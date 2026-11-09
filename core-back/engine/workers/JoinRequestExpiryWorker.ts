import { BaseWorker, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import type { PrismaLike } from "../db/ports";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { bilingualNotice, queueNotice, type NoticeDefinition } from "../../lib/automationNotices";

type Any = Record<string, any>;

export const DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Merchant notices (AUTO-13). Neutral by design: they never say anything about screening or review findings. */
export const JOIN_REQUEST_DRAFT_EXPIRED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "JOIN_REQUEST_DRAFT_EXPIRED",
  en: {
    subject: "Your merchant application draft has expired",
    body: "Your merchant application draft was not submitted within {{days}} days and has expired. You can start a new application at any time.",
  },
  ar: {
    subject: "انتهت صلاحية مسودة طلب الانضمام",
    body: "انتهت صلاحية مسودة طلب الانضمام الخاص بك لأنها لم تُرسل خلال {{days}} يوما. يمكنك بدء طلب جديد في أي وقت.",
  },
});

export const JOIN_REQUEST_REVIEW_EXPIRED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "JOIN_REQUEST_REVIEW_EXPIRED",
  en: {
    subject: "Your merchant application has expired",
    body: "We could not complete the review of your merchant application in time and it has expired. Please submit a new application.",
  },
  ar: {
    subject: "انتهت صلاحية طلب الانضمام",
    body: "لم نتمكن من إكمال مراجعة طلب الانضمام الخاص بك في الوقت المحدد وانتهت صلاحيته. يرجى تقديم طلب جديد.",
  },
});

export type JoinRequestExpiryReason = "DRAFT_ABANDONED" | "REVIEW_OVERDUE";

export interface ExpiredJoinRequest {
  id: string;
  merchantId: string;
  submittedByUserId: string;
  previousStatus: string;
}

export interface JoinRequestExpiryWorkerDeps extends WorkerOptions {
  /**
   * How long an untouched draft may stay open. Design §18 expects an abandoned
   * onboarding draft to be released, not to sit in `DRAFT` forever.
   */
  draftTtlMs?: number;
  /** Batches one tick may process per kind (the next tick continues). Default 5. */
  maxBatchesPerTick?: number;
  /** One audit row per expired request (default `writeSystemAudit`, the system actor). */
  audit?: (db: Any, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => Promise<void>;
  /** Queues the merchant notice (default `queueNotice`). */
  notify?: (db: Any, request: ExpiredJoinRequest, reason: JoinRequestExpiryReason, days: number) => Promise<void>;
}

/**
 * Expires the onboarding drafts that were abandoned, and the submitted requests
 * whose review SLA has elapsed (AUTO-13: with an audit row and a merchant notice).
 *
 * A `DRAFT` never reaches the review queue, so without this worker it lives
 * forever and the merchant's onboarding is stuck between `DRAFT` and
 * `SUBMITTED` with no way to reapply. A `SUBMITTED`/`IN_REVIEW` request whose
 * `sla_due_at` has passed is EXPIRED too, which is what the design's SLA
 * timers are for.
 *
 * Each batch is ONE statement (`UPDATE ... RETURNING`, bounded by `batchSize`) inside ONE transaction together with
 * its audit rows and notices: a request is never expired without its audit row, and a crash between them cannot lose
 * the notice (the notice event id is unique per request, so a repeat never sends twice). `PENDING_CHECKER` is never
 * touched: a decision waiting for its checker is not overdue.
 */
export class JoinRequestExpiryWorker extends BaseWorker {
  /** Cluster singleton: only the advisory-lock leader ticks (GAP-012). */
  protected override get singleton(): boolean {
    return true;
  }

  private readonly draftTtlMs: number;
  private readonly maxBatchesPerTick: number;
  private readonly audit: NonNullable<JoinRequestExpiryWorkerDeps["audit"]>;
  private readonly notify: NonNullable<JoinRequestExpiryWorkerDeps["notify"]>;

