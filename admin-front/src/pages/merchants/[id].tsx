import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VDialog,
    VTab,
    VTabs,
    VTextField,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import FieldsSections from "@/components/FieldsSections";
import CollapsibleSection, { type SectionCommand } from "@/components/CollapsibleSection";
import type { FieldProps } from "@/components/Field";
import { ApiTable } from "@/components/Table/ApiTable";
import type { TableHeader } from "@/components/Table/types";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {
    COLUMN_HELP,
    formatDateTime,
    formatMoney,
    kybStatusHelp,
    merchantStatusHelp,
    riskHelp,
} from "./merchantHelp";
import type {
    MerchantAdjustment,
    MerchantApplicationRow,
    MerchantAuditEvent,
    MerchantCashout,
    MerchantDetail,
    MerchantDetailChange,
    MerchantDispute,
    MerchantNotification,
    MerchantPendingChange,
    MerchantStats,
    MerchantSummary,
    MerchantTransaction,
    MerchantWalletRow,
} from "./types";
import MerchantHelpPanel from "./components/MerchantHelpPanel";
import MerchantActionDialog, { type MerchantActionMode } from "./components/MerchantActionDialog";
import MerchantEditDialog, { type MerchantEditMode } from "./components/MerchantEditDialog";
import MerchantResourceTable from "./components/MerchantResourceTable";
import MerchantTransactionDialog from "./components/MerchantTransactionDialog";
import {
    adjustmentFilters,
    applicationFilters,
    auditFilters,
    cashoutFilters,
    disputeFilters,
    notificationFilters,
    transactionFilters,
    walletFilters,
} from "./merchantTableFilters";

const parse = (payload: unknown): MerchantDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.merchant ?? source) as MerchantDetail;
};

const field = (text: string, value: unknown, hint?: string, source?: string, copy = false): FieldProps => ({
    text,
    value: value === null || value === undefined ? "" : String(value),
    hint,
    source,
    copyOnClick: copy,
});

