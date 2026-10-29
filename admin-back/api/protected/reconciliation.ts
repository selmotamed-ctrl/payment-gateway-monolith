import express, { type Request, type Response } from "express";
import { z } from "zod";
import { zListQuery } from "../../lib/zReady";
import { parseOrThrow } from "../../lib/error";
import { zIdentifier, zPaginationQuery } from "../../lib/zReady";
import { toCoreReconciliationSourceCreate, toCoreReconciliationUpload } from "../contract";
import { coreForward } from "../forward";
import { forwardUpload, uploadSingle } from "../upload";

const router = express.Router();

export const sourceCreateSchema = z
  .object({
    code: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "invalid statement source code"),
    name: z.string().min(2).max(160),
    gatewayId: zIdentifier.optional(),
    fileType: z.enum(["CSV", "XLSX", "JSON"]),
    delimiter: z.enum([",", ";", "|", "\t"]).optional(),
    hasHeader: z.boolean().optional(),
    columnMapping: z.record(z.string().max(64), z.string().max(64)).optional(),
    dateFormat: z.string().max(64).optional(),
    active: z.boolean().optional(),
    // core requires the transport of a statement source and the public API cannot express it.
    type: z.enum(["API", "SFTP", "UPLOAD"]).optional(),
  })
  .strict();

export const uploadSchema = z
  .object({
    sourceId: zIdentifier,
    periodStart: z.string().max(64),
    periodEnd: z.string().max(64),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    autoPost: z.boolean().optional(),
  })
  .strict();

router.get(
  "/sources",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/reconciliation/sources",
    querySchema: zListQuery,
  }),
);

router.post(
  "/sources",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/reconciliation/sources",
    schema: sourceCreateSchema,
    bodyFrom: (_req, body) => toCoreReconciliationSourceCreate(body),
    status: 201,
  }),
);

router.post(
  "/upload",
  uploadSingle("statement"),
  async (req: Request, res: Response) => {
    const metadata = parseOrThrow(uploadSchema, req.body ?? {});
    const body = toCoreReconciliationUpload(metadata);
    // The statement file itself is forwarded as raw bytes so that `core-back`
    // can hash and parse the exact uploaded payload. The metadata travels in
    // the `x-upload-metadata` header.
    await forwardUpload(req, res, {
      path: "/internal/admin/reconciliation/upload",
      fileField: "statement",
      metadata,
      headers: { "x-statement-source-id": String(body.sourceId) },
    });
  },
);

router.get(
  "/runs",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/reconciliation/runs",
    querySchema: zPaginationQuery,
  }),
);

export const reconciliationRouter = router;
