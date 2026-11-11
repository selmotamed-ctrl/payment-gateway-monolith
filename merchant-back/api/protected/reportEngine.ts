import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();
export const reportEngineRouter = router;

const codeParams = z.object({ code: z.string().min(1).max(64) }).strict();
const sourceParams = z.object({ sourceKey: z.string().min(1).max(64) }).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();

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
    querySchema: z
      .object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
        search: z.string().max(200).optional(),
        sortKey: z.string().max(64).optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
      })
      .passthrough(),
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

const studioBody = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
  })
  .strict();

router.get(
  "/studio/transcript",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/report-engine/studio/transcript",
  }),
);

router.post(
  "/studio/verify",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/report-engine/studio/verify",
    schema: studioBody,
  }),
);

router.post(
  "/studio/preview",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/report-engine/studio/preview",
    schema: studioBody
      .extend({
        inputs: z.record(z.string(), z.unknown()).optional(),
        locale: z.string().max(16).optional(),
        mode: z.enum(["MOCK", "LIVE"]).default("MOCK"),
      })
      .strict(),
  }),
);

router.post(
  "/studio/specs",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/report-engine/studio/specs",
    schema: studioBody.extend({ publish: z.boolean().optional() }).strict(),
    status: 201,
  }),
);

router.get(
  "/studio/specs",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/report-engine/studio/specs",
    querySchema: z.object({ code: z.string().max(64).optional() }).passthrough(),
  }),
);

router.get(
  "/studio/specs/:id",
  coreForward({
    method: "GET",
    path: ({ params }) => `/internal/merchant/report-engine/studio/specs/${params.id}`,
    paramsSchema: idParams,
  }),
);

router.post(
  "/studio/specs/:id/publish",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/merchant/report-engine/studio/specs/${params.id}/publish`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
  }),
);

router.post(
  "/studio/specs/:id/archive",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/merchant/report-engine/studio/specs/${params.id}/archive`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
  }),
);

router.get(
  "/studio/usage",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/report-engine/studio/usage",
  }),
);

router.post(
  "/studio/templates/:code/clone",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/merchant/report-engine/studio/templates/${params.code}/clone`,
    paramsSchema: codeParams,
    schema: z.object({ code: z.string().min(1).max(64).optional() }).strict(),
    status: 201,
  }),
);
