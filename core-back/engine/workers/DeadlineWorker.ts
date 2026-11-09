import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { queueNotice } from "../../lib/automationNotices";
import { DEFAULT_BUSINESS_TIME_ZONE, parseHolidays, type BusinessCalendar } from "./deadlines/businessTime";
import { runAmlCaseDeadlines, runJoinRequestReminders, runOperatorCaseDeadlines, type CaseDeadlineConfig } from "./deadlines/caseDeadlines";
import { runCashoutDeadlines } from "./deadlines/cashoutDeadlines";
import { runDisputeDeadlines } from "./deadlines/disputeDeadlines";
import { runEmergencyDeadlines, type EmergencyReverter } from "./deadlines/emergencyDeadlines";
import { runReportDeadlines } from "./deadlines/reportDeadlines";
import type { DeadlineContext } from "./deadlines/common";

type Any = Record<string, any>;

export type DeadlineRuleName = "operatorCases" | "amlCases" | "joinRequests" | "disputes" | "cashouts" | "emergency" | "reports";
const RULES: DeadlineRuleName[] = ["operatorCases", "amlCases", "joinRequests", "disputes", "cashouts", "emergency", "reports"];

export interface DeadlineWorkerDeps extends WorkerOptions {
  /** Reminder lead of operator and AML cases. Default 60 minutes. */
  caseReminderLeadMs?: number;
  /** Reminder lead of join requests. Default 24 hours. */
  joinReminderLeadMs?: number;
  /** Only deadlines of the last N hours are acted on (older ones are ignored). Default 72. */
  catchupHours?: number;
  /** SLA of the cases these rules open, in hours. Default 24. */
  caseSlaHours?: number;
  disputeReminderHours?: readonly number[];
  disputeRulingSlaDays?: number;
  cashoutSlaBusinessHours?: number;
  cashoutReminderRatio?: number;
  emergencyGraceHours?: number;
  emergencyEscalateEveryHours?: number;
  emergencyReminderHours?: readonly number[];
  emergencyReverters?: Record<string, EmergencyReverter>;
  /** Business days before a regulatory report's due date at which the filers are reminded (AUTO-16). Default 3. */
  reportReminderBusinessDays?: number;
  timeZone?: string;
  /** Reads the holiday calendar (`calendar.holidays` platform setting). */
  loadHolidays?: (db: Any) => Promise<Set<string>>;
  audit?: DeadlineContext["audit"];
  notify?: DeadlineContext["notify"];
  /** Rules to run (default all). */
  rules?: readonly DeadlineRuleName[];
}

export interface DeadlineSummary extends WorkerTickResult {
  counts: Record<DeadlineRuleName, number>;
  failed: DeadlineRuleName[];
}

export const loadPlatformHolidays = async (db: Any): Promise<Set<string>> => {
  const rows = (await db.$queryRawUnsafe(
    `SELECT value_json FROM platform_settings WHERE key = 'calendar.holidays' AND scope = 'PLATFORM' AND effective_from <= now()
     ORDER BY version DESC LIMIT 1`,
  )) as Array<{ value_json: unknown }>;
  return parseHolidays(rows[0]?.value_json);
};

/**
 * SLA and deadline escalation (AUTO-04) and unratified emergency actions (AUTO-22). Cluster singleton, every 5 minutes.
 *
 * Seven isolated rules (a failing rule is reported at the end of the tick, never stops the others): operator cases, AML
 * cases, join request reminders, dispute deadlines, cash-out SLA, emergency ratification and regulatory report filing
 * deadlines. Each action is guarded by
 * a `deadline_stages` row claimed in the same transaction (exactly once), audited, bounded per tick, and limited to
 * deadlines inside the catch-up window. See `engine/workers/deadlines/*` for the rules and the decisions D1, D2, D7.
 */
