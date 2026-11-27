import { createIf } from "@vue/runtime-vapor";
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { dc } from "../../lib/dc";

/** Vapor JSX returns a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { usePgUiConfig } from "../../lib/config";
import { useLocale } from "../../lib/locale";
import { useDisplay } from "../../lib/display";
import { PgCard } from "../../layout/PgLayout";
import { PgStateView } from "../../feedback/PgStateView";
import { PgButton } from "../../actions/PgButton";
import { PgProgressBar } from "../../actions/PgFeedbackAtoms";
import { PgTable } from "./Table";
import { createTableFilterSurface, tableFilterSurfaceKey, PgTableFilters } from "./TableFilters";
import { PgTableFooter, PgTableHeader, useTableXlsx } from "./HeaderFooter";
import { activeFilterCount, buildFilterQuery, type FilterValues, type TableFilter } from "./filters";
import {
    sortRowsByHeader,
    type BaseTableProps,
    type RefreshMethodApiWithoutSkip,
    type RefreshMethodWithNextSkip,
    type TableHeader,
} from "./types";

type ApiEnvelope<T> = { items: T[]; total: number };

export type PgApiTableProps<T, RawData = any> = BaseTableProps<T> & {
    title?: string | ((data: RawData) => string);
    headers: TableHeader<T>[];

    /* Legacy host-driven contract (kept for every existing page). */
    url?: string;
    apiHeaders?: any;
    apiDataExtractor?: (data: RawData) => T[];
    apiTotalExtractor?: (data: RawData) => number;
    apiPageSizeExtractor?: (data: RawData) => number;
    onRefresh?: (
        props: { skip: number; page: number; sortKey: string | null; sortDirection: "asc" | "desc" },
        refresh: RefreshMethodApiWithoutSkip,
    ) => void;
    onSort?: (sortTarget: { headerKey: string; direction: "desc" | "asc" }, refresh: RefreshMethodApiWithoutSkip) => Promise<void> | void;
    setRefreshHook?: (props: {
        reset: () => void;
        refresh: RefreshMethodWithNextSkip;
        refreshAsIs: () => void;
    }) => void;
    clearRefreshHook?: (props: {
        reset: () => void;
        refresh: RefreshMethodWithNextSkip;
        refreshAsIs: () => void;
    }) => void;
    /* Filter/toolbar surface (shared by both contracts). */
    filters?: TableFilter[];
    filterValues?: FilterValues;
    filterTotal?: number;
    onFilterChange?: (key: string, value: unknown) => void;
    onFilterClear?: () => void;
    localSearch?: boolean;
    onData?: (rows: T[], total: number) => void;
    TopSlot?: (props: {
        reset: () => void;
        refresh: RefreshMethodWithNextSkip;
        refreshAsIs: () => void;
    }) => any;

    /* 2026 self-contained contract. */
    endpoint?: string;
    fetcher?: (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
    params?: Record<string, unknown>;
    defaultSort?: { key: string; direction: "asc" | "desc" };
    defaultPageSize?: number;
    syncUrl?: boolean;
    exportFilename?: string;
    pageSizeOptions?: number[];
    emptyTitle?: string;
    emptyDescription?: string;
    hiddenColumns?: string[];
    onRowClick?: (row: T, index: number) => void;
    rowKey?: (row: T, index: number) => string | number;
    selectable?: boolean;
    selectedKeys?: Array<string | number>;
    onSelectionChange?: (keys: Array<string | number>, rows: T[]) => void;
    density?: "comfortable" | "compact" | string;
    skeletonRows?: number;
};

const isAbortError = (error: unknown): boolean =>
    Boolean(error && typeof error === "object" && ((error as { name?: string }).name === "AbortError" || (error as { code?: string }).code === "ERR_CANCELED"));

const envelopeOf = <T,>(payload: any): ApiEnvelope<T> => {
    if (Array.isArray(payload)) return { items: payload as T[], total: payload.length };
    if (!payload || typeof payload !== "object") return { items: [], total: 0 };
    const items = payload.items ?? payload.rows ?? payload.data ?? [];
    const list = Array.isArray(items) ? (items as T[]) : [];
    const total = payload.total ?? payload.meta?.total ?? payload.count ?? list.length;
    return { items: list, total: Number.isFinite(Number(total)) ? Number(total) : list.length };
};

