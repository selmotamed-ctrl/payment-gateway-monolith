import { describe, expect, test } from "bun:test";
import {
  ReportingRuleEvaluator,
  type RegulatoryReportCreateData,
  type RegulatoryReportRecord,
  type ReportingRuleRecord,
} from "../engine/compliance/ReportingRuleEvaluator";
import {
  DynamicRailEngine,
  type DynamicAttempt,
  type DynamicRailEngineOptions,
  type ReportingEvaluationInput,
} from "../engine/flow/DynamicRailEngine";
import type { FlowStep } from "../engine/flow/StepExecutor";

const NOW = new Date("2026-06-01T00:00:00.000Z");

const rule = (overrides: Partial<ReportingRuleRecord> = {}): ReportingRuleRecord => ({
  id: "rule-large-transaction",
  authority: "CBL",
  reportType: "LARGE_TRANSACTION",
  thresholdAmount: "50000.0000",
  windowSeconds: null,
  currency: "LYD",
  conditions: {},
  sourceReference: "CBL-LT-001",
  status: "CONFIRMED",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  ...overrides,
});

type StoredReport = RegulatoryReportRecord & { subjectId: string };

const createSource = (rules: ReportingRuleRecord[]) => {
  const reports: StoredReport[] = [];
  let sequence = 0;
  return {
    reports,
    source: {
      listRules: async () => rules,
      listReportsForAttempt: async (attemptId: string) =>
        reports.filter((report) => report.subjectId === attemptId),
      createReport: async (data: RegulatoryReportCreateData) => {
        sequence += 1;
        const report: StoredReport = {
          id: `report-${sequence}`,
          subjectId: data.subjectId,
          reportType: data.reportType,
          payloadCiphertext: data.payloadCiphertext,
          status: data.status,
        };
        reports.push(report);
        return { id: report.id };
      },
    },
  };
};

const settledAttempt = {
  id: "attempt-1",
  merchantId: "merchant-1",
  amount: "75000.0000",
  currency: "LYD",
  status: "SUCCEEDED",
  settledAt: NOW,
};

describe("reporting rule evaluator", () => {
  test("a CONFIRMED rule above its threshold creates a PENDING_CHECKER report", async () => {
    const harness = createSource([rule()]);
    const evaluator = new ReportingRuleEvaluator(harness.source, { now: () => NOW });

    const result = await evaluator.evaluate(settledAttempt);

    expect(result.created).toEqual(["report-1"]);
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0]?.status).toBe("PENDING_CHECKER");
    expect(harness.reports[0]?.reportType).toBe("LARGE_TRANSACTION");
    const payload = JSON.parse(harness.reports[0]?.payloadCiphertext ?? "{}") as Record<string, unknown>;
    expect(payload.ruleId).toBe("rule-large-transaction");
    expect(payload.attemptId).toBe("attempt-1");
    expect(payload.internalOnly).toBe(false);
  });

  test("a PROVISIONAL rule never creates a live report", async () => {
    const harness = createSource([rule({
      id: "rule-suspicious",
      reportType: "SUSPICIOUS_ACTIVITY",
      status: "PROVISIONAL",
      thresholdAmount: "10000.0000",
    })]);
    const evaluator = new ReportingRuleEvaluator(harness.source, { now: () => NOW });

    const result = await evaluator.evaluate(settledAttempt);

    expect(result.created).toEqual(["report-1"]);
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0]?.status).toBe("DRAFT");
    expect(harness.reports.some((report) => report.status === "PENDING_CHECKER")).toBe(false);
    const payload = JSON.parse(harness.reports[0]?.payloadCiphertext ?? "{}") as Record<string, unknown>;
    expect(payload.internalOnly).toBe(true);
  });

  test("a below-threshold attempt creates no report", async () => {
    const harness = createSource([rule()]);
    const evaluator = new ReportingRuleEvaluator(harness.source, { now: () => NOW });

    const result = await evaluator.evaluate({ ...settledAttempt, amount: "49999.9999" });

    expect(result.created).toEqual([]);
    expect(harness.reports).toHaveLength(0);
  });

  test("re-evaluating the same settled attempt is idempotent", async () => {
    const harness = createSource([rule()]);
    const evaluator = new ReportingRuleEvaluator(harness.source, { now: () => NOW });

    const first = await evaluator.evaluate(settledAttempt);
    const second = await evaluator.evaluate(settledAttempt);

    expect(first.created).toEqual(["report-1"]);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(["rule-large-transaction"]);
    expect(harness.reports).toHaveLength(1);
  });
});

describe("reporting evaluation on settlement", () => {
  test("the confirmation path evaluates the reporting rules once per settled attempt", async () => {
    const attempt: DynamicAttempt = {
      id: "attempt-settled",
      reference: "PA-SETTLED",
      gatewayReference: "GW-SETTLED",
      status: "AWAITING_CUSTOMER",
      env: "SANDBOX",
      currency: "LYD",
      requestedAmount: "100.0000",
      totalChargedAmount: "100.0000",
      settledAmount: "100.0000",
      platformCommissionAmount: "3.0000",
      netMerchantAmount: "97.0000",
      merchantId: "merchant-1",
      otpAttempts: 0,
      ownershipMode: "PLATFORM_CLEARING",
      context: {},
    };
    const attempts = new Map<string, DynamicAttempt>([[attempt.id, attempt]]);
    const SUBMIT_STEP: FlowStep = { id: "submit", type: "HTTP", side_effect: "MOVES_MONEY" };
    const evaluated: ReportingEvaluationInput[] = [];
    const options: DynamicRailEngineOptions = {
      attempts: {
        getAttempt: async (id) => attempts.get(id) ?? null,
        updateAttempt: async (id, patch) => {
          const target = attempts.get(id);
          if (!target) throw new Error("attempt not found");
          Object.assign(target, patch);
          return target;
        },
      },
      slots: {
        reserveSlot: async (target) => ({ reservationId: target.id }),
        releaseSlot: async () => undefined,
        commitSlot: async () => ({ outcome: "COMMITTED", journalEntryId: "journal-1" }),
      },
      flowProvider: {
        getSteps: async (phase) => (phase === "SUBMIT" ? [SUBMIT_STEP] : []),
      },
      stepExecutor: {
        execute: async () => ({
          stepId: "submit",
          status: "SUCCEEDED" as const,
          response: {
            status: "SUCCESS",
            reference: "GW-SETTLED",
            amount: "100.0000",
            currency: "LYD",
            environment: "SANDBOX",
          },
          output: { state: {}, public: {} },
          logs: [],
        }),
      } as never,
      ledgerPoster: {
        postPaymentConfirmation: async () => ({ entry: { id: "journal-1" } }),
      },
      reportingEvaluator: {
        evaluate: async (input) => {
          evaluated.push(input);
        },
      },
      now: () => NOW,
    };

    const engine = new DynamicRailEngine(options);
    const result = await engine.confirm(attempt, { otp: "123456" });

    expect(result.status).toBe("SUCCEEDED");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toMatchObject({
      id: "attempt-settled",
      merchantId: "merchant-1",
      amount: "100.0000",
      currency: "LYD",
      status: "SUCCEEDED",
    });
  });
});
