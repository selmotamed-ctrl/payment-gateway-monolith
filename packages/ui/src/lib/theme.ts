import { computed, ref } from "vue";

/**
 * Shared theme state for every portal. The host app calls `initTheme()` before
 * mounting, so login and every route start with the resolved theme on the first
 * paint. `system` follows the OS live and every tab stays in sync.
 */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const isThemeMode = (value: unknown): value is ThemeMode =>
    value === "system" || value === "light" || value === "dark";

export const readThemeMode = (): ThemeMode => {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "system";
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
    themeMode.value = mode;
    if (typeof window !== "undefined") window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    apply(mode);
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
        if (event.key !== THEME_STORAGE_KEY) return;
        const next = isThemeMode(event.newValue) ? event.newValue : "system";
        themeMode.value = next;
        apply(next);
    });
};

const LIGHT_COLORS = {
    background: "#f7f8fa",
    surface: "#ffffff",
    primary: "#0f172a",
    secondary: "#475569",
    accent: "#4f46e5",
    success: "#16a34a",
    warning: "#d97706",
    error: "#dc2626",
    info: "#2563eb",
    onSurface: "#0f172a",
    onSurfaceVariant: "#64748b",
    onBackground: "#0f172a",
    outlineVariant: "#d1d5db",
};

const DARK_COLORS = {
    background: "#09090b",
    surface: "#111114",
    primary: "#f4f4f5",
    secondary: "#a1a1aa",
    accent: "#6366f1",
    success: "#4ade80",
    warning: "#fbbf24",
    error: "#f87171",
    info: "#60a5fa",
    onSurface: "#f4f4f5",
    onSurfaceVariant: "#71717a",
    onBackground: "#f4f4f5",
    outlineVariant: "#32323a",
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

export const getTheme = (): ResolvedTheme => resolvedTheme.value;
