import { Table } from "./Table";
import TableFilters, { createTableFilterSurface, tableFilterSurfaceKey } from "./TableFilters";
import { EmptyState } from "@/components/ui/EmptyState";
import {
    type ApiTableProps,
    defaultNumberOfItemsPerPageChoices,
    type RefreshMethodApiWithoutSkip,
    sortRowsByHeader,
} from "./types";
import { ThemedText } from "../ThemedText";
import { TableFooter, TableHeader, useTableXlsx } from "./HeaderFooter";
import { api } from "@/state/api";
import { useDisplay, useLocale } from "vuetify";
import { VBtn, VProgressCircular } from "vuetify/components";
import { computed, defineComponent, provide, ref, watch } from "vue";
import type { JsonValue } from "@/utils/common";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const ApiTable = defineComponent(
    <T, RawData extends JsonValue = any>(props: ApiTableProps<T>) => {
        const display = useDisplay();
        const filterSurface = createTableFilterSurface(!display.mobile.value);
        provide(tableFilterSurfaceKey, filterSurface);

        const sortDirection = ref("asc" as "asc" | "desc");
        const sortBy = ref(null as null | string);
        // A table filters even when the page does not own a search ref.
        const internalSearch = ref<string | null>(null);
        const effectiveSearch = computed(() =>
            props.searchValue !== undefined ? props.searchValue : internalSearch.value,
        );
        const setSearchValue = (value: string | null) => {
            if (props.setSearchValue) {
                props.setSearchValue(value);
            } else {
                internalSearch.value = value;
            }
        };

        const data = ref<T[]>([]);
        const total = ref(0);
        const skip = ref(0);
        const loading = ref(false);
        const errMsg = ref(null as null | string);
        const numberOfItemsPerPage = computed(() => {
            return props.numberOfItemsPerPage || 10;
        });

        const currentPage = computed(() => {
            return numberOfItemsPerPage.value < 1 ? 1 : Math.ceil(Math.abs(skip.value / numberOfItemsPerPage.value) + 1);
        });

        const rawData = ref(null as null | RawData);

        const title = computed(() => {
            if (typeof props.title == "function") {
                return props.title(rawData.value);
            }
            return props.title;
        });

        const refresh = async ({ queryParams, nextSkip }: { queryParams?: any; nextSkip: number }) => {
            const apiHeaders = props.apiHeaders;
            const url = props.url;
            console.log("called Refresh...", {
                apiHeaders,
                url,
                queryParams,
            });
            loading.value = true;
            errMsg.value = null;

            try {
                const result = await api.get(url, {
                    params: queryParams,
                    headers: apiHeaders,
                });
                rawData.value = result.data;
                console.log("result", title.value, {
                    queryParams,
                    nextSkip,
                    result: result.data,
                });
                const extracted = props.apiDataExtractor(result.data);
                const search = effectiveSearch.value;
                const searched = props.localSearch === false || !search
                    ? extracted
                    : extracted.filter((row: T) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
                skip.value = nextSkip;
                data.value = sortRowsByHeader(searched, props.headers, sortBy.value, sortDirection.value);
                total.value = props.apiTotalExtractor(result.data);
                props.onData?.(data.value as T[], total.value);
                if (props.apiPageSizeExtractor) {
                    props.setNumberOfItemsPerPage?.(props.apiPageSizeExtractor(result.data));
                }
            } catch (error) {
                console.error("Refresh Error", error);
                errMsg.value = extractApiErrorMessage(error);
            } finally {
                loading.value = false;
            }
        };

        const reset = () =>
            props.onRefresh(
                {
                    page: 1,
                    skip: 0,
                    sortKey: sortBy.value,
                    sortDirection: sortDirection.value,
                },
                (async (props) => {
                    refresh({
                        ...props,
                        nextSkip: 0,
                    });
                }) satisfies RefreshMethodApiWithoutSkip,
            );

        const refreshAsIs = () =>
            props.onRefresh(
                {
                    page: currentPage.value,
                    skip: skip.value,
                    sortKey: sortBy.value,
                    sortDirection: sortDirection.value,
                },
                (async (props) => {
                    refresh({
                        ...props,
                        nextSkip: skip.value,
                    });
                }) satisfies RefreshMethodApiWithoutSkip,
            );

        watch(
            [() => props.numberOfItemsPerPage, () => props.url],
            () => {
                reset();
            },
            {
                immediate: true,
            },
        );

        watch(
            () => effectiveSearch.value,
            () => {
                reset();
            },
        );

        const onSearch = () => reset();

        const numberOfPages = computed(() => {
            return numberOfItemsPerPage.value < 1 ? 1 : Math.ceil(Math.abs(total.value / numberOfItemsPerPage.value)) || 1;
        });

        const goToPage = (targetPageNumber: number) => {
            if (targetPageNumber <= numberOfPages.value && targetPageNumber > 0 && targetPageNumber != currentPage.value) {
                console.log("going to page", targetPageNumber);
                const newSkipValue = numberOfItemsPerPage.value * (targetPageNumber - 1);

                props.onRefresh(
                    {
                        skip: newSkipValue,
                        page: targetPageNumber,
                        sortKey: sortBy.value,
                        sortDirection: sortDirection.value,
                    },
                    (async (props) => {
                        refresh({
                            ...props,
                            nextSkip: newSkipValue,
                        });
                    }) satisfies RefreshMethodApiWithoutSkip,
                );
            }
        };

        const hasNext = computed(() => {
            return currentPage.value < numberOfPages.value;
        });

        const { t } = useLocale();

        const next = () => {
            if (hasNext.value) {
                goToPage(currentPage.value + 1);
            }
        };

        const hasPrev = computed(() => {
            return currentPage.value > 1;
        });
        const prev = () => {
            if (hasPrev.value) {
                goToPage(currentPage.value - 1);
            }
        };

        const { downloadingXlsx, downloadXlsx } = useTableXlsx({
            headers: () => props.headers,
            data: () => data.value,
            title: () => title.value,
        });

        onMounted(() => {
            if (props.setRefreshHook) {
                props.setRefreshHook({ refresh, reset, refreshAsIs });
            }
        });

        onUnmounted(() => {
            if (props.clearRefreshHook) {
                props.clearRefreshHook({ refresh, reset, refreshAsIs });
            }
        });
        return () => {
            if (props.showNumber) {
                if (props.headers[0]?.key != "__no") {
                    props.headers.unshift({
                        value: (_, index) => String(index + 1 + skip.value),
                        key: "__no",
                        label: "No.",
                        minWidth: true,
                        sortable: false,
                    });
                } else {
                    props.headers[0] = {
                        value: (_, index) => String(index + 1 + skip.value),
                        key: "__no",
                        label: "No",
                        minWidth: true,
                        sortable: false,
                    };
                }
            }
            const filterControl = filterSurface.hasFilters.value
                ? {
                      count: filterSurface.activeCount.value,
                      open: filterSurface.open.value,
                      toggle: filterSurface.toggle,
                  }
                : undefined;

            return (
                <SurfaceCard noPadding class="pg-unified-table">
                    <TableHeader
                        loading={loading.value}
                        onSearch={onSearch}
                        onRefresh={refreshAsIs}
                        total={total.value}
                        filterControl={filterControl}
                        xlsx={
                            (props.xlsx ?? true)
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
                    ></TableHeader>
                    {props.TopSlot ? props.TopSlot({ loading: loading.value, refresh, reset, refreshAsIs }) : null}
                    {props.filters?.length ? (
                        <TableFilters
                            filters={props.filters}
                            values={props.filterValues ?? {}}
                            total={props.filterTotal}
                            onChange={(key, value) => props.onFilterChange?.(key, value)}
                            onClear={() => props.onFilterClear?.()}
                        />
                    ) : null}
                    {loading.value ? (
                        <div class="pg-table-loading">
                            <VProgressCircular indeterminate size={40} color="primary" width={3}></VProgressCircular>
                        </div>
                    ) : errMsg.value ? (
                        <div class="pg-table-banner pg-table-banner--error" role="alert">
                            <ThemedText style={{ flex: 1, fontSize: "13px" }}>{errMsg.value}</ThemedText>
                            <VBtn size="small" variant="tonal" color="error" onClick={() => reset()}>
                                {t("Retry")}
                            </VBtn>
                        </div>
                    ) : data.value?.length ? (
                        <Table
                            {...props}
                            onSetSort={(_sortBy, _sortDirection) => {
                                sortBy.value = _sortBy;
                                sortDirection.value = _sortDirection;
                                reset();
                            }}
                            sortBy={sortBy.value}
                            sortDirection={sortDirection.value}
                            reset={reset}
                            skip={skip.value}
                            pageNumber={currentPage.value}
                            data={data.value as T[]}
                            refresh={refresh}
                            refreshAsIs={refreshAsIs}
                        ></Table>
                    ) : (
                        <EmptyState title={t("No Data Found")} description={t("There are no items to display")} icon="mdi-inbox-outline" />
                    )}
                    <TableFooter
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
                    ></TableFooter>
                </SurfaceCard>
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
        ] as any[],
    },
);

export default ApiTable;
