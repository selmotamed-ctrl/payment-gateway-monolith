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
    if (value === null || value === undefined || value === "") {
        return new Decimal(0);
    }
    if (value instanceof Decimal) {
        return value;
    }
    try {
        return new Decimal(String(value));
    } catch {
        return new Decimal(0);
    }
};

export const addMoney = (a: MoneyInput, b: MoneyInput): Decimal => toDecimal(a).plus(toDecimal(b));

export const subMoney = (a: MoneyInput, b: MoneyInput): Decimal => toDecimal(a).minus(toDecimal(b));

export const mulMoney = (a: MoneyInput, b: MoneyInput): Decimal => toDecimal(a).times(toDecimal(b));

export const divMoney = (a: MoneyInput, b: MoneyInput): Decimal => {
    const divisor = toDecimal(b);
    if (divisor.isZero()) {
        return new Decimal(0);
    }
    return toDecimal(a).dividedBy(divisor);
};

export const percentOf = (amount: MoneyInput, percent: MoneyInput): Decimal =>
    toDecimal(amount).times(toDecimal(percent)).dividedBy(100);

export const sumMoney = (values: MoneyInput[]): Decimal =>
    values.reduce<Decimal>((total, value) => total.plus(toDecimal(value)), new Decimal(0));

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
    const locale = options.locale ?? "en";
    const decimal = toDecimal(value).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
    const negative = decimal.isNegative();
    const fixed = decimal.abs().toFixed(precision);
    const [integerPart = "0", fractionPart = ""] = fixed.split(".");
    const grouped = groupThousands(integerPart);
    const body = fractionPart ? `${grouped}.${fractionPart}` : grouped;
    const sign = negative ? "-" : options.showSign ? "+" : "";
    const currencyText = options.showCurrency === false ? "" : ` ${currency}`;
    if (locale === "ar") {
        return `${sign}${body}${currencyText}`;
    }
    return `${sign}${body}${currencyText}`;
};

export const formatAmount = (value: MoneyInput, currency?: string | null, locale: "ar" | "en" = "en"): string =>
    formatMoney(value, { currency, locale });

export const formatPlainNumber = (value: MoneyInput, precision = 0): string => {
    const decimal = toDecimal(value).toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
    const negative = decimal.isNegative();
    const [integerPart = "0", fractionPart = ""] = decimal.abs().toFixed(precision).split(".");
    const grouped = groupThousands(integerPart);
    const body = fractionPart ? `${grouped}.${fractionPart}` : grouped;
    return `${negative ? "-" : ""}${body}`;
};

export const toNumber = (value: MoneyInput): number => toDecimal(value).toNumber();

export const isZeroMoney = (value: MoneyInput): boolean => toDecimal(value).isZero();

export const compareMoney = (a: MoneyInput, b: MoneyInput): number => toDecimal(a).comparedTo(toDecimal(b));
