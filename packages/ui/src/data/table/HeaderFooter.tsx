import { createIf } from "@vue/runtime-vapor";
import { computed, inject, ref } from "vue";

import { defineComponent } from "../../lib/dc";

/** Vapor JSX returns a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { useLocale } from "../../lib/locale";
import { useDisplay } from "../../lib/display";
import { usePgUiConfig } from "../../lib/config";
import { formatMoney, formatPlainNumber } from "../../lib/money";
import { formatDisplayDate } from "../../lib/date";
import { PgButton } from "../../actions/PgButton";
import { PgIcon } from "../../actions/PgIcon";
import { PgMenu } from "../../overlays/PgMenu";
import { PgTooltip } from "../../overlays/PgTooltip";
import { PgSearchInput } from "../../inputs/PgSearchInput";
import { PgAutocomplete } from "../../inputs/PgAutocomplete";
import { showToast } from "../../feedback/toastStore";
import { tableFilterSurfaceKey } from "./TableFilters";
import { readCell, type IconProps, type RefreshMethodWithNextSkip, type TableHeader as TableHeaderType } from "./types";

/* ------------------------------------------------------------------- XLSX */

const MONEY_COLUMN = /(amount|fee|balance|total|volume|price|value|commission|net|gross|debit|credit|revenue|cost|charge|limit|ceiling)/i;
const DATE_COLUMN = /(date|time)$/i;

const isMoneyColumn = (header: TableHeaderType<any>): boolean =>
    header.format === "money" ||
    header.money === true ||
    MONEY_COLUMN.test(header.key) ||
    (typeof header.label === "string" && MONEY_COLUMN.test(header.label));

const isDateColumn = (header: TableHeaderType<any>): boolean =>
    header.format === "date" ||
    DATE_COLUMN.test(header.key) ||
    /At$/.test(header.key) ||
    (typeof header.label === "string" && /(date|time)/i.test(header.label));

const pad = (value: number) => String(value).padStart(2, "0");

const dateCellText = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "";
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return "";
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
    }
    const text = String(value).trim();
    if (!text) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return formatDisplayDate(text) || text;
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
        // Keep the server's UTC wall clock; never shift a filing timestamp.
        return text.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, " UTC");
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text : dateCellText(parsed);
};

const plainCellText = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (value instanceof Date) return dateCellText(value);
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "";
        }
    }
    return String(value);
};

export type UseTableXlsxOptions = {
    headers: () => TableHeaderType<any>[];
    data: () => any[];
    title: () => string;
    /** Optional file name; falls back to the table title. */
    filename?: () => string | undefined;
    /** Default currency for money columns that do not declare one. */
    currency?: () => string | undefined;
};

/**
 * Shared XLSX export. Every exported cell is a formatted string: money goes
 * through `formatMoney`, dates through the display formatter and nested objects
 * are JSON-stringified, so a workbook never contains `[object Object]`.
 */
export const useTableXlsx = (options: UseTableXlsxOptions) => {
    const config = usePgUiConfig();
    const { t } = useLocale();
    const downloadingXlsx = ref(false);

    const cellText = (header: TableHeaderType<any>, row: any, index: number): string => {
        const raw =
            header.value !== undefined
                ? readCell(header.value as any, row, index)
                : row === null || row === undefined
                  ? ""
                  : row?.[header.key];
        if (raw === null || raw === undefined || raw === "") return "";
        if (isDateColumn(header)) return dateCellText(raw);
        if (isMoneyColumn(header)) {
            const currency = header.currency ?? options.currency?.() ?? config.currency;
            return formatMoney(raw as any, { currency });
        }
        return plainCellText(raw);
    };

    const exportHeaders = (): TableHeaderType<any>[] =>
        (options.headers() ?? [])
            .filter((header) => header && header.key !== "actions")
            .map((header) => ({
                ...header,
                value: (row: any, index: number) => cellText(header, row, index),
            }));

    const downloadXlsx = async () => {
        const rows = options.data() ?? [];
        if (downloadingXlsx.value || rows.length === 0) return;
        if (!config.exportXlsx) {
            showToast({ tone: "warning", message: t("Export is not configured") });
            return;
        }
        downloadingXlsx.value = true;
        try {
            const filename = options.filename?.();
            await config.exportXlsx({
                headers: exportHeaders(),
                data: rows,
                title: filename ?? options.title(),
                ...(filename ? { filename } : {}),
            } as any);
            showToast({
                tone: "success",
                message: `${t("Exported")} ${rows.length} ${t("rows")}`,
            });
        } catch (error) {
            console.error(error);
            showToast({ tone: "danger", message: t("Could not export the table") });
        } finally {
            downloadingXlsx.value = false;
        }
    };

    return { downloadingXlsx, downloadXlsx };
};

