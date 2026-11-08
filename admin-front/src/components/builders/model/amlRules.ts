import {
    CURRENCY_PATTERN,
    MONEY_PATTERN,
    asObject,
    deepClone,
    deepEqual,
    humanizeKey,
    isPlainObject,
    summarizeValue,
    toStringList,
    uniqueStrings,
    type JsonObject,
    type SummaryRow,
} from "./jsonTree";

/**
 * AML rule categories and the params each one really reads (core
 * `engine/guards/AmlRuleEngine.ts` `evaluateRule`, enum `AmlRuleType`).
 * Money params are 4-decimal strings, counts are integers, `window_seconds` is only
 * reported in the hit details. `scope` is stored with the rule but the engine does not
 * evaluate it today (every effective rule applies platform-wide).
 */
export const AML_RULE_TYPES = [
    "SINGLE_AMOUNT",
    "CUMULATIVE_WINDOW",
    "STRUCTURING",
    "RISK_TIER",
    "COUNTERPARTY_COUNTRY",
    "RAIL",
    "MERCHANT_DIRECT_AMOUNT",
] as const;
export type AmlRuleType = (typeof AML_RULE_TYPES)[number];
export const AML_ACTIONS = ["HOLD", "FLAG", "BLOCK", "CASE_ONLY"] as const;
export const AML_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const AML_RISK_TIERS = ["LOW", "STANDARD", "HIGH"] as const;
export const AML_COUNTRY_MODES = ["DENY", "ALLOW"] as const;

export type AmlParamKind = "money" | "integer" | "number" | "select" | "strings" | "currency" | "window";
export type AmlParamField = {
    key: string;
    kind: AmlParamKind;
    label: string;
    hint?: string;
    options?: readonly string[];
    required?: boolean;
    min?: number;
    max?: number;
    /** Initial text of a new rule. */
    initial?: string | string[];
    /** Normalise typed chips (country and rail codes are matched upper-case by the engine). */
    uppercase?: boolean;
    /** Format validated per entry (chips). */
    entryPattern?: RegExp;
};

const WINDOW_YEAR = 31_536_000;

export const AML_PARAM_FIELDS: Record<AmlRuleType, readonly AmlParamField[]> = {
    SINGLE_AMOUNT: [
        { key: "min_amount", kind: "money", label: "Minimum amount", required: true, hint: "The rule fires when a single payment reaches this amount." },
        { key: "currency", kind: "currency", label: "Currency", hint: "Leave empty to apply to every currency.", initial: "LYD" },
    ],
    CUMULATIVE_WINDOW: [
        { key: "max_amount", kind: "money", label: "Maximum cumulative amount", hint: "Fires when the total in the window exceeds this amount." },
        { key: "max_count", kind: "integer", label: "Maximum payment count", min: 1, hint: "Fires when the number of payments in the window exceeds this count." },
        { key: "window_seconds", kind: "window", label: "Window", required: true, min: 1, max: WINDOW_YEAR, initial: "86400" },
    ],
    STRUCTURING: [
        { key: "threshold", kind: "money", label: "Reporting threshold", required: true },
        { key: "band_percent", kind: "number", label: "Band below the threshold (%)", min: 1, max: 99, initial: "10", hint: "Amounts within this percentage under the threshold count as clustered." },
        { key: "min_count", kind: "integer", label: "Minimum clustered payments", min: 2, initial: "2" },
        { key: "window_seconds", kind: "window", label: "Window", required: true, min: 1, max: WINDOW_YEAR, initial: "86400" },
    ],
    RISK_TIER: [
        { key: "tier", kind: "select", label: "Risk tier (and above)", options: AML_RISK_TIERS, required: true, initial: "HIGH" },
        { key: "min_amount", kind: "money", label: "Minimum amount" },
    ],
    COUNTERPARTY_COUNTRY: [
        { key: "mode", kind: "select", label: "Mode", options: AML_COUNTRY_MODES, required: true, initial: "DENY", hint: "Deny fires for listed countries, allow fires for countries outside the list." },
        { key: "countries", kind: "strings", label: "Countries", required: true, uppercase: true, entryPattern: /^[A-Z]{2}$/, hint: "Two-letter ISO 3166 country codes." },
    ],
    RAIL: [
        { key: "rail_codes", kind: "strings", label: "Rail codes", required: true, uppercase: false, hint: "Rail codes are matched case-insensitively." },
        { key: "min_amount", kind: "money", label: "Minimum amount" },
    ],
    MERCHANT_DIRECT_AMOUNT: [
        { key: "min_amount", kind: "money", label: "Minimum amount", required: true, hint: "Merchant-direct settlement: the platform holds no cash, so the rule only opens a case." },
    ],
};

export type AmlParamsForm = Record<string, string | string[]>;
export type AmlParamsState = { form: AmlParamsForm; originals: JsonObject; extras: JsonObject };

const textOf = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "");

