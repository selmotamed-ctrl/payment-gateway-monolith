import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusBadge, formatHumanStatus, statusToTone } from "@/components/ui/StatusBadge";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";

type WalState = {
    archiveLagSeconds?: number | null;
    currentLsn?: string | null;
    lastArchivedLsn?: string | null;
    lagBytes?: number | null;
};

type StorageTarget = {
    id: string;
    name: string;
    kind: string;
    healthy: boolean;
    detail?: string | null;
};

type BackupSchedule = {
    fullCron?: string;
    deltaCron?: string;
    drillCron?: string;
    fullRetentionDays?: number;
    walRetentionDays?: number;
    alertLagSeconds?: number;
};

type BackupRow = {
    id: string;
    target: string;
    kind: string;
    engine?: string | null;
    status: string;
    startedAt?: string | null;
    completedAt?: string | null;
    durationMs?: number | null;
    sizeBytes?: number | null;
    errorMessage?: string | null;
};

type DrillCheck = {
    key?: string;
    name?: string;
    status?: string;
    passed?: boolean;
    detail?: string;
};

type DrillRow = {
    id: string;
    status: string;
    startedAt?: string | null;
    completedAt?: string | null;
    durationMs?: number | null;
    targetTime?: string | null;
    replayedLsn?: string | null;
    doubleEntryDrift?: string | number | null;
    balanceMismatches?: number | null;
    auditBrokenLinks?: number | null;
    journalLineCount?: number | null;
    checks?: DrillCheck[] | Record<string, unknown> | null;
    errorMessage?: string | null;
};

type BackupOverview = {
    configured: boolean;
    daemonReachable: boolean;
    generatedAt?: string;
    engineMode?: string;
    healthy?: boolean;
    wal?: WalState;
    targets?: StorageTarget[];
    schedule?: BackupSchedule;
    policy?: unknown;
    backups?: BackupRow[];
    latestDrill?: DrillRow | null;
    drills?: DrillRow[];
    localCatalog?: { backups?: BackupRow[]; drills?: DrillRow[] };
};

type Translate = (key: string) => string;

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

const formatDuration = (value: number | null | undefined, t: Translate): string => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const milliseconds = Number(value);
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ${t("ms")}`;
    const seconds = milliseconds / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} ${t("s")}`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}${t("m")} ${remainder}${t("s")}`;
};

const formatBytes = (value: number | null | undefined, t: Translate): string => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const bytes = Number(value);
    if (bytes < 1024) return `${bytes} ${t("B")}`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${t(units[index] ?? "KB")}`;
};

const finiteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const passesStatus = (value: unknown): boolean =>
    ["PASSED", "OK", "HEALTHY", "TRUE", "SUCCEEDED", "COMPLETED"].includes(
        String(value ?? "").trim().toUpperCase(),
    );

const readDrillCheck = (drill: DrillRow, candidates: string[]): boolean | null => {
    const checks = drill.checks;
    if (Array.isArray(checks)) {
        const normalized = candidates.map((candidate) => candidate.toUpperCase());
        const match = checks.find((check) =>
            normalized.includes(String(check.key ?? check.name ?? "").trim().toUpperCase()),
        );
        if (match) {
            if (typeof match.passed === "boolean") return match.passed;
            if (match.status !== undefined) return passesStatus(match.status);
        }
    } else if (checks && typeof checks === "object") {
        const record = checks as Record<string, unknown>;
        for (const candidate of candidates) {
            const value =
                record[candidate] ??
                record[candidate.toLowerCase()] ??
                record[candidate.toUpperCase()];
            if (typeof value === "boolean") return value;
            if (typeof value === "number") return value === 0;
            if (typeof value === "string") {
                const numeric = Number(value);
                if (value.trim() !== "" && Number.isFinite(numeric)) return numeric === 0;
                return passesStatus(value);
            }
            if (value && typeof value === "object") {
                const nested = value as { passed?: unknown; status?: unknown };
                if (typeof nested.passed === "boolean") return nested.passed;
                if (nested.status !== undefined) return passesStatus(nested.status);
            }
        }
    }
    return null;
};

