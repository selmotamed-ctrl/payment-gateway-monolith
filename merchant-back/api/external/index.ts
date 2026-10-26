import express, { type NextFunction, type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { zAmount, zCurrency, zIdentifier, zJsonObject } from "../../lib/zReady";
import { coreLinkCreateSchema } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const externalLimiter = rateLimiter({
  windowMs: 60_000,
  max: () => env.EXTERNAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many external API requests, please retry later",
    });
  },
});

export const requirePgLiveToken = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || !token.startsWith(env.PG_LIVE_TOKEN_PREFIX)) {
    throw new ApiError(401, "INVALID_API_TOKEN", "A valid pg_live_ bearer token is required");
  }
  next();
};

const linkCreateSchema = z
  .object({
    title: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    amount: zAmount,
    currency: zCurrency,
    feeBearer: z.enum(["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"]).optional(),
    expiresAt: z.string().max(64).optional(),
    maxUses: z.number().int().min(1).max(1000000).optional(),
    activeSlots: z.number().int().min(1).max(100000).optional(),
    allowedRails: z.array(z.string().min(1).max(64)).max(50).optional(),
    metadata: zJsonObject.optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

const linkKeyParamsSchema = z.object({ key: zIdentifier });

const paymentReferenceParamsSchema = z.object({ reference: zIdentifier });

const cancelSchema = z
  .object({
    reason: z.string().max(256).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

router.use(externalLimiter);
router.use(requirePgLiveToken);

router.post(
  "/links",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/external/links",
    schema: linkCreateSchema,
    coreSchema: coreLinkCreateSchema,
    status: 201,
  }),
);

router.get(
  "/links/:key",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/external/links/${encodeURIComponent(context.params.key ?? "")}`,
    paramsSchema: linkKeyParamsSchema,
  }),
);

router.post(
  "/links/:key/cancel",
  coreForward({
    method: "POST",
    path: (context) => `/internal/merchant/external/links/${encodeURIComponent(context.params.key ?? "")}/cancel`,
    paramsSchema: linkKeyParamsSchema,
    schema: cancelSchema,
  }),
);

router.get(
  "/payments/:reference",
  coreForward({
    method: "GET",
    path: (context) =>
      `/internal/merchant/external/payments/${encodeURIComponent(context.params.reference ?? "")}`,
    paramsSchema: paymentReferenceParamsSchema,
  }),
);

export const externalRouter = router;
