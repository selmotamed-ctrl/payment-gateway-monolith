import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VFileInput, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { formatPlainNumber } from "@/utils/money";

type StatementSource = {
    id: string;
    name: string;
    gatewayId: string;
    format: string;
    delimiter: string;
    currency: string;
    active: boolean;
    columnMapping: Record<string, string>;
};

type ReconciliationRun = {
    id: string;
    sourceId: string;
    sourceName: string;
    fileName: string;
    state: string;
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    drift: string;
    startedAt: string;
    finishedAt: string | null;
};

const ReconciliationPage = dc(() => {
    const { t } = useLocale();
    const sources = ref<StatementSource[]>([]);
    const runs = ref<ReconciliationRun[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const selectedSourceId = ref<string | null>(null);
    const file = ref<File | null>(null);
    const uploadLoading = ref(false);
    const preview = ref<{ columns: string[]; rows: string[][] } | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [sourcesResponse, runsResponse] = await Promise.all([
                api.get(urlsMap.reconciliationSources),
                api.get(urlsMap.reconciliationRuns),
            ]);
            const sourcesPayload = sourcesResponse.data?.data ?? sourcesResponse.data ?? {};
            const runsPayload = runsResponse.data?.data ?? runsResponse.data ?? {};
            sources.value = sourcesPayload.sources ?? sourcesPayload.rows ?? [];
            runs.value = runsPayload.runs ?? runsPayload.rows ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const upload = async () => {
        if (!file.value || !selectedSourceId.value) {
            showSnackBar({ type: "warning", message: t("Choose a statement source and a file") });
            return;
        }
        uploadLoading.value = true;
        try {
            const body = new FormData();
            body.append("sourceId", selectedSourceId.value);
            body.append("file", file.value);
            const response = await api.post(urlsMap.reconciliationUpload, body, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            const payload = response.data?.data ?? response.data ?? {};
            preview.value = payload.preview ?? null;
            showSnackBar({ type: "success", message: t("Uploaded File") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            uploadLoading.value = false;
        }
    };

    const sourceHeaders: TableHeader<StatementSource>[] = [
        { key: "name", label: "Statement Source", value: (row) => row.name },
        { key: "gatewayId", label: "Gateway", value: (row) => row.gatewayId },
        { key: "format", label: "Type", value: (row) => row.format },
        { key: "delimiter", label: "Column", value: (row) => row.delimiter },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        {
            key: "active",
            label: "Status",
            Value: ({ row }: { row: StatementSource }) => (
                <StatusChip label={row.active ? t("Active") : t("Inactive")} tone={row.active ? "success" : "neutral"} />
            ),
        },
        {
            key: "mapping",
            label: "Column Mapping",
            Value: ({ row }: { row: StatementSource }) => (
                <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>
                    {JSON.stringify(row.columnMapping ?? {})}
                </ThemedText>
            ),
        },
    ];

    const runHeaders: TableHeader<ReconciliationRun>[] = [
        { key: "sourceName", label: "Statement Source", value: (row) => row.sourceName },
        { key: "fileName", label: "Uploaded File", value: (row) => row.fileName },
        { key: "state", label: "Status", value: (row) => row.state },
        { key: "totalRows", label: "Total", value: (row) => formatPlainNumber(row.totalRows ?? 0) },
        { key: "matchedRows", label: "Matched", value: (row) => formatPlainNumber(row.matchedRows ?? 0) },
        { key: "unmatchedRows", label: "Unmatched", value: (row) => formatPlainNumber(row.unmatchedRows ?? 0) },
        { key: "drift", label: "Drift", value: (row) => row.drift },
        { key: "startedAt", label: "Created At", value: (row) => row.startedAt },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Reconciliation")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                <ThemedText type="defaultSemiBold">{t("Run File")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "flex-start" }}>
                                    <VSelect
                                        items={sources.value.map((source) => ({ title: source.name, value: source.id }))}
                                        modelValue={selectedSourceId.value}
                                        onUpdate:modelValue={(v: string | null) => (selectedSourceId.value = v)}
                                        label={t("Statement Source")}
                                        style={{ minWidth: "220px" }}
                                    />
                                    <VFileInput
                                        label={t("Uploaded File")}
                                        modelValue={file.value}
                                        onUpdate:modelValue={(v: File | File[] | null) => {
                                            file.value = Array.isArray(v) ? (v[0] ?? null) : v;
                                        }}
                                        style={{ minWidth: "260px" }}
                                    />
                                    <VBtn color="primary" loading={uploadLoading.value} onClick={() => void upload()}>
                                        {t("Upload")}
                                    </VBtn>
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        {preview.value && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Column Mapping")}</ThemedText>
                                    <div style={{ overflowX: "auto" }}>
                                        <table
                                            style={{
                                                borderCollapse: "collapse",
                                                width: "100%",
                                                fontSize: "12px",
                                                direction: "ltr",
                                            }}
                                        >
                                            <thead>
                                                <tr>
                                                    {preview.value.columns.map((column) => (
                                                        <th
                                                            key={column}
                                                            style={{
                                                                border: "1px solid rgba(100,116,139,0.3)",
                                                                padding: "6px 10px",
                                                                textAlign: "left",
                                                            }}
                                                        >
                                                            {column}
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {preview.value.rows.map((row, index) => (
                                                    <tr key={index}>
                                                        {row.map((cell, cellIndex) => (
                                                            <td
                                                                key={cellIndex}
                                                                style={{
                                                                    border: "1px solid rgba(100,116,139,0.2)",
                                                                    padding: "6px 10px",
                                                                }}
                                                            >
                                                                {cell}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </VCardText>
                            </VCard>
                        )}

                        <VCard>
                            <VCardText>
                                <DataTable
                                    title={t("Statement Source")}
                                    data={sources.value}
                                    headers={sourceHeaders}
                                    loading={loading.value}
                                    showNumber={true}
                                    xlsx={false}
                                    noElevation={true}
                                />
                            </VCardText>
                        </VCard>

                        <VCard>
                            <VCardText>
                                <DataTable
                                    title={t("Reconciliation")}
                                    data={runs.value}
                                    headers={runHeaders}
                                    loading={loading.value}
                                    showNumber={true}
                                    xlsx={false}
                                    noElevation={true}
                                />
                            </VCardText>
                        </VCard>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default ReconciliationPage;
