import type { StatusTone } from "@/components/StatusChip";

const SUCCESS = new Set([
    "ACTIVE", "LIVE", "SUCCEEDED", "VERIFIED", "APPROVED", "EXECUTED", "COMPLETE", "COMPLETED",
    "SETTLED", "RELEASED", "HEALTHY", "MATCHED", "CONFIRMED", "ACKNOWLEDGED", "WON", "CLEAR",
    "SANDBOX_VERIFIED", "PROCESSED", "RESOLVED",
]);

const WARNING = new Set([
    "PENDING", "PENDING_REVIEW", "PENDING_CHECKER", "IN_REVIEW", "IN_PROGRESS", "PROCESSING",
    "DRAFT", "INFO_REQUESTED", "UNVERIFIED", "UNKNOWN", "PARTIAL", "DEGRADED", "MEDIUM",
    "EVIDENCE_REQUESTED", "POTENTIAL_MATCH", "P2", "SUBMITTED", "QUEUED", "RETRYING",
    "AMOUNT_MISMATCH", "MISSING_LOCALLY", "DUPLICATE",
]);

const INFO = new Set([
    "SCHEDULED", "RUNNING", "OPERATOR_CASE", "AUTOMATIC",
]);

const ERROR = new Set([
    "FAILED", "REJECTED", "BLOCKED", "SUSPENDED", "EXPIRED", "CANCELLED", "FROZEN", "REVOKED",
    "LOST", "HIGH", "HIGH_RISK", "CRITICAL", "FAILING", "REJECTED_BY_AUTHORITY", "CONFIRMED_MATCH",
    "P1", "OVERDUE", "ERROR", "MISSING_AT_GATEWAY",
]);

/** One shared colour vocabulary for chips, filter options and row markers. */
export const statusTone = (value: string | null | undefined): StatusTone => {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (!normalized) return "neutral";
    if (SUCCESS.has(normalized)) return "success";
    if (WARNING.has(normalized)) return "warning";
    if (INFO.has(normalized)) return "info";
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

export type CriticalRowTone = "danger" | "warning" | "info" | "success" | null;

const CRITICAL_VALUES = new Set([
    "P1",
    "CRITICAL",
    "HIGH_RISK",
    "OPEN_BREAKER",
    "CONFIRMED_MATCH",
    "TRUE_MATCH",
    "INFECTED",
    "EMERGENCY_RATIFICATION",
]);

const OVERDUE_VALUES = new Set([
    "OVERDUE",
    "EXPIRED",
    "EVIDENCE_OVERDUE",
    "BREACHED",
]);

const WARNING_VALUES = new Set([
    "P2",
    "HIGH",
    "DEGRADED",
    "POTENTIAL_MATCH",
    "DUE_SOON",
]);

const CRITICAL_KEYS = [
    "priority",
    "severity",
    "status",
    "state",
    "result",
    "riskTier",
    "riskClass",
    "healthState",
    "avStatus",
    "expiryState",
    "mode",
];

const OVERDUE_FLAGS = ["slaOverdue", "isOverdue", "evidenceOverdue", "expired", "overdue"];

const DANGER_COLORS = ["#dc2626", "#ef4444", "#b91c1c", "#e11d48", "#f87171"];
const WARNING_COLORS = ["#d97706", "#f59e0b", "#b45309", "#fbbf24", "#eab308"];
const INFO_COLORS = ["#2563eb", "#3b82f6", "#0f6bff", "#1d4ed8", "#60a5fa"];
const SUCCESS_COLORS = ["#059669", "#16a34a", "#22c55e", "#15803d", "#4ade80"];

const isDangerColor = (value: string): boolean =>
    DANGER_COLORS.some((color) => value.includes(color)) || value.includes("danger") || value.includes("error");

const isWarningColor = (value: string): boolean =>
    WARNING_COLORS.some((color) => value.includes(color)) || value.includes("warning") || value.includes("amber");

/**
 * Returns the hairline indicator tone for a genuinely critical row.
 * Ordinary statuses stay neutral; page-level rowColor hints are honoured only
 * when they resolve to a danger or warning token.
 */
export const criticalRowTone = (row: Record<string, unknown>, rowColor?: string): CriticalRowTone => {
    const color = String(rowColor ?? "").trim().toLowerCase();
    if (color) {
        if (DANGER_COLORS.some((entry) => color.includes(entry)) || color.includes("danger") || color.includes("error") || color.includes("red")) {
            return "danger";
        }
        if (WARNING_COLORS.some((entry) => color.includes(entry)) || color.includes("warning") || color.includes("amber") || color.includes("orange")) {
            return "warning";
        }
        if (INFO_COLORS.some((entry) => color.includes(entry)) || color.includes("info") || color.includes("primary") || color.includes("blue")) {
            return "info";
        }
        if (SUCCESS_COLORS.some((entry) => color.includes(entry)) || color.includes("success") || color.includes("green")) {
            return "success";
        }
    }

    for (const key of CRITICAL_KEYS) {
        const value = row[key];
        if (typeof value !== "string" || !value) continue;
        const normalized = value.trim().toUpperCase();
        if (CRITICAL_VALUES.has(normalized) || OVERDUE_VALUES.has(normalized)) return "danger";
        if (WARNING_VALUES.has(normalized)) return "warning";
    }

    if (OVERDUE_FLAGS.some((key) => row[key] === true)) {
        return "danger";
    }

    const routeHealth = row.routeHealth;
    if (routeHealth && typeof routeHealth === "object" && Number((routeHealth as Record<string, unknown>).openBreaker ?? 0) > 0) {
        return "danger";
    }

    return null;
};
