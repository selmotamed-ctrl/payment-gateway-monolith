/**
 * Pure helpers shared by the operator-case HTTP routes and their tests.
 *
 * The Rules here are safety rules, not presentation rules:
 *  - an inquiry may only be scheduled for an attempt that is still waiting for
 *    a definitive gateway answer;
 *  - a closed or checker-pending case is never reopened by a bulk action;
 *  - a gateway that has no status-inquiry API must be resolved through the
 *    statement or a Maker-Checker manual outcome instead.
 */

export const OPERATOR_CASE_ACTIONS = [
  "MARK_SUCCEEDED",
  "MARK_FAILED",
  "CLOSE_CASE",
] as const;

export type OperatorCaseAction = (typeof OPERATOR_CASE_ACTIONS)[number];

export const OPERATOR_CASE_INQUIRABLE_STATUSES = ["UNKNOWN", "VERIFYING"] as const;

export type InquiryEligibilityInput = {
  caseState: string | null | undefined;
  attemptStatus: string | null | undefined;
  terminalAt: Date | string | null | undefined;
  supportsStatusCheck: boolean | null | undefined;
};

export type InquiryEligibility = {
  eligible: boolean;
  reason: string;
};

const CLOSED_CASE_STATES = new Set(["RESOLVED", "PENDING_CHECKER"]);

export const operatorCaseInquiryEligibility = (
  input: InquiryEligibilityInput,
): InquiryEligibility => {
  const caseState = String(input.caseState ?? "").toUpperCase();
  if (CLOSED_CASE_STATES.has(caseState)) {
    return {
      eligible: false,
      reason:
        caseState === "RESOLVED"
          ? "CASE_RESOLVED"
          : "CASE_PENDING_CHECKER",
    };
  }
  if (!input.attemptStatus) {
    return { eligible: false, reason: "NO_ATTEMPT" };
  }
  if (input.terminalAt) {
    return { eligible: false, reason: "ATTEMPT_TERMINAL" };
  }
  const status = String(input.attemptStatus).toUpperCase();
  if (!(OPERATOR_CASE_INQUIRABLE_STATUSES as readonly string[]).includes(status)) {
    return { eligible: false, reason: "ATTEMPT_NOT_INQUIRABLE" };
  }
  if (input.supportsStatusCheck !== true) {
    return { eligible: false, reason: "GATEWAY_HAS_NO_STATUS_INQUIRY" };
  }
  return { eligible: true, reason: "ELIGIBLE" };
};

export const operatorCaseInquirySkipMessage = (reason: string): string => {
  switch (reason) {
    case "CASE_RESOLVED":
      return "The case is already resolved";
    case "CASE_PENDING_CHECKER":
      return "A resolution is already waiting for a checker";
    case "NO_ATTEMPT":
      return "The case has no linked payment attempt";
    case "ATTEMPT_TERMINAL":
      return "The payment attempt is already in a terminal state";
    case "ATTEMPT_NOT_INQUIRABLE":
      return "Only UNKNOWN or VERIFYING attempts can be inquired";
    case "GATEWAY_HAS_NO_STATUS_INQUIRY":
      return "The pinned gateway version does not support status inquiry";
    case "CASE_NOT_FOUND":
      return "The operator case does not exist";
    default:
      return "The inquiry could not be scheduled";
  }
};
