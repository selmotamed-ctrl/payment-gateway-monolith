import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();

const searchSchema = z
  .object({
    query: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(2).max(120)),
    types: z.array(z.string().min(1).max(64)).max(30).optional(),
    limit: z.number().int().min(1).max(10).optional().default(5),
  })
  .strict();

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 120;
const buckets = new Map<string, { count: number; resetAt: number }>();

const sessionKey = (request: Request): string => {
  const token =
    (typeof request.headers.authorization === "string" && request.headers.authorization) ||
    request.ip ||
    "anonymous";
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
};

const rateLimit = (request: Request, response: Response, next: NextFunction): void => {
  const now = Date.now();
  if (buckets.size > 2_000) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  const key = sessionKey(request);
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (current.count >= MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    response.setHeader("Retry-After", String(retryAfterSec));
    response.status(429).json({
      code: "SEARCH_RATE_LIMITED",
      message: "Too many search requests. Please wait a moment and try again.",
      retryAfterSec,
    });
    return;
  }

  current.count += 1;
  next();
};

const noStore = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
};

export const resetSearchRateLimiterForTests = (): void => {
  buckets.clear();
};

router.post(
  "/",
  noStore,
  rateLimit,
  coreForward({
    method: "POST",
    path: () => "/internal/admin/search",
    schema: searchSchema,
  }),
);

export const searchRouter = router;
export default searchRouter;
