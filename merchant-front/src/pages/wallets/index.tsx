import { dc } from "@/utils/dc";
import { ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRouter } from "vue-router";
import {PgAutocomplete, PgButton, PgTextField} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {StateView} from "@pg/ui";
import { DataTable } from "@/tables/DataTable";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import {SectionFields} from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
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
    const form = ref({ name: "", currency: "LYD", applicationId: "" });
    const applicationOptions = ref<{ title: string; value: string }[]>([]);
    const formError = ref("");

    const loadApplications = async () => {
        const response = await api.get(urlsMap.options("applications"), { params: { limit: 100 } });
        const payload = response.data?.data ?? response.data ?? {};
        applicationOptions.value = (payload.items ?? []).map((item: { title: string; value: string }) => ({
            title: item.title,
            value: item.value,
        }));
    };
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
        formError.value = "";
        try {
            await api.post(urlsMap.walletsList, {
                applicationId: form.value.applicationId,
                label: form.value.name,
                currency: form.value.currency,
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<Wallet>[] = [
        { key: "name", label: "Wallet Name", value: (row) => row.name },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        {
            key: "balance",
            label: "Wallet Balance",
            Value: ({ row }: { row: Wallet }) => (
                <MoneyDisplay amount={row.balance} currency={row.currency} size="sm" />
            ),
        },
        {
            key: "pendingBalance",
            label: "Pending",
            Value: ({ row }: { row: Wallet }) => (
                <MoneyDisplay amount={row.pendingBalance} currency={row.currency} size="sm" />
            ),
        },
        {
            key: "negativeBalance",
            label: "Amount Due",
            Value: ({ row }: { row: Wallet }) => (
                <MoneyDisplay amount={row.negativeBalance} currency={row.currency} size="sm" colorSign />
            ),
        },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Wallet }) => (
                <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        { key: "lastTransactionAt", label: "Last Used", value: (row) => row.lastTransactionAt ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Wallet }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Statements"),
                        icon: "mdi-file-document-outline",
                        onClick: () => void router.push({ name: "Statements", query: { walletId: row.id } }),
                    }}
                    items={[
                        {
                            key: "refresh",
                            label: t("Refresh"),
                            icon: "mdi-refresh",
                            onClick: async () => {
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
                            },
                        },
                    ]}
                />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Wallets")} subtitle={t("Available, pending, and reserved balances by wallet.")}>(
                        <PgButton
                            variant="tonal"
                            onClick={() => {
                                form.value = { name: "", currency: "LYD", applicationId: "" };
                                formError.value = "";
                                void loadApplications();
                                dialogOpen.value = true;
                            }}
                        >
                            {t("Create")}
                        </PgButton>
                    )</PageHeader>

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
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
                )}
            </ThemedView>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={t("Create Wallet")}
                size="sm"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Create")}
                onSubmit={() => void createWallet()}
            >
                <SectionFields title={t("Details")}>
                    <FormField label={t("Application")} required>
                        <PgAutocomplete
                            items={applicationOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={form.value.applicationId}
                            onUpdate:modelValue={(v: string) => (form.value.applicationId = v ?? "")}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Wallet Name")} required>
                        <PgTextField
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Currency")} required>
                        <PgTextField
                            modelValue={form.value.currency}
                            onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default WalletsPage;
