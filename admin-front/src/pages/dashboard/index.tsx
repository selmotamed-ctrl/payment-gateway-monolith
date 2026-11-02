import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VCheckbox, VIcon, VProgressLinear } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { EChart } from "@/components/EChart";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { MonoRef } from "@/components/ui/MonoRef";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { areChecklistsVisible } from "@/constants/env";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatPlainNumber } from "@/utils/money";
import { showSnackBar } from "@/utils/snackBar";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetaPill } from "@/components/ui/MetaPill";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
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

const CHART_TEXT = "#64748b";
const CHART_GRID = "#e2e8f0";
const CHART_INDIGO = "#4f46e5";
const CHART_EMERALD = "#059669";

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
    const showChecklists = areChecklistsVisible();

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

    const exportChecklistComplete = computed(() => !showChecklists || EXPORT_CHECKS.every((check) => exportChecklist.value[check.key] === true));

    const activityExportChecklistComplete = computed(() => !showChecklists || ACTIVITY_EXPORT_CHECKS.every((check) => activityExportChecklist.value[check.key] === true));

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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `dashboard-activity-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `dashboard-${period.value}-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
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

    const metricItems = computed<MetricItem[]>(() => {
        const data = overview.value;
        const openQueues =
            (data?.approvalPending ?? 0) +
            (data?.operatorOpen ?? 0) +
            (data?.joinRequestOpen ?? 0) +
            (data?.amlOpen ?? 0);
        const successRate = Number(data?.successRate ?? 0);
        return [
            {
                key: "volume",
                label: t("Gross Volume"),
                moneyAmount: data?.grossVolume ?? "0",
                currency: "LYD",
                subLabel: `${formatPlainNumber(data?.attemptsTotal ?? 0)} ${t("attempts")}`,
            },
            {
                key: "success",
                label: t("Success Rate"),
                value: `${formatPlainNumber(successRate)}%`,
                badge: successRate >= 90 ? t("Healthy") : successRate >= 70 ? t("Watch") : t("Critical"),
                badgeTone: successRate >= 90 ? "success" : successRate >= 70 ? "warning" : "danger",
                subLabel: `${formatPlainNumber(data?.attemptsSucceeded ?? 0)} ${t("succeeded")}`,
            },
            {
                key: "queues",
                label: t("Open Action Queues"),
                value: formatPlainNumber(openQueues),
                subLabel: `${formatPlainNumber(data?.approvalPending ?? 0)} ${t("approvals")} · ${formatPlainNumber(data?.operatorOpen ?? 0)} ${t("operator cases")}`,
            },
            {
                key: "unknown",
                label: t("Unknown Backlog"),
                value: formatPlainNumber(data?.unknownBacklog ?? 0),
                badge: (data?.unknownBacklog ?? 0) > 0 ? t("Needs review") : t("Clear"),
                badgeTone: (data?.unknownBacklog ?? 0) > 0 ? "warning" : "success",
                subLabel: `${formatDuration(data?.unknownOldestAgeSeconds ?? 0)} ${t("oldest")}`,
            },
        ];
    });

    const periodTabs = PERIODS.map((entry) => ({ value: entry.value, label: entry.title }));

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

    const attemptChartOption = () => ({
        color: [CHART_INDIGO],
        tooltip: { trigger: "axis" },
        grid: { left: "6%", right: "4%", top: "10%", bottom: "18%" },
        xAxis: {
            type: "category",
            data: attemptRows.value.map((row) => row.state),
            axisLabel: { color: CHART_TEXT, fontSize: 10, interval: 0, rotate: attemptRows.value.length > 5 ? 28 : 0 },
            axisLine: { lineStyle: { color: CHART_GRID } },
        },
        yAxis: {
            type: "value",
            axisLabel: { color: CHART_TEXT },
            splitLine: { lineStyle: { color: CHART_GRID } },
        },
        series: [
            {
                name: t("Attempts"),
                type: "bar",
                data: attemptRows.value.map((row) => row.count),
                barMaxWidth: 28,
                itemStyle: { color: CHART_INDIGO, borderRadius: [4, 4, 0, 0] },
            },
        ],
    });

    const volumeChartOption = () => ({
        color: [CHART_EMERALD],
        tooltip: { trigger: "axis" },
        grid: { left: "8%", right: "4%", top: "10%", bottom: "18%" },
        xAxis: {
            type: "category",
            data: attemptRows.value.map((row) => row.state),
            axisLabel: { color: CHART_TEXT, fontSize: 10, interval: 0, rotate: attemptRows.value.length > 5 ? 28 : 0 },
            axisLine: { lineStyle: { color: CHART_GRID } },
        },
        yAxis: {
            type: "value",
            axisLabel: { color: CHART_TEXT },
            splitLine: { lineStyle: { color: CHART_GRID } },
        },
        series: [
            {
                name: t("Volume"),
                type: "bar",
                data: attemptRows.value.map((row) => Number(row.amount)),
                barMaxWidth: 28,
                itemStyle: { color: CHART_EMERALD, borderRadius: [4, 4, 0, 0] },
            },
        ],
    });

    const queueAgeing = computed(() => overview.value?.approvalQueueAgeing ?? []);

    const queueLinks = [
        { title: t("Approvals"), subtitle: `${formatPlainNumber(overview.value?.approvalPending ?? 0)} ${t("pending")}`, icon: "mdi-clipboard-check-outline", route: "Approvals" },
        { title: t("Operator cases"), subtitle: `${formatPlainNumber(overview.value?.operatorOpen ?? 0)} ${t("open")} · ${formatPlainNumber(overview.value?.operatorP1 ?? 0)} P1`, icon: "mdi-alert-octagon-outline", route: "OperatorCases" },
        { title: t("Join requests"), subtitle: `${formatPlainNumber(overview.value?.joinRequestOpen ?? 0)} ${t("open")} · ${formatPlainNumber(overview.value?.joinRequestSlaBreaches ?? 0)} ${t("SLA breaches")}`, icon: "mdi-account-clock-outline", route: "JoinRequests" },
        { title: t("AML cases"), subtitle: `${formatPlainNumber(overview.value?.amlOpen ?? 0)} ${t("open")} · ${formatPlainNumber(overview.value?.amlSlaBreaches ?? 0)} ${t("SLA breaches")}`, icon: "mdi-shield-alert-outline", route: "AmlCases" },
        { title: t("Reconciliation"), subtitle: `${formatPlainNumber(overview.value?.reconciliationItems ?? 0)} ${t("items in period")}`, icon: "mdi-file-compare-outline", route: "Reconciliation" },
        { title: t("Merchants"), subtitle: `${formatPlainNumber(overview.value?.merchantsActive ?? 0)} ${t("active")} · ${formatPlainNumber(overview.value?.merchantsPending ?? 0)} ${t("pending")}`, icon: "mdi-storefront-outline", route: "Merchants" },
    ];

    const routeTone = (state: string) => (state === "OPEN_BREAKER" ? "danger" as const : state === "DEGRADED" ? "warning" as const : "success" as const);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Dashboard")}
                    subtitle={t("Live platform health, volume, and operational queues.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <SegmentedTabs
                                modelValue={period.value}
                                tabs={periodTabs}
                                onUpdate:modelValue={(value: string) => (period.value = value)}
                            />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => { void load(); void loadRecentActivity(); }}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} disabled={!exportChecklistComplete.value} onClick={() => void exportSnapshot()}>{t("Export snapshot")}</VBtn>
                            <MetaPill color="primary" variant="tonal" size="small">{t("Operational")}</MetaPill>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        {showChecklists && (
                            <SurfaceCard>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
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
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}

                        <MetricStrip items={metricItems.value} loading={loading.value} />

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard title={t("Attempts By State")} subtitle={t("Payment attempts created in the selected period")}>
                                {loading.value ? (
                                    <VProgressLinear indeterminate color="primary" />
                                ) : attemptRows.value.length === 0 ? (
                                    <EmptyState title={t("No Data Found")} description={t("No payment attempts were recorded for the selected period.")} />
                                ) : (
                                    <EChart option={attemptChartOption()} height="260px" />
                                )}
                            </SurfaceCard>
                            <SurfaceCard title={t("Volume")} subtitle={t("Attempt volume by state")}>
                                {loading.value ? (
                                    <VProgressLinear indeterminate color="primary" />
                                ) : attemptRows.value.length === 0 ? (
                                    <EmptyState title={t("No Data Found")} description={t("No payment attempts were recorded for the selected period.")} />
                                ) : (
                                    <EChart option={volumeChartOption()} height="260px" />
                                )}
                            </SurfaceCard>
                        </ThemedView>

                        <SurfaceCard title={t("Recent attempts")} subtitle={t("Payment attempts created in the selected period")} noPadding>
                            {loading.value ? (
                                <div style={{ padding: "20px" }}>
                                    <VProgressLinear indeterminate color="primary" />
                                </div>
                            ) : attemptRows.value.length === 0 ? (
                                <EmptyState title={t("No Data Found")} description={t("No payment attempts were recorded for the selected period.")} />
                            ) : (
                                <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                        <thead>
                                            <tr>
                                                <th style={{ textAlign: "start" }}>{t("State")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Attempts")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Volume")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Share")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {attemptRows.value.map((row) => (
                                                <tr key={row.state}>
                                                    <td><StatusBadge status={row.state} /></td>
                                                    <td class="pg-tabular" style={{ textAlign: "end" }}>{formatPlainNumber(row.count)}</td>
                                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.amount} currency="LYD" size="sm" /></td>
                                                    <td class="pg-tabular" style={{ textAlign: "end" }}>{formatPlainNumber(row.percent, 1)}%</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </SurfaceCard>

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard style={{ flex: "1 1 340px" }}>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
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
                                            <StatusBadge status={row.key} label={row.label} toneOverride={routeTone(row.key)} showDot={false} />
                                            <ThemedText style={{ fontSize: "15px", fontWeight: 700 }}>{formatPlainNumber(row.count)}</ThemedText>
                                        </ThemedView>
                                    ))}
                                    <VBtn size="small" variant="text" prependIcon="mdi-arrow-right" onClick={() => void router.push({ name: "GatewayRoutes" })}>{t("Open routes")}</VBtn>
                                </SurfaceCardText>
                            </SurfaceCard>

                            <SurfaceCard style={{ flex: "1 1 340px" }}>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedView style={{ gap: "3px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Approval queue by domain")}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Pending and draft requests by domain")}</ThemedText>
                                    </ThemedView>
                                    {queueAgeing.value.length === 0 ? (
                                        <EmptyState title={t("No Data Found")} description={t("No approval queue entries were recorded for the selected period.")} />
                                    ) : (
                                        queueAgeing.value.map((entry) => (
                                            <ThemedView key={entry.domain} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "7px" }}>
                                                    <StatusBadge status={entry.domain} label={entry.domain} toneOverride={entry.oldestHours >= 72 ? "danger" : entry.oldestHours >= 24 ? "warning" : "info"} showDot={false} />
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatHours(entry.oldestHours)}</ThemedText>
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>{formatPlainNumber(entry.count)}</ThemedText>
                                            </ThemedView>
                                        ))
                                    )}
                                    <VBtn size="small" variant="text" prependIcon="mdi-arrow-right" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                </SurfaceCardText>
                            </SurfaceCard>
                        </ThemedView>

                        {canViewActivity.value && (
                            <SurfaceCard>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
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
                                    {showChecklists && (
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
                                    )}
                                    {activityLoading.value ? (
                                        <VProgressLinear indeterminate color="primary" />
                                    ) : recentActivity.value.length === 0 ? (
                                        <EmptyState title={t("No activity recorded yet.")} description={t("Privileged actions will appear here as operators work.")} icon="mdi-shield-search" />
                                    ) : (
                                        <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                                <thead>
                                                    <tr>
                                                        <th style={{ textAlign: "start" }}>{t("Action")}</th>
                                                        <th style={{ textAlign: "start" }}>{t("Actor")}</th>
                                                        <th style={{ textAlign: "start" }}>{t("Role")}</th>
                                                        <th style={{ textAlign: "start" }}>{t("Entity")}</th>
                                                        <th style={{ textAlign: "end" }}>{t("Time")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {recentActivity.value.map((event) => (
                                                        <tr key={event.id}>
                                                            <td>
                                                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                                    <span style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{event.action}</span>
                                                                    <span style={{ fontSize: "10px", color: "var(--pg-ink-muted)" }}>{event.entityType}</span>
                                                                </div>
                                                            </td>
                                                            <td style={{ fontSize: "12px" }}>{event.actorEmail || t("System")}</td>
                                                            <td><StatusBadge status={event.role} showDot={false} /></td>
                                                            <td><MonoRef value={event.entityId || event.id} truncate={14} /></td>
                                                            <td style={{ textAlign: "end", fontSize: "11px", color: "var(--pg-ink-muted)" }}>{formatEventTime(event.createdAt)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold">{t("Queues needing attention")}</ThemedText>
                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                                    {queueLinks.map((link) => (
                                        <SurfaceCard key={link.title} variant="tonal" style={{ cursor: "pointer" }} onClick={() => void router.push({ name: link.route })}>
                                            <SurfaceCardText style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px", padding: "12px" }}>
                                                <VIcon icon={link.icon} size="22" color="primary" />
                                                <ThemedView style={{ gap: "2px" }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{link.title}</ThemedText>
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{link.subtitle}</ThemedText>
                                                </ThemedView>
                                            </SurfaceCardText>
                                        </SurfaceCard>
                                    ))}
                                </ThemedView>
                            </SurfaceCardText>
                        </SurfaceCard>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default DashboardPage;
