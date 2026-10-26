import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VCard, VCardText } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

type Liquidity = {
    currency?: string;
    treasuryBalance?: string;
    clearingBalances?: string;
    obligations?: string;
    coverRatio?: string;
    clearingAgeing?: { gatewayCode: string; t0: string; t1: string; t2: string; older: string; settlementLagDays: number }[];
    cashoutQueue?: { pending: string; processing: string; completed: string; nextDayDemand: string } | null;
    holdsAndReserves?: { amlHold: string; chargebackReserve: string; oldestItemAgeDays: number; bySeverity: Record<string, number> };
    receivables?: { commissionReceivable: string; negativeBalances: string; ceiling: string };
};

const LiquidityPage = dc(() => {
    const { t } = useLocale();
    const data = ref<Liquidity | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.financeLiquidity);
            data.value = (response.data?.data ?? response.data ?? {}) as Liquidity;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const currency = () => data.value?.currency ?? "LYD";

    const line = (label: string, value: string | undefined, color?: string) => (
        <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
            <ThemedText style={{ fontSize: "13px" }}>{t(label)}</ThemedText>
            <MoneyText value={value ?? "0"} currency={currency()} color={color} bold />
        </ThemedView>
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Liquidity")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                        <VCard style={{ flex: "1 1 340px" }}>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Treasury Cover")}</ThemedText>
                                {line("Treasury Balance", data.value?.treasuryBalance)}
                                {line("Clearing Ageing", data.value?.clearingBalances)}
                                {line("Receivables", data.value?.obligations)}
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                                    <ThemedText style={{ fontSize: "13px" }}>{t("Treasury Cover")}</ThemedText>
                                    <ThemedText style={{ fontSize: "14px", fontWeight: "700" }}>
                                        {data.value?.coverRatio ?? "-"}
                                    </ThemedText>
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        <VCard style={{ flex: "1 1 340px" }}>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Cash-Out Queue")}</ThemedText>
                                {line("Pending", data.value?.cashoutQueue?.pending)}
                                {line("Processing", data.value?.cashoutQueue?.processing)}
                                {line("Complete", data.value?.cashoutQueue?.completed)}
                                {line("Amount Due", data.value?.cashoutQueue?.nextDayDemand)}
                            </VCardText>
                        </VCard>

                        <VCard style={{ flex: "1 1 340px" }}>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Holds And Reserves")}</ThemedText>
                                {line("Holds And Reserves", data.value?.holdsAndReserves?.amlHold)}
                                {line("Chargeback", data.value?.holdsAndReserves?.chargebackReserve)}
                                {line("Commission Receivable", data.value?.receivables?.commissionReceivable)}
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                                    <ThemedText style={{ fontSize: "13px" }}>{t("Oldest")}</ThemedText>
                                    <StatusChip
                                        label={`${data.value?.holdsAndReserves?.oldestItemAgeDays ?? 0}d`}
                                        tone="warning"
                                    />
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        <VCard style={{ flex: "1 1 100%" }}>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Clearing Ageing")}</ThemedText>
                                {(data.value?.clearingAgeing ?? []).map((row) => (
                                    <ThemedView
                                        key={row.gatewayCode}
                                        style={{ flexDirection: "row", gap: "14px", alignItems: "center", fontSize: "13px" }}
                                    >
                                        <span style={{ flex: 1 }}>{row.gatewayCode}</span>
                                        <span>{t("T+0")}: {row.t0}</span>
                                        <span>{t("T+1")}: {row.t1}</span>
                                        <span>{t("T+2")}: {row.t2}</span>
                                        <span>{t("Older")}: {row.older}</span>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    </ThemedView>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default LiquidityPage;
