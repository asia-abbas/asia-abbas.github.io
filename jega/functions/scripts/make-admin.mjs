// Create (or promote) an owner/admin account for the Jêga Admin dashboard.
//
// Usage (from the functions folder):
//   1. Firebase console → Project settings → Service accounts → Generate new private key
//      Save it as functions/service-account.json (this file is git-ignored; never share it).
//   2. node scripts/make-admin.mjs owner@example.com "a-strong-password"
//   To remove admin rights:  node scripts/make-admin.mjs owner@example.com --remove
//
// Admins sign in with email + password at the admin site. Phone accounts from the app can never be admins.
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const [email, pass] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/make-admin.mjs <email> "<password>"   |   <email> --remove');
  process.exit(1);
}
const sa = JSON.parse(readFileSync(new URL("../service-account.json", import.meta.url)));
initializeApp({ credential: cert(sa) });
const auth = getAuth(), db = getFirestore();

if (pass === "--remove") {
  const u = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(u.uid, { admin: false });
  await auth.revokeRefreshTokens(u.uid);
  await db.doc(`admins/${u.uid}`).delete();
  console.log(`Removed admin rights from ${email}`);
  process.exit(0);
}

let user;
try {
  user = await auth.getUserByEmail(email);
  if (pass) await auth.updateUser(user.uid, { password: pass });
} catch {
  if (!pass || pass.length < 10) { console.error("Give a password of at least 10 characters for a new admin."); process.exit(1); }
  user = await auth.createUser({ email, password: pass, emailVerified: true });
}
await auth.setCustomUserClaims(user.uid, { admin: true });
await db.doc(`admins/${user.uid}`).set({ email, notifyPush: false, createdAt: FieldValue.serverTimestamp() }, { merge: true });
console.log(`✓ ${email} is an admin (uid ${user.uid}). Sign in at your admin site.`);
process.exit(0);
