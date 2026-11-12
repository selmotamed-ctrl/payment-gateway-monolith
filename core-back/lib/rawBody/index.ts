import express, { type NextFunction, type Request, type Response } from "express";

/**
 * Endpoints that carry opaque binary payloads (gateway webhooks, KYB
 * documents, statement files) must receive the exact bytes that were sent:
 * a JSON body parser would consume them and destroy the signature material.
 * The raw collector is therefore mounted before the JSON parser.
 */
export const RAW_BODY_PATHS = [
  "/internal/checkout/inbound",
  "/internal/merchant/onboarding/kyb-documents",
  "/internal/admin/reconciliation/upload",
  "/internal/admin/assets/upload",
] as const;

/** Fallback for callers that do not use `rawBodyLimitFor` (kept for compatibility). */
export const RAW_BODY_LIMIT = "25mb";

const RAW_BODY_PATTERNS: ReadonlyArray<{ pattern: RegExp; limit: string }> = [
  { pattern: /^\/internal\/admin\/join-requests\/[^/]+\/kyb-documents$/, limit: "25mb" },
  { pattern: /^\/internal\/admin\/aml\/cases\/[^/]+\/evidence$/, limit: "50mb" },
  { pattern: /^\/internal\/admin\/disputes\/[^/]+\/attachments$/, limit: "25mb" },
  { pattern: /^\/internal\/merchant\/disputes\/[^/]+\/attachments$/, limit: "25mb" },
] as const;

const EXACT_LIMITS: Record<string, string> = {
  "/internal/admin/reconciliation/upload": "100mb",
  "/internal/admin/assets/upload": "5mb",
  "/internal/merchant/onboarding/kyb-documents": "25mb",
  "/internal/checkout/inbound": "25mb",
};

export const isRawBodyPath = (path: string): boolean =>
  RAW_BODY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  || RAW_BODY_PATTERNS.some((entry) => entry.pattern.test(path));

/** Per-endpoint limit so a small asset upload never shares the 100 MB statement budget. */
export const rawBodyLimitFor = (path: string): string => {
  if (EXACT_LIMITS[path]) return EXACT_LIMITS[path];
  const match = RAW_BODY_PATTERNS.find((entry) => entry.pattern.test(path));
  return match?.limit ?? RAW_BODY_LIMIT;
};

const collectors = new Map<string, ReturnType<typeof express.raw>>();
const collectorFor = (limit: string) => {
  let collector = collectors.get(limit);
  if (!collector) {
    collector = express.raw({ type: () => true, limit });
    collectors.set(limit, collector);
  }
  return collector;
};

export const rawBodyMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (!isRawBodyPath(request.path)) {
    next();
    return;
  }
  collectorFor(rawBodyLimitFor(request.path))(request, response, next);
};
