// Jêga Admin service worker: installable PWA, offline app shell, and FCM push alerts
// (payment failures, reports, new slots) while the dashboard is closed.
// Bump VERSION whenever you deploy changed admin files.
const VERSION = "jega-admin-v2";
const RUNTIME = "jega-admin-runtime-v2";
const SHELL = [
  "/", "/index.html", "/css/admin.css", "/js/admin.js", "/js/firebase-config.js",
  "/manifest.webmanifest", "/favicon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/badge-72.png",
];
const CDN_HOSTS = new Set(["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com", "tile.openstreetmap.org"]);

try {
  importScripts("/js/firebase-config.js"); // defines self.FIREBASE_CONFIG
  const cfg = self.FIREBASE_CONFIG;
  if (cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("PASTE_") && cfg.messagingSenderId && !String(cfg.messagingSenderId).startsWith("PASTE_")) {
    importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
    firebase.initializeApp(cfg);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage((payload) => {
      if (payload.notification) return; // FCM shows these itself
      const d = payload.data || {};
      self.registration.showNotification(d.title || "Jêga Admin", {
        body: d.body || "", icon: "/icons/icon-192.png", badge: "/icons/badge-72.png", tag: d.tag, data: { link: d.link || "/#alerts" },
      });
    });
  }
} catch (err) {
  // Push unavailable (offline or placeholder config); the installable shell still works.
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = e.notification.data?.FCM_MSG?.data?.link || e.notification.data?.link || "/#alerts";
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = all.find((w) => new URL(w.url).origin === location.origin);
    if (c) { await c.navigate(link).catch(() => {}); return c.focus(); }
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

// Network first for our own files (always fresh data/code when online), cache fallback offline.
// Cache-first with background refresh for fonts, Leaflet and map tiles.
// Firebase traffic is never touched.
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
      if (e.request.mode === "navigate") return (await caches.match("/index.html")) || (await caches.match("/")) || Response.error();
      return Response.error();
    }
  })());
});
