import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge, formatHumanStatus } from "@/components/ui/StatusBadge";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues, type TableFilter } from "@/components/Table/filters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { formatDateTime } from "@/components/ledger/format";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type StorageHealth = {
  ok: boolean;
  mode: "FS_LOCAL" | "REMOTE_MTLS";
  rootDirOrUrl: string;
  freeBytes: number;
  latencyMs: number;
  error?: string;
};

type StorageSummary = {
  health: StorageHealth;
  activeKekVersion: number;
  countsByStatus: Record<string, number>;
  bytesByNamespace: Record<string, { objects: number; bytes: string }>;
  activeLocksCount: number;
  legalHoldCount: number;
  quarantinePendingCount: number;
  scrubErrorsCount: number;
  scrubErrorObjects: number;
  totalObjects: number;
};

type LockRow = {
  id: string;
  holderType: string;
  holderId: string;
  acquiredReason: string;
  acquiredAt: string;
  acquiredByActorId?: string;
  releasedAt: string | null;
  releasedByActorId?: string | null;
  releaseReason: string | null;
  retentionFloorUntil?: string | null;
};

type AccessLogRow = {
  id: string;
  objectId: string;
  actorType: string;
  actorId: string;
  action: string;
  allowed: boolean;
  denialReason: string | null;
  holderType: string | null;
  holderId: string | null;
  ipAddress: string | null;
  requestId?: string | null;
  bytesServed?: string | null;
  occurredAt: string;
  object?: { id?: string; namespace: string; storageKey: string } | null;
};

type StorageObjectRow = {
  id: string;
  bucket: string;
  namespace: string;
  storageKey: string;
  status: string;
  detectedMimeType: string;
  originalFilename: string | null;
  byteSize: string;
  sha256Hex: string;
  ownerMerchantId: string | null;
  uploadedByActorType?: string;
  uploadedByActorId?: string;
  requiredAuthority?: string;
  confidentialityTier?: string;
  retainUntil: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldByAdminId?: string | null;
  legalHoldPlacedAt?: string | null;
  gcEligibleAt: string | null;
  gcClaimedAt?: string | null;
  avScanStatus: string;
  avScannedAt?: string | null;
  avSignature: string | null;
  lastScrubbedAt?: string | null;
  scrubErrorCount: number;
  stagingExpiresAt?: string | null;
  activatedAt?: string | null;
  purgedAt?: string | null;
  metadata?: unknown;
  createdAt: string;
  activeLocks?: LockRow[];
};

type ObjectDetail = {
  object: StorageObjectRow;
  locks: LockRow[];
  accessLogs: AccessLogRow[];
};

const NAMESPACES = [
  "KYB_DOCUMENTS",
  "RECON_STATEMENTS",
  "REGULATORY_REPORTS",
  "REPORT_STUDIO_ASSETS",
  "MERCHANT_STATEMENTS",
  "DISPUTE_EVIDENCE",
  "AML_CASE_ATTACHMENTS",
  "SYSTEM_BRAND_ASSETS",
  "BACKUP_ARTIFACTS",
];

const STATUSES = ["STAGING", "QUARANTINE_PENDING_AV", "QUARANTINE_REJECTED", "ACTIVE", "PURGED"];
const BUCKETS = ["HOT", "COLD", "QUARANTINE"];
const MAINTENANCE_JOBS = ["gc", "sweep", "scrub", "reconcile-locks", "rewrap", "av-scan"] as const;

