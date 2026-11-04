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
  /**
   * Top-level NOT NULL columns that may drive keyset (cursor) pagination in
   * addition to `createdAt`, `updatedAt` and `id`. A sort on any other column
   * (nullable, or a relation path) falls back to offset pagination.
   */
  keysetFields?: string[];
}

export interface KeysetPlan {
  fields: Array<{ path: string; direction: "asc" | "desc" }>;
}

export interface BuiltListQuery {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  /** Present when the active sort can be paged with a cursor. */
  keyset?: KeysetPlan;
  /** True when the request supplied a valid `cursor` (skip is then 0). */
  cursorApplied: boolean;
  /** False when the client sent `includeTotal=false` (skip the COUNT). */
  includeTotal: boolean;
}

const DEFAULT_KEYSET_FIELDS = new Set(["createdAt", "updatedAt", "id"]);

type CursorValue = string | number | boolean | { d: string } | { n: string };

const encodeCursorValue = (value: unknown): CursorValue | undefined => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : { d: value.toISOString() };
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return { n: value.toString() };
  }
  if (value && typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
    // Prisma.Decimal / decimal.js: keep the exact decimal text, never a float.
    return { n: String(value) };
  }
  return undefined;
};

const decodeCursorValue = (value: unknown): unknown => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.d === "string") {
      const date = new Date(record.d);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
    if (typeof record.n === "string" && /^-?\d+(\.\d+)?$/.test(record.n)) {
      return new Prisma.Decimal(record.n);
    }
  }
  throw new Error("INVALID_CURSOR_VALUE");
};

/** Encodes the keyset position of `row` (sort values + id) as an opaque token. */
export const encodeListCursor = (keyset: KeysetPlan, row: Record<string, unknown>): string | undefined => {
  const values: CursorValue[] = [];
  for (const field of keyset.fields) {
    const encoded = encodeCursorValue(row[field.path]);
    if (encoded === undefined) {
      return undefined;
    }
    values.push(encoded);
  }
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
};

const decodeListCursor = (keyset: KeysetPlan, token: string): unknown[] | undefined => {
  try {
    if (token.length > 2048) {
      return undefined;
    }
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== keyset.fields.length) {
      return undefined;
    }
    return parsed.map(decodeCursorValue);
  } catch {
    return undefined;
  }
};

/**
 * Rows strictly after the cursor for ORDER BY f1 d1, ..., fn dn:
 * OR_k (f1 = v1 AND ... AND f(k-1) = v(k-1) AND fk (> | <) vk).
 * Only NOT NULL columns are keyset fields, so no NULL ordering rules apply.
 */
export const keysetWhere = (keyset: KeysetPlan, values: unknown[]): Record<string, unknown> => {
  const branches: Record<string, unknown>[] = [];
  for (let index = 0; index < keyset.fields.length; index += 1) {
    const clause: Record<string, unknown>[] = [];
    for (let prior = 0; prior < index; prior += 1) {
      clause.push({ [keyset.fields[prior]!.path]: values[prior] });
    }
    const field = keyset.fields[index]!;
    clause.push({ [field.path]: { [field.direction === "asc" ? "gt" : "lt"]: values[index] } });
    branches.push(clause.length === 1 ? clause[0]! : { AND: clause });
  }
  return branches.length === 1 ? branches[0]! : { OR: branches };
};

export const buildListQuery = (raw: unknown, spec: ListSpec): BuiltListQuery => {
  const query = parseListQuery(raw);
  const conditions: Record<string, unknown>[] = [];

  if (spec.search && query.search) {
    const or = spec.search.map((path) => setPath({}, path, { contains: query.search, mode: "insensitive" }));
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
    const or = paths.map((path) => setPath({}, path, { contains: value, mode: "insensitive" }));
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
  const includeTotal = asString(rawSource.includeTotal) !== "false";

  // Keyset pagination (GAP-002): available when every ORDER BY term is a
  // top-level NOT NULL column. A valid `cursor` replaces OFFSET, so deep pages
  // cost the same as the first page instead of scanning and discarding
  // (page - 1) * pageSize rows.
  const allowed = new Set([...DEFAULT_KEYSET_FIELDS, ...(spec.keysetFields ?? [])]);
  const fields: KeysetPlan["fields"] = [];
  let keysetable = true;
  for (const term of orderBy) {
    const entries = Object.entries(term);
    const [path, direction] = entries[0] ?? [];
    if (entries.length !== 1 || !path || path.includes(".") || !allowed.has(path)
      || (direction !== "asc" && direction !== "desc")) {
      keysetable = false;
      break;
    }
    fields.push({ path, direction });
  }
  const keyset = keysetable && fields.length > 0 ? { fields } : undefined;
  const cursorToken = asString(rawSource.cursor);
  const cursorValues = keyset && cursorToken ? decodeListCursor(keyset, cursorToken) : undefined;
  if (keyset && cursorValues) {
    const conditionsWithCursor = [...conditions, keysetWhere(keyset, cursorValues)];
    return {
      where: { AND: conditionsWithCursor },
      orderBy,
      page,
      pageSize,
      skip: 0,
      take: pageSize,
      keyset,
      cursorApplied: true,
      includeTotal,
    };
  }
  return {
    where,
    orderBy,
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    ...(keyset ? { keyset } : {}),
    cursorApplied: false,
    includeTotal,
  };
};

/** Runs `count` unless the client opted out with `includeTotal=false`. */
export const countUnlessSkipped = async (
  built: Pick<BuiltListQuery, "includeTotal">,
  count: () => Promise<number>,
): Promise<number | null> => (built.includeTotal ? count() : null);

/**
 * Standard list envelope. When the sort supports keyset pagination and a full
 * page was returned, `nextCursor` carries the position of the last row; the
 * client passes it back as `cursor`. `sourceRows` are the raw database rows
 * when `rows` were reshaped and no longer carry the sort columns.
 */
export const listResponse = <T>(
  key: string,
  rows: T[],
  total: number | null,
  built: Pick<BuiltListQuery, "page" | "pageSize"> & Partial<Pick<BuiltListQuery, "keyset">>,
  sourceRows?: readonly unknown[],
): Record<string, unknown> => {
  const response: Record<string, unknown> = { [key]: rows, total, page: built.page, pageSize: built.pageSize };
  const source = sourceRows ?? rows;
  const last = source[source.length - 1];
  if (built.keyset && source.length >= built.pageSize && last && typeof last === "object") {
    const nextCursor = encodeListCursor(built.keyset, last as Record<string, unknown>);
    if (nextCursor) {
      response.nextCursor = nextCursor;
    }
  }
  return response;
};
