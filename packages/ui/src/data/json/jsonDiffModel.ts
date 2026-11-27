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

/** Semantic change status used by the 2026 audit diff rows. */
export type JsonDiffStatus = "added" | "removed" | "modified" | "unchanged";
/** Display classification of a row/value (`money`, enum status, ISO date, list, object). */
export type JsonDiffKind = "value" | "money" | "status" | "date" | "list" | "object";

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
    /** Semantic state of the row (added / removed / modified / unchanged). */
    status: JsonDiffStatus;
    /** Typed rendering hint (money, status, date, list, object, value). */
    kind: JsonDiffKind;
    /** `from` path label for move/copy operations. */
    fromLabel?: string;
    /** Currency of the nearest enclosing object that carries a `currency` string. */
    currency?: string;
}

export interface DiffModel {
    mode: DiffMode;
    entries: DiffEntry[];
}

/** One classifier row, including the raw leaf key and typed kind. */
export interface JsonDiffRow {
    path: string;
    key: string;
    segments: string[];
    label: string;
    before: unknown;
    after: unknown;
    hasBefore: boolean;
    hasAfter: boolean;
    status: JsonDiffStatus;
    kind: JsonDiffKind;
    op: EntryOp;
    currency?: string;
}

export interface JsonDiffOptions {
    /** Keep equal leaves as `unchanged` rows (default `false` for `normalizeDiff`, `true` for `classifyDiff`). */
    includeUnchanged?: boolean;
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

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const markSeenPair = (seen: WeakMap<object, WeakSet<object>>, a: object, b: object): boolean => {
    let pairs = seen.get(a);
    if (!pairs) {
        pairs = new WeakSet<object>();
        seen.set(a, pairs);
    }
    if (pairs.has(b)) return true;
    pairs.add(b);
    return false;
};

/** Structural equality for JSON values: objects, arrays, Dates, BigInt and cycles. */
export const deepEqual = (a: unknown, b: unknown, seen: WeakMap<object, WeakSet<object>> = new WeakMap()): boolean => {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        if (markSeenPair(seen, a, b)) return true;
        return a.every((item, index) => deepEqual(item, b[index], seen));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        if (markSeenPair(seen, a, b)) return true;
        return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key], seen));
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

const safeStringify = (value: unknown, ancestors: readonly unknown[], depth: number): string => {
    if (value === null) return "null";
    const type = typeof value;
    if (type === "bigint") return JSON.stringify(String(value));
    if (type === "string") return JSON.stringify(value);
    if (type === "number") return Number.isFinite(value as number) ? String(value) : JSON.stringify(String(value));
    if (type === "boolean") return value ? "true" : "false";
    if (type !== "object") return JSON.stringify(String(value));
    if (value instanceof Date) return JSON.stringify(Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString());
    if (ancestors.includes(value)) return JSON.stringify("[Circular]");
    if (depth >= 12) return JSON.stringify("[Nested]");
    const next = [...ancestors, value];
    if (Array.isArray(value)) return `[${value.map((item) => safeStringify(item, next, depth + 1)).join(",")}]`;
    if (isPlainObject(value)) {
        return `{${Object.entries(value)
            .map(([key, child]) => `${JSON.stringify(key)}:${safeStringify(child, next, depth + 1)}`)
            .join(",")}}`;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify(String(value));
    }
};

/**
 * Formatting used by copy buttons and raw inspectors. Never throws: BigInt,
 * Dates, cycles and exotic values degrade to a readable string instead of a
 * `JSON.stringify` TypeError.
 */
export const formatJsonValue = (value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return safeStringify(value, [], 0);
    } catch {
        try {
            return String(value);
        } catch {
            return "";
        }
    }
};

const MONEY_KEY = /(amount|ceiling|fee|balance|volume|total|price|flat|upto)$/i;
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

export const isIsoDateString = (value: unknown): boolean => typeof value === "string" && ISO_DATE.test(value);

