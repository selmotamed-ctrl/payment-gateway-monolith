import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { EChart } from "@/components/EChart";
import { MoneyText } from "@/components/MoneyText";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatMoney, formatPlainNumber, toDecimal } from "@/utils/money";
import { showSnackBar } from "@/utils/snackBar";

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

    const moneyLine = (label: string, value: string | undefined, color?: string) => (
        <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "5px" }}>
            <ThemedText style={{ fontSize: "13px" }}>{t(label)}</ThemedText>
            <MoneyText value={value ?? "0"} currency={currency()} color={color} bold />
        </ThemedView>
    );

    const summaryCards = () => {
        const entry = data.value;
        if (!entry) return [];
        return [
            { label: t("Gross volume"), value: formatMoney(entry.grossVolume, { currency: currency() }), tone: "info" as const },
            { label: t("Net to merchants"), value: formatMoney(entry.netMerchantAmount, { currency: currency() }), tone: "neutral" as const },
            { label: t("Gross commission"), value: formatMoney(entry.grossCommissionRevenue, { currency: currency() }), tone: "success" as const },
            { label: t("Gateway cost"), value: formatMoney(entry.gatewayCostPeriod, { currency: currency() }), tone: "warning" as const },
            { label: t("Chargeback losses"), value: formatMoney(entry.chargebackLossesPeriod, { currency: currency() }), tone: "error" as const },
            { label: t("Period net contribution"), value: formatMoney(entry.periodNetContribution, { currency: currency() }), tone: toDecimal(entry.periodNetContribution).isNegative() ? "error" as const : "success" as const },
            { label: t("Commission margin"), value: `${formatPlainNumber(entry.commissionMargin, 2)}%`, tone: "info" as const },
            { label: t("Average ticket"), value: formatMoney(entry.averageTicket, { currency: currency() }), tone: "neutral" as const },
        ];
    };

    const railChartOption = () => {
        const rows = data.value?.byRail ?? [];
        return {
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: "#94a3b8" } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: { type: "category", data: rows.map((row) => row.railCode), axisLabel: { color: "#94a3b8" } },
            yAxis: { type: "value", axisLabel: { color: "#94a3b8" } },
            series: [
                { name: t("Gross"), type: "bar", data: rows.map((row) => toDecimal(row.gross).toNumber()), itemStyle: { borderRadius: [4, 4, 0, 0] } },
                { name: t("Gateway cost"), type: "bar", data: rows.map((row) => toDecimal(row.cost).toNumber()) },
            ],
        };
    };

    const dayChartOption = () => {
        const rows = data.value?.byDay ?? [];
        return {
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: "#94a3b8" } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: { type: "category", data: rows.map((row) => row.day), axisLabel: { color: "#94a3b8" } },
            yAxis: { type: "value", axisLabel: { color: "#94a3b8" } },
            series: [
                { name: t("Gross commission"), type: "line", smooth: true, data: rows.map((row) => toDecimal(row.gross).toNumber()) },
                { name: t("Net"), type: "line", smooth: true, data: rows.map((row) => toDecimal(row.net).toNumber()) },
            ],
        };
    };

    const breakdownTable = (
        title: string,
        rows: Array<{ key: string; volume: string; gross: string; cost: string; net: string }>,
    ) => (
        <VCard>
            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <ThemedText type="defaultSemiBold">{t(title)}</ThemedText>
                <ThemedView style={{ flexDirection: "row", gap: "12px", fontSize: "11px", opacity: 0.6, borderBottom: "1px solid rgba(100,116,139,0.2)", paddingBottom: "4px" }}>
                    <span style={{ flex: 1 }}>{t("Name")}</span>
                    <span style={{ width: "130px", textAlign: "right" }}>{t("Volume")}</span>
                    <span style={{ width: "120px", textAlign: "right" }}>{t("Gross")}</span>
                    <span style={{ width: "120px", textAlign: "right" }}>{t("Cost")}</span>
                    <span style={{ width: "120px", textAlign: "right" }}>{t("Net")}</span>
                </ThemedView>
                {rows.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>}
                {rows.map((row) => (
                    <ThemedView key={row.key} style={{ flexDirection: "row", gap: "12px", alignItems: "center", fontSize: "12px", borderBottom: "1px solid rgba(100,116,139,0.1)", paddingBottom: "5px" }}>
                        <span style={{ flex: 1 }}>{row.key}</span>
                        <span style={{ width: "130px", textAlign: "right" }}><MoneyText value={row.volume} currency={currency()} showCurrency={false} /></span>
                        <span style={{ width: "120px", textAlign: "right" }}><MoneyText value={row.gross} currency={currency()} showCurrency={false} /></span>
                        <span style={{ width: "120px", textAlign: "right" }}><MoneyText value={row.cost} currency={currency()} showCurrency={false} /></span>
                        <span style={{ width: "120px", textAlign: "right" }}><MoneyText value={row.net} currency={currency()} showCurrency={false} bold /></span>
                    </ThemedView>
                ))}
            </VCardText>
        </VCard>
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Profitability")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <VSelect
                                items={[
                                    { title: t("Today"), value: "today" },
                                    { title: t("Last 7 days"), value: "last_7d" },
                                    { title: t("Last 30 days"), value: "last_30d" },
                                    { title: t("Last 90 days"), value: "last_90d" },
                                ]}
                                modelValue={period.value}
                                onUpdate:modelValue={(value: string) => {
                                    period.value = value;
                                    void load();
                                }}
                                density="compact"
                                hideDetails
                                style={{ minWidth: "170px" }}
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

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                            {summaryCards().map((item) => (
                                <VCard key={item.label} variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "5px", padding: "14px" }}>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                    </VCardText>
                                </VCard>
                            ))}
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                                        <ThemedText type="defaultSemiBold">{t("Period P&L")}</ThemedText>
                                        <StatusChip label={`${data.value?.windowDays ?? 0} ${t("days")}`} tone="neutral" size="small" />
                                    </ThemedView>
                                    {moneyLine("Gross commission", data.value?.grossCommissionRevenue)}
                                    {moneyLine("Gateway cost (period)", data.value?.gatewayCostPeriod)}
                                    {moneyLine("Period net revenue", data.value?.periodNetRevenue)}
                                    {moneyLine("Chargeback losses (period)", data.value?.chargebackLossesPeriod, "#dc2626")}
                                    {moneyLine("Commission reversed (refunds)", data.value?.refundCommissionReversed, "#d97706")}
                                    {moneyLine("Period net contribution", data.value?.periodNetContribution, "#059669")}
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.5 }}>
                                        {data.value?.succeededAttempts ?? 0} {t("succeeded attempts")} · {t("Average commission")} {formatMoney(data.value?.averageCommission, { currency: currency() })}
                                    </ThemedText>
                                </VCardText>
                            </VCard>

                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Current ledger position")}</ThemedText>
                                    {moneyLine("Gateway cost realized", data.value?.gatewayCostRealized)}
                                    {moneyLine("Gateway cost accrued", data.value?.gatewayCostAccrued)}
                                    {moneyLine("Chargeback reserve movement", data.value?.chargebackLosses, "#dc2626")}
                                    {moneyLine("All-time net revenue", data.value?.netRevenue)}
                                    {moneyLine("All-time net contribution", data.value?.netContribution, "#059669")}
                                    {moneyLine("Commission receivable", data.value?.commissionReceivable)}
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.5 }}>
                                        {t("Gateway cost ratio")} {formatPlainNumber(data.value?.gatewayCostRatio, 2)}% · {t("Net margin")} {formatPlainNumber(data.value?.netMargin, 2)}%
                                    </ThemedText>
                                </VCardText>
                            </VCard>
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText>
                                    <ThemedText type="defaultSemiBold" style={{ marginBottom: "10px" }}>{t("By rail")}</ThemedText>
                                    <EChart option={railChartOption()} height="300px" />
                                </VCardText>
                            </VCard>
                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText>
                                    <ThemedText type="defaultSemiBold" style={{ marginBottom: "10px" }}>{t("By day")}</ThemedText>
                                    <EChart option={dayChartOption()} height="300px" />
                                </VCardText>
                            </VCard>
                        </ThemedView>

                        {breakdownTable("By rail", (data.value?.byRail ?? []).map((row) => ({ key: row.railCode, ...row })))}
                        {breakdownTable("By gateway", (data.value?.byGateway ?? []).map((row) => ({ key: row.gatewayCode, ...row })))}
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default ProfitabilityPage;
