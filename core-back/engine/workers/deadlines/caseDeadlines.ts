import { toCamelRows } from "../../db/rawRows";
import { openKeyedOperatorCase } from "../automationCases";
import { claimStage, notifyStaff, priorityBump, SLA_BREACH_NOTICE, SLA_REMINDER_NOTICE, staffByRole, type DeadlineContext } from "./common";

type Any = Record<string, any>;

export interface CaseDeadlineConfig {
  /** How long before `sla_due_at` the reminder goes out. Default 60 minutes. */
  reminderLeadMs: number;
  /** How long before a join request's `sla_due_at` its reminder goes out. Default 24 hours. */
  joinReminderLeadMs: number;
  /** SLA of the escalation case an AML breach opens, in hours. Default 24. */
  escalationCaseSlaHours: number;
}

const minutesUntil = (due: Date, now: Date): number => Math.max(1, Math.round((due.getTime() - now.getTime()) / 60_000));
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

// ---- operator cases (reminder, then breach = priority bump + notice) ---------------------------------------------

/**
 * Operator cases: a reminder before `sla_due_at`; at breach the priority goes up one level (P3 to P2 to P1), the case
 * is annotated, and the assignee (or the OPERATOR queue) is told. The case is never resolved or reassigned here.
 */
export const runOperatorCaseDeadlines = async (ctx: DeadlineContext, config: CaseDeadlineConfig): Promise<number> => {
  let processed = 0;
  const reminders = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT c.id::text AS id, c.priority::text AS priority, c.assignee_user_id::text AS assignee_user_id, c.sla_due_at
       FROM operator_cases c
       WHERE c.state <> 'RESOLVED' AND c.sla_due_at > $1 AND c.sla_due_at <= $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'OPERATOR_CASE' AND s.subject_id = c.id::text AND s.stage = 'REMINDER')
       ORDER BY c.sla_due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() + config.reminderLeadMs),
      ctx.batchSize,
    ),
  );
  for (const row of reminders) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "OPERATOR_CASE", String(row.id), "REMINDER"))) return 0;
      const recipients = row.assigneeUserId ? [String(row.assigneeUserId)] : await staffByRole(tx, ["OPERATOR"]);
      await notifyStaff(ctx, tx, {
        definition: SLA_REMINDER_NOTICE,
        eventKey: `deadline:operator-case:${row.id}:REMINDER`,
        payload: { kind: "Operator case", ref: String(row.id), minutes: minutesUntil(toDate(row.slaDueAt), ctx.now) },
        recipients,
      });
      await ctx.audit(tx, {
        action: "DEADLINE_REMINDER_SENT",
        entityType: "OPERATOR_CASE",
        entityId: String(row.id),
        after: { stage: "REMINDER", dueAt: toDate(row.slaDueAt).toISOString(), recipients: recipients.length },
      });
      return 1;
    });
  }

  const breaches = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT c.id::text AS id, c.priority::text AS priority, c.assignee_user_id::text AS assignee_user_id, c.sla_due_at
       FROM operator_cases c
       WHERE c.state <> 'RESOLVED' AND c.sla_due_at <= $1 AND c.sla_due_at > $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'OPERATOR_CASE' AND s.subject_id = c.id::text AND s.stage = 'BREACH')
       ORDER BY c.sla_due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() - ctx.catchupMs),
      ctx.batchSize,
    ),
  );
  for (const row of breaches) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "OPERATOR_CASE", String(row.id), "BREACH"))) return 0;
      const before = String(row.priority);
      const after = priorityBump(before);
      const stamp = ctx.now.toISOString();
      const updated = await tx.$executeRawUnsafe(
        `UPDATE operator_cases
         SET priority = $2::"OperatorCasePriority",
             resolution_notes = left(coalesce(resolution_notes, '') || E'\\n' || $3, 8000),
             updated_at = $4
         WHERE id = $1::uuid AND state <> 'RESOLVED'`,
        String(row.id),
        after,
        `[SLA BREACHED ${stamp}] priority ${before} -> ${after}`,
        ctx.now,
      );
      if (Number(updated) === 0) return 0; // resolved in the meantime: nothing to escalate
      const recipients = new Set<string>(await staffByRole(tx, ["OPERATOR"]));
      if (row.assigneeUserId) recipients.add(String(row.assigneeUserId));
      await notifyStaff(ctx, tx, {
        definition: SLA_BREACH_NOTICE,
        eventKey: `deadline:operator-case:${row.id}:BREACH`,
        payload: { kind: "Operator case", ref: String(row.id), action: `Priority ${before} is now ${after}.` },
        recipients: [...recipients],
      });
      await ctx.audit(tx, {
        action: "OPERATOR_CASE_SLA_BREACHED",
        entityType: "OPERATOR_CASE",
        entityId: String(row.id),
        before: { priority: before },
        after: { priority: after, dueAt: toDate(row.slaDueAt).toISOString() },
      });
      return 1;
    });
  }
  return processed;
};

// ---- AML cases (reminder, breach = one keyed P1 escalation case) -------------------------------------------------

const AML_OPEN = "('OPEN', 'IN_REVIEW', 'PENDING_CHECKER', 'FROZEN')";

/**
 * AML cases: a reminder to the assigned reviewer (or the MLRO and compliance queue), and at breach ONE keyed P1
 * operator case `aml.sla_breached:<id>`. Only the case id travels in notices and in the escalation case: nothing about
 * the subject, the trigger or the severity (confidentiality; the notices are INTERNAL).
 */
