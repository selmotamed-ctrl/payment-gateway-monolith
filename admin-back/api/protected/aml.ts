import express from "express";
import { z } from "zod";
import { requireAuthorities } from "../middleware/authorityGuard";
import { zAmount, zIdentifier, zJsonObject, zPaginationQuery, zReason } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const amlConfidential = requireAuthorities("COMPLIANCE", "MLRO");

const dispositionSchema = z
  .object({
    disposition: z.enum(["FALSE_POSITIVE", "CONFIRMED_MATCH", "PENDING", "ESCALATED"]),
    notes: z.string().min(3).max(2000),
    caseId: zIdentifier.optional(),
  })
  .strict();

const caseProposeSchema = z
  .object({
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    action: z.enum(["CASE_ONLY", "AML_HOLD", "BLOCK", "REPORT"]),
    reason: zReason,
    notes: z.string().max(2000).optional(),
    reportingRuleId: zIdentifier.optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    code: z.string().min(2).max(64),
    name: z.string().min(2).max(160),
    layer: z.number().int().min(1).max(7),
    type: z.enum(["SINGLE_AMOUNT", "CUMULATIVE_WINDOW", "STRUCTURING"]),
    parameters: zJsonObject,
    action: z.enum(["CASE_ONLY", "AML_HOLD", "BLOCK", "REPORT"]),
    active: z.boolean().optional(),
  })
  .strict();

const reportingRuleSchema = z
  .object({
    code: z.string().min(2).max(64),
    name: z.string().min(2).max(160),
    mode: z.enum(["PROVISIONAL", "CONFIRMED"]),
    threshold: zAmount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    windowDays: z.number().int().min(1).max(365),
    active: z.boolean().optional(),
  })
  .strict();

const reportSchema = z
  .object({
    reportingRuleId: zIdentifier,
    caseId: zIdentifier.optional(),
    periodStart: z.string().max(64),
    periodEnd: z.string().max(64),
    notes: z.string().max(2000).optional(),
  })
  .strict();

router.use(amlConfidential);

router.get(
  "/screenings",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/screenings",
    querySchema: zPaginationQuery,
  }),
);

router.post(
  "/matches/:id/disposition",
  coreForward({
    method: "POST",
    path: (context) =>
      `/internal/admin/aml/matches/${encodeURIComponent(context.params.id ?? "")}/disposition`,
    paramsSchema: idParamsSchema,
    schema: dispositionSchema,
  }),
);

router.get(
  "/cases",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/cases",
    querySchema: zPaginationQuery,
  }),
);

router.post(
  "/cases/:id/propose",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/cases/${encodeURIComponent(context.params.id ?? "")}/propose`,
    paramsSchema: idParamsSchema,
    schema: caseProposeSchema,
  }),
);

router.get(
  "/rules",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/rules",
  }),
);

router.post(
  "/rules",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/aml/rules",
    schema: ruleSchema,
    status: 201,
  }),
);

router.get(
  "/reporting-rules",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/reporting-rules",
  }),
);

router.post(
  "/reporting-rules",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/aml/reporting-rules",
    schema: reportingRuleSchema,
    status: 201,
  }),
);

router.get(
  "/reports",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/reports",
    querySchema: zPaginationQuery,
  }),
);

router.post(
  "/reports",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/aml/reports",
    schema: reportSchema,
    status: 201,
  }),
);

export const amlRouter = router;
