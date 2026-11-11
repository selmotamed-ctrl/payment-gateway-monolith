import { createHash } from "node:crypto";
import type { PrismaLike } from "../db/ports";
import { decimal, type DecimalInput } from "../ledger/LedgerPoster";
import { ReportGenerationService } from "./reporting/ReportGenerationService";
import { ensureBaselineReportingSchemas } from "./reporting/baselineSchemas";
import type { ReportOutputFormat } from "./reporting/types";

export type ReportingRuleStatus = "PROVISIONAL" | "CONFIRMED";
export type ReportingType = "LARGE_TRANSACTION" | "SUSPICIOUS_ACTIVITY" | "PERIODIC_RETURN" | "INCIDENT";
export type RegulatoryReportStatus =
  | "DRAFT"
  | "PENDING_CHECKER"
  | "APPROVED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "REJECTED_BY_AUTHORITY";

export interface ReportingRuleRecord {
  id: string;
  authority: string;
  reportType: ReportingType;
  thresholdAmount: unknown;
  windowSeconds: number | null;
  currency: string;
  conditions: unknown;
  sourceReference: string | null;
  status: ReportingRuleStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  requiredOutputFormats?: string[];
}

export interface RegulatoryReportRecord {
  id: string;
  reportType: ReportingType;
  payloadCiphertext: string;
  status: RegulatoryReportStatus;
}

export interface RegulatoryReportCreateData {
  reportType: ReportingType;
  authority: string;
  subjectType: string;
  subjectId: string;
  periodStart: Date;
  periodEnd: Date;
  status: RegulatoryReportStatus;
  payloadCiphertext: string;
  payloadSha256: string;
  confidential: boolean;
  reportCode?: string | null;
  periodKey?: string | null;
  dueAt?: Date | null;
  requiredOutputFormats?: string[];
}

export interface ReportingRuleSource {
  listRules(): Promise<ReportingRuleRecord[]>;
  listReportsForAttempt(attemptId: string): Promise<RegulatoryReportRecord[]>;
  createReport(data: RegulatoryReportCreateData): Promise<{ id: string }>;
  generateOutputs?(
    reportId: string,
    payload: Record<string, unknown>,
    ruleId: string,
    formats: string[],
  ): Promise<void>;
}

export interface ReportingPayloadCodec {
  encode(plaintext: string): string | Promise<string>;
  decode(ciphertext: string): string | Promise<string>;
}

export interface ReportingEvaluationAttempt {
  id: string;
  merchantId?: string;
  amount: DecimalInput;
  currency: string;
  status?: string;
  settledAt?: Date;
}

export interface ReportingEvaluationResult {
  created: string[];
  skipped: string[];
}