const readInitialParam = (key: string): string | null => {
    if (typeof window === "undefined" || !window.location?.search) return null;
    try {
        return new URLSearchParams(window.location.search).get(key);
    } catch {
        return null;
    }
};

/** Restores bookmarked filter values from the query string. */
const readInitialFilters = (filters: TableFilter[] | undefined, enabled: boolean): FilterValues => {
    if (!enabled || !filters?.length) return {};
    const values: FilterValues = {};
    for (const filter of filters) {
        if (filter.type === "number-range") {
            const min = readInitialParam(filter.queryMin ?? `${filter.key}Min`);
            const max = readInitialParam(filter.queryMax ?? `${filter.key}Max`);
            if (min !== null || max !== null) values[filter.key] = { min: min ?? "", max: max ?? "" };
            continue;
        }
        if (filter.type === "date") {
            const from = readInitialParam(filter.queryFrom ?? "from");
            const to = readInitialParam(filter.queryTo ?? "to");
            if (from !== null || to !== null) values[filter.key] = { from: from ?? "", to: to ?? "" };
            continue;
        }
        const raw = readInitialParam(filter.query ?? filter.key);
        if (raw === null || raw === "") continue;
        values[filter.key] =
            (filter.type === "data-autocomplete" || filter.type === "api-autocomplete") && filter.multiple
                ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
                : raw;
    }
    return values;
};

/**
 * The server-backed operational table.
 *
 * One request pipeline drives both the legacy host `onRefresh` contract and the
 * 2026 `endpoint`/`fetcher` contract. Every search, filter, sort or page-size
 * change aborts the previous request, resets to page 1 where required, keeps the
 * loaded rows visible during a background refetch (thin 3px progress bar) and
 * renders skeletons only on the very first load.
 */