export const runAmlCaseDeadlines = async (ctx: DeadlineContext, config: CaseDeadlineConfig): Promise<number> => {
  let processed = 0;
  const reminders = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT c.id::text AS id, c.assigned_reviewer_id::text AS reviewer, c.sla_due_at
       FROM aml_cases c
       WHERE c.status::text IN ${AML_OPEN} AND c.sla_due_at IS NOT NULL AND c.sla_due_at > $1 AND c.sla_due_at <= $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'AML_CASE' AND s.subject_id = c.id::text AND s.stage = 'REMINDER')
       ORDER BY c.sla_due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() + config.reminderLeadMs),
      ctx.batchSize,
    ),
  );
  for (const row of reminders) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "AML_CASE", String(row.id), "REMINDER"))) return 0;
      const recipients = row.reviewer ? [String(row.reviewer)] : await staffByRole(tx, ["MLRO", "COMPLIANCE"]);
      await notifyStaff(ctx, tx, {
        definition: SLA_REMINDER_NOTICE,
        eventKey: `deadline:aml-case:${row.id}:REMINDER`,
        payload: { kind: "AML case", ref: String(row.id), minutes: minutesUntil(toDate(row.slaDueAt), ctx.now) },
        recipients,
      });
      await ctx.audit(tx, {
        action: "DEADLINE_REMINDER_SENT",
        entityType: "AML_CASE",
        entityId: String(row.id),
        after: { stage: "REMINDER", dueAt: toDate(row.slaDueAt).toISOString(), recipients: recipients.length },
      });
      return 1;
    });
  }

  const breaches = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT c.id::text AS id, c.assigned_reviewer_id::text AS reviewer, c.sla_due_at
       FROM aml_cases c
       WHERE c.status::text IN ${AML_OPEN} AND c.sla_due_at IS NOT NULL AND c.sla_due_at <= $1 AND c.sla_due_at > $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'AML_CASE' AND s.subject_id = c.id::text AND s.stage = 'BREACH')
       ORDER BY c.sla_due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() - ctx.catchupMs),
      ctx.batchSize,
    ),
  );
  for (const row of breaches) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "AML_CASE", String(row.id), "BREACH"))) return 0;
      const escalation = await openKeyedOperatorCase(tx as never, {
        kind: "MANUAL_REVIEW",
        priority: "P1",
        subjectKey: `aml.sla_breached:${row.id}`,
        slaHours: config.escalationCaseSlaHours,
        now: ctx.now,
        notes: `AML case ${row.id} passed its review deadline (${toDate(row.slaDueAt).toISOString()}). Review it or reassign it.`,
      });
      const recipients = new Set<string>(await staffByRole(tx, ["MLRO", "COMPLIANCE"]));
      if (row.reviewer) recipients.add(String(row.reviewer));
      await notifyStaff(ctx, tx, {
        definition: SLA_BREACH_NOTICE,
        eventKey: `deadline:aml-case:${row.id}:BREACH`,
        payload: { kind: "AML case", ref: String(row.id), action: "An escalation case was opened." },
        recipients: [...recipients],
      });
      await ctx.audit(tx, {
        action: "AML_CASE_SLA_BREACHED",
        entityType: "AML_CASE",
        entityId: String(row.id),
        after: { dueAt: toDate(row.slaDueAt).toISOString(), escalationCaseId: escalation.id },
      });
      return 1;
    });
  }
  return processed;
};

// ---- join requests (reminder only: the breach is the existing expiry) -------------------------------------------

/**
 * Join requests: a reminder to the assigned reviewer (or the COMPLIANCE and OPERATOR queue) before the review SLA
 * runs out. The breach itself is `JoinRequestExpiryWorker`, which expires the request (AUTO-13).
 */
export const runJoinRequestReminders = async (ctx: DeadlineContext, config: CaseDeadlineConfig): Promise<number> => {
  let processed = 0;
  const reminders = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT j.id::text AS id, j.assigned_reviewer_id::text AS reviewer, j.sla_due_at
       FROM join_requests j
       WHERE j.status::text IN ('SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED') AND j.sla_due_at > $1 AND j.sla_due_at <= $2
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'JOIN_REQUEST' AND s.subject_id = j.id::text AND s.stage = 'REMINDER')
       ORDER BY j.sla_due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() + config.joinReminderLeadMs),
      ctx.batchSize,
    ),
  );
  for (const row of reminders) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "JOIN_REQUEST", String(row.id), "REMINDER"))) return 0;
      const recipients = row.reviewer ? [String(row.reviewer)] : await staffByRole(tx, ["COMPLIANCE", "OPERATOR"]);
      await notifyStaff(ctx, tx, {
        definition: SLA_REMINDER_NOTICE,
        eventKey: `deadline:join-request:${row.id}:REMINDER`,
        payload: { kind: "Join request", ref: String(row.id), minutes: minutesUntil(toDate(row.slaDueAt), ctx.now) },
        recipients,
      });
      await ctx.audit(tx, {
        action: "DEADLINE_REMINDER_SENT",
        entityType: "JOIN_REQUEST",
        entityId: String(row.id),
        after: { stage: "REMINDER", dueAt: toDate(row.slaDueAt).toISOString(), recipients: recipients.length },
      });
      return 1;
    });
  }
  return processed;
};
