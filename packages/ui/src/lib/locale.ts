import { computed, ref, type ComputedRef } from "vue";
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

const fallbackLocale = ref("en");

/**
 * Locale adapter for every `@pg/ui` primitive. The host portal installs
 * `vue-i18n` globally; the adapter keeps the old `useLocale()` contract used by
 * page components (`t`, `current`, `isRtl`).
 */
export const useLocale = (): LocaleLike => {
    let i18n: ReturnType<typeof useI18n> | null = null;
    try {
        i18n = useI18n({ useScope: "global" }) as any;
    } catch {
        i18n = null;
    }
    if (!i18n) {
        return {
            t: (key: string) => String(key ?? ""),
            current: fallbackLocale,
            isRtl: computed(() => fallbackLocale.value === "ar"),
        };
    }
    return {
        t: (key: string, ...params: unknown[]) => {
            if (typeof key !== "string") return String(key ?? "");
            return String((i18n!.t as any)(key, ...params));
        },
        current: i18n.locale as unknown as { value: string },
        isRtl: computed(() => String(i18n!.locale.value) === "ar"),
    };
};

/** Translate outside a component setup; falls back to the key. */
export const t = (key: string, ...params: unknown[]): string => {
    try {
        return String((useI18n({ useScope: "global" }).t as any)(key, ...params));
    } catch {
        return String(key ?? "");
    }
};
