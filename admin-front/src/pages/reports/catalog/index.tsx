import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { PageHeader, SegmentedTabs, StatusBadge, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiError } from "@/utils/errors/extractor";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
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

type CatalogRefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const ReportsCatalogPage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const chromeSpecs = ref<ChromeRow[]>([]);
  const chromeLoading = ref(false);
  const error = ref<string | null>(null);
  const selected = ref<CatalogReport | null>(null);
  const audienceTab = ref("ALL");
  const catalogSearch = ref<string | null>(null);
  const catalogPageSize = ref(20);
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
  const catalogRefresh = ref<CatalogRefreshHook | null>(null);
  const canStudio = computed(() =>
    hasOneOfAuthorities(["reports.studio", "reports.draft", "report_engine:author", "report:review", "report:approve", "security:write"]),
  );
  const canChrome = computed(() => hasOneOfAuthorities(["reports.studio", "security:write"]));
  const hasRows = computed(() =>
    bundle.value ? Object.values(bundle.value.datasets).some((rows) => rows.length > 0) : false,
  );

  const audienceTabs = computed(() => [
    { label: t("All Authorized Reports"), value: "ALL" },
    { label: t("Backoffice Internal"), value: "BACKOFFICE_INTERNAL" },
    { label: t("Merchant Reports"), value: "MERCHANT_FACING" },
  ]);
  const availableLocales = computed(() =>
    selected.value ? Object.keys(selected.value.spec.i18n.locales) : ["en"],
  );

  const renderedSectionsHtml = computed(() =>
    bundle.value ? renderReportSectionsToHtml({ bundle: bundle.value, locale: locale.value, t }) : "",
  );
  const renderedHeaderHtml = computed(() =>
    bundle.value
      ? renderChromeHtml({ chrome: bundle.value.resolvedHeaderChrome, bundle: bundle.value, locale: locale.value, t })
      : "",
  );
  const renderedFooterHtml = computed(() =>
    bundle.value
      ? renderChromeHtml({ chrome: bundle.value.resolvedFooterChrome, bundle: bundle.value, locale: locale.value, t })
      : "",
  );

  const catalogHeaders = computed<TableHeader<CatalogReport>[]>(() => [
    {
      key: "report",
      label: t("Report"),
      sortKey: "report",
      Value: ({ row }) => (
        <div>
          <div class="font-weight-medium">{row.spec.i18n.locales.en?.["report.title"] ?? row.code}</div>
          <div class="text-caption text-medium-emphasis">{row.code}</div>
        </div>
      ),
    },
    { key: "category", label: t("Category"), sortKey: "category", value: (row) => row.category },
    {
      key: "audience",
      label: t("Audience"),
      Value: ({ row }) => <StatusBadge status={row.audienceScope} label={row.audienceScope} toneOverride="info" />,
    },
    { key: "languages", label: t("Languages"), value: (row) => row.supportedLocales.join(", ") },
    { key: "version", label: t("Version"), sortKey: "version", value: (row) => String(row.version) },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{ label: t("Run"), icon: "mdi-play", onClick: () => selectReport(row) }}
          items={[
            { key: "copy", label: t("Copy code"), icon: "mdi-content-copy", onClick: () => void copyCode(row.code) },
            { key: "download", label: t("Download spec"), icon: "mdi-download", onClick: () => downloadSpec(row) },
            ...(canStudio.value
              ? [{ key: "studio", label: t("Open Studio"), icon: "mdi-robot-outline", onClick: () => void router.push({ name: "ReportsStudio" }) }]
              : []),
          ]}
        />
      ),
    },
  ]);

  const loadChrome = async () => {
    chromeLoading.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineChrome);
      chromeSpecs.value = (response.data?.specs ?? []) as ChromeRow[];
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      chromeLoading.value = false;
    }
  };

  const refresh = async () => {
    await loadChrome();
    catalogRefresh.value?.refreshAsIs();
  };

  const changeAudience = (value: string) => {
    audienceTab.value = value;
    void catalogRefresh.value?.refresh({
      queryParams: {
        audience: value,
        page: 1,
        pageSize: catalogPageSize.value,
        ...(catalogSearch.value ? { search: catalogSearch.value } : {}),
      },
      nextSkip: 0,
    });
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
    downloadText(`${report.code}-v${report.version}.json`, JSON.stringify(report.spec, null, 2), "application/json");
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
      const extracted = extractApiError(caught);
      if (extracted?.code === "REPORT_NOT_PUBLISHED") {
        error.value = t("This report is saved but not published. Open Report Studio, publish it, then run it again.");
      } else if (extracted?.code === "REPORT_NOT_FOUND") {
        error.value = t("This report could not be found. Refresh the catalog or open Report Studio to publish it.");
      } else if (extracted?.status === 403) {
        error.value = t("You do not have permission to run this report. Ask a Security Admin to grant the report access policy.");
      } else {
        error.value = extracted?.error ?? (caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      generating.value = false;
    }
  };

  const requestGenerate = () => {
    if (!selected.value) return;
    if (availableLocales.value.length > 1 && selected.value.spec.i18n.prompt_user_when_multi_locale !== false) {
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
            const text = String(row[header] ?? "").replace(/"/g, '""');
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

  onMounted(() => {
    void loadChrome();
  });

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Catalog")}
          subtitle={t("Run and export published backoffice and merchant reports")}
          breadcrumbs={[{ label: t("Reporting"), to: "/reports/catalog" }, { label: t("Catalog") }]}
          end={() => (
            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <VBtn variant="tonal" prependIcon="mdi-refresh" loading={chromeLoading.value} onClick={() => void refresh()}>
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
              <VBtn size="small" variant="tonal" onClick={() => void refresh()}>{t("Retry")}</VBtn>
            </div>
          </VAlert>
        )}

        <ApiTable<CatalogReport>
          title={t("Published Reports")}
          url={urlsMap.reportEngineCatalog}
          headers={catalogHeaders.value}
          localSearch={false}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={catalogPageSize.value}
          setNumberOfItemsPerPage={(value) => (catalogPageSize.value = value)}
          searchValue={catalogSearch.value}
          setSearchValue={(value) => (catalogSearch.value = value)}
          apiDataExtractor={(data) => (data as { reports?: CatalogReport[] }).reports ?? []}
          apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
          setRefreshHook={(hook) => {
            catalogRefresh.value = hook as CatalogRefreshHook;
          }}
          clearRefreshHook={() => {
            catalogRefresh.value = null;
          }}
          onRefresh={(table, refresh) => {
            void refresh({
              queryParams: {
                audience: audienceTab.value,
                page: table.page,
                pageSize: catalogPageSize.value,
                ...(catalogSearch.value ? { search: catalogSearch.value } : {}),
                ...(table.sortKey
                  ? { sortKey: table.sortKey, sortDirection: table.sortDirection }
                  : {}),
              },
            });
          }}
          TopSlot={() => (
            <div style={{ padding: "0 20px 12px" }}>
              <SegmentedTabs
                modelValue={audienceTab.value}
                onUpdate:modelValue={changeAudience}
                tabs={audienceTabs.value}
                ariaLabel={t("Audience")}
              />
            </div>
          )}
        />

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
                  density="comfortable"
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
                      density="comfortable"
                      variant="outlined"
                      hideDetails="auto"
                      style={{ maxWidth: "260px" }}
                    />
                    <VSelect
                      v-model={footerMode.value}
                      label={t("Footer")}
                      items={chromeOptions("FOOTER")}
                      density="comfortable"
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
