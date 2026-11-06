/**
 * Pure model behind `JsonDiffViewer` / `JsonValueList` (no Vue, no DOM).
 *
 * Turns the three diff shapes the platform produces into one flat list of
 * human-labelled entries:
 *   - RFC-6902 patch arrays (`[{ op, path, value, oldValue? }]`, or `{ operations }`)
 *   - `{ before, after }` snapshots (audit rows, pricing history)
 *   - plain payload objects (`DRAFT_AML_RULE`, `CREATE_ADJUSTMENT`, ...)
 * and classifies every leaf value so the view can pick money / status / chips.
 */

export type JsonPatchOp = "add" | "remove" | "replace" | "move" | "copy" | "test";
export type DiffMode = "patch" | "compare" | "payload" | "empty";
export type EntryOp = JsonPatchOp | "value";

export interface JsonPatchOperation {
    op: JsonPatchOp;
    path: string;
    value?: unknown;
    from?: string;
    oldValue?: unknown;
    fromValue?: unknown;
    before?: unknown;
}

export interface DiffEntry {
    /** JSON-pointer style path (`/payoutBankDetailsJson/iban`), "" for the whole record. */
    path: string;
    segments: string[];
    /** Human label, e.g. `Payout Bank Details · IBAN`. Empty for the root. */
    label: string;
    op: EntryOp;
    before: unknown;
    after: unknown;
    hasBefore: boolean;
    hasAfter: boolean;
    /** `from` path label for move/copy operations. */
    fromLabel?: string;
    /** Currency of the nearest enclosing object that carries a `currency` string. */
    currency?: string;
}

export interface DiffModel {
    mode: DiffMode;
    entries: DiffEntry[];
}

export type ValueView =
    | { kind: "absent" }
    | { kind: "empty" }
    | { kind: "money"; amount: string; currency?: string }
    | { kind: "status"; status: string }
    | { kind: "boolean"; value: boolean }
    | { kind: "datetime"; iso: string }
    | { kind: "list"; items: string[] }
    | { kind: "number"; text: string }
    | { kind: "text"; text: string };

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

const ACRONYMS: Record<string, string> = {
    id: "ID",
    ids: "IDs",
    iban: "IBAN",
    bic: "BIC",
    swift: "SWIFT",
    url: "URL",
    urls: "URLs",
    uri: "URI",
    ip: "IP",
    ips: "IPs",
    api: "API",
    kyb: "KYB",
    kyc: "KYC",
    aml: "AML",
    str: "STR",
    pep: "PEP",
    sms: "SMS",
    otp: "OTP",
    rrn: "RRN",
    gl: "GL",
    pos: "POS",
    bps: "bps",
    sla: "SLA",
    ui: "UI",
    cbl: "CBL",
    ofac: "OFAC",
    un: "UN",
    eu: "EU",
    http: "HTTP",
    https: "HTTPS",
    tls: "TLS",
    mtls: "mTLS",
    kms: "KMS",
    lyd: "LYD",
    usd: "USD",
    utc: "UTC",
    cidr: "CIDR",
    ocr: "OCR",
};

const splitWords = (key: string): string[] =>
    key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/[_\-\s.]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);

