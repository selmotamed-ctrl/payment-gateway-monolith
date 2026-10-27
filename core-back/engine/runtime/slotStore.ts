import { Decimal } from "decimal.js";
import type { PrismaLike, Tx } from "../db/ports";
import type {
  DynamicAttempt,
  SlotCommitResult,
  SlotReservation,
  SlotReservationStore,
} from "../flow/DynamicRailEngine";
import { buildLedgerTemplate, decimal, LedgerPoster, type LedgerPostContext } from "../ledger/LedgerPoster";
import { ApiError } from "../../lib/error";

/**
 * Prisma-backed slot reservation store.
 *
 * MySQL/MariaDB has no `UPDATE ... RETURNING`, so the reservation is a pair
 * of statements that run in a single transaction:
 *
 *   SELECT id FROM payment_links
 *    WHERE id = ?
 *      AND (infinite_use = 1 OR confirmed_count + active_locked_count < use_count)
 *    FOR UPDATE
 *
 *   UPDATE payment_links
 *      SET active_locked_count = active_locked_count + 1, updated_at = NOW()
 *    WHERE id = ?
 *      AND (infinite_use = 1 OR confirmed_count + active_locked_count < use_count)
 *
 * The row lock is taken before the counter is incremented, so two cluster
 * nodes can never both take the last slot: the second one waits for the lock
 * and then finds no free slot anymore. When the update affects no row the
 * reservation failed.
 *
 * The slot is released on a terminal non-successful outcome and committed
 * (converted into a confirmed slot) when the attempt succeeds.
 */
export class PrismaSlotReservationStore implements SlotReservationStore {
  private readonly client: PrismaLike;

  constructor(client: PrismaLike) {
    this.client = client;
  }

  async reserveSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<SlotReservation> {
    const target = (transaction ?? this.client) as PrismaLike;
    const linkId = await this.linkIdOf(target, attempt);
    if (!linkId) {
      throw new ApiError(409, "SLOT_RESERVATION_FAILED", "The attempt is not bound to a payment link");
    }
    const reserve = async (tx: PrismaLike): Promise<boolean> => {
      const locked = (await tx.$queryRawUnsafe(
        "SELECT id FROM payment_links WHERE id = ? AND (infinite_use = 1 OR confirmed_count + active_locked_count < use_count) FOR UPDATE",
        linkId,
      )) as Array<{ id: string }>;
      if (!Array.isArray(locked) || locked.length === 0) {
        return false;
      }
      const updated = await tx.$executeRawUnsafe(
        "UPDATE payment_links SET active_locked_count = active_locked_count + 1, updated_at = NOW() WHERE id = ? AND (infinite_use = 1 OR confirmed_count + active_locked_count < use_count)",
        linkId,
      );
      return Number(updated ?? 0) > 0;
    };
    const reserved = transaction
      ? await reserve(target)
      : await this.client.$transaction((tx: Tx) => reserve(tx as PrismaLike));
    if (!reserved) {
      throw new ApiError(409, "PAYMENT_LINK_SLOT_UNAVAILABLE", "The payment link has no available slot");
    }
    return { reservationId: `${linkId}:${attempt.id}`, linkId };
  }

  async releaseSlot(attempt: DynamicAttempt, reason: string, transaction?: unknown): Promise<void> {
    const target = (transaction ?? this.client) as PrismaLike;
    const linkId = await this.linkIdOf(target, attempt);
    if (!linkId) {
      return;
    }
    await target.$executeRawUnsafe(
      "UPDATE payment_links SET active_locked_count = GREATEST(0, active_locked_count - 1), updated_at = NOW() WHERE id = ?",
      linkId,
    );
    await target.paymentAttempt.update({
      where: { id: attempt.id },
      data: { substatus: reason },
    });
  }

  /**
   * Commits a reserved slot into a confirmed one.
   *
   * The link row is locked first, so the decision and the counter update are
   * taken against the same state even on a multi-node cluster. When the link
   * is not infinite and the commit would take `confirmed_count` above
   * `use_count`, the counters are deliberately NOT advanced: the settlement is
   * real money but there is no slot for it, so it is routed to SUSPENSE and an
   * automatic refund is drafted (design §9.1 rule 6). The distinct outcome lets
   * the engine avoid reporting the settlement as a normal SUCCEEDED and lets it
   * keep the whole decision inside the posting transaction.
   */
  async commitSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<SlotCommitResult> {
    const target = (transaction ?? this.client) as PrismaLike;
    const linkId = await this.linkIdOf(target, attempt);
    if (!linkId) {
      return { outcome: "COMMITTED" };
    }
    // The conditional update is the atomic decision: it takes the row lock
    // and only advances the counters when a slot is still free. The state is
    // settled before the counters move because MySQL evaluates the assignments
    // of an UPDATE from left to right.
    const updated = Number(
      await target.$executeRawUnsafe(
        `UPDATE payment_links
            SET state = CASE WHEN infinite_use = 0 AND confirmed_count + 1 >= use_count THEN 'COMPLETED' ELSE state END,
                confirmed_count = confirmed_count + 1,
                active_locked_count = GREATEST(0, active_locked_count - 1),
                updated_at = NOW()
          WHERE id = ?
            AND (infinite_use = 1 OR confirmed_count + 1 <= use_count)`,
        linkId,
      ) ?? 0,
    );
    if (updated > 0) {
      return { outcome: "COMMITTED" };
    }
    // No row moved: either the link is gone, or the settlement would have
    // pushed a non-infinite link past `use_count`. Read the locked row to take
    // the safe path for the latter.
    const rows = (await target.$queryRawUnsafe(
      `SELECT confirmed_count, active_locked_count, use_count, infinite_use, state
         FROM payment_links
        WHERE id = ?
        FOR UPDATE`,
      linkId,
    )) as Array<Record<string, unknown>>;
    const link = rows[0];
    if (!link) {
      // The link vanished between the attempt and the commit. There is no
      // capacity we can safely rely on, so the money goes to SUSPENSE rather
      // than being reported as a normal merchant credit.
      return this.routeToSuspense(target, attempt, linkId, 0, 1);
    }
    const confirmedCount = Number(link.confirmed_count ?? 0);
    const useCount = Number(link.use_count ?? 1);
    return this.routeToSuspense(target, attempt, linkId, confirmedCount, useCount);
  }

