/**
 * Response normaliser for the TS ⇄ Rust parity harness.
 *
 * Purpose: two implementations of the same route must be compared on their *semantic* contract.
 * Generated identifiers, clocks, request ids, release stamps and the incidental order of sets are
 * not part of that contract. Everything else is.
 *
 * The rule table is data (`DEFAULT_RULE_TABLE`) and every rule has an id so a diff report can say
 * which rule produced a placeholder. Fixtures may append rules and override defaults through
 * `NormalizeOptions` (see `tests/parity-fixtures/README.md` for the JSON form).
 *
 * Rule table (defaults)
 * ---------------------------------------------------------------------------------------------
 * | id                          | scope   | match                                             | action |
 * | :-------------------------- | :------ | :------------------------------------------------ | :----- |
 * | status                      | status  | the HTTP status line                              | exact  |
 * | headers.allowlist           | headers | content-type, content-disposition, cache-control, | keep   |
 * |                             |         | x-content-sha256, x-pg-*, ratelimit, ratelimit-*,  |        |
 * |                             |         | retry-after, location, set-cookie                 |        |
 * | headers.volatile            | headers | date, etag, age, server, connection, keep-alive,  | drop   |
 * |                             |         | transfer-encoding, content-length, x-request-id,  |        |
 * |                             |         | x-trace-id, x-pg-request-id, x-pg-trace-id        |        |
 * | headers.ratelimit-number    | headers | remaining=N and reset=N inside ratelimit-*        | `<n>`  |
 * | body.volatile-key           | body    | requestId/request_id, traceId/trace_id, released  | drop   |
 * |                             |         | stamps, createdAt/updatedAt/deletedAt/generatedAt,|        |
 * |                             |         | uptime, nonce, webhook-id                         |        |
 * | body.detail-message         | body    | details/*\/message (design ch.8 §3.1)              | drop   |
 * | body.uuid                   | body    | canonical UUID (any version) in a string value    | `<uuid>` |
 * | body.iso-timestamp          | body    | RFC 3339 timestamp in a string value              | `<timestamp>` |
 * | body.jwt                    | body    | three-segment JWT in a string value               | `<jwt>` |
 * | body.lsn                    | body    | PostgreSQL LSN `<hex>/<hex>`                      | `<lsn>` |
 * | body.set-key                | body    | arrays under authorities/scopes/permissions/roles/| sort   |
 * |                             |         | tags (sets, not sequences)                        |        |
 * | body.key-order              | body    | every object                                      | sorted |
 *
 * Paths use `/` segments. `*` matches exactly one segment (an object key or an array element),
 * `**` matches zero or more. A leading `body/` is accepted and ignored. Arrays keep their order
 * unless a path in `unorderedPaths` or a key in `unorderedKeys` marks the array as a set.
 *
 * Key order: the design (chapter 8 §3.1) calls key order significant. This harness normalises it
 * by default because a byte-order difference with equal values is noise for every route that is
 * not explicitly a canonical-JSON format (those are covered by golden vectors). Set
 * `keyOrder: "preserve"` to compare insertion order when a route really depends on it.
 */

export type NormalizeScope = "status" | "headers" | "body";

export interface RuleDoc {
  id: string;
  scope: NormalizeScope;
  match: string;
  action: string;
}

