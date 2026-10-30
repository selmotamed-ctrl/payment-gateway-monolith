import type { NextFunction, Request, Response } from "express";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { verifyJwt, type JwtPayload } from "../../lib/jwt";

declare global {
  namespace Express {
    interface Request {
      tester?: JwtPayload;
    }
  }
}

const publicPaths = new Set(["/auth/login"]);

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
    if (!token || token !== env.FAKE_RAILS_SEEDER_TOKEN) {
      next(new ApiError(401, "INVALID_SEEDER_TOKEN", "A valid X-Fake-Rails-Seeder-Token header is required"));
      return;
    }
    next();
    return;
  }

  const header = request.header("authorization") ?? "";
  const queryToken = typeof request.query.token === "string" ? request.query.token : "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : queryToken;
  const payload = token ? verifyJwt(token, env.FAKE_RAILS_JWT_SECRET) : null;
  if (!payload || payload.role !== "FAKE_RAILS_TESTER") {
    next(new ApiError(401, "UNAUTHENTICATED", "A valid tester session is required"));
    return;
  }
  request.tester = payload;
  next();
};
