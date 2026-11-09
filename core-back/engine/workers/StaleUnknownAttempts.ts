import { toCamelRows } from "../db/rawRows";
import type { PaymentAttemptRow, PrismaLike } from "../db/ports";
import { inTransaction, writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase } from "./automationCases";

/**
 * AUTO-19: stale UNKNOWN attempts.
 *
 * An UNKNOWN attempt means the gateway may or may not have moved the money.
 * It is never failed automatically: only a definitive gateway or statement
 * answer, or an operator, may close it. When the polling window elapses the
 * attempt is handed to an operator through ONE keyed case, and the platform
 * monitor watches the age of the UNKNOWN population (SLO: 95 % resolved
 * within 24 h).
 */

export const UNKNOWN_ATTEMPT_SUBJECT_KEY = (attemptId: string): string => `attempt.unknown:${attemptId}`;

export interface UnknownEscalationResult {
  caseId: string | null;
  created: boolean;
}

/**
 * Hands an UNKNOWN attempt whose polling window elapsed to an operator.
 * Implementations must be idempotent per attempt.
 */
export interface UnknownAttemptEscalator {
  escalate(attempt: PaymentAttemptRow, context: { now: Date; reason: string }): Promise<UnknownEscalationResult>;
}

export interface UnknownAttemptEscalatorOptions {
  db: PrismaLike;
  /** SLA of the operator case. Default 24 h (the UNKNOWN resolution SLO). */
  slaHours?: number;
  /** Priority of the operator case. Default P1: the payer's money is in doubt. */
  priority?: "P1" | "P2" | "P3";
}

export const DEFAULT_UNKNOWN_CASE_SLA_HOURS = 24;
export const DEFAULT_UNKNOWN_CASE_PRIORITY = "P1" as const;

export const createUnknownAttemptEscalator = (
  options: UnknownAttemptEscalatorOptions,
): UnknownAttemptEscalator => {
  const slaHours = options.slaHours ?? DEFAULT_UNKNOWN_CASE_SLA_HOURS;
  const priority = options.priority ?? DEFAULT_UNKNOWN_CASE_PRIORITY;
  return {
    // The case and its audit row commit together.
    escalate: (attempt, context) => inTransaction(options.db, async (tx) => {
      const result = await openKeyedOperatorCase(tx as PrismaLike, {
        kind: "UNKNOWN",
        priority,
        subjectKey: UNKNOWN_ATTEMPT_SUBJECT_KEY(attempt.id),
        attemptId: attempt.id,
        dedupeOnAttempt: true,
        slaHours,
        now: context.now,
        notes:
          `Stale UNKNOWN attempt: ${context.reason}. Attempt ${attempt.id} is still UNKNOWN; `
          + "confirm the outcome with the gateway or the statement and resolve the case. "
          + "The attempt is never failed automatically.",
      });
      if (result.created) {
        await writeSystemAudit(tx, {
          action: "ATTEMPT_UNKNOWN_ESCALATED",
          entityType: "PAYMENT_ATTEMPT",
          entityId: attempt.id,
          before: { status: attempt.status },
          after: {
            status: attempt.status,
            operatorCaseId: result.id,
            priority,
            slaHours,
            reason: context.reason,
          },
        });
      }
      return { caseId: result.id, created: result.created };
    }),
  };
};

export interface StaleUnknownAttempt {
  id: string;
  merchantId: string | null;
  routeId: string | null;
  linkId: string | null;
  createdAt: Date;
  ageMs: number;
  /** An unresolved UNKNOWN operator case exists for the attempt. */
  hasOpenCase: boolean;
}

export interface StaleUnknownCheck {
  thresholdHours: number;
  /** All UNKNOWN attempts older than the threshold. */
  count: number;
  /** Of those, the ones that no unresolved UNKNOWN case covers. */
  withoutCase: number;
  oldestAgeMs: number | null;
  /** The oldest stale attempts, at most `limit`. */
  attempts: StaleUnknownAttempt[];
}

export interface StaleUnknownCheckOptions {
  /** Default 24 h. */
  olderThanHours?: number;
  /** Default 50. */
  limit?: number;
  now?: Date;
}

/**
 * Counts and lists the UNKNOWN attempts older than N hours, for the platform
 * monitor (AUTO-03) or an admin view. Read-only; served by the
 * `(status, created_at)` index on `payment_attempts`.
 */
export const checkStaleUnknownAttempts = async (
  db: PrismaLike,
  options: StaleUnknownCheckOptions = {},
): Promise<StaleUnknownCheck> => {
  const thresholdHours = options.olderThanHours ?? DEFAULT_UNKNOWN_CASE_SLA_HOURS;
  const limit = Math.max(1, Math.floor(options.limit ?? 50));
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - thresholdHours * 60 * 60 * 1000);
  const openCase =
    "EXISTS (SELECT 1 FROM operator_cases c WHERE c.attempt_id = p.id"
    + " AND c.kind = 'UNKNOWN' AND c.state <> 'RESOLVED')";
  const summaryRows = toCamelRows<{ total: unknown; withoutCase: unknown; oldest: Date | string | null }>(
    await db.$queryRawUnsafe(
      "SELECT count(*)::int AS total,"
        + ` count(*) FILTER (WHERE NOT ${openCase})::int AS without_case,`
        + " min(p.created_at) AS oldest"
        + " FROM payment_attempts p"
        + " WHERE p.status = 'UNKNOWN' AND p.terminal_at IS NULL AND p.created_at <= $1",
      cutoff,
    ),
  );
  const summary = summaryRows[0];
  const listRows = toCamelRows<{
    id: string;
    merchantId: string | null;
    routeId: string | null;
    linkId: string | null;
    createdAt: Date | string;
    hasOpenCase: boolean;
  }>(
    await db.$queryRawUnsafe(
      "SELECT p.id, p.merchant_id, p.route_id, p.link_id, p.created_at,"
        + ` ${openCase} AS has_open_case`
        + " FROM payment_attempts p"
        + " WHERE p.status = 'UNKNOWN' AND p.terminal_at IS NULL AND p.created_at <= $1"
        + " ORDER BY p.created_at ASC LIMIT $2",
      cutoff,
      limit,
    ),
  );
  const oldest = summary?.oldest ? new Date(summary.oldest) : null;
  return {
    thresholdHours,
    count: Number(summary?.total ?? 0),
    withoutCase: Number(summary?.withoutCase ?? 0),
    oldestAgeMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : null,
    attempts: listRows.map((row) => {
      const createdAt = new Date(row.createdAt);
      return {
        id: String(row.id),
        merchantId: row.merchantId ? String(row.merchantId) : null,
        routeId: row.routeId ? String(row.routeId) : null,
        linkId: row.linkId ? String(row.linkId) : null,
        createdAt,
        ageMs: Math.max(0, now.getTime() - createdAt.getTime()),
        hasOpenCase: row.hasOpenCase === true,
      };
    }),
  };
};
