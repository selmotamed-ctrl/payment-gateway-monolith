import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VAutocomplete, VBtn, VProgressCircular, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
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
type Adjustment = {
    id: string;
    type: string;
    state: string;
    amount: string;
    currency: string;
    reverseCommission: boolean;
    reason: string;
    externalDisputeRef: string | null;
    providerRefundRef: string | null;
    draftedBySystem: boolean;
    sourceAttemptId: string | null;
    sourceAttemptReference: string | null;
    sourceAttemptStatus: string | null;
    disputeId: string | null;
    disputeReference: string | null;
    disputeStatus: string | null;
    targetGlAccountId: string;
    targetAccountType: string | null;
    targetAccountOwnerId: string | null;
    merchantId: string | null;
    merchantName: string;
    journalEntryId: string | null;
    approvalRequestId: string | null;
    approvalState: string | null;
    checkerUserId: string | null;
    createdAt: string;
    updatedAt: string;
    executedAt: string | null;
};

type AdjustmentDetail = Adjustment & {
    disputeAmount: string | null;
    disputeOpenedAt: string | null;
    journalEntry: { id: string; refType: string; refId: string; description: string } | null;
    approval: {
        id: string;
        state: string;
        makerUserId: string;
        checkerUserId: string | null;
        rejectionReason: string | null;
        createdAt: string;
    } | null;
};

type AdjustmentSummary = {
    totalOpen: number;
    openAmount: string;
    executedCount: number;
    executedAmount: string;
    byState: Record<string, number>;
    amountByState: Record<string, string>;
    byType: Record<string, number>;
    amountByType: Record<string, string>;
};

type AdjustmentView = "open" | "executed" | "all";

