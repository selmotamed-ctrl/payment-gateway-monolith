import type { StyleValue } from "vue";
import type { TableFilter, FilterValues } from "./filters";

export const defaultNumberOfItemsPerPageChoices: { label: string; value: number }[] = [
  { label: "10", value: 10 },
  { label: "15", value: 15 },
  { label: "20", value: 20 },
  { label: "50", value: 50 },
  { label: "100", value: 100 },
];

export type TableHeader<T> = {
  key: string;
  label?: string;
  value?: ((row: T, index: number) => string) | string | string[];
  Value?: (props: { row: T }) => JSX.Element;
  sortable?: boolean;
  sortKey?: string;
  minWidth?: boolean;
  startSeparator?: boolean;
  endSeparator?: boolean;
  headerTooltip?: string;
  headerCellStyle?: StyleValue;
  rowCellStyle?: StyleValue;
};

export type BaseTableProps<T> = {
  headers: TableHeader<T>[];
  title?: string;
  loading?: boolean;
  rowColor?: (row: T) => string | undefined;
  searchValue?: string | null;
  setSearchValue?: (text: string | null) => void;
  numberOfItemsPerPage?: number;
  numberOfItemsPerPageChoices?: false | { label: string; value: number }[];
  setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
  showNumber?: boolean;
  tableContainerStyle?: StyleValue;
  filters?: TableFilter[];
  filterValues?: FilterValues;
  onFilterChange?: (key: string, value: unknown) => void;
  onFilterClear?: () => void;
  filterTotal?: number;
};

export type DataTableProps<T> = BaseTableProps<T> & {
  data: T[];
  title: string;
  TopSlot?: (props: { refreshAsIs: () => void; reset: () => void; refresh: () => void }) => JSX.Element;
};

export type ApiTableProps<T, RawData = unknown> = BaseTableProps<T> & {
  url: string;
  title: string;
  apiDataExtractor: (data: RawData) => T[];
  apiTotalExtractor?: (data: RawData) => number;
  onData?: (rows: T[], total: number) => void;
  TopSlot?: (props: { loading: boolean; refreshAsIs: () => void; reset: () => void; refresh: () => void }) => JSX.Element;
  setRefreshHook?: (props: { reset: () => void; refresh: () => void; refreshAsIs: () => void }) => void;
  clearRefreshHook?: (props: { reset: () => void; refresh: () => void; refreshAsIs: () => void }) => void;
};

const readPath = (path: string, row: unknown): unknown =>
  path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, row);

export function readCell<T>(
  selector: ((row: T, index: number) => string) | string | string[],
  row: T,
  index: number,
): string {
  if (typeof selector === "function") {
    return selector(row, index) ?? "";
  }
  if (Array.isArray(selector)) {
    return selector.map((key) => String(readPath(key, row) ?? "")).filter(Boolean).join(" ");
  }
  return String(readPath(selector, row) ?? "");
}

export function sortRowsByHeader<T>(
  rows: T[],
  headers: TableHeader<T>[],
  sortBy: string | null,
  sortDirection: "asc" | "desc",
): T[] {
  if (!sortBy) return rows;
  const header = headers.find((candidate) => (candidate.sortKey ?? candidate.key) === sortBy);
  if (!header) return rows;
  const valueOf = (row: T): string => {
    if (header.value !== undefined) {
      return readCell(header.value, row, 0);
    }
    return String((row as Record<string, unknown>)[header.key] ?? "");
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