/** Typed rendering hint for a JSON value. */
export const diffKindOf = (key: string, value: unknown, present = true): JsonDiffKind => {
    if (!present || value === null || value === undefined) return "value";
    if (Array.isArray(value)) return "list";
    if (value instanceof Date) return "date";
    if (isPlainObject(value)) return "object";
    if (typeof value === "string") {
        if (isIsoDateString(value)) return "date";
        if (isMoneyKey(key) && DECIMAL.test(value.trim())) return "money";
        if (isStatusValue(key, value)) return "status";
        return "value";
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return isMoneyKey(key) ? "money" : "value";
    }
    return "value";
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
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? { kind: "empty" } : { kind: "datetime", iso: value.toISOString() };
    }
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
export const flattenLeaves = (
    value: unknown,
    prefix: string[] = [],
    currency?: string,
    depth = 0,
    ancestors: readonly unknown[] = [],
): Leaf[] => {
    const own = isPlainObject(value) && typeof value.currency === "string" && CURRENCY_CODE.test(value.currency) ? value.currency : currency;
    if (depth < MAX_DEPTH && value !== null && typeof value === "object") {
        if (ancestors.includes(value)) return [{ segments: prefix, value: "[Circular]", currency: own }];
        const nextAncestors = [...ancestors, value];
        if (isPlainObject(value) && Object.keys(value).length > 0) {
            return Object.entries(value).flatMap(([key, child]) => flattenLeaves(child, [...prefix, key], own, depth + 1, nextAncestors));
        }
        if (Array.isArray(value) && value.some((item) => isPlainObject(item) || Array.isArray(item))) {
            return value.flatMap((child, index) => flattenLeaves(child, [...prefix, String(index)], own, depth + 1, nextAncestors));
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

const STATUS_BY_OP: Record<EntryOp, JsonDiffStatus> = {
    add: "added",
    remove: "removed",
    replace: "modified",
    move: "modified",
    copy: "added",
    test: "unchanged",
    value: "unchanged",
};

const namedSegment = (segments: string[]): string =>
    [...segments].reverse().find((segment) => !/^\d+$/.test(segment)) ?? segments[segments.length - 1] ?? "";

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
    status: STATUS_BY_OP[op],
    kind: diffKindOf(namedSegment(segments), hasAfter ? after : before, hasBefore || hasAfter),
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
        if (!b && !a) continue;
        // A newly added / removed blank field in a snapshot carries no information.
        // Explicit patch operations keep their row even when the value is blank.
        if (!options.op && (!b || !a) && isBlankValue((a ?? b)!.value)) continue;
        // `null` and "absent" are the same thing in a snapshot diff.
        const bValue = b ? b.value : undefined;
        const aValue = a ? a.value : undefined;
        const blank = isBlankValue(bValue) && isBlankValue(aValue);
        const equal = b && a ? blank || deepEqual(bValue, aValue) : blank;
        if (equal && options.changedOnly !== false) continue;
        const segments = (b ?? a)!.segments;
        const op: EntryOp = options.op ?? (b && a ? (equal ? "value" : "replace") : a ? "add" : "remove");
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
 * - `{ before, after }` -> compare (changed leaves only unless `includeUnchanged`)
 * - any other object/array/scalar -> payload (all leaves)
 */
export const normalizeDiff = (input: unknown, options: JsonDiffOptions = {}): DiffModel => {
    const value = parseInput(input);
    if (value === null || value === undefined) return { mode: "empty", entries: [] };
    if (isPlainObject(value) && Array.isArray(value.operations) && Object.keys(value).length === 1) {
        return normalizeDiff(value.operations, options);
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
            changedOnly: options.includeUnchanged !== true,
        });
        return { mode: "compare", entries };
    }
    const entries = payloadEntries(value);
    return { mode: entries.length === 0 ? "empty" : "payload", entries };
};

/**
 * Flat typed classifier used by `JsonDiffViewer` and payload inspectors.
 * Unchanged leaves are included by default so a caller can decide whether to
 * collapse them; pass `{ includeUnchanged: false }` to keep changes only.
 */
export const classifyDiff = (input: unknown, options: JsonDiffOptions = {}): JsonDiffRow[] => {
    const model = normalizeDiff(input, { includeUnchanged: options.includeUnchanged !== false });
    return model.entries.map((entry) => ({
        path: entry.path,
        key: entry.segments.length > 0 ? entry.segments[entry.segments.length - 1]! : "",
        segments: entry.segments,
        label: entry.label,
        before: entry.before,
        after: entry.after,
        hasBefore: entry.hasBefore,
        hasAfter: entry.hasAfter,
        status: entry.status,
        kind: entry.kind,
        op: entry.op,
        currency: entry.currency,
    }));
};

/** Alias with a row-oriented name for page code. */
export const diffRows = classifyDiff;

/** View model of the `before` / `after` side of an entry. */
export const entryView = (entry: DiffEntry, side: "before" | "after"): ValueView => {
    const key = entry.segments.length > 0 ? entry.segments[entry.segments.length - 1]! : "";
    const lastNamed = [...entry.segments].reverse().find((segment) => !/^\d+$/.test(segment)) ?? key;
    return side === "before"
        ? classifyValue(lastNamed, entry.before, entry.hasBefore, entry.currency)
        : classifyValue(lastNamed, entry.after, entry.hasAfter, entry.currency);
};
