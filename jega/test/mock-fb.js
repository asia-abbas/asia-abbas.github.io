// In-memory stand-in for app/js/fb.js, used only by test/ui.test.py to exercise the UI without Firebase.
const store = new Map(); // path -> data
const subs = new Set();
let uidSeq = 0;
const now = () => ({ toMillis: () => Date.now(), seconds: Date.now() / 1000 });
const serverTimestamp = () => now();
const notify = () => subs.forEach((s) => s.run());

function ref(path) { return { path, id: path.split("/").pop() }; }
export const fs = {
  collection: (_db, ...p) => ({ type: "col", path: p.join("/") }),
  doc: (_db, ...p) => ({ type: "doc", ...ref(p.join("/")) }),
  query: (col, ...cons) => ({ type: "q", path: col.path, cons }),
  where: (f, op, v) => ({ k: "where", f, op, v }),
  orderBy: (f, d = "asc") => ({ k: "order", f, d }),
  limit: (n) => ({ k: "limit", n }),
  serverTimestamp,
  arrayUnion: (...v) => ({ __union: v }),
  arrayRemove: (...v) => ({ __remove: v }),
  async getDoc(r) { const d = store.get(r.path); return { exists: () => !!d, data: () => d, id: r.id, ref: r }; },
  async setDoc(r, data) { store.set(r.path, { ...data }); notify(); },
  async addDoc(col, data) { const id = "id" + ++uidSeq; store.set(`${col.path}/${id}`, { ...data }); notify(); return ref(`${col.path}/${id}`); },
  async updateDoc(r, data) {
    const d = { ...(store.get(r.path) || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (k.includes(".")) { const [a, b] = k.split("."); d[a] = { ...(d[a] || {}), [b]: v }; }
      else if (v && v.__union) d[k] = [...new Set([...(d[k] || []), ...v.__union])];
      else if (v && v.__remove) d[k] = (d[k] || []).filter((x) => !v.__remove.includes(x));
      else d[k] = v;
    }
    store.set(r.path, d); notify();
  },
  async deleteDoc(r) { store.delete(r.path); notify(); },
  writeBatch: () => { const ops = []; return { update: (r, d) => ops.push([r, d]), commit: async () => { for (const [r, d] of ops) await fs.updateDoc(r, d); } }; },
  onSnapshot(target, cb) {
    const seen = new Set();
    const sub = {
      run() {
        if (target.type === "doc") {
          const d = store.get(target.path);
          return cb({ exists: () => !!d, data: () => d, id: target.id, ref: target });
        }
        let rows = [...store.entries()].filter(([p]) => p.startsWith(target.path + "/") && p.split("/").length === target.path.split("/").length + 1)
          .map(([p, d]) => ({ id: p.split("/").pop(), d }));
        let lim = Infinity;
        for (const c of target.cons || []) {
          if (c.k === "where") rows = rows.filter(({ d }) => c.op === "==" ? d[c.f] === c.v : c.op === "array-contains" ? (d[c.f] || []).includes(c.v) : true);
          if (c.k === "order") rows.sort((a, b) => ((a.d[c.f]?.toMillis?.() ?? 0) - (b.d[c.f]?.toMillis?.() ?? 0)) * (c.d === "desc" ? -1 : 1));
          if (c.k === "limit") lim = c.n;
        }
        rows = rows.slice(0, lim);
        const docs = rows.map(({ id, d }) => ({ id, data: () => d, ref: ref(`${target.path}/${id}`) }));
        const changes = docs.filter((x) => !seen.has(x.id)).map((x) => ({ type: "added", doc: x }));
        docs.forEach((x) => seen.add(x.id));
        cb({ docs, docChanges: () => changes });
      },
    };
    subs.add(sub); setTimeout(() => sub.run(), 0);
    return () => subs.delete(sub);
  },
};

let authCb = null;
export const auth = { currentUser: null };
export const authMod = {
  onAuthStateChanged: (_a, cb) => { authCb = cb; setTimeout(() => cb(auth.currentUser), 0); return () => {}; },
  signInWithCustomToken: async (_a, token) => { auth.currentUser = { uid: token }; authCb(auth.currentUser); },
  signOut: async () => { auth.currentUser = null; authCb(null); },
};
export const db = {};

const hours = (s) => s.mode === "flat" ? s.price : null;
const fns = {
  async phoneLogin({ phone, name, lang }) {
    const uid = "p964" + phone.replace(/\D/g, "").replace(/^0/, "");
    store.set(`users/${uid}`, { phone, phonePretty: "+964 " + phone.slice(1, 4) + " " + phone.slice(4, 7) + " " + phone.slice(7), name, lang, fcmTokens: [], blocked: false });
    // seed one notification so the bell shows a count
    store.set(`users/${uid}/notifications/n1`, { title: "Welcome to Jêga", body: "Find a spot or list yours.", read: false, at: now(), link: "/" });
    return { token: uid };
  },
  async createBooking({ slotId, date, start, hours: h, payMethod }) {
    const s = store.get(`slots/${slotId}`);
    const total = hours(s) ?? s.price * h;
    const id = "b" + ++uidSeq;
    const u = store.get(`users/${auth.currentUser.uid}`);
    store.set(`bookings/${id}`, { slotId, slotCode: s.code, slotTitle: s.title, landmark: s.landmark, lat: s.lat, lng: s.lng, hostUid: s.hostUid, hostName: s.hostName, hostPhone: s.hostPhone,
      driverUid: auth.currentUser.uid, driverName: u.name, driverPhone: u.phonePretty, date, start, hours: h, total, mode: s.mode, payMethod,
      status: payMethod === "cash" ? "confirmed" : "pending_payment", paymentStatus: payMethod === "cash" ? "cash_on_arrival" : "unpaid",
      startAt: { toMillis: () => Date.now() + 3600e3 }, expiresAt: { toMillis: () => Date.now() + 15 * 60e3 }, createdAt: now() });
    store.set(`chats/${slotId}_${auth.currentUser.uid}`, { members: [auth.currentUser.uid, s.hostUid], slotId, slotCode: s.code, names: { [auth.currentUser.uid]: u.name, [s.hostUid]: s.hostName }, lastAt: now(), unread: {} });
    store.set(`chats/${slotId}_${auth.currentUser.uid}/messages/m0`, { from: "system", text: `${s.code} · ${date} · ${total} IQD`, at: now() });
    notify();
    return { bookingId: id, status: payMethod === "cash" ? "confirmed" : "pending_payment" };
  },
  async paymentServices() { return { services: [{ id: "test-fib", name: "FIB (test)" }, { id: "test-qi", name: "Qi Card (test)" }], testMode: true }; },
  async startPayment({ bookingId }) { window.__payBooking = bookingId; return { url: "about:blank#pay" }; },
  async checkPayment({ bookingId }) { return { status: store.get(`bookings/${bookingId}`).status }; },
  async cancelBooking({ bookingId }) { await fs.updateDoc(ref(`bookings/${bookingId}`), { status: "cancelled" }); return { ok: true }; },
};
export const call = (name) => async (data) => ({ data: await fns[name](data) });
export const enablePush = async () => "unsupported";
export const disablePush = async () => {};
export const onForegroundPush = () => {};

// test helpers
window.__store = store;
window.__pay = (id) => fs.updateDoc(ref(`bookings/${id}`), { status: "confirmed", paymentStatus: "paid" });
const host = "phost";
const seedSlot = (id, o) => store.set(`slots/${id}`, { hostUid: host, hostName: "Rawand K.", hostPhone: "+964 750 112 4401", active: true, status: "active", feat: ["covered"], allDay: true, opens: "00:00", closes: "00:00", maxH: 12, createdAt: now(), ...o });
seedSlot("s1", { code: "A-07", title: "Covered spot by Ainkawa Mall", area: "ainkawa", landmark: "Behind Ainkawa Mall, gate 2", mode: "hour", price: 1500, lat: 36.229, lng: 44.006 });
seedSlot("s2", { code: "C-02", title: "Driveway near the Citadel", area: "citadel", landmark: "Qaysari Bazaar side street", mode: "flat", price: 5000, maxH: 6, lat: 36.191, lng: 44.009 });
store.set("config/app", { commissionPct: 10, pendingPaymentMinutes: 15, onlinePayments: true });
