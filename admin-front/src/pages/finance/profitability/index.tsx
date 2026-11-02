import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { EChart } from "@/components/EChart";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatMoney, formatPlainNumber, toDecimal } from "@/utils/money";
import { showSnackBar } from "@/utils/snackBar";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { DescriptionList } from "@/components/ui/DescriptionList";
type Profitability = {
    period?: string;
    currency?: string;
    windowDays?: number;
    windowStart?: string;
    windowEnd?: string;
    succeededAttempts?: number;
    grossVolume?: string;
    grossCommissionRevenue?: string;
    netMerchantAmount?: string;
    gatewayCostRealized?: string;
    gatewayCostAccrued?: string;
    gatewayCostPeriod?: string;
    netRevenue?: string;
    periodNetRevenue?: string;
    chargebackLosses?: string;
    chargebackLossesPeriod?: string;
    periodNetContribution?: string;
    refundCommissionReversed?: string;
    netContribution?: string;
    commissionReceivable?: string;
    commissionMargin?: string;
    gatewayCostRatio?: string;
    netMargin?: string;
    averageTicket?: string;
    averageCommission?: string;
    byRail?: { railCode: string; volume: string; gross: string; cost: string; net: string }[];
    byGateway?: { gatewayCode: string; volume: string; gross: string; cost: string; net: string }[];
    byDay?: { day: string; volume: string; gross: string; cost: string; net: string }[];
};

const CHART_TEXT = "#64748b";
const CHART_GRID = "#e2e8f0";
const CHART_INDIGO = "#4f46e5";
const CHART_EMERALD = "#059669";
const CHART_SLATE = "#64748b";

