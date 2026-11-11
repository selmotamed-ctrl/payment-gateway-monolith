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
import { adaptedLocale } from "@/plugins/localization";
import { getLocaleName } from "@/plugins/i18n";

// Composables
import { createVuetify } from "vuetify";
import { mdi, aliases } from "vuetify/iconsets/mdi";
import { Icons, IconsSet } from "@/utils/iconSet/index";
import { initialTheme } from "@/utils/theme";

export default createVuetify({
    theme: {
        defaultTheme: initialTheme(),
        themes: {
            light: {
                dark: false,
                colors: {
                    background: "#F8FAFC",
                    surface: "#FFFFFF",
                    primary: "#0F172A",
                    secondary: "#2563EB",
                    accent: "#2563EB",
                    success: "#16A34A",
                    warning: "#D97706",
                    error: "#DC2626",
                    info: "#2563EB",
                    "surface-variant": "#F1F5F9",
                    "on-surface": "#0F172A",
                    "on-surface-variant": "#64748B",
                    "on-background": "#0F172A",
                },
            },
            dark: {
                dark: true,
                colors: {
                    background: "#09090B",
                    surface: "#121215",
                    primary: "#F8FAFC",
                    secondary: "#3B82F6",
                    accent: "#3B82F6",
                    success: "#22C55E",
                    warning: "#F59E0B",
                    error: "#EF4444",
                    info: "#3B82F6",
                    "surface-variant": "#18181C",
                    "on-surface": "#F8FAFC",
                    "on-surface-variant": "#A1A1AA",
                    "on-background": "#F8FAFC",
                },
            },
        },
    },
    defaults: {
        global: { ripple: false },
        VCard: { elevation: 0, rounded: "lg" },
        VBtn: {
            elevation: 0,
            rounded: "md",
            height: 36,
            class: "text-none font-weight-medium",
        },
        VTextField: {
            variant: "outlined",
            density: "compact",
            color: "primary",
            hideDetails: "auto",
        },
        VSelect: {
            variant: "outlined",
            density: "compact",
            color: "primary",
            hideDetails: "auto",
        },
        VAutocomplete: {
            variant: "outlined",
            density: "compact",
            color: "primary",
            hideDetails: "auto",
        },
        VTextarea: {
            variant: "outlined",
            density: "compact",
            color: "primary",
            hideDetails: "auto",
        },
        VCombobox: {
            variant: "outlined",
            density: "compact",
            color: "primary",
            hideDetails: "auto",
        },
        VChip: {
            rounded: "md",
            size: "small",
            elevation: 0,
        },
        VDialog: {
            scrim: "rgba(15, 23, 42, 0.45)",
        },
    },
    locale: {
        rtl: {
            ar: true,
            en: false,
        },
        locale: getLocaleName(),
        fallback: "en",
        adapter: adaptedLocale,
    },
    blueprint: {
        defaults: {
            VDateInput: {
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
