// Jêga service worker: offline app shell + runtime asset caching + Firebase Cloud Messaging (background push).
// Bump VERSION whenever you deploy changed app files so phones pick them up.
const VERSION = "jega-v2";
const RUNTIME = "jega-runtime-v2";
const SHELL = [
  "./", "./index.html", "./css/app.css", "./js/app.js", "./js/i18n.js", "./js/fb.js", "./js/config.js", "./js/firebase-config.js", "./js/hero.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/badge-72.png",
];
const CDN_HOSTS = new Set(["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com", "tile.openstreetmap.org"]);

try {
  importScripts("./js/firebase-config.js"); // defines self.FIREBASE_CONFIG
  const cfg = self.FIREBASE_CONFIG;
  if (cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("PASTE_") && cfg.messagingSenderId && !String(cfg.messagingSenderId).startsWith("PASTE_")) {
    importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
    firebase.initializeApp(cfg);
    const messaging = firebase.messaging();

    // Data-only or background messages: show a system notification.
    // (Messages with a "notification" block are shown automatically by FCM.)
    messaging.onBackgroundMessage((payload) => {
      if (payload.notification) return;
      const d = payload.data || {};
      self.registration.showNotification(d.title || "Jêga", {
        body: d.body || "", icon: "./icons/icon-192.png", badge: "./icons/badge-72.png", tag: d.tag, data: { link: d.link || "./" },
      });
    });
  }
} catch (err) {
  // Push messaging unavailable (offline install or placeholder config); offline PWA shell still works.
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = e.notification.data?.FCM_MSG?.data?.link || e.notification.data?.link || "./";
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === location.origin) { await c.navigate(link); return c.focus(); }
    }
    return clients.openWindow(link);
  })());
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  const keep = new Set([VERSION, RUNTIME]);
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for our own files (fresh after deploys), cache as fallback when offline.
// Cache-first with background refresh for CDN fonts, Leaflet, and map tiles.
// Firebase/Firestore traffic is never cached here; Firestore has its own offline cache.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (CDN_HOSTS.has(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(e.request);
      const net = fetch(e.request).then((res) => {
        if (res.ok || res.type === "opaque") cache.put(e.request, res.clone());
        return res;
      }).catch(() => cached || Response.error());
      return cached || net;
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(VERSION)).put(e.request, res.clone());
      return res;
    } catch {
      const cached = (await caches.match(e.request)) || (await caches.match(url.pathname));
      if (cached) return cached;
      if (e.request.mode === "navigate") {
        return (await caches.match("./index.html")) || (await caches.match("./")) || Response.error();
      }
      return Response.error();
    }
  })());
});
