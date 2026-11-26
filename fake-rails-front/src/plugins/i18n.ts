import { createI18n } from "vue-i18n";

/** Minimal catalogue for the tester portal; labels fall back to their keys. */
export const i18n = createI18n({
    legacy: false,
    globalInjection: true,
    locale: "en",
    fallbackLocale: "en",
    messages: { en: {}, ar: {} },
});
