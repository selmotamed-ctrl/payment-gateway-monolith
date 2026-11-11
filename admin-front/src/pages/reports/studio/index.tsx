import { dc } from "kt-dc";
import { computed, onMounted, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { VAlert, VBtn, VCol, VFileInput, VRow, VSelect } from "vuetify/components";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { ReportDiagnosticsPanel } from "@/components/reports/ReportDiagnosticsPanel";
import { JsonSpecEditor } from "@/components/reports/JsonSpecEditor";
import { AuthorityOverrideModal, type AuthorityOverridePayload } from "@/components/reports/AuthorityOverrideModal";
import {
  DescriptionList,
  MetaPill,
  MonoRef,
  PageHeader,
  SegmentedTabs,
  StatusBadge,
  SurfaceCard,
} from "@/components/ui";
import { formatDateTime } from "@/components/ledger/format";
import { api } from "@/state/api";
import {
  ReportPagedPreviewSurface,
  renderChromeHtml,
  renderReportSectionsToHtml,
  specTranslator,
  type ReportDescriptorSpec,
  type ReportDiagnostic,
  type ReportExecutionBundle,
} from "@/lib/reportEngineSdk";
import {
  ASSET_ZIP_TOO_LARGE_MESSAGE,
  diagnosticsFromApiError,
  friendlyApiErrorMessage,
} from "@/utils/reports/diagnostics";
import {
  downloadText,
  fileToBase64,
  formatBytes,
  isAssetZipTooLarge,
  layerStatus,
  type LayerScore,
} from "@/utils/reports/jsonSpec";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities, user } from "@/state/user";

type PendingAmlBypass = {
  id: string;
  reportSpecId: string;
  reportCode: string;
  allowedRoles: string[];
  allowedAuthorities: string[];
  justification: string;
  makerEmail: string;
  makerUserId?: string;
  createdAt: string;
  canDecide: boolean;
};

type VersionRow = {
  id: string;
  code: string;
  version: number;
  status: string;
  isLatestPublished: boolean;
  createdAt: string;
  publishedAt: string | null;
};

type ExecutionRow = {
  id: string;
  reportSpecId: string;
  reportCode: string;
  reportVersion: number;
  actorUserId: string;
  actorRole: string;
  actorEmail?: string | null;
  actorName?: string | null;
  selectedLocale: string;
  rowCountTotal: number;
  durationMs: number;
  verificationSha256: string;
  renderTarget?: string | null;
  createdAt: string;
};

type VerificationReport = {
  valid: boolean;
  specVersion: string | null;
  layers: LayerScore[];
  authorityInference: {
    queriedModels: string[];
    queriedDomains: string[];
    inferredRequiredAuthorities: string[];
    inferredNaturalRoles: string[];
    requiresConfidentialAmlAccess: boolean;
    containsMaskedPiiColumns: boolean;
    conflictStatus: string;
    conflictDetails: Array<{ code: string; message: string; resolutionHint: string }>;
    effectiveAccessPolicy: { mode: string; allowedRoles: string[]; requiredAnyAuthorities: string[]; requiredAllAuthorities: string[] };
  } | null;
  verifiedAssets: Array<{ assetKey: string; fileName: string; mimeType: string; sha256: string; bytes: number }>;
  diagnostics: ReportDiagnostic[];
  aiRepairPrompt?: string;
};

const DOMAINS = [
  "LEDGER",
  "PAYMENTS",
  "MERCHANTS",
  "COMPLIANCE_AML",
  "GATEWAYS",
  "RECONCILIATION",
  "SECURITY_AUDIT",
  "OPERATIONS",
];

