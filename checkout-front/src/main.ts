(BigInt as any).prototype.toJSON = function () {
  return this.toString();
};


import { registerPlugins } from "@/plugins";

import { createApp } from "vue";
import App from "./App";

import "@/assets/fonts/fonts.css";
import '@vuepic/vue-datepicker/dist/main.css';
import "@/styles/fintech-minimal.css";


import { VueDatePicker } from '@vuepic/vue-datepicker';


const app = createApp(App);

registerPlugins(app);

app.component('VueDatePicker',VueDatePicker)

app.mount("#app");
