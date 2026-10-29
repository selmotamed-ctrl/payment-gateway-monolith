import { type AxiosRequestConfig } from "axios";
import { rs, type JsonValue } from "@/utils/common";
import type { StyleValue } from "vue";
import type { RulesList } from "@/utils/clientValidationRules";

export const defaultNumberOfItemsPerPageChoices: {
    label: string;
    value: number;
}[] = [
    {
        label: "10",
        value: 10,
    },
    {
        label: "15",
        value: 15,
    },
    {
        label: "20",
        value: 20,
    },
    {
        label: "50",
        value: 50,
    },
    {
        label: "100",
        value: 100,
    },
    // {
    //     label: "All",
    //     value: -1,
    // },
];

export const defaultNumberOfItemsPerPageChoicesWithAll: {
    label: string;
    value: number;
}[] = [
    {
        label: "10",
        value: 10,
    },
    {
        label: "20",
        value: 20,
    },
    {
        label: "50",
        value: 50,
    },
    {
        label: "100",
        value: 100,
    },
    {
        label: "All",
        value: -1,
    },
];

export type IconProps = {
    onClick?: () => void | Promise<void>;
    color?: string;
    icon?: string;
    size?: string | number;
};

export type RefreshMethodApiWithoutSkip = (refreshProps: { queryParams?: any }) => Promise<void>;

export type RefreshMethodData = (refreshProps: { nextSkip: number }) => Promise<void>;

export type RefreshMethodWithNextSkip = (refreshProps: { queryParams?: any; nextSkip: number }) => Promise<void>;

export function readCell<T>(selector: ((row: T, index: number) => string) | string | string[], row: T, index: number): string {
    if (typeof selector == "function") {
        return selector(row, index) ?? "";
    }

    return rs(selector, row) ?? "";
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
    Tooltip?: (props: { row: T }) => JSX.Element | null;
    tooltip?: (props: { row: T }) => string | null;
    disabled?: (row: T) => boolean;
};

export type TableHeader<T> = {
    startSeparator?: boolean;
    endSeparator?: boolean;
    Header?: () => JSX.Element; // --
    label?: string; // --
    CellTooltip?: () => JSX.Element;
    cellToolTip?: {
        text: (row: T) => string;
        onClick?: (row: T) => void;
    };
    headerIcon?: string; // --
    HeaderIcon?: (iconProps: Omit<IconProps, "name">) => JSX.Element; // --
    headerTextStyle?: StyleValue; // --
    rowTextStyle?: StyleValue;
    headerCellStyle?: StyleValue; // --
    rowCellStyle?: StyleValue; // --
    key: string; // --
    minWidth?: boolean; // - web only
    actions?: TableHeaderAction<T>[];
    menu?: boolean;
    value?: ((row: T, index: number) => string) | string | string[]; // --
    Value?: (props: { row: T }) => JSX.Element; // --
    sortable?: boolean;
    sortKey?: string;
    /** Column filters are derived from the values unless configured here. */
    filterable?: boolean;
    filterType?: "text" | "select" | "boolean";
    filterOptions?: { title: string; value: string }[];
    onHeaderPress?: () => void | Promise<void>; // --
    onCellPress?: (row: T, props: {
        refresh: RefreshMethodData | RefreshMethodWithNextSkip;
        reset: ()=>Promise<void> | void;
        refreshAsIs: ()=>Promise<void> | void;
    }) => void | Promise<void>; // --
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
    Icon?: (iconProps: Omit<IconProps, "name">) => JSX.Element;
    numberOfItemsPerPage?: number;
    showNumber?: boolean;
    tableContainerStyle?: StyleValue; // --
    Row?: (props: { items: T }) => JSX.Element; // --
    headers: TableHeader<T>[]; // --
    /** When set, the table fetches, filters and sorts on the server. */
    server?: import("./filters").TableServerConfig;
    rowTone?: (row: T) => import("@/components/StatusChip").StatusTone;
};

export type ApiTableProps<T, RawData extends JsonValue = any> = BaseTableProps<T> & {
    url: string; // --
    title: string | ((data: RawData) => string);

    TopSlot?: (props: { loading: boolean; reset: () => void; refresh: RefreshMethodWithNextSkip; refreshAsIs: () => void }) => JSX.Element;
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
    ) => void; // --
    onSort?: (
        sortTarget: {
            headerKey: string;
            direction: "desc" | "asc";
        },
        refresh: RefreshMethodApiWithoutSkip,
    ) => Promise<void> | void;
    apiHeaders?: AxiosRequestConfig["headers"]; // --
    apiDataExtractor: (data: RawData) => T[]; // --
    apiTotalExtractor: (data: RawData) => number; // --
    apiPageSizeExtractor?: (data: RawData) => number; // --
};

export type DataTableProps<T> = BaseTableProps<T> & {
    data: T[];
    title: string;
    TopSlot?: (props: { refreshAsIs: () => void; reset: () => void; refresh: RefreshMethodWithNextSkip }) => JSX.Element;
    loading?: boolean;
};

/**
 * Sorts rows by the header the user clicked. Values are read through the
 * column accessor when present, otherwise from the row key. Numeric strings,
 * dates and text are compared naturally; nullish values sort first.
 */
export function sortRowsByHeader<T>(
    rows: T[],
    headers: TableHeader<T>[],
    sortBy: string | null,
    sortDirection: "asc" | "desc",
): T[] {
    if (!sortBy) {
        return rows;
    }
    const header = headers.find((candidate) => (candidate.sortKey ?? candidate.key) === sortBy);
    if (!header) {
        return rows;
    }
    const valueOf = (row: T): string => {
        if (header.value !== undefined) {
            return readCell(header.value, row, 0);
        }
        const raw = (row as Record<string, unknown>)[header.key];
        return raw === null || raw === undefined ? "" : String(raw);
    };
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
        const a = valueOf(left);
        const b = valueOf(right);
        const an = Number(a);
        const bn = Number(b);
        if (a !== "" && b !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) {
            return (an - bn) * direction;
        }
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) * direction;
    });
}
