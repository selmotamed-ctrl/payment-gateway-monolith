import { dc } from "@/utils/dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRouter } from "vue-router";
import {PgAlert, PgButton, PgStack} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {FormModal} from "@pg/ui";
import { areChecklistsVisible } from "@/constants/env";
import {PgPage as ScreenContainer} from "@pg/ui";
import {ApiTable} from "@pg/ui";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import {MetaPill, MonoRef, PageHeader, StatusBadge} from "@pg/ui";
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

type ChromeMigrationRow = {
  id: string;
  code: string;
  version: number;
  name: string;
  chromeType: "HEADER" | "FOOTER";
  status: string;
  isDefaultGlobal: boolean;
  defaultRevokedAt: string | null;
  defaultRevokedReason: string | null;
  defaultState: "ACTIVE" | "MISSING" | "REVOKED" | "NONE";
  compatibility: Compatibility;
  impactedReportCount: number;
  impactedReportCodes: string[];
};

type RefreshHook = {
  refresh: (props: { queryParams?: Record<string, unknown>; nextSkip: number }) => Promise<void>;
  refreshAsIs: () => void;
};

const RECONCILE_CHECKS = [
  { key: "CHROME_SCOPE_VERIFIED", label: "Chrome default scope verified" },
  { key: "IMPACTED_REPORTS_REVIEWED", label: "Impacted reports reviewed" },
  { key: "AUTHORITY_CONFIRMED", label: "Reconciliation authority confirmed" },
] as const;

