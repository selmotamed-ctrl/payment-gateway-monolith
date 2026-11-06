import express, { type NextFunction, type Request, type Response } from "express";
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
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .passthrough();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/cashouts",
    querySchema: cashoutQuerySchema,
  }),
);

/** core requires an idempotency key: accept it as the body field or as an Idempotency-Key header. */
const idempotencyKeyFromHeader = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header("idempotency-key");
  const body = req.body as Record<string, unknown> | undefined;
  if (header !== undefined && body && typeof body === "object" && body.idempotencyKey === undefined) {
    body.idempotencyKey = header;
  }
  next();
};

router.post(
  "/",
  idempotencyKeyFromHeader,
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
