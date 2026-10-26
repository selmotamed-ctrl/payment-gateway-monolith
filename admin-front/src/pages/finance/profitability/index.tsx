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
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatMoney, toDecimal } from "@/utils/money";

type Profitability = {
    period?: string;
    currency?: string;
    grossCommissionRevenue?: string;
    gatewayCostRealized?: string;
    gatewayCostAccrued?: string;
    netRevenue?: string;
    chargebackLosses?: string;
    refundCommissionReversed?: string;
    netContribution?: string;
    commissionReceivable?: string;
    byRail?: { railCode: string; gross: string; cost: string; net: string }[];
    byGateway?: { gatewayCode: string; gross: string; cost: string; net: string }[];
    byDay?: { day: string; gross: string; cost: string; net: string }[];
};

const ProfitabilityPage = dc(() => {
    const { t } = useLocale();
    const data = ref<Profitability | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const period = ref<string>("last_30d");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.financeProfitability, {
                params: { period: period.value },
            });
            data.value = (response.data?.data ?? response.data ?? {}) as Profitability;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const currency = () => data.value?.currency ?? "LYD";

    const moneyLine = (label: string, value: string | undefined, color?: string) => (
        <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
            <ThemedText style={{ fontSize: "13px" }}>{t(label)}</ThemedText>
            <MoneyText value={value ?? "0"} currency={currency()} color={color} bold />
        </ThemedView>
    );

    const railChartOption = () => {
        const rows = data.value?.byRail ?? [];
        return {
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: "#94a3b8" } },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: { type: "category", data: rows.map((row) => row.railCode), axisLabel: { color: "#94a3b8" } },
            yAxis: { type: "value", axisLabel: { color: "#94a3b8" } },
            series: [
                {
                    name: t("Gross"),
                    type: "bar",
                    data: rows.map((row) => Number(toDecimal(row.gross).toString())),
                    itemStyle: { borderRadius: [4, 4, 0, 0] },
                },
                {
                    name: t("Gateway Cost Realized"),
                    type: "bar",
                    data: rows.map((row) => Number(toDecimal(row.cost).toString())),
                },
            ],
        };
    };

    const dayChartOption = () => {
        const rows = data.value?.byDay ?? [];
        return {
            tooltip: { trigger: "axis" },
            grid: { left: "8%", right: "4%", top: "12%", bottom: "12%" },
            xAxis: { type: "category", data: rows.map((row) => row.day), axisLabel: { color: "#94a3b8" } },
            yAxis: { type: "value", axisLabel: { color: "#94a3b8" } },
            series: [
                {
                    name: t("Net Contribution"),
                    type: "line",
                    smooth: true,
                    data: rows.map((row) => Number(toDecimal(row.net).toString())),
                },
            ],
        };
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Profitability")}
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
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Net Contribution")}</ThemedText>
                                {moneyLine("Gross Commission Revenue", data.value?.grossCommissionRevenue)}
                                {moneyLine("Gateway Cost Realized", data.value?.gatewayCostRealized)}
                                {moneyLine("Gateway Cost Accrued", data.value?.gatewayCostAccrued)}
                                {moneyLine("Net Revenue", data.value?.netRevenue)}
                                {moneyLine("Chargeback Losses", data.value?.chargebackLosses, "#dc2626")}
                                {moneyLine("Net Contribution", data.value?.netContribution, "#059669")}
                                {moneyLine("Commission Receivable", data.value?.commissionReceivable)}
                            </VCardText>
                        </VCard>

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText>
                                    <ThemedText type="defaultSemiBold" style={{ marginBottom: "10px" }}>
                                        {t("By Rail")}
                                    </ThemedText>
                                    <EChart option={railChartOption()} height="300px" />
                                </VCardText>
                            </VCard>
                            <VCard style={{ flex: "1 1 420px" }}>
                                <VCardText>
                                    <ThemedText type="defaultSemiBold" style={{ marginBottom: "10px" }}>
                                        {t("By Day")}
                                    </ThemedText>
                                    <EChart option={dayChartOption()} height="300px" />
                                </VCardText>
                            </VCard>
                        </ThemedView>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("By Gateway")}</ThemedText>
                                {(data.value?.byGateway ?? []).map((row) => (
                                    <ThemedView
                                        key={row.gatewayCode}
                                        style={{ flexDirection: "row", gap: "14px", alignItems: "center", fontSize: "13px" }}
                                    >
                                        <span style={{ flex: 1 }}>{row.gatewayCode}</span>
                                        <span>{formatMoney(row.gross, { currency: currency() })}</span>
                                        <span>{formatMoney(row.cost, { currency: currency() })}</span>
                                        <span>{formatMoney(row.net, { currency: currency() })}</span>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default ProfitabilityPage;
