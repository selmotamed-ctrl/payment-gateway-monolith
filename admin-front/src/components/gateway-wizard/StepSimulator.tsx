import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VSelect, VTextField, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
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

        const submitForApproval = async () => {
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
            <ThemedView style={{ gap: "16px" }}>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Dry Run")}
                        </ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
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
                                label={t("Phase")}
                                style={{ minWidth: "220px" }}
                            />
                            <VTextField
                                label={t("Amount")}
                                modelValue={sampleAmount.value}
                                onUpdate:modelValue={(v: string) => (sampleAmount.value = v)}
                                style={{ minWidth: "140px" }}
                            />
                            <VTextField
                                label={t("Currency")}
                                modelValue={sampleCurrency.value}
                                onUpdate:modelValue={(v: string) => (sampleCurrency.value = v.toUpperCase())}
                                style={{ minWidth: "130px" }}
                            />
                        </ThemedView>
                        <VTextarea
                            label={t("Params")}
                            modelValue={formData.value}
                            onUpdate:modelValue={(v: string) => (formData.value = v)}
                            rows={4}
                        />
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Dry-run checklist")}</ThemedText>
                                {DRY_RUN_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={dryRunChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (dryRunChecklist.value = { ...dryRunChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!dryRunChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all dry-run checklist items before running")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <VBtn color="primary" loading={dryRunning.value} disabled={!dryRunChecklistComplete.value} onClick={() => void runDryRun()}>
                            {t("Dry Run")}
                        </VBtn>
                        {dryRunError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {dryRunError.value}
                            </VAlert>
                        )}
                        {dryRunOutput.value && (
                            <pre
                                style={{
                                    margin: 0,
                                    fontSize: "12px",
                                    whiteSpace: "pre-wrap",
                                    direction: "ltr",
                                    background: "rgba(100,116,139,0.08)",
                                    padding: "12px",
                                    borderRadius: "10px",
                                }}
                            >
                                {dryRunOutput.value}
                            </pre>
                        )}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView
                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                        >
                            <ThemedText type="defaultSemiBold">{t("Test Suite")}</ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "8px" }}>
                                <VBtn color="primary" size="small" loading={suiteRunning.value} disabled={!suiteChecklistComplete.value} onClick={() => void runSuite()}>
                                    {t("Run")}
                                </VBtn>
                            </ThemedView>
                        </ThemedView>

                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Test suite checklist")}</ThemedText>
                                {SUITE_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={suiteChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (suiteChecklist.value = { ...suiteChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!suiteChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all test suite checklist items before running")}</ThemedText>
                                )}
                            </ThemedView>
                        )}

                        {suiteError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {suiteError.value}
                            </VAlert>
                        )}

                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            {scenarios.value.map((scenario) => (
                                <StatusChip
                                    key={scenario.key}
                                    label={`${scenario.name || scenario.key}: ${scenario.passed ? t("Passed") : t("Failed")}`}
                                    tone={scenario.passed ? "success" : "error"}
                                />
                            ))}
                        </ThemedView>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                        <ThemedText type="defaultSemiBold">{t("Go-Live Gates")}</ThemedText>
                        {gates.value.map((gate) => (
                            <ThemedView
                                key={gate.key}
                                style={{ flexDirection: "row", gap: "12px", alignItems: "center", fontSize: "13px" }}
                            >
                                <StatusChip label={gate.passed ? t("Passed") : t("Pending")} tone={gate.passed ? "success" : "warning"} />
                                <span style={{ flex: 1, direction: "ltr" }}>{gate.key}</span>
                                <span style={{ opacity: 0.65 }}>{gate.detail ?? ""}</span>
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{t("Rollback Version")}</ThemedText>
                        <VTextField
                            label="rollback_version_id"
                            modelValue={rollbackVersionId.value}
                            onUpdate:modelValue={(v: string) => {
                                rollbackVersionId.value = v;
                                props.onChange({ ...props.model, rollbackVersionId: v || null });
                            }}
                        />
                        <VTextarea
                            label={t("Reason")}
                            modelValue={submitReason.value}
                            onUpdate:modelValue={(v: string) => (submitReason.value = v)}
                            rows={3}
                        />
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Go-live checklist")}</ThemedText>
                                {SUBMIT_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={submitChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (submitChecklist.value = { ...submitChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!submitChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all go-live checklist items before submitting")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <VBtn color="primary" loading={submitting.value} disabled={!submitChecklistComplete.value} onClick={() => void submitForApproval()}>
                            {t("Submit For Approval")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </ThemedView>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepSimulator;
