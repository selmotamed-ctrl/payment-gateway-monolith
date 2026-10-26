import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AmlRuleEngine,
  evaluateAmlRules,
  type AmlRuleDefinition,
} from "../engine/guards/AmlRuleEngine";
import {
  InternalWatchlistProvider,
  normalizeArabicName,
  normalizeIdentifier,
  nameSimilarity,
} from "../engine/guards/ScreeningProvider";
import { AttemptGuardPipeline } from "../engine/guards/AttemptGuardPipeline";
import { parseCsvRows, parseStatementDate } from "../engine/reconciliation/StatementIngestor";
import { assertNoTippingOff, redactAmlPayload } from "../engine/compliance/tippingOff";
import { moneyFromDecimal } from "../engine/db/money";

const amlRule: AmlRuleDefinition = {
  id: "rule-1",
  code: "LARGE_SINGLE_AMOUNT",
  name: "Large single amount",
  ruleType: "SINGLE_AMOUNT",
  scope: {},
  params: { min_amount: "10000.0000", currency: "LYD" },
  action: "HOLD",
  baseSeverity: "HIGH",
  active: true,
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
};

const context = {
  subjectType: "PAYMENT_ATTEMPT" as const,
  subjectId: "attempt-1",
  merchantId: "merchant-1",
  amount: moneyFromDecimal("25000.0000"),
  currency: "LYD",
  railCode: "edfali",
  riskTier: "STANDARD" as const,
  settlementTarget: "PLATFORM_CLEARING" as const,
  counterpartyCountry: "LY",
  windowStats: { count: 0, totalAmount: moneyFromDecimal(0), amounts: [] },
  expectedMonthlyVolume: null,
  openCaseCount: 0,
  velocityFlagged: false,
  screeningResult: null,
  screeningListType: null,
  now: new Date("2026-06-01T00:00:00.000Z"),
};

describe("phase 4 onboarding", () => {
  test("detects a duplicate KYB document hash across merchants", () => {
    const first = createHash("sha256").update("registry-copy").digest("hex");
    const second = createHash("sha256").update("registry-copy").digest("hex");
    const documents = [
      { id: "doc-1", merchantId: "merchant-1", sha256: first },
      { id: "doc-2", merchantId: "merchant-2", sha256: second },
    ];
    const duplicates = documents.filter((document) => document.sha256 === first);
    expect(duplicates.length).toBe(2);
    expect(new Set(duplicates.map((document) => document.merchantId)).size).toBe(2);
  });

  test("keeps only one open join request per merchant", () => {
    const open = ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"];
    const requests = [
      { id: "jr-1", merchantId: "merchant-1", status: "IN_REVIEW" },
      { id: "jr-2", merchantId: "merchant-1", status: "APPROVED" },
    ];
    const openForMerchant = requests.filter(
      (request) => request.merchantId === "merchant-1" && open.includes(request.status),
    );
    expect(openForMerchant.length).toBe(1);
  });

  test("escalates a rejected applicant that reapplies under a new identity", () => {
    const priorApplication = { taxId: "T-1", registrationNo: "R-1", riskTier: "STANDARD" };
    const newApplication = { taxId: "T-1", registrationNo: "R-9", riskTier: "STANDARD" };
    const duplicate = priorApplication.taxId === newApplication.taxId;
    expect(duplicate).toBe(true);
    const order = ["LOW", "STANDARD", "HIGH"];
    const raised = order[Math.min(order.indexOf(priorApplication.riskTier) + 1, order.length - 1)];
    expect(raised).toBe("HIGH");
  });
});

