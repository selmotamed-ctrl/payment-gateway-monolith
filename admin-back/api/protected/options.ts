import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();

const kindSchema = z.object({
  kind: z.enum(["merchants", "rails", "gateways", "users", "applications", "wallets", "credential-sets"]),
});

const querySchema = z
  .object({
    search: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

router.get(
  "/:kind",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/options/${encodeURIComponent(context.params.kind ?? "")}`,
    paramsSchema: kindSchema,
    querySchema,
  }),
);

export const optionsRouter = router;
