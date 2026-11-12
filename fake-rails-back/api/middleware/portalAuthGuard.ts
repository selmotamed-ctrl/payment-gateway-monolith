import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { verifyJwt, type JwtPayload } from "../../lib/jwt";
import { consumeSseTicket } from "../../lib/tickets";

declare global {
  namespace Express {
    interface Request {
      tester?: JwtPayload;
    }
  }
}

const publicPaths = new Set(["/auth/login"]);

/**
 * The stateful-account control plane is used by `pg-core-sandbox` (shared
 * seeder token) and by the tester portal (tester JWT). Either credential is
 * accepted; anything else falls through to the JWT check.
 */
const CONTROL_PATHS = ["/accounts", "/checkout-helper"];

/**
 * Only the SSE stream may take a credential in the query string (EventSource cannot set
 * headers), and it is a 30s single-use `ticket`, never the session token (GAP-024).
 */
const TICKET_PATHS = new Set(["/transactions/stream"]);

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const constantTimeEquals = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right));

/**
 * Protects `/portal-api/*`. The login route and the hosted checkout simulator
 * are public (the payer is not a tester); the internal seeder routes
 * authenticate with the shared seeder token instead of a tester JWT.
 */
export const portalAuthGuard = (request: Request, _response: Response, next: NextFunction) => {
  const relative = request.path || "/";
  if (publicPaths.has(relative) || relative.startsWith("/hosted/")) {
    next();
    return;
  }
  if (relative.startsWith("/internal/")) {
    const token = request.header("x-fake-rails-seeder-token") ?? "";
    if (!token || !constantTimeEquals(token, env.FAKE_RAILS_SEEDER_TOKEN)) {
      next(new ApiError(401, "INVALID_SEEDER_TOKEN", "A valid X-Fake-Rails-Seeder-Token header is required"));
      return;
    }
    next();
    return;
  }

  if (CONTROL_PATHS.some((path) => relative === path || relative.startsWith(`${path}/`))) {
    const token = request.header("x-fake-rails-seeder-token") ?? "";
    if (token && constantTimeEquals(token, env.FAKE_RAILS_SEEDER_TOKEN)) {
      next();
      return;
    }
    // Fall through to the tester-session check below.
  }

  if (TICKET_PATHS.has(relative) && typeof request.query.ticket === "string") {
    if (!consumeSseTicket(request.query.ticket)) {
      next(new ApiError(401, "UNAUTHENTICATED", "The stream ticket is invalid, expired or already used"));
      return;
    }
    next();
    return;
  }

  const header = request.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const payload = token ? verifyJwt(token, env.FAKE_RAILS_JWT_SECRET) : null;
  if (!payload || payload.role !== "FAKE_RAILS_TESTER") {
    next(new ApiError(401, "UNAUTHENTICATED", "A valid tester session is required"));
    return;
  }
  request.tester = payload;
  next();
};
