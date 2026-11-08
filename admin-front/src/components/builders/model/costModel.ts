import {
    MONEY_PATTERN,
    PERCENT_PATTERN,
    asObject,
    deepClone,
    fromText,
    isBlank,
    pickAlias,
    toText,
    type JsonObject,
} from "./jsonTree";

/**
 * Route cost model. The engine (core-back `engine/flow/VisibleRailsResolver.ts`
 * `RouteCostModel`) reads: `calc_type`, `flat`, `percent`, `min`, `max`,
 * `tiers[{ up_to, flat, percent }]` and the fee accrual flag `accrue_fee_at_confirm`
 * (`engine/runtime/attemptRepository.ts`). Older rows carry the wizard spelling
 * (`model`, `flatFee`, `percentFee`, `minFee`, `maxFee`) or camelCase: every alias
 * is read and written back under the spelling that was found.
 */
export const COST_CALC_TYPES = ["FLAT", "PERCENTAGE", "TIERED", "HYBRID"] as const;
export type CostCalcType = (typeof COST_CALC_TYPES)[number];

export type CostField = "calcType" | "flat" | "percent" | "min" | "max" | "accrue" | "tiers";
const FIELD_ALIASES: Record<CostField, readonly string[]> = {
    calcType: ["calc_type", "calcType", "model"],
    flat: ["flat", "flatFee", "flat_fee"],
    percent: ["percent", "percentFee", "percent_fee"],
    min: ["min", "minFee", "min_fee"],
    max: ["max", "maxFee", "max_fee"],
    accrue: ["accrue_fee_at_confirm", "accrueFeeAtConfirm"],
    tiers: ["tiers"],
};
const TIER_ALIASES = { upTo: ["up_to", "upTo"], flat: ["flat"], percent: ["percent"] } as const;

export type CostTierForm = {
    upTo: string;
    flat: string;
    percent: string;
    /** Spellings / JSON types / unknown keys of the tier, carried through untouched. */
    meta: TierMeta;
};
type TierMeta = {
    keys: Partial<Record<"upTo" | "flat" | "percent", string>>;
    originals: Partial<Record<"upTo" | "flat" | "percent", unknown>>;
    extras: JsonObject;
};

export type CostModelForm = {
    calcType: CostCalcType | "";
    flat: string;
    percent: string;
    min: string;
    max: string;
    accrueFeeAtConfirm: boolean;
    tiers: CostTierForm[];
};

export type CostModelState = {
    form: CostModelForm;
    keys: Partial<Record<CostField, string>>;
    originals: Partial<Record<CostField, unknown>>;
    extras: JsonObject;
};

const emptyForm = (): CostModelForm => ({ calcType: "", flat: "", percent: "", min: "", max: "", accrueFeeAtConfirm: false, tiers: [] });

const parseTier = (raw: unknown): CostTierForm => {
    const source = asObject(raw);
    const meta: TierMeta = { keys: {}, originals: {}, extras: {} };
    const consumed = new Set<string>();
    const read = (field: "upTo" | "flat" | "percent"): string => {
        const alias = pickAlias(source, TIER_ALIASES[field]);
        if (!alias) return "";
        meta.keys[field] = alias;
        meta.originals[field] = source[alias];
        consumed.add(alias);
        return toText(source[alias]);
    };
    const upTo = read("upTo");
    const flat = read("flat");
    const percent = read("percent");
    for (const [key, value] of Object.entries(source)) if (!consumed.has(key)) meta.extras[key] = deepClone(value);
    return { upTo, flat, percent, meta };
};

