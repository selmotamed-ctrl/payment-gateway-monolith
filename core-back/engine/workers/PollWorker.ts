import { toCamelRows, postgresPlaceholders } from "../db/rawRows";
import type { PaymentAttemptRow, Tx } from "../db/ports";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";
import type { InquiryOutcome, InquiryPort } from "./ExpirySweeperWorker";
import {
  findActiveGatewayInquiry,
  markGatewayInquiryRunning,
  reconcileGatewayInquiries,
  updateGatewayInquiry,
} from "./GatewayInquirySchedules";
import {
  createUnknownAttemptEscalator,
  type UnknownAttemptEscalator,
} from "./StaleUnknownAttempts";

export interface PollWorkerDeps extends WorkerOptions {
  inquiry?: InquiryPort;
  defaultFirstAfterSeconds?: number;
  defaultBackoffSeconds?: number[];
  defaultMaxDurationSeconds?: number;
  /**
   * AUTO-19: hands an UNKNOWN attempt whose polling window elapsed to an
   * operator (one keyed UNKNOWN case). Defaults to the database escalator
   * built from `unknownCaseSlaHours` / `unknownCasePriority`.
   */
  unknownEscalator?: UnknownAttemptEscalator;
  /** SLA of the UNKNOWN operator case. Default 24 h. */
  unknownCaseSlaHours?: number;
  /** Priority of the UNKNOWN operator case. Default P1. */
  unknownCasePriority?: "P1" | "P2" | "P3";
  /**
   * When the escalation itself fails (e.g. the database is briefly away), the
   * attempt is re-checked after this delay instead of being dropped from
   * polling without a case. Default 300 s.
   */
  unknownEscalationRetrySeconds?: number;
}

export interface PollPolicy {
  routeId: string;
  firstAfterSeconds: number;
  backoffSeconds: number[];
  maxDurationSeconds: number;
  stopOnStates: string[];
}

const POLLABLE_STATUSES = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"];
const TERMINAL_STATUSES = ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"];

export const computeBackoffDelaySeconds = (
  policy: Pick<PollPolicy, "firstAfterSeconds" | "backoffSeconds" | "maxDurationSeconds">,
  elapsedSeconds: number,
): number | null => {
  if (elapsedSeconds >= policy.maxDurationSeconds) {
    return null;
  }
  const schedule = policy.backoffSeconds.length > 0 ? policy.backoffSeconds : [policy.firstAfterSeconds];
  let accumulated = 0;
  for (const step of schedule) {
    accumulated += step;
    if (elapsedSeconds < accumulated) {
      return step;
    }
  }
  return schedule[schedule.length - 1] ?? policy.firstAfterSeconds;
};

export class PollWorker extends BaseWorker {
  private readonly inquiry: InquiryPort | undefined;
  private readonly defaultFirstAfterSeconds: number;
  private readonly defaultBackoffSeconds: number[];
  private readonly defaultMaxDurationSeconds: number;
  private readonly unknownEscalator: UnknownAttemptEscalator;
  private readonly unknownEscalationRetrySeconds: number;
  private policies = new Map<string, PollPolicy>();

  constructor(deps: PollWorkerDeps) {
    super(deps);
    this.inquiry = deps.inquiry;
    this.defaultFirstAfterSeconds = deps.defaultFirstAfterSeconds ?? 5;
    this.defaultBackoffSeconds = deps.defaultBackoffSeconds ?? [5, 15, 30, 60, 120, 300];
    this.defaultMaxDurationSeconds = deps.defaultMaxDurationSeconds ?? 900;
    this.unknownEscalator = deps.unknownEscalator ?? createUnknownAttemptEscalator({
      db: deps.db,
      slaHours: deps.unknownCaseSlaHours,
      priority: deps.unknownCasePriority,
    });
    this.unknownEscalationRetrySeconds = deps.unknownEscalationRetrySeconds ?? 300;
  }

  protected async tick(): Promise<void> {
    const now = this.clock();
    await reconcileGatewayInquiries(this.db as Tx, now);
    const attempts = await this.lockDueAttempts(now);
    if (attempts.length === 0) return;
    await this.refreshPolicies();
    for (const attempt of attempts) {
      await this.pollAttempt(attempt, now);
    }
  }

