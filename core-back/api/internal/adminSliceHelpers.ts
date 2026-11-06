import type { Request } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/error";
import { isUuid } from "../../lib/search/uuidSearch";
import { actorFromRequest } from "../middleware/makerCheckerGuard";
import { decimal } from "../../engine/ledger/LedgerPoster";

/**
 * Small shared helpers of the ledger, operations and system admin routers
 * (`adminLedger.ts`, `adminOperations.ts`, `adminSystem.ts`).
 */

export type QueryRecord = Record<string, unknown>;

export const queryString = (query: QueryRecord, key: string): string | undefined => {
  const value = query[key];
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === "string" && scalar.trim() !== "" ? scalar.trim() : undefined;
};

/** A copy of the query without the keys a router handles itself (so buildListQuery never sees them). */
export const queryWithout = (query: QueryRecord, ...keys: string[]): QueryRecord => {
  const copy: QueryRecord = { ...query };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
};

export const requireUuidParam = (
  value: unknown,
  code: string,
  message: string,
): string => {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new ApiError(404, code, message);
  }
  return value.trim();
};

const invalidFilter = (name: string, detail?: unknown): ApiError =>
  new ApiError(400, "INVALID_FILTER", `The '${name}' filter is invalid`, detail);

/** Comma separated enum filter. Unknown members are a 400, never a database error. */
export const enumListFilter = <T extends string>(
  query: QueryRecord,
  key: string,
  allowed: readonly T[],
): T[] | undefined => {
  const raw = queryString(query, key);
  if (raw === undefined) {
    return undefined;
  }
  const values = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const unknown = values.filter((entry) => !(allowed as readonly string[]).includes(entry));
  if (unknown.length > 0 || values.length === 0) {
    throw invalidFilter(key, { allowed, unknown });
  }
  return values as T[];
};

/** Comma separated uuid filter (several ids allowed). */
export const uuidListFilter = (query: QueryRecord, key: string): string[] | undefined => {
  const raw = queryString(query, key);
  if (raw === undefined) {
    return undefined;
  }
  const values = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (values.length === 0 || values.some((entry) => !isUuid(entry))) {
    throw invalidFilter(key);
  }
  return values;
};

export const booleanFilter = (query: QueryRecord, key: string): boolean | undefined => {
  const raw = queryString(query, key);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw invalidFilter(key);
};

export const assertDecimalQuery = (query: QueryRecord, ...keys: string[]): void => {
  for (const key of keys) {
    const raw = queryString(query, key);
    if (raw !== undefined && !/^-?\d{1,18}(\.\d{1,8})?$/.test(raw)) {
      throw invalidFilter(key);
    }
  }
};

export const money4 = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "0.0000";
  }
  return decimal(value as never).toFixed(4);
};

export const money4OrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : money4(value);

/**
 * Case-insensitive text search over `textFields`, plus an exact match of a
 * full uuid over `uuidFields` (native uuid columns have no substring search).
 */
export const searchClause = (
  text: string | undefined,
  fields: { text?: readonly string[]; uuid?: readonly string[] },
): Record<string, unknown> | undefined => {
  if (!text) {
    return undefined;
  }
  const or: Record<string, unknown>[] = [];
  for (const path of fields.text ?? []) {
    or.push(nested(path, { contains: text, mode: "insensitive" }));
  }
  if (isUuid(text)) {
    for (const path of fields.uuid ?? []) {
      or.push(nested(path, text.trim()));
    }
  }
  // A query that cannot match any column must match nothing, not everything.
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
};

const nested = (path: string, value: unknown): Record<string, unknown> => {
  const parts = path.split(".");
  let result: unknown = value;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    result = { [parts[index]!]: result };
  }
  return result as Record<string, unknown>;
};

export const andWhere = (...clauses: Array<Record<string, unknown> | undefined>): Record<string, unknown> => ({
  AND: clauses.filter((clause): clause is Record<string, unknown> => clause !== undefined),
});

/** A required operator reason (10..500 characters after trimming). */
export const reasonSchema = z.string().trim().min(10).max(500);

export interface AuditActor {
  actorId: string;
  role: string;
  requestId: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

/** The audit identity of the calling staff user. Throws 403 for a principal that is not a human user. */
export const auditActor = (request: Request): AuditActor => {
  const actor = actorFromRequest(request);
  const requestId = request.headers["x-request-id"]?.toString();
  const userAgent = request.headers["user-agent"]?.toString();
  return {
    actorId: actor.userId,
    role: actor.role ?? "UNKNOWN",
    requestId: requestId ? requestId.slice(0, 64) : null,
    clientIp: request.ip ? request.ip.slice(0, 45) : null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
  };
};

/** The columns every audit row of these routers carries (audit_log has no request/ip columns). */
export const auditBase = (actor: AuditActor): { actorId: string; role: string } => ({
  actorId: actor.actorId,
  role: actor.role,
});
