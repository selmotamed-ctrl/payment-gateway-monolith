import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { normalizeOptions } from "../lib/options";
import { PgAutocomplete } from "./PgAutocomplete";

type ApiResult = { items: any[]; hasMore?: boolean; total?: number };
type SelectedResolver = (values: any[], signal: AbortSignal) => Promise<any[]>;

const EMPTY: any[] = [];

const valueOf = (item: any, accessors: Record<string, any>): any => {
    const [option] = normalizeOptions([item], accessors);
    return option?.value;
};
const labelOf = (item: any, accessors: Record<string, any>): string => {
    const [option] = normalizeOptions([item], accessors);
    return option?.label ?? "";
};

/**
 * Async server-backed autocomplete.
 *
 * - `endpoint` + `<PgProvider :config>` API client, or `fetcher(query, page, signal)`.
 * - 250 ms debounce, one in-flight request and an `AbortController` that cancels
 *   the stale request before a newer one starts.
 * - Selected labels are cached, so an id from the URL never renders raw even
 *   when it is outside the first page.
 * - No bordered refresh control inside the input: loading shows a 14px spinner
 *   where the chevron sits; retry/load-more live inside the dropdown.
 */
export const PgApiAutocomplete = dc(
    (props: Record<string, any>, expose, { attrs, emit }) => {
        const config = usePgUiConfig();
        const accessors = computed<Record<string, any>>(() => ({
            itemTitle: props.itemTitle,
            itemValue: props.itemValue,
            itemSubtitle: props.itemSubtitle,
            itemIcon: props.itemIcon,
            itemDisabled: props.itemDisabled,
        }));

        const options = ref<any[]>([]);
        const cache = ref<Record<string, { item: any; label: string }>>({});
        const loading = ref(false);
        const error = ref("");
        const hasMore = ref(false);
        const page = ref(1);
        const loaded = ref(false);
        const currentQuery = ref("");
        let controller: AbortController | null = null;
        let resolveController: AbortController | null = null;
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        let sequence = 0;

        const cacheItems = (items: any[]) => {
            if (!Array.isArray(items) || !items.length) return;
            const next = { ...cache.value };
            for (const item of items) {
                const value = valueOf(item, accessors.value);
                if (value === null || value === undefined) continue;
                next[String(value)] = { item, label: labelOf(item, accessors.value) };
            }
            cache.value = next;
        };

        const seedCache = (items: any) => {
            if (Array.isArray(items)) cacheItems(items);
        };
        seedCache(props.items);

        const selectedValues = computed<any[]>(() => {
            if (props.multiple)
                return Array.isArray(props.modelValue) ? props.modelValue : [];
            return props.modelValue === null ||
                props.modelValue === undefined ||
                props.modelValue === ""
                ? []
                : [props.modelValue];
        });

        const labelMap = computed(() => {
            const map: Record<string, string> = {};
            if (props.labels && typeof props.labels === "object") {
                for (const [key, label] of Object.entries(props.labels)) {
                    if (label !== null && label !== undefined) map[key] = String(label);
                }
            }
            for (const [key, entry] of Object.entries(cache.value)) {
                map[key] = entry.label;
            }
            return map;
        });

        /** Selected rows first so chips keep their icon/subtitle out of page one. */
        const combinedItems = computed(() => {
            const present = new Set(
                options.value.map((item) => String(valueOf(item, accessors.value))),
            );
            const selected = selectedValues.value
                .filter((value) => !present.has(String(value)) && cache.value[String(value)])
                .map((value) => cache.value[String(value)]!.item);
            // When every selected value is already in the server page, keep the
            // exact same array. Returning a fresh array on every selection made
            // the autocomplete rebuild every option row (and lose hover/scroll).
            return selected.length ? [...selected, ...options.value] : options.value;
        });

        const dedupe = (items: any[]): any[] => {
            const seen = new Set<string>();
            const result: any[] = [];
            for (const item of items) {
                const key = String(valueOf(item, accessors.value));
                if (seen.has(key)) continue;
                seen.add(key);
                result.push(item);
            }
            return result;
        };

        const extract = (data: any): ApiResult => {
            if (props.apiDataExtractor) {
                const extracted = props.apiDataExtractor(data);
                return { items: Array.isArray(extracted) ? extracted : [], hasMore: false };
            }
            if (Array.isArray(data)) return { items: data, hasMore: false };
            if (!data || typeof data !== "object") return { items: [], hasMore: false };
            const items = Array.isArray(data.items)
                ? data.items
                : Array.isArray(data.results)
                  ? data.results
                  : Array.isArray(data.rows)
                    ? data.rows
                    : Array.isArray(data.data)
                      ? data.data
                      : [];
            const hasMore = Boolean(
                data.hasMore ??
                    data.has_more ??
                    data.meta?.hasMore ??
                    data.pagination?.hasMore ??
                    data.pagination?.has_more ??
                    false,
            );
            return { items, hasMore };
        };

        const canLoad = () =>
            typeof props.fetcher === "function" ||
            Boolean(props.endpoint || props.url) && Boolean(config.api?.get);

        const request = async (
            query: string,
            targetPage: number,
            signal: AbortSignal,
        ): Promise<ApiResult> => {
            if (typeof props.fetcher === "function") {
                const result = await props.fetcher(query, targetPage, signal);
                if (Array.isArray(result)) return { items: result, hasMore: false };
                if (!result || typeof result !== "object") return { items: [] };
                return {
                    items: Array.isArray(result.items)
                        ? result.items
                        : Array.isArray(result.results)
                          ? result.results
                          : [],
                    hasMore: Boolean(result.hasMore ?? result.has_more),
                };
            }
            const endpoint = props.endpoint || props.url;
            const params: Record<string, unknown> = {
                ...(props.queryParams ?? {}),
                [props.pageParam || "page"]: targetPage,
            };
            if (query) params[props.queryParam || "search"] = query;
            const response = await config.api!.get(endpoint, { params, signal });
            return extract(response?.data);
        };

        const load = async (query: string, mode: "reset" | "more") => {
            if (!canLoad()) return;
            if (mode === "more" && (!hasMore.value || loading.value)) return;
            controller?.abort();
            const mine = new AbortController();
            controller = mine;
            const mineSequence = ++sequence;
            const targetPage = mode === "more" ? page.value + 1 : 1;
            loading.value = true;
            error.value = "";
            currentQuery.value = query;
            try {
                const result = await request(query, targetPage, mine.signal);
                if (mine.signal.aborted || mineSequence !== sequence) return;
                const items = Array.isArray(result.items) ? result.items : [];
                cacheItems(items);
                options.value =
                    mode === "more" ? dedupe([...options.value, ...items]) : items;
                hasMore.value = Boolean(result.hasMore);
                page.value = targetPage;
                loaded.value = true;
            } catch (cause) {
                if (mine.signal.aborted || mineSequence !== sequence) return;
                const extracted = config.extractApiError?.(cause);
                const message =
                    extracted?.error ??
                    extracted?.message ??
                    (cause instanceof Error ? cause.message : "") ??
                    "";
                error.value = message || "Could not load options";
                emit?.("error", cause);
            } finally {
                if (mineSequence === sequence) loading.value = false;
            }
        };

        const scheduleSearch = (query: string) => {
            if (debounceTimer) clearTimeout(debounceTimer);
            const delay = Math.max(0, Number(props.debounceMs ?? 250));
            debounceTimer = setTimeout(() => {
                debounceTimer = undefined;
                void load(query, "reset");
            }, delay);
        };

        const resolveSelected = async () => {
            if (typeof props.resolveSelected !== "function") return;
            const missing = selectedValues.value.filter(
                (value) => !cache.value[String(value)],
            );
            if (!missing.length) return;
            resolveController?.abort();
            const mine = new AbortController();
            resolveController = mine;
            try {
                const items = await props.resolveSelected(missing, mine.signal);
                if (mine.signal.aborted) return;
                if (Array.isArray(items)) cacheItems(items);
            } catch (cause) {
                if (!mine.signal.aborted) emit?.("error", cause);
            }
        };

        watch(
            () => props.modelValue,
            () => void resolveSelected(),
            { deep: true },
        );
        watch(
            () => props.items,
            (items) => {
                seedCache(items);
                if (Array.isArray(items) && items.length && !options.value.length) {
                    options.value = [...items];
                }
            },
            { deep: true },
        );

        onMounted(() => {
            void resolveSelected();
            // With an endpoint and an existing selection, fill the label cache
            // once even before the user opens the dropdown.
            if (
                props.preloadOnOpen !== false &&
                selectedValues.value.length &&
                canLoad() &&
                !loaded.value
            ) {
                void load("", "reset");
            }
        });

        onBeforeUnmount(() => {
            controller?.abort();
            resolveController?.abort();
            if (debounceTimer) clearTimeout(debounceTimer);
        });

        expose?.({
            refresh: () => void load(currentQuery.value, "reset"),
            resolve: () => void resolveSelected(),
        });

        const forwardProps = () => {
            const out: Record<string, any> = {};
            const keys = [
                "label",
                "placeholder",
                "hint",
                "error",
                "errorMessages",
                "multiple",
                "searchable",
                "creatable",
                "allowCustom",
                "clearable",
                "disabled",
                "readonly",
                "required",
                "size",
                "density",
                "maxVisibleChips",
                "noResultsText",
                "itemTitle",
                "itemValue",
                "itemSubtitle",
                "itemIcon",
                "itemDisabled",
                "prependInnerIcon",
                "appendInnerIcon",
                "rules",
                "hideDetails",
                "id",
            ];
            for (const key of keys) {
                if (props[key] !== undefined) out[key] = props[key];
            }
            if (attrs.class) out.class = attrs.class;
            if (attrs.style) out.style = attrs.style;
            if (attrs["aria-label"]) out["aria-label"] = attrs["aria-label"];
            return out;
        };

        return () => (
            <PgAutocomplete
                {...forwardProps()}
                items={combinedItems.value}
                modelValue={props.modelValue}
                loading={loading.value}
                serverError={error.value}
                hasMore={hasMore.value}
                valueLabels={labelMap.value}
                onUpdate:modelValue={(value: any) => emit?.("update:modelValue", value)}
                onSearch={(query: string) => {
                    emit?.("search", query);
                    scheduleSearch(query);
                }}
                onOpen={() => {
                    emit?.("open");
                    if (
                        props.preloadOnOpen !== false &&
                        !loaded.value &&
                        !currentQuery.value
                    ) {
                        void load("", "reset");
                    }
                }}
                onSelect={(item: any) => {
                    seedCache([item]);
                    emit?.("select", item);
                }}
                onLoadMore={() => void load(currentQuery.value, "more")}
                onRetry={() => void load(currentQuery.value || "", "reset")}
            />
        );
    },
    {
        props: {
            modelValue: { type: [String, Number, Array, Object], default: null },
            /** Initial option/label cache (selected rows, previously seen pages). */
            items: { type: Array as () => any[], default: () => EMPTY },
            endpoint: { type: String, default: "" },
            /** Legacy spelling kept for the existing forms. */
            url: { type: String, default: "" },
            fetcher: {
                type: Function as unknown as () => (
                    query: string,
                    page: number,
                    signal: AbortSignal,
                ) => Promise<ApiResult | any[]>,
                default: undefined,
            },
            resolveSelected: {
                type: Function as unknown as () => SelectedResolver,
                default: undefined,
            },
            queryParam: { type: String, default: "search" },
            pageParam: { type: String, default: "page" },
            debounceMs: { type: Number, default: 250 },
            preloadOnOpen: { type: Boolean, default: true },
            pageSize: { type: Number, default: 20 },
            labels: { type: Object, default: undefined },
            queryParams: { type: Object, default: undefined },
            apiDataExtractor: {
                type: Function as unknown as () => (data: any) => any[],
                default: undefined,
            },
            multiple: { type: Boolean, default: false },
            itemTitle: { type: [String, Function], default: undefined },
            itemValue: { type: [String, Function], default: undefined },
            itemSubtitle: { type: [String, Function], default: undefined },
            itemIcon: { type: [String, Function], default: undefined },
            itemDisabled: { type: [String, Function], default: undefined },
            label: { type: String, default: "" },
            placeholder: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            searchable: { type: Boolean, default: true },
            creatable: { type: Boolean, default: false },
            allowCustom: { type: Boolean, default: false },
            clearable: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            size: { type: String, default: "" },
            density: { type: String, default: "" },
            maxVisibleChips: { type: Number, default: 3 },
            noResultsText: { type: String, default: "" },
            prependInnerIcon: { type: String, default: "" },
            appendInnerIcon: { type: String, default: "" },
            rules: {
                type: Array as () => Array<(value: any) => any>,
                default: undefined,
            },
            hideDetails: { type: Boolean, default: false },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "search", "select", "error", "open"],
        inheritAttrs: true,
    },
);

export const ApiAutocomplete = PgApiAutocomplete;
