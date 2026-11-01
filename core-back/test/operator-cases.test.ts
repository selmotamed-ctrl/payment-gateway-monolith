import { describe, expect, test } from "bun:test";
import {
  operatorCaseInquiryEligibility,
  operatorCaseInquirySkipMessage,
} from "../lib/operatorCases";

describe("operator-case inquiry eligibility", () => {
  test("an UNKNOWN attempt on an inquiry-capable gateway is eligible", () => {
    expect(
      operatorCaseInquiryEligibility({
        caseState: "OPEN",
        attemptStatus: "UNKNOWN",
        terminalAt: null,
        supportsStatusCheck: true,
      }),
    ).toEqual({ eligible: true, reason: "ELIGIBLE" });
  });

  test("a VERIFYING attempt is eligible", () => {
    expect(
      operatorCaseInquiryEligibility({
        caseState: "IN_PROGRESS",
        attemptStatus: "VERIFYING",
        terminalAt: null,
        supportsStatusCheck: true,
      }).eligible,
    ).toBe(true);
  });

  test("resolved and checker-pending cases are never reopened by bulk inquiry", () => {
    expect(
      operatorCaseInquiryEligibility({
        caseState: "RESOLVED",
        attemptStatus: "UNKNOWN",
        terminalAt: null,
        supportsStatusCheck: true,
      }).reason,
    ).toBe("CASE_RESOLVED");
    expect(
      operatorCaseInquiryEligibility({
        caseState: "PENDING_CHECKER",
        attemptStatus: "UNKNOWN",
        terminalAt: null,
        supportsStatusCheck: true,
      }).reason,
    ).toBe("CASE_PENDING_CHECKER");
  });

  test("missing, terminal and non-inquirable attempts are skipped", () => {
    expect(
      operatorCaseInquiryEligibility({
        caseState: "OPEN",
        attemptStatus: null,
        terminalAt: null,
        supportsStatusCheck: true,
      }).reason,
    ).toBe("NO_ATTEMPT");
    expect(
      operatorCaseInquiryEligibility({
        caseState: "OPEN",
        attemptStatus: "UNKNOWN",
        terminalAt: new Date(),
        supportsStatusCheck: true,
      }).reason,
    ).toBe("ATTEMPT_TERMINAL");
    expect(
      operatorCaseInquiryEligibility({
        caseState: "OPEN",
        attemptStatus: "SUCCEEDED",
        terminalAt: null,
        supportsStatusCheck: true,
      }).reason,
    ).toBe("ATTEMPT_NOT_INQUIRABLE");
  });

  test("a gateway without an inquiry API is skipped with a usable message", () => {
    const result = operatorCaseInquiryEligibility({
      caseState: "OPEN",
      attemptStatus: "UNKNOWN",
      terminalAt: null,
      supportsStatusCheck: false,
    });
    expect(result).toEqual({ eligible: false, reason: "GATEWAY_HAS_NO_STATUS_INQUIRY" });
    expect(operatorCaseInquirySkipMessage(result.reason)).toContain("does not support status inquiry");
  });
});
