import express from "express";
import { z } from "zod";
import { zBaseVersion, zIdentifier, zJsonPatch, zPaginationQuery, zReason } from "../../lib/zReady";
import {
  toCoreMerchantClose,
  toCoreMerchantDescriptive,
  toCoreMerchantProposeEdit,
  toCoreMerchantReinstate,
  toCoreMerchantSuspend,
  toCoreMerchantWithdraw,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const MERCHANT_SUSPENSION_REASONS = [
  "AML",
  "FRAUD",
  "KYB_EXPIRED",
  "COMMISSION_CEILING",
  "MERCHANT_REQUEST",
  "OTHER",
] as const;

export const MERCHANT_CLOSE_REASONS = [
  "MERCHANT_REQUEST",
  "COMPLIANCE",
  "BUSINESS_CLOSED",
  "OTHER",
] as const;

export const suspendSchema = z
  .object({
    reasonCode: z.enum(MERCHANT_SUSPENSION_REASONS).optional(),
    reason: zReason.optional(),
    notes: z.string().max(2000).optional(),
    emergency: z.boolean().optional(),
    ratifyWithinHours: z.number().int().min(1).max(168).optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.reasonCode || value.reason), {
    message: "A suspension reason is required",
    path: ["reasonCode"],
  });

export const reinstateSchema = z
  .object({
    reason: zReason,
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

export const proposeEditSchema = z
  .object({
    reason: zReason,
    patch: zJsonPatch.min(1).max(200),
    baseVersion: zBaseVersion,
  })
  .strict();

export const descriptiveEditSchema = z
  .object({
    tradeName: z.string().min(2).max(200).optional(),
    displayName: z.string().max(200).optional(),
    logoUrl: z.string().url().max(500).optional(),
    supportEmail: z.string().email().max(160).optional(),
    supportPhone: z.string().min(6).max(40).optional(),
    baseVersion: zBaseVersion.optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict()
  .refine((value) => ["tradeName", "displayName", "logoUrl", "supportEmail", "supportPhone"].some((field) => value[field as keyof typeof value] !== undefined), {
    message: "At least one descriptive field is required",
    path: ["tradeName"],
  });

export const closeSchema = z
  .object({
    reasonCode: z.enum(MERCHANT_CLOSE_REASONS),
    notes: z.string().max(2000).optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

export const withdrawSchema = z
  .object({ reason: z.string().min(3).max(2000).optional() })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/merchants",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/merchants/summary",
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

for (const resource of ["transactions", "applications", "wallets", "cashouts", "disputes", "adjustments", "notifications", "audit-events"] as const) {
  router.get(
    `/:id/${resource}`,
    coreForward({
      method: "GET",
      path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/${resource}`,
      paramsSchema: idParamsSchema,
      querySchema: zPaginationQuery,
    }),
  );
}

router.get(
  "/:id/stats",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/stats`,
    paramsSchema: idParamsSchema,
    querySchema: zPaginationQuery,
  }),
);

router.patch(
  "/:id/descriptive",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/descriptive`,
    paramsSchema: idParamsSchema,
    schema: descriptiveEditSchema,
    bodyFrom: (_req, body) => toCoreMerchantDescriptive(body),
  }),
);

router.post(
  "/:id/suspend",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/suspend`,
    paramsSchema: idParamsSchema,
    schema: suspendSchema,
    bodyFrom: (_req, body) => toCoreMerchantSuspend(body),
    relayStatus: true,
  }),
);

router.post(
  "/:id/reinstate",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/reinstate`,
    paramsSchema: idParamsSchema,
    schema: reinstateSchema,
    bodyFrom: (_req, body) => toCoreMerchantReinstate(body),
    relayStatus: true,
  }),
);

router.post(
  "/:id/close",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/close`,
    paramsSchema: idParamsSchema,
    schema: closeSchema,
    bodyFrom: (_req, body) => toCoreMerchantClose(body),
    relayStatus: true,
  }),
);

router.get(
  "/:id/pending-changes",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/pending-changes`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/:id/pending-changes/:approvalId/withdraw",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/pending-changes/${encodeURIComponent(context.params.approvalId ?? "")}/withdraw`,
    paramsSchema: z.object({ id: zIdentifier, approvalId: zIdentifier }).strict(),
    schema: withdrawSchema,
    bodyFrom: (_req, body) => toCoreMerchantWithdraw(body),
  }),
);

router.post(
  "/:id/propose-edit",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/propose-edit`,
    paramsSchema: idParamsSchema,
    schema: proposeEditSchema,
    bodyFrom: (_req, body) => toCoreMerchantProposeEdit(body),
    // The edit is an approval request: core answers `202 Accepted`.
    relayStatus: true,
  }),
);

router.get(
  "/:id/detail-changes",
  coreForward({
    method: "GET",
    path: (context) =>
      `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/detail-changes`,
    paramsSchema: idParamsSchema,
  }),
);

export const merchantsRouter = router;
