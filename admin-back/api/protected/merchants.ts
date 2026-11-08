import express from "express";
import { z } from "zod";
import { zBaseVersion, zIdentifier, zJsonPatch, zPaginationQuery, zReason, zUuid } from "../../lib/zReady";
import {
  toCoreMerchantClose,
  toCoreMerchantDescriptive,
  toCoreMerchantProposeEdit,
  toCoreMerchantReinstate,
  toCoreMerchantSuspend,
  toCoreMerchantWithdraw,
} from "../contract";
import { coreForward } from "../forward";
import { encode, uuidParamsSchema } from "./mutationSchemas";

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
    checklist: z
      .array(
        z.enum([
          "IMPACT_REVIEWED",
          "REASON_DOCUMENTED",
          "NOTIFICATION_PLANNED",
          "WALLET_DISPUTE_CHECKED",
        ]),
      )
      .max(10)
      .optional(),
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
    checklist: z
      .array(
        z.enum([
          "COMPLIANCE_CLEARANCE_VERIFIED",
          "OUTSTANDING_ITEMS_RESOLVED",
          "WALLET_DISPUTE_CHECKED",
          "REASON_DOCUMENTED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const proposeEditSchema = z
  .object({
    reason: zReason,
    patch: zJsonPatch.min(1).max(200),
    baseVersion: zBaseVersion,
    checklist: z
      .array(
        z.enum([
          "PATCH_REVIEWED",
          "SOURCE_DOCUMENT_VERIFIED",
          "MAKER_REASON_DOCUMENTED",
          "CHECKER_SCOPE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const descriptiveEditSchema = z
  .object({
    tradeName: z.string().min(2).max(200).optional(),
    displayName: z.string().max(200).optional(),
    logoUrl: z
      .string()
      .url()
      .max(500)
      .refine((value) => ["https:", "http:"].includes(new URL(value).protocol), "must be an http(s) url")
      .optional(),
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
    checklist: z
      .array(
        z.enum([
          "BALANCE_ZERO_VERIFIED",
          "OPEN_DISPUTES_CLEARED",
          "CASHOUTS_CLEARED",
          "IRREVERSIBLE_ACKNOWLEDGED",
        ]),
      )
      .max(10)
      .optional(),
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
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/merchants/export",
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
  "/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/merchants/summary/export",
  }),
);

router.get(
  "/:id/summary/export",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/summary/export`,
    paramsSchema: idParamsSchema,
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

/**
 * Beneficial owners and KYB revalidation requests (core: `kyb:write` any-of `merchant:write`).
 * The owner body mirrors the join-request owner handlers; the national id is write-only.
 */
const ownerFields = {
  fullName: z.string().trim().min(2).max(160),
  fullNameEn: z.string().trim().min(2).max(160).optional(),
  identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
  identityNumber: z.string().trim().min(4).max(32),
  nationality: z.string().length(2).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ownershipPercent: z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/).optional(),
  role: z.enum(["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]).optional(),
  pepDeclared: z.boolean().optional(),
  position: z.string().trim().min(2).max(80).optional(),
};

export const beneficialOwnerCreateSchema = z.object(ownerFields).strict();

export const beneficialOwnerPatchSchema = z
  .object(ownerFields)
  .partial()
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "at least one field is required",
    path: ["fullName"],
  });

export const KYB_DOCUMENT_TYPES = [
  "COMMERCIAL_REGISTRY",
  "TAX_CERTIFICATE",
  "ARTICLES_OF_ASSOCIATION",
  "OWNER_ID",
  "SIGNATORY_ID",
  "PROOF_OF_ADDRESS",
  "BANK_LETTER",
  "SECTOR_LICENSE",
  "OTHER",
] as const;

export const merchantRevalidationSchema = z
  .object({
    docType: z.enum(KYB_DOCUMENT_TYPES),
    dueAt: z.string().trim().min(10).max(64),
    message: z.string().trim().min(3).max(1000),
    reasonCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const ownerParamsSchema = z.object({ id: zUuid, ownerId: zUuid }).strict();

router.get(
  "/:id/beneficial-owners",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/merchants/${encode(context.params.id)}/beneficial-owners`,
    paramsSchema: uuidParamsSchema,
  }),
);

router.post(
  "/:id/beneficial-owners",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encode(context.params.id)}/beneficial-owners`,
    paramsSchema: uuidParamsSchema,
    schema: beneficialOwnerCreateSchema,
    relayStatus: true,
  }),
);

router.patch(
  "/:id/beneficial-owners/:ownerId",
  coreForward({
    method: "PATCH",
    path: (context) =>
      `/internal/admin/merchants/${encode(context.params.id)}/beneficial-owners/${encode(context.params.ownerId)}`,
    paramsSchema: ownerParamsSchema,
    schema: beneficialOwnerPatchSchema,
    relayStatus: true,
  }),
);

router.delete(
  "/:id/beneficial-owners/:ownerId",
  coreForward({
    method: "DELETE",
    path: (context) =>
      `/internal/admin/merchants/${encode(context.params.id)}/beneficial-owners/${encode(context.params.ownerId)}`,
    paramsSchema: ownerParamsSchema,
    relayStatus: true,
  }),
);

router.post(
  "/:id/revalidations",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encode(context.params.id)}/revalidations`,
    paramsSchema: uuidParamsSchema,
    schema: merchantRevalidationSchema,
    relayStatus: true,
  }),
);

export const merchantsRouter = router;
