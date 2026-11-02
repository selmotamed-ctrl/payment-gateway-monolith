import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
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
    const exportLoading = ref(false);

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

    const exportSnapshot = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.financeLiquidityExport);
            const snapshot = (response.data?.data ?? response.data ?? {}) as Liquidity;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["checked_at", snapshot.checkedAt ?? ""],
                ["currency", snapshot.currency ?? "LYD"],
                ["treasury_balance", snapshot.treasuryBalance ?? "0"],
                ["clearing_balances", snapshot.clearingBalances ?? "0"],
                ["wallet_obligations", snapshot.obligations ?? "0"],
                ["cover_ratio", snapshot.coverRatio ?? "0"],
                ["cashout_pending", snapshot.cashoutQueue?.pending ?? "0"],
                ["cashout_processing", snapshot.cashoutQueue?.processing ?? "0"],
                ["cashout_completed", snapshot.cashoutQueue?.completed ?? "0"],
                ["cashout_next_day_demand", snapshot.cashoutQueue?.nextDayDemand ?? "0"],
                ["aml_hold", snapshot.holdsAndReserves?.amlHold ?? "0"],
                ["chargeback_reserve", snapshot.holdsAndReserves?.chargebackReserve ?? "0"],
                ["suspense", snapshot.holdsAndReserves?.suspense ?? "0"],
                ["oldest_item_age_days", snapshot.holdsAndReserves?.oldestItemAgeDays ?? 0],
                ["commission_receivable", snapshot.receivables?.commissionReceivable ?? "0"],
            ];
            for (const row of snapshot.clearingAgeing ?? []) {
                rows.push([`clearing_ageing.${row.bucket}.count`, row.count]);
                rows.push([`clearing_ageing.${row.bucket}.amount`, row.amount]);
            }
            for (const row of snapshot.clearingByGateway ?? []) {
                rows.push([`gateway.${row.gatewayCode}.balance`, row.balance]);
                rows.push([`gateway.${row.gatewayCode}.t0`, row.t0]);
                rows.push([`gateway.${row.gatewayCode}.t1`, row.t1]);
                rows.push([`gateway.${row.gatewayCode}.t2`, row.t2]);
                rows.push([`gateway.${row.gatewayCode}.older`, row.older]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `liquidity-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Liquidity snapshot exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    const currency = () => data.value?.currency ?? "LYD";

    const line = (label: string, value: string | undefined, sign = false) => (
        <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
            <ThemedText style={{ fontSize: "13px" }}>{t(label)}</ThemedText>
            <MoneyDisplay amount={value ?? "0"} currency={currency()} size="lg" colorSign={sign} />
        </ThemedView>
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Liquidity")}
                    subtitle={t("Monitor treasury cover, clearing ageing, cash-out demand, and held balances.")}
                    badge={t("Treasury control")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {data.value?.checkedAt && <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Updated")} {new Date(data.value.checkedAt).toLocaleTimeString()}</ThemedText>}
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
                    <ThemedView style={{ flexDirection: "column", gap: "18px" }}>
                        {Number(data.value?.coverRatio ?? 1) < 1 && (
                            <VAlert type="error" variant="tonal">
                                {t("Treasury cover is below 1. Review clearing balances and cash-out demand before releasing payouts.")}
                            </VAlert>
                        )}

                        <MetricStrip items={[
                            { key: "treasury", label: t("Treasury Balance"), moneyAmount: data.value?.treasuryBalance ?? "0", currency: currency() },
                            { key: "clearing", label: t("Clearing Ageing"), moneyAmount: data.value?.clearingBalances ?? "0", currency: currency() },
                            { key: "receivables", label: t("Receivables"), moneyAmount: data.value?.obligations ?? "0", currency: currency() },
                            { key: "cover", label: t("Treasury Cover"), value: data.value?.coverRatio ?? "-", badge: Number(data.value?.coverRatio ?? 1) < 1 ? t("Failed") : t("Passed"), badgeTone: Number(data.value?.coverRatio ?? 1) < 1 ? "danger" : "success" },
                        ]} />

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                        <SurfaceCard style={{ flex: "1 1 340px" }}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Cash-Out Queue")}</ThemedText>
                                {line("Pending", data.value?.cashoutQueue?.pending)}
                                {line("Processing", data.value?.cashoutQueue?.processing)}
                                {line("Complete", data.value?.cashoutQueue?.completed)}
                                {line("Amount Due", data.value?.cashoutQueue?.nextDayDemand)}
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard style={{ flex: "1 1 340px" }}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
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
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard style={{ flex: "1 1 100%" }}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold">{t("Clearing by gateway")}</ThemedText>
                                {(data.value?.clearingByGateway ?? []).length === 0 && <EmptyState title={t("No gateway clearing balances")} description={t("No gateway clearing balances are available for this snapshot.")} />}
                                {(data.value?.clearingByGateway ?? []).map((row) => (
                                    <ThemedView
                                        key={row.gatewayId}
                                        style={{ flexDirection: "row", gap: "14px", alignItems: "center", fontSize: "13px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "6px" }}
                                    >
                                        <ThemedView style={{ flex: 1, gap: "2px" }}>
                                            <MonoRef value={row.gatewayCode} copyable={false} />
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.gatewayName}</ThemedText>
                                        </ThemedView>
                                        <MoneyDisplay amount={row.balance} currency={currency()} size="lg" />
                                        <span style={{ opacity: 0.55 }}>{t("T+0")}: {row.t0}</span>
                                        <span style={{ opacity: 0.55 }}>{t("T+1")}: {row.t1}</span>
                                        <span style={{ opacity: 0.55 }}>{t("T+2")}: {row.t2}</span>
                                        <span style={{ opacity: 0.55 }}>{t("Older")}: {row.older}</span>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Settlement ageing")}</ThemedText>
                                {(data.value?.clearingAgeing ?? []).map((row) => (
                                    <ThemedView key={row.bucket} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", fontSize: "13px" }}>
                                        <ThemedText>{row.bucket}</ThemedText>
                                        <ThemedText>{row.count} {t("attempts")}</ThemedText>
                                        <MoneyDisplay amount={row.amount} currency={currency()} size="md" />
                                    </ThemedView>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                        </ThemedView>
                    </ThemedView>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default LiquidityPage;
