import { toCamelRows, mysqlPlaceholders } from "../db/rawRows";
import type { PaymentAttemptRow, Tx } from "../db/ports";
import {
  recordAttemptLifecycle,
  type AttemptLifecycleEvent,
} from "../../lib/counters/materializedCounters";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";
import type { InquiryOutcome, InquiryPort } from "./ExpirySweeperWorker";
import {
  findActiveGatewayInquiry,
  markGatewayInquiryRunning,
  reconcileGatewayInquiries,
  updateGatewayInquiry,
} from "./GatewayInquirySchedules";

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
const POLL_CLAIM_LEASE_MS = 5 * 60 * 1000;
const lifecycleEventForTerminal = (status: string): AttemptLifecycleEvent | null => {
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (status === "FAILED" || status === "BLOCKED") return "FAILED";
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "CANCELLED") return "CANCELLED";
  return null;
};
const ATTEMPT_CLAIM_COLUMNS = [
  "id", "reference", "idempotency_key", "link_id", "attempt_group_id",
  "application_id", "merchant_id", "rail_id", "route_id", "credential_set_id",
  "gateway_version_id", "commission_profile_id", "env", "mode", "sub_mode",
  "status", "substatus", "gateway_reference", "provider_reference",
  "network_reference", "requested_amount", "surcharge_amount",
  "total_charged_amount", "gateway_amount_wire", "settled_amount",
  "gateway_fee_amount", "platform_commission_amount", "net_merchant_amount",
  "fee_bearer", "currency", "point_of_no_return", "otp_attempts",
  "last_otp_sent_at", "client_ip", "end_client_ip", "end_client_phone_hash",
  "end_client_card_alias", "expires_at", "grace_expires_at", "next_check_at",
  "ledger_entry_id", "terminal_at", "created_at", "updated_at",
].join(", ");

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
    const statusPlaceholders = mysqlPlaceholders(POLLABLE_STATUSES.length);
    const sql =
      `SELECT ${ATTEMPT_CLAIM_COLUMNS} FROM payment_attempts` +
      " WHERE next_check_at IS NOT NULL" +
      " AND next_check_at <= ?" +
      " AND terminal_at IS NULL" +
      ` AND status IN (${statusPlaceholders})` +
      " ORDER BY next_check_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    // The selection and the claim transition share one short transaction. The
    // lease is written to the existing `next_check_at` column, so no new
    // column is required. The gateway inquiry runs after the commit.
    return this.db.$transaction(async (tx: Tx) => {
      const result = await tx.$queryRawUnsafe(sql, now, ...POLLABLE_STATUSES, this.batchSize);
      const attempts = toCamelRows<PaymentAttemptRow>(result);
      if (attempts.length === 0) {
        return attempts;
      }
      const leaseUntil = new Date(now.getTime() + POLL_CLAIM_LEASE_MS);
      const idPlaceholders = mysqlPlaceholders(attempts.length);
      await tx.$executeRawUnsafe(
        `UPDATE payment_attempts SET next_check_at = ?, updated_at = NOW() WHERE id IN (${idPlaceholders})`,
        leaseUntil,
        ...attempts.map((attempt) => attempt.id),
      );
      return attempts;
    });
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
      const transitioned = await this.terminate(attempt, outcome.status, now);
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

  /**
   * Applies a terminal transition at most once. The row is only updated when
   * it is still non-terminal, which makes the worker safe to run on several
   * nodes at the same time.
   */
  private async terminate(attempt: PaymentAttemptRow, status: string, now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx: Tx) => {
      const result = await tx.$executeRawUnsafe(
        "UPDATE payment_attempts SET status = ?, terminal_at = ?, next_check_at = NULL, updated_at = NOW() WHERE id = ? AND terminal_at IS NULL",
        status,
        now,
        attempt.id,
      );
      if (Number(result ?? 0) <= 0) {
        return false;
      }
      const event = lifecycleEventForTerminal(status);
      if (event) {
        await recordAttemptLifecycle(tx, {
          attemptId: attempt.id,
          event,
          previousStatus: attempt.status,
          at: now,
        });
      }
      return true;
    });
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
