import { Decimal } from "decimal.js";
import { toCamelRows } from "../../db/rawRows";
import { openKeyedOperatorCase } from "../automationCases";
import { businessHoursBetween, type BusinessCalendar } from "./businessTime";
import { claimStage, notifyStaff, SLA_BREACH_NOTICE, SLA_REMINDER_NOTICE, staffByRole, type DeadlineContext } from "./common";

type Any = Record<string, any>;

export interface CashoutDeadlineConfig {
  /** The operator window in BUSINESS hours (decision D2). Default 24. */
  slaBusinessHours: number;
  /** Fraction of the SLA at which the reminder goes out. Default 0.75. */
  reminderRatio: number;
  caseSlaHours: number;
  calendar: BusinessCalendar;
}

export const CASHOUT_STAGES = ["REMIND_75", "BREACH_100", "BREACH_200"] as const;
export type CashoutStage = (typeof CASHOUT_STAGES)[number];

/** The stages a cash-out of `businessHours` has reached (pure; the worker claims the ones not yet claimed). */
export const reachedCashoutStages = (businessHours: number, slaBusinessHours: number, reminderRatio: number): CashoutStage[] => {
  const reached: CashoutStage[] = [];
  if (businessHours >= slaBusinessHours * reminderRatio) reached.push("REMIND_75");
  if (businessHours >= slaBusinessHours) reached.push("BREACH_100");
  if (businessHours >= slaBusinessHours * 2) reached.push("BREACH_200");
  return reached;
};

/**
 * Cash-out SLA (decision D2): the OPERATOR window only, in Libyan business hours (Sunday to Thursday, holiday calendar
 * from the platform setting `calendar.holidays`). A reminder to the finance queue at 75 %, a P2 finance case at 100 %
 * (`cashout.sla:<id>:1`), and at 200 % a P1 case (`cashout.sla:<id>:2`) with compliance told as well. A cash-out of a
 * merchant that is not ACTIVE is in a documented hold (KYB, AML, suspension) and is not measured. When several stages
 * are reached at once (the first look at an old request) only the highest acts, the lower ones are claimed silently.
 */
export const runCashoutDeadlines = async (ctx: DeadlineContext, config: CashoutDeadlineConfig): Promise<number> => {
  const open = toCamelRows<Any>(
    await ctx.db.$queryRawUnsafe(
      `SELECT c.id::text AS id, c.created_at, c.amount::text AS amount, c.merchant_id::text AS merchant_id
       FROM cashout_requests c JOIN merchants m ON m.id = c.merchant_id
       WHERE c.state::text IN ('PENDING', 'PROCESSING') AND m.status::text = 'ACTIVE'
       ORDER BY c.created_at ASC LIMIT $1`,
      ctx.batchSize * 5,
    ),
  );
  if (open.length === 0) return 0;
  const claimedRows = (await ctx.db.$queryRawUnsafe(
    `SELECT subject_id, stage FROM deadline_stages WHERE subject_type = 'CASHOUT' AND subject_id = ANY($1::text[])`,
    open.map((row) => String(row.id)),
  )) as Array<{ subject_id: string; stage: string }>;
  const claimed = new Map<string, Set<string>>();
  for (const row of claimedRows) {
    const set = claimed.get(row.subject_id) ?? new Set<string>();
    set.add(row.stage);
    claimed.set(row.subject_id, set);
  }

  let processed = 0;
  for (const row of open) {
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
    const hours = businessHoursBetween(created, ctx.now, config.calendar);
    const fresh = reachedCashoutStages(hours, config.slaBusinessHours, config.reminderRatio).filter((stage) => !claimed.get(String(row.id))?.has(stage));
    if (fresh.length === 0) continue;
    processed += await ctx.inTransaction(async (tx) => {
      const won: CashoutStage[] = [];
      for (const stage of fresh) {
        if (await claimStage(tx, "CASHOUT", String(row.id), stage, { businessHours: Number(hours.toFixed(2)) })) won.push(stage);
      }
      const top = won.at(-1);
      if (!top) return 0;
      const amount = new Decimal(String(row.amount)).toFixed(4);
      const ref = String(row.id);
      if (top === "REMIND_75") {
        await notifyStaff(ctx, tx, {
          definition: SLA_REMINDER_NOTICE,
          eventKey: `deadline:cashout:${ref}:${top}`,
          payload: { kind: "Cash-out", ref, minutes: Math.max(1, Math.round((config.slaBusinessHours - hours) * 60)) },
          recipients: await staffByRole(tx, ["FINANCE"]),
        });
      } else {
        const level = top === "BREACH_100" ? 1 : 2;
        const escalation = await openKeyedOperatorCase(tx as never, {
          kind: "MANUAL_REVIEW",
          priority: level === 1 ? "P2" : "P1",
          subjectKey: `cashout.sla:${ref}:${level}`,
          slaHours: config.caseSlaHours,
          now: ctx.now,
          notes:
            `Cash-out ${ref} (${amount}) has been open for ${hours.toFixed(1)} business hours, ` +
            `${level === 1 ? "past" : "twice"} its ${config.slaBusinessHours} hour operator SLA. Pay it, reject it, or document the hold.`,
        });
        const recipients = new Set<string>(await staffByRole(tx, ["FINANCE"]));
        if (level === 2) for (const id of await staffByRole(tx, ["COMPLIANCE"])) recipients.add(id);
        await notifyStaff(ctx, tx, {
          definition: SLA_BREACH_NOTICE,
          eventKey: `deadline:cashout:${ref}:${top}`,
          payload: { kind: "Cash-out", ref, action: `A ${level === 1 ? "P2" : "P1"} case was opened.` },
          recipients: [...recipients],
        });
        await ctx.audit(tx, {
          action: "CASHOUT_SLA_BREACHED",
          entityType: "CASHOUT_REQUEST",
          entityId: ref,
          after: { stage: top, businessHours: Number(hours.toFixed(2)), slaBusinessHours: config.slaBusinessHours, caseId: escalation.id },
        });
      }
      return 1;
    });
  }
  return processed;
};
