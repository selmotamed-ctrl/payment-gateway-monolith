import { computed, ref } from "vue";

/**
 * Shared theme state for every portal. The host app calls `initTheme()` before
 * mounting, so login and every route start with the resolved theme on the first
 * paint. `system` follows the OS live and every tab stays in sync.
 */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "pg-theme";
/** Legacy key kept readable so an existing operator choice survives the upgrade. */
const LEGACY_THEME_STORAGE_KEY = "theme";
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const isThemeMode = (value: unknown): value is ThemeMode =>
    value === "system" || value === "light" || value === "dark";

export const readThemeMode = (): ThemeMode => {
    if (typeof window === "undefined") return "system";
    try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (isThemeMode(stored)) return stored;
        const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
        if (isThemeMode(legacy)) return legacy;
    } catch {
        /* storage unavailable */
    }
    return "system";
};

export const systemPrefersDark = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(DARK_MEDIA_QUERY).matches
        : false;

export const resolveTheme = (mode: ThemeMode): ResolvedTheme =>
    mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;

export const initialTheme = (): ResolvedTheme => resolveTheme(readThemeMode());

export const themeMode = ref<ThemeMode>(readThemeMode());
const systemDark = ref(systemPrefersDark());

export const resolvedTheme = computed<ResolvedTheme>(() =>
    themeMode.value === "system" ? (systemDark.value ? "dark" : "light") : themeMode.value,
);

const apply = (mode: ThemeMode) => {
    if (typeof window === "undefined") return;
    const resolved = resolveTheme(mode);
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.classList.toggle("v-theme--dark", resolved === "dark");
    document.documentElement.classList.toggle("v-theme--light", resolved !== "dark");
    document.querySelectorAll(".v-application").forEach((element) => {
        element.classList.toggle("v-theme--dark", resolved === "dark");
        element.classList.toggle("v-theme--light", resolved !== "dark");
    });
};

export const setThemeMode = (mode: ThemeMode) => {
    const next = isThemeMode(mode) ? mode : "system";
    themeMode.value = next;
    if (typeof window !== "undefined") {
        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
            /* storage unavailable */
        }
    }
    apply(next);
};

export const toggleTheme = () => {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(themeMode.value) + 1) % order.length] ?? "system";
    setThemeMode(next);
};

let media: MediaQueryList | null = null;
let initialized = false;

export const initTheme = () => {
    if (typeof window === "undefined") return;
    themeMode.value = readThemeMode();
    systemDark.value = systemPrefersDark();
    apply(themeMode.value);
    if (initialized || typeof window.matchMedia !== "function") return;
    initialized = true;
    media = window.matchMedia(DARK_MEDIA_QUERY);
    const onSystemChange = (event: MediaQueryListEvent) => {
        systemDark.value = event.matches;
        if (themeMode.value === "system") apply("system");
    };
    if (typeof media.addEventListener === "function") media.addEventListener("change", onSystemChange);
    else media.addListener(onSystemChange);
    window.addEventListener("storage", (event) => {
        if (event.key !== THEME_STORAGE_KEY && event.key !== LEGACY_THEME_STORAGE_KEY) return;
        const next = isThemeMode(event.newValue) ? event.newValue : "system";
        themeMode.value = next;
        apply(next);
    });
};

/**
 * Reads a live `--pg-*` custom property so the JS-side bridge can never drift
 * from the single CSS token source.
 */
export const readToken = (name: string, fallback: string): string => {
    if (typeof window === "undefined" || typeof document === "undefined") return fallback;
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    } catch {
        return fallback;
    }
};

const palette = computed(() => {
    const dark = resolvedTheme.value === "dark";
    return {
        background: readToken("--pg-bg-canvas", dark ? "#09090b" : "#f7f8fa"),
        surface: readToken("--pg-bg-surface", dark ? "#111114" : "#ffffff"),
        primary: readToken("--pg-accent-primary", dark ? "#f4f4f5" : "#0f172a"),
        secondary: readToken("--pg-ink-secondary", dark ? "#a1a1aa" : "#475569"),
        accent: readToken("--pg-accent-brand", dark ? "#6366f1" : "#4f46e5"),
        success: readToken("--pg-status-success-dot", dark ? "#22c55e" : "#16a34a"),
        warning: readToken("--pg-status-warning-dot", dark ? "#f59e0b" : "#d97706"),
        error: readToken("--pg-status-danger-dot", dark ? "#ef4444" : "#dc2626"),
        info: readToken("--pg-status-info-dot", dark ? "#3b82f6" : "#2563eb"),
        onSurface: readToken("--pg-ink-primary", dark ? "#f4f4f5" : "#0f172a"),
        onSurfaceVariant: readToken("--pg-ink-muted", dark ? "#71717a" : "#64748b"),
        onBackground: readToken("--pg-ink-primary", dark ? "#f4f4f5" : "#0f172a"),
        outlineVariant: readToken("--pg-border-default", dark ? "#32323a" : "#d1d5db"),
    };
});

/** vael-ui compatibility theme derived from the CSS tokens. */
export const useTheme = () => ({
    current: computed(() => ({ dark: resolvedTheme.value === "dark", colors: palette.value })),
    global: { current: computed(() => ({ dark: resolvedTheme.value === "dark", colors: palette.value })) },
    change: () => undefined,
});

export const getTheme = (): ResolvedTheme => resolvedTheme.value;
