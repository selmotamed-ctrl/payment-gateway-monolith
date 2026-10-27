import { toCamelRows, mysqlPlaceholders } from "../db/rawRows";
import type { PaymentAttemptRow, Tx } from "../db/ports";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";
import type { InquiryOutcome, InquiryPort } from "./ExpirySweeperWorker";

export interface PollWorkerDeps extends WorkerOptions {
  inquiry?: InquiryPort;
  defaultFirstAfterSeconds?: number;
  defaultBackoffSeconds?: number[];
  defaultMaxDurationSeconds?: number;
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
  private policies = new Map<string, PollPolicy>();

  constructor(deps: PollWorkerDeps) {
    super(deps);
    this.inquiry = deps.inquiry;
    this.defaultFirstAfterSeconds = deps.defaultFirstAfterSeconds ?? 5;
    this.defaultBackoffSeconds = deps.defaultBackoffSeconds ?? [5, 15, 30, 60, 120, 300];
    this.defaultMaxDurationSeconds = deps.defaultMaxDurationSeconds ?? 900;
  }

  protected async tick(): Promise<void> {
    const now = this.clock();
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
    const statusPlaceholders = mysqlPlaceholders(POLLABLE_STATUSES.length);
    const sql =
      "SELECT * FROM payment_attempts" +
      " WHERE next_check_at IS NOT NULL" +
      " AND next_check_at <= ?" +
      " AND terminal_at IS NULL" +
      ` AND status IN (${statusPlaceholders})` +
      " ORDER BY next_check_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    const result = await this.db.$queryRawUnsafe(sql, now, ...POLLABLE_STATUSES, this.batchSize);
    return toCamelRows<PaymentAttemptRow>(result);
  }

  private async pollAttempt(attempt: PaymentAttemptRow, now: Date): Promise<void> {
    const policy = this.policyFor(attempt);

    if (policy.stopOnStates.includes(attempt.status)) {
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: null });
      return;
    }

    const createdAt = attempt.createdAt ?? attempt.createdAt ?? now;
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 1000));
    const delaySeconds = computeBackoffDelaySeconds(policy, elapsedSeconds);

    if (delaySeconds === null) {
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: null });
      return;
    }

    if (!this.inquiry) {
      const nextCheckAt = new Date(now.getTime() + delaySeconds * 1000);
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: nextCheckAt });
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
      return;
    }

    if (!outcome) {
      const nextCheckAt = new Date(now.getTime() + delaySeconds * 1000);
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, { nextCheckAt: nextCheckAt });
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
    } else {
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
        status: outcome.status,
        substatus: outcome.substatus ?? attempt.substatus ?? null,
        nextCheckAt: new Date(now.getTime() + delaySeconds * 1000),
      });
    }

    if (terminal && (outcome.status === "FAILED" || outcome.status === "CANCELLED")) {
      await this.releaseSlot(attempt);
    }
  }

  /**
   * Applies a terminal transition at most once. The row is only updated when
   * it is still non-terminal, which makes the worker safe to run on several
   * nodes at the same time.
   */
  private async terminate(attemptId: string, status: string, now: Date): Promise<boolean> {
    const result = await this.db.$executeRawUnsafe(
      "UPDATE payment_attempts SET status = ?, terminal_at = ?, next_check_at = NULL, updated_at = NOW() WHERE id = ? AND terminal_at IS NULL",
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