export const PgApiTable = dc(
    <T, RawData = any>(
        props: PgApiTableProps<T, RawData>,
        expose: any,
        { emit }: any,
    ) => {
        const config = usePgUiConfig();
        const { t } = useLocale();
        const display = useDisplay();
        const filterSurface = createTableFilterSurface(!display.mobile.value);
        provide(tableFilterSurfaceKey, filterSurface);

        const isModern = typeof props.fetcher === "function" || Boolean(props.endpoint);
        const syncFromUrl = props.syncUrl !== false;
        const initialPage = syncFromUrl ? Math.max(1, Number(readInitialParam("page")) || 1) : 1;
        const initialSize = Math.max(
            1,
            (syncFromUrl ? Number(readInitialParam("pageSize")) : 0) ||
                Number(props.defaultPageSize) ||
                Number(props.numberOfItemsPerPage) ||
                25,
        );
        const initialSearch = syncFromUrl ? (readInitialParam("search") ?? "") : "";

        const rows = ref<T[]>([]) as { value: T[] };
        const total = ref(0);
        const page = ref(isModern ? initialPage : 1);
        const pageSize = ref(
            Number(props.numberOfItemsPerPage) > 0
                ? Number(props.numberOfItemsPerPage)
                : Number(props.defaultPageSize) > 0
                  ? Number(props.defaultPageSize)
                  : isModern
                    ? initialSize
                    : 25,
        );
        const skip = ref(isModern ? (page.value - 1) * pageSize.value : 0);
        const loading = ref(isModern);
        const hasLoaded = ref(false);
        const errorMessage = ref<string | null>(null);
        const rawData = ref<any>(null);
        const searchDisplay = ref(String(props.searchValue ?? initialSearch));
        const searchTerm = ref(String(props.searchValue ?? initialSearch));
        const internalSearch = ref<string | null>(null);
        const sortBy = ref<string | null>((syncFromUrl ? readInitialParam("sortKey") : null) ?? props.defaultSort?.key ?? null);
        const sortDirection = ref<"asc" | "desc">(
            ((syncFromUrl ? readInitialParam("sortDirection") : null) as "asc" | "desc" | null) ??
                props.defaultSort?.direction ??
                "asc",
        );
        const filterValues = ref<FilterValues>({
            ...readInitialFilters(props.filters, syncFromUrl),
            ...(props.filterValues ?? {}),
        });
        const hidden = ref<Record<string, boolean>>(
            Object.fromEntries(
                (props.hiddenColumns ?? [])
                    .filter((key) => key !== "actions" && key !== "__no")
                    .map((key) => [key, true]),
            ),
        );

        const controller = ref<AbortController | null>(null);
        let sequence = 0;

        const headersList = computed<TableHeader<T>[]>(() => {
            const list = [...(props.headers ?? [])];
            if (props.showNumber && list[0]?.key !== "__no") {
                list.unshift({
                    value: (_row: T, index: number) => String(index + 1 + skip.value),
                    key: "__no",
                    label: "No.",
                    minWidth: true,
                    sortable: false,
                } as any);
            }
            return list;
        });
        const visibleHeaders = computed(() => headersList.value.filter((header) => !hidden.value[header.key]));
        const columnChoices = computed(() =>
            headersList.value
                .filter((header) => header.key !== "__no")
                .map((header) => ({
                    key: header.key,
                    label: header.label ?? header.key,
                    visible: !hidden.value[header.key],
                    hideable: header.key !== "actions",
                })),
        );

        const title = computed(() =>
            typeof props.title === "function"
                ? rawData.value === null || rawData.value === undefined
                    ? ""
                    : props.title(rawData.value as RawData)
                : String(props.title ?? ""),
        );
        const effectiveSearch = computed(() => (props.searchValue !== undefined ? props.searchValue : internalSearch.value));
        const numberOfPages = computed(() => Math.max(1, Math.ceil(total.value / Math.max(1, pageSize.value))));
        const currentPage = computed(() =>
            isModern ? page.value : Math.max(1, Math.floor(skip.value / Math.max(1, pageSize.value)) + 1),
        );
        const activeFilters = computed(() => activeFilterCount(props.filters ?? [], filterValues.value));
        const filtered = computed(() => activeFilters.value > 0 || Boolean(searchDisplay.value || searchTerm.value));

        const abortCurrent = () => {
            controller.value?.abort();
            controller.value = null;
        };

        const beginRequest = () => {
            abortCurrent();
            const next = new AbortController();
            controller.value = next;
            const mine = ++sequence;
            loading.value = true;
            errorMessage.value = null;
            return { signal: next.signal, mine };
        };

        const finishRequest = (mine: number) => {
            if (mine !== sequence) return;
            loading.value = false;
        };

        const failRequest = (mine: number, error: unknown, signal: AbortSignal) => {
            if (mine !== sequence || signal.aborted || isAbortError(error)) return;
            const extracted = config.extractApiError?.(error);
            errorMessage.value = extracted?.error ?? extracted?.message ?? t("Could not load data");
            emit?.("error", error);
        };

        /* --------------------------------------------------------- legacy */

        const legacyRefresh = async ({ queryParams, nextSkip }: { queryParams?: any; nextSkip: number }) => {
            const { signal, mine } = beginRequest();
            try {
                if (!config.api) throw new Error("No API client configured for PgApiTable");
                const result = await config.api.get(props.url as string, {
                    params: queryParams,
                    headers: props.apiHeaders,
                    signal,
                });
                if (mine !== sequence) return;
                const payload = result?.data as RawData;
                rawData.value = payload;
                const extracted = props.apiDataExtractor ? props.apiDataExtractor(payload) : envelopeOf<T>(payload).items;
                const search = effectiveSearch.value;
                const searched =
                    props.localSearch === false || !search
                        ? extracted
                        : extracted.filter((row) => JSON.stringify(row).toLowerCase().includes(String(search).toLowerCase()));
                skip.value = nextSkip;
                rows.value = sortRowsByHeader(searched, headersList.value, sortBy.value, sortDirection.value);
                total.value = props.apiTotalExtractor ? props.apiTotalExtractor(payload) : envelopeOf<T>(payload).total;
                hasLoaded.value = true;
                props.onData?.(rows.value, total.value);
                emit?.("loaded", { rows: rows.value, total: total.value, raw: payload });
                if (props.apiPageSizeExtractor) {
                    const next = props.apiPageSizeExtractor(payload);
                    if (Number(next) > 0) {
                        pageSize.value = Number(next);
                        props.setNumberOfItemsPerPage?.(Number(next));
                    }
                }
            } catch (error) {
                failRequest(mine, error, signal);
            } finally {
                finishRequest(mine);
            }
        };

        const reset = () => {
            skip.value = 0;
            page.value = 1;
            props.onRefresh?.(
                { page: 1, skip: 0, sortKey: sortBy.value, sortDirection: sortDirection.value },
                (async (next: any) => {
                    await legacyRefresh({ ...next, nextSkip: 0 });
                }) satisfies RefreshMethodApiWithoutSkip,
            );
        };
        const refreshAsIs = () => {
            props.onRefresh?.(
                { page: currentPage.value, skip: skip.value, sortKey: sortBy.value, sortDirection: sortDirection.value },
                (async (next: any) => {
                    await legacyRefresh({ ...next, nextSkip: skip.value });
                }) satisfies RefreshMethodApiWithoutSkip,
            );
        };

        /* --------------------------------------------------------- modern */

        const modernParams = () => ({
            page: page.value,
            pageSize: pageSize.value,
            ...(searchTerm.value ? { search: searchTerm.value } : {}),
            ...(sortBy.value ? { sortKey: sortBy.value, sortDirection: sortDirection.value } : {}),
            ...buildFilterQuery(props.filters ?? [], filterValues.value),
            ...(props.params ?? {}),
        });

        const syncUrl = (params: Record<string, unknown>) => {
            if (props.syncUrl === false || !isModern) return;
            if (typeof window === "undefined" || !window.history?.replaceState) return;
            try {
                const url = new URL(window.location.href);
                url.searchParams.set("page", String(params.page));
                url.searchParams.set("pageSize", String(params.pageSize));
                if (params.search) url.searchParams.set("search", String(params.search));
                else url.searchParams.delete("search");
                if (params.sortKey) {
                    url.searchParams.set("sortKey", String(params.sortKey));
                    url.searchParams.set("sortDirection", String(params.sortDirection));
                } else {
                    url.searchParams.delete("sortKey");
                    url.searchParams.delete("sortDirection");
                }
                const filterKeys = new Set<string>();
                for (const filter of props.filters ?? []) {
                    filterKeys.add(filter.query ?? filter.key);
                    if (filter.type === "number-range") {
                        filterKeys.add(filter.queryMin ?? `${filter.key}Min`);
                        filterKeys.add(filter.queryMax ?? `${filter.key}Max`);
                    }
                    if (filter.type === "date") {
                        filterKeys.add(filter.queryFrom ?? "from");
                        filterKeys.add(filter.queryTo ?? "to");
                    }
                }
                for (const key of filterKeys) {
                    if (params[key] === undefined || params[key] === null || params[key] === "") url.searchParams.delete(key);
                    else url.searchParams.set(key, String(params[key]));
                }
                window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
            } catch {
                /* URL sync is best-effort */
            }
        };

        const modernFetch = async () => {
            const { signal, mine } = beginRequest();
            try {
                const params = modernParams();
                let payload: any;
                if (typeof props.fetcher === "function") {
                    payload = await props.fetcher(params, signal);
                } else {
                    if (!config.api) throw new Error("No API client configured for PgApiTable");
                    const result = await config.api.get(props.endpoint as string, {
                        params,
                        headers: props.apiHeaders,
                        signal,
                    });
                    payload = result?.data;
                }
                if (mine !== sequence) return;
                rawData.value = payload as RawData;
                const envelope = envelopeOf<T>(payload);
                rows.value = props.apiDataExtractor ? props.apiDataExtractor(payload as RawData) : envelope.items;
                total.value = props.apiTotalExtractor ? props.apiTotalExtractor(payload as RawData) : envelope.total;
                hasLoaded.value = true;
                syncUrl(params);
                props.onData?.(rows.value, total.value);
                emit?.("loaded", { rows: rows.value, total: total.value, raw: payload });
            } catch (error) {
                failRequest(mine, error, signal);
            } finally {
                finishRequest(mine);
            }
        };

        const fetchNow = () => {
            if (!isModern) return;
            void modernFetch();
        };
        const goToFirstPage = () => {
            page.value = 1;
            skip.value = 0;
            if (isModern) {
                abortCurrent();
                fetchNow();
            } else {
                reset();
            }
        };
        const refresh = async () => {
            if (isModern) await modernFetch();
            else refreshAsIs();
        };
        const resetFilters = () => {
            filterValues.value = {};
            searchDisplay.value = "";
            searchTerm.value = "";
            internalSearch.value = null;
            props.onFilterClear?.();
            props.setSearchValue?.(null);
            goToFirstPage();
        };

        const onSearch = (value?: string) => {
            if (isModern) {
                const next = String(value ?? searchDisplay.value ?? "");
                if (next === searchTerm.value) return;
                searchTerm.value = next;
                return;
            }
            reset();
        };

        const setSearchValue = (value: string | null) => {
            searchDisplay.value = value ?? "";
            if (props.setSearchValue) props.setSearchValue(value);
            else internalSearch.value = value;
        };

        const onFilterChange = (key: string, value: unknown) => {
            filterValues.value = { ...filterValues.value, [key]: value };
            props.onFilterChange?.(key, value);
            goToFirstPage();
        };
        const onFilterClear = () => {
            resetFilters();
        };

        const onSort = (key: string, direction: "asc" | "desc") => {
            sortBy.value = key;
            sortDirection.value = direction;
            goToFirstPage();
        };
        const onClearSort = () => {
            sortBy.value = null;
            sortDirection.value = "asc";
            goToFirstPage();
        };

        const goToPage = (target: number) => {
            if (target < 1 || target > numberOfPages.value || target === currentPage.value) return;
            page.value = target;
            skip.value = (target - 1) * pageSize.value;
            if (isModern) {
                abortCurrent();
                fetchNow();
                return;
            }
            props.onRefresh?.(
                { page: target, skip: skip.value, sortKey: sortBy.value, sortDirection: sortDirection.value },
                (async (next: any) => {
                    await legacyRefresh({ ...next, nextSkip: skip.value });
                }) satisfies RefreshMethodApiWithoutSkip,
            );
        };
        const goNext = () => goToPage(currentPage.value + 1);
        const goPrev = () => goToPage(currentPage.value - 1);

        const setPageSize = (value: number) => {
            const next = Number(value);
            if (!Number.isFinite(next) || next <= 0 || next === pageSize.value) return;
            pageSize.value = next;
            props.setNumberOfItemsPerPage?.(next);
            if (!isModern) return;
            page.value = 1;
            skip.value = 0;
            abortCurrent();
            fetchNow();
        };

        const toggleColumn = (key: string) => {
            const column = headersList.value.find((header) => header.key === key);
            if (!column || key === "actions" || key === "__no") return;
            const isHidden = Boolean(hidden.value[key]);
            if (!isHidden && visibleHeaders.value.length <= 1) return;
            const next = { ...hidden.value };
            if (isHidden) delete next[key];
            else next[key] = true;
            hidden.value = next;
        };

        const { downloadingXlsx, downloadXlsx } = useTableXlsx({
            headers: () => visibleHeaders.value,
            data: () => rows.value,
            title: () => title.value,
            filename: () => props.exportFilename,
        });

        const refreshHook = {
            reset: () => goToFirstPage(),
            refresh: ((next: any) => {
                if (isModern) return modernFetch();
                const requested = Number(next?.nextSkip);
                return legacyRefresh({
                    ...next,
                    nextSkip: Number.isFinite(requested) ? requested : skip.value,
                });
            }) as RefreshMethodWithNextSkip,
            refreshAsIs: () => void refresh(),
        };

        onMounted(() => {
            props.setRefreshHook?.(refreshHook);
            if (isModern) fetchNow();
            // Legacy pages pass `onRefresh` and expect the first page to load
            // on mount (the old table did this).
            else refreshAsIs();
        });
        onUnmounted(() => {
            abortCurrent();
            props.clearRefreshHook?.(refreshHook);
        });

        watch(
            () => props.searchValue,
            (next) => {
                if (next === undefined || next === null) return;
                searchDisplay.value = String(next);
            },
        );

        if (!isModern) {
            watch(
                [() => props.numberOfItemsPerPage, () => props.url],
                () => {
                    const next = Number(props.numberOfItemsPerPage);
                    if (Number.isFinite(next) && next > 0) pageSize.value = next;
                    reset();
                },
                { immediate: true },
            );
            watch(() => effectiveSearch.value, () => reset());
        } else {
            watch(
                () => props.numberOfItemsPerPage,
                (next) => {
                    const value = Number(next);
                    if (!Number.isFinite(value) || value <= 0 || value === pageSize.value) return;
                    pageSize.value = value;
                    page.value = 1;
                    skip.value = 0;
                    fetchNow();
                },
            );
            watch(
                () => props.defaultPageSize,
                (next) => {
                    const value = Number(next);
                    if (!Number.isFinite(value) || value <= 0 || value === pageSize.value) return;
                    pageSize.value = value;
                    page.value = 1;
                    skip.value = 0;
                    fetchNow();
                },
            );
            watch(
                () => props.filterValues,
                (next) => {
                    filterValues.value = { ...(next ?? {}) };
                    page.value = 1;
                    skip.value = 0;
                    fetchNow();
                },
                { deep: true },
            );
            watch(
                () => props.endpoint,
                () => goToFirstPage(),
            );
            watch(
                () => props.searchValue,
                (next) => {
                    if (next === undefined || next === null) return;
                    searchDisplay.value = String(next);
                    if (String(next) === searchTerm.value) return;
                    searchTerm.value = String(next);
                },
            );
            watch(searchTerm, () => {
                page.value = 1;
                skip.value = 0;
                abortCurrent();
                fetchNow();
            });
        }

        expose?.({
            refresh,
            resetFilters,
            reset: goToFirstPage,
            downloadXlsx,
            setPage: goToPage,
        });

        return () => {
            return (
                <PgCard noPadding class={["pg-table-card pg-unified-table", props.noElevation ? "pg-table-card--flat" : ""].filter(Boolean).join(" ")}>
                    <PgTableHeader
                        loading={loading.value}
                        onSearch={onSearch}
                        onRefresh={() => void refresh()}
                        total={total.value}
                        filterControl={
                            (props.filters?.length ?? 0) > 0 || filterSurface.hasFilters.value
                                ? {
                                      count: filterSurface.activeCount.value,
                                      open: filterSurface.open.value,
                                      toggle: filterSurface.toggle,
                                  }
                                : undefined
                        }
                        xlsx={
                            (props.xlsx ?? true)
                                ? {
                                      disabled: !rows.value.length || downloadingXlsx.value,
                                      handler: downloadXlsx,
                                      loading: downloadingXlsx.value,
                                  }
                                : undefined
                        }
                        searchValue={searchDisplay.value}
                        setSearchValue={setSearchValue}
                        title={title.value}
                        refresh={refreshHook.refresh}
                        Icon={props.Icon}
                        iconName={props.iconName}
                        columns={columnChoices.value}
                        onToggleColumn={toggleColumn}
                    />
                    {props.TopSlot ? (
                        <div id={(props.filters?.length ?? 0) > 0 ? undefined : "pg-table-filters"}>
                            {props.TopSlot({ reset: goToFirstPage, refresh: refreshHook.refresh, refreshAsIs: refreshHook.refreshAsIs })}
                        </div>
                    ) : null}
                    {(props.filters?.length ?? 0) > 0 ? (
                        <div id={(props.filters?.length ?? 0) > 0 ? undefined : "pg-table-filters"}>
                            <PgTableFilters
                                filters={props.filters ?? []}
                                values={filterValues.value}
                                total={props.filterTotal}
                                onChange={onFilterChange}
                                onClear={onFilterClear}
                            />
                        </div>
                    ) : null}
                    {branch(
                        () => loading.value,
                        () => (
                            <PgProgressBar
                                indeterminate
                                height={3}
                                class="pg-table-refetch"
                                aria-label={t("Loading")}
                            />
                        ),
                    )}
                    {branch(
                        () => Boolean(errorMessage.value && !rows.value.length),
                        () => <PgStateView error={errorMessage.value ?? ""} onRetry={() => void refresh()} retryLabel={t("Retry")} />,
                    )}
                    {branch(
                        () => Boolean(errorMessage.value && rows.value.length),
                        () => (
                            <div class="pg-table-banner pg-table-banner--error" role="alert">
                                <span class="pg-text">{errorMessage.value}</span>
                                <PgButton size="sm" variant="outlined" onClick={() => void refresh()}>
                                    {t("Retry")}
                                </PgButton>
                            </div>
                        ),
                    )}
                    <div class={errorMessage.value && !rows.value.length ? "pg-table-body--hidden" : ""}>
                        <PgTable
                            headers={visibleHeaders.value}
                            data={rows.value}
                            loading={loading.value && !hasLoaded.value}
                            skeletonRows={props.skeletonRows}
                            sortBy={sortBy.value}
                            sortDirection={sortDirection.value}
                            onSetSort={onSort}
                            onClearSort={onClearSort}
                            skip={skip.value}
                            pageNumber={currentPage.value}
                            reset={refreshHook.reset}
                            refreshAsIs={refreshHook.refreshAsIs}
                            refresh={legacyRefresh}
                            rowColor={props.rowColor}
                            rowTone={props.rowTone}
                            rowKey={props.rowKey}
                            Row={props.Row}
                            onRowClick={(row: T, index: number) => {
                                props.onRowClick?.(row, index);
                                emit?.("rowClick", row, index);
                            }}
                            selectable={props.selectable}
                            selectedKeys={props.selectedKeys}
                            onSelectionChange={(keys: Array<string | number>, nextRows: T[]) => {
                                props.onSelectionChange?.(keys, nextRows);
                                emit?.("selectionChange", nextRows);
                            }}
                            density={props.density}
                            tableContainerStyle={props.tableContainerStyle}
                            title={typeof props.title === "string" ? props.title : undefined}
                            emptyTitle={
                                props.emptyTitle ??
                                (filtered.value ? t("No matching records") : t("No Data Found"))
                            }
                            emptyDescription={
                                props.emptyDescription ??
                                (filtered.value
                                    ? t("Try a different search or clear the filters.")
                                    : t("There are no items to display"))
                            }
                            emptyActionLabel={filtered.value ? t("Reset all filters") : ""}
                            onEmptyAction={filtered.value ? resetFilters : undefined}
                        />
                    </div>
                    <PgTableFooter
                        page={currentPage.value}
                        pageSize={pageSize.value}
                        total={total.value}
                        numberOfPages={numberOfPages.value}
                        pageSizeOptions={props.pageSizeOptions}
                        numberOfItemsPerPageChoices={props.numberOfItemsPerPageChoices}
                        setNumberOfItemsPerPage={setPageSize}
                        goToPage={goToPage}
                        hasPrev={currentPage.value > 1}
                        hasNext={currentPage.value < numberOfPages.value}
                        loading={loading.value}
                        next={goNext}
                        prev={goPrev}
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
            "rowTone",
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
            "endpoint",
            "fetcher",
            "params",
            "defaultSort",
            "defaultPageSize",
            "syncUrl",
            "exportFilename",
            "pageSizeOptions",
            "emptyTitle",
            "emptyDescription",
            "hiddenColumns",
            "onRowClick",
            "rowKey",
            "selectable",
            "selectedKeys",
            "onSelectionChange",
            "density",
            "skeletonRows",
        ] as any[],
        emits: ["loaded", "error", "rowClick", "selectionChange"],
        inheritAttrs: true,
    },
);

export default PgApiTable;
