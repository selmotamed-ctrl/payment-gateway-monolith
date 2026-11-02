import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAutocomplete, VBtn, VCheckbox, VDivider, VSelect, VTextField } from "vuetify/components";
import { useRouter } from "vue-router";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { MoneyText } from "@/components/MoneyText";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { createOptionsLoader } from "@/components/Table/referenceOptions";
import { tableRegistry } from "@/components/Table/tableRegistry";
import { statusTone } from "@/components/Table/statusTone";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {
    COLUMN_HELP,
    caseHelp,
    caseStateHelp,
    formatDateTime,
    priorityHelp,
    slaInfo,
} from "./operatorCaseHelp";
import type { BulkInquiryResult, OperatorCaseSummary } from "./types";

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
type AssigneeOption = { title: string; value: string };

type OperatorCasesSummary = {
    total: number;
    open: number;
    inProgress: number;
    pendingChecker: number;
    resolved: number;
    unassigned: number;
    overdue: number;
    p1Open: number;
    byState: Record<string, number>;
    byPriority: Record<string, number>;
};

const filterDefinitions = tableRegistry.OperatorCases?.filters ?? [];

const reasonText = (reason: string | undefined): string => {
    if (!reason) return "";
    return reason.replaceAll("_", " ").toLowerCase();
};

