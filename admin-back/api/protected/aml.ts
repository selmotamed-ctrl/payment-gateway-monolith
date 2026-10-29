import express from "express";
import { z } from "zod";
import { zListQuery } from "../../lib/zReady";
import { requireAuthorities } from "../middleware/authorityGuard";
import { zAmount, zIdentifier, zJsonObject, zPaginationQuery, zReason } from "../../lib/zReady";
import {
  toCoreAmlCasePropose,
  toCoreAmlMatchDisposition,
  toCoreAmlReport,
  toCoreAmlReportingRule,
  toCoreAmlRule,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

// Confidential AML routes: the role names are the canonical check, the aml authority
// strings are the equivalent claim core accepts for the same resources.
const amlConfidential = requireAuthorities("COMPLIANCE", "MLRO", "aml:read", "aml:write");

export const dispositionSchema = z
  .object({
    disposition: z.enum(["FALSE_POSITIVE", "CONFIRMED_MATCH", "PENDING", "ESCALATED"]),
    notes: z.string().min(3).max(2000),
    caseId: zIdentifier.optional(),
  })
  .strict();

export const caseProposeSchema = z
  .object({
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    // The core expresses the checker's decision as HOLD / RELEASE / REJECT /
    // ESCALATE. The public enum keeps the product vocabulary and adds the two
    // decisions a release or a void needs.
    action: z.enum(["CASE_ONLY", "AML_HOLD", "BLOCK", "REPORT", "RELEASE", "REJECT"]),
    reason: zReason,
    notes: z.string().max(2000).optional(),
    reportingRuleId: zIdentifier.optional(),
  })
  .strict();

export const ruleSchema = z
  .object({
    code: z.string().min(2).max(64),
    name: z.string().min(2).max(160),
    ruleType: z.enum([
      "SINGLE_AMOUNT",
      "CUMULATIVE_WINDOW",
      "STRUCTURING",
      "RISK_TIER",
      "COUNTERPARTY_COUNTRY",
      "RAIL",
      "MERCHANT_DIRECT_AMOUNT",
    ]),
    action: z.enum(["HOLD", "FLAG", "BLOCK", "CASE_ONLY"]),
    baseSeverity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    params: zJsonObject.optional(),
    effectiveFrom: z.string().max(64).optional(),
  })
  .strict();

export const reportingRuleSchema = z
  .object({
    code: z.string().min(2).max(64),
    name: z.string().min(2).max(160),
    mode: z.enum(["PROVISIONAL", "CONFIRMED"]),
    threshold: zAmount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    windowDays: z.number().int().min(1).max(365),
    active: z.boolean().optional(),
    reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]).optional(),
  })
  .strict();

export const reportSchema = z
  .object({
    reportingRuleId: zIdentifier,
    caseId: zIdentifier.optional(),
    periodStart: z.string().max(64),
    periodEnd: z.string().max(64),
    notes: z.string().max(2000).optional(),
    reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]).optional(),
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
    bodyFrom: (_req, body) => toCoreAmlMatchDisposition(body),
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
    bodyFrom: (_req, body) => toCoreAmlCasePropose(body),
    // The proposal is an approval request: core answers `202 Accepted`.
    relayStatus: true,
  }),
);

router.get(
  "/rules",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/rules",
    querySchema: zListQuery,
  }),
);

router.post(
  "/rules",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/aml/rules",
    schema: ruleSchema,
    bodyFrom: (_req, body) => toCoreAmlRule(body),
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
    bodyFrom: (_req, body) => toCoreAmlReportingRule(body),
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
    bodyFrom: (_req, body) => toCoreAmlReport(body),
    status: 201,
  }),
);

export const amlRouter = router;