const ProfitabilityPage = dc(() => {
    const { t } = useLocale();
    const data = ref<Profitability | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const period = ref<string>("last_30d");
    const exportLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.financeProfitability, { params: { period: period.value } });
            data.value = (response.data?.data ?? response.data ?? {}) as Profitability;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const exportSnapshot = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.financeProfitabilityExport, { params: { period: period.value } });
            const snapshot = (response.data?.data ?? response.data ?? {}) as Profitability;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["period", snapshot.period ?? period.value],
                ["currency", snapshot.currency ?? "LYD"],
                ["window_days", snapshot.windowDays ?? ""],
                ["window_start", snapshot.windowStart ?? ""],
                ["window_end", snapshot.windowEnd ?? ""],
                ["succeeded_attempts", snapshot.succeededAttempts ?? 0],
                ["gross_volume", snapshot.grossVolume ?? "0"],
                ["gross_commission_revenue", snapshot.grossCommissionRevenue ?? "0"],
                ["net_merchant_amount", snapshot.netMerchantAmount ?? "0"],
                ["gateway_cost_period", snapshot.gatewayCostPeriod ?? "0"],
                ["gateway_cost_realized", snapshot.gatewayCostRealized ?? "0"],
                ["gateway_cost_accrued", snapshot.gatewayCostAccrued ?? "0"],
                ["period_net_revenue", snapshot.periodNetRevenue ?? "0"],
                ["chargeback_losses_period", snapshot.chargebackLossesPeriod ?? "0"],
                ["period_net_contribution", snapshot.periodNetContribution ?? "0"],
                ["refund_commission_reversed", snapshot.refundCommissionReversed ?? "0"],
                ["commission_receivable", snapshot.commissionReceivable ?? "0"],
                ["commission_margin_percent", snapshot.commissionMargin ?? "0"],
                ["gateway_cost_ratio_percent", snapshot.gatewayCostRatio ?? "0"],
                ["net_margin_percent", snapshot.netMargin ?? "0"],
                ["average_ticket", snapshot.averageTicket ?? "0"],
                ["average_commission", snapshot.averageCommission ?? "0"],
            ];
            for (const row of snapshot.byRail ?? []) {
                rows.push([`rail.${row.railCode}.volume`, row.volume]);
                rows.push([`rail.${row.railCode}.gross`, row.gross]);
                rows.push([`rail.${row.railCode}.cost`, row.cost]);
                rows.push([`rail.${row.railCode}.net`, row.net]);
            }
            for (const row of snapshot.byGateway ?? []) {
                rows.push([`gateway.${row.gatewayCode}.volume`, row.volume]);
                rows.push([`gateway.${row.gatewayCode}.gross`, row.gross]);
                rows.push([`gateway.${row.gatewayCode}.cost`, row.cost]);
                rows.push([`gateway.${row.gatewayCode}.net`, row.net]);
            }
            for (const row of snapshot.byDay ?? []) {
                rows.push([`day.${row.day}.volume`, row.volume]);
                rows.push([`day.${row.day}.gross`, row.gross]);
                rows.push([`day.${row.day}.cost`, row.cost]);
                rows.push([`day.${row.day}.net`, row.net]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `profitability-${period.value}-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Profitability snapshot exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    const currency = () => data.value?.currency ?? "LYD";

    const railChartOption = () => {
        const rows = data.value?.byRail ?? [];
        return {
            color: [CHART_INDIGO, CHART_SLATE],
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: CHART_TEXT } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: {
                type: "category",
                data: rows.map((row) => row.railCode),
                axisLabel: { color: CHART_TEXT },
                axisLine: { lineStyle: { color: CHART_GRID } },
            },
            yAxis: {
                type: "value",
                axisLabel: { color: CHART_TEXT },
                splitLine: { lineStyle: { color: CHART_GRID } },
            },
            series: [
                { name: t("Gross"), type: "bar", data: rows.map((row) => toDecimal(row.gross).toNumber()), itemStyle: { color: CHART_INDIGO, borderRadius: [4, 4, 0, 0] } },
                { name: t("Gateway cost"), type: "bar", data: rows.map((row) => toDecimal(row.cost).toNumber()), itemStyle: { color: CHART_SLATE } },
            ],
        };
    };

    const dayChartOption = () => {
        const rows = data.value?.byDay ?? [];
        return {
            color: [CHART_EMERALD, CHART_INDIGO],
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: CHART_TEXT } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: {
                type: "category",
                data: rows.map((row) => row.day),
                axisLabel: { color: CHART_TEXT },
                axisLine: { lineStyle: { color: CHART_GRID } },
            },
            yAxis: {
                type: "value",
                axisLabel: { color: CHART_TEXT },
                splitLine: { lineStyle: { color: CHART_GRID } },
            },
            series: [
                { name: t("Gross commission"), type: "line", smooth: true, data: rows.map((row) => toDecimal(row.gross).toNumber()), itemStyle: { color: CHART_EMERALD } },
                { name: t("Net"), type: "line", smooth: true, data: rows.map((row) => toDecimal(row.net).toNumber()), itemStyle: { color: CHART_INDIGO } },
            ],
        };
    };

    const breakdownTable = (
        title: string,
        rows: Array<{ key: string; volume: string; gross: string; cost: string; net: string }>,
        monoKey = false,
    ) => (
        <SurfaceCard title={t(title)} noPadding>
            {rows.length === 0 ? (
                <EmptyState title={t("No Data Found")} description={t("No rows match the selected period.")} />
            ) : (
                <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                            <tr>
                                <th style={{ textAlign: "start" }}>{t("Name")}</th>
                                <th style={{ textAlign: "end" }}>{t("Volume")}</th>
                                <th style={{ textAlign: "end" }}>{t("Gross")}</th>
                                <th style={{ textAlign: "end" }}>{t("Cost")}</th>
                                <th style={{ textAlign: "end" }}>{t("Net")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.key}>
                                    <td>{monoKey ? <MonoRef value={row.key} copyable={false} /> : row.key}</td>
                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.volume} currency={currency()} size="sm" showCurrency={false} /></td>
                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.gross} currency={currency()} size="sm" showCurrency={false} /></td>
                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.cost} currency={currency()} size="sm" showCurrency={false} /></td>
                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.net} currency={currency()} size="sm" showCurrency={false} colorSign /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </SurfaceCard>
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Profitability")}
                    subtitle={t("Review gross commission, gateway cost, and net contribution across rails and gateways.")}
                    badge={t("Margin control")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <SegmentedTabs
                                modelValue={period.value}
                                onUpdate:modelValue={(value: string) => {
                                    if (period.value === value) return;
                                    period.value = value;
                                    void load();
                                }}
                                tabs={[
                                    { value: "today", label: t("Today") },
                                    { value: "last_7d", label: t("Last 7 days") },
                                    { value: "last_30d", label: t("Last 30 days") },
                                    { value: "last_90d", label: t("Last 90 days") },
                                ]}
                            />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSnapshot()}>{t("Export snapshot")}</VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <VAlert type="info" variant="tonal">
                            {t("Period P&L uses succeeded attempts and executed chargeback/refund adjustments. Ledger positions are current balances, not period movements.")}
                        </VAlert>

                        <MetricStrip items={[
                            { key: "volume", label: t("Gross volume"), moneyAmount: data.value?.grossVolume ?? "0", currency: currency(), subLabel: `${t("Net to merchants")}: ${formatMoney(data.value?.netMerchantAmount, { currency: currency() })}` },
                            { key: "commission", label: t("Gross commission"), moneyAmount: data.value?.grossCommissionRevenue ?? "0", currency: currency() },
                            { key: "gatewayCost", label: t("Gateway cost"), moneyAmount: data.value?.gatewayCostPeriod ?? "0", currency: currency() },
                            { key: "chargeback", label: t("Chargeback losses"), moneyAmount: data.value?.chargebackLossesPeriod ?? "0", currency: currency() },
                            { key: "netContribution", label: t("Net Contribution"), moneyAmount: data.value?.periodNetContribution ?? "0", currency: currency(), subLabel: `${formatPlainNumber(data.value?.commissionMargin, 2)}% ${t("Commission margin")}` },
                        ]} />

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard title={t("Period P&L")}>
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <ThemedView style={{ display: "flex", justifyContent: "flex-end" }}>
                                        <StatusBadge status="WINDOW" label={`${data.value?.windowDays ?? 0} ${t("days")}`} toneOverride="neutral" showDot={false} />
                                    </ThemedView>
                                    <DescriptionList
                                        items={[
                                            { label: t("Gross commission"), value: data.value?.grossCommissionRevenue ?? "0", money: true, currency: currency() },
                                            { label: t("Gateway cost (period)"), value: data.value?.gatewayCostPeriod ?? "0", money: true, currency: currency() },
                                            { label: t("Period net revenue"), value: data.value?.periodNetRevenue ?? "0", money: true, currency: currency() },
                                            { label: t("Chargeback losses (period)"), value: data.value?.chargebackLossesPeriod ?? "0", money: true, currency: currency() },
                                            { label: t("Commission reversed (refunds)"), value: data.value?.refundCommissionReversed ?? "0", money: true, currency: currency() },
                                            {
                                                label: t("Period net contribution"),
                                                value: <MoneyDisplay amount={data.value?.periodNetContribution ?? "0"} currency={currency()} size="md" colorSign />,
                                            },
                                        ]}
                                    />
                                    <ThemedText style={{ fontSize: "10px", color: "var(--pg-ink-muted)" }}>
                                        {data.value?.succeededAttempts ?? 0} {t("succeeded attempts")} · {t("Average commission")} {formatMoney(data.value?.averageCommission, { currency: currency() })} · {t("Average ticket")} {formatMoney(data.value?.averageTicket, { currency: currency() })}
                                    </ThemedText>
                                </ThemedView>
                            </SurfaceCard>

                            <SurfaceCard title={t("Current ledger position")}>
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <DescriptionList
                                        items={[
                                            { label: t("Gateway cost realized"), value: data.value?.gatewayCostRealized ?? "0", money: true, currency: currency() },
                                            { label: t("Gateway cost accrued"), value: data.value?.gatewayCostAccrued ?? "0", money: true, currency: currency() },
                                            { label: t("Chargeback reserve movement"), value: data.value?.chargebackLosses ?? "0", money: true, currency: currency() },
                                            { label: t("All-time net revenue"), value: data.value?.netRevenue ?? "0", money: true, currency: currency() },
                                            {
                                                label: t("All-time net contribution"),
                                                value: <MoneyDisplay amount={data.value?.netContribution ?? "0"} currency={currency()} size="md" colorSign />,
                                            },
                                            { label: t("Commission receivable"), value: data.value?.commissionReceivable ?? "0", money: true, currency: currency() },
                                        ]}
                                    />
                                    <ThemedText style={{ fontSize: "10px", color: "var(--pg-ink-muted)" }}>
                                        {t("Gateway cost ratio")} {formatPlainNumber(data.value?.gatewayCostRatio, 2)}% · {t("Net margin")} {formatPlainNumber(data.value?.netMargin, 2)}%
                                    </ThemedText>
                                </ThemedView>
                            </SurfaceCard>
                        </ThemedView>

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard title={t("By rail")}>
                                {(data.value?.byRail ?? []).length === 0 ? (
                                    <EmptyState title={t("No Data Found")} description={t("No rows match the selected period.")} />
                                ) : (
                                    <EChart option={railChartOption()} height="300px" />
                                )}
                            </SurfaceCard>
                            <SurfaceCard title={t("By day")}>
                                {(data.value?.byDay ?? []).length === 0 ? (
                                    <EmptyState title={t("No Data Found")} description={t("No rows match the selected period.")} />
                                ) : (
                                    <EChart option={dayChartOption()} height="300px" />
                                )}
                            </SurfaceCard>
                        </ThemedView>

                        {breakdownTable("By rail", (data.value?.byRail ?? []).map((row) => ({ key: row.railCode, ...row })), true)}
                        {breakdownTable("By gateway", (data.value?.byGateway ?? []).map((row) => ({ key: row.gatewayCode, ...row })), true)}
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default ProfitabilityPage;
