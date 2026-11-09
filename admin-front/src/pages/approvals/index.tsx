import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCheckbox, VProgressCircular, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { statusTone } from "@/components/Table/statusTone";
import { JsonDiffViewer } from "@/components/ui/JsonDiffViewer";
import { humanizeKey } from "@/components/ui/jsonDiffModel";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { areChecklistsVisible, areHelpPanelsVisible } from "@/constants/env";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import ApprovalHelpPanel from "./components/ApprovalHelpPanel";
import {
    APPROVAL_BLOCK_REASON_HELP,
    APPROVAL_DOMAIN_HELP,
    APPROVAL_STATE_HELP,
} from "./approvalHelp";
import type { ApprovalDetail, ApprovalRow, ApprovalSummary } from "./types";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionFields } from "@/components/SectionFields";
type ApprovalView = "pending" | "history" | "all";

const SUMMARY_EXPORT_CHECKS = [
    { key: "PENDING_SCOPE_VERIFIED", label: "Pending approval scope verified" },
    { key: "EXPIRY_REVIEWED", label: "Expiry and emergency status reviewed" },
    { key: "DOMAIN_BREAKDOWN_REVIEWED", label: "Domain breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const BULK_REJECT_CHECKS = [
    { key: "SELECTION_REVIEWED", label: "Selected requests reviewed" },
    { key: "REASONS_DOCUMENTED", label: "Rejection reasons documented" },
    { key: "MAKER_NOTIFICATION_PLANNED", label: "Maker notification planned" },
    { key: "CHECKER_AUTHORITY_CONFIRMED", label: "Checker authority confirmed" },
] as const;

const APPROVAL_CHECKS = [
    { key: "DIFF_REVIEWED", label: "Diff reviewed" },
    { key: "SUBJECT_CONTEXT_REVIEWED", label: "Subject context reviewed" },
    { key: "MAKER_CHECKER_SEPARATION_VERIFIED", label: "Maker/checker separation verified" },
    { key: "RISK_ASSESSED", label: "Risk assessed" },
] as const;

const PENDING_STATES = ["PENDING_REVIEW"];
const HISTORY_STATES = ["APPROVED", "EXECUTED", "REJECTED", "EXPIRED"];

/** `POS_TERMINAL` -> `POS Terminal`, `AML_CASE` -> `AML Case` (translated at the call site). */
const subjectTypeLabel = (value: string): string => humanizeKey(value);

const kindLabel = (value: string): string => value.replaceAll("_", " ");

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

const ApprovalsPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();
    const showChecklists = areChecklistsVisible();
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
    const rows = ref<ApprovalRow[]>([]);
    const total = ref(0);
    const selectedApprovals = ref<Record<string, ApprovalRow>>({});
    const bulkRejectOpen = ref(false);
    const bulkRejectReason = ref("");
    const bulkRejectLoading = ref(false);
    const bulkRejectError = ref<string | null>(null);
    const bulkRejectChecklist = ref<Record<string, boolean>>({});
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const summary = ref<ApprovalSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<ApprovalView>("pending");
    const filters = ref<FilterValues>({ state: [...PENDING_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const selected = ref<ApprovalDetail | null>(null);
    const detailLoading = ref(false);
    const decisionReason = ref("");
    const outcome = ref<"WON" | "LOST" | "">("");
    const riskAcceptanceNote = ref("");
    const actionLoading = ref(false);
    const decisionChecklist = ref<Record<string, boolean>>({});

    const filterDefinitions = computed(() => tableRegistry.Approvals?.filters ?? []);
    const selectedList = computed(() => Object.values(selectedApprovals.value));
    const selectedCount = computed(() => selectedList.value.length);
    const allVisibleSelected = computed(
        () => rows.value.length > 0 && rows.value.every((row) => row.state !== "PENDING_REVIEW" || Boolean(selectedApprovals.value[row.id])),
    );
    const someVisibleSelected = computed(
        () => rows.value.some((row) => Boolean(selectedApprovals.value[row.id])) && !allVisibleSelected.value,
    );
    const clearSelection = () => {
        selectedApprovals.value = {};
    };
    const toggleRow = (row: ApprovalRow, value: boolean | null) => {
        if (row.state !== "PENDING_REVIEW") return;
        if (value) selectedApprovals.value = { ...selectedApprovals.value, [row.id]: row };
        else {
            const next = { ...selectedApprovals.value };
            delete next[row.id];
            selectedApprovals.value = next;
        }
    };
    const toggleVisible = (value: boolean | null) => {
        if (!value) {
            const next = { ...selectedApprovals.value };
            for (const row of rows.value) delete next[row.id];
            selectedApprovals.value = next;
            return;
        }
        const next = { ...selectedApprovals.value };
        for (const row of rows.value) {
            if (row.state === "PENDING_REVIEW") next[row.id] = row;
        }
        selectedApprovals.value = next;
    };
    const openBulkReject = () => {
        if (selectedCount.value === 0) return;
        bulkRejectReason.value = "";
        bulkRejectError.value = null;
        bulkRejectChecklist.value = {};
        bulkRejectOpen.value = true;
    };
    const bulkRejectChecklistComplete = computed(() => !showChecklists || BULK_REJECT_CHECKS.every((check) => bulkRejectChecklist.value[check.key] === true));

    const runBulkReject = async () => {
        if (selectedCount.value === 0 || bulkRejectLoading.value) return;
        if (bulkRejectReason.value.trim().length < 2) {
            bulkRejectError.value = t("A rejection reason of at least 2 characters is required.");
            return;
        }
        if (!bulkRejectChecklistComplete.value) {
            bulkRejectError.value = t("Complete all bulk rejection checklist items before continuing.");
            return;
        }
        bulkRejectLoading.value = true;
        bulkRejectError.value = null;
        try {
            const response = await api.post(urlsMap.approvalsBulkReject, {
                approvalIds: Object.keys(selectedApprovals.value),
                reason: bulkRejectReason.value.trim(),
                checklist: BULK_REJECT_CHECKS.filter((check) => bulkRejectChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rejected = Number(payload.rejected ?? 0);
            const failed = Number(payload.failed ?? 0);
            const failedIds = new Set(
                (Array.isArray(payload.results) ? payload.results : [])
                    .filter((item: Record<string, unknown>) => item.status === "FAILED")
                    .map((item: Record<string, unknown>) => String(item.approvalId ?? "")),
            );
            selectedApprovals.value = Object.fromEntries(
                Object.entries(selectedApprovals.value).filter(([id]) => failedIds.has(id)),
            );
            showSnackBar({
                type: failed > 0 ? "warning" : "success",
                message: `${t("Rejected")}: ${rejected} · ${t("Failed")}: ${failed}`,
            });
            bulkRejectOpen.value = false;
            refreshAll();
        } catch (e) {
            bulkRejectError.value = extractApiErrorMessage(e);
        } finally {
            bulkRejectLoading.value = false;
        }
    };

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.approvalsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as ApprovalSummary;
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
        filters.value = activeView.value === "pending"
            ? { state: [...PENDING_STATES] }
            : activeView.value === "history"
              ? { state: [...HISTORY_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const setView = (view: ApprovalView) => {
        activeView.value = view;
        filters.value = view === "pending"
            ? { state: [...PENDING_STATES] }
            : view === "history"
              ? { state: [...HISTORY_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.approvalsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.approvals ?? []) as ApprovalRow[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No approvals match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = [
                "id",
                "subjectType",
                "subjectId",
                "domain",
                "kind",
                "state",
                "mode",
                "maker",
                "checker",
                "createdAt",
                "expiresAt",
                "ageHours",
            ];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.subjectType,
                        row.subjectId,
                        row.domain,
                        row.kind,
                        row.state,
                        row.mode,
                        row.makerName || row.makerUserId,
                        row.checkerName || "",
                        row.createdAt,
                        row.expiresAt ?? "",
                        row.ageHours,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `approvals-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const subjectRoute = (
        row: ApprovalRow,
    ): { name: string; params?: Record<string, string>; query?: Record<string, string> } | null => {
        switch (row.subjectType) {
            case "MERCHANT":
                return { name: "MerchantDetail", params: { id: row.subjectId } };
            case "JOIN_REQUEST":
                return { name: "JoinRequestDetail", params: { id: row.subjectId } };
            case "OPERATOR_CASE":
                return { name: "OperatorCaseDetail", params: { id: row.subjectId } };
            case "COMMISSION_PROFILE":
                return { name: "PricingControls", query: { tab: "COMMISSION" } };
            case "VELOCITY_RULE":
                return { name: "PricingControls", query: { tab: "VELOCITY" } };
            default:
                return null;
        }
    };

    const openSubject = (row: ApprovalRow) => {
        const target = subjectRoute(row);
        if (target) void router.push(target);
    };

    const resetDecisionState = () => {
        decisionReason.value = "";
        outcome.value = "";
        riskAcceptanceNote.value = "";
        decisionChecklist.value = {};
    };

    const presentApprovalDetail = (detail: ApprovalDetail) => {
        selected.value = detail;
        resetDecisionState();
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchApprovalDetail = async (id: string): Promise<ApprovalDetail | null> => {
        const response = await api.get(urlsMap.approvalDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.approval ?? payload) as ApprovalDetail;
    };

    const openDetails = async (row: ApprovalRow) => {
        selected.value = {
            ...row,
            subjectContext: null,
            canCheck: false,
            canApprove: false,
            checkBlockedReason: null,
        };
        resetDecisionState();
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchApprovalDetail(row.id);
            if (detail) presentApprovalDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<ApprovalDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchApprovalDetail,
        onOpenRecord: presentApprovalDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("Approval not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };

    const requiresOutcome = computed(() =>
        selected.value?.subjectType === "ADJUSTMENT" && selected.value?.kind === "CHARGEBACK",
    );

    const canApprove = computed(() => selected.value?.canApprove === true);
    const canReject = computed(() => selected.value?.canCheck === true);
    const blockMessage = computed(() => {
        const reason = selected.value?.checkBlockedReason;
        if (!reason) return null;
        return APPROVAL_BLOCK_REASON_HELP[reason] ?? reason.replaceAll("_", " ");
    });

    const decisionChecklistComplete = computed(() => !showChecklists || APPROVAL_CHECKS.every((check) => decisionChecklist.value[check.key] === true));
    const approveSafeguard = useSafeguard("sg-approve-request");
    const rejectSafeguard = useSafeguard("sg-reject-request");

    const decide = async (approve: boolean) => {
        if (!selected.value) return;
        if (approve && !canApprove.value) return;
        if (!approve && !canReject.value) return;
        const reason = decisionReason.value.trim();
        if (!approve && reason.length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        if (approve && requiresOutcome.value && !outcome.value) {
            showSnackBar({ type: "warning", message: t("Choose the chargeback outcome before approving") });
            return;
        }
        if (!decisionChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all decision checklist items before deciding") });
            return;
        }
        const safeguardConfirmed = await (approve ? approveSafeguard : rejectSafeguard).confirm();
        if (!safeguardConfirmed) return;
        actionLoading.value = true;
        try {
            const response = await api.post(
                approve ? urlsMap.approvalApprove(selected.value.id) : urlsMap.approvalReject(selected.value.id),
                {
                    ...(approve && requiresOutcome.value && outcome.value ? { outcome: outcome.value } : {}),
                    ...(reason ? { reason } : {}),
                    ...(approve && riskAcceptanceNote.value.trim() ? { riskAcceptanceNote: riskAcceptanceNote.value.trim() } : {}),
                    checklist: APPROVAL_CHECKS.filter((check) => decisionChecklist.value[check.key]).map((check) => check.key),
                },
            );
            const payload = response.data?.data ?? response.data ?? {};
            closeDetails();
            showSnackBar({
                type: "success",
                message: approve
                    ? payload.status === "QUEUED"
                        ? t("Approved and queued for execution")
                        : t("Approved")
                    : t("Rejected"),
            });
            refreshAll();
        } catch (error) {
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
            const response = await api.get(urlsMap.approvalsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = payload as ApprovalSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total_pending", snapshot.totalPending],
                ["expired", snapshot.expired],
                ["expiring_soon", snapshot.expiringSoon],
                ["emergency_due", snapshot.emergencyDue],
                ["oldest_age_hours", snapshot.oldestAgeHours],
            ];
            for (const [state, count] of Object.entries(snapshot.byState ?? {})) rows.push([`state.${state}.count`, count]);
            for (const item of snapshot.bySubjectType ?? []) rows.push([`subject.${item.subjectType}.count`, item.count]);
            for (const item of snapshot.byDomain ?? []) rows.push([`domain.${item.domain}.count`, item.count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `approval-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Approval summary exported") });
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
                key: "pending",
                label: t("Open requests"),
                value: String(data.totalPending),
                subLabel: t("Awaiting checker"),
                badge: data.totalPending > 0 ? t("P1") : t("Clear"),
                badgeTone: data.totalPending > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "expiringSoon",
                label: t("Expiring in 24h"),
                value: String(data.expiringSoon),
                subLabel: t("SLA window"),
                badge: data.expiringSoon > 0 ? t("P2") : t("Clear"),
                badgeTone: data.expiringSoon > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "expired",
                label: t("Expired"),
                value: String(data.expired),
                subLabel: t("No longer actionable"),
                badge: data.expired > 0 ? t("P1") : t("Clear"),
                badgeTone: data.expired > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "emergency",
                label: t("Emergency due"),
                value: String(data.emergencyDue),
                subLabel: t("Ratification window"),
                badge: data.emergencyDue > 0 ? t("Critical") : t("Clear"),
                badgeTone: data.emergencyDue > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "oldest",
                label: t("Oldest pending"),
                value: `${data.oldestAgeHours}h`,
                subLabel: t("Queue ageing"),
                badge: data.oldestAgeHours >= 72 ? t("P1") : data.oldestAgeHours >= 24 ? t("P2") : t("Clear"),
                badgeTone: data.oldestAgeHours >= 72 ? "danger" as const : data.oldestAgeHours >= 24 ? "warning" as const : "success" as const,
            },
        ];
    });

    const contextRows = computed(() => {
        const context = selected.value?.subjectContext;
        if (!context) return [];
        const rows: Array<{ label: string; value: string }> = [];
        const push = (label: string, value: unknown) => {
            if (value === null || value === undefined || value === "") return;
            rows.push({ label, value: String(value) });
        };
        push(t("Type"), t(subjectTypeLabel(String(context.contextType ?? selected.value?.subjectType ?? ""))));
        push(t("Reference"), context.id ?? selected.value?.subjectId);
        push(t("Merchant"), context.merchant?.tradeName ?? context.merchant?.legalName ?? context.tradeName ?? context.legalName ?? context.displayName);
        push(t("Status"), context.status);
        push(t("KYB"), context.kybStatus);
        push(t("Risk"), context.riskTier);
        push(t("Channel"), context.onboardingChannel);
        push(t("Submitted"), context.submittedAt ? formatDateTime(String(context.submittedAt)) : null);
        push(t("SLA due"), context.slaDueAt ? formatDateTime(String(context.slaDueAt)) : null);
        push(t("Adjustment type"), context.type);
        push(t("Amount"), context.amount);
        push(t("Adjustment state"), context.state);
        push(t("Operator priority"), context.priority);
        push(t("Operator kind"), context.kind);
        push(t("AML severity"), context.severity);
        push(t("Trigger"), context.triggerReason);
        push(t("Version"), context.versionNumber);
        push(t("Gateway"), context.gateway && typeof context.gateway === "object" ? `${(context.gateway as Record<string, unknown>).code ?? ""} ${(context.gateway as Record<string, unknown>).name ?? ""}`.trim() : null);
        push(t("Role"), context.role);
        push(t("Setting key"), context.key);
        push(t("Report type"), context.reportType);
        push(t("Rail code"), context.railCode);
        push(t("Calculation"), context.calcType);
        push(t("Flat fee"), context.flatFee);
        push(t("Percentage"), context.percentageRate);
        push(t("Fee bearer"), context.feeBearerDefault);
        push(t("Scope type"), context.scopeType);
        push(t("Scope value"), context.scopeValue);
        push(t("Window seconds"), context.windowSeconds);
        push(t("Max count"), context.maxCount);
        push(t("Max amount"), context.maxAmount);
        push(t("Action"), context.action);
        push(t("Active"), context.active === undefined ? null : context.active ? t("Yes") : t("No"));
        push(t("Effective from"), context.effectiveFrom ? formatDateTime(String(context.effectiveFrom)) : null);
        push(t("Effective to"), context.effectiveTo ? formatDateTime(String(context.effectiveTo)) : null);
        return rows;
    });

    const headers = computed<TableHeader<ApprovalRow>[]>(() => [
        {
            key: "select",
            label: "",
            sortable: false,
            headerCellStyle: { justifyContent: "center" },
            Header: () => (
                <span style={{ width: "28px", height: "40px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <VCheckbox
                        modelValue={allVisibleSelected.value}
                        indeterminate={someVisibleSelected.value}
                        onUpdate:modelValue={(value: boolean | null) => toggleVisible(value)}
                        density="compact"
                        hideDetails
                        aria-label="Select all pending approvals on this page"
                    />
                </span>
            ),
            Value: ({ row }: { row: ApprovalRow }) => (
                <ThemedView style={{ width: "28px", height: "40px", alignItems: "center", justifyContent: "center" }}>
                    <VCheckbox
                        modelValue={Boolean(selectedApprovals.value[row.id])}
                        onUpdate:modelValue={(value: boolean | null) => toggleRow(row, value)}
                        disabled={row.state !== "PENDING_REVIEW"}
                        density="compact"
                        hideDetails
                        aria-label={`Select approval ${row.id}`}
                    />
                </ThemedView>
            ),
        },
        {
            key: "subject",
            label: "Subject",
            sortKey: "subjectType",
            headerTooltip: "The entity that will change when this request is approved.",
            value: (row) => `${row.subjectType} ${row.subjectId}`,
            Value: ({ row }: { row: ApprovalRow }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t(subjectTypeLabel(row.subjectType))}</ThemedText>
                    <MonoRef value={row.subjectId} truncate={18} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{kindLabel(row.kind)}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "domain",
            label: "Domain",
            headerTooltip: "The risk domain that owns this request. A checker may only act inside their authorised domains.",
            value: (row) => row.domain,
            Value: ({ row }: { row: ApprovalRow }) => <span title={APPROVAL_DOMAIN_HELP[row.domain]}><StatusBadge status={row.domain} label={row.domain} toneOverride="neutral" /></span>,
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            value: (row) => row.state,
            Value: ({ row }: { row: ApprovalRow }) => {
                const help = APPROVAL_STATE_HELP[row.state];
                return <span title={help?.meaning}><StatusBadge status={row.state} label={help?.label ?? row.state} toneOverride={asBadgeTone(help?.tone ?? statusTone(row.state))} /></span>;
            },
        },
        {
            key: "mode",
            label: "Mode",
            sortKey: "mode",
            value: (row) => row.mode,
            Value: ({ row }: { row: ApprovalRow }) => (
                <StatusBadge
                    status={row.mode}
                    label={row.mode === "EMERGENCY_RATIFICATION" ? t("Emergency") : t("Standard")}
                    toneOverride={row.mode === "EMERGENCY_RATIFICATION" ? "danger" : "neutral"}
                />
            ),
        },
        {
            key: "maker",
            label: "Maker",
            value: (row) => row.makerName,
            Value: ({ row }: { row: ApprovalRow }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.makerName || row.makerUserId}</ThemedText>,
        },
        {
            key: "checker",
            label: "Checker",
            value: (row) => row.checkerName,
            Value: ({ row }: { row: ApprovalRow }) => <ThemedText style={{ fontSize: "11px", direction: "ltr", opacity: row.checkerName ? 1 : 0.55 }}>{row.checkerName || "—"}</ThemedText>,
        },
        {
            key: "age",
            label: "Age",
            headerTooltip: "How long this request has been waiting. Ageing above 24 hours is highlighted; above 72 hours is critical.",
            value: (row) => String(row.ageHours),
            Value: ({ row }: { row: ApprovalRow }) => (
                <StatusBadge status="age" label={`${row.ageHours}h`} toneOverride={row.ageHours >= 72 ? "danger" : row.ageHours >= 24 ? "warning" : "neutral"} />
            ),
        },
        {
            key: "expires",
            label: "Expires",
            sortKey: "expiresAt",
            value: (row) => row.expiresAt ?? "",
            Value: ({ row }: { row: ApprovalRow }) => (
                row.expired
                    ? <StatusBadge status="Expired" label={t("Expired")} toneOverride="danger" />
                    : <ThemedText style={{ fontSize: "11px", opacity: row.expiresInHours !== null && row.expiresInHours <= 24 ? 1 : 0.7 }}>
                        {row.expiresInHours === null ? t("No expiry") : `${row.expiresInHours}h`}
                    </ThemedText>
            ),
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: ApprovalRow }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Review"),
                        icon: "mdi-file-compare",
                        onClick: () => void openDetails(row),
                    }}
                    items={[
                        {
                            key: "subject",
                            label: t("Open subject"),
                            icon: "mdi-open-in-new",
                            hidden: !subjectRoute(row),
                            onClick: () => openSubject(row),
                        },
                    ]}
                />
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Approvals")}
                    subtitle={t("Review maker-checker requests, inspect the proposed diff and decide with an independent check.")}
                    badge={summary.value ? `${summary.value.totalPending} ${t("Pending")}` : t("Four eyes")}
                    badgeTone={summary.value && summary.value.totalPending > 0 ? "warning" : "success"}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Maker and checker must always be different people. Read the diff before deciding. All decisions are audited.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Queue health")}
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
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {summary.value.byDomain.map((item) => (
                                <StatusBadge key={item.domain} status={item.domain} label={`${item.domain}: ${item.count}`} toneOverride="info" showDot={false} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}

                <SegmentedTabs
                    modelValue={activeView.value}
                    tabs={[
                        { value: "pending", label: t("Pending"), count: summary.value?.totalPending },
                        { value: "history", label: t("History") },
                        { value: "all", label: t("All") },
                    ]}
                    onUpdate:modelValue={(value: string) => setView(value as ApprovalView)}
                />

                {selectedCount.value > 0 && (
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            gap: "10px",
                            alignItems: "center",
                            flexWrap: "wrap",
                            padding: "10px 14px",
                            borderRadius: "var(--pg-radius-md)",
                            border: "1px solid var(--pg-border-subtle)",
                            background: "var(--pg-bg-surface-subtle)",
                        }}
                    >
                        <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>{selectedCount.value} {t("selected")}</ThemedText>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("Only pending requests can be rejected in bulk.")}</ThemedText>
                        <div style={{ flex: 1 }} />
                        <VBtn size="small" variant="text" onClick={clearSelection}>{t("Clear selection")}</VBtn>
                        <VBtn size="small" color="error" variant="flat" prependIcon="mdi-close-octagon-outline" onClick={openBulkReject}>
                            {t("Reject selected")}
                        </VBtn>
                    </ThemedView>
                )}

                <ApiTable<ApprovalRow>
                    title={t("Approval requests")}
                    url={urlsMap.approvalsList}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "20", value: 20 },
                        { label: "50", value: 50 },
                        { label: "100", value: 100 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    rowColor={(row) => {
                        const colors = theme.current.value.colors as Record<string, string>;
                        if (row.expired || row.mode === "EMERGENCY_RATIFICATION") return colors.error;
                        if (row.ageHours >= 24) return colors.warning;
                        return undefined;
                    }}
                    apiDataExtractor={(data) => {
                        const payload = data as { approvals?: ApprovalRow[]; rows?: ApprovalRow[] };
                        return payload.approvals ?? payload.rows ?? [];
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

                {areHelpPanelsVisible() && <SurfaceCard><SurfaceCardText><ApprovalHelpPanel /></SurfaceCardText></SurfaceCard>}
            </ThemedView>

            <FormModal
                modelValue={bulkRejectOpen.value}
                onUpdate:modelValue={(value: boolean) => (bulkRejectOpen.value = value)}
                title={t("Reject selected approvals")}
                size="sm"
                onSubmit={() => void runBulkReject()}
                submitLabel={`${t("Reject")} (${selectedCount.value})`}
                cancelLabel={t("Cancel")}
                loading={bulkRejectLoading.value}
                danger
                errorMessage={bulkRejectError.value ?? ""}
            >
                <VAlert type="warning" variant="tonal">
                    {t("Each request is validated independently. Requests you made yourself or cannot check will fail and remain selected.")}
                </VAlert>
                <SectionFields title={t("Bulk rejection details")}>
                    <FormField
                        label={t("Rejection reason")}
                        hint={t("At least 2 characters. Applied to every selected request.")}
                        required
                    >
                        <VTextarea
                            modelValue={bulkRejectReason.value}
                            onUpdate:modelValue={(value: string) => (bulkRejectReason.value = value)}
                            rows={3}
                        />
                    </FormField>
                    {showChecklists && (
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Bulk rejection checklist")}</ThemedText>
                            {BULK_REJECT_CHECKS.map((check) => (
                                <VCheckbox
                                    key={check.key}
                                    modelValue={bulkRejectChecklist.value[check.key] === true}
                                    onUpdate:modelValue={(value: unknown) => (bulkRejectChecklist.value = { ...bulkRejectChecklist.value, [check.key]: Boolean(value) })}
                                    label={t(check.label)}
                                    density="compact"
                                    hideDetails
                                />
                            ))}
                            {!bulkRejectChecklistComplete.value && (
                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all bulk rejection checklist items before continuing.")}</ThemedText>
                            )}
                        </ThemedView>
                    )}
                </SectionFields>
            </FormModal>

            <SlideOverDrawer
                modelValue={detailsOpen.value}
                onUpdate:modelValue={(value: boolean) => {
                    detailsOpen.value = value;
                    if (!value) void clearOpenQueryParam();
                }}
                title={selected.value ? t(subjectTypeLabel(selected.value.subjectType)) : t("Approval")}
                subtitle={selected.value ? `${selected.value.domain} · ${kindLabel(selected.value.kind)}` : ""}
                width={680}
            >
{detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading approval detail")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <MonoRef value={selected.value.subjectId} />
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusBadge status={selected.value.state} label={APPROVAL_STATE_HELP[selected.value.state]?.label ?? selected.value.state} toneOverride={asBadgeTone(APPROVAL_STATE_HELP[selected.value.state]?.tone ?? statusTone(selected.value.state))} />
                                        <StatusBadge status={selected.value.domain} label={selected.value.domain} toneOverride="neutral" />
                                        <StatusBadge status={selected.value.kind} label={kindLabel(selected.value.kind)} toneOverride="info" />
                                        {selected.value.baseVersion !== null && <StatusBadge status="version" label={`v${selected.value.baseVersion}`} toneOverride="neutral" />}
                                        {selected.value.mode === "EMERGENCY_RATIFICATION" && <StatusBadge status="Emergency" label={t("Emergency")} toneOverride="danger" />}
                                    </ThemedView>
                                </ThemedView>

                                {selected.value.expired && (
                                    <VAlert type="error" variant="tonal">{t("This request has expired. It cannot be approved, but it can still be rejected with a reason.")}</VAlert>
                                )}
                                {blockMessage.value && (
                                    <VAlert type="warning" variant="tonal">{t(blockMessage.value)}</VAlert>
                                )}

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
                                    <SurfaceCard variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "7px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Subject context")}</ThemedText>
                                            {contextRows.value.length === 0 ? (
                                                <EmptyState
                                                    title={t("No subject context is available for this request type.")}
                                                    icon="mdi-text-box-search-outline"
                                                />
                                            ) : (
                                                <DescriptionList
                                                    columns={2}
                                                    items={contextRows.value.map((row) => ({
                                                        label: row.label,
                                                        value: row.label === t("Reference") ? <MonoRef value={row.value} /> : row.value,
                                                    }))}
                                                />
                                            )}
                                            {subjectRoute(selected.value) && (
                                                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => openSubject(selected.value as ApprovalRow)}>{t("Open subject")}</VBtn>
                                            )}
                                        </SurfaceCardText>
                                    </SurfaceCard>

                                    <SurfaceCard variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "7px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval metadata")}</ThemedText>
                                            <DescriptionList
                                                items={[
                                                    { label: t("Approval request ID"), value: <MonoRef value={selected.value.id} /> },
                                                    { label: t("Maker"), value: selected.value.makerName || selected.value.makerUserId },
                                                    { label: t("Checker"), value: selected.value.checkerName || "—" },
                                                    { label: t("Created"), value: formatDateTime(selected.value.createdAt) },
                                                    { label: t("Expires"), value: selected.value.expired ? t("Expired") : formatDateTime(selected.value.expiresAt) },
                                                    { label: t("Base version"), value: selected.value.baseVersion === null ? "—" : `v${selected.value.baseVersion}` },
                                                    { label: t("Maker reason"), value: selected.value.makerReason || "—" },
                                                    { label: t("Rejection reason"), value: selected.value.rejectionReason || "—" },
                                                ]}
                                            />
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                </ThemedView>

                                <ThemedView style={{ gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Proposed change")}</ThemedText>
                                    <JsonDiffViewer diff={selected.value.payloadDiff} />
                                </ThemedView>

                                {selected.value.riskAcceptanceNote && (
                                    <VAlert type="warning" variant="tonal">
                                        <ThemedText style={{ fontSize: "12px" }}>{t("Risk acceptance note")}: {selected.value.riskAcceptanceNote}</ThemedText>
                                    </VAlert>
                                )}

                                <SurfaceCard variant="tonal">
                                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Checker decision")}</ThemedText>
                                        {requiresOutcome.value && (
                                            <FormField label={t("Dispute outcome")} required>
                                                <VSelect
                                                    items={["WON", "LOST"]}
                                                    clearable
                                                    modelValue={outcome.value}
                                                    onUpdate:modelValue={(value: string | null) => (outcome.value = (value as "WON" | "LOST" | null) ?? "")}
                                                />
                                            </FormField>
                                        )}
                                        {showChecklists && (
                                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Decision checklist")}</ThemedText>
                                                {APPROVAL_CHECKS.map((check) => (
                                                    <VCheckbox
                                                        key={check.key}
                                                        modelValue={decisionChecklist.value[check.key] === true}
                                                        onUpdate:modelValue={(value: unknown) => (decisionChecklist.value = { ...decisionChecklist.value, [check.key]: Boolean(value) })}
                                                        label={t(check.label)}
                                                        density="compact"
                                                        hideDetails
                                                    />
                                                ))}
                                                {!decisionChecklistComplete.value && (
                                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all decision checklist items before deciding")}</ThemedText>
                                                )}
                                            </ThemedView>
                                        )}
                                        <FormField
                                            label={t("Decision reason")}
                                            hint={t("Required for rejection. A clear reason lets the maker correct the request.")}
                                            required={canReject.value}
                                        >
                                            <VTextarea
                                                modelValue={decisionReason.value}
                                                onUpdate:modelValue={(value: string) => (decisionReason.value = value)}
                                                rows={2}
                                            />
                                        </FormField>
                                        <FormField label={t("Risk acceptance note (optional)")}>
                                            <VTextarea
                                                modelValue={riskAcceptanceNote.value}
                                                onUpdate:modelValue={(value: string) => (riskAcceptanceNote.value = value)}
                                                rows={2}
                                            />
                                        </FormField>
                                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                            <VBtn
                                                color="success"
                                                disabled={!canApprove.value || !decisionChecklistComplete.value}
                                                loading={actionLoading.value}
                                                onClick={() => void decide(true)}
                                            >
                                                {t("Approve")}
                                            </VBtn>
                                            <VBtn
                                                color="error"
                                                variant="tonal"
                                                disabled={!canReject.value || !decisionChecklistComplete.value}
                                                loading={actionLoading.value}
                                                onClick={() => void decide(false)}
                                            >
                                                {t("Reject")}
                                            </VBtn>
                                            <VBtn variant="text" onClick={closeDetails}>{t("Close")}</VBtn>
                                        </ThemedView>
                                    </SurfaceCardText>
                                </SurfaceCard>
                            </>
                        )}
            </SlideOverDrawer>
        </ScreenContainer>
    );
});

export default ApprovalsPage;
