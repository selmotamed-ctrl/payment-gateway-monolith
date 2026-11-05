import cors from "cors";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../env";

/**
 * Basic security headers (a hand written subset of what helmet sets; no extra dependency).
 * Every response is non-sniffable, never framed, never leaks the referrer and is not cached
 * by default (individual routes may override `cache-control`).
 */
export const securityHeaders: RequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (!res.hasHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
  next();
};

const allowedOrigins = (): string[] =>
  env.CORS_ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter((value) => value.length > 0);

/**
 * The public pay page is served from another origin, so with an empty `CORS_ALLOWED_ORIGINS`
 * the checkout API stays reachable cross-origin. It never uses cookies or credentials, so
 * credentials are never allowed; a non empty list restricts the origins to exactly that list.
 */
export const corsAllowList = (): RequestHandler => {
  const handler = cors({
    origin: (origin, callback) => {
      const list = allowedOrigins();
      callback(null, origin !== undefined && list.includes(origin));
    },
    credentials: false,
  });
  const permissive = cors({ origin: true, credentials: false });
  return (req, res, next) => {
    (allowedOrigins().length === 0 ? permissive : handler)(req, res, next);
  };
};
