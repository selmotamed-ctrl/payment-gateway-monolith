import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCheckbox, VProgressCircular, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
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

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList } from "@/components/ui/DescriptionList";
type Cashout = {
    id: string;
    merchantId: string;
    merchantName: string;
    walletId: string;
    currency: string;
    amount: string;
    state: string;
    destination: Record<string, unknown>;
    adjustmentId: string | null;
    adjustmentState: string | null;
    adjustmentJournalEntryId: string | null;
    requestedAt: string;
    createdAt: string;
    updatedAt: string;
    ageHours: number;
};

type CashoutDetail = Cashout & {
    merchantLegalName: string;
    walletStatus: string;
    walletBalance: string | null;
    adjustmentReason: string | null;
    adjustmentAmount: string | null;
    canProcess: boolean;
    processBlockedReason: string | null;
};

type CashoutSummary = {
    totalOpen: number;
    openAmount: string;
    pendingCount: number;
    processingCount: number;
    completedCount: number;
    subtractedCount: number;
    rejectedCount: number;
    oldestPendingAgeHours: number;
    byState: Record<string, number>;
    amountByState: Record<string, string>;
};

type CashoutView = "open" | "history" | "all";

const SUMMARY_EXPORT_CHECKS = [
    { key: "OPEN_SCOPE_VERIFIED", label: "Open cash-out scope verified" },
    { key: "AMOUNT_TOTALS_REVIEWED", label: "Amount totals reviewed" },
    { key: "STATE_BREAKDOWN_REVIEWED", label: "State breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const PROCESS_CHECKS = [
    { key: "BANK_DETAILS_VERIFIED", label: "Bank details snapshot verified" },
    { key: "WALLET_BALANCE_VERIFIED", label: "Wallet balance and holds verified" },
    { key: "MERCHANT_ACTIVE", label: "Merchant is active and not suspended" },
    { key: "NO_AML_RESTRICTIONS", label: "No AML restriction blocks the payout" },
] as const;

const OPEN_STATES = ["PENDING", "PROCESSING"];
const HISTORY_STATES = ["COMPLETE", "SUBTRACTED", "REJECTED"];

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

const destinationText = (destination: Record<string, unknown> | null | undefined): string => {
    if (!destination) return "—";
    const bank = String(destination.bank ?? destination.bankName ?? "");
    const account = String(destination.account ?? destination.accountNumber ?? destination.iban ?? "");
    return [bank, account].filter(Boolean).join(" · ") || "—";
};

const CashoutsPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const rows = ref<Cashout[]>([]);
    const total = ref(0);
    const summary = ref<CashoutSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<CashoutView>("open");
    const filters = ref<FilterValues>({ state: [...OPEN_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const selected = ref<CashoutDetail | null>(null);
    const detailLoading = ref(false);
    const decision = ref<"APPROVE" | "REJECT">("APPROVE");
    const reason = ref("");
    const actionLoading = ref(false);
    const checklist = ref<Record<string, boolean>>({});
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});

    const filterDefinitions = computed(() => tableRegistry.CashOuts?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.cashoutsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as CashoutSummary;
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
            ? { state: [...OPEN_STATES] }
            : activeView.value === "history"
              ? { state: [...HISTORY_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const setView = (view: CashoutView) => {
        activeView.value = view;
        filters.value = view === "open"
            ? { state: [...OPEN_STATES] }
            : view === "history"
              ? { state: [...HISTORY_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.cashoutsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.cashouts ?? []) as Cashout[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No cash-outs match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "merchant", "walletId", "currency", "amount", "state", "adjustmentId", "adjustmentState", "requestedAt", "ageHours"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.merchantName || row.merchantId,
                        row.walletId,
                        row.currency,
                        row.amount,
                        row.state,
                        row.adjustmentId ?? "",
                        row.adjustmentState ?? "",
                        row.requestedAt,
                        row.ageHours,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `cashouts-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.cashoutsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as CashoutSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total_open", snapshot.totalOpen],
                ["open_amount", snapshot.openAmount],
                ["pending_count", snapshot.pendingCount],
                ["processing_count", snapshot.processingCount],
                ["completed_count", snapshot.completedCount],
                ["subtracted_count", snapshot.subtractedCount],
                ["rejected_count", snapshot.rejectedCount],
                ["oldest_pending_age_hours", snapshot.oldestPendingAgeHours],
            ];
            for (const [state, count] of Object.entries(snapshot.byState ?? {})) {
                rows.push([`state.${state}.count`, count]);
                rows.push([`state.${state}.amount`, snapshot.amountByState?.[state] ?? "0"]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `cashout-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Cash-out summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const openDetails = async (row: Cashout) => {
        checklist.value = {};
        selected.value = {
            ...row,
            merchantLegalName: "",
            walletStatus: "",
            walletBalance: null,
            adjustmentReason: null,
            adjustmentAmount: null,
            canProcess: row.state === "PENDING",
            processBlockedReason: row.state === "PENDING" ? null : "CASHOUT_NOT_PENDING",
        };
        decision.value = "APPROVE";
        reason.value = "";
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.cashoutDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.cashout ?? payload) as CashoutDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const checklistComplete = computed(() => !showChecklists || PROCESS_CHECKS.every((check) => checklist.value[check.key] === true));

    const process = async () => {
        if (!selected.value) return;
        if (!selected.value.canProcess) return;
        if (!checklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all checklist items before processing") });
            return;
        }
        if (decision.value === "REJECT" && reason.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.cashoutProcess(selected.value.id), {
                decision: decision.value,
                reason: reason.value.trim() || undefined,
                checklist: PROCESS_CHECKS.filter((check) => checklist.value[check.key]).map((check) => check.key),
            });
            showSnackBar({ type: "success", message: decision.value === "APPROVE" ? t("Cash-out approved") : t("Cash-out rejected") });
            detailsOpen.value = false;
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };

    const summaryMetrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "open", label: t("Open cash-outs"), value: String(data.totalOpen), badge: data.totalOpen > 0 ? t("Pending") : t("Clear"), badgeTone: data.totalOpen > 0 ? "warning" : "success" },
            { key: "openAmount", label: t("Open amount"), moneyAmount: data.openAmount, currency: "LYD" },
            { key: "pending", label: t("Pending"), value: String(data.pendingCount), badge: data.pendingCount > 0 ? t("Pending") : t("Clear"), badgeTone: data.pendingCount > 0 ? "warning" : "success" },
            { key: "processing", label: t("Processing"), value: String(data.processingCount), badge: t("Processing"), badgeTone: "info" },
            { key: "oldest", label: t("Oldest pending"), value: formatHours(data.oldestPendingAgeHours), badge: data.oldestPendingAgeHours >= 72 ? t("Overdue") : undefined, badgeTone: data.oldestPendingAgeHours >= 72 ? "danger" : "success" },
        ];
    });

    const headers = computed<TableHeader<Cashout>[]>(() => [
        {
            key: "merchant",
            label: "Merchant",
            headerTooltip: "Merchant that requested this cash-out.",
            value: (row) => row.merchantName,
            Value: ({ row }: { row: Cashout }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.merchantName || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.merchantId}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "amount",
            label: "Amount",
            sortKey: "amount",
            value: (row) => row.amount,
            Value: ({ row }: { row: Cashout }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />,
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            value: (row) => row.state,
            Value: ({ row }: { row: Cashout }) => <StatusChip label={row.state} tone={statusTone(row.state)} size="small" />,
        },
        {
            key: "destination",
            label: "Destination",
            headerTooltip: "Masked destination bank details. The full account remains in the finance record.",
            value: (row) => destinationText(row.destination),
        },
        {
            key: "wallet",
            label: "Wallet",
            value: (row) => row.walletId,
            Value: ({ row }: { row: Cashout }) => <MonoRef value={row.walletId} />,
        },
        {
            key: "requestedAt",
            label: "Requested",
            sortKey: "requestedAt",
            value: (row) => row.requestedAt,
            Value: ({ row }: { row: Cashout }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.requestedAt)}</ThemedText>,
        },
        {
            key: "age",
            label: "Age",
            value: (row) => String(row.ageHours),
            Value: ({ row }: { row: Cashout }) => <StatusChip label={formatHours(row.ageHours)} tone={row.ageHours >= 72 ? "error" : row.ageHours >= 24 ? "warning" : "neutral"} size="x-small" />,
        },
        {
            key: "adjustment",
            label: "Adjustment",
            headerTooltip: "The subtraction adjustment created when the cash-out is completed.",
            value: (row) => row.adjustmentState ?? "",
            Value: ({ row }: { row: Cashout }) => row.adjustmentState
                ? <StatusChip label={row.adjustmentState} tone={statusTone(row.adjustmentState)} size="x-small" />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: Cashout }) => (
                <VBtn size="small" variant={row.state === "PENDING" ? "tonal" : "text"} onClick={() => void openDetails(row)}>
                    {row.state === "PENDING" ? t("Process") : t("Review")}
                </VBtn>
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Cash-Outs")}
                    subtitle={t("Review and process merchant cash-out requests with wallet, destination, and AML checks.")}
                    badge={t("Payouts")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("A cash-out moves money only when a finance checker approves it. Pending requests show the current wallet balance and the masked destination.")}
                </VAlert>

                {summary.value && (
                    <>
                        <MetricStrip items={summaryMetrics.value} />
                        <SurfaceCard title={t("Cash-out health")}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
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
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    {Object.entries(summary.value.byState ?? {}).map(([state, count]) => (
                                        <StatusChip key={state} label={`${state}: ${count}`} tone={statusTone(state)} size="x-small" />
                                    ))}
                                </ThemedView>
                            </SurfaceCardText>
                        </SurfaceCard>
                    </>
                )}

                <SegmentedTabs
                    modelValue={activeView.value}
                    onUpdate:modelValue={(value: string) => setView(value as CashoutView)}
                    tabs={[
                        { value: "open", label: t("Open") },
                        { value: "history", label: t("History") },
                        { value: "all", label: t("All") },
                    ]}
                />

                <ApiTable<Cashout>
                    title={t("Cash-out queue")}
                    url={urlsMap.cashoutsList}
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
                    rowColor={(row) => (row.state === "PENDING" ? "#d97706" : row.state === "PROCESSING" ? "#2563eb" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { cashouts?: Cashout[]; rows?: Cashout[] };
                        return payload.cashouts ?? payload.rows ?? [];
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

            <FormModal
                modelValue={detailsOpen.value}
                onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)}
                title={formatMoney(selected.value?.amount, selected.value?.currency)}
                size="lg"
            >
{detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading cash-out")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <MoneyDisplay amount={selected.value.amount} currency={selected.value.currency} colorSign />
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.merchantName || selected.value.merchantId}</ThemedText>
                                        </ThemedView>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={selected.value.state} tone={statusTone(selected.value.state)} />
                                        {selected.value.adjustmentState && <StatusChip label={selected.value.adjustmentState} tone={statusTone(selected.value.adjustmentState)} size="small" />}
                                    </ThemedView>
                                </ThemedView>

                                {!selected.value.canProcess && (
                                    <VAlert type="info" variant="tonal">
                                        {t("Only a PENDING cash-out can be processed. This request is read-only.")}
                                    </VAlert>
                                )}

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                                    <SurfaceCard variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Request context")}</ThemedText>
                                            <DescriptionList items={[
                                                { label: t("Merchant"), value: selected.value.merchantName || "—" },
                                                { label: t("Legal name"), value: selected.value.merchantLegalName || "—" },
                                                { label: t("Wallet"), value: <MonoRef value={selected.value.walletId} /> },
                                                { label: t("Wallet status"), value: selected.value.walletStatus || "—" },
                                                { label: t("Wallet balance"), value: <MoneyDisplay amount={selected.value.walletBalance} currency={selected.value.currency} size="sm" /> },
                                                { label: t("Destination"), value: destinationText(selected.value.destination) },
                                                { label: t("Requested"), value: formatDateTime(selected.value.requestedAt) },
                                                { label: t("Last update"), value: formatDateTime(selected.value.updatedAt) },
                                                { label: t("Age"), value: formatHours(selected.value.ageHours) },
                                            ]} />
                                            <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "MerchantDetail", params: { id: selected.value?.merchantId ?? "" } })}>{t("Open merchant")}</VBtn>
                                        </SurfaceCardText>
                                    </SurfaceCard>

                                    <SurfaceCard variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Adjustment")}</ThemedText>
                                            <DescriptionList items={[
                                                { label: t("Adjustment state"), value: selected.value.adjustmentState || "—" },
                                                { label: t("Adjustment amount"), value: <MoneyDisplay amount={selected.value.adjustmentAmount} currency={selected.value.currency} size="sm" colorSign /> },
                                                { label: t("Adjustment reason"), value: selected.value.adjustmentReason || "—" },
                                                { label: t("Journal entry"), value: <MonoRef value={selected.value.adjustmentJournalEntryId ?? ""} /> },
                                            ]} />
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                </ThemedView>

                                {selected.value.canProcess && (
                                    <SurfaceCard variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Finance decision")}</ThemedText>
                                            {showChecklists && (
                                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Process checklist")}</ThemedText>
                                                    {PROCESS_CHECKS.map((check) => (
                                                        <VCheckbox
                                                            key={check.key}
                                                            modelValue={checklist.value[check.key] === true}
                                                            onUpdate:modelValue={(value: unknown) => (checklist.value = { ...checklist.value, [check.key]: Boolean(value) })}
                                                            label={t(check.label)}
                                                            density="compact"
                                                            hideDetails
                                                        />
                                                    ))}
                                                    {!checklistComplete.value && (
                                                        <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all checklist items before processing")}</ThemedText>
                                                    )}
                                                </ThemedView>
                                            )}
                                            <VSelect
                                                items={[
                                                    { title: t("Approve and execute"), value: "APPROVE" },
                                                    { title: t("Reject and release"), value: "REJECT" },
                                                ]}
                                                modelValue={decision.value}
                                                onUpdate:modelValue={(value: string) => (decision.value = value as "APPROVE" | "REJECT")}
                                                label={t("Decision")}
                                            />
                                            <VTextarea
                                                rows={3}
                                                modelValue={reason.value}
                                                onUpdate:modelValue={(value: string) => (reason.value = value)}
                                                label={t("Decision reason")}
                                                hint={t("Required for rejection.")}
                                                persistentHint
                                            />
                                            <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                                <VBtn color={decision.value === "APPROVE" ? "success" : "error"} loading={actionLoading.value} disabled={!checklistComplete.value} onClick={() => void process()}>
                                                    {decision.value === "APPROVE" ? t("Approve cash-out") : t("Reject cash-out")}
                                                </VBtn>
                                                <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                            </ThemedView>
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                )}

                                {!selected.value.canProcess && (
                                    <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                        <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                    </ThemedView>
                                )}
                            </>
                        )}
            </FormModal>
        </ScreenContainer>
    );
});

export default CashoutsPage;
