import { createSlot } from "vue";
import { VBtn } from "@/components/vael/VuetifyShim";
import { dc } from "@/utils/dc";

/**
 * Vapor wrapper around Vuetify's button. Vuetify remains Virtual DOM; this
 * component keeps the application side of the boundary in Vapor.
 */
const _Button = dc((props: any, _expose, { attrs }) => {
    return () => (
        <VBtn {...attrs} {...props}>
            {createSlot("default")}
        </VBtn>
    );
});

export default _Button;
