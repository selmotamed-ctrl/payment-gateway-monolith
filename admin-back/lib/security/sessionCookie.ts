import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../env";
import { ApiError } from "../error";
import { callCoreResponse } from "../mtlsClient";
import { parseCidrList, resolveClientIp } from "../net";
import { resolveRequestId } from "../requestLogger";

/**
 * Session cookie option for the admin edge (GAP-019).
 *
 * With `SESSION_COOKIE_MODE=true` the session token minted by core is never handed to
 * browser JavaScript: login/MFA responses set it as an `HttpOnly; SameSite=Strict` cookie
 * and the body carries `sessionCookie: true` instead of `token`. The edge turns the cookie
 * back into the `Authorization: Bearer` header it forwards to core, so core still verifies
 * the very same JWT (audience, revoke list). Unsafe methods authenticated by cookie must also
 * carry `x-pg-csrf: 1` (a custom header a cross-site form cannot send).
 * Bearer headers keep working unchanged when the mode is off or the caller sends one.
 */
export const SESSION_COOKIE_NAME = "pg_admin_session";
export const SESSION_COOKIE_PATH = "/api/v1/admin";
export const CSRF_HEADER = "x-pg-csrf";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

export const sessionCookieModeEnabled = (): boolean => env.SESSION_COOKIE_MODE === "true";

export const readSessionCookie = (req: Request): string | undefined => {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9._-]{20,4096}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
};

const cookieAttributes = (maxAgeSeconds: number): string =>
  [
    `Path=${SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(env.SESSION_COOKIE_SECURE === "false" ? [] : ["Secure"]),
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");

export const setSessionCookie = (res: Response, token: string): void => {
  res.append("Set-Cookie", `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(SESSION_COOKIE_MAX_AGE_SECONDS)}`);
};

export const clearSessionCookie = (res: Response): void => {
  res.append("Set-Cookie", `${SESSION_COOKIE_NAME}=; ${cookieAttributes(0)}`);
};

/** Turns the session cookie into the bearer header when the caller sent no Authorization. */
export const cookieSession: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  // A leftover cookie must not authenticate (or block a login with the CSRF
  // check) when the cookie mode is off.
  if (!sessionCookieModeEnabled()) {
    next();
    return;
  }
  if (req.headers.authorization) {
    next();
    return;
  }
  // Login/MFA are not authenticated by the cookie; a stale cookie must not
  // force the CSRF header on them (login would otherwise fail with 403).
  if (/(?:^|\/)(?:auth\/)?(?:login|mfa)$/.test(req.path)) {
    next();
    return;
  }
  const token = readSessionCookie(req);
  if (!token) {
    next();
    return;
  }
  const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (!safe && req.headers[CSRF_HEADER] !== "1") {
    next(new ApiError(403, "CSRF_HEADER_REQUIRED", "Cookie-authenticated writes must send the x-pg-csrf header"));
    return;
  }
  req.headers.authorization = `Bearer ${token}`;
  next();
};

/**
 * Mounted on login/MFA routes: in cookie mode moves `token` from the JSON body into the
 * httpOnly cookie.
 */
export const captureSessionToken: RequestHandler = (_req, res, next) => {
  if (!sessionCookieModeEnabled()) {
    next();
    return;
  }
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode < 400 && body && typeof body === "object" && typeof (body as { token?: unknown }).token === "string") {
      const { token, ...rest } = body as { token: string } & Record<string, unknown>;
      setSessionCookie(res, token);
      return json({ ...rest, sessionCookie: true });
    }
    return json(body);
  }) as Response["json"];
  next();
};

/**
 * Server-side logout: revokes the session in core, then always clears the cookie.
 * An already invalid/expired/revoked session (core 401) is a successful logout.
 */
export const logoutHandler = async (req: Request, res: Response): Promise<void> => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    clearSessionCookie(res);
    res.json({ revoked: false });
    return;
  }
  try {
    await callCoreResponse({
      method: "POST",
      path: "/internal/admin/auth/logout",
      body: {},
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
    });
  } catch (error) {
    clearSessionCookie(res);
    if (error instanceof ApiError && error.statusCode === 401) {
      res.json({ revoked: false });
      return;
    }
    throw error;
  }
  clearSessionCookie(res);
  res.json({ revoked: true });
};
