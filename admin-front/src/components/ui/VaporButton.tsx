import { createSlot } from "vue";
import { VBtn } from "vuetify/components";
import { dc } from "@/utils/dc";
export const VaporButton = dc((props: any) => () => <VBtn {...props}>{createSlot("default")}</VBtn>);
export default VaporButton;
