import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { requireAuthorities } from "../middleware/authorityGuard";
import { coreForward } from "../forward";

const router = express.Router();

const objectParamsSchema = z.object({ id: zIdentifier }).strict();
const legalHoldSchema = z.object({ reason: z.string().trim().min(5).max(512) }).strict();
const objectListSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  namespace: z.string().trim().max(64).optional(),
  status: z.string().trim().max(32).optional(),
  statuses: z.string().trim().max(200).optional(),
  bucket: z.string().trim().max(16).optional(),
  ownerMerchantId: z.string().uuid().optional(),
  legalHold: z.enum(["true", "false"]).optional(),
  sha256Hex: z.string().trim().length(64).regex(/^[a-f0-9]{64}$/i).optional(),
  search: z.string().trim().max(200).optional(),
  sortKey: z.enum(["createdAt", "namespace", "status", "retainUntil", "byteSize", "originalFilename"]).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
}).strict();
const accessLogListSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  allowed: z.enum(["true", "false"]).optional(),
  action: z.string().trim().max(48).optional(),
  objectId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
}).strict();
const maintenanceSchema = z.object({
  job: z.enum(["gc", "sweep", "scrub", "reconcile-locks", "rewrap", "av-scan"]),
}).strict();

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/object-storage/summary",
  }),
);

router.get(
  "/access-logs",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/object-storage/access-logs",
    querySchema: accessLogListSchema,
  }),
);

router.get(
  "/objects",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/object-storage/objects",
    querySchema: objectListSchema,
  }),
);

router.get(
  "/objects/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/object-storage/objects/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: objectParamsSchema,
  }),
);

router.post(
  "/objects/:id/legal-hold",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/object-storage/objects/${encodeURIComponent(context.params.id ?? "")}/legal-hold`,
    paramsSchema: objectParamsSchema,
    schema: legalHoldSchema,
    relayStatus: true,
  }),
);

router.delete(
  "/objects/:id/legal-hold",
  coreForward({
    method: "DELETE",
    path: (context) => `/internal/admin/object-storage/objects/${encodeURIComponent(context.params.id ?? "")}/legal-hold`,
    paramsSchema: objectParamsSchema,
    schema: legalHoldSchema,
    relayStatus: true,
  }),
);

router.post(
  "/maintenance/:job",
  requireAuthorities("system:storage:admin"),
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/object-storage/maintenance/${encodeURIComponent(context.params.job ?? "")}`,
    paramsSchema: maintenanceSchema,
  }),
);

export const objectStorageRouter = router;
