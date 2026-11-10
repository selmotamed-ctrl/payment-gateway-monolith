import { createI18n } from "vue-i18n";
import { en as vuetifyEn, ar as vuetifyAr } from "vuetify/locale";
import { appCatalogue } from "@/constants/i18nCatalogue";
import { academyCatalogue } from "@/constants/i18nAcademy";
import { commerceCatalogue } from "@/constants/i18n/commerce";
import { ledgerOpsCatalogue } from "@/constants/i18n/ledgerOps";
import { formsCatalogue } from "@/constants/i18n/forms";
import { buildersCatalogue } from "@/constants/i18n/builders";
import { reportsCatalogue } from "@/constants/i18n/reports";

const buildAppMessages = () => {
    const en: Record<string, string> = {};
    const ar: Record<string, string> = {};
    for (const [key, pair] of Object.entries({ ...appCatalogue, ...academyCatalogue, ...commerceCatalogue, ...ledgerOpsCatalogue, ...formsCatalogue, ...buildersCatalogue, ...reportsCatalogue })) {
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
