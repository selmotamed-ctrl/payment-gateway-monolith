import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { env } from "../env";
import { parseCidrList, resolveClientIp } from "../net";

/** Client ip resolved through the trusted-proxy aware resolver (never a raw header). */
export const requestClientIp = (req: Request): string =>
  resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS));

/** Rate limiter key: the verified client ip (IPv6 grouped by /56) plus optional extra parts. */
export const rateLimitKey = (req: Request, ...parts: Array<string | undefined>): string => {
  const ip = ipKeyGenerator(requestClientIp(req) || "unknown");
  const extra = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return extra.length > 0 ? `${ip}|${extra.join("|")}` : ip;
};

/**
 * Builds a limiter on its first request. The environment is only guaranteed to be loaded
 * then (tests configure it after importing the app), and a limiter's window is fixed at
 * construction.
 */
export const lazyLimiter = (build: () => RequestHandler): RequestHandler => {
  let instance: RequestHandler | undefined;
  return (req, res, next) => {
    instance ??= build();
    return instance(req, res, next);
  };
};

/** Stable, non reversible short digest used to key limiters on secrets or identifiers. */
export const digestKeyPart = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
