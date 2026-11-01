import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VDialog, VFileInput, VProgressCircular, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import { DataTable } from "@/components/Table/DataTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues, type TableFilter } from "@/components/Table/filters";
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
    gatewayCode: string;
    type: string;
    format: string;
    delimiter: string;
    currency: string;
    scheduleCron: string | null;
    settlementLagDays: number;
    dedupeKeyTemplate: string | null;
    active: boolean;
    columnMapping: Record<string, unknown>;
    parserConfig: Record<string, unknown>;
    createdAt: string;
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
    amountMismatch: number;
    missingAtGateway: number;
    missingLocally: number;
    duplicates: number;
    feeVariances: number;
    matchRate: string;
    drift: number;
    stats: Record<string, unknown>;
    startedAt: string;
    createdAt: string;
    finishedAt: string | null;
    ingestedAt: string | null;
};

type ReconciliationItem = {
    id: string;
    ourReference: string;
    providerReference: string;
    batchReference: string | null;
    statementAmount: string;
    statementFee: string;
    result: string;
    attemptId: string | null;
};

type ReconciliationRunDetail = ReconciliationRun & {
    items: ReconciliationItem[];
};

type ReconciliationSummary = {
    sources: number;
    runs: number;
    completedRuns: number;
    processingRuns: number;
    totalRows: number;
    matchedRows: number;
    mismatchedRows: number;
    matchRate: string;
    resultCounts: Record<string, number>;
};

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

const parseCsvPreview = (text: string, delimiter = ","): { columns: string[]; rows: string[][] } | null => {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 8);
    if (lines.length === 0) return null;
    const parseLine = (line: string): string[] => {
        const cells: string[] = [];
        let current = "";
        let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
            const char = line[index] ?? "";
            if (char === '"') {
                if (quoted && line[index + 1] === '"') {
                    current += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else if (char === delimiter && !quoted) {
                cells.push(current);
                current = "";
            } else {
                current += char;
            }
        }
        cells.push(current);
        return cells;
    };
    const rows = lines.map(parseLine);
    const columns = rows.shift() ?? [];
    return { columns, rows };
};

