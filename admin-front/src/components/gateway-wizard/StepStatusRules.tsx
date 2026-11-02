import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VSelect, VTextField } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { WizardSection } from "./WizardSection";
import { Decimal } from "decimal.js";
import { formatMoney, toDecimal } from "@/utils/money";
import type { WizardErrorMap, WizardStatusRule } from "./types";
import type { WizardStepProps } from "./StepIdentity";

const CANONICAL_STATUSES = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
];

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: "14px",
} as const;

const errorTone = (entry: WizardErrorMap): BadgeTone => {
    if (entry.otpRetryable) return "warning";
    if (entry.retryable) return "info";
    return "danger";
};

export const StepStatusRules = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const sampleAmount = ref("100");
        const sampleFee = ref("3");
        const sampleGatewayFee = ref("0.8");

        const updateStatusRule = (index: number, patch: Partial<WizardStatusRule>) => {
            const statusRules = props.model.statusRules.map((rule, ruleIndex) =>
                ruleIndex === index ? { ...rule, ...patch } : rule,
            );
            props.onChange({ ...props.model, statusRules });
        };

        const updateErrorMap = (index: number, patch: Partial<WizardErrorMap>) => {
            const errorMaps = props.model.errorMaps.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, ...patch } : entry,
            );
            props.onChange({ ...props.model, errorMaps });
        };

        const addStatusRule = () => {
            props.onChange({
                ...props.model,
                statusRules: [
                    ...props.model.statusRules,
                    {
                        gatewayCode: "",
                        canonicalStatus: "SUCCEEDED",
                        messageAr: "",
                        messageEn: "",
                        terminal: true,
                    },
                ],
            });
        };

        const addErrorMap = () => {
            props.onChange({
                ...props.model,
                errorMaps: [
                    ...props.model.errorMaps,
                    {
                        gatewayCode: "",
                        canonicalStatus: "FAILED",
                        retryable: false,
                        otpRetryable: false,
                        messageAr: "",
                        messageEn: "",
                    },
                ],
            });
        };

        const pipeline = () => {
            const pipelineConfig = props.model.amountPipeline;
            const amount = toDecimal(sampleAmount.value);
            const scaled = amount.times(pipelineConfig.scale);
            const rounded = scaled.toDecimalPlaces(pipelineConfig.precision, roundingMode(pipelineConfig.rounding));
            return { scaled, rounded };
        };

        const cost = () => {
            const model = props.model.costModel;
            const amount = toDecimal(sampleAmount.value);
            const flat = toDecimal(model.flatFee);
            const percent = amount.times(toDecimal(model.percentFee)).dividedBy(100);
            let total = flat.plus(percent);
            const min = toDecimal(model.minFee);
            const max = toDecimal(model.maxFee);
            if (!min.isZero() && total.lessThan(min)) {
                total = min;
            }
            if (!max.isZero() && total.greaterThan(max)) {
                total = max;
            }
            return total;
        };

        return () => (
            <SurfaceCard title={t("Status Rules & Costs")}>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <WizardSection
                        title={t("Status Rule")}
                        v-slots={{
                            actions: () => (
                                <VBtn variant="tonal" size="small" onClick={addStatusRule}>
                                    {t("Add")}
                                </VBtn>
                            ),
                        }}
                    >
                        {props.model.statusRules.map((rule, index) => (
                            <WizardSection
                                key={index}
                                title={rule.gatewayCode || `${t("Status Rule")} ${index + 1}`}
                                divider={index > 0}
                                v-slots={{
                                    actions: () => (
                                        <StatusBadge status={rule.canonicalStatus} toneOverride="info" showDot={false} />
                                    ),
                                }}
                            >
                                <div style={gridStyle}>
                                    <FormField label="gateway_code">
                                        <VTextField
                                            modelValue={rule.gatewayCode}
                                            onUpdate:modelValue={(v: string) => updateStatusRule(index, { gatewayCode: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Status")}>
                                        <VSelect
                                            items={CANONICAL_STATUSES}
                                            modelValue={rule.canonicalStatus}
                                            onUpdate:modelValue={(v: any) => updateStatusRule(index, { canonicalStatus: v })}
                                        />
                                    </FormField>
                                    <FormField label="message_ar">
                                        <VTextField
                                            modelValue={rule.messageAr}
                                            onUpdate:modelValue={(v: string) => updateStatusRule(index, { messageAr: v })}
                                        />
                                    </FormField>
                                    <FormField label="message_en">
                                        <VTextField
                                            modelValue={rule.messageEn}
                                            onUpdate:modelValue={(v: string) => updateStatusRule(index, { messageEn: v })}
                                        />
                                    </FormField>
                                </div>
                            </WizardSection>
                        ))}
                    </WizardSection>

                    <WizardSection
                        title={t("Error Map")}
                        divider
                        v-slots={{
                            actions: () => (
                                <VBtn variant="tonal" size="small" onClick={addErrorMap}>
                                    {t("Add")}
                                </VBtn>
                            ),
                        }}
                    >
                        {props.model.errorMaps.map((entry, index) => (
                            <WizardSection
                                key={index}
                                title={entry.gatewayCode || `${t("Error Map")} ${index + 1}`}
                                divider={index > 0}
                                v-slots={{
                                    actions: () => (
                                        <StatusBadge
                                            status={entry.otpRetryable ? "RETRYABLE_OTP" : entry.retryable ? "RETRYABLE" : "FAILED"}
                                            label={entry.otpRetryable ? "RETRYABLE_OTP" : entry.retryable ? t("Retry") : t("Failed")}
                                            toneOverride={errorTone(entry)}
                                        />
                                    ),
                                }}
                            >
                                <div style={gridStyle}>
                                    <FormField label="gateway_code">
                                        <VTextField
                                            modelValue={entry.gatewayCode}
                                            onUpdate:modelValue={(v: string) => updateErrorMap(index, { gatewayCode: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Status")}>
                                        <VSelect
                                            items={CANONICAL_STATUSES}
                                            modelValue={entry.canonicalStatus}
                                            onUpdate:modelValue={(v: any) => updateErrorMap(index, { canonicalStatus: v })}
                                        />
                                    </FormField>
                                    <FormField label="message_ar">
                                        <VTextField
                                            modelValue={entry.messageAr}
                                            onUpdate:modelValue={(v: string) => updateErrorMap(index, { messageAr: v })}
                                        />
                                    </FormField>
                                    <FormField label="message_en">
                                        <VTextField
                                            modelValue={entry.messageEn}
                                            onUpdate:modelValue={(v: string) => updateErrorMap(index, { messageEn: v })}
                                        />
                                    </FormField>
                                </div>
                            </WizardSection>
                        ))}
                    </WizardSection>

                    <WizardSection title={t("Amount Pipeline")} divider>
                        <div style={gridStyle}>
                            <FormField label={t("Amount Scale")}>
                                <VTextField
                                    type="number"
                                    modelValue={props.model.amountPipeline.scale}
                                    onUpdate:modelValue={(v: any) =>
                                        props.onChange({
                                            ...props.model,
                                            amountPipeline: { ...props.model.amountPipeline, scale: Number(v) },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label={t("Amount Precision")}>
                                <VTextField
                                    type="number"
                                    modelValue={props.model.amountPipeline.precision}
                                    onUpdate:modelValue={(v: any) =>
                                        props.onChange({
                                            ...props.model,
                                            amountPipeline: { ...props.model.amountPipeline, precision: Number(v) },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label={t("Amount Rounding")}>
                                <VSelect
                                    items={["NONE", "NEAREST", "UP", "DOWN"]}
                                    modelValue={props.model.amountPipeline.rounding}
                                    onUpdate:modelValue={(v: any) =>
                                        props.onChange({
                                            ...props.model,
                                            amountPipeline: { ...props.model.amountPipeline, rounding: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label={t("Currency")}>
                                <VTextField
                                    modelValue={props.model.amountPipeline.currency}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            amountPipeline: { ...props.model.amountPipeline, currency: v.toUpperCase() },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label={t("Amount")}>
                                <VTextField
                                    modelValue={sampleAmount.value}
                                    onUpdate:modelValue={(v: string) => (sampleAmount.value = v)}
                                />
                            </FormField>
                        </div>

                        <DescriptionList
                            columns={2}
                            items={[
                                { label: t("Amount Scale"), value: pipeline().scaled.toString(), mono: true },
                                { label: t("Amount Due"), value: pipeline().rounded.toString(), mono: true },
                            ]}
                        />
                    </WizardSection>

                    <WizardSection title={t("Cost Model")} divider>
                        <div style={gridStyle}>
                            <FormField label={t("Cost Model")}>
                                <VSelect
                                    items={["FLAT", "PERCENT", "FLAT_PLUS_PERCENT"]}
                                    modelValue={props.model.costModel.model}
                                    onUpdate:modelValue={(v: any) =>
                                        props.onChange({
                                            ...props.model,
                                            costModel: { ...props.model.costModel, model: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label="flat_fee">
                                <VTextField
                                    modelValue={props.model.costModel.flatFee}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            costModel: { ...props.model.costModel, flatFee: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label="percent_fee">
                                <VTextField
                                    modelValue={props.model.costModel.percentFee}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            costModel: { ...props.model.costModel, percentFee: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label="min_fee">
                                <VTextField
                                    modelValue={props.model.costModel.minFee}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            costModel: { ...props.model.costModel, minFee: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label="max_fee">
                                <VTextField
                                    modelValue={props.model.costModel.maxFee}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            costModel: { ...props.model.costModel, maxFee: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label={t("Currency")}>
                                <VTextField
                                    modelValue={props.model.costModel.currency}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            costModel: { ...props.model.costModel, currency: v.toUpperCase() },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label="gateway_fee">
                                <VTextField
                                    modelValue={sampleGatewayFee.value}
                                    onUpdate:modelValue={(v: string) => (sampleGatewayFee.value = v)}
                                />
                            </FormField>
                        </div>

                        <DescriptionList
                            columns={2}
                            items={[
                                {
                                    label: t("Cost Model"),
                                    value: formatMoney(cost(), { currency: props.model.costModel.currency }),
                                },
                                {
                                    label: t("Net"),
                                    value: formatMoney(
                                        toDecimal(sampleAmount.value).minus(cost()).minus(toDecimal(sampleFee.value)),
                                        { currency: props.model.costModel.currency },
                                    ),
                                },
                            ]}
                        />
                    </WizardSection>

                    <WizardSection
                        title={t("Statement Source")}
                        divider
                        v-slots={{
                            actions: () => (
                                <VBtn
                                    variant="tonal"
                                    size="small"
                                    onClick={() =>
                                        props.onChange({
                                            ...props.model,
                                            statementMapping: {
                                                ...props.model.statementMapping,
                                                columnMapping: [
                                                    ...props.model.statementMapping.columnMapping,
                                                    { source: "", target: "" },
                                                ],
                                            },
                                        })
                                    }
                                >
                                    {t("Add")}
                                </VBtn>
                            ),
                        }}
                    >
                        <div style={gridStyle}>
                            <FormField label="source_id">
                                <VTextField
                                    modelValue={props.model.statementMapping.sourceId}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            statementMapping: { ...props.model.statementMapping, sourceId: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label={t("Type")}>
                                <VSelect
                                    items={["CSV", "XLSX", "JSON"]}
                                    modelValue={props.model.statementMapping.format}
                                    onUpdate:modelValue={(v: any) =>
                                        props.onChange({
                                            ...props.model,
                                            statementMapping: { ...props.model.statementMapping, format: v },
                                        })
                                    }
                                />
                            </FormField>
                            <FormField label="delimiter">
                                <VTextField
                                    modelValue={props.model.statementMapping.delimiter}
                                    onUpdate:modelValue={(v: string) =>
                                        props.onChange({
                                            ...props.model,
                                            statementMapping: { ...props.model.statementMapping, delimiter: v },
                                        })
                                    }
                                />
                            </FormField>
                        </div>

                        {props.model.statementMapping.columnMapping.map((mapping, index) => (
                            <div key={index} style={gridStyle}>
                                <FormField label={t("Column")}>
                                    <VTextField
                                        modelValue={mapping.source}
                                        onUpdate:modelValue={(v: string) => {
                                            const columnMapping = props.model.statementMapping.columnMapping.map(
                                                (entry, entryIndex) =>
                                                    entryIndex === index ? { ...entry, source: v } : entry,
                                            );
                                            props.onChange({
                                                ...props.model,
                                                statementMapping: { ...props.model.statementMapping, columnMapping },
                                            });
                                        }}
                                    />
                                </FormField>
                                <FormField label={t("Maps To")}>
                                    <VTextField
                                        modelValue={mapping.target}
                                        onUpdate:modelValue={(v: string) => {
                                            const columnMapping = props.model.statementMapping.columnMapping.map(
                                                (entry, entryIndex) =>
                                                    entryIndex === index ? { ...entry, target: v } : entry,
                                            );
                                            props.onChange({
                                                ...props.model,
                                                statementMapping: { ...props.model.statementMapping, columnMapping },
                                            });
                                        }}
                                    />
                                </FormField>
                            </div>
                        ))}
                    </WizardSection>
                </SurfaceCardText>
            </SurfaceCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

const roundingMode = (mode: string): Decimal.Rounding => {
    switch (mode) {
        case "NEAREST":
            return Decimal.ROUND_HALF_UP;
        case "UP":
            return Decimal.ROUND_UP;
        case "DOWN":
            return Decimal.ROUND_DOWN;
        default:
            return Decimal.ROUND_DOWN;
    }
};

export default StepStatusRules;