const ROLES = ["GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "OPERATOR", "COMPLIANCE", "MLRO", "SUPPORT"];
const AUTHORITIES = [
  "merchant:read",
  "kyb:read",
  "compliance:read",
  "aml:read",
  "report:review",
  "report:approve",
  "finance:read",
  "cashout:read",
  "commission:read",
  "reconciliation:read",
  "gateway:read",
  "operator:read",
  "security:read",
  "security:write",
  "report_engine:author",
  "report_engine:run",
];

const LAYER_TONE = { PASSED: "success", FAILED: "danger", SKIPPED: "neutral" } as const;

const pickFile = (files: File | File[] | null): File | null => (Array.isArray(files) ? (files[0] ?? null) : files);

const specHasRequiredAssets = (json: string): boolean => {
  try {
    const parsed = JSON.parse(json) as { required_assets?: unknown[] };
    return Array.isArray(parsed.required_assets) && parsed.required_assets.length > 0;
  } catch {
    return false;
  }
};

const ReportsStudioPage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const domains = ref<string[]>([]);
  const specJson = ref("");
  const specFile = ref<File | null>(null);
  const zipFile = ref<File | null>(null);
  const zipError = ref("");
  const verification = ref<VerificationReport | null>(null);
  const previewBundle = ref<ReportExecutionBundle | null>(null);
  const previewLocale = ref("en");
  const previewPages = ref(1);
  const previewLoading = ref(false);
  const previewRef = ref<{ printClientSideVectorPdf?: () => void } | null>(null);
  /** Editor JSON and zip the current `verification` was produced from; any edit invalidates it. */
  const verifiedInput = ref<{ json: string; zip: File | null } | null>(null);
  const savedSpecId = ref<string | null>(null);
  const savedSpecCode = ref<string | null>(null);
  const savedSpecVersion = ref<number | null>(null);
  const loadedNeedsAssets = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const actionDiagnostics = ref<ReportDiagnostic[]>([]);
  const pendingAml = ref<PendingAmlBypass[]>([]);
  const historyRows = ref<VersionRow[]>([]);
  const historyLoading = ref(false);
  const executions = ref<ExecutionRow[]>([]);
  const executionsLoading = ref(false);
  const historyTab = ref<"versions" | "executions">("versions");
  const overrideOpen = ref(false);
  const overrideError = ref("");

  const currentUserId = computed(() => String(user.value?.userInfo?.id ?? ""));
  const currentUserEmail = computed(() => String(user.value?.userInfo?.email ?? "").toLowerCase());
  const canVerify = computed(() => specJson.value.trim().length > 0 && !zipError.value);
  const verificationCurrent = computed(
    () =>
      Boolean(verification.value) &&
      verifiedInput.value?.json === specJson.value &&
      verifiedInput.value?.zip === zipFile.value,
  );
  const verificationStale = computed(() => Boolean(verification.value) && !verificationCurrent.value);
  const canSave = computed(() => verificationCurrent.value && verification.value?.valid === true && !zipError.value);
  watch(
    () => [specJson.value, zipFile.value],
    () => {
      previewBundle.value = null;
    },
  );
  const canChrome = computed(() => hasOneOfAuthorities(["reports.studio", "security:write"]));
  const canApproveAml = computed(() => ["MLRO", "SECURITY_ADMIN"].includes(String(user.value?.userInfo?.role ?? "")));
  const canOverride = computed(
    () =>
      hasOneOfAuthorities(["security:write", "security.write"]) ||
      String(user.value?.userInfo?.role ?? "") === "SECURITY_ADMIN",
  );
  const isVerified = computed(() => verificationCurrent.value && verification.value?.valid === true);
  const previewSectionsHtml = computed(() =>
    previewBundle.value
      ? renderReportSectionsToHtml({ bundle: previewBundle.value, locale: previewLocale.value, t })
      : "",
  );
  const previewHeaderHtml = computed(() =>
    previewBundle.value
      ? renderChromeHtml({
          chrome: previewBundle.value.resolvedHeaderChrome,
          bundle: previewBundle.value,
          locale: previewLocale.value,
          t,
        })
      : "",
  );
  const previewFooterHtml = computed(() =>
    previewBundle.value
      ? renderChromeHtml({
          chrome: previewBundle.value.resolvedFooterChrome,
          bundle: previewBundle.value,
          locale: previewLocale.value,
          t,
        })
      : "",
  );

  const fail = (caught: unknown, withDiagnostics = true) => {
    if (withDiagnostics) actionDiagnostics.value = diagnosticsFromApiError(caught);
    error.value = friendlyApiErrorMessage(caught, t);
  };
  const resetFeedback = () => {
    error.value = null;
    actionDiagnostics.value = [];
  };

  watch(zipFile, (file) => {
    zipError.value = isAssetZipTooLarge(file) ? t(ASSET_ZIP_TOO_LARGE_MESSAGE) : "";
  });

  const isMakerOf = (approval: PendingAmlBypass) =>
    approval.canDecide === false ||
    (Boolean(approval.makerUserId) && approval.makerUserId === currentUserId.value) ||
    (Boolean(approval.makerEmail) && approval.makerEmail.toLowerCase() === currentUserEmail.value);

  // ---------- data loading ----------
  const loadPendingAml = async () => {
    if (!canApproveAml.value) return;
    try {
      const response = await api.get(urlsMap.reportEngineAmlBypassPending);
      pendingAml.value = (response.data?.approvals ?? []) as PendingAmlBypass[];
    } catch {
      pendingAml.value = [];
    }
  };

  const loadHistory = async (code?: string | null) => {
    if (!code) return;
    historyLoading.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineSpecs, { params: { code } });
      historyRows.value = (response.data?.specs ?? []) as VersionRow[];
    } catch (caught) {
      historyRows.value = [];
      fail(caught, false);
    } finally {
      historyLoading.value = false;
    }
  };

  const loadExecutions = async (code?: string | null) => {
    if (!code) return;
    executionsLoading.value = true;
    try {
      // `code` is forwarded for servers that filter; the list is filtered client-side either way.
      const response = await api.get(urlsMap.reportEngineExecutions, { params: { limit: 200, code } });
      const rows = (response.data?.executions ?? []) as ExecutionRow[];
      executions.value = rows.filter((row) => row.reportCode === code);
    } catch (caught) {
      executions.value = [];
      fail(caught, false);
    } finally {
      executionsLoading.value = false;
    }
  };

  const refreshHistoryTab = () =>
    historyTab.value === "versions" ? loadHistory(savedSpecCode.value) : loadExecutions(savedSpecCode.value);

  watch(historyTab, () => void refreshHistoryTab());

  // ---------- transcript ----------
  const downloadTranscript = async (kind: "REPORT" | "CHROME") => {
    busy.value = true;
    resetFeedback();
    try {
      const response = await api.get(urlsMap.reportEngineTranscript, {
        params: kind === "REPORT" ? { kind, domains: domains.value.join(",") } : { kind },
      });
      const data = response.data ?? {};
      const fallback = kind === "REPORT" ? "report-engine-ai-transcript-v1.0.md" : "chrome-engine-ai-transcript-v1.0.md";
      downloadText(data.filename ?? fallback, data.markdown ?? "", "text/markdown");
    } catch (caught) {
      fail(caught, false);
    } finally {
      busy.value = false;
    }
  };

  // ---------- editor ----------
  const readSpecFile = async (file: File | null) => {
    specFile.value = file;
    if (file) {
      specJson.value = await file.text();
      loadedNeedsAssets.value = false;
    }
  };

  const clearEditor = () => {
    specJson.value = "";
    previewBundle.value = null;
    specFile.value = null;
    zipFile.value = null;
    verification.value = null;
    verifiedInput.value = null;
    savedSpecId.value = null;
    savedSpecCode.value = null;
    savedSpecVersion.value = null;
    loadedNeedsAssets.value = false;
    historyRows.value = [];
    executions.value = [];
    resetFeedback();
  };

  const verify = async () => {
    if (zipError.value) return;
    previewBundle.value = null;
    busy.value = true;
    resetFeedback();
    verification.value = null;
    verifiedInput.value = null;
    const json = specJson.value;
    const zip = zipFile.value;
    try {
      const assetsZipBase64 = zip ? await fileToBase64(zip) : undefined;
      const response = await api.post(urlsMap.reportEngineVerify, { specJson: json, assetsZipBase64 });
      verification.value = response.data as VerificationReport;
      verifiedInput.value = { json, zip };
    } catch (caught) {
      fail(caught);
    } finally {
      busy.value = false;
    }
  };

  const runPreview = async () => {
    if (!canSave.value) return;
    previewLoading.value = true;
    resetFeedback();
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEnginePreview, {
        specJson: specJson.value,
        assetsZipBase64,
      });
      const bundle = response.data?.bundle as ReportExecutionBundle | undefined;
      previewBundle.value = bundle ?? null;
      previewLocale.value = bundle?.spec.i18n.default_locale ?? "en";
      previewPages.value = 1;
      if (bundle) showSnackBar({ message: t("Preview generated"), type: "success" });
    } catch (caught) {
      previewBundle.value = null;
      fail(caught);
    } finally {
      previewLoading.value = false;
    }
  };

  const applySaveResponse = async (data: { id?: unknown; code?: unknown; version?: unknown }) => {
    savedSpecId.value = String(data?.id ?? "") || null;
    savedSpecCode.value = String(data?.code ?? "") || null;
    savedSpecVersion.value = Number(data?.version ?? 0) || null;
    await loadHistory(savedSpecCode.value);
  };

  const save = async (publish: boolean) => {
    if (!canSave.value) return;
    busy.value = true;
    resetFeedback();
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineSpecs, {
        specJson: specJson.value,
        assetsZipBase64,
        publish,
      });
      showSnackBar({ message: publish ? t("Report published") : t("Report saved as verified"), type: "success" });
      await applySaveResponse(response.data ?? {});
    } catch (caught) {
      fail(caught);
    } finally {
      busy.value = false;
    }
  };

  // ---------- version history ----------
  const openInEditor = async (row: VersionRow) => {
    busy.value = true;
    resetFeedback();
    try {
      const response = await api.get(urlsMap.reportEngineSpecDetail(row.id));
      const json = JSON.stringify(response.data?.spec ?? {}, null, 2);
      specJson.value = json;
      specFile.value = null;
      zipFile.value = null;
      verification.value = null;
      verifiedInput.value = null;
      savedSpecId.value = row.id;
      savedSpecCode.value = row.code;
      savedSpecVersion.value = row.version;
      loadedNeedsAssets.value = specHasRequiredAssets(json);
      showSnackBar({ message: t("Loaded {name} into the editor", { name: `${row.code} v${row.version}` }), type: "success" });
    } catch (caught) {
      fail(caught, false);
    } finally {
      busy.value = false;
    }
  };

  const publishVersion = async (row: VersionRow) => {
    const confirmed = await showConfirm({
      title: t("Publish this version?"),
      message: t("{name} becomes the published version that report runners see.", { name: `${row.code} v${row.version}` }),
      submitButtonLabel: t("Publish"),
      type: "primary",
    });
    if (!confirmed) return;
    busy.value = true;
    resetFeedback();
    try {
      await api.post(urlsMap.reportEnginePublish(row.id), {});
      showSnackBar({ message: t("Report published"), type: "success" });
      await loadHistory(row.code);
    } catch (caught) {
      fail(caught);
    } finally {
      busy.value = false;
    }
  };

  const archiveVersion = async (row: VersionRow) => {
    const confirmed = await showConfirm({
      title: t("Archive report version"),
      message: t("Archive {name}? It can no longer be run or published.", { name: `${row.code} v${row.version}` }),
      submitButtonLabel: t("Archive"),
      type: "error",
    });
    if (!confirmed) return;
    busy.value = true;
    resetFeedback();
    try {
      await api.post(urlsMap.reportEngineArchive(row.id), {});
      showSnackBar({ message: t("Report version archived"), type: "success" });
      await loadHistory(row.code);
    } catch (caught) {
      fail(caught, false);
    } finally {
      busy.value = false;
    }
  };

  // ---------- authority override ----------
  const applyOverride = async (payload: AuthorityOverridePayload) => {
    if (!savedSpecId.value) return;
    busy.value = true;
    overrideError.value = "";
    try {
      const response = await api.post(urlsMap.reportEngineOverride(savedSpecId.value), payload);
      overrideOpen.value = false;
      if (response.data?.status === "PENDING_REVIEW") {
        showSnackBar({ message: t("AML bypass requested; a different MLRO or Security Admin must approve it"), type: "success" });
        await loadPendingAml();
      } else {
        showSnackBar({ message: t("Authority override saved and audited"), type: "success" });
      }
    } catch (caught) {
      overrideError.value = friendlyApiErrorMessage(caught, t);
    } finally {
      busy.value = false;
    }
  };

  const clearOverride = async () => {
    if (!savedSpecId.value) return;
    const confirmed = await showConfirm({
      title: t("Clear override"),
      message: t("Clear the authority override? The inferred access policy applies again."),
      submitButtonLabel: t("Clear override"),
      type: "error",
    });
    if (!confirmed) return;
    busy.value = true;
    resetFeedback();
    try {
      await api.post(urlsMap.reportEngineOverride(savedSpecId.value), {
        clear: true,
        allowedRoles: [],
        allowedAuthorities: [],
        justification: "Override cleared by a Security Admin",
      });
      showSnackBar({ message: t("Authority override cleared"), type: "success" });
    } catch (caught) {
      fail(caught, false);
    } finally {
      busy.value = false;
    }
  };

  // ---------- AML bypass checker ----------
  const decideAmlBypass = async (approval: PendingAmlBypass, approve: boolean) => {
    const confirmed = await showConfirm({
      title: approve ? t("Approve AML bypass") : t("Reject AML bypass"),
      message: approve
        ? t("Approve the confidential AML bypass for {name}? Its allowed roles will see AML-confidential data.", { name: approval.reportCode })
        : t("Reject the confidential AML bypass for {name}?", { name: approval.reportCode }),
      submitButtonLabel: approve ? t("Approve") : t("Reject"),
      type: approve ? "primary" : "error",
    });
    if (!confirmed) return;
    busy.value = true;
    resetFeedback();
    try {
      await api.post(
        approve ? urlsMap.reportEngineAmlBypassApprove(approval.id) : urlsMap.reportEngineAmlBypassReject(approval.id),
        approve ? {} : { notes: t("Rejected by MLRO/Security Admin") },
      );
      showSnackBar({ message: approve ? t("AML bypass approved") : t("AML bypass rejected"), type: "success" });
      await loadPendingAml();
    } catch (caught) {
      fail(caught, false);
    } finally {
      busy.value = false;
    }
  };

  const copyRepairPrompt = async () => {
    if (!verification.value?.aiRepairPrompt) return;
    try {
      await navigator.clipboard.writeText(verification.value.aiRepairPrompt);
      showSnackBar({ message: t("AI repair prompt copied"), type: "success" });
    } catch {
      showSnackBar({ message: t("Could not copy to the clipboard"), type: "error" });
    }
  };

  // ---------- tables ----------
  const historyHeaders = computed<TableHeader<VersionRow>[]>(() => [
    {
      key: "version",
      label: t("Version"),
      Value: ({ row }) => (
        <div class="d-flex align-center ga-2">
          <span class="pg-mono">v{row.version}</span>
          {row.isLatestPublished && <MetaPill size="x-small" color="success">{t("latest")}</MetaPill>}
          {row.id === savedSpecId.value && <MetaPill size="x-small" color="info">{t("In editor")}</MetaPill>}
        </div>
      ),
    },
    { key: "status", label: t("Status"), Value: ({ row }) => <StatusBadge status={row.status} /> },
    { key: "createdAt", label: t("Created At"), value: (row) => formatDateTime(row.createdAt) },
    { key: "publishedAt", label: t("Published At"), value: (row) => formatDateTime(row.publishedAt) },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{
            label: t("Open in editor"),
            icon: "mdi-code-json",
            disabled: busy.value,
            onClick: () => void openInEditor(row),
          }}
          items={[
            {
              key: "publish",
              label: t("Publish"),
              icon: "mdi-publish",
              hidden: row.status !== "VERIFIED",
              onClick: () => void publishVersion(row),
            },
            {
              key: "archive",
              label: t("Archive"),
              icon: "mdi-archive-outline",
              danger: true,
              dividerBefore: row.status === "VERIFIED",
              hidden: row.status === "ARCHIVED",
              onClick: () => void archiveVersion(row),
            },
          ]}
        />
      ),
    },
  ]);

  const executionHeaders = computed<TableHeader<ExecutionRow>[]>(() => [
    { key: "createdAt", label: t("Time"), value: (row) => formatDateTime(row.createdAt) },
    { key: "reportVersion", label: t("Version"), Value: ({ row }) => <span class="pg-mono">v{row.reportVersion}</span> },
    {
      key: "actor",
      label: t("Actor"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span>{row.actorName || row.actorEmail || <MonoRef value={row.actorUserId} truncate={8} />}</span>
          {row.actorRole && <span class="text-caption text-medium-emphasis">{row.actorRole}</span>}
        </div>
      ),
    },
    { key: "selectedLocale", label: t("Locale"), value: (row) => String(row.selectedLocale ?? "").toUpperCase() },
    { key: "rowCountTotal", label: t("Rows"), value: (row) => Number(row.rowCountTotal ?? 0).toLocaleString() },
    { key: "durationMs", label: t("Duration"), value: (row) => `${Number(row.durationMs ?? 0).toLocaleString()} ms` },
    {
      key: "verificationSha256",
      label: t("Verification hash"),
      Value: ({ row }) => <MonoRef value={row.verificationSha256} truncate={12} />,
    },
  ]);

  const amlHeaders = computed<TableHeader<PendingAmlBypass>[]>(() => [
    { key: "reportCode", label: t("Report"), Value: ({ row }) => <MonoRef value={row.reportCode} /> },
    { key: "makerEmail", label: t("Requested by"), value: (row) => row.makerEmail || "—" },
    { key: "allowedRoles", label: t("Allowed roles"), value: (row) => row.allowedRoles.join(", ") || "—" },
    { key: "justification", label: t("Justification"), value: (row) => row.justification || "—" },
    { key: "createdAt", label: t("Created At"), value: (row) => formatDateTime(row.createdAt) },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) =>
        isMakerOf(row) ? (
          <span class="text-caption text-medium-emphasis">{t("Your request")}</span>
        ) : (
          <TableRowActions
            primaryAction={{
              label: t("Approve"),
              icon: "mdi-check",
              disabled: busy.value,
              onClick: () => void decideAmlBypass(row, true),
            }}
            items={[
              {
                key: "reject",
                label: t("Reject"),
                icon: "mdi-close",
                danger: true,
                onClick: () => void decideAmlBypass(row, false),
              },
            ]}
          />
        ),
    },
  ]);

  onMounted(() => {
    void loadPendingAml();
  });

  const renderScorecard = (report: VerificationReport) => (
    <SurfaceCard
      title={t("Step 3 — Verification Scorecard")}
      subtitle={t("Layers 1-5, diagnostics and the one-click AI repair prompt")}
      v-slots={
        report.aiRepairPrompt
          ? {
              headerActions: () => (
                <VBtn size="small" variant="tonal" prependIcon="mdi-content-copy" onClick={() => void copyRepairPrompt()}>
                  {t("Copy AI Repair Prompt")}
                </VBtn>
              ),
            }
          : undefined
      }
    >
      <div class="d-flex flex-column ga-4">
        {verificationStale.value && (
          <VAlert type="warning" variant="tonal">
            {t("The spec or asset bundle changed after verification. Verify again before saving or publishing.")}
          </VAlert>
        )}
        <div class="d-flex flex-wrap ga-2">
          {report.layers.map((layer) => {
            const status = layerStatus(layer);
            const outcome =
              status === "PASSED"
                ? t("Passed")
                : status === "SKIPPED"
                  ? t("Skipped")
                  : `${layer.errorCount} ${t("errors")}`;
            return (
              <StatusBadge
                key={layer.layer}
                status={status}
                label={`${t("Layer")} ${layer.layer} · ${layer.name} — ${outcome}`}
                toneOverride={LAYER_TONE[status]}
              />
            );
          })}
        </div>
        {report.diagnostics.length > 0 && (
          <ReportDiagnosticsPanel diagnostics={report.diagnostics} title={t("Verification diagnostics")} />
        )}
        {report.verifiedAssets.length > 0 && (
          <DescriptionList
            items={report.verifiedAssets.map((asset) => ({
              label: asset.assetKey,
              value: (
                <span class="d-inline-flex flex-wrap align-center ga-2">
                  <span>{asset.fileName}</span>
                  <MetaPill size="x-small">{formatBytes(asset.bytes)}</MetaPill>
                  <MonoRef value={asset.sha256} truncate={12} />
                </span>
              ),
            }))}
          />
        )}
      </div>
    </SurfaceCard>
  );

  const renderAuthority = (report: VerificationReport) => {
    const inference = report.authorityInference;
    if (!inference) return null;
    return (
      <SurfaceCard
        title={t("Step 4 — Authority Inference")}
        subtitle={t("Computed from the queried models and columns")}
        v-slots={
          canOverride.value
            ? {
                headerActions: () => (
                  <div class="d-flex flex-wrap ga-2">
                    <VBtn
                      size="small"
                      variant="tonal"
                      prependIcon="mdi-shield-account-outline"
                      disabled={!savedSpecId.value || busy.value}
                      onClick={() => {
                        overrideError.value = "";
                        overrideOpen.value = true;
                      }}
                    >
                      {t("Security Admin Authority Override")}
                    </VBtn>
                    <VBtn
                      size="small"
                      variant="tonal"
                      prependIcon="mdi-shield-off-outline"
                      disabled={!savedSpecId.value || busy.value}
                      onClick={() => void clearOverride()}
                    >
                      {t("Clear override")}
                    </VBtn>
                  </div>
                ),
              }
            : undefined
        }
      >
        <div class="d-flex flex-column ga-3">
          <DescriptionList
            items={[
              { label: t("Queried models"), value: inference.queriedModels.join(", ") || "—" },
              { label: t("Queried domains"), value: inference.queriedDomains.join(", ") || "—" },
              { label: t("Inferred roles"), value: inference.inferredNaturalRoles.join(", ") || "—" },
              { label: t("Required authorities"), value: inference.inferredRequiredAuthorities.join(", ") || "—" },
              { label: t("Conflict status"), value: <StatusBadge status={inference.conflictStatus} /> },
              { label: t("Confidential AML"), value: inference.requiresConfidentialAmlAccess ? t("Yes") : t("No") },
              { label: t("Masked PII"), value: inference.containsMaskedPiiColumns ? t("Yes") : t("No") },
            ]}
          />
          {inference.conflictDetails.map((conflict) => (
            <VAlert key={conflict.code} type="warning" variant="tonal">
              <div class="d-flex flex-wrap align-center ga-2">
                <MonoRef value={conflict.code} />
                <span>{conflict.message}</span>
              </div>
              <div class="text-caption mt-1">{conflict.resolutionHint}</div>
            </VAlert>
          ))}
          {canOverride.value && !savedSpecId.value && (
            <div class="text-caption text-medium-emphasis">{t("Save the spec as verified first so the override can be attached")}</div>
          )}
        </div>
      </SurfaceCard>
    );
  };

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Studio")}
          subtitle={t("Download the AI transcript, verify a spec, infer authorities and publish")}
          badge={isVerified.value ? "VERIFIED" : "DRAFT"}
          badgeLabel={isVerified.value ? t("Verified") : t("Draft")}
          badgeTone={isVerified.value ? "success" : "neutral"}
          end={() => (
            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <VBtn variant="tonal" prependIcon="mdi-file-chart-outline" onClick={() => void router.push({ name: "ReportsCatalog" })}>
                {t("Open Catalog")}
              </VBtn>
              {canChrome.value && (
                <VBtn variant="tonal" prependIcon="mdi-page-layout-header-footer" onClick={() => void router.push({ name: "ReportsChrome" })}>
                  {t("Headers & Footers")}
                </VBtn>
              )}
              {canApproveAml.value && (
                <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => void loadPendingAml()}>
                  {t("Refresh pending")}
                </VBtn>
              )}
            </ThemedView>
          )}
        />

        {error.value && (
          <VAlert type="error" variant="tonal" closable onClick:close={() => (error.value = null)}>
            {error.value}
          </VAlert>
        )}
        {actionDiagnostics.value.length > 0 && (
          <ReportDiagnosticsPanel diagnostics={actionDiagnostics.value} title={t("Action diagnostics")} />
        )}

        <SurfaceCard title={t("Step 1 — AI Authoring Transcript")} subtitle={t("The transcript contains the live schema, optimization rules and bilingual contract")}>
          <VRow dense align="center">
            <VCol cols={12} md={5}>
              <VSelect
                modelValue={domains.value}
                onUpdate:modelValue={(value: string[]) => (domains.value = value)}
                label={t("Domains")}
                items={DOMAINS}
                multiple
                chips
              />
            </VCol>
            <VCol cols={12} md={7} class="d-flex flex-wrap ga-2">
              <VBtn color="primary" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadTranscript("REPORT")}>
                {t("Download Report AI Transcript")}
              </VBtn>
              <VBtn variant="tonal" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadTranscript("CHROME")}>
                {t("Download Header/Footer AI Transcript")}
              </VBtn>
            </VCol>
          </VRow>
        </SurfaceCard>

        <SurfaceCard
          title={t("Step 2 — Upload Spec and Optional Asset Bundle")}
          subtitle={t("Standalone JSON or JSON paired with an assets .zip")}
          v-slots={
            savedSpecCode.value
              ? {
                  headerActions: () => (
                    <MetaPill prependIcon="mdi-code-json">{`${savedSpecCode.value}${savedSpecVersion.value ? ` v${savedSpecVersion.value}` : ""}`}</MetaPill>
                  ),
                }
              : undefined
          }
        >
          <div class="d-flex flex-column ga-3">
            <VRow dense>
              <VCol cols={12} md={6}>
                <VFileInput
                  label={t("Report spec (.json)")}
                  {...{ accept: "application/json,.json" }}
                  modelValue={specFile.value}
                  onUpdate:modelValue={(files: File | File[] | null) => void readSpecFile(pickFile(files))}
                />
              </VCol>
              <VCol cols={12} md={6}>
                <VFileInput
                  label={t("Asset bundle (.zip, optional)")}
                  {...{ accept: "application/zip,.zip" }}
                  modelValue={zipFile.value}
                  errorMessages={zipError.value ? [zipError.value] : []}
                  onUpdate:modelValue={(files: File | File[] | null) => (zipFile.value = pickFile(files))}
                />
              </VCol>
            </VRow>
            {loadedNeedsAssets.value && !zipFile.value && (
              <VAlert type="info" variant="tonal">
                {t("This spec declares required assets. Re-attach its asset bundle (.zip) before verifying.")}
              </VAlert>
            )}
            <JsonSpecEditor
              modelValue={specJson.value}
              onUpdate:modelValue={(value: string) => (specJson.value = value)}
              onClear={clearEditor}
              label={t("Spec JSON")}
              downloadName={savedSpecCode.value ? `${savedSpecCode.value}.json` : "report-spec.json"}
              copiedMessage={t("Spec JSON copied")}
            />
            <div class="d-flex flex-wrap align-center ga-2">
              <VBtn color="primary" loading={busy.value} disabled={!canVerify.value} prependIcon="mdi-shield-check-outline" onClick={() => void verify()}>
                {t("Verify Spec (5 Layers)")}
              </VBtn>
              <VBtn variant="tonal" loading={busy.value} disabled={!canSave.value} onClick={() => void save(false)}>
                {t("Save as Verified")}
              </VBtn>
              <VBtn variant="tonal" loading={busy.value} disabled={!canSave.value} prependIcon="mdi-publish" onClick={() => void save(true)}>
                {t("Publish")}
              </VBtn>
              {verificationStale.value && (
                <MetaPill color="warning" prependIcon="mdi-alert-outline">{t("Verify again after editing")}</MetaPill>
              )}
            </div>
          </div>
        </SurfaceCard>

        {verification.value && renderScorecard(verification.value)}
        {verification.value && renderAuthority(verification.value)}

        {verification.value?.valid && (
          <SurfaceCard
            title={t("Step 5 — Draft preview")}
            subtitle={t("Renders the verified draft with sample inputs; nothing is saved or published")}
            v-slots={{
              headerActions: () => (
                <div class="d-flex flex-wrap align-center ga-2">
                  <VBtn
                    size="small"
                    variant="tonal"
                    prependIcon="mdi-eye-outline"
                    loading={previewLoading.value}
                    disabled={!canSave.value}
                    onClick={() => void runPreview()}
                  >
                    {t("Generate preview")}
                  </VBtn>
                  {previewBundle.value && (
                    <>
                      <MetaPill color="info">{`${previewPages.value} ${t("pages")}`}</MetaPill>
                      <MonoRef value={previewBundle.value.verificationSha256} truncate={12} />
                      <VBtn
                        size="small"
                        variant="tonal"
                        prependIcon="mdi-printer-outline"
                        onClick={() => previewRef.value?.printClientSideVectorPdf?.()}
                      >
                        {t("Print")}
                      </VBtn>
                    </>
                  )}
                </div>
              ),
            }}
          >
            {previewBundle.value ? (
              <div class="d-flex flex-column ga-3">
                <SegmentedTabs
                  modelValue={previewLocale.value}
                  onUpdate:modelValue={(next: string) => (previewLocale.value = next)}
                  tabs={Object.keys(previewBundle.value.spec.i18n.locales).map((entry) => ({
                    label: entry.toUpperCase(),
                    value: entry,
                  }))}
                  ariaLabel={t("Output language")}
                />
                <ReportPagedPreviewSurface
                  ref={previewRef}
                  bundle={previewBundle.value}
                  selectedLocale={previewLocale.value}
                  renderedSectionsHtml={previewSectionsHtml.value}
                  renderedHeaderHtml={previewHeaderHtml.value}
                  renderedFooterHtml={previewFooterHtml.value}
                  onPageCountChanged={(pages: number) => (previewPages.value = pages)}
                />
              </div>
            ) : (
              <p class="text-body-2 text-medium-emphasis mb-0">
                {t("Generate a preview to see the exact paginated pages before saving or publishing.")}
              </p>
            )}
          </SurfaceCard>
        )}

        {savedSpecCode.value && (
          <div class="d-flex flex-column ga-3">
            <SegmentedTabs
              modelValue={historyTab.value}
              onUpdate:modelValue={(value: string) => (historyTab.value = value as "versions" | "executions")}
              ariaLabel={t("Version history")}
              tabs={[
                { value: "versions", label: t("Version history"), count: historyRows.value.length },
                { value: "executions", label: t("Executions") },
              ]}
            />
            {historyTab.value === "versions" ? (
              <DataTable<VersionRow>
                title={t("Version history")}
                data={historyRows.value}
                headers={historyHeaders.value}
                loading={historyLoading.value}
                showNumber={false}
                xlsx={false}
                numberOfItemsPerPage={1000}
                numberOfItemsPerPageChoices={false}
                TopSlot={() => (
                  <div class="px-5 pb-3">
                    <VBtn size="small" variant="tonal" prependIcon="mdi-refresh" onClick={() => void loadHistory(savedSpecCode.value)}>
                      {t("Refresh history")}
                    </VBtn>
                  </div>
                )}
              />
            ) : (
              <DataTable<ExecutionRow>
                title={t("Executions")}
                data={executions.value}
                headers={executionHeaders.value}
                loading={executionsLoading.value}
                showNumber={false}
                xlsx={false}
                numberOfItemsPerPage={20}
                TopSlot={() => (
                  <div class="px-5 pb-3">
                    <VBtn size="small" variant="tonal" prependIcon="mdi-refresh" onClick={() => void loadExecutions(savedSpecCode.value)}>
                      {t("Refresh")}
                    </VBtn>
                  </div>
                )}
              />
            )}
          </div>
        )}

        {canApproveAml.value && pendingAml.value.length > 0 && (
          <DataTable<PendingAmlBypass>
            title={t("Pending confidential AML bypasses")}
            data={pendingAml.value}
            headers={amlHeaders.value}
            loading={busy.value}
            showNumber={false}
            xlsx={false}
            numberOfItemsPerPage={1000}
            numberOfItemsPerPageChoices={false}
            TopSlot={() => (
              <div class="px-5 pb-3 text-caption text-medium-emphasis">{t("A different MLRO or Security Admin must decide")}</div>
            )}
          />
        )}

        <AuthorityOverrideModal
          modelValue={overrideOpen.value}
          onUpdate:modelValue={(value: boolean) => (overrideOpen.value = value)}
          roles={ROLES}
          authorities={AUTHORITIES}
          initialRoles={verification.value?.authorityInference?.inferredNaturalRoles ?? []}
          initialAuthorities={verification.value?.authorityInference?.inferredRequiredAuthorities ?? []}
          target={savedSpecCode.value ? `${savedSpecCode.value}${savedSpecVersion.value ? ` v${savedSpecVersion.value}` : ""}` : ""}
          loading={busy.value}
          errorMessage={overrideError.value}
          onSubmit={(payload: AuthorityOverridePayload) => void applyOverride(payload)}
        />
      </ThemedView>
    </ScreenContainer>
  );
});

export default ReportsStudioPage;
