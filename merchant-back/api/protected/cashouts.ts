import express from "express";
import { z } from "zod";
import { zAmount, zCurrency, zIdentifier, zJsonObject } from "../../lib/zReady";
import { coreCashoutCreateSchema, toCoreCashoutCreate } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

export const cashoutCreateSchema = z
  .object({
    walletId: zIdentifier,
    amount: zAmount,
    currency: zCurrency,
    bankAccountId: zIdentifier.optional(),
    /** Canonical core field: the settlement account details of the merchant. */
    destinationBank: zJsonObject.optional(),
    reference: z.string().max(140).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

const cashoutQuerySchema = z
  .object({
    status: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED", "PROCESSING", "COMPLETED", "FAILED"]).optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/cashouts",
    querySchema: cashoutQuerySchema,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/cashouts",
    schema: cashoutCreateSchema,
    bodyMapper: toCoreCashoutCreate,
    coreSchema: coreCashoutCreateSchema,
    status: 201,
  }),
);

export const cashoutsRouter = router;
