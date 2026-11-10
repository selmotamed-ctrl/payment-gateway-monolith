import vuetify from "@/plugins/vuetify";
import { adaptedLocale } from "@/plugins/localization";

export const drawer = ref(false);

export const toggleDrawer = () => {
    drawer.value = !drawer.value;
};

export {
    getTheme,
    initTheme,
    resolvedTheme,
    setTheme,
    setThemeMode,
    themeMode,
    toggleTheme,
} from "@/state/theme";
export type { ResolvedTheme, ThemeMode } from "@/state/theme";
