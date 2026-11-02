import { moneyToString, type Money } from "../db/money";
import { toCamelRows, mysqlPlaceholders } from "../db/rawRows";
import type { PaymentAttemptRow, Tx } from "../db/ports";
import {
  recordAttemptLifecycle,
  type AttemptLifecycleEvent,
} from "../../lib/counters/materializedCounters";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface InquiryOutcome {
  status: string;
  substatus?: string | null;
  settledAmount?: unknown;
  providerFee?: unknown;
  definitive: boolean;
}

export interface InquiryPort {
  inquire(attempt: PaymentAttemptRow): Promise<InquiryOutcome>;
}

export interface ExpirySweeperWorkerDeps extends WorkerOptions {
  inquiry?: InquiryPort;
}

const EXPIRABLE_STATUSES = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING"];
const RELEASE_SLOT_STATUSES = ["FAILED", "EXPIRED", "CANCELLED"];
/**
 * An AML-held attempt is owned by its case until the case is resolved. Its
 * expiry is the case SLA, not the payment session TTL, so the generic sweeper
 * must never expire it (and must never release its reserved slot).
 */
const AML_HOLD_SUBSTATUS = "AML_HOLD";
const EXPIRY_CLAIM_LEASE_MS = 5 * 60 * 1000;
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

export class ExpirySweeperWorker extends BaseWorker {
  private readonly inquiry: InquiryPort | undefined;
  private inquirySupport = new Map<string, boolean>();

  constructor(deps: ExpirySweeperWorkerDeps) {
    super(deps);
    this.inquiry = deps.inquiry;
  }

  protected async tick(): Promise<void> {
    const now = this.clock();
    const attempts = await this.lockExpiredAttempts(now);
    if (attempts.length === 0) return;
    await this.refreshInquirySupport();
    for (const attempt of attempts) {
      await this.handleAttempt(attempt, now);
    }
  }

  private async refreshInquirySupport(): Promise<void> {
    try {
      const support = await this.repositories.payments.listRouteInquirySupport(this.db as Tx);
      this.inquirySupport = new Map(support.map((entry) => [entry.routeId, entry.supportsStatusCheck]));
    } catch (error) {
      this.logger.warn("ExpirySweeperWorker: unable to refresh inquiry support", {
        error: (error as Error).message,
      });
    }
  }

  private async lockExpiredAttempts(now: Date): Promise<PaymentAttemptRow[]> {
    const statusPlaceholders = mysqlPlaceholders(EXPIRABLE_STATUSES.length);
    const sql =
      `SELECT ${ATTEMPT_CLAIM_COLUMNS} FROM payment_attempts` +
      " WHERE expires_at IS NOT NULL" +
      " AND expires_at <= ?" +
      " AND terminal_at IS NULL" +
      ` AND status IN (${statusPlaceholders})` +
      " AND (substatus IS NULL OR substatus <> ?)" +
      " AND (next_check_at IS NULL OR next_check_at <= ?)" +
      " ORDER BY expires_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    // Selection and claim share one short transaction. The gateway inquiry is
    // made only after the claim commits, and the existing `next_check_at`
    // column carries the short lease.
    return this.db.$transaction(async (tx: Tx) => {
      const result = await tx.$queryRawUnsafe(
        sql,
        now,
        ...EXPIRABLE_STATUSES,
        AML_HOLD_SUBSTATUS,
        now,
        this.batchSize,
      );
      const attempts = toCamelRows<PaymentAttemptRow>(result)
        .filter((attempt) => attempt.substatus !== AML_HOLD_SUBSTATUS);
      if (attempts.length === 0) {
        return attempts;
      }
      const leaseUntil = new Date(now.getTime() + EXPIRY_CLAIM_LEASE_MS);
      const idPlaceholders = mysqlPlaceholders(attempts.length);
      await tx.$executeRawUnsafe(
        `UPDATE payment_attempts SET next_check_at = ?, updated_at = NOW() WHERE id IN (${idPlaceholders})`,
        leaseUntil,
        ...attempts.map((attempt) => attempt.id),
      );
      return attempts;
    });
  }

