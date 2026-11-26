import { computed, ref, type ComputedRef } from "vue";
import { resolvedTheme } from "@/state/theme";
import { i18n } from "@/plugins/i18n";

/**
 * Compatibility layer for the Vuetify composables used across the portals.
 * The application keeps its existing calls (`useLocale`, `useDisplay`,
 * `useTheme`, `useRtl`) while the implementation no longer depends on Vuetify.
 */

export type IconProps = {
    icon?: string;
    size?: string | number;
    color?: string;
    class?: string;
    style?: unknown;
};

type LocaleLike = {
    t: (key: string, ...params: unknown[]) => string;
    current: { value: string };
    isRtl: ComputedRef<boolean>;
};

const locale = i18n.global.locale;

export const useLocale = (): LocaleLike => ({
    t: (key: string, ...params: unknown[]) =>
        String((i18n.global.t as unknown as (...args: unknown[]) => string)(key, ...params)),
    current: locale as unknown as { value: string },
    isRtl: computed(() => locale.value === "ar"),
});

const width = ref(typeof window === "undefined" ? 1280 : window.innerWidth);
let listening = false;
const ensureResize = () => {
    if (listening || typeof window === "undefined") return;
    listening = true;
    window.addEventListener("resize", () => {
        width.value = window.innerWidth;
    });
};

const readDirection = (): boolean =>
    typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";

export const useRtl = () => computed(readDirection);

export const useDisplay = () => {
    ensureResize();
    return {
        width,
        mobile: computed(() => width.value < 600),
        sm: computed(() => width.value >= 600 && width.value < 960),
        md: computed(() => width.value >= 960 && width.value < 1280),
        lg: computed(() => width.value >= 1280 && width.value < 1920),
        xl: computed(() => width.value >= 1920),
        smAndDown: computed(() => width.value < 960),
        smAndUp: computed(() => width.value >= 600),
        mdAndDown: computed(() => width.value < 1280),
        mdAndUp: computed(() => width.value >= 960),
        lgAndUp: computed(() => width.value >= 1280),
    };
};

const LIGHT_COLORS = {
    background: "#f8fafc",
    surface: "#ffffff",
    primary: "#0f172a",
    secondary: "#2563eb",
    accent: "#2563eb",
    success: "#16a34a",
    warning: "#d97706",
    error: "#dc2626",
    info: "#2563eb",
    onSurface: "#0f172a",
    onSurfaceVariant: "#64748b",
    onBackground: "#0f172a",
    outlineVariant: "#cbd5e1",
};

const DARK_COLORS = {
    background: "#09090b",
    surface: "#121215",
    primary: "#f8fafc",
    secondary: "#a1a1aa",
    accent: "#60a5fa",
    success: "#4ade80",
    warning: "#fbbf24",
    error: "#f87171",
    info: "#60a5fa",
    onSurface: "#f8fafc",
    onSurfaceVariant: "#a1a1aa",
    onBackground: "#f8fafc",
    outlineVariant: "#3f3f46",
};

const current = computed(() => ({
    dark: resolvedTheme.value === "dark",
    colors: resolvedTheme.value === "dark" ? DARK_COLORS : LIGHT_COLORS,
}));

export const useTheme = () => ({
    current,
    global: { current },
    change: () => undefined,
});
