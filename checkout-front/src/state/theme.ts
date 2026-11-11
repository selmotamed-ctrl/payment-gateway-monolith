import { computed, ref } from "vue";
import vuetify from "@/plugins/vuetify";
import {
    DARK_MEDIA_QUERY,
    THEME_STORAGE_KEY,
    isThemeMode,
    readThemeMode,
    resolveTheme,
    systemPrefersDark,
    type ResolvedTheme,
    type ThemeMode,
} from "@/utils/theme";

export type { ResolvedTheme, ThemeMode };

/** The selected mode (`system` follows the OS). */
export const themeMode = ref<ThemeMode>(readThemeMode());

/** The current OS preference; kept live while the page is open. */
const systemDark = ref(systemPrefersDark());

/** The concrete theme Vuetify renders (`light` or `dark`). */
export const resolvedTheme = computed<ResolvedTheme>(() =>
    themeMode.value === "system" ? (systemDark.value ? "dark" : "light") : themeMode.value,
);

const apply = (mode: ThemeMode) => {
    if (typeof window === "undefined") {
        return;
    }
    vuetify.theme.change(resolveTheme(mode));
};

/** Persist and apply a mode. */
export const setThemeMode = (mode: ThemeMode) => {
    themeMode.value = mode;
    if (typeof window !== "undefined") {
        window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
    apply(mode);
};

/**
 * Cycle used by the compact buttons: system -> light -> dark -> system.
 * Explicit menus call `setThemeMode` directly.
 */
export const toggleTheme = () => {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(themeMode.value) + 1) % order.length] ?? "system";
    setThemeMode(next);
};

let media: MediaQueryList | null = null;
let initialized = false;

/**
 * Apply the persisted mode and keep `system` live while the OS preference
 * changes. Called from `main.ts` before `app.mount`, so every route (including
 * the login pages) starts with the correct theme.
 */
export const initTheme = () => {
    if (typeof window === "undefined") {
        return;
    }
    themeMode.value = readThemeMode();
    systemDark.value = systemPrefersDark();
    apply(themeMode.value);
    if (initialized || typeof window.matchMedia !== "function") {
        return;
    }
    initialized = true;
    media = window.matchMedia(DARK_MEDIA_QUERY);
    const onSystemChange = (event: MediaQueryListEvent) => {
        systemDark.value = event.matches;
        if (themeMode.value === "system") {
            apply("system");
        }
    };
    if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onSystemChange);
    } else {
        // Safari < 14
        media.addListener(onSystemChange);
    }
    window.addEventListener("storage", (event) => {
        if (event.key !== THEME_STORAGE_KEY) {
            return;
        }
        const next = isThemeMode(event.newValue) ? event.newValue : "system";
        themeMode.value = next;
        apply(next);
    });
};

/** Compatibility helpers for older callers. */
export const getTheme = (): ResolvedTheme => resolvedTheme.value;
export const setTheme = (theme: ResolvedTheme) => setThemeMode(theme);
