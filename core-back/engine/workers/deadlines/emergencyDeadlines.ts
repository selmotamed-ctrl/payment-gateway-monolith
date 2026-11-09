import { toCamelRows } from "../../db/rawRows";
import { bilingualNotice, type NoticeDefinition } from "../../../lib/automationNotices";
import { openKeyedOperatorCase } from "../automationCases";
import { claimStage, notifyStaff, SLA_BREACH_NOTICE, SLA_REMINDER_NOTICE, staffByRole, type DeadlineContext } from "./common";

type Any = Record<string, any>;

/** Roles that can ratify an emergency action (`merchantApprovalCheckerAllowed`: COMPLIANCE or MLRO). */
export const RATIFIER_ROLES = ["MLRO", "COMPLIANCE"] as const;

export interface EmergencyDeadlineConfig {
  /** Hours after `ratify_due_at` during which an unratified suspension stays in force (and may still be ratified). Default 48. */
  graceHours: number;
  /** Hours between two escalations while an action is unratified. Default 4. */
  escalateEveryHours: number;
  /** Hours before `ratify_due_at` at which the ratifiers are reminded. Default [4, 1]. */
  reminderHours: readonly number[];
  caseSlaHours: number;
  /** Reverts an unratified emergency change of a subject type that is NOT a merchant suspension (none exists yet). */
  reverters?: Record<string, EmergencyReverter>;
}

/**
 * Reverts an emergency change to the last ratified values (decision D7: velocity and limit changes). Return false when
 * nothing could be reverted; the worker then opens the P1 case. No emergency velocity flow exists yet: register a
 * reverter for its subject type when it does.
 */
export interface EmergencyReverter {
  revert(tx: Any, approval: { id: string; subjectType: string; subjectId: string; payloadDiffJson: unknown }): Promise<boolean>;
}

export const SUSPENSION_ENDED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "MERCHANT_SUSPENSION_ENDED",
  en: {
    subject: "Your account suspension has ended",
    body: "The suspension of your account has ended and your account is active again.",
  },
  ar: {
    subject: "انتهى تعليق حسابك",
    body: "انتهى تعليق حسابك وأصبح حسابك نشطا من جديد.",
  },
});

const HOUR = 3_600_000;
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

/**
 * Emergency actions that nobody ratified (AUTO-22, decision D7, chosen by the owner).
 *
 * An unratified emergency approval is `mode = EMERGENCY_RATIFICATION`, `state = PENDING_REVIEW`, with a
 * `ratify_due_at`. Per approval, each step is a stage claimed exactly once:
 *
 *   - REMIND_4H / REMIND_1H  the MLRO and compliance officers (never the actor) are reminded before the deadline.
 *   - OVERDUE                at the deadline. A suspension STAYS in force and one P1 case `emergency.unratified:<id>`
 *                            goes to the MLRO queue. Any other emergency change is REVERTED through its registered
 *                            reverter (audit `EMERGENCY_ACTION_REVERTED`); without one the case says so.
 *   - ESCALATE_n             the escalation repeats every `escalateEveryHours` (notice and audit).
 *   - LIFT                   at `ratify_due_at + graceHours` a still-unratified suspension is LIFTED: the merchant goes
 *                            back to the status it had (`/status` of the approval's change log), the approval becomes
 *                            EXPIRED (never ratified), a P1 case `emergency.lifted:<id>` records it, and the merchant
 *                            is told only that the suspension ended (tipping-off: no compliance detail).
 *
 * One independent officer may extend a suspension once by up to 7 days (`POST /approvals/:id/extend-emergency`), which
 * moves `ratify_due_at` and clears these stages so they run again against the new deadline.
 */
