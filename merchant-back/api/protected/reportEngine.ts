import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();
export const reportEngineRouter = router;

const codeParams = z.object({ code: z.string().min(1).max(64) }).strict();
const sourceParams = z.object({ sourceKey: z.string().min(1).max(64) }).strict();

const executeBody = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    locale: z.string().max(16).optional(),
    renderMode: z.enum(["CLIENT_PAGED_VECTOR", "SERVER_PDF"]).optional(),
  })
  .strict();

router.get(
  "/catalog",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/report-engine/catalog",
  }),
);

router.get(
  "/autocomplete/:sourceKey",
  coreForward({
    method: "GET",
    path: ({ params }) => `/internal/merchant/report-engine/autocomplete/${params.sourceKey}`,
    paramsSchema: sourceParams,
    querySchema: z
      .object({
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        dependent: z.string().optional(),
      })
      .passthrough(),
  }),
);

router.post(
  "/catalog/:code/execute",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/merchant/report-engine/catalog/${params.code}/execute`,
    paramsSchema: codeParams,
    schema: executeBody,
  }),
);
