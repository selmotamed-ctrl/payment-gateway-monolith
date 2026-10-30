/**
 * Suite 02.1 — the 15 journal-entry templates combinatorial matrix.
 *
 * 19 template variants × 3 currencies × 5 amount tiers × 4 fee configurations
 * = 1,140 independent journal constructions, each validated by the real
 * production `LedgerPoster.validateTemplate`.
 */
import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import {
  ALL_CURRENCIES,
} from "../_harness";
import {
  LedgerPoster,
  buildLedgerTemplate,
  type LedgerScenario,
  type LedgerScenarioStage,
} from "../../../engine/ledger/LedgerPoster";

interface TemplateDefinition {
  label: string;
  scenario: LedgerScenario;
  stage?: LedgerScenarioStage;
  /** Payer surcharge / split templates carry the fee on top of the amount. */
  surcharge?: boolean;
  /** Split templates keep the merchant whole and balance through the surcharge. */
  split?: boolean;
}

const TEMPLATES: readonly TemplateDefinition[] = [
  { label: "T1 platform-held same-day confirmation", scenario: "PLATFORM_HELD_CONFIRMATION" },
  { label: "T2 platform-held T+N fee accrual", scenario: "PLATFORM_HELD_FEE_ACCRUAL" },
  { label: "T3 T+N bank statement settlement sweep", scenario: "SETTLEMENT_SWEEP" },
  { label: "T4 settlement fee-variance true-up", scenario: "FEE_VARIANCE_TRUE_UP" },
  { label: "T5 payer-surcharge confirmation", scenario: "PAYER_SURCHARGE_CONFIRMATION", surcharge: true },
  { label: "T5b split surcharge confirmation", scenario: "SPLIT_SURCHARGE_CONFIRMATION", surcharge: true, split: true },
  { label: "T6 merchant-direct commission recognition", scenario: "MERCHANT_DIRECT_CONFIRMATION" },
  { label: "T6b merchant-direct commission netting", scenario: "MERCHANT_DIRECT_CONFIRMATION", stage: "NETTING" },
  { label: "T7 AML hold at confirmation", scenario: "AML_HOLD_AND_RELEASE" },
  { label: "T7b AML checker release", scenario: "AML_HOLD_AND_RELEASE", stage: "RELEASE" },
  { label: "T8 cash-out subtraction", scenario: "CASHOUT" },
  { label: "T9 full refund with commission reversal", scenario: "FULL_REFUND" },
  { label: "T10 chargeback reserve", scenario: "CHARGEBACK_RESERVE_AND_LOST" },
  { label: "T10b chargeback lost", scenario: "CHARGEBACK_RESERVE_AND_LOST", stage: "LOST" },
  { label: "T11 AML void", scenario: "AML_VOID" },
  { label: "T12 chargeback won", scenario: "CHARGEBACK_WON" },
  { label: "T13 NeomPay internal confirmation (INTERNAL-1)", scenario: "INTERNAL_CONFIRMATION" },
  { label: "T14 NeomPay internal refund", scenario: "INTERNAL_REFUND" },
  { label: "T15 chargeback against insufficient wallet", scenario: "CHARGEBACK_INSUFFICIENT" },
  { label: "T15b settlement routed to suspense", scenario: "SUSPENSE_SETTLEMENT" },
];

const AMOUNT_TIERS = ["0.0100", "76.2550", "100.0000", "999.9999", "250000.0000"] as const;

interface FeeConfig {
  label: string;
  commission: (amount: Decimal) => Decimal;
  providerFee: (amount: Decimal) => Decimal;
  gatewayFee: (amount: Decimal) => Decimal;
}

const FEE_CONFIGS: readonly FeeConfig[] = [
  {
    label: "near-zero-fee",
    // A strictly positive token commission keeps the merchant-direct template
    // non-empty; a truly zero commission legitimately produces no journal line.
    commission: (amount) => amount.mul("0.0000001"),
    providerFee: () => new Decimal(0),
    gatewayFee: () => new Decimal(0),
  },
  {
    label: "standard-3pct",
    commission: (amount) => amount.mul("0.03"),
    // Keep the fee strictly below the amount so the treasury / settlement leg
    // remains positive even on the smallest tier.
    providerFee: (amount) => Decimal.min(amount.mul("0.1"), new Decimal("1")),
    gatewayFee: (amount) => Decimal.min(amount.mul("0.1"), new Decimal("0.8")),
  },
  {
    label: "high-10pct",
    commission: (amount) => amount.mul("0.10"),
    providerFee: (amount) => amount.mul("0.01"),
    gatewayFee: (amount) => amount.mul("0.02"),
  },
  {
    label: "fractional-1bp",
    commission: (amount) => amount.mul("0.0001"),
    providerFee: (amount) => amount.mul("0.0001"),
    gatewayFee: (amount) => amount.mul("0.0001"),
  },
];

const poster = new LedgerPoster({} as never);

