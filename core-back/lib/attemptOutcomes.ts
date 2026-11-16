/**
 * Attempt statuses that count toward the dashboard success rate.
 *
 * Success: the payment was processed and money moved. A later refund or dispute
 * does not turn the original processing result into a failure.
 *
 * Problematic: a processing outcome we could not call a success (the partner
 * failed the payment or we still do not know the result). These are the only
 * non-success statuses in the denominator.
 *
 * Ignored: pending/in-flight attempts and deliberate or no-processing outcomes
 * (customer/system cancellation, expiry, guard/AML block). They are neither
 * successes nor payment-processing failures, so they are not counted.
 */
export const merchantSuccessStatuses = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] as const;

export const problematicAttemptStatuses = ["FAILED", "UNKNOWN"] as const;

export const ignoredAttemptStatuses = [
  "CREATED",
  "INITIATING",
  "AWAITING_CUSTOMER",
  "AUTHORIZING",
  "VERIFYING",
  "CANCELLED",
  "EXPIRED",
  "BLOCKED",
] as const;

const successStatuses = new Set<string>(merchantSuccessStatuses);
const problematicStatuses = new Set<string>(problematicAttemptStatuses);

export const isSuccessAttemptStatus = (status: unknown): boolean =>
  successStatuses.has(String(status ?? "").toUpperCase());

export const isProblematicAttemptStatus = (status: unknown): boolean =>
  problematicStatuses.has(String(status ?? "").toUpperCase());

/** True when the status is a success or a processing failure and thus enters the success-rate denominator. */
export const isAttemptCounted = (status: unknown): boolean =>
  isSuccessAttemptStatus(status) || isProblematicAttemptStatus(status);

export const successRatePercent = (succeeded: number, counted: number): number =>
  counted <= 0 ? 0 : Number(((succeeded / counted) * 100).toFixed(2));
