import express from "express";
import { z } from "zod";
import { zIdentifier, zJsonObject } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const credentialSetParamsSchema = z.object({ id: zIdentifier });

const credentialCreateSchema = z
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
  })
  .strict();

const credentialUpdateSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    secrets: zJsonObject.optional(),
    settings: zJsonObject.optional(),
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