const buildInput = (
  definition: TemplateDefinition,
  amountText: string,
  config: FeeConfig,
) => {
  const amount = new Decimal(amountText);
  const commission = config.commission(amount);
  const providerFee = config.providerFee(amount);
  const gatewayFee = config.gatewayFee(amount);
  const variance = Decimal.max(new Decimal("0.0001"), amount.mul("0.0001"));
  const input: Record<string, unknown> = {
    amount,
    commissionAmount: commission,
    providerFeeAmount: providerFee,
    gatewayFeeAmount: gatewayFee,
    varianceAmount: variance,
  };
  if (definition.stage) {
    input.stage = definition.stage;
  }
  if (definition.surcharge) {
    input.surchargeAmount = commission;
  }
  if (definition.split) {
    input.merchantAmount = amount;
  }
  return input;
};

describe("Suite 02 · all journal-entry templates", () => {
  test(`the matrix expands to ${TEMPLATES.length * ALL_CURRENCIES.length * AMOUNT_TIERS.length * FEE_CONFIGS.length} entries`, () => {
    expect(TEMPLATES.length).toBe(20);
    expect(TEMPLATES.length * ALL_CURRENCIES.length * AMOUNT_TIERS.length * FEE_CONFIGS.length).toBe(1200);
  });

  for (const definition of TEMPLATES) {
    for (const currency of ALL_CURRENCIES) {
      for (const amount of AMOUNT_TIERS) {
        for (const config of FEE_CONFIGS) {
          test(`${definition.label} · ${currency} · ${amount} · ${config.label}`, () => {
            const input = buildInput(definition, amount, config);
            const template = buildLedgerTemplate(definition.scenario, input as never);
            // The real production validator enforces balance and positivity.
            expect(() => poster.validateTemplate(template)).not.toThrow();

            const debits = template.lines
              .filter((line) => line.direction === "DEBIT")
              .reduce((total, line) => total.plus(new Decimal(String(line.amount))), new Decimal(0));
            const credits = template.lines
              .filter((line) => line.direction === "CREDIT")
              .reduce((total, line) => total.plus(new Decimal(String(line.amount))), new Decimal(0));
            expect(debits.equals(credits)).toBe(true);
            expect(debits.gt(0)).toBe(true);
            for (const line of template.lines) {
              expect(new Decimal(String(line.amount)).gt(0)).toBe(true);
              expect(line.amount).toBeInstanceOf(Decimal);
              expect(typeof line.amount).not.toBe("number");
            }
          });
        }
      }
    }
  }
});

describe("Suite 02 · template account semantics", () => {
  const amount = "100.0000";
  const commission = "3.0000";

  test("T1 deducts the provider fee at source", () => {
    const template = buildLedgerTemplate("PLATFORM_HELD_CONFIRMATION", {
      amount,
      commissionAmount: commission,
      providerFeeAmount: "1.0000",
    });
    const byType = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(String(byType.get("TREASURY")?.amount)).toBe("99");
    expect(String(byType.get("PROVIDER_FEE_EXPENSE")?.amount)).toBe("1");
    expect(String(byType.get("MERCHANT_WALLET")?.amount)).toBe("97");
    expect(String(byType.get("PLATFORM_INCOME")?.amount)).toBe("3");
  });

  test("T6 merchant-direct confirmation books COMMISSION_RECEIVABLE, then nets it", () => {
    const confirm = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", { amount, commissionAmount: commission });
    expect(confirm.lines.map((line) => line.account.accountType)).toEqual([
      "COMMISSION_RECEIVABLE",
      "PLATFORM_INCOME",
    ]);
    const netting = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", {
      amount,
      commissionAmount: commission,
      stage: "NETTING",
    });
    expect(netting.lines.map((line) => line.account.accountType)).toEqual([
      "MERCHANT_WALLET",
      "COMMISSION_RECEIVABLE",
    ]);
  });

  test("T7 recognises commission only at release, never while held", () => {
    const hold = buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount, commissionAmount: commission });
    expect(hold.lines.map((line) => line.account.accountType)).toEqual(["GATEWAY_CLEARING", "AML_HOLD"]);
    const release = buildLedgerTemplate("AML_HOLD_AND_RELEASE", {
      amount,
      commissionAmount: commission,
      stage: "RELEASE",
    });
    expect(release.lines.map((line) => line.account.accountType)).toContain("PLATFORM_INCOME");
  });

  test("T13 posts straight to TREASURY with zero clearing leg", () => {
    const template = buildLedgerTemplate("INTERNAL_CONFIRMATION", { amount, commissionAmount: commission });
    expect(template.lines.map((line) => line.account.accountType)).not.toContain("GATEWAY_CLEARING");
    expect(template.lines[0]?.account.accountType).toBe("TREASURY");
  });

  test("T15 suspense settlement parks the money in SUSPENSE", () => {
    const template = buildLedgerTemplate("SUSPENSE_SETTLEMENT", { amount, ownershipMode: "PLATFORM_CLEARING" });
    expect(template.lines.map((line) => line.account.accountType)).toEqual(["GATEWAY_CLEARING", "SUSPENSE"]);
  });

  test("a malformed template is refused by the production validator", () => {
    expect(() => poster.validateTemplate({
      refType: "PAYMENT_ATTEMPT",
      refId: "unbalanced",
      description: "unbalanced",
      lines: [
        { direction: "DEBIT", amount: "1.0000", account: { accountType: "TREASURY" } },
        { direction: "CREDIT", amount: "0.5000", account: { accountType: "MERCHANT_WALLET" } },
      ],
    })).toThrow();
  });
});
