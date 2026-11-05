import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { checkoutInternals } from "../../api/internal/checkout";
import { buildLedgerTemplate, LedgerPoster, decimal } from "../../engine/ledger/LedgerPoster";

/**
 * H7: the commission is rounded ONCE (per the profile rounding mode, default
 * half-up at 4 decimals); every other figure is derived by exact subtraction,
 * so the journal always balances.
 */
const profile = (over: Record<string, unknown>) => ({
  calcType: "FLAT", flatFee: decimal(0), percentageRate: decimal(0), minFee: decimal(0), maxFee: null, tiersJson: null, ...over,
}) as never;
const link = (amount: string, feeBearer = "MERCHANT_ABSORBS", splitRatioJson: unknown = null) =>
  ({ amount, feeBearer, splitRatioJson }) as never;
const validate = (template: unknown) =>
  (LedgerPoster.prototype as unknown as { validateTemplate: (t: unknown) => void }).validateTemplate.call({}, template);

const run = (amount: string, p: never, feeBearer = "MERCHANT_ABSORBS", splitRatioJson: unknown = null) => {
  const b = checkoutInternals.buildBreakdown(link(amount, feeBearer, splitRatioJson), p);
  const template = buildLedgerTemplate("PLATFORM_HELD_CONFIRMATION", {
    amount, commissionAmount: b.commission, merchantAmount: b.merchantCredited, providerFeeAmount: 0,
  } as never);
  return { b, template };
};

describe("H7 rounding (real buildBreakdown + real ledger validateTemplate)", () => {
  test("flat fee 0.12345 on 1.0000: credited + commission == amount", () => {
    const { b } = run("1.0000", profile({ flatFee: decimal("0.12345") }));
    expect(decimal(b.merchantCredited).plus(decimal(b.commission)).toFixed(4)).toBe("1.0000");
    expect(b.commission).toBe("0.1235");
  });

  test("2.5% on 10.0500: credited + commission == amount", () => {
    const { b } = run("10.0500", profile({ calcType: "PERCENTAGE", percentageRate: decimal("0.025") }));
    expect(decimal(b.merchantCredited).plus(decimal(b.commission)).toFixed(4)).toBe("10.0500");
  });

  test("ledger template built from those numbers validates (balanced)", () => {
    expect(() => validate(run("1.0000", profile({ flatFee: decimal("0.12345") })).template)).not.toThrow();
    expect(() => validate(run("10.0500", profile({ calcType: "PERCENTAGE", percentageRate: decimal("0.025") })).template)).not.toThrow();
  });

  test("the profile roundingMode is honoured", () => {
    const base = { calcType: "FLAT", flatFee: decimal("0.12345") };
    expect(run("1.0000", profile({ ...base, roundingMode: "HALF_UP" })).b.commission).toBe("0.1235");
    expect(run("1.0000", profile({ ...base, roundingMode: "DOWN" })).b.commission).toBe("0.1234");
    expect(run("1.0000", profile({ ...base, roundingMode: "FLOOR" })).b.commission).toBe("0.1234");
    expect(run("1.0000", profile({ ...base, roundingMode: "UP" })).b.commission).toBe("0.1235");
    expect(run("1.0000", profile({ ...base, roundingMode: "HALF_EVEN" })).b.commission).toBe("0.1234");
    expect(run("1.0000", profile({ ...base, roundingMode: "HALF_DOWN" })).b.commission).toBe("0.1234");
    // unknown / missing => default half-up
    expect(run("1.0000", profile({ ...base, roundingMode: "NONSENSE" })).b.commission).toBe("0.1235");
    expect(run("1.0000", profile(base)).b.commission).toBe("0.1235");
  });

  test("property: figures always reconcile exactly for every bearer, rounding mode, rate and amount", () => {
    const amounts = ["0.0100", "0.3333", "1.0000", "7.7777", "10.0500", "99.9999", "123.4567", "1000.0000", "54321.0987"];
    const rates = ["0", "0.001", "0.0125", "0.025", "0.0333", "0.0299", "0.1"];
    const flats = ["0", "0.12345", "0.0001", "0.5", "1.23456"];
    const modes = ["HALF_UP", "HALF_EVEN", "HALF_DOWN", "UP", "DOWN", "CEILING", "FLOOR"];
    const bearers = ["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"];
    const calcTypes = ["FLAT", "PERCENTAGE", "HYBRID"];
    let checked = 0;
    for (const amount of amounts) for (const rate of rates) for (const flat of flats) for (const roundingMode of modes)
      for (const bearer of bearers) for (const calcType of calcTypes) {
        const p = profile({ calcType, flatFee: decimal(flat), percentageRate: decimal(rate), roundingMode });
        const b = checkoutInternals.buildBreakdown(link(amount, bearer, { platformShare: "0.3333" }), p);
        const commission = new Decimal(b.commission);
        const surcharge = new Decimal(b.payerSurcharge);
        const total = new Decimal(b.totalCharged);
        const net = new Decimal(b.merchantCredited);
        const requested = new Decimal(amount);
        // What the payer pays, less the surcharge, is the requested amount.
        expect(total.minus(surcharge).eq(requested)).toBe(true);
        // The merchant net plus the commission the platform keeps, less what the payer added on top, is the requested amount.
        expect(net.plus(commission).minus(surcharge).eq(requested)).toBe(true);
        expect(commission.decimalPlaces()).toBeLessThanOrEqual(4);
        expect(net.decimalPlaces()).toBeLessThanOrEqual(4);
        if (bearer === "MERCHANT_ABSORBS" && net.gte(0)) {
          validate(run(amount, p, bearer).template);
        }
        checked += 1;
      }
    expect(checked).toBeGreaterThan(10000);
  });
});
