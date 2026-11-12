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
import { MonoRef, PageHeader, StatusBadge } from "@/components/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Row = {
  id: string;
  code: string;
  version: number;
  category: string;
  status: string;
  isLatestPublished: boolean;
  compatibility: {
    status: "NEEDS_MIGRATION" | "INVALID";
    reasonCode: string | null;
    message: string;
    storedEngineVersion: string | null;
    storedSpecVersion: string | null;
    currentEngineVersion: string;
    currentSpecVersion: string;
  };
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

  const copyPrompt = async (row: Row) => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineStudioSpecMigrationPrompt(row.id));
      await navigator.clipboard.writeText(String(response.data?.prompt ?? ""));
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
      const response = await api.get(urlsMap.reportEngineStudioSpecMigrationPrompt(row.id));
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

  const openStudio = (row: Row) => {
    void router.push({ name: "MerchantReportsStudio", query: { open: row.id, from: "migration" } });
  };

  const headers = computed<TableHeader<Row>[]>(() => [
    {
      key: "report",
      label: t("Report"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.code}</span>
          <MonoRef value={`v${row.version}`} copyable={false} />
        </div>
      ),
    },
    { key: "category", label: t("Category"), value: (row) => row.category },
    {
      key: "status",
      label: t("Status"),
      Value: ({ row }) => <StatusBadge status={row.compatibility.status} toneOverride="danger" label={t("Needs migration")} />,
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
            { key: "studio", label: t("Open in Studio"), icon: "mdi-robot-outline", onClick: () => openStudio(row) },
          ]}
        />
      ),
    },
  ]);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Reports Needing Migration")}
          subtitle={t("Your reports that must be regenerated or migrated before they can run again")}
          badge="NEEDS_MIGRATION"
          badgeLabel={t("Needs migration")}
          badgeTone="danger"
          end={() => (
            <div class="d-flex flex-wrap ga-2">
              <VBtn variant="tonal" prependIcon="mdi-palette-outline" onClick={() => void router.push({ name: "MerchantReportsChromeNeedsMigration" })}>
                {t("Headers & Footers migration")}
              </VBtn>
              <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => refreshHook.value?.refreshAsIs()}>
                {t("Refresh")}
              </VBtn>
            </div>
          )}
        />
        <ApiTable<Row>
          title={t("Reports Needing Migration")}
          url={urlsMap.reportEngineStudioNeedsMigration}
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
