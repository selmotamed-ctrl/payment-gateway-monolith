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
import { coreForward, coreForwardRaw } from "../forward";

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
    checklist: z
      .array(
        z.enum([
          "MATCH_DETAILS_REVIEWED",
          "IDENTITY_EVIDENCE_CHECKED",
          "DISPOSITION_RATIONALE_DOCUMENTED",
          "ESCALATION_PATH_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
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
    checklist: z
      .array(
        z.enum([
          "EVIDENCE_REVIEWED",
          "SUBJECT_IDENTIFIED",
          "REGULATORY_OBLIGATION_ASSESSED",
          "CHECKER_INDEPENDENCE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
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
    scope: zJsonObject.optional(),
    params: zJsonObject.optional(),
    effectiveFrom: z.string().max(64).optional(),
    checklist: z
      .array(
        z.enum([
          "RULE_LOGIC_REVIEWED",
          "THRESHOLDS_VERIFIED",
          "REGULATORY_BASIS_DOCUMENTED",
          "CHECKER_INDEPENDENCE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
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
    reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN", "INCIDENT"]).optional(),
  })
  .strict();

export const reportSchema = z
  .object({
    reportingRuleId: zIdentifier,
    caseId: zIdentifier.optional(),
    periodStart: z.string().max(64),
    periodEnd: z.string().max(64),
    notes: z.string().max(2000).optional(),
    reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN", "INCIDENT"]).optional(),
    authority: z.string().min(2).max(64).optional(),
    checklist: z
      .array(
        z.enum([
          "REPORTING_RULE_VERIFIED",
          "PERIOD_VERIFIED",
          "CASE_LINKAGE_VERIFIED",
          "NOTES_REVIEWED",
        ]),
      )
      .max(10)
      .optional(),
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

router.get(
  "/screenings/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/screenings/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/screenings/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/screenings/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/screenings/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/screenings/summary/export",
  }),
);

router.get(
  "/screenings/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/screenings/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
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

router.get(
  "/cases/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/cases/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/cases/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/cases/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/cases/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/cases/summary/export",
  }),
);

router.get(
  "/cases/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/cases/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
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

router.get(
  "/rules/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/rules/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/rules/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/rules/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/rules/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/rules/summary/export",
  }),
);

router.get(
  "/rules/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/rules/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/rules",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/aml/rules",
    schema: ruleSchema,
    bodyFrom: (_req, body) => toCoreAmlRule(body),
    relayStatus: true,
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

const reportingRulePromoteSchema = z.object({}).strict();

router.post(
  "/reporting-rules/:id/promote",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/reporting-rules/${encodeURIComponent(context.params.id ?? "")}/promote`,
    paramsSchema: z.object({ id: zIdentifier }),
    schema: reportingRulePromoteSchema,
    // Promotion is a maker-checker request: core answers `202 Accepted`.
    relayStatus: true,
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

router.get(
  "/reports/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/reports/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/reports/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/reports/summary",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/reports/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/aml/reports/summary/export",
  }),
);

const reportSubmitSchema = z
  .object({
    submissionRef: z.string().min(1).max(200),
    submittedAt: z.string().max(64).optional(),
    filingChannel: z.string().min(2).max(80).optional(),
    checklist: z
      .array(
        z.enum([
          "REPORT_APPROVED_VERIFIED",
          "AUTHORITY_REFERENCE_VERIFIED",
          "DEADLINE_VERIFIED",
          "PAYLOAD_DIGEST_VERIFIED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

router.post(
  "/reports/:id/submit",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/submit`,
    paramsSchema: idParamsSchema,
    schema: reportSubmitSchema,
  }),
);

const reportAcknowledgeSchema = z
  .object({
    status: z.enum(["ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"]),
    reason: z.string().max(2000).optional(),
    checklist: z
      .array(
        z.enum([
          "AUTHORITY_RESPONSE_VERIFIED",
          "DECISION_RECORDED",
          "REJECTION_REASON_DOCUMENTED",
          "REPORT_CLOSURE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

router.post(
  "/reports/:id/acknowledge",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/acknowledge`,
    paramsSchema: idParamsSchema,
    schema: reportAcknowledgeSchema,
  }),
);

router.get(
  "/reports/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
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


const reportSchemaUploadSchema = z
  .object({
    authority: z.string().min(2).max(64).default("CBL"),
    reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN", "INCIDENT"]),
    reportCode: z.string().max(40).default(""),
    format: z.enum(["XML", "XLSX", "DOCX"]),
    schemaCode: z.string().min(2).max(120),
    name: z.string().min(2).max(200),
    version: z.number().int().min(1).max(10000).optional(),
    definitionText: z.string().min(1).max(2_000_000),
    mappingBlueprint: zJsonObject.default({}),
    sampleContext: zJsonObject.optional(),
    templateBase64: z.string().max(20_000_000).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

const reportSchemaPromoteSchema = z.object({ setAsDefault: z.boolean().default(true) }).strict();
const reportSchemaDefaultSchema = z
  .object({
    authority: z.string().min(2).max(64).default("CBL"),
    reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN", "INCIDENT"]),
    reportCode: z.string().max(40).default(""),
    format: z.enum(["XML", "XLSX", "DOCX"]),
    schemaId: zIdentifier,
  })
  .strict();
const reportSimulateSchema = z.object({ context: zJsonObject }).strict();
const reportGenerateSchema = z
  .object({
    formats: z.array(z.enum(["XML", "XLSX", "DOCX"])).min(1).max(3).optional(),
    allowRegenerate: z.boolean().default(false),
  })
  .strict();
const reportIdFormatParams = z.object({ id: zIdentifier, format: z.enum(["XML", "XLSX", "DOCX"]) });

router.get("/report-context-catalog", coreForward({ method: "GET", path: () => "/internal/admin/aml/report-context-catalog" }));
router.get("/report-schemas", coreForward({ method: "GET", path: () => "/internal/admin/aml/report-schemas" }));
router.get(
  "/report-schemas/:id",
  coreForward({ method: "GET", path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}`, paramsSchema: idParamsSchema }),
);
router.post(
  "/report-schemas",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/aml/report-schemas",
    schema: reportSchemaUploadSchema,
    relayStatus: true,
  }),
);
router.post(
  "/report-schemas/:id/compile",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/compile`,
    paramsSchema: idParamsSchema,
    schema: z.object({}).strict(),
  }),
);
router.post(
  "/report-schemas/:id/simulate",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/simulate`,
    paramsSchema: idParamsSchema,
    schema: reportSimulateSchema,
  }),
);
router.post(
  "/report-schemas/:id/promote",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/promote`,
    paramsSchema: idParamsSchema,
    schema: reportSchemaPromoteSchema,
    relayStatus: true,
  }),
);
const schemaDraftSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    definitionText: z.string().min(1).max(2_000_000).optional(),
    mappingBlueprint: zJsonObject.optional(),
    sampleContext: zJsonObject.optional(),
    templateBase64: z.string().max(20_000_000).optional(),
    notes: z.string().max(4000).optional(),
    baseRevision: z.number().int().min(1).optional(),
  })
  .strict();
const schemaValidateSchema = z
  .object({
    definitionText: z.string().min(1).max(2_000_000).optional(),
    mappingBlueprint: zJsonObject.optional(),
    sampleContext: zJsonObject.optional(),
    context: zJsonObject.optional(),
    format: z.enum(["XML", "XLSX", "DOCX"]).optional(),
  })
  .strict();
const sampleContextSchema = z
  .object({
    sourceType: z.enum(["SCHEMA", "PAYMENT_ATTEMPT", "AML_CASE", "REGULATORY_REPORT"]).default("SCHEMA"),
    sourceId: zIdentifier.optional(),
    includePii: z.boolean().default(false),
  })
  .strict();
const codeListPreviewSchema = z
  .object({
    mappingBlueprint: zJsonObject.optional(),
    codeMapKey: z.string().max(120).optional(),
    values: z.array(z.string()).max(500).optional(),
  })
  .strict();
const templateSchema = z.object({ templateBase64: z.string().max(20_000_000), templateBinding: zJsonObject.optional() }).strict();
const ruleBindingsSchema = z
  .object({ bindings: z.array(z.object({ format: z.enum(["XML", "XLSX", "DOCX"]), schemaId: zIdentifier })).max(3) })
  .strict();

router.put(
  "/report-schemas/:id",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
    schema: schemaDraftSchema,
  }),
);
router.post(
  "/report-schemas/:id/clone",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/clone`,
    paramsSchema: idParamsSchema,
    schema: z.object({
      version: z.number().int().min(1).max(10000).optional(),
      name: z.string().min(2).max(200).optional(),
      notes: z.string().max(4000).optional(),
      copySample: z.boolean().default(false),
    }).strict(),
    relayStatus: true,
  }),
);
router.post(
  "/report-schemas/validate",
  coreForward({ method: "POST", path: () => "/internal/admin/aml/report-schemas/validate", schema: schemaValidateSchema }),
);
router.post(
  "/report-schemas/:id/validate",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/validate`,
    paramsSchema: idParamsSchema,
    schema: schemaValidateSchema,
  }),
);
router.post(
  "/report-schemas/:id/sample-context",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/sample-context`,
    paramsSchema: idParamsSchema,
    schema: sampleContextSchema,
  }),
);
router.post(
  "/report-schemas/:id/code-lists/preview",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/code-lists/preview`,
    paramsSchema: idParamsSchema,
    schema: codeListPreviewSchema,
  }),
);
router.post(
  "/report-schemas/:id/template/analyze",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/template/analyze`,
    paramsSchema: idParamsSchema,
    schema: z.object({ templateBase64: z.string().max(20_000_000).optional() }).strict(),
  }),
);
router.post(
  "/report-schemas/:id/template/upload",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/template/upload`,
    paramsSchema: idParamsSchema,
    schema: templateSchema,
    relayStatus: true,
  }),
);
router.delete(
  "/report-schemas/:id/template",
  coreForward({
    method: "DELETE",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/template`,
    paramsSchema: idParamsSchema,
  }),
);
router.get(
  "/report-schemas/:id/template",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/template`,
    paramsSchema: idParamsSchema,
  }),
);
router.put(
  "/report-schemas/:id/template",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/template`,
    paramsSchema: idParamsSchema,
    schema: templateSchema,
  }),
);
router.post(
  "/report-schemas/:id/workbook/preview",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/report-schemas/${encodeURIComponent(context.params.id ?? "")}/workbook/preview`,
    paramsSchema: idParamsSchema,
    schema: reportSimulateSchema,
  }),
);
router.get(
  "/reporting-rules/:id/schema-bindings",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/reporting-rules/${encodeURIComponent(context.params.id ?? "")}/schema-bindings`,
    paramsSchema: idParamsSchema,
  }),
);
router.put(
  "/reporting-rules/:id/schema-bindings",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/admin/aml/reporting-rules/${encodeURIComponent(context.params.id ?? "")}/schema-bindings`,
    paramsSchema: idParamsSchema,
    schema: ruleBindingsSchema,
    relayStatus: true,
  }),
);
router.get(
  "/reports/:id/requirements",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/requirements`,
    paramsSchema: idParamsSchema,
  }),
);
router.get("/report-schema-defaults", coreForward({ method: "GET", path: () => "/internal/admin/aml/report-schema-defaults" }));
router.put(
  "/report-schema-defaults",
  coreForward({
    method: "PUT",
    path: () => "/internal/admin/aml/report-schema-defaults",
    schema: reportSchemaDefaultSchema,
    relayStatus: true,
  }),
);
router.get(
  "/reports/:id/payload",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/payload`,
    paramsSchema: idParamsSchema,
  }),
);
const reportNarrativeSchema = z.object({ narrative: z.record(z.string().max(80), z.string().max(20_000)), basePayloadSha256: z.string().length(64).optional() }).strict();
router.patch(
  "/reports/:id/payload",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/payload`,
    paramsSchema: idParamsSchema,
    schema: reportNarrativeSchema,
  }),
);
router.post(
  "/reports/:id/generate-output",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/generate-output`,
    paramsSchema: idParamsSchema,
    schema: reportGenerateSchema,
  }),
);
router.post(
  "/reports/:id/request-approval",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/request-approval`,
    paramsSchema: idParamsSchema,
    schema: z.object({}).strict(),
    relayStatus: true,
  }),
);
router.get(
  "/reports/:id/outputs/:format/download",
  coreForwardRaw({
    method: "GET",
    path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/outputs/${encodeURIComponent(context.params.format ?? "")}/download`,
    paramsSchema: reportIdFormatParams,
  }),
);


const incidentSeveritySchema = z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]);
const incidentStatusSchema = z.enum(["DETECTED", "TRIAGED", "DECLARED", "CONTAINED", "MONITORING", "RESOLVED", "POSTMORTEM", "CLOSED"]);
const incidentCategorySchema = z.enum(["AVAILABILITY", "DATA_INTEGRITY", "SECURITY", "FRAUD", "COMPLIANCE", "THIRD_PARTY", "PAYMENT_PROCESSING", "OTHER"]);
const incidentImpactSchema = z.enum(["PLATFORM", "MERCHANT", "CHECKOUT", "ADMIN", "MULTI_TENANT"]);
const incidentLinkTypeSchema = z.enum(["ATTEMPT", "MERCHANT", "RAIL", "GATEWAY", "REPORT", "CASE", "OTHER"]);
const incidentIdParams = z.object({ id: zIdentifier });
const incidentQuerySchema = z.object({
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  category: incidentCategorySchema.optional(),
}).strict();
const incidentChildParams = z.object({ id: zIdentifier, childId: zIdentifier });

const incidentCreateSchema = z.object({
  title: z.string().min(3).max(300),
  summary: z.string().max(20_000).optional(),
  category: incidentCategorySchema.default("OTHER"),
  severity: incidentSeveritySchema.default("SEV3"),
  impactScope: incidentImpactSchema.default("PLATFORM"),
  detectedAt: z.string().max(64).optional(),
  commanderUserId: zIdentifier.optional(),
  affectedServices: z.array(z.string().min(1).max(120)).max(100).default([]),
  affectedMerchantIds: z.array(zIdentifier).max(500).default([]),
  affectedAttemptIds: z.array(zIdentifier).max(500).default([]),
  regulatorsNotified: z.boolean().default(false),
}).strict();

const incidentPatchSchema = z.object({
  title: z.string().min(3).max(300).optional(),
  summary: z.string().max(20_000).nullable().optional(),
  category: incidentCategorySchema.optional(),
  severity: incidentSeveritySchema.optional(),
  impactScope: incidentImpactSchema.optional(),
  commanderUserId: zIdentifier.nullable().optional(),
  affectedServices: z.array(z.string().min(1).max(120)).max(100).optional(),
  affectedMerchantIds: z.array(zIdentifier).max(500).optional(),
  affectedAttemptIds: z.array(zIdentifier).max(500).optional(),
  regulatorsNotified: z.boolean().optional(),
  rootCause: z.string().max(20_000).nullable().optional(),
  postmortemSummary: z.string().max(50_000).nullable().optional(),
  postmortemJson: zJsonObject.nullable().optional(),
}).strict();

const incidentTimelineSchema = z.object({
  type: z.enum(["DETECTED", "DECLARED", "STATUS_CHANGE", "NOTE", "ESCALATION", "COMMUNICATION", "ACTION", "REGULATORY"]).default("NOTE"),
  summary: z.string().min(1).max(5000),
  detailJson: zJsonObject.optional(),
  occurredAt: z.string().max(64).optional(),
}).strict();

const incidentResponderSchema = z.object({ userId: zIdentifier.optional(), name: z.string().min(1).max(200), role: z.string().min(1).max(120), isCommander: z.boolean().default(false) }).strict();
const incidentActionSchema = z.object({ title: z.string().min(1).max(500), ownerUserId: zIdentifier.optional(), priority: z.number().int().min(1).max(4).default(3), dueAt: z.string().max(64).optional(), notes: z.string().max(5000).optional() }).strict();
const incidentActionPatchSchema = z.object({ title: z.string().min(1).max(500).optional(), ownerUserId: zIdentifier.nullable().optional(), priority: z.number().int().min(1).max(4).optional(), status: z.enum(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]).optional(), dueAt: z.string().max(64).nullable().optional(), notes: z.string().max(5000).nullable().optional() }).strict();
const incidentLinkSchema = z.object({ linkType: incidentLinkTypeSchema, targetId: z.string().min(1).max(200), label: z.string().max(300).optional() }).strict();
const incidentCommunicationSchema = z.object({ channel: z.enum(["STATUS_PAGE", "EMAIL", "SMS", "REGULATOR", "INTERNAL"]), audience: z.string().min(1).max(500), subject: z.string().min(1).max(500), body: z.string().min(1).max(50_000) }).strict();

router.get("/incidents", coreForward({ method: "GET", path: () => "/internal/admin/incidents", querySchema: incidentQuerySchema }));
router.post("/incidents", coreForward({ method: "POST", path: () => "/internal/admin/incidents", schema: incidentCreateSchema, relayStatus: true }));
router.get("/incidents/:id", coreForward({ method: "GET", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}`, paramsSchema: incidentIdParams }));
router.patch("/incidents/:id", coreForward({ method: "PATCH", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}`, paramsSchema: incidentIdParams, schema: incidentPatchSchema, relayStatus: true }));
router.post("/incidents/:id/transition", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/transition`, paramsSchema: incidentIdParams, schema: z.object({ status: incidentStatusSchema, note: z.string().max(5000).optional() }).strict(), relayStatus: true }));
router.post("/incidents/:id/timeline", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/timeline`, paramsSchema: incidentIdParams, schema: incidentTimelineSchema, relayStatus: true }));
router.post("/incidents/:id/responders", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/responders`, paramsSchema: incidentIdParams, schema: incidentResponderSchema, relayStatus: true }));
router.patch("/incidents/:id/responders/:childId", coreForward({ method: "PATCH", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/responders/${encodeURIComponent(context.params.childId ?? "")}`, paramsSchema: incidentChildParams, schema: z.object({ acknowledged: z.boolean().optional(), released: z.boolean().optional() }).strict(), relayStatus: true }));
router.post("/incidents/:id/actions", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/actions`, paramsSchema: incidentIdParams, schema: incidentActionSchema, relayStatus: true }));
router.patch("/incidents/:id/actions/:childId", coreForward({ method: "PATCH", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/actions/${encodeURIComponent(context.params.childId ?? "")}`, paramsSchema: incidentChildParams, schema: incidentActionPatchSchema, relayStatus: true }));
router.post("/incidents/:id/links", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/links`, paramsSchema: incidentIdParams, schema: incidentLinkSchema, relayStatus: true }));
router.delete("/incidents/:id/links/:childId", coreForward({ method: "DELETE", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/links/${encodeURIComponent(context.params.childId ?? "")}`, paramsSchema: incidentChildParams, relayStatus: true }));
router.post("/incidents/:id/communications", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/communications`, paramsSchema: incidentIdParams, schema: incidentCommunicationSchema, relayStatus: true }));
router.post("/incidents/:id/report", coreForward({ method: "POST", path: (context) => `/internal/admin/incidents/${encodeURIComponent(context.params.id ?? "")}/report`, paramsSchema: incidentIdParams, schema: z.object({}).strict(), relayStatus: true }));



