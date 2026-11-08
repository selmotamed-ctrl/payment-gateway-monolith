import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { urlsMap } from "@/constants/urlsMap";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { GlAccountDrawer } from "@/components/ledger/GlAccountDrawer";
import ReasonModal from "@/pages/merchants/components/ReasonModal";
import {
    ApprovalSubmittedNotice,
    MoneyOrRestricted,
    formatDateTime,
    toBadgeTone,
} from "@/pages/merchants/components/commerceBits";
import { isRestricted } from "@/pages/merchants/commerceGovernance";
import { notifyOutcome, reportCommerceError, runGoverned } from "@/pages/merchants/governedRequest";
import { walletActionsFor, type WalletAction } from "./walletActions";

type WalletRow = {
    id: string;
    merchantId: string;
    merchant: { id: string; legalName: string; tradeName: string };
    currency: string;
    status: string;
    glAccountId: string;
    liveBalance: string | null;
    checkpointBalance: string | null;
    applicationCount: number;
    paymentLinkCount: number;
    pendingCashoutCount: number;
    createdAt: string;
    redactedFields: string[];
};

type WalletSummary = {
    totalWallets: number;
    activeWallets: number;
    frozenWallets: number;
    pendingCashoutWallets: number;
    totalBalanceByCurrency: Array<{ currency: string; total: string | null }>;
    redactedFields?: string[];
};

const WalletsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const canWrite = computed(() => hasOneOfAuthorities(["merchant:write"]));
    const summary = ref<WalletSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const total = ref(0);
    const pageSize = ref(25);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const glAccountId = ref<string | null>(null);
    const notice = ref<{ approvalRequestId: string | null } | null>(null);
    const target = ref<{ wallet: WalletRow; action: WalletAction } | null>(null);
    const submitting = ref(false);
    const modalError = ref("");

    const filterDefinitions = computed(() => tableRegistry.Wallets?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.walletsSummary);
            summary.value = (response.data?.data ?? response.data ?? null) as WalletSummary | null;
        } catch {
            summary.value = null;
        }
    };
    void loadSummary();

    const openWallet = (id: string) => void router.push({ name: "WalletDetail", params: { id } });

    // Older links (`/wallets?open=<id>`: search hits, the application drawer, guide articles) land on the wallet page.
    useOpenQuery<{ id: string }>({
        alwaysFetchDetail: true,
        fetchById: async (id) => ({ id }),
        onOpenRecord: (record) => void router.replace({ name: "WalletDetail", params: { id: record.id } }),
    });

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };
    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const submit = async (reason: string) => {
        const current = target.value;
        if (!current) return;
        submitting.value = true;
        modalError.value = "";
        try {
            const outcome = await runGoverned(() => api.post(urlsMap.walletStatus(current.wallet.id), { status: current.action.targetStatus, reason }));
            notifyOutcome(outcome, "Wallet frozen");
            notice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
            target.value = null;
            refreshAll();
        } catch (cause) {
            modalError.value = reportCommerceError(cause);
        } finally {
            submitting.value = false;
        }
    };

    const metrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        const items: MetricItem[] = [
            { key: "total", label: t("Total wallets"), value: String(data.totalWallets) },
            { key: "active", label: t("Active wallets"), value: String(data.activeWallets), badge: t("Active"), badgeTone: "success" },
            {
                key: "frozen",
                label: t("Frozen wallets"),
                value: String(data.frozenWallets),
                badge: data.frozenWallets > 0 ? t("Contained") : t("Clear"),
                badgeTone: data.frozenWallets > 0 ? "danger" : "success",
            },
            {
                key: "cashouts",
                label: t("Wallets with pending cash-outs"),
                value: String(data.pendingCashoutWallets),
                badge: data.pendingCashoutWallets > 0 ? t("Pending") : t("Clear"),
                badgeTone: data.pendingCashoutWallets > 0 ? "warning" : "success",
            },
        ];
        for (const entry of data.totalBalanceByCurrency ?? []) {
            items.push(
                entry.total === null
                    ? { key: `balance-${entry.currency}`, label: `${t("Total balance")} · ${entry.currency}`, value: t("Restricted"), subLabel: t("Hidden for your role") }
                    : { key: `balance-${entry.currency}`, label: `${t("Total balance")} · ${entry.currency}`, moneyAmount: entry.total, currency: entry.currency },
            );
        }
        return items;
    });

    const headers = computed<TableHeader<WalletRow>[]>(() => [
        {
            key: "id",
            label: "Wallet",
            value: (row) => row.id,
            Value: ({ row }: { row: WalletRow }) => (
                <VBtn size="small" variant="text" style={{ paddingInline: "2px", textTransform: "none" }} aria-label={`${t("Open wallet")} ${row.id}`} onClick={() => openWallet(row.id)}>
                    <MonoRef value={row.id} truncate={12} />
                </VBtn>
            ),
        },
        {
            key: "merchant",
            label: "Merchant",
            value: (row) => row.merchant.tradeName,
            Value: ({ row }: { row: WalletRow }) => (
                <VBtn
                    size="small"
                    variant="text"
                    style={{ paddingInline: "2px", textTransform: "none", justifyContent: "flex-start" }}
                    onClick={() => void router.push({ name: "MerchantDetail", params: { id: row.merchantId } })}
                >
                    {row.merchant.tradeName || row.merchant.legalName}
                </VBtn>
            ),
        },
        { key: "currency", label: "Currency", sortKey: "currency", value: (row) => row.currency },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: WalletRow }) => <StatusBadge status={row.status} toneOverride={toBadgeTone(row.status)} />,
        },
        {
            key: "liveBalance",
            label: "Live balance",
            headerTooltip: "Sum of the ledger shards of the wallet account. Hidden for roles without financial visibility.",
            value: (row) => row.liveBalance ?? "",
            Value: ({ row }: { row: WalletRow }) => <MoneyOrRestricted amount={row.liveBalance} currency={row.currency} restricted={isRestricted(row.redactedFields, "liveBalance", row.liveBalance)} />,
        },
        {
            key: "checkpointBalance",
            label: "Checkpoint",
            value: (row) => row.checkpointBalance ?? "",
            Value: ({ row }: { row: WalletRow }) => <MoneyOrRestricted amount={row.checkpointBalance} currency={row.currency} restricted={isRestricted(row.redactedFields, "checkpointBalance", row.checkpointBalance)} />,
        },
        {
            key: "glAccount",
            label: "GL account",
            value: (row) => row.glAccountId,
            Value: ({ row }: { row: WalletRow }) => <MonoRef value={row.glAccountId} truncate={10} />,
        },
        { key: "applications", label: "Applications", value: (row) => String(row.applicationCount) },
        { key: "pendingCashouts", label: "Pending cash-outs", value: (row) => String(row.pendingCashoutCount) },
        {
            key: "createdAt",
            label: "Created",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: WalletRow }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText>,
        },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: WalletRow }) => (
                <TableRowActions
                    primaryAction={{ label: t("Inspect"), icon: "mdi-wallet-outline", onClick: () => openWallet(row.id) }}
                    items={[
                        { key: "gl", label: t("Inspect GL account"), icon: "mdi-book-open-variant", onClick: () => { glAccountId.value = row.glAccountId; } },
                        { key: "merchant", label: t("Open merchant"), icon: "mdi-storefront-outline", onClick: () => void router.push({ name: "MerchantDetail", params: { id: row.merchantId } }) },
                        ...walletActionsFor(row.status, { canWrite: canWrite.value }).map((action) => ({
                            key: action.key,
                            label: t(action.label),
                            icon: action.icon,
                            danger: action.danger,
                            dividerBefore: true,
                            onClick: () => {
                                modalError.value = "";
                                target.value = { wallet: row, action };
                            },
                        })),
                    ]}
                />
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Wallets")}
                    subtitle={t("Merchant wallets across the platform: live balances, shards, statement and containment.")}
                    badge={t("Ledger")}
                    badgeTone="info"
                    end={() => (
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                    )}
                />

                {notice.value && <ApprovalSubmittedNotice approvalRequestId={notice.value.approvalRequestId} onDismiss={() => (notice.value = null)} />}

                {metrics.value.length > 0 && <MetricStrip items={metrics.value} />}

                <ApiTable<WalletRow>
                    title={t("Wallets")}
                    url={urlsMap.walletsList}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "25", value: 25 },
                        { label: "50", value: 50 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    apiDataExtractor={(data) => ((data as { wallets?: WalletRow[] }).wallets ?? []) as WalletRow[]}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(_rows, nextTotal) => {
                        total.value = nextTotal;
                    }}
                    setRefreshHook={(hook) => {
                        refreshHook.value = hook as typeof refreshHook.value;
                    }}
                    clearRefreshHook={() => {
                        refreshHook.value = null;
                    }}
                    onRefresh={(table, refresh) => {
                        void refresh({
                            queryParams: {
                                page: table.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefinitions.value, filters.value),
                                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters
                            filters={filterDefinitions.value}
                            values={filters.value}
                            total={total.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </ThemedView>

            <GlAccountDrawer accountId={glAccountId.value} onClose={() => (glAccountId.value = null)} onChanged={refreshAll} />

            <ReasonModal
                modelValue={target.value !== null}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) target.value = null;
                }}
                title={target.value ? `${t(target.value.action.label)} · ${target.value.wallet.currency}` : ""}
                description={
                    target.value?.action.mode === "approval"
                        ? t("Restoring a frozen wallet needs an independent checker.")
                        : t("A frozen wallet cannot be debited by cash-outs until it is restored.")
                }
                mode={target.value?.action.mode ?? "immediate"}
                danger={target.value?.action.danger ?? false}
                submitLabel={target.value ? t(target.value.action.label) : ""}
                loading={submitting.value}
                errorMessage={modalError.value}
                onSubmit={(reason: string) => void submit(reason)}
            />
        </ScreenContainer>
    );
});

export default WalletsPage;