export const runEmergencyDeadlines = async (ctx: DeadlineContext, config: EmergencyDeadlineConfig): Promise<number> => {
  const approvals = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT id::text AS id, subject_type, subject_id, maker_user_id::text AS maker_user_id, ratify_due_at, payload_diff_json
       FROM approval_requests
       WHERE mode::text = 'EMERGENCY_RATIFICATION' AND state::text = 'PENDING_REVIEW' AND checker_user_id IS NULL AND ratify_due_at IS NOT NULL
       ORDER BY ratify_due_at ASC LIMIT $1`,
      ctx.batchSize,
    ),
  );
  let processed = 0;
  const reminders = [...config.reminderHours].sort((left, right) => right - left);
  for (const approval of approvals) {
    const id = String(approval.id);
    const due = toDate(approval.ratifyDueAt);
    const sinceDue = ctx.now.getTime() - due.getTime();
    const makerExclude = [String(approval.makerUserId)];
    const subjectType = String(approval.subjectType);
    const subjectId = String(approval.subjectId);

    if (sinceDue < 0) {
      // Before the deadline: only the reminders. The highest reached acts; the lower ones are claimed silently.
      const reached = reminders.filter((hours) => -sinceDue <= hours * HOUR);
      if (reached.length === 0) continue;
      processed += await ctx.inTransaction(async (tx) => {
        const won: number[] = [];
        for (const hours of reached) {
          if (await claimStage(tx, "EMERGENCY_APPROVAL", id, `REMIND_${hours}H`)) won.push(hours);
        }
        if (won.length === 0) return 0;
        const hours = Math.min(...won);
        await notifyStaff(ctx, tx, {
          definition: SLA_REMINDER_NOTICE,
          eventKey: `deadline:emergency:${id}:REMIND_${hours}H`,
          payload: { kind: "Emergency action awaiting ratification", ref: `${subjectType} ${subjectId}`, minutes: Math.max(1, Math.round(-sinceDue / 60_000)) },
          recipients: await staffByRole(tx, RATIFIER_ROLES, { exclude: makerExclude }),
        });
        await ctx.audit(tx, {
          action: "DEADLINE_REMINDER_SENT",
          entityType: "APPROVAL_REQUEST",
          entityId: id,
          after: { stage: `REMIND_${hours}H`, ratifyDueAt: due.toISOString() },
        });
        return 1;
      });
      continue;
    }

    // ---- at or past the deadline -----------------------------------------------------------------------------
    processed += await ctx.inTransaction(async (tx) => {
      let acted = 0;
      if (await claimStage(tx, "EMERGENCY_APPROVAL", id, "OVERDUE")) {
        acted += 1;
        let reverted = false;
        const reverter = config.reverters?.[subjectType];
        if (subjectType !== "MERCHANT" && reverter) {
          reverted = await reverter.revert(tx, {
            id,
            subjectType,
            subjectId,
            payloadDiffJson: approval.payloadDiffJson,
          });
          if (reverted) {
            await tx.$executeRawUnsafe(
              `UPDATE approval_requests SET state = 'EXPIRED', rejection_reason = 'EMERGENCY_NOT_RATIFIED: reverted', updated_at = $2
               WHERE id = $1::uuid AND state::text = 'PENDING_REVIEW'`,
              id,
              ctx.now,
            );
            await ctx.audit(tx, {
              action: "EMERGENCY_ACTION_REVERTED",
              entityType: subjectType,
              entityId: subjectId,
              after: { approvalRequestId: id, ratifyDueAt: due.toISOString() },
            });
          }
        }
        const detail = subjectType === "MERCHANT"
          ? "The suspension stays in force and is lifted automatically if it is still unratified 48 hours after the deadline."
          : reverted
            ? "The emergency change was reverted to the last ratified values."
            : `No automatic revert is registered for ${subjectType}: revert it manually.`;
        await openKeyedOperatorCase(tx as never, {
          kind: "MANUAL_REVIEW",
          priority: "P1",
          subjectKey: `emergency.unratified:${id}`,
          slaHours: config.caseSlaHours,
          now: ctx.now,
          notes: `Emergency action on ${subjectType} ${subjectId} (approval ${id}) was not ratified by ${due.toISOString()}. ${detail}`,
        });
        await notifyStaff(ctx, tx, {
          definition: SLA_BREACH_NOTICE,
          eventKey: `deadline:emergency:${id}:OVERDUE`,
          payload: { kind: "Emergency action", ref: `${subjectType} ${subjectId}`, action: detail },
          recipients: await staffByRole(tx, RATIFIER_ROLES, { exclude: makerExclude }),
        });
        await ctx.audit(tx, {
          action: "EMERGENCY_ACTION_UNRATIFIED",
          entityType: "APPROVAL_REQUEST",
          entityId: id,
          after: { ratifyDueAt: due.toISOString(), subjectType, subjectId, reverted },
        });
        if (reverted) return acted; // closed: nothing left to escalate or lift
      }

      const graceEnd = due.getTime() + config.graceHours * HOUR;
      if (ctx.now.getTime() >= graceEnd) {
        if (await claimStage(tx, "EMERGENCY_APPROVAL", id, "LIFT")) {
          acted += 1;
          await liftSuspension(ctx, tx, config, { approvalId: id, subjectType, subjectId, due });
        }
        return acted;
      }

      // The repeated escalation: one per `escalateEveryHours` after the deadline, until the grace ends.
      const round = Math.floor(sinceDue / (config.escalateEveryHours * HOUR));
      if (round >= 1 && (await claimStage(tx, "EMERGENCY_APPROVAL", id, `ESCALATE_${round}`))) {
        acted += 1;
        await notifyStaff(ctx, tx, {
          definition: SLA_BREACH_NOTICE,
          eventKey: `deadline:emergency:${id}:ESCALATE_${round}`,
          payload: {
            kind: "Emergency action",
            ref: `${subjectType} ${subjectId}`,
            action: `Still unratified ${Math.round(sinceDue / HOUR)} hours after its deadline.`,
          },
          recipients: await staffByRole(tx, RATIFIER_ROLES, { exclude: makerExclude }),
        });
        await ctx.audit(tx, {
          action: "EMERGENCY_ACTION_ESCALATED",
          entityType: "APPROVAL_REQUEST",
          entityId: id,
          after: { round, hoursOverdue: Math.round(sinceDue / HOUR) },
        });
      }
      return acted;
    });
  }
  return processed;
};

/** Lifts an unratified emergency suspension (merchant subjects only) and closes its approval. */
const liftSuspension = async (
  ctx: DeadlineContext,
  tx: Any,
  config: EmergencyDeadlineConfig,
  input: { approvalId: string; subjectType: string; subjectId: string; due: Date },
): Promise<void> => {
  await tx.$executeRawUnsafe(
    `UPDATE approval_requests SET state = 'EXPIRED', rejection_reason = 'EMERGENCY_NOT_RATIFIED: lifted', updated_at = $2
     WHERE id = $1::uuid AND state::text = 'PENDING_REVIEW'`,
    input.approvalId,
    ctx.now,
  );
  if (input.subjectType !== "MERCHANT") {
    await openKeyedOperatorCase(tx as never, {
      kind: "MANUAL_REVIEW",
      priority: "P1",
      subjectKey: `emergency.lifted:${input.approvalId}`,
      slaHours: config.caseSlaHours,
      now: ctx.now,
      notes: `The emergency action on ${input.subjectType} ${input.subjectId} (approval ${input.approvalId}) was not ratified within the grace period and its approval was closed. It was NOT reverted automatically: revert it manually.`,
    });
    return;
  }
  const previous = (await tx.$queryRawUnsafe(
    `SELECT old_value FROM detail_change_logs WHERE approval_request_id = $1::uuid AND field_name = '/status' ORDER BY created_at ASC LIMIT 1`,
    input.approvalId,
  )) as Array<{ old_value: string | null }>;
  const restoreTo = /^[A-Z_]+$/.test(String(previous[0]?.old_value ?? "")) && previous[0]?.old_value !== "SUSPENDED" ? String(previous[0]!.old_value) : "ACTIVE";
  const lifted = await tx.$executeRawUnsafe(
    `UPDATE merchants SET status = $2::"MerchantStatus", suspended_at = NULL, suspension_reason_code = NULL, suspension_notes = NULL,
                          version = version + 1, updated_at = $3
     WHERE id = $1::uuid AND status::text = 'SUSPENDED'`,
    input.subjectId,
    restoreTo,
    ctx.now,
  );
  await ctx.audit(tx, {
    action: "EMERGENCY_ACTION_LIFTED",
    entityType: "MERCHANT",
    entityId: input.subjectId,
    before: { status: "SUSPENDED" },
    after: { status: Number(lifted) > 0 ? restoreTo : "UNCHANGED", approvalRequestId: input.approvalId, ratifyDueAt: input.due.toISOString(), reason: "NOT_RATIFIED_WITHIN_GRACE" },
  });
  await openKeyedOperatorCase(tx as never, {
    kind: "MANUAL_REVIEW",
    priority: "P1",
    subjectKey: `emergency.lifted:${input.approvalId}`,
    slaHours: config.caseSlaHours,
    now: ctx.now,
    notes:
      Number(lifted) > 0
        ? `The emergency suspension of merchant ${input.subjectId} (approval ${input.approvalId}) was not ratified within ${config.graceHours} hours of its deadline and was LIFTED (status ${restoreTo}). Review whether a regular suspension is needed.`
        : `The emergency suspension approval ${input.approvalId} was closed unratified, but the merchant ${input.subjectId} was no longer suspended, so nothing was lifted.`,
  });
  if (Number(lifted) > 0) {
    // The merchant learns only that the suspension ended: never why it was imposed or that it lapsed unratified.
    await ctx.notify(tx, {
      definition: SUSPENSION_ENDED_NOTICE,
      eventKey: `deadline:emergency:${input.approvalId}:LIFT`,
      payload: {},
      merchantId: input.subjectId,
    });
    await notifyStaff(ctx, tx, {
      definition: SLA_BREACH_NOTICE,
      eventKey: `deadline:emergency:${input.approvalId}:LIFT`,
      payload: { kind: "Emergency suspension", ref: `MERCHANT ${input.subjectId}`, action: "It was lifted automatically because nobody ratified it." },
      recipients: await staffByRole(tx, RATIFIER_ROLES),
    });
  }
};
