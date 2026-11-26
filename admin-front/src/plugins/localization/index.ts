import { computed, ref } from "vue";
import { getLocaleName, i18n, setI18nLocale } from "@/plugins/i18n";

/**
 * Locale adapter kept for the many call sites that use `adaptedLocale.t` /
 * `.current` / `.n`. It is backed by vue-i18n only; Vuetify's locale bundle
 * is no longer shipped.
 */
export const localeVersion = ref(0);

export const adaptedLocale = {
    name: "payment-gateway-i18n",
    current: computed(() => i18n.global.locale.value),
    t: (key: string, ...params: unknown[]) => {
        if (typeof key !== "string") {
            return String(key ?? "");
        }
        const translate = i18n.global.t as unknown as (...args: unknown[]) => string;
        return String(translate(key, ...params));
    },
    n: (value: number) => (i18n.global.n as unknown as (v: number) => string)(value),
    provide: () => adaptedLocale,
};

export const t = adaptedLocale.t;

export const setLocale = (locale: string) => {
    setI18nLocale(locale === "en" ? "en" : "ar");
    localeVersion.value += 1;
};

export const currentLocale = () => getLocaleName();

export { i18n };
