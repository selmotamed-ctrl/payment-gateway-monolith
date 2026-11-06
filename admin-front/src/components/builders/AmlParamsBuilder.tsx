import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VSelect, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormField } from "@/components/ui/FormField";
import { ChipListInput } from "./ChipListInput";
import { KeyValueSummary, type KeyValueItem } from "./KeyValueSummary";
import { AML_PARAM_ERROR_MESSAGES } from "./messages";
import {
    AML_PARAM_FIELDS,
    joinDuration,
    splitDuration,
    summarizeAmlParams,
    summarizeAmlScope,
    validateAmlParams,
    type AmlParamField,
    type AmlParamSummary,
    type AmlParamsState,
    type AmlRuleType,
    type DurationUnit,
} from "./model/amlRules";

const DURATION_UNITS: { value: DurationUnit; label: string }[] = [
    { value: "days", label: "Days" },
    { value: "hours", label: "Hours" },
    { value: "minutes", label: "Minutes" },
    { value: "seconds", label: "Seconds" },
];

const UNIT_ONE: Record<DurationUnit, string> = { days: "day", hours: "hour", minutes: "minute", seconds: "second" };
const UNIT_MANY: Record<DurationUnit, string> = { days: "days", hours: "hours", minutes: "minutes", seconds: "seconds" };

/** `86400` -> `1 day`, `7200` -> `2 hours` (translated). */
export const durationText = (seconds: number, translate: (key: string) => string): string => {
    const { value, unit } = splitDuration(seconds);
    return `${value} ${translate(value === 1 ? UNIT_ONE[unit] : UNIT_MANY[unit])}`;
};

/** Category-aware parameter form of an AML rule: the fields that the rule type really reads. */
export const AmlParamsBuilder = defineComponent({
    name: "AmlParamsBuilder",
    props: {
        ruleType: { type: String as PropType<AmlRuleType>, required: true },
        modelValue: { type: Object as PropType<AmlParamsState>, required: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const setValue = (key: string, value: string | string[]) =>
            emit("update:modelValue", { ...props.modelValue, form: { ...props.modelValue.form, [key]: value } });

        const control = (field: AmlParamField): VNodeChild => {
            const value = props.modelValue.form[field.key];
            const text = typeof value === "string" ? value : "";
            switch (field.kind) {
                case "select":
                    return (
                        <VSelect
                            modelValue={text || null}
                            onUpdate:modelValue={(next: string | null) => setValue(field.key, next ?? "")}
                            items={(field.options ?? []).map((option) => ({ title: option.charAt(0) + option.slice(1).toLowerCase().replaceAll("_", " "), value: option }))}
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
                                isInvalid={field.entryPattern ? (entry: string) => !field.entryPattern!.test(entry) : undefined}
                                ariaLabel={t(field.label)}
                            />
                        </div>
                    );
                case "window": {
                    const seconds = Number(text);
                    const split = text.trim() !== "" && Number.isInteger(seconds) && seconds > 0 ? splitDuration(seconds) : { value: Number.NaN, unit: "days" as DurationUnit };
                    const unit = split.unit;
                    return (
                        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                            <VTextField
                                type="number"
                                modelValue={Number.isNaN(split.value) ? "" : String(split.value)}
                                onUpdate:modelValue={(next: string) => {
                                    const parsed = Number(next);
                                    setValue(field.key, next.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? String(joinDuration(parsed, unit)) : "");
                                }}
                                density="compact"
                                hideDetails
                                style={{ flex: 1, minInlineSize: 0 }}
                            />
                            <VSelect
                                modelValue={unit}
                                onUpdate:modelValue={(next: DurationUnit) => {
                                    const current = Number.isNaN(split.value) ? 1 : split.value;
                                    setValue(field.key, String(joinDuration(current, next)));
                                }}
                                items={DURATION_UNITS.map((entry) => ({ title: t(entry.label), value: entry.value }))}
                                density="compact"
                                hideDetails
                                style={{ flex: "0 0 130px" }}
                            />
                        </div>
                    );
                }
                case "currency":
                    return <VTextField modelValue={text} onUpdate:modelValue={(next: string) => setValue(field.key, next.toUpperCase())} density="compact" hideDetails />;
                default:
                    return <VTextField modelValue={text} onUpdate:modelValue={(next: string) => setValue(field.key, next)} density="compact" hideDetails />;
            }
        };

        return (): VNodeChild => {
            const errors = validateAmlParams(props.ruleType, props.modelValue.form);
            const extras = props.modelValue.extras;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px", minInlineSize: 0 }}>
                    {AML_PARAM_FIELDS[props.ruleType].map((field) => {
                        const found = errors.find((entry) => entry.field === field.key);
                        const message = found ? `${t(AML_PARAM_ERROR_MESSAGES[found.code])}${found.value ? ` (${found.value})` : ""}` : "";
                        return (
                            <FormField key={`${props.ruleType}-${field.key}`} label={t(field.label)} hint={field.hint ? t(field.hint) : ""} error={message} required={field.required === true}>
                                <div>{control(field)}</div>
                            </FormField>
                        );
                    })}
                    {Object.keys(extras).length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <span style={{ fontSize: "13px", fontWeight: 500 }}>{t("Other parameters (kept as they are)")}</span>
                            <KeyValueSummary value={extras} compact />
                        </div>
                    )}
                </div>
            );
        };
    },
});

const paramItems = (rows: AmlParamSummary[], translate: (key: string) => string): KeyValueItem[] =>
    rows.map((row) => ({
        label: translate(row.label),
        ...(row.list ? { list: row.list } : row.seconds !== undefined ? { text: durationText(row.seconds, translate) } : { text: row.text ?? "—" }),
    }));

/** Human summary of a rule's params (labelled rows, formatted money / windows / lists). */
export const AmlParamsSummary = defineComponent({
    name: "AmlParamsSummary",
    props: {
        ruleType: { type: String, required: true },
        params: { type: null as unknown as PropType<unknown> },
        compact: { type: Boolean, default: false },
        maxRows: { type: Number, default: 0 },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => (
            <KeyValueSummary
                items={paramItems(summarizeAmlParams(props.ruleType, props.params), t)}
                compact={props.compact}
                maxRows={props.maxRows}
                emptyLabel={t("No parameters.")}
            />
        );
    },
});

/** Human summary of a rule's scope. An empty scope applies to every merchant and rail. */
export const AmlScopeSummary = defineComponent({
    name: "AmlScopeSummary",
    props: {
        scope: { type: null as unknown as PropType<unknown> },
    },
    setup(props) {
        const { t } = useLocale();
        return (): VNodeChild => (
            <KeyValueSummary items={paramItems(summarizeAmlScope(props.scope), t)} emptyLabel={t("All merchants and rails.")} />
        );
    },
});
