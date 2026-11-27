export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const STATUS_TO_TONE: Record<string, BadgeTone> = {
    LIVE: "success", PUBLISHED: "success", ACTIVE: "success", SUCCEEDED: "success",
    APPROVED: "success", EXECUTED: "success", VERIFIED: "success", HEALTHY: "success",
    CLEAR: "success", CLEAN: "success", ACCEPTED: "success", MATCHED: "success",
    COMPLETE: "success", COMPLETED: "success", SUBTRACTED: "success", CONFIRMED: "success",
    WON: "success", RELEASED: "success", DELIVERED: "success", SETTLED: "success",
    PROCESSED: "success", RESOLVED: "success", CAPTURED: "success", PAID: "success",
    FALSE_POSITIVE: "neutral", SIMULATED: "info",
    PENDING: "warning", PENDING_REVIEW: "warning", PENDING_CHECKER: "warning",
    PENDING_APPROVAL: "warning", IN_REVIEW: "warning", IN_PROGRESS: "warning",
    INFO_REQUESTED: "warning", AWAITING_CUSTOMER: "warning", DRAFT: "warning",
    ARCHIVED: "neutral", NEEDS_MIGRATION: "danger", INVALID: "danger", BROKEN: "danger",
    MISSING: "danger", UNVERIFIED: "warning", PARTIAL: "warning", DRAINING: "warning",
    DEGRADED: "warning", POTENTIAL_MATCH: "warning", UNREVIEWED: "warning",
    PROVISIONAL: "warning", EVIDENCE_REQUESTED: "warning", MEDIUM: "warning", HIGH: "warning",
    P2: "warning", SUBMITTED: "warning", QUEUED: "warning", RETRYING: "warning",
    AMOUNT_MISMATCH: "danger", MISSING_LOCALLY: "danger", DUPLICATE: "warning", OVERDUE: "danger",
    VERIFYING: "info", AUTHORIZING: "info", INITIATING: "info", PROCESSING: "info",
    EXECUTING: "info", SANDBOX_VERIFIED: "info", EVIDENCE_SUBMITTED: "info", SCHEDULED: "info",
    RUNNING: "info", OPERATOR_CASE: "info", AUTOMATIC: "info", MANUAL: "info",
    UNKNOWN: "danger", FAILED: "danger", BLOCKED: "danger", SUSPENDED: "danger",
    REJECTED: "danger", REJECTED_VOID: "danger", REJECTED_BY_AUTHORITY: "danger",
    REVOKED: "danger", FAILING: "danger", OPEN_BREAKER: "danger", CONFIRMED_MATCH: "danger",
    TRUE_MATCH: "danger", ESCALATED: "danger", ESCALATED_STR: "danger", FROZEN: "danger",
    DISPUTED: "danger", LOST: "danger", INFECTED: "danger", MISSING_AT_GATEWAY: "danger",
    CONFLICT: "danger", HIGH_RISK: "danger", CRITICAL: "danger", P1: "danger",
    EXPIRED: "danger", CANCELLED: "danger", CANCELED: "danger", ERROR: "danger",
    FAILED_INSUFFICIENT_FUNDS: "danger", CHARGEBACK: "danger", QUARANTINED: "danger",
    DEAD_LETTERED: "danger", PARKED: "danger", VIOLATION: "danger", MISMATCH: "danger",
};

/** Uppercase banking acronyms preserved by `formatHumanStatus`. */
const ACRONYMS = new Set([
    "AML", "API", "BHD", "CBL", "CVV", "DZD", "EGP", "EUR", "GBP", "IBAN", "JOD", "JPY",
    "KWD", "KYB", "KYC", "KRW", "LYD", "MAD", "MLRO", "MTLS", "OMR", "OTP", "PAN", "PDF",
    "PEP", "POS", "PSP", "QR", "SAR", "SLA", "STR", "SWIFT", "TND", "TLS", "USD", "XLSX",
    "XML", "3DS", "2FA", "TOTP", "SMS", "SMTP", "URL", "UUID", "CSV", "JSON", "HTML",
]);

const normaliseKey = (raw: string): string =>
    raw.trim().replace(/[-\s]+/g, "_").replace(/_+/g, "_").toUpperCase();

/**
 * Human label for a backend enum. Acronyms stay uppercase and delimiters are
 * interchangeable (`pending-kyb`, `PENDING_KYB`, `pending kyb`).
 */
export const formatHumanStatus = (raw: string | null | undefined): string => {
    if (raw === null || raw === undefined || String(raw).trim() === "") return "—";
    const upper = normaliseKey(String(raw));
    if (upper === "AML_HOLD") return "AML Hold";
    if (upper === "AML_CONFIDENTIAL" || upper === "AML-CONFIDENTIAL") return "AML-CONFIDENTIAL";
    if (upper.startsWith("PENDING_")) {
        return ["Pending", ...upper.slice("PENDING_".length).split("_").map(humaniseToken)].join(" ");
    }
    return upper
        .split("_")
        .map(humaniseToken)
        .join(" ");
};

const humaniseToken = (token: string): string => {
    if (!token) return "";
    if (ACRONYMS.has(token)) return token;
    if (/^\d+[A-Z]+$/.test(token)) return token;
    return token.charAt(0) + token.slice(1).toLowerCase();
};

export const statusToTone = (raw: string | null | undefined): BadgeTone => {
    const key = normaliseKey(String(raw ?? ""));
    if (!key) return "neutral";
    const mapped = STATUS_TO_TONE[key];
    if (mapped) return mapped;
    // Any unlisted pending/awaiting state is still an in-flight warning.
    if (key.startsWith("PENDING_") || key.startsWith("AWAITING_") || key.endsWith("_PENDING")) return "warning";
    if (key.startsWith("FAILED_") || key.startsWith("REJECTED_") || key.endsWith("_FAILED")) return "danger";
    return "neutral";
};
