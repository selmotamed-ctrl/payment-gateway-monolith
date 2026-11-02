import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import { createVuetify } from "vuetify";
import { mdi, aliases } from "vuetify/iconsets/mdi";

export default createVuetify({
  theme: {
    defaultTheme: "dark",
    themes: {
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
