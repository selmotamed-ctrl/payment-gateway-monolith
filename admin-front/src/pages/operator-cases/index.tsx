import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useTheme } from "@/utils/vuetify-compat";
import { areChecklistsVisible } from "@/constants/env";
import {PgAlert, PgAutocomplete, PgButton, PgCheckbox, PgDivider, PgTextField, PgStack} from "@pg/ui";
import { useRouter } from "vue-router";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
import {ApiTable} from "@pg/ui";
import {TableRowActions} from "@pg/ui";
import {TableFilters} from "@pg/ui";
import {buildFilterQuery, type FilterValues} from "@pg/ui";
import { createOptionsLoader } from "@/tables/referenceOptions";
import { tableRegistry } from "@/tables/tableRegistry";
import {statusTone} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import {
    COLUMN_HELP,
    caseStateHelp,
    formatDateTime,
    priorityHelp,
    slaInfo,
} from "./operatorCaseHelp";
import type { BulkInquiryResult, OperatorCaseSummary } from "./types";
import { caseTypeMeta } from "./caseTypes";

import {FormModal} from "@pg/ui";
import {SurfaceCard, SurfaceCardText} from "@pg/ui";
import {SlideOverDrawer} from "@pg/ui";
import {DescriptionList} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {StatusBadge, type BadgeTone} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {FormField} from "@pg/ui";
import {SectionFields} from "@pg/ui";
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

