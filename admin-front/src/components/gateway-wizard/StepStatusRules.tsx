import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
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
            <ThemedView style={{ gap: "16px" }}>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView
                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                        >
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                {t("Status Rule")}
                            </ThemedText>
                            <VBtn variant="tonal" size="small" onClick={addStatusRule}>
                                {t("Add")}
                            </VBtn>
                        </ThemedView>

                        {props.model.statusRules.map((rule, index) => (
                            <ThemedView
                                key={index}
                                style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "center" }}
                            >
                                <VTextField
                                    label="gateway_code"
                                    modelValue={rule.gatewayCode}
                                    onUpdate:modelValue={(v: string) => updateStatusRule(index, { gatewayCode: v })}
                                    style={{ minWidth: "160px" }}
                                />
                                <VSelect
                                    items={CANONICAL_STATUSES}
                                    modelValue={rule.canonicalStatus}
                                    onUpdate:modelValue={(v: any) => updateStatusRule(index, { canonicalStatus: v })}
                                    label={t("Status")}
                                    style={{ minWidth: "200px" }}
                                />
                                <VTextField
                                    label="message_ar"
                                    modelValue={rule.messageAr}
                                    onUpdate:modelValue={(v: string) => updateStatusRule(index, { messageAr: v })}
                                    style={{ minWidth: "220px" }}
                                />
                                <VTextField
                                    label="message_en"
                                    modelValue={rule.messageEn}
                                    onUpdate:modelValue={(v: string) => updateStatusRule(index, { messageEn: v })}
                                    style={{ minWidth: "220px" }}
                                />
                                <StatusChip label={rule.canonicalStatus} tone="info" />
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView
                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                        >
                            <ThemedText type="defaultSemiBold">{t("Error Map")}</ThemedText>
                            <VBtn variant="tonal" size="small" onClick={addErrorMap}>
                                {t("Add")}
                            </VBtn>
                        </ThemedView>

                        {props.model.errorMaps.map((entry, index) => (
                            <ThemedView
                                key={index}
                                style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "center" }}
                            >
                                <VTextField
                                    label="gateway_code"
                                    modelValue={entry.gatewayCode}
                                    onUpdate:modelValue={(v: string) => updateErrorMap(index, { gatewayCode: v })}
                                    style={{ minWidth: "150px" }}
                                />
                                <VSelect
                                    items={CANONICAL_STATUSES}
                                    modelValue={entry.canonicalStatus}
                                    onUpdate:modelValue={(v: any) => updateErrorMap(index, { canonicalStatus: v })}
                                    label={t("Status")}
                                    style={{ minWidth: "190px" }}
                                />
                                <VTextField
                                    label="message_ar"
                                    modelValue={entry.messageAr}
                                    onUpdate:modelValue={(v: string) => updateErrorMap(index, { messageAr: v })}
                                    style={{ minWidth: "210px" }}
                                />
                                <VTextField
                                    label="message_en"
                                    modelValue={entry.messageEn}
                                    onUpdate:modelValue={(v: string) => updateErrorMap(index, { messageEn: v })}
                                    style={{ minWidth: "210px" }}
                                />
                                <StatusChip
                                    label={entry.otpRetryable ? "RETRYABLE_OTP" : entry.retryable ? t("Retry") : t("Failed")}
                                    tone={entry.otpRetryable ? "warning" : entry.retryable ? "info" : "error"}
                                />
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{t("Amount Pipeline")}</ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField
                                label={t("Amount Scale")}
                                type="number"
                                modelValue={props.model.amountPipeline.scale}
                                onUpdate:modelValue={(v: any) =>
                                    props.onChange({
                                        ...props.model,
                                        amountPipeline: { ...props.model.amountPipeline, scale: Number(v) },
                                    })
                                }
                                style={{ minWidth: "150px" }}
                            />
                            <VTextField
                                label={t("Amount Precision")}
                                type="number"
                                modelValue={props.model.amountPipeline.precision}
                                onUpdate:modelValue={(v: any) =>
                                    props.onChange({
                                        ...props.model,
                                        amountPipeline: { ...props.model.amountPipeline, precision: Number(v) },
                                    })
                                }
                                style={{ minWidth: "160px" }}
                            />
                            <VSelect
                                items={["NONE", "NEAREST", "UP", "DOWN"]}
                                modelValue={props.model.amountPipeline.rounding}
                                onUpdate:modelValue={(v: any) =>
                                    props.onChange({
                                        ...props.model,
                                        amountPipeline: { ...props.model.amountPipeline, rounding: v },
                                    })
                                }
                                label={t("Amount Rounding")}
                                style={{ minWidth: "180px" }}
                            />
                            <VTextField
                                label={t("Currency")}
                                modelValue={props.model.amountPipeline.currency}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        amountPipeline: { ...props.model.amountPipeline, currency: v.toUpperCase() },
                                    })
                                }
                                style={{ minWidth: "130px" }}
                            />
                            <VTextField
                                label={t("Amount")}
                                modelValue={sampleAmount.value}
                                onUpdate:modelValue={(v: string) => (sampleAmount.value = v)}
                                style={{ minWidth: "150px" }}
                            />
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "row", gap: "18px", flexWrap: "wrap" }}>
                            <ThemedText style={{ fontSize: "13px" }}>
                                {t("Amount Scale")}: {pipeline().scaled.toString()}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", fontWeight: "700" }}>
                                {t("Amount Due")}: {pipeline().rounded.toString()}
                            </ThemedText>
                        </ThemedView>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{t("Cost Model")}</ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VSelect
                                items={["FLAT", "PERCENT", "FLAT_PLUS_PERCENT"]}
                                modelValue={props.model.costModel.model}
                                onUpdate:modelValue={(v: any) =>
                                    props.onChange({
                                        ...props.model,
                                        costModel: { ...props.model.costModel, model: v },
                                    })
                                }
                                label={t("Cost Model")}
                                style={{ minWidth: "200px" }}
                            />
                            <VTextField
                                label="flat_fee"
                                modelValue={props.model.costModel.flatFee}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        costModel: { ...props.model.costModel, flatFee: v },
                                    })
                                }
                                style={{ minWidth: "140px" }}
                            />
                            <VTextField
                                label="percent_fee"
                                modelValue={props.model.costModel.percentFee}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        costModel: { ...props.model.costModel, percentFee: v },
                                    })
                                }
                                style={{ minWidth: "140px" }}
                            />
                            <VTextField
                                label="min_fee"
                                modelValue={props.model.costModel.minFee}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        costModel: { ...props.model.costModel, minFee: v },
                                    })
                                }
                                style={{ minWidth: "130px" }}
                            />
                            <VTextField
                                label="max_fee"
                                modelValue={props.model.costModel.maxFee}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        costModel: { ...props.model.costModel, maxFee: v },
                                    })
                                }
                                style={{ minWidth: "130px" }}
                            />
                            <VTextField
                                label={t("Currency")}
                                modelValue={props.model.costModel.currency}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        costModel: { ...props.model.costModel, currency: v.toUpperCase() },
                                    })
                                }
                                style={{ minWidth: "130px" }}
                            />
                            <VTextField
                                label="gateway_fee"
                                modelValue={sampleGatewayFee.value}
                                onUpdate:modelValue={(v: string) => (sampleGatewayFee.value = v)}
                                style={{ minWidth: "150px" }}
                            />
                        </ThemedView>

                        <ThemedText style={{ fontSize: "13px" }}>
                            {t("Cost Model")}: {formatMoney(cost(), { currency: props.model.costModel.currency })} ·{" "}
                            {t("Net")}:{" "}
                            {formatMoney(
                                toDecimal(sampleAmount.value).minus(cost()).minus(toDecimal(sampleFee.value)),
                                { currency: props.model.costModel.currency },
                            )}
                        </ThemedText>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{t("Statement Source")}</ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField
                                label="source_id"
                                modelValue={props.model.statementMapping.sourceId}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        statementMapping: { ...props.model.statementMapping, sourceId: v },
                                    })
                                }
                                style={{ minWidth: "180px" }}
                            />
                            <VSelect
                                items={["CSV", "XLSX", "JSON"]}
                                modelValue={props.model.statementMapping.format}
                                onUpdate:modelValue={(v: any) =>
                                    props.onChange({
                                        ...props.model,
                                        statementMapping: { ...props.model.statementMapping, format: v },
                                    })
                                }
                                label={t("Type")}
                                style={{ minWidth: "160px" }}
                            />
                            <VTextField
                                label="delimiter"
                                modelValue={props.model.statementMapping.delimiter}
                                onUpdate:modelValue={(v: string) =>
                                    props.onChange({
                                        ...props.model,
                                        statementMapping: { ...props.model.statementMapping, delimiter: v },
                                    })
                                }
                                style={{ minWidth: "130px" }}
                            />
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            {props.model.statementMapping.columnMapping.map((mapping, index) => (
                                <ThemedView key={index} style={{ flexDirection: "row", gap: "10px", alignItems: "center" }}>
                                    <VTextField
                                        label={t("Column")}
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
                                        style={{ minWidth: "220px" }}
                                    />
                                    <VTextField
                                        label={t("Maps To")}
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
                                        style={{ minWidth: "220px" }}
                                    />
                                </ThemedView>
                            ))}
                            <VBtn
                                variant="tonal"
                                size="small"
                                style={{ alignSelf: "flex-start" }}
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
                        </ThemedView>
                    </VCardText>
                </VCard>
            </ThemedView>
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