  constructor(deps: JoinRequestExpiryWorkerDeps) {
    super(deps);
    this.draftTtlMs = deps.draftTtlMs ?? DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS;
    this.maxBatchesPerTick = Math.max(1, Math.floor(deps.maxBatchesPerTick ?? 5));
    this.audit = deps.audit ?? writeSystemAudit;
    this.notify =
      deps.notify ??
      (async (db, request, reason, days) => {
        await queueNotice(db, {
          definition: reason === "DRAFT_ABANDONED" ? JOIN_REQUEST_DRAFT_EXPIRED_NOTICE : JOIN_REQUEST_REVIEW_EXPIRED_NOTICE,
          eventKey: `join-request-expired:${request.id}`,
          payload: { days },
          userId: request.submittedByUserId,
          merchantId: request.merchantId,
        });
      });
  }

  protected async tick(): Promise<WorkerTickResult> {
    const now = this.clock();
    const drafts = await this.expireAbandonedDrafts(now);
    const reviews = await this.expireOverdueReviews(now);
    return { processed: drafts + reviews };
  }

  private async expireAbandonedDrafts(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.draftTtlMs);
    const days = Math.max(1, Math.round(this.draftTtlMs / 86_400_000));
    const total = await this.drain(async (tx) =>
      toCamelRows<Record<string, unknown>>(
        await tx.$queryRawUnsafe(
          "WITH target AS (SELECT id, status FROM join_requests WHERE status = 'DRAFT' AND created_at < $2 AND updated_at < $3" +
            " ORDER BY created_at ASC LIMIT $4 FOR UPDATE SKIP LOCKED)" +
            " UPDATE join_requests j SET status = 'EXPIRED', updated_at = $1 FROM target t WHERE j.id = t.id" +
            " RETURNING j.id, j.merchant_id, j.submitted_by_user_id, t.status::text AS previous_status",
          now,
          cutoff,
          cutoff,
          this.batchSize,
        ),
      ),
      "DRAFT_ABANDONED",
      days,
      { cutoff: cutoff.toISOString() },
    );
    if (total > 0) {
      this.logger.info("JoinRequestExpiryWorker: expired abandoned drafts", { expired: total, cutoff: cutoff.toISOString() });
    }
    return total;
  }

  private async expireOverdueReviews(now: Date): Promise<number> {
    const total = await this.drain(async (tx) =>
      toCamelRows<Record<string, unknown>>(
        await tx.$queryRawUnsafe(
          "WITH target AS (SELECT id, status FROM join_requests WHERE status IN ('SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED')" +
            " AND sla_due_at <= $2 ORDER BY sla_due_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED)" +
            " UPDATE join_requests j SET status = 'EXPIRED', updated_at = $1 FROM target t WHERE j.id = t.id" +
            " RETURNING j.id, j.merchant_id, j.submitted_by_user_id, t.status::text AS previous_status",
          now,
          now,
          this.batchSize,
        ),
      ),
      "REVIEW_OVERDUE",
      0,
      {},
    );
    if (total > 0) {
      this.logger.info("JoinRequestExpiryWorker: expired overdue reviews", { expired: total });
    }
    return total;
  }

  /** Runs batches (each in its own transaction with its audit rows and notices) until one comes back short. */
  private async drain(
    expire: (tx: Any) => Promise<Array<Record<string, unknown>>>,
    reason: JoinRequestExpiryReason,
    days: number,
    extra: Record<string, unknown>,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < this.maxBatchesPerTick; batch += 1) {
      const expired = await this.inTransaction(async (tx) => {
        const rows = await expire(tx as Any);
        for (const row of rows) {
          const request: ExpiredJoinRequest = {
            id: String(row.id),
            merchantId: String(row.merchantId),
            submittedByUserId: String(row.submittedByUserId),
            previousStatus: String(row.previousStatus ?? ""),
          };
          await this.audit(tx as Any, {
            action: "JOIN_REQUEST_EXPIRED",
            entityType: "JOIN_REQUEST",
            entityId: request.id,
            before: { status: request.previousStatus },
            after: { status: "EXPIRED", reason, ...extra },
          });
          await this.notify(tx as Any, request, reason, days);
        }
        return rows.length;
      });
      total += expired;
      if (expired < this.batchSize) break;
    }
    return total;
  }
}

export type { PrismaLike };
