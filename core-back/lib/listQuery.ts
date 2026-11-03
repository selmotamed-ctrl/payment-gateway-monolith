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
  cursor?: string;
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

export const LIST_COUNT_CAP = 10_001;
export const LIST_COUNT_CACHE_MS = 15_000;

interface CountCacheEntry {
  expiresAt: number;
  total: number;
  totalIsCapped: boolean;
}

const countCache = new Map<string, CountCacheEntry>();

export const clearListQueryCaches = (): void => {
  countCache.clear();
};

export const clearListQueryCache = clearListQueryCaches;

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

const readPath = (source: unknown, path: string): unknown => {
  let cursor: unknown = source;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
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

export interface ListCursorPayload {
  key: string;
  direction: "asc" | "desc";
  value: unknown;
  valueType: "date" | "number" | "string" | "boolean";
  id: string;
}

export interface BuiltListQuery {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  cursor?: ListCursorPayload;
  cursorMode: boolean;
  sortPath?: string;
  sortDirection: "asc" | "desc";
}

export const encodeListCursor = (payload: ListCursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const encodeCursor = encodeListCursor;

export const decodeListCursor = (value: string | undefined): ListCursorPayload | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ListCursorPayload>;
    if (
      typeof parsed.key !== "string"
      || (parsed.direction !== "asc" && parsed.direction !== "desc")
      || typeof parsed.id !== "string"
      || (parsed.valueType !== "date"
        && parsed.valueType !== "number"
        && parsed.valueType !== "string"
        && parsed.valueType !== "boolean")
    ) {
      return null;
    }
    let decoded = parsed.value;
    if (parsed.valueType === "date" && typeof decoded === "string") {
      const date = new Date(decoded);
      decoded = Number.isNaN(date.getTime()) ? decoded : date;
    }
    return {
      key: parsed.key,
      direction: parsed.direction,
      value: decoded,
      valueType: parsed.valueType,
      id: parsed.id,
    };
  } catch {
    return null;
  }
};

const cursorValueType = (value: unknown): ListCursorPayload["valueType"] => {
  if (value instanceof Date) {
    return "date";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "string";
};

export const cursorForRow = (
  row: unknown,
  sortPath: string | undefined,
  direction: "asc" | "desc",
): string | null => {
  if (!row || typeof row !== "object") {
    return null;
  }
  const idValue = readPath(row, "id");
  if (idValue === null || idValue === undefined) {
    return null;
  }
  const key = sortPath && sortPath.length > 0 ? sortPath : "createdAt";
  const value = readPath(row, key);
  if (value === null || value === undefined) {
    return null;
  }
  const valueType = cursorValueType(value);
  return encodeCursor({
    key,
    direction,
    value: value instanceof Date ? value.toISOString() : value,
    valueType,
    id: String(idValue),
  });
};

const applyCursorCondition = (
  conditions: Record<string, unknown>[],
  cursor: ListCursorPayload,
): void => {
  if (cursor.key === "id") {
    conditions.push({ id: cursor.direction === "asc" ? { gt: cursor.id } : { lt: cursor.id } });
    return;
  }
  const comparison = cursor.direction === "asc" ? { gt: cursor.value } : { lt: cursor.value };
  conditions.push({
    OR: [
      setPath({}, cursor.key, comparison),
      {
        AND: [
          setPath({}, cursor.key, { equals: cursor.value }),
          { id: cursor.direction === "asc" ? { gt: cursor.id } : { lt: cursor.id } },
        ],
      },
    ],
  });
};

const resolveSort = (
  query: ListQuery,
  spec: ListSpec,
): { path?: string; direction: "asc" | "desc"; defaultOrder: Array<Record<string, unknown>> } => {
  const sortPath = query.sortKey && spec.sortable ? spec.sortable[query.sortKey] : undefined;
  if (sortPath) {
    return {
      path: sortPath,
      direction: query.sortDirection,
      defaultOrder: [],
    };
  }
  if (Array.isArray(spec.defaultSort)) {
    const last = spec.defaultSort[spec.defaultSort.length - 1];
    const entry = last ? Object.entries(last)[0] : undefined;
    return {
      path: entry?.[0],
      direction: (entry?.[1] as "asc" | "desc" | undefined) ?? "desc",
      defaultOrder: [...spec.defaultSort],
    };
  }
  const entry = Object.entries(spec.defaultSort)[0];
  return {
    path: entry?.[0],
    direction: (entry?.[1] as "asc" | "desc" | undefined) ?? "desc",
    defaultOrder: [{ ...spec.defaultSort }],
  };
};

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

  const sort = resolveSort(query, spec);
  const cursor = decodeListCursor(query.cursor);
  const cursorMode = Boolean(cursor && (!sort.path || cursor.key === sort.path));
  if (cursorMode && cursor) {
    applyCursorCondition(conditions, cursor);
  }

  const where = conditions.length === 0 ? {} : { AND: conditions };
  const orderBy: Array<Record<string, unknown>> = sort.path
    ? sort.path === "id"
      ? [{ id: sort.direction }]
      : [...sort.defaultOrder.filter((entry) => !(sort.path! in entry)), setPath({}, sort.path, sort.direction), { id: sort.direction }]
    : [...sort.defaultOrder, { id: sort.direction }];

  const rawSource = (raw ?? {}) as Record<string, unknown>;
  const requestedPageSize = typeof rawSource.pageSize === "string" && rawSource.pageSize !== "";
  const pageSize = Math.min(200, Math.max(1, requestedPageSize ? query.pageSize : spec.defaultPageSize ?? query.pageSize));
  const page = cursorMode ? 1 : query.page;
  return {
    where,
    orderBy,
    page,
    pageSize,
    skip: cursorMode ? 0 : Math.min((page - 1) * pageSize, 1_000),
    take: pageSize,
    cursor: cursor ?? undefined,
    cursorMode,
    sortPath: sort.path,
    sortDirection: sort.direction,
  };
};

