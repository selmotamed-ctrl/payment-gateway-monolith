import express from "express";
import { z } from "zod";
import { zListQuery } from "../../lib/zReady";
import { coreForward } from "../forward";
import { encode, uuidParamsSchema, zMutationReason } from "./mutationSchemas";

const router = express.Router();

/** Only the containment/restoration transitions exist; PENDING and CLOSED are never operator choices. */
export const walletStatusSchema = z
  .object({
    status: z.enum(["FROZEN", "ACTIVE"]),
    reason: zMutationReason,
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/wallets",
    querySchema: zListQuery,
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/wallets/summary",
    querySchema: zListQuery,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/wallets/${encode(context.params.id)}`,
    paramsSchema: uuidParamsSchema,
  }),
);

router.post(
  "/:id/status",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/wallets/${encode(context.params.id)}/status`,
    paramsSchema: uuidParamsSchema,
    schema: walletStatusSchema,
    // FROZEN is immediate (200); FROZEN -> ACTIVE becomes an approval request (202).
    relayStatus: true,
  }),
);

export const walletsRouter = router;
