export const LOCALE_DISPLAY_NAMES: Record<string, { nativeName: string; direction: "LTR" | "RTL" }> = {
  en: { nativeName: "English", direction: "LTR" },
  ar: { nativeName: "العربية (Arabic)", direction: "RTL" },
  fr: { nativeName: "Français (French)", direction: "LTR" },
  it: { nativeName: "Italiano (Italian)", direction: "LTR" },
  tr: { nativeName: "Türkçe (Turkish)", direction: "LTR" },
};

export interface LocaleOption {
  locale: string;
  nativeName: string;
  direction: "LTR" | "RTL";
  localizedTitle?: string;
}

export function buildLocaleOptions(
  availableLocales: string[],
  reportTitleMap: Record<string, string> = {},
): LocaleOption[] {
  return availableLocales.map((locale) => {
    const meta = LOCALE_DISPLAY_NAMES[locale] ?? {
      nativeName: locale.toUpperCase(),
      direction: locale.startsWith("ar") ? ("RTL" as const) : ("LTR" as const),
    };
    return {
      locale,
      nativeName: meta.nativeName,
      direction: meta.direction,
      localizedTitle: reportTitleMap[locale],
    };
  });
}
