import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VProgressCircular, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SectionFields } from "@/components/SectionFields";
type AmlCase = {
    id: string;
    caseRef: string;
    subjectType: string;
    subjectId: string;
    subjectName: string;
    subjectReference: string;
    subjectStatus: string | null;
    merchantName: string;
    severity: string;
    status: string;
    amount: string | null;
    currency: string | null;
    ruleId: string | null;
    ruleCode: string | null;
    ruleName: string | null;
    ruleVersion: number | null;
    screeningId: string | null;
    screeningResult: string | null;
    screeningScore: string | null;
    triggerReason: string;
    severityInputs: Record<string, unknown>;
    holdJournalEntryId: string | null;
    regulatoryReportId: string | null;
    assignedReviewerId: string | null;
    assignedReviewerName: string;
    reviewerNotes: string | null;
    confidential: boolean;
    openedAt: string;
    createdAt: string;
    updatedAt: string;
    slaDueAt: string | null;
    ageHours: number;
    slaOverdue: boolean;
};

type AmlCaseDetail = AmlCase & {
    screening: {
        id: string;
        result: string;
        trigger: string;
        providerCode: string;
        requestedAt: string;
        completedAt: string | null;
        highestScore: string | null;
        matches: Array<{
            id: string;
            listType: string;
            listName: string;
            listEntryRef: string;
            matchedName: string;
            score: string;
            disposition: string;
            dispositionNotes: string | null;
        }>;
    } | null;
    holdJournalEntry: { id: string; refType: string; refId: string; description: string } | null;
    regulatoryReport: { id: string; reportType: string; status: string; submittedAt: string | null } | null;
    approval: {
        id: string;
        state: string;
        makerUserId: string;
        checkerUserId: string | null;
        rejectionReason: string | null;
        createdAt: string;
    } | null;
};

type AmlCaseSummary = {
    totalOpen: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    overdue: number;
    criticalOpen: number;
    frozen: number;
    escalated: number;
    oldestOpenAgeHours: number;
};

type AmlCaseView = "open" | "resolved" | "all";

