import type { StatusTone } from "@/components/StatusChip";
import type { JoinRequestStatus } from "./types";

export const COLUMN_HELP = {
    merchant: "The merchant legal and trade name on the onboarding request.",
    status: "Onboarding state. DRAFT and INFO_REQUESTED can be edited; PENDING_CHECKER is waiting for four-eyes review.",
    channel: "SELF_SERVICE means the merchant completed the form. ADMIN_ASSISTED means an operator prepared it.",
    riskTier: "The risk tier proposed by the reviewer. Activation writes this value to the merchant.",
    category: "The merchant business category, used by the risk-based four-eyes policy.",
    volume: "Expected monthly processing volume and currency captured in the onboarding profile.",
    submitted: "When the merchant or operator submitted the request for review.",
    sla: "Onboarding review SLA. Paused while an information request is outstanding.",
    reviewer: "The operator currently assigned to review this request.",
    readiness: "Approval is refused until every blocker is cleared. This is the server-side decision readiness result.",
    duplicates: "Cross-merchant matches on tax ID, registration, contacts, payout account, owner national ID or document hash.",
    documents: "KYB documents are encrypted at rest, magic-byte validated and malware scanned before review or preview.",
    owners: "Active beneficial owners. Every owner is screened as part of onboarding.",
    screening: "The latest AML screening result and any matches. Match details are visible only to COMPLIANCE and MLRO.",
};

export const joinStatusHelp = (status: string): { label: string; meaning: string; tone: StatusTone } => {
    switch (status) {
        case "DRAFT":
            return { label: "Draft", meaning: "The request is being prepared and has not entered the review queue.", tone: "neutral" };
        case "SUBMITTED":
            return { label: "Submitted", meaning: "The request has been submitted and is waiting to be picked up.", tone: "info" };
        case "IN_REVIEW":
            return { label: "In review", meaning: "An operator is reviewing evidence, documents and screening.", tone: "info" };
        case "INFO_REQUESTED":
            return { label: "Info requested", meaning: "Additional information is required. The SLA is paused.", tone: "warning" };
        case "PENDING_CHECKER":
            return { label: "Pending checker", meaning: "A maker-checker approval is waiting for an independent checker.", tone: "warning" };
        case "APPROVED":
            return { label: "Approved", meaning: "The merchant was activated and KYB is verified.", tone: "success" };
        case "REJECTED":
            return { label: "Rejected", meaning: "The onboarding request was rejected.", tone: "error" };
        case "WITHDRAWN":
            return { label: "Withdrawn", meaning: "The request was withdrawn before a decision.", tone: "neutral" };
        case "EXPIRED":
            return { label: "Expired", meaning: "The request expired before completion.", tone: "error" };
        default:
            return { label: status, meaning: "Unknown onboarding state.", tone: "neutral" };
    }
};

export const channelLabel = (channel: string): string =>
    channel === "ADMIN_ASSISTED" ? "Admin assisted" : "Self service";

export const blockerLabel = (blocker: string): string =>
    blocker.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());

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

export const slaInfo = (row: { slaDueAt?: string | null; slaPausedAt?: string | null }): {
    label: string;
    tone: StatusTone;
    detail: string;
} => {
    if (!row.slaDueAt) return { label: "—", tone: "neutral", detail: "No SLA" };
    if (row.slaPausedAt) return { label: "Paused", tone: "neutral", detail: `Paused ${formatDateTime(row.slaPausedAt)}` };
    const diff = new Date(row.slaDueAt).getTime() - Date.now();
    if (Number.isNaN(diff)) return { label: "—", tone: "neutral", detail: "Invalid SLA" };
    if (diff < 0) return { label: "Overdue", tone: "error", detail: `${Math.ceil(Math.abs(diff) / 3600000)}h overdue` };
    if (diff < 24 * 3600 * 1000) {
        return { label: `${Math.max(1, Math.round(diff / 3600000))}h`, tone: "warning", detail: "Due within a day" };
    }
    return { label: `${Math.round(diff / 86400000)}d`, tone: "success", detail: formatDateTime(row.slaDueAt) };
};

export const DOCUMENT_TYPES = [
    { title: "Commercial registry", value: "COMMERCIAL_REGISTRY" },
    { title: "Tax certificate", value: "TAX_CERTIFICATE" },
    { title: "Articles of association", value: "ARTICLES_OF_ASSOCIATION" },
    { title: "Owner ID", value: "OWNER_ID" },
    { title: "Signatory ID", value: "SIGNATORY_ID" },
    { title: "Proof of address", value: "PROOF_OF_ADDRESS" },
    { title: "Bank letter", value: "BANK_LETTER" },
    { title: "Sector licence", value: "SECTOR_LICENSE" },
    { title: "Other", value: "OTHER" },
];

export const REJECTION_REASONS = [
    { title: "Incomplete documents", value: "INCOMPLETE_DOCUMENTS" },
    { title: "Unverifiable business", value: "UNVERIFIABLE_BUSINESS" },
    { title: "Prohibited activity", value: "PROHIBITED_ACTIVITY" },
    { title: "Screening concern", value: "SCREENING_CONCERN" },
    { title: "Policy", value: "POLICY" },
];

export const infoRequestedLabel = (item: { field: string; message: string }): string =>
    `${blockerLabel(item.field)}: ${item.message}`;

export const isEditableStatus = (status: JoinRequestStatus): boolean =>
    status === "DRAFT" || status === "INFO_REQUESTED";
