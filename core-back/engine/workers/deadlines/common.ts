import { bilingualNotice, type NoticeDefinition, type queueNotice } from "../../../lib/automationNotices";
import type { WorkerLogger } from "../workerRuntime";

type Any = Record<string, any>;

/**
 * Shared pieces of the deadline worker (AUTO-04, AUTO-22).
 *
 * Every deadline action is guarded by a STAGE: one `deadline_stages` row per (subject, stage), claimed with
 * `INSERT ... ON CONFLICT DO NOTHING` inside the SAME transaction as the action. A repeated tick, a restart or a second
 * node finds the row and does nothing, so a reminder is sent once, an escalation is raised once and a revert happens
 * once. If the action fails the transaction rolls the claim back and the next tick retries it.
 */

export interface DeadlineContext {
  db: Any;
  now: Date;
  /** Rows one rule may process in one tick (the next tick continues). */
  batchSize: number;
  /**
   * Only deadlines that fell within this window are acted on. Anything older is ignored, so the first run on a
   * database with years of old open items (or a long outage) does not flood staff with stale reminders.
   */
  catchupMs: number;
  logger: WorkerLogger;
  inTransaction<T>(fn: (tx: Any) => Promise<T>): Promise<T>;
  audit(tx: Any, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }): Promise<void>;
  notify(tx: Any, input: Parameters<typeof queueNotice>[1]): Promise<number>;
}

export type DeadlineSubjectType =
  | "OPERATOR_CASE"
  | "AML_CASE"
  | "JOIN_REQUEST"
  | "DISPUTE"
  | "CASHOUT"
  | "EMERGENCY_APPROVAL"
  | "ACCESS_TOKEN"
  | "CREDENTIAL_SET"
  | "REPORT"
  | "WEBHOOK_ENDPOINT";

/** Claims a stage; true exactly once per (subject, stage) across all nodes and restarts. */
export const claimStage = async (
  tx: Any,
  subjectType: DeadlineSubjectType,
  subjectId: string,
  stage: string,
  detail?: Record<string, unknown>,
): Promise<boolean> => {
  const claimed = await tx.$executeRawUnsafe(
    `INSERT INTO deadline_stages (subject_type, subject_id, stage, detail_json)
     VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (subject_type, subject_id, stage) DO NOTHING`,
    subjectType,
    subjectId,
    stage,
    JSON.stringify(detail ?? {}),
  );
  return Number(claimed) === 1;
};

/**
 * Active staff of the given roles (an internal queue): at most `limit` PER ROLE (oldest first), never the excluded
 * users. The cap is per role so a large role can never crowd a small one out of a combined queue.
 */
export const staffByRole = async (
  tx: Any,
  roles: readonly string[],
  options: { exclude?: readonly string[]; limit?: number } = {},
): Promise<string[]> => {
  const rows = (await tx.$queryRawUnsafe(
    `SELECT id FROM (
       SELECT id::text AS id, created_at,
              ROW_NUMBER() OVER (PARTITION BY role ORDER BY created_at ASC, id ASC) AS position
       FROM users
       WHERE status = 'ACTIVE' AND role::text = ANY($1::text[]) AND NOT (id::text = ANY($2::text[]))
     ) ranked
     WHERE position <= $3::int ORDER BY created_at ASC, id ASC`,
    [...roles],
    [...(options.exclude ?? [])],
    options.limit ?? 20,
  )) as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
};

/** Sends one staff notice per recipient (the assignee when there is one, otherwise the role queue). */
export const notifyStaff = async (
  ctx: DeadlineContext,
  tx: Any,
  input: { definition: NoticeDefinition; eventKey: string; payload: Record<string, unknown>; recipients: readonly string[] },
): Promise<number> => {
  let sent = 0;
  for (const userId of input.recipients) {
    sent += await ctx.notify(tx, {
      definition: input.definition,
      eventKey: `${input.eventKey}:${userId}`,
      payload: input.payload,
      userId,
    });
  }
  return sent;
};

export const SLA_REMINDER_NOTICE: NoticeDefinition = bilingualNotice({
  code: "DEADLINE_REMINDER",
  audience: "INTERNAL",
  en: {
    subject: "Deadline approaching: {{kind}} {{ref}}",
    body: "{{kind}} {{ref}} reaches its deadline in about {{minutes}} minutes. Please handle it before then.",
  },
  ar: {
    subject: "اقتراب الموعد النهائي: {{kind}} {{ref}}",
    body: "يصل {{kind}} {{ref}} إلى موعده النهائي خلال نحو {{minutes}} دقيقة. يرجى معالجته قبل ذلك.",
  },
});

export const SLA_BREACH_NOTICE: NoticeDefinition = bilingualNotice({
  code: "DEADLINE_BREACH",
  audience: "INTERNAL",
  en: {
    subject: "Deadline passed: {{kind}} {{ref}}",
    body: "{{kind}} {{ref}} passed its deadline and has been escalated. {{action}}",
  },
  ar: {
    subject: "تجاوز الموعد النهائي: {{kind}} {{ref}}",
    body: "تجاوز {{kind}} {{ref}} موعده النهائي وتم تصعيده. {{action}}",
  },
});

export const priorityBump = (priority: string): string => (priority === "P3" ? "P2" : priority === "P2" ? "P1" : priority);
