(BigInt as any).prototype.toJSON = function () {
  return this.toString();
};


import { registerPlugins } from "@/plugins";

import { createApp } from "vue";
import App from "./App";

import "unfonts.css";


import { VueDatePicker } from '@vuepic/vue-datepicker';
import '@vuepic/vue-datepicker/dist/main.css';


const app = createApp(App);

registerPlugins(app);

app.component('VueDatePicker',VueDatePicker)

app.mount("#app");
