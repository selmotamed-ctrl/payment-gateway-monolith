import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward, coreProxyStream } from "../forward";

const router = express.Router();

const terminalParamsSchema = z.object({ id: zIdentifier });
const screenParamsSchema = z.object({ screenCode: zIdentifier });

const terminalCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    applicationId: zIdentifier.optional(),
    location: z.string().max(160).optional(),
    deviceId: z.string().max(128).optional(),
  })
  .strict();

const terminalPatchSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    location: z.string().max(160).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();

const screenCreateSchema = z
  .object({
    label: z.string().min(1).max(120),
    mode: z.enum(["CASHIER", "CUSTOMER"]).optional(),
    ttlSeconds: z.number().int().min(60).max(3600).optional(),
  })
  .strict();

router.get(
  "/terminals",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/pos/terminals",
  }),
);

router.post(
  "/terminals",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/pos/terminals",
    schema: terminalCreateSchema,
    status: 201,
  }),
);

router.patch(
  "/terminals/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/merchant/pos/terminals/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: terminalParamsSchema,
    schema: terminalPatchSchema,
  }),
);

router.post(
  "/terminals/:id/screens",
  coreForward({
    method: "POST",
    path: (context) => `/internal/merchant/pos/terminals/${encodeURIComponent(context.params.id ?? "")}/screens`,
    paramsSchema: terminalParamsSchema,
    schema: screenCreateSchema,
    status: 201,
  }),
);

router.get(
  "/screens/:screenCode/stream",
  coreProxyStream({
    method: "GET",
    path: (context) =>
      `/internal/merchant/pos/screens/${encodeURIComponent(context.params.screenCode ?? "")}/stream`,
    paramsSchema: screenParamsSchema,
  }),
);

router.get(
  "/terminals/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/pos/terminals/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: terminalParamsSchema,
  }),
);

export const posRouter = router;
