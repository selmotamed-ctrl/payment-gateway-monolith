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
import { MetaPill, MonoRef, PageHeader, SegmentedTabs, StatusBadge } from "@/components/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { downloadText } from "@/utils/reports/jsonSpec";
import { showSnackBar } from "@/utils/snackBar";

type Compatibility = {
  status: "COMPATIBLE" | "NEEDS_MIGRATION" | "INVALID";
  reasonCode: string | null;
  message: string;
  storedEngineVersion: string | null;
  storedSpecVersion: string | null;
  currentEngineVersion: string;
  currentSpecVersion: string;
};

type MigrationRow = {
  id: string;
  source: "STAFF" | "MERCHANT";
  merchantId?: string | null;
  code: string;
  version: number;
  category: string;
  audienceScope: string;
  status: string;
  isLatestPublished: boolean;
  compatibility: Compatibility;
  updatedAt: string;
};

type RefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const Page = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const source = ref("ALL");
  const search = ref<string | null>(null);
  const pageSize = ref(20);
  const refreshHook = ref<RefreshHook | null>(null);
  const busy = ref(false);
  const canPrompt = computed(() =>
    hasOneOfAuthorities(["report_engine:author", "report:review", "report:approve", "security:write"]),
  );
  const canStudio = computed(() =>
    hasOneOfAuthorities(["reports.studio", "reports.draft", "report_engine:author", "report:review", "report:approve", "security:write"]),
  );

  const tabs = computed(() => [
    { label: t("All"), value: "ALL" },
    { label: t("Staff"), value: "STAFF" },
    { label: t("Merchant"), value: "MERCHANT" },
  ]);

  const promptUrl = (row: MigrationRow) =>
    row.source === "MERCHANT"
      ? urlsMap.reportEngineMerchantMigrationPrompt(row.id)
      : urlsMap.reportEngineSpecMigrationPrompt(row.id);

  const fetchPrompt = async (row: MigrationRow): Promise<{ filename: string; prompt: string } | null> => {
    busy.value = true;
    try {
      const response = await api.get(promptUrl(row));
      return {
        filename: String(response.data?.filename ?? `${row.code}-migration.prompt.md`),
        prompt: String(response.data?.prompt ?? ""),
      };
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
      return null;
    } finally {
      busy.value = false;
    }
  };

  const copyPrompt = async (row: MigrationRow) => {
    const result = await fetchPrompt(row);
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.prompt);
      showSnackBar({ message: t("Migration prompt copied"), type: "success" });
    } catch {
      showSnackBar({ message: t("Copy failed"), type: "error" });
    }
  };

  const downloadPrompt = async (row: MigrationRow) => {
    const result = await fetchPrompt(row);
    if (!result) return;
    downloadText(result.filename, result.prompt, "text/markdown");
  };

  const openStudio = (row: MigrationRow) => {
    if (row.source !== "STAFF") return;
    void router.push({ name: "ReportsStudio", query: { open: row.id, from: "migration" } });
  };

  const headers = computed<TableHeader<MigrationRow>[]>(() => [
    {
      key: "report",
      label: t("Report"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.code}</span>
          <span class="d-flex align-center ga-2">
            <MonoRef value={`${row.source.toLowerCase()} · v${row.version}`} copyable={false} />
            {row.merchantId && <MetaPill color="info">{row.merchantId}</MetaPill>}
          </span>
        </div>
      ),
    },
    { key: "category", label: t("Category"), value: (row) => row.category },
    { key: "audience", label: t("Audience"), value: (row) => row.audienceScope },
    {
      key: "status",
      label: t("Status"),
      Value: ({ row }) => <StatusBadge status={row.compatibility.status} toneOverride="danger" label={t("Needs migration")} />,
    },
    {
      key: "versions",
      label: t("Stored vs current"),
      Value: ({ row }) => (
        <div class="d-flex flex-column text-caption">
          <span>{t("Stored version")}: {row.compatibility.storedEngineVersion ?? "—"} / {row.compatibility.storedSpecVersion ?? "—"}</span>
          <span>{t("Current version")}: {row.compatibility.currentEngineVersion} / {row.compatibility.currentSpecVersion}</span>
        </div>
      ),
    },
    {
      key: "reason",
      label: t("Reason"),
      Value: ({ row }) => <span class="text-caption">{row.compatibility.reasonCode ?? row.compatibility.message}</span>,
    },
    { key: "updatedAt", label: t("Updated"), value: (row) => new Date(row.updatedAt).toLocaleString() },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{
            label: t("Copy migration prompt"),
            icon: "mdi-content-copy",
            disabled: busy.value || !canPrompt.value,
            onClick: () => void copyPrompt(row),
          }}
          items={[
            {
              key: "download",
              label: t("Download migration prompt"),
              icon: "mdi-download",
              disabled: !canPrompt.value,
              onClick: () => void downloadPrompt(row),
            },
            ...(row.source === "STAFF" && canStudio.value
              ? [{ key: "studio", label: t("Open in Studio"), icon: "mdi-robot-outline", onClick: () => openStudio(row) }]
              : []),
          ]}
        />
      ),
    },
  ]);

  const refresh = () => refreshHook.value?.refreshAsIs();

  const changeSource = (next: string) => {
    source.value = next;
    void refreshHook.value?.refresh({
      queryParams: {
        source: next,
        page: 1,
        pageSize: pageSize.value,
        ...(search.value ? { search: search.value } : {}),
      },
      nextSkip: 0,
    });
  };

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Reports Needing Migration")}
          subtitle={t("Stored reports that must be regenerated or migrated before they can run again")}
          badge="NEEDS_MIGRATION"
          badgeLabel={t("Needs migration")}
          badgeTone="danger"
          end={() => (
            <div class="d-flex flex-wrap ga-2">
              <VBtn variant="tonal" prependIcon="mdi-page-layout-header-footer" onClick={() => void router.push({ name: "ReportsChromeNeedsMigration" })}>
                {t("Headers & Footers migration")}
              </VBtn>
              <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refresh}>
                {t("Refresh")}
              </VBtn>
            </div>
          )}
        />
        <SegmentedTabs
          modelValue={source.value}
          onUpdate:modelValue={changeSource}
          tabs={tabs.value}
          ariaLabel={t("Source")}
        />
        <ApiTable<MigrationRow>
          title={t("Reports Needing Migration")}
          url={urlsMap.reportEngineNeedsMigration}
          headers={headers.value}
          rowColor={() => "var(--pg-status-danger-bg)"}
          localSearch={false}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={pageSize.value}
          setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
          searchValue={search.value}
          setSearchValue={(value) => (search.value = value)}
          apiDataExtractor={(data) => (data as { specs?: MigrationRow[] }).specs ?? []}
          apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
          setRefreshHook={(hook) => (refreshHook.value = hook as RefreshHook)}
          clearRefreshHook={() => (refreshHook.value = null)}
          onRefresh={(table, refreshTable) => {
            void refreshTable({
              queryParams: {
                source: source.value,
                page: table.page,
                pageSize: pageSize.value,
                ...(search.value ? { search: search.value } : {}),
              },
            });
          }}
        />
      </ThemedView>
    </ScreenContainer>
  );
});

export default Page;
