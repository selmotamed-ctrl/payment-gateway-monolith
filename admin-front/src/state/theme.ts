import {setThemeMode, type ResolvedTheme} from "@pg/ui";

export {
    DARK_MEDIA_QUERY,
    THEME_STORAGE_KEY,
    getTheme,
    initTheme,
    isThemeMode,
    readThemeMode,
    resolvedTheme,
    resolveTheme,
    setThemeMode,
    systemPrefersDark,
    themeMode,
    toggleTheme,
} from "@pg/ui";
export type { ResolvedTheme, ThemeMode } from "@pg/ui";

/** Compatibility helper for older callers. */
export const setTheme = (theme: ResolvedTheme) => setThemeMode(theme);
