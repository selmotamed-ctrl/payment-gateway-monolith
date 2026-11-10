import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCol, VFileInput, VRow, VSwitch } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { DescriptionList, MetaPill, MonoRef, PageHeader, SegmentedTabs, SlideOverDrawer, StatusBadge, SurfaceCard } from "@/components/ui";
import { ReportDiagnosticsPanel } from "@/components/reports/ReportDiagnosticsPanel";
import { JsonSpecEditor } from "@/components/reports/JsonSpecEditor";
import { ASSET_ZIP_TOO_LARGE_MESSAGE, diagnosticsFromApiError, friendlyApiErrorMessage } from "@/utils/reports/diagnostics";
import { downloadText, fileToBase64, isAssetZipTooLarge } from "@/utils/reports/jsonSpec";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { showConfirm } from "@/utils/confirm";
import { showSnackBar } from "@/utils/snackBar";
import { urlsMap } from "@/constants/urlsMap";
import {
  ReportSandboxedHtmlSurface,
  renderChromeHtml,
  type ReportChromeSpec,
  type ReportExecutionBundle,
} from "@/lib/reportEngineSdk";
import "@/components/reports/reports.css";

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
  /** Inlined only when the list is requested with `includeAssets=1`; keyed by `asset_key`. */
  assetDataUrls?: Record<string, string>;
  spec: ReportChromeSpec;
};

type ChromeRefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const pickFile = (files: File | File[] | null): File | null => (Array.isArray(files) ? (files[0] ?? null) : files);

