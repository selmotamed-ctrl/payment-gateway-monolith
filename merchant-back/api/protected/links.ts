import express from "express";
import { z } from "zod";
import { zAmount, zCurrency, zIdentifier, zJsonObject } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const linkParamsSchema = z.object({ id: zIdentifier });

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

const linkListQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"]).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const cancelSchema = z
  .object({
    reason: z.string().max(256).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/links",
    querySchema: linkListQuerySchema,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/links",
    schema: linkCreateSchema,
    status: 201,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/links/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: linkParamsSchema,
  }),
);

router.post(
  "/:id/cancel",
  coreForward({
    method: "POST",
    path: (context) => `/internal/merchant/links/${encodeURIComponent(context.params.id ?? "")}/cancel`,
    paramsSchema: linkParamsSchema,
    schema: cancelSchema,
  }),
);

router.get(
  "/:id/attempts",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/links/${encodeURIComponent(context.params.id ?? "")}/attempts`,
    paramsSchema: linkParamsSchema,
  }),
);

export const linksRouter = router;
