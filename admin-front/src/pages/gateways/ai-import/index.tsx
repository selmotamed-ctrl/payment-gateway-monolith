import { dc } from "kt-dc";
import { Fragment, computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VChip,
    VDivider,
    VExpansionPanel,
    VExpansionPanelText,
    VExpansionPanelTitle,
    VExpansionPanels,
    VFileInput,
    VIcon,
    VSelect,
    VStepper,
    VStepperHeader,
    VStepperItem,
    VStepperWindow,
    VStepperWindowItem,
    VTextField,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type RailKind = "OTP_PULL" | "REDIRECT" | "EMBEDDED" | "QR_DISPLAY" | "PUSH_APPROVAL" | "HYBRID";

const RAIL_KINDS: RailKind[] = ["OTP_PULL", "REDIRECT", "EMBEDDED", "QR_DISPLAY", "PUSH_APPROVAL", "HYBRID"];

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
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    direction: "ltr",
    textAlign: "left",
    margin: 0,
    padding: "10px",
    borderRadius: "8px",
    background: "rgba(100,116,139,0.12)",
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

    const canImport = computed(() => !!report.value && spec.value !== null);

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

    const runImport = async () => {
        if (!canImport.value) {
            return;
        }
        importLoading.value = true;
        importError.value = null;
        importRepairPrompt.value = null;
        try {
            const response = await api.post(urlsMap.gatewaySpecImport, {
                spec: spec.value,
                credentialsValues: credentialsValues.value,
                mode: importMode.value,
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
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <ThemedView
                        style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}
                    >
                        <ThemedText type="defaultSemiBold">{t("AI Integration Kit")}</ThemedText>
                        <StatusChip label={payload.specVersion || "-"} tone="info" />
                        <StatusChip label={payload.filename || "-"} tone="neutral" />
                    </ThemedView>

                    {vocabularyEntries.length > 0 && (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            {vocabularyEntries.map(([key, values]) => (
                                <VChip key={key} size="small" variant="tonal" color="primary">
                                    {key}: {(values ?? []).join(", ")}
                                </VChip>
                            ))}
                        </ThemedView>
                    )}

                    <VDivider />

                    <div style={{ ...monoStyle, maxHeight: "320px", overflowY: "auto" }}>
                        {payload.markdown || t("No transcript content returned.")}
                    </div>
                </VCardText>
            </VCard>
        );
    };

    const renderScorecard = (nextReport: VerificationReport) => {
        const layers = nextReport.layers ?? [];
        return (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "10px",
                            flexWrap: "wrap",
                        }}
                    >
                        <ThemedText type="defaultSemiBold">{t("4-Layer Scorecard")}</ThemedText>
                        <StatusChip
                            label={nextReport.valid ? t("VALID") : t("INVALID")}
                            tone={nextReport.valid ? "success" : "error"}
                        />
                    </ThemedView>

                    {layers.length === 0 ? (
                        <ThemedText style={{ opacity: 0.7 }}>{t("No layer results returned.")}</ThemedText>
                    ) : (
                        layers.map((layer) => (
                            <ThemedView
                                key={`${layer.layer}-${layer.name}`}
                                style={{
                                    border: "1px solid rgba(100,116,139,0.25)",
                                    borderRadius: "10px",
                                    padding: "12px",
                                    gap: "8px",
                                }}
                            >
                                <ThemedView
                                    style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        gap: "10px",
                                        flexWrap: "wrap",
                                    }}
                                >
                                    <VChip size="small" variant="tonal" color="primary">
                                        {t("Layer")} {layer.layer}
                                    </VChip>
                                    <ThemedText type="defaultSemiBold" style={{ flex: 1 }}>
                                        {t(layer.name)}
                                    </ThemedText>
                                    <StatusChip
                                        label={layer.passed ? t("PASSED") : t("FAILED")}
                                        tone={layer.passed ? "success" : "error"}
                                    />
                                </ThemedView>
                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                    <VChip size="x-small" variant="text" color="error">
                                        {t("Errors")}: {layer.errorCount}
                                    </VChip>
                                    <VChip size="x-small" variant="text" color="warning">
                                        {t("Warnings")}: {layer.warningCount}
                                    </VChip>
                                </ThemedView>
                            </ThemedView>
                        ))
                    )}
                </VCardText>
            </VCard>
        );
    };

    const renderIssueList = (issues: VerificationIssue[] | undefined, title: string, tone: "error" | "warning") => {
        const list = issues ?? [];
        return (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                        <ThemedText type="defaultSemiBold">{title}</ThemedText>
                        <VChip size="x-small" variant="tonal" color={tone}>
                            {list.length}
                        </VChip>
                    </ThemedView>

                    {list.length === 0 ? (
                        <ThemedText style={{ opacity: 0.7 }}>{t("None")}</ThemedText>
                    ) : (
                        list.map((issue, index) => (
                            <ThemedView
                                key={`${issue.path}-${issue.code}-${index}`}
                                style={{
                                    borderInlineStart: `3px solid ${
                                        tone === "error" ? "rgba(239,68,68,0.75)" : "rgba(245,158,11,0.75)"
                                    }`,
                                    paddingInlineStart: "10px",
                                    gap: "4px",
                                }}
                            >
                                <ThemedView
                                    style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
                                >
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                        {issue.code}
                                    </ThemedText>
                                    {issue.path && (
                                        <ThemedText style={{ ...monoStyle, padding: 0, background: "transparent", opacity: 0.7 }}>
                                            {issue.path}
                                        </ThemedText>
                                    )}
                                </ThemedView>
                                <ThemedText style={{ fontSize: "13px" }}>{issue.message}</ThemedText>
                                {issue.aiFixHint && (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.8 }}>
                                        <strong>{t("AI fix hint")}:</strong> {issue.aiFixHint}
                                    </ThemedText>
                                )}
                            </ThemedView>
                        ))
                    )}
                </VCardText>
            </VCard>
        );
    };

    const renderKeyValues = (title: string, values: Record<string, unknown> | undefined) => {
        const entries = Object.entries(values ?? {});
        return (
            <ThemedView style={{ gap: "6px" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                    {title}
                </ThemedText>
                {entries.length === 0 ? (
                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{t("No data")}</ThemedText>
                ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 220px) 1fr", gap: "6px 12px" }}>
                        {entries.map(([key, value]) => (
                            <Fragment key={key}>
                                <ThemedText style={{ ...monoStyle, padding: 0, background: "transparent", opacity: 0.75 }}>
                                    {key}
                                </ThemedText>
                                <ThemedText style={{ ...monoStyle, padding: 0, background: "transparent" }}>
                                    {formatValue(value)}
                                </ThemedText>
                            </Fragment>
                        ))}
                    </div>
                )}
            </ThemedView>
        );
    };

    const renderRequests = (requests: VectorRequest[] | undefined) => {
        const list = requests ?? [];
        return (
            <ThemedView style={{ gap: "8px" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                    {t("Captured Requests")}
                </ThemedText>
                {list.length === 0 ? (
                    <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{t("No requests captured")}</ThemedText>
                ) : (
                    list.map((request, index) => {
                        const headerEntries = Object.entries(request.headers ?? {});
                        return (
                            <ThemedView
                                key={`${request.method}-${request.url}-${index}`}
                                style={{
                                    border: "1px solid rgba(100,116,139,0.25)",
                                    borderRadius: "10px",
                                    padding: "10px",
                                    gap: "8px",
                                }}
                            >
                                <ThemedText style={{ fontFamily: monoStyle.fontFamily, fontSize: "13px", fontWeight: 700 }}>
                                    {request.method} {request.url}
                                </ThemedText>
                                {headerEntries.length > 0 && (
                                    <pre style={monoStyle}>
                                        {headerEntries.map(([key, value]) => `${key}: ${value}`).join("\n")}
                                    </pre>
                                )}
                                {request.body && <pre style={monoStyle}>{prettyBody(request.body)}</pre>}
                            </ThemedView>
                        );
                    })
                )}
            </ThemedView>
        );
    };

    const renderVectors = (nextReport: VerificationReport) => {
        const vectors = nextReport.vectorResults ?? [];
        const passed = vectors.filter((vector) => vector.passed).length;
        return (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "10px",
                            flexWrap: "wrap",
                        }}
                    >
                        <ThemedText type="defaultSemiBold">{t("Vector Results")}</ThemedText>
                        <StatusChip label={`${passed} / ${vectors.length} ${t("passed")}`} tone={passed === vectors.length ? "success" : "warning"} />
                    </ThemedView>

                    {vectors.length === 0 ? (
                        <ThemedText style={{ opacity: 0.7 }}>{t("No vector results returned.")}</ThemedText>
                    ) : (
                        <VExpansionPanels multiple>
                            {vectors.map((vector, index) => (
                                <VExpansionPanel key={`${vector.name}-${index}`} value={index}>
                                    <VExpansionPanelTitle>
                                        <ThemedView
                                            style={{
                                                flexDirection: "row",
                                                alignItems: "center",
                                                gap: "8px",
                                                flexWrap: "wrap",
                                            }}
                                        >
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                                {vector.name}
                                            </ThemedText>
                                            <StatusChip label={vector.phase || "-"} tone="info" size="x-small" />
                                            <StatusChip
                                                label={vector.passed ? t("PASSED") : t("FAILED")}
                                                tone={vector.passed ? "success" : "error"}
                                                size="x-small"
                                            />
                                            {vector.status && (
                                                <VChip size="x-small" variant="outlined">
                                                    {vector.status}
                                                </VChip>
                                            )}
                                        </ThemedView>
                                    </VExpansionPanelTitle>
                                    <VExpansionPanelText>
                                        <ThemedView style={{ gap: "12px", paddingTop: "6px" }}>
                                            {renderKeyValues(t("Extractions"), vector.extractions)}
                                            {renderRequests(vector.requests)}
                                            {(vector.errors ?? []).length > 0 && (
                                                <VAlert type="error" variant="tonal" density="compact">
                                                    <ThemedView style={{ gap: "4px" }}>
                                                        {(vector.errors ?? []).map((issue, errorIndex) => (
                                                            <ThemedText key={`${issue.code}-${errorIndex}`} style={{ fontSize: "12px" }}>
                                                                {issue.path ? `${issue.path}: ` : ""}
                                                                {issue.message}
                                                            </ThemedText>
                                                        ))}
                                                    </ThemedView>
                                                </VAlert>
                                            )}
                                        </ThemedView>
                                    </VExpansionPanelText>
                                </VExpansionPanel>
                            ))}
                        </VExpansionPanels>
                    )}
                </VCardText>
            </VCard>
        );
    };

    const renderSummary = (nextReport: VerificationReport) => {
        const summary = nextReport.summary;
        return (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <ThemedText type="defaultSemiBold">{t("Verification Summary")}</ThemedText>
                        <StatusChip
                            label={nextReport.valid ? t("VALID") : t("INVALID")}
                            tone={nextReport.valid ? "success" : "error"}
                        />
                        <StatusChip label={nextReport.specVersion || "-"} tone="info" />
                    </ThemedView>
                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        <VChip size="small" variant="tonal">
                            {t("Gateway")}: {summary?.gatewayCode ?? "-"}
                        </VChip>
                        <VChip size="small" variant="tonal">
                            {t("Rail")}: {summary?.railCode ?? "-"}
                        </VChip>
                        <VChip size="small" variant="tonal">
                            {t("Collection Mode")}: {summary?.collectionMode ?? "-"}
                        </VChip>
                        <VChip size="small" variant="tonal">
                            {t("Vectors")}: {summary?.passedVectors ?? 0} / {summary?.vectorCount ?? 0}
                        </VChip>
                        <VChip size="small" variant="tonal" color="error">
                            {t("Errors")}: {summary?.errorCount ?? 0}
                        </VChip>
                        <VChip size="small" variant="tonal" color="warning">
                            {t("Warnings")}: {summary?.warningCount ?? 0}
                        </VChip>
                    </ThemedView>
                    {(summary?.flowPhases ?? []).length > 0 && (
                        <ThemedText style={{ fontSize: "12px", opacity: 0.8 }}>
                            <strong>{t("Flow Phases")}:</strong> {(summary?.flowPhases ?? []).join(" → ")}
                        </ThemedText>
                    )}
                </VCardText>
            </VCard>
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
        <VCard>
            <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                    {t("Download the AI Integration Kit")}
                </ThemedText>
                <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>
                    {t("Download the markdown transcript, hand it to any external AI assistant, and bring the resulting JSON spec back here.")}
                </ThemedText>

                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
                    <VSelect
                        label={t("Rail Kind (optional)")}
                        items={RAIL_KINDS}
                        clearable
                        modelValue={railKind.value}
                        onUpdate:modelValue={(value: RailKind | null) => {
                            railKind.value = value;
                        }}
                        style={{ minWidth: "260px", maxWidth: "320px" }}
                    />
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
                </ThemedView>

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
            </VCardText>
        </VCard>
    );

    const renderStepVerify = () => (
        <ThemedView style={{ gap: "14px" }}>
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                        {t("Upload & Verify the Spec")}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>
                        {t("Select the JSON spec produced by your external AI. It is parsed locally and validated against the four backend layers.")}
                    </ThemedText>

                    <VFileInput
                        {...{ accept: ".json,application/json" }}
                        label={t("Spec File")}
                        modelValue={specFileModel.value}
                        onUpdate:modelValue={(value: File | File[] | null) => void readSpecFile(value)}
                        prependIcon={"mdi-file-code-outline"}
                    />

                    {specFileName.value && (
                        <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
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
                </VCardText>
            </VCard>

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
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                        <ThemedText type="defaultSemiBold">{t("Required Credentials")}</ThemedText>
                        <VChip size="x-small" variant="tonal" color="primary">
                            {credentials.length}
                        </VChip>
                    </ThemedView>

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
                            return (
                                <ThemedView
                                    key={`${credential.key}-${index}`}
                                    style={{
                                        border: "1px solid rgba(100,116,139,0.25)",
                                        borderRadius: "10px",
                                        padding: "12px",
                                        gap: "8px",
                                    }}
                                >
                                    <ThemedView
                                        style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
                                    >
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>
                                            {credential.key}
                                        </ThemedText>
                                        <StatusChip
                                            label={credential.is_secret ? t("Secret") : t("Plain")}
                                            tone={credential.is_secret ? "warning" : "info"}
                                            size="x-small"
                                        />
                                        {credential.type && (
                                            <VChip size="x-small" variant="text">
                                                {credential.type}
                                            </VChip>
                                        )}
                                    </ThemedView>

                                    <ThemedView
                                        style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
                                    >
                                        <VTextField
                                            label={credential.key}
                                            modelValue={credentialsValues.value[credential.key] ?? ""}
                                            onUpdate:modelValue={(value: string) => {
                                                credentialsValues.value = {
                                                    ...credentialsValues.value,
                                                    [credential.key]: value,
                                                };
                                            }}
                                            type={credential.is_secret && !visible ? "password" : "text"}
                                            autocomplete={credential.is_secret ? "new-password" : "off"}
                                            hint={hint || undefined}
                                            persistentHint={!!hint}
                                            style={{ flex: 1, minWidth: "240px" }}
                                        />
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
                                    </ThemedView>
                                </ThemedView>
                            );
                        })
                    )}
                </VCardText>
            </VCard>
        );
    };

    const renderCounts = (counts: Record<string, unknown> | undefined) => {
        const entries = Object.entries(counts ?? {});
        if (entries.length === 0) {
            return <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>{t("No counts returned.")}</ThemedText>;
        }
        return (
            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                {entries.map(([key, value]) => (
                    <VChip key={key} size="small" variant="tonal" color="primary">
                        {key}: {formatValue(value)}
                    </VChip>
                ))}
            </ThemedView>
        );
    };

    const renderSuccess = (result: ImportResponse) => {
        const credentialCheck = result.credentialCheck;
        return (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <ThemedView
                        style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}
                    >
                        <VIcon icon={"mdi-check-decagram"} color="success" size={"30px"} />
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {t("Draft created successfully")}
                        </ThemedText>
                        <StatusChip label={`${result.versionState} v${result.versionNumber}`} tone="success" />
                    </ThemedView>

                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        <VChip size="small" variant="tonal">
                            {t("Gateway")}: {result.gatewayCode}
                        </VChip>
                        <VChip size="small" variant="tonal">
                            {t("Rail")}: {result.railCode}
                        </VChip>
                        <VChip size="small" variant="tonal">
                            {t("Version")}: {result.versionNumber}
                        </VChip>
                        <VChip size="small" variant="tonal">
                            {t("State")}: {result.versionState}
                        </VChip>
                        {credentialCheck && (
                            <StatusChip
                                label={`${t("Credentials")}: ${credentialCheck.status}`}
                                tone={credentialCheck.status === "VERIFIED" ? "success" : "error"}
                            />
                        )}
                    </ThemedView>

                    {credentialCheck && (
                        <ThemedView style={{ gap: "4px" }}>
                            {credentialCheck.method && (
                                <ThemedText style={{ fontSize: "13px" }}>
                                    <strong>{t("Check method")}:</strong> {credentialCheck.method}
                                </ThemedText>
                            )}
                            {credentialCheck.reason && (
                                <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>
                                    <strong>{t("Reason")}:</strong> {credentialCheck.reason}
                                </ThemedText>
                            )}
                        </ThemedView>
                    )}

                    <VDivider />

                    <ThemedView style={{ gap: "8px" }}>
                        <ThemedText type="defaultSemiBold">{t("Imported Counts")}</ThemedText>
                        {renderCounts(result.counts)}
                    </ThemedView>

                    {result.nextStep && (
                        <VAlert type="info" variant="tonal">
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText type="defaultSemiBold">{t("Next Step")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>{result.nextStep}</ThemedText>
                            </ThemedView>
                        </VAlert>
                    )}

                    <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                        <VBtn color="primary" prependIcon={"mdi-open-in-new"} onClick={openGateway}>
                            {t("Open Gateway")}
                        </VBtn>
                        <VBtn variant="tonal" onClick={startOver}>
                            {t("Start another import")}
                        </VBtn>
                    </ThemedView>
                </VCardText>
            </VCard>
        );
    };

    const renderStepImport = () => {
        if (!report.value) {
            return (
                <VCard>
                    <VCardText>
                        <StateView
                            empty={true}
                            emptyTitle={t("Verify a spec first")}
                            emptyDescription={t("Upload and verify a JSON spec in step 2 before binding credentials.")}
                            minHeight="200px"
                        />
                    </VCardText>
                </VCard>
            );
        }

        if (importResult.value) {
            return renderSuccess(importResult.value);
        }

        return (
            <ThemedView style={{ gap: "14px" }}>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Bind Secrets & Create the Draft")}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>
                            {t("Secrets are sent once to the backend and are never prefilled or displayed from storage.")}
                        </ThemedText>

                        {report.value.collision?.gatewayExists && (
                            <VAlert type="warning" variant="tonal" density="compact">
                                {t("Gateway code already exists. Importing as a new version is recommended.")}
                            </VAlert>
                        )}

                        <VSelect
                            label={t("Import Mode")}
                            items={IMPORT_MODES.map((mode) => ({ title: t(mode.title), value: mode.value }))}
                            modelValue={importMode.value}
                            onUpdate:modelValue={(value: ImportMode | null) => {
                                importMode.value = value ?? "CREATE_NEW";
                            }}
                            style={{ maxWidth: "360px" }}
                        />
                    </VCardText>
                </VCard>

                {renderCredentials(report.value)}

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

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Smart AI Integration")}
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

                <VStepper v-model={step.value} flat style={{ background: "transparent" }}>
                    <VStepperHeader>
                        <VStepperItem title={t("Download Kit")} value={1} />
                        <VStepperItem title={t("Verify Spec")} value={2} />
                        <VStepperItem title={t("Import Draft")} value={3} />
                    </VStepperHeader>
                    <VStepperWindow>
                        <VStepperWindowItem value={1}>{renderStepDownload()}</VStepperWindowItem>
                        <VStepperWindowItem value={2}>{renderStepVerify()}</VStepperWindowItem>
                        <VStepperWindowItem value={3}>{renderStepImport()}</VStepperWindowItem>
                    </VStepperWindow>
                </VStepper>

                <ThemedView
                    style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        gap: "12px",
                        flexWrap: "wrap",
                    }}
                >
                    <VBtn variant="tonal" disabled={step.value <= 1} onClick={goBack}>
                        {t("Back")}
                    </VBtn>

                    <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                        {step.value === 1 && (
                            <VBtn color="primary" onClick={() => (step.value = 2)}>
                                {t("Continue to Verify")}
                            </VBtn>
                        )}
                        {step.value === 2 && (
                            <VBtn
                                color="primary"
                                disabled={!report.value || verifyLoading.value}
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
                                disabled={!canImport.value}
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
                    </ThemedView>
                </ThemedView>
            </ThemedView>
        </ScreenContainer>
    );
});

export default GatewayAiImportPage;
