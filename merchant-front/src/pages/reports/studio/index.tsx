import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VBtn, VFileInput, VSwitch, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { MetaPill, MonoRef, PageHeader, StatusBadge, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";
import type { ReportDiagnostic } from "@/lib/reportEngineSdk";

type LayerScore = {
  layer: number;
  name: string;
  passed: boolean;
  status?: "PASSED" | "FAILED" | "SKIPPED";
  errorCount: number;
  warningCount: number;
};

type Verification = {
  valid: boolean;
  layers: LayerScore[];
  diagnostics: ReportDiagnostic[];
  aiRepairPrompt?: string;
};

type VersionRow = {
  id: string;
  code: string;
  version: number;
  category: string;
  status: string;
  isLatestPublished: boolean;
  createdAt: string;
  publishedAt: string | null;
};

type Usage = {
  codes: number;
  maxCodes: number;
  runsToday: number;
  dbTimeTodayMs: number;
  maxDailyDbTimeMs: number;
  executesLastHour: number;
  verifiesLastHour: number;
  maxExecutesPerHour: number;
  maxVerifiesPerHour: number;
  suspended: boolean;
  suspensionReason: string | null;
  engineEnabled?: boolean;
  assetsEnabled?: boolean;
};

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the file"));
    reader.readAsDataURL(file);
  });

