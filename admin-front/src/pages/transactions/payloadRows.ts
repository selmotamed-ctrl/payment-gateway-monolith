/**
 * Turns the redacted wire payloads of step logs and inbound events into labelled key/value rows
 * so the UI never dumps raw JSON. Everything here is pure and covered by unit tests.
 */

export interface PayloadRow {
    /** Full path, e.g. `customer.phone` or `items[0].sku`. */
    path: string;
    /** Last path segment shown as the row label. */
    label: string;
    /** Parent path (empty at the top level), shown muted before the label. */
    parent: string;
    value: string;
    redacted: boolean;
    depth: number;
}

export interface PayloadSection {
    id: "summary" | "headers" | "query" | "body";
    rows: PayloadRow[];
    /** Rows dropped because the payload was larger than the cap. */
    truncated: number;
}

export const MAX_PAYLOAD_ROWS = 120;
const MAX_VALUE_LENGTH = 400;
const MAX_DEPTH = 6;
const REDACTED_PATTERN = /^\s*(\[?\*{0,6}redacted\*{0,6}\]?|\*{3,}.*|<redacted>|\[?masked\]?)\s*$/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const scalarText = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") {
        if (value === "") return "—";
        return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
    }
    return String(value);
};

export const isRedactedValue = (value: unknown): boolean => typeof value === "string" && REDACTED_PATTERN.test(value);

/** Flattens any JSON value into rows; objects use dotted paths, arrays use `[index]`. */
export const flattenPayload = (value: unknown, options: { maxRows?: number; prefix?: string } = {}): { rows: PayloadRow[]; truncated: number } => {
    const maxRows = options.maxRows ?? MAX_PAYLOAD_ROWS;
    const rows: PayloadRow[] = [];
    let truncated = 0;

    const push = (path: string, parent: string, label: string, raw: unknown, depth: number) => {
        if (rows.length >= maxRows) {
            truncated += 1;
            return;
        }
        rows.push({
            path,
            label,
            parent,
            value: isRedactedValue(raw) ? "" : scalarText(raw),
            redacted: isRedactedValue(raw),
            depth,
        });
    };

    const walk = (node: unknown, path: string, parent: string, label: string, depth: number) => {
        const nested = Array.isArray(node) ? node.length > 0 : isPlainObject(node) && Object.keys(node).length > 0;
        if (!nested || depth >= MAX_DEPTH) {
            if (nested) {
                // Too deep: summarise instead of recursing without bound.
                push(path, parent, label, Array.isArray(node) ? `[${node.length}]` : `{${Object.keys(node as object).length}}`, depth);
            } else {
                push(path, parent, label, Array.isArray(node) ? "[]" : isPlainObject(node) ? "{}" : node, depth);
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((entry, index) => walk(entry, `${path}[${index}]`, path, `[${index}]`, depth + 1));
            return;
        }
        for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
            walk(entry, path ? `${path}.${key}` : key, path, key, depth + 1);
        }
    };

    if (isPlainObject(value)) {
        for (const [key, entry] of Object.entries(value)) {
            walk(entry, options.prefix ? `${options.prefix}.${key}` : key, options.prefix ?? "", key, 0);
        }
    } else if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `[${index}]`, "", `[${index}]`, 0));
    } else if (value !== undefined && value !== null) {
        push("value", "", "value", value, 0);
    }
    return { rows, truncated };
};

const SECTION_KEYS: Record<string, PayloadSection["id"]> = {
    headers: "headers",
    header: "headers",
    query: "query",
    params: "query",
    queryparams: "query",
    body: "body",
    payload: "body",
    form: "body",
    data: "body",
};

const sectionOf = (key: string): PayloadSection["id"] | null => SECTION_KEYS[key.toLowerCase()] ?? null;

/**
 * Splits a logged request into a summary (method, url, ...), headers, query and body sections.
 * A request that has none of those keys is shown as a single summary section.
 */
export const sectionsOfRequest = (request: unknown): PayloadSection[] => {
    if (!isPlainObject(request)) {
        const flat = flattenPayload(request);
        return flat.rows.length > 0 ? [{ id: "summary", ...flat }] : [];
    }
    const summary: Record<string, unknown> = {};
    const grouped: Partial<Record<PayloadSection["id"], Record<string, unknown>>> = {};
    for (const [key, value] of Object.entries(request)) {
        const section = sectionOf(key);
        if (section && (isPlainObject(value) || Array.isArray(value))) {
            grouped[section] = { ...(grouped[section] ?? {}), ...(Array.isArray(value) ? { [key]: value } : value) };
        } else if (section && typeof value === "string" && section === "body") {
            const parsed = parseTextPayload(value);
            if (parsed.kind === "fields") {
                grouped.body = { ...(grouped.body ?? {}), ...Object.fromEntries(parsed.rows.map((row) => [row.path, row.redacted ? "[REDACTED]" : row.value])) };
            } else {
                summary[key] = value;
            }
        } else {
            summary[key] = value;
        }
    }
    const order: PayloadSection["id"][] = ["summary", "headers", "query", "body"];
    const sections: PayloadSection[] = [];
    for (const id of order) {
        const source = id === "summary" ? summary : grouped[id];
        if (!source || Object.keys(source).length === 0) continue;
        sections.push({ id, ...flattenPayload(source) });
    }
    return sections;
};

export type ParsedText =
    | { kind: "fields"; rows: PayloadRow[]; truncated: number }
    | { kind: "text"; text: string; truncated: boolean };

const MAX_TEXT = 4000;

/** Response/body text: JSON and form-encoded payloads become rows, anything else stays plain text. */
export const parseTextPayload = (text: string | null | undefined): ParsedText => {
    const raw = String(text ?? "");
    const trimmed = raw.trim();
    if (!trimmed) return { kind: "fields", rows: [], truncated: 0 };
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const flat = flattenPayload(JSON.parse(trimmed) as unknown);
            if (flat.rows.length > 0) return { kind: "fields", ...flat };
        } catch {
            // fall through: a cut-off JSON response is shown as text.
        }
    }
    if (/^[^\s{<"][^\n]*=[^\n]*$/.test(trimmed) && !trimmed.includes(" ")) {
        const entries = [...new URLSearchParams(trimmed).entries()];
        if (entries.length > 0) {
            return { kind: "fields", ...flattenPayload(Object.fromEntries(entries)) };
        }
    }
    return { kind: "text", text: trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed, truncated: trimmed.length > MAX_TEXT };
};

/** HTTP status → badge tone for the step log table. */
export const httpStatusTone = (status: number | null | undefined): "success" | "warning" | "danger" | "neutral" => {
    if (status === null || status === undefined) return "neutral";
    if (status >= 200 && status < 300) return "success";
    if (status === 429 || (status >= 300 && status < 400)) return "warning";
    if (status >= 400) return "danger";
    return "neutral";
};

export const formatDuration = (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
};
