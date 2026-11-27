import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { areChecklistsVisible } from "@/constants/env";
import {PgAlert, PgButton, PgSpinner, PgAutocomplete, PgTextarea, PgStack} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {statusTone} from "@pg/ui";
import {ApiTable} from "@pg/ui";
import {TableRowActions} from "@pg/ui";
import {TableFilters} from "@pg/ui";
import {buildFilterQuery, type FilterValues} from "@pg/ui";
import { tableRegistry } from "@/tables/tableRegistry";
import type { TableHeader } from "@pg/ui";
import { api } from "@/state/api";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import type { MetricItem } from "@pg/ui";
import {SlideOverDrawer} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {DescriptionList} from "@pg/ui";
import {MetaPill} from "@pg/ui";
import { listVersionChips } from "./listVersions";
import {EmptyState} from "@pg/ui";
import {StatusBadge, type BadgeTone} from "@pg/ui";
import {SectionFields} from "@pg/ui";
type Screening = {
    id: string;
    subjectType: string;
    subjectId: string;
    subjectName: string;
    subjectReference: string;
    merchantName: string;
    provider: string;
    providerRequestRef: string | null;
    trigger: string;
    lists: unknown;
    result: string;
    score: string | null;
    matchCount: number;
    matchId: string | null;
    disposition: string | null;
    dispositionSummary: { unreviewed: number; falsePositive: number; trueMatch: number; escalated: number };
    requestedAt: string;
    screenedAt: string;
    completedAt: string | null;
    ageHours: number;
};
type ScreeningMatch = {
    id: string;
    listType: string;
    listName: string;
    listEntryRef: string;
    matchedName: string;
    score: string;
    attributes: Record<string, unknown>;
    disposition: string;
    dispositionBy: string | null;
    dispositionNotes: string | null;
    suppressFuture: boolean;
    suppressUntil: string | null;
    createdAt: string;
};
type ScreeningDetail = Screening & {
    matches: ScreeningMatch[];
    amlCases: Array<{ id: string; status: string; severity: string; createdAt: string }>;
    canDisposition: boolean;
};
type ScreeningSummary = {
    total: number;
    screened24h: number;
    unresolvedMatches: number;
    byResult: Record<string, number>;
    byTrigger: Record<string, number>;
    latestScreenedAt: string | null;
};
const SUMMARY_EXPORT_CHECKS = [
    { key: "SCREENING_SCOPE_VERIFIED", label: "Screening scope verified" },
    { key: "RESULT_TRIGGER_REVIEWED", label: "Result and trigger breakdown reviewed" },
    { key: "UNRESOLVED_MATCH_REVIEWED", label: "Unresolved matches reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const SCREENING_EXPORT_CHECKS = [
    { key: "SCREENING_SCOPE_VERIFIED", label: "Screening scope verified" },
    { key: "MATCH_DATA_REVIEWED", label: "Confidential match data reviewed" },
    { key: "EXPORT_AUTHORITY_CONFIRMED", label: "Export authority confirmed" },
] as const;

const DISPOSITION_CHECKS = [
    { key: "MATCH_DETAILS_REVIEWED", label: "Match details reviewed" },
    { key: "IDENTITY_EVIDENCE_CHECKED", label: "Identity evidence checked" },
    { key: "DISPOSITION_RATIONALE_DOCUMENTED", label: "Disposition rationale documented" },
    { key: "ESCALATION_PATH_CONFIRMED", label: "Escalation path confirmed" },
] as const;
const DISPOSITIONS = [
    { title: "False positive", value: "FALSE_POSITIVE" },
    { title: "True match", value: "TRUE_MATCH" },
    { title: "Escalated", value: "ESCALATED" },
];
const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};
const badgeTone = (value: string): BadgeTone => {
    const tone = statusTone(value);
    return tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
};
const resultTone = (result: string) => badgeTone(result);
const AmlScreeningsPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const rows = ref<Screening[]>([]);
    const total = ref(0);
    const summary = ref<ScreeningSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;
    const detailsOpen = ref(false);
    const dispositionOpen = ref(false);
    const actionError = ref("");
    const selected = ref<ScreeningDetail | null>(null);
    const detailLoading = ref(false);
    const selectedMatchId = ref("");
    const disposition = ref("FALSE_POSITIVE");
    const dispositionChecklist = ref<Record<string, boolean>>({});
    const note = ref("");
    const actionLoading = ref(false);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const listExportOpen = ref(false);
    const listExportChecklist = ref<Record<string, boolean>>({});
    const listExportChecklistComplete = computed(() => !showChecklists || SCREENING_EXPORT_CHECKS.every((check) => listExportChecklist.value[check.key] === true));
    const filterDefinitions = computed(() => tableRegistry.AmlScreenings?.filters ?? []);
    const unresolvedMatches = computed(() => selected.value?.matches.filter((match) => match.disposition === "UNREVIEWED") ?? []);
    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.amlScreeningsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as ScreeningSummary;
        } catch {
            summary.value = null;
        }
    };
    void loadSummary();
    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };
    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };
    const exportExcel = async () => {
        if (exportLoading.value) return;
        if (!listExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlScreeningsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                    checklist: SCREENING_EXPORT_CHECKS.filter((check) => listExportChecklist.value[check.key]).map((check) => check.key).join(","),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.screenings ?? []) as Screening[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No AML screenings match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "subjectType", "subjectName", "merchantName", "provider", "providerRequestRef", "trigger", "result", "score", "matchCount", "unreviewed", "falsePositive", "trueMatch", "escalated", "requestedAt", "ageHours"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.subjectType,
                        row.subjectName,
                        row.merchantName,
                        row.provider,
                        row.providerRequestRef ?? "",
                        row.trigger,
                        row.result,
                        row.score ?? "",
                        row.matchCount,
                        row.dispositionSummary.unreviewed,
                        row.dispositionSummary.falsePositive,
                        row.dispositionSummary.trueMatch,
                        row.dispositionSummary.escalated,
                        row.requestedAt,
                        row.ageHours,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-screenings-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            listExportOpen.value = false;
            listExportChecklist.value = {};
            showSnackBar({
                type: payload.truncated ? "warning" : "success",
                message: payload.truncated
                    ? `${t("Exported")} ${rowsData.length} / ${payload.total}`
                    : `${t("Exported")} ${rowsData.length}`,
            });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            exportLoading.value = false;
        }
    };
    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };
    const resetDispositionState = () => {
        disposition.value = "FALSE_POSITIVE";
        dispositionChecklist.value = {};
        note.value = "";
        dispositionOpen.value = false;
        actionError.value = "";
    };

    const presentScreeningDetail = (detail: ScreeningDetail) => {
        selected.value = detail;
        selectedMatchId.value = detail.matches.find((match) => match.disposition === "UNREVIEWED")?.id ?? "";
        resetDispositionState();
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchAmlScreeningDetail = async (id: string): Promise<ScreeningDetail | null> => {
        const response = await api.get(urlsMap.amlScreeningDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.screening ?? payload) as ScreeningDetail;
    };

    const openDetails = async (row: Screening) => {
        selected.value = { ...row, matches: [], amlCases: [], canDisposition: false };
        selectedMatchId.value = row.matchId ?? "";
        resetDispositionState();
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchAmlScreeningDetail(row.id);
            if (detail) presentScreeningDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<ScreeningDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchAmlScreeningDetail,
        onOpenRecord: presentScreeningDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("AML screening not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };
    const dispositionChecklistComplete = computed(() => !showChecklists || DISPOSITION_CHECKS.every((check) => dispositionChecklist.value[check.key] === true));
    const dispositionSafeguard = useSafeguard("sg-aml-disposition");
    const submitDisposition = async () => {
        actionError.value = "";
        if (!selectedMatchId.value) {
            showSnackBar({ type: "warning", message: t("Select an unresolved match") });
            return;
        }
        if (note.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("Disposition notes are required") });
            return;
        }
        if (!dispositionChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all disposition checklist items before saving") });
            return;
        }
        if (!(await dispositionSafeguard.confirm())) return;
        actionLoading.value = true;
        try {
            await api.post(urlsMap.amlMatchDisposition(selectedMatchId.value), {
                disposition: disposition.value,
                notes: note.value.trim(),
                checklist: DISPOSITION_CHECKS.filter((check) => dispositionChecklist.value[check.key]).map((check) => check.key),
            });
            dispositionOpen.value = false;
            showSnackBar({ type: "success", message: t("Disposition saved") });
            if (selected.value) {
                const response = await api.get(urlsMap.amlScreeningDetail(selected.value.id));
                const payload = response.data?.data ?? response.data ?? {};
                selected.value = (payload.screening ?? payload) as ScreeningDetail;
                selectedMatchId.value = selected.value.matches.find((match) => match.disposition === "UNREVIEWED")?.id ?? "";
                note.value = "";
            }
            refreshAll();
        } catch (error) {
            actionError.value = extractApiErrorMessage(error);
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
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
            const response = await api.get(urlsMap.amlScreeningsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as ScreeningSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["screened_24h", snapshot.screened24h],
                ["unresolved_matches", snapshot.unresolvedMatches],
                ["latest_screened_at", snapshot.latestScreenedAt ?? ""],
            ];
            for (const [result, count] of Object.entries(snapshot.byResult ?? {})) rows.push([`result.${result}.count`, count]);
            for (const [trigger, count] of Object.entries(snapshot.byTrigger ?? {})) rows.push([`trigger.${trigger}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-screening-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("AML screening summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };
    const summaryMetrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "screenings", label: t("Screenings"), value: String(data.total) },
            { key: "screened24h", label: t("Last 24h"), value: String(data.screened24h) },
            { key: "unresolved", label: t("Unresolved matches"), value: String(data.unresolvedMatches), badge: data.unresolvedMatches > 0 ? t("Pending") : t("Clear"), badgeTone: data.unresolvedMatches > 0 ? "warning" : "success" },
            { key: "potential", label: t("Potential matches"), value: String(data.byResult?.POTENTIAL_MATCH ?? 0), badge: (data.byResult?.POTENTIAL_MATCH ?? 0) > 0 ? t("High") : t("Clear"), badgeTone: (data.byResult?.POTENTIAL_MATCH ?? 0) > 0 ? "warning" : "success" },
            { key: "confirmed", label: t("Confirmed matches"), value: String(data.byResult?.CONFIRMED_MATCH ?? 0), subLabel: `${data.byResult?.ERROR ?? 0} ${t("Provider errors")}`, badge: (data.byResult?.CONFIRMED_MATCH ?? 0) > 0 ? t("Critical") : t("Clear"), badgeTone: (data.byResult?.CONFIRMED_MATCH ?? 0) > 0 ? "danger" : "success" },
        ];
    });
    const headers = computed<TableHeader<Screening>[]>(() => [
        {
            key: "subject",
            label: "Subject",
            value: (row) => row.subjectName,
            Value: ({ row }: { row: Screening }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.subjectName || "—"}</ThemedText>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.subjectType}</ThemedText>
                        <MonoRef value={row.subjectReference} />
                    </ThemedView>
                </ThemedView>
            ),
        },
        {
            key: "result",
            label: "Result",
            value: (row) => row.result,
            Value: ({ row }: { row: Screening }) => <StatusBadge status={row.result} toneOverride={resultTone(row.result)} />,
        },
        {
            key: "score",
            label: "Score",
            sortKey: "score",
            value: (row) => row.score ?? "",
            Value: ({ row }: { row: Screening }) => <ThemedText style={{ fontSize: "12px" }}>{row.score ?? "—"}</ThemedText>,
        },
        {
            key: "matches",
            label: "Matches",
            value: (row) => String(row.matchCount),
            Value: ({ row }: { row: Screening }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.matchCount}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.dispositionSummary.unreviewed} {t("unreviewed")}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "trigger",
            label: "Trigger",
            value: (row) => row.trigger,
        },
        {
            key: "provider",
            label: "Provider",
            value: (row) => row.provider,
            Value: ({ row }: { row: Screening }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.provider}</ThemedText>
                    <MonoRef value={row.providerRequestRef ?? ""} />
                </ThemedView>
            ),
        },
        {
            key: "screenedAt",
            label: "Screened",
            value: (row) => row.screenedAt,
            Value: ({ row }: { row: Screening }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.screenedAt)}</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: Screening }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Review"),
                        icon: "mdi-shield-search",
                        onClick: () => void openDetails(row),
                    }}
                />
            ),
        },
    ]);
    return () => (
        <ScreenContainer>
            <PgStack gap="lg">
                <PageHeader title={t("AML Screenings")} subtitle={t("Review sanctions and PEP screening results and disposition unresolved matches.")} badge="AML-CONFIDENTIAL" badgeTone="danger">
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <PgButton variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</PgButton>
                            <PgButton variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => { listExportChecklist.value = {}; listExportOpen.value = true; }}>{t("Export Excel")}</PgButton>
                        </ThemedView>
                </PageHeader>
                <PgAlert tone="danger">
                    {t("AML-CONFIDENTIAL · Screening results and matches are restricted to Compliance, MLRO and authorised AML reviewers.")}
                </PgAlert>
                {summary.value && (
                    <SummaryExportCard
                        title={t("Screening health")}
                        metrics={summaryMetrics.value}
                        exportLoading={summaryExportLoading.value}
                        exportLabel={t("Export summary")}
                        exportDisabled={!summaryExportChecklistComplete.value}
                        onExport={() => void exportSummary()}
                    >
                        <FormChecklist
                            checks={[...SUMMARY_EXPORT_CHECKS]}
                            modelValue={summaryExportChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (summaryExportChecklist.value = value)}
                            show={showChecklists}
                            title={t("Summary export checklist")}
                            complete={summaryExportChecklistComplete.value}
                            incompleteMessage={t("Complete all summary export checklist items before exporting")}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byResult ?? {}).map(([result, count]) => (
                                <StatusBadge key={result} status={result} label={`${result}: ${count}`} toneOverride={resultTone(result)} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}
                <ApiTable<Screening>
                    title={t("AML screening queue")}
                    url={urlsMap.amlScreenings}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "20", value: 20 },
                        { label: "50", value: 50 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    rowColor={(row) => (row.result === "CONFIRMED_MATCH" ? "var(--pg-status-danger-dot)" : row.result === "POTENTIAL_MATCH" ? "var(--pg-status-warning-dot)" : row.result === "ERROR" ? "var(--pg-status-danger-dot)" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { screenings?: Screening[]; rows?: Screening[] };
                        return payload.screenings ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(nextRows, nextTotal) => {
                        rows.value = nextRows;
                        total.value = nextTotal;
                    }}
                    setRefreshHook={(hook) => {
                        refreshHook.value = hook as typeof refreshHook.value;
                    }}
                    clearRefreshHook={() => {
                        refreshHook.value = null;
                    }}
                    onRefresh={(table, refresh) => {
                        void refresh({
                            queryParams: {
                                page: table.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefinitions.value, filters.value),
                                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters
                            filters={filterDefinitions.value}
                            values={filters.value}
                            total={total.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </PgStack>
            <SlideOverDrawer
                modelValue={detailsOpen.value}
                onUpdate:modelValue={(value: boolean) => {
                    detailsOpen.value = value;
                    if (!value) void clearOpenQueryParam();
                }}
                title={selected.value?.subjectName ?? t("AML screening")}
                subtitle={selected.value ? `${selected.value.subjectType} · ${selected.value.subjectReference}` : ""}
                width={640}
                v-slots={{
                    footer: () => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            {unresolvedMatches.value.length > 0 && (
                                <PgButton color="primary" onClick={() => { actionError.value = ""; dispositionOpen.value = true; }}>{t("Disposition an unresolved match")}</PgButton>
                            )}
                            <PgButton variant="text" onClick={closeDetails}>{t("Close")}</PgButton>
                        </ThemedView>
                    ),
                }}
            >
                {detailLoading.value || !selected.value ? (
                    <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                        <PgSpinner indeterminate size={52} color="primary" />
                        <ThemedText style={{ opacity: 0.65 }}>{t("Loading screening")}</ThemedText>
                    </ThemedView>
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.subjectType} · {selected.value.subjectReference}</ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                <StatusBadge status={selected.value.result} toneOverride={resultTone(selected.value.result)} />
                                <StatusBadge status="MATCH_COUNT" label={`${selected.value.matchCount} ${t("matches")}`} toneOverride="neutral" />
                            </ThemedView>
                        </ThemedView>
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px", marginBottom: "16px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Screening context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Provider"), value: selected.value.provider },
                                    { label: t("Provider reference"), value: <MonoRef value={selected.value.providerRequestRef ?? ""} /> },
                                    { label: t("Trigger"), value: selected.value.trigger },
                                    { label: t("Merchant"), value: selected.value.merchantName || "—" },
                                    { label: t("Score"), value: selected.value.score || "—" },
                                    { label: t("Requested"), value: formatDateTime(selected.value.requestedAt) },
                                    { label: t("Completed"), value: formatDateTime(selected.value.completedAt) },
                                    {
                                        label: t("List versions"),
                                        value:
                                            listVersionChips(selected.value.lists).length === 0 ? (
                                                "—"
                                            ) : (
                                                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px", justifyContent: "flex-end" }}>
                                                    {listVersionChips(selected.value.lists).map((chip) => (
                                                        <MetaPill key={chip.list} size="x-small" variant="outlined">
                                                            {chip.version ? `${t(chip.list)} · ${chip.version}` : t(chip.list)}
                                                        </MetaPill>
                                                    ))}
                                                </span>
                                            ),
                                    },
                                ]} />
                            </ThemedView>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Related AML cases")}</ThemedText>
                                {selected.value.amlCases.length === 0 && <EmptyState title={t("No AML case linked")} description={t("No AML case has been linked to this screening.")} />}
                                {selected.value.amlCases.map((entry) => (
                                    <ThemedView key={entry.id} style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusBadge status={entry.severity} toneOverride={badgeTone(entry.severity)} />
                                        <StatusBadge status={entry.status} toneOverride={badgeTone(entry.status)} />
                                        <MonoRef value={entry.id} />
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{formatDateTime(entry.createdAt)}</ThemedText>
                                    </ThemedView>
                                ))}
                            </ThemedView>
                        </ThemedView>
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Matches")}</ThemedText>
                            {selected.value.matches.length === 0 && <EmptyState title={t("No matches returned")} description={t("The screening provider returned no matches.")} />}
                            {selected.value.matches.map((match) => (
                                <ThemedView key={match.id} style={{ gap: "4px", borderBottom: "1px solid var(--pg-border-subtle)", paddingBottom: "7px" }}>
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusBadge status={match.disposition} toneOverride={match.disposition === "TRUE_MATCH" ? "danger" : match.disposition === "UNREVIEWED" ? "warning" : "success"} />
                                        <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{match.matchedName}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{match.listType} · {match.listName} · {match.score}</ThemedText>
                                    </ThemedView>
                                    <MonoRef value={match.listEntryRef} />
                                    {match.dispositionNotes && <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{match.dispositionNotes}</ThemedText>}
                                    {match.dispositionBy && <ThemedText style={{ fontSize: "10px", opacity: 0.5, direction: "ltr" }}>{match.dispositionBy}</ThemedText>}
                                </ThemedView>
                            ))}
                        </ThemedView>
                    </>
                )}
            </SlideOverDrawer>

            <FormModal
                modelValue={listExportOpen.value}
                onUpdate:modelValue={(value: boolean) => (listExportOpen.value = value)}
                title={t("Export AML screenings")}
                size="md"
                loading={exportLoading.value}
                submitLabel={t("Export")}
                onSubmit={() => void exportExcel()}
            >
                <PgAlert tone="danger">
                    {t("AML screening exports contain confidential match data. Confirm scope, handling and authority before exporting.")}
                </PgAlert>
                <FormChecklist
                    checks={[...SCREENING_EXPORT_CHECKS]}
                    modelValue={listExportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (listExportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Screening export checklist")}
                    complete={listExportChecklistComplete.value}
                    incompleteMessage={t("Complete all export checklist items before exporting")}
                />
            </FormModal>
            <FormModal
                modelValue={dispositionOpen.value}
                onUpdate:modelValue={(value: boolean) => (dispositionOpen.value = value)}
                title={t("Disposition an unresolved match")}
                size="md"
                loading={actionLoading.value}
                errorMessage={actionError.value}
                submitLabel={t("Save disposition")}
                cancelLabel={t("Close")}
                onSubmit={() => void submitDisposition()}
            >
                <SectionFields title={t("Disposition details")}>
                    <FormField label={t("Unresolved match")} required sensitiveMakerChecker>
                        <PgAutocomplete
                            items={unresolvedMatches.value.map((match) => ({ title: `${match.matchedName} · ${match.listType} · ${match.score}`, value: match.id }))}
                            modelValue={selectedMatchId.value}
                            onUpdate:modelValue={(value: string) => (selectedMatchId.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Disposition")} required sensitiveMakerChecker>
                        <PgAutocomplete
                            items={DISPOSITIONS}
                            modelValue={disposition.value}
                            onUpdate:modelValue={(value: string) => (disposition.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField
                        label={t("Disposition notes")}
                        hint={t("Required. Explain why the match is false, true or escalated.")}
                        required
                        sensitiveMakerChecker
                    >
                        <PgTextarea
                            modelValue={note.value}
                            onUpdate:modelValue={(value: string) => (note.value = value)}
                            rows={3}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...DISPOSITION_CHECKS]}
                    modelValue={dispositionChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (dispositionChecklist.value = value)}
                    show={showChecklists}
                    title={t("Disposition checklist")}
                    complete={dispositionChecklistComplete.value}
                    incompleteMessage={t("Complete all disposition checklist items before saving")}
                />
            </FormModal>
        </ScreenContainer>
    );
});
export default AmlScreeningsPage;
