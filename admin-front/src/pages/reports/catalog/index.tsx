import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import {
  FormField,
  MetaPill,
  MonoRef,
  PageHeader,
  SegmentedTabs,
  SlideOverDrawer,
  StatusBadge,
  SurfaceCard,
} from "@/components/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiError } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import {
  ReportInputForm,
  ReportLanguagePromptDialog,
  ReportPagedPreviewSurface,
  formatReportValue,
  renderChromeHtml,
  renderReportSectionsToHtml,
  specTranslator,
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
  version: number;
  chromeType: "HEADER" | "FOOTER";
  status: string;
  isDefaultGlobal: boolean;
};

type CatalogRefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const AUDIENCE_LABEL_KEYS: Record<string, string> = {
  BACKOFFICE_INTERNAL: "Backoffice",
  MERCHANT_FACING: "Merchant",
  BOTH: "Merchant & Backoffice",
};

const ReportsCatalogPage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const chromeSpecs = ref<ChromeRow[]>([]);
  const chromeLoading = ref(false);
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
  const drawerOpen = ref(false);
  const previewRef = ref<{
    printClientSideVectorPdf?: () => void;
    renderPaginatedPreview?: () => Promise<void>;
    pageCount?: number;
  } | null>(null);
  const inputFormRef = ref<{ validate?: () => boolean } | null>(null);
  const catalogRefresh = ref<CatalogRefreshHook | null>(null);
  const previewPages = ref(1);
  const canStudio = computed(() =>
    hasOneOfAuthorities(["reports.studio", "reports.draft", "report_engine:author", "report:review", "report:approve", "security:write"]),
  );
  const canChrome = computed(() => hasOneOfAuthorities(["reports.studio", "security:write"]));
  const hasRows = computed(() =>
    bundle.value ? Object.values(bundle.value.datasets).some((rows) => rows.length > 0) : false,
  );
  const showOutputSection = computed(
    () =>
      availableLocales.value.length > 1 ||
      Boolean(selected.value?.spec.page_layout.allow_runtime_chrome_selection),
  );

  const audienceTabs = computed(() => [
    { label: t("All Authorized Reports"), value: "ALL" },
    { label: t("Backoffice Internal"), value: "BACKOFFICE_INTERNAL" },
    { label: t("Merchant Reports"), value: "MERCHANT_FACING" },
  ]);
  const availableLocales = computed(() =>
    selected.value ? Object.keys(selected.value.spec.i18n.locales) : ["en"],
  );

  const localizedTitle = (report: CatalogReport): string =>
    report.spec.i18n.locales[locale.value]?.["report.title"] ??
    report.spec.i18n.locales[report.defaultLocale]?.["report.title"] ??
    report.code;

  const specT = computed(() =>
    selected.value ? specTranslator(selected.value.spec, locale.value) : (key: string) => key,
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
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{localizedTitle(row)}</span>
          <MonoRef value={row.code} copyable={false} />
        </div>
      ),
    },
    { key: "category", label: t("Category"), sortKey: "category", value: (row) => row.category },
    {
      key: "audience",
      label: t("Audience"),
      Value: ({ row }) => (
        <StatusBadge
          status={row.audienceScope}
          label={t(AUDIENCE_LABEL_KEYS[row.audienceScope] ?? row.audienceScope)}
          toneOverride="info"
        />
      ),
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
      showSnackBar({ message: friendlyError(caught), type: "error" });
    } finally {
      chromeLoading.value = false;
    }
  };

  const friendlyError = (caught: unknown): string => {
    const extracted = extractApiError(caught);
    if (extracted?.code === "REPORT_NOT_PUBLISHED") {
      return t("This report is saved but not published. Open Report Studio, publish it, then run it again.");
    }
    if (extracted?.code === "REPORT_NOT_FOUND") {
      return t("This report could not be found. Refresh the catalog or open Report Studio to publish it.");
    }
    if (extracted?.status === 403) {
      return t("You do not have permission to run this report. Ask a Security Admin to grant the report access policy.");
    }
    return extracted?.error ?? (caught instanceof Error ? caught.message : String(caught));
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
    previewPages.value = 1;
    drawerOpen.value = true;
  };

  const resetInputs = () => {
    if (!selected.value) return;
    inputs.value = resolveInputDefaults(selected.value.spec);
  };

  const clearSelection = () => {
    drawerOpen.value = false;
    selected.value = null;
    bundle.value = null;
    inputs.value = {};
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
    try {
      await navigator.clipboard.writeText(code);
      showSnackBar({ message: t("Code copied"), type: "success" });
    } catch {
      showSnackBar({ message: t("Copy failed"), type: "error" });
    }
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

  const effectiveChromeMode = (mode: string, code: string | null, type: "HEADER" | "FOOTER") => {
    if (mode !== "SPECIFIC_CHROME_CODE") return { mode, code: null };
    const fallback = latestChromeCode(type);
    return { mode: code || fallback ? "SPECIFIC_CHROME_CODE" : "GLOBAL_DEFAULT", code: code ?? fallback };
  };

  const runGenerate = async (chosenLocale: string) => {
    if (!selected.value) return;
    if (inputFormRef.value?.validate && !inputFormRef.value.validate()) {
      showSnackBar({ message: t("Fix the highlighted inputs before generating"), type: "warning" });
      return;
    }
    generating.value = true;
    try {
      const header = effectiveChromeMode(headerMode.value, headerCode.value, "HEADER");
      const footer = effectiveChromeMode(footerMode.value, footerCode.value, "FOOTER");
      const response = await api.post(urlsMap.reportEngineExecute(selected.value.code), {
        inputs: inputs.value,
        locale: chosenLocale,
        ...(selected.value.spec.page_layout.allow_runtime_chrome_selection
          ? {
              chromeOverride: {
                headerMode: header.mode,
                headerChromeCode: header.code,
                footerMode: footer.mode,
                footerChromeCode: footer.code,
              },
            }
          : {}),
      });
      bundle.value = response.data as ReportExecutionBundle;
      locale.value = chosenLocale;
      drawerOpen.value = false;
      showSnackBar({ message: t("Report generated"), type: "success" });
    } catch (caught) {
      showSnackBar({ message: friendlyError(caught), type: "error" });
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

  const exportExcel = async () => {
    if (!selected.value || !bundle.value) return;
    const sheets = Object.entries(bundle.value.datasets)
      .filter(([, rows]) => rows.length > 0)
      .map(([datasetId, rows]) => {
        const section = selected.value!.spec.sections.find(
          (entry) => entry.section_type === "DATA_TABLE" && entry.dataset_id === datasetId,
        );
        const columnDefs =
          section && section.section_type === "DATA_TABLE"
            ? section.columns
            : Object.keys(rows[0] ?? {}).map((field) => ({
                field,
                header_i18n_key: "",
                format_hint: "RAW" as const,
              }));
        const headers = columnDefs.map((column) => ({
          text:
            column.header_i18n_key && specT.value(column.header_i18n_key) !== column.header_i18n_key
              ? specT.value(column.header_i18n_key)
              : column.field,
          key: column.field,
          type: "string" as const,
        }));
        const data = rows.map((row) => {
          const record: Record<string, string> = {};
          for (const column of columnDefs) {
            const raw = formatReportValue(
              row[column.field],
              column.format_hint ?? "RAW",
              undefined,
              specT.value,
            );
            record[column.field] = excelSafe(raw);
          }
          return record;
        });
        return { name: datasetId, headers, data };
      });
    if (sheets.length === 0) return;
    await xlsxUIPipeline.downloadXlsxWorkbook({
      sheets,
      title: `${selected.value.code}-${locale.value}`,
    });
  };

  const latestChromeByCode = (type: "HEADER" | "FOOTER"): ChromeRow[] => {
    const byCode = new Map<string, ChromeRow>();
    for (const row of chromeSpecs.value) {
      if (row.chromeType !== type || row.status !== "PUBLISHED") continue;
      const current = byCode.get(row.code);
      if (!current || row.version > current.version) byCode.set(row.code, row);
    }
    return [...byCode.values()];
  };

  const latestChromeCode = (type: "HEADER" | "FOOTER"): string | null =>
    latestChromeByCode(type)[0]?.code ?? null;

  const chromeModeOptions = () => [
    { title: t("Global Default"), value: "GLOBAL_DEFAULT" },
    { title: t("Specific header/footer"), value: "SPECIFIC_CHROME_CODE" },
    { title: t("None"), value: "NONE" },
  ];

  const chromeCodeOptions = (type: "HEADER" | "FOOTER") =>
    latestChromeByCode(type).map((row) => ({ title: `${row.name} (${row.code})`, value: row.code }));

  onMounted(() => {
    void loadChrome();
  });

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Catalog")}
          subtitle={t("Run and export published backoffice and merchant reports")}
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

        {bundle.value && selected.value && (
          <SurfaceCard
            title={t("Paginated Vector Preview")}
            subtitle={t("Client-side rendering; no server CPU used")}
            v-slots={{
              headerActions: () => (
                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <MetaPill color="info">{`${previewPages.value} ${t("pages")}`}</MetaPill>
                  <MonoRef value={bundle.value?.verificationSha256 ?? ""} truncate={12} />
                  <SegmentedTabs
                    modelValue={locale.value}
                    onUpdate:modelValue={(next: string) => (locale.value = next)}
                    tabs={availableLocales.value.map((entry) => ({ label: entry.toUpperCase(), value: entry }))}
                    ariaLabel={t("Output language")}
                  />
                  <VBtn size="small" variant="tonal" prependIcon="mdi-refresh" loading={generating.value} onClick={() => void runGenerate(locale.value)}>
                    {t("Regenerate")}
                  </VBtn>
                  <VBtn size="small" variant="tonal" prependIcon="mdi-microsoft-excel" disabled={!hasRows.value} onClick={() => void exportExcel()}>
                    {t("Export Excel")}
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
                </ThemedView>
              ),
            }}
          >
            <ReportPagedPreviewSurface
              ref={previewRef}
              bundle={bundle.value}
              selectedLocale={locale.value}
              renderedSectionsHtml={renderedSectionsHtml.value}
              renderedHeaderHtml={renderedHeaderHtml.value}
              renderedFooterHtml={renderedFooterHtml.value}
              onPageCountChanged={(pages: number) => (previewPages.value = pages)}
            />
          </SurfaceCard>
        )}

        <div>
          <SegmentedTabs
            modelValue={audienceTab.value}
            onUpdate:modelValue={changeAudience}
            tabs={audienceTabs.value}
            ariaLabel={t("Audience")}
          />
        </div>

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
        />

        <SlideOverDrawer
          modelValue={drawerOpen.value}
          onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)}
          title={selected.value ? localizedTitle(selected.value) : t("Run report")}
          subtitle={t("Fill the parameters, choose the output language and generate the report")}
          width={720}
          v-slots={{
            footer: () =>
              selected.value ? (
                <div class="pg-report-actions">
                  <div class="pg-report-actions__secondary">
                    <VBtn variant="text" onClick={resetInputs}>{t("Reset inputs")}</VBtn>
                    <VBtn variant="text" onClick={clearSelection}>{t("Clear selection")}</VBtn>
                  </div>
                  <VBtn color="primary" prependIcon="mdi-file-chart" loading={generating.value} onClick={requestGenerate}>
                    {t("Generate Report")}
                  </VBtn>
                </div>
              ) : null,
          }}
        >
          {selected.value && (
            <div class="d-flex flex-column ga-4">
              <ReportInputForm
                ref={inputFormRef}
                spec={selected.value.spec}
                modelValue={inputs.value}
                autocomplete={autocomplete}
                translate={specT.value}
                onUpdate:modelValue={(value: Record<string, unknown>) => (inputs.value = value)}
              />

              {showOutputSection.value && (
                <section class="pg-report-section">
                  <header class="pg-report-section__header">
                    <h3 class="pg-report-section__title">{t("Output options")}</h3>
                    <p class="pg-report-section__description">
                      {t("Choose the language and page header/footer for the generated report.")}
                    </p>
                  </header>
                  <div class="pg-report-section__fields">
                    {availableLocales.value.length > 1 && (
                      <FormField
                        variant="filter"
                        label={t("Output language")}
                        hint={t("Choose the language used for the report text, headings and labels.")}
                      >
                        <VSelect
                          v-model={locale.value}
                          items={availableLocales.value}
                          density="compact"
                          variant="outlined"
                          hideDetails="auto"
                        />
                      </FormField>
                    )}
                    {selected.value.spec.page_layout.allow_runtime_chrome_selection && (
                      <>
                        <FormField
                          variant="filter"
                          label={t("Page header")}
                          hint={t("Choose the header used in the printed report.")}
                        >
                          <VSelect
                            v-model={headerMode.value}
                            items={chromeModeOptions()}
                            density="compact"
                            variant="outlined"
                            hideDetails="auto"
                          />
                        </FormField>
                        {headerMode.value === "SPECIFIC_CHROME_CODE" && (
                          <FormField
                            variant="filter"
                            label={t("Header template")}
                            hint={t("Choose the registered header template.")}
                          >
                            <VSelect
                              v-model={headerCode.value}
                              items={chromeCodeOptions("HEADER")}
                              density="compact"
                              variant="outlined"
                              hideDetails="auto"
                            />
                          </FormField>
                        )}
                        <FormField
                          variant="filter"
                          label={t("Page footer")}
                          hint={t("Choose the footer used in the printed report.")}
                        >
                          <VSelect
                            v-model={footerMode.value}
                            items={chromeModeOptions()}
                            density="compact"
                            variant="outlined"
                            hideDetails="auto"
                          />
                        </FormField>
                        {footerMode.value === "SPECIFIC_CHROME_CODE" && (
                          <FormField
                            variant="filter"
                            label={t("Footer template")}
                            hint={t("Choose the registered footer template.")}
                          >
                            <VSelect
                              v-model={footerCode.value}
                              items={chromeCodeOptions("FOOTER")}
                              density="compact"
                              variant="outlined"
                              hideDetails="auto"
                            />
                          </FormField>
                        )}
                      </>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </SlideOverDrawer>

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

function excelSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export default ReportsCatalogPage;
