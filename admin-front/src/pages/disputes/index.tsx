import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VProgressCircular, VTab, VTabs, VTextarea, VTextField } from "vuetify/components";
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
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

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

    const openDetails = async (row: Dispute) => {
        selected.value = {
            ...row,
            attemptSettledAmount: "0.0000",
            adjustmentReason: null,
            evidenceJson: null,
            canSubmitEvidence: false,
            evidenceBlockedReason: null,
        };
        evidenceReference.value = "";
        evidenceDocumentUrl.value = "";
        evidenceNotes.value = "";
        evidenceChecklist.value = {};
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.disputeDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.dispute ?? payload) as DisputeDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const evidenceChecklistComplete = computed(() => !showChecklists || EVIDENCE_CHECKS.every((check) => evidenceChecklist.value[check.key] === true));

    const submitEvidence = async () => {
        if (!selected.value) return;
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
            detailsOpen.value = false;
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

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Open disputes"), value: String(data.totalOpen), tone: data.totalOpen > 0 ? "warning" as const : "success" as const },
            { label: t("Open amount"), value: formatMoney(data.openAmount), tone: "info" as const },
            { label: t("Evidence due in 48h"), value: String(data.dueSoon), tone: data.dueSoon > 0 ? "warning" as const : "success" as const },
            { label: t("Evidence overdue"), value: String(data.overdue), tone: data.overdue > 0 ? "error" as const : "success" as const },
            { label: t("Earliest evidence due"), value: formatDateTime(data.earliestEvidenceDueAt), tone: "neutral" as const },
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
                    <ThemedText style={{ fontSize: "11px", direction: "ltr", fontWeight: 600 }}>{row.externalDisputeRef}</ThemedText>
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
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.merchantId ?? ""}</ThemedText>
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
                    <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.attemptReference || row.attemptId}</ThemedText>
                    {row.attemptStatus && <StatusChip label={row.attemptStatus} tone={statusTone(row.attemptStatus)} size="x-small" />}
                </ThemedView>
            ),
        },
        {
            key: "amount",
            label: "Amount",
            sortKey: "amount",
            value: (row) => row.amount,
            Value: ({ row }: { row: Dispute }) => <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{formatMoney(row.amount, row.currency)}</ThemedText>,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: Dispute }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="small" />,
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
                    ? <StatusChip label={t("Overdue")} tone="error" size="x-small" />
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
                ? <StatusChip label={row.adjustmentState} tone={statusTone(row.adjustmentState)} size="x-small" />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: Dispute }) => <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>,
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Disputes")}
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
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Dispute health")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
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
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
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

                <VTabs modelValue={activeView.value} onUpdate:modelValue={(value: unknown) => setView(value as DisputeView)} color="primary" density="comfortable" showArrows>
                    <VTab value="open" prependIcon="mdi-alert-circle-outline">{t("Open")}</VTab>
                    <VTab value="resolved" prependIcon="mdi-check-circle-outline">{t("Resolved")}</VTab>
                    <VTab value="all" prependIcon="mdi-view-list-outline">{t("All")}</VTab>
                </VTabs>

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

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="1040px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading dispute")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selected.value.externalDisputeRef}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{formatMoney(selected.value.amount, selected.value.currency)} · {selected.value.source}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={selected.value.status} tone={statusTone(selected.value.status)} />
                                        {selected.value.evidenceOverdue && <StatusChip label={t("Evidence overdue")} tone="error" size="small" />}
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

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Dispute context")}</ThemedText>
                                            {[
                                                [t("Merchant"), selected.value.merchantName || "—"],
                                                [t("Attempt"), selected.value.attemptReference || selected.value.attemptId],
                                                [t("Attempt status"), selected.value.attemptStatus || "—"],
                                                [t("Settled amount"), formatMoney(selected.value.attemptSettledAmount, selected.value.currency)],
                                                [t("Rail"), `${selected.value.railCode || "—"} ${selected.value.railName || ""}`.trim()],
                                                [t("Gateway"), `${selected.value.gatewayCode || "—"} ${selected.value.gatewayName || ""}`.trim()],
                                                [t("Reason"), selected.value.reasonCode || "—"],
                                                [t("Opened"), formatDateTime(selected.value.openedAt)],
                                                [t("Evidence due"), selected.value.evidenceOverdue ? t("Overdue") : formatDateTime(selected.value.evidenceDueAt)],
                                                [t("Outcome"), formatDateTime(selected.value.outcomeAt)],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            {selected.value.merchantId && (
                                                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "MerchantDetail", params: { id: selected.value?.merchantId ?? "" } })}>{t("Open merchant")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>

                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Adjustment and evidence")}</ThemedText>
                                            {[
                                                [t("Adjustment state"), selected.value.adjustmentState || "—"],
                                                [t("Adjustment reason"), selected.value.adjustmentReason || "—"],
                                                [t("Journal entry"), selected.value.adjustmentJournalEntryId || "—"],
                                                [t("Evidence submitted"), formatDateTime(selected.value.evidenceSubmittedAt)],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            {selected.value.evidenceJson && (
                                                <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "180px", overflow: "auto" }}>
                                                    {JSON.stringify(selected.value.evidenceJson, null, 2)}
                                                </pre>
                                            )}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                {selected.value.canSubmitEvidence && (
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Submit evidence")}</ThemedText>
                                            <VTextField
                                                label={t("Evidence reference")}
                                                modelValue={evidenceReference.value}
                                                onUpdate:modelValue={(value: string) => (evidenceReference.value = value)}
                                                placeholder={t("Gateway portal reference or case number")}
                                            />
                                            <VTextField
                                                label={t("Document URL")}
                                                modelValue={evidenceDocumentUrl.value}
                                                onUpdate:modelValue={(value: string) => (evidenceDocumentUrl.value = value)}
                                                placeholder="https://"
                                            />
                                            {showChecklists && (
                                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Evidence checklist")}</ThemedText>
                                                    {EVIDENCE_CHECKS.map((check) => (
                                                        <VCheckbox
                                                            key={check.key}
                                                            modelValue={evidenceChecklist.value[check.key] === true}
                                                            onUpdate:modelValue={(value: unknown) => (evidenceChecklist.value = { ...evidenceChecklist.value, [check.key]: Boolean(value) })}
                                                            label={t(check.label)}
                                                            density="compact"
                                                            hideDetails
                                                        />
                                                    ))}
                                                    {!evidenceChecklistComplete.value && (
                                                        <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all evidence checklist items before submitting")}</ThemedText>
                                                    )}
                                                </ThemedView>
                                            )}
                                            <VTextarea
                                                label={t("Evidence notes")}
                                                modelValue={evidenceNotes.value}
                                                onUpdate:modelValue={(value: string) => (evidenceNotes.value = value)}
                                                rows={3}
                                            />
                                            <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                                <VBtn color="primary" loading={actionLoading.value} disabled={!evidenceChecklistComplete.value} onClick={() => void submitEvidence()}>{t("Submit evidence")}</VBtn>
                                                <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                )}

                                {!selected.value.canSubmitEvidence && (
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

export default DisputesPage;
