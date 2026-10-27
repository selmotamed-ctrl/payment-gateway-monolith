import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import {
  coreApplicationCreateSchema,
  coreApplicationPatchSchema,
  toCoreApplicationCreate,
  toCoreApplicationPatch,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const applicationParamsSchema = z.object({ id: zIdentifier });

/**
 * Public (frontend) contract of an application.
 *
 * The canonical fields of `core-back` (`businessUseDescription`,
 * `expectedMonthlyVolume`, `assignedWalletId`, `railWhitelist`,
 * `redirectDomainAllowlist`) are accepted next to the portal vocabulary so the
 * edge can translate the payload without losing information.
 */
const applicationFields = {
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  businessUseDescription: z.string().max(2000).optional(),
  expectedMonthlyVolume: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,4})?$/, { error: "expected monthly volume must be a decimal string" })
    .optional(),
  assignedWalletId: zIdentifier.optional(),
  railWhitelist: z.array(z.string().min(1).max(64)).min(1).optional(),
  redirectDomainAllowlist: z.array(z.string().min(1).max(200)).min(1).optional(),
  website: z.string().max(200).optional(),
  category: z.string().min(2).max(64).optional(),
  settlementCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  contactEmail: z.string().min(3).max(160).optional(),
  contactPhone: z.string().min(6).max(20).optional(),
};

export const applicationCreateSchema = z.object(applicationFields).strict();

export const applicationPatchSchema = z
  .object({
    ...applicationFields,
    name: applicationFields.name.optional(),
    baseVersion: z.number().int().min(1).optional(),
    /** Sensitive changes of the portal, flattened by the edge onto the canonical fields. */
    sensitive: z
      .object({
        assignedWalletId: zIdentifier.optional(),
        railWhitelist: z.array(z.string().min(1).max(64)).min(1).optional(),
        redirectDomainAllowlist: z.array(z.string().min(1).max(200)).min(1).optional(),
      })
      .strict()
      .optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/applications",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/applications",
    schema: applicationCreateSchema,
    bodyMapper: toCoreApplicationCreate,
    coreSchema: coreApplicationCreateSchema,
    status: 201,
  }),
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/merchant/applications/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: applicationParamsSchema,
    schema: applicationPatchSchema,
    bodyMapper: toCoreApplicationPatch,
    coreSchema: coreApplicationPatchSchema,
    // A sensitive change is an approval request: core answers `202 Accepted`.
    relayStatus: true,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/applications/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: applicationParamsSchema,
  }),
);

export const applicationsRouter = router;
