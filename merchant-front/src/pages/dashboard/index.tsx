import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VCard, VCardText, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { EChart } from "@/components/EChart";
import { MiniStats, type StatItem } from "@/components/MiniStats";
import { MoneyText } from "@/components/MoneyText";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatPlainNumber, toDecimal } from "@/utils/money";

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

    const stats = (): StatItem[] => [
        {
            title: t("Wallet Balance"),
            value: overview.value?.walletBalance ?? "0",
            icon: "mdi-wallet-outline",
            color: "#0f6bff",
        },
        {
            title: t("Monthly Volume"),
            value: overview.value?.todayVolume ?? "0",
            icon: "mdi-chart-bar",
            color: "#059669",
        },
        {
            title: t("Success Rate"),
            value: `${overview.value?.successRate ?? "0"}%`,
            icon: "mdi-check-circle-outline",
            color: "#00b8a9",
        },
        {
            title: t("Cash-Outs"),
            value: overview.value?.pendingCashouts ?? "0",
            icon: "mdi-cash-fast",
            color: "#d97706",
        },
    ];

    const volumeChart = () => {
        const rows = overview.value?.volumeByDay ?? [];
        return {
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: "#94a3b8" } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: { type: "category", data: rows.map((row) => row.day), axisLabel: { color: "#94a3b8" } },
            yAxis: { type: "value", axisLabel: { color: "#94a3b8" } },
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
            legend: { textStyle: { color: "#94a3b8" } },
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
        { key: "reference", label: "Reference", value: (row) => row.reference },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        { key: "amount", label: "Amount", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "status", label: "Status", value: (row) => row.status },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Dashboard")}
                    end={() => (
                        <VSelect
                            items={[
                                { title: t("Today"), value: "today" },
                                { title: t("Last 7 days"), value: "last_7d" },
                                { title: t("Last 30 days"), value: "last_30d" },
                                { title: t("Last 90 days"), value: "last_90d" },
                            ]}
                            modelValue={period.value}
                            onUpdate:modelValue={(v: string) => {
                                period.value = v;
                                void load();
                            }}
                            density="compact"
                            hideDetails
                            style={{ minWidth: "170px" }}
                        />
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        <MiniStats stats={stats()} loading={loading.value} />

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 440px" }}>
                                <VCardText>
                                    <ThemedText type="defaultSemiBold" style={{ marginBottom: "10px" }}>
                                        {t("Monthly Volume")}
                                    </ThemedText>
                                    <EChart option={volumeChart()} height="300px" />
                                </VCardText>
                            </VCard>
                            <VCard style={{ flex: "1 1 340px" }}>
                                <VCardText>
                                    <ThemedText type="defaultSemiBold" style={{ marginBottom: "10px" }}>
                                        {t("By Rail")}
                                    </ThemedText>
                                    <EChart option={railChart()} height="300px" />
                                </VCardText>
                            </VCard>
                        </ThemedView>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <DataTable
                                    title={t("Recent Payments")}
                                    data={overview.value?.recentPayments ?? []}
                                    headers={paymentHeaders}
                                    loading={loading.value}
                                    showNumber={false}
                                    xlsx={false}
                                    noElevation={true}
                                />
                            </VCardText>
                        </VCard>

                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                {t("Gross")}: <MoneyText value={overview.value?.todayVolume ?? "0"} currency={currency()} />
                            </ThemedText>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
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
