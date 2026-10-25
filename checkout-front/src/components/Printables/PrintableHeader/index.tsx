import { dc } from "kt-dc";
import { useLocale, useTheme } from "vuetify";
import { VIcon } from "vuetify/components";
import { PrintableThemedView } from "../PrintableThemedView.tsx";

export type HeaderProps = {
    text: string;
    size?: "small" | "medium" | "large" | "xlarge";
    weight?: "normal" | "medium" | "semibold" | "bold";
    align?: "left" | "center" | "right";
    color?: string;
    icon?: string;
    iconPosition?: "left" | "right";
    underline?: boolean;
    marginBottom?: string;
    marginTop?: string;
    letterSpacing?: string;
    textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
};

export const PrintableHeader = dc(

    (props: HeaderProps) => {

        const {t} = useLocale();
        const theme = useTheme();

        return () => {
            const cc = theme.current.value.colors;

            const getFontSize = () => {
                switch (props.size) {
                    case "small":
                        return "18px";
                    case "large":
                        return "28px";
                    case "xlarge":
                        return "32px";
                    case "medium":
                    default:
                        return "24px";
                }
            };

            const getFontWeight = () => {
                switch (props.weight) {
                    case "normal":
                        return "400";
                    case "medium":
                        return "500";
                    case "semibold":
                        return "600";
                    case "bold":
                        return "700";
                    default:
                        return "600";
                }
            };

            const getTextAlign = () => {
                switch (props.align) {
                    case "center":
                        return "center";
                    case "right":
                        return "right";
                    case "left":
                    default:
                        return "left";
                }
            };

            const getTextTransform = () => {
                switch (props.textTransform) {
                    case "uppercase":
                        return "uppercase";
                    case "lowercase":
                        return "lowercase";
                    case "capitalize":
                        return "capitalize";
                    case "none":
                    default:
                        return "none";
                }
            };

            return (
                <>
                    <style>{`
                        @media print {
                            .printable-header {
                                page-break-after: auto !important;
                                page-break-inside: avoid !important;
                                orphans: 3 !important;
                                widows: 3 !important;
                            }
                        }
                    `}</style>
                    <PrintableThemedView
                        class="printable-header"
                        style={{
                            direction: "rtl",
                            display: "flex",
                            flexDirection: "row",
                            alignItems: "center",
                            gap: "12px",
                            marginBottom: props.marginBottom || "24px",
                            marginTop: props.marginTop || "0",
                            width: "100%",
                            ...(props.align === "center" && { justifyContent: "center" }),
                            ...(props.align === "right" && { justifyContent: "flex-end" }),
                        }}
                    >
                        {/* {props.icon && (!props.iconPosition || props.iconPosition === "left") && ( */}
                        <VIcon
                            size={props.size === "xlarge" ? "32" : props.size === "large" ? "28" : "24"}
                            style={{
                                color: props.color || cc.primary,
                                flexShrink: 0,
                                colorAdjust: "exact",
                            }}
                        >
                            {props.icon}
                        </VIcon>
                        {/* )} */}

                        <h1
                            style={{
                                margin: 0,
                                fontSize: getFontSize(),
                                fontWeight: getFontWeight(),
                                color: props.color || cc.onSurface,
                                textAlign: getTextAlign(),
                                letterSpacing: props.letterSpacing || "-0.02em",
                                textTransform: getTextTransform(),
                                textDecoration: props.underline ? "underline" : "none",
                                lineHeight: "1.2",
                                wordBreak: "break-word",
                                flex: 1,
                            }}
                        >
                            {t(props.text)}
                        </h1>

                        {props.icon && props.iconPosition === "right" && (
                            <VIcon
                                size={props.size === "xlarge" ? "32" : props.size === "large" ? "28" : "24"}
                                style={{
                                    color: props.color || cc.primary,
                                    flexShrink: 0,
                                }}
                            >
                                {props.icon}
                            </VIcon>
                        )}
                    </PrintableThemedView>
                </>
            );
        };
    },
    {
        props: ["text", "size", "weight", "align", "color", "icon", "iconPosition", "underline", "marginBottom", "marginTop", "letterSpacing", "textTransform"],
    },
);

export default PrintableHeader;