/* ---------------------------------------------------------------- controls */

export type TableFilterControl = {
    count: number;
    open: boolean;
    toggle: () => void;
};

export type TableColumnChoice = {
    key: string;
    label: string;
    visible: boolean;
    hideable?: boolean;
};

export type TableHeaderProps = {
    refresh?: RefreshMethodWithNextSkip;
    setSearchValue?: (text: string | null) => void;
    searchValue?: string | null;
    onSearch?: (value?: string) => Promise<void> | void;
    onRefresh?: () => void | Promise<void>;
    iconName?: string;
    Icon?: (iconProps: Omit<IconProps, "icon">) => any;
    xlsx?: {
        handler: () => void | Promise<void>;
        disabled: boolean;
        loading: boolean;
    };
    title?: string;
    loading?: boolean;
    total?: number;
    filterControl?: TableFilterControl;
    searchable?: boolean;
    showSearch?: boolean;
    exportable?: boolean;
    exporting?: boolean;
    onExport?: () => void | Promise<void>;
    columns?: TableColumnChoice[];
    onToggleColumn?: (key: string) => void;
};

const searchEnabled = (props: TableHeaderProps): boolean =>
    props.searchable !== false &&
    props.showSearch !== false &&
    typeof props.onSearch === "function" &&
    typeof props.setSearchValue === "function";

const exportControl = (props: TableHeaderProps) => {
    if (props.xlsx) return props.xlsx;
    if (typeof props.onExport === "function") {
        return { handler: props.onExport, disabled: false, loading: Boolean(props.exporting) };
    }
    return undefined;
};

export const TableHeader = defineComponent<TableHeaderProps>(
    (props, { slots }) => {
        const { t } = useLocale();
        const display = useDisplay();
        const mobile = computed(() => display.mobile.value);
        // The nearest PgApiTable owns the filter surface; reading its refs inside
        // the render expression keeps the count badge and aria-expanded live.
        const surface = inject(tableFilterSurfaceKey, null);

        const filtersCount = (): number => surface?.activeCount.value ?? props.filterControl?.count ?? 0;
        const filtersOpen = (): boolean => surface?.open.value ?? props.filterControl?.open ?? false;
        const toggleFilters = () => {
            if (surface) surface.toggle();
            else props.filterControl?.toggle();
        };

        const refreshNow = () => {
            if (props.loading) return;
            if (props.onRefresh) {
                void props.onRefresh();
                return;
            }
            if (props.refresh) void props.refresh({ nextSkip: 0 });
        };

        return () => {
            const exporter = exportControl(props);
            return (
                <div class={["pg-table-toolbar", mobile.value ? "pg-table-toolbar--mobile" : ""]}>
                    {slots.prepend?.()}
                    <div class="pg-table-toolbar__left">
                        {props.Icon ? (
                            <span class="pg-table-toolbar__icon">{props.Icon({})}</span>
                        ) : props.iconName ? (
                            <PgIcon icon={props.iconName} size={18} />
                        ) : null}
                        {props.title && <span class="pg-sr-only">{t(props.title)}</span>}
                        {searchEnabled(props) ? (
                            <PgSearchInput
                                class="pg-table-search"
                                modelValue={String(props.searchValue ?? "")}
                                placeholder={t("Search")}
                                ariaLabel={t("Search")}
                                debounce={250}
                                onUpdate:modelValue={(value: string) => props.setSearchValue?.(value)}
                                onSearch={(value: string) => props.onSearch?.(value)}
                            />
                        ) : (
                            props.title && <span class="pg-table-toolbar__title">{t(props.title)}</span>
                        )}
                        {branch(
                            () => Boolean(props.filterControl),
                            () => (
                                <PgButton
                                    size="small"
                                    variant="outlined"
                                    prependIcon="mdi-filter-variant"
                                    class={["pg-filter-trigger", filtersCount() > 0 ? "pg-filter-trigger--active" : ""]
                                        .filter(Boolean)
                                        .join(" ")}
                                    aria-expanded={filtersOpen() ? "true" : "false"}
                                    aria-controls="pg-table-filters"
                                    onClick={toggleFilters}
                                >
                                    {t("Filters")}
                                    {branch(() => filtersCount() > 0, () => (
                                        <span class="pg-filter-trigger__badge pg-tabular">{filtersCount()}</span>
                                    ))}
                                </PgButton>
                            ),
                        )}
                    </div>
                    <div class="pg-table-toolbar__right">
                        <span class="pg-record-count pg-tabular">
                            {typeof props.total === "number" ? `${formatPlainNumber(props.total)} ${t("records")}` : ""}
                        </span>
                        <PgTooltip text={t("Refresh")}>
                            <PgButton
                                size="sm"
                                variant="text"
                                ariaLabel={t("Refresh")}
                                loading={Boolean(props.loading)}
                                disabled={Boolean(props.loading)}
                                onClick={refreshNow}
                                icon="mdi-refresh"
                            />
                        </PgTooltip>
                        {props.columns && props.columns.length > 0 && (
                            <PgMenu>
                                {{
                                    activator: () => (
                                        <PgButton
                                            size="sm"
                                            variant="text"
                                            ariaLabel={t("Columns")}
                                            icon="mdi-view-column-outline"
                                        />
                                    ),
                                    default: () => (
                                        <div class="pg-menu-list pg-column-picker" role="group" aria-label={t("Columns")}>
                                            {props.columns!.map((column) => (
                                                <button
                                                    key={column.key}
                                                    type="button"
                                                    role="menuitemcheckbox"
                                                    aria-checked={column.visible ? "true" : "false"}
                                                    class="pg-menu-item pg-column-picker__item"
                                                    disabled={column.hideable === false}
                                                    onClick={() => props.onToggleColumn?.(column.key)}
                                                >
                                                    <PgIcon
                                                        icon={column.visible ? "mdi-checkbox-marked-outline" : "mdi-checkbox-blank-outline"}
                                                        size={16}
                                                    />
                                                    <span>{t(column.label)}</span>
                                                </button>
                                            ))}
                                        </div>
                                    ),
                                }}
                            </PgMenu>
                        )}
                        {exporter && (
                            <PgTooltip text={t("Download Current Data as Excel Sheet")}>
                                <PgButton
                                    size="sm"
                                    variant="text"
                                    ariaLabel={t("Download Current Data as Excel Sheet")}
                                    disabled={Boolean(props.xlsx?.disabled ?? props.exporting)}
                                    loading={Boolean(props.xlsx?.loading ?? props.exporting)}
                                    onClick={() => void exportControl(props)?.handler()}
                                    icon="mdi-file-excel-outline"
                                />
                            </PgTooltip>
                        )}
                        {slots.actions?.()}
                    </div>
                </div>
            );
        };
    },
    {
        props: [
            "refresh",
            "setSearchValue",
            "searchValue",
            "onSearch",
            "onRefresh",
            "iconName",
            "Icon",
            "xlsx",
            "title",
            "loading",
            "total",
            "filterControl",
            "searchable",
            "showSearch",
            "exportable",
            "exporting",
            "onExport",
            "columns",
            "onToggleColumn",
        ] as any[],
        slots: ["actions", "prepend"],
    },
);

