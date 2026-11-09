import type { MonitorFinding, PlatformMonitorCheck } from "./PlatformMonitorWorker";
import { findExecutingRefundsWithoutInquiry } from "./RefundInquiry";
import { checkStaleUnknownAttempts, DEFAULT_UNKNOWN_CASE_SLA_HOURS } from "./StaleUnknownAttempts";

/**
 * Platform monitor checks for the money-path automations (AUTO-19, AUTO-20).
 * Pass them to `PlatformMonitorWorker` through `extraChecks`; each finding
 * becomes one keyed case `platform.<id>` that clears when the condition stops.
 */

/** AUTO-19: UNKNOWN attempts older than N hours (SLO: 95 % resolved within 24 h). */
export const createStaleUnknownMonitorCheck = (options: { olderThanHours?: number; sampleSize?: number } = {}): PlatformMonitorCheck => ({
  id: "stale_unknown",
  async run({ db, now }): Promise<MonitorFinding[]> {
    const thresholdHours = options.olderThanHours ?? DEFAULT_UNKNOWN_CASE_SLA_HOURS;
    const check = await checkStaleUnknownAttempts(db, { olderThanHours: thresholdHours, limit: options.sampleSize ?? 10, now });
    if (check.count === 0) return [];
    const oldestHours = check.oldestAgeMs === null ? null : Math.floor(check.oldestAgeMs / 3_600_000);
    return [{
      title: `${check.count} payment attempt(s) UNKNOWN for more than ${thresholdHours} h`,
      detail:
        `${check.count} attempt(s) are still UNKNOWN after ${thresholdHours} h (${check.withoutCase} without an open UNKNOWN case`
        + `${oldestHours === null ? "" : `, oldest ${oldestHours} h`}). Oldest: ${check.attempts.map((row) => row.id).join(", ")}.`,
      priority: "P1",
    }];
  },
});

/** AUTO-20: EXECUTING refunds that neither an inquiry job nor an inquiry case covers. */
export const createUnscheduledRefundMonitorCheck = (options: { olderThanMinutes?: number; sampleSize?: number } = {}): PlatformMonitorCheck => ({
  id: "refund_unscheduled",
  async run({ db, now }): Promise<MonitorFinding[]> {
    const rows = await findExecutingRefundsWithoutInquiry(db, {
      olderThanMinutes: options.olderThanMinutes ?? 15,
      limit: options.sampleSize ?? 10,
      now,
    });
    if (rows.length === 0) return [];
    return [{
      title: "Refunds stuck in EXECUTING without a follow-up",
      detail:
        `${rows.length}${rows.length >= (options.sampleSize ?? 10) ? "+" : ""} refund adjustment(s) are EXECUTING with no REFUND_INQUIRY job `
        + `and no inquiry case: ${rows.map((row) => row.adjustmentId).join(", ")}. Re-schedule them with the refund inquiry scheduler.`,
      priority: "P1",
    }];
  },
});
