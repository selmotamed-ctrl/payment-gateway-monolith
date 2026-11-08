import { defineComponent, ref, type PropType, type VNodeChild } from "vue";
import { VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { parseListEntry } from "./model/jsonTree";

/**
 * Editable list of short values (ids, codes, roles) shown as removable chips.
 * Enter, comma or the add button commits the typed text. Entries keep their
 * JSON type: a list of numbers only accepts numbers.
 */
export const ChipListInput = defineComponent({
    name: "ChipListInput",
    props: {
        modelValue: { type: Array as PropType<(string | number)[]>, default: () => [] },
        placeholder: { type: String, default: "" },
        ariaLabel: { type: String, default: "" },
        /** Normalises an entry before it is added (e.g. upper-case). */
        normalize: { type: Function as PropType<(value: string) => string>, default: undefined },
        /** Returns an error message for an entry that must be rejected, else null. */
        validateEntry: { type: Function as PropType<(value: string) => string | null>, default: undefined },
        /** Marks already stored entries that are invalid (shown in the danger tone). */
        isInvalid: { type: Function as PropType<(value: string) => boolean>, default: undefined },
        disabled: { type: Boolean, default: false },
        monospace: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const draft = ref("");
        const error = ref("");

        const commit = (raw: string) => {
            const normalized = props.normalize ? props.normalize(raw.trim()) : raw.trim();
            if (!normalized) return;
            const parsed = parseListEntry(normalized, props.modelValue);
            if (parsed === undefined) {
                error.value = t("Enter a number");
                return;
            }
            const message = props.validateEntry?.(String(parsed)) ?? null;
            if (message) {
                error.value = message;
                return;
            }
            error.value = "";
            if (!props.modelValue.some((entry) => String(entry) === String(parsed))) {
                emit("update:modelValue", [...props.modelValue, parsed]);
            }
            draft.value = "";
        };

        const remove = (index: number) => {
            emit("update:modelValue", props.modelValue.filter((_, position) => position !== index));
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commit(draft.value);
            } else if (event.key === "Backspace" && !draft.value && props.modelValue.length > 0) {
                remove(props.modelValue.length - 1);
            }
        };

        return (): VNodeChild => (
            <div class="pg-chip-list" style={{ display: "flex", flexDirection: "column", gap: "6px", minInlineSize: 0 }}>
                {props.modelValue.length > 0 && (
                    <ul
                        aria-label={props.ariaLabel || undefined}
                        style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: 0, padding: 0, listStyle: "none" }}
                    >
                        {props.modelValue.map((entry, index) => {
                            const text = String(entry);
                            const invalid = props.isInvalid?.(text) === true;
                            return (
                                <li
                                    key={`${text}-${index}`}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "4px",
                                        maxInlineSize: "100%",
                                        paddingInlineStart: "8px",
                                        paddingInlineEnd: "2px",
                                        blockSize: "24px",
                                        borderRadius: "var(--pg-radius-sm)",
                                        border: `1px solid ${invalid ? "var(--pg-status-danger-border)" : "var(--pg-border-subtle)"}`,
                                        backgroundColor: invalid ? "var(--pg-status-danger-bg)" : "var(--pg-bg-surface-subtle)",
                                        color: invalid ? "var(--pg-status-danger-text)" : "var(--pg-ink-secondary)",
                                        fontSize: "12px",
                                        fontFamily: props.monospace ? "ui-monospace, monospace" : "inherit",
                                    }}
                                >
                                    <span dir="auto" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
                                    {!props.disabled && (
                                        <VBtn
                                            icon="mdi-close"
                                            variant="text"
                                            size="x-small"
                                            density="compact"
                                            aria-label={`${t("Remove")} ${text}`}
                                            onClick={() => remove(index)}
                                        />
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {!props.disabled && (
                    <div style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
                        <VTextField
                            modelValue={draft.value}
                            onUpdate:modelValue={(value: string) => {
                                draft.value = value;
                                if (error.value) error.value = "";
                            }}
                            onKeydown={onKeydown}
                            onBlur={() => commit(draft.value)}
                            placeholder={props.placeholder || t("Type and press Enter")}
                            density="compact"
                            hideDetails={!error.value}
                            errorMessages={error.value ? [error.value] : []}
                            style={{ flex: 1, minInlineSize: 0 }}
                        />
                        <VBtn variant="tonal" size="small" onClick={() => commit(draft.value)} aria-label={t("Add")} icon="mdi-plus" />
                    </div>
                )}
            </div>
        );
    },
});

/** A fixed set of options toggled on/off (risk tiers, channels). Values outside `options` are shown and can be removed. */
export const OptionChips = defineComponent({
    name: "OptionChips",
    props: {
        modelValue: { type: Array as PropType<string[]>, default: () => [] },
        options: { type: Array as PropType<{ value: string; label: string }[]>, required: true },
        ariaLabel: { type: String, default: "" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const toggle = (value: string) => {
            emit(
                "update:modelValue",
                props.modelValue.includes(value) ? props.modelValue.filter((entry) => entry !== value) : [...props.modelValue, value],
            );
        };
        return (): VNodeChild => {
            const known = new Set(props.options.map((option) => option.value));
            const all = [
                ...props.options,
                ...props.modelValue.filter((value) => !known.has(value)).map((value) => ({ value, label: value })),
            ];
            return (
                <div role="group" aria-label={props.ariaLabel || undefined} style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {all.map((option) => {
                        const active = props.modelValue.includes(option.value);
                        const invalid = !known.has(option.value);
                        return (
                            <button
                                key={option.value}
                                type="button"
                                aria-pressed={active ? "true" : "false"}
                                onClick={() => toggle(option.value)}
                                style={{
                                    blockSize: "28px",
                                    paddingInline: "10px",
                                    borderRadius: "var(--pg-radius-sm)",
                                    border: `1px solid ${invalid ? "var(--pg-status-danger-border)" : active ? "var(--pg-status-info-border)" : "var(--pg-border-subtle)"}`,
                                    backgroundColor: invalid ? "var(--pg-status-danger-bg)" : active ? "var(--pg-status-info-bg)" : "var(--pg-bg-surface)",
                                    color: invalid ? "var(--pg-status-danger-text)" : active ? "var(--pg-status-info-text)" : "var(--pg-ink-secondary)",
                                    fontSize: "12.5px",
                                    fontWeight: active ? 600 : 500,
                                    fontFamily: "inherit",
                                    cursor: "pointer",
                                }}
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>
            );
        };
    },
});
