import express from "express";
import { z } from "zod";
import { zIdentifier, zJsonObject } from "../../lib/zReady";
import {
  coreCredentialSetCreateSchema,
  coreCredentialSetUpdateSchema,
  toCoreCredentialSetCreate,
  toCoreCredentialSetUpdate,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const credentialSetParamsSchema = z.object({ id: zIdentifier });

const credentialEntrySchema = z.object({
  key: z.string().min(1).max(64),
  type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
  value: z.string().max(4096),
  isSecret: z.boolean().default(true),
});

export const credentialCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    gatewayId: zIdentifier.optional(),
    environment: z.enum(["sandbox", "test", "uat", "live"]).optional(),
    ownership: z.enum(["MERCHANT_DIRECT", "PLATFORM_MANAGED"]).optional(),
    authMethod: z
      .enum([
        "NONE",
        "API_KEY",
        "PERMANENT_TOKEN",
        "TOKEN_ENDPOINT",
        "REFRESH_TOKEN",
        "USERNAME_PASSWORD",
        "BASIC",
        "REQUEST_SIGNATURE",
        "OAUTH2_CLIENT_CREDENTIALS",
        "MUTUAL_TLS",
      ])
      .optional(),
    secrets: zJsonObject.optional(),
    settings: zJsonObject.optional(),
    /** Canonical core fields, accepted next to the portal vocabulary. */
    gatewayCode: z.string().min(2).max(64).optional(),
    env: z.enum(["SANDBOX", "LIVE"]).optional(),
    externalMerchantId: z.string().min(2).max(120).optional(),
    settlementTarget: z.enum(["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]).optional(),
    entries: z.array(credentialEntrySchema).min(1).max(40).optional(),
  })
  .strict();

export const credentialUpdateSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    secrets: zJsonObject.optional(),
    settings: zJsonObject.optional(),
    entries: z.array(credentialEntrySchema).min(1).max(40).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/credential-sets",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/credential-sets",
    schema: credentialCreateSchema,
    bodyMapper: toCoreCredentialSetCreate,
    coreSchema: coreCredentialSetCreateSchema,
    status: 201,
  }),
);

router.put(
  "/:id",
  coreForward({
    method: "PUT",
    path: (context) =>
      `/internal/merchant/credential-sets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: credentialSetParamsSchema,
    schema: credentialUpdateSchema,
    bodyMapper: toCoreCredentialSetUpdate,
    coreSchema: coreCredentialSetUpdateSchema,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) =>
      `/internal/merchant/credential-sets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: credentialSetParamsSchema,
  }),
);

export const credentialSetsRouter = router;
