import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAutocomplete, VBtn, VCard, VCardText, VDialog, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Cashout = {
    id: string;
    state: string;
    amount: string;
    currency: string;
    walletId: string;
    requestedAt: string;
    processedAt: string | null;
    completedAt: string | null;
    subtractedAt: string | null;
};

const CashoutsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Cashout[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const amount = ref("");
    const currency = ref("LYD");
    const walletId = ref("");
    const bankName = ref("");
    const accountNumber = ref("");
    const iban = ref("");
    const walletOptions = ref<{ title: string; value: string }[]>([]);

    const loadWallets = async () => {
        const response = await api.get(urlsMap.options("wallets"), { params: { limit: 100 } });
        const payload = response.data?.data ?? response.data ?? {};
        walletOptions.value = (payload.items ?? []).map((item: { title: string; value: string }) => ({
            title: item.title,
            value: item.value,
        }));
    };
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.cashoutsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.cashouts ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const request = async () => {
        actionLoading.value = true;
        try {
            await api.post(urlsMap.cashoutsList, {
                walletId: walletId.value,
                amount: amount.value,
                currency: currency.value.toUpperCase(),
                destinationBank: {
                    bankName: bankName.value,
                    accountNumber: accountNumber.value,
                    ...(iban.value ? { iban: iban.value } : {}),
                },
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Request Cash-Out") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const stateTone = (state: string) => {
        switch (state) {
            case "SUBTRACTED":
            case "COMPLETE":
                return "success" as const;
            case "REJECTED":
                return "error" as const;
            case "PROCESSING":
                return "info" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Cashout>[] = [
        {
            key: "state",
            label: "Cash-Out State",
            Value: ({ row }: { row: Cashout }) => <StatusChip label={row.state} tone={stateTone(row.state)} />,
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Cashout }) => <MoneyText value={row.amount} currency={row.currency} bold />,
        },
        { key: "walletId", label: "Wallet Balance", value: (row) => row.walletId },
        { key: "requestedAt", label: "Submitted At", value: (row) => row.requestedAt },
        { key: "processedAt", label: "Processing", value: (row) => row.processedAt ?? "-" },
        { key: "completedAt", label: "Complete", value: (row) => row.completedAt ?? "-" },
        { key: "subtractedAt", label: "Subtracted", value: (row) => row.subtractedAt ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Cash-Outs")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                amount.value = "";
                                currency.value = "LYD";
                                walletId.value = "";
                                bankName.value = "";
                                accountNumber.value = "";
                                iban.value = "";
                                void loadWallets();
                                dialogOpen.value = true;
                            }}
                        >
                            {t("Request Cash-Out")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Cash-Outs")}
                                data={rows.value}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                searchValue={search.value}
                                setSearchValue={(value) => (search.value = value)}
                            />
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="480px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{t("Request Cash-Out")}</ThemedText>
                        <VAutocomplete
                            label={t("Wallet")}
                            items={walletOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={walletId.value}
                            onUpdate:modelValue={(v: string) => (walletId.value = v ?? "")}
                        />
                        <VTextField
                            label={t("Amount")}
                            modelValue={amount.value}
                            onUpdate:modelValue={(v: string) => (amount.value = v)}
                        />
                        <VTextField
                            label={t("Currency")}
                            modelValue={currency.value}
                            onUpdate:modelValue={(v: string) => (currency.value = v.toUpperCase())}
                        />
                        <VTextField
                            label={t("Bank name")}
                            modelValue={bankName.value}
                            onUpdate:modelValue={(v: string) => (bankName.value = v)}
                        />
                        <VTextField
                            label={t("Account number")}
                            modelValue={accountNumber.value}
                            onUpdate:modelValue={(v: string) => (accountNumber.value = v)}
                        />
                        <VTextField
                            label={t("IBAN (optional)")}
                            modelValue={iban.value}
                            onUpdate:modelValue={(v: string) => (iban.value = v)}
                        />
                        <VBtn
                            color="primary"
                            disabled={!walletId.value || !amount.value || !bankName.value || !accountNumber.value}
                            loading={actionLoading.value}
                            onClick={() => void request()}
                        >
                            {t("Request Cash-Out")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default CashoutsPage;
