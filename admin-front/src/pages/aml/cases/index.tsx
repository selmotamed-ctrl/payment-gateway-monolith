import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VProgressCircular, VSelect, VTab, VTabs, VTextarea } from "vuetify/components";
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

const formatMoney = (value: string | null | undefined, currency = "LYD"): string => {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return `${number.toFixed(4)} ${currency}`;
};

const formatHours = (hours: number): string => (hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`);

const severityTone = (severity: string) => {
    if (severity === "CRITICAL") return "error" as const;
    if (severity === "HIGH") return "warning" as const;
    if (severity === "MEDIUM") return "info" as const;
    return "neutral" as const;
};

const AmlCasesPage = dc(() => {
    const { t } = useLocale();
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
    const selected = ref<AmlCaseDetail | null>(null);
    const detailLoading = ref(false);
    const resolution = ref("RELEASE");
    const rationale = ref("");
    const caseChecklist = ref<Record<string, boolean>>({});
    const actionLoading = ref(false);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);

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

    const exportCsv = async () => {
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
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `aml-cases-${new Date().toISOString().slice(0, 10)}.csv`;
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

    const openDetails = async (row: AmlCase) => {
        selected.value = {
            ...row,
            screening: null,
            holdJournalEntry: null,
            regulatoryReport: null,
            approval: null,
        };
        resolution.value = "RELEASE";
        rationale.value = "";
        caseChecklist.value = {};
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlCaseDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.case ?? payload) as AmlCaseDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const canPropose = computed(() => selected.value && ["OPEN", "IN_REVIEW"].includes(selected.value.status));

    const caseChecklistComplete = computed(() => AML_CASE_CHECKS.every((check) => caseChecklist.value[check.key] === true));

    const propose = async () => {
        if (!selected.value) return;
        if (rationale.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("Rationale is required") });
            return;
        }
        if (!caseChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all case checklist items before proposing") });
            return;
        }
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlCasePropose(selected.value.id), {
                severity: selected.value.severity,
                action: resolution.value,
                reason: rationale.value.trim(),
                checklist: AML_CASE_CHECKS.filter((check) => caseChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            detailsOpen.value = false;
            showSnackBar({
                type: "success",
                message: payload.approvalRequestId
                    ? `${t("Resolution proposed")} · ${t("Approval request")} ${String(payload.approvalRequestId).slice(0, 8)}`
                    : t("Resolution proposed"),
            });
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
            const response = await api.get(urlsMap.amlCasesSummaryExport);
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
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `aml-case-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("AML case summary exported") });
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
            { label: t("Open cases"), value: String(data.totalOpen), tone: data.totalOpen > 0 ? "warning" as const : "success" as const },
            { label: t("Critical open"), value: String(data.criticalOpen), tone: data.criticalOpen > 0 ? "error" as const : "success" as const },
            { label: t("SLA overdue"), value: String(data.overdue), tone: data.overdue > 0 ? "error" as const : "success" as const },
            { label: t("Frozen"), value: String(data.frozen), tone: data.frozen > 0 ? "warning" as const : "success" as const },
            { label: t("Escalated STR"), value: String(data.escalated), tone: data.escalated > 0 ? "error" as const : "success" as const },
            { label: t("Oldest open"), value: formatHours(data.oldestOpenAgeHours), tone: data.oldestOpenAgeHours >= 72 ? "error" as const : data.oldestOpenAgeHours >= 24 ? "warning" as const : "success" as const },
        ];
    });

    const headers = computed<TableHeader<AmlCase>[]>(() => [
        {
            key: "caseRef",
            label: "Case",
            value: (row) => row.caseRef,
            Value: ({ row }: { row: AmlCase }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px", fontWeight: 600, direction: "ltr" }}>{row.caseRef}</ThemedText>
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
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.subjectReference}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "severity",
            label: "Severity",
            sortKey: "severity",
            value: (row) => row.severity,
            Value: ({ row }: { row: AmlCase }) => <StatusChip label={row.severity} tone={severityTone(row.severity)} size="small" />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: AmlCase }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="small" />,
        },
        {
            key: "rule",
            label: "Rule",
            value: (row) => row.ruleCode ?? "",
            Value: ({ row }: { row: AmlCase }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.ruleCode || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.ruleName || ""}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "amount",
            label: "Amount",
            value: (row) => row.amount ?? "",
            Value: ({ row }: { row: AmlCase }) => <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.amount, row.currency ?? "LYD")}</ThemedText>,
        },
        {
            key: "sla",
            label: "SLA due",
            sortKey: "slaDueAt",
            value: (row) => row.slaDueAt ?? "",
            Value: ({ row }: { row: AmlCase }) => row.slaOverdue
                ? <StatusChip label={t("Overdue")} tone="error" size="x-small" />
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
            Value: ({ row }: { row: AmlCase }) => <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>,
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Cases")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportCsv()}>{t("Export CSV")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="error" variant="tonal">
                    {t("AML-CONFIDENTIAL · This queue is restricted to Compliance, MLRO and authorised AML reviewers. Never disclose case details to the merchant or payer.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("AML case health")}</ThemedText>
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
                                {Object.entries(summary.value.byStatus ?? {}).map(([state, count]) => (
                                    <StatusChip key={state} label={`${state}: ${count}`} tone={statusTone(state)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <VTabs modelValue={activeView.value} onUpdate:modelValue={(value: unknown) => setView(value as AmlCaseView)} color="primary" density="comfortable" showArrows>
                    <VTab value="open" prependIcon="mdi-shield-alert-outline">{t("Open")}</VTab>
                    <VTab value="resolved" prependIcon="mdi-check-circle-outline">{t("Resolved")}</VTab>
                    <VTab value="all" prependIcon="mdi-view-list-outline">{t("All")}</VTab>
                </VTabs>

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

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="1080px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading AML case")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selected.value.caseRef}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.subjectName} · {selected.value.triggerReason}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={selected.value.severity} tone={severityTone(selected.value.severity)} />
                                        <StatusChip label={selected.value.status} tone={statusTone(selected.value.status)} />
                                        {selected.value.slaOverdue && <StatusChip label={t("SLA overdue")} tone="error" size="small" />}
                                    </ThemedView>
                                </ThemedView>

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Case context")}</ThemedText>
                                            {[
                                                [t("Subject type"), selected.value.subjectType],
                                                [t("Subject"), selected.value.subjectName],
                                                [t("Reference"), selected.value.subjectReference],
                                                [t("Subject status"), selected.value.subjectStatus || "—"],
                                                [t("Merchant"), selected.value.merchantName || "—"],
                                                [t("Amount"), formatMoney(selected.value.amount, selected.value.currency ?? "LYD")],
                                                [t("Rule"), selected.value.ruleCode ? `${selected.value.ruleCode} · ${selected.value.ruleName ?? ""}` : "—"],
                                                [t("Rule version"), selected.value.ruleVersion ?? "—"],
                                                [t("Opened"), formatDateTime(selected.value.openedAt)],
                                                [t("SLA due"), formatDateTime(selected.value.slaDueAt)],
                                                [t("Reviewer"), selected.value.assignedReviewerName || "—"],
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
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Investigation context")}</ThemedText>
                                            {[
                                                [t("Screening result"), selected.value.screening?.result ?? selected.value.screeningResult ?? "—"],
                                                [t("Screening score"), selected.value.screening?.highestScore ?? selected.value.screeningScore ?? "—"],
                                                [t("Screening provider"), selected.value.screening?.providerCode ?? "—"],
                                                [t("Hold journal"), selected.value.holdJournalEntryId || "—"],
                                                [t("Regulatory report"), selected.value.regulatoryReport ? `${selected.value.regulatoryReport.reportType} · ${selected.value.regulatoryReport.status}` : selected.value.regulatoryReportId || "—"],
                                                [t("Approval state"), selected.value.approval?.state ?? "—"],
                                                [t("Rejection reason"), selected.value.approval?.rejectionReason ?? "—"],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            {selected.value.approval && (
                                                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                {selected.value.screening?.matches?.length ? (
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Screening matches")}</ThemedText>
                                            {selected.value.screening.matches.map((match) => (
                                                <ThemedView key={match.id} style={{ gap: "3px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "6px" }}>
                                                    <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                                        <StatusChip label={match.disposition} tone={match.disposition === "TRUE_MATCH" ? "error" : match.disposition === "UNREVIEWED" ? "warning" : "success"} size="x-small" />
                                                        <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{match.matchedName}</ThemedText>
                                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{match.listType} · {match.listName} · {match.score}</ThemedText>
                                                    </ThemedView>
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{match.listEntryRef}</ThemedText>
                                                    {match.dispositionNotes && <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{match.dispositionNotes}</ThemedText>}
                                                </ThemedView>
                                            ))}
                                        </VCardText>
                                    </VCard>
                                ) : null}

                                <VCard variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Severity inputs")}</ThemedText>
                                        <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "160px", overflow: "auto" }}>
                                            {JSON.stringify(selected.value.severityInputs ?? {}, null, 2)}
                                        </pre>
                                    </VCardText>
                                </VCard>

                                {canPropose.value ? (
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Propose resolution")}</ThemedText>
                                            <VAlert type="info" variant="tonal">{t("The resolution is proposed to a different MLRO checker. No ledger posting occurs until approval.")}</VAlert>
                                            <VSelect
                                                items={RESOLUTIONS}
                                                modelValue={resolution.value}
                                                onUpdate:modelValue={(value: string) => (resolution.value = value)}
                                                label={t("Resolution")}
                                            />
                                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Case checklist")}</ThemedText>
                                                {AML_CASE_CHECKS.map((check) => (
                                                    <VCheckbox
                                                        key={check.key}
                                                        modelValue={caseChecklist.value[check.key] === true}
                                                        onUpdate:modelValue={(value: unknown) => (caseChecklist.value = { ...caseChecklist.value, [check.key]: Boolean(value) })}
                                                        label={t(check.label)}
                                                        density="compact"
                                                        hideDetails
                                                    />
                                                ))}
                                                {!caseChecklistComplete.value && (
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all case checklist items before proposing")}</ThemedText>
                                                )}
                                            </ThemedView>
                                            <VTextarea
                                                modelValue={rationale.value}
                                                onUpdate:modelValue={(value: string) => (rationale.value = value)}
                                                label={t("Rationale")}
                                                hint={t("Required. Record the evidence and reasoning for the checker.")}
                                                persistentHint
                                                rows={3}
                                            />
                                            <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                                <VBtn color="primary" loading={actionLoading.value} disabled={!caseChecklistComplete.value} onClick={() => void propose()}>{t("Propose resolution")}</VBtn>
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

export default AmlCasesPage;