export const listResponse = <T>(
  key: string,
  rows: T[],
  total: number,
  built: Pick<BuiltListQuery, "page" | "pageSize"> & Partial<Pick<BuiltListQuery, "sortPath" | "sortDirection" | "cursorMode">>,
): Record<string, unknown> => {
  const totalIsCapped = total >= LIST_COUNT_CAP;
  const boundedTotal = Math.min(total, LIST_COUNT_CAP);
  const last = rows[rows.length - 1];
  const nextCursor = rows.length >= built.pageSize && last !== undefined
    ? cursorForRow(last, built.sortPath, built.sortDirection ?? "desc")
    : null;
  return {
    [key]: rows,
    total: boundedTotal,
    page: built.page,
    pageSize: built.pageSize,
    nextCursor,
    totalIsCapped,
  };
};

export interface BoundedCountResult {
  total: number;
  totalIsCapped: boolean;
}

const cacheKeyOf = (key: string): string => key;

export const boundedListCount = async (
  count: () => Promise<number>,
  cacheKey: string,
  ttlMs: number = LIST_COUNT_CACHE_MS,
): Promise<BoundedCountResult> => {
  const key = cacheKeyOf(cacheKey);
  const cached = countCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { total: cached.total, totalIsCapped: cached.totalIsCapped };
  }
  const raw = Math.max(0, Math.trunc(await count()));
  const total = Math.min(raw, LIST_COUNT_CAP);
  const result = { total, totalIsCapped: raw >= LIST_COUNT_CAP };
  countCache.set(key, { expiresAt: Date.now() + ttlMs, ...result });
  return result;
};

export const boundedCountQuery = async (
  db: { $queryRawUnsafe: (...args: any[]) => Promise<any> },
  input: { table: string; whereSql?: string; params?: unknown[]; cacheKey: string },
): Promise<BoundedCountResult> => {
  if (!/^[A-Za-z0-9_]+$/.test(input.table)) {
    throw new Error("Invalid table name for a bounded count");
  }
  const where = input.whereSql && input.whereSql.trim() !== "" ? ` WHERE ${input.whereSql}` : "";
  return boundedListCount(async () => {
    const rows = (await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${input.table}${where} LIMIT ${LIST_COUNT_CAP}) AS bounded`,
      ...(input.params ?? []),
    )) as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return Number(row?.total ?? 0);
  }, input.cacheKey);
};
