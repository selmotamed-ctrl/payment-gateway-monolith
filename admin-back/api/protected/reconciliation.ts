import express, { type Request, type Response } from "express";
import { z } from "zod";
import { parseOrThrow } from "../../lib/error";
import { zIdentifier, zPaginationQuery } from "../../lib/zReady";
import { coreForward } from "../forward";
import { forwardUpload, uploadSingle } from "../upload";

const router = express.Router();

const sourceCreateSchema = z
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
  })
  .strict();

const uploadSchema = z
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
  }),
);

router.post(
  "/sources",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/reconciliation/sources",
    schema: sourceCreateSchema,
    status: 201,
  }),
);

router.post(
  "/upload",
  uploadSingle("statement"),
  async (req: Request, res: Response) => {
    const metadata = parseOrThrow(uploadSchema, req.body ?? {});
    await forwardUpload(req, res, {
      path: "/internal/admin/reconciliation/upload",
      fileField: "statement",
      metadata,
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