const ReconciliationPage = dc(() => {
    const { t } = useLocale();
    const sources = ref<StatementSource[]>([]);
    const runs = ref<ReconciliationRun[]>([]);
    const runTotal = ref(0);
    const summary = ref<ReconciliationSummary | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const selectedSourceId = ref<string | null>(null);
    const file = ref<File | null>(null);
    const uploadLoading = ref(false);
    const today = new Date();
    const defaultStart = new Date(today.getTime() - 31 * 24 * 60 * 60 * 1000);
    const periodStart = ref(defaultStart.toISOString().slice(0, 10));
    const periodEnd = ref(today.toISOString().slice(0, 10));
    const preview = ref<{ columns: string[]; rows: string[][] } | null>(null);

    const runFilters = ref<FilterValues>({});
    const runPageSize = ref(20);
    const runRefreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const selectedRun = ref<ReconciliationRunDetail | null>(null);
    const detailLoading = ref(false);

    const filterDefinitions = computed<TableFilter[]>(() => [
        { key: "search", label: "File name", type: "text", query: "search", placeholder: "Statement file name" },
        {
            key: "state",
            label: "State",
            type: "data-autocomplete",
            options: [
                { title: t("Completed"), value: "COMPLETED", tone: "success" },
                { title: t("Processing"), value: "PROCESSING", tone: "warning" },
            ],
        },
        {
            key: "sourceId",
            label: "Statement source",
            type: "data-autocomplete",
            options: sources.value.map((source) => ({ title: source.name, value: source.id })),
        },
        { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
    ]);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.reconciliationSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as ReconciliationSummary;
        } catch {
            summary.value = null;
        }
    };

    const loadSources = async () => {
        const response = await api.get(urlsMap.reconciliationSources, { params: { pageSize: 100 } });
        const payload = response.data?.data ?? response.data ?? {};
        sources.value = payload.sources ?? payload.rows ?? [];
    };

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            await Promise.all([loadSources(), loadSummary()]);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const onFileChanged = async (value: File | File[] | null) => {
        file.value = Array.isArray(value) ? (value[0] ?? null) : value;
        preview.value = null;
        if (!file.value) return;
        const source = sources.value.find((entry) => entry.id === selectedSourceId.value);
        if (source?.format?.toUpperCase().includes("CSV") || file.value.name.toLowerCase().endsWith(".csv")) {
            try {
                const text = await file.value.text();
                preview.value = parseCsvPreview(text, source?.delimiter || ",");
            } catch {
                preview.value = null;
            }
        }
    };

    const upload = async () => {
        if (!file.value || !selectedSourceId.value) {
            showSnackBar({ type: "warning", message: t("Choose a statement source and a file") });
            return;
        }
        if (!periodStart.value || !periodEnd.value) {
            showSnackBar({ type: "warning", message: t("Choose the statement period") });
            return;
        }
        uploadLoading.value = true;
        try {
            const body = new FormData();
            body.append("statement", file.value);
            body.append("sourceId", selectedSourceId.value);
            body.append("periodStart", periodStart.value);
            body.append("periodEnd", periodEnd.value);
            const response = await api.post(urlsMap.reconciliationUpload, body, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            const payload = response.data?.data ?? response.data ?? {};
            showSnackBar({
                type: "success",
                message: payload.idempotent
                    ? t("This statement was already uploaded")
                    : `${t("Statement queued")} · ${String(payload.runId ?? "").slice(0, 8)}`,
            });
            file.value = null;
            preview.value = null;
            runRefreshHook.value?.reset();
            void loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            uploadLoading.value = false;
        }
    };

    const onFiltersChanged = (key: string, value: unknown) => {
        runFilters.value = { ...runFilters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => runRefreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        runFilters.value = {};
        runRefreshHook.value?.reset();
    };

    const openRun = async (row: ReconciliationRun) => {
        selectedRun.value = { ...row, items: [] };
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.reconciliationRunDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selectedRun.value = (payload.run ?? payload) as ReconciliationRunDetail;
        } catch (e) {
            detailsOpen.value = false;
            selectedRun.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            detailLoading.value = false;
        }
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Statement sources"), value: String(data.sources), tone: "info" as const },
            { label: t("Runs in 30d"), value: String(data.runs), tone: "neutral" as const },
            { label: t("Processing"), value: String(data.processingRuns), tone: data.processingRuns > 0 ? "warning" as const : "success" as const },
            { label: t("Matched rows"), value: formatPlainNumber(data.matchedRows), tone: "success" as const },
            { label: t("Mismatch rows"), value: formatPlainNumber(data.mismatchedRows), tone: data.mismatchedRows > 0 ? "error" as const : "success" as const },
            { label: t("Match rate"), value: `${formatPlainNumber(Number(data.matchRate))}%`, tone: Number(data.matchRate) >= 99 ? "success" as const : "warning" as const },
        ];
    });

    const sourceHeaders = computed<TableHeader<StatementSource>[]>(() => [
        {
            key: "name",
            label: "Source",
            value: (row) => row.name,
            Value: ({ row }: { row: StatementSource }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.name}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.gatewayCode} · {row.type}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "format", label: "Format", value: (row) => row.format },
        { key: "delimiter", label: "Delimiter", value: (row) => row.delimiter },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        { key: "lag", label: "Settlement lag", value: (row) => `${row.settlementLagDays}d` },
        { key: "schedule", label: "Schedule", value: (row) => row.scheduleCron || "—" },
        {
            key: "mapping",
            label: "Mapped columns",
            value: (row) => String(Object.keys(row.columnMapping ?? {}).length),
            Value: ({ row }: { row: StatementSource }) => (
                <ThemedText style={{ fontSize: "10px", direction: "ltr", maxWidth: "260px", wordBreak: "break-word" }}>
                    {JSON.stringify(row.columnMapping ?? {})}
                </ThemedText>
            ),
        },
        {
            key: "active",
            label: "Status",
            Value: ({ row }: { row: StatementSource }) => <StatusChip label={row.active ? t("Active") : t("Inactive")} tone={row.active ? "success" : "neutral"} size="small" />,
        },
    ]);

    const runHeaders = computed<TableHeader<ReconciliationRun>[]>(() => [
        {
            key: "fileName",
            label: "Statement file",
            sortKey: "fileName",
            value: (row) => row.fileName,
            Value: ({ row }: { row: ReconciliationRun }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>{row.fileName}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.sourceName}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "state",
            label: "State",
            value: (row) => row.state,
            Value: ({ row }: { row: ReconciliationRun }) => <StatusChip label={row.state} tone={row.state === "COMPLETED" ? "success" : "warning"} size="small" />,
        },
        { key: "total", label: "Rows", value: (row) => String(row.totalRows) },
        { key: "matched", label: "Matched", value: (row) => String(row.matchedRows) },
        { key: "unmatched", label: "Unmatched", value: (row) => String(row.unmatchedRows) },
        {
            key: "matchRate",
            label: "Match rate",
            value: (row) => row.matchRate,
            Value: ({ row }: { row: ReconciliationRun }) => <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{formatPlainNumber(Number(row.matchRate))}%</ThemedText>,
        },
        { key: "mismatch", label: "Mismatch", value: (row) => String(row.amountMismatch) },
        { key: "duplicates", label: "Duplicates", value: (row) => String(row.duplicates) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: ReconciliationRun }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
        { key: "finishedAt", label: "Finished", sortKey: "ingestedAt", value: (row) => row.finishedAt ?? "", Value: ({ row }: { row: ReconciliationRun }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.finishedAt)}</ThemedText> },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: ReconciliationRun }) => <VBtn size="small" variant="tonal" onClick={() => void openRun(row)}>{t("Review")}</VBtn>,
        },
    ]);

    const itemHeaders: TableHeader<ReconciliationItem>[] = [
        { key: "result", label: "Result", Value: ({ row }: { row: ReconciliationItem }) => <StatusChip label={row.result} tone={row.result === "MATCHED" ? "success" : row.result === "DUPLICATE" ? "warning" : "error"} size="x-small" /> },
        { key: "ourReference", label: "Our reference", value: (row) => row.ourReference },
        { key: "providerReference", label: "Provider reference", value: (row) => row.providerReference },
        { key: "batch", label: "Batch", value: (row) => row.batchReference ?? "—" },
        { key: "amount", label: "Statement amount", value: (row) => row.statementAmount },
        { key: "fee", label: "Statement fee", value: (row) => row.statementFee },
    ];

    const resultTone = (result: string) => statusTone(result);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Reconciliation")}
                    end={() => <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { void load(); runRefreshHook.value?.refreshAsIs(); }}>{t("Refresh")}</VBtn>}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        <VAlert type="info" variant="tonal">
                            {t("Statement uploads are queued and matched in the background. A repeated file is idempotent and never creates a second run.")}
                        </VAlert>

                        {summary.value && (
                            <VCard variant="flat" style={{ borderRadius: "16px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Reconciliation health")}</ThemedText>
                                    <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                        {summaryItems.value.map((item) => (
                                            <VCard key={item.label} variant="tonal">
                                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                                </VCardText>
                                            </VCard>
                                        ))}
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                        {Object.entries(summary.value.resultCounts ?? {}).map(([result, count]) => (
                                            <StatusChip key={result} label={`${result}: ${count}`} tone={resultTone(result)} size="x-small" />
                                        ))}
                                    </ThemedView>
                                </VCardText>
                            </VCard>
                        )}

                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                <ThemedText type="defaultSemiBold">{t("Upload a statement")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "flex-start" }}>
                                    <VSelect
                                        items={sources.value.map((source) => ({ title: source.name, value: source.id }))}
                                        modelValue={selectedSourceId.value}
                                        onUpdate:modelValue={(value: string | null) => {
                                            selectedSourceId.value = value;
                                            preview.value = null;
                                        }}
                                        label={t("Statement source")}
                                        style={{ minWidth: "220px" }}
                                    />
                                    <VTextField type="date" label={t("Period start")} modelValue={periodStart.value} onUpdate:modelValue={(value: string) => (periodStart.value = value)} style={{ minWidth: "170px" }} />
                                    <VTextField type="date" label={t("Period end")} modelValue={periodEnd.value} onUpdate:modelValue={(value: string) => (periodEnd.value = value)} style={{ minWidth: "170px" }} />
                                    <VFileInput label={t("Statement file")} modelValue={file.value} onUpdate:modelValue={(value: File | File[] | null) => void onFileChanged(value)} style={{ minWidth: "260px" }} />
                                    <VBtn color="primary" loading={uploadLoading.value} disabled={!selectedSourceId.value || !file.value} onClick={() => void upload()}>{t("Upload")}</VBtn>
                                </ThemedView>
                            </VCardText>
                        </VCard>

                        {preview.value && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold">{t("File preview")}</ThemedText>
                                    <div style={{ overflowX: "auto" }}>
                                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", direction: "ltr" }}>
                                            <thead>
                                                <tr>
                                                    {preview.value.columns.map((column) => (
                                                        <th key={column} style={{ border: "1px solid rgba(100,116,139,0.3)", padding: "6px 10px", textAlign: "left" }}>{column}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {preview.value.rows.map((row, index) => (
                                                    <tr key={index}>
                                                        {row.map((cell, cellIndex) => (
                                                            <td key={cellIndex} style={{ border: "1px solid rgba(100,116,139,0.2)", padding: "6px 10px" }}>{cell}</td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </VCardText>
                            </VCard>
                        )}

                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Statement sources")}</ThemedText>
                            <StatusChip label={String(sources.value.length)} tone="neutral" size="x-small" />
                        </ThemedView>
                        <DataTable
                            title={t("Statement sources")}
                            data={sources.value}
                            headers={sourceHeaders.value}
                            loading={loading.value}
                            showNumber={true}
                            xlsx={false}
                            noElevation={false}
                        />

                        <ApiTable<ReconciliationRun>
                            title={t("Reconciliation runs")}
                            url={urlsMap.reconciliationRuns}
                            localSearch={false}
                            xlsx={false}
                            showNumber={true}
                            numberOfItemsPerPage={runPageSize.value}
                            numberOfItemsPerPageChoices={[
                                { label: "10", value: 10 },
                                { label: "20", value: 20 },
                                { label: "50", value: 50 },
                            ]}
                            setNumberOfItemsPerPage={(value) => (runPageSize.value = value)}
                            headers={runHeaders.value}
                            apiDataExtractor={(data) => {
                                const payload = data as { runs?: ReconciliationRun[]; rows?: ReconciliationRun[] };
                                return payload.runs ?? payload.rows ?? [];
                            }}
                            apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                            onData={(nextRows, nextTotal) => {
                                runs.value = nextRows;
                                runTotal.value = nextTotal;
                            }}
                            setRefreshHook={(hook) => {
                                runRefreshHook.value = hook as typeof runRefreshHook.value;
                            }}
                            clearRefreshHook={() => {
                                runRefreshHook.value = null;
                            }}
                            onRefresh={(table, refresh) => {
                                void refresh({
                                    queryParams: {
                                        page: table.page,
                                        pageSize: runPageSize.value,
                                        ...buildFilterQuery(filterDefinitions.value, runFilters.value),
                                        ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                                    },
                                });
                            }}
                            TopSlot={() => (
                                <TableFilters
                                    filters={filterDefinitions.value}
                                    values={runFilters.value}
                                    total={runTotal.value}
                                    onChange={onFiltersChanged}
                                    onClear={onFiltersCleared}
                                />
                            )}
                        />
                    </>
                )}
            </ThemedView>

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="1100px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selectedRun.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading reconciliation run")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selectedRun.value.fileName}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selectedRun.value.sourceName}</ThemedText>
                                    </ThemedView>
                                    <StatusChip label={selectedRun.value.state} tone={selectedRun.value.state === "COMPLETED" ? "success" : "warning"} />
                                </ThemedView>

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                    {[
                                        [t("Rows"), selectedRun.value.totalRows],
                                        [t("Matched"), selectedRun.value.matchedRows],
                                        [t("Unmatched"), selectedRun.value.unmatchedRows],
                                        [t("Amount mismatch"), selectedRun.value.amountMismatch],
                                        [t("Missing at gateway"), selectedRun.value.missingAtGateway],
                                        [t("Missing locally"), selectedRun.value.missingLocally],
                                        [t("Duplicates"), selectedRun.value.duplicates],
                                        [t("Fee variances"), selectedRun.value.feeVariances],
                                        [t("Match rate"), `${formatPlainNumber(Number(selectedRun.value.matchRate))}%`],
                                    ].map(([label, value]) => (
                                        <VCard key={String(label)} variant="tonal">
                                            <VCardText style={{ padding: "10px" }}>
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{label}</ThemedText>
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{String(value)}</ThemedText>
                                            </VCardText>
                                        </VCard>
                                    ))}
                                </ThemedView>

                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                    {t("Created")} {formatDateTime(selectedRun.value.createdAt)} · {t("Finished")} {formatDateTime(selectedRun.value.finishedAt)}
                                </ThemedText>

                                <DataTable
                                    title={t("Statement items")}
                                    data={selectedRun.value.items}
                                    headers={itemHeaders}
                                    showNumber={true}
                                    xlsx={false}
                                    noElevation={true}
                                />

                                <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                                    <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                </ThemedView>
                            </>
                        )}
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default ReconciliationPage;
