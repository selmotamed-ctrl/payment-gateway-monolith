import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { ThemedView } from "@/components/ThemedView";
import { ApiTable } from "@/components/Table/ApiTable";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { FormModal, MetaPill, MonoRef, PageHeader, StatusBadge } from "@/components/ui";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { areChecklistsVisible } from "@/constants/env";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { xlsxUIPipeline } from "@/utils/xlsx";

type MerchantReportRow = {
  id: string;
  merchantId: string;
  merchantName: string;
  code: string;
  version: number;
  category: string;
  status: string;
  isLatestPublished: boolean;
  createdAt: string;
  publishedAt: string | null;
  studioSuspended: boolean;
};

type ExecutionRow = {
  id: string;
  merchantId: string;
  reportCode: string;
  reportVersion: number;
  actorUserId: string;
  actorRole: string;
  selectedLocale: string;
  rowCountTotal: number;
  durationMs: number;
  verificationSha256: string;
  createdAt: string;
};

const EXECUTION_EXPORT_CHECKS = [
  { key: "EXECUTION_SCOPE_VERIFIED", label: "Execution scope verified" },
  { key: "MERCHANT_DATA_REVIEWED", label: "Merchant report data reviewed" },
  { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const SUSPEND_CHECKS = [
  { key: "MERCHANT_SCOPE_VERIFIED", label: "Merchant report scope verified" },
  { key: "SUSPENSION_IMPACT_REVIEWED", label: "Suspension impact reviewed" },
  { key: "AUTHORITY_CONFIRMED", label: "Suspension authority confirmed" },
] as const;

const MerchantReportsPage = dc(() => {
  const { t } = useLocale();
  const executions = ref<ExecutionRow[]>([]);
  const executionsLoading = ref(false);
  const executionsMerchant = ref<MerchantReportRow | null>(null);
  const suspendTarget = ref<MerchantReportRow | null>(null);
  const suspendReason = ref("");
  const suspendError = ref("");
  const suspending = ref(false);
  const showChecklists = areChecklistsVisible();
  const suspendChecklist = ref<Record<string, boolean>>({});
  const executionExportOpen = ref(false);
  const executionExportLoading = ref(false);
  const executionExportChecklist = ref<Record<string, boolean>>({});
  const executionExportChecklistComplete = computed(() => !showChecklists || EXECUTION_EXPORT_CHECKS.every((check) => executionExportChecklist.value[check.key] === true));
  const suspendChecklistComplete = computed(() => !showChecklists || SUSPEND_CHECKS.every((check) => suspendChecklist.value[check.key] === true));
  const search = ref<string | null>(null);
  const oversightPageSize = ref(20);
  const catalogRefresh = ref<{ refreshAsIs: () => void } | null>(null);
  const canWrite = computed(() => hasOneOfAuthorities(["security:write"]));

  const loadExecutions = async (row: MerchantReportRow) => {
    executionsMerchant.value = row;
    executionsLoading.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineMerchantExecutions, {
        params: { merchantId: row.merchantId, limit: 200 },
      });
      executions.value = (response.data?.executions ?? []) as ExecutionRow[];
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      executionsLoading.value = false;
    }
  };

  const suspendStudio = async () => {
    if (!suspendTarget.value) return;
    if (suspendReason.value.trim().length < 5) {
      suspendError.value = t("Enter at least 5 characters");
      return;
    }
    if (!suspendChecklistComplete.value) {
      suspendError.value = t("Complete all suspension checklist items before continuing");
      return;
    }
    suspending.value = true;
    suspendError.value = "";
    try {
      await api.post(urlsMap.reportEngineMerchantSuspend(suspendTarget.value.merchantId), {
        reason: suspendReason.value.trim(),
        checklist: SUSPEND_CHECKS.filter((check) => suspendChecklist.value[check.key]).map((check) => check.key),
      });
      showSnackBar({ message: t("Merchant report studio suspended"), type: "success" });
      suspendTarget.value = null;
      suspendReason.value = "";
      catalogRefresh.value?.refreshAsIs();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      suspending.value = false;
    }
  };

  const exportExecutions = async () => {
    const merchant = executionsMerchant.value;
    if (!merchant || executionExportLoading.value) return;
    if (!executionExportChecklistComplete.value) {
      showSnackBar({ message: t("Complete all export checklist items before exporting"), type: "warning" });
      return;
    }
    executionExportLoading.value = true;
    try {
      const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const columns = ["id", "reportCode", "reportVersion", "actorUserId", "actorRole", "selectedLocale", "rowCountTotal", "durationMs", "createdAt"];
      const lines = [
        columns.map(escape).join(","),
        ...executions.value.map((row) => [
          row.id, row.reportCode, row.reportVersion, row.actorUserId, row.actorRole,
          row.selectedLocale, row.rowCountTotal, row.durationMs, row.createdAt,
        ].map(escape).join(",")),
      ];
      await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `merchant-report-executions-${merchant.merchantId}-${new Date().toISOString().slice(0, 10)}.xlsx`, lines });
      executionExportOpen.value = false;
      executionExportChecklist.value = {};
      showSnackBar({ message: t("Execution history exported"), type: "success" });
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      executionExportLoading.value = false;
    }
  };

  const resumeStudio = async (row: MerchantReportRow) => {
    try {
      await api.post(urlsMap.reportEngineMerchantResume(row.merchantId), {});
      showSnackBar({ message: t("Merchant report studio resumed"), type: "success" });
      catalogRefresh.value?.refreshAsIs();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    }
  };

  const headers = computed<TableHeader<MerchantReportRow>[]>(() => [
    {
      key: "merchant",
      label: t("Merchant"),
      sortKey: "merchant",
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.merchantName}</span>
          <MonoRef value={row.merchantId} truncate={12} />
        </div>
      ),
    },
    {
      key: "report",
      label: t("Report"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.code}</span>
          <span class="text-caption text-medium-emphasis">v{row.version}</span>
        </div>
      ),
    },
    { key: "category", label: t("Category"), value: (row) => row.category },
    {
      key: "status",
      label: t("Status"),
      Value: ({ row }) => (
        <div class="d-flex align-center ga-2">
          <StatusBadge status={row.status} />
          {row.isLatestPublished && <MetaPill color="success">{t("published")}</MetaPill>}
          {row.studioSuspended && <MetaPill color="error">{t("Studio suspended")}</MetaPill>}
        </div>
      ),
    },
    { key: "createdAt", label: t("Created"), value: (row) => new Date(row.createdAt).toLocaleString() },
    {
      key: "actions",
      label: t("Actions"),
      minWidth: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{ label: t("Executions"), icon: "mdi-history", onClick: () => void loadExecutions(row) }}
          items={[
            ...(!canWrite.value
              ? []
              : [
                  row.studioSuspended
                    ? {
                        key: "resume",
                        label: t("Resume Studio"),
                        icon: "mdi-play-circle-outline",
                        onClick: () => void resumeStudio(row),
                      }
                    : {
                        key: "suspend",
                        label: t("Suspend Studio"),
                        icon: "mdi-pause-circle-outline",
                        onClick: () => {
                          suspendTarget.value = row;
                          suspendReason.value = "";
                          suspendError.value = "";
                          suspendChecklist.value = {};
                        },
                      },
                ]),
          ]}
        />
      ),
    },
  ]);

  const executionHeaders = computed<TableHeader<ExecutionRow>[]>(() => [
    { key: "code", label: t("Report"), value: (row) => `${row.reportCode} v${row.reportVersion}` },
    { key: "actor", label: t("Actor"), value: (row) => `${row.actorRole} · ${row.actorUserId.slice(0, 8)}` },
    { key: "locale", label: t("Language"), value: (row) => row.selectedLocale.toUpperCase() },
    { key: "rows", label: t("Rows"), value: (row) => String(row.rowCountTotal) },
    { key: "duration", label: t("Duration"), value: (row) => `${row.durationMs} ms` },
    { key: "time", label: t("Time"), value: (row) => new Date(row.createdAt).toLocaleString() },
  ]);

  return () => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Merchant Report Studio oversight")}
          subtitle={t("Read merchant-authored reports and their executions; suspend the Studio when needed")}
        />

        <ApiTable<MerchantReportRow>
          title={t("Merchant-authored reports")}
          url={urlsMap.reportEngineMerchantReports}
          headers={headers.value}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={oversightPageSize.value}
          setNumberOfItemsPerPage={(value) => (oversightPageSize.value = value)}
          searchValue={search.value}
          setSearchValue={(value) => (search.value = value)}
          apiDataExtractor={(data) => (data as { reports?: MerchantReportRow[] }).reports ?? []}
          apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
          setRefreshHook={(hook) => (catalogRefresh.value = hook as { refreshAsIs: () => void })}
          clearRefreshHook={() => (catalogRefresh.value = null)}
          onRefresh={(table, refresh) =>
            void refresh({
              queryParams: {
                page: table.page,
                pageSize: oversightPageSize.value,
                ...(search.value ? { search: search.value } : {}),
                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
              },
            })
          }
        />

        {executionsMerchant.value && (
          <DataTable<ExecutionRow>
            title={t("Merchant report executions")}
            data={executions.value}
            headers={executionHeaders.value}
            loading={executionsLoading.value}
            showNumber={false}
            xlsx={false}
            numberOfItemsPerPage={50}
            numberOfItemsPerPageChoices={false}
            TopSlot={() => (
              <div class="px-5 pb-3 d-flex flex-wrap align-center ga-3">
                <span class="text-caption text-medium-emphasis">
                  {executionsMerchant.value?.merchantName} · {executionsMerchant.value?.merchantId}
                </span>
                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={executionExportLoading.value} onClick={() => { executionExportChecklist.value = {}; executionExportOpen.value = true; }}>
                  {t("Export executions")}
                </VBtn>
                <VBtn size="small" variant="tonal" prependIcon="mdi-refresh" loading={executionsLoading.value} onClick={() => void loadExecutions(executionsMerchant.value!)}>
                  {t("Refresh")}
                </VBtn>
              </div>
            )}
          />
        )}

        <FormModal
          modelValue={executionExportOpen.value}
          onUpdate:modelValue={(value: boolean) => (executionExportOpen.value = value)}
          title={t("Export merchant report executions")}
          size="md"
          loading={executionExportLoading.value}
          submitLabel={t("Export")}
          onSubmit={() => void exportExecutions()}
        >
          <FormChecklist
            checks={[...EXECUTION_EXPORT_CHECKS]}
            modelValue={executionExportChecklist.value}
            onUpdate:modelValue={(value: Record<string, boolean>) => (executionExportChecklist.value = value)}
            show={showChecklists}
            title={t("Execution export checklist")}
            complete={executionExportChecklistComplete.value}
            incompleteMessage={t("Complete all export checklist items before exporting")}
          />
        </FormModal>

        <FormModal
          modelValue={Boolean(suspendTarget.value)}
          onUpdate:modelValue={(value: boolean) => {
            if (!value) suspendTarget.value = null;
          }}
          title={t("Suspend the merchant report studio?")}
          subtitle={suspendTarget.value?.merchantName}
          size="sm"
          submitLabel={t("Suspend Studio")}
          loading={suspending.value}
          danger
          errorMessage={suspendError.value}
          onSubmit={() => void suspendStudio()}
        >
          <VTextarea
            modelValue={suspendReason.value}
            onUpdate:modelValue={(value: string) => {
              suspendReason.value = value;
              suspendError.value = "";
            }}
            label={t("Reason (recorded in the audit trail)")}
            rows={3}
            variant="outlined"
            autofocus
          />
          <FormChecklist
            checks={[...SUSPEND_CHECKS]}
            modelValue={suspendChecklist.value}
            onUpdate:modelValue={(value: Record<string, boolean>) => (suspendChecklist.value = value)}
            show={showChecklists}
            title={t("Suspension checklist")}
            complete={suspendChecklistComplete.value}
            incompleteMessage={t("Complete all suspension checklist items before continuing")}
          />
        </FormModal>
      </ThemedView>
    </ScreenContainer>
  );
});

export default MerchantReportsPage;