export class DeadlineWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly deps: DeadlineWorkerDeps;
  private readonly audit: DeadlineContext["audit"];
  private readonly notify: DeadlineContext["notify"];
  private readonly rules: readonly DeadlineRuleName[];
  lastSummary: DeadlineSummary | null = null;

  constructor(deps: DeadlineWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 5 * 60 * 1000, batchSize: deps.batchSize ?? 100 });
    this.deps = deps;
    this.audit = deps.audit ?? writeSystemAudit;
    this.notify = deps.notify ?? queueNotice;
    this.rules = deps.rules ?? RULES;
  }

  protected async tick(): Promise<DeadlineSummary> {
    const now = this.clock();
    const ctx: DeadlineContext = {
      db: this.db as Any,
      now,
      batchSize: this.batchSize,
      catchupMs: Math.max(1, this.deps.catchupHours ?? 72) * 3_600_000,
      logger: this.logger,
      inTransaction: (fn) => this.inTransaction((tx) => fn(tx as Any)),
      audit: this.audit,
      notify: this.notify,
    };
    const caseConfig: CaseDeadlineConfig = {
      reminderLeadMs: this.deps.caseReminderLeadMs ?? 60 * 60_000,
      joinReminderLeadMs: this.deps.joinReminderLeadMs ?? 24 * 3_600_000,
      escalationCaseSlaHours: this.deps.caseSlaHours ?? 24,
    };
    const caseSlaHours = this.deps.caseSlaHours ?? 24;
    const counts = Object.fromEntries(RULES.map((rule) => [rule, 0])) as Record<DeadlineRuleName, number>;
    const failed: DeadlineRuleName[] = [];
    const errors: string[] = [];
    const runners: Record<DeadlineRuleName, () => Promise<number>> = {
      operatorCases: () => runOperatorCaseDeadlines(ctx, caseConfig),
      amlCases: () => runAmlCaseDeadlines(ctx, caseConfig),
      joinRequests: () => runJoinRequestReminders(ctx, caseConfig),
      disputes: () =>
        runDisputeDeadlines(ctx, {
          reminderHours: this.deps.disputeReminderHours ?? [72, 24],
          rulingSlaDays: this.deps.disputeRulingSlaDays ?? 30,
          caseSlaHours,
        }),
      cashouts: async () => {
        const calendar: BusinessCalendar = {
          timeZone: this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE,
          holidays: await (this.deps.loadHolidays ?? loadPlatformHolidays)(ctx.db),
        };
        return runCashoutDeadlines(ctx, {
          slaBusinessHours: this.deps.cashoutSlaBusinessHours ?? 24,
          reminderRatio: this.deps.cashoutReminderRatio ?? 0.75,
          caseSlaHours,
          calendar,
        });
      },
      reports: async () =>
        runReportDeadlines(ctx, {
          reminderBusinessDays: this.deps.reportReminderBusinessDays ?? 3,
          caseSlaHours,
          calendar: {
            timeZone: this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE,
            holidays: await (this.deps.loadHolidays ?? loadPlatformHolidays)(ctx.db),
          },
        }),
      emergency: () =>
        runEmergencyDeadlines(ctx, {
          graceHours: this.deps.emergencyGraceHours ?? 48,
          escalateEveryHours: this.deps.emergencyEscalateEveryHours ?? 4,
          reminderHours: this.deps.emergencyReminderHours ?? [4, 1],
          caseSlaHours: Math.min(caseSlaHours, 4),
          reverters: this.deps.emergencyReverters,
        }),
    };
    for (const rule of this.rules) {
      try {
        counts[rule] = await runners[rule]();
      } catch (error) {
        failed.push(rule);
        errors.push(`${rule}: ${sanitizeWorkerError(error)}`);
        this.logger.error("DeadlineWorker: rule failed", { rule, error: sanitizeWorkerError(error) });
      }
    }
    const processed = Object.values(counts).reduce((total, value) => total + value, 0);
    if (processed > 0) this.logger.info("DeadlineWorker: deadlines handled", { ...counts });
    const summary: DeadlineSummary = { processed, counts, failed };
    this.lastSummary = summary;
    if (failed.length > 0) throw new Error(`deadline rules failed (${errors.join("; ")})`);
    return summary;
  }
}
