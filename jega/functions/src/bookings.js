import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import {
  db, auth, FieldValue, Timestamp, HttpsError, REGION, normPhone, prettyPhone, uidFromPhone,
  startDate, todayLocal, whenText, requireUser, appConfig, rateLimit,
} from "./common.js";
import { notifyUser, alertAdmins } from "./notify.js";

const LANGS = ["en", "ar", "ckb", "kmr"];
const ACTIVE = ["pending_payment", "confirmed"];

/**
 * Phone-only sign-in (no OTP, as requested by the product owner).
 * Anyone who knows a number can open that account; see README "Security notes".
 * Returns a Firebase custom token with claim role = "user". This claim can never grant admin.
 */
export const phoneLogin = onCall({ region: REGION }, async (req) => {
  const phone = normPhone(req.data?.phone);
  const name = String(req.data?.name || "").trim().slice(0, 40);
  const lang = LANGS.includes(req.data?.lang) ? req.data.lang : "en";
  if (!phone) throw new HttpsError("invalid-argument", "bad-phone");

  const ip = req.rawRequest?.ip || "unknown";
  await rateLimit(`login_ip_${ip}`, 30, 3600);
  await rateLimit(`login_phone_${phone}`, 15, 3600);

  const uid = uidFromPhone(phone);
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  if (snap.exists && snap.data().blocked) {
    await alertAdmins("user_blocked_login", { uid, summary: `${prettyPhone(phone)} tried to sign in` }, "info");
    throw new HttpsError("permission-denied", "blocked");
  }
  if (!snap.exists && name.length < 2) throw new HttpsError("invalid-argument", "need-name");

  try { await auth.getUser(uid); }
  catch { await auth.createUser({ uid, displayName: name || undefined }); }

  await ref.set({
    phone, phonePretty: prettyPhone(phone), lang,
    ...(name ? { name } : {}),
    ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp(), blocked: false, fcmTokens: [], notifyPush: true }),
    lastLoginAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const token = await auth.createCustomToken(uid, { role: "user" });
  return { token, isNew: !snap.exists };
});

/** "HH:MM" -> whole hour. Opening times round up, closing times round down, so bookings stay inside. */
function hourOf(hhmm, fallback, roundUp) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return fallback;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  return roundUp && min > 0 ? h + 1 : h;
}

/**
 * Create a booking. Prices and overlaps are checked here, never in the client.
 * payMethod "cash"   -> confirmed immediately, driver pays the host on arrival
 * payMethod "online" -> pending_payment for N minutes until FuratPay confirms
 */