const jsonText = (value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

type MerchantDetailTab = "all" | "details" | "transactions" | "wallets" | "applications" | "finance" | "compliance" | "access";

const MerchantDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const merchant = ref<MerchantDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const actionOpen = ref(false);
    const actionMode = ref<MerchantActionMode>("SUSPEND");
    const editOpen = ref(false);
    const editMode = ref<MerchantEditMode>("DESCRIPTIVE");
    const withdrawOpen = ref(false);
    const withdrawTarget = ref<MerchantPendingChange | null>(null);
    const withdrawReason = ref("");
    const historyOpen = ref(false);
    const historyRefreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    const historyPageSize = ref(25);
    const stats = ref<MerchantStats | null>(null);
    const transactionOpen = ref(false);
    const selectedTransaction = ref<MerchantTransaction | null>(null);
    const transactionRefresh = ref<(() => void) | null>(null);
    const summaryExportLoading = ref(false);
    const sectionCommand = ref<SectionCommand | null>(null);
    const sectionCommandSeq = ref(0);
    const activeTab = ref<MerchantDetailTab>("all");

    const merchantId = computed(() => String(route.params.id ?? ""));
    const currentUserId = computed(() => user.value?.userInfo?.id ?? null);
    const isSupport = computed(() => user.value?.userInfo.role === "SUPPORT");
    const canWrite = computed(() => !isSupport.value && hasOneOfAuthorities(["merchant:write"]));
    const canFinancial = computed(() => !isSupport.value && hasOneOfAuthorities(["merchant:write", "finance:read", "finance:write"]));
    const canAml = computed(() => !isSupport.value && hasOneOfAuthorities(["aml.read_confidential", "aml.review", "aml:read", "compliance:read"]));
    const canInquire = computed(() => hasOneOfAuthorities(["attempt:inquire"]));
    const statusHelp = computed(() => merchantStatusHelp(merchant.value?.status ?? ""));
    const balance = computed(() => merchant.value?.walletBalance?.balance ?? null);
    const currency = computed(() => merchant.value?.walletBalance?.wallets?.[0]?.currency ?? "LYD");

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.merchantSummaryExport(merchantId.value));
            const payload = (response.data?.data ?? response.data ?? {}) as Record<string, any>;
            const merchant = (payload.merchant ?? {}) as Record<string, any>;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["id", merchant.id],
                ["display_name", merchant.displayName ?? merchant.tradeName ?? ""],
                ["legal_name", merchant.legalName ?? ""],
                ["status", merchant.status ?? ""],
                ["kyb_status", merchant.kybStatus ?? ""],
                ["risk_tier", merchant.riskTier ?? ""],
                ["country", merchant.country ?? ""],
                ["version", merchant.version ?? ""],
                ["wallet_count", merchant.walletCount ?? 0],
                ["application_count", merchant.applicationCount ?? 0],
                ["user_count", merchant.userCount ?? 0],
                ["join_request_count", merchant.joinRequestCount ?? 0],
                ["kyb_document_count", merchant.kybDocumentCount ?? 0],
                ["pending_approvals", merchant.pendingApprovalCount ?? 0],
                ["wallet_balance", payload.walletBalance?.balance ?? ""],
                ["open_disputes", payload.openDisputes ?? 0],
                ["pending_cashouts", payload.pendingCashouts ?? 0],
                ["open_aml_cases", payload.openAmlCases ?? 0],
                ["generated_at", payload.generatedAt ?? ""],
            ];
            for (const metric of payload.metrics ?? []) {
                rows.push([`attempts.${metric.status}.count`, metric.count]);
                rows.push([`attempts.${metric.status}.charged_amount`, metric.chargedAmount]);
            }
            for (const [field, value] of Object.entries(merchant)) {
                if (["id", "displayName", "tradeName", "legalName", "status", "kybStatus", "riskTier", "country", "version", "walletCount", "applicationCount", "userCount", "joinRequestCount", "kybDocumentCount", "pendingApprovalCount"].includes(field)) continue;
                if (["joinRequests", "wallets", "applications", "users", "accessTokens", "credentialSets", "pendingChanges", "fieldHistory", "beneficialOwners", "kybDocuments", "amlCases", "revalidations", "metrics", "walletBalance"].includes(field)) continue;
                if (value !== null && typeof value === "object") continue;
                rows.push([`merchant.${field}`, value]);
            }
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `merchant-360-${merchantId.value}-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Merchant 360 summary exported") });
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.merchantDetail(merchantId.value));
            merchant.value = parse(response.data?.data ?? response.data ?? {});
            if (canFinancial.value) {
                try {
                    const statsResponse = await api.get(urlsMap.merchantStats(merchantId.value), { params: { period: "30d" } });
                    const raw = statsResponse.data?.data ?? statsResponse.data ?? {};
                    stats.value = (raw.stats ?? raw) as MerchantStats;
                } catch {
                    stats.value = null;
                }
            } else {
                stats.value = null;
            }
        } catch (cause) {
            error.value = extractApiErrorMessage(cause);
            merchant.value = null;
            stats.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch(merchantId, () => void load());
    void load();

    const openAction = (mode: MerchantActionMode) => {
        actionMode.value = mode;
        actionOpen.value = true;
    };

    const openTransaction = (transaction: MerchantTransaction) => {
        selectedTransaction.value = transaction;
        transactionOpen.value = true;
    };

    const inquireTransaction = async (transaction: MerchantTransaction) => {
        try {
            await api.post(urlsMap.attemptInquire(transaction.id), {});
            showSnackBar({ type: "success", message: t("Attempt inquiry scheduled") });
            transactionOpen.value = false;
            transactionRefresh.value?.();
            await load();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        }
    };

    const setAllSections = (open: boolean) => {
        sectionCommandSeq.value += 1;
        sectionCommand.value = { id: sectionCommandSeq.value, open };
    };

    const openEdit = (mode: MerchantEditMode) => {
        editMode.value = mode;
        editOpen.value = true;
    };

    const openWithdraw = (change: MerchantPendingChange) => {
        withdrawTarget.value = change;
        withdrawReason.value = "";
        withdrawOpen.value = true;
    };

    const withdraw = async () => {
        if (!withdrawTarget.value) return;
        try {
            await api.post(urlsMap.merchantWithdrawChange(merchantId.value, withdrawTarget.value.id), {
                reason: withdrawReason.value.trim() || undefined,
            });
            withdrawOpen.value = false;
            showSnackBar({ type: "success", message: t("Pending change withdrawn") });
            await load();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        }
    };

    const sections = computed(() => {
        const entry = merchant.value;
        if (!entry) return [];
        const status = merchantStatusHelp(entry.status);
        const sensitiveVisible = !entry.redactedFields.includes("taxId");
        const financialVisible = !entry.redactedFields.includes("payoutBankDetailsJson");
        const kyb = entry.kybStatus ? kybStatusHelp(entry.kybStatus) : null;
        const risk = entry.riskTier ? riskHelp(entry.riskTier) : null;
        return [
            {
                title: t("Identity and lifecycle"),
                description: t("Core merchant identity, lifecycle and support contacts. Sensitive fields are shown only when your role may see them."),
                defaultExpanded: true,
                fields: [
                    field("Display name", entry.displayName, "Customer-facing display name.", "merchants.display_name"),
                    field("Trade name", entry.tradeName, "Customer-facing trade name.", "merchants.tradeName"),
                    field("Legal name", entry.legalName, "Registered legal entity name.", "merchants.legalName", true),
                    field("Merchant ID", entry.id, "Stable merchant database identifier.", "merchants.id", true),
                    field("Status", status.label, status.meaning, "merchants.status"),
                    field("Version", entry.version, "Optimistic-concurrency version for pending edits.", "merchants.version"),
                    field("Onboarding channel", entry.onboardingChannel, COLUMN_HELP.channel, "merchants.onboardingChannel"),
                    field("Country", entry.country, COLUMN_HELP.country, "merchants.country"),
                    field("Created", formatDateTime(entry.createdAt), "Merchant record creation time.", "merchants.created_at"),
                    field("Activated", formatDateTime(entry.activatedAt), "Activation time.", "merchants.activatedAt"),
                    field("Suspended", formatDateTime(entry.suspendedAt), "Suspension time.", "merchants.suspendedAt"),
                    field("Suspension reason", entry.suspensionReasonRedacted ? t("Restricted") : entry.suspensionReasonCode, "AML reasons are restricted to compliance.", "merchants.suspensionReasonCode"),
                    field("Closed", formatDateTime(entry.closedAt), "Closure time.", "merchants.closedAt"),
                ],
            },
            {
                title: t("Contacts and descriptive profile"),
                defaultExpanded: false,
                fields: [
                    field("Contact email", entry.contactEmail, "Primary merchant contact email.", "merchants.contactEmail", true),
                    field("Contact phone", entry.contactPhone, "Primary merchant contact phone.", "merchants.contactPhone", true),
                    field("Support email", entry.supportEmail, "Merchant support contact email.", "merchants.supportEmail", true),
                    field("Support phone", entry.supportPhone, "Merchant support contact phone.", "merchants.supportPhone", true),
                    field("Logo URL", entry.logoUrl, "Optional merchant logo URL.", "merchants.logoUrl"),
                ],
            },
            {
                title: t("Commercial and risk profile"),
                defaultExpanded: false,
                fields: [
                    field("Tax ID", sensitiveVisible ? entry.taxId : t("Restricted"), "Tax registration identifier. Sensitive field.", "merchants.taxId", true),
                    field("Registration number", sensitiveVisible ? entry.registrationNo : t("Restricted"), "Commercial registration number. Sensitive field.", "merchants.registrationNo", true),
                    field("Business category", sensitiveVisible ? entry.businessCategory : t("Restricted"), COLUMN_HELP.category, "merchants.businessCategory"),
                    field("Risk tier", sensitiveVisible ? risk?.label ?? "—" : t("Restricted"), risk?.meaning, "merchants.riskTier"),
                    field("KYB status", sensitiveVisible ? kyb?.label ?? "—" : t("Restricted"), kyb?.meaning, "merchants.kybStatus"),
                    field("Next KYB review", sensitiveVisible ? formatDateTime(entry.nextKybReviewAt) : t("Restricted"), COLUMN_HELP.review, "merchants.nextKybReviewAt"),
                    field("Commission receivable ceiling", financialVisible ? formatMoney(entry.commissionReceivableCeiling, currency.value) : t("Restricted"), "Commission receivable ceiling. Sensitive financial field.", "merchants.commissionReceivableCeiling"),
                    field("Negative balance ceiling", financialVisible ? formatMoney(entry.negativeBalanceCeiling, currency.value) : t("Restricted"), "Allowed negative wallet balance ceiling. Sensitive financial field.", "merchants.negativeBalanceCeiling"),
                    field("Payout bank", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).bank ?? "—") : t("Restricted"), "Payout bank name.", "merchants.payoutBankDetailsJson.bank"),
                    field("Payout account", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).iban ?? (entry.payoutBankDetailsJson ?? {}).accountNumber ?? "—") : t("Restricted"), "Payout IBAN/account. Sensitive financial field.", "merchants.payoutBankDetailsJson.iban"),
                    field("Payout holder", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).holder ?? "—") : t("Restricted"), "Payout account holder.", "merchants.payoutBankDetailsJson.holder"),
                ],
            },
        ];
    });


    const healthItems = computed(() => {
        const current = stats.value;
        if (!current) return [];
        const totals = current.totals;
        return [
            { label: "30-day gross volume", value: formatMoney(totals.grossVolume, currency.value), tone: "info" as const },
            { label: "Net credited", value: formatMoney(totals.netCredited, currency.value), tone: "success" as const },
            { label: "Platform commission", value: formatMoney(totals.commission, currency.value), tone: "neutral" as const },
            { label: "Attempts", value: String(totals.attemptCount), tone: "neutral" as const },
            { label: "Success rate", value: `${totals.successRate.toFixed(2)}%`, tone: totals.successRate >= 90 ? "success" as const : totals.successRate >= 70 ? "warning" as const : "error" as const },
            { label: "Average ticket", value: formatMoney(totals.averageTicket, currency.value), tone: "neutral" as const },
            { label: "Open disputes", value: String(current.openDisputes), tone: current.openDisputes > 0 ? "warning" as const : "success" as const },
            { label: "Pending cash-outs", value: `${current.pendingCashouts.count} · ${formatMoney(current.pendingCashouts.amount, currency.value)}`, tone: current.pendingCashouts.count > 0 ? "warning" as const : "success" as const },
            { label: "Pending changes", value: String(current.pendingApprovals), tone: current.pendingApprovals > 0 ? "warning" as const : "success" as const },
            { label: "Unknown outcomes", value: String(totals.unknownCount), tone: totals.unknownCount > 0 ? "error" as const : "success" as const },
        ];
    });

    const transactionHeaders = computed<TableHeader<MerchantTransaction>[]>(() => {
        const headers: TableHeader<MerchantTransaction>[] = [
            {
                key: "reference",
                label: "Reference",
                sortKey: "reference",
                headerTooltip: COLUMN_HELP.transactionReference,
                value: (row) => row.reference,
                Value: ({ row }: { row: MerchantTransaction }) => (
                    <VBtn size="x-small" variant="text" style={{ padding: "0", textTransform: "none", minWidth: "0" }} onClick={() => openTransaction(row)}>
                        <ThemedText style={{ fontSize: "12px", direction: "ltr", fontWeight: 600 }}>{row.reference}</ThemedText>
                    </VBtn>
                ),
            },
            {
                key: "createdAt",
                label: "Created",
                sortKey: "createdAt",
                headerTooltip: COLUMN_HELP.transactionCreated,
                value: (row) => row.createdAt,
                Value: ({ row }: { row: MerchantTransaction }) => <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(row.createdAt)}</ThemedText>,
            },
            {
                key: "status",
                label: "Status",
                sortKey: "status",
                headerTooltip: COLUMN_HELP.transactionStatus,
                value: (row) => row.status,
                Value: ({ row }: { row: MerchantTransaction }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" />,
            },
            {
                key: "application",
                label: "Application",
                headerTooltip: COLUMN_HELP.transactionApplication,
                value: (row) => row.application.name,
            },
            {
                key: "rail",
                label: "Rail / gateway",
                headerTooltip: COLUMN_HELP.transactionRail,
                value: (row) => `${row.rail.code} ${row.gateway.code}`,
                Value: ({ row }: { row: MerchantTransaction }) => (
                    <ThemedView style={{ gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px" }}>{row.rail.code}</ThemedText>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.gateway.name}</ThemedText>
                    </ThemedView>
                ),
            },
        ];
        if (!isSupport.value) {
            headers.push({
                key: "amount",
                label: "Amount",
                sortKey: "totalChargedAmount",
                headerTooltip: COLUMN_HELP.transactionAmount,
                value: (row) => row.totalChargedAmount ?? "",
                Value: ({ row }: { row: MerchantTransaction }) => <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.totalChargedAmount, row.currency)}</ThemedText>,
            });
        }
        if (canFinancial.value) {
            headers.push({
                key: "net",
                label: "Net / fee",
                headerTooltip: COLUMN_HELP.transactionNet,
                value: (row) => row.netMerchantAmount ?? "",
                Value: ({ row }: { row: MerchantTransaction }) => (
                    <ThemedView style={{ gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.netMerchantAmount, row.currency)}</ThemedText>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{t("fee")} {formatMoney(row.gatewayFeeAmount, row.currency)}</ThemedText>
                    </ThemedView>
                ),
            });
        }
        if (!isSupport.value) {
            headers.push({
                key: "providerReference",
                label: "Provider reference",
                headerTooltip: COLUMN_HELP.transactionProvider,
                value: (row) => row.providerReference ?? "",
                Value: ({ row }: { row: MerchantTransaction }) => <ThemedText style={{ fontSize: "11px", direction: "ltr", opacity: row.providerReference ? 1 : 0.55 }}>{row.providerReference || "—"}</ThemedText>,
            });
        }
        headers.push({
            key: "operatorCase",
            label: "Operator case",
            headerTooltip: COLUMN_HELP.transactionCase,
            value: (row) => row.operatorCases[0]?.state ?? "",
            Value: ({ row }: { row: MerchantTransaction }) =>
                row.operatorCases[0]
                    ? <StatusChip label={`${row.operatorCases[0].priority} · ${row.operatorCases[0].state}`} tone={statusTone(row.operatorCases[0].state)} size="x-small" />
                    : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        });
        return headers;
    });

    const applicationHeaders = computed<TableHeader<MerchantApplicationRow>[]>(() => {
        const headers: TableHeader<MerchantApplicationRow>[] = [
            { key: "name", label: "Application", sortKey: "name", headerTooltip: COLUMN_HELP.applicationName, value: (row) => row.name, Value: ({ row }: { row: MerchantApplicationRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.name}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.id}</ThemedText>
                </ThemedView>
            ) },
            { key: "status", label: "Status", sortKey: "status", headerTooltip: COLUMN_HELP.applicationStatus, value: (row) => row.status, Value: ({ row }: { row: MerchantApplicationRow }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" /> },
            { key: "wallet", label: "Wallet", value: (row) => row.assignedWallet.id, Value: ({ row }: { row: MerchantApplicationRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.assignedWallet.currency}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.assignedWallet.id}</ThemedText>
                </ThemedView>
            ) },
            { key: "links", label: "Links / tokens", headerTooltip: COLUMN_HELP.applicationLinks, value: (row) => `${row.paymentLinkCount}/${row.accessTokenCount}`, Value: ({ row }: { row: MerchantApplicationRow }) => <ThemedText style={{ fontSize: "12px" }}>{row.paymentLinkCount} / {row.accessTokenCount}</ThemedText> },
            { key: "pos", label: "POS", value: (row) => String(row.posTerminalCount) },
            { key: "railWhitelist", label: "Rails", headerTooltip: COLUMN_HELP.applicationRails, value: (row) => row.railWhitelistMode, Value: ({ row }: { row: MerchantApplicationRow }) => <StatusChip label={row.railWhitelistMode === "ALL" ? t("All rails") : row.railWhitelistMode === "NONE" ? t("No rails") : `${row.railWhitelistCount} ${t("rails")}`} tone="neutral" size="x-small" /> },
            { key: "domains", label: "Domains", headerTooltip: COLUMN_HELP.applicationDomains, value: (row) => String(row.redirectDomainCount) },
            { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: MerchantApplicationRow }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
        ];
        if (!isSupport.value) {
            headers.splice(3, 0, {
                key: "expectedMonthlyVolume",
                label: "Expected volume",
                sortKey: "expectedMonthlyVolume",
                headerTooltip: COLUMN_HELP.applicationVolume,
                value: (row) => row.expectedMonthlyVolume ?? "",
                Value: ({ row }: { row: MerchantApplicationRow }) => <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.expectedMonthlyVolume, row.assignedWallet.currency)}</ThemedText>,
            });
        }
        return headers;
    });

    const walletHeaders = computed<TableHeader<MerchantWalletRow>[]>(() => {
        const headers: TableHeader<MerchantWalletRow>[] = [
            { key: "id", label: "Wallet", headerTooltip: COLUMN_HELP.walletId, value: (row) => row.id, Value: ({ row }: { row: MerchantWalletRow }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.id}</ThemedText> },
            { key: "currency", label: "Currency", sortKey: "currency", value: (row) => row.currency },
            { key: "status", label: "Status", sortKey: "status", value: (row) => row.status, Value: ({ row }: { row: MerchantWalletRow }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" /> },
        ];
        if (canFinancial.value) {
            headers.push(
                { key: "balance", label: "Ledger balance", headerTooltip: COLUMN_HELP.walletBalance, value: (row) => row.balance ?? "", Value: ({ row }: { row: MerchantWalletRow }) => <ThemedText style={{ fontSize: "12px", fontWeight: Number(row.balance ?? 0) < 0 ? 700 : 500 }}>{formatMoney(row.balance, row.currency)}</ThemedText> },
                { key: "checkpoint", label: "Checkpoint", headerTooltip: COLUMN_HELP.walletCheckpoint, value: (row) => row.checkpointBalance ?? "" },
            );
        }
        headers.push(
            { key: "applications", label: "Apps", value: (row) => String(row.applicationCount) },
            { key: "links", label: "Links", value: (row) => String(row.paymentLinkCount) },
            { key: "cashouts", label: "Cash-outs", headerTooltip: COLUMN_HELP.walletCashouts, value: (row) => `${row.pendingCashoutCount}/${row.cashoutCount}` },
            { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: MerchantWalletRow }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
        );
        return headers;
    });

    const cashoutHeaders: TableHeader<MerchantCashout>[] = [
        { key: "id", label: "Cash-out", value: (row) => row.id, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.id}</ThemedText> },
        { key: "amount", label: "Amount", sortKey: "amount", value: (row) => row.amount, Value: ({ row }) => <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.amount, row.currency)}</ThemedText> },
        { key: "state", label: "State", sortKey: "state", value: (row) => row.state, Value: ({ row }) => <StatusChip label={row.state} tone={statusTone(row.state)} size="x-small" /> },
        { key: "wallet", label: "Wallet", value: (row) => row.wallet.id, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.wallet.id}</ThemedText> },
        { key: "destination", label: "Destination", headerTooltip: COLUMN_HELP.cashoutDestination, value: (row) => JSON.stringify(row.destination), Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{String(row.destination.bank ?? row.destination.bankName ?? "—")} · {String(row.destination.account ?? row.destination.accountNumber ?? row.destination.iban ?? "—")}</ThemedText> },
        { key: "adjustment", label: "Adjustment", value: (row) => row.adjustment?.state ?? "", Value: ({ row }) => row.adjustment ? <StatusChip label={row.adjustment.state} tone={statusTone(row.adjustment.state)} size="x-small" /> : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText> },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const disputeHeaders: TableHeader<MerchantDispute>[] = [
        { key: "externalDisputeRef", label: "Dispute", value: (row) => row.externalDisputeRef, Value: ({ row }) => <ThemedView style={{ gap: "2px" }}><ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.externalDisputeRef}</ThemedText><ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.attempt.reference}</ThemedText></ThemedView> },
        { key: "amount", label: "Amount", sortKey: "amount", value: (row) => row.amount, Value: ({ row }) => <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.amount, row.currency)}</ThemedText> },
        { key: "status", label: "Status", sortKey: "status", value: (row) => row.status, Value: ({ row }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" /> },
        { key: "reason", label: "Reason", headerTooltip: COLUMN_HELP.disputeReason, value: (row) => row.reasonCode ?? "" },
        { key: "rail", label: "Rail / gateway", value: (row) => `${row.rail.code} ${row.gateway.code}` },
        { key: "openedAt", label: "Opened", sortKey: "openedAt", value: (row) => row.openedAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.openedAt)}</ThemedText> },
        { key: "evidenceDueAt", label: "Evidence due", sortKey: "evidenceDueAt", value: (row) => row.evidenceDueAt ?? "", Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.evidenceDueAt)}</ThemedText> },
        { key: "adjustment", label: "Adjustment", value: (row) => row.adjustment?.state ?? "", Value: ({ row }) => row.adjustment ? <StatusChip label={row.adjustment.state} tone={statusTone(row.adjustment.state)} size="x-small" /> : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText> },
    ];

    const adjustmentHeaders: TableHeader<MerchantAdjustment>[] = [
        { key: "id", label: "Adjustment", value: (row) => row.id, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.id}</ThemedText> },
        { key: "type", label: "Type", sortKey: "type", value: (row) => row.type },
        { key: "amount", label: "Amount", sortKey: "amount", value: (row) => row.amount, Value: ({ row }) => <ThemedText style={{ fontSize: "12px" }}>{formatMoney(row.amount, row.currency)}</ThemedText> },
        { key: "state", label: "State", sortKey: "state", value: (row) => row.state, Value: ({ row }) => <StatusChip label={row.state} tone={statusTone(row.state)} size="x-small" /> },
        { key: "attempt", label: "Source attempt", value: (row) => row.sourceAttempt?.reference ?? "", Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.sourceAttempt?.reference ?? "—"}</ThemedText> },
        { key: "dispute", label: "Dispute", value: (row) => row.dispute?.externalDisputeRef ?? "" },
        { key: "reason", label: "Reason", headerTooltip: COLUMN_HELP.adjustmentReason, value: (row) => row.reason },
        { key: "journal", label: "Journal entry", value: (row) => row.journalEntryId ?? "" },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const notificationHeaders: TableHeader<MerchantNotification>[] = [
        { key: "templateCode", label: "Template", sortKey: "templateCode", value: (row) => row.templateCode },
        { key: "channel", label: "Channel", sortKey: "channel", value: (row) => `${row.channel} ${row.lang}`, Value: ({ row }) => <StatusChip label={`${row.channel} · ${row.lang}`} tone="neutral" size="x-small" /> },
        { key: "status", label: "Status", sortKey: "status", value: (row) => row.status, Value: ({ row }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" /> },
        { key: "attempts", label: "Attempts", sortKey: "attempts", value: (row) => String(row.attempts) },
        { key: "addressMasked", label: "Recipient", headerTooltip: COLUMN_HELP.notificationRecipient, value: (row) => row.addressMasked },
        { key: "nextAttemptAt", label: "Next attempt", value: (row) => row.nextAttemptAt ?? "", Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.nextAttemptAt)}</ThemedText> },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const auditHeaders: TableHeader<MerchantAuditEvent>[] = [
        { key: "action", label: "Action", sortKey: "action", value: (row) => row.action },
        { key: "role", label: "Role", sortKey: "role", value: (row) => row.role },
        { key: "actor", label: "Actor", value: (row) => row.actorEmail, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.actorEmail}</ThemedText> },
        { key: "entity", label: "Entity", value: (row) => `${row.entityType} ${row.entityId}`, Value: ({ row }) => <ThemedText style={{ fontSize: "10px", direction: "ltr", opacity: 0.7 }}>{row.entityType} · {row.entityId}</ThemedText> },
        { key: "approval", label: "Approval", value: (row) => row.approvalRequestId ?? "" },
        { key: "change", label: "Change", value: (row) => row.redacted ? "" : `${JSON.stringify(row.before ?? {})} ${JSON.stringify(row.after ?? {})}`, Value: ({ row }) => <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{row.redacted ? t("Restricted") : `${jsonText(row.before).slice(0, 60)} → ${jsonText(row.after).slice(0, 60)}`}</ThemedText> },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const show = (tab: MerchantDetailTab) => activeTab.value === "all" || activeTab.value === tab;

    return () => {
        if (loading.value) {
            return <ScreenContainer><StateView loading onRetry={() => void load()} /></ScreenContainer>;
        }
        if (error.value || !merchant.value) {
            return <ScreenContainer><StateView error={error.value ?? "Merchant not found"} onRetry={() => void load()} /></ScreenContainer>;
        }
        const entry = merchant.value;
        return (
            <ScreenContainer>
                <ThemedView style={{ gap: "18px" }}>
                    <PageHeader
                        title={entry.displayName || entry.tradeName || t("Merchant")}
                        end={() => (
                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "Merchants" })}>{t("Queue")}</VBtn>
                                {activeTab.value === "all" && (
                                    <>
                                        <VBtn variant="text" prependIcon="mdi-unfold-more-horizontal" onClick={() => setAllSections(true)}>{t("Expand all")}</VBtn>
                                        <VBtn variant="text" prependIcon="mdi-unfold-less-horizontal" onClick={() => setAllSections(false)}>{t("Collapse all")}</VBtn>
                                    </>
                                )}
                                <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                                {canWrite.value && (
                                    <>
                                        <VBtn variant="tonal" prependIcon="mdi-pencil-outline" onClick={() => openEdit("DESCRIPTIVE")}>{t("Edit descriptive")}</VBtn>
                                        <VBtn variant="tonal" prependIcon="mdi-file-document-edit-outline" onClick={() => openEdit("SENSITIVE")}>{t("Propose sensitive change")}</VBtn>
                                    </>
                                )}
                                {canWrite.value && entry.status === "ACTIVE" && (
                                    <VBtn color="error" variant="tonal" onClick={() => openAction("SUSPEND")}>{t("Suspend")}</VBtn>
                                )}
                                {canWrite.value && entry.status === "SUSPENDED" && (
                                    <VBtn color="success" variant="tonal" onClick={() => openAction("REINSTATE")}>{t("Reinstate")}</VBtn>
                                )}
                                {canWrite.value && ["ACTIVE", "SUSPENDED"].includes(entry.status) && (
                                    <VBtn color="error" variant="text" onClick={() => openAction("CLOSE")}>{t("Close")}</VBtn>
                                )}
                            </ThemedView>
                        )}
                    />

                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        <span title={statusHelp.value.meaning}><StatusChip label={statusHelp.value.label} tone={statusHelp.value.tone} /></span>
                        {entry.kybStatus && <StatusChip label={kybStatusHelp(entry.kybStatus).label} tone={kybStatusHelp(entry.kybStatus).tone} />}
                        {entry.riskTier && <StatusChip label={riskHelp(entry.riskTier).label} tone={riskHelp(entry.riskTier).tone} />}
                        <StatusChip label={`v${entry.version}`} tone="neutral" size="small" />
                        {entry.pendingApprovalCount > 0 && <StatusChip label={`${entry.pendingApprovalCount} ${t("pending changes")}`} tone="warning" />}
                        {entry.redactedFields.length > 0 && <StatusChip label={t("Some fields restricted")} tone="neutral" size="small" />}
                    </ThemedView>

                    {entry.redactedFields.length > 0 && (
                        <VAlert type="info" variant="tonal">
                            {t("Sensitive tax, registration, payout, ceiling, risk or AML information is hidden for your role.")}
                        </VAlert>
                    )}
                    {entry.status === "SUSPENDED" && (
                        <VAlert type="warning" variant="tonal">
                            {t("Suspended merchants cannot start new live payments. Reinstatement requires a compliance or MLRO checker.")}
                        </VAlert>
                    )}

                    <VCard variant="flat" style={{ borderRadius: "14px", overflow: "hidden" }}>
                        <VTabs v-model={activeTab.value} color="primary" density="comfortable" showArrows>
                            <VTab value="all" prependIcon="mdi-view-dashboard-outline">{t("All")}</VTab>
                            <VTab value="details" prependIcon="mdi-account-details-outline">{t("Details")}</VTab>
                            <VTab value="transactions" prependIcon="mdi-swap-horizontal">{t("Transactions")}</VTab>
                            {canFinancial.value && <VTab value="wallets" prependIcon="mdi-wallet-outline">{t("Wallets")}</VTab>}
                            <VTab value="applications" prependIcon="mdi-apps">{t("Applications")}</VTab>
                            {canFinancial.value && <VTab value="finance" prependIcon="mdi-bank-outline">{t("Finance")}</VTab>}
                            {!isSupport.value && <VTab value="compliance" prependIcon="mdi-shield-check-outline">{t("Compliance")}</VTab>}
                            <VTab value="access" prependIcon="mdi-account-key-outline">{t("Access & activity")}</VTab>
                        </VTabs>
                    </VCard>

                    {activeTab.value === "all" && <VCard><VCardText><MerchantHelpPanel /></VCardText></VCard>}

                    {show("details") && (
                        <FieldsSections
                            sections={sections.value}
                            collapsible={activeTab.value === "all"}
                            storageKeyPrefix={`merchant:${merchantId.value}:fields`}
                            defaultExpanded={activeTab.value === "all" ? false : true}
                            command={sectionCommand.value}
                        />
                    )}

                    {show("transactions") && (
                        <>
                    <CollapsibleSection
                        command={sectionCommand.value}
                        alwaysOpen={activeTab.value !== "all"}
                        title={t("Merchant health summary")}
                        subtitle={t("Volume, quality, cash and risk indicators for the last 30 days. Amounts are derived from attempts and posted ledger lines.")}
                        defaultOpen={true}
                        storageKey={`merchant:${merchantId.value}:health`}
                    >
                        {healthItems.value.length === 0 ? (
                            <VAlert type="info" variant="tonal">{t("Health statistics are available to financial roles and could not be loaded.")}</VAlert>
                        ) : (
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                                {healthItems.value.map((item) => (
                                    <VCard key={item.label} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "5px", padding: "14px" }}>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{t(item.label)}</ThemedText>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </ThemedView>
                        )}
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                            <StatusChip label={`${t("Ledger balance")}: ${formatMoney(stats.value?.walletBalance.balance ?? balance.value, currency.value)}`} tone={Number(stats.value?.walletBalance.balance ?? balance.value ?? 0) < 0 ? "error" : "success"} />
                            <StatusChip label={`${t("Negative ceiling")}: ${formatMoney(stats.value?.negativeBalanceCeiling ?? entry.negativeBalanceCeiling, currency.value)}`} tone="neutral" />
                            <StatusChip label={`${t("Next KYB review")}: ${formatDateTime(stats.value?.nextKybReviewAt ?? entry.nextKybReviewAt)}`} tone="neutral" />
                        </ThemedView>
                    </CollapsibleSection>

                    <CollapsibleSection
                        command={sectionCommand.value}
                        alwaysOpen={activeTab.value !== "all"}
                        title={t("Recent transactions")}
                        subtitle={t("Payment attempts for this merchant. Open a reference for the full masked transaction context; inquiries are limited to eligible UNKNOWN or VERIFYING attempts.")}
                        defaultOpen={true}
                        storageKey={`merchant:${merchantId.value}:transactions`}
                        count={stats.value?.totals.attemptCount}
                        tone="info"
                    >
                        <MerchantResourceTable<MerchantTransaction>
                            title={t("Transactions")}
                            url={urlsMap.merchantTransactions(merchantId.value)}
                            listKey="transactions"
                            headers={transactionHeaders.value}
                            filters={transactionFilters(entry.applications ?? [])}
                            pageSize={10}
                            noElevation={true}
                            onRefreshReady={(refresh) => (transactionRefresh.value = refresh)}
                        />
                    </CollapsibleSection>
                        </>
                    )}

                    {show("wallets") && canFinancial.value && (
                        <CollapsibleSection
                            command={sectionCommand.value}
                            alwaysOpen={activeTab.value !== "all"}
                            title={t("Wallets and balances")}
                            subtitle={t("Wallet balances are derived from posted journal lines and checkpoint balances. Pending cash-outs are shown per wallet.")}
                            defaultOpen={true}
                            storageKey={`merchant:${merchantId.value}:wallets`}
                        >
                            <MerchantResourceTable<MerchantWalletRow>
                                title={t("Wallets")}
                                url={urlsMap.merchantWallets(merchantId.value)}
                                listKey="wallets"
                                headers={walletHeaders.value}
                                filters={walletFilters()}
                                pageSize={10}
                                noElevation={true}
                            />
                        </CollapsibleSection>
                    )}

                    {show("applications") && (
                        <CollapsibleSection
                            command={sectionCommand.value}
                            alwaysOpen={activeTab.value !== "all"}
                            title={t("Applications")}
                            subtitle={t("Applications, assigned wallets, link/token/POS counts, rail whitelists and redirect domains.")}
                            defaultOpen={false}
                            storageKey={`merchant:${merchantId.value}:applications`}
                            count={entry.applicationCount}
                        >
                            <MerchantResourceTable<MerchantApplicationRow>
                                title={t("Applications")}
                                url={urlsMap.merchantApplications(merchantId.value)}
                                listKey="applications"
                                headers={applicationHeaders.value}
                                filters={applicationFilters(entry.wallets ?? [])}
                                pageSize={10}
                                noElevation={true}
                            />
                        </CollapsibleSection>
                    )}

                    {show("finance") && canFinancial.value && (
                        <>
                            <CollapsibleSection
                                command={sectionCommand.value}
                                alwaysOpen={activeTab.value !== "all"}
                                title={t("Cash-outs")}
                                subtitle={t("Cash-out requests and their adjustment state. This page is read-only; money movement remains in the finance queue.")}
                                defaultOpen={false}
                                storageKey={`merchant:${merchantId.value}:cashouts`}
                            >
                                <MerchantResourceTable<MerchantCashout>
                                    title={t("Cash-outs")}
                                    url={urlsMap.merchantCashouts(merchantId.value)}
                                    listKey="cashouts"
                                    headers={cashoutHeaders}
                                    filters={cashoutFilters(entry.wallets ?? [])}
                                    pageSize={10}
                                    noElevation={true}
                                />
                            </CollapsibleSection>

                            <CollapsibleSection
                                command={sectionCommand.value}
                                alwaysOpen={activeTab.value !== "all"}
                                title={t("Disputes")}
                                subtitle={t("Disputes linked to this merchant's payment attempts, including evidence due dates and adjustment state.")}
                                defaultOpen={false}
                                storageKey={`merchant:${merchantId.value}:disputes`}
                            >
                                <MerchantResourceTable<MerchantDispute>
                                    title={t("Disputes")}
                                    url={urlsMap.merchantDisputes(merchantId.value)}
                                    listKey="disputes"
                                    headers={disputeHeaders}
                                    filters={disputeFilters()}
                                    pageSize={10}
                                    noElevation={true}
                                />
                            </CollapsibleSection>

                            <CollapsibleSection
                                command={sectionCommand.value}
                                alwaysOpen={activeTab.value !== "all"}
                                title={t("Adjustments")}
                                subtitle={t("Refunds, chargebacks, manual credits and debits linked to the merchant wallet or its attempts.")}
                                defaultOpen={false}
                                storageKey={`merchant:${merchantId.value}:adjustments`}
                            >
                                <MerchantResourceTable<MerchantAdjustment>
                                    title={t("Adjustments")}
                                    url={urlsMap.merchantAdjustments(merchantId.value)}
                                    listKey="adjustments"
                                    headers={adjustmentHeaders}
                                    filters={adjustmentFilters()}
                                    pageSize={10}
                                    noElevation={true}
                                />
                            </CollapsibleSection>
                        </>
                    )}

                    {show("details") && entry.pendingChanges && entry.pendingChanges.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Pending changes")}</ThemedText>
                                {entry.pendingChanges.map((change) => (
                                    <VCard key={change.id} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusChip label={change.state} tone={statusTone(change.state)} size="x-small" />
                                                <ThemedText style={{ fontSize: "12px" }}>{change.maker?.email ?? change.makerUserId}</ThemedText>
                                                {change.baseVersion && <StatusChip label={`base v${change.baseVersion}`} tone="neutral" size="x-small" />}
                                            </ThemedView>
                                            {change.makerReason && <ThemedText style={{ fontSize: "12px" }}>{change.makerReason}</ThemedText>}
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(change.createdAt)} · {change.mode}</ThemedText>
                                            {change.makerUserId === currentUserId.value && ["DRAFT", "PENDING_REVIEW"].includes(change.state) && (
                                                <VBtn size="x-small" variant="text" color="error" onClick={() => openWithdraw(change)}>{t("Withdraw")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {show("compliance") && entry.amlCases && entry.amlCases.length > 0 && canAml.value && (
                        <VCard variant="tonal" color="error">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("AML cases")}</ThemedText>
                                {entry.amlCases.map((amlCase) => (
                                    <ThemedView key={amlCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={amlCase.status} tone={statusTone(amlCase.status)} size="x-small" />
                                        <StatusChip label={amlCase.severity} tone={statusTone(amlCase.severity)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px" }}>{amlCase.triggerReason}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(amlCase.createdAt)}</ThemedText>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {show("compliance") && entry.joinRequests && entry.joinRequests.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Join requests")}</ThemedText>
                                    <VBtn size="small" variant="text" onClick={() => void router.push({ name: "JoinRequests" })}>{t("Open queue")}</VBtn>
                                </ThemedView>
                                {(entry.joinRequests ?? []).map((row) => (
                                    <ThemedView key={row.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={row.status} tone={statusTone(row.status)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>{row.id}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(row.createdAt)}</ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "JoinRequestDetail", params: { id: row.id } })}>
                                            {t("Open")}
                                        </VBtn>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {show("compliance") && entry.kybDocuments && entry.kybDocuments.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("KYB evidence")}</ThemedText>
                                    <VBtn size="small" variant="text" onClick={() => void router.push({ name: "KybReview" })}>{t("Open KYB review")}</VBtn>
                                </ThemedView>
                                {entry.kybDocuments.map((document) => (
                                    <ThemedView key={document.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={document.status} tone={statusTone(document.status)} size="x-small" />
                                        <StatusChip label={document.avStatus} tone={statusTone(document.avStatus)} size="x-small" />
                                        <ThemedText style={{ fontSize: "12px" }}>{document.docType} · {document.originalFileName || document.id}</ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "KybReviewDetail", params: { id: document.id } })}>{t("Open")}</VBtn>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {show("compliance") && entry.beneficialOwners && entry.beneficialOwners.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Beneficial owners")}</ThemedText>
                                {entry.beneficialOwners.map((owner) => (
                                    <ThemedView key={owner.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={owner.screeningStatus} tone={statusTone(owner.screeningStatus)} size="x-small" />
                                        {owner.pepDeclared && <StatusChip label="PEP" tone="error" size="x-small" />}
                                        <ThemedText style={{ fontSize: "12px" }}>{owner.fullNameEn || owner.fullNameAr} · {owner.role} · {owner.ownershipPercent ?? "—"}%</ThemedText>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {show("access") && entry.users && entry.users.length > 0 && canWrite.value && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Merchant users and access")}</ThemedText>
                                {entry.users.map((merchantUser) => (
                                    <ThemedText key={merchantUser.id} style={{ fontSize: "12px" }}>
                                        {merchantUser.email} · {merchantUser.role} · {merchantUser.status} · MFA {merchantUser.mfaRequired ? "on" : "off"}
                                    </ThemedText>
                                ))}
                                {entry.accessTokens?.map((token) => (
                                    <ThemedText key={token.id} style={{ fontSize: "12px" }}>
                                        {t("Token")} {token.name} · ****{token.lastFour} · {token.revokedAt ? t("Revoked") : t("Active")} · {t("last used")} {formatDateTime(token.lastUsedAt)}
                                    </ThemedText>
                                ))}
                                {entry.credentialSets?.map((credential) => (
                                    <ThemedText key={credential.id} style={{ fontSize: "12px" }}>
                                        {t("Credential set")} {credential.id} · {credential.env} · {credential.status}
                                    </ThemedText>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {show("access") && (
                    <>
                    <CollapsibleSection
                        command={sectionCommand.value}
                        alwaysOpen={activeTab.value !== "all"}
                        title={t("Notifications")}
                        subtitle={t("Notification delivery status for this merchant. Recipient addresses are masked and message payloads are never shown.")}
                        defaultOpen={false}
                        storageKey={`merchant:${merchantId.value}:notifications`}
                    >
                        <MerchantResourceTable<MerchantNotification>
                            title={t("Notifications")}
                            url={urlsMap.merchantNotifications(merchantId.value)}
                            listKey="notifications"
                            headers={notificationHeaders}
                            filters={notificationFilters()}
                            pageSize={10}
                            noElevation={true}
                        />
                    </CollapsibleSection>

                    <CollapsibleSection
                        command={sectionCommand.value}
                        alwaysOpen={activeTab.value !== "all"}
                        title={t("Merchant audit trail")}
                        subtitle={t("Lifecycle and governance events recorded against this merchant. Support sees the event and actor context without raw before/after values.")}
                        defaultOpen={false}
                        storageKey={`merchant:${merchantId.value}:audit`}
                    >
                        <MerchantResourceTable<MerchantAuditEvent>
                            title={t("Audit events")}
                            url={urlsMap.merchantAuditEvents(merchantId.value)}
                            listKey="auditEvents"
                            headers={auditHeaders}
                            filters={auditFilters()}
                            pageSize={10}
                            noElevation={true}
                        />
                    </CollapsibleSection>
                    </>
                    )}

                    {show("access") && (
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Field history")}</ThemedText>
                                <VBtn size="small" variant="text" onClick={() => (historyOpen.value = true)}>{t("View all")}</VBtn>
                            </ThemedView>
                            {entry.fieldHistory.length === 0 && <ThemedText style={{ opacity: 0.6 }}>{t("No field changes recorded")}</ThemedText>}
                            {entry.fieldHistory.slice(0, 8).map((change) => (
                                <ThemedView key={change.id} style={{ gap: "2px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "6px" }}>
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusChip label={change.fieldName} tone={change.redacted ? "neutral" : "info"} size="x-small" />
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{change.actorEmail || change.actorId} · {formatDateTime(change.createdAt)} · {change.source}</ThemedText>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.8 }}>
                                        {change.redacted ? t("Value restricted") : `${change.oldValue ?? "—"} → ${change.newValue ?? "—"}`}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </VCardText>
                    </VCard>
                    )}
                </ThemedView>

                <MerchantActionDialog
                    open={actionOpen.value}
                    mode={actionMode.value}
                    merchant={merchant.value}
                    onUpdate={(value) => (actionOpen.value = value)}
                    onDone={() => void load()}
                />
                <MerchantEditDialog
                    open={editOpen.value}
                    mode={editMode.value}
                    merchant={merchant.value}
                    onUpdate={(value) => (editOpen.value = value)}
                    onDone={() => void load()}
                />
                <MerchantTransactionDialog
                    open={transactionOpen.value}
                    transaction={selectedTransaction.value}
                    canInquire={canInquire.value}
                    onUpdate={(value) => (transactionOpen.value = value)}
                    onInquire={(transaction) => void inquireTransaction(transaction)}
                    onOpenCase={(caseId) => {
                        transactionOpen.value = false;
                        void router.push({ name: "OperatorCaseDetail", params: { id: caseId } });
                    }}
                />
                <VDialog modelValue={withdrawOpen.value} onUpdate:modelValue={(value: boolean) => (withdrawOpen.value = value)} maxWidth="560px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Withdraw pending change")}</ThemedText>
                            <ThemedText style={{ fontSize: "13px" }}>{withdrawTarget.value?.id}</ThemedText>
                            <VTextarea v-model={withdrawReason.value} label={t("Withdrawal reason (optional)")} rows={3} autoGrow />
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (withdrawOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="error" onClick={() => void withdraw()}>{t("Withdraw")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>
                <VDialog modelValue={historyOpen.value} onUpdate:modelValue={(value: boolean) => (historyOpen.value = value)} maxWidth="1100px" scrollable>
                    <VCard>
                        <VCardText>
                            <ApiTable<MerchantDetailChange>
                                title={t("Field history")}
                                url={urlsMap.merchantDetailChanges(merchantId.value)}
                                localSearch={false}
                                xlsx={false}
                                showNumber={true}
                                numberOfItemsPerPage={historyPageSize.value}
                                setNumberOfItemsPerPage={(value) => (historyPageSize.value = value)}
                                headers={[
                                    { key: "fieldName", label: "Field", value: (row) => row.fieldName },
                                    { key: "oldValue", label: "Old value", value: (row) => row.oldValue ?? "" },
                                    { key: "newValue", label: "New value", value: (row) => row.newValue ?? "" },
                                    { key: "actor", label: "Actor", value: (row) => row.actorEmail ?? row.actorId },
                                    { key: "source", label: "Source", value: (row) => row.source },
                                    { key: "createdAt", label: "When", value: (row) => row.createdAt },
                                ]}
                                apiDataExtractor={(data) => {
                                    const payload = data as { detailChanges?: MerchantDetailChange[]; rows?: MerchantDetailChange[] };
                                    return payload.detailChanges ?? payload.rows ?? [];
                                }}
                                apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                                setRefreshHook={(hook) => { historyRefreshHook.value = hook as typeof historyRefreshHook.value; }}
                                clearRefreshHook={() => { historyRefreshHook.value = null; }}
                                onRefresh={(props, refresh) => {
                                    void refresh({
                                        queryParams: {
                                            page: props.page,
                                            pageSize: historyPageSize.value,
                                            ...(props.sortKey ? { sortKey: props.sortKey, sortDirection: props.sortDirection } : {}),
                                        },
                                    });
                                }}
                            />
                        </VCardText>
                    </VCard>
                </VDialog>
            </ScreenContainer>
        );
    };
});

export default MerchantDetailPage;
