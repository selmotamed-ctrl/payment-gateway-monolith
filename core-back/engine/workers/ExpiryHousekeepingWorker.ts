import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { normalizeApprovalSubjectType } from "../../lib/approvalQueue";
import { bilingualNotice, maskNoticeAddress, queueNotice, type NoticeDefinition } from "../../lib/automationNotices";

type Any = Record<string, any>;

/**
 * Time-driven housekeeping of rows that expire silently (AUTO-05, AUTO-11). Cluster singleton, every 15 minutes.
 *
 * Six bounded passes (each at most `maxBatchesPerTick` batches of `batchSize` rows per tick, all index-backed), each
 * isolated: a failing pass is reported at the end of the tick but never stops the others.
 *
 *  1. approvals      PENDING/DRAFT approval requests past `expires_at` become EXPIRED (final), EXCEPT emergency ratifications
 *                    (mode EMERGENCY_RATIFICATION: an emergency action already in force, whose deadline policy - escalation,
 *                    revert or lift - belongs to the DeadlineWorker, AUTO-22), their subject is released
 *                    exactly like a rejection (a join request back to IN_REVIEW, an operator case back to IN_PROGRESS),
 *                    and the maker is told. Until now they were only treated as expired when somebody opened them, so
 *                    the queue showed stale items and the subject stayed locked behind them.
 *  2. invitations    a staff invitation past `invitation_expires_at` loses its token hash (the token is unusable even
 *                    if the accept-time check were removed), its still-queued invitation mail is suppressed and
 *                    unsealed, and the inviter is told.
 *  3. payment links  PENDING links past `expires_at` become EXPIRED and `link.expired` is written to the outbox in the
 *                    same transaction (the merchant webhook, AUTO-34, consumes it), so merchant lists and caps stop
 *                    counting them as active.
 *  4. MFA challenges consumed or expired for more than `mfaRetentionHours` are deleted.
 *  5. secrets        the sealed MFA code / invitation token of a notification that is no longer QUEUED is removed from
 *                    its payload after `secretScrubAfterMinutes`.
 *  6. revocations    `session_revocations` rows of tokens that expired anyway are deleted (they were only pruned on
 *                    one in fifty revocations).
 */

/**
 * Approval subjects the housekeeping NEVER expires, normalized without separators: each has its own lifecycle, deadline
 * and money side effects, and closing its approval would strand it (a drafted chargeback keeps its escrowed reserve
 * until a finance checker decides; an AML case, a regulatory report or a cash-out has its own SLA and states).
 */
export const APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE: readonly string[] = [
  "ADJUSTMENT",
  "CASHOUT",
  "CASHOUTREQUEST",
  "AMLCASE",
  "REGULATORYREPORT",
  "DISPUTE",
  "KYBDOCUMENT",
  "GLSHARDREPAIR",
];

export const APPROVAL_EXPIRED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "APPROVAL_REQUEST_EXPIRED",
  audience: "INTERNAL",
  en: {
    subject: "Your approval request expired",
    body: "Your approval request for {{subjectType}} {{subjectId}} was not decided before it expired. Submit it again if the change is still needed.",
  },
  ar: {
    subject: "انتهت صلاحية طلب الموافقة",
    body: "انتهت صلاحية طلب الموافقة الخاص بك على {{subjectType}} {{subjectId}} قبل اتخاذ قرار بشأنه. قدّمه من جديد إذا كان التغيير لا يزال مطلوبا.",
  },
});

export const STAFF_INVITATION_EXPIRED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "STAFF_INVITATION_EXPIRED",
  audience: "INTERNAL",
  en: {
    subject: "A staff invitation expired",
    body: "The invitation for {{email}} expired before it was accepted. Invite the user again if access is still needed.",
  },
  ar: {
    subject: "انتهت صلاحية دعوة موظف",
    body: "انتهت صلاحية الدعوة المرسلة إلى {{email}} قبل قبولها. أرسل دعوة جديدة إذا كان الوصول لا يزال مطلوبا.",
  },
});

export type HousekeepingPass = "approvals" | "invitations" | "paymentLinks" | "mfaChallenges" | "secrets" | "revocations";

