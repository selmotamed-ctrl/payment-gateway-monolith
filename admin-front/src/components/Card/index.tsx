import { dc } from "kt-dc";
import type { StyleValue } from "vue";
import { useDisplay } from "vuetify";

const Card = dc(
    (
        props: {
            noElevation?: boolean;
            externalHref?: boolean;
            href?: string | (() => string);
            style?: StyleValue;
            onClick?: () => void | Promise<void>;
        },
        _,
        ctx,
    ) => {
        const display = useDisplay();
        return () => {
            const isMobile = display.mobile.value;
            const slots = ctx.slots;
            const attrs = ctx.attrs;
            return (
                <>
                    <ThemedView
                        {...attrs}
                        href={typeof props.href == "function" ? props.href() : props.href}
                        onClick={props.onClick}
                        style={[
                            {
                                padding: isMobile ? "14px" : "20px",
                                background: "var(--pg-bg-surface)",
                                borderRadius: "var(--pg-radius-md)",
                                border: "1px solid var(--pg-border-subtle)",
                                gap: "18px",
                                boxShadow: props.noElevation ? undefined : "var(--pg-shadow-xs)",
                            },
                            props.style,
                        ]}
                    >
                        {slots.default?.()}
                    </ThemedView>
                </>
            );
        };
    },
    {
        slots: ["default"],
        props: ["noElevation", "style", "href", "onClick", "externalHref"],
    },
);

export default Card;
