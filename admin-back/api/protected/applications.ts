import express from "express";
import { z } from "zod";
import { zListQuery, zUuid } from "../../lib/zReady";
import { coreForward } from "../forward";
import { encode, reasonOnlySchema, uuidParamsSchema, zMutationReason } from "./mutationSchemas";

const applicationsRouter = express.Router();
const paymentLinksRouter = express.Router();
const posTerminalsRouter = express.Router();

const railCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, "invalid rail code");

/** An https origin or a bare hostname (core re-validates and normalises). */
const redirectDomainSchema = z.string().trim().min(1).max(253);

/**
 * Suspending alone is immediate; re-activating or editing what the application may accept is an
 * approval request. The edge only validates the shape, core decides the mode.
 */
export const applicationPatchSchema = z
  .object({
    status: z.enum(["SUSPENDED", "ACTIVE"]).optional(),
    assignedWalletId: zUuid.optional(),
    railWhitelist: z.array(railCodeSchema).max(200).nullable().optional(),
    redirectDomainAllowlist: z.array(redirectDomainSchema).max(100).optional(),
    reason: zMutationReason,
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.assignedWalletId !== undefined ||
      value.railWhitelist !== undefined ||
      value.redirectDomainAllowlist !== undefined,
    { message: "at least one change is required", path: ["status"] },
  );

export const applicationTokenParamsSchema = z.object({ id: zUuid, tokenId: zUuid }).strict();

export const paymentLinkStateSchema = z
  .object({
    state: z.literal("CANCELLED"),
    reason: zMutationReason,
  })
  .strict();

export const posTerminalStatusSchema = z
  .object({
    status: z.enum(["INACTIVE", "BLOCKED", "ACTIVE"]),
    reason: zMutationReason,
  })
  .strict();

applicationsRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/applications",
    querySchema: zListQuery,
  }),
);

applicationsRouter.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/applications/summary",
    querySchema: zListQuery,
  }),
);

applicationsRouter.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/applications/${encode(context.params.id)}`,
    paramsSchema: uuidParamsSchema,
  }),
);

applicationsRouter.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/applications/${encode(context.params.id)}`,
    paramsSchema: uuidParamsSchema,
    schema: applicationPatchSchema,
    // Suspension answers 200, every other change is an approval request (202).
    relayStatus: true,
  }),
);

applicationsRouter.post(
  "/:id/tokens/:tokenId/revoke",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/applications/${encode(context.params.id)}/tokens/${encode(context.params.tokenId)}/revoke`,
    paramsSchema: applicationTokenParamsSchema,
    schema: reasonOnlySchema,
    relayStatus: true,
  }),
);

paymentLinksRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/payment-links",
    querySchema: zListQuery,
  }),
);

paymentLinksRouter.post(
  "/:id/state",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/payment-links/${encode(context.params.id)}/state`,
    paramsSchema: uuidParamsSchema,
    schema: paymentLinkStateSchema,
    relayStatus: true,
  }),
);

posTerminalsRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/pos-terminals",
    querySchema: zListQuery,
  }),
);

posTerminalsRouter.post(
  "/:id/status",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/pos-terminals/${encode(context.params.id)}/status`,
    paramsSchema: uuidParamsSchema,
    schema: posTerminalStatusSchema,
    // INACTIVE/BLOCKED are immediate (200); re-activation is an approval request (202).
    relayStatus: true,
  }),
);

export { applicationsRouter, paymentLinksRouter, posTerminalsRouter };
