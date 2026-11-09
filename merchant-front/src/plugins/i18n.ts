import { createI18n } from "vue-i18n";
import { en as vuetifyEn, ar as vuetifyAr } from "vuetify/locale";
import { appCatalogue } from "@/constants/i18nCatalogue";
import { landingCatalogue } from "@/constants/landingCatalogue";
import { merchantReportCatalogue } from "@/constants/reportCatalogue";

const buildAppMessages = () => {
    const en: Record<string, string> = {};
    const ar: Record<string, string> = {};
    // The app catalogue wins on any key collision (the landing test forbids collisions).
    for (const [key, pair] of Object.entries({ ...landingCatalogue, ...appCatalogue, ...merchantReportCatalogue })) {
        en[key] = pair[0];
        ar[key] = pair[1];
    }
    return { en, ar };
};

const appMessages = buildAppMessages();

export const messages = {
    en: {
        ...appMessages.en,
        $vuetify: { ...vuetifyEn },
    },
    ar: {
        ...appMessages.ar,
        $vuetify: { ...vuetifyAr },
    },
};

export const getLocaleName = (): "ar" | "en" => {
    const stored = localStorage.getItem("locale-name");
    return stored === "en" ? "en" : "ar";
};

export const i18n = createI18n({
    legacy: false,
    globalInjection: true,
    locale: getLocaleName(),
    fallbackLocale: "en",
    fallbackWarn: false,
    missingWarn: false,
    messages,
});

export const setI18nLocale = (locale: "ar" | "en") => {
    i18n.global.locale.value = locale;
    localStorage.setItem("locale-name", locale);
    if (typeof document !== "undefined") {
        document.documentElement.setAttribute("lang", locale);
        document.documentElement.setAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    }
};

if (typeof document !== "undefined") {
    const locale = getLocaleName();
    document.documentElement.setAttribute("lang", locale);
    document.documentElement.setAttribute("dir", locale === "ar" ? "rtl" : "ltr");
}
