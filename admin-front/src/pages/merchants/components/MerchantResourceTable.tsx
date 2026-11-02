import { defineComponent, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues, type TableFilter } from "@/components/Table/filters";
import type { TableHeader } from "@/components/Table/types";

type MerchantResourceTableProps<T> = {
    title: string;
    url: string;
    listKey: string;
    headers: TableHeader<T>[];
    filters: TableFilter[];
    pageSize?: number;
    searchPlaceholder?: string;
    noElevation?: boolean;
    initialSearch?: string | null;
    focusReference?: string | null;
    onFocusReference?: (row: T) => void;
    onRows?: (rows: T[], total: number) => void;
    onRefreshReady?: (refresh: (() => void) | null) => void;
};

const MerchantResourceTable = defineComponent(
    <T,>(props: MerchantResourceTableProps<T>) => {
        const { t } = useLocale();
        const search = ref<string | null>(props.initialSearch ?? null);
        const focusedReference = ref<string | null>(null);
        const filters = ref<FilterValues>({});
        const pageSize = ref(props.pageSize ?? 10);
        const total = ref(0);
        const hook = ref<{
            reset: () => void;
            refreshAsIs: () => void;
            refresh: (input: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        } | null>(null);
        let filterTimer: ReturnType<typeof setTimeout> | undefined;

        const normalizeReference = (value: unknown): string =>
            typeof value === "string" ? value.trim() : "";

        watch(
            () => props.initialSearch,
            (value) => {
                const next = value ?? null;
                if (next === search.value) return;
                search.value = next;
                hook.value?.reset();
            },
        );

        watch(
            () => props.focusReference,
            () => {
                focusedReference.value = null;
            },
        );

        const focusLoadedReference = (rows: T[]) => {
            const target = normalizeReference(props.focusReference);
            if (!target || focusedReference.value === target) return;
            const match = rows.find((row) => {
                const record = row as unknown as { reference?: unknown; ourReference?: unknown };
                return normalizeReference(record.reference) === target
                    || normalizeReference(record.ourReference) === target;
            });
            if (!match) return;
            focusedReference.value = target;
            props.onFocusReference?.(match);
        };

        const onFiltersChanged = (key: string, value: unknown) => {
            filters.value = { ...filters.value, [key]: value };
            if (filterTimer) clearTimeout(filterTimer);
            filterTimer = setTimeout(() => hook.value?.reset(), 300);
        };

        const onFiltersCleared = () => {
            filters.value = {};
            hook.value?.reset();
        };

        return () => (
            <ApiTable<T>
                title={t(props.title)}
                url={props.url}
                localSearch={false}
                xlsx={false}
                noElevation={props.noElevation}
                showNumber={false}
                numberOfItemsPerPage={pageSize.value}
                numberOfItemsPerPageChoices={[
                    { label: "10", value: 10 },
                    { label: "20", value: 20 },
                    { label: "50", value: 50 },
                ]}
                setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                searchValue={search.value}
                setSearchValue={(value) => (search.value = value)}
                headers={props.headers}
                apiDataExtractor={(data) => {
                    const payload = data as Record<string, unknown>;
                    return (payload[props.listKey] ?? payload.rows ?? []) as T[];
                }}
                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                onData={(rows, nextTotal) => {
                    total.value = nextTotal;
                    props.onRows?.(rows, nextTotal);
                    focusLoadedReference(rows);
                }}
                setRefreshHook={(next) => {
                    hook.value = next as typeof hook.value;
                    props.onRefreshReady?.(() => hook.value?.refreshAsIs());
                }}
                clearRefreshHook={() => {
                    hook.value = null;
                    props.onRefreshReady?.(null);
                }}
                onRefresh={(table, refresh) => {
                    void refresh({
                        queryParams: {
                            page: table.page,
                            pageSize: pageSize.value,
                            ...(search.value ? { search: search.value } : {}),
                            ...buildFilterQuery(props.filters, filters.value),
                            ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                        },
                    });
                }}
                TopSlot={() => (
                    <TableFilters
                        filters={props.filters}
                        values={filters.value}
                        total={total.value}
                        onChange={onFiltersChanged}
                        onClear={onFiltersCleared}
                    />
                )}
            />
        );
    },
    {
        props: [
            "title",
            "url",
            "listKey",
            "headers",
            "filters",
            "pageSize",
            "searchPlaceholder",
            "noElevation",
            "initialSearch",
            "focusReference",
            "onFocusReference",
            "onRows",
            "onRefreshReady",
        ] as any[],
    },
);

export default MerchantResourceTable;
