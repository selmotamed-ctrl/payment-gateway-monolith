import { Decimal } from "decimal.js";
import { decimal, type DecimalInput } from "../../engine/ledger/LedgerPoster";

/**
 * Exact money helpers for the synthetic seeder.
 *
 * Every amount is a `decimal.js` value rendered with four fraction digits
 * (`DECIMAL(18,4)`); JavaScript numbers are never used for money.
 *
 * The three pricing functions mirror the private checkout pricing of
 * `api/internal/checkout.ts` (`commissionForProfile`, `buildBreakdown`,
 * `gatewayFeeForRoute`). They are not exported there and that module imports
 * the HTTP router and the Prisma client, so they are reproduced here line for
 * line; `test/synthetic-seeder-realism.test.ts` pins their behaviour.
 */

export const D = (value: DecimalInput): Decimal => decimal(value);
export const ZERO = new Decimal(0);
export const money = (value: DecimalInput): string => decimal(value).toFixed(4);

export interface CommissionProfileLike {
  calcType: string;
  flatFee: DecimalInput;
  percentageRate: DecimalInput;
  minFee: DecimalInput;
  maxFee: DecimalInput | null;
  tiersJson: unknown;
}

/** Mirror of `commissionForProfile` (api/internal/checkout.ts). */
export const commissionForProfile = (profile: CommissionProfileLike, amount: DecimalInput): Decimal => {
  let value = new Decimal(0);
  if (profile.calcType === "FLAT" || profile.calcType === "HYBRID") {
    value = value.plus(decimal(profile.flatFee));
  }
  if (profile.calcType === "PERCENTAGE" || profile.calcType === "HYBRID") {
    value = value.plus(decimal(amount).mul(decimal(profile.percentageRate)));
  }
  if (profile.calcType === "TIERED") {
    const tiers = Array.isArray(profile.tiersJson) ? (profile.tiersJson as Array<Record<string, unknown>>) : [];
    for (const tier of tiers) {
      const upTo = tier.upTo ?? tier.up_to;
      if (upTo === undefined || decimal(amount).lte(decimal(String(upTo)))) {
        if (tier.flat !== undefined) value = value.plus(decimal(String(tier.flat)));
        if (tier.percent !== undefined) value = value.plus(decimal(amount).mul(decimal(String(tier.percent))));
        break;
      }
    }
  }
  if (value.lt(decimal(profile.minFee))) value = decimal(profile.minFee);
  if (profile.maxFee !== null && profile.maxFee !== undefined && value.gt(decimal(profile.maxFee))) {
    value = decimal(profile.maxFee);
  }
  return value;
};

export interface Breakdown {
  commission: string;
  payerSurcharge: string;
  totalCharged: string;
  merchantCredited: string;
  feeBearer: "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";
}

const splitRatio = (value: unknown): Decimal => {
  const fallback = decimal("0.5");
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const raw = record.platformShare ?? record.platform_share ?? record.share;
  if (raw === undefined || raw === null) return fallback;
  let parsed: Decimal;
  try {
    parsed = decimal(raw as never);
  } catch {
    return fallback;
  }
  if (!parsed.isFinite() || parsed.lt(0) || parsed.gt(1)) return fallback;
  return parsed;
};

/** Mirror of `buildBreakdown` (api/internal/checkout.ts). */
export const buildBreakdown = (
  link: { amount: DecimalInput; feeBearer: string; splitRatioJson?: unknown },
  profile: CommissionProfileLike,
): Breakdown => {
  const amount = decimal(link.amount);
  const commission = commissionForProfile(profile, link.amount);
  const feeBearer = link.feeBearer as Breakdown["feeBearer"];
  if (feeBearer === "MERCHANT_ABSORBS") {
    return {
      commission: commission.toFixed(4),
      payerSurcharge: "0.0000",
      totalCharged: amount.toFixed(4),
      merchantCredited: amount.minus(commission).toFixed(4),
      feeBearer,
    };
  }
  if (feeBearer === "PAYER_SURCHARGE") {
    return {
      commission: commission.toFixed(4),
      payerSurcharge: commission.toFixed(4),
      totalCharged: amount.plus(commission).toFixed(4),
      merchantCredited: amount.toFixed(4),
      feeBearer,
    };
  }
  const platformShare = splitRatio(link.splitRatioJson);
  const payerShare = commission.mul(platformShare);
  return {
    commission: commission.toFixed(4),
    payerSurcharge: payerShare.toFixed(4),
    totalCharged: amount.plus(payerShare).toFixed(4),
    merchantCredited: amount.minus(commission.minus(payerShare)).toFixed(4),
    feeBearer,
  };
};

