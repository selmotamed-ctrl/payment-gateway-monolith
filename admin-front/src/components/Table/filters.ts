import type { StatusTone } from "@/components/StatusChip";

export type FilterOption = {
    title: string;
    value: string;
    subtitle?: string;
    tone?: StatusTone;
};

type BaseFilter = {
    key: string;
    label: string;
    icon?: string;
    /** Query parameter name (defaults to `key`). */
    query?: string;
};

export type TableFilter =
    | (BaseFilter & { type: "text"; placeholder?: string })
    | (BaseFilter & {
          type: "api-autocomplete";
          load: (search: string) => Promise<FilterOption[]>;
          multiple?: boolean;
          placeholder?: string;
      })
    | (BaseFilter & { type: "data-autocomplete"; options: FilterOption[]; multiple?: boolean; placeholder?: string })
    | (BaseFilter & { type: "boolean"; trueLabel?: string; falseLabel?: string })
    | (BaseFilter & { type: "number-range"; queryMin?: string; queryMax?: string; suffix?: string })
    | (BaseFilter & { type: "date"; queryFrom?: string; queryTo?: string });

export type FilterValues = Record<string, unknown>;

export const isFilterActive = (filter: TableFilter, value: unknown): boolean => {
    if (value === undefined || value === null || value === "") {
        return false;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === "object") {
        return Object.values(value as Record<string, unknown>).some((entry) => entry !== undefined && entry !== null && entry !== "");
    }
    return true;
};

/** Maps a filter value to the query parameters the backend expects. */
export const filterToQuery = (filter: TableFilter, value: unknown): Record<string, string> => {
    if (!isFilterActive(filter, value)) {
        return {};
    }
    if (filter.type === "text" || filter.type === "api-autocomplete" || filter.type === "data-autocomplete") {
        const query = filter.query ?? filter.key;
        return { [query]: Array.isArray(value) ? value.join(",") : String(value) };
    }
    if (filter.type === "boolean") {
        return { [filter.query ?? filter.key]: String(value) };
    }
    if (filter.type === "number-range") {
        const range = value as { min?: string; max?: string };
        const result: Record<string, string> = {};
        if (range.min) result[filter.queryMin ?? `${filter.key}Min`] = range.min;
        if (range.max) result[filter.queryMax ?? `${filter.key}Max`] = range.max;
        return result;
    }
    if (filter.type === "date") {
        const range = value as { from?: string; to?: string };
        const result: Record<string, string> = {};
        if (range.from) result[filter.queryFrom ?? "from"] = range.from;
        if (range.to) result[filter.queryTo ?? "to"] = range.to;
        return result;
    }
    return {};
};

export const buildFilterQuery = (filters: TableFilter[], values: FilterValues): Record<string, string> =>
    filters.reduce<Record<string, string>>((query, filter) => ({ ...query, ...filterToQuery(filter, values[filter.key]) }), {});

export const activeFilterCount = (filters: TableFilter[], values: FilterValues): number =>
    filters.filter((filter) => isFilterActive(filter, values[filter.key])).length;

export interface TableServerConfig {
    url: string;
    listKey: string;
    filters?: TableFilter[];
    defaultSort?: { key: string; direction: "asc" | "desc" };
    storageKey?: string;
    params?: Record<string, unknown>;
    map?: (rows: any[]) => any[];
}
