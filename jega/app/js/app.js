import { LANGS, AREAS, FEATS, t, tx, setLang, getLang, dirOf } from "./i18n.js";
import { auth, db, authMod, fs, call, enablePush, disablePush, onForegroundPush } from "./fb.js";
import { MAP_CENTER, MAP_ZOOM } from "./config.js";
import { heroSVG } from "./hero.js";

const { collection, doc, query, where, orderBy, limit, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, getDoc, writeBatch, serverTimestamp } = fs;

/* ================= state ================= */
const st = {
  user: null, profile: null, config: {},
  slots: [], mySlots: [], myBookings: [], hostBookings: [], chats: [], notifs: [],
  tab: "park", view: "list", area: "all", q: "", chat: null, me: null,
  unsubs: [], swReg: null, installEvt: null, seenNotifs: new Set(), booted: false,
};
const LS = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
setLang(LS.get("jega.lang", guessLang()));

function guessLang() {
  const n = (navigator.language || "en").toLowerCase();
  if (n.startsWith("ckb") || n === "ku-iq") return "ckb";
  if (n.startsWith("kmr") || n.startsWith("ku")) return "kmr";
  if (n.startsWith("ar")) return "ar";
  return "en";
}

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString("en-US");
const iqd = (n) => `${num(n)} ${t("iqd")}`;
const pad2 = (n) => String(n).padStart(2, "0");
const LTR = (s) => `<bdi dir="ltr">${esc(s)}</bdi>`;
const initials = (n) => String(n || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad" }).format(new Date());
const nowHour = () => parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Baghdad", hour: "2-digit", hourCycle: "h23" }).format(new Date()), 10);
const tsMs = (v) => (v?.toMillis ? v.toMillis() : v?.seconds ? v.seconds * 1000 : 0);
const when = (b) => `${b.date} · ${pad2(b.start)}:00–${pad2(b.start + b.hours)}:00`;
const stamp = (ms) => ms ? new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const areaName = (k) => tx(AREAS, k);
const featName = (k) => tx(FEATS, k);
const isMine = (s) => st.user && s.hostUid === st.user.uid;
const costOf = (s, h) => (s.mode === "flat" ? s.price : s.price * h);
function km(a, b) {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const d = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(d));
}
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.setAttribute("role", "status"); el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}
function errText(e, vars = {}) {
  const m = String(e?.message || ""), c = String(e?.code || "");
  const map = { clash: "errClash", closed: "errClosed", "in-past": "errPast", "slot-off": "errSlotOff", "too-long": "errTooLong",
    "past-midnight": "errMidnight", blocked: "blocked", "bad-phone": "errPhone", "need-name": "errName", "pay-unavailable": "payUnavailable",
    "online-off": "payUnavailable", expired: "payFailed" };
  for (const k in map) if (m.includes(k)) return t(map[k], vars);
  if (c.includes("resource-exhausted")) return t("tooMany");
  return t("genericErr");
}
function applyLang() {
  document.documentElement.lang = getLang();
  document.documentElement.dir = dirOf(getLang());
}
function setLanguage(l) {
  setLang(l); LS.set("jega.lang", l); applyLang();
  if (st.user) updateDoc(doc(db, "users", st.user.uid), { lang: l }).catch(() => {});
  render();
}
const ICON = {
  park: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 17V8h3a3 3 0 0 1 0 6h-3"/></svg>',
  host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
  globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>',
  pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  send: '<svg class="flip" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg class="flip" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 6l-6 6 6 6"/></svg>',
  install: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
};

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true || st.installed;
const isIosDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
async function triggerInstall() {
  if (st.installEvt) {
    st.installEvt.prompt();
    await st.installEvt.userChoice.catch(() => {});
    st.installEvt = null;
    render();
    return;
  }
  sheet(`<div class="stack">
    <h2>${t("install")}</h2>
    <p class="lead">${isIosDevice() ? t("installIos") : t("installSub")}</p>
  </div>`);
}

/* ================= boot ================= */
applyLang();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then((r) => {
    st.swReg = r;
    r.addEventListener("updatefound", () => {
      const nw = r.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          nw.postMessage({ type: "SKIP_WAITING" });
        }
      });
    });
  }).catch(() => {});
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); st.installEvt = e; schedule(); });
window.addEventListener("appinstalled", () => { st.installEvt = null; st.installed = true; schedule(); });
window.addEventListener("online", banner);
window.addEventListener("offline", banner);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
onForegroundPush((p) => {
  const link = p.data?.link || "";
  const chatId = new URLSearchParams(link.split("?")[1] || "").get("chat");
  if (chatId && st.chat === chatId) return;          // already looking at that chat
  if (chatId) toast(`${p.notification?.title}: ${p.notification?.body}`);
});

authMod.onAuthStateChanged(auth, (u) => {
  st.unsubs.forEach((f) => f()); st.unsubs = [];
  st.user = u;
  st.seenNotifs.clear(); st._notifInit = false;
  if (!u) { st.profile = null; st.booted = false; return render(); }
  listen();
});

function listen() {
  const uid = st.user.uid;
  const on = (q, cb) => st.unsubs.push(onSnapshot(q, cb, (e) => console.warn(e)));
  const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  on(doc(db, "users", uid), (s) => {
    st.profile = s.data() || null;
    if (st.profile?.blocked) { toast(t("blocked"), "bad"); authMod.signOut(auth); return; }
    if (st.profile && st.profile.lang !== getLang()) updateDoc(s.ref, { lang: getLang() }).catch(() => {});
    if (!st.booted) { st.booted = true; handleDeepLink(); }
    schedule();
  });
  on(doc(db, "config", "app"), (s) => { st.config = s.data() || {}; schedule(); });
  on(query(collection(db, "slots"), where("status", "==", "active")), (s) => { st.slots = list(s); schedule(); updateMarkers(); });
  on(query(collection(db, "slots"), where("hostUid", "==", uid)), (s) => { st.mySlots = list(s); schedule(); });
  on(query(collection(db, "bookings"), where("driverUid", "==", uid), orderBy("createdAt", "desc"), limit(50)), (s) => { st.myBookings = list(s); schedule(); });
  on(query(collection(db, "bookings"), where("hostUid", "==", uid), orderBy("createdAt", "desc"), limit(50)), (s) => { st.hostBookings = list(s); schedule(); });
  on(query(collection(db, "chats"), where("members", "array-contains", uid), orderBy("lastAt", "desc")), (s) => { st.chats = list(s); schedule(); });
  on(query(collection(db, "users", uid, "notifications"), orderBy("at", "desc"), limit(60)), (s) => {
    const first = st.seenNotifs.size === 0 && !st._notifInit;
    st._notifInit = true;
    s.docChanges().forEach((c) => {
      if (c.type !== "added" || st.seenNotifs.has(c.doc.id)) return;
      st.seenNotifs.add(c.doc.id);
      const n = c.doc.data();
      if (!first && !n.read) alertBanner(c.doc.id, n);   // live in-app alert
    });
    st.notifs = list(s); schedule();
  });
}

