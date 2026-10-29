import type { StatusTone } from "@/components/StatusChip";

const SUCCESS = new Set([
    "ACTIVE", "LIVE", "SUCCEEDED", "VERIFIED", "APPROVED", "EXECUTED", "COMPLETE", "COMPLETED",
    "SETTLED", "RELEASED", "HEALTHY", "MATCHED", "CONFIRMED", "ACKNOWLEDGED", "WON", "CLEAR",
    "SANDBOX_VERIFIED", "PROCESSED",
]);

const WARNING = new Set([
    "PENDING", "PENDING_REVIEW", "PENDING_CHECKER", "IN_REVIEW", "IN_PROGRESS", "PROCESSING",
    "DRAFT", "INFO_REQUESTED", "UNVERIFIED", "UNKNOWN", "PARTIAL", "DEGRADED", "MEDIUM",
    "EVIDENCE_REQUESTED", "POTENTIAL_MATCH", "P2", "SUBMITTED", "QUEUED",
]);

const ERROR = new Set([
    "FAILED", "REJECTED", "BLOCKED", "SUSPENDED", "EXPIRED", "CANCELLED", "FROZEN", "REVOKED",
    "LOST", "HIGH", "HIGH_RISK", "CRITICAL", "FAILING", "REJECTED_BY_AUTHORITY", "CONFIRMED_MATCH",
    "P1", "OVERDUE", "ERROR",
]);

/** One shared colour vocabulary for chips, filter options and row tints. */
export const statusTone = (value: string | null | undefined): StatusTone => {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (!normalized) return "neutral";
    if (SUCCESS.has(normalized)) return "success";
    if (WARNING.has(normalized)) return "warning";
    if (ERROR.has(normalized)) return "error";
    return "neutral";
};

const ROW_PRIORITY = ["status", "state", "result", "severity", "riskTier", "priority"];

export const rowTone = (row: Record<string, unknown>): StatusTone => {
    for (const key of ROW_PRIORITY) {
        const value = row[key];
        if (typeof value === "string" && value) {
            return statusTone(value);
        }
    }
    return "neutral";
};
