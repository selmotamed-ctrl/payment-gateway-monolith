import type { StyleValue } from "vue";

import { compareMoney, isMoneyInput } from "../../lib/money";

type JsonValue = any;
type AxiosRequestConfig = any;
type RulesList = Array<(value: any) => any>;

/** Default rows-per-page choices used by every table footer. */
export const defaultNumberOfItemsPerPageChoices: {
    label: string;
    value: number;
}[] = [
    { label: "10", value: 10 },
    { label: "25", value: 25 },
    { label: "50", value: 50 },
    { label: "100", value: 100 },
];

export const defaultNumberOfItemsPerPageChoicesWithAll: {
    label: string;
    value: number;
}[] = [...defaultNumberOfItemsPerPageChoices, { label: "All", value: -1 }];

export type IconProps = {
    onClick?: () => void | Promise<void>;
    color?: string;
    icon?: string;
    size?: string | number;
};

export type RefreshMethodApiWithoutSkip = (refreshProps: { queryParams?: any }) => Promise<void>;

export type RefreshMethodData = (refreshProps: { nextSkip: number }) => Promise<void>;

export type RefreshMethodWithNextSkip = (refreshProps: { queryParams?: any; nextSkip: number }) => Promise<void>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const resolvePath = (path: unknown, row: unknown): unknown => {
    if (Array.isArray(path)) {
        return path.reduce<unknown>((value, key) => (value == null ? value : (value as Record<string, unknown>)[key as string]), row);
    }
    if (typeof path !== "string") return undefined;
    if (!path.includes(".")) return row == null ? undefined : (row as Record<string, unknown>)[path];
    return path
        .split(".")
        .reduce<unknown>((value, key) => (value == null ? value : (value as Record<string, unknown>)[key]), row);
};

const cellText = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    if (Array.isArray(value)) {
        return value.map(cellText).filter(Boolean).join(", ");
    }
    if (isPlainObject(value)) {
        try {
            return JSON.stringify(value);
        } catch {
            return "";
        }
    }
    return String(value);
};

/**
 * Reads a cell through a selector, a column key, or a dot path
 * (`"merchant.legalName"`). A missing intermediate object returns `""` — it
 * never throws and never renders `[object Object]`.
 */
export function readCell<T>(selector: ((row: T, index: number) => string) | string | string[], row: T, index: number): string {
    try {
        if (typeof selector === "function") {
            return cellText(selector(row, index));
        }
        return cellText(resolvePath(selector, row));
    } catch {
        return "";
    }
}

const MONEY_KEY = /(amount|fee|balance|total|volume|price|value|commission|net|gross|debit|credit|revenue|cost|charge|limit|ceiling|salary)/i;
const DATE_KEY = /(date|time)$/i;
const DATE_LABEL = /(date|time)/i;

export type TableHeaderFormat = "text" | "money" | "date" | "number";

const isMoneyHeader = <T,>(header: TableHeader<T>): boolean =>
    header.format === "money" ||
    header.money === true ||
    MONEY_KEY.test(header.key) ||
    (typeof header.label === "string" && MONEY_KEY.test(header.label));

const isDateHeader = <T,>(header: TableHeader<T>): boolean =>
    header.format === "date" ||
    DATE_KEY.test(header.key) ||
    /At$/.test(header.key) ||
    (typeof header.label === "string" && DATE_LABEL.test(header.label));

const rawCellValue = <T,>(header: TableHeader<T>, row: T): unknown => {
    if (header.value !== undefined) {
        if (typeof header.value === "function") {
            try {
                return header.value(row, 0);
            } catch {
                return undefined;
            }
        }
        return resolvePath(header.value, row);
    }
    return row == null ? undefined : (row as Record<string, unknown>)[header.key];
};

const dateValue = (value: unknown): number | null => {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isNaN(time) ? null : time;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
};

/**
 * Sorts rows by the header the user clicked.
 *
 * Money columns delegate to `compareMoney()` so `90.000` sorts before
 * `100.000`; date columns compare timestamps; other values compare naturally
 * (numeric strings numerically, text case-insensitively). Nullish values sort
 * first in ascending order.
 */
export function sortRowsByHeader<T>(
    rows: T[],
    headers: TableHeader<T>[],
    sortBy: string | null,
    sortDirection: "asc" | "desc",
): T[] {
    if (!sortBy) return rows;
    const header = (headers ?? []).find((candidate) => (candidate.sortKey ?? candidate.key) === sortBy);
    if (!header) return rows;

    const direction = sortDirection === "asc" ? 1 : -1;
    const money = isMoneyHeader(header);
    const dates = isDateHeader(header);

    return [...rows].sort((left, right) => {
        const a = rawCellValue(header, left);
        const b = rawCellValue(header, right);
        const aBlank = a === null || a === undefined || a === "";
        const bBlank = b === null || b === undefined || b === "";
        if (aBlank && bBlank) return 0;
        if (aBlank) return -1 * direction;
        if (bBlank) return direction;

        if (money && isMoneyInput(a as any) && isMoneyInput(b as any)) {
            return compareMoney(a as any, b as any) * direction;
        }
        if (dates) {
            const at = dateValue(a);
            const bt = dateValue(b);
            if (at !== null && bt !== null) return (at - bt) * direction;
            if (at !== null) return -1 * direction;
            if (bt !== null) return direction;
        }

        const as = cellText(a).trim();
        const bs = cellText(b).trim();
        const an = Number(as);
        const bn = Number(bs);
        if (as !== "" && bs !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) {
            return (an - bn) * direction;
        }
        return as.localeCompare(bs, undefined, { numeric: true, sensitivity: "base" }) * direction;
    });
}