  private async refreshPolicies(): Promise<void> {
    try {
      const policies = await this.repositories.payments.listPollPolicies(this.db as Tx);
      this.policies = new Map(policies.map((policy) => [policy.routeId, policy]));
    } catch (error) {
      this.logger.warn("PollWorker: unable to refresh poll policies", { error: (error as Error).message });
    }
  }

  private policyFor(attempt: PaymentAttemptRow): PollPolicy {
    const routeId = attempt.routeId ?? "";
    const policy = this.policies.get(routeId);
    if (!policy) {
      return {
        routeId: routeId,
        firstAfterSeconds: this.defaultFirstAfterSeconds,
        backoffSeconds: this.defaultBackoffSeconds,
        maxDurationSeconds: this.defaultMaxDurationSeconds,
        stopOnStates: [],
      };
    }
    return policy;
  }

  private async lockDueAttempts(now: Date): Promise<PaymentAttemptRow[]> {
    const statusPlaceholders = postgresPlaceholders(POLLABLE_STATUSES.length, 2);
    const limitPlaceholder = `$${POLLABLE_STATUSES.length + 2}`;
    // The claim is ONE statement inside ONE transaction: the rows are locked
    // with FOR UPDATE SKIP LOCKED and leased by pushing next_check_at forward
    // before the lock is released at commit. The inquiry then runs OUTSIDE the
    // transaction (a held row lock would deadlock the engine, which updates the
    // same attempt on another connection). Every outcome below rewrites
    // next_check_at; a crashed node's rows become due again after the lease.
    const leaseParam = "$" + String(POLLABLE_STATUSES.length + 3);
    const sql =
      "WITH claimed AS (" +
      "SELECT id FROM payment_attempts" +
      " WHERE next_check_at IS NOT NULL" +
      " AND next_check_at <= $1" +
      " AND terminal_at IS NULL" +
      ` AND status IN (${statusPlaceholders})` +
      " ORDER BY next_check_at ASC" +
      ` LIMIT ${limitPlaceholder}` +
      " FOR UPDATE SKIP LOCKED)" +
      ` UPDATE payment_attempts p SET next_check_at = ${leaseParam}, updated_at = now()` +
      " FROM claimed WHERE p.id = claimed.id RETURNING p.*";
    const leaseUntil = new Date(now.getTime() + this.claimLeaseSeconds * 1000);
    const result = await this.inTransaction((tx) =>
      tx.$queryRawUnsafe(sql, now, ...POLLABLE_STATUSES, this.batchSize, leaseUntil),
    );
    return toCamelRows<PaymentAttemptRow>(result);
  }

