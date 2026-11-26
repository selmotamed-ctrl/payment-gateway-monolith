import { dc } from "@/utils/dc";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "@/utils/vael-compat";
import { VBtn } from "@/components/vael/VuetifyShim";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { type MetricItem } from "@/components/ui/MetricStrip";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { FormModal } from "@/components/ui/FormModal";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions, type RowActionItem } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import { statusTone } from "@/components/Table/statusTone";
import { inboundEventFilters } from "@/components/Table/registry/ledgerOps";
import type { TableHeader } from "@/components/Table/types";
import { JournalEntryDrawer } from "@/components/ledger/JournalEntryDrawer";
import { LedgerRefLink } from "@/components/ledger/LedgerRefLink";
import { formatDateTime } from "@/components/ledger/format";
import MerchantTransactionDialog from "@/pages/merchants/components/MerchantTransactionDialog";
import InboundEventDrawer from "./components/InboundEventDrawer";
import { INQUIRABLE_STATUSES } from "./lifecycle";
import type { InboundEventRow, TransactionRow, TransactionSummary } from "./types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { areChecklistsVisible } from "@/constants/env";
import { xlsxUIPipeline } from "@/utils/xlsx";

type TabKey = "attempts" | "inbound";

const INQUIRY_CHECKS = [
    { key: "INQUIRY_ELIGIBILITY_VERIFIED", label: "Attempt status and inquiry eligibility verified" },
    { key: "PAYMENT_STATE_REVIEWED", label: "Current payment state reviewed" },
    { key: "GATEWAY_CONTACT_CONFIRMED", label: "Gateway status inquiry confirmed" },
] as const;

type TableHook = {
    reset: () => void;
    refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
    refreshAsIs: () => void;
};

