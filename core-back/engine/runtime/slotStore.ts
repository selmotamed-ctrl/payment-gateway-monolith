import type { PrismaLike } from "../db/ports";
import type { DynamicAttempt, SlotReservation, SlotReservationStore } from "../flow/DynamicRailEngine";
import { ApiError } from "../../lib/error";

/**
 * Prisma-backed slot reservation store.
 *
 * The reservation is a single conditional UPDATE so that two concurrent
 * requests can never both take the last slot:
 *
 *   UPDATE payment_links
 *      SET active_locked_count = active_locked_count + 1
 *    WHERE id = $1
 *      AND (infinite_use = true OR confirmed_count + active_locked_count < use_count)
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
    const rows = (await target.$queryRawUnsafe(
      "UPDATE payment_links SET active_locked_count = active_locked_count + 1, updated_at = NOW() WHERE id = $1 AND (infinite_use = true OR confirmed_count + active_locked_count < use_count) RETURNING id",
      linkId,
    )) as Array<{ id: string }>;
    if (!Array.isArray(rows) || rows.length === 0) {
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
    await target.$queryRawUnsafe(
      "UPDATE payment_links SET active_locked_count = GREATEST(0, active_locked_count - 1), updated_at = NOW() WHERE id = $1",
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
    await target.$queryRawUnsafe(
      `UPDATE payment_links
          SET confirmed_count = confirmed_count + 1,
              active_locked_count = GREATEST(0, active_locked_count - 1),
              state = CASE WHEN infinite_use = true OR confirmed_count + 1 >= use_count THEN 'COMPLETED' ELSE state END,
              updated_at = NOW()
        WHERE id = $1`,
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
