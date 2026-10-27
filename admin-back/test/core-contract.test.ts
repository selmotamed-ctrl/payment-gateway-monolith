import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CORE_SCHEMAS } from "./helpers/core-schema";
import {
  toCoreAdjustmentCreate,
  toCoreAmlCasePropose,
  toCoreAmlMatchDisposition,
  toCoreAmlReport,
  toCoreAmlReportingRule,
  toCoreAmlRule,
  toCoreApprovalApprove,
  toCoreApprovalReject,
  toCoreAssetCreate,
  toCoreCashoutProcess,
  toCoreCommissionProfileCreate,
  toCoreDisputeCreate,
  toCoreGatewayCreate,
  toCoreGatewayRollback,
  toCoreGatewayUpdate,
  toCoreGatewayVersionAuth,
  toCoreGatewayVersionChannels,
  toCoreGatewayVersionCryptoProfiles,
  toCoreGatewayVersionCreate,
  toCoreGatewayVersionDryRun,
  toCoreGatewayVersionEnvironments,
  toCoreGatewayVersionErrorMaps,
  toCoreGatewayVersionFlows,
  toCoreGatewayVersionRunSuite,
  toCoreGatewayVersionSettings,
  toCoreGatewayVersionStatusRules,
  toCoreJoinRequestAssign,
  toCoreJoinRequestDecide,
  toCoreJoinRequestRequestInfo,
  toCoreKybDocumentReview,
  toCoreMerchantProposeEdit,
  toCoreMerchantReinstate,
  toCoreMerchantSuspend,
  toCoreOperatorCaseResolve,
  toCoreRailCreate,
  toCoreRailFields,
  toCoreRailUpdate,
  toCoreReconciliationSourceCreate,
  toCoreReconciliationUpload,
  toCoreRouteCreate,
  toCoreRouteState,
  toCoreRouteUpdate,
  toCoreSettingsUpdate,
  toCoreUserCreate,
  toCoreUserUpdate,
  toCoreUserUpdates,
  toCoreVelocityRuleCreate,
  type JsonRecord,
} from "../api/contract";
import {
  authSchema,
  channelsSchema,
  cryptoProfilesSchema,
  dryRunSchema,
  environmentsSchema,
  errorMapsSchema,
  flowsSchema,
  gatewayCreateSchema,
  gatewayPatchSchema,
  rollbackSchema,
  runSuiteSchema,
  settingsSchema,
  statusRulesSchema,
  versionCreateSchema,
} from "../api/protected/gateways";
import {
  caseProposeSchema,
  dispositionSchema,
  reportSchema,
  reportingRuleSchema,
  ruleSchema,
} from "../api/protected/aml";
import { decisionSchema as approvalDecisionSchema } from "../api/protected/approvals";
import {
  assignSchema,
  decideSchema,
  kybReviewSchema,
  requestInfoSchema,
} from "../api/protected/joinRequests";
import {
  proposeEditSchema,
  reinstateSchema,
  suspendSchema,
} from "../api/protected/merchants";
import {
  userBulkPatchSchema,
  userCreateSchema,
  userPatchSchema,
} from "../api/protected/users";
import {
  railCreateSchema,
  railFieldsSchema,
  railPatchSchema,
  routeCreateSchema,
  routePatchSchema,
  routeStateSchema,
} from "../api/protected/rails";
import { assetCreateSchema } from "../api/protected/assets";
import { resolveSchema } from "../api/protected/operations";
import { sourceCreateSchema, uploadSchema } from "../api/protected/reconciliation";
import {
  adjustmentCreateSchema,
  cashoutProcessSchema,
  commissionProfileSchema,
  disputeCreateSchema,
  velocityRuleSchema,
} from "../api/protected/finance";
import { settingsUpdateSchema } from "../api/protected/settings";

/**
 * The allowed key lists are transcribed from the canonical core schemas in
 * `core-back/api/internal/admin.ts`. Core validates the forwarded body with a `.strict()`
 * object, so any key outside of these lists makes core answer `400 VALIDATION_FAILED`.
 */
interface ContractCase {
  route: string;
  mapper: (body: unknown) => JsonRecord;
  publicSchema: z.ZodType;
  legacyPayload: unknown;
  allowedKeys: string[];
  requiredKeys: string[];
}

