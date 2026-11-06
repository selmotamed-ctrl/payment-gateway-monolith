import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";

/**
 * A list of repeatable rows with add / remove. The row body is the default
 * slot (`{ index }`); the parent owns the data and answers `add` / `remove`.
 */
export const RepeatableRows = defineComponent({
    name: "RepeatableRows",
    props: {
        count: { type: Number, required: true },
        addLabel: { type: String, default: "" },
        emptyLabel: { type: String, default: "" },
        maxItems: { type: Number, default: 0 },
        disabled: { type: Boolean, default: false },
        removeLabel: { type: String, default: "" },
        rowLabel: { type: Function as PropType<(index: number) => string>, default: undefined },
    },
    emits: ["add", "remove"],
    setup(props, { emit, slots }) {
        const { t } = useLocale();
        return (): VNodeChild => {
            const canAdd = !props.disabled && (props.maxItems === 0 || props.count < props.maxItems);
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", minInlineSize: 0 }}>
                    {props.count === 0 && props.emptyLabel && (
                        <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{props.emptyLabel}</span>
                    )}
                    {Array.from({ length: props.count }, (_, index) => (
                        <div
                            key={index}
                            role="group"
                            aria-label={props.rowLabel?.(index) ?? `${index + 1}`}
                            style={{
                                display: "flex",
                                gap: "8px",
                                alignItems: "flex-start",
                                padding: "10px",
                                borderRadius: "var(--pg-radius-sm)",
                                border: "1px solid var(--pg-border-subtle)",
                                backgroundColor: "var(--pg-bg-surface-subtle)",
                                minInlineSize: 0,
                            }}
                        >
                            <div style={{ flex: 1, minInlineSize: 0 }}>{slots.default?.({ index })}</div>
                            {!props.disabled && (
                                <VBtn
                                    icon="mdi-delete-outline"
                                    variant="text"
                                    size="small"
                                    color="error"
                                    aria-label={`${props.removeLabel || t("Remove")} ${index + 1}`}
                                    onClick={() => emit("remove", index)}
                                />
                            )}
                        </div>
                    ))}
                    {canAdd && (
                        <div>
                            <VBtn variant="tonal" size="small" prependIcon="mdi-plus" onClick={() => emit("add")}>
                                {props.addLabel || t("Add")}
                            </VBtn>
                        </div>
                    )}
                </div>
            );
        };
    },
});
