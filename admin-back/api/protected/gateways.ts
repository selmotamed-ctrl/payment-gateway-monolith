import express from "express";
import { z } from "zod";
import { zBaseVersion, zConfigDocument, zGatewayCode, zIdentifier, zJsonObject } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const gatewayParamsSchema = z.object({ id: zIdentifier });
const versionParamsSchema = z.object({ vid: zIdentifier });

const gatewayCreateSchema = z
  .object({
    code: zGatewayCode,
    name: z.string().min(2).max(160),
    description: z.string().max(2000).optional(),
    category: z.string().min(2).max(64).optional(),
    country: z.string().min(2).max(2).optional(),
    evidenceLevel: z.enum(["VERIFIED", "PARTIAL", "INTERNAL"]).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const gatewayPatchSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    description: z.string().max(2000).optional(),
    category: z.string().min(2).max(64).optional(),
    evidenceLevel: z.enum(["VERIFIED", "PARTIAL", "INTERNAL"]).optional(),
    active: z.boolean().optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

const versionCreateSchema = z
  .object({
    version: z.coerce.number().int().min(1).max(100000),
    basedOnVersionId: zIdentifier.optional(),
    changelog: z.string().max(2000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const environmentsSchema = z
  .object({
    environments: z
      .array(
        z
          .object({
            code: z.string().min(2).max(32),
            baseUrl: z.string().min(1).max(300),
            active: z.boolean().optional(),
            timeoutMs: z.number().int().min(100).max(120000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .catchall(z.unknown());

const authSchema = z
  .object({
    authMethod: z.enum([
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
    ]),
    credentialSetId: zIdentifier.optional(),
    settings: zJsonObject.optional(),
  })
  .catchall(z.unknown());

const settingsSchema = z
  .object({
    settings: zJsonObject.optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(),
    retries: z.number().int().min(0).max(10).optional(),
  })
  .catchall(z.unknown());

const cryptoProfilesSchema = z
  .object({
    cryptoProfiles: z
      .array(
        z
          .object({
            code: z.string().min(2).max(64),
            algorithm: z.enum(["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "PLAIN", "NONE"]),
            encoding: z.enum(["HEX_UPPER", "HEX_LOWER", "BASE64", "RAW", "SORTED_KEY_VALUE_AMP", "TIMESTAMP_DOT_RAW_BODY", "SORTED_VALUES_HASH"]),
            secretRef: z.string().max(128).optional(),
            fields: z.array(z.string().max(64)).max(50).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .catchall(z.unknown());

const flowsSchema = z
  .object({
    flows: z
      .array(
        z
          .object({
            code: z.string().min(2).max(64),
            name: z.string().min(2).max(160),
            phases: z.array(z.string().min(2).max(64)).max(30).optional(),
            steps: z.array(zJsonObject).max(200).optional(),
            amountPipeline: z.array(zJsonObject).max(50).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .catchall(z.unknown());

const channelsSchema = z
  .object({
    clientActions: z.array(zJsonObject).max(20).optional(),
    confirmationChannels: z.array(zJsonObject).max(20).optional(),
    pollPolicies: z.array(zJsonObject).max(20).optional(),
  })
  .catchall(z.unknown());

const statusRulesSchema = z
  .object({
    statusRules: z.array(zJsonObject).min(1).max(100),
  })
  .catchall(z.unknown());

const errorMapsSchema = z
  .object({
    errorMaps: z.array(zJsonObject).min(1).max(100),
  })
  .catchall(z.unknown());

const dryRunSchema = z
  .object({
    scenario: z.string().min(2).max(64),
    payload: zJsonObject.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const runSuiteSchema = z
  .object({
    suite: z.enum(["SANDBOX_15", "CONTRACT_AMOUNT", "CONTRACT_REFERENCE", "CONTRACT_SIGNATURE"]),
    environment: z.enum(["sandbox", "test", "uat", "live"]).optional(),
  })
  .strict();

const submitApprovalSchema = z
  .object({
    reason: z.string().min(3).max(500),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

const rollbackSchema = z
  .object({
    targetVersionId: zIdentifier,
    reason: z.string().min(3).max(500),
  })
  .strict();

export const gatewaysRouter = router;

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/gateways",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/gateways",
    schema: gatewayCreateSchema,
    status: 201,
  }),
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/gateways/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: gatewayParamsSchema,
    schema: gatewayPatchSchema,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/gateways/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: gatewayParamsSchema,
  }),
);

router.post(
  "/:id/rollback",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/gateways/${encodeURIComponent(context.params.id ?? "")}/rollback`,
    paramsSchema: gatewayParamsSchema,
    schema: rollbackSchema,
  }),
);

router.get(
  "/:id/versions",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/gateways/${encodeURIComponent(context.params.id ?? "")}/versions`,
    paramsSchema: gatewayParamsSchema,
  }),
);

router.post(
  "/:id/versions",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/gateways/${encodeURIComponent(context.params.id ?? "")}/versions`,
    paramsSchema: gatewayParamsSchema,
    schema: versionCreateSchema,
    status: 201,
  }),
);

const versionRouter = express.Router();

versionRouter.put(
  "/:vid/environments",
  coreForward({
    method: "PUT",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/environments`,
    paramsSchema: versionParamsSchema,
    schema: environmentsSchema,
  }),
);

versionRouter.put(
  "/:vid/auth",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/auth`,
    paramsSchema: versionParamsSchema,
    schema: authSchema,
  }),
);

versionRouter.put(
  "/:vid/settings",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/settings`,
    paramsSchema: versionParamsSchema,
    schema: settingsSchema,
  }),
);

versionRouter.put(
  "/:vid/crypto-profiles",
  coreForward({
    method: "PUT",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/crypto-profiles`,
    paramsSchema: versionParamsSchema,
    schema: cryptoProfilesSchema,
  }),
);

versionRouter.put(
  "/:vid/flows",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/flows`,
    paramsSchema: versionParamsSchema,
    schema: flowsSchema,
  }),
);

versionRouter.put(
  "/:vid/channels",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/channels`,
    paramsSchema: versionParamsSchema,
    schema: channelsSchema,
  }),
);

versionRouter.put(
  "/:vid/status-rules",
  coreForward({
    method: "PUT",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/status-rules`,
    paramsSchema: versionParamsSchema,
    schema: statusRulesSchema,
  }),
);

versionRouter.put(
  "/:vid/error-maps",
  coreForward({
    method: "PUT",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/error-maps`,
    paramsSchema: versionParamsSchema,
    schema: errorMapsSchema,
  }),
);

versionRouter.post(
  "/:vid/dry-run",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/dry-run`,
    paramsSchema: versionParamsSchema,
    schema: dryRunSchema,
  }),
);

versionRouter.post(
  "/:vid/run-suite",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/run-suite`,
    paramsSchema: versionParamsSchema,
    schema: runSuiteSchema,
  }),
);

versionRouter.post(
  "/:vid/submit-approval",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/submit-approval`,
    paramsSchema: versionParamsSchema,
    schema: submitApprovalSchema,
  }),
);

export const gatewayVersionsRouter = versionRouter;
export const gatewayConfigDocumentSchema = zConfigDocument;
