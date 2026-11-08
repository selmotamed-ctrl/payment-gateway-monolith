import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge, formatHumanStatus } from "@/components/ui/StatusBadge";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { JournalEntryDrawer } from "@/components/ledger/JournalEntryDrawer";
import { LedgerRefLink } from "@/components/ledger/LedgerRefLink";
import { formatDateTime } from "@/components/ledger/format";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";

type JournalRow = {
    id: string;
    refType: string;
    refId: string;
    description: string;
    createdAt: string;
    lineCount: number;
    totalDebit: string;
    totalCredit: string;
    balanced: boolean;
    currency: string | null;
};

type JournalSummary = {
    totalEntries: number;
    entries24h: number;
    volume24hByCurrency: { currency: string; total: string }[];
    unbalancedEntries: number;
    window: string;
};

const rowCurrency = (row: JournalRow): string => (row.currency && row.currency !== "MIXED" ? row.currency : "LYD");

const JournalEntriesPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const summary = ref<JournalSummary | null>(null);
    const search = ref<string | null>(null);
    const total = ref(0);
    const pageSize = ref(25);
    const entryId = ref<string | null>(typeof route.query.open === "string" ? route.query.open : null);
    const initialAccount = typeof route.query.glAccountId === "string" ? route.query.glAccountId : "";
    const filters = ref<FilterValues>(initialAccount ? { glAccountId: initialAccount } : {});
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const filterDefinitions = computed(() => tableRegistry.JournalEntries?.filters ?? []);

    // Deep links (`?open=<entry>`) keep working while the page is already mounted.
    watch(
        () => route.query.open,
        (value) => {
            if (typeof value === "string" && value) entryId.value = value;
        },
    );

    const closeEntry = () => {
        entryId.value = null;
        if ("open" in route.query) {
            const nextQuery = { ...route.query };
            delete nextQuery.open;
            void router.replace({ query: nextQuery });
        }
    };

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.financeJournalEntriesSummary);
            summary.value = (response.data?.data ?? response.data) as JournalSummary;
        } catch {
            summary.value = null;
        }
    };
    void loadSummary();

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };
    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        const volumes = data.volume24hByCurrency ?? [];
        const volumeItem: MetricItem =
            volumes.length === 1
                ? { key: "volume", label: t("Volume posted (24h)"), moneyAmount: volumes[0]!.total, currency: volumes[0]!.currency }
                : {
                      key: "volume",
                      label: t("Volume posted (24h)"),
                      value: volumes.length === 0 ? "0" : `${volumes.length} ${t("currencies")}`,
                      subLabel: volumes.map((entry) => `${entry.total} ${entry.currency}`).join(" · ") || undefined,
                  };
        return [
            { key: "total", label: t("Journal entries"), value: String(data.totalEntries) },
            { key: "24h", label: t("Entries (24h)"), value: String(data.entries24h) },
            volumeItem,
            {
                key: "unbalanced",
                label: t("Unbalanced entries"),
                value: String(data.unbalancedEntries),
                subLabel: `${t("Checked over the last")} ${data.window}`,
                badge: data.unbalancedEntries === 0 ? t("Passed") : t("Failed"),
                badgeTone: data.unbalancedEntries === 0 ? "success" : "danger",
            },
        ];
    });

    const headers = computed<TableHeader<JournalRow>[]>(() => [
        {
            key: "id",
            label: "Entry ID",
            value: (row) => row.id,
            Value: ({ row }: { row: JournalRow }) => <LedgerRefLink value={row.id} truncate={12} label={t("Open journal entry")} onOpen={() => (entryId.value = row.id)} />,
        },
        {
            key: "refType",
            label: "Reference type",
            sortKey: "refType",
            value: (row) => row.refType,
            Value: ({ row }: { row: JournalRow }) => <StatusBadge status={row.refType} label={formatHumanStatus(row.refType)} showDot={false} />,
        },
        {
            key: "refId",
            label: "Reference",
            sortKey: "refId",
            value: (row) => row.refId,
            Value: ({ row }: { row: JournalRow }) => <MonoRef value={row.refId} truncate={14} />,
        },
        {
            key: "description",
            label: "Memo",
            value: (row) => row.description,
            Value: ({ row }: { row: JournalRow }) => (
                <ThemedText style={{ fontSize: "12px", maxWidth: "260px", overflowWrap: "anywhere" }}>{row.description || "—"}</ThemedText>
            ),
        },
        { key: "lineCount", label: "Lines", value: (row) => String(row.lineCount) },
        {
            key: "totalDebit",
            label: "Total debit",
            value: (row) => row.totalDebit,
            Value: ({ row }: { row: JournalRow }) => <MoneyDisplay amount={row.totalDebit} currency={rowCurrency(row)} size="sm" showCurrency={row.currency !== "MIXED"} />,
        },
        {
            key: "totalCredit",
            label: "Total credit",
            value: (row) => row.totalCredit,
            Value: ({ row }: { row: JournalRow }) => <MoneyDisplay amount={row.totalCredit} currency={rowCurrency(row)} size="sm" showCurrency={row.currency !== "MIXED"} />,
        },
        {
            key: "balanced",
            label: "Balance",
            value: (row) => (row.balanced ? "BALANCED" : "UNBALANCED"),
            Value: ({ row }: { row: JournalRow }) => (
                <StatusBadge status={row.balanced ? "BALANCED" : "UNBALANCED"} label={row.balanced ? t("Balanced") : t("Unbalanced")} toneOverride={row.balanced ? "success" : "danger"} />
            ),
        },
        {
            key: "createdAt",
            label: "Posted at",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: JournalRow }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText>,
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: JournalRow }) => (
                <TableRowActions primaryAction={{ label: t("Inspect T-account"), icon: "mdi-text-search", onClick: () => void (entryId.value = row.id) }} />
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Journal Entries")}
                    subtitle={t("Append-only double-entry postings of the ledger, with their balance check.")}
                    badge={t("Ledger control")}
                    badgeTone="info"
                    end={() => (
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                    )}
                />

                {summary.value && <MetricStrip items={metricItems.value} />}

                <ApiTable<JournalRow>
                    title={t("Journal entries")}
                    url={urlsMap.financeJournalEntries}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "25", value: 25 },
                        { label: "50", value: 50 },
                        { label: "100", value: 100 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    apiDataExtractor={(data) => ((data as { journalEntries?: JournalRow[] }).journalEntries ?? [])}
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
            <JournalEntryDrawer entryId={entryId.value} onClose={closeEntry} />
        </ScreenContainer>
    );
});

export default JournalEntriesPage;
