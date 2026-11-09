import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { EmptyState, PageHeader, SegmentedTabs, StatusBadge, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import "@/components/Table/styling.css";
import {
  ReportInputForm,
  ReportLanguagePromptDialog,
  ReportPagedPreviewSurface,
  renderChromeHtml,
  renderReportSectionsToHtml,
  type ReportDescriptorSpec,
  type ReportExecutionBundle,
} from "@/lib/reportEngineSdk";
import { resolveInputDefaults } from "@/lib/reportEngineSdk/utils/inputDefaults";

type CatalogReport = {
  id: string;
  code: string;
  version: number;
  category: string;
  audienceScope: string;
  supportedLocales: string[];
  defaultLocale: string;
  authorityMode: string;
  inferredRoles: string[];
  inferredAuthorities: string[];
  conflictStatus: string;
  spec: ReportDescriptorSpec;
};

type ChromeRow = {
  id: string;
  code: string;
  name: string;
  chromeType: "HEADER" | "FOOTER";
  status: string;
  isDefaultGlobal: boolean;
};

const ReportsCatalogPage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const reports = ref<CatalogReport[]>([]);
  const chromeSpecs = ref<ChromeRow[]>([]);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const selected = ref<CatalogReport | null>(null);
  const audienceTab = ref("ALL");
  const inputs = ref<Record<string, unknown>>({});
  const locale = ref("en");
  const headerMode = ref("GLOBAL_DEFAULT");
  const headerCode = ref<string | null>(null);
  const footerMode = ref("GLOBAL_DEFAULT");
  const footerCode = ref<string | null>(null);
  const generating = ref(false);
  const bundle = ref<ReportExecutionBundle | null>(null);
  const languagePrompt = ref(false);
  const previewRef = ref<{ printClientSideVectorPdf?: () => void } | null>(null);
  const canStudio = computed(() =>
    hasOneOfAuthorities(["reports.studio", "reports.draft", "report_engine:author", "report:review", "report:approve", "security:write"]),
  );
  const canChrome = computed(() => hasOneOfAuthorities(["reports.studio", "security:write"]));
  const hasRows = computed(() =>
    bundle.value ? Object.values(bundle.value.datasets).some((rows) => rows.length > 0) : false,
  );

  const filteredReports = computed(() => {
    if (audienceTab.value === "BACKOFFICE_INTERNAL") {
      return reports.value.filter((report) => report.audienceScope === "BACKOFFICE_INTERNAL");
    }
    if (audienceTab.value === "MERCHANT_FACING") {
      return reports.value.filter(
        (report) => report.audienceScope === "MERCHANT_FACING" || report.audienceScope === "BOTH",
      );
    }
    return reports.value;
  });
  const audienceTabs = computed(() => [
    { label: t("All Authorized Reports"), value: "ALL", count: reports.value.length },
    {
      label: t("Backoffice Internal"),
      value: "BACKOFFICE_INTERNAL",
      count: reports.value.filter((report) => report.audienceScope === "BACKOFFICE_INTERNAL").length,
    },
    {
      label: t("Merchant Reports"),
      value: "MERCHANT_FACING",
      count: reports.value.filter((report) => report.audienceScope === "MERCHANT_FACING" || report.audienceScope === "BOTH").length,
    },
  ]);
  const availableLocales = computed(() =>
    selected.value ? Object.keys(selected.value.spec.i18n.locales) : ["en"],
  );

  const renderedSectionsHtml = computed(() =>
    bundle.value ? renderReportSectionsToHtml({ bundle: bundle.value, locale: locale.value, t }) : "",
  );
  const renderedHeaderHtml = computed(() =>
    bundle.value
      ? renderChromeHtml({
          chrome: bundle.value.resolvedHeaderChrome,
          bundle: bundle.value,
          locale: locale.value,
          t,
        })
      : "",
  );
  const renderedFooterHtml = computed(() =>
    bundle.value
      ? renderChromeHtml({
          chrome: bundle.value.resolvedFooterChrome,
          bundle: bundle.value,
          locale: locale.value,
          t,
        })
      : "",
  );

  const load = async () => {
    loading.value = true;
    error.value = null;
    try {
      const [catalogResponse, chromeResponse] = await Promise.all([
        api.get(urlsMap.reportEngineCatalog),
        api.get(urlsMap.reportEngineChrome),
      ]);
      reports.value = (catalogResponse.data?.reports ?? []) as CatalogReport[];
      chromeSpecs.value = (chromeResponse.data?.specs ?? []) as ChromeRow[];
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading.value = false;
    }
  };

  const selectReport = (report: CatalogReport) => {
    selected.value = report;
    inputs.value = resolveInputDefaults(report.spec);
    locale.value = report.defaultLocale || "en";
    headerMode.value = report.spec.page_layout.header_mode ?? "GLOBAL_DEFAULT";
    headerCode.value = report.spec.page_layout.header_chrome_code ?? null;
    footerMode.value = report.spec.page_layout.footer_mode ?? "GLOBAL_DEFAULT";
    footerCode.value = report.spec.page_layout.footer_chrome_code ?? null;
    bundle.value = null;
    error.value = null;
  };

  const resetInputs = () => {
    if (!selected.value) return;
    inputs.value = resolveInputDefaults(selected.value.spec);
  };

  const clearSelection = () => {
    selected.value = null;
    bundle.value = null;
    inputs.value = {};
    error.value = null;
  };

  const downloadText = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadSpec = (report: CatalogReport) => {
    downloadText(
      `${report.code}-v${report.version}.json`,
      JSON.stringify(report.spec, null, 2),
      "application/json",
    );
  };

  const copyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
  };

  const autocomplete = async (
    source: string,
    query: string,
    dependentValues?: Record<string, unknown>,
  ) => {
    const response = await api.get(urlsMap.reportEngineAutocomplete(source), {
      params: {
        q: query,
        dependent: dependentValues ? JSON.stringify(dependentValues) : undefined,
      },
    });
    return (response.data?.items ?? []) as Array<{ value: string; label: string; sublabel?: string; badge?: string }>;
  };

  const runGenerate = async (chosenLocale: string) => {
    if (!selected.value) return;
    generating.value = true;
    error.value = null;
    try {
      const response = await api.post(urlsMap.reportEngineExecute(selected.value.code), {
        inputs: inputs.value,
        locale: chosenLocale,
        ...(selected.value.spec.page_layout.allow_runtime_chrome_selection
          ? {
              chromeOverride: {
                headerMode: headerMode.value,
                headerChromeCode: headerCode.value,
                footerMode: footerMode.value,
                footerChromeCode: footerCode.value,
              },
            }
          : {}),
      });
      bundle.value = response.data as ReportExecutionBundle;
      locale.value = chosenLocale;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      generating.value = false;
    }
  };

  const requestGenerate = () => {
    if (!selected.value) return;
    if (
      availableLocales.value.length > 1 &&
      selected.value.spec.i18n.prompt_user_when_multi_locale !== false
    ) {
      languagePrompt.value = true;
      return;
    }
    void runGenerate(locale.value);
  };

  const onLanguageConfirmed = (chosen: string) => {
    locale.value = chosen;
    void runGenerate(chosen);
  };

  const allDatasetRows = (): Array<Record<string, unknown>> => {
    if (!bundle.value) return [];
    return Object.entries(bundle.value.datasets).flatMap(([datasetId, rows]) =>
      rows.map((row) => ({ dataset: datasetId, ...row })),
    );
  };

  const exportCsv = () => {
    if (!selected.value) return;
    const rows = allDatasetRows();
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]!);
    const csv = [
      headers.join(","),
      ...rows.map((row) =>
        headers
          .map((header) => {
            const value = row[header] ?? "";
            const text = String(value).replace(/"/g, '""');
            return /[",\n]/.test(text) ? `"${text}"` : text;
          })
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected.value.code}-${locale.value}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportXlsx = async () => {
    if (!selected.value) return;
    const rows = allDatasetRows();
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]!).map((key) => ({ text: key, key, type: "string" as const }));
    await xlsxUIPipeline.downloadXlsxFromHeadersAndData({
      headers,
      data: rows,
      title: `${selected.value.code}-${locale.value}`,
      color: "#2563EB",
    });
  };

  const chromeOptions = (type: "HEADER" | "FOOTER") => {
    if (!selected.value?.spec.page_layout.allow_runtime_chrome_selection) {
      return [{ title: t("Report default"), value: "GLOBAL_DEFAULT" }];
    }
    return [
      { title: t("Global Default"), value: "GLOBAL_DEFAULT" },
      { title: t("None"), value: "NONE" },
      ...chromeSpecs.value
        .filter((row) => row.chromeType === type && row.status === "PUBLISHED")
        .map((row) => ({ title: `${row.name} (${row.code})`, value: row.code })),
    ];
  };

  onMounted(load);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
      <PageHeader
        title={t("Report Catalog")}
        subtitle={t("Run and export published backoffice and merchant reports")}
        breadcrumbs={[{ label: t("Reporting"), to: "/reports/catalog" }, { label: t("Catalog") }]}
        end={() => (
          <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
              {t("Refresh")}
            </VBtn>
            {canStudio.value && (
              <VBtn variant="tonal" prependIcon="mdi-robot-outline" onClick={() => void router.push({ name: "ReportsStudio" })}>
                {t("Open Studio")}
              </VBtn>
            )}
            {canChrome.value && (
              <VBtn variant="tonal" prependIcon="mdi-page-layout-header-footer" onClick={() => void router.push({ name: "ReportsChrome" })}>
                {t("Headers & Footers")}
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

      <SurfaceCard title={t("Published Reports")} subtitle={t("Only reports your role can access are shown")} noPadding>
        <div style={{ padding: "16px 20px 0" }}>
          <SegmentedTabs
            modelValue={audienceTab.value}
            onUpdate:modelValue={(value: string) => (audienceTab.value = value)}
            tabs={audienceTabs.value}
            ariaLabel={t("Audience")}
          />
        </div>
        {loading.value ? (
          <StateView loading minHeight="220px" />
        ) : filteredReports.value.length === 0 ? (
          <EmptyState
            title={t("No reports available")}
            description={t("Published reports appear here after an author publishes them from Report Studio.")}
            icon="mdi-file-chart-outline"
            actionLabel={canStudio.value ? t("Open Studio") : ""}
            actionIcon="mdi-robot-outline"
            onAction={() => void router.push({ name: "ReportsStudio" })}
          />
        ) : (
          <div class="table-wrapper">
            <table class="modern-table pg-unified-table">
              <thead>
                <tr>
                  <th>{t("Report")}</th>
                  <th>{t("Category")}</th>
                  <th>{t("Audience")}</th>
                  <th>{t("Languages")}</th>
                  <th>{t("Version")}</th>
                  <th class="pg-col-actions">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredReports.value.map((report) => (
                  <tr key={report.id}>
                    <td>
                      <div class="font-weight-medium">{report.spec.i18n.locales.en?.["report.title"] ?? report.code}</div>
                      <div class="text-caption text-medium-emphasis">{report.code}</div>
                    </td>
                    <td>{report.category}</td>
                    <td>
                      <StatusBadge status={report.audienceScope} label={report.audienceScope} toneOverride="info" />
                    </td>
                    <td>{report.supportedLocales.join(", ")}</td>
                    <td>{report.version}</td>
                    <td class="pg-col-actions">
                      <TableRowActions
                        primaryAction={{
                          label: t("Run"),
                          icon: "mdi-play",
                          onClick: () => selectReport(report),
                        }}
                        items={[
                          { key: "copy", label: t("Copy code"), icon: "mdi-content-copy", onClick: () => void copyCode(report.code) },
                          { key: "download", label: t("Download spec"), icon: "mdi-download", onClick: () => downloadSpec(report) },
                          ...(canStudio.value
                            ? [{ key: "studio", label: t("Open Studio"), icon: "mdi-robot-outline", onClick: () => void router.push({ name: "ReportsStudio" }) }]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SurfaceCard>

      {selected.value && (
        <SurfaceCard
          title={selected.value.spec.i18n.locales.en?.["report.title"] ?? selected.value.code}
          subtitle={t("Fill the parameters, choose the output language and generate the report")}
          v-slots={{
            headerActions: () => (
              <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                <VBtn size="small" variant="text" onClick={resetInputs}>{t("Reset inputs")}</VBtn>
                <VBtn size="small" variant="text" onClick={clearSelection}>{t("Clear selection")}</VBtn>
              </ThemedView>
            ),
          }}
        >
          <div class="d-flex flex-column ga-4">
            <ReportInputForm
              spec={selected.value.spec}
              modelValue={inputs.value}
              autocomplete={autocomplete}
              onUpdate:modelValue={(value: Record<string, unknown>) => (inputs.value = value)}
            />
            <div class="d-flex flex-wrap ga-3 align-end">
              <VSelect
                v-model={locale.value}
                label={t("Output language")}
                items={availableLocales.value}
                density="compact"
                variant="outlined"
                hideDetails="auto"
                style={{ maxWidth: "180px" }}
              />
              {selected.value.spec.page_layout.allow_runtime_chrome_selection && (
                <>
                  <VSelect
                    v-model={headerMode.value}
                    label={t("Header")}
                    items={chromeOptions("HEADER")}
                    density="compact"
                    variant="outlined"
                    hideDetails="auto"
                    style={{ maxWidth: "260px" }}
                  />
                  <VSelect
                    v-model={footerMode.value}
                    label={t("Footer")}
                    items={chromeOptions("FOOTER")}
                    density="compact"
                    variant="outlined"
                    hideDetails="auto"
                    style={{ maxWidth: "260px" }}
                  />
                </>
              )}
              <VBtn color="primary" loading={generating.value} onClick={requestGenerate}>
                {t("Generate Report")}
              </VBtn>
            </div>
          </div>
        </SurfaceCard>
      )}

      {bundle.value && (
        <SurfaceCard
          title={t("Paginated Vector Preview")}
          subtitle={t("Client-side rendering; no server CPU used")}
          v-slots={{
            headerActions: () => (
              <VBtn
                size="small"
                variant="tonal"
                prependIcon="mdi-refresh"
                loading={generating.value}
                onClick={() => void runGenerate(locale.value)}
              >
                {t("Regenerate")}
              </VBtn>
            ),
          }}
        >
          <div class="d-flex flex-wrap ga-2 mb-3">
            <VBtn size="small" variant="tonal" prependIcon="mdi-file-delimited-outline" disabled={!hasRows.value} onClick={exportCsv}>
              {t("Export CSV")}
            </VBtn>
            <VBtn size="small" variant="tonal" prependIcon="mdi-microsoft-excel" disabled={!hasRows.value} onClick={() => void exportXlsx()}>
              {t("Export XLSX")}
            </VBtn>
            <VBtn
              size="small"
              variant="tonal"
              prependIcon="mdi-printer-outline"
              disabled={!hasRows.value}
              onClick={() => previewRef.value?.printClientSideVectorPdf?.()}
            >
              {t("Print")}
            </VBtn>
          </div>
          <ReportPagedPreviewSurface
            ref={previewRef}
            bundle={bundle.value}
            selectedLocale={locale.value}
            renderedSectionsHtml={renderedSectionsHtml.value}
            renderedHeaderHtml={renderedHeaderHtml.value}
            renderedFooterHtml={renderedFooterHtml.value}
            onChangeLocale={(next: string) => (locale.value = next)}
          />
        </SurfaceCard>
      )}

      {selected.value && (
        <ReportLanguagePromptDialog
          modelValue={languagePrompt.value}
          availableLocales={availableLocales.value}
          defaultLocale={selected.value.defaultLocale}
          reportTitleMap={Object.fromEntries(
            availableLocales.value.map((loc) => [loc, selected.value?.spec.i18n.locales[loc]?.["report.title"] ?? ""]),
          )}
          onUpdate:modelValue={(value: boolean) => (languagePrompt.value = value)}
          onConfirmLocale={onLanguageConfirmed}
        />
      )}
      </ThemedView>
    </ScreenContainer>
  );
});

export default ReportsCatalogPage;