const SUMMARY_EXPORT_CHECKS = [
    { key: "TRANSACTION_SCOPE_VERIFIED", label: "Transaction scope verified" },
    { key: "STATUS_SETTLEMENT_REVIEWED", label: "Status and settlement breakdown reviewed" },
    { key: "ESCALATION_REVIEWED", label: "Escalated-case posture reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const toBadgeTone = (tone: ReturnType<typeof statusTone>) => (tone === "error" ? ("danger" as const) : tone === "primary" ? ("info" as const) : tone);

const TransactionsPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();

    const tab = ref<TabKey>(route.query.tab === "inbound" ? "inbound" : "attempts");
    const summary = ref<TransactionSummary | null>(null);
    const canInquire = computed(() => hasOneOfAuthorities(["attempt:inquire"]));
    const showChecklists = areChecklistsVisible();
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    // ---- attempts table
    const attemptSearch = ref<string | null>(null);
    const attemptFilters = ref<FilterValues>({});
    const attemptTotal = ref(0);
    const attemptPageSize = ref(25);
    const attemptHook = ref<TableHook | null>(null);
    const attemptFilterDefs = computed(() => tableRegistry.Transactions?.filters ?? []);
    let attemptTimer: ReturnType<typeof setTimeout> | undefined;

    // ---- inbound table
    const inboundSearch = ref<string | null>(null);
    const inboundFilters = ref<FilterValues>({});
    const inboundTotal = ref(0);
    const inboundPageSize = ref(25);
    const inboundHook = ref<TableHook | null>(null);
    let inboundTimer: ReturnType<typeof setTimeout> | undefined;

    // ---- drawers
    const attemptId = ref<string | null>(typeof route.query.open === "string" && route.query.open ? route.query.open : null);
    const inboundEventId = ref<string | null>(null);
    const journalEntryId = ref<string | null>(null);
    const inquiryRowTarget = ref<TransactionRow | null>(null);
    const inquiryChecklist = ref<Record<string, boolean>>({});
    const inquirySubmitting = ref(false);
    const inquiryChecklistComplete = computed(() => !showChecklists || INQUIRY_CHECKS.every((check) => inquiryChecklist.value[check.key] === true));

    watch(
        () => route.query.open,
        (value) => {
            if (typeof value === "string" && value) attemptId.value = value;
        },
    );

    const closeAttempt = () => {
        attemptId.value = null;
        if ("open" in route.query) {
            const nextQuery = { ...route.query };
            delete nextQuery.open;
            void router.replace({ query: nextQuery });
        }
    };

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.transactionsSummary);
            summary.value = (response.data?.data ?? response.data) as TransactionSummary;
        } catch {
            summary.value = null;
        }
    };
    void loadSummary();

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.transactionsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as TransactionSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total_24h", snapshot.total24h],
                ["settled_24h", snapshot.settled24h],
                ["in_flight_24h", snapshot.inFlight24h],
                ["failed_24h", snapshot.failed24h],
                ["escalated_24h", snapshot.escalated24h],
            ];
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `transaction-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines });
            showSnackBar({ type: "success", message: t("Transaction summary exported") });
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const onAttemptFilter = (key: string, value: unknown) => {
        attemptFilters.value = { ...attemptFilters.value, [key]: value };
        if (attemptTimer) clearTimeout(attemptTimer);
        attemptTimer = setTimeout(() => attemptHook.value?.reset(), 300);
    };
    const onInboundFilter = (key: string, value: unknown) => {
        inboundFilters.value = { ...inboundFilters.value, [key]: value };
        if (inboundTimer) clearTimeout(inboundTimer);
        inboundTimer = setTimeout(() => inboundHook.value?.reset(), 300);
    };

    const refreshAll = () => {
        attemptHook.value?.refreshAsIs();
        inboundHook.value?.refreshAsIs();
        void loadSummary();
    };

    const openInquiry = (row: TransactionRow) => {
        inquiryChecklist.value = {};
        inquiryRowTarget.value = row;
    };

    const inquireRow = async () => {
        const row = inquiryRowTarget.value;
        if (!row || !inquiryChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all inquiry checklist items before continuing") });
            return;
        }
        inquirySubmitting.value = true;
        try {
            const checklist = INQUIRY_CHECKS.filter((check) => inquiryChecklist.value[check.key]).map((check) => check.key);
            await api.post(urlsMap.attemptInquire(row.id), { checklist });
            showSnackBar({ type: "success", message: t("Attempt inquiry scheduled") });
            inquiryRowTarget.value = null;
            refreshAll();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            inquirySubmitting.value = false;
        }
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "total", label: t("Attempts (24h)"), value: String(data.total24h) },
            { key: "settled", label: t("Settled"), value: String(data.settled24h), badge: t("Succeeded"), badgeTone: "success" },
            { key: "inflight", label: t("In flight / verifying"), value: String(data.inFlight24h), badge: data.inFlight24h > 0 ? t("Open") : undefined, badgeTone: "info" },
            { key: "failed", label: t("Failed"), value: String(data.failed24h), badge: data.failed24h > 0 ? t("Review") : undefined, badgeTone: "danger" },
            { key: "escalated", label: t("Escalated to case"), value: String(data.escalated24h), badge: data.escalated24h > 0 ? t("Open cases") : undefined, badgeTone: "warning" },
        ];
    });

    const restricted = () => <span style={{ color: "var(--pg-ink-faint)", fontSize: "12px" }}>{t("Restricted")}</span>;

    const attemptHeaders = computed<TableHeader<TransactionRow>[]>(() => [
        {
            key: "reference",
            label: "Reference",
            value: (row) => row.reference,
            Value: ({ row }: { row: TransactionRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <LedgerRefLink value={row.reference} truncate={22} label={t("Open attempt")} onOpen={() => (attemptId.value = row.id)} />
                    <ThemedText style={{ fontSize: "10.5px", opacity: 0.55 }}>{formatDateTime(row.createdAt)}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: TransactionRow }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                    <StatusBadge status={row.status} label={row.status} toneOverride={toBadgeTone(statusTone(row.status))} />
                    {row.hasOpenCase && <StatusBadge status="ESCALATED" label={t("Case")} toneOverride="warning" showDot={false} />}
                </ThemedView>
            ),
        },
        {
            key: "requestedAmount",
            label: "Amount",
            sortKey: "requestedAmount",
            value: (row) => row.requestedAmount ?? "",
            Value: ({ row }: { row: TransactionRow }) => (row.requestedAmount === null ? restricted() : <MoneyDisplay amount={row.requestedAmount} currency={row.currency} size="sm" />),
        },
        {
            key: "merchant",
            label: "Merchant",
            value: (row) => row.merchant.tradeName || row.merchant.legalName,
            Value: ({ row }: { row: TransactionRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.merchant.tradeName || row.merchant.legalName}</ThemedText>
                    <ThemedText style={{ fontSize: "10.5px", opacity: 0.55 }}>{row.application.name}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "rail",
            label: "Rail",
            value: (row) => row.rail.code,
            Value: ({ row }: { row: TransactionRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.rail.code}</ThemedText>
                    <ThemedText style={{ fontSize: "10.5px", opacity: 0.55 }}>{row.gateway.code}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "providerReference",
            label: "Provider reference",
            value: (row) => row.providerReference ?? "",
            Value: ({ row }: { row: TransactionRow }) => (row.redactedFields.includes("providerReference") ? restricted() : <MonoRef value={row.providerReference ?? ""} truncate={16} />),
        },
        {
            key: "ledgerEntryId",
            label: "Ledger entry",
            value: (row) => row.ledgerEntryId ?? "",
            Value: ({ row }: { row: TransactionRow }) =>
                row.redactedFields.includes("ledgerEntryId") ? restricted() : <LedgerRefLink value={row.ledgerEntryId ?? ""} truncate={10} label={t("Open journal entry")} onOpen={(id: string) => (journalEntryId.value = id)} />,
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: TransactionRow }) => {
                const items: RowActionItem[] = [
                    {
                        key: "inquire",
                        label: t("Schedule inquiry"),
                        icon: "mdi-radar",
                        hidden: !(canInquire.value && INQUIRABLE_STATUSES.includes(row.status) && row.inquiryEligible !== false),
                        onClick: () => openInquiry(row),
                    },
                    {
                        key: "merchant",
                        label: t("Open merchant"),
                        icon: "mdi-storefront-outline",
                        onClick: () => void router.push({ name: "MerchantDetail", params: { id: row.merchantId } }),
                    },
                ];
                return <TableRowActions primaryAction={{ label: t("Inspect"), icon: "mdi-text-search", onClick: () => void (attemptId.value = row.id) }} items={items} />;
            },
        },
    ]);

    const inboundHeaders = computed<TableHeader<InboundEventRow>[]>(() => [
        {
            key: "receivedAt",
            label: "Received",
            sortKey: "receivedAt",
            value: (row) => row.receivedAt,
            Value: ({ row }: { row: InboundEventRow }) => <ThemedText style={{ fontSize: "11.5px" }}>{formatDateTime(row.receivedAt)}</ThemedText>,
        },
        {
            key: "gateway",
            label: "Gateway",
            sortKey: "gatewayId",
            value: (row) => row.gateway.code,
            Value: ({ row }: { row: InboundEventRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.gateway.code}</ThemedText>
                    <StatusBadge status={row.env} label={row.env} toneOverride={row.env === "LIVE" ? "warning" : "info"} showDot={false} />
                </ThemedView>
            ),
        },
        {
            key: "verified",
            label: "Signature",
            sortKey: "verified",
            value: (row) => (row.verified ? "VERIFIED" : "UNVERIFIED"),
            Value: ({ row }: { row: InboundEventRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <StatusBadge status={row.verified ? "VERIFIED" : "UNVERIFIED"} label={row.verified ? t("Verified") : t("Unverified")} toneOverride={row.verified ? "success" : "danger"} />
                    {row.verificationError && <ThemedText style={{ fontSize: "10.5px", color: "var(--pg-status-danger-text)" }}>{row.verificationError}</ThemedText>}
                </ThemedView>
            ),
        },
        { key: "sourceIp", label: "Source IP", value: (row) => row.sourceIp, Value: ({ row }: { row: InboundEventRow }) => <span class="pg-mono" style={{ fontSize: "12px" }}>{row.sourceIp}</span> },
        {
            key: "attempt",
            label: "Attempt",
            value: (row) => row.attemptId ?? "",
            Value: ({ row }: { row: InboundEventRow }) =>
                row.attemptId ? (
                    <LedgerRefLink value={row.attemptId} truncate={10} label={t("Open attempt")} onOpen={(id: string) => (attemptId.value = id)} />
                ) : (
                    <StatusBadge status="UNMATCHED" label={t("Unmatched")} toneOverride="warning" showDot={false} />
                ),
        },
        {
            key: "processingResult",
            label: "Processing result",
            value: (row) => row.processingResult ?? "",
            Value: ({ row }: { row: InboundEventRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.processingResult ?? t("Not processed")}</ThemedText>
                    {row.processedAt && <ThemedText style={{ fontSize: "10.5px", opacity: 0.55 }}>{formatDateTime(row.processedAt)}</ThemedText>}
                </ThemedView>
            ),
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: InboundEventRow }) => <TableRowActions primaryAction={{ label: t("Inspect"), icon: "mdi-text-search", onClick: () => void (inboundEventId.value = row.id) }} />,
        },
    ]);

    const attemptsView = () => (
        <>
            {summary.value && (
                <SummaryExportCard
                    title={t("Transaction health")}
                    metrics={metricItems.value}
                    checks={[...SUMMARY_EXPORT_CHECKS]}
                    checklist={summaryExportChecklist.value}
                    onUpdate:checklist={(value: Record<string, boolean>) => (summaryExportChecklist.value = value)}
                    showChecklists={showChecklists}
                    checklistComplete={summaryExportChecklistComplete.value}
                    exportLoading={summaryExportLoading.value}
                    exportDisabled={!summaryExportChecklistComplete.value}
                    exportLabel={t("Export summary")}
                    onExport={() => void exportSummary()}
                />
            )}
            <ApiTable<TransactionRow>
                title={t("Payment attempts")}
                url={urlsMap.transactionsList}
                localSearch={false}
                xlsx={false}
                showNumber={true}
                numberOfItemsPerPage={attemptPageSize.value}
                numberOfItemsPerPageChoices={[
                    { label: "10", value: 10 },
                    { label: "25", value: 25 },
                    { label: "50", value: 50 },
                    { label: "100", value: 100 },
                ]}
                setNumberOfItemsPerPage={(value) => (attemptPageSize.value = value)}
                searchValue={attemptSearch.value}
                setSearchValue={(value) => (attemptSearch.value = value)}
                headers={attemptHeaders.value}
                apiDataExtractor={(data) => ((data as { transactions?: TransactionRow[] }).transactions ?? [])}
                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                onData={(_rows, nextTotal) => {
                    attemptTotal.value = nextTotal;
                }}
                setRefreshHook={(hook) => {
                    attemptHook.value = hook as TableHook;
                }}
                clearRefreshHook={() => {
                    attemptHook.value = null;
                }}
                onRefresh={(table, refresh) => {
                    void refresh({
                        queryParams: {
                            page: table.page,
                            pageSize: attemptPageSize.value,
                            ...(attemptSearch.value ? { search: attemptSearch.value } : {}),
                            ...buildFilterQuery(attemptFilterDefs.value, attemptFilters.value),
                            ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                        },
                    });
                }}
                TopSlot={() => (
                    <TableFilters
                        filters={attemptFilterDefs.value}
                        values={attemptFilters.value}
                        total={attemptTotal.value}
                        onChange={onAttemptFilter}
                        onClear={() => {
                            attemptFilters.value = {};
                            attemptHook.value?.reset();
                        }}
                    />
                )}
            />
        </>
    );

    const inboundView = () => (
        <ApiTable<InboundEventRow>
            title={t("Inbound webhooks")}
            url={urlsMap.inboundEventsList}
            localSearch={false}
            xlsx={false}
            showNumber={true}
            numberOfItemsPerPage={inboundPageSize.value}
            numberOfItemsPerPageChoices={[
                { label: "10", value: 10 },
                { label: "25", value: 25 },
                { label: "50", value: 50 },
                { label: "100", value: 100 },
            ]}
            setNumberOfItemsPerPage={(value) => (inboundPageSize.value = value)}
            searchValue={inboundSearch.value}
            setSearchValue={(value) => (inboundSearch.value = value)}
            headers={inboundHeaders.value}
            rowColor={(row) => (row.verified ? undefined : "var(--pg-status-danger-bg)")}
            apiDataExtractor={(data) => ((data as { inboundEvents?: InboundEventRow[] }).inboundEvents ?? [])}
            apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
            onData={(_rows, nextTotal) => {
                inboundTotal.value = nextTotal;
            }}
            setRefreshHook={(hook) => {
                inboundHook.value = hook as TableHook;
            }}
            clearRefreshHook={() => {
                inboundHook.value = null;
            }}
            onRefresh={(table, refresh) => {
                void refresh({
                    queryParams: {
                        page: table.page,
                        pageSize: inboundPageSize.value,
                        ...(inboundSearch.value ? { search: inboundSearch.value } : {}),
                        ...buildFilterQuery(inboundEventFilters, inboundFilters.value),
                        ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                    },
                });
            }}
            TopSlot={() => (
                <TableFilters
                    filters={inboundEventFilters}
                    values={inboundFilters.value}
                    total={inboundTotal.value}
                    onChange={onInboundFilter}
                    onClear={() => {
                        inboundFilters.value = {};
                        inboundHook.value?.reset();
                    }}
                />
            )}
        />
    );

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Transactions")} subtitle={t("Every payment attempt and provider callback across all merchants.")} badge={t("Operations")} badgeTone="info">(
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>
                            {t("Refresh")}
                        </VBtn>
                    )</PageHeader>
                <SegmentedTabs
                    modelValue={tab.value}
                    onUpdate:modelValue={(value: string) => (tab.value = value as TabKey)}
                    ariaLabel={t("Transaction views")}
                    tabs={[
                        { value: "attempts", label: t("Payment attempts") },
                        { value: "inbound", label: t("Inbound webhooks") },
                    ]}
                />
                {tab.value === "attempts" ? attemptsView() : inboundView()}
            </ThemedView>

            <MerchantTransactionDialog
                open={attemptId.value !== null}
                attemptId={attemptId.value}
                onUpdate={(open: boolean) => {
                    if (!open) closeAttempt();
                }}
                onChanged={refreshAll}
            />
            <FormModal
                modelValue={inquiryRowTarget.value !== null}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) inquiryRowTarget.value = null;
                }}
                title={t("Schedule gateway inquiry")}
                size="md"
                loading={inquirySubmitting.value}
                submitLabel={t("Schedule inquiry")}
                onSubmit={() => void inquireRow()}
            >
                <FormChecklist
                    checks={[...INQUIRY_CHECKS]}
                    modelValue={inquiryChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (inquiryChecklist.value = value)}
                    show={showChecklists}
                    title={t("Inquiry checklist")}
                    complete={inquiryChecklistComplete.value}
                    incompleteMessage={t("Complete all inquiry checklist items before continuing")}
                />
            </FormModal>
            <InboundEventDrawer
                eventId={inboundEventId.value}
                onClose={() => (inboundEventId.value = null)}
                onOpenAttempt={(id: string) => {
                    inboundEventId.value = null;
                    attemptId.value = id;
                }}
            />
            {journalEntryId.value && <JournalEntryDrawer entryId={journalEntryId.value} onClose={() => (journalEntryId.value = null)} />}
        </ScreenContainer>
    );
});

export default TransactionsPage;