const filterOptions = (values: readonly string[]) => values.map((value) => ({ title: value, value }));
const objectFilters: TableFilter[] = [
  { key: "namespace", label: "Namespace", type: "data-autocomplete", options: filterOptions(NAMESPACES) },
  { key: "status", label: "Status", type: "data-autocomplete", options: filterOptions(STATUSES) },
  { key: "bucket", label: "Bucket", type: "data-autocomplete", options: filterOptions(BUCKETS) },
  { key: "legalHold", label: "Legal hold", type: "boolean", trueLabel: "On hold", falseLabel: "Not held" },
  { key: "ownerMerchantId", label: "Owner merchant id", type: "text", placeholder: "Merchant UUID" },
  { key: "sha256Hex", label: "SHA-256", type: "text", placeholder: "Content hash" },
];
const quarantineFilters: TableFilter[] = objectFilters.filter((filter) => filter.key !== "status");
const auditFilters: TableFilter[] = [
  { key: "allowed", label: "Result", type: "boolean", trueLabel: "Allowed", falseLabel: "Denied" },
  { key: "action", label: "Action", type: "text", placeholder: "e.g. READ" },
  { key: "objectId", label: "Object id", type: "text", placeholder: "Storage object UUID" },
];

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const jobLabel = (job: string, t: (key: string) => string): string => {
  switch (job) {
    case "gc":
      return t("Garbage collection");
    case "sweep":
      return t("Blob sweep");
    case "scrub":
      return t("Integrity scrub");
    case "reconcile-locks":
      return t("Lock reconcile");
    case "rewrap":
      return t("KEK rewrap");
    case "av-scan":
      return t("Malware scan");
    default:
      return formatHumanStatus(job);
  }
};

