import { defineComponent, type VNodeChild } from "vue";

export const ScreenContainer = defineComponent({
  name: "ScreenContainer",
  setup(_props, { slots }) {
    return (): VNodeChild => <div class="pg-page pg-screen-container">{slots.default?.()}</div>;
  },
});

export default ScreenContainer;
