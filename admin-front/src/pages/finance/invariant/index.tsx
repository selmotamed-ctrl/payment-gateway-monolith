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

    const currency = () => data.value?.currency ?? "LYD";

    const sideRow = (label: string, value: string | undefined) => (
        <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
            <ThemedText style={{ fontSize: "13px" }}>{t(label)}</ThemedText>
            <MoneyText value={value ?? "0"} currency={currency()} />
        </ThemedView>
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Invariant Status")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {data.value?.checkedAt && <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Last run")} {new Date(data.value.checkedAt).toLocaleTimeString()}</ThemedText>}
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
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

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                        {t("Invariant Status")}
                                    </ThemedText>
                                    <StatusChip
                                        label={data.value?.ok ? t("Passed") : t("Failed")}
                                        tone={data.value?.ok ? "success" : "error"}
                                    />
                                </ThemedView>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                                    <ThemedText style={{ fontSize: "13px" }}>{t("Drift")}</ThemedText>
                                    <MoneyText
                                        value={data.value?.drift ?? "0"}
                                        currency={currency()}
                                        color={data.value?.ok ? "#059669" : "#dc2626"}
                                        bold
                                    />
                                </ThemedView>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                                    <ThemedText style={{ fontSize: "13px" }}>{t("Last Run")}</ThemedText>
                                    <ThemedText style={{ fontSize: "13px" }}>{data.value?.checkedAt ? new Date(data.value.checkedAt).toLocaleString() : "-"}</ThemedText>
                                </ThemedView>
                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
                                    {[
                                        { label: t("Debit side"), value: data.value?.leftSide ?? "0.0000" },
                                        { label: t("Credit side"), value: data.value?.rightSide ?? "0.0000" },
                                        { label: t("Accounts"), value: String(data.value?.accounts?.length ?? 0) },
                                    ].map((item) => (
                                        <VCard key={item.label} variant="tonal">
                                            <VCardText style={{ padding: "12px" }}>
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{item.label}</ThemedText>
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{item.value}</ThemedText>
                                            </VCardText>
                                        </VCard>
                                    ))}
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 380px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Treasury Cover")}</ThemedText>
                                    {sideRow("Treasury Balance", data.value?.sides?.treasury)}
                                    {sideRow("GATEWAY_CLEARING", data.value?.sides?.clearing)}
                                    {sideRow("Commission Receivable", data.value?.sides?.commissionReceivable)}
                                </VCardText>
                            </VCard>
                            <VCard style={{ flex: "1 1 380px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Ledger")}</ThemedText>
                                    {sideRow("MERCHANT_WALLET", data.value?.sides?.merchantWallet)}
                                    {sideRow("PLATFORM_INCOME", data.value?.sides?.platformIncome)}
                                    {sideRow("PROVIDER_FEE_EXPENSE", data.value?.sides?.providerFeeExpense)}
                                    {sideRow("GATEWAY_FEE_EXPENSE", data.value?.sides?.gatewayFeeExpense)}
                                    {sideRow("GATEWAY_FEE_ACCRUAL", data.value?.sides?.gatewayFeeAccrual)}
                                    {sideRow("AML_HOLD", data.value?.sides?.amlHold)}
                                    {sideRow("CHARGEBACK_RESERVE", data.value?.sides?.chargebackReserve)}
                                    {sideRow("SUSPENSE", data.value?.sides?.suspense)}
                                </VCardText>
                            </VCard>
                        </ThemedView>

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Ledger accounts")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "12px", fontSize: "11px", opacity: 0.6, borderBottom: "1px solid rgba(100,116,139,0.2)", paddingBottom: "4px" }}>
                                    <span style={{ flex: 1 }}>{t("Account")}</span>
                                    <span style={{ width: "170px" }}>{t("Type")}</span>
                                    <span style={{ width: "140px", textAlign: "right" }}>{t("Live balance")}</span>
                                    <span style={{ width: "140px", textAlign: "right" }}>{t("Natural balance")}</span>
                                </ThemedView>
                                {(data.value?.accounts ?? []).length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>}
                                {(data.value?.accounts ?? []).map((row) => (
                                    <ThemedView key={row.accountId} style={{ flexDirection: "row", gap: "12px", alignItems: "center", fontSize: "12px", borderBottom: "1px solid rgba(100,116,139,0.1)", paddingBottom: "5px" }}>
                                        <span style={{ flex: 1, direction: "ltr", opacity: 0.75 }}>{row.accountId}</span>
                                        <span style={{ width: "170px" }}>{row.accountType}</span>
                                        <span style={{ width: "140px", textAlign: "right" }}><MoneyText value={row.liveBalance} currency={currency()} showCurrency={false} /></span>
                                        <span style={{ width: "140px", textAlign: "right" }}><MoneyText value={row.naturalBalance} currency={currency()} showCurrency={false} bold /></span>
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

export default InvariantPage;
