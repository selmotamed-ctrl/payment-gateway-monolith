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
            <main class="pg-checkout">
                {props.title && (
                    <h1 class="pg-checkout__title" style={{ margin: 0 }}>
                        {props.title}
                    </h1>
                )}
                {slots.default?.()}
            </main>
        );
    },
    {
        slots: ["default"],
        props: ["title"],
    },
);

export default CheckoutLayout;
