/**
 * Authentic-looking Libyan operational data. The catalogue is deliberately
 * bilingual so Arabic and English dashboards both render real names.
 */

export const FIRST_NAMES_AR = [
  "محمد", "أحمد", "علي", "يوسف", "عمر", "خالد", "سالم", "مريم", "فاطمة", "عائشة",
  "ليلى", "نور", "هدى", "سارة", "إبراهيم", "مصطفى", "عبدالله", "حسن", "زينب", "رقية",
];

export const FIRST_NAMES_EN = [
  "Mohamed", "Ahmed", "Ali", "Yousef", "Omar", "Khaled", "Salem", "Mariam", "Fatima", "Aisha",
  "Layla", "Nour", "Huda", "Sara", "Ibrahim", "Mustafa", "Abdullah", "Hassan", "Zainab", "Ruqaya",
];

// The Arabic and English surname lists are index-aligned (randomName picks the
// same index in both). The previous lists had 15 Arabic and 14 English entries,
// so every name after the sixth was paired with the wrong transliteration and
// the last one rendered as "undefined".
export const LAST_NAMES_AR = [
  "المصراتي", "الطرابلسي", "البنغازي", "الزوي", "الورفلي", "العبيدي", "الشريف",
  "المبروك", "الفيتوري", "السنوسي", "الجحاوي", "الزنتاني", "الغرياني", "الدرسي",
];

export const LAST_NAMES_EN = [
  "Al-Misrati", "Al-Tarabulsi", "Al-Benghazi", "Al-Zawi", "Al-Werfalli", "Al-Obeidi", "Al-Sharif",
  "Al-Mabrouk", "Al-Fitouri", "Al-Senussi", "Al-Jahawi", "Al-Zintani", "Al-Ghariani", "Al-Darsi",
];

export const CITIES = [
  { ar: "طرابلس", en: "Tripoli" },
  { ar: "بنغازي", en: "Benghazi" },
  { ar: "مصراتة", en: "Misrata" },
  { ar: "الزاوية", en: "Zawiya" },
  { ar: "سبها", en: "Sabha" },
  { ar: "طبرق", en: "Tobruk" },
  { ar: "درنة", en: "Derna" },
  { ar: "الخمس", en: "Khoms" },
];

export const BANKS = [
  { ar: "مصرف الجمهورية", en: "Jumhouria Bank", code: "JUM", ibanCode: "002" },
  { ar: "مصرف الوحدة", en: "Wahda Bank", code: "WAH", ibanCode: "005" },
  { ar: "مصرف الصحاري", en: "Sahara Bank", code: "SAH", ibanCode: "004" },
  { ar: "مصرف شمال أفريقيا", en: "North Africa Bank", code: "NAB", ibanCode: "011" },
  { ar: "مصرف التجاري الوطني", en: "National Commercial Bank", code: "NCB", ibanCode: "003" },
  { ar: "مصرف اليقين", en: "Yaqeen Bank", code: "YAQ", ibanCode: "032" },
];

/**
 * Merchant categories with the ticket-size band (LYD) a Libyan merchant of
 * that kind really collects, the share of the cohort, and whether the
 * category runs counter (POS) checkout.
 */
export const BUSINESS_CATEGORIES = [
  { ar: "تجارة التجزئة", en: "Retail", code: "RETAIL", min: 15, max: 1200, weight: 22, pos: true },
  { ar: "المطاعم والمقاهي", en: "Restaurants & Cafes", code: "RESTAURANTS", min: 8, max: 300, weight: 16, pos: true },
  { ar: "الصيدليات", en: "Pharmacies", code: "PHARMACY", min: 10, max: 450, weight: 10, pos: true },
  { ar: "الاتصالات", en: "Telecommunications", code: "TELECOM", min: 5, max: 150, weight: 10, pos: false },
  { ar: "العقارات", en: "Real Estate", code: "REAL_ESTATE", min: 500, max: 25000, weight: 4, pos: false },
  { ar: "النقل", en: "Transport", code: "TRANSPORT", min: 10, max: 650, weight: 8, pos: false },
  { ar: "التعليم", en: "Education", code: "EDUCATION", min: 150, max: 6000, weight: 8, pos: false },
  { ar: "الخدمات المهنية", en: "Professional Services", code: "PROFESSIONAL_SERVICES", min: 100, max: 5000, weight: 9, pos: false },
  { ar: "السياحة والسفر", en: "Travel & Tourism", code: "TRAVEL", min: 250, max: 9000, weight: 7, pos: false },
  { ar: "البناء والتشييد", en: "Construction", code: "CONSTRUCTION", min: 400, max: 20000, weight: 6, pos: false },
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export const BUSINESS_SUFFIXES = [
  { ar: "للمواد الغذائية", en: "Foodstuffs" },
  { ar: "للخدمات", en: "Services" },
  { ar: "للتجارة العامة", en: "General Trading" },
  { ar: "للإلكترونيات", en: "Electronics" },
  { ar: "للمقاولات", en: "Contracting" },
  { ar: "للصيدلة", en: "Pharmacy" },
  { ar: "للاتصالات", en: "Telecom" },
  { ar: "للأثاث", en: "Furniture" },
];

export const STREETS = ["شارع عمر المختار", "شارع الجمهورية", "شارع 17 فبراير", "شارع الاستقلال", "طريق المطار"];

export const ADDRESSES_EN = ["Omar Al-Mukhtar St", "Republic St", "17 February St", "Independence St", "Airport Road"];

export const PHONE_PREFIXES = ["091", "092", "093", "094", "095"];

export const OTP_CODES = ["1234", "123456", "482910", "781245", "559021", "662104", "908113"];

export const NATIONALITIES = ["LY", "EG", "TN", "TR", "AE", "GB", "IT"];

export const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

export const pickPhone = (rng: { pick: <T>(values: readonly T[]) => T; int: (min: number, max: number) => number }): string =>
  `${rng.pick(PHONE_PREFIXES)}${String(rng.int(1000000, 9999999))}`;

/** A 25-character Libyan IBAN (LYkk BBB SSS AAAAAAAAAAAAAAA). */
export const pickIban = (rng: { int: (min: number, max: number) => number }, bankCode: string): string =>
  `LY${String(rng.int(10, 99))}${bankCode}${String(rng.int(1, 99)).padStart(3, "0")}${String(rng.int(0, 99_999)).padStart(5, "0")}${String(rng.int(0, 99_999)).padStart(5, "0")}${String(rng.int(0, 99_999)).padStart(5, "0")}`;

export const pickTaxId = (rng: { int: (min: number, max: number) => number }): string =>
  `${rng.int(100000, 999999)}-${rng.int(10, 99)}-${rng.int(1, 9)}`;
