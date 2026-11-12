import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { MetaPill, MonoRef, PageHeader, StatusBadge } from "@/components/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Row = {
  id: string;
  code: string;
  version: number;
  name: string;
  chromeType: "HEADER" | "FOOTER";
  status: string;
  isDefaultForMerchant: boolean;
  defaultRevokedAt: string | null;
  defaultRevokedReason: string | null;
  compatibility: {
    status: "NEEDS_MIGRATION" | "INVALID";
    reasonCode: string | null;
    message: string;
    storedEngineVersion: string | null;
    storedSpecVersion: string | null;
    currentEngineVersion: string;
    currentSpecVersion: string;
  };
  impactedReportCount: number;
  impactedReportCodes: string[];
};

type RefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const Page = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const search = ref<string | null>(null);
  const pageSize = ref(20);
  const refreshHook = ref<RefreshHook | null>(null);
  const busy = ref(false);

  const prompt = async (row: Row) => {
    const response = await api.get(urlsMap.reportEngineStudioChromeMigrationPrompt(row.id));
    return {
      filename: String(response.data?.filename ?? `${row.code}-migration.prompt.md`),
      prompt: String(response.data?.prompt ?? ""),
    };
  };

  const copyPrompt = async (row: Row) => {
    busy.value = true;
    try {
      const result = await prompt(row);
      await navigator.clipboard.writeText(result.prompt);
      showSnackBar({ message: t("Migration prompt copied"), type: "success" });
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const downloadPrompt = async (row: Row) => {
    busy.value = true;
    try {
      const result = await prompt(row);
      const blob = new Blob([result.prompt], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const open = (row: Row) => {
    void router.push({ name: "MerchantReportsChrome", query: { open: row.id, from: "migration" } });
  };

  const headers = computed<TableHeader<Row>[]>(() => [
    {
      key: "chrome",
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
        <div class="d-flex flex-column ga-1">
          <StatusBadge status={row.compatibility.status} toneOverride="danger" label={t("Needs migration")} />
          {row.defaultRevokedAt && <StatusBadge status="REVOKED" label={t("Default revoked")} toneOverride="warning" />}
          {row.defaultRevokedAt && <span class="text-caption">{t("Platform chrome is temporarily in use")}</span>}
        </div>
      ),
    },
    {
      key: "versions",
      label: t("Version"),
      Value: ({ row }) => (
        <span class="text-caption">
          {row.compatibility.storedEngineVersion ?? "—"} / {row.compatibility.storedSpecVersion ?? "—"} → {row.compatibility.currentEngineVersion} / {row.compatibility.currentSpecVersion}
        </span>
      ),
    },
    { key: "impact", label: t("Impacted reports"), value: (row) => `${row.impactedReportCount}: ${row.impactedReportCodes.join(", ")}` },
    { key: "reason", label: t("Reason"), value: (row) => row.compatibility.reasonCode ?? row.compatibility.message },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{ label: t("Copy migration prompt"), icon: "mdi-content-copy", onClick: () => void copyPrompt(row), disabled: busy.value }}
          items={[
            { key: "download", label: t("Download migration prompt"), icon: "mdi-download", onClick: () => void downloadPrompt(row) },
            { key: "open", label: t("Open in branding editor"), icon: "mdi-pencil-outline", onClick: () => open(row) },
          ]}
        />
      ),
    },
  ]);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Needs Migration")}
          subtitle={t("Migrate your branding header/footer to keep your company name and logo on reports")}
          badge="NEEDS_MIGRATION"
          badgeLabel={t("Needs migration")}
          badgeTone="danger"
          end={() => (
            <div class="d-flex flex-wrap ga-2">
              <VBtn variant="tonal" prependIcon="mdi-palette-outline" onClick={() => void router.push({ name: "MerchantReportsChrome" })}>
                {t("Report Branding")}
              </VBtn>
              <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => refreshHook.value?.refreshAsIs()}>
                {t("Refresh")}
              </VBtn>
            </div>
          )}
        />
        <ApiTable<Row>
          title={t("Needs migration")}
          url={urlsMap.reportEngineStudioChromeNeedsMigration}
          headers={headers.value}
          rowColor={() => "var(--pg-status-danger-bg)"}
          localSearch={false}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={pageSize.value}
          setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
          searchValue={search.value}
          setSearchValue={(value) => (search.value = value)}
          apiDataExtractor={(data) => (data as { specs?: Row[] }).specs ?? []}
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
