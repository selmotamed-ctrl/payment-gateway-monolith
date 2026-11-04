import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VSelect, VTextField, VTextarea } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { WizardSection } from "./WizardSection";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import type { WizardStepProps } from "./StepIdentity";

const DRY_RUN_CHECKS = [
    { key: "PHASE_SELECTED", label: "Dry-run phase selected" },
    { key: "SAMPLE_PAYLOAD_REVIEWED", label: "Sample payload reviewed" },
    { key: "CREDENTIAL_CONTEXT_READY", label: "Credential context ready" },
    { key: "RESULT_INTERPRETATION_REVIEWED", label: "Result interpretation reviewed" },
] as const;

const SUITE_CHECKS = [
    { key: "SUITE_SELECTED", label: "Test suite selected" },
    { key: "SANDBOX_ENV_VERIFIED", label: "Sandbox environment verified" },
    { key: "EVIDENCE_CAPTURE_READY", label: "Evidence capture ready" },
    { key: "RESULTS_REVIEW_PLANNED", label: "Results review planned" },
] as const;

const SUBMIT_CHECKS = [
    { key: "GATES_REVIEWED", label: "Go-live gates reviewed" },
    { key: "EVIDENCE_VERIFIED", label: "Sandbox evidence verified" },
    { key: "ROLLBACK_READY", label: "Rollback version ready" },
    { key: "CHECKER_INDEPENDENCE_CONFIRMED", label: "Checker independence confirmed" },
] as const;

const GO_LIVE_GATE_KEYS = [
    "MAKER_CHECKER_APPROVAL",
    "SCENARIO_SUITE_GREEN",
    "AMOUNT_PIPELINE_CONTRACT",
    "REFERENCE_FORMAT_CONTRACT",
    "SIGNATURE_CONTRACT",
    "CHANNEL_VERIFICATION_STRENGTH",
    "ROLLBACK_VERSION_SET",
    "ROUTE_LIMITS_COMMISSION_STATEMENT",
    "EVIDENCE_LEVEL_CONTRACT",
    "PCI_SCOPE_REVIEW",
    "CANARY_TRAFFIC_PLAN",
    "ROUTE_ALERTS_RUNBOOKS",
];

type ScenarioResult = {
    key: string;
    name: string;
    passed: boolean;
    detail?: string;
};

type GateResult = {
    key: string;
    passed: boolean;
    detail?: string;
};

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: "14px",
} as const;

