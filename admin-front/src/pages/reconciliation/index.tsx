import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VCheckbox,
    VDialog,
    VFileInput,
    VProgressCircular,
    VSelect,
    VSwitch,
    VTextField,
    VTextarea,
} from "vuetify/components";
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
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { formatPlainNumber } from "@/utils/money";

const UPLOAD_CHECKS = [
    { key: "SOURCE_VERIFIED", label: "Statement source verified" },
    { key: "FILE_REVIEWED", label: "Statement file reviewed" },
    { key: "PERIOD_VERIFIED", label: "Statement period verified" },
    { key: "DUPLICATE_CHECK_ACKNOWLEDGED", label: "Duplicate-file behavior acknowledged" },
] as const;

const SUMMARY_EXPORT_CHECKS = [
    { key: "RUN_SCOPE_VERIFIED", label: "Reconciliation run scope verified" },
    { key: "MATCH_RATE_REVIEWED", label: "Match rate reviewed" },
    { key: "RESULT_BREAKDOWN_REVIEWED", label: "Result breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const SOURCE_EDIT_CHECKS = [
    { key: "PARSER_CONFIG_REVIEWED", label: "Parser config reviewed" },
    { key: "SCHEDULE_LAG_VERIFIED", label: "Schedule and settlement lag verified" },
    { key: "DEDUPE_TEMPLATE_REVIEWED", label: "Dedupe template reviewed" },
    { key: "SOURCE_IMPACT_REVIEWED", label: "Source impact reviewed" },
] as const;

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
    operatorCaseId: string | null;
    operatorCase: { id: string; state: string; priority: string } | null;
};