export interface ExpiryHousekeepingWorkerDeps extends WorkerOptions {
  /** Batches one pass may run per tick (the next tick continues). Default 5. */
  maxBatchesPerTick?: number;
  /** Hours an MFA challenge is kept after it was consumed or expired. Default 24. */
  mfaRetentionHours?: number;
  /** Minutes a finished notification keeps its sealed secret. Default 60. */
  secretScrubAfterMinutes?: number;
  /** One audit row per closed approval / invitation (default `writeSystemAudit`). */
  audit?: (db: Any, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => Promise<void>;
  /** Queues a staff notice (default `queueNotice`). */
  notify?: (db: Any, input: Parameters<typeof queueNotice>[1]) => Promise<number>;
}

export interface HousekeepingSummary extends WorkerTickResult {
  counts: Record<HousekeepingPass, number>;
  failed: HousekeepingPass[];
}

const DEFAULT_PASSES: HousekeepingPass[] = ["approvals", "invitations", "paymentLinks", "mfaChallenges", "secrets", "revocations"];

export class ExpiryHousekeepingWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly maxBatchesPerTick: number;
  private readonly mfaRetentionHours: number;
  private readonly secretScrubAfterMinutes: number;
  private readonly audit: NonNullable<ExpiryHousekeepingWorkerDeps["audit"]>;
  private readonly notify: NonNullable<ExpiryHousekeepingWorkerDeps["notify"]>;
  lastSummary: HousekeepingSummary | null = null;

