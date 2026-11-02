import { ref, watch, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";

export interface UseOpenQueryOptions<TRecord> {
    /** Query parameter name to watch (defaults to 'open') */
    queryParam?: string;
    /** Optional reactive array of currently loaded table rows for instant lookup */
    loadedRows?: Ref<TRecord[]>;
    /** Key extractor on loaded rows (defaults to (row) => row.id) */
    getId?: (row: TRecord) => string;
    /** Whether to call fetchById even if found in loadedRows */
    alwaysFetchDetail?: boolean;
    /** Async fetcher to retrieve the full record detail by ID */
    fetchById: (id: string) => Promise<TRecord | null>;
    /** Callback invoked once to open the drawer/dialog with the resolved record */
    onOpenRecord: (record: TRecord) => void;
    /** Optional callback if fetchById returns null or fails */
    onNotFound?: (id: string) => void;
}

const normalizeQueryId = (rawValue: unknown): string => {
    if (Array.isArray(rawValue)) {
        for (const value of rawValue) {
            if (typeof value === "string" && value.trim()) return value.trim();
        }
        return "";
    }
    return typeof rawValue === "string" ? rawValue.trim() : "";
};

const defaultGetId = <TRecord>(row: TRecord): string => {
    const id = (row as { id?: unknown } | null | undefined)?.id;
    return id === null || id === undefined ? "" : String(id);
};

export function useOpenQuery<TRecord>(options: UseOpenQueryOptions<TRecord>) {
    const route = useRoute();
    const router = useRouter();
    const paramKey = options.queryParam ?? "open";
    const getId = options.getId ?? defaultGetId<TRecord>;

    const lastHandledId = ref<string | null>(null);
    const isResolvingOpenQuery = ref(false);

    const clearOpenQueryParam = async () => {
        if (!(paramKey in route.query)) return;
        const nextQuery = { ...route.query };
        delete nextQuery[paramKey];
        lastHandledId.value = null;
        await router.replace({ query: nextQuery });
    };

    watch(
        () => route.query[paramKey],
        async (rawValue) => {
            const targetId = normalizeQueryId(rawValue);

            if (!targetId) {
                lastHandledId.value = null;
                return;
            }

            // One-shot guard: never re-open the same record after a reactive refresh.
            if (lastHandledId.value === targetId) return;
            lastHandledId.value = targetId;
            isResolvingOpenQuery.value = true;

            try {
                if (!options.alwaysFetchDetail && options.loadedRows?.value?.length) {
                    const existing = options.loadedRows.value.find((row) => getId(row) === targetId);
                    if (existing) {
                        options.onOpenRecord(existing);
                        return;
                    }
                }

                const fetched = await options.fetchById(targetId);
                if (fetched) {
                    options.onOpenRecord(fetched);
                } else {
                    options.onNotFound?.(targetId);
                }
            } catch {
                options.onNotFound?.(targetId);
            } finally {
                isResolvingOpenQuery.value = false;
            }
        },
        { immediate: true },
    );

    return {
        isResolvingOpenQuery,
        clearOpenQueryParam,
    };
}
