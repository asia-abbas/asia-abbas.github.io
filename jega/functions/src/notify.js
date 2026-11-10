import { logger } from "firebase-functions/v2";
import { db, messaging, FieldValue } from "./common.js";
import { render, money } from "./messages.js";

/**
 * Send a notification to one app user:
 *  1. stores it in users/{uid}/notifications (the in-app bell + alert list)
 *  2. pushes it to every device the user registered (FCM web push), in the user's language
 * `vars.total` may be a number; it is formatted with the user's currency word.
 */
export async function notifyUser(uid, type, vars = {}, opts = {}) {
  const userRef = db.doc(`users/${uid}`);
  const user = (await userRef.get()).data();
  if (!user) return;
  const lang = user.lang || "en";
  const v = { ...vars };
  if (typeof v.total === "number") v.total = money(v.total, lang);
  const { title, body } = render(type, lang, v);
  const link = opts.link || "/";

  // chat messages are push-only; everything else also lands in the in-app notification list
  if (opts.inbox !== false) {
    await userRef.collection("notifications").add({
      type, title, body, link, read: false, at: FieldValue.serverTimestamp(),
      priority: opts.priority || "normal",
    });
  }

  if (user.notifyPush === false) return;
  const tokens = user.fcmTokens || [];
  if (!tokens.length) return;
  await pushToTokens(tokens, { title, body, link, tag: opts.tag || type }, async (bad) => {
    await userRef.update({ fcmTokens: FieldValue.arrayRemove(...bad) });
  });
}

/** Raise an alert in the admin dashboard and push it to admins who enabled notifications. */
export async function alertAdmins(type, data = {}, severity = "warning") {
  await db.collection("alerts").add({ type, severity, data, resolved: false, at: FieldValue.serverTimestamp() });
  const admins = await db.collection("admins").where("notifyPush", "==", true).get();
  const titles = {
    payment_failed: "Payment failed", new_slot: "New slot listed", report: "New report",
    webhook_error: "FuratPay webhook error", user_blocked_login: "Blocked user tried to sign in",
  };
  const body = data.summary || "";
  for (const a of admins.docs) {
    const tokens = a.data().fcmTokens || [];
    if (tokens.length) {
      await pushToTokens(tokens, { title: `Jêga Admin · ${titles[type] || type}`, body, link: "/#alerts", tag: "admin-" + type },
        async (bad) => a.ref.update({ fcmTokens: FieldValue.arrayRemove(...bad) }));
    }
  }
}

async function pushToTokens(tokens, { title, body, link, tag }, onBad) {
  try {
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { link, tag },
      webpush: {
        fcmOptions: { link },
        notification: { icon: "/icons/icon-192.png", badge: "/icons/badge-72.png", tag, renotify: true },
      },
    });
    const bad = [];
    res.responses.forEach((r, i) => {
      const code = r.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) bad.push(tokens[i]);
    });
    if (bad.length) await onBad(bad);
  } catch (e) {
    logger.error("push failed", e);
  }
}
