import { toCamelRows } from "../../db/rawRows";
import { openKeyedOperatorCase } from "../automationCases";
import { claimStage, notifyStaff, SLA_BREACH_NOTICE, SLA_REMINDER_NOTICE, staffByRole, type DeadlineContext } from "./common";
import { minusBusinessDays } from "../regulatory/periods";
import type { BusinessCalendar } from "./businessTime";

type Any = Record<string, any>;

export interface ReportDeadlineConfig {
  /** Business days before `due_at` at which the reminder goes out. Default 3. */
  reminderBusinessDays: number;
  caseSlaHours: number;
  calendar: BusinessCalendar;
}

/** The staff who file regulatory reports. */
const FILERS = ["MLRO", "COMPLIANCE"] as const;
const DAY = 86_400_000;
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

/**
 * Filing deadlines of regulatory reports (AUTO-16, AUTO-04). A report that is not yet filed (`DRAFT`, `PENDING_CHECKER`,
 * `APPROVED`) and has a `due_at`:
 *
 *  - REMINDER  `reminderBusinessDays` business days before the due date the MLRO and compliance queues are reminded;
 *  - OVERDUE   at the due date one keyed P1 case `report.overdue:<id>` is opened for the MLRO queue and they are told.
 *
 * Nothing is filed or changed on the report. A missed filing must never be silently dropped, so the catch-up window of
 * this rule is at least 30 days (the generic window is shorter).
 */
export const runReportDeadlines = async (ctx: DeadlineContext, config: ReportDeadlineConfig): Promise<number> => {
  let processed = 0;
  const windowMs = Math.max(ctx.catchupMs, 30 * DAY);

  const upcoming = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT r.id::text AS id, r.report_code, r.period_key, r.due_at FROM regulatory_reports r
       WHERE r.due_at > $1 AND r.due_at <= $2 AND r.status IN ('DRAFT', 'PENDING_CHECKER', 'APPROVED')
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'REPORT' AND s.subject_id = r.id::text AND s.stage = 'REMINDER')
       ORDER BY r.due_at ASC LIMIT $3`,
      ctx.now,
      // 3 business days can span a weekend and holidays: look two weeks ahead and decide per report.
      new Date(ctx.now.getTime() + 14 * DAY),
      ctx.batchSize,
    ),
  );
  for (const row of upcoming) {
    const due = toDate(row.dueAt);
    if (minusBusinessDays(due, config.reminderBusinessDays, config.calendar).getTime() > ctx.now.getTime()) continue;
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "REPORT", String(row.id), "REMINDER"))) return 0;
      const recipients = await staffByRole(tx, FILERS);
      await notifyStaff(ctx, tx, {
        definition: SLA_REMINDER_NOTICE,
        eventKey: `deadline:report:${row.id}:REMINDER`,
        payload: { kind: `Regulatory report ${String(row.reportCode ?? "")} ${String(row.periodKey ?? "")}`.trim(), ref: String(row.id), minutes: Math.max(1, Math.round((due.getTime() - ctx.now.getTime()) / 60_000)) },
        recipients,
      });
      await ctx.audit(tx, {
        action: "DEADLINE_REMINDER_SENT",
        entityType: "REGULATORY_REPORT",
        entityId: String(row.id),
        after: { stage: "REMINDER", dueAt: due.toISOString(), recipients: recipients.length },
      });
      return 1;
    });
  }

  const overdue = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT r.id::text AS id, r.report_code, r.period_key, r.status::text AS status, r.due_at FROM regulatory_reports r
       WHERE r.due_at <= $1 AND r.due_at > $2 AND r.status IN ('DRAFT', 'PENDING_CHECKER', 'APPROVED')
         AND NOT EXISTS (SELECT 1 FROM deadline_stages s WHERE s.subject_type = 'REPORT' AND s.subject_id = r.id::text AND s.stage = 'OVERDUE')
       ORDER BY r.due_at ASC LIMIT $3`,
      ctx.now,
      new Date(ctx.now.getTime() - windowMs),
      ctx.batchSize,
    ),
  );
  for (const row of overdue) {
    processed += await ctx.inTransaction(async (tx) => {
      if (!(await claimStage(tx, "REPORT", String(row.id), "OVERDUE"))) return 0;
      const due = toDate(row.dueAt);
      const label = `${String(row.reportCode ?? "report")} ${String(row.periodKey ?? "")}`.trim();
      await openKeyedOperatorCase(tx as never, {
        kind: "MANUAL_REVIEW",
        priority: "P1",
        subjectKey: `report.overdue:${row.id}`,
        notes: `Regulatory report ${label} (${row.id}) was due ${due.toISOString()} and is still ${String(row.status)}. File it with the authority, record the reference and mark it submitted.`,
        slaHours: config.caseSlaHours,
        now: ctx.now,
      });
      const recipients = await staffByRole(tx, FILERS);
      await notifyStaff(ctx, tx, {
        definition: SLA_BREACH_NOTICE,
        eventKey: `deadline:report:${row.id}:OVERDUE`,
        payload: { kind: "Regulatory report", ref: label, action: "A P1 case was opened for the MLRO queue." },
        recipients,
      });
      await ctx.audit(tx, {
        action: "REGULATORY_REPORT_OVERDUE",
        entityType: "REGULATORY_REPORT",
        entityId: String(row.id),
        after: { stage: "OVERDUE", dueAt: due.toISOString(), status: String(row.status), recipients: recipients.length },
      });
      return 1;
    });
  }
  return processed;
};