const SystemBackupsPage = dc(() => {
    const { t } = useLocale();
    const overview = ref<BackupOverview | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const triggerOpen = ref(false);
    const triggering = ref(false);
    const triggerForm = ref<{ target: string; kind: string }>({ target: "all", kind: "full" });

    const policyOpen = ref(false);
    const savingPolicy = ref(false);
    const policyError = ref<string | null>(null);
    const policyForm = ref({
        fullCron: "",
        deltaCron: "",
        drillCron: "",
        fullRetentionDays: "",
        walRetentionDays: "",
        alertLagSeconds: "",
    });

    const canWrite = computed(() => hasOneOfAuthorities(["security:write"]));

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.systemBackupsOverview);
            overview.value = (response.data?.data ?? response.data ?? null) as BackupOverview | null;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const targetOptions = computed(() => [
        { title: t("All targets"), value: "all" },
        { title: t("PostgreSQL core"), value: "postgres_core" },
        { title: t("Audit database"), value: "audit_db" },
        { title: t("Redis"), value: "redis" },
    ]);

    const kindOptions = computed(() => [
        { title: t("Full"), value: "full" },
        { title: t("Delta"), value: "delta" },
    ]);

    const wal = computed<WalState>(() => overview.value?.wal ?? {});
    const schedule = computed<BackupSchedule>(() => overview.value?.schedule ?? {});
    const targets = computed<StorageTarget[]>(() => overview.value?.targets ?? []);
    const healthyTargets = computed(() => targets.value.filter((target) => target.healthy).length);
    const alertLagSeconds = computed(() => finiteNumber(schedule.value.alertLagSeconds) ?? 0);
    const lagSeconds = computed(() => finiteNumber(wal.value.archiveLagSeconds) ?? 0);
    const lagTone = computed<"success" | "warning" | "danger">(() => {
        if (alertLagSeconds.value <= 0) return "success";
        if (lagSeconds.value > alertLagSeconds.value * 2) return "danger";
        if (lagSeconds.value > alertLagSeconds.value) return "warning";
        return "success";
    });

    const backupRows = computed<BackupRow[]>(() => {
        const data = overview.value;
        if (!data) return [];
        const rows = data.backups && data.backups.length > 0 ? data.backups : data.localCatalog?.backups ?? [];
        return rows.slice(0, 30);
    });

    const latestBackup = computed<BackupRow | null>(() => backupRows.value[0] ?? null);
    const latestDrill = computed<DrillRow | null>(() => overview.value?.latestDrill ?? null);
    const drillPassed = computed(() => passesStatus(latestDrill.value?.status));
    const drillPending = computed(() =>
        ["PENDING", "QUEUED", "RUNNING", "IN_PROGRESS", "SCHEDULED"].includes(
            String(latestDrill.value?.status ?? "").trim().toUpperCase(),
        ),
    );
    const drillTone = computed<"success" | "warning" | "danger" | "neutral">(() => {
        if (!latestDrill.value) return "neutral";
        if (drillPassed.value) return "success";
        if (drillPending.value) return "warning";
        return "danger";
    });
    const drillLabel = computed(() => {
        if (!latestDrill.value) return t("Pending");
        if (drillPassed.value) return t("Drill passed");
        if (drillPending.value) return t(formatHumanStatus(latestDrill.value.status));
        return t("Drill failed");
    });

    const invariantChecks = computed(() => {
        const drill = latestDrill.value;
        if (!drill) return [];
        const drift = finiteNumber(drill.doubleEntryDrift);
        const mismatches = finiteNumber(drill.balanceMismatches);
        const brokenLinks = finiteNumber(drill.auditBrokenLinks);
        return [
            {
                key: "double-entry",
                label: t("Double-entry zero drift"),
                passed:
                    readDrillCheck(drill, ["DOUBLE_ENTRY_DRIFT", "DOUBLE_ENTRY_ZERO_DRIFT", "DOUBLE_ENTRY"]) ??
                    (drift === null ? null : drift === 0),
            },
            {
                key: "balance-parity",
                label: t("Sharded balance parity"),
                passed:
                    readDrillCheck(drill, ["BALANCE_PARITY", "SHARDED_BALANCE_PARITY", "BALANCE_MISMATCHES"]) ??
                    (mismatches === null ? null : mismatches === 0),
            },
            {
                key: "audit-chain",
                label: t("Audit hash chain"),
                passed:
                    readDrillCheck(drill, ["AUDIT_CHAIN", "AUDIT_HASH_CHAIN", "AUDIT_BROKEN_LINKS"]) ??
                    (brokenLinks === null ? null : brokenLinks === 0),
            },
        ];
    });

    const metricItems = computed<MetricItem[]>(() => {
        const data = overview.value;
        if (!data) return [];
        const latestStatus = latestBackup.value?.status;
        const drillStatus = latestDrill.value?.status;        return [
            {
                key: "wal",
                label: t("WAL archive lag"),
                value: `${lagSeconds.value} ${t("s")}`,
                subLabel: `${t("Alert threshold")}: ${alertLagSeconds.value} ${t("s")}`,
                badge: lagTone.value === "success" ? t("Healthy") : lagTone.value === "warning" ? t("Attention") : t("Critical"),
                badgeTone: lagTone.value,
            },
            {
                key: "daemon",
                label: t("Daemon status"),
                value: data.daemonReachable ? t("Reachable") : t("Unreachable"),
                badge: data.daemonReachable ? t("Healthy") : t("Failed"),
                badgeTone: data.daemonReachable ? "success" : "danger",
            },
            {
                key: "targets",
                label: t("Storage targets"),
                value: `${healthyTargets.value}/${targets.value.length}`,
                badge:
                    targets.value.length > 0 && healthyTargets.value === targets.value.length
                        ? t("Healthy")
                        : t("Attention"),
                badgeTone:
                    targets.value.length > 0 && healthyTargets.value === targets.value.length
                        ? "success"
                        : "warning",
            },
            {
                key: "last-backup",
                label: t("Last backup"),
                value: latestBackup.value
                    ? formatDateTime(latestBackup.value.completedAt ?? latestBackup.value.startedAt)
                    : t("No backups yet"),
                badge: latestStatus ? t(formatHumanStatus(latestStatus)) : t("Pending"),
                badgeTone: latestStatus ? statusToTone(latestStatus) : "neutral",
            },
            {
                key: "latest-drill",
                label: t("Latest restore drill"),
                value: latestDrill.value
                    ? formatDateTime(latestDrill.value.completedAt ?? latestDrill.value.startedAt)
                    : t("No restore drill yet"),
                badge: drillStatus ? drillLabel.value : t("Pending"),
                badgeTone: drillTone.value,
            },
        ];
    });

    const backupHeaders: TableHeader<BackupRow>[] = [
        {
            key: "id",
            label: "Backup ID",
            value: (row) => row.id,
            Value: ({ row }: { row: BackupRow }) => <MonoRef value={row.id} truncate={18} />,
        },
        { key: "target", label: "Target", value: (row) => row.target },
        { key: "kind", label: "Kind", value: (row) => row.kind },
        { key: "engine", label: "Engine", value: (row) => row.engine ?? "" },
        {
            key: "status",
            label: "Status",
            value: (row) => row.status,
            Value: ({ row }: { row: BackupRow }) => (
                <StatusBadge
                    status={row.status}
                    label={t(formatHumanStatus(row.status))}
                    toneOverride={statusToTone(row.status)}
                />
            ),
        },
        { key: "startedAt", label: "Started", value: (row) => formatDateTime(row.startedAt) },
        { key: "completedAt", label: "Completed", value: (row) => formatDateTime(row.completedAt) },
        { key: "durationMs", label: "Duration", value: (row) => formatDuration(row.durationMs, t) },
        { key: "sizeBytes", label: "Size", value: (row) => formatBytes(row.sizeBytes, t) },
        { key: "errorMessage", label: "Error", value: (row) => row.errorMessage ?? "" },
    ];

    const openTrigger = () => {
        triggerForm.value = { target: "all", kind: "full" };
        triggerOpen.value = true;
    };

    const submitTrigger = async () => {
        if (triggering.value) return;
        triggering.value = true;
        try {
            const response = await api.post(urlsMap.systemBackupsTrigger, {
                target: triggerForm.value.target,
                kind: triggerForm.value.kind,
            });
            const payload = (response.data?.data ?? response.data ?? {}) as { backupJobId?: string };
            triggerOpen.value = false;
            showSnackBar({
                type: "success",
                message: payload.backupJobId
                    ? `${t("Triggered")} · ${payload.backupJobId}`
                    : t("Triggered"),
            });
            void load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            triggering.value = false;
        }
    };

    const runDrill = async () => {
        if (!canWrite.value) return;
        await showConfirm({
            title: t("Run restore drill"),
            message: t(
                "This launches an isolated scratch PostgreSQL instance, restores the latest backup, and verifies the three ledger invariants. It can take several minutes.",
            ),
            submitButtonLabel: t("Run restore drill"),
            type: "warning",
            onConfirm: async () => {
                const response = await api.post(urlsMap.systemBackupsDrill, {});
                const payload = (response.data?.data ?? response.data ?? {}) as { drillId?: string };
                showSnackBar({
                    type: "success",
                    message: payload.drillId
                        ? `${t("Restore drill triggered")} · ${payload.drillId}`
                        : t("Restore drill triggered"),
                });
                void load();
            },
        });
    };

    const openPolicy = () => {
        policyError.value = null;
        policyForm.value = {
            fullCron: schedule.value.fullCron ?? "",
            deltaCron: schedule.value.deltaCron ?? "",
            drillCron: schedule.value.drillCron ?? "",
            fullRetentionDays:
                schedule.value.fullRetentionDays === undefined
                    ? ""
                    : String(schedule.value.fullRetentionDays),
            walRetentionDays:
                schedule.value.walRetentionDays === undefined
                    ? ""
                    : String(schedule.value.walRetentionDays),
            alertLagSeconds:
                schedule.value.alertLagSeconds === undefined
                    ? ""
                    : String(schedule.value.alertLagSeconds),
        };
        policyOpen.value = true;
    };

    const submitPolicy = async () => {
        if (savingPolicy.value) return;
        const form = policyForm.value;
        const fullRetentionDays = Number(form.fullRetentionDays);
        const walRetentionDays = Number(form.walRetentionDays);
        const alertLag = Number(form.alertLagSeconds);
        if (
            !form.fullCron.trim() ||
            !form.deltaCron.trim() ||
            !form.drillCron.trim() ||
            !Number.isInteger(fullRetentionDays) ||
            !Number.isInteger(walRetentionDays) ||
            !Number.isInteger(alertLag)
        ) {
            policyError.value = t("Complete every policy field with a valid value.");
            return;
        }
        policyError.value = null;
        savingPolicy.value = true;
        try {
            const response = await api.put(urlsMap.systemBackupsPolicy, {
                fullCron: form.fullCron.trim(),
                deltaCron: form.deltaCron.trim(),
                drillCron: form.drillCron.trim(),
                fullRetentionDays,
                walRetentionDays,
                alertLagSeconds: alertLag,
            });
            const payload = (response.data?.data ?? response.data ?? {}) as {
                status?: string;
                approvalRequestId?: string;
            };
            policyOpen.value = false;
            if (payload.status === "PENDING_REVIEW") {
                showSnackBar({
                    type: "success",
                    message: payload.approvalRequestId
                        ? `${t("Policy change submitted for approval")} · ${payload.approvalRequestId}`
                        : t("Policy change submitted for approval"),
                });
            } else {
                showSnackBar({ type: "success", message: t("Policy updated") });
            }
            void load();
        } catch (e) {
            policyError.value = extractApiErrorMessage(e);
        } finally {
            savingPolicy.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Backup management")}
                    subtitle={t("Monitor WAL archiving, storage target health, backups, and restore drills.")}
                    badge={t("Disaster recovery")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <VBtn
                                variant="tonal"
                                prependIcon="mdi-refresh"
                                loading={loading.value}
                                onClick={() => void load()}
                            >
                                {t("Refresh")}
                            </VBtn>
                            {canWrite.value && (
                                <VBtn
                                    variant="tonal"
                                    prependIcon="mdi-database-plus-outline"
                                    onClick={openTrigger}
                                >
                                    {t("Run backup now")}
                                </VBtn>
                            )}
                            {canWrite.value && (
                                <VBtn
                                    variant="tonal"
                                    prependIcon="mdi-restore"
                                    onClick={() => void runDrill()}
                                >
                                    {t("Run restore drill")}
                                </VBtn>
                            )}
                            {canWrite.value && (
                                <VBtn
                                    color="primary"
                                    variant="flat"
                                    prependIcon="mdi-tune-variant"
                                    onClick={openPolicy}
                                >
                                    {t("Edit policy")}
                                </VBtn>
                            )}
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : !overview.value ? (
                    <StateView
                        empty={true}
                        emptyTitle={t("No Data Found")}
                        emptyDescription={t("The backup daemon returned no overview.")}
                    />
                ) : (
                    <>
                        <MetricStrip items={metricItems.value} />

                        {!overview.value.configured && (
                            <VAlert type="info" variant="tonal">
                                {t("Backup management is not configured for this environment.")}
                            </VAlert>
                        )}
                        {!overview.value.daemonReachable && (
                            <VAlert type="error" variant="tonal">
                                {t("The backup daemon is unreachable. Backup and drill actions are disabled until connectivity returns.")}
                            </VAlert>
                        )}

                        <ThemedView
                            style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                                gap: "18px",
                            }}
                        >
                            <SurfaceCard title={t("WAL archive lag")}>
                                <DescriptionList
                                    items={[
                                        {
                                            label: t("Archive lag"),
                                            value: `${lagSeconds.value} ${t("s")}`,
                                        },
                                        {
                                            label: t("Current LSN"),
                                            value: wal.value.currentLsn ?? "—",
                                            mono: true,
                                        },
                                        {
                                            label: t("Last archived LSN"),
                                            value: wal.value.lastArchivedLsn ?? "—",
                                            mono: true,
                                        },
                                        {
                                            label: t("Lag bytes"),
                                            value: formatBytes(wal.value.lagBytes, t),
                                        },
                                        {
                                            label: t("Alert threshold"),
                                            value: `${alertLagSeconds.value} ${t("s")}`,
                                        },
                                    ]}
                                />
                            </SurfaceCard>

                            <SurfaceCard title={t("Daemon status")}>
                                <ThemedView
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "14px",
                                    }}
                                >
                                    <ThemedView
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            gap: "10px",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <StatusBadge
                                            status={overview.value.daemonReachable ? "HEALTHY" : "FAILED"}
                                            label={
                                                overview.value.daemonReachable
                                                    ? t("Reachable")
                                                    : t("Unreachable")
                                            }
                                            toneOverride={
                                                overview.value.daemonReachable ? "success" : "danger"
                                            }
                                        />
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                            {t("Generated at")}: {formatDateTime(overview.value.generatedAt)}
                                        </ThemedText>
                                    </ThemedView>
                                    <DescriptionList
                                        items={[
                                            { label: t("Engine mode"), value: overview.value.engineMode ?? "—" },
                                            {
                                                label: t("Configured"),
                                                value: overview.value.configured ? t("Yes") : t("No"),
                                            },
                                            {
                                                label: t("Overall health"),
                                                value: overview.value.healthy ? t("Healthy") : t("Attention"),
                                            },
                                        ]}
                                    />
                                </ThemedView>
                            </SurfaceCard>

                            <SurfaceCard title={t("Storage targets")}>
                                {targets.value.length === 0 ? (
                                    <EmptyState
                                        title={t("No Data Found")}
                                        description={t("No storage targets reported by the backup daemon.")}
                                    />
                                ) : (
                                    <ThemedView
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "12px",
                                        }}
                                    >
                                        {targets.value.map((target) => (
                                            <ThemedView
                                                key={target.id}
                                                style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: "4px",
                                                    paddingBottom: "10px",
                                                    borderBottom: "1px solid var(--pg-border-subtle)",
                                                }}
                                            >
                                                <ThemedView
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "space-between",
                                                        gap: "10px",
                                                        flexWrap: "wrap",
                                                    }}
                                                >
                                                    <ThemedText style={{ fontSize: "13.5px", fontWeight: 600 }}>
                                                        {target.name}
                                                    </ThemedText>
                                                    <StatusBadge
                                                        status={target.healthy ? "HEALTHY" : "FAILED"}
                                                        label={target.healthy ? t("Healthy") : t("Failed")}
                                                        toneOverride={target.healthy ? "success" : "danger"}
                                                    />
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {target.kind}
                                                    {target.detail ? ` · ${target.detail}` : ""}
                                                </ThemedText>
                                            </ThemedView>
                                        ))}
                                    </ThemedView>
                                )}
                            </SurfaceCard>

                            <SurfaceCard title={t("Backup schedule")}>
                                <DescriptionList
                                    items={[
                                        { label: t("Full cron"), value: schedule.value.fullCron ?? "—", mono: true },
                                        { label: t("Delta cron"), value: schedule.value.deltaCron ?? "—", mono: true },
                                        { label: t("Drill cron"), value: schedule.value.drillCron ?? "—", mono: true },
                                        {
                                            label: t("Full retention days"),
                                            value: schedule.value.fullRetentionDays ?? "—",
                                        },
                                        {
                                            label: t("WAL retention days"),
                                            value: schedule.value.walRetentionDays ?? "—",
                                        },
                                        {
                                            label: t("Alert lag threshold"),
                                            value:
                                                schedule.value.alertLagSeconds === undefined
                                                    ? "—"
                                                    : `${schedule.value.alertLagSeconds} ${t("s")}`,
                                        },
                                    ]}
                                />
                            </SurfaceCard>
                        </ThemedView>

                        <SurfaceCard title={t("Latest restore drill")}>
                            {!latestDrill.value ? (
                                <EmptyState
                                    title={t("No restore drill yet")}
                                    description={t("Run a restore drill to verify backups and ledger invariants.")}
                                />
                            ) : (
                                <ThemedView
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "16px",
                                    }}
                                >
                                    <ThemedView
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            gap: "10px",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <ThemedView
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "10px",
                                                flexWrap: "wrap",
                                            }}
                                        >
                                            <StatusBadge
                                                status={latestDrill.value.status}
                                                label={drillLabel.value}
                                                toneOverride={drillTone.value}
                                            />
                                            <MonoRef value={latestDrill.value.id} truncate={22} />
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                            {t("Started")}: {formatDateTime(latestDrill.value.startedAt)}
                                        </ThemedText>
                                    </ThemedView>

                                    <DescriptionList
                                        columns={2}
                                        items={[
                                            {
                                                label: t("Target time"),
                                                value: formatDateTime(latestDrill.value.targetTime),
                                            },
                                            {
                                                label: t("Replayed LSN"),
                                                value: latestDrill.value.replayedLsn ?? "—",
                                                mono: true,
                                            },
                                            {
                                                label: t("Duration"),
                                                value: formatDuration(latestDrill.value.durationMs, t),
                                            },
                                            {
                                                label: t("Journal lines"),
                                                value:
                                                    latestDrill.value.journalLineCount === null ||
                                                    latestDrill.value.journalLineCount === undefined
                                                        ? "—"
                                                        : String(latestDrill.value.journalLineCount),
                                            },
                                        ]}
                                    />

                                    <ThemedView
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "8px",
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        {invariantChecks.value.map((check) => (
                                            <StatusBadge
                                                key={check.key}
                                                status={
                                                    check.passed === null
                                                        ? "PENDING"
                                                        : check.passed
                                                          ? "PASSED"
                                                          : "FAILED"
                                                }
                                                label={`${check.label}: ${
                                                    check.passed === null
                                                        ? t("Pending")
                                                        : check.passed
                                                          ? t("Passed")
                                                          : t("Failed")
                                                }`}
                                                toneOverride={
                                                    check.passed === null
                                                        ? "neutral"
                                                        : check.passed
                                                          ? "success"
                                                          : "danger"
                                                }
                                            />
                                        ))}
                                    </ThemedView>

                                    {latestDrill.value.errorMessage && (
                                        <VAlert type="error" variant="tonal">
                                            {latestDrill.value.errorMessage}
                                        </VAlert>
                                    )}
                                </ThemedView>
                            )}
                        </SurfaceCard>

                        <DataTable<BackupRow>
                            title={t("Scheduled backups")}
                            data={backupRows.value}
                            headers={backupHeaders}
                            showNumber={true}
                            numberOfItemsPerPage={10}
                            xlsx={false}
                        />
                    </>
                )}
            </ThemedView>

            <FormModal
                modelValue={triggerOpen.value}
                onUpdate:modelValue={(value: boolean) => (triggerOpen.value = value)}
                title={t("Run backup now")}
                subtitle={t("Trigger an immediate backup through the backup daemon.")}
                size="sm"
                submitLabel={t("Run backup now")}
                loading={triggering.value}
                onSubmit={() => void submitTrigger()}
            >
                <FormField label={t("Backup target")} required>
                    <VSelect
                        items={targetOptions.value}
                        itemTitle="title"
                        itemValue="value"
                        modelValue={triggerForm.value.target}
                        onUpdate:modelValue={(value: string) => (triggerForm.value.target = value)}
                    />
                </FormField>
                <FormField label={t("Backup kind")} required>
                    <VSelect
                        items={kindOptions.value}
                        itemTitle="title"
                        itemValue="value"
                        modelValue={triggerForm.value.kind}
                        onUpdate:modelValue={(value: string) => (triggerForm.value.kind = value)}
                    />
                </FormField>
                <VAlert type="info" variant="tonal">
                    {t("The backup runs asynchronously. Monitor the scheduled backups table for its result.")}
                </VAlert>
            </FormModal>

            <FormModal
                modelValue={policyOpen.value}
                onUpdate:modelValue={(value: boolean) => (policyOpen.value = value)}
                title={t("Edit backup policy")}
                subtitle={t("Schedule and retention changes require four-eyes approval.")}
                size="md"
                submitLabel={t("Save Changes")}
                loading={savingPolicy.value}
                errorMessage={policyError.value ?? ""}
                onSubmit={() => void submitPolicy()}
            >
                <FormField label={t("Full cron")} required>
                    <VTextField
                        modelValue={policyForm.value.fullCron}
                        onUpdate:modelValue={(value: string) => (policyForm.value.fullCron = value)}
                    />
                </FormField>
                <FormField label={t("Delta cron")} required>
                    <VTextField
                        modelValue={policyForm.value.deltaCron}
                        onUpdate:modelValue={(value: string) => (policyForm.value.deltaCron = value)}
                    />
                </FormField>
                <FormField label={t("Drill cron")} required>
                    <VTextField
                        modelValue={policyForm.value.drillCron}
                        onUpdate:modelValue={(value: string) => (policyForm.value.drillCron = value)}
                    />
                </FormField>
                <FormField label={t("Full retention days")} required>
                    <VTextField
                        type="number"
                        modelValue={policyForm.value.fullRetentionDays}
                        onUpdate:modelValue={(value: string) =>
                            (policyForm.value.fullRetentionDays = value)
                        }
                    />
                </FormField>
                <FormField label={t("WAL retention days")} required>
                    <VTextField
                        type="number"
                        modelValue={policyForm.value.walRetentionDays}
                        onUpdate:modelValue={(value: string) =>
                            (policyForm.value.walRetentionDays = value)
                        }
                    />
                </FormField>
                <FormField label={t("Alert lag threshold")} required>
                    <VTextField
                        type="number"
                        modelValue={policyForm.value.alertLagSeconds}
                        onUpdate:modelValue={(value: string) =>
                            (policyForm.value.alertLagSeconds = value)
                        }
                    />
                </FormField>
            </FormModal>
        </ScreenContainer>
    );
});

export default SystemBackupsPage;
