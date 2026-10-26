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
    trialBalance?: { accountCode: string; accountName: string; accountType: string; debit: string; credit: string; balance: string }[];
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
                <PageHeader title={t("Invariant Status")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
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
                                    <ThemedText style={{ fontSize: "13px" }}>{data.value?.checkedAt ?? "-"}</ThemedText>
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
                                <ThemedText type="defaultSemiBold">{t("Trial Balance")}</ThemedText>
                                {(data.value?.trialBalance ?? []).map((row) => (
                                    <ThemedView
                                        key={row.accountCode}
                                        style={{ flexDirection: "row", gap: "14px", alignItems: "center", fontSize: "13px" }}
                                    >
                                        <span style={{ width: "110px" }}>{row.accountCode}</span>
                                        <span style={{ flex: 1 }}>{row.accountName}</span>
                                        <span>{row.accountType}</span>
                                        <MoneyText value={row.debit} currency={currency()} showCurrency={false} />
                                        <MoneyText value={row.credit} currency={currency()} showCurrency={false} />
                                        <MoneyText value={row.balance} currency={currency()} />
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
