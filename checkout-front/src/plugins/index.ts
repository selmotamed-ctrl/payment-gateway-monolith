import vuetify from "./vuetify.ts";
import router from "../router";
import { i18n } from "./i18n";

export function registerPlugins(app: any) {
    app.use(i18n).use(vuetify).use(router);
}
