import { defineSecret, defineString } from "firebase-functions/params";

// Secrets (set with: firebase functions:secrets:set NAME). Use "none" until you have a FuratPay account.
export const FURATPAY_API_KEY = defineSecret("FURATPAY_API_KEY");
export const FURATPAY_WEBHOOK_SECRET = defineSecret("FURATPAY_WEBHOOK_SECRET");

// Plain config (functions/.env)
export const FURATPAY_API_URL = defineString("FURATPAY_API_URL", { default: "https://api.furatpay.com/v1" });
export const FURATPAY_CUSTOMER_ID = defineString("FURATPAY_CUSTOMER_ID", { default: "" });
export const FURATPAY_CUSTOMER_EMAIL_DOMAIN = defineString("FURATPAY_CUSTOMER_EMAIL_DOMAIN", { default: "" });
export const APP_URL = defineString("APP_URL", { default: "https://your-project-id.web.app" });

export function furatCfg() {
  return {
    apiKey: FURATPAY_API_KEY.value(),
    webhookSecret: FURATPAY_WEBHOOK_SECRET.value(),
    apiUrl: FURATPAY_API_URL.value(),
    customerId: FURATPAY_CUSTOMER_ID.value(),
    customerEmailDomain: FURATPAY_CUSTOMER_EMAIL_DOMAIN.value(),
  };
}
