import { onCall } from "firebase-functions/v2/https";
import { db, auth, FieldValue, HttpsError, REGION, requireAdmin, whenText } from "./common.js";
import { notifyUser } from "./notify.js";

const log = (adminUid, action, data) =>
  db.collection("auditLog").add({ adminUid, action, data, at: FieldValue.serverTimestamp() });

/** Suspend or restore a slot. The host is notified with the reason. */
export const adminSetSlotStatus = onCall({ region: REGION }, async (req) => {
  const a = requireAdmin(req);
  const { slotId, status, reason = "" } = req.data || {};
  if (!["active", "suspended"].includes(status)) throw new HttpsError("invalid-argument", "bad-status");
  const ref = db.doc(`slots/${slotId}`);
  const s = (await ref.get()).data();
  if (!s) throw new HttpsError("not-found", "no-slot");
  await ref.update({ status, statusReason: reason, statusAt: FieldValue.serverTimestamp() });
  await notifyUser(s.hostUid, status === "suspended" ? "slot_suspended" : "slot_restored",
    { code: s.code, reason: reason || "Contact Jêga support for details." }, { link: "/?tab=host", priority: "high" });
  await log(a, "slot_status", { slotId, status, reason });
  return { ok: true };
});

/** Block or unblock a user. Blocking signs them out everywhere and hides their slots. */
export const adminSetUserBlocked = onCall({ region: REGION }, async (req) => {
  const a = requireAdmin(req);
  const { uid, blocked } = req.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "no-uid");
  await db.doc(`users/${uid}`).update({ blocked: !!blocked, blockedAt: FieldValue.serverTimestamp() });
  await auth.updateUser(uid, { disabled: !!blocked });
  if (blocked) await auth.revokeRefreshTokens(uid);
  const slots = await db.collection("slots").where("hostUid", "==", uid).get();
  const batch = db.batch();
  slots.docs.forEach((d) => batch.update(d.ref, { status: blocked ? "suspended" : "active", statusReason: blocked ? "Account blocked" : "" }));
  if (!slots.empty) await batch.commit();
  await log(a, "user_blocked", { uid, blocked: !!blocked });
  return { ok: true };
});

/** Cancel any booking. Paid bookings are flagged for refund. */
export const adminCancelBooking = onCall({ region: REGION }, async (req) => {
  const a = requireAdmin(req);
  const { bookingId, reason = "" } = req.data || {};
  const ref = db.doc(`bookings/${bookingId}`);
  const b = (await ref.get()).data();
  if (!b) throw new HttpsError("not-found", "no-booking");
  if (!["pending_payment", "confirmed"].includes(b.status)) throw new HttpsError("failed-precondition", "not-active");
  await ref.update({
    status: "cancelled", cancelledBy: "admin", cancelReason: reason, cancelledAt: FieldValue.serverTimestamp(),
    ...(b.paymentStatus === "paid" ? { refund: "needed" } : {}),
  });
  const vars = { code: b.slotCode, when: whenText(b), reason };
  await notifyUser(b.driverUid, "booking_cancelled", vars, { link: `/?booking=${bookingId}`, priority: "high" });
  await notifyUser(b.hostUid, "booking_cancelled", vars, { link: "/?tab=host" });
  await log(a, "booking_cancel", { bookingId, reason });
  return { ok: true };
});

/** Mark a refund as done after you've returned the money through FuratPay or the bank. */
export const adminMarkRefunded = onCall({ region: REGION }, async (req) => {
  const a = requireAdmin(req);
  const { bookingId, note = "" } = req.data || {};
  await db.doc(`bookings/${bookingId}`).update({ refund: "done", refundNote: note, refundedAt: FieldValue.serverTimestamp() });
  await db.doc(`payments/${bookingId}`).set({ status: "refunded" }, { merge: true });
  await log(a, "refund", { bookingId, note });
  return { ok: true };
});

/** Send an announcement to all users, only hosts, or only drivers. Titles are sent as written. */
export const adminBroadcast = onCall({ region: REGION, timeoutSeconds: 540 }, async (req) => {
  const a = requireAdmin(req);
  const { title, body, audience = "all" } = req.data || {};
  if (!title || !body) throw new HttpsError("invalid-argument", "need-text");
  let uids;
  if (audience === "hosts") {
    const s = await db.collection("slots").select("hostUid").get();
    uids = [...new Set(s.docs.map((d) => d.data().hostUid))];
  } else {
    const u = await db.collection("users").where("blocked", "==", false).select().get();
    uids = u.docs.map((d) => d.id);
    if (audience === "drivers") {
      const s = await db.collection("slots").select("hostUid").get();
      const hosts = new Set(s.docs.map((d) => d.data().hostUid));
      uids = uids.filter((x) => !hosts.has(x));
    }
  }
  // sequential in small groups keeps FCM and Firestore within limits; for >20k users move this to a queue
  for (let i = 0; i < uids.length; i += 20) {
    await Promise.all(uids.slice(i, i + 20).map((u) => notifyUser(u, "broadcast", { title, body }, { link: "/?tab=me" })));
  }
  await db.collection("broadcasts").add({ title, body, audience, count: uids.length, by: a, at: FieldValue.serverTimestamp() });
  await log(a, "broadcast", { audience, count: uids.length });
  return { sent: uids.length };
});
