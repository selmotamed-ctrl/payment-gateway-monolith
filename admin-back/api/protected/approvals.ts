import express from "express";
import { z } from "zod";
import { zIdentifier, zPaginationQuery, zReason } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const decisionSchema = z
  .object({
    reason: zReason,
    checkerUserId: zIdentifier.optional(),
    baseVersion: z.number().int().min(1).optional(),
    comment: z.string().max(2000).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/approvals",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/approvals/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/:id/approve",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/approvals/${encodeURIComponent(context.params.id ?? "")}/approve`,
    paramsSchema: idParamsSchema,
    schema: decisionSchema,
  }),
);

router.post(
  "/:id/reject",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/approvals/${encodeURIComponent(context.params.id ?? "")}/reject`,
    paramsSchema: idParamsSchema,
    schema: decisionSchema,
  }),
);

export const approvalsRouter = router;
