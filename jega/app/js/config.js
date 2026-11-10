import "./firebase-config.js"; // sets self.FIREBASE_CONFIG — edit that file
export const firebaseConfig = self.FIREBASE_CONFIG;

// Firebase console → Project settings → Cloud Messaging → Web Push certificates → Key pair
export const VAPID_KEY = "PASTE_WEB_PUSH_KEY_PAIR";

// Must match REGION in functions/src/common.js
export const FUNCTIONS_REGION = "europe-west1";

// Map starts here (Erbil centre). Change for another city.
export const MAP_CENTER = [36.1911, 44.0092];
export const MAP_ZOOM = 13;

// Set true to use the local Firebase emulators (firebase emulators:start)
export const USE_EMULATORS = location.hostname === "localhost" || location.hostname === "127.0.0.1";
