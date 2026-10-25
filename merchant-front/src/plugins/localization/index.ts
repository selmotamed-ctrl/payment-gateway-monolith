import { createI18n } from "vue-i18n";
import type { LocaleInstance } from "vuetify";
import { en, ar } from "vuetify/locale";
import { createVueI18nAdapter } from "vuetify/locale/adapters/vue-i18n";
import { useI18n } from "vue-i18n";
import { isDev, isSendNotFoundTranslations } from "@/constants/env";
import axios from "axios";
import { createAsyncBatcher } from "async-batcher-js";

export const messages = {
    en: {
        $vuetify: {
            ...en,
        },
    },
    ar: {
        $vuetify: {
            ...ar,
        },
        ...Object.fromEntries(Object.entries({}).map(([key, translation]) => {
            return [key.toLowerCase(), translation];
        })),
    },
};

export const getLocaleName = () => {
    const locale = localStorage.getItem("locale-name");
    return locale || "ar";
};

export const setLocale = (l: string) => {
    localStorage.setItem("locale-name", l);
    setTimeout(() => {
        location.reload();
    }, 0.5e3);
};

export const i18n = createI18n({
    legacy: false,
    locale: getLocaleName(),
    fallbackLocale: "en",
    fallbackWarn: false,
    missingWarn: false,
    messages,
});

const adaptedLocale: LocaleInstance & {
    originalT: (key: string, ...params: unknown[]) => string;
} = createVueI18nAdapter({ i18n, useI18n }) as any;

adaptedLocale.originalT = adaptedLocale.t;

const sendBatcher = createAsyncBatcher<
    {
        lang: string;
        message: string;
    },
    void
>({
    async batcherCallback(promises, timeoutAbortSignal) {
        const phrases: {
            [lang: string]: string[];
        } = {};
        for (const promise of promises) {
            promise.resolve();

            if (!phrases[promise.content.lang]) {
                phrases[promise.content.lang] = [];
            }
            phrases[promise.content.lang]?.push(promise.content.message);
        }
        if (Object.keys(phrases).length)
            try {
                console.log("sending translations", phrases);
                await axios.post(
                    "http://localhost:3456/api/add-translations",
                    {
                        phrases,
                    },
                    {
                        signal: timeoutAbortSignal,
                    },
                );
            } catch (error) {
                console.error(error);
            }
    },
    batchPeriodInMs: 1e3,
    name: "translation-batcher",
    timeoutPeriod: 60e3,
});
if (isDev()) {
    sendBatcher.start();
}
adaptedLocale.t = (key: string, ...args: any[]) => {
    if (typeof key != "string") {
        return key;
    }
    if (key.match(/\{\{.*?\}\}/)) {
        const translations = [] as string[];
        const match = key.matchAll(/\{\{(.*?)\}\}|(.+?)(?=$|\{\{)/gi);
        for (const [_, constant, translatable] of match) {
            if (constant) {
                translations.push(constant);
            } else if (translatable) {
                const match = translatable.match(/^(\s+)?(.+?)(\s+)?$/);
                if (match) {
                    if (match[1]) {
                        translations.push(match[1]);
                    }
                    if (match[2]) {
                        translations.push(adaptedLocale.t(match[2]));
                    }
                    if (match[3]) {
                        translations.push(match[3]);
                    }
                } else {
                    translations.push(translatable);
                }
            }
        }
        return translations.join("");
    }

    if (key.startsWith("$v")) {
        return adaptedLocale.originalT(key, ...args);
    }
    const translation = adaptedLocale.originalT(key.toLowerCase(), ...args);
    if (translation == key.toLowerCase()) {
        if (key.toLowerCase() && isDev() && isSendNotFoundTranslations()) {
            sendBatcher.run({
                message: key.toLowerCase(),
                lang: adaptedLocale.current.value,
            });
        }
        return key;
    }
    return translation;
};

export const t = adaptedLocale.t;
export { adaptedLocale };
