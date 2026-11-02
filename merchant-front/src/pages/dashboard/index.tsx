import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";

import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { EChart } from "@/components/EChart";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";

import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatPlainNumber, toDecimal } from "@/utils/money";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
type Overview = {
    currency?: string;
    walletBalance?: string;
    todayVolume?: string;
    successRate?: string;
    pendingCashouts?: string;
    recentPayments?: {
        id: string;
        reference: string;
        railCode: string;
        amount: string;
        currency: string;
        status: string;
        createdAt: string;
    }[];
    volumeByDay?: { day: string; gross: string; commission: string; net: string }[];
    volumeByRail?: { railCode: string; gross: string; count: number }[];
};

const DashboardPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const chartInk = () => theme.current.value.colors["on-surface-variant"];
    const overview = ref<Overview | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const period = ref("last_30d");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.statsOverview, {
                params: { period: period.value },
            });
            overview.value = (response.data?.data ?? response.data ?? {}) as Overview;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const currency = () => overview.value?.currency ?? "LYD";

    const metricItems = computed<MetricItem[]>(() => [
        {
            key: "balance",
            label: t("Wallet Balance"),
            moneyAmount: overview.value?.walletBalance ?? "0",
            currency: currency(),
        },
        {
            key: "volume",
            label: t("Monthly Volume"),
            moneyAmount: overview.value?.todayVolume ?? "0",
            currency: currency(),
        },
        {
            key: "success",
            label: t("Success Rate"),
            value: `${overview.value?.successRate ?? "0"}%`,
            badge: Number(overview.value?.successRate ?? 0) >= 90 ? t("Healthy") : t("Watch"),
            badgeTone: Number(overview.value?.successRate ?? 0) >= 90 ? "success" : "warning",
        },
        {
            key: "cashouts",
            label: t("Cash-Outs"),
            value: overview.value?.pendingCashouts ?? "0",
        },
    ]);

    const periodTabs = [
        { value: "today", label: t("Today") },
        { value: "last_7d", label: t("7D") },
        { value: "last_30d", label: t("30D") },
        { value: "last_90d", label: t("90D") },
    ];

    const volumeChart = () => {
        const rows = overview.value?.volumeByDay ?? [];
        return {
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: chartInk() } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: { type: "category", data: rows.map((row) => row.day), axisLabel: { color: chartInk() } },
            yAxis: { type: "value", axisLabel: { color: chartInk() } },
            series: [
                {
                    name: t("Gross"),
                    type: "bar",
                    data: rows.map((row) => Number(toDecimal(row.gross).toString())),
                    itemStyle: { borderRadius: [4, 4, 0, 0] },
                },
                {
                    name: t("Commission"),
                    type: "bar",
                    data: rows.map((row) => Number(toDecimal(row.commission).toString())),
                },
                {
                    name: t("Net"),
                    type: "line",
                    smooth: true,
                    data: rows.map((row) => Number(toDecimal(row.net).toString())),
                },
            ],
        };
    };

    const railChart = () => {
        const rows = overview.value?.volumeByRail ?? [];
        return {
            tooltip: { trigger: "item" },
            legend: { textStyle: { color: chartInk() } },
            series: [
                {
                    name: t("By Rail"),
                    type: "pie",
                    radius: ["42%", "68%"],
                    data: rows.map((row) => ({
                        name: row.railCode,
                        value: Number(toDecimal(row.gross).toString()),
                    })),
                },
            ],
        };
    };

    const paymentHeaders: TableHeader<any>[] = [
        { key: "reference", label: "Reference", value: (row) => row.reference, Value: ({ row }) => <MonoRef value={row.reference} truncate={18} /> },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        { key: "amount", label: "Amount", value: (row) => row.amount, Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "status", label: "Status", value: (row) => row.status, Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Dashboard")}
                    subtitle={t("Your wallet, payment volume, and settlement posture.")}
                    end={() => (
                        <SegmentedTabs
                            modelValue={period.value}
                            tabs={periodTabs}
                            onUpdate:modelValue={(value: string) => {
                                period.value = value;
                                void load();
                            }}
                        />
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        <MetricStrip items={metricItems.value} loading={loading.value} />

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <SurfaceCard title={t("Monthly Volume")} style={{ flex: "1 1 440px" }}>
                                <EChart option={volumeChart()} height="300px" />
                            </SurfaceCard>
                            <SurfaceCard title={t("By Rail")} style={{ flex: "1 1 340px" }}>
                                <EChart option={railChart()} height="300px" />
                            </SurfaceCard>
                        </ThemedView>

                        <DataTable
                            title={t("Recent Payments")}
                            data={overview.value?.recentPayments ?? []}
                            headers={paymentHeaders}
                            loading={loading.value}
                            showNumber={false}
                            xlsx={false}
                            noElevation={true}
                        />

                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                            <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                {t("Gross")}: <MoneyDisplay amount={overview.value?.todayVolume ?? "0"} currency={currency()} />
                            </ThemedText>
                            <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                {formatPlainNumber(overview.value?.volumeByRail?.length ?? 0)} {t("By Rail")}
                            </ThemedText>
                        </ThemedView>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default DashboardPage;
