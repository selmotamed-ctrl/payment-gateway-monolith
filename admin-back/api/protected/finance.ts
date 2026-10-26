import express from "express";
import { z } from "zod";
import { zAmount, zCurrency, zDateRangeQuery, zIdentifier, zPaginationQuery, zReason } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const disputeCreateSchema = z
  .object({
    merchantId: zIdentifier,
    gatewayId: zIdentifier.optional(),
    paymentReference: z.string().min(1).max(140),
    externalDisputeRef: z.string().min(1).max(140),
    type: z.enum(["CHARGEBACK", "REPRESENTMENT", "PRE_ARBITRATION", "REFUND_REQUEST"]),
    amount: zAmount,
    currency: zCurrency,
    reason: z.string().min(3).max(500),
    dueAt: z.string().max(64).optional(),
  })
  .strict();

const adjustmentCreateSchema = z
  .object({
    disputeId: zIdentifier.optional(),
    merchantId: zIdentifier,
    attemptId: zIdentifier.optional(),
    type: z.enum(["CHARGEBACK", "FEE_VARIANCE", "CORRECTION", "RECOVERY", "WRITEOFF"]),
    amount: zAmount,
    currency: zCurrency,
    reason: zReason,
    draft: z.boolean().optional(),
  })
  .strict();

const cashoutProcessSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "HOLD"]),
    reason: zReason.optional(),
    amount: zAmount.optional(),
    currency: zCurrency.optional(),
    executedBy: zIdentifier.optional(),
  })
  .strict();

const commissionProfileSchema = z
  .object({
    code: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "invalid commission profile code"),
    name: z.string().min(2).max(160),
    model: z.enum(["FLAT", "PERCENTAGE", "TIERED", "MIXED"]),
    percentage: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).optional(),
    flatAmount: zAmount.optional(),
    tiers: z.array(z.record(z.string().max(64), z.unknown())).max(20).optional(),
    currency: zCurrency.optional(),
    active: z.boolean().optional(),
  })
  .strict();

const velocityRuleSchema = z
  .object({
    code: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "invalid velocity rule code"),
    name: z.string().min(2).max(160),
    scope: z.enum(["MERCHANT", "APPLICATION", "LINK", "IP", "DEVICE"]),
    windowSeconds: z.number().int().min(1).max(86400),
    maxAttempts: z.number().int().min(1).max(100000),
    maxAmount: zAmount.optional(),
    currency: zCurrency.optional(),
    action: z.enum(["BLOCK", "REVIEW", "THROTTLE", "CHALLENGE"]),
    active: z.boolean().optional(),
  })
  .strict();

router.get(
  "/disputes",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/disputes",
    querySchema: zPaginationQuery,
  }),
);

router.post(
  "/disputes",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/disputes",
    schema: disputeCreateSchema,
    status: 201,
  }),
);

router.get(
  "/disputes/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/disputes/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.get(
  "/adjustments",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/adjustments",
    querySchema: zPaginationQuery,
  }),
);

router.post(
  "/adjustments",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/adjustments",
    schema: adjustmentCreateSchema,
    status: 201,
  }),
);

router.get(
  "/cashouts",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/cashouts",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/cashouts/:id/process",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/cashouts/${encodeURIComponent(context.params.id ?? "")}/process`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/cashouts/:id/process",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/cashouts/${encodeURIComponent(context.params.id ?? "")}/process`,
    paramsSchema: idParamsSchema,
    schema: cashoutProcessSchema,
  }),
);

router.get(
  "/commission-profiles",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/commission-profiles",
  }),
);

router.post(
  "/commission-profiles",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/commission-profiles",
    schema: commissionProfileSchema,
    status: 201,
  }),
);

router.get(
  "/velocity-rules",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/velocity-rules",
  }),
);

router.post(
  "/velocity-rules",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/velocity-rules",
    schema: velocityRuleSchema,
    status: 201,
  }),
);

router.get(
  "/finance/profitability",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/profitability",
    querySchema: zDateRangeQuery,
  }),
);

router.get(
  "/finance/liquidity",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/liquidity",
    querySchema: zDateRangeQuery,
  }),
);

router.get(
  "/finance/invariant-check",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/invariant-check",
  }),
);

export const financeRouter = router;
