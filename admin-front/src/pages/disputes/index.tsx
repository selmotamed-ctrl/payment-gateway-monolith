import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VProgressCircular, VTextarea, VTextField } from "vuetify/components";
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
type Dispute = {
    id: string;
    externalDisputeRef: string;
    disputeRef: string;
    source: string;
    status: string;
    state: string;
    reasonCode: string | null;
    amount: string;
    currency: string;
    openedAt: string;
    evidenceDueAt: string | null;
    outcomeAt: string | null;
    evidenceDueInHours: number | null;
    evidenceOverdue: boolean;
    evidenceSubmittedAt: string | null;
    ageHours: number;
    merchantId: string | null;
    merchantName: string;
    attemptId: string;
    attemptReference: string | null;
    attemptStatus: string | null;
    railCode: string;
    railName: string;
    gatewayCode: string;
    gatewayName: string;
    adjustmentId: string | null;
    adjustmentState: string | null;
    adjustmentJournalEntryId: string | null;
};

type DisputeDetail = Dispute & {
    attemptSettledAmount: string;
    adjustmentReason: string | null;
    evidenceJson: unknown;
    canSubmitEvidence: boolean;
    evidenceBlockedReason: string | null;
};

type DisputeSummary = {
    totalOpen: number;
    openAmount: string;
    byStatus: Record<string, number>;
    overdue: number;
    dueSoon: number;
    earliestEvidenceDueAt: string | null;
};

type DisputeView = "open" | "resolved" | "all";