const plaintextCodec: ReportingPayloadCodec = {
  encode: (plaintext) => plaintext,
  decode: (ciphertext) => ciphertext,
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const conditionsMatch = (
  conditions: unknown,
  attempt: ReportingEvaluationAttempt,
  amount: ReturnType<typeof decimal>,
): boolean => {
  const record = asRecord(conditions);
  if (!record) {
    return true;
  }
  const merchantId = attempt.merchantId;
  const merchantIds = record.merchantIds;
  if (Array.isArray(merchantIds)) {
    if (!merchantId || !merchantIds.map(String).includes(merchantId)) {
      return false;
    }
  }
  if (typeof record.merchantId === "string" && record.merchantId !== merchantId) {
    return false;
  }
  const currencies = record.currencies;
  if (Array.isArray(currencies)) {
    if (!currencies.map((value) => String(value).toUpperCase()).includes(attempt.currency.toUpperCase())) {
      return false;
    }
  }
  if (record.minAmount !== undefined) {
    try {
      if (amount.lt(decimal(record.minAmount as DecimalInput))) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (record.maxAmount !== undefined) {
    try {
      if (amount.gt(decimal(record.maxAmount as DecimalInput))) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
};

/** True for a catalogue rule that a worker drafts on a schedule (it names its `returnCode`). */
export const isScheduledReturnRule = (conditions: unknown): boolean => {
  const record = asRecord(conditions);
  return typeof record?.returnCode === "string" && record.returnCode.length > 0;
};

export class ReportingRuleEvaluator {
  private readonly source: ReportingRuleSource;
  private readonly codec: ReportingPayloadCodec;
  private readonly now: () => Date;

  constructor(
    source: ReportingRuleSource,
    options: { codec?: ReportingPayloadCodec; now?: () => Date } = {},
  ) {
    this.source = source;
    this.codec = options.codec ?? plaintextCodec;
    this.now = options.now ?? (() => new Date());
  }

  async evaluate(
    attempt: ReportingEvaluationAttempt,
    options: { now?: Date } = {},
  ): Promise<ReportingEvaluationResult> {
    const now = options.now ?? this.now();
    const amount = decimal(attempt.amount);
    const rules = await this.source.listRules();
    const reports = await this.source.listReportsForAttempt(attempt.id);
    const firedRules = await this.firedRuleIds(reports);
    const created: string[] = [];
    const skipped: string[] = [];

    for (const rule of rules) {
      if (!this.isEffective(rule, now) || rule.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
        continue;
      }
      // A scheduled return (AUTO-16: `conditions.returnCode`) is drafted per period or per business day by the
      // RegulatoryReportWorker, never once per payment attempt.
      if (isScheduledReturnRule(rule.conditions)) {
        continue;
      }
      if (rule.thresholdAmount !== null && rule.thresholdAmount !== undefined) {
        const threshold = decimal(rule.thresholdAmount as DecimalInput);
        if (!amount.gte(threshold)) {
          continue;
        }
      }
      if (!conditionsMatch(rule.conditions, attempt, amount)) {
        continue;
      }
      if (firedRules.has(rule.id)) {
        skipped.push(rule.id);
        continue;
      }
      const status: RegulatoryReportStatus = "DRAFT";
      const periodEnd = now;
      const periodStart = rule.windowSeconds && rule.windowSeconds > 0
        ? new Date(now.getTime() - rule.windowSeconds * 1000)
        : now;
      const reportCode = rule.reportType === "SUSPICIOUS_ACTIVITY"
        ? "STR"
        : rule.reportType === "LARGE_TRANSACTION"
          ? "LTR"
          : null;
      const requiredOutputFormats = (rule.requiredOutputFormats ?? (reportCode === "STR" ? ["XML"] : reportCode === "LTR" ? ["XML", "XLSX"] : []))
        .filter((format): format is "XML" | "XLSX" | "DOCX" => format === "XML" || format === "XLSX" || format === "DOCX");
      const payload = {
        ruleId: rule.id,
        sourceReference: rule.sourceReference,
        reportType: rule.reportType,
        authority: rule.authority,
        internalOnly: rule.status !== "CONFIRMED",
        attemptId: attempt.id,
        merchantId: attempt.merchantId ?? null,
        amount: amount.toFixed(4),
        currency: attempt.currency,
        attemptStatus: attempt.status ?? null,
        windowSeconds: rule.windowSeconds,
        conditions: rule.conditions,
        generatedAt: now.toISOString(),
      };
      const plaintext = JSON.stringify(payload);
      const payloadSha256 = createHash("sha256").update(plaintext).digest("hex");
      const payloadCiphertext = await this.codec.encode(plaintext);
      const report = await this.source.createReport({
        reportType: rule.reportType,
        authority: rule.authority,
        subjectType: "PAYMENT_ATTEMPT",
        subjectId: attempt.id,
        periodStart,
        periodEnd,
        status,
        payloadCiphertext,
        payloadSha256,
        confidential: true,
        reportCode,
        periodKey: `attempt:${attempt.id}:${rule.id}`,
        dueAt: null,
        requiredOutputFormats,
      });
      if (this.source.generateOutputs && requiredOutputFormats.length > 0) {
        await this.source.generateOutputs(report.id, payload, rule.id, requiredOutputFormats);
      }
      firedRules.add(rule.id);
      created.push(report.id);
    }
    return { created, skipped };
  }

  private isEffective(rule: ReportingRuleRecord, now: Date): boolean {
    if (rule.effectiveFrom.getTime() > now.getTime()) {
      return false;
    }
    return rule.effectiveTo === null || rule.effectiveTo.getTime() >= now.getTime();
  }

  private async firedRuleIds(reports: RegulatoryReportRecord[]): Promise<Set<string>> {
    const fired = new Set<string>();
    for (const report of reports) {
      try {
        const decoded = await this.codec.decode(report.payloadCiphertext);
        const payload = asRecord(JSON.parse(decoded));
        const ruleId = payload?.ruleId;
        if (typeof ruleId === "string" && ruleId.length > 0) {
          fired.add(ruleId);
        }
      } catch {
        continue;
      }
    }
    return fired;
  }
}

export class PrismaReportingRuleSource implements ReportingRuleSource {
  private readonly client: PrismaLike;
  private readonly generation = new ReportGenerationService();
  private baselineReady = false;

  constructor(client: PrismaLike) {
    this.client = client;
  }

  async listRules(): Promise<ReportingRuleRecord[]> {
    return await this.client.reportingRule.findMany() as ReportingRuleRecord[];
  }

  async listReportsForAttempt(attemptId: string): Promise<RegulatoryReportRecord[]> {
    return await this.client.regulatoryReport.findMany({
      where: { subjectType: "PAYMENT_ATTEMPT", subjectId: attemptId },
    }) as RegulatoryReportRecord[];
  }

  async createReport(data: RegulatoryReportCreateData): Promise<{ id: string }> {
    const created = await this.client.regulatoryReport.create({ data: data as never });
    return { id: String(created.id) };
  }

  async generateOutputs(
    reportId: string,
    payload: Record<string, unknown>,
    ruleId: string,
    formats: string[],
  ): Promise<void> {
    const db = this.client as unknown as Record<string, any>;
    if (!this.baselineReady && typeof db.regulatoryReportSchema?.findUnique === "function") {
      try {
        await ensureBaselineReportingSchemas(db);
        this.baselineReady = true;
      } catch {
        // The report remains DRAFT with no output; the worker/API can retry.
      }
    }
    const report = await db.regulatoryReport.findUnique({ where: { id: reportId } });
    if (!report) return;
    await this.generation.generate(db, {
      report: {
        id: String(report.id),
        reportType: String(report.reportType),
        reportCode: report.reportCode ?? null,
        authority: String(report.authority),
        subjectType: String(report.subjectType),
        subjectId: String(report.subjectId),
        amlCaseId: report.amlCaseId ?? null,
        periodStart: report.periodStart ?? null,
        periodEnd: report.periodEnd ?? null,
        periodKey: report.periodKey ?? null,
        dueAt: report.dueAt ?? null,
        requiredOutputFormats: (report.requiredOutputFormats ?? []) as string[],
      },
      payload,
      ruleId,
      formats: formats as ReportOutputFormat[],
    });
  }
}
