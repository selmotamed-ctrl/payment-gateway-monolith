import express from "express";
import { z } from "zod";
import { zBaseVersion, zIdentifier, zJsonPatch, zPaginationQuery, zReason } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const suspendSchema = z
  .object({
    reason: zReason,
    emergency: z.boolean().optional(),
    ratifyWithinHours: z.number().int().min(1).max(168).optional(),
  })
  .strict();

const reinstateSchema = z
  .object({
    reason: zReason,
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

const proposeEditSchema = z
  .object({
    reason: zReason,
    patch: zJsonPatch.min(1).max(200),
    baseVersion: zBaseVersion,
  })
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
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/:id/suspend",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/suspend`,
    paramsSchema: idParamsSchema,
    schema: suspendSchema,
  }),
);

router.post(
  "/:id/reinstate",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/reinstate`,
    paramsSchema: idParamsSchema,
    schema: reinstateSchema,
  }),
);

router.post(
  "/:id/propose-edit",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/merchants/${encodeURIComponent(context.params.id ?? "")}/propose-edit`,
    paramsSchema: idParamsSchema,
    schema: proposeEditSchema,
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
