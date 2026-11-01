import type { StatusTone } from "@/components/StatusChip";

export const COLUMN_HELP = {
    merchant: "Legal and trade identity of the merchant. The DB ID is the stable reference used by every audit row.",
    status: "Merchant lifecycle state: PENDING, ACTIVE, SUSPENDED, REJECTED or CLOSED.",
    kyb: "KYB verification state derived from the accepted, unexpired required documents and beneficial-owner checks.",
    risk: "Risk tier used by routing, monitoring and four-eyes policy.",
    category: "Business category. This is a sensitive descriptive field used by the required-document policy.",
    country: "Two-letter country code of the merchant.",
    channel: "SELF_SERVICE means the merchant registered; ADMIN_ASSISTED means an operator prepared the package.",
    contact: "Merchant contact details. Contact changes are treated as sensitive until the new address is verified.",
    counts: "Wallet, application, user and token counts for quick operational context.",
    request: "Latest join request and its current state.",
    review: "Next periodic KYB review date.",
    lifecycleAt: "Activation, suspension or closure timestamp.",
    pending: "Sensitive maker-checker changes waiting for an independent checker.",
    actions: "Open the merchant 360, start a lifecycle action, or propose an edit.",
    transactionReference: "Payment attempt reference. Open it for the full masked transaction context and linked operator cases.",
    transactionCreated: "Time the payment attempt was created.",
    transactionStatus: "Attempt lifecycle status. UNKNOWN and VERIFYING attempts may still be inquired if the pinned gateway supports status checks.",
    transactionApplication: "Merchant application that created the payment attempt.",
    transactionRail: "Rail and gateway selected for the attempt.",
    transactionAmount: "Total charged amount. Hidden for support and restricted roles.",
    transactionNet: "Net merchant amount, gateway fee and platform commission. Visible to financial roles only.",
    transactionProvider: "Provider or network reference returned by the gateway. Hidden for support.",
    transactionCase: "Operator case linked to the attempt. Open the case from the transaction detail dialog.",
    applicationName: "Merchant application and stable application ID.",
    applicationStatus: "Application lifecycle state. Suspended or closed applications cannot start new payments.",
    applicationLinks: "Number of payment links and access tokens under the application.",
    applicationRails: "Rail whitelist mode. ALL means every rail, NONE means no rail, LIST shows the configured count.",
    applicationDomains: "Number of redirect domains allowed for this application.",
    applicationVolume: "Merchant-declared expected monthly volume. Hidden for support.",
    walletId: "Stable wallet identifier and its ledger account.",
    walletBalance: "Balance derived from checkpoint plus posted journal lines. Hidden without financial access.",
    walletCheckpoint: "Last ledger checkpoint balance before posted lines are applied.",
    walletCashouts: "Pending cash-outs / total cash-outs for the wallet.",
    cashoutDestination: "Masked destination bank details. Full payment details stay in the finance cash-out queue.",
    disputeReason: "Gateway reason code for the dispute.",
    adjustmentReason: "Maker reason recorded on the adjustment.",
    notificationRecipient: "Masked recipient address. Message payloads are never shown on the merchant page.",
};

export const MERCHANT_STATUS_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    PENDING: { label: "Pending", meaning: "Onboarding is not complete; live payments are blocked.", tone: "warning" },
    ACTIVE: { label: "Active", meaning: "The merchant is activated and live payments are allowed subject to guards.", tone: "success" },
    SUSPENDED: { label: "Suspended", meaning: "New live payments are blocked while the suspension is investigated or a reinstatement is approved.", tone: "error" },
    REJECTED: { label: "Rejected", meaning: "The onboarding request was rejected. The merchant may re-apply with a new join request.", tone: "error" },
    CLOSED: { label: "Closed", meaning: "The relationship is closed. The merchant is read-only and closed accounts cannot transact.", tone: "neutral" },
};

export const KYB_STATUS_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    UNVERIFIED: { label: "Unverified", meaning: "Evidence has not been verified yet.", tone: "neutral" },
    PENDING: { label: "Pending", meaning: "KYB evidence is being collected or re-verification is due.", tone: "warning" },
    VERIFIED: { label: "Verified", meaning: "Required KYB evidence and owner checks are complete.", tone: "success" },
    REJECTED: { label: "Rejected", meaning: "KYB evidence was rejected or the merchant is not eligible.", tone: "error" },
};

export const RISK_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    LOW: { label: "Low", meaning: "Low-risk monitoring and review cadence.", tone: "success" },
    STANDARD: { label: "Standard", meaning: "Standard risk monitoring and review cadence.", tone: "info" },
    HIGH: { label: "High", meaning: "Enhanced monitoring and more frequent review.", tone: "error" },
};