const SUMMARY_EXPORT_CHECKS = [
    { key: "OPEN_SCOPE_VERIFIED", label: "Open case scope verified" },
    { key: "SLA_REVIEWED", label: "SLA status reviewed" },
    { key: "PRIORITY_BREAKDOWN_REVIEWED", label: "Priority breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const INQUIRY_CHECKS = [
    { key: "ELIGIBILITY_REVIEWED", label: "Inquiry eligibility reviewed" },
    { key: "ATTEMPT_STATUS_VERIFIED", label: "Attempt status verified" },
    { key: "GATEWAY_SUPPORT_CONFIRMED", label: "Gateway inquiry support confirmed" },
    { key: "INQUIRY_SCOPE_CONFIRMED", label: "Inquiry scope confirmed" },
] as const;

const STATE_CHANGE_CHECKS = [
    { key: "CASE_SCOPE_CONFIRMED", label: "Selected case scope confirmed" },
    { key: "STATE_IMPACT_REVIEWED", label: "State impact reviewed" },
    { key: "SLA_IMPACT_REVIEWED", label: "SLA impact reviewed" },
    { key: "NOTIFICATION_PLANNED", label: "Notification planned" },
] as const;

const ASSIGN_CHECKS = [
    { key: "ASSIGNEE_VERIFIED", label: "Assignee verified" },
    { key: "WORKLOAD_REVIEWED", label: "Workload reviewed" },
    { key: "NOTIFICATION_PLANNED", label: "Assignee notification planned" },
    { key: "CASE_SCOPE_CONFIRMED", label: "Selected case scope confirmed" },
] as const;

const OperatorCasesPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const theme = useTheme();
    const router = useRouter();

    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const rows = ref<OperatorCaseSummary[]>([]);
    const total = ref(0);
    const summary = ref<OperatorCasesSummary | null>(null);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const pageSize = ref(20);
    const selected = ref<Record<string, OperatorCaseSummary>>({});
    const bulkLoading = ref(false);
    const inquiringId = ref<string | null>(null);
    const bulkResult = ref<BulkInquiryResult | null>(null);
    const resultOpen = ref(false);
    const inspectionOpen = ref(false);
    const inspectionCase = ref<OperatorCaseSummary | null>(null);
    const inquiryOpen = ref(false);
    const inquiryCaseIds = ref<string[]>([]);
    const inquiryChecklist = ref<Record<string, boolean>>({});
    const assignOpen = ref(false);
    const assignSaving = ref(false);
    const assignUserId = ref<string | null>(null);
    const assignReason = ref("");
    const assignChecklist = ref<Record<string, boolean>>({});
    const assignOptions = ref<AssigneeOption[]>([]);
    const assignOptionsLoading = ref(false);
    const loadAssigneeOptions = createOptionsLoader("users");
    const stateOpen = ref(false);
    const stateSaving = ref(false);
    const bulkState = ref<"OPEN" | "IN_PROGRESS">("IN_PROGRESS");
    const stateReason = ref("");
    const stateChangeChecklist = ref<Record<string, boolean>>({});
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.operatorCasesSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as OperatorCasesSummary;
        } catch {
            summary.value = null;
        }
    };

    void loadSummary();

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.operatorCasesExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.cases ?? []) as OperatorCaseSummary[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No operator cases match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "caseRef", "caseType", "priority", "state", "merchantName", "merchantStatus", "railCode", "gatewayCode", "attemptReference", "attemptStatus", "amount", "currency", "providerReference", "reconciliationResult", "approvalState", "assigneeEmail", "openedAt", "slaDueAt", "inquiryEligible", "inquiryReason"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.caseRef,
                        row.caseType,
                        row.priority,
                        row.state,
                        row.merchantName,
                        row.merchantStatus ?? "",
                        row.railCode,
                        row.gatewayCode,
                        row.attemptReference ?? "",
                        row.attemptStatus ?? "",
                        row.chargedAmount ?? row.statementAmount ?? "",
                        row.currency ?? "",
                        row.providerReference ?? "",
                        row.reconciliationResult ?? "",
                        row.approvalState ?? "",
                        row.assigneeEmail ?? "",
                        row.openedAt,
                        row.slaDueAt,
                        row.inquiryEligibility?.eligible ?? false,
                        row.inquiryEligibility?.reason ?? "",
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `operator-cases-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.operatorCasesSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as OperatorCasesSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["open", snapshot.open],
                ["in_progress", snapshot.inProgress],
                ["pending_checker", snapshot.pendingChecker],
                ["resolved", snapshot.resolved],
                ["unassigned", snapshot.unassigned],
                ["overdue", snapshot.overdue],
                ["p1_open", snapshot.p1Open],
            ];
            for (const [state, count] of Object.entries(snapshot.byState ?? {})) rows.push([`state.${state}.count`, count]);
            for (const [priority, count] of Object.entries(snapshot.byPriority ?? {})) rows.push([`priority.${priority}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `operator-case-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Operator case summary exported") });
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
            {
                key: "queue",
                label: t("Queue"),
                value: String(data.total),
                subLabel: t("Operator queue"),
                badge: t("Live"),
                badgeTone: "info" as const,
            },
            {
                key: "p1",
                label: t("P1 open"),
                value: String(data.p1Open),
                subLabel: t("P1 target: 4h · P2 target: 24h"),
                badge: data.p1Open > 0 ? t("P1") : t("Clear"),
                badgeTone: data.p1Open > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "overdue",
                label: t("Overdue"),
                value: String(data.overdue),
                subLabel: t("Past SLA"),
                badge: data.overdue > 0 ? t("P1") : t("Clear"),
                badgeTone: data.overdue > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "unassigned",
                label: t("Unassigned"),
                value: String(data.unassigned),
                subLabel: t("No owner"),
                badge: data.unassigned > 0 ? t("Attention") : t("Clear"),
                badgeTone: data.unassigned > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "pendingChecker",
                label: t("Pending checker"),
                value: String(data.pendingChecker),
                subLabel: t("Awaiting independent checker"),
                badge: data.pendingChecker > 0 ? t("Four eyes") : t("Clear"),
                badgeTone: data.pendingChecker > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "resolved",
                label: t("Resolved"),
                value: String(data.resolved),
                subLabel: t("Closed with evidence"),
                badge: t("Complete"),
                badgeTone: "success" as const,
            },
        ];
    });
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);

    const canInquire = computed(() => hasOneOfAuthorities(["attempt:inquire", "case:write"]));
    const canAssign = computed(() => hasOneOfAuthorities(["case:write", "operator:write"]));
    const selectedList = computed(() => Object.values(selected.value));
    const selectedCount = computed(() => selectedList.value.length);
    const eligibleSelected = computed(() =>
        selectedList.value.filter((row) => row.inquiryEligibility?.eligible === true),
    );
    const skippedSelected = computed(() =>
        selectedList.value.filter((row) => row.inquiryEligibility?.eligible !== true),
    );
    const allVisibleSelected = computed(
        () => rows.value.length > 0 && rows.value.every((row) => Boolean(selected.value[row.id])),
    );
    const someVisibleSelected = computed(
        () => rows.value.some((row) => Boolean(selected.value[row.id])) && !allVisibleSelected.value,
    );

    const clearSelection = () => {
        selected.value = {};
    };

    const toggleRow = (row: OperatorCaseSummary, value: boolean | null) => {
        if (value) {
            selected.value = { ...selected.value, [row.id]: row };
        } else {
            const next = { ...selected.value };
            delete next[row.id];
            selected.value = next;
        }
    };

    const toggleVisible = (value: boolean | null) => {
        if (!value) {
            const next = { ...selected.value };
            for (const row of rows.value) delete next[row.id];
            selected.value = next;
            return;
        }
        const next = { ...selected.value };
        for (const row of rows.value) next[row.id] = row;
        selected.value = next;
    };

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        clearSelection();
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        clearSelection();
        refreshHook.value?.reset();
    };

    const onSearchChanged = (value: string | null) => {
        search.value = value;
        clearSelection();
    };

    const toneColor = (tone: ReturnType<typeof statusTone>): string => {
        const colors = theme.current.value.colors as Record<string, string>;
        return colors[tone] ?? colors["on-surface-variant"] ?? "#64748b";
    };

    const rowColor = (row: OperatorCaseSummary): string | undefined => {
        if (row.priority === "P1" || slaInfo(row.slaDueAt).tone === "error") {
            return toneColor("error");
        }
        if (row.priority === "P2" || row.state === "PENDING_CHECKER") {
            return toneColor("warning");
        }
        if (row.priority === "P3") {
            return toneColor("info");
        }
        return undefined;
    };

    const openCase = (row: OperatorCaseSummary) => {
        void router.push({ name: "OperatorCaseDetail", params: { id: row.id } });
    };

    const openInspection = (row: OperatorCaseSummary) => {
        inspectionCase.value = row;
        inspectionOpen.value = true;
    };

    const openInquiry = (caseIds: string[]) => {
        if (caseIds.length === 0) return;
        inquiryCaseIds.value = caseIds;
        inquiryChecklist.value = {};
        inquiryOpen.value = true;
    };

    const inquiryChecklistComplete = computed(() => !showChecklists || INQUIRY_CHECKS.every((check) => inquiryChecklist.value[check.key] === true));

    const confirmInquiry = () => {
        if (!inquiryChecklistComplete.value) return;
        inquiryOpen.value = false;
        void runBulkInquiry(inquiryCaseIds.value);
    };

    const runBulkInquiry = async (caseIds: string[]) => {
        if (caseIds.length === 0) return;
        bulkLoading.value = true;
        try {
            const response = await api.post(urlsMap.operatorCasesBulkInquire, {
                caseIds,
                checklist: INQUIRY_CHECKS.filter((check) => inquiryChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = (response.data?.data ?? response.data ?? {}) as BulkInquiryResult;
            bulkResult.value = payload;
            resultOpen.value = true;
            clearSelection();
            refreshHook.value?.refreshAsIs();
            showSnackBar({
                type: payload.scheduled > 0 ? "success" : "warning",
                message: `${t("Inquiry scheduled")}: ${payload.scheduled} / ${payload.requested}`,
            });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            bulkLoading.value = false;
        }
    };

    const openAssign = async () => {
        if (selectedCount.value === 0) return;
        assignUserId.value = null;
        assignReason.value = "";
        assignChecklist.value = {};
        assignOpen.value = true;
        assignOptionsLoading.value = true;
        try {
            assignOptions.value = (await loadAssigneeOptions("")) as AssigneeOption[];
        } catch {
            assignOptions.value = [];
        } finally {
            assignOptionsLoading.value = false;
        }
    };

    const openState = () => {
        if (selectedCount.value === 0) return;
        bulkState.value = "IN_PROGRESS";
        stateReason.value = "";
        stateChangeChecklist.value = {};
        stateOpen.value = true;
    };

    const stateChangeChecklistComplete = computed(() => !showChecklists || STATE_CHANGE_CHECKS.every((check) => stateChangeChecklist.value[check.key] === true));

    const applyBulkState = async () => {
        if (selectedCount.value === 0 || stateSaving.value) return;
        if (!stateChangeChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all state checklist items before applying") });
            return;
        }
        stateSaving.value = true;
        try {
            const response = await api.post(urlsMap.operatorCasesBulkState, {
                caseIds: Object.keys(selected.value),
                state: bulkState.value,
                ...(stateReason.value.trim() ? { reason: stateReason.value.trim() } : {}),
                checklist: STATE_CHANGE_CHECKS.filter((check) => stateChangeChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            const updated = Number(payload.updated ?? 0);
            const skipped = Number(payload.skipped ?? 0);
            showSnackBar({
                type: skipped > 0 ? "warning" : "success",
                message: `${t("Updated")}: ${updated} · ${t("Skipped")}: ${skipped}`,
            });
            stateOpen.value = false;
            clearSelection();
            refreshHook.value?.refreshAsIs();
            void loadSummary();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            stateSaving.value = false;
        }
    };

    const searchAssignees = async (value: string) => {
        assignOptionsLoading.value = true;
        try {
            assignOptions.value = (await loadAssigneeOptions(value)) as AssigneeOption[];
        } catch {
            assignOptions.value = [];
        } finally {
            assignOptionsLoading.value = false;
        }
    };

    const assignChecklistComplete = computed(() => !showChecklists || ASSIGN_CHECKS.every((check) => assignChecklist.value[check.key] === true));

    const assignSelected = async () => {
        if (selectedCount.value === 0 || assignSaving.value) return;
        if (!assignChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all assignment checklist items before assigning") });
            return;
        }
        assignSaving.value = true;
        try {
            const response = await api.post(urlsMap.operatorCasesBulkAssign, {
                caseIds: Object.keys(selected.value),
                assigneeUserId: assignUserId.value,
                ...(assignReason.value.trim() ? { reason: assignReason.value.trim() } : {}),
                checklist: ASSIGN_CHECKS.filter((check) => assignChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            const assigned = Number(payload.assigned ?? 0);
            const skipped = Number(payload.skipped ?? 0);
            showSnackBar({
                type: skipped > 0 ? "warning" : "success",
                message: `${t("Assigned")}: ${assigned} · ${t("Skipped")}: ${skipped}`,
            });
            assignOpen.value = false;
            clearSelection();
            refreshHook.value?.refreshAsIs();
            void loadSummary();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            assignSaving.value = false;
        }
    };

    const inquireOne = async (row: OperatorCaseSummary) => {
        inquiringId.value = row.id;
        try {
            openInquiry([row.id]);
        } finally {
            inquiringId.value = null;
        }
    };

    const headers: TableHeader<OperatorCaseSummary>[] = [
        {
            key: "select",
            label: "",
            sortable: false,
            headerTooltip: "Select cases for a bulk gateway inquiry. Only inquiry-eligible cases are scheduled.",
            headerCellStyle: { justifyContent: "center" },
            Header: () => (
                <span
                    style={{
                        width: "28px",
                        height: "40px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    <VCheckbox
                        modelValue={allVisibleSelected.value}
                        indeterminate={someVisibleSelected.value}
                        onUpdate:modelValue={(value: boolean | null) => toggleVisible(value)}
                        density="compact"
                        hideDetails
                        aria-label="Select all cases on this page"
                        style={{ flex: "0 0 auto" }}
                    />
                </span>
            ),
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <ThemedView
                    style={{
                        width: "28px",
                        height: "40px",
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    <VCheckbox
                        modelValue={Boolean(selected.value[row.id])}
                        onUpdate:modelValue={(value: boolean | null) => toggleRow(row, value)}
                        density="compact"
                        hideDetails
                        aria-label={`Select case ${row.caseRef}`}
                        style={{ flex: "0 0 auto" }}
                    />
                </ThemedView>
            ),
        },
        {
            key: "caseRef",
            label: "Case reference",
            sortKey: "caseRef",
            headerTooltip: COLUMN_HELP.caseRef,
            value: (row) => row.caseRef,
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <VBtn
                    variant="text"
                    color="primary"
                    size="small"
                    aria-label={`Open case ${row.caseRef}`}
                    onClick={() => openCase(row)}
                    style={{
                        minWidth: 0,
                        height: "auto",
                        padding: "2px 4px",
                        textTransform: "none",
                        fontWeight: 700,
                        letterSpacing: 0,
                    }}
                >
                    {row.caseRef}
                </VBtn>
            ),
        },
        {
            key: "caseType",
            label: "Type",
            sortKey: "kind",
            headerTooltip: COLUMN_HELP.caseType,
            value: (row) => row.caseType,
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const help = caseHelp(row.caseType);
                return (
                    <StatusChip
                        label={help.label}
                        tone={
                            row.caseType === "CONFLICT" || row.caseType === "LATE_SUCCESS"
                                ? "error"
                                : row.caseType === "UNKNOWN" || row.caseType === "MISMATCH"
                                  ? "warning"
                                  : "info"
                        }
                    />
                );
            },
        },
        {
            key: "priority",
            label: "Priority",
            sortKey: "priority",
            headerTooltip: COLUMN_HELP.priority,
            value: (row) => row.priority,
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <span title={priorityHelp(row.priority).meaning}>
                    <StatusChip label={row.priority} tone={statusTone(row.priority)} />
                </span>
            ),
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            headerTooltip: COLUMN_HELP.state,
            value: (row) => row.state,
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <span title={caseStateHelp(row.state).meaning}>
                    <StatusChip label={row.state} tone={statusTone(row.state)} />
                </span>
            ),
        },
        {
            key: "merchantName",
            label: "Merchant",
            sortKey: "merchantName",
            headerTooltip: COLUMN_HELP.merchant,
            value: (row) => row.merchantTradeName || row.merchantLegalName || "—",
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>
                        {row.merchantTradeName || row.merchantLegalName || "—"}
                    </ThemedText>
                    {row.merchantLegalName && row.merchantLegalName !== row.merchantTradeName && (
                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{row.merchantLegalName}</ThemedText>
                    )}
                </ThemedView>
            ),
        },
        {
            key: "route",
            label: "Rail / Gateway",
            headerTooltip: COLUMN_HELP.route,
            value: (row) => `${row.railCode ?? ""} ${row.gatewayCode ?? ""}`.trim(),
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>{row.railCode || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                        {row.gatewayCode || row.gatewayName || "—"}
                    </ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "amount",
            label: "Amount",
            headerTooltip: COLUMN_HELP.amount,
            value: (row) => String(row.chargedAmount ?? row.statementAmount ?? ""),
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const amount = row.chargedAmount ?? row.statementAmount;
                const source = row.chargedAmount ? "Charged" : row.statementAmount ? "Statement" : "";
                if (amount === null || amount === undefined) {
                    return <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>;
                }
                return (
                    <ThemedView style={{ gap: "2px" }}>
                        <MoneyText value={amount} currency={row.currency} showCurrency={Boolean(row.currency)} bold />
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{source}</ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "attempt",
            label: "Attempt",
            headerTooltip: COLUMN_HELP.attempt,
            value: (row) => row.attemptReference ?? "",
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <MonoRef value={row.attemptReference ?? ""} truncate={18} />
                    {row.attemptStatus ? (
                        <StatusChip label={row.attemptStatus} tone={statusTone(row.attemptStatus)} size="x-small" />
                    ) : (
                        <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>No attempt</ThemedText>
                    )}
                    {row.attemptSubstatus && (
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.attemptSubstatus}</ThemedText>
                    )}
                </ThemedView>
            ),
        },
        {
            key: "slot",
            label: "Link slot",
            headerTooltip: COLUMN_HELP.slot,
            value: (row) =>
                row.linkSlot ? `${row.linkSlot.confirmedCount ?? 0}/${row.linkSlot.useCount ?? 0}` : "",
            Value: ({ row }: { row: OperatorCaseSummary }) =>
                row.linkSlot ? (
                    <ThemedView style={{ gap: "3px" }}>
                        <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>
                            {row.linkSlot.confirmedCount ?? 0}/{row.linkSlot.useCount ?? 0} used
                        </ThemedText>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>
                            {row.linkSlot.activeLockedCount ?? 0} locked
                        </ThemedText>
                    </ThemedView>
                ) : (
                    <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>
                ),
        },
        {
            key: "providerReference",
            label: "Provider reference",
            headerTooltip: COLUMN_HELP.providerReference,
            value: (row) => row.providerReference ?? "",
            Value: ({ row }: { row: OperatorCaseSummary }) => <MonoRef value={row.providerReference ?? ""} truncate={18} />,
        },
        {
            key: "reconciliation",
            label: "Reconciliation",
            headerTooltip: COLUMN_HELP.reconciliation,
            value: (row) => row.reconciliationResult ?? "",
            Value: ({ row }: { row: OperatorCaseSummary }) =>
                row.reconciliationResult ? (
                    <StatusChip
                        label={row.reconciliationResult}
                        tone={statusTone(row.reconciliationResult)}
                        size="x-small"
                    />
                ) : (
                    <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>
                ),
        },
        {
            key: "approval",
            label: "Approval",
            headerTooltip: COLUMN_HELP.approval,
            value: (row) => row.approvalState ?? "",
            Value: ({ row }: { row: OperatorCaseSummary }) =>
                row.approvalState ? (
                    <StatusChip label={row.approvalState} tone={statusTone(row.approvalState)} size="x-small" />
                ) : (
                    <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>
                ),
        },
        {
            key: "openedAt",
            label: "Opened",
            sortKey: "openedAt",
            headerTooltip: COLUMN_HELP.openedAt,
            value: (row) => row.openedAt,
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(row.openedAt)}</ThemedText>
            ),
        },
        {
            key: "slaDueAt",
            label: "SLA due",
            sortKey: "slaDueAt",
            headerTooltip: COLUMN_HELP.slaDueAt,
            value: (row) => row.slaDueAt,
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const sla = slaInfo(row.slaDueAt);
                return (
                    <ThemedView style={{ gap: "3px" }}>
                        <StatusChip label={sla.label} tone={sla.tone} size="x-small" />
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                            {formatDateTime(row.slaDueAt)}
                        </ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "assignee",
            label: "Assignee",
            headerTooltip: COLUMN_HELP.assignee,
            value: (row) => row.assigneeEmail ?? "",
            Value: ({ row }: { row: OperatorCaseSummary }) => (
                <ThemedText style={{ fontSize: "12px", opacity: row.assigneeEmail ? 1 : 0.55 }}>
                    {row.assigneeEmail || t("Unassigned")}
                </ThemedText>
            ),
        },
        {
            key: "inquirySchedule",
            label: "Inquiry schedule",
            sortable: false,
            headerTooltip: "The latest persisted gateway inquiry schedule for this case.",
            value: (row) => row.latestInquirySchedule?.status ?? "",
            Value: ({ row }) => {
                const schedule = row.latestInquirySchedule;
                if (!schedule) {
                    return <ThemedText style={{ fontSize: "11px", opacity: 0.5 }}>—</ThemedText>;
                }
                return (
                    <ThemedView style={{ gap: "3px" }}>
                        <StatusChip label={String(schedule.status ?? "").replaceAll("_", " ")} tone={statusTone(schedule.status)} size="x-small" />
                        {schedule.nextRunAt && (
                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(schedule.nextRunAt)}</ThemedText>
                        )}
                    </ThemedView>
                );
            },
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            headerTooltip: COLUMN_HELP.actions,
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const eligibility = row.inquiryEligibility;
                return (
                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center" }}>
                        <VBtn size="small" variant="text" prependIcon="mdi-eye-outline" onClick={() => openInspection(row)}>
                            {t("Inspect")}
                        </VBtn>
                        <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => openCase(row)}>
                            {t("Open")}
                        </VBtn>
                        <span
                            title={
                                eligibility?.eligible
                                    ? t("Schedule a gateway status inquiry")
                                    : reasonText(eligibility?.reason) || t("Inquiry is not available")
                            }
                        >
                            <VBtn
                                size="small"
                                variant="tonal"
                                color="primary"
                                loading={inquiringId.value === row.id}
                                disabled={!eligibility?.eligible || bulkLoading.value || !canInquire.value}
                                onClick={() => void inquireOne(row)}
                            >
                                {t("Inquire")}
                            </VBtn>
                        </span>
                    </ThemedView>
                );
            },
        },
    ];

    const selectedEligibleCount = computed(() => eligibleSelected.value.length);
    const selectedSkippedCount = computed(() => skippedSelected.value.length);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Operator Cases")}
                    subtitle={t("Triage unknown outcomes, conflicts and reconciliation breaks with SLA-aware operator workflows.")}
                    badge={summary.value ? `${summary.value.p1Open} ${t("P1 open")}` : t("P1 queue")}
                    badgeTone={summary.value && summary.value.p1Open > 0 ? "danger" : "info"}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            <StatusChip
                                label={`${total.value} ${t("cases")}`}
                                tone="info"
                                size="small"
                            />
                            <StatusChip
                                label={`${selectedCount.value} ${t("selected")}`}
                                tone={selectedCount.value > 0 ? "primary" : "neutral"}
                                size="small"
                            />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-radar" onClick={() => void router.push({ name: "GatewayInquirySchedules" })}>{t("Inquiry Schedule")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                {summary.value && (
                    <ThemedView style={{ gap: "12px" }}>
                        <MetricStrip items={summaryItems.value} />
                        <SurfaceCard variant="flat" style={{ borderRadius: "16px" }}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", flex: 1 }}>{t("Operator queue health")}</ThemedText>
                                    <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("P1 target: 4h · P2 target: 24h")}</ThemedText>
                                </ThemedView>
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
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    {Object.entries(summary.value.byPriority ?? {}).map(([priority, count]) => (
                                        <StatusChip key={priority} label={`${priority}: ${count}`} tone={statusTone(priority)} size="x-small" />
                                    ))}
                                    {Object.entries(summary.value.byState ?? {}).map(([state, count]) => (
                                        <StatusChip key={state} label={`${state.replaceAll("_", " ")}: ${count}`} tone={statusTone(state)} size="x-small" />
                                    ))}
                                </ThemedView>
                            </SurfaceCardText>
                        </SurfaceCard>
                    </ThemedView>
                )}

                <ApiTable<OperatorCaseSummary>
                    title={t("Operator Cases")}
                    url={urlsMap.operatorCases}
                    showNumber={true}
                    xlsx={true}
                    localSearch={false}
                    numberOfItemsPerPage={pageSize.value}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={onSearchChanged}
                    headers={headers}
                    rowColor={rowColor}
                    apiDataExtractor={(data) => {
                        const payload = data as { cases?: OperatorCaseSummary[]; rows?: OperatorCaseSummary[]; items?: OperatorCaseSummary[] };
                        return payload.cases ?? payload.rows ?? payload.items ?? [];
                    }}
                    apiTotalExtractor={(data) => {
                        const payload = data as { total?: number; cases?: OperatorCaseSummary[] };
                        return Number(payload.total ?? payload.cases?.length ?? 0);
                    }}
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
                    onRefresh={(props, refresh) => {
                        void refresh({
                            queryParams: {
                                page: props.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefinitions, filters.value),
                                ...(props.sortKey
                                    ? { sortKey: props.sortKey, sortDirection: props.sortDirection }
                                    : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <ThemedView style={{ gap: "14px" }}>
                            <TableFilters
                                filters={filterDefinitions}
                                values={filters.value}
                                total={total.value}
                                onChange={onFiltersChanged}
                                onClear={onFiltersCleared}
                            />
                            <ThemedView
                                style={{
                                    flexDirection: "row",
                                    gap: "12px",
                                    alignItems: "center",
                                    flexWrap: "wrap",
                                    padding: "12px 14px",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(100,116,139,0.25)",
                                    background: "rgba(100,116,139,0.06)",
                                }}
                            >
                                <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>
                                    {selectedCount.value} {t("selected")}
                                </ThemedText>
                                <StatusChip
                                    label={`${selectedEligibleCount.value} ${t("inquiry-ready")}`}
                                    tone="success"
                                    size="x-small"
                                />
                                <StatusChip
                                    label={`${selectedSkippedCount.value} ${t("will be skipped")}`}
                                    tone={selectedSkippedCount.value > 0 ? "warning" : "neutral"}
                                    size="x-small"
                                />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                    {t(
                                        "Only UNKNOWN or VERIFYING attempts on gateways with status inquiry are scheduled.",
                                    )}
                                </ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn
                                    size="small"
                                    variant="text"
                                    disabled={selectedCount.value === 0 || bulkLoading.value}
                                    onClick={clearSelection}
                                >
                                    {t("Clear selection")}
                                </VBtn>
                                <VBtn
                                    size="small"
                                    variant="tonal"
                                    prependIcon="mdi-account-arrow-right-outline"
                                    disabled={selectedCount.value === 0 || !canAssign.value}
                                    onClick={() => void openAssign()}
                                >
                                    {t("Assign selected")}
                                </VBtn>
                                <VBtn
                                    size="small"
                                    variant="tonal"
                                    prependIcon="mdi-progress-clock"
                                    disabled={selectedCount.value === 0 || !canAssign.value}
                                    onClick={openState}
                                >
                                    {t("Set state")}
                                </VBtn>
                                <VBtn
                                    size="small"
                                    color="primary"
                                    variant="flat"
                                    prependIcon="mdi-radar"
                                    loading={bulkLoading.value}
                                    disabled={selectedCount.value === 0 || !canInquire.value}
                                    onClick={() => openInquiry(Object.keys(selected.value))}
                                >
                                    {t("Inquire selected")} ({selectedCount.value})
                                </VBtn>
                            </ThemedView>
                            <VDivider />
                        </ThemedView>
                    )}
                />
            </ThemedView>

            <SlideOverDrawer
                modelValue={inspectionOpen.value}
                onUpdate:modelValue={(value: boolean) => (inspectionOpen.value = value)}
                title={inspectionCase.value?.caseRef || inspectionCase.value?.caseId || t("Operator case")}
                subtitle={inspectionCase.value ? `${inspectionCase.value.caseType} · ${inspectionCase.value.priority}` : ""}
            >
                {inspectionCase.value && (
                    <ThemedView style={{ gap: "16px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusChip label={inspectionCase.value.state} tone={statusTone(inspectionCase.value.state)} />
                            <StatusChip label={inspectionCase.value.priority} tone={statusTone(inspectionCase.value.priority)} />
                            <StatusChip label={slaInfo(inspectionCase.value.slaDueAt).label} tone={slaInfo(inspectionCase.value.slaDueAt).tone} />
                        </ThemedView>
                        <DescriptionList
                            columns={2}
                            items={[
                                { label: t("Operator case ID"), value: <MonoRef value={inspectionCase.value.id} /> },
                                { label: t("Case reference"), value: <MonoRef value={inspectionCase.value.caseRef} /> },
                                { label: t("Payment attempt ID"), value: <MonoRef value={inspectionCase.value.attemptId ?? ""} /> },
                                { label: t("Attempt reference"), value: <MonoRef value={inspectionCase.value.attemptReference ?? ""} /> },
                                { label: t("Merchant ID"), value: <MonoRef value={inspectionCase.value.merchantId ?? ""} /> },
                                { label: t("Merchant"), value: inspectionCase.value.merchantName || "—" },
                                { label: t("Rail / Gateway"), value: `${inspectionCase.value.railCode || "—"} · ${inspectionCase.value.gatewayCode || "—"}` },
                                { label: t("Provider reference"), value: <MonoRef value={inspectionCase.value.providerReference ?? ""} /> },
                                { label: t("Gateway reference"), value: <MonoRef value={inspectionCase.value.gatewayReference ?? ""} /> },
                                { label: t("Link key"), value: <MonoRef value={inspectionCase.value.linkSlot?.key ?? ""} /> },
                                { label: t("Opened"), value: formatDateTime(inspectionCase.value.openedAt) },
                                { label: t("SLA due"), value: formatDateTime(inspectionCase.value.slaDueAt) },
                                { label: t("Assignee"), value: inspectionCase.value.assigneeEmail || t("Unassigned") },
                            ]}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <VBtn variant="text" onClick={() => (inspectionOpen.value = false)}>{t("Close")}</VBtn>
                            <VBtn
                                variant="tonal"
                                color="primary"
                                disabled={!inspectionCase.value.inquiryEligibility?.eligible || !canInquire.value}
                                onClick={() => {
                                    const row = inspectionCase.value;
                                    inspectionOpen.value = false;
                                    if (row) void inquireOne(row);
                                }}
                            >
                                {t("Inquire")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                prependIcon="mdi-open-in-new"
                                onClick={() => {
                                    const row = inspectionCase.value;
                                    inspectionOpen.value = false;
                                    if (row) openCase(row);
                                }}
                            >
                                {t("Open")}
                            </VBtn>
                        </ThemedView>
                    </ThemedView>
                )}
            </SlideOverDrawer>

            <FormModal
                modelValue={inquiryOpen.value}
                onUpdate:modelValue={(value: boolean) => (inquiryOpen.value = value)}
                title={t("Inquire about selected cases")}
                size="md"
            >
<ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                            {t("Only eligible UNKNOWN or VERIFYING attempts on supported gateways are scheduled.")}
                        </ThemedText>
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Inquiry checklist")}</ThemedText>
                                {INQUIRY_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={inquiryChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (inquiryChecklist.value = { ...inquiryChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!inquiryChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all inquiry checklist items before continuing")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (inquiryOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={bulkLoading.value} disabled={!inquiryChecklistComplete.value} onClick={() => confirmInquiry()}>{t("Inquire")} ({inquiryCaseIds.value.length})</VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={assignOpen.value}
                onUpdate:modelValue={(value: boolean) => (assignOpen.value = value)}
                title={t("Assign selected cases")}
                size="md"
            >
<ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                            {t("Resolved and pending-checker cases are skipped automatically.")}
                        </ThemedText>
                        <VAutocomplete
                            label={t("Assignee")}
                            items={assignOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={assignUserId.value}
                            loading={assignOptionsLoading.value}
                            clearable
                            hint={t("Leave empty to unassign the selected cases.")}
                            persistentHint
                            onUpdate:modelValue={(value: unknown) => (assignUserId.value = value ? String(value) : null)}
                            onUpdate:search={(value: string) => void searchAssignees(value)}
                        />
                        <VTextField
                            label={t("Reason (optional)")}
                            modelValue={assignReason.value}
                            onUpdate:modelValue={(value: string) => (assignReason.value = value)}
                        />
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Assignment checklist")}</ThemedText>
                                {ASSIGN_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={assignChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (assignChecklist.value = { ...assignChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!assignChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all assignment checklist items before assigning")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (assignOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={assignSaving.value} disabled={!assignChecklistComplete.value} onClick={() => void assignSelected()}>
                                {t("Assign")} ({selectedCount.value})
                            </VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={stateOpen.value}
                onUpdate:modelValue={(value: boolean) => (stateOpen.value = value)}
                title={t("Set state for selected cases")}
                size="sm"
            >
<ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                            {t("Resolved, pending-checker and unchanged cases are skipped automatically.")}
                        </ThemedText>
                        <VSelect
                            label={t("State")}
                            items={["OPEN", "IN_PROGRESS"]}
                            modelValue={bulkState.value}
                            onUpdate:modelValue={(value: string | null) => (bulkState.value = value === "OPEN" ? "OPEN" : "IN_PROGRESS")}
                        />
                        <VTextField
                            label={t("Reason (optional)")}
                            modelValue={stateReason.value}
                            onUpdate:modelValue={(value: string) => (stateReason.value = value)}
                        />
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("State change checklist")}</ThemedText>
                                {STATE_CHANGE_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={stateChangeChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (stateChangeChecklist.value = { ...stateChangeChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!stateChangeChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all state checklist items before applying")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (stateOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={stateSaving.value} disabled={!stateChangeChecklistComplete.value} onClick={() => void applyBulkState()}>
                                {t("Apply")} ({selectedCount.value})
                            </VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={resultOpen.value}
                onUpdate:modelValue={(value: boolean | null) => (resultOpen.value = Boolean(value))}
                title={t("Bulk inquiry result")}
                size="lg"
            >
<ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <StatusChip
                                label={`${bulkResult.value?.scheduled ?? 0} ${t("scheduled")}`}
                                tone="success"
                            />
                            <StatusChip
                                label={`${bulkResult.value?.skipped ?? 0} ${t("skipped")}`}
                                tone={(bulkResult.value?.skipped ?? 0) > 0 ? "warning" : "neutral"}
                            />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            {(bulkResult.value?.results ?? []).map((result) => (
                                <ThemedView
                                    key={result.caseId}
                                    style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        gap: "10px",
                                        padding: "10px 12px",
                                        borderRadius: "10px",
                                        border: "1px solid rgba(100,116,139,0.2)",
                                    }}
                                >
                                    <StatusChip
                                        label={result.status}
                                        tone={result.status === "SCHEDULED" ? "success" : "warning"}
                                        size="x-small"
                                    />
                                    <ThemedView style={{ flex: 1, gap: "2px" }}>
                                        <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>
                                            {result.caseRef ?? result.caseId}
                                        </ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                            {result.attemptReference ?? result.attemptId ?? "—"} · {t(result.message)}
                                        </ThemedText>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>
                                        {reasonText(result.reason)}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </ThemedView>
                        <VBtn variant="tonal" onClick={() => (resultOpen.value = false)}>
                            {t("Close")}
                        </VBtn>
            </FormModal>
        </ScreenContainer>
    );
});

export default OperatorCasesPage;