const Page = dc(() => {
  const { t } = useLocale();
  const router = useRouter();
  const search = ref<string | null>(null);
  const pageSize = ref(20);
  const refreshHook = ref<RefreshHook | null>(null);
  const busy = ref(false);
  const showChecklists = areChecklistsVisible();
  const reconcileOpen = ref(false);
  const reconcileChecklist = ref<Record<string, boolean>>({});
  const reconcileChecklistComplete = computed(() => !showChecklists || RECONCILE_CHECKS.every((check) => reconcileChecklist.value[check.key] === true));
  const canPrompt = computed(() =>
    hasOneOfAuthorities(["report_engine:author", "report:review", "report:approve", "security:write"]),
  );
  const defaults = ref<{ header: "ACTIVE" | "REVOKED" | "MISSING"; footer: "ACTIVE" | "REVOKED" | "MISSING" } | null>(null);
  const canReconcile = computed(() => hasOneOfAuthorities(["report:approve", "security:write"]));
  const canOpenChrome = computed(() => hasOneOfAuthorities(["reports.studio", "report:approve", "security:write"]));

  const loadDefaults = async () => {
    try {
      const response = await api.get(urlsMap.reportEngineChromeNeedsMigration, {
        params: { page: 1, pageSize: 1 },
      });
      defaults.value = response.data?.defaults ?? null;
    } catch {
      defaults.value = null;
    }
  };

  const defaultIssues = computed(() => {
    if (!defaults.value) return [] as string[];
    const issues: string[] = [];
    if (defaults.value.header !== "ACTIVE") {
      issues.push(`${t("Header")}: ${defaults.value.header === "REVOKED" ? t("Default revoked") : t("No global default configured")}`);
    }
    if (defaults.value.footer !== "ACTIVE") {
      issues.push(`${t("Footer")}: ${defaults.value.footer === "REVOKED" ? t("Default revoked") : t("No global default configured")}`);
    }
    return issues;
  });

  const refreshAll = () => {
    void loadDefaults();
    refreshHook.value?.refreshAsIs();
  };

  const fetchPrompt = async (row: ChromeMigrationRow): Promise<{ filename: string; prompt: string } | null> => {
    busy.value = true;
    try {
      const response = await api.get(urlsMap.reportEngineChromeMigrationPrompt(row.id));
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

  const copyPrompt = async (row: ChromeMigrationRow) => {
    const result = await fetchPrompt(row);
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.prompt);
      showSnackBar({ message: t("Migration prompt copied"), type: "success" });
    } catch {
      showSnackBar({ message: t("Copy failed"), type: "error" });
    }
  };

  const downloadPrompt = async (row: ChromeMigrationRow) => {
    const result = await fetchPrompt(row);
    if (!result) return;
    downloadText(result.filename, result.prompt, "text/markdown");
  };

  const openStudio = (row: ChromeMigrationRow) => {
    void router.push({ name: "ReportsChrome", query: { open: row.id, from: "migration" } });
  };

  const reconcile = async () => {
    if (!reconcileChecklistComplete.value) {
      showSnackBar({ message: t("Complete all reconciliation checklist items before continuing"), type: "warning" });
      return;
    }
    busy.value = true;
    try {
      await api.post(urlsMap.reportEngineChromeReconcile, {
        checklist: RECONCILE_CHECKS.filter((check) => reconcileChecklist.value[check.key]).map((check) => check.key),
      });
      reconcileOpen.value = false;
      showSnackBar({ message: t("Default reconciliation complete"), type: "success" });
      refreshAll();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      busy.value = false;
    }
  };

  const headers = computed<TableHeader<ChromeMigrationRow>[]>(() => [
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
          {row.defaultState === "REVOKED" && <StatusBadge status="REVOKED" toneOverride="warning" label={t("Default revoked")} />}
          {row.defaultState === "MISSING" && <StatusBadge status="MISSING" toneOverride="warning" label={t("No global default configured")} />}
        </div>
      ),
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
      key: "impact",
      label: t("Impacted reports"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span>{row.impactedReportCount}</span>
          <span class="text-caption">{row.impactedReportCodes.join(", ")}</span>
        </div>
      ),
    },
    { key: "reason", label: t("Reason"), value: (row) => row.compatibility.reasonCode ?? row.compatibility.message },
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
            ...(canOpenChrome.value
              ? [{ key: "studio", label: t("Open in Studio"), icon: "mdi-pencil-outline", onClick: () => openStudio(row) }]
              : []),
          ]}
        />
      ),
    },
  ]);

  onMounted(() => {
    void loadDefaults();
  });

  return () => (
    <ScreenContainer>
    <PgStack gap="lg">
        <PageHeader title={t("Headers & Footers Needing Migration")} subtitle={t("Platform headers and footers that must be migrated before dependent reports can run")} badge="NEEDS_MIGRATION" badgeLabel={t("Needs migration")} badgeTone="danger">
            <div class="d-flex flex-wrap ga-2">
              <PgButton variant="tonal" prependIcon="mdi-file-chart-outline" onClick={() => void router.push({ name: "ReportsNeedsMigration" })}>
                {t("Report migration")}
              </PgButton>
              {canReconcile.value && (
                <PgButton variant="tonal" loading={busy.value} prependIcon="mdi-cog-refresh-outline" onClick={() => { reconcileChecklist.value = {}; reconcileOpen.value = true; }}>
                  {t("Reconcile defaults")}
                </PgButton>
              )}
              <PgButton variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>
                {t("Refresh")}
              </PgButton>
            </div>
        </PageHeader>
        {defaultIssues.value.length > 0 && (
          <PgAlert tone="warning">
            {defaultIssues.value.join(" · ")}
          </PgAlert>
        )}
        <ApiTable<ChromeMigrationRow>
          title={t("Headers & Footers Needing Migration")}
          url={urlsMap.reportEngineChromeNeedsMigration}
          headers={headers.value}
          rowColor={() => "var(--pg-status-danger-bg)"}
          localSearch={false}
          xlsx={false}
          showNumber={true}
          numberOfItemsPerPage={pageSize.value}
          setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
          searchValue={search.value}
          setSearchValue={(value) => (search.value = value)}
          apiDataExtractor={(data) => (data as { specs?: ChromeMigrationRow[] }).specs ?? []}
          apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
          setRefreshHook={(hook) => (refreshHook.value = hook as RefreshHook)}
          clearRefreshHook={() => (refreshHook.value = null)}
          onRefresh={(table, refreshTable) => {
            void refreshTable({ queryParams: { page: table.page, pageSize: pageSize.value, ...(search.value ? { search: search.value } : {}) } });
          }}
        />
      </PgStack>
      <FormModal
        modelValue={reconcileOpen.value}
        onUpdate:modelValue={(value: boolean) => (reconcileOpen.value = value)}
        title={t("Reconcile chrome defaults")}
        size="md"
        loading={busy.value}
        submitLabel={t("Reconcile")}
        onSubmit={() => void reconcile()}
      >
        <FormChecklist
          checks={[...RECONCILE_CHECKS]}
          modelValue={reconcileChecklist.value}
          onUpdate:modelValue={(value: Record<string, boolean>) => (reconcileChecklist.value = value)}
          show={showChecklists}
          title={t("Reconciliation checklist")}
          complete={reconcileChecklistComplete.value}
          incompleteMessage={t("Complete all reconciliation checklist items before continuing")}
        />
      </FormModal>
    </ScreenContainer>
  );
});

export default Page;