let pending = false;
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }

function handleDeepLink() {
  const p = new URLSearchParams(location.search);
  if (p.get("tab")) st.tab = p.get("tab");
  if (p.get("chat")) st.chat = p.get("chat");
  if (p.get("booking")) setTimeout(() => openBooking(p.get("booking")), 300);
  if ([...p.keys()].length) history.replaceState(null, "", location.pathname);
}

/* ================= in-app alerts ================= */
function alertBanner(id, n) {
  const box = $("#alerts");
  const el = document.createElement("button");
  el.className = "alert " + (n.priority === "high" ? "high" : "");
  el.innerHTML = `${ICON.bell}<span><b>${esc(n.title)}</b><small>${esc(n.body)}</small></span>`;
  el.onclick = () => { el.remove(); openNotif({ id, ...n }); };
  box.prepend(el);
  if (navigator.vibrate && n.priority === "high") navigator.vibrate([80, 40, 80]);
  setTimeout(() => el.remove(), n.priority === "high" ? 12000 : 6000);
}
function banner() {
  const b = $("#netbar");
  if (!b) return;
  b.hidden = navigator.onLine;
  b.textContent = t("offline");
}

/* ================= render ================= */
function render() {
  applyLang();
  banner();
  if (!st.user) return renderLogin();
  if (!st.profile) return ($("#app").innerHTML = `<div class="center hint">${t("loading")}</div>`);
  if (st.chat) return renderChat();
  const unread = st.notifs.filter((n) => !n.read).length;
  const chatUnread = st.chats.reduce((a, c) => a + (c.unread?.[st.user.uid] || 0), 0);
  const ann = st.config.announcement;
  const annText = ann ? (typeof ann === "string" ? ann : ann[getLang()] || ann.en) : "";
  const views = { park: viewPark, host: viewHost, chats: viewChats, me: viewMe };
  const keepMap = st.tab === "park" && st.view === "map";
  const showInstallBtn = !isStandalone() && (st.installEvt || isIosDevice());
  $("#app").innerHTML = `
    <header class="top pad">
      <div class="logo"><div class="logo-mark">J</div><div class="logo-name">Jêga <span class="logo-ku">جێگا</span></div></div>
      <div class="top-actions">
        ${showInstallBtn ? `<button class="iconbtn" id="instTop" aria-label="${t("install")}" title="${t("install")}">${ICON.install}</button>` : ""}
        <button class="iconbtn" id="lb" aria-label="${t("language")}">${ICON.globe}</button>
        <button class="iconbtn" id="bell" aria-label="${t("notifs")}">${ICON.bell}${unread ? `<span class="dot">${unread > 9 ? "9+" : unread}</span>` : ""}</button>
      </div>
    </header>
    ${annText ? `<div class="pad"><div class="announce">${esc(annText)}</div></div>` : ""}
    <main class="view pad">${views[st.tab]()}</main>
    <nav class="tabs"><div class="tabs-in">
      ${[["park", "tPark", "park"], ["host", "tHost", "host"], ["chats", "tChats", "chat"], ["me", "tMe", "me"]].map(([k, l, i]) => `
      <button class="tab" data-tab="${k}" ${st.tab === k ? 'aria-current="page"' : ""}>${ICON[i]}${t(l)}${k === "chats" && chatUnread ? `<span class="dot">${chatUnread}</span>` : ""}</button>`).join("")}
    </div></nav>`;
  $$("[data-tab]").forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; render(); scrollTo(0, 0); }));
  if ($("#instTop")) $("#instTop").onclick = triggerInstall;
  $("#lb").onclick = openLang;
  $("#bell").onclick = openNotifs;
  bindCommon();
  if (keepMap) mountMap();
}

function langGrid() {
  return `<div class="langs">${LANGS.map((l) => `<button type="button" class="lang" data-lang="${l.id}" aria-pressed="${getLang() === l.id}" dir="${l.dir}">
    <b class="${l.dir === "rtl" ? "ar" : ""}">${l.name}</b><small>${l.sub}</small></button>`).join("")}</div>`;
}
function bindLang(scope = document) {
  $$("[data-lang]", scope).forEach((b) => (b.onclick = () => { setLanguage(b.dataset.lang); closeSheet(); }));
}
function openLang() {
  sheet(`<div class="stack"><h2>${t("language")}</h2>${langGrid()}</div>`);
  bindLang($("#layer"));
}

/* ================= login ================= */
function renderLogin() {
  const keepP = $("#ph")?.value || "", keepN = $("#nm")?.value || "";
  const canInstall = !isStandalone() && (st.installEvt || isIosDevice());
  $("#app").innerHTML = `
  <div class="login pad">
    <div class="row-between"><div class="logo"><div class="logo-mark">J</div><div><div class="logo-name">Jêga</div><div class="logo-ku">جێگا</div></div></div>
      ${canInstall ? `<button type="button" class="btn ghost sm" id="instLogin">${ICON.install}${t("install")}</button>` : ""}</div>
    <div class="hero">
      <h1>${t("hero1")}<br><em>${t("hero2")}</em></h1>
      <div class="hero-art" aria-hidden="true">${heroSVG(`1,500 ${t("iqd")}`)}</div>
    </div>
    <div class="field"><span class="label">${t("language")}</span>${langGrid()}</div>
    <form id="lf" class="stack" novalidate>
      <div class="field"><label class="label" for="ph">${t("phone")}</label>
        <div class="phone" dir="ltr"><span>+964</span><input id="ph" inputmode="tel" autocomplete="tel" placeholder="750 123 4567" maxlength="14"></div></div>
      <div class="field"><label class="label" for="nm">${t("name")}</label>
        <input id="nm" class="input" autocomplete="name" placeholder="${t("namePh")}" maxlength="40"></div>
      <div class="err" id="le" role="alert"></div>
      <button class="btn dark" type="submit" id="lgo">${t("cont")}</button>
      <p class="hint">${t("loginHint")}</p>
    </form>
  </div>`;
  $("#ph").value = keepP; $("#nm").value = keepN;
  if ($("#instLogin")) $("#instLogin").onclick = triggerInstall;
  bindLang();
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const digits = $("#ph").value.replace(/\D/g, "").replace(/^964/, "").replace(/^0/, "");
    if (!/^7[5-9]\d{8}$/.test(digits)) return ($("#le").textContent = t("errPhone"));
    const name = $("#nm").value.trim();
    $("#lgo").disabled = true; $("#le").textContent = "";
    try {
      const r = await call("phoneLogin")({ phone: "0" + digits, name, lang: getLang() });
      await authMod.signInWithCustomToken(auth, r.data.token);
    } catch (err) {
      $("#le").textContent = errText(err);
      $("#lgo").disabled = false;
    }
  };
}

