import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { callCore } from "../../lib/mtlsClient";
import { zIdentifier, assertAllowedUpload } from "../../lib/zReady";
import {
  MAX_EVIDENCE_FILE_BYTES,
  coreDisputeEvidenceSchema,
  toCoreDisputeEvidence,
} from "../contract";
import { coreCallContext, coreForward, requireBearer } from "../forward";
import { uploadSingleAny } from "../upload";

const router = express.Router();

const disputeParamsSchema = z.object({ id: zIdentifier });

const disputeQuerySchema = z
  .object({
    status: z.enum(["PENDING_REVIEW", "ACCEPTED", "REJECTED", "WITHDRAWN", "RESOLVED"]).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .passthrough();

export const evidenceSchema = z
  .object({
    evidenceType: z.enum(["RECEIPT", "INVOICE", "DELIVERY_PROOF", "CORRESPONDENCE", "OTHER"]).optional(),
    notes: z.string().max(2000).optional(),
    note: z.string().max(2000).optional(),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  })
  .strict();

const allowedUploadMimes = (): string[] =>
  env.UPLOAD_ALLOWED_MIME.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/disputes",
    querySchema: disputeQuerySchema,
  }),
);

/**
 * The uploaded document is forwarded as a canonical JSON payload
 * (`{ evidence, notes? }`), core-back expects a JSON body here.
 */
router.post(
  "/:id/evidence",
  uploadSingleAny(["evidence", "file"]),
  async (req: Request, res: Response): Promise<void> => {
    requireBearer(req);
    const metadata = parseOrThrow(evidenceSchema, req.body ?? {});
    const id = parseOrThrow(disputeParamsSchema, req.params).id;
    const file = req.file;
    if (!file) {
      throw new ApiError(400, "UPLOAD_REQUIRED", "An evidence document file is required in the evidence field");
    }
    const detected = assertAllowedUpload(
      file.buffer,
      file.mimetype,
      allowedUploadMimes(),
      env.MAX_UPLOAD_BYTES,
    );
    if (file.buffer.byteLength > MAX_EVIDENCE_FILE_BYTES) {
      throw new ApiError(
        413,
        "UPLOAD_TOO_LARGE",
        "The evidence document is too large to be forwarded to core",
        { maxBytes: MAX_EVIDENCE_FILE_BYTES, receivedBytes: file.buffer.byteLength },
      );
    }
    const body = parseOrThrow(
      coreDisputeEvidenceSchema,
      toCoreDisputeEvidence(file, { ...metadata, notes: metadata.notes ?? metadata.note }, detected),
    );
    const payload = await callCore({
      ...coreCallContext(req),
      method: "POST",
      path: `/internal/merchant/disputes/${encodeURIComponent(id)}/evidence`,
      body,
    });
    res.status(200).json(payload);
  },
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/disputes/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: disputeParamsSchema,
  }),
);

export const disputesRouter = router;
