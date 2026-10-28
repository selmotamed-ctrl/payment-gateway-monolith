import { dc } from "kt-dc";

export type CheckoutLayoutProps = {
    title?: string;
};

/**
 * The payer surface: one focused column, centered on desktop and top-aligned on
 * small screens so a tall form never clips its first field.
 */
const CheckoutLayout = dc(
    (props: CheckoutLayoutProps, _, { slots }) => {
        return () => (
            <div class="pg-checkout">
                {props.title && <div class="pg-checkout__title">{props.title}</div>}
                {slots.default?.()}
            </div>
        );
    },
    {
        slots: ["default"],
        props: ["title"],
    },
);

export default CheckoutLayout;