/* ================= park ================= */
function modeSwitch() {
  return `<div class="modes">
    <button class="mode" data-go="park" aria-pressed="${st.tab === "park"}"><b>${t("needPark")}</b><small>${t("needParkSub")}</small></button>
    <button class="mode" data-go="host" aria-pressed="${st.tab === "host"}"><b>${t("haveSlot")}</b><small>${t("haveSlotSub")}</small></button>
  </div>`;
}
function priceBlock(s) {
  return s.mode === "flat"
    ? `<div class="price"><b>${num(s.price)}</b><small>${t("iqd")}</small><span class="flat">${t("flatTag")}</span></div>`
    : `<div class="price"><b>${num(s.price)}</b><small>${t("perHr")}</small></div>`;
}
function hoursText(s) { return s.allDay ? "24/7" : `${s.opens}–${s.closes}`; }
function slotCard(s, extra = "") {
  const d = st.me && s.lat ? km(st.me, [s.lat, s.lng]) : null;
  return `<button class="slot" data-slot="${s.id}">
    <div class="code">${esc(s.code)}</div>
    <div class="slot-main"><h3 dir="auto">${esc(s.title)}</h3>
      <div class="slot-sub">${esc(areaName(s.area))} · ${LTR(hoursText(s))}${d !== null ? ` · ${t("km", { d: d.toFixed(1) })}` : ""}</div>
      <div class="tags">${isMine(s) ? `<span class="tag you">${t("yourSlot")}</span>` : ""}${extra}${(s.feat || []).map((f) => `<span class="tag">${esc(featName(f))}</span>`).join("")}</div></div>
    ${priceBlock(s)}
  </button>`;
}
function filteredSlots() {
  const q = st.q.toLowerCase();
  let list = st.slots.filter((s) => s.active && (st.area === "all" || s.area === st.area) &&
    (!q || [s.title, s.landmark, areaName(s.area), AREAS[s.area]?.en, s.code].join(" ").toLowerCase().includes(q)));
  if (st.me) list = list.sort((a, b) => km(st.me, [a.lat, a.lng]) - km(st.me, [b.lat, b.lng]));
  return list;
}
function viewPark() {
  const list = filteredSlots();
  return `${modeSwitch()}
  <div class="search"><input id="q" class="input" type="search" placeholder="${t("search")}" value="${esc(st.q)}" aria-label="${t("search")}">
    <button class="btn ghost sm" id="near">${ICON.pin}${t("nearMe")}</button></div>
  <div class="chips">${[["all", t("all")], ...Object.keys(AREAS).map((k) => [k, areaName(k)])].map(([k, l]) => `<button class="chip" data-area="${k}" aria-pressed="${st.area === k}">${esc(l)}</button>`).join("")}</div>
  <div class="row-between"><span class="label">${t("count", { n: list.length })}</span>
    <div class="toggle" role="group"><button data-view="list" aria-pressed="${st.view === "list"}">${t("list")}</button><button data-view="map" aria-pressed="${st.view === "map"}">${t("map")}</button></div></div>
  ${st.view === "map" ? `<div id="mapslot" class="mapbox big"></div>` : `<div class="list">${list.length ? list.map((s) => slotCard(s)).join("") : `<div class="empty">${t("noMatch")}</div>`}</div>`}`;
}

