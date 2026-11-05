/** Monetary amount format shared with admin adjustments: up to 14 integer digits, up to 4 decimals, > 0. */
export const AMOUNT_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;

export const isValidPositiveAmount = (value: unknown): boolean => {
    if (typeof value !== "string") {
        return false;
    }
    const v = value.trim();
    return AMOUNT_PATTERN.test(v) && Number(v) > 0;
};
