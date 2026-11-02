import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VProgressCircular, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

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

const resultTone = (result: string) => statusTone(result);

const AmlScreeningsPage = dc(() => {
    const { t } = useLocale();
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
    const selected = ref<ScreeningDetail | null>(null);
    const detailLoading = ref(false);
    const selectedMatchId = ref("");
    const disposition = ref("FALSE_POSITIVE");
    const dispositionChecklist = ref<Record<string, boolean>>({});
    const note = ref("");
    const actionLoading = ref(false);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);

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

    const exportCsv = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlScreeningsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
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
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `aml-screenings-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
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

    const openDetails = async (row: Screening) => {
        selected.value = { ...row, matches: [], amlCases: [], canDisposition: false };
        selectedMatchId.value = row.matchId ?? "";
        disposition.value = "FALSE_POSITIVE";
        dispositionChecklist.value = {};
        note.value = "";
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlScreeningDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.screening ?? payload) as ScreeningDetail;
            selectedMatchId.value = selected.value.matches.find((match) => match.disposition === "UNREVIEWED")?.id ?? "";
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const dispositionChecklistComplete = computed(() => DISPOSITION_CHECKS.every((check) => dispositionChecklist.value[check.key] === true));

    const submitDisposition = async () => {
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
        actionLoading.value = true;
        try {
            await api.post(urlsMap.amlMatchDisposition(selectedMatchId.value), {
                disposition: disposition.value,
                notes: note.value.trim(),
                checklist: DISPOSITION_CHECKS.filter((check) => dispositionChecklist.value[check.key]).map((check) => check.key),
            });
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
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlScreeningsSummaryExport);
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
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `aml-screening-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("AML screening summary exported") });
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
            { label: t("Screenings"), value: String(data.total), tone: "info" as const },
            { label: t("Last 24h"), value: String(data.screened24h), tone: "neutral" as const },
            { label: t("Unresolved matches"), value: String(data.unresolvedMatches), tone: data.unresolvedMatches > 0 ? "warning" as const : "success" as const },
            { label: t("Potential matches"), value: String(data.byResult?.POTENTIAL_MATCH ?? 0), tone: (data.byResult?.POTENTIAL_MATCH ?? 0) > 0 ? "warning" as const : "success" as const },
            { label: t("Confirmed matches"), value: String(data.byResult?.CONFIRMED_MATCH ?? 0), tone: (data.byResult?.CONFIRMED_MATCH ?? 0) > 0 ? "error" as const : "success" as const },
            { label: t("Provider errors"), value: String(data.byResult?.ERROR ?? 0), tone: (data.byResult?.ERROR ?? 0) > 0 ? "error" as const : "success" as const },
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
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.subjectType} · {row.subjectReference}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "result",
            label: "Result",
            value: (row) => row.result,
            Value: ({ row }: { row: Screening }) => <StatusChip label={row.result} tone={resultTone(row.result)} size="small" />,
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
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.providerRequestRef || ""}</ThemedText>
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
            Value: ({ row }: { row: Screening }) => <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>,
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Screenings")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportCsv()}>{t("Export CSV")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="error" variant="tonal">
                    {t("AML-CONFIDENTIAL · Screening results and matches are restricted to Compliance, MLRO and authorised AML reviewers.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Screening health")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                            </ThemedView>
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
                                {Object.entries(summary.value.byResult ?? {}).map(([result, count]) => (
                                    <StatusChip key={result} label={`${result}: ${count}`} tone={resultTone(result)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
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
                    rowColor={(row) => (row.result === "CONFIRMED_MATCH" ? "#dc2626" : row.result === "POTENTIAL_MATCH" ? "#d97706" : row.result === "ERROR" ? "#dc2626" : undefined)}
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
            </ThemedView>

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="1080px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading screening")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selected.value.subjectName}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.subjectType} · {selected.value.subjectReference}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={selected.value.result} tone={resultTone(selected.value.result)} />
                                        <StatusChip label={`${selected.value.matchCount} ${t("matches")}`} tone="neutral" size="small" />
                                    </ThemedView>
                                </ThemedView>

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Screening context")}</ThemedText>
                                            {[
                                                [t("Provider"), selected.value.provider],
                                                [t("Provider reference"), selected.value.providerRequestRef || "—"],
                                                [t("Trigger"), selected.value.trigger],
                                                [t("Merchant"), selected.value.merchantName || "—"],
                                                [t("Score"), selected.value.score || "—"],
                                                [t("Requested"), formatDateTime(selected.value.requestedAt)],
                                                [t("Completed"), formatDateTime(selected.value.completedAt)],
                                                [t("List versions"), JSON.stringify(selected.value.lists ?? {})],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </VCardText>
                                    </VCard>

                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Related AML cases")}</ThemedText>
                                            {selected.value.amlCases.length === 0 && <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("No AML case linked")}</ThemedText>}
                                            {selected.value.amlCases.map((entry) => (
                                                <ThemedView key={entry.id} style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                    <StatusChip label={entry.severity} tone={statusTone(entry.severity)} size="x-small" />
                                                    <StatusChip label={entry.status} tone={statusTone(entry.status)} size="x-small" />
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{formatDateTime(entry.createdAt)}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                <VCard variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Matches")}</ThemedText>
                                        {selected.value.matches.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No matches returned")}</ThemedText>}
                                        {selected.value.matches.map((match) => (
                                            <ThemedView key={match.id} style={{ gap: "4px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "7px" }}>
                                                <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                    <StatusChip label={match.disposition} tone={match.disposition === "TRUE_MATCH" ? "error" : match.disposition === "UNREVIEWED" ? "warning" : "success"} size="x-small" />
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{match.matchedName}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{match.listType} · {match.listName} · {match.score}</ThemedText>
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{match.listEntryRef}</ThemedText>
                                                {match.dispositionNotes && <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{match.dispositionNotes}</ThemedText>}
                                                {match.dispositionBy && <ThemedText style={{ fontSize: "10px", opacity: 0.5, direction: "ltr" }}>{match.dispositionBy}</ThemedText>}
                                            </ThemedView>
                                        ))}
                                    </VCardText>
                                </VCard>

                                {unresolvedMatches.value.length > 0 ? (
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Disposition an unresolved match")}</ThemedText>
                                            <VSelect
                                                items={unresolvedMatches.value.map((match) => ({ title: `${match.matchedName} · ${match.listType} · ${match.score}`, value: match.id }))}
                                                modelValue={selectedMatchId.value}
                                                onUpdate:modelValue={(value: string) => (selectedMatchId.value = value)}
                                                label={t("Unresolved match")}
                                            />
                                            <VSelect
                                                items={DISPOSITIONS}
                                                modelValue={disposition.value}
                                                onUpdate:modelValue={(value: string) => (disposition.value = value)}
                                                label={t("Disposition")}
                                            />
                                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Disposition checklist")}</ThemedText>
                                                {DISPOSITION_CHECKS.map((check) => (
                                                    <VCheckbox
                                                        key={check.key}
                                                        modelValue={dispositionChecklist.value[check.key] === true}
                                                        onUpdate:modelValue={(value: unknown) => (dispositionChecklist.value = { ...dispositionChecklist.value, [check.key]: Boolean(value) })}
                                                        label={t(check.label)}
                                                        density="compact"
                                                        hideDetails
                                                    />
                                                ))}
                                                {!dispositionChecklistComplete.value && (
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all disposition checklist items before saving")}</ThemedText>
                                                )}
                                            </ThemedView>
                                            <VTextarea
                                                modelValue={note.value}
                                                onUpdate:modelValue={(value: string) => (note.value = value)}
                                                label={t("Disposition notes")}
                                                hint={t("Required. Explain why the match is false, true or escalated.")}
                                                persistentHint
                                                rows={3}
                                            />
                                            <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                                <VBtn color="primary" loading={actionLoading.value} disabled={!dispositionChecklistComplete.value} onClick={() => void submitDisposition()}>{t("Save disposition")}</VBtn>
                                                <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                ) : (
                                    <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                        <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                    </ThemedView>
                                )}
                            </>
                        )}
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AmlScreeningsPage;
