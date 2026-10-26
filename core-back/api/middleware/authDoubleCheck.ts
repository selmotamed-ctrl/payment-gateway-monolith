import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import * as ipaddr from "ipaddr.js";
import { client } from "../../prisma/client";
import { ApiError } from "../../lib/error";
import { hashAccessToken, verifySessionToken } from "../../lib/auth";

export type PrincipalKind = "session" | "apiToken";

export interface Principal {
  kind: PrincipalKind;
  userId: string | null;
  role: string | null;
  merchantId: string | null;
  applicationId: string | null;
  authorities: string[];
  scopes: string[];
  tokenId: string | null;
  sessionId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export const parseAuthorities = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([authority]) => authority);
  }
  return [];
};

export const ipWithinCidr = (address: string, cidr: string): boolean => {
  try {
    const parsedAddress = ipaddr.parse(address);
    const [network, prefix] = cidr.split("/");
    if (!network) {
      return false;
    }
    const parsedNetwork = ipaddr.parse(network);
    const prefixLength = prefix === undefined ? parsedAddress.kind() === "ipv4" ? 32 : 128 : Number(prefix);
    if (parsedAddress.kind() !== parsedNetwork.kind()) {
      return false;
    }
    return parsedAddress.match(parsedNetwork, prefixLength);
  } catch {
    return false;
  }
};

export const ipAllowed = (address: string | null, cidrList: readonly string[]): boolean => {
  if (cidrList.length === 0) {
    return true;
  }
  if (!address) {
    return false;
  }
  return cidrList.some((cidr) => ipWithinCidr(address, cidr));
};

const bearerToken = (request: Request): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]?.trim() ?? null : null;
};

const clientIp = (request: Request): string | null => {
  const forwarded = request.headers["x-real-client-ip"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded;
  }
  return request.ip ?? request.socket.remoteAddress ?? null;
};

const resolveApiTokenPrincipal = async (token: string, request: Request): Promise<Principal> => {
  const tokenHash = hashAccessToken(token);
  const record = await client.accessToken.findUnique({
    where: { tokenHash },
    include: { ips: true },
  });
  if (!record) {
    throw new ApiError(401, "ACCESS_TOKEN_INVALID", "The supplied access token is not recognised");
  }
  if (record.revokedAt) {
    throw new ApiError(401, "ACCESS_TOKEN_REVOKED", "The supplied access token has been revoked");
  }
  const scopes = parseAuthorities(record.scopes);
  if (record.ipWhitelistEnabled) {
    const cidrs = record.ips.map((entry) => entry.cidr);
    if (!ipAllowed(clientIp(request), cidrs)) {
      throw new ApiError(403, "ACCESS_TOKEN_IP_NOT_ALLOWED", "The request origin is not allowed for this access token");
    }
  }
  await client.accessToken.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  return {
    kind: "apiToken",
    userId: null,
    role: "MERCHANT_API",
    merchantId: record.merchantId,
    applicationId: record.applicationId,
    authorities: scopes,
    scopes,
    tokenId: record.id,
    sessionId: null,
  };
};

const resolveSessionPrincipal = async (token: string): Promise<Principal> => {
  let claims;
  try {
    claims = verifySessionToken(token);
  } catch {
    throw new ApiError(401, "SESSION_INVALID", "The session token is invalid or expired");
  }
  const user = await client.user.findUnique({ where: { id: claims.sub } });
  if (!user) {
    throw new ApiError(401, "SESSION_USER_MISSING", "The session principal no longer exists");
  }
  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "SESSION_USER_INACTIVE", "The session principal is not active");
  }
  const authorities = parseAuthorities(user.authoritiesMap);
  if (authorities.length === 0) {
    throw new ApiError(403, "SESSION_AUTHORITIES_EMPTY", "The session principal has no granted authorities");
  }
  return {
    kind: "session",
    userId: user.id,
    role: user.role,
    merchantId: user.merchantId,
    applicationId: null,
    authorities,
    scopes: authorities,
    tokenId: null,
    sessionId: claims.sub,
  };
};

export const authenticate = async (request: Request): Promise<Principal> => {
  const token = bearerToken(request);
  if (!token) {
    throw new ApiError(401, "AUTH_REQUIRED", "A bearer token is required for this endpoint");
  }
  if (token.startsWith("pg_live_")) {
    return resolveApiTokenPrincipal(token, request);
  }
  return resolveSessionPrincipal(token);
};

export const requireAuthentication = async (
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    request.principal = await authenticate(request);
    next();
  } catch (error) {
    next(error);
  }
};

export const principalOf = (request: Request): Principal => {
  const principal = request.principal;
  if (!principal) {
    throw new ApiError(401, "AUTH_REQUIRED", "A bearer token is required for this endpoint");
  }
  return principal;
};

export const requireAuthorities = (request: Request, required: readonly string[]): Principal => {
  const principal = principalOf(request);
  if (required.length === 0) {
    return principal;
  }
  const granted = new Set(principal.authorities);
  const allowed = required.some((authority) => granted.has(authority) || granted.has("*"));
  if (!allowed) {
    throw new ApiError(403, "AUTHORITY_REQUIRED", "The principal lacks the required authority", {
      required,
    });
  }
  return principal;
};

export const requireMerchantScope = (request: Request, merchantId: string | null | undefined): Principal => {
  const principal = principalOf(request);
  if (!merchantId) {
    return principal;
  }
  if (principal.kind === "apiToken" && principal.merchantId !== merchantId) {
    throw new ApiError(403, "MERCHANT_SCOPE_VIOLATION", "The token is not bound to this merchant");
  }
  if (principal.merchantId && principal.merchantId !== merchantId) {
    throw new ApiError(403, "MERCHANT_SCOPE_VIOLATION", "The principal is not bound to this merchant");
  }
  return principal;
};

export const fingerprint = (parts: readonly (string | null | undefined)[]): string =>
  createHash("sha256").update(parts.filter((part): part is string => Boolean(part)).join("|"), "utf8").digest("hex");
