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
  })
  .strict();

export const bulkInquireSchema = z
  .object({
    caseIds: z.array(zIdentifier).min(1).max(200),
    reason: z.string().max(500).optional(),
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
  "/operator-cases",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/operator-cases",
    querySchema: zPaginationQuery,
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
