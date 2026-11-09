import { describe, expect, test } from "bun:test";
import { PrismaRepositories, WINDOW_AMOUNTS_IN_BAND_CAP } from "../engine/db/repositories";
import { moneyFromDecimal } from "../engine/db/money";
import type { Tx } from "../engine/db/ports";
import { evaluateAmlRules, structuringBand, structuringBands, type AmlRuleDefinition } from "../engine/guards/AmlRuleEngine";
import { createRecordingDb } from "./edge-cases/helpers";

/**
 * Regression: `collectWindowStats` runs on every payment creation (the AML guard) and loaded every
 * attempt of the merchant's 24-hour window with an unbounded findMany, summing them in JavaScript.
 * It now asks PostgreSQL for the count and the total, and loads individual amounts only inside the
 * STRUCTURING bands (the only rules that read them), capped.
 */

const SINCE = new Date("2026-06-01T00:00:00.000Z");

const run = async (
  filter: Record<string, unknown>,
  answers: { aggregate?: Record<string, unknown>; inBand?: Array<Record<string, unknown>> } = {},
) => {
  const { db, calls } = createRecordingDb({
    onQuery: (sql) => {
      if (sql.includes("count(*)")) return [answers.aggregate ?? { count: 0, total: "0" }];
      return answers.inBand ?? [];
    },
  });
  // Any ORM fallback would show up as a missing method, so the fake has none.
  const stats = await new PrismaRepositories(db).payments.collectWindowStats(db as unknown as Tx, {
    merchantId: "11111111-1111-1111-1111-111111111111",
    since: SINCE,
    ...filter,
  } as never);
  return { stats, queries: calls.filter((call) => call.kind === "query") };
};

const rule = (overrides: Partial<AmlRuleDefinition> = {}): AmlRuleDefinition => ({
  id: "rule-1",
  code: "STRUCT",
  name: "Structuring",
  ruleType: "STRUCTURING",
  scope: {},
  params: { threshold: "10000", band_percent: 10, min_count: 2 },
  action: "CASE_ONLY",
  baseSeverity: "MEDIUM",
  active: true,
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  ...overrides,
});

describe("collectWindowStats aggregates in SQL", () => {
  test("count and total come from one aggregate, with no amounts loaded when no band is asked", async () => {
    const { stats, queries } = await run({}, { aggregate: { count: 12, total: "1234.5600" } });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("SELECT count(*)::int AS count, COALESCE(SUM(");
    expect(queries[0]?.sql).toContain("FROM payment_attempts WHERE created_at >= $1");
    expect(queries[0]?.args[0]).toBe(SINCE);
    expect(stats).toEqual({ count: 12, totalAmount: moneyFromDecimal("1234.5600"), amounts: [] });
  });

  test("the subject filter is bound, never interpolated", async () => {
    const { queries } = await run({
      applicationId: "22222222-2222-2222-2222-222222222222",
      clientIp: "198.51.100.7' OR '1'='1",
    });

    const sql = queries[0]?.sql ?? "";
    expect(sql).toMatch(/\(merchant_id = \$\d+::uuid OR application_id = \$\d+::uuid OR client_ip = \$\d+\)/);
    expect(sql).not.toContain("198.51.100.7");
    expect(queries[0]?.args).toContain("198.51.100.7' OR '1'='1");
    // The same statuses as before: live or settled attempts count, failed/expired/blocked do not.
    for (const status of ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "SUCCEEDED", "UNKNOWN"]) {
      expect(queries[0]?.args).toContain(status);
    }
    expect(queries[0]?.args).not.toContain("FAILED");
  });

  test("amounts are loaded only inside the requested bands, capped, as exact decimals", async () => {
    const { stats, queries } = await run(
      { amountBands: [{ lower: moneyFromDecimal("9000"), upper: moneyFromDecimal("10000") }] },
      { aggregate: { count: 3, total: "27000.0000" }, inBand: [{ amount: "9000.0000" }, { amount: "9999.9999" }] },
    );

    expect(queries).toHaveLength(2);
    const band = queries[1];
    expect(band?.sql).toMatch(/>= \$\d+::numeric AND COALESCE\(total_charged_amount, requested_amount, 0\) < \$\d+::numeric/);
    expect(band?.sql).toContain(`LIMIT ${WINDOW_AMOUNTS_IN_BAND_CAP}`);
    expect(band?.args).toContain("9000.0000");
    expect(band?.args).toContain("10000.0000");
    expect(stats.count).toBe(3);
    expect(stats.amounts).toEqual([moneyFromDecimal("9000.0000"), moneyFromDecimal("9999.9999")]);
  });
});

describe("structuring bands match the STRUCTURING rule exactly", () => {
  test("the band is [threshold * (100 - band%) / 100, threshold)", () => {
    expect(structuringBand({ threshold: "10000", band_percent: 10 })).toMatchObject({
      lower: moneyFromDecimal("9000"),
      upper: moneyFromDecimal("10000"),
      minCount: 2,
    });
  });

  test("only effective STRUCTURING rules contribute a band", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const bands = structuringBands([
      rule(),
      rule({ id: "inactive", active: false }),
      rule({ id: "future", effectiveFrom: new Date("2027-01-01T00:00:00.000Z") }),
      rule({ id: "cumulative", ruleType: "CUMULATIVE_WINDOW", params: { max_amount: "50000" } }),
      rule({ id: "no-threshold", params: {} }),
    ], now);
    expect(bands).toEqual([{ lower: moneyFromDecimal("9000"), upper: moneyFromDecimal("10000") }]);
  });

  test("the rule still fires on the in-band amounts the query returns", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const context = {
      subjectType: "PAYMENT_ATTEMPT" as const,
      subjectId: "link-1",
      merchantId: "merchant-1",
      amount: moneyFromDecimal("9500"),
      currency: "LYD",
      railCode: null,
      riskTier: "STANDARD" as const,
      settlementTarget: "PLATFORM_CLEARING" as never,
      counterpartyCountry: null,
      windowStats: { count: 40, totalAmount: moneyFromDecimal("120000"), amounts: [moneyFromDecimal("9100"), moneyFromDecimal("9800")] },
      expectedMonthlyVolume: null,
      openCaseCount: 0,
      velocityFlagged: false,
      screeningResult: null,
      screeningListType: null,
      now,
    };
    expect(evaluateAmlRules([rule()], context).hits.map((hit) => hit.ruleCode)).toEqual(["STRUCT"]);
  });
});