const cases: ContractCase[] = [
  {
    route: "POST /gateways",
    mapper: toCoreGatewayCreate,
    publicSchema: gatewayCreateSchema,
    legacyPayload: {
      code: "GW1",
      name: "Gateway one",
      description: "primary acquirer",
      category: "ACQUIRER",
      country: "LY",
      evidenceLevel: "VERIFIED",
      active: true,
    },
    allowedKeys: [
      "code",
      "name",
      "operator",
      "country",
      "aliases",
      "kind",
      "verificationState",
      "riskClass",
    ],
    requiredKeys: ["code", "name", "operator", "kind"],
  },
  {
    route: "PATCH /gateways/:id",
    mapper: toCoreGatewayUpdate,
    publicSchema: gatewayPatchSchema,
    legacyPayload: { name: "Gateway two", description: "renamed", evidenceLevel: "PARTIAL" },
    allowedKeys: ["name", "operator", "aliases", "verificationState", "riskClass"],
    requiredKeys: [],
  },
  {
    route: "POST /gateways/:id/versions",
    mapper: toCoreGatewayVersionCreate,
    publicSchema: versionCreateSchema,
    legacyPayload: { version: 3, basedOnVersionId: "gv_2", changelog: "new routes", active: true },
    allowedKeys: ["changeNote", "snapshot"],
    requiredKeys: [],
  },
  {
    route: "POST /gateways/:id/rollback",
    mapper: toCoreGatewayRollback,
    publicSchema: rollbackSchema,
    legacyPayload: { targetVersionId: "gv_1", reason: "rollback" },
    allowedKeys: ["versionId"],
    requiredKeys: ["versionId"],
  },
  {
    route: "PUT /gateway-versions/:vid/environments",
    mapper: toCoreGatewayVersionEnvironments,
    publicSchema: environmentsSchema,
    legacyPayload: {
      environments: [{ code: "live", baseUrl: "https://gw.example.com", active: true, timeoutMs: 5000 }],
    },
    allowedKeys: [
      "env",
      "baseUrls",
      "allowedHosts",
      "inboundIpAllowlist",
      "outboundEgressIps",
      "enabled",
    ],
    requiredKeys: ["env", "baseUrls", "allowedHosts"],
  },
  {
    route: "PUT /gateway-versions/:vid/auth",
    mapper: toCoreGatewayVersionAuth,
    publicSchema: authSchema,
    legacyPayload: { authMethod: "API_KEY", credentialSetId: "cs_1", settings: { headerName: "X-Key" } },
    allowedKeys: ["env", "method", "authApply", "refreshConfigJson"],
    requiredKeys: ["env", "method", "authApply"],
  },
  {
    route: "PUT /gateway-versions/:vid/settings",
    mapper: toCoreGatewayVersionSettings,
    publicSchema: settingsSchema,
    legacyPayload: { settings: { amountScale: 100, gatewayTimezone: "Africa/Tripoli" }, timeoutMs: 20000, retries: 2 },
    allowedKeys: [
      "amountScale",
      "amountPrecision",
      "amountRounding",
      "amountFormat",
      "referenceFormat",
      "sessionTtlSeconds",
      "otpTtlSeconds",
      "otpResendCooldownSeconds",
      "maxOtpAttempts",
      "supportsStatusCheck",
      "statusCheckMinAgeSeconds",
      "supportsIdempotencyKey",
      "supportsCancel",
      "rateLimitPerSecond",
      "concurrencyCap",
      "timeoutMs",
      "maxResponseBytes",
      "gatewayTimezone",
    ],
    requiredKeys: [
      "amountScale",
      "amountPrecision",
      "amountRounding",
      "amountFormat",
      "referenceFormat",
      "sessionTtlSeconds",
      "otpTtlSeconds",
      "otpResendCooldownSeconds",
    ],
  },
  {
    route: "PUT /gateway-versions/:vid/crypto-profiles",
    mapper: toCoreGatewayVersionCryptoProfiles,
    publicSchema: cryptoProfilesSchema,
    legacyPayload: {
      cryptoProfiles: [
        {
          code: "cp1",
          algorithm: "HMAC_SHA256",
          encoding: "HEX_UPPER",
          secretRef: "vault://hmac",
          fields: ["amount", "reference"],
        },
      ],
    },
    allowedKeys: ["profiles"],
    requiredKeys: ["profiles"],
  },
  {
    route: "PUT /gateway-versions/:vid/flows",
    mapper: toCoreGatewayVersionFlows,
    publicSchema: flowsSchema,
    legacyPayload: {
      flows: [
        {
          code: "f1",
          name: "otp flow",
          phases: ["INITIATE", "VERIFY"],
          steps: [{ type: "HTTP", method: "POST", urlTemplate: "https://gw.example.com/pay" }],
        },
      ],
    },
    allowedKeys: ["flows"],
    requiredKeys: ["flows"],
  },
  {
    route: "PUT /gateway-versions/:vid/channels",
    mapper: toCoreGatewayVersionChannels,
    publicSchema: channelsSchema,
    legacyPayload: {
      confirmationChannels: [{ type: "WEBHOOK", pathToken: "tok_abcdefgh", bodyFormat: "JSON" }],
      pollPolicies: [{ pathToken: "poll_abcdefgh" }],
    },
    allowedKeys: ["channels"],
    requiredKeys: ["channels"],
  },
  {
    route: "PUT /gateway-versions/:vid/status-rules",
    mapper: toCoreGatewayVersionStatusRules,
    publicSchema: statusRulesSchema,
    legacyPayload: { statusRules: [{ phase: "VERIFY", selector: "status", op: "equals", value: "OK" }] },
    allowedKeys: ["rules"],
    requiredKeys: ["rules"],
  },
  {
    route: "PUT /gateway-versions/:vid/error-maps",
    mapper: toCoreGatewayVersionErrorMaps,
    publicSchema: errorMapsSchema,
    legacyPayload: { errorMaps: [{ code: "E1", classification: "TERMINAL_DECLINE" }] },
    allowedKeys: ["maps"],
    requiredKeys: ["maps"],
  },
  {
    route: "POST /gateway-versions/:vid/dry-run",
    mapper: toCoreGatewayVersionDryRun,
    publicSchema: dryRunSchema,
    legacyPayload: { scenario: "otp-success", payload: { railCode: "CIB", amount: "10.0000", currency: "LYD" } },
    allowedKeys: ["railCode", "amount", "currency"],
    requiredKeys: [],
  },
  {
    route: "POST /gateway-versions/:vid/run-suite",
    mapper: toCoreGatewayVersionRunSuite,
    publicSchema: runSuiteSchema,
    legacyPayload: { suite: "CONTRACT_AMOUNT", environment: "sandbox" },
    allowedKeys: ["scenarios"],
    requiredKeys: [],
  },
  {
    route: "POST /users",
    mapper: toCoreUserCreate,
    publicSchema: userCreateSchema,
    legacyPayload: {
      email: "admin@example.com",
      fullName: "Admin",
      role: "FINANCE",
      phone: "+218910000000",
      locale: "en",
      temporaryPassword: "Str0ngPassw0rd",
      authorities: { aml: ["read", "write"] },
    },
    allowedKeys: ["email", "phone", "password", "role", "authoritiesMap", "isMaker", "isChecker"],
    requiredKeys: ["email", "role"],
  },
  {
    route: "PATCH /users",
    mapper: (body) => toCoreUserUpdates(body)[0] ?? {},
    publicSchema: userBulkPatchSchema,
    legacyPayload: { userIds: ["usr_1", "usr_2"], role: "SUPPORT", status: "SUSPENDED", reason: "audit" },
    allowedKeys: ["id", "authoritiesMap", "role", "status", "isMaker", "isChecker"],
    requiredKeys: ["id"],
  },
  {
    route: "PATCH /users/:id",
    mapper: toCoreUserUpdate,
    publicSchema: userPatchSchema,
    legacyPayload: { fullName: "Admin two", role: "FINANCE", status: "LOCKED", locale: "ar" },
    allowedKeys: ["authoritiesMap", "role", "status"],
    requiredKeys: [],
  },
  {
    route: "POST /join-requests/:id/assign",
    mapper: toCoreJoinRequestAssign,
    publicSchema: assignSchema,
    legacyPayload: { assigneeUserId: "usr_1", dueAt: "2026-02-01T00:00:00Z", note: "please review" },
    allowedKeys: ["reviewerId"],
    requiredKeys: ["reviewerId"],
  },
  {
    route: "POST /join-requests/:id/request-info",
    mapper: toCoreJoinRequestRequestInfo,
    publicSchema: requestInfoSchema,
    legacyPayload: { requestedItems: ["national_id", "bank_statement"], message: "please upload" },
    allowedKeys: ["items"],
    requiredKeys: ["items"],
  },
  {
    route: "POST /join-requests/:id/decide",
    mapper: toCoreJoinRequestDecide,
    publicSchema: decideSchema,
    legacyPayload: { decision: "APPROVE", reason: "kyb complete", notes: "looks good" },
    allowedKeys: ["decision", "reasonCode", "notes", "proposedRiskTier"],
    requiredKeys: ["decision"],
  },
  {
    route: "POST /kyb-documents/:id/review",
    mapper: toCoreKybDocumentReview,
    publicSchema: kybReviewSchema,
    legacyPayload: { decision: "ACCEPT", checklist: ["readable"], notes: "document is fine" },
    allowedKeys: ["decision", "reasonCode", "expiresOn"],
    requiredKeys: ["decision"],
  },
  {
    route: "POST /merchants/:id/suspend",
    mapper: toCoreMerchantSuspend,
    publicSchema: suspendSchema,
    legacyPayload: { reason: "suspected fraud", emergency: true, ratifyWithinHours: 24 },
    allowedKeys: ["reasonCode", "notes"],
    requiredKeys: ["reasonCode"],
  },
  {
    route: "POST /merchants/:id/reinstate",
    mapper: toCoreMerchantReinstate,
    publicSchema: reinstateSchema,
    legacyPayload: { reason: "case cleared", baseVersion: 4 },
    allowedKeys: [],
    requiredKeys: [],
  },
  {
    route: "POST /merchants/:id/propose-edit",
    mapper: toCoreMerchantProposeEdit,
    publicSchema: proposeEditSchema,
    legacyPayload: {
      reason: "typo",
      patch: [{ op: "replace", path: "/name", value: "Acme Ltd" }],
      baseVersion: 1,
    },
    allowedKeys: ["patch"],
    requiredKeys: ["patch"],
  },
  {
    route: "POST /approvals/:id/approve",
    mapper: toCoreApprovalApprove,
    publicSchema: approvalDecisionSchema,
    legacyPayload: { reason: "checked", checkerUserId: "usr_9", baseVersion: 2, comment: "ok" },
    allowedKeys: ["notes", "riskAcceptanceNote", "outcome"],
    requiredKeys: [],
  },
  {
    route: "POST /approvals/:id/reject",
    mapper: toCoreApprovalReject,
    publicSchema: approvalDecisionSchema,
    legacyPayload: { reason: "not checked", checkerUserId: "usr_9", baseVersion: 2, comment: "no" },
    allowedKeys: ["reason"],
    requiredKeys: ["reason"],
  },
  {
    route: "POST /aml/matches/:id/disposition",
    mapper: toCoreAmlMatchDisposition,
    publicSchema: dispositionSchema,
    legacyPayload: { disposition: "CONFIRMED_MATCH", notes: "real match", caseId: "aml_case_1" },
    allowedKeys: ["disposition", "notes", "suppressFuture", "suppressUntil"],
    requiredKeys: ["disposition"],
  },
  {
    route: "POST /aml/cases/:id/propose",
    mapper: toCoreAmlCasePropose,
    publicSchema: caseProposeSchema,
    legacyPayload: {
      severity: "HIGH",
      action: "AML_HOLD",
      reason: "structuring",
      notes: "hold the funds",
      reportingRuleId: "rr_1",
    },
    allowedKeys: ["action", "notes"],
    requiredKeys: ["action"],
  },
  {
    route: "POST /aml/rules",
    mapper: toCoreAmlRule,
    publicSchema: ruleSchema,
    legacyPayload: {
      code: "R1",
      name: "rule",
      layer: 3,
      type: "SINGLE_AMOUNT",
      parameters: { amount: "1000.0000" },
      action: "BLOCK",
      active: true,
    },
    allowedKeys: [
      "code",
      "name",
      "ruleType",
      "scope",
      "params",
      "action",
      "baseSeverity",
      "effectiveFrom",
    ],
    requiredKeys: ["code", "name", "ruleType", "action", "baseSeverity"],
  },
  {
    route: "POST /aml/reporting-rules",
    mapper: toCoreAmlReportingRule,
    publicSchema: reportingRuleSchema,
    legacyPayload: {
      code: "CBL_LARGE",
      name: "cbl large transaction",
      mode: "PROVISIONAL",
      threshold: "1000.0000",
      currency: "LYD",
      windowDays: 30,
      active: true,
    },
    allowedKeys: [
      "reportType",
      "thresholdAmount",
      "windowSeconds",
      "currency",
      "conditions",
      "sourceReference",
      "status",
    ],
    requiredKeys: ["reportType", "sourceReference"],
  },
  {
    route: "POST /aml/reports",
    mapper: toCoreAmlReport,
    publicSchema: reportSchema,
    legacyPayload: {
      reportingRuleId: "rr_1",
      caseId: "aml_case_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      notes: "monthly filing",
    },
    allowedKeys: ["reportType", "authority", "subjectType", "subjectId", "amlCaseId", "payload"],
    requiredKeys: ["reportType", "subjectType", "subjectId", "payload"],
  },
  {
    route: "POST /rails",
    mapper: toCoreRailCreate,
    publicSchema: railCreateSchema,
    legacyPayload: {
      code: "RAIL1",
      name: "Rail one",
      gatewayId: "gw_1",
      collectionMode: "REDIRECT",
      subModes: ["card"],
      feeBearer: "PAYER",
      active: true,
      labels: { ar: "rail" },
    },
    allowedKeys: [
      "code",
      "nameAr",
      "nameEn",
      "collectionMode",
      "subModes",
      "currency",
      "minAmount",
      "maxAmount",
      "displayOrder",
      "capabilities",
      "refundWindowDays",
      "instructionsAr",
      "instructionsEn",
    ],
    requiredKeys: ["code", "nameAr", "nameEn", "collectionMode"],
  },
  {
    route: "PATCH /rails/:id",
    mapper: toCoreRailUpdate,
    publicSchema: railPatchSchema,
    legacyPayload: {
      name: "Rail two",
      subModes: ["card"],
      feeBearer: "MERCHANT",
      active: false,
      labels: { ar: "rail" },
      baseVersion: 3,
    },
    allowedKeys: [
      "nameAr",
      "nameEn",
      "blocked",
      "displayOrder",
      "minAmount",
      "maxAmount",
      "capabilities",
      "instructionsAr",
      "instructionsEn",
    ],
    requiredKeys: [],
  },
  {
    route: "PUT /rails/:id/fields",
    mapper: toCoreRailFields,
    publicSchema: railFieldsSchema,
    legacyPayload: {
      fields: [
        {
          code: "phone-number",
          label: "Phone",
          type: "PHONE",
          required: true,
          pattern: "^\\d+$",
          minLength: 5,
          maxLength: 20,
          sensitive: true,
          order: 2,
        },
      ],
    },
    allowedKeys: ["fields"],
    requiredKeys: ["fields"],
  },
  {
    route: "POST /routes",
    mapper: toCoreRouteCreate,
    publicSchema: routeCreateSchema,
    legacyPayload: {
      railId: "rail_1",
      gatewayId: "gw_1",
      environment: "live",
      priority: 5,
      costModel: { fixed: "1.0000" },
      limitAmount: "100.0000",
      limitCurrency: "LYD",
      active: true,
      credentialPolicy: "MERCHANT_OR_PLATFORM",
    },
    allowedKeys: [
      "railId",
      "gatewayId",
      "credentialPolicy",
      "priority",
      "routingStrategy",
      "weight",
      "costModel",
      "mismatchPolicy",
      "minAmount",
      "maxAmount",
      "dailyCapAmount",
      "scope",
    ],
    requiredKeys: ["railId", "gatewayId", "credentialPolicy"],
  },
  {
    route: "PATCH /routes/:id",
    mapper: toCoreRouteUpdate,
    publicSchema: routePatchSchema,
    legacyPayload: {
      priority: 7,
      costModel: { fixed: "2.0000" },
      limitAmount: "50.0000",
      limitCurrency: "LYD",
      baseVersion: 2,
    },
    allowedKeys: [
      "priority",
      "weight",
      "minAmount",
      "maxAmount",
      "dailyCapAmount",
      "scope",
      "costModel",
    ],
    requiredKeys: [],
  },
  {
    route: "POST /routes/:id/state",
    mapper: toCoreRouteState,
    publicSchema: routeStateSchema,
    legacyPayload: { state: "DRAINING", reason: "maintenance window" },
    allowedKeys: ["status", "reason"],
    requiredKeys: ["status"],
  },
  {
    route: "POST /assets",
    mapper: toCoreAssetCreate,
    publicSchema: assetCreateSchema,
    legacyPayload: {
      kind: "LOGO",
      name: "logo",
      contentType: "image/png",
      storageKey: "assets/logo.png",
      sizeBytes: 1024,
      checksumSha256: "a".repeat(64),
      metadata: { alt: "logo" },
    },
    allowedKeys: ["name", "mime", "sizeBytes", "storageKey", "sha256"],
    requiredKeys: ["name", "mime", "sizeBytes", "storageKey", "sha256"],
  },
  {
    route: "POST /operator-cases/:id/resolve",
    mapper: toCoreOperatorCaseResolve,
    publicSchema: resolveSchema,
    legacyPayload: {
      resolution: "RETRY_INQUIRE",
      reason: "unknown state",
      notes: "retried the inquiry",
      operatorNote: "operator took over",
    },
    allowedKeys: ["resolution", "state"],
    requiredKeys: ["resolution"],
  },
  {
    route: "POST /reconciliation/sources",
    mapper: toCoreReconciliationSourceCreate,
    publicSchema: sourceCreateSchema,
    legacyPayload: {
      code: "SRC1",
      name: "source",
      gatewayId: "gw_1",
      fileType: "CSV",
      delimiter: ",",
      hasHeader: true,
      columnMapping: { amount: "amt" },
      dateFormat: "YYYY-MM-DD",
      active: true,
      type: "UPLOAD",
    },
    allowedKeys: [
      "gatewayId",
      "type",
      "scheduleCron",
      "parserConfig",
      "settlementLagDays",
      "dedupeKeyTemplate",
    ],
    requiredKeys: ["gatewayId", "type", "parserConfig"],
  },
  {
    route: "POST /reconciliation/upload",
    mapper: toCoreReconciliationUpload,
    publicSchema: uploadSchema,
    legacyPayload: {
      sourceId: "src_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      currency: "LYD",
      autoPost: false,
    },
    allowedKeys: ["sourceId", "periodStart", "periodEnd", "currency", "autoPost"],
    requiredKeys: ["sourceId"],
  },
  {
    route: "POST /disputes",
    mapper: toCoreDisputeCreate,
    publicSchema: disputeCreateSchema,
    legacyPayload: {
      merchantId: "mch_1",
      gatewayId: "gw_1",
      paymentReference: "PA-1",
      externalDisputeRef: "CB1",
      type: "CHARGEBACK",
      amount: "10.0000",
      currency: "LYD",
      reason: "fraud",
      dueAt: "2026-02-01",
      railId: "rail_1",
      source: "MANUAL",
    },
    allowedKeys: [
      "attemptId",
      "gatewayId",
      "railId",
      "externalDisputeRef",
      "source",
      "reasonCode",
      "amount",
      "currency",
    ],
    requiredKeys: [
      "attemptId",
      "gatewayId",
      "railId",
      "externalDisputeRef",
      "source",
      "amount",
      "currency",
    ],
  },
  {
    route: "POST /adjustments",
    mapper: toCoreAdjustmentCreate,
    publicSchema: adjustmentCreateSchema,
    legacyPayload: {
      disputeId: "dsp_1",
      merchantId: "mch_1",
      attemptId: "att_1",
      type: "CHARGEBACK",
      amount: "10.0000",
      currency: "LYD",
      reason: "chargeback",
      draft: false,
      targetGlAccountId: "gl_1",
    },
    allowedKeys: [
      "type",
      "targetGlAccountId",
      "sourceAttemptId",
      "disputeId",
      "amount",
      "reverseCommission",
      "reason",
      "externalDisputeRef",
    ],
    requiredKeys: ["type", "targetGlAccountId", "amount", "reason"],
  },
  {
    route: "POST /cashouts/:id/process",
    mapper: toCoreCashoutProcess,
    publicSchema: cashoutProcessSchema,
    legacyPayload: {
      decision: "APPROVE",
      reason: "verified the request",
      amount: "10.0000",
      currency: "LYD",
      executedBy: "usr_1",
    },
    allowedKeys: ["decision", "reason"],
    requiredKeys: ["decision"],
  },
  {
    route: "POST /commission-profiles",
    mapper: toCoreCommissionProfileCreate,
    publicSchema: commissionProfileSchema,
    legacyPayload: {
      code: "STD",
      name: "standard",
      model: "PERCENTAGE",
      percentage: "3.0000",
      flatAmount: "1.0000",
      tiers: [{ upTo: "100.0000", rate: "3.0000" }],
      currency: "LYD",
      active: true,
      railCode: "cib",
    },
    allowedKeys: [
      "merchantId",
      "applicationId",
      "railCode",
      "calcType",
      "flatFee",
      "percentageRate",
      "tiersJson",
      "minFee",
      "maxFee",
      "feeBearerDefault",
      "roundingMode",
      "effectiveFrom",
    ],
    requiredKeys: ["railCode", "calcType"],
  },
  {
    route: "POST /velocity-rules",
    mapper: toCoreVelocityRuleCreate,
    publicSchema: velocityRuleSchema,
    legacyPayload: {
      code: "V1",
      name: "velocity",
      scope: "IP",
      windowSeconds: 60,
      maxAttempts: 5,
      maxAmount: "100.0000",
      currency: "LYD",
      action: "BLOCK",
      active: true,
    },
    allowedKeys: ["scopeType", "scopeValue", "windowSeconds", "maxCount", "maxAmount", "action"],
    requiredKeys: ["scopeType", "windowSeconds", "maxCount", "action"],
  },
  {
    route: "PUT /settings",
    mapper: toCoreSettingsUpdate,
    publicSchema: settingsUpdateSchema,
    legacyPayload: {
      settings: {
        "join_request.four_eyes_policy": "RISK_BASED",
        limits: { max: 10 },
      },
      baseVersion: 3,
      reason: "policy change",
    },
    allowedKeys: ["settings"],
    requiredKeys: ["settings"],
  },
];

