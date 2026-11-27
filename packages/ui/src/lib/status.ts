export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const STATUS_TO_TONE: Record<string, BadgeTone> = {
    LIVE: "success", PUBLISHED: "success", ACTIVE: "success", SUCCEEDED: "success",
    APPROVED: "success", EXECUTED: "success", VERIFIED: "success", HEALTHY: "success",
    CLEAR: "success", CLEAN: "success", ACCEPTED: "success", MATCHED: "success",
    COMPLETE: "success", COMPLETED: "success", SUBTRACTED: "success", CONFIRMED: "success",
    WON: "success", RELEASED: "success", DELIVERED: "success", SETTLED: "success",
    PROCESSED: "success", RESOLVED: "success", FALSE_POSITIVE: "neutral",
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
    RUNNING: "info", OPERATOR_CASE: "info", AUTOMATIC: "info",
    UNKNOWN: "danger", FAILED: "danger", BLOCKED: "danger", SUSPENDED: "danger",
    REJECTED: "danger", REJECTED_VOID: "danger", REJECTED_BY_AUTHORITY: "danger",
    REVOKED: "danger", FAILING: "danger", OPEN_BREAKER: "danger", CONFIRMED_MATCH: "danger",
    TRUE_MATCH: "danger", ESCALATED: "danger", ESCALATED_STR: "danger", FROZEN: "danger",
    DISPUTED: "danger", LOST: "danger", INFECTED: "danger", MISSING_AT_GATEWAY: "danger",
    CONFLICT: "danger", HIGH_RISK: "danger", CRITICAL: "danger", P1: "danger",
    EXPIRED: "danger", CANCELLED: "danger", ERROR: "danger",
};

export const formatHumanStatus = (raw: string): string => {
    if (!raw) return "—";
    const upper = raw.toUpperCase();
    if (upper === "AML_HOLD") return "AML Hold";
    if (upper === "AML-CONFIDENTIAL" || upper === "AML_CONFIDENTIAL") return "AML-CONFIDENTIAL";
    if (["KYC", "KYB", "OTP", "P1", "P2", "P3", "AML", "LYD"].includes(upper)) return upper;
    return raw
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (character) => character.toUpperCase());
};

export const statusToTone = (raw: string | null | undefined): BadgeTone =>
    STATUS_TO_TONE[String(raw ?? "").trim().toUpperCase()] ?? "neutral";
