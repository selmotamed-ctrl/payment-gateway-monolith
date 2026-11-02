import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VCard, VCardText, VCheckbox, VChip, VIcon, VProgressLinear, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { MiniStats, type StatItem } from "@/components/MiniStats";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatPlainNumber } from "@/utils/money";
import { showSnackBar } from "@/utils/snackBar";

const ACTIVITY_EXPORT_CHECKS = [
    { key: "ACTIVITY_SCOPE_VERIFIED", label: "Activity scope verified" },
    { key: "ACTORS_REVIEWED", label: "Actor list reviewed" },
    { key: "SECURITY_SCOPE_CONFIRMED", label: "Security scope confirmed" },
    { key: "EXPORT_AUDIT_ACKNOWLEDGED", label: "Export audit acknowledged" },
] as const;

const EXPORT_CHECKS = [
    { key: "PERIOD_VERIFIED", label: "Reporting period verified" },
    { key: "METRICS_REVIEWED", label: "Snapshot metrics reviewed" },
    { key: "DISTRIBUTION_ACKNOWLEDGED", label: "Distribution constraints acknowledged" },
    { key: "EXPORT_SCOPE_CONFIRMED", label: "Export scope confirmed" },
] as const;

type RecentActivity = {
    id: string;
    createdAt: string;
    actorEmail: string;
    role: string;
    action: string;
    entityType: string;
    entityId: string;
    approvalRequestId: string | null;
};

type Overview = {
    period: string;
    since: string;
    attemptsByState?: Record<string, number>;
    volumeByState?: Record<string, string>;
    attemptsTotal?: number;
    attemptsSucceeded?: number;
    successRate?: number;
    grossVolume?: string;
    unknownBacklog?: number;
    unknownOldestAgeSeconds?: number;
    openCircuitBreakers?: number;
    routeHealth?: { healthy: number; degraded: number; openBreaker: number };
    webhookInboxLagSeconds?: number;
    reconciliationMatchRate?: string;
    reconciliationItems?: number;
    approvalPending?: number;
    approvalExpired?: number;
    approvalEmergencyDue?: number;
    approvalQueueAgeing?: { domain: string; oldestHours: number; count: number }[];
    joinRequestOpen?: number;
    joinRequestSlaBreaches?: number;
    amlOpen?: number;
    amlSlaBreaches?: number;
    operatorOpen?: number;
    operatorP1?: number;
    operatorSlaBreaches?: number;
    merchantsActive?: number;
    merchantsPending?: number;
};

const PERIODS = [
    { title: "24 hours", value: "24h" },
    { title: "7 days", value: "7d" },
    { title: "30 days", value: "30d" },
    { title: "90 days", value: "90d" },
];