/** Mirror of `gatewayFeeForRoute` (api/internal/checkout.ts). */
export const gatewayFeeForRoute = (costModel: Record<string, unknown> | null | undefined, amount: DecimalInput): string => {
  const model = costModel as {
    calc_type?: string;
    flat?: DecimalInput;
    percent?: DecimalInput;
    min?: DecimalInput;
    max?: DecimalInput;
    tiers?: Array<{ up_to?: DecimalInput; flat?: DecimalInput; percent?: DecimalInput }>;
  } | null | undefined;
  if (!model) return "0.0000";
  let cost = decimal(0);
  if (model.flat !== undefined) cost = cost.plus(decimal(model.flat));
  if (model.percent !== undefined) cost = cost.plus(decimal(amount).mul(decimal(model.percent)).div(100));
  if (model.calc_type === "TIERED" || model.calc_type === "HYBRID") {
    for (const tier of model.tiers ?? []) {
      if (tier.up_to === undefined || decimal(amount).lte(decimal(tier.up_to))) {
        if (tier.flat !== undefined) cost = cost.plus(decimal(tier.flat));
        if (tier.percent !== undefined) cost = cost.plus(decimal(amount).mul(decimal(tier.percent)).div(100));
        break;
      }
    }
  }
  if (model.min !== undefined) cost = decimal(model.min).gt(cost) ? decimal(model.min) : cost;
  if (model.max !== undefined && cost.gt(decimal(model.max))) cost = decimal(model.max);
  return cost.toFixed(4);
};

/** `rail_routes.cost_model.accrue_fee_at_confirm` (mirror of `feeAccrualOf`, engine/runtime/attemptRepository.ts). */
export const feeAccrualOf = (costModel: Record<string, unknown> | null | undefined): boolean => {
  if (!costModel || typeof costModel !== "object") return false;
  const value = costModel.accrue_fee_at_confirm ?? costModel.accrueFeeAtConfirm;
  return value === true || value === "true" || value === 1;
};

/**
 * The wire amount the gateway receives, mirroring the Fake Rails
 * normalisation (`fake-rails-back/api/rails/common.ts#normalizeAmount`):
 * Moamalat transmits integer dirhams, LyPay/NeomPay three decimals, the rest
 * two decimals. Returns the wire string and the LYD amount the emulator will
 * settle, which is what the engine stores as `settled_amount`.
 */
export const wireAmount = (gatewayCode: string, total: DecimalInput): { wire: string; settled: string } => {
  const value = decimal(total);
  if (gatewayCode === "moamalat") {
    const dirhams = value.mul(1000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return { wire: dirhams.toFixed(0), settled: dirhams.div(1000).toFixed(4) };
  }
  if (gatewayCode === "ly_pay" || gatewayCode === "neompay") {
    const wire = value.toFixed(3);
    return { wire, settled: decimal(wire).toFixed(4) };
  }
  const wire = value.toFixed(2);
  return { wire, settled: decimal(wire).toFixed(4) };
};

/** Picks a realistic price point in [min, max] with a log-uniform shape. */
export const pricePoint = (roll: number, min: number, max: number): string => {
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const raw = Math.exp(logMin + roll * (logMax - logMin));
  // Libyan price points: half-dinar steps below 100 LYD, whole dinars to
  // 1,000 LYD and five-dinar steps above. Only the step choice uses the
  // float; the amount itself is an exact decimal string.
  const step = raw < 100 ? 0.5 : raw < 1000 ? 1 : 5;
  const steps = Math.max(1, Math.round(raw / step));
  return new Decimal(steps).mul(step).toFixed(4);
};
