import vuetify from "@/plugins/vuetify";
import { adaptedLocale } from "@/plugins/localization";
import { api } from "@/state/api";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { urlsMap } from "@/constants/urlsMap";

export const drawer = ref(!vuetify.display.mobile.value);

export const toggleDrawer = () => {
    drawer.value = !drawer.value;
};

export type AppInfo = {
    name: string;
    version: string;
    suspended: boolean;
};

export const appInfo = ref<AppInfo | null>(null);
export const appStatusLoading = ref(false);
export const appStatusError = ref<string | null>(null);

export const loadAppStatus = async () => {
    appStatusLoading.value = true;
    appStatusError.value = null;
    try {
        const response = await api.get(urlsMap.profileMe);
        const data = response.data?.data ?? response.data ?? {};
        appInfo.value = {
            name: data?.platformName ?? "Payment Gateway",
            version: data?.version ?? "",
            suspended: !!data?.suspended,
        };
    } catch (error) {
        appStatusError.value = extractApiErrorMessage(error);
    } finally {
        appStatusLoading.value = false;
    }
};

export {
    activeEnvironment,
    isSandboxEnvironment,
    setActiveEnvironment,
    type PgEnvironment,
} from "@/state/environment";

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
