import { api } from "@/state/api";
import { extractApiError, type ApiError } from "@/utils/errors/extractor";
import type { Merge } from "kt-common";
import { dc, type DCExpose } from "kt-dc";
import { VAutocomplete } from "vuetify/components";

type ApiAutocompleteProps<T> = Merge<
    {
        itemTitle: (item: T) => string;
        itemValue: (item: T) => any;
    },
    InstanceType<typeof VAutocomplete>["$props"]
> & {
    url: string;
    apiDataExtractor: (data: any) => T[];
};

const ApiAutocomplete = dc(
    <T,>(
        props: ApiAutocompleteProps<T>,
        expose: DCExpose<{
            refresh: () => Promise<void>;
        }>,
        ctx: any,
    ) => {
        const loading = ref(false);
        const apiError = ref(null as null | ApiError);
        const data = ref([] as any[]);
        const load = async () => {
            if (loading.value || !props.url) {
                return;
            }
            apiError.value = null;
            loading.value = true;
            try {
                data.value = props.apiDataExtractor((await api.get(props.url)).data);
                console.log("Api autocomplete", props.url, data.value);
            } catch (error) {
                console.error(error);
                const e = extractApiError(error);
                if (e) {
                    apiError.value = e;
                }
            } finally {
                loading.value = false;
            }
        };

        watch(
            () => props.url,
            () => {
                load();
            },
            {
                immediate: true,
            },
        );

        expose({
            refresh: load,
        });

        return () => {
            const f = ctx.attrs as InstanceType<typeof Autocomplete>["$props"] & {
                url: string;
                key: string;
                apiDataExtractor: (data: any) => any[];
            };
            return (
                <VAutocomplete
                    {...f}
                    items={data.value as T[]}
                    loading={loading.value || f.loading}
                    disabled={loading.value || f.disabled}
                    errorMessages={apiError.value?.error}
                    prependIcon={"mdi-reload"}
                    onClick:prepend={() => {
                        load();
                    }}
                ></VAutocomplete>
            );
        };
    },
    {
        props: ["url", "apiDataExtractor", "items"] as any[],
    },
);
export default ApiAutocomplete;
