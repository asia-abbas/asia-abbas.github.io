import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhook, isTestMode, listServices, pay } from "../src/furatpay.js";
import { render, money } from "../src/messages.js";

// common.js initialises firebase-admin; only pure helpers are imported below
const { normPhone, startDate } = await import("../src/common.js");

test("normalises Iraqi phone numbers", () => {
  assert.equal(normPhone("0750 123 4567"), "+9647501234567");
  assert.equal(normPhone("+964 770 908 1144"), "+9647709081144");
  assert.equal(normPhone("009647511234567"), "+9647511234567");
  assert.equal(normPhone("0740 123 4567"), null);
  assert.equal(normPhone("12345"), null);
});

test("booking start is Erbil local time", () => {
  assert.equal(startDate("2026-11-10", 16).toISOString(), "2026-11-10T13:00:00.000Z");
});

test("webhook signature matches FuratPay's scheme", () => {
  const cfg = { webhookSecret: "s3cret" };
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = { type: "INVOICE_PAID", data: { id: "inv1", code: "bk1", order_number: "bk1" } };
  const sig = crypto.createHmac("sha256", "s3cret").update(`inv1bk1bk1${ts}`).digest("hex");
  assert.deepEqual(verifyWebhook(cfg, { "x-timestamp": ts, "x-signature": sig }, payload), payload);
  assert.throws(() => verifyWebhook(cfg, { "x-timestamp": ts, "x-signature": "bad" }, payload));
  assert.throws(() => verifyWebhook(cfg, { "x-timestamp": "1", "x-signature": sig }, payload));
});

test("test mode needs no FuratPay account", async () => {
  assert.ok(isTestMode({ apiKey: "none" }));
  assert.ok(isTestMode({ apiKey: "" }));
  assert.ok(!isTestMode({ apiKey: "live_abc" }));
  assert.equal((await listServices({ apiKey: "none" })).length, 3);
  const r = await pay({ apiKey: "none" }, "test_bk1", "test-fib", "https://x/testCheckout");
  assert.match(r.url, /testCheckout\?invoice=test_bk1/);
});

test("notifications render in all four languages", () => {
  for (const l of ["en", "ar", "ckb", "kmr"]) {
    const r = render("booking_new", l, { code: "A-07", driver: "Aram", when: "2026-11-10 16:00–18:00", total: money(3000, l) });
    assert.ok(r.title.includes("A-07"));
    assert.ok(r.body.includes("3,000"));
  }
});
