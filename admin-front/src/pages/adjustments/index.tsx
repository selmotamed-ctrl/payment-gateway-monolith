import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import {
    VAlert,
    VAutocomplete,
    VBtn,
    VCard,
    VCardText,
    VDialog,
    VProgressCircular,
    VSelect,
    VSwitch,
    VTab,
    VTabs,
    VTextField,
    VTextarea,
} from "vuetify/components";
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
const OPEN_STATES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTING"];
const EXECUTED_STATES = ["EXECUTED"];

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

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
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
            const response = await api.get(urlsMap.adjustmentDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.adjustment ?? payload) as AdjustmentDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const openCreate = () => {
        form.value = emptyForm();
        glAccountOptions.value = [];
        createOpen.value = true;
        void loadMerchants();
    };

    const onMerchantChanged = (value: string) => {
        form.value.merchantId = value ?? "";
        form.value.targetGlAccountId = "";
        void loadGlAccounts(form.value.merchantId);
    };

    const submit = async () => {
        const amount = form.value.amount.trim();
        if (!/^\d{1,14}(\.\d{1,4})?$/.test(amount)) {
            showSnackBar({ type: "warning", message: t("Amount must be a decimal with up to 4 places") });
            return;
        }
        if (form.value.reason.trim().length < 2) {
            showSnackBar({ type: "warning", message: t("Reason is required") });
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
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Open adjustments"), value: String(data.totalOpen), tone: data.totalOpen > 0 ? "warning" as const : "success" as const },
            { label: t("Open amount"), value: formatMoney(data.openAmount), tone: "info" as const },
            { label: t("Executed"), value: String(data.executedCount), tone: "success" as const },
            { label: t("Executed amount"), value: formatMoney(data.executedAmount), tone: "neutral" as const },
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
            Value: ({ row }: { row: Adjustment }) => <StatusChip label={row.state} tone={statusTone(row.state)} size="small" />,
        },
        {
            key: "amount",
            label: "Amount",
            sortKey: "amount",
            value: (row) => row.amount,
            Value: ({ row }: { row: Adjustment }) => <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{formatMoney(row.amount, row.currency)}</ThemedText>,
        },
        {
            key: "merchant",
            label: "Merchant",
            value: (row) => row.merchantName,
            Value: ({ row }: { row: Adjustment }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.merchantName || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.merchantId ?? ""}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "source",
            label: "Source",
            value: (row) => `${row.sourceAttemptReference ?? ""} ${row.disputeReference ?? ""}`,
            Value: ({ row }: { row: Adjustment }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "10px", direction: "ltr", opacity: row.sourceAttemptReference ? 1 : 0.55 }}>{row.sourceAttemptReference || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", direction: "ltr", opacity: row.disputeReference ? 1 : 0.55 }}>{row.disputeReference || "—"}</ThemedText>
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
                ? <StatusChip label={row.approvalState} tone={statusTone(row.approvalState)} size="x-small" />
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
            Value: ({ row }: { row: Adjustment }) => <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>,
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Adjustments")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("Propose")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Every adjustment is a draft plus an approval request. Money moves only after a different finance checker approves it.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Adjustment health")}</ThemedText>
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
                                {Object.entries(summary.value.byState ?? {}).map(([state, count]) => (
                                    <StatusChip key={state} label={`${state}: ${count}`} tone={statusTone(state)} size="x-small" />
                                ))}
                                {Object.entries(summary.value.byType ?? {}).map(([type, count]) => (
                                    <StatusChip key={type} label={`${type}: ${count}`} tone="neutral" size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <VTabs modelValue={activeView.value} onUpdate:modelValue={(value: unknown) => setView(value as AdjustmentView)} color="primary" density="comfortable" showArrows>
                    <VTab value="open" prependIcon="mdi-clock-alert-outline">{t("Open")}</VTab>
                    <VTab value="executed" prependIcon="mdi-check-circle-outline">{t("Executed")}</VTab>
                    <VTab value="all" prependIcon="mdi-view-list-outline">{t("All")}</VTab>
                </VTabs>

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

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="1000px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading adjustment")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selected.value.type} · {formatMoney(selected.value.amount, selected.value.currency)}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.merchantName || selected.value.merchantId || "—"}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={selected.value.state} tone={statusTone(selected.value.state)} />
                                        {selected.value.approvalState && <StatusChip label={`approval ${selected.value.approvalState}`} tone={statusTone(selected.value.approvalState)} size="small" />}
                                        {selected.value.draftedBySystem && <StatusChip label={t("System draft")} tone="info" size="small" />}
                                    </ThemedView>
                                </ThemedView>

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Adjustment context")}</ThemedText>
                                            {[
                                                [t("Merchant"), selected.value.merchantName || "—"],
                                                [t("Source attempt"), selected.value.sourceAttemptReference || selected.value.sourceAttemptId || "—"],
                                                [t("Attempt status"), selected.value.sourceAttemptStatus || "—"],
                                                [t("Dispute"), selected.value.disputeReference || selected.value.disputeId || "—"],
                                                [t("Dispute status"), selected.value.disputeStatus || "—"],
                                                [t("Dispute amount"), formatMoney(selected.value.disputeAmount, selected.value.currency)],
                                                [t("Target account"), `${selected.value.targetAccountType || "—"} · ${selected.value.currency}`],
                                                [t("Reverse commission"), selected.value.reverseCommission ? t("Yes") : t("No")],
                                                [t("Reason"), selected.value.reason],
                                                [t("Created"), formatDateTime(selected.value.createdAt)],
                                                [t("Executed"), formatDateTime(selected.value.executedAt)],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
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
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval and ledger")}</ThemedText>
                                            {[
                                                [t("Approval request"), selected.value.approvalRequestId || "—"],
                                                [t("Approval state"), selected.value.approvalState || "—"],
                                                [t("Checker"), selected.value.approval?.checkerUserId || selected.value.checkerUserId || "—"],
                                                [t("Rejection reason"), selected.value.approval?.rejectionReason || "—"],
                                                [t("Journal entry"), selected.value.journalEntryId || "—"],
                                                [t("Journal type"), selected.value.journalEntry?.refType || "—"],
                                                [t("Journal reference"), selected.value.journalEntry?.refId || "—"],
                                                [t("External dispute ref"), selected.value.externalDisputeRef || "—"],
                                                [t("Provider refund ref"), selected.value.providerRefundRef || "—"],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            {selected.value.approvalRequestId && (
                                                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                    <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                </ThemedView>
                            </>
                        )}
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} maxWidth="720px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Propose adjustment")}</ThemedText>
                        <VAlert type="info" variant="tonal">
                            {t("The draft creates an approval request. The adjustment does not execute until a different finance checker approves it.")}
                        </VAlert>
                        <VSelect
                            items={ADJUSTMENT_TYPES.map((value) => ({ title: value, value }))}
                            modelValue={form.value.type}
                            onUpdate:modelValue={(value: string) => (form.value.type = value)}
                            label={t("Adjustment type")}
                        />
                        <VTextField
                            label={t("Amount")}
                            modelValue={form.value.amount}
                            onUpdate:modelValue={(value: string) => (form.value.amount = value)}
                            placeholder="0.0000"
                        />
                        <VAutocomplete
                            label={t("Merchant")}
                            items={merchantOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={form.value.merchantId}
                            onUpdate:modelValue={(value: string | null) => onMerchantChanged(value ?? "")}
                        />
                        <VAutocomplete
                            label={t("Target merchant wallet account")}
                            items={glAccountOptions.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={form.value.targetGlAccountId}
                            onUpdate:modelValue={(value: string | null) => (form.value.targetGlAccountId = value ?? "")}
                            disabled={!form.value.merchantId}
                            hint={form.value.merchantId ? t("Select the merchant wallet GL account") : t("Choose a merchant first")}
                            persistentHint
                        />
                        <VTextField
                            label={t("Reason")}
                            modelValue={form.value.reason}
                            onUpdate:modelValue={(value: string) => (form.value.reason = value)}
                        />
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                            <VTextField
                                label={t("Source attempt ID (optional)")}
                                modelValue={form.value.sourceAttemptId}
                                onUpdate:modelValue={(value: string) => (form.value.sourceAttemptId = value)}
                            />
                            <VTextField
                                label={t("Dispute ID (optional)")}
                                modelValue={form.value.disputeId}
                                onUpdate:modelValue={(value: string) => (form.value.disputeId = value)}
                            />
                        </ThemedView>
                        <VTextField
                            label={t("External dispute reference (optional)")}
                            modelValue={form.value.externalDisputeRef}
                            onUpdate:modelValue={(value: string) => (form.value.externalDisputeRef = value)}
                        />
                        <VSwitch
                            label={t("Reverse commission")}
                            modelValue={form.value.reverseCommission}
                            onUpdate:modelValue={(value: unknown) => (form.value.reverseCommission = Boolean(value))}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn
                                color="primary"
                                loading={actionLoading.value}
                                disabled={!form.value.merchantId || !form.value.targetGlAccountId || !form.value.amount.trim() || form.value.reason.trim().length < 2}
                                onClick={() => void submit()}
                            >
                                {t("Create draft")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AdjustmentsPage;
