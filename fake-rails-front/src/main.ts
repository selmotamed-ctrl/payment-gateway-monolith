import { createApp } from "vue";
import { createVuetify } from "vuetify";
import App from "./App";
import router from "./router";
import vuetify from "./plugins/vuetify";
import { initTheme } from "./state/theme";
import "./styles/settings.scss";
import "./assets/fonts/fonts.css";
import "./styles/fintech-minimal.css";

const app = createApp(App);
app.use(vuetify as ReturnType<typeof createVuetify>);
app.use(router);
initTheme();
app.mount("#app");