export const DEFAULT_RULE_TABLE: readonly RuleDoc[] = [
  { id: "status", scope: "status", match: "HTTP status line", action: "exact" },
  {
    id: "headers.allowlist",
    scope: "headers",
    match:
      "content-type, content-disposition, cache-control, x-content-sha256, x-pg-*, ratelimit, ratelimit-*, retry-after, location, set-cookie",
    action: "keep",
  },
  {
    id: "headers.volatile",
    scope: "headers",
    match:
      "date, etag, age, server, connection, keep-alive, transfer-encoding, content-length, x-request-id, x-trace-id, x-pg-request-id, x-pg-trace-id",
    action: "drop",
  },
  {
    id: "headers.ratelimit-number",
    scope: "headers",
    match: "remaining=N and reset=N inside ratelimit-* values",
    action: "replace with <n>",
  },
  {
    id: "body.volatile-key",
    scope: "body",
    match:
      "requestId, request_id, traceId, trace_id, spanId, span_id, release, commit, build, uptime, generatedAt, createdAt, updatedAt, deletedAt, issuedAt, expiresAt, serverTime, webhook-id, nonce",
    action: "drop",
  },
  {
    id: "body.detail-message",
    scope: "body",
    match: "details/*/message",
    action: "drop (disable with ignoreDetailMessages=false)",
  },
  { id: "body.uuid", scope: "body", match: "canonical UUID string value", action: "replace with <uuid>" },
  {
    id: "body.iso-timestamp",
    scope: "body",
    match: "RFC 3339 timestamp string value",
    action: "replace with <timestamp>",
  },
  { id: "body.jwt", scope: "body", match: "three-segment JWT string value", action: "replace with <jwt>" },
  { id: "body.lsn", scope: "body", match: "PostgreSQL LSN string value", action: "replace with <lsn>" },
  {
    id: "body.set-key",
    scope: "body",
    match: "arrays under authorities, scopes, permissions, roles, tags",
    action: "sort",
  },
  { id: "body.key-order", scope: "body", match: "every object", action: "sort keys" },
];

export interface ValuePattern {
  name: string;
  /** Regular expression source, applied to a whole string value by default. */
  pattern: string;
  flags?: string;
  /** Replacement text; defaults to `<name>`. */
  placeholder?: string;
  /** Apply the pattern to substrings instead of requiring a full-value match. */
  substring?: boolean;
}

export interface NormalizeOptions {
  /** Extra key names dropped anywhere in the body. */
  dropKeys?: string[];
  /** Key names that must NOT be dropped even when they match a default rule. */
  keepKeys?: string[];
  /** Extra body paths dropped entirely, e.g. `data/*\/internalRef`. */
  dropPaths?: string[];
  /** Body paths whose arrays are sets (sorted before comparison). */
  unorderedPaths?: string[];
  /** Key names whose arrays are sets. Defaults to the body.set-key rule. */
  unorderedKeys?: string[];
  /** Key names whose arrays must keep their order even when they match a default set rule. */
  orderedKeys?: string[];
  /** Extra string-value patterns. Defaults to the four body.* value rules. */
  placeholders?: ValuePattern[];
  /** Replace the default header allowlist. */
  headerAllowlist?: string[];
  /** Replace the default `x-pg-`/`ratelimit-` allow prefixes. */
  headerAllowPrefixes?: string[];
  /** Extra header names dropped. */
  dropHeaders?: string[];
  /** Header names that must NOT be dropped even when they match a default rule. */
  keepHeaders?: string[];
  /** "sorted" (default) or "preserve". */
  keyOrder?: "sorted" | "preserve";
  /** Compare `ratelimit-*` counters exactly instead of replacing numbers. */
  pinRateLimit?: boolean;
  /** Keep `details[].message` (default false: dropped, design ch.8 §3.1). */
  ignoreDetailMessages?: boolean;
  /** Skip the status comparison (a route whose status is intentionally allowed to differ). */
  ignoreStatus?: boolean;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined> | Array<[string, string]> | Headers;
  body: string | Uint8Array | null | undefined;
}

export interface NormalizedResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  bodyKind: "json" | "text" | "empty";
}

export interface DiffEntry {
  path: string;
  kind: "status" | "header" | "value" | "missing-left" | "missing-right" | "length";
  left?: unknown;
  right?: unknown;
}

export interface DiffResult {
  equal: boolean;
  differences: DiffEntry[];
}

const DEFAULT_HEADER_ALLOWLIST = [
  "content-type",
  "content-disposition",
  "cache-control",
  "x-content-sha256",
  "retry-after",
  "location",
  "set-cookie",
  // express-rate-limit emits `ratelimit` (no suffix) and `ratelimit-policy`;
  // the prefix rule below covers any future `ratelimit-*` header.
  "ratelimit",
];

