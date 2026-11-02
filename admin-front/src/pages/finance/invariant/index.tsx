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

    const sideRow = (label: string, value: string | undefined) => (
        <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
            <ThemedText style={{ fontSize: "13px" }}>{t(label)}</ThemedText>
            <MoneyDisplay amount={value ?? "0"} currency={currency()} size="md" colorSign />
        </ThemedView>
    );

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
                                    <StatusChip
                                        label={data.value?.ok ? t("Passed") : t("Failed")}
                                        tone={data.value?.ok ? "success" : "error"}
                                    />
                                    <ThemedText style={{ fontSize: "13px" }}>
                                        {t("Last Run")}: {data.value?.checkedAt ? new Date(data.value.checkedAt).toLocaleString() : "-"}
                                    </ThemedText>
                                </ThemedView>
                                <MoneyDisplay amount={data.value?.drift ?? "0"} currency={currency()} size="xl" colorSign />
                            </SurfaceCardText>
                        </SurfaceCard>

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <SurfaceCard style={{ flex: "1 1 380px" }}>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Treasury Cover")}</ThemedText>
                                    {sideRow("Treasury Balance", data.value?.sides?.treasury)}
                                    {sideRow("GATEWAY_CLEARING", data.value?.sides?.clearing)}
                                    {sideRow("Commission Receivable", data.value?.sides?.commissionReceivable)}
                                </SurfaceCardText>
                            </SurfaceCard>
                            <SurfaceCard style={{ flex: "1 1 380px" }}>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Ledger")}</ThemedText>
                                    {sideRow("MERCHANT_WALLET", data.value?.sides?.merchantWallet)}
                                    {sideRow("PLATFORM_INCOME", data.value?.sides?.platformIncome)}
                                    {sideRow("PROVIDER_FEE_EXPENSE", data.value?.sides?.providerFeeExpense)}
                                    {sideRow("GATEWAY_FEE_EXPENSE", data.value?.sides?.gatewayFeeExpense)}
                                    {sideRow("GATEWAY_FEE_ACCRUAL", data.value?.sides?.gatewayFeeAccrual)}
                                    {sideRow("AML_HOLD", data.value?.sides?.amlHold)}
                                    {sideRow("CHARGEBACK_RESERVE", data.value?.sides?.chargebackReserve)}
                                    {sideRow("SUSPENSE", data.value?.sides?.suspense)}
                                </SurfaceCardText>
                            </SurfaceCard>
                        </ThemedView>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Ledger accounts")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "12px", fontSize: "11px", opacity: 0.6, borderBottom: "1px solid rgba(100,116,139,0.2)", paddingBottom: "4px" }}>
                                    <span style={{ flex: 1 }}>{t("Account")}</span>
                                    <span style={{ width: "170px" }}>{t("Type")}</span>
                                    <span style={{ width: "140px", textAlign: "right" }}>{t("Live balance")}</span>
                                    <span style={{ width: "140px", textAlign: "right" }}>{t("Natural balance")}</span>
                                </ThemedView>
                                {(data.value?.accounts ?? []).length === 0 && <EmptyState title={t("No Data Found")} description={t("No ledger accounts returned by the invariant check.")} />}
                                {(data.value?.accounts ?? []).map((row) => (
                                    <ThemedView key={row.accountId} style={{ flexDirection: "row", gap: "12px", alignItems: "center", fontSize: "12px", borderBottom: "1px solid rgba(100,116,139,0.1)", paddingBottom: "5px" }}>
                                        <span style={{ flex: 1 }}><MonoRef value={row.accountId} /></span>
                                        <span style={{ width: "170px" }}>{row.accountType}</span>
                                        <span style={{ width: "140px", textAlign: "right" }}><MoneyDisplay amount={row.liveBalance} currency={currency()} size="sm" showCurrency={false} /></span>
                                        <span style={{ width: "140px", textAlign: "right" }}><MoneyDisplay amount={row.naturalBalance} currency={currency()} size="sm" showCurrency={false} colorSign /></span>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default InvariantPage;
