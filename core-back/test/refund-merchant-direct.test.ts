import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { executeAdjustment } from "../engine/governance/GovernanceExecution";
import { buildLedgerTemplate, refundScenarioFor, type LedgerScenarioInput } from "../engine/ledger/LedgerPoster";
import { moneyFromDecimal } from "../engine/db/money";
import { createEngineHarness, createGovernanceFixture } from "./edge-cases/helpers";
import { fakeTable } from "./helpers/governanceFake";

/**
 * A MERCHANT_DIRECT payment settles into the merchant's own gateway account: the platform books
 * only its commission (`Dr COMMISSION_RECEIVABLE / Cr PLATFORM_INCOME`) and the merchant wallet is
 * never credited. A refund that reuses FULL_REFUND would debit the wallet for money it never
 * received and credit treasury with cash the platform never held, while still balancing.
 */

const accountTypeOf = (glAccountId: unknown): string =>
  String(fakeTable("glAccount").find((row) => row.id === glAccountId)?.accountType);

const refundLines = (adjustmentId: string) => {
  const entry = fakeTable("journalEntry").find((row) => row.refType === "ADJUSTMENT" && row.refId === adjustmentId);
  if (!entry) return null;
  return fakeTable("journalLine")
    .filter((line) => line.entryId === entry.id)
    .map((line) => ({
      direction: String(line.direction),
      account: accountTypeOf(line.glAccountId),
      amount: new Decimal(String(line.amount)).toFixed(4),
    }));
};

const seedMerchantDirectRefund = (
  fixture: ReturnType<typeof createGovernanceFixture>,
  options: { adjustmentId: string; amount: number; reverseCommission: boolean },
): void => {
  fakeTable("glAccount").push({
    id: "acc-receivable",
    accountType: "COMMISSION_RECEIVABLE",
    currency: "LYD",
  });
  const attempt = fakeTable("paymentAttempt").find((row) => row.id === "attempt-1")!;
  attempt.settlementTarget = "MERCHANT_DIRECT";
  fixture.client.adjustment.create({
    data: {
      id: options.adjustmentId,
      type: "REFUND",
      targetGlAccountId: "acc-wallet",
      sourceAttemptId: "attempt-1",
      amount: new Decimal(options.amount),
      reverseCommission: options.reverseCommission,
      reason: "customer request",
      state: "PENDING_REVIEW",
    },
  });
};

const merchantDirectEngine = {
  refund: async () => ({ status: "REFUNDED", attempt: { ownershipMode: "MERCHANT_DIRECT" } }),
};

