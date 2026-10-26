import { ApiError } from "../../lib/error";

export type Money = bigint;

export const MONEY_DECIMALS = 4;
export const MONEY_SCALE = 10n ** BigInt(MONEY_DECIMALS);

const MONEY_PATTERN = /^-?\d{1,18}(?:\.\d{1,18})?$/;
const RATE_DECIMALS = 6;

export const ZERO_MONEY: Money = 0n;

const invalidAmount = (raw: unknown): ApiError =>
  new ApiError(400, "INVALID_AMOUNT", `Invalid monetary amount: ${String(raw)}`, { value: String(raw) });

export function moneyFromString(input: string): Money {
  const trimmed = input.trim();
  if (!MONEY_PATTERN.test(trimmed)) {
    throw invalidAmount(input);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split(".");
  const intPart = parts[0] ?? "0";
  const fracPart = parts[1] ?? "";
  const padded = (fracPart + "0000").slice(0, MONEY_DECIMALS);
  const rest = fracPart.slice(MONEY_DECIMALS);
  let scaled = BigInt(intPart) * MONEY_SCALE + BigInt(padded);
  if (rest.length > 0 && Number(rest[0]) >= 5) {
    scaled += 1n;
  }
  return negative ? -scaled : scaled;
}

export function moneyFromDecimal(value: unknown): Money {
  if (value === null || value === undefined) {
    throw invalidAmount(value);
  }
  if (typeof value === "bigint") {
    return value * MONEY_SCALE;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidAmount(value);
    }
    return moneyFromString(value.toFixed(MONEY_DECIMALS));
  }
  if (typeof value === "string") {
    return moneyFromString(value);
  }
  const asString = (value as { toString(): string }).toString();
  return moneyFromString(asString);
}

export function moneyToString(value: Money): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const intPart = absolute / MONEY_SCALE;
  const fracPart = (absolute % MONEY_SCALE).toString().padStart(MONEY_DECIMALS, "0");
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

export function moneyToNumber(value: Money): number {
  return Number(moneyToString(value));
}

export function addMoney(a: Money, b: Money): Money {
  return a + b;
}

export function subtractMoney(a: Money, b: Money): Money {
  return a - b;
}

export function negateMoney(a: Money): Money {
  return -a;
}

export function absoluteMoney(a: Money): Money {
  return a < 0n ? -a : a;
}

export function compareMoney(a: Money, b: Money): number {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function isZeroMoney(a: Money): boolean {
  return a === 0n;
}

export function moneyMin(a: Money, b: Money): Money {
  return a <= b ? a : b;
}

export function moneyMax(a: Money, b: Money): Money {
  return a >= b ? a : b;
}

export function roundHalfUp(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) {
    throw new ApiError(500, "INVALID_DIVISOR", "Divisor must be positive");
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const rounded = (absolute + divisor / 2n) / divisor;
  return negative ? -rounded : rounded;
}

export function multiplyMoneyByRate(amount: Money, rate: Money, rateDecimals: number = RATE_DECIMALS): Money {
  const divisor = 10n ** BigInt(rateDecimals);
  return roundHalfUp(amount * rate, divisor);
}

export function rateToMoney(rateValue: unknown): Money {
  return moneyFromDecimal(rateValue);
}

export function moneyJson(value: Money): string {
  return moneyToString(value);
}

export function sumMoney(values: readonly Money[]): Money {
  return values.reduce((acc, current) => acc + current, 0n);
}
