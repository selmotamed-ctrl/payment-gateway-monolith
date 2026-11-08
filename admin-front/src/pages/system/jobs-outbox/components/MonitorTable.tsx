import { dc } from "kt-dc";
import { ref, watch } from "vue";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues, type TableFilter } from "@/components/Table/filters";
import type { TableHeader } from "@/components/Table/types";

type TableHook = {
    reset: () => void;
    refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
    refreshAsIs: () => void;
};

/**
 * One server-side paged monitor table with its own filters. The Jobs & Outbox page has four of
 * them; `refreshSignal` is bumped by the page to re-run the current query after an action.
 */
const MonitorTable = dc(
    (props: {
        title: string;
        url: string;
        listKey: string;
        headers: TableHeader<any>[];
        filters: TableFilter[];
        initialFilters?: FilterValues;
        refreshSignal: number;
        rowColor?: (row: any) => string | undefined;
        searchable?: boolean;
    }) => {
        const search = ref<string | null>(null);
        const values = ref<FilterValues>({ ...(props.initialFilters ?? {}) });
        const total = ref(0);
        const pageSize = ref(25);
        const hook = ref<TableHook | null>(null);
        let timer: ReturnType<typeof setTimeout> | undefined;

        watch(
            () => props.refreshSignal,
            () => hook.value?.refreshAsIs(),
        );

        const onChange = (key: string, value: unknown) => {
            values.value = { ...values.value, [key]: value };
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => hook.value?.reset(), 300);
        };

        return () => (
            <ApiTable<any>
                title={props.title}
                url={props.url}
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
                headers={props.headers}
                rowColor={props.rowColor}
                apiDataExtractor={(data) => ((data as Record<string, unknown>)[props.listKey] as any[]) ?? []}
                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                onData={(_rows, nextTotal) => {
                    total.value = nextTotal;
                }}
                setRefreshHook={(next) => {
                    hook.value = next as TableHook;
                }}
                clearRefreshHook={() => {
                    hook.value = null;
                }}
                onRefresh={(table, refresh) => {
                    void refresh({
                        queryParams: {
                            page: table.page,
                            pageSize: pageSize.value,
                            ...(props.searchable !== false && search.value ? { search: search.value } : {}),
                            ...buildFilterQuery(props.filters, values.value),
                            ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                        },
                    });
                }}
                TopSlot={() => (
                    <TableFilters
                        filters={props.filters}
                        values={values.value}
                        total={total.value}
                        onChange={onChange}
                        onClear={() => {
                            values.value = {};
                            hook.value?.reset();
                        }}
                    />
                )}
            />
        );
    },
);

export default MonitorTable;
