/**
 * AUTO-16 against live PostgreSQL: scheduled drafts per rule and period (idempotent, concurrent-safe, with due dates,
 * encrypted payload, audit and notices), the business-day large-transaction batch, the filing deadline rule, and the
 * per-attempt evaluator leaving scheduled rules alone. Rules are test-private (unique return codes, scoped workers).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { RegulatoryReportWorker } from "../../engine/workers/RegulatoryReportWorker";
import { DeadlineWorker } from "../../engine/workers/DeadlineWorker";
import { ReportingRuleEvaluator, type ReportingRuleRecord } from "../../engine/compliance/ReportingRuleEvaluator";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const DAY = 86_400_000;
const created = { rules: [] as string[], users: [] as string[], catalogs: [] as AutomationCatalog[], codes: [] as string[] };

const disableTestStaff = () => client.$executeRawUnsafe(`UPDATE users SET status = 'DISABLED' WHERE (email LIKE 'dl-%@gateway.test' OR email LIKE 'hk-%@gateway.test' OR email LIKE 'rr-%@gateway.test') AND status = 'ACTIVE'`);
if (databaseIsReachable) await disableTestStaff();

afterAll(async () => {
  for (const code of created.codes) {
    const reports = await client.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM regulatory_reports WHERE report_code = $1`, code);
    for (const report of reports) {
      await client.$executeRawUnsafe(`DELETE FROM deadline_stages WHERE subject_type = 'REPORT' AND subject_id = $1`, report.id);
      await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key = $1`, `report.overdue:${report.id}`);
      await client.$executeRawUnsafe(`DELETE FROM notifications WHERE event_id LIKE $1`, `%${report.id}%`);
    }
    await client.$executeRawUnsafe(`DELETE FROM regulatory_reports WHERE report_code = $1`, code);
  }
  for (const id of created.rules) await client.$executeRawUnsafe(`DELETE FROM reporting_rules WHERE id = $1::uuid`, id);
  for (const catalog of created.catalogs) {
    await client.$executeRawUnsafe(`DELETE FROM payment_attempts WHERE merchant_id = $1::uuid AND currency <> 'LYD'`, catalog.merchantId).catch(() => undefined);
  }
  await cleanupAutomationCatalog(client, created.catalogs);
  await disableTestStaff();
  await client.$disconnect();
});

const code = (prefix: string): string => {
  const value = `${prefix}-${randomUUID().slice(0, 6)}`;
  created.codes.push(value);
  return value;
};

const rule = async (conditions: Record<string, unknown>, options: { reportType?: string; threshold?: string | null; currency?: string; status?: string; effectiveFrom?: Date } = {}): Promise<string> => {
  const row = await client.reportingRule.create({
    data: {
      authority: "CBL",
      reportType: (options.reportType ?? "PERIODIC_RETURN") as never,
      thresholdAmount: options.threshold === undefined || options.threshold === null ? null : options.threshold,
      currency: options.currency ?? "LYD",
      conditions: conditions as never,
      sourceReference: "test rule",
      status: (options.status ?? "PROVISIONAL") as never,
      effectiveFrom: options.effectiveFrom ?? new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  created.rules.push(row.id);
  return row.id;
};

const staff = async (role: string): Promise<string> => {
  const user = await client.user.create({
    data: { email: `rr-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@gateway.test`, role: role as never, status: "ACTIVE", authoritiesMap: {}, isMaker: false, isChecker: false, mfaRequired: false },
  });
  created.users.push(user.id);
  return user.id;
};

const worker = (ruleIds: string[], now: Date, extra: Partial<ConstructorParameters<typeof RegulatoryReportWorker>[0]> = {}) =>
  new RegulatoryReportWorker({
    db: client as never,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    clock: () => now,
    encode: async (plaintext: string) => `enc:${plaintext}`,
    ruleIds,
    loadHolidays: async () => new Set<string>(),
    ...extra,
  } as never);

const reportsOf = (returnCode: string) =>
  client.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT id::text AS id, report_type::text AS report_type, status::text AS status, period_key, period_start, period_end, due_at, payload_ciphertext, payload_sha256, confidential, subject_type, subject_id, authority
     FROM regulatory_reports WHERE report_code = $1 ORDER BY period_key DESC`,
    returnCode,
  );
const payloadOf = (row: Record<string, any>) => JSON.parse(String(row.payload_ciphertext).slice(4)) as Record<string, any>;
const NOW = new Date("2026-11-09T10:00:00.000Z"); // Monday 12:00 in Tripoli

describeDb("scheduled regulatory returns (live PostgreSQL)", () => {
  test("a monthly rule drafts the last closed month: DRAFT, confidential, due 10 days after month end, encrypted payload with its SHA-256, one audit row, MLRO and compliance told", async () => {
    const returnCode = code("TPSP");
    const ruleId = await rule({ returnCode, period: "MONTHLY", dueDays: 10 });
    const mlro = await staff("MLRO");
    const compliance = await staff("COMPLIANCE");
    await worker([ruleId], NOW, { maxPeriods: 1 }).runOnce();

    const reports = await reportsOf(returnCode);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report).toMatchObject({ report_type: "PERIODIC_RETURN", status: "DRAFT", period_key: "2026-10", confidential: true, subject_type: "REPORTING_RULE", subject_id: ruleId, authority: "CBL" });
    expect(new Date(report.period_start).toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(new Date(report.period_end).toISOString()).toBe("2026-10-31T22:00:00.000Z");
    expect(new Date(report.due_at).toISOString()).toBe("2026-11-10T22:00:00.000Z");
    const payload = payloadOf(report);
    expect(payload).toMatchObject({ schemaVersion: 1, returnCode, ruleId, provisional: true, period: { key: "2026-10", timeZone: "Africa/Tripoli" } });
    expect(Object.keys(payload.sections)).toEqual(expect.arrayContaining(["paymentsByRail", "refunds", "disputesOpened", "disputesDecided", "cashouts", "merchants", "fundsPositionAtGeneration"]));
    expect(payload.pending).toContain("serviceAvailabilityAndIncidents");
    expect(createHash("sha256").update(String(report.payload_ciphertext).slice(4)).digest("hex")).toBe(report.payload_sha256);

    const audits = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'REGULATORY_REPORT_DRAFTED' AND entity_id = $1`, report.id);
    expect(Number(audits[0]!.n)).toBe(1);
    for (const userId of [mlro, compliance]) {
      const notices = await client.notification.findMany({ where: { eventId: { startsWith: `notice:report-drafted:${report.id}:${userId}` } } });
      expect(notices.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    }
  });

  test("repeated and concurrent ticks never draft a period twice; each run adds only the periods not drafted yet", async () => {
    const returnCode = code("TIDEM");
    const ruleId = await rule({ returnCode, period: "MONTHLY", dueDays: 10 });
    await Promise.all([worker([ruleId], NOW, { maxPeriods: 1 }).runOnce(), worker([ruleId], NOW, { maxPeriods: 1 }).runOnce(), worker([ruleId], NOW, { maxPeriods: 1 }).runOnce()]);
    await worker([ruleId], NOW, { maxPeriods: 1 }).runOnce();
    expect((await reportsOf(returnCode)).map((row) => row.period_key)).toEqual(["2026-10"]);

    await worker([ruleId], NOW, { maxPeriods: 3 }).runOnce(); // catch-up depth 3: September and August are added
    expect((await reportsOf(returnCode)).map((row) => row.period_key)).toEqual(["2026-10", "2026-09", "2026-08"]);
    await worker([ruleId], NOW, { maxPeriods: 3 }).runOnce();
    expect(await reportsOf(returnCode)).toHaveLength(3);

    // the next month closes at local midnight: a new draft appears exactly then
    const before = new Date("2026-11-30T21:59:59.000Z");
    const after = new Date("2026-11-30T22:00:00.000Z");
    await worker([ruleId], before, { maxPeriods: 1 }).runOnce();
    expect(await reportsOf(returnCode)).toHaveLength(3);
    await worker([ruleId], after, { maxPeriods: 1 }).runOnce();
    expect((await reportsOf(returnCode)).map((row) => row.period_key)[0]).toBe("2026-11");
  });

  test("quarterly and annual rules use their own periods and due days; periods before the rule's effective date are not drafted", async () => {
    const quarterly = code("TQ");
    const annual = code("TA");
    const q = await rule({ returnCode: quarterly, period: "QUARTERLY", dueDays: 15 });
    const a = await rule({ returnCode: annual, period: "ANNUAL", dueDays: 31 });
    const late = code("TLATE");
    const lateRule = await rule({ returnCode: late, period: "MONTHLY", dueDays: 10 }, { effectiveFrom: new Date("2026-10-15T00:00:00.000Z") });
    const now = new Date("2027-01-12T10:00:00.000Z");
    await worker([q, a, lateRule], now, { maxPeriods: 1 }).runOnce();
    const quarter = (await reportsOf(quarterly))[0]!;
    expect(quarter.period_key).toBe("2026-Q4");
    expect(new Date(quarter.due_at).toISOString()).toBe("2027-01-15T22:00:00.000Z"); // 16 Jan 00:00 local
    const year = (await reportsOf(annual))[0]!;
    expect(year.period_key).toBe("2026");
    expect(new Date(year.due_at).toISOString()).toBe("2027-01-31T22:00:00.000Z"); // 1 Feb 00:00 local
    // the last closed month (December) starts after 15 Oct: drafted; with depth 3 October (starts 30 Sep) is not
    await worker([lateRule], now, { maxPeriods: 3 }).runOnce();
    expect((await reportsOf(late)).map((row) => row.period_key)).toEqual(["2026-12", "2026-11"]);
  });

  test("the monthly payload counts the period's own data and nothing outside it", async () => {
    const returnCode = code("TDATA");
    const currency = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const ruleId = await rule({ returnCode, period: "MONTHLY", dueDays: 10 });
    const catalog = await createAutomationCatalog(client, { label: "regrep" });
    created.catalogs.push(catalog);
    const inside = new Date("2026-10-15T09:00:00.000Z");
    const outside = new Date("2026-09-15T09:00:00.000Z");
    const a = await catalog.newAttempt({ status: "SUCCEEDED", amount: "120.5000", createdAt: inside });
    await catalog.newAttempt({ status: "FAILED", amount: "10.0000", createdAt: inside });
    await catalog.newAttempt({ status: "SUCCEEDED", amount: "999.0000", createdAt: outside });
    expect(a.id).toBeTruthy();
    // Regulatory returns cover LIVE attempts only; the catalog creates SANDBOX
    // fixtures, so mark this merchant's attempts live for the return.
    await client.$executeRawUnsafe(`UPDATE payment_attempts SET env = 'LIVE', currency = $2 WHERE merchant_id = $1::uuid`, catalog.merchantId, currency);
    await worker([ruleId], NOW, { maxPeriods: 1 }).runOnce();
    const payload = payloadOf((await reportsOf(returnCode))[0]!);
    const mine = (payload.sections.paymentsByRail as Array<Record<string, any>>).filter((row) => row.currency === currency);
    const total = mine.reduce((sum, row) => sum + row.attempts, 0);
    expect(total).toBeGreaterThanOrEqual(2);
    const succeededValue = mine.reduce((sum, row) => sum + Number(row.valueSucceeded), 0);
    expect(succeededValue).toBeGreaterThanOrEqual(120.5);
    // the September attempt (999.00) is not in October's return: its value is not part of this month's total unless another suite's attempts are
    const only = await client.$queryRawUnsafe<Array<{ amount: string }>>(
      `SELECT coalesce(sum(requested_amount), 0)::text AS amount FROM payment_attempts WHERE created_at >= '2026-09-30T22:00:00Z' AND created_at < '2026-10-31T22:00:00Z' AND status = 'SUCCEEDED' AND currency = $1`,
      currency,
    );
    expect(succeededValue).toBeCloseTo(Number(only[0]!.amount), 2);
  });

  test("a failing builder reports the failure but the other rules still draft", async () => {
    const broken = code("TBAD");
    const ok = code("TOK");
    const brokenRule = await rule({ returnCode: broken, period: "MONTHLY", dueDays: 10 });
    const okRule = await rule({ returnCode: ok, period: "MONTHLY", dueDays: 10 });
    const instance = worker([brokenRule, okRule], NOW, {
      maxPeriods: 1,
      encode: async (plaintext: string) => {
        if (JSON.parse(plaintext).returnCode === broken) throw new Error("cipher unavailable");
        return `enc:${plaintext}`;
      },
    });
    await expect(instance.runOnce()).rejects.toThrow(/cipher unavailable/);
    expect(await reportsOf(broken)).toHaveLength(0);
    expect(await reportsOf(ok)).toHaveLength(1);
    // once the cipher works the next tick drafts the failed one
    await worker([brokenRule], NOW, { maxPeriods: 1 }).runOnce();
    expect(await reportsOf(broken)).toHaveLength(1);
  });
});

describeDb("large-transaction batches (live PostgreSQL)", () => {
  // Sunday 2026-11-08 06:00Z: Thursday 2026-11-05's batch (Thursday + the weekend) is complete.
  const sunday = new Date("2026-11-08T06:00:00.000Z");
  const letters = (): string => Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

  const attemptsIn = async (currency: string, amounts: Array<[string, string, Date]>) => {
    const catalog = await createAutomationCatalog(client, { label: "ltr" });
    created.catalogs.push(catalog);
    for (const [status, amount, at] of amounts) {
      const attempt = await catalog.newAttempt({ status, amount, createdAt: at });
      await client.$executeRawUnsafe(`UPDATE payment_attempts SET currency = $2, env = 'LIVE' WHERE id = $1::uuid`, attempt.id, currency);
    }
    return catalog;
  };

  test("one draft per business-day batch holding every transaction at or above the threshold, due the next business day", async () => {
    const currency = letters();
    const returnCode = code("TLTR");
    const ruleId = await rule({ returnCode, batch: "BUSINESS_DAY", dueBusinessDays: 1 }, { reportType: "LARGE_TRANSACTION", threshold: "50000.0000", currency });
    await attemptsIn(currency, [
      ["SUCCEEDED", "60000.0000", new Date("2026-11-05T08:00:00.000Z")], // Thursday: in
      ["SUCCEEDED", "50000.0000", new Date("2026-11-06T10:00:00.000Z")], // Friday (weekend part of Thursday's batch): in, exactly at the threshold
      ["SUCCEEDED", "49999.9999", new Date("2026-11-05T09:00:00.000Z")], // below
      ["FAILED", "80000.0000", new Date("2026-11-05T09:30:00.000Z")], // not successful
      ["SUCCEEDED", "70000.0000", new Date("2026-11-04T21:00:00.000Z")], // Wednesday 23:00 local: Wednesday's batch, not Thursday's
    ]);
    await worker([ruleId], sunday, { maxBatches: 1 }).runOnce();
    const reports = await reportsOf(returnCode);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report).toMatchObject({ report_type: "LARGE_TRANSACTION", status: "DRAFT", period_key: "2026-11-05" });
    expect(new Date(report.due_at).toISOString()).toBe("2026-11-08T22:00:00.000Z"); // end of Sunday 8 Nov
    const payload = payloadOf(report);
    expect(payload.sections.transactionCount).toBe(2);
    expect(payload.sections.transactions.map((row: any) => row.amount)).toEqual(["60000.0000", "50000.0000"]);
    expect(payload.sections.truncated).toBe(false);
    expect(payload.sections.transactions.every((row: any) => row.currency === currency && row.status === "SUCCEEDED")).toBe(true);

    // Wednesday's batch (one transaction) appears when the depth allows it, and a repeat adds nothing
    await worker([ruleId], sunday, { maxBatches: 2 }).runOnce();
    await worker([ruleId], sunday, { maxBatches: 2 }).runOnce();
    expect((await reportsOf(returnCode)).map((row) => row.period_key)).toEqual(["2026-11-05", "2026-11-04"]);
  });

  test("a batch without any breach produces no report; a long batch is truncated and says so", async () => {
    const currency = letters();
    const quietCode = code("TLTQ");
    const quietRule = await rule({ returnCode: quietCode, batch: "BUSINESS_DAY" }, { reportType: "LARGE_TRANSACTION", threshold: "50000.0000", currency });
    await worker([quietRule], sunday, { maxBatches: 3 }).runOnce();
    expect(await reportsOf(quietCode)).toHaveLength(0);

    const busyCurrency = letters();
    const busyCode = code("TLTB");
    const busyRule = await rule({ returnCode: busyCode, batch: "BUSINESS_DAY" }, { reportType: "LARGE_TRANSACTION", threshold: "1.0000", currency: busyCurrency });
    await attemptsIn(busyCurrency, [
      ["SUCCEEDED", "10.0000", new Date("2026-11-05T08:00:00.000Z")],
      ["SUCCEEDED", "11.0000", new Date("2026-11-05T08:01:00.000Z")],
      ["SUCCEEDED", "12.0000", new Date("2026-11-05T08:02:00.000Z")],
    ]);
    await worker([busyRule], sunday, { maxBatches: 1, maxBatchLines: 2 }).runOnce();
    const payload = payloadOf((await reportsOf(busyCode))[0]!);
    expect(payload.sections.transactionCount).toBe(2);
    expect(payload.sections.truncated).toBe(true);
    expect(payload.pending).toContain("batchTruncatedAtLimit");
  });

  test("a holiday moves the batch boundary and the due date", async () => {
    const currency = letters();
    const returnCode = code("TLTH");
    const ruleId = await rule({ returnCode, batch: "BUSINESS_DAY" }, { reportType: "LARGE_TRANSACTION", threshold: "10.0000", currency });
    await attemptsIn(currency, [["SUCCEEDED", "20.0000", new Date("2026-11-05T08:00:00.000Z")]]);
    // Sunday 8 Nov is a holiday: Thursday's batch runs to Monday's midnight and is due at the end of Monday
    const monday = new Date("2026-11-09T06:00:00.000Z");
    await worker([ruleId], monday, { maxBatches: 1, loadHolidays: async () => new Set(["2026-11-08"]) }).runOnce();
    const report = (await reportsOf(returnCode))[0]!;
    expect(report.period_key).toBe("2026-11-05");
    expect(new Date(report.period_end).toISOString()).toBe("2026-11-08T22:00:00.000Z");
    expect(new Date(report.due_at).toISOString()).toBe("2026-11-09T22:00:00.000Z");
  });
});

describeDb("filing deadlines (live PostgreSQL)", () => {
  const insertReport = async (returnCode: string, dueAt: Date, status = "DRAFT"): Promise<string> => {
    const id = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO regulatory_reports (id, created_at, updated_at, report_type, authority, subject_type, subject_id, status, payload_ciphertext, payload_sha256, confidential, due_at, report_code, period_key)
       VALUES ($1::uuid, now(), now(), 'PERIODIC_RETURN', 'CBL', 'REPORTING_RULE', $2, $3::"RegulatoryReportStatus", 'x', $4, true, $5, $6, $7)`,
      id,
      randomUUID(),
      status,
      "0".repeat(64),
      dueAt,
      returnCode,
      `p-${randomUUID().slice(0, 6)}`,
    );
    return id;
  };
  const deadline = (now: Date) =>
    new DeadlineWorker({
      db: client as never,
      repositories: createFakeRepositories(),
      logger: quiet,
      healthRegistry: null,
      clock: () => now,
      rules: ["reports"],
      loadHolidays: async () => new Set<string>(),
    });
  const stageCount = async (id: string, stage: string): Promise<number> =>
    Number((await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM deadline_stages WHERE subject_type = 'REPORT' AND subject_id = $1 AND stage = $2`, id, stage))[0]!.n);

  test("the filers are reminded within the business-day lead, once; a far-away report is not; an overdue one opens ONE P1 case", async () => {
    const returnCode = code("TDL");
    await staff("MLRO");
    const now = new Date();
    const soon = await insertReport(returnCode, new Date(now.getTime() + DAY));
    const far = await insertReport(returnCode, new Date(now.getTime() + 13 * DAY));
    await deadline(now).runOnce();
    await deadline(now).runOnce();
    expect(await stageCount(soon, "REMINDER")).toBe(1);
    expect(await stageCount(far, "REMINDER")).toBe(0);

    const late = await insertReport(returnCode, new Date(now.getTime() - 3_600_000), "PENDING_CHECKER");
    const filed = await insertReport(returnCode, new Date(now.getTime() - 3_600_000), "SUBMITTED");
    await deadline(now).runOnce();
    await deadline(now).runOnce();
    expect(await stageCount(late, "OVERDUE")).toBe(1);
    expect(await stageCount(filed, "OVERDUE")).toBe(0);
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `report.overdue:${late}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ priority: "P1", kind: "MANUAL_REVIEW" });
    expect(cases[0]!.resolutionNotes).toContain(late);
    expect(await client.operatorCase.count({ where: { subjectKey: `report.overdue:${filed}` } })).toBe(0);
    const audits = await client.$queryRawUnsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'REGULATORY_REPORT_OVERDUE' AND entity_id = $1`, late);
    expect(Number(audits[0]!.n)).toBe(1);
  });

  test("a missed filing is not forgotten after the generic catch-up window: 10 days overdue is still escalated, 60 days is not", async () => {
    const returnCode = code("TDL2");
    const now = new Date();
    const tenDays = await insertReport(returnCode, new Date(now.getTime() - 10 * DAY));
    const sixtyDays = await insertReport(returnCode, new Date(now.getTime() - 60 * DAY));
    await deadline(now).runOnce();
    expect(await stageCount(tenDays, "OVERDUE")).toBe(1);
    expect(await stageCount(sixtyDays, "OVERDUE")).toBe(0);
  });
});

describe("the per-attempt evaluator and scheduled rules", () => {
  const record = (conditions: unknown, id: string): ReportingRuleRecord => ({
    id,
    authority: "CBL",
    reportType: "LARGE_TRANSACTION",
    thresholdAmount: "50000.0000",
    windowSeconds: null,
    currency: "LYD",
    conditions,
    sourceReference: null,
    status: "CONFIRMED",
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
  });

  test("a rule that names a returnCode is never fired per attempt; an ordinary rule still is", async () => {
    const createdReports: Array<{ reportType: string }> = [];
    const evaluator = new ReportingRuleEvaluator(
      {
        listRules: async () => [record({ returnCode: "LTR", batch: "BUSINESS_DAY" }, "scheduled"), record({}, "ordinary")],
        listReportsForAttempt: async () => [],
        createReport: async (data) => {
          createdReports.push({ reportType: data.reportType });
          return { id: `r${createdReports.length}` };
        },
      },
      { now: () => new Date("2026-11-09T10:00:00.000Z") },
    );
    const result = await evaluator.evaluate({ id: "attempt-1", amount: "60000", currency: "LYD", merchantId: "m1" });
    expect(result.created).toHaveLength(1);
    expect(createdReports).toHaveLength(1);
  });
});
