// Jêga Admin — owner dashboard. Separate site, separate login (email + password),
// and only accounts with the custom claim admin == true can see anything (enforced by firestore.rules).
import "./firebase-config.js";
const V = "10.12.2", base = `https://www.gstatic.com/firebasejs/${V}`;
const { initializeApp } = await import(`${base}/firebase-app.js`);
const A = await import(`${base}/firebase-auth.js`);
const F = await import(`${base}/firebase-firestore.js`);

const VAPID_KEY = "PASTE_WEB_PUSH_KEY_PAIR"; // same key as app/js/config.js
const app = initializeApp(self.FIREBASE_CONFIG);
const auth = A.getAuth(app);
const db = F.getFirestore(app);
const { collection, doc, query, where, orderBy, limit, onSnapshot, getDocs, getDoc, setDoc, updateDoc, Timestamp, getCountFromServer, getAggregateFromServer, sum } = F;

/* ---------------- admin actions ----------------
   On the free Spark plan there are no Cloud Functions: the dashboard writes directly, as the admin.
   firestore.rules lets only accounts with the admin claim do these writes. */
const pad = (n) => String(n).padStart(2, "0");
const whenText = (b) => `${b.date} ${pad(b.start)}:00–${pad(b.start + b.hours)}:00`;
const maskOf = (start, hours) => (2 ** hours - 1) * 2 ** start;
const audit = (batch, action, data) => batch.set(doc(collection(db, "auditLog")), { adminUid: S.user.uid, action, data, at: F.serverTimestamp() });
const notifyIn = (batch, uid, type, vars, opts = {}) => batch.set(doc(collection(db, "users", uid, "notifications")), {
  type, vars, link: opts.link || "/", priority: opts.priority || "normal", read: false, at: F.serverTimestamp(), from: S.user.uid,
});
const ACTIONS = {
  /** Suspend or restore a slot. The host is notified with the reason. */
  async adminSetSlotStatus({ slotId, status, reason = "" }) {
    const ref = doc(db, "slots", slotId);
    const s = (await getDoc(ref)).data();
    if (!s) throw new Error("no-slot");
    const batch = F.writeBatch(db);
    batch.update(ref, { status, statusReason: reason, statusAt: F.serverTimestamp() });
    notifyIn(batch, s.hostUid, status === "suspended" ? "slot_suspended" : "slot_restored",
      { code: s.code, reason: reason || "Contact Jêga support for details." }, { link: "/?tab=host", priority: "high" });
    audit(batch, "slot_status", { slotId, status, reason });
    await batch.commit();
    return { ok: true };
  },
  /** Block or unblock a user. The app signs a blocked user out and the rules stop their writes; their slots are suspended. */
  async adminSetUserBlocked({ uid, blocked }) {
    const slots = await getDocs(query(collection(db, "slots"), where("hostUid", "==", uid)));
    const batch = F.writeBatch(db);
    batch.update(doc(db, "users", uid), { blocked: !!blocked, blockedAt: F.serverTimestamp() });
    slots.docs.forEach((d) => batch.update(d.ref, { status: blocked ? "suspended" : "active", statusReason: blocked ? "Account blocked" : "" }));
    audit(batch, "user_blocked", { uid, blocked: !!blocked });
    await batch.commit();
    return { ok: true };
  },
  /** Cancel any booking and free its hours. Paid bookings are flagged for refund. */
  async adminCancelBooking({ bookingId, reason = "" }) {
    const ref = doc(db, "bookings", bookingId);
    let b;
    await F.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      b = snap.data();
      if (!b) throw new Error("no-booking");
      if (!["pending_payment", "confirmed"].includes(b.status)) throw new Error("not-active");
      const dayRef = doc(db, "slotDays", `${b.slotId}_${b.date}`);
      const day = await tx.get(dayRef);
      tx.update(ref, {
        status: "cancelled", cancelledBy: "admin", cancelReason: reason, cancelledAt: F.serverTimestamp(),
        ...(b.paymentStatus === "paid" ? { refund: "needed" } : {}),
      });
      if (b.status === "confirmed" && day.exists()) {
        tx.set(dayRef, { slotId: b.slotId, date: b.date, taken: (day.data().taken || 0) - maskOf(b.start, b.hours), lastBooking: bookingId });
      }
    });
    const batch = F.writeBatch(db);
    const vars = { code: b.slotCode, when: whenText(b), reason };
    notifyIn(batch, b.driverUid, "booking_cancelled", vars, { link: `/?booking=${bookingId}`, priority: "high" });
    notifyIn(batch, b.hostUid, "booking_cancelled", vars, { link: "/?tab=host" });
    audit(batch, "booking_cancel", { bookingId, reason });
    await batch.commit();
    return { ok: true };
  },
  /** Mark a refund as done after you've returned the money. */
  async adminMarkRefunded({ bookingId, note = "" }) {
    const batch = F.writeBatch(db);
    batch.update(doc(db, "bookings", bookingId), { refund: "done", refundNote: note, refundedAt: F.serverTimestamp() });
    audit(batch, "refund", { bookingId, note });
    await batch.commit();
    return { ok: true };
  },
  /** In-app announcement to all users, only hosts, or only drivers. */
  async adminBroadcast({ title, body, audience = "all" }) {
    if (!title || !body) throw new Error("need-text");
    const slots = await getDocs(collection(db, "slots"));
    const hosts = new Set(slots.docs.map((d) => d.data().hostUid));
    let uids;
    if (audience === "hosts") uids = [...hosts];
    else {
      const u = await getDocs(query(collection(db, "users"), where("blocked", "==", false)));
      uids = u.docs.map((d) => d.id);
      if (audience === "drivers") uids = uids.filter((x) => !hosts.has(x));
    }
    for (let i = 0; i < uids.length; i += 400) {
      const batch = F.writeBatch(db);
      uids.slice(i, i + 400).forEach((u) => notifyIn(batch, u, "broadcast", { title, body }, { link: "/?tab=me" }));
      await batch.commit();
    }
    const batch = F.writeBatch(db);
    batch.set(doc(collection(db, "broadcasts")), { title, body, audience, count: uids.length, by: S.user.uid, at: F.serverTimestamp() });
    audit(batch, "broadcast", { audience, count: uids.length });
    await batch.commit();
    return { sent: uids.length };
  },
};
/** Same shape as the old httpsCallable: call("name")(data) -> { data } */
const call = (n) => async (d) => ({ data: await ACTIONS[n](d || {}) });

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString("en-US");
const iqd = (n) => `${num(n)} IQD`;
const ms = (v) => (v?.toMillis ? v.toMillis() : 0);
const dt = (v) => (ms(v) ? new Date(ms(v)).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const pad2 = (n) => String(n).padStart(2, "0");
const when = (b) => `${b.date} ${pad2(b.start)}:00–${pad2(b.start + b.hours)}:00`;
const localDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad" }).format(d);
function toast(msg, kind = "") {
  const el = document.createElement("div"); el.className = "toast " + kind; el.textContent = msg;
  $("#toasts").appendChild(el); setTimeout(() => el.remove(), 3500);
}
const pill = (s) => `<span class="pill p-${esc(s)}">${esc(String(s).replace(/_/g, " "))}</span>`;

/* ---------------- state ---------------- */
const S = { user: null, tab: (location.hash || "#overview").slice(1), alerts: [], reports: [], unsubs: [], filters: {} };

/* ---------------- PWA: service worker + install ---------------- */
let swReg = null, installEvt = null;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then((r) => (swReg = r)).catch(() => {});
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; drawInstall(); });
window.addEventListener("appinstalled", () => { installEvt = null; drawInstall(); });
function drawInstall() {
  const b = $("#inst"); if (!b) return;
  b.hidden = !installEvt;
  b.onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; drawInstall(); };
}
const TABS = [
  ["overview", "Overview"], ["alerts", "Alerts"], ["bookings", "Bookings"], ["slots", "Slots"],
  ["users", "Users"], ["payments", "Payments"], ["broadcast", "Broadcast"], ["settings", "Settings"],
];
window.addEventListener("hashchange", () => { S.tab = location.hash.slice(1) || "overview"; shell(); });

