import vuetify from "@/plugins/vuetify";
import { adaptedLocale } from "@/plugins/localization";

export const drawer = ref(false);

export const toggleDrawer = () => {
    drawer.value = !drawer.value;
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
