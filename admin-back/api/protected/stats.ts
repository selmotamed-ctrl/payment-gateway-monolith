import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();

const overviewQuerySchema = z
  .object({ period: z.enum(["24h", "7d", "30d", "90d"]).optional() })
  .passthrough();

router.get(
  "/overview",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/stats/overview",
    querySchema: overviewQuerySchema,
  }),
);

export const statsRouter = router;
