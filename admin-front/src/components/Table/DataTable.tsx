import { Table } from "./Table";
import {
    type DataTableProps,
    defaultNumberOfItemsPerPageChoices,
    type RefreshMethodApiWithoutSkip,
    type RefreshMethodData,
    type TableHeader as TableHeaderType,
} from "./types";
import { ThemedView } from "../ThemedView";
import { ThemedText } from "../ThemedText";
import { TableFooter, TableHeader } from "./HeaderFooter";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { VDivider, VProgressCircular } from "vuetify/components";
import { computed, defineComponent, ref, watch } from "vue";
import { defaultBoxShadow } from "@/constants/styling";
import { xlsxUIPipeline, type XlsxHeader } from "@/utils/xlsx";
import { colors } from "@/plugins/vuetify";

export const DataTable = defineComponent(
    <T,>(props: DataTableProps<T>) => {
        const allData = computed(() => props.data);

        const sortDirection = ref("asc" as "asc" | "desc");
        const sortBy = ref(null as null | string);
        const total = ref(props.data.length);
        const data = ref<T[]>([]);
        const skip = ref(0);

        const numberOfItemsPerPage = computed(() => props.numberOfItemsPerPage || 10);

        const refresh: RefreshMethodData = async ({ nextSkip }: { nextSkip: number }) => {
            let _data = allData.value.filter((row) => {
                if (props.searchValue) {
                    return JSON.stringify(row).toLowerCase().includes(props.searchValue.toLowerCase());
                }
                return true;
            });
            const totalLength = _data.length;
            if (nextSkip > _data.length - 1) {
                nextSkip = 0;
            }
            if (numberOfItemsPerPage.value > 0) {
                _data = _data.slice(nextSkip, nextSkip + numberOfItemsPerPage.value);
            }
            total.value = totalLength;
            skip.value = nextSkip;
            data.value = _data;
        };

        const display = useDisplay();
        const isMobile = computed(() => display.mobile.value);
        const reset = () =>
            refresh({
                nextSkip: 0,
            });

        const refreshAsIs = () => {
            refresh({
                nextSkip: skip.value,
            });
        };

        watch(
            () => props.numberOfItemsPerPage,
            () => {
                reset();
            },
            {
                immediate: true,
            },
        );

        watch([() => skip.value, () => props.data], () => {
            refresh({
                nextSkip: skip.value,
            });
        });

        const onSearch = () => reset();

        const currentTheme = useTheme();
        const theme = computed(() => currentTheme.current.value.colors);

        const numberOfPages = computed(() => {
            return numberOfItemsPerPage.value < 1 ? 1 : Math.ceil(Math.abs(total.value / numberOfItemsPerPage.value)) || 1;
        });

        const currentPage = computed(() => {
            return numberOfItemsPerPage.value < 1 ? 1 : Math.ceil(Math.abs(skip.value / numberOfItemsPerPage.value) + 1);
        });

        const goToPage = (targetPageNumber: number) => {
            if (targetPageNumber <= numberOfPages.value && targetPageNumber > 0 && targetPageNumber != currentPage.value) {
                const newSkipValue = numberOfItemsPerPage.value * (targetPageNumber - 1);
                refresh({
                    nextSkip: newSkipValue,
                });
            }
        };

        const hasNext = computed(() => currentPage.value < numberOfPages.value);
        const next = () => {
            if (hasNext.value) {
                goToPage(currentPage.value + 1);
            }
        };

        const hasPrev = computed(() => currentPage.value > 1);
        const prev = () => {
            if (hasPrev.value) {
                goToPage(currentPage.value - 1);
            }
        };

        const { t } = useLocale();

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
                    title: props.title,
                    data: data.value.map((d, index) => {
                        const item = {} as {
                            [key: string]: any;
                        };
                        for (const header of translatedHeaders) {
                            item[header.key] = typeof header.originalHeader.value == "function" ? header.originalHeader.value?.(d, index) : "";
                        }
                        return item;
                    }),
                });
            } catch (error) {
                console.error(error);
            } finally {
                downloadingXlsx.value = false;
            }
        };

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
                <>
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
                                {props.TopSlot({ refresh, reset, refreshAsIs })}
                                <VDivider></VDivider>
                            </ThemedView>
                        ) : (
                            <></>
                        )}

                        <TableHeader
                            loading={!!props.loading}
                            onSearch={onSearch}
                            searchValue={props.searchValue}
                            setSearchValue={props.setSearchValue}
                            title={props.title}
                            xlsx={
                                (props.xlsx ?? true)
                                    ? {
                                          disabled: !data.value?.length || props.loading || downloadingXlsx.value,
                                          handler: downloadXlsx,
                                          loading: downloadingXlsx.value,
                                      }
                                    : undefined
                            }
                            refresh={refresh}
                            Icon={props.Icon}
                            iconName={props.iconName}
                        ></TableHeader>
                        {props.loading ? (
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
                        ) : data.value.length ? (
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
                                    refreshAsIs={refreshAsIs}
                                    reset={reset}
                                    skip={skip.value}
                                    pageNumber={currentPage.value}
                                    data={data.value as T[]}
                                    refresh={refresh}
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
                                            No Data Found
                                        </ThemedText>
                                        <ThemedText
                                            style={{
                                                color: colors["on-surface-variant"],
                                                fontSize: "14px",
                                                opacity: 0.7,
                                            }}
                                        >
                                            There are no items to display
                                        </ThemedText>
                                    </ThemedView>
                                </ThemedView>
                            </>
                        )}
                        <TableFooter
                            numberOfItemsPerPage={numberOfItemsPerPage.value}
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
                            loading={props.loading || false}
                            hasNext={hasNext.value}
                            hasPrev={hasPrev.value}
                            next={next}
                            prev={prev}
                        ></TableFooter>
                    </ThemedView>
                </>
            );
        };
    },
    {
        props: [
            "Icon",
            "Row",
            "data",
            "headers",
            "iconName",
            "loading",
            "TopSlot",
            "xlsx",
            "numberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "rowColor",
            "searchValue",
            "setNumberOfItemsPerPage",
            "setSearchValue",
            "placeDividers",
            "showNumber",
            "tableContainerStyle",
            "noElevation",
            "title",
        ] as any[],
    },
);

export default DataTable;
