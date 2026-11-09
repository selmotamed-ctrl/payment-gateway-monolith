import { toCamelRows } from "../../db/rawRows";
import { bilingualNotice, type NoticeDefinition } from "../../../lib/automationNotices";
import { openKeyedOperatorCase } from "../automationCases";
import { claimStage, notifyStaff, SLA_BREACH_NOTICE, SLA_REMINDER_NOTICE, staffByRole, type DeadlineContext } from "./common";

type Any = Record<string, any>;

export interface DisputeDeadlineConfig {
  /** Hours before `evidence_due_at` at which the merchant and the dispute queue are reminded. Default [72, 24]. */
  reminderHours: readonly number[];
  /** Days after the evidence was submitted before a missing provider ruling is escalated. Default 30. */
  rulingSlaDays: number;
  /** SLA of the finance cases these rules open, in hours. Default 24. */
  caseSlaHours: number;
}

export const DISPUTE_EVIDENCE_DUE_NOTICE: NoticeDefinition = bilingualNotice({
  code: "DISPUTE_EVIDENCE_DUE",
  en: {
    subject: "Evidence due for dispute {{reference}}",
    body: "The evidence for dispute {{reference}} is due in about {{hours}} hours. If it is not submitted in time the dispute is closed in the cardholder's favour.",
  },
  ar: {
    subject: "موعد تقديم الأدلة للنزاع {{reference}}",
    body: "يحين موعد تقديم أدلة النزاع {{reference}} خلال نحو {{hours}} ساعة. إذا لم تُقدَّم في الوقت المحدد يُغلق النزاع لصالح حامل البطاقة.",
  },
});

export const DISPUTE_EXPIRED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "DISPUTE_EXPIRED",
  en: {
    subject: "Dispute {{reference}} closed without evidence",
    body: "The evidence deadline for dispute {{reference}} passed without evidence, so the dispute was closed in the cardholder's favour. If the provider later rules in your favour the amount is released to you.",
  },
  ar: {
    subject: "أُغلق النزاع {{reference}} دون أدلة",
    body: "انتهى موعد تقديم أدلة النزاع {{reference}} دون تقديم أدلة، فأُغلق النزاع لصالح حامل البطاقة. إذا حكم المزوّد لاحقا لصالحك فسيُفرج عن المبلغ لك.",
  },
});

const NO_EVIDENCE = "(d.evidence_json IS NULL OR d.evidence_json IN ('{}'::jsonb, '[]'::jsonb, 'null'::jsonb))";

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

/**
 * Dispute deadlines (decision D1: a late answer is a lost dispute, but money still needs a human).
 *
 *  - Reminders to the merchant and the finance queue at T-72 h and T-24 h before `evidence_due_at`.
 *  - At the deadline with NO evidence the dispute becomes EXPIRED (the outcome is LOST by default, which is what the
 *    chargeback execution already reads from an EXPIRED dispute), the merchant is told, and one keyed finance case
 *    `dispute.expired:<id>` asks a finance checker to approve the chargeback adjustment that books the reserve loss.
 *    The booking itself stays a human decision: `executeAdjustment` refuses any non-human authoriser of a chargeback
 *    (design section 19.3), and this worker does not bypass that control.
 *  - With evidence submitted nothing is decided: the dispute waits for the provider, and a ruling that is overdue
 *    after `rulingSlaDays` opens one keyed finance case `dispute.ruling_overdue:<id>`.
 */
