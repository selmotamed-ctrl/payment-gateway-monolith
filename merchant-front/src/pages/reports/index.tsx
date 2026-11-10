import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import type { TableHeader } from "@/components/Table/types";
import { PageHeader, SurfaceCard } from "@/components/ui";
import { api } from "@/state/api";
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

type MerchantReport = {
  id: string;
  code: string;
  version: number;
  category: string;
  audienceScope: string;
  supportedLocales: string[];
  defaultLocale: string;
  spec: ReportDescriptorSpec;
};

const MerchantReportsPage = dc(() => {
  const { t } = useLocale();
  const error = ref<string | null>(null);
  const search = ref<string | null>(null);
  const pageSize = ref(20);
  const selected = ref<MerchantReport | null>(null);
  const inputs = ref<Record<string, unknown>>({});
  const locale = ref("en");
  const generating = ref(false);
  const bundle = ref<ReportExecutionBundle | null>(null);
  const languagePrompt = ref(false);
  const previewRef = ref<{ printClientSideVectorPdf?: () => void } | null>(null);

  const availableLocales = computed(() =>
    selected.value ? Object.keys(selected.value.spec.i18n.locales) : ["en"],
  );
  const scopeKey = computed(() => selected.value?.spec.report.merchant_scope_input_key);
  const hiddenInputKeys = computed(() => (scopeKey.value ? [scopeKey.value] : []));
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

  const selectReport = (report: MerchantReport) => {
    selected.value = report;
    inputs.value = resolveInputDefaults(report.spec);
    locale.value = report.defaultLocale || "en";
    bundle.value = null;
    error.value = null;
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
    if (availableLocales.value.length > 1 && selected.value.spec.i18n.prompt_user_when_multi_locale !== false) {
      languagePrompt.value = true;
      return;
    }
    void runGenerate(locale.value);
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

  const reportHeaders = computed<TableHeader<MerchantReport>[]>(() => [
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
    { key: "languages", label: t("Languages"), value: (row) => row.supportedLocales.join(", ") },
    { key: "version", label: t("Version"), sortKey: "version", value: (row) => String(row.version) },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <VBtn size="small" variant="tonal" onClick={() => selectReport(row)}>
          {t("Run")}
        </VBtn>
      ),
    },
  ]);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
      <PageHeader
        title={t("Reports")}
        subtitle={t("Generate the reports available to your merchant account")}
        breadcrumbs={[{ label: t("Reports"), to: "/portal/reports" }]}
      />
      {error.value && <VAlert type="error" variant="tonal" density="compact">{error.value}</VAlert>}
      <ApiTable<MerchantReport>
        title={t("Available reports")}
        url={urlsMap.reportEngineCatalog}
        headers={reportHeaders.value}
        localSearch={false}
        xlsx={false}
        showNumber={true}
        numberOfItemsPerPage={pageSize.value}
        setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
        searchValue={search.value}
        setSearchValue={(value) => (search.value = value)}
        apiDataExtractor={(data) => (data as { reports?: MerchantReport[] }).reports ?? []}
        apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
        onRefresh={(table, refresh) => {
          void refresh({
            queryParams: {
              page: table.page,
              pageSize: pageSize.value,
              ...(search.value ? { search: search.value } : {}),
              ...(table.sortKey
                ? { sortKey: table.sortKey, sortDirection: table.sortDirection }
                : {}),
            },
          });
        }}
      />

      {selected.value && (
        <SurfaceCard
          class="mt-4"
          title={selected.value.spec.i18n.locales.en?.["report.title"] ?? selected.value.code}
          subtitle={t("Fill the parameters and generate the report")}
        >
          <div class="d-flex flex-column ga-4">
            <ReportInputForm
              spec={selected.value.spec}
              modelValue={inputs.value}
              autocomplete={autocomplete}
              hiddenInputKeys={hiddenInputKeys.value}
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
              <VBtn color="primary" loading={generating.value} onClick={requestGenerate}>
                {t("Generate Report")}
              </VBtn>
            </div>
          </div>
        </SurfaceCard>
      )}

      {bundle.value && (
        <SurfaceCard title={t("Paginated Vector Preview")} subtitle={t("Client-side rendering; no server CPU used")}>
          <div class="d-flex flex-wrap ga-2 mb-3">
            <VBtn size="small" variant="tonal" prependIcon="mdi-file-delimited-outline" onClick={exportCsv}>
              {t("Export CSV")}
            </VBtn>
            <VBtn size="small" variant="tonal" prependIcon="mdi-microsoft-excel" onClick={() => void exportXlsx()}>
              {t("Export XLSX")}
            </VBtn>
            <VBtn
              size="small"
              variant="tonal"
              prependIcon="mdi-printer-outline"
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
          onConfirmLocale={(chosen: string) => {
            locale.value = chosen;
            void runGenerate(chosen);
          }}
        />
      )}
      </ThemedView>
    </ScreenContainer>
  );
});

export default MerchantReportsPage;
