import { dc } from "kt-dc";
import _Button from "../_Button/index.vue";
import { VIcon } from "vuetify/components";
import { useLocale } from "vuetify";

const Button = dc(
    (
        _props: InstanceType<typeof _Button>["$props"] & {
            label?: string;
            iconName?: string;
            href?: string;
        },
        _,
        { attrs, slots },
    ) => {
        const { t, isRtl } = useLocale();
        return () => {
            const main = (
                <>
                    <_Button {...attrs} onClick={attrs.onClick! as any}>
                        {(attrs.label || attrs.iconName) && (
                            <>
                                <ThemedView
                                    style={{
                                        flexDirection: "row",
                                        gap: "12px",
                                        alignItems: "center",
                                    }}
                                >
                                    {attrs.iconName && (
                                        <VIcon
                                            style={{
                                                transform: isRtl.value ? "scaleX(-1)" : undefined,
                                            }}
                                        >
                                            {attrs.iconName}
                                        </VIcon>
                                    )}
                                    {typeof attrs.label == "string" && <ThemedView>{t(attrs.label)}</ThemedView>}
                                </ThemedView>
                            </>
                        )}
                        {slots.default?.()}
                    </_Button>
                </>
            );

            const href = attrs.href;
            if (typeof href == "string" && !!href) {
                return (
                    <a
                        onClick={(e) => {
                            if (attrs.onClick) {
                                e.preventDefault();
                            }
                        }}
                        style={{
                            textDecoration: "none",
                        }}
                        href={href}
                    >
                        <_Button {...attrs} onClick={attrs.onClick! as any}>
                            {(attrs.label || attrs.iconName) && (
                                <>
                                    <ThemedView
                                        style={{
                                            flexDirection: "row",
                                            gap: "12px",
                                            alignItems: "center",
                                        }}
                                    >
                                        {attrs.iconName && (
                                            <VIcon
                                                style={{
                                                    transform: isRtl.value ? "scaleX(-1)" : undefined,
                                                }}
                                            >
                                                {attrs.iconName}
                                            </VIcon>
                                        )}
                                        {typeof attrs.label == "string" && <ThemedView>{t(attrs.label)}</ThemedView>}
                                    </ThemedView>
                                </>
                            )}
                            {slots.default?.()}
                        </_Button>
                    </a>
                );
            }

            return main;
        };
    },
);

export default Button;
