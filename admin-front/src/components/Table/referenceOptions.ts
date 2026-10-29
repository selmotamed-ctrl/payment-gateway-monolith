import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import type { FilterOption } from "./filters";

const cache = new Map<string, FilterOption[]>();

/** Debounced-friendly loader backed by the dedicated /options endpoints. */
export const createOptionsLoader = (kind: string) => async (search: string): Promise<FilterOption[]> => {
    const key = `${kind}:${search}`;
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }
    const response = await api.get(urlsMap.options(kind), {
        params: { search: search || undefined, limit: 50 },
    });
    const payload = response.data?.data ?? response.data ?? {};
    const items = (payload.items ?? []) as FilterOption[];
    cache.set(key, items);
    return items;
};
