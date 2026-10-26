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

export const getTheme = (): "light" | "dark" => {
    if (typeof window !== "undefined") {
        const saved = localStorage.getItem("theme");
        if (saved === "light" || saved === "dark") {
            return saved;
        }
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
            return "dark";
        }
    }
    return "light";
};

export const doArabic = (arabic: null | undefined | string, fallback: string) => {
    if (isArabic()) {
        return arabic || fallback;
    }
    return fallback;
};

export const isArabic = () => {
    return adaptedLocale.current.value == "ar";
};

export const setTheme = (theme: "light" | "dark") => {
    if (typeof window !== "undefined") {
        localStorage.setItem("theme", theme);
        vuetify.theme.change(theme);
    }
};

export const toggleTheme = () => {
    const current = vuetify.theme.global.name.value;
    const newTheme = current === "light" ? "dark" : "light";
    setTheme(newTheme);
};

if (typeof window !== "undefined") {
    const initialTheme = getTheme();
    vuetify.theme.change(initialTheme);
}