export const defaultAmlParams = (ruleType: AmlRuleType): AmlParamsState => {
    const form: AmlParamsForm = {};
    for (const field of AML_PARAM_FIELDS[ruleType]) form[field.key] = field.kind === "strings" ? [] : (field.initial ?? "");
    return { form, originals: {}, extras: {} };
};

export const parseAmlParams = (ruleType: AmlRuleType, raw: unknown): AmlParamsState => {
    const source = asObject(raw);
    const state: AmlParamsState = { form: {}, originals: {}, extras: {} };
    const known = new Set<string>();
    for (const field of AML_PARAM_FIELDS[ruleType]) {
        known.add(field.key);
        const value = source[field.key];
        if (value !== undefined) state.originals[field.key] = value;
        state.form[field.key] = field.kind === "strings" ? toStringList(value) : textOf(value);
    }
    for (const [key, value] of Object.entries(source)) if (!known.has(key)) state.extras[key] = deepClone(value);
    return state;
};

const entryOf = (field: AmlParamField, entry: string): string => {
    const trimmed = entry.trim();
    return field.uppercase ? trimmed.toUpperCase() : trimmed;
};

/** The `params` object the API stores; blank optional params are omitted, unknown keys are kept. */
export const buildAmlParams = (ruleType: AmlRuleType, state: AmlParamsState): JsonObject => {
    const out: JsonObject = deepClone(state.extras);
    for (const field of AML_PARAM_FIELDS[ruleType]) {
        const value = state.form[field.key];
        if (field.kind === "strings") {
            const list = uniqueStrings(((value as string[]) ?? []).map((entry) => entryOf(field, entry)));
            if (list.length > 0) out[field.key] = list;
            continue;
        }
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) continue;
        if (field.kind === "money") out[field.key] = text;
        else if (field.kind === "currency") out[field.key] = text.toUpperCase();
        else if (field.kind === "select") out[field.key] = text;
        else {
            const original = state.originals[field.key];
            out[field.key] = typeof original === "string" && original === text ? original : Number(text);
        }
    }
    return out;
};

export type AmlParamErrorCode =
    | "REQUIRED"
    | "MONEY_INVALID"
    | "INTEGER_INVALID"
    | "NUMBER_INVALID"
    | "RANGE"
    | "OPTION_INVALID"
    | "CURRENCY_INVALID"
    | "ENTRY_INVALID"
    | "AT_LEAST_ONE_LIMIT";
export type AmlParamError = { field: string; code: AmlParamErrorCode; value?: string };

export const validateAmlParams = (ruleType: AmlRuleType, form: AmlParamsForm): AmlParamError[] => {
    const errors: AmlParamError[] = [];
    for (const field of AML_PARAM_FIELDS[ruleType]) {
        const value = form[field.key];
        if (field.kind === "strings") {
            const list = uniqueStrings(((value as string[]) ?? []).map((entry) => entryOf(field, entry)));
            if (field.required && list.length === 0) errors.push({ field: field.key, code: "REQUIRED" });
            if (field.entryPattern) for (const entry of list) if (!field.entryPattern.test(entry)) errors.push({ field: field.key, code: "ENTRY_INVALID", value: entry });
            continue;
        }
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) {
            if (field.required) errors.push({ field: field.key, code: "REQUIRED" });
            continue;
        }
        switch (field.kind) {
            case "money":
                if (!MONEY_PATTERN.test(text)) errors.push({ field: field.key, code: "MONEY_INVALID" });
                break;
            case "currency":
                if (!CURRENCY_PATTERN.test(text.toUpperCase())) errors.push({ field: field.key, code: "CURRENCY_INVALID" });
                break;
            case "select":
                if (!field.options?.includes(text.toUpperCase())) errors.push({ field: field.key, code: "OPTION_INVALID" });
                break;
            case "integer":
            case "window":
                if (!/^\d+$/.test(text)) errors.push({ field: field.key, code: "INTEGER_INVALID" });
                else if ((field.min !== undefined && Number(text) < field.min) || (field.max !== undefined && Number(text) > field.max)) errors.push({ field: field.key, code: "RANGE" });
                break;
            case "number": {
                const parsed = Number(text);
                if (!Number.isFinite(parsed)) errors.push({ field: field.key, code: "NUMBER_INVALID" });
                else if ((field.min !== undefined && parsed < field.min) || (field.max !== undefined && parsed > field.max)) errors.push({ field: field.key, code: "RANGE" });
                break;
            }
        }
    }
    if (ruleType === "CUMULATIVE_WINDOW") {
        const amount = typeof form.max_amount === "string" ? form.max_amount.trim() : "";
        const count = typeof form.max_count === "string" ? form.max_count.trim() : "";
        if (!amount && !count) errors.push({ field: "max_amount", code: "AT_LEAST_ONE_LIMIT" });
    }
    return errors;
};

export const isAmlParamsUnchanged = (ruleType: AmlRuleType, state: AmlParamsState, original: unknown): boolean =>
    deepEqual(buildAmlParams(ruleType, state), asObject(original));

// ---------------------------------------------------------------- duration helper

export type DurationUnit = "days" | "hours" | "minutes" | "seconds";

