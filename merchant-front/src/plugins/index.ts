import vuetify from "./vuetify.ts";
import router from "../router";

// Types
import type { App } from "vue";

import "viewerjs/dist/viewer.css";
import VueViewer from "v-viewer";
export function registerPlugins(app: App) {
    app.use(VueViewer).use(vuetify).use(router);
}
