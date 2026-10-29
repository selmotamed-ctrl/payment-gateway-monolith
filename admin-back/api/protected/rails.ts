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
    name: z.string().min(2).max(160),
    gatewayId: zIdentifier.optional(),
    collectionMode: z.enum(["REDIRECT", "EMBEDDED", "QR", "PUSH", "TRANSFER", "CASH"]),
    subModes: z.array(z.string().min(1).max(64)).max(20).optional(),
    feeBearer: z.enum(["PAYER", "MERCHANT", "PLATFORM"]).optional(),
    active: z.boolean().optional(),
    labels: z.record(z.string().max(16), z.string().max(160)).optional(),
  })
  .strict();

export const railPatchSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    subModes: z.array(z.string().min(1).max(64)).max(20).optional(),
    feeBearer: z.enum(["PAYER", "MERCHANT", "PLATFORM"]).optional(),
    active: z.boolean().optional(),
    labels: z.record(z.string().max(16), z.string().max(160)).optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

export const railFieldsSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            code: z.string().min(1).max(64),
            label: z.string().min(1).max(160),
            type: z.enum(["TEXT", "NUMBER", "PHONE", "NATIONAL_ID", "PASSPORT", "DATE", "OTP", "HIDDEN"]),
            required: z.boolean().optional(),
            pattern: z.string().max(200).optional(),
            minLength: z.number().int().min(0).max(64).optional(),
            maxLength: z.number().int().min(1).max(256).optional(),
            sensitive: z.boolean().optional(),
            order: z.number().int().min(0).max(100).optional(),
          })
          .strict(),
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
    priority: z.number().int().min(0).max(10000).optional(),
    costModel: zJsonObject.optional(),
    limitAmount: zAmount.optional(),
    limitCurrency: zCurrency.optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

export const routeStateSchema = z
  .object({
    state: z.enum(["ACTIVE", "PAUSED", "DRAINING"]),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict();

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
