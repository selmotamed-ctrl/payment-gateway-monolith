import { dc } from "kt-dc";
import { useTheme } from "vuetify";
import { VIcon } from "vuetify/components";
import { PrintableThemedView } from "../PrintableThemedView.tsx";

export type SubHeaderProps = {
    text: string;
    size?: "small" | "medium" | "large";
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
    opacity?: number;
};

export const PrintableSubHeader = dc(
    (props: SubHeaderProps) => {
        const theme = useTheme();

        return () => {
            const cc = theme.current.value.colors;

            const getFontSize = () => {
                switch (props.size) {
                    case "small": return "14px";
                    case "large": return "20px";
                    case "medium":
                    default: return "16px";
                }
            };

            const getFontWeight = () => {
                switch (props.weight) {
                    case "normal": return "400";
                    case "medium": return "500";
                    case "semibold": return "600";
                    case "bold": return "700";
                    default: return "500";
                }
            };

            const getTextAlign = () => {
                switch (props.align) {
                    case "center": return "center";
                    case "right": return "right";
                    case "left":
                    default: return "left";
                }
            };

            const getTextTransform = () => {
                switch (props.textTransform) {
                    case "uppercase": return "uppercase";
                    case "lowercase": return "lowercase";
                    case "capitalize": return "capitalize";
                    case "none":
                    default: return "none";
                }
            };

            return (
                <>
                    <style>{`
                        @media print {
                            .printable-subheader {
                                page-break-after: auto !important;
                                page-break-inside: avoid !important;
                                orphans: 3 !important;
                                widows: 3 !important;
                            }
                        }
                    `}</style>
                    <PrintableThemedView
                        class="printable-subheader"
                        style={{
                            display: "flex",
                            flexDirection: "row",
                            alignItems: "center",
                            gap: "8px",
                            marginBottom: props.marginBottom || "16px",
                            marginTop: props.marginTop || "0",
                            width: "100%",
                            ...(props.align === "center" && { justifyContent: "center" }),
                            ...(props.align === "right" && { justifyContent: "flex-end" }),
                        }}
                    >
                        {props.icon && props.iconPosition === "left" && (
                            <VIcon
                                size={props.size === "large" ? "20" : props.size === "medium" ? "18" : "16"}
                                style={{
                                    color: props.color || cc.onSurfaceVariant,
                                    flexShrink: 0,
                                    opacity: props.opacity || 0.8,
                                }}
                            >
                                {props.icon}
                            </VIcon>
                        )}

                        <h2
                            style={{
                                margin: 0,
                                fontSize: getFontSize(),
                                fontWeight: getFontWeight(),
                                color: props.color || cc.onSurfaceVariant,
                                textAlign: getTextAlign(),
                                letterSpacing: props.letterSpacing || "0.01em",
                                textTransform: getTextTransform(),
                                textDecoration: props.underline ? "underline" : "none",
                                lineHeight: "1.4",
                                wordBreak: "break-word",
                                flex: 1,
                                opacity: props.opacity || 0.9,
                            }}
                        >
                            {props.text}
                        </h2>

                        {props.icon && props.iconPosition === "right" && (
                            <VIcon
                                size={props.size === "large" ? "20" : props.size === "medium" ? "18" : "16"}
                                style={{
                                    color: props.color || cc.onSurfaceVariant,
                                    flexShrink: 0,
                                    opacity: props.opacity || 0.8,
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
        props: [
            "text",
            "size",
            "weight",
            "align",
            "color",
            "icon",
            "iconPosition",
            "underline",
            "marginBottom",
            "marginTop",
            "letterSpacing",
            "textTransform",
            "opacity"
        ],
    },
);

export default PrintableSubHeader;