const SUMMARY_EXPORT_CHECKS = [
    { key: "OPEN_SCOPE_VERIFIED", label: "Open dispute scope verified" },
    { key: "DUE_DATE_REVIEWED", label: "Evidence due dates reviewed" },
    { key: "STATUS_BREAKDOWN_REVIEWED", label: "Status breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const EVIDENCE_CHECKS = [
    { key: "EVIDENCE_REFERENCE_VERIFIED", label: "Evidence reference verified" },
    { key: "SUPPORTING_DOCUMENTS_ATTACHED", label: "Supporting documents attached" },
    { key: "EVIDENCE_WINDOW_VERIFIED", label: "Evidence deadline and window verified" },
    { key: "SUMMARY_REVIEWED", label: "Evidence summary reviewed" },
] as const;

const OPEN_STATES = ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"];
const RESOLVED_STATES = ["WON", "LOST", "EXPIRED", "WITHDRAWN"];

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

const formatHours = (hours: number | null): string => {
    if (hours === null) return "—";
    if (hours < 0) return `${Math.abs(hours)}h ago`;
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
};

const DisputesPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const rows = ref<Dispute[]>([]);
    const total = ref(0);
    const summary = ref<DisputeSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<DisputeView>("open");
    const filters = ref<FilterValues>({ status: [...OPEN_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const evidenceOpen = ref(false);
    const actionError = ref("");
    const selected = ref<DisputeDetail | null>(null);
    const detailLoading = ref(false);
    const actionLoading = ref(false);
    const evidenceReference = ref("");
    const evidenceDocumentUrl = ref("");
    const evidenceNotes = ref("");
    const evidenceChecklist = ref<Record<string, boolean>>({});
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});

    const filterDefinitions = computed(() => tableRegistry.Disputes?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.disputesSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as DisputeSummary;
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

    const setView = (view: DisputeView) => {
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
            const response = await api.get(urlsMap.disputesExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.disputes ?? []) as Dispute[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No disputes match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "disputeRef", "externalDisputeRef", "status", "source", "amount", "currency", "merchant", "attemptReference", "railCode", "gatewayCode", "openedAt", "evidenceDueAt", "ageHours"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.disputeRef,
                        row.externalDisputeRef,
                        row.status,
                        row.source,
                        row.amount,
                        row.currency,
                        row.merchantName || row.merchantId || "",
                        row.attemptReference ?? "",
                        row.railCode,
                        row.gatewayCode,
                        row.openedAt,
                        row.evidenceDueAt ?? "",
                        row.ageHours,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `disputes-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const resetEvidenceState = () => {
        evidenceReference.value = "";
        evidenceDocumentUrl.value = "";
        evidenceNotes.value = "";
        evidenceChecklist.value = {};
        evidenceOpen.value = false;
        actionError.value = "";
    };

    const presentDisputeDetail = (detail: DisputeDetail) => {
        selected.value = detail;
        resetEvidenceState();
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchDisputeDetail = async (id: string): Promise<DisputeDetail | null> => {
        const response = await api.get(urlsMap.disputeDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.dispute ?? payload) as DisputeDetail;
    };

    const openDetails = async (row: Dispute) => {
        selected.value = {
            ...row,
            attemptSettledAmount: "0.0000",
            adjustmentReason: null,
            evidenceJson: null,
            canSubmitEvidence: false,
            evidenceBlockedReason: null,
        };
        resetEvidenceState();
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchDisputeDetail(row.id);
            if (detail) presentDisputeDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<DisputeDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchDisputeDetail,
        onOpenRecord: presentDisputeDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("Dispute not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };

    const evidenceChecklistComplete = computed(() => !showChecklists || EVIDENCE_CHECKS.every((check) => evidenceChecklist.value[check.key] === true));

    const submitEvidence = async () => {
        if (!selected.value) return;
        actionError.value = "";
        const evidence: Record<string, unknown> = {};
        if (evidenceReference.value.trim()) evidence.reference = evidenceReference.value.trim();
        if (evidenceDocumentUrl.value.trim()) evidence.documentUrl = evidenceDocumentUrl.value.trim();
        if (evidenceNotes.value.trim()) evidence.summary = evidenceNotes.value.trim();
        if (Object.keys(evidence).length === 0) {
            showSnackBar({ type: "warning", message: t("Add at least one evidence field") });
            return;
        }
        if (!evidenceChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all evidence checklist items before submitting") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.disputeEvidence(selected.value.id), {
                evidence,
                notes: evidenceNotes.value.trim() || undefined,
                checklist: EVIDENCE_CHECKS.filter((check) => evidenceChecklist.value[check.key]).map((check) => check.key),
            });
            showSnackBar({ type: "success", message: t("Evidence submitted") });
            evidenceOpen.value = false;
            closeDetails();
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
            const response = await api.get(urlsMap.disputesSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as DisputeSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total_open", snapshot.totalOpen],
                ["open_amount", snapshot.openAmount],
                ["overdue", snapshot.overdue],
                ["due_soon", snapshot.dueSoon],
                ["earliest_evidence_due_at", snapshot.earliestEvidenceDueAt ?? ""],
            ];
            for (const [state, count] of Object.entries(snapshot.byStatus ?? {})) {
                rows.push([`status.${state}.count`, count]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `dispute-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Dispute summary exported") });
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
            { key: "open", label: t("Open disputes"), value: String(data.totalOpen), badge: data.totalOpen > 0 ? t("Open") : t("Clear"), badgeTone: data.totalOpen > 0 ? "warning" : "success" },
            { key: "openAmount", label: t("Open amount"), moneyAmount: data.openAmount, currency: "LYD" },
            { key: "dueSoon", label: t("Evidence due in 48h"), value: String(data.dueSoon), badge: data.dueSoon > 0 ? t("Pending") : t("Clear"), badgeTone: data.dueSoon > 0 ? "warning" : "success" },
            { key: "overdue", label: t("Evidence overdue"), value: String(data.overdue), badge: data.overdue > 0 ? t("Overdue") : t("Clear"), badgeTone: data.overdue > 0 ? "danger" : "success" },
            { key: "earliest", label: t("Earliest evidence due"), value: formatDateTime(data.earliestEvidenceDueAt) },
        ];
    });

    const headers = computed<TableHeader<Dispute>[]>(() => [
        {
            key: "externalDisputeRef",
            label: "Dispute",
            sortKey: "externalDisputeRef",
            headerTooltip: "The gateway or scheme dispute reference. It is unique per gateway.",
            value: (row) => row.externalDisputeRef,
            Value: ({ row }: { row: Dispute }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.externalDisputeRef} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.source}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "merchant",
            label: "Merchant",
            headerTooltip: "Merchant whose payment attempt is disputed.",
            value: (row) => row.merchantName,
            Value: ({ row }: { row: Dispute }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.merchantName || "—"}</ThemedText>
                    <MonoRef value={row.merchantId ?? ""} />
                </ThemedView>
            ),
        },
        {
            key: "attempt",
            label: "Attempt",
            headerTooltip: "The original payment attempt. The dispute amount cannot exceed its settled amount.",
            value: (row) => row.attemptReference ?? "",
            Value: ({ row }: { row: Dispute }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.attemptReference || row.attemptId} />
                    {row.attemptStatus && <StatusBadge status={row.attemptStatus} toneOverride={badgeTone(row.attemptStatus)} />}
                </ThemedView>
            ),
        },
        {
            key: "amount",
            label: "Amount",
            sortKey: "amount",
            value: (row) => row.amount,
            Value: ({ row }: { row: Dispute }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: Dispute }) => <StatusBadge status={row.status} toneOverride={badgeTone(row.status)} />,
        },
        {
            key: "reason",
            label: "Reason",
            value: (row) => row.reasonCode ?? "",
        },
        {
            key: "openedAt",
            label: "Opened",
            sortKey: "openedAt",
            value: (row) => row.openedAt,
            Value: ({ row }: { row: Dispute }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.openedAt)}</ThemedText>,
        },
        {
            key: "evidenceDueAt",
            label: "Evidence due",
            sortKey: "evidenceDueAt",
            value: (row) => row.evidenceDueAt ?? "",
            Value: ({ row }: { row: Dispute }) => (
                row.evidenceOverdue
                    ? <StatusBadge status="OVERDUE" label={t("Overdue")} toneOverride="danger" />
                    : <ThemedView style={{ gap: "2px" }}>
                        <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.evidenceDueAt)}</ThemedText>
                        {row.evidenceDueInHours !== null && <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatHours(row.evidenceDueInHours)}</ThemedText>}
                    </ThemedView>
            ),
        },
        {
            key: "adjustment",
            label: "Adjustment",
            headerTooltip: "The chargeback adjustment drafted from this dispute. Money moves only after a checker approves it.",
            value: (row) => row.adjustmentState ?? "",
            Value: ({ row }: { row: Dispute }) => row.adjustmentState
                ? <StatusBadge status={row.adjustmentState} toneOverride={badgeTone(row.adjustmentState)} />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: Dispute }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Review"),
                        icon: "mdi-file-document-search-outline",
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
                    title={t("Disputes")}
                    subtitle={t("Track chargeback disputes, evidence deadlines, and adjustment linkage. No money moves until a finance checker approves the adjustment.")}
                    badge={t("Chargebacks")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("A dispute creates a chargeback adjustment draft. No money moves until a finance checker approves it. Submit evidence before the due date.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Dispute health")}
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
                            {Object.entries(summary.value.byStatus ?? {}).map(([state, count]) => (
                                <StatusBadge key={state} status={state} label={`${state}: ${count}`} toneOverride={badgeTone(state)} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}

                <SegmentedTabs
                    modelValue={activeView.value}
                    onUpdate:modelValue={(value: string) => setView(value as DisputeView)}
                    tabs={[
                        { value: "open", label: t("Open") },
                        { value: "resolved", label: t("Resolved") },
                        { value: "all", label: t("All") },
                    ]}
                />

                <ApiTable<Dispute>
                    title={t("Dispute queue")}
                    url={urlsMap.disputesList}
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
                    rowColor={(row) => {
                        if (row.evidenceOverdue) return "#dc2626";
                        if (row.status === "OPENED" || row.status === "EVIDENCE_REQUESTED") return "#d97706";
                        return undefined;
                    }}
                    apiDataExtractor={(data) => {
                        const payload = data as { disputes?: Dispute[]; rows?: Dispute[] };
                        return payload.disputes ?? payload.rows ?? [];
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
                title={selected.value?.externalDisputeRef ?? t("Dispute")}
                subtitle={selected.value ? selected.value.source : ""}
                width={660}
                v-slots={{
                    footer: () => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            {selected.value?.canSubmitEvidence && (
                                <VBtn color="primary" onClick={() => { actionError.value = ""; evidenceOpen.value = true; }}>{t("Submit evidence")}</VBtn>
                            )}
                            <VBtn variant="text" onClick={closeDetails}>{t("Close")}</VBtn>
                        </ThemedView>
                    ),
                }}
            >
                {detailLoading.value || !selected.value ? (
                    <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
                        <VProgressCircular indeterminate size={52} color="primary" />
                        <ThemedText style={{ opacity: 0.65 }}>{t("Loading dispute")}</ThemedText>
                    </ThemedView>
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <MoneyDisplay amount={selected.value.amount} currency={selected.value.currency} colorSign />
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.source}</ThemedText>
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                <StatusBadge status={selected.value.status} toneOverride={badgeTone(selected.value.status)} />
                                {selected.value.evidenceOverdue && <StatusBadge status="OVERDUE" label={t("Evidence overdue")} toneOverride="danger" />}
                            </ThemedView>
                        </ThemedView>

                        {selected.value.evidenceBlockedReason && (
                            <VAlert type="warning" variant="tonal">
                                {selected.value.evidenceBlockedReason === "EVIDENCE_ALREADY_SUBMITTED"
                                    ? t("Evidence has already been submitted for this dispute.")
                                    : selected.value.evidenceBlockedReason === "EVIDENCE_WINDOW_CLOSED"
                                      ? t("The evidence window has closed.")
                                      : t("This dispute is not open for evidence submission.")}
                            </VAlert>
                        )}

                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Dispute context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Merchant"), value: selected.value.merchantName || "—" },
                                    { label: t("Attempt"), value: <MonoRef value={selected.value.attemptReference || selected.value.attemptId} /> },
                                    { label: t("Attempt status"), value: selected.value.attemptStatus || "—" },
                                    { label: t("Settled amount"), value: <MoneyDisplay amount={selected.value.attemptSettledAmount} currency={selected.value.currency} size="sm" /> },
                                    { label: t("Rail"), value: `${selected.value.railCode || "—"} ${selected.value.railName || ""}`.trim() },
                                    { label: t("Gateway"), value: `${selected.value.gatewayCode || "—"} ${selected.value.gatewayName || ""}`.trim() },
                                    { label: t("Reason"), value: selected.value.reasonCode || "—" },
                                    { label: t("Opened"), value: formatDateTime(selected.value.openedAt) },
                                    { label: t("Evidence due"), value: selected.value.evidenceOverdue ? t("Overdue") : formatDateTime(selected.value.evidenceDueAt) },
                                    { label: t("Outcome"), value: formatDateTime(selected.value.outcomeAt) },
                                ]} />
                                {selected.value.merchantId && (
                                    <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "MerchantDetail", params: { id: selected.value?.merchantId ?? "" } })}>{t("Open merchant")}</VBtn>
                                )}
                            </ThemedView>

                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Adjustment and evidence")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Adjustment state"), value: selected.value.adjustmentState || "—" },
                                    { label: t("Adjustment reason"), value: selected.value.adjustmentReason || "—" },
                                    { label: t("Journal entry"), value: <MonoRef value={selected.value.adjustmentJournalEntryId ?? ""} /> },
                                    { label: t("Evidence submitted"), value: formatDateTime(selected.value.evidenceSubmittedAt) },
                                ]} />
                                {selected.value.evidenceJson && (
                                    <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", background: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "180px", overflow: "auto" }}>
                                        {JSON.stringify(selected.value.evidenceJson, null, 2)}
                                    </pre>
                                )}
                            </ThemedView>
                        </ThemedView>
                    </>
                )}
            </SlideOverDrawer>

            <FormModal
                modelValue={evidenceOpen.value}
                onUpdate:modelValue={(value: boolean) => (evidenceOpen.value = value)}
                title={t("Submit evidence")}
                size="md"
                loading={actionLoading.value}
                errorMessage={actionError.value}
                submitLabel={t("Submit evidence")}
                cancelLabel={t("Close")}
                onSubmit={() => void submitEvidence()}
            >
                <SectionFields title={t("Evidence details")}>
                    <FormField label={t("Evidence reference")} hint={t("Gateway portal reference or case number")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={evidenceReference.value}
                            onUpdate:modelValue={(value: string) => (evidenceReference.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Document URL")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={evidenceDocumentUrl.value}
                            onUpdate:modelValue={(value: string) => (evidenceDocumentUrl.value = value)}
                            placeholder="https://"
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Evidence notes")} sensitiveMakerChecker>
                        <VTextarea
                            modelValue={evidenceNotes.value}
                            onUpdate:modelValue={(value: string) => (evidenceNotes.value = value)}
                            rows={3}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...EVIDENCE_CHECKS]}
                    modelValue={evidenceChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (evidenceChecklist.value = value)}
                    show={showChecklists}
                    title={t("Evidence checklist")}
                    complete={evidenceChecklistComplete.value}
                    incompleteMessage={t("Complete all evidence checklist items before submitting")}
                />
            </FormModal>
        </ScreenContainer>
    );
});

export default DisputesPage;
