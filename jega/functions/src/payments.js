import { onCall, onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { db, FieldValue, HttpsError, REGION, requireUser, whenText } from "./common.js";
import { FURATPAY_API_KEY, FURATPAY_WEBHOOK_SECRET, APP_URL, furatCfg } from "./params.js";
import * as furat from "./furatpay.js";
import { notifyUser, alertAdmins } from "./notify.js";
import { announceConfirmed } from "./bookings.js";

const secrets = [FURATPAY_API_KEY, FURATPAY_WEBHOOK_SECRET];
const testCheckoutUrl = () =>
  process.env.TEST_CHECKOUT_URL || `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/testCheckout`;

/** Payment services (FIB, Qi Card, FastPay …) enabled on the FuratPay merchant account. */
export const paymentServices = onCall({ region: REGION, secrets }, async (req) => {
  requireUser(req);
  const cfg = furatCfg();
  try {
    return { services: await furat.listServices(cfg), testMode: furat.isTestMode(cfg) };
  } catch (e) {
    logger.error(e);
    throw new HttpsError("unavailable", "pay-unavailable");
  }
});

/** Create (or reuse) the FuratPay invoice for a pending booking and return where to pay. */
export const startPayment = onCall({ region: REGION, secrets }, async (req) => {
  const uid = requireUser(req);
  const { bookingId, serviceId } = req.data || {};
  if (!bookingId || serviceId === undefined || serviceId === null) throw new HttpsError("invalid-argument", "bad-input");
  const bRef = db.doc(`bookings/${bookingId}`);
  const b = (await bRef.get()).data();
  if (!b || b.driverUid !== uid) throw new HttpsError("not-found", "no-booking");
  if (b.status !== "pending_payment") throw new HttpsError("failed-precondition", "not-pending");
  if (b.expiresAt.toMillis() < Date.now()) throw new HttpsError("deadline-exceeded", "expired");

  const cfg = furatCfg();
  const pRef = db.doc(`payments/${bookingId}`);
  let p = (await pRef.get()).data();
  try {
    if (!p?.invoiceId) {
      const number = await nextInvoiceNumber();
      const invoiceId = await furat.createInvoice(cfg, {
        number, bookingId, amount: b.total,
        title: `Parking ${b.slotCode} · ${whenText(b)}`,
        description: b.slotTitle,
        customer: { uid, name: b.driverName, phone: b.driverPhone.replace(/\s/g, "") },
      });
      p = {
        bookingId, invoiceId, invoiceNumber: number, provider: "furatpay", testMode: furat.isTestMode(cfg),
        amount: b.total, currency: "IQD", driverUid: uid, hostUid: b.hostUid,
        status: "pending", createdAt: FieldValue.serverTimestamp(),
      };
      await pRef.set(p);
    }
    const res = await furat.pay(cfg, p.invoiceId, serviceId, testCheckoutUrl());
    await pRef.update({ serviceId: String(serviceId), lastPayUrlAt: FieldValue.serverTimestamp() });
    return res;
  } catch (e) {
    logger.error("startPayment", e);
    throw new HttpsError("unavailable", "pay-unavailable");
  }
});

/** Polled by the app while the driver is paying (same as FuratPay's own plugin does). */
export const checkPayment = onCall({ region: REGION, secrets }, async (req) => {
  const uid = requireUser(req);
  const bookingId = req.data?.bookingId;
  const b = (await db.doc(`bookings/${bookingId}`).get()).data();
  if (!b || b.driverUid !== uid) throw new HttpsError("not-found", "no-booking");
  if (b.status !== "pending_payment") return { status: b.status };
  const p = (await db.doc(`payments/${bookingId}`).get()).data();
  if (!p?.invoiceId) return { status: b.status };
  const s = await furat.invoiceStatus(furatCfg(), p.invoiceId);
  if (s === "paid") await markPaid(bookingId, "poll");
  if (s === "failed") await markFailed(bookingId, "provider reported failure");
  return { status: (await db.doc(`bookings/${bookingId}`).get()).data().status };
});

/** FuratPay webhook (set this URL in your FuratPay dashboard). */
export const furatpayWebhook = onRequest({ region: REGION, secrets }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("POST only");
  const cfg = furatCfg();
  try {
    const payload = furat.verifyWebhook(cfg, req.headers, req.body);
    if (!["INVOICE_PAID", "INVOICE_UPDATED"].includes(payload.type)) return res.status(200).json({ ignored: true });
    const bookingId = String(payload.data.order_number || payload.data.code || "");
    const p = (await db.doc(`payments/${bookingId}`).get()).data();
    if (!p || p.invoiceId !== payload.data.id) throw new Error(`Unknown invoice ${payload.data.id}`);
    // never trust the webhook body alone: ask FuratPay for the real status
    const s = await furat.invoiceStatus(cfg, p.invoiceId);
    if (s === "paid") await markPaid(bookingId, "webhook");
    else if (s === "failed") await markFailed(bookingId, "provider reported failure");
    return res.status(200).json({ ok: true });
  } catch (e) {
    logger.error("webhook", e);
    await alertAdmins("webhook_error", { summary: e.message }, "critical");
    return res.status(400).json({ error: e.message });
  }
});

