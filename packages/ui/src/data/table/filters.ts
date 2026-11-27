export type StatusTone = "success" | "warning" | "info" | "error" | "neutral" | "primary";

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

const isBlank = (value: unknown): boolean => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const cleanStringList = (value: unknown[]): string[] =>
    value
        .filter((entry) => !isBlank(entry))
        .map((entry) => String(entry).trim())
        .filter(Boolean);

/**
 * A filter is active only when the operator actually narrowed the result set.
 * Empty arrays, blank strings (`"   "`), `null`, and an empty date/number range
 * all count as inactive so the badge and the URL stay clean.
 */
export const isFilterActive = (filter: TableFilter, value: unknown): boolean => {
    if (filter.type === "boolean") {
        // `false` is a deliberate filter value; only a missing value is inactive.
        return value !== undefined && value !== null && value !== "";
    }
    if (isBlank(value)) return false;
    if (Array.isArray(value)) return cleanStringList(value).length > 0;
    if (typeof value === "object") {
        return Object.values(value as Record<string, unknown>).some((entry) => !isBlank(entry) && !(Array.isArray(entry) && entry.length === 0));
    }
    if (typeof value === "string") return value.trim() !== "";
    return true;
};

/** Maps a filter value to the query parameters the backend expects. */
export const filterToQuery = (filter: TableFilter, value: unknown): Record<string, string> => {
    if (!isFilterActive(filter, value)) {
        return {};
    }
    if (filter.type === "text" || filter.type === "api-autocomplete" || filter.type === "data-autocomplete") {
        const query = filter.query ?? filter.key;
        if (Array.isArray(value)) {
            // Never emit `status=` for a cleared multi-select.
            const joined = cleanStringList(value).join(",");
            return joined ? { [query]: joined } : {};
        }
        const text = String(value).trim();
        return text ? { [query]: text } : {};
    }
    if (filter.type === "boolean") {
        const text = String(value).trim();
        return text ? { [filter.query ?? filter.key]: text } : {};
    }
    if (filter.type === "number-range") {
        const range = value as { min?: unknown; max?: unknown };
        const result: Record<string, string> = {};
        const min = isBlank(range?.min) ? "" : String(range.min).trim();
        const max = isBlank(range?.max) ? "" : String(range.max).trim();
        if (min) result[filter.queryMin ?? `${filter.key}Min`] = min;
        if (max) result[filter.queryMax ?? `${filter.key}Max`] = max;
        return result;
    }
    if (filter.type === "date") {
        const range = value as { from?: unknown; to?: unknown };
        const result: Record<string, string> = {};
        const from = isBlank(range?.from) ? "" : String(range.from).trim();
        const to = isBlank(range?.to) ? "" : String(range.to).trim();
        if (from) result[filter.queryFrom ?? "from"] = from;
        if (to) result[filter.queryTo ?? "to"] = to;
        return result;
    }
    return {};
};

export const buildFilterQuery = (filters: TableFilter[], values: FilterValues): Record<string, string> =>
    (filters ?? []).reduce<Record<string, string>>(
        (query, filter) => ({ ...query, ...filterToQuery(filter, values?.[filter.key]) }),
        {},
    );

export const activeFilterCount = (filters: TableFilter[], values: FilterValues): number =>
    (filters ?? []).filter((filter) => isFilterActive(filter, values?.[filter.key])).length;

export interface TableServerConfig {
    url: string;
    listKey: string;
    filters?: TableFilter[];
    defaultSort?: { key: string; direction: "asc" | "desc" };
    storageKey?: string;
    params?: Record<string, unknown>;
    map?: (rows: any[]) => any[];
}
