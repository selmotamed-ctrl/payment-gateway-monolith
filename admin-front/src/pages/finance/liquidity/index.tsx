import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText } from "vuetify/components";
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
    clearingAgeing?: { bucket: string; count: number; amount: string }[];
    clearingByGateway?: { gatewayId: string; gatewayCode: string; gatewayName: string; balance: string; t0: string; t1: string; t2: string; older: string }[];
    checkedAt?: string;
    cashoutQueue?: { pending: string; processing: string; completed: string; nextDayDemand: string } | null;
    holdsAndReserves?: { amlHold: string; chargebackReserve: string; suspense: string; oldestItemAgeDays: number; bySeverity: Record<string, number> };
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
                <PageHeader
                    title={t("Liquidity")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {data.value?.checkedAt && <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Updated")} {new Date(data.value.checkedAt).toLocaleTimeString()}</ThemedText>}
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <ThemedView style={{ flexDirection: "column", gap: "18px" }}>
                        {Number(data.value?.coverRatio ?? 1) < 1 && (
                            <VAlert type="error" variant="tonal">
                                {t("Treasury cover is below 1. Review clearing balances and cash-out demand before releasing payouts.")}
                            </VAlert>
                        )}
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
                                {line("Suspense", data.value?.holdsAndReserves?.suspense)}
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
                                <ThemedText type="defaultSemiBold">{t("Clearing by gateway")}</ThemedText>
                                {(data.value?.clearingByGateway ?? []).length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No gateway clearing balances")}</ThemedText>}
                                {(data.value?.clearingByGateway ?? []).map((row) => (
                                    <ThemedView
                                        key={row.gatewayId}
                                        style={{ flexDirection: "row", gap: "14px", alignItems: "center", fontSize: "13px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "6px" }}
                                    >
                                        <ThemedView style={{ flex: 1, gap: "2px" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.gatewayCode}</ThemedText>
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.gatewayName}</ThemedText>
                                        </ThemedView>
                                        <MoneyText value={row.balance} currency={currency()} bold />
                                        <span style={{ opacity: 0.55 }}>{t("T+0")}: {row.t0}</span>
                                        <span style={{ opacity: 0.55 }}>{t("T+1")}: {row.t1}</span>
                                        <span style={{ opacity: 0.55 }}>{t("T+2")}: {row.t2}</span>
                                        <span style={{ opacity: 0.55 }}>{t("Older")}: {row.older}</span>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Settlement ageing")}</ThemedText>
                                {(data.value?.clearingAgeing ?? []).map((row) => (
                                    <ThemedView key={row.bucket} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", fontSize: "13px" }}>
                                        <ThemedText>{row.bucket}</ThemedText>
                                        <ThemedText>{row.count} {t("attempts")}</ThemedText>
                                        <MoneyText value={row.amount} currency={currency()} />
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                        </ThemedView>
                    </ThemedView>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default LiquidityPage;