/* ----------------------------------------------------------------- footer */

export type TableFooterProps = {
    page?: number;
    currentPage?: number;
    pageSize?: number;
    numberOfItemsPerPage?: number;
    total?: number;
    totalDataLength?: number;
    numberOfPages?: number;
    pageSizeOptions?: number[];
    numberOfItemsPerPageChoices?: false | { label: string; value: number }[];
    setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
    goToPage?: (targetPageNumber: number) => void;
    next?: () => void;
    prev?: () => void;
    hasNext?: boolean;
    hasPrev?: boolean;
    loading?: boolean;
};

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100];

export const TableFooter = defineComponent<TableFooterProps>(
    (props, { emit }) => {
        const { t, isRtl } = useLocale();
        const display = useDisplay();
        const mobile = computed(() => display.mobile.value);

        const page = computed(() => {
            const value = Number(props.page ?? props.currentPage ?? 1);
            return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
        });
        const size = computed(() => {
            const value = Number(props.pageSize ?? props.numberOfItemsPerPage ?? 25);
            return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
        });
        const total = computed(() => {
            const value = Number(props.total ?? props.totalDataLength ?? 0);
            return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        });
        const pages = computed(() => {
            const explicit = Number(props.numberOfPages);
            if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
            return Math.max(1, Math.ceil(total.value / Math.max(1, size.value)));
        });
        const start = computed(() => (total.value === 0 ? 0 : (page.value - 1) * size.value + 1));
        const end = computed(() => Math.min(total.value, page.value * size.value));

        const rangeLabel = computed(() =>
            total.value === 0
                ? t("0 results")
                : `${t("Showing")} ${formatPlainNumber(start.value)}–${formatPlainNumber(end.value)} ${t("of")} ${formatPlainNumber(total.value)}`,
        );

        const hasPrev = () => (typeof props.hasPrev === "boolean" ? props.hasPrev : page.value > 1);
        const hasNext = () => (typeof props.hasNext === "boolean" ? props.hasNext : page.value < pages.value);

        const goto = (target: number) => {
            if (props.loading) return;
            if (!Number.isFinite(target) || target < 1 || target > pages.value || target === page.value) return;
            props.goToPage?.(target);
            emit?.("update:page", target);
        };
        const goPrev = () => {
            if (!hasPrev() || props.loading) return;
            if (props.prev) {
                props.prev();
                return;
            }
            goto(page.value - 1);
        };
        const goNext = () => {
            if (!hasNext() || props.loading) return;
            if (props.next) {
                props.next();
                return;
            }
            goto(page.value + 1);
        };

        const pageList = computed<Array<number | "gap">>(() => {
            const last = pages.value;
            const current = Math.min(Math.max(1, page.value), last);
            if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1);
            const list: Array<number | "gap"> = [1];
            const from = Math.max(2, current - 1);
            const to = Math.min(last - 1, current + 1);
            if (from > 2) list.push("gap");
            for (let number = from; number <= to; number += 1) list.push(number);
            if (to < last - 1) list.push("gap");
            list.push(last);
            return list;
        });

        const sizeChoices = computed(() => {
            if (Array.isArray(props.numberOfItemsPerPageChoices) && props.numberOfItemsPerPageChoices.length > 0) {
                return props.numberOfItemsPerPageChoices;
            }
            return (props.pageSizeOptions && props.pageSizeOptions.length > 0 ? props.pageSizeOptions : DEFAULT_PAGE_SIZES).map(
                (value) => ({ label: String(value), value }),
            );
        });

        const setSize = (value: unknown) => {
            const next = Number(value);
            if (!Number.isFinite(next) || next <= 0 || next === size.value) return;
            props.setNumberOfItemsPerPage?.(next);
            emit?.("update:pageSize", next);
        };

        return () => (
            <div class={["pg-table-footer", mobile.value ? "pg-table-footer--mobile" : ""]}>
                <div class="pg-table-footer__range pg-tabular" role="status" aria-live="polite">
                    {rangeLabel.value}
                </div>
                <div class="pg-table-footer__controls">
                    <nav class="pg-pagination" role="navigation" aria-label={t("Pagination")}>
                        <button
                            type="button"
                            class="pg-pagination-button"
                            aria-label={t("Previous page")}
                            aria-disabled={!hasPrev() || Boolean(props.loading) ? "true" : undefined}
                            disabled={!hasPrev() || Boolean(props.loading)}
                            onClick={goPrev}
                        >
                            <PgIcon icon={isRtl.value ? "mdi-chevron-right" : "mdi-chevron-left"} size={18} />
                        </button>
                        <div class="pg-page-numbers">
                            {pageList.value.map((entry, index) =>
                                entry === "gap" ? (
                                    <span key={`gap-${index}`} class="pg-page-ellipsis" aria-hidden="true">
                                        …
                                    </span>
                                ) : (
                                    <button
                                        key={`page-${entry}`}
                                        type="button"
                                        class={["pg-page-number", entry === page.value ? "pg-page-number--active" : ""]
                                            .filter(Boolean)
                                            .join(" ")}
                                        aria-label={`${t("Page")} ${entry}`}
                                        aria-current={entry === page.value ? "page" : undefined}
                                        disabled={Boolean(props.loading)}
                                        onClick={() => goto(entry)}
                                    >
                                        {entry}
                                    </button>
                                ),
                            )}
                        </div>
                        <button
                            type="button"
                            class="pg-pagination-button"
                            aria-label={t("Next page")}
                            aria-disabled={!hasNext() || Boolean(props.loading) ? "true" : undefined}
                            disabled={!hasNext() || Boolean(props.loading)}
                            onClick={goNext}
                        >
                            <PgIcon icon={isRtl.value ? "mdi-chevron-left" : "mdi-chevron-right"} size={18} />
                        </button>
                    </nav>
                    {total.value > 0 && (
                        <div class="pg-page-size">
                            <span class="pg-sr-only">{t("Rows per page")}</span>
                            <PgAutocomplete
                                aria-label={t("Rows per page")}
                                items={sizeChoices.value}
                                itemTitle="label"
                                itemValue="value"
                                modelValue={size.value}
                                onUpdate:modelValue={(value: number) => setSize(value)}
                                searchable={false}
                                clearable={false}
                                size="sm"
                                density="compact"
                                hideDetails
                            />
                        </div>
                    )}
                </div>
            </div>
        );
    },
    {
        props: [
            "page",
            "currentPage",
            "pageSize",
            "numberOfItemsPerPage",
            "total",
            "totalDataLength",
            "numberOfPages",
            "pageSizeOptions",
            "numberOfItemsPerPageChoices",
            "setNumberOfItemsPerPage",
            "goToPage",
            "next",
            "prev",
            "hasNext",
            "hasPrev",
            "loading",
        ] as any[],
        emits: ["update:page", "update:pageSize"],
        rerender: true,
    },
);

export const PgTableHeader = TableHeader;
export const PgTableFooter = TableFooter;
