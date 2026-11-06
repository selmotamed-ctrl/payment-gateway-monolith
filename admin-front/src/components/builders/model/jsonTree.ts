/**
 * Pure helpers shared by every structured builder: no Vue, no DOM.
 *
 * The builders edit JSON that the API stores verbatim. Their contract is
 * LOSSLESS round-tripping: a key a builder does not know is carried through
 * untouched (`extras`) and a value that was not edited is serialised exactly
 * like it was read.
 */
export type JsonObject = Record<string, unknown>;

export type JsonKind = "string" | "number" | "boolean" | "null" | "array" | "object";

export const isPlainObject = (value: unknown): value is JsonObject =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export const kindOf = (value: unknown): JsonKind => {
    if (value === null || value === undefined) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object") return "object";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    return "string";
};

export const deepClone = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map((entry) => deepClone(entry)) as unknown as T;
    if (isPlainObject(value)) {
        const out: JsonObject = {};
        for (const [key, entry] of Object.entries(value)) out[key] = deepClone(entry);
        return out as T;
    }
    return value;
};

export const deepEqual = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
    }
    if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return leftKeys.length === rightKeys.length && leftKeys.every((key) => key in right && deepEqual(left[key], right[key]));
    }
    return false;
};

/** `min_amount` / `ownerThresholdPercent` / `rail-codes` -> `Min amount` / `Owner threshold percent` / `Rail codes`. */
export const humanizeKey = (key: string): string => {
    const spaced = key
        .replace(/[_\-.]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
    if (!spaced) return key;
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

/** Returns the object when `value` is a plain object, otherwise a fresh empty object. A JSON string holding an object is parsed. */
export const asObject = (value: unknown): JsonObject => {
    if (isPlainObject(value)) return value;
    if (typeof value === "string") {
        try {
            const parsed: unknown = JSON.parse(value);
            if (isPlainObject(parsed)) return parsed;
        } catch {
            /* not JSON */
        }
    }
    return {};
};

/** Picks the first alias that is present in `source` (own property), else `null`. */
export const pickAlias = (source: JsonObject, aliases: readonly string[]): string | null => {
    for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(source, alias) && source[alias] !== undefined) return alias;
    }
    return null;
};

/** `value` as an editable text: numbers/booleans stringified, null/undefined/objects -> "". */
export const toText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return "";
};

/**
 * Text -> value, keeping the original JSON type when the text still represents
 * it (a number stays a number, a string stays a string). A new value is a string.
 */
export const fromText = (text: string, original: unknown): string | number => {
    const trimmed = text.trim();
    if (typeof original === "number" && trimmed !== "") {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && String(parsed) === trimmed) return parsed;
    }
    return trimmed;
};

export const isBlank = (text: string): boolean => text.trim() === "";

export const MONEY_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;
export const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,4})?$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Deduplicates (first occurrence wins), trims and drops empty entries. */
export const uniqueStrings = (values: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const clean = value.trim();
        if (clean && !seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
        }
    }
    return out;
};

/** A string-array JSON value -> `string[]` (non-string scalars stringified, non-arrays -> []). */
export const toStringList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value.trim()] : [];
    return value.filter((entry) => entry !== null && typeof entry !== "object").map((entry) => String(entry));
};

// ---------------------------------------------------------------- generic tree editing

export type TreeKind = "text" | "number" | "boolean" | "list" | "group";

export const defaultForTreeKind = (kind: TreeKind): unknown => {
    switch (kind) {
        case "number":
            return 0;
        case "boolean":
            return false;
        case "list":
            return [];
        case "group":
            return {};
        default:
            return "";
    }
};

export const treeKindOf = (value: unknown): TreeKind => {
    switch (kindOf(value)) {
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "array":
            return "list";
        case "object":
            return "group";
        default:
            return "text";
    }
};

/** An "empty" value shaped like `value` (used to add a new item to a list of objects). */
export const blankLike = (value: unknown): unknown => {
    if (Array.isArray(value)) return [];
    if (isPlainObject(value)) {
        const out: JsonObject = {};
        for (const [key, entry] of Object.entries(value)) out[key] = blankLike(entry);
        return out;
    }
    if (typeof value === "number") return 0;
    if (typeof value === "boolean") return false;
    return "";
};

export const NEW_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Returns a code when `key` cannot be added to `target`, else `null`. */
export const validateNewKey = (target: JsonObject, key: string): "EMPTY" | "INVALID" | "DUPLICATE" | null => {
    const clean = key.trim();
    if (!clean) return "EMPTY";
    if (!NEW_KEY_PATTERN.test(clean)) return "INVALID";
    if (Object.prototype.hasOwnProperty.call(target, clean)) return "DUPLICATE";
    return null;
};

export const withKey = (target: JsonObject, key: string, value: unknown): JsonObject => ({ ...target, [key]: value });

export const withoutKey = (target: JsonObject, key: string): JsonObject => {
    const out: JsonObject = { ...target };
    delete out[key];
    return out;
};

/**
 * Parses a chip that is added to a list. A list of numbers only accepts numbers,
 * any other list takes the trimmed text. Returns `undefined` when the text is rejected.
 */
export const parseListEntry = (text: string, existing: readonly unknown[]): string | number | undefined => {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    if (existing.length > 0 && existing.every((entry) => typeof entry === "number")) {
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return trimmed;
};

// ---------------------------------------------------------------- read-only summaries

export type SummaryRow = {
    /** Dotted path of the value (stable key). */
    path: string;
    /** Humanised label (English; the view translates known words). */
    label: string;
    /** A scalar shown as text, or a list shown as chips. */
    value: string | boolean | string[] | null;
    kind: "text" | "boolean" | "list" | "empty";
};

const MAX_SUMMARY_ROWS = 60;

/** Flattens a JSON value into labelled rows for a structured read view. Never produces raw JSON text. */
export const summarizeValue = (value: unknown, prefix: string[] = [], rows: SummaryRow[] = []): SummaryRow[] => {
    if (rows.length >= MAX_SUMMARY_ROWS) return rows;
    const label = prefix.map(humanizeKey).join(" · ");
    const path = prefix.join(".");
    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0 && prefix.length > 0) {
            rows.push({ path, label, value: null, kind: "empty" });
            return rows;
        }
        for (const [key, entry] of entries) summarizeValue(entry, [...prefix, key], rows);
        return rows;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            rows.push({ path, label, value: null, kind: "empty" });
        } else if (value.every((entry) => entry === null || typeof entry !== "object")) {
            rows.push({ path, label, value: value.map((entry) => String(entry)), kind: "list" });
        } else {
            value.forEach((entry, index) => summarizeValue(entry, [...prefix, String(index + 1)], rows));
        }
        return rows;
    }
    if (typeof value === "boolean") {
        rows.push({ path, label, value, kind: "boolean" });
    } else if (value === null || value === undefined || value === "") {
        rows.push({ path, label, value: null, kind: "empty" });
    } else {
        rows.push({ path, label, value: String(value), kind: "text" });
    }
    return rows;
};
