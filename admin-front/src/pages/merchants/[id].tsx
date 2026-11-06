import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import CollapsibleSection, { type SectionCommand } from "@/components/CollapsibleSection";
import { ApiTable } from "@/components/Table/ApiTable";
import type { TableHeader } from "@/components/Table/types";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { areHelpPanelsVisible } from "@/constants/env";
import { xlsxUIPipeline } from "@/utils/xlsx";
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

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { JsonDiffViewer } from "@/components/ui/JsonDiffViewer";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { JournalEntryDrawer } from "@/components/ledger/JournalEntryDrawer";
import { walletActionsFor, type WalletAction } from "@/pages/wallets/walletActions";
import { WalletDetailDrawer } from "./components/WalletDetailDrawer";
import { ApplicationDetailDrawer } from "./components/ApplicationDetailDrawer";
import ReasonModal from "./components/ReasonModal";
import BeneficialOwnersCard from "./components/BeneficialOwnersCard";
import MerchantAccessCard from "./components/MerchantAccessCard";
import RevalidationModal from "./components/RevalidationModal";
import { AuditChangeChips } from "@/components/AuditChangeChips";
import { summarizeAuditChange } from "@/utils/auditSummary";
import { ApprovalSubmittedNotice, MiniTable, MoneyOrRestricted, PillList, RestrictedValue } from "./components/commerceBits";
import { isRestricted } from "./commerceGovernance";
import { notifyOutcome, reportCommerceError, runGoverned } from "./governedRequest";
import { railWhitelistModeOf } from "@/pages/applications/applicationActions";
import { KYB_DOC_TYPE_LABELS, type KybDocType } from "./revalidation";

const parse = (payload: unknown): MerchantDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    const merchant = ((source.merchant ?? source) ?? {}) as Record<string, any>;
    const arrays = [
        "redactedFields",
        "fieldHistory",
        "pendingChanges",
        "amlCases",
        "joinRequests",
        "kybDocuments",
        "beneficialOwners",
        "users",
        "wallets",
        "applications",
        "accessTokens",
        "credentialSets",
        "revalidations",
        "metrics",
    ];
    for (const key of arrays) {
        if (!Array.isArray(merchant[key])) merchant[key] = [];
    }
    return merchant as MerchantDetail;
};

const detailItem = (label: string, value: unknown, _hint?: string, _source?: string, mono = false): DescriptionItem => ({
    label,
    value:
        value === null || value === undefined || value === ""
            ? "—"
            : mono
              ? <MonoRef value={String(value)} />
              : String(value),
});

