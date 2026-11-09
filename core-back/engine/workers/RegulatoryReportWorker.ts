import { createHash } from "node:crypto";
import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { bilingualNotice, queueNotice, type NoticeDefinition } from "../../lib/automationNotices";
import { DEFAULT_BUSINESS_TIME_ZONE, type BusinessCalendar } from "./deadlines/businessTime";
import { staffByRole } from "./deadlines/common";
import { loadPlatformHolidays } from "./DeadlineWorker";
import {
  buildAnnualAmlReturn,
  buildLargeTransactionBatch,
  buildMonthlyPaymentReturn,
  buildQuarterlyAmlReturn,
  type PeriodRange,
} from "./regulatory/payloads";
import { businessDayBatches, closedPeriods, dueAfterBatch, dueAfterPeriod, localDate, type ReportPeriod, type ReturnPeriod } from "./regulatory/periods";

type Any = Record<string, any>;

/** Staff queue told about a new draft (the people who review and file it). */
export const REPORT_DRAFT_ROLES = ["MLRO", "COMPLIANCE"] as const;

export const REGULATORY_REPORT_DRAFTED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "REGULATORY_REPORT_DRAFTED",
  audience: "INTERNAL",
  en: {
    subject: "Regulatory report drafted: {{returnCode}} {{periodKey}}",
    body: "A draft of the {{returnCode}} report for {{periodKey}} is ready for review. It is due {{dueAt}}. Review it, complete the sections marked pending, then submit it for approval and file it.",
  },
  ar: {
    subject: "تمت صياغة تقرير تنظيمي: {{returnCode}} {{periodKey}}",
    body: "مسودة التقرير {{returnCode}} للفترة {{periodKey}} جاهزة للمراجعة. موعد تقديمه {{dueAt}}. راجعها وأكمل الأقسام المعلّقة ثم قدّمها للموافقة وقم بتقديمها للجهة المختصة.",
  },
});

export interface RegulatoryReportWorkerDeps extends WorkerOptions {
  /** Encrypts the plaintext JSON payload for storage (production: the vault key `reporting-payload`). */
  encode: (plaintext: string) => Promise<string>;
  /** Closed periods considered per scheduled return per tick (catch-up depth). Default 2. */
  maxPeriods?: number;
  /** Business-day batches considered per tick for the large-transaction report. Default 3. */
  maxBatches?: number;
  /** Lines one large-transaction batch may carry; beyond it the batch is marked truncated. Default 5000. */
  maxBatchLines?: number;
  /** Restricts the worker to these rules. Production leaves it unset; tests that share a database use it. */
  ruleIds?: readonly string[];
  timeZone?: string;
  loadHolidays?: (db: Any) => Promise<Set<string>>;
  audit?: (db: Any, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => Promise<void>;
}

interface ScheduledRule {
  id: string;
  authority: string;
  reportType: "PERIODIC_RETURN" | "LARGE_TRANSACTION" | "SUSPICIOUS_ACTIVITY";
  thresholdAmount: string | null;
  currency: string;
  conditions: Any;
  sourceReference: string | null;
  status: string;
  effectiveFrom: Date;
}

/**
 * Drafts the scheduled regulatory returns (AUTO-16, decision D3: draft automatically, file by a person). Cluster
 * singleton, hourly.
 *
 * The catalogue is DATA: every `reporting_rules` row whose `conditions` carries a `returnCode` is a scheduled return.
 *  - `period` MONTHLY / QUARTERLY / ANNUAL: one DRAFT per closed period (boundaries are local midnights in
 *    `Africa/Tripoli`), idempotent per (return code, period) through the unique index `regulatory_reports_code_period_key`,
 *    with `due_at = period end + dueDays`. Only the most recent `maxPeriods` closed periods are considered, so enabling
 *    the worker on a database with years of history does not draft years of returns.
 *  - `batch: "BUSINESS_DAY"` (the large-transaction report): one DRAFT per business-day batch (a Thursday batch also
 *    holds the weekend) with every transaction at or above the rule's threshold, due the next business day. A batch
 *    without any such transaction produces no report.
 *
 * Nothing here files anything: the report is a DRAFT (confidential, payload encrypted with its SHA-256), the MLRO and
 * compliance queues are told, and the filing, goAML upload and reference recording stay human (the due date is watched
 * by the DeadlineWorker `reports` rule). A report is regenerated, never edited in place, until it is approved: a
 * correction means a new draft (not built: there is no regenerate action yet). The statistics are read-only
 * aggregates; the sections the platform cannot fill from its own data are listed in `pending` in the payload.
 */
export class RegulatoryReportWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly deps: RegulatoryReportWorkerDeps;
  private readonly audit: NonNullable<RegulatoryReportWorkerDeps["audit"]>;

