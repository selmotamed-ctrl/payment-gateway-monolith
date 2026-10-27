import express from "express";
import { z } from "zod";
import { zBaseVersion, zConfigDocument, zGatewayCode, zIdentifier, zJsonObject } from "../../lib/zReady";
import {
  toCoreGatewayCreate,
  toCoreGatewayRollback,
  toCoreGatewayUpdate,
  toCoreGatewayVersionAuth,
  toCoreGatewayVersionChannels,
  toCoreGatewayVersionCryptoProfiles,
  toCoreGatewayVersionCreate,
  toCoreGatewayVersionDryRun,
  toCoreGatewayVersionEnvironments,
  toCoreGatewayVersionErrorMaps,
  toCoreGatewayVersionFlows,
  toCoreGatewayVersionRunSuite,
  toCoreGatewayVersionSettings,
  toCoreGatewayVersionStatusRules,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const gatewayParamsSchema = z.object({ id: zIdentifier });
const versionParamsSchema = z.object({ vid: zIdentifier });

export const gatewayCreateSchema = z
  .object({
    code: zGatewayCode,
    name: z.string().min(2).max(160),
    description: z.string().max(2000).optional(),
    category: z.string().min(2).max(64).optional(),
    country: z.string().min(2).max(2).optional(),
    evidenceLevel: z.enum(["VERIFIED", "PARTIAL", "INTERNAL"]).optional(),
    active: z.boolean().optional(),
    // core requires an operator and a gateway kind: they are accepted optionally so the
    // existing frontend payloads keep working and are translated into core defaults.
    operator: z.string().min(2).max(160).optional(),
    kind: z.enum(["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]).optional(),
    aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
    riskClass: z.enum(["NORMAL", "HIGH_RISK"]).optional(),
  })
  .strict();

export const gatewayPatchSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    description: z.string().max(2000).optional(),
    category: z.string().min(2).max(64).optional(),
    evidenceLevel: z.enum(["VERIFIED", "PARTIAL", "INTERNAL"]).optional(),
    active: z.boolean().optional(),
    baseVersion: zBaseVersion.optional(),
    operator: z.string().min(2).max(160).optional(),
    aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
    riskClass: z.enum(["NORMAL", "HIGH_RISK"]).optional(),
  })
  .strict();

export const versionCreateSchema = z
  .object({
    version: z.coerce.number().int().min(1).max(100000),
    basedOnVersionId: zIdentifier.optional(),
    changelog: z.string().max(2000).optional(),
    active: z.boolean().optional(),
    snapshot: zJsonObject.optional(),
  })
  .strict();

export const environmentsSchema = z
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
    env: z.enum(["SANDBOX", "LIVE"]).optional(),
  })
  .catchall(z.unknown());

export const authSchema = z
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
    env: z.enum(["SANDBOX", "LIVE"]).optional(),
    authApply: z.enum(["HEADER", "QUERY", "BODY"]).optional(),
  })
  .catchall(z.unknown());

export const settingsSchema = z
  .object({
    settings: zJsonObject.optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(),
    retries: z.number().int().min(0).max(10).optional(),
  })
  .catchall(z.unknown());

export const cryptoProfilesSchema = z
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
            purpose: z.enum(["OUTBOUND_SIGN", "INBOUND_VERIFY"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .catchall(z.unknown());

export const flowsSchema = z
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

export const channelsSchema = z
  .object({
    clientActions: z.array(zJsonObject).max(20).optional(),
    confirmationChannels: z.array(zJsonObject).max(20).optional(),
    pollPolicies: z.array(zJsonObject).max(20).optional(),
  })
  .catchall(z.unknown());

export const statusRulesSchema = z
  .object({
    statusRules: z.array(zJsonObject).min(1).max(100),
  })
  .catchall(z.unknown());

export const errorMapsSchema = z
  .object({
    errorMaps: z.array(zJsonObject).min(1).max(100),
  })
  .catchall(z.unknown());

export const dryRunSchema = z
  .object({
    scenario: z.string().min(2).max(64),
    payload: zJsonObject.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const runSuiteSchema = z
  .object({
    suite: z.enum(["SANDBOX_15", "CONTRACT_AMOUNT", "CONTRACT_REFERENCE", "CONTRACT_SIGNATURE"]),
    environment: z.enum(["sandbox", "test", "uat", "live"]).optional(),
  })
  .strict();

export const submitApprovalSchema = z
  .object({
    reason: z.string().min(3).max(500),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

export const rollbackSchema = z
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
    bodyFrom: (_req, body) => toCoreGatewayCreate(body),
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
    bodyFrom: (_req, body) => toCoreGatewayUpdate(body),
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
    bodyFrom: (_req, body) => toCoreGatewayRollback(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionCreate(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionEnvironments(body),
  }),
);

versionRouter.put(
  "/:vid/auth",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/auth`,
    paramsSchema: versionParamsSchema,
    schema: authSchema,
    bodyFrom: (_req, body) => toCoreGatewayVersionAuth(body),
  }),
);

versionRouter.put(
  "/:vid/settings",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/settings`,
    paramsSchema: versionParamsSchema,
    schema: settingsSchema,
    bodyFrom: (_req, body) => toCoreGatewayVersionSettings(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionCryptoProfiles(body),
  }),
);

versionRouter.put(
  "/:vid/flows",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/flows`,
    paramsSchema: versionParamsSchema,
    schema: flowsSchema,
    bodyFrom: (_req, body) => toCoreGatewayVersionFlows(body),
  }),
);

versionRouter.put(
  "/:vid/channels",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/gateway-versions/${encodeURIComponent(context.params.vid ?? "")}/channels`,
    paramsSchema: versionParamsSchema,
    schema: channelsSchema,
    bodyFrom: (_req, body) => toCoreGatewayVersionChannels(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionStatusRules(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionErrorMaps(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionDryRun(body),
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
    bodyFrom: (_req, body) => toCoreGatewayVersionRunSuite(body),
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
    // The version is queued for approval: core answers `202 Accepted`.
    relayStatus: true,
  }),
);

export const gatewayVersionsRouter = versionRouter;
export const gatewayConfigDocumentSchema = zConfigDocument;
