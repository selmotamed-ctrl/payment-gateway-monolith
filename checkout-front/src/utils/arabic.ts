const ARABIC_INDIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const PERSIAN_INDIC_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
const ARABIC_DECIMAL_SEPARATOR = "٫";
const ARABIC_THOUSANDS_SEPARATOR = "٬";

export const toAsciiDigits = (input: string): string => {
    let out = "";
    for (const char of input) {
        const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(char);
        if (arabicIndex >= 0) {
            out += String(arabicIndex);
            continue;
        }
        const persianIndex = PERSIAN_INDIC_DIGITS.indexOf(char);
        if (persianIndex >= 0) {
            out += String(persianIndex);
            continue;
        }
        out += char;
    }
    return out;
};

export const normalizeArabicDigits = (input: string | null | undefined): string => {
    if (!input) {
        return "";
    }
    return toAsciiDigits(String(input))
        .replace(new RegExp(ARABIC_DECIMAL_SEPARATOR, "g"), ".")
        .replace(new RegExp(ARABIC_THOUSANDS_SEPARATOR, "g"), "")
        .replace(/[٫٬]/g, (char) => (char === ARABIC_DECIMAL_SEPARATOR ? "." : ""));
};

export const toArabicIndicDigits = (input: string | null | undefined): string => {
    if (!input) {
        return "";
    }
    return String(input)
        .split("")
        .map((char) => {
            if (char >= "0" && char <= "9") {
                return ARABIC_INDIC_DIGITS[Number(char)];
            }
            return char;
        })
        .join("");
};

const ARABIC_DIACRITICS = /[ً-ٰٟ]/g;
const TATWEEL = /ـ/g;

export const normalizeArabicText = (input: string | null | undefined): string => {
    if (!input) {
        return "";
    }
    return String(input)
        .replace(ARABIC_DIACRITICS, "")
        .replace(TATWEEL, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/ؤ/g, "و")
        .replace(/ئ/g, "ي")
        .replace(/[‌-‏‪-‮]/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

export const normalizePhone = (input: string | null | undefined, style: "LOCAL_09" | "INTL_218" | "E164" = "LOCAL_09"): string => {
    const digits = toAsciiDigits(String(input ?? "")).replace(/[^\d+]/g, "");
    if (!digits) {
        return "";
    }
    const local = digits.replace(/^\+/, "").replace(/^218/, "0").replace(/^00918/, "0");
    if (style === "INTL_218") {
        const localDigits = local.replace(/^0/, "");
        return localDigits ? `+218${localDigits}` : "";
    }
    if (style === "E164") {
        const localDigits = local.replace(/^0/, "");
        return localDigits ? `+218${localDigits}` : "";
    }
    return local;
};

export const isArabicText = (input: string | null | undefined): boolean => {
    if (!input) {
        return false;
    }
    return /[\u0600-\u06FF]/.test(String(input));
};
