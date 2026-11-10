import Decimal from "decimal.js";

/** Minor units per major unit for CURRENCY_MINOR values (host default scale; LYD has 3 decimals). */
export const DEFAULT_MINOR_UNIT_SCALE = 1000;
export const DEFAULT_MINOR_UNIT_DECIMALS = 3;
export const DEFAULT_REPORT_CURRENCY = "LYD";

/** Parses a report cell into a Decimal without ever going through a JS float. Returns null when not numeric. */
export function toDecimal(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  if (Decimal.isDecimal(value)) return value as Decimal;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "bigint") {
    text = value.toString();
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  try {
    const parsed = new Decimal(text);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/** Adds thousands separators to a plain decimal string ("-1234567.500" -> "-1,234,567.500"). */
export function groupDecimalString(fixed: string): string {
  const negative = fixed.startsWith("-");
  const body = negative ? fixed.slice(1) : fixed;
  const [intPart = "0", fracPart] = body.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fracPart !== undefined ? `.${fracPart}` : ""}`;
}

export function formatDecimal(value: Decimal, fractionDigits: number, grouped = true): string {
  const fixed = value.toFixed(fractionDigits, Decimal.ROUND_HALF_UP);
  // Avoid "-0.000" for values that round to zero.
  const normalized = /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
  return grouped ? groupDecimalString(normalized) : normalized;
}

/** Minor units -> major-unit Decimal, using the host scale. */
export function minorToMajor(value: Decimal, scale = DEFAULT_MINOR_UNIT_SCALE): Decimal {
  return value.div(scale);
}
