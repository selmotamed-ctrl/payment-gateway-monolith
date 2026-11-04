import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VProgressCircular, VSelect, VTextField, VTextarea } from "vuetify/components";
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
import type { MetricItem } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SectionFields } from "@/components/SectionFields";
type RegulatoryReport = {
    id: string;
    reportRef: string;
    reportType: string;
    authority: string;
    status: string;
    state: string;
    subjectType: string;
    subjectId: string;
    amlCaseId: string | null;
    amlCaseStatus: string | null;
    amlCaseSeverity: string | null;
    subjectName: string;
    periodStart: string | null;
    periodEnd: string | null;
    submissionRef: string | null;
    payloadSha256: string;
    confidential: boolean;
    approvalRequestId: string | null;
    approvalState: string | null;
    submittedAt: string | null;
    createdAt: string;
    updatedAt: string;
    ageHours: number;
};
type RegulatoryReportDetail = RegulatoryReport & {
    approval: {
        id: string;
        state: string;
        makerUserId: string;
        checkerUserId: string | null;
        rejectionReason: string | null;
        createdAt: string;
    } | null;
    amlCase: {
        id: string;
        status: string;
        severity: string;
        subjectType: string;
        subjectId: string;
        triggerReason: string;
    } | null;
};
type ReportSummary = {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    submittedThisMonth: number;
    pendingChecker: number;
    drafts: number;
    acknowledged: number;
    rejected: number;
};
type ReportView = "open" | "submitted" | "all";
type ReportingRule = {
    id: string;
    reportType: string;
    status: string;
    sourceReference: string | null;
    authority?: string;
};
const OPEN_STATES = ["DRAFT", "PENDING_CHECKER", "APPROVED"];
const SUBMITTED_STATES = ["SUBMITTED", "ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"];
const REPORT_TYPES = ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"];
const badgeTone = (value: string): BadgeTone => {
    const tone = statusTone(value);
    return tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
};
const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};
const REPORT_CHECKS = [
    { key: "REPORTING_RULE_VERIFIED", label: "Reporting rule verified" },
    { key: "PERIOD_VERIFIED", label: "Reporting period verified" },
    { key: "CASE_LINKAGE_VERIFIED", label: "Case linkage verified" },
    { key: "NOTES_REVIEWED", label: "Draft notes reviewed" },
] as const;
const SUBMISSION_CHECKS = [
    { key: "REPORT_APPROVED_VERIFIED", label: "Report approval verified" },
    { key: "AUTHORITY_REFERENCE_VERIFIED", label: "Authority reference verified" },
    { key: "DEADLINE_VERIFIED", label: "Submission deadline verified" },
    { key: "PAYLOAD_DIGEST_VERIFIED", label: "Payload digest verified" },
] as const;
const ACK_CHECKS = [
    { key: "AUTHORITY_RESPONSE_VERIFIED", label: "Authority response verified" },
    { key: "DECISION_RECORDED", label: "Authority decision recorded" },
    { key: "REJECTION_REASON_DOCUMENTED", label: "Rejection reason documented" },
    { key: "REPORT_CLOSURE_CONFIRMED", label: "Report closure confirmed" },
] as const;
const AmlReportsPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const rows = ref<RegulatoryReport[]>([]);
    const total = ref(0);
    const summary = ref<ReportSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<ReportView>("open");
    const filters = ref<FilterValues>({ status: [...OPEN_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;
    const createOpen = ref(false);
    const form = ref({
        reportingRuleId: "",
        reportType: "LARGE_TRANSACTION",
        authority: "CBL",
        periodStart: "",
        periodEnd: "",
        caseId: "",
        notes: "",
    });
    const rules = ref<ReportingRule[]>([]);
    const actionLoading = ref(false);
    const createError = ref("");
    const reportChecklist = ref<Record<string, boolean>>({});
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const detailsOpen = ref(false);
    const selected = ref<RegulatoryReportDetail | null>(null);
    const detailLoading = ref(false);
    const submitOpen = ref(false);
    const submissionRef = ref("");
    const submissionError = ref("");
    const submissionChecklist = ref<Record<string, boolean>>({});
    const submissionLoading = ref(false);
    const ackStatus = ref<"ACKNOWLEDGED" | "REJECTED_BY_AUTHORITY">("ACKNOWLEDGED");
    const ackReason = ref("");
    const ackOpen = ref(false);
    const ackError = ref("");
    const ackChecklist = ref<Record<string, boolean>>({});
    const ackLoading = ref(false);
    const filterDefinitions = computed(() => tableRegistry.AmlReports?.filters ?? []);
    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.amlReportsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as ReportSummary;
        } catch {
            summary.value = null;
        }
    };
    const loadRules = async () => {
        try {
            const response = await api.get(urlsMap.amlReportingRules);
            const payload = response.data?.data ?? response.data ?? {};
            rules.value = payload.rules ?? [];
        } catch {
            rules.value = [];
        }
    };
    void loadSummary();
    void loadRules();
    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };
    const onFiltersCleared = () => {
        filters.value = activeView.value === "open"
            ? { status: [...OPEN_STATES] }
            : activeView.value === "submitted"
              ? { status: [...SUBMITTED_STATES] }
              : {};
        refreshHook.value?.reset();
    };
    const setView = (view: ReportView) => {
        activeView.value = view;
        filters.value = view === "open"
            ? { status: [...OPEN_STATES] }
            : view === "submitted"
              ? { status: [...SUBMITTED_STATES] }
              : {};
        refreshHook.value?.reset();
    };
    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlReportsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.reports ?? []) as RegulatoryReport[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No AML reports match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "reportRef", "reportType", "authority", "status", "subjectType", "subjectName", "amlCaseId", "periodStart", "periodEnd", "submissionRef", "submittedAt", "createdAt", "ageHours"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.reportRef,
                        row.reportType,
                        row.authority,
                        row.status,
                        row.subjectType,
                        row.subjectName,
                        row.amlCaseId ?? "",
                        row.periodStart ?? "",
                        row.periodEnd ?? "",
                        row.submissionRef ?? "",
                        row.submittedAt ?? "",
                        row.createdAt,
                        row.ageHours,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-reports-${new Date().toISOString().slice(0, 10)}.xlsx`,
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
    const openCreate = () => {
        createError.value = "";
        form.value = {
            reportingRuleId: "",
            reportType: "LARGE_TRANSACTION",
            authority: "CBL",
            periodStart: "",
            periodEnd: "",
            caseId: "",
            notes: "",
        };
        createOpen.value = true;
        void loadRules();
    };
    const onRuleChanged = (value: string) => {
        form.value.reportingRuleId = value ?? "";
        const rule = rules.value.find((entry) => entry.id === form.value.reportingRuleId);
        if (rule) {
            form.value.reportType = rule.reportType;
            if (rule.authority) form.value.authority = rule.authority;
        }
    };
    const reportChecklistComplete = computed(() => !showChecklists || REPORT_CHECKS.every((check) => reportChecklist.value[check.key] === true));
    const reportSafeguard = useSafeguard("sg-aml-report");
    const submit = async () => {
        createError.value = "";
        if (!form.value.reportingRuleId || !form.value.periodStart || !form.value.periodEnd) {
            showSnackBar({ type: "warning", message: t("Reporting rule and period are required") });
            return;
        }
        if (!reportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all report checklist items before drafting") });
            return;
        }
        if (!(await reportSafeguard.confirm())) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReports, {
                reportingRuleId: form.value.reportingRuleId,
                reportType: form.value.reportType,
                authority: form.value.authority,
                periodStart: form.value.periodStart,
                periodEnd: form.value.periodEnd,
                ...(form.value.caseId.trim() ? { caseId: form.value.caseId.trim() } : {}),
                ...(form.value.notes.trim() ? { notes: form.value.notes.trim() } : {}),
                checklist: REPORT_CHECKS.filter((check) => reportChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            createOpen.value = false;
            showSnackBar({
                type: "success",
                message: payload.approvalRequestId
                    ? `${t("Report drafted")} · ${t("Approval request")} ${String(payload.approvalRequestId).slice(0, 8)}`
                    : t("Report drafted"),
            });
            refreshAll();
        } catch (error) {
            createError.value = extractApiErrorMessage(error);
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };
    const resetReportActionState = () => {
        submitOpen.value = false;
        ackOpen.value = false;
        submissionError.value = "";
        ackError.value = "";
        submissionRef.value = "";
        submissionChecklist.value = {};
        ackStatus.value = "ACKNOWLEDGED";
        ackReason.value = "";
        ackChecklist.value = {};
    };

    const presentReportDetail = (detail: RegulatoryReportDetail) => {
        selected.value = detail;
        resetReportActionState();
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchAmlReportDetail = async (id: string): Promise<RegulatoryReportDetail | null> => {
        const response = await api.get(urlsMap.amlReportDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.report ?? payload) as RegulatoryReportDetail;
    };

    const openDetails = async (row: RegulatoryReport) => {
        resetReportActionState();
        selected.value = { ...row, approval: null, amlCase: null };
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchAmlReportDetail(row.id);
            if (detail) presentReportDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<RegulatoryReportDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchAmlReportDetail,
        onOpenRecord: presentReportDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("AML report not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };
    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlReportsSummaryExport);
            const snapshot = (response.data?.data ?? response.data ?? {}) as ReportSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["submitted_this_month", snapshot.submittedThisMonth],
                ["pending_checker", snapshot.pendingChecker],
                ["drafts", snapshot.drafts],
                ["acknowledged", snapshot.acknowledged],
                ["rejected", snapshot.rejected],
            ];
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            for (const [type, count] of Object.entries(snapshot.byType ?? {})) rows.push([`type.${type}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-report-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("AML report summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };
    const canSubmitReport = computed(() => selected.value?.status === "APPROVED");
    const submissionChecklistComplete = computed(() => !showChecklists || SUBMISSION_CHECKS.every((check) => submissionChecklist.value[check.key] === true));
    const submitReport = async () => {
        if (!selected.value) return;
        submissionError.value = "";
        if (submissionRef.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("Submission reference is required") });
            return;
        }
        if (!submissionChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all submission checklist items before submitting") });
            return;
        }
        submissionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReportSubmit(selected.value.id), {
                submissionRef: submissionRef.value.trim(),
                checklist: SUBMISSION_CHECKS.filter((check) => submissionChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = { ...selected.value, status: payload.status ?? selected.value.status, submissionRef: payload.submissionRef ?? submissionRef.value.trim() };
            submitOpen.value = false;
            closeDetails();
            showSnackBar({ type: "success", message: t("Regulatory report submitted") });
            refreshAll();
        } catch (error) {
            submissionError.value = extractApiErrorMessage(error);
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            submissionLoading.value = false;
        }
    };
    const canAcknowledgeReport = computed(() => selected.value?.status === "SUBMITTED");
    const ackChecklistComplete = computed(() => !showChecklists || ACK_CHECKS.every((check) => ackChecklist.value[check.key] === true));
    const acknowledgeReport = async () => {
        if (!selected.value) return;
        ackError.value = "";
        if (!ackChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all acknowledgement checklist items before saving") });
            return;
        }
        if (ackStatus.value === "REJECTED_BY_AUTHORITY" && ackReason.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        if (!(await reportSafeguard.confirm())) return;
        ackLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReportAcknowledge(selected.value.id), {
                status: ackStatus.value,
                ...(ackReason.value.trim() ? { reason: ackReason.value.trim() } : {}),
                checklist: ACK_CHECKS.filter((check) => ackChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = { ...selected.value, status: payload.status ?? ackStatus.value };
            ackOpen.value = false;
            closeDetails();
            showSnackBar({ type: "success", message: t("Authority decision recorded") });
            refreshAll();
        } catch (error) {
            ackError.value = extractApiErrorMessage(error);
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            ackLoading.value = false;
        }
    };
    const summaryMetrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "reports", label: t("Reports"), value: String(data.total) },
            { key: "pending", label: t("Pending checker"), value: String(data.pendingChecker), badge: data.pendingChecker > 0 ? t("Pending") : t("Clear"), badgeTone: data.pendingChecker > 0 ? "warning" : "success" },
            { key: "drafts", label: t("Drafts"), value: String(data.drafts) },
            { key: "submitted", label: t("Submitted this month"), value: String(data.submittedThisMonth), badge: t("Submitted"), badgeTone: "success" },
            { key: "rejected", label: t("Rejected by authority"), value: String(data.rejected), subLabel: `${data.acknowledged} ${t("Acknowledged")}`, badge: data.rejected > 0 ? t("Rejected") : t("Clear"), badgeTone: data.rejected > 0 ? "danger" : "success" },
        ];
    });
    const headers = computed<TableHeader<RegulatoryReport>[]>(() => [
        {
            key: "reportRef",
            label: "Report",
            value: (row) => row.reportRef,
            Value: ({ row }: { row: RegulatoryReport }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.reportRef} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.reportType}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "authority", label: "Authority", value: (row) => row.authority },
        {
            key: "subject",
            label: "Subject",
            value: (row) => row.subjectName,
            Value: ({ row }: { row: RegulatoryReport }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{row.subjectName || "—"}</ThemedText>
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.subjectType}</ThemedText>
                        <MonoRef value={row.subjectId} />
                    </ThemedView>
                </ThemedView>
            ),
        },
        {
            key: "status",
            label: "Status",
            value: (row) => row.status,
            Value: ({ row }: { row: RegulatoryReport }) => <StatusBadge status={row.status} toneOverride={badgeTone(row.status)} />,
        },
        {
            key: "period",
            label: "Period",
            value: (row) => `${row.periodStart ?? ""} ${row.periodEnd ?? ""}`,
            Value: ({ row }: { row: RegulatoryReport }) => <ThemedText style={{ fontSize: "10px" }}>{formatDateTime(row.periodStart)} → {formatDateTime(row.periodEnd)}</ThemedText>,
        },
        {
            key: "submission",
            label: "Submission",
            value: (row) => row.submissionRef ?? "",
            Value: ({ row }: { row: RegulatoryReport }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.submissionRef ?? ""} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(row.submittedAt)}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "approval",
            label: "Approval",
            value: (row) => row.approvalState ?? "",
            Value: ({ row }: { row: RegulatoryReport }) => row.approvalState
                ? <StatusBadge status={row.approvalState} toneOverride={badgeTone(row.approvalState)} />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: RegulatoryReport }) => (
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
                    title={t("AML Reports")}
                    subtitle={t("Draft, approve, submit, and acknowledge regulatory reports under restricted access.")}
                    badge="AML-CONFIDENTIAL"
                    badgeTone="danger"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("Draft report")}</VBtn>
                        </ThemedView>
                    )}
                />
                <VAlert type="error" variant="tonal">
                    {t("AML-CONFIDENTIAL · Regulatory reports are restricted to Compliance, MLRO and authorised reporting roles. Never disclose an STR or its existence to the subject.")}
                </VAlert>
                {summary.value && (
                    <SummaryExportCard
                        title={t("Reporting health")}
                        metrics={summaryMetrics.value}
                        exportLoading={summaryExportLoading.value}
                        exportLabel={t("Export summary")}
                        onExport={() => void exportSummary()}
                    >
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byStatus ?? {}).map(([status, count]) => (
                                <StatusBadge key={status} status={status} label={`${status}: ${count}`} toneOverride={badgeTone(status)} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}
                <SegmentedTabs
                    modelValue={activeView.value}
                    onUpdate:modelValue={(value: string) => setView(value as ReportView)}
                    tabs={[
                        { value: "open", label: t("Open") },
                        { value: "submitted", label: t("Submitted") },
                        { value: "all", label: t("All") },
                    ]}
                />
                <ApiTable<RegulatoryReport>
                    title={t("Regulatory report queue")}
                    url={urlsMap.amlReports}
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
                    rowColor={(row) => (row.status === "REJECTED_BY_AUTHORITY" ? "#dc2626" : row.status === "PENDING_CHECKER" ? "#d97706" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { reports?: RegulatoryReport[]; rows?: RegulatoryReport[] };
                        return payload.reports ?? payload.rows ?? [];
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
                title={selected.value?.reportRef ?? t("AML report")}
                subtitle={selected.value ? `${selected.value.reportType} · ${selected.value.authority}` : ""}
                width={660}
                v-slots={{
                    footer: () => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            {canSubmitReport.value && (
                                <VBtn color="primary" onClick={() => { submissionError.value = ""; submitOpen.value = true; }}>{t("Submit report")}</VBtn>
                            )}
                            {canAcknowledgeReport.value && (
                                <VBtn color="primary" onClick={() => { ackError.value = ""; ackOpen.value = true; }}>{t("Record authority decision")}</VBtn>
                            )}
                            <VBtn variant="text" onClick={closeDetails}>{t("Close")}</VBtn>
                        </ThemedView>
                    ),
                }}
            >
                {detailLoading.value || !selected.value ? (
                    <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                        <VProgressCircular indeterminate size={52} color="primary" />
                        <ThemedText style={{ opacity: 0.65 }}>{t("Loading regulatory report")}</ThemedText>
                    </ThemedView>
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "16px" }}>
                            <StatusBadge status={selected.value.status} toneOverride={badgeTone(selected.value.status)} />
                            {selected.value.confidential && <StatusBadge status="AML_CONFIDENTIAL" label="AML-CONFIDENTIAL" toneOverride="danger" />}
                        </ThemedView>
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px", marginBottom: "16px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Report context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Report ref"), value: <MonoRef value={selected.value.reportRef} /> },
                                    { label: t("Subject type"), value: selected.value.subjectType },
                                    { label: t("Subject"), value: selected.value.subjectName },
                                    { label: t("Subject ID"), value: <MonoRef value={selected.value.subjectId} /> },
                                    { label: t("AML case"), value: <MonoRef value={selected.value.amlCaseId ?? ""} /> },
                                    { label: t("Case status"), value: selected.value.amlCase?.status || selected.value.amlCaseStatus || "—" },
                                    { label: t("Case severity"), value: selected.value.amlCase?.severity || selected.value.amlCaseSeverity || "—" },
                                    { label: t("Period start"), value: formatDateTime(selected.value.periodStart) },
                                    { label: t("Period end"), value: formatDateTime(selected.value.periodEnd) },
                                    { label: t("Submission ref"), value: <MonoRef value={selected.value.submissionRef ?? ""} /> },
                                ]} />
                            </ThemedView>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval and integrity")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Approval state"), value: selected.value.approvalState || selected.value.approval?.state || "—" },
                                    { label: t("Approval request"), value: <MonoRef value={selected.value.approvalRequestId ?? ""} /> },
                                    { label: t("Checker"), value: selected.value.approval?.checkerUserId || "—" },
                                    { label: t("Rejection reason"), value: selected.value.approval?.rejectionReason || "—" },
                                    { label: t("Payload SHA-256"), value: <MonoRef value={selected.value.payloadSha256} /> },
                                    { label: t("Created"), value: formatDateTime(selected.value.createdAt) },
                                    { label: t("Submitted"), value: formatDateTime(selected.value.submittedAt) },
                                ]} />
                                {selected.value.approvalRequestId && (
                                    <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                )}
                            </ThemedView>
                        </ThemedView>
                        <VAlert type="info" variant="tonal">
                            {t("The report payload is frozen and encrypted. Its SHA-256 digest proves the submitted content was not changed.")}
                        </VAlert>
                    </>
                )}
            </SlideOverDrawer>
            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(value: boolean) => (createOpen.value = value)}
                title={t("Draft regulatory report")}
                size="md"
                loading={actionLoading.value}
                errorMessage={createError.value}
                submitLabel={t("Create draft")}
                onSubmit={() => void submit()}
            >
                <VAlert type="info" variant="tonal">{t("The report is drafted as PENDING_CHECKER. A different MLRO must approve it before it is frozen and submitted.")}</VAlert>
                <SectionFields title={t("Report definition")}>
                    <FormField label={t("Reporting rule")} required sensitiveMakerChecker>
                        <VSelect
                            items={rules.value.map((rule) => ({ title: `${rule.reportType} · ${rule.status} · ${rule.sourceReference ?? rule.id}`, value: rule.id }))}
                            modelValue={form.value.reportingRuleId}
                            onUpdate:modelValue={(value: string) => onRuleChanged(value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Report type")} required sensitiveMakerChecker>
                        <VSelect
                            items={REPORT_TYPES.map((value) => ({ title: value, value }))}
                            modelValue={form.value.reportType}
                            onUpdate:modelValue={(value: string) => (form.value.reportType = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Authority")} required sensitiveMakerChecker>
                        <VTextField modelValue={form.value.authority} onUpdate:modelValue={(value: string) => (form.value.authority = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Period start")} required sensitiveMakerChecker>
                        <VTextField type="date" modelValue={form.value.periodStart} onUpdate:modelValue={(value: string) => (form.value.periodStart = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Period end")} required sensitiveMakerChecker>
                        <VTextField type="date" modelValue={form.value.periodEnd} onUpdate:modelValue={(value: string) => (form.value.periodEnd = value)} hideDetails />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Case linkage and notes")}>
                    <FormField label={t("AML case ID (optional)")} sensitiveMakerChecker>
                        <VTextField modelValue={form.value.caseId} onUpdate:modelValue={(value: string) => (form.value.caseId = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Notes")} sensitiveMakerChecker>
                        <VTextarea modelValue={form.value.notes} onUpdate:modelValue={(value: string) => (form.value.notes = value)} rows={3} hideDetails />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...REPORT_CHECKS]}
                    modelValue={reportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (reportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Report checklist")}
                    complete={reportChecklistComplete.value}
                    incompleteMessage={t("Complete all report checklist items before drafting")}
                />
            </FormModal>

            <FormModal
                modelValue={submitOpen.value}
                onUpdate:modelValue={(value: boolean) => (submitOpen.value = value)}
                title={t("Submit regulatory report")}
                size="md"
                loading={submissionLoading.value}
                errorMessage={submissionError.value}
                submitLabel={t("Submit report")}
                cancelLabel={t("Close")}
                onSubmit={() => void submitReport()}
            >
                <VAlert type="warning" variant="tonal">
                    {t("Submission freezes the report and records the authority reference. Verify the deadline and payload digest first.")}
                </VAlert>
                <FormField label={t("Submission reference")} required sensitiveMakerChecker>
                    <VTextField
                        modelValue={submissionRef.value}
                        onUpdate:modelValue={(value: string) => (submissionRef.value = value)}
                        hideDetails
                    />
                </FormField>
                <FormChecklist
                    checks={[...SUBMISSION_CHECKS]}
                    modelValue={submissionChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (submissionChecklist.value = value)}
                    show={showChecklists}
                    title={t("Submission checklist")}
                    complete={submissionChecklistComplete.value}
                    incompleteMessage={t("Complete all submission checklist items before submitting")}
                />
            </FormModal>

            <FormModal
                modelValue={ackOpen.value}
                onUpdate:modelValue={(value: boolean) => (ackOpen.value = value)}
                title={t("Record authority decision")}
                size="md"
                loading={ackLoading.value}
                errorMessage={ackError.value}
                submitLabel={t("Save authority decision")}
                cancelLabel={t("Close")}
                onSubmit={() => void acknowledgeReport()}
            >
                <VAlert type="info" variant="tonal">
                    {t("Record the authority response exactly. A rejection requires a documented reason.")}
                </VAlert>
                <SectionFields title={t("Authority decision")}>
                    <FormField label={t("Authority decision")} required sensitiveMakerChecker>
                        <VSelect
                            items={[
                                { title: t("Acknowledged"), value: "ACKNOWLEDGED" },
                                { title: t("Rejected by authority"), value: "REJECTED_BY_AUTHORITY" },
                            ]}
                            modelValue={ackStatus.value}
                            onUpdate:modelValue={(value: string) => (ackStatus.value = value as "ACKNOWLEDGED" | "REJECTED_BY_AUTHORITY")}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Rejection reason")} sensitiveMakerChecker>
                        <VTextarea
                            rows={2}
                            modelValue={ackReason.value}
                            onUpdate:modelValue={(value: string) => (ackReason.value = value)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...ACK_CHECKS]}
                    modelValue={ackChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (ackChecklist.value = value)}
                    show={showChecklists}
                    title={t("Acknowledgement checklist")}
                    complete={ackChecklistComplete.value}
                    incompleteMessage={t("Complete all acknowledgement checklist items before saving")}
                />
            </FormModal>
        </ScreenContainer>
    );
});
export default AmlReportsPage;
