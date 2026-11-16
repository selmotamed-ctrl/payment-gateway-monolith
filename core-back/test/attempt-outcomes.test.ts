import { describe, expect, test } from "bun:test";
import {
  ignoredAttemptStatuses,
  isAttemptCounted,
  isProblematicAttemptStatus,
  isSuccessAttemptStatus,
  merchantSuccessStatuses,
  problematicAttemptStatuses,
  successRatePercent,
} from "../lib/attemptOutcomes";

const allStatuses = [
  "CREATED",
  "INITIATING",
  "AWAITING_CUSTOMER",
  "AUTHORIZING",
  "VERIFYING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "DISPUTED",
] as const;

describe("dashboard attempt outcomes", () => {
  test("success statuses include the post-success states", () => {
    for (const status of merchantSuccessStatuses) {
      expect(isSuccessAttemptStatus(status)).toBe(true);
      expect(isProblematicAttemptStatus(status)).toBe(false);
      expect(isAttemptCounted(status)).toBe(true);
    }
  });

  test("only failed and unknown processing outcomes are problematic", () => {
    for (const status of problematicAttemptStatuses) {
      expect(isProblematicAttemptStatus(status)).toBe(true);
      expect(isSuccessAttemptStatus(status)).toBe(false);
      expect(isAttemptCounted(status)).toBe(true);
    }
  });

  test("pending and deliberate outcomes are neither successes nor counted failures", () => {
    for (const status of ignoredAttemptStatuses) {
      expect(isSuccessAttemptStatus(status)).toBe(false);
      expect(isProblematicAttemptStatus(status)).toBe(false);
      expect(isAttemptCounted(status)).toBe(false);
    }
  });

  test("every attempt status is classified once", () => {
    const classified = [...merchantSuccessStatuses, ...problematicAttemptStatuses, ...ignoredAttemptStatuses].sort();
    expect(classified).toEqual([...allStatuses].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  test("success rate divides by the counted attempts", () => {
    expect(successRatePercent(468, 955)).toBe(49.01);
    expect(successRatePercent(1, 2)).toBe(50);
    expect(successRatePercent(0, 0)).toBe(0);
    expect(successRatePercent(0, 10)).toBe(0);
  });
});
