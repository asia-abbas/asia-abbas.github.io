// FuratPay adapter.
//
// FuratPay is an Iraqi payment aggregator: one merchant account gives access to several
// payment services (FIB, Qi Card, FastPay, PayTabs …). The flow, taken from FuratPay's
// official WooCommerce integration (github.com/AramRafeq/woo-furatpay), is:
//
//   GET  {API_URL}/payment_service/linked/list   -> services enabled for the merchant
//   POST {API_URL}/invoice                       -> create an invoice, returns { id }
//   POST {API_URL}/public/invoice/pay            -> { invoice_id, payment_service_id } -> payment URL
//   GET  {API_URL}/invoice/{id}                  -> { status: "paid" | "pending" | "failed" | ... }
//   Webhook POST to our endpoint with headers x-timestamp + x-signature
//      signature = HMAC_SHA256(webhookSecret, id + code + order_number + timestamp) as hex
//
// All requests authenticate with the header  x-api-key: <API key>.
//
// TEST MODE: while FURATPAY_API_KEY is empty or "none", nothing is sent to FuratPay.
// The adapter returns test services and a built-in test checkout page, so the whole
// booking -> payment -> confirmation -> notification flow works before you have an account.

import crypto from "node:crypto";

export const isTestMode = (cfg) => !cfg.apiKey || cfg.apiKey.trim() === "" || cfg.apiKey.trim().toLowerCase() === "none";

const TEST_SERVICES = [
  { id: "test-fib", name: "FIB · First Iraqi Bank (test)", logo: "" },
  { id: "test-qi", name: "Qi Card (test)", logo: "" },
  { id: "test-fastpay", name: "FastPay (test)", logo: "" },
];

async function call(cfg, method, path, body) {
  const url = cfg.apiUrl.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method,
    headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
  if (!res.ok) {
    const err = new Error(`FuratPay ${method} ${path} failed (${res.status}): ${json.message || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Payment services the merchant has enabled (only active ones). */
export async function listServices(cfg) {
  if (isTestMode(cfg)) return TEST_SERVICES;
  const r = await call(cfg, "GET", "/payment_service/linked/list?limit=10&offset=0&status=production,testing");
  return (r.data || [])
    .filter((s) => !s.status || s.status === "active")
    .map((s) => ({ id: s.id, name: s.name, logo: s.logo || "" }));
}

/**
 * Create an invoice for a booking.
 * @param {object} p { number:int, bookingId, amount, title, customer:{ uid, name, phone } }
 * @returns invoice id
 */
export async function createInvoice(cfg, p) {
  if (isTestMode(cfg)) return `test_${p.bookingId}`;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const invoice = {
    code: p.bookingId,
    number: p.number,                // FuratPay requires an integer
    order_number: p.bookingId,
    currency_id: 3,                  // 3 = Iraqi Dinar (IQD)
    base_currency_id: 3,
    rate_id: -1,
    rate: 1,
    at: now,
    due_at: now,
    terms: "due_on_recept",
    subject: "Jêga parking",
    customer_notes: "",
    terms_and_conditions: "",
    notes: "",
    attachments: [],
    discount: 0,
    discount_type: "percentage",
    subtotal: p.amount,
    total: p.amount,
    status: "pending",
    remarks: "",
    items: [{ item: p.title, description: p.description || "", rate: p.amount, quantity: 1, discount: 0 }],
    meta_data: { bookingId: p.bookingId },
  };
  if (cfg.customerId) {
    invoice.customer_id = cfg.customerId;
  } else {
    // FuratPay creates the customer from this code if it doesn't exist yet
    invoice.customer_id = "jega_" + p.customer.uid;
    invoice.customer = {
      display_name: p.customer.name,
      phone_no: p.customer.phone,
      type: "individual",
      details: { name: p.customer.name, firstname: p.customer.name, lastname: "" },
    };
    if (cfg.customerEmailDomain) {
      invoice.customer.email = `${p.customer.uid}@${cfg.customerEmailDomain}`;
      invoice.customer.details.email = invoice.customer.email;
    }
  }
  const r = await call(cfg, "POST", "/invoice", invoice);
  if (!r.id) throw new Error("FuratPay invoice response has no id");
  return r.id;
}

/**
 * Start payment for an invoice with a chosen service.
 * @returns { url, qr?, code? }  url = where to send the driver (bank app link or card form)
 */
export async function pay(cfg, invoiceId, serviceId, testCheckoutUrl) {
  if (isTestMode(cfg)) {
    return { url: `${testCheckoutUrl}?invoice=${encodeURIComponent(invoiceId)}&service=${encodeURIComponent(serviceId)}` };
  }
  const r = await call(cfg, "POST", "/public/invoice/pay", { payment_service_id: serviceId, invoice_id: invoiceId });
  const d = r.data || {};
  const url = d.redirect_uri || r.formUrl || r.redirect_url || d.url || r.url || r.personalAppLink;
  if (!url) throw new Error("FuratPay pay response has no payment URL");
  return { url, qr: d.qrUrl || r.qrCode || null, code: r.readableCode || d.qrText || null };
}

/** Normalised invoice status: "paid" | "failed" | "pending". */
export async function invoiceStatus(cfg, invoiceId) {
  if (isTestMode(cfg)) return "pending"; // test invoices are settled by the test checkout page
  const r = await call(cfg, "GET", `/invoice/${encodeURIComponent(invoiceId)}`);
  const s = String(r.status || "").toLowerCase();
  if (s === "paid" || s === "completed") return "paid";
  if (["failed", "canceled", "cancelled", "expired"].includes(s)) return "failed";
  return "pending";
}

/** Verify a webhook call. Returns the parsed payload or throws. */
export function verifyWebhook(cfg, headers, payload) {
  const ts = headers["x-timestamp"];
  const sig = headers["x-signature"];
  if (!ts || Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) throw new Error("Invalid or expired timestamp");
  const d = payload?.data || {};
  const base = `${d.id ?? ""}${d.code ?? ""}${d.order_number ?? ""}${ts}`.trim();
  const expected = crypto.createHmac("sha256", cfg.webhookSecret).update(base).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(sig || ""));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid signature");
  return payload;
}
