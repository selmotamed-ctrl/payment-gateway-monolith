import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const applicationParamsSchema = z.object({ id: zIdentifier });

const applicationCreateSchema = z
  .object({
    name: z.string().min(2).max(160),
    description: z.string().max(2000).optional(),
    website: z.string().max(200).optional(),
    category: z.string().min(2).max(64).optional(),
    settlementCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
    contactEmail: z.string().min(3).max(160).optional(),
    contactPhone: z.string().min(6).max(20).optional(),
  })
  .strict();

const applicationPatchSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    description: z.string().max(2000).optional(),
    website: z.string().max(200).optional(),
    category: z.string().min(2).max(64).optional(),
    contactEmail: z.string().min(3).max(160).optional(),
    contactPhone: z.string().min(6).max(20).optional(),
    baseVersion: z.number().int().min(1).optional(),
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
