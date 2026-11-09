import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VFileInput, VSelect, VTextarea } from "vuetify/components";
import { DescriptionList, PageHeader, StatusBadge, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
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
    <div>
      <PageHeader
        title={t("Report Headers & Footers")}
        subtitle={t("Upload reusable bilingual chrome specs and assign the global default")}
        breadcrumbs={[{ label: t("Reporting"), to: "/reports/catalog" }, { label: t("Headers & Footers") }]}
      />

      {error.value && <VAlert type="error" variant="tonal" density="compact" class="mb-4">{error.value}</VAlert>}
      {notice.value && <VAlert type="success" variant="tonal" density="compact" class="mb-4">{notice.value}</VAlert>}

      <SurfaceCard title={t("Chrome AI Transcript")} subtitle={t("Author headers and footers with the same closed contract")}>
        <VBtn color="primary" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadTranscript()}>
          {t("Download Header/Footer AI Transcript")}
        </VBtn>
      </SurfaceCard>

      <SurfaceCard class="mt-4" title={t("Upload Chrome Spec")} subtitle={t("JSON + optional logo/seal .zip bundle")}>
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
            rows={10}
            density="compact"
            variant="outlined"
            hideDetails="auto"
            style={{ fontFamily: "monospace" }}
          />
          <div class="d-flex flex-wrap ga-3 align-center">
            <VBtn color="primary" loading={busy.value} onClick={() => void saveChrome()}>
              {t("Verify & Save")}
            </VBtn>
            <VBtn variant="tonal" onClick={() => (publish.value = !publish.value)}>
              {publish.value ? t("Publish: On") : t("Publish: Off")}
            </VBtn>
            <VBtn variant="tonal" onClick={() => (makeDefault.value = !makeDefault.value)}>
              {makeDefault.value ? t("Make default: On") : t("Make default: Off")}
            </VBtn>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard class="mt-4" title={t("Registered Headers & Footers")} subtitle={t("At most one published global default per type")}>
        {loading.value ? (
          <div class="py-6 text-center text-medium-emphasis">{t("Loading…")}</div>
        ) : (
          <div class="d-flex flex-column ga-3">
            {rows.value.map((row) => (
              <div key={row.id} class="pa-3" style={{ border: "1px solid var(--pg-border-subtle)", borderRadius: "8px" }}>
                <div class="d-flex flex-wrap align-center justify-space-between ga-2">
                  <div>
                    <div class="font-weight-medium">
                      {row.name} <span class="text-caption text-medium-emphasis">({row.code} v{row.version})</span>
                    </div>
                    <div class="d-flex align-center ga-2 mt-1">
                      <StatusBadge status={row.chromeType} label={row.chromeType} toneOverride="info" />
                      <StatusBadge status={row.status} label={row.status} toneOverride={row.status === "PUBLISHED" ? "success" : "neutral"} />
                      {row.isDefaultGlobal && <StatusBadge status="DEFAULT" label={t("Global Default")} toneOverride="success" />}
                    </div>
                  </div>
                  <div class="d-flex flex-wrap ga-2">
                    <VBtn size="small" variant="text" onClick={() => (selected.value = selected.value?.id === row.id ? null : row)}>
                      {t("Preview")}
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
                      style={{ border: "1px dashed var(--pg-border-strong)", padding: "12px", borderRadius: "6px", background: "var(--pg-bg-surface-subtle)" }}
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
    </div>
  );
});

export default ReportsChromePage;
