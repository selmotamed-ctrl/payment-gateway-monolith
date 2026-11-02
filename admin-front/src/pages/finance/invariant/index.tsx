import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
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

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { DescriptionList } from "@/components/ui/DescriptionList";
type InvariantResult = {
    ok?: boolean;
    drift?: string;
    currency?: string;
    checkedAt?: string;
    sides?: {
        treasury: string;
        clearing: string;
        commissionReceivable: string;
        merchantWallet: string;
        platformIncome: string;
        providerFeeExpense: string;
        gatewayFeeExpense: string;
        gatewayFeeAccrual: string;
        amlHold: string;
        chargebackReserve: string;
        suspense: string;
    };
    leftSide?: string;
    rightSide?: string;
    accounts?: { accountId: string; accountType: string; liveBalance: string; naturalBalance: string; checkpointAt: string | null }[];
};

const InvariantPage = dc(() => {
    const { t } = useLocale();
    const data = ref<InvariantResult | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const exportLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.financeInvariantCheck);
            data.value = (response.data?.data ?? response.data ?? {}) as InvariantResult;
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
            const response = await api.get(urlsMap.financeInvariantExport);
            const snapshot = (response.data?.data ?? response.data ?? {}) as InvariantResult;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["checked_at", snapshot.checkedAt ?? ""],
                ["ok", snapshot.ok === true],
                ["drift", snapshot.drift ?? "0"],
                ["currency", snapshot.currency ?? "LYD"],
                ["left_side", snapshot.leftSide ?? "0"],
                ["right_side", snapshot.rightSide ?? "0"],
            ];
            for (const [key, value] of Object.entries(snapshot.sides ?? {})) {
                rows.push([`side.${key}`, value]);
            }
            for (const row of snapshot.accounts ?? []) {
                rows.push([`account.${row.accountId}.type`, row.accountType]);
                rows.push([`account.${row.accountId}.live_balance`, row.liveBalance]);
                rows.push([`account.${row.accountId}.natural_balance`, row.naturalBalance]);
                rows.push([`account.${row.accountId}.checkpoint_at`, row.checkpointAt ?? ""]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `invariant-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Invariant snapshot exported") });
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
                    title={t("Invariant Status")}
                    subtitle={t("Verify the double-entry ledger invariant and inspect account-level balances.")}
                    badge={t("Ledger control")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {data.value?.checkedAt && <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Last run")} {new Date(data.value.checkedAt).toLocaleTimeString()}</ThemedText>}
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
                        <VAlert type={data.value?.ok ? "success" : "error"} variant="tonal">
                            {data.value?.ok
                                ? t("The double-entry invariant is balanced. Payouts may continue subject to normal policy.")
                                : t("Ledger drift detected. Automated payouts must halt until finance resolves the drift.")}
                        </VAlert>

                        <MetricStrip items={[
                            { key: "drift", label: t("Drift"), moneyAmount: data.value?.drift ?? "0", currency: currency(), badge: data.value?.ok ? t("Passed") : t("Failed"), badgeTone: data.value?.ok ? "success" : "danger" },
                            { key: "debit", label: t("Debit side"), moneyAmount: data.value?.leftSide ?? "0.0000", currency: currency() },
                            { key: "credit", label: t("Credit side"), moneyAmount: data.value?.rightSide ?? "0.0000", currency: currency() },
                            { key: "accounts", label: t("Accounts"), value: String(data.value?.accounts?.length ?? 0) },
                        ]} />

                        <SurfaceCard title={t("Invariant Status")}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                                    <StatusBadge
                                        status={data.value?.ok ? "PASSED" : "FAILED"}
                                        label={data.value?.ok ? t("Passed") : t("Failed")}
                                        toneOverride={data.value?.ok ? "success" : "danger"}
                                    />
                                    <ThemedText style={{ fontSize: "13px" }}>
                                        {t("Last Run")}: {data.value?.checkedAt ? new Date(data.value.checkedAt).toLocaleString() : "-"}
                                    </ThemedText>
                                </ThemedView>
                                <MoneyDisplay amount={data.value?.drift ?? "0"} currency={currency()} size="xl" colorSign />
                            </SurfaceCardText>
                        </SurfaceCard>

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
                            <SurfaceCard title={t("Treasury Cover")}>
                                <DescriptionList
                                    items={[
                                        { label: t("Treasury Balance"), value: data.value?.sides?.treasury ?? "0", money: true, currency: currency() },
                                        { label: t("GATEWAY_CLEARING"), value: data.value?.sides?.clearing ?? "0", money: true, currency: currency() },
                                        { label: t("Commission Receivable"), value: data.value?.sides?.commissionReceivable ?? "0", money: true, currency: currency() },
                                    ]}
                                />
                            </SurfaceCard>
                            <SurfaceCard title={t("Ledger")}>
                                <DescriptionList
                                    items={[
                                        { label: t("MERCHANT_WALLET"), value: data.value?.sides?.merchantWallet ?? "0", money: true, currency: currency() },
                                        { label: t("PLATFORM_INCOME"), value: data.value?.sides?.platformIncome ?? "0", money: true, currency: currency() },
                                        { label: t("PROVIDER_FEE_EXPENSE"), value: data.value?.sides?.providerFeeExpense ?? "0", money: true, currency: currency() },
                                        { label: t("GATEWAY_FEE_EXPENSE"), value: data.value?.sides?.gatewayFeeExpense ?? "0", money: true, currency: currency() },
                                        { label: t("GATEWAY_FEE_ACCRUAL"), value: data.value?.sides?.gatewayFeeAccrual ?? "0", money: true, currency: currency() },
                                        { label: t("AML_HOLD"), value: data.value?.sides?.amlHold ?? "0", money: true, currency: currency() },
                                        { label: t("CHARGEBACK_RESERVE"), value: data.value?.sides?.chargebackReserve ?? "0", money: true, currency: currency() },
                                        { label: t("SUSPENSE"), value: data.value?.sides?.suspense ?? "0", money: true, currency: currency() },
                                    ]}
                                />
                            </SurfaceCard>
                        </ThemedView>

                        <SurfaceCard title={t("Ledger accounts")} noPadding>
                            {(data.value?.accounts ?? []).length === 0 ? (
                                <EmptyState title={t("No Data Found")} description={t("No ledger accounts returned by the invariant check.")} />
                            ) : (
                                <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                        <thead>
                                            <tr>
                                                <th style={{ textAlign: "start" }}>{t("Account")}</th>
                                                <th style={{ textAlign: "start" }}>{t("Type")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Live balance")}</th>
                                                <th style={{ textAlign: "end" }}>{t("Natural balance")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(data.value?.accounts ?? []).map((row) => (
                                                <tr key={row.accountId}>
                                                    <td><MonoRef value={row.accountId} /></td>
                                                    <td><StatusBadge status={row.accountType} label={row.accountType} showDot={false} /></td>
                                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.liveBalance} currency={currency()} size="sm" showCurrency={false} /></td>
                                                    <td style={{ textAlign: "end" }}><MoneyDisplay amount={row.naturalBalance} currency={currency()} size="sm" showCurrency={false} colorSign /></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </SurfaceCard>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default InvariantPage;
