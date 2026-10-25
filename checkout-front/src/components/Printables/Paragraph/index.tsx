import { dc } from "kt-dc";
import { useTheme } from "vuetify";
import { PrintableThemedView } from "../PrintableThemedView.tsx";

export type ParagraphProps = {
    text: string;
    size?: "small" | "medium" | "large";
    weight?: "normal" | "medium" | "semibold" | "bold";
    align?: "left" | "center" | "right" | "justify";
    color?: string;
    italic?: boolean;
    underline?: boolean;
    maxWidth?: string;
    lineHeight?: string;
    letterSpacing?: string;
    marginBottom?: string;
    marginTop?: string;
};

export const Paragraph = dc(
    (props: ParagraphProps) => {
        const theme = useTheme();

        return () => {
            const cc = theme.current.value.colors;

            const getFontSize = () => {
                switch (props.size) {
                    case "small": return "14px";
                    case "large": return "18px";
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
                    default: return "400";
                }
            };

            const getTextAlign = () => {
                switch (props.align) {
                    case "center": return "center";
                    case "right": return "right";
                    case "justify": return "justify";
                    case "left":
                    default: return "left";
                }
            };

            return (
                <>
                    <style>{`
                        @media print {
                            .printable-paragraph {
                                page-break-inside: avoid !important;
                                orphans: 3 !important;
                                widows: 3 !important;
                            }
                        }
                    `}</style>
                    <PrintableThemedView
                        class="printable-paragraph"
                        style={{
                            width: "100%",
                            maxWidth: props.maxWidth || "100%",
                            marginBottom: props.marginBottom || "16px",
                            marginTop: props.marginTop || "0",
                        }}
                    >
                        <p
                            style={{
                                margin: 0,
                                fontSize: getFontSize(),
                                fontWeight: getFontWeight(),
                                color: props.color || cc.onSurface,
                                textAlign: getTextAlign(),
                                lineHeight: props.lineHeight || "1.6",
                                letterSpacing: props.letterSpacing || "0.01em",
                                fontStyle: props.italic ? "italic" : "normal",
                                textDecoration: props.underline ? "underline" : "none",
                                wordBreak: "break-word",
                                hyphens: "auto",
                            }}
                        >
                            {props.text}
                        </p>
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
            "italic",
            "underline",
            "maxWidth",
            "lineHeight",
            "letterSpacing",
            "marginBottom",
            "marginTop"
        ],
    },
);

export default Paragraph;
