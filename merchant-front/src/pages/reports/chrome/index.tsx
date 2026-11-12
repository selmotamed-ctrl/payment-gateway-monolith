import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VCol, VFileInput, VRow, VSwitch, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { MetaPill, MonoRef, PageHeader, SegmentedTabs, StatusBadge, SurfaceCard } from "@/components/ui";
import { ReportSandboxedHtmlSurface } from "@/lib/reportEngineSdk";
import { renderChromeHtml, type ReportChromeSpec, type ReportExecutionBundle } from "@/lib/reportEngineSdk";
import { api } from "@/state/api";
import { user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";

type MerchantChromeRow = {
  id: string;
  code: string;
  version: number;
  name: string;
  chromeType: "HEADER" | "FOOTER";
  status: string;
  isDefaultForMerchant: boolean;
  defaultRevokedAt?: string | null;
  defaultRevokedReason?: string | null;
  compatibility?: { status: "COMPATIBLE" | "NEEDS_MIGRATION" | "INVALID"; reasonCode: string | null; message: string };
  supportedLocales: string[];
  assetDataUrls?: Record<string, string>;
  spec: ReportChromeSpec;
};

type RefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const pickFile = (files: File | File[] | null): File | null => (Array.isArray(files) ? (files[0] ?? null) : files);
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the file"));
    reader.readAsDataURL(file);
  });

