import express from "express";
import { z } from "zod";
import { zBaseVersion, zIdentifier, zJsonPatch, zPaginationQuery, zReason } from "../../lib/zReady";
import {
  toCoreMerchantProposeEdit,
  toCoreMerchantReinstate,
  toCoreMerchantSuspend,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const suspendSchema = z
  .object({
    reason: zReason,
    emergency: z.boolean().optional(),
    ratifyWithinHours: z.number().int().min(1).max(168).optional(),
  })
  .strict();

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
    bodyFrom: (_req, body) => toCoreMerchantSuspend(body),
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
