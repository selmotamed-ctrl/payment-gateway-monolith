import type { NextFunction, Request, Response } from "express";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";

export interface AuthorityHints {
  roles: string[];
  authorities: string[];
}

/** Core mints the administrative session token (`core-back/lib/auth/index.ts`). */
const SESSION_TOKEN_TYPE = "session";
const SESSION_TOKEN_ISSUER = "payment-gateway-core";
const SESSION_TOKEN_AUDIENCE = "payment-gateway-edge";

/**
 * Authorities that grant the same access as a confidential role.
 * Mirrors `roleHasConfidentialAccess` in `core-back/api/internal/admin.ts`.
 */
const ROLE_AUTHORITY_ALIASES: Record<string, string[]> = {
  COMPLIANCE: ["AML:READ", "AML:WRITE"],
  MLRO: ["AML:READ", "AML:WRITE"],
};

const decodeSegment = (segment: string): string | null => {
  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * Reads the authority hints carried by a core session token.
 *
 * The canonical claims are `role` (a single role name) and `authorities` (an array of
 * `resource:action` strings). The legacy `roles` array and `authorities_map` object are
 * still honoured for older sessions.
 *
 * Returns `null` when the credential cannot be read as a core session token, in which case
 * the caller must deny access instead of assuming the authority is present.
 */
export const extractAuthorityHints = (authorization?: string): AuthorityHints | null => {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const decoded = decodeSegment(segments[1] ?? "");
  if (!decoded) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;

  if (typeof candidate.typ === "string" && candidate.typ !== SESSION_TOKEN_TYPE) {
    // e.g. an mfa challenge token: it is not an administrative session.
    return null;
  }
  if (typeof candidate.iss === "string" && candidate.iss !== SESSION_TOKEN_ISSUER) {
    return null;
  }
  if (candidate.aud !== undefined) {
    const audiences = isStringArray(candidate.aud)
      ? candidate.aud
      : typeof candidate.aud === "string"
        ? [candidate.aud]
        : [];
    if (!audiences.includes(SESSION_TOKEN_AUDIENCE)) return null;
  }

  const roles: string[] = [];
  if (typeof candidate.role === "string" && candidate.role.trim().length > 0) {
    roles.push(candidate.role.trim());
  }
  if (Array.isArray(candidate.roles)) {
    for (const role of candidate.roles) {
      if (typeof role === "string" && role.trim().length > 0) roles.push(role.trim());
    }
  }

  const authorities: string[] = [];
  if (Array.isArray(candidate.authorities)) {
    for (const entry of candidate.authorities) {
      if (typeof entry === "string" && entry.trim().length > 0) authorities.push(entry.trim());
    }
  }
  const authorityMap = candidate.authorities_map;
  if (typeof authorityMap === "object" && authorityMap !== null && !Array.isArray(authorityMap)) {
    for (const [key, value] of Object.entries(authorityMap as Record<string, unknown>)) {
      if (value === true) {
        authorities.push(key);
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") authorities.push(entry);
        }
        continue;
      }
      if (typeof value === "string") authorities.push(value);
    }
  }

  return { roles, authorities };
};

export const requireSession = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.headers.authorization) {
    throw new ApiError(401, "AUTH_REQUIRED", "An administrative bearer token is required");
  }
  next();
};

const normalize = (value: string): string => value.trim().toUpperCase();

export const requireAuthorities =
  (...required: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      throw new ApiError(401, "AUTH_REQUIRED", "An administrative bearer token is required");
    }
    const configured = env.ADMIN_AUTHORITY_HINTS.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const expected = required.filter((authority) => configured.length === 0 || configured.includes(authority));
    if (expected.length === 0) {
      next();
      return;
    }
    const hints = extractAuthorityHints(authorization);
    if (!hints) {
      // Confidential resources must never be opened for a credential the edge cannot read.
      throw new ApiError(
        403,
        "EDGE_AUTHORITY_DENIED",
        "The supplied administrative session does not carry the required authority",
        { required: expected },
      );
    }
    const granted = new Set([...hints.roles, ...hints.authorities].map(normalize));
    const satisfied = expected.some((authority) => {
      const candidate = normalize(authority);
      if (granted.has(candidate)) return true;
      return (ROLE_AUTHORITY_ALIASES[candidate] ?? []).some((alias) => granted.has(alias));
    });
    if (!satisfied) {
      throw new ApiError(
        403,
        "EDGE_AUTHORITY_DENIED",
        "The supplied administrative session does not carry the required authority",
        { required: expected },
      );
    }
    next();
  };
