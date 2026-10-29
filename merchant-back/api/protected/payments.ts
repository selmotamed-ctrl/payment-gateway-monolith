import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const paymentQuerySchema = z
  .object({
    linkId: zIdentifier.optional(),
    status: z
      .enum([
        "CREATED",
        "INITIATING",
        "AWAITING_CUSTOMER",
        "AUTHORIZING",
        "VERIFYING",
        "UNKNOWN",
        "SUCCEEDED",
        "FAILED",
        "EXPIRED",
        "CANCELLED",
        "BLOCKED",
        "PARTIALLY_REFUNDED",
        "REFUNDED",
        "DISPUTED",
      ])
      .optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .passthrough();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/payments",
    querySchema: paymentQuerySchema,
  }),
);

export const paymentsRouter = router;
