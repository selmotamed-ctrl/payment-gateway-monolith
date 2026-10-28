import { dc } from "kt-dc";

/**
 * The page content surface.
 *
 * It is a plain block container (no `flex: 1` on a non-flex parent) with the
 * shared max width and responsive padding. The shell owns the layout; pages
 * only supply their content.
 */
const ScreenContainer = dc(
    (_, __, { slots }) => {
        return () => <div class="pg-page">{slots.default?.()}</div>;
    },
    { slots: ["default"] },
);

export default ScreenContainer;