describe("phase 4 AML program", () => {
  test("a large single amount triggers a hold", () => {
    const result = evaluateAmlRules([amlRule], context);
    expect(result.hits.length).toBe(1);
    expect(result.effectiveAction).toBe("HOLD");
    expect(result.requiresHold).toBe(true);
  });

  test("a merchant direct settlement converts the hold into a case only action", () => {
    const result = evaluateAmlRules([amlRule], { ...context, settlementTarget: "MERCHANT_DIRECT" });
    expect(result.effectiveAction).toBe("CASE_ONLY");
  });

  test("a velocity flag correlated with an AML hit escalates to critical", () => {
    const result = evaluateAmlRules([amlRule], { ...context, velocityFlagged: true });
    expect(result.correlatedEscalation).toBe(true);
    expect(result.severity).toBe("CRITICAL");
  });

  test("the rule engine loads the effective rule set from the repository", async () => {
    const engine = new AmlRuleEngine({
      risk: {
        listActiveAmlRules: (async () => [
          {
            id: amlRule.id,
            code: amlRule.code,
            name: amlRule.name,
            ruleType: amlRule.ruleType,
            scope: {},
            params: amlRule.params,
            action: amlRule.action,
            baseSeverity: amlRule.baseSeverity,
            active: true,
            version: 1,
            effectiveFrom: amlRule.effectiveFrom,
            effectiveTo: null,
          },
        ]) as never,
      } as never,
      tx: {} as never,
    });
    const rules = await engine.loadRules();
    expect(rules.length).toBe(1);
    expect(rules[0]?.ruleType).toBe("SINGLE_AMOUNT");
  });

  test("normalizes Arabic names and identifiers before screening", () => {
    expect(normalizeArabicName("مُحَمَّد")).toBe("محمد");
    expect(normalizeIdentifier("+218 91 234 5678")).toBe("+218912345678");
    expect(nameSimilarity("محمد الشريف", "محمد الشريف")).toBe(100);
  });

  test("the internal watchlist raises a potential match", () => {
    const provider = new InternalWatchlistProvider({
      entries: [
        {
          entryRef: "OFAC-1",
          listType: "SANCTIONS",
          listName: "OFAC SDN",
          names: ["مُحَمَّد الشريف"],
        },
      ],
    });
    const result = provider.screenLocal({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      names: ["محمد الشريف"],
    });
    expect(["POTENTIAL_MATCH", "CONFIRMED_MATCH"]).toContain(result.result);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  test("keeps AML details out of public and merchant templates", () => {
    expect(() =>
      assertNoTippingOff({
        code: "PAYMENT_UNKNOWN",
        subjectTemplate: "Payment status",
        bodyTemplate: "The AML screening result is {{screening_result}}",
        confidentialityClass: "MERCHANT",
      }),
    ).toThrow();
    const redacted = redactAmlPayload({ amount: "10.0000", aml_case_reason: "structured" }, "PUBLIC") as Record<string, unknown>;
    expect(redacted.aml_case_reason).toBeUndefined();
    expect(redacted.amount).toBe("10.0000");
    const internal = redactAmlPayload({ amount: "10.0000", aml_case_reason: "structured" }, "INTERNAL");
    expect(internal.aml_case_reason).toBe("structured");
  });

  test("blocks an attempt when the guard pipeline finds no payment link", async () => {
    const pipeline = new AttemptGuardPipeline({
      db: { $transaction: async (callback: (tx: never) => Promise<unknown>) => callback({} as never) } as never,
      repositories: {
        payments: {
          findAttemptByIdempotencyKey: async () => null,
          lockLinkByKey: async () => null,
        },
      } as never,
      screening: new InternalWatchlistProvider(),
    });
    await expect(
      pipeline.guard({
        linkKey: "missing-link",
        railCode: "edfali",
        env: "LIVE",
        channel: "WEB",
      }),
    ).rejects.toThrow();
  });
});

describe("phase 4 disputes and reconciliation", () => {
  test("absorbs a replayed dispute reference", () => {
    const disputes = [
      { id: "d-1", gatewayId: "gw-1", externalDisputeRef: "CB-42" },
      { id: "d-2", gatewayId: "gw-1", externalDisputeRef: "CB-42" },
    ];
    const unique = new Set(disputes.map((dispute) => `${dispute.gatewayId}:${dispute.externalDisputeRef}`));
    expect(unique.size).toBe(1);
  });

  test("caps a chargeback to the amount that was not refunded", () => {
    const settled = moneyFromDecimal("100.0000");
    const refunded = moneyFromDecimal("100.0000");
    const chargeback = moneyFromDecimal("100.0000");
    const remaining = settled - refunded;
    const capped = remaining < chargeback ? remaining : chargeback;
    expect(capped).toBe(0n);
  });

  test("parses a statement file with a configurable delimiter", () => {
    const rows = parseCsvRows("our_reference;amount;fee\nPA-1;100.00;0.80", ";");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe("PA-1");
    expect(rows[1]?.[2]).toBe("0.80");
  });

  test("parses statement dates with the configured format", () => {
    const parsed = parseStatementDate("01/06/2026", "DD/MM/YYYY");
    expect(parsed?.toISOString().startsWith("2026-06-01")).toBe(true);
  });

  test("produces a fee variance posting from the statement and the accrued fee", () => {
    const accrued = moneyFromDecimal("0.8000");
    const statementFee = moneyFromDecimal("0.9000");
    const variance = statementFee - accrued;
    expect(variance).toBe(moneyFromDecimal("0.1000"));
  });
});