const DEFAULT_HEADER_ALLOW_PREFIXES = ["x-pg-", "ratelimit-"];

const DEFAULT_DROP_HEADERS = [
  "date",
  "etag",
  "age",
  "server",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "x-request-id",
  "x-trace-id",
  "x-pg-request-id",
  "x-pg-trace-id",
];

const DEFAULT_DROP_KEYS = [
  "requestId",
  "request_id",
  "traceId",
  "trace_id",
  "spanId",
  "span_id",
  "release",
  "commit",
  "build",
  "uptime",
  "generatedAt",
  "generated_at",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "deletedAt",
  "deleted_at",
  "issuedAt",
  "issued_at",
  "expiresAt",
  "expires_at",
  "serverTime",
  "server_time",
  "webhook-id",
  "webhook_id",
  "nonce",
];

const DEFAULT_DETAIL_PATHS = ["details/*/message", "details/message"];

const DEFAULT_UNORDERED_KEYS = ["authorities", "scopes", "permissions", "roles", "tags"];

const DEFAULT_PLACEHOLDERS: ValuePattern[] = [
  {
    name: "jwt",
    pattern: "^eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    placeholder: "<jwt>",
  },
  {
    name: "uuid",
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    placeholder: "<uuid>",
  },
  {
    name: "iso-timestamp",
    pattern:
      "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:[Zz]|[+-]\\d{2}:\\d{2})$",
    placeholder: "<timestamp>",
  },
  {
    name: "lsn",
    pattern: "^[0-9A-Fa-f]{1,16}/[0-9A-Fa-f]{1,16}$",
    placeholder: "<lsn>",
  },
];

interface CompiledOptions {
  dropKeys: Set<string>;
  dropPaths: string[][];
  unorderedPaths: string[][];
  unorderedKeys: Set<string>;
  placeholders: Array<{ pattern: RegExp; placeholder: string; substring: boolean }>;
  headerAllowlist: string[];
  headerAllowPrefixes: string[];
  dropHeaders: Set<string>;
  keyOrder: "sorted" | "preserve";
  pinRateLimit: boolean;
  ignoreStatus: boolean;
}

const lower = (value: string): string => value.toLowerCase();

const pathSegments = (pattern: string): string[] => {
  let value = pattern.trim();
  if (value.startsWith("body/")) value = value.slice("body/".length);
  if (value === "body") return [];
  return value.split("/").filter((segment) => segment.length > 0);
};

/** `*` matches one segment, `**` matches zero or more. */
export const pathMatches = (pattern: string[] | string, tokens: string[]): boolean => {
  const segments = typeof pattern === "string" ? pathSegments(pattern) : pattern;
  const walk = (at: number, from: number): boolean => {
    if (at === segments.length) return from === tokens.length;
    const head = segments[at];
    if (head === "**") {
      if (at + 1 === segments.length) return true;
      for (let index = from; index <= tokens.length; index += 1) {
        if (walk(at + 1, index)) return true;
      }
      return false;
    }
    if (from >= tokens.length) return false;
    if (head !== "*" && head !== tokens[from]) return false;
    return walk(at + 1, from + 1);
  };
  return walk(0, 0);
};

