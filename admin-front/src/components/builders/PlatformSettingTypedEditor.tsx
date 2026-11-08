import { defineComponent, ref, type PropType, type VNodeChild } from "vue";
import { VBtn, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormField } from "@/components/ui/FormField";
import { ChipListInput } from "./ChipListInput";
import { StructuredValueEditor } from "./StructuredValueEditor";
import { SETTING_ERROR_MESSAGES } from "./messages";
import {
    selectOptions,
    validateSettingForm,
    type JsonObject,
    type SettingFieldDef,
    type SettingForm,
    type SettingNamespaceDef,
} from "./model/index";

const humanizeOption = (value: string): string =>
    value.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/**
 * Typed editor of one platform-setting namespace (see `model/settingsSchemas.ts`): one labelled
 * control per declared field, then every key the namespace does not declare as an editable
 * structured tree, so saving never drops an unknown key. An unknown namespace (`def === null`)
 * is edited entirely through the structured tree.
 */
export const PlatformSettingTypedEditor = defineComponent({
    name: "PlatformSettingTypedEditor",
    props: {
        def: { type: Object as PropType<SettingNamespaceDef | null>, default: null },
        modelValue: { type: Object as PropType<SettingForm>, required: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const newCategory = ref("");

        const setValue = (key: string, value: unknown) =>
            emit("update:modelValue", { ...props.modelValue, values: { ...props.modelValue.values, [key]: value } });
        const setExtras = (extras: unknown) =>
            emit("update:modelValue", { ...props.modelValue, extras: (extras && typeof extras === "object" && !Array.isArray(extras) ? extras : {}) as JsonObject });

        const control = (field: SettingFieldDef, errorText: string): VNodeChild => {
            const value = props.modelValue.values[field.key];
            switch (field.kind) {
                case "boolean":
                    return (
                        <VSwitch
                            modelValue={value === true}
                            onUpdate:modelValue={(next: boolean | null) => setValue(field.key, next === true)}
                            color="primary"
                            density="compact"
                            hideDetails
                        />
                    );
                case "select":
                    return (
                        <VSelect
                            modelValue={typeof value === "string" && value ? value : null}
                            onUpdate:modelValue={(next: string | null) => setValue(field.key, next ?? "")}
                            items={selectOptions(field, props.modelValue.originals[field.key]).map((option) => ({ title: humanizeOption(option), value: option }))}
                            clearable={!field.required}
                            density="compact"
                            hideDetails
                        />
                    );
                case "strings":
                    return (
                        <div>
                            <ChipListInput
                                modelValue={(value as string[]) ?? []}
                                onUpdate:modelValue={(next: (string | number)[]) => setValue(field.key, next.map(String))}
                                normalize={field.uppercase ? (entry: string) => entry.toUpperCase() : undefined}
                                ariaLabel={t(field.label)}
                            />
                        </div>
                    );
                case "stringListMap": {
                    const map = (value as Record<string, string[]>) ?? {};
                    return (
                        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            {Object.entries(map).map(([name, list]) => (
                                <div key={name} style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", border: "1px solid var(--pg-border-subtle)" }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                                        <strong dir="auto" style={{ fontSize: "12.5px" }}>{name}</strong>
                                        <VBtn
                                            icon="mdi-delete-outline"
                                            variant="text"
                                            size="small"
                                            color="error"
                                            aria-label={`${t("Remove")} ${name}`}
                                            onClick={() => {
                                                const { [name]: _removed, ...rest } = map;
                                                setValue(field.key, rest);
                                            }}
                                        />
                                    </div>
                                    <ChipListInput
                                        modelValue={list}
                                        onUpdate:modelValue={(next: (string | number)[]) => setValue(field.key, { ...map, [name]: next.map(String) })}
                                        normalize={field.uppercase ? (entry: string) => entry.toUpperCase() : undefined}
                                        ariaLabel={`${t(field.label)} · ${name}`}
                                    />
                                </div>
                            ))}
                            <div style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
                                <VTextField
                                    modelValue={newCategory.value}
                                    onUpdate:modelValue={(next: string) => (newCategory.value = next)}
                                    placeholder={t("New category name")}
                                    aria-label={t("New category name")}
                                    density="compact"
                                    hideDetails
                                    style={{ flex: 1, minInlineSize: 0 }}
                                />
                                <VBtn
                                    variant="tonal"
                                    size="small"
                                    prependIcon="mdi-plus"
                                    onClick={() => {
                                        const name = newCategory.value.trim();
                                        if (!name || name in map) return;
                                        setValue(field.key, { ...map, [name]: [] });
                                        newCategory.value = "";
                                    }}
                                >
                                    {t("Add category")}
                                </VBtn>
                            </div>
                        </div>
                    );
                }
                case "tree":
                    return <StructuredValueEditor modelValue={value} onUpdate:modelValue={(next: unknown) => setValue(field.key, next)} ariaLabel={t(field.label)} />;
                case "longtext":
                    return <VTextarea modelValue={typeof value === "string" ? value : ""} onUpdate:modelValue={(next: string) => setValue(field.key, next)} rows={2} autoGrow density="compact" hideDetails />;
                default:
                    return (
                        <VTextField
                            modelValue={typeof value === "string" ? value : ""}
                            onUpdate:modelValue={(next: string) => setValue(field.key, next)}
                            density="compact"
                            hideDetails
                            error={Boolean(errorText)}
                        />
                    );
            }
        };

        return (): VNodeChild => {
            const def = props.def;
            const errors = validateSettingForm(def, props.modelValue);
            const extrasCount = Object.keys(props.modelValue.extras).length;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px", minInlineSize: 0 }}>
                    {def && def.description && <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{t(def.description)}</span>}
                    {(def?.fields ?? []).map((field) => {
                        const found = errors.find((entry) => entry.field === field.key);
                        const errorText = found ? t(SETTING_ERROR_MESSAGES[found.code]) : "";
                        return (
                            <FormField key={field.key} label={t(field.label)} hint={field.hint ? t(field.hint) : ""} error={errorText} required={field.required === true}>
                                <div>{control(field, errorText)}</div>
                            </FormField>
                        );
                    })}
                    {(!def || def.fields.length === 0 || extrasCount > 0) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            {def && def.fields.length > 0 && <span style={{ fontSize: "13px", fontWeight: 500 }}>{t("Other fields")}</span>}
                            <StructuredValueEditor modelValue={props.modelValue.extras} onUpdate:modelValue={setExtras} ariaLabel={t("Setting value")} />
                        </div>
                    )}
                </div>
            );
        };
    },
});
