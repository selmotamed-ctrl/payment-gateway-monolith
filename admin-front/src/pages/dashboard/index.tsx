import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VCard, VCardText, VChip, VIcon, VProgressLinear, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { MiniStats, type StatItem } from "@/components/MiniStats";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatPlainNumber } from "@/utils/money";

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

    watch(period, () => void load());
    void load();

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
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                            <VChip color="primary" variant="tonal" size="small">{t("Operational")}</VChip>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
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
