import { createSlot } from "vue";
import { VBtn } from "@/components/vael/VuetifyShim";
import { dc } from "@/utils/dc";
export const VaporButton = dc((props: any) => () => <VBtn {...props}>{createSlot("default")}</VBtn>);
export default VaporButton;