export const createBooking = onCall({ region: REGION }, async (req) => {
  const uid = requireUser(req);
  const { slotId, date, payMethod } = req.data || {};
  const start = parseInt(req.data?.start, 10);
  const hours = parseInt(req.data?.hours, 10);
  if (!slotId || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new HttpsError("invalid-argument", "bad-input");
  if (!(start >= 0 && start <= 23) || !(hours >= 1 && hours <= 24)) throw new HttpsError("invalid-argument", "bad-time");
  if (start + hours > 24) throw new HttpsError("failed-precondition", "past-midnight");
  if (!["cash", "online"].includes(payMethod)) throw new HttpsError("invalid-argument", "bad-pay");
  await rateLimit(`book_${uid}`, 20, 3600);

  const cfg = await appConfig();
  if (payMethod === "online" && cfg.onlinePayments === false) throw new HttpsError("failed-precondition", "online-off");

  const startAt = startDate(date, start);
  const endAt = new Date(startAt.getTime() + hours * 3600e3);
  if (date < todayLocal() || endAt.getTime() <= Date.now()) throw new HttpsError("failed-precondition", "in-past");
  if (startAt.getTime() - Date.now() > 31 * 86400e3) throw new HttpsError("failed-precondition", "too-far");

  const user = (await db.doc(`users/${uid}`).get()).data();
  if (!user || user.blocked) throw new HttpsError("permission-denied", "blocked");

  const bookingRef = db.collection("bookings").doc();
  let booking, slot;

  await db.runTransaction(async (tx) => {
    const sSnap = await tx.get(db.doc(`slots/${slotId}`));
    if (!sSnap.exists) throw new HttpsError("not-found", "no-slot");
    slot = sSnap.data();
    if (slot.status !== "active" || !slot.active) throw new HttpsError("failed-precondition", "slot-off");
    if (slot.hostUid === uid) throw new HttpsError("failed-precondition", "own-slot");
    if (hours > (slot.maxH || 24)) throw new HttpsError("failed-precondition", "too-long");
    if (!slot.allDay) {
      const open = hourOf(slot.opens, 0, true), close = slot.closes === "00:00" ? 24 : hourOf(slot.closes, 24, false);
      if (start < open || start + hours > close) throw new HttpsError("failed-precondition", "closed");
    }

    const same = await tx.get(db.collection("bookings").where("slotId", "==", slotId).where("date", "==", date));
    const clash = same.docs.some((d) => {
      const b = d.data();
      if (!ACTIVE.includes(b.status)) return false;
      if (b.status === "pending_payment" && b.expiresAt?.toMillis() < Date.now()) return false;
      return start < b.start + b.hours && b.start < start + hours;
    });
    if (clash) throw new HttpsError("already-exists", "clash");

    const total = slot.mode === "flat" ? slot.price : slot.price * hours;
    const fee = Math.round((total * (cfg.commissionPct || 0)) / 100);
    booking = {
      slotId, slotCode: slot.code, slotTitle: slot.title, landmark: slot.landmark || "",
      lat: slot.lat, lng: slot.lng,
      hostUid: slot.hostUid, hostName: slot.hostName, hostPhone: slot.hostPhone,
      driverUid: uid, driverName: user.name, driverPhone: user.phonePretty,
      date, start, hours, mode: slot.mode, unitPrice: slot.price,
      total, platformFee: fee, hostEarning: total - fee,
      payMethod,
      status: payMethod === "cash" ? "confirmed" : "pending_payment",
      paymentStatus: payMethod === "cash" ? "cash_on_arrival" : "unpaid",
      startAt: Timestamp.fromDate(startAt), endAt: Timestamp.fromDate(endAt),
      expiresAt: payMethod === "online" ? Timestamp.fromMillis(Date.now() + cfg.pendingPaymentMinutes * 60e3) : null,
      remindedStart: false, remindedEnd: false,
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.set(bookingRef, booking);

    const chatId = `${slotId}_${uid}`;
    tx.set(db.doc(`chats/${chatId}`), {
      members: [uid, slot.hostUid], slotId, slotCode: slot.code,
      names: { [uid]: user.name, [slot.hostUid]: slot.hostName },
      lastAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.collection(`chats/${chatId}/messages`).doc(), {
      from: "system", type: "booking", bookingId: bookingRef.id,
      text: `${slot.code} · ${whenText(booking)} · ${total.toLocaleString("en-US")} IQD`,
      at: FieldValue.serverTimestamp(),
    });
  });

  if (booking.status === "confirmed") await announceConfirmed(bookingRef.id, booking);
  logger.info("booking created", { id: bookingRef.id, payMethod });
  return { bookingId: bookingRef.id, status: booking.status, total: booking.total, expiresAt: booking.expiresAt?.toMillis() || null };
});

export async function announceConfirmed(id, b, paid = false) {
  const link = `/?booking=${id}`;
  await notifyUser(b.driverUid, "booking_confirmed", { code: b.slotCode, when: whenText(b) }, { link, priority: "high" });
  if (paid) await notifyUser(b.hostUid, "payment_paid", { code: b.slotCode, when: whenText(b), total: b.total }, { link: "/?tab=host" });
  await notifyUser(b.hostUid, "booking_new", { code: b.slotCode, when: whenText(b), total: b.total, driver: b.driverName }, { link: "/?tab=host", priority: "high" });
}

/** Driver cancels: allowed for unpaid bookings and cash bookings that haven't started. */
export const cancelBooking = onCall({ region: REGION }, async (req) => {
  const uid = requireUser(req);
  const ref = db.doc(`bookings/${req.data?.bookingId}`);
  let b;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError("not-found", "no-booking");
    b = s.data();
    if (b.driverUid !== uid) throw new HttpsError("permission-denied", "not-yours");
    const startedOrPaid = b.startAt.toMillis() <= Date.now() || b.paymentStatus === "paid";
    if (!ACTIVE.includes(b.status) || startedOrPaid) throw new HttpsError("failed-precondition", "cannot-cancel");
    tx.update(ref, { status: "cancelled", cancelledBy: "driver", cancelledAt: FieldValue.serverTimestamp() });
  });
  if (b.status === "confirmed") {
    await notifyUser(b.hostUid, "booking_cancelled", { code: b.slotCode, when: whenText(b), reason: "" }, { link: "/?tab=host" });
  }
  return { ok: true };
});

