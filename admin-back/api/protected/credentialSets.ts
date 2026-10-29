import express from "express";
import { z } from "zod";
import { zIdentifier, zListQuery } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const credentialEntrySchema = z
  .object({
    key: z.string().min(1).max(64),
    type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
    value: z.string().max(4096),
    isSecret: z.boolean().optional(),
  })
  .strict();

export const credentialSetCreateSchema = z
  .object({
    gatewayCode: z.string().min(2).max(64),
    env: z.enum(["SANDBOX", "LIVE"]),
    ownerType: z.enum(["PLATFORM", "MERCHANT"]),
    ownerMerchantId: zIdentifier.optional(),
    externalMerchantId: z.string().min(2).max(120).optional(),
    settlementTarget: z.enum(["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]),
    entries: z.array(credentialEntrySchema).min(1).max(40),
  })
  .strict();

export const credentialSetUpdateSchema = z
  .object({
    entries: z.array(credentialEntrySchema).min(1).max(40),
  })
  .strict();

export const credentialSetVerifySchema = z
  .object({
    gatewayVersionId: zIdentifier.optional(),
  })
  .strict();

export const credentialSetRevokeSchema = z
  .object({
    reason: z.string().min(2).max(500).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/credential-sets",
    querySchema: zListQuery,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/credential-sets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/credential-sets",
    schema: credentialSetCreateSchema,
    status: 201,
  }),
);

router.put(
  "/:id",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/credential-sets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
    schema: credentialSetUpdateSchema,
  }),
);

router.post(
  "/:id/verify",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/credential-sets/${encodeURIComponent(context.params.id ?? "")}/verify`,
    paramsSchema: idParamsSchema,
    schema: credentialSetVerifySchema,
  }),
);

router.post(
  "/:id/revoke",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/credential-sets/${encodeURIComponent(context.params.id ?? "")}/revoke`,
    paramsSchema: idParamsSchema,
    schema: credentialSetRevokeSchema,
  }),
);

export const credentialSetsRouter = router;
