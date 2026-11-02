import { dc } from "kt-dc";
import { Field, type FieldProps } from "../Field";
import { VDivider } from "vuetify/components";
import { useDisplay } from "vuetify";
import { ThemedView } from "../ThemedView";

const FieldsSections = dc(
    (props: {
        sections: {
            fields: FieldProps[];
        }[];
        noElevation?: boolean;
    }) => {
        const display = useDisplay();

        return () => {
            const mobile = display.mobile.value;
            return (
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
                                        <Fields noElevation={props.noElevation} fields={el1.fields}></Fields>
                                    </ThemedView>,
                                );
                                continue;
                            }
                            if (mobile) {
                                rendered.push(
                                    <ThemedView>
                                        <Fields noElevation={props.noElevation} fields={el1.fields}></Fields>
                                    </ThemedView>,
                                    <ThemedView>
                                        <Fields noElevation={props.noElevation} fields={el2.fields}></Fields>
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
                                        <Fields noElevation={props.noElevation} fields={el1.fields}></Fields>
                                    </ThemedView>
                                    <ThemedView
                                        style={{
                                            flex: 1,
                                        }}
                                    >
                                        <Fields noElevation={props.noElevation} fields={el2.fields}></Fields>
                                    </ThemedView>
                                </ThemedView>,
                            );
                        }
                        return <>{rendered}</>;
                    })()}
                </ThemedView>
            );
        };
    },
    {
        props: ["sections", "noElevation"],
    },
);

const Fields = dc(
    (props: { fields: FieldProps[]; noElevation?: boolean }) => {
        return () => {
            return (
                <ThemedView
                    style={{
                        flex: 1,
                        height: "100%",
                        padding: "24px",
                        gap: "18px",
                        borderRadius: "var(--pg-radius-lg)",
                        boxShadow: props.noElevation ? "none" : "var(--pg-shadow-sm)",
                        background: "var(--pg-bg-surface)",
                        border: "1px solid var(--pg-border-subtle)",
                        transition: "border-color 0.2s ease",
                    }}
                    class={`${props.noElevation ? undefined : "fields-section-card"}`}
                >
                    {props.fields.map((f, i) => {
                        return (
                            <>
                                <Field key={i} copyOnClick={f.copyOnClick} text={f.text} value={f.value} onClick={f.onClick}></Field>
                                {i < props.fields.length - 1 && (
                                    <VDivider
                                        style={{
                                            margin: "2px 0",
                                            opacity: 0.6,
                                            borderColor: "var(--pg-border-subtle)",
                                        }}
                                    ></VDivider>
                                )}
                            </>
                        );
                    })}
                </ThemedView>
            );
        };
    },
    {
        props: ["fields", "noElevation"],
    },
);

export default FieldsSections;
