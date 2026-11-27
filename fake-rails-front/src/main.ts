import { createVaporApp } from "vue";
import { formPlugin } from "vael-form";
import { i18n } from "./plugins/i18n";
import App from "./App";
import router from "./router";
import { initTheme } from "./state/theme";
import "./assets/fonts/fonts.css";
import "@pg/ui/tokens/index.css";

const app = createVaporApp(App);
app.use(i18n);
app.use(formPlugin, { showErrors: "edited", i18n: { t: i18n.global.t, locale: i18n.global.locale } });
app.use(router);
initTheme();
app.mount("#app");
