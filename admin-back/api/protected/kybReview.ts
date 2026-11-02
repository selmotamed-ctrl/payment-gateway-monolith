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
  const contentType = upstream.headers["content-type"];
  const contentDisposition = upstream.headers["content-disposition"];
  const cacheControl = upstream.headers["cache-control"];
  if (typeof contentType === "string") res.setHeader("Content-Type", contentType);
  if (typeof contentDisposition === "string") res.setHeader("Content-Disposition", contentDisposition);
  if (typeof cacheControl === "string") res.setHeader("Cache-Control", cacheControl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(upstream.statusCode).send(upstream.body);
});

export const kybReviewRouter = router;
