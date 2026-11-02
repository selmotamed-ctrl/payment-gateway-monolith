import express from "express";
import { z } from "zod";
import { zAmount, zCurrency, zIdentifier, zJsonObject, zPaginationQuery, zReason } from "../../lib/zReady";
import {
  toCoreAdjustmentCreate,
  toCoreCashoutProcess,
  toCoreCommissionProfileCreate,
  toCoreDisputeCreate,
  toCoreVelocityRuleCreate,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const financePeriodQuerySchema = z
  .object({
    period: z.enum(["today", "last_7d", "last_30d", "last_90d"]).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    currency: zCurrency.optional(),
  })
  .strict();

export const disputeCreateSchema = z
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
    // core requires the rail, the gateway and the ingestion source of a dispute and the
    // public API cannot always express them.
    railId: zIdentifier.optional(),
    source: z.enum(["WEBHOOK", "STATEMENT", "MANUAL"]).optional(),
  })
  .strict();

export const disputeEvidenceSchema = z
  .object({
    evidence: zJsonObject,
    notes: z.string().max(2000).optional(),
    checklist: z
      .array(
        z.enum([
          "EVIDENCE_REFERENCE_VERIFIED",
          "SUPPORTING_DOCUMENTS_ATTACHED",
          "EVIDENCE_WINDOW_VERIFIED",
          "SUMMARY_REVIEWED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const adjustmentCreateSchema = z
  .object({
    disputeId: zIdentifier.optional(),
    merchantId: zIdentifier.optional(),
    attemptId: zIdentifier.optional(),
    type: z.enum(["CHARGEBACK", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION", "FEE_VARIANCE", "RECOVERY", "WRITEOFF"]),
    amount: zAmount,
    currency: zCurrency.optional(),
    reason: zReason.optional(),
    reasonCode: z.string().max(64).optional(),
    notes: z.string().max(2000).optional(),
    reverseCommission: z.boolean().optional(),
    draft: z.boolean().optional(),
    targetGlAccountId: zIdentifier,
    checklist: z
      .array(
        z.enum([
          "TARGET_ACCOUNT_VERIFIED",
          "AMOUNT_CURRENCY_VERIFIED",
          "REASON_DOCUMENTED",
          "SOURCE_LINKAGE_VERIFIED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.reason || value.reasonCode), {
    message: "a reason or reasonCode is required",
    path: ["reason"],
  });

export const cashoutProcessSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "HOLD"]),
    reason: zReason.optional(),
    amount: zAmount.optional(),
    currency: zCurrency.optional(),
    executedBy: zIdentifier.optional(),
    checklist: z
      .array(
        z.enum([
          "BANK_DETAILS_VERIFIED",
          "WALLET_BALANCE_VERIFIED",
          "MERCHANT_ACTIVE",
          "NO_AML_RESTRICTIONS",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const commissionProfileSchema = z
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
    // core binds every commission profile to a rail code that the public API does not carry.
    railCode: z.string().min(1).max(64).optional(),
  })
  .strict();

export const velocityRuleSchema = z
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
    // core scopes a rule to an end client dimension that the public scope vocabulary cannot
    // always express (a device scope has no canonical counterpart).
    scopeType: z
      .enum([
        "END_CLIENT_IP",
        "END_CLIENT_PHONE",
        "END_CLIENT_CARD",
        "MERCHANT",
        "APPLICATION",
        "RAIL",
        "LINK",
      ])
      .optional(),
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
    bodyFrom: (_req, body) => toCoreDisputeCreate(body),
    // The intake is a queued job: core answers `202 Accepted` with the job id.
    relayStatus: true,
  }),
);

router.get(
  "/disputes/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/disputes/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/disputes/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/disputes/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/disputes/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/disputes/summary/export",
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

router.post(
  "/disputes/:id/evidence",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/disputes/${encodeURIComponent(context.params.id ?? "")}/evidence`,
    paramsSchema: idParamsSchema,
    schema: disputeEvidenceSchema,
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

router.get(
  "/adjustments/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/adjustments/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/adjustments/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/adjustments/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/adjustments/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/adjustments/summary/export",
  }),
);

router.get(
  "/adjustments/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/adjustments/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/adjustments",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/adjustments",
    schema: adjustmentCreateSchema,
    bodyFrom: (_req, body) => toCoreAdjustmentCreate(body),
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
  "/cashouts/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/cashouts/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/cashouts/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/cashouts/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/cashouts/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/cashouts/summary/export",
  }),
);

router.get(
  "/cashouts/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/cashouts/${encodeURIComponent(context.params.id ?? "")}`,
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
    bodyFrom: (_req, body) => toCoreCashoutProcess(body),
  }),
);

router.get(
  "/commission-profiles",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/commission-profiles",
  }),
);

router.get(
  "/commission-profiles/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/commission-profiles/summary",
  }),
);

router.post(
  "/commission-profiles",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/commission-profiles",
    schema: commissionProfileSchema,
    bodyFrom: (_req, body) => toCoreCommissionProfileCreate(body),
    status: 201,
  }),
);

export const commissionProfileExpireSchema = z
  .object({
    effectiveTo: z.string().max(64).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

router.get(
  "/commission-profiles/:id/history",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/commission-profiles/${encodeURIComponent(context.params.id ?? "")}/history`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/commission-profiles/:id/expire",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/commission-profiles/${encodeURIComponent(context.params.id ?? "")}/expire`,
    paramsSchema: idParamsSchema,
    schema: commissionProfileExpireSchema,
    relayStatus: true,
  }),
);

router.get(
  "/velocity-rules",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/velocity-rules",
  }),
);

export const velocityRuleDeactivateSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();

router.get(
  "/velocity-rules/:id/history",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/velocity-rules/${encodeURIComponent(context.params.id ?? "")}/history`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/velocity-rules/:id/deactivate",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/velocity-rules/${encodeURIComponent(context.params.id ?? "")}/deactivate`,
    paramsSchema: idParamsSchema,
    schema: velocityRuleDeactivateSchema,
    relayStatus: true,
  }),
);

router.get(
  "/velocity-rules/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/velocity-rules/summary",
  }),
);

router.post(
  "/velocity-rules",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/velocity-rules",
    schema: velocityRuleSchema,
    bodyFrom: (_req, body) => toCoreVelocityRuleCreate(body),
    status: 201,
  }),
);

router.get(
  "/finance/profitability",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/profitability",
    querySchema: financePeriodQuerySchema,
  }),
);

router.get(
  "/finance/profitability/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/profitability/export",
    querySchema: financePeriodQuerySchema,
  }),
);

router.get(
  "/finance/liquidity",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/liquidity",
    querySchema: financePeriodQuerySchema,
  }),
);

router.get(
  "/finance/liquidity/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/liquidity/export",
    querySchema: financePeriodQuerySchema,
  }),
);

router.get(
  "/finance/invariant-check/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/finance/invariant-check/export",
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
