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

export const LAST_NAMES_AR = [
  "المصراتي", "الطرابلسي", "بنغازي", "الزوي", "الورفلي", "القذافي", "العبيدي", "الشريف",
  "المبروك", "الفيتوري", "السنوسي", "الجحاوي", "الزنتاني", "الغرياني", "الدرسي",
];

export const LAST_NAMES_EN = [
  "Al-Misrati", "Al-Tripoli", "Benghazi", "Al-Zawi", "Al-Werfalli", "Al-Abeidi", "Al-Sharif",
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
  { ar: "مصرف الجمهورية", en: "Jumhouria Bank", code: "JUM" },
  { ar: "مصرف الوحدة", en: "Wahda Bank", code: "WAH" },
  { ar: "مصرف الصحاري", en: "Sahara Bank", code: "SAH" },
  { ar: "مصرف شمال أفريقيا", en: "North Africa Bank", code: "NAB" },
  { ar: "مصرف التجاري الوطني", en: "National Commercial Bank", code: "NCB" },
  { ar: "مصرف اليقين", en: "Yaqeen Bank", code: "YAQ" },
];

export const BUSINESS_CATEGORIES = [
  { ar: "تجارة التجزئة", en: "Retail" },
  { ar: "المطاعم والمقاهي", en: "Restaurants & Cafes" },
  { ar: "الصيدليات", en: "Pharmacies" },
  { ar: "الاتصالات", en: "Telecommunications" },
  { ar: "العقارات", en: "Real Estate" },
  { ar: "النقل", en: "Transport" },
  { ar: "التعليم", en: "Education" },
  { ar: "الخدمات المهنية", en: "Professional Services" },
  { ar: "السياحة والسفر", en: "Travel & Tourism" },
  { ar: "البناء والتشييد", en: "Construction" },
];

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

export const pickTaxId = (rng: { int: (min: number, max: number) => number }): string =>
  `${rng.int(100000, 999999)}-${rng.int(10, 99)}-${rng.int(1, 9)}`;