  constructor(deps: ExpiryHousekeepingWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 15 * 60 * 1000, batchSize: deps.batchSize ?? 200 });
    this.maxBatchesPerTick = Math.max(1, Math.floor(deps.maxBatchesPerTick ?? 5));
    this.mfaRetentionHours = Math.max(1, deps.mfaRetentionHours ?? 24);
    this.secretScrubAfterMinutes = Math.max(1, deps.secretScrubAfterMinutes ?? 60);
    this.audit = deps.audit ?? writeSystemAudit;
    this.notify = deps.notify ?? queueNotice;
  }

  protected async tick(): Promise<HousekeepingSummary> {
    const now = this.clock();
    const counts = Object.fromEntries(DEFAULT_PASSES.map((pass) => [pass, 0])) as Record<HousekeepingPass, number>;
    const failed: HousekeepingPass[] = [];
    const errors: string[] = [];
    const passes: Record<HousekeepingPass, () => Promise<number>> = {
      approvals: () => this.batches((tx) => this.expireApprovals(tx, now)),
      invitations: () => this.batches((tx) => this.expireInvitations(tx, now)),
      paymentLinks: () => this.batches((tx) => this.expirePaymentLinks(tx, now)),
      mfaChallenges: () => this.batches((tx) => this.purgeMfaChallenges(tx, now)),
      secrets: () => this.batches((tx) => this.scrubNotificationSecrets(tx, now)),
      revocations: () => this.batches((tx) => this.purgeRevocations(tx, now)),
    };
    for (const pass of DEFAULT_PASSES) {
      try {
        counts[pass] = await passes[pass]();
      } catch (error) {
        failed.push(pass);
        errors.push(`${pass}: ${sanitizeWorkerError(error)}`);
        this.logger.error("ExpiryHousekeepingWorker: pass failed", { pass, error: sanitizeWorkerError(error) });
      }
    }
    const processed = Object.values(counts).reduce((total, value) => total + value, 0);
    if (processed > 0) this.logger.info("ExpiryHousekeepingWorker: housekeeping done", { ...counts });
    const summary: HousekeepingSummary = { processed, counts, failed };
    this.lastSummary = summary;
    // The other passes ran; report the failure to the health registry so the monitor sees a failing worker.
    if (failed.length > 0) throw new Error(`housekeeping passes failed (${errors.join("; ")})`);
    return summary;
  }

  /** Runs `batch` (each in its own transaction) until one comes back short, at most `maxBatchesPerTick` times. */
  private async batches(batch: (tx: Any) => Promise<number>): Promise<number> {
    let total = 0;
    for (let index = 0; index < this.maxBatchesPerTick; index += 1) {
      const done = await this.inTransaction((tx) => batch(tx as Any));
      total += done;
      if (done < this.batchSize) break;
    }
    return total;
  }

  // ---- 1. approvals -------------------------------------------------------------------------------------------

  private async expireApprovals(tx: Any, now: Date): Promise<number> {
    const rows = toCamelRows<Record<string, any>>(
      await tx.$queryRawUnsafe(
        `WITH target AS (
           SELECT id, state::text AS previous_state, expires_at FROM approval_requests
           WHERE state IN ('DRAFT', 'PENDING_REVIEW') AND expires_at IS NOT NULL AND expires_at < $1
             AND mode <> 'EMERGENCY_RATIFICATION'
             AND upper(regexp_replace(subject_type, '[[:space:]_-]+', '', 'g')) <> ALL($3::text[])
           ORDER BY expires_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE approval_requests a
         SET state = 'EXPIRED',
             rejection_reason = 'EXPIRED: not decided before ' || to_char(t.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             updated_at = $1
         FROM target t WHERE a.id = t.id
         RETURNING a.id, a.subject_type, a.subject_id, a.maker_user_id, t.previous_state, t.expires_at`,
        now,
        this.batchSize,
        [...APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE],
      ),
    );
    for (const row of rows) {
      const subjectType = normalizeApprovalSubjectType(String(row.subjectType));
      const approvalId = String(row.id);
      const subjectId = String(row.subjectId);
      await this.audit(tx, {
        action: "APPROVAL_REQUEST_EXPIRED",
        entityType: "APPROVAL_REQUEST",
        entityId: approvalId,
        before: { state: row.previousState },
        after: { state: "EXPIRED", subjectType, subjectId, expiresAt: new Date(row.expiresAt).toISOString() },
      });
      await this.releaseSubject(tx, { approvalId, subjectType, subjectId, now });
      await this.notify(tx, {
        definition: APPROVAL_EXPIRED_NOTICE,
        eventKey: `approval-expired:${approvalId}`,
        payload: { subjectType, subjectId },
        userId: String(row.makerUserId),
      });
    }
    return rows.length;
  }

  /** What a rejection does to the subject (`POST /approvals/:id/reject`), without a human actor. */
  private async releaseSubject(
    tx: Any,
    input: { approvalId: string; subjectType: string; subjectId: string; now: Date },
  ): Promise<void> {
    if (input.subjectType === "OPERATOR_CASE") {
      const released = await tx.$executeRawUnsafe(
        "UPDATE operator_cases SET state = 'IN_PROGRESS', updated_at = $1 WHERE id = $2::uuid AND state = 'PENDING_CHECKER'",
        input.now,
        input.subjectId,
      );
      if (Number(released) > 0) {
        await this.audit(tx, {
          action: "OPERATOR_CASE_RESOLUTION_EXPIRED",
          entityType: "OPERATOR_CASE",
          entityId: input.subjectId,
          before: { state: "PENDING_CHECKER" },
          after: { state: "IN_PROGRESS", approvalRequestId: input.approvalId, reason: "APPROVAL_EXPIRED" },
        });
      }
    } else if (input.subjectType === "JOIN_REQUEST") {
      const released = await tx.$executeRawUnsafe(
        "UPDATE join_requests SET status = 'IN_REVIEW', approval_request_id = NULL, updated_at = $1" +
          " WHERE id = $2::uuid AND approval_request_id = $3::uuid AND status = 'PENDING_CHECKER'",
        input.now,
        input.subjectId,
        input.approvalId,
      );
      if (Number(released) > 0) {
        await this.audit(tx, {
          action: "JOIN_REQUEST_APPROVAL_EXPIRED",
          entityType: "JOIN_REQUEST",
          entityId: input.subjectId,
          before: { state: "PENDING_CHECKER" },
          after: { state: "IN_REVIEW", approvalRequestId: input.approvalId, reason: "APPROVAL_EXPIRED" },
        });
      }
    } else if (input.subjectType === "MERCHANT") {
      await this.audit(tx, {
        action: "MERCHANT_CHANGE_EXPIRED",
        entityType: "MERCHANT",
        entityId: input.subjectId,
        before: { state: "PENDING_REVIEW" },
        after: { state: "EXPIRED", approvalRequestId: input.approvalId },
      });
    }
  }

  // ---- 2. staff invitations -----------------------------------------------------------------------------------

  private async expireInvitations(tx: Any, now: Date): Promise<number> {
    const rows = toCamelRows<Record<string, any>>(
      await tx.$queryRawUnsafe(
        `UPDATE users SET invitation_token_hash = NULL, updated_at = $1
         WHERE id IN (
           SELECT id FROM users
           WHERE status = 'INVITED' AND invitation_token_hash IS NOT NULL AND invitation_expires_at IS NOT NULL AND invitation_expires_at < $1
           ORDER BY invitation_expires_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, email, invited_by, invitation_expires_at`,
        now,
        this.batchSize,
      ),
    );
    for (const row of rows) {
      const userId = String(row.id);
      // The invitation mail may still be waiting in the queue: it must not be sent, and its sealed token goes.
      await tx.$executeRawUnsafe(
        `UPDATE notifications SET status = 'SUPPRESSED', payload_json = payload_json - 'tokenCiphertext', updated_at = $1
         WHERE recipient_user_id = $2::uuid AND template_code = 'STAFF_INVITATION' AND status = 'QUEUED'`,
        now,
        userId,
      );
      await this.audit(tx, {
        action: "STAFF_INVITATION_EXPIRED",
        entityType: "USER",
        entityId: userId,
        before: { status: "INVITED" },
        after: { status: "INVITED", invitationExpiresAt: new Date(row.invitationExpiresAt).toISOString(), tokenRevoked: true },
      });
      if (row.invitedBy) {
        await this.notify(tx, {
          definition: STAFF_INVITATION_EXPIRED_NOTICE,
          eventKey: `invitation-expired:${userId}:${new Date(row.invitationExpiresAt).getTime()}`,
          payload: { email: maskNoticeAddress(String(row.email)) },
          userId: String(row.invitedBy),
        });
      }
    }
    return rows.length;
  }

  // ---- 3. payment links ---------------------------------------------------------------------------------------

  private async expirePaymentLinks(tx: Any, now: Date): Promise<number> {
    const rows = toCamelRows<Record<string, any>>(
      await tx.$queryRawUnsafe(
        `WITH target AS (
           SELECT id FROM payment_links
           WHERE state = 'PENDING' AND expires_at IS NOT NULL AND expires_at < $1
           ORDER BY expires_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE payment_links l SET state = 'EXPIRED', updated_at = $1
         FROM target t WHERE l.id = t.id
         RETURNING l.id, l.key, l.application_id, l.expires_at`,
        now,
        this.batchSize,
      ),
    );
    if (rows.length === 0) return 0;
    // `link.expired` for the merchant webhook, in the same transaction as the state change.
    await tx.$executeRawUnsafe(
      `INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json)
       SELECT 'link.expired', 'payment_link', l.id::text, a.merchant_id,
              jsonb_build_object('linkId', l.id::text, 'linkKey', l.key, 'expiredAt', $2::text)
       FROM payment_links l JOIN applications a ON a.id = l.application_id
       WHERE l.id = ANY($1::uuid[])`,
      rows.map((row) => String(row.id)),
      now.toISOString(),
    );
    return rows.length;
  }

  // ---- 4. MFA challenges ----------------------------------------------------------------------------------------

  private async purgeMfaChallenges(tx: Any, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.mfaRetentionHours * 3_600_000);
    return Number(
      await tx.$executeRawUnsafe(
        `DELETE FROM mfa_challenges WHERE id IN (
           SELECT id FROM mfa_challenges WHERE expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)
           ORDER BY expires_at ASC LIMIT $2
         )`,
        cutoff,
        this.batchSize,
      ),
    );
  }

  // ---- 5. sealed secrets of finished notifications --------------------------------------------------------------

  private async scrubNotificationSecrets(tx: Any, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.secretScrubAfterMinutes * 60_000);
    return Number(
      await tx.$executeRawUnsafe(
        `UPDATE notifications SET payload_json = payload_json - 'codeCiphertext' - 'tokenCiphertext', updated_at = $2
         WHERE id IN (
           SELECT id FROM notifications
           WHERE status <> 'QUEUED' AND (payload_json ? 'codeCiphertext' OR payload_json ? 'tokenCiphertext') AND updated_at < $1
           ORDER BY updated_at ASC LIMIT $3
         )`,
        cutoff,
        now,
        this.batchSize,
      ),
    );
  }

  // ---- 6. session revocations -----------------------------------------------------------------------------------

  private async purgeRevocations(tx: Any, now: Date): Promise<number> {
    return Number(
      await tx.$executeRawUnsafe(
        `DELETE FROM session_revocations WHERE jti IN (
           SELECT jti FROM session_revocations WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2
         )`,
        now,
        this.batchSize,
      ),
    );
  }
}
