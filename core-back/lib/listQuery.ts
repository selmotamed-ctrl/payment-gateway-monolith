import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client";

/**
 * The shared list contract for every back-office table.
 *
 * Filters are declared per endpoint and translated into a Prisma `where`
 * (never a post-filter over a capped array). Dates are inclusive; `from` is
 * start-of-day and `to` is end-of-day, so a future range ("next 30 days") works
 * the same way as a past one.
 */
export interface ListQuery {
  search?: string;
  page: number;
  pageSize: number;
  sortKey?: string;
  sortDirection: "asc" | "desc";
  status?: string;
  state?: string;
  kind?: string;
  type?: string;
  riskTier?: string;
  severity?: string;
  action?: string;
  merchantId?: string;
  railId?: string;
  gatewayId?: string;
  applicationId?: string;
  walletId?: string;
  assigneeUserId?: string;
  active?: string;
  from?: string;
  to?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: string;
  amountMax?: string;
  minScore?: string;
  maxScore?: string;
  [key: string]: unknown;
}

const asString = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

export const parseListQuery = (raw: unknown): ListQuery => {
  const source = (raw ?? {}) as Record<string, unknown>;
  const page = Math.max(1, Number(asString(source.page) ?? 1) || 1);
  const rawPageSize = Number(asString(source.pageSize) ?? 50) || 50;
  const pageSize = Math.min(200, Math.max(1, rawPageSize));
  const direction = asString(source.sortDirection);
  const result: ListQuery = {
    page,
    pageSize,
    sortDirection: direction === "desc" ? "desc" : "asc",
  };
  for (const [key, value] of Object.entries(source)) {
    if (key === "page" || key === "pageSize" || key === "sortDirection") {
      continue;
    }
    const scalar = asString(value);
    if (scalar !== undefined) {
      (result as Record<string, unknown>)[key] = scalar;
    }
  }
  return result;
};

export const csv = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

