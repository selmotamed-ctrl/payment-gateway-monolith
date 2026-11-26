import { createSlot } from "vue";
import { dc } from "@/utils/dc";

/**
 * The page content surface.
 *
 * `.pg-page` stays on the root for existing page-level selectors while
 * `.pg-screen-container` guarantees the v2 desktop/mobile padding.
 */
const ScreenContainer = dc(
    (_, __, { slots }) => {
        return () => <div class="pg-page pg-screen-container">{createSlot("default")}</div>;
    },
    { slots: ["default"] },
);

export default ScreenContainer;
