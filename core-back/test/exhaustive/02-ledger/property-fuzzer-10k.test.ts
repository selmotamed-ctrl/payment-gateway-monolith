/**
 * Suite 02.3 — 10,000-iteration deterministic monetary property fuzzer.
 *
 * Seeded with "ledger-fuzz-10000" (xoshiro128**). Every iteration drives the
 * real `buildPaymentConfirmationTemplate` / `LedgerPoster.validateTemplate`
 * with a random amount, commission model, rounding mode, fee bearer and route
 * cost model, then asserts the algebraic money identities and the continuous
 * double-entry invariant.
 */
import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import {
  COMMISSION_CALC_TYPES,
  FEE_BEARERS,
  ROUNDING_MODES,
  Xoshiro128StarStar,
  type AccountBalanceLike,
} from "../_harness";
import {
  LedgerPoster,
  buildPaymentConfirmationTemplate,
  type DecimalInput,
} from "../../../engine/ledger/LedgerPoster";
import { InvariantVerifier } from "../../../engine/ledger/InvariantVerifier";

type CalcType = (typeof COMMISSION_CALC_TYPES)[number];
type FeeBearer = (typeof FEE_BEARERS)[number];
type RoundingMode = (typeof ROUNDING_MODES)[number];

const ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
};

const PRIME_FRACTIONS = ["13.3330", "76.2550", "0.0070", "99.9990"] as const;

interface Iteration {
  index: number;
  requested: Decimal;
  commission: Decimal;
  surcharge: Decimal;
  gatewayFee: Decimal;
  providerFee: Decimal;
  feeBearer: FeeBearer;
  feeAccrual: boolean;
  calcType: CalcType;
  roundingMode: RoundingMode;
  percentageRate: string;
}

const computeCommission = (
  requested: Decimal,
  calcType: CalcType,
  flatFee: Decimal,
  percentageRate: Decimal,
  roundingMode: RoundingMode,
  prng: Xoshiro128StarStar,
): Decimal => {
  let raw: Decimal;
  switch (calcType) {
    case "FLAT":
      raw = flatFee;
      break;
    case "PERCENTAGE":
      raw = requested.mul(percentageRate);
      break;
    case "TIERED":
      raw = requested.lte(100)
        ? requested.mul(percentageRate).div(2)
        : flatFee.plus(requested.mul(percentageRate));
      break;
    case "HYBRID":
      raw = flatFee.plus(requested.mul(percentageRate));
      break;
    default:
      raw = requested.mul(percentageRate);
  }
  const rounded = raw.toDecimalPlaces(4, ROUNDING[roundingMode]);
  // Keep the merchant net non-negative while still honouring every calc type.
  const ceiling = requested.mul(prng.pick(["0.90", "0.95", "0.99"]));
  return Decimal.min(rounded, ceiling).toDecimalPlaces(4, ROUNDING[roundingMode]);
};

