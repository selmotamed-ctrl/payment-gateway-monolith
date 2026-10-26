import express, { type Request, type Response } from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";
import { forwardUpload, uploadSingle } from "../upload";

const router = express.Router();

const disputeParamsSchema = z.object({ id: zIdentifier });

const disputeQuerySchema = z
  .object({
    status: z.enum(["PENDING_REVIEW", "ACCEPTED", "REJECTED", "WITHDRAWN", "RESOLVED"]).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    evidenceType: z.enum(["RECEIPT", "INVOICE", "DELIVERY_PROOF", "CORRESPONDENCE", "OTHER"]),
    notes: z.string().max(2000).optional(),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/disputes",
    querySchema: disputeQuerySchema,
  }),
);

router.post(
  "/:id/evidence",
  uploadSingle("evidence"),
  async (req: Request, res: Response) => {
    const metadata = evidenceSchema.parse(req.body ?? {});
    const id = disputeParamsSchema.parse(req.params).id;
    await forwardUpload(req, res, {
      path: `/internal/merchant/disputes/${encodeURIComponent(id)}/evidence`,
      fileField: "evidence",
      metadata,
    });
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
