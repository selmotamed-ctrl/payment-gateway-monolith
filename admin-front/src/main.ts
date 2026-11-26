(BigInt as any).prototype.toJSON = function () {
  return this.toString();
};

import { registerPlugins } from "@/plugins";
import { initTheme } from "@/state/theme";

import { createVaporApp, vaporInteropPlugin } from "vue";
import App from "./App";

import "@/assets/fonts/fonts.css";
import "@/styles/fintech-minimal.css";
import "@/styles/command-palette.css";
import "@/styles/guide.css";
import "@/styles/academy/index.css";

const app = createVaporApp(App);
app.use(vaporInteropPlugin);
registerPlugins(app);
initTheme();
app.mount("#app");
