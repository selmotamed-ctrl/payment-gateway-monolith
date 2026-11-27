import { ref, watch } from "vue";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { PgAutocomplete } from "./PgAutocomplete";

/**
 * Async, debounced server-search wrapper over `PgAutocomplete`.
 * The host supplies `url` and an `apiDataExtractor`; the API client comes from
 * `<PgProvider>`, so no portal store is imported here.
 */
export const PgApiAutocomplete = dc(
    (props: Record<string, any>, expose, { attrs, emit }) => {
        const config = usePgUiConfig();
        const loading = ref(false);
        const error = ref("");
        const data = ref<any[]>([]);
        let sequence = 0;

        const load = async (search = "") => {
            if (!props.url || !config.api) return;
            const mine = ++sequence;
            loading.value = true;
            error.value = "";
            try {
                const params = search ? { ...(props.queryParams ?? {}), search } : props.queryParams;
                const response = await config.api.get(props.url, { params });
                const extracted = props.apiDataExtractor ? props.apiDataExtractor(response.data) : response.data;
                if (mine === sequence) data.value = Array.isArray(extracted) ? extracted : [];
            } catch (cause) {
                if (mine === sequence) {
                    const extracted = config.extractApiError?.(cause);
                    error.value = extracted?.error ?? extracted?.message ?? "Could not load options";
                }
            } finally {
                if (mine === sequence) loading.value = false;
            }
        };

        watch(() => props.url, () => void load(""), { immediate: true });
        expose?.({ refresh: () => load("") });

        return () => (
            <PgAutocomplete
                {...props}
                {...attrs}
                items={data.value}
                loading={loading.value}
                disabled={loading.value || props.disabled}
                errorMessages={error.value || props.errorMessages}
                prependInnerIcon={props.prependInnerIcon ?? "mdi-reload"}
                onClick:prependInner={() => void load("")}
                onUpdate:modelValue={(value: any) => emit?.("update:modelValue", value)}
                onSearch={(query: string) => {
                    emit?.("search", query);
                    if (props.url) void load(query);
                }}
            />
        );
    },
    {
        props: {
            url: { type: String, default: "" },
            apiDataExtractor: { type: Function as unknown as () => (data: any) => any[], default: undefined },
            queryParams: { type: Object, default: undefined },
            prependInnerIcon: { type: String, default: "" },
        } as any,
        emits: ["update:modelValue", "search"],
        inheritAttrs: true,
    },
);
