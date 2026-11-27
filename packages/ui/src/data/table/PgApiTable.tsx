import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { dc } from "../../lib/dc";
import { usePgUiConfig } from "../../lib/config";
import { useLocale } from "../../lib/locale";
import { useDisplay } from "../../lib/display";
import { PgCard } from "../../layout/PgLayout";
import { PgEmptyState } from "../../feedback/PgEmptyState";
import { PgButton } from "../../actions/PgButton";
import { PgSpinner } from "../../actions/PgFeedbackAtoms";
import { PgTable } from "./Table";
import { createTableFilterSurface, tableFilterSurfaceKey, PgTableFilters } from "./TableFilters";
import { PgTableFooter, PgTableHeader, useTableXlsx } from "./HeaderFooter";
import {
    defaultNumberOfItemsPerPageChoices,
    sortRowsByHeader,
    type ApiTableProps,
    type RefreshMethodApiWithoutSkip,
} from "./types";

/**
 * Data-connected table. It owns fetch state, local search, sorting and paging
 * while the presentational pieces (`PgTable`, toolbar, filters, footer) stay in
 * the design system. The host supplies the API client through `<PgProvider>`.
 */
export const PgApiTable = dc(
    <T, RawData = any>(props: ApiTableProps<T>, _expose, { attrs }) => {
        const config = usePgUiConfig();
        const { t } = useLocale();
        const display = useDisplay();
        const filterSurface = createTableFilterSurface(!display.mobile.value);
        provide(tableFilterSurfaceKey, filterSurface);

        const sortDirection = ref<"asc" | "desc">("asc");
        const sortBy = ref<string | null>(null);
        const internalSearch = ref<string | null>(null);
        const effectiveSearch = computed(() =>
            props.searchValue !== undefined ? props.searchValue : internalSearch.value,
        );
        const setSearchValue = (value: string | null) => {
            if (props.setSearchValue) props.setSearchValue(value);
            else internalSearch.value = value;
        };

        const data = ref<T[]>([]);
        const total = ref(0);
        const skip = ref(0);
        const loading = ref(false);
        const errorMessage = ref<string | null>(null);
        const rawData = ref<RawData | null>(null);
        const numberOfItemsPerPage = computed(() => props.numberOfItemsPerPage || 10);
        const currentPage = computed(() =>
            numberOfItemsPerPage.value < 1 ? 1 : Math.ceil(Math.abs(skip.value / numberOfItemsPerPage.value) + 1),
        );
        const title = computed(() => (typeof props.title === "function" ? props.title(rawData.value) : props.title));

        const refresh = async ({ queryParams, nextSkip }: { queryParams?: any; nextSkip: number }) => {
            loading.value = true;
            errorMessage.value = null;
            try {
                if (!config.api) throw new Error("No API client configured for PgApiTable");
                const result = await config.api.get(props.url, { params: queryParams, headers: props.apiHeaders });
                rawData.value = result.data;
                const extracted = props.apiDataExtractor(result.data) as T[];
                const search = effectiveSearch.value;
                const searched =
                    props.localSearch === false || !search
                        ? extracted
                        : extracted.filter((row) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
                skip.value = nextSkip;
                data.value = sortRowsByHeader(searched, props.headers, sortBy.value, sortDirection.value);
                total.value = props.apiTotalExtractor(result.data);
                props.onData?.(data.value as T[], total.value);
                if (props.apiPageSizeExtractor) props.setNumberOfItemsPerPage?.(props.apiPageSizeExtractor(result.data));
            } catch (error) {
                console.error("Refresh Error", error);
                errorMessage.value = config.extractApiError?.(error)?.error ?? "Could not load data";
            } finally {
                loading.value = false;
            }
        };

        const reset = () =>
            props.onRefresh({ page: 1, skip: 0, sortKey: sortBy.value, sortDirection: sortDirection.value }, (async (next: any) => {
                await refresh({ ...next, nextSkip: 0 });
            }) satisfies RefreshMethodApiWithoutSkip);

        const refreshAsIs = () =>
            props.onRefresh(
                { page: currentPage.value, skip: skip.value, sortKey: sortBy.value, sortDirection: sortDirection.value },
                (async (next: any) => {
                    await refresh({ ...next, nextSkip: skip.value });
                }) satisfies RefreshMethodApiWithoutSkip,
            );

        watch(
            [() => props.numberOfItemsPerPage, () => props.url],
            () => reset(),
            { immediate: true },
        );
        watch(() => effectiveSearch.value, () => reset());
        const onSearch = () => reset();

        const numberOfPages = computed(() =>
            numberOfItemsPerPage.value < 1 ? 1 : Math.ceil(Math.abs(total.value / numberOfItemsPerPage.value)) || 1,
        );
        const goToPage = (targetPageNumber: number) => {
            if (targetPageNumber <= numberOfPages.value && targetPageNumber > 0 && targetPageNumber !== currentPage.value) {
                const newSkip = numberOfItemsPerPage.value * (targetPageNumber - 1);
                props.onRefresh(
                    { skip: newSkip, page: targetPageNumber, sortKey: sortBy.value, sortDirection: sortDirection.value },
                    (async (next: any) => {
                        await refresh({ ...next, nextSkip: newSkip });
                    }) satisfies RefreshMethodApiWithoutSkip,
                );
            }
        };
        const hasNext = computed(() => currentPage.value < numberOfPages.value);
        const hasPrev = computed(() => currentPage.value > 1);
        const next = () => hasNext.value && goToPage(currentPage.value + 1);
        const prev = () => hasPrev.value && goToPage(currentPage.value - 1);

        const { downloadingXlsx, downloadXlsx } = useTableXlsx({
            headers: () => props.headers,
            data: () => data.value,
            title: () => title.value,
        });

        onMounted(() => props.setRefreshHook?.({ refresh, reset, refreshAsIs }));
        onUnmounted(() => props.clearRefreshHook?.({ refresh, reset, refreshAsIs }));

        return () => {
            if (props.showNumber && props.headers[0]?.key !== "__no") {
                props.headers.unshift({
                    value: (_row: T, index: number) => String(index + 1 + skip.value),
                    key: "__no",
                    label: "No.",
                    minWidth: true,
                    sortable: false,
                } as any);
            }
            const filterControl = filterSurface.hasFilters.value
                ? { count: filterSurface.activeCount.value, open: filterSurface.open.value, toggle: filterSurface.toggle }
                : undefined;
            return (
                <PgCard noPadding class="pg-table-card pg-unified-table">
                    <PgTableHeader
                        loading={loading.value}
                        onSearch={onSearch}
                        onRefresh={refreshAsIs}
                        total={total.value}
                        filterControl={filterControl}
                        xlsx={
                            props.xlsx ?? true
                                ? {
                                      disabled: !data.value?.length || loading.value || downloadingXlsx.value,
                                      handler: downloadXlsx,
                                      loading: downloadingXlsx.value,
                                  }
                                : undefined
                        }
                        searchValue={effectiveSearch.value}
                        setSearchValue={setSearchValue}
                        title={title.value}
                        refresh={refresh}
                        Icon={props.Icon}
                        iconName={props.iconName}
                    />
                    {props.TopSlot ? props.TopSlot({ loading: loading.value, refresh, reset, refreshAsIs }) : null}
                    {props.filters?.length ? (
                        <PgTableFilters
                            filters={props.filters}
                            values={props.filterValues ?? {}}
                            total={props.filterTotal}
                            onChange={(key, value) => props.onFilterChange?.(key, value)}
                            onClear={() => props.onFilterClear?.()}
                        />
                    ) : null}
                    {loading.value ? (
                        <div class="pg-table-loading">
                            <PgSpinner size={38} />
                        </div>
                    ) : errorMessage.value ? (
                        <div class="pg-table-banner pg-table-banner--error" role="alert">
                            <span class="pg-text">{errorMessage.value}</span>
                            <PgButton size="sm" variant="tonal" color="error" onClick={() => reset()}>
                                {t("Retry")}
                            </PgButton>
                        </div>
                    ) : data.value?.length ? (
                        <PgTable
                            {...props}
                            onSetSort={(nextSortBy, nextSortDirection) => {
                                sortBy.value = nextSortBy;
                                sortDirection.value = nextSortDirection;
                                reset();
                            }}
                            sortBy={sortBy.value}
                            sortDirection={sortDirection.value}
                            reset={reset}
                            skip={skip.value}
                            pageNumber={currentPage.value}
                            data={data.value}
                            refresh={refresh}
                            refreshAsIs={refreshAsIs}
                        />
                    ) : (
                        <PgEmptyState title={t("No Data Found")} description={t("There are no items to display")} icon="mdi-inbox-outline" />
                    )}
                    <PgTableFooter
                        numberOfItemsPerPage={props.numberOfItemsPerPage || 10}
                        numberOfItemsPerPageChoices={
                            props.numberOfItemsPerPageChoices === undefined
                                ? defaultNumberOfItemsPerPageChoices
                                : props.numberOfItemsPerPageChoices || undefined
                        }
                        setNumberOfItemsPerPage={props.setNumberOfItemsPerPage}
                        totalDataLength={total.value}
                        currentPage={currentPage.value}
                        goToPage={goToPage}
                        numberOfPages={numberOfPages.value}
                        loading={loading.value}
                        hasNext={hasNext.value}
                        hasPrev={hasPrev.value}
                        next={next}
                        prev={prev}
                    />
                </PgCard>
            );
        };
    },
    {
        props: [
            "Icon",
            "Row",
            "TopSlot",
            "apiDataExtractor",
            "apiHeaders",
            "apiTotalExtractor",
            "headers",
            "placeDividers",
            "iconName",
            "setRefreshHook",
            "clearRefreshHook",
            "loading",
            "numberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "onRefresh",
            "onSort",
            "noElevation",
            "rowColor",
            "searchValue",
            "setNumberOfItemsPerPage",
            "setSearchValue",
            "showNumber",
            "tableContainerStyle",
            "title",
            "url",
            "apiPageSizeExtractor",
            "localSearch",
            "onData",
            "filters",
            "filterValues",
            "filterTotal",
            "onFilterChange",
            "onFilterClear",
            "xlsx",
        ] as any[],
        inheritAttrs: true,
    },
);

export default PgApiTable;