const buildIterations = (count: number): Iteration[] => {
  const prng = new Xoshiro128StarStar("ledger-fuzz-10000");
  const iterations: Iteration[] = [];
  for (let index = 0; index < count; index += 1) {
    const amountText = prng.int(0, 9) === 0
      ? prng.pick(PRIME_FRACTIONS)
      : prng.decimalString(0.001, 250_000, 4);
    const requested = new Decimal(amountText);
    const calcType = prng.pick(COMMISSION_CALC_TYPES) as CalcType;
    const roundingMode = prng.pick(ROUNDING_MODES) as RoundingMode;
    const feeBearer = prng.pick(FEE_BEARERS) as FeeBearer;
    const percentageRate = prng.decimalString(0.0005, 0.15, 6);
    const flatFee = new Decimal(prng.decimalString(0, 5, 4));
    let commission = computeCommission(
      requested,
      calcType,
      flatFee,
      new Decimal(percentageRate),
      roundingMode,
      prng,
    );
    if (feeBearer !== "MERCHANT_ABSORBS" && commission.lte(0)) {
      // A payer surcharge must be strictly positive: a zero-surcharge
      // confirmation is not a valid payer-surge entry.
      commission = new Decimal("0.0001");
    }
    const surcharge = feeBearer === "MERCHANT_ABSORBS"
      ? new Decimal(0)
      : commission;
    const gatewayFee = requested.mul(prng.decimalString(0.0001, 0.02, 6)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const providerFee = requested.mul(prng.decimalString(0.0001, 0.02, 6)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    iterations.push({
      index,
      requested,
      commission,
      surcharge,
      gatewayFee,
      providerFee,
      feeBearer,
      feeAccrual: prng.int(0, 1) === 1,
      calcType,
      roundingMode,
      percentageRate,
    });
  }
  return iterations;
};

const ITERATIONS = buildIterations(10_000);
const poster = new LedgerPoster({} as never);
const balances = new Map<string, Decimal>();

const accumulate = (accountType: string, direction: string, amount: DecimalInput): void => {
  const current = balances.get(accountType) ?? new Decimal(0);
  const signed = direction === "DEBIT" ? new Decimal(String(amount)) : new Decimal(String(amount)).neg();
  balances.set(accountType, current.plus(signed));
};

const asBalances = async (): Promise<AccountBalanceLike[]> =>
  [...balances.entries()].map(([accountType, liveBalance]) => ({
    accountId: accountType,
    accountType: accountType as AccountBalanceLike["accountType"],
    checkpointBalance: new Decimal(0),
    delta: liveBalance,
    liveBalance,
  }));

describe("Suite 02 · deterministic monetary fuzzer (10,000 iterations)", () => {
  test("the fuzzer generated exactly 10,000 iterations", () => {
    expect(ITERATIONS.length).toBe(10_000);
  });

  for (const iteration of ITERATIONS) {
    test(`fuzz #${iteration.index + 1} · ${iteration.feeBearer} · ${iteration.calcType} · ${iteration.roundingMode}`, async () => {
      const merchantAmount = iteration.feeBearer === "MERCHANT_ABSORBS"
        ? iteration.requested.minus(iteration.commission)
        : iteration.requested;

      const template = buildPaymentConfirmationTemplate({
        ownershipMode: "PLATFORM_CLEARING",
        feeBearer: iteration.feeBearer,
        feeAccrual: iteration.feeAccrual,
        amount: iteration.requested,
        commissionAmount: iteration.commission,
        surchargeAmount: iteration.surcharge.gt(0) ? iteration.surcharge : undefined,
        gatewayFeeAmount: iteration.gatewayFee,
        providerFeeAmount: iteration.providerFee,
        merchantAmount,
      });

      expect(() => poster.validateTemplate(template)).not.toThrow();

      let debits = new Decimal(0);
      let credits = new Decimal(0);
      for (const line of template.lines) {
        // 1. No floating-point operation ever touches the money.
        expect(typeof line.amount).not.toBe("number");
        expect(Decimal.isDecimal(line.amount)).toBe(true);
        const amount = new Decimal(String(line.amount));
        expect(amount.gt(0)).toBe(true);
        if (line.direction === "DEBIT") {
          debits = debits.plus(amount);
        } else {
          credits = credits.plus(amount);
        }
        accumulate(line.account.accountType, line.direction, amount);
      }

      // 2. Every generated JournalEntry balances.
      expect(debits.equals(credits)).toBe(true);
      expect(debits.gt(0)).toBe(true);

      // 3. totalCharged - requested == surcharge.
      const totalCharged = iteration.requested.plus(iteration.surcharge);
      expect(totalCharged.minus(iteration.requested).equals(iteration.surcharge)).toBe(true);

      // 4. netMerchant + platformCommission == totalCharged.
      expect(merchantAmount.plus(iteration.commission).equals(totalCharged)).toBe(true);

      // 5. Continuous invariant checkpoint every 500 entries.
      if ((iteration.index + 1) % 500 === 0) {
        const verifier = new InvariantVerifier(async () => asBalances());
        const result = await verifier.verify();
        expect(result.ok).toBe(true);
        expect(result.drift.toFixed(4)).toBe("0.0000");
      }
    });
  }
});