/* ---------------- auth ---------------- */
A.onAuthStateChanged(auth, async (u) => {
  S.unsubs.forEach((f) => f()); S.unsubs = [];
  if (!u) { S.user = null; return login(); }
  const tok = await u.getIdTokenResult(true);
  if (tok.claims.admin !== true) {
    await A.signOut(auth);
    return login("This account is not an admin. Ask the owner to run make-admin for it.");
  }
  S.user = u;
  watchAlerts();
  shell();
});

function login(msg = "") {
  $("#root").innerHTML = `
  <div class="login">
    <form id="lf" class="login-card">
      <div class="brand"><span class="mark">J</span><div><b>Jêga Admin</b><small>Owner access only</small></div></div>
      <label>Email<input id="em" type="email" autocomplete="username" required></label>
      <label>Password<input id="pw" type="password" autocomplete="current-password" required></label>
      <div class="err" role="alert">${esc(msg)}</div>
      <button class="btn">Sign in</button>
      <p class="muted small">Driver and host phone accounts cannot sign in here.</p>
    </form>
  </div>`;
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    try { await A.signInWithEmailAndPassword(auth, $("#em").value.trim(), $("#pw").value); }
    catch { $(".err").textContent = "Wrong email or password."; }
  };
}

/* ---------------- live alerts ---------------- */
function watchAlerts() {
  let first = true;
  S.unsubs.push(onSnapshot(query(collection(db, "alerts"), orderBy("at", "desc"), limit(100)), (s) => {
    s.docChanges().forEach((c) => {
      if (first || c.type !== "added") return;
      const a = c.doc.data();
      toast(`${label(a.type)}: ${a.data?.summary || ""}`, a.severity === "critical" ? "bad" : "");
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Jêga Admin · ${label(a.type)}`, { body: a.data?.summary || "", icon: "/favicon.png" });
      }
    });
    first = false;
    S.alerts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    const open = S.alerts.filter((a) => !a.resolved).length;
    document.title = open ? `(${open}) Jêga Admin` : "Jêga Admin";
    const badge = $("#alertBadge"); if (badge) { badge.textContent = open; badge.hidden = !open; }
    if (S.tab === "alerts") view();
  }));
  S.unsubs.push(onSnapshot(query(collection(db, "reports"), orderBy("at", "desc"), limit(100)), (s) => {
    S.reports = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (S.tab === "alerts") view();
  }));
}
const label = (t) => ({ payment_failed: "Payment problem", new_slot: "New slot", report: "Report", webhook_error: "Webhook error", user_blocked_login: "Blocked user sign-in" }[t] || t);

/* ---------------- shell ---------------- */
function shell() {
  if (!TABS.some(([k]) => k === S.tab)) S.tab = "overview";
  const open = S.alerts.filter((a) => !a.resolved).length;
  $("#root").innerHTML = `
  <div class="layout">
    <aside class="side">
      <div class="brand"><span class="mark">J</span><div><b>Jêga Admin</b><small>${esc(S.user.email)}</small></div></div>
      <nav>${TABS.map(([k, l]) => `<a href="#${k}" class="${S.tab === k ? "on" : ""}">${l}${k === "alerts" ? `<span class="badge" id="alertBadge" ${open ? "" : "hidden"}>${open}</span>` : ""}</a>`).join("")}</nav>
      <button class="btn sm install" id="inst" hidden>Install app</button>
      <button class="linkbtn" id="out">Sign out</button>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $("#out").onclick = () => A.signOut(auth);
  drawInstall();
  view();
}
function view() {
  const m = $("#main"); if (!m) return;
  ({ overview, alerts, bookings, slots, users, payments, broadcast, settings })[S.tab](m);
}

/* ---------------- overview ---------------- */
let ovMap = null;
async function overview(m) {
  m.innerHTML = `<header class="head"><h1>Overview</h1><span class="muted">${localDay()} · Erbil time</span></header>
    <section class="kpis" id="kpis">${["Users", "Active slots", "Bookings today", "Revenue this month", "Jêga fees this month", "Refunds to do"].map((l) => `<div class="kpi"><span>${l}</span><b>…</b></div>`).join("")}</section>
    <section class="grid2">
      <div class="panel"><h2>Bookings, last 14 days</h2><div id="chart" class="chart"></div></div>
      <div class="panel"><h2>Open alerts</h2><div id="ovAlerts"></div><a href="#alerts" class="linkbtn">All alerts</a></div>
    </section>
    <section class="panel"><h2>All slots</h2><div id="ovmap" class="map"></div>
      <div class="legend"><span><i class="lg active"></i>Active</span><span><i class="lg hidden"></i>Hidden by host</span><span><i class="lg suspended"></i>Suspended</span></div></section>`;

  const openA = S.alerts.filter((a) => !a.resolved).slice(0, 6);
  $("#ovAlerts").innerHTML = openA.length ? openA.map(alertRow).join("") : `<p class="muted">Nothing needs attention.</p>`;

  const monthStart = Timestamp.fromDate(new Date(`${localDay().slice(0, 7)}-01T00:00:00+03:00`));
  const B = collection(db, "bookings");
  const paidStatuses = ["confirmed", "completed"];
  const [users, activeSlots, today, rev, refunds] = await Promise.all([
    getCountFromServer(collection(db, "users")),
    getCountFromServer(query(collection(db, "slots"), where("status", "==", "active"), where("active", "==", true))),
    getCountFromServer(query(B, where("date", "==", localDay()), where("status", "in", ["pending_payment", ...paidStatuses]))),
    getAggregateFromServer(query(B, where("status", "in", paidStatuses), where("createdAt", ">=", monthStart)), { total: sum("total"), fee: sum("platformFee") }),
    getCountFromServer(query(B, where("refund", "==", "needed"))),
  ]).catch((e) => { console.error(e); return []; });
  if (users) {
    const vals = [num(users.data().count), num(activeSlots.data().count), num(today.data().count), iqd(rev.data().total), iqd(rev.data().fee), num(refunds.data().count)];
    $$("#kpis .kpi b").forEach((b, i) => (b.textContent = vals[i]));
    if (refunds.data().count) $$("#kpis .kpi")[5].classList.add("warn");
  }

  // 14-day chart
  const since = new Date(Date.now() - 13 * 86400e3);
  const snap = await getDocs(query(B, where("createdAt", ">=", Timestamp.fromDate(new Date(`${localDay(since)}T00:00:00+03:00`)))));
  const days = [...Array(14)].map((_, i) => localDay(new Date(since.getTime() + i * 86400e3)));
  const counts = Object.fromEntries(days.map((d) => [d, { ok: 0, other: 0 }]));
  snap.docs.forEach((d) => {
    const b = d.data(), k = localDay(new Date(ms(b.createdAt)));
    if (counts[k]) counts[k][paidStatuses.includes(b.status) ? "ok" : "other"]++;
  });
  drawChart($("#chart"), days, counts);

  // map of every slot (admins can read all)
  const slotsSnap = await getDocs(collection(db, "slots"));
  if (!window.L) return;
  if (ovMap) { ovMap.remove(); ovMap = null; }
  ovMap = L.map("ovmap").setView([36.1911, 44.0092], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(ovMap);
  const pts = [];
  slotsSnap.docs.forEach((d) => {
    const s = d.data(); if (typeof s.lat !== "number") return;
    const cls = s.status === "suspended" ? "suspended" : s.active ? "active" : "hidden";
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="mpin ${cls}">${esc(s.code)}</div>`, iconSize: null }) })
      .bindPopup(`<b>${esc(s.code)} · ${esc(s.title)}</b><br>${esc(s.hostName)} · ${esc(s.hostPhone)}<br>${num(s.price)} IQD ${s.mode === "flat" ? "flat" : "/ hr"}`)
      .addTo(ovMap);
    pts.push([s.lat, s.lng]);
  });
  if (pts.length) ovMap.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
}
function drawChart(el, days, counts) {
  const max = Math.max(1, ...days.map((d) => counts[d].ok + counts[d].other));
  const W = 560, H = 180, P = 26, bw = (W - P * 2) / days.length;
  const y = (v) => H - P - (v / max) * (H - P * 2);
  const ticks = [0, Math.ceil(max / 2), max];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bookings per day">
    ${ticks.map((v) => `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join("")}
    ${days.map((d, i) => {
      const c = counts[d], x = P + i * bw + 3, w = bw - 6;
      return `<rect x="${x}" y="${y(c.ok)}" width="${w}" height="${H - P - y(c.ok)}" class="bar"><title>${d}: ${c.ok} confirmed</title></rect>
        <rect x="${x}" y="${y(c.ok + c.other)}" width="${w}" height="${y(c.ok) - y(c.ok + c.other)}" class="bar2"><title>${d}: ${c.other} unpaid/cancelled</title></rect>
        ${i % 2 === 0 ? `<text x="${x + w / 2}" y="${H - 8}" class="ax" text-anchor="middle">${d.slice(8)}</text>` : ""}`;
    }).join("")}
  </svg><div class="legend"><span><i class="lg active"></i>Confirmed or completed</span><span><i class="lg muted"></i>Unpaid, cancelled or expired</span></div>`;
}

/* ---------------- alerts + reports ---------------- */
function alertRow(a) {
  return `<div class="alert sev-${a.severity} ${a.resolved ? "done" : ""}">
    <div class="grow"><b>${label(a.type)}</b><p>${esc(a.data?.summary || "")}</p><small class="muted">${dt(a.at)}${a.data?.bookingId ? ` · booking ${esc(a.data.bookingId)}` : ""}</small></div>
    ${a.resolved ? `<span class="muted small">Resolved</span>` : `<button class="btn sm ghost" data-resolve="${a.id}">Resolve</button>`}</div>`;
}
function alerts(m) {
  const openR = S.reports.filter((r) => !r.resolved);
  m.innerHTML = `<header class="head"><h1>Alerts</h1><button class="btn sm" id="pushBtn">Turn on desktop alerts</button></header>
    <section class="panel"><h2>System alerts</h2>${S.alerts.length ? S.alerts.map(alertRow).join("") : `<p class="muted">No alerts yet.</p>`}</section>
    <section class="panel"><h2>User reports (${openR.length} open)</h2>
    ${S.reports.length ? `<table><thead><tr><th>When</th><th>About</th><th>Reason</th><th>From</th><th></th></tr></thead><tbody>
      ${S.reports.map((r) => `<tr class="${r.resolved ? "done" : ""}"><td>${dt(r.at)}</td><td>${esc(r.targetLabel || r.targetId)}</td><td>${esc(r.reason)}</td><td class="mono">${esc(r.by)}</td>
      <td>${r.resolved ? "Resolved" : `<button class="btn sm ghost" data-rres="${r.id}">Resolve</button>`}${r.targetType === "slot" ? ` <a class="linkbtn" href="#slots" data-find="${esc(r.targetId)}">Open slot</a>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<p class="muted">No reports.</p>`}</section>`;
  $$("[data-resolve]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "alerts", b.dataset.resolve), { resolved: true, resolvedBy: S.user.uid })));
  $$("[data-rres]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "reports", b.dataset.rres), { resolved: true, resolvedBy: S.user.uid })));
  $$("[data-find]").forEach((a) => (a.onclick = () => (S.filters.slotQ = a.dataset.find)));
  $("#pushBtn").onclick = enableAdminPush;
}
async function enableAdminPush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Notifications are blocked in this browser.", "bad");
    const reg = swReg || (await navigator.serviceWorker.register("/sw.js"));
    const msg = await import(`${base}/firebase-messaging.js`);
    const token = await msg.getToken(msg.getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    await setDoc(doc(db, "admins", S.user.uid), { email: S.user.email, notifyPush: true, fcmTokens: F.arrayUnion(token) }, { merge: true });
    toast("Desktop alerts are on for this browser.", "ok");
  } catch (e) { console.error(e); toast("Couldn't turn on alerts: " + e.message, "bad"); }
}

/* ---------------- bookings ---------------- */
async function bookings(m) {
  const f = S.filters.bStatus || "all";
  m.innerHTML = `<header class="head"><h1>Bookings</h1>
    <div class="filters"><select id="bs">${["all", "pending_payment", "confirmed", "completed", "cancelled", "expired", "refund"].map((s) => `<option value="${s}" ${f === s ? "selected" : ""}>${s === "refund" ? "refund needed" : s.replace("_", " ")}</option>`).join("")}</select>
    <input id="bq" type="search" placeholder="Code, name or phone" value="${esc(S.filters.bQ || "")}"></div></header>
    <section class="panel"><div class="tablewrap" id="bt">Loading…</div></section>`;
  $("#bs").onchange = () => { S.filters.bStatus = $("#bs").value; bookings(m); };
  $("#bq").oninput = () => { S.filters.bQ = $("#bq").value; draw(); };
  let q = query(collection(db, "bookings"), orderBy("createdAt", "desc"), limit(300));
  if (f === "refund") q = query(collection(db, "bookings"), where("refund", "==", "needed"), limit(300));
  else if (f !== "all") q = query(collection(db, "bookings"), where("status", "==", f), orderBy("createdAt", "desc"), limit(300));
  const rows = (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  function draw() {
    const s = (S.filters.bQ || "").toLowerCase();
    const list = rows.filter((b) => !s || [b.slotCode, b.driverName, b.driverPhone, b.hostName, b.hostPhone, b.id].join(" ").toLowerCase().includes(s));
    $("#bt").innerHTML = list.length ? `<table><thead><tr><th>Created</th><th>Slot</th><th>When</th><th>Driver</th><th>Host</th><th>Pay</th><th class="r">Total</th><th class="r">Fee</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((b) => `<tr><td>${dt(b.createdAt)}</td><td class="mono">${esc(b.slotCode)}</td><td class="mono">${esc(when(b))}</td>
        <td>${esc(b.driverName)}<br><small class="mono muted">${esc(b.driverPhone)}</small></td><td>${esc(b.hostName)}<br><small class="mono muted">${esc(b.hostPhone)}</small></td>
        <td>${b.payMethod === "cash" ? "Cash" : "Online"}${b.paymentStatus === "paid" ? " ✓" : ""}</td><td class="r mono">${num(b.total)}</td><td class="r mono">${num(b.platformFee)}</td>
        <td>${pill(b.status)}${b.refund === "needed" ? pill("refund_needed") : b.refund === "done" ? pill("refunded") : ""}</td>
        <td class="actions">${["pending_payment", "confirmed"].includes(b.status) ? `<button class="btn sm ghost" data-bc="${b.id}">Cancel</button>` : ""}
          ${b.refund === "needed" ? `<button class="btn sm" data-rf="${b.id}">Mark refunded</button>` : ""}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">No bookings match.</p>`;
    $$("[data-bc]").forEach((btn) => (btn.onclick = () => ask("Cancel booking", "Reason shown to the driver and host", async (reason) => {
      await call("adminCancelBooking")({ bookingId: btn.dataset.bc, reason }); toast("Booking cancelled. Both sides were notified.", "ok"); bookings(m);
    })));
    $$("[data-rf]").forEach((btn) => (btn.onclick = () => ask("Mark refunded", "Note (e.g. FIB transfer reference)", async (note) => {
      await call("adminMarkRefunded")({ bookingId: btn.dataset.rf, note }); toast("Refund recorded.", "ok"); bookings(m);
    })));
  }
  draw();
}

/* ---------------- slots ---------------- */
async function slots(m) {
  m.innerHTML = `<header class="head"><h1>Slots</h1><div class="filters"><input id="sq" type="search" placeholder="Code, title, area, host" value="${esc(S.filters.slotQ || "")}"></div></header>
    <section class="panel"><div class="tablewrap" id="st">Loading…</div></section>`;
  const rows = (await getDocs(query(collection(db, "slots"), limit(1000)))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const draw = () => {
    const s = (S.filters.slotQ || "").toLowerCase();
    const list = rows.filter((x) => !s || [x.id, x.code, x.title, x.area, x.hostName, x.hostPhone].join(" ").toLowerCase().includes(s));
    $("#st").innerHTML = list.length ? `<table><thead><tr><th>Code</th><th>Title</th><th>Area</th><th>Host</th><th class="r">Price</th><th>Pricing</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((x) => `<tr><td class="mono">${esc(x.code)}</td><td>${esc(x.title)}<br><small class="muted">${esc(x.landmark)}</small></td><td>${esc(x.area)}</td>
        <td>${esc(x.hostName)}<br><small class="mono muted">${esc(x.hostPhone)}</small></td><td class="r mono">${num(x.price)}</td><td>${x.mode === "flat" ? `Flat, up to ${x.maxH} h` : "Per hour"}</td>
        <td class="mono">${x.allDay ? "24/7" : `${esc(x.opens)}–${esc(x.closes)}`}</td>
        <td>${pill(x.status === "suspended" ? "suspended" : x.active ? "active" : "hidden")}${x.statusReason ? `<br><small class="muted">${esc(x.statusReason)}</small>` : ""}</td>
        <td class="actions"><a class="linkbtn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lng}#map=18/${x.lat}/${x.lng}">Map</a>
          ${x.status === "suspended" ? `<button class="btn sm" data-restore="${x.id}">Restore</button>` : `<button class="btn sm ghost" data-susp="${x.id}">Suspend</button>`}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">No slots match.</p>`;
    $$("[data-susp]").forEach((b) => (b.onclick = () => ask("Suspend slot", "Reason the host will see", async (reason) => {
      await call("adminSetSlotStatus")({ slotId: b.dataset.susp, status: "suspended", reason }); toast("Slot suspended. Host notified.", "ok"); slots(m);
    })));
    $$("[data-restore]").forEach((b) => (b.onclick = async () => {
      await call("adminSetSlotStatus")({ slotId: b.dataset.restore, status: "active" }); toast("Slot restored. Host notified.", "ok"); slots(m);
    }));
  };
  $("#sq").oninput = () => { S.filters.slotQ = $("#sq").value; draw(); };
  draw();
}

/* ---------------- users ---------------- */
async function users(m) {
  m.innerHTML = `<header class="head"><h1>Users</h1><div class="filters"><input id="uq" type="search" placeholder="Name or phone" value="${esc(S.filters.uQ || "")}"></div></header>
    <section class="panel"><div class="tablewrap" id="ut">Loading…</div></section>`;
  const [us, ss] = await Promise.all([getDocs(query(collection(db, "users"), orderBy("createdAt", "desc"), limit(1000))), getDocs(collection(db, "slots"))]);
  const slotCount = {}; ss.docs.forEach((d) => { const h = d.data().hostUid; slotCount[h] = (slotCount[h] || 0) + 1; });
  const rows = us.docs.map((d) => ({ id: d.id, ...d.data() }));
  const draw = () => {
    const s = (S.filters.uQ || "").toLowerCase();
    const list = rows.filter((u) => !s || [u.name, u.phonePretty, u.phone].join(" ").toLowerCase().includes(s));
    $("#ut").innerHTML = `<table><thead><tr><th>Name</th><th>Phone</th><th>Language</th><th class="r">Slots</th><th>Joined</th><th>Last sign-in</th><th>Push</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((u) => `<tr><td>${esc(u.name)}</td><td class="mono">${esc(u.phonePretty)}</td><td>${esc({ en: "English", ar: "Arabic", ckb: "Sorani", kmr: "Badini" }[u.lang] || u.lang)}</td>
        <td class="r mono">${slotCount[u.id] || 0}</td><td>${dt(u.createdAt)}</td><td>${dt(u.lastLoginAt)}</td><td>${(u.fcmTokens || []).length ? "On" : "Off"}</td>
        <td>${pill(u.blocked ? "blocked" : "active")}</td>
        <td class="actions">${u.blocked ? `<button class="btn sm" data-unblock="${u.id}">Unblock</button>` : `<button class="btn sm ghost" data-block="${u.id}">Block</button>`}</td></tr>`).join("")}
      </tbody></table>`;
    $$("[data-block]").forEach((b) => (b.onclick = () => confirmBox("Block this user? They are signed out now, can't sign in again, and their slots are suspended.", "Block", async () => {
      await call("adminSetUserBlocked")({ uid: b.dataset.block, blocked: true }); toast("User blocked.", "ok"); users(m);
    })));
    $$("[data-unblock]").forEach((b) => (b.onclick = async () => {
      await call("adminSetUserBlocked")({ uid: b.dataset.unblock, blocked: false }); toast("User unblocked.", "ok"); users(m);
    }));
  };
  $("#uq").oninput = () => { S.filters.uQ = $("#uq").value; draw(); };
  draw();
}

/* ---------------- payments ---------------- */
async function payments(m) {
  m.innerHTML = `<header class="head"><h1>Payments</h1><span class="muted">Online payments through FuratPay</span></header>
    <section class="panel"><div class="tablewrap" id="pt">Loading…</div></section>`;
  const rows = (await getDocs(query(collection(db, "payments"), orderBy("createdAt", "desc"), limit(300)))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const paid = rows.filter((p) => p.status === "paid").reduce((a, p) => a + p.amount, 0);
  $("#pt").innerHTML = rows.length ? `<p class="muted">${rows.length} payments shown · ${iqd(paid)} paid${rows.some((p) => p.testMode) ? ` · <b>includes TEST MODE payments</b>` : ""}</p>
    <table><thead><tr><th>Created</th><th>Booking</th><th>Invoice</th><th>Service</th><th class="r">Amount</th><th>Status</th><th>Paid at</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td>${dt(p.createdAt)}</td><td class="mono">${esc(p.bookingId)}</td><td class="mono">${esc(p.invoiceId)}${p.testMode ? " (test)" : ""}</td>
      <td>${esc(p.serviceId || "—")}</td><td class="r mono">${num(p.amount)}</td><td>${pill(p.status)}</td><td>${dt(p.paidAt)}</td></tr>`).join("")}
    </tbody></table>` : `<p class="muted">No online payments yet.</p>`;
}

/* ---------------- broadcast ---------------- */
async function broadcast(m) {
  m.innerHTML = `<header class="head"><h1>Broadcast</h1><span class="muted">Sends an in-app notification to each user</span></header>
    <section class="grid2">
      <form class="panel form" id="bf">
        <label>Audience<select id="ba"><option value="all">Everyone</option><option value="hosts">Hosts only</option><option value="drivers">Drivers only</option></select></label>
        <label>Title<input id="bti" maxlength="60" required placeholder="e.g. New area: Italian Village"></label>
        <label>Message<textarea id="bbo" rows="4" maxlength="240" required placeholder="Write it in the language your users read. You can send one per language."></textarea></label>
        <button class="btn">Send</button>
      </form>
      <div class="panel"><h2>Sent</h2><div id="bh">Loading…</div></div>
    </section>`;
  $("#bf").onsubmit = (e) => {
    e.preventDefault();
    confirmBox(`Send "${$("#bti").value}" to ${$("#ba").selectedOptions[0].text.toLowerCase()}?`, "Send", async () => {
      const r = await call("adminBroadcast")({ title: $("#bti").value.trim(), body: $("#bbo").value.trim(), audience: $("#ba").value });
      toast(`Sent to ${r.data.sent} people.`, "ok"); broadcast(m);
    });
  };
  const h = await getDocs(query(collection(db, "broadcasts"), orderBy("at", "desc"), limit(30)));
  $("#bh").innerHTML = h.empty ? `<p class="muted">Nothing sent yet.</p>` : h.docs.map((d) => { const b = d.data(); return `<div class="alert"><div class="grow"><b>${esc(b.title)}</b><p>${esc(b.body)}</p><small class="muted">${dt(b.at)} · ${esc(b.audience)} · ${num(b.count)} people</small></div></div>`; }).join("");
}

/* ---------------- settings ---------------- */
async function settings(m) {
  const c = (await getDoc(doc(db, "config", "app"))).data() || {};
  const ann = typeof c.announcement === "object" && c.announcement ? c.announcement : { en: c.announcement || "" };
  const pid = self.FIREBASE_CONFIG.projectId;
  m.innerHTML = `<header class="head"><h1>Settings</h1></header>
  <section class="grid2">
    <form class="panel form" id="sf">
      <h2>Business rules</h2>
      <label>Jêga fee (% of each booking)<input id="cp" type="number" min="0" max="50" step="0.5" value="${c.commissionPct ?? 10}"></label>
      <label>Minutes to finish online payment before the slot is released<input id="pm" type="number" min="5" max="60" value="${c.pendingPaymentMinutes ?? 15}"></label>
      <label class="check"><input id="op" type="checkbox" ${c.onlinePayments !== false ? "checked" : ""}> Allow online payments (FuratPay)</label>
      <h2>Announcement banner</h2><p class="muted small">Shown at the top of the app. Leave empty to hide.</p>
      <label>English<input id="a-en" value="${esc(ann.en || "")}"></label>
      <label>Arabic<input id="a-ar" dir="rtl" value="${esc(ann.ar || "")}"></label>
      <label>Kurdish Sorani<input id="a-ckb" dir="rtl" value="${esc(ann.ckb || "")}"></label>
      <label>Kurdish Badini<input id="a-kmr" dir="rtl" value="${esc(ann.kmr || "")}"></label>
      <button class="btn">Save settings</button>
    </form>
    <div class="panel">
      <h2>FuratPay setup</h2>
      <p>Webhook URL to paste in your FuratPay dashboard:</p>
      <div class="copy"><code id="wh">https://${REGION}-${esc(pid)}.cloudfunctions.net/furatpayWebhook</code><button class="btn sm ghost" id="cpy">Copy</button></div>
      <p class="muted small">Until you set the FURATPAY_API_KEY secret, payments run in test mode with a built-in test checkout. See README → FuratPay.</p>
      <h2>Recent admin actions</h2><div id="audit">Loading…</div>
    </div>
  </section>`;
  $("#cpy").onclick = () => navigator.clipboard.writeText($("#wh").textContent).then(() => toast("Copied", "ok"));
  $("#sf").onsubmit = async (e) => {
    e.preventDefault();
    const announcement = Object.fromEntries(["en", "ar", "ckb", "kmr"].map((l) => [l, $("#a-" + l).value.trim()]));
    const any = Object.values(announcement).some(Boolean);
    await setDoc(doc(db, "config", "app"), {
      commissionPct: Number($("#cp").value), pendingPaymentMinutes: Number($("#pm").value), onlinePayments: $("#op").checked,
      announcement: any ? announcement : null,
    }, { merge: true });
    toast("Settings saved. The app updates right away.", "ok");
  };
  const au = await getDocs(query(collection(db, "auditLog"), orderBy("at", "desc"), limit(25)));
  $("#audit").innerHTML = au.empty ? `<p class="muted">No actions yet.</p>` :
    `<table><tbody>${au.docs.map((d) => { const a = d.data(); return `<tr><td>${dt(a.at)}</td><td>${esc(a.action.replace(/_/g, " "))}</td><td class="mono small">${esc(JSON.stringify(a.data))}</td></tr>`; }).join("")}</tbody></table>`;
}

/* ---------------- modals ---------------- */
function ask(title, placeholder, fn) {
  $("#modal").innerHTML = `<div class="scrim"><form class="dialog" id="af"><h2>${esc(title)}</h2>
    <textarea id="ai" rows="3" placeholder="${esc(placeholder)}"></textarea>
    <div class="row"><button type="button" class="btn ghost" id="ac">Back</button><button class="btn">${esc(title)}</button></div></form></div>`;
  $("#ac").onclick = () => ($("#modal").innerHTML = "");
  $("#af").onsubmit = async (e) => {
    e.preventDefault(); e.submitter && (e.submitter.disabled = true);
    try { await fn($("#ai").value.trim()); } catch (err) { toast(err.message, "bad"); }
    $("#modal").innerHTML = "";
  };
}
function confirmBox(text, yes, fn) {
  $("#modal").innerHTML = `<div class="scrim"><div class="dialog"><p>${esc(text)}</p>
    <div class="row"><button class="btn ghost" id="cn">Back</button><button class="btn" id="cy">${esc(yes)}</button></div></div></div>`;
  $("#cn").onclick = () => ($("#modal").innerHTML = "");
  $("#cy").onclick = async () => { $("#cy").disabled = true; try { await fn(); } catch (err) { toast(err.message, "bad"); } $("#modal").innerHTML = ""; };
}