  constructor(deps: RegulatoryReportWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60 * 60 * 1000 });
    this.deps = deps;
    this.audit = deps.audit ?? writeSystemAudit;
  }

  protected async tick(): Promise<WorkerTickResult> {
    const now = this.clock();
    const rules = await this.loadRules(now);
    const calendar: BusinessCalendar = {
      timeZone: this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE,
      holidays: rules.some((rule) => rule.conditions.batch === "BUSINESS_DAY") ? await (this.deps.loadHolidays ?? loadPlatformHolidays)(this.db as Any) : new Set<string>(),
    };
    let created = 0;
    const zone = this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
    const errors: string[] = [];
    for (const rule of rules) {
      try {
        const periods = this.periodsOf(rule, now, calendar);
        for (const period of periods) {
          // Compared as local calendar days: a rule effective from 2026-01-01 (stored as UTC midnight, 02:00 in Tripoli)
          // still owns the period that starts at local midnight of 1 January.
          if (localDate(period.start, zone) < localDate(rule.effectiveFrom, zone)) continue;
          created += await this.draft(rule, period, now, calendar);
        }
      } catch (error) {
        errors.push(`${String(rule.conditions.returnCode)}: ${sanitizeWorkerError(error)}`);
        this.logger.error("RegulatoryReportWorker: rule failed", { returnCode: rule.conditions.returnCode, error: sanitizeWorkerError(error) });
      }
    }
    if (created > 0) this.logger.info("RegulatoryReportWorker: drafts created", { created });
    if (errors.length > 0) throw new Error(`regulatory rules failed (${errors.join("; ")})`);
    return { processed: created };
  }

  private async loadRules(now: Date): Promise<ScheduledRule[]> {
    const scoped = this.deps.ruleIds && this.deps.ruleIds.length > 0;
    const rows = toCamelRows<Any>(
      await this.db.$queryRawUnsafe(
        `SELECT id::text AS id, authority, report_type::text AS report_type, threshold_amount::text AS threshold_amount, currency, conditions,
                source_reference, status::text AS status, effective_from
         FROM reporting_rules
         WHERE conditions ? 'returnCode' AND effective_from <= $1 AND (effective_to IS NULL OR effective_to >= $1)${scoped ? " AND id::text = ANY($2::text[])" : ""}
         ORDER BY effective_from ASC, id ASC`,
        now,
        ...(scoped ? [[...this.deps.ruleIds!]] : []),
      ),
    );
    return rows.map((row) => ({
      id: String(row.id),
      authority: String(row.authority),
      reportType: String(row.reportType) as ScheduledRule["reportType"],
      thresholdAmount: row.thresholdAmount === null || row.thresholdAmount === undefined ? null : String(row.thresholdAmount),
      currency: String(row.currency).trim(),
      conditions: (typeof row.conditions === "string" ? JSON.parse(row.conditions) : row.conditions) as Any,
      sourceReference: row.sourceReference ? String(row.sourceReference) : null,
      status: String(row.status),
      effectiveFrom: row.effectiveFrom instanceof Date ? row.effectiveFrom : new Date(String(row.effectiveFrom)),
    }));
  }

  private periodsOf(rule: ScheduledRule, now: Date, calendar: BusinessCalendar): ReportPeriod[] {
    const zone = this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
    if (rule.conditions.batch === "BUSINESS_DAY") {
      return businessDayBatches(now, Math.max(1, this.deps.maxBatches ?? 3), calendar, zone);
    }
    const period = String(rule.conditions.period ?? "") as ReturnPeriod;
    if (period !== "MONTHLY" && period !== "QUARTERLY" && period !== "ANNUAL") return [];
    return closedPeriods(period, now, Math.max(1, this.deps.maxPeriods ?? 2), zone);
  }

  /** Drafts one (rule, period); returns 1 when a new draft was written. */
  private async draft(rule: ScheduledRule, period: ReportPeriod, now: Date, calendar: BusinessCalendar): Promise<number> {
    const code = String(rule.conditions.returnCode);
    const exists = toCamelRows<Any>(
      await this.db.$queryRawUnsafe(`SELECT 1 AS present FROM regulatory_reports WHERE report_code = $1 AND period_key = $2 LIMIT 1`, code, period.key),
    );
    if (exists.length > 0) return 0;

    const range: PeriodRange = { start: period.start, end: period.end };
    const zone = this.deps.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
    let body: Record<string, unknown>;
    let dueAt: Date;
    if (rule.conditions.batch === "BUSINESS_DAY") {
      body = await buildLargeTransactionBatch(this.db as Any, range, rule.thresholdAmount ?? "0", rule.currency, Math.max(1, this.deps.maxBatchLines ?? 5000));
      if (Number((body.sections as Any).transactionCount) === 0) return 0; // no breach, nothing to report
      dueAt = dueAfterBatch(period.end, calendar, zone);
    } else {
      const builders: Record<string, (db: Any, range: PeriodRange) => Promise<Record<string, unknown>>> = {
        MONTHLY: buildMonthlyPaymentReturn,
        QUARTERLY: buildQuarterlyAmlReturn,
        ANNUAL: buildAnnualAmlReturn,
      };
      body = await builders[String(rule.conditions.period)]!(this.db as Any, range);
      dueAt = dueAfterPeriod(period.end, Number(rule.conditions.dueDays ?? 0), zone);
    }
    const payload = {
      schemaVersion: 1,
      returnCode: code,
      ruleId: rule.id,
      sourceReference: rule.sourceReference,
      provisional: rule.status !== "CONFIRMED",
      period: { key: period.key, start: period.start.toISOString(), end: period.end.toISOString(), timeZone: zone },
      dueAt: dueAt.toISOString(),
      generatedAt: now.toISOString(),
      ...body,
    };
    const plaintext = JSON.stringify(payload);
    const payloadSha256 = createHash("sha256").update(plaintext).digest("hex");
    const payloadCiphertext = await this.deps.encode(plaintext);

    return this.inTransaction(async (tx) => {
      const inserted = toCamelRows<Any>(
        await tx.$queryRawUnsafe(
          `INSERT INTO regulatory_reports (id, created_at, updated_at, report_type, authority, subject_type, subject_id, period_start, period_end, status,
                                           payload_ciphertext, payload_sha256, confidential, due_at, report_code, period_key)
           VALUES (gen_random_uuid(), $1, $1, $2::"ReportingType", $3, 'REPORTING_RULE', $4, $5, $6, 'DRAFT', $7, $8, true, $9, $10, $11)
           ON CONFLICT (report_code, period_key) WHERE report_code IS NOT NULL AND period_key IS NOT NULL DO NOTHING
           RETURNING id::text AS id`,
          now,
          rule.reportType,
          rule.authority,
          rule.id,
          period.start,
          period.end,
          payloadCiphertext,
          payloadSha256,
          dueAt,
          code,
          period.key,
        ),
      );
      if (inserted.length === 0) return 0; // another node drafted it first
      const reportId = String(inserted[0]!.id);
      await this.audit(tx as Any, {
        action: "REGULATORY_REPORT_DRAFTED",
        entityType: "REGULATORY_REPORT",
        entityId: reportId,
        after: { returnCode: code, periodKey: period.key, dueAt: dueAt.toISOString(), payloadSha256, provisionalRule: rule.status !== "CONFIRMED" },
      });
      for (const userId of await staffByRole(tx as Any, REPORT_DRAFT_ROLES)) {
        await queueNotice(tx as Any, {
          definition: REGULATORY_REPORT_DRAFTED_NOTICE,
          eventKey: `report-drafted:${reportId}:${userId}`,
          payload: { returnCode: code, periodKey: period.key, dueAt: dueAt.toISOString().slice(0, 10) },
          userId,
        });
      }
      return 1;
    });
  }
}
