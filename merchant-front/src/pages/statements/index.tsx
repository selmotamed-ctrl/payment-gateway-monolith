import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import TableFilters from "@/components/Table/TableFilters";
import type { TableFilter } from "@/components/Table/filters";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";
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

    watch(
        [walletId, month],
        () => {
            void loadStatement();
        },
        { immediate: true },
    );

    const currency = computed(() => statement.value?.currency ?? wallets.value[0]?.currency ?? "LYD");

    const filterDefinitions = computed<TableFilter[]>(() => [
        {
            key: "walletId",
            label: t("Wallet"),
            type: "data-autocomplete",
            options: wallets.value.map((wallet) => ({ title: wallet.name, value: wallet.id })),
        },
        {
            key: "month",
            label: t("Month"),
            type: "data-autocomplete",
            options: monthOptions(),
        },
    ]);

    const filterValues = () => ({
        walletId: walletId.value,
        month: month.value,
    });

    const applyFilter = (key: string, value: unknown) => {
        const normalized = typeof value === "string" && value ? value : null;
        if (key === "walletId") walletId.value = normalized;
        if (key === "month" && normalized) month.value = normalized;
    };

    const clearFilters = () => {
        walletId.value = wallets.value[0]?.id ?? null;
        month.value = monthOptions()[0]?.value ?? "";
    };

    const summaryItems = computed<DescriptionItem[]>(() => {
        const current = statement.value;
        if (!current) return [];
        return [
            {
                label: t("Opening Balance"),
                value: (
                    <MoneyDisplay amount={current.openingBalance} currency={currency.value} size="sm" colorSign />
                ),
            },
            {
                label: t("Gross"),
                value: <MoneyDisplay amount={current.grossCredits} currency={currency.value} size="sm" />,
            },
            {
                label: t("Commission"),
                value: <MoneyDisplay amount={current.commission} currency={currency.value} size="sm" />,
            },
            {
                label: t("Net"),
                value: <MoneyDisplay amount={current.netCredits} currency={currency.value} size="sm" colorSign />,
            },
            {
                label: t("Adjustments"),
                value: <MoneyDisplay amount={current.adjustments} currency={currency.value} size="sm" colorSign />,
            },
            {
                label: t("Cash-Outs"),
                value: <MoneyDisplay amount={current.cashouts} currency={currency.value} size="sm" />,
            },
            {
                label: t("Closing Balance"),
                value: (
                    <MoneyDisplay amount={current.closingBalance} currency={currency.value} size="sm" colorSign />
                ),
            },
            ...(current.snapshotHash
                ? [
                      {
                          label: t("Snapshot"),
                          value: <MonoRef value={current.snapshotHash} truncate={18} />,
                      },
                  ]
                : []),
        ];
    });

    const exportStatement = async () => {
        if (!walletId.value) {
            return;
        }
        try {
            const response = await api.get(urlsMap.walletStatementExport(walletId.value, month.value), {
                responseType: "text",
            });
            await xlsxUIPipeline.downloadXlsxFromCsvText({
                title: `statement-${walletId.value}-${month.value}.xlsx`,
                csv: String(response.data ?? ""),
            });
            showSnackBar({ type: "success", message: t("Download") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const renderFilters = () => (
        <TableFilters
            filters={filterDefinitions.value}
            values={filterValues()}
            onChange={applyFilter}
            onClear={clearFilters}
        />
    );

    const headers: TableHeader<any>[] = [
        { key: "occurredAt", label: "Created At", value: (row) => row.occurredAt },
        { key: "type", label: "Type", value: (row) => row.type },
        { key: "description", label: "Description", value: (row) => row.description },
        {
            key: "gross",
            label: "Gross",
            Value: ({ row }: { row: Statement["lines"][number] }) => (
                <MoneyDisplay amount={row.gross} currency={currency.value} size="sm" />
            ),
        },
        {
            key: "commission",
            label: "Commission",
            Value: ({ row }: { row: Statement["lines"][number] }) => (
                <MoneyDisplay amount={row.commission} currency={currency.value} size="sm" />
            ),
        },
        {
            key: "net",
            label: "Net",
            Value: ({ row }: { row: Statement["lines"][number] }) => (
                <MoneyDisplay amount={row.net} currency={currency.value} size="sm" colorSign />
            ),
        },
        {
            key: "balance",
            label: "Closing Balance",
            Value: ({ row }: { row: Statement["lines"][number] }) => (
                <MoneyDisplay amount={row.balance} currency={currency.value} size="sm" colorSign />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Statements")}
                    subtitle={t("Settlement statements and downloadable reconciliation records.")}
                    end={() => (
                        <VBtn variant="tonal" disabled={!walletId.value} onClick={() => void exportStatement()}>
                            {t("Export")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void loadStatement()} />
                ) : (
                    <>
                        {statement.value && (
                            <SurfaceCard title={`${statement.value.walletName} · ${statement.value.month}`}>
                                <DescriptionList items={summaryItems.value} columns={2} />
                            </SurfaceCard>
                        )}

                        {statement.value || loading.value ? (
                            <DataTable
                                title={t("Statements")}
                                data={statement.value?.lines ?? []}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                TopSlot={renderFilters}
                            />
                        ) : (
                            <SurfaceCard noPadding>
                                {renderFilters()}
                                <EmptyState
                                    title={t("No statement found")}
                                    description={t("Choose another wallet or month to view a statement.")}
                                />
                            </SurfaceCard>
                        )}
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default StatementsPage;