/** 86400 -> { value: 1, unit: "days" }; picks the largest unit that divides the seconds exactly. */
export const splitDuration = (seconds: number): { value: number; unit: DurationUnit } => {
    if (seconds > 0 && seconds % 86400 === 0) return { value: seconds / 86400, unit: "days" };
    if (seconds > 0 && seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
    if (seconds > 0 && seconds % 60 === 0) return { value: seconds / 60, unit: "minutes" };
    return { value: seconds, unit: "seconds" };
};

export const joinDuration = (value: number, unit: DurationUnit): number => {
    const factor = unit === "days" ? 86400 : unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
    return Math.round(value * factor);
};

// ---------------------------------------------------------------- summaries (table + drawer)

export type AmlParamSummary = {
    key: string;
    label: string;
    /** Pre-formatted text for scalars (money keeps its currency when known). */
    text?: string;
    list?: string[];
    /** Set for `window` params: render with the duration formatter. */
    seconds?: number;
};

/** Labelled, formatted rows for the params of a rule: declared params first (in field order), unknown keys humanised after. */
export const summarizeAmlParams = (ruleType: string, params: unknown): AmlParamSummary[] => {
    const source = asObject(params);
    const rows: AmlParamSummary[] = [];
    const known = new Set<string>();
    const fields = (AML_PARAM_FIELDS as Record<string, readonly AmlParamField[]>)[ruleType] ?? [];
    const currency = typeof source.currency === "string" ? source.currency.toUpperCase() : "";
    for (const field of fields) {
        known.add(field.key);
        const value = source[field.key];
        if (value === undefined || value === null || value === "") continue;
        if (field.kind === "strings") {
            const list = toStringList(value);
            if (list.length) rows.push({ key: field.key, label: field.label, list });
        } else if (field.kind === "window") {
            const seconds = Number(value);
            if (Number.isFinite(seconds)) rows.push({ key: field.key, label: field.label, seconds });
        } else if (field.kind === "money") {
            rows.push({ key: field.key, label: field.label, text: currency && ruleType === "SINGLE_AMOUNT" ? `${String(value)} ${currency}` : String(value) });
        } else if (field.key === "band_percent") {
            rows.push({ key: field.key, label: field.label, text: `${String(value)}%` });
        } else {
            rows.push({ key: field.key, label: field.label, text: String(value) });
        }
    }
    for (const [key, value] of Object.entries(source)) {
        if (known.has(key)) continue;
        for (const row of summarizeValue(value, [key])) rows.push(summaryRowToParam(row));
    }
    return rows;
};

const summaryRowToParam = (row: SummaryRow): AmlParamSummary => {
    if (row.kind === "list") return { key: row.path, label: row.label, list: row.value as string[] };
    if (row.kind === "boolean") return { key: row.path, label: row.label, text: row.value ? "true" : "false" };
    return { key: row.path, label: row.label, text: row.kind === "empty" ? "—" : String(row.value) };
};

/** The scope rows (humanised keys, never raw JSON). An empty scope means "all merchants and rails". */
export const summarizeAmlScope = (scope: unknown): AmlParamSummary[] =>
    summarizeValue(asObject(scope)).map(summaryRowToParam);

// ---------------------------------------------------------------- reporting rules

export const REPORTING_TYPES = ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"] as const;
export const REPORTING_STATUSES = ["PROVISIONAL", "CONFIRMED"] as const;

/**
 * Reporting-rule `conditions` the evaluator reads (core `engine/compliance/ReportingRuleEvaluator.ts`):
 * `merchantIds[]`, `merchantId`, `currencies[]`, `minAmount`, `maxAmount`. Anything else is shown humanised.
 */
export const summarizeReportingConditions = (conditions: unknown): AmlParamSummary[] => {
    const source = asObject(conditions);
    const labels: Record<string, string> = {
        merchantIds: "Merchants",
        merchantId: "Merchant",
        currencies: "Currencies",
        minAmount: "Minimum amount",
        maxAmount: "Maximum amount",
    };
    const rows: AmlParamSummary[] = [];
    const known = new Set(Object.keys(labels));
    for (const key of Object.keys(labels)) {
        const value = source[key];
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value)) {
            const list = toStringList(value);
            if (list.length) rows.push({ key, label: labels[key]!, list });
        } else rows.push({ key, label: labels[key]!, text: String(value) });
    }
    for (const [key, value] of Object.entries(source)) {
        if (known.has(key)) continue;
        if (isPlainObject(value) || Array.isArray(value)) for (const row of summarizeValue(value, [key])) rows.push(summaryRowToParam(row));
        else rows.push({ key, label: humanizeKey(key), text: value === null || value === "" ? "—" : String(value) });
    }
    return rows;
};

/** Window (seconds) -> whole days when it divides evenly, used by the reporting-rule table. */
export const windowSecondsLabel = (seconds: number | null | undefined): { value: number; unit: DurationUnit } | null =>
    typeof seconds === "number" && seconds > 0 ? splitDuration(seconds) : null;
