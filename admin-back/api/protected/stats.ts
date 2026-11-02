import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();

const overviewQuerySchema = z
  .object({ period: z.enum(["24h", "7d", "30d", "90d"]).optional() })
  .passthrough();

router.get(
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/stats/overview",
    querySchema: overviewQuerySchema,
  }),
);

export const exportAuditSchema = z
  .object({
    period: z.enum(["24h", "7d", "30d", "90d"]),
    checklist: z
      .array(
        z.enum([
          "PERIOD_VERIFIED",
          "METRICS_REVIEWED",
          "DISTRIBUTION_ACKNOWLEDGED",
          "EXPORT_SCOPE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

router.post(
  "/export-audit",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/stats/export-audit",
    schema: exportAuditSchema,
    status: 201,
  }),
);

router.get(
  "/overview",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/stats/overview",
    querySchema: overviewQuerySchema,
  }),
);



const recentActivityQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(5000).optional() })
  .passthrough();

router.get(
  "/recent-activity/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/stats/recent-activity/export",
    querySchema: recentActivityQuerySchema,
  }),
);

router.get(
  "/recent-activity",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/stats/recent-activity",
    querySchema: recentActivityQuerySchema,
  }),
);

export const statsRouter = router;
