import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import {
  FormField,
  FormModal,
  MetaPill,
  MonoRef,
  PageHeader,
  SegmentedTabs,
  SlideOverDrawer,
  SurfaceCard,
} from "@/components/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiError, extractApiErrorMessage } from "@/utils/errors/extractor";
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

type MerchantReport = {
  id: string;
  code: string;
  version: number;
  category: string;
  audienceScope: string;
  supportedLocales: string[];
  defaultLocale: string;
  spec: ReportDescriptorSpec;
  source?: "OWN" | "TEMPLATE";
};

const MerchantReportsPage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const search = ref<string | null>(null);
  const pageSize = ref(20);
  const selected = ref<MerchantReport | null>(null);
  const inputs = ref<Record<string, unknown>>({});
  const locale = ref("en");
  const generating = ref(false);
  const bundle = ref<ReportExecutionBundle | null>(null);
  const languagePrompt = ref(false);
  const drawerOpen = ref(false);
  const previewRef = ref<{ printClientSideVectorPdf?: () => void } | null>(null);
  const inputFormRef = ref<{ validate?: () => boolean } | null>(null);
  const previewPages = ref(1);
  const cloneTarget = ref<MerchantReport | null>(null);
  const canStudio = computed(() => hasOneOfAuthorities(["reports.studio"]));
  const health = ref<{
    reportsBlockedByChrome?: number;
    ownReportsBlockedByChrome?: number;
    brokenReportSpecs?: number;
    brokenTemplateSpecs?: number;
    brokenChromeSpecs?: number;
  } | null>(null);
  const cloneCode = ref("");
  const cloning = ref(false);

  const availableLocales = computed(() =>
    selected.value ? Object.keys(selected.value.spec.i18n.locales) : ["en"],
  );
  const scopeKey = computed(() => selected.value?.spec.report.merchant_scope_input_key);
  const hiddenInputKeys = computed(() => (scopeKey.value ? [scopeKey.value] : []));
  const startClone = (report: MerchantReport) => {
    cloneTarget.value = report;
    cloneCode.value = `${report.code}-mine`.slice(0, 64);
  };

  const cloneTemplate = async () => {
    if (!cloneTarget.value || cloneCode.value.trim().length === 0) return;
    cloning.value = true;
    try {
      const response = await api.post(urlsMap.reportEngineStudioClone(cloneTarget.value.code), {
        code: cloneCode.value.trim(),
      });
      const id = String(response.data?.id ?? "");
      cloneTarget.value = null;
      showSnackBar({ message: t("Template cloned into your Studio"), type: "success" });
      if (id) {
        await router.push({ name: "MerchantReportsStudio", query: { open: id } });
      }
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      cloning.value = false;
    }
  };

  const localizedTitle = (report: MerchantReport): string =>
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
  const hasRows = computed(() =>
    bundle.value ? Object.values(bundle.value.datasets).some((rows) => rows.length > 0) : false,
  );

  const selectReport = (report: MerchantReport) => {
    selected.value = report;
    inputs.value = resolveInputDefaults(report.spec);
    locale.value = report.defaultLocale || "en";
    bundle.value = null;
    previewPages.value = 1;
    drawerOpen.value = true;
  };

  const resetInputs = () => {
    if (!selected.value) return;
    inputs.value = resolveInputDefaults(selected.value.spec);
  };

  const friendlyError = (caught: unknown): string => {
    const extracted = extractApiError(caught);
    if (extracted?.code === "REPORT_NOT_PUBLISHED" || extracted?.code === "REPORT_NOT_FOUND") {
      return t("This report is not available right now. Refresh the list or contact the operator.");
    }
    if (extracted?.code === "REPORT_NEEDS_MIGRATION" || extracted?.code === "REPORT_SPEC_INVALID") {
      return t("This report needs migration. Open the migration page, copy the prompt, and save a migrated version.");
    }
    if (extracted?.code === "REPORT_CHROME_NEEDS_MIGRATION" || extracted?.code === "REPORT_CHROME_DEFAULT_MISSING") {
      return t("This report's header/footer is temporarily unavailable. The platform is being updated.");
    }
    if (extracted?.status === 403) {
      return t("You do not have permission to run this report.");
    }
    return extractApiErrorMessage(caught) || (caught instanceof Error ? caught.message : String(caught));
  };

  const loadHealth = async () => {
    try {
      const response = await api.get(urlsMap.reportEngineCatalog, { params: { page: 1, pageSize: 1 } });
      health.value = (response.data?.health ?? null) as typeof health.value;
    } catch {
      health.value = null;
    }
  };

  onMounted(() => {
    void loadHealth();
  });

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
    if (inputFormRef.value?.validate && !inputFormRef.value.validate()) {
      showSnackBar({ message: t("Fix the highlighted inputs before generating"), type: "warning" });
      return;
    }
    generating.value = true;
    try {
      const response = await api.post(urlsMap.reportEngineExecute(selected.value.code), {
        inputs: inputs.value,
        locale: chosenLocale,
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
            record[column.field] = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
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

  const reportHeaders = computed<TableHeader<MerchantReport>[]>(() => [
    {
      key: "report",
      label: t("Report"),
      sortKey: "report",
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{localizedTitle(row)}</span>
          <div class="d-flex align-center ga-2">
            <MonoRef value={row.code} copyable={false} />
            <MetaPill size="x-small" color={row.source === "OWN" ? "success" : "info"}>
              {row.source === "OWN" ? t("Mine") : t("Template")}
            </MetaPill>
          </div>
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
        <TableRowActions
          primaryAction={{ label: t("Run"), icon: "mdi-play", onClick: () => selectReport(row) }}
          items={[
            {
              key: "copy",
              label: t("Copy code"),
              icon: "mdi-content-copy",
              onClick: () => {
                void navigator.clipboard.writeText(row.code).then(
                  () => showSnackBar({ message: t("Code copied"), type: "success" }),
                  () => showSnackBar({ message: t("Copy failed"), type: "error" }),
                );
              },
            },
            ...(row.source === "TEMPLATE"
              ? [
                  {
                    key: "clone",
                    label: t("Clone template"),
                    icon: "mdi-content-duplicate",
                    onClick: () => startClone(row),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ]);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Reports")}
          subtitle={t("Generate the reports available to your merchant account")}
        />

        {((health.value?.reportsBlockedByChrome ?? 0) > 0 ||
          (health.value?.brokenReportSpecs ?? 0) > 0 ||
          (health.value?.brokenTemplateSpecs ?? 0) > 0) && (
          <VAlert type="warning" variant="tonal">
            <div class="d-flex flex-wrap align-center ga-3">
              <span>{t("Some reports are temporarily unavailable while platform templates are updated")}</span>
              {canStudio.value && (health.value?.brokenReportSpecs ?? 0) > 0 && (
                <VBtn size="small" variant="text" onClick={() => void router.push({ name: "MerchantReportsNeedsMigration" })}>
                  {t("Reports Needing Migration")}
                </VBtn>
              )}
              {canStudio.value && (health.value?.ownReportsBlockedByChrome ?? 0) > 0 && (
                <VBtn size="small" variant="text" onClick={() => void router.push({ name: "MerchantReportsChromeNeedsMigration" })}>
                  {t("Headers & Footers migration")}
                </VBtn>
              )}
            </div>
          </VAlert>
        )}

        {bundle.value && selected.value && (
          <SurfaceCard
            title={t("Paginated Vector Preview")}
            subtitle={t("Client-side rendering; no server CPU used")}
            v-slots={{
              headerActions: () => (
                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <MetaPill color="info">{`${previewPages.value} ${t("pages")}`}</MetaPill>
                  {bundle.value?.chromeFallbackUsed && <MetaPill color="warning">{t("Platform chrome is temporarily in use")}</MetaPill>}
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

        <SlideOverDrawer
          modelValue={drawerOpen.value}
          onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)}
          title={selected.value ? localizedTitle(selected.value) : t("Run report")}
          subtitle={t("Fill the parameters and generate the report")}
          width={720}
          v-slots={{
            footer: () =>
              selected.value ? (
                <div class="pg-report-actions">
                  <div class="pg-report-actions__secondary">
                    <VBtn variant="text" onClick={resetInputs}>{t("Reset inputs")}</VBtn>
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
                hiddenInputKeys={hiddenInputKeys.value}
                translate={specT.value}
                onUpdate:modelValue={(value: Record<string, unknown>) => (inputs.value = value)}
              />
              {availableLocales.value.length > 1 && (
                <section class="pg-report-section">
                  <header class="pg-report-section__header">
                    <h3 class="pg-report-section__title">{t("Output options")}</h3>
                    <p class="pg-report-section__description">
                      {t("Choose the language used for the report text, headings and labels.")}
                    </p>
                  </header>
                  <div class="pg-report-section__fields">
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
                  </div>
                </section>
              )}
            </div>
          )}
        </SlideOverDrawer>

        <FormModal
          modelValue={Boolean(cloneTarget.value)}
          onUpdate:modelValue={(value: boolean) => {
            if (!value) cloneTarget.value = null;
          }}
          title={t("Clone this template into your Studio?")}
          subtitle={cloneTarget.value ? localizedTitle(cloneTarget.value) : ""}
          size="sm"
          submitLabel={t("Clone template")}
          loading={cloning.value}
          onSubmit={() => void cloneTemplate()}
        >
          <VTextField
            modelValue={cloneCode.value}
            onUpdate:modelValue={(value: string) => (cloneCode.value = value.slice(0, 64))}
            label={t("New report code")}
            hint={t("Lower-case letters, digits and dashes; up to 64 characters")}
            variant="outlined"
          />
        </FormModal>

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
