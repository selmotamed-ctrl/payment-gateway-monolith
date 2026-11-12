import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zIdentifier, zPaginationQuery, zReason } from "../../lib/zReady";
import {
  toCoreJoinRequestAssign,
  toCoreJoinRequestDecide,
  toCoreJoinRequestRequestInfo,
} from "../contract";
import { coreForward } from "../forward";
import { callCoreResponse } from "../../lib/mtlsClient";
import { env } from "../../lib/env";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import { uploadGuards, uploadSingle } from "../upload";
import { assertAllowedUpload } from "../../lib/zReady";
import { ApiError, parseOrThrow } from "../../lib/error";

const router = express.Router();

const KYB_ALLOWED_MIME = ["image/png", "image/jpeg", "application/pdf"];

const kybUploadFieldsSchema = z
  .object({
    documentType: z.string().regex(/^[A-Za-z0-9_]{2,64}$/).default("OTHER"),
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => !Number.isNaN(Date.parse(value)), "must be a calendar date")
      .optional(),
  })
  .strict();

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

const adminAssistedSchema = z.record(z.string(), z.unknown());
const ownerParamsSchema = z.object({ id: zIdentifier, ownerId: zIdentifier }).strict();
const documentParamsSchema = z.object({ id: zIdentifier, docId: zIdentifier }).strict();
const checklistSchema = z.object({ items: z.record(z.string().max(80), z.boolean()) }).strict();

const coreCallContext = (req: Request) => ({
  requestId: resolveRequestId(req),
  clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
  userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  authorization: req.headers.authorization,
  plane: String(req.headers["x-pg-env"] ?? "").trim().toUpperCase() === "SANDBOX" ? "SANDBOX" as const : undefined,
});

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/join-requests",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/join-requests/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/join-requests/summary",
  }),
);

router.get(
  "/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/join-requests/summary/export",
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
  "/admin-assisted",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/join-requests/admin-assisted",
    schema: adminAssistedSchema,
    relayStatus: true,
  }),
);

router.patch(
  "/:id/profile",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/profile`,
    paramsSchema: idParamsSchema,
    schema: adminAssistedSchema,
  }),
);

router.post(
  "/:id/beneficial-owners",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/beneficial-owners`,
    paramsSchema: idParamsSchema,
    schema: adminAssistedSchema,
    relayStatus: true,
  }),
);

router.patch(
  "/:id/beneficial-owners/:ownerId",
  coreForward({
    method: "PATCH",
    path: (context) =>
      `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/beneficial-owners/${encodeURIComponent(context.params.ownerId ?? "")}`,
    paramsSchema: ownerParamsSchema,
    schema: adminAssistedSchema,
  }),
);

router.delete(
  "/:id/beneficial-owners/:ownerId",
  coreForward({
    method: "DELETE",
    path: (context) =>
      `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/beneficial-owners/${encodeURIComponent(context.params.ownerId ?? "")}`,
    paramsSchema: ownerParamsSchema,
  }),
);

router.post(
  "/:id/kyb-documents",
  ...uploadGuards,
  uploadSingle("file"),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      throw new ApiError(400, "UPLOAD_REQUIRED", "A KYB document file is required");
    }
    const fields = parseOrThrow(kybUploadFieldsSchema, {
      documentType: req.body?.documentType,
      expiresOn: req.body?.expiresOn,
    });
    // Same content sniffing the statement uploads get: declared type, size and magic bytes.
    const detectedType = assertAllowedUpload(file.buffer, file.mimetype, KYB_ALLOWED_MIME, env.MAX_UPLOAD_BYTES);
    const metadata = {
      documentType: fields.documentType,
      fileName: file.originalname.slice(0, 255),
      expiresOn: fields.expiresOn,
    };
    const result = await callCoreResponse({
      method: "POST",
      path: `/internal/admin/join-requests/${encodeURIComponent(String(req.params.id ?? ""))}/kyb-documents`,
      rawBody: file.buffer,
      rawContentType: "application/octet-stream",
      headers: {
        "x-upload-content-type": detectedType,
        "x-upload-sha256": createHash("sha256").update(file.buffer).digest("hex"),
        "x-upload-size": String(file.buffer.byteLength),
        "x-upload-metadata": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
      },
      ...coreCallContext(req),
    });
    res.status(result.status).json(result.body);
  },
);

router.delete(
  "/:id/kyb-documents/:docId",
  coreForward({
    method: "DELETE",
    path: (context) =>
      `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/kyb-documents/${encodeURIComponent(context.params.docId ?? "")}`,
    paramsSchema: documentParamsSchema,
  }),
);

router.post(
  "/:id/submit",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/submit`,
    paramsSchema: idParamsSchema,
    schema: z.record(z.string(), z.unknown()),
  }),
);

router.post(
  "/:id/withdraw",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/withdraw`,
    paramsSchema: idParamsSchema,
    schema: z.record(z.string(), z.unknown()),
  }),
);

router.patch(
  "/:id/checklist",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/checklist`,
    paramsSchema: idParamsSchema,
    schema: checklistSchema,
  }),
);

router.post(
  "/:id/screening/retry",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/join-requests/${encodeURIComponent(context.params.id ?? "")}/screening/retry`,
    paramsSchema: idParamsSchema,
    schema: z.record(z.string(), z.unknown()),
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
