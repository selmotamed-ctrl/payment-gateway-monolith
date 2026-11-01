import { dc } from "kt-dc";
import { ref, watch } from "vue";
import { Field, type FieldProps } from "../Field";
import { VDivider, VIcon } from "vuetify/components";
import { useDisplay, useTheme } from "vuetify";
import { ThemedView } from "../ThemedView";
import { ThemedText } from "../ThemedText";
import type { SectionCommand } from "../CollapsibleSection";

type FieldSection = {
    title?: string;
    description?: string;
    fields: FieldProps[];
    defaultExpanded?: boolean;
};

const readExpanded = (key: string, fallback: boolean): boolean => {
    if (typeof window === "undefined") return fallback;
    try {
        const stored = window.sessionStorage.getItem(key);
        if (stored === "1") return true;
        if (stored === "0") return false;
    } catch {
        return fallback;
    }
    return fallback;
};

const FieldsSections = dc(
    (props: {
        sections: FieldSection[];
        noElevation?: boolean;
        collapsible?: boolean;
        storageKeyPrefix?: string;
        defaultExpanded?: boolean;
        command?: SectionCommand | null;
    }) => {
        const display = useDisplay();

        const renderFields = (section: FieldSection, index: number) => (
            <Fields
                noElevation={props.noElevation}
                title={section.title}
                description={section.description}
                fields={section.fields}
                collapsible={props.collapsible}
                defaultExpanded={section.defaultExpanded ?? props.defaultExpanded ?? true}
                storageKey={props.collapsible ? `${props.storageKeyPrefix ?? "fields"}:${index}:${section.title ?? ""}` : undefined}
                command={props.command}
            />
        );

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
                                            {renderFields(el1, currentIndex)}
                                        </ThemedView>,
                                    );
                                    continue;
                                }
                                if (mobile) {
                                    rendered.push(
                                        <ThemedView>
                                            {renderFields(el1, currentIndex)}
                                        </ThemedView>,
                                        <ThemedView>
                                            {renderFields(el2, nextCurrentIndex)}
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
                                        <ThemedView style={{ flex: 1 }}>
                                            {renderFields(el1, currentIndex)}
                                        </ThemedView>
                                        <ThemedView style={{ flex: 1 }}>
                                            {renderFields(el2, nextCurrentIndex)}
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
        props: ["sections", "noElevation", "collapsible", "storageKeyPrefix", "defaultExpanded", "command"],
    },
);

const Fields = dc(
    (props: {
        fields: FieldProps[];
        noElevation?: boolean;
        title?: string;
        description?: string;
        collapsible?: boolean;
        defaultExpanded?: boolean;
        storageKey?: string;
        command?: SectionCommand | null;
    }) => {
        const theme = useTheme();
        const open = ref(readExpanded(props.storageKey ?? "", props.defaultExpanded !== false));
        watch(
            () => props.storageKey,
            () => {
                open.value = readExpanded(props.storageKey ?? "", props.defaultExpanded !== false);
            },
        );
        watch(open, (value) => {
            if (!props.storageKey || typeof window === "undefined") return;
            try {
                window.sessionStorage.setItem(props.storageKey, value ? "1" : "0");
            } catch {
                return;
            }
        });
        watch(
            () => props.command?.id,
            () => {
                if (props.command) open.value = props.command.open;
            },
        );
        return () => {
            const cc = theme.current.value.colors;
            const expanded = !props.collapsible || open.value;
            return (
                <>
                    <ThemedView
                        style={{
                            flex: 1,
                            height: "100%",
                            padding: props.collapsible ? "18px 22px" : "28px 24px",
                            gap: expanded ? "20px" : "0",
                            borderRadius: "16px",
                            boxShadow: props.noElevation ? undefined : "0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)",
                            background: cc.surface,
                            border: `1px solid ${cc.outlineVariant}20`,
                            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                        }}
                        class={`${props.noElevation ? undefined : "fields-section-card"}`}
                    >
                        {(props.title || props.description) && (() => {
                            const header = (
                                <>
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
                                    {props.collapsible && (
                                        <VIcon icon={open.value ? "mdi-chevron-down" : "mdi-chevron-right"} size="20" style={{ opacity: 0.6 }} />
                                    )}
                                </>
                            );
                            const style = {
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "10px",
                                width: "100%",
                                padding: "0",
                                background: "transparent",
                                border: "0",
                                color: "inherit",
                                textAlign: "left" as const,
                                cursor: props.collapsible ? "pointer" : "default",
                            };
                            return props.collapsible ? (
                                <button
                                    type="button"
                                    aria-expanded={open.value ? "true" : "false"}
                                    onClick={() => (open.value = !open.value)}
                                    style={style}
                                >
                                    {header}
                                </button>
                            ) : (
                                <ThemedView style={style}>{header}</ThemedView>
                            );
                        })()}
                        {expanded && props.fields.map((f, i) => {
                            return (
                                <>
                                    <Field key={i} copyOnClick={f.copyOnClick} text={f.text} value={f.value} onClick={f.onClick} hint={f.hint} source={f.source}></Field>
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
        props: ["fields", "noElevation", "title", "description", "collapsible", "defaultExpanded", "storageKey", "command"],
    },
);

export default FieldsSections;