const Page = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const route = useRoute();
  const busy = ref(false);
  const specJson = ref("");
  const zipFile = ref<File | null>(null);
  const publish = ref(true);
  const makeDefault = ref(false);
  const editingRow = ref<MerchantChromeRow | null>(null);
  const migrationOpen = ref(false);
  const search = ref<string | null>(null);
  const pageSize = ref(20);
  const refreshHook = ref<RefreshHook | null>(null);
  const previewRow = ref<MerchantChromeRow | null>(null);
  const previewLocale = ref("en");

  const canSave = computed(() => specJson.value.trim().length > 0);
  const editingNeedsZip = computed(() => Boolean(editingRow.value?.spec?.required_assets?.length) && !zipFile.value);

  const readFile = async (file: File | null) => {
    if (!file) return;
    specJson.value = await file.text();
    editingRow.value = null;
  };

  const clearEditor = () => {
    specJson.value = "";
    zipFile.value = null;
    editingRow.value = null;
    migrationOpen.value = false;
    publish.value = true;
    makeDefault.value = false;
  };

  const downloadTranscript = async () => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioChromeTranscript);
      const markdown = String(response.data?.markdown ?? "");
      const filename = String(response.data?.filename ?? "merchant-chrome-transcript.md");
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

  const save = async (publishNow: boolean) => {
    if (!canSave.value) return;
    busy.value = true;
    try {
      const response = await api.post(urlsMap.reportEngineStudioChrome, {
        specJson: specJson.value,
        assetsZipBase64: zipFile.value ? await fileToBase64(zipFile.value) : undefined,
        publish: publishNow,
        makeDefault: makeDefault.value,
      });
      showSnackBar({ message: t("Header/footer saved"), type: "success" });
      editingRow.value = { ...(editingRow.value ?? {}), id: String(response.data?.id ?? "") } as MerchantChromeRow;
      migrationOpen.value = false;
      refreshHook.value?.refreshAsIs();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const openRow = async (row: MerchantChromeRow) => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioChromeDetail(row.id));
      const detail = response.data as MerchantChromeRow;
      editingRow.value = detail;
      previewRow.value = detail.compatibility && detail.compatibility.status !== "COMPATIBLE" ? null : detail;
      previewLocale.value = detail.supportedLocales.includes("en") ? "en" : (detail.supportedLocales[0] ?? "en");
      specJson.value = JSON.stringify(detail.spec ?? {}, null, 2);
      zipFile.value = null;
      publish.value = detail.status === "PUBLISHED";
      makeDefault.value = detail.isDefaultForMerchant || Boolean(detail.defaultRevokedAt);
      migrationOpen.value =
        route.query.from === "migration" ||
        Boolean(detail.compatibility && detail.compatibility.status !== "COMPATIBLE");
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const setDefault = async (row: MerchantChromeRow, value: boolean) => {
    busy.value = true;
    try {
      await api.post(urlsMap.reportEngineStudioChromeDefault(row.id), { isDefault: value });
      showSnackBar({ message: t("Default updated"), type: "success" });
      refreshHook.value?.refreshAsIs();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const archiveRow = async (row: MerchantChromeRow) => {
    const confirmed = await showConfirm({
      title: t("Archive"),
      message: `${row.name} v${row.version}`,
      submitButtonLabel: t("Archive"),
      type: "error",
    });
    if (!confirmed) return;
    busy.value = true;
    try {
      await api.post(urlsMap.reportEngineStudioChromeArchive(row.id), {});
      showSnackBar({ message: t("Header/footer archived"), type: "success" });
      refreshHook.value?.refreshAsIs();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const copyMigrationPrompt = async (row: MerchantChromeRow) => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioChromeMigrationPrompt(row.id));
      await navigator.clipboard.writeText(String(response.data?.prompt ?? ""));
      showSnackBar({ message: t("Migration prompt copied"), type: "success" });
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const downloadMigrationPrompt = async (row: MerchantChromeRow) => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioChromeMigrationPrompt(row.id));
      const blob = new Blob([String(response.data?.prompt ?? "")], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = String(response.data?.filename ?? `${row.code}-migration.prompt.md`);
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const headers = computed<TableHeader<MerchantChromeRow>[]>(() => [
    {
      key: "name",
      label: t("Name"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.name}</span>
          <span class="d-flex align-center ga-2">
            <MonoRef value={`${row.code} · v${row.version}`} copyable={false} />
            <MetaPill color={row.chromeType === "HEADER" ? "info" : "neutral"}>{row.chromeType === "HEADER" ? t("Header") : t("Footer")}</MetaPill>
          </span>
        </div>
      ),
    },
    {
      key: "status",
      label: t("Status"),
      Value: ({ row }) => (
        <div class="d-flex align-center ga-2 flex-wrap">
          <StatusBadge status={row.status} />
          {row.isDefaultForMerchant && <StatusBadge status="DEFAULT" label={row.chromeType === "HEADER" ? t("Default header") : t("Default footer")} toneOverride="success" />}
          {row.compatibility && row.compatibility.status !== "COMPATIBLE" && (
            <StatusBadge status={row.compatibility.status} toneOverride="danger" label={t("Needs migration")} />
          )}
          {row.defaultRevokedAt && <StatusBadge status="REVOKED" label={t("Default revoked")} toneOverride="warning" />}
        </div>
      ),
    },
    { key: "locales", label: t("Languages"), value: (row) => row.supportedLocales.map((entry) => entry.toUpperCase()).join(", ") },
    { key: "version", label: t("Version"), value: (row) => `v${row.version}` },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{
            label:
              row.compatibility && row.compatibility.status !== "COMPATIBLE"
                ? t("Migrate and restore default")
                : t("Edit"),
            icon: "mdi-pencil-outline",
            onClick: () => void openRow(row),
          }}
          items={[
            { key: "default", label: row.isDefaultForMerchant ? t("Clear default") : t("Set default"), icon: "mdi-star-outline", disabled: row.status !== "PUBLISHED" || Boolean(row.compatibility && row.compatibility.status !== "COMPATIBLE"), onClick: () => void setDefault(row, !row.isDefaultForMerchant) },
            { key: "archive", label: t("Archive"), icon: "mdi-archive-outline", danger: true, onClick: () => void archiveRow(row) },
            ...(row.compatibility && row.compatibility.status !== "COMPATIBLE"
              ? [{ key: "prompt", label: t("Copy migration prompt"), icon: "mdi-content-copy", onClick: () => void copyMigrationPrompt(row) }]
              : []),
          ]}
        />
      ),
    },
  ]);

  const sampleBundle = (row: MerchantChromeRow): ReportExecutionBundle => ({
    executionId: "merchant-chrome-preview",
    executedAtIso: new Date().toISOString(),
    verificationSha256: "preview",
    spec: {
      spec_kind: "REPORT_DESCRIPTOR",
      spec_version: "1.0",
      report: { code: "branding-preview", version: 1, category: "MERCHANT_SETTLEMENT", audience_scope: "MERCHANT_FACING", classification: "INTERNAL" },
      page_layout: { paper_size: "A4", orientation: "PORTRAIT", margins_mm: { top: 20, right: 14, bottom: 18, left: 14 }, header_mode: "NONE", footer_mode: "NONE", allow_runtime_chrome_selection: false, global_scoped_css: "" },
      required_assets: [],
      i18n: { default_locale: "en", prompt_user_when_multi_locale: false, locales: { en: { "report.title": "Merchant Statement" }, ar: { "report.title": "كشف التاجر" } } },
      datasets: [],
      transforms: [],
      sections: [],
    } as never,
    resolvedHeaderChrome: row.chromeType === "HEADER" ? row.spec : null,
    resolvedFooterChrome: row.chromeType === "FOOTER" ? row.spec : null,
    datasets: {},
    assetDataUrls: row.assetDataUrls ?? {},
    actor: { name: "Merchant", email: "", role: "MERCHANT_ADMIN" },
    institutionName: "Libyan National Payment Gateway",
    chromeVariables: {
      merchantTradeName: String(user.value?.userInfo?.merchantTradeName ?? "Your company"),
      merchantLegalName: String(user.value?.userInfo?.merchantTradeName ?? "Your company"),
      merchantDisplayName: String(user.value?.userInfo?.merchantTradeName ?? "Your company"),
    },
    inputsUsed: {},
    rowCountTotal: 0,
    durationMs: 0,
    servedByNode: "preview",
    previewMode: "MOCK",
  });

  const previewHtml = (row: MerchantChromeRow) =>
    `<div class="mc-preview"><h1>Merchant statement</h1><p>Your company header and footer appear on every page.</p></div>`;

  onMounted(() => {
    const open = typeof route.query.open === "string" ? route.query.open : "";
    if (open) {
      void openRow({ id: open } as MerchantChromeRow);
    }
  });

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Report Branding")}
          subtitle={t("Upload a logo and add your company name to your reports")}
          end={() => (
            <div class="d-flex flex-wrap ga-2">
              <VBtn variant="tonal" prependIcon="mdi-alert-decagram-outline" onClick={() => void router.push({ name: "MerchantReportsChromeNeedsMigration" })}>
                {t("Needs Migration")}
              </VBtn>
              <VBtn variant="tonal" prependIcon="mdi-download" loading={busy.value} onClick={() => void downloadTranscript()}>
                {t("Download branding transcript")}
              </VBtn>
            </div>
          )}
        />

        {migrationOpen.value && editingRow.value && (
          <VAlert type="warning" variant="tonal">
            {t("Your default header/footer needs migration")}: {editingRow.value.code} v{editingRow.value.version}
          </VAlert>
        )}

        <SurfaceCard title={t("My Headers & Footers")} subtitle={t("Manage your company header and footer for your own reports")}>
          <div class="d-flex flex-column ga-3">
            <VRow dense>
              <VCol cols={12} md={6}>
                <VFileInput label={t("Header/footer spec (.json)")} {...{ accept: "application/json,.json" }} modelValue={null} onUpdate:modelValue={(files: File | File[] | null) => void readFile(pickFile(files))} />
              </VCol>
              <VCol cols={12} md={6}>
                <VFileInput label={t("Logo bundle (.zip, optional)")} {...{ accept: "application/zip,.zip" }} modelValue={zipFile.value} onUpdate:modelValue={(files: File | File[] | null) => (zipFile.value = pickFile(files))} />
              </VCol>
            </VRow>
            {editingNeedsZip.value && <VAlert type="info" variant="tonal">{t("This header/footer uses assets. Re-attach its logo bundle (.zip).")}</VAlert>}
            <VTextarea
              label={t("Header/footer spec (.json)")}
              modelValue={specJson.value}
              onUpdate:modelValue={(value: string) => (specJson.value = value)}
              rows={18}
              variant="outlined"
              class="pg-mono"
            />
            <div class="d-flex flex-wrap ga-2">
              <VBtn size="small" variant="text" onClick={clearEditor}>{t("Clear editor")}</VBtn>
            </div>
            <div class="d-flex flex-wrap ga-4 align-center">
              <VBtn color="primary" loading={busy.value} disabled={!canSave.value} onClick={() => void save(publish.value)}>
                {t("Verify & save header/footer")}
              </VBtn>
              <VSwitch label={t("Publish")} hideDetails color="primary" modelValue={publish.value} onUpdate:modelValue={(value: boolean | null) => (publish.value = Boolean(value))} />
              <VSwitch label={t("Make default")} hideDetails color="primary" disabled={!publish.value} modelValue={makeDefault.value} onUpdate:modelValue={(value: boolean | null) => (makeDefault.value = Boolean(value))} />
            </div>
          </div>
        </SurfaceCard>

        {previewRow.value && (
          <SurfaceCard title={t("Preview")} subtitle={previewRow.value.name}>
            <div class="d-flex flex-column ga-3">
              <SegmentedTabs
                modelValue={previewLocale.value}
                onUpdate:modelValue={(value: string) => (previewLocale.value = value)}
                tabs={previewRow.value.supportedLocales.map((locale) => ({
                  label: locale.toUpperCase(),
                  value: locale,
                }))}
                ariaLabel={t("Preview")}
              />
              <ReportSandboxedHtmlSurface
                html={renderChromeHtml({ chrome: previewRow.value.spec, bundle: sampleBundle(previewRow.value), locale: previewLocale.value }) || previewHtml(previewRow.value)}
                css={previewRow.value.spec.template.scoped_css}
                locale={previewLocale.value}
                minHeight={260}
              />
            </div>
          </SurfaceCard>
        )}

        <ApiTable<MerchantChromeRow>
          title={t("My Headers & Footers")}
          url={urlsMap.reportEngineStudioChrome}
          headers={headers.value}
          rowColor={(row) => (row.compatibility && row.compatibility.status !== "COMPATIBLE" ? "var(--pg-status-danger-bg)" : undefined)}
          localSearch={false}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={pageSize.value}
          setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
          searchValue={search.value}
          setSearchValue={(value) => (search.value = value)}
          apiDataExtractor={(data) => (data as { specs?: MerchantChromeRow[] }).specs ?? []}
          apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
          setRefreshHook={(hook) => (refreshHook.value = hook as RefreshHook)}
          clearRefreshHook={() => (refreshHook.value = null)}
          onRefresh={(table, refreshTable) => {
            void refreshTable({ queryParams: { page: table.page, pageSize: pageSize.value, ...(search.value ? { search: search.value } : {}) } });
          }}
        />
      </ThemedView>
    </ScreenContainer>
  );
});

export default Page;