const compile = (options: NormalizeOptions | undefined): CompiledOptions => {
  const merged = options ?? {};
  const extraPatterns = merged.placeholders ?? [];
  const placeholders = [...DEFAULT_PLACEHOLDERS, ...extraPatterns].map((entry) => ({
    pattern: new RegExp(entry.pattern, entry.flags ?? "u"),
    placeholder: entry.placeholder ?? `<${entry.name}>`,
    substring: entry.substring === true,
  }));
  const keepKeys = new Set(merged.keepKeys ?? []);
  const keepHeaders = new Set((merged.keepHeaders ?? []).map(lower));
  return {
    dropKeys: new Set(
      [...DEFAULT_DROP_KEYS, ...(merged.dropKeys ?? [])].filter((key) => !keepKeys.has(key)),
    ),
    dropPaths: [
      ...((merged.ignoreDetailMessages ?? false) ? [] : DEFAULT_DETAIL_PATHS),
      ...(merged.dropPaths ?? []),
    ].map(pathSegments),
    unorderedPaths: (merged.unorderedPaths ?? []).map(pathSegments),
    unorderedKeys: new Set(
      [...DEFAULT_UNORDERED_KEYS, ...(merged.unorderedKeys ?? [])].filter(
        (key) => !(merged.orderedKeys ?? []).includes(key),
      ),
    ),
    placeholders,
    headerAllowlist: (merged.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST).map(lower),
    headerAllowPrefixes: (merged.headerAllowPrefixes ?? DEFAULT_HEADER_ALLOW_PREFIXES).map(lower),
    dropHeaders: new Set(
      [...DEFAULT_DROP_HEADERS, ...(merged.dropHeaders ?? [])]
        .map(lower)
        .filter((name) => !keepHeaders.has(name)),
    ),
    keyOrder: merged.keyOrder ?? "sorted",
    pinRateLimit: merged.pinRateLimit === true,
    ignoreStatus: merged.ignoreStatus === true,
  };
};

const applyPlaceholders = (value: string, compiled: CompiledOptions): string => {
  for (const { pattern, placeholder, substring } of compiled.placeholders) {
    if (substring) {
      if (pattern.test(value)) {
        pattern.lastIndex = 0;
        return value.replace(pattern, placeholder);
      }
      pattern.lastIndex = 0;
      continue;
    }
    if (pattern.test(value)) {
      pattern.lastIndex = 0;
      return placeholder;
    }
    pattern.lastIndex = 0;
  }
  return value;
};

const sortKeys = (value: Record<string, unknown>): Record<string, unknown> => {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[key] = value[key];
  }
  return sorted;
};

const canonical = (value: unknown): string => JSON.stringify(value);

const normalizeValue = (
  value: unknown,
  path: string[],
  compiled: CompiledOptions,
): unknown => {
  if (typeof value === "string") return applyPlaceholders(value, compiled);
  if (Array.isArray(value)) {
    const items = value.map((entry) => normalizeValue(entry, [...path, "*"], compiled));
    const isSet =
      compiled.unorderedPaths.some((pattern) => pathMatches(pattern, path)) ||
      (path.length > 0 && compiled.unorderedKeys.has(path[path.length - 1] ?? ""));
    if (isSet) items.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return items;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (compiled.dropKeys.has(key)) continue;
      const childPath = [...path, key];
      if (compiled.dropPaths.some((pattern) => pathMatches(pattern, childPath))) continue;
      output[key] = normalizeValue(entry, childPath, compiled);
    }
    return compiled.keyOrder === "sorted" ? sortKeys(output) : output;
  }
  return value;
};

const headerEntries = (
  headers: RawResponse["headers"],
): Array<[string, string]> => {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of headers.entries()) entries.push([key, value]);
    return entries;
  }
  if (Array.isArray(headers)) return headers.map(([key, value]) => [key, value]);
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) entries.push([key, entry]);
    } else {
      entries.push([key, value]);
    }
  }
  return entries;
};

const normaliseHeaderValue = (
  name: string,
  value: string,
  compiled: CompiledOptions,
): string => {
  const trimmed = value.trim();
  if (!compiled.pinRateLimit && (name === "ratelimit" || name.startsWith("ratelimit-"))) {
    return trimmed.replace(/\b(remaining|reset)=\d+/gi, "$1=<n>");
  }
  return applyPlaceholders(trimmed, compiled);
};

const normalizeHeaders = (
  raw: RawResponse["headers"],
  compiled: CompiledOptions,
): Record<string, string | string[]> => {
  const collected = new Map<string, string[]>();
  for (const [rawName, rawValue] of headerEntries(raw)) {
    const name = lower(rawName);
    if (compiled.dropHeaders.has(name)) continue;
    const allowed =
      compiled.headerAllowlist.includes(name) ||
      compiled.headerAllowPrefixes.some((prefix) => name.startsWith(prefix));
    if (!allowed) continue;
    const values = collected.get(name) ?? [];
    values.push(normaliseHeaderValue(name, rawValue, compiled));
    collected.set(name, values);
  }
  const output: Record<string, string | string[]> = {};
  for (const name of [...collected.keys()].sort()) {
    const values = collected.get(name) ?? [];
    values.sort();
    output[name] = values.length === 1 ? values[0]! : values;
  }
  return output;
};

