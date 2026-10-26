import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
import { callCore } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import { zAttemptToken } from "../../lib/zReady";

const router = express.Router();

const paramsSchema = z.object({
  attemptToken: zAttemptToken,
});

const returnLimiter = rateLimiter({
  windowMs: 60_000,
  max: () => env.PAY_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many return callbacks, please retry later",
    });
  },
});

router.use(returnLimiter);

const buildStatusUrl = (attemptToken: string, reference: unknown): string => {
  const base = env.CHECKOUT_FRONT_BASE_URL.replace(/\/+$/, "");
  const statusPath = env.CHECKOUT_FRONT_STATUS_PATH.startsWith("/")
    ? env.CHECKOUT_FRONT_STATUS_PATH
    : `/${env.CHECKOUT_FRONT_STATUS_PATH}`;
  const params = new URLSearchParams();
  params.set("attempt_token", attemptToken);
  if (typeof reference === "string" && reference.length > 0) params.set("reference", reference);
  return `${base}${statusPath}?${params.toString()}`;
};

const handleReturn = async (req: Request, res: Response) => {
  const { attemptToken } = parseOrThrow(paramsSchema, req.params);
  const payload = await callCore<{ reference?: string }>({
    method: req.method === "GET" ? "GET" : "POST",
    path: `/internal/checkout/return/${encodeURIComponent(attemptToken)}`,
    body: req.method === "GET" ? undefined : { hint: "browser_return" },
    query:
      req.method === "GET"
        ? Object.fromEntries(
            Object.entries(req.query).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value] as const] : [],
            ),
          )
        : undefined,
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  });
  res.redirect(302, buildStatusUrl(attemptToken, payload?.reference));
};

router.get("/:attemptToken", handleReturn);
router.post("/:attemptToken", handleReturn);

export const returnRouter = router;