export const runDisputeDeadlines = async (ctx: DeadlineContext, config: DisputeDeadlineConfig): Promise<number> => {
  let processed = 0;
  const hours = [...config.reminderHours].sort((left, right) => right - left);
  for (let index = 0; index < hours.length; index += 1) {
    const upper = hours[index]!;
    const lower = hours[index + 1] ?? 0;
    const stage = `T${upper}H`;
    const rows = toCamelRows<Any>(
      await ctx.db.$queryRawUnsafe(
        `SELECT d.id::text AS id, d.external_dispute_ref AS reference, d.evidence_due_at, a.merchant_id::text AS merchant_id
         FROM disputes d JOIN payment_attempts a ON a.id = d.attempt_id
         WHERE d.status::text IN ('OPENED', 'EVIDENCE_REQUESTED') AND ${NO_EVIDENCE}
           AND d.evidence_due_at > $1 AND d.evidence_due_at <= $2
           AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'DISPUTE' AND s.subject_id = d.id::text AND s.stage = $4)
         ORDER BY d.evidence_due_at ASC LIMIT $3`,
        new Date(ctx.now.getTime() + lower * 3_600_000),
        new Date(ctx.now.getTime() + upper * 3_600_000),
        ctx.batchSize,
        stage,
      ),
    );
    for (const row of rows) {
      processed += await ctx.inTransaction(async (tx) => {
        if (!(await claimStage(tx, "DISPUTE", String(row.id), stage))) return 0;
        const dueAt = toDate(row.evidenceDueAt);
        const remainingHours = Math.max(1, Math.round((dueAt.getTime() - ctx.now.getTime()) / 3_600_000));
        await ctx.notify(tx, {
          definition: DISPUTE_EVIDENCE_DUE_NOTICE,
          eventKey: `deadline:dispute:${row.id}:${stage}`,
          payload: { reference: String(row.reference), hours: remainingHours },
          merchantId: String(row.merchantId),
        });
        await notifyStaff(ctx, tx, {
          definition: SLA_REMINDER_NOTICE,
          eventKey: `deadline:dispute:${row.id}:${stage}`,
          payload: { kind: "Dispute", ref: String(row.reference), minutes: remainingHours * 60 },
          recipients: await staffByRole(tx, ["FINANCE"]),
        });
        await ctx.audit(tx, {
          action: "DEADLINE_REMINDER_SENT",
          entityType: "DISPUTE",
          entityId: String(row.id),
          after: { stage, evidenceDueAt: dueAt.toISOString() },
        });
        return 1;
      });
    }
  }

  const expired = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT d.id::text AS id, d.external_dispute_ref AS reference, d.evidence_due_at, d.status::text AS status, a.merchant_id::text AS merchant_id
       FROM disputes d JOIN payment_attempts a ON a.id = d.attempt_id
       WHERE d.status::text IN ('OPENED', 'EVIDENCE_REQUESTED') AND ${NO_EVIDENCE}
         AND d.evidence_due_at <= $1 AND d.evidence_due_at > $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'DISPUTE' AND s.subject_id = d.id::text AND s.stage = 'EXPIRY')
       ORDER BY d.evidence_due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() - ctx.catchupMs),
      ctx.batchSize,
    ),
  );
  for (const row of expired) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "DISPUTE", String(row.id), "EXPIRY"))) return 0;
      const changed = await tx.$executeRawUnsafe(
        `UPDATE disputes SET status = 'EXPIRED', outcome_at = $2, updated_at = $2
         WHERE id = $1::uuid AND status::text IN ('OPENED', 'EVIDENCE_REQUESTED')`,
        String(row.id),
        ctx.now,
      );
      if (Number(changed) === 0) return 0; // answered in the meantime
      // The merchant webhook (AUTO-34), in the same transaction as the expiry.
      await tx.$executeRawUnsafe(
        `INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json)
         SELECT 'dispute.closed', 'DISPUTE', d.id::text, a.merchant_id,
                jsonb_build_object('disputeId', d.id::text, 'outcome', 'LOST', 'reason', 'EVIDENCE_NOT_SUBMITTED', 'amount', d.amount::text, 'occurredAt', $2::text)
         FROM disputes d JOIN payment_attempts a ON a.id = d.attempt_id WHERE d.id = $1::uuid`,
        String(row.id),
        ctx.now.toISOString(),
      );
      const financeCase = await openKeyedOperatorCase(tx as never, {
        kind: "MANUAL_REVIEW",
        priority: "P2",
        subjectKey: `dispute.expired:${row.id}`,
        slaHours: config.caseSlaHours,
        now: ctx.now,
        notes:
          `Dispute ${row.reference} passed its evidence deadline without evidence and was closed as LOST by default. ` +
          `Approve its chargeback adjustment to book the reserve loss. A later provider ruling in the merchant's favour is booked with CHARGEBACK_WON.`,
      });
      await ctx.notify(tx, {
        definition: DISPUTE_EXPIRED_NOTICE,
        eventKey: `deadline:dispute:${row.id}:EXPIRY`,
        payload: { reference: String(row.reference) },
        merchantId: String(row.merchantId),
      });
      await notifyStaff(ctx, tx, {
        definition: SLA_BREACH_NOTICE,
        eventKey: `deadline:dispute:${row.id}:EXPIRY`,
        payload: { kind: "Dispute", ref: String(row.reference), action: "It was closed as lost by default; a finance case asks for the chargeback approval." },
        recipients: await staffByRole(tx, ["FINANCE"]),
      });
      await ctx.audit(tx, {
        action: "DISPUTE_EXPIRED_LOST_BY_DEFAULT",
        entityType: "DISPUTE",
        entityId: String(row.id),
        before: { status: String(row.status) },
        after: { status: "EXPIRED", outcome: "LOST", evidenceDueAt: toDate(row.evidenceDueAt).toISOString(), financeCaseId: financeCase.id },
      });
      return 1;
    });
  }

  const slaMs = config.rulingSlaDays * 86_400_000;
  const overdue = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT d.id::text AS id, d.external_dispute_ref AS reference, d.updated_at
       FROM disputes d
       WHERE d.status::text = 'EVIDENCE_SUBMITTED' AND d.updated_at <= $1 AND d.updated_at > $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'DISPUTE' AND s.subject_id = d.id::text AND s.stage = 'RULING_OVERDUE')
       ORDER BY d.updated_at ASC LIMIT $3`,
      new Date(ctx.now.getTime() - slaMs),
      new Date(ctx.now.getTime() - slaMs - ctx.catchupMs),
      ctx.batchSize,
    ),
  );
  for (const row of overdue) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "DISPUTE", String(row.id), "RULING_OVERDUE"))) return 0;
      const financeCase = await openKeyedOperatorCase(tx as never, {
        kind: "MANUAL_REVIEW",
        priority: "P2",
        subjectKey: `dispute.ruling_overdue:${row.id}`,
        slaHours: config.caseSlaHours,
        now: ctx.now,
        notes: `Dispute ${row.reference} has had its evidence with the provider for more than ${config.rulingSlaDays} days without a ruling. Ask the provider for the outcome.`,
      });
      await notifyStaff(ctx, tx, {
        definition: SLA_BREACH_NOTICE,
        eventKey: `deadline:dispute:${row.id}:RULING_OVERDUE`,
        payload: { kind: "Dispute", ref: String(row.reference), action: "The provider's ruling is overdue; a finance case was opened." },
        recipients: await staffByRole(tx, ["FINANCE"]),
      });
      await ctx.audit(tx, {
        action: "DISPUTE_RULING_OVERDUE",
        entityType: "DISPUTE",
        entityId: String(row.id),
        after: { rulingSlaDays: config.rulingSlaDays, financeCaseId: financeCase.id },
      });
      return 1;
    });
  }
  return processed;
};
