import { ref } from "vue";

import { adaptedLocale } from "@/plugins/localization";
import { api } from "@/state/api";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { urlsMap } from "@/constants/urlsMap";

export const drawer = ref(typeof window === "undefined" ? true : window.innerWidth >= 960);

export const toggleDrawer = () => {
    drawer.value = !drawer.value;
};

export type CommunicationMaintenance = {
    active: boolean;
    code: string;
    message: string;
};

export type CommunicationStatus = {
    emailConfigured: boolean;
    smsConfigured: boolean;
    googleEnabled: boolean;
    registrationEnabled: boolean;
    passwordResetEnabled: boolean;
    maintenance: CommunicationMaintenance | null;
};

export type AppInfo = {
    name: string;
    version: string;
    suspended: boolean;
    communication: CommunicationStatus | null;
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
            communication: data?.communication
                ? {
                      emailConfigured: !!data.communication.emailConfigured,
                      smsConfigured: !!data.communication.smsConfigured,
                      googleEnabled: !!data.communication.googleEnabled,
                      registrationEnabled: !!data.communication.registrationEnabled,
                      passwordResetEnabled: !!data.communication.passwordResetEnabled,
                      maintenance: data.communication.maintenance ?? null,
                  }
                : null,
        };
    } catch (error) {
        appStatusError.value = extractApiErrorMessage(error);
    } finally {
        appStatusLoading.value = false;
    }
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