const readQueryString = (value: unknown): string | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    return text.length > 0 ? text : null;
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
    const activeTab = ref<MerchantDetailTab>(readQueryString(route.query.tab) === "transactions" ? "transactions" : "all");
    const reference = computed(() => readQueryString(route.query.reference));
    const openWalletId = ref<string | null>(null);
    const openApplicationId = ref<string | null>(null);
    const openEntryId = ref<string | null>(null);
    const revalidationOpen = ref(false);
    const walletTarget = ref<{ wallet: MerchantWalletRow; action: WalletAction } | null>(null);
    const walletSubmitting = ref(false);
    const walletModalError = ref("");
    const walletNotice = ref<{ approvalRequestId: string | null } | null>(null);
    const walletRefresh = ref<(() => void) | null>(null);
    const applicationRefresh = ref<(() => void) | null>(null);

    watch(
        () => readQueryString(route.query.tab),
        (tab) => {
            if (tab === "transactions") activeTab.value = "transactions";
        },
    );

    const merchantId = computed(() => String(route.params.id ?? ""));
    const currentUserId = computed(() => user.value?.userInfo?.id ?? null);
    const isSupport = computed(() => user.value?.userInfo.role === "SUPPORT");
    const canWrite = computed(() => !isSupport.value && hasOneOfAuthorities(["merchant:write"]));
    const canFinancial = computed(() => !isSupport.value && hasOneOfAuthorities(["merchant:write", "finance:read", "finance:write"]));
    const canAml = computed(() => !isSupport.value && hasOneOfAuthorities(["aml.read_confidential", "aml.review", "aml:read", "compliance:read"]));
    const canInquire = computed(() => hasOneOfAuthorities(["attempt:inquire"]));
    const canKyb = computed(() => hasOneOfAuthorities(["kyb:write", "merchant:write"]));
    const canWriteCommerce = computed(() => hasOneOfAuthorities(["merchant:write"]));
    const statusHelp = computed(() => merchantStatusHelp(merchant.value?.status ?? ""));
    const balance = computed(() => merchant.value?.walletBalance?.balance ?? null);
    const currency = computed(() => merchant.value?.walletBalance?.wallets?.[0]?.currency ?? "LYD");
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;

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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `merchant-360-${merchantId.value}-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Merchant 360 summary exported") });
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const load = async (silent = false) => {
        if (!silent) loading.value = true;
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
            if (silent && merchant.value) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
            } else {
                error.value = extractApiErrorMessage(cause);
                merchant.value = null;
                stats.value = null;
            }
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

    const reloadSilently = () => void load(true);

    const entryLink = (id: string | null | undefined, restricted = false) => {
        if (restricted) return <RestrictedValue />;
        if (!id) return <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>;
        return (
            <VBtn
                size="x-small"
                variant="text"
                style={{ textTransform: "none", paddingInline: "4px", minWidth: "0" }}
                aria-label={t("Open journal entry")}
                onClick={() => {
                    openEntryId.value = id;
                }}
            >
                <span dir="ltr" style={{ fontFamily: "var(--pg-font-mono)", fontSize: "11.5px" }}>{id.slice(0, 8)}</span>
            </VBtn>
        );
    };

    const submitWalletAction = async (reason: string) => {
        const current = walletTarget.value;
        if (!current) return;
        walletSubmitting.value = true;
        walletModalError.value = "";
        try {
            const outcome = await runGoverned(() => api.post(urlsMap.walletStatus(current.wallet.id), { status: current.action.targetStatus, reason }));
            notifyOutcome(outcome, "Wallet frozen");
            walletNotice.value = outcome.kind === "approval" ? { approvalRequestId: outcome.approvalRequestId } : null;
            walletTarget.value = null;
            walletRefresh.value?.();
            reloadSilently();
        } catch (cause) {
            walletModalError.value = reportCommerceError(cause);
        } finally {
            walletSubmitting.value = false;
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
                items: [
                    detailItem("Display name", entry.displayName, "Customer-facing display name.", "merchants.display_name"),
                    detailItem("Trade name", entry.tradeName, "Customer-facing trade name.", "merchants.tradeName"),
                    detailItem("Legal name", entry.legalName, "Registered legal entity name.", "merchants.legalName", true),
                    detailItem("Merchant ID", entry.id, "Stable merchant database identifier.", "merchants.id", true),
                    detailItem("Status", status.label, status.meaning, "merchants.status"),
                    detailItem("Version", entry.version, "Optimistic-concurrency version for pending edits.", "merchants.version"),
                    detailItem("Onboarding channel", entry.onboardingChannel, COLUMN_HELP.channel, "merchants.onboardingChannel"),
                    detailItem("Country", entry.country, COLUMN_HELP.country, "merchants.country"),
                    detailItem("Created", formatDateTime(entry.createdAt), "Merchant record creation time.", "merchants.created_at"),
                    detailItem("Activated", formatDateTime(entry.activatedAt), "Activation time.", "merchants.activatedAt"),
                    detailItem("Suspended", formatDateTime(entry.suspendedAt), "Suspension time.", "merchants.suspendedAt"),
                    detailItem("Suspension reason", entry.suspensionReasonRedacted ? t("Restricted") : entry.suspensionReasonCode, "AML reasons are restricted to compliance.", "merchants.suspensionReasonCode"),
                    detailItem("Closed", formatDateTime(entry.closedAt), "Closure time.", "merchants.closedAt"),
                ],
            },
            {
                title: t("Contacts and descriptive profile"),
                defaultExpanded: false,
                items: [
                    detailItem("Contact email", entry.contactEmail, "Primary merchant contact email.", "merchants.contactEmail", true),
                    detailItem("Contact phone", entry.contactPhone, "Primary merchant contact phone.", "merchants.contactPhone", true),
                    detailItem("Support email", entry.supportEmail, "Merchant support contact email.", "merchants.supportEmail", true),
                    detailItem("Support phone", entry.supportPhone, "Merchant support contact phone.", "merchants.supportPhone", true),
                    detailItem("Logo URL", entry.logoUrl, "Optional merchant logo URL.", "merchants.logoUrl"),
                ],
            },
            {
                title: t("Commercial and risk profile"),
                defaultExpanded: false,
                items: [
                    detailItem("Tax ID", sensitiveVisible ? entry.taxId : t("Restricted"), "Tax registration identifier. Sensitive field.", "merchants.taxId", true),
                    detailItem("Registration number", sensitiveVisible ? entry.registrationNo : t("Restricted"), "Commercial registration number. Sensitive field.", "merchants.registrationNo", true),
                    detailItem("Business category", sensitiveVisible ? entry.businessCategory : t("Restricted"), COLUMN_HELP.category, "merchants.businessCategory"),
                    detailItem("Risk tier", sensitiveVisible ? risk?.label ?? "—" : t("Restricted"), risk?.meaning, "merchants.riskTier"),
                    detailItem("KYB status", sensitiveVisible ? kyb?.label ?? "—" : t("Restricted"), kyb?.meaning, "merchants.kybStatus"),
                    detailItem("Next KYB review", sensitiveVisible ? formatDateTime(entry.nextKybReviewAt) : t("Restricted"), COLUMN_HELP.review, "merchants.nextKybReviewAt"),
                    detailItem("Commission receivable ceiling", financialVisible ? formatMoney(entry.commissionReceivableCeiling, currency.value) : t("Restricted"), "Commission receivable ceiling. Sensitive financial field.", "merchants.commissionReceivableCeiling"),
                    detailItem("Negative balance ceiling", financialVisible ? formatMoney(entry.negativeBalanceCeiling, currency.value) : t("Restricted"), "Allowed negative wallet balance ceiling. Sensitive financial field.", "merchants.negativeBalanceCeiling"),
                    detailItem("Payout bank", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).bank ?? "—") : t("Restricted"), "Payout bank name.", "merchants.payoutBankDetailsJson.bank"),
                    detailItem("Payout account", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).iban ?? (entry.payoutBankDetailsJson ?? {}).accountNumber ?? "—") : t("Restricted"), "Payout IBAN/account. Sensitive financial field.", "merchants.payoutBankDetailsJson.iban"),
                    detailItem("Payout holder", financialVisible ? String((entry.payoutBankDetailsJson ?? {}).holder ?? "—") : t("Restricted"), "Payout account holder.", "merchants.payoutBankDetailsJson.holder"),
                ],
            },
        ];
    });


    const healthItems = computed(() => {
        const current = stats.value;
        if (!current) return [];
        const totals = current.totals ?? ({} as Record<string, any>);
        const pendingCashouts = current.pendingCashouts ?? ({ count: 0, amount: 0 } as Record<string, any>);
        const successRate = Number(totals.successRate ?? 0);
        return [
            {
                key: "grossVolume",
                label: t("30-day gross volume"),
                moneyAmount: totals.grossVolume ?? 0,
                currency: currency.value,
                subLabel: t("Last 30 days"),
                badge: t("Gross"),
                badgeTone: "info" as const,
            },
            {
                key: "netCredited",
                label: t("Net credited"),
                moneyAmount: totals.netCredited ?? 0,
                currency: currency.value,
                subLabel: t("Settled to merchant"),
                badge: t("Net"),
                badgeTone: "success" as const,
            },
            {
                key: "commission",
                label: t("Platform commission"),
                moneyAmount: totals.commission ?? 0,
                currency: currency.value,
                subLabel: t("Platform revenue"),
                badge: t("Fee"),
                badgeTone: "neutral" as const,
            },
            {
                key: "attempts",
                label: t("Attempts"),
                value: String(totals.attemptCount ?? 0),
                subLabel: t("Payment attempts"),
                badge: t("30D"),
                badgeTone: "neutral" as const,
            },
            {
                key: "successRate",
                label: t("Success rate"),
                value: `${successRate.toFixed(2)}%`,
                subLabel: t("Authorization quality"),
                badge: successRate >= 90 ? t("Healthy") : t("Attention"),
                badgeTone: successRate >= 90 ? "success" as const : successRate >= 70 ? "warning" as const : "danger" as const,
            },
            {
                key: "averageTicket",
                label: t("Average ticket"),
                moneyAmount: totals.averageTicket ?? 0,
                currency: currency.value,
                subLabel: t("Per attempt"),
                badge: t("30D"),
                badgeTone: "neutral" as const,
            },
            {
                key: "openDisputes",
                label: t("Open disputes"),
                value: String(current.openDisputes ?? 0),
                subLabel: t("Dispute exposure"),
                badge: (current.openDisputes ?? 0) > 0 ? t("P1") : t("Clear"),
                badgeTone: (current.openDisputes ?? 0) > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "pendingCashouts",
                label: t("Pending cash-outs"),
                value: `${pendingCashouts.count ?? 0} · ${formatMoney(pendingCashouts.amount ?? 0, currency.value)}`,
                subLabel: t("Awaiting processing"),
                badge: (pendingCashouts.count ?? 0) > 0 ? t("Attention") : t("Clear"),
                badgeTone: (pendingCashouts.count ?? 0) > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "pendingChanges",
                label: t("Pending changes"),
                value: String(current.pendingApprovals ?? 0),
                subLabel: t("Awaiting independent checker"),
                badge: (current.pendingApprovals ?? 0) > 0 ? t("Four eyes") : t("Clear"),
                badgeTone: (current.pendingApprovals ?? 0) > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "unknownOutcomes",
                label: t("Unknown outcomes"),
                value: String(totals.unknownCount ?? 0),
                subLabel: t("Operator attention"),
                badge: (totals.unknownCount ?? 0) > 0 ? t("P1") : t("Clear"),
                badgeTone: (totals.unknownCount ?? 0) > 0 ? "danger" as const : "success" as const,
            },
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
                Value: ({ row }: { row: MerchantTransaction }) => <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} />,
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
                Value: ({ row }: { row: MerchantTransaction }) => <MoneyDisplay amount={row.totalChargedAmount} currency={row.currency} size="sm" />,
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
                        <MoneyDisplay amount={row.netMerchantAmount} currency={row.currency} size="sm" />
                        <ThemedView style={{ flexDirection: "row", gap: "4px", alignItems: "baseline" }}>
                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{t("fee")}</ThemedText>
                            <MoneyDisplay amount={row.gatewayFeeAmount} currency={row.currency} size="sm" />
                        </ThemedView>
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
            key: "ledgerEntry",
            label: "Ledger entry",
            value: (row) => row.ledgerEntryId ?? "",
            Value: ({ row }: { row: MerchantTransaction }) => entryLink(row.ledgerEntryId, (row.redactedFields ?? []).includes("ledgerEntryId")),
        });
        headers.push({
            key: "operatorCase",
            label: "Operator case",
            headerTooltip: COLUMN_HELP.transactionCase,
            value: (row) => row.operatorCases[0]?.state ?? "",
            Value: ({ row }: { row: MerchantTransaction }) =>
                row.operatorCases[0]
                    ? <StatusBadge status={row.operatorCases[0].state} label={`${row.operatorCases[0].priority} · ${row.operatorCases[0].state}`} toneOverride={asBadgeTone(statusTone(row.operatorCases[0].state))} />
                    : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        });
        return headers;
    });

    const applicationHeaders = computed<TableHeader<MerchantApplicationRow>[]>(() => {
        const headers: TableHeader<MerchantApplicationRow>[] = [
            {
                key: "name",
                label: "Application",
                sortKey: "name",
                headerTooltip: COLUMN_HELP.applicationName,
                value: (row) => row.name,
                Value: ({ row }: { row: MerchantApplicationRow }) => (
                    <ThemedView style={{ gap: "2px" }}>
                        <VBtn
                            size="small"
                            variant="text"
                            style={{ paddingInline: "2px", textTransform: "none", justifyContent: "flex-start", fontWeight: 600 }}
                            onClick={() => {
                                openApplicationId.value = row.id;
                            }}
                        >
                            {row.name}
                        </VBtn>
                        <MonoRef value={row.id} truncate={14} />
                    </ThemedView>
                ),
            },
            { key: "status", label: "Status", sortKey: "status", headerTooltip: COLUMN_HELP.applicationStatus, value: (row) => row.status, Value: ({ row }: { row: MerchantApplicationRow }) => <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} /> },
            {
                key: "wallet",
                label: "Wallet",
                value: (row) => row.assignedWallet.id,
                Value: ({ row }: { row: MerchantApplicationRow }) => (
                    <ThemedView style={{ gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px" }}>{row.assignedWallet.currency}</ThemedText>
                        <MonoRef value={row.assignedWallet.id} truncate={14} />
                    </ThemedView>
                ),
            },
            { key: "links", label: "Links / tokens", headerTooltip: COLUMN_HELP.applicationLinks, value: (row) => `${row.paymentLinkCount}/${row.accessTokenCount}`, Value: ({ row }: { row: MerchantApplicationRow }) => <ThemedText style={{ fontSize: "12px" }}>{row.paymentLinkCount} / {row.accessTokenCount}</ThemedText> },
            { key: "pos", label: "POS", value: (row) => String(row.posTerminalCount) },
            {
                key: "railWhitelist",
                label: "Rails",
                headerTooltip: COLUMN_HELP.applicationRails,
                value: (row) => (row.railWhitelist ?? []).join(" ") || row.railWhitelistMode,
                Value: ({ row }: { row: MerchantApplicationRow }) => {
                    const mode = row.railWhitelist === undefined ? row.railWhitelistMode : railWhitelistModeOf(row.railWhitelist);
                    if (mode === "ALL") return <StatusBadge status="ACTIVE" label={t("All rails")} toneOverride="neutral" />;
                    if (mode === "NONE") return <StatusBadge status="BLOCKED" label={t("No rails")} toneOverride="warning" />;
                    return row.railWhitelist ? <PillList items={row.railWhitelist} max={3} /> : <StatusBadge status="LIST" label={`${row.railWhitelistCount} ${t("rails")}`} toneOverride="neutral" />;
                },
            },
            { key: "domains", label: "Domains", headerTooltip: COLUMN_HELP.applicationDomains, value: (row) => String(row.redirectDomainCount) },
            { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: MerchantApplicationRow }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
            {
                key: "actions",
                label: "Action",
                sortable: false,
                Value: ({ row }: { row: MerchantApplicationRow }) => (
                    <TableRowActions
                        primaryAction={{
                            label: t("Inspect"),
                            icon: "mdi-application-outline",
                            onClick: () => {
                                openApplicationId.value = row.id;
                            },
                        }}
                        items={[
                            {
                                key: "wallet",
                                label: t("Open wallet"),
                                icon: "mdi-wallet-outline",
                                onClick: () => {
                                    openWalletId.value = row.assignedWallet.id;
                                },
                            },
                            {
                                key: "page",
                                label: t("Open in Applications"),
                                icon: "mdi-open-in-new",
                                onClick: () => {
                                    void router.push({ name: "Applications", query: { open: row.id } });
                                },
                            },
                        ]}
                    />
                ),
            },
        ];
        if (!isSupport.value) {
            headers.splice(3, 0, {
                key: "expectedMonthlyVolume",
                label: "Expected volume",
                sortKey: "expectedMonthlyVolume",
                headerTooltip: COLUMN_HELP.applicationVolume,
                value: (row) => row.expectedMonthlyVolume ?? "",
                Value: ({ row }: { row: MerchantApplicationRow }) => <MoneyOrRestricted amount={row.expectedMonthlyVolume} currency={row.assignedWallet.currency} restricted={isRestricted(row.redactedFields, "expectedMonthlyVolume", row.expectedMonthlyVolume)} />,
            });
        }
        return headers;
    });

    const walletHeaders = computed<TableHeader<MerchantWalletRow>[]>(() => [
        {
            key: "id",
            label: "Wallet",
            headerTooltip: COLUMN_HELP.walletId,
            value: (row) => row.id,
            Value: ({ row }: { row: MerchantWalletRow }) => (
                <VBtn
                    size="small"
                    variant="text"
                    style={{ paddingInline: "2px", textTransform: "none", justifyContent: "flex-start" }}
                    onClick={() => {
                        openWalletId.value = row.id;
                    }}
                >
                    <MonoRef value={row.id} truncate={14} />
                </VBtn>
            ),
        },
        { key: "currency", label: "Currency", sortKey: "currency", value: (row) => row.currency },
        { key: "status", label: "Status", sortKey: "status", value: (row) => row.status, Value: ({ row }: { row: MerchantWalletRow }) => <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} /> },
        {
            key: "balance",
            label: "Ledger balance",
            headerTooltip: COLUMN_HELP.walletBalance,
            value: (row) => row.balance ?? "",
            Value: ({ row }: { row: MerchantWalletRow }) => <MoneyOrRestricted amount={row.balance} currency={row.currency} restricted={isRestricted(row.redactedFields, "balance", row.balance)} />,
        },
        {
            key: "checkpoint",
            label: "Checkpoint",
            headerTooltip: COLUMN_HELP.walletCheckpoint,
            value: (row) => row.checkpointBalance ?? "",
            Value: ({ row }: { row: MerchantWalletRow }) => <MoneyOrRestricted amount={row.checkpointBalance} currency={row.currency} restricted={isRestricted(row.redactedFields, "checkpointBalance", row.checkpointBalance)} />,
        },
        { key: "applications", label: "Apps", value: (row) => String(row.applicationCount) },
        { key: "links", label: "Links", value: (row) => String(row.paymentLinkCount) },
        { key: "cashouts", label: "Cash-outs", headerTooltip: COLUMN_HELP.walletCashouts, value: (row) => `${row.pendingCashoutCount}/${row.cashoutCount}` },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }: { row: MerchantWalletRow }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
        {
            key: "actions",
            label: "Action",
            sortable: false,
            Value: ({ row }: { row: MerchantWalletRow }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Inspect"),
                        icon: "mdi-wallet-outline",
                        onClick: () => {
                            openWalletId.value = row.id;
                        },
                    }}
                    items={[
                        {
                            key: "page",
                            label: t("Open in Wallets"),
                            icon: "mdi-open-in-new",
                            onClick: () => {
                                void router.push({ name: "Wallets", query: { open: row.id } });
                            },
                        },
                        ...walletActionsFor(row.status, { canWrite: canWriteCommerce.value }).map((action) => ({
                            key: action.key,
                            label: t(action.label),
                            icon: action.icon,
                            danger: action.danger,
                            dividerBefore: true,
                            onClick: () => {
                                walletModalError.value = "";
                                walletTarget.value = { wallet: row, action };
                            },
                        })),
                    ]}
                />
            ),
        },
    ]);

    const cashoutHeaders: TableHeader<MerchantCashout>[] = [
        { key: "id", label: "Cash-out", value: (row) => row.id, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.id}</ThemedText> },
        { key: "amount", label: "Amount", sortKey: "amount", value: (row) => row.amount, Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "state", label: "State", sortKey: "state", value: (row) => row.state, Value: ({ row }) => <StatusBadge status={row.state} label={row.state} toneOverride={asBadgeTone(statusTone(row.state))} /> },
        { key: "wallet", label: "Wallet", value: (row) => row.wallet.id, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.wallet.id}</ThemedText> },
        { key: "destination", label: "Destination", headerTooltip: COLUMN_HELP.cashoutDestination, value: (row) => `${String(row.destination.bank ?? row.destination.bankName ?? "")} ${String(row.destination.account ?? row.destination.accountNumber ?? row.destination.iban ?? "")}`.trim(), Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{String(row.destination.bank ?? row.destination.bankName ?? "—")} · {String(row.destination.account ?? row.destination.accountNumber ?? row.destination.iban ?? "—")}</ThemedText> },
        { key: "adjustment", label: "Adjustment", value: (row) => row.adjustment?.state ?? "", Value: ({ row }) => row.adjustment ? <StatusBadge status={row.adjustment.state} label={row.adjustment.state} toneOverride={asBadgeTone(statusTone(row.adjustment.state))} /> : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText> },
        { key: "journal", label: "Journal entry", value: (row) => row.adjustment?.journalEntryId ?? "", Value: ({ row }) => entryLink(row.adjustment?.journalEntryId) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const disputeHeaders: TableHeader<MerchantDispute>[] = [
        { key: "externalDisputeRef", label: "Dispute", value: (row) => row.externalDisputeRef, Value: ({ row }) => <ThemedView style={{ gap: "2px" }}><ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.externalDisputeRef}</ThemedText><ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.attempt.reference}</ThemedText></ThemedView> },
        { key: "amount", label: "Amount", sortKey: "amount", value: (row) => row.amount, Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "status", label: "Status", sortKey: "status", value: (row) => row.status, Value: ({ row }) => <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} /> },
        { key: "reason", label: "Reason", headerTooltip: COLUMN_HELP.disputeReason, value: (row) => row.reasonCode ?? "" },
        { key: "rail", label: "Rail / gateway", value: (row) => `${row.rail.code} ${row.gateway.code}` },
        { key: "openedAt", label: "Opened", sortKey: "openedAt", value: (row) => row.openedAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.openedAt)}</ThemedText> },
        { key: "evidenceDueAt", label: "Evidence due", sortKey: "evidenceDueAt", value: (row) => row.evidenceDueAt ?? "", Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.evidenceDueAt)}</ThemedText> },
        { key: "adjustment", label: "Adjustment", value: (row) => row.adjustment?.state ?? "", Value: ({ row }) => row.adjustment ? <StatusBadge status={row.adjustment.state} label={row.adjustment.state} toneOverride={asBadgeTone(statusTone(row.adjustment.state))} /> : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText> },
        { key: "journal", label: "Journal entry", value: (row) => row.adjustment?.journalEntryId ?? "", Value: ({ row }) => entryLink(row.adjustment?.journalEntryId) },
    ];

    const adjustmentHeaders: TableHeader<MerchantAdjustment>[] = [
        { key: "id", label: "Adjustment", value: (row) => row.id, Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.id}</ThemedText> },
        { key: "type", label: "Type", sortKey: "type", value: (row) => row.type },
        { key: "amount", label: "Amount", sortKey: "amount", value: (row) => row.amount, Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "state", label: "State", sortKey: "state", value: (row) => row.state, Value: ({ row }) => <StatusBadge status={row.state} label={row.state} toneOverride={asBadgeTone(statusTone(row.state))} /> },
        { key: "attempt", label: "Source attempt", value: (row) => row.sourceAttempt?.reference ?? "", Value: ({ row }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.sourceAttempt?.reference ?? "—"}</ThemedText> },
        { key: "dispute", label: "Dispute", value: (row) => row.dispute?.externalDisputeRef ?? "" },
        { key: "reason", label: "Reason", headerTooltip: COLUMN_HELP.adjustmentReason, value: (row) => row.reason },
        { key: "journal", label: "Journal entry", value: (row) => row.journalEntryId ?? "", Value: ({ row }) => entryLink(row.journalEntryId) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const notificationHeaders: TableHeader<MerchantNotification>[] = [
        { key: "templateCode", label: "Template", sortKey: "templateCode", value: (row) => row.templateCode },
        { key: "channel", label: "Channel", sortKey: "channel", value: (row) => `${row.channel} ${row.lang}`, Value: ({ row }) => <StatusBadge status={row.channel} label={`${row.channel} · ${row.lang}`} toneOverride="neutral" /> },
        { key: "status", label: "Status", sortKey: "status", value: (row) => row.status, Value: ({ row }) => <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} /> },
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
        {
            key: "change",
            label: "Change",
            value: (row) => (row.redacted ? "" : summarizeAuditChange(row.before, row.after).join(" ")),
            Value: ({ row }) => (row.redacted ? <RestrictedValue /> : <AuditChangeChips before={row.before} after={row.after} />),
        },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt, Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText> },
    ];

    const detailTabs = computed(() => [
        { value: "all", label: t("All") },
        { value: "details", label: t("Details") },
        { value: "transactions", label: t("Transactions") },
        { value: "wallets", label: t("Wallets") },
        { value: "applications", label: t("Applications") },
        ...(canFinancial.value ? [{ value: "finance", label: t("Finance") }] : []),
        ...(!isSupport.value ? [{ value: "compliance", label: t("Compliance") }] : []),
        { value: "access", label: t("Access & activity") },
    ]);

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
                        subtitle={t("Inspect the merchant profile, payment activity, compliance evidence and governed change history.")}
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
                        <span title={statusHelp.value.meaning}><StatusBadge status={entry.status} label={statusHelp.value.label} toneOverride={asBadgeTone(statusHelp.value.tone)} /></span>
                        {entry.kybStatus && <StatusBadge status={entry.kybStatus} label={kybStatusHelp(entry.kybStatus).label} toneOverride={asBadgeTone(kybStatusHelp(entry.kybStatus).tone)} />}
                        {entry.riskTier && <StatusBadge status={entry.riskTier} label={riskHelp(entry.riskTier).label} toneOverride={asBadgeTone(riskHelp(entry.riskTier).tone)} />}
                        <StatusBadge status="version" label={`v${entry.version}`} toneOverride="neutral" />
                        {entry.pendingApprovalCount > 0 && <StatusBadge status="pending" label={`${entry.pendingApprovalCount} ${t("pending changes")}`} toneOverride="warning" />}
                        {entry.redactedFields.length > 0 && <StatusBadge status="restricted" label={t("Some fields restricted")} toneOverride="neutral" />}
                    </ThemedView>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Merchant identifiers")}</ThemedText>
                            <DescriptionList
                                columns={2}
                                items={[
                                    { label: t("Merchant ID"), value: <MonoRef value={entry.id} /> },
                                    { label: t("Legal name"), value: entry.legalName || "—" },
                                    { label: t("Status"), value: statusHelp.value.label },
                                    { label: t("KYB status"), value: entry.kybStatus ? kybStatusHelp(entry.kybStatus).label : "—" },
                                    { label: t("Risk tier"), value: entry.riskTier ? riskHelp(entry.riskTier).label : "—" },
                                    { label: t("Version"), value: `v${entry.version}` },
                                    { label: t("Contact email"), value: entry.contactEmail || "—" },
                                    { label: t("Next KYB review"), value: formatDateTime(entry.nextKybReviewAt) },
                                ]}
                            />
                        </SurfaceCardText>
                    </SurfaceCard>

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

                    <SegmentedTabs
                        modelValue={activeTab.value}
                        tabs={detailTabs.value}
                        onUpdate:modelValue={(value: string) => (activeTab.value = value as MerchantDetailTab)}
                    />

                    {activeTab.value === "all" && areHelpPanelsVisible() && <SurfaceCard><SurfaceCardText><MerchantHelpPanel /></SurfaceCardText></SurfaceCard>}

                    {show("details") && sections.value.map((section) => (
                        <SurfaceCard key={section.title}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{section.title}</ThemedText>
                                {("description" in section && section.description) && (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{section.description}</ThemedText>
                                )}
                                <DescriptionList columns={2} items={section.items} />
                            </SurfaceCardText>
                        </SurfaceCard>
                    ))}

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
                            <MetricStrip items={healthItems.value} />
                        )}
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                            <StatusBadge status="ledger balance" label={`${t("Ledger balance")}: ${formatMoney(stats.value?.walletBalance?.balance ?? balance.value, currency.value)}`} toneOverride={Number(stats.value?.walletBalance?.balance ?? balance.value ?? 0) < 0 ? "danger" : "success"} />
                            <StatusBadge status="negative ceiling" label={`${t("Negative ceiling")}: ${formatMoney(stats.value?.negativeBalanceCeiling ?? entry.negativeBalanceCeiling, currency.value)}`} toneOverride="neutral" />
                            <StatusBadge status="next review" label={`${t("Next KYB review")}: ${formatDateTime(stats.value?.nextKybReviewAt ?? entry.nextKybReviewAt)}`} toneOverride="neutral" />
                        </ThemedView>
                    </CollapsibleSection>

                    <CollapsibleSection
                        command={sectionCommand.value}
                        alwaysOpen={activeTab.value !== "all"}
                        title={t("Recent transactions")}
                        subtitle={t("Payment attempts for this merchant. Open a reference for the full masked transaction context; inquiries are limited to eligible UNKNOWN or VERIFYING attempts.")}
                        defaultOpen={true}
                        storageKey={`merchant:${merchantId.value}:transactions`}
                        count={stats.value?.totals?.attemptCount}
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
                            initialSearch={reference.value}
                            focusReference={reference.value}
                            onFocusReference={(transaction) => openTransaction(transaction)}
                            onRefreshReady={(refresh) => (transactionRefresh.value = refresh)}
                        />
                    </CollapsibleSection>
                        </>
                    )}

                    {show("wallets") && (
                        <CollapsibleSection
                            command={sectionCommand.value}
                            alwaysOpen={activeTab.value !== "all"}
                            title={t("Wallets and balances")}
                            subtitle={t("Wallet balances are derived from posted journal lines and checkpoint balances. Pending cash-outs are shown per wallet.")}
                            defaultOpen={true}
                            storageKey={`merchant:${merchantId.value}:wallets`}
                        >
                            {walletNotice.value && (
                                <ApprovalSubmittedNotice approvalRequestId={walletNotice.value.approvalRequestId} onDismiss={() => (walletNotice.value = null)} />
                            )}
                            {isSupport.value && (
                                <VAlert type="info" variant="tonal" density="compact">{t("Balances are hidden for your role and shown as Restricted.")}</VAlert>
                            )}
                            <MerchantResourceTable<MerchantWalletRow>
                                title={t("Wallets")}
                                url={urlsMap.merchantWallets(merchantId.value)}
                                listKey="wallets"
                                headers={walletHeaders.value}
                                filters={walletFilters()}
                                pageSize={10}
                                noElevation={true}
                                onRefreshReady={(refresh) => (walletRefresh.value = refresh)}
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
                                onRefreshReady={(refresh) => (applicationRefresh.value = refresh)}
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
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Pending changes")}</ThemedText>
                                {entry.pendingChanges.map((change) => (
                                    <SurfaceCard key={change.id} variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusBadge status={change.state} label={change.state} toneOverride={asBadgeTone(statusTone(change.state))} />
                                                <ThemedText style={{ fontSize: "12px" }}>{change.maker?.email ?? change.makerUserId}</ThemedText>
                                                {change.baseVersion && <StatusBadge status="base version" label={`base v${change.baseVersion}`} toneOverride="neutral" />}
                                            </ThemedView>
                                            {change.makerReason && <ThemedText style={{ fontSize: "12px" }}>{change.makerReason}</ThemedText>}
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(change.createdAt)} · {change.mode}</ThemedText>
                                            {change.payloadDiffJson && <JsonDiffViewer diff={change.payloadDiffJson} />}
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                                <VBtn
                                                    size="x-small"
                                                    variant="text"
                                                    prependIcon="mdi-open-in-new"
                                                    onClick={() => {
                                                        void router.push({ name: "Approvals", query: { open: change.id } });
                                                    }}
                                                >
                                                    {t("Open in Approvals")}
                                                </VBtn>
                                                {change.makerUserId === currentUserId.value && ["DRAFT", "PENDING_REVIEW"].includes(change.state) && (
                                                    <VBtn size="x-small" variant="text" color="error" onClick={() => openWithdraw(change)}>{t("Withdraw")}</VBtn>
                                                )}
                                            </ThemedView>
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {show("compliance") && entry.amlCases && entry.amlCases.length > 0 && canAml.value && (
                        <SurfaceCard variant="tonal" color="error">
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("AML cases")}</ThemedText>
                                {entry.amlCases.map((amlCase) => (
                                    <ThemedView key={amlCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusBadge status={amlCase.status} label={amlCase.status} toneOverride={asBadgeTone(statusTone(amlCase.status))} />
                                        <StatusBadge status={amlCase.severity} label={amlCase.severity} toneOverride={asBadgeTone(statusTone(amlCase.severity))} />
                                        <ThemedText style={{ fontSize: "12px" }}>{amlCase.triggerReason}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(amlCase.createdAt)}</ThemedText>
                                        <VBtn
                                            size="x-small"
                                            variant="text"
                                            prependIcon="mdi-open-in-new"
                                            onClick={() => {
                                                void router.push({ name: "AmlCases", query: { open: amlCase.id } });
                                            }}
                                        >
                                            {t("Open case")}
                                        </VBtn>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {show("compliance") && entry.joinRequests && entry.joinRequests.length > 0 && (
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Join requests")}</ThemedText>
                                    <VBtn size="small" variant="text" onClick={() => void router.push({ name: "JoinRequests" })}>{t("Open queue")}</VBtn>
                                </ThemedView>
                                {(entry.joinRequests ?? []).map((row) => (
                                    <ThemedView key={row.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} />
                                        <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>{row.id}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(row.createdAt)}</ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "JoinRequestDetail", params: { id: row.id } })}>
                                            {t("Open")}
                                        </VBtn>
                                    </ThemedView>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {show("compliance") && !isSupport.value && (
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                                    <ThemedView style={{ gap: "2px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("KYB evidence")}</ThemedText>
                                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                            {entry.kybStatus ? (
                                                <StatusBadge status={entry.kybStatus} label={kybStatusHelp(entry.kybStatus).label} toneOverride={asBadgeTone(kybStatusHelp(entry.kybStatus).tone)} />
                                            ) : (
                                                <RestrictedValue />
                                            )}
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{`${t("Next KYB review")}: ${formatDateTime(entry.nextKybReviewAt)}`}</ThemedText>
                                        </ThemedView>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                        {canKyb.value && (
                                            <VBtn
                                                size="small"
                                                variant="tonal"
                                                prependIcon="mdi-file-sync-outline"
                                                onClick={() => {
                                                    revalidationOpen.value = true;
                                                }}
                                            >
                                                {t("Request KYB revalidation")}
                                            </VBtn>
                                        )}
                                        <VBtn size="small" variant="text" onClick={() => void router.push({ name: "KybReview" })}>{t("Open KYB review")}</VBtn>
                                    </ThemedView>
                                </ThemedView>
                                {(entry.kybDocuments ?? []).length === 0 ? (
                                    <EmptyState icon="mdi-file-document-outline" title={t("No KYB documents")} description={t("No KYB document has been uploaded for this merchant yet.")} />
                                ) : (
                                    (entry.kybDocuments ?? []).map((document) => (
                                        <ThemedView key={document.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                            <StatusBadge status={document.status} label={document.status} toneOverride={asBadgeTone(statusTone(document.status))} />
                                            <StatusBadge status={document.avStatus} label={document.avStatus} toneOverride={asBadgeTone(statusTone(document.avStatus))} />
                                            <ThemedText style={{ fontSize: "12px" }}>{document.docType} · {document.originalFileName || document.id}</ThemedText>
                                            <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "KybReviewDetail", params: { id: document.id } })}>{t("Open")}</VBtn>
                                        </ThemedView>
                                    ))
                                )}
                                {(entry.revalidations ?? []).length > 0 && (
                                    <ThemedView style={{ gap: "6px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Revalidation requests")}</ThemedText>
                                        <MiniTable
                                            ariaLabel={t("Revalidation requests")}
                                            emptyLabel={t("No open revalidation requests")}
                                            rows={entry.revalidations ?? []}
                                            rowKey={(row: { id: string }) => row.id}
                                            columns={[
                                                { key: "docType", label: t("Document type"), render: (row: { docType: string }) => t(KYB_DOC_TYPE_LABELS[row.docType as KybDocType] ?? row.docType) },
                                                { key: "status", label: t("Status"), render: (row: { status: string }) => <StatusBadge status={row.status} label={row.status} toneOverride={asBadgeTone(statusTone(row.status))} /> },
                                                { key: "dueAt", label: t("Due date"), render: (row: { dueAt: string | null }) => formatDateTime(row.dueAt) },
                                                { key: "message", label: t("Message"), render: (row: { message: string }) => row.message },
                                            ]}
                                        />
                                    </ThemedView>
                                )}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {show("compliance") && !isSupport.value && (
                        <BeneficialOwnersCard
                            merchantId={merchantId.value}
                            initialOwners={entry.beneficialOwners ?? []}
                            canWrite={canKyb.value}
                            closed={entry.status === "CLOSED"}
                            onChanged={reloadSilently}
                        />
                    )}

                    {show("access") && ((entry.users ?? []).length > 0 || (entry.accessTokens ?? []).length > 0 || (entry.credentialSets ?? []).length > 0) && (
                        <MerchantAccessCard
                            users={entry.users ?? []}
                            tokens={entry.accessTokens ?? []}
                            credentialSets={entry.credentialSets ?? []}
                            canWrite={canWriteCommerce.value}
                            onChanged={reloadSilently}
                        />
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
                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Field history")}</ThemedText>
                                <VBtn size="small" variant="text" onClick={() => (historyOpen.value = true)}>{t("View all")}</VBtn>
                            </ThemedView>
                            {entry.fieldHistory.length === 0 && <ThemedText style={{ opacity: 0.6 }}>{t("No field changes recorded")}</ThemedText>}
                            {entry.fieldHistory.slice(0, 8).map((change) => (
                                <ThemedView key={change.id} style={{ gap: "2px", borderBottom: "1px solid var(--pg-border-subtle)", paddingBottom: "6px" }}>
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                        <StatusBadge status={change.fieldName} label={change.fieldName} toneOverride={change.redacted ? "neutral" : "info"} />
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{change.actorEmail || change.actorId} · {formatDateTime(change.createdAt)} · {change.source}</ThemedText>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.8 }}>
                                        {change.redacted ? t("Value restricted") : `${change.oldValue ?? "—"} → ${change.newValue ?? "—"}`}
                                    </ThemedText>
                                </ThemedView>
                            ))}
                        </SurfaceCardText>
                    </SurfaceCard>
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
                <WalletDetailDrawer
                    walletId={openWalletId.value}
                    onClose={() => (openWalletId.value = null)}
                    onChanged={() => {
                        walletRefresh.value?.();
                        reloadSilently();
                    }}
                />
                <ApplicationDetailDrawer
                    applicationId={openApplicationId.value}
                    onClose={() => (openApplicationId.value = null)}
                    onChanged={() => {
                        applicationRefresh.value?.();
                        reloadSilently();
                    }}
                />
                <JournalEntryDrawer entryId={openEntryId.value} onClose={() => (openEntryId.value = null)} />
                <RevalidationModal
                    modelValue={revalidationOpen.value}
                    merchantId={merchantId.value}
                    onUpdate:modelValue={(value: boolean) => (revalidationOpen.value = value)}
                    onDone={reloadSilently}
                />
                <ReasonModal
                    modelValue={walletTarget.value !== null}
                    onUpdate:modelValue={(value: boolean) => {
                        if (!value) walletTarget.value = null;
                    }}
                    title={walletTarget.value ? `${t(walletTarget.value.action.label)} · ${walletTarget.value.wallet.currency}` : ""}
                    description={
                        walletTarget.value?.action.mode === "approval"
                            ? t("Restoring a frozen wallet needs an independent checker.")
                            : t("A frozen wallet cannot be debited by cash-outs until it is restored.")
                    }
                    mode={walletTarget.value?.action.mode ?? "immediate"}
                    danger={walletTarget.value?.action.danger ?? false}
                    submitLabel={walletTarget.value ? t(walletTarget.value.action.label) : ""}
                    loading={walletSubmitting.value}
                    errorMessage={walletModalError.value}
                    onSubmit={(reason: string) => void submitWalletAction(reason)}
                />
                <FormModal
                    modelValue={withdrawOpen.value}
                    onUpdate:modelValue={(value: boolean) => (withdrawOpen.value = value)}
                    title={t("Withdraw pending change")}
                    size="md"
                    onSubmit={() => void withdraw()}
                    submitLabel={t("Withdraw")}
                    cancelLabel={t("Cancel")}
                    danger
                >
                    <ThemedText style={{ fontSize: "13px" }}>{withdrawTarget.value?.id}</ThemedText>
                    <FormField label={t("Withdrawal reason (optional)")}>
                        <VTextarea v-model={withdrawReason.value} rows={3} autoGrow />
                    </FormField>
                </FormModal>
                <SlideOverDrawer
                    modelValue={historyOpen.value}
                    onUpdate:modelValue={(value: boolean) => (historyOpen.value = value)}
                    title={t("Field history")}
                    width={760}
                >
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
                </SlideOverDrawer>
            </ScreenContainer>
        );
    };
});

export default MerchantDetailPage;
