import { moneyToString, type Money } from "../db/money";
import { toCamelRows, mysqlPlaceholders } from "../db/rawRows";
import type { PaymentAttemptRow, Tx } from "../db/ports";
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
      "SELECT * FROM payment_attempts" +
      " WHERE expires_at IS NOT NULL" +
      " AND expires_at <= ?" +
      " AND terminal_at IS NULL" +
      ` AND status IN (${statusPlaceholders})` +
      " ORDER BY expires_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    const result = await this.db.$queryRawUnsafe(sql, now, ...EXPIRABLE_STATUSES, this.batchSize);
    return toCamelRows<PaymentAttemptRow>(result);
  }

  private async handleAttempt(attempt: PaymentAttemptRow, now: Date): Promise<void> {
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
      const transitioned = await this.terminate(attempt.id, {
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
    const transitioned = await this.terminate(attempt.id, {
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
    attemptId: string,
    columns: { status: string; terminal_at: Date; next_check_at: null },
  ): Promise<boolean> {
    const result = await this.db.$executeRawUnsafe(
      "UPDATE payment_attempts SET status = ?, terminal_at = ?, next_check_at = NULL, updated_at = NOW() WHERE id = ? AND terminal_at IS NULL",
      columns.status,
      columns.terminal_at,
      attemptId,
    );
    return Number(result ?? 0) > 0;
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