export const SUSPENSION_REASONS = [
    { title: "AML / compliance", value: "AML" },
    { title: "Fraud", value: "FRAUD" },
    { title: "KYB expired", value: "KYB_EXPIRED" },
    { title: "Commission ceiling", value: "COMMISSION_CEILING" },
    { title: "Merchant request", value: "MERCHANT_REQUEST" },
    { title: "Other", value: "OTHER" },
];

export const CLOSE_REASONS = [
    { title: "Merchant request", value: "MERCHANT_REQUEST" },
    { title: "Compliance decision", value: "COMPLIANCE" },
    { title: "Business closed", value: "BUSINESS_CLOSED" },
    { title: "Other", value: "OTHER" },
];

export const SENSITIVE_FIELDS = [
    "legalName",
    "taxId",
    "registrationNo",
    "businessCategory",
    "payoutBankDetailsJson",
    "riskTier",
    "kybStatus",
    "commissionReceivableCeiling",
    "negativeBalanceCeiling",
    "contactEmail",
    "contactPhone",
];

export const merchantStatusHelp = (status: string) =>
    MERCHANT_STATUS_HELP[status] ?? { label: status, meaning: "Unknown merchant status.", tone: "neutral" as StatusTone };

export const kybStatusHelp = (status: string) =>
    KYB_STATUS_HELP[status] ?? { label: status, meaning: "Unknown KYB status.", tone: "neutral" as StatusTone };

export const riskHelp = (risk: string) =>
    RISK_HELP[risk] ?? { label: risk, meaning: "Unknown risk tier.", tone: "neutral" as StatusTone };

export const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

export const formatMoney = (value: string | number | null | undefined, currency = "LYD"): string => {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return `${number.toFixed(4)} ${currency}`;
};

export const MERCHANT_HELP_SECTIONS = [
    {
        title: "Merchant lifecycle",
        body: "PENDING merchants are onboarding. ACTIVE merchants can transact subject to the risk guards. SUSPENDED merchants cannot start new live payments. REJECTED applicants may re-apply with a new join request. CLOSED merchants are read-only. Suspension, reinstatement and closure are sensitive lifecycle actions.",
    },
    {
        title: "Descriptive vs sensitive fields",
        body: "Trade name, display name, logo URL and support contacts are descriptive. Legal name, tax ID, registration number, business category, payout account, risk tier, KYB override and commercial ceilings are sensitive and route through maker-checker. The current value remains in force until a checker executes the change.",
    },
    {
        title: "Suspension and reinstatement",
        body: "A standard suspension waits for an independent checker. An emergency suspension takes effect immediately and must be ratified within 24 hours; the suspension remains in force even if ratification is rejected. Reinstatement always needs a compliance or MLRO checker and is never an emergency action.",
    },
    {
        title: "Support and confidentiality",
        body: "Support can read descriptive merchant data and field history. Sensitive tax, registration, payout, ceiling, risk and AML information is redacted. Support never sees an AML suspension reason or any AML case details.",
    },
    {
        title: "Financials and ledger",
        body: "Wallet balances are derived from posted journal lines, not from a mutable balance column. Pending cash-outs, disputes and 30-day volume are operational indicators and link to their own queues. The merchant page never moves money.",
    },
    {
        title: "History, pending changes and versions",
        body: "Every edit is recorded in detail_change_logs. Sensitive changes carry a base version so a stale proposal cannot overwrite a newer edit. The maker may withdraw a pending change before a checker acts.",
    },
    {
        title: "Transactions, applications and wallets",
        body: "Recent transactions are server-paginated attempts. Open a reference to see masked amounts, provider references, ledger entry and linked operator cases. Inquiries are only offered for UNKNOWN or VERIFYING attempts when the pinned gateway supports status checks. Applications show assigned wallets, links, tokens, POS terminals, rail whitelists and redirect domains. Wallet balances are derived from the ledger checkpoint plus posted journal lines; the merchant page never moves money.",
    },
    {
        title: "Cash-outs, disputes and adjustments",
        body: "Cash-outs, disputes and adjustments are read-only merchant views with filters and links to the finance queues. Cash-out destination details are masked. Disputes show evidence due dates and adjustment state. Adjustments show the source attempt, dispute reference, journal entry and state. Financial access is required.",
    },
    {
        title: "Notifications and audit trail",
        body: "Notification rows show delivery status, channel, language, attempt count and a masked recipient. Message payloads are never shown. The merchant audit trail lists lifecycle and governance events; Support sees the event and actor context, while raw before/after values are available only to sensitive-access roles.",
    },
    {
        title: "Tabs and collapsible merchant 360",
        body: "The merchant page opens on All, which shows every section in one long operational view. Use the Details, Transactions, Wallets, Applications, Finance, Compliance and Access & activity tabs to see only one area. In All, merchant profile fields and operational sections are collapsible; the page remembers open sections for the current session. Expand all / Collapse all changes only the display, never merchant data. Collapsed tables do not load until opened.",
    },
];
