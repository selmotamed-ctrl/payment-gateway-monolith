import { computed, ref, shallowRef } from "vue";
import { en as vuetifyEn, ar as vuetifyAr } from "vuetify/locale";
import type { LocaleInstance } from "vuetify";
import { getLocaleName, i18n, setI18nLocale } from "@/plugins/i18n";

const vuetifyMessages: Record<string, Record<string, string>> = {
    en: vuetifyEn as unknown as Record<string, string>,
    ar: vuetifyAr as unknown as Record<string, string>,
};

const lookupNested = (source: unknown, path: string): unknown => {
    let cursor: unknown = source;
    for (const part of path.split(".")) {
        if (!cursor || typeof cursor !== "object") {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
};

const replaceParams = (str: string, params: unknown[]): string => {
    return str.replace(/\{(\w+)\}/g, (match, key: string) => {
        const numeric = Number(key);
        if (!Number.isNaN(numeric)) {
            return String(params[numeric] ?? "");
        }
        const object = params[0] as Record<string, unknown> | undefined;
        const value = object?.[key];
        return value === undefined || value === null ? match : String(value);
    });
};

export const adaptedLocale: LocaleInstance = {
    name: "payment-gateway-i18n",
    decimalSeparator: shallowRef("."),
    messages: ref(vuetifyMessages) as unknown as LocaleInstance["messages"],
    current: computed(() => i18n.global.locale.value) as unknown as LocaleInstance["current"],
    fallback: shallowRef("en"),
    t: (key: string, ...params: unknown[]) => {
        if (typeof key != "string") {
            return String(key ?? "");
        }
        if (key.startsWith("$vuetify.")) {
            const shortKey = key.slice("$vuetify.".length);
            const current = vuetifyMessages[i18n.global.locale.value] ?? vuetifyMessages.en;
            const fallback = vuetifyMessages.en;
            const found = lookupNested(current, shortKey) ?? lookupNested(fallback, shortKey) ?? key;
            return replaceParams(String(found), params);
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
};

export const currentLocale = () => getLocaleName();

export { i18n };
