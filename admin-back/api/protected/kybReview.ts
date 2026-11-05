import express, { type Request, type Response } from "express";
import { z } from "zod";
import { zIdentifier, zPaginationQuery } from "../../lib/zReady";
import { ApiError, parseOrThrow } from "../../lib/error";
import { env } from "../../lib/env";
import {
  callCoreRaw,
  callCoreResponse,
  mapCoreHttpError,
  parseJsonBuffer,
} from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import { coreForward } from "../forward";
import {
  toCoreKybDocumentReplacement,
  toCoreKybDocumentRevalidation,
  toCoreKybDocumentReview,
} from "../contract";

const router = express.Router();

const KYB_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);

/** Always `attachment`; keeps core's file name only when it is a plain safe token. */
const safeAttachmentDisposition = (upstream: string | string[] | undefined, id: string): string => {
  const raw = typeof upstream === "string" ? upstream : "";
  const match = /filename="?([A-Za-z0-9._-]{1,120})"?/.exec(raw);
  const name = match?.[1] ?? `kyb-document-${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
  return `attachment; filename="${name}"`;
};
const idParamsSchema = z.object({ id: zIdentifier });

export const kybReviewSchema = z
  .object({
    decision: z.enum(["ACCEPT", "REJECT", "ACCEPTED", "REJECTED"]),
    reasonCode: z.string().min(2).max(64).optional(),
    notes: z.string().max(2000).optional(),
    checklist: z.array(z.string().min(1).max(160)).max(50).optional(),
    duplicateJustification: z.string().max(4000).optional(),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export const kybReplacementSchema = z
  .object({
    reasonCode: z.string().min(2).max(64).optional(),
    message: z.string().min(5).max(2000),
  })
  .strict();

export const kybRevalidationSchema = z
  .object({
    reasonCode: z.string().min(2).max(64).optional(),
    message: z.string().min(5).max(2000),
    dueAt: z.string().datetime().optional(),
  })
  .strict();

const coreCallContext = (req: Request) => ({
  requestId: resolveRequestId(req),
  clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
  userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  authorization: req.headers.authorization,
});

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/kyb-documents",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/kyb-documents/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/kyb-documents/summary",
  }),
);

router.get(
  "/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/kyb-documents/summary/export",
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/kyb-documents/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/:id/review",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/kyb-documents/${encodeURIComponent(context.params.id ?? "")}/review`,
    paramsSchema: idParamsSchema,
    schema: kybReviewSchema,
    bodyFrom: (_req, body) => toCoreKybDocumentReview(body),
  }),
);

router.post(
  "/:id/request-replacement",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/kyb-documents/${encodeURIComponent(context.params.id ?? "")}/request-replacement`,
    paramsSchema: idParamsSchema,
    schema: kybReplacementSchema,
    bodyFrom: (_req, body) => toCoreKybDocumentReplacement(body),
  }),
);

router.post(
  "/:id/request-revalidation",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/kyb-documents/${encodeURIComponent(context.params.id ?? "")}/request-revalidation`,
    paramsSchema: idParamsSchema,
    schema: kybRevalidationSchema,
    bodyFrom: (_req, body) => toCoreKybDocumentRevalidation(body),
    relayStatus: true,
  }),
);

router.get("/:id/content", async (req: Request, res: Response): Promise<void> => {
  const { id } = parseOrThrow(idParamsSchema, req.params);
  const upstream = await callCoreRaw({
    method: "GET",
    path: `/internal/admin/kyb-documents/${encodeURIComponent(id)}/content`,
    ...coreCallContext(req),
  });
  if (upstream.statusCode >= 400) {
    throw mapCoreHttpError(upstream.statusCode, parseJsonBuffer(upstream.body));
  }
  // The stored document is untrusted content: it is only ever served as a download, in a
  // sandbox, with a content type from a fixed allow-list (anything else is octet-stream).
  const contentType = upstream.headers["content-type"];
  const baseType = typeof contentType === "string" ? (contentType.split(";")[0] ?? "").trim().toLowerCase() : "";
  res.setHeader("Content-Type", KYB_CONTENT_TYPES.has(baseType) ? baseType : "application/octet-stream");
  res.setHeader("Content-Disposition", safeAttachmentDisposition(upstream.headers["content-disposition"], id));
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(upstream.statusCode).send(upstream.body);
});

export const kybReviewRouter = router;