  /**
   * Books an excess settlement to SUSPENSE instead of the merchant.
   *
   * The settlement journal, the automatic refund draft and the P1 operator
   * case all use the caller's transaction, so the money movement and the
   * evidence around it commit or roll back together.
   */
  private async routeToSuspense(
    target: PrismaLike,
    attempt: DynamicAttempt,
    linkId: string,
    confirmedCount: number,
    useCount: number,
  ): Promise<SlotCommitResult> {
    // Release the reservation the attempt may still hold. `confirmed_count`
    // is never incremented, so `payment_links_slot_reservation_invariant`
    // cannot be violated.
    await target.$executeRawUnsafe(
      `UPDATE payment_links
          SET state = CASE WHEN infinite_use = 0 AND confirmed_count >= use_count THEN 'COMPLETED' ELSE state END,
              active_locked_count = GREATEST(0, active_locked_count - 1),
              updated_at = NOW()
        WHERE id = ?`,
      linkId,
    );

    const amount = decimal(attempt.totalChargedAmount ?? attempt.requestedAmount);
    const template = buildLedgerTemplate("SUSPENSE_SETTLEMENT", {
      amount,
      ownershipMode: attempt.ownershipMode,
    });
    template.refId = attempt.id;
    const poster = new LedgerPoster(target as never);
    const posted = await poster.post(template, this.ledgerContext(attempt), target as never);

    const suspenseAccountId = await this.suspenseAccountId(target, attempt.currency);
    const adjustment = await this.ensureRefundAdjustment(
      target,
      attempt,
      linkId,
      amount,
      suspenseAccountId,
      confirmedCount,
      useCount,
    );
    const operatorCase = await this.ensureOperatorCase(target, attempt, linkId, amount);

    return {
      outcome: "SUSPENSE",
      journalEntryId: posted.entry.id,
      adjustmentId: String(adjustment.id),
      operatorCaseId: String(operatorCase.id),
      reason: "SLOT_ALREADY_SETTLED",
    };
  }

  private ledgerContext(attempt: DynamicAttempt): LedgerPostContext {
    return {
      merchantId: attempt.merchantId,
      gatewayId: attempt.gatewayId,
      credentialSetId: attempt.credentialSetId,
      env: attempt.env,
      currency: attempt.currency,
    };
  }

  private async suspenseAccountId(target: PrismaLike, currency: string | undefined): Promise<string> {
    const account = await target.glAccount.findFirst({
      where: {
        accountType: "SUSPENSE",
        ...(currency ? { currency } : {}),
      },
      select: { id: true },
    });
    const resolved = account ?? (await target.glAccount.findFirst({
      where: { accountType: "SUSPENSE" },
      select: { id: true },
    }));
    if (!resolved) {
      throw new ApiError(400, "GL_ACCOUNT_NOT_FOUND", "No SUSPENSE account matched the posting context");
    }
    return String((resolved as { id: unknown }).id);
  }

  private async ensureRefundAdjustment(
    target: PrismaLike,
    attempt: DynamicAttempt,
    linkId: string,
    amount: Decimal,
    suspenseAccountId: string,
    confirmedCount: number,
    useCount: number,
  ): Promise<{ id: unknown }> {
    const existing = await target.adjustment.findFirst({
      where: { sourceAttemptId: attempt.id, type: "REFUND" },
    });
    if (existing) {
      return existing as { id: unknown };
    }
    const adjustment = await target.adjustment.create({
      data: {
        type: "REFUND",
        targetGlAccountId: suspenseAccountId,
        sourceAttemptId: attempt.id,
        draftedBySystem: true,
        amount,
        reverseCommission: false,
        reason:
          `Automatic refund draft: the settlement of attempt ${attempt.id} was routed to SUSPENSE `
          + `because payment link ${linkId} already used ${confirmedCount} of ${useCount} slot(s).`,
        state: "PENDING_REVIEW",
      },
    });
    return adjustment as { id: unknown };
  }

  private async ensureOperatorCase(
    target: PrismaLike,
    attempt: DynamicAttempt,
    linkId: string,
    amount: Decimal,
  ): Promise<{ id: unknown }> {
    const existing = await target.operatorCase.findFirst({
      where: { attemptId: attempt.id, kind: "LATE_SUCCESS" },
    });
    if (existing) {
      return existing as { id: unknown };
    }
    const operatorCase = await target.operatorCase.create({
      data: {
        attemptId: attempt.id,
        kind: "LATE_SUCCESS",
        priority: "P1",
        state: "OPEN",
        slaDueAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        resolutionNotes:
          `Settlement of ${amount.toFixed(4)} on link ${linkId} was routed to SUSPENSE; `
          + "an automatic refund adjustment is waiting for review.",
      },
    });
    return operatorCase as { id: unknown };
  }

  private async linkIdOf(target: PrismaLike, attempt: DynamicAttempt): Promise<string | null> {
    if (attempt.linkId) {
      return attempt.linkId;
    }
    const row = await target.paymentAttempt.findUnique({
      where: { id: attempt.id },
      select: { linkId: true },
    });
    return row?.linkId ?? null;
  }
}
