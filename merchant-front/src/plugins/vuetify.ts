/**
 * plugins/vuetify.ts
 *
 * Framework documentation: https://vuetifyjs.com`
 */

// Styles
import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";

import colors from "vuetify/util/colors";
export { colors };
import { adaptedLocale, getLocaleName } from "./localization";

// Composables
import { createVuetify } from "vuetify";
import { mdi, aliases } from "vuetify/iconsets/mdi";
import { Icons, IconsSet } from "@/utils/iconSet/index";

export default createVuetify({
    theme: {
        defaultTheme: "light",
        themes: {
            light: {
                dark: false,
                colors: {
                    primary: "#0f6bff",
                    secondary: "#0f172a",
                    accent: "#00b8a9",
                    error: "#dc2626",
                    info: "#2563eb",
                    success: "#059669",
                    warning: "#d97706",
                    background: "#f4f7fb",
                    surface: "#ffffff",
                    "surface-variant": "#eef3f9",
                    "on-surface": "#111827",
                    "on-surface-variant": "#64748b",
                    "on-background": "#111827",
                },
            },
            dark: {
                dark: true,
                colors: {
                    primary: "#5ea1ff",
                    secondary: "#cbd5e1",
                    accent: "#2dd4bf",
                    error: "#f87171",
                    info: "#7dd3fc",
                    success: "#34d399",
                    warning: "#fbbf24",
                    background: "#08111f",
                    surface: "#0f1b2d",
                    "surface-variant": "#17243a",
                    "on-surface": "#e5edf8",
                    "on-surface-variant": "#9fb0c6",
                    "on-background": "#e5edf8",
                },
            },
        },
    },
    defaults: {
        VBtn: {
            color: "primary",
            rounded: "lg",
            elevation: 0,
            style: "text-transform: none; font-weight: 700; letter-spacing: 0;",
        },
        VCard: {
            elevation: 0,
            rounded: "lg",
        },
        VMenu: {
            offset: 10,
        },
        VList: {
            density: "comfortable",
        },
        global: {
            ripple: false,
        },
    },
    locale: {
        rtl: {
            ar: true,
            en: false,
        },
        locale: getLocaleName(),
        adapter: adaptedLocale,
    },
    blueprint: {
        defaults: {
            VTextField: {
                variant: "outlined",
            },
            VAutocomplete: {
                variant: "outlined",
            },
            VDateInput: {
                variant: "outlined",
            },
            VCombobox: {
                variant: "outlined",
            },
        },
    },
    icons: {
        defaultSet: "mdi",
        sets: {
            mdi,
            i: IconsSet,
        },
        aliases: {
            ...aliases,
            ...Icons,
        },
    },
});
