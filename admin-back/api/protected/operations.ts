import express from "express";
import { z } from "zod";
import { zIdentifier, zJsonObject, zPaginationQuery, zReason } from "../../lib/zReady";
import { toCoreOperatorCaseResolve } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const resolveSchema = z
  .object({
    action: z.enum(["MARK_SUCCEEDED", "MARK_FAILED", "CLOSE_CASE"]),
    reason: zReason,
    notes: z.string().max(2000).optional(),
    providerReference: z.string().min(1).max(191).optional(),
    settledAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    checklist: z
      .array(
        z.enum([
          "EVIDENCE_REVIEWED",
          "ATTEMPT_STATUS_VERIFIED",
          "OUTCOME_DOCUMENTED",
          "CHECKER_REQUIREMENT_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const bulkInquireSchema = z
  .object({
    caseIds: z.array(zIdentifier).min(1).max(200),
    reason: z.string().max(500).optional(),
    checklist: z
      .array(
        z.enum([
          "ELIGIBILITY_REVIEWED",
          "ATTEMPT_STATUS_VERIFIED",
          "GATEWAY_SUPPORT_CONFIRMED",
          "INQUIRY_SCOPE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const bulkAssignSchema = z
  .object({
    caseIds: z.array(zIdentifier).min(1).max(200),
    assigneeUserId: zIdentifier.nullable(),
    reason: z.string().max(500).optional(),
    checklist: z
      .array(
        z.enum([
          "ASSIGNEE_VERIFIED",
          "WORKLOAD_REVIEWED",
          "NOTIFICATION_PLANNED",
          "CASE_SCOPE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const bulkStateSchema = z
  .object({
    caseIds: z.array(zIdentifier).min(1).max(200),
    state: z.enum(["OPEN", "IN_PROGRESS"]),
    reason: z.string().max(500).optional(),
    checklist: z
      .array(
        z.enum([
          "CASE_SCOPE_CONFIRMED",
          "STATE_IMPACT_REVIEWED",
          "SLA_IMPACT_REVIEWED",
          "NOTIFICATION_PLANNED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const gatewayInquiryCancelSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    checklist: z.array(z.string().min(1).max(64)).max(10).optional(),
  })
  .strict();

export const gatewayInquiryActionSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    checklist: z.array(z.string().min(1).max(64)).max(10).optional(),
  })
  .strict();

export const operatorCasePatchSchema = z
  .object({
    assigneeUserId: zIdentifier.nullable().optional(),
    state: z.enum(["OPEN", "IN_PROGRESS"]).optional(),
  })
  .strict();

const inquireSchema = z
  .object({
    force: z.boolean().optional(),
    reason: z.string().max(500).optional(),
    metadata: zJsonObject.optional(),
  })
  .strict();

router.get(
  "/gateway-inquiries",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/gateway-inquiries",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/gateway-inquiries/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/gateway-inquiries/summary",
  }),
);

router.get(
  "/gateway-inquiries/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/gateway-inquiries/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/gateway-inquiries/:id/cancel",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/gateway-inquiries/${encodeURIComponent(context.params.id ?? "")}/cancel`,
    paramsSchema: idParamsSchema,
    schema: gatewayInquiryCancelSchema,
    relayStatus: true,
  }),
);

router.post(
  "/gateway-inquiries/:id/run-now",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/gateway-inquiries/${encodeURIComponent(context.params.id ?? "")}/run-now`,
    paramsSchema: idParamsSchema,
    schema: gatewayInquiryActionSchema,
    relayStatus: true,
  }),
);

router.post(
  "/gateway-inquiries/:id/retry",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/gateway-inquiries/${encodeURIComponent(context.params.id ?? "")}/retry`,
    paramsSchema: idParamsSchema,
    schema: gatewayInquiryActionSchema,
    relayStatus: true,
  }),
);

router.get(
  "/operator-cases",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/operator-cases",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/operator-cases/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/operator-cases/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/operator-cases/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/operator-cases/summary",
  }),
);

router.post(
  "/operator-cases/bulk-inquire",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/operator-cases/bulk-inquire",
    schema: bulkInquireSchema,
  }),
);

router.post(
  "/operator-cases/bulk-assign",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/operator-cases/bulk-assign",
    schema: bulkAssignSchema,
  }),
);

router.post(
  "/operator-cases/bulk-state",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/operator-cases/bulk-state",
    schema: bulkStateSchema,
  }),
);

router.patch(
  "/operator-cases/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/operator-cases/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
    schema: operatorCasePatchSchema,
  }),
);

router.post(
  "/operator-cases/:id/resolve",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/operator-cases/${encodeURIComponent(context.params.id ?? "")}/resolve`,
    paramsSchema: idParamsSchema,
    schema: resolveSchema,
    bodyFrom: (_req, body) => toCoreOperatorCaseResolve(body),
    relayStatus: true,
  }),
);

router.get(
  "/operator-cases/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/operator-cases/summary/export",
  }),
);

router.get(
  "/operator-cases/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/operator-cases/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/attempts/:id/inquire",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/attempts/${encodeURIComponent(context.params.id ?? "")}/inquire`,
    paramsSchema: idParamsSchema,
    schema: inquireSchema,
  }),
);

router.get(
  "/attempts/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/attempts/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

export const operationsRouter = router;
