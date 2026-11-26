import ThemedView from "@/components/ThemedView/index";
import { createSlot } from "vue";
import { dc } from "@/utils/dc";
import _Button from "../_Button/index";
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
                        {createSlot("default")}
                    </_Button>
                </>
            );

            const href = attrs.href;
            return (typeof href == "string" && !!href ? (
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
                            {createSlot("default")}
                        </_Button>
                    </a>
                ) : main);
        };
    },
);

export default Button;
