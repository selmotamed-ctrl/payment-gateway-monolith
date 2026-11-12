import { moneyToString, type Money } from "../db/money";
import { toCamelRows, postgresPlaceholders } from "../db/rawRows";
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
/**
 * An AML-held attempt is owned by its case until the case is resolved. Its
 * expiry is the case SLA, not the payment session TTL, so the generic sweeper
 * must never expire it (and must never release its reserved slot).
 */
const AML_HOLD_SUBSTATUS = "AML_HOLD";
/**
 * The states in which a money-moving step is in flight: the confirm claim moved the attempt to
 * AUTHORIZING (the SUBMIT stack is running) or the gateway answered "pending" (VERIFYING). With
 * `point_of_no_return` set, the gateway may have charged the payer. AWAITING_CUSTOMER is NOT one of
 * them although the flag stays set after a wrong OTP: the gateway answered definitively that no
 * money moved, so such a session expires normally.
 */
const MONEY_IN_FLIGHT_STATUSES = ["AUTHORIZING", "VERIFYING"];
const moneyMayHaveMoved = (row: { status: string; pointOfNoReturn?: boolean | null }): boolean =>
  row.pointOfNoReturn === true && MONEY_IN_FLIGHT_STATUSES.includes(row.status);

export class ExpirySweeperWorker extends BaseWorker {
  private readonly inquiry: InquiryPort | undefined;
  private inquirySupport = new Map<string, boolean>();

  protected override get singleton(): boolean {
    return true;
  }

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
    const statusPlaceholders = postgresPlaceholders(EXPIRABLE_STATUSES.length, 2);
    const substatusPlaceholder = `$${EXPIRABLE_STATUSES.length + 2}`;
    const limitPlaceholder = `$${EXPIRABLE_STATUSES.length + 3}`;
    const sql =
      "SELECT * FROM payment_attempts" +
      " WHERE expires_at IS NOT NULL" +
      " AND expires_at <= $1" +
      " AND terminal_at IS NULL" +
      ` AND status IN (${statusPlaceholders})` +
      ` AND (substatus IS NULL OR substatus <> ${substatusPlaceholder})` +
      " ORDER BY expires_at ASC" +
      ` LIMIT ${limitPlaceholder}` +
      " FOR UPDATE SKIP LOCKED";
    // The claim runs inside a transaction (a SKIP LOCKED lock outside one is
    // released immediately). There is no lease column for expiry, so cluster
    // exclusivity comes from the advisory-lock leader election (singleton) and
    // the conditional terminal transition below stays the last line of defence.
    const result = await this.inTransaction((tx) =>
      tx.$queryRawUnsafe(sql, now, ...EXPIRABLE_STATUSES, AML_HOLD_SUBSTATUS, this.batchSize),
    );
    return toCamelRows<PaymentAttemptRow>(result);
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

    // The row was read when the batch was claimed, and that lock is long gone: a payer may have
    // confirmed since (the claim moves the attempt to AUTHORIZING and sends the charge), and the
    // inquiry above may have moved it too. Decide on the row as it is NOW.
    const fresh = await this.reload(attempt.id);
    if (!fresh || fresh.terminalAt) {
      return;
    }
    // Past the point of no return a money-moving step was already sent, so the gateway may have
    // charged the payer. With no definitive answer the outcome is unknown, not expired: expiring
    // would make the attempt terminal, release its slot and drop it from polling, leaving a real
    // charge visible only to a callback or reconciliation.
    if (moneyMayHaveMoved(fresh)) {
      await this.holdAsUnknown(fresh, now);
      return;
    }
    if (!EXPIRABLE_STATUSES.includes(fresh.status)) {
      return; // for example UNKNOWN: the PollWorker owns it
    }

    const expired = await this.expireAttempt(fresh, now);
    if (!expired) {
      // The conditional expiry lost a race with a confirm that claimed the attempt in between.
      const latest = await this.reload(attempt.id);
      if (latest && !latest.terminalAt && moneyMayHaveMoved(latest)) {
        await this.holdAsUnknown(latest, now);
      }
    }
  }

  private async reload(attemptId: string): Promise<PaymentAttemptRow | null> {
    const rows = toCamelRows<PaymentAttemptRow>(
      await this.db.$queryRawUnsafe("SELECT * FROM payment_attempts WHERE id = $1::uuid", attemptId),
    );
    return rows[0] ?? null;
  }

  /**
   * Moves an expired attempt past the point of no return to UNKNOWN and makes it due for the
   * PollWorker, which inquires while the route's polling window is open and otherwise hands it to
   * an operator through one keyed UNKNOWN case (AUTO-19). The slot stays reserved. The update is
   * conditional on the status the sweeper observed, so it never overwrites a concurrent finalize.
   */
  private async holdAsUnknown(attempt: PaymentAttemptRow, now: Date): Promise<void> {
    // An inquiry the PollWorker already scheduled is kept, so a held attempt is not asked on
    // every sweeper tick.
    const result = await this.db.$executeRawUnsafe(
      "UPDATE payment_attempts SET status = 'UNKNOWN', next_check_at = COALESCE(next_check_at, $1), updated_at = now()" +
        " WHERE id = $2::uuid AND terminal_at IS NULL AND status = $3",
      now,
      attempt.id,
      attempt.status,
    );
    if (Number(result ?? 0) === 0) {
      return;
    }
    this.logger.warn("ExpirySweeperWorker: expired attempt past the point of no return held as UNKNOWN", {
      attemptId: attempt.id,
      previousStatus: attempt.status,
    });
    await this.repositories.governance.writeAuditLog(this.db as Tx, {
      actorId: null,
      role: "SYSTEM",
      action: "ATTEMPT_EXPIRY_HELD_UNKNOWN",
      entityType: "PAYMENT_ATTEMPT",
      entityId: attempt.id,
      beforeJson: { status: attempt.status },
      afterJson: { status: "UNKNOWN", reason: "EXPIRED_PAST_POINT_OF_NO_RETURN" },
    });
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
    // Never over a terminal attempt: the inquiry runs outside any transaction, and a verified
    // webhook may have settled the attempt while it was failing.
    await this.db.$executeRawUnsafe(
      "UPDATE payment_attempts SET status = 'UNKNOWN', next_check_at = $1, updated_at = now() WHERE id = $2::uuid AND terminal_at IS NULL",
      retryAt,
      attempt.id,
    );
  }

  /** Returns false when the attempt was not expired (it changed since it was read). */
  private async expireAttempt(attempt: PaymentAttemptRow, now: Date): Promise<boolean> {
    // The terminal transition is conditional on the row still being exactly what was decided
    // on: open, in the status that was read, and with no money-moving step in flight. Two
    // cluster nodes can never expire the same attempt twice (or release its slot twice), and a
    // confirm that claimed the attempt after it was read (status AUTHORIZING, charge sent) can
    // never be expired underneath: it was the bug that marked a charged payment EXPIRED.
    const result = await this.db.$executeRawUnsafe(
      "UPDATE payment_attempts SET status = 'EXPIRED', terminal_at = $1, next_check_at = NULL, updated_at = now()" +
        " WHERE id = $2::uuid AND terminal_at IS NULL AND status = $3" +
        " AND NOT (point_of_no_return = true AND status IN ('AUTHORIZING', 'VERIFYING'))",
      now,
      attempt.id,
      attempt.status,
    );
    if (Number(result ?? 0) === 0) {
      return false;
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
    return true;
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
      "UPDATE payment_attempts SET status = $1, terminal_at = $2, next_check_at = NULL, updated_at = now() WHERE id = $3::uuid AND terminal_at IS NULL",
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
