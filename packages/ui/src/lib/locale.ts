import { computed, getCurrentInstance, ref, watch, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";

export type IconProps = {
    icon?: string;
    size?: string | number;
    color?: string;
    class?: string;
    style?: unknown;
};

export type LocaleLike = {
    t: (key: string, ...params: unknown[]) => string;
    current: { value: string };
    isRtl: ComputedRef<boolean>;
};

export type AppLocale = "en" | "ar";

export type PgLocaleHost = {
    t: (key: string, ...params: unknown[]) => string;
    locale: { value: string };
};

/**
 * The host portal registers its own `vue-i18n` composer here. `@pg/ui` may be
 * bundled with a second physical copy of `vue-i18n` (the package has its own
 * node_modules), which makes `useI18n()` injection return a different composer.
 * Registering the host's translator is deterministic and keeps a single locale
 * source across the package and the app.
 */
let hostLocale: PgLocaleHost | null = null;

export const registerLocaleHost = (host: PgLocaleHost | null | undefined) => {
    hostLocale = host && typeof host.t === "function" && host.locale ? host : null;
    if (hostLocale) syncDocumentLocale(String(hostLocale.locale.value));
};

export const getLocaleHost = (): PgLocaleHost | null => hostLocale;

export const LOCALE_STORAGE_KEY = "locale-name";

/** Persisted application locale. English (LTR) is the default everywhere. */
export const readLocale = (): AppLocale => {
    if (typeof window === "undefined") return "en";
    try {
        return window.localStorage.getItem(LOCALE_STORAGE_KEY) === "ar" ? "ar" : "en";
    } catch {
        return "en";
    }
};

export const currentLocale = ref<AppLocale>(readLocale());

/** Reactive text direction — the single source of truth for `useRtl()`. */
export const isRtlLocale = computed(() => currentLocale.value === "ar");

/**
 * Keeps `<html lang>` and `<html dir>` in lock-step with the active locale.
 * Every portal calls this from `useLocale()` (inside setup), so switching
 * language can never leave English copy rendered inside `dir="rtl"`.
 */
export const syncDocumentLocale = (locale: string | null | undefined = currentLocale.value): AppLocale => {
    const next: AppLocale = locale === "ar" ? "ar" : "en";
    currentLocale.value = next;
    if (typeof document !== "undefined") {
        document.documentElement.setAttribute("lang", next);
        document.documentElement.setAttribute("dir", next === "ar" ? "rtl" : "ltr");
    }
    return next;
};

/**
 * Changes the active locale. It persists the choice, updates the document and —
 * when called inside a component — also updates the host `vue-i18n` instance.
 */
export const setLocale = (locale: string): AppLocale => {
    const next = syncDocumentLocale(locale);
    if (typeof window !== "undefined") {
        try {
            window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
        } catch {
            /* storage can be unavailable in private mode */
        }
    }
    if (hostLocale) {
        try {
            hostLocale.locale.value = next;
        } catch {
            /* frozen host locale */
        }
        return next;
    }
    if (getCurrentInstance()) {
        try {
            const i18n = useI18n({ useScope: "global" });
            if (String(i18n.locale.value) !== next) i18n.locale.value = next;
        } catch {
            /* host not using vue-i18n */
        }
    }
    return next;
};

const translate = (key: string, ...params: unknown[]): string => {
    if (key === null || key === undefined) return "";
    return String(key);
};

const fallbackLocale = ref("en");

/**
 * Locale adapter for every `@pg/ui` primitive. The host portal installs
 * `vue-i18n` globally; the adapter keeps the old `useLocale()` contract used by
 * page components (`t`, `current`, `isRtl`) and synchronizes `<html lang|dir>`.
 */
export const useLocale = (): LocaleLike => {
    if (hostLocale) {
        const host = hostLocale;
        if (getCurrentInstance()) {
            syncDocumentLocale(String(host.locale.value));
            watch(
                () => String(host.locale.value),
                (next) => syncDocumentLocale(next),
            );
            watch(currentLocale, (next) => {
                if (String(host.locale.value) !== next) host.locale.value = next;
            });
        }
        return {
            t: (key: string, ...params: unknown[]) => {
                if (key === null || key === undefined) return "";
                if (typeof key !== "string") return String(key);
                try {
                    return String(host.t(key, ...params));
                } catch {
                    return key;
                }
            },
            current: host.locale,
            isRtl: computed(() => String(host.locale.value) === "ar"),
        };
    }
    let i18n: ReturnType<typeof useI18n> | null = null;
    try {
        i18n = useI18n({ useScope: "global" }) as any;
    } catch {
        i18n = null;
    }
    if (!i18n) {
        syncDocumentLocale(fallbackLocale.value);
        return {
            t: translate,
            current: fallbackLocale,
            isRtl: computed(() => fallbackLocale.value === "ar"),
        };
    }
    const current = i18n.locale as unknown as { value: string };
    // Keep the document direction and the shared locale store in sync with
    // vue-i18n (the host may set `i18n.locale` directly).
    if (getCurrentInstance()) {
        syncDocumentLocale(String(current.value));
        watch(
            () => String(current.value),
            (next) => syncDocumentLocale(next),
        );
        watch(currentLocale, (next) => {
            if (String(current.value) !== next) current.value = next;
        });
    }
    return {
        t: (key: string, ...params: unknown[]) => {
            if (typeof key !== "string") return key === null || key === undefined ? "" : String(key);
            return String((i18n!.t as any)(key, ...params));
        },
        current,
        isRtl: computed(() => String(i18n!.locale.value) === "ar"),
    };
};

/** Translate outside a component setup; falls back to the key. */
export const t = (key: string, ...params: unknown[]): string => {
    if (key === null || key === undefined) return "";
    try {
        return String((useI18n({ useScope: "global" }).t as any)(key, ...params));
    } catch {
        return String(key);
    }
};