const EXPORT_CHECKS = [
    { key: "CASE_SCOPE_VERIFIED", label: "Case scope and filters verified" },
    { key: "SENSITIVE_FIELDS_REVIEWED", label: "Sensitive case fields reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

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
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
    const theme = useTheme();
    const router = useRouter();

    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({
        state: ["OPEN", "IN_PROGRESS", "PENDING_CHECKER"],
    });
    const rows = ref<OperatorCaseSummary[]>([]);
    const total = ref(0);
    const summary = ref<OperatorCasesSummary | null>(null);
    const exportLoading = ref(false);
    const exportOpen = ref(false);
    const exportChecklist = ref<Record<string, boolean>>({});
    const exportChecklistComplete = computed(() => !showChecklists || EXPORT_CHECKS.every((check) => exportChecklist.value[check.key] === true));
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
        if (!exportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.operatorCasesExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions, filters.value),
                    checklist: EXPORT_CHECKS.filter((check) => exportChecklist.value[check.key]).map((check) => check.key).join(","),
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
            exportOpen.value = false;
            exportChecklist.value = {};
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
        return colors[tone] ?? colors["on-surface-variant"] ?? "var(--pg-ink-muted)";
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
    const bulkInquirySafeguard = useSafeguard("sg-bulk-inquiry");

    const confirmInquiry = () => {
        if (!inquiryChecklistComplete.value) return;
        inquiryOpen.value = false;
        void runBulkInquiry(inquiryCaseIds.value);
    };

    const runBulkInquiry = async (caseIds: string[]) => {
        if (caseIds.length === 0) return;
        if (!(await bulkInquirySafeguard.confirm())) return;
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
                    <PgCheckbox
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
                    <PgCheckbox
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
                <PgButton
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
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px" }}>
                        <span>{row.caseReference || row.caseRef}</span>
                        <span style={{ fontSize: "10px", fontWeight: 500, opacity: 0.6 }}>{row.title || caseTypeMeta(row.caseType).label}</span>
                    </span>
                </PgButton>
            ),
        },
        {
            key: "caseType",
            label: "Type",
            sortKey: "caseType",
            headerTooltip: COLUMN_HELP.caseType,
            value: (row) => row.caseType,
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const meta = caseTypeMeta(row.caseType);
                return <StatusBadge status={row.caseType} label={meta.label} toneOverride={meta.tone ?? "info"} />;
            },
        },
        {
            key: "context",
            label: "Context",
            headerTooltip: "The human subject and the relevant context for this case type.",
            value: (row) => [row.title, row.subjectLabel, row.merchantTradeName, row.attemptReference, row.statementAmount, row.chargedAmount].filter(Boolean).join(" "),
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const meta = caseTypeMeta(row.caseType);
                const amount = row.chargedAmount ?? row.statementAmount;
                return (
                    <ThemedView style={{ gap: "4px", minWidth: 0 }}>
                        <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>{row.title || meta.label}</ThemedText>
                        <ThemedText style={{ fontSize: "11px", opacity: 0.65, overflowWrap: "anywhere" }}>
                            {row.attemptId
                                ? [row.merchantTradeName || row.merchantLegalName, row.attemptReference, amount ? `${amount} ${row.currency ?? ""}`.trim() : null].filter(Boolean).join(" · ")
                                : ([row.subjectLabel, row.summary].filter(Boolean).join(" · ") || meta.meaning)}
                        </ThemedText>
                    </ThemedView>
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
                    <StatusBadge status={row.priority} label={row.priority} toneOverride={asBadgeTone(statusTone(row.priority))} />
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
                    <StatusBadge status={row.state} label={row.state} toneOverride={asBadgeTone(statusTone(row.state))} />
                </span>
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
                        <StatusBadge status={sla.label} label={sla.label} toneOverride={asBadgeTone(sla.tone)} />
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
            key: "actions",
            label: "Actions",
            sortable: false,
            headerTooltip: COLUMN_HELP.actions,
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const eligibility = row.inquiryEligibility;
                return (
                    <div
                        title={
                            eligibility?.eligible
                                ? t("Schedule a gateway status inquiry")
                                : reasonText(eligibility?.reason) || t("Inquiry is not available")
                        }
                        style={{ display: "inline-flex" }}
                    >
                        <TableRowActions
                            primaryAction={{
                                label: t("Open"),
                                icon: "mdi-open-in-new",
                                onClick: () => openCase(row),
                            }}
                            items={[
                                ...(row.attemptId
                                    ? [{
                                        key: "inquire",
                                        label: t("Inquire gateway"),
                                        icon: "mdi-radar",
                                        disabled: !eligibility?.eligible || bulkLoading.value || !canInquire.value,
                                        onClick: () => void inquireOne(row),
                                    }]
                                    : []),
                                {
                                    key: "inspect",
                                    label: t("Quick inspect"),
                                    icon: "mdi-eye-outline",
                                    onClick: () => openInspection(row),
                                },
                            ]}
                        />
                    </div>
                );
            },
        },
    ];

    const selectedEligibleCount = computed(() => eligibleSelected.value.length);
    const selectedSkippedCount = computed(() => skippedSelected.value.length);

    return () => (
        <ScreenContainer>
            <PgStack gap="lg">
                <PageHeader title={t("Operator Cases")} subtitle={t("Triage unknown outcomes, conflicts and reconciliation breaks with SLA-aware operator workflows.")} badge={summary.value ? `${summary.value.p1Open} ${t("P1 open")}` : t("P1 queue")} badgeTone={summary.value && summary.value.p1Open > 0 ? "danger" : "info"}>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            <StatusBadge status="cases" label={`${total.value} ${t("cases")}`} toneOverride="info" showDot={false} />
                            <StatusBadge status="selected" label={`${selectedCount.value} ${t("selected")}`} toneOverride={selectedCount.value > 0 ? "info" : "neutral"} showDot={false} />
                            <PgButton variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</PgButton>
                            <PgButton variant="tonal" prependIcon="mdi-radar" onClick={() => void router.push({ name: "GatewayInquirySchedules" })}>{t("Inquiry Schedule")}</PgButton>
                            <PgButton variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => { exportChecklist.value = {}; exportOpen.value = true; }}>{t("Export Excel")}</PgButton>
                        </ThemedView>
                </PageHeader>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Operator queue health")}
                        metrics={summaryItems.value}
                        exportLoading={summaryExportLoading.value}
                        exportDisabled={!summaryExportChecklistComplete.value}
                        exportLabel={t("Export summary")}
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
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                            <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("P1 target: 4h · P2 target: 24h")}</ThemedText>
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byPriority ?? {}).map(([priority, count]) => (
                                <StatusBadge key={priority} status={priority} label={`${priority}: ${count}`} toneOverride={asBadgeTone(statusTone(priority))} showDot={false} />
                            ))}
                            {Object.entries(summary.value.byState ?? {}).map(([state, count]) => (
                                <StatusBadge key={state} status={state} label={`${state.replaceAll("_", " ")}: ${count}`} toneOverride={asBadgeTone(statusTone(state))} showDot={false} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
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
                                    borderRadius: "var(--pg-radius-md)",
                                    border: "1px solid var(--pg-border-subtle)",
                                    background: "var(--pg-bg-surface-subtle)",
                                }}
                            >
                                <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>
                                    {selectedCount.value} {t("selected")}
                                </ThemedText>
                                <StatusBadge status="eligible" label={`${selectedEligibleCount.value} ${t("inquiry-ready")}`} toneOverride="success" />
                                <StatusBadge status="skipped" label={`${selectedSkippedCount.value} ${t("will be skipped")}`} toneOverride={selectedSkippedCount.value > 0 ? "warning" : "neutral"} />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                    {t(
                                        "Only UNKNOWN or VERIFYING attempts on gateways with status inquiry are scheduled.",
                                    )}
                                </ThemedText>
                                <div style={{ flex: 1 }} />
                                <PgButton
                                    size="small"
                                    variant="text"
                                    disabled={selectedCount.value === 0 || bulkLoading.value}
                                    onClick={clearSelection}
                                >
                                    {t("Clear selection")}
                                </PgButton>
                                <PgButton
                                    size="small"
                                    variant="tonal"
                                    prependIcon="mdi-account-arrow-right-outline"
                                    disabled={selectedCount.value === 0 || !canAssign.value}
                                    onClick={() => void openAssign()}
                                >
                                    {t("Assign selected")}
                                </PgButton>
                                <PgButton
                                    size="small"
                                    variant="tonal"
                                    prependIcon="mdi-progress-clock"
                                    disabled={selectedCount.value === 0 || !canAssign.value}
                                    onClick={openState}
                                >
                                    {t("Set state")}
                                </PgButton>
                                <PgButton
                                    size="small"
                                    color="primary"
                                    variant="flat"
                                    prependIcon="mdi-radar"
                                    loading={bulkLoading.value}
                                    disabled={selectedCount.value === 0 || !canInquire.value}
                                    onClick={() => openInquiry(Object.keys(selected.value))}
                                >
                                    {t("Inquire selected")} ({selectedCount.value})
                                </PgButton>
                            </ThemedView>
                            <PgDivider />
                        </ThemedView>
                    )}
                />
            </PgStack>

            <SlideOverDrawer
                modelValue={inspectionOpen.value}
                onUpdate:modelValue={(value: boolean) => (inspectionOpen.value = value)}
                title={inspectionCase.value?.caseRef || inspectionCase.value?.caseId || t("Operator case")}
                subtitle={inspectionCase.value ? `${inspectionCase.value.caseType} · ${inspectionCase.value.priority}` : ""}
            >
                {inspectionCase.value && (
                    <ThemedView style={{ gap: "16px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge status={inspectionCase.value.state} label={inspectionCase.value.state} toneOverride={asBadgeTone(statusTone(inspectionCase.value.state))} />
                            <StatusBadge status={inspectionCase.value.priority} label={inspectionCase.value.priority} toneOverride={asBadgeTone(statusTone(inspectionCase.value.priority))} />
                            <StatusBadge status={slaInfo(inspectionCase.value.slaDueAt).label} label={slaInfo(inspectionCase.value.slaDueAt).label} toneOverride={asBadgeTone(slaInfo(inspectionCase.value.slaDueAt).tone)} />
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
                            <PgButton variant="text" onClick={() => (inspectionOpen.value = false)}>{t("Close")}</PgButton>
                            <PgButton
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
                            </PgButton>
                            <PgButton
                                color="primary"
                                prependIcon="mdi-open-in-new"
                                onClick={() => {
                                    const row = inspectionCase.value;
                                    inspectionOpen.value = false;
                                    if (row) openCase(row);
                                }}
                            >
                                {t("Open")}
                            </PgButton>
                        </ThemedView>
                    </ThemedView>
                )}
            </SlideOverDrawer>

            <FormModal
                modelValue={exportOpen.value}
                onUpdate:modelValue={(value: boolean) => (exportOpen.value = value)}
                title={t("Export operator cases")}
                size="md"
                loading={exportLoading.value}
                submitLabel={t("Export")}
                onSubmit={() => void exportExcel()}
            >
                <PgAlert tone="warning">{t("The export contains merchant, attempt and resolution details. Handle the file as confidential operational evidence.")}</PgAlert>
                <FormChecklist
                    checks={[...EXPORT_CHECKS]}
                    modelValue={exportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (exportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Case export checklist")}
                    complete={exportChecklistComplete.value}
                    incompleteMessage={t("Complete all export checklist items before exporting")}
                />
            </FormModal>

            <FormModal
                modelValue={inquiryOpen.value}
                onUpdate:modelValue={(value: boolean) => (inquiryOpen.value = value)}
                title={t("Inquire about selected cases")}
                size="md"
                onSubmit={confirmInquiry}
                submitLabel={`${t("Inquire")} (${inquiryCaseIds.value.length})`}
                cancelLabel={t("Cancel")}
                loading={bulkLoading.value}
                danger={false}
            >
                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                    {t("Only eligible UNKNOWN or VERIFYING attempts on supported gateways are scheduled.")}
                </ThemedText>
                {showChecklists && (
                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Inquiry checklist")}</ThemedText>
                        {INQUIRY_CHECKS.map((check) => (
                            <PgCheckbox
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
            </FormModal>

            <FormModal
                modelValue={assignOpen.value}
                onUpdate:modelValue={(value: boolean) => (assignOpen.value = value)}
                title={t("Assign selected cases")}
                size="md"
                onSubmit={() => void assignSelected()}
                submitLabel={`${t("Assign")} (${selectedCount.value})`}
                cancelLabel={t("Cancel")}
                loading={assignSaving.value}
            >
                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                    {t("Resolved and pending-checker cases are skipped automatically.")}
                </ThemedText>
                <SectionFields title={t("Assignment details")}>
                    <FormField
                        label={t("Assignee")}
                        hint={t("Leave empty to unassign the selected cases.")}
                    >
                        <PgAutocomplete
                            items={assignOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={assignUserId.value}
                            loading={assignOptionsLoading.value}
                            clearable
                            onUpdate:modelValue={(value: unknown) => (assignUserId.value = value ? String(value) : null)}
                            onUpdate:search={(value: string) => void searchAssignees(value)}
                        />
                    </FormField>
                    <FormField label={t("Reason (optional)")}>
                        <PgTextField
                            modelValue={assignReason.value}
                            onUpdate:modelValue={(value: string) => (assignReason.value = value)}
                        />
                    </FormField>
                </SectionFields>
                {showChecklists && (
                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Assignment checklist")}</ThemedText>
                        {ASSIGN_CHECKS.map((check) => (
                            <PgCheckbox
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
            </FormModal>

            <FormModal
                modelValue={stateOpen.value}
                onUpdate:modelValue={(value: boolean) => (stateOpen.value = value)}
                title={t("Set state for selected cases")}
                size="sm"
                onSubmit={() => void applyBulkState()}
                submitLabel={`${t("Apply")} (${selectedCount.value})`}
                cancelLabel={t("Cancel")}
                loading={stateSaving.value}
            >
                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                    {t("Resolved, pending-checker and unchanged cases are skipped automatically.")}
                </ThemedText>
                <SectionFields title={t("State change")}>
                    <FormField label={t("State")} required>
                        <PgAutocomplete
                            items={["OPEN", "IN_PROGRESS"]}
                            modelValue={bulkState.value}
                            onUpdate:modelValue={(value: string | null) => (bulkState.value = value === "OPEN" ? "OPEN" : "IN_PROGRESS")}
                        />
                    </FormField>
                    <FormField label={t("Reason (optional)")}>
                        <PgTextField
                            modelValue={stateReason.value}
                            onUpdate:modelValue={(value: string) => (stateReason.value = value)}
                        />
                    </FormField>
                </SectionFields>
                {showChecklists && (
                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("State change checklist")}</ThemedText>
                        {STATE_CHANGE_CHECKS.map((check) => (
                            <PgCheckbox
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
            </FormModal>

            <FormModal
                modelValue={resultOpen.value}
                onUpdate:modelValue={(value: boolean | null) => (resultOpen.value = Boolean(value))}
                title={t("Bulk inquiry result")}
                size="lg"
                v-slots={{
                    footer: () => (
                        <PgButton variant="tonal" onClick={() => (resultOpen.value = false)}>
                            {t("Close")}
                        </PgButton>
                    ),
                }}
            >
                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                    <StatusBadge status="scheduled" label={`${bulkResult.value?.scheduled ?? 0} ${t("scheduled")}`} toneOverride="success" />
                    <StatusBadge status="skipped" label={`${bulkResult.value?.skipped ?? 0} ${t("skipped")}`} toneOverride={(bulkResult.value?.skipped ?? 0) > 0 ? "warning" : "neutral"} />
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
                                borderRadius: "var(--pg-radius-lg)",
                                border: "1px solid var(--pg-border-subtle)",
                            }}
                        >
                            <StatusBadge
                                status={result.status}
                                label={result.status}
                                toneOverride={result.status === "SCHEDULED" ? "success" : "warning"}
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
            </FormModal>
        </ScreenContainer>
    );
});

export default OperatorCasesPage;
