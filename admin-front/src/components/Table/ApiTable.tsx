import { Table } from "./Table";
import {
    type ApiTableProps,
    defaultNumberOfItemsPerPageChoices,
    type RefreshMethodApiWithoutSkip,
    type TableHeader as TableHeaderType,
    sortRowsByHeader,
} from "./types";
import { ThemedView } from "../ThemedView";
import { ThemedText } from "../ThemedText";
import { TableFooter, TableHeader } from "./HeaderFooter";
import { api } from "@/state/api";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { AlertView } from "../AlertView";
import { VDivider, VProgressCircular } from "vuetify/components";
import { computed, defineComponent, ref, watch } from "vue";
import { defaultBoxShadow } from "@/constants/styling";
import type { JsonValue } from "@/utils/common";
import { xlsxUIPipeline, type XlsxHeader } from "@/utils/xlsx";
import { colors } from "@/plugins/vuetify";

export const ApiTable = defineComponent(
    <T, RawData extends JsonValue = any>(props: ApiTableProps<T>) => {
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
                const searched = search
                    ? extracted.filter((row: T) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase()))
                    : extracted;
                skip.value = nextSkip;
                data.value = sortRowsByHeader(searched, props.headers, sortBy.value, sortDirection.value);
                total.value = props.apiTotalExtractor(result.data);
                if (props.apiPageSizeExtractor) {
                    console.log("Setting page size from data", props.apiPageSizeExtractor(result.data));
                    props.setNumberOfItemsPerPage?.(props.apiPageSizeExtractor(result.data));
                }
            } catch (error) {
                console.log("Refresh Error", error);
                errMsg.value = "Something Went Wrong!";
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

        const display = useDisplay();
        const isMobile = computed(() => {
            return display.mobile.value;
        });

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

        const currentTheme = useTheme();
        const theme = computed(() => {
            return currentTheme.current.value.colors;
        });

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

        const downloadingXlsx = ref(false);

        const translatedHeaders = [] as (XlsxHeader & {
            originalHeader: TableHeaderType<any>;
        })[];
        const translateTableHeadersToXlsxHeader = (
            headers: TableHeaderType<any>[],
        ): (XlsxHeader & {
            originalHeader: TableHeaderType<any>;
        })[] => {
            if (translatedHeaders.length) {
                return translatedHeaders;
            }
            for (const th of headers) {
                if (!th.value) {
                    console.log("skipping header", th);
                    continue;
                }
                translatedHeaders.push({
                    key: th.key,
                    text: typeof th.label == "string" ? t(th.label) : th.key,
                    type: "string",
                    required: false,
                    originalHeader: th,
                });
            }

            return translatedHeaders;
        };

        const downloadXlsx = async () => {
            if (downloadingXlsx.value || !data.value?.length) {
                return;
            }
            downloadingXlsx.value = true;
            try {
                const translatedHeaders = translateTableHeadersToXlsxHeader(props.headers);
                await xlsxUIPipeline.downloadXlsxFromHeadersAndData({
                    color: colors.blue.base,
                    headers: translatedHeaders,
                    title: typeof props.title == "function" ? props.title(data) : props.title,
                    data: data.value.map((d, index) => {
                        const item = {} as {
                            [key: string]: any;
                        };
                        for (const header of translatedHeaders) {
                            item[header.key] = typeof header.originalHeader.value == "function" ? header.originalHeader.value?.(d, index) : "";
                        }
                        console.log("rendered item", item);
                        return item;
                    }),
                });
            } catch (error) {
                console.error(error);
            } finally {
                downloadingXlsx.value = false;
            }
        };

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
            const isDark = currentTheme.current.value.dark;
            const colors = currentTheme.current.value.colors;
            if (props.showNumber) {
                if (props.headers[0]?.key != "__no") {
                    props.headers.unshift({
                        value: (_, index) => String(index + 1 + skip.value),
                        key: "__no",
                        label: "No.",
                        minWidth: true,
                    });
                } else {
                    props.headers[0] = {
                        value: (_, index) => String(index + 1 + skip.value),
                        key: "__no",
                        label: "No",
                        minWidth: true,
                    };
                }
            }
            return (
                <ThemedView
                    style={{
                        flexDirection: "column",
                        gap: "16px",
                        padding: isMobile.value ? "16px" : "24px",
                        backgroundColor: isDark ? colors.surface : "#ffffff",
                        borderRadius: "12px",
                        boxShadow: props.noElevation ? undefined : defaultBoxShadow,
                        border: props.noElevation ? undefined : isDark ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid #e2e8f0",
                    }}
                >
                    {props.TopSlot ? (
                        <ThemedView
                            style={{
                                gap: "12px",
                            }}
                        >
                            {props.TopSlot({ loading: loading.value, refresh, reset, refreshAsIs })}
                            <VDivider></VDivider>
                        </ThemedView>
                    ) : (
                        <></>
                    )}
                    <TableHeader
                        loading={!!props.loading}
                        onSearch={onSearch}
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
                    {loading.value ? (
                        <>
                            <ThemedView
                                style={{
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "100%",
                                    minHeight: "200px",
                                    padding: "40px",
                                }}
                            >
                                <VProgressCircular indeterminate size={64} color="primary" width={4}></VProgressCircular>
                            </ThemedView>
                        </>
                    ) : errMsg.value ? (
                        <>
                            <AlertView
                                style={{
                                    alignItems: "center",
                                    justifyContent: "center",
                                    minHeight: "200px",
                                    flex: "1",
                                    padding: "40px",
                                }}
                                message={errMsg.value}
                                type="error"
                            ></AlertView>
                        </>
                    ) : data.value?.length ? (
                        <>
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
                        </>
                    ) : (
                        <>
                            <ThemedView
                                id="NoData"
                                style={{
                                    padding: "60px 40px",
                                    borderRadius: "8px",
                                    borderWidth: "1px",
                                    borderStyle: "solid",
                                    borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "#e2e8f0",
                                    backgroundColor: isDark ? colors["surface-variant"] : "#f8fafc",
                                }}
                            >
                                <ThemedView
                                    style={{
                                        alignItems: "center",
                                        justifyContent: "center",
                                        flexDirection: "column",
                                        gap: "12px",
                                    }}
                                >
                                    <ThemedText
                                        style={{
                                            color: colors["on-surface-variant"],
                                            fontSize: "16px",
                                            fontWeight: "500",
                                        }}
                                    >
                                        {t("No Data Found")}
                                    </ThemedText>
                                    <ThemedText
                                        style={{
                                            color: colors["on-surface-variant"],
                                            fontSize: "14px",
                                            opacity: 0.7,
                                        }}
                                    >
                                        {t("There are no items to display")}
                                    </ThemedText>
                                </ThemedView>
                            </ThemedView>
                        </>
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
                </ThemedView>
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
        ] as any[],
    },
);

export default ApiTable;