const ADJUSTMENT_TYPES = ["CHARGEBACK", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION", "CASHOUT_SUBTRACTION"];
const SUMMARY_EXPORT_CHECKS = [
    { key: "OPEN_SCOPE_VERIFIED", label: "Open adjustment scope verified" },
    { key: "AMOUNT_TOTALS_REVIEWED", label: "Amount totals reviewed" },
    { key: "STATE_TYPE_BREAKDOWN_REVIEWED", label: "State and type breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const ADJUSTMENT_CHECKS = [
    { key: "TARGET_ACCOUNT_VERIFIED", label: "Target merchant account verified" },
    { key: "AMOUNT_CURRENCY_VERIFIED", label: "Amount and currency verified" },
    { key: "REASON_DOCUMENTED", label: "Reason documented" },
    { key: "SOURCE_LINKAGE_VERIFIED", label: "Payment or dispute linkage verified" },
] as const;

const OPEN_STATES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTING"];
const EXECUTED_STATES = ["EXECUTED"];

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

const formatMoney = (value: string | null | undefined, currency = "LYD"): string => {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return `${number.toFixed(4)} ${currency}`;
};

const emptyForm = () => ({
    type: "MANUAL_CREDIT",
    amount: "",
    merchantId: "",
    targetGlAccountId: "",
    reason: "",
    sourceAttemptId: "",
    disputeId: "",
    externalDisputeRef: "",
    reverseCommission: true,
});

const AdjustmentsPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const rows = ref<Adjustment[]>([]);
    const total = ref(0);
    const summary = ref<AdjustmentSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<AdjustmentView>("open");
    const filters = ref<FilterValues>({ state: [...OPEN_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const selected = ref<AdjustmentDetail | null>(null);
    const detailLoading = ref(false);

    const createOpen = ref(false);
    const form = ref(emptyForm());
    const actionLoading = ref(false);
    const createError = ref("");
    const proposalChecklist = ref<Record<string, boolean>>({});
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const merchantOptions = ref<{ title: string; value: string; subtitle?: string }[]>([]);
    const glAccountOptions = ref<{ title: string; value: string; subtitle?: string }[]>([]);

    const filterDefinitions = computed(() => tableRegistry.Adjustments?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.adjustmentsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as AdjustmentSummary;
        } catch {
            summary.value = null;
        }
    };

    const loadMerchants = async () => {
        try {
            const response = await api.get(urlsMap.options("merchants"), { params: { limit: 100 } });
            const payload = response.data?.data ?? response.data ?? {};
            merchantOptions.value = payload.items ?? [];
        } catch {
            merchantOptions.value = [];
        }
    };

    const loadGlAccounts = async (merchantId: string) => {
        if (!merchantId) {
            glAccountOptions.value = [];
            return;
        }
        try {
            const response = await api.get(urlsMap.options("gl-accounts"), { params: { ownerId: merchantId, limit: 100 } });
            const payload = response.data?.data ?? response.data ?? {};
            glAccountOptions.value = payload.items ?? [];
        } catch {
            glAccountOptions.value = [];
        }
    };

    void loadSummary();
    void loadMerchants();

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = activeView.value === "open"
            ? { state: [...OPEN_STATES] }
            : activeView.value === "executed"
              ? { state: [...EXECUTED_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const setView = (view: AdjustmentView) => {
        activeView.value = view;
        filters.value = view === "open"
            ? { state: [...OPEN_STATES] }
            : view === "executed"
              ? { state: [...EXECUTED_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.adjustmentsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.adjustments ?? []) as Adjustment[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No adjustments match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "type", "state", "amount", "currency", "merchant", "reason", "sourceAttemptReference", "disputeReference", "approvalState", "journalEntryId", "createdAt"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.type,
                        row.state,
                        row.amount,
                        row.currency,
                        row.merchantName || row.merchantId || "",
                        row.reason,
                        row.sourceAttemptReference ?? "",
                        row.disputeReference ?? "",
                        row.approvalState ?? "",
                        row.journalEntryId ?? "",
                        row.createdAt,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `adjustments-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const presentAdjustmentDetail = (detail: AdjustmentDetail) => {
        selected.value = detail;
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchAdjustmentDetail = async (id: string): Promise<AdjustmentDetail | null> => {
        const response = await api.get(urlsMap.adjustmentDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.adjustment ?? payload) as AdjustmentDetail;
    };

    const openDetails = async (row: Adjustment) => {
        selected.value = {
            ...row,
            disputeAmount: null,
            disputeOpenedAt: null,
            journalEntry: null,
            approval: null,
        };
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchAdjustmentDetail(row.id);
            if (detail) presentAdjustmentDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<AdjustmentDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchAdjustmentDetail,
        onOpenRecord: presentAdjustmentDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("Adjustment not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };

    const openCreate = () => {
        form.value = emptyForm();
        proposalChecklist.value = {};
        createError.value = "";
        glAccountOptions.value = [];
        createOpen.value = true;
        void loadMerchants();
    };

    const onMerchantChanged = (value: string) => {
        form.value.merchantId = value ?? "";
        form.value.targetGlAccountId = "";
        void loadGlAccounts(form.value.merchantId);
    };

    const proposalChecklistComplete = computed(() => !showChecklists || ADJUSTMENT_CHECKS.every((check) => proposalChecklist.value[check.key] === true));

    const submit = async () => {
        createError.value = "";
        const amount = form.value.amount.trim();
        if (!/^\d{1,14}(\.\d{1,4})?$/.test(amount)) {
            showSnackBar({ type: "warning", message: t("Amount must be a decimal with up to 4 places") });
            return;
        }
        if (form.value.reason.trim().length < 2) {
            showSnackBar({ type: "warning", message: t("Reason is required") });
            return;
        }
        if (!proposalChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all proposal checklist items before drafting") });
            return;
        }
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.adjustmentsList, {
                type: form.value.type,
                amount,
                targetGlAccountId: form.value.targetGlAccountId,
                reason: form.value.reason.trim(),
                reverseCommission: form.value.reverseCommission,
                ...(form.value.sourceAttemptId.trim() ? { attemptId: form.value.sourceAttemptId.trim() } : {}),
                ...(form.value.disputeId.trim() ? { disputeId: form.value.disputeId.trim() } : {}),
                ...(form.value.externalDisputeRef.trim() ? { externalDisputeRef: form.value.externalDisputeRef.trim() } : {}),
                checklist: ADJUSTMENT_CHECKS.filter((check) => proposalChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            createOpen.value = false;
            showSnackBar({
                type: "success",
                message: payload.approvalRequestId
                    ? `${t("Adjustment draft created")} · ${t("Approval request")} ${String(payload.approvalRequestId).slice(0, 8)}`
                    : t("Adjustment draft created"),
            });
            refreshAll();
        } catch (error) {
            createError.value = extractApiErrorMessage(error);
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
            const response = await api.get(urlsMap.adjustmentsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as AdjustmentSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total_open", snapshot.totalOpen],
                ["open_amount", snapshot.openAmount],
                ["executed_count", snapshot.executedCount],
                ["executed_amount", snapshot.executedAmount],
            ];
            for (const [state, count] of Object.entries(snapshot.byState ?? {})) {
                rows.push([`state.${state}.count`, count]);
                rows.push([`state.${state}.amount`, snapshot.amountByState?.[state] ?? "0"]);
            }
            for (const [type, count] of Object.entries(snapshot.byType ?? {})) {
                rows.push([`type.${type}.count`, count]);
                rows.push([`type.${type}.amount`, snapshot.amountByType?.[type] ?? "0"]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `adjustment-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Adjustment summary exported") });
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
            { key: "open", label: t("Open adjustments"), value: String(data.totalOpen), badge: data.totalOpen > 0 ? t("Open") : t("Clear"), badgeTone: data.totalOpen > 0 ? "warning" : "success" },
            { key: "openAmount", label: t("Open amount"), moneyAmount: data.openAmount, currency: "LYD" },
            { key: "executed", label: t("Executed"), value: String(data.executedCount), badge: t("Executed"), badgeTone: "success" },
            { key: "executedAmount", label: t("Executed amount"), moneyAmount: data.executedAmount, currency: "LYD" },
        ];
    });

    const headers = computed<TableHeader<Adjustment>[]>(() => [
        {
            key: "type",
            label: "Type",
            sortKey: "type",
            value: (row) => row.type,
            Value: ({ row }: { row: Adjustment }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.type}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.draftedBySystem ? t("System draft") : t("Manual draft")}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            value: (row) => row.state,
            Value: ({ row }: { row: Adjustment }) => <StatusBadge status={row.state} toneOverride={badgeTone(row.state)} />,
        },
        {
            key: "amount",
            label: "Amount",
            sortKey: "amount",
            value: (row) => row.amount,
            Value: ({ row }: { row: Adjustment }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />,
        },
        {
            key: "merchant",
            label: "Merchant",
            value: (row) => row.merchantName,
            Value: ({ row }: { row: Adjustment }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.merchantName || "—"}</ThemedText>
                    <MonoRef value={row.merchantId ?? ""} />
                </ThemedView>
            ),
        },
        {
            key: "source",
            label: "Source",
            value: (row) => `${row.sourceAttemptReference ?? ""} ${row.disputeReference ?? ""}`,
            Value: ({ row }: { row: Adjustment }) => (
                <ThemedView style={{ gap: "2px" }}>
                    {row.sourceAttemptReference ? <MonoRef value={row.sourceAttemptReference} /> : <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>—</ThemedText>}
                    {row.disputeReference ? <MonoRef value={row.disputeReference} /> : <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>—</ThemedText>}
                </ThemedView>
            ),
        },
        {
            key: "reason",
            label: "Reason",
            value: (row) => row.reason,
        },
        {
            key: "approval",
            label: "Approval",
            headerTooltip: "The maker-checker request that must approve this adjustment before money moves.",
            value: (row) => row.approvalState ?? "",
            Value: ({ row }: { row: Adjustment }) => row.approvalState
                ? <StatusBadge status={row.approvalState} toneOverride={badgeTone(row.approvalState)} />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "createdAt",
            label: "Created",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: Adjustment }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: Adjustment }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Review"),
                        icon: "mdi-cash-check",
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
                    title={t("Adjustments")}
                    subtitle={t("Draft and review adjustments under maker-checker governance. Every adjustment requires independent finance approval before execution.")}
                    badge={t("Four-Eyes Required")}
                    badgeTone="warning"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("Propose")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Every adjustment is a draft plus an approval request. Money moves only after a different finance checker approves it.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Adjustment health")}
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
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byState ?? {}).map(([state, count]) => (
                                <StatusBadge key={state} status={state} label={`${state}: ${count}`} toneOverride={badgeTone(state)} />
                            ))}
                            {Object.entries(summary.value.byType ?? {}).map(([type, count]) => (
                                <StatusBadge key={type} status={type} label={`${type}: ${count}`} toneOverride="neutral" />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}

                <SegmentedTabs
                    modelValue={activeView.value}
                    onUpdate:modelValue={(value: string) => setView(value as AdjustmentView)}
                    tabs={[
                        { value: "open", label: t("Open") },
                        { value: "executed", label: t("Executed") },
                        { value: "all", label: t("All") },
                    ]}
                />

                <ApiTable<Adjustment>
                    title={t("Adjustment queue")}
                    url={urlsMap.adjustmentsList}
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
                    rowColor={(row) => (row.state === "PENDING_REVIEW" ? "#d97706" : row.state === "EXECUTING" ? "#2563eb" : row.state === "REJECTED" ? "#dc2626" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { adjustments?: Adjustment[]; rows?: Adjustment[] };
                        return payload.adjustments ?? payload.rows ?? [];
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
                title={[selected.value?.type, "·", formatMoney(selected.value?.amount, selected.value?.currency)].filter(Boolean).join(" · ")}
                subtitle={selected.value ? selected.value.merchantName || selected.value.merchantId || "" : ""}
                width={660}
                v-slots={{
                    footer: () => (
                        <VBtn variant="text" onClick={closeDetails}>{t("Close")}</VBtn>
                    ),
                }}
            >
                {detailLoading.value || !selected.value ? (
                    <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                        <VProgressCircular indeterminate size={52} color="primary" />
                        <ThemedText style={{ opacity: 0.65 }}>{t("Loading adjustment")}</ThemedText>
                    </ThemedView>
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                            <MoneyDisplay amount={selected.value.amount} currency={selected.value.currency} size="lg" colorSign />
                            <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                <StatusBadge status={selected.value.state} toneOverride={badgeTone(selected.value.state)} />
                                {selected.value.approvalState && <StatusBadge status={selected.value.approvalState} label={`approval ${selected.value.approvalState}`} toneOverride={badgeTone(selected.value.approvalState)} />}
                                {selected.value.draftedBySystem && <StatusBadge status="SYSTEM_DRAFT" label={t("System draft")} toneOverride="info" />}
                            </ThemedView>
                        </ThemedView>

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Adjustment context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Merchant"), value: selected.value.merchantName || "—" },
                                    { label: t("Source attempt"), value: <MonoRef value={selected.value.sourceAttemptReference || selected.value.sourceAttemptId || ""} /> },
                                    { label: t("Attempt status"), value: selected.value.sourceAttemptStatus || "—" },
                                    { label: t("Dispute"), value: <MonoRef value={selected.value.disputeReference || selected.value.disputeId || ""} /> },
                                    { label: t("Dispute status"), value: selected.value.disputeStatus || "—" },
                                    { label: t("Dispute amount"), value: <MoneyDisplay amount={selected.value.disputeAmount} currency={selected.value.currency} size="sm" colorSign /> },
                                    { label: t("Target account"), value: `${selected.value.targetAccountType || "—"} · ${selected.value.currency}` },
                                    { label: t("Reverse commission"), value: selected.value.reverseCommission ? t("Yes") : t("No") },
                                    { label: t("Reason"), value: selected.value.reason },
                                    { label: t("Created"), value: formatDateTime(selected.value.createdAt) },
                                    { label: t("Executed"), value: formatDateTime(selected.value.executedAt) },
                                ]} />
                                {selected.value.merchantId && (
                                    <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "MerchantDetail", params: { id: selected.value?.merchantId ?? "" } })}>{t("Open merchant")}</VBtn>
                                )}
                            </ThemedView>

                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval and ledger")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Approval request"), value: <MonoRef value={selected.value.approvalRequestId ?? ""} /> },
                                    { label: t("Approval state"), value: selected.value.approvalState || "—" },
                                    { label: t("Checker"), value: selected.value.approval?.checkerUserId || selected.value.checkerUserId || "—" },
                                    { label: t("Rejection reason"), value: selected.value.approval?.rejectionReason || "—" },
                                    { label: t("Journal entry"), value: <MonoRef value={selected.value.journalEntryId ?? ""} /> },
                                    { label: t("Journal type"), value: selected.value.journalEntry?.refType || "—" },
                                    { label: t("Journal reference"), value: <MonoRef value={selected.value.journalEntry?.refId ?? ""} /> },
                                    { label: t("External dispute ref"), value: <MonoRef value={selected.value.externalDisputeRef ?? ""} /> },
                                    { label: t("Provider refund ref"), value: <MonoRef value={selected.value.providerRefundRef ?? ""} /> },
                                ]} />
                                {selected.value.approvalRequestId && (
                                    <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                )}
                            </ThemedView>
                        </ThemedView>
                    </>
                )}
            </SlideOverDrawer>

            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(value: boolean) => (createOpen.value = value)}
                title={t("Propose adjustment")}
                size="md"
                loading={actionLoading.value}
                errorMessage={createError.value}
                submitLabel={t("Create draft")}
                onSubmit={() => void submit()}
            >
                <VAlert type="info" variant="tonal">
                    {t("The draft creates an approval request. The adjustment does not execute until a different finance checker approves it.")}
                </VAlert>
                <SectionFields title={t("Adjustment details")}>
                    <FormField label={t("Adjustment type")} required sensitiveMakerChecker>
                        <VSelect
                            items={ADJUSTMENT_TYPES.map((value) => ({ title: value, value }))}
                            modelValue={form.value.type}
                            onUpdate:modelValue={(value: string) => (form.value.type = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Amount")} required sensitiveMakerChecker>
                        <VTextField
                            modelValue={form.value.amount}
                            onUpdate:modelValue={(value: string) => (form.value.amount = value)}
                            placeholder="0.0000"
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Merchant")} required sensitiveMakerChecker>
                        <VAutocomplete
                            items={merchantOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={form.value.merchantId}
                            onUpdate:modelValue={(value: string | null) => onMerchantChanged(value ?? "")}
                            hideDetails
                        />
                    </FormField>
                    <FormField
                        label={t("Target merchant wallet account")}
                        hint={form.value.merchantId ? t("Select the merchant wallet GL account") : t("Choose a merchant first")}
                        required
                        sensitiveMakerChecker
                    >
                        <VAutocomplete
                            items={glAccountOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={form.value.targetGlAccountId}
                            onUpdate:modelValue={(value: string | null) => (form.value.targetGlAccountId = value ?? "")}
                            disabled={!form.value.merchantId}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Reason")} required sensitiveMakerChecker>
                        <VTextField
                            modelValue={form.value.reason}
                            onUpdate:modelValue={(value: string) => (form.value.reason = value)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Source references")}>
                    <FormField label={t("Source attempt ID (optional)")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={form.value.sourceAttemptId}
                            onUpdate:modelValue={(value: string) => (form.value.sourceAttemptId = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Dispute ID (optional)")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={form.value.disputeId}
                            onUpdate:modelValue={(value: string) => (form.value.disputeId = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("External dispute reference (optional)")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={form.value.externalDisputeRef}
                            onUpdate:modelValue={(value: string) => (form.value.externalDisputeRef = value)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...ADJUSTMENT_CHECKS]}
                    modelValue={proposalChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (proposalChecklist.value = value)}
                    show={showChecklists}
                    title={t("Proposal checklist")}
                    complete={proposalChecklistComplete.value}
                    incompleteMessage={t("Complete all proposal checklist items before drafting")}
                />
                <FormField label={t("Reverse commission")} sensitiveMakerChecker>
                    <VSwitch
                        modelValue={form.value.reverseCommission}
                        onUpdate:modelValue={(value: unknown) => (form.value.reverseCommission = Boolean(value))}
                        hideDetails
                    />
                </FormField>
            </FormModal>
        </ScreenContainer>
    );
});

export default AdjustmentsPage;
