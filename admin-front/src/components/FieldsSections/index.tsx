import { dc } from "kt-dc";
import { Field, type FieldProps } from "../Field";
import { VDivider } from "vuetify/components";
import { useDisplay, useTheme } from "vuetify";
import { ThemedView } from "../ThemedView";
import { ThemedText } from "../ThemedText";

const FieldsSections = dc(
    (props: {
        sections: {
            title?: string;
            description?: string;
            fields: FieldProps[];
        }[];
        noElevation?: boolean;
    }) => {
        const display = useDisplay();

        return () => {
            const mobile = display.mobile.value;
            return (
                <>
                    <ThemedView
                        style={{
                            gap: "22px 12px",
                        }}
                    >
                        {(() => {
                            const filteredSections = props.sections.filter((s) => s.fields.length > 0);
                            if (!filteredSections.length) {
                                return <></>;
                            }
                            const rendered = [] as JSX.Element[];
                            for (let i = 0; i < Math.ceil(filteredSections.length / 2); i++) {
                                console.log("rendering sections of row", i, "in", Math.ceil(filteredSections.length / 2));
                                const currentIndex = i * 2;
                                const nextCurrentIndex = i * 2 + 1;
                                const el1 = filteredSections[currentIndex];
                                const el2 = filteredSections[nextCurrentIndex];
                                if (!el1) {
                                    rendered.push(<></>);
                                    continue;
                                }
                                if (!el2) {
                                    rendered.push(
                                        <ThemedView>
                                            <Fields
                                                noElevation={props.noElevation}
                                                title={el1!.title}
                                                description={el1!.description}
                                                fields={el1!.fields}
                                            ></Fields>
                                        </ThemedView>,
                                    );
                                    continue;
                                }
                                if (mobile) {
                                    rendered.push(
                                        <ThemedView>
                                            <Fields
                                                noElevation={props.noElevation}
                                                title={el1!.title}
                                                description={el1!.description}
                                                fields={el1!.fields}
                                            ></Fields>
                                        </ThemedView>,
                                        <ThemedView>
                                            <Fields
                                                noElevation={props.noElevation}
                                                title={el2!.title}
                                                description={el2!.description}
                                                fields={el2!.fields}
                                            ></Fields>
                                        </ThemedView>,
                                    );
                                    continue;
                                }

                                rendered.push(
                                    <ThemedView
                                        style={{
                                            gap: "12px",
                                            flexDirection: "row",
                                            alignItems: "stretch",
                                        }}
                                    >
                                        <ThemedView
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <Fields
                                                noElevation={props.noElevation}
                                                title={el1!.title}
                                                description={el1!.description}
                                                fields={el1!.fields}
                                            ></Fields>
                                        </ThemedView>
                                        <ThemedView
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <Fields
                                                noElevation={props.noElevation}
                                                title={el2!.title}
                                                description={el2!.description}
                                                fields={el2!.fields}
                                            ></Fields>
                                        </ThemedView>
                                    </ThemedView>,
                                );
                            }
                            return <>{rendered}</>;
                        })()}
                    </ThemedView>
                </>
            );
        };
    },
    {
        props: ["sections", "noElevation"],
    },
);

const Fields = dc(
    (props: { fields: FieldProps[]; noElevation?: boolean; title?: string; description?: string }) => {
        const theme = useTheme();
        return () => {
            const cc = theme.current.value.colors;
            return (
                <>
                    <ThemedView
                        style={{
                            flex: 1,
                            height: "100%",
                            padding: "28px 24px",
                            gap: "20px",
                            borderRadius: "16px",
                            boxShadow: props.noElevation ? undefined : "0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)",
                            background: cc.surface,
                            border: `1px solid ${cc.outlineVariant}20`,
                            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                        }}
                        class={`${props.noElevation ? undefined : "fields-section-card"}`}
                    >
                        {(props.title || props.description) && (
                            <ThemedView style={{ gap: "4px", marginBottom: "4px" }}>
                                {props.title && (
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>
                                        {props.title}
                                    </ThemedText>
                                )}
                                {props.description && (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.6, lineHeight: 1.5 }}>
                                        {props.description}
                                    </ThemedText>
                                )}
                            </ThemedView>
                        )}
                        {props.fields.map((f, i) => {
                            return (
                                <>
                                    <Field key={i} copyOnClick={f.copyOnClick} text={f.text} value={f.value} onClick={f.onClick}></Field>
                                    {i < props.fields.length - 1 && (
                                        <VDivider
                                            style={{
                                                margin: "4px 0",
                                                opacity: 0.12,
                                                borderColor: cc.outlineVariant,
                                            }}
                                        ></VDivider>
                                    )}
                                </>
                            );
                        })}
                    </ThemedView>
                </>
            );
        };
    },
    {
        props: ["fields", "noElevation", "title", "description"],
    },
);

export default FieldsSections;
