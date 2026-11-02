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
    checklist: z
      .array(
        z.enum([
          "SOURCE_VERIFIED",
          "FILE_REVIEWED",
          "PERIOD_VERIFIED",
          "DUPLICATE_CHECK_ACKNOWLEDGED",
        ]),
      )
      .max(10)
      .optional(),
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

export const sourcePatchSchema = z
  .object({
    scheduleCron: z.string().max(120).nullable().optional(),
    settlementLagDays: z.number().int().min(0).max(365).optional(),
    dedupeKeyTemplate: z.string().max(200).nullable().optional(),
    parserConfig: z.record(z.string().max(64), z.unknown()).optional(),
    active: z.boolean().optional(),
    checklist: z
      .array(
        z.enum([
          "PARSER_CONFIG_REVIEWED",
          "SCHEDULE_LAG_VERIFIED",
          "DEDUPE_TEMPLATE_REVIEWED",
          "SOURCE_IMPACT_REVIEWED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.scheduleCron !== undefined ||
      value.settlementLagDays !== undefined ||
      value.dedupeKeyTemplate !== undefined ||
      value.parserConfig !== undefined ||
      value.active !== undefined,
    { message: "At least one field is required" },
  );

router.patch(
  "/sources/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/reconciliation/sources/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: z.object({ id: zIdentifier }).strict(),
    schema: sourcePatchSchema,
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
  "/runs/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/reconciliation/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/runs/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/reconciliation/summary/export",
  }),
);

router.get(
  "/runs/:id/export",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/reconciliation/runs/${encodeURIComponent(context.params.id ?? "")}/export`,
    paramsSchema: z.object({ id: zIdentifier }).strict(),
    querySchema: zListQuery,
  }),
);

router.get(
  "/runs/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/reconciliation/runs/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: z.object({ id: zIdentifier }).strict(),
    querySchema: zListQuery,
  }),
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
