import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import { createVuetify } from "vuetify";
import { mdi, aliases } from "vuetify/iconsets/mdi";

export default createVuetify({
  theme: {
    defaultTheme: "portal",
    themes: {
      portal: {
        dark: true,
        colors: {
          primary: "#38bdf8",
          secondary: "#1e293b",
          accent: "#22d3ee",
          error: "#f87171",
          info: "#60a5fa",
          success: "#34d399",
          warning: "#fbbf24",
          background: "#0b1220",
          surface: "#111c30",
          "surface-variant": "#17243a",
          "on-surface": "#e5edf8",
          "on-surface-variant": "#9fb0c6",
          "on-background": "#e5edf8",
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: "lg", elevation: 0, style: "text-transform:none;font-weight:700" },
    VCard: { rounded: "lg", elevation: 0 },
    VTextField: { variant: "outlined", density: "comfortable" },
    VSelect: { variant: "outlined", density: "comfortable" },
    VSlider: { color: "primary" },
  },
  icons: { defaultSet: "mdi", sets: { mdi }, aliases },
});
