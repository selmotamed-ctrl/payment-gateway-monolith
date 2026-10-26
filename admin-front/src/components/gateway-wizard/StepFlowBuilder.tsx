import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VSelect, VTextField, VTextarea, VSwitch } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { FLOW_PHASES, type WizardFlowStep, type WizardTransform } from "./types";
import type { WizardStepProps } from "./StepIdentity";

const TRANSFORM_OPS = [
    "scale",
    "MUL_INT",
    "DIV_DECIMAL",
    "round",
    "format_decimal",
    "to_int",
    "to_number",
    "to_string",
    "concat",
    "template",
    "lowercase",
    "uppercase",
    "trim",
    "pad_left",
    "pad_right",
    "substring",
    "mask",
    "prepend",
    "arabic_digits_to_ascii",
    "phone_normalize",
    "sort_keys",
    "values_only",
    "join_pairs",
    "format_date",
    "epoch_seconds",
    "epoch_millis",
    "uuid",
    "numeric_random",
    "base64_encode",
    "hex_lower",
    "hex_upper",
    "url_encode",
    "json_encode",
    "xml_escape",
    "sha256",
    "sha512",
    "hmac_sha256",
    "hmac_sha512",
    "rsa_sha256_sign",
];

export const validateFlowStep = (step: WizardFlowStep): string[] => {
    const errors: string[] = [];
    if (!step.name) {
        errors.push("step name is required");
    }
    if (step.type === "HTTP") {
        if (!/^https:\/\//i.test(step.url ?? "")) {
            errors.push("HTTP steps require an https URL (plain http and SSRF targets are rejected)");
        }
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes((step.method ?? "").toUpperCase())) {
            errors.push("HTTP steps require a valid method");
        }
    }
    if (step.type === "ASSERT" && !step.assertExpression) {
        errors.push("ASSERT steps require an assertion expression");
    }
    if (step.sideEffect === "MOVES_MONEY" && step.retryPolicy !== "NEVER") {
        errors.push("steps with side_effect = MOVES_MONEY must use retry_policy = NEVER");
    }
    if (step.pointOfNoReturn && step.retryPolicy === "SAFE") {
        errors.push("a point of no return step cannot use retry_policy = SAFE");
    }
    for (const transform of step.transforms ?? []) {
        if (!TRANSFORM_OPS.includes(transform.op)) {
            errors.push(`transform op '${transform.op}' is not part of the closed transform library`);
        }
        if (transform.op === "scale" && !transform.args?.[0]) {
            errors.push("transform op 'scale' requires a factor argument");
        }
        if (transform.op === "DIV_DECIMAL" && !transform.args?.[0]) {
            errors.push("transform op 'DIV_DECIMAL' requires a divisor argument");
        }
        if (transform.op.startsWith("hmac_") && !transform.args?.[0]) {
            errors.push(`transform op '${transform.op}' requires a key reference argument`);
        }
    }
    return errors;
};

const emptyStep = (phase: WizardFlowStep["phase"], order: number): WizardFlowStep => ({
    phase,
    order,
    type: "HTTP",
    name: "",
    method: "POST",
    url: "",
    sideEffect: "READ_ONLY",
    retryPolicy: "SAFE",
    idempotencyConfig: "",
    pointOfNoReturn: false,
    transforms: [],
    assertExpression: "",
    outputName: "",
});

