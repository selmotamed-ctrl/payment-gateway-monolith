import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VCheckbox, VExpansionPanel, VExpansionPanelText, VExpansionPanelTitle, VExpansionPanels, VIcon, VSelect, VTextField, VTextarea, VTimeline, VTimelineItem } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { user, hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import { statusTone } from "@/components/Table/statusTone";
import {
    CASE_REFERENCE_SOURCE_HELP,
    INQUIRY_REASON_HELP,
    caseHelp,
    caseNarrative,
    caseStateHelp,
    formatDateTime,
    priorityHelp,
    reconciliationHelp,
    slaInfo,
} from "./operatorCaseHelp";
import type { OperatorCaseDetail } from "./types";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { JsonDiffViewer } from "@/components/ui/JsonDiffViewer";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
const parse = (payload: unknown): OperatorCaseDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.operatorCase ?? source) as OperatorCaseDetail;
};

const approvalPayload = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

const asText = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    return String(value);
};

const jsonText = (value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const detailItem = (
    label: string,
    value: unknown,
    _hint?: string,
    _source?: string,
    mono = false,
): DescriptionItem => ({
    label,
    value:
        value === null || value === undefined || value === ""
            ? "—"
            : mono
              ? <MonoRef value={String(value)} />
              : String(value),
});

const RESOLVE_CHECKS = [
    { key: "EVIDENCE_REVIEWED", label: "Evidence reviewed" },
    { key: "ATTEMPT_STATUS_VERIFIED", label: "Attempt status verified" },
    { key: "OUTCOME_DOCUMENTED", label: "Outcome documented" },
    { key: "CHECKER_REQUIREMENT_CONFIRMED", label: "Checker requirement confirmed" },
] as const;

const OperatorCaseDetailPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const route = useRoute();
    const router = useRouter();

    const detail = ref<OperatorCaseDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const actionLoading = ref(false);
    const resolveOpen = ref(false);
    const resolveAction = ref("MARK_FAILED");
    const resolveReason = ref("");
    const resolveNotes = ref("");
    const resolveChecklist = ref<Record<string, boolean>>({});
    const providerReference = ref("");
    const settledAmount = ref("");
    const checkerReason = ref("");

    const caseId = computed(() => String(route.params.id ?? ""));

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.operatorCaseDetail(caseId.value));
            detail.value = parse(response.data?.data ?? response.data ?? {});
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            detail.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch(caseId, () => void load());
    void load();

    const canWrite = computed(() => hasOneOfAuthorities(["case:write", "operator:write", "attempt:inquire"]));
    const canInquire = computed(() => hasOneOfAuthorities(["attempt:inquire", "case:write"]));
    const canCheck = computed(
        () =>
            hasOneOfAuthorities(["approval:check", "approval:write"]) &&
            detail.value?.approvalRequest?.state === "PENDING_REVIEW" &&
            detail.value?.approvalRequest?.makerUserId !== user.value?.userInfo?.id,
    );
    const isResolved = computed(() => detail.value?.state === "RESOLVED");
    const isPendingChecker = computed(() => detail.value?.state === "PENDING_CHECKER");
    const inquiry = computed(() => detail.value?.inquiryEligibility);
    const sla = computed(() => slaInfo(detail.value?.slaDueAt));
    const narrative = computed(() => (detail.value ? caseNarrative(detail.value) : null));
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;

    const stats = computed(() => {
        const entry = detail.value;
        const currency = entry?.attempt?.currency ?? entry?.currency ?? "LYD";
        const amount = entry?.chargedAmount ?? entry?.statementAmount ?? "0";
        return [
            {
                key: "amount",
                label: t("Charged amount"),
                moneyAmount: amount,
                currency,
                subLabel: entry?.statementAmount && !entry?.chargedAmount ? t("Statement amount") : t("Attempt amount"),
                badge: currency,
                badgeTone: "info" as const,
            },
            {
                key: "attemptStatus",
                label: t("Attempt status"),
                value: entry?.attemptStatus ?? "—",
                subLabel: entry?.attemptSubstatus ?? t("No substatus"),
                badge: entry?.attemptStatus ?? t("Unknown"),
                badgeTone: asBadgeTone(statusTone(entry?.attemptStatus)),
            },
            {
                key: "sla",
                label: t("SLA"),
                value: sla.value.label,
                subLabel: formatDateTime(entry?.slaDueAt),
                badge: sla.value.label,
                badgeTone: asBadgeTone(sla.value.tone),
            },
            {
                key: "priority",
                label: t("Priority"),
                value: entry?.priority ?? "—",
                subLabel: caseStateHelp(entry?.state).label,
                badge: entry?.priority ?? t("P3"),
                badgeTone: asBadgeTone(statusTone(entry?.priority)),
            },
        ];
    });

    const actionOptions = computed(() => {
        const attempt = detail.value?.attempt;
        const status = String(attempt?.status ?? "");
        const terminal = Boolean(attempt?.terminalAt);
        const options: Array<{ title: string; value: string }> = [];
        if (attempt) {
            if (["UNKNOWN", "VERIFYING", "FAILED", "EXPIRED", "SUCCEEDED"].includes(status)) {
                options.push({ title: t("Resolve as succeeded"), value: "MARK_SUCCEEDED" });
            }
            if (["UNKNOWN", "VERIFYING"].includes(status)) {
                options.push({ title: t("Resolve as failed and release reservation"), value: "MARK_FAILED" });
            }
        }
        if (!attempt || terminal) {
            options.push({ title: t("Close case without changing the attempt"), value: "CLOSE_CASE" });
        }
        return options;
    });

    const openResolve = () => {
        if (actionOptions.value.length === 0) {
            showSnackBar({
                type: "warning",
                message: t("No resolution action is available for the current attempt status"),
            });
            return;
        }
        resolveReason.value = "";
        resolveNotes.value = "";
        resolveChecklist.value = {};
        providerReference.value = detail.value?.attempt?.providerReference ?? "";
        settledAmount.value = detail.value?.attempt?.totalChargedAmount ?? "";
        resolveAction.value = actionOptions.value[0]?.value ?? "CLOSE_CASE";
        resolveOpen.value = true;
    };

    const refreshAfterAction = async () => {
        await load();
    };

    const assignToMe = async () => {
        const userId = user.value?.userInfo?.id;
        if (!userId) {
            showSnackBar({ type: "error", message: t("Your session does not carry a user id") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.patch(urlsMap.operatorCaseUpdate(caseId.value), {
                assigneeUserId: userId,
                state: detail.value?.state === "OPEN" ? "IN_PROGRESS" : undefined,
            });
            showSnackBar({ type: "success", message: t("Assigned") });
            await refreshAfterAction();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const startWork = async () => {
        actionLoading.value = true;
        try {
            await api.patch(urlsMap.operatorCaseUpdate(caseId.value), { state: "IN_PROGRESS" });
            showSnackBar({ type: "success", message: t("In progress") });
            await refreshAfterAction();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const inquire = async () => {
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.operatorCasesBulkInquire, { caseIds: [caseId.value] });
            const payload = response.data?.data ?? response.data ?? {};
            const result = (payload.results ?? [])[0];
            showSnackBar({
                type: result?.status === "SCHEDULED" ? "success" : "warning",
                message:
                    result?.status === "SCHEDULED"
                        ? t("Gateway inquiry scheduled")
                        : t(result?.message ?? "Inquiry could not be scheduled"),
            });
            await refreshAfterAction();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const resolveChecklistComplete = computed(() => !showChecklists || RESOLVE_CHECKS.every((check) => resolveChecklist.value[check.key] === true));
    const resolveSafeguard = useSafeguard("sg-resolve-unknown");

    const proposeResolution = async () => {
        if (!detail.value || resolveReason.value.trim().length < 3) return;
        if (resolveAction.value === "MARK_SUCCEEDED" && providerReference.value.trim().length === 0) {
            showSnackBar({ type: "warning", message: t("A provider reference is required to resolve as succeeded") });
            return;
        }
        if (!resolveChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all resolution checklist items before submitting") });
            return;
        }
        if (!(await resolveSafeguard.confirm())) return;
        actionLoading.value = true;
        try {
            await api.post(urlsMap.operatorCaseResolve(caseId.value), {
                action: resolveAction.value,
                reason: resolveReason.value.trim(),
                ...(resolveNotes.value.trim() ? { notes: resolveNotes.value.trim() } : {}),
                ...(resolveAction.value === "MARK_SUCCEEDED" && providerReference.value.trim()
                    ? { providerReference: providerReference.value.trim() }
                    : {}),
                checklist: RESOLVE_CHECKS.filter((check) => resolveChecklist.value[check.key]).map((check) => check.key),
                ...(resolveAction.value === "MARK_SUCCEEDED" && settledAmount.value.trim()
                    ? { settledAmount: settledAmount.value.trim() }
                    : {}),
            });
            resolveOpen.value = false;
            showSnackBar({ type: "success", message: t("Resolution proposed; awaiting checker") });
            await refreshAfterAction();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const decideApproval = async (approve: boolean) => {
        const approval = detail.value?.approvalRequest;
        if (!approval) return;
        const reason = checkerReason.value.trim() || (approve ? "Reviewed and approved" : "");
        if (!approve && reason.length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(
                approve ? urlsMap.approvalApprove(approval.id) : urlsMap.approvalReject(approval.id),
                { reason },
            );
            checkerReason.value = "";
            showSnackBar({
                type: "success",
                message: approve ? t("Approved and executed") : t("Rejected"),
            });
            await refreshAfterAction();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const statusLabel = computed(() => detail.value?.attempt?.status ?? null);
    const caseRef = computed(() => detail.value?.caseRef ?? caseId.value);

    const identifierItems = computed(() => identifiers.value);

    const identifiers = computed<DescriptionItem[]>(() => {
        const entry = detail.value;
        const attempt = entry?.attempt;
        const link = attempt?.link;
        const item = entry?.reconciliationItem;
        const source = item?.run?.statementSource;
        const approval = entry?.approvalRequest;
        return [
            detailItem("Operator case ID", entry?.id, "Primary key of the case row.", "operator_cases.id", true),
            detailItem("Case reference", entry?.caseRef, CASE_REFERENCE_SOURCE_HELP[entry?.caseReferenceSource ?? ""] ?? "Display reference derived from the linked evidence.", entry?.caseReferenceSource, true),
            detailItem("Payment attempt ID", entry?.attemptId, "The payment attempt this case was opened for.", "operator_cases.attempt_id → payment_attempts.id", true),
            detailItem("Attempt reference", attempt?.reference, "Human-readable attempt reference.", "payment_attempts.reference", true),
            detailItem("Payment link ID", attempt?.linkId, "The link whose slot counters are affected by this attempt.", "payment_attempts.link_id → payment_links.id", true),
            detailItem("Payment link key", link?.key, "Public capability key of the payment link.", "payment_links.key", true),
            detailItem("Attempt group ID", attempt?.attemptGroupId, "Groups attempts of the same customer on the same link.", "payment_attempts.attempt_group_id → attempt_groups.id", true),
            detailItem("Merchant ID", attempt?.merchantId, "Owner of the payment attempt.", "payment_attempts.merchant_id → merchants.id", true),
            detailItem("Application ID", attempt?.applicationId, "Merchant application used for the attempt.", "payment_attempts.application_id → applications.id", true),
            detailItem("Rail ID", attempt?.railId, "Rail selected for the attempt.", "payment_attempts.rail_id → rails.id", true),
            detailItem("Route ID", attempt?.routeId, "Route that connected the rail to the gateway.", "payment_attempts.route_id → rail_routes.id", true),
            detailItem("Gateway ID", attempt?.route?.gateway?.id, "Gateway of the pinned route.", "rail_routes.gateway_id → gateways.id", true),
            detailItem("Gateway version ID", attempt?.gatewayVersionId, "Immutable gateway version pinned on the attempt.", "payment_attempts.gateway_version_id → gateway_versions.id", true),
            detailItem("Gateway setting ID", attempt?.gatewayVersion?.setting?.id, "Settings row of the pinned version.", "gateway_settings.id", true),
            detailItem("Credential set ID", attempt?.credentialSetId, "Credential set pinned on the attempt.", "payment_attempts.credential_set_id → credential_sets.id", true),
            detailItem("Commission profile ID", attempt?.commissionProfileId, "Commission profile pinned on the attempt.", "payment_attempts.commission_profile_id → commission_profiles.id", true),
            detailItem("Ledger entry ID", attempt?.ledgerEntryId, "Journal entry posted for the attempt, if any.", "payment_attempts.ledger_entry_id → journal_entries.id", true),
            detailItem("Reconciliation item ID", entry?.reconciliationItemId, "Statement line attached to the case.", "operator_cases.reconciliation_item_id → reconciliation_items.id", true),
            detailItem("Reconciliation run ID", item?.runId, "Statement ingestion run that produced the item.", "reconciliation_items.run_id → reconciliation_runs.id", true),
            detailItem("Statement source ID", source?.id, "Configured source of the statement file.", "statement_sources.id", true),
            detailItem("Approval request ID", approval?.id ?? entry?.approvalRequestId, "Maker-Checker request for the current or last resolution.", "operator_cases.approval_request_id → approval_requests.id", true),
            detailItem("Assignee user ID", entry?.assigneeUserId, "Operator currently responsible for the case.", "operator_cases.assignee_user_id → users.id", true),
            detailItem("Wallet ID", link?.walletId, "Merchant wallet assigned to the payment link.", "payment_links.wallet_id → wallets.id", true),
        ];
    });

    const sections = computed(() => {
        const entry = detail.value;
        if (!entry) return [];
        const attempt = entry.attempt;
        const link = attempt?.link;
        const item = entry.reconciliationItem;
        const run = item?.run;
        const source = run?.statementSource;
        const approval = entry.approvalRequest;
        const currency = attempt?.currency ?? link?.currency ?? "LYD";
        return [
            {
                title: t("Case and ownership"),
                description: t("What the case is, who owns it and which workflow state it is in."),
                items: [
                    detailItem("Case ID", entry.id, "Primary key of operator_cases.", "operator_cases.id", true),
                    detailItem("Case reference", entry.caseRef, CASE_REFERENCE_SOURCE_HELP[entry.caseReferenceSource] ?? "Derived display reference.", entry.caseReferenceSource, true),
                    detailItem("Case type", entry.caseType, caseHelp(entry.caseType).meaning, "operator_cases.kind"),
                    detailItem("Priority", entry.priority, priorityHelp(entry.priority).meaning, "operator_cases.priority"),
                    detailItem("Case state", entry.state, caseStateHelp(entry.state).meaning, "operator_cases.state"),
                    detailItem("Assignee", entry.assigneeEmail, "Email of the assigned platform user.", "operator_cases.assignee_user_id → users.email"),
                    detailItem("Assignee user ID", entry.assigneeUserId, "Primary key of the assigned user.", "users.id", true),
                    detailItem("Opened at", formatDateTime(entry.openedAt), "When the case entered the queue.", "operator_cases.created_at"),
                    detailItem("Updated at", formatDateTime(entry.updatedAt), "Last time the case row changed.", "operator_cases.updated_at"),
                    detailItem("SLA deadline", formatDateTime(entry.slaDueAt), "Deadline for the first resolution; a business SLA, not a payment expiry.", "operator_cases.sla_due_at"),
                    detailItem("Resolution notes", entry.resolutionNotes, "Human-readable resolution recorded by the checker.", "operator_cases.resolution_notes"),
                ],
            },
            {
                title: t("Merchant and application"),
                description: t("Who the payment belongs to and which application produced it."),
                items: [
                    detailItem("Merchant ID", attempt?.merchant?.id, "Merchant primary key.", "merchants.id", true),
                    detailItem("Trade name", attempt?.merchant?.tradeName, "Name the merchant trades under.", "merchants.trade_name"),
                    detailItem("Legal name", attempt?.merchant?.legalName, "Registered legal name.", "merchants.legal_name"),
                    detailItem("Merchant status", attempt?.merchant?.status, "Current merchant lifecycle status.", "merchants.status"),
                    detailItem("KYB status", attempt?.merchant?.kybStatus, "Document verification status.", "merchants.kyb_status"),
                    detailItem("Risk tier", attempt?.merchant?.riskTier, "Merchant risk classification.", "merchants.risk_tier"),
                    detailItem("Contact email", attempt?.merchant?.contactEmail, "Merchant contact email.", "merchants.contact_email"),
                    detailItem("Contact phone", attempt?.merchant?.contactPhone, "Merchant contact phone.", "merchants.contact_phone"),
                    detailItem("Country", attempt?.merchant?.country, "Merchant country ISO code.", "merchants.country"),
                    detailItem("Application ID", attempt?.application?.id, "Application primary key.", "applications.id", true),
                    detailItem("Application name", attempt?.application?.name, "Merchant-facing application name.", "applications.name"),
                    detailItem("Application status", attempt?.application?.status, "Application lifecycle status.", "applications.status"),
                    detailItem("Assigned wallet ID", attempt?.application?.assignedWalletId, "Wallet the application settles into.", "applications.assigned_wallet_id → wallets.id", true),
                ],
            },
            {
                title: t("Payment attempt and money"),
                description: t("The payment lifecycle and the exact money that the ledger will use."),
                items: [
                    detailItem("Attempt ID", attempt?.id, "Payment attempt primary key.", "payment_attempts.id", true),
                    detailItem("Attempt reference", attempt?.reference, "Public reference of the attempt.", "payment_attempts.reference", true),
                    detailItem("Attempt status", attempt?.status, "Payment lifecycle status, separate from the case state.", "payment_attempts.status"),
                    detailItem("Attempt substatus", attempt?.substatus, "Machine detail such as AML_HOLD or SUSPENSE_SETTLEMENT.", "payment_attempts.substatus"),
                    detailItem("Environment", attempt?.env, "SANDBOX or LIVE. The attempt can never cross environments.", "payment_attempts.env"),
                    detailItem("Mode / sub-mode", [attempt?.mode, attempt?.subMode].filter(Boolean).join(" / "), "Collection mode detail pinned on the attempt.", "payment_attempts.mode, sub_mode"),
                    detailItem("Point of no return", attempt?.pointOfNoReturn ? t("Yes") : t("No"), "True once a money-moving request was sent.", "payment_attempts.point_of_no_return"),
                    detailItem("Requested amount", attempt?.requestedAmount, "Amount requested before surcharge.", "payment_attempts.requested_amount"),
                    detailItem("Surcharge", attempt?.surchargeAmount, "Extra amount charged to the payer.", "payment_attempts.surcharge_amount"),
                    detailItem("Charged amount", attempt?.totalChargedAmount, "Requested amount plus surcharge.", "payment_attempts.total_charged_amount"),
                    detailItem("Settled amount", attempt?.settledAmount, "Amount the gateway says it settled, when known.", "payment_attempts.settled_amount"),
                    detailItem("Gateway fee", attempt?.gatewayFeeAmount, "Upstream fee recorded for the attempt.", "payment_attempts.gateway_fee_amount"),
                    detailItem("Platform commission", attempt?.platformCommissionAmount, "Commission earned by the platform.", "payment_attempts.platform_commission_amount"),
                    detailItem("Net merchant amount", attempt?.netMerchantAmount, "Amount credited to the merchant before adjustments.", "payment_attempts.net_merchant_amount"),
                    detailItem("Currency", currency, "ISO currency of the attempt.", "payment_attempts.currency"),
                    detailItem("Fee bearer", attempt?.feeBearer, "Who pays the gateway fee.", "payment_attempts.fee_bearer"),
                    detailItem("Settlement target", attempt?.settlementTarget, "Where the money settles.", "payment_attempts.settlement_target"),
                    detailItem("Gateway reference", attempt?.gatewayReference, "Reference generated by the platform for the gateway.", "payment_attempts.gateway_reference"),
                    detailItem("Provider reference", attempt?.providerReference, "Reference returned by the gateway or bank.", "payment_attempts.provider_reference"),
                    detailItem("Network reference", attempt?.networkReference, "Card or network reference when supplied.", "payment_attempts.network_reference"),
                    detailItem("Created at", formatDateTime(attempt?.createdAt), "When the attempt was created.", "payment_attempts.created_at"),
                    detailItem("Expires at", formatDateTime(attempt?.expiresAt), "Platform expiry of the attempt.", "payment_attempts.expires_at"),
                    detailItem("Terminal at", formatDateTime(attempt?.terminalAt), "When the attempt became terminal.", "payment_attempts.terminal_at"),
                    detailItem("Next check at", formatDateTime(attempt?.nextCheckAt), "Next scheduled background inquiry.", "payment_attempts.next_check_at"),
                    detailItem("Ledger entry ID", attempt?.ledgerEntryId, "Journal entry that booked the attempt.", "payment_attempts.ledger_entry_id → journal_entries.id", true),
                ],
            },
            {
                title: t("Route, gateway and slot"),
                description: t("Which rail, route and pinned gateway handled the payment, and what the link slot looks like."),
                items: [
                    detailItem("Rail ID", attempt?.rail?.id, "Rail primary key.", "rails.id", true),
                    detailItem("Rail code", attempt?.rail?.code, "Stable rail code.", "rails.code"),
                    detailItem("Rail name", attempt?.rail?.nameEn, "English rail name.", "rails.name_en"),
                    detailItem("Collection mode", attempt?.rail?.collectionMode, "How the payer interacts with the rail.", "rails.collection_mode"),
                    detailItem("Route ID", attempt?.route?.id, "Route primary key.", "rail_routes.id", true),
                    detailItem("Route status", attempt?.route?.status, "ACTIVE, PAUSED or DRAINING.", "rail_routes.status"),
                    detailItem("Route health", attempt?.route?.healthState, "Current route health sample.", "rail_routes.health_state"),
                    detailItem("Gateway ID", attempt?.route?.gateway?.id, "Gateway primary key.", "gateways.id", true),
                    detailItem("Gateway code", attempt?.route?.gateway?.code, "Stable gateway code.", "gateways.code"),
                    detailItem("Gateway name", attempt?.route?.gateway?.name, "Gateway display name.", "gateways.name"),
                    detailItem("Gateway kind", attempt?.route?.gateway?.kind, "DIRECT, AGGREGATOR, NATIVE_ADAPTER or INTERNAL.", "gateways.kind"),
                    detailItem("Gateway version ID", attempt?.gatewayVersion?.id, "Pinned gateway version.", "gateway_versions.id", true),
                    detailItem("Gateway version", attempt?.gatewayVersion?.versionNumber, "Monotonic version number.", "gateway_versions.version_number"),
                    detailItem("Gateway version state", attempt?.gatewayVersion?.state, "DRAFT, LIVE, etc.", "gateway_versions.state"),
                    detailItem("Gateway setting ID", attempt?.gatewayVersion?.setting?.id, "Settings row of the pinned version.", "gateway_settings.id", true),
                    detailItem(
                        "Status inquiry support",
                        attempt?.gatewayVersion?.setting?.supportsStatusCheck ? t("Supported") : t("Not supported"),
                        attempt?.gatewayVersion?.setting?.supportsStatusCheck
                            ? "The pinned gateway version can be asked for a definitive payment status."
                            : INQUIRY_REASON_HELP.GATEWAY_HAS_NO_STATUS_INQUIRY,
                        "gateway_settings.supports_status_check",
                    ),
                    detailItem("Gateway timeout", attempt?.gatewayVersion?.setting?.timeoutMs, "HTTP timeout of the pinned version.", "gateway_settings.timeout_ms"),
                    detailItem("Link ID", link?.id, "Payment link primary key.", "payment_links.id", true),
                    detailItem("Link key", link?.key, "Public capability key.", "payment_links.key", true),
                    detailItem("Link state", link?.state, "PENDING, COMPLETED, EXPIRED or CANCELLED.", "payment_links.state"),
                    detailItem("Link usage", link ? `${link.confirmedCount}/${link.useCount}` : "", "Confirmed slots / total slots.", "payment_links.confirmed_count, use_count"),
                    detailItem("Active locks", link?.activeLockedCount, "Attempts currently holding a reservation.", "payment_links.active_locked_count"),
                    detailItem("Infinite use", link?.infiniteUse ? t("Yes") : t("No"), "Whether the link has unlimited slots.", "payment_links.infinite_use"),
                    detailItem("Wallet ID", link?.walletId, "Wallet assigned to the link.", "payment_links.wallet_id → wallets.id", true),
                ],
            },
            {
                title: t("Reconciliation and statement"),
                description: t("The evidence produced by statement ingestion, when the case came from reconciliation."),
                items: [
                    detailItem("Reconciliation item ID", item?.id ?? entry.reconciliationItemId, "Statement line primary key.", "reconciliation_items.id", true),
                    detailItem("Result", item?.result, reconciliationHelp(item?.result)?.meaning, "reconciliation_items.result"),
                    detailItem("Our reference", item?.ourReference, "Platform reference matched by the statement.", "reconciliation_items.our_reference"),
                    detailItem("Provider reference", item?.providerReference, "Gateway reference matched by the statement.", "reconciliation_items.provider_reference"),
                    detailItem("Statement amount", item?.statementAmount, "Amount reported by the statement.", "reconciliation_items.statement_amount"),
                    detailItem("Statement fee", item?.statementFee, "Fee reported by the statement.", "reconciliation_items.statement_fee"),
                    detailItem("Run ID", item?.runId, "Reconciliation run primary key.", "reconciliation_runs.id", true),
                    detailItem("File name", run?.fileName, "Uploaded statement file name.", "reconciliation_runs.file_name"),
                    detailItem("Window", run ? `${formatDateTime(run.windowStart)} → ${formatDateTime(run.windowEnd)}` : "", "Statement window.", "reconciliation_runs.window_start, window_end"),
                    detailItem("File hash", run?.fileHash, "SHA-256 idempotency hash of the statement.", "reconciliation_runs.file_hash", true),
                    detailItem("Statement source ID", source?.id, "Configured statement source.", "statement_sources.id", true),
                    detailItem("Statement source type", source?.type, "API, SFTP or UPLOAD.", "statement_sources.type"),
                    detailItem("Settlement lag", source?.settlementLagDays, "Expected T+N lag for this gateway.", "statement_sources.settlement_lag_days"),
                    detailItem("Statement gateway", source?.gateway?.code, "Gateway the statement belongs to.", "statement_sources.gateway_id → gateways.code"),
                ],
            },
            {
                title: t("Resolution and approval"),
                description: t("The Maker-Checker proposal, who made it and who checked it. No attempt or ledger change happens before approval."),
                items: [
                    detailItem("Approval request ID", approval?.id ?? entry.approvalRequestId, "Maker-Checker request primary key.", "approval_requests.id", true),
                    detailItem("Approval state", approval?.state ?? entry.approvalState, "DRAFT, PENDING_REVIEW, APPROVED, EXECUTED or REJECTED.", "approval_requests.state"),
                    detailItem("Action", approvalPayload(approval?.payloadDiffJson).action, "The resolution action proposed by the maker.", "approval_requests.payload_diff_json.action"),
                    detailItem("Proposed reason", approvalPayload(approval?.payloadDiffJson).reason, "Why the maker proposed this outcome.", "approval_requests.payload_diff_json.reason"),
                    detailItem("Proposed notes", approvalPayload(approval?.payloadDiffJson).notes, "Additional maker notes.", "approval_requests.payload_diff_json.notes"),
                    detailItem("Provider reference", approvalPayload(approval?.payloadDiffJson).providerReference, "Evidence reference supplied with the proposal.", "approval_requests.payload_diff_json.providerReference"),
                    detailItem("Maker user ID", approval?.makerUserId, "User who proposed the resolution.", "approval_requests.maker_user_id → users.id", true),
                    detailItem("Maker email", approval?.maker?.email, "Email of the maker.", "users.email"),
                    detailItem("Checker user ID", approval?.checkerUserId, "User who approved or rejected the resolution.", "approval_requests.checker_user_id → users.id", true),
                    detailItem("Checker email", approval?.checker?.email, "Email of the checker.", "users.email"),
                    detailItem("Rejection reason", approval?.rejectionReason, "Why the checker rejected the proposal.", "approval_requests.rejection_reason"),
                    detailItem("Approval created", formatDateTime(approval?.createdAt), "When the proposal was created.", "approval_requests.created_at"),
                    detailItem("Approval expires", formatDateTime(approval?.expiresAt), "When the proposal stops being actionable.", "approval_requests.expires_at"),
                ],
            },
        ];
    });

    const timeline = computed(() => {
        const entry = detail.value;
        if (!entry) return [];
        const items: Array<{ at: string; title: string; detail: string; tone: string }> = [
            {
                at: entry.openedAt,
                title: t("Case opened"),
                detail: `${entry.caseType} · ${entry.priority}`,
                tone: "warning",
            },
        ];
        if (entry.approvalRequest?.createdAt) {
            items.push({
                at: entry.approvalRequest.createdAt,
                title: t("Resolution proposed"),
                detail: asText(approvalPayload(entry.approvalRequest.payloadDiffJson).action),
                tone: "info",
            });
        }
        for (const log of entry.attempt?.stepLogs ?? []) {
            items.push({
                at: log.createdAt,
                title: `${log.phase}${log.stepId ? ` · ${log.stepId}` : ""}`,
                detail: `${log.outcome}${log.httpStatus ? ` · HTTP ${log.httpStatus}` : ""}${log.durationMs ? ` · ${log.durationMs}ms` : ""}`,
                tone: statusTone(log.outcome) === "error" ? "error" : "primary",
            });
        }
        for (const event of entry.attempt?.inboundEvents ?? []) {
            items.push({
                at: event.receivedAt,
                title: t("Inbound event"),
                detail: `${event.verified ? t("Verified") : t("Unverified")} · ${event.processingResult ?? "—"}`,
                tone: event.verified ? "success" : "warning",
            });
        }
        for (const audit of entry.auditTrail ?? []) {
            items.push({
                at: audit.createdAt,
                title: audit.action,
                detail: `${audit.actor?.email ?? audit.actorId} · ${audit.role}`,
                tone: "info",
            });
        }
        return items
            .filter((item) => Boolean(item.at))
            .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
    });

    const preStyle = {
        margin: 0,
        padding: "10px 12px",
        borderRadius: "var(--pg-radius-md)",
        background: "var(--pg-bg-surface-subtle)",
        fontSize: "11px",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap" as const,
        wordBreak: "break-word" as const,
        direction: "ltr" as const,
        unicodeBidi: "isolate" as const,
        maxHeight: "320px",
        overflow: "auto" as const,
    };

    const renderAttempt = () => {
        const attempt = detail.value?.attempt;
        if (!attempt) {
            return (
                <VAlert type="info" variant="tonal">
                    {t("This case has no linked payment attempt. It is resolved from reconciliation or manual evidence.")}
                </VAlert>
            );
        }
        return null;
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={`${t("Operator Case")} ${caseRef.value}`}
                    subtitle={t("Inspect the case, evidence, identifiers and maker-checker resolution path.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => router.push({ name: "OperatorCases" })}>
                                {t("Back")}
                            </VBtn>
                            {canWrite.value && !isResolved.value && !isPendingChecker.value && (
                                <>
                                    <VBtn variant="tonal" loading={actionLoading.value} onClick={() => void assignToMe()}>
                                        {t("Assign to me")}
                                    </VBtn>
                                    {detail.value?.state === "OPEN" && (
                                        <VBtn variant="tonal" loading={actionLoading.value} onClick={() => void startWork()}>
                                            {t("Start working")}
                                        </VBtn>
                                    )}
                                    <span title={INQUIRY_REASON_HELP[inquiry.value?.reason ?? ""] ?? t("Inquiry is not available")}>
                                        <VBtn
                                            variant="tonal"
                                            color="primary"
                                            prependIcon="mdi-radar"
                                            loading={actionLoading.value}
                                            disabled={!inquiry.value?.eligible || !canInquire.value}
                                            onClick={() => void inquire()}
                                        >
                                            {t("Inquire Gateway Now")}
                                        </VBtn>
                                    </span>
                                    <VBtn color="primary" onClick={openResolve}>
                                        {t("Propose resolution")}
                                    </VBtn>
                                </>
                            )}
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : !detail.value ? (
                    <StateView empty={true} emptyTitle={t("Case not found")} />
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <span title={caseHelp(detail.value.caseType).meaning}>
                                <StatusBadge status={detail.value.caseType} label={detail.value.caseType} toneOverride={
                                    detail.value.caseType === "CONFLICT" || detail.value.caseType === "LATE_SUCCESS"
                                        ? "danger"
                                        : detail.value.caseType === "UNKNOWN" || detail.value.caseType === "MISMATCH"
                                          ? "warning"
                                          : "info"
                                } />
                            </span>
                            <span title={priorityHelp(detail.value.priority).meaning}>
                                <StatusBadge status={detail.value.priority} label={detail.value.priority} toneOverride={asBadgeTone(statusTone(detail.value.priority))} />
                            </span>
                            <span title={caseStateHelp(detail.value.state).meaning}>
                                <StatusBadge status={detail.value.state} label={detail.value.state} toneOverride={asBadgeTone(statusTone(detail.value.state))} />
                            </span>
                            <StatusBadge status={sla.value.label} label={sla.value.label} toneOverride={asBadgeTone(sla.value.tone)} />
                            {statusLabel.value && (
                                <StatusBadge status={statusLabel.value} label={`${t("Attempt")}: ${statusLabel.value}`} toneOverride={asBadgeTone(statusTone(statusLabel.value))} />
                            )}
                        </ThemedView>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                    {t("Workflow")}
                                </ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                    {["OPEN", "IN_PROGRESS", "PENDING_CHECKER", "RESOLVED"].map((state, index) => (
                                        <ThemedView key={state} style={{ flexDirection: "row", alignItems: "center", gap: "6px" }}>
                                            <StatusBadge
                                                status={state}
                                                label={state}
                                                toneOverride={detail.value?.state === state ? asBadgeTone(statusTone(state)) : "neutral"}
                                            />
                                            {index < 3 && <VIcon icon="mdi-chevron-right" size={16} style={{ opacity: 0.35 }} />}
                                        </ThemedView>
                                    ))}
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.6, marginInlineStart: "8px" }}>
                                        {caseStateHelp(detail.value.state).meaning}
                                    </ThemedText>
                                </ThemedView>
                            </SurfaceCardText>
                        </SurfaceCard>

                        {detail.value.inquirySchedules && detail.value.inquirySchedules.length > 0 && (
                            <SurfaceCard>
                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Gateway inquiry schedule")}</ThemedText>
                                        <VBtn size="small" variant="text" prependIcon="mdi-radar" onClick={() => void router.push({ name: "GatewayInquirySchedules" })}>
                                            {t("Open inquiry schedule")}
                                        </VBtn>
                                    </ThemedView>
                                    {detail.value.inquirySchedules.slice(0, 3).map((schedule) => (
                                        <ThemedView key={schedule.id} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--pg-border-subtle)", paddingBottom: "7px" }}>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                                                <StatusBadge status={String(schedule.status)} label={String(schedule.status).replaceAll("_", " ")} toneOverride={asBadgeTone(statusTone(schedule.status))} />
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Scheduled")}: {formatDateTime(schedule.scheduledAt ?? schedule.createdAt)}</ThemedText>
                                                {(schedule.isOverdue ?? (["SCHEDULED", "RETRYING", "RUNNING"].includes(String(schedule.status)) && Boolean(schedule.nextRunAt) && new Date(String(schedule.nextRunAt)).getTime() <= Date.now())) && <StatusBadge status="Overdue" label={t("Overdue")} toneOverride="warning" />}
                                            </ThemedView>
                                            <ThemedView style={{ gap: "2px", alignItems: "flex-end" }}>
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.7 }}>{t("Next run")}: {formatDateTime(schedule.nextRunAt)}</ThemedText>
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{schedule.attempts} {t("attempts")}</ThemedText>
                                            </ThemedView>
                                        </ThemedView>
                                    ))}
                                </SurfaceCardText>
                            </SurfaceCard>
                        )}

                        <MetricStrip items={stats.value} />

                        {isPendingChecker.value && (
                            <VAlert type="info" variant="tonal">
                                {t("A resolution is waiting for a different checker. The attempt and the ledger have not been changed yet.")}
                            </VAlert>
                        )}
                        {isResolved.value && (
                            <VAlert type="success" variant="tonal">
                                {t("This case is resolved. The resolution notes below record the approved outcome.")}
                            </VAlert>
                        )}
                        {!inquiry.value?.eligible && !isResolved.value && !isPendingChecker.value && (
                            <VAlert type="warning" variant="tonal">
                                {INQUIRY_REASON_HELP[inquiry.value?.reason ?? ""] ?? t("Gateway inquiry is not available")}
                            </VAlert>
                        )}
                        {sla.value.tone === "error" && !isResolved.value && (
                            <VAlert type="error" variant="tonal">
                                {t("The SLA deadline has passed. Prioritise this case and document the reason for the delay.")}
                            </VAlert>
                        )}

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                    {t("What this case means")}
                                </ThemedText>
                                {narrative.value && (
                                    <ThemedView style={{ gap: "12px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>
                                            {narrative.value.title}
                                        </ThemedText>
                                        <ThemedView style={{ gap: "4px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("What happened")}</ThemedText>
                                            <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>{narrative.value.happened}</ThemedText>
                                        </ThemedView>
                                        <ThemedView style={{ gap: "4px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Why it matters")}</ThemedText>
                                            <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>{narrative.value.matters}</ThemedText>
                                        </ThemedView>
                                        <ThemedView style={{ gap: "4px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("What to do next")}</ThemedText>
                                            <ThemedText style={{ fontSize: "13px", lineHeight: 1.6 }}>{narrative.value.next}</ThemedText>
                                        </ThemedView>
                                    </ThemedView>
                                )}
                            </SurfaceCardText>
                        </SurfaceCard>

                        {renderAttempt()}

                        {sections.value.map((section) => (
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

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                    {t("Approval decision")}
                                </ThemedText>
                                {detail.value.approvalRequest ? (
                                    <>
                                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                            <StatusBadge
                                                status={detail.value.approvalRequest.state}
                                                label={detail.value.approvalRequest.state}
                                                toneOverride={asBadgeTone(statusTone(detail.value.approvalRequest.state))}
                                            />
                                            <StatusBadge
                                                status={asText(approvalPayload(detail.value.approvalRequest.payloadDiffJson).action) || "—"}
                                                label={asText(approvalPayload(detail.value.approvalRequest.payloadDiffJson).action) || "—"}
                                                toneOverride="info"
                                            />
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.75 }}>
                                            {t("Maker")}: {detail.value.approvalRequest.maker?.email ?? detail.value.approvalRequest.makerUserId ?? "—"}
                                            {" · "}
                                            {t("Checker")}: {detail.value.approvalRequest.checker?.email ?? detail.value.approvalRequest.checkerUserId ?? "—"}
                                        </ThemedText>
                                        {detail.value.approvalRequest.state === "PENDING_REVIEW" && canCheck.value && (
                                            <ThemedView style={{ gap: "10px" }}>
                                                <FormField
                                                    label={t("Checker note")}
                                                    hint={t("Required when rejecting; optional when approving.")}
                                                >
                                                    <VTextarea
                                                        modelValue={checkerReason.value}
                                                        onUpdate:modelValue={(value: string) => (checkerReason.value = value)}
                                                        rows={2}
                                                    />
                                                </FormField>
                                                <ThemedView style={{ flexDirection: "row", gap: "10px" }}>
                                                    <VBtn
                                                        color="success"
                                                        loading={actionLoading.value}
                                                        onClick={() => void decideApproval(true)}
                                                    >
                                                        {t("Approve and execute")}
                                                    </VBtn>
                                                    <VBtn
                                                        color="error"
                                                        variant="tonal"
                                                        loading={actionLoading.value}
                                                        onClick={() => void decideApproval(false)}
                                                    >
                                                        {t("Reject")}
                                                    </VBtn>
                                                </ThemedView>
                                            </ThemedView>
                                        )}
                                        {detail.value.approvalRequest.state === "PENDING_REVIEW" && !canCheck.value && (
                                            <ThemedText style={{ fontSize: "13px", opacity: 0.65 }}>
                                                {t("Waiting for an eligible checker. A maker can never approve their own proposal.")}
                                            </ThemedText>
                                        )}
                                    </>
                                ) : (
                                    <ThemedText style={{ fontSize: "13px", opacity: 0.65 }}>
                                        {t("No Maker-Checker proposal has been created for this case yet.")}
                                    </ThemedText>
                                )}
                            </SurfaceCardText>
                        </SurfaceCard>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                    {t("Recorded timeline")}
                                </ThemedText>
                                {timeline.value.length === 0 ? (
                                    <EmptyState title={t("No timeline events recorded")} icon="mdi-timeline-clock-outline" />
                                ) : (
                                    <VTimeline density="compact" side="end">
                                        {timeline.value.map((item, index) => (
                                            <VTimelineItem
                                                key={`${item.at}-${index}`}
                                                dotColor={item.tone === "error" ? "error" : item.tone === "success" ? "success" : "primary"}
                                                size="x-small"
                                            >
                                                <ThemedView style={{ gap: "2px", paddingBottom: "8px" }}>
                                                    <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>{item.title}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                                        {formatDateTime(item.at)} · {item.detail}
                                                    </ThemedText>
                                                </ThemedView>
                                            </VTimelineItem>
                                        ))}
                                    </VTimeline>
                                )}
                            </SurfaceCardText>
                        </SurfaceCard>

                        <VExpansionPanels multiple>
                            <VExpansionPanel value="step-logs">
                                <VExpansionPanelTitle>
                                    {t("Gateway step logs")} ({(detail.value.attempt?.stepLogs ?? []).length})
                                </VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    {(detail.value.attempt?.stepLogs ?? []).length === 0 ? (
                                        <EmptyState title={t("No step logs recorded")} icon="mdi-script-text-outline" />
                                    ) : (
                                        (detail.value.attempt?.stepLogs ?? []).map((log) => (
                                            <SurfaceCard key={log.id} variant="outlined" style={{ marginBottom: "10px" }}>
                                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>
                                                        {formatDateTime(log.createdAt)} · {log.phase} · {log.stepId ?? "—"} · HTTP {log.httpStatus ?? "—"} · {log.durationMs ?? "—"}ms · {log.outcome}
                                                    </ThemedText>
                                                    <ThemedText style={{ fontSize: "12px" }}>
                                                        {t("Step log ID")}: {log.id} · {t("Gateway version ID")}: {log.gatewayVersionId} · {t("Step ID")}: {log.stepId ?? "—"} · {t("Order")}: {log.stepOrder}
                                                    </ThemedText>
                                                    <ThemedView style={{ gap: "4px" }}>
                                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{t("Redacted request")}</ThemedText>
                                                        <pre style={preStyle}>{jsonText(log.redactedRequestJson)}</pre>
                                                    </ThemedView>
                                                    <ThemedView style={{ gap: "4px" }}>
                                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{t("Redacted response")}</ThemedText>
                                                        <pre style={preStyle}>{log.redactedResponseText}</pre>
                                                    </ThemedView>
                                                </SurfaceCardText>
                                            </SurfaceCard>
                                        ))
                                    )}
                                </VExpansionPanelText>
                            </VExpansionPanel>

                            <VExpansionPanel value="inbound-events">
                                <VExpansionPanelTitle>
                                    {t("Inbound webhooks")} ({(detail.value.attempt?.inboundEvents ?? []).length})
                                </VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    {(detail.value.attempt?.inboundEvents ?? []).length === 0 ? (
                                        <EmptyState title={t("No inbound events recorded")} icon="mdi-webhook" />
                                    ) : (
                                        (detail.value.attempt?.inboundEvents ?? []).map((event) => (
                                            <SurfaceCard key={event.id} variant="outlined" style={{ marginBottom: "10px" }}>
                                                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>
                                                        {formatDateTime(event.receivedAt)} · {event.verified ? t("Verified") : t("Unverified")} · {event.processingResult ?? t("Unprocessed")}
                                                    </ThemedText>
                                                    <ThemedText style={{ fontSize: "12px" }}>
                                                        {t("Event ID")}: {event.id} · {t("Channel ID")}: {event.channelId} · {t("Gateway ID")}: {event.gatewayId} · {t("Attempt ID")}: {event.attemptId ?? "—"} · {t("Source IP")}: {event.sourceIp}
                                                    </ThemedText>
                                                    <ThemedText style={{ fontSize: "12px" }}>
                                                        {t("Dedupe key")}: {event.dedupeKey} · {t("Received")}: {formatDateTime(event.receivedAt)} · {t("Processed")}: {formatDateTime(event.processedAt)}
                                                    </ThemedText>
                                                    {event.verificationError && (
                                                        <ThemedText style={{ fontSize: "12px", color: "var(--pg-status-danger-text)" }}>
                                                            {t("Verification error")}: {event.verificationError}
                                                        </ThemedText>
                                                    )}
                                                    <ThemedView style={{ gap: "4px" }}>
                                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{t("Redacted headers")}</ThemedText>
                                                        <pre style={preStyle}>{jsonText(event.redactedHeadersJson)}</pre>
                                                    </ThemedView>
                                                    <ThemedView style={{ gap: "4px" }}>
                                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{t("Raw body preview")}</ThemedText>
                                                        <pre style={preStyle}>{event.rawBodyPreview || "—"}</pre>
                                                    </ThemedView>
                                                </SurfaceCardText>
                                            </SurfaceCard>
                                        ))
                                    )}
                                </VExpansionPanelText>
                            </VExpansionPanel>

                            <VExpansionPanel value="related">
                                <VExpansionPanelTitle>
                                    {t("Adjustments and disputes")} ({(detail.value.attempt?.adjustments ?? []).length + (detail.value.attempt?.disputes ?? []).length})
                                </VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    {(detail.value.attempt?.adjustments ?? []).map((adjustment) => {
                                        const row = adjustment as Record<string, unknown>;
                                        return (
                                            <ThemedText key={String(row.id)} style={{ fontSize: "12px", display: "block", marginBottom: "6px" }}>
                                                {t("Adjustment")} {asText(row.id)} · {asText(row.type)} · {asText(row.state)} · {asText(row.amount)} {detail.value?.attempt?.currency ?? ""} · {t("Journal")}: {asText(row.journalEntryId) || "—"}
                                            </ThemedText>
                                        );
                                    })}
                                    {(detail.value.attempt?.disputes ?? []).map((dispute) => {
                                        const row = dispute as Record<string, unknown>;
                                        return (
                                            <ThemedText key={String(row.id)} style={{ fontSize: "12px", display: "block", marginBottom: "6px" }}>
                                                {t("Dispute")} {asText(row.id)} · {asText(row.status)} · {asText(row.amount)} {asText(row.currency)} · {asText(row.externalDisputeRef)}
                                            </ThemedText>
                                        );
                                    })}
                                    {(detail.value.attempt?.adjustments ?? []).length === 0 && (detail.value.attempt?.disputes ?? []).length === 0 && (
                                        <EmptyState title={t("No adjustments or disputes")} icon="mdi-scale-balance" />
                                    )}
                                </VExpansionPanelText>
                            </VExpansionPanel>

                            <VExpansionPanel value="audit">
                                <VExpansionPanelTitle>
                                    {t("Audit trail")} ({(detail.value.auditTrail ?? []).length})
                                </VExpansionPanelTitle>
                                <VExpansionPanelText>
                                    {(detail.value.auditTrail ?? []).map((audit) => (
                                        <ThemedView
                                            key={audit.id}
                                            style={{
                                                gap: "3px",
                                                padding: "8px 0",
                                                borderBottom: "1px solid var(--pg-border-subtle)",
                                            }}
                                        >
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>
                                                {formatDateTime(audit.createdAt)} · {audit.action}
                                            </ThemedText>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.7 }}>
                                                {audit.actor?.email ?? audit.actorId} · {audit.role} · {t("Audit ID")}: {audit.id} · {t("Approval ID")}: {audit.approvalRequestId ?? "—"}
                                            </ThemedText>
                                            <JsonDiffViewer diff={{ before: audit.beforeJson, after: audit.afterJson }} />
                                        </ThemedView>
                                    ))}
                                    {(detail.value.auditTrail ?? []).length === 0 && (
                                        <EmptyState title={t("No audit entries recorded")} icon="mdi-history" />
                                    )}
                                </VExpansionPanelText>
                            </VExpansionPanel>
                        </VExpansionPanels>

                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                    {t("All identifiers")}
                                </ThemedText>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                    {t("Every identifier is shown with the entity and database source it belongs to. Click an id to copy it.")}
                                </ThemedText>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Database identifiers")}</ThemedText>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                    {t("Use these exact ids when cross-referencing the database, logs or support tickets.")}
                                </ThemedText>
                                <DescriptionList columns={2} items={identifierItems.value} />
                            </SurfaceCardText>
                        </SurfaceCard>

                    </>
                )}
            </ThemedView>

            <FormModal
                modelValue={resolveOpen.value}
                onUpdate:modelValue={(value: boolean | null) => (resolveOpen.value = Boolean(value))}
                title={t("Propose resolution")}
                size="md"
                onSubmit={() => void proposeResolution()}
                submitLabel={t("Submit to checker")}
                cancelLabel={t("Cancel")}
                loading={actionLoading.value}
            >
                <VAlert type="info" variant="tonal">
                    {t("This creates a Maker-Checker proposal. A different checker must approve it before the attempt or ledger changes.")}
                </VAlert>
                <FormField label={t("Resolution action")} required>
                    <VSelect
                        items={actionOptions.value}
                        modelValue={resolveAction.value}
                        onUpdate:modelValue={(value: string) => (resolveAction.value = value)}
                    />
                </FormField>
                {resolveAction.value === "MARK_SUCCEEDED" && (
                    <>
                        <FormField
                            label={t("Provider reference")}
                            hint={t("Required. The gateway or bank reference that proves the payment.")}
                            required
                        >
                            <VTextField
                                modelValue={providerReference.value}
                                onUpdate:modelValue={(value: string) => (providerReference.value = value)}
                            />
                        </FormField>
                        <FormField
                            label={t("Settled amount")}
                            hint={t("Must equal the charged amount. Use the reconciliation adjustment flow for a mismatch.")}
                        >
                            <VTextField
                                modelValue={settledAmount.value}
                                onUpdate:modelValue={(value: string) => (settledAmount.value = value)}
                            />
                        </FormField>
                    </>
                )}
                <FormField
                    label={t("Reason")}
                    hint={t("Minimum 3 characters. This becomes part of the permanent case record.")}
                    required
                >
                    <VTextarea
                        modelValue={resolveReason.value}
                        onUpdate:modelValue={(value: string) => (resolveReason.value = value)}
                        rows={3}
                    />
                </FormField>
                <FormField label={t("Additional notes")} hint={t("Optional evidence notes for the checker.")}>
                    <VTextarea
                        modelValue={resolveNotes.value}
                        onUpdate:modelValue={(value: string) => (resolveNotes.value = value)}
                        rows={2}
                    />
                </FormField>
                {showChecklists && (
                    <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Resolution checklist")}</ThemedText>
                        {RESOLVE_CHECKS.map((check) => (
                            <VCheckbox
                                key={check.key}
                                modelValue={resolveChecklist.value[check.key] === true}
                                onUpdate:modelValue={(value: unknown) => (resolveChecklist.value = { ...resolveChecklist.value, [check.key]: Boolean(value) })}
                                label={t(check.label)}
                                density="compact"
                                hideDetails
                            />
                        ))}
                        {!resolveChecklistComplete.value && (
                            <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all resolution checklist items before submitting")}</ThemedText>
                        )}
                    </ThemedView>
                )}
            </FormModal>
        </ScreenContainer>
    );
});

export default OperatorCaseDetailPage;
