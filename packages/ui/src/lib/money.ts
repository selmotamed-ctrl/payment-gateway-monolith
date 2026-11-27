import Decimal from "decimal.js";

export type MoneyInput = Decimal | string | number | null | undefined;

export const CURRENCY_PRECISION: Record<string, number> = {
    LYD: 3,
    USD: 2,
    EUR: 2,
    GBP: 2,
    SAR: 2,
    AED: 2,
    EGP: 2,
    TND: 3,
    DZD: 2,
    JOD: 3,
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
        return new Decimal(String(value));
    } catch {
        return new Decimal(0);
    }
};

const groupThousands = (raw: string): string => raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export type FormatMoneyOptions = {
    currency?: string | null;
    locale?: "ar" | "en";
    showCurrency?: boolean;
    showSign?: boolean;
    precision?: number;
};

export const formatMoney = (value: MoneyInput, options: FormatMoneyOptions = {}): string => {
    const currency = (options.currency || DEFAULT_CURRENCY).toUpperCase();
    const precision = options.precision ?? currencyPrecision(currency);
    const decimal = toDecimal(value).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
    const negative = decimal.isNegative();
    const fixed = decimal.abs().toFixed(precision);
    const [integerPart = "0", fractionPart = ""] = fixed.split(".");
    const body = fractionPart ? `${groupThousands(integerPart)}.${fractionPart}` : groupThousands(integerPart);
    const sign = negative ? "-" : options.showSign ? "+" : "";
    const currencyText = options.showCurrency === false ? "" : ` ${currency}`;
    return `${sign}${body}${currencyText}`;
};

export const formatPlainNumber = (value: MoneyInput, precision = 0): string => {
    const decimal = toDecimal(value).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
    const negative = decimal.isNegative();
    const [integerPart = "0", fractionPart = ""] = decimal.abs().toFixed(precision).split(".");
    return `${negative ? "-" : ""}${groupThousands(integerPart)}${fractionPart ? `.${fractionPart}` : ""}`;
};

export const toNumber = (value: MoneyInput): number => toDecimal(value).toNumber();
export const isZeroMoney = (value: MoneyInput): boolean => toDecimal(value).isZero();
export const compareMoney = (a: MoneyInput, b: MoneyInput): number => toDecimal(a).comparedTo(toDecimal(b));
