const ARABIC_INDIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const PERSIAN_INDIC_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

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
