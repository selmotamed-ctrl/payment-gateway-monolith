import { Table } from "./Table";
import TableFilters from "./TableFilters";
import { buildFilterQuery, type FilterValues } from "./filters";
import { rowTone as rowToneFor, statusTone } from "./statusTone";
import { tableRegistry } from "./tableRegistry";
import {
    type DataTableProps,
    defaultNumberOfItemsPerPageChoices,
    type RefreshMethodApiWithoutSkip,
    type RefreshMethodData,
    type TableHeader as TableHeaderType,
    sortRowsByHeader,
} from "./types";
import { ThemedView } from "../ThemedView";
import { ThemedText } from "../ThemedText";
import { TableFooter, TableHeader } from "./HeaderFooter";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { VBtn, VDivider, VProgressCircular } from "vuetify/components";
import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/state/api";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { defaultBoxShadow } from "@/constants/styling";
import { xlsxUIPipeline, type XlsxHeader } from "@/utils/xlsx";
import { colors } from "@/plugins/vuetify";

export const DataTable = defineComponent(
    <T,>(props: DataTableProps<T>) => {
        const allData = computed(() => (isServer.value ? serverRows.value : props.data) as T[]);

        const sortDirection = ref("asc" as "asc" | "desc");
        const sortBy = ref(null as null | string);
        // A table filters even when the page does not own a search ref.
        const internalSearch = ref<string | null>(null);
        const effectiveSearch = computed(() =>
            isServer.value
                ? serverSearch.value
                : props.searchValue !== undefined
                  ? props.searchValue
                  : internalSearch.value,
        );
        const setSearchValue = (value: string | null) => {
            if (isServer.value) {
                serverSearch.value = value;
                return;
            }
            if (props.setSearchValue) {
                props.setSearchValue(value);
            } else {
                internalSearch.value = value;
            }
        };
        const total = ref(props.data.length);
        const data = ref<T[]>([]);
        const skip = ref(0);

        const route = useRoute();
        const server = computed(() => props.server ?? tableRegistry[String(route.name)] ?? null);
        const isServer = computed(() => server.value !== null);
        const storageKey = computed(() => (server.value ? server.value.storageKey ?? `pg.table.${String(route.name)}` : ""));
        const serverRows = ref<T[]>([]);
        const serverTotal = ref(0);
        const serverLoading = ref(false);
        const serverError = ref<string | null>(null);
        const serverSearch = ref<string | null>(null);
        const serverFilterValues = ref<FilterValues>({});
        const serverSortBy = ref<string | null>(server.value?.defaultSort?.key ?? null);
        const serverSortDirection = ref<"asc" | "desc">(server.value?.defaultSort?.direction ?? "asc");
        const effectiveLoading = computed(() => (isServer.value ? serverLoading.value : props.loading));
        const activeSortBy = computed(() => (isServer.value ? serverSortBy.value : sortBy.value));
        const activeSortDirection = computed(() => (isServer.value ? serverSortDirection.value : sortDirection.value));

        let fetchTimer: ReturnType<typeof setTimeout> | undefined;
        let fetchSequence = 0;

        const persistServerState = () => {
            if (!isServer.value || typeof sessionStorage === "undefined") return;
            try {
                sessionStorage.setItem(storageKey.value, JSON.stringify({
                    search: serverSearch.value,
                    filters: serverFilterValues.value,
                    sortBy: serverSortBy.value,
                    sortDirection: serverSortDirection.value,
                }));
            } catch {
                // storage is best-effort
            }
        };

        const fetchServerRows = async () => {
            const config = server.value;
            if (!config) return;
            const mine = ++fetchSequence;
            serverLoading.value = true;
            serverError.value = null;
            try {
                const response = await api.get(config.url, {
                    params: {
                        page: 1,
                        pageSize: 200,
                        ...(serverSearch.value ? { search: serverSearch.value } : {}),
                        ...(serverSortBy.value ? { sortKey: serverSortBy.value, sortDirection: serverSortDirection.value } : {}),
                        ...buildFilterQuery(config.filters ?? [], serverFilterValues.value),
                        ...(config.params ?? {}),
                    },
                });
                if (mine !== fetchSequence) return;
                const payload = response.data?.data ?? response.data ?? {};
                const raw = payload[config.listKey] ?? payload.rows ?? payload.items ?? [];
                const rows = (config.map ? config.map(raw as any[]) : raw) as T[];
                serverRows.value = rows;
                serverTotal.value = Number(payload.total ?? rows.length);
                refresh({ nextSkip: 0 });
            } catch (cause) {
                if (mine === fetchSequence) {
                    serverError.value = extractApiErrorMessage(cause);
                    serverRows.value = [];
                    refresh({ nextSkip: 0 });
                }
            } finally {
                if (mine === fetchSequence) serverLoading.value = false;
            }
        };

        const scheduleServerFetch = (delay = 0) => {
            if (!isServer.value) return;
            if (fetchTimer) clearTimeout(fetchTimer);
            fetchTimer = setTimeout(() => void fetchServerRows(), delay);
        };

        if (isServer.value && typeof sessionStorage !== "undefined") {
            try {
                const raw = sessionStorage.getItem(storageKey.value);
                if (raw) {
                    const saved = JSON.parse(raw);
                    serverSearch.value = saved.search ?? null;
                    serverFilterValues.value = saved.filters ?? {};
                    serverSortBy.value = saved.sortBy ?? null;
                    serverSortDirection.value = saved.sortDirection ?? "asc";
                }
            } catch {
                // ignore malformed persisted state
            }
        }

        onMounted(() => scheduleServerFetch());

        watch(
            [serverSearch, serverFilterValues, serverSortBy, serverSortDirection],
            () => {
                persistServerState();
                scheduleServerFetch(300);
            },
            { deep: true },
        );

        const numberOfItemsPerPage = computed(() => props.numberOfItemsPerPage || 10);

        const refresh: RefreshMethodData = async ({ nextSkip }: { nextSkip: number }) => {
            if (isServer.value) {
                const totalLength = allData.value.length;
                let target = nextSkip;
                if (target > totalLength - 1) target = 0;
                const pageRows = numberOfItemsPerPage.value > 0
                    ? allData.value.slice(target, target + numberOfItemsPerPage.value)
                    : allData.value;
                total.value = totalLength;
                skip.value = target;
                data.value = pageRows as T[];
                return;
            }
            const search = effectiveSearch.value;
            let _data = allData.value.filter((row) => {
                if (search) {
                    return JSON.stringify(row).toLowerCase().includes(search.toLowerCase());
                }
                return true;
            });
            _data = sortRowsByHeader(_data, props.headers, sortBy.value, sortDirection.value);
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

        watch(
            () => effectiveSearch.value,
            () => {
                if (isServer.value) {
                    scheduleServerFetch(300);
                    return;
                }
                reset();
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
                            loading={!!effectiveLoading.value}
                            onSearch={onSearch}
                            searchValue={effectiveSearch.value}
                            setSearchValue={setSearchValue}
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

                        {server.value?.filters?.length ? (
                            <TableFilters
                                filters={server.value.filters}
                                values={serverFilterValues.value}
                                total={serverTotal.value}
                                onChange={(key, value) => {
                                    serverFilterValues.value = { ...serverFilterValues.value, [key]: value };
                                }}
                                onClear={() => {
                                    serverFilterValues.value = {};
                                }}
                            />
                        ) : null}

                        {serverError.value ? (
                            <ThemedView
                                style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: "10px",
                                    padding: "10px 14px",
                                    borderRadius: "10px",
                                    background: "rgba(var(--v-theme-error), 0.08)",
                                    color: "rgb(var(--v-theme-error))",
                                }}
                            >
                                <ThemedText style={{ flex: 1, fontSize: "13px" }}>{serverError.value}</ThemedText>
                                <VBtn size="small" variant="tonal" color="error" onClick={() => scheduleServerFetch()}>
                                    {t("Retry")}
                                </VBtn>
                            </ThemedView>
                        ) : null}
                        {effectiveLoading.value ? (
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
                                        if (isServer.value) {
                                            serverSortBy.value = _sortBy;
                                            serverSortDirection.value = _sortDirection;
                                            return;
                                        }
                                        sortBy.value = _sortBy;
                                        sortDirection.value = _sortDirection;
                                        reset();
                                    }}
                                    sortBy={activeSortBy.value}
                                    sortDirection={activeSortDirection.value}
                                    rowColor={
                                        isServer.value
                                            ? (row: T) => theme.value[statusTone(rowToneFor(row as Record<string, unknown>))] ?? theme.value["on-surface-variant"]
                                            : props.rowColor
                                    }
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
