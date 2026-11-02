import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VSwitch, VTextField } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FLOW_PHASES, type WizardFlowStep, type WizardTransform } from "./types";
import { WizardSection } from "./WizardSection";
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

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: "14px",
} as const;

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
                <SurfaceCard
                    title={t("Flow Builder")}
                    v-slots={{
                        headerActions: () => (
                            <>
                                <VBtn variant="tonal" size="small" onClick={validateAll}>
                                    {t("Preview")}
                                </VBtn>
                                <VBtn color="primary" size="small" onClick={addStep}>
                                    {t("Add")}
                                </VBtn>
                            </>
                        ),
                    }}
                >
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                        <SegmentedTabs
                            modelValue={phase}
                            tabs={FLOW_PHASES.map((item) => ({
                                value: item,
                                label: item,
                                count: flowForPhase(item).steps.length,
                            }))}
                            onUpdate:modelValue={(value: string) => (activePhase.value = value as WizardFlowStep["phase"])}
                            ariaLabel={t("Flow Builder")}
                        />

                        {validationErrors.value.length > 0 && (
                            <VAlert type="error" variant="tonal" density="compact">
                                <ul style={{ margin: 0, paddingInlineStart: "18px" }}>
                                    {validationErrors.value.map((error, index) => (
                                        <li key={index}>{error}</li>
                                    ))}
                                </ul>
                            </VAlert>
                        )}

                        {steps.map((step, stepIndex) => {
                            const errors = validateFlowStep(step);
                            return (
                                <WizardSection
                                    key={stepIndex}
                                    title={`${stepIndex + 1}. ${step.name || t("Step")}`}
                                    divider={stepIndex > 0}
                                    v-slots={{
                                        actions: () => (
                                            <>
                                                <StatusBadge
                                                    status={step.sideEffect}
                                                    toneOverride={step.sideEffect === "MOVES_MONEY" ? "danger" : "neutral"}
                                                    showDot={false}
                                                />
                                                {step.pointOfNoReturn && (
                                                    <StatusBadge
                                                        status="POINT_OF_NO_RETURN"
                                                        label={t("Point Of No Return")}
                                                        toneOverride="warning"
                                                        showDot={false}
                                                    />
                                                )}
                                                <StatusBadge
                                                    status={errors.length === 0 ? "PASSED" : "FAILED"}
                                                    label={errors.length === 0 ? t("Passed") : t("Failed")}
                                                    toneOverride={errors.length === 0 ? "success" : "danger"}
                                                />
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
                                            </>
                                        ),
                                    }}
                                >
                                    <div style={gridStyle}>
                                        <FormField label={t("Merchant Name")}>
                                            <VTextField
                                                modelValue={step.name}
                                                onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { name: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Step Type")}>
                                            <VSelect
                                                items={["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"]}
                                                modelValue={step.type}
                                                onUpdate:modelValue={(v: any) => updateStep(phase, stepIndex, { type: v })}
                                            />
                                        </FormField>
                                        <FormField label="method">
                                            <VTextField
                                                modelValue={step.method}
                                                onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { method: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Base URL")}>
                                            <VTextField
                                                modelValue={step.url}
                                                onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { url: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Side Effect")}>
                                            <VSelect
                                                items={["READ_ONLY", "SAFE_WITH_COOLDOWN", "SENDS_NOTIFICATION", "MOVES_MONEY"]}
                                                modelValue={step.sideEffect}
                                                onUpdate:modelValue={(v: any) => updateStep(phase, stepIndex, { sideEffect: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Retry Policy")}>
                                            <VSelect
                                                items={["NEVER", "SAFE", "IDEMPOTENT"]}
                                                modelValue={step.retryPolicy}
                                                onUpdate:modelValue={(v: any) => updateStep(phase, stepIndex, { retryPolicy: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Idempotency")}>
                                            <VTextField
                                                modelValue={step.idempotencyConfig}
                                                onUpdate:modelValue={(v: string) =>
                                                    updateStep(phase, stepIndex, { idempotencyConfig: v })
                                                }
                                            />
                                        </FormField>
                                        <FormField label="output">
                                            <VTextField
                                                modelValue={step.outputName}
                                                onUpdate:modelValue={(v: string) => updateStep(phase, stepIndex, { outputName: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Point Of No Return")}>
                                            <VSwitch
                                                modelValue={step.pointOfNoReturn}
                                                onUpdate:modelValue={(v: boolean | null) =>
                                                    updateStep(phase, stepIndex, { pointOfNoReturn: !!v })
                                                }
                                                density="compact"
                                                hideDetails
                                            />
                                        </FormField>
                                    </div>

                                    {step.type === "ASSERT" && (
                                        <FormField label="assert_expression">
                                            <VTextField
                                                modelValue={step.assertExpression}
                                                onUpdate:modelValue={(v: string) =>
                                                    updateStep(phase, stepIndex, { assertExpression: v })
                                                }
                                            />
                                        </FormField>
                                    )}

                                    <WizardSection
                                        title={t("Transforms")}
                                        divider
                                        v-slots={{
                                            actions: () => (
                                                <VBtn size="x-small" variant="tonal" onClick={() => addTransform(phase, stepIndex)}>
                                                    {t("Add")}
                                                </VBtn>
                                            ),
                                        }}
                                    >
                                        {(step.transforms ?? []).map((transform, transformIndex) => (
                                            <div
                                                key={transformIndex}
                                                style={{
                                                    display: "grid",
                                                    gridTemplateColumns: "minmax(180px, 1fr) minmax(220px, 1.4fr) auto",
                                                    gap: "12px",
                                                    alignItems: "end",
                                                }}
                                            >
                                                <FormField label={t("Type")}>
                                                    <VSelect
                                                        items={TRANSFORM_OPS}
                                                        modelValue={transform.op}
                                                        onUpdate:modelValue={(v: string) =>
                                                            updateTransform(phase, stepIndex, transformIndex, { op: v })
                                                        }
                                                    />
                                                </FormField>
                                                <FormField label={t("Params")}>
                                                    <VTextField
                                                        modelValue={(transform.args ?? []).join(",")}
                                                        onUpdate:modelValue={(v: string) =>
                                                            updateTransform(phase, stepIndex, transformIndex, {
                                                                args: v
                                                                    .split(",")
                                                                    .map((entry) => entry.trim())
                                                                    .filter((entry) => !!entry),
                                                            })
                                                        }
                                                    />
                                                </FormField>
                                                <VBtn
                                                    size="x-small"
                                                    variant="text"
                                                    color="error"
                                                    onClick={() => removeTransform(phase, stepIndex, transformIndex)}
                                                >
                                                    ×
                                                </VBtn>
                                            </div>
                                        ))}
                                    </WizardSection>

                                    {errors.length > 0 && (
                                        <VAlert type="warning" variant="tonal" density="compact">
                                            <ul style={{ margin: 0, paddingInlineStart: "18px" }}>
                                                {errors.map((error, index) => (
                                                    <li key={index}>{error}</li>
                                                ))}
                                            </ul>
                                        </VAlert>
                                    )}
                                </WizardSection>
                            );
                        })}
                    </SurfaceCardText>
                </SurfaceCard>
            );
        };
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepFlowBuilder;
