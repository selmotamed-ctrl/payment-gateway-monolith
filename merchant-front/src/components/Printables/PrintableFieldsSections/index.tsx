import { dc } from "kt-dc";
import { PrintableField, type FieldProps } from "../PrintableField";
import { VDivider } from "vuetify/components";
import { useTheme } from "vuetify";
import { PrintableThemedView } from "../PrintableThemedView.tsx";

const PrintableFieldsSections = dc(
    (props: {
        sections: {
            fields: FieldProps[];
        }[];
        noElevation?: boolean;
    }) => {
        return () => {
            return (
                <>
                    <style>{`
                        @media print {
                            .printable-container {
                                display: flex !important;
                                flex-direction: column !important;
                                gap: 20px !important;
                            }
                            .printable-row {
                                display: flex !important;
                                flex-direction: row !important;
                                gap: 16px !important;
                            }
                            .printable-column {
                                flex: 1 !important;
                            }
                            .printable-full-width {
                                width: 100% !important;
                            }
                            .avoid-breaking-in-print {
                                page-break-inside: avoid !important;
                            }
                            .print-hide {
                                display: none !important;
                            }
                        }
                    `}</style>
                    <PrintableThemedView
                        class="printable-container"
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "22px",
                        }}
                    >
                        {(() => {
                            const filteredSections = props.sections.filter((s) => s.fields.length > 0);
                            if (!filteredSections.length) {
                                return <></>;
                            }
                            const rendered = [] as JSX.Element[];
                            for (let i = 0; i < Math.ceil(filteredSections.length / 2); i++) {
                                const currentIndex = i * 2;
                                const nextCurrentIndex = i * 2 + 1;
                                const el1 = filteredSections[currentIndex];
                                const el2 = filteredSections[nextCurrentIndex];
                                if (!el1) {
                                    continue;
                                }
                                if (!el2) {
                                    rendered.push(
                                        <PrintableThemedView key={`section-${currentIndex}`} class="printable-full-width">
                                            <Fields noElevation={props.noElevation} fields={el1!.fields}></Fields>
                                        </PrintableThemedView>,
                                    );
                                    continue;
                                }

                                rendered.push(
                                    <PrintableThemedView
                                        key={`row-${i}`}
                                        class="printable-row"
                                        style={{
                                            display: "flex",
                                            flexDirection: "row",
                                            gap: "16px",
                                        }}
                                    >
                                        <PrintableThemedView
                                            key={`section-${currentIndex}`}
                                            class="printable-column"
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <Fields noElevation={props.noElevation} fields={el1!.fields}></Fields>
                                        </PrintableThemedView>
                                        <PrintableThemedView
                                            key={`section-${nextCurrentIndex}`}
                                            class="printable-column"
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <Fields noElevation={props.noElevation} fields={el2!.fields}></Fields>
                                        </PrintableThemedView>
                                    </PrintableThemedView>,
                                );
                            }
                            return <>{rendered}</>;
                        })()}
                    </PrintableThemedView>
                </>
            );
        };
    },
    {
        props: ["sections", "noElevation"],
    },
);

const Fields = dc(
    (props: { fields: FieldProps[]; noElevation?: boolean }) => {
        const theme = useTheme();
        return () => {
            const cc = theme.current.value.colors;
            return (
                <>
                    <PrintableThemedView
                        style={{
                            flex: 1,
                            height: "100%",
                            padding: "24px",
                            gap: "16px",
                            borderRadius: "8px",
                            boxShadow: props.noElevation ? "none" : "0 1px 3px rgba(0, 0, 0, 0.1)",
                            background: props.noElevation ? "transparent" : cc.surface,
                            border: props.noElevation ? "none" : `1px solid ${cc.outlineVariant}30`,
                        }}
                        class={`${props.noElevation ? undefined : "fields-section-card"}`}
                    >
                        {props.fields.map((f, i) => {
                            return (
                                <>
                                    <PrintableThemedView class="avoid-breaking-in-print">
                                        <PrintableField key={i} copyOnClick={f.copyOnClick} text={f.text} value={f.value} onClick={f.onClick}></PrintableField>

                                        <VDivider
                                            style={{
                                                margin: "8px 0",
                                                opacity: 0.15,
                                                borderColor: cc.outlineVariant,
                                            }}
                                        ></VDivider>
                                    </PrintableThemedView>
                                </>
                            );
                        })}
                    </PrintableThemedView>
                </>
            );
        };
    },
    {
        props: ["fields", "noElevation"],
    },
);

export default PrintableFieldsSections;