const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${formatPlainNumber(seconds)}s`;
    if (seconds < 3600) return `${formatPlainNumber(Math.round(seconds / 60))}m`;
    if (seconds < 86_400) return `${formatPlainNumber(Math.round(seconds / 3600))}h`;
    return `${formatPlainNumber(Math.round(seconds / 86_400))}d`;
};

const formatHours = (hours: number): string => {
    if (hours < 24) return `${formatPlainNumber(hours)}h`;
    return `${formatPlainNumber(Math.round(hours / 24))}d`;
};

const formatEventTime = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

const formatAmount = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return `${number.toLocaleString(undefined, { maximumFractionDigits: 4 })} LYD`;
};

const DashboardPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const overview = ref<Overview | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const period = ref("24h");
    const exportLoading = ref(false);
    const exportChecklist = ref<Record<string, boolean>>({});
    const recentActivity = ref<RecentActivity[]>([]);
    const activityLoading = ref(false);
    const activityExportLoading = ref(false);
    const activityExportChecklist = ref<Record<string, boolean>>({});
    const canViewActivity = computed(() => hasOneOfAuthorities(["security:read"]));

    const loadRecentActivity = async () => {
        if (!canViewActivity.value) return;
        activityLoading.value = true;
        try {
            const response = await api.get(urlsMap.dashboardRecentActivity, { params: { limit: 8 } });
            const payload = response.data?.data ?? response.data ?? {};
            recentActivity.value = (payload.recentActivity ?? []) as RecentActivity[];
        } catch {
            recentActivity.value = [];
        } finally {
            activityLoading.value = false;
        }
    };

    const exportChecklistComplete = computed(() => EXPORT_CHECKS.every((check) => exportChecklist.value[check.key] === true));

    const activityExportChecklistComplete = computed(() => ACTIVITY_EXPORT_CHECKS.every((check) => activityExportChecklist.value[check.key] === true));

    const exportActivity = async () => {
        if (activityExportLoading.value) return;
        if (!activityExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all activity export checklist items before exporting") });
            return;
        }
        activityExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.dashboardRecentActivityExport, {
                params: {
                    limit: 200,
                    checklist: ACTIVITY_EXPORT_CHECKS.filter((check) => activityExportChecklist.value[check.key]).map((check) => check.key).join(","),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.recentActivity ?? []) as RecentActivity[];
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["createdAt", "actorEmail", "role", "action", "entityType", "entityId", "approvalRequestId"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) => [row.createdAt, row.actorEmail, row.role, row.action, row.entityType, row.entityId, row.approvalRequestId ?? ""].map(escape).join(",")),
            ];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `dashboard-activity-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Dashboard activity exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            activityExportLoading.value = false;
        }
    };

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.dashboardOverview, { params: { period: period.value } });
            overview.value = (response.data?.data ?? response.data ?? {}) as Overview;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const exportSnapshot = async () => {
        if (exportLoading.value) return;
        if (!exportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.dashboardExport, { params: { period: period.value } });
            const data = (response.data?.data ?? response.data ?? {}) as Overview;
            const rows: Array<[string, string]> = [
                ["period", String(data.period ?? period.value)],
                ["since", String(data.since ?? "")],
                ["gross_volume", String(data.grossVolume ?? "0.0000")],
                ["attempts_total", String(data.attemptsTotal ?? 0)],
                ["attempts_succeeded", String(data.attemptsSucceeded ?? 0)],
                ["success_rate_percent", String(data.successRate ?? 0)],
                ["active_merchants", String(data.merchantsActive ?? 0)],
                ["pending_merchants", String(data.merchantsPending ?? 0)],
                ["unknown_backlog", String(data.unknownBacklog ?? 0)],
                ["unknown_oldest_age_seconds", String(data.unknownOldestAgeSeconds ?? 0)],
                ["pending_approvals", String(data.approvalPending ?? 0)],
                ["expired_approvals", String(data.approvalExpired ?? 0)],
                ["emergency_approvals_due", String(data.approvalEmergencyDue ?? 0)],
                ["open_circuit_breakers", String(data.openCircuitBreakers ?? 0)],
                ["degraded_routes", String(data.routeHealth?.degraded ?? 0)],
                ["webhook_inbox_lag_seconds", String(data.webhookInboxLagSeconds ?? 0)],
                ["reconciliation_match_rate_percent", String(data.reconciliationMatchRate ?? "0.0000")],
                ["reconciliation_items", String(data.reconciliationItems ?? 0)],
                ["join_requests_open", String(data.joinRequestOpen ?? 0)],
                ["join_request_sla_breaches", String(data.joinRequestSlaBreaches ?? 0)],
                ["aml_cases_open", String(data.amlOpen ?? 0)],
                ["aml_sla_breaches", String(data.amlSlaBreaches ?? 0)],
                ["operator_cases_open", String(data.operatorOpen ?? 0)],
                ["operator_cases_p1", String(data.operatorP1 ?? 0)],
                ["operator_sla_breaches", String(data.operatorSlaBreaches ?? 0)],
            ];
            for (const [state, count] of Object.entries(data.attemptsByState ?? {})) {
                rows.push([`attempts_state.${state}`, String(count)]);
                rows.push([`volume_state.${state}`, String(data.volumeByState?.[state] ?? "0.0000")]);
            }
            for (const queue of data.approvalQueueAgeing ?? []) {
                rows.push([`approval_queue.${queue.domain}.count`, String(queue.count)]);
                rows.push([`approval_queue.${queue.domain}.oldest_hours`, String(queue.oldestHours)]);
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const lines = ["metric,value", ...rows.map(([metric, value]) => `${escape(metric)},${escape(value)}`)];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `dashboard-${period.value}-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            await api.post(urlsMap.dashboardExportAudit, {
                period: period.value,
                checklist: EXPORT_CHECKS.filter((check) => exportChecklist.value[check.key]).map((check) => check.key),
            });
            showSnackBar({ type: "success", message: t("Dashboard snapshot exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    watch(period, () => void load());
    void load();
    void loadRecentActivity();

    const stats = (): StatItem[] => {
        const data = overview.value;
        return [
            {
                title: t("Gross volume"),
                value: formatAmount(data?.grossVolume),
                icon: "mdi-chart-line",
                color: "#0f6bff",
                subtitle: `${formatPlainNumber(data?.attemptsTotal ?? 0)} ${t("attempts")}`,
            },
            {
                title: t("Success rate"),
                value: `${formatPlainNumber(data?.successRate ?? 0)}%`,
                icon: "mdi-check-decagram-outline",
                color: (data?.successRate ?? 0) >= 90 ? "#059669" : (data?.successRate ?? 0) >= 70 ? "#d97706" : "#dc2626",
                subtitle: `${formatPlainNumber(data?.attemptsSucceeded ?? 0)} ${t("succeeded")}`,
            },
            {
                title: t("Active merchants"),
                value: formatPlainNumber(data?.merchantsActive ?? 0),
                icon: "mdi-storefront-outline",
                color: "#0f6bff",
                subtitle: `${formatPlainNumber(data?.merchantsPending ?? 0)} ${t("Pending")}`,
            },
            {
                title: t("Unknown backlog"),
                value: formatPlainNumber(data?.unknownBacklog ?? 0),
                icon: "mdi-help-circle-outline",
                color: "#d97706",
                subtitle: `${formatDuration(data?.unknownOldestAgeSeconds ?? 0)} ${t("Oldest")}`,
            },
            {
                title: t("Pending approvals"),
                value: formatPlainNumber(data?.approvalPending ?? 0),
                icon: "mdi-clipboard-check-outline",
                color: (data?.approvalExpired ?? 0) > 0 ? "#dc2626" : "#2563eb",
                subtitle: `${formatPlainNumber(data?.approvalExpired ?? 0)} ${t("Expired")} · ${formatPlainNumber(data?.approvalEmergencyDue ?? 0)} ${t("Emergency due")}`,
            },
            {
                title: t("Open circuit breakers"),
                value: formatPlainNumber(data?.openCircuitBreakers ?? 0),
                icon: "mdi-electric-switch",
                color: (data?.openCircuitBreakers ?? 0) > 0 ? "#dc2626" : "#059669",
                subtitle: `${formatPlainNumber(data?.routeHealth?.degraded ?? 0)} ${t("degraded")}`,
            },
            {
                title: t("Join request SLA"),
                value: formatPlainNumber(data?.joinRequestSlaBreaches ?? 0),
                icon: "mdi-clipboard-account-outline",
                color: (data?.joinRequestSlaBreaches ?? 0) > 0 ? "#d97706" : "#059669",
                subtitle: `${formatPlainNumber(data?.joinRequestOpen ?? 0)} ${t("open")}`,
            },
            {
                title: t("AML SLA"),
                value: formatPlainNumber(data?.amlSlaBreaches ?? 0),
                icon: "mdi-scale-balance",
                color: (data?.amlSlaBreaches ?? 0) > 0 ? "#dc2626" : "#059669",
                subtitle: `${formatPlainNumber(data?.amlOpen ?? 0)} ${t("open")}`,
            },
            {
                title: t("Webhook inbox lag"),
                value: formatDuration(data?.webhookInboxLagSeconds ?? 0),
                icon: "mdi-webhook",
                color: (data?.webhookInboxLagSeconds ?? 0) > 60 ? "#d97706" : "#2563eb",
                subtitle: t("Oldest unprocessed event"),
            },
            {
                title: t("Reconciliation match"),
                value: `${formatPlainNumber(Number(data?.reconciliationMatchRate ?? 0))}%`,
                icon: "mdi-file-compare-outline",
                color: Number(data?.reconciliationMatchRate ?? 0) >= 99 ? "#059669" : "#d97706",
                subtitle: `${formatPlainNumber(data?.reconciliationItems ?? 0)} ${t("items")}`,
            },
        ];
    };

    const attemptsTotal = computed(() =>
        Object.values(overview.value?.attemptsByState ?? {}).reduce((sum, count) => sum + count, 0),
    );

    const attemptRows = computed(() =>
        Object.entries(overview.value?.attemptsByState ?? {})
            .sort(([, left], [, right]) => right - left)
            .map(([state, count]) => ({
                state,
                count,
                percent: attemptsTotal.value === 0 ? 0 : Math.min(100, (count / attemptsTotal.value) * 100),
                amount: overview.value?.volumeByState?.[state] ?? "0.0000",
            })),
    );

    const queueAgeing = computed(() => overview.value?.approvalQueueAgeing ?? []);

    const queueLinks = [
        { title: t("Approvals"), subtitle: `${formatPlainNumber(overview.value?.approvalPending ?? 0)} ${t("pending")}`, icon: "mdi-clipboard-check-outline", route: "Approvals" },
        { title: t("Operator cases"), subtitle: `${formatPlainNumber(overview.value?.operatorOpen ?? 0)} ${t("open")} · ${formatPlainNumber(overview.value?.operatorP1 ?? 0)} P1`, icon: "mdi-alert-octagon-outline", route: "OperatorCases" },
        { title: t("Join requests"), subtitle: `${formatPlainNumber(overview.value?.joinRequestOpen ?? 0)} ${t("open")} · ${formatPlainNumber(overview.value?.joinRequestSlaBreaches ?? 0)} ${t("SLA breaches")}`, icon: "mdi-account-clock-outline", route: "JoinRequests" },
        { title: t("AML cases"), subtitle: `${formatPlainNumber(overview.value?.amlOpen ?? 0)} ${t("open")} · ${formatPlainNumber(overview.value?.amlSlaBreaches ?? 0)} ${t("SLA breaches")}`, icon: "mdi-shield-alert-outline", route: "AmlCases" },
        { title: t("Reconciliation"), subtitle: `${formatPlainNumber(overview.value?.reconciliationItems ?? 0)} ${t("items in period")}`, icon: "mdi-file-compare-outline", route: "Reconciliation" },
        { title: t("Merchants"), subtitle: `${formatPlainNumber(overview.value?.merchantsActive ?? 0)} ${t("active")} · ${formatPlainNumber(overview.value?.merchantsPending ?? 0)} ${t("pending")}`, icon: "mdi-storefront-outline", route: "Merchants" },
    ];

    const routeTone = (state: string) => (state === "OPEN_BREAKER" ? "error" as const : state === "DEGRADED" ? "warning" as const : "success" as const);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Dashboard")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <VSelect
                                modelValue={period.value}
                                onUpdate:modelValue={(value: string) => (period.value = value)}
                                items={PERIODS}
                                density="compact"
                                hideDetails
                                style={{ minWidth: "150px" }}
                            />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => { void load(); void loadRecentActivity(); }}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} disabled={!exportChecklistComplete.value} onClick={() => void exportSnapshot()}>{t("Export snapshot")}</VBtn>
                            <VChip color="primary" variant="tonal" size="small">{t("Operational")}</VChip>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        <VCard variant="tonal">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Snapshot export checklist")}</ThemedText>
                                {EXPORT_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={exportChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (exportChecklist.value = { ...exportChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!exportChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all export checklist items before exporting")}</ThemedText>
                                )}
                            </VCardText>
                        </VCard>

                        <MiniStats stats={stats()} loading={loading.value} />

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                        <ThemedView style={{ gap: "3px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Attempts by state")}</ThemedText>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Payment attempts created in the selected period")}</ThemedText>
                                        </ThemedView>
                                        <StatusChip label={`${formatPlainNumber(attemptsTotal.value)} ${t("attempts")}`} tone="neutral" size="small" />
                                    </ThemedView>
                                    {loading.value ? (
                                        <VProgressLinear indeterminate color="primary" />
                                    ) : attemptRows.value.length === 0 ? (
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>
                                    ) : (
                                        attemptRows.value.map((row) => (
                                            <ThemedView key={row.state} style={{ flexDirection: "column", gap: "4px" }}>
                                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px" }}>
                                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "7px" }}>
                                                        <StatusChip label={row.state} tone={row.state === "SUCCEEDED" ? "success" : row.state === "UNKNOWN" ? "error" : "neutral"} size="x-small" />
                                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatAmount(row.amount)}</ThemedText>
                                                    </ThemedView>
                                                    <ThemedText style={{ fontSize: "13px", fontWeight: "700" }}>{formatPlainNumber(row.count)}</ThemedText>
                                                </ThemedView>
                                                <VProgressLinear modelValue={row.percent} color={row.state === "UNKNOWN" ? "error" : "primary"} height="6px" rounded />
                                            </ThemedView>
                                        ))
                                    )}
                                </VCardText>
                            </VCard>

                            <VCard style={{ flex: "1 1 340px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                    <ThemedView style={{ gap: "3px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Route health")}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Active routes by health state")}</ThemedText>
                                    </ThemedView>
                                    {[
                                        { key: "HEALTHY", label: t("Healthy"), count: overview.value?.routeHealth?.healthy ?? 0 },
                                        { key: "DEGRADED", label: t("Degraded"), count: overview.value?.routeHealth?.degraded ?? 0 },
                                        { key: "OPEN_BREAKER", label: t("Open breaker"), count: overview.value?.routeHealth?.openBreaker ?? 0 },
                                    ].map((row) => (
                                        <ThemedView key={row.key} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                                            <StatusChip label={row.label} tone={routeTone(row.key)} size="small" />
                                            <ThemedText style={{ fontSize: "15px", fontWeight: 700 }}>{formatPlainNumber(row.count)}</ThemedText>
                                        </ThemedView>
                                    ))}
                                    <VBtn size="small" variant="text" prependIcon="mdi-arrow-right" onClick={() => void router.push({ name: "GatewayRoutes" })}>{t("Open routes")}</VBtn>
                                </VCardText>
                            </VCard>

                            <VCard style={{ flex: "1 1 340px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedView style={{ gap: "3px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Approval queue by domain")}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Pending and draft requests by domain")}</ThemedText>
                                    </ThemedView>
                                    {queueAgeing.value.length === 0 ? (
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>
                                    ) : (
                                        queueAgeing.value.map((entry) => (
                                            <ThemedView key={entry.domain} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "7px" }}>
                                                    <StatusChip label={entry.domain} tone={entry.oldestHours >= 72 ? "error" : entry.oldestHours >= 24 ? "warning" : "info"} size="x-small" />
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatHours(entry.oldestHours)}</ThemedText>
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>{formatPlainNumber(entry.count)}</ThemedText>
                                            </ThemedView>
                                        ))
                                    )}
                                    <VBtn size="small" variant="text" prependIcon="mdi-arrow-right" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                </VCardText>
                            </VCard>
                        </ThemedView>

                        {canViewActivity.value && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                        <ThemedView style={{ gap: "3px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Recent privileged activity")}</ThemedText>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Latest audited actions across the portal")}</ThemedText>
                                        </ThemedView>
                                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                            <VBtn size="small" variant="text" prependIcon="mdi-download" loading={activityExportLoading.value} disabled={!activityExportChecklistComplete.value} onClick={() => void exportActivity()}>{t("Export activity")}</VBtn>
                                            <VBtn size="small" variant="text" prependIcon="mdi-history" onClick={() => void router.push({ name: "AuditLog" })}>{t("Open audit log")}</VBtn>
                                        </ThemedView>
                                    </ThemedView>
                                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                        <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Activity export checklist")}</ThemedText>
                                        {ACTIVITY_EXPORT_CHECKS.map((check) => (
                                            <VCheckbox
                                                key={check.key}
                                                modelValue={activityExportChecklist.value[check.key] === true}
                                                onUpdate:modelValue={(value: unknown) => (activityExportChecklist.value = { ...activityExportChecklist.value, [check.key]: Boolean(value) })}
                                                label={t(check.label)}
                                                density="compact"
                                                hideDetails
                                            />
                                        ))}
                                        {!activityExportChecklistComplete.value && (
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all activity export checklist items before exporting")}</ThemedText>
                                        )}
                                    </ThemedView>
                                    {activityLoading.value ? (
                                        <VProgressLinear indeterminate color="primary" />
                                    ) : recentActivity.value.length === 0 ? (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No activity recorded yet.")}</ThemedText>
                                    ) : (
                                        recentActivity.value.map((event) => (
                                            <ThemedView key={event.id} style={{ flexDirection: "row", alignItems: "center", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.14)", paddingBottom: "7px", flexWrap: "wrap" }}>
                                                <ThemedView style={{ gap: "2px", minWidth: "220px", flex: 1 }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{event.action}</ThemedText>
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{event.actorEmail || t("System")} · {event.entityType}</ThemedText>
                                                </ThemedView>
                                                <StatusChip label={event.role} tone="neutral" size="x-small" />
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.55, minWidth: "90px", textAlign: "right" }}>{formatEventTime(event.createdAt)}</ThemedText>
                                            </ThemedView>
                                        ))
                                    )}
                                </VCardText>
                            </VCard>
                        )}

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold">{t("Queues needing attention")}</ThemedText>
                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                                    {queueLinks.map((link) => (
                                        <VCard key={link.title} variant="tonal" style={{ cursor: "pointer" }} onClick={() => void router.push({ name: link.route })}>
                                            <VCardText style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px", padding: "12px" }}>
                                                <VIcon icon={link.icon} size="22" color="primary" />
                                                <ThemedView style={{ gap: "2px" }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{link.title}</ThemedText>
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{link.subtitle}</ThemedText>
                                                </ThemedView>
                                            </VCardText>
                                        </VCard>
                                    ))}
                                </ThemedView>
                            </VCardText>
                        </VCard>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default DashboardPage;
