import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VDivider, VExpansionPanel, VExpansionPanelText, VExpansionPanelTitle, VExpansionPanels, VFileInput, VIcon, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetaPill } from "@/components/ui/MetaPill";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MetricStrip } from "@/components/ui/MetricStrip";
type RailKind = "OTP_PULL" | "REDIRECT" | "EMBEDDED" | "QR_DISPLAY" | "PUSH_APPROVAL" | "HYBRID";

const RAIL_KINDS: RailKind[] = ["OTP_PULL", "REDIRECT", "EMBEDDED", "QR_DISPLAY", "PUSH_APPROVAL", "HYBRID"];

const IMPORT_CHECKS = [
    { key: "SPEC_VERIFIED", label: "Spec verification passed" },
    { key: "CREDENTIALS_VERIFIED", label: "Required credentials entered" },
    { key: "IMPORT_MODE_REVIEWED", label: "Import mode reviewed" },
    { key: "NO_SECRET_EXPOSURE_CONFIRMED", label: "No secret exposure in logs or files" },
] as const;

type ImportMode = "CREATE_NEW" | "NEW_VERSION";

const IMPORT_MODES: { title: string; value: ImportMode }[] = [
    { title: "Create New Gateway", value: "CREATE_NEW" },
    { title: "New Version", value: "NEW_VERSION" },
];

type TranscriptResponse = {
    filename: string;
    contentType: string;
    specVersion: string;
    markdown: string;
    vocabulary: Record<string, string[]>;
};

type VerificationIssue = {
    path: string;
    code: string;
    message: string;
    aiFixHint: string;
};

type LayerResult = {
    layer: number;
    name: string;
    passed: boolean;
    errorCount: number;
    warningCount: number;
};

type VectorRequest = {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
};

type VectorResult = {
    name: string;
    phase: string;
    passed: boolean;
    status?: string;
    extractions: Record<string, unknown>;
    requests: VectorRequest[];
    errors: VerificationIssue[];
};

type VerificationSummary = {
    gatewayCode: string | null;
    railCode: string | null;
    collectionMode: string | null;
    vectorCount: number;
    passedVectors: number;
    flowPhases: string[];
    errorCount: number;
    warningCount: number;
};

type RequiredCredential = {
    key: string;
    is_secret: boolean;
    encoding?: string;
    description?: string;
    type: string;
};

type CollisionInfo = {
    gatewayExists: boolean;
    railCodeExists: boolean;
    versionCount: number;
};

type VerificationReport = {
    valid: boolean;
    specVersion: string | null;
    layers: LayerResult[];
    summary: VerificationSummary;
    requiredCredentials: RequiredCredential[];
    vectorResults: VectorResult[];
    errors: VerificationIssue[];
    warnings: VerificationIssue[];
    collision?: CollisionInfo;
    aiRepairPrompt?: string;
};

type CredentialCheck = {
    status: string;
    method?: string;
    reason?: string;
};

type ImportResponse = {
    gatewayId: string;
    gatewayCode: string;
    gatewayVersionId: string;
    versionNumber: number;
    versionState: string;
    railId: string;
    railCode: string;
    railRouteId: string;
    credentialSetId: string;
    counts: Record<string, unknown>;
    verification: VerificationReport;
    credentialCheck?: CredentialCheck;
    nextStep: string;
};

const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const prettyBody = (body: string): string => {
    if (!body) {
        return "";
    }
    try {
        return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
        return body;
    }
};

const monoStyle = {
    fontFamily: "var(--pg-font-mono)",
    fontSize: "12px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    direction: "ltr",
    textAlign: "left",
    margin: 0,
    padding: "10px",
    borderRadius: "var(--pg-radius-sm)",
    background: "var(--pg-bg-surface-subtle)",
    border: "1px solid var(--pg-border-subtle)",
    color: "var(--pg-ink-primary)",
    overflowX: "auto",
} as const;

type RepairPromptErrorShape = {
    response?: {
        data?: {
            details?: { aiRepairPrompt?: unknown };
            data?: { details?: { aiRepairPrompt?: unknown } };
            aiRepairPrompt?: unknown;
        };
    };
    aiRepairPrompt?: unknown;
};

const extractRepairPrompt = (error: unknown): string | null => {
    const shape = error as RepairPromptErrorShape | null | undefined;
    const data = shape?.response?.data;
    const candidates: unknown[] = [
        data?.details?.aiRepairPrompt,
        data?.data?.details?.aiRepairPrompt,
        data?.aiRepairPrompt,
        shape?.aiRepairPrompt,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate;
        }
    }
    return null;
};

const GatewayAiImportPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();

    const step = ref(1);

    const railKind = ref<RailKind | null>(null);
    const transcript = ref<TranscriptResponse | null>(null);
    const transcriptLoading = ref(false);
    const transcriptError = ref<string | null>(null);
    const downloading = ref(false);

    const spec = ref<unknown>(null);
    const specFileModel = ref<File | File[] | null>(null);
    const specFileName = ref("");
    const specError = ref<string | null>(null);
    const verifyLoading = ref(false);
    const verifyError = ref<string | null>(null);
    const report = ref<VerificationReport | null>(null);

    const credentialsValues = ref<Record<string, string>>({});
    const visibleSecrets = ref<Record<string, boolean>>({});
    const importMode = ref<ImportMode>("CREATE_NEW");
    const importLoading = ref(false);
    const importError = ref<string | null>(null);
    const importRepairPrompt = ref<string | null>(null);
    const importResult = ref<ImportResponse | null>(null);
    const importChecklist = ref<Record<string, boolean>>({});

    const missingRequiredCredentials = computed(() =>
        (report.value?.requiredCredentials ?? [])
            .filter((credential) => credential.is_secret)
            .filter((credential) => !(credentialsValues.value[credential.key] ?? "").trim())
            .map((credential) => credential.key),
    );
    const canImport = computed(
        () =>
            !!report.value &&
            report.value.valid &&
            spec.value !== null &&
            missingRequiredCredentials.value.length === 0,
    );

    const loadTranscript = async () => {
        transcriptLoading.value = true;
        transcriptError.value = null;
        try {
            const response = await api.get(urlsMap.gatewayAiTranscript, {
                params: railKind.value ? { railKind: railKind.value } : {},
            });
            const payload = (response.data?.data ?? response.data) as TranscriptResponse;
            transcript.value = payload;
        } catch (e) {
            transcriptError.value = extractApiErrorMessage(e);
            transcript.value = null;
        } finally {
            transcriptLoading.value = false;
        }
    };

    void loadTranscript();

    watch(railKind, () => {
        void loadTranscript();
    });

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showSnackBar({ type: "success", message: t("Copied to clipboard") });
        } catch {
            showSnackBar({ type: "error", message: t("Copy failed") });
        }
    };

    const downloadTranscript = () => {
        const payload = transcript.value;
        if (!payload) {
            return;
        }
        downloading.value = true;
        try {
            const blob = new Blob([payload.markdown], {
                type: payload.contentType || "text/markdown",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = payload.filename || "gateway-ai-kit.md";
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Kit downloaded") });
        } catch {
            showSnackBar({ type: "error", message: t("Download failed") });
        } finally {
            downloading.value = false;
        }
    };

    const seedCredentials = (nextReport: VerificationReport) => {
        const next: Record<string, string> = {};
        for (const credential of nextReport.requiredCredentials ?? []) {
            next[credential.key] = "";
        }
        credentialsValues.value = next;
        visibleSecrets.value = {};
    };

    const verifySpec = async (parsed: unknown) => {
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            specError.value = t("The spec must be a JSON object.");
            return;
        }
        verifyLoading.value = true;
        verifyError.value = null;
        importResult.value = null;
        importError.value = null;
        importRepairPrompt.value = null;
        try {
            const response = await api.post(urlsMap.gatewaySpecVerify, { spec: parsed });
            const payload = (response.data?.data ?? response.data) as VerificationReport;
            report.value = payload;
            seedCredentials(payload);
            importMode.value = payload?.collision?.gatewayExists ? "NEW_VERSION" : "CREATE_NEW";
            showSnackBar({
                type: payload.valid ? "success" : "warning",
                message: payload.valid ? t("Spec verified") : t("Spec has validation errors"),
            });
        } catch (e) {
            verifyError.value = extractApiErrorMessage(e);
            report.value = null;
        } finally {
            verifyLoading.value = false;
        }
    };

    const readSpecFile = async (value: File | File[] | null) => {
        specFileModel.value = value;
        specError.value = null;
        verifyError.value = null;
        report.value = null;
        importResult.value = null;
        importError.value = null;
        importRepairPrompt.value = null;
        specFileName.value = "";

        const file = Array.isArray(value) ? value[0] : value;
        if (!file) {
            spec.value = null;
            return;
        }

        specFileName.value = file.name;
        try {
            const text = await file.text();
            let parsed: unknown;
            try {
                parsed = JSON.parse(text) as unknown;
            } catch {
                spec.value = null;
                specError.value = t("The selected file is not valid JSON. Please choose a valid spec file.");
                return;
            }
            spec.value = parsed;
            await verifySpec(parsed);
        } catch {
            spec.value = null;
            specError.value = t("Could not read the selected file.");
        }
    };

    const importChecklistComplete = computed(() => !showChecklists || IMPORT_CHECKS.every((check) => importChecklist.value[check.key] === true));
    const importSafeguard = useSafeguard("sg-ai-import-draft");

    const runImport = async () => {
        if (!canImport.value) {
            return;
        }
        if (!importChecklistComplete.value) {
            importError.value = t("Complete all import checklist items before creating the draft");
            return;
        }
        if (!(await importSafeguard.confirm())) return;
        importLoading.value = true;
        importError.value = null;
        importRepairPrompt.value = null;
        try {
            const response = await api.post(urlsMap.gatewaySpecImport, {
                spec: spec.value,
                credentialsValues: credentialsValues.value,
                mode: importMode.value,
                checklist: IMPORT_CHECKS.filter((check) => importChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = (response.data?.data ?? response.data) as ImportResponse;
            importResult.value = payload;
            showSnackBar({ type: "success", message: t("Draft created") });
        } catch (e) {
            importError.value = extractApiErrorMessage(e);
            importRepairPrompt.value = extractRepairPrompt(e);
        } finally {
            importLoading.value = false;
        }
    };

    const openGateway = () => {
        if (!importResult.value) {
            return;
        }
        void router.push({ name: "GatewayWizard", params: { id: importResult.value.gatewayId } });
    };

    const startOver = () => {
        step.value = 1;
        spec.value = null;
        specFileModel.value = null;
        specFileName.value = "";
        specError.value = null;
        verifyError.value = null;
        report.value = null;
        credentialsValues.value = {};
        visibleSecrets.value = {};
        importMode.value = "CREATE_NEW";
        importChecklist.value = {};
        importError.value = null;
        importRepairPrompt.value = null;
        importResult.value = null;
    };

    const goBack = () => {
        if (step.value > 1) {
            step.value -= 1;
        }
    };

    const renderTranscriptPreview = (payload: TranscriptResponse) => {
        const vocabularyEntries = Object.entries(payload.vocabulary ?? {});
        return (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    paddingTop: "16px",
                    borderTop: "1px solid var(--pg-border-subtle)",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <ThemedText type="defaultSemiBold">{t("AI Integration Kit")}</ThemedText>
                    <StatusBadge status={payload.specVersion || "-"} toneOverride="info" />
                    <StatusBadge
                        status="FILE"
                        label={payload.filename || "-"}
                        toneOverride="neutral"
                        showDot={false}
                    />
                </div>

                {vocabularyEntries.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        {vocabularyEntries.map(([key, values]) => (
                            <MetaPill key={key} size="small" variant="tonal" color="primary">
                                {key}: {(values ?? []).join(", ")}
                            </MetaPill>
                        ))}
                    </div>
                )}

                <VDivider />

                <pre class="pg-mono" style={{ ...monoStyle, maxHeight: "320px", overflowY: "auto" }}>
                    {payload.markdown || t("No transcript content returned.")}
                </pre>
            </div>
        );
    };

    const renderScorecard = (nextReport: VerificationReport) => {
        const layers = nextReport.layers ?? [];
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        flexWrap: "wrap",
                    }}
                >
                    <ThemedText type="defaultSemiBold">{t("4-Layer Scorecard")}</ThemedText>
                    <StatusBadge
                        status={nextReport.valid ? "VERIFIED" : "FAILED"}
                        label={nextReport.valid ? t("VALID") : t("INVALID")}
                        toneOverride={nextReport.valid ? "success" : "danger"}
                    />
                </div>

                {layers.length === 0 ? (
                    <ThemedText style={{ opacity: 0.7 }}>{t("No layer results returned.")}</ThemedText>
                ) : (
                    <MetricStrip
                        items={layers.map((layer) => ({
                            key: `${layer.layer}-${layer.name}`,
                            label: `${t("Layer")} ${layer.layer} · ${t(layer.name)}`,
                            value: layer.passed ? t("PASSED") : t("FAILED"),
                            badge: layer.passed ? "PASSED" : "FAILED",
                            badgeTone: layer.passed ? "success" : "danger",
                            subLabel: `${t("Errors")}: ${layer.errorCount} · ${t("Warnings")}: ${layer.warningCount}`,
                        }))}
                    />
                )}
            </div>
        );
    };

    const renderIssueList = (issues: VerificationIssue[] | undefined, title: string, tone: "error" | "warning") => {
        const list = issues ?? [];
        return (
            <SurfaceCard title={title}>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <StatusBadge
                            status={tone === "error" ? "FAILED" : "WARNING"}
                            label={String(list.length)}
                            toneOverride={tone === "error" ? "danger" : "warning"}
                            showDot={false}
                        />
                    </div>

                    {list.length === 0 ? (
                        <ThemedText style={{ opacity: 0.7 }}>{t("None")}</ThemedText>
                    ) : (
                        list.map((issue, index) => (
                            <div
                                key={`${issue.path}-${issue.code}-${index}`}
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "4px",
                                    paddingInlineStart: "10px",
                                    paddingTop: "8px",
                                    borderInlineStart: `3px solid ${
                                        tone === "error"
                                            ? "var(--pg-status-danger-dot)"
                                            : "var(--pg-status-warning-dot)"
                                    }`,
                                    borderTop: "1px solid var(--pg-border-subtle)",
                                }}
                            >
                                <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <MonoRef value={issue.code} copyable={false} />
                                    {issue.path && <MonoRef value={issue.path} copyable={false} />}
                                </div>
                                <ThemedText style={{ fontSize: "13px" }}>{issue.message}</ThemedText>
                                {issue.aiFixHint && (
                                    <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                        <strong>{t("AI fix hint")}:</strong> {issue.aiFixHint}
                                    </ThemedText>
                                )}
                            </div>
                        ))
                    )}
                </SurfaceCardText>
            </SurfaceCard>
        );
    };

    const renderKeyValues = (title: string, values: Record<string, unknown> | undefined) => {
        const entries = Object.entries(values ?? {});
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                    {title}
                </ThemedText>
                {entries.length === 0 ? (
                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{t("No data")}</ThemedText>
                ) : (
                    <DescriptionList
                        columns={2}
                        items={entries.map(([key, value]) => ({
                            label: key,
                            value: formatValue(value),
                            mono: true,
                        }))}
                    />
                )}
            </div>
        );
    };

    const renderRequests = (requests: VectorRequest[] | undefined) => {
        const list = requests ?? [];
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                    {t("Captured Requests")}
                </ThemedText>
                {list.length === 0 ? (
                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{t("No requests captured")}</ThemedText>
                ) : (
                    list.map((request, index) => {
                        const headerEntries = Object.entries(request.headers ?? {});
                        return (
                            <div
                                key={`${request.method}-${request.url}-${index}`}
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "8px",
                                    paddingTop: "10px",
                                    borderTop: "1px solid var(--pg-border-subtle)",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <span class="pg-mono" style={{ fontSize: "13px", fontWeight: 700 }}>
                                        {request.method}
                                    </span>
                                    <MonoRef value={request.url} copyable={false} />
                                </div>
                                {headerEntries.length > 0 && (
                                    <pre class="pg-mono" style={monoStyle}>
                                        {headerEntries.map(([key, value]) => `${key}: ${value}`).join("\n")}
                                    </pre>
                                )}
                                {request.body && <pre class="pg-mono" style={monoStyle}>{prettyBody(request.body)}</pre>}
                            </div>
                        );
                    })
                )}
            </div>
        );
    };

    const renderVectors = (nextReport: VerificationReport) => {
        const vectors = nextReport.vectorResults ?? [];
        const passed = vectors.filter((vector) => vector.passed).length;
        return (
            <SurfaceCard
                title={t("Vector Results")}
                v-slots={{
                    headerActions: () => (
                        <StatusBadge
                            status={passed === vectors.length ? "PASSED" : "PENDING"}
                            label={`${passed} / ${vectors.length} ${t("passed")}`}
                            toneOverride={passed === vectors.length ? "success" : "warning"}
                        />
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {vectors.length === 0 ? (
                        <ThemedText style={{ opacity: 0.7 }}>{t("No vector results returned.")}</ThemedText>
                    ) : (
                        <VExpansionPanels multiple>
                            {vectors.map((vector, index) => (
                                <VExpansionPanel key={`${vector.name}-${index}`} value={index}>
                                    <VExpansionPanelTitle>
                                        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                                {vector.name}
                                            </ThemedText>
                                            <StatusBadge
                                                status={vector.phase || "-"}
                                                toneOverride="info"
                                                showDot={false}
                                            />
                                            <StatusBadge
                                                status={vector.passed ? "PASSED" : "FAILED"}
                                                label={vector.passed ? t("PASSED") : t("FAILED")}
                                                toneOverride={vector.passed ? "success" : "danger"}
                                            />
                                            {vector.status && (
                                                <MetaPill size="x-small" variant="outlined">
                                                    {vector.status}
                                                </MetaPill>
                                            )}
                                        </div>
                                    </VExpansionPanelTitle>
                                    <VExpansionPanelText>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "12px", paddingTop: "6px" }}>
                                            {renderKeyValues(t("Extractions"), vector.extractions)}
                                            {renderRequests(vector.requests)}
                                            {(vector.errors ?? []).length > 0 && (
                                                <VAlert type="error" variant="tonal" density="compact">
                                                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                                        {(vector.errors ?? []).map((issue, errorIndex) => (
                                                            <ThemedText key={`${issue.code}-${errorIndex}`} style={{ fontSize: "12px" }}>
                                                                {issue.path ? `${issue.path}: ` : ""}
                                                                {issue.message}
                                                            </ThemedText>
                                                        ))}
                                                    </div>
                                                </VAlert>
                                            )}
                                        </div>
                                    </VExpansionPanelText>
                                </VExpansionPanel>
                            ))}
                        </VExpansionPanels>
                    )}
                </SurfaceCardText>
            </SurfaceCard>
        );
    };

    const renderSummary = (nextReport: VerificationReport) => {
        const summary = nextReport.summary;
        return (
            <SurfaceCard
                title={t("Verification Summary")}
                v-slots={{
                    headerActions: () => (
                        <>
                            <StatusBadge
                                status={nextReport.valid ? "VERIFIED" : "FAILED"}
                                label={nextReport.valid ? t("VALID") : t("INVALID")}
                                toneOverride={nextReport.valid ? "success" : "danger"}
                            />
                            <StatusBadge status={nextReport.specVersion || "-"} toneOverride="info" />
                        </>
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <DescriptionList
                        columns={2}
                        items={[
                            {
                                label: t("Gateway"),
                                value: summary?.gatewayCode ? <MonoRef value={summary.gatewayCode} /> : "-",
                            },
                            {
                                label: t("Rail"),
                                value: summary?.railCode ? <MonoRef value={summary.railCode} /> : "-",
                            },
                            { label: t("Collection Mode"), value: summary?.collectionMode ?? "-" },
                            {
                                label: t("Vectors"),
                                value: `${summary?.passedVectors ?? 0} / ${summary?.vectorCount ?? 0}`,
                            },
                            { label: t("Errors"), value: summary?.errorCount ?? 0 },
                            { label: t("Warnings"), value: summary?.warningCount ?? 0 },
                        ]}
                    />
                    {(summary?.flowPhases ?? []).length > 0 && (
                        <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                            <strong>{t("Flow Phases")}:</strong> {(summary?.flowPhases ?? []).join(" → ")}
                        </ThemedText>
                    )}
                </SurfaceCardText>
            </SurfaceCard>
        );
    };

    const renderRepairPrompt = (prompt: string | null | undefined, label: string) => {
        if (!prompt) {
            return null;
        }
        return (
            <VAlert type="warning" variant="tonal" prominent>
                <ThemedView style={{ gap: "10px" }}>
                    <ThemedText type="defaultSemiBold">{t("AI repair prompt available")}</ThemedText>
                    <ThemedText style={{ fontSize: "13px" }}>
                        {t("Copy this prompt and paste it back into your external AI assistant, then upload the corrected spec.")}
                    </ThemedText>
                    <ThemedView style={{ flexDirection: "row" }}>
                        <VBtn color="warning" prependIcon={"mdi-content-copy"} onClick={() => void copyText(prompt)}>
                            {label}
                        </VBtn>
                    </ThemedView>
                </ThemedView>
            </VAlert>
        );
    };

    const renderStepDownload = () => (
        <SurfaceCard
            title={t("Download the AI Integration Kit")}
            subtitle={t("Download the markdown transcript, hand it to any external AI assistant, and bring the resulting JSON spec back here.")}
        >
            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <div style={{ display: "flex", flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div style={{ minWidth: "260px", maxWidth: "320px", flex: "0 1 320px" }}>
                        <FormField label={t("Rail Kind (optional)")}>
                            <VSelect
                                items={RAIL_KINDS}
                                clearable
                                modelValue={railKind.value}
                                onUpdate:modelValue={(value: RailKind | null) => {
                                    railKind.value = value;
                                }}
                            />
                        </FormField>
                    </div>
                    <VBtn
                        color="primary"
                        prependIcon={"mdi-download"}
                        loading={downloading.value}
                        disabled={!transcript.value || transcriptLoading.value}
                        onClick={downloadTranscript}
                    >
                        {t("Download")}
                    </VBtn>
                    <VBtn
                        variant="tonal"
                        prependIcon={"mdi-content-copy"}
                        disabled={!transcript.value || transcriptLoading.value}
                        onClick={() => transcript.value && void copyText(transcript.value.markdown)}
                    >
                        {t("Copy transcript")}
                    </VBtn>
                </div>

                {transcriptLoading.value ? (
                    <StateView loading={true} minHeight="180px" />
                ) : transcriptError.value ? (
                    <StateView error={transcriptError.value} minHeight="180px" onRetry={() => void loadTranscript()} />
                ) : transcript.value ? (
                    renderTranscriptPreview(transcript.value)
                ) : (
                    <StateView
                        empty={true}
                        emptyTitle={t("No transcript available")}
                        emptyDescription={t("Choose a rail kind or retry to load the integration kit.")}
                        minHeight="180px"
                    />
                )}
            </SurfaceCardText>
        </SurfaceCard>
    );

    const renderStepVerify = () => (
        <ThemedView style={{ gap: "14px" }}>
            <SurfaceCard
                title={t("Upload & Verify the Spec")}
                subtitle={t("Select the JSON spec produced by your external AI. It is parsed locally and validated against the four backend layers.")}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <FormField label={t("Spec File")}>
                        <VFileInput
                            {...{ accept: ".json,application/json" }}
                            modelValue={specFileModel.value}
                            onUpdate:modelValue={(value: File | File[] | null) => void readSpecFile(value)}
                            prependIcon={"mdi-file-code-outline"}
                        />
                    </FormField>

                    {specFileName.value && (
                        <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                            {t("Selected file")}: {specFileName.value}
                        </ThemedText>
                    )}

                    {specError.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {specError.value}
                        </VAlert>
                    )}

                    {verifyLoading.value && <StateView loading={true} minHeight="180px" />}

                    {!verifyLoading.value && verifyError.value && (
                        <StateView
                            error={verifyError.value}
                            minHeight="180px"
                            onRetry={() => (spec.value === null ? undefined : void verifySpec(spec.value))}
                        />
                    )}

                    {!verifyLoading.value && !verifyError.value && !report.value && (
                        <StateView
                            empty={true}
                            emptyTitle={t("No spec verified yet")}
                            emptyDescription={t("Choose a .json file to run the four-layer verification.")}
                            minHeight="180px"
                        />
                    )}
                </SurfaceCardText>
            </SurfaceCard>

            {report.value && (
                <>
                    {renderSummary(report.value)}

                    {report.value.collision?.gatewayExists && (
                        <VAlert type="warning" variant="tonal" prominent>
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText type="defaultSemiBold">{t("Gateway code already exists")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>
                                    {t("The import mode has been pre-selected as New Version. You can change it in the next step.")}{" "}
                                    {t("Existing versions")}: {report.value.collision.versionCount}
                                </ThemedText>
                            </ThemedView>
                        </VAlert>
                    )}

                    {renderRepairPrompt(report.value.aiRepairPrompt, t("Copy AI Repair Prompt"))}

                    {renderScorecard(report.value)}
                    {renderVectors(report.value)}
                    {renderIssueList(report.value.errors, t("Errors"), "error")}
                    {renderIssueList(report.value.warnings, t("Warnings"), "warning")}
                </>
            )}
        </ThemedView>
    );

    const renderCredentials = (nextReport: VerificationReport) => {
        const credentials = nextReport.requiredCredentials ?? [];
        return (
            <SurfaceCard
                title={t("Required Credentials")}
                v-slots={{
                    headerActions: () => (
                        <MetaPill size="x-small" variant="tonal" color="primary">
                            {credentials.length}
                        </MetaPill>
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {credentials.length === 0 ? (
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {t("No credentials are required for this spec.")}
                        </ThemedText>
                    ) : (
                        credentials.map((credential, index) => {
                            const visible = !!visibleSecrets.value[credential.key];
                            const hintParts = [
                                credential.encoding ? `${t("Encoding")}: ${credential.encoding}` : "",
                                credential.description ?? "",
                            ].filter((part) => !!part);
                            const hint = hintParts.join(" • ");
                            const missingSecret =
                                credential.is_secret && !(credentialsValues.value[credential.key] ?? "").trim();
                            return (
                                <div
                                    key={`${credential.key}-${index}`}
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "8px",
                                        paddingTop: index === 0 ? 0 : "12px",
                                        borderTop: index === 0 ? undefined : "1px solid var(--pg-border-subtle)",
                                    }}
                                >
                                    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <MonoRef value={credential.key} copyable={false} />
                                        <StatusBadge
                                            status={credential.is_secret ? "SECRET" : "PLAIN"}
                                            label={credential.is_secret ? t("Secret") : t("Plain")}
                                            toneOverride={credential.is_secret ? "warning" : "info"}
                                            showDot={false}
                                        />
                                        {credential.type && (
                                            <MetaPill size="x-small" variant="text">
                                                {credential.type}
                                            </MetaPill>
                                        )}
                                    </div>

                                    <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: "8px", flexWrap: "wrap" }}>
                                        <div style={{ flex: "1 1 240px", minWidth: "240px" }}>
                                            <FormField
                                                label={credential.key}
                                                hint={hint || undefined}
                                                error={missingSecret ? t("Required before import") : ""}
                                                required={credential.is_secret}
                                                sensitiveMakerChecker={credential.is_secret}
                                            >
                                                <VTextField
                                                    modelValue={credentialsValues.value[credential.key] ?? ""}
                                                    onUpdate:modelValue={(value: string) => {
                                                        credentialsValues.value = {
                                                            ...credentialsValues.value,
                                                            [credential.key]: value,
                                                        };
                                                    }}
                                                    type={credential.is_secret && !visible ? "password" : "text"}
                                                    autocomplete={credential.is_secret ? "new-password" : "off"}
                                                    error={missingSecret}
                                                />
                                            </FormField>
                                        </div>
                                        {credential.is_secret && (
                                            <VBtn
                                                icon
                                                variant="text"
                                                aria-label={visible ? t("Hide secret") : t("Show secret")}
                                                onClick={() => {
                                                    visibleSecrets.value = {
                                                        ...visibleSecrets.value,
                                                        [credential.key]: !visible,
                                                    };
                                                }}
                                            >
                                                <VIcon icon={visible ? "mdi-eye-off" : "mdi-eye"} />
                                            </VBtn>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </SurfaceCardText>
            </SurfaceCard>
        );
    };

    const renderCounts = (counts: Record<string, unknown> | undefined) => {
        const entries = Object.entries(counts ?? {});
        if (entries.length === 0) {
            return <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>{t("No counts returned.")}</ThemedText>;
        }
        return (
            <DescriptionList
                columns={2}
                items={entries.map(([key, value]) => ({
                    label: key,
                    value: formatValue(value),
                    mono: true,
                }))}
            />
        );
    };

    const renderSuccess = (result: ImportResponse) => {
        const credentialCheck = result.credentialCheck;
        return (
            <SurfaceCard
                title={t("Draft created successfully")}
                v-slots={{
                    headerActions: () => (
                        <>
                            <VIcon icon={"mdi-check-decagram"} color="success" size={"24px"} />
                            <StatusBadge
                                status={result.versionState}
                                label={`${result.versionState} v${result.versionNumber}`}
                            />
                        </>
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <DescriptionList
                        columns={2}
                        items={[
                            { label: t("Gateway"), value: <MonoRef value={result.gatewayCode} /> },
                            { label: t("Rail"), value: <MonoRef value={result.railCode} /> },
                            { label: t("Version"), value: result.versionNumber, mono: true },
                            {
                                label: t("State"),
                                value: <StatusBadge status={result.versionState} label={result.versionState} />,
                            },
                            ...(credentialCheck
                                ? [
                                      {
                                          label: t("Credentials"),
                                          value: (
                                              <StatusBadge
                                                  status={credentialCheck.status}
                                                  label={credentialCheck.status}
                                                  toneOverride={credentialCheck.status === "VERIFIED" ? "success" : "danger"}
                                              />
                                          ),
                                      },
                                  ]
                                : []),
                        ]}
                    />

                    {credentialCheck && (
                        <ThemedView style={{ gap: "4px" }}>
                            {credentialCheck.method && (
                                <ThemedText style={{ fontSize: "13px" }}>
                                    <strong>{t("Check method")}:</strong> {credentialCheck.method}
                                </ThemedText>
                            )}
                            {credentialCheck.reason && (
                                <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                                    <strong>{t("Reason")}:</strong> {credentialCheck.reason}
                                </ThemedText>
                            )}
                        </ThemedView>
                    )}

                    <VDivider />

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <ThemedText type="defaultSemiBold">{t("Imported Counts")}</ThemedText>
                        {renderCounts(result.counts)}
                    </div>

                    {result.nextStep && (
                        <VAlert type="info" variant="tonal">
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText type="defaultSemiBold">{t("Next Step")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>{result.nextStep}</ThemedText>
                            </ThemedView>
                        </VAlert>
                    )}

                    <div style={{ display: "flex", flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                        <VBtn color="primary" prependIcon={"mdi-open-in-new"} onClick={openGateway}>
                            {t("Open Gateway")}
                        </VBtn>
                        <VBtn variant="tonal" onClick={startOver}>
                            {t("Start another import")}
                        </VBtn>
                    </div>
                </SurfaceCardText>
            </SurfaceCard>
        );
    };

    const renderStepImport = () => {
        if (!report.value) {
            return (
                <SurfaceCard>
                    <SurfaceCardText>
                        <StateView
                            empty={true}
                            emptyTitle={t("Verify a spec first")}
                            emptyDescription={t("Upload and verify a JSON spec in step 2 before binding credentials.")}
                            minHeight="200px"
                        />
                    </SurfaceCardText>
                </SurfaceCard>
            );
        }

        if (importResult.value) {
            return renderSuccess(importResult.value);
        }

        return (
            <ThemedView style={{ gap: "14px" }}>
                <SurfaceCard
                    title={t("Bind Secrets & Create the Draft")}
                    subtitle={t("Secrets are sent once to the backend and are never prefilled or displayed from storage.")}
                >
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        {report.value.collision?.gatewayExists && (
                            <VAlert type="warning" variant="tonal" density="compact">
                                {t("Gateway code already exists. Importing as a new version is recommended.")}
                            </VAlert>
                        )}

                        <div style={{ maxWidth: "360px" }}>
                            <FormField label={t("Import Mode")}>
                                <VSelect
                                    items={IMPORT_MODES.map((mode) => ({ title: t(mode.title), value: mode.value }))}
                                    modelValue={importMode.value}
                                    onUpdate:modelValue={(value: ImportMode | null) => {
                                        importMode.value = value ?? "CREATE_NEW";
                                    }}
                                />
                            </FormField>
                        </div>
                    </SurfaceCardText>
                </SurfaceCard>

                {renderCredentials(report.value)}

                {missingRequiredCredentials.value.length > 0 && (
                    <VAlert type="warning" variant="tonal">
                        {t("Enter all required secrets before creating the draft")}: {missingRequiredCredentials.value.join(", ")}
                    </VAlert>
                )}

                <FormChecklist
                    checks={IMPORT_CHECKS.map((check) => ({ key: check.key, label: check.label }))}
                    modelValue={importChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (importChecklist.value = value)}
                    show={showChecklists}
                    title={t("Import checklist")}
                    incompleteMessage={t("Complete all import checklist items before creating the draft")}
                    complete={importChecklistComplete.value}
                />

                {!report.value.valid && (
                    <VAlert type="error" variant="tonal">
                        {t("This spec has validation errors. Fix it and verify again before importing.")}
                    </VAlert>
                )}

                {importError.value && (
                    <VAlert type="error" variant="tonal" prominent>
                        <ThemedView style={{ gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Import failed")}</ThemedText>
                            <ThemedText style={{ fontSize: "13px" }}>{importError.value}</ThemedText>
                        </ThemedView>
                    </VAlert>
                )}

                {renderRepairPrompt(importRepairPrompt.value, t("Copy AI Repair Prompt"))}
            </ThemedView>
        );
    };

    const stepTabs = [
        { value: "1", label: `1. ${t("Download Kit")}` },
        { value: "2", label: `2. ${t("Verify Spec")}` },
        { value: "3", label: `3. ${t("Import Draft")}` },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Smart AI Integration")}
                    subtitle={t("Verify an AI-generated gateway specification before binding live secrets.")}
                    end={() => (
                        <VBtn
                            variant="text"
                            prependIcon={"mdi-arrow-left"}
                            onClick={() => void router.push({ name: "Gateways" })}
                        >
                            {t("Back to Gateways")}
                        </VBtn>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    <ThemedView style={{ gap: "4px" }}>
                        <ThemedText type="defaultSemiBold">{t("Bring your own AI")}</ThemedText>
                        <ThemedText style={{ fontSize: "13px" }}>
                            {t("Download the AI kit, generate a spec outside the platform, then upload and verify it here. No AI service is called by the platform.")}
                        </ThemedText>
                    </ThemedView>
                </VAlert>

                <SegmentedTabs
                    modelValue={String(step.value)}
                    tabs={stepTabs}
                    onUpdate:modelValue={(value: string) => (step.value = Number(value))}
                    ariaLabel={t("Smart AI Integration")}
                />

                {step.value === 1 ? renderStepDownload() : step.value === 2 ? renderStepVerify() : renderStepImport()}

                <div
                    style={{
                        display: "flex",
                        flexDirection: "row",
                        justifyContent: "space-between",
                        gap: "12px",
                        flexWrap: "wrap",
                    }}
                >
                    <VBtn variant="tonal" disabled={step.value <= 1} onClick={goBack}>
                        {t("Back")}
                    </VBtn>

                    <div style={{ display: "flex", flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                        {step.value === 1 && (
                            <VBtn color="primary" onClick={() => (step.value = 2)}>
                                {t("Continue to Verify")}
                            </VBtn>
                        )}
                        {step.value === 2 && (
                            <VBtn
                                color="primary"
                                disabled={!report.value?.valid || verifyLoading.value}
                                onClick={() => (step.value = 3)}
                            >
                                {t("Continue to Import")}
                            </VBtn>
                        )}
                        {step.value === 3 && !importResult.value && (
                            <VBtn
                                color="primary"
                                prependIcon={"mdi-database-plus"}
                                loading={importLoading.value}
                                disabled={!canImport.value || !importChecklistComplete.value}
                                onClick={() => void runImport()}
                            >
                                {t("Create Draft")}
                            </VBtn>
                        )}
                        {step.value === 3 && importResult.value && (
                            <VBtn color="primary" onClick={openGateway}>
                                {t("Open Gateway")}
                            </VBtn>
                        )}
                    </div>
                </div>
            </ThemedView>
        </ScreenContainer>
    );
});

export default GatewayAiImportPage;
