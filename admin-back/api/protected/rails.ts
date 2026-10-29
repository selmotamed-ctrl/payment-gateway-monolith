import express from "express";
import { z } from "zod";
import { zAmount, zBaseVersion, zCurrency, zIdentifier, zJsonObject, zListQuery, zPaginationQuery } from "../../lib/zReady";
import {
  toCoreRailCreate,
  toCoreRailFields,
  toCoreRailUpdate,
  toCoreRouteCreate,
  toCoreRouteState,
  toCoreRouteUpdate,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const railCreateSchema = z
  .object({
    code: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "invalid rail code"),
    name: z.string().min(1).max(160).optional(),
    nameAr: z.string().min(1).max(160).optional(),
    nameEn: z.string().min(1).max(160).optional(),
    gatewayId: zIdentifier.optional(),
    collectionMode: z.enum([
      "OTP_PULL",
      "REDIRECT",
      "EMBEDDED",
      "PUSH_APPROVAL",
      "QR_DISPLAY",
      "PAY_CODE",
      "DEEP_LINK",
      "MANUAL",
      "HYBRID",
      "QR",
      "PUSH",
      "TRANSFER",
      "CASH",
    ]),
    subModes: z.array(z.string().min(1).max(64)).max(20).optional(),
    feeBearer: z.enum(["PAYER", "MERCHANT", "PLATFORM"]).optional(),
    active: z.boolean().optional(),
    labels: z.record(z.string().max(16), z.string().max(160)).optional(),
    currency: z.string().length(3).optional(),
    minAmount: zAmount.optional(),
    maxAmount: zAmount.optional(),
    capabilities: z.union([z.array(z.string().max(40)).max(50), z.record(z.string().max(40), z.boolean())]).optional(),
  })
  .catchall(z.unknown());

export const railPatchSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    nameAr: z.string().min(1).max(160).optional(),
    nameEn: z.string().min(1).max(160).optional(),
    subModes: z.array(z.string().min(1).max(64)).max(20).optional(),
    feeBearer: z.enum(["PAYER", "MERCHANT", "PLATFORM"]).optional(),
    active: z.boolean().optional(),
    labels: z.record(z.string().max(16), z.string().max(160)).optional(),
    currency: z.string().length(3).optional(),
    minAmount: zAmount.optional(),
    maxAmount: zAmount.optional(),
    displayOrder: z.number().int().min(0).max(9999).optional(),
    capabilities: z.union([z.array(z.string().max(40)).max(50), z.record(z.string().max(40), z.boolean())]).optional(),
    instructionsAr: z.string().max(2000).optional(),
    instructionsEn: z.string().max(2000).optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .catchall(z.unknown());

export const railFieldsSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            code: z.string().min(1).max(64).optional(),
            key: z.string().min(1).max(64).optional(),
            fieldKey: z.string().min(1).max(64).optional(),
            label: z.string().min(1).max(160).optional(),
            labelAr: z.string().min(1).max(160).optional(),
            labelEn: z.string().min(1).max(160).optional(),
            type: z.string().min(1).max(32).optional(),
            inputType: z.string().min(1).max(32).optional(),
            required: z.boolean().optional(),
            pattern: z.string().max(200).optional(),
            regex: z.string().max(200).optional(),
            minLength: z.number().int().min(0).max(64).nullable().optional(),
            maxLength: z.number().int().min(1).max(256).nullable().optional(),
            sensitive: z.boolean().optional(),
            sensitivity: z.enum(["NORMAL", "SENSITIVE", "PAN"]).optional(),
            normalizer: z.union([z.string().max(64), z.record(z.string().max(64), z.unknown())]).optional(),
            options: z.array(z.string().max(160)).max(100).optional(),
            order: z.number().int().min(0).max(100).optional(),
            orderIndex: z.number().int().min(0).max(100).optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(50),
  })
  .catchall(z.unknown());

export const routeCreateSchema = z
  .object({
    railId: zIdentifier,
    gatewayId: zIdentifier.optional(),
    environment: z.enum(["sandbox", "test", "uat", "live"]),
    priority: z.number().int().min(0).max(10000).optional(),
    costModel: zJsonObject.optional(),
    limitAmount: zAmount.optional(),
    limitCurrency: zCurrency.optional(),
    active: z.boolean().optional(),
    // core requires the credential policy of a route and the public API cannot express it.
    credentialPolicy: z.enum(["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"]).optional(),
  })
  .strict();

export const routePatchSchema = z
  .object({
    priority: z.number().int().min(0).max(9999).optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    costModel: zJsonObject.optional(),
    scope: zJsonObject.optional(),
    limitAmount: zAmount.optional(),
    minAmount: zAmount.optional(),
    maxAmount: zAmount.optional(),
    dailyCapAmount: zAmount.optional(),
    limitCurrency: zCurrency.optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

export const routeStateSchema = z
  .object({
    status: z.enum(["ACTIVE", "PAUSED", "DRAINING"]).optional(),
    state: z.enum(["ACTIVE", "PAUSED", "DRAINING"]).optional(),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict()
  .refine((value) => value.status !== undefined || value.state !== undefined, {
    message: "status is required",
    path: ["status"],
  });

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/rails",
    querySchema: zListQuery,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/rails",
    schema: railCreateSchema,
    bodyFrom: (_req, body) => toCoreRailCreate(body),
    status: 201,
  }),
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/rails/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
    schema: railPatchSchema,
    bodyFrom: (_req, body) => toCoreRailUpdate(body),
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/rails/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.put(
  "/:id/fields",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/rails/${encodeURIComponent(context.params.id ?? "")}/fields`,
    paramsSchema: idParamsSchema,
    schema: railFieldsSchema,
    bodyFrom: (_req, body) => toCoreRailFields(body),
  }),
);

export const railsRouter = router;
export const routesRouter = express.Router();

routesRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/routes",
    querySchema: zPaginationQuery,
  }),
);

routesRouter.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/routes",
    schema: routeCreateSchema,
    bodyFrom: (_req, body) => toCoreRouteCreate(body),
    status: 201,
  }),
);

routesRouter.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/routes/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
    schema: routePatchSchema,
    bodyFrom: (_req, body) => toCoreRouteUpdate(body),
  }),
);

routesRouter.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/routes/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

routesRouter.post(
  "/:id/state",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/routes/${encodeURIComponent(context.params.id ?? "")}/state`,
    paramsSchema: idParamsSchema,
    schema: routeStateSchema,
    bodyFrom: (_req, body) => toCoreRouteState(body),
  }),
);
