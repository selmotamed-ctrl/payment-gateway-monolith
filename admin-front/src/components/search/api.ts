import { urlsMap } from "@/constants/urlsMap";
import { api } from "@/state/api";
import type {
    GlobalSearchFetchResult,
    GlobalSearchRequest,
    GlobalSearchResponse,
} from "./types";

interface CacheEntry {
    response: GlobalSearchResponse;
    expiresAt: number;
}

const SESSION_CACHE_TTL_MS = 60_000;
const GLOBAL_SEARCH_TIMEOUT_MS = 8_000;
const FALLBACK_GLOBAL_SEARCH_URL = "v1/admin/search";

const searchCache = new Map<string, CacheEntry>();

let activeController: AbortController | null = null;
let latestSequenceId = 0;

const globalSearchUrl =
    (urlsMap as unknown as { globalSearch?: string }).globalSearch || FALLBACK_GLOBAL_SEARCH_URL;

function makeCacheKey(request: GlobalSearchRequest): string {
    const query = request.query.trim().toLowerCase();
    const limit = request.limit ?? 5;
    const types = request.types ? [...request.types].sort().join(",") : "*";
    return `${query}::${limit}::${types}`;
}

export function clearGlobalSearchCache(): void {
    searchCache.clear();
}

export function cancelPendingGlobalSearch(): void {
    if (!activeController) {
        return;
    }
    activeController.abort();
    activeController = null;
}

export async function fetchGlobalSearchResults(
    request: GlobalSearchRequest,
    options?: { bypassCache?: boolean },
): Promise<GlobalSearchFetchResult> {
    const key = makeCacheKey(request);
    const now = Date.now();

    if (!options?.bypassCache) {
        const cached = searchCache.get(key);
        if (cached && cached.expiresAt > now) {
            return { data: cached.response, stale: false };
        }
    }

    cancelPendingGlobalSearch();

    const controller = new AbortController();
    activeController = controller;
    const sequenceId = ++latestSequenceId;

    try {
        const response = await api.post<GlobalSearchResponse>(
            globalSearchUrl,
            {
                query: request.query.trim(),
                limit: request.limit ?? 5,
                ...(request.types && request.types.length > 0 ? { types: request.types } : {}),
            },
            {
                timeout: GLOBAL_SEARCH_TIMEOUT_MS,
                signal: controller.signal,
            },
        );

        if (sequenceId !== latestSequenceId) {
            return { data: response.data, stale: true };
        }

        if (!response.data.partial) {
            searchCache.set(key, {
                response: response.data,
                expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
            });
        }

        return { data: response.data, stale: false };
    } finally {
        if (activeController === controller) {
            activeController = null;
        }
    }
}
