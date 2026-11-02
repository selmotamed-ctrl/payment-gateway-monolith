import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAutocomplete, VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { SectionFields } from "@/components/SectionFields";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
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
    const formError = ref("");

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
        formError.value = "";
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
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
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
                return "danger" as const;
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
            Value: ({ row }: { row: Cashout }) => (
                <StatusBadge status={row.state} toneOverride={stateTone(row.state)} />
            ),
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Cashout }) => (
                <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />
            ),
        },
        {
            key: "walletId",
            label: "Wallet",
            Value: ({ row }: { row: Cashout }) => <MonoRef value={row.walletId} truncate={14} />,
        },
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
                    subtitle={t("Settlement withdrawals and payout status.")}
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
                                formError.value = "";
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
                )}
            </ThemedView>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={t("Request Cash-Out")}
                size="sm"
                loading={actionLoading.value}
                errorMessage={formError.value}
                onSubmit={() => void request()}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={actionLoading.value} onClick={() => (dialogOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                disabled={!walletId.value || !amount.value || !bankName.value || !accountNumber.value}
                                loading={actionLoading.value}
                            >
                                {t("Request Cash-Out")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <SectionFields title={t("Cash-Outs")}>
                    <FormField label={t("Wallet")} required>
                        <VAutocomplete
                            items={walletOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={walletId.value}
                            onUpdate:modelValue={(v: string) => (walletId.value = v ?? "")}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Amount")} required>
                        <VTextField
                            modelValue={amount.value}
                            onUpdate:modelValue={(v: string) => (amount.value = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Currency")} required>
                        <VTextField
                            modelValue={currency.value}
                            onUpdate:modelValue={(v: string) => (currency.value = v.toUpperCase())}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Bank Details")}>
                    <FormField label={t("Bank name")} required>
                        <VTextField
                            modelValue={bankName.value}
                            onUpdate:modelValue={(v: string) => (bankName.value = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Account number")} required>
                        <VTextField
                            modelValue={accountNumber.value}
                            onUpdate:modelValue={(v: string) => (accountNumber.value = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("IBAN (optional)")}>
                        <VTextField
                            modelValue={iban.value}
                            onUpdate:modelValue={(v: string) => (iban.value = v)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default CashoutsPage;
