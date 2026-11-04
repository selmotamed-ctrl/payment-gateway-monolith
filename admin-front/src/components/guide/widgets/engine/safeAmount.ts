import Decimal from "decimal.js";

export type RoundingMode = "NEAREST" | "UP" | "DOWN";

export const decimal = (value: Decimal.Value): Decimal => new Decimal(value ?? 0);

export const roundDecimal = (value: Decimal.Value, places: number, mode: RoundingMode): Decimal => {
    const rounding =
        mode === "UP"
            ? Decimal.ROUND_UP
            : mode === "DOWN"
              ? Decimal.ROUND_DOWN
              : Decimal.ROUND_HALF_UP;
    return decimal(value).toDecimalPlaces(places, rounding);
};

export const formatDecimal = (value: Decimal.Value, places: number): string =>
    decimal(value).toFixed(places, Decimal.ROUND_HALF_UP);

export const formatMoney = (value: Decimal.Value): string => formatDecimal(value, 4);

export const safeDecimalString = (value: Decimal.Value): string => {
    const result = decimal(value);
    return result.isFinite() ? result.toString() : "0";
};

export const assertDecimal = (value: string): boolean => {
    try {
        const parsed = new Decimal(value);
        return parsed.isFinite();
    } catch {
        return false;
    }
};