const filingAdapterSchema = z.object({
  name: z.string().min(2).max(120),
  authority: z.string().min(2).max(64).optional(),
  kind: z.enum(["MANUAL", "HTTP"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  endpointUrl: z.string().url().max(500).nullable().optional(),
  authHeaderName: z.string().min(2).max(80).nullable().optional(),
  authSecret: z.string().min(4).max(4000).nullable().optional(),
  timeoutSeconds: z.number().int().min(5).max(120).optional(),
  configJson: zJsonObject.nullable().optional(),
}).strict();

router.get("/filing-adapters", coreForward({ method: "GET", path: () => "/internal/admin/aml/filing-adapters" }));
router.post("/filing-adapters", coreForward({ method: "POST", path: () => "/internal/admin/aml/filing-adapters", schema: filingAdapterSchema, relayStatus: true }));
router.patch("/filing-adapters/:id", coreForward({ method: "PATCH", path: (context) => `/internal/admin/aml/filing-adapters/${encodeURIComponent(context.params.id ?? "")}`, paramsSchema: incidentIdParams, schema: filingAdapterSchema.partial(), relayStatus: true }));
router.delete("/filing-adapters/:id", coreForward({ method: "DELETE", path: (context) => `/internal/admin/aml/filing-adapters/${encodeURIComponent(context.params.id ?? "")}`, paramsSchema: incidentIdParams, relayStatus: true }));
router.get("/reports/:id/submissions", coreForward({ method: "GET", path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/submissions`, paramsSchema: incidentIdParams }));
router.post("/reports/:id/file", coreForward({ method: "POST", path: (context) => `/internal/admin/aml/reports/${encodeURIComponent(context.params.id ?? "")}/file`, paramsSchema: incidentIdParams, schema: z.object({ adapterId: zIdentifier, checklist: z.array(z.enum(["REPORT_APPROVED_VERIFIED", "AUTHORITY_REFERENCE_VERIFIED", "DEADLINE_VERIFIED", "PAYLOAD_DIGEST_VERIFIED"])).max(10).optional() }).strict(), relayStatus: true }));


export const amlRouter = router;
