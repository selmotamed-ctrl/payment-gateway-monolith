(BigInt as any).prototype.toJSON = function () {
  return this.toString();
};


import { registerPlugins } from "@/plugins";
import { initTheme } from "@/state/theme";

import { createApp } from "vue";
import App from "./App";

import "@/assets/fonts/fonts.css";
import '@vuepic/vue-datepicker/dist/main.css';
import "@/styles/fintech-minimal.css";


import { VueDatePicker } from '@vuepic/vue-datepicker';


const app = createApp(App);

registerPlugins(app);
initTheme();

app.component('VueDatePicker',VueDatePicker)

app.mount("#app");
