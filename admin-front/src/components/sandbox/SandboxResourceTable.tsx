import { defineComponent, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues, type TableFilter } from "@/components/Table/filters";
import type { TableHeader } from "@/components/Table/types";

type SandboxResourceTableProps<T> = {
    title: string;
    url: string;
    listKey: string;
    headers: TableHeader<T>[];
    filters?: TableFilter[];
    pageSize?: number;
    initialSearch?: string | null;
    showNumber?: boolean;
    xlsx?: boolean;
    onRows?: (rows: T[], total: number) => void;
    onRefreshReady?: (refresh: (() => void) | null) => void;
};

export const SandboxResourceTable = defineComponent(
    <T,>(props: SandboxResourceTableProps<T>) => {
        const { t } = useLocale();
        const search = ref<string | null>(props.initialSearch ?? null);
        const filters = ref<FilterValues>({});
        const pageSize = ref(props.pageSize ?? 20);
        const total = ref(0);
        const hook = ref<{
            reset: () => void;
            refreshAsIs: () => void;
            refresh: (input: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        } | null>(null);
        let filterTimer: ReturnType<typeof setTimeout> | undefined;

        watch(
            () => props.initialSearch,
            (value) => {
                if ((value ?? null) === search.value) return;
                search.value = value ?? null;
                hook.value?.reset();
            },
        );

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
                xlsx={props.xlsx ?? true}
                noElevation={true}
                showNumber={props.showNumber ?? false}
                numberOfItemsPerPage={pageSize.value}
                numberOfItemsPerPageChoices={[
                    { label: "10", value: 10 },
                    { label: "20", value: 20 },
                    { label: "50", value: 50 },
                    { label: "100", value: 100 },
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
                            ...buildFilterQuery(props.filters ?? [], filters.value),
                            ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                        },
                    });
                }}
                TopSlot={(props.filters?.length ?? 0) > 0
                    ? () => (
                        <TableFilters
                            filters={props.filters ?? []}
                            values={filters.value}
                            total={total.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )
                    : undefined}
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
            "initialSearch",
            "showNumber",
            "xlsx",
            "onRows",
            "onRefreshReady",
        ] as any[],
    },
);

export default SandboxResourceTable;
