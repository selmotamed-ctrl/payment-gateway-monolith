import { defineComponent, ref, type PropType, type VNodeChild } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import type { TableHeader } from "@/components/Table/types";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { formatHumanStatus } from "@/components/ui/StatusBadge";
import { LedgerRefLink } from "./LedgerRefLink";
import { accountLineFilters, netChangeOf, type AccountLine, type AccountLinesTotals } from "./accountLinesModel";
import { journalReferenceTarget, referenceRouteOfRefType } from "./journalModel";
import { formatDateTime } from "./format";

/**
 * Paginated posting lines of one GL account: the wallet statement and the lines of the GL
 * account drawer. Filters (side, reference type, date range), text search over the memo and
 * reference, server paging, and totals for the WHOLE filtered set above the table.
 *
 * Page position and filters are local state; the parent chooses the `url` (a wallet statement
 * or a GL account lines endpoint) and decides what opening an entry means (`onOpenEntry`).
 */
export const AccountLinesTable = defineComponent({
    name: "AccountLinesTable",
    props: {
        url: { type: String, required: true },
        currency: { type: String, required: true },
        accountType: { type: String, default: "" },
        title: { type: String, default: "" },
        /** Narrow layouts (the drawer) drop the memo column. */
        compact: { type: Boolean, default: false },
        pageSize: { type: Number, default: 10 },
        noElevation: { type: Boolean, default: false },
    },
    emits: {
        openEntry: (_entryId: string) => true,
        loaded: (_totals: AccountLinesTotals | null, _total: number) => true,
    },
    setup(props, { emit, expose }) {
        const { t } = useLocale();
        const router = useRouter();
        const search = ref<string | null>(null);
        const filters = ref<FilterValues>({});
        const pageSize = ref(props.pageSize);
        const total = ref(0);
        const totals = ref<AccountLinesTotals | null>(null);
        const hook = ref<{
            reset: () => void;
            refreshAsIs: () => void;
            refresh: (input: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        } | null>(null);
        let filterTimer: ReturnType<typeof setTimeout> | undefined;

        expose({ refresh: () => hook.value?.refreshAsIs() });

        const onFiltersChanged = (key: string, value: unknown) => {
            filters.value = { ...filters.value, [key]: value };
            if (filterTimer) clearTimeout(filterTimer);
            filterTimer = setTimeout(() => hook.value?.reset(), 300);
        };
        const onFiltersCleared = () => {
            filters.value = {};
            hook.value?.reset();
        };

        const openRecord = (line: AccountLine) => {
            const target = journalReferenceTarget({ route: referenceRouteOfRefType(line.refType), id: line.refId });
            if (target.kind === "link") void router.push(target.location);
        };

        const headers = (): TableHeader<AccountLine>[] => {
            const columns: TableHeader<AccountLine>[] = [
                {
                    key: "createdAt",
                    label: "Posted",
                    sortKey: "createdAt",
                    value: (row) => row.createdAt,
                    Value: ({ row }: { row: AccountLine }) => <span class="pg-tabular">{formatDateTime(row.createdAt)}</span>,
                },
                {
                    key: "refType",
                    label: "Reference type",
                    sortable: false,
                    value: (row) => row.refType,
                    Value: ({ row }: { row: AccountLine }) =>
                        referenceRouteOfRefType(row.refType) && row.refId ? (
                            <button
                                type="button"
                                class="pg-link-button"
                                title={t("Open the record behind this line")}
                                onClick={() => openRecord(row)}
                                style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--pg-accent-interactive)", font: "inherit" }}
                            >
                                {formatHumanStatus(row.refType)}
                            </button>
                        ) : (
                            <span>{formatHumanStatus(row.refType)}</span>
                        ),
                },
            ];
            if (!props.compact) {
                columns.push({
                    key: "description",
                    label: "Memo",
                    sortable: false,
                    value: (row) => row.description ?? "",
                    Value: ({ row }: { row: AccountLine }) => (
                        <span
                            title={row.description ?? ""}
                            style={{ display: "inline-block", maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}
                        >
                            {row.description || "—"}
                        </span>
                    ),
                });
            }
            columns.push(
                {
                    key: "debit",
                    label: "Debit",
                    sortable: false,
                    value: (row) => (row.direction === "DEBIT" ? row.amount : ""),
                    Value: ({ row }: { row: AccountLine }) =>
                        row.direction === "DEBIT" ? <MoneyDisplay amount={row.amount} currency={props.currency} size="sm" showCurrency={false} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>,
                },
                {
                    key: "credit",
                    label: "Credit",
                    sortable: false,
                    value: (row) => (row.direction === "CREDIT" ? row.amount : ""),
                    Value: ({ row }: { row: AccountLine }) =>
                        row.direction === "CREDIT" ? <MoneyDisplay amount={row.amount} currency={props.currency} size="sm" showCurrency={false} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>,
                },
                {
                    key: "entry",
                    label: "Journal entry",
                    sortable: false,
                    value: (row) => row.entryId,
                    Value: ({ row }: { row: AccountLine }) => (
                        <LedgerRefLink value={row.entryId} truncate={8} label={t("Open journal entry")} onOpen={(id: string) => emit("openEntry", id)} />
                    ),
                },
            );
            return columns;
        };

        const totalsStrip = (): VNodeChild => {
            const current = totals.value;
            if (!current || current.totalDebit === null) return null;
            const net = netChangeOf(props.accountType, current);
            const cell = (label: string, value: VNodeChild) => (
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "110px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--pg-ink-muted)" }}>{label}</span>
                    {value}
                </div>
            );
            return (
                <div
                    role="group"
                    aria-label={t("Totals of the filtered lines")}
                    style={{ display: "flex", flexWrap: "wrap", gap: "12px 28px", padding: "12px 20px", borderBottom: "1px solid var(--pg-border-subtle)", backgroundColor: "var(--pg-bg-surface-subtle)" }}
                >
                    {cell(t("Lines"), <span class="pg-tabular" style={{ fontWeight: 600 }}>{current.lineCount}</span>)}
                    {cell(t("Total debits"), <MoneyDisplay amount={current.totalDebit} currency={props.currency} size="md" />)}
                    {cell(t("Total credits"), <MoneyDisplay amount={current.totalCredit} currency={props.currency} size="md" />)}
                    {net !== null && cell(t("Net change"), <MoneyDisplay amount={net} currency={props.currency} size="md" colorSign />)}
                </div>
            );
        };

        return (): VNodeChild => (
            <div>
                {totalsStrip()}
                <ApiTable<AccountLine>
                    title={props.title || t("Statement")}
                    url={props.url}
                    localSearch={false}
                    xlsx={false}
                    noElevation={props.noElevation}
                    showNumber={false}
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
                    headers={headers()}
                    apiDataExtractor={(data) => {
                        const payload = data as { lines?: AccountLine[]; totals?: AccountLinesTotals };
                        totals.value = payload.totals ?? null;
                        return payload.lines ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(_rows, nextTotal) => {
                        total.value = nextTotal;
                        emit("loaded", totals.value, nextTotal);
                    }}
                    setRefreshHook={(next) => {
                        hook.value = next as typeof hook.value;
                    }}
                    clearRefreshHook={() => {
                        hook.value = null;
                    }}
                    onRefresh={(table, refresh) => {
                        void refresh({
                            queryParams: {
                                page: table.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(accountLineFilters, filters.value),
                                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters filters={accountLineFilters} values={filters.value} total={total.value} onChange={onFiltersChanged} onClear={onFiltersCleared} />
                    )}
                />
            </div>
        );
    },
});

export default AccountLinesTable;