const ObjectStoragePage = dc(() => {
  const { t } = useLocale();
  const route = useRoute();
  const tab = ref("health");
  const summary = ref<StorageSummary | null>(null);
  const summaryLoading = ref(false);
  const summaryError = ref("");
  const detail = ref<ObjectDetail | null>(null);
  const detailLoading = ref(false);
  const drawerOpen = ref(false);
  const objectFilterValues = ref<FilterValues>({});
  const quarantineFilterValues = ref<FilterValues>({});
  const auditFilterValues = ref<FilterValues>({});
  const objectSearch = ref<string | null>(null);
  const quarantineSearch = ref<string | null>(null);
  const auditSearch = ref<string | null>(null);
  const pageSize = ref(25);
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const quarantinePageSize = ref(25);
  const auditPageSize = ref(25);
  const holdTarget = ref<StorageObjectRow | null>(null);
  const holdMode = ref<"place" | "lift">("place");
  const holdReason = ref("");
  const holdError = ref("");
  const holdSaving = ref(false);
  const maintenanceJob = ref<string | null>(null);
  const maintenanceConfirm = ref(false);
  const maintenanceBusy = ref<string | null>(null);
  const maintenanceResult = ref<unknown>(null);
  const objectsRefresh = ref<null | (() => void)>(null);
  const quarantineRefresh = ref<null | (() => void)>(null);
  const auditRefresh = ref<null | (() => void)>(null);

  const filtersFor = (quarantined: boolean) => (quarantined ? quarantineFilters : objectFilters);
  const filterValuesFor = (quarantined: boolean) => (quarantined ? quarantineFilterValues.value : objectFilterValues.value);
  const setFilterValue = (key: string, value: unknown, quarantined = false) => {
    const target = quarantined ? quarantineFilterValues : objectFilterValues;
    target.value = { ...target.value, [key]: value };
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => (quarantined ? quarantineRefresh.value : objectsRefresh.value)?.(), 300);
  };
  const clearFilters = (quarantined = false) => {
    if (quarantined) quarantineFilterValues.value = {};
    else objectFilterValues.value = {};
    (quarantined ? quarantineRefresh.value : objectsRefresh.value)?.();
  };
  const setAuditFilterValue = (key: string, value: unknown) => {
    auditFilterValues.value = { ...auditFilterValues.value, [key]: value };
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => auditRefresh.value?.(), 300);
  };
  const clearAuditFilters = () => {
    auditFilterValues.value = {};
    auditRefresh.value?.();
  };

  const canAdmin = computed(() => hasOneOfAuthorities(["system:storage:admin"]));
  const canLegalHold = computed(() => hasOneOfAuthorities(["system:storage:legal-hold"]));

  const loadSummary = async () => {
    summaryLoading.value = true;
    summaryError.value = "";
    try {
      const response = await api.get(urlsMap.objectStorageSummary);
      summary.value = (response.data?.data ?? response.data) as StorageSummary;
    } catch (caught) {
      summaryError.value = extractApiErrorMessage(caught);
    } finally {
      summaryLoading.value = false;
    }
  };

  const loadDetail = async (id: string) => {
    detailLoading.value = true;
    detail.value = null;
    drawerOpen.value = true;
    try {
      const response = await api.get(urlsMap.objectStorageObject(id));
      detail.value = (response.data?.data ?? response.data) as ObjectDetail;
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
      drawerOpen.value = false;
    } finally {
      detailLoading.value = false;
    }
  };

  const openDetail = (row: StorageObjectRow) => void loadDetail(row.id);

  const refreshCurrent = () => {
    if (tab.value === "objects") objectsRefresh.value?.();
    if (tab.value === "quarantine") quarantineRefresh.value?.();
    if (tab.value === "audit") auditRefresh.value?.();
  };

  const refreshAll = async () => {
    await loadSummary();
    refreshCurrent();
  };

  onMounted(async () => {
    await loadSummary();
    const requestedTab = typeof route.query.tab === "string" ? route.query.tab : null;
    if (requestedTab && ["health", "objects", "quarantine", "audit"].includes(requestedTab)) tab.value = requestedTab;
    const open = typeof route.query.open === "string" ? route.query.open : null;
    if (open) void loadDetail(open);
  });

  const openHold = (row: StorageObjectRow, mode: "place" | "lift") => {
    holdTarget.value = row;
    holdMode.value = mode;
    holdReason.value = "";
    holdError.value = "";
  };

  const submitHold = async () => {
    if (!holdTarget.value) return;
    if (holdReason.value.trim().length < 5) {
      holdError.value = t("Enter at least 5 characters");
      return;
    }
    holdSaving.value = true;
    holdError.value = "";
    try {
      const url = urlsMap.objectStorageLegalHold(holdTarget.value.id);
      const response = holdMode.value === "place"
        ? await api.post(url, { reason: holdReason.value.trim() })
        : await api.delete(url, { data: { reason: holdReason.value.trim() } });
      const pendingApproval = holdMode.value === "lift" && response.status === 202;
      showSnackBar({
        message: pendingApproval
          ? t("Legal-hold lift submitted for approval")
          : holdMode.value === "place" ? t("Legal hold placed") : t("Legal hold lifted"),
        type: "success",
      });
      holdTarget.value = null;
      await refreshAll();
      if (detail.value) await loadDetail(detail.value.object.id);
    } catch (caught) {
      holdError.value = extractApiErrorMessage(caught);
    } finally {
      holdSaving.value = false;
    }
  };

  const requestMaintenance = (job: string) => {
    maintenanceJob.value = job;
    maintenanceConfirm.value = true;
    maintenanceResult.value = null;
  };

  const runMaintenance = async () => {
    const job = maintenanceJob.value;
    if (!job) return;
    maintenanceBusy.value = job;
    try {
      const response = await api.post(urlsMap.objectStorageMaintenance(job), {});
      maintenanceResult.value = (response.data?.data ?? response.data)?.result ?? null;
      maintenanceConfirm.value = false;
      showSnackBar({ message: t("Maintenance job completed: {job}", { job: jobLabel(job, t) }), type: "success" });
      await refreshAll();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      maintenanceBusy.value = null;
      maintenanceJob.value = null;
    }
  };

  const queryForObjects = (
    page: number,
    sortKey: string | null,
    sortDirection: "asc" | "desc",
    quarantined = false,
  ): Record<string, unknown> => ({
    page,
    pageSize: quarantined ? quarantinePageSize.value : pageSize.value,
    ...buildFilterQuery(filtersFor(quarantined), filterValuesFor(quarantined)),
    ...(quarantined ? { statuses: "QUARANTINE_PENDING_AV,QUARANTINE_REJECTED" } : {}),
    ...(sortKey ? { sortKey, sortDirection } : {}),
  });

  const metrics = computed<MetricItem[]>(() => {
    const value = summary.value;
    return [
      {
        key: "mode",
        label: t("Storage mode"),
        value: value ? (value.health.mode === "REMOTE_MTLS" ? t("Shared mTLS daemon") : t("Local vault")) : "—",
        ...(value ? { badge: value.health.ok ? t("Healthy") : t("Vault unhealthy"), badgeTone: value.health.ok ? "success" : "danger" } : {}),
        subLabel: value?.health.error ?? value?.health.rootDirOrUrl,
      },
      { key: "objects", label: t("Objects"), value: value?.totalObjects ?? "—" },
      { key: "locks", label: t("Active locks"), value: value?.activeLocksCount ?? "—" },
      { key: "quarantine", label: t("Awaiting AV"), value: value?.quarantinePendingCount ?? "—" },
      { key: "legal", label: t("Legal holds"), value: value?.legalHoldCount ?? "—" },
      {
        key: "scrub",
        label: t("Scrub errors"),
        value: value?.scrubErrorObjects ?? "—",
        ...(value && value.scrubErrorObjects > 0 ? { badge: t("Errors"), badgeTone: "danger" } : {}),
      },
      {
        key: "kek",
        label: t("Active KEK version"),
        value: value?.activeKekVersion ?? "—",
        subLabel: t("KEK rewrap rotates without rewriting blobs"),
      },
      {
        key: "free",
        label: t("Free space"),
        value: value ? formatBytes(value.health.freeBytes) : "—",
        subLabel: value ? `${value.health.latencyMs} ms` : undefined,
      },
    ];
  });

  const objectHeaders = computed<TableHeader<StorageObjectRow>[]>(() => [
    {
      key: "object",
      label: t("Object"),
      sortKey: "originalFilename",
      value: (row) => row.originalFilename ?? row.id,
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.originalFilename ?? row.namespace}</span>
          <MonoRef value={row.id} truncate={12} />
        </div>
      ),
    },
    { key: "namespace", label: t("Namespace"), sortKey: "namespace", value: (row) => row.namespace },
    { key: "status", label: t("Status"), sortKey: "status", value: (row) => row.status, Value: ({ row }) => <StatusBadge status={row.status} /> },
    { key: "mime", label: t("Type"), value: (row) => row.detectedMimeType },
    { key: "size", label: t("Size"), sortKey: "byteSize", value: (row) => formatBytes(Number(row.byteSize)) },
    { key: "owner", label: t("Owner"), value: (row) => row.ownerMerchantId ?? t("Shared") },
    { key: "bucket", label: t("Bucket"), value: (row) => row.bucket },
    { key: "locks", label: t("Locks"), value: (row) => String(row.activeLocks?.length ?? 0) },
    { key: "av", label: t("AV"), value: (row) => row.avScanStatus, Value: ({ row }) => <StatusBadge status={row.avScanStatus} /> },
    {
      key: "legal",
      label: t("Legal hold"),
      value: (row) => (row.legalHold ? t("On hold") : ""),
      Value: ({ row }) => row.legalHold ? <StatusBadge status="LEGAL_HOLD" label={t("On hold")} toneOverride="danger" /> : <span class="text-medium-emphasis">—</span>,
    },
    { key: "retain", label: t("Retention"), sortKey: "retainUntil", value: (row) => (row.retainUntil ? formatDateTime(row.retainUntil) : "—") },
    { key: "created", label: t("Created"), sortKey: "createdAt", value: (row) => formatDateTime(row.createdAt) },
    {
      key: "actions",
      label: t("Actions"),
      menu: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{ label: t("Inspect"), icon: "mdi-magnify", onClick: () => openDetail(row) }}
          items={canLegalHold.value ? [{
            key: "legal-hold",
            label: row.legalHold ? t("Request hold lift") : t("Legal hold"),
            icon: "mdi-gavel",
            danger: true,
            onClick: () => openHold(row, row.legalHold ? "lift" : "place"),
          }] : []}
        />
      ),
    },
  ]);

  const quarantineHeaders = computed<TableHeader<StorageObjectRow>[]>(() => [
    ...objectHeaders.value.filter((header) => !["owner", "bucket", "created", "actions"].includes(header.key)),
    { key: "signature", label: t("AV signature"), value: (row) => row.avSignature ?? "—" },
    { key: "age", label: t("Age"), value: (row) => (row.createdAt ? formatDateTime(row.createdAt) : "—") },
    {
      key: "actions",
      label: t("Actions"),
      menu: true,
      Value: ({ row }) => <TableRowActions primaryAction={{ label: t("Inspect"), icon: "mdi-magnify", onClick: () => openDetail(row) }} items={[]} />,
    },
  ]);

  const logHeaders = computed<TableHeader<AccessLogRow>[]>(() => [
    { key: "time", label: t("When"), value: (row) => formatDateTime(row.occurredAt) },
    { key: "action", label: t("Action"), value: (row) => row.action, Value: ({ row }) => <StatusBadge status={row.action} toneOverride={row.allowed ? "success" : "danger"} /> },
    {
      key: "actor",
      label: t("Access actor"),
      value: (row) => `${row.actorType}:${row.actorId}`,
      Value: ({ row }) => <div class="d-flex flex-column"><span>{formatHumanStatus(row.actorType)}</span><MonoRef value={row.actorId} truncate={14} /></div>,
    },
    {
      key: "object",
      label: t("Object"),
      value: (row) => row.objectId,
      Value: ({ row }) => <div class="d-flex flex-column"><span>{row.object?.namespace ?? "—"}</span><MonoRef value={row.objectId} truncate={12} /></div>,
    },
    { key: "holder", label: t("Holder"), value: (row) => (row.holderType ? `${row.holderType}:${row.holderId ?? ""}` : "—") },
    { key: "ip", label: t("IP"), value: (row) => row.ipAddress ?? "—" },
    { key: "request", label: t("Request"), value: (row) => row.requestId ?? "—" },
    { key: "bytes", label: t("Bytes"), value: (row) => row.bytesServed ?? "—" },
    { key: "denial", label: t("Reason"), value: (row) => row.denialReason ?? (row.allowed ? t("Granted") : "—") },
  ]);

  const detailItems = computed(() => {
    const object = detail.value?.object;
    if (!object) return [];
    return [
      { label: t("Object id"), value: <MonoRef value={object.id} /> },
      { label: t("Namespace"), value: object.namespace },
      { label: t("Status"), value: <StatusBadge status={object.status} /> },
      { label: t("Storage key"), value: <MonoRef value={object.storageKey} truncate={42} /> },
      { label: t("Detected type"), value: object.detectedMimeType },
      { label: t("Original file name"), value: object.originalFilename ?? "—" },
      { label: t("Size"), value: formatBytes(Number(object.byteSize)) },
      { label: t("SHA-256"), value: <MonoRef value={object.sha256Hex} truncate={20} /> },
      { label: t("Owner merchant"), value: object.ownerMerchantId ?? t("Shared") },
      { label: t("Storage bucket"), value: object.bucket },
      { label: t("Uploaded by"), value: `${object.uploadedByActorType ?? "—"}:${object.uploadedByActorId ?? "—"}` },
      { label: t("Required authority"), value: object.requiredAuthority ?? "—" },
      { label: t("Confidentiality"), value: object.confidentialityTier ?? "—" },
      { label: t("AV status"), value: <StatusBadge status={object.avScanStatus} /> },
      { label: t("AV signature"), value: object.avSignature ?? "—" },
      { label: t("AV scanned at"), value: object.avScannedAt ? formatDateTime(object.avScannedAt) : "—" },
      { label: t("Retain until"), value: object.retainUntil ? formatDateTime(object.retainUntil) : "—" },
      { label: t("GC eligible at"), value: object.gcEligibleAt ? formatDateTime(object.gcEligibleAt) : "—" },
      { label: t("GC claim"), value: object.gcClaimedAt ? formatDateTime(object.gcClaimedAt) : "—" },
      { label: t("Staging expires at"), value: object.stagingExpiresAt ? formatDateTime(object.stagingExpiresAt) : "—" },
      { label: t("Activated at"), value: object.activatedAt ? formatDateTime(object.activatedAt) : "—" },
      { label: t("Purged at"), value: object.purgedAt ? formatDateTime(object.purgedAt) : "—" },
      { label: t("Last scrubbed at"), value: object.lastScrubbedAt ? formatDateTime(object.lastScrubbedAt) : "—" },
      { label: t("Scrub errors"), value: String(object.scrubErrorCount) },
      { label: t("Legal hold"), value: object.legalHold ? t("On hold") : t("No") },
      { label: t("Legal hold reason"), value: object.legalHoldReason ?? "—" },
      { label: t("Legal hold by"), value: object.legalHoldByAdminId ?? "—" },
      { label: t("Legal hold placed at"), value: object.legalHoldPlacedAt ? formatDateTime(object.legalHoldPlacedAt) : "—" },
      { label: t("Metadata"), value: <MonoRef value={JSON.stringify(object.metadata ?? {})} truncate={42} /> },
      { label: t("Created"), value: formatDateTime(object.createdAt) },
    ];
  });

  return (): JSX.Element => (
    <ScreenContainer>
      <ThemedView style={{ gap: "18px" }}>
        <PageHeader
          title={t("Object & Asset Storage")}
          subtitle={t("Shared encrypted vault, quarantine, record locks, retention and legal holds across every core node.")}
          end={() => (
            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <StatusBadge status="info" label={`${summary.value?.totalObjects ?? 0} ${t("Objects")}`} toneOverride="info" showDot={false} />
              <StatusBadge status="pending" label={`${summary.value?.quarantinePendingCount ?? 0} ${t("Quarantine & AV queue")}`} toneOverride={summary.value?.quarantinePendingCount ? "warning" : "neutral"} showDot={false} />
              <StatusBadge status="legal" label={`${summary.value?.legalHoldCount ?? 0} ${t("Legal holds")}`} toneOverride={summary.value?.legalHoldCount ? "danger" : "neutral"} showDot={false} />
              <VBtn variant="tonal" prependIcon="mdi-refresh" loading={summaryLoading.value} onClick={() => void refreshAll()}>
                {t("Refresh")}
              </VBtn>
            </ThemedView>
          )}
        />
        {summaryError.value && <VAlert type="error" variant="tonal">{summaryError.value}</VAlert>}
        <MetricStrip items={metrics.value} loading={summaryLoading.value} />

        <SegmentedTabs
            modelValue={tab.value}
            tabs={[
              { value: "health", label: t("Cluster & daemon health") },
              { value: "objects", label: t("Object explorer") },
              { value: "quarantine", label: t("Quarantine & AV queue") },
              { value: "audit", label: t("Access audit trail") },
            ]}
            onUpdate:modelValue={(value: string) => (tab.value = value)}
        />

        {tab.value === "health" && (
          <SurfaceCard
            title={t("Maintenance jobs")}
            subtitle={t("Jobs run on this core node. Rewrap rotates the KEK without rewriting encrypted blobs.")}
          >
            {summary.value && !summary.value.health.ok && (
              <VAlert type="error" variant="tonal" class="mb-4">{summary.value.health.error ?? t("The shared vault is unhealthy")}</VAlert>
            )}
            <div class="d-flex flex-wrap ga-2">
              {MAINTENANCE_JOBS.map((job) => (
                <VBtn key={job} variant="outlined" size="small" disabled={!canAdmin.value} loading={maintenanceBusy.value === job} onClick={() => requestMaintenance(job)}>
                  {jobLabel(job, t)}
                </VBtn>
              ))}
            </div>
            {maintenanceResult.value !== null && (
              <div class="mt-4">
                <ThemedText type="defaultSemiBold" class="mb-1">{t("Last maintenance result")}</ThemedText>
                <pre class="pg-code-block">{JSON.stringify(maintenanceResult.value, null, 2)}</pre>
              </div>
            )}
            {summary.value && (
              <>
                <div class="mt-6">
                  <ThemedText type="defaultSemiBold" class="mb-2">{t("Objects by status")}</ThemedText>
                  <div class="d-flex flex-wrap ga-2">
                    {Object.entries(summary.value.countsByStatus).map(([status, count]) => (
                      <StatusBadge key={status} status={status} label={`${status}: ${count}`} />
                    ))}
                  </div>
                </div>
                <div class="mt-6">
                  <ThemedText type="defaultSemiBold" class="mb-2">{t("Bytes by namespace")}</ThemedText>
                  <DescriptionList
                    columns={2}
                    items={Object.entries(summary.value.bytesByNamespace).map(([namespace, value]) => ({
                      label: namespace,
                      value: `${formatBytes(Number(value.bytes))} · ${value.objects} ${t("object(s)")}`,
                    }))}
                  />
                </div>
              </>
            )}
          </SurfaceCard>
        )}

        {(tab.value === "objects" || tab.value === "quarantine") && (
          <ApiTable<StorageObjectRow>
              key={tab.value}
              title={tab.value === "quarantine" ? t("Quarantine & AV queue") : t("Storage objects")}
              url={urlsMap.objectStorageObjects}
              localSearch={false}
              showNumber
              numberOfItemsPerPage={tab.value === "quarantine" ? quarantinePageSize.value : pageSize.value}
              setNumberOfItemsPerPage={(value) => {
                if (tab.value === "quarantine") quarantinePageSize.value = value;
                else pageSize.value = value;
              }}
              numberOfItemsPerPageChoices={[{ label: "10", value: 10 }, { label: "25", value: 25 }, { label: "50", value: 50 }, { label: "100", value: 100 }]}
              searchValue={tab.value === "quarantine" ? quarantineSearch.value : objectSearch.value}
              setSearchValue={(value) => {
                if (tab.value === "quarantine") quarantineSearch.value = value;
                else objectSearch.value = value;
              }}
              headers={tab.value === "quarantine" ? quarantineHeaders.value : objectHeaders.value}
              apiDataExtractor={(data) => ((data as { objects?: StorageObjectRow[] }).objects ?? [])}
              apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
              setRefreshHook={(hook) => {
                if (tab.value === "quarantine") quarantineRefresh.value = hook.reset;
                else objectsRefresh.value = hook.reset;
              }}
              clearRefreshHook={() => {
                if (tab.value === "quarantine") quarantineRefresh.value = null;
                else objectsRefresh.value = null;
              }}
              onRefresh={(table, refresh) => {
                const query = queryForObjects(table.page, table.sortKey, table.sortDirection, tab.value === "quarantine");
                if (tab.value === "quarantine" && quarantineSearch.value) query.search = quarantineSearch.value;
                if (tab.value === "objects" && objectSearch.value) query.search = objectSearch.value;
                void refresh({ queryParams: query });
              }}
              TopSlot={() => (
                <TableFilters
                  filters={tab.value === "quarantine" ? quarantineFilters : objectFilters}
                  values={tab.value === "quarantine" ? quarantineFilterValues.value : objectFilterValues.value}
                  onChange={(key, value) => setFilterValue(key, value, tab.value === "quarantine")}
                  onClear={() => clearFilters(tab.value === "quarantine")}
                />
              )}
            />
        )}

        {tab.value === "audit" && (
          <ApiTable<AccessLogRow>
              title={t("Access audit trail")}
              url={urlsMap.objectStorageAccessLogs}
              localSearch={false}
              showNumber
              numberOfItemsPerPage={auditPageSize.value}
              setNumberOfItemsPerPage={(value) => (auditPageSize.value = value)}
              numberOfItemsPerPageChoices={[{ label: "10", value: 10 }, { label: "25", value: 25 }, { label: "50", value: 50 }, { label: "100", value: 100 }]}
              searchValue={auditSearch.value}
              setSearchValue={(value) => (auditSearch.value = value)}
              headers={logHeaders.value}
              apiDataExtractor={(data) => ((data as { accessLogs?: AccessLogRow[] }).accessLogs ?? [])}
              apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
              setRefreshHook={(hook) => (auditRefresh.value = hook.reset)}
              clearRefreshHook={() => (auditRefresh.value = null)}
              onRefresh={(table, refresh) => {
                void refresh({
                  queryParams: {
                    page: table.page,
                    pageSize: auditPageSize.value,
                    ...buildFilterQuery(auditFilters, auditFilterValues.value),
                    ...(auditSearch.value ? { search: auditSearch.value } : {}),
                  },
                });
              }}
              TopSlot={() => (
                <TableFilters
                  filters={auditFilters}
                  values={auditFilterValues.value}
                  onChange={(key, value) => setAuditFilterValue(key, value)}
                  onClear={() => clearAuditFilters()}
                />
              )}
            />
        )}

        <SlideOverDrawer modelValue={drawerOpen.value} onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)} title={t("Storage object")} subtitle={detail.value?.object.id ?? ""} width={720}>
          {detailLoading.value && <ThemedText>{t("Loading…")}</ThemedText>}
          {detail.value && !detailLoading.value && (
            <div class="d-flex flex-column ga-5">
              <DescriptionList items={detailItems.value} columns={2} />
              <div>
                <ThemedText type="defaultSemiBold" class="mb-2">{t("Locks (active and historical)")}</ThemedText>
                {detail.value.locks.length === 0 ? <ThemedText class="text-medium-emphasis">{t("No record holds this object.")}</ThemedText> : detail.value.locks.map((lock) => (
                  <div key={lock.id} class="d-flex align-center justify-space-between py-2" style={{ borderBottom: "1px solid var(--pg-border-subtle)" }}>
                    <div class="d-flex flex-column">
                      <span class="font-weight-medium">{lock.holderType}</span>
                      <MonoRef value={lock.holderId} truncate={18} />
                      <span class="text-caption text-medium-emphasis">{lock.acquiredReason} → {lock.releaseReason ?? t("active")}</span>
                      <span class="text-caption text-medium-emphasis">{t("Acquired")} {formatDateTime(lock.acquiredAt)} {lock.acquiredByActorId ? `· ${lock.acquiredByActorId}` : ""}</span>
                      {lock.releasedAt && <span class="text-caption text-medium-emphasis">{t("Released")} {formatDateTime(lock.releasedAt)} {lock.releasedByActorId ? `· ${lock.releasedByActorId}` : ""}</span>}
                    </div>
                    <StatusBadge status={lock.releasedAt ? "RELEASED" : "ACTIVE"} />
                  </div>
                ))}
              </div>
              <div>
                <ThemedText type="defaultSemiBold" class="mb-2">{t("Recent access")}</ThemedText>
                {detail.value.accessLogs.length === 0 ? <ThemedText class="text-medium-emphasis">{t("No access recorded yet.")}</ThemedText> : detail.value.accessLogs.map((log) => (
                  <div key={log.id} class="d-flex align-center justify-space-between py-2" style={{ borderBottom: "1px solid var(--pg-border-subtle)" }}>
                    <div class="d-flex flex-column">
                      <span>{log.action} · {log.actorType} · {log.actorId}</span>
                      <span class="text-caption text-medium-emphasis">{formatDateTime(log.occurredAt)} · {log.denialReason ?? t("Granted")} {log.requestId ? `· ${log.requestId}` : ""}</span>
                    </div>
                    <StatusBadge status={log.allowed ? "ALLOWED" : "DENIED"} />
                  </div>
                ))}
              </div>
              {canLegalHold.value && (
                <div class="d-flex ga-2">
                  {detail.value.object.legalHold ? (
                    <VBtn color="error" variant="tonal" onClick={() => openHold(detail.value!.object, "lift")}>{t("Request legal hold lift")}</VBtn>
                  ) : (
                    <VBtn color="error" variant="tonal" onClick={() => openHold(detail.value!.object, "place")}>{t("Place legal hold")}</VBtn>
                  )}
                </div>
              )}
            </div>
          )}
        </SlideOverDrawer>

        <FormModal modelValue={Boolean(holdTarget.value)} onUpdate:modelValue={(value: boolean) => { if (!value) holdTarget.value = null; }} title={holdMode.value === "place" ? t("Place a legal hold?") : t("Request a legal-hold lift?")} subtitle={holdTarget.value?.originalFilename ?? holdTarget.value?.id ?? ""} size="sm" submitLabel={holdMode.value === "place" ? t("Place hold") : t("Submit for approval")} loading={holdSaving.value} danger={holdMode.value === "place"} errorMessage={holdError.value} onSubmit={() => void submitHold()}>
          <VTextarea modelValue={holdReason.value} onUpdate:modelValue={(value: string) => { holdReason.value = value; holdError.value = ""; }} label={t("Hold reason (audit trail)")} rows={3} variant="outlined" autofocus />
          {holdMode.value === "lift" && <ThemedText class="text-medium-emphasis mt-2">{t("A different authorized checker must approve the lift.")}</ThemedText>}
        </FormModal>

        <FormModal modelValue={maintenanceConfirm.value} onUpdate:modelValue={(value: boolean) => (maintenanceConfirm.value = value)} title={t("Run maintenance job?")} subtitle={maintenanceJob.value ? jobLabel(maintenanceJob.value, t) : ""} size="sm" submitLabel={t("Run")} loading={Boolean(maintenanceBusy.value)} danger={maintenanceJob.value === "gc" || maintenanceJob.value === "rewrap"} onSubmit={() => void runMaintenance()}>
          <ThemedText>{t("This operation runs against the shared vault and will be audited.")}</ThemedText>
        </FormModal>
      </ThemedView>
    </ScreenContainer>
  );
});

export default ObjectStoragePage;