/** `payoutBankDetailsJson` -> `Payout Bank Details`, `iban` -> `IBAN`, `rail_code` -> `Rail Code`. */
export const humanizeKey = (key: string): string => {
    let words = splitWords(String(key));
    if (words.length > 1 && words[words.length - 1]!.toLowerCase() === "json") words = words.slice(0, -1);
    return words
        .map((word) => {
            const lower = word.toLowerCase();
            if (ACRONYMS[lower]) return ACRONYMS[lower]!;
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join(" ");
};

const unescapePointer = (segment: string): string => segment.replace(/~1/g, "/").replace(/~0/g, "~");
const escapePointer = (segment: string): string => segment.replace(/~/g, "~0").replace(/\//g, "~1");

/** Accepts JSON pointers (`/a/b/0`), dotted paths (`a.b[0]`) and `""` / `$` for the root. */
export const parsePath = (path: string | null | undefined): string[] => {
    const raw = String(path ?? "").trim();
    if (raw === "" || raw === "$" || raw === "/" || raw === "(root)") return [];
    if (raw.startsWith("/")) return raw.slice(1).split("/").map(unescapePointer);
    return raw
        .replace(/^\$\.?/, "")
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .filter((part) => part !== "");
};

export const toPointer = (segments: string[]): string =>
    segments.length === 0 ? "" : `/${segments.map(escapePointer).join("/")}`;

/** One path segment as a label: numeric -> `#N` (1-based), `-` -> `New item`. */
export const humanizeSegment = (segment: string): string => {
    if (/^\d+$/.test(segment)) return `#${Number(segment) + 1}`;
    if (segment === "-") return "New item";
    return humanizeKey(segment);
};

export const humanizeSegments = (segments: string[]): string => segments.map(humanizeSegment).join(" · ");

/** `/payoutBankDetailsJson/iban` -> `Payout Bank Details · IBAN`. */
export const humanizePath = (path: string | null | undefined): string => humanizeSegments(parsePath(path));

/* ------------------------------------------------------------------ */
/* value helpers                                                       */
/* ------------------------------------------------------------------ */

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
    }
    return false;
};

/** Strings that hold serialised JSON objects/arrays (`stringifyChangeValue`) are parsed back. */
export const coerceValue = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!(text.startsWith("{") || text.startsWith("["))) return value;
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === "object" ? parsed : value;
    } catch {
        return value;
    }
};

const MONEY_KEY = /(amount|ceiling|fee|balance|volume|flat|upto)$/i;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const STATUS_KEY = /(status|state|result|severity|outcome|decision|tier|mode|kind|role|action|model|type)$/i;
const ENUM_VALUE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{4,}$/;
const ENUM_SHORT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NON_STATUS_KEY = /(currency|code|id|ref|reference|key|name|email|phone)$/i;

export const isMoneyKey = (key: string): boolean => MONEY_KEY.test(key);

export const isStatusValue = (key: string, value: unknown): boolean => {
    if (typeof value !== "string") return false;
    if (NON_STATUS_KEY.test(key)) return false;
    if (STATUS_KEY.test(key)) return ENUM_SHORT.test(value) && value.length >= 2 && value.length <= 40;
    return ENUM_VALUE.test(value) && value.length >= 4 && value.length <= 40;
};

const scalarText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return `[${value.length}]`;
    if (typeof value === "object") return `{${Object.keys(value as object).length}}`;
    return String(value);
};

/** Decide how one leaf value is drawn. `key` is the raw last path segment. */
export const classifyValue = (key: string, value: unknown, present = true, currency?: string): ValueView => {
    if (!present) return { kind: "absent" };
    if (value === null || value === undefined || value === "") return { kind: "empty" };
    if (Array.isArray(value)) {
        if (value.length === 0) return { kind: "empty" };
        return { kind: "list", items: value.map((item) => (typeof item === "string" ? item : scalarText(item))) };
    }
    if (isPlainObject(value)) {
        return Object.keys(value).length === 0 ? { kind: "empty" } : { kind: "text", text: scalarText(value) };
    }
    if (typeof value === "boolean") return { kind: "boolean", value };
    if (isMoneyKey(key) && (typeof value === "string" || typeof value === "number")) {
        const text = String(value).trim();
        if (DECIMAL.test(text)) return { kind: "money", amount: text, currency };
    }
    if (typeof value === "number" || typeof value === "bigint") return { kind: "number", text: String(value) };
    if (typeof value === "string") {
        if (ISO_DATE.test(value)) return { kind: "datetime", iso: value };
        if (isStatusValue(key, value)) return { kind: "status", status: value };
        return { kind: "text", text: value };
    }
    return { kind: "text", text: scalarText(value) };
};

/* ------------------------------------------------------------------ */
/* flattening                                                          */
/* ------------------------------------------------------------------ */

export interface Leaf {
    segments: string[];
    value: unknown;
    currency?: string;
}

