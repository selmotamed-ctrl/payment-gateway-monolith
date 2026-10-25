import { dc } from "kt-dc";
import { useTheme } from "vuetify";
import { PrintableThemedView } from "../PrintableThemedView.tsx";

export type PrinterContainerProps = {
    gap?: string;
    padding?: string;
    maxWidth?: string;
    backgroundColor?: string;
    borderRadius?: string;
    border?: string;
    children?: any;
};

export const PrintableContainer = dc(
    (props: PrinterContainerProps, _, {slots}) => {
        const theme = useTheme();

        return () => {
            const cc = theme.current.value.colors;

            return (
                <>
                    <style>{`
                        @media print {
                            .printer-container {
                                width: 100% !important;
                                max-width: 100% !important;
                                box-shadow: none !important;
                            },
                        }
                    `}</style>
                    <PrintableThemedView
                        class="printer-container"
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: props.gap || "28px",
                            padding: props.padding || "0",
                            maxWidth: props.maxWidth || "100%",
                            width: "100%",
                            breakAfter: "always",
                            pageBreakAfter: "always",
                            backgroundColor: props.backgroundColor || "transparent",
                            borderRadius: props.borderRadius || "0",
                            border: props.border || "none",
                            boxSizing: "border-box",
                        }}
                    >
                        <PrintableThemedView
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: props.gap || "24px",
                                width: "100%",
                            }}
                        >
                            {slots.default?.()}
                        </PrintableThemedView>
                    </PrintableThemedView>
                </>
            );
        };
    },
    {
        props: [
            "gap",
            "padding",
            "maxWidth",
            "backgroundColor",
            "borderRadius",
            "border",
            "children"
        ],
    },
);

export default PrintableContainer;