export const parseCostModel = (raw: unknown): CostModelState => {
    const source = asObject(raw);
    const state: CostModelState = { form: emptyForm(), keys: {}, originals: {}, extras: {} };
    const consumed = new Set<string>();
    const take = (field: CostField): unknown => {
        const alias = pickAlias(source, FIELD_ALIASES[field]);
        if (!alias) return undefined;
        state.keys[field] = alias;
        state.originals[field] = source[alias];
        consumed.add(alias);
        return source[alias];
    };
    const calc = take("calcType");
    if (typeof calc === "string") {
        const upper = calc.trim().toUpperCase();
        if ((COST_CALC_TYPES as readonly string[]).includes(upper)) state.form.calcType = upper as CostCalcType;
        else state.form.calcType = "";
    }
    state.form.flat = toText(take("flat"));
    state.form.percent = toText(take("percent"));
    state.form.min = toText(take("min"));
    state.form.max = toText(take("max"));
    const accrue = take("accrue");
    state.form.accrueFeeAtConfirm = accrue === true || accrue === "true" || accrue === 1;
    const tiers = take("tiers");
    state.form.tiers = Array.isArray(tiers) ? tiers.map(parseTier) : [];
    for (const [key, value] of Object.entries(source)) if (!consumed.has(key)) state.extras[key] = deepClone(value);
    // A calc_type that is not a known enum value is kept verbatim.
    if (typeof calc === "string" && state.form.calcType === "") state.extras = { ...state.extras, [state.keys.calcType ?? "calc_type"]: calc };
    return state;
};

const keyFor = (state: Pick<CostModelState, "keys">, field: CostField): string => state.keys[field] ?? FIELD_ALIASES[field][0]!;

const emitText = (text: string, original: unknown): string | number => fromText(text, original);

const serializeTier = (tier: CostTierForm): JsonObject => {
    const out: JsonObject = { ...deepClone(tier.meta.extras) };
    const put = (field: "upTo" | "flat" | "percent", text: string) => {
        if (isBlank(text)) return;
        out[tier.meta.keys[field] ?? TIER_ALIASES[field][0]] = emitText(text, tier.meta.originals[field]);
    };
    put("upTo", tier.upTo);
    put("flat", tier.flat);
    put("percent", tier.percent);
    return out;
};

/** The object the route PATCH accepts (`costModel: z.record(...)`). Unknown keys are preserved. */
export const serializeCostModel = (state: CostModelState): JsonObject => {
    const out: JsonObject = deepClone(state.extras);
    const { form } = state;
    const put = (field: CostField, value: unknown) => {
        out[keyFor(state, field)] = value;
    };
    // An unknown calc_type spelling is already preserved through `extras`.
    if (form.calcType) put("calcType", form.calcType);
    for (const field of ["flat", "percent", "min", "max"] as const) {
        const text = form[field];
        if (!isBlank(text)) put(field, emitText(text, state.originals[field]));
    }
    const originalAccrue = state.originals.accrue;
    const originalTruthy = originalAccrue === true || originalAccrue === "true" || originalAccrue === 1;
    if (form.accrueFeeAtConfirm) put("accrue", originalTruthy ? originalAccrue : true);
    else if (state.keys.accrue) put("accrue", typeof state.originals.accrue === "string" ? "false" : false);
    if (form.tiers.length > 0) put("tiers", form.tiers.map(serializeTier));
    return out;
};

export type CostModelErrorCode =
    | "FLAT_INVALID"
    | "PERCENT_INVALID"
    | "PERCENT_OVER_100"
    | "MIN_INVALID"
    | "MAX_INVALID"
    | "MIN_GT_MAX"
    | "TIERS_REQUIRED"
    | "TIER_UP_TO_INVALID"
    | "TIER_UP_TO_ORDER"
    | "TIER_UP_TO_REQUIRED"
    | "TIER_FLAT_INVALID"
    | "TIER_PERCENT_INVALID"
    | "TIER_EMPTY";

export type CostModelError = { code: CostModelErrorCode; field: string };

const num = (text: string): number => Number(text.trim());