const decodeBody = (body: RawResponse["body"]): string | null => {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  return new TextDecoder().decode(body);
};

const looksJson = (text: string): boolean => {
  const head = text.trimStart()[0];
  return head === "{" || head === "[" || head === '"' || head === "-" || (head !== undefined && /[0-9tfn]/.test(head));
};

export const normalizeResponse = (
  raw: RawResponse,
  options?: NormalizeOptions,
): NormalizedResponse => {
  const compiled = compile(options);
  const text = decodeBody(raw.body);
  const headers = normalizeHeaders(raw.headers, compiled);
  let body: unknown = null;
  let bodyKind: NormalizedResponse["bodyKind"] = "empty";
  if (text !== null && text.length > 0) {
    if (looksJson(text)) {
      try {
        body = normalizeValue(JSON.parse(text), [], compiled);
        bodyKind = "json";
      } catch {
        body = applyPlaceholders(text, compiled);
        bodyKind = "text";
      }
    } else {
      body = applyPlaceholders(text, compiled);
      bodyKind = "text";
    }
  }
  return { status: raw.status, headers, body, bodyKind };
};

const joinPath = (base: string, segment: string | number): string =>
  `${base}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;

const diffValue = (
  left: unknown,
  right: unknown,
  path: string,
  output: DiffEntry[],
): void => {
  if (left === undefined && right === undefined) return;
  if (left === undefined) {
    output.push({ path, kind: "missing-left", right });
    return;
  }
  if (right === undefined) {
    output.push({ path, kind: "missing-right", left });
    return;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      output.push({ path, kind: "value", left, right });
      return;
    }
    if (left.length !== right.length) {
      output.push({ path, kind: "length", left: left.length, right: right.length });
    }
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      diffValue(left[index], right[index], joinPath(path, index), output);
    }
    return;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    for (const key of keys) {
      diffValue(leftRecord[key], rightRecord[key], joinPath(path, key), output);
    }
    return;
  }
  if (!Object.is(left, right)) {
    output.push({ path, kind: "value", left, right });
  }
};

export const diffResponses = (
  left: NormalizedResponse,
  right: NormalizedResponse,
  options?: { ignoreStatus?: boolean },
): DiffResult => {
  const differences: DiffEntry[] = [];
  if (!options?.ignoreStatus && left.status !== right.status) {
    differences.push({ path: "/status", kind: "status", left: left.status, right: right.status });
  }
  const headerNames = [
    ...new Set([...Object.keys(left.headers), ...Object.keys(right.headers)]),
  ].sort();
  for (const name of headerNames) {
    diffValue(left.headers[name], right.headers[name], `/headers/${name}`, differences);
  }
  diffValue(left.body, right.body, "/body", differences);
  if (left.bodyKind !== right.bodyKind) {
    differences.push({
      path: "/bodyKind",
      kind: "value",
      left: left.bodyKind,
      right: right.bodyKind,
    });
  }
  return { equal: differences.length === 0, differences };
};

/** Human-readable diff lines, bounded so a broken route cannot flood a CI log. */
export const formatDifferences = (differences: DiffEntry[], limit = 12): string[] => {
  return differences.slice(0, limit).map((entry) => {
    const left = entry.left === undefined ? "<missing>" : JSON.stringify(entry.left);
    const right = entry.right === undefined ? "<missing>" : JSON.stringify(entry.right);
    return `${entry.kind} ${entry.path}: ${left} !== ${right}`;
  });
};

export const ruleTableLines = (): string[] =>
  DEFAULT_RULE_TABLE.map(
    (rule) => `${rule.id}\t${rule.scope}\t${rule.match}\t${rule.action}`,
  );
