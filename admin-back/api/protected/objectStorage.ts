import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const objectParamsSchema = z.object({ id: zIdentifier }).strict();
const legalHoldSchema = z.object({ reason: z.string().trim().min(5).max(512) }).strict();
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
  }),
);

router.get(
  "/objects",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/object-storage/objects",
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
  }),
);

router.delete(
  "/objects/:id/legal-hold",
  coreForward({
    method: "DELETE",
    path: (context) => `/internal/admin/object-storage/objects/${encodeURIComponent(context.params.id ?? "")}/legal-hold`,
    paramsSchema: objectParamsSchema,
    schema: legalHoldSchema,
  }),
);

router.post(
  "/maintenance/:job",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/object-storage/maintenance/${encodeURIComponent(context.params.job ?? "")}`,
    paramsSchema: maintenanceSchema,
  }),
);

export const objectStorageRouter = router;
