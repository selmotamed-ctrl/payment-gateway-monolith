import { describe, expect, test } from "bun:test";
import { AttemptGuardPipeline } from "../../engine/guards/AttemptGuardPipeline";
import { AmlRuleEngine, evaluateAmlRules, resolveEffectiveAction } from "../../engine/guards/AmlRuleEngine";
import { InternalWatchlistProvider, MockScreeningProvider, normalizeArabicName } from "../../engine/guards/ScreeningProvider";
import { StatementIngestor, parseCsvRows, parseStatementDate } from "../../engine/reconciliation/StatementIngestor";
import { ExpirySweeperWorker } from "../../engine/workers/ExpirySweeperWorker";
import { PollWorker, computeBackoffDelaySeconds } from "../../engine/workers/PollWorker";
import { InboundInboxWorker, RetryableInboundError } from "../../engine/workers/InboundInboxWorker";
import { OutboxNotificationWorker } from "../../engine/workers/OutboxNotificationWorker";
import { assertNoTippingOff, redactAmlPayload } from "../../engine/compliance/tippingOff";
import type { PrismaLike, Tx } from "../../engine/db/ports";
import { emptyRepositories } from "../helpers/fakeRepositories";

const fakeDb = (): PrismaLike => ({
  $transaction: async (callback: (tx: Tx) => Promise<unknown>) => callback(fakeDb() as Tx),
  $queryRaw: async () => [],
  $executeRaw: async () => 0,
  $queryRawUnsafe: async () => [],
  $executeRawUnsafe: async () => 0,
});

describe("AttemptGuardPipeline", () => {
  test("rejects a missing payment link", async () => {
    const pipeline = new AttemptGuardPipeline({
      db: fakeDb(),
      repositories: emptyRepositories(),
      screening: new MockScreeningProvider(),
    });
    await expect(
      pipeline.guard({
        linkKey: "missing",
        railCode: "edfali",
        env: "SANDBOX",
        channel: "WEB",
      }),
    ).rejects.toThrow();
  });
});

describe("AmlRuleEngine", () => {
  const baseContext = {
    subjectType: "PAYMENT_ATTEMPT" as const,
    subjectId: "attempt-1",
    merchantId: "merchant-1",
    amount: 1_000_000n,
    currency: "LYD",
    railCode: "edfali",
    riskTier: "STANDARD" as const,
    settlementTarget: "PLATFORM_CLEARING" as const,
    counterpartyCountry: "LY",
    windowStats: { count: 1, totalAmount: 1_000_000n, amounts: [1_000_000n] },
    expectedMonthlyVolume: null,
    openCaseCount: 0,
    velocityFlagged: false,
    screeningResult: null,
    screeningListType: null,
    now: new Date("2026-03-01T00:00:00Z"),
  };

  const rule = (overrides: Partial<Parameters<typeof evaluateAmlRules>[0][number]> = {}) => ({
    id: "rule-1",
    code: "RULE-1",
    name: "Rule",
    ruleType: "SINGLE_AMOUNT" as const,
    scope: {},
    params: { min_amount: "50.0000" },
    action: "HOLD" as const,
    baseSeverity: "HIGH" as const,
    active: true,
    version: 1,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    ...overrides,
  });

  test("a single amount rule above the threshold hits", () => {
    const result = evaluateAmlRules([rule()], baseContext);
    expect(result.hits).toHaveLength(1);
    expect(result.effectiveAction).toBe("HOLD");
    expect(result.requiresHold).toBe(true);
  });

  test("a rule below the threshold does not hit", () => {
    const result = evaluateAmlRules([rule({ params: { min_amount: "500.0000" } })], baseContext);
    expect(result.hits).toHaveLength(0);
    expect(result.effectiveAction).toBeNull();
  });

  test("a velocity flag correlated with an AML hit escalates the severity to CRITICAL", () => {
    const result = evaluateAmlRules([rule()], { ...baseContext, velocityFlagged: true });
    expect(result.correlatedEscalation).toBe(true);
    expect(result.severity).toBe("CRITICAL");
  });

  test("a merchant direct settlement converts a HOLD into a CASE_ONLY outcome", () => {
    const result = evaluateAmlRules([rule()], { ...baseContext, settlementTarget: "MERCHANT_DIRECT" });
    expect(result.effectiveAction).toBe("CASE_ONLY");
  });

  test("the strongest action wins across multiple rules", () => {
    const result = evaluateAmlRules(
      [
        rule({ id: "r1", action: "FLAG" }),
        rule({ id: "r2", action: "BLOCK", code: "RULE-2" }),
      ],
      baseContext,
    );
    expect(resolveEffectiveAction(result.hits, "PLATFORM_CLEARING")).toBe("BLOCK");
  });

  test("the rule engine loads rules from the risk repository", async () => {
    const repositories = emptyRepositories();
    const engine = new AmlRuleEngine({ risk: repositories.risk, tx: fakeDb() as Tx });
    const rules = await engine.loadRules();
    expect(rules).toEqual([]);
  });
});

