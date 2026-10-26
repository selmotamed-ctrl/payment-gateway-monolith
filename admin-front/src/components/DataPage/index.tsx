import { dc } from "kt-dc";
import { ref, watch } from "vue";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

export type DataPageProps = {
    title: string;
    subtitle?: string;
    url: string;
    method?: "get" | "post";
    headers: TableHeader<any>[];
    query?: Record<string, any>;
    body?: Record<string, any>;
    extractRows: (payload: any) => any[];
    extractTotal: (payload: any) => number;
    transformRow?: (row: any) => any;
    topSlot?: (props: { refresh: () => Promise<void>; loading: boolean }) => JSX.Element;
    emptyTitle?: string;
    showNumber?: boolean;
};

export const DataPage = dc(
    (props: DataPageProps) => {
        const rows = ref<any[]>([]);
        const loading = ref(true);
        const error = ref<string | null>(null);
        const search = ref<string | null>(null);

        const load = async () => {
            loading.value = true;
            error.value = null;
            try {
                const params = { ...(props.query ?? {}), ...(search.value ? { search: search.value } : {}) };
                const response =
                    props.method === "post"
                        ? await api.post(props.url, props.body ?? {}, { params })
                        : await api.get(props.url, { params });
                const payload = response.data?.data ?? response.data ?? {};
                const rawRows = props.extractRows(payload) ?? [];
                rows.value = props.transformRow ? rawRows.map((row) => props.transformRow!(row)) : rawRows;
            } catch (e) {
                error.value = extractApiErrorMessage(e);
                rows.value = [];
            } finally {
                loading.value = false;
            }
        };

        watch(
            () => [props.url, JSON.stringify(props.query ?? {}), JSON.stringify(props.body ?? {})],
            () => {
                void load();
            },
        );

        return () => (
            <ScreenContainer>
                <ThemedView style={{ gap: "18px" }}>
                    <PageHeader
                        title={props.title}
                        end={() => <>{props.topSlot?.({ refresh: load, loading: loading.value })}</>}
                    />
                    {props.subtitle && (
                        <div style={{ fontSize: "13px", opacity: 0.65, marginTop: "-8px" }}>{props.subtitle}</div>
                    )}
                    {error.value ? (
                        <StateView error={error.value} onRetry={() => void load()} />
                    ) : (
                        <DataTable
                            title={props.title}
                            data={rows.value}
                            headers={props.headers}
                            loading={loading.value}
                            showNumber={props.showNumber ?? true}
                            xlsx={false}
                            searchValue={search.value}
                            setSearchValue={(value) => (search.value = value)}
                        />
                    )}
                </ThemedView>
            </ScreenContainer>
        );
    },
    {
        props: [
            "title",
            "subtitle",
            "url",
            "method",
            "headers",
            "query",
            "body",
            "extractRows",
            "extractTotal",
            "transformRow",
            "topSlot",
            "emptyTitle",
            "showNumber",
        ] as any,
    },
);

export default DataPage;
