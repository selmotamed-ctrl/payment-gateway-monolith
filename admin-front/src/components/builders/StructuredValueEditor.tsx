import { defineComponent, ref, type PropType, type VNodeChild } from "vue";
import { VBtn, VSelect, VSwitch, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { ChipListInput } from "./ChipListInput";
import { RepeatableRows } from "./RepeatableRows";
import {
    blankLike,
    defaultForTreeKind,
    humanizeKey,
    isPlainObject,
    treeKindOf,
    validateNewKey,
    withKey,
    withoutKey,
    type JsonObject,
    type TreeKind,
} from "./model/jsonTree";

const MAX_DEPTH = 6;

const TREE_KIND_LABELS: { value: TreeKind; label: string }[] = [
    { value: "text", label: "Text" },
    { value: "number", label: "Number" },
    { value: "boolean", label: "Yes / No" },
    { value: "list", label: "List" },
    { value: "group", label: "Group" },
];

/**
 * Generic, lossless editor for any JSON value. Objects become labelled field rows
 * (add / remove a field), lists of scalars become chips, lists of objects become
 * repeatable rows, booleans switches and numbers numeric inputs. Nothing is ever
 * rendered as raw JSON, and every key of the input is shown, so nothing is lost.
 */
export const StructuredValueEditor = defineComponent({
    name: "StructuredValueEditor",
    props: {
        modelValue: { type: null as unknown as PropType<unknown> },
        /** Hide the "add field" row (read-mostly objects). */
        lockStructure: { type: Boolean, default: false },
        depth: { type: Number, default: 0 },
        ariaLabel: { type: String, default: "" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const newKey = ref("");
        const newKind = ref<TreeKind>("text");
        const newKeyError = ref("");

        const scalarEditor = (value: unknown, onChange: (next: unknown) => void, label: string): VNodeChild => {
            const kind = treeKindOf(value);
            if (kind === "boolean") {
                return (
                    <VSwitch
                        modelValue={value === true}
                        onUpdate:modelValue={(next: boolean | null) => onChange(next === true)}
                        color="primary"
                        density="compact"
                        hideDetails
                        aria-label={label}
                    />
                );
            }
            if (kind === "number") {
                return (
                    <VTextField
                        type="number"
                        modelValue={String(value)}
                        onUpdate:modelValue={(next: string) => {
                            const parsed = Number(next);
                            if (next.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
                        }}
                        density="compact"
                        hideDetails
                        aria-label={label}
                    />
                );
            }
            return (
                <VTextField
                    modelValue={typeof value === "string" ? value : ""}
                    onUpdate:modelValue={(next: string) => onChange(next)}
                    density="compact"
                    hideDetails
                    aria-label={label}
                />
            );
        };

        const valueEditor = (value: unknown, onChange: (next: unknown) => void, label: string, depth: number): VNodeChild => {
            const kind = treeKindOf(value);
            if (kind === "group") {
                if (depth >= MAX_DEPTH) return <span style={{ color: "var(--pg-ink-muted)", fontSize: "12px" }}>{t("Too deeply nested to edit here")}</span>;
                return <StructuredValueEditor modelValue={value} depth={depth + 1} lockStructure={props.lockStructure} onUpdate:modelValue={onChange} ariaLabel={label} />;
            }
            if (kind === "list") {
                const list = value as unknown[];
                if (list.every((entry) => entry === null || typeof entry !== "object")) {
                    return <ChipListInput modelValue={list as (string | number)[]} onUpdate:modelValue={onChange} ariaLabel={label} />;
                }
                return (
                    <RepeatableRows
                        count={list.length}
                        addLabel={t("Add item")}
                        rowLabel={(index: number) => `${label} ${index + 1}`}
                        onAdd={() => onChange([...list, blankLike(list[list.length - 1])])}
                        onRemove={(index: number) => onChange(list.filter((_, position) => position !== index))}
                        v-slots={{
                            default: ({ index }: { index: number }) =>
                                valueEditor(list[index], (next) => onChange(list.map((entry, position) => (position === index ? next : entry))), `${label} ${index + 1}`, depth + 1),
                        }}
                    />
                );
            }
            return scalarEditor(value, onChange, label);
        };

        const addField = () => {
            const target = isPlainObject(props.modelValue) ? props.modelValue : {};
            const code = validateNewKey(target, newKey.value);
            if (code) {
                newKeyError.value = code === "EMPTY" ? t("Enter a field name") : code === "DUPLICATE" ? t("This field already exists") : t("Use letters, digits, dots, colons, underscores or hyphens.");
                return;
            }
            emit("update:modelValue", withKey(target, newKey.value.trim(), defaultForTreeKind(newKind.value)));
            newKey.value = "";
            newKeyError.value = "";
        };

        return (): VNodeChild => {
            const model = props.modelValue;
            if (!isPlainObject(model)) {
                return valueEditor(model, (next) => emit("update:modelValue", next), props.ariaLabel || t("Value"), props.depth);
            }
            const entries = Object.entries(model);
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", minInlineSize: 0 }}>
                    {entries.length === 0 && <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{t("No fields yet")}</span>}
                    {entries.map(([key, value]) => {
                        const nested = treeKindOf(value) === "group" || (treeKindOf(value) === "list" && (value as unknown[]).some((entry) => entry !== null && typeof entry === "object"));
                        return (
                            <div
                                key={key}
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: nested ? "1fr" : "minmax(110px, 190px) 1fr auto",
                                    gap: "6px 10px",
                                    alignItems: "start",
                                    paddingInlineStart: props.depth > 0 ? "10px" : 0,
                                    borderInlineStart: props.depth > 0 ? "2px solid var(--pg-border-subtle)" : "none",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", minInlineSize: 0, paddingBlockStart: nested ? 0 : "8px" }}>
                                    <span title={key} style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--pg-ink-primary)", overflowWrap: "anywhere" }}>
                                        {humanizeKey(key)}
                                    </span>
                                    {nested && !props.lockStructure && (
                                        <VBtn icon="mdi-delete-outline" variant="text" size="small" color="error" aria-label={`${t("Remove")} ${humanizeKey(key)}`} onClick={() => emit("update:modelValue", withoutKey(model as JsonObject, key))} />
                                    )}
                                </div>
                                <div style={{ minInlineSize: 0 }}>
                                    {valueEditor(value, (next) => emit("update:modelValue", withKey(model as JsonObject, key, next)), humanizeKey(key), props.depth)}
                                </div>
                                {!nested && !props.lockStructure && (
                                    <VBtn icon="mdi-delete-outline" variant="text" size="small" color="error" aria-label={`${t("Remove")} ${humanizeKey(key)}`} onClick={() => emit("update:modelValue", withoutKey(model as JsonObject, key))} />
                                )}
                            </div>
                        );
                    })}
                    {!props.lockStructure && props.depth < MAX_DEPTH && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "flex-start" }}>
                            <VTextField
                                modelValue={newKey.value}
                                onUpdate:modelValue={(value: string) => {
                                    newKey.value = value;
                                    newKeyError.value = "";
                                }}
                                placeholder={t("New field name")}
                                aria-label={t("New field name")}
                                density="compact"
                                hideDetails={!newKeyError.value}
                                errorMessages={newKeyError.value ? [newKeyError.value] : []}
                                style={{ flex: "1 1 160px", minInlineSize: 0 }}
                                onKeydown={(event: KeyboardEvent) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        addField();
                                    }
                                }}
                            />
                            <VSelect
                                modelValue={newKind.value}
                                onUpdate:modelValue={(value: TreeKind) => (newKind.value = value)}
                                items={TREE_KIND_LABELS.map((entry) => ({ title: t(entry.label), value: entry.value }))}
                                aria-label={t("Field type")}
                                density="compact"
                                hideDetails
                                style={{ flex: "0 0 130px" }}
                            />
                            <VBtn variant="tonal" size="small" prependIcon="mdi-plus" onClick={addField}>{t("Add field")}</VBtn>
                        </div>
                    )}
                </div>
            );
        };
    },
});
