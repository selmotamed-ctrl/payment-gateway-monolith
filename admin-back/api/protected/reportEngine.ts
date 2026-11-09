import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

const router = express.Router();
export const reportEngineRouter = router;

const idParams = z.object({ id: z.string().uuid() }).strict();
const codeParams = z.object({ code: z.string().min(1).max(64) }).strict();
const sourceParams = z.object({ sourceKey: z.string().min(1).max(64) }).strict();

const specBody = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
    publish: z.boolean().optional(),
  })
  .strict();

const verifyBody = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
  })
  .strict();

const overrideBody = z
  .object({
    allowedRoles: z.array(z.string()).max(20).default([]),
    allowedAuthorities: z.array(z.string()).max(40).default([]),
    justification: z.string().trim().min(15).max(1000),
    allowConfidentialAmlBypass: z.boolean().optional(),
    clear: z.boolean().optional(),
  })
  .strict();

const executeBody = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    locale: z.string().max(16).optional(),
    chromeOverride: z
      .object({
        headerMode: z.enum(["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"]).optional(),
        headerChromeCode: z.string().nullable().optional(),
        footerMode: z.enum(["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"]).optional(),
        footerChromeCode: z.string().nullable().optional(),
      })
      .optional(),
    renderMode: z.enum(["CLIENT_PAGED_VECTOR", "SERVER_PDF"]).optional(),
  })
  .strict();

const chromeBody = z
  .object({
    specJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    assetsZipBase64: z.string().optional(),
    publish: z.boolean().optional(),
    makeDefault: z.boolean().optional(),
  })
  .strict();

router.get(
  "/transcript",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/report-engine/transcript",
    querySchema: z.object({ kind: z.string().optional(), domains: z.string().optional() }).passthrough(),
  }),
);

router.post(
  "/specs/verify",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/report-engine/specs/verify",
    schema: verifyBody,
  }),
);

router.post(
  "/specs",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/report-engine/specs",
    schema: specBody,
    status: 201,
  }),
);

router.get(
  "/specs",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/report-engine/specs",
    querySchema: z
      .object({ code: z.string().max(64).optional(), status: z.string().max(32).optional() })
      .passthrough(),
  }),
);

router.get(
  "/specs/:id",
  coreForward({
    method: "GET",
    path: ({ params }) => `/internal/admin/report-engine/specs/${params.id}`,
    paramsSchema: idParams,
  }),
);

router.post(
  "/specs/:id/archive",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/admin/report-engine/specs/${params.id}/archive`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
  }),
);

router.get(
  "/executions",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/report-engine/executions",
    querySchema: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).passthrough(),
  }),
);

router.post(
  "/specs/:id/authority-override",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/admin/report-engine/specs/${params.id}/authority-override`,
    paramsSchema: idParams,
    schema: overrideBody,
  }),
);

router.get(
  "/catalog",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/report-engine/catalog",
  }),
);

router.get(
  "/autocomplete/:sourceKey",
  coreForward({
    method: "GET",
    path: ({ params }) => `/internal/admin/report-engine/autocomplete/${params.sourceKey}`,
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
    path: ({ params }) => `/internal/admin/report-engine/catalog/${params.code}/execute`,
    paramsSchema: codeParams,
    schema: executeBody,
  }),
);

router.get(
  "/aml-bypass/pending",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/report-engine/aml-bypass/pending",
  }),
);

router.post(
  "/aml-bypass/:id/approve",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/admin/report-engine/aml-bypass/${params.id}/approve`,
    paramsSchema: idParams,
    schema: z.object({}).strict(),
  }),
);

router.post(
  "/aml-bypass/:id/reject",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/admin/report-engine/aml-bypass/${params.id}/reject`,
    paramsSchema: idParams,
    schema: z.object({ notes: z.string().max(2000).optional() }).strict(),
  }),
);

router.get(
  "/chrome",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/report-engine/chrome",
    querySchema: z.object({ type: z.string().optional() }).passthrough(),
  }),
);

router.post(
  "/chrome",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/report-engine/chrome",
    schema: chromeBody,
    status: 201,
  }),
);

router.post(
  "/chrome/:id/set-default",
  coreForward({
    method: "POST",
    path: ({ params }) => `/internal/admin/report-engine/chrome/${params.id}/set-default`,
    paramsSchema: idParams,
    schema: z.object({ isDefault: z.boolean() }).strict(),
  }),
);
