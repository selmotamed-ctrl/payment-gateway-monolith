import type { PrismaLike, Tx } from "../db/ports";
import type { DynamicAttempt, SlotReservation, SlotReservationStore } from "../flow/DynamicRailEngine";
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

  async commitSlot(attempt: DynamicAttempt, transaction?: unknown): Promise<void> {
    const target = (transaction ?? this.client) as PrismaLike;
    const linkId = await this.linkIdOf(target, attempt);
    if (!linkId) {
      return;
    }
    // The state is settled before the counters move: MySQL evaluates the
    // assignments of an UPDATE from left to right, so the case still reads the
    // confirmed count the link had before the commit.
    await target.$executeRawUnsafe(
      `UPDATE payment_links
          SET state = CASE WHEN infinite_use = 1 OR confirmed_count + 1 >= use_count THEN 'COMPLETED' ELSE state END,
              confirmed_count = confirmed_count + 1,
              active_locked_count = GREATEST(0, active_locked_count - 1),
              updated_at = NOW()
        WHERE id = ?`,
      linkId,
    );
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