describe("core contract translation", () => {
  for (const contract of cases) {
    test(`${contract.route} only emits keys core accepts`, () => {
      const mapped = contract.mapper(contract.legacyPayload);
      for (const key of Object.keys(mapped)) {
        expect(contract.allowedKeys).toContain(key);
      }
    });

    test(`${contract.route} always emits the keys core requires`, () => {
      const mapped = contract.mapper(contract.legacyPayload);
      for (const key of contract.requiredKeys) {
        expect(Object.keys(mapped)).toContain(key);
        expect(mapped[key]).not.toBeUndefined();
      }
    });

    test(`${contract.route} is accepted by the canonical core schema`, () => {
      const coreSchema = CORE_SCHEMAS[contract.route];
      if (!coreSchema) throw new Error(`no core schema transcribed for ${contract.route}`);
      const parsed = coreSchema.safeParse(contract.mapper(contract.legacyPayload));
      if (!parsed.success) {
        console.error(parsed.error.issues);
      }
      expect(parsed.success).toBe(true);
    });

    test(`${contract.route} still accepts the legacy public payload`, () => {
      const parsed = contract.publicSchema.safeParse(contract.legacyPayload);
      expect(parsed.success).toBe(true);
    });
  }
});

describe("core contract field mapping", () => {
  test("gateway create lowers the code and derives the operator", () => {
    const mapped = toCoreGatewayCreate({
      code: "GW1",
      name: "Gateway one",
      category: "ACQUIRER",
      evidenceLevel: "PARTIAL",
    });
    expect(mapped.code).toBe("gw1");
    expect(mapped.operator).toBe("ACQUIRER");
    expect(mapped.kind).toBe("DIRECT");
    expect(mapped.verificationState).toBe("UNVERIFIED");
  });

  test("gateway create keeps an explicit operator and kind", () => {
    const mapped = toCoreGatewayCreate({
      code: "gw_2",
      name: "Gateway two",
      operator: "Salam Bank",
      kind: "NATIVE_ADAPTER",
      aliases: ["salam"],
      riskClass: "HIGH_RISK",
    });
    expect(mapped.operator).toBe("Salam Bank");
    expect(mapped.kind).toBe("NATIVE_ADAPTER");
    expect(mapped.aliases).toEqual(["salam"]);
    expect(mapped.riskClass).toBe("HIGH_RISK");
  });

  test("gateway version create keeps the changelog and the snapshot", () => {
    const mapped = toCoreGatewayVersionCreate({ version: 4, changelog: "new routes" });
    expect(mapped.changeNote).toBe("new routes");
    expect(mapped.snapshot).toEqual({ version: 4 });
  });

  test("environments derive the core environment, base urls and allowed hosts", () => {
    const mapped = toCoreGatewayVersionEnvironments({
      environments: [
        { code: "live", baseUrl: "https://gw.example.com/pay", active: true },
        { code: "sandbox", baseUrl: "https://sandbox.example.com/pay" },
      ],
    });
    expect(mapped.env).toBe("LIVE");
    expect(mapped.baseUrls).toEqual({ live: "https://gw.example.com/pay" });
    expect(mapped.allowedHosts).toEqual(["gw.example.com"]);
    expect(mapped.enabled).toBe(true);
  });

  test("auth maps the public auth method and carries the settings as refresh config", () => {
    const mapped = toCoreGatewayVersionAuth({
      authMethod: "TOKEN_ENDPOINT",
      settings: { tokenUrl: "https://gw.example.com/token" },
    });
    expect(mapped.method).toBe("TOKEN_ENDPOINT");
    expect(mapped.env).toBe("LIVE");
    expect(mapped.authApply).toBe("HEADER");
    expect(mapped.refreshConfigJson).toEqual({ tokenUrl: "https://gw.example.com/token" });
  });

  test("settings fall back to the documented core defaults", () => {
    const mapped = toCoreGatewayVersionSettings({ settings: {} });
    expect(mapped.amountScale).toBe(1);
    expect(mapped.amountPrecision).toBe(2);
    expect(mapped.amountRounding).toBe("NONE");
    expect(mapped.amountFormat).toBe("STRING_DECIMAL");
    expect(mapped.referenceFormat).toEqual({});
    expect(mapped.sessionTtlSeconds).toBe(1800);
    expect(mapped.otpTtlSeconds).toBe(300);
    expect(mapped.otpResendCooldownSeconds).toBe(60);
  });

  test("settings clamp the public timeout into the core range", () => {
    const mapped = toCoreGatewayVersionSettings({ settings: {}, timeoutMs: 250 });
    expect(mapped.timeoutMs).toBe(1000);
  });

  test("crypto profiles map the public encoding onto canonicalization and output", () => {
    const mapped = toCoreGatewayVersionCryptoProfiles({
      cryptoProfiles: [{ code: "cp1", algorithm: "PLAIN", encoding: "SORTED_KEY_VALUE_AMP" }],
    });
    const profile = (mapped.profiles as JsonRecord[])[0] as JsonRecord;
    expect(profile.name).toBe("cp1");
    expect(profile.algorithm).toBe("SHA256");
    expect(profile.canonicalizationMode).toBe("SORTED_KEY_VALUE_AMP");
    expect(profile.outputEncoding).toBe("HEX_LOWER");
  });

  test("flows expand the public phases into one core flow per phase", () => {
    const mapped = toCoreGatewayVersionFlows({
      flows: [{ code: "f1", name: "flow", phases: ["INITIATE", "VERIFY"], steps: [] }],
    });
    const flows = mapped.flows as JsonRecord[];
    expect(flows.map((flow) => flow.phase)).toEqual(["INITIATE", "VERIFY"]);
  });

  test("channels derive the weak verification policies and the path token", () => {
    const mapped = toCoreGatewayVersionChannels({
      confirmationChannels: [{ type: "RETURN_URL", pathToken: "return_token_1" }],
      pollPolicies: [{ pathToken: "poll_token_1" }],
    });
    const channels = mapped.channels as JsonRecord[];
    expect(channels).toHaveLength(2);
    expect(channels[0]?.type).toBe("RETURN_URL");
    expect(channels[0]?.mustInquire).toBe(true);
    expect(channels[1]?.type).toBe("POLL");
    expect(channels[1]?.verifyMethod).toBe("NONE_PLUS_INQUIRY");
  });

  test("status rules always carry a canonical status", () => {
    const mapped = toCoreGatewayVersionStatusRules({ statusRules: [{ code: "s1" }] });
    const rules = mapped.rules as JsonRecord[];
    expect(rules[0]?.canonicalStatus).toBe("UNKNOWN");
    expect(rules[0]?.op).toBe("equals");
    expect(rules[0]?.value).toBeNull();
  });

  test("error maps derive the gateway code and the classification", () => {
    const mapped = toCoreGatewayVersionErrorMaps({ errorMaps: [{ code: "e1" }] });
    const maps = mapped.maps as JsonRecord[];
    expect(maps[0]?.gatewayCode).toBe("e1");
    expect(maps[0]?.canonicalError).toBe("e1");
    expect(maps[0]?.classification).toBe("AMBIGUOUS");
  });

  test("dry run only forwards the core fields it understands", () => {
    const mapped = toCoreGatewayVersionDryRun({
      scenario: "otp-success",
      payload: { railCode: "CIB", amount: "10.0000", currency: "LYD", ignored: "x" },
    });
    expect(mapped).toEqual({ railCode: "CIB", amount: "10.0000", currency: "LYD" });
  });

  test("run suite forwards the suite as a core scenario", () => {
    const mapped = toCoreGatewayVersionRunSuite({ suite: "SANDBOX_15" });
    expect(mapped.scenarios).toEqual(["SANDBOX_15"]);
  });

  test("user create flattens the public authority map", () => {
    const mapped = toCoreUserCreate({
      email: "Admin@Example.com",
      fullName: "Admin",
      role: "COMPLIANCE",
      temporaryPassword: "Str0ngPassw0rd",
      authorities: { aml: ["read", "write"], kyb: "read" },
    });
    expect(mapped.email).toBe("admin@example.com");
    expect(mapped.role).toBe("COMPLIANCE");
    expect(mapped.password).toBe("Str0ngPassw0rd");
    expect(mapped.authoritiesMap).toEqual(["aml:read", "aml:write", "kyb:read"]);
  });

  test("user patch maps the locked status onto the core vocabulary", () => {
    const mapped = toCoreUserUpdate({ status: "LOCKED", role: "SUPPORT" });
    expect(mapped.status).toBe("SUSPENDED");
    expect(mapped.role).toBe("SUPPORT");
  });

  test("bulk user patch expands into one core request per user", () => {
    const mapped = toCoreUserUpdates({ userIds: ["usr_1", "usr_2"], role: "FINANCE" });
    expect(mapped).toEqual([
      { id: "usr_1", role: "FINANCE" },
      { id: "usr_2", role: "FINANCE" },
    ]);
  });

  test("join request assignment maps the assignee onto the core reviewer", () => {
    const mapped = toCoreJoinRequestAssign({ assigneeUserId: "usr_1", dueAt: "2026-02-01" });
    expect(mapped).toEqual({ reviewerId: "usr_1" });
  });

  test("join request info maps the requested items onto core items", () => {
    const mapped = toCoreJoinRequestRequestInfo({
      requestedItems: ["national_id"],
      message: "please upload",
    });
    expect(mapped.items).toEqual([{ field: "national_id", message: "please upload" }]);
  });

  test("join request decision maps approve onto the core decision", () => {
    const mapped = toCoreJoinRequestDecide({ decision: "APPROVE", reason: "kyb complete" });
    expect(mapped.decision).toBe("APPROVED");
    expect(mapped.reasonCode).toBe("kyb complete");
  });

  test("join request decision rejects the decisions core cannot express", () => {
    expect(() => toCoreJoinRequestDecide({ decision: "REQUEST_INFO", reason: "missing" })).toThrow();
    expect(() => toCoreJoinRequestDecide({ decision: "WITHDRAW", reason: "nope" })).toThrow();
  });

  test("kyb review maps accept onto the core decision", () => {
    const mapped = toCoreKybDocumentReview({ decision: "ACCEPT", notes: "document is fine" });
    expect(mapped.decision).toBe("ACCEPTED");
    expect(mapped.reasonCode).toBe("document is fine");
  });

  test("merchant suspend keeps the operator reason in the core notes", () => {
    const mapped = toCoreMerchantSuspend({ reason: "suspected fraud", emergency: true });
    expect(mapped.reasonCode).toBe("suspected fraud");
    expect(mapped.notes).toBe("suspected fraud");
  });

  test("merchant reinstate forwards an empty core body", () => {
    expect(toCoreMerchantReinstate({ reason: "cleared" })).toEqual({});
  });

  test("merchant propose edit forwards the json patch untouched", () => {
    const patch = [{ op: "replace", path: "/name", value: "Acme Ltd" }];
    expect(toCoreMerchantProposeEdit({ reason: "typo", patch, baseVersion: 1 })).toEqual({ patch });
  });

  test("approval approve maps the reason onto the core notes", () => {
    expect(toCoreApprovalApprove({ reason: "checked" })).toEqual({ notes: "checked" });
    expect(toCoreApprovalReject({ reason: "not checked" })).toEqual({ reason: "not checked" });
  });

  test("approval approve forwards the chargeback outcome and the risk acceptance", () => {
    expect(
      toCoreApprovalApprove({
        reason: "chargeback reviewed",
        outcome: "WON",
        riskAcceptanceNote: "the evidence is conclusive",
      }),
    ).toEqual({
      notes: "chargeback reviewed",
      outcome: "WON",
      riskAcceptanceNote: "the evidence is conclusive",
    });
    expect(toCoreApprovalApprove({ reason: "checked", outcome: "lost" })).toEqual({
      notes: "checked",
      outcome: "LOST",
    });
  });

  test("aml disposition maps the confirmed match onto the core vocabulary", () => {
    const mapped = toCoreAmlMatchDisposition({ disposition: "CONFIRMED_MATCH", notes: "real match" });
    expect(mapped.disposition).toBe("TRUE_MATCH");
    expect(mapped.notes).toBe("real match");
  });

  test("aml case proposal maps the hold action onto the core vocabulary", () => {
    const mapped = toCoreAmlCasePropose({ action: "AML_HOLD", reason: "structuring" });
    expect(mapped.action).toBe("HOLD");
    expect(mapped.notes).toBe("structuring");
  });

  test("aml rule maps the public action and severity onto the core vocabulary", () => {
    const mapped = toCoreAmlRule({
      code: "R1",
      name: "rule",
      layer: 3,
      type: "SINGLE_AMOUNT",
      parameters: { amount: "1000.0000" },
      action: "REPORT",
    });
    expect(mapped.action).toBe("FLAG");
    expect(mapped.ruleType).toBe("SINGLE_AMOUNT");
    expect(mapped.baseSeverity).toBe("MEDIUM");
    expect(mapped.params).toEqual({ amount: "1000.0000" });
  });

  test("aml reporting rule converts the window and keeps the source reference", () => {
    const mapped = toCoreAmlReportingRule({
      code: "CBL_LARGE",
      name: "cbl large transaction",
      mode: "CONFIRMED",
      threshold: "1000.0000",
      currency: "LYD",
      windowDays: 30,
    });
    expect(mapped.reportType).toBe("LARGE_TRANSACTION");
    expect(mapped.thresholdAmount).toBe("1000.0000");
    expect(mapped.windowSeconds).toBe(2592000);
    expect(mapped.sourceReference).toBe("CBL_LARGE");
    expect(mapped.status).toBe("CONFIRMED");
  });

  test("aml report derives the subject from the referenced case", () => {
    const mapped = toCoreAmlReport({
      reportingRuleId: "rr_1",
      caseId: "aml_case_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    expect(mapped.subjectType).toBe("AML_CASE");
    expect(mapped.subjectId).toBe("aml_case_1");
    expect(mapped.amlCaseId).toBe("aml_case_1");
    expect(mapped.payload).toEqual({
      reportingRuleId: "rr_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
  });

  test("rail create lowercases the code and mirrors the name on both locales", () => {
    const mapped = toCoreRailCreate({
      code: "RAIL1",
      name: "Rail one",
      collectionMode: "QR",
      feeBearer: "PAYER",
      active: true,
    });
    expect(mapped.code).toBe("rail1");
    expect(mapped.nameAr).toBe("Rail one");
    expect(mapped.nameEn).toBe("Rail one");
    expect(mapped.collectionMode).toBe("QR_DISPLAY");
    expect(mapped.feeBearer).toBeUndefined();
    expect(mapped.active).toBeUndefined();
  });

  test("rail patch maps the public active flag onto the core blocked flag", () => {
    const mapped = toCoreRailUpdate({ name: "Rail two", active: false, baseVersion: 4 });
    expect(mapped).toEqual({ nameAr: "Rail two", nameEn: "Rail two", blocked: true });
  });

  test("rail fields map the public field vocabulary onto the canonical one", () => {
    const mapped = toCoreRailFields({
      fields: [
        {
          code: "phone-number",
          label: "Phone",
          type: "PHONE",
          required: false,
          pattern: "^\\d+$",
          minLength: 5,
          maxLength: 20,
          sensitive: true,
        },
      ],
    });
    const fields = mapped.fields as JsonRecord[];
    expect(fields[0]?.key).toBe("phone_number");
    expect(fields[0]?.type).toBe("phone");
    expect(fields[0]?.labelAr).toBe("Phone");
    expect(fields[0]?.labelEn).toBe("Phone");
    expect(fields[0]?.orderIndex).toBe(0);
    expect(fields[0]?.required).toBe(false);
    expect(fields[0]?.sensitivity).toBe("SENSITIVE");
    expect(fields[0]?.regex).toBe("^\\d+$");
  });

  test("route create maps the public limit onto the core maximum amount", () => {
    const mapped = toCoreRouteCreate({
      railId: "rail_1",
      gatewayId: "gw_1",
      environment: "live",
      priority: 5,
      limitAmount: "100.0000",
      credentialPolicy: "MERCHANT_OR_PLATFORM",
    });
    expect(mapped.railId).toBe("rail_1");
    expect(mapped.gatewayId).toBe("gw_1");
    expect(mapped.credentialPolicy).toBe("MERCHANT_OR_PLATFORM");
    expect(mapped.maxAmount).toBe("100.0000");
    expect(mapped.environment).toBeUndefined();
    expect(mapped.limitCurrency).toBeUndefined();
  });

  test("route state renames the public state onto the core status", () => {
    const mapped = toCoreRouteState({ state: "DRAINING", reason: "maintenance window" });
    expect(mapped).toEqual({ status: "DRAINING", reason: "maintenance window" });
  });

  test("asset create maps the content type onto the core mime type", () => {
    const mapped = toCoreAssetCreate({
      kind: "LOGO",
      name: "logo",
      contentType: "image/svg+xml",
      storageKey: "assets/logo.svg",
      sizeBytes: 1024,
      checksumSha256: "b".repeat(64),
    });
    expect(mapped.mime).toBe("image/svg+xml");
    expect(mapped.sha256).toBe("b".repeat(64));
    expect(mapped.kind).toBeUndefined();
    expect(mapped.metadata).toBeUndefined();
  });

  test("operator case resolve carries the operator notes as the core resolution", () => {
    const mapped = toCoreOperatorCaseResolve({
      resolution: "RETRY_INQUIRE",
      reason: "unknown state",
      notes: "retried the inquiry",
    });
    expect(mapped).toEqual({ resolution: "retried the inquiry", state: "RESOLVED" });
  });

  test("operator case resolve keeps an escalated case in progress", () => {
    const mapped = toCoreOperatorCaseResolve({
      resolution: "ESCALATE",
      reason: "needs the risk team",
    });
    expect(mapped).toEqual({ resolution: "needs the risk team", state: "IN_PROGRESS" });
  });

  test("reconciliation source carries the public parser description as the parser config", () => {
    const mapped = toCoreReconciliationSourceCreate({
      code: "SRC1",
      name: "source",
      gatewayId: "gw_1",
      fileType: "CSV",
      delimiter: ",",
      hasHeader: true,
      columnMapping: { amount: "amt" },
      dateFormat: "YYYY-MM-DD",
      type: "UPLOAD",
    });
    expect(mapped.gatewayId).toBe("gw_1");
    expect(mapped.type).toBe("UPLOAD");
    expect(mapped.parserConfig).toEqual({
      fileType: "CSV",
      delimiter: ",",
      hasHeader: true,
      columnMapping: { amount: "amt" },
      dateFormat: "YYYY-MM-DD",
    });
    expect(mapped.code).toBeUndefined();
    expect(mapped.name).toBeUndefined();
  });

  test("reconciliation upload forwards the metadata and the statement source", () => {
    const mapped = toCoreReconciliationUpload({
      sourceId: "src_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      currency: "LYD",
      autoPost: false,
    });
    expect(mapped).toEqual({
      sourceId: "src_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      currency: "LYD",
      autoPost: false,
    });
  });

  test("dispute create maps the public reference and reason onto the core vocabulary", () => {
    const mapped = toCoreDisputeCreate({
      merchantId: "mch_1",
      gatewayId: "gw_1",
      paymentReference: "PA-1",
      externalDisputeRef: "CB1",
      type: "CHARGEBACK",
      amount: "10.0000",
      currency: "LYD",
      reason: "fraud",
      railId: "rail_1",
      source: "MANUAL",
    });
    expect(mapped.attemptId).toBe("PA-1");
    expect(mapped.railId).toBe("rail_1");
    expect(mapped.source).toBe("MANUAL");
    expect(mapped.reasonCode).toBe("fraud");
    expect(mapped.merchantId).toBeUndefined();
    expect(mapped.type).toBeUndefined();
  });

  test("adjustment create maps the public type and the referenced attempt", () => {
    const mapped = toCoreAdjustmentCreate({
      merchantId: "mch_1",
      attemptId: "att_1",
      disputeId: "dsp_1",
      type: "WRITEOFF",
      amount: "10.0000",
      currency: "LYD",
      reason: "write off",
      targetGlAccountId: "gl_1",
    });
    expect(mapped.type).toBe("MANUAL_DEBIT");
    expect(mapped.targetGlAccountId).toBe("gl_1");
    expect(mapped.sourceAttemptId).toBe("att_1");
    expect(mapped.disputeId).toBe("dsp_1");
    expect(mapped.currency).toBeUndefined();
  });

  test("cashout process rejects the decisions core cannot express", () => {
    expect(() => toCoreCashoutProcess({ decision: "HOLD", reason: "wait" })).toThrow();
    const mapped = toCoreCashoutProcess({ decision: "REJECT", reason: "insufficient funds" });
    expect(mapped).toEqual({ decision: "REJECT", reason: "insufficient funds" });
  });

  test("commission profile maps the public model onto the core calculation type", () => {
    const mapped = toCoreCommissionProfileCreate({
      code: "STD",
      name: "standard",
      model: "MIXED",
      percentage: "3.0000",
      flatAmount: "1.0000",
      tiers: [{ upTo: "100.0000" }],
      railCode: "cib",
    });
    expect(mapped.railCode).toBe("cib");
    expect(mapped.calcType).toBe("HYBRID");
    expect(mapped.flatFee).toBe("1.0000");
    expect(mapped.percentageRate).toBe("3.0000");
    expect(mapped.tiersJson).toEqual({ "0": { upTo: "100.0000" } });
  });

  test("velocity rule maps the public scope and action onto the core vocabulary", () => {
    const mapped = toCoreVelocityRuleCreate({
      code: "V1",
      name: "velocity",
      scope: "IP",
      windowSeconds: 60,
      maxAttempts: 5,
      maxAmount: "100.0000",
      action: "BLOCK",
    });
    expect(mapped.scopeType).toBe("END_CLIENT_IP");
    expect(mapped.maxCount).toBe(5);
    expect(mapped.action).toBe("REJECT");
    expect(mapped.maxAmount).toBe("100.0000");
  });

  test("velocity rule accepts an explicit canonical scope type", () => {
    const mapped = toCoreVelocityRuleCreate({
      code: "V2",
      name: "velocity",
      scope: "DEVICE",
      scopeType: "END_CLIENT_CARD",
      windowSeconds: 60,
      maxAttempts: 5,
      action: "REVIEW",
    });
    expect(mapped.scopeType).toBe("END_CLIENT_CARD");
    expect(mapped.action).toBe("FLAG");
  });

  test("settings map the public object onto the canonical setting array", () => {
    const mapped = toCoreSettingsUpdate({
      settings: {
        "join_request.four_eyes_policy": "RISK_BASED",
        limits: { max: 10 },
      },
      baseVersion: 3,
      reason: "policy change",
    });
    expect(mapped.settings).toEqual([
      { key: "join_request.four_eyes_policy", valueJson: { value: "RISK_BASED" } },
      { key: "limits", valueJson: { max: 10 } },
    ]);
    expect(mapped.baseVersion).toBeUndefined();
    expect(mapped.reason).toBeUndefined();
  });

  test("the edge names the canonical key the public payload cannot supply", () => {
    const missing = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        const failure = error as { code?: string; details?: { path?: string[] } };
        expect(failure.code).toBe("VALIDATION_FAILED");
        return failure.details?.path?.[0] ?? "";
      }
      throw new Error("expected the mapper to reject the payload");
    };

    expect(missing(() => toCoreRouteCreate({ railId: "rail_1", environment: "live" }))).toBe(
      "gatewayId",
    );
    expect(
      missing(() =>
        toCoreRouteCreate({
          railId: "rail_1",
          gatewayId: "gw_1",
          environment: "live",
        }),
      ),
    ).toBe("credentialPolicy");
    expect(
      missing(() =>
        toCoreDisputeCreate({
          merchantId: "mch_1",
          paymentReference: "PA-1",
          externalDisputeRef: "CB1",
          type: "CHARGEBACK",
          amount: "10.0000",
          currency: "LYD",
          reason: "fraud",
        }),
      ),
    ).toBe("gatewayId");
    expect(
      missing(() =>
        toCoreAdjustmentCreate({
          merchantId: "mch_1",
          type: "CHARGEBACK",
          amount: "10.0000",
          currency: "LYD",
          reason: "chargeback",
        }),
      ),
    ).toBe("targetGlAccountId");
    expect(
      missing(() =>
        toCoreCommissionProfileCreate({
          code: "STD",
          name: "standard",
          model: "PERCENTAGE",
        }),
      ),
    ).toBe("railCode");
    expect(
      missing(() =>
        toCoreReconciliationSourceCreate({
          code: "SRC1",
          name: "source",
          fileType: "CSV",
        }),
      ),
    ).toBe("gatewayId");
    expect(
      missing(() =>
        toCoreVelocityRuleCreate({
          code: "V1",
          name: "velocity",
          scope: "DEVICE",
          windowSeconds: 60,
          maxAttempts: 5,
          action: "BLOCK",
        }),
      ),
    ).toBe("scopeType");
    expect(missing(() => toCoreAssetCreate({ kind: "LOGO", name: "logo" }))).toBe("mime");
    expect(missing(() => toCoreSettingsUpdate({ settings: {} }))).toBe("settings");
  });
});