const MerchantReportStudioPage = dc(() => {
  const { t } = useLocale();
  const route = useRoute();
  const specJson = ref("");
  const zipFile = ref<File | null>(null);
  const verification = ref<Verification | null>(null);
  const verifiedInput = ref<{ json: string; zip: File | null } | null>(null);
  const busy = ref(false);
  const versions = ref<VersionRow[]>([]);
  const usage = ref<Usage | null>(null);
  const editingId = ref<string | null>(null);

  const canVerify = computed(() => specJson.value.trim().length > 0);
  const verificationCurrent = computed(
    () => verifiedInput.value !== null && verifiedInput.value.json === specJson.value && verifiedInput.value.zip === zipFile.value,
  );
  const canSave = computed(() => verificationCurrent.value && verification.value?.valid === true);
  const assetsEnabled = computed(() => usage.value?.assetsEnabled !== false);
  const engineEnabled = computed(() => usage.value?.engineEnabled !== false);

  const readFile = async (files: File | File[] | null) => {
    const file = Array.isArray(files) ? files[0] : files;
    if (!file) return;
    specJson.value = await file.text();
  };

  const selectZip = (files: File | File[] | null) => {
    const file = Array.isArray(files) ? files[0] ?? null : files;
    if (file && file.size > 2 * 1024 * 1024) {
      showSnackBar({ message: t("The asset bundle must be at most 2 MB"), type: "error" });
      zipFile.value = null;
      return;
    }
    zipFile.value = file;
  };

  const loadUsage = async () => {
    try {
      const response = await api.get(urlsMap.reportEngineStudioUsage);
      usage.value = response.data as Usage;
    } catch {
      usage.value = null;
    }
  };

  const loadVersions = async (code?: string) => {
    try {
      const response = await api.get(urlsMap.reportEngineStudioSpecs, { params: code ? { code } : undefined });
      versions.value = (response.data?.specs ?? []) as VersionRow[];
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    }
  };

  const downloadTranscript = async () => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioTranscript);
      const markdown = String(response.data?.markdown ?? "");
      const filename = String(response.data?.filename ?? "merchant-report-transcript.md");
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const verify = async () => {
    if (!canVerify.value) return;
    busy.value = true;
    verification.value = null;
    verifiedInput.value = null;
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineStudioVerify, {
        specJson: specJson.value,
        assetsZipBase64,
      });
      verification.value = response.data as Verification;
      verifiedInput.value = { json: specJson.value, zip: zipFile.value };
      showSnackBar({
        message: verification.value.valid ? t("Spec verified") : t("Verification failed"),
        type: verification.value.valid ? "success" : "error",
      });
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const save = async (publish: boolean) => {
    if (!canSave.value) return;
    busy.value = true;
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineStudioSpecs, {
        specJson: specJson.value,
        assetsZipBase64,
        publish,
      });
      showSnackBar({ message: publish ? t("Report published") : t("Report saved"), type: "success" });
      editingId.value = String(response.data?.id ?? "") || null;
      await Promise.all([loadVersions(), loadUsage()]);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const loadSpec = async (id: string) => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioSpec(id));
      specJson.value = JSON.stringify(response.data?.spec ?? {}, null, 2);
      zipFile.value = null;
      verification.value = null;
      verifiedInput.value = null;
      editingId.value = id;
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const openVersion = async (row: VersionRow) => {
    await loadSpec(row.id);
  };

  const publishVersion = async (row: VersionRow) => {
    const confirmed = await showConfirm({
      title: t("Publish this version?"),
      message: t("{name} becomes the published version your team can run.", { name: `${row.code} v${row.version}` }),
      submitButtonLabel: t("Publish"),
      type: "primary",
    });
    if (!confirmed) return;
    busy.value = true;
    try {
      await api.post(urlsMap.reportEngineStudioPublish(row.id), {});
      showSnackBar({ message: t("Report published"), type: "success" });
      await Promise.all([loadVersions(row.code), loadUsage()]);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const archiveVersion = async (row: VersionRow) => {
    const confirmed = await showConfirm({
      title: t("Archive this version?"),
      message: t("{name} can no longer be run.", { name: `${row.code} v${row.version}` }),
      submitButtonLabel: t("Archive"),
      type: "warning",
    });
    if (!confirmed) return;
    busy.value = true;
    try {
      await api.post(urlsMap.reportEngineStudioArchive(row.id), {});
      showSnackBar({ message: t("Version archived"), type: "success" });
      await loadVersions(row.code);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const headers = computed<TableHeader<VersionRow>[]>(() => [
    { key: "code", label: t("Report"), sortKey: "code", value: (row) => row.code },
    { key: "version", label: t("Version"), value: (row) => `v${row.version}` },
    { key: "category", label: t("Category"), value: (row) => row.category },
    {
      key: "status",
      label: t("Status"),
      Value: ({ row }) => (
        <div class="d-flex align-center ga-2">
          <StatusBadge status={row.status} />
          {row.isLatestPublished && <MetaPill color="success">{t("published")}</MetaPill>}
        </div>
      ),
    },
    { key: "createdAt", label: t("Created"), value: (row) => new Date(row.createdAt).toLocaleString() },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{ label: t("Open in editor"), icon: "mdi-pencil-outline", onClick: () => void openVersion(row) }}
          items={[
            ...(row.status === "VERIFIED"
              ? [{ key: "publish", label: t("Publish"), icon: "mdi-publish", onClick: () => void publishVersion(row) }]
              : []),
            ...(row.status !== "ARCHIVED"
              ? [{ key: "archive", label: t("Archive"), icon: "mdi-archive-outline", onClick: () => void archiveVersion(row) }]
              : []),
          ]}
        />
      ),
    },
  ]);

  onMounted(() => {
    void loadVersions();
    void loadUsage().then(() => {
      const open = typeof route.query.open === "string" ? route.query.open : "";
      if (open) void loadSpec(open);
    });
  });

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Studio")}
          subtitle={t("Author your own merchant reports with the AI transcript, verify them and publish")}
          end={() => (
            <div class="d-flex flex-wrap ga-2">
              <VBtn variant="tonal" prependIcon="mdi-download" loading={busy.value} onClick={() => void downloadTranscript()}>
                {t("Download AI transcript")}
              </VBtn>
              <VBtn variant="tonal" prependIcon="mdi-file-chart-outline" onClick={() => void loadVersions()}>
                {t("Refresh")}
              </VBtn>
            </div>
          )}
        />

        {usage.value && (
          <SurfaceCard title={t("Usage and quotas")} subtitle={t("Per-merchant limits protect the platform")}>
            <div class="d-flex flex-wrap ga-2">
              <MetaPill>{`${t("codes")}: ${usage.value.codes}/${usage.value.maxCodes}`}</MetaPill>
              <MetaPill>{`${t("runs today")}: ${usage.value.runsToday}`}</MetaPill>
              <MetaPill>{`${t("DB time today")}: ${Math.round(usage.value.dbTimeTodayMs / 1000)}s / ${Math.round(usage.value.maxDailyDbTimeMs / 1000)}s`}</MetaPill>
              <MetaPill>{`${t("executions/hour")}: ${usage.value.executesLastHour}/${usage.value.maxExecutesPerHour}`}</MetaPill>
              <MetaPill>{`${t("verifications/hour")}: ${usage.value.verifiesLastHour}/${usage.value.maxVerifiesPerHour}`}</MetaPill>
              {usage.value.suspended && (
                <MetaPill color="error">{usage.value.suspensionReason || t("Studio suspended")}</MetaPill>
              )}
              <MetaPill color={assetsEnabled.value ? "success" : "warning"}>
                {assetsEnabled.value ? t("Assets enabled by platform policy") : t("Assets disabled by platform policy")}
              </MetaPill>
              {!engineEnabled.value && (
                <MetaPill color="error">{t("Merchant reporting disabled by platform policy")}</MetaPill>
              )}
            </div>
          </SurfaceCard>
        )}

        <SurfaceCard
          title={t("Report spec")}
          subtitle={t("Paste the JSON produced from the merchant transcript, or upload a .json file")}
          v-slots={{
            headerActions: () =>
              editingId.value ? <MonoRef value={editingId.value} truncate={12} /> : undefined,
          }}
        >
          <div class="d-flex flex-column ga-3">
            <VFileInput
              label={t("Report spec (.json)")}
              {...{ accept: "application/json,.json" }}
              modelValue={null}
              onUpdate:modelValue={(files: File | File[] | null) => void readFile(files)}
            />
            {assetsEnabled.value ? (
              <VFileInput
                label={t("Asset bundle (.zip, optional, max 2 MB)")}
                {...{ accept: "application/zip,.zip" }}
                modelValue={zipFile.value}
                onUpdate:modelValue={(files: File | File[] | null) => selectZip(files)}
              />
            ) : (
              <div class="text-caption text-medium-emphasis">
                {t("Assets are disabled by platform policy: required_assets must be empty and no .zip can be uploaded.")}
              </div>
            )}
            <VTextarea
              modelValue={specJson.value}
              onUpdate:modelValue={(value: string) => (specJson.value = value)}
              label={t("Spec JSON")}
              rows={14}
              variant="outlined"
              {...{ spellcheck: false }}
              class="pg-mono"
              style={{ direction: "ltr", fontFamily: "var(--pg-font-mono)" }}
            />
            <div class="d-flex flex-wrap ga-2">
              <VBtn color="primary" loading={busy.value} disabled={!canVerify.value || !engineEnabled.value} onClick={() => void verify()}>
                {t("Verify Spec (5 Layers)")}
              </VBtn>
              <VBtn variant="tonal" loading={busy.value} disabled={!canSave.value || !engineEnabled.value} onClick={() => void save(false)}>
                {t("Save as Verified")}
              </VBtn>
              <VBtn variant="tonal" loading={busy.value} disabled={!canSave.value || !engineEnabled.value} onClick={() => void save(true)}>
                {t("Publish")}
              </VBtn>
            </div>
          </div>
        </SurfaceCard>

        {verification.value && (
          <SurfaceCard title={t("Verification scorecard")} subtitle={t("Layers 1-5 and diagnostics")}>
            <div class="d-flex flex-column ga-3">
              <div class="d-flex flex-wrap ga-2">
                {verification.value.layers.map((layer) => (
                  <StatusBadge
                    key={layer.layer}
                    status={layer.status ?? (layer.passed ? "PASSED" : "FAILED")}
                    label={`${t("Layer")} ${layer.layer} · ${layer.name}`}
                  />
                ))}
              </div>
              {verification.value.diagnostics.length > 0 && (
                <div class="d-flex flex-column ga-2">
                  {verification.value.diagnostics.map((diagnostic, index) => (
                    <div key={`${diagnostic.code}-${index}`} class="d-flex flex-column">
                      <div class="d-flex flex-wrap align-center ga-2">
                        <StatusBadge status={diagnostic.severity} />
                        <MonoRef value={diagnostic.code} copyable={false} />
                        <span class="text-caption text-medium-emphasis">{diagnostic.path}</span>
                      </div>
                      <span class="text-body-2">{diagnostic.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {verification.value.aiRepairPrompt && (
                <VBtn
                  size="small"
                  variant="tonal"
                  prependIcon="mdi-content-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(verification.value?.aiRepairPrompt ?? "").then(
                      () => showSnackBar({ message: t("Repair prompt copied"), type: "success" }),
                      () => showSnackBar({ message: t("Copy failed"), type: "error" }),
                    );
                  }}
                >
                  {t("Copy AI Repair Prompt")}
                </VBtn>
              )}
            </div>
          </SurfaceCard>
        )}

        <DataTable<VersionRow>
          title={t("My report versions")}
          data={versions.value}
          headers={headers.value}
          loading={busy.value}
          showNumber={false}
          xlsx={false}
          numberOfItemsPerPage={100}
          numberOfItemsPerPageChoices={false}
        />
      </ThemedView>
    </ScreenContainer>
  );
});

export default MerchantReportStudioPage;
