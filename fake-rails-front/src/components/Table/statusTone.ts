import type { BadgeTone } from "@/components/ui/StatusBadge";

export type StatusTone = BadgeTone;

const SUCCESS_SET = new Set([
  "LIVE", "ACTIVE", "SUCCEEDED", "APPROVED", "EXECUTED", "VERIFIED",
  "HEALTHY", "CLEAR", "CLEAN", "ACCEPTED", "MATCHED", "COMPLETE",
  "COMPLETED", "SUBTRACTED", "CONFIRMED", "WON", "RELEASED", "DELIVERED",
  "PAID", "TRUE", "YES",
]);

const WARNING_SET = new Set([
  "PENDING", "PENDING_REVIEW", "PENDING_CHECKER", "PENDING_APPROVAL",
  "IN_REVIEW", "IN_PROGRESS", "INFO_REQUESTED", "AWAITING_CUSTOMER",
  "AWAITING_ACTION", "INITIATED", "DRAINING", "DEGRADED", "POTENTIAL_MATCH",
  "UNREVIEWED", "PROVISIONAL", "EVIDENCE_REQUESTED", "MEDIUM", "HIGH", "P2",
]);

const DANGER_SET = new Set([
  "UNKNOWN", "UNKNOWN_SIMULATED", "FAILED", "BLOCKED", "SUSPENDED", "REJECTED",
  "REJECTED_VOID", "REVOKED", "FAILING", "OPEN_BREAKER", "CONFIRMED_MATCH",
  "TRUE_MATCH", "ESCALATED", "ESCALATED_STR", "FROZEN", "DISPUTED", "LOST",
  "INFECTED", "AMOUNT_MISMATCH", "MISSING_AT_GATEWAY", "MISSING_LOCALLY",
  "CONFLICT", "HIGH_RISK", "CRITICAL", "P1",
]);

const INFO_SET = new Set([
  "VERIFYING", "AUTHORIZING", "INITIATING_PAYMENT", "PROCESSING", "EXECUTING",
  "SANDBOX_VERIFIED", "EVIDENCE_SUBMITTED",
]);

export function resolveStatusTone(value: unknown): StatusTone {
  if (value === true) return "success";
  if (value === false) return "neutral";
  const normalized = String(value ?? "").trim().toUpperCase();
  if (SUCCESS_SET.has(normalized)) return "success";
  if (WARNING_SET.has(normalized)) return "warning";
  if (DANGER_SET.has(normalized)) return "danger";
  if (INFO_SET.has(normalized)) return "info";
  return "neutral";
}

export function getRowTintStyle(_row: Record<string, unknown>): Record<string, string> {
  return {};
}

export const statusTone = (value: string | null | undefined): StatusTone => resolveStatusTone(value);

const ROW_PRIORITY = ["status", "state", "result", "severity", "riskTier", "priority"];

export const rowTone = (row: Record<string, unknown>): StatusTone => {
  for (const key of ROW_PRIORITY) {
    const value = row[key];
    if (typeof value === "string" && value) {
      return resolveStatusTone(value);
    }
  }
  return "neutral";
};
