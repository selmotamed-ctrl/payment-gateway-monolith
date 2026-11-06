import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { FormField } from "@/components/ui/FormField";
import { ChipListInput, OptionChips } from "./ChipListInput";
import { MISMATCH_ERROR_MESSAGE, SCOPE_ERROR_MESSAGES } from "./messages";
import {
    ROUTE_CHANNELS,
    ROUTE_RISK_TIERS,
    UUID_PATTERN,
    isScopeEmpty,
    validateMismatchPolicy,
    validateRouteScope,
    type MismatchPolicyState,
    type RouteScopeForm,
    type RouteScopeState,
    type ScopeField,
} from "./model/index";

const RISK_LABELS: Record<string, string> = { LOW: "Low", STANDARD: "Standard", HIGH: "High" };
const CHANNEL_LABELS: Record<string, string> = { WEB: "Web", API: "API", POS: "POS" };

/**
 * Scope of a route: which merchants / applications / risk tiers / channels it serves.
 * An empty scope serves everyone; an empty list is never written (it would exclude every merchant).
 */
export const RouteScopeBuilder = defineComponent({
    name: "RouteScopeBuilder",
    props: {
        modelValue: { type: Object as PropType<RouteScopeState>, required: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const setField = (field: ScopeField, value: (string | number)[]) =>
            emit("update:modelValue", { ...props.modelValue, form: { ...props.modelValue.form, [field]: value.map(String) } });

        return (): VNodeChild => {
            const form = props.modelValue.form;
            const errors = validateRouteScope(form);
            const errorFor = (field: ScopeField): string => {
                const found = errors.find((entry) => entry.field === field);
                return found ? `${t(SCOPE_ERROR_MESSAGES[found.code])} (${found.value})` : "";
            };
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px", minInlineSize: 0 }}>
                    {isScopeEmpty(form) && (
                        <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>
                            {t("No restrictions: this route serves every merchant, application, risk tier and channel.")}
                        </span>
                    )}
                    <FormField label={t("Merchants")} hint={t("Merchant ids (UUID). Leave empty for all merchants.")} error={errorFor("merchantIds")}>
                        <div>
                            <ChipListInput
                                modelValue={form.merchantIds}
                                onUpdate:modelValue={(value: (string | number)[]) => setField("merchantIds", value)}
                                normalize={(value: string) => value.toLowerCase()}
                                isInvalid={(value: string) => !UUID_PATTERN.test(value)}
                                ariaLabel={t("Merchants")}
                                monospace
                            />
                        </div>
                    </FormField>
                    <FormField label={t("Applications")} hint={t("Application ids (UUID). Leave empty for all applications.")} error={errorFor("applicationIds")}>
                        <div>
                            <ChipListInput
                                modelValue={form.applicationIds}
                                onUpdate:modelValue={(value: (string | number)[]) => setField("applicationIds", value)}
                                normalize={(value: string) => value.toLowerCase()}
                                isInvalid={(value: string) => !UUID_PATTERN.test(value)}
                                ariaLabel={t("Applications")}
                                monospace
                            />
                        </div>
                    </FormField>
                    <FormField label={t("Risk tiers")} error={errorFor("riskTiers")}>
                        <div>
                            <OptionChips
                                modelValue={form.riskTiers}
                                options={ROUTE_RISK_TIERS.map((value) => ({ value, label: t(RISK_LABELS[value] ?? value) }))}
                                onUpdate:modelValue={(value: string[]) => setField("riskTiers", value)}
                                ariaLabel={t("Risk tiers")}
                            />
                        </div>
                    </FormField>
                    <FormField label={t("Channels")} error={errorFor("channels")}>
                        <div>
                            <OptionChips
                                modelValue={form.channels}
                                options={ROUTE_CHANNELS.map((value) => ({ value, label: t(CHANNEL_LABELS[value] ?? value) }))}
                                onUpdate:modelValue={(value: string[]) => setField("channels", value)}
                                ariaLabel={t("Channels")}
                            />
                        </div>
                    </FormField>
                </div>
            );
        };
    },
});

export const scopeFormHasErrors = (form: RouteScopeForm): boolean => validateRouteScope(form).length > 0;

/** Mismatch policy of a route (`tolerance_amount`); other keys of the stored policy are preserved untouched. */
export const MismatchPolicyBuilder = defineComponent({
    name: "MismatchPolicyBuilder",
    props: {
        modelValue: { type: Object as PropType<MismatchPolicyState>, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        return (): VNodeChild => {
            const invalid = validateMismatchPolicy(props.modelValue) !== null;
            return (
                <FormField
                    label={t("Mismatch tolerance amount")}
                    hint={t("Reconciliation differences up to this amount are accepted without a case.")}
                    error={invalid ? t(MISMATCH_ERROR_MESSAGE) : ""}
                >
                    <VTextField
                        modelValue={props.modelValue.toleranceAmount}
                        onUpdate:modelValue={(value: string) => emit("update:modelValue", { ...props.modelValue, toleranceAmount: value })}
                        readonly={props.readonly}
                        density="compact"
                        hideDetails
                    />
                </FormField>
            );
        };
    },
});
