// Firebase wiring for the Jêga app (modular SDK from Google's CDN, no build step).
const V = "10.12.2";
const base = `https://www.gstatic.com/firebasejs/${V}`;

const { initializeApp } = await import(`${base}/firebase-app.js`);
const authMod = await import(`${base}/firebase-auth.js`);
const fs = await import(`${base}/firebase-firestore.js`);
const fnMod = await import(`${base}/firebase-functions.js`);
import { firebaseConfig, FUNCTIONS_REGION, USE_EMULATORS, VAPID_KEY } from "./config.js";

export const app = initializeApp(firebaseConfig);
export const auth = authMod.getAuth(app);
export const db = fs.initializeFirestore(app, {
  localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
});
export const functions = fnMod.getFunctions(app, FUNCTIONS_REGION);

if (USE_EMULATORS) {
  authMod.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  fnMod.connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export { authMod, fs };
export const call = (name) => fnMod.httpsCallable(functions, name);

/** Turn on push alerts for this device. Returns "on" | "denied" | "unsupported". */
export async function enablePush(uid, swReg) {
  if (!("Notification" in window) || !swReg) return "unsupported";
  const msg = await import(`${base}/firebase-messaging.js`);
  if (!(await msg.isSupported())) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const messaging = msg.getMessaging(app);
  const token = await msg.getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
  if (!token) return "unsupported";
  await fs.updateDoc(fs.doc(db, "users", uid), { fcmTokens: fs.arrayUnion(token), notifyPush: true });
  localStorage.setItem("jega.fcm", token);
  return "on";
}

export async function disablePush(uid) {
  const token = localStorage.getItem("jega.fcm");
  await fs.updateDoc(fs.doc(db, "users", uid), {
    notifyPush: false, ...(token ? { fcmTokens: fs.arrayRemove(token) } : {}),
  });
  localStorage.removeItem("jega.fcm");
}

/** Messages that arrive while the app is open (chat pushes are not in the notification list). */
export async function onForegroundPush(cb) {
  try {
    const msg = await import(`${base}/firebase-messaging.js`);
    if (!(await msg.isSupported())) return;
    msg.onMessage(msg.getMessaging(app), cb);
  } catch { /* push unsupported */ }
}
