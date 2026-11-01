import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VDialog, VProgressCircular, VSelect, VTab, VTabs, VTextarea } from "vuetify/components";
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

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const openDetails = async (row: Cashout) => {
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

    const process = async () => {
        if (!selected.value) return;
        if (!selected.value.canProcess) return;
        if (decision.value === "REJECT" && reason.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.cashoutProcess(selected.value.id), {
                decision: decision.value,
                reason: reason.value.trim() || undefined,
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

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Open cash-outs"), value: String(data.totalOpen), tone: data.totalOpen > 0 ? "warning" as const : "success" as const },
            { label: t("Open amount"), value: formatMoney(data.openAmount), tone: "info" as const },
            { label: t("Pending"), value: String(data.pendingCount), tone: data.pendingCount > 0 ? "warning" as const : "success" as const },
            { label: t("Processing"), value: String(data.processingCount), tone: "info" as const },
            { label: t("Oldest pending"), value: formatHours(data.oldestPendingAgeHours), tone: data.oldestPendingAgeHours >= 72 ? "error" as const : data.oldestPendingAgeHours >= 24 ? "warning" as const : "success" as const },
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
            Value: ({ row }: { row: Cashout }) => <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{formatMoney(row.amount, row.currency)}</ThemedText>,
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
            Value: ({ row }: { row: Cashout }) => <ThemedText style={{ fontSize: "10px", direction: "ltr", opacity: 0.75 }}>{row.walletId}</ThemedText>,
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
                    end={() => <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>}
                />

                <VAlert type="info" variant="tonal">
                    {t("A cash-out moves money only when a finance checker approves it. Pending requests show the current wallet balance and the masked destination.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Cash-out health")}</ThemedText>
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
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <VTabs modelValue={activeView.value} onUpdate:modelValue={(value: unknown) => setView(value as CashoutView)} color="primary" density="comfortable" showArrows>
                    <VTab value="open" prependIcon="mdi-clock-alert-outline">{t("Open")}</VTab>
                    <VTab value="history" prependIcon="mdi-history">{t("History")}</VTab>
                    <VTab value="all" prependIcon="mdi-view-list-outline">{t("All")}</VTab>
                </VTabs>

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

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="900px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading cash-out")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{formatMoney(selected.value.amount, selected.value.currency)}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.merchantName || selected.value.merchantId}</ThemedText>
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
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Request context")}</ThemedText>
                                            {[
                                                [t("Merchant"), selected.value.merchantName || "—"],
                                                [t("Legal name"), selected.value.merchantLegalName || "—"],
                                                [t("Wallet"), selected.value.walletId],
                                                [t("Wallet status"), selected.value.walletStatus || "—"],
                                                [t("Wallet balance"), formatMoney(selected.value.walletBalance, selected.value.currency)],
                                                [t("Destination"), destinationText(selected.value.destination)],
                                                [t("Requested"), formatDateTime(selected.value.requestedAt)],
                                                [t("Last update"), formatDateTime(selected.value.updatedAt)],
                                                [t("Age"), formatHours(selected.value.ageHours)],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "MerchantDetail", params: { id: selected.value?.merchantId ?? "" } })}>{t("Open merchant")}</VBtn>
                                        </VCardText>
                                    </VCard>

                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Adjustment")}</ThemedText>
                                            {[
                                                [t("Adjustment state"), selected.value.adjustmentState || "—"],
                                                [t("Adjustment amount"), formatMoney(selected.value.adjustmentAmount, selected.value.currency)],
                                                [t("Adjustment reason"), selected.value.adjustmentReason || "—"],
                                                [t("Journal entry"), selected.value.adjustmentJournalEntryId || "—"],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                {selected.value.canProcess && (
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                            <ThemedText type="defaultSemiBold">{t("Finance decision")}</ThemedText>
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
                                                <VBtn color={decision.value === "APPROVE" ? "success" : "error"} loading={actionLoading.value} onClick={() => void process()}>
                                                    {decision.value === "APPROVE" ? t("Approve cash-out") : t("Reject cash-out")}
                                                </VBtn>
                                                <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                )}

                                {!selected.value.canProcess && (
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

export default CashoutsPage;