/** Built-in checkout page used only in TEST MODE (no FuratPay account yet). */
export const testCheckout = onRequest({ region: REGION, secrets }, async (req, res) => {
  const cfg = furatCfg();
  if (!furat.isTestMode(cfg)) return res.status(404).send("Not available: live payments are enabled.");
  const invoice = String(req.query.invoice || req.body?.invoice || "");
  const bookingId = invoice.replace(/^test_/, "");
  const b = (await db.doc(`bookings/${bookingId}`).get()).data();
  if (!b) return res.status(404).send("Unknown invoice");
  const back = `${APP_URL.value()}/?booking=${bookingId}`;

  if (req.method === "POST") {
    if (req.body?.action === "pay") await markPaid(bookingId, "test-checkout");
    else await markFailed(bookingId, "declined on test checkout");
    return res.redirect(303, back);
  }
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test checkout</title><style>body{font:16px system-ui;margin:0;background:#ECEEF0;color:#1A1F25;display:grid;place-items:center;min-height:100vh;padding:16px}
.c{background:#fff;border-radius:16px;padding:24px;max-width:380px;width:100%}h1{font-size:20px;margin:0 0 4px}.t{font-size:28px;font-weight:700;margin:16px 0}
button{width:100%;padding:14px;border:0;border-radius:12px;font:600 16px system-ui;margin-top:10px;cursor:pointer}.p{background:#F2B705}.d{background:#eee}
.n{font-size:13px;color:#5D6672;background:#FFF6D6;padding:10px;border-radius:10px}</style>
<div class="c"><p class="n">TEST MODE. No real money moves. This page is replaced by FuratPay once you add your merchant key.</p>
<h1>${b.slotCode} · ${b.slotTitle.replace(/</g, "&lt;")}</h1><div>${whenText(b)}</div>
<div class="t">${b.total.toLocaleString("en-US")} IQD</div>
<form method="post"><input type="hidden" name="invoice" value="${invoice.replace(/"/g, "")}">
<button class="p" name="action" value="pay">Pay (test)</button><button class="d" name="action" value="decline">Decline (test)</button></form></div>`);
});

async function nextInvoiceNumber() {
  const ref = db.doc("config/counters");
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const n = (s.exists ? s.data().invoice || 100000 : 100000) + 1;
    tx.set(ref, { invoice: n }, { merge: true });
    return n;
  });
}

export async function markPaid(bookingId, source) {
  const bRef = db.doc(`bookings/${bookingId}`), pRef = db.doc(`payments/${bookingId}`);
  let b, outcome;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(bRef);
    b = s.data();
    if (!b || b.paymentStatus === "paid") { outcome = "noop"; return; }
    tx.update(pRef, { status: "paid", paidAt: FieldValue.serverTimestamp(), source });
    if (b.status === "pending_payment") {
      tx.update(bRef, { status: "confirmed", paymentStatus: "paid", paidAt: FieldValue.serverTimestamp(), expiresAt: null });
      outcome = "confirmed";
    } else {
      // money arrived after the hold expired or was cancelled: needs a refund by the admin
      tx.update(bRef, { paymentStatus: "paid", refund: "needed", paidAt: FieldValue.serverTimestamp() });
      outcome = "late";
    }
  });
  if (outcome === "confirmed") await announceConfirmed(bookingId, b, true);
  if (outcome === "late") {
    await alertAdmins("payment_failed", {
      bookingId, summary: `Paid after the booking was ${b.status}. Refund ${b.total.toLocaleString("en-US")} IQD to ${b.driverPhone}.`,
    }, "critical");
  }
}

export async function markFailed(bookingId, reason) {
  const bRef = db.doc(`bookings/${bookingId}`);
  let b, changed = false;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(bRef);
    b = s.data();
    if (!b || b.status !== "pending_payment") return;
    tx.update(bRef, { status: "cancelled", cancelledBy: "payment", paymentStatus: "failed", cancelledAt: FieldValue.serverTimestamp() });
    tx.set(db.doc(`payments/${bookingId}`), { status: "failed", failedReason: reason }, { merge: true });
    changed = true;
  });
  if (!changed) return;
  await notifyUser(b.driverUid, "payment_failed", { code: b.slotCode }, { link: `/?booking=${bookingId}`, priority: "high" });
  await alertAdmins("payment_failed", { bookingId, summary: `${b.slotCode} · ${b.total.toLocaleString("en-US")} IQD · ${reason}` });
}
