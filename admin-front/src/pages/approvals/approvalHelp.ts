import type { StatusTone } from "@/components/StatusChip";

export const APPROVAL_STATE_HELP: Record<string, { label: string; meaning: string; tone: StatusTone }> = {
    DRAFT: { label: "Draft", meaning: "The maker has not submitted the request to the checker queue yet.", tone: "neutral" },
    PENDING_REVIEW: { label: "Pending review", meaning: "The request is waiting for an independent checker.", tone: "warning" },
    APPROVED: { label: "Approved", meaning: "The checker approved the request and execution is in progress or complete.", tone: "info" },
    EXECUTED: { label: "Executed", meaning: "The approved change was executed atomically and the subject is updated.", tone: "success" },
    REJECTED: { label: "Rejected", meaning: "The checker rejected the request. The maker must submit a clean draft.", tone: "error" },
    EXPIRED: { label: "Expired", meaning: "Nobody decided the request before its deadline, so it was closed automatically and can no longer be approved. The maker submits it again if the change is still needed.", tone: "warning" },
};

export const APPROVAL_DOMAIN_HELP: Record<string, string> = {
    ONBOARDING: "Join request and KYB document decisions.",
    MERCHANT: "Merchant profile, application and lifecycle changes.",
    FINANCE: "Adjustments, cash-outs, commission profiles and velocity rules.",
    COMPLIANCE: "AML cases, AML rules, reporting rules and regulatory reports.",
    OPERATIONS: "Operator case resolutions.",
    GATEWAY: "Gateway versions, credential sets and gateway configuration.",
    SECURITY: "Admin user role and authority changes.",
    SETTINGS: "Platform setting changes.",
    OTHER: "Unclassified approval subject.",
};

export const APPROVAL_BLOCK_REASON_HELP: Record<string, string> = {
    APPROVAL_NOT_PENDING: "This request is no longer pending a checker decision.",
    MAKER_CANNOT_CHECK: "You are the maker of this request. A different checker must decide it.",
    ADMIN_ASSISTED_MAKER_CANNOT_CHECK: "You prepared this admin-assisted onboarding. A different checker must decide it.",
    MERCHANT_CHECKER_DOMAIN_FORBIDDEN: "Your role cannot check this merchant field domain.",
    APPROVAL_EXPIRED: "The request has expired and can no longer be approved.",
};

export const APPROVAL_HELP_SECTIONS = [
    {
        title: "Maker cannot check their own request",
        body: "Every sensitive action is wrapped in one approval request. The maker proposes, a different checker decides, and execution happens atomically with approval. The maker and checker must always be different people.",
    },
    {
        title: "Read the diff before deciding",
        body: "Never approve from the summary alone. Read the green/red JSON diff, verify currency and decimal scale, and check the linked subject record. For a payout account change, verify the bank letter. For a refund or chargeback, verify the provider reference or dispute outcome.",
    },
    {
        title: "Chargeback outcome",
        body: "An ADJUSTMENT approval can require an explicit WON or LOST dispute outcome. The selector is only shown for chargeback adjustments. Choosing the wrong outcome changes the ledger posting.",
    },
    {
        title: "Expiry and rejection",
        body: "Pending requests expire after their deadline. Expired requests cannot be approved. A rejection must include a clear reason so the maker can correct and resubmit the draft.",
    },
    {
        title: "Queue ageing",
        body: "The summary highlights pending requests, expiring-soon requests, expired requests, emergency ratifications that are due, and the oldest pending request. Use the domain and subject filters to focus your review.",
    },
];