const parseDate = (value: string | undefined, endOfDay: boolean): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const setPath = (target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
  const parts = path.split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const existing = cursor[part];
    if (!existing || typeof existing !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return target;
};

export interface ListSpec {
  /** Dot paths searched with a case-insensitive `contains`, OR-ed together. */
  search?: string[];
  /**
   * Query key → dot path(s), each matched with a case-insensitive `contains`.
   * Several paths for one key are OR-ed together; different keys are AND-ed.
   */
  contains?: Record<string, string | string[]>;
  /** Query key → model/relation dot path, exact equality. */
  equals?: Record<string, string>;
  /** Query key → dot path, comma-separated `in` list. */
  in?: Record<string, string>;
  /** Query key → dot path, `"true"` / `"false"`. */
  booleans?: Record<string, string>;
  /** from/to query keys → date column. `endOfDay: false` for an exclusive start. */
  dates?: Record<string, { path: string; fromKey?: string; toKey?: string }>;
  /** `amountMin`/`amountMax` or `minScore`/`maxScore` → column. */
  ranges?: Record<string, { path: string; kind: "decimal" | "number" }>;
  /** Sort key → dot path. Only these are accepted from the client. */
  sortable?: Record<string, string>;
  defaultSort: Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>;
  defaultPageSize?: number;
}

export interface BuiltListQuery {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export const buildListQuery = (raw: unknown, spec: ListSpec): BuiltListQuery => {
  const query = parseListQuery(raw);
  const conditions: Record<string, unknown>[] = [];

  if (spec.search && query.search) {
    const or = spec.search.map((path) => setPath({}, path, { contains: query.search }));
    if (or.length > 0) {
      conditions.push({ OR: or });
    }
  }
  for (const [key, definition] of Object.entries(spec.contains ?? {})) {
    const value = query[key];
    if (typeof value !== "string" || value === "") {
      continue;
    }
    const paths = Array.isArray(definition) ? definition : [definition];
    const or = paths.map((path) => setPath({}, path, { contains: value }));
    if (or.length === 1) {
      conditions.push(or[0]!);
    } else if (or.length > 1) {
      conditions.push({ OR: or });
    }
  }
  for (const [key, path] of Object.entries(spec.equals ?? {})) {
    const value = query[key];
    if (typeof value === "string" && value !== "") {
      conditions.push(setPath({}, path, value));
    }
  }
  for (const [key, path] of Object.entries(spec.in ?? {})) {
    const values = csv(typeof query[key] === "string" ? (query[key] as string) : undefined);
    if (values.length > 0) {
      conditions.push(setPath({}, path, { in: values }));
    }
  }
  for (const [key, path] of Object.entries(spec.booleans ?? {})) {
    if (query[key] === "true" || query[key] === "false") {
      conditions.push(setPath({}, path, query[key] === "true"));
    }
  }
  for (const [name, dateSpec] of Object.entries(spec.dates ?? {})) {
    const fromKey = dateSpec.fromKey ?? `${name}From`;
    const toKey = dateSpec.toKey ?? `${name}To`;
    const fromRaw = (query[fromKey] ?? (name === "createdAt" ? query.from : undefined)) as string | undefined;
    const toRaw = (query[toKey] ?? (name === "createdAt" ? query.to : undefined)) as string | undefined;
    const from = parseDate(fromRaw, false);
    const to = parseDate(toRaw, true);
    if (from || to) {
      conditions.push(setPath({}, dateSpec.path, { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }));
    }
  }
  for (const [name, rangeSpec] of Object.entries(spec.ranges ?? {})) {
    const minRaw = query[`${name}Min`];
    const maxRaw = query[`${name}Max`];
    const min = typeof minRaw === "string" && minRaw !== "" ? minRaw : undefined;
    const max = typeof maxRaw === "string" && maxRaw !== "" ? maxRaw : undefined;
    if (min || max) {
      const value: Record<string, unknown> = {};
      if (min) {
        value.gte = rangeSpec.kind === "decimal" ? new Prisma.Decimal(min) : Number(min);
      }
      if (max) {
        value.lte = rangeSpec.kind === "decimal" ? new Prisma.Decimal(max) : Number(max);
      }
      conditions.push(setPath({}, rangeSpec.path, value));
    }
  }

  const where = conditions.length === 0 ? {} : { AND: conditions };

  const sortPath = query.sortKey && spec.sortable ? spec.sortable[query.sortKey] : undefined;
  const orderBy: Array<Record<string, unknown>> = sortPath
    ? [setPath({}, sortPath, query.sortDirection), { id: "desc" }]
    : Array.isArray(spec.defaultSort)
      ? [...spec.defaultSort, { id: "desc" }]
      : [{ ...spec.defaultSort }, { id: "desc" }];

  const rawSource = (raw ?? {}) as Record<string, unknown>;
  const requestedPageSize = typeof rawSource.pageSize === "string" && rawSource.pageSize !== "";
  const pageSize = Math.min(200, Math.max(1, requestedPageSize ? query.pageSize : spec.defaultPageSize ?? query.pageSize));
  const page = query.page;
  return { where, orderBy, page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

export interface KeysetCursorPayload {
  /** ISO timestamp of the last row's sortable createdAt. */
  c: string;
  /** UUID of the last row (tie breaker). */
  i: string;
}

export function encodeKeysetCursor(row: { createdAt: Date | string; id: string }): string {
  const c = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  return Buffer.from(JSON.stringify({ c, i: row.id }), "utf8").toString("base64url");
}

export function decodeKeysetCursor(raw?: string | null): KeysetCursorPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<KeysetCursorPayload>;
    if (typeof parsed?.c === "string" && typeof parsed?.i === "string") {
      return { c: parsed.c, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

export function buildKeysetWhere(
  cursor: KeysetCursorPayload | null,
  direction: "desc" | "asc" = "desc",
  field = "createdAt",
): Record<string, unknown> {
  if (!cursor) {
    return {};
  }
  const date = new Date(cursor.c);
  if (Number.isNaN(date.getTime())) {
    return {};
  }
  const operator = direction === "desc" ? "lt" : "gt";
  return {
    OR: [
      { [field]: { [operator]: date } },
      { [field]: date, id: { [operator]: cursor.i } },
    ],
  };
}

export function encodeKeysetCursorFromRow(
  row: Record<string, unknown>,
  field = "createdAt",
): string | null {
  const createdAt = row[field];
  const id = row.id;
  if (
    (typeof createdAt !== "string" && !(createdAt instanceof Date)) ||
    typeof id !== "string" ||
    !id
  ) {
    return null;
  }
  return encodeKeysetCursor({ createdAt, id });
}

const stableValue = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    const withJson = value as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === "function") {
      return stableValue(withJson.toJSON());
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
};

export const stableWhereHash = (where: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(where ?? {})))
    .digest("hex")
    .slice(0, 40);

export const BOUNDED_COUNT_CAP = 10001;
const BOUNDED_COUNT_CACHE_LIMIT = 1000;
const boundedCountCache = new Map<
  string,
  { expiresAt: number; value: { total: number; totalIsCapped: boolean } }
>();

export interface BoundedCountModel {
  findMany: (args: Record<string, unknown>) => Promise<unknown[]>;
}

export interface BoundedCountOptions {
  modelName?: string;
  key?: string;
  /** Maximum rows to inspect; defaults to 10001 so the API can render "10,000+". */
  cap?: number;
  ttlMs?: number;
  select?: Record<string, boolean>;
}

export interface BoundedCountResult {
  total: number;
  totalIsCapped: boolean;
}

export const clearBoundedCountCache = (): void => {
  boundedCountCache.clear();
};

/**
 * Bounded window count: never scans more than `cap` index entries. The result
 * is cached for a short TTL because list pages are reloaded frequently, and a
 * count that is a few seconds stale is acceptable for a "10,000+" indicator.
 */
export async function boundedCount(
  model: BoundedCountModel,
  where: unknown,
  options: BoundedCountOptions = {},
): Promise<BoundedCountResult> {
  const cap = Math.max(1, Math.trunc(options.cap ?? BOUNDED_COUNT_CAP));
  const ttlMs = Math.max(0, options.ttlMs ?? 15_000);
  const cacheKey = `${options.modelName ?? "model"}:${options.key ?? ""}:${stableWhereHash(where)}`;
  const now = Date.now();

  if (ttlMs > 0) {
    const cached = boundedCountCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const rows = await model.findMany({
    where: where ?? {},
    select: options.select ?? { id: true },
    take: cap,
  });

  const value: BoundedCountResult =
    rows.length >= cap
      ? { total: cap - 1, totalIsCapped: true }
      : { total: rows.length, totalIsCapped: false };

  if (ttlMs > 0) {
    for (const [key, entry] of boundedCountCache) {
      if (entry.expiresAt <= now) {
        boundedCountCache.delete(key);
      }
    }
    if (boundedCountCache.size >= BOUNDED_COUNT_CACHE_LIMIT) {
      boundedCountCache.clear();
    }
    boundedCountCache.set(cacheKey, { expiresAt: now + ttlMs, value });
  }

  return value;
}

export interface ListResponseExtras {
  nextCursor?: string | null;
  totalIsCapped?: boolean;
}

export const listResponse = <T>(
  key: string,
  rows: T[],
  total: number,
  built: Pick<BuiltListQuery, "page" | "pageSize">,
  extras: ListResponseExtras = {},
): Record<string, unknown> => ({
  [key]: rows,
  total,
  page: built.page,
  pageSize: built.pageSize,
  ...(extras.nextCursor ? { nextCursor: extras.nextCursor } : {}),
  ...(extras.totalIsCapped !== undefined ? { totalIsCapped: extras.totalIsCapped } : {}),
});