describe("refund of a MERCHANT_DIRECT payment", () => {
  test("only the commission recognition is reversed: no wallet debit and no treasury credit", async () => {
    const fixture = createGovernanceFixture();
    seedMerchantDirectRefund(fixture, { adjustmentId: "refund-direct-1", amount: 100, reverseCommission: true });

    const result = await executeAdjustment(
      { ...fixture.context, engine: merchantDirectEngine },
      fixture.client as never,
      { adjustmentId: "refund-direct-1", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );

    expect(result.status).toBe("EXECUTED");
    expect(result.template).toBe("MERCHANT_DIRECT_REFUND");
    const lines = refundLines("refund-direct-1");
    expect(lines).toEqual([
      { direction: "DEBIT", account: "PLATFORM_INCOME", amount: "3.0000" },
      { direction: "CREDIT", account: "COMMISSION_RECEIVABLE", amount: "3.0000" },
    ]);
    expect(lines?.map((line) => line.account)).not.toContain("MERCHANT_WALLET");
    expect(lines?.map((line) => line.account)).not.toContain("TREASURY");
    const adjustment = fakeTable("adjustment").find((row) => row.id === "refund-direct-1");
    expect(adjustment?.state).toBe("EXECUTED");
    expect(adjustment?.journalEntryId).toBeTruthy();
  });

  test("with no commission to reverse nothing is posted, yet the refund still executes once", async () => {
    const fixture = createGovernanceFixture();
    seedMerchantDirectRefund(fixture, { adjustmentId: "refund-direct-2", amount: 100, reverseCommission: false });

    const result = await executeAdjustment(
      { ...fixture.context, engine: merchantDirectEngine },
      fixture.client as never,
      { adjustmentId: "refund-direct-2", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );

    expect(result.status).toBe("EXECUTED");
    expect(result.template).toBe("MERCHANT_DIRECT_REFUND");
    expect(refundLines("refund-direct-2")).toBeNull();
    const adjustment = fakeTable("adjustment").find((row) => row.id === "refund-direct-2");
    expect(adjustment?.state).toBe("EXECUTED");
    expect(adjustment?.journalEntryId ?? null).toBeNull();

    const again = await executeAdjustment(
      { ...fixture.context, engine: merchantDirectEngine },
      fixture.client as never,
      { adjustmentId: "refund-direct-2", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );
    expect(again.status).toBe("SKIPPED");
  });

  test("a partial refund reverses at most the commission and never exceeds the refunded amount", async () => {
    const fixture = createGovernanceFixture();
    seedMerchantDirectRefund(fixture, { adjustmentId: "refund-direct-3", amount: 2, reverseCommission: true });

    await executeAdjustment(
      { ...fixture.context, engine: merchantDirectEngine },
      fixture.client as never,
      { adjustmentId: "refund-direct-3", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );

    expect(refundLines("refund-direct-3")).toEqual([
      { direction: "DEBIT", account: "PLATFORM_INCOME", amount: "2.0000" },
      { direction: "CREDIT", account: "COMMISSION_RECEIVABLE", amount: "2.0000" },
    ]);
  });

  test("a platform-cleared refund is unchanged: wallet and income debited, treasury credited", async () => {
    const fixture = createGovernanceFixture();
    fixture.client.adjustment.create({
      data: {
        id: "refund-cleared-1",
        type: "REFUND",
        targetGlAccountId: "acc-wallet",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(100),
        reverseCommission: true,
        reason: "customer request",
        state: "PENDING_REVIEW",
      },
    });
    const engine = { refund: async () => ({ status: "REFUNDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } }) };

    const result = await executeAdjustment(
      { ...fixture.context, engine },
      fixture.client as never,
      { adjustmentId: "refund-cleared-1", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );

    expect(result.template).toBe("FULL_REFUND");
    expect(refundLines("refund-cleared-1")).toEqual([
      { direction: "DEBIT", account: "MERCHANT_WALLET", amount: "97.0000" },
      { direction: "DEBIT", account: "PLATFORM_INCOME", amount: "3.0000" },
      { direction: "CREDIT", account: "TREASURY", amount: "100.0000" },
    ]);
  });
});

describe("merchant-direct refund ledger template", () => {
  test("refundScenarioFor routes each ownership mode to its own template", () => {
    expect(refundScenarioFor("INTERNAL")).toMatchObject({ scenario: "INTERNAL_REFUND", label: "INTERNAL_REFUND" });
    expect(refundScenarioFor("MERCHANT_DIRECT")).toMatchObject({
      scenario: "MERCHANT_DIRECT_CONFIRMATION",
      stage: "REFUND",
      label: "MERCHANT_DIRECT_REFUND",
    });
    for (const mode of ["PLATFORM_CLEARING", null, undefined] as const) {
      expect(refundScenarioFor(mode)).toMatchObject({ scenario: "FULL_REFUND", label: "FULL_REFUND" });
    }
  });

  test("the REFUND stage balances, reverses only commission and is empty for a zero commission", () => {
    const template = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", {
      amount: "100.0000",
      commissionAmount: "3.0000",
      stage: "REFUND",
    });
    expect(template.refType).toBe("ADJUSTMENT");
    expect(template.lines.map((line) => [line.direction, line.account.accountType])).toEqual([
      ["DEBIT", "PLATFORM_INCOME"],
      ["CREDIT", "COMMISSION_RECEIVABLE"],
    ]);
    const empty = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", {
      amount: "100.0000",
      commissionAmount: "0",
      stage: "REFUND",
    });
    expect(empty.lines).toHaveLength(0);
  });
});

describe("commission receivable balance after a merchant-direct refund", () => {
  test("a refund's commission reversal reduces the merchant's receivable", async () => {
    const fixture = createGovernanceFixture();
    seedMerchantDirectRefund(fixture, { adjustmentId: "refund-direct-4", amount: 100, reverseCommission: true });
    // The confirmation recognised the 3.0000 commission against the attempt.
    fakeTable("journalEntry").push({ id: "entry-confirm", refType: "PAYMENT_ATTEMPT", refId: "attempt-1" });
    fakeTable("journalLine").push(
      { id: "line-confirm-dr", entryId: "entry-confirm", glAccountId: "acc-receivable", direction: "DEBIT", amount: new Decimal(3) },
      { id: "line-confirm-cr", entryId: "entry-confirm", glAccountId: "acc-income", direction: "CREDIT", amount: new Decimal(3) },
    );
    const balance = fixture.repositories.merchants.getCommissionReceivableBalance!;
    expect(await balance(fixture.client as never, "merchant-1")).toBe(moneyFromDecimal("3.0000"));

    await executeAdjustment(
      { ...fixture.context, engine: merchantDirectEngine },
      fixture.client as never,
      { adjustmentId: "refund-direct-4", checkerUserId: "user-finance", checkerRole: "FINANCE" },
    );

    expect(await balance(fixture.client as never, "merchant-1")).toBe(0n);
  });
});

describe("DynamicRailEngine.refund picks the template from the ownership mode", () => {
  const refundStep = [{ id: "refund-step", type: "HTTP", side_effect: "MOVES_MONEY" }] as never;
  const run = async (ownershipMode: "MERCHANT_DIRECT" | "PLATFORM_CLEARING" | "INTERNAL", amount: string) => {
    const calls: Array<{ scenario: string; refId: string; input: LedgerScenarioInput }> = [];
    const harness = createEngineHarness({
      attempt: { status: "SUCCEEDED", settledAmount: "100.0000", ownershipMode },
      steps: { REFUND: refundStep },
      ledgerScenarioCalls: calls,
    });
    const result = await harness.engine.refund(harness.attempt, amount, "adj-engine");
    return { result, calls };
  };

  test("a MERCHANT_DIRECT refund posts the commission-reversal stage, not FULL_REFUND", async () => {
    const { result, calls } = await run("MERCHANT_DIRECT", "100.0000");
    expect(result.status).toBe("REFUNDED");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scenario).toBe("MERCHANT_DIRECT_CONFIRMATION");
    expect(calls[0]?.input.stage).toBe("REFUND");
  });

  test("a partial MERCHANT_DIRECT refund reverses the proportional commission", async () => {
    const { calls } = await run("MERCHANT_DIRECT", "50.0000");
    expect(calls[0]?.scenario).toBe("MERCHANT_DIRECT_CONFIRMATION");
    expect(String(calls[0]?.input.commissionAmount)).toBe("1.5");
  });

  test("platform-cleared and internal refunds keep their templates", async () => {
    expect((await run("PLATFORM_CLEARING", "100.0000")).calls[0]?.scenario).toBe("FULL_REFUND");
    expect((await run("INTERNAL", "100.0000")).calls[0]?.scenario).toBe("INTERNAL_REFUND");
  });
});
