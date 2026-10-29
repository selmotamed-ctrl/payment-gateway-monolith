import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VCard, VCardText, VDialog, VTextField } from "vuetify/components";
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
import { toDecimal } from "@/utils/money";

type Wallet = {
    id: string;
    name: string;
    currency: string;
    status: string;
    balance: string;
    pendingBalance: string;
    negativeBalance: string;
    negativeBalanceCeiling: string;
    lastTransactionAt: string | null;
};

const WalletsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Wallet[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const form = ref({ name: "", currency: "LYD" });
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.walletsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.wallets ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const createWallet = async () => {
        actionLoading.value = true;
        try {
            await api.post(urlsMap.walletsList, form.value);
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<Wallet>[] = [
        { key: "name", label: "Merchant Name", value: (row) => row.name },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        {
            key: "balance",
            label: "Wallet Balance",
            Value: ({ row }: { row: Wallet }) => <MoneyText value={row.balance} currency={row.currency} bold />,
        },
        {
            key: "pendingBalance",
            label: "Pending",
            Value: ({ row }: { row: Wallet }) => <MoneyText value={row.pendingBalance} currency={row.currency} />,
        },
        {
            key: "negativeBalance",
            label: "Amount Due",
            Value: ({ row }: { row: Wallet }) => (
                <MoneyText
                    value={row.negativeBalance}
                    currency={row.currency}
                    color={toDecimal(row.negativeBalance).greaterThan(0) ? "#dc2626" : undefined}
                />
            ),
        },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Wallet }) => (
                <StatusChip label={row.status} tone={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        { key: "lastTransactionAt", label: "Last Used", value: (row) => row.lastTransactionAt ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Wallet }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn
                        size="small"
                        variant="tonal"
                        onClick={() => void router.push({ name: "Statements", query: { walletId: row.id } })}
                    >
                        {t("Statements")}
                    </VBtn>
                    <VBtn
                        size="small"
                        variant="tonal"
                        onClick={async () => {
                            try {
                                const response = await api.get(urlsMap.walletBalance(row.id));
                                const payload = response.data?.data ?? response.data ?? {};
                                showSnackBar({
                                    type: "primary",
                                    message: `${payload.balance ?? row.balance} ${payload.currency ?? row.currency}`,
                                });
                            } catch (e) {
                                showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
                            }
                        }}
                    >
                        {t("Refresh")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Wallets")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = { name: "", currency: "LYD" };
                                dialogOpen.value = true;
                            }}
                        >
                            {t("Create")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Wallets")}
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
                        <VTextField
                            label={t("Merchant Name")}
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                        />
                        <VTextField
                            label={t("Currency")}
                            modelValue={form.value.currency}
                            onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void createWallet()}>
                            {t("Create")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default WalletsPage;
