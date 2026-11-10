// Jêga "backend" for the free Spark plan: what the Cloud Functions used to do, done from the app.
// Firestore security rules (firestore.rules) enforce every check below, so a modified client can't
// book at the wrong price, double-book an hour, or write as someone else.
import { auth, db, authMod, fs } from "./fb.js";

const { doc, collection, getDoc, setDoc, updateDoc, addDoc, runTransaction, writeBatch, serverTimestamp, increment, Timestamp } = fs;

const TZ_OFFSET = "+03:00"; // Erbil, no daylight saving
const pad2 = (n) => String(n).padStart(2, "0");
const whenText = (b) => `${b.date} ${pad2(b.start)}:00–${pad2(b.start + b.hours)}:00`;
const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad" }).format(new Date());
const maskOf = (start, hours) => (2 ** hours - 1) * 2 ** start;
const hourBitsFree = (taken, start, hours) => Math.floor(taken / 2 ** start) % 2 ** hours === 0;

/** Errors carry a short code in the message; app.js maps it to a translated text. */
function fail(code) { const e = new Error(code); e.code = code; throw e; }

/** "+9647XXXXXXXXX" or null */
export function normPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00964")) d = d.slice(5);
  else if (d.startsWith("964")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^7[5-9]\d{8}$/.test(d) ? "+964" + d : null;
}
const prettyPhone = (p) => `+964 ${p.slice(4, 7)} ${p.slice(7, 10)} ${p.slice(10)}`;

/**
 * Phone-only sign-in (no code), as the product owner chose.
 * Each number maps to one Firebase email account, so the same number reaches the same account on any device.
 * Anyone who knows a number can open that account; see README "Security notes".
 */
async function phoneLogin({ phone, name = "", lang = "en" }) {
  const p = normPhone(phone);
  if (!p) fail("bad-phone");
  name = String(name).trim().slice(0, 40);
  const digits = p.slice(1);
  const email = `p${digits}@users.jega.app`;
  const password = `jega:${digits}:phone-login`;

  let cred;
  try {
    cred = await authMod.signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    if (!["auth/invalid-credential", "auth/user-not-found", "auth/invalid-login-credentials"].includes(e.code)) throw e;
    if (name.length < 2) fail("need-name");
    cred = await authMod.createUserWithEmailAndPassword(auth, email, password);
  }

  const ref = doc(db, "users", cred.user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    if (name.length < 2) { await authMod.signOut(auth); fail("need-name"); }
    await setDoc(ref, {
      phone: p, phonePretty: prettyPhone(p), name, lang, blocked: false, fcmTokens: [], notifyPush: true,
      createdAt: serverTimestamp(), lastLoginAt: serverTimestamp(),
    });
    return { isNew: true };
  }
  if (snap.data().blocked) { await authMod.signOut(auth); fail("blocked"); }
  await updateDoc(ref, { lang, lastLoginAt: serverTimestamp(), ...(name.length >= 2 ? { name } : {}) });
  return { isNew: false };
}

/** "HH:MM" -> whole hour. Opening times round up, closing times round down, so bookings stay inside. */
function hourOf(hhmm, fallback, roundUp) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return fallback;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  return roundUp && min > 0 ? h + 1 : h;
}

/** Store a notification in someone's in-app list. It is rendered in their language on their device. */
export async function notify(uid, type, vars = {}, opts = {}) {
  await addDoc(collection(db, "users", uid, "notifications"), {
    type, vars, link: opts.link || "/", priority: opts.priority || "normal", read: false,
    at: serverTimestamp(), from: auth.currentUser.uid, ...(opts.bookingId ? { bookingId: opts.bookingId } : {}),
  });
}

/** Raise an alert on the admin dashboard. */
export async function alertAdmins(type, data, severity = "info") {
  await addDoc(collection(db, "alerts"), { type, severity, data, resolved: false, at: serverTimestamp() });
}

/**
 * Book a slot (cash on arrival). Runs in a transaction: the hours are marked in slotDays/{slot}_{date},
 * so two drivers can never get the same hour. Online payment needs the Blaze plan and is off.
 */
