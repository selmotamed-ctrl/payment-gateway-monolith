import { zIdentifier } from "../../lib/zReady";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { coreForward } from "../forward";

/**
 * Outbound webhook management (AUTO-34). Thin proxy to `core-back`; the contract (and the authority checks) live there:
 * reading needs a merchant read authority, changing needs `application:manage`, a scoped user only reaches their own
 * applications. The signing secret appears in exactly two responses (create, rotate) and is never cached.
 */
const router = express.Router();

const idParams = z.object({ id: zIdentifier });

const endpointFields = {
  url: z.string().min(1).max(2000),
  eventTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
  description: z.string().max(200).nullable().optional(),
};

export const webhookEndpointCreateSchema = z.object({ applicationId: zIdentifier, ...endpointFields }).strict();
export const webhookEndpointPatchSchema = z
  .object({
    url: endpointFields.url.optional(),
    eventTypes: endpointFields.eventTypes,
    description: endpointFields.description,
    enabled: z.boolean().optional(),
  })
  .strict();

const noStore = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader("Cache-Control", "no-store");
  next();
};

router.get("/event-types", coreForward({ method: "GET", path: () => "/internal/merchant/webhooks/event-types" }));

router.get(
  "/endpoints",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/webhooks/endpoints",
    querySchema: z.object({ applicationId: zIdentifier.optional() }).strict(),
  }),
);

router.post(
  "/endpoints",
  noStore,
  coreForward({ method: "POST", path: () => "/internal/merchant/webhooks/endpoints", schema: webhookEndpointCreateSchema, status: 201 }),
);

router.patch(
  "/endpoints/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/merchant/webhooks/endpoints/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParams,
    schema: webhookEndpointPatchSchema,
  }),
);

router.post(
  "/endpoints/:id/rotate-secret",
  noStore,
  coreForward({
    method: "POST",
    path: (context) => `/internal/merchant/webhooks/endpoints/${encodeURIComponent(context.params.id ?? "")}/rotate-secret`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
  }),
);

router.post(
  "/endpoints/:id/test",
  coreForward({
    method: "POST",
    path: (context) => `/internal/merchant/webhooks/endpoints/${encodeURIComponent(context.params.id ?? "")}/test`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
    status: 202,
  }),
);

router.get(
  "/deliveries",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/webhooks/deliveries",
    querySchema: z
      .object({
        endpointId: zIdentifier.optional(),
        status: z.enum(["PENDING", "DELIVERED", "PARKED"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        before: z.string().max(64).optional(),
      })
      .strict(),
  }),
);

router.post(
  "/deliveries/:id/redeliver",
  coreForward({
    method: "POST",
    path: (context) => `/internal/merchant/webhooks/deliveries/${encodeURIComponent(context.params.id ?? "")}/redeliver`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
    status: 202,
  }),
);

export const webhooksRouter = router;