  private async pollAttempt(attempt: PaymentAttemptRow, now: Date): Promise<void> {
    const policy = this.policyFor(attempt);
    const schedule = await findActiveGatewayInquiry(this.db as Tx, attempt.id);

    if (policy.stopOnStates.includes(attempt.status)) {
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: null });
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "COMPLETED",
          completedAt: now,
          lastResult: attempt.status,
        });
      }
      return;
    }

    // A manual inquiry schedule owns its own polling window. Using the
    // attempt's original creation time would immediately expire a schedule
    // created for an old UNKNOWN attempt, so the schedule start time is the
    // reference while one is active.
    const referenceAt = schedule?.windowStartedAt ?? schedule?.createdAt ?? attempt.createdAt ?? now;
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - new Date(referenceAt).getTime()) / 1000));
    const delaySeconds = computeBackoffDelaySeconds(policy, elapsedSeconds);

    if (delaySeconds === null) {
      // AUTO-19: an UNKNOWN attempt is never failed here. It is handed to an
      // operator through one keyed case before it leaves the polling loop; if
      // the case cannot be opened the attempt stays due and is retried.
      if (attempt.status === "UNKNOWN" && !(await this.escalateUnknown(attempt, now, elapsedSeconds))) {
        const retryAt = new Date(now.getTime() + this.unknownEscalationRetrySeconds * 1000);
        await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: retryAt });
        return;
      }
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: null });
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "EXPIRED",
          completedAt: now,
          lastResult: attempt.status,
          lastError: "The polling window elapsed before a definitive result",
        });
      }
      return;
    }

    if (schedule) {
      const marked = await markGatewayInquiryRunning(this.db as Tx, schedule.id, now);
      if (!marked) {
        // The schedule was cancelled or superseded after the attempt was
        // claimed. Do not perform an inquiry the operator no longer wants.
        return;
      }
    }

    if (!this.inquiry) {
      const nextCheckAt = new Date(now.getTime() + delaySeconds * 1000);
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: nextCheckAt });
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "RETRYING",
          nextRunAt: nextCheckAt,
          lastError: "The gateway inquiry runtime is not configured",
        });
      }
      return;
    }

    let outcome: InquiryOutcome | null = null;
    try {
      outcome = await this.inquiry.inquire(attempt);
    } catch (error) {
      this.logger.warn("PollWorker: inquiry failed", { attemptId: attempt.id, error: (error as Error).message });
      const nextCheckAt = new Date(now.getTime() + delaySeconds * 1000);
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
        status: "UNKNOWN",
        nextCheckAt: nextCheckAt,
      });
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "RETRYING",
          nextRunAt: nextCheckAt,
          lastError: (error as Error).message,
        });
      }
      return;
    }

    if (!outcome) {
      const nextCheckAt = new Date(now.getTime() + delaySeconds * 1000);
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: nextCheckAt });
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "RETRYING",
          nextRunAt: nextCheckAt,
          lastError: "The gateway inquiry returned no result",
        });
      }
      return;
    }

    const terminal = TERMINAL_STATUSES.includes(outcome.status);
    if (terminal) {
      // The terminal transition is conditional on the attempt still being
      // open, so two cluster nodes can never terminate it twice.
      const transitioned = await this.terminate(attempt.id, outcome.status, now);
      if (!transitioned) {
        return;
      }
      if (outcome.settledAmount !== undefined && outcome.settledAmount !== null) {
        await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
          settledAmount: outcome.settledAmount,
        });
      }
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "COMPLETED",
          completedAt: now,
          lastResult: outcome.status,
        });
      }
    } else {
      const nextCheckAt = new Date(now.getTime() + delaySeconds * 1000);
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
        status: outcome.status,
        substatus: outcome.substatus ?? attempt.substatus ?? null,
        nextCheckAt: nextCheckAt,
      });
      if (schedule) {
        await updateGatewayInquiry(this.db as Tx, schedule.id, {
          status: "RETRYING",
          nextRunAt: nextCheckAt,
          lastResult: outcome.status,
        });
      }
    }

    if (terminal && (outcome.status === "FAILED" || outcome.status === "CANCELLED")) {
      await this.releaseSlot(attempt);
    }
  }

  /** Returns false only when the escalation could not be recorded. */
  private async escalateUnknown(attempt: PaymentAttemptRow, now: Date, elapsedSeconds: number): Promise<boolean> {
    try {
      const result = await this.unknownEscalator.escalate(attempt, {
        now,
        reason: `the polling window elapsed after ${elapsedSeconds}s without a definitive gateway answer`,
      });
      if (result.created) {
        this.logger.warn("PollWorker: stale UNKNOWN attempt escalated to an operator", {
          attemptId: attempt.id,
          operatorCaseId: result.caseId,
        });
      }
      return true;
    } catch (error) {
      this.logger.error("PollWorker: unable to escalate a stale UNKNOWN attempt", {
        attemptId: attempt.id,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Applies a terminal transition at most once. The row is only updated when
   * it is still non-terminal, which makes the worker safe to run on several
   * nodes at the same time.
   */
  private async terminate(attemptId: string, status: string, now: Date): Promise<boolean> {
    const result = await this.db.$executeRawUnsafe(
      "UPDATE payment_attempts SET status = $1, terminal_at = $2, next_check_at = NULL, updated_at = now() WHERE id = $3::uuid AND terminal_at IS NULL",
      status,
      now,
      attemptId,
    );
    return Number(result ?? 0) > 0;
  }

  private async releaseSlot(attempt: PaymentAttemptRow): Promise<void> {
    if (!attempt.linkId) return;
    try {
      await this.repositories.payments.updateLinkSlotCount(this.db as Tx, attempt.linkId, -1);
    } catch (error) {
      this.logger.error("PollWorker: unable to release link slot", {
        attemptId: attempt.id,
        error: (error as Error).message,
      });
    }
  }
}