async function createBooking({ slotId, date, start, hours, payMethod }) {
  const uid = auth.currentUser?.uid;
  if (!uid) fail("unauthenticated");
  start = parseInt(start, 10); hours = parseInt(hours, 10);
  if (!slotId || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) fail("bad-input");
  if (!(start >= 0 && start <= 23) || !(hours >= 1 && hours <= 24)) fail("bad-time");
  if (start + hours > 24) fail("past-midnight");
  if (payMethod !== "cash") fail("online-off");

  const startAt = new Date(`${date}T${pad2(start)}:00:00${TZ_OFFSET}`);
  const endAt = new Date(startAt.getTime() + hours * 3600e3);
  if (date < todayLocal() || endAt.getTime() <= Date.now()) fail("in-past");
  if (startAt.getTime() - Date.now() > 31 * 86400e3) fail("too-far");

  const [userSnap, cfgSnap] = await Promise.all([getDoc(doc(db, "users", uid)), getDoc(doc(db, "config", "app"))]);
  const user = userSnap.data();
  if (!user || user.blocked) fail("blocked");
  const pct = cfgSnap.exists() ? (cfgSnap.data().commissionPct ?? 10) : 10;

  const bookingRef = doc(collection(db, "bookings"));
  const dayRef = doc(db, "slotDays", `${slotId}_${date}`);
  let booking;

  await runTransaction(db, async (tx) => {
    const sSnap = await tx.get(doc(db, "slots", slotId));
    if (!sSnap.exists()) fail("no-slot");
    const slot = sSnap.data();
    if (slot.status !== "active" || !slot.active) fail("slot-off");
    if (slot.hostUid === uid) fail("own-slot");
    if (hours > (slot.maxH || 24)) fail("too-long");
    if (!slot.allDay) {
      const open = hourOf(slot.opens, 0, true), close = slot.closes === "00:00" ? 24 : hourOf(slot.closes, 24, false);
      if (start < open || start + hours > close) fail("closed");
    }
    const day = await tx.get(dayRef);
    const taken = day.exists() ? day.data().taken || 0 : 0;
    if (!hourBitsFree(taken, start, hours)) fail("clash");

    const total = slot.mode === "flat" ? slot.price : slot.price * hours;
    const fee = Math.round((total * pct) / 100);
    booking = {
      slotId, slotCode: slot.code, slotTitle: slot.title, landmark: slot.landmark || "",
      lat: slot.lat, lng: slot.lng,
      hostUid: slot.hostUid, hostName: slot.hostName, hostPhone: slot.hostPhone,
      driverUid: uid, driverName: user.name, driverPhone: user.phonePretty,
      date, start, hours, mode: slot.mode, unitPrice: slot.price,
      total, platformFee: fee, hostEarning: total - fee,
      payMethod: "cash", status: "confirmed", paymentStatus: "cash_on_arrival",
      startAt: Timestamp.fromDate(startAt), endAt: Timestamp.fromDate(endAt),
      createdAt: serverTimestamp(),
    };
    tx.set(bookingRef, booking);
    tx.set(dayRef, { slotId, date, taken: taken + maskOf(start, hours), lastBooking: bookingRef.id });

    // open (or reuse) the chat with the host and drop the booking into it
    const chatId = `${slotId}_${uid}`;
    const text = `${slot.code} · ${whenText(booking)} · ${total.toLocaleString("en-US")} IQD`;
    tx.set(doc(db, "chats", chatId), {
      members: [uid, slot.hostUid], slotId, slotCode: slot.code,
      names: { [uid]: user.name, [slot.hostUid]: slot.hostName },
      lastText: text, lastFrom: uid, lastAt: serverTimestamp(), unread: { [slot.hostUid]: increment(1) },
    }, { merge: true });
    tx.set(doc(collection(db, "chats", chatId, "messages")), { from: uid, type: "booking", bookingId: bookingRef.id, text, at: serverTimestamp() });
  });

  const id = bookingRef.id, when = whenText(booking);
  await Promise.all([
    notify(booking.hostUid, "booking_new", { code: booking.slotCode, when, total: booking.total, driver: booking.driverName },
      { bookingId: id, link: "/?tab=host", priority: "high" }),
    notify(uid, "booking_confirmed", { code: booking.slotCode, when }, { bookingId: id, link: `/?booking=${id}` }),
  ]).catch((e) => console.warn("notify failed", e));
  return { bookingId: id, status: booking.status, total: booking.total };
}

/** Driver cancels a booking that hasn't started. Frees the hours in the same transaction. */
async function cancelBooking({ bookingId }) {
  const uid = auth.currentUser?.uid;
  const ref = doc(db, "bookings", bookingId);
  let b;
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) fail("no-booking");
    b = s.data();
    if (b.driverUid !== uid) fail("not-yours");
    if (b.status !== "confirmed" || b.startAt.toMillis() <= Date.now()) fail("cannot-cancel");
    const dayRef = doc(db, "slotDays", `${b.slotId}_${b.date}`);
    const day = await tx.get(dayRef);
    const taken = day.exists() ? day.data().taken || 0 : 0;
    tx.update(ref, { status: "cancelled", cancelledBy: "driver", cancelledAt: serverTimestamp() });
    tx.set(dayRef, { slotId: b.slotId, date: b.date, taken: taken - maskOf(b.start, b.hours), lastBooking: bookingId });
  });
  await notify(b.hostUid, "booking_cancelled", { code: b.slotCode, when: whenText(b), reason: "" },
    { bookingId, link: "/?tab=host" }).catch((e) => console.warn("notify failed", e));
  return { ok: true };
}

/** Send a chat message and update the thread summary + the other member's unread counter. */
export async function sendMessage(chatId, text, otherUid) {
  const uid = auth.currentUser.uid;
  const batch = writeBatch(db);
  batch.set(doc(collection(db, "chats", chatId, "messages")), { from: uid, text, at: serverTimestamp() });
  batch.update(doc(db, "chats", chatId), {
    lastText: text.slice(0, 120), lastFrom: uid, lastAt: serverTimestamp(),
    ...(otherUid ? { [`unread.${otherUid}`]: increment(1) } : {}),
  });
  await batch.commit();
}

const ACTIONS = { phoneLogin, createBooking, cancelBooking };
/** Same shape as the old httpsCallable: call("name")(data) -> { data } */
export const call = (name) => async (data) => {
  const fn = ACTIONS[name];
  if (!fn) fail("unavailable");
  return { data: await fn(data || {}) };
};