const MAX_DEPTH = 12;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Nested objects (and arrays of objects) become sub-rows; scalars and scalar arrays stay leaves. */
export const flattenLeaves = (value: unknown, prefix: string[] = [], currency?: string, depth = 0): Leaf[] => {
    const own = isPlainObject(value) && typeof value.currency === "string" && CURRENCY_CODE.test(value.currency) ? value.currency : currency;
    if (depth < MAX_DEPTH) {
        if (isPlainObject(value) && Object.keys(value).length > 0) {
            return Object.entries(value).flatMap(([key, child]) => flattenLeaves(child, [...prefix, key], own, depth + 1));
        }
        if (Array.isArray(value) && value.some((item) => isPlainObject(item) || Array.isArray(item))) {
            return value.flatMap((child, index) => flattenLeaves(child, [...prefix, String(index)], own, depth + 1));
        }
    }
    return [{ segments: prefix, value, currency: own }];
};

const leafKey = (segments: string[]): string => JSON.stringify(segments);

const isBlankValue = (value: unknown): boolean =>
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0);

/** An empty `{}` / `[]` mounted at the root carries no information (it is "nothing"). */
const meaningfulLeaves = (value: unknown, prefix: string[]): Leaf[] =>
    flattenLeaves(value, prefix).filter(
        (leaf) =>
            !(
                leaf.segments.length === prefix.length &&
                ((isPlainObject(leaf.value) && Object.keys(leaf.value).length === 0) ||
                    (Array.isArray(leaf.value) && leaf.value.length === 0))
            ),
    );

const naturalCompare = (a: string[], b: string[]): number =>
    a.join("/").localeCompare(b.join("/"), undefined, { numeric: true, sensitivity: "base" });

const makeEntry = (
    segments: string[],
    op: EntryOp,
    before: unknown,
    after: unknown,
    hasBefore: boolean,
    hasAfter: boolean,
    currency?: string,
): DiffEntry => ({
    path: toPointer(segments),
    segments,
    label: humanizeSegments(segments),
    op,
    before,
    after,
    hasBefore,
    hasAfter,
    currency,
});

/** Leaf-by-leaf comparison of two snapshots mounted at `prefix`. */
export const compareValues = (
    before: unknown,
    after: unknown,
    options: { prefix?: string[]; hasBefore?: boolean; hasAfter?: boolean; changedOnly?: boolean; op?: EntryOp; sort?: boolean } = {},
): DiffEntry[] => {
    const prefix = options.prefix ?? [];
    const hasBefore = options.hasBefore ?? before !== undefined;
    const hasAfter = options.hasAfter ?? after !== undefined;
    const beforeLeaves = hasBefore ? meaningfulLeaves(before, prefix) : [];
    const afterLeaves = hasAfter ? meaningfulLeaves(after, prefix) : [];
    const beforeMap = new Map(beforeLeaves.map((leaf) => [leafKey(leaf.segments), leaf]));
    const afterMap = new Map(afterLeaves.map((leaf) => [leafKey(leaf.segments), leaf]));
    const keys = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()]));
    const entries: DiffEntry[] = [];
    for (const key of keys) {
        const b = beforeMap.get(key);
        const a = afterMap.get(key);
        // `null` and "absent" are the same thing in a snapshot diff.
        const bValue = b ? b.value : undefined;
        const aValue = a ? a.value : undefined;
        if (options.changedOnly !== false && (b || a)) {
            if ((isBlankValue(bValue) && isBlankValue(aValue)) || deepEqual(bValue, aValue)) continue;
        }
        const segments = (b ?? a)!.segments;
        const op: EntryOp = options.op ?? (b && a ? "replace" : a ? "add" : "remove");
        entries.push(makeEntry(segments, op, bValue, aValue, Boolean(b), Boolean(a), (a ?? b)!.currency));
    }
    if (options.sort !== false) entries.sort((x, y) => naturalCompare(x.segments, y.segments));
    return entries;
};

/** Plain payload: every leaf is shown once (no before column). */
export const payloadEntries = (payload: unknown, prefix: string[] = []): DiffEntry[] => {
    const value = coerceValue(payload);
    if (value === null || value === undefined) return [];
    return meaningfulLeaves(value, prefix).map((leaf) => makeEntry(leaf.segments, "value", undefined, leaf.value, false, true, leaf.currency));
};

