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

export const listResponse = <T>(
  key: string,
  rows: T[],
  total: number,
  built: Pick<BuiltListQuery, "page" | "pageSize">,
): Record<string, unknown> => ({ [key]: rows, total, page: built.page, pageSize: built.pageSize });
