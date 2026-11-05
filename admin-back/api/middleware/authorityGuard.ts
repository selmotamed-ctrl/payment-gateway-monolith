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
  COMPLIANCE: ["aml:read", "aml:write"],
  MLRO: ["aml:read", "aml:write"],
};

/** Core signs the session with HS256 only; anything else (`none`, RS256, ...) is not a core token. */
const SESSION_TOKEN_ALGORITHM = "HS256";
/** A base64url encoded HMAC-SHA256 signature is 43 characters long. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CLOCK_SKEW_SECONDS = 5;

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
export const extractAuthorityHints = (
  authorization?: string,
  nowMs: number = Date.now(),
): AuthorityHints | null => {
  if (!authorization) return null;
  const parts = authorization.split(" ");
  const [scheme, token] = parts;
  if (parts.length !== 2 || scheme?.toLowerCase() !== "bearer" || !token) return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  // The edge cannot verify the signature (core owns the key). It can still refuse every
  // credential that is not shaped like a core session: wrong algorithm (`none`), missing
  // or malformed signature segment, or a lifetime that is not currently valid.
  const decodedHeader = decodeSegment(segments[0] ?? "");
  if (!decodedHeader) return null;
  let header: unknown;
  try {
    header = JSON.parse(decodedHeader);
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  if ((header as Record<string, unknown>).alg !== SESSION_TOKEN_ALGORITHM) return null;
  if (!SIGNATURE_PATTERN.test(segments[2] ?? "")) return null;
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

  // Fail closed: every claim core always sets is mandatory.
  if (candidate.typ !== SESSION_TOKEN_TYPE) {
    // e.g. an mfa challenge token: it is not an administrative session.
    return null;
  }
  if (candidate.iss !== SESSION_TOKEN_ISSUER) {
    return null;
  }
  const audiences = isStringArray(candidate.aud)
    ? candidate.aud
    : typeof candidate.aud === "string"
      ? [candidate.aud]
      : [];
  if (!audiences.includes(SESSION_TOKEN_AUDIENCE)) return null;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)) return null;
  if (nowSeconds >= candidate.exp) return null;
  if (candidate.nbf !== undefined) {
    if (typeof candidate.nbf !== "number" || !Number.isFinite(candidate.nbf)) return null;
    if (candidate.nbf > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return null;
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
  // A credential that is not even shaped like a live core session (wrong algorithm,
  // expired, foreign issuer, malformed) is refused here instead of loading core with it.
  if (extractAuthorityHints(req.headers.authorization) === null) {
    throw new ApiError(401, "AUTH_INVALID", "The administrative session is invalid or expired");
  }
  next();
};

const configuredHints = (): string[] =>
  env.ADMIN_AUTHORITY_HINTS.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const denied = (required: string[]) =>
  new ApiError(
    403,
    "EDGE_AUTHORITY_DENIED",
    "The supplied administrative session does not carry the required authority",
    { required },
  );

/**
 * Edge authority guard (advisory, core re-verifies the signature and enforces the authority).
 *
 * It fails CLOSED: an unreadable, malformed, expired or wrongly signed-looking credential is
 * denied, and the optional `ADMIN_AUTHORITY_HINTS` list can only RESTRICT (a guard whose
 * required authorities are all missing from a configured list is denied, never skipped).
 * Authorities are compared case-sensitively; role names are compared upper-cased.
 *
 * The wildcard `*` is honoured because core grants it to its super administrators and
 * denying it here would lock them out; an unverified token that merely claims `*` still
 * reaches core, which verifies the signature and rejects it. It is therefore no bypass of the
 * real authority check.
 */
export const requireAuthorities =
  (...required: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      throw new ApiError(401, "AUTH_REQUIRED", "An administrative bearer token is required");
    }
    if (required.length === 0) {
      throw denied([]);
    }
    const configured = configuredHints();
    if (configured.length > 0 && !required.some((authority) => configured.includes(authority))) {
      throw denied(required);
    }
    const hints = extractAuthorityHints(authorization);
    if (!hints) {
      // Privileged resources must never be opened for a credential the edge cannot read.
      throw denied(required);
    }
    const roles = new Set(hints.roles.map((role) => role.toUpperCase()));
    const authorities = new Set(hints.authorities);
    const satisfied =
      authorities.has("*") ||
      required.some((authority) => {
        if (authorities.has(authority)) return true;
        const role = authority.toUpperCase();
        if (roles.has(role)) return true;
        return (ROLE_AUTHORITY_ALIASES[role] ?? []).some((alias) => authorities.has(alias));
      });
    if (!satisfied) throw denied(required);
    next();
  };

export interface MethodAuthoritySpec {
  /** Any-of list required for GET/HEAD/OPTIONS requests. */
  read: string[];
  /** Any-of list required for every other method. */
  write: string[];
  /** Paths (relative to the mount point) that are read-only operations sent as POST. */
  readPaths?: RegExp[];
}

/**
 * Mount-level edge guard mirroring the authority lists core enforces on the same routes
 * (`core-back/api/internal/admin.ts`). Reads and writes need different authorities.
 */
export const requireAuthoritiesByMethod = (spec: MethodAuthoritySpec) => {
  const readGuard = requireAuthorities(...spec.read);
  const writeGuard = requireAuthorities(...spec.write);
  return (req: Request, res: Response, next: NextFunction) => {
    const isRead =
      req.method === "GET" ||
      req.method === "HEAD" ||
      req.method === "OPTIONS" ||
      (spec.readPaths ?? []).some((pattern) => pattern.test(req.path));
    (isRead ? readGuard : writeGuard)(req, res, next);
  };
};
