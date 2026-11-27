(BigInt as any).prototype.toJSON = function () {
  return this.toString();
};

import { registerPlugins } from "@/plugins";
import {initTheme} from "@pg/ui";

import { createVaporApp } from "vue";
import { formPlugin } from "vael-form";
import { i18n } from "@/plugins/i18n";
import App from "./App";

import "@/assets/fonts/fonts.css";
import "@pg/ui/tokens/index.css";
import "@/styles/command-palette.css";
import "@/styles/guide.css";
import "@/styles/academy/index.css";

const app = createVaporApp(App);
app.use(formPlugin, {
    i18n: { t: i18n.global.t, locale: i18n.global.locale },
    showErrors: "edited",
});
registerPlugins(app);
initTheme();
app.mount("#app");
