import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VBtn, VCard, VCardText, VSelect } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { toDecimal } from "@/utils/money";

type Wallet = {
    id: string;
    name: string;
    currency: string;
};

type Statement = {
    walletId: string;
    walletName: string;
    currency: string;
    month: string;
    openingBalance: string;
    closingBalance: string;
    grossCredits: string;
    commission: string;
    netCredits: string;
    adjustments: string;
    cashouts: string;
    snapshotHash: string;
    lines: {
        id: string;
        occurredAt: string;
        type: string;
        description: string;
        gross: string;
        commission: string;
        net: string;
        balance: string;
    }[];
};

const monthOptions = () => {
    const months: { title: string; value: string }[] = [];
    const now = new Date();
    for (let index = 0; index < 12; index += 1) {
        const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
        months.push({
            title: date.toISOString().slice(0, 7),
            value: date.toISOString().slice(0, 7),
        });
    }
    return months;
};

const StatementsPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const wallets = ref<Wallet[]>([]);
    const walletId = ref<string | null>((route.query.walletId as string) ?? null);
    const month = ref(monthOptions()[0]?.value ?? "");
    const statement = ref<Statement | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);

    const loadWallets = async () => {
        try {
            const response = await api.get(urlsMap.walletsList);
            const payload = response.data?.data ?? response.data ?? {};
            wallets.value = payload.wallets ?? payload.rows ?? [];
            if (!walletId.value && wallets.value.length) {
                walletId.value = wallets.value[0]!.id;
            }
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        }
    };

    void loadWallets();

    const loadStatement = async () => {
        if (!walletId.value) {
            return;
        }
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.walletStatements(walletId.value), {
                params: { month: month.value },
            });
            const payload = response.data?.data ?? response.data ?? {};
            statement.value = payload.statement ?? payload;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            statement.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch([walletId, month], () => {
        void loadStatement();
    });

    const currency = computed(() => statement.value?.currency ?? wallets.value[0]?.currency ?? "LYD");

    const exportStatement = async () => {
        if (!walletId.value) {
            return;
        }
        try {
            const response = await api.get(urlsMap.walletStatementExport(walletId.value, month.value), {
                responseType: "blob",
            });
            const blob = new Blob([response.data], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `statement-${walletId.value}-${month.value}.csv`;
            link.click();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Download") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const headers: TableHeader<any>[] = [
        { key: "occurredAt", label: "Created At", value: (row) => row.occurredAt },
        { key: "type", label: "Type", value: (row) => row.type },
        { key: "description", label: "Merchant Name", value: (row) => row.description },
        { key: "gross", label: "Gross", value: (row) => row.gross },
        { key: "commission", label: "Commission", value: (row) => row.commission },
        { key: "net", label: "Net", value: (row) => row.net },
        { key: "balance", label: "Closing Balance", value: (row) => row.balance },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Statements")}
                    end={() => (
                        <ThemedView
                            style={{
                                display: "flex",
                                flexDirection: "row",
                                flexWrap: "wrap",
                                gap: "10px",
                                alignItems: "center",
                                width: "100%",
                            }}
                        >
                            <VSelect
                                items={wallets.value.map((wallet) => ({ title: wallet.name, value: wallet.id }))}
                                modelValue={walletId.value}
                                onUpdate:modelValue={(v: string | null) => (walletId.value = v)}
                                label={t("Wallets")}
                                density="compact"
                                hideDetails
                                style={{ minWidth: "140px", flex: "1 1 140px" }}
                            />
                            <VSelect
                                items={monthOptions()}
                                modelValue={month.value}
                                onUpdate:modelValue={(v: string) => (month.value = v)}
                                label={t("Statements")}
                                density="compact"
                                hideDetails
                                style={{ minWidth: "120px", flex: "1 1 120px" }}
                            />
                            <VBtn variant="tonal" onClick={() => void exportStatement()}>
                                {t("Export")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void loadStatement()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : statement.value ? (
                    <>
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                    {statement.value.walletName} · {statement.value.month}
                                </ThemedText>
                                {[
                                    { label: t("Opening Balance"), value: statement.value.openingBalance },
                                    { label: t("Gross"), value: statement.value.grossCredits },
                                    { label: t("Commission"), value: statement.value.commission },
                                    { label: t("Net"), value: statement.value.netCredits },
                                    { label: t("Adjustments"), value: statement.value.adjustments },
                                    { label: t("Cash-Outs"), value: statement.value.cashouts },
                                    { label: t("Closing Balance"), value: statement.value.closingBalance },
                                ].map((item) => (
                                    <ThemedView
                                        key={item.label}
                                        style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}
                                    >
                                        <ThemedText style={{ fontSize: "13px" }}>{item.label}</ThemedText>
                                        <MoneyText
                                            value={item.value}
                                            currency={currency.value}
                                            color={
                                                toDecimal(item.value).isNegative() ? "#dc2626" : undefined
                                            }
                                            bold
                                        />
                                    </ThemedView>
                                ))}
                                {statement.value.snapshotHash && (
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6, direction: "ltr" }}>
                                        snapshot: {statement.value.snapshotHash}
                                    </ThemedText>
                                )}
                            </VCardText>
                        </VCard>

                        <VCard>
                            <VCardText>
                                <DataTable
                                    title={t("Statements")}
                                    data={statement.value.lines ?? []}
                                    headers={headers}
                                    loading={false}
                                    showNumber={true}
                                    xlsx={false}
                                    noElevation={true}
                                />
                            </VCardText>
                        </VCard>
                    </>
                ) : (
                    <StateView empty={true} emptyTitle={t("No Data Found")} />
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default StatementsPage;
