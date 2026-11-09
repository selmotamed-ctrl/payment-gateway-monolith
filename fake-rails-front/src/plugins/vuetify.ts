import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import { createVuetify } from "vuetify";
import { mdi, aliases } from "vuetify/iconsets/mdi";
import { initialTheme } from "@/utils/theme";

export default createVuetify({
  theme: {
    defaultTheme: initialTheme(),
    themes: {
      light: {
        dark: false,
        colors: {
          primary: "#2563eb",
          secondary: "#64748b",
          accent: "#3b82f6",
          error: "#dc2626",
          info: "#2563eb",
          success: "#16a34a",
          warning: "#d97706",
          background: "#f8fafc",
          surface: "#ffffff",
          "surface-variant": "#f1f5f9",
          "on-surface": "#0f172a",
          "on-surface-variant": "#64748b",
          "on-background": "#0f172a",
        },
      },
      dark: {
        dark: true,
        colors: {
          primary: "#3b82f6",
          secondary: "#a1a1aa",
          accent: "#60a5fa",
          error: "#f87171",
          info: "#60a5fa",
          success: "#4ade80",
          warning: "#fbbf24",
          background: "#09090b",
          surface: "#121215",
          "surface-variant": "#18181c",
          "on-surface": "#f8fafc",
          "on-surface-variant": "#a1a1aa",
          "on-background": "#f8fafc",
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: "sm", elevation: 0, style: "text-transform:none;font-weight:500" },
    VCard: { rounded: "md", elevation: 0 },
    VTextField: { variant: "outlined", density: "compact" },
    VSelect: { variant: "outlined", density: "compact" },
    VSlider: { color: "primary" },
  },
  icons: { defaultSet: "mdi", sets: { mdi }, aliases },
});
