import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { HttpsError } from "firebase-functions/v2/https";

if (!getApps().length) initializeApp();

export const db = getFirestore();
export const auth = getAuth();
export const messaging = getMessaging();
export { FieldValue, Timestamp, HttpsError };

export const REGION = "europe-west1"; // closest Firebase region to Iraq with full support
export const TZ = "Asia/Baghdad";     // all booking times are local Erbil time (UTC+3, no DST)
export const TZ_OFFSET = "+03:00";

/** Normalise an Iraqi mobile number. Returns "+9647XXXXXXXXX" or null. */
export function normPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00964")) d = d.slice(5);
  else if (d.startsWith("964")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  if (!/^7[5-9]\d{8}$/.test(d)) return null;
  return "+964" + d;
}
export const prettyPhone = (p) => `+964 ${p.slice(4, 7)} ${p.slice(7, 10)} ${p.slice(10)}`;
export const uidFromPhone = (p) => "p" + p.replace(/\D/g, "");

/** Booking start as a Date, from "YYYY-MM-DD" + hour in Erbil time. */
export function startDate(date, hour) {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00${TZ_OFFSET}`);
}
export function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
export const pad2 = (n) => String(n).padStart(2, "0");
export const whenText = (b) => `${b.date} ${pad2(b.start)}:00–${pad2(b.start + b.hours)}:00`;

export function requireUser(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  if (req.auth.token.role !== "user") throw new HttpsError("permission-denied", "Only app accounts can do this.");
  return req.auth.uid;
}
export function requireAdmin(req) {
  if (!req.auth || req.auth.token.admin !== true) throw new HttpsError("permission-denied", "Admins only.");
  return req.auth.uid;
}

export async function appConfig() {
  const snap = await db.doc("config/app").get();
  return { commissionPct: 10, pendingPaymentMinutes: 15, onlinePayments: true, ...(snap.exists ? snap.data() : {}) };
}

/** Simple fixed-window rate limit stored in Firestore. Throws when exceeded. */
export async function rateLimit(key, max, windowSec) {
  const ref = db.doc(`rateLimits/${key.replace(/[^\w.-]/g, "_")}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    if (!d || now - d.start > windowSec * 1000) {
      tx.set(ref, { start: now, count: 1, expireAt: Timestamp.fromMillis(now + windowSec * 1000) });
      return;
    }
    if (d.count >= max) throw new HttpsError("resource-exhausted", "Too many attempts. Try again later.");
    tx.update(ref, { count: d.count + 1 });
  });
}
