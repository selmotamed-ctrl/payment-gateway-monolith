import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VFileInput, VSelect, VSwitch, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { DescriptionList, PageHeader, StatusBadge, SurfaceCard } from "@/components/ui";
import { ReportDiagnosticsPanel } from "@/components/reports/ReportDiagnosticsPanel";
import { diagnosticsFromApiError, friendlyApiErrorMessage } from "@/utils/reports/diagnostics";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { showConfirm } from "@/utils/confirm";
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

type ChromeRefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
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
  const busy = ref(false);
  const error = ref<string | null>(null);
  const diagnostics = ref<ReturnType<typeof diagnosticsFromApiError>>([]);
  const notice = ref<string | null>(null);
  const specJson = ref("");
  const specFile = ref<File | null>(null);
  const zipFile = ref<File | null>(null);
  const publish = ref(true);
  const makeDefault = ref(false);
  const previewLocale = ref("en");
  const selected = ref<ChromeRow | null>(null);
  const chromeSearch = ref<string | null>(null);
  const chromePageSize = ref(20);
  const chromeRefresh = ref<ChromeRefreshHook | null>(null);
  const canAuthor = computed(() => hasOneOfAuthorities(["reports.studio", "report_engine:author"]));
  const canSave = computed(() => specJson.value.trim().length > 0);

  const refresh = () => {
    chromeRefresh.value?.refreshAsIs();
  };

  const chromeHeaders = computed<TableHeader<ChromeRow>[]>(() => [
    {
      key: "name",
      label: t("Name"),
      sortKey: "name",
      Value: ({ row }) => (
        <div>
          <div class="font-weight-medium">{row.name}</div>
          <div class="text-caption text-medium-emphasis">{row.code} · v{row.version}</div>
        </div>
      ),
    },
    {
      key: "type",
      label: t("Type"),
      sortKey: "type",
      Value: ({ row }) => <StatusBadge status={row.chromeType} label={row.chromeType} toneOverride="info" />,
    },
    {
      key: "status",
      label: t("Status"),
      sortKey: "status",
      Value: ({ row }) => (
        <div class="d-flex align-center ga-2 flex-wrap">
          <StatusBadge status={row.status} label={row.status} toneOverride={row.status === "PUBLISHED" ? "success" : "neutral"} />
          {row.isDefaultGlobal && <StatusBadge status="DEFAULT" label={t("Global Default")} toneOverride="success" />}
        </div>
      ),
    },
    {
      key: "locales",
      label: t("Languages"),
      value: (row) => row.supportedLocales.join(", "),
    },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{
            label: t("Preview"),
            icon: "mdi-eye-outline",
            onClick: () => {
              selected.value = selected.value?.id === row.id ? null : row;
            },
          }}
          items={[
            { key: "edit", label: t("Edit"), icon: "mdi-pencil-outline", onClick: () => editRow(row) },
            { key: "copy", label: t("Copy code"), icon: "mdi-content-copy", onClick: () => void copyCode(row.code) },
            { key: "download", label: t("Download spec"), icon: "mdi-download", onClick: () => downloadSpec(row) },
            {
              key: "default",
              label: row.isDefaultGlobal ? t("Clear default") : t("Set global default"),
              icon: "mdi-star-outline",
              disabled: row.status !== "PUBLISHED",
              onClick: () => void setDefault(row, !row.isDefaultGlobal),
            },
            {
              key: "archive",
              label: t("Archive"),
              icon: "mdi-archive-outline",
              danger: true,
              dividerBefore: true,
              onClick: () => void archiveRow(row),
            },
          ]}
        />
      ),
    },
  ]);

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
    diagnostics.value = [];
    notice.value = null;
  };

  const editRow = (row: ChromeRow) => {
    specJson.value = JSON.stringify(row.spec, null, 2);
    specFile.value = null;
    zipFile.value = null;
    error.value = null;
    diagnostics.value = [];
    publish.value = false;
    makeDefault.value = row.isDefaultGlobal;
    notice.value = t("Loaded {name} into the editor", { name: row.name });
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
    diagnostics.value = [];
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
      refresh();
    } catch (caught) {
      diagnostics.value = diagnosticsFromApiError(caught);
      error.value = friendlyApiErrorMessage(caught);
    } finally {
      busy.value = false;
    }
  };

  const archiveRow = async (row: ChromeRow) => {
    const confirmed = await showConfirm({
      title: t("Archive header/footer"),
      message: t("Archive {name}? It will no longer be available to reports.", { name: row.name }),
      submitButtonLabel: t("Archive"),
      type: "error",
    });
    if (!confirmed) return;
    busy.value = true;
    error.value = null;
    diagnostics.value = [];
    try {
      await api.post(urlsMap.reportEngineChromeArchive(row.id), {});
      if (selected.value?.id === row.id) selected.value = null;
      notice.value = t("Header/footer archived");
      refresh();
    } catch (caught) {
      diagnostics.value = diagnosticsFromApiError(caught);
      error.value = friendlyApiErrorMessage(caught);
    } finally {
      busy.value = false;
    }
  };

  const setDefault = async (row: ChromeRow, isDefault: boolean) => {
    busy.value = true;
    error.value = null;
    diagnostics.value = [];
    try {
      await api.post(urlsMap.reportEngineChromeDefault(row.id), { isDefault });
      refresh();
    } catch (caught) {
      diagnostics.value = diagnosticsFromApiError(caught);
      error.value = friendlyApiErrorMessage(caught);
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

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Headers & Footers")}
          subtitle={t("Upload reusable bilingual chrome specs and assign the global default")}
          breadcrumbs={[{ label: t("Reporting"), to: "/reports/catalog" }, { label: t("Headers & Footers") }]}
          end={() => (
            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <VBtn variant="tonal" prependIcon="mdi-refresh" loading={busy.value} onClick={refresh}>
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
              <VBtn size="small" variant="tonal" onClick={refresh}>{t("Retry")}</VBtn>
            </div>
          </VAlert>
        )}

        {diagnostics.value.length > 0 && (
          <ReportDiagnosticsPanel diagnostics={diagnostics.value} title={t("Action diagnostics")} />
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
              density="comfortable"
              variant="outlined"
              hideDetails="auto"
              modelValue={specFile.value}
              onUpdate:modelValue={(files: File | File[] | null) => void readSpecFile(Array.isArray(files) ? (files[0] ?? null) : files)}
            />
            <VFileInput
              label={t("Logo/seal bundle (.zip, optional)")}
              density="comfortable"
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
              density="comfortable"
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
                color="primary"
                baseColor="grey"
                inset
                modelValue={publish.value}
                onUpdate:modelValue={(value: boolean | null) => (publish.value = Boolean(value))}
                density="comfortable"
                hideDetails="auto"
              />
              <VSwitch
                label={t("Make default")}
                color="primary"
                baseColor="grey"
                inset
                modelValue={makeDefault.value}
                onUpdate:modelValue={(value: boolean | null) => (makeDefault.value = Boolean(value))}
                density="comfortable"
                hideDetails="auto"
              />
            </div>
          </div>
        </SurfaceCard>

        <ApiTable<ChromeRow>
          title={t("Registered Headers & Footers")}
          url={urlsMap.reportEngineChrome}
          headers={chromeHeaders.value}
          localSearch={false}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={chromePageSize.value}
          setNumberOfItemsPerPage={(value) => (chromePageSize.value = value)}
          searchValue={chromeSearch.value}
          setSearchValue={(value) => (chromeSearch.value = value)}
          apiDataExtractor={(data) => (data as { specs?: ChromeRow[] }).specs ?? []}
          apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
          setRefreshHook={(hook) => {
            chromeRefresh.value = hook as ChromeRefreshHook;
          }}
          clearRefreshHook={() => {
            chromeRefresh.value = null;
          }}
          onRefresh={(table, refreshTable) => {
            void refreshTable({
              queryParams: {
                page: table.page,
                pageSize: chromePageSize.value,
                ...(chromeSearch.value ? { search: chromeSearch.value } : {}),
                ...(table.sortKey
                  ? { sortKey: table.sortKey, sortDirection: table.sortDirection }
                  : {}),
              },
            });
          }}
        />

        {selected.value && (
          <SurfaceCard title={t("Chrome preview")} subtitle={t("Preview the selected header or footer")}>
            <div class="d-flex align-center ga-2 mb-2">
              <VSelect
                modelValue={previewLocale.value}
                onUpdate:modelValue={(value: string) => (previewLocale.value = value)}
                items={selected.value.supportedLocales}
                density="comfortable"
                variant="outlined"
                hideDetails="auto"
                style={{ maxWidth: "160px" }}
              />
            </div>
            <div
              class="pg-section-fields pa-3"
              style={{ marginBottom: 0, borderStyle: "dashed" }}
              innerHTML={previewHtml(selected.value)}
            />
            <DescriptionList
              class="mt-3"
              items={[
                { label: t("Locales"), value: selected.value.supportedLocales.join(", ") },
                { label: t("Variables"), value: selected.value.spec.template.used_variables.join(", ") || "—" },
              ]}
            />
          </SurfaceCard>
        )}
      </ThemedView>
    </ScreenContainer>
  );
});

export default ReportsChromePage;
