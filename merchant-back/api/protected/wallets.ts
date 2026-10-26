import express from "express";
import { z } from "zod";
import { zAmount, zCurrency, zIdentifier, zJsonObject, zMonth } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const walletParamsSchema = z.object({ id: zIdentifier });

const walletCreateSchema = z
  .object({
    applicationId: zIdentifier,
    label: z.string().min(2).max(120),
    currency: zCurrency,
    openingAmount: zAmount.optional(),
  })
  .strict();

const statementQuerySchema = z
  .object({
    month: zMonth.optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/wallets",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/wallets",
    schema: walletCreateSchema,
    status: 201,
  }),
);

router.get(
  "/:id/balance",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/wallets/${encodeURIComponent(context.params.id ?? "")}/balance`,
    paramsSchema: walletParamsSchema,
  }),
);

router.get(
  "/:id/statements",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/wallets/${encodeURIComponent(context.params.id ?? "")}/statements`,
    paramsSchema: walletParamsSchema,
    querySchema: statementQuerySchema,
  }),
);

router.get(
  "/:id/statements/:month/export",
  coreForward({
    method: "GET",
    path: (context) =>
      `/internal/merchant/wallets/${encodeURIComponent(context.params.id ?? "")}/statements/${encodeURIComponent(context.params.month ?? "")}/export`,
    paramsSchema: z.object({ id: zIdentifier, month: zMonth }),
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/wallets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: walletParamsSchema,
  }),
);

export const walletsRouter = router;
export const walletMetadataSchema = zJsonObject;
