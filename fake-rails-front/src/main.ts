import { createApp } from "vue";
import { createVuetify } from "vuetify";
import App from "./App";
import router from "./router";
import vuetify from "./plugins/vuetify";
import "./styles/settings.scss";

const app = createApp(App);
app.use(vuetify as ReturnType<typeof createVuetify>);
app.use(router);
app.mount("#app");
