import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
import { callCore } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";

const router = express.Router();

const verifyLimiter = lazyLimiter(() => rateLimiter({
  windowMs: env.PAY_RATE_LIMIT_WINDOW_MS,
  max: () => env.PAY_RATE_LIMIT_MAX,
  keyGenerator: (req) => rateLimitKey(req, "certificate"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many certificate verification requests, please retry later",
    });
  },
}));

const paramsSchema = z.object({ publicId: z.string().min(16).max(64) });

router.get("/certificate/:publicId", verifyLimiter, async (req: Request, res: Response) => {
  const { publicId } = parseOrThrow(paramsSchema, req.params);
  res.setHeader("cache-control", "no-store");
  const payload = await callCore({
    method: "GET",
    path: `/internal/checkout/academy/certificates/${encodeURIComponent(publicId)}`,
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  });
  res.json(payload);
});

export const certificateRouter = router;