const SUMMARY_EXPORT_CHECKS = [
    { key: "CASE_SCOPE_VERIFIED", label: "AML case scope verified" },
    { key: "SEVERITY_STATUS_REVIEWED", label: "Severity and status reviewed" },
    { key: "SLA_BREACH_REVIEWED", label: "SLA breach posture reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const AML_CASE_CHECKS = [
    { key: "EVIDENCE_REVIEWED", label: "Evidence reviewed" },
    { key: "SUBJECT_IDENTIFIED", label: "Subject identified and verified" },
    { key: "REGULATORY_OBLIGATION_ASSESSED", label: "Regulatory obligation assessed" },
    { key: "CHECKER_INDEPENDENCE_CONFIRMED", label: "Checker independence confirmed" },
] as const;

const OPEN_STATES = ["OPEN", "IN_REVIEW", "PENDING_CHECKER"];
const RESOLVED_STATES = ["RELEASED", "REJECTED_VOID", "FROZEN", "ESCALATED_STR"];
const RESOLUTIONS = [
    { title: "Release", value: "RELEASE" },
    { title: "Void and return", value: "REJECT" },
    { title: "Freeze", value: "AML_HOLD" },
    { title: "Escalate to STR", value: "REPORT" },
];

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

const formatHours = (hours: number): string => (hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`);

const badgeTone = (value: string): BadgeTone => {
    const tone = statusTone(value);
    return tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
};

const severityTone = (severity: string): BadgeTone => {
    if (severity === "CRITICAL") return "danger";
    if (severity === "HIGH") return "warning";
    if (severity === "MEDIUM") return "info";
    return "neutral";
};

const AmlCasesPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const rows = ref<AmlCase[]>([]);
    const total = ref(0);
    const summary = ref<AmlCaseSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<AmlCaseView>("open");
    const filters = ref<FilterValues>({ status: [...OPEN_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const proposeOpen = ref(false);
    const actionError = ref("");
    const selected = ref<AmlCaseDetail | null>(null);
    const detailLoading = ref(false);
    const resolution = ref("RELEASE");
    const rationale = ref("");
    const caseChecklist = ref<Record<string, boolean>>({});
    const actionLoading = ref(false);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});

    const filterDefinitions = computed(() => tableRegistry.AmlCases?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.amlCasesSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as AmlCaseSummary;
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
        filters.value = activeView.value === "open"
            ? { status: [...OPEN_STATES] }
            : activeView.value === "resolved"
              ? { status: [...RESOLVED_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const setView = (view: AmlCaseView) => {
        activeView.value = view;
        filters.value = view === "open"
            ? { status: [...OPEN_STATES] }
            : view === "resolved"
              ? { status: [...RESOLVED_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlCasesExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.cases ?? []) as AmlCase[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No AML cases match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "caseRef", "subjectType", "subjectName", "merchantName", "severity", "status", "ruleCode", "screeningResult", "assignedReviewerName", "openedAt", "slaDueAt", "ageHours", "slaOverdue"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.caseRef,
                        row.subjectType,
                        row.subjectName,
                        row.merchantName,
                        row.severity,
                        row.status,
                        row.ruleCode ?? "",
                        row.screeningResult ?? "",
                        row.assignedReviewerName,
                        row.openedAt,
                        row.slaDueAt ?? "",
                        row.ageHours,
                        row.slaOverdue,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-cases-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
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

    const resetCaseActionState = () => {
        resolution.value = "RELEASE";
        rationale.value = "";
        caseChecklist.value = {};
        proposeOpen.value = false;
        actionError.value = "";
    };

    const presentCaseDetail = (detail: AmlCaseDetail) => {
        selected.value = detail;
        resetCaseActionState();
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchAmlCaseDetail = async (id: string): Promise<AmlCaseDetail | null> => {
        const response = await api.get(urlsMap.amlCaseDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.case ?? payload) as AmlCaseDetail;
    };

    const openDetails = async (row: AmlCase) => {
        selected.value = {
            ...row,
            screening: null,
            holdJournalEntry: null,
            regulatoryReport: null,
            approval: null,
        };
        resetCaseActionState();
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchAmlCaseDetail(row.id);
            if (detail) presentCaseDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<AmlCaseDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchAmlCaseDetail,
        onOpenRecord: presentCaseDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("AML case not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };

    const canPropose = computed(() => selected.value && ["OPEN", "IN_REVIEW"].includes(selected.value.status));

    const caseChecklistComplete = computed(() => !showChecklists || AML_CASE_CHECKS.every((check) => caseChecklist.value[check.key] === true));
    const caseSafeguard = useSafeguard("sg-aml-propose-resolution");

    const propose = async () => {
        if (!selected.value) return;
        actionError.value = "";
        if (rationale.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("Rationale is required") });
            return;
        }
        if (!caseChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all case checklist items before proposing") });
            return;
        }
        if (!(await caseSafeguard.confirm())) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlCasePropose(selected.value.id), {
                severity: selected.value.severity,
                action: resolution.value,
                reason: rationale.value.trim(),
                checklist: AML_CASE_CHECKS.filter((check) => caseChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            proposeOpen.value = false;
            closeDetails();
            showSnackBar({
                type: "success",
                message: payload.approvalRequestId
                    ? `${t("Resolution proposed")} · ${t("Approval request")} ${String(payload.approvalRequestId).slice(0, 8)}`
                    : t("Resolution proposed"),
            });
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
            const response = await api.get(urlsMap.amlCasesSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as AmlCaseSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total_open", snapshot.totalOpen],
                ["overdue", snapshot.overdue],
                ["critical_open", snapshot.criticalOpen],
                ["frozen", snapshot.frozen],
                ["escalated", snapshot.escalated],
                ["oldest_open_age_hours", snapshot.oldestOpenAgeHours],
            ];
            for (const [state, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${state}.count`, count]);
            for (const [severity, count] of Object.entries(snapshot.bySeverity ?? {})) rows.push([`severity.${severity}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-case-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("AML case summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const summaryMetrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        const severity = data.bySeverity ?? {};
        return [
            { key: "critical", label: t("Critical"), value: String(severity.CRITICAL ?? data.criticalOpen ?? 0), badge: (severity.CRITICAL ?? data.criticalOpen ?? 0) > 0 ? t("Critical") : t("Clear"), badgeTone: (severity.CRITICAL ?? data.criticalOpen ?? 0) > 0 ? "danger" : "success" },
            { key: "high", label: t("High"), value: String(severity.HIGH ?? 0), badge: (severity.HIGH ?? 0) > 0 ? t("High") : t("Clear"), badgeTone: (severity.HIGH ?? 0) > 0 ? "warning" : "success" },
            { key: "medium", label: t("Medium"), value: String(severity.MEDIUM ?? 0) },
            { key: "low", label: t("Low"), value: String(severity.LOW ?? 0) },
            { key: "overdue", label: t("SLA overdue"), value: String(data.overdue), subLabel: `${t("Oldest open")}: ${formatHours(data.oldestOpenAgeHours)}`, badge: data.overdue > 0 ? t("Overdue") : t("Clear"), badgeTone: data.overdue > 0 ? "danger" : "success" },
        ];
    });

    const headers = computed<TableHeader<AmlCase>[]>(() => [
        {
            key: "caseRef",
            label: "Case",
            value: (row) => row.caseRef,
            Value: ({ row }: { row: AmlCase }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.caseRef} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.subjectType}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "subject",
            label: "Subject",
            headerTooltip: "The merchant, payment attempt or beneficial owner under investigation.",
            value: (row) => row.subjectName,
            Value: ({ row }: { row: AmlCase }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.subjectName || "—"}</ThemedText>
                    <MonoRef value={row.subjectReference} />
                </ThemedView>
            ),
        },
        {
            key: "severity",
            label: "Severity",
            sortKey: "severity",
            value: (row) => row.severity,
            Value: ({ row }: { row: AmlCase }) => <StatusBadge status={row.severity} toneOverride={severityTone(row.severity)} />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: AmlCase }) => <StatusBadge status={row.status} toneOverride={badgeTone(row.status)} />,
        },
        {
            key: "rule",
            label: "Rule",
            value: (row) => row.ruleCode ?? "",
            Value: ({ row }: { row: AmlCase }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.ruleCode ?? ""} copyable={false} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.ruleName || ""}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "amount",
            label: "Amount",
            value: (row) => row.amount ?? "",
            Value: ({ row }: { row: AmlCase }) => <MoneyDisplay amount={row.amount} currency={row.currency ?? "LYD"} size="sm" />,
        },
        {
            key: "sla",
            label: "SLA due",
            sortKey: "slaDueAt",
            value: (row) => row.slaDueAt ?? "",
            Value: ({ row }: { row: AmlCase }) => row.slaOverdue
                ? <StatusBadge status="OVERDUE" label={t("Overdue")} toneOverride="danger" />
                : <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.slaDueAt)}</ThemedText>,
        },
        {
            key: "reviewer",
            label: "Reviewer",
            value: (row) => row.assignedReviewerName,
            Value: ({ row }: { row: AmlCase }) => <ThemedText style={{ fontSize: "11px", direction: "ltr", opacity: row.assignedReviewerName ? 1 : 0.55 }}>{row.assignedReviewerName || "—"}</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: AmlCase }) => (
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
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Cases")}
                    subtitle={t("Investigate, disposition, and escalate AML cases under restricted compliance access.")}
                    badge="AML-CONFIDENTIAL"
                    badgeTone="danger"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="error" variant="tonal">
                    {t("AML-CONFIDENTIAL · This queue is restricted to Compliance, MLRO and authorised AML reviewers. Never disclose case details to the merchant or payer.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("AML case health")}
                        metrics={summaryMetrics.value}
                        checks={[...SUMMARY_EXPORT_CHECKS]}
                        checklist={summaryExportChecklist.value}
                        showChecklists={showChecklists}
                        checklistComplete={summaryExportChecklistComplete.value}
                        exportLoading={summaryExportLoading.value}
                        exportDisabled={!summaryExportChecklistComplete.value}
                        exportLabel={t("Export summary")}
                        onExport={() => void exportSummary()}
                    >
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                {`${summary.value.totalOpen} ${t("Open cases")} · ${summary.value.frozen} ${t("Frozen")} · ${summary.value.escalated} ${t("Escalated STR")}`}
                            </ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                {Object.entries(summary.value.byStatus ?? {}).map(([state, count]) => (
                                    <StatusBadge key={state} status={state} label={`${state}: ${count}`} toneOverride={badgeTone(state)} />
                                ))}
                            </ThemedView>
                        </ThemedView>
                    </SummaryExportCard>
                )}

                <SegmentedTabs
                    modelValue={activeView.value}
                    onUpdate:modelValue={(value: string) => setView(value as AmlCaseView)}
                    tabs={[
                        { value: "open", label: t("Open") },
                        { value: "resolved", label: t("Resolved") },
                        { value: "all", label: t("All") },
                    ]}
                />

                <ApiTable<AmlCase>
                    title={t("AML case queue")}
                    url={urlsMap.amlCases}
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
                    rowColor={(row) => (row.slaOverdue || row.severity === "CRITICAL" ? "#dc2626" : row.severity === "HIGH" ? "#d97706" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { cases?: AmlCase[]; rows?: AmlCase[] };
                        return payload.cases ?? payload.rows ?? [];
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

            <SlideOverDrawer
                modelValue={detailsOpen.value}
                onUpdate:modelValue={(value: boolean) => {
                    detailsOpen.value = value;
                    if (!value) void clearOpenQueryParam();
                }}
                title={selected.value?.caseRef ?? t("AML case")}
                subtitle={selected.value ? `${selected.value.subjectName} · ${selected.value.triggerReason}` : ""}
                width={640}
                v-slots={{
                    footer: () => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            {canPropose.value && (
                                <VBtn color="primary" onClick={() => { actionError.value = ""; proposeOpen.value = true; }}>{t("Propose resolution")}</VBtn>
                            )}
                            <VBtn variant="text" onClick={closeDetails}>{t("Close")}</VBtn>
                        </ThemedView>
                    ),
                }}
            >
                {detailLoading.value || !selected.value ? (
                    <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
                        <VProgressCircular indeterminate size={52} color="primary" />
                        <ThemedText style={{ opacity: 0.65 }}>{t("Loading AML case")}</ThemedText>
                    </ThemedView>
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                            <MoneyDisplay amount={selected.value.amount} currency={selected.value.currency ?? "LYD"} colorSign />
                            <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                <StatusBadge status={selected.value.severity} toneOverride={severityTone(selected.value.severity)} />
                                <StatusBadge status={selected.value.status} toneOverride={badgeTone(selected.value.status)} />
                                {selected.value.slaOverdue && <StatusBadge status="OVERDUE" label={t("SLA overdue")} toneOverride="danger" />}
                            </ThemedView>
                        </ThemedView>

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px", marginBottom: "16px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Case context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Subject type"), value: selected.value.subjectType },
                                    { label: t("Subject"), value: selected.value.subjectName },
                                    { label: t("Reference"), value: <MonoRef value={selected.value.subjectReference} /> },
                                    { label: t("Subject status"), value: selected.value.subjectStatus || "—" },
                                    { label: t("Merchant"), value: selected.value.merchantName || "—" },
                                    { label: t("Amount"), value: <MoneyDisplay amount={selected.value.amount} currency={selected.value.currency ?? "LYD"} size="sm" colorSign /> },
                                    { label: t("Rule"), value: selected.value.ruleCode ? <ThemedView style={{ flexDirection: "row", gap: "4px", alignItems: "center", justifyContent: "flex-end" }}><MonoRef value={selected.value.ruleCode} copyable={false} /><ThemedText style={{ fontSize: "11px" }}>{selected.value.ruleName ?? ""}</ThemedText></ThemedView> : "—" },
                                    { label: t("Rule version"), value: selected.value.ruleVersion ?? "—" },
                                    { label: t("Opened"), value: formatDateTime(selected.value.openedAt) },
                                    { label: t("SLA due"), value: formatDateTime(selected.value.slaDueAt) },
                                    { label: t("Reviewer"), value: selected.value.assignedReviewerName || "—" },
                                ]} />
                            </ThemedView>

                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Investigation context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Screening result"), value: selected.value.screening?.result ?? selected.value.screeningResult ?? "—" },
                                    { label: t("Screening score"), value: selected.value.screening?.highestScore ?? selected.value.screeningScore ?? "—" },
                                    { label: t("Screening provider"), value: selected.value.screening?.providerCode ?? "—" },
                                    { label: t("Screening ID"), value: <MonoRef value={selected.value.screening?.id ?? selected.value.screeningId ?? ""} /> },
                                    { label: t("Hold journal"), value: <MonoRef value={selected.value.holdJournalEntryId ?? ""} /> },
                                    { label: t("Regulatory report"), value: selected.value.regulatoryReport ? <ThemedView style={{ flexDirection: "row", gap: "4px", alignItems: "center", justifyContent: "flex-end" }}><StatusBadge status={selected.value.regulatoryReport.status} label={`${selected.value.regulatoryReport.reportType} · ${selected.value.regulatoryReport.status}`} toneOverride={badgeTone(selected.value.regulatoryReport.status)} /><MonoRef value={selected.value.regulatoryReport.id} /></ThemedView> : <MonoRef value={selected.value.regulatoryReportId ?? ""} /> },
                                    { label: t("Approval request"), value: <MonoRef value={selected.value.approval?.id ?? ""} /> },
                                    { label: t("Approval state"), value: selected.value.approval?.state ?? "—" },
                                    { label: t("Rejection reason"), value: selected.value.approval?.rejectionReason ?? "—" },
                                ]} />
                                {selected.value.approval && (
                                    <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                )}
                            </ThemedView>
                        </ThemedView>

                        {selected.value.screening?.matches?.length ? (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                                <ThemedText type="defaultSemiBold">{t("Screening matches")}</ThemedText>
                                {selected.value.screening.matches.map((match) => (
                                    <ThemedView key={match.id} style={{ gap: "3px", borderBottom: "1px solid var(--pg-border-subtle)", paddingBottom: "6px" }}>
                                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <StatusBadge status={match.disposition} toneOverride={match.disposition === "TRUE_MATCH" ? "danger" : match.disposition === "UNREVIEWED" ? "warning" : "success"} />
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{match.matchedName}</ThemedText>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{match.listType} · {match.listName} · {match.score}</ThemedText>
                                        </ThemedView>
                                        <MonoRef value={match.listEntryRef} />
                                        {match.dispositionNotes && <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{match.dispositionNotes}</ThemedText>}
                                    </ThemedView>
                                ))}
                            </ThemedView>
                        ) : null}

                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Severity inputs")}</ThemedText>
                            <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", background: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "160px", overflow: "auto" }}>
                                {JSON.stringify(selected.value.severityInputs ?? {}, null, 2)}
                            </pre>
                        </ThemedView>
                    </>
                )}
            </SlideOverDrawer>

            <FormModal
                modelValue={proposeOpen.value}
                onUpdate:modelValue={(value: boolean) => (proposeOpen.value = value)}
                title={t("Propose resolution")}
                size="md"
                loading={actionLoading.value}
                errorMessage={actionError.value}
                submitLabel={t("Propose resolution")}
                cancelLabel={t("Close")}
                onSubmit={() => void propose()}
            >
                <VAlert type="info" variant="tonal">{t("The resolution is proposed to a different MLRO checker. No ledger posting occurs until approval.")}</VAlert>
                <SectionFields title={t("Resolution proposal")}>
                    <FormField label={t("Resolution")} required sensitiveMakerChecker>
                        <VSelect
                            items={RESOLUTIONS}
                            modelValue={resolution.value}
                            onUpdate:modelValue={(value: string) => (resolution.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField
                        label={t("Rationale")}
                        hint={t("Required. Record the evidence and reasoning for the checker.")}
                        required
                        sensitiveMakerChecker
                    >
                        <VTextarea
                            modelValue={rationale.value}
                            onUpdate:modelValue={(value: string) => (rationale.value = value)}
                            rows={3}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...AML_CASE_CHECKS]}
                    modelValue={caseChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (caseChecklist.value = value)}
                    show={showChecklists}
                    title={t("Case checklist")}
                    complete={caseChecklistComplete.value}
                    incompleteMessage={t("Complete all case checklist items before proposing")}
                />
            </FormModal>
        </ScreenContainer>
    );
});

export default AmlCasesPage;
