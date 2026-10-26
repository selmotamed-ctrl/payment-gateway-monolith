import express from "express";
import { z } from "zod";
import { zIdentifier, zJsonObject, zPaginationQuery, zReason } from "../../lib/zReady";
import { toCoreOperatorCaseResolve } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const resolveSchema = z
  .object({
    resolution: z.enum(["RETRY_INQUIRE", "MARK_SUCCEEDED", "MARK_FAILED", "ESCALATE", "RELEASE_RESERVATION"]),
    reason: zReason,
    notes: z.string().max(2000).optional(),
    operatorNote: z.string().max(2000).optional(),
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
  "/operator-cases/:id/resolve",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/operator-cases/${encodeURIComponent(context.params.id ?? "")}/resolve`,
    paramsSchema: idParamsSchema,
    schema: resolveSchema,
    bodyFrom: (_req, body) => toCoreOperatorCaseResolve(body),
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
