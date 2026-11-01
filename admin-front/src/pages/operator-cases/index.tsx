import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import {
    VBtn,
    VCard,
    VCardText,
    VCheckbox,
    VDialog,
    VDivider,
} from "vuetify/components";
import { useRouter } from "vue-router";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { MoneyText } from "@/components/MoneyText";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import { statusTone } from "@/components/Table/statusTone";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
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

const OperatorCasesPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();

    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const rows = ref<OperatorCaseSummary[]>([]);
    const total = ref(0);
    const summary = ref<OperatorCasesSummary | null>(null);
    const pageSize = ref(20);
    const selected = ref<Record<string, OperatorCaseSummary>>({});
    const bulkLoading = ref(false);
    const inquiringId = ref<string | null>(null);
    const bulkResult = ref<BulkInquiryResult | null>(null);
    const resultOpen = ref(false);
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

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Queue"), value: String(data.total), tone: "info" as const },
            { label: t("P1 open"), value: String(data.p1Open), tone: data.p1Open > 0 ? "error" as const : "success" as const },
            { label: t("Overdue"), value: String(data.overdue), tone: data.overdue > 0 ? "error" as const : "success" as const },
            { label: t("Unassigned"), value: String(data.unassigned), tone: data.unassigned > 0 ? "warning" as const : "success" as const },
            { label: t("Pending checker"), value: String(data.pendingChecker), tone: data.pendingChecker > 0 ? "warning" as const : "success" as const },
            { label: t("Resolved"), value: String(data.resolved), tone: "success" as const },
        ];
    });
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);

    const canInquire = computed(() => hasOneOfAuthorities(["attempt:inquire", "case:write"]));
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

    const runBulkInquiry = async (caseIds: string[]) => {
        if (caseIds.length === 0) return;
        bulkLoading.value = true;
        try {
            const response = await api.post(urlsMap.operatorCasesBulkInquire, { caseIds });
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

    const inquireOne = async (row: OperatorCaseSummary) => {
        inquiringId.value = row.id;
        try {
            await runBulkInquiry([row.id]);
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
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600, direction: "ltr", unicodeBidi: "isolate" }}>
                        {row.attemptReference || "—"}
                    </ThemedText>
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
            key: "actions",
            label: "Actions",
            sortable: false,
            headerTooltip: COLUMN_HELP.actions,
            Value: ({ row }: { row: OperatorCaseSummary }) => {
                const eligibility = row.inquiryEligibility;
                return (
                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center" }}>
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
                        </ThemedView>
                    )}
                />

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", flex: 1 }}>{t("Operator queue health")}</ThemedText>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("P1 target: 4h · P2 target: 24h")}</ThemedText>
                            </ThemedView>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
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
                                {Object.entries(summary.value.byPriority ?? {}).map(([priority, count]) => (
                                    <StatusChip key={priority} label={`${priority}: ${count}`} tone={statusTone(priority)} size="x-small" />
                                ))}
                                {Object.entries(summary.value.byState ?? {}).map(([state, count]) => (
                                    <StatusChip key={state} label={`${state.replaceAll("_", " ")}: ${count}`} tone={statusTone(state)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
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
                                    color="primary"
                                    variant="flat"
                                    prependIcon="mdi-radar"
                                    loading={bulkLoading.value}
                                    disabled={selectedCount.value === 0 || !canInquire.value}
                                    onClick={() => void runBulkInquiry(Object.keys(selected.value))}
                                >
                                    {t("Inquire selected")} ({selectedCount.value})
                                </VBtn>
                            </ThemedView>
                            <VDivider />
                        </ThemedView>
                    )}
                />
            </ThemedView>

            <VDialog
                modelValue={resultOpen.value}
                onUpdate:modelValue={(value: boolean | null) => (resultOpen.value = Boolean(value))}
                maxWidth="820px"
                scrollable
            >
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {t("Bulk inquiry result")}
                        </ThemedText>
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
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default OperatorCasesPage;
