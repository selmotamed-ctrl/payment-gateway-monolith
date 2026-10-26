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
] as const;

export const RAW_BODY_LIMIT = "25mb";

export const isRawBodyPath = (path: string): boolean =>
  RAW_BODY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const rawCollector = express.raw({
  type: () => true,
  limit: RAW_BODY_LIMIT,
});

export const rawBodyMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (!isRawBodyPath(request.path)) {
    next();
    return;
  }
  rawCollector(request, response, next);
};
