import express, { type NextFunction, type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { digestKeyPart, lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { zAmount, zCurrency, zIdentifier, zJsonObject } from "../../lib/zReady";
import { coreLinkCreateSchema } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const limited = (_req: Request, res: Response) => {
  res.status(429).json({
    code: "RATE_LIMITED",
    message: "Too many external API requests, please retry later",
  });
};

const tokenOf = (req: Request): string => (req.headers.authorization ?? "").split(" ")[1] ?? "";

/** Per token (hashed) AND client ip: one integration cannot burn another one's budget. */
const externalLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.EXTERNAL_RATE_LIMIT_WINDOW_MS,
    max: () => env.EXTERNAL_RATE_LIMIT_MAX,
    keyGenerator: (req) => rateLimitKey(req, digestKeyPart(tokenOf(req))),
    standardHeaders: true,
    legacyHeaders: false,
    handler: limited,
  }),
);

/** Coarse per ip ceiling over all tokens, so spraying random tokens does not evade the limit. */
const externalClientLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.EXTERNAL_RATE_LIMIT_WINDOW_MS,
    max: () => env.EXTERNAL_RATE_LIMIT_MAX * 5,
    keyGenerator: (req) => rateLimitKey(req),
    standardHeaders: false,
    legacyHeaders: false,
    handler: limited,
  }),
);

/** Core issues `<prefix>` + base64url(32 random bytes): 43 url safe characters. */
const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Edge format check (the edge cannot validate the token itself; core does). Anything that is
 * not shaped like an issued token is refused without loading core.
 */
export const requirePgLiveToken = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? "";
  const parts = header.split(" ");
  const [scheme, token] = parts;
  if (
    parts.length !== 2 ||
    scheme?.toLowerCase() !== "bearer" ||
    !token ||
    !token.startsWith(env.PG_LIVE_TOKEN_PREFIX) ||
    !TOKEN_BODY_PATTERN.test(token.slice(env.PG_LIVE_TOKEN_PREFIX.length))
  ) {
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

router.use(externalClientLimiter);
router.use(requirePgLiveToken);
router.use(externalLimiter);

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
