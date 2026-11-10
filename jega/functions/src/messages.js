// Notification text for every language the app supports.
// en = English, ar = Arabic, ckb = Kurdish Sorani (Central), kmr = Kurdish Badini.
// Placeholders in {braces} are filled by notify().

export const CURRENCY = { en: "IQD", ar: "دينار", ckb: "دینار", kmr: "دینار" };

export const MSG = {
  booking_new: {
    en: ["New booking for {code}", "{driver} booked {when}. {total}"],
    ar: ["حجز جديد لـ {code}", "{driver} حجز {when}. {total}"],
    ckb: ["حیجزی نوێ بۆ {code}", "{driver} حیجزی کرد: {when}. {total}"],
    kmr: ["حیجزەکا نوی بۆ {code}", "{driver} حیجز کر: {when}. {total}"],
  },
  booking_confirmed: {
    en: ["Booking confirmed", "{code} · {when}"],
    ar: ["تم تأكيد الحجز", "{code} · {when}"],
    ckb: ["حیجزەکە پشتڕاستکرایەوە", "{code} · {when}"],
    kmr: ["حیجز هاتە پشتڕاستکرن", "{code} · {when}"],
  },
  payment_paid: {
    en: ["Payment received", "{total} for {code} · {when}"],
    ar: ["تم استلام الدفعة", "{total} مقابل {code} · {when}"],
    ckb: ["پارەکە وەرگیرا", "{total} بۆ {code} · {when}"],
    kmr: ["پارە هاتە وەرگرتن", "{total} بۆ {code} · {when}"],
  },
  payment_failed: {
    en: ["Payment didn't go through", "Your booking for {code} was not confirmed. Try again or pay in cash."],
    ar: ["لم تتم عملية الدفع", "لم يتم تأكيد حجزك لـ {code}. حاول مجدداً أو ادفع نقداً."],
    ckb: ["پارەدانەکە سەرنەکەوت", "حیجزەکەت بۆ {code} پشتڕاست نەکرایەوە. دووبارە هەوڵ بدەرەوە یان بە کاش بیدە."],
    kmr: ["پارەدان سەرنەکەفت", "حیجزا تە بۆ {code} نەهاتە پشتڕاستکرن. دووبارە هەول بدە یان ب کاش بدە."],
  },
  booking_expired: {
    en: ["Booking released", "Payment for {code} wasn't completed within {min} minutes, so the slot was released."],
    ar: ["تم إلغاء الحجز", "لم يكتمل الدفع لـ {code} خلال {min} دقيقة، فأصبح الموقف متاحاً."],
    ckb: ["حیجزەکە هەڵوەشایەوە", "پارەدان بۆ {code} لە {min} خولەکدا تەواو نەبوو، بۆیە جێگاکە ئازاد کرا."],
    kmr: ["حیجز هاتە هەلوەشاندن", "پارەدان بۆ {code} د {min} خولەکان دا تەمام نەبوو، لەوما جه هاتە ئازادکرن."],
  },
  reminder_start: {
    en: ["Your parking starts soon", "{code} at {time}. {landmark}"],
    ar: ["موقفك يبدأ قريباً", "{code} الساعة {time}. {landmark}"],
    ckb: ["پارککردنەکەت بەم زووانە دەست پێدەکات", "{code} کاتژمێر {time}. {landmark}"],
    kmr: ["پارککرنا تە دێ زوو دەستپێکەت", "{code} دەمژمێر {time}. {landmark}"],
  },
  reminder_end: {
    en: ["15 minutes left", "Your time at {code} ends at {time}."],
    ar: ["بقيت 15 دقيقة", "ينتهي وقتك في {code} الساعة {time}."],
    ckb: ["15 خولەک ماوە", "کاتەکەت لە {code} کاتژمێر {time} تەواو دەبێت."],
    kmr: ["15 خولەک مان", "دەمێ تە ل {code} دەمژمێر {time} ب دوماهی دهێت."],
  },
  host_arriving: {
    en: ["Driver arriving soon", "{driver} parks at {code} at {time}."],
    ar: ["السائق سيصل قريباً", "{driver} سيصطف في {code} الساعة {time}."],
    ckb: ["شۆفێر بەم زووانە دەگات", "{driver} کاتژمێر {time} لە {code} پارک دەکات."],
    kmr: ["شوفێر دێ زوو گەهیت", "{driver} دەمژمێر {time} ل {code} پارک دکەت."],
  },
  slot_suspended: {
    en: ["Slot {code} suspended", "{reason}"],
    ar: ["تم إيقاف الموقف {code}", "{reason}"],
    ckb: ["جێگای {code} ڕاگیرا", "{reason}"],
    kmr: ["جهێ {code} هاتە راوەستاندن", "{reason}"],
  },
  slot_restored: {
    en: ["Slot {code} is live again", "Drivers can book it now."],
    ar: ["الموقف {code} متاح مجدداً", "يمكن للسائقين حجزه الآن."],
    ckb: ["جێگای {code} دووبارە بەردەستە", "شۆفێرەکان ئێستا دەتوانن حیجزی بکەن."],
    kmr: ["جهێ {code} دووبارە بەردەستە", "شوفێر نوکە دشێن حیجز بکەن."],
  },
  booking_cancelled: {
    en: ["Booking cancelled", "{code} · {when}. {reason}"],
    ar: ["تم إلغاء الحجز", "{code} · {when}. {reason}"],
    ckb: ["حیجزەکە هەڵوەشێنرایەوە", "{code} · {when}. {reason}"],
    kmr: ["حیجز هاتە هەلوەشاندن", "{code} · {when}. {reason}"],
  },
  message: {
    en: ["{name}", "{text}"], ar: ["{name}", "{text}"], ckb: ["{name}", "{text}"], kmr: ["{name}", "{text}"],
  },
  broadcast: {
    en: ["{title}", "{body}"], ar: ["{title}", "{body}"], ckb: ["{title}", "{body}"], kmr: ["{title}", "{body}"],
  },
};

export function render(type, lang, vars = {}) {
  const set = MSG[type] || MSG.broadcast;
  const [title, body] = set[lang] || set.en;
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "")).replace(/\s+\.\s*$/, ".").trim();
  return { title: fill(title), body: fill(body) };
}

export const money = (n, lang) => `${Number(n).toLocaleString("en-US")} ${CURRENCY[lang] || CURRENCY.en}`;
