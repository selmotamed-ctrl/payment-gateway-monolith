import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VSelect, VTextarea, VTextField } from "vuetify/components";
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
import { EmptyState } from "@/components/ui/EmptyState";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { DataTable } from "@/components/Table/DataTable";
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
  releasedAt: string | null;
  releaseReason: string | null;
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
  occurredAt: string;
  object?: { namespace: string; storageKey: string } | null;
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
  retainUntil: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  gcEligibleAt: string | null;
  avScanStatus: string;
  avSignature: string | null;
  scrubErrorCount: number;
  ownerMerchantId: string | null;
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

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const ObjectStoragePage = dc(() => {
  const { t } = useLocale();
  const tab = ref("health");
  const loading = ref(false);
  const summary = ref<StorageSummary | null>(null);
  const objects = ref<StorageObjectRow[]>([]);
  const objectsTotal = ref(0);
  const accessLogs = ref<AccessLogRow[]>([]);
  const accessLogsTotal = ref(0);
  const search = ref("");
  const namespaceFilter = ref<string | null>(null);
  const statusFilter = ref<string | null>(null);
  const detail = ref<ObjectDetail | null>(null);
  const detailLoading = ref(false);
  const drawerOpen = computed({
    get: () => detail.value !== null,
    set: (value: boolean) => {
      if (!value) detail.value = null;
    },
  });
  const holdTarget = ref<StorageObjectRow | null>(null);
  const holdMode = ref<"place" | "lift">("place");
  const holdReason = ref("");
  const holdError = ref("");
  const holdSaving = ref(false);
  const maintenanceBusy = ref<string | null>(null);

  const canAdmin = computed(() => hasOneOfAuthorities(["system:storage:admin"]));
  const canLegalHold = computed(() => hasOneOfAuthorities(["system:storage:legal-hold"]));

  const loadSummary = async () => {
    const response = await api.get(urlsMap.objectStorageSummary);
    summary.value = (response.data?.data ?? response.data) as StorageSummary;
  };

  const loadObjects = async () => {
    const response = await api.get(urlsMap.objectStorageObjects, {
      params: {
        page: 1,
        pageSize: 200,
        ...(namespaceFilter.value ? { namespace: namespaceFilter.value } : {}),
        ...(statusFilter.value ? { status: statusFilter.value } : {}),
        ...(search.value.trim() ? { search: search.value.trim() } : {}),
      },
    });
    const payload = response.data?.data ?? response.data ?? {};
    objects.value = (payload.objects ?? []) as StorageObjectRow[];
    objectsTotal.value = Number(payload.total ?? 0);
  };

  const loadAccessLogs = async () => {
    const response = await api.get(urlsMap.objectStorageAccessLogs, { params: { page: 1, pageSize: 100 } });
    const payload = response.data?.data ?? response.data ?? {};
    accessLogs.value = (payload.accessLogs ?? []) as AccessLogRow[];
    accessLogsTotal.value = Number(payload.total ?? 0);
  };

  const loadAll = async () => {
    loading.value = true;
    try {
      await Promise.all([loadSummary(), loadObjects(), loadAccessLogs()]);
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      loading.value = false;
    }
  };

  onMounted(() => void loadAll());

  const openDetail = async (row: StorageObjectRow) => {
    detailLoading.value = true;
    detail.value = { object: row, locks: [], accessLogs: [] };
    try {
      const response = await api.get(urlsMap.objectStorageObject(row.id));
      detail.value = (response.data?.data ?? response.data) as ObjectDetail;
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
      detail.value = null;
    } finally {
      detailLoading.value = false;
    }
  };

  const runMaintenance = async (job: string) => {
    maintenanceBusy.value = job;
    try {
      const response = await api.post(urlsMap.objectStorageMaintenance(job), {});
      const result = (response.data?.data ?? response.data)?.result ?? {};
      showSnackBar({ message: t("Maintenance job finished: {job}", { job }), type: "success" });
      void result;
      await loadAll();
    } catch (caught) {
      showSnackBar({ message: extractApiErrorMessage(caught), type: "error" });
    } finally {
      maintenanceBusy.value = null;
    }
  };

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
      if (holdMode.value === "place") await api.post(url, { reason: holdReason.value.trim() });
      else await api.delete(url, { data: { reason: holdReason.value.trim() } });
      showSnackBar({
        message: holdMode.value === "place" ? t("Legal hold placed") : t("Legal hold lifted"),
        type: "success",
      });
      holdTarget.value = null;
      await loadAll();
      if (detail.value) await openDetail(detail.value.object);
    } catch (caught) {
      holdError.value = extractApiErrorMessage(caught);
    } finally {
      holdSaving.value = false;
    }
  };

  const metrics = computed<MetricItem[]>(() => {
    const value = summary.value;
    return [
      {
        key: "mode",
        label: t("Storage mode"),
        value: value ? (value.health.mode === "REMOTE_MTLS" ? t("Shared mTLS daemon") : t("Local vault")) : "—",
        badge: value?.health.ok ? t("Healthy") : t("Vault unhealthy"),
        badgeTone: value?.health.ok ? "success" : "danger",
        subLabel: value?.health.rootDirOrUrl,
      },
      { key: "objects", label: t("Objects"), value: value?.totalObjects ?? 0 },
      { key: "locks", label: t("Active locks"), value: value?.activeLocksCount ?? 0 },
      { key: "quarantine", label: t("Awaiting AV"), value: value?.quarantinePendingCount ?? 0 },
      { key: "legal", label: t("Legal holds"), value: value?.legalHoldCount ?? 0 },
      {
        key: "scrub",
        label: t("Scrub errors"),
        value: value?.scrubErrorObjects ?? 0,
        badgeTone: value && value.scrubErrorObjects > 0 ? "danger" : "neutral",
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
      sortKey: "id",
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span class="font-weight-medium">{row.originalFilename ?? row.namespace}</span>
          <MonoRef value={row.id} truncate={12} />
        </div>
      ),
    },
    { key: "namespace", label: t("Namespace"), sortKey: "namespace", value: (row) => row.namespace },
    {
      key: "status",
      label: t("Status"),
      sortKey: "status",
      Value: ({ row }) => <StatusBadge status={row.status} />,
    },
    {
      key: "mime",
      label: t("Type"),
      value: (row) => row.detectedMimeType,
    },
    {
      key: "size",
      label: t("Size"),
      sortKey: "byteSize",
      value: (row) => formatBytes(Number(row.byteSize)),
    },
    {
      key: "locks",
      label: t("Locks"),
      value: (row) => String(row.activeLocks?.length ?? 0),
    },
    {
      key: "legal",
      label: t("Legal hold"),
      Value: ({ row }) =>
        row.legalHold ? <StatusBadge status="LEGAL_HOLD" label={t("On hold")} toneOverride="danger" /> : <span class="text-medium-emphasis">—</span>,
    },
    {
      key: "retain",
      label: t("Retention"),
      sortKey: "retainUntil",
      value: (row) => (row.retainUntil ? formatDateTime(row.retainUntil) : "—"),
    },
    {
      key: "created",
      label: t("Created"),
      sortKey: "createdAt",
      value: (row) => formatDateTime(row.createdAt),
    },
    {
      key: "actions",
      label: t("Actions"),
      menu: true,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{ label: t("Inspect"), icon: "mdi-magnify", onClick: () => void openDetail(row) }}
          items={[
            ...(canLegalHold.value
              ? [{
                  key: "legal-hold",
                  label: row.legalHold ? t("Lift hold") : t("Legal hold"),
                  icon: "mdi-gavel",
                  danger: true,
                  onClick: () => openHold(row, row.legalHold ? "lift" : "place"),
                }]
              : []),
          ]}
        />
      ),
    },
  ]);

  const logHeaders = computed<TableHeader<AccessLogRow>[]>(() => [
    {
      key: "time",
      label: t("When"),
      sortKey: "occurredAt",
      value: (row) => formatDateTime(row.occurredAt),
    },
    {
      key: "action",
      label: t("Action"),
      Value: ({ row }) => <StatusBadge status={row.action} toneOverride={row.allowed ? "success" : "danger"} />,
    },
    {
      key: "actor",
      label: t("Access actor"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span>{formatHumanStatus(row.actorType)}</span>
          <MonoRef value={row.actorId} truncate={14} />
        </div>
      ),
    },
    {
      key: "object",
      label: t("Object"),
      Value: ({ row }) => (
        <div class="d-flex flex-column">
          <span>{row.object?.namespace ?? "—"}</span>
          <MonoRef value={row.objectId} truncate={12} />
        </div>
      ),
    },
    { key: "holder", label: t("Holder"), value: (row) => (row.holderType ? `${row.holderType}:${row.holderId ?? ""}` : "—") },
    { key: "ip", label: t("IP"), value: (row) => row.ipAddress ?? "—" },
    {
      key: "denial",
      label: t("Reason"),
      value: (row) => row.denialReason ?? (row.allowed ? t("Granted") : "—"),
    },
  ]);

  const quarantined = computed(() =>
    objects.value.filter((row) => row.status === "QUARANTINE_PENDING_AV" || row.status === "QUARANTINE_REJECTED"),
  );

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
      { label: t("AV status"), value: <StatusBadge status={object.avScanStatus} /> },
      { label: t("AV signature"), value: object.avSignature ?? "—" },
      { label: t("Retain until"), value: object.retainUntil ? formatDateTime(object.retainUntil) : "—" },
      { label: t("GC eligible at"), value: object.gcEligibleAt ? formatDateTime(object.gcEligibleAt) : "—" },
      { label: t("Scrub errors"), value: String(object.scrubErrorCount) },
      { label: t("Created"), value: formatDateTime(object.createdAt) },
    ];
  });

  const maintenanceJobs = ["gc", "sweep", "scrub", "reconcile-locks", "rewrap", "av-scan"] as const;

  return (): JSX.Element => (
    <ScreenContainer>
      <ThemedView>
        <PageHeader
          title={t("Object & Asset Storage")}
          subtitle={t("Shared encrypted vault, quarantine, record locks, retention and legal holds across every core node.")}
          end={() => (
            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void loadAll()}>
              {t("Refresh")}
            </VBtn>
          )}
        />
        <MetricStrip items={metrics.value} loading={loading.value} />

        <div class="mb-4">
          <SegmentedTabs
            modelValue={tab.value}
            tabs={[
              { value: "health", label: t("Cluster & daemon health") },
              { value: "objects", label: t("Object explorer"), count: objectsTotal.value },
              { value: "quarantine", label: t("Quarantine & AV queue"), count: summary.value?.quarantinePendingCount ?? 0 },
              { value: "audit", label: t("Access audit trail"), count: accessLogsTotal.value },
            ]}
            onUpdate:modelValue={(value: string) => (tab.value = value)}
          />
        </div>

        {tab.value === "health" && (
          <SurfaceCard>
            <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-3">
              <ThemedText type="subtitle">{t("Maintenance jobs")}</ThemedText>
              <ThemedText  class="text-medium-emphasis">
                {t("Jobs run on this core node. Rewrap rotates the KEK without rewriting encrypted blobs.")}
              </ThemedText>
            </div>
            <div class="d-flex flex-wrap ga-2">
              {maintenanceJobs.map((job) => (
                <VBtn
                  key={job}
                  variant="outlined"
                  size="small"
                  disabled={!canAdmin.value}
                  loading={maintenanceBusy.value === job}
                  onClick={() => void runMaintenance(job)}
                >
                  {formatHumanStatus(job)}
                </VBtn>
              ))}
            </div>
            {summary.value && (
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
            )}
          </SurfaceCard>
        )}

        {(tab.value === "objects" || tab.value === "quarantine") && (
          <SurfaceCard>
            <div class="d-flex flex-wrap align-center ga-3 mb-4">
              <VTextField
                modelValue={search.value}
                onUpdate:modelValue={(value: string) => (search.value = value)}
                label={t("Search by key or file name")}
                density="compact"
                variant="outlined"
                hideDetails
                style={{ maxWidth: "320px" }}
                onKeydown={(event: KeyboardEvent) => {
                  if (event.key === "Enter") void loadObjects();
                }}
              />
              <VSelect
                modelValue={namespaceFilter.value}
                onUpdate:modelValue={(value: string | null) => {
                  namespaceFilter.value = value;
                  void loadObjects();
                }}
                items={NAMESPACES}
                label={t("Namespace")}
                density="compact"
                variant="outlined"
                hideDetails
                clearable
                style={{ maxWidth: "260px" }}
              />
              {tab.value === "objects" && (
                <VSelect
                  modelValue={statusFilter.value}
                  onUpdate:modelValue={(value: string | null) => {
                    statusFilter.value = value;
                    void loadObjects();
                  }}
                  items={STATUSES}
                  label={t("Status")}
                  density="compact"
                  variant="outlined"
                  hideDetails
                  clearable
                  style={{ maxWidth: "260px" }}
                />
              )}
              <VBtn variant="tonal" prependIcon="mdi-magnify" onClick={() => void loadObjects()}>
                {t("Search")}
              </VBtn>
            </div>
            {tab.value === "quarantine" && quarantined.value.length === 0 ? (
              <EmptyState
                title={t("The quarantine queue is empty")}
                description={t("Uploaded files appear here until the malware scanner marks them clean or rejects them.")}
                icon="mdi-shield-check-outline"
              />
            ) : (
              <DataTable<StorageObjectRow>
                title={tab.value === "quarantine" ? t("Quarantine & AV queue") : t("Storage objects")}
                data={tab.value === "quarantine" ? quarantined.value : objects.value}
                headers={objectHeaders.value}
                loading={loading.value}
                showNumber
                numberOfItemsPerPage={25}
                setNumberOfItemsPerPage={() => undefined}
              />
            )}
          </SurfaceCard>
        )}

        {tab.value === "audit" && (
          <SurfaceCard>
            <DataTable<AccessLogRow>
              title={t("Access audit trail")}
              data={accessLogs.value}
              headers={logHeaders.value}
              loading={loading.value}
              showNumber
              numberOfItemsPerPage={25}
              setNumberOfItemsPerPage={() => undefined}
            />
          </SurfaceCard>
        )}

        <SlideOverDrawer
          modelValue={drawerOpen.value}
          onUpdate:modelValue={(value: boolean) => (drawerOpen.value = value)}
          title={t("Storage object")}
          subtitle={detail.value?.object.id ?? ""}
          width={720}
        >
          {detailLoading.value && <ThemedText class="pa-4">{t("Loading…")}</ThemedText>}
          {detail.value && !detailLoading.value && (
            <div class="d-flex flex-column ga-5 pa-4">
              <DescriptionList items={detailItems.value} columns={2} />
              <div>
                <ThemedText type="defaultSemiBold" class="mb-2">{t("Locks (active and historical)")}</ThemedText>
                {detail.value.locks.length === 0 ? (
                  <ThemedText  class="text-medium-emphasis">{t("No record holds this object.")}</ThemedText>
                ) : (
                  detail.value.locks.map((lock) => (
                    <div key={lock.id} class="d-flex align-center justify-space-between py-2" style={{ borderBottom: "1px solid var(--pg-border-subtle)" }}>
                      <div class="d-flex flex-column">
                        <span class="font-weight-medium">{lock.holderType}</span>
                        <MonoRef value={lock.holderId} truncate={18} />
                        <span class="text-caption text-medium-emphasis">{lock.acquiredReason} → {lock.releaseReason ?? t("active")}</span>
                      </div>
                      <StatusBadge status={lock.releasedAt ? "RELEASED" : "ACTIVE"} />
                    </div>
                  ))
                )}
              </div>
              <div>
                <ThemedText type="defaultSemiBold" class="mb-2">{t("Recent access")}</ThemedText>
                {detail.value.accessLogs.length === 0 ? (
                  <ThemedText  class="text-medium-emphasis">{t("No access recorded yet.")}</ThemedText>
                ) : (
                  detail.value.accessLogs.map((log) => (
                    <div key={log.id} class="d-flex align-center justify-space-between py-2" style={{ borderBottom: "1px solid var(--pg-border-subtle)" }}>
                      <div class="d-flex flex-column">
                        <span>{log.action} · {log.actorType}</span>
                        <span class="text-caption text-medium-emphasis">{formatDateTime(log.occurredAt)} · {log.denialReason ?? t("Granted")}</span>
                      </div>
                      <StatusBadge status={log.allowed ? "ALLOWED" : "DENIED"} />
                    </div>
                  ))
                )}
              </div>
              {canLegalHold.value && (
                <div class="d-flex ga-2">
                  {detail.value.object.legalHold ? (
                    <VBtn color="error" variant="tonal" onClick={() => openHold(detail.value!.object, "lift")}>
                      {t("Lift legal hold")}
                    </VBtn>
                  ) : (
                    <VBtn color="error" variant="tonal" onClick={() => openHold(detail.value!.object, "place")}>
                      {t("Place legal hold")}
                    </VBtn>
                  )}
                </div>
              )}
            </div>
          )}
        </SlideOverDrawer>

        <FormModal
          modelValue={Boolean(holdTarget.value)}
          onUpdate:modelValue={(value: boolean) => {
            if (!value) holdTarget.value = null;
          }}
          title={holdMode.value === "place" ? t("Place a legal hold?") : t("Lift the legal hold?")}
          subtitle={holdTarget.value?.originalFilename ?? holdTarget.value?.id ?? ""}
          size="sm"
          submitLabel={holdMode.value === "place" ? t("Place hold") : t("Lift hold")}
          loading={holdSaving.value}
          danger={holdMode.value === "place"}
          errorMessage={holdError.value}
          onSubmit={() => void submitHold()}
        >
          <VTextarea
            modelValue={holdReason.value}
            onUpdate:modelValue={(value: string) => {
              holdReason.value = value;
              holdError.value = "";
            }}
            label={t("Hold reason (audit trail)")}
            rows={3}
            variant="outlined"
            autofocus
          />
        </FormModal>
      </ThemedView>
    </ScreenContainer>
  );
});

export default ObjectStoragePage;