const ReportsChromePage = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const busy = ref(false);
  const error = ref<string | null>(null);
  const diagnostics = ref<ReturnType<typeof diagnosticsFromApiError>>([]);
  const specJson = ref("");
  const specFile = ref<File | null>(null);
  const zipFile = ref<File | null>(null);
  const zipError = ref("");
  const publish = ref(true);
  const makeDefault = ref(false);
  /** Row loaded through "Edit" (drives the re-attach-zip hint). */
  const editingRow = ref<ChromeRow | null>(null);
  const previewRow = ref<ChromeRow | null>(null);
  const previewOpen = ref(false);
  const previewLocale = ref("en");
  const previewAssets = ref<Record<string, string>>({});
  const previewLoading = ref(false);
  const previewError = ref("");
  const chromeSearch = ref<string | null>(null);
  const chromePageSize = ref(20);
  const chromeRefresh = ref<ChromeRefreshHook | null>(null);
  const canAuthor = computed(() => hasOneOfAuthorities(["reports.studio", "report_engine:author"]));
  const canSave = computed(() => specJson.value.trim().length > 0 && !zipError.value);
  const editingNeedsZip = computed(
    () => Boolean(editingRow.value?.spec?.required_assets?.length) && !zipFile.value,
  );

  watch(zipFile, (file) => {
    zipError.value = isAssetZipTooLarge(file) ? t(ASSET_ZIP_TOO_LARGE_MESSAGE) : "";
  });

  const refresh = () => {
    chromeRefresh.value?.refreshAsIs();
  };

  const fail = (caught: unknown) => {
    diagnostics.value = diagnosticsFromApiError(caught);
    error.value = friendlyApiErrorMessage(caught, t);
  };
  const resetFeedback = () => {
    error.value = null;
    diagnostics.value = [];
  };

  const chromeHeaders = computed<TableHeader<ChromeRow>[]>(() => [
    {
      key: "name",
      label: t("Name"),
      sortKey: "name",
      Value: ({ row }) => (
        <div class="d-flex flex-column ga-1">
          <span class="font-weight-medium">{row.name}</span>
          <span class="d-inline-flex align-center ga-2">
            <MonoRef
              value={row.code}
              onCopied={() => showSnackBar({ message: t("Code copied"), type: "success" })}
            />
            <span class="pg-mono text-caption text-medium-emphasis">v{row.version}</span>
          </span>
        </div>
      ),
    },
    {
      key: "type",
      label: t("Type"),
      sortKey: "type",
      Value: ({ row }) => (
        <StatusBadge status={row.chromeType} label={row.chromeType === "HEADER" ? t("Header") : t("Footer")} toneOverride="info" />
      ),
    },
    {
      key: "status",
      label: t("Status"),
      sortKey: "status",
      Value: ({ row }) => (
        <div class="d-flex align-center ga-2 flex-wrap">
          <StatusBadge status={row.status} toneOverride={row.status === "PUBLISHED" ? "success" : undefined} />
          {row.isDefaultGlobal && <StatusBadge status="DEFAULT" label={t("Global Default")} toneOverride="success" />}
        </div>
      ),
    },
    {
      key: "locales",
      label: t("Languages"),
      value: (row) => row.supportedLocales.map((locale) => locale.toUpperCase()).join(", "),
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
            onClick: () => void openPreview(row),
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
    resetFeedback();
    try {
      const response = await api.get(urlsMap.reportEngineTranscript, { params: { kind: "CHROME" } });
      const data = response.data ?? {};
      downloadText(data.filename ?? "chrome-engine-ai-transcript-v1.0.md", data.markdown ?? "", "text/markdown");
    } catch (caught) {
      error.value = friendlyApiErrorMessage(caught, t);
    } finally {
      busy.value = false;
    }
  };

  const readSpecFile = async (file: File | null) => {
    specFile.value = file;
    if (file) {
      specJson.value = await file.text();
      editingRow.value = null;
    }
  };

  const clearEditor = () => {
    specJson.value = "";
    specFile.value = null;
    zipFile.value = null;
    editingRow.value = null;
    publish.value = true;
    makeDefault.value = false;
    resetFeedback();
  };

  const editRow = (row: ChromeRow) => {
    specJson.value = JSON.stringify(row.spec, null, 2);
    specFile.value = null;
    zipFile.value = null;
    editingRow.value = row;
    resetFeedback();
    // Saving creates the next version; editing a published row republishes by default.
    publish.value = row.status === "PUBLISHED";
    makeDefault.value = row.isDefaultGlobal;
    showSnackBar({ message: t("Loaded {name} into the editor", { name: row.name }), type: "success" });
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      showSnackBar({ message: t("Code copied"), type: "success" });
    } catch {
      showSnackBar({ message: t("Could not copy to the clipboard"), type: "error" });
    }
  };

  const downloadSpec = (row: ChromeRow) => {
    downloadText(`${row.code}-v${row.version}.json`, JSON.stringify(row.spec, null, 2), "application/json");
  };

  const saveChrome = async () => {
    if (!canSave.value) return;
    busy.value = true;
    resetFeedback();
    try {
      const assetsZipBase64 = zipFile.value ? await fileToBase64(zipFile.value) : undefined;
      const response = await api.post(urlsMap.reportEngineChrome, {
        specJson: specJson.value,
        assetsZipBase64,
        publish: publish.value,
        makeDefault: makeDefault.value,
      });
      const warnings = Array.isArray(response.data?.verification?.diagnostics) ? response.data.verification.diagnostics.length : 0;
      showSnackBar({
        message: warnings
          ? `${t("Header/footer spec saved")} · ${warnings} ${t("diagnostics")}`
          : t("Header/footer spec saved"),
        type: "success",
      });
      refresh();
    } catch (caught) {
      fail(caught);
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
    resetFeedback();
    try {
      await api.post(urlsMap.reportEngineChromeArchive(row.id), {});
      if (previewRow.value?.id === row.id) previewOpen.value = false;
      showSnackBar({ message: t("Header/footer archived"), type: "success" });
      refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      busy.value = false;
    }
  };

  const setDefault = async (row: ChromeRow, isDefault: boolean) => {
    busy.value = true;
    resetFeedback();
    try {
      await api.post(urlsMap.reportEngineChromeDefault(row.id), { isDefault });
      showSnackBar({ message: isDefault ? t("Global default updated") : t("Global default cleared"), type: "success" });
      refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      busy.value = false;
    }
  };

  // ---------- preview drawer ----------
  const openPreview = async (row: ChromeRow) => {
    previewRow.value = row;
    previewLocale.value = row.supportedLocales.includes("en") ? "en" : (row.supportedLocales[0] ?? "en");
    previewAssets.value = row.assetDataUrls ?? {};
    previewError.value = "";
    previewOpen.value = true;
    if (!row.assetBundleId || !row.spec.required_assets?.length) return;
    // The list omits asset data URLs unless asked for; fetch them for this row only.
    previewLoading.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineChrome, {
        params: { includeAssets: 1, includeArchived: "true", search: row.code, pageSize: 200 },
      });
      const match = ((response.data?.specs ?? []) as ChromeRow[]).find((candidate) => candidate.id === row.id);
      if (previewRow.value?.id === row.id && match?.assetDataUrls) previewAssets.value = match.assetDataUrls;
    } catch (caught) {
      previewError.value = friendlyApiErrorMessage(caught, t);
    } finally {
      previewLoading.value = false;
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
      assetDataUrls: previewAssets.value,
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

  const localeLabel = (locale: string) => (locale === "ar" ? t("Arabic") : locale === "en" ? t("English") : locale.toUpperCase());

  const renderPreview = (row: ChromeRow) => (
    <div class="d-flex flex-column ga-4">
      <SegmentedTabs
        modelValue={previewLocale.value}
        onUpdate:modelValue={(value: string) => (previewLocale.value = value)}
        ariaLabel={t("Preview language")}
        tabs={row.supportedLocales.map((locale) => ({ value: locale, label: localeLabel(locale) }))}
      />
      {previewError.value && <VAlert type="error" variant="tonal">{previewError.value}</VAlert>}
      {previewLoading.value ? (
        <div class="text-caption text-medium-emphasis">{t("Loading assets…")}</div>
      ) : (
        <ReportSandboxedHtmlSurface
          html={previewHtml(row)}
          css={row.spec.template.scoped_css}
          locale={previewLocale.value}
          minHeight={260}
        />
      )}
      <DescriptionList
        items={[
          { label: t("Code"), value: <MonoRef value={row.code} /> },
          { label: t("Version"), value: `v${row.version}` },
          { label: t("Locales"), value: row.supportedLocales.map((locale) => locale.toUpperCase()).join(", ") },
          { label: t("Variables"), value: row.spec.template.used_variables.join(", ") || "—" },
        ]}
      />
    </div>
  );

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Headers & Footers")}
          subtitle={t("Upload reusable bilingual chrome specs and assign the global default")}
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
          <VAlert type="error" variant="tonal" closable onClick:close={() => (error.value = null)}>
            {error.value}
          </VAlert>
        )}
        {diagnostics.value.length > 0 && (
          <ReportDiagnosticsPanel diagnostics={diagnostics.value} title={t("Action diagnostics")} />
        )}

        <SurfaceCard title={t("Chrome AI Transcript")} subtitle={t("Author headers and footers with the same closed contract")}>
          <VBtn color="primary" loading={busy.value} prependIcon="mdi-download" onClick={() => void downloadTranscript()}>
            {t("Download Header/Footer AI Transcript")}
          </VBtn>
        </SurfaceCard>

        <SurfaceCard
            title={t("Upload Chrome Spec")}
            subtitle={t("JSON + optional logo/seal .zip bundle")}
            v-slots={
              editingRow.value
                ? {
                    headerActions: () => (
                      <MetaPill prependIcon="mdi-pencil-outline">{`${editingRow.value?.code} v${editingRow.value?.version}`}</MetaPill>
                    ),
                  }
                : undefined
            }
          >
            <div class="d-flex flex-column ga-3">
              <VRow dense>
                <VCol cols={12} md={6}>
                  <VFileInput
                    label={t("Chrome spec (.json)")}
                    {...{ accept: "application/json,.json" }}
                    modelValue={specFile.value}
                    onUpdate:modelValue={(files: File | File[] | null) => void readSpecFile(pickFile(files))}
                  />
                </VCol>
                <VCol cols={12} md={6}>
                  <VFileInput
                    label={t("Logo/seal bundle (.zip, optional)")}
                    {...{ accept: "application/zip,.zip" }}
                    modelValue={zipFile.value}
                    errorMessages={zipError.value ? [zipError.value] : []}
                    onUpdate:modelValue={(files: File | File[] | null) => (zipFile.value = pickFile(files))}
                  />
                </VCol>
              </VRow>
              {editingNeedsZip.value && (
                <VAlert type="info" variant="tonal">
                  {t("This header/footer uses assets. Re-attach its logo/seal bundle (.zip); saving creates a new version and assets are not carried over.")}
                </VAlert>
              )}
              <JsonSpecEditor
                modelValue={specJson.value}
                onUpdate:modelValue={(value: string) => (specJson.value = value)}
                onClear={clearEditor}
                label={t("Chrome spec JSON")}
                downloadName={editingRow.value ? `${editingRow.value.code}.json` : "chrome-spec.json"}
                copiedMessage={t("Chrome JSON copied")}
              />
              <div class="d-flex flex-wrap ga-4 align-center">
                <VBtn color="primary" loading={busy.value} disabled={!canSave.value} onClick={() => void saveChrome()}>
                  {t("Verify & Save")}
                </VBtn>
                <VSwitch
                  label={t("Publish")}
                  color="primary"
                  hideDetails
                  modelValue={publish.value}
                  onUpdate:modelValue={(value: boolean | null) => (publish.value = Boolean(value))}
                />
                <VSwitch
                  label={t("Make default")}
                  color="primary"
                  hideDetails
                  modelValue={makeDefault.value}
                  onUpdate:modelValue={(value: boolean | null) => (makeDefault.value = Boolean(value))}
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

        <SlideOverDrawer
          modelValue={previewOpen.value}
          onUpdate:modelValue={(value: boolean) => (previewOpen.value = value)}
          title={previewRow.value?.name ?? t("Chrome preview")}
          subtitle={t("Preview the selected header or footer")}
          width={760}
        >
          {previewRow.value && renderPreview(previewRow.value)}
        </SlideOverDrawer>
      </ThemedView>
    </ScreenContainer>
  );
});

export default ReportsChromePage;