/* ------------------------------------------------------------------ */
/* normalisation                                                       */
/* ------------------------------------------------------------------ */

const isPatchOperation = (value: unknown): value is JsonPatchOperation =>
    isPlainObject(value) &&
    typeof value.op === "string" &&
    ["add", "remove", "replace", "move", "copy", "test"].includes(value.op) &&
    typeof value.path === "string";

export const isPatchArray = (value: unknown): value is JsonPatchOperation[] =>
    Array.isArray(value) && value.length > 0 && value.every(isPatchOperation);

export const isBeforeAfter = (value: unknown): value is { before?: unknown; after?: unknown } =>
    isPlainObject(value) &&
    ("before" in value || "after" in value) &&
    Object.keys(value).every((key) => key === "before" || key === "after");

const parseInput = (input: unknown): unknown => {
    if (typeof input !== "string") return input;
    const text = input.trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return input;
    }
};

const operationEntries = (operation: JsonPatchOperation): DiffEntry[] => {
    const segments = parsePath(operation.path);
    const oldRaw = operation.oldValue ?? operation.fromValue ?? operation.before;
    const hasOld = oldRaw !== undefined;
    switch (operation.op) {
        case "add":
            return compareValues(undefined, coerceValue(operation.value), { prefix: segments, hasBefore: false, hasAfter: true, changedOnly: false, op: "add", sort: false });
        case "remove": {
            const gone = hasOld ? oldRaw : operation.value;
            return compareValues(coerceValue(gone), undefined, { prefix: segments, hasBefore: gone !== undefined, hasAfter: false, changedOnly: false, op: "remove", sort: false });
        }
        case "replace":
            return compareValues(coerceValue(oldRaw), coerceValue(operation.value), {
                prefix: segments,
                hasBefore: hasOld,
                hasAfter: true,
                changedOnly: hasOld,
                op: "replace",
                sort: false,
            });
        case "test":
            return [{ ...makeEntry(segments, "test", coerceValue(oldRaw), coerceValue(operation.value), hasOld, operation.value !== undefined) }];
        case "move":
        case "copy":
            return [{ ...makeEntry(segments, operation.op, undefined, undefined, false, false), fromLabel: humanizePath(operation.from) || "—" }];
    }
};

/**
 * Normalise any diff payload into display entries.
 * - `[ {op,path,...} ]` or `{ operations: [...] }` -> patch
 * - `{ before, after }` -> compare (changed leaves only)
 * - any other object/array/scalar -> payload (all leaves)
 */
export const normalizeDiff = (input: unknown): DiffModel => {
    const value = parseInput(input);
    if (value === null || value === undefined) return { mode: "empty", entries: [] };
    if (isPlainObject(value) && Array.isArray(value.operations) && Object.keys(value).length === 1) {
        return normalizeDiff(value.operations);
    }
    if (Array.isArray(value) && value.length === 0) return { mode: "empty", entries: [] };
    if (isPatchArray(value)) {
        return { mode: "patch", entries: value.flatMap(operationEntries) };
    }
    if (isBeforeAfter(value)) {
        const before = coerceValue(parseInput(value.before));
        const after = coerceValue(parseInput(value.after));
        const entries = compareValues(before, after, {
            hasBefore: before !== undefined && before !== null,
            hasAfter: after !== undefined && after !== null,
        });
        return { mode: "compare", entries };
    }
    const entries = payloadEntries(value);
    return { mode: entries.length === 0 ? "empty" : "payload", entries };
};

/** View model of the `before` / `after` side of an entry. */
export const entryView = (entry: DiffEntry, side: "before" | "after"): ValueView => {
    const key = entry.segments.length > 0 ? entry.segments[entry.segments.length - 1]! : "";
    const lastNamed = [...entry.segments].reverse().find((segment) => !/^\d+$/.test(segment)) ?? key;
    return side === "before"
        ? classifyValue(lastNamed, entry.before, entry.hasBefore, entry.currency)
        : classifyValue(lastNamed, entry.after, entry.hasAfter, entry.currency);
};
