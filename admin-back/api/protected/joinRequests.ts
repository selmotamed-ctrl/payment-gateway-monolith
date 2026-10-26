import express from "express";
import { z } from "zod";
import { zIdentifier, zPaginationQuery, zReason } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const assignSchema = z
  .object({
    assigneeUserId: zIdentifier,
    dueAt: z.string().max(64).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

const requestInfoSchema = z
  .object({
    requestedItems: z.array(z.string().min(1).max(160)).min(1).max(50),
    message: z.string().min(3).max(2000),
    dueAt: z.string().max(64).optional(),
  })
  .strict();

const decideSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_INFO", "WITHDRAW"]),
    reason: zReason,
    notes: z.string().max(2000).optional(),
    checkerUserId: zIdentifier.optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

const kybReviewSchema = z
  .object({
    decision: z.enum(["ACCEPT", "REJECT", "REQUEST_INFO"]),
    checklist: z.array(z.string().min(1).max(160)).max(50).optional(),
    notes: z.string().max(2000).optional(),
    documentType: z.string().max(64).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/join-requests",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/:id/assign",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/assign`,
    paramsSchema: idParamsSchema,
    schema: assignSchema,
  }),
);

router.post(
  "/:id/request-info",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/request-info`,
    paramsSchema: idParamsSchema,
    schema: requestInfoSchema,
  }),
);

router.post(
  "/:id/decide",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/decide`,
    paramsSchema: idParamsSchema,
    schema: decideSchema,
  }),
);

export const joinRequestsRouter = router;

export const kybRouter = express.Router();

kybRouter.post(
  "/kyb-documents/:id/review",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/kyb-documents/${encodeURIComponent(context.params.id ?? "")}/review`,
    paramsSchema: idParamsSchema,
    schema: kybReviewSchema,
  }),
);
