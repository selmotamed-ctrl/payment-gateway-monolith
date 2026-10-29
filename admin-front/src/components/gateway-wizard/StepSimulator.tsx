import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VSelect, VTextField, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import type { WizardStepProps } from "./StepIdentity";

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
        const phase = ref("INITIATE");
        const formData = ref('{"customer_mobile":"0912345678"}');
        const sampleAmount = ref("100");
        const sampleCurrency = ref("LYD");
        const dryRunning = ref(false);
        const dryRunOutput = ref<string | null>(null);
        const dryRunError = ref<string | null>(null);

        const suiteRunning = ref(false);
        const scenarios = ref<ScenarioResult[]>([]);
        const suiteError = ref<string | null>(null);

        const gates = ref<GateResult[]>(
            GO_LIVE_GATE_KEYS.map((key) => ({ key, passed: false, detail: "not evaluated yet" })),
        );

        const rollbackVersionId = ref(props.model.rollbackVersionId ?? "");
        const submitReason = ref("");
        const submitting = ref(false);

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

        const runSuite = async () => {
            suiteRunning.value = true;
            suiteError.value = null;
            try {
                const response = await api.post(urlsMap.gatewayVersionRunSuite(props.model.versionId ?? ""), {
                    suite: "SANDBOX_15",
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

        const submitForApproval = async () => {
            submitting.value = true;
            try {
                await api.post(urlsMap.gatewayVersionSubmitApproval(props.model.versionId ?? ""), {
                    reason: submitReason.value.trim() || "Ready for approval",
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
                        <VBtn color="primary" loading={dryRunning.value} onClick={() => void runDryRun()}>
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
                                <VBtn color="primary" size="small" loading={suiteRunning.value} onClick={() => void runSuite()}>
                                    {t("Run")}
                                </VBtn>
                            </ThemedView>
                        </ThemedView>

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
                        <VBtn color="primary" loading={submitting.value} onClick={() => void submitForApproval()}>
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
