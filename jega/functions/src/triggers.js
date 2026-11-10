import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp, REGION, TZ, appConfig } from "./common.js";
import { notifyUser, alertAdmins } from "./notify.js";

/** New chat message: update the thread summary and push to the other member. */
export const onChatMessage = onDocumentCreated({ document: "chats/{chatId}/messages/{mid}", region: REGION }, async (ev) => {
  const m = ev.data?.data();
  if (!m || m.from === "system") return;
  const chatRef = db.doc(`chats/${ev.params.chatId}`);
  const chat = (await chatRef.get()).data();
  if (!chat) return;
  const to = chat.members.find((u) => u !== m.from);
  await chatRef.update({
    lastText: m.text.slice(0, 120), lastFrom: m.from, lastAt: FieldValue.serverTimestamp(),
    [`unread.${to}`]: FieldValue.increment(1),
  });
  await notifyUser(to, "message", { name: chat.names?.[m.from] || "Jêga", text: m.text.slice(0, 140) },
    { inbox: false, link: `/?chat=${ev.params.chatId}`, tag: `chat-${ev.params.chatId}` });
});

/** A host listed a new slot: tell the admins so they can review it. */
export const onSlotCreated = onDocumentCreated({ document: "slots/{slotId}", region: REGION }, async (ev) => {
  const s = ev.data?.data();
  if (!s) return;
  await alertAdmins("new_slot", { slotId: ev.params.slotId, summary: `${s.code} · ${s.title} · ${s.hostName}` }, "info");
});

/** A user reported a slot or a person. */
export const onReport = onDocumentCreated({ document: "reports/{rid}", region: REGION }, async (ev) => {
  const r = ev.data?.data();
  if (!r) return;
  await alertAdmins("report", { reportId: ev.params.rid, summary: `${r.targetType} ${r.targetLabel || r.targetId}: ${r.reason}` }, "warning");
});

/**
 * Every 5 minutes:
 *  - release online bookings whose payment wasn't completed in time
 *  - remind drivers ~30 min before start, and tell the host the driver is coming
 *  - warn drivers 15 min before their time ends
 *  - mark finished bookings as completed
 */
export const bookingClock = onSchedule({ schedule: "every 5 minutes", timeZone: TZ, region: REGION }, async () => {
  const now = Date.now();
  const cfg = await appConfig();
  const ts = (ms) => Timestamp.fromMillis(ms);
  const hm = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(t.toDate());

  const expired = await db.collection("bookings").where("status", "==", "pending_payment").where("expiresAt", "<=", ts(now)).get();
  for (const d of expired.docs) {
    const b = d.data();
    await d.ref.update({ status: "expired", paymentStatus: "unpaid", expiredAt: FieldValue.serverTimestamp() });
    await db.doc(`payments/${d.id}`).set({ status: "expired" }, { merge: true });
    await notifyUser(b.driverUid, "booking_expired", { code: b.slotCode, min: cfg.pendingPaymentMinutes }, { link: `/?booking=${d.id}` });
  }

  const soon = await db.collection("bookings").where("status", "==", "confirmed")
    .where("startAt", ">", ts(now)).where("startAt", "<=", ts(now + 35 * 60e3)).get();
  for (const d of soon.docs) {
    const b = d.data();
    if (b.remindedStart) continue;
    await d.ref.update({ remindedStart: true });
    await notifyUser(b.driverUid, "reminder_start", { code: b.slotCode, time: hm(b.startAt), landmark: b.landmark }, { link: `/?booking=${d.id}`, priority: "high" });
    await notifyUser(b.hostUid, "host_arriving", { code: b.slotCode, time: hm(b.startAt), driver: b.driverName }, { link: "/?tab=host" });
  }

  const ending = await db.collection("bookings").where("status", "==", "confirmed")
    .where("endAt", ">", ts(now + 5 * 60e3)).where("endAt", "<=", ts(now + 20 * 60e3)).get();
  for (const d of ending.docs) {
    const b = d.data();
    if (b.remindedEnd || b.hours < 1) continue;
    await d.ref.update({ remindedEnd: true });
    await notifyUser(b.driverUid, "reminder_end", { code: b.slotCode, time: hm(b.endAt) }, { link: `/?booking=${d.id}`, priority: "high" });
  }

  const done = await db.collection("bookings").where("status", "==", "confirmed").where("endAt", "<=", ts(now)).limit(400).get();
  const batch = db.batch();
  done.docs.forEach((d) => batch.update(d.ref, { status: "completed" }));
  if (!done.empty) await batch.commit();

  logger.info("clock", { expired: expired.size, soon: soon.size, ending: ending.size, done: done.size });
});

