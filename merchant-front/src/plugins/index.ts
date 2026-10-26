import vuetify from "./vuetify.ts";
import router from "../router";
import { i18n } from "./i18n";

// Types
import type { App } from "vue";

import "viewerjs/dist/viewer.css";
import VueViewer from "v-viewer";

export function registerPlugins(app: App) {
    app.use(i18n).use(VueViewer).use(vuetify).use(router);
}
