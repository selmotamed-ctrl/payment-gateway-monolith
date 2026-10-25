import { dc } from "kt-dc";
import type { StyleValue } from "vue";
import { useDisplay, useTheme } from "vuetify";

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
        const theme = useTheme();
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
                                background: theme.current.value.dark
                                    ? "linear-gradient(180deg, rgba(15, 27, 45, 0.96), rgba(13, 24, 40, 0.96))"
                                    : "linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 251, 255, 0.98))",
                                borderRadius: isMobile ? "12px" : "16px",
                                border: theme.current.value.dark ? "1px solid rgba(226, 232, 240, 0.09)" : "1px solid rgba(15, 23, 42, 0.08)",
                                gap: "18px",
                                boxShadow: props.noElevation
                                    ? undefined
                                    : theme.current.value.dark
                                      ? "0 18px 50px rgba(0, 0, 0, 0.28)"
                                      : "0 16px 42px rgba(15, 23, 42, 0.07)",
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