export const validateCostModel = (form: CostModelForm): CostModelError[] => {
    const errors: CostModelError[] = [];
    if (!isBlank(form.flat) && !MONEY_PATTERN.test(form.flat.trim())) errors.push({ code: "FLAT_INVALID", field: "flat" });
    if (!isBlank(form.percent)) {
        if (!PERCENT_PATTERN.test(form.percent.trim())) errors.push({ code: "PERCENT_INVALID", field: "percent" });
        else if (num(form.percent) > 100) errors.push({ code: "PERCENT_OVER_100", field: "percent" });
    }
    if (!isBlank(form.min) && !MONEY_PATTERN.test(form.min.trim())) errors.push({ code: "MIN_INVALID", field: "min" });
    if (!isBlank(form.max) && !MONEY_PATTERN.test(form.max.trim())) errors.push({ code: "MAX_INVALID", field: "max" });
    if (
        !isBlank(form.min) && !isBlank(form.max) &&
        MONEY_PATTERN.test(form.min.trim()) && MONEY_PATTERN.test(form.max.trim()) &&
        num(form.min) > num(form.max)
    ) {
        errors.push({ code: "MIN_GT_MAX", field: "min" });
    }
    const tiered = form.calcType === "TIERED" || form.calcType === "HYBRID";
    if (tiered && form.tiers.length === 0) errors.push({ code: "TIERS_REQUIRED", field: "tiers" });
    let previous = -1;
    form.tiers.forEach((tier, index) => {
        const field = `tiers.${index}`;
        if (isBlank(tier.upTo) && isBlank(tier.flat) && isBlank(tier.percent)) {
            errors.push({ code: "TIER_EMPTY", field });
            return;
        }
        if (isBlank(tier.upTo)) {
            // Only the last tier may be the open-ended catch-all.
            if (index !== form.tiers.length - 1) errors.push({ code: "TIER_UP_TO_REQUIRED", field: `${field}.upTo` });
        } else if (!MONEY_PATTERN.test(tier.upTo.trim())) {
            errors.push({ code: "TIER_UP_TO_INVALID", field: `${field}.upTo` });
        } else {
            const value = num(tier.upTo);
            if (value <= previous) errors.push({ code: "TIER_UP_TO_ORDER", field: `${field}.upTo` });
            previous = value;
        }
        if (!isBlank(tier.flat) && !MONEY_PATTERN.test(tier.flat.trim())) errors.push({ code: "TIER_FLAT_INVALID", field: `${field}.flat` });
        if (!isBlank(tier.percent) && (!PERCENT_PATTERN.test(tier.percent.trim()) || num(tier.percent) > 100)) {
            errors.push({ code: "TIER_PERCENT_INVALID", field: `${field}.percent` });
        }
    });
    return errors;
};

// ---------------------------------------------------------------- display

export type CostFormatLabels = { min: string; max: string; tiers: string; tiered: string };
const DEFAULT_LABELS: CostFormatLabels = { min: "min", max: "max", tiers: "tiers", tiered: "Tiered" };

const trimZeros = (text: string): string => {
    const value = Number(text);
    return Number.isFinite(value) ? String(value) : text;
};
/** LYD has 3 decimals; other currencies use 2. Display only (never used for arithmetic). */
const money = (text: string, currency: string): string => {
    const value = Number(text);
    if (!Number.isFinite(value)) return `${text} ${currency}`.trim();
    return `${value.toFixed(currency === "LYD" ? 3 : 2)} ${currency}`.trim();
};

/**
 * `1.25% + 0.500 LYD (min 0.100 LYD, max 5.000 LYD)`; tiered models append `· Tiered · 3 tiers`.
 * Returns `""` for an empty model so the caller can show a placeholder.
 */
export const formatCostModel = (raw: unknown, options: { currency?: string; labels?: Partial<CostFormatLabels> } = {}): string => {
    const currency = options.currency ?? "LYD";
    const labels = { ...DEFAULT_LABELS, ...options.labels };
    const { form } = parseCostModel(raw);
    const core: string[] = [];
    if (!isBlank(form.percent) && Number(form.percent) !== 0) core.push(`${trimZeros(form.percent.trim())}%`);
    if (!isBlank(form.flat) && Number(form.flat) !== 0) core.push(money(form.flat.trim(), currency));
    let text = core.join(" + ");
    const bounds: string[] = [];
    if (!isBlank(form.min) && Number(form.min) !== 0) bounds.push(`${labels.min} ${money(form.min.trim(), currency)}`);
    if (!isBlank(form.max) && Number(form.max) !== 0) bounds.push(`${labels.max} ${money(form.max.trim(), currency)}`);
    if (bounds.length > 0) text = text ? `${text} (${bounds.join(", ")})` : bounds.join(", ");
    if ((form.calcType === "TIERED" || form.calcType === "HYBRID") && form.tiers.length > 0) {
        const tierText = `${labels.tiered} · ${form.tiers.length} ${labels.tiers}`;
        text = text ? `${text} · ${tierText}` : tierText;
    }
    return text;
};
