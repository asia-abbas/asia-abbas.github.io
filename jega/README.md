# Jêga · جێگا

Parking-slot rental for Erbil (and any Iraqi city). Drivers find and book a slot; hosts list driveways, garages and bays in any area and earn.

**Kurdish (Sorani) setup guide:** [README.ckb.md](README.ckb.md)

| Part | Folder | Who uses it | Sign-in |
|---|---|---|---|
| **Jêga app** (installable PWA) | `app/` | Drivers and hosts | Phone number only, no code |
| **Jêga Admin** (separate site) | `admin/` | You, the owner | Email + password, admin accounts only |
| **Backend** (Cloud Functions) | `functions/` | Both, never directly | — |
| **Security rules** | `firestore.rules` | Enforces who can read/write what | — |

## What's in it

**App (drivers and hosts)**
- Four languages, switchable any time: English, Arabic, Kurdish Sorani (Central), Kurdish Badini. Arabic and both Kurdish dialects use right-to-left layout.
- Two modes: **I need parking** and **I have a slot**.
- Map (OpenStreetMap, free) and list views, area filters, search, "near me".
- Two pricing options per slot: **per hour** (price × hours) or **flat** (one price for any length up to a maximum the host sets).
- Booking with opening hours, overlap protection, and a server-side price check.
- Payment: **cash on arrival** or **online through FuratPay** (FIB, Qi Card, FastPay and other services enabled on your merchant account).
- Chat between driver and host for every slot and booking.
- Notifications: in-app list (bell), live pop-up alerts, and phone push alerts even when the app is closed.
- Installable on Android and iPhone home screens, and works offline for viewing.

**Notifications and alerts that are sent automatically**

| When | Who gets it |
|---|---|
| New booking | Host |
| Booking confirmed (cash, or once paid online) | Driver |
| Payment received | Host |
| Payment failed | Driver, plus an alert to admins |
| Unpaid booking released after 15 min (configurable) | Driver |
| 30 min before start | Driver ("starts soon") and host ("driver arriving") |
| 15 min before the end | Driver |
| New chat message | Other person (push only) |
| Slot suspended or restored by admin | Host |
| Booking cancelled | The other side |
| Broadcast from admin | Everyone, hosts only, or drivers only |

**Admin dashboard (owner only)**
- Overview: users, active slots, bookings today, revenue and Jêga fees this month, refunds to do, a 14-day bookings chart, and a map of every slot.
- Alerts: payment problems, webhook errors, new slots, user reports, and blocked users trying to sign in. Live pop-ups, plus optional desktop push.
- Bookings: filter, search, cancel (both sides notified), and mark refunds done.
- Slots: suspend or restore with a reason (the host is notified).
- Users: block or unblock (signs them out everywhere and suspends their slots).
- Payments: every FuratPay payment with status.
- Broadcast: send announcements.
- Settings: Jêga fee %, payment hold time, online payments on or off, and an announcement banner in all four languages.
- Every admin action is written to an audit log.

## Access tree

```
Firebase Auth
├── Phone accounts  (uid "p964…", token claim role = "user")   ← created only by phoneLogin function
│     can: read slots · manage OWN slots (not their status) · read OWN bookings as driver or host
│          chat in threads they belong to · read OWN notifications · send reports
│     cannot: write bookings or payments · see other users · open the admin site
└── Admin accounts  (email + password, claim admin = true)      ← created only by scripts/make-admin.mjs
      can: read everything · suspend slots · block users · cancel bookings · settings · broadcasts
Money and booking state are written ONLY by Cloud Functions.
```

## Setup (about 30 minutes)