export type TableHeaderAction<T> = {
    if?: (row: T) => boolean;
    action: (
        row: T,
        props: {
            refreshAsIs: () => void;
            reset: () => void;
            refresh: RefreshMethodWithNextSkip;
        },
    ) => void | Promise<void>;
    iconName?: ((row: T) => string) | string;
    label?: ((row: T) => string) | string;
    backgroundColor?: ((row: T) => string) | string;
    textColor?: string;
    href?: (row: T) => string;
    Tooltip?: (props: { row: T }) => any | null;
    tooltip?: (props: { row: T }) => string | null;
    disabled?: (row: T) => boolean;
};

export type TableHeader<T> = {
    startSeparator?: boolean;
    endSeparator?: boolean;
    Header?: () => any;
    label?: string;
    CellTooltip?: () => any;
    cellToolTip?: {
        text: (row: T) => string;
        onClick?: (row: T) => void;
    };
    headerIcon?: string;
    /** Plain-language help shown from an info icon beside the header label. */
    headerTooltip?: string;
    HeaderIcon?: (iconProps: Omit<IconProps, "name">) => any;
    headerTextStyle?: StyleValue;
    rowTextStyle?: StyleValue;
    headerCellStyle?: StyleValue;
    rowCellStyle?: StyleValue;
    key: string;
    minWidth?: boolean;
    actions?: TableHeaderAction<T>[];
    menu?: boolean;
    value?: ((row: T, index: number) => string) | string | string[];
    Value?: (props: { row: T }) => any;
    sortable?: boolean;
    sortKey?: string;
    /** Export/sort hint. Money delegates to decimal comparison. */
    format?: TableHeaderFormat;
    /** Explicit money flag (also inferred from the key/label). */
    money?: boolean;
    /** ISO-4217 code used by the XLSX exporter for this column. */
    currency?: string;
    /** Column filters are derived from the values unless configured here. */
    filterable?: boolean;
    filterType?: "text" | "select" | "boolean";
    filterOptions?: { title: string; value: string }[];
    onHeaderPress?: () => void | Promise<void>;
    onCellPress?: (
        row: T,
        props: {
            refresh: RefreshMethodData | RefreshMethodWithNextSkip;
            reset: () => Promise<void> | void;
            refreshAsIs: () => Promise<void> | void;
        },
    ) => void | Promise<void>;
} & (
    | {
          cellEditEnabled?: undefined | false;
      }
    | {
          cellEditEnabled: true;
          cellIconName: string;
          cellIconOnClick: (props: { row: T; index: number; enableCellEditing: () => void }) => void;
          cellEditKey: string;
          rules?: RulesList;
          onSubmitEdit: (props: {
              row: T;
              index: number;
              reset: () => void | Promise<void>;
              refreshAsIs: () => void | Promise<void>;
              originalCellValue: any;
              editedValue: any;
          }) => void | Promise<void>;
          requireConfirmation?: boolean;
          confirmationMessage?: string;
      }
);

export type BaseTableProps<T> = {
    placeDividers?: boolean;
    noElevation?: boolean;
    xlsx?: boolean;
    rowColor?: (row: T) => string | undefined;
    setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
    numberOfItemsPerPageChoices?: false | { label: string; value: number }[];
    iconName?: string;
    loading?: boolean;
    setSearchValue?: (text: string | null) => void;
    searchValue?: string | null;
    Icon?: (iconProps: Omit<IconProps, "name">) => any;
    numberOfItemsPerPage?: number;
    showNumber?: boolean;
    tableContainerStyle?: StyleValue;
    Row?: (props: { items: T }) => any;
    headers: TableHeader<T>[];
    /** When set, the table fetches, filters and sorts on the server. */
    server?: import("./filters").TableServerConfig;
    rowTone?: (row: T) => import("./filters").StatusTone;
};

export type ApiTableProps<T, RawData extends JsonValue = any> = BaseTableProps<T> & {
    url: string;
    title: string | ((data: RawData) => string);
    filters?: import("./filters").TableFilter[];
    filterValues?: import("./filters").FilterValues;
    onFilterChange?: (key: string, value: unknown) => void;
    onFilterClear?: () => void;
    filterTotal?: number;
    /**
     * Whether the already-fetched page is also filtered by the search text.
     * Set false when the server performs the search, so the current page is
     * not filtered a second time.
     */
    localSearch?: boolean;
    /** Called after each successful refresh with the rendered rows and total. */
    onData?: (rows: T[], total: number) => void;

    TopSlot?: (props: { loading: boolean; reset: () => void; refresh: RefreshMethodWithNextSkip; refreshAsIs: () => void }) => any;
    setRefreshHook?: (props: { reset: () => void; refresh: RefreshMethodWithNextSkip; refreshAsIs: () => void }) => void;
    clearRefreshHook?: (props: { reset: () => void; refresh: RefreshMethodWithNextSkip; refreshAsIs: () => void }) => void;
    onRefresh: (
        props: {
            skip: number;
            page: number;
            sortKey: string | null;
            sortDirection: "asc" | "desc";
        },
        refresh: RefreshMethodApiWithoutSkip,
    ) => void;
    onSort?: (
        sortTarget: {
            headerKey: string;
            direction: "desc" | "asc";
        },
        refresh: RefreshMethodApiWithoutSkip,
    ) => Promise<void> | void;
    apiHeaders?: AxiosRequestConfig["headers"];
    apiDataExtractor: (data: RawData) => T[];
    apiTotalExtractor: (data: RawData) => number;
    apiPageSizeExtractor?: (data: RawData) => number;
};

export type DataTableProps<T> = BaseTableProps<T> & {
    data: T[];
    title: string;
    TopSlot?: (props: { refreshAsIs: () => void; reset: () => void; refresh: RefreshMethodWithNextSkip }) => any;
    loading?: boolean;
};
