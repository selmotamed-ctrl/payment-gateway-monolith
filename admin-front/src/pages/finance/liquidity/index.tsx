import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VProgressLinear } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { buildCapViews, type CapTone, type RouteCapRow } from "./routeCaps";
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

type RouteCapsPayload = { currency?: string; timeZone?: string; businessDay?: { since: string; until: string }; routes?: RouteCapRow[] };

const CAP_COLOR: Record<CapTone, string> = { success: "success", warning: "warning", danger: "error", neutral: "secondary" };

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

    // ---- live route daily-cap utilisation (separate call: a failure must not hide the snapshot)
    const caps = ref<RouteCapsPayload | null>(null);
    const capsError = ref<string | null>(null);
    const loadCaps = async () => {
        capsError.value = null;
        try {
            const response = await api.get(urlsMap.financeRouteCaps);
            caps.value = (response.data?.data ?? response.data ?? {}) as RouteCapsPayload;
        } catch (e) {
            caps.value = null;
            capsError.value = extractApiErrorMessage(e);
        }
    };
    const capViews = computed(() => buildCapViews(caps.value?.routes ?? []));

    const refreshAll = () => {
        void load();
        void loadCaps();
    };

    void load();
    void loadCaps();

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
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={refreshAll}>{t("Refresh")}</VBtn>
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

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard title={t("Cash-Out Queue")}>
                                <DescriptionList
                                    items={[
                                        { label: t("Pending"), value: data.value?.cashoutQueue?.pending ?? "0", money: true, currency: currency() },
                                        { label: t("Processing"), value: data.value?.cashoutQueue?.processing ?? "0", money: true, currency: currency() },
                                        { label: t("Complete"), value: data.value?.cashoutQueue?.completed ?? "0", money: true, currency: currency() },
                                        { label: t("Amount Due"), value: data.value?.cashoutQueue?.nextDayDemand ?? "0", money: true, currency: currency() },
                                    ]}
                                />
                            </SurfaceCard>

                            <SurfaceCard title={t("Holds And Reserves")}>
                                <DescriptionList
                                    items={[
                                        { label: t("Holds And Reserves"), value: data.value?.holdsAndReserves?.amlHold ?? "0", money: true, currency: currency() },
                                        { label: t("Chargeback"), value: data.value?.holdsAndReserves?.chargebackReserve ?? "0", money: true, currency: currency() },
                                        { label: t("Suspense"), value: data.value?.holdsAndReserves?.suspense ?? "0", money: true, currency: currency() },
                                        { label: t("Commission Receivable"), value: data.value?.receivables?.commissionReceivable ?? "0", money: true, currency: currency() },
                                        {
                                            label: t("Oldest"),
                                            value: (
                                                <StatusBadge
                                                    status="OLDEST_ITEM"
                                                    label={`${data.value?.holdsAndReserves?.oldestItemAgeDays ?? 0}d`}
                                                    toneOverride="warning"
                                                    showDot={false}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            </SurfaceCard>

                            <SurfaceCard title={t("Clearing by gateway")} noPadding>
                                {(data.value?.clearingByGateway ?? []).length === 0 ? (
                                    <EmptyState title={t("No gateway clearing balances")} description={t("No gateway clearing balances are available for this snapshot.")} />
                                ) : (
                                    <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ textAlign: "start" }}>{t("Gateway")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("Balance")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("T+0")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("T+1")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("T+2")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("Older")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(data.value?.clearingByGateway ?? []).map((row) => (
                                                    <tr key={row.gatewayId}>
                                                        <td>
                                                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                                <MonoRef value={row.gatewayCode} copyable={false} />
                                                                <span style={{ fontSize: "10px", color: "var(--pg-ink-muted)" }}>{row.gatewayName}</span>
                                                            </div>
                                                        </td>
                                                        <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.balance} currency={currency()} size="sm" /></td>
                                                        <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.t0} currency={currency()} size="sm" showCurrency={false} /></td>
                                                        <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.t1} currency={currency()} size="sm" showCurrency={false} /></td>
                                                        <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.t2} currency={currency()} size="sm" showCurrency={false} /></td>
                                                        <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.older} currency={currency()} size="sm" showCurrency={false} /></td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </SurfaceCard>

                            <SurfaceCard title={t("Settlement ageing")} noPadding>
                                {(data.value?.clearingAgeing ?? []).length === 0 ? (
                                    <EmptyState title={t("No Data Found")} description={t("No settlement ageing buckets are available for this snapshot.")} />
                                ) : (
                                    <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ textAlign: "start" }}>{t("Bucket")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("Attempts")}</th>
                                                    <th style={{ textAlign: "end" }}>{t("Amount")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(data.value?.clearingAgeing ?? []).map((row) => (
                                                    <tr key={row.bucket}>
                                                        <td>{row.bucket}</td>
                                                        <td class="pg-tabular" style={{ textAlign: "end" }}>{row.count} {t("attempts")}</td>
                                                        <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.amount} currency={currency()} size="sm" /></td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </SurfaceCard>
                        </ThemedView>

                        <SurfaceCard
                            title={t("Route daily-cap utilisation")}
                            subtitle={
                                caps.value?.timeZone
                                    ? `${t("Business day")} · ${caps.value.timeZone}${capViews.value.exhaustedCount > 0 ? ` · ${capViews.value.exhaustedCount} ${t("exhausted")}` : ""}`
                                    : t("Succeeded volume against each route's daily cap")
                            }
                            noPadding
                        >
                            {capsError.value ? (
                                <StateView error={capsError.value} minHeight="120px" onRetry={() => void loadCaps()} />
                            ) : capViews.value.capped.length === 0 ? (
                                <EmptyState
                                    title={t("No capped routes")}
                                    description={caps.value ? `${t("No route has a daily cap configured.")} ${capViews.value.uncappedCount} ${t("uncapped routes.")}` : t("Loading route caps")}
                                />
                            ) : (
                                <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                        <thead>
                                            <tr>
                                                <th style={{ textAlign: "start" }}>{t("Rail route")}</th>
                                                <th style={{ textAlign: "start", minWidth: "180px" }}>{t("Utilisation")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Processed")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Daily cap")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Remaining")}</th>
                                                <th style={{ textAlign: "start" }}>{t("Status")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {capViews.value.capped.map((view) => (
                                                <tr key={view.routeId}>
                                                    <td>
                                                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                            <MonoRef value={view.railCode} copyable={false} />
                                                            <MonoRef value={view.gatewayId} truncate={12} />
                                                        </div>
                                                    </td>
                                                    <td>
                                                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                                            <VProgressLinear modelValue={view.barPercent} height={8} rounded color={CAP_COLOR[view.tone]} aria-label={`${view.railCode} ${view.utilisationLabel}`} />
                                                            <span class="pg-tabular" style={{ fontSize: "11.5px", color: "var(--pg-ink-secondary)" }}>{view.utilisationLabel}</span>
                                                        </div>
                                                    </td>
                                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={view.processed} currency={caps.value?.currency ?? currency()} size="sm" showCurrency={false} /></td>
                                                    <td style={{ textAlign: "end" }}>{view.cap ? <MoneyDisplay amount={view.cap} currency={caps.value?.currency ?? currency()} size="sm" showCurrency={false} /> : "—"}</td>
                                                    <td style={{ textAlign: "end" }}>{view.remaining ? <MoneyDisplay amount={view.remaining} currency={caps.value?.currency ?? currency()} size="sm" showCurrency={false} /> : "—"}</td>
                                                    <td>
                                                        {view.exhausted ? (
                                                            <StatusBadge status="DAILY_CAP_EXCEEDED" label={t("Daily cap exceeded")} toneOverride="danger" />
                                                        ) : (
                                                            <StatusBadge status="WITHIN_CAP" label={view.tone === "warning" ? t("Near cap") : t("Within cap")} toneOverride={view.tone === "warning" ? "warning" : "success"} showDot={false} />
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </SurfaceCard>
                    </ThemedView>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default LiquidityPage;