You need: a Google account, [Node.js 20+](https://nodejs.org), and the Firebase CLI (`npm i -g firebase-tools`).

1. **Create the Firebase project.** At [console.firebase.google.com](https://console.firebase.google.com), add a project and switch it to the **Blaze** plan. Cloud Functions and scheduled reminders need Blaze; small apps usually stay within the free allowance.
2. **Turn on the services:**
   - Build → **Firestore Database** → Create. Choose location `eur3` or `europe-west1`.
   - Build → **Authentication** → Get started → enable **Email/Password** (used only for admins).
   - Project settings → General → **Add app → Web**. Copy the config.
   - Project settings → **Cloud Messaging** → Web Push certificates → **Generate key pair**. Copy the key.
3. **Paste the settings:**
   - `app/js/firebase-config.js` and `admin/js/firebase-config.js`: the web config (same values in both).
   - `app/js/config.js` → `VAPID_KEY`, and `admin/js/admin.js` → `VAPID_KEY`: the key pair.
   - `.firebaserc`, `functions/.env`: replace `your-project-id` with your project ID.
4. **Create the second hosting site for the admin dashboard:** Hosting → Add another site, for example `your-project-id-admin`. Put that name in `.firebaserc` under `admin`.
5. **Set the payment secrets.** Until you have FuratPay, enter `none` for both:
   ```bash
   firebase login
   firebase functions:secrets:set FURATPAY_API_KEY
   firebase functions:secrets:set FURATPAY_WEBHOOK_SECRET
   ```
6. **Deploy everything:**
   ```bash
   cd functions && npm install && cd ..
   firebase deploy
   ```
   - App: `https://your-project-id.web.app`
   - Admin: `https://your-project-id-admin.web.app`
7. **Create your admin account.** Project settings → Service accounts → **Generate new private key**, and save it as `functions/service-account.json`. Never commit or share it. Then run:
   ```bash
   cd functions
   node scripts/make-admin.mjs you@example.com "a-strong-password"
   ```
8. **Optional: custom domains.** Hosting → Add custom domain, for example `jega.app` and `admin.jega.app`. Then update `APP_URL` in `functions/.env` and redeploy the functions.

### Test it locally

```bash
firebase emulators:start      # app on http://localhost:5000, Emulator UI on http://localhost:4000
cd functions && npm test      # backend unit tests
python3 test/ui_test.py       # UI walk-through with Firebase mocked (needs Playwright)
```

## FuratPay (online payments)

The payment code follows FuratPay's own published integration ([woo-furatpay](https://github.com/AramRafeq/woo-furatpay)): invoices in IQD, payment services such as FIB, Qi Card and FastPay, status checks, and signed webhooks.

**Right now it runs in test mode.** While `FURATPAY_API_KEY` is `none`, drivers who choose "Pay online" see test services and a built-in test checkout with **Pay** and **Decline** buttons. The whole flow works: hold, confirmation, notifications, release on timeout. No money moves.

**When you get your merchant account:**
1. From the FuratPay dashboard, copy the **API key**, the **webhook secret**, and the **API URL** (if it's different from `https://api.furatpay.com/v1`).
2. Set them:
   ```bash
   firebase functions:secrets:set FURATPAY_API_KEY          # paste the real key
   firebase functions:secrets:set FURATPAY_WEBHOOK_SECRET   # paste the webhook secret
   # if the URL differs, edit FURATPAY_API_URL in functions/.env
   firebase deploy --only functions
   ```
3. In the FuratPay dashboard, set the webhook URL to the one shown in **Admin → Settings**:
   `https://europe-west1-your-project-id.cloudfunctions.net/furatpayWebhook`
4. Make one small real payment and check that it shows up in **Admin → Payments**.

Ask FuratPay to confirm whether customers need an email. If they do, set `FURATPAY_CUSTOMER_EMAIL_DOMAIN` in `functions/.env`.

**Money rules built in**
- The price is calculated on the server. The app can't change it.
- An online booking holds the slot for 15 minutes. If payment doesn't arrive, the slot is released and the driver is told.
- A payment that arrives after release is flagged **Refund needed** in Admin, with a critical alert.
- Drivers can cancel cash bookings before the start time. Paid bookings are cancelled by an admin, who records the refund.
- Each booking stores the total, the Jêga fee (your commission %), and the host's earnings.

## Security notes (please read)

**Phone-only login with no code was a product decision, and it has a cost.** Anyone who types someone else's number can open that account and see their bookings and chats. The system limits the damage:
- Sign-in attempts are rate-limited per phone number and per IP.
- Phone accounts can never become admins or touch money records.
- Blocked users can't sign in, and admins are alerted when they try.

When you're ready, the easiest upgrade is a 4-digit PIN set on first sign-in, or Firebase's SMS code. Both fit into `phoneLogin` without changing the rest of the app.

Also:
- Keep `functions/service-account.json` private. It's git-ignored.
- Use a long, unique password for admin accounts, and remove access for anyone who leaves (`make-admin.mjs email --remove`).
- The admin site is `noindex` and can't be framed. You can also put it on a hard-to-guess subdomain.

## Project layout

```
app/                 PWA (no build step): index.html, css/, js/app.js (screens), js/i18n.js (all 4 languages),
                     js/hero.js (login illustration), sw.js (offline + push), manifest.webmanifest, icons/
admin/               Admin dashboard (separate hosting site)
functions/           Cloud Functions
  src/bookings.js    phone sign-in, create/cancel booking
  src/payments.js    FuratPay flow, webhook, test checkout
  src/furatpay.js    FuratPay API adapter
  src/triggers.js    chat pushes, new-slot/report alerts, 5-minute booking clock (reminders, expiry)
  src/admin.js       admin-only actions
  src/messages.js    notification text in all 4 languages
  scripts/make-admin.mjs
firestore.rules      access control
test/                UI test with mocked Firebase
```

**Changing text:** every app string lives in `app/js/i18n.js` and every notification in `functions/src/messages.js`, with English, Arabic, Sorani and Badini side by side. Have native speakers review the Kurdish and Arabic before launch, especially Badini, where spelling varies.