type ReconciliationRunDetail = ReconciliationRun & {
    items: ReconciliationItem[];
    itemResultCounts?: Record<string, number>;
    itemsTotal?: number;
    itemsTruncated?: boolean;
    itemResultFilter?: string | null;
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
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const sources = ref<StatementSource[]>([]);
    const runs = ref<ReconciliationRun[]>([]);
    const runTotal = ref(0);
    const summary = ref<ReconciliationSummary | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const selectedSourceId = ref<string | null>(null);
    const file = ref<File | null>(null);
    const uploadLoading = ref(false);
    const uploadChecklist = ref<Record<string, boolean>>({});
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
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const runResultFilter = ref("ALL");
    const sourceEditOpen = ref(false);
    const sourceSaving = ref(false);
    const sourceError = ref<string | null>(null);
    const editingSource = ref<StatementSource | null>(null);
    const sourceEditChecklist = ref<Record<string, boolean>>({});
    const sourceForm = ref({
        scheduleCron: "",
        settlementLagDays: "0",
        dedupeKeyTemplate: "",
        active: true,
        parserConfig: "{}",
    });
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

    const uploadChecklistComplete = computed(() => !showChecklists || UPLOAD_CHECKS.every((check) => uploadChecklist.value[check.key] === true));

    const upload = async () => {
        if (!file.value || !selectedSourceId.value) {
            showSnackBar({ type: "warning", message: t("Choose a statement source and a file") });
            return;
        }
        if (!periodStart.value || !periodEnd.value) {
            showSnackBar({ type: "warning", message: t("Choose the statement period") });
            return;
        }
        if (!uploadChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all upload checklist items before uploading") });
            return;
        }
        uploadLoading.value = true;
        try {
            const body = new FormData();
            body.append("statement", file.value);
            body.append("sourceId", selectedSourceId.value);
            body.append("periodStart", periodStart.value);
            body.append("periodEnd", periodEnd.value);
            body.append("checklist", JSON.stringify(UPLOAD_CHECKS.filter((check) => uploadChecklist.value[check.key]).map((check) => check.key)));
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

    const exportRunItems = async () => {
        if (!selectedRun.value || exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.reconciliationRunExport(selectedRun.value.id), {
                params: runResultFilter.value === "ALL" ? {} : { result: runResultFilter.value },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const items = (payload.items ?? []) as ReconciliationItem[];
            if (items.length === 0) {
                showSnackBar({ type: "warning", message: t("No items to export for this run.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "ourReference", "providerReference", "batchReference", "statementAmount", "statementFee", "result", "attemptId", "operatorCaseId", "operatorCaseState"];
            const lines = [
                columns.map(escape).join(","),
                ...items.map((item) =>
                    [
                        item.id,
                        item.ourReference,
                        item.providerReference,
                        item.batchReference ?? "",
                        item.statementAmount,
                        item.statementFee,
                        item.result,
                        item.attemptId ?? "",
                        item.operatorCaseId ?? "",
                        item.operatorCase?.state ?? "",
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `reconciliation-${selectedRun.value.id}.xlsx`,
                lines,
            });
            showSnackBar({
                type: payload.truncated ? "warning" : "success",
                message: payload.truncated
                    ? `${t("Exported")} ${items.length} / ${payload.total}`
                    : `${t("Exported")} ${items.length}`,
            });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            exportLoading.value = false;
        }
    };

    const openSourceEdit = (source: StatementSource) => {
        editingSource.value = source;
        sourceForm.value = {
            scheduleCron: source.scheduleCron ?? "",
            settlementLagDays: String(source.settlementLagDays),
            dedupeKeyTemplate: source.dedupeKeyTemplate ?? "",
            active: source.active,
            parserConfig: JSON.stringify(source.parserConfig ?? {}, null, 2),
        };
        sourceError.value = null;
        sourceEditChecklist.value = {};
        sourceEditOpen.value = true;
    };

    const sourceEditChecklistComplete = computed(() => !showChecklists || SOURCE_EDIT_CHECKS.every((check) => sourceEditChecklist.value[check.key] === true));

    const saveSourceEdit = async () => {
        if (!editingSource.value || sourceSaving.value) return;
        let parserConfig: unknown;
        try {
            parserConfig = JSON.parse(sourceForm.value.parserConfig || "{}");
        } catch {
            sourceError.value = t("Parser config must be valid JSON.");
            return;
        }
        if (parserConfig === null || typeof parserConfig !== "object" || Array.isArray(parserConfig)) {
            sourceError.value = t("Parser config must be a JSON object.");
            return;
        }
        const lag = Number(sourceForm.value.settlementLagDays);
        if (!Number.isInteger(lag) || lag < 0 || lag > 365) {
            sourceError.value = t("Settlement lag must be between 0 and 365 days.");
            return;
        }
        if (!sourceEditChecklistComplete.value) {
            sourceError.value = t("Complete all source checklist items before saving.");
            return;
        }
        sourceSaving.value = true;
        sourceError.value = null;
        try {
            await api.patch(urlsMap.reconciliationSourceUpdate(editingSource.value.id), {
                scheduleCron: sourceForm.value.scheduleCron.trim() || null,
                settlementLagDays: lag,
                dedupeKeyTemplate: sourceForm.value.dedupeKeyTemplate.trim() || null,
                active: sourceForm.value.active,
                parserConfig,
            });
            showSnackBar({ type: "success", message: t("Statement source updated") });
            sourceEditOpen.value = false;
            await load();
        } catch (e) {
            sourceError.value = extractApiErrorMessage(e);
        } finally {
            sourceSaving.value = false;
        }
    };

    const loadRunDetail = async (id: string, result: string) => {
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.reconciliationRunDetail(id), {
                params: result === "ALL" ? {} : { result },
            });
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

    const openRun = async (row: ReconciliationRun) => {
        selectedRun.value = { ...row, items: [] };
        runResultFilter.value = "ALL";
        detailsOpen.value = true;
        await loadRunDetail(row.id, "ALL");
    };

    const changeRunResult = async (value: string | null) => {
        const next = value || "ALL";
        runResultFilter.value = next;
        if (selectedRun.value) await loadRunDetail(selectedRun.value.id, next);
    };

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.reconciliationSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = payload as ReconciliationSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["sources", snapshot.sources],
                ["runs", snapshot.runs],
                ["completed_runs", snapshot.completedRuns],
                ["processing_runs", snapshot.processingRuns],
                ["total_rows", snapshot.totalRows],
                ["matched_rows", snapshot.matchedRows],
                ["mismatched_rows", snapshot.mismatchedRows],
                ["match_rate", snapshot.matchRate],
            ];
            for (const [result, count] of Object.entries(snapshot.resultCounts ?? {})) rows.push([`result.${result}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `reconciliation-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Reconciliation summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
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
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: StatementSource }) => (
                <VBtn size="small" variant="text" onClick={() => openSourceEdit(row)}>{t("Edit")}</VBtn>
            ),
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
        {
            key: "case",
            label: "Operator case",
            value: (row) => row.operatorCase?.state ?? (row.operatorCaseId ? "LINKED" : ""),
            Value: ({ row }: { row: ReconciliationItem }) =>
                row.operatorCaseId ? (
                    <VBtn
                        size="x-small"
                        variant="text"
                        prependIcon="mdi-lifebuoy"
                        onClick={() => void router.push({ name: "OperatorCaseDetail", params: { id: row.operatorCaseId ?? "" } })}
                    >
                        {row.operatorCase?.state ?? t("Open case")}
                    </VBtn>
                ) : (
                    <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>—</ThemedText>
                ),
        },
    ];

    const resultTone = (result: string) => statusTone(result);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Reconciliation")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { void load(); runRefreshHook.value?.refreshAsIs(); }}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                        </ThemedView>
                    )}
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
                                        {showChecklists && (
                                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Summary export checklist")}</ThemedText>
                                                {SUMMARY_EXPORT_CHECKS.map((check) => (
                                                    <VCheckbox
                                                        key={check.key}
                                                        modelValue={summaryExportChecklist.value[check.key] === true}
                                                        onUpdate:modelValue={(value: unknown) => (summaryExportChecklist.value = { ...summaryExportChecklist.value, [check.key]: Boolean(value) })}
                                                        label={t(check.label)}
                                                        density="compact"
                                                        hideDetails
                                                    />
                                                ))}
                                                {!summaryExportChecklistComplete.value && (
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all summary export checklist items before exporting")}</ThemedText>
                                                )}
                                            </ThemedView>
                                        )}
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
                                    {showChecklists && (
                                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Upload checklist")}</ThemedText>
                                            {UPLOAD_CHECKS.map((check) => (
                                                <VCheckbox
                                                    key={check.key}
                                                    modelValue={uploadChecklist.value[check.key] === true}
                                                    onUpdate:modelValue={(value: unknown) => (uploadChecklist.value = { ...uploadChecklist.value, [check.key]: Boolean(value) })}
                                                    label={t(check.label)}
                                                    density="compact"
                                                    hideDetails
                                                />
                                            ))}
                                            {!uploadChecklistComplete.value && (
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all upload checklist items before uploading")}</ThemedText>
                                            )}
                                        </ThemedView>
                                    )}
                                    <VBtn color="primary" loading={uploadLoading.value} disabled={!selectedSourceId.value || !file.value || !uploadChecklistComplete.value} onClick={() => void upload()}>{t("Upload")}</VBtn>
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

            <VDialog modelValue={sourceEditOpen.value} onUpdate:modelValue={(value: boolean) => (sourceEditOpen.value = value)} maxWidth="720px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Edit statement source")}</ThemedText>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                            <ThemedText style={{ fontSize: "13px", flex: 1 }}>{editingSource.value?.name}</ThemedText>
                            <VSwitch
                                label={t("Active")}
                                modelValue={sourceForm.value.active}
                                onUpdate:modelValue={(value: boolean | null) => (sourceForm.value.active = !!value)}
                                color="primary"
                                hideDetails
                            />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField label={t("Schedule cron")} modelValue={sourceForm.value.scheduleCron} onUpdate:modelValue={(value: string) => (sourceForm.value.scheduleCron = value)} style={{ flex: "1 1 240px" }} />
                            <VTextField label={t("Settlement lag days")} type="number" modelValue={sourceForm.value.settlementLagDays} onUpdate:modelValue={(value: string) => (sourceForm.value.settlementLagDays = value)} style={{ flex: "1 1 180px" }} />
                        </ThemedView>
                        <VTextField label={t("Dedupe key template")} modelValue={sourceForm.value.dedupeKeyTemplate} onUpdate:modelValue={(value: string) => (sourceForm.value.dedupeKeyTemplate = value)} />
                        <VTextarea
                            label={t("Parser config JSON")}
                            modelValue={sourceForm.value.parserConfig}
                            onUpdate:modelValue={(value: string) => (sourceForm.value.parserConfig = value)}
                            rows={8}
                            style={{ fontFamily: "ui-monospace, monospace", direction: "ltr" }}
                        />
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Source edit checklist")}</ThemedText>
                                {SOURCE_EDIT_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={sourceEditChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (sourceEditChecklist.value = { ...sourceEditChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!sourceEditChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all source checklist items before saving.")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        {sourceError.value && <VAlert type="error" variant="tonal" density="compact">{sourceError.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (sourceEditOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={sourceSaving.value} disabled={!sourceEditChecklistComplete.value} onClick={() => void saveSourceEdit()}>{t("Save")}</VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>

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

                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                    <VSelect
                                        label={t("Filter by result")}
                                        items={[
                                            { title: t("All results"), value: "ALL" },
                                            ...Object.entries(selectedRun.value.itemResultCounts ?? {}).map(([result, count]) => ({
                                                title: `${result.replaceAll("_", " ")} (${count})`,
                                                value: result,
                                            })),
                                        ]}
                                        modelValue={runResultFilter.value}
                                        onUpdate:modelValue={(value: string | null) => void changeRunResult(value)}
                                        style={{ maxWidth: "360px" }}
                                    />
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                        {selectedRun.value.itemsTotal ?? selectedRun.value.items.length} {t("items")}
                                    </ThemedText>
                                </ThemedView>

                                {selectedRun.value.itemsTruncated && (
                                    <VAlert type="info" variant="tonal" density="compact">
                                        {t("Showing the first 200 filtered items. Export includes all matching rows.")}
                                    </VAlert>
                                )}

                                <DataTable
                                    title={t("Statement items")}
                                    data={selectedRun.value.items}
                                    headers={itemHeaders}
                                    showNumber={true}
                                    xlsx={false}
                                    noElevation={true}
                                />

                                <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                                    <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportRunItems()}>{t("Export items")}</VBtn>
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
