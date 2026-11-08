import Decimal from "decimal.js";

/**
 * Commission tiers editor model (pure).
 *
 * Wire shape: `tiers: [{ upTo?, flat?, percent? }]` sent to `POST /commission-profiles`
 * (admin-back `commissionProfileSchema.tiers`, forwarded to core as `tiersJson`).
 * The checkout fee calculator (core `api/internal/checkout.ts`, `calculateFee`) reads, per
 * tier: `upTo` (inclusive ceiling of the attempt amount; a tier without `upTo` is the
 * catch-all), `flat` (fixed fee) and `percent` (rate as a decimal fraction of the amount);
 * the first tier whose ceiling covers the amount wins. All values are decimal STRINGS.
 */
export const MAX_TIERS = 20;

export interface TierRow {
    /** Inclusive upper bound of the amount band; blank = no ceiling (last tier only). */
    upTo: string;
    /** Fixed fee charged in this band. */
    flat: string;
    /** Rate (decimal fraction, e.g. 0.015 = 1.5%) charged on the amount. */
    percent: string;
}

export type TierField = keyof TierRow;
export type TierErrorCode = "INVALID_DECIMAL" | "MISSING_PRICE" | "NOT_ASCENDING" | "CEILING_NOT_LAST" | "TOO_MANY" | "EMPTY";
export interface TierError {
    /** Zero-based row index, -1 for table-level errors. */
    index: number;
    field: TierField | "table";
    code: TierErrorCode;
}

const AMOUNT = /^\d{1,14}(\.\d{1,4})?$/;
const RATE = /^\d{1,6}(\.\d{1,6})?$/;

export const emptyTier = (): TierRow => ({ upTo: "", flat: "", percent: "" });

const asDecimalText = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
};

/** Accepts the array form and the index-keyed object (`{ "0": {...} }`) that core persists; `up_to` is an alias. */
export const tiersFromApi = (value: unknown): TierRow[] => {
    const list: unknown[] = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([, tier]) => tier)
          : [];
    return list
        .filter((tier): tier is Record<string, unknown> => !!tier && typeof tier === "object" && !Array.isArray(tier))
        .map((tier) => ({
            upTo: asDecimalText(tier.upTo ?? tier.up_to),
            flat: asDecimalText(tier.flat),
            percent: asDecimalText(tier.percent),
        }));
};

/** Request-ready tiers: blank fields are omitted, text is trimmed. */
export const tiersToApi = (rows: TierRow[]): Array<Record<string, string>> =>
    rows.map((row) => {
        const tier: Record<string, string> = {};
        if (row.upTo.trim()) tier.upTo = row.upTo.trim();
        if (row.flat.trim()) tier.flat = row.flat.trim();
        if (row.percent.trim()) tier.percent = row.percent.trim();
        return tier;
    });

const isBlank = (row: TierRow): boolean => !row.upTo.trim() && !row.flat.trim() && !row.percent.trim();

export const validateTiers = (rows: TierRow[]): TierError[] => {
    const errors: TierError[] = [];
    if (rows.length === 0) return [{ index: -1, field: "table", code: "EMPTY" }];
    if (rows.length > MAX_TIERS) errors.push({ index: -1, field: "table", code: "TOO_MANY" });
    let previous: Decimal | null = null;
    rows.forEach((row, index) => {
        if (row.upTo.trim() && !AMOUNT.test(row.upTo.trim())) errors.push({ index, field: "upTo", code: "INVALID_DECIMAL" });
        if (row.flat.trim() && !AMOUNT.test(row.flat.trim())) errors.push({ index, field: "flat", code: "INVALID_DECIMAL" });
        if (row.percent.trim() && !RATE.test(row.percent.trim())) errors.push({ index, field: "percent", code: "INVALID_DECIMAL" });
        if (!row.flat.trim() && !row.percent.trim()) errors.push({ index, field: "flat", code: "MISSING_PRICE" });
        if (!row.upTo.trim()) {
            if (index !== rows.length - 1) errors.push({ index, field: "upTo", code: "CEILING_NOT_LAST" });
        } else if (AMOUNT.test(row.upTo.trim())) {
            const ceiling = new Decimal(row.upTo.trim());
            if (previous !== null && ceiling.lte(previous)) errors.push({ index, field: "upTo", code: "NOT_ASCENDING" });
            previous = ceiling;
        }
    });
    return errors;
};

/** Rows that carry no data are dropped before validation / submission. */
export const withoutBlankTiers = (rows: TierRow[]): TierRow[] => rows.filter((row) => !isBlank(row));
