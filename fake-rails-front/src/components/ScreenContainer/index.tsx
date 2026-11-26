import { type VNodeChild, createSlot } from "vue";
import { defineComponent } from "@/utils/dc";

export const ScreenContainer = defineComponent({
  name: "ScreenContainer",
  setup(_props, { slots }) {
    return (): VNodeChild => <div class="pg-page pg-screen-container">{createSlot("default")}</div>;
  },
});

export default ScreenContainer;
