import Decimal from "decimal.js";

export type MoneyInput = Decimal | string | number | bigint | null | undefined;

/** ISO-4217 minor-unit precision for the currencies the platform settles. */
export const CURRENCY_PRECISION: Record<string, number> = {
    LYD: 3,
    KWD: 3,
    BHD: 3,
    OMR: 3,
    JOD: 3,
    TND: 3,
    USD: 2,
    EUR: 2,
    GBP: 2,
    SAR: 2,
    AED: 2,
    EGP: 2,
    DZD: 2,
    MAD: 2,
    JPY: 0,
    KRW: 0,
};

export const DEFAULT_CURRENCY = "LYD";

export const currencyPrecision = (currency?: string | null): number => {
    const code = (currency || DEFAULT_CURRENCY).toUpperCase();
    return CURRENCY_PRECISION[code] ?? 2;
};

export const toDecimal = (value: MoneyInput): Decimal => {
    if (value === null || value === undefined || value === "") return new Decimal(0);
    if (value instanceof Decimal) return value;
    try {
        return new Decimal(typeof value === "bigint" ? value.toString() : String(value));
    } catch {
        return new Decimal(0);
    }
};

/** True when the input is a real number (not null/blank/NaN). */
export const isMoneyInput = (value: MoneyInput): boolean => {
    if (value === null || value === undefined || value === "") return false;
    if (value instanceof Decimal) return !value.isNaN();
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "bigint") return true;
    const text = String(value).trim();
    if (!text) return false;
    try {
        return !new Decimal(text).isNaN();
    } catch {
        return false;
    }
};

const groupThousands = (raw: string): string => raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export type FormatMoneyOptions = {
    currency?: string | null;
    locale?: "ar" | "en";
    showCurrency?: boolean;
    showSign?: boolean;
    precision?: number;
    /** Use K/M/B suffixes for dense dashboards. */
    compact?: boolean;
};

const compactSuffix = (decimal: Decimal): { value: Decimal; suffix: string } => {
    const abs = decimal.abs();
    if (abs.gte(1_000_000_000)) return { value: decimal.div(1_000_000_000), suffix: "B" };
    if (abs.gte(1_000_000)) return { value: decimal.div(1_000_000), suffix: "M" };
    if (abs.gte(1_000)) return { value: decimal.div(1_000), suffix: "K" };
    return { value: decimal, suffix: "" };
};

/**
 * Decimal-safe money formatter. Digits are always Western Latin
 * (`1,250.500 LYD`) so ledger columns align; numbers never pass through IEEE-754.
 */
export const formatMoney = (
    value: MoneyInput,
    optionsOrCurrency: FormatMoneyOptions | string = {},
): string => {
    if (!isMoneyInput(value)) return "—";
    const options: FormatMoneyOptions =
        typeof optionsOrCurrency === "string" ? { currency: optionsOrCurrency } : optionsOrCurrency;
    const currency = (options.currency || DEFAULT_CURRENCY).toUpperCase();
    const precision = options.precision ?? currencyPrecision(currency);
    const decimal = toDecimal(value);
    const negative = decimal.isNegative() && !decimal.isZero();
    const scaled = options.compact ? compactSuffix(decimal) : { value: decimal, suffix: "" };
    const fixed = scaled.value.abs().toFixed(scaled.suffix ? Math.min(precision, 1) : precision);
    const [integerPart = "0", fractionPart = ""] = fixed.split(".");
    const body = fractionPart ? `${groupThousands(integerPart)}.${fractionPart}` : groupThousands(integerPart);
    const sign = negative ? "-" : options.showSign && !decimal.isZero() ? "+" : "";
    const currencyText = options.showCurrency === false ? "" : ` ${currency}`;
    return `${sign}${body}${scaled.suffix}${currencyText}`;
};

export const formatPlainNumber = (value: MoneyInput, precision = 0): string => {
    if (!isMoneyInput(value)) return "—";
    const decimal = toDecimal(value).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
    const negative = decimal.isNegative();
    const [integerPart = "0", fractionPart = ""] = decimal.abs().toFixed(precision).split(".");
    return `${negative ? "-" : ""}${groupThousands(integerPart)}${fractionPart ? `.${fractionPart}` : ""}`;
};

export const toNumber = (value: MoneyInput): number => toDecimal(value).toNumber();
export const isZeroMoney = (value: MoneyInput): boolean => !isMoneyInput(value) || toDecimal(value).isZero();
export const compareMoney = (a: MoneyInput, b: MoneyInput): number => toDecimal(a).comparedTo(toDecimal(b));