export const StepSimulator = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const showChecklists = areChecklistsVisible();
        const phase = ref("INITIATE");
        const formData = ref('{"customer_mobile":"0912345678"}');
        const sampleAmount = ref("100");
        const sampleCurrency = ref("LYD");
        const dryRunning = ref(false);
        const dryRunOutput = ref<string | null>(null);
        const dryRunError = ref<string | null>(null);
        const dryRunChecklist = ref<Record<string, boolean>>({});

        const suiteRunning = ref(false);
        const scenarios = ref<ScenarioResult[]>([]);
        const suiteError = ref<string | null>(null);
        const suiteChecklist = ref<Record<string, boolean>>({});

        const gates = ref<GateResult[]>(
            GO_LIVE_GATE_KEYS.map((key) => ({ key, passed: false, detail: "not evaluated yet" })),
        );

        const rollbackVersionId = ref(props.model.rollbackVersionId ?? "");
        const submitReason = ref("");
        const submitting = ref(false);
        const submitChecklist = ref<Record<string, boolean>>({});

        const dryRunChecklistComplete = computed(() => !showChecklists || DRY_RUN_CHECKS.every((check) => dryRunChecklist.value[check.key] === true));

        const runDryRun = async () => {
            dryRunning.value = true;
            dryRunOutput.value = null;
            dryRunError.value = null;
            try {
                let parsedForm: Record<string, unknown> = {};
                try {
                    parsedForm = JSON.parse(formData.value || "{}");
                } catch {
                    throw new Error("form data must be a valid JSON object");
                }
                const response = await api.post(urlsMap.gatewayVersionDryRun(props.model.versionId ?? ""), {
                    scenario: phase.value,
                    checklist: DRY_RUN_CHECKS.filter((check) => dryRunChecklist.value[check.key]).map((check) => check.key),
                    payload: {
                        ...parsedForm,
                        amount: sampleAmount.value,
                        currency: sampleCurrency.value.toUpperCase(),
                    },
                });
                const payload = response.data?.data ?? response.data ?? {};
                dryRunOutput.value = JSON.stringify(payload, null, 2);
            } catch (e) {
                dryRunError.value = extractApiErrorMessage(e);
            } finally {
                dryRunning.value = false;
            }
        };

        const suiteChecklistComplete = computed(() => !showChecklists || SUITE_CHECKS.every((check) => suiteChecklist.value[check.key] === true));

        const runSuite = async () => {
            suiteRunning.value = true;
            suiteError.value = null;
            try {
                const response = await api.post(urlsMap.gatewayVersionRunSuite(props.model.versionId ?? ""), {
                    suite: "SANDBOX_15",
                    checklist: SUITE_CHECKS.filter((check) => suiteChecklist.value[check.key]).map((check) => check.key),
                });
                const payload = response.data?.data ?? response.data ?? {};
                const results = payload.evidence?.scenarioResults ?? payload.scenarios ?? payload.results ?? [];
                scenarios.value = results.map((scenario: any) => ({
                    key: scenario.key ?? scenario.scenario ?? scenario.id ?? "",
                    name: scenario.name ?? scenario.title ?? scenario.scenario ?? "",
                    passed: !!scenario.passed,
                    detail: scenario.detail ?? scenario.details ?? scenario.message ?? "",
                }));
                const reportGates = payload.report?.gates ?? payload.gates ?? [];
                if (reportGates.length) {
                    gates.value = reportGates.map((gate: any) => ({
                        key: gate.key ?? gate.id,
                        passed: !!gate.passed,
                        detail: Array.isArray(gate.reasons) ? gate.reasons.join(" · ") : gate.detail ?? "",
                    }));
                }
            } catch (e) {
                suiteError.value = extractApiErrorMessage(e);
            } finally {
                suiteRunning.value = false;
            }
        };

        const submitChecklistComplete = computed(() => !showChecklists || SUBMIT_CHECKS.every((check) => submitChecklist.value[check.key] === true));
        const submitSafeguard = useSafeguard("sg-submit-gateway-version");

        const submitForApproval = async () => {
            if (!(await submitSafeguard.confirm())) return;
            submitting.value = true;
            try {
                await api.post(urlsMap.gatewayVersionSubmitApproval(props.model.versionId ?? ""), {
                    reason: submitReason.value.trim() || "Ready for approval",
                    checklist: SUBMIT_CHECKS.filter((check) => submitChecklist.value[check.key]).map((check) => check.key),
                });
                showSnackBar({ type: "success", message: t("Submit For Approval") });
            } catch (e) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
            } finally {
                submitting.value = false;
            }
        };

        return () => (
            <SurfaceCard title={t("Simulator & Approval")}>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <WizardSection title={t("Dry Run")}>
                        <div style={gridStyle}>
                            <FormField label={t("Phase")}>
                                <VSelect
                                    items={[
                                        "CREDENTIAL_CHECK",
                                        "PRE_INITIATE",
                                        "INITIATE",
                                        "SUBMIT",
                                        "VERIFY",
                                        "CANCEL",
                                        "REFUND",
                                        "VOID",
                                        "CAPTURE",
                                        "SETTLEMENT_FETCH",
                                    ]}
                                    modelValue={phase.value}
                                    onUpdate:modelValue={(v: string) => (phase.value = v)}
                                />
                            </FormField>
                            <FormField label={t("Amount")}>
                                <VTextField
                                    modelValue={sampleAmount.value}
                                    onUpdate:modelValue={(v: string) => (sampleAmount.value = v)}
                                />
                            </FormField>
                            <FormField label={t("Currency")}>
                                <VTextField
                                    modelValue={sampleCurrency.value}
                                    onUpdate:modelValue={(v: string) => (sampleCurrency.value = v.toUpperCase())}
                                />
                            </FormField>
                        </div>
                        <FormField label={t("Params")}>
                            <VTextarea
                                modelValue={formData.value}
                                onUpdate:modelValue={(v: string) => (formData.value = v)}
                                rows={4}
                            />
                        </FormField>
                        <FormChecklist
                            checks={DRY_RUN_CHECKS.map((check) => ({ key: check.key, label: check.label }))}
                            modelValue={dryRunChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (dryRunChecklist.value = value)}
                            show={showChecklists}
                            title={t("Dry-run checklist")}
                            incompleteMessage={t("Complete all dry-run checklist items before running")}
                            complete={dryRunChecklistComplete.value}
                        />
                        <div>
                            <VBtn color="primary" loading={dryRunning.value} disabled={!dryRunChecklistComplete.value} onClick={() => void runDryRun()}>
                                {t("Dry Run")}
                            </VBtn>
                        </div>
                        {dryRunError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {dryRunError.value}
                            </VAlert>
                        )}
                        {dryRunOutput.value && (
                            <pre
                                class="pg-mono"
                                style={{
                                    margin: 0,
                                    fontSize: "12px",
                                    lineHeight: 1.55,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    direction: "ltr",
                                    background: "var(--pg-bg-surface-subtle)",
                                    color: "var(--pg-ink-primary)",
                                    border: "1px solid var(--pg-border-subtle)",
                                    padding: "12px",
                                    borderRadius: "var(--pg-radius-sm)",
                                    overflowX: "auto",
                                }}
                            >
                                {dryRunOutput.value}
                            </pre>
                        )}
                    </WizardSection>

                    <WizardSection
                        title={t("Test Suite")}
                        divider
                        v-slots={{
                            actions: () => (
                                <VBtn color="primary" size="small" loading={suiteRunning.value} disabled={!suiteChecklistComplete.value} onClick={() => void runSuite()}>
                                    {t("Run")}
                                </VBtn>
                            ),
                        }}
                    >
                        <FormChecklist
                            checks={SUITE_CHECKS.map((check) => ({ key: check.key, label: check.label }))}
                            modelValue={suiteChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (suiteChecklist.value = value)}
                            show={showChecklists}
                            title={t("Test suite checklist")}
                            incompleteMessage={t("Complete all test suite checklist items before running")}
                            complete={suiteChecklistComplete.value}
                        />

                        {suiteError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {suiteError.value}
                            </VAlert>
                        )}

                        <div style={{ display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            {scenarios.value.map((scenario) => (
                                <StatusBadge
                                    key={scenario.key}
                                    status={scenario.passed ? "PASSED" : "FAILED"}
                                    label={`${scenario.name || scenario.key}: ${scenario.passed ? t("Passed") : t("Failed")}`}
                                    toneOverride={scenario.passed ? "success" : "danger"}
                                />
                            ))}
                        </div>
                    </WizardSection>

                    <WizardSection title={t("Go-Live Gates")} divider>
                        <DescriptionList
                            items={gates.value.map((gate, index) => ({
                                label: `${t("Gate")} ${index + 1}`,
                                value: (
                                    <span
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            justifyContent: "flex-end",
                                            gap: "8px",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <MonoRef value={gate.key} copyable={false} />
                                        <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                            {gate.detail ?? ""}
                                        </span>
                                        <StatusBadge
                                            status={gate.passed ? "PASSED" : "PENDING"}
                                            label={gate.passed ? t("Passed") : t("Pending")}
                                            toneOverride={gate.passed ? "success" : "warning"}
                                        />
                                    </span>
                                ),
                            }))}
                        />
                    </WizardSection>

                    <WizardSection title={t("Rollback Version")} divider>
                        <FormField label="rollback_version_id">
                            <VTextField
                                modelValue={rollbackVersionId.value}
                                onUpdate:modelValue={(v: string) => {
                                    rollbackVersionId.value = v;
                                    props.onChange({ ...props.model, rollbackVersionId: v || null });
                                }}
                            />
                        </FormField>
                        <FormField label={t("Reason")}>
                            <VTextarea
                                modelValue={submitReason.value}
                                onUpdate:modelValue={(v: string) => (submitReason.value = v)}
                                rows={3}
                            />
                        </FormField>
                        <FormChecklist
                            checks={SUBMIT_CHECKS.map((check) => ({ key: check.key, label: check.label }))}
                            modelValue={submitChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (submitChecklist.value = value)}
                            show={showChecklists}
                            title={t("Go-live checklist")}
                            incompleteMessage={t("Complete all go-live checklist items before submitting")}
                            complete={submitChecklistComplete.value}
                        />
                        <div>
                            <VBtn color="primary" loading={submitting.value} disabled={!submitChecklistComplete.value} onClick={() => void submitForApproval()}>
                                {t("Submit For Approval")}
                            </VBtn>
                        </div>
                    </WizardSection>
                </SurfaceCardText>
            </SurfaceCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepSimulator;
