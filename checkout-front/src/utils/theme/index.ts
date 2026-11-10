/**
 * Theme mode: the user can follow the operating system (`system`) or pin
 * `light`/`dark`. The resolved theme is what Vuetify renders.
 *
 * This module is pure (no Vuetify import) so `plugins/vuetify.ts` can use
 * `initialTheme()` for `defaultTheme` before the app is mounted, avoiding a
 * light flash when the OS prefers dark. The reactive wrapper lives in
 * `@/state/theme`.
 */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const isThemeMode = (value: unknown): value is ThemeMode =>
    value === "system" || value === "light" || value === "dark";

/** The persisted mode; an old `light`/`dark` value is still valid, absent means `system`. */
export const readThemeMode = (): ThemeMode => {
    if (typeof window === "undefined") {
        return "system";
    }
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "system";
};

export const systemPrefersDark = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(DARK_MEDIA_QUERY).matches
        : false;

export const resolveTheme = (mode: ThemeMode): ResolvedTheme =>
    mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;

/** The theme to use for Vuetify's `defaultTheme` before any component renders. */
export const initialTheme = (): ResolvedTheme => resolveTheme(readThemeMode());