/* ---- map (Leaflet + OpenStreetMap) ---- */
let mainMap = null, mapEl = null, markerLayer = null;
function mountMap() {
  const slot = $("#mapslot");
  if (!slot || !window.L) return;
  if (!mapEl) {
    mapEl = document.createElement("div"); mapEl.className = "mapfill";
    slot.appendChild(mapEl);
    mainMap = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView(st.me || MAP_CENTER, MAP_ZOOM);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mainMap);
    markerLayer = L.layerGroup().addTo(mainMap);
  } else slot.appendChild(mapEl);
  setTimeout(() => mainMap.invalidateSize(), 50);
  updateMarkers();
}
function updateMarkers() {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  filteredSlots().forEach((s) => {
    if (typeof s.lat !== "number") return;
    const icon = L.divIcon({ className: "", html: `<div class="pin ${s.mode === "flat" ? "flat" : ""} ${isMine(s) ? "mine" : ""}">${num(s.price)}</div>`, iconSize: null });
    L.marker([s.lat, s.lng], { icon, title: s.title }).on("click", () => openSlot(s.id)).addTo(markerLayer);
  });
  if (st.me) L.circleMarker(st.me, { radius: 7, color: "#fff", weight: 3, fillColor: "#1F6FEB", fillOpacity: 1 }).addTo(markerLayer);
}
function locate(cb) {
  if (!navigator.geolocation) return toast(t("locBlocked"), "bad");
  navigator.geolocation.getCurrentPosition(
    (p) => cb([p.coords.latitude, p.coords.longitude]),
    () => toast(t("locBlocked"), "bad"), { enableHighAccuracy: true, timeout: 10000 });
}
function smallMap(el, lat, lng, opts = {}) {
  const m = L.map(el, { zoomControl: !!opts.picker, dragging: true, scrollWheelZoom: false, attributionControl: false }).setView([lat, lng], opts.zoom || 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(m);
  const mk = L.marker([lat, lng], { draggable: !!opts.picker }).addTo(m);
  setTimeout(() => m.invalidateSize(), 80);
  return { m, mk };
}

/* ---- slot sheet + booking ---- */
function openSlot(id) {
  const s = st.slots.find((x) => x.id === id) || st.mySlots.find((x) => x.id === id);
  if (!s) return;
  const mine = isMine(s), maxH = s.maxH || 12;
  let hours = Math.min(2, maxH), pay = "cash";
  const open = s.allDay ? 0 : Math.ceil(parseFloat(s.opens.replace(":", ".")));
  const close = s.allDay ? 24 : (s.closes === "00:00" ? 24 : parseInt(s.closes, 10));
  const onlineOk = st.config.onlinePayments !== false;
  sheet(`
    <div class="stack">
      <div class="slot-head"><div class="code">${esc(s.code)}</div>
        <div class="grow"><h2 dir="auto">${esc(s.title)}</h2><div class="hint" dir="auto">${esc(s.landmark)}</div></div></div>
      <div class="mapbox" id="smap"></div>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}">${ICON.pin}${t("directions")}</a>
      <div class="facts">
        <div class="fact"><span class="label">${t("rate")}</span><b>${num(s.price)}</b><small>${s.mode === "flat" ? `${t("flatTag")} · ${t("upTo", { n: maxH })}` : t("perHr")}</small></div>
        <div class="fact"><span class="label">${t("open")}</span><b class="sm">${LTR(hoursText(s))}</b></div>
        <div class="fact"><span class="label">${t("area")}</span><b class="sm txt">${esc(areaName(s.area))}</b></div>
      </div>
      <div class="tags">${(s.feat || []).map((f) => `<span class="tag">${esc(featName(f))}</span>`).join("")}</div>
      <div class="card host-card"><div class="avatar">${initials(s.hostName)}</div>
        <div class="grow"><b>${esc(s.hostName)}</b><div class="hint mono">${LTR(s.hostPhone)}</div></div>
        ${mine ? "" : `<button class="btn ghost sm" id="msgHost">${t("message")}</button>`}</div>
      ${mine ? `<p class="hint">${t("mineNote")}</p>` : `
      <div class="row2">
        <div class="field"><label class="label" for="bd">${t("date")}</label><input id="bd" class="input" type="date" value="${today()}" min="${today()}"></div>
        <div class="field"><label class="label" for="bt">${t("start")}</label><select id="bt" class="input mono"></select></div>
      </div>
      <div class="field"><span class="label">${t("hours")}</span>
        <div class="stepper"><button id="hm" aria-label="${t("fewer")}">−</button><output id="hv"></output><button id="hp" aria-label="${t("more")}">+</button></div></div>
      <div class="field"><span class="label">${t("payHow")}</span>
        <div class="seg">
          <label><input type="radio" name="pay" value="cash" checked><b>${t("payCash")}</b><small>${t("payCashSub")}</small></label>
          ${onlineOk ? `<label><input type="radio" name="pay" value="online"><b>${t("payOnline")}</b><small>${t("payOnlineSub")}</small></label>` : ""}
        </div></div>
      <div class="total"><span id="tl"></span><b id="tt"></b></div>
      <div class="err" id="be" role="alert"></div>
      <button class="btn" id="book">${t("book", { c: s.code })}</button>
      <p class="hint">${t("hostsSee")}</p>
      <button class="linkbtn" id="rep">${t("report")}</button>`}
    </div>`);
  if (window.L && s.lat) smallMap($("#smap"), s.lat, s.lng);
  if (mine) return;
  const fillStarts = () => {
    const d = $("#bd").value, from = d === today() ? Math.max(open, nowHour() + 1) : open;
    const opts = [];
    for (let h = from; h < close; h++) opts.push(`<option value="${h}">${pad2(h)}:00</option>`);
    $("#bt").innerHTML = opts.join("") || `<option value="">—</option>`;
  };
  const upd = () => {
    $("#hv").innerHTML = `<span class="mono">${hours}</span> ${t("h")}`;
    $("#tt").textContent = iqd(costOf(s, hours));
    $("#tl").textContent = s.mode === "flat" ? t("totalFlat", { n: maxH }) : t("totalHour", { p: num(s.price), n: hours });
  };
  fillStarts(); upd();
  $("#bd").onchange = fillStarts;
  $("#hm").onclick = () => { if (hours > 1) { hours--; upd(); } };
  $("#hp").onclick = () => { if (hours < maxH) { hours++; upd(); } };
  $$("[name=pay]").forEach((r) => (r.onchange = () => (pay = r.value)));
  $("#msgHost").onclick = () => { closeSheet(); openChatForSlot(s); };
  $("#rep").onclick = () => openReport(s);
  $("#book").onclick = async () => {
    const date = $("#bd").value, start = parseInt($("#bt").value, 10);
    if (!date || Number.isNaN(start)) return ($("#be").textContent = t("errDate"));
    if (start + hours > 24) return ($("#be").textContent = t("errMidnight"));
    $("#book").disabled = true; $("#be").textContent = "";
    try {
      const r = await call("createBooking")({ slotId: s.id, date, start, hours, payMethod: pay });
      closeSheet();
      if (r.data.status === "pending_payment") openPay(r.data.bookingId);
      else { toast(t("status_confirmed"), "ok"); openBooking(r.data.bookingId); }
    } catch (e) {
      $("#be").textContent = errText(e, { n: maxH });
      $("#book").disabled = false;
    }
  };
}

function openReport(s) {
  sheet(`<form id="rf" class="stack"><h2>${t("report")}</h2><div class="hint">${esc(s.code)} · ${esc(s.title)}</div>
    <textarea id="rr" class="input" rows="4" maxlength="500" placeholder="${t("reportPh")}"></textarea>
    <button class="btn dark">${t("sendReport")}</button></form>`);
  $("#rf").onsubmit = async (e) => {
    e.preventDefault();
    const reason = $("#rr").value.trim();
    if (reason.length < 3) return;
    await addDoc(collection(db, "reports"), { by: st.user.uid, targetType: "slot", targetId: s.id, targetLabel: `${s.code} ${s.title}`, reason, at: serverTimestamp() });
    closeSheet(); toast(t("reportSent"), "ok");
  };
}

/* ---- online payment (FuratPay) ---- */
async function openPay(bookingId) {
  sheet(`<div class="stack"><h2>${t("chooseService")}</h2><div id="svc" class="hint">${t("loading")}</div></div>`);
  try {
    const r = await call("paymentServices")({});
    const b = st.myBookings.find((x) => x.id === bookingId);
    const mins = st.config.pendingPaymentMinutes || 15;
    $("#svc").outerHTML = `
      ${r.data.testMode ? `<p class="note warn">${t("testMode")}</p>` : ""}
      <p class="hint">${t("holdNote", { m: mins })}</p>
      <div class="svcs">${r.data.services.map((s) => `<button class="svc" data-svc="${esc(s.id)}">${s.logo ? `<img src="${esc(s.logo)}" alt="">` : ""}<b>${esc(s.name)}</b></button>`).join("")}</div>
      ${b ? `<div class="total"><span>${esc(b.slotCode)} · ${esc(when(b))}</span><b>${iqd(b.total)}</b></div>` : ""}
      <div class="err" id="pe" role="alert"></div>`;
    $$("[data-svc]").forEach((btn) => (btn.onclick = async () => {
      $$("[data-svc]").forEach((x) => (x.disabled = true));
      try {
        const p = await call("startPayment")({ bookingId, serviceId: btn.dataset.svc });
        // ("noopener" would make window.open return null even on success, so detach the opener by hand)
        const w = window.open(p.data.url, "_blank");
        if (w) w.opener = null;
        else location.href = p.data.url;   // popup blocked (common in installed PWAs): go there directly; we return via ?booking=
        openBooking(bookingId, p.data);
      } catch (e) {
        $("#pe").textContent = errText(e);
        $$("[data-svc]").forEach((x) => (x.disabled = false));
      }
    }));
  } catch (e) {
    $("#svc").textContent = errText(e);
  }
}

/* ---- booking detail (also the "waiting for payment" screen) ---- */
let bookingWatch = null;
function openBooking(id, payInfo) {
  stopWatch();
  const draw = (b) => {
    if (!b) return;
    const driver = b.driverUid === st.user.uid;
    const pend = b.status === "pending_payment";
    const left = pend ? Math.max(0, tsMs(b.expiresAt) - Date.now()) : 0;
    const canCancel = driver && ["pending_payment", "confirmed"].includes(b.status) && tsMs(b.startAt) > Date.now() && b.paymentStatus !== "paid";
    sheet(`<div class="stack">
      <div class="slot-head"><div class="code">${esc(b.slotCode)}</div><div class="grow"><h2 dir="auto">${esc(b.slotTitle)}</h2><div class="hint" dir="auto">${esc(b.landmark)}</div></div></div>
      <div><span class="status s-${b.status}">${t("status_" + b.status)}</span>
        ${b.paymentStatus === "paid" ? `<span class="status s-confirmed">${t("paidOnline")}</span>` : b.payMethod === "cash" ? `<span class="status">${t("payCash")}</span>` : ""}</div>
      ${pend ? `<div class="paywait"><div class="spinner" aria-hidden="true"></div><b>${t("waitingPay")}</b><p class="hint">${t("waitingPaySub")}</p>
        <div class="mono countdown" id="cd">${t("timeLeft", { m: Math.floor(left / 60000), s: pad2(Math.floor(left / 1000) % 60) })}</div>
        ${payInfo?.qr ? `<img class="qr" src="${esc(payInfo.qr)}" alt="QR">` : ""}${payInfo?.code ? `<div class="mono big">${esc(payInfo.code)}</div>` : ""}
        ${payInfo?.url ? `<a class="btn" href="${esc(payInfo.url)}" target="_blank" rel="noopener">${t("openPayAgain")}</a>` : `<button class="btn" id="repay">${t("payNow", { t: iqd(b.total) })}</button>`}
      </div>` : ""}
      <div class="facts">
        <div class="fact"><span class="label">${t("date")}</span><b class="sm">${LTR(b.date)}</b></div>
        <div class="fact"><span class="label">${t("start")}</span><b class="sm">${LTR(`${pad2(b.start)}:00–${pad2(b.start + b.hours)}:00`)}</b></div>
        <div class="fact"><span class="label">${t("rate")}</span><b class="sm">${num(b.total)}</b><small>${t("iqd")}</small></div>
      </div>
      ${b.lat ? `<div class="mapbox" id="bmap"></div><a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}">${ICON.pin}${t("directions")}</a>` : ""}
      <div class="card host-card"><div class="avatar">${initials(driver ? b.hostName : b.driverName)}</div>
        <div class="grow"><b>${esc(driver ? b.hostName : b.driverName)}</b><div class="hint mono">${LTR(driver ? b.hostPhone : b.driverPhone)}</div></div>
        <button class="btn ghost sm" id="bchat">${driver ? t("chatHost") : t("chatDriver")}</button></div>
      ${canCancel ? `<button class="btn ghost danger" id="bcancel">${t("cancelBooking")}</button>` : ""}
    </div>`, stopWatch);
    if (b.lat && window.L) smallMap($("#bmap"), b.lat, b.lng);
    $("#bchat").onclick = () => { closeSheet(); st.chat = `${b.slotId}_${b.driverUid}`; render(); };
    if ($("#repay")) $("#repay").onclick = () => openPay(id);
    if ($("#bcancel")) $("#bcancel").onclick = () => confirmBox(t("cancelConfirm"), t("yesCancel"), async () => {
      try { await call("cancelBooking")({ bookingId: id }); toast(t("status_cancelled")); } catch (e) { toast(errText(e), "bad"); }
    });
  };
  let last = null, prevStatus = null;
  bookingWatch = {
    unsub: onSnapshot(doc(db, "bookings", id), (s) => {
      last = s.exists() ? { id, ...s.data() } : null;
      if (prevStatus === "pending_payment" && last?.status === "confirmed") toast(t("paidOk"), "ok");
      if (prevStatus === "pending_payment" && ["cancelled", "expired"].includes(last?.status)) toast(t("payFailed"), "bad");
      prevStatus = last?.status;
      draw(last);
    }),
    tick: setInterval(() => {
      if (last?.status !== "pending_payment") return;
      const left = Math.max(0, tsMs(last.expiresAt) - Date.now());
      const el = $("#cd"); if (el) el.textContent = t("timeLeft", { m: Math.floor(left / 60000), s: pad2(Math.floor(left / 1000) % 60) });
    }, 1000),
    poll: setInterval(() => { if (last?.status === "pending_payment") call("checkPayment")({ bookingId: id }).catch(() => {}); }, 5000),
  };
}
function stopWatch() {
  if (!bookingWatch) return;
  bookingWatch.unsub(); clearInterval(bookingWatch.tick); clearInterval(bookingWatch.poll); bookingWatch = null;
}

/* ================= host ================= */
function viewHost() {
  const month = today().slice(0, 7);
  const fee = st.config.commissionPct ?? 10;
  const earned = st.hostBookings.filter((b) => ["confirmed", "completed"].includes(b.status) && b.date.startsWith(month)).reduce((a, b) => a + (b.hostEarning || 0), 0);
  const upcoming = st.hostBookings.filter((b) => ["pending_payment", "confirmed"].includes(b.status));
  return `${modeSwitch()}
  ${st.mySlots.length ? `<div class="earn"><span class="label">${t("earnings")}</span><b class="mono">${iqd(earned)}</b><small>${t("afterFee", { p: fee })}</small></div>` : ""}
  <div class="row-between"><h2>${t("yourSlots")}</h2><button class="btn sm" id="add">${t("add")}</button></div>
  <div class="list">${st.mySlots.length ? st.mySlots.map((s) => {
    const n = st.hostBookings.filter((b) => b.slotId === s.id && ["confirmed", "completed"].includes(b.status)).length;
    const susp = s.status === "suspended";
    return `<div class="card slotcard">
      ${slotCard(s, susp ? `<span class="tag bad">${t("suspended")}</span>` : "").replace('class="slot"', 'class="slot bare"')}
      ${susp && s.statusReason ? `<p class="hint bad">${esc(s.statusReason)}</p>` : ""}
      <div class="row-between line"><span class="hint">${n} × ${t("status_confirmed")}</span>
        <div class="row"><button class="linkbtn" data-edit="${s.id}">${t("edit")}</button>
        <label class="switch"><input type="checkbox" data-toggle="${s.id}" ${s.active ? "checked" : ""} ${susp ? "disabled" : ""}> ${s.active ? t("listed") : t("hidden")}</label></div>
      </div></div>`;
  }).join("") : `<div class="empty"><b>${t("emptyHost1")}</b><br>${t("emptyHost2")}</div>`}</div>
  ${upcoming.length ? `<h2 class="mt">${t("incoming")}</h2><div class="card list-card">${upcoming.map(bookingRow).join("")}</div>` : ""}`;
}
function bookingRow(b) {
  const other = b.driverUid === st.user.uid ? b.hostName : b.driverName;
  return `<button class="booking" data-booking="${b.id}"><div class="grow"><b class="mono">${LTR(b.slotCode)}</b> · ${esc(other)}
    <div class="hint">${LTR(when(b))} · ${iqd(b.total)}</div></div><span class="status s-${b.status}">${t("status_" + b.status)}</span></button>`;
}

function openSlotForm(existing) {
  const s = existing || { title: "", area: "ainkawa", landmark: "", mode: "hour", price: 1500, maxH: 12, opens: "08:00", closes: "22:00", allDay: false, feat: [], lat: MAP_CENTER[0], lng: MAP_CENTER[1] };
  let lat = s.lat, lng = s.lng;
  sheet(`<form id="af" class="stack" novalidate>
    <h2>${existing ? t("edit") + " " + esc(s.code) : t("listTitle")}</h2>
    <div class="field"><label class="label" for="at">${t("title")}</label><input id="at" class="input" placeholder="${t("titlePh")}" maxlength="60" value="${esc(s.title)}"></div>
    <div class="field"><label class="label" for="aa">${t("area")}</label><select id="aa" class="input">${Object.keys(AREAS).map((k) => `<option value="${k}" ${s.area === k ? "selected" : ""}>${esc(areaName(k))}</option>`).join("")}</select></div>
    <div class="field"><span class="label">${t("pinTitle")}</span><div class="mapbox" id="pmap"></div>
      <div class="row-between"><span class="hint">${t("pinHint")}</span><button type="button" class="btn ghost sm" id="myloc">${ICON.pin}${t("useMyLoc")}</button></div></div>
    <div class="field"><span class="label">${t("pricing")}</span>
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="pm" id="pm-hour" value="hour" ${s.mode === "hour" ? "checked" : ""}><b>${t("pHour")}</b><small>${t("pHourSub")}</small></label>
        <label><input type="radio" name="pm" id="pm-flat" value="flat" ${s.mode === "flat" ? "checked" : ""}><b>${t("pFlat")}</b><small>${t("pFlatSub")}</small></label>
      </div></div>
    <div class="row2">
      <div class="field"><label class="label" for="ap" id="apl">${s.mode === "flat" ? t("priceFlat") : t("priceHour")}</label><input id="ap" class="input mono" inputmode="numeric" value="${s.price}" dir="ltr"></div>
      <div class="field"><label class="label" for="ax">${t("maxH")}</label><input id="ax" class="input mono" inputmode="numeric" value="${s.maxH}" dir="ltr"></div>
    </div>
    <div class="field"><label class="label" for="al">${t("landmark")}</label><input id="al" class="input" placeholder="${t("landmarkPh")}" maxlength="120" value="${esc(s.landmark)}"></div>
    <label class="switch"><input type="checkbox" id="a24" ${s.allDay ? "checked" : ""}> ${t("allDay")}</label>
    <div class="row2" id="hrs" ${s.allDay ? "hidden" : ""}>
      <div class="field"><label class="label" for="ao">${t("opens")}</label><input id="ao" class="input" type="time" value="${s.opens || "08:00"}"></div>
      <div class="field"><label class="label" for="ac">${t("closes")}</label><input id="ac" class="input" type="time" value="${s.closes || "22:00"}"></div>
    </div>
    <div class="field"><span class="label">${t("features")}</span>
      <div class="checks">${Object.keys(FEATS).map((f) => `<label><input type="checkbox" value="${f}" ${(s.feat || []).includes(f) ? "checked" : ""}> ${esc(featName(f))}</label>`).join("")}</div></div>
    <div class="err" id="ae" role="alert"></div>
    <button class="btn" type="submit">${existing ? t("save") : t("publish")}</button>
    ${existing ? `<button type="button" class="btn ghost danger" id="adel">${t("deleteSlot")}</button>` : ""}
  </form>`);
  if (window.L) {
    const { m, mk } = smallMap($("#pmap"), lat, lng, { picker: true, zoom: existing ? 17 : 13 });
    const setPin = (ll) => { lat = ll[0]; lng = ll[1]; mk.setLatLng(ll); };
    m.on("click", (e) => setPin([e.latlng.lat, e.latlng.lng]));
    mk.on("dragend", () => { const p = mk.getLatLng(); lat = p.lat; lng = p.lng; });
    $("#myloc").onclick = () => locate((ll) => { setPin(ll); m.setView(ll, 17); });
  }
  $("#a24").onchange = () => ($("#hrs").hidden = $("#a24").checked);
  $$("[name=pm]").forEach((r) => (r.onchange = () => {
    const flat = $("#pm-flat").checked;
    $("#apl").textContent = flat ? t("priceFlat") : t("priceHour");
  }));
  if (existing) $("#adel").onclick = () => confirmBox(t("deleteConfirm"), t("yesDelete"), async () => { await deleteDoc(doc(db, "slots", existing.id)); });
  $("#af").onsubmit = async (e) => {
    e.preventDefault();
    const title = $("#at").value.trim(), price = parseInt($("#ap").value.replace(/\D/g, ""), 10);
    const maxH = parseInt($("#ax").value.replace(/\D/g, ""), 10), landmark = $("#al").value.trim();
    if (title.length < 4) return ($("#ae").textContent = t("errTitle"));
    if (!price || price < 250) return ($("#ae").textContent = t("errPrice"));
    if (!maxH || maxH < 1 || maxH > 24) return ($("#ae").textContent = t("errMax"));
    if (landmark.length < 4) return ($("#ae").textContent = t("errLandmark"));
    const area = $("#aa").value;
    const data = {
      title, area, landmark, lat, lng, mode: $("#pm-flat").checked ? "flat" : "hour", price, maxH,
      allDay: $("#a24").checked, opens: $("#ao").value || "00:00", closes: $("#ac").value || "00:00",
      feat: $$(".checks input:checked").map((i) => i.value),
      hostName: st.profile.name, hostPhone: st.profile.phonePretty, updatedAt: serverTimestamp(),
    };
    try {
      if (existing) {
        await updateDoc(doc(db, "slots", existing.id), data);
        toast(t("saved"), "ok");
      } else {
        const code = (AREAS[area].en[0] || "X").toUpperCase() + "-" + (10 + Math.floor(Math.random() * 89));
        await addDoc(collection(db, "slots"), { ...data, code, hostUid: st.user.uid, active: true, status: "active", createdAt: serverTimestamp() });
        toast(t("live", { c: code }), "ok");
      }
      closeSheet();
    } catch (err) { $("#ae").textContent = errText(err); }
  };
}

/* ================= chats ================= */
function chatName(c) {
  const other = c.members.find((u) => u !== st.user.uid);
  return c.names?.[other] || "Jêga";
}
function viewChats() {
  return `<h2>${t("chats")}</h2>
  ${st.chats.length ? st.chats.map((c) => {
    const u = c.unread?.[st.user.uid] || 0;
    return `<button class="thread" data-chat="${c.id}"><div class="avatar">${initials(chatName(c))}</div>
      <div class="grow"><h3>${esc(chatName(c))} <span class="hint mono">${LTR(c.slotCode || "")}</span></h3><p class="${u ? "strong" : ""}">${esc(c.lastText || "")}</p></div>
      <div class="thread-end"><time class="mono">${stamp(tsMs(c.lastAt))}</time>${u ? `<span class="dot static">${u}</span>` : ""}</div></button>`;
  }).join("") : `<div class="empty">${t("noChats")}</div>`}`;
}
async function openChatForSlot(s) {
  const id = `${s.id}_${st.user.uid}`;
  const ref = doc(db, "chats", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      members: [st.user.uid, s.hostUid], slotId: s.id, slotCode: s.code,
      names: { [st.user.uid]: st.profile.name, [s.hostUid]: s.hostName }, lastAt: serverTimestamp(), unread: {},
    });
  }
  st.chat = id; render();
}
let chatUnsub = null, chatMsgs = [], chatFor = null;
function renderChat() {
  const c = st.chats.find((x) => x.id === st.chat);
  if (chatFor !== st.chat) {
    chatUnsub?.(); chatMsgs = []; chatFor = st.chat;
    chatUnsub = onSnapshot(query(collection(db, "chats", st.chat, "messages"), orderBy("at", "asc"), limit(300)),
      (s) => { chatMsgs = s.docs.map((d) => ({ id: d.id, ...d.data() })); renderChat(); });
  }
  if (c && (c.unread?.[st.user.uid] || 0) > 0) updateDoc(doc(db, "chats", c.id), { [`unread.${st.user.uid}`]: 0 }).catch(() => {});
  const draft = $("#ci")?.value || "", focused = document.activeElement?.id === "ci";
  const atBottom = innerHeight + scrollY >= document.body.scrollHeight - 80;
  $("#app").innerHTML = `
    <header class="top pad bordered">
      <button class="back" id="cb">${ICON.back}${t("back")}</button>
      <div class="end"><b>${esc(c ? chatName(c) : "")}</b><div class="hint mono">${LTR(c?.slotCode || "")}</div></div>
    </header>
    <div class="msgs pad">${chatMsgs.map((m) => `<div class="msg ${m.from === "system" ? "sys" : m.from === st.user.uid ? "me" : "them"}" dir="auto">${esc(m.text)}<time>${stamp(tsMs(m.at))}</time></div>`).join("")}</div>
    <div class="composer"><form id="cf" class="pad"><input id="ci" class="input" placeholder="${t("write")}" autocomplete="off" aria-label="${t("write")}" dir="auto" maxlength="1000"><button class="send" aria-label="${t("send")}">${ICON.send}</button></form></div>`;
  $("#ci").value = draft; if (focused) $("#ci").focus();
  $("#cb").onclick = () => { chatUnsub?.(); chatUnsub = null; chatFor = null; st.chat = null; st.tab = "chats"; render(); };
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("#ci").value.trim(); if (!text) return;
    $("#ci").value = "";
    await addDoc(collection(db, "chats", st.chat, "messages"), { from: st.user.uid, text, at: serverTimestamp() });
  };
  if (atBottom || focused) scrollTo(0, document.body.scrollHeight);
}

/* ================= account ================= */
function viewMe() {
  const isIos = isIosDevice();
  const standalone = isStandalone();
  const pushOn = st.profile.notifyPush !== false && "Notification" in window && Notification.permission === "granted" && LS.get("jega.fcm", "");
  const denied = "Notification" in window && Notification.permission === "denied";
  return `<div class="card profile"><div class="avatar lg">${initials(st.profile.name)}</div>
      <div class="grow"><input id="pn" class="input bare-input" value="${esc(st.profile.name)}" aria-label="${t("name")}" maxlength="40"><div class="mono hint">${LTR(st.profile.phonePretty)}</div></div></div>
    <div class="card setting"><div class="grow"><b>${t("pushOn")}</b><p class="hint">${denied ? t("pushBlocked") : isIos && !standalone ? t("pushIos") : t("pushSub")}</p></div>
      <label class="sw"><input type="checkbox" id="push" ${pushOn ? "checked" : ""} ${denied || (isIos && !standalone) ? "disabled" : ""}><span></span></label></div>
    ${!standalone ? `<button class="card setting tap" id="inst"><div class="grow"><b>${t("install")}</b><p class="hint">${!st.installEvt && isIos ? t("installIos") : t("installSub")}</p></div>${ICON.install}</button>` : ""}
    <span class="label">${t("language")}</span>${langGrid()}
    <span class="label mt">${t("myBookings")}</span>
    <div class="card list-card">${st.myBookings.length ? st.myBookings.map(bookingRow).join("") : `<p class="hint">${t("noBookings")}</p>`}</div>
    <button class="btn dark mt" id="out">${t("signOut")}</button>`;
}

/* ================= notifications ================= */
function openNotifs() {
  const draw = () => sheet(`<div class="stack">
    <div class="row-between"><h2>${t("notifs")}</h2>${st.notifs.some((n) => !n.read) ? `<button class="linkbtn" id="nall">${t("markAllRead")}</button>` : ""}</div>
    ${st.notifs.length ? `<div class="notifs">${st.notifs.map((n) => `<button class="notif ${n.read ? "" : "unread"}" data-n="${n.id}">
      <span class="grow"><b>${esc(n.title)}</b><small>${esc(n.body)}</small></span><time class="mono">${stamp(tsMs(n.at))}</time></button>`).join("")}</div>`
      : `<div class="empty">${t("noNotifs")}</div>`}</div>`);
  draw();
  $$("[data-n]").forEach((b) => (b.onclick = () => openNotif(st.notifs.find((n) => n.id === b.dataset.n))));
  if ($("#nall")) $("#nall").onclick = async () => {
    const batch = writeBatch(db);
    st.notifs.filter((n) => !n.read).forEach((n) => batch.update(doc(db, "users", st.user.uid, "notifications", n.id), { read: true }));
    await batch.commit(); closeSheet();
  };
}
function openNotif(n) {
  if (!n) return;
  if (!n.read) updateDoc(doc(db, "users", st.user.uid, "notifications", n.id), { read: true }).catch(() => {});
  closeSheet();
  const p = new URLSearchParams((n.link || "").split("?")[1] || "");
  if (p.get("booking")) return openBooking(p.get("booking"));
  if (p.get("chat")) { st.chat = p.get("chat"); return render(); }
  if (p.get("tab")) { st.tab = p.get("tab"); render(); }
}

/* ================= sheet + confirm ================= */
let onSheetClose = null;
function sheet(html, onClose) {
  if (onSheetClose && onSheetClose !== onClose) { const f = onSheetClose; onSheetClose = null; f(); }
  const reuse = onSheetClose && onSheetClose === onClose && $("#scrim");   // live update of the same sheet: no re-animation
  onSheetClose = onClose || null;
  const inner = `<div class="sheet-top"><div class="grab"></div><button class="iconbtn x" id="sx" aria-label="${t("close")}">✕</button></div>${html}`;
  if (reuse) {
    const sh = $(".sheet"), top = sh.scrollTop;
    sh.innerHTML = inner; sh.scrollTop = top;
  } else {
    $("#layer").innerHTML = `<div class="scrim" id="scrim"><div class="sheet pad" role="dialog" aria-modal="true">${inner}</div></div>`;
  }
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") closeSheet(); };
  $("#sx").onclick = closeSheet;
}
function closeSheet() {
  $("#layer").innerHTML = "";
  if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
}
function confirmBox(text, yes, fn) {
  sheet(`<div class="stack"><p class="lead">${esc(text)}</p><div class="row2">
    <button class="btn ghost" id="cno">${t("keep")}</button><button class="btn dark" id="cyes">${esc(yes)}</button></div></div>`);
  $("#cno").onclick = closeSheet;
  $("#cyes").onclick = async () => { $("#cyes").disabled = true; await fn(); closeSheet(); };
}

/* ================= binding ================= */
function bindCommon() {
  $$("[data-go]").forEach((b) => (b.onclick = () => { st.tab = b.dataset.go; render(); }));
  $$("[data-slot]").forEach((b) => (b.onclick = () => openSlot(b.dataset.slot)));
  $$("[data-area]").forEach((b) => (b.onclick = () => { st.area = b.dataset.area; render(); }));
  $$("[data-view]").forEach((b) => (b.onclick = () => { st.view = b.dataset.view; render(); }));
  $$("[data-chat]").forEach((b) => (b.onclick = () => { st.chat = b.dataset.chat; render(); }));
  $$("[data-booking]").forEach((b) => (b.onclick = () => {
    const bk = [...st.myBookings, ...st.hostBookings].find((x) => x.id === b.dataset.booking);
    if (bk?.status === "pending_payment" && bk.driverUid === st.user.uid) openPay(bk.id); else openBooking(b.dataset.booking);
  }));
  $$("[data-edit]").forEach((b) => (b.onclick = () => openSlotForm(st.mySlots.find((s) => s.id === b.dataset.edit))));
  $$("[data-toggle]").forEach((i) => (i.onchange = () => updateDoc(doc(db, "slots", i.dataset.toggle), { active: i.checked }).catch((e) => toast(errText(e), "bad"))));
  if (st.tab === "me") {
    bindLang();
    $("#out").onclick = async () => { await disablePush(st.user.uid).catch(() => {}); authMod.signOut(auth); };
    $("#pn").onchange = () => { const v = $("#pn").value.trim(); if (v.length >= 2) updateDoc(doc(db, "users", st.user.uid), { name: v }).then(() => toast(t("saved"), "ok")); };
    $("#push").onchange = async (e) => {
      if (e.target.checked) {
        const r = await enablePush(st.user.uid, st.swReg).catch(() => "unsupported");
        if (r !== "on") { e.target.checked = false; toast(r === "denied" ? t("pushBlocked") : t("genericErr"), "bad"); }
      } else await disablePush(st.user.uid);
    };
    if ($("#inst")) $("#inst").onclick = triggerInstall;
  }
  const q = $("#q");
  if (q) q.oninput = () => { st.q = q.value; const p = q.selectionStart; render(); const n = $("#q"); n.focus(); n.setSelectionRange(p, p); };
  if ($("#near")) $("#near").onclick = () => locate((ll) => { st.me = ll; render(); if (mainMap) mainMap.setView(ll, 15); });
  if ($("#add")) $("#add").onclick = () => openSlotForm(null);
}

render();
