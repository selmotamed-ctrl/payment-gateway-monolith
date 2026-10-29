import express from "express";
import { z } from "zod";
import { zIdentifier, zPaginationQuery, zReason } from "../../lib/zReady";
import {
  toCoreJoinRequestAssign,
  toCoreJoinRequestDecide,
  toCoreJoinRequestRequestInfo,
  toCoreKybDocumentReview,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const assignSchema = z
  .object({
    assigneeUserId: zIdentifier,
    dueAt: z.string().max(64).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const requestInfoSchema = z
  .object({
    requestedItems: z.array(z.string().min(1).max(160)).min(1).max(50),
    message: z.string().min(3).max(2000),
    dueAt: z.string().max(64).optional(),
  })
  .strict();

export const decideSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "APPROVED", "REJECTED", "REQUEST_INFO", "WITHDRAW"]),
    reason: zReason.optional(),
    reasonCode: z.string().max(64).optional(),
    notes: z.string().max(4000).optional(),
    checklist: z.record(z.string().max(64), z.boolean()).optional(),
    proposedRiskTier: z.enum(["LOW", "STANDARD", "HIGH"]).optional(),
    checkerUserId: zIdentifier.optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.reason || value.reasonCode), {
    message: "a reason or reasonCode is required",
    path: ["reason"],
  });

export const kybReviewSchema = z
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
    bodyFrom: (_req, body) => toCoreJoinRequestAssign(body),
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
    bodyFrom: (_req, body) => toCoreJoinRequestRequestInfo(body),
  }),
);

router.post(
  "/:id/decide",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/decide`,
    paramsSchema: idParamsSchema,
    schema: decideSchema,
    bodyFrom: (_req, body) => toCoreJoinRequestDecide(body),
    // An approval that needs four eyes is queued: core answers `202 Accepted`.
    relayStatus: true,
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
    bodyFrom: (_req, body) => toCoreKybDocumentReview(body),
  }),
);