export const StepFlowBuilder = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const activePhase = ref<WizardFlowStep["phase"]>("INITIATE");
        const validationErrors = ref<string[]>([]);

        const flows = computed(() => props.model.flows ?? []);

        const flowForPhase = (phase: WizardFlowStep["phase"]) =>
            flows.value.find((flow) => flow.phase === phase) ?? { phase, steps: [] };

        const updatePhase = (phase: WizardFlowStep["phase"], steps: WizardFlowStep[]) => {
            const existing = flows.value.some((flow) => flow.phase === phase);
            const nextFlows = existing
                ? flows.value.map((flow) => (flow.phase === phase ? { ...flow, steps } : flow))
                : [...flows.value, { phase, steps }];
            props.onChange({ ...props.model, flows: nextFlows });
        };

        const updateStep = (phase: WizardFlowStep["phase"], index: number, patch: Partial<WizardFlowStep>) => {
            const steps = flowForPhase(phase).steps.map((step, stepIndex) =>
                stepIndex === index ? { ...step, ...patch } : step,
            );
            updatePhase(phase, steps);
        };

        const addStep = () => {
            const phase = activePhase.value;
            const steps = [...flowForPhase(phase).steps, emptyStep(phase, flowForPhase(phase).steps.length + 1)];
            updatePhase(phase, steps);
        };

        const removeStep = (phase: WizardFlowStep["phase"], index: number) => {
            updatePhase(
                phase,
                flowForPhase(phase).steps.filter((_, stepIndex) => stepIndex !== index),
            );
        };

        const moveStep = (phase: WizardFlowStep["phase"], index: number, direction: -1 | 1) => {
            const steps = [...flowForPhase(phase).steps];
            const target = index + direction;
            if (target < 0 || target >= steps.length) {
                return;
            }
            const [moved] = steps.splice(index, 1);
            steps.splice(target, 0, moved!);
            updatePhase(
                phase,
                steps.map((step, stepIndex) => ({ ...step, order: stepIndex + 1 })),
            );
        };

        const validateAll = () => {
            const errors: string[] = [];
            for (const flow of flows.value) {
                for (const step of flow.steps) {
                    for (const error of validateFlowStep(step)) {
                        errors.push(`${flow.phase} · ${step.name || "step"}: ${error}`);
                    }
                }
            }
            validationErrors.value = errors;
        };

        const updateTransform = (
            phase: WizardFlowStep["phase"],
            stepIndex: number,
            transformIndex: number,
            patch: Partial<WizardTransform>,
        ) => {
            const step = flowForPhase(phase).steps[stepIndex];
            if (!step) {
                return;
            }
            const transforms = (step.transforms ?? []).map((transform, index) =>
                index === transformIndex ? { ...transform, ...patch } : transform,
            );
            updateStep(phase, stepIndex, { transforms });
        };

        const addTransform = (phase: WizardFlowStep["phase"], stepIndex: number) => {
            const step = flowForPhase(phase).steps[stepIndex];
            if (!step) {
                return;
            }
            updateStep(phase, stepIndex, { transforms: [...(step.transforms ?? []), { op: "to_string", args: [] }] });
        };

        const removeTransform = (phase: WizardFlowStep["phase"], stepIndex: number, transformIndex: number) => {
            const step = flowForPhase(phase).steps[stepIndex];
            if (!step) {
                return;
            }
            updateStep(phase, stepIndex, {
                transforms: (step.transforms ?? []).filter((_, index) => index !== transformIndex),
            });
        };

        return () => {
            const phase = activePhase.value;
            const steps = flowForPhase(phase).steps;

            return (
                <ThemedView style={{ gap: "16px" }}>
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView
                                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                            >
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                    {t("Flow Builder")}
                                </ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "8px" }}>
                                    <VBtn variant="tonal" size="small" onClick={validateAll}>
                                        {t("Preview")}
                                    </VBtn>
                                    <VBtn color="primary" size="small" onClick={addStep}>
                                        {t("Add")}
                                    </VBtn>
                                </ThemedView>
                            </ThemedView>

                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                {FLOW_PHASES.map((item) => {
                                    const count = flowForPhase(item).steps.length;
                                    return (
                                        <VBtn
                                            key={item}
                                            size="small"
                                            variant={item === phase ? "flat" : "tonal"}
                                            color={item === phase ? "primary" : undefined}
                                            onClick={() => (activePhase.value = item)}
                                        >
                                            {item} ({count})
                                        </VBtn>
                                    );
                                })}
                            </ThemedView>

                            {validationErrors.value.length > 0 && (
                                <VAlert type="error" variant="tonal" density="compact">
                                    <ul style={{ margin: 0, paddingInlineStart: "18px" }}>
                                        {validationErrors.value.map((error, index) => (
                                            <li key={index}>{error}</li>
                                        ))}
                                    </ul>
                                </VAlert>
                            )}
                        </VCardText>
                    </VCard>

                    {steps.map((step, stepIndex) => {
                        const errors = validateFlowStep(step);
                        return (
                            <VCard key={stepIndex}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedView
                                        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                                    >
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                            <ThemedText type="defaultSemiBold">
                                                {stepIndex + 1}. {step.name || t("Step")}
                                            </ThemedText>
                                            <StatusChip
                                                label={step.sideEffect}
                                                tone={step.sideEffect === "MOVES_MONEY" ? "error" : "neutral"}
                                            />
                                            {step.pointOfNoReturn && <StatusChip label={t("Point Of No Return")} tone="warning" />}
                                            {errors.length === 0 ? (
                                                <StatusChip label={t("Passed")} tone="success" />
                                            ) : (
                                                <StatusChip label={t("Failed")} tone="error" />
                                            )}
                                        </ThemedView>
                                        <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                                            <VBtn size="x-small" variant="text" onClick={() => moveStep(phase, stepIndex, -1)}>
                                                ↑
                                            </VBtn>
                                            <VBtn size="x-small" variant="text" onClick={() => moveStep(phase, stepIndex, 1)}>
                                                ↓
                                            </VBtn>
                                            <VBtn
                                                size="x-small"
                                                variant="text"
                                                color="error"
                                                onClick={() => removeStep(phase, stepIndex)}
                                            >
                                                ×
                                            </VBtn>
                                        </ThemedView>
                                    </ThemedView>

                                    <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                        <VTextField
                                            label={t("Merchant Name")}
                                            modelValue={step.name}
                                            onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { name: v })}
                                            style={{ minWidth: "200px" }}
                                        />
                                        <VSelect
                                            items={["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"]}
                                            modelValue={step.type}
                                            onUpdate:modelValue={(v: any) => updateStep(phase, stepIndex, { type: v })}
                                            label={t("Step Type")}
                                            style={{ minWidth: "160px" }}
                                        />
                                        <VTextField
                                            label="method"
                                            modelValue={step.method}
                                            onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { method: v })}
                                            style={{ minWidth: "120px" }}
                                        />
                                        <VTextField
                                            label={t("Base URL")}
                                            modelValue={step.url}
                                            onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { url: v })}
                                            style={{ minWidth: "300px" }}
                                        />
                                        <VSelect
                                            items={["READ_ONLY", "SAFE_WITH_COOLDOWN", "SENDS_NOTIFICATION", "MOVES_MONEY"]}
                                            modelValue={step.sideEffect}
                                            onUpdate:modelValue={(v: any) => updateStep(phase, stepIndex, { sideEffect: v })}
                                            label={t("Side Effect")}
                                            style={{ minWidth: "200px" }}
                                        />
                                        <VSelect
                                            items={["NEVER", "SAFE", "IDEMPOTENT"]}
                                            modelValue={step.retryPolicy}
                                            onUpdate:modelValue={(v: any) => updateStep(phase, stepIndex, { retryPolicy: v })}
                                            label={t("Retry Policy")}
                                            style={{ minWidth: "160px" }}
                                        />
                                        <VTextField
                                            label={t("Idempotency")}
                                            modelValue={step.idempotencyConfig}
                                            onUpdate:modelValue={(v: string) =>
                                                updateStep(phase, stepIndex, { idempotencyConfig: v })
                                            }
                                            style={{ minWidth: "180px" }}
                                        />
                                        <VTextField
                                            label="output"
                                            modelValue={step.outputName}
                                            onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { outputName: v })}
                                            style={{ minWidth: "160px" }}
                                        />
                                    </ThemedView>

                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "12px" }}>
                                        <VSwitch
                                            label={t("Point Of No Return")}
                                            modelValue={step.pointOfNoReturn}
                                            onUpdate:modelValue={(v: boolean | null) =>
                                                updateStep(phase, stepIndex, { pointOfNoReturn: !!v })
                                            }
                                            density="compact"
                                            hideDetails
                                        />
                                    </ThemedView>

                                    {step.type === "ASSERT" && (
                                        <VTextField
                                            label="assert_expression"
                                            modelValue={step.assertExpression}
                                            onUpdate:modelValue={(v: string) =>
                                                updateStep(phase, stepIndex, { assertExpression: v })
                                            }
                                        />
                                    )}

                                    <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                                        <ThemedView
                                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                                        >
                                            <ThemedText type="defaultSemiBold">{t("Transforms")}</ThemedText>
                                            <VBtn size="x-small" variant="tonal" onClick={() => addTransform(phase, stepIndex)}>
                                                {t("Add")}
                                            </VBtn>
                                        </ThemedView>
                                        {(step.transforms ?? []).map((transform, transformIndex) => (
                                            <ThemedView key={transformIndex} style={{ flexDirection: "row", gap: "10px", alignItems: "center" }}>
                                                <VSelect
                                                    items={TRANSFORM_OPS}
                                                    modelValue={transform.op}
                                                    onUpdate:modelValue={(v: string) =>
                                                        updateTransform(phase, stepIndex, transformIndex, { op: v })
                                                    }
                                                    label={t("Type")}
                                                    style={{ minWidth: "240px" }}
                                                />
                                                <VTextField
                                                    label={t("Params")}
                                                    modelValue={(transform.args ?? []).join(",")}
                                                    onUpdate:modelValue={(v: string) =>
                                                        updateTransform(phase, stepIndex, transformIndex, {
                                                            args: v
                                                                .split(",")
                                                                .map((entry) => entry.trim())
                                                                .filter((entry) => !!entry),
                                                        })
                                                    }
                                                    style={{ minWidth: "260px" }}
                                                />
                                                <VBtn
                                                    size="x-small"
                                                    variant="text"
                                                    color="error"
                                                    onClick={() => removeTransform(phase, stepIndex, transformIndex)}
                                                >
                                                    ×
                                                </VBtn>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>

                                    {errors.length > 0 && (
                                        <VAlert type="warning" variant="tonal" density="compact">
                                            <ul style={{ margin: 0, paddingInlineStart: "18px" }}>
                                                {errors.map((error, index) => (
                                                    <li key={index}>{error}</li>
                                                ))}
                                            </ul>
                                        </VAlert>
                                    )}
                                </VCardText>
                            </VCard>
                        );
                    })}
                </ThemedView>
            );
        };
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepFlowBuilder;
