import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import {
  VAlert,
  VBtn,
  VCheckbox,
  VFileInput,
  VSelect,
  VTextarea,
  VTextField,
} from "vuetify/components";
import { DescriptionList, PageHeader, StatusBadge, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities, user } from "@/state/user";

type Diagnostic = {
  layer: number;
  severity: "error" | "warning";
  path: string;
  code: string;
  message: string;
  aiFixHint?: string;
};

type PendingAmlBypass = {
  id: string;
  reportSpecId: string;
  reportCode: string;
  allowedRoles: string[];
  allowedAuthorities: string[];
  justification: string;
  makerEmail: string;
  createdAt: string;
  canDecide: boolean;
};

type VerificationReport = {
  valid: boolean;
  specVersion: string | null;
  layers: Array<{ layer: number; name: string; passed: boolean; errorCount: number; warningCount: number }>;
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
  diagnostics: Diagnostic[];
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

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const downloadText = (filename: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const ReportsStudioPage = dc(() => {
  const { t } = useLocale();
  const domains = ref<string[]>([]);
  const specJson = ref("");
  const specFile = ref<File | null>(null);
  const zipFile = ref<File | null>(null);
  const verification = ref<VerificationReport | null>(null);
  const savedSpecId = ref<string | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const overrideRoles = ref<string[]>([]);
  const overrideAuthorities = ref<string[]>([]);
  const overrideJustification = ref("");
  const allowConfidentialAmlBypass = ref(false);
  const amlApprovalId = ref<string | null>(null);
  const pendingAml = ref<PendingAmlBypass[]>([]);

  const canApproveAml = computed(
    () => ["MLRO", "SECURITY_ADMIN"].includes(String(user.value?.userInfo?.role ?? "")),
  );
  const loadPendingAml = async () => {
    if (!canApproveAml.value) return;
    try {
      const response = await api.get(urlsMap.reportEngineAmlBypassPending);
      pendingAml.value = (response.data?.approvals ?? []) as PendingAmlBypass[];
    } catch {
      pendingAml.value = [];
    }
  };
  const canOverride = computed(
    () =>
      hasOneOfAuthorities(["security:write", "security.write"]) ||
      String(user.value?.userInfo?.role ?? "") === "SECURITY_ADMIN",
  );

  const downloadTranscript = async () => {
    busy.value = true;
    error.value = null;
    try {
      const response = await api.get(urlsMap.reportEngineTranscript, {
        params: { kind: "REPORT", domains: domains.value.join(",") },
      });
      const data = response.data ?? {};
      downloadText(data.filename ?? "report-engine-ai-transcript-v1.0.md", data.markdown ?? "", "text/markdown");
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const downloadChromeTranscript = async () => {
    busy.value = true;
    error.value = null;
    try {
      const response = await api.get(urlsMap.reportEngineTranscript, { params: { kind: "CHROME" } });
      const data = response.data ?? {};
      downloadText(data.filename ?? "chrome-engine-ai-transcript-v1.0.md", data.markdown ?? "", "text/markdown");
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const readSpecFile = async (file: File | null) => {
    specFile.value = file;
    if (file) {
      specJson.value = await file.text();
    }
  };

  const verify = async () => {
    busy.value = true;
    error.value = null;
    notice.value = null;
    verification.value = null;
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineVerify, {
        specJson: specJson.value,
        assetsZipBase64,
      });
      verification.value = response.data as VerificationReport;
      if (verification.value.authorityInference) {
        overrideRoles.value = verification.value.authorityInference.inferredNaturalRoles;
        overrideAuthorities.value = verification.value.authorityInference.inferredRequiredAuthorities;
      }
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const save = async (publish: boolean) => {
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineSpecs, {
        specJson: specJson.value,
        assetsZipBase64,
        publish,
      });
      savedSpecId.value = String(response.data?.id ?? "");
      notice.value = publish ? t("Report published") : t("Report saved as verified");
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const applyOverride = async () => {
    if (!savedSpecId.value) {
      error.value = t("Save the spec as verified first so the override can be attached");
      return;
    }
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const response = await api.post(urlsMap.reportEngineOverride(savedSpecId.value), {
        allowedRoles: overrideRoles.value,
        allowedAuthorities: overrideAuthorities.value,
        justification: overrideJustification.value,
        allowConfidentialAmlBypass: allowConfidentialAmlBypass.value,
      });
      if (response.data?.status === "PENDING_REVIEW") {
        amlApprovalId.value = String(response.data.approvalRequestId ?? "");
        notice.value = t("AML bypass requested; a different MLRO or Security Admin must approve it");
      } else {
        notice.value = t("Authority override saved and audited");
      }
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const clearOverride = async () => {
    if (!savedSpecId.value) return;
    busy.value = true;
    error.value = null;
    try {
      await api.post(urlsMap.reportEngineOverride(savedSpecId.value), {
        clear: true,
        allowedRoles: [],
        allowedAuthorities: [],
        justification: "Override cleared by a Security Admin",
      });
      notice.value = t("Authority override cleared");
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const decideAmlBypass = async (approve: boolean) => {
    if (!amlApprovalId.value) return;
    busy.value = true;
    error.value = null;
    try {
      await api.post(
        approve
          ? urlsMap.reportEngineAmlBypassApprove(amlApprovalId.value)
          : urlsMap.reportEngineAmlBypassReject(amlApprovalId.value),
        approve ? {} : { notes: t("Rejected by MLRO/Security Admin") },
      );
      notice.value = approve ? t("AML bypass approved") : t("AML bypass rejected");
      amlApprovalId.value = null;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const copyRepairPrompt = async () => {
    if (!verification.value?.aiRepairPrompt) return;
    await navigator.clipboard.writeText(verification.value.aiRepairPrompt);
    notice.value = t("AI repair prompt copied");
  };

  const layerTone = (passed: boolean) => (passed ? "success" : "danger");

  onMounted(() => {
    void loadPendingAml();
  });

  return () => (
    <div>
      <PageHeader
        title={t("Report Studio")}
        subtitle={t("Download the AI transcript, verify a spec, infer authorities and publish")}
        breadcrumbs={[{ label: t("Reporting"), to: "/reports/catalog" }, { label: t("Studio") }]}
      />

      {error.value && <VAlert type="error" variant="tonal" density="compact" class="mb-4">{error.value}</VAlert>}
      {notice.value && <VAlert type="success" variant="tonal" density="compact" class="mb-4">{notice.value}</VAlert>}

      <SurfaceCard title={t("Step 1 — AI Authoring Transcript")} subtitle={t("The transcript contains the live schema, optimization rules and bilingual contract")}>
        <div class="d-flex flex-wrap ga-3 align-end">
          <VSelect
            modelValue={domains.value}
            onUpdate:modelValue={(value: string[]) => (domains.value = value)}
            label={t("Domains")}
            items={DOMAINS}
            multiple
            chips
            density="compact"
            variant="outlined"
            hideDetails="auto"
            style={{ minWidth: "280px", maxWidth: "520px" }}
          />
          <VBtn color="primary" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadTranscript()}>
            {t("Download Report AI Transcript")}
          </VBtn>
          <VBtn variant="tonal" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadChromeTranscript()}>
            {t("Download Header/Footer AI Transcript")}
          </VBtn>
        </div>
      </SurfaceCard>

      <SurfaceCard class="mt-4" title={t("Step 2 — Upload Spec and Optional Asset Bundle")} subtitle={t("Standalone JSON or JSON paired with an assets .zip")}>
        <div class="d-flex flex-column ga-3">
          <VFileInput
            label={t("Report spec (.json)")}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            modelValue={specFile.value}
            onUpdate:modelValue={(files: File | File[] | null) => void readSpecFile(Array.isArray(files) ? (files[0] ?? null) : files)}
          />
          <VFileInput
            label={t("Asset bundle (.zip, optional)")}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            modelValue={zipFile.value}
            onUpdate:modelValue={(files: File | File[] | null) => (zipFile.value = Array.isArray(files) ? (files[0] ?? null) : files)}
          />
          <VTextarea
            label={t("Spec JSON")}
            modelValue={specJson.value}
            onUpdate:modelValue={(value: string) => (specJson.value = value)}
            rows={10}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            style={{ fontFamily: "monospace" }}
          />
          <div class="d-flex flex-wrap ga-2">
            <VBtn color="primary" loading={busy.value} prependIcon="mdi-shield-check-outline" onClick={() => void verify()}>
              {t("Verify Spec (5 Layers)")}
            </VBtn>
            <VBtn variant="tonal" loading={busy.value} onClick={() => void save(false)}>
              {t("Save as Verified")}
            </VBtn>
            <VBtn variant="tonal" color="success" loading={busy.value} onClick={() => void save(true)}>
              {t("Publish")}
            </VBtn>
          </div>
        </div>
      </SurfaceCard>

      {verification.value && (
        <SurfaceCard class="mt-4" title={t("Step 3 — Verification Scorecard")} subtitle={t("Layers 1-5, diagnostics and the one-click AI repair prompt")}>
          <div class="d-flex flex-wrap ga-2 mb-4">
            {verification.value.layers.map((layer) => (
              <StatusBadge
                key={layer.layer}
                status={`L${layer.layer}`}
                label={`${layer.name} — ${layer.passed ? t("Passed") : `${layer.errorCount} ${t("errors")}`}`}
                toneOverride={layerTone(layer.passed) as never}
              />
            ))}
          </div>
          {verification.value.diagnostics.length > 0 && (
            <div class="d-flex flex-column ga-2 mb-3">
              {verification.value.diagnostics.map((diagnostic, index) => (
                <VAlert
                  key={`${diagnostic.code}-${index}`}
                  type={diagnostic.severity === "error" ? "error" : "warning"}
                  variant="tonal"
                  density="compact"
                >
                  <strong>L{diagnostic.layer} {diagnostic.code}</strong> — {diagnostic.path}: {diagnostic.message}
                  {diagnostic.aiFixHint ? <div class="text-caption">{diagnostic.aiFixHint}</div> : null}
                </VAlert>
              ))}
            </div>
          )}
          {verification.value.aiRepairPrompt && (
            <div class="d-flex ga-2 mb-3">
              <VBtn size="small" variant="tonal" prependIcon="mdi-content-copy" onClick={() => void copyRepairPrompt()}>
                {t("Copy AI Repair Prompt")}
              </VBtn>
            </div>
          )}
          {verification.value.verifiedAssets.length > 0 && (
            <DescriptionList
              items={verification.value.verifiedAssets.map((asset) => ({
                label: asset.assetKey,
                value: `${asset.fileName} · ${asset.bytes} B · ${asset.sha256.slice(0, 12)}…`,
              }))}
            />
          )}
        </SurfaceCard>
      )}

      {verification.value?.authorityInference && (
        <SurfaceCard class="mt-4" title={t("Step 4 — Authority Inference")} subtitle={t("Computed from the queried models and columns")}>
          <DescriptionList
            items={[
              { label: t("Queried models"), value: verification.value.authorityInference.queriedModels.join(", ") },
              { label: t("Queried domains"), value: verification.value.authorityInference.queriedDomains.join(", ") },
              { label: t("Inferred roles"), value: verification.value.authorityInference.inferredNaturalRoles.join(", ") || "—" },
              { label: t("Required authorities"), value: verification.value.authorityInference.inferredRequiredAuthorities.join(", ") || "—" },
              { label: t("Conflict status"), value: verification.value.authorityInference.conflictStatus },
              { label: t("Confidential AML"), value: verification.value.authorityInference.requiresConfidentialAmlAccess ? t("Yes") : t("No") },
              { label: t("Masked PII"), value: verification.value.authorityInference.containsMaskedPiiColumns ? t("Yes") : t("No") },
            ]}
          />
          {verification.value.authorityInference.conflictDetails.map((conflict) => (
            <VAlert key={conflict.code} type="warning" variant="tonal" density="compact" class="mt-3">
              <strong>{conflict.code}</strong> — {conflict.message}
              <div class="text-caption">{conflict.resolutionHint}</div>
            </VAlert>
          ))}
          {canOverride.value && (
            <div class="d-flex flex-column ga-3 mt-4">
              <div class="text-subtitle-2 font-weight-bold">{t("Security Admin Authority Override")}</div>
              <VSelect
                modelValue={overrideRoles.value}
                onUpdate:modelValue={(value: string[]) => (overrideRoles.value = value)}
                label={t("Allowed roles")}
                items={ROLES}
                multiple
                chips
                density="compact"
                variant="outlined"
                hideDetails="auto"
              />
              <VSelect
                modelValue={overrideAuthorities.value}
                onUpdate:modelValue={(value: string[]) => (overrideAuthorities.value = value)}
                label={t("Allowed authorities")}
                items={AUTHORITIES}
                multiple
                chips
                density="compact"
                variant="outlined"
                hideDetails="auto"
              />
              <VCheckbox
                label={t("Allow confidential AML bypass (requires MLRO/Security sign-off)")}
                modelValue={allowConfidentialAmlBypass.value}
                onUpdate:modelValue={(value: boolean | null) => (allowConfidentialAmlBypass.value = Boolean(value))}
              />
              <VTextField
                label={t("Justification (minimum 15 characters)")}
                modelValue={overrideJustification.value}
                onUpdate:modelValue={(value: string) => (overrideJustification.value = value)}
                density="compact"
                variant="outlined"
                hideDetails="auto"
              />
              <div class="d-flex flex-wrap ga-2">
                <VBtn color="warning" loading={busy.value} onClick={() => void applyOverride()}>
                  {t("Apply Security Admin Override")}
                </VBtn>
                <VBtn variant="tonal" loading={busy.value} onClick={() => void clearOverride()}>
                  {t("Clear override")}
                </VBtn>
                {amlApprovalId.value && (
                  <>
                    <VBtn color="success" loading={busy.value} onClick={() => void decideAmlBypass(true)}>
                      {t("Approve AML bypass")}
                    </VBtn>
                    <VBtn color="error" variant="tonal" loading={busy.value} onClick={() => void decideAmlBypass(false)}>
                      {t("Reject AML bypass")}
                    </VBtn>
                  </>
                )}
              </div>
            </div>
          )}
        </SurfaceCard>
      )}

      {canApproveAml.value && pendingAml.value.length > 0 && (
        <SurfaceCard class="mt-4" title={t("Pending confidential AML bypasses")} subtitle={t("A different MLRO or Security Admin must decide")}>
          <div class="d-flex flex-column ga-3">
            {pendingAml.value.map((approval) => (
              <div key={approval.id} class="pa-3" style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "8px" }}>
                <div class="font-weight-medium">{approval.reportCode}</div>
                <div class="text-caption text-medium-emphasis">
                  {t("Requested by")} {approval.makerEmail || "—"}
                </div>
                <div class="text-caption">{approval.justification}</div>
                <div class="d-flex flex-wrap ga-2 mt-2">
                  <VBtn size="small" color="success" disabled={!approval.canDecide} onClick={() => { amlApprovalId.value = approval.id; void decideAmlBypass(true).then(loadPendingAml); }}>
                    {t("Approve AML bypass")}
                  </VBtn>
                  <VBtn size="small" color="error" variant="tonal" disabled={!approval.canDecide} onClick={() => { amlApprovalId.value = approval.id; void decideAmlBypass(false).then(loadPendingAml); }}>
                    {t("Reject AML bypass")}
                  </VBtn>
                </div>
              </div>
            ))}
          </div>
        </SurfaceCard>
      )}
    </div>
  );
});

export default ReportsStudioPage;
