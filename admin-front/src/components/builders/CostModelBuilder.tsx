import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VSelect, VSwitch, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormField } from "@/components/ui/FormField";
import { RepeatableRows } from "./RepeatableRows";
import { COST_ERROR_MESSAGES } from "./messages";
import {
    COST_CALC_TYPES,
    formatCostModel,
    serializeCostModel,
    validateCostModel,
    type CostCalcType,
    type CostModelForm,
    type CostModelState,
    type CostTierForm,
} from "./model/costModel";

const CALC_LABELS: Record<CostCalcType, string> = {
    FLAT: "Flat fee",
    PERCENTAGE: "Percentage",
    TIERED: "Tiered",
    HYBRID: "Hybrid (percentage + flat)",
};

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px 12px" } as const;

/**
 * Structured editor of a route cost model. Edits a `CostModelState` (see `model/costModel.ts`):
 * unknown keys and the stored key spellings are preserved by `serializeCostModel`.
 */
export const CostModelBuilder = defineComponent({
    name: "CostModelBuilder",
    props: {
        modelValue: { type: Object as PropType<CostModelState>, required: true },
        currency: { type: String, default: "LYD" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();

        const patch = (change: Partial<CostModelForm>) =>
            emit("update:modelValue", { ...props.modelValue, form: { ...props.modelValue.form, ...change } });
        const patchTier = (index: number, change: Partial<CostTierForm>) =>
            patch({ tiers: props.modelValue.form.tiers.map((tier, position) => (position === index ? { ...tier, ...change } : tier)) });

        return (): VNodeChild => {
            const form = props.modelValue.form;
            const errors = validateCostModel(form);
            const errorFor = (field: string): string => {
                const found = errors.find((entry) => entry.field === field);
                return found ? t(COST_ERROR_MESSAGES[found.code]) : "";
            };
            const tiered = form.calcType === "TIERED" || form.calcType === "HYBRID" || form.tiers.length > 0;
            const preview = errors.length === 0 ? formatCostModel(serializeCostModel(props.modelValue), { currency: props.currency, labels: { min: t("min"), max: t("max"), tiers: t("tiers"), tiered: t("Tiered") } }) : "";
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px", minInlineSize: 0 }}>
                    <div style={GRID}>
                        <FormField label={t("Calculation type")}>
                            <VSelect
                                modelValue={form.calcType || null}
                                onUpdate:modelValue={(value: CostCalcType | null) => patch({ calcType: value ?? "" })}
                                items={COST_CALC_TYPES.map((value) => ({ title: t(CALC_LABELS[value]), value }))}
                                clearable
                                density="compact"
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Flat fee")} error={errorFor("flat")}>
                            <VTextField modelValue={form.flat} onUpdate:modelValue={(value: string) => patch({ flat: value })} density="compact" hideDetails />
                        </FormField>
                        <FormField label={t("Percentage (%)")} error={errorFor("percent")}>
                            <VTextField modelValue={form.percent} onUpdate:modelValue={(value: string) => patch({ percent: value })} density="compact" hideDetails />
                        </FormField>
                        <FormField label={t("Minimum fee")} error={errorFor("min")}>
                            <VTextField modelValue={form.min} onUpdate:modelValue={(value: string) => patch({ min: value })} density="compact" hideDetails />
                        </FormField>
                        <FormField label={t("Maximum fee")} error={errorFor("max")}>
                            <VTextField modelValue={form.max} onUpdate:modelValue={(value: string) => patch({ max: value })} density="compact" hideDetails />
                        </FormField>
                    </div>
                    <VSwitch
                        modelValue={form.accrueFeeAtConfirm}
                        onUpdate:modelValue={(value: boolean | null) => patch({ accrueFeeAtConfirm: value === true })}
                        label={t("Accrue the fee when the payment is confirmed")}
                        color="primary"
                        density="compact"
                        hideDetails
                    />
                    {(tiered || errorFor("tiers")) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            <span style={{ fontSize: "13px", fontWeight: 500 }}>{t("Fee tiers")}</span>
                            {errorFor("tiers") && (
                                <span role="alert" style={{ fontSize: "12px", color: "var(--pg-status-danger-text)" }}>{errorFor("tiers")}</span>
                            )}
                            <RepeatableRows
                                count={form.tiers.length}
                                addLabel={t("Add tier")}
                                emptyLabel={t("No tiers defined.")}
                                removeLabel={t("Remove tier")}
                                rowLabel={(index: number) => `${t("Tier")} ${index + 1}`}
                                onAdd={() => patch({ tiers: [...form.tiers, { upTo: "", flat: "", percent: "", meta: { keys: {}, originals: {}, extras: {} } }] })}
                                onRemove={(index: number) => patch({ tiers: form.tiers.filter((_, position) => position !== index) })}
                                v-slots={{
                                    default: ({ index }: { index: number }) => {
                                        const tier = form.tiers[index]!;
                                        return (
                                            <div style={GRID}>
                                                <FormField label={t("Up to amount")} error={errorFor(`tiers.${index}.upTo`) || errorFor(`tiers.${index}`)} hint={index === form.tiers.length - 1 ? t("Leave empty for the last open-ended tier.") : ""}>
                                                    <VTextField modelValue={tier.upTo} onUpdate:modelValue={(value: string) => patchTier(index, { upTo: value })} density="compact" hideDetails />
                                                </FormField>
                                                <FormField label={t("Flat fee")} error={errorFor(`tiers.${index}.flat`)}>
                                                    <VTextField modelValue={tier.flat} onUpdate:modelValue={(value: string) => patchTier(index, { flat: value })} density="compact" hideDetails />
                                                </FormField>
                                                <FormField label={t("Percentage (%)")} error={errorFor(`tiers.${index}.percent`)}>
                                                    <VTextField modelValue={tier.percent} onUpdate:modelValue={(value: string) => patchTier(index, { percent: value })} density="compact" hideDetails />
                                                </FormField>
                                            </div>
                                        );
                                    },
                                }}
                            />
                        </div>
                    )}
                    {preview && (
                        <span style={{ fontSize: "12.5px", color: "var(--pg-ink-secondary)" }}>
                            {t("Effective cost")}: <strong dir="ltr">{preview}</strong>
                        </span>
                    )}
                </div>
            );
        };
    },
});

/** First validation message of a cost model form, translated; `""` when valid. */
export const firstCostError = (form: CostModelForm, translate: (key: string) => string): string => {
    const first = validateCostModel(form)[0];
    return first ? translate(COST_ERROR_MESSAGES[first.code]) : "";
};
