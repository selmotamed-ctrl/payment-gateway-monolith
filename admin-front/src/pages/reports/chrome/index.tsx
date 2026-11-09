import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VFileInput, VSelect, VSwitch, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DescriptionList, EmptyState, PageHeader, StatusBadge, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import "@/components/Table/styling.css";
import { renderChromeHtml, type ReportChromeSpec, type ReportExecutionBundle } from "@/lib/reportEngineSdk";

type ChromeRow = {
  id: string;
  code: string;
  version: number;
  name: string;
  chromeType: "HEADER" | "FOOTER";
  status: string;
  isDefaultGlobal: boolean;
  supportedLocales: string[];
  assetBundleId?: string | null;
  assetDataUrls?: Record<string, string>;
  spec: ReportChromeSpec;
};

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

const ReportsChromePage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const rows = ref<ChromeRow[]>([]);
  const loading = ref(true);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const specJson = ref("");
  const specFile = ref<File | null>(null);
  const zipFile = ref<File | null>(null);
  const publish = ref(true);
  const makeDefault = ref(false);
  const previewLocale = ref("en");
  const selected = ref<ChromeRow | null>(null);
  const canAuthor = computed(() => hasOneOfAuthorities(["reports.studio", "report_engine:author"]));
  const canSave = computed(() => specJson.value.trim().length > 0);

  const load = async () => {
    loading.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineChrome);
      rows.value = (response.data?.specs ?? []) as ChromeRow[];
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading.value = false;
    }
  };

  const downloadTranscript = async () => {
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
    if (file) specJson.value = await file.text();
  };

  const formatJson = () => {
    try {
      specJson.value = JSON.stringify(JSON.parse(specJson.value), null, 2);
      error.value = null;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  };

  const copyJson = async () => {
    if (!specJson.value.trim()) return;
    await navigator.clipboard.writeText(specJson.value);
    notice.value = t("Chrome JSON copied");
  };

  const downloadJson = () => {
    if (!specJson.value.trim()) return;
    downloadText("chrome-spec.json", specJson.value, "application/json");
  };

  const clearEditor = () => {
    specJson.value = "";
    specFile.value = null;
    zipFile.value = null;
    error.value = null;
    notice.value = null;
  };

  const editRow = (row: ChromeRow) => {
    specJson.value = JSON.stringify(row.spec, null, 2);
    specFile.value = null;
    zipFile.value = null;
    publish.value = false;
    makeDefault.value = row.isDefaultGlobal;
    notice.value = t("Loaded {name} into the editor").replace("{name}", row.name);
  };

  const copyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
  };

  const downloadSpec = (row: ChromeRow) => {
    downloadText(`${row.code}-v${row.version}.json`, JSON.stringify(row.spec, null, 2), "application/json");
  };

  const saveChrome = async () => {
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineChrome, {
        specJson: specJson.value,
        assetsZipBase64,
        publish: publish.value,
        makeDefault: makeDefault.value,
      });
      notice.value = t("Header/footer spec saved");
      if (response.data?.verification?.diagnostics?.length) {
        notice.value = `${notice.value} · ${response.data.verification.diagnostics.length} ${t("diagnostics")}`;
      }
      await load();
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const setDefault = async (row: ChromeRow, isDefault: boolean) => {
    busy.value = true;
    error.value = null;
    try {
      await api.post(urlsMap.reportEngineChromeDefault(row.id), { isDefault });
      await load();
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
    }
  };

  const previewHtml = (row: ChromeRow): string => {
    const fakeBundle = {
      executionId: "preview",
      executedAtIso: new Date().toISOString(),
      verificationSha256: "0".repeat(64),
      spec: {
        report: { code: "preview", version: 1, classification: "INTERNAL" },
        i18n: { default_locale: "en", locales: row.spec.i18n.locales },
      },
      resolvedHeaderChrome: row.chromeType === "HEADER" ? row.spec : null,
      resolvedFooterChrome: row.chromeType === "FOOTER" ? row.spec : null,
      datasets: {},
      assetDataUrls: row.assetDataUrls ?? {},
      actor: { name: "Preview", email: "preview@example", role: "SECURITY_ADMIN" },
      inputsUsed: {},
      rowCountTotal: 0,
      durationMs: 0,
      servedByNode: "preview",
    } as unknown as ReportExecutionBundle;
    return renderChromeHtml({
      chrome: row.spec,
      bundle: fakeBundle,
      locale: previewLocale.value,
      t: (key: string) =>
        row.spec.i18n.locales[previewLocale.value]?.[key] ??
        row.spec.i18n.locales[row.spec.i18n.default_locale]?.[key] ??
        key,
    });
  };

  onMounted(load);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
      <PageHeader
        title={t("Report Headers & Footers")}
        subtitle={t("Upload reusable bilingual chrome specs and assign the global default")}
        breadcrumbs={[{ label: t("Reporting"), to: "/reports/catalog" }, { label: t("Headers & Footers") }]}
        end={() => (
          <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
              {t("Refresh")}
            </VBtn>
            <VBtn variant="tonal" prependIcon="mdi-file-chart-outline" onClick={() => void router.push({ name: "ReportsCatalog" })}>
              {t("Open Catalog")}
            </VBtn>
            {canAuthor.value && (
              <VBtn variant="tonal" prependIcon="mdi-robot-outline" onClick={() => void router.push({ name: "ReportsStudio" })}>
                {t("Open Studio")}
              </VBtn>
            )}
          </ThemedView>
        )}
      />

      {error.value && (
        <VAlert type="error" variant="tonal" density="compact">
          <div class="d-flex align-center justify-space-between ga-3 flex-wrap">
            <span>{error.value}</span>
            <VBtn size="small" variant="tonal" onClick={() => void load()}>{t("Retry")}</VBtn>
          </div>
        </VAlert>
      )}
      {notice.value && <VAlert type="success" variant="tonal" density="compact">{notice.value}</VAlert>}

      <SurfaceCard title={t("Chrome AI Transcript")} subtitle={t("Author headers and footers with the same closed contract")}>
        <VBtn color="primary" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadTranscript()}>
          {t("Download Header/Footer AI Transcript")}
        </VBtn>
      </SurfaceCard>

      <SurfaceCard
        title={t("Upload Chrome Spec")}
        subtitle={t("JSON + optional logo/seal .zip bundle")}
        v-slots={{
          headerActions: () => (
            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
              <VBtn size="small" variant="text" prependIcon="mdi-format-align-left" disabled={!canSave.value} onClick={formatJson}>
                {t("Format JSON")}
              </VBtn>
              <VBtn size="small" variant="text" prependIcon="mdi-content-copy" disabled={!canSave.value} onClick={() => void copyJson()}>
                {t("Copy JSON")}
              </VBtn>
              <VBtn size="small" variant="text" prependIcon="mdi-download" disabled={!canSave.value} onClick={downloadJson}>
                {t("Download JSON")}
              </VBtn>
              <VBtn size="small" variant="text" prependIcon="mdi-eraser" onClick={clearEditor}>
                {t("Clear editor")}
              </VBtn>
            </ThemedView>
          ),
        }}
      >
        <div class="d-flex flex-column ga-3">
          <VFileInput
            label={t("Chrome spec (.json)")}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            modelValue={specFile.value}
            onUpdate:modelValue={(files: File | File[] | null) => void readSpecFile(Array.isArray(files) ? (files[0] ?? null) : files)}
          />
          <VFileInput
            label={t("Logo/seal bundle (.zip, optional)")}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            modelValue={zipFile.value}
            onUpdate:modelValue={(files: File | File[] | null) => (zipFile.value = Array.isArray(files) ? (files[0] ?? null) : files)}
          />
          <VTextarea
            label={t("Chrome spec JSON")}
            modelValue={specJson.value}
            onUpdate:modelValue={(value: string) => (specJson.value = value)}
            rows={12}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            style={{ fontFamily: "monospace" }}
          />
          <div class="d-flex flex-wrap ga-3 align-center">
            <VBtn color="primary" loading={busy.value} disabled={!canSave.value} onClick={() => void saveChrome()}>
              {t("Verify & Save")}
            </VBtn>
            <VSwitch
              label={t("Publish")}
              modelValue={publish.value}
              onUpdate:modelValue={(value: boolean | null) => (publish.value = Boolean(value))}
              density="compact"
              hideDetails="auto"
            />
            <VSwitch
              label={t("Make default")}
              modelValue={makeDefault.value}
              onUpdate:modelValue={(value: boolean | null) => (makeDefault.value = Boolean(value))}
              density="compact"
              hideDetails="auto"
            />
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard
        title={t("Registered Headers & Footers")}
        subtitle={t("At most one published global default per type")}
        v-slots={{
          headerActions: () => (
            <VBtn size="small" variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
              {t("Refresh")}
            </VBtn>
          ),
        }}
      >
        {loading.value ? (
          <StateView loading minHeight="220px" />
        ) : rows.value.length === 0 ? (
          <EmptyState
            title={t("No headers or footers registered")}
            description={t("Upload a chrome spec above to make it available to reports.")}
            icon="mdi-page-layout-header-footer"
          />
        ) : (
          <div class="d-flex flex-column ga-3">
            {rows.value.map((row) => (
              <div key={row.id} class="pg-section-fields pa-4" style={{ marginBottom: 0 }}>
                <div class="d-flex flex-wrap align-center justify-space-between ga-2">
                  <div>
                    <div class="font-weight-medium">
                      {row.name} <span class="text-caption text-medium-emphasis">({row.code} v{row.version})</span>
                    </div>
                    <div class="d-flex align-center ga-2 mt-1 flex-wrap">
                      <StatusBadge status={row.chromeType} label={row.chromeType} toneOverride="info" />
                      <StatusBadge status={row.status} label={row.status} toneOverride={row.status === "PUBLISHED" ? "success" : "neutral"} />
                      {row.isDefaultGlobal && <StatusBadge status="DEFAULT" label={t("Global Default")} toneOverride="success" />}
                    </div>
                  </div>
                  <div class="d-flex flex-wrap ga-2">
                    <VBtn size="small" variant="text" onClick={() => (selected.value = selected.value?.id === row.id ? null : row)}>
                      {t("Preview")}
                    </VBtn>
                    <VBtn size="small" variant="text" prependIcon="mdi-pencil-outline" onClick={() => editRow(row)}>
                      {t("Edit")}
                    </VBtn>
                    <VBtn size="small" variant="text" prependIcon="mdi-content-copy" onClick={() => void copyCode(row.code)}>
                      {t("Copy code")}
                    </VBtn>
                    <VBtn size="small" variant="text" prependIcon="mdi-download" onClick={() => downloadSpec(row)}>
                      {t("Download spec")}
                    </VBtn>
                    <VBtn
                      size="small"
                      variant="tonal"
                      disabled={row.status !== "PUBLISHED"}
                      onClick={() => void setDefault(row, !row.isDefaultGlobal)}
                    >
                      {row.isDefaultGlobal ? t("Clear default") : t("Set global default")}
                    </VBtn>
                  </div>
                </div>
                {selected.value?.id === row.id && (
                  <div class="mt-3">
                    <div class="d-flex align-center ga-2 mb-2">
                      <VSelect
                        modelValue={previewLocale.value}
                        onUpdate:modelValue={(value: string) => (previewLocale.value = value)}
                        items={row.supportedLocales}
                        density="compact"
                        variant="outlined"
                        hideDetails="auto"
                        style={{ maxWidth: "140px" }}
                      />
                    </div>
                    <div
                      class="pg-section-fields pa-3"
                      style={{ marginBottom: 0, borderStyle: "dashed" }}
                      innerHTML={previewHtml(row)}
                    />
                    <DescriptionList
                      class="mt-3"
                      items={[
                        { label: t("Locales"), value: row.supportedLocales.join(", ") },
                        { label: t("Variables"), value: row.spec.template.used_variables.join(", ") || "—" },
                      ]}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SurfaceCard>
      </ThemedView>
    </ScreenContainer>
  );
});

export default ReportsChromePage;
