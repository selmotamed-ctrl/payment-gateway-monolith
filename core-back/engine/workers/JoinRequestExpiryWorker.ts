import { BaseWorker, type WorkerOptions } from "./workerRuntime";
import type { PrismaLike } from "../db/ports";
import { toCamelRows, mysqlPlaceholders } from "../db/rawRows";

export interface JoinRequestExpiryWorkerDeps extends WorkerOptions {
  /**
   * How long an untouched draft may stay open. Design §18 expects an abandoned
   * onboarding draft to be released, not to sit in `DRAFT` forever.
   */
  draftTtlMs?: number;
}

export const DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Expires the onboarding drafts that were abandoned, and the submitted requests
 * whose review SLA has elapsed.
 *
 * A `DRAFT` never reaches the review queue, so without this worker it lives
 * forever and the merchant's onboarding is stuck between `DRAFT` and
 * `SUBMITTED` with no way to reapply. A `SUBMITTED`/`IN_REVIEW` request whose
 * `sla_due_at` has passed is EXPIRED too, which is what the design's SLA
 * timers are for.
 */
export class JoinRequestExpiryWorker extends BaseWorker {
  private readonly draftTtlMs: number;

  constructor(deps: JoinRequestExpiryWorkerDeps) {
    super(deps);
    this.draftTtlMs = deps.draftTtlMs ?? DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS;
  }

  protected async tick(): Promise<void> {
    const now = this.clock();
    await this.expireAbandonedDrafts(now);
    await this.expireOverdueReviews(now);
  }

  private async expireAbandonedDrafts(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - this.draftTtlMs);
    const result = await this.db.$executeRawUnsafe(
      "UPDATE `join_requests` SET `status` = 'EXPIRED', `updated_at` = ?" +
        " WHERE `status` = 'DRAFT' AND `created_at` < ? AND `updated_at` < ?",
      now,
      cutoff,
      cutoff,
    );
    const expired = Number(result ?? 0);
    if (expired > 0) {
      this.logger.info("JoinRequestExpiryWorker: expired abandoned drafts", {
        expired,
        cutoff: cutoff.toISOString(),
      });
    }
  }

  private async expireOverdueReviews(now: Date): Promise<void> {
    const statuses = ["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"];
    const placeholders = mysqlPlaceholders(statuses.length);
    const sql =
      "SELECT `id` FROM `join_requests`" +
      ` WHERE \`status\` IN (${placeholders})` +
      " AND `sla_due_at` <= ? AND `status` <> 'PENDING_CHECKER'" +
      " ORDER BY `sla_due_at` ASC LIMIT ?";
    const rows = toCamelRows<{ id: string }>(
      await this.db.$queryRawUnsafe(sql, ...statuses, now, this.batchSize),
    );
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      await this.db.$executeRawUnsafe(
        "UPDATE `join_requests` SET `status` = 'EXPIRED', `updated_at` = ?" +
          " WHERE `id` = ? AND `status` IN ('SUBMITTED','IN_REVIEW','INFO_REQUESTED')",
        now,
        row.id,
      );
    }
    this.logger.info("JoinRequestExpiryWorker: expired overdue reviews", { expired: rows.length });
  }
}

export type { PrismaLike };