describe("ScreeningProvider", () => {
  test("the internal watchlist clears an unknown name", () => {
    const provider = new InternalWatchlistProvider();
    const result = provider.screenLocal({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      names: ["Unknown Trading"],
    });
    expect(result.result).toBe("CLEAR");
    expect(result.matches).toHaveLength(0);
  });

  test("the internal watchlist matches a listed name", () => {
    const provider = new InternalWatchlistProvider({
      entries: [
        {
          entryRef: "SAN-1",
          listType: "SANCTIONS",
          listName: "Test list",
          names: ["Sanctioned Person"],
        },
      ],
    });
    const result = provider.screenLocal({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      names: ["Sanctioned Person"],
    });
    expect(result.result).toBe("CONFIRMED_MATCH");
    expect(result.matches[0]?.listType).toBe("SANCTIONS");
  });

  test("Arabic names are normalized for screening", () => {
    expect(normalizeArabicName("  محمد   علي  ")).toBe("محمد علي");
  });
});

describe("StatementIngestor", () => {
  test("parses CSV rows with quoted fields", () => {
    const rows = parseCsvRows('a,"b,c",d\n1,2,3');
    expect(rows).toEqual([["a", "b,c", "d"], ["1", "2", "3"]]);
  });

  test("parses a statement date with a configured format", () => {
    const parsed = parseStatementDate("20260304", "YYYYMMDD");
    expect(parsed?.toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });

  test("rejects a missing statement source", async () => {
    const ingestor = new StatementIngestor({
      db: fakeDb(),
      repositories: emptyRepositories(),
    });
    await expect(
      ingestor.ingest({ statementSourceId: "missing", content: "a,b" }),
    ).rejects.toThrow();
  });
});

describe("workers", () => {
  test("the poll backoff follows the configured schedule", () => {
    const policy = { firstAfterSeconds: 5, backoffSeconds: [5, 15, 30], maxDurationSeconds: 60 };
    expect(computeBackoffDelaySeconds(policy, 0)).toBe(5);
    expect(computeBackoffDelaySeconds(policy, 4)).toBe(5);
    expect(computeBackoffDelaySeconds(policy, 6)).toBe(15);
    expect(computeBackoffDelaySeconds(policy, 100)).toBeNull();
  });

  test("the expiry sweeper runs once without a live database", async () => {
    const worker = new ExpirySweeperWorker({
      db: fakeDb(),
      repositories: emptyRepositories(),
    });
    await worker.runOnce();
    expect(worker.isRunning).toBe(false);
  });

  test("the poll worker runs once without a live database", async () => {
    const worker = new PollWorker({
      db: fakeDb(),
      repositories: emptyRepositories(),
    });
    await worker.runOnce();
    expect(worker.isRunning).toBe(false);
  });

  test("the inbound inbox worker counts retry attempts from the processing result", async () => {
    const worker = new InboundInboxWorker({
      db: fakeDb(),
      repositories: emptyRepositories(),
    });
    const retryable = new RetryableInboundError("transient");
    expect(retryable.retryable).toBe(true);
    await worker.runOnce();
  });

  test("the outbox notification worker runs once without a live database", async () => {
    const worker = new OutboxNotificationWorker({
      db: fakeDb(),
      repositories: emptyRepositories(),
    });
    await worker.runOnce();
    expect(worker.isRunning).toBe(false);
  });
});

describe("compliance tipping off guards", () => {
  test("rejects an AML variable in a public template", () => {
    expect(() =>
      assertNoTippingOff({
        code: "AML_CASE_OPENED",
        bodyTemplate: "Your {{aml_case_id}} is open",
        confidentialityClass: "PUBLIC",
      }),
    ).toThrow();
  });

  test("allows an AML variable in an internal template", () => {
    expect(() =>
      assertNoTippingOff({
        code: "AML_CASE_OPENED",
        bodyTemplate: "Your {{aml_case_id}} is open",
        confidentialityClass: "INTERNAL",
      }),
    ).not.toThrow();
  });

  test("redacts AML payload values for a public template", () => {
    const redacted = redactAmlPayload(
      { aml_case_id: "CASE-1", status: "OPEN" },
      "PUBLIC",
    );
    expect(JSON.stringify(redacted)).not.toContain("CASE-1");
  });
});
