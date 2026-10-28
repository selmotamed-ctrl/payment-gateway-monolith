import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();

const overviewQuerySchema = z
  .object({
    period: z.enum(["last_7d", "last_30d", "last_90d"]).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .strict();

router.get(
  "/overview",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/stats/overview",
    querySchema: overviewQuerySchema,
  }),
);

export const statsRouter = router;