  private async handleAttempt(attempt: PaymentAttemptRow, now: Date): Promise<void> {
    // Defence in depth: even if a held attempt is handed to the worker (for
    // example by a stale lock snapshot), the AML case remains its only writer.
    if (attempt.substatus === AML_HOLD_SUBSTATUS) {
      return;
    }
    const routeId = attempt.routeId;
    const supportsInquiry = routeId ? this.inquirySupport.get(routeId) === true : false;

    if (supportsInquiry && this.inquiry) {
      let outcome: InquiryOutcome | null = null;
      try {
        outcome = await this.inquiry.inquire(attempt);
      } catch (error) {
        this.logger.warn("ExpirySweeperWorker: inquiry failed, attempt kept open", {
          attemptId: attempt.id,
          error: (error as Error).message,
        });
        await this.deferAttempt(attempt, now);
        return;
      }

      if (outcome && outcome.definitive) {
        await this.applyInquiryOutcome(attempt, outcome, now);
        return;
      }
    }

    await this.expireAttempt(attempt, now);
  }

  private async applyInquiryOutcome(attempt: PaymentAttemptRow, outcome: InquiryOutcome, now: Date): Promise<void> {
    const terminal = ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"].includes(outcome.status);
    if (terminal) {
      const transitioned = await this.terminate(attempt, {
        status: outcome.status,
        terminal_at: now,
        next_check_at: null,
      });
      if (!transitioned) {
        return;
      }
      if (outcome.settledAmount !== undefined && outcome.settledAmount !== null) {
        await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
          settledAmount: outcome.settledAmount,
        });
      }
      if (outcome.providerFee !== undefined && outcome.providerFee !== null) {
        await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
          gatewayFeeAmount: outcome.providerFee,
        });
      }
    } else {
      await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
        status: outcome.status,
        substatus: outcome.substatus ?? attempt.substatus ?? null,
      });
    }
    if (terminal && RELEASE_SLOT_STATUSES.includes(outcome.status)) {
      await this.releaseSlot(attempt);
    }
    await this.repositories.governance.writeAuditLog(this.db as Tx, {
      actorId: null,
      role: "SYSTEM",
      action: "ATTEMPT_EXPIRY_INQUIRY_RESOLVED",
      entityType: "PAYMENT_ATTEMPT",
      entityId: attempt.id,
      afterJson: { status: outcome.status, substatus: outcome.substatus ?? null },
    });
  }

  private async deferAttempt(attempt: PaymentAttemptRow, now: Date): Promise<void> {
    const retryAt = new Date(now.getTime() + 60_000);
    await this.repositories.payments.updateAttempt(this.db as Tx, attempt.id, {
      status: "UNKNOWN",
      nextCheckAt: retryAt,
    });
  }

  private async expireAttempt(attempt: PaymentAttemptRow, now: Date): Promise<void> {
    // The terminal transition is conditional, so two cluster nodes can never
    // expire the same attempt twice (and can never release its slot twice).
    const transitioned = await this.terminate(attempt, {
      status: "EXPIRED",
      terminal_at: now,
      next_check_at: null,
    });
    if (!transitioned) {
      return;
    }
    await this.releaseSlot(attempt);
    await this.repositories.governance.writeAuditLog(this.db as Tx, {
      actorId: null,
      role: "SYSTEM",
      action: "ATTEMPT_EXPIRED",
      entityType: "PAYMENT_ATTEMPT",
      entityId: attempt.id,
      afterJson: { status: "EXPIRED", graceExpiresAt: attempt.graceExpiresAt ?? null },
    });
  }

  /**
   * Applies a terminal transition at most once. The row is only updated when
   * it is still non-terminal, which makes the worker safe to run on several
   * nodes at the same time.
   */
  private async terminate(
    attempt: PaymentAttemptRow,
    columns: { status: string; terminal_at: Date; next_check_at: null },
  ): Promise<boolean> {
    return this.db.$transaction(async (tx: Tx) => {
      const result = await tx.$executeRawUnsafe(
        "UPDATE payment_attempts SET status = ?, terminal_at = ?, next_check_at = NULL, updated_at = NOW() WHERE id = ? AND terminal_at IS NULL",
        columns.status,
        columns.terminal_at,
        attempt.id,
      );
      if (Number(result ?? 0) <= 0) {
        return false;
      }
      const event = lifecycleEventForTerminal(columns.status);
      if (event) {
        await recordAttemptLifecycle(tx, {
          attemptId: attempt.id,
          event,
          previousStatus: attempt.status,
          at: columns.terminal_at,
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
      this.logger.error("ExpirySweeperWorker: unable to release link slot", {
        attemptId: attempt.id,
        linkId: attempt.linkId,
        error: (error as Error).message,
      });
    }
  }
}

export const expiryWorkerMoney = (value: Money): string => moneyToString(value);
