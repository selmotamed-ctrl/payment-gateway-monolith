import type { NextFunction, Request, Response } from "express";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";

export interface AuthorityHints {
  roles: string[];
  authorities: string[];
}

const decodeSegment = (segment: string): string | null => {
  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

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
  const roles: string[] = [];
  if (Array.isArray(candidate.roles)) {
    for (const role of candidate.roles) {
      if (typeof role === "string") roles.push(role);
    }
  }
  const authorities: string[] = [];
  const authorityMap = candidate.authorities_map;
  if (typeof authorityMap === "object" && authorityMap !== null) {
    for (const value of Object.values(authorityMap as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") authorities.push(entry);
        }
      }
    }
  }
  if (Array.isArray(candidate.authorities)) {
    for (const entry of candidate.authorities) {
      if (typeof entry === "string") authorities.push(entry);
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
      next();
      return;
    }
    const granted = [...hints.roles, ...hints.authorities];
    if (!expected.some((authority) => granted.includes(authority))) {
      throw new ApiError(
        403,
        "EDGE_AUTHORITY_DENIED",
        "The supplied administrative session does not carry the required authority",
        { required: expected },
      );
    }
    next();
  };
