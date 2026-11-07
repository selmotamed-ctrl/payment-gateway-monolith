import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge, formatHumanStatus } from "@/components/ui/StatusBadge";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { auditOutboxFilters, jobFilters, notificationFilters, outboxFilters } from "@/components/Table/registry/ledgerOps";
import type { TableHeader } from "@/components/Table/types";
import { formatDateTime } from "@/components/ledger/format";
import ReasonModal from "@/pages/merchants/components/ReasonModal";
import MonitorTable from "./components/MonitorTable";
import {
    ageSecondsSince,
    attemptsLabel,
    backlogTone,
    canRequeueJob,
    canRetryNotification,
    formatAge,
    jobStateTone,
    normalizeTab,
    truncateError,
    type JobsOutboxSummary,
    type OutboxTab,
} from "./model";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type OutboxRow = {
    id: string;
    topic: string;
    aggregateType: string;
    aggregateId: string;
    merchantId: string | null;
    createdAt: string;
    processedAt: string | null;
    published: boolean;
    ageSeconds: number | null;
};

type AuditOutboxRow = {
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    actorId: string | null;
    role: string | null;
    createdAt: string;
    shippedAt: string | null;
    leaseUntil: string | null;
    shipped: boolean;
};

type JobRow = {
    id: string;
    jobType: string;
    referenceType: string;
    referenceId: string;
    state: string;
    attempts: number;
    maxAttempts: number;
    availableAt: string;
    lastError: string | null;
    completedAt: string | null;
    createdAt: string;
};

type NotificationRow = {
    id: string;
    templateCode: string;
    channel: string;
    lang: string;
    addressMasked: string | null;
    status: string;
    attempts: number;
    nextAttemptAt: string | null;
    recipientMerchantId: string | null;
    createdAt: string;
};

type PendingAction = { kind: "job" | "notification"; id: string } | null;

const JobsOutboxPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const canWrite = computed(() => hasOneOfAuthorities(["security:write"]));

    const tab = ref<OutboxTab>(normalizeTab(route.query.tab));
    const summary = ref<JobsOutboxSummary | null>(null);
    const refreshSignal = ref(0);
    const pending = ref<PendingAction>(null);
    const actionLoading = ref(false);
    const actionError = ref("");

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.systemJobsOutboxSummary);
            summary.value = (response.data?.data ?? response.data) as JobsOutboxSummary;
        } catch {
            summary.value = null;
        }
    };
    void loadSummary();

    const refreshAll = () => {
        refreshSignal.value += 1;
        void loadSummary();
    };

    const selectTab = (value: string) => {
        tab.value = normalizeTab(value);
        void router.replace({ query: { ...route.query, tab: tab.value } });
    };

    const submitAction = async (reason: string) => {
        const action = pending.value;
        if (!action) return;
        actionLoading.value = true;
        actionError.value = "";
        try {
            if (action.kind === "job") {
                await api.post(urlsMap.systemJobRequeue(action.id), { reason });
                showSnackBar({ type: "success", message: t("Background job re-queued") });
            } else {
                await api.post(urlsMap.systemNotificationRetry(action.id), { reason });
                showSnackBar({ type: "success", message: t("Notification re-queued for delivery") });
            }
            pending.value = null;
            refreshAll();
        } catch (cause) {
            actionError.value = extractApiErrorMessage(cause);
        } finally {
            actionLoading.value = false;
        }
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        const outboxAge = ageSecondsSince(data.oldestUnpublishedOutboxAt);
        const auditAge = ageSecondsSince(data.oldestAuditOutboxAt);
        const outboxTone = backlogTone(data.unpublishedOutbox, outboxAge);
        const auditTone = backlogTone(data.auditOutboxQueued, auditAge);
        return [
            {
                key: "outbox",
                label: t("Unpublished outbox events"),
                value: String(data.unpublishedOutbox),
                subLabel: data.unpublishedOutbox > 0 ? `${t("Oldest")}: ${formatAge(outboxAge)}` : t("Nothing waiting"),
                badge: outboxTone === "success" ? t("Healthy") : outboxTone === "danger" ? t("Backlog") : t("Draining"),
                badgeTone: outboxTone,
            },
            {
                key: "audit",
                label: t("Audit outbox queued"),
                value: String(data.auditOutboxQueued),
                subLabel: data.auditOutboxQueued > 0 ? `${t("Oldest")}: ${formatAge(auditAge)}` : t("Nothing waiting"),
                badge: auditTone === "success" ? t("Healthy") : auditTone === "danger" ? t("Backlog") : t("Draining"),
                badgeTone: auditTone,
            },
            {
                key: "jobs",
                label: t("Background jobs (24h)"),
                value: String(data.jobs24h.queued + data.jobs24h.running + data.jobs24h.succeeded + data.jobs24h.failed),
                subLabel: `${data.jobs24h.queued} ${t("queued")} · ${data.jobs24h.running} ${t("running")} · ${data.jobs24h.succeeded} ${t("succeeded")}`,
            },
            {
                key: "failed-jobs",
                label: t("Failed jobs (24h)"),
                value: String(data.jobs24h.failed),
                badge: data.jobs24h.failed > 0 ? t("Review") : t("Clear"),
                badgeTone: data.jobs24h.failed > 0 ? "danger" : "success",
            },
            {
                key: "notifications",
                label: t("Failed notifications"),
                value: String(data.failedNotifications),
                badge: data.failedNotifications > 0 ? t("Review") : t("Clear"),
                badgeTone: data.failedNotifications > 0 ? "danger" : "success",
            },
            ...(data.ledger
                ? [
                      {
                          key: "ledger-checkpoints",
                          label: t("Shards behind checkpoint"),
                          value: String(data.ledger.shardsBehind),
                          subLabel: data.ledger.shardsBehind > 0 ? `${t("Most pending lines")}: ${data.ledger.maxPendingLines}` : t("All shards are checkpointed"),
                          badge: data.ledger.failedShards > 0 ? t("Proof failed") : data.ledger.shardsBehind > 0 ? t("Catching up") : t("Healthy"),
                          badgeTone: (data.ledger.failedShards > 0 ? "danger" : data.ledger.shardsBehind > 0 ? "warning" : "success") as MetricItem["badgeTone"],
                      },
                      {
                          key: "ledger-failed-shards",
                          label: t("Shards failing the checkpoint proof"),
                          value: String(data.ledger.failedShards),
                          badge: data.ledger.failedShards > 0 ? t("Review") : t("Clear"),
                          badgeTone: (data.ledger.failedShards > 0 ? "danger" : "success") as MetricItem["badgeTone"],
                      },
                      {
                          key: "ledger-scaling",
                          label: t("Last shard scaling"),
                          value: data.ledger.lastScaling ? `${data.ledger.lastScaling.shardCount} ${t("shards")}` : t("None"),
                          subLabel: data.ledger.lastScaling ? formatDateTime(data.ledger.lastScaling.at) : t("No account was widened yet"),
                      },
                  ]
                : []),
        ];
    });

    const timeCell = (value: string | null | undefined) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(value)}</ThemedText>;

    const outboxHeaders = computed<TableHeader<OutboxRow>[]>(() => [
        { key: "id", label: "Event", value: (row) => row.id, Value: ({ row }) => <MonoRef value={row.id} truncate={12} /> },
        { key: "topic", label: "Topic", sortKey: "topic", value: (row) => row.topic },
        { key: "aggregateType", label: "Aggregate", value: (row) => row.aggregateType },
        { key: "aggregateId", label: "Aggregate ID", value: (row) => row.aggregateId, Value: ({ row }) => <MonoRef value={row.aggregateId} truncate={14} /> },
        {
            key: "merchantId",
            label: "Merchant",
            value: (row) => row.merchantId ?? "",
            Value: ({ row }) => (row.merchantId ? <MonoRef value={row.merchantId} truncate={12} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>),
        },
        {
            key: "published",
            label: "Status",
            value: (row) => (row.published ? "PUBLISHED" : "UNPUBLISHED"),
            Value: ({ row }) => (
                <StatusBadge
                    status={row.published ? "PUBLISHED" : "UNPUBLISHED"}
                    label={row.published ? t("Published") : t("Unpublished")}
                    toneOverride={row.published ? "success" : backlogTone(1, row.ageSeconds)}
                />
            ),
        },
        { key: "age", label: "Age", value: (row) => (row.published ? "—" : formatAge(row.ageSeconds)) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => timeCell(row.createdAt) },
        { key: "processedAt", label: "Published at", value: (row) => row.processedAt ?? "", Value: ({ row }) => timeCell(row.processedAt) },
    ]);

    const auditHeaders = computed<TableHeader<AuditOutboxRow>[]>(() => [
        { key: "id", label: "Record", value: (row) => row.id, Value: ({ row }) => <MonoRef value={row.id} truncate={12} /> },
        { key: "action", label: "Action", sortKey: "action", value: (row) => row.action, Value: ({ row }) => <StatusBadge status={row.action} label={formatHumanStatus(row.action)} showDot={false} toneOverride="neutral" /> },
        { key: "entityType", label: "Entity type", value: (row) => row.entityType },
        { key: "entityId", label: "Entity ID", value: (row) => row.entityId ?? "", Value: ({ row }) => (row.entityId ? <MonoRef value={row.entityId} truncate={14} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>) },
        { key: "role", label: "Actor role", value: (row) => row.role ?? "—" },
        {
            key: "shipped",
            label: "Status",
            value: (row) => (row.shipped ? "SHIPPED" : "QUEUED"),
            Value: ({ row }) => <StatusBadge status={row.shipped ? "SHIPPED" : "QUEUED"} label={row.shipped ? t("Shipped") : t("Queued")} toneOverride={row.shipped ? "success" : "warning"} />,
        },
        { key: "leaseUntil", label: "Lease until", value: (row) => row.leaseUntil ?? "", Value: ({ row }) => timeCell(row.leaseUntil) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => timeCell(row.createdAt) },
        { key: "shippedAt", label: "Shipped at", value: (row) => row.shippedAt ?? "", Value: ({ row }) => timeCell(row.shippedAt) },
    ]);

    const jobHeaders = computed<TableHeader<JobRow>[]>(() => [
        { key: "id", label: "Job", value: (row) => row.id, Value: ({ row }) => <MonoRef value={row.id} truncate={12} /> },
        { key: "jobType", label: "Type", value: (row) => row.jobType, Value: ({ row }) => <StatusBadge status={row.jobType} label={formatHumanStatus(row.jobType)} showDot={false} toneOverride="neutral" /> },
        {
            key: "reference",
            label: "Reference",
            value: (row) => `${row.referenceType}:${row.referenceId}`,
            Value: ({ row }) => (
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontSize: "11px", color: "var(--pg-ink-muted)" }}>{formatHumanStatus(row.referenceType)}</span>
                    <MonoRef value={row.referenceId} truncate={14} />
                </div>
            ),
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            value: (row) => row.state,
            Value: ({ row }) => <StatusBadge status={row.state} label={formatHumanStatus(row.state)} toneOverride={jobStateTone(row.state)} />,
        },
        { key: "attempts", label: "Attempts", sortKey: "attempts", value: (row) => attemptsLabel(row.attempts, row.maxAttempts) },
        { key: "availableAt", label: "Available at", sortKey: "availableAt", value: (row) => row.availableAt, Value: ({ row }) => timeCell(row.availableAt) },
        {
            key: "lastError",
            label: "Last error",
            value: (row) => row.lastError ?? "",
            Value: ({ row }) =>
                row.lastError ? (
                    <ThemedText style={{ fontSize: "11.5px", maxWidth: "280px", overflowWrap: "anywhere", color: "var(--pg-status-danger-text)" }} title={row.lastError}>
                        {truncateError(row.lastError)}
                    </ThemedText>
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => timeCell(row.createdAt) },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }) =>
                canRequeueJob(row.state, canWrite.value) ? (
                    <TableRowActions
                        primaryAction={{
                            label: t("Re-queue"),
                            icon: "mdi-restart",
                            onClick: () => {
                                actionError.value = "";
                                pending.value = { kind: "job", id: row.id };
                            },
                        }}
                    />
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
    ]);

    const notificationHeaders = computed<TableHeader<NotificationRow>[]>(() => [
        { key: "id", label: "Notification", value: (row) => row.id, Value: ({ row }) => <MonoRef value={row.id} truncate={12} /> },
        { key: "templateCode", label: "Template", sortKey: "templateCode", value: (row) => row.templateCode },
        { key: "channel", label: "Channel", value: (row) => row.channel, Value: ({ row }) => <StatusBadge status={row.channel} label={formatHumanStatus(row.channel)} showDot={false} toneOverride="info" /> },
        { key: "lang", label: "Language", value: (row) => row.lang },
        { key: "addressMasked", label: "Recipient", value: (row) => row.addressMasked ?? "—" },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }) => <StatusBadge status={row.status} label={formatHumanStatus(row.status)} />,
        },
        { key: "attempts", label: "Attempts", sortKey: "attempts", value: (row) => String(row.attempts) },
        { key: "nextAttemptAt", label: "Next attempt", value: (row) => row.nextAttemptAt ?? "", Value: ({ row }) => timeCell(row.nextAttemptAt) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => timeCell(row.createdAt) },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }) =>
                canRetryNotification(row.status, canWrite.value) ? (
                    <TableRowActions
                        primaryAction={{
                            label: t("Retry"),
                            icon: "mdi-send-clock-outline",
                            onClick: () => {
                                actionError.value = "";
                                pending.value = { kind: "notification", id: row.id };
                            },
                        }}
                    />
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
    ]);

    const tabView = () => {
        switch (tab.value) {
            case "audit":
                return (
                    <MonitorTable
                        key="audit"
                        title={t("Audit outbox")}
                        url={urlsMap.systemAuditOutboxList}
                        listKey="auditOutbox"
                        headers={auditHeaders.value}
                        filters={auditOutboxFilters}
                        refreshSignal={refreshSignal.value}
                        rowColor={(row: AuditOutboxRow) => (row.shipped ? undefined : "var(--pg-status-warning-bg)")}
                    />
                );
            case "jobs":
                return (
                    <MonitorTable
                        key="jobs"
                        title={t("Background jobs")}
                        url={urlsMap.systemJobsList}
                        listKey="jobs"
                        headers={jobHeaders.value}
                        filters={jobFilters}
                        initialFilters={{}}
                        refreshSignal={refreshSignal.value}
                        rowColor={(row: JobRow) => (row.state === "FAILED" ? "var(--pg-status-danger-bg)" : undefined)}
                    />
                );
            case "notifications":
                return (
                    <MonitorTable
                        key="notifications"
                        title={t("Failed notifications")}
                        url={urlsMap.systemNotificationsList}
                        listKey="notifications"
                        headers={notificationHeaders.value}
                        filters={notificationFilters}
                        refreshSignal={refreshSignal.value}
                    />
                );
            default:
                return (
                    <MonitorTable
                        key="outbox"
                        title={t("Transactional outbox")}
                        url={urlsMap.systemOutboxList}
                        listKey="outbox"
                        headers={outboxHeaders.value}
                        filters={outboxFilters}
                        refreshSignal={refreshSignal.value}
                        rowColor={(row: OutboxRow) => (row.published ? undefined : "var(--pg-status-warning-bg)")}
                    />
                );
        }
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("System Jobs & Outbox")}
                    subtitle={t("Delivery health of the transactional outbox, the audit outbox, background jobs and notifications.")}
                    badge={t("Operations")}
                    badgeTone="info"
                    end={() => (
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>
                            {t("Refresh")}
                        </VBtn>
                    )}
                />
                {summary.value && <MetricStrip items={metricItems.value} />}
                <SegmentedTabs
                    modelValue={tab.value}
                    onUpdate:modelValue={selectTab}
                    ariaLabel={t("Jobs and outbox views")}
                    tabs={[
                        { value: "outbox", label: t("Transactional outbox") },
                        { value: "audit", label: t("Audit outbox") },
                        { value: "jobs", label: t("Background jobs") },
                        { value: "notifications", label: t("Notifications") },
                    ]}
                />
                {tab.value === "outbox" || tab.value === "audit" ? (
                    <ThemedText style={{ fontSize: "12.5px", color: "var(--pg-ink-secondary)" }}>
                        {t("This is a monitor: the worker republishes events itself, there is nothing to retry by hand.")}
                    </ThemedText>
                ) : null}
                {tabView()}
            </ThemedView>
            <ReasonModal
                modelValue={pending.value !== null}
                onUpdate:modelValue={(open: boolean) => {
                    if (!open) pending.value = null;
                }}
                title={pending.value?.kind === "job" ? t("Re-queue background job") : t("Retry failed notification")}
                description={
                    pending.value?.kind === "job"
                        ? t("The failed job is moved back to the queue with its attempts reset.")
                        : t("The failed notification is queued again for delivery.")
                }
                submitLabel={pending.value?.kind === "job" ? t("Re-queue") : t("Retry")}
                loading={actionLoading.value}
                errorMessage={actionError.value}
                onSubmit={(reason: string) => void submitAction(reason)}
            />
        </ScreenContainer>
    );
});

export default JobsOutboxPage;
