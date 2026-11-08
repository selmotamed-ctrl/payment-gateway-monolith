import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma, type ContentType } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { invalidationBus } from "../../lib/invalidationBus";
import { createReconciliationUploadHandler } from "./reconciliationUpload";
import { backupInternalRouter } from "./backups";
import { adminCommerceRouter } from "./adminCommerce";
import { academyInternalRouter } from "./academy";
import { adminLedgerRouter } from "./adminLedger";
import { adminOperationsRouter } from "./adminOperations";
import { adminSystemRouter } from "./adminSystem";
import { publicProgress } from "../../engine/academy/progress";
import { loadCatalog } from "../../engine/academy/catalog";
import { getPlatformRuntime } from "../../engine/runtime";
import { InvariantVerifier, naturalBalance } from "../../engine/ledger/InvariantVerifier";
import { moneyToString } from "../../engine/db/money";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, listResponse } from "../../lib/listQuery";
import {
  APPROVAL_DOMAIN_SUBJECT_TYPES,
  APPROVAL_PENDING_STATES,
  approvalAgeHours,
  approvalSubjectTypeVariants,
  approvalDomain,
  approvalExpiresInHours,
  approvalIsExpired,
  approvalListRow,
  normalizeApprovalSubjectType,
} from "../../lib/approvalQueue";
import {
  OPERATOR_CASE_ACTIONS,
  operatorCaseInquiryEligibility,
  operatorCaseInquirySkipMessage,
  type OperatorCaseAction,
} from "../../lib/operatorCases";
import {
  JOIN_REQUEST_CHECKLIST_KEYS,
  buildProfileJson,
  computeJoinRequestReadiness,
  detectDuplicateFlags,
  nationalIdHash,
  normalizeEmail,
  normalizePhone,
  payoutAccountHash,
  type DuplicateFlag,
  type ProfileInput,
} from "../../lib/joinRequestOnboarding";
import {
  assertUploadSignature,
  resolveFourEyesForSubmission,
  runOnboardingScreening,
} from "./merchant";
import {
  KYB_DOCUMENT_REJECTION_REASONS,
  daysUntilExpiry,
  distinctDuplicateMerchantIds,
  duplicateJustificationRequired,
  expiryState,
  isKybDocumentActionable,
  mergeInfoRequestItems,
  readKybRefreshPolicy,
  recomputeMerchantKybStatus,
  secondsBetween,
} from "../../lib/kybReview";
import { queueKybNotification } from "../../lib/kybNotifications";
import {
  MERCHANT_CLOSE_REASON_CODES,
  MERCHANT_DESCRIPTIVE_FIELDS,
  MERCHANT_SENSITIVE_FIELD_SET,
  MERCHANT_SUSPENSION_REASON_CODES,
  assertMerchantClosable,
  assertMerchantPatchFields,
  assertMerchantReinstatable,
  assertMerchantSuspendable,
  assertMerchantVersion,
  hasMerchantAmlAccess,
  hasMerchantFinancialAccess,
  hasSensitiveMerchantAccess,
  merchantPatchOperations,
  merchantVersion,
  merchantWalletBalance,
  queueMerchantLifecycleNotification,
} from "../../lib/merchantOps";
import { scanKybBytes } from "../../lib/kybScan";
import { postgresPlaceholders } from "../../engine/db/rawRows";
import { hashPassword, signSession, verifyPasswordOrDummy } from "../../lib/auth";
import { revokePrincipalSession } from "../middleware/authDoubleCheck";
import { issueMfaChallenge, verifyMfaChallenge } from "../../lib/auth/mfaChallenges";
import {
  assertLoginAllowed,
  assertMfaAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  recordMfaFailure,
} from "../../lib/auth/throttle";
import { buildAdminUserInfo } from "../../lib/auth/uiAuthorities";
import { hasConfidentialAmlAccess } from "../../lib/auth/confidentialAccess";
import { executeGlobalSearch } from "../../lib/globalSearch";
import { getConfiguredAuditStore, readThroughReplicaOrPrimary } from "../../lib/storageEngine";
import { getBackupControlClient, isBackupDaemonConfigured } from "../../lib/storageEngine/backupControlClient";
import { backupPolicySchema } from "./backups";
import { loadAccountCheckpointSummary, loadLiveAccountBalances, naturalShardBalance } from "../../lib/storageEngine/shardBalances";
import type { Decimal } from "decimal.js";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { LedgerPoster } from "../../engine/ledger/LedgerPoster";
import {
  GoLiveGateValidator,
  type ChannelVerificationEvidence,
} from "../../engine/flow/GoLiveGateValidator";
import { Vault } from "../../engine/crypto/Vault";
import { VaultContextCipher } from "../../engine/runtime/contextCipher";
import { ApiConsumerError } from "../../engine/apiConsumer/ApiConsumer";
import type { AdapterAttempt } from "../../engine/flow/NativeAdapterRegistry";
import {
  MOCK_SCENARIOS,
  MockGatewayServer,
  type MockScenario,
} from "../../engine/mockGateway/MockGatewayServer";
import {
  activateApprovedJoinRequest,
  activateGatewayVersionInTransaction,
  assertGatewayVersionGoLive,
  executeApprovalSubject,
  executeCashout,
  type GovernanceExecutionContext,
} from "../../engine/governance/GovernanceExecution";
import { evaluateRouteDailyCap } from "../../engine/flow/VisibleRailsResolver";
import { dayWindowInTimeZone, resolveGatewayTimezone } from "../../engine/flow/DailyRouteVolume";
import { PrismaRepositories } from "../../engine/db/repositories";
import {
  buildTranscriptKit,
  materializeSpec,
  parseImportRequest,
  simulateSpec,
  type CollisionResult,
} from "../../engine/specImporter";
import { createComputeRegistry } from "../../engine/runtime/computeRegistry";
import type { Tx } from "../../engine/db/ports";
import { validateTransformUsage, type TransformPipe, type TransformUsage } from "../../engine/transforms/TransformPipeline";
import { json, jsonOptional } from "./json";
import {
  clientIp,
  principalOf,
  requireAuthentication,
  requireAuthorities,
  requireStaffPrincipal,
} from "../middleware/authDoubleCheck";
import { actorFromRequest, assertCheckerAuthority, assertCheckerIsNotMaker, SYSTEM_AUTOMATION_PRINCIPAL } from "../middleware/makerCheckerGuard";
import { writeAudit } from "../../lib/audit/writeAudit";

const router = express.Router();

/**
 * The vault of the credential sets. The secrets are encrypted with the very
 * same key the merchant route uses, so a secret is never stored in clear.
 */
const vault = new Vault();

/**
 * The execution context of the governance module.
 *
 * The ledger poster, the repositories and the database are the very same
 * instances the rest of the service uses, so a governance execution posts
 * through the production ledger.
 */
const governanceContext = (platform: ReturnType<typeof getPlatformRuntime>): GovernanceExecutionContext => ({
  ledgerPoster: platform.ledgerPoster,
  repositories: platform.repositories,
  engine: platform.engine,
  transitionBus: invalidationBus,
  slots: platform.slots,
});

/**
 * The actor of a governance write.
 *
 * A dispute may be opened by a rail webhook, so a non-human principal is
 * tolerated here. The maker-checker guard is never relaxed: the system
 * principal can never check an approval.
 */
const auditActorOf = (request: Request): { userId: string | null; role: string | null } => {
  const principal = principalOf(request);
  if (principal.userId && principal.role !== SYSTEM_AUTOMATION_PRINCIPAL) {
    return { userId: principal.userId, role: principal.role ?? null };
  }
  return { userId: null, role: "SYSTEM" };
};

router.get("/health", (_request, response) => {
  response.json({ status: "ok", channel: "admin" });
});


const idSchema = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });

const CONTENT_TYPES: Record<string, string> = {
  "application/json": "APPLICATION_JSON",
  "application/x-www-form-urlencoded": "APPLICATION_FORM_URLENCODED",
  "multipart/form-data": "MULTIPART_FORM_DATA",
  "application/xml": "APPLICATION_XML",
  "text/xml": "TEXT_XML",
  "text/plain": "TEXT_PLAIN",
};

const contentTypeEnum = (value: string | undefined): ContentType | null => {
  if (!value) {
    return null;
  }
  return (CONTENT_TYPES[value.trim().toLowerCase()] as ContentType | undefined) ?? null;
};

const roleHasConfidentialAccess = (request: Request): boolean => {
  const principal = principalOf(request);
  return hasConfidentialAmlAccess({
    id: principal.userId ?? principal.tokenId ?? "system",
    role: principal.role ?? "",
    authorities: principal.authorities,
  });
};

const assertConfidential = (request: Request): void => {
  if (!roleHasConfidentialAccess(request)) {
    throw new ApiError(403, "AML_CONFIDENTIAL_ROLE_REQUIRED", "This resource is restricted to compliance roles");
  }
};

const reportingPayloadCipher = new VaultContextCipher(vault, "reporting-payload");

const REPORTING_ROLES = ["MLRO", "COMPLIANCE"];
const REPORTING_AUTHORITIES = [
  "report:approve",
  "report:review",
  "aml:write",
  "compliance:write",
  "approval:check",
  "approval:write",
];

const assertReportingAuthority = (request: Request): void => {
  assertConfidential(request);
  const principal = principalOf(request);
  if (REPORTING_ROLES.includes(principal.role ?? "")) {
    return;
  }
  if (principal.authorities.some((authority) => authority === "*" || REPORTING_AUTHORITIES.includes(authority))) {
    return;
  }
  throw new ApiError(
    403,
    "REPORTING_AUTHORITY_REQUIRED",
    "A reporting action requires an MLRO / compliance authority",
  );
};

const readRegulatoryReportPayload = async (ciphertext: string | null | undefined): Promise<Record<string, unknown>> => {
  if (!ciphertext) {
    return {};
  }
  try {
    const parsed = JSON.parse(ciphertext) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // The evaluator stores the reporting payload encrypted. The admin route
    // stores the draft payload as JSON, so both shapes are understood.
  }
  try {
    const decoded = await reportingPayloadCipher.decrypt(ciphertext);
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const assertReportSubmitter = async (
  db: typeof client,
  report: { approvalRequestId: string | null },
  actorUserId: string,
): Promise<void> => {
  if (!report.approvalRequestId) {
    return;
  }
  const approval = await db.approvalRequest.findUnique({ where: { id: report.approvalRequestId } });
  if (approval) {
    assertCheckerIsNotMaker(approval.makerUserId, actorUserId);
  }
};

export const createRegulatoryReportViaApproval = async (
  db: typeof client,
  input: {
    reportType: "LARGE_TRANSACTION" | "SUSPICIOUS_ACTIVITY" | "PERIODIC_RETURN";
    authority: string;
    subjectType: string;
    subjectId: string;
    amlCaseId?: string | null;
    payload: Record<string, unknown>;
    checklist?: string[];
  },
  actor: { userId: string; role: string | null },
): Promise<{ reportId: string; approvalRequestId: string; status: string }> => {
  const payloadJson = JSON.stringify(input.payload);
  const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
  const parsePeriod = (value: unknown): Date | null => {
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const periodStart = parsePeriod(input.payload.periodStart);
  const periodEnd = parsePeriod(input.payload.periodEnd);
  return db.$transaction(async (tx) => {
    const report = await tx.regulatoryReport.create({
      data: {
        reportType: input.reportType,
        authority: input.authority,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        amlCaseId: input.amlCaseId ?? null,
        periodStart,
        periodEnd,
        payloadCiphertext: payloadJson,
        payloadSha256,
        status: "PENDING_CHECKER",
        confidential: true,
      },
    });
    const approval = await tx.approvalRequest.create({
      data: {
        subjectType: "REGULATORY_REPORT",
        subjectId: report.id,
        payloadDiffJson: {
          reportType: input.reportType,
          authority: input.authority,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          ruleId: input.payload.ruleId ?? null,
          checklist: input.checklist ?? [],
        },
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await tx.regulatoryReport.update({
      where: { id: report.id },
      data: { approvalRequestId: approval.id },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "REGULATORY_REPORT_DRAFTED",
        entityType: "REGULATORY_REPORT",
        entityId: report.id,
        beforeJson: {},
        afterJson: {
          reportType: report.reportType,
          authority: report.authority,
          approvalRequestId: approval.id,
          checklist: input.checklist ?? [],
        },
        approvalRequestId: approval.id,
      },
    });
    return { reportId: report.id, approvalRequestId: approval.id, status: report.status };
  });
};

export const submitRegulatoryReport = async (
  db: typeof client,
  input: {
    reportId: string;
    submissionRef: string;
    submittedAt?: Date | null;
    actorUserId: string;
    actorRole: string | null;
  },
): Promise<{ id: string; status: string; submissionRef: string | null; submittedAt: Date | null }> => {
  const report = await db.regulatoryReport.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ApiError(404, "REGULATORY_REPORT_NOT_FOUND", "The regulatory report does not exist");
  }
  if (report.status !== "APPROVED") {
    throw new ApiError(
      409,
      "REGULATORY_REPORT_NOT_APPROVED",
      `The regulatory report is '${report.status}' and cannot be submitted`,
      { reportId: report.id, status: report.status },
    );
  }
  await assertReportSubmitter(db, report, input.actorUserId);

  // OD-1: a PROVISIONAL rule is internal only. The evaluator links the report
  // to its triggering rule through the persisted payload's `ruleId`.
  const payload = await readRegulatoryReportPayload(report.payloadCiphertext);
  const ruleId = typeof payload.ruleId === "string" && payload.ruleId.length > 0 ? payload.ruleId : null;
  if (ruleId) {
    const rule = await db.reportingRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.status !== "CONFIRMED") {
      throw new ApiError(
        409,
        "REPORTING_RULE_PROVISIONAL",
        "A PROVISIONAL reporting rule can never produce a live regulatory filing",
        { reportId: report.id, ruleId, ruleStatus: rule.status },
      );
    }
  }

  const submittedAt = input.submittedAt ?? new Date();
  return db.$transaction(async (tx) => {
    const current = await tx.regulatoryReport.findUnique({ where: { id: report.id } });
    if (!current) {
      throw new ApiError(404, "REGULATORY_REPORT_NOT_FOUND", "The regulatory report does not exist");
    }
    if (current.status !== "APPROVED") {
      throw new ApiError(
        409,
        "REGULATORY_REPORT_NOT_APPROVED",
        `The regulatory report is '${current.status}' and cannot be submitted`,
        { reportId: current.id, status: current.status },
      );
    }
    const updated = await tx.regulatoryReport.update({
      where: { id: current.id },
      data: { status: "SUBMITTED", submissionRef: input.submissionRef, submittedAt },
    });
    await writeAudit(tx, {
      data: {
        actorId: input.actorUserId,
        role: input.actorRole ?? "SYSTEM",
        action: "REGULATORY_REPORT_SUBMITTED",
        entityType: "REGULATORY_REPORT",
        entityId: updated.id,
        beforeJson: { status: "APPROVED" },
        afterJson: {
          status: "SUBMITTED",
          submissionRef: input.submissionRef,
          submittedAt: submittedAt.toISOString(),
          ruleId,
        },
        approvalRequestId: updated.approvalRequestId,
      },
    });
    return {
      id: updated.id,
      status: updated.status,
      submissionRef: updated.submissionRef,
      submittedAt: updated.submittedAt,
    };
  });
};

export const acknowledgeRegulatoryReport = async (
  db: typeof client,
  input: {
    reportId: string;
    status: "ACKNOWLEDGED" | "REJECTED_BY_AUTHORITY";
    reason?: string | null;
    actorUserId: string;
    actorRole: string | null;
  },
): Promise<{ id: string; status: string; reason: string | null }> => {
  const report = await db.regulatoryReport.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new ApiError(404, "REGULATORY_REPORT_NOT_FOUND", "The regulatory report does not exist");
  }
  if (report.status !== "SUBMITTED") {
    throw new ApiError(
      409,
      "REGULATORY_REPORT_NOT_SUBMITTED",
      `The regulatory report is '${report.status}' and cannot be acknowledged`,
      { reportId: report.id, status: report.status },
    );
  }
  const reason = input.reason?.trim() || null;
  if (input.status === "REJECTED_BY_AUTHORITY" && !reason) {
    throw new ApiError(
      400,
      "REJECTION_REASON_REQUIRED",
      "A rejection by the authority must carry a reason",
    );
  }
  return db.$transaction(async (tx) => {
    const current = await tx.regulatoryReport.findUnique({ where: { id: report.id } });
    if (!current) {
      throw new ApiError(404, "REGULATORY_REPORT_NOT_FOUND", "The regulatory report does not exist");
    }
    if (current.status !== "SUBMITTED") {
      throw new ApiError(
        409,
        "REGULATORY_REPORT_NOT_SUBMITTED",
        `The regulatory report is '${current.status}' and cannot be acknowledged`,
        { reportId: current.id, status: current.status },
      );
    }
    const updated = await tx.regulatoryReport.update({
      where: { id: current.id },
      data: { status: input.status },
    });
    await writeAudit(tx, {
      data: {
        actorId: input.actorUserId,
        role: input.actorRole ?? "SYSTEM",
        action: input.status === "ACKNOWLEDGED"
          ? "REGULATORY_REPORT_ACKNOWLEDGED"
          : "REGULATORY_REPORT_REJECTED_BY_AUTHORITY",
        entityType: "REGULATORY_REPORT",
        entityId: updated.id,
        beforeJson: { status: "SUBMITTED" },
        afterJson: { status: updated.status, reason },
        approvalRequestId: updated.approvalRequestId,
      },
    });
    return { id: updated.id, status: updated.status, reason };
  });
};

export const proposeReportingRulePromotion = async (
  db: typeof client,
  input: { ruleId: string; actorUserId: string; actorRole: string | null },
): Promise<{ approvalRequestId: string; status: string }> => {
  const rule = await db.reportingRule.findUnique({ where: { id: input.ruleId } });
  if (!rule) {
    throw new ApiError(404, "REPORTING_RULE_NOT_FOUND", "The reporting rule does not exist");
  }
  if (rule.status === "CONFIRMED") {
    throw new ApiError(409, "REPORTING_RULE_ALREADY_CONFIRMED", "The reporting rule is already CONFIRMED");
  }
  const pending = await db.approvalRequest.findFirst({
    where: {
      subjectType: "REPORTING_RULE",
      subjectId: rule.id,
      state: { in: ["DRAFT", "PENDING_REVIEW"] },
    },
  });
  if (pending) {
    throw new ApiError(
      409,
      "REPORTING_RULE_PROMOTION_PENDING",
      "A promotion of this reporting rule is already pending",
      { approvalRequestId: pending.id },
    );
  }
  return db.$transaction(async (tx) => {
    const approval = await tx.approvalRequest.create({
      data: {
        subjectType: "REPORTING_RULE",
        subjectId: rule.id,
        payloadDiffJson: { from: rule.status, to: "CONFIRMED" },
        mode: "STANDARD",
        makerUserId: input.actorUserId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await tx.reportingRule.update({
      where: { id: rule.id },
      data: { approvalRequestId: approval.id },
    });
    await writeAudit(tx, {
      data: {
        actorId: input.actorUserId,
        role: input.actorRole ?? "SYSTEM",
        action: "REPORTING_RULE_PROMOTION_PROPOSED",
        entityType: "REPORTING_RULE",
        entityId: rule.id,
        beforeJson: { status: rule.status },
        afterJson: { status: rule.status, requestedStatus: "CONFIRMED" },
        approvalRequestId: approval.id,
      },
    });
    return { approvalRequestId: approval.id, status: "PENDING_REVIEW" };
  });
};

router.post("/auth/login", async (request: Request, response: Response) => {
  const body = parseOrThrow(
    z.object({ identifier: z.string().min(3).max(128), password: z.string().min(1).max(128) }).strict(),
    request.body,
  );
  const identifier = body.identifier.includes("@") ? body.identifier.trim().toLowerCase() : body.identifier.trim();
  const ip = clientIp(request);
  await assertLoginAllowed(identifier, ip);
  const user = await client.user.findFirst({
    where: {
      OR: [
        { email: identifier },
        { phone: identifier },
        { identities: { some: { identifierNormalized: identifier } } },
      ],
    },
  });
  // Merchant principals never authenticate on the admin channel; they get the
  // same answer as an unknown user.
  const staffUser = user && user.merchantId === null && !String(user.role).startsWith("MERCHANT_") ? user : null;
  const passwordOk = await verifyPasswordOrDummy(body.password, staffUser?.passwordHash);
  if (!staffUser || !passwordOk) {
    await recordLoginFailure(identifier, ip);
    throw new ApiError(401, "INVALID_CREDENTIALS", "The supplied credentials are not valid");
  }
  if (staffUser.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "The account is not active");
  }
  await recordLoginSuccess(identifier);
  if (staffUser.mfaRequired) {
    const { challengeId } = await client.$transaction((tx) =>
      issueMfaChallenge(tx as never, {
        userId: staffUser.id,
        channel: "ADMIN",
        phone: staffUser.phone,
        phoneLast4: (staffUser.phone ?? "").slice(-4),
        ip,
      }),
    );
    response.json({ mfaRequired: true, challengeId });
    return;
  }
  const authorities = Array.isArray(staffUser.authoritiesMap)
    ? staffUser.authoritiesMap.map(String)
    : Object.entries((staffUser.authoritiesMap ?? {}) as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([authority]) => authority);
  response.json({
    token: signSession({
      sub: staffUser.id,
      role: staffUser.role,
      merchantId: staffUser.merchantId,
      authorities,
      appScopeIds: Array.isArray(staffUser.appScopeIds) ? staffUser.appScopeIds.map(String) : [],
      mfa: false,
    }, "admin"),
    expiresInSeconds: 12 * 60 * 60,
    userInfo: buildAdminUserInfo(staffUser, authorities),
  });
});

router.post("/auth/mfa", async (request: Request, response: Response) => {
  const body = parseOrThrow(
    z.object({ code: z.string().regex(/^\d{6}$/), challengeId: z.string().min(4).max(4096) }).strict(),
    request.body,
  );
  const ip = clientIp(request);
  await assertMfaAllowed(ip);
  // Not wrapped in a transaction: a wrong guess must persist its attempt counter.
  let verified;
  try {
    verified = await verifyMfaChallenge(client as never, {
      challengeId: body.challengeId,
      code: body.code,
      channel: "ADMIN",
    });
  } catch (error) {
    await recordMfaFailure(ip);
    throw error;
  }
  const user = await client.user.findUnique({ where: { id: verified.userId } });
  if (!user || user.status !== "ACTIVE" || user.merchantId !== null || String(user.role).startsWith("MERCHANT_")) {
    throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "The account is not active");
  }
  const authorities = Array.isArray(user.authoritiesMap)
    ? user.authoritiesMap.map(String)
    : Object.entries((user.authoritiesMap ?? {}) as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([authority]) => authority);
  response.json({
    token: signSession({
      sub: user.id,
      role: user.role,
      merchantId: user.merchantId,
      authorities,
      appScopeIds: Array.isArray(user.appScopeIds) ? user.appScopeIds.map(String) : [],
      mfa: true,
    }, "admin"),
    expiresInSeconds: 12 * 60 * 60,
    userInfo: buildAdminUserInfo(user, authorities),
  });
});

router.get("/auth/me", (_request: Request, response: Response) => {
  response.json({
    platformName: "Payment Gateway",
    version: process.env.GIT_COMMIT?.slice(0, 12) ?? "dev",
    suspended: false,
  });
});


router.use(requireAuthentication);
// Principal-type separation: merchant users and API tokens never reach an admin route,
// even when their authority strings (for example merchant:read) overlap.
router.use(requireStaffPrincipal);

/** Server-side logout (GAP-019): puts the presented session on the revoke list. */
router.post("/auth/logout", async (request: Request, response: Response) => {
  await revokePrincipalSession(request);
  response.json({ revoked: true });
});
router.use("/system/backups", backupInternalRouter);
router.use("/", adminCommerceRouter);
router.use(adminLedgerRouter);
router.use(adminOperationsRouter);
router.use(adminSystemRouter);
router.use("/academy", academyInternalRouter);

/** Any staff read authority: the floor for the cross-cutting dashboard, lookup and search routes. */
const STAFF_READ_AUTHORITIES = [
  "merchant:read",
  "finance:read",
  "gateway:read",
  "case:read",
  "operator:read",
  "kyb:read",
  "compliance:read",
  "aml:read",
  "security:read",
  "reconciliation:read",
  "approval:read",
  "cashout:read",
  "dispute:read",
  "attempt:read",
] as const;

router.post("/search", async (request: Request, response: Response) => {
  requireAuthorities(request, STAFF_READ_AUTHORITIES);
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  const principal = principalOf(request);
  const result = await readThroughReplicaOrPrimary(
    client as never,
    request.header("x-pg-min-lsn") ?? undefined,
    (reader) =>
      executeGlobalSearch(request.body ?? {}, {
        prisma: reader,
        auditStore: getConfiguredAuditStore(),
        actor: {
          id: principal.userId ?? principal.tokenId ?? "system",
          role: principal.role ?? "",
          authorities: principal.authorities,
        },
        requestId: request.requestId,
        logger: {
          warn: (message, meta) => request.logger?.warn(`${message} ${JSON.stringify(meta ?? {})}`),
          error: (message, meta) => request.logger?.error(`${message} ${JSON.stringify(meta ?? {})}`),
        },
      }),
  );
  response.json(result);
});

const recentActivityRows = async (limit: number) => {
  const rows = await client.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { email: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    actorEmail: row.actor?.email ?? "",
    role: row.role,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    approvalRequestId: row.approvalRequestId,
  }));
};

router.get("/stats/recent-activity", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const parsedLimit = Number(request.query.limit ?? 8);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 20) : 8;
  response.json({ recentActivity: await recentActivityRows(limit) });
});

router.get("/stats/recent-activity/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const parsedLimit = Number(request.query.limit ?? 200);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 5000) : 200;
  const rows = await recentActivityRows(limit);
  const allowedChecklist = new Set([
    "ACTIVITY_SCOPE_VERIFIED",
    "ACTORS_REVIEWED",
    "SECURITY_SCOPE_CONFIRMED",
    "EXPORT_AUDIT_ACKNOWLEDGED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "DASHBOARD_RECENT_ACTIVITY_EXPORTED",
      entityType: "AUDIT_LOG",
      entityId: "dashboard-recent-activity",
      beforeJson: {},
      afterJson: { exported: rows.length, checklist },
    },
  });
  response.json({ recentActivity: rows, exported: rows.length, exportedAt: new Date().toISOString() });
});

router.get("/stats/overview", async (request: Request, response: Response) => {
  requireAuthorities(request, STAFF_READ_AUTHORITIES);
  const now = new Date();
  const period = merchantPeriodLabel(request.query.period);
  const since = merchantStatsSince(period);
  const openJoinStatuses = ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"];
  const openAmlStatuses = ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"];
  const openOperatorStatuses = ["OPEN", "IN_PROGRESS", "PENDING_CHECKER"];
  const [
    merchantsActive,
    merchantsPending,
    attemptsByStateRows,
    unknownAggregate,
    approvalPendingRows,
    joinRequestOpen,
    joinRequestSlaBreaches,
    amlOpen,
    amlSlaBreaches,
    operatorOpen,
    operatorP1,
    operatorSlaBreaches,
    routeHealthRows,
    oldestUnprocessedInbound,
    reconciliationRows,
  ] = await Promise.all([
    client.merchant.count({ where: { status: "ACTIVE" } }),
    client.merchant.count({ where: { status: "PENDING" } }),
    client.paymentAttempt.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { totalChargedAmount: true },
    }),
    client.paymentAttempt.aggregate({
      where: { status: "UNKNOWN" },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    client.approvalRequest.findMany({
      where: { state: { in: [...APPROVAL_PENDING_STATES] } },
      select: { subjectType: true, state: true, mode: true, createdAt: true, expiresAt: true, ratifyDueAt: true },
    }),
    client.joinRequest.count({ where: { status: { in: openJoinStatuses as never } } }),
    client.joinRequest.count({
      where: { status: { in: openJoinStatuses as never }, slaDueAt: { lt: now } },
    }),
    client.amlCase.count({ where: { status: { in: openAmlStatuses as never } } }),
    client.amlCase.count({
      where: { status: { in: openAmlStatuses as never }, slaDueAt: { lt: now } },
    }),
    client.operatorCase.count({ where: { state: { in: openOperatorStatuses as never } } }),
    client.operatorCase.count({ where: { state: { in: openOperatorStatuses as never }, priority: "P1" } }),
    client.operatorCase.count({
      where: { state: { in: openOperatorStatuses as never }, slaDueAt: { lt: now } },
    }),
    client.railRoute.groupBy({ by: ["healthState"], _count: { _all: true } }),
    client.inboundEvent.findFirst({
      where: { processedAt: null },
      orderBy: { receivedAt: "asc" },
      select: { receivedAt: true },
    }),
    client.reconciliationItem.groupBy({
      by: ["result"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const attemptsByState: Record<string, number> = {};
  const volumeByState: Record<string, string> = {};
  let attemptsTotal = 0;
  let attemptsSucceeded = 0;
  let grossVolume = decimal(0);
  const successStatuses = new Set<string>(merchantSuccessStatuses);
  for (const row of attemptsByStateRows) {
    const count = row._count._all;
    attemptsByState[String(row.status)] = count;
    attemptsTotal += count;
    const charged = decimal(row._sum.totalChargedAmount ?? 0);
    volumeByState[String(row.status)] = charged.toFixed(4);
    if (successStatuses.has(String(row.status))) {
      attemptsSucceeded += count;
      grossVolume = grossVolume.plus(charged);
    }
  }

  const unknownOldest = unknownAggregate._min.createdAt;
  const byDomain = new Map<string, { count: number; oldestCreatedAt: Date | null }>();
  let approvalExpired = 0;
  let approvalEmergencyDue = 0;
  for (const row of approvalPendingRows) {
    const domain = approvalDomain(row.subjectType);
    const current = byDomain.get(domain) ?? { count: 0, oldestCreatedAt: null };
    current.count += 1;
    if (!current.oldestCreatedAt || row.createdAt < current.oldestCreatedAt) current.oldestCreatedAt = row.createdAt;
    byDomain.set(domain, current);
    if (approvalIsExpired(row.expiresAt, now.getTime())) approvalExpired += 1;
    if (row.mode === "EMERGENCY_RATIFICATION" && row.ratifyDueAt && row.ratifyDueAt.getTime() <= now.getTime()) {
      approvalEmergencyDue += 1;
    }
  }

  const routeHealth: Record<string, number> = {};
  for (const row of routeHealthRows) {
    routeHealth[String(row.healthState)] = row._count._all;
  }

  let reconciliationMatched = 0;
  let reconciliationItems = 0;
  for (const row of reconciliationRows) {
    const count = row._count._all;
    reconciliationItems += count;
    if (row.result === "MATCHED") reconciliationMatched += count;
  }
  const reconciliationMatchRate = reconciliationItems === 0
    ? "0.0000"
    : ((reconciliationMatched / reconciliationItems) * 100).toFixed(4);

  response.json({
    period,
    since,
    merchantsActive,
    merchantsPending,
    attemptsByState,
    volumeByState,
    attemptsTotal,
    attemptsSucceeded,
    successRate: attemptsTotal === 0 ? 0 : Number(((attemptsSucceeded / attemptsTotal) * 100).toFixed(2)),
    grossVolume: grossVolume.toFixed(4),
    unknownBacklog: (unknownAggregate._count as { _all: number })._all,
    unknownOldestAgeSeconds: unknownOldest
      ? Math.max(0, Math.round((now.getTime() - unknownOldest.getTime()) / 1000))
      : 0,
    openCircuitBreakers: routeHealth.OPEN_BREAKER ?? 0,
    routeHealth: {
      healthy: routeHealth.HEALTHY ?? 0,
      degraded: routeHealth.DEGRADED ?? 0,
      openBreaker: routeHealth.OPEN_BREAKER ?? 0,
    },
    webhookInboxLagSeconds: oldestUnprocessedInbound
      ? Math.max(0, Math.round((now.getTime() - oldestUnprocessedInbound.receivedAt.getTime()) / 1000))
      : 0,
    reconciliationMatchRate,
    reconciliationItems,
    approvalPending: approvalPendingRows.length,
    approvalExpired,
    approvalEmergencyDue,
    approvalQueueAgeing: [...byDomain.entries()]
      .map(([domain, value]) => ({
        domain,
        count: value.count,
        oldestHours: value.oldestCreatedAt ? approvalAgeHours(value.oldestCreatedAt, now.getTime()) : 0,
      }))
      .sort((a, b) => b.count - a.count),
    joinRequestOpen,
    joinRequestSlaBreaches,
    amlOpen,
    amlSlaBreaches,
    operatorOpen,
    operatorP1,
    operatorSlaBreaches,
  });
});

router.post("/stats/export-audit", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read", "security:write"]);
  const body = parseOrThrow(
    z.object({
      period: z.string().min(1).max(32),
      checklist: z.array(z.enum([
        "PERIOD_VERIFIED",
        "METRICS_REVIEWED",
        "DISTRIBUTION_ACKNOWLEDGED",
        "EXPORT_SCOPE_CONFIRMED",
      ])).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  const actor = actorFromRequest(request);
  const created = await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "DASHBOARD_SNAPSHOT_EXPORTED",
      entityType: "DASHBOARD",
      entityId: "snapshot",
      beforeJson: {},
      afterJson: { period: body.period, checklist: body.checklist ?? [] },
    },
  });
  response.status(201).json({ id: created.id });
});

const OPTION_LIMIT = 100;

router.get("/options/:kind", async (request: Request, response: Response) => {
  const kind = String(request.params.kind ?? "");
  requireAuthorities(request, kind === "users" ? ["user:read", "security:read"] : STAFF_READ_AUTHORITIES);
  const rawSearch = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const limit = Math.min(OPTION_LIMIT, Math.max(1, Number(request.query.limit ?? 50) || 50));
  const ownerId = typeof request.query.ownerId === "string" ? request.query.ownerId.trim() : "";
  const contains = rawSearch ? { contains: rawSearch } : undefined;
  let items: Array<{ value: string; title: string; subtitle?: string }> = [];

  switch (kind) {
    case "merchants": {
      const rows = await client.merchant.findMany({
        where: rawSearch ? { OR: [{ tradeName: contains! }, { legalName: contains! }] } : {},
        orderBy: { tradeName: "asc" },
        take: limit,
        select: { id: true, tradeName: true, legalName: true },
      });
      items = rows.map((row) => ({ value: row.id, title: row.tradeName, subtitle: row.legalName }));
      break;
    }
    case "rails": {
      const rows = await client.rail.findMany({
        where: rawSearch ? { OR: [{ code: contains! }, { nameEn: contains! }, { nameAr: contains! }] } : {},
        orderBy: { code: "asc" },
        take: limit,
        select: { id: true, code: true, nameEn: true, nameAr: true },
      });
      items = rows.map((row) => ({ value: row.id, title: `${row.nameEn} (${row.code})`, subtitle: row.nameAr }));
      break;
    }
    case "gateways": {
      const rows = await client.gateway.findMany({
        where: rawSearch ? { OR: [{ code: contains! }, { name: contains! }] } : {},
        orderBy: { code: "asc" },
        take: limit,
        select: { id: true, code: true, name: true },
      });
      items = rows.map((row) => ({ value: row.id, title: `${row.name} (${row.code})` }));
      break;
    }
    case "users": {
      const rows = await client.user.findMany({
        where: rawSearch ? { OR: [{ email: contains! }, { phone: contains! }] } : {},
        orderBy: { email: "asc" },
        take: limit,
        select: { id: true, email: true, role: true },
      });
      items = rows.map((row) => ({ value: row.id, title: row.email, subtitle: row.role }));
      break;
    }
    case "applications": {
      const rows = await client.application.findMany({
        where: rawSearch ? { name: contains! } : {},
        orderBy: { name: "asc" },
        take: limit,
        select: { id: true, name: true, merchant: { select: { tradeName: true } } },
      });
      items = rows.map((row) => ({ value: row.id, title: row.name, subtitle: row.merchant?.tradeName }));
      break;
    }
    case "wallets": {
      const rows = await client.wallet.findMany({
        where: rawSearch ? { currency: contains! } : {},
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, currency: true, merchant: { select: { tradeName: true } } },
      });
      items = rows.map((row) => ({ value: row.id, title: `${row.merchant?.tradeName ?? row.id} · ${row.currency}` }));
      break;
    }
    case "credential-sets": {
      const rows = await client.credentialSet.findMany({
        where: rawSearch ? { externalMerchantId: contains! } : {},
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, externalMerchantId: true, env: true, gateway: { select: { code: true } } },
      });
      items = rows.map((row) => ({ value: row.id, title: `${row.gateway.code} · ${row.externalMerchantId ?? row.id}`, subtitle: row.env }));
      break;
    }
    case "gl-accounts": {
      const rows = await client.glAccount.findMany({
        where: ownerId ? { ownerId, accountType: "MERCHANT_WALLET" } : {},
        orderBy: [{ accountType: "asc" }, { currency: "asc" }],
        take: limit,
        select: { id: true, accountType: true, currency: true, ownerId: true },
      });
      items = rows.map((row) => ({
        value: row.id,
        title: `${row.accountType} · ${row.currency}`,
        subtitle: row.ownerId ? row.ownerId.slice(0, 12) : row.id.slice(0, 8),
      }));
      break;
    }
    default:
      throw new ApiError(400, "UNKNOWN_OPTION_KIND", "Unknown option kind");
  }
  response.json({ items, total: items.length });
});


router.get("/users", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  const built = buildListQuery(request.query, {
    search: ["email", "phone"],
    in: { status: "status" }, equals: {role: "role", merchantId: "merchantId"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { email: "email", role: "role", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const scope = String(request.query.scope ?? "").trim().toLowerCase();
  if (scope === "admin") {
    built.where = { ...(built.where as Record<string, unknown>), merchantId: null };
  } else if (scope === "merchant") {
    built.where = { ...(built.where as Record<string, unknown>), merchantId: { not: null } };
  }
  const [users, total] = await Promise.all([
    client.user.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.user.count({ where: built.where as never }),
  ]);
  response.json(listResponse("users", users.map((user) => ({
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    merchantId: user.merchantId,
    authoritiesMap: user.authoritiesMap,
    status: user.status,
    isMaker: user.isMaker,
    isChecker: user.isChecker,
    mfaRequired: user.mfaRequired,
    invitationExpiresAt: user.invitationExpiresAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  })), total, built));
});

router.get("/users/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  const built = buildListQuery(request.query, {
    search: ["email", "phone"],
    in: { status: "status" }, equals: {role: "role", merchantId: "merchantId"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { email: "email", role: "role", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const scope = String(request.query.scope ?? "").trim().toLowerCase();
  if (scope === "admin") {
    built.where = { ...(built.where as Record<string, unknown>), merchantId: null };
  } else if (scope === "merchant") {
    built.where = { ...(built.where as Record<string, unknown>), merchantId: { not: null } };
  }
  const take = 5000;
  const [users, total] = await Promise.all([
    client.user.findMany({ where: built.where as never, orderBy: built.orderBy as never, take }),
    client.user.count({ where: built.where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "ADMIN_USERS_EXPORTED",
      entityType: "USER",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: users.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      merchantId: user.merchantId,
      authoritiesMap: user.authoritiesMap,
      status: user.status,
      isMaker: user.isMaker,
      isChecker: user.isChecker,
      mfaRequired: user.mfaRequired,
      invitationExpiresAt: user.invitationExpiresAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })),
    total,
    exported: users.length,
    truncated: total > users.length,
  });
});

const buildInternalUserSummary = async () => {
  const users = await client.user.findMany({
    where: { merchantId: null },
    select: { role: true, status: true, isMaker: true, isChecker: true },
  });
  const byRole: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const user of users) {
    byRole[user.role] = (byRole[user.role] ?? 0) + 1;
    byStatus[user.status] = (byStatus[user.status] ?? 0) + 1;
  }
  const makers = users.filter((user) => user.isMaker).length;
  const checkers = users.filter((user) => user.isChecker).length;
  return {
    summary: {
      total: users.length,
      active: byStatus.ACTIVE ?? 0,
      invited: byStatus.INVITED ?? 0,
      suspended: byStatus.SUSPENDED ?? 0,
      disabled: byStatus.DISABLED ?? 0,
      makers,
      checkers,
      fourEyes: users.filter((user) => user.isMaker && user.isChecker).length,
      byRole,
      byStatus,
    },
  };
};

router.get("/users/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  response.json(await buildInternalUserSummary());
});

router.get("/users/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  const snapshot = await buildInternalUserSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "ACCESS_SCOPE_VERIFIED",
    "ROLE_STATUS_REVIEWED",
    "MAKER_CHECKER_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "INTERNAL_USER_SUMMARY_EXPORTED",
      entityType: "USER",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: snapshot.summary.total,
        active: snapshot.summary.active,
        invited: snapshot.summary.invited,
        makers: snapshot.summary.makers,
        checkers: snapshot.summary.checkers,
        checklist,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.get("/users/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const user = await client.user.findUnique({
    where: { id },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      merchantId: true,
      email: true,
      phone: true,
      role: true,
      authoritiesMap: true,
      appScopeIds: true,
      isMaker: true,
      isChecker: true,
      mfaRequired: true,
      status: true,
      invitedById: true,
      invitationExpiresAt: true,
      academyProgressJson: true,
    },
  });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  const [approvalHistory, auditTrail] = await Promise.all([
    client.approvalRequest.findMany({
      where: { OR: [{ makerUserId: user.id }, { checkerUserId: user.id }] },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        state: true,
        mode: true,
        makerUserId: true,
        checkerUserId: true,
        makerReason: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        maker: { select: { id: true, email: true } },
        checker: { select: { id: true, email: true } },
      },
    }),
    client.auditLog.findMany({
      where: { actorId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        action: true,
        role: true,
        entityType: true,
        entityId: true,
        beforeJson: true,
        afterJson: true,
        approvalRequestId: true,
      },
    }),
  ]);
  response.json({
    user: { ...user, academyProgressJson: publicProgress(user.academyProgressJson, loadCatalog(), new Date()) },
    approvalHistory,
    auditTrail,
  });
});

const STAFF_ROLES = [
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN",
  "FINANCE",
  "OPERATOR",
  "COMPLIANCE",
  "MLRO",
  "SUPPORT",
] as const;

/**
 * No self-escalation: a staff user can only hand out authorities they hold
 * themselves. The wildcard can only be granted by a holder of the wildcard.
 */
const assertGrantableAuthorities = (principal: { authorities: readonly string[] }, requested: readonly string[]): void => {
  const held = new Set(principal.authorities);
  const holdsWildcard = held.has("*");
  const excess = requested.filter((authority) => authority === "*" ? !holdsWildcard : !holdsWildcard && !held.has(authority));
  if (excess.length > 0) {
    throw new ApiError(403, "AUTHORITY_ESCALATION_FORBIDDEN", "You cannot grant authorities you do not hold", {
      authorities: excess,
    });
  }
};

router.post("/users", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:write", "security:write"]);
  const body = parseOrThrow(
    z
      .object({
        email: z.string().email(),
        phone: z.string().min(6).max(20).optional(),
        password: z.string().min(10).max(128).optional(),
        role: z.enum(STAFF_ROLES),
        authoritiesMap: z.array(z.string().min(1).max(64)).max(60).default([]),
        isMaker: z.boolean().default(false),
        isChecker: z.boolean().default(false),
        checklist: z.array(z.enum([
          "EMAIL_VERIFIED",
          "ROLE_SCOPE_CONFIRMED",
          "AUTHORITIES_REVIEWED",
          "MFA_REQUIREMENT_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const creator = principalOf(request);
  assertGrantableAuthorities(creator, body.authoritiesMap);
  const actor = actorFromRequest(request);
  // The maker/checker flags are never granted at creation: the user is created
  // INVITED with both off and, when they were requested, a maker-checker
  // approval carries the request.
  const wantsFlags = body.isMaker || body.isChecker;
  const { user, flagsApprovalId } = await client.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: body.email.trim().toLowerCase(),
        phone: body.phone ?? null,
        passwordHash: body.password ? await hashPassword(body.password) : null,
        role: body.role,
        authoritiesMap: body.authoritiesMap,
        isMaker: false,
        isChecker: false,
        mfaRequired: true,
        status: "INVITED",
        invitedById: actor.userId,
      },
    });
    let approvalId: string | null = null;
    if (wantsFlags) {
      const approval = await tx.approvalRequest.create({
        data: {
          subjectType: "USER",
          subjectId: created.id,
          payloadDiffJson: { isMaker: body.isMaker, isChecker: body.isChecker, checklist: body.checklist ?? [] },
          mode: "STANDARD",
          makerUserId: actor.userId,
          state: "PENDING_REVIEW",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      approvalId = approval.id;
    }
    return { user: created, flagsApprovalId: approvalId };
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "INTERNAL_USER_INVITED",
      entityType: "USER",
      entityId: user.id,
      beforeJson: {},
      afterJson: { email: user.email, role: user.role, checklist: body.checklist ?? [] },
    },
  });
  response.status(201).json({
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    ...(flagsApprovalId ? { approvalRequestId: flagsApprovalId, approvalStatus: "PENDING_REVIEW" } : {}),
  });
});

/**
 * Authority, role, maker/checker flag and activation changes of a staff user are
 * maker-checker requests; only restrictive changes (suspend, disable, back to
 * invited) are applied directly. Nobody changes their own record.
 */
const requiresUserApproval = (body: {
  authoritiesMap?: unknown;
  role?: unknown;
  isMaker?: unknown;
  isChecker?: unknown;
  status?: unknown;
}): boolean =>
  body.authoritiesMap !== undefined
  || body.role !== undefined
  || body.isMaker !== undefined
  || body.isChecker !== undefined
  || body.status === "ACTIVE";

const loadManagedStaffUser = async (request: Request, id: string) => {
  const user = await client.user.findUnique({ where: { id } });
  if (!user || user.merchantId !== null || String(user.role).startsWith("MERCHANT_")) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  if (user.id === principalOf(request).userId) {
    throw new ApiError(403, "SELF_MODIFICATION_FORBIDDEN", "You cannot change your own account");
  }
  return user;
};

router.patch("/users", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:write", "security:write"]);
  const body = parseOrThrow(
    z
      .object({
        id: z.string().min(1).max(64),
        authoritiesMap: z.array(z.string().min(1).max(64)).max(60).optional(),
        role: z.enum(STAFF_ROLES).optional(),
        status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
        isMaker: z.boolean().optional(),
        isChecker: z.boolean().optional(),
        checklist: z.array(z.enum([
          "SELECTION_REVIEWED",
          "STATUS_IMPACT_REVIEWED",
          "NOTIFICATION_PLANNED",
          "AUTHORITY_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const user = await loadManagedStaffUser(request, body.id);
  const actor = actorFromRequest(request);
  if (body.authoritiesMap) {
    assertGrantableAuthorities(principalOf(request), body.authoritiesMap);
  }
  if (requiresUserApproval(body)) {
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "USER",
        subjectId: user.id,
        payloadDiffJson: body,
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
    return;
  }
  const updated = await client.user.update({
    where: { id: user.id },
    data: {
      authoritiesMap: body.authoritiesMap,
      role: body.role as never,
      status: body.status,
      isMaker: body.isMaker,
      isChecker: body.isChecker,
    },
  });
  if (body.status !== undefined) {
    await writeAudit(client, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "ADMIN_USER_STATUS_UPDATED",
        entityType: "USER",
        entityId: user.id,
        beforeJson: { status: user.status },
        afterJson: { status: updated.status, checklist: body.checklist ?? [] },
      },
    });
  }
  response.json({ id: updated.id, role: updated.role, status: updated.status });
});

router.patch("/users/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:write", "security:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        authoritiesMap: z.array(z.string().min(1).max(64)).max(60).optional(),
        role: z.enum(STAFF_ROLES).optional(),
        status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
        checklist: z.array(z.enum([
          "SELECTION_REVIEWED",
          "STATUS_IMPACT_REVIEWED",
          "NOTIFICATION_PLANNED",
          "AUTHORITY_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const user = await loadManagedStaffUser(request, id);
  if (body.authoritiesMap) {
    assertGrantableAuthorities(principalOf(request), body.authoritiesMap);
  }
  if (requiresUserApproval(body)) {
    const actor = actorFromRequest(request);
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "USER",
        subjectId: user.id,
        payloadDiffJson: {
          ...(body.authoritiesMap ? { authoritiesMap: body.authoritiesMap } : {}),
          ...(body.role ? { role: body.role } : {}),
          ...(body.status === "ACTIVE" ? { status: "ACTIVE" } : {}),
          checklist: body.checklist ?? [],
        },
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
    return;
  }
  const updated = await client.user.update({
    where: { id: user.id },
    data: { status: body.status },
  });
  if (body.status !== undefined) {
    await writeAudit(client, {
      data: {
        actorId: actorFromRequest(request).userId,
        role: actorFromRequest(request).role,
        action: "ADMIN_USER_STATUS_UPDATED",
        entityType: "USER",
        entityId: user.id,
        beforeJson: { status: user.status },
        afterJson: { status: updated.status, checklist: body.checklist ?? [] },
      },
    });
  }
  response.json({ id: updated.id, role: updated.role, status: updated.status });
});


const publicKybDocumentSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  merchantId: true,
  joinRequestId: true,
  subjectType: true,
  subjectId: true,
  docType: true,
  originalFileName: true,
  sha256: true,
  mime: true,
  sizeBytes: true,
  avStatus: true,
  status: true,
  reviewedById: true,
  uploadedBy: { select: { id: true, email: true } },
  reviewedBy: { select: { id: true, email: true } },
  reviewedAt: true,
  expiresOn: true,
  rejectionReasonCode: true,
  reviewNotes: true,
  duplicateJustification: true,
  statusChangedAt: true,
  expiredAt: true,
} as const;


const KYB_OPEN_JOIN_STATUSES = ["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"] as const;

const kybDocumentContextSelect = {
  ...publicKybDocumentSelect,
  merchant: {
    select: {
      id: true,
      legalName: true,
      tradeName: true,
      status: true,
      kybStatus: true,
      riskTier: true,
      businessCategory: true,
      country: true,
      contactEmail: true,
      contactPhone: true,
    },
  },
  joinRequest: {
    select: {
      id: true,
      status: true,
      onboardingChannel: true,
      proposedRiskTier: true,
      slaDueAt: true,
      slaPausedAt: true,
      slaRemainingSeconds: true,
      assignedReviewer: { select: { id: true, email: true } },
    },
  },
} as const;

const contentAvailabilityForIds = async (ids: string[]): Promise<Map<string, boolean>> => {
  if (ids.length === 0) return new Map();
  const placeholders = postgresPlaceholders(ids.length, 1, "uuid");
  const rows = (await client.$queryRawUnsafe(
    `SELECT id, (content_ciphertext IS NOT NULL) AS contentAvailable FROM kyb_documents WHERE id IN (${placeholders})`,
    ...ids,
  )) as Array<{ id: string; contentAvailable: number | bigint | boolean }>;
  return new Map(rows.map((row) => [String(row.id), Boolean(Number(row.contentAvailable))]));
};

const subjectOwnerNames = async (documents: Array<{ subjectType: string; subjectId: string }>): Promise<Map<string, string>> => {
  const ids = documents
    .filter((document) => document.subjectType === "BENEFICIAL_OWNER")
    .map((document) => document.subjectId);
  if (ids.length === 0) return new Map();
  const owners = await client.beneficialOwner.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullNameAr: true, fullNameEn: true },
  });
  return new Map(owners.map((owner) => [owner.id, owner.fullNameEn || owner.fullNameAr]));
};

const duplicateDocumentsForHash = async (document: {
  id: string;
  merchantId: string;
  sha256: string;
}) => {
  const matches = await client.kybDocument.findMany({
    where: {
      sha256: document.sha256,
      id: { not: document.id },
      merchantId: { not: document.merchantId },
    },
    select: {
      id: true,
      merchantId: true,
      joinRequestId: true,
      docType: true,
      status: true,
      avStatus: true,
      createdAt: true,
      reviewedAt: true,
      merchant: { select: { id: true, legalName: true, tradeName: true, status: true, kybStatus: true } },
      joinRequest: { select: { id: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return matches;
};

const openJoinRequestForDocument = async (document: {
  merchantId: string;
  joinRequestId: string | null;
}) => {
  if (document.joinRequestId) {
    const linked = await client.joinRequest.findUnique({ where: { id: document.joinRequestId } });
    if (linked && KYB_OPEN_JOIN_STATUSES.includes(String(linked.status) as never)) {
      return linked;
    }
  }
  return client.joinRequest.findFirst({
    where: {
      merchantId: document.merchantId,
      status: { in: [...KYB_OPEN_JOIN_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
  });
};

const maybeRaiseDuplicateAmlCase = async (input: {
  document: { id: string; merchantId: string; sha256: string; docType: string };
  duplicateMerchantIds: string[];
  actorUserId: string;
  actorRole: string;
}): Promise<string | null> => {
  const distinctMerchants = new Set([input.document.merchantId, ...input.duplicateMerchantIds]);
  const policy = await readKybRefreshPolicy(client);
  if (distinctMerchants.size < policy.duplicateAmlThreshold) return null;
  const existing = await client.amlCase.findFirst({
    where: {
      subjectType: "MERCHANT",
      subjectId: input.document.merchantId,
      triggerReason: { startsWith: `KYB_DOCUMENT_REUSE:${input.document.sha256}` },
      status: { in: ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"] },
    },
    select: { id: true },
  });
  if (existing) return existing.id;
  const amlCaseId = await client.$transaction(async (tx) => {
    const amlCase = await tx.amlCase.create({
      data: {
        subjectType: "MERCHANT",
        subjectId: input.document.merchantId,
        triggerReason: `KYB_DOCUMENT_REUSE:${input.document.sha256}`,
        severity: "HIGH",
        severityInputsJson: {
          documentId: input.document.id,
          documentType: input.document.docType,
          sha256: input.document.sha256,
          duplicateMerchantIds: [...distinctMerchants].filter((id) => id !== input.document.merchantId),
          distinctMerchantCount: distinctMerchants.size,
        },
        status: "OPEN",
        slaDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        confidential: true,
        reviewerNotes: "The same KYB document hash was reused by multiple merchants and accepted with reviewer justification.",
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: input.actorUserId,
        role: input.actorRole,
        action: "KYB_DOCUMENT_REUSE_AML_CASE_OPENED",
        entityType: "AML_CASE",
        entityId: amlCase.id,
        beforeJson: {},
        afterJson: {
          documentId: input.document.id,
          merchantId: input.document.merchantId,
          sha256: input.document.sha256,
          distinctMerchantCount: distinctMerchants.size,
        },
      },
    });
    return amlCase.id;
  });
  return amlCaseId;
};

const adminJoinProfileSchema = z
  .object({
    legalName: z.string().min(2).max(200).optional(),
    tradeName: z.string().min(2).max(200).optional(),
    country: z.string().length(2).optional(),
    businessCategory: z.string().min(2).max(80).optional(),
    registrationNumber: z.string().max(64).optional(),
    taxId: z.string().max(64).optional(),
    registeredAddress: z.string().max(500).optional(),
    websiteUrl: z.string().url().max(300).optional(),
    contactPhone: z.string().min(6).max(40).optional(),
    contactEmail: z.string().email().max(160).optional(),
    expectedMonthlyVolume: z.string().regex(/^\d+(?:\.\d{1,4})?$/).max(32).optional(),
    currency: z.string().length(3).optional(),
    businessUseDescription: z.string().max(2000).optional(),
    payoutBankDetails: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const adminJoinCreateSchema = adminJoinProfileSchema
  .extend({
    merchantId: z.string().min(1).max(64).optional(),
    riskTier: z.enum(["LOW", "STANDARD", "HIGH"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.merchantId) ||
      Boolean(value.legalName && value.tradeName && (value.contactPhone || value.contactEmail)),
    { message: "A new merchant needs a legal name, a trade name and a phone or email" },
  );

const adminOwnerSchema = z
  .object({
    fullName: z.string().min(2).max(160),
    fullNameEn: z.string().min(2).max(160).optional(),
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
    identityNumber: z.string().min(4).max(32),
    nationality: z.string().length(2).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ownershipPercent: z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/).optional(),
    role: z.enum(["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]).optional(),
    pepDeclared: z.boolean().optional(),
    position: z.string().min(2).max(80).optional(),
  })
  .strict();

const JOIN_REQUEST_OPEN_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "IN_REVIEW",
  "INFO_REQUESTED",
  "PENDING_CHECKER",
] as const;

const profileInputOf = (body: z.infer<typeof adminJoinProfileSchema>): ProfileInput => ({
  legalName: body.legalName,
  tradeName: body.tradeName,
  country: body.country?.toUpperCase(),
  businessCategory: body.businessCategory,
  registrationNumber: body.registrationNumber,
  taxId: body.taxId,
  registeredAddress: body.registeredAddress,
  websiteUrl: body.websiteUrl,
  contactPhone: body.contactPhone ? normalizePhone(body.contactPhone) : undefined,
  contactEmail: body.contactEmail ? normalizeEmail(body.contactEmail) : undefined,
  expectedMonthlyVolume: body.expectedMonthlyVolume,
  currency: body.currency?.toUpperCase(),
  businessUseDescription: body.businessUseDescription,
});

const merchantDataOf = (
  body: z.infer<typeof adminJoinProfileSchema>,
): Prisma.MerchantUpdateInput => {
  const data: Prisma.MerchantUpdateInput = {};
  if (body.legalName !== undefined) data.legalName = body.legalName;
  if (body.tradeName !== undefined) data.tradeName = body.tradeName;
  if (body.country !== undefined) data.country = body.country.toUpperCase();
  if (body.businessCategory !== undefined) data.businessCategory = body.businessCategory;
  if (body.registrationNumber !== undefined) data.registrationNo = body.registrationNumber;
  if (body.taxId !== undefined) data.taxId = body.taxId;
  if (body.contactPhone !== undefined) data.contactPhone = normalizePhone(body.contactPhone);
  if (body.contactEmail !== undefined) data.contactEmail = normalizeEmail(body.contactEmail);
  if (body.payoutBankDetails !== undefined) {
    data.payoutBankDetailsJson = body.payoutBankDetails as Prisma.InputJsonValue;
    data.payoutAccountHash = payoutAccountHash(body.payoutBankDetails);
  }
  return data;
};

const invalidatePendingJoinApproval = async (
  tx: Prisma.TransactionClient,
  joinRequest: { id: string; status: string; approvalRequestId: string | null },
  reason: string,
): Promise<boolean> => {
  if (!joinRequest.approvalRequestId) return false;
  if (!["PENDING_CHECKER", "IN_REVIEW", "SUBMITTED"].includes(joinRequest.status)) return false;
  await tx.approvalRequest.update({
    where: { id: joinRequest.approvalRequestId },
    data: { state: "REJECTED", rejectionReason: reason },
  });
  await tx.joinRequest.update({
    where: { id: joinRequest.id },
    data: { status: "IN_REVIEW", approvalRequestId: null },
  });
  return true;
};

const refreshJoinScreening = async (joinRequestId: string): Promise<{
  screeningResult: string | null;
  screeningError: string | null;
}> => {
  const joinRequest = await client.joinRequest.findUnique({
    where: { id: joinRequestId },
    select: { merchantId: true, slaDueAt: true, slaPausedAt: true },
  });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  try {
    const screening = await runOnboardingScreening(joinRequest.merchantId, joinRequestId);
    const fourEyes = await resolveFourEyesForSubmission(joinRequest.merchantId, screening, joinRequestId);
    await client.joinRequest.update({
      where: { id: joinRequestId },
      data: {
        screeningId: screening.screeningId,
        lastScreenedAt: new Date(),
        fourEyesRequired: fourEyes.required,
        fourEyesReasons: fourEyes.reasons,
      },
    });
    return { screeningResult: screening.result, screeningError: null };
  } catch (error) {
    await client.joinRequest.update({
      where: { id: joinRequestId },
      data: { lastScreenedAt: new Date() },
    });
    return {
      screeningResult: "ERROR",
      screeningError: error instanceof Error ? error.message : "Screening failed",
    };
  }
};

const ownerCreateData = async (
  body: z.infer<typeof adminOwnerSchema>,
  merchantId: string,
): Promise<Prisma.BeneficialOwnerUncheckedCreateInput> => ({
  merchantId,
  fullNameAr: body.fullName,
  fullNameEn: body.fullNameEn ?? null,
  nationalIdCiphertext: await vault.encryptSecret(body.identityNumber, "kyb-national-id"),
  nationalIdHash: nationalIdHash(body.identityNumber),
  dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : new Date(),
  nationality: (body.nationality ?? "LY").toUpperCase(),
  ownershipPercent: body.ownershipPercent ? new Prisma.Decimal(body.ownershipPercent) : null,
  role: body.role ?? "OWNER",
  pepDeclared: body.pepDeclared ?? false,
  validFrom: new Date(),
});


const refreshJoinDuplicateFlags = async (joinRequestId: string): Promise<DuplicateFlag[]> => {
  const joinRequest = await client.joinRequest.findUnique({
    where: { id: joinRequestId },
    include: { merchant: true, kybDocuments: true },
  });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  const owners = await client.beneficialOwner.findMany({
    where: { merchantId: joinRequest.merchantId, active: true },
    select: { nationalIdHash: true },
  });
  const flags = await detectDuplicateFlags(client, {
    merchantId: joinRequest.merchantId,
    joinRequestId,
    taxId: joinRequest.merchant.taxId,
    registrationNo: joinRequest.merchant.registrationNo,
    contactPhone: joinRequest.merchant.contactPhone,
    contactEmail: joinRequest.merchant.contactEmail,
    payoutHash: joinRequest.merchant.payoutAccountHash,
    ownerHashes: owners.map((owner) => owner.nationalIdHash).filter((hash): hash is string => Boolean(hash)),
    documentHashes: joinRequest.kybDocuments.map((document) => document.sha256),
  });
  await client.joinRequest.update({
    where: { id: joinRequestId },
    data: { duplicateFlagsJson: flags as unknown as Prisma.InputJsonValue },
  });
  return flags;
};

const joinRequestDetail = async (id: string, role: string | null) => {
  const joinRequest = await client.joinRequest.findUnique({
    where: { id },
    include: {
      merchant: { include: { wallets: true } },
      submittedBy: { select: { id: true, email: true } },
      assignedReviewer: { select: { id: true, email: true } },
      approvalRequest: true,
      screening: { include: { matches: true, amlCases: true } },
      kybDocuments: {
        select: publicKybDocumentSelect,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  const beneficialOwners = await client.beneficialOwner.findMany({
    where: { merchantId: joinRequest.merchantId },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  const readiness = await computeJoinRequestReadiness(client, id);
  const auditTrail = await client.auditLog.findMany({
    where: { entityType: "JOIN_REQUEST", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      createdAt: true,
      action: true,
      role: true,
      beforeJson: true,
      afterJson: true,
      approvalRequestId: true,
      actor: { select: { id: true, email: true } },
    },
  });
  const confidential = role === "COMPLIANCE" || role === "MLRO";
  const screening = joinRequest.screening
    ? {
        ...joinRequest.screening,
        matches: joinRequest.screening.matches.map((match) => confidential
          ? match
          : {
              ...match,
              listName: "[REDACTED]",
              listEntryRef: "[REDACTED]",
              matchedName: "[REDACTED]",
              attributesJson: {},
              dispositionNotes: null,
            }),
      }
    : null;
  return {
    ...joinRequest,
    screening,
    beneficialOwners,
    readiness,
    auditTrail,
    checklistKeys: JOIN_REQUEST_CHECKLIST_KEYS,
    amlDetailsRedacted: !confidential,
  };
};

router.get("/join-requests", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const built = buildListQuery(request.query, {
    search: ["merchant.legalName", "merchant.tradeName", "merchant.contactEmail", "merchant.contactPhone"],
    in: { status: "status" }, equals: {merchantId: "merchantId", proposedRiskTier: "proposedRiskTier", onboardingChannel: "onboardingChannel", assignedReviewerId: "assignedReviewerId"},
    dates: { createdAt: { path: "createdAt" }, slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { status: "status", submittedAt: "createdAt", slaDueAt: "slaDueAt", riskTier: "proposedRiskTier" },
    defaultSort: { createdAt: "desc" },
  });
  const [joinRequests, total] = await Promise.all([
    client.joinRequest.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { merchant: true, kybDocuments: { select: publicKybDocumentSelect }, assignedReviewer: { select: { email: true } } }, skip: built.skip, take: built.take }),
    client.joinRequest.count({ where: built.where as never }),
  ]);
  response.json(listResponse("joinRequests", joinRequests.map((entry) => ({
    ...entry,
    merchantName: entry.merchant?.tradeName ?? "",
    riskTier: entry.proposedRiskTier,
    submittedAt: entry.submittedAt ?? entry.createdAt,
    reviewer: entry.assignedReviewer?.email ?? "",
  })), total, built));
});

router.get("/join-requests/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const built = buildListQuery(request.query, {
    search: ["merchant.legalName", "merchant.tradeName", "merchant.contactEmail", "merchant.contactPhone"],
    in: { status: "status" }, equals: {merchantId: "merchantId", proposedRiskTier: "proposedRiskTier", onboardingChannel: "onboardingChannel", assignedReviewerId: "assignedReviewerId"},
    dates: { createdAt: { path: "createdAt" }, slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { status: "status", submittedAt: "createdAt", slaDueAt: "slaDueAt", riskTier: "proposedRiskTier" },
    defaultSort: { createdAt: "desc" },
  });
  const take = 5000;
  const [joinRequests, total] = await Promise.all([
    client.joinRequest.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        merchant: { select: { id: true, tradeName: true, legalName: true } },
        assignedReviewer: { select: { email: true } },
      },
      take,
    }),
    client.joinRequest.count({ where: built.where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "JOIN_REQUESTS_EXPORTED",
      entityType: "JOIN_REQUEST",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: joinRequests.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    joinRequests: joinRequests.map((entry) => ({
      id: entry.id,
      merchantId: entry.merchantId,
      merchantName: entry.merchant?.tradeName ?? "",
      legalName: entry.merchant?.legalName ?? "",
      status: entry.status,
      riskTier: entry.proposedRiskTier,
      onboardingChannel: entry.onboardingChannel,
      submittedAt: entry.submittedAt ?? entry.createdAt,
      createdAt: entry.createdAt,
      slaDueAt: entry.slaDueAt,
      slaPausedAt: entry.slaPausedAt,
      reviewer: entry.assignedReviewer?.email ?? "",
      fourEyesRequired: entry.fourEyesRequired,
      decision: entry.decision ?? null,
      decisionReasonCode: entry.decisionReasonCode ?? null,
    })),
    total,
    exported: joinRequests.length,
    truncated: total > joinRequests.length,
  });
});

const buildJoinRequestSummary = async () => {
  const now = new Date();
  const requests = await client.joinRequest.findMany({
    select: {
      status: true,
      proposedRiskTier: true,
      slaDueAt: true,
      slaPausedAt: true,
      assignedReviewerId: true,
      fourEyesRequired: true,
    },
  });
  const byStatus: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
  let overdue = 0;
  let dueSoon = 0;
  let unassigned = 0;
  let pendingChecker = 0;
  let fourEyes = 0;
  const openStatuses = new Set<string>(JOIN_REQUEST_OPEN_STATUSES);
  for (const entry of requests) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    byRisk[entry.proposedRiskTier] = (byRisk[entry.proposedRiskTier] ?? 0) + 1;
    if (openStatuses.has(entry.status) && !entry.slaPausedAt) {
      if (entry.slaDueAt.getTime() < now.getTime()) overdue += 1;
      else if (entry.slaDueAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000) dueSoon += 1;
    }
    if (entry.status === "PENDING_CHECKER") pendingChecker += 1;
    if (!entry.assignedReviewerId && openStatuses.has(entry.status)) unassigned += 1;
    if (entry.fourEyesRequired && openStatuses.has(entry.status)) fourEyes += 1;
  }
  return {
    summary: {
      total: requests.length,
      open: requests.filter((entry) => openStatuses.has(entry.status)).length,
      submitted: byStatus.SUBMITTED ?? 0,
      inReview: byStatus.IN_REVIEW ?? 0,
      infoRequested: byStatus.INFO_REQUESTED ?? 0,
      pendingChecker,
      approved: byStatus.APPROVED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      overdue,
      dueSoon,
      unassigned,
      fourEyes,
      byStatus,
      byRisk,
    },
  };
};

router.get("/join-requests/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  response.json(await buildJoinRequestSummary());
});

router.get("/join-requests/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const snapshot = await buildJoinRequestSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "JOIN_REQUEST_SUMMARY_EXPORTED",
      entityType: "JOIN_REQUEST",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: snapshot.summary.total,
        open: snapshot.summary.open,
        overdue: snapshot.summary.overdue,
        unassigned: snapshot.summary.unassigned,
        fourEyes: snapshot.summary.fourEyes,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.get("/join-requests/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const principal = principalOf(request);
  response.json({ joinRequest: await joinRequestDetail(id, principal.role ?? null) });
});

router.post("/join-requests/admin-assisted", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const body = parseOrThrow(adminJoinCreateSchema, request.body);
  const actor = actorFromRequest(request);
  const profileInput = profileInputOf(body);
  const profileJson = buildProfileJson(profileInput);
  const merchantData = merchantDataOf(body);
  const riskTier = body.riskTier ?? "STANDARD";

  if (body.merchantId) {
    const merchant = await client.merchant.findUnique({ where: { id: body.merchantId } });
    if (!merchant) {
      throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
    }
    if (!["PENDING", "REJECTED"].includes(merchant.status)) {
      throw new ApiError(
        409,
        "MERCHANT_NOT_ONBOARDABLE",
        "Admin-assisted onboarding is only available for pending or rejected merchants",
      );
    }
    const existingOpen = await client.joinRequest.findFirst({
      where: {
        merchantId: merchant.id,
        status: { in: [...JOIN_REQUEST_OPEN_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (existingOpen) {
      throw new ApiError(409, "JOIN_REQUEST_ALREADY_OPEN", "The merchant already has an open join request", {
        joinRequestId: existingOpen.id,
        status: existingOpen.status,
      });
    }
    const result = await client.$transaction(async (tx) => {
      await tx.merchant.update({
        where: { id: merchant.id },
        data: {
          ...merchantData,
          status: "PENDING",
          kybStatus: "PENDING",
          riskTier,
          onboardingChannel: "ADMIN_ASSISTED",
        },
      });
      const joinRequest = await tx.joinRequest.create({
        data: {
          merchantId: merchant.id,
          submittedByUserId: actor.userId,
          status: "DRAFT",
          onboardingChannel: "ADMIN_ASSISTED",
          slaDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
          proposedRiskTier: riskTier,
          fourEyesRequired: false,
          fourEyesReasons: [],
          profileJson: profileJson as Prisma.InputJsonValue,
        },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "SYSTEM",
          action: "JOIN_REQUEST_ADMIN_ASSISTED_CREATED",
          entityType: "JOIN_REQUEST",
          entityId: joinRequest.id,
          beforeJson: {},
          afterJson: {
            merchantId: merchant.id,
            existingMerchant: true,
            onboardingChannel: "ADMIN_ASSISTED",
          },
        },
      });
      return { merchantId: merchant.id, joinRequestId: joinRequest.id };
    });
    await refreshJoinDuplicateFlags(result.joinRequestId);
    response.status(201).json({
      ...result,
      status: "DRAFT",
      existingMerchant: true,
      invited: false,
    });
    return;
  }

  const phone = body.contactPhone ? normalizePhone(body.contactPhone) : null;
  const email = body.contactEmail ? normalizeEmail(body.contactEmail) : null;
  if (phone) {
    const existing = await client.userIdentity.findFirst({ where: { kind: "PHONE", identifierNormalized: phone } });
    if (existing) {
      throw new ApiError(409, "IDENTITY_ALREADY_REGISTERED", "The phone number is already linked to an account");
    }
  }
  if (email) {
    const existing = await client.userIdentity.findFirst({ where: { kind: "EMAIL", identifierNormalized: email } });
    if (existing) {
      throw new ApiError(409, "IDENTITY_ALREADY_REGISTERED", "The email address is already linked to an account");
    }
    const existingUser = await client.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ApiError(409, "IDENTITY_ALREADY_REGISTERED", "The email address is already linked to an account");
    }
  }

  const invitationToken = randomBytes(24).toString("base64url");
  const invitationTokenHash = createHash("sha256").update(invitationToken).digest("hex");
  const invitationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const userEmail = email ?? `${phone}@invited.payment-gateway.local`;

  const result = await client.$transaction(async (tx) => {
    const merchant = await tx.merchant.create({
      data: {
        legalName: body.legalName!,
        tradeName: body.tradeName!,
        country: body.country?.toUpperCase() ?? "LY",
        businessCategory: body.businessCategory,
        registrationNo: body.registrationNumber,
        taxId: body.taxId,
        contactPhone: phone,
        contactEmail: email,
        status: "PENDING",
        kybStatus: "PENDING",
        riskTier,
        onboardingChannel: "ADMIN_ASSISTED",
        payoutBankDetailsJson: body.payoutBankDetails as Prisma.InputJsonValue | undefined,
        payoutAccountHash: payoutAccountHash(body.payoutBankDetails),
      },
    });
    const user = await tx.user.create({
      data: {
        merchantId: merchant.id,
        email: userEmail,
        phone,
        role: "MERCHANT_ADMIN",
        authoritiesMap: ["merchant:read", "merchant:write", "link:write", "payment:read"] as Prisma.InputJsonValue,
        isMaker: true,
        isChecker: false,
        mfaRequired: true,
        status: "INVITED",
        invitationTokenHash,
        invitationExpiresAt,
        invitedById: actor.userId,
      },
    });
    if (phone) {
      await tx.userIdentity.create({
        data: { userId: user.id, kind: "PHONE", identifierNormalized: phone, isPrimary: true },
      });
    }
    if (email) {
      await tx.userIdentity.create({
        data: { userId: user.id, kind: "EMAIL", identifierNormalized: email, isPrimary: !phone },
      });
    }
    const glAccount = await tx.glAccount.create({
      data: {
        accountType: "MERCHANT_WALLET",
        ownerId: merchant.id,
        currency: "LYD",
      },
    });
    await tx.wallet.create({
      data: { merchantId: merchant.id, glAccountId: glAccount.id, currency: "LYD", status: "PENDING" },
    });
    const joinRequest = await tx.joinRequest.create({
      data: {
        merchantId: merchant.id,
        submittedByUserId: actor.userId,
        status: "DRAFT",
        onboardingChannel: "ADMIN_ASSISTED",
        slaDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        proposedRiskTier: riskTier,
        fourEyesRequired: false,
        fourEyesReasons: [],
        profileJson: profileJson as Prisma.InputJsonValue,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_ADMIN_ASSISTED_CREATED",
        entityType: "JOIN_REQUEST",
        entityId: joinRequest.id,
        beforeJson: {},
        afterJson: {
          merchantId: merchant.id,
          userId: user.id,
          existingMerchant: false,
          onboardingChannel: "ADMIN_ASSISTED",
        },
      },
    });
    return { merchantId: merchant.id, userId: user.id, joinRequestId: joinRequest.id };
  });
  await refreshJoinDuplicateFlags(result.joinRequestId);
  response.status(201).json({
    ...result,
    status: "DRAFT",
    existingMerchant: false,
    invited: true,
    invitationToken,
    invitationExpiresAt,
  });
});

router.patch("/join-requests/:id/profile", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(adminJoinProfileSchema, request.body);
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id }, include: { merchant: true } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (!["DRAFT", "INFO_REQUESTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_EDITABLE", "The join request profile can no longer be edited");
  }
  const profileJson = buildProfileJson(profileInputOf(body), joinRequest.profileJson);
  const merchantData = merchantDataOf(body);
  await client.$transaction(async (tx) => {
    if (Object.keys(merchantData).length > 0) {
      await tx.merchant.update({ where: { id: joinRequest.merchantId }, data: merchantData });
    }
    await tx.joinRequest.update({
      where: { id },
      data: { profileJson: profileJson as Prisma.InputJsonValue },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_PROFILE_UPDATED",
        entityType: "JOIN_REQUEST",
        entityId: id,
        beforeJson: joinRequest.profileJson ?? {},
        afterJson: profileJson as Prisma.InputJsonValue,
      },
    });
  });
  const duplicateFlags = await refreshJoinDuplicateFlags(id);
  const readiness = await computeJoinRequestReadiness(client, id);
  response.json({ id, readiness, duplicateFlags });
});

router.post("/join-requests/:id/beneficial-owners", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(adminOwnerSchema, request.body);
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_EDITABLE", "The join request can no longer be edited");
  }
  const wasSubmitted = ["SUBMITTED", "IN_REVIEW", "PENDING_CHECKER"].includes(joinRequest.status);
  const data = await ownerCreateData(body, joinRequest.merchantId);
  const owner = await client.$transaction(async (tx) => {
    await invalidatePendingJoinApproval(tx, joinRequest, "SUPERSEDED_BY_BENEFICIAL_OWNER_CHANGE");
    const created = await tx.beneficialOwner.create({ data });
    if (wasSubmitted) {
      await tx.joinRequest.update({ where: { id }, data: { status: "IN_REVIEW" } });
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_BENEFICIAL_OWNER_ADDED",
        entityType: "JOIN_REQUEST",
        entityId: id,
        beforeJson: {},
        afterJson: { beneficialOwnerId: created.id, ownershipPercent: body.ownershipPercent ?? null },
      },
    });
    return created;
  });
  const duplicateFlags = await refreshJoinDuplicateFlags(id);
  const screening = wasSubmitted ? await refreshJoinScreening(id) : { screeningResult: null, screeningError: null };
  const { nationalIdCiphertext: _ciphertext, ...safeOwner } = owner;
  response.status(201).json({ owner: safeOwner, duplicateFlags, screening });
});

router.patch("/join-requests/:id/beneficial-owners/:ownerId", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const params = parseOrThrow(
    z.object({
      id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
      ownerId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    }).strict(),
    request.params,
  );
  const body = parseOrThrow(adminOwnerSchema.partial().strict(), request.body);
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, "BENEFICIAL_OWNER_UPDATE_REQUIRED", "At least one beneficial owner field is required");
  }
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id: params.id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_EDITABLE", "The join request can no longer be edited");
  }
  const owner = await client.beneficialOwner.findFirst({
    where: { id: params.ownerId, merchantId: joinRequest.merchantId },
  });
  if (!owner) {
    throw new ApiError(404, "BENEFICIAL_OWNER_NOT_FOUND", "The beneficial owner does not exist");
  }
  const wasSubmitted = ["SUBMITTED", "IN_REVIEW", "PENDING_CHECKER"].includes(joinRequest.status);
  const data: Prisma.BeneficialOwnerUpdateInput = {};
  if (body.fullName !== undefined) data.fullNameAr = body.fullName;
  if (body.fullNameEn !== undefined) data.fullNameEn = body.fullNameEn;
  if (body.identityNumber !== undefined) {
    data.nationalIdCiphertext = await vault.encryptSecret(body.identityNumber, "kyb-national-id");
    data.nationalIdHash = nationalIdHash(body.identityNumber);
  }
  if (body.nationality !== undefined) data.nationality = body.nationality.toUpperCase();
  if (body.dateOfBirth !== undefined) data.dateOfBirth = new Date(body.dateOfBirth);
  if (body.ownershipPercent !== undefined) data.ownershipPercent = new Prisma.Decimal(body.ownershipPercent);
  if (body.role !== undefined) data.role = body.role;
  if (body.pepDeclared !== undefined) data.pepDeclared = body.pepDeclared;
  const updated = await client.$transaction(async (tx) => {
    await invalidatePendingJoinApproval(tx, joinRequest, "SUPERSEDED_BY_BENEFICIAL_OWNER_CHANGE");
    const saved = await tx.beneficialOwner.update({ where: { id: owner.id }, data });
    if (wasSubmitted) {
      await tx.joinRequest.update({ where: { id: params.id }, data: { status: "IN_REVIEW" } });
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_BENEFICIAL_OWNER_UPDATED",
        entityType: "JOIN_REQUEST",
        entityId: params.id,
        beforeJson: { beneficialOwnerId: owner.id },
        afterJson: { beneficialOwnerId: owner.id },
      },
    });
    return saved;
  });
  const duplicateFlags = await refreshJoinDuplicateFlags(params.id);
  const screening = wasSubmitted ? await refreshJoinScreening(params.id) : { screeningResult: null, screeningError: null };
  const { nationalIdCiphertext: _ciphertext, ...safeOwner } = updated;
  response.json({ owner: safeOwner, duplicateFlags, screening });
});

router.delete("/join-requests/:id/beneficial-owners/:ownerId", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const params = parseOrThrow(
    z.object({
      id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
      ownerId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    }).strict(),
    request.params,
  );
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id: params.id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_EDITABLE", "The join request can no longer be edited");
  }
  const owner = await client.beneficialOwner.findFirst({
    where: { id: params.ownerId, merchantId: joinRequest.merchantId, active: true },
  });
  if (!owner) {
    throw new ApiError(404, "BENEFICIAL_OWNER_NOT_FOUND", "The beneficial owner does not exist");
  }
  const wasSubmitted = ["SUBMITTED", "IN_REVIEW", "PENDING_CHECKER"].includes(joinRequest.status);
  await client.$transaction(async (tx) => {
    await invalidatePendingJoinApproval(tx, joinRequest, "SUPERSEDED_BY_BENEFICIAL_OWNER_CHANGE");
    await tx.beneficialOwner.update({
      where: { id: owner.id },
      data: { active: false, validTo: new Date() },
    });
    if (wasSubmitted) {
      await tx.joinRequest.update({ where: { id: params.id }, data: { status: "IN_REVIEW" } });
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_BENEFICIAL_OWNER_REMOVED",
        entityType: "JOIN_REQUEST",
        entityId: params.id,
        beforeJson: { beneficialOwnerId: owner.id },
        afterJson: { beneficialOwnerId: owner.id, active: false },
      },
    });
  });
  const duplicateFlags = await refreshJoinDuplicateFlags(params.id);
  const screening = wasSubmitted ? await refreshJoinScreening(params.id) : { screeningResult: null, screeningError: null };
  response.json({ id: owner.id, active: false, duplicateFlags, screening });
});

router.post("/join-requests/:id/kyb-documents", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const actor = actorFromRequest(request);
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (raw.byteLength === 0) {
    throw new ApiError(400, "UPLOAD_REQUIRED", "A KYB document payload is required");
  }
  if (raw.byteLength > 10 * 1024 * 1024) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "KYB documents must be 10 MiB or smaller");
  }
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (!["DRAFT", "INFO_REQUESTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_EDITABLE", "Documents can no longer be edited for this join request");
  }
  const declaredMime = typeof request.headers["x-upload-content-type"] === "string"
    ? (request.headers["x-upload-content-type"] as string)
    : undefined;
  const mime = assertUploadSignature(raw, declaredMime);
  let metadata: Record<string, unknown> = {};
  const metadataHeader = request.headers["x-upload-metadata"];
  if (typeof metadataHeader === "string") {
    try {
      metadata = JSON.parse(Buffer.from(metadataHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new ApiError(400, "UPLOAD_METADATA_INVALID", "The upload metadata is not valid JSON");
    }
  }
  const docType = parseOrThrow(
    z.enum([
      "COMMERCIAL_REGISTRY",
      "TAX_CERTIFICATE",
      "ARTICLES_OF_ASSOCIATION",
      "OWNER_ID",
      "SIGNATORY_ID",
      "PROOF_OF_ADDRESS",
      "BANK_LETTER",
      "SECTOR_LICENSE",
      "OTHER",
    ]),
    String(metadata.documentType ?? "OTHER").toUpperCase().replaceAll(" ", "_"),
  );
  const originalFileName = String(metadata.fileName ?? "document").slice(0, 255);
  const expiresOn = typeof metadata.expiresOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(metadata.expiresOn)
    ? new Date(metadata.expiresOn)
    : null;
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const avStatus = scanKybBytes(raw);
  const infected = avStatus === "INFECTED";
  const storageKey = `kyb/${joinRequest.merchantId}/${sha256}`;
  const document = await client.kybDocument.create({
    data: {
      merchantId: joinRequest.merchantId,
      joinRequestId: id,
      subjectType: "MERCHANT",
      subjectId: joinRequest.merchantId,
      docType,
      storageKey,
      originalFileName,
      contentCiphertext: await vault.encryptSecret(raw.toString("base64"), "kyb-document"),
      sha256,
      mime,
      sizeBytes: raw.byteLength,
      avStatus,
      status: infected ? "REJECTED" : "UPLOADED",
      uploadedById: actor.userId,
      expiresOn,
    },
  });
  const duplicateFlags = await refreshJoinDuplicateFlags(id);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "JOIN_REQUEST_KYB_DOCUMENT_UPLOADED",
      entityType: "KYB_DOCUMENT",
      entityId: document.id,
      beforeJson: {},
      afterJson: { joinRequestId: id, docType, avStatus, sha256 },
    },
  });
  const payload = {
    id: document.id,
    docType: document.docType,
    originalFileName: document.originalFileName,
    status: document.status,
    avStatus: document.avStatus,
    sha256,
    duplicateFlags,
  };
  if (infected) {
    response.status(422).json({
      code: "KIB_DOCUMENT_INFECTED",
      message: "The uploaded document failed malware scanning",
      details: payload,
    });
    return;
  }
  response.status(201).json(payload);
});

router.delete("/join-requests/:id/kyb-documents/:docId", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const params = parseOrThrow(
    z.object({
      id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
      docId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    }).strict(),
    request.params,
  );
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id: params.id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (!["DRAFT", "INFO_REQUESTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_EDITABLE", "Documents can no longer be edited for this join request");
  }
  const document = await client.kybDocument.findFirst({
    where: { id: params.docId, joinRequestId: params.id },
  });
  if (!document) {
    throw new ApiError(404, "KIB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  await client.kybDocument.delete({ where: { id: document.id } });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "JOIN_REQUEST_KYB_DOCUMENT_DELETED",
      entityType: "KYB_DOCUMENT",
      entityId: document.id,
      beforeJson: { joinRequestId: params.id, docType: document.docType, sha256: document.sha256 },
      afterJson: {},
    },
  });
  const duplicateFlags = await refreshJoinDuplicateFlags(params.id);
  response.json({ id: document.id, deleted: true, duplicateFlags });
});

router.get("/kyb-documents/:id/content", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const actor = actorFromRequest(request);
  const document = await client.kybDocument.findUnique({ where: { id } });
  if (!document) {
    throw new ApiError(404, "KIB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  if (document.avStatus !== "CLEAN") {
    throw new ApiError(409, "KIB_DOCUMENT_NOT_SCANNED", "The KYB document has not passed malware scanning");
  }
  if (!document.contentCiphertext) {
    throw new ApiError(404, "KIB_DOCUMENT_CONTENT_MISSING", "The KYB document content is not available");
  }
  const base64 = await vault.decryptSecret(document.contentCiphertext);
  const content = Buffer.from(base64, "base64");
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "JOIN_REQUEST_KYB_DOCUMENT_VIEWED",
      entityType: "KYB_DOCUMENT",
      entityId: document.id,
      beforeJson: {},
      afterJson: { joinRequestId: document.joinRequestId, mime: document.mime, sizeBytes: document.sizeBytes },
    },
  });
  const fileName = (document.originalFileName ?? "document").replace(/["\r\n]/g, "_");
  response.setHeader("Content-Type", document.mime);
  response.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.send(content);
});

router.post("/join-requests/:id/submit", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({
    where: { id },
    include: { merchant: true, kybDocuments: true },
  });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (!["DRAFT", "INFO_REQUESTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_SUBMITTABLE", "The join request is not in a submittable state");
  }
  const owners = await client.beneficialOwner.findMany({
    where: { merchantId: joinRequest.merchantId, active: true },
  });
  if (!joinRequest.merchant.legalName || !joinRequest.merchant.tradeName) {
    throw new ApiError(409, "JOIN_REQUEST_PROFILE_INCOMPLETE", "The merchant legal and trade names are required");
  }
  if (!joinRequest.merchant.contactPhone && !joinRequest.merchant.contactEmail) {
    throw new ApiError(409, "JOIN_REQUEST_PROFILE_INCOMPLETE", "A merchant phone or email is required");
  }
  if (!joinRequest.merchant.payoutBankDetailsJson) {
    throw new ApiError(409, "JOIN_REQUEST_PAYOUT_BANK_REQUIRED", "Payout bank details are required");
  }
  // GAP-017: the KYB payout hash is mandatory; it binds every cash-out destination.
  const payoutHash = joinRequest.merchant.payoutAccountHash
    ?? payoutAccountHash(joinRequest.merchant.payoutBankDetailsJson);
  if (!payoutHash) {
    throw new ApiError(
      409,
      "JOIN_REQUEST_PAYOUT_HASH_REQUIRED",
      "The payout bank details must include a bank and an account number or IBAN",
    );
  }
  if (!joinRequest.merchant.payoutAccountHash) {
    await client.merchant.update({
      where: { id: joinRequest.merchantId },
      data: { payoutAccountHash: payoutHash },
    });
  }
  if (owners.length === 0) {
    throw new ApiError(409, "JOIN_REQUEST_OWNER_REQUIRED", "At least one beneficial owner is required");
  }
  if (joinRequest.kybDocuments.length === 0) {
    throw new ApiError(409, "KIB_DOCUMENTS_REQUIRED", "At least one KYB document is required before submission");
  }
  const screening = await runOnboardingScreening(joinRequest.merchantId, joinRequest.id);
  if (screening.result === "ERROR") {
    throw new ApiError(503, "SCREENING_UNAVAILABLE", "The AML screening provider is unavailable", {
      screeningId: screening.screeningId,
    });
  }
  if (screening.blocked) {
    throw new ApiError(403, "AML_CONFIRMED_MATCH", "The onboarding screening produced a confirmed watch list match", {
      screeningId: screening.screeningId,
      amlCaseId: screening.amlCaseId,
    });
  }
  const fourEyes = await resolveFourEyesForSubmission(joinRequest.merchantId, screening, joinRequest.id);
  const now = new Date();
  const remainingSeconds = joinRequest.slaRemainingSeconds
    ?? Math.max(0, Math.floor((joinRequest.slaDueAt.getTime() - now.getTime()) / 1000));
  const slaDueAt = joinRequest.slaPausedAt
    ? new Date(now.getTime() + remainingSeconds * 1000)
    : joinRequest.slaDueAt;
  const duplicateFlags = await refreshJoinDuplicateFlags(id);
  await client.joinRequest.update({
    where: { id },
    data: {
      status: screening.joinRequestStatus as never,
      submittedAt: now,
      screeningId: screening.screeningId,
      lastScreenedAt: now,
      fourEyesRequired: fourEyes.required,
      fourEyesReasons: fourEyes.reasons,
      duplicateFlagsJson: duplicateFlags as unknown as Prisma.InputJsonValue,
      slaPausedAt: null,
      slaRemainingSeconds: null,
      slaDueAt,
      infoRequestJson: Prisma.DbNull,
    },
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "JOIN_REQUEST_ADMIN_ASSISTED_SUBMITTED",
      entityType: "JOIN_REQUEST",
      entityId: id,
      beforeJson: { status: joinRequest.status },
      afterJson: {
        status: screening.joinRequestStatus,
        screeningId: screening.screeningId,
        fourEyesRequired: fourEyes.required,
      },
    },
  });
  const readiness = await computeJoinRequestReadiness(client, id);
  response.json({
    id,
    status: screening.joinRequestStatus,
    screeningResult: screening.result,
    fourEyesRequired: fourEyes.required,
    fourEyesReasons: fourEyes.reasons,
    readiness,
  });
});

router.post("/join-requests/:id/withdraw", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_WITHDRAWABLE", "The join request is no longer open");
  }
  await client.$transaction(async (tx) => {
    await invalidatePendingJoinApproval(tx, joinRequest, "SUPERSEDED_BY_WITHDRAWAL");
    await tx.joinRequest.update({
      where: { id },
      data: { status: "WITHDRAWN", approvalRequestId: null },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_WITHDRAWN",
        entityType: "JOIN_REQUEST",
        entityId: id,
        beforeJson: { status: joinRequest.status },
        afterJson: { status: "WITHDRAWN" },
      },
    });
  });
  response.json({ id, status: "WITHDRAWN" });
});

router.patch("/join-requests/:id/checklist", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ items: z.record(z.string(), z.boolean()) }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (!["SUBMITTED", "IN_REVIEW"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_CHECKLIST_LOCKED", "The review checklist can no longer be edited");
  }
  const knownKeys = new Set<string>(JOIN_REQUEST_CHECKLIST_KEYS);
  const unknownKeys = Object.keys(body.items).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ApiError(400, "CHECKLIST_ITEM_UNKNOWN", "The review checklist contains unknown items", { unknownKeys });
  }
  const current = (joinRequest.reviewChecklistJson ?? {}) as Record<string, unknown>;
  const checklist = { ...current, ...body.items };
  await client.$transaction(async (tx) => {
    await tx.joinRequest.update({
      where: { id },
      data: { reviewChecklistJson: checklist as Prisma.InputJsonValue },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_CHECKLIST_UPDATED",
        entityType: "JOIN_REQUEST",
        entityId: id,
        beforeJson: current as Prisma.InputJsonValue,
        afterJson: checklist as Prisma.InputJsonValue,
      },
    });
  });
  const readiness = await computeJoinRequestReadiness(client, id);
  response.json({ id, checklist, readiness });
});

router.post("/join-requests/:id/screening/retry", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (!["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_SCREENING_LOCKED", "Screening cannot be retried in this state");
  }
  const screening = await refreshJoinScreening(id);
  if (screening.screeningError) {
    throw new ApiError(503, "SCREENING_UNAVAILABLE", "The AML screening provider is unavailable", {
      reason: screening.screeningError,
    });
  }
  const duplicateFlags = await refreshJoinDuplicateFlags(id);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "JOIN_REQUEST_SCREENING_RETRIED",
      entityType: "JOIN_REQUEST",
      entityId: id,
      beforeJson: {},
      afterJson: { screeningResult: screening.screeningResult },
    },
  });
  const readiness = await computeJoinRequestReadiness(client, id);
  response.json({ id, screeningResult: screening.screeningResult, duplicateFlags, readiness });
});

router.post("/join-requests/:id/assign", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({ reviewerId: z.string().min(1).max(64) }).strict(), request.body);
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  const updated = await client.joinRequest.update({
    where: { id },
    data: { assignedReviewerId: body.reviewerId, status: "IN_REVIEW" },
  });
  response.json({ id: updated.id, status: updated.status, assignedReviewerId: updated.assignedReviewerId });
});

router.post("/join-requests/:id/request-info", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ items: z.array(z.object({ field: z.string().max(80), message: z.string().max(500) })).min(1) }).strict(),
    request.body,
  );
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  const actor = actorFromRequest(request);
  const now = new Date();
  const remainingSeconds = joinRequest.slaRemainingSeconds
    ?? Math.max(0, Math.floor((joinRequest.slaDueAt.getTime() - now.getTime()) / 1000));
  const updated = await client.joinRequest.update({
    where: { id },
    data: {
      status: "INFO_REQUESTED",
      infoRequestJson: body.items,
      slaPausedAt: joinRequest.slaPausedAt ?? now,
      slaRemainingSeconds: remainingSeconds,
    },
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "JOIN_REQUEST_INFO_REQUESTED",
      entityType: "JOIN_REQUEST",
      entityId: id,
      beforeJson: { status: joinRequest.status },
      afterJson: { status: "INFO_REQUESTED", items: body.items.length },
    },
  });
  response.json({ id: updated.id, status: updated.status, slaPausedAt: updated.slaPausedAt });
});

router.post("/join-requests/:id/decide", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        decision: z.enum(["APPROVED", "REJECTED"]),
        reasonCode: z.string().max(64).optional(),
        notes: z.string().max(4000).optional(),
        proposedRiskTier: z.enum(["LOW", "STANDARD", "HIGH"]).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const joinRequest = await client.joinRequest.findUnique({ where: { id } });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  if (joinRequest.status === "PENDING_CHECKER") {
    throw new ApiError(
      409,
      "JOIN_REQUEST_AWAITING_CHECKER",
      "The join request is awaiting four-eyes review in the approvals queue",
    );
  }
  if (!["IN_REVIEW", "INFO_REQUESTED", "SUBMITTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_DECIDABLE", "The join request is not in a decidable state");
  }
  if (joinRequest.onboardingChannel === "ADMIN_ASSISTED" && joinRequest.submittedByUserId === actor.userId) {
    throw new ApiError(
      403,
      "JOIN_REQUEST_MAKER_CANNOT_DECIDE",
      "The operator who prepared an admin-assisted onboarding cannot decide it",
    );
  }
  if (body.decision === "APPROVED") {
    const readiness = await computeJoinRequestReadiness(client, id);
    if (!readiness.ready) {
      throw new ApiError(
        409,
        "JOIN_REQUEST_NOT_READY",
        "The join request is not ready for approval",
        { blockers: readiness.blockers },
      );
    }
    // A merchant with an open confirmed screening match is never activated.
    const blockingCase = await client.amlCase.findFirst({
      where: {
        subjectType: "MERCHANT",
        subjectId: joinRequest.merchantId,
        status: { in: ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"] },
        triggerReason: { startsWith: "SCREENING_CONFIRMED_MATCH" },
      },
      select: { id: true, triggerReason: true, severity: true },
    });
    if (blockingCase) {
      throw new ApiError(
        409,
        "AML_CONFIRMED_MATCH",
        "The merchant has an open confirmed watch list match and cannot be activated",
        { amlCaseId: blockingCase.id, severity: blockingCase.severity },
      );
    }
  }
  if (joinRequest.fourEyesRequired) {
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "JOIN_REQUEST",
        subjectId: joinRequest.id,
        payloadDiffJson: body as Prisma.InputJsonValue,
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await client.$transaction(async (tx) => {
      await tx.joinRequest.update({
        where: { id },
        data: { status: "PENDING_CHECKER", approvalRequestId: approval.id },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "SYSTEM",
          action: body.decision === "APPROVED"
            ? "JOIN_REQUEST_APPROVAL_PROPOSED"
            : "JOIN_REQUEST_REJECTION_PROPOSED",
          entityType: "JOIN_REQUEST",
          entityId: id,
          beforeJson: { status: joinRequest.status },
          afterJson: { status: "PENDING_CHECKER", decision: body.decision, approvalRequestId: approval.id },
          approvalRequestId: approval.id,
        },
      });
    });
    response.status(202).json({
      status: "PENDING_CHECKER",
      approvalRequestId: approval.id,
      decision: body.decision,
    });
    return;
  }
  if (body.decision === "APPROVED") {
    const platform = getPlatformRuntime(client as never);
    await client.$transaction(async (tx) => {
      await activateApprovedJoinRequest(governanceContext(platform), tx as never, {
        joinRequestId: joinRequest.id,
        checkerUserId: actor.userId,
        checkerRole: actor.role,
        approvalRequestId: joinRequest.approvalRequestId ?? null,
        decisionReasonCode: body.reasonCode ?? null,
        decisionNotes: body.notes ?? null,
        proposedRiskTier: body.proposedRiskTier ?? joinRequest.proposedRiskTier ?? null,
      });
    });
    response.json({ id: joinRequest.id, status: "APPROVED" });
    return;
  }
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.joinRequest.update({
      where: { id },
      data: {
        status: "REJECTED",
        decision: "REJECTED",
        decisionReasonCode: body.reasonCode,
        decisionNotes: body.notes,
      },
    });
    const merchant = await tx.merchant.findUnique({ where: { id: joinRequest.merchantId } });
    if (merchant?.status === "PENDING") {
      await tx.merchant.update({
        where: { id: merchant.id },
        data: {
          status: "REJECTED",
          kybStatus: ["PENDING", "UNVERIFIED"].includes(merchant.kybStatus) ? "REJECTED" : merchant.kybStatus,
          version: merchantVersion(merchant) + 1,
        },
      });
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "JOIN_REQUEST_REJECTED",
        entityType: "JOIN_REQUEST",
        entityId: id,
        beforeJson: { status: joinRequest.status },
        afterJson: { status: "REJECTED", reasonCode: body.reasonCode ?? null },
      },
    });
    return row;
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/kyb-documents", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const built = buildListQuery(request.query, {
    search: [
      "merchant.legalName",
      "merchant.tradeName",
      "merchant.contactEmail",
      "merchant.contactPhone",
      "originalFileName",
      "sha256",
    ],
    contains: {
      requestRef: "joinRequest.id",
      merchantName: ["merchant.legalName", "merchant.tradeName"],
    },
    in: { status: "status", avStatus: "avStatus", docType: "docType", subjectType: "subjectType" },
    equals: {
      merchantId: "merchantId",
      joinRequestId: "joinRequestId",
      reviewedById: "reviewedById",
    },
    dates: {
      createdAt: { path: "createdAt", fromKey: "uploadedFrom", toKey: "uploadedTo" },
      expiresOn: { path: "expiresOn", fromKey: "expiryFrom", toKey: "expiryTo" },
    },
    sortable: {
      createdAt: "createdAt",
      expiresOn: "expiresOn",
      status: "status",
      avStatus: "avStatus",
      docType: "docType",
    },
    defaultSort: { createdAt: "desc" },
  });
  const query = (request.query ?? {}) as Record<string, unknown>;
  const conditions = ((built.where as Record<string, unknown>).AND as Record<string, unknown>[] | undefined) ?? [];
  const and = [...conditions];
  // Draft-request evidence stays out of reviewer queues (design Edge Case 116).
  and.push({ OR: [{ joinRequestId: null }, { joinRequest: { status: { not: "DRAFT" } } }] });
  const requestStatuses = typeof query.requestStatus === "string"
    ? query.requestStatus.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (requestStatuses.length > 0) {
    and.push({ joinRequest: { status: { in: requestStatuses } } });
  }
  if (query.duplicateOnly === "true") {
    const duplicateHashes = (await client.$queryRawUnsafe(
      "SELECT sha256 FROM kyb_documents GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1",
    )) as Array<{ sha256: string }>;
    if (duplicateHashes.length === 0) {
      response.json(listResponse("kybDocuments", [], 0, built));
      return;
    }
    and.push({ sha256: { in: duplicateHashes.map((row) => row.sha256) } });
  }
  if (query.expiringSoon === "true") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    and.push({ expiresOn: { gte: today, lte: thirtyDays } });
    and.push({ status: { in: ["UPLOADED", "ACCEPTED"] } });
  }
  const where = { AND: and };
  const [documents, total] = await Promise.all([
    client.kybDocument.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: kybDocumentContextSelect,
    }),
    client.kybDocument.count({ where: where as never }),
  ]);
  const ids = documents.map((document) => document.id);
  const merchantIds = [...new Set(documents.map((document) => document.merchantId))];
  const hashes = [...new Set(documents.map((document) => document.sha256))];
  const [availability, subjectNames, duplicateRows, openRequests, openRevalidations] = await Promise.all([
    contentAvailabilityForIds(ids),
    subjectOwnerNames(documents),
    hashes.length === 0
      ? Promise.resolve([] as Array<{ id: string; merchantId: string; sha256: string }>)
      : client.kybDocument.findMany({
          where: { sha256: { in: hashes } },
          select: { id: true, merchantId: true, sha256: true },
        }),
    merchantIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; merchantId: string; status: string }>)
      : client.joinRequest.findMany({
          where: { merchantId: { in: merchantIds }, status: { in: [...KYB_OPEN_JOIN_STATUSES] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, merchantId: true, status: true },
        }),
    ids.length === 0
      ? Promise.resolve([] as Array<{ documentId: string | null }>)
      : client.kybRevalidationRequest.findMany({
          where: { documentId: { in: ids }, status: "OPEN" },
          select: { documentId: true },
        }),
  ]);
  const duplicateMerchantMap = new Map<string, Set<string>>();
  for (const row of duplicateRows) {
    const set = duplicateMerchantMap.get(row.sha256) ?? new Set<string>();
    set.add(row.merchantId);
    duplicateMerchantMap.set(row.sha256, set);
  }
  const openRequestByMerchant = new Map<string, { id: string; status: string }>();
  for (const joinRequest of openRequests) {
    if (!openRequestByMerchant.has(joinRequest.merchantId)) {
      openRequestByMerchant.set(joinRequest.merchantId, joinRequest);
    }
  }
  const openRevalidationDocuments = new Set(
    openRevalidations
      .map((row) => row.documentId)
      .filter((value): value is string => Boolean(value)),
  );
  const rows = documents.map((document) => {
    const duplicates = duplicateMerchantMap.get(document.sha256) ?? new Set<string>();
    const duplicateMerchantCount = [...duplicates].filter((id) => id !== document.merchantId).length;
    const openRequest = document.joinRequestId
      ? document.joinRequest
      : openRequestByMerchant.get(document.merchantId) ?? null;
    return {
      ...document,
      merchantName: document.merchant?.tradeName ?? document.merchant?.legalName ?? "",
      merchantLegalName: document.merchant?.legalName ?? "",
      merchantStatus: document.merchant?.status ?? null,
      merchantKybStatus: document.merchant?.kybStatus ?? null,
      reviewer: document.reviewedBy?.email ?? "",
      uploader: document.uploadedBy?.email ?? "",
      subjectName: document.subjectType === "BENEFICIAL_OWNER"
        ? subjectNames.get(document.subjectId) ?? null
        : null,
      contentAvailable: availability.get(document.id) ?? false,
      duplicateMerchantCount,
      duplicateDocumentCount: duplicates.size,
      expiryState: expiryState(document.expiresOn),
      daysUntilExpiry: daysUntilExpiry(document.expiresOn),
      canReview: isKybDocumentActionable(document)
        && (!document.joinRequest || !["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(String(document.joinRequest.status))),
      canRequestReplacement: Boolean(openRequest && KYB_OPEN_JOIN_STATUSES.includes(String(openRequest.status) as never)),
      canRequestRevalidation: Boolean(
        document.merchant?.status === "ACTIVE"
        && document.status !== "UPLOADED"
        && !openRequest
        && !openRevalidationDocuments.has(document.id),
      ),
      openJoinRequest: openRequest ? { id: openRequest.id, status: openRequest.status } : null,
    };
  });
  response.json(listResponse("kybDocuments", rows, total, built));
});

router.get("/kyb-documents/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const built = buildListQuery(request.query, {
    search: [
      "merchant.legalName",
      "merchant.tradeName",
      "merchant.contactEmail",
      "merchant.contactPhone",
      "originalFileName",
      "sha256",
    ],
    contains: {
      requestRef: "joinRequest.id",
      merchantName: ["merchant.legalName", "merchant.tradeName"],
    },
    in: { status: "status", avStatus: "avStatus", docType: "docType", subjectType: "subjectType" },
    equals: {
      merchantId: "merchantId",
      joinRequestId: "joinRequestId",
      reviewedById: "reviewedById",
    },
    dates: {
      createdAt: { path: "createdAt", fromKey: "uploadedFrom", toKey: "uploadedTo" },
      expiresOn: { path: "expiresOn", fromKey: "expiryFrom", toKey: "expiryTo" },
    },
    sortable: {
      createdAt: "createdAt",
      expiresOn: "expiresOn",
      status: "status",
      avStatus: "avStatus",
      docType: "docType",
    },
    defaultSort: { createdAt: "desc" },
  });
  const query = (request.query ?? {}) as Record<string, unknown>;
  const conditions = ((built.where as Record<string, unknown>).AND as Record<string, unknown>[] | undefined) ?? [];
  const and = [...conditions];
  and.push({ OR: [{ joinRequestId: null }, { joinRequest: { status: { not: "DRAFT" } } }] });
  const requestStatuses = typeof query.requestStatus === "string"
    ? query.requestStatus.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (requestStatuses.length > 0) {
    and.push({ joinRequest: { status: { in: requestStatuses } } });
  }
  if (query.duplicateOnly === "true") {
    const duplicateHashes = (await client.$queryRawUnsafe(
      "SELECT sha256 FROM kyb_documents GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1",
    )) as Array<{ sha256: string }>;
    and.push({ sha256: { in: duplicateHashes.map((row) => row.sha256) } });
  }
  if (query.expiringSoon === "true") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    and.push({ expiresOn: { gte: today, lte: thirtyDays } });
    and.push({ status: { in: ["UPLOADED", "ACCEPTED"] } });
  }
  const where = { AND: and };
  const take = 5000;
  const [documents, total] = await Promise.all([
    client.kybDocument.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      take,
      select: {
        id: true,
        merchantId: true,
        joinRequestId: true,
        subjectType: true,
        subjectId: true,
        docType: true,
        originalFileName: true,
        mime: true,
        sizeBytes: true,
        sha256: true,
        avStatus: true,
        status: true,
        expiresOn: true,
        reviewedAt: true,
        rejectionReasonCode: true,
        createdAt: true,
        merchant: { select: { tradeName: true, legalName: true, status: true, kybStatus: true } },
        uploadedBy: { select: { email: true } },
        reviewedBy: { select: { email: true } },
        joinRequest: { select: { id: true, status: true } },
      },
    }),
    client.kybDocument.count({ where: where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "KYB_DOCUMENTS_EXPORTED",
      entityType: "KYB_DOCUMENT",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: documents.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    documents: documents.map((document) => ({
      id: document.id,
      merchantId: document.merchantId,
      merchantName: document.merchant?.tradeName ?? document.merchant?.legalName ?? "",
      merchantLegalName: document.merchant?.legalName ?? "",
      merchantStatus: document.merchant?.status ?? null,
      merchantKybStatus: document.merchant?.kybStatus ?? null,
      joinRequestId: document.joinRequestId,
      joinRequestStatus: document.joinRequest?.status ?? null,
      subjectType: document.subjectType,
      subjectId: document.subjectId,
      docType: document.docType,
      originalFileName: document.originalFileName,
      mime: document.mime,
      sizeBytes: document.sizeBytes,
      sha256: document.sha256,
      avStatus: document.avStatus,
      status: document.status,
      expiresOn: document.expiresOn,
      expiryState: expiryState(document.expiresOn),
      uploadedBy: document.uploadedBy?.email ?? "",
      reviewedBy: document.reviewedBy?.email ?? "",
      reviewedAt: document.reviewedAt,
      rejectionReasonCode: document.rejectionReasonCode,
      createdAt: document.createdAt,
    })),
    total,
    exported: documents.length,
    truncated: total > documents.length,
  });
});

const buildKybDocumentSummary = async () => {
  const now = new Date();
  const inThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const documents = await client.kybDocument.findMany({
    where: { OR: [{ joinRequestId: null }, { joinRequest: { status: { not: "DRAFT" } } }] },
    select: { status: true, avStatus: true, docType: true, expiresOn: true, sha256: true, merchantId: true },
  });
  const duplicateRows = (await client.$queryRawUnsafe(
    "SELECT sha256 FROM kyb_documents GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1",
  )) as Array<{ sha256: string }>;
  const duplicateHashes = new Set(duplicateRows.map((row) => row.sha256));
  const byStatus: Record<string, number> = {};
  const byAvStatus: Record<string, number> = {};
  const byDocType: Record<string, number> = {};
  let expiringSoon = 0;
  let expired = 0;
  let duplicates = 0;
  for (const doc of documents) {
    byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1;
    byAvStatus[doc.avStatus] = (byAvStatus[doc.avStatus] ?? 0) + 1;
    byDocType[doc.docType] = (byDocType[doc.docType] ?? 0) + 1;
    if (duplicateHashes.has(doc.sha256)) duplicates += 1;
    if (doc.expiresOn) {
      if (doc.expiresOn.getTime() < now.getTime()) expired += 1;
      else if (doc.expiresOn.getTime() <= inThirtyDays.getTime()) expiringSoon += 1;
    }
  }
  return {
    summary: {
      total: documents.length,
      pending: byStatus.UPLOADED ?? 0,
      accepted: byStatus.ACCEPTED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      expired,
      infected: byAvStatus.INFECTED ?? 0,
      scanning: byAvStatus.PENDING ?? 0,
      duplicates,
      expiringSoon,
      byStatus,
      byAvStatus,
      byDocType,
    },
  };
};

router.get("/kyb-documents/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  response.json(await buildKybDocumentSummary());
});

router.get("/kyb-documents/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const snapshot = await buildKybDocumentSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "KYB_DOCUMENT_SUMMARY_EXPORTED",
      entityType: "KYB_DOCUMENT",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: snapshot.summary.total,
        pending: snapshot.summary.pending,
        expired: snapshot.summary.expired,
        duplicates: snapshot.summary.duplicates,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.get("/kyb-documents/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const document = await client.kybDocument.findUnique({
    where: { id },
    select: kybDocumentContextSelect,
  });
  if (!document) {
    throw new ApiError(404, "KYB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  const [availability, duplicateMatches, subjectName, readiness, openJoinRequest, openRevalidations, auditTrail] = await Promise.all([
    contentAvailabilityForIds([document.id]),
    duplicateDocumentsForHash(document),
    document.subjectType === "BENEFICIAL_OWNER"
      ? client.beneficialOwner.findUnique({
          where: { id: document.subjectId },
          select: { id: true, fullNameAr: true, fullNameEn: true, screeningStatus: true, active: true },
        })
      : Promise.resolve(null),
    document.joinRequestId
      ? computeJoinRequestReadiness(client, document.joinRequestId)
      : Promise.resolve(null),
    openJoinRequestForDocument(document),
    client.kybRevalidationRequest.findMany({
      where: { documentId: document.id, status: "OPEN" },
      orderBy: { requestedAt: "desc" },
    }),
    client.auditLog.findMany({
      where: { entityType: "KYB_DOCUMENT", entityId: document.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        createdAt: true,
        action: true,
        role: true,
        beforeJson: true,
        afterJson: true,
        approvalRequestId: true,
        actor: { select: { id: true, email: true } },
      },
    }),
  ]);
  const linkedJoinRequest = document.joinRequest;
  response.json({
    kybDocument: {
      ...document,
      contentAvailable: availability.get(document.id) ?? false,
      merchantName: document.merchant?.tradeName ?? document.merchant?.legalName ?? "",
      subjectName: subjectName
        ? subjectName.fullNameEn || subjectName.fullNameAr
        : null,
      subjectOwner: subjectName,
      expiryState: expiryState(document.expiresOn),
      daysUntilExpiry: daysUntilExpiry(document.expiresOn),
      duplicateMatches,
      duplicateMerchantCount: new Set(duplicateMatches.map((match) => match.merchantId)).size,
      duplicateDocumentCount: duplicateMatches.length,
      readiness,
      canReview: isKybDocumentActionable(document)
        && (!linkedJoinRequest || !["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(String(linkedJoinRequest.status))),
      canRequestReplacement: Boolean(
        openJoinRequest && KYB_OPEN_JOIN_STATUSES.includes(String(openJoinRequest.status) as never),
      ),
      canRequestRevalidation: Boolean(
        document.merchant?.status === "ACTIVE"
        && document.status !== "UPLOADED"
        && !openJoinRequest
        && openRevalidations.length === 0,
      ),
      openJoinRequest: openJoinRequest ? { id: openJoinRequest.id, status: openJoinRequest.status } : null,
      openRevalidations,
      auditTrail,
      reviewReasonCodes: KYB_DOCUMENT_REJECTION_REASONS,
    },
  });
});

router.post("/kyb-documents/:id/review", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        decision: z.enum(["ACCEPTED", "REJECTED"]),
        reasonCode: z.string().max(64).optional(),
        notes: z.string().max(2000).optional(),
        duplicateJustification: z.string().max(4000).optional(),
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const document = await client.kybDocument.findUnique({
    where: { id },
    select: kybDocumentContextSelect,
  });
  if (!document) {
    throw new ApiError(404, "KYB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  if (document.avStatus !== "CLEAN") {
    throw new ApiError(409, "KYB_DOCUMENT_NOT_SCANNED", "The KYB document has not passed malware scanning");
  }
  if (!isKybDocumentActionable(document)) {
    throw new ApiError(409, "KYB_DOCUMENT_NOT_ACTIONABLE", "Only an uploaded, clean and unexpired document can be reviewed");
  }
  const linkedJoinRequest = document.joinRequestId
    ? await client.joinRequest.findUnique({ where: { id: document.joinRequestId } })
    : null;
  if (linkedJoinRequest && ["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(linkedJoinRequest.status)) {
    throw new ApiError(409, "KYB_DOCUMENT_REVIEW_LOCKED", "The related join request is already closed");
  }
  if (body.decision === "REJECTED") {
    if (!body.reasonCode || !KYB_DOCUMENT_REJECTION_REASONS.includes(body.reasonCode as never)) {
      throw new ApiError(400, "KYB_REJECTION_REASON_REQUIRED", "A valid document rejection reason is required");
    }
  }
  const expiresOn = body.expiresOn
    ? new Date(`${body.expiresOn}T00:00:00.000Z`)
    : document.expiresOn;
  if (body.decision === "ACCEPTED" && expiryState(expiresOn) === "EXPIRED") {
    throw new ApiError(409, "KYB_DOCUMENT_EXPIRED", "An expired document cannot be accepted; request a replacement");
  }
  const duplicateMerchantIds = await distinctDuplicateMerchantIds(client, document.sha256, document.merchantId);
  if (duplicateJustificationRequired({
    decision: body.decision,
    duplicateMerchantCount: duplicateMerchantIds.length,
    justification: body.duplicateJustification,
  })) {
    throw new ApiError(
      422,
      "KYB_DUPLICATE_JUSTIFICATION_REQUIRED",
      "Accepting a document reused by another merchant requires a written justification",
      { duplicateMerchantIds },
    );
  }
  const now = new Date();
  const updated = await client.$transaction(async (tx) => {
    if (linkedJoinRequest?.status === "PENDING_CHECKER") {
      await invalidatePendingJoinApproval(tx, linkedJoinRequest, "SUPERSEDED_BY_KYB_DOCUMENT_REVIEW");
    }
    const saved = await tx.kybDocument.update({
      where: { id },
      data: {
        status: body.decision,
        reviewedById: actor.userId,
        reviewedAt: now,
        statusChangedAt: now,
        rejectionReasonCode: body.decision === "REJECTED" ? body.reasonCode : null,
        reviewNotes: body.notes,
        duplicateJustification: body.duplicateJustification,
        expiresOn,
        ...(body.decision === "ACCEPTED" ? { expiredAt: null } : {}),
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: body.decision === "ACCEPTED" ? "KYB_DOCUMENT_ACCEPTED" : "KYB_DOCUMENT_REJECTED",
        entityType: "KYB_DOCUMENT",
        entityId: document.id,
        beforeJson: {
          status: document.status,
          avStatus: document.avStatus,
          expiresOn: document.expiresOn?.toISOString() ?? null,
        },
        afterJson: {
          status: saved.status,
          reasonCode: body.reasonCode ?? null,
          expiresOn: saved.expiresOn?.toISOString() ?? null,
          duplicateMerchantIds,
        },
      },
    });
    return saved;
  });
  const kybStatus = await recomputeMerchantKybStatus(client, document.merchantId);
  const amlCaseId = body.decision === "ACCEPTED"
    ? await maybeRaiseDuplicateAmlCase({
        document: {
          id: document.id,
          merchantId: document.merchantId,
          sha256: document.sha256,
          docType: document.docType,
        },
        duplicateMerchantIds,
        actorUserId: actor.userId,
        actorRole: actor.role ?? "SYSTEM",
      })
    : null;
  response.json({
    id: updated.id,
    status: updated.status,
    expiresOn: updated.expiresOn,
    kybStatus,
    duplicateMerchantCount: duplicateMerchantIds.length,
    amlCaseId,
  });
});

router.post("/kyb-documents/:id/request-replacement", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        reasonCode: z.string().max(64).optional(),
        message: z.string().min(5).max(2000),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const document = await client.kybDocument.findUnique({ where: { id } });
  if (!document) {
    throw new ApiError(404, "KYB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  const joinRequest = await openJoinRequestForDocument(document);
  if (!joinRequest) {
    throw new ApiError(
      409,
      "KYB_REVALIDATION_REQUIRED",
      "The document has no open join request; use the active-merchant revalidation action",
    );
  }
  const reasonCode = body.reasonCode ?? "REPLACEMENT_REQUESTED";
  if (!KYB_DOCUMENT_REJECTION_REASONS.includes(reasonCode as never)) {
    throw new ApiError(400, "KYB_REJECTION_REASON_REQUIRED", "A valid replacement reason is required");
  }
  const now = new Date();
  await client.$transaction(async (tx) => {
    await invalidatePendingJoinApproval(tx, joinRequest, "SUPERSEDED_BY_KYB_REPLACEMENT_REQUEST");
    await tx.kybDocument.update({
      where: { id },
      data: {
        status: "REJECTED",
        reviewedById: actor.userId,
        reviewedAt: now,
        statusChangedAt: now,
        rejectionReasonCode: reasonCode,
        reviewNotes: body.message,
      },
    });
    const remainingSeconds = joinRequest.slaRemainingSeconds
      ?? secondsBetween(now, joinRequest.slaDueAt);
    const infoRequestJson = mergeInfoRequestItems(joinRequest.infoRequestJson, [
      { field: String(document.docType), message: body.message },
    ]);
    await tx.joinRequest.update({
      where: { id: joinRequest.id },
      data: {
        status: "INFO_REQUESTED",
        infoRequestJson,
        slaPausedAt: joinRequest.slaPausedAt ?? now,
        slaRemainingSeconds: remainingSeconds,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "KYB_DOCUMENT_REPLACEMENT_REQUESTED",
        entityType: "KYB_DOCUMENT",
        entityId: document.id,
        beforeJson: { status: document.status, joinRequestStatus: joinRequest.status },
        afterJson: {
          status: "REJECTED",
          joinRequestStatus: "INFO_REQUESTED",
          reasonCode,
          docType: document.docType,
        },
      },
    });
  });
  await queueKybNotification(client, {
    merchantId: document.merchantId,
    code: "KYB_DOCUMENT_REPLACEMENT_REQUESTED",
    payload: { documentType: document.docType, message: body.message },
    eventKey: `replacement:${document.id}:${now.toISOString()}`,
  });
  await recomputeMerchantKybStatus(client, document.merchantId);
  response.json({ id: document.id, status: "REJECTED", joinRequestStatus: "INFO_REQUESTED" });
});

router.post("/kyb-documents/:id/request-revalidation", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        reasonCode: z.string().max(64).optional(),
        message: z.string().min(5).max(2000),
        dueAt: z.string().datetime().optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const document = await client.kybDocument.findUnique({
    where: { id },
    include: { merchant: true },
  });
  if (!document) {
    throw new ApiError(404, "KYB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  if (document.merchant.status === "CLOSED") {
    throw new ApiError(409, "KYB_REVALIDATION_NOT_AVAILABLE", "A closed merchant cannot be asked for documents");
  }
  if (document.status === "UPLOADED") {
    throw new ApiError(409, "KYB_DOCUMENT_PENDING_REVIEW", "Review or decide the uploaded document before requesting re-verification");
  }
  const openRequest = await openJoinRequestForDocument(document);
  if (openRequest) {
    throw new ApiError(
      409,
      "KYB_REPLACEMENT_REQUIRED",
      "The document belongs to an open join request; request a replacement instead",
    );
  }
  const existing = await client.kybRevalidationRequest.findFirst({
    where: { documentId: document.id, status: "OPEN" },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, "KYB_REVALIDATION_ALREADY_OPEN", "A revalidation request is already open for this document", {
      revalidationRequestId: existing.id,
    });
  }
  const policy = await readKybRefreshPolicy(client);
  const now = new Date();
  const dueAt = body.dueAt
    ? new Date(body.dueAt)
    : new Date(now.getTime() + policy.revalidationDueDays * 24 * 60 * 60 * 1000);
  const revalidation = await client.$transaction(async (tx) => {
    const created = await tx.kybRevalidationRequest.create({
      data: {
        merchantId: document.merchantId,
        documentId: document.id,
        docType: document.docType,
        reasonCode: body.reasonCode ?? "PERIODIC_REVIEW",
        message: body.message,
        status: "OPEN",
        requestedById: actor.userId,
        requestedAt: now,
        dueAt,
      },
    });
    await tx.merchant.update({
      where: { id: document.merchantId },
      data: { kybStatus: "PENDING" },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "KYB_REVALIDATION_REQUESTED",
        entityType: "KYB_REVALIDATION_REQUEST",
        entityId: created.id,
        beforeJson: {},
        afterJson: {
          merchantId: document.merchantId,
          documentId: document.id,
          docType: document.docType,
          dueAt: dueAt.toISOString(),
        },
      },
    });
    return created;
  });
  await queueKybNotification(client, {
    merchantId: document.merchantId,
    code: "KYB_REVALIDATION_DUE",
    payload: { documentType: document.docType, dueAt: dueAt.toISOString(), message: body.message },
    eventKey: `revalidation:${revalidation.id}`,
  });
  response.status(201).json({ id: revalidation.id, status: revalidation.status, dueAt: revalidation.dueAt });
});

const MERCHANT_OPEN_JOIN_STATUSES = ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"] as const;
const MERCHANT_OPEN_AML_STATUSES = ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"] as const;

const merchantListSelect = {
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  legalName: true,
  tradeName: true,
  displayName: true,
  logoUrl: true,
  supportEmail: true,
  supportPhone: true,
  country: true,
  status: true,
  onboardingChannel: true,
  contactEmail: true,
  contactPhone: true,
  activatedAt: true,
  suspendedAt: true,
  closedAt: true,
  nextKybReviewAt: true,
  taxId: true,
  registrationNo: true,
  businessCategory: true,
  riskTier: true,
  kybStatus: true,
  payoutBankDetailsJson: true,
  commissionReceivableCeiling: true,
  negativeBalanceCeiling: true,
  suspensionReasonCode: true,
  suspensionNotes: true,
  closedReasonCode: true,
  closedNotes: true,
  _count: {
    select: {
      wallets: true,
      applications: true,
      users: true,
      accessTokens: true,
      joinRequests: true,
      kybDocuments: true,
    },
  },
  joinRequests: {
    select: { id: true, status: true, submittedAt: true, proposedRiskTier: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} as const;

const merchantOperationalFlags = (principal: { role: string | null; authorities: string[] }) => {
  const support = principal.role === "SUPPORT";
  return {
    support,
    canSensitive: !support && hasSensitiveMerchantAccess(principal.authorities),
    canAml: !support && hasMerchantAmlAccess(principal.authorities),
    canFinancial: !support && hasMerchantFinancialAccess(principal.authorities),
  };
};

const merchantStatusReasonVisible = (
  reasonCode: string | null | undefined,
  flags: ReturnType<typeof merchantOperationalFlags>,
): boolean => Boolean(reasonCode) && flags.canSensitive && (flags.canAml || reasonCode !== "AML");

const serializeMerchantSummary = (
  merchant: Record<string, any>,
  flags: ReturnType<typeof merchantOperationalFlags>,
  pendingApprovalCount = 0,
) => {
  const latestJoinRequest = merchant.joinRequests?.[0] ?? null;
  return {
    id: merchant.id,
    version: merchant.version,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
    legalName: merchant.legalName,
    tradeName: merchant.tradeName,
    displayName: merchant.displayName ?? merchant.tradeName,
    logoUrl: merchant.logoUrl,
    supportEmail: merchant.supportEmail,
    supportPhone: merchant.supportPhone,
    country: merchant.country,
    status: merchant.status,
    onboardingChannel: merchant.onboardingChannel,
    contactEmail: merchant.contactEmail,
    contactPhone: merchant.contactPhone,
    activatedAt: merchant.activatedAt,
    suspendedAt: merchant.suspendedAt,
    closedAt: merchant.closedAt,
    suspensionReasonCode: merchantStatusReasonVisible(merchant.suspensionReasonCode, flags)
      ? merchant.suspensionReasonCode
      : null,
    suspensionReasonRedacted: Boolean(merchant.suspensionReasonCode) && !merchantStatusReasonVisible(merchant.suspensionReasonCode, flags),
    closedReasonCode: flags.canSensitive ? merchant.closedReasonCode : null,
    ...(flags.canSensitive
      ? {
          taxId: merchant.taxId,
          registrationNo: merchant.registrationNo,
          businessCategory: merchant.businessCategory,
          riskTier: merchant.riskTier,
          kybStatus: merchant.kybStatus,
          nextKybReviewAt: merchant.nextKybReviewAt,
          suspensionNotes: merchant.suspensionNotes,
          closedNotes: merchant.closedNotes,
        }
      : {}),
    ...(flags.canFinancial
      ? {
          payoutBankDetailsJson: merchant.payoutBankDetailsJson,
          commissionReceivableCeiling: merchant.commissionReceivableCeiling,
          negativeBalanceCeiling: merchant.negativeBalanceCeiling,
        }
      : {}),
    walletCount: merchant._count?.wallets ?? merchant.wallets?.length ?? 0,
    applicationCount: merchant._count?.applications ?? merchant.applications?.length ?? 0,
    userCount: merchant._count?.users ?? merchant.users?.length ?? 0,
    tokenCount: merchant._count?.accessTokens ?? merchant.accessTokens?.length ?? 0,
    joinRequestCount: merchant._count?.joinRequests ?? merchant.joinRequests?.length ?? 0,
    kybDocumentCount: merchant._count?.kybDocuments ?? merchant.kybDocuments?.length ?? 0,
    latestJoinRequest,
    pendingApprovalCount,
    redactedFields: [
      ...(flags.canSensitive ? [] : ["taxId", "registrationNo", "businessCategory", "riskTier", "kybStatus", "nextKybReviewAt", "suspensionNotes", "closedReasonCode", "closedNotes"]),
      ...(flags.canFinancial ? [] : ["payoutBankDetailsJson", "commissionReceivableCeiling", "negativeBalanceCeiling"]),
      ...(merchant.suspensionReasonCode && !merchantStatusReasonVisible(merchant.suspensionReasonCode, flags) ? ["suspensionReasonCode"] : []),
    ],
  };
};

const stringifyChangeValue = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const merchantSensitiveHistoryFields = new Set([
  "legalName",
  "taxId",
  "registrationNo",
  "businessCategory",
  "riskTier",
  "kybStatus",
  "payoutBankDetailsJson",
  "commissionReceivableCeiling",
  "negativeBalanceCeiling",
  "contactEmail",
  "contactPhone",
  "suspensionReasonCode",
  "suspensionNotes",
  "closedReasonCode",
  "closedNotes",
]);

const redactDetailChange = (
  entry: Record<string, any>,
  flags: ReturnType<typeof merchantOperationalFlags>,
): Record<string, unknown> => {
  const field = String(entry.fieldName ?? "").replace(/^\//, "").split("/")[0] ?? "";
  const sensitive = merchantSensitiveHistoryFields.has(field);
  const amlReason = field === "suspensionReasonCode" && String(entry.newValue ?? "") === "AML";
  const redact = (!flags.canSensitive && sensitive) || (amlReason && !flags.canAml);
  return {
    ...entry,
    actorEmail: entry.actor?.email ?? null,
    oldValue: redact ? "[REDACTED]" : entry.oldValue,
    newValue: redact ? "[REDACTED]" : entry.newValue,
    redacted: redact,
  };
};

const maskBankAccount = (value: unknown): string => {
  const text = String(value ?? "");
  if (text.length <= 4) return text ? "****" : "";
  return `****${text.slice(-4)}`;
};

const merchantStatsSince = (period: unknown): Date => {
  const normalized = String(period ?? "30d").toLowerCase();
  const days = normalized === "24h" ? 1 : normalized === "7d" ? 7 : normalized === "90d" ? 90 : 30;
  return new Date(Date.now() - days * 86_400_000);
};

const merchantPeriodLabel = (period: unknown): string => {
  const normalized = String(period ?? "30d").toLowerCase();
  return ["24h", "7d", "30d", "90d"].includes(normalized) ? normalized : "30d";
};

const merchantApprovalKind = (payload: unknown): string => {
  if (Array.isArray(payload)) return "EDIT";
  if (payload && typeof payload === "object") {
    const kind = (payload as Record<string, unknown>).kind;
    if (typeof kind === "string") return kind.toUpperCase();
  }
  return "EDIT";
};

const merchantApprovalCheckerAllowed = (
  role: string | null,
  payload: unknown,
): boolean => {
  const kind = merchantApprovalKind(payload);
  if (["SUSPEND", "SUSPEND_EMERGENCY", "REINSTATE", "CLOSE"].includes(kind)) {
    return role === "COMPLIANCE" || role === "MLRO";
  }
  if (kind === "EDIT" && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const patch = (payload as Record<string, unknown>).patch;
    if (Array.isArray(patch)) {
      const fields = patch
        .map((entry) => (entry && typeof entry === "object" ? String((entry as Record<string, unknown>).path ?? "") : ""))
        .map((path) => path.replace(/^\//, "").split("/")[0] ?? "");
      const financial = fields.some((field) => ["commissionReceivableCeiling", "negativeBalanceCeiling"].includes(field));
      const compliance = fields.some((field) =>
        ["legalName", "taxId", "registrationNo", "businessCategory", "payoutBankDetailsJson", "riskTier", "kybStatus", "contactEmail", "contactPhone"].includes(field),
      );
      if (financial && !compliance) return role === "FINANCE" || role === "COMPLIANCE" || role === "MLRO";
      if (compliance) return role === "COMPLIANCE" || role === "MLRO";
    }
  }
  return role !== "SUPPORT";
};

const approvalCheckBlockReason = async (
  approval: {
    id: string;
    subjectType: string;
    subjectId: string;
    state: string;
    makerUserId: string;
    payloadDiffJson: unknown;
  },
  actor: { userId: string; role: string | null },
): Promise<string | null> => {
  if (!["PENDING_REVIEW", "DRAFT"].includes(approval.state)) return "APPROVAL_NOT_PENDING";
  if (approval.makerUserId === actor.userId) return "MAKER_CANNOT_CHECK";
  const subjectType = normalizeApprovalSubjectType(approval.subjectType);
  if (subjectType === "JOIN_REQUEST") {
    const joinRequest = await client.joinRequest.findUnique({ where: { id: approval.subjectId } });
    if (joinRequest?.onboardingChannel === "ADMIN_ASSISTED" && joinRequest.submittedByUserId === actor.userId) {
      return "ADMIN_ASSISTED_MAKER_CANNOT_CHECK";
    }
  }
  if (subjectType === "MERCHANT" && !merchantApprovalCheckerAllowed(actor.role, approval.payloadDiffJson)) {
    return "MERCHANT_CHECKER_DOMAIN_FORBIDDEN";
  }
  return null;
};

const approvalSubjectContext = async (subjectType: string, subjectId: string): Promise<Record<string, unknown> | null> => {
  switch (normalizeApprovalSubjectType(subjectType)) {
    case "MERCHANT": {
      const row = await client.merchant.findUnique({
        where: { id: subjectId },
        select: { id: true, legalName: true, tradeName: true, displayName: true, status: true, kybStatus: true, riskTier: true },
      });
      return row ? { contextType: "MERCHANT", ...row } : null;
    }
    case "JOIN_REQUEST": {
      const row = await client.joinRequest.findUnique({
        where: { id: subjectId },
        select: {
          id: true,
          status: true,
          onboardingChannel: true,
          proposedRiskTier: true,
          submittedAt: true,
          slaDueAt: true,
          decision: true,
          merchant: { select: { id: true, tradeName: true, legalName: true } },
        },
      });
      return row ? { contextType: "JOIN_REQUEST", ...row } : null;
    }
    case "ADJUSTMENT": {
      const row = await client.adjustment.findUnique({
        where: { id: subjectId },
        select: {
          id: true,
          type: true,
          amount: true,
          state: true,
          reason: true,
          sourceAttemptId: true,
          disputeId: true,
          targetGlAccount: { select: { currency: true, accountType: true, ownerId: true } },
        },
      });
      return row ? { kind: "ADJUSTMENT", ...row, amount: merchantMoney(row.amount) } : null;
    }
    case "OPERATOR_CASE": {
      const row = await client.operatorCase.findUnique({
        where: { id: subjectId },
        select: {
          id: true,
          kind: true,
          priority: true,
          state: true,
          slaDueAt: true,
          attemptId: true,
          attempt: { select: { reference: true, status: true } },
        },
      });
      return row ? { contextType: "OPERATOR_CASE", ...row } : null;
    }
    case "AML_CASE": {
      const row = await client.amlCase.findUnique({
        where: { id: subjectId },
        select: { id: true, status: true, severity: true, triggerReason: true, slaDueAt: true, subjectType: true, subjectId: true },
      });
      return row ? { contextType: "AML_CASE", ...row } : null;
    }
    case "GATEWAY_VERSION": {
      const row = await client.gatewayVersion.findUnique({
        where: { id: subjectId },
        select: {
          id: true,
          versionNumber: true,
          state: true,
          gatewayId: true,
          gateway: { select: { code: true, name: true } },
        },
      });
      return row ? { contextType: "GATEWAY_VERSION", ...row } : null;
    }
    case "COMMISSION_PROFILE": {
      const row = await client.commissionProfile.findUnique({
        where: { id: subjectId },
        select: {
          id: true,
          railCode: true,
          calcType: true,
          flatFee: true,
          percentageRate: true,
          feeBearerDefault: true,
          effectiveFrom: true,
          effectiveTo: true,
          merchantId: true,
          applicationId: true,
          version: true,
        },
      });
      return row ? { contextType: "COMMISSION_PROFILE", ...row } : null;
    }
    case "VELOCITY_RULE": {
      const row = await client.velocityRule.findUnique({
        where: { id: subjectId },
        select: {
          id: true,
          scopeType: true,
          scopeValue: true,
          windowSeconds: true,
          maxCount: true,
          maxAmount: true,
          action: true,
          active: true,
          effectiveFrom: true,
          effectiveTo: true,
          version: true,
        },
      });
      return row ? { contextType: "VELOCITY_RULE", ...row } : null;
    }
    case "USER": {
      const row = await client.user.findUnique({
        where: { id: subjectId },
        select: { id: true, email: true, role: true, status: true, isMaker: true, isChecker: true },
      });
      return row ? { contextType: "USER", ...row } : null;
    }
    case "PLATFORM_SETTING": {
      const row = await client.platformSetting.findUnique({
        where: { id: subjectId },
        select: { id: true, key: true, scope: true, version: true, effectiveFrom: true },
      });
      return row ? { contextType: "PLATFORM_SETTING", ...row } : null;
    }
    case "REGULATORY_REPORT": {
      const row = await client.regulatoryReport.findUnique({
        where: { id: subjectId },
        select: { id: true, reportType: true, status: true, authority: true, periodStart: true, periodEnd: true },
      });
      return row ? { contextType: "REGULATORY_REPORT", ...row } : null;
    }
    case "REPORTING_RULE": {
      const row = await client.reportingRule.findUnique({
        where: { id: subjectId },
        select: { id: true, code: true, name: true, status: true, reportType: true },
      });
      return row ? { contextType: "REPORTING_RULE", ...row } : null;
    }
    case "AML_RULE": {
      const row = await client.amlRule.findUnique({
        where: { id: subjectId },
        select: { id: true, code: true, name: true, ruleType: true, action: true, active: true },
      });
      return row ? { contextType: "AML_RULE", ...row } : null;
    }
    default:
      return null;
  }
};

router.get("/merchants", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const principal = principalOf(request);
  const flags = merchantOperationalFlags(principal);
  const built = buildListQuery(request.query, {
    search: flags.canSensitive
      ? ["legalName", "tradeName", "contactEmail", "contactPhone", "taxId", "registrationNo"]
      : ["legalName", "tradeName", "contactEmail", "contactPhone"],
    contains: {
      merchantName: ["displayName", "tradeName"],
      businessName: "legalName",
    },
    in: { status: "status", kybStatus: "kybStatus", riskTier: "riskTier", onboardingChannel: "onboardingChannel" },
    equals: { country: "country" },
    dates: {
      createdAt: { path: "createdAt" },
      activatedAt: { path: "activatedAt", fromKey: "activatedFrom", toKey: "activatedTo" },
      nextKybReviewAt: { path: "nextKybReviewAt", fromKey: "reviewFrom", toKey: "reviewTo" },
    },
    sortable: {
      legalName: "legalName",
      tradeName: "tradeName",
      status: "status",
      riskTier: "riskTier",
      kybStatus: "kybStatus",
      createdAt: "createdAt",
      activatedAt: "activatedAt",
      nextKybReviewAt: "nextKybReviewAt",
    },
    defaultSort: { createdAt: "desc" },
  });
  const query = (request.query ?? {}) as Record<string, unknown>;
  const and = [...(((built.where as Record<string, unknown>).AND as Record<string, unknown>[] | undefined) ?? [])];
  const requestRef = typeof query.requestRef === "string" ? query.requestRef.trim() : "";
  if (requestRef) {
    and.push({ joinRequests: { some: { id: { contains: requestRef } } } });
  }
  if (query.hasOpenJoinRequest === "true") {
    and.push({ joinRequests: { some: { status: { in: [...MERCHANT_OPEN_JOIN_STATUSES] } } } });
  }
  if (query.hasOpenAmlCase === "true") {
    if (!flags.canAml) {
      response.json(listResponse("merchants", [], 0, built));
      return;
    }
    const cases = await client.amlCase.findMany({
      where: { subjectType: "MERCHANT", status: { in: [...MERCHANT_OPEN_AML_STATUSES] } },
      select: { subjectId: true },
      distinct: ["subjectId"],
    });
    if (cases.length === 0) {
      response.json(listResponse("merchants", [], 0, built));
      return;
    }
    and.push({ id: { in: cases.map((row) => row.subjectId) } });
  }
  const where = { AND: and };
  const { merchants, total } = await readThroughReplicaOrPrimary(
    client as never,
    request.header("x-pg-min-lsn") ?? undefined,
    async (reader) => {
      const [rows, count] = await Promise.all([
        reader.merchant.findMany({
          where: where as never,
          orderBy: built.orderBy as never,
          skip: built.skip,
          take: built.take,
          select: merchantListSelect,
        }),
        reader.merchant.count({ where: where as never }),
      ]);
      return { merchants: rows, total: count };
    },
  );
  const ids = merchants.map((merchant) => merchant.id);
  const pendingApprovals = ids.length === 0
    ? []
    : await client.approvalRequest.findMany({
        where: { subjectType: "MERCHANT", subjectId: { in: ids }, state: "PENDING_REVIEW" },
        select: { subjectId: true },
      });
  const pendingCount = new Map<string, number>();
  for (const approval of pendingApprovals) {
    pendingCount.set(approval.subjectId, (pendingCount.get(approval.subjectId) ?? 0) + 1);
  }
  response.json(listResponse(
    "merchants",
    merchants.map((merchant) => serializeMerchantSummary(merchant as never, flags, pendingCount.get(merchant.id) ?? 0)),
    total,
    built,
  ));
});

router.get("/merchants/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const principal = principalOf(request);
  const flags = merchantOperationalFlags(principal);
  const built = buildListQuery(request.query, {
    search: flags.canSensitive
      ? ["legalName", "tradeName", "contactEmail", "contactPhone", "taxId", "registrationNo"]
      : ["legalName", "tradeName", "contactEmail", "contactPhone"],
    contains: {
      merchantName: ["displayName", "tradeName"],
      businessName: "legalName",
    },
    in: { status: "status", kybStatus: "kybStatus", riskTier: "riskTier", onboardingChannel: "onboardingChannel" },
    equals: { country: "country" },
    dates: {
      createdAt: { path: "createdAt" },
      activatedAt: { path: "activatedAt", fromKey: "activatedFrom", toKey: "activatedTo" },
      nextKybReviewAt: { path: "nextKybReviewAt", fromKey: "reviewFrom", toKey: "reviewTo" },
    },
    sortable: {
      legalName: "legalName",
      tradeName: "tradeName",
      status: "status",
      riskTier: "riskTier",
      kybStatus: "kybStatus",
      createdAt: "createdAt",
      activatedAt: "activatedAt",
      nextKybReviewAt: "nextKybReviewAt",
    },
    defaultSort: { createdAt: "desc" },
  });
  const query = (request.query ?? {}) as Record<string, unknown>;
  const and = [...(((built.where as Record<string, unknown>).AND as Record<string, unknown>[] | undefined) ?? [])];
  const requestRef = typeof query.requestRef === "string" ? query.requestRef.trim() : "";
  if (requestRef) and.push({ joinRequests: { some: { id: { contains: requestRef } } } });
  if (query.hasOpenJoinRequest === "true") {
    and.push({ joinRequests: { some: { status: { in: [...MERCHANT_OPEN_JOIN_STATUSES] } } } });
  }
  if (query.hasOpenAmlCase === "true") {
    if (!flags.canAml) {
      and.push({ id: { in: [] } });
    } else {
      const cases = await client.amlCase.findMany({
        where: { subjectType: "MERCHANT", status: { in: [...MERCHANT_OPEN_AML_STATUSES] } },
        select: { subjectId: true },
        distinct: ["subjectId"],
      });
      and.push({ id: { in: cases.map((row) => row.subjectId) } });
    }
  }
  const where = { AND: and };
  const take = 5000;
  const [merchants, total] = await Promise.all([
    client.merchant.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      take,
      select: merchantListSelect,
    }),
    client.merchant.count({ where: where as never }),
  ]);
  const ids = merchants.map((merchant) => merchant.id);
  const pendingApprovals = ids.length === 0
    ? []
    : await client.approvalRequest.findMany({
        where: { subjectType: "MERCHANT", subjectId: { in: ids }, state: "PENDING_REVIEW" },
        select: { subjectId: true },
      });
  const pendingCount = new Map<string, number>();
  for (const approval of pendingApprovals) {
    pendingCount.set(approval.subjectId, (pendingCount.get(approval.subjectId) ?? 0) + 1);
  }
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "MERCHANTS_EXPORTED",
      entityType: "MERCHANT",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: merchants.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    merchants: merchants.map((merchant) => serializeMerchantSummary(merchant as never, flags, pendingCount.get(merchant.id) ?? 0)),
    total,
    exported: merchants.length,
    truncated: total > merchants.length,
  });
});

const buildMerchantSummary = async () => {
  const now = new Date();
  const merchants = await client.merchant.findMany({
    select: {
      status: true,
      kybStatus: true,
      riskTier: true,
      onboardingChannel: true,
      nextKybReviewAt: true,
    },
  });
  const pendingApprovals = await client.approvalRequest.findMany({
    where: { subjectType: "MERCHANT", state: { in: ["DRAFT", "PENDING_REVIEW"] } },
    select: { subjectId: true },
    distinct: ["subjectId"],
  });
  const byStatus: Record<string, number> = {};
  const byKyb: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  let reviewOverdue = 0;
  let reviewDueSoon = 0;
  for (const merchant of merchants) {
    byStatus[merchant.status] = (byStatus[merchant.status] ?? 0) + 1;
    byKyb[merchant.kybStatus] = (byKyb[merchant.kybStatus] ?? 0) + 1;
    byRisk[merchant.riskTier] = (byRisk[merchant.riskTier] ?? 0) + 1;
    byChannel[merchant.onboardingChannel] = (byChannel[merchant.onboardingChannel] ?? 0) + 1;
    if (merchant.nextKybReviewAt) {
      if (merchant.nextKybReviewAt.getTime() < now.getTime()) reviewOverdue += 1;
      else if (merchant.nextKybReviewAt.getTime() - now.getTime() <= 30 * 24 * 60 * 60 * 1000) reviewDueSoon += 1;
    }
  }
  return {
    summary: {
      total: merchants.length,
      active: byStatus.ACTIVE ?? 0,
      pending: byStatus.PENDING ?? 0,
      suspended: byStatus.SUSPENDED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      closed: byStatus.CLOSED ?? 0,
      kybPending: byKyb.PENDING ?? 0,
      kybVerified: byKyb.VERIFIED ?? 0,
      highRisk: byRisk.HIGH ?? 0,
      reviewOverdue,
      reviewDueSoon,
      pendingApprovals: pendingApprovals.length,
      byStatus,
      byKyb,
      byRisk,
      byChannel,
    },
  };
};

router.get("/merchants/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  response.json(await buildMerchantSummary());
});

router.get("/merchants/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const snapshot = await buildMerchantSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "MERCHANT_SUMMARY_EXPORTED",
      entityType: "MERCHANT",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: snapshot.summary.total,
        active: snapshot.summary.active,
        pending: snapshot.summary.pending,
        highRisk: snapshot.summary.highRisk,
        reviewOverdue: snapshot.summary.reviewOverdue,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.get("/merchants/:id/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const principal = principalOf(request);
  const flags = merchantOperationalFlags(principal);
  const merchant = await client.merchant.findUnique({
    where: { id },
    select: merchantListSelect,
  });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const [pendingApprovalCount, metrics, balance, openDisputes, pendingCashouts, openAmlCases] = await Promise.all([
    client.approvalRequest.count({ where: { subjectType: "MERCHANT", subjectId: id, state: { in: ["DRAFT", "PENDING_REVIEW"] } } }),
    flags.canFinancial
      ? client.paymentAttempt.groupBy({
          by: ["status"],
          where: { merchantId: id, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
          _count: { _all: true },
          _sum: { totalChargedAmount: true },
        })
      : Promise.resolve([]),
    flags.canFinancial ? merchantWalletBalance(client, id) : Promise.resolve(null),
    flags.canFinancial
      ? client.dispute.count({ where: { attempt: { merchantId: id }, status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] } } })
      : Promise.resolve(0),
    flags.canFinancial
      ? client.cashoutRequest.count({ where: { merchantId: id, state: { in: ["PENDING", "PROCESSING"] } } })
      : Promise.resolve(0),
    flags.canAml
      ? client.amlCase.count({ where: { subjectType: "MERCHANT", subjectId: id, status: { in: [...AML_OPEN_STATUSES] as never } } })
      : Promise.resolve(0),
  ]);
  const summary = serializeMerchantSummary(merchant as never, flags, pendingApprovalCount);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "MERCHANT_360_SUMMARY_EXPORTED",
      entityType: "MERCHANT",
      entityId: id,
      beforeJson: {},
      afterJson: {
        status: summary.status,
        pendingApprovalCount,
        openDisputes,
        pendingCashouts,
        openAmlCases,
      },
    },
  });
  response.json({
    merchant: summary,
    walletBalance: balance,
    metrics: metrics.map((row) => ({
      status: row.status,
      count: row._count._all,
      chargedAmount: row._sum.totalChargedAmount ?? "0.0000",
    })),
    openDisputes,
    pendingCashouts,
    openAmlCases,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/merchants/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const principal = principalOf(request);
  const flags = merchantOperationalFlags(principal);
  const merchant = await client.merchant.findUnique({
    where: { id },
    select: {
      ...merchantListSelect,
      joinRequests: {
        select: {
          id: true,
          status: true,
          onboardingChannel: true,
          proposedRiskTier: true,
          submittedAt: true,
          slaDueAt: true,
          slaPausedAt: true,
          createdAt: true,
          decision: true,
          decisionReasonCode: true,
          fourEyesRequired: true,
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      wallets: { select: { id: true, currency: true, status: true, createdAt: true } },
      applications: {
        select: {
          id: true,
          name: true,
          status: true,
          expectedMonthlyVolume: true,
          assignedWalletId: true,
          createdAt: true,
        },
      },
      users: {
        select: { id: true, email: true, phone: true, role: true, status: true, isMaker: true, isChecker: true, mfaRequired: true, createdAt: true },
      },
      accessTokens: {
        select: { id: true, applicationId: true, name: true, lastFour: true, scopes: true, ipWhitelistEnabled: true, revokedAt: true, lastUsedAt: true, createdAt: true },
      },
      credentialSets: {
        select: { id: true, gatewayId: true, env: true, ownerType: true, settlementTarget: true, status: true, lastVerifiedAt: true, expiresAt: true },
      },
      kybDocuments: {
        select: { id: true, docType: true, status: true, avStatus: true, originalFileName: true, expiresOn: true, reviewedAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 30,
      },
    },
  });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  const [pendingApprovals, recentChanges, owners, revalidations, amlCases, balance, metrics, openDisputes, pendingCashouts] = await Promise.all([
    flags.canSensitive
      ? client.approvalRequest.findMany({
          where: { subjectType: "MERCHANT", subjectId: id, state: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED"] } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            state: true,
            mode: true,
            baseVersion: true,
            makerUserId: true,
            makerReason: true,
            payloadDiffJson: true,
            createdAt: true,
            expiresAt: true,
            maker: { select: { email: true } },
          },
        })
      : Promise.resolve([]),
    client.detailChangeLog.findMany({
      where: { merchantId: id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { actor: { select: { email: true } } },
    }),
    flags.canSensitive
      ? client.beneficialOwner.findMany({
          where: { merchantId: id },
          orderBy: [{ active: "desc" }, { createdAt: "asc" }],
          select: { id: true, fullNameAr: true, fullNameEn: true, nationality: true, ownershipPercent: true, role: true, pepDeclared: true, screeningStatus: true, active: true },
        })
      : Promise.resolve([]),
    flags.canSensitive
      ? client.kybRevalidationRequest.findMany({
          where: { merchantId: id, status: { in: ["OPEN", "EXPIRED"] } },
          orderBy: { requestedAt: "desc" },
        })
      : Promise.resolve([]),
    flags.canAml
      ? client.amlCase.findMany({
          where: { subjectType: "MERCHANT", subjectId: id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, triggerReason: true, severity: true, status: true, slaDueAt: true, createdAt: true, confidential: true },
        })
      : Promise.resolve([]),
    flags.canFinancial ? merchantWalletBalance(client, id) : Promise.resolve(null),
    flags.canFinancial
      ? client.paymentAttempt.groupBy({
          by: ["status"],
          where: { merchantId: id, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
          _count: { _all: true },
          _sum: { totalChargedAmount: true },
        })
      : Promise.resolve([]),
    flags.canFinancial
      ? client.dispute.count({
          where: {
            attempt: { merchantId: id },
            status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] },
          },
        })
      : Promise.resolve(0),
    flags.canFinancial
      ? client.cashoutRequest.count({ where: { merchantId: id, state: { in: ["PENDING", "PROCESSING"] } } })
      : Promise.resolve(0),
  ]);
  const summary = serializeMerchantSummary(merchant as never, flags, pendingApprovals.length);
  response.json({
    merchant: {
      ...summary,
      ...(flags.canSensitive
        ? {
            joinRequests: merchant.joinRequests,
            kybDocuments: merchant.kybDocuments,
            beneficialOwners: owners,
            revalidations,
            amlCases,
            pendingChanges: pendingApprovals,
          }
        : {}),
      ...(flags.canSensitive || flags.canFinancial
        ? {
            wallets: merchant.wallets,
            applications: merchant.applications,
          }
        : {}),
      ...(flags.canSensitive
        ? {
            users: merchant.users,
            accessTokens: merchant.accessTokens,
            credentialSets: merchant.credentialSets,
          }
        : {}),
      fieldHistory: recentChanges.map((entry) => redactDetailChange(entry, flags)),
      ...(balance ? { walletBalance: balance } : {}),
      ...(flags.canFinancial
        ? {
            metrics: metrics.map((row) => ({
              status: row.status,
              count: row._count._all,
              chargedAmount: row._sum.totalChargedAmount ?? "0.0000",
            })),
            openDisputes,
            pendingCashouts,
          }
        : {}),
    },
  });
});

const merchantScopedWhere = (merchantId: string, builtWhere: Record<string, unknown>): Record<string, unknown> => {
  const conditions = Array.isArray(builtWhere.AND) ? builtWhere.AND : [];
  return { AND: [{ merchantId }, ...conditions] };
};

const merchantMoney = (value: unknown): string => {
  if (value === null || value === undefined) return "0.0000";
  try {
    return decimal(value as never).toFixed(4);
  } catch {
    return String(value);
  }
};

const merchantMaskedJson = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (/account|iban|number|phone|email/i.test(key)) {
      result[key] = maskBankAccount(entry);
    } else if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      result[key] = entry;
    }
  }
  return result;
};

const merchantSuccessStatuses = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] as const;

router.get("/merchants/:id/transactions", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  const built = buildListQuery(request.query, {
    search: flags.support ? ["reference"] : ["reference", "providerReference", "networkReference", "gatewayReference"],
    in: { status: "status", env: "env", applicationId: "applicationId", railId: "railId" },
    dates: {
      createdAt: { path: "createdAt" },
      terminalAt: { path: "terminalAt", fromKey: "terminalFrom", toKey: "terminalTo" },
    },
    ranges: { amount: { path: "totalChargedAmount", kind: "decimal" } },
    sortable: { reference: "reference", status: "status", createdAt: "createdAt", terminalAt: "terminalAt", totalChargedAmount: "totalChargedAmount" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const where = merchantScopedWhere(id, built.where);
  const [attempts, total] = await Promise.all([
    client.paymentAttempt.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        reference: true,
        createdAt: true,
        updatedAt: true,
        terminalAt: true,
        status: true,
        substatus: true,
        env: true,
        mode: true,
        subMode: true,
        currency: true,
        requestedAmount: true,
        surchargeAmount: true,
        totalChargedAmount: true,
        settledAmount: true,
        gatewayFeeAmount: true,
        platformCommissionAmount: true,
        netMerchantAmount: true,
        providerReference: true,
        networkReference: true,
        gatewayReference: true,
        application: { select: { id: true, name: true } },
        rail: { select: { id: true, code: true, nameEn: true } },
        route: { select: { id: true, gateway: { select: { id: true, code: true, name: true } } } },
        gatewayVersion: { select: { setting: { select: { supportsStatusCheck: true } } } },
        link: { select: { id: true, key: true } },
        ledgerEntry: { select: { id: true } },
        operatorCases: { select: { id: true, kind: true, state: true, priority: true, slaDueAt: true }, orderBy: { createdAt: "desc" }, take: 3 },
      },
    }),
    client.paymentAttempt.count({ where: where as never }),
  ]);
  response.json({
    ...listResponse(
      "transactions",
      attempts.map((attempt) => {
        const redacted = flags.support;
        const inquiry = operatorCaseInquiryEligibility({
          caseState: null,
          attemptStatus: attempt.status,
          terminalAt: attempt.terminalAt,
          supportsStatusCheck: attempt.gatewayVersion?.setting?.supportsStatusCheck === true,
        });
        return {
          id: attempt.id,
          reference: attempt.reference,
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt,
          terminalAt: attempt.terminalAt,
          status: attempt.status,
          substatus: attempt.substatus,
          env: attempt.env,
          mode: attempt.mode,
          subMode: attempt.subMode,
          currency: attempt.currency,
          application: attempt.application,
          rail: attempt.rail,
          gateway: attempt.route.gateway,
          link: redacted ? null : attempt.link,
          ledgerEntryId: redacted ? null : attempt.ledgerEntry?.id ?? null,
          providerReference: redacted ? null : attempt.providerReference,
          networkReference: redacted ? null : attempt.networkReference,
          gatewayReference: redacted ? null : attempt.gatewayReference,
          requestedAmount: redacted ? null : merchantMoney(attempt.requestedAmount),
          surchargeAmount: redacted ? null : merchantMoney(attempt.surchargeAmount),
          totalChargedAmount: redacted ? null : merchantMoney(attempt.totalChargedAmount),
          settledAmount: redacted || !flags.canFinancial ? null : merchantMoney(attempt.settledAmount),
          gatewayFeeAmount: redacted || !flags.canFinancial ? null : merchantMoney(attempt.gatewayFeeAmount),
          platformCommissionAmount: redacted || !flags.canFinancial ? null : merchantMoney(attempt.platformCommissionAmount),
          netMerchantAmount: redacted || !flags.canFinancial ? null : merchantMoney(attempt.netMerchantAmount),
          operatorCases: attempt.operatorCases,
          inquiryEligible: inquiry.eligible,
          inquiryEligibilityReason: inquiry.reason,
          redactedFields: redacted
            ? ["amounts", "fees", "net", "providerReference", "networkReference", "gatewayReference", "link", "ledgerEntryId"]
            : flags.canFinancial
              ? []
              : ["settledAmount", "gatewayFeeAmount", "platformCommissionAmount", "netMerchantAmount"],
        };
      }),
      total,
      built,
    ),
    redactedFields: flags.support ? ["financialFields", "providerReferences"] : [],
  });
});

router.get("/merchants/:id/applications", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  const built = buildListQuery(request.query, {
    search: ["name", "id"],
    in: { status: "status" },
    equals: { walletId: "assignedWalletId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "name", status: "status", createdAt: "createdAt", expectedMonthlyVolume: "expectedMonthlyVolume" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const where = merchantScopedWhere(id, built.where);
  const [applications, total] = await Promise.all([
    client.application.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        name: true,
        status: true,
        expectedMonthlyVolume: true,
        railWhitelist: true,
        redirectDomainAllowlist: true,
        createdAt: true,
        assignedWallet: { select: { id: true, currency: true, status: true } },
        _count: { select: { accessTokens: true, paymentLinks: true, posTerminals: true } },
      },
    }),
    client.application.count({ where: where as never }),
  ]);
  response.json(listResponse(
    "applications",
    applications.map((application) => {
      const railWhitelist = Array.isArray(application.railWhitelist) ? application.railWhitelist : null;
      const redirectDomains = Array.isArray(application.redirectDomainAllowlist) ? application.redirectDomainAllowlist : [];
      return {
        id: application.id,
        name: application.name,
        status: application.status,
        expectedMonthlyVolume: flags.support ? null : merchantMoney(application.expectedMonthlyVolume),
        assignedWallet: application.assignedWallet,
        accessTokenCount: application._count.accessTokens,
        paymentLinkCount: application._count.paymentLinks,
        posTerminalCount: application._count.posTerminals,
        railWhitelistMode: railWhitelist === null ? "ALL" : railWhitelist.length === 0 ? "NONE" : "LIST",
        railWhitelistCount: railWhitelist?.length ?? 0,
        railWhitelist,
        redirectDomainCount: redirectDomains.length,
        redirectDomains: flags.canSensitive ? redirectDomains : [],
        createdAt: application.createdAt,
        redactedFields: flags.support ? ["expectedMonthlyVolume"] : [],
      };
    }),
    total,
    built,
  ));
});

router.get("/merchants/:id/wallets", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  const built = buildListQuery(request.query, {
    search: ["id", "glAccountId"],
    in: { status: "status", currency: "currency" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { currency: "currency", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "asc" },
    defaultPageSize: 10,
  });
  const where = merchantScopedWhere(id, built.where);
  const [wallets, total, balances] = await Promise.all([
    client.wallet.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        currency: true,
        status: true,
        glAccountId: true,
        createdAt: true,
        _count: { select: { applications: true, paymentLinks: true, cashoutRequests: true } },
      },
    }),
    client.wallet.count({ where: where as never }),
    flags.canFinancial ? merchantWalletBalance(client, id) : Promise.resolve(null),
  ]);
  const checkpointSummaries = flags.canFinancial && wallets.length > 0
    ? await loadAccountCheckpointSummary(client as never, wallets.map((wallet) => wallet.glAccountId))
    : [];
  const checkpointByAccount = new Map(checkpointSummaries.map((row) => [row.id, row.checkpointBalance]));
  const balanceMap = new Map((balances?.wallets ?? []).map((wallet) => [wallet.id, wallet.balance]));
  const pendingByWallet = new Map<string, number>();
  if (flags.canFinancial && wallets.length > 0) {
    const pending = await client.cashoutRequest.groupBy({
      by: ["walletId"],
      where: { walletId: { in: wallets.map((wallet) => wallet.id) }, state: { in: ["PENDING", "PROCESSING"] } },
      _count: { _all: true },
    });
    for (const row of pending) pendingByWallet.set(row.walletId, row._count._all);
  }
  response.json(listResponse(
    "wallets",
    wallets.map((wallet) => ({
      id: wallet.id,
      currency: wallet.currency,
      status: wallet.status,
      glAccountId: wallet.glAccountId,
      balance: flags.canFinancial ? balanceMap.get(wallet.id) ?? "0.0000" : null,
      // Natural sign like `balance`; the stored (debit-positive) shard checkpoints are summed per wallet account.
      checkpointBalance: flags.canFinancial ? merchantMoney(naturalShardBalance("MERCHANT_WALLET", checkpointByAccount.get(wallet.glAccountId) ?? "0")) : null,
      applicationCount: wallet._count.applications,
      paymentLinkCount: wallet._count.paymentLinks,
      cashoutCount: wallet._count.cashoutRequests,
      pendingCashoutCount: pendingByWallet.get(wallet.id) ?? 0,
      createdAt: wallet.createdAt,
      redactedFields: flags.canFinancial ? [] : ["balance", "checkpointBalance"],
    })),
    total,
    built,
  ));
});

router.get("/merchants/:id/cashouts", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  if (!flags.canFinancial) throw new ApiError(403, "MERCHANT_FINANCIAL_ACCESS_REQUIRED", "Financial access is required to view cash-outs");
  const built = buildListQuery(request.query, {
    search: ["id", "adjustmentId"],
    in: { state: "state", walletId: "walletId" },
    dates: { createdAt: { path: "createdAt" } },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    sortable: { amount: "amount", state: "state", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const where = merchantScopedWhere(id, built.where);
  const [cashouts, total] = await Promise.all([
    client.cashoutRequest.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        amount: true,
        state: true,
        destinationBankJson: true,
        adjustmentId: true,
        createdAt: true,
        wallet: { select: { id: true, currency: true, status: true } },
        adjustment: { select: { id: true, state: true, journalEntryId: true } },
      },
    }),
    client.cashoutRequest.count({ where: where as never }),
  ]);
  response.json(listResponse(
    "cashouts",
    cashouts.map((cashout) => ({
      id: cashout.id,
      amount: merchantMoney(cashout.amount),
      currency: cashout.wallet.currency,
      state: cashout.state,
      wallet: cashout.wallet,
      destination: merchantMaskedJson(cashout.destinationBankJson),
      adjustmentId: cashout.adjustmentId,
      adjustment: cashout.adjustment,
      createdAt: cashout.createdAt,
    })),
    total,
    built,
  ));
});

router.get("/merchants/:id/disputes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  if (!flags.canFinancial) throw new ApiError(403, "MERCHANT_FINANCIAL_ACCESS_REQUIRED", "Financial access is required to view disputes");
  const built = buildListQuery(request.query, {
    search: ["id", "externalDisputeRef", "attempt.reference"],
    in: { status: "status", railId: "railId" },
    dates: {
      openedAt: { path: "openedAt", fromKey: "openedFrom", toKey: "openedTo" },
      evidenceDueAt: { path: "evidenceDueAt", fromKey: "dueFrom", toKey: "dueTo" },
    },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    sortable: { amount: "amount", status: "status", openedAt: "openedAt", evidenceDueAt: "evidenceDueAt" },
    defaultSort: { openedAt: "desc" },
    defaultPageSize: 10,
  });
  const conditions = Array.isArray(built.where.AND) ? built.where.AND : [];
  const where = { AND: [{ attempt: { merchantId: id } }, ...conditions] };
  const [disputes, total] = await Promise.all([
    client.dispute.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        externalDisputeRef: true,
        source: true,
        reasonCode: true,
        amount: true,
        currency: true,
        status: true,
        openedAt: true,
        evidenceDueAt: true,
        outcomeAt: true,
        adjustmentId: true,
        attempt: { select: { id: true, reference: true, status: true } },
        gateway: { select: { id: true, code: true, name: true } },
        rail: { select: { id: true, code: true, nameEn: true } },
        adjustment: { select: { id: true, state: true, journalEntryId: true } },
      },
    }),
    client.dispute.count({ where: where as never }),
  ]);
  response.json(listResponse(
    "disputes",
    disputes.map((dispute) => ({
      ...dispute,
      amount: merchantMoney(dispute.amount),
    })),
    total,
    built,
  ));
});

router.get("/merchants/:id/adjustments", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  if (!flags.canFinancial) throw new ApiError(403, "MERCHANT_FINANCIAL_ACCESS_REQUIRED", "Financial access is required to view adjustments");
  const built = buildListQuery(request.query, {
    search: ["id", "reason", "externalDisputeRef", "providerRefundRef", "sourceAttempt.reference"],
    in: { type: "type", state: "state" },
    dates: { createdAt: { path: "createdAt" } },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    sortable: { amount: "amount", type: "type", state: "state", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const conditions = Array.isArray(built.where.AND) ? built.where.AND : [];
  const where = {
    AND: [
      { OR: [{ sourceAttempt: { merchantId: id } }, { targetGlAccount: { ownerId: id } }] },
      ...conditions,
    ],
  };
  const [adjustments, total] = await Promise.all([
    client.adjustment.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        type: true,
        amount: true,
        reverseCommission: true,
        reason: true,
        externalDisputeRef: true,
        providerRefundRef: true,
        state: true,
        journalEntryId: true,
        createdAt: true,
        targetGlAccount: { select: { id: true, accountType: true, currency: true, ownerId: true } },
        sourceAttempt: { select: { id: true, reference: true, status: true, currency: true } },
        dispute: { select: { id: true, externalDisputeRef: true, status: true } },
      },
    }),
    client.adjustment.count({ where: where as never }),
  ]);
  response.json(listResponse(
    "adjustments",
    adjustments.map((adjustment) => ({
      ...adjustment,
      amount: merchantMoney(adjustment.amount),
      currency: adjustment.sourceAttempt?.currency ?? adjustment.targetGlAccount.currency,
    })),
    total,
    built,
  ));
});

router.get("/merchants/:id/notifications", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const built = buildListQuery(request.query, {
    search: ["templateCode", "addressMasked"],
    in: { status: "status", channel: "channel", lang: "lang", templateCode: "templateCode" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { templateCode: "templateCode", status: "status", channel: "channel", attempts: "attempts", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const notificationWhere = { AND: [{ recipientMerchantId: id }, ...(Array.isArray(built.where.AND) ? built.where.AND : [])] };
  const [notifications, total] = await Promise.all([
    client.notification.findMany({
      where: notificationWhere as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        templateCode: true,
        channel: true,
        lang: true,
        status: true,
        attempts: true,
        addressMasked: true,
        nextAttemptAt: true,
        createdAt: true,
      },
    }),
    client.notification.count({ where: notificationWhere as never }),
  ]);
  response.json(listResponse("notifications", notifications, total, built));
});

router.get("/merchants/:id/audit-events", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  const built = buildListQuery(request.query, {
    search: ["action", "role", "actor.email"],
    in: { action: "action", role: "role" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { action: "action", role: "role", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const conditions = Array.isArray(built.where.AND) ? built.where.AND : [];
  const where = { AND: [{ entityType: "MERCHANT", entityId: id }, ...conditions] };
  const [events, total] = await Promise.all([
    client.auditLog.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        action: true,
        role: true,
        entityType: true,
        entityId: true,
        beforeJson: true,
        afterJson: true,
        approvalRequestId: true,
        createdAt: true,
        actor: { select: { email: true } },
      },
    }),
    client.auditLog.count({ where: where as never }),
  ]);
  response.json(listResponse(
    "auditEvents",
    events.map((event) => ({
      id: event.id,
      action: event.action,
      role: event.role,
      entityType: event.entityType,
      entityId: event.entityId,
      actorEmail: event.actor.email,
      approvalRequestId: event.approvalRequestId,
      before: flags.canSensitive ? event.beforeJson : null,
      after: flags.canSensitive ? event.afterJson : null,
      createdAt: event.createdAt,
      redacted: !flags.canSensitive,
    })),
    total,
    built,
  ));
});

router.get("/merchants/:id/stats", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({
    where: { id },
    select: { id: true, nextKybReviewAt: true, negativeBalanceCeiling: true },
  });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const flags = merchantOperationalFlags(principalOf(request));
  if (!flags.canFinancial) throw new ApiError(403, "MERCHANT_FINANCIAL_ACCESS_REQUIRED", "Financial access is required to view merchant statistics");
  const period = merchantPeriodLabel(request.query.period);
  const since = merchantStatsSince(period);
  const statusRows = await client.paymentAttempt.groupBy({
    by: ["status"],
    where: { merchantId: id, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { totalChargedAmount: true, netMerchantAmount: true, platformCommissionAmount: true },
  });
  const success = new Set<string>(merchantSuccessStatuses);
  let attemptCount = 0;
  let successfulCount = 0;
  let grossVolume = decimal(0);
  let netCredited = decimal(0);
  let commission = decimal(0);
  let failedCount = 0;
  let expiredCount = 0;
  let blockedCount = 0;
  let unknownCount = 0;
  for (const row of statusRows) {
    const count = row._count._all;
    attemptCount += count;
    if (success.has(row.status)) {
      successfulCount += count;
      grossVolume = grossVolume.plus(decimal(row._sum.totalChargedAmount ?? 0));
      netCredited = netCredited.plus(decimal(row._sum.netMerchantAmount ?? 0));
      commission = commission.plus(decimal(row._sum.platformCommissionAmount ?? 0));
    }
    if (row.status === "FAILED") failedCount += count;
    if (row.status === "EXPIRED") expiredCount += count;
    if (row.status === "BLOCKED") blockedCount += count;
    if (row.status === "UNKNOWN") unknownCount += count;
  }
  const [balance, pendingCashouts, openDisputes, pendingApprovals] = await Promise.all([
    merchantWalletBalance(client, id),
    client.cashoutRequest.aggregate({
      where: { merchantId: id, state: { in: ["PENDING", "PROCESSING"] } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    client.dispute.count({
      where: { attempt: { merchantId: id }, status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] } },
    }),
    client.approvalRequest.count({ where: { subjectType: "MERCHANT", subjectId: id, state: "PENDING_REVIEW" } }),
  ]);
  response.json({
    period,
    since,
    totals: {
      attemptCount,
      successfulCount,
      successRate: attemptCount === 0 ? 0 : Number(((successfulCount / attemptCount) * 100).toFixed(2)),
      grossVolume: grossVolume.toFixed(4),
      netCredited: netCredited.toFixed(4),
      commission: commission.toFixed(4),
      averageTicket: successfulCount === 0 ? "0.0000" : grossVolume.dividedBy(successfulCount).toFixed(4),
      failedCount,
      expiredCount,
      blockedCount,
      unknownCount,
    },
    statuses: statusRows.map((row) => ({
      status: row.status,
      count: row._count._all,
      chargedAmount: merchantMoney(row._sum.totalChargedAmount),
    })),
    walletBalance: balance,
    negativeBalanceCeiling: merchantMoney(merchant.negativeBalanceCeiling),
    pendingCashouts: { count: pendingCashouts._count._all, amount: merchantMoney(pendingCashouts._sum.amount) },
    openDisputes,
    pendingApprovals,
    nextKybReviewAt: merchant.nextKybReviewAt,
  });
});

router.patch("/merchants/:id/descriptive", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      tradeName: z.string().min(2).max(200).optional(),
      displayName: z.string().max(200).optional(),
      logoUrl: z.string().url().max(500).optional(),
      supportEmail: z.string().email().max(160).optional(),
      supportPhone: z.string().min(6).max(40).optional(),
      baseVersion: z.number().int().min(1).optional(),
      reason: z.string().max(2000).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  assertMerchantVersion(merchant, body.baseVersion);
  const fields = MERCHANT_DESCRIPTIVE_FIELDS.filter((field) => body[field] !== undefined);
  if (fields.length === 0) throw new ApiError(400, "MERCHANT_EDIT_EMPTY", "At least one descriptive field is required");
  const updated = await client.$transaction(async (tx) => {
    const data: Record<string, unknown> = { version: merchantVersion(merchant) + 1 };
    for (const field of fields) data[field] = body[field];
    const row = await tx.merchant.update({ where: { id }, data });
    for (const field of fields) {
      await tx.detailChangeLog.create({
        data: {
          actorId: actor.userId,
          merchantId: id,
          entityType: "MERCHANT",
          entityId: id,
          fieldName: `/${field}`,
          oldValue: stringifyChangeValue((merchant as Record<string, unknown>)[field]),
          newValue: stringifyChangeValue(body[field]),
          source: "ADMIN",
          requestId: request.headers["x-request-id"]?.toString() ?? randomBytes(8).toString("hex"),
          clientIp: request.ip,
        },
      });
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "SYSTEM",
        action: "MERCHANT_DESCRIPTIVE_UPDATED",
        entityType: "MERCHANT",
        entityId: id,
        beforeJson: Object.fromEntries(fields.map((field) => [field, (merchant as Record<string, unknown>)[field] ?? null])),
        afterJson: Object.fromEntries(fields.map((field) => [field, body[field] ?? null])),
      },
    });
    return row;
  });
  response.json({ merchant: serializeMerchantSummary(updated as never, merchantOperationalFlags(principalOf(request))) });
});

router.post("/merchants/:id/propose-edit", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reason: z.string().min(3).max(2000),
      baseVersion: z.number().int().min(1).optional(),
      patch: z.array(z.record(z.string().max(64), z.unknown())).min(1).max(200),
      checklist: z.array(z.enum([
        "PATCH_REVIEWED",
        "SOURCE_DOCUMENT_VERIFIED",
        "MAKER_REASON_DOCUMENTED",
        "CHECKER_SCOPE_CONFIRMED",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const baseVersion = body.baseVersion ?? merchantVersion(merchant);
  assertMerchantVersion(merchant, baseVersion);
  const operations = merchantPatchOperations(body.patch);
  assertMerchantPatchFields(operations, MERCHANT_SENSITIVE_FIELD_SET);
  // GAP-017: a payout-account change is only ever a maker-checker approval, and a
  // whole-account replacement must carry the data the KYB payout hash is derived from.
  for (const operation of operations) {
    if (operation.path === "/payoutBankDetailsJson" && operation.op !== "remove" && !payoutAccountHash(operation.value)) {
      throw new ApiError(422, "PAYOUT_ACCOUNT_HASH_REQUIRED", "The payout account must include a bank and an account number or IBAN");
    }
    if (operation.path === "/payoutBankDetailsJson" && operation.op === "remove") {
      throw new ApiError(422, "PAYOUT_ACCOUNT_HASH_REQUIRED", "The payout account cannot be removed");
    }
  }
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "MERCHANT",
      subjectId: merchant.id,
      payloadDiffJson: {
        kind: "EDIT",
        patch: body.patch,
        reason: body.reason,
        baseVersion,
        checklist: body.checklist ?? [],
      } as Prisma.InputJsonValue,
      makerReason: body.reason,
      mode: "STANDARD",
      baseVersion,
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id, baseVersion });
});

router.post("/merchants/:id/suspend", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reasonCode: z.enum(MERCHANT_SUSPENSION_REASON_CODES),
      notes: z.string().max(2000).optional(),
      emergency: z.boolean().optional(),
      ratifyWithinHours: z.number().int().min(1).max(168).optional(),
      baseVersion: z.number().int().min(1).optional(),
      checklist: z.array(z.enum([
        "IMPACT_REVIEWED",
        "REASON_DOCUMENTED",
        "NOTIFICATION_PLANNED",
        "WALLET_DISPUTE_CHECKED",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  assertMerchantSuspendable(merchant.status);
  const baseVersion = body.baseVersion ?? merchantVersion(merchant);
  assertMerchantVersion(merchant, baseVersion);
  if (body.emergency) {
    const now = new Date();
    const ratifyDueAt = new Date(now.getTime() + (body.ratifyWithinHours ?? 24) * 3_600_000);
    const result = await client.$transaction(async (tx) => {
      const updated = await tx.merchant.update({
        where: { id },
        data: {
          status: "SUSPENDED",
          suspendedAt: now,
          suspensionReasonCode: body.reasonCode,
          suspensionNotes: body.notes,
          version: merchantVersion(merchant) + 1,
        },
      });
      const approval = await tx.approvalRequest.create({
        data: {
          subjectType: "MERCHANT",
          subjectId: id,
          payloadDiffJson: {
            kind: "SUSPEND_EMERGENCY",
            reasonCode: body.reasonCode,
            notes: body.notes ?? null,
            baseVersion,
            checklist: body.checklist ?? [],
          } as Prisma.InputJsonValue,
          makerReason: body.notes ?? `Emergency suspension: ${body.reasonCode}`,
          mode: "EMERGENCY_RATIFICATION",
          baseVersion,
          makerUserId: actor.userId,
          state: "PENDING_REVIEW",
          ratifyDueAt,
          expiresAt: ratifyDueAt,
        },
      });
      for (const [field, oldValue] of [
        ["status", merchant.status],
        ["suspendedAt", merchant.suspendedAt],
        ["suspensionReasonCode", merchant.suspensionReasonCode],
        ["suspensionNotes", merchant.suspensionNotes],
      ] as const) {
        await tx.detailChangeLog.create({
          data: {
            actorId: actor.userId,
            merchantId: id,
            entityType: "MERCHANT",
            entityId: id,
            fieldName: `/${field}`,
            oldValue: stringifyChangeValue(oldValue),
            newValue: stringifyChangeValue((updated as Record<string, unknown>)[field]),
            approvalRequestId: approval.id,
            source: "ADMIN",
            requestId: request.headers["x-request-id"]?.toString() ?? randomBytes(8).toString("hex"),
            clientIp: request.ip,
          },
        });
      }
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "SYSTEM",
          action: "MERCHANT_EMERGENCY_SUSPENDED",
          entityType: "MERCHANT",
          entityId: id,
          beforeJson: { status: merchant.status },
          afterJson: { status: "SUSPENDED", reasonCode: body.reasonCode, approvalRequestId: approval.id, checklist: body.checklist ?? [] },
          approvalRequestId: approval.id,
        },
      });
      return { approval, updated };
    });
    await queueMerchantLifecycleNotification(client, {
      merchantId: id,
      code: "MERCHANT_SUSPENDED",
      payload: { merchantId: id, reasonCode: body.reasonCode },
      eventKey: `approval:${result.approval.id}`,
    });
    response.status(202).json({
      status: "SUSPENDED",
      merchantStatus: "SUSPENDED",
      approvalRequestId: result.approval.id,
      emergency: true,
      ratifyDueAt,
    });
    return;
  }
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "MERCHANT",
      subjectId: id,
      payloadDiffJson: {
        kind: "SUSPEND",
        reasonCode: body.reasonCode,
        notes: body.notes ?? null,
        baseVersion: body.baseVersion ?? merchantVersion(merchant),
        checklist: body.checklist ?? [],
      } as Prisma.InputJsonValue,
      makerReason: body.notes ?? `Suspend merchant: ${body.reasonCode}`,
      mode: "STANDARD",
      baseVersion: body.baseVersion ?? merchantVersion(merchant),
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
});

router.post("/merchants/:id/reinstate", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reason: z.string().min(3).max(2000),
      baseVersion: z.number().int().min(1).optional(),
      checklist: z.array(z.enum([
        "COMPLIANCE_CLEARANCE_VERIFIED",
        "OUTSTANDING_ITEMS_RESOLVED",
        "WALLET_DISPUTE_CHECKED",
        "REASON_DOCUMENTED",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  assertMerchantReinstatable(merchant.status);
  const baseVersion = body.baseVersion ?? merchantVersion(merchant);
  assertMerchantVersion(merchant, baseVersion);
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "MERCHANT",
      subjectId: id,
      payloadDiffJson: {
        kind: "REINSTATE",
        reasonCode: "REINSTATEMENT",
        notes: body.reason,
        baseVersion,
        checklist: body.checklist ?? [],
      } as Prisma.InputJsonValue,
      makerReason: body.reason,
      mode: "STANDARD",
      baseVersion,
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
});

router.post("/merchants/:id/close", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reasonCode: z.enum(MERCHANT_CLOSE_REASON_CODES),
      notes: z.string().max(2000).optional(),
      baseVersion: z.number().int().min(1).optional(),
      checklist: z.array(z.enum([
        "BALANCE_ZERO_VERIFIED",
        "OPEN_DISPUTES_CLEARED",
        "CASHOUTS_CLEARED",
        "IRREVERSIBLE_ACKNOWLEDGED",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  assertMerchantClosable(merchant.status);
  const baseVersion = body.baseVersion ?? merchantVersion(merchant);
  assertMerchantVersion(merchant, baseVersion);
  const [balance, openDisputes, openCashouts] = await Promise.all([
    merchantWalletBalance(client, id),
    client.dispute.count({
      where: { attempt: { merchantId: id }, status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] } },
    }),
    client.cashoutRequest.count({ where: { merchantId: id, state: { in: ["PENDING", "PROCESSING"] } } }),
  ]);
  if (!decimal(balance.balance).isZero()) {
    throw new ApiError(409, "MERCHANT_BALANCE_NOT_ZERO", "The merchant wallet balance must be zero before closing", {
      balance: balance.balance,
    });
  }
  if (openDisputes > 0) {
    throw new ApiError(409, "MERCHANT_OPEN_DISPUTES", "The merchant has open disputes", { openDisputes });
  }
  if (openCashouts > 0) {
    throw new ApiError(409, "MERCHANT_OPEN_CASHOUTS", "The merchant has open cash-out requests", { openCashouts });
  }
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "MERCHANT",
      subjectId: id,
      payloadDiffJson: {
        kind: "CLOSE",
        reasonCode: body.reasonCode,
        notes: body.notes ?? null,
        baseVersion,
        checklist: body.checklist ?? [],
      } as Prisma.InputJsonValue,
      makerReason: body.notes ?? `Close merchant: ${body.reasonCode}`,
      mode: "STANDARD",
      baseVersion,
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
});

router.get("/merchants/:id/pending-changes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const principal = principalOf(request);
  const flags = merchantOperationalFlags(principal);
  const changes = await client.approvalRequest.findMany({
    where: { subjectType: "MERCHANT", subjectId: id, state: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED"] } },
    orderBy: { createdAt: "desc" },
    include: { maker: { select: { email: true } }, checker: { select: { email: true } } },
  });
  response.json({
    pendingChanges: changes.map((approval) => ({
      id: approval.id,
      state: approval.state,
      mode: approval.mode,
      baseVersion: approval.baseVersion,
      makerReason: flags.canSensitive ? approval.makerReason : null,
      maker: approval.maker.email,
      checker: approval.checker?.email ?? null,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      payload: flags.canSensitive ? approval.payloadDiffJson : null,
    })),
  });
});

router.post("/merchants/:id/pending-changes/:approvalId/withdraw", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const params = parseOrThrow(
    z.object({ id: z.string().min(1).max(64), approvalId: z.string().min(1).max(64) }).strict(),
    request.params,
  );
  const body = parseOrThrow(z.object({ reason: z.string().min(3).max(2000).optional() }).strict(), request.body ?? {});
  const actor = actorFromRequest(request);
  const approval = await client.approvalRequest.findFirst({
    where: { id: params.approvalId, subjectType: "MERCHANT", subjectId: params.id, state: { in: ["DRAFT", "PENDING_REVIEW"] } },
  });
  if (!approval) throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The pending merchant change does not exist");
  if (approval.makerUserId !== actor.userId) {
    throw new ApiError(403, "APPROVAL_WITHDRAW_FORBIDDEN", "Only the maker can withdraw this change");
  }
  const updated = await client.approvalRequest.update({
    where: { id: approval.id },
    data: { state: "REJECTED", rejectionReason: body.reason ? `WITHDRAWN_BY_MAKER: ${body.reason}` : "WITHDRAWN_BY_MAKER" },
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "SYSTEM",
      action: "MERCHANT_CHANGE_WITHDRAWN",
      entityType: "MERCHANT",
      entityId: params.id,
      beforeJson: { approvalRequestId: approval.id, state: approval.state },
      afterJson: { approvalRequestId: approval.id, state: "REJECTED", reason: body.reason ?? null },
      approvalRequestId: approval.id,
    },
  });
  response.json({ id: updated.id, state: updated.state });
});

router.get("/merchants/:id/detail-changes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const principal = principalOf(request);
  const flags = merchantOperationalFlags(principal);
  const built = buildListQuery(request.query, {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [logs, total] = await Promise.all([
    client.detailChangeLog.findMany({
      where: { merchantId: id, ...(built.where as object) } as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      include: { actor: { select: { email: true } } },
    }),
    client.detailChangeLog.count({ where: { merchantId: id, ...(built.where as object) } as never }),
  ]);
  response.json(listResponse("detailChanges", logs.map((entry) => redactDetailChange(entry, flags)), total, built));
});

router.get("/approvals", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["subjectId", "subjectType", "maker.email", "checker.email"],
    in: { state: "state", mode: "mode" },
    equals: { makerUserId: "makerUserId", checkerUserId: "checkerUserId" },
    dates: {
      createdAt: { path: "createdAt" },
      expiresAt: { path: "expiresAt", fromKey: "expiresFrom", toKey: "expiresTo" },
    },
    sortable: {
      subjectType: "subjectType",
      subjectId: "subjectId",
      state: "state",
      mode: "mode",
      createdAt: "createdAt",
      expiresAt: "expiresAt",
    },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const domain = typeof query.domain === "string" ? query.domain.trim().toUpperCase() : "";
  const conditions: Record<string, unknown>[] = [built.where];
  const requestedSubjectTypes = typeof query.subjectType === "string"
    ? query.subjectType.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (requestedSubjectTypes.length > 0) {
    conditions.push({
      subjectType: { in: requestedSubjectTypes.flatMap((value) => approvalSubjectTypeVariants(value)) },
    });
  }
  const domainSubjects = APPROVAL_DOMAIN_SUBJECT_TYPES[domain];
  if (domainSubjects) {
    conditions.push({
      subjectType: { in: domainSubjects.flatMap((value) => approvalSubjectTypeVariants(value)) },
    });
  }
  const expired = query.expired === "true" || query.expired === "false" ? query.expired : "";
  if (expired === "true") {
    conditions.push({ expiresAt: { lt: new Date() } });
  } else if (expired === "false") {
    conditions.push({ OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }] });
  }
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const [approvals, total] = await Promise.all([
    client.approvalRequest.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: { maker: { select: { email: true } }, checker: { select: { email: true } } },
      skip: built.skip,
      take: built.take,
    }),
    client.approvalRequest.count({ where: where as never }),
  ]);
  response.json(listResponse("approvals", approvals.map((approval) => approvalListRow(approval as never)), total, built));
});

router.get("/approvals/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["subjectId", "subjectType", "maker.email", "checker.email"],
    in: { state: "state", mode: "mode" },
    equals: { makerUserId: "makerUserId", checkerUserId: "checkerUserId" },
    dates: {
      createdAt: { path: "createdAt" },
      expiresAt: { path: "expiresAt", fromKey: "expiresFrom", toKey: "expiresTo" },
    },
    sortable: {
      subjectType: "subjectType",
      subjectId: "subjectId",
      state: "state",
      mode: "mode",
      createdAt: "createdAt",
      expiresAt: "expiresAt",
    },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const domain = typeof query.domain === "string" ? query.domain.trim().toUpperCase() : "";
  const conditions: Record<string, unknown>[] = [built.where];
  const requestedSubjectTypes = typeof query.subjectType === "string"
    ? query.subjectType.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (requestedSubjectTypes.length > 0) {
    conditions.push({
      subjectType: { in: requestedSubjectTypes.flatMap((value) => approvalSubjectTypeVariants(value)) },
    });
  }
  const domainSubjects = APPROVAL_DOMAIN_SUBJECT_TYPES[domain];
  if (domainSubjects) {
    conditions.push({
      subjectType: { in: domainSubjects.flatMap((value) => approvalSubjectTypeVariants(value)) },
    });
  }
  const expired = query.expired === "true" || query.expired === "false" ? query.expired : "";
  if (expired === "true") {
    conditions.push({ expiresAt: { lt: new Date() } });
  } else if (expired === "false") {
    conditions.push({ OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }] });
  }
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const take = 5000;
  const [approvals, total] = await Promise.all([
    client.approvalRequest.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: { maker: { select: { email: true } }, checker: { select: { email: true } } },
      take,
    }),
    client.approvalRequest.count({ where: where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "APPROVALS_EXPORTED",
      entityType: "APPROVAL_REQUEST",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: approvals.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    approvals: approvals.map((approval) => approvalListRow(approval as never)),
    total,
    exported: approvals.length,
    truncated: total > approvals.length,
  });
});

const buildApprovalSummary = async () => {
  const pending = await client.approvalRequest.findMany({
    where: { state: { in: [...APPROVAL_PENDING_STATES] } },
    select: { subjectType: true, mode: true, state: true, createdAt: true, expiresAt: true, ratifyDueAt: true },
  });
  const now = Date.now();
  const soon = now + 24 * 60 * 60 * 1000;
  const byState: Record<string, number> = {};
  const bySubjectType: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  let expired = 0;
  let expiringSoon = 0;
  let emergencyDue = 0;
  let oldestAgeHours = 0;
  for (const row of pending) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    const subjectType = normalizeApprovalSubjectType(row.subjectType);
    bySubjectType[subjectType] = (bySubjectType[subjectType] ?? 0) + 1;
    const domain = approvalDomain(subjectType);
    byDomain[domain] = (byDomain[domain] ?? 0) + 1;
    const age = approvalAgeHours(row.createdAt);
    if (age > oldestAgeHours) oldestAgeHours = age;
    if (row.expiresAt) {
      const expires = row.expiresAt.getTime();
      if (expires < now) expired += 1;
      else if (expires <= soon) expiringSoon += 1;
    }
    if (row.mode === "EMERGENCY_RATIFICATION" && row.ratifyDueAt && row.ratifyDueAt.getTime() <= now) {
      emergencyDue += 1;
    }
  }
  return {
    totalPending: pending.length,
    byState,
    bySubjectType: Object.entries(bySubjectType).map(([subjectType, count]) => ({ subjectType, count })).sort((a, b) => b.count - a.count),
    byDomain: Object.entries(byDomain).map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count),
    expired,
    expiringSoon,
    emergencyDue,
    oldestAgeHours,
  };
};

router.get("/approvals/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  response.json(await buildApprovalSummary());
});

router.get("/approvals/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  const snapshot = await buildApprovalSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "PENDING_SCOPE_VERIFIED",
    "EXPIRY_REVIEWED",
    "DOMAIN_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "APPROVAL_SUMMARY_EXPORTED",
      entityType: "APPROVAL_REQUEST",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        totalPending: snapshot.totalPending,
        expired: snapshot.expired,
        expiringSoon: snapshot.expiringSoon,
        emergencyDue: snapshot.emergencyDue,
        oldestAgeHours: snapshot.oldestAgeHours,
        checklist,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.get("/approvals/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const approval = await client.approvalRequest.findUnique({
    where: { id },
    include: { maker: { select: { email: true } }, checker: { select: { email: true } } },
  });
  if (!approval) {
    throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The approval request does not exist");
  }
  const actor = principalOf(request);
  const [subjectContext, checkBlockedReason] = await Promise.all([
    approvalSubjectContext(approval.subjectType, approval.subjectId),
    approvalCheckBlockReason(approval as never, { userId: actor.userId ?? "", role: actor.role ?? null }),
  ]);
  response.json({
    approval: {
      ...approvalListRow(approval as never),
      payloadDiff: approval.payloadDiffJson,
      makerReason: approval.makerReason,
      rejectionReason: approval.rejectionReason,
      riskAcceptanceNote: approval.riskAcceptanceNote,
      subjectContext,
      canCheck: checkBlockedReason === null,
      checkBlockedReason,
      canApprove: checkBlockedReason === null && !approvalIsExpired(approval.expiresAt),
    },
  });
});

/**
 * Claims a pending approval inside the decision transaction with a conditional update
 * (UPDATE ... WHERE id = ? AND state IN ('PENDING_REVIEW','DRAFT')): two concurrent
 * decisions cannot both pass the pending check done before the transaction started.
 */
const claimPendingApproval = async (
  tx: { approvalRequest: { updateMany: (args: never) => Promise<{ count: number }> } },
  approvalId: string,
  checkerUserId: string,
): Promise<void> => {
  const claimed = await tx.approvalRequest.updateMany({
    where: { id: approvalId, state: { in: ["PENDING_REVIEW", "DRAFT"] } },
    data: { checkerUserId },
  } as never);
  if (claimed.count !== 1) {
    throw new ApiError(409, "APPROVAL_NOT_PENDING", "The approval request is not pending review");
  }
};

router.post("/approvals/:id/approve", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:check", "approval:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        notes: z.string().max(2000).optional(),
        riskAcceptanceNote: z.string().max(2000).optional(),
        outcome: z.enum(["WON", "LOST"]).optional(),
        checklist: z.array(z.enum([
          "DIFF_REVIEWED",
          "SUBJECT_CONTEXT_REVIEWED",
          "MAKER_CHECKER_SEPARATION_VERIFIED",
          "RISK_ASSESSED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const actor = actorFromRequest(request);
  assertCheckerAuthority(actor);
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval) {
    throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The approval request does not exist");
  }
  const subjectType = normalizeApprovalSubjectType(approval.subjectType);
  assertCheckerIsNotMaker(approval.makerUserId, actor.userId);
  if (approval.state !== "PENDING_REVIEW" && approval.state !== "DRAFT") {
    throw new ApiError(409, "APPROVAL_NOT_PENDING", "The approval request is not pending review");
  }
  if (approvalIsExpired(approval.expiresAt)) {
    throw new ApiError(409, "APPROVAL_EXPIRED", "The approval request has expired");
  }
  if (subjectType === "JOIN_REQUEST") {
    const joinRequest = await client.joinRequest.findUnique({ where: { id: approval.subjectId } });
    if (joinRequest?.onboardingChannel === "ADMIN_ASSISTED" && joinRequest.submittedByUserId === actor.userId) {
      throw new ApiError(
        403,
        "JOIN_REQUEST_MAKER_CANNOT_CHECK",
        "The operator who prepared an admin-assisted onboarding cannot check its approval",
      );
    }
  }
  if (subjectType === "MERCHANT" && !merchantApprovalCheckerAllowed(actor.role ?? null, approval.payloadDiffJson)) {
    throw new ApiError(
      403,
      "MERCHANT_CHECKER_DOMAIN_FORBIDDEN",
      "The principal's role cannot check this merchant change",
    );
  }
  if (subjectType === "BACKUP_POLICY") {
    if (!isBackupDaemonConfigured()) {
      throw new ApiError(
        503,
        "BACKUP_DAEMON_NOT_CONFIGURED",
        "The backup daemon is not configured for this deployment",
      );
    }
    const payload = backupPolicySchema
      .omit({ approvalRequestId: true })
      .parse(approval.payloadDiffJson ?? {});
    const updated = await getBackupControlClient().updatePolicy({
      fullCron: payload.fullCron,
      deltaCron: payload.deltaCron,
      drillCron: payload.drillCron,
      fullRetentionDays: payload.fullRetentionDays,
      walRetentionDays: payload.walRetentionDays,
      alertLagSeconds: payload.alertLagSeconds,
      updatedBy: actor.userId ?? undefined,
    });
    const executed = await client.$transaction(async (tx) => {
      await claimPendingApproval(tx as never, id, actor.userId);
      const row = await tx.approvalRequest.update({
        where: { id },
        data: {
          checkerUserId: actor.userId,
          state: "EXECUTED",
          riskAcceptanceNote: body.riskAcceptanceNote,
          baseVersion: (approval.baseVersion ?? 0) + 1,
        },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "UNKNOWN",
          action: "BACKUP_POLICY_UPDATED",
          entityType: "BACKUP_POLICY",
          entityId: approval.id,
          approvalRequestId: approval.id,
          beforeJson: (approval.payloadDiffJson ?? {}) as Record<string, unknown>,
          afterJson: {
            policy: updated.policy,
            approvalRequestId: approval.id,
          },
        },
      });
      return row;
    });
    response.json({
      id: executed.id,
      state: executed.state,
      checkerUserId: executed.checkerUserId,
      policy: updated.policy,
      status: "EXECUTED",
    });
    return;
  }
  const platform = getPlatformRuntime(client as never);
  if (subjectType === "ADJUSTMENT") {
    // The execution of an adjustment moves the money, so it is a background
    // job: the request records the checker and queues the execution. The job
    // never invents a checker, it executes with the one that is recorded on
    // the approval request.
    const { updated, job } = await client.$transaction(async (tx) => {
      await claimPendingApproval(tx as never, id, actor.userId);
      const updatedApproval = await tx.approvalRequest.update({
        where: { id },
        data: {
          checkerUserId: actor.userId,
          state: "APPROVED",
          riskAcceptanceNote: body.riskAcceptanceNote,
        },
      });
      const queued = await platform.repositories.jobs.enqueueJob(tx as never, {
        jobType: "ADJUSTMENT_EXECUTION",
        referenceType: "APPROVAL_REQUEST",
        referenceId: id,
        payload: {
          kind: "ADJUSTMENT_EXECUTION",
          approvalRequestId: id,
          outcome: body.outcome ?? null,
          notes: body.notes ?? null,
          checkerRole: actor.role,
        },
      });
      return { updated: updatedApproval, job: queued };
    });
    response.status(202).json({
      id: updated.id,
      state: updated.state,
      checkerUserId: updated.checkerUserId,
      jobId: job.id,
      status: "QUEUED",
    });
    return;
  }
  // The approved change is executed, not just recorded: the ledger posting,
  // the state change of the subject and the audit trail share one transaction.
  const { updated, execution } = await client.$transaction(async (tx) => {
    await claimPendingApproval(tx as never, id, actor.userId);
    const result = await executeApprovalSubject(governanceContext(platform), tx as never, {
      approval: {
        id: approval.id,
        subjectType,
        subjectId: approval.subjectId,
        payloadDiffJson: approval.payloadDiffJson,
        makerUserId: approval.makerUserId,
      },
      checkerUserId: actor.userId,
      checkerRole: actor.role,
      notes: body.notes ?? null,
      outcome: body.outcome ?? null,
    });
    const state = result.status === "HELD" ? "PENDING_REVIEW" : "EXECUTED";
    const updatedApproval = await tx.approvalRequest.update({
      where: { id },
      data: {
        checkerUserId: actor.userId,
        state,
        riskAcceptanceNote: body.riskAcceptanceNote,
      },
    });
    return { updated: updatedApproval, execution: result };
  });
  if (subjectType === "GATEWAY_VERSION") {
    // The state change committed with the go-live gate decision; only the
    // outbound cache is invalidated after the commit.
    const version = await client.gatewayVersion.findUnique({ where: { id: approval.subjectId } });
    if (version) {
      await invalidationBus.invalidateGateway(version.gatewayId, "gateway-version-live");
    }
  }
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "APPROVAL_DECISION_CHECKLIST",
      entityType: "APPROVAL_REQUEST",
      entityId: id,
      beforeJson: {},
      afterJson: { decision: "APPROVED", checklist: body.checklist ?? [] },
    },
  });
  response.json({
    id: updated.id,
    state: updated.state,
    checkerUserId: updated.checkerUserId,
    execution: {
      status: execution.status,
      reason: execution.reason ?? null,
      template: execution.template ?? null,
      journalEntryId: execution.journalEntryId ?? null,
      operatorCaseId: execution.operatorCaseId ?? null,
    },
  });
});

/**
 * Promotes a gateway version to LIVE.
 *
 * Design v5 §14: "No `gateway_versions` row can transition to `LIVE` without
 * passing all 12 Go-Live Gates." The gates are evaluated against the
 * evidence the sandbox suite runner persisted, and the transition is refused
 * with the ids of the failed gates. The previous live version is superseded
 * and the outbound consumer cache of the gateway is invalidated.
 */
export const activateGatewayVersion = async (
  versionId: string,
  checkerUserId: string | null = null,
): Promise<void> => {
  // The gates and the state change share the transaction of the activation,
  // so a version can never become live unless every gate passed in the same
  // commit (design §14).
  const activated = await client.$transaction(async (tx) =>
    activateGatewayVersionInTransaction(tx as never, versionId, checkerUserId),
  );
  await invalidationBus.invalidateGateway(activated.gatewayId, "gateway-version-live");
};

router.post("/approvals/:id/reject", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:check", "approval:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({
    reason: z.string().min(2).max(2000),
    checklist: z.array(z.enum([
      "DIFF_REVIEWED",
      "SUBJECT_CONTEXT_REVIEWED",
      "MAKER_CHECKER_SEPARATION_VERIFIED",
      "RISK_ASSESSED",
    ])).max(10).optional(),
  }).strict(), request.body);
  const actor = actorFromRequest(request);
  assertCheckerAuthority(actor);
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval) {
    throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The approval request does not exist");
  }
  const subjectType = normalizeApprovalSubjectType(approval.subjectType);
  assertCheckerIsNotMaker(approval.makerUserId, actor.userId);
  if (subjectType === "JOIN_REQUEST") {
    const joinRequest = await client.joinRequest.findUnique({ where: { id: approval.subjectId } });
    if (joinRequest?.onboardingChannel === "ADMIN_ASSISTED" && joinRequest.submittedByUserId === actor.userId) {
      throw new ApiError(
        403,
        "JOIN_REQUEST_MAKER_CANNOT_CHECK",
        "The operator who prepared an admin-assisted onboarding cannot check its approval",
      );
    }
  }
  if (subjectType === "MERCHANT" && !merchantApprovalCheckerAllowed(actor.role ?? null, approval.payloadDiffJson)) {
    throw new ApiError(
      403,
      "MERCHANT_CHECKER_DOMAIN_FORBIDDEN",
      "The principal's role cannot check this merchant change",
    );
  }
  if (approval.state !== "PENDING_REVIEW" && approval.state !== "DRAFT") {
    throw new ApiError(409, "APPROVAL_NOT_PENDING", "The approval request is not pending review");
  }
  const updated = await client.$transaction(async (tx) => {
    await claimPendingApproval(tx as never, id, actor.userId);
    const row = await tx.approvalRequest.update({
      where: { id },
      data: { checkerUserId: actor.userId, state: "REJECTED", rejectionReason: body.reason },
    });
    if (subjectType === "OPERATOR_CASE") {
      const operatorCase = await tx.operatorCase.findUnique({ where: { id: row.subjectId } });
      if (operatorCase) {
        await tx.operatorCase.updateMany({
          where: { id: row.subjectId, state: "PENDING_CHECKER" },
          data: { state: "IN_PROGRESS" },
        });
        await writeAudit(tx, {
          data: {
            actorId: actor.userId,
            role: actor.role,
            action: "OPERATOR_CASE_RESOLUTION_REJECTED",
            entityType: "OPERATOR_CASE",
            entityId: row.subjectId,
            beforeJson: { state: "PENDING_CHECKER" },
            afterJson: { state: "IN_PROGRESS", rejectionReason: body.reason },
            approvalRequestId: row.id,
          },
        });
      }
    }
    if (subjectType === "JOIN_REQUEST") {
      const joinRequest = await tx.joinRequest.findUnique({ where: { id: row.subjectId } });
      if (joinRequest) {
        await tx.joinRequest.update({
          where: { id: row.subjectId },
          data: { status: "IN_REVIEW", approvalRequestId: null },
        });
        await writeAudit(tx, {
          data: {
            actorId: actor.userId,
            role: actor.role,
            action: "JOIN_REQUEST_APPROVAL_REJECTED",
            entityType: "JOIN_REQUEST",
            entityId: row.subjectId,
            beforeJson: { state: "PENDING_CHECKER" },
            afterJson: { state: "IN_REVIEW", rejectionReason: body.reason },
            approvalRequestId: row.id,
          },
        });
      }
    }
    if (subjectType === "MERCHANT") {
      const kind = merchantApprovalKind(row.payloadDiffJson);
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role,
          action: kind === "SUSPEND_EMERGENCY"
            ? "MERCHANT_EMERGENCY_SUSPENSION_NOT_RATIFIED"
            : "MERCHANT_CHANGE_REJECTED",
          entityType: "MERCHANT",
          entityId: row.subjectId,
          beforeJson: { state: "PENDING_REVIEW", kind },
          afterJson: { state: "REJECTED", rejectionReason: body.reason },
          approvalRequestId: row.id,
        },
      });
    }
    return row;
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "APPROVAL_DECISION_CHECKLIST",
      entityType: "APPROVAL_REQUEST",
      entityId: id,
      beforeJson: {},
      afterJson: { decision: "REJECTED", checklist: body.checklist ?? [] },
    },
  });
  response.json({ id: updated.id, state: updated.state });
});

const amlScreeningRow = (
  screening: Record<string, any>,
  maps: Awaited<ReturnType<typeof amlCaseSubjectMaps>>,
) => {
  const merchant = maps.merchants.get(screening.subjectId);
  const attempt = maps.attempts.get(screening.subjectId);
  const owner = maps.owners.get(screening.subjectId);
  const matches = Array.isArray(screening.matches) ? screening.matches : [];
  const unresolved = matches.filter((match: Record<string, unknown>) => match.disposition === "UNREVIEWED");
  return {
    id: screening.id,
    subjectType: screening.subjectType,
    subjectId: screening.subjectId,
    subjectName: merchant?.tradeName
      ?? attempt?.merchant?.tradeName
      ?? (owner ? owner.fullNameEn ?? owner.fullNameAr : null)
      ?? screening.subjectId,
    subjectReference: attempt?.reference ?? screening.subjectId,
    merchantName: merchant?.tradeName ?? attempt?.merchant?.tradeName ?? owner?.merchant?.tradeName ?? "",
    provider: screening.providerCode,
    providerRequestRef: screening.providerRequestRef,
    trigger: screening.trigger,
    lists: screening.listVersionsJson,
    result: screening.result,
    score: screening.highestScore ? merchantMoney(screening.highestScore) : null,
    matchCount: screening.matchCount,
    matchId: unresolved[0]?.id ?? null,
    disposition: unresolved.length === 0 && matches.length > 0 ? matches[0]?.disposition ?? null : null,
    dispositionSummary: {
      unreviewed: unresolved.length,
      falsePositive: matches.filter((match: Record<string, unknown>) => match.disposition === "FALSE_POSITIVE").length,
      trueMatch: matches.filter((match: Record<string, unknown>) => match.disposition === "TRUE_MATCH").length,
      escalated: matches.filter((match: Record<string, unknown>) => match.disposition === "ESCALATED").length,
    },
    requestedAt: screening.requestedAt,
    screenedAt: screening.requestedAt,
    completedAt: screening.completedAt,
    ageHours: approvalAgeHours(new Date(screening.requestedAt)),
  };
};

router.get("/aml/screenings", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["subjectId", "providerCode", "providerRequestRef"],
    in: { result: "result", subjectType: "subjectType", trigger: "trigger" },
    equals: { providerCode: "providerCode" },
    ranges: { score: { path: "highestScore", kind: "decimal" } },
    dates: {
      createdAt: { path: "requestedAt" },
      requestedAt: { path: "requestedAt", fromKey: "requestedFrom", toKey: "requestedTo" },
    },
    sortable: { result: "result", requestedAt: "requestedAt", score: "highestScore", matchCount: "matchCount" },
    defaultSort: { requestedAt: "desc" },
    defaultPageSize: 20,
  });
  const [screenings, total] = await Promise.all([
    client.amlScreening.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { matches: true }, skip: built.skip, take: built.take }),
    client.amlScreening.count({ where: built.where as never }),
  ]);
  const maps = await amlCaseSubjectMaps(screenings.map((screening) => ({ subjectType: screening.subjectType, subjectId: screening.subjectId })));
  response.json(listResponse("screenings", screenings.map((screening) => amlScreeningRow(screening as never, maps)), total, built));
});

router.get("/aml/screenings/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["subjectId", "providerCode", "providerRequestRef"],
    in: { result: "result", subjectType: "subjectType", trigger: "trigger" },
    equals: { providerCode: "providerCode" },
    ranges: { score: { path: "highestScore", kind: "decimal" } },
    dates: {
      createdAt: { path: "requestedAt" },
      requestedAt: { path: "requestedAt", fromKey: "requestedFrom", toKey: "requestedTo" },
    },
    sortable: { result: "result", requestedAt: "requestedAt", score: "highestScore", matchCount: "matchCount" },
    defaultSort: { requestedAt: "desc" },
    defaultPageSize: 20,
  });
  const take = 5000;
  const [screenings, total] = await Promise.all([
    client.amlScreening.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { matches: true }, take }),
    client.amlScreening.count({ where: built.where as never }),
  ]);
  const maps = await amlCaseSubjectMaps(screenings.map((screening) => ({ subjectType: screening.subjectType, subjectId: screening.subjectId })));
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_SCREENINGS_EXPORTED",
      entityType: "AML_SCREENING",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: screenings.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    screenings: screenings.map((screening) => amlScreeningRow(screening as never, maps)),
    total,
    exported: screenings.length,
    truncated: total > screenings.length,
  });
});

const buildAmlScreeningSummary = async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [resultRows, triggerRows, total, screened24h, unresolvedMatches, latest] = await Promise.all([
    client.amlScreening.groupBy({ by: ["result"], _count: { _all: true } }),
    client.amlScreening.groupBy({ by: ["trigger"], _count: { _all: true } }),
    client.amlScreening.count(),
    client.amlScreening.count({ where: { requestedAt: { gte: since } } }),
    client.amlScreeningMatch.count({ where: { disposition: "UNREVIEWED" } }),
    client.amlScreening.findFirst({ orderBy: { requestedAt: "desc" }, select: { requestedAt: true } }),
  ]);
  const byResult: Record<string, number> = {};
  for (const row of resultRows) byResult[row.result] = row._count._all;
  const byTrigger: Record<string, number> = {};
  for (const row of triggerRows) byTrigger[row.trigger] = row._count._all;
  return {
    total,
    screened24h,
    unresolvedMatches,
    byResult,
    byTrigger,
    latestScreenedAt: latest?.requestedAt ?? null,
  };
};

router.get("/aml/screenings/summary", async (request: Request, response: Response) => {
  assertConfidential(request);
  response.json(await buildAmlScreeningSummary());
});

router.get("/aml/screenings/summary/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const summary = await buildAmlScreeningSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_SCREENING_SUMMARY_EXPORTED",
      entityType: "AML_SCREENING",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: summary.total,
        screened24h: summary.screened24h,
        unresolvedMatches: summary.unresolvedMatches,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/aml/screenings/:id", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const screening = await client.amlScreening.findUnique({
    where: { id },
    include: {
      matches: {
        orderBy: { score: "desc" },
        include: { dispositionBy: { select: { email: true } } },
      },
      amlCases: { select: { id: true, status: true, severity: true, createdAt: true } },
    },
  });
  if (!screening) throw new ApiError(404, "AML_SCREENING_NOT_FOUND", "The AML screening does not exist");
  const maps = await amlCaseSubjectMaps([{ subjectType: screening.subjectType, subjectId: screening.subjectId }]);
  response.json({
    screening: {
      ...amlScreeningRow(screening as never, maps),
      matches: screening.matches.map((match) => ({
        id: match.id,
        listType: match.listType,
        listName: match.listName,
        listEntryRef: match.listEntryRef,
        matchedName: match.matchedName,
        score: merchantMoney(match.score),
        attributes: match.attributesJson,
        disposition: match.disposition,
        dispositionBy: match.dispositionBy?.email ?? null,
        dispositionNotes: match.dispositionNotes,
        suppressFuture: match.suppressFuture,
        suppressUntil: match.suppressUntil,
        createdAt: match.createdAt,
      })),
      amlCases: screening.amlCases,
      canDisposition: screening.matches.some((match) => match.disposition === "UNREVIEWED"),
    },
  });
});

router.post("/aml/matches/:id/disposition", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        disposition: z.enum(["FALSE_POSITIVE", "TRUE_MATCH", "ESCALATED"]),
        notes: z.string().max(2000).optional(),
        suppressFuture: z.boolean().default(false),
        suppressUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        checklist: z.array(z.enum([
          "MATCH_DETAILS_REVIEWED",
          "IDENTITY_EVIDENCE_CHECKED",
          "DISPOSITION_RATIONALE_DOCUMENTED",
          "ESCALATION_PATH_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const match = await client.amlScreeningMatch.findUnique({ where: { id } });
  if (!match) {
    throw new ApiError(404, "SCREENING_MATCH_NOT_FOUND", "The screening match does not exist");
  }
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.amlScreeningMatch.update({
      where: { id },
      data: {
        disposition: body.disposition,
        dispositionById: actor.userId,
        dispositionNotes: body.notes,
        suppressFuture: body.suppressFuture,
        suppressUntil: body.suppressUntil ? new Date(body.suppressUntil) : null,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "COMPLIANCE",
        action: "AML_SCREENING_MATCH_DISPOSITIONED",
        entityType: "AML_SCREENING_MATCH",
        entityId: id,
        beforeJson: { disposition: match.disposition },
        afterJson: { disposition: row.disposition, notes: body.notes ?? null, suppressFuture: body.suppressFuture, checklist: body.checklist ?? [] },
      },
    });
    return row;
  });
  response.json({ id: updated.id, disposition: updated.disposition });
});

const AML_OPEN_STATUSES = ["OPEN", "IN_REVIEW", "PENDING_CHECKER"] as const;
const AML_RESOLVED_STATUSES = ["RELEASED", "REJECTED_VOID", "FROZEN", "ESCALATED_STR"] as const;

const amlCaseSubjectMaps = async (cases: Array<{ subjectType: string; subjectId: string }>) => {
  const merchantIds = new Set<string>();
  const attemptIds = new Set<string>();
  const ownerIds = new Set<string>();
  for (const entry of cases) {
    if (entry.subjectType === "MERCHANT") merchantIds.add(entry.subjectId);
    else if (entry.subjectType === "PAYMENT_ATTEMPT") attemptIds.add(entry.subjectId);
    else if (entry.subjectType === "BENEFICIAL_OWNER") ownerIds.add(entry.subjectId);
  }
  const [merchants, attempts, owners] = await Promise.all([
    merchantIds.size === 0 ? [] : client.merchant.findMany({
      where: { id: { in: [...merchantIds] } },
      select: { id: true, tradeName: true, legalName: true, status: true },
    }),
    attemptIds.size === 0 ? [] : client.paymentAttempt.findMany({
      where: { id: { in: [...attemptIds] } },
      select: {
        id: true,
        reference: true,
        status: true,
        totalChargedAmount: true,
        currency: true,
        merchant: { select: { tradeName: true, legalName: true } },
      },
    }),
    ownerIds.size === 0 ? [] : client.beneficialOwner.findMany({
      where: { id: { in: [...ownerIds] } },
      select: { id: true, fullNameEn: true, fullNameAr: true, merchant: { select: { tradeName: true, legalName: true } } },
    }),
  ]);
  return {
    merchants: new Map(merchants.map((row) => [row.id, row])),
    attempts: new Map(attempts.map((row) => [row.id, row])),
    owners: new Map(owners.map((row) => [row.id, row])),
  };
};

const amlCaseListRow = (
  entry: Record<string, any>,
  maps: Awaited<ReturnType<typeof amlCaseSubjectMaps>>,
) => {
  const merchant = maps.merchants.get(entry.subjectId);
  const attempt = maps.attempts.get(entry.subjectId);
  const owner = maps.owners.get(entry.subjectId);
  const subjectName = merchant?.tradeName
    ?? attempt?.merchant?.tradeName
    ?? (owner ? owner.fullNameEn ?? owner.fullNameAr : null)
    ?? entry.subjectId;
  const amount = attempt?.totalChargedAmount ? merchantMoney(attempt.totalChargedAmount) : null;
  return {
    id: entry.id,
    caseRef: `AML-${String(entry.id).slice(-8).toUpperCase()}`,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectName,
    subjectReference: attempt?.reference ?? entry.subjectId,
    subjectStatus: merchant?.status ?? attempt?.status ?? null,
    merchantName: merchant?.tradeName ?? attempt?.merchant?.tradeName ?? owner?.merchant?.tradeName ?? "",
    severity: entry.severity,
    status: entry.status,
    amount,
    currency: attempt?.currency ?? null,
    ruleId: entry.ruleId,
    ruleCode: entry.rule?.code ?? null,
    ruleName: entry.rule?.name ?? null,
    ruleVersion: entry.ruleVersion,
    screeningId: entry.screeningId,
    screeningResult: entry.screening?.result ?? null,
    screeningScore: entry.screening?.highestScore ? merchantMoney(entry.screening.highestScore) : null,
    triggerReason: entry.triggerReason,
    severityInputs: entry.severityInputsJson,
    holdJournalEntryId: entry.holdJournalEntryId,
    regulatoryReportId: entry.regulatoryReportId,
    assignedReviewerId: entry.assignedReviewerId,
    assignedReviewerName: entry.assignedReviewer?.email ?? "",
    reviewerNotes: entry.reviewerNotes,
    confidential: entry.confidential,
    openedAt: entry.createdAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    slaDueAt: entry.slaDueAt,
    ageHours: approvalAgeHours(new Date(entry.createdAt)),
    slaOverdue: Boolean(entry.slaDueAt && new Date(entry.slaDueAt).getTime() < Date.now()),
  };
};

router.get("/aml/cases", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["triggerReason", "subjectId", "rule.code", "rule.name", "assignedReviewer.email"],
    in: { status: "status", severity: "severity", subjectType: "subjectType" },
    equals: { ruleCode: "rule.code", assignedReviewerId: "assignedReviewerId" },
    dates: {
      createdAt: { path: "createdAt" },
      slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" },
    },
    sortable: { status: "status", severity: "severity", openedAt: "createdAt", slaDueAt: "slaDueAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const [cases, total] = await Promise.all([
    client.amlCase.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        rule: { select: { code: true, name: true } },
        screening: { select: { id: true, result: true, highestScore: true } },
        assignedReviewer: { select: { email: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.amlCase.count({ where: built.where as never }),
  ]);
  const maps = await amlCaseSubjectMaps(cases.map((entry) => ({ subjectType: entry.subjectType, subjectId: entry.subjectId })));
  response.json(listResponse("cases", cases.map((entry) => amlCaseListRow(entry as never, maps)), total, built));
});

router.get("/aml/cases/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["triggerReason", "subjectId", "rule.code", "rule.name", "assignedReviewer.email"],
    in: { status: "status", severity: "severity", subjectType: "subjectType" },
    equals: { ruleCode: "rule.code", assignedReviewerId: "assignedReviewerId" },
    dates: {
      createdAt: { path: "createdAt" },
      slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" },
    },
    sortable: { status: "status", severity: "severity", openedAt: "createdAt", slaDueAt: "slaDueAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const take = 5000;
  const [cases, total] = await Promise.all([
    client.amlCase.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        rule: { select: { code: true, name: true } },
        screening: { select: { id: true, result: true, highestScore: true } },
        assignedReviewer: { select: { email: true } },
      },
      take,
    }),
    client.amlCase.count({ where: built.where as never }),
  ]);
  const maps = await amlCaseSubjectMaps(cases.map((entry) => ({ subjectType: entry.subjectType, subjectId: entry.subjectId })));
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_CASES_EXPORTED",
      entityType: "AML_CASE",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: cases.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    cases: cases.map((entry) => amlCaseListRow(entry as never, maps)),
    total,
    exported: cases.length,
    truncated: total > cases.length,
  });
});

const buildAmlCaseSummary = async () => {
  const now = new Date();
  const [statusRows, severityRows, openAggregate, oldest] = await Promise.all([
    client.amlCase.groupBy({ by: ["status"], _count: { _all: true } }),
    client.amlCase.groupBy({ by: ["severity"], _count: { _all: true } }),
    client.amlCase.aggregate({ where: { status: { in: [...AML_OPEN_STATUSES] as never } }, _count: { _all: true } }),
    client.amlCase.findFirst({
      where: { status: { in: [...AML_OPEN_STATUSES] as never } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const [overdue, criticalOpen, frozen, escalated] = await Promise.all([
    client.amlCase.count({ where: { status: { in: [...AML_OPEN_STATUSES] as never }, slaDueAt: { lt: now } } }),
    client.amlCase.count({ where: { status: { in: [...AML_OPEN_STATUSES] as never }, severity: "CRITICAL" } }),
    client.amlCase.count({ where: { status: "FROZEN" } }),
    client.amlCase.count({ where: { status: "ESCALATED_STR" } }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row._count._all;
  const bySeverity: Record<string, number> = {};
  for (const row of severityRows) bySeverity[row.severity] = row._count._all;
  return {
    totalOpen: (openAggregate._count as { _all: number })._all,
    byStatus,
    bySeverity,
    overdue,
    criticalOpen,
    frozen,
    escalated,
    oldestOpenAgeHours: oldest ? approvalAgeHours(oldest.createdAt, now.getTime()) : 0,
  };
};

router.get("/aml/cases/summary", async (request: Request, response: Response) => {
  assertConfidential(request);
  response.json(await buildAmlCaseSummary());
});

router.get("/aml/cases/summary/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const summary = await buildAmlCaseSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "CASE_SCOPE_VERIFIED",
    "SEVERITY_STATUS_REVIEWED",
    "SLA_BREACH_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_CASE_SUMMARY_EXPORTED",
      entityType: "AML_CASE",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        totalOpen: summary.totalOpen,
        overdue: summary.overdue,
        criticalOpen: summary.criticalOpen,
        frozen: summary.frozen,
        escalated: summary.escalated,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/aml/cases/:id", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const entry = await client.amlCase.findUnique({
    where: { id },
    include: {
      rule: { select: { id: true, code: true, name: true, ruleType: true, action: true, baseSeverity: true } },
      screening: { include: { matches: true } },
      assignedReviewer: { select: { id: true, email: true } },
      holdJournalEntry: { select: { id: true, refType: true, refId: true, description: true } },
      regulatoryReport: { select: { id: true, reportType: true, status: true, submittedAt: true } },
    },
  });
  if (!entry) throw new ApiError(404, "AML_CASE_NOT_FOUND", "The AML case does not exist");
  const maps = await amlCaseSubjectMaps([{ subjectType: entry.subjectType, subjectId: entry.subjectId }]);
  const approval = await client.approvalRequest.findFirst({
    where: { subjectType: { in: approvalSubjectTypeVariants("AML_CASE") as never }, subjectId: entry.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, state: true, makerUserId: true, checkerUserId: true, rejectionReason: true, createdAt: true },
  });
  response.json({
    case: {
      ...amlCaseListRow(entry as never, maps),
      severityInputs: entry.severityInputsJson,
      screening: entry.screening ? {
        id: entry.screening.id,
        result: entry.screening.result,
        trigger: entry.screening.trigger,
        providerCode: entry.screening.providerCode,
        requestedAt: entry.screening.requestedAt,
        completedAt: entry.screening.completedAt,
        highestScore: entry.screening.highestScore ? merchantMoney(entry.screening.highestScore) : null,
        matches: entry.screening.matches.map((match) => ({
          id: match.id,
          listType: match.listType,
          listName: match.listName,
          listEntryRef: match.listEntryRef,
          matchedName: match.matchedName,
          score: merchantMoney(match.score),
          disposition: match.disposition,
          dispositionNotes: match.dispositionNotes,
        })),
      } : null,
      holdJournalEntry: entry.holdJournalEntry,
      regulatoryReport: entry.regulatoryReport,
      approval: approval ? {
        id: approval.id,
        state: approval.state,
        makerUserId: approval.makerUserId,
        checkerUserId: approval.checkerUserId,
        rejectionReason: approval.rejectionReason,
        createdAt: approval.createdAt,
      } : null,
    },
  });
});

router.post("/aml/cases/:id/propose", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      action: z.enum(["HOLD", "RELEASE", "REJECT", "ESCALATE"]),
      notes: z.string().max(2000).optional(),
      checklist: z.array(z.enum([
        "EVIDENCE_REVIEWED",
        "SUBJECT_IDENTIFIED",
        "REGULATORY_OBLIGATION_ASSESSED",
        "CHECKER_INDEPENDENCE_CONFIRMED",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const amlCase = await client.amlCase.findUnique({ where: { id } });
  if (!amlCase) {
    throw new ApiError(404, "AML_CASE_NOT_FOUND", "The AML case does not exist");
  }
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "AML_CASE",
      subjectId: amlCase.id,
      payloadDiffJson: body,
      mode: "STANDARD",
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
  });
  await client.amlCase.update({ where: { id }, data: { status: "PENDING_CHECKER" } });
  response.status(202).json({ status: "PENDING_CHECKER", approvalRequestId: approval.id });
});

router.get("/aml/rules", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["code", "name"],
    equals: { ruleType: "ruleType", action: "action", baseSeverity: "baseSeverity" },
    booleans: { active: "active" },
    ranges: { version: { path: "version", kind: "number" } },
    dates: { effectiveFrom: { path: "effectiveFrom" } },
    sortable: { code: "code", name: "name", ruleType: "ruleType", baseSeverity: "baseSeverity", active: "active", effectiveFrom: "effectiveFrom" },
    defaultSort: { code: "asc" },
  });
  const [rules, total] = await Promise.all([
    client.amlRule.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.amlRule.count({ where: built.where as never }),
  ]);
  const ruleIds = rules.map((rule) => rule.id);
  const approvals = ruleIds.length === 0
    ? []
    : await client.approvalRequest.findMany({
        where: { subjectType: { in: approvalSubjectTypeVariants("AML_RULE") as never }, subjectId: { in: ruleIds } },
        orderBy: { createdAt: "desc" },
        select: { id: true, subjectId: true, state: true },
      });
  const approvalMap = new Map<string, { id: string; state: string }>();
  for (const approval of approvals) {
    if (!approvalMap.has(approval.subjectId)) approvalMap.set(approval.subjectId, { id: approval.id, state: approval.state });
  }
  response.json(listResponse(
    "rules",
    rules.map((rule) => ({
      ...rule,
      approvalRequestId: approvalMap.get(rule.id)?.id ?? null,
      approvalState: approvalMap.get(rule.id)?.state ?? null,
      pendingApproval: approvalMap.get(rule.id)?.state === "PENDING_REVIEW",
    })),
    total,
    built,
  ));
});

router.get("/aml/rules/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["code", "name"],
    equals: { ruleType: "ruleType", action: "action", baseSeverity: "baseSeverity" },
    booleans: { active: "active" },
    ranges: { version: { path: "version", kind: "number" } },
    dates: { effectiveFrom: { path: "effectiveFrom" } },
    sortable: { code: "code", name: "name", ruleType: "ruleType", baseSeverity: "baseSeverity", active: "active", effectiveFrom: "effectiveFrom" },
    defaultSort: { code: "asc" },
  });
  const take = 5000;
  const [rules, total] = await Promise.all([
    client.amlRule.findMany({ where: built.where as never, orderBy: built.orderBy as never, take }),
    client.amlRule.count({ where: built.where as never }),
  ]);
  const ruleIds = rules.map((rule) => rule.id);
  const approvals = ruleIds.length === 0
    ? []
    : await client.approvalRequest.findMany({
        where: { subjectType: { in: approvalSubjectTypeVariants("AML_RULE") as never }, subjectId: { in: ruleIds } },
        orderBy: { createdAt: "desc" },
        select: { id: true, subjectId: true, state: true },
      });
  const approvalMap = new Map<string, { id: string; state: string }>();
  for (const approval of approvals) {
    if (!approvalMap.has(approval.subjectId)) approvalMap.set(approval.subjectId, { id: approval.id, state: approval.state });
  }
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_RULES_EXPORTED",
      entityType: "AML_RULE",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: rules.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    rules: rules.map((rule) => ({
      ...rule,
      approvalRequestId: approvalMap.get(rule.id)?.id ?? null,
      approvalState: approvalMap.get(rule.id)?.state ?? null,
      pendingApproval: approvalMap.get(rule.id)?.state === "PENDING_REVIEW",
    })),
    total,
    exported: rules.length,
    truncated: total > rules.length,
  });
});

const buildAmlRuleSummary = async () => {
  const [active, pendingApprovals, severityRows, typeRows, actionRows] = await Promise.all([
    client.amlRule.count({ where: { active: true } }),
    client.approvalRequest.count({ where: { subjectType: { in: approvalSubjectTypeVariants("AML_RULE") as never }, state: "PENDING_REVIEW" } }),
    client.amlRule.groupBy({ by: ["baseSeverity"], _count: { _all: true } }),
    client.amlRule.groupBy({ by: ["ruleType"], _count: { _all: true } }),
    client.amlRule.groupBy({ by: ["action"], _count: { _all: true } }),
  ]);
  const bySeverity: Record<string, number> = {};
  for (const row of severityRows) bySeverity[row.baseSeverity] = row._count._all;
  const byType: Record<string, number> = {};
  for (const row of typeRows) byType[row.ruleType] = row._count._all;
  const byAction: Record<string, number> = {};
  for (const row of actionRows) byAction[row.action] = row._count._all;
  const total = await client.amlRule.count();
  return { total, active, inactive: total - active, pendingApprovals, bySeverity, byType, byAction };
};

router.get("/aml/rules/summary", async (request: Request, response: Response) => {
  assertConfidential(request);
  response.json(await buildAmlRuleSummary());
});

router.get("/aml/rules/summary/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const summary = await buildAmlRuleSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_RULE_SUMMARY_EXPORTED",
      entityType: "AML_RULE",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: summary.total,
        active: summary.active,
        inactive: summary.inactive,
        pendingApprovals: summary.pendingApprovals,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.post("/aml/rules", async (request: Request, response: Response) => {
  assertConfidential(request);
  const body = parseOrThrow(
    z
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
        scope: z.record(z.string().max(64), z.unknown()).default({}),
        params: z.record(z.string().max(64), z.unknown()).default({}),
        action: z.enum(["HOLD", "FLAG", "BLOCK", "CASE_ONLY"]),
        baseSeverity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        effectiveFrom: z.string().max(64).optional(),
        checklist: z.array(z.enum([
          "RULE_LOGIC_REVIEWED",
          "THRESHOLDS_VERIFIED",
          "REGULATORY_BASIS_DOCUMENTED",
          "CHECKER_INDEPENDENCE_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  let created: { ruleId: string; approvalRequestId: string };
  try {
    created = await client.$transaction(async (tx) => {
      const rule = await tx.amlRule.create({
        data: {
          code: body.code,
          name: body.name,
          ruleType: body.ruleType,
          scope: json(body.scope),
          params: json(body.params),
          action: body.action,
          baseSeverity: body.baseSeverity,
          active: false,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
        },
      });
      const approval = await tx.approvalRequest.create({
        data: {
          subjectType: "AML_RULE",
          subjectId: rule.id,
          payloadDiffJson: json(body),
          mode: "STANDARD",
          makerUserId: actor.userId,
          state: "PENDING_REVIEW",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "COMPLIANCE",
          action: "AML_RULE_DRAFTED",
          entityType: "AML_RULE",
          entityId: rule.id,
          beforeJson: {},
          afterJson: { code: rule.code, state: "PENDING_REVIEW", approvalRequestId: approval.id, checklist: body.checklist ?? [] },
          approvalRequestId: approval.id,
        },
      });
      return { ruleId: rule.id, approvalRequestId: approval.id };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      throw new ApiError(409, "AML_RULE_CODE_EXISTS", "An AML rule with this code already exists");
    }
    throw error;
  }
  response.status(202).json({
    status: "PENDING_REVIEW",
    ruleId: created.ruleId,
    approvalRequestId: created.approvalRequestId,
  });
});

router.get("/aml/rules/:id", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const rule = await client.amlRule.findUnique({
    where: { id },
    include: { approvalRequest: { select: { id: true, state: true, makerUserId: true, checkerUserId: true, rejectionReason: true, createdAt: true } } },
  });
  if (!rule) throw new ApiError(404, "AML_RULE_NOT_FOUND", "The AML rule does not exist");
  response.json({
    rule: {
      ...rule,
      approvalState: rule.approvalRequest?.state ?? null,
      approval: rule.approvalRequest,
    },
  });
});
router.get("/aml/reporting-rules", async (request: Request, response: Response) => {
  assertConfidential(request);
  const rules = await client.reportingRule.findMany();
  response.json({ rules });
});

router.post("/aml/reporting-rules", async (request: Request, response: Response) => {
  assertConfidential(request);
  const body = parseOrThrow(
    z
      .object({
        reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]),
        thresholdAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        windowSeconds: z.number().int().min(1).max(31_536_000).optional(),
        currency: z.string().length(3).default("LYD"),
        conditions: z.record(z.string().max(64), z.unknown()).default({}),
        sourceReference: z.string().min(2).max(200),
        status: z.enum(["PROVISIONAL", "CONFIRMED"]).default("PROVISIONAL"),
      })
      .strict(),
    request.body,
  );
  const rule = await client.reportingRule.create({
    data: {
      reportType: body.reportType,
      thresholdAmount: body.thresholdAmount ? new Prisma.Decimal(body.thresholdAmount) : null,
      windowSeconds: body.windowSeconds ?? null,
      currency: body.currency.toUpperCase(),
      conditions: json(body.conditions),
      sourceReference: body.sourceReference,
      status: body.status,
      effectiveFrom: new Date(),
    },
  });
  response.status(201).json({ id: rule.id, status: rule.status });
});

router.post("/aml/reporting-rules/:id/promote", async (request: Request, response: Response) => {
  assertReportingAuthority(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const actor = actorFromRequest(request);
  const result = await proposeReportingRulePromotion(client, {
    ruleId: id,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
  response.status(202).json(result);
});

const AML_REPORT_OPEN_STATUSES = ["DRAFT", "PENDING_CHECKER", "APPROVED"] as const;
const AML_REPORT_SUBMITTED_STATUSES = ["SUBMITTED", "ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"] as const;

const regulatoryReportRow = (report: Record<string, any>, subjectNameOverride?: string | null) => ({
  id: report.id,
  reportRef: `RPT-${String(report.id).slice(-8).toUpperCase()}`,
  reportType: report.reportType,
  authority: report.authority,
  status: report.status,
  state: report.status,
  subjectType: report.subjectType,
  subjectId: report.subjectId,
  amlCaseId: report.amlCaseId,
  amlCaseStatus: report.amlCase?.status ?? null,
  amlCaseSeverity: report.amlCase?.severity ?? null,
  subjectName: subjectNameOverride ?? report.amlCase?.subjectId ?? report.subjectId,
  periodStart: report.periodStart,
  periodEnd: report.periodEnd,
  submissionRef: report.submissionRef,
  payloadSha256: report.payloadSha256,
  confidential: report.confidential,
  approvalRequestId: report.approvalRequestId,
  approvalState: report.approvalRequest?.state ?? null,
  submittedAt: report.submittedAt,
  createdAt: report.createdAt,
  updatedAt: report.updatedAt,
  ageHours: approvalAgeHours(new Date(report.createdAt)),
});

router.get("/aml/reports", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["subjectId", "submissionRef", "amlCaseId"],
    in: { status: "status", reportType: "reportType" },
    equals: { authority: "authority", amlCaseId: "amlCaseId" },
    dates: {
      createdAt: { path: "createdAt" },
      submittedAt: { path: "submittedAt", fromKey: "dateFrom", toKey: "dateTo" },
      periodStart: { path: "periodStart", fromKey: "periodFrom", toKey: "periodTo" },
    },
    sortable: { reportType: "reportType", authority: "authority", status: "status", createdAt: "createdAt", submittedAt: "submittedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const [reports, total] = await Promise.all([
    client.regulatoryReport.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        amlCase: { select: { id: true, status: true, severity: true, subjectType: true, subjectId: true } },
        approvalRequest: { select: { state: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.regulatoryReport.count({ where: built.where as never }),
  ]);
  const ruleIds = reports.filter((report) => report.subjectType === "REPORTING_RULE").map((report) => report.subjectId);
  const rules = ruleIds.length === 0
    ? []
    : await client.reportingRule.findMany({
        where: { id: { in: ruleIds } },
        select: { id: true, sourceReference: true, reportType: true, status: true },
      });
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.sourceReference ?? `${rule.reportType} · ${rule.status}`]));
  response.json(listResponse(
    "reports",
    reports.map((report) => regulatoryReportRow(report as never, ruleNames.get(report.subjectId) ?? null)),
    total,
    built,
  ));
});

router.get("/aml/reports/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["subjectId", "submissionRef", "amlCaseId"],
    in: { status: "status", reportType: "reportType" },
    equals: { authority: "authority", amlCaseId: "amlCaseId" },
    dates: {
      createdAt: { path: "createdAt" },
      submittedAt: { path: "submittedAt", fromKey: "dateFrom", toKey: "dateTo" },
      periodStart: { path: "periodStart", fromKey: "periodFrom", toKey: "periodTo" },
    },
    sortable: { reportType: "reportType", authority: "authority", status: "status", createdAt: "createdAt", submittedAt: "submittedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const take = 5000;
  const [reports, total] = await Promise.all([
    client.regulatoryReport.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        amlCase: { select: { id: true, status: true, severity: true, subjectType: true, subjectId: true } },
        approvalRequest: { select: { state: true } },
      },
      take,
    }),
    client.regulatoryReport.count({ where: built.where as never }),
  ]);
  const ruleIds = reports.filter((report) => report.subjectType === "REPORTING_RULE").map((report) => report.subjectId);
  const rules = ruleIds.length === 0
    ? []
    : await client.reportingRule.findMany({
        where: { id: { in: ruleIds } },
        select: { id: true, sourceReference: true, reportType: true, status: true },
      });
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.sourceReference ?? `${rule.reportType} · ${rule.status}`]));
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_REPORTS_EXPORTED",
      entityType: "REGULATORY_REPORT",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: reports.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    reports: reports.map((report) => regulatoryReportRow(report as never, ruleNames.get(report.subjectId) ?? null)),
    total,
    exported: reports.length,
    truncated: total > reports.length,
  });
});

const buildAmlReportSummary = async () => {
  const [statusRows, typeRows, submittedThisMonth, total] = await Promise.all([
    client.regulatoryReport.groupBy({ by: ["status"], _count: { _all: true } }),
    client.regulatoryReport.groupBy({ by: ["reportType"], _count: { _all: true } }),
    client.regulatoryReport.count({
      where: {
        submittedAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      },
    }),
    client.regulatoryReport.count(),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row._count._all;
  const byType: Record<string, number> = {};
  for (const row of typeRows) byType[row.reportType] = row._count._all;
  return {
    total,
    byStatus,
    byType,
    submittedThisMonth,
    pendingChecker: byStatus.PENDING_CHECKER ?? 0,
    drafts: byStatus.DRAFT ?? 0,
    acknowledged: byStatus.ACKNOWLEDGED ?? 0,
    rejected: byStatus.REJECTED_BY_AUTHORITY ?? 0,
  };
};

router.get("/aml/reports/summary", async (request: Request, response: Response) => {
  assertConfidential(request);
  response.json(await buildAmlReportSummary());
});

router.get("/aml/reports/summary/export", async (request: Request, response: Response) => {
  assertConfidential(request);
  const summary = await buildAmlReportSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AML_REPORT_SUMMARY_EXPORTED",
      entityType: "REGULATORY_REPORT",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: summary.total,
        submittedThisMonth: summary.submittedThisMonth,
        pendingChecker: summary.pendingChecker,
        drafts: summary.drafts,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/aml/reports/:id", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const report = await client.regulatoryReport.findUnique({
    where: { id },
    include: {
      amlCase: { select: { id: true, status: true, severity: true, subjectType: true, subjectId: true, triggerReason: true } },
      approvalRequest: { select: { id: true, state: true, makerUserId: true, checkerUserId: true, rejectionReason: true, createdAt: true } },
    },
  });
  if (!report) throw new ApiError(404, "REGULATORY_REPORT_NOT_FOUND", "The regulatory report does not exist");
  const subjectRule = report.subjectType === "REPORTING_RULE"
    ? await client.reportingRule.findUnique({ where: { id: report.subjectId }, select: { sourceReference: true, reportType: true, status: true } })
    : null;
  response.json({
    report: {
      ...regulatoryReportRow(report as never, subjectRule ? subjectRule.sourceReference ?? `${subjectRule.reportType} · ${subjectRule.status}` : null),
      approval: report.approvalRequest ? {
        id: report.approvalRequest.id,
        state: report.approvalRequest.state,
        makerUserId: report.approvalRequest.makerUserId,
        checkerUserId: report.approvalRequest.checkerUserId,
        rejectionReason: report.approvalRequest.rejectionReason,
        createdAt: report.approvalRequest.createdAt,
      } : null,
      amlCase: report.amlCase,
    },
  });
});

router.post("/aml/reports", async (request: Request, response: Response) => {
  assertConfidential(request);
  const body = parseOrThrow(
    z
      .object({
        reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]),
        authority: z.string().min(2).max(64).default("CBL"),
        subjectType: z.string().min(2).max(40),
        subjectId: z.string().min(1).max(64),
        amlCaseId: z.string().min(1).max(64).optional(),
        payload: z.record(z.string().max(64), z.unknown()),
        checklist: z.array(z.enum([
          "REPORTING_RULE_VERIFIED",
          "PERIOD_VERIFIED",
          "CASE_LINKAGE_VERIFIED",
          "NOTES_REVIEWED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const created = await createRegulatoryReportViaApproval(
    client,
    {
      reportType: body.reportType,
      authority: body.authority,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      amlCaseId: body.amlCaseId ?? null,
      payload: body.payload,
      checklist: body.checklist ?? [],
    },
    { userId: actor.userId, role: actor.role },
  );
  response.status(201).json(created);
});

router.post("/aml/reports/:id/submit", async (request: Request, response: Response) => {
  assertReportingAuthority(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        submissionRef: z.string().min(1).max(200),
        submittedAt: z.string().max(64).optional(),
        checklist: z.array(z.enum([
          "REPORT_APPROVED_VERIFIED",
          "AUTHORITY_REFERENCE_VERIFIED",
          "DEADLINE_VERIFIED",
          "PAYLOAD_DIGEST_VERIFIED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const submittedAt = body.submittedAt ? new Date(body.submittedAt) : null;
  if (submittedAt && Number.isNaN(submittedAt.getTime())) {
    throw new ApiError(400, "INVALID_SUBMITTED_AT", "The submission time is not a valid date");
  }
  const report = await submitRegulatoryReport(client, {
    reportId: id,
    submissionRef: body.submissionRef,
    submittedAt,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "REGULATORY_REPORT_SUBMISSION_CHECKLIST",
      entityType: "REGULATORY_REPORT",
      entityId: id,
      beforeJson: {},
      afterJson: { submissionRef: body.submissionRef, checklist: body.checklist ?? [] },
    },
  });
  response.json(report);
});

router.post("/aml/reports/:id/acknowledge", async (request: Request, response: Response) => {
  assertReportingAuthority(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        status: z.enum(["ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"]).optional(),
        outcome: z.enum(["ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"]).optional(),
        decision: z.enum(["ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"]).optional(),
        accepted: z.boolean().optional(),
        acknowledged: z.boolean().optional(),
        rejected: z.boolean().optional(),
        reason: z.string().max(2000).optional(),
        rejectionReason: z.string().max(2000).optional(),
        checklist: z.array(z.enum([
          "AUTHORITY_RESPONSE_VERIFIED",
          "DECISION_RECORDED",
          "REJECTION_REASON_DOCUMENTED",
          "REPORT_CLOSURE_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const actor = actorFromRequest(request);
  const explicit = body.status ?? body.outcome ?? body.decision;
  const reason = body.reason ?? body.rejectionReason ?? null;
  const implicitRejection = body.accepted === false
    || body.rejected === true
    || (body.acknowledged !== true && body.accepted !== true && reason !== null);
  const status = explicit ?? (implicitRejection ? "REJECTED_BY_AUTHORITY" : "ACKNOWLEDGED");
  const report = await acknowledgeRegulatoryReport(client, {
    reportId: id,
    status,
    reason,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "REGULATORY_REPORT_ACKNOWLEDGEMENT_CHECKLIST",
      entityType: "REGULATORY_REPORT",
      entityId: id,
      beforeJson: {},
      afterJson: { status, reason, checklist: body.checklist ?? [] },
    },
  });
  response.json(report);
});

/* --------------------------------------------------------------- operator cases */

const operatorCaseListInclude = {
  attempt: {
    select: {
      id: true,
      reference: true,
      status: true,
      substatus: true,
      requestedAmount: true,
      totalChargedAmount: true,
      settledAmount: true,
      currency: true,
      providerReference: true,
      gatewayReference: true,
      createdAt: true,
      terminalAt: true,
      merchant: {
        select: {
          id: true,
          tradeName: true,
          legalName: true,
          status: true,
          riskTier: true,
        },
      },
      rail: { select: { id: true, code: true, nameEn: true } },
      route: {
        select: {
          id: true,
          gateway: { select: { id: true, code: true, name: true } },
        },
      },
      gatewayVersion: {
        select: {
          id: true,
          versionNumber: true,
          state: true,
          setting: { select: { supportsStatusCheck: true } },
        },
      },
      link: {
        select: {
          id: true,
          key: true,
          state: true,
          useCount: true,
          confirmedCount: true,
          activeLockedCount: true,
          infiniteUse: true,
        },
      },
    },
  },
  assignee: { select: { id: true, email: true, role: true } },
  approvalRequest: { select: { id: true, state: true, subjectType: true, createdAt: true } },
  reconciliationItem: {
    select: {
      id: true,
      result: true,
      ourReference: true,
      providerReference: true,
      statementAmount: true,
      statementFee: true,
      runId: true,
    },
  },
  inquirySchedules: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      source: true,
      nextRunAt: true,
      lastRunAt: true,
      attempts: true,
      lastResult: true,
      lastError: true,
      createdAt: true,
      completedAt: true,
      cancelledAt: true,
    },
  },
} as const;

const operatorCaseDetailInclude = {
  ...operatorCaseListInclude,
  inquirySchedules: {
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      scheduledBy: { select: { id: true, email: true, role: true } },
      cancelledBy: { select: { id: true, email: true, role: true } },
    },
  },
  approvalRequest: {
    include: {
      maker: { select: { id: true, email: true, role: true } },
      checker: { select: { id: true, email: true, role: true } },
    },
  },
  reconciliationItem: {
    include: {
      run: {
        include: {
          statementSource: {
            include: {
              gateway: { select: { id: true, code: true, name: true } },
            },
          },
        },
      },
    },
  },
  attempt: {
    select: {
      id: true,
      reference: true,
      createdAt: true,
      updatedAt: true,
      linkId: true,
      attemptGroupId: true,
      applicationId: true,
      merchantId: true,
      railId: true,
      routeId: true,
      credentialSetId: true,
      gatewayVersionId: true,
      commissionProfileId: true,
      env: true,
      mode: true,
      subMode: true,
      status: true,
      substatus: true,
      gatewayReference: true,
      providerReference: true,
      networkReference: true,
      requestedAmount: true,
      surchargeAmount: true,
      totalChargedAmount: true,
      settledAmount: true,
      gatewayFeeAmount: true,
      platformCommissionAmount: true,
      netMerchantAmount: true,
      feeBearer: true,
      settlementTarget: true,
      currency: true,
      pointOfNoReturn: true,
      expiresAt: true,
      graceExpiresAt: true,
      nextCheckAt: true,
      ledgerEntryId: true,
      terminalAt: true,
      merchant: {
        select: {
          id: true,
          tradeName: true,
          legalName: true,
          status: true,
          kybStatus: true,
          riskTier: true,
          contactEmail: true,
          contactPhone: true,
          country: true,
        },
      },
      application: {
        select: {
          id: true,
          name: true,
          status: true,
          assignedWalletId: true,
          expectedMonthlyVolume: true,
        },
      },
      rail: {
        select: {
          id: true,
          code: true,
          nameEn: true,
          nameAr: true,
          collectionMode: true,
          currency: true,
        },
      },
      route: {
        select: {
          id: true,
          status: true,
          healthState: true,
          gateway: {
            select: { id: true, code: true, name: true, kind: true, status: true },
          },
        },
      },
      gatewayVersion: {
        select: {
          id: true,
          versionNumber: true,
          state: true,
          gatewayId: true,
          setting: {
            select: {
              id: true,
              supportsStatusCheck: true,
              timeoutMs: true,
              statusCheckMinAgeSeconds: true,
            },
          },
        },
      },
      link: {
        select: {
          id: true,
          key: true,
          applicationId: true,
          walletId: true,
          amount: true,
          currency: true,
          feeBearer: true,
          infiniteUse: true,
          useCount: true,
          confirmedCount: true,
          activeLockedCount: true,
          state: true,
          expiresAt: true,
          createdAt: true,
        },
      },
      stepLogs: {
        orderBy: { createdAt: "asc" as const },
        take: 200,
        select: {
          id: true,
          createdAt: true,
          gatewayVersionId: true,
          phase: true,
          stepId: true,
          stepOrder: true,
          redactedRequestJson: true,
          redactedResponseText: true,
          httpStatus: true,
          durationMs: true,
          outcome: true,
        },
      },
      inboundEvents: {
        orderBy: { receivedAt: "desc" as const },
        take: 100,
        select: {
          id: true,
          channelId: true,
          gatewayId: true,
          env: true,
          rawBodyBytes: true,
          redactedHeadersJson: true,
          sourceIp: true,
          verified: true,
          verificationError: true,
          dedupeKey: true,
          attemptId: true,
          receivedAt: true,
          processedAt: true,
          processingResult: true,
        },
      },
      adjustments: {
        orderBy: { createdAt: "desc" as const },
        select: {
          id: true,
          createdAt: true,
          type: true,
          targetGlAccountId: true,
          sourceAttemptId: true,
          disputeId: true,
          draftedBySystem: true,
          amount: true,
          reverseCommission: true,
          reason: true,
          externalDisputeRef: true,
          providerRefundRef: true,
          state: true,
          journalEntryId: true,
        },
      },
      disputes: {
        orderBy: { openedAt: "desc" as const },
        select: {
          id: true,
          attemptId: true,
          gatewayId: true,
          railId: true,
          externalDisputeRef: true,
          source: true,
          reasonCode: true,
          amount: true,
          currency: true,
          status: true,
          openedAt: true,
          evidenceDueAt: true,
          outcomeAt: true,
          adjustmentId: true,
        },
      },
      reconciliationItems: {
        orderBy: { createdAt: "desc" as const },
        take: 50,
        select: {
          id: true,
          runId: true,
          attemptId: true,
          ourReference: true,
          providerReference: true,
          batchReference: true,
          statementAmount: true,
          statementFee: true,
          result: true,
          operatorCaseId: true,
          createdAt: true,
        },
      },
    },
  },
} as const;

const operatorCaseReference = (entry: {
  id: string;
  attempt?: { reference?: string | null } | null;
  reconciliationItem?: { ourReference?: string | null; providerReference?: string | null } | null;
}): { value: string; source: string } => {
  if (entry.attempt?.reference) {
    return { value: entry.attempt.reference, source: "ATTEMPT_REFERENCE" };
  }
  if (entry.reconciliationItem?.ourReference) {
    return { value: entry.reconciliationItem.ourReference, source: "RECONCILIATION_OUR_REFERENCE" };
  }
  if (entry.reconciliationItem?.providerReference) {
    return { value: entry.reconciliationItem.providerReference, source: "RECONCILIATION_PROVIDER_REFERENCE" };
  }
  return { value: entry.id, source: "CASE_ID" };
};

const bytesPreview = (value: unknown, limit = 64 * 1024): string => {
  if (!value) return "";
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8").slice(0, limit);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8").slice(0, limit);
  }
  if (Array.isArray(value)) {
    return Buffer.from(Uint8Array.from(value as number[])).toString("utf8").slice(0, limit);
  }
  return String(value).slice(0, limit);
};

const flattenOperatorCase = (entry: any): Record<string, unknown> => {
  const attempt = entry?.attempt ?? null;
  const item = entry?.reconciliationItem ?? null;
  const reference = operatorCaseReference(entry);
  const supportsStatusCheck = attempt?.gatewayVersion?.setting?.supportsStatusCheck === true;
  const eligibility = operatorCaseInquiryEligibility({
    caseState: entry?.state,
    attemptStatus: attempt?.status,
    terminalAt: attempt?.terminalAt,
    supportsStatusCheck,
  });
  const link = attempt?.link ?? null;
  return {
    ...entry,
    caseId: entry.id,
    caseRef: reference.value,
    caseReferenceSource: reference.source,
    caseType: entry.kind,
    openedAt: entry.createdAt,
    merchantId: attempt?.merchant?.id ?? null,
    merchantTradeName: attempt?.merchant?.tradeName ?? "",
    merchantLegalName: attempt?.merchant?.legalName ?? "",
    merchantName: attempt?.merchant?.tradeName || attempt?.merchant?.legalName || "",
    merchantStatus: attempt?.merchant?.status ?? null,
    merchantRiskTier: attempt?.merchant?.riskTier ?? null,
    applicationId: attempt?.applicationId ?? null,
    railId: attempt?.rail?.id ?? null,
    railCode: attempt?.rail?.code ?? "",
    railNameEn: attempt?.rail?.nameEn ?? "",
    gatewayId: attempt?.route?.gateway?.id ?? null,
    gatewayCode: attempt?.route?.gateway?.code ?? "",
    gatewayName: attempt?.route?.gateway?.name ?? "",
    routeId: attempt?.route?.id ?? null,
    attemptId: entry.attemptId,
    attemptReference: attempt?.reference ?? null,
    attemptStatus: attempt?.status ?? null,
    attemptSubstatus: attempt?.substatus ?? null,
    requestedAmount: attempt?.requestedAmount ?? null,
    chargedAmount: attempt?.totalChargedAmount ?? null,
    settledAmount: attempt?.settledAmount ?? null,
    statementAmount: item?.statementAmount ?? null,
    statementFee: item?.statementFee ?? null,
    currency: attempt?.currency ?? null,
    providerReference: attempt?.providerReference ?? item?.providerReference ?? null,
    gatewayReference: attempt?.gatewayReference ?? null,
    linkSlot: link
      ? {
          id: link.id,
          key: link.key,
          state: link.state,
          useCount: link.useCount,
          confirmedCount: link.confirmedCount,
          activeLockedCount: link.activeLockedCount,
          infiniteUse: link.infiniteUse,
        }
      : null,
    reconciliationItemId: entry.reconciliationItemId,
    reconciliationResult: item?.result ?? null,
    approvalRequestId: entry.approvalRequestId,
    approvalState: entry.approvalRequest?.state ?? null,
    assigneeUserId: entry.assigneeUserId,
    assigneeEmail: entry.assignee?.email ?? null,
    gatewaySupportsStatusCheck: supportsStatusCheck,
    inquiryEligibility: eligibility,
    latestInquirySchedule: entry?.inquirySchedules?.[0] ?? null,
  };
};

const gatewayInquiryListInclude = {
  operatorCase: {
    select: {
      id: true,
      state: true,
      priority: true,
      kind: true,
      slaDueAt: true,
      attempt: { select: { reference: true } },
      reconciliationItem: { select: { ourReference: true, providerReference: true } },
    },
  },
  scheduledBy: { select: { id: true, email: true, role: true } },
  cancelledBy: { select: { id: true, email: true, role: true } },
  attempt: {
    select: {
      id: true,
      reference: true,
      status: true,
      substatus: true,
      terminalAt: true,
      nextCheckAt: true,
      createdAt: true,
      totalChargedAmount: true,
      currency: true,
      providerReference: true,
      merchant: { select: { id: true, tradeName: true, legalName: true } },
      rail: { select: { id: true, code: true, nameEn: true } },
      route: {
        select: {
          id: true,
          gateway: { select: { id: true, code: true, name: true } },
        },
      },
      gatewayVersion: {
        select: {
          id: true,
          versionNumber: true,
          setting: { select: { supportsStatusCheck: true } },
        },
      },
    },
  },
} as const;

const gatewayInquiryDetailInclude = {
  ...gatewayInquiryListInclude,
} as const;

const flattenGatewayInquiry = (entry: any): Record<string, unknown> => {
  const attempt = entry?.attempt ?? null;
  const operatorCase = entry?.operatorCase ?? null;
  const gateway = attempt?.route?.gateway ?? null;
  const now = Date.now();
  const active = ["SCHEDULED", "RUNNING", "RETRYING"].includes(String(entry.status ?? ""));
  const nextRunAt = entry.nextRunAt ?? null;
  const attemptTerminal = Boolean(attempt?.terminalAt)
    || ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"].includes(String(attempt?.status ?? ""));
  return {
    id: entry.id,
    status: entry.status,
    source: entry.source,
    operatorCaseId: entry.operatorCaseId ?? null,
    caseRef: operatorCase?.attempt?.reference
      ?? operatorCase?.reconciliationItem?.ourReference
      ?? operatorCase?.reconciliationItem?.providerReference
      ?? entry.operatorCaseId
      ?? null,
    caseState: operatorCase?.state ?? null,
    casePriority: operatorCase?.priority ?? null,
    caseType: operatorCase?.kind ?? null,
    attemptId: entry.attemptId,
    attemptReference: attempt?.reference ?? null,
    attemptStatus: attempt?.status ?? null,
    attemptSubstatus: attempt?.substatus ?? null,
    attemptTerminal,
    merchantId: attempt?.merchant?.id ?? null,
    merchantName: attempt?.merchant?.tradeName || attempt?.merchant?.legalName || "",
    railCode: attempt?.rail?.code ?? null,
    railName: attempt?.rail?.nameEn ?? null,
    gatewayId: gateway?.id ?? null,
    gatewayCode: gateway?.code ?? null,
    gatewayName: gateway?.name ?? null,
    gatewaySupportsStatusCheck: attempt?.gatewayVersion?.setting?.supportsStatusCheck === true,
    amount: attempt?.totalChargedAmount ?? null,
    currency: attempt?.currency ?? null,
    providerReference: attempt?.providerReference ?? null,
    scheduledByEmail: entry.scheduledBy?.email ?? null,
    scheduledAt: entry.createdAt,
    previousNextCheckAt: entry.previousNextCheckAt ?? null,
    windowStartedAt: entry.windowStartedAt ?? null,
    nextRunAt,
    lastRunAt: entry.lastRunAt ?? null,
    attempts: entry.attempts ?? 0,
    lastResult: entry.lastResult ?? null,
    lastError: entry.lastError ?? null,
    completedAt: entry.completedAt ?? null,
    cancelledAt: entry.cancelledAt ?? null,
    cancelledByEmail: entry.cancelledBy?.email ?? null,
    cancelReason: entry.cancelReason ?? null,
    isOverdue: active && nextRunAt !== null && new Date(nextRunAt).getTime() <= now,
    canCancel: ["SCHEDULED", "RETRYING"].includes(String(entry.status ?? "")) && !attemptTerminal,
    canRunNow: ["SCHEDULED", "RETRYING"].includes(String(entry.status ?? "")) && !attemptTerminal,
    canRetry: ["FAILED", "EXPIRED", "CANCELLED"].includes(String(entry.status ?? "")) && !attemptTerminal,
  };
};

const writeGatewayInquiryAudit = async (
  target: typeof client,
  input: {
    actor: { userId: string; role: string | null };
    scheduleId: string;
    action: string;
    beforeJson?: unknown;
    afterJson?: unknown;
  },
) => {
  await writeAudit(target, {
    data: {
      actorId: input.actor.userId,
      role: input.actor.role ?? "OPERATOR",
      action: input.action,
      entityType: "GATEWAY_INQUIRY",
      entityId: input.scheduleId,
      beforeJson: (input.beforeJson ?? {}) as never,
      afterJson: (input.afterJson ?? {}) as never,
    },
  });
};

const scheduleOperatorCaseInquiry = async (
  target: typeof client,
  operatorCase: any,
  actor: { userId: string; role: string | null },
  input: { reason?: string; checklist?: string[] } = {},
): Promise<{ status: "SCHEDULED" | "SKIPPED"; reason?: string; scheduleId?: string }> => {
  const attempt = operatorCase.attempt;
  const supportsStatusCheck = attempt?.gatewayVersion?.setting?.supportsStatusCheck === true;
  const eligibility = operatorCaseInquiryEligibility({
    caseState: operatorCase.state,
    attemptStatus: attempt?.status,
    terminalAt: attempt?.terminalAt,
    supportsStatusCheck,
  });
  if (!eligibility.eligible) {
    return { status: "SKIPPED", reason: eligibility.reason };
  }
  const existing = await target.gatewayInquirySchedule.findFirst({
    where: {
      attemptId: operatorCase.attemptId,
      status: { in: ["SCHEDULED", "RUNNING", "RETRYING"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.status === "RUNNING") {
    throw new ApiError(409, "INQUIRY_ALREADY_RUNNING", "An inquiry is already running for this attempt");
  }
  const nextCheckAt = new Date(Date.now() + 1000);
  const previousNextCheckAt = attempt?.nextCheckAt ?? null;
  let scheduleId = existing?.id ?? "";
  await target.$transaction(async (tx) => {
    const updated = await tx.paymentAttempt.updateMany({
      where: {
        id: operatorCase.attemptId,
        terminalAt: null,
        status: { in: ["UNKNOWN", "VERIFYING"] },
      },
      data: { status: "VERIFYING", nextCheckAt },
    });
    if (updated.count === 0) {
      throw new ApiError(
        409,
        "ATTEMPT_NOT_INQUIRABLE",
        "The payment attempt changed state before the inquiry could be scheduled",
      );
    }
    await tx.operatorCase.updateMany({
      where: { id: operatorCase.id, state: { in: ["OPEN", "IN_PROGRESS"] } },
      data: { state: "IN_PROGRESS" },
    });
    if (existing) {
      await tx.gatewayInquirySchedule.update({
        where: { id: existing.id },
        data: {
          operatorCaseId: operatorCase.id,
          status: "SCHEDULED",
          scheduledByUserId: actor.userId,
          reason: input.reason ?? existing.reason ?? null,
          checklist: input.checklist ?? existing.checklist ?? undefined,
          windowStartedAt: nextCheckAt,
          nextRunAt: nextCheckAt,
          lastError: null,
        },
      });
      scheduleId = existing.id;
    } else {
      const created = await tx.gatewayInquirySchedule.create({
        data: {
          attemptId: operatorCase.attemptId,
          operatorCaseId: operatorCase.id,
          source: "OPERATOR_CASE",
          status: "SCHEDULED",
          scheduledByUserId: actor.userId,
          reason: input.reason ?? null,
          checklist: input.checklist ?? undefined,
          previousNextCheckAt,
          windowStartedAt: nextCheckAt,
          nextRunAt: nextCheckAt,
        },
      });
      scheduleId = created.id;
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "OPERATOR",
        action: "OPERATOR_CASE_INQUIRY_SCHEDULED",
        entityType: "OPERATOR_CASE",
        entityId: operatorCase.id,
        beforeJson: { state: operatorCase.state },
        afterJson: {
          state: "IN_PROGRESS",
          attemptId: operatorCase.attemptId,
          scheduleId,
          nextCheckAt: nextCheckAt.toISOString(),
        },
      },
    });
  });
  return { status: "SCHEDULED", scheduleId };
};

router.get("/operator-cases", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const built = buildListQuery(request.query, {
    search: [
      "id",
      "attempt.reference",
      "attempt.providerReference",
      "attempt.merchant.tradeName",
      "attempt.merchant.legalName",
      "reconciliationItem.ourReference",
      "reconciliationItem.providerReference",
    ],
    contains: {
      caseRef: ["id", "attempt.reference", "reconciliationItem.ourReference", "reconciliationItem.providerReference"],
      merchantName: ["attempt.merchant.tradeName", "attempt.merchant.legalName"],
      providerReference: ["attempt.providerReference", "reconciliationItem.providerReference"],
    },
    in: { state: "state", kind: "kind", priority: "priority" },
    equals: { assigneeUserId: "assigneeUserId" },
    dates: {
      createdAt: { path: "createdAt" },
      slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" },
    },
    sortable: {
      priority: "priority",
      state: "state",
      kind: "kind",
      openedAt: "createdAt",
      slaDueAt: "slaDueAt",
      caseRef: "attempt.reference",
      merchantName: "attempt.merchant.tradeName",
    },
    defaultSort: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  const [cases, total] = await Promise.all([
    client.operatorCase.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: operatorCaseListInclude,
      skip: built.skip,
      take: built.take,
    }),
    client.operatorCase.count({ where: built.where as never }),
  ]);
  response.json(listResponse("cases", cases.map(flattenOperatorCase), total, built));
});

router.get("/operator-cases/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const built = buildListQuery(request.query, {
    search: [
      "id",
      "attempt.reference",
      "attempt.providerReference",
      "attempt.merchant.tradeName",
      "attempt.merchant.legalName",
      "reconciliationItem.ourReference",
      "reconciliationItem.providerReference",
    ],
    contains: {
      caseRef: ["id", "attempt.reference", "reconciliationItem.ourReference", "reconciliationItem.providerReference"],
      merchantName: ["attempt.merchant.tradeName", "attempt.merchant.legalName"],
      providerReference: ["attempt.providerReference", "reconciliationItem.providerReference"],
    },
    in: { state: "state", kind: "kind", priority: "priority" },
    equals: { assigneeUserId: "assigneeUserId" },
    dates: {
      createdAt: { path: "createdAt" },
      slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" },
    },
    sortable: {
      priority: "priority",
      state: "state",
      kind: "kind",
      openedAt: "createdAt",
      slaDueAt: "slaDueAt",
      caseRef: "attempt.reference",
      merchantName: "attempt.merchant.tradeName",
    },
    defaultSort: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  const take = 5000;
  const [cases, total] = await Promise.all([
    client.operatorCase.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: operatorCaseListInclude,
      take,
    }),
    client.operatorCase.count({ where: built.where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "OPERATOR_CASES_EXPORTED",
      entityType: "OPERATOR_CASE",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: cases.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    cases: cases.map((entry) => {
      const row = flattenOperatorCase(entry);
      const eligibility = row.inquiryEligibility as { eligible?: boolean; reason?: string } | null | undefined;
      return {
        id: row.id,
        caseRef: row.caseRef,
        caseType: row.caseType,
        priority: row.priority,
        state: row.state,
        merchantName: row.merchantName,
        merchantStatus: row.merchantStatus,
        railCode: row.railCode,
        railName: row.railNameEn,
        gatewayCode: row.gatewayCode,
        gatewayName: row.gatewayName,
        attemptReference: row.attemptReference,
        attemptStatus: row.attemptStatus,
        amount: row.chargedAmount ?? row.statementAmount ?? null,
        currency: row.currency,
        providerReference: row.providerReference,
        reconciliationResult: row.reconciliationResult,
        approvalState: row.approvalState,
        assigneeEmail: row.assigneeEmail,
        openedAt: row.openedAt,
        slaDueAt: row.slaDueAt,
        inquiryEligible: eligibility?.eligible === true,
        inquiryReason: eligibility?.reason ?? null,
        resolutionNotes: row.resolutionNotes ?? null,
      };
    }),
    total,
    exported: cases.length,
    truncated: total > cases.length,
  });
});

const buildOperatorCaseSummary = async () => {
  const cases = await client.operatorCase.findMany({
    select: { state: true, priority: true, slaDueAt: true, assigneeUserId: true },
  });
  const now = new Date();
  const byState: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let overdue = 0;
  let unassigned = 0;
  let pendingChecker = 0;
  for (const item of cases) {
    byState[item.state] = (byState[item.state] ?? 0) + 1;
    byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
    if (!item.assigneeUserId) unassigned += 1;
    if (item.state === "PENDING_CHECKER") pendingChecker += 1;
    if (item.state !== "RESOLVED" && item.slaDueAt.getTime() < now.getTime()) overdue += 1;
  }
  return {
    summary: {
      total: cases.length,
      open: byState.OPEN ?? 0,
      inProgress: byState.IN_PROGRESS ?? 0,
      pendingChecker,
      resolved: byState.RESOLVED ?? 0,
      unassigned,
      overdue,
      p1Open: cases.filter((item) => item.priority === "P1" && item.state !== "RESOLVED").length,
      byState,
      byPriority,
    },
  };
};

router.get("/operator-cases/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  response.json(await buildOperatorCaseSummary());
});

router.get("/operator-cases/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const snapshot = await buildOperatorCaseSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "OPEN_SCOPE_VERIFIED",
    "SLA_REVIEWED",
    "PRIORITY_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "OPERATOR_CASE_SUMMARY_EXPORTED",
      entityType: "OPERATOR_CASE",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: snapshot.summary.total,
        overdue: snapshot.summary.overdue,
        unassigned: snapshot.summary.unassigned,
        p1Open: snapshot.summary.p1Open,
        checklist,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.get("/gateway-inquiries", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const built = buildListQuery(request.query, {
    search: [
      "id",
      "attempt.reference",
      "attempt.providerReference",
      "attempt.merchant.tradeName",
      "attempt.merchant.legalName",
      "operatorCaseId",
    ],
    contains: {
      attemptReference: "attempt.reference",
      merchantName: ["attempt.merchant.tradeName", "attempt.merchant.legalName"],
      providerReference: "attempt.providerReference",
    },
    in: { status: "status", source: "source" },
    equals: {
      attemptId: "attemptId",
      operatorCaseId: "operatorCaseId",
      gatewayId: "attempt.route.gateway.id",
    },
    dates: {
      createdAt: { path: "createdAt" },
      nextRunAt: { path: "nextRunAt", fromKey: "nextRunFrom", toKey: "nextRunTo" },
    },
    sortable: {
      status: "status",
      source: "source",
      scheduledAt: "createdAt",
      nextRunAt: "nextRunAt",
      lastRunAt: "lastRunAt",
      attempts: "attempts",
    },
    defaultSort: [{ status: "asc" }, { createdAt: "desc" }],
  });
  const [schedules, total] = await Promise.all([
    client.gatewayInquirySchedule.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: gatewayInquiryListInclude,
      skip: built.skip,
      take: built.take,
    }),
    client.gatewayInquirySchedule.count({ where: built.where as never }),
  ]);
  response.json(listResponse("schedules", schedules.map(flattenGatewayInquiry), total, built));
});

router.get("/gateway-inquiries/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const now = new Date();
  const grouped = await client.gatewayInquirySchedule.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = {};
  for (const row of grouped) {
    byStatus[row.status] = row._count._all;
  }
  const overdue = await client.gatewayInquirySchedule.count({
    where: {
      status: { in: ["SCHEDULED", "RETRYING"] },
      nextRunAt: { lte: now },
    },
  });
  response.json({
    summary: {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      scheduled: byStatus.SCHEDULED ?? 0,
      running: byStatus.RUNNING ?? 0,
      retrying: byStatus.RETRYING ?? 0,
      completed: byStatus.COMPLETED ?? 0,
      failed: byStatus.FAILED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      expired: byStatus.EXPIRED ?? 0,
      overdue,
      byStatus,
    },
  });
});

router.get("/gateway-inquiries/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const schedule = await client.gatewayInquirySchedule.findUnique({
    where: { id },
    include: gatewayInquiryDetailInclude,
  });
  if (!schedule) {
    throw new ApiError(404, "GATEWAY_INQUIRY_NOT_FOUND", "The gateway inquiry schedule does not exist");
  }
  const auditTrail = await client.auditLog.findMany({
    where: { entityType: "GATEWAY_INQUIRY", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { id: true, email: true, role: true } } },
  });
  response.json({ schedule: flattenGatewayInquiry(schedule), auditTrail });
});

router.post("/gateway-inquiries/:id/cancel", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:inquire", "case:write", "operator:write"]);
  const actor = actorFromRequest(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reason: z.string().trim().min(3).max(500),
      checklist: z.array(z.string().min(1).max(64)).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  const schedule = await client.gatewayInquirySchedule.findUnique({
    where: { id },
    include: { attempt: { select: { id: true, status: true, terminalAt: true } } },
  });
  if (!schedule) {
    throw new ApiError(404, "GATEWAY_INQUIRY_NOT_FOUND", "The gateway inquiry schedule does not exist");
  }
  if (!["SCHEDULED", "RETRYING"].includes(schedule.status)) {
    throw new ApiError(409, "INQUIRY_NOT_CANCELLABLE", "Only a scheduled or retrying inquiry can be cancelled");
  }
  const now = new Date();
  await client.$transaction(async (tx) => {
    const updated = await tx.gatewayInquirySchedule.updateMany({
      where: { id, status: { in: ["SCHEDULED", "RETRYING"] } },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: actor.userId,
        cancelReason: body.reason,
      },
    });
    if (updated.count === 0) {
      throw new ApiError(409, "INQUIRY_NOT_CANCELLABLE", "The inquiry changed state before it could be cancelled");
    }
    if (!schedule.attempt.terminalAt && ["UNKNOWN", "VERIFYING"].includes(String(schedule.attempt.status))) {
      await tx.paymentAttempt.updateMany({
        where: { id: schedule.attemptId, terminalAt: null },
        data: { nextCheckAt: schedule.previousNextCheckAt },
      });
    }
  });
  await writeGatewayInquiryAudit(client, {
    actor,
    scheduleId: id,
    action: "GATEWAY_INQUIRY_CANCELLED",
    beforeJson: { status: schedule.status, nextRunAt: schedule.nextRunAt },
    afterJson: { status: "CANCELLED", reason: body.reason, checklist: body.checklist ?? [] },
  });
  const updated = await client.gatewayInquirySchedule.findUnique({ where: { id }, include: gatewayInquiryDetailInclude });
  response.json({ schedule: updated ? flattenGatewayInquiry(updated) : null });
});

router.post("/gateway-inquiries/:id/run-now", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:inquire", "case:write", "operator:write"]);
  const actor = actorFromRequest(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reason: z.string().trim().max(500).optional(),
      checklist: z.array(z.string().min(1).max(64)).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  const schedule = await client.gatewayInquirySchedule.findUnique({
    where: { id },
    include: { attempt: { select: { id: true, status: true, terminalAt: true } } },
  });
  if (!schedule) {
    throw new ApiError(404, "GATEWAY_INQUIRY_NOT_FOUND", "The gateway inquiry schedule does not exist");
  }
  if (!["SCHEDULED", "RETRYING"].includes(schedule.status)) {
    throw new ApiError(409, "INQUIRY_NOT_RUNNABLE", "Only a scheduled or retrying inquiry can run now");
  }
  if (schedule.attempt.terminalAt || !["UNKNOWN", "VERIFYING"].includes(String(schedule.attempt.status))) {
    throw new ApiError(409, "ATTEMPT_NOT_INQUIRABLE", "The payment attempt is no longer inquirable");
  }
  const now = new Date();
  await client.$transaction(async (tx) => {
    await tx.gatewayInquirySchedule.update({
      where: { id },
      data: { status: "SCHEDULED", windowStartedAt: now, nextRunAt: now, lastError: null },
    });
    await tx.paymentAttempt.update({
      where: { id: schedule.attemptId },
      data: { status: "VERIFYING", nextCheckAt: now },
    });
  });
  await writeGatewayInquiryAudit(client, {
    actor,
    scheduleId: id,
    action: "GATEWAY_INQUIRY_RUN_NOW",
    beforeJson: { status: schedule.status, nextRunAt: schedule.nextRunAt },
    afterJson: { status: "SCHEDULED", nextRunAt: now.toISOString(), reason: body.reason ?? null, checklist: body.checklist ?? [] },
  });
  const updated = await client.gatewayInquirySchedule.findUnique({ where: { id }, include: gatewayInquiryDetailInclude });
  response.json({ schedule: updated ? flattenGatewayInquiry(updated) : null });
});

router.post("/gateway-inquiries/:id/retry", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:inquire", "case:write", "operator:write"]);
  const actor = actorFromRequest(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reason: z.string().trim().max(500).optional(),
      checklist: z.array(z.string().min(1).max(64)).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  const schedule = await client.gatewayInquirySchedule.findUnique({
    where: { id },
    include: { attempt: { select: { id: true, status: true, terminalAt: true } } },
  });
  if (!schedule) {
    throw new ApiError(404, "GATEWAY_INQUIRY_NOT_FOUND", "The gateway inquiry schedule does not exist");
  }
  if (!["FAILED", "EXPIRED", "CANCELLED"].includes(schedule.status)) {
    throw new ApiError(409, "INQUIRY_NOT_RETRYABLE", "Only a failed, expired or cancelled inquiry can be retried");
  }
  if (schedule.attempt.terminalAt || !["UNKNOWN", "VERIFYING"].includes(String(schedule.attempt.status))) {
    throw new ApiError(409, "ATTEMPT_NOT_INQUIRABLE", "The payment attempt is no longer inquirable");
  }
  const now = new Date();
  await client.$transaction(async (tx) => {
    await tx.gatewayInquirySchedule.update({
      where: { id },
      data: {
        status: "SCHEDULED",
        windowStartedAt: now,
        nextRunAt: now,
        attempts: 0,
        lastError: null,
        lastResult: null,
        completedAt: null,
        cancelledAt: null,
        cancelledByUserId: null,
        cancelReason: null,
      },
    });
    await tx.paymentAttempt.update({
      where: { id: schedule.attemptId },
      data: { status: "VERIFYING", nextCheckAt: now },
    });
  });
  await writeGatewayInquiryAudit(client, {
    actor,
    scheduleId: id,
    action: "GATEWAY_INQUIRY_RETRIED",
    beforeJson: { status: schedule.status, nextRunAt: schedule.nextRunAt },
    afterJson: { status: "SCHEDULED", nextRunAt: now.toISOString(), reason: body.reason ?? null, checklist: body.checklist ?? [] },
  });
  const updated = await client.gatewayInquirySchedule.findUnique({ where: { id }, include: gatewayInquiryDetailInclude });
  response.json({ schedule: updated ? flattenGatewayInquiry(updated) : null });
});

router.get("/operator-cases/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const operatorCase = await client.operatorCase.findUnique({
    where: { id },
    include: operatorCaseDetailInclude,
  });
  if (!operatorCase) {
    throw new ApiError(404, "OPERATOR_CASE_NOT_FOUND", "The operator case does not exist");
  }
  const auditTrail = await client.auditLog.findMany({
    where: { entityType: "OPERATOR_CASE", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { id: true, email: true, role: true } } },
  });
  const flattened = flattenOperatorCase(operatorCase) as Record<string, any>;
  const attempt = flattened.attempt
    ? {
        ...flattened.attempt,
        inboundEvents: (flattened.attempt.inboundEvents ?? []).map((event: any) => {
          const { rawBodyBytes, ...rest } = event;
          return { ...rest, rawBodyPreview: bytesPreview(rawBodyBytes) };
        }),
      }
    : null;
  response.json({
    operatorCase: {
      ...flattened,
      attempt,
      auditTrail,
    },
  });
});

router.post("/operator-cases/bulk-inquire", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:inquire", "case:write", "operator:write"]);
  const body = parseOrThrow(
    z
      .object({
        caseIds: z.array(z.string().min(1).max(64)).min(1).max(200),
        reason: z.string().max(500).optional(),
        checklist: z.array(z.enum([
          "ELIGIBILITY_REVIEWED",
          "ATTEMPT_STATUS_VERIFIED",
          "GATEWAY_SUPPORT_CONFIRMED",
          "INQUIRY_SCOPE_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const actor = actorFromRequest(request);
  const requestedIds = [...new Set(body.caseIds)];
  const cases = await client.operatorCase.findMany({
    where: { id: { in: requestedIds } },
    include: {
      attempt: {
        select: {
          id: true,
          reference: true,
          status: true,
          terminalAt: true,
          nextCheckAt: true,
          gatewayVersion: {
            select: { setting: { select: { supportsStatusCheck: true } } },
          },
        },
      },
      reconciliationItem: {
        select: { ourReference: true, providerReference: true },
      },
    },
  });
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const results: Array<Record<string, unknown>> = [];
  let scheduled = 0;
  let skipped = 0;
  for (const caseId of requestedIds) {
    const entry = byId.get(caseId);
    if (!entry) {
      skipped += 1;
      results.push({
        caseId,
        status: "SKIPPED",
        reason: "CASE_NOT_FOUND",
        message: operatorCaseInquirySkipMessage("CASE_NOT_FOUND"),
      });
      continue;
    }
    const ref = operatorCaseReference(entry);
    try {
      const eligibility = operatorCaseInquiryEligibility({
        caseState: entry.state,
        attemptStatus: entry.attempt?.status,
        terminalAt: entry.attempt?.terminalAt,
        supportsStatusCheck: entry.attempt?.gatewayVersion?.setting?.supportsStatusCheck === true,
      });
      if (!eligibility.eligible) {
        skipped += 1;
        results.push({
          caseId,
          caseRef: ref.value,
          attemptId: entry.attemptId,
          attemptReference: entry.attempt?.reference ?? null,
          status: "SKIPPED",
          reason: eligibility.reason,
          message: operatorCaseInquirySkipMessage(eligibility.reason),
        });
        continue;
      }
      const scheduledResult = await scheduleOperatorCaseInquiry(client, entry, actor, {
        reason: body.reason,
        checklist: body.checklist,
      });
      scheduled += 1;
      results.push({
        caseId,
        caseRef: ref.value,
        attemptId: entry.attemptId,
        attemptReference: entry.attempt?.reference ?? null,
        scheduleId: scheduledResult.scheduleId,
        status: "SCHEDULED",
        reason: "ELIGIBLE",
        message: "Gateway inquiry scheduled",
      });
    } catch (error) {
      skipped += 1;
      results.push({
        caseId,
        caseRef: ref.value,
        attemptId: entry.attemptId,
        attemptReference: entry.attempt?.reference ?? null,
        status: "SKIPPED",
        reason: error instanceof ApiError ? error.code : "INQUIRY_SCHEDULE_FAILED",
        message: error instanceof Error ? error.message : "The inquiry could not be scheduled",
      });
    }
  }
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "OPERATOR",
      action: "OPERATOR_CASE_BULK_INQUIRY",
      entityType: "OPERATOR_CASE",
      entityId: "bulk-inquiry",
      beforeJson: {},
      afterJson: { requested: requestedIds.length, scheduled, skipped, checklist: body.checklist ?? [] },
    },
  });
  response.json({
    requested: requestedIds.length,
    scheduled,
    skipped,
    results,
  });
});

router.post("/operator-cases/bulk-assign", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:write", "operator:write"]);
  const body = parseOrThrow(
    z
      .object({
        caseIds: z.array(z.string().min(1).max(64)).min(1).max(200),
        assigneeUserId: z.string().min(1).max(64).nullable(),
        reason: z.string().max(500).optional(),
        checklist: z.array(z.enum([
          "ASSIGNEE_VERIFIED",
          "WORKLOAD_REVIEWED",
          "NOTIFICATION_PLANNED",
          "CASE_SCOPE_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  if (body.assigneeUserId) {
    const user = await client.user.findUnique({
      where: { id: body.assigneeUserId },
      select: { id: true, status: true, merchantId: true },
    });
    if (!user || user.status !== "ACTIVE" || user.merchantId) {
      throw new ApiError(400, "INVALID_ASSIGNEE", "The assignee must be an active platform user");
    }
  }
  const caseIds = [...new Set(body.caseIds)];
  const cases = await client.operatorCase.findMany({
    where: { id: { in: caseIds } },
    select: { id: true, state: true, assigneeUserId: true },
  });
  const found = new Map(cases.map((entry) => [entry.id, entry]));
  const actor = actorFromRequest(request);
  const results: Array<{ caseId: string; status: "ASSIGNED" | "SKIPPED"; reason?: string }> = [];
  let assigned = 0;
  let skipped = 0;
  await client.$transaction(async (tx) => {
    for (const caseId of caseIds) {
      const current = found.get(caseId);
      if (!current) {
        skipped += 1;
        results.push({ caseId, status: "SKIPPED", reason: "OPERATOR_CASE_NOT_FOUND" });
        continue;
      }
      if (current.state === "RESOLVED" || current.state === "PENDING_CHECKER") {
        skipped += 1;
        results.push({ caseId, status: "SKIPPED", reason: "OPERATOR_CASE_NOT_EDITABLE" });
        continue;
      }
      const nextState =
        body.assigneeUserId && current.state === "OPEN" ? "IN_PROGRESS" : current.state;
      const updated = await tx.operatorCase.update({
        where: { id: caseId },
        data: {
          assigneeUserId: body.assigneeUserId,
          ...(nextState !== current.state ? { state: nextState } : {}),
        },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "OPERATOR",
          action: "OPERATOR_CASE_ASSIGNED",
          entityType: "OPERATOR_CASE",
          entityId: caseId,
          beforeJson: { state: current.state, assigneeUserId: current.assigneeUserId },
          afterJson: {
            state: updated.state,
            assigneeUserId: updated.assigneeUserId,
            reason: body.reason ?? null,
            checklist: body.checklist ?? [],
          },
        },
      });
      assigned += 1;
      results.push({ caseId, status: "ASSIGNED" });
    }
  });
  response.json({ requested: caseIds.length, assigned, skipped, results });
});

router.post("/operator-cases/bulk-state", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:write", "operator:write"]);
  const body = parseOrThrow(
    z
      .object({
        caseIds: z.array(z.string().min(1).max(64)).min(1).max(200),
        state: z.enum(["OPEN", "IN_PROGRESS"]),
        reason: z.string().max(500).optional(),
        checklist: z.array(z.enum([
          "CASE_SCOPE_CONFIRMED",
          "STATE_IMPACT_REVIEWED",
          "SLA_IMPACT_REVIEWED",
          "NOTIFICATION_PLANNED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const caseIds = [...new Set(body.caseIds)];
  const cases = await client.operatorCase.findMany({
    where: { id: { in: caseIds } },
    select: { id: true, state: true, assigneeUserId: true },
  });
  const found = new Map(cases.map((entry) => [entry.id, entry]));
  const actor = actorFromRequest(request);
  const results: Array<{ caseId: string; status: "UPDATED" | "SKIPPED"; reason?: string }> = [];
  let updated = 0;
  let skipped = 0;
  await client.$transaction(async (tx) => {
    for (const caseId of caseIds) {
      const current = found.get(caseId);
      if (!current) {
        skipped += 1;
        results.push({ caseId, status: "SKIPPED", reason: "OPERATOR_CASE_NOT_FOUND" });
        continue;
      }
      if (current.state === "RESOLVED" || current.state === "PENDING_CHECKER") {
        skipped += 1;
        results.push({ caseId, status: "SKIPPED", reason: "OPERATOR_CASE_NOT_EDITABLE" });
        continue;
      }
      if (current.state === body.state) {
        skipped += 1;
        results.push({ caseId, status: "SKIPPED", reason: "ALREADY_IN_STATE" });
        continue;
      }
      const row = await tx.operatorCase.update({
        where: { id: caseId },
        data: { state: body.state },
      });
      await writeAudit(tx, {
        data: {
          actorId: actor.userId,
          role: actor.role ?? "OPERATOR",
          action: "OPERATOR_CASE_STATE_CHANGED",
          entityType: "OPERATOR_CASE",
          entityId: caseId,
          beforeJson: { state: current.state, assigneeUserId: current.assigneeUserId },
          afterJson: {
            state: row.state,
            assigneeUserId: row.assigneeUserId,
            reason: body.reason ?? null,
            checklist: body.checklist ?? [],
          },
        },
      });
      updated += 1;
      results.push({ caseId, status: "UPDATED" });
    }
  });
  response.json({ requested: caseIds.length, updated, skipped, results });
});

router.patch("/operator-cases/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:write", "operator:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        assigneeUserId: z.string().min(1).max(64).nullable().optional(),
        state: z.enum(["OPEN", "IN_PROGRESS"]).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  if (body.assigneeUserId === undefined && body.state === undefined) {
    throw new ApiError(400, "NO_CHANGES", "At least one of assigneeUserId or state is required");
  }
  const current = await client.operatorCase.findUnique({ where: { id } });
  if (!current) {
    throw new ApiError(404, "OPERATOR_CASE_NOT_FOUND", "The operator case does not exist");
  }
  if (current.state === "RESOLVED" || current.state === "PENDING_CHECKER") {
    throw new ApiError(
      409,
      "OPERATOR_CASE_NOT_EDITABLE",
      `The case is '${current.state}' and cannot be reassigned or moved`,
    );
  }
  if (body.assigneeUserId !== undefined && body.assigneeUserId !== null) {
    const user = await client.user.findUnique({
      where: { id: body.assigneeUserId },
      select: { id: true, status: true, merchantId: true },
    });
    if (!user || user.status !== "ACTIVE" || user.merchantId) {
      throw new ApiError(400, "INVALID_ASSIGNEE", "The assignee must be an active platform user");
    }
  }
  const actor = actorFromRequest(request);
  const nextState =
    body.state ?? (body.assigneeUserId && current.state === "OPEN" ? "IN_PROGRESS" : current.state);
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.operatorCase.update({
      where: { id },
      data: {
        ...(body.assigneeUserId !== undefined ? { assigneeUserId: body.assigneeUserId } : {}),
        ...(body.state !== undefined || nextState !== current.state ? { state: nextState } : {}),
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "OPERATOR",
        action: body.assigneeUserId !== undefined ? "OPERATOR_CASE_ASSIGNED" : "OPERATOR_CASE_STATE_CHANGED",
        entityType: "OPERATOR_CASE",
        entityId: id,
        beforeJson: { state: current.state, assigneeUserId: current.assigneeUserId },
        afterJson: { state: row.state, assigneeUserId: row.assigneeUserId },
      },
    });
    return row;
  });
  response.json({
    id: updated.id,
    state: updated.state,
    assigneeUserId: updated.assigneeUserId,
  });
});

router.post("/operator-cases/:id/resolve", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:write", "operator:write", "attempt:inquire"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        action: z.enum(OPERATOR_CASE_ACTIONS),
        reason: z.string().min(3).max(500),
        notes: z.string().max(2000).optional(),
        providerReference: z.string().min(1).max(191).optional(),
        settledAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        checklist: z.array(z.enum([
          "EVIDENCE_REVIEWED",
          "ATTEMPT_STATUS_VERIFIED",
          "OUTCOME_DOCUMENTED",
          "CHECKER_REQUIREMENT_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const actor = actorFromRequest(request);
  const operatorCase = await client.operatorCase.findUnique({
    where: { id },
    include: {
      attempt: { select: { id: true, reference: true, status: true, terminalAt: true } },
      reconciliationItem: { select: { ourReference: true, providerReference: true } },
    },
  });
  if (!operatorCase) {
    throw new ApiError(404, "OPERATOR_CASE_NOT_FOUND", "The operator case does not exist");
  }
  if (operatorCase.state === "RESOLVED") {
    throw new ApiError(409, "OPERATOR_CASE_ALREADY_RESOLVED", "The operator case is already resolved");
  }
  const pending = await client.approvalRequest.findFirst({
    where: { subjectType: "OPERATOR_CASE", subjectId: id, state: "PENDING_REVIEW" },
    select: { id: true },
  });
  if (pending) {
    throw new ApiError(
      409,
      "OPERATOR_CASE_APPROVAL_PENDING",
      "A resolution for this case is already waiting for a checker",
      { approvalRequestId: pending.id },
    );
  }
  const action = body.action as OperatorCaseAction;
  if (action !== "CLOSE_CASE" && !operatorCase.attempt) {
    throw new ApiError(409, "CASE_HAS_NO_ATTEMPT", "This action requires a linked payment attempt");
  }
  if (action === "MARK_SUCCEEDED" && !body.providerReference) {
    throw new ApiError(
      400,
      "PROVIDER_REFERENCE_REQUIRED",
      "A provider reference is required to resolve a case as succeeded",
    );
  }
  if (action === "CLOSE_CASE" && operatorCase.attempt && !operatorCase.attempt.terminalAt) {
    throw new ApiError(
      409,
      "ATTEMPT_OUTCOME_REQUIRED",
      "The linked attempt is still open; resolve it as succeeded or failed instead of closing the case",
    );
  }
  const reference = operatorCaseReference(operatorCase as never);
  const payload = {
    action,
    reason: body.reason,
    notes: body.notes ?? null,
    providerReference: body.providerReference ?? null,
    settledAmount: body.settledAmount ?? null,
    caseId: operatorCase.id,
    caseRef: reference.value,
    attemptId: operatorCase.attemptId,
    attemptReference: operatorCase.attempt?.reference ?? null,
    proposedAt: new Date().toISOString(),
    checklist: body.checklist ?? [],
  };
  const approval = await client.$transaction(async (tx) => {
    const created = await tx.approvalRequest.create({
      data: {
        subjectType: "OPERATOR_CASE",
        subjectId: operatorCase.id,
        payloadDiffJson: json(payload),
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await tx.operatorCase.update({
      where: { id: operatorCase.id },
      data: { state: "PENDING_CHECKER", approvalRequestId: created.id },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "OPERATOR",
        action: "OPERATOR_CASE_RESOLUTION_PROPOSED",
        entityType: "OPERATOR_CASE",
        entityId: operatorCase.id,
        beforeJson: { state: operatorCase.state },
        afterJson: { state: "PENDING_CHECKER", approvalRequestId: created.id, action, checklist: body.checklist ?? [] },
        approvalRequestId: created.id,
      },
    });
    return created;
  });
  response.status(202).json({
    status: "PENDING_CHECKER",
    caseId: operatorCase.id,
    approvalRequestId: approval.id,
  });
});

// GET /attempts/:id (attempt detail) is served by adminOperations.ts, mounted next to /system/backups.

router.post("/attempts/:id/inquire", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:inquire"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const attempt = await client.paymentAttempt.findUnique({
    where: { id },
    include: {
      gatewayVersion: { select: { setting: { select: { supportsStatusCheck: true } } } },
    },
  });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  }
  const eligibility = operatorCaseInquiryEligibility({
    caseState: null,
    attemptStatus: attempt.status,
    terminalAt: attempt.terminalAt,
    supportsStatusCheck: attempt.gatewayVersion?.setting?.supportsStatusCheck === true,
  });
  if (!eligibility.eligible) {
    throw new ApiError(
      409,
      "ATTEMPT_NOT_INQUIRABLE",
      operatorCaseInquirySkipMessage(eligibility.reason),
      { reason: eligibility.reason },
    );
  }
  const actor = actorFromRequest(request);
  const nextCheckAt = new Date(Date.now() + 1000);
  const updated = await client.$transaction(async (tx) => {
    const changed = await tx.paymentAttempt.updateMany({
      where: { id, terminalAt: null, status: { in: ["UNKNOWN", "VERIFYING"] } },
      data: { status: "VERIFYING", nextCheckAt },
    });
    if (changed.count === 0) {
      throw new ApiError(
        409,
        "ATTEMPT_NOT_INQUIRABLE",
        "The payment attempt changed state before the inquiry could be scheduled",
      );
    }
    await tx.operatorCase.updateMany({
      where: { attemptId: id, state: { in: ["OPEN", "IN_PROGRESS"] } },
      data: { state: "IN_PROGRESS" },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "OPERATOR",
        action: "ATTEMPT_INQUIRY_SCHEDULED",
        entityType: "PAYMENT_ATTEMPT",
        entityId: id,
        beforeJson: { status: attempt.status },
        afterJson: { status: "VERIFYING", nextCheckAt: nextCheckAt.toISOString() },
      },
    });
    return tx.paymentAttempt.findUnique({ where: { id }, select: { id: true, status: true } });
  });
  response.json({ id: updated?.id ?? id, status: updated?.status ?? "VERIFYING", inquiryScheduled: true });
});



/**
 * The Smart AI-Assisted Provider Onboarding kit.
 *
 * Download -> the admin hands the transcript to an external AI -> upload the
 * generated spec -> the platform verifies it offline and imports it as a DRAFT
 * gateway version. The platform never calls an external AI, and a live secret
 * never leaves the admin's machine before the import.
 */
const AI_TRANSCRIPT_RAIL_KINDS = [
  "OTP_PULL",
  "REDIRECT",
  "EMBEDDED",
  "QR_DISPLAY",
  "PUSH_APPROVAL",
  "HYBRID",
] as const;

router.get("/gateways/ai-transcript", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const query = parseOrThrow(
    z
      .object({ railKind: z.enum(AI_TRANSCRIPT_RAIL_KINDS).optional() })
      .strict(),
    request.query ?? {},
  );
  const kit = buildTranscriptKit({ railKind: query.railKind });
  response.json({
    filename: kit.filename,
    contentType: kit.contentType,
    specVersion: kit.specVersion,
    markdown: kit.markdown,
    vocabulary: kit.vocabulary,
  });
});

/** Layer 4: is the code already taken? */
const collisionCheck = async (spec: {
  gateway: { code: string };
  rail: { code: string };
}): Promise<CollisionResult> => {
  const [gateway, rail, versions] = await Promise.all([
    client.gateway.findUnique({ where: { code: spec.gateway.code }, select: { id: true } }),
    client.rail.findUnique({ where: { code: spec.rail.code }, select: { id: true } }),
    client.gateway.findUnique({
      where: { code: spec.gateway.code },
      select: { _count: { select: { versions: true } } },
    }),
  ]);
  return {
    gatewayExists: Boolean(gateway),
    railCodeExists: Boolean(rail),
    versionCount: versions?._count.versions ?? 0,
  };
};

const specSimulatorOptions = () => ({
  collisionChecker: collisionCheck,
  computeRegistry: createComputeRegistry({ db: client as never }),
});

router.post("/gateways/spec-verify", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const body = parseOrThrow(z.object({ spec: z.unknown() }).strict(), request.body ?? {});
  const report = await simulateSpec(body.spec, specSimulatorOptions());
  response.json(report);
});

router.post("/gateways/spec-import", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const actor = actorFromRequest(request);
  const body = parseOrThrow(
    z
      .object({
        spec: z.unknown(),
        credentialsValues: z.record(z.string().max(64), z.string().max(4096)).optional(),
        credentials_values: z.record(z.string().max(64), z.string().max(4096)).optional(),
        mode: z.enum(["CREATE_NEW", "NEW_VERSION"]).optional(),
        checklist: z.array(z.enum([
          "SPEC_VERIFIED",
          "CREDENTIALS_VERIFIED",
          "IMPORT_MODE_REVIEWED",
          "NO_SECRET_EXPOSURE_CONFIRMED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const parsed = parseImportRequest(body);
  const platform = getPlatformRuntime(client as never);
  const result = await materializeSpec(
    client as never,
    {
      spec: parsed.spec,
      credentialsValues: parsed.credentialsValues,
      mode: parsed.mode,
      actorId: actor.userId,
    },
    specSimulatorOptions(),
    platform.vault,
  );

  // The live probe runs AFTER the draft is safely committed: a failing probe
  // marks the credential set FAILING, it never loses the imported draft.
  let credentialCheck: { status: string; method?: string; reason?: string } | undefined;
  if (result.credentialSetId) {
    try {
      const check = await platform.credentialCheck.verify(result.credentialSetId, {
        gatewayVersionId: result.gatewayVersionId,
      });
      credentialCheck = { status: check.status, method: check.method, reason: check.reason };
    } catch (error) {
      credentialCheck = { status: "FAILING", reason: (error as Error).message };
    }
  }

  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "GATEWAY_SPEC_IMPORTED",
      entityType: "GATEWAY",
      entityId: result.gatewayId,
      beforeJson: {},
      afterJson: { gatewayVersionId: result.gatewayVersionId, mode: parsed.mode, checklist: body.checklist ?? [] },
    },
  });
  response.status(201).json({
    ...result,
    credentialCheck,
    nextStep:
      "Bind the remaining secrets in the portal (if any), then submit the version for approval. It stays DRAFT and its route PAUSED until all 12 go-live gates pass.",
  });
});

router.get("/gateways", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["code", "name", "operator"],
    in: { status: "status" }, equals: {kind: "kind", verificationState: "verificationState", riskClass: "riskClass", country: "country"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { code: "code", name: "name", operator: "operator", status: "status", kind: "kind", createdAt: "createdAt" },
    defaultSort: { code: "asc" },
  });
  const [gateways, total] = await Promise.all([
    client.gateway.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        versions: { orderBy: { versionNumber: "desc" }, select: { id: true, versionNumber: true, state: true, createdAt: true } },
        activeVersion: { select: { id: true, versionNumber: true, state: true } },
        _count: { select: { credentialSets: true, railRoutes: true, statementSources: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.gateway.count({ where: built.where as never }),
  ]);
  const gatewayIds = gateways.map((gateway) => gateway.id);
  const routeHealth = gatewayIds.length === 0
    ? []
    : await client.railRoute.groupBy({
        by: ["gatewayId", "healthState"],
        where: { gatewayId: { in: gatewayIds } },
        _count: { _all: true },
      });
  const healthMap = new Map<string, Record<string, number>>();
  for (const row of routeHealth) {
    const current = healthMap.get(row.gatewayId) ?? {};
    current[row.healthState] = row._count._all;
    healthMap.set(row.gatewayId, current);
  }
  response.json(listResponse(
    "gateways",
    gateways.map((gateway) => ({
      ...gateway,
      versionCount: gateway.versions.length,
      activeVersion: gateway.activeVersion,
      pendingVersion: gateway.versions.find((version) => version.state === "PENDING_APPROVAL") ?? null,
      routeCount: gateway._count.railRoutes,
      credentialSetCount: gateway._count.credentialSets,
      statementSourceCount: gateway._count.statementSources,
      routeHealth: {
        healthy: healthMap.get(gateway.id)?.HEALTHY ?? 0,
        degraded: healthMap.get(gateway.id)?.DEGRADED ?? 0,
        openBreaker: healthMap.get(gateway.id)?.OPEN_BREAKER ?? 0,
      },
    })),
    total,
    built,
  ));
});

router.get("/gateways/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["code", "name", "operator"],
    in: { status: "status" }, equals: {kind: "kind", verificationState: "verificationState", riskClass: "riskClass", country: "country"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { code: "code", name: "name", operator: "operator", status: "status", kind: "kind", createdAt: "createdAt" },
    defaultSort: { code: "asc" },
  });
  const take = 5000;
  const [gateways, total] = await Promise.all([
    client.gateway.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        versions: { orderBy: { versionNumber: "desc" }, select: { id: true, versionNumber: true, state: true, createdAt: true } },
        activeVersion: { select: { id: true, versionNumber: true, state: true } },
        _count: { select: { credentialSets: true, railRoutes: true, statementSources: true } },
      },
      take,
    }),
    client.gateway.count({ where: built.where as never }),
  ]);
  const gatewayIds = gateways.map((gateway) => gateway.id);
  const routeHealth = gatewayIds.length === 0
    ? []
    : await client.railRoute.groupBy({
        by: ["gatewayId", "healthState"],
        where: { gatewayId: { in: gatewayIds } },
        _count: { _all: true },
      });
  const healthMap = new Map<string, Record<string, number>>();
  for (const row of routeHealth) {
    const current = healthMap.get(row.gatewayId) ?? {};
    current[row.healthState] = row._count._all;
    healthMap.set(row.gatewayId, current);
  }
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "GATEWAYS_EXPORTED",
      entityType: "GATEWAY",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: gateways.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    gateways: gateways.map((gateway) => ({
      id: gateway.id,
      code: gateway.code,
      name: gateway.name,
      operator: gateway.operator,
      country: gateway.country,
      kind: gateway.kind,
      verificationState: gateway.verificationState,
      riskClass: gateway.riskClass,
      status: gateway.status,
      aliases: gateway.aliases,
      activeVersion: gateway.activeVersion,
      pendingVersion: gateway.versions.find((version) => version.state === "PENDING_APPROVAL") ?? null,
      versionCount: gateway.versions.length,
      routeCount: gateway._count.railRoutes,
      credentialSetCount: gateway._count.credentialSets,
      statementSourceCount: gateway._count.statementSources,
      routeHealth: {
        healthy: healthMap.get(gateway.id)?.HEALTHY ?? 0,
        degraded: healthMap.get(gateway.id)?.DEGRADED ?? 0,
        openBreaker: healthMap.get(gateway.id)?.OPEN_BREAKER ?? 0,
      },
      createdAt: gateway.createdAt,
      updatedAt: gateway.updatedAt,
    })),
    total,
    exported: gateways.length,
    truncated: total > gateways.length,
  });
});

const buildGatewaySummary = async () => {
  const [statusRows, kindRows, verificationRows, riskRows, routeHealthRows, pendingVersions] = await Promise.all([
    client.gateway.groupBy({ by: ["status"], _count: { _all: true } }),
    client.gateway.groupBy({ by: ["kind"], _count: { _all: true } }),
    client.gateway.groupBy({ by: ["verificationState"], _count: { _all: true } }),
    client.gateway.groupBy({ by: ["riskClass"], _count: { _all: true } }),
    client.railRoute.groupBy({ by: ["healthState"], _count: { _all: true } }),
    client.gatewayVersion.count({ where: { state: "PENDING_APPROVAL" } }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row._count._all;
  const byKind: Record<string, number> = {};
  for (const row of kindRows) byKind[row.kind] = row._count._all;
  const byVerification: Record<string, number> = {};
  for (const row of verificationRows) byVerification[row.verificationState] = row._count._all;
  const byRisk: Record<string, number> = {};
  for (const row of riskRows) byRisk[row.riskClass] = row._count._all;
  const routeHealth: Record<string, number> = {};
  for (const row of routeHealthRows) routeHealth[row.healthState] = row._count._all;
  return {
    total: statusRows.reduce((sum, row) => sum + row._count._all, 0),
    byStatus,
    byKind,
    byVerification,
    byRisk,
    pendingVersions,
    routes: {
      healthy: routeHealth.HEALTHY ?? 0,
      degraded: routeHealth.DEGRADED ?? 0,
      openBreaker: routeHealth.OPEN_BREAKER ?? 0,
    },
  };
};

router.get("/gateways/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  response.json(await buildGatewaySummary());
});

router.get("/gateways/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const summary = await buildGatewaySummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "PORTFOLIO_SCOPE_VERIFIED",
    "STATUS_BREAKDOWN_REVIEWED",
    "VERSION_RISK_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "GATEWAY_SUMMARY_EXPORTED",
      entityType: "GATEWAY",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: summary.total,
        pendingVersions: summary.pendingVersions,
        routes: summary.routes,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/gateways/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const gateway = await client.gateway.findUnique({
    where: { id },
    include: { versions: true, credentialSets: true },
  });
  if (!gateway) {
    throw new ApiError(404, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  }
  response.json({ gateway });
});

router.post("/gateways", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const body = parseOrThrow(
    z
      .object({
        code: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/),
        name: z.string().min(2).max(160),
        operator: z.string().min(2).max(160),
        country: z.string().length(2).default("LY"),
        aliases: z.array(z.string().min(1).max(64)).max(20).default([]),
        kind: z.enum(["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]),
        verificationState: z.enum(["VERIFIED", "UNVERIFIED"]).default("UNVERIFIED"),
        riskClass: z.enum(["NORMAL", "HIGH_RISK"]).default("NORMAL"),
      })
      .strict(),
    request.body,
  );
  const gateway = await client.gateway.create({
    data: {
      code: body.code,
      name: body.name,
      operator: body.operator,
      country: body.country.toUpperCase(),
      aliases: body.aliases,
      kind: body.kind,
      verificationState: body.verificationState,
      riskClass: body.riskClass,
    },
  });
  response.status(201).json({ id: gateway.id, code: gateway.code, status: gateway.status });
});

router.patch("/gateways/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        code: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/).optional(),
        name: z.string().min(2).max(160).optional(),
        operator: z.string().min(2).max(160).optional(),
        country: z.string().length(2).optional(),
        aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
        kind: z.enum(["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]).optional(),
        verificationState: z.enum(["VERIFIED", "UNVERIFIED"]).optional(),
        riskClass: z.enum(["NORMAL", "HIGH_RISK"]).optional(),
      })
      .strict(),
    request.body,
  );
  const gateway = await client.gateway.findUnique({ where: { id } });
  if (!gateway) {
    throw new ApiError(404, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  }
  const updated = await client.gateway.update({
    where: { id },
    data: {
      code: body.code,
      name: body.name,
      operator: body.operator,
      country: body.country?.toUpperCase(),
      aliases: body.aliases,
      kind: body.kind,
      verificationState: body.verificationState,
      riskClass: body.riskClass,
    },
  });
  response.json({ id: updated.id, name: updated.name });
});

router.get("/gateways/:id/versions", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const versions = await client.gatewayVersion.findMany({
    where: { gatewayId: id },
    orderBy: { versionNumber: "desc" },
  });
  response.json({ versions });
});

router.post("/gateways/:id/versions", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ changeNote: z.string().max(1000).optional(), snapshot: z.record(z.string().max(64), z.unknown()).default({}) }).strict(),
    request.body ?? {},
  );
  const gateway = await client.gateway.findUnique({ where: { id } });
  if (!gateway) {
    throw new ApiError(404, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  }
  const actor = actorFromRequest(request);
  const latest = await client.gatewayVersion.findFirst({
    where: { gatewayId: id },
    orderBy: { versionNumber: "desc" },
  });
  const snapshot = JSON.stringify(body.snapshot);
  const version = await client.gatewayVersion.create({
    data: {
      gatewayId: id,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      snapshotCiphertext: snapshot,
      contentHash: createHash("sha256").update(snapshot).digest("hex"),
      state: "DRAFT",
      createdById: actor.userId,
      changeNote: body.changeNote,
    },
  });
  response.status(201).json({ id: version.id, versionNumber: version.versionNumber, state: version.state });
});

const gatewayVersionCloneBodySchema = z
  .object({ changelog: z.string().max(1000).optional() })
  .strict();

/**
 * Clones a version's configuration into a brand-new DRAFT.
 *
 * Editing a LIVE row in place bypasses the go-live gates, so the wizard uses
 * this endpoint whenever the gateway has no open draft. Evidence, attempt logs
 * and inbound events are deliberately not copied: the new draft must earn its
 * own evidence before a checker can activate it.
 */
router.post("/gateway-versions/:vid/clone", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  const body = parseOrThrow(gatewayVersionCloneBodySchema, request.body ?? {});
  const actor = actorFromRequest(request);
  const source = await client.gatewayVersion.findUnique({
    where: { id: vid },
    include: {
      environments: true,
      auth: true,
      setting: true,
      cryptoProfiles: true,
      flows: {
        include: {
          steps: {
            include: { parameters: true, outputs: true },
          },
        },
      },
      statusRules: true,
      errorMaps: true,
      confirmationChannels: true,
    },
  });
  if (!source) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  const latest = await client.gatewayVersion.findFirst({
    where: { gatewayId: source.gatewayId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const nextVersion = (latest?.versionNumber ?? 0) + 1;
  const clone = await client.$transaction(async (tx) => {
    const created = await tx.gatewayVersion.create({
      data: {
        gatewayId: source.gatewayId,
        versionNumber: nextVersion,
        snapshotCiphertext: JSON.stringify({
          clonedFromVersionId: source.id,
          clonedFromVersionNumber: source.versionNumber,
          clonedAt: new Date().toISOString(),
        }),
        contentHash: createHash("sha256")
          .update(`${source.id}:${nextVersion}:${randomBytes(16).toString("hex")}`)
          .digest("hex"),
        state: "DRAFT",
        createdById: actor.userId,
        changeNote: body.changelog ?? `Cloned from v${source.versionNumber}`,
        rollbackVersionId: source.rollbackVersionId ?? source.id,
      },
    });

    for (const environment of source.environments) {
      await tx.gatewayEnvironment.create({
        data: {
          gatewayVersionId: created.id,
          env: environment.env,
          baseUrls: environment.baseUrls as Prisma.InputJsonValue,
          allowedHosts: environment.allowedHosts as Prisma.InputJsonValue,
          inboundIpAllowlist: environment.inboundIpAllowlist as Prisma.InputJsonValue,
          outboundEgressIps: environment.outboundEgressIps as Prisma.InputJsonValue,
          enabled: environment.enabled,
        },
      });
    }
    for (const auth of source.auth) {
      await tx.gatewayAuth.create({
        data: {
          gatewayVersionId: created.id,
          env: auth.env,
          method: auth.method,
          authApply: auth.authApply,
          refreshConfigJson: auth.refreshConfigJson as Prisma.InputJsonValue | undefined,
        },
      });
    }
    if (source.setting) {
      const setting = source.setting;
      await tx.gatewaySetting.create({
        data: {
          gatewayVersionId: created.id,
          amountScale: setting.amountScale,
          amountPrecision: setting.amountPrecision,
          amountRounding: setting.amountRounding,
          amountFormat: setting.amountFormat,
          referenceFormat: setting.referenceFormat as Prisma.InputJsonValue,
          sessionTtlSeconds: setting.sessionTtlSeconds,
          otpTtlSeconds: setting.otpTtlSeconds,
          otpResendCooldownSeconds: setting.otpResendCooldownSeconds,
          maxOtpAttempts: setting.maxOtpAttempts,
          supportsStatusCheck: setting.supportsStatusCheck,
          statusCheckMinAgeSeconds: setting.statusCheckMinAgeSeconds,
          supportsIdempotencyKey: setting.supportsIdempotencyKey,
          supportsCancel: setting.supportsCancel,
          rateLimitPerSecond: setting.rateLimitPerSecond,
          concurrencyCap: setting.concurrencyCap,
          timeoutMs: setting.timeoutMs,
          maxResponseBytes: setting.maxResponseBytes,
          gatewayTimezone: setting.gatewayTimezone,
        },
      });
    }

    const profileIdMap = new Map<string, string>();
    for (const profile of source.cryptoProfiles) {
      const createdProfile = await tx.cryptoProfile.create({
        data: {
          gatewayVersionId: created.id,
          name: profile.name,
          purpose: profile.purpose,
          algorithm: profile.algorithm,
          secretKeyRef: profile.secretKeyRef,
          secretKeyEncoding: profile.secretKeyEncoding,
          canonicalizationMode: profile.canonicalizationMode,
          templateString: profile.templateString,
          includedFields: profile.includedFields as Prisma.InputJsonValue,
          excludedFields: profile.excludedFields as Prisma.InputJsonValue,
          outputEncoding: profile.outputEncoding,
        },
      });
      profileIdMap.set(profile.id, createdProfile.id);
    }

    for (const flow of source.flows) {
      await tx.flow.create({
        data: {
          gatewayVersionId: created.id,
          railId: flow.railId,
          subMode: flow.subMode,
          phase: flow.phase,
          steps: {
            create: flow.steps.map((step) => ({
              orderIndex: step.orderIndex,
              type: step.type,
              method: step.method,
              urlTemplate: step.urlTemplate,
              contentType: step.contentType,
              xmlTemplate: step.xmlTemplate,
              timeoutMs: step.timeoutMs,
              successCheck: step.successCheck as Prisma.InputJsonValue | undefined,
              sideEffect: step.sideEffect,
              retryPolicy: step.retryPolicy,
              idempotencyConfig: step.idempotencyConfig as Prisma.InputJsonValue,
              pointOfNoReturn: step.pointOfNoReturn,
              parameters: {
                create: step.parameters.map((parameter) => ({
                  place: parameter.place,
                  key: parameter.key,
                  source: parameter.source,
                  selector: parameter.selector,
                  constantValue: parameter.constantValue,
                  cryptoProfileId: parameter.cryptoProfileId
                    ? profileIdMap.get(parameter.cryptoProfileId) ?? null
                    : null,
                  transforms: parameter.transforms as Prisma.InputJsonValue,
                })),
              },
              outputs: {
                create: step.outputs.map((output) => ({
                  name: output.name,
                  selector: output.selector,
                  transforms: output.transforms as Prisma.InputJsonValue,
                  storeAs: output.storeAs,
                  required: output.required,
                })),
              },
            })),
          },
        },
      });
    }

    for (const rule of source.statusRules) {
      await tx.statusRule.create({
        data: {
          gatewayVersionId: created.id,
          phase: rule.phase,
          orderIndex: rule.orderIndex,
          selector: rule.selector,
          op: rule.op,
          valueJson: rule.valueJson as Prisma.InputJsonValue,
          canonicalStatus: rule.canonicalStatus,
          canonicalSubstatus: rule.canonicalSubstatus,
          canonicalError: rule.canonicalError,
        },
      });
    }
    for (const errorMap of source.errorMaps) {
      await tx.errorMap.create({
        data: {
          gatewayVersionId: created.id,
          gatewayCode: errorMap.gatewayCode,
          canonicalError: errorMap.canonicalError,
          classification: errorMap.classification,
          retryable: errorMap.retryable,
          countsTowardLockout: errorMap.countsTowardLockout,
          countsTowardBreaker: errorMap.countsTowardBreaker,
          customerMessageAr: errorMap.customerMessageAr,
          customerMessageEn: errorMap.customerMessageEn,
          operatorHint: errorMap.operatorHint,
        },
      });
    }
    for (const channel of source.confirmationChannels) {
      await tx.confirmationChannel.create({
        data: {
          gatewayVersionId: created.id,
          routeId: channel.routeId,
          type: channel.type,
          pathToken: randomBytes(16).toString("hex"),
          cryptoProfileId: channel.cryptoProfileId
            ? profileIdMap.get(channel.cryptoProfileId) ?? null
            : null,
          verifyMethod: channel.verifyMethod,
          signatureHeader: channel.signatureHeader,
          timestampSelector: channel.timestampSelector,
          timestampToleranceSec: channel.timestampToleranceSec,
          ipAllowlist: channel.ipAllowlist as Prisma.InputJsonValue | undefined,
          bodyFormat: channel.bodyFormat,
          correlationSelector: channel.correlationSelector,
          dedupeKeySelector: channel.dedupeKeySelector,
          eventMap: channel.eventMap as Prisma.InputJsonValue,
          mustInquire: channel.mustInquire,
          ackStatus: channel.ackStatus,
          ackBodyTemplate: channel.ackBodyTemplate,
        },
      });
    }

    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "GATEWAY_VERSION_CLONED",
        entityType: "GATEWAY_VERSION",
        entityId: created.id,
        beforeJson: { sourceVersionId: source.id, sourceVersionNumber: source.versionNumber },
        afterJson: { versionNumber: created.versionNumber, state: "DRAFT" },
      },
    });
    return created;
  });
  response.status(201).json({
    id: clone.id,
    gatewayId: clone.gatewayId,
    versionNumber: clone.versionNumber,
    state: clone.state,
    clonedFromVersionId: source.id,
  });
});

/**
 * States a rollback target may have had before. Only a version that was
 * already promoted through the go-live gates can be rolled back to.
 */
const ROLLBACK_ELIGIBLE_STATES = new Set(["LIVE", "SUPERSEDED", "ROLLED_BACK"]);

/**
 * Rolls a gateway back to a previously live version.
 *
 * Design v5 §14 admits no exception: even a rollback target must still pass
 * all twelve go-live gates against its persisted evidence. The state check
 * rejects a version that was never live, and the gate assertion - the very
 * same one the approval path uses - runs inside the rollback transaction, so
 * a partially validated version can never become LIVE.
 */
export const rollbackGatewayVersionInTransaction = async (
  tx: Tx,
  gatewayId: string,
  targetVersionId: string,
  checkerUserId: string | null,
) => {
  const target = await tx.gatewayVersion.findFirst({
    where: { id: targetVersionId, gatewayId },
  });
  if (!target) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  const state = String(target.state);
  if (!ROLLBACK_ELIGIBLE_STATES.has(state)) {
    throw new ApiError(
      409,
      "GATEWAY_VERSION_NOT_ROLLBACKABLE",
      `The gateway version cannot be rolled back to because it has never been live (state '${state}')`,
      { versionId: String(target.id), state },
    );
  }
  await assertGatewayVersionGoLive(tx, String(target.id), checkerUserId);
  const previous = await tx.gatewayVersion.findMany({
    where: { gatewayId, state: "LIVE" },
    select: { id: true },
  });
  for (const version of previous) {
    await tx.gatewayVersion.update({ where: { id: version.id }, data: { state: "ROLLED_BACK" } });
  }
  await tx.gatewayVersion.update({ where: { id: String(target.id) }, data: { state: "LIVE" } });
  return tx.gateway.update({
    where: { id: gatewayId },
    data: { activeVersionId: String(target.id), status: "LIVE" },
  });
};

router.post("/gateways/:id/rollback", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({
    versionId: z.string().min(1).max(64),
    reason: z.string().min(3).max(500).optional(),
    checklist: z.array(z.enum([
      "TARGET_VERSION_VERIFIED",
      "GATES_VERIFIED",
      "IMPACT_REVIEWED",
      "ROLLBACK_AUTHORITY_CONFIRMED",
    ])).max(10).optional(),
  }).strict(), request.body);
  const actor = actorFromRequest(request);
  const gateway = await client.$transaction(async (tx) =>
    rollbackGatewayVersionInTransaction(tx as never, id, body.versionId, actor.userId)
  );
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "GATEWAY_VERSION_ROLLED_BACK",
      entityType: "GATEWAY",
      entityId: id,
      beforeJson: {},
      afterJson: { targetVersionId: body.versionId, reason: body.reason ?? null, checklist: body.checklist ?? [] },
    },
  });
  // The outbound consumers of the gateway are now stale.
  await invalidationBus.invalidateGateway(id, "gateway-version-rolled-back");
  response.json({ id: gateway.id, activeVersionId: gateway.activeVersionId });
});

/* ------------------------------------------------------------------ *
 * Credential sets (design v5 §6 layer 2, §7.2 and §16.3)
 * ------------------------------------------------------------------ */

/**
 * The sentinel of the external merchant id of a platform owned credential
 * set. A platform owned set has no merchant on the other side, but the
 * uniqueness constraint of the table is `(gateway_id, env,
 * external_merchant_id)`, so the platform sets need a stable value as well.
 */
const PLATFORM_EXTERNAL_MERCHANT_ID = "PLATFORM";

const credentialEntrySchema = z.object({
  key: z.string().min(1).max(64),
  type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
  value: z.string().max(4096),
  isSecret: z.boolean().default(true),
});

const credentialSetSchema = z
  .object({
    gatewayCode: z.string().min(2).max(64),
    env: z.enum(["SANDBOX", "LIVE"]),
    ownerType: z.enum(["PLATFORM", "MERCHANT"]),
    ownerMerchantId: z.string().min(1).max(64).optional(),
    externalMerchantId: z.string().min(2).max(120).optional(),
    settlementTarget: z.enum(["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]),
    entries: z.array(credentialEntrySchema).min(1).max(40),
  })
  .strict();

const credentialSetEntry = (entry: {
  key: string;
  type: string;
  value: string;
  isSecret: boolean;
  secretVersion?: number;
}) => ({
  key: entry.key,
  type: entry.type,
  value: entry.value,
  isSecret: entry.isSecret,
  secretVersion: entry.secretVersion ?? 1,
});

const credentialSetView = (credentialSet: {
  id: string;
  env: string;
  ownerType: string;
  ownerMerchantId: string | null;
  externalMerchantId: string | null;
  settlementTarget: string;
  status: string;
  lastVerifiedAt: Date | null;
  expiresAt: Date | null;
  gateway?: { code: string } | null;
}) => ({
  id: credentialSet.id,
  gatewayCode: credentialSet.gateway?.code ?? null,
  env: credentialSet.env,
  ownerType: credentialSet.ownerType,
  ownerMerchantId: credentialSet.ownerMerchantId,
  externalMerchantId: credentialSet.externalMerchantId,
  settlementTarget: credentialSet.settlementTarget,
  status: credentialSet.status,
  lastVerifiedAt: credentialSet.lastVerifiedAt,
  expiresAt: credentialSet.expiresAt,
});

router.get("/credential-sets", async (request: Request, response: Response) => {
  requireAuthorities(request, ["credential:read", "gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["externalMerchantId", "gateway.code"],
    in: { status: "status" }, equals: {gatewayCode: "gateway.code", env: "env", ownerType: "ownerType",},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { gatewayCode: "gatewayId", env: "env", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [credentialSets, total] = await Promise.all([
    client.credentialSet.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { gateway: { select: { code: true } } }, skip: built.skip, take: built.take }),
    client.credentialSet.count({ where: built.where as never }),
  ]);
  response.json(listResponse("credentialSets", credentialSets, total, built));
});

router.get("/credential-sets/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["credential:read", "gateway:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const credentialSet = await client.credentialSet.findUnique({
    where: { id },
    include: { gateway: { select: { code: true } } },
  });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  response.json({
    ...credentialSetView(credentialSet),
    // The secrets are write only: they are never read back.
    entries: (credentialSet.entriesCiphertext as Array<{ key: string; type: string; isSecret: boolean }>).map(
      (entry) => ({
        key: entry.key,
        type: entry.type,
        isSecret: entry.isSecret,
        value: entry.isSecret ? "[REDACTED]" : "[WRITE_ONLY]",
      }),
    ),
  });
});

router.post("/credential-sets", async (request: Request, response: Response) => {
  requireAuthorities(request, ["credential:write", "gateway:write"]);
  const body = parseOrThrow(credentialSetSchema, request.body);
  const gateway = await client.gateway.findUnique({ where: { code: body.gatewayCode } });
  if (!gateway) {
    throw new ApiError(404, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  }
  if (body.ownerType === "MERCHANT" && !body.ownerMerchantId) {
    throw new ApiError(
      400,
      "CREDENTIAL_SET_OWNER_REQUIRED",
      "A merchant owned credential set requires the merchant that owns it",
    );
  }
  const externalMerchantId = body.ownerType === "PLATFORM"
    ? (body.externalMerchantId ?? PLATFORM_EXTERNAL_MERCHANT_ID)
    : (body.externalMerchantId ?? body.ownerMerchantId ?? "");
  const encryptedEntries = await Promise.all(
    body.entries.map(async (entry) =>
      credentialSetEntry({
        ...entry,
        value: entry.isSecret ? await vault.encryptSecret(entry.value, "credential-set") : entry.value,
      }),
    ),
  );
  const credentialSet = await client.credentialSet.create({
    data: {
      gatewayId: gateway.id,
      env: body.env,
      ownerType: body.ownerType,
      ownerMerchantId: body.ownerType === "MERCHANT" ? body.ownerMerchantId : null,
      externalMerchantId,
      settlementTarget: body.settlementTarget,
      entriesCiphertext: encryptedEntries,
      // A new credential set is never trusted before it was proven.
      status: "UNTESTED",
    },
  });
  await invalidationBus.invalidateCredential(credentialSet.id, "credential-set-created");
  response.status(201).json({ id: credentialSet.id, status: credentialSet.status });
});

router.put("/credential-sets/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["credential:write", "gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ entries: z.array(credentialEntrySchema).min(1).max(40) }).strict(),
    request.body,
  );
  const credentialSet = await client.credentialSet.findUnique({ where: { id } });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  const encryptedEntries = await Promise.all(
    body.entries.map(async (entry) =>
      credentialSetEntry({
        ...entry,
        secretVersion: 2,
        value: entry.isSecret ? await vault.encryptSecret(entry.value, "credential-set") : entry.value,
      }),
    ),
  );
  // A rotated secret is untrusted again until the credential check proves it.
  const updated = await client.credentialSet.update({
    where: { id: credentialSet.id },
    data: { entriesCiphertext: encryptedEntries, status: "UNTESTED", lastVerifiedAt: null },
  });
  await invalidationBus.invalidateCredential(updated.id, "credential-set-rotated");
  response.json({ id: updated.id, status: updated.status });
});

/**
 * Runs the credential check of a credential set.
 *
 * The check is the `CREDENTIAL_CHECK` phase of design v5 §7.4: the version
 * either defines the steps that prove the credentials or the platform probes
 * the environment of the gateway with the `ApiConsumer`. The verdict is
 * recorded on the credential set: `VERIFIED` with the verification time, or
 * `FAILING`.
 */
router.post("/credential-sets/:id/verify", async (request: Request, response: Response) => {
  requireAuthorities(request, ["credential:write", "gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ gatewayVersionId: z.string().min(1).max(64).optional() }).strict(),
    request.body ?? {},
  );
  const credentialSet = await client.credentialSet.findUnique({ where: { id } });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  const platform = getPlatformRuntime(client as never);
  const result = await platform.credentialCheck.verify(id, {
    ...(body.gatewayVersionId ? { gatewayVersionId: body.gatewayVersionId } : {}),
  });
  await invalidationBus.invalidateCredential(id, "credential-set-verified");
  if (result.status !== "VERIFIED") {
    throw new ApiError(
      502,
      "CREDENTIAL_VERIFICATION_FAILED",
      result.reason ?? "The credentials of the gateway could not be verified",
      { credentialSetId: id, method: result.method, httpStatus: result.httpStatus ?? null },
    );
  }
  response.json({
    id: result.credentialSetId,
    status: result.status,
    method: result.method,
    lastVerifiedAt: result.checkedAt.toISOString(),
  });
});

router.post("/credential-sets/:id/revoke", async (request: Request, response: Response) => {
  requireAuthorities(request, ["credential:write", "gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ reason: z.string().min(2).max(500).optional() }).strict(),
    request.body ?? {},
  );
  const credentialSet = await client.credentialSet.findUnique({ where: { id } });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  const actor = actorFromRequest(request);
  const updated = await client.credentialSet.update({
    where: { id: credentialSet.id },
    data: { status: "REVOKED" },
  });
  await invalidationBus.invalidateCredential(updated.id, "credential-set-revoked");
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "CREDENTIAL_SET_REVOKED",
      entityType: "CREDENTIAL_SET",
      entityId: updated.id,
      beforeJson: { status: credentialSet.status },
      afterJson: { status: updated.status, reason: body.reason ?? null },
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

const versionParamsSchema = z.object({ vid: z.string().min(1).max(64) });

const loadVersion = async (versionId: string) => {
  const version = await client.gatewayVersion.findUnique({ where: { id: versionId } });
  if (!version) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  return version;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const asRecordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];

const asNumberArray = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
    : [];

const wizardFieldType = (type: string): string => {
  switch (type) {
    case "NUMBER":
      return "numeric";
    case "PHONE":
      return "phone";
    case "WALLET_ID":
      return "wallet_id";
    case "OTP":
      return "otp";
    case "FROM_LIST":
      return "select";
    default:
      return "text";
  }
};

/**
 * The wizard reads one version as a single draft document. The relational rows
 * stay authoritative; this projection only renames the fields to the wizard
 * contract so the eight steps can render and round-trip their state.
 */
router.get("/gateway-versions/:vid", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  const version = await client.gatewayVersion.findUnique({
    where: { id: vid },
    include: {
      gateway: { include: { credentialSets: true } },
      environments: true,
      auth: true,
      setting: true,
      cryptoProfiles: true,
      flows: { include: { steps: true } },
      statusRules: { orderBy: { orderIndex: "asc" } },
      errorMaps: true,
      confirmationChannels: true,
    },
  });
  if (!version) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }

  const routes = await client.railRoute.findMany({
    where: { gatewayId: version.gatewayId },
    include: {
      rail: { include: { fields: { orderBy: { orderIndex: "asc" } } } },
      widgetDefinitions: true,
      redirectDefinitions: true,
      pollPolicies: true,
    },
    orderBy: { priority: "desc" },
  });

  const environments = version.environments.map((environment) => {
    const baseUrls = asRecordValue(environment.baseUrls);
    const baseUrl =
      (typeof baseUrls[environment.env] === "string" ? (baseUrls[environment.env] as string) : "") ||
      (Object.values(baseUrls).find((entry): entry is string => typeof entry === "string") ?? "");
    return {
      env: environment.env,
      baseUrl,
      baseUrls,
      allowedHosts: asStringArray(environment.allowedHosts),
      inboundIpAllowlist: asStringArray(environment.inboundIpAllowlist),
      enabled: environment.enabled,
    };
  });

  const authRow = version.auth.find((entry) => entry.env === "LIVE") ?? version.auth[0];
  const authConfig = asRecordValue(authRow?.refreshConfigJson);
  const auth = {
    method: authRow?.method ?? "API_KEY",
    authApply: authRow?.authApply ?? "HEADER",
    username: typeof authConfig.username === "string" ? authConfig.username : "",
    keyRef: typeof authConfig.keyRef === "string" ? authConfig.keyRef : "",
    tokenUrl: typeof authConfig.tokenUrl === "string" ? authConfig.tokenUrl : typeof authConfig.token_endpoint === "string" ? authConfig.token_endpoint : "",
    clientIdRef: typeof authConfig.clientIdRef === "string" ? authConfig.clientIdRef : "",
    clientSecretRef: typeof authConfig.clientSecretRef === "string" ? authConfig.clientSecretRef : "",
    extraHeaders: asRecordArray(authConfig.extraHeaders).map((entry) => ({
      key: typeof entry.key === "string" ? entry.key : "",
      value: typeof entry.value === "string" ? entry.value : "",
    })),
  };

  const credentialSets = version.gateway.credentialSets.map((credential) => ({
    id: credential.id,
    label: credential.externalMerchantId ?? credential.id.slice(0, 8),
    ownerType: credential.ownerType,
    settlementTarget: credential.settlementTarget,
    env: credential.env,
    secret: "",
    secretRef: "",
    status: credential.status,
  }));

  const cryptoProfiles = version.cryptoProfiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    direction: profile.purpose,
    algorithm: profile.algorithm,
    keyEncoding:
      profile.secretKeyEncoding === "UTF8"
        ? "utf8"
        : profile.secretKeyEncoding === "HEX"
          ? "hex"
          : "base64",
    canonicalization: profile.canonicalizationMode,
    secretRef: profile.secretKeyRef ?? "",
    fields: asStringArray(profile.includedFields),
    toleranceSeconds: 300,
  }));

  const flows = version.flows.map((flow) => ({
    id: flow.id,
    phase: flow.phase,
    steps: [...flow.steps]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((step) => ({
        id: step.id,
        phase: flow.phase,
        order: step.orderIndex,
        type: step.type,
        name: step.method ?? step.type,
        method: step.method ?? "",
        url: step.urlTemplate ?? "",
        sideEffect: step.sideEffect,
        retryPolicy: step.retryPolicy,
        idempotencyConfig: "",
        pointOfNoReturn: step.pointOfNoReturn,
        transforms: [],
        assertExpression: "",
        outputName: "",
      })),
  }));

  const statusRules = version.statusRules.map((rule) => ({
    id: rule.id,
    gatewayCode: rule.selector,
    canonicalStatus: rule.canonicalStatus,
    messageAr: rule.canonicalError ?? "",
    messageEn: rule.canonicalSubstatus ?? "",
    terminal: rule.canonicalStatus === "SUCCEEDED" || rule.canonicalStatus === "FAILED",
  }));

  const errorMaps = version.errorMaps.map((entry) => ({
    id: entry.id,
    gatewayCode: entry.gatewayCode,
    canonicalStatus: entry.canonicalError,
    retryable: entry.retryable,
    otpRetryable: entry.classification === "RETRYABLE_OTP",
    messageAr: entry.customerMessageAr ?? "",
    messageEn: entry.customerMessageEn ?? "",
  }));

  const confirmationChannels = version.confirmationChannels.map((channel) => ({
    id: channel.id,
    kind: channel.type === "POLL" ? "INQUIRY_POLL" : channel.type,
    name: channel.pathToken,
    eventMap: asRecordArray(channel.eventMap).map((entry) => ({
      event: typeof entry.event === "string" ? entry.event : "",
      canonical: typeof entry.canonical === "string" ? entry.canonical : "",
    })),
    secretRef: channel.cryptoProfileId ?? "",
    ipAllowlist: asStringArray(channel.ipAllowlist),
    mustInquire: channel.mustInquire,
    timestampToleranceSeconds: channel.timestampToleranceSec,
  }));

  const rails = new Map<string, Record<string, unknown>>();
  const clientActions: Record<string, unknown>[] = [];
  const pollPolicies: Record<string, unknown>[] = [];
  let costModel: Record<string, unknown> | undefined;
  for (const route of routes) {
    if (!rails.has(route.rail.id)) {
      rails.set(route.rail.id, {
        id: route.rail.id,
        routeId: route.id,
        code: route.rail.code,
        nameAr: route.rail.nameAr,
        nameEn: route.rail.nameEn,
        collectionMode: route.rail.collectionMode,
        currency: route.rail.currency,
        minAmount: String(route.rail.minAmount),
        maxAmount: route.rail.maxAmount === null ? "" : String(route.rail.maxAmount),
        capabilities: Object.entries(asRecordValue(route.rail.capabilities))
          .filter(([, enabled]) => enabled === true)
          .map(([key]) => key),
        fields: route.rail.fields.map((field) => ({
          id: field.id,
          fieldKey: field.key,
          labelAr: field.labelAr,
          labelEn: field.labelEn,
          inputType: wizardFieldType(field.type),
          required: field.required,
          regex: field.regex ?? "",
          minLength: field.minLength,
          maxLength: field.maxLength,
          normalizer: "NONE",
          sensitivity: field.sensitivity,
          options: Array.isArray(field.optionsJson)
            ? asStringArray(field.optionsJson)
            : asStringArray(asRecordValue(field.optionsJson).options),
        })),
      });
    }
    costModel ??= asRecordValue(route.costModel);
    for (const widget of route.widgetDefinitions) {
      clientActions.push({
        id: widget.id,
        kind: "RENDER_EMBEDDED",
        name: route.rail.code,
        scriptUrls: asStringArray(widget.scriptUrls),
        scriptSriHashes: asStringArray(widget.scriptSriHashes),
        allowedOrigins: asStringArray(widget.allowedOrigins),
        iframeSandbox: asStringArray(widget.iframeSandboxAttrs).join(" "),
        otpLength: 6,
        maxOtpAttempts: 3,
        resendCooldownSeconds: 30,
        redirectMethod: "GET",
        redirectUrl: "",
        qrPayload: "",
        payCode: "",
        instructionsAr: "",
        instructionsEn: "",
        deepLinkUrl: "",
        walletHint: "",
        destinationAccount: "",
      });
    }
    for (const redirect of route.redirectDefinitions) {
      clientActions.push({
        id: redirect.id,
        kind: "HTTP_REDIRECT",
        name: route.rail.code,
        scriptUrls: [],
        scriptSriHashes: [],
        allowedOrigins: [],
        iframeSandbox: "",
        otpLength: 6,
        maxOtpAttempts: 3,
        resendCooldownSeconds: 30,
        redirectMethod: redirect.method === "POST_FORM" ? "POST_FORM" : "GET",
        redirectUrl: redirect.urlSourceOutput,
        qrPayload: "",
        payCode: "",
        instructionsAr: "",
        instructionsEn: "",
        deepLinkUrl: "",
        walletHint: "",
        destinationAccount: "",
      });
    }
    for (const policy of route.pollPolicies) {
      pollPolicies.push({
        id: policy.id,
        name: route.rail.code,
        intervalSeconds: policy.firstAfterSeconds,
        backoffSchedule: asNumberArray(policy.backoffSeconds),
        maxAttempts: asNumberArray(policy.backoffSeconds).length,
        timeoutSeconds: policy.maxDurationSeconds,
      });
    }
  }

  const setting = version.setting;
  const amountPipeline = {
    scale: setting?.amountScale ?? 1,
    precision: setting?.amountPrecision ?? 3,
    rounding: setting?.amountRounding ?? "NONE",
    currency: "LYD",
  };

  response.json({
    id: version.id,
    versionId: version.id,
    gatewayId: version.gatewayId,
    versionNumber: version.versionNumber,
    state: version.state,
    rollbackVersionId: version.rollbackVersionId,
    identity: {
      code: version.gateway.code,
      name: version.gateway.name,
      operator: version.gateway.operator,
      country: version.gateway.country,
      aliases: asStringArray(version.gateway.aliases),
      kind: version.gateway.kind,
      verificationState: version.gateway.verificationState,
      riskClass: version.gateway.riskClass,
    },
    environments,
    auth,
    credentialSets,
    rails: [...rails.values()],
    cryptoProfiles,
    flows,
    clientActions,
    confirmationChannels,
    pollPolicies,
    statusRules,
    errorMaps,
    amountPipeline,
    costModel: {
      model: "FLAT",
      flatFee: typeof costModel?.flatFee === "string" ? costModel.flatFee : "0",
      percentFee: typeof costModel?.percentFee === "string" ? costModel.percentFee : "0",
      minFee: typeof costModel?.minFee === "string" ? costModel.minFee : "0",
      maxFee: typeof costModel?.maxFee === "string" ? costModel.maxFee : "0",
      currency: typeof costModel?.currency === "string" ? costModel.currency : "LYD",
    },
    statementMapping: {
      sourceId: "",
      format: "CSV",
      delimiter: ",",
      columnMapping: [],
    },
  });
});


router.put("/gateway-versions/:vid/environments", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        env: z.enum(["SANDBOX", "LIVE"]),
        baseUrls: z.record(z.string().max(40), z.string().max(500)),
        allowedHosts: z.array(z.string().max(200)).max(20),
        inboundIpAllowlist: z.array(z.string().max(64)).max(50).default([]),
        outboundEgressIps: z.array(z.string().max(64)).max(50).default([]),
        enabled: z.boolean().default(true),
      })
      .strict(),
    request.body,
  );
  const environment = await client.gatewayEnvironment.upsert({
    where: { gatewayVersionId_env: { gatewayVersionId: vid, env: body.env } },
    update: {
      baseUrls: body.baseUrls,
      allowedHosts: body.allowedHosts,
      inboundIpAllowlist: body.inboundIpAllowlist,
      outboundEgressIps: body.outboundEgressIps,
      enabled: body.enabled,
    },
    create: {
      gatewayVersionId: vid,
      env: body.env,
      baseUrls: body.baseUrls,
      allowedHosts: body.allowedHosts,
      inboundIpAllowlist: body.inboundIpAllowlist,
      outboundEgressIps: body.outboundEgressIps,
      enabled: body.enabled,
    },
  });
  response.json({ id: environment.id, env: environment.env });
});

router.put("/gateway-versions/:vid/auth", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write", "credential:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        env: z.enum(["SANDBOX", "LIVE"]),
        method: z.enum([
          "NONE",
          "API_KEY",
          "PERMANENT_TOKEN",
          "TOKEN_ENDPOINT",
          "REFRESH_TOKEN",
          "USERNAME_PASSWORD",
          "BASIC",
          "REQUEST_SIGNATURE",
          "OAUTH2_CLIENT_CREDENTIALS",
          "MUTUAL_TLS",
        ]),
        authApply: z.enum(["HEADER", "QUERY", "BODY"]),
        refreshConfigJson: z.record(z.string().max(64), z.unknown()).optional(),
      })
      .strict(),
    request.body,
  );
  const auth = await client.gatewayAuth.upsert({
    where: { gatewayVersionId_env: { gatewayVersionId: vid, env: body.env } },
    update: {
      method: body.method,
      authApply: body.authApply,
      refreshConfigJson: jsonOptional(body.refreshConfigJson),
    },
    create: {
      gatewayVersionId: vid,
      env: body.env,
      method: body.method,
      authApply: body.authApply,
      refreshConfigJson: jsonOptional(body.refreshConfigJson),
    },
  });
  response.json({ id: auth.id, method: auth.method });
});

router.put("/gateway-versions/:vid/settings", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        amountScale: z.union([z.literal(1), z.literal(100), z.literal(1000)]),
        amountPrecision: z.union([z.literal(0), z.literal(2), z.literal(3)]),
        amountRounding: z.enum(["NONE", "NEAREST", "UP", "DOWN"]),
        amountFormat: z.enum(["STRING_DECIMAL", "INTEGER_MINOR_UNITS", "NUMBER"]),
        referenceFormat: z.record(z.string().max(40), z.unknown()),
        sessionTtlSeconds: z.number().int().min(30).max(86400),
        otpTtlSeconds: z.number().int().min(30).max(3600),
        otpResendCooldownSeconds: z.number().int().min(0).max(3600),
        maxOtpAttempts: z.number().int().min(1).max(10).default(3),
        supportsStatusCheck: z.boolean().default(false),
        statusCheckMinAgeSeconds: z.number().int().min(0).max(86400).optional(),
        supportsIdempotencyKey: z.boolean().default(false),
        supportsCancel: z.boolean().default(false),
        rateLimitPerSecond: z.number().int().min(1).max(1000).optional(),
        concurrencyCap: z.number().int().min(1).max(1000).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).default(15000),
        maxResponseBytes: z.number().int().min(1024).max(10485760).default(2097152),
        gatewayTimezone: z.string().max(64).default("Africa/Tripoli"),
      })
      .strict(),
    request.body,
  );
  const settings = await client.gatewaySetting.upsert({
    where: { gatewayVersionId: vid },
    update: { ...body, referenceFormat: json(body.referenceFormat) },
    create: { gatewayVersionId: vid, ...body, referenceFormat: json(body.referenceFormat) },
  });
  response.json({ id: settings.id, amountScale: settings.amountScale });
});

router.put("/gateway-versions/:vid/crypto-profiles", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write", "security:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        profiles: z
          .array(
            z
              .object({
                name: z.string().min(1).max(64),
                purpose: z.enum(["OUTBOUND_SIGN", "INBOUND_VERIFY"]),
                algorithm: z.enum(["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"]),
                secretKeyRef: z.string().max(120).optional(),
                secretKeyEncoding: z.enum(["UTF8", "HEX", "BASE64"]).default("UTF8"),
                canonicalizationMode: z.enum([
                  "SORTED_KEY_VALUE_AMP",
                  "SORTED_VALUES_HASH",
                  "TEMPLATE_STRING",
                  "JSON_CANONICAL",
                  "RAW_BODY",
                  "TIMESTAMP_DOT_RAW_BODY",
                ]),
                templateString: z.string().max(1000).optional(),
                includedFields: z.array(z.string().max(64)).max(100).default([]),
                excludedFields: z.array(z.string().max(64)).max(100).default([]),
                outputEncoding: z.enum(["HEX_LOWER", "HEX_UPPER", "BASE64"]).default("HEX_LOWER"),
              }),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    request.body,
  );
  await client.cryptoProfile.deleteMany({ where: { gatewayVersionId: vid } });
  const created = await Promise.all(
    body.profiles.map((profile) =>
      client.cryptoProfile.create({
        data: {
          gatewayVersionId: vid,
          name: profile.name,
          purpose: profile.purpose,
          algorithm: profile.algorithm,
          secretKeyRef: profile.secretKeyRef,
          secretKeyEncoding: profile.secretKeyEncoding,
          canonicalizationMode: profile.canonicalizationMode,
          templateString: profile.templateString,
          includedFields: profile.includedFields,
          excludedFields: profile.excludedFields,
          outputEncoding: profile.outputEncoding,
        },
      }),
    ),
  );
  response.json({ profiles: created.map((profile) => ({ id: profile.id, name: profile.name })) });
});

const transformPipeSchema = z
  .object({
    op: z.string().min(1).max(40),
    args: z.array(z.unknown()).max(10).optional(),
  })
  .strict();

const stepParameterSchema = z
  .object({
    place: z.enum(["HEADERS", "QUERY", "PATH", "BODY", "FORM", "MULTIPART", "XML"]),
    key: z.string().min(1).max(120),
    source: z.enum([
      "GATEWAY_META",
      "ROUTE_META",
      "CREDENTIAL",
      "ATTEMPT",
      "CUSTOMER_FIELD",
      "STATE",
      "PREVIOUS_RESPONSE",
      "URLS",
      "CLIENT_CONTEXT",
      "CONSTANT",
      "NOW",
      "RANDOM",
      "COMPUTED",
      "CRYPTO_SIGNATURE",
    ]),
    selector: z.string().max(200).optional(),
    constantValue: z.string().max(2000).optional(),
    cryptoProfileId: z.string().min(1).max(64).optional(),
    transforms: z.array(transformPipeSchema).max(20).default([]),
  })
  .strict();

const stepOutputSchema = z
  .object({
    name: z.string().min(1).max(64),
    selector: z.string().max(200).optional(),
    transforms: z.array(transformPipeSchema).max(20).default([]),
    storeAs: z.enum(["STATE", "PUBLIC", "SETTLED_AMOUNT", "PROVIDER_FEE", "PROVIDER_REF", "NETWORK_REF"]),
    required: z.boolean().default(false),
  })
  .strict();

const gatewayFlowsSchema = z
  .object({
    flows: z
      .array(
        z
          .object({
            railId: z.string().min(1).max(64).optional(),
            subMode: z.string().max(64).optional(),
            phase: z.enum([
              "CREDENTIAL_CHECK",
              "PRE_INITIATE",
              "INITIATE",
              "SUBMIT",
              "VERIFY",
              "CANCEL",
              "REFUND",
              "VOID",
              "CAPTURE",
              "SETTLEMENT_FETCH",
            ]),
            steps: z
              .array(
                z
                  .object({
                    type: z.enum(["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"]),
                    method: z.string().max(10).optional(),
                    urlTemplate: z.string().max(1000).optional(),
                    contentType: z.string().max(80).optional(),
                    sideEffect: z.enum(["READ_ONLY", "SENDS_NOTIFICATION", "MOVES_MONEY"]),
                    retryPolicy: z.enum(["SAFE", "SAFE_WITH_COOLDOWN", "NEVER"]),
                    pointOfNoReturn: z.boolean().default(false),
                    idempotencyConfig: z.record(z.string().max(64), z.unknown()).default({ mode: "NONE" }),
                    timeoutMs: z.number().int().min(1000).max(120000).optional(),
                    parameters: z.array(stepParameterSchema).max(50).default([]),
                    outputs: z.array(stepOutputSchema).max(50).default([]),
                  }),
              )
              .max(50)
              .default([]),
          }),
      )
      .min(1)
      .max(40),
  })
  .strict();

export type GatewayFlowInput = z.output<typeof gatewayFlowsSchema>["flows"][number];

/**
 * The operation of a pipe is checked against the closed library by the
 * transform validator, so the parsed payload is narrowed here.
 */
const asTransformPipes = (
  pipes: readonly { op: string; args?: unknown[] }[],
): readonly TransformPipe[] => pipes as readonly TransformPipe[];

/**
 * Every transform usage of a gateway version save: the pipes of the step
 * parameters and of the step outputs.
 */
export const gatewayFlowTransformUsages = (
  flows: readonly GatewayFlowInput[],
): TransformUsage[] => {
  const usages: TransformUsage[] = [];
  flows.forEach((flow, flowIndex) => {
    flow.steps.forEach((step, stepIndex) => {
      step.parameters.forEach((parameter, parameterIndex) => {
        usages.push({
          path: `flows[${flowIndex}].steps[${stepIndex}].parameters[${parameterIndex}].transforms`,
          pipes: asTransformPipes(parameter.transforms),
        });
      });
      step.outputs.forEach((output, outputIndex) => {
        usages.push({
          path: `flows[${flowIndex}].steps[${stepIndex}].outputs[${outputIndex}].transforms`,
          pipes: asTransformPipes(output.transforms),
          storeAs: output.storeAs,
        });
      });
    });
  });
  return usages;
};

/**
 * The closed transform library is validated when the gateway version is
 * saved, never when a live payment executes.
 */
export const assertValidGatewayFlowTransforms = (flows: readonly GatewayFlowInput[]): void => {
  const result = validateTransformUsage(gatewayFlowTransformUsages(flows));
  if (!result.valid) {
    throw new ApiError(400, "INVALID_TRANSFORM_PIPE", "The transform pipeline is invalid", result.errors);
  }
};

export interface GatewayFlowStore {
  deleteMany(args: Prisma.FlowDeleteManyArgs): Promise<unknown>;
  create(args: Prisma.FlowCreateArgs): Promise<{ id: string; phase: string }>;
}

/**
 * Replaces the declarative flows of a gateway version. The transform pipes are
 * validated before anything is written, so an invalid pipe is refused with a
 * 400 instead of breaking a live payment.
 */
export const saveGatewayVersionFlows = async (
  vid: string,
  flows: readonly GatewayFlowInput[],
  store: GatewayFlowStore = client.flow,
): Promise<Array<{ id: string; phase: string }>> => {
  assertValidGatewayFlowTransforms(flows);
  await store.deleteMany({ where: { gatewayVersionId: vid } });
  const created = await Promise.all(
    flows.map((flow) =>
      store.create({
        data: {
          gatewayVersionId: vid,
          railId: flow.railId,
          subMode: flow.subMode,
          phase: flow.phase,
          steps: {
            create: flow.steps.map((step, index) => ({
              orderIndex: index,
              type: step.type,
              method: step.method,
              urlTemplate: step.urlTemplate,
              contentType: contentTypeEnum(step.contentType),
              sideEffect: step.sideEffect,
              retryPolicy: step.retryPolicy,
              pointOfNoReturn: step.pointOfNoReturn,
              idempotencyConfig: json(step.idempotencyConfig),
              timeoutMs: step.timeoutMs,
              parameters: {
                create: step.parameters.map((parameter) => ({
                  place: parameter.place,
                  key: parameter.key,
                  source: parameter.source,
                  selector: parameter.selector,
                  constantValue: parameter.constantValue,
                  cryptoProfileId: parameter.cryptoProfileId,
                  transforms: json(parameter.transforms),
                })),
              },
              outputs: {
                create: step.outputs.map((output) => ({
                  name: output.name,
                  selector: output.selector,
                  transforms: json(output.transforms),
                  storeAs: output.storeAs,
                  required: output.required,
                })),
              },
            })) as Prisma.FlowStepCreateWithoutFlowInput[],
          },
        },
      }),
    ),
  );
  return created.map((flow) => ({ id: flow.id, phase: flow.phase }));
};

router.put("/gateway-versions/:vid/flows", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(gatewayFlowsSchema, request.body);
  const flows = await saveGatewayVersionFlows(vid, body.flows);
  response.json({ flows });
});

router.put("/gateway-versions/:vid/channels", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write", "security:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        channels: z
          .array(
            z
              .object({
                routeId: z.string().max(64).optional(),
                type: z.enum(["WEBHOOK", "RETURN_URL", "BROWSER_CALLBACK", "POLL", "STATEMENT", "OPERATOR"]),
                pathToken: z.string().min(8).max(120),
                verifyMethod: z.enum([
                  "HMAC_BODY",
                  "HASH_FIELDS",
                  "SORTED_VALUES_HASH",
                  "RSA",
                  "SHARED_TOKEN",
                  "IP_ONLY",
                  "NONE_PLUS_INQUIRY",
                ]),
                signatureHeader: z.string().max(120).optional(),
                timestampToleranceSec: z.number().int().min(30).max(86400).default(300),
                ipAllowlist: z.array(z.string().max(64)).max(50).default([]),
                bodyFormat: z.enum(["JSON", "FORM", "XML"]),
                correlationSelector: z.string().max(160).optional(),
                dedupeKeySelector: z.string().max(160).optional(),
                mustInquire: z.boolean().default(false),
                ackStatus: z.number().int().min(200).max(599).default(200),
                ackBodyTemplate: z.string().max(1000).optional(),
              }),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    request.body,
  );
  for (const channel of body.channels) {
    const weak = ["SHARED_TOKEN", "IP_ONLY", "RETURN_URL", "BROWSER_CALLBACK"].includes(channel.verifyMethod);
    if (weak && !channel.mustInquire) {
      throw new ApiError(
        400,
        "WEAK_CHANNEL_REQUIRES_INQUIRY",
        `Channel verification method '${channel.verifyMethod}' must set must_inquire`,
      );
    }
  }
  await client.confirmationChannel.deleteMany({ where: { gatewayVersionId: vid } });
  const channels = await Promise.all(
    body.channels.map((channel) =>
      client.confirmationChannel.create({
        data: {
          gatewayVersionId: vid,
          routeId: channel.routeId,
          type: channel.type,
          pathToken: channel.pathToken,
          verifyMethod: channel.verifyMethod,
          signatureHeader: channel.signatureHeader,
          timestampToleranceSec: channel.timestampToleranceSec,
          ipAllowlist: channel.ipAllowlist,
          bodyFormat: channel.bodyFormat,
          correlationSelector: channel.correlationSelector,
          dedupeKeySelector: channel.dedupeKeySelector,
          mustInquire: channel.mustInquire,
          ackStatus: channel.ackStatus,
          ackBodyTemplate: channel.ackBodyTemplate,
          eventMap: {},
        },
      }),
    ),
  );
  response.json({ channels: channels.map((channel) => ({ id: channel.id, pathToken: channel.pathToken })) });
});

router.put("/gateway-versions/:vid/status-rules", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        rules: z
          .array(
            z
              .object({
                phase: z.string().max(40),
                selector: z.string().max(160),
                op: z.enum(["equals", "not_equals", "in", "exists", "matches"]),
                value: z.unknown(),
                canonicalStatus: z.enum(["AWAITING_CUSTOMER", "VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN"]),
                canonicalSubstatus: z.string().max(80).optional(),
                canonicalError: z.string().max(80).optional(),
              }),
          )
          .min(1)
          .max(50),
        checklist: z.array(z.enum([
          "KEY_SCOPE_VERIFIED",
          "VALUE_SCHEMA_REVIEWED",
          "EFFECTIVE_DATE_REVIEWED",
          "IMMUTABLE_VERSION_ACKNOWLEDGED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  await client.statusRule.deleteMany({ where: { gatewayVersionId: vid } });
  const rules = await Promise.all(
    body.rules.map((rule, index) =>
      client.statusRule.create({
        data: {
          gatewayVersionId: vid,
          phase: rule.phase,
          orderIndex: index,
          selector: rule.selector,
          op: rule.op.toUpperCase() as never,
          valueJson: json(rule.value ?? null),
          canonicalStatus: rule.canonicalStatus,
          canonicalSubstatus: rule.canonicalSubstatus,
          canonicalError: rule.canonicalError,
        },
      }),
    ),
  );
  response.json({ rules: rules.map((rule) => ({ id: rule.id })) });
});

router.put("/gateway-versions/:vid/error-maps", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        maps: z
          .array(
            z
              .object({
                gatewayCode: z.string().min(1).max(80),
                canonicalError: z.string().min(1).max(80),
                classification: z.enum([
                  "RETRYABLE_OTP",
                  "TERMINAL_DECLINE",
                  "LIMIT_EXCEEDED",
                  "GATEWAY_FAULT",
                  "AMBIGUOUS",
                ]),
                retryable: z.boolean().default(false),
                countsTowardLockout: z.boolean().default(false),
                countsTowardBreaker: z.boolean().default(false),
                customerMessageAr: z.string().max(500).optional(),
                customerMessageEn: z.string().max(500).optional(),
                operatorHint: z.string().max(500).optional(),
              }),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    request.body,
  );
  await client.errorMap.deleteMany({ where: { gatewayVersionId: vid } });
  const maps = await Promise.all(
    body.maps.map((entry) =>
      client.errorMap.create({
        data: {
          gatewayVersionId: vid,
          gatewayCode: entry.gatewayCode,
          canonicalError: entry.canonicalError,
          classification: entry.classification,
          retryable: entry.retryable,
          countsTowardLockout: entry.countsTowardLockout,
          countsTowardBreaker: entry.countsTowardBreaker,
          customerMessageAr: entry.customerMessageAr,
          customerMessageEn: entry.customerMessageEn,
          operatorHint: entry.operatorHint,
        },
      }),
    ),
  );
  response.json({ maps: maps.map((entry) => ({ id: entry.id })) });
});

router.post("/gateway-versions/:vid/dry-run", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:test"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  const version = await loadVersion(vid);
  const body = parseOrThrow(
    z
      .object({
        railCode: z.string().max(64).optional(),
        amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        currency: z.string().length(3).optional(),
        checklist: z.array(z.enum([
          "CREDENTIAL_REFS_VERIFIED",
          "ENVIRONMENT_MATCH_REVIEWED",
          "SECRET_STORAGE_VERIFIED",
          "CREDENTIAL_CHECK_APPROVED",
          "PHASE_SELECTED",
          "SAMPLE_PAYLOAD_REVIEWED",
          "CREDENTIAL_CONTEXT_READY",
          "RESULT_INTERPRETATION_REVIEWED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const flows = await client.flow.findMany({
    where: { gatewayVersionId: vid },
    include: { steps: { orderBy: { orderIndex: "asc" } } },
  });
  const credentialChecklist = (body.checklist ?? []).some((entry) => entry.startsWith("CREDENTIAL_") || entry === "ENVIRONMENT_MATCH_REVIEWED" || entry === "SECRET_STORAGE_VERIFIED");
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: credentialChecklist ? "GATEWAY_CREDENTIAL_CHECK" : "GATEWAY_VERSION_DRY_RUN",
      entityType: "GATEWAY_VERSION",
      entityId: version.id,
      beforeJson: {},
      afterJson: { checklist: body.checklist ?? [] },
    },
  });
  response.json({
    gatewayVersionId: version.id,
    versionNumber: version.versionNumber,
    railCode: body.railCode ?? null,
    amount: body.amount ?? null,
    currency: body.currency ?? null,
    phases: flows.map((flow) => ({
      phase: flow.phase,
      steps: flow.steps.map((step) => ({
        orderIndex: step.orderIndex,
        type: step.type,
        sideEffect: step.sideEffect,
        retryPolicy: step.retryPolicy,
        pointOfNoReturn: step.pointOfNoReturn,
      })),
    })),
    executed: false,
    reason: "Dry run executes against the mock gateway inside the sandbox suite runner",
  });
});

router.post("/gateway-versions/:vid/run-suite", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:test"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  const version = await loadVersion(vid);
  const body = parseOrThrow(
    z.object({
      scenarios: z.array(z.string().max(64)).max(30).optional(),
      checklist: z.array(z.enum([
        "SUITE_SELECTED",
        "SANDBOX_ENV_VERIFIED",
        "EVIDENCE_CAPTURE_READY",
        "RESULTS_REVIEW_PLANNED",
      ])).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  // The evidence is collected from the database and from the sandbox suite
  // itself, and it is persisted: the activation reads it back instead of
  // trusting a set of constants.
  const evidence = await collectGoLiveEvidence(vid);
  await persistGoLiveEvidence(vid, evidence);
  const gates = new GoLiveGateValidator();
  const checker = await client.approvalRequest.findFirst({
    where: { subjectType: "GATEWAY_VERSION", subjectId: vid, checkerUserId: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  const report = await gates.validate({
    makerUserId: version.createdById,
    checkerUserId: checker?.checkerUserId ?? "",
    ...evidence,
  });
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "GATEWAY_SANDBOX_SUITE_RUN",
      entityType: "GATEWAY_VERSION",
      entityId: version.id,
      beforeJson: {},
      afterJson: { scenarios: body.scenarios ?? [], checklist: body.checklist ?? [] },
    },
  });
  response.json({
    gatewayVersionId: version.id,
    requestedScenarios: body.scenarios ?? [],
    evidence,
    report,
  });
});

router.post("/gateway-versions/:vid/submit-approval", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  const body = parseOrThrow(
    z.object({
      reason: z.string().min(3).max(500).optional(),
      checklist: z.array(z.enum([
        "GATES_REVIEWED",
        "EVIDENCE_VERIFIED",
        "ROLLBACK_READY",
        "CHECKER_INDEPENDENCE_CONFIRMED",
      ])).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  const version = await loadVersion(vid);
  const actor = actorFromRequest(request);
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "GATEWAY_VERSION",
      subjectId: version.id,
      payloadDiffJson: { gatewayVersionId: version.id, reason: body.reason ?? null, checklist: body.checklist ?? [] },
      mode: "STANDARD",
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  await client.gatewayVersion.update({
    where: { id: version.id },
    data: { state: "PENDING_APPROVAL", approvalRequestId: approval.id },
  });
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "GATEWAY_VERSION_APPROVAL_SUBMITTED",
      entityType: "GATEWAY_VERSION",
      entityId: version.id,
      beforeJson: { state: version.state },
      afterJson: { state: "PENDING_APPROVAL", reason: body.reason ?? null, checklist: body.checklist ?? [] },
      approvalRequestId: approval.id,
    },
  });
  response.status(202).json({ status: "PENDING_APPROVAL", approvalRequestId: approval.id });
});

/* ------------------------------------------------------------------ *
 * The go-live evidence of design v5 §14
 * ------------------------------------------------------------------ */

/**
 * The result of one contract test.
 */
interface ContractResult {
  passed: boolean;
  details: string[];
}

/**
 * The evidence the twelve go-live gates consume.
 *
 * Every field is collected from the database or from the sandbox suite, so
 * the gate decision is a decision about recorded facts.
 */
interface GoLiveEvidenceRecord {
  scenarioResults: { scenario: string; passed: boolean; details?: string }[];
  amountPipelineContractPassed: boolean;
  referenceFormatContractPassed: boolean;
  cryptographicSignatureContractPassed: boolean;
  channels: ChannelVerificationEvidence[];
  rollbackVersionId: string | null;
  routeLimitsPreviewed: boolean;
  commissionProfilePreviewed: boolean;
  statementParserPreviewed: boolean;
  evidenceLevel: "VERIFIED" | "INTERNAL" | "UNVERIFIED" | "PARTIAL" | "HIGH_RISK";
  internalContractSuitePassed: boolean;
  highRiskExecutiveAcceptanceSigned: boolean;
  panFieldCount: number;
  pciScopeReviewPassed: boolean;
  canaryTrafficPlanConfigured: boolean;
  routeAlertsConfigured: boolean;
  runbooksConfigured: boolean;
  /** The findings of the contract tests, for the operator panel. */
  contractDetails: Record<string, string[]>;
}

const AMOUNT_PIPELINE_SCALES = [1, 100, 1000];
const AMOUNT_PIPELINE_PRECISIONS = [0, 1, 2, 3, 4];
const AMOUNT_PIPELINE_ROUNDINGS = ["NONE", "NEAREST", "UP", "DOWN"];
const AMOUNT_PIPELINE_FORMATS = ["STRING_DECIMAL", "INTEGER_MINOR_UNITS", "NUMBER"];
/** The platform stores money with four decimals (design v5 §7 rule 6). */
const PLATFORM_MONEY_PRECISION = 4;

const CRYPTO_ALGORITHMS = ["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"];
const CRYPTO_CANONICALIZATIONS = [
  "MOAMALAT_SECURE_HASH",
  "DPAY_WEBHOOK_VERIFY",
  "PLUTU_CALLBACK_HASH",
  "MYPAY_RAW_BODY",
  "SORTED_KEY_VALUE_AMP",
  "TIMESTAMP_DOT_RAW_BODY",
  "SORTED_VALUES_HASH",
  "TEMPLATE_STRING",
  "JSON_CANONICAL",
  "RAW_BODY",
];
const CRYPTO_KEY_ENCODINGS = ["UTF8", "HEX", "BASE64"];
const CRYPTO_OUTPUT_ENCODINGS = ["HEX_LOWER", "HEX_UPPER", "BASE64"];

const CANONICAL_AMOUNT = "100.0000";
const CANONICAL_REFERENCE = "PA-CONTRACT-0001";

/**
 * Rounds an amount to the precision of the gateway.
 *
 * The arithmetic is exact: no floating point is involved at any point of the
 * money pipeline.
 */
const roundAmount = (
  value: Decimal,
  precision: number,
  rounding: string,
): Decimal => {
  const factor = decimal(10).pow(precision);
  if (rounding === "NONE") {
    return value;
  }
  const scaled = value.mul(factor);
  if (rounding === "UP") {
    return scaled.ceil().div(factor);
  }
  if (rounding === "DOWN") {
    return scaled.floor().div(factor);
  }
  return scaled.round().div(factor);
};

/**
 * Contract test of gate 3: the amount pipeline of the gateway version.
 *
 * The pipeline has to be exact, reversible and inside the closed sets of the
 * design. A gateway that asks for more decimals than the platform stores, or
 * a scale that produces fractional minor units, fails the contract.
 */
const runAmountPipelineContract = (setting: {
  amountScale: number;
  amountPrecision: number;
  amountRounding: string;
  amountFormat: string;
} | null): ContractResult => {
  const details: string[] = [];
  if (!setting) {
    return { passed: false, details: ["The gateway version has no settings"] };
  }
  const scale = Number(setting.amountScale);
  const precision = Number(setting.amountPrecision);
  const rounding = String(setting.amountRounding ?? "NONE").toUpperCase();
  const format = String(setting.amountFormat ?? "STRING_DECIMAL").toUpperCase();
  if (!AMOUNT_PIPELINE_SCALES.includes(scale)) {
    details.push(`The amount scale '${scale}' is not one of ${AMOUNT_PIPELINE_SCALES.join(", ")}`);
  }
  if (!AMOUNT_PIPELINE_PRECISIONS.includes(precision)) {
    details.push(`The amount precision '${precision}' is not a number of decimals`);
  }
  if (precision > PLATFORM_MONEY_PRECISION) {
    details.push(
      `The gateway asks for ${precision} decimals while the platform stores ${PLATFORM_MONEY_PRECISION}`,
    );
  }
  if (!AMOUNT_PIPELINE_ROUNDINGS.includes(rounding)) {
    details.push(`The amount rounding '${rounding}' is not one of ${AMOUNT_PIPELINE_ROUNDINGS.join(", ")}`);
  }
  if (!AMOUNT_PIPELINE_FORMATS.includes(format)) {
    details.push(`The amount format '${format}' is not one of ${AMOUNT_PIPELINE_FORMATS.join(", ")}`);
  }
  if (details.length > 0) {
    return { passed: false, details };
  }
  for (const canonical of [CANONICAL_AMOUNT, "10.5000", "0.0100"]) {
    const value = decimal(canonical);
    const rounded = roundAmount(value, precision, rounding);
    if (rounding === "NONE" && !rounded.eq(value)) {
      details.push(`The amount ${canonical} is not representable with ${precision} decimals and the rounding is NONE`);
      continue;
    }
    const minorUnits = rounded.mul(scale);
    if (!minorUnits.isInteger()) {
      details.push(`The scaled amount of ${canonical} is not a whole number of minor units`);
      continue;
    }
    if (!minorUnits.div(scale).eq(rounded)) {
      details.push(`The amount pipeline is not reversible for ${canonical}`);
      continue;
    }
    if (format === "INTEGER_MINOR_UNITS" && !minorUnits.isInteger()) {
      details.push(`The amount ${canonical} cannot be sent as integer minor units`);
    }
  }
  return { passed: details.length === 0, details };
};

/**
 * Renders the reference of an attempt with the reference format of the
 * gateway version.
 */
const renderReference = (template: string, prefix: string, reference: string): string => {
  const rendered = template
    .replace(/\{attempt\.reference\}/g, reference)
    .replace(/\{reference\}/g, reference);
  return rendered.startsWith(prefix) ? rendered : `${prefix}${rendered}`;
};

/**
 * Contract test of gate 4: the reference format of the gateway version.
 *
 * The format has to carry a prefix, a template and a pattern, and the
 * rendered reference has to match the pattern of the gateway.
 */
const runReferenceFormatContract = (
  setting: { referenceFormat: unknown } | null,
): ContractResult => {
  const details: string[] = [];
  if (!setting) {
    return { passed: false, details: ["The gateway version has no settings"] };
  }
  const format = (setting.referenceFormat ?? {}) as Record<string, unknown>;
  const prefix = typeof format.prefix === "string" ? format.prefix : "";
  const template = typeof format.template === "string" ? format.template : "";
  const pattern = typeof format.pattern === "string" ? format.pattern : "";
  if (!prefix) {
    details.push("The reference format has no prefix");
  }
  if (!template) {
    details.push("The reference format has no template");
  }
  if (!pattern) {
    details.push("The reference format has no pattern");
  }
  if (details.length > 0) {
    return { passed: false, details };
  }
  const rendered = renderReference(template, prefix, CANONICAL_REFERENCE);
  if (!rendered.startsWith(prefix)) {
    details.push(`The rendered reference '${rendered}' does not start with the prefix '${prefix}'`);
  }
  let matches = false;
  try {
    matches = new RegExp(pattern).test(rendered);
  } catch {
    details.push(`The reference pattern '${pattern}' is not a valid regular expression`);
  }
  if (!matches) {
    details.push(`The rendered reference '${rendered}' does not match '${pattern}'`);
  }
  return { passed: details.length === 0, details };
};

/**
 * Contract test of gate 5: the cryptographic profiles of the gateway version.
 *
 * Every profile has to be complete, and every signing step has to reference
 * a profile that exists.
 */
const runCryptoSignatureContract = (
  profiles: readonly {
    id: string;
    name: string;
    purpose: string;
    algorithm: string;
    secretKeyRef: string | null;
    secretKeyEncoding: string;
    canonicalizationMode: string;
    outputEncoding: string;
  }[],
  signingProfileIds: readonly string[],
): ContractResult => {
  const details: string[] = [];
  if (profiles.length === 0) {
    details.push("The gateway version has no cryptographic profile");
  }
  for (const profile of profiles) {
    if (!CRYPTO_ALGORITHMS.includes(profile.algorithm)) {
      details.push(`The profile '${profile.name}' uses the unknown algorithm '${profile.algorithm}'`);
    }
    if (!CRYPTO_CANONICALIZATIONS.includes(profile.canonicalizationMode)) {
      details.push(
        `The profile '${profile.name}' uses the unknown canonicalization '${profile.canonicalizationMode}'`,
      );
    }
    if (!CRYPTO_KEY_ENCODINGS.includes(profile.secretKeyEncoding)) {
      details.push(
        `The profile '${profile.name}' uses the unknown key encoding '${profile.secretKeyEncoding}'`,
      );
    }
    if (!CRYPTO_OUTPUT_ENCODINGS.includes(profile.outputEncoding)) {
      details.push(
        `The profile '${profile.name}' uses the unknown output encoding '${profile.outputEncoding}'`,
      );
    }
    if (profile.purpose === "OUTBOUND_SIGN" && !profile.secretKeyRef) {
      details.push(`The signing profile '${profile.name}' has no secret key reference`);
    }
  }
  for (const profileId of signingProfileIds) {
    if (!profiles.some((profile) => profile.id === profileId)) {
      details.push(`A signing step references the unknown crypto profile '${profileId}'`);
    }
  }
  return { passed: details.length === 0, details };
};

const sandboxAttempt = (
  scenario: MockScenario,
  overrides: Partial<AdapterAttempt> = {},
): AdapterAttempt => ({
  id: `sandbox-${scenario}`,
  reference: `PA-SANDBOX-${scenario}`,
  status: "CREATED",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: CANONICAL_AMOUNT,
  totalChargedAmount: CANONICAL_AMOUNT,
  maxOtpAttempts: 3,
  context: { scenario },
  ...overrides,
});

const scenarioFailure = (message: string): Error => new Error(message);

/**
 * Runs one scenario of the sandbox suite.
 *
 * The scenario is not a snapshot of a happy path: every scenario asserts the
 * behaviour the platform has to show, so a gateway that answers wrongly (a
 * mismatching amount, a webhook of the wrong environment, an out of order
 * webhook) is detected by the suite.
 */
const runSandboxScenario = async (
  mock: MockGatewayServer,
  scenario: MockScenario,
): Promise<string> => {
  const attempt = sandboxAttempt(scenario);
  if (scenario === "CANCEL") {
    const cancelled = await mock.initiate(attempt, { phone: "+218910000000" });
    if (cancelled.status !== "CANCELLED") {
      throw scenarioFailure(`the initiation ended in '${cancelled.status}' instead of 'CANCELLED'`);
    }
    return "the initiation was cancelled";
  }
  const initiated = await mock.initiate(attempt, { phone: "+218910000000" });
  if (initiated.status !== "AWAITING_CUSTOMER") {
    throw scenarioFailure(`the initiation ended in '${initiated.status}' instead of 'AWAITING_CUSTOMER'`);
  }
  const confirmed = async (evidence: Record<string, unknown>) =>
    mock.confirm(initiated.attempt, evidence);

  switch (scenario) {
    case "HAPPY_PATH": {
      const result = await confirmed({ otp: "1234" });
      if (result.status !== "SUCCEEDED") {
        throw scenarioFailure(`the confirmation ended in '${result.status}' instead of 'SUCCEEDED'`);
      }
      const settled = decimal(String((result.outputs.response as { amount?: string } | undefined)?.amount ?? "0"));
      if (!settled.eq(decimal(CANONICAL_AMOUNT))) {
        throw scenarioFailure(`the confirmed amount '${settled.toFixed(4)}' is not the charged amount`);
      }
      return "the payment succeeded with the charged amount";
    }
    case "WRONG_OTP_RETRY_SUCCESS": {
      const first = await confirmed({ otp: "0000" });
      if (first.status !== "AWAITING_CUSTOMER" || first.canonicalError !== "RETRYABLE_OTP") {
        throw scenarioFailure("the wrong OTP was not reported as a retryable OTP");
      }
      const second = await confirmed({ otp: "1234" });
      if (second.status !== "SUCCEEDED") {
        throw scenarioFailure(`the second confirmation ended in '${second.status}' instead of 'SUCCEEDED'`);
      }
      return "the wrong OTP was retried and the retry succeeded";
    }
    case "EXPIRED_OTP":
    case "INSUFFICIENT_FUNDS":
    case "CUSTOMER_LIMIT_HIT": {
      const result = await confirmed({ otp: "1234" });
      if (result.status !== "FAILED") {
        throw scenarioFailure(`the confirmation ended in '${result.status}' instead of 'FAILED'`);
      }
      if (!result.canonicalError) {
        throw scenarioFailure("the failure carried no canonical error");
      }
      return `the confirmation failed with '${result.canonicalError}'`;
    }
    case "CONFIRM_5XX":
    case "CONFIRM_TIMEOUT": {
      let uncertain = false;
      try {
        await confirmed({ otp: "1234" });
      } catch (error) {
        uncertain = error instanceof ApiConsumerError && error.moneyUncertain === true;
      }
      if (!uncertain) {
        throw scenarioFailure("the uncertain outcome of the gateway was not detected");
      }
      return "the uncertain outcome of the gateway was detected";
    }
    case "MALFORMED_RESPONSE": {
      const result = await confirmed({ otp: "1234" });
      if (result.status !== "UNKNOWN") {
        throw scenarioFailure(`the malformed answer ended in '${result.status}' instead of 'UNKNOWN'`);
      }
      return "the malformed answer was held as UNKNOWN";
    }
    case "AMOUNT_MISMATCH": {
      const result = await confirmed({ otp: "1234" });
      const settled = decimal(String((result.outputs.response as { amount?: string } | undefined)?.amount ?? "0"));
      if (settled.eq(decimal(CANONICAL_AMOUNT))) {
        throw scenarioFailure("the mismatching amount was not detected");
      }
      return "the mismatching amount was detected";
    }
    case "THREE_DECIMAL_ROUNDING": {
      const rounded = roundAmount(decimal(CANONICAL_AMOUNT), 3, "NONE");
      if (!rounded.eq(decimal(CANONICAL_AMOUNT))) {
        throw scenarioFailure("the three decimal amount was not preserved");
      }
      const result = await confirmed({ otp: "1234" });
      if (result.status !== "SUCCEEDED") {
        throw scenarioFailure(`the confirmation ended in '${result.status}' instead of 'SUCCEEDED'`);
      }
      return "the three decimal amount was preserved";
    }
    case "DUPLICATE_WEBHOOK": {
      const first = await mock.verifyCallback("webhook", {
        attemptId: attempt.id,
        scenario,
        dedupeKey: `${scenario}:${attempt.id}`,
        reference: attempt.reference,
        amount: CANONICAL_AMOUNT,
        currency: "LYD",
        environment: "SANDBOX",
      });
      if (first.status !== "SUCCEEDED") {
        throw scenarioFailure(`the webhook ended in '${first.status}' instead of 'SUCCEEDED'`);
      }
      const second = await mock.verifyCallback("webhook", {
        attemptId: attempt.id,
        scenario,
        dedupeKey: `${scenario}:${attempt.id}`,
        reference: attempt.reference,
        amount: CANONICAL_AMOUNT,
        currency: "LYD",
        environment: "SANDBOX",
      });
      if (second.outputs.duplicate !== true) {
        throw scenarioFailure("the duplicated webhook was not detected");
      }
      return "the duplicated webhook was detected";
    }
    case "OUT_OF_ORDER_WEBHOOK": {
      const result = await mock.verifyCallback("webhook", {
        attemptId: attempt.id,
        scenario,
        dedupeKey: `${scenario}:${attempt.id}`,
        reference: attempt.reference,
        amount: CANONICAL_AMOUNT,
        currency: "LYD",
        environment: "SANDBOX",
      });
      if (result.status !== "VERIFYING") {
        throw scenarioFailure(`the out of order webhook ended in '${result.status}' instead of 'VERIFYING'`);
      }
      return "the out of order webhook was held for verification";
    }
    case "LATE_WEBHOOK_AFTER_EXPIRY": {
      const result = await mock.verifyCallback("webhook", {
        attemptId: attempt.id,
        scenario,
        dedupeKey: `${scenario}:${attempt.id}`,
        reference: attempt.reference,
        amount: CANONICAL_AMOUNT,
        currency: "LYD",
        environment: "SANDBOX",
      });
      if (result.status !== "SUCCEEDED") {
        throw scenarioFailure(`the late webhook ended in '${result.status}' instead of 'SUCCEEDED'`);
      }
      if (result.outputs.scenario !== "LATE_SUCCESS") {
        throw scenarioFailure("the late webhook was not reported as a late success");
      }
      return "the late webhook was recovered";
    }
    case "CROSS_ENVIRONMENT_WEBHOOK": {
      const result = await mock.verifyCallback("webhook", {
        attemptId: attempt.id,
        scenario,
        dedupeKey: `${scenario}:${attempt.id}`,
        reference: attempt.reference,
        amount: CANONICAL_AMOUNT,
        currency: "LYD",
        environment: "LIVE",
      });
      const response = result.outputs.response as { environment?: string } | undefined;
      if (response?.environment === attempt.env) {
        throw scenarioFailure("the webhook of the wrong environment was not detected");
      }
      return "the webhook of the wrong environment was detected";
    }
    default:
      throw scenarioFailure(`The scenario '${scenario}' is not part of the sandbox suite`);
  }
};

/**
 * The fifteen scenarios of the sandbox suite (design v5 §14 gate 2).
 */
const runSandboxScenarioSuite = async (): Promise<
  { scenario: string; passed: boolean; details?: string }[]
> => {
  const mock = new MockGatewayServer();
  const results: { scenario: string; passed: boolean; details?: string }[] = [];
  for (const scenario of MOCK_SCENARIOS) {
    try {
      const details = await runSandboxScenario(mock, scenario);
      results.push({ scenario, passed: true, details });
    } catch (error) {
      results.push({
        scenario,
        passed: false,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
};

/**
 * The operational go-live configuration of a gateway.
 *
 * It is operator provided configuration in the platform settings, so the
 * gates read what the operator actually configured and never a constant.
 */
const goLiveSettingKey = (gatewayCode: string, aspect: string): string =>
  `gateway.go_live.${gatewayCode}.${aspect}`;

const readGoLiveSetting = async (
  gatewayCode: string,
  aspect: string,
): Promise<Record<string, unknown> | null> => {
  const setting = await client.platformSetting.findFirst({
    where: { key: goLiveSettingKey(gatewayCode, aspect), scope: "PLATFORM" },
    orderBy: { version: "desc" },
  });
  const value = setting?.valueJson;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const isConfigured = (value: Record<string, unknown> | null): boolean =>
  value !== null && Object.keys(value).length > 0;

/**
 * Collects the go-live evidence of a gateway version.
 *
 * The scenario suite is executed against the sandbox gateway, the contract
 * tests are executed against the configuration of the version and the
 * operational evidence is read from the platform settings.
 */
const collectGoLiveEvidence = async (versionId: string): Promise<GoLiveEvidenceRecord> => {
  const version = await client.gatewayVersion.findUnique({
    where: { id: versionId },
    include: { setting: true },
  });
  if (!version) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  const gateway = await client.gateway.findUnique({ where: { id: version.gatewayId } });
  const gatewayCode = gateway?.code ?? "";
  const channels = await client.confirmationChannel.findMany({
    where: { gatewayVersionId: versionId },
  });
  const profiles = await client.cryptoProfile.findMany({
    where: { gatewayVersionId: versionId },
  });
  const flows = await client.flow.findMany({
    where: { gatewayVersionId: versionId },
    include: { steps: { include: { parameters: true } } },
  });
  const signingProfileIds = flows.flatMap((flow) =>
    flow.steps.flatMap((step) =>
      step.parameters
        .filter((parameter) => parameter.source === "CRYPTO_SIGNATURE")
        .map((parameter) => parameter.cryptoProfileId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const routes = await client.railRoute.findMany({ where: { gatewayId: version.gatewayId } });
  const rails = await client.rail.findMany({
    where: { routes: { some: { gatewayId: version.gatewayId } } },
    include: { fields: true },
  });
  const railCodes = rails.map((rail) => rail.code);
  const commissionProfiles = await client.commissionProfile.findMany({
    where: { railCode: { in: railCodes } },
  });
  const sources = await client.statementSource.findMany({
    where: { gatewayId: version.gatewayId },
  });
  const panFieldCount = rails.reduce(
    (total, rail) => total + rail.fields.filter((field) => field.sensitivity === "PAN").length,
    0,
  );

  const amountContract = runAmountPipelineContract(version.setting);
  const referenceContract = runReferenceFormatContract(version.setting);
  const cryptoContract = runCryptoSignatureContract(profiles, signingProfileIds);
  const scenarioResults = await runSandboxScenarioSuite();

  const canaryPlan = await readGoLiveSetting(gatewayCode, "canary_traffic_plan");
  const routeAlerts = await readGoLiveSetting(gatewayCode, "route_alerts");
  const runbooks = await readGoLiveSetting(gatewayCode, "runbooks");
  const pciReview = await readGoLiveSetting(gatewayCode, "pci_scope_review");
  const executiveAcceptance = await readGoLiveSetting(gatewayCode, "executive_acceptance");

  const evidenceLevel: GoLiveEvidenceRecord["evidenceLevel"] =
    gateway?.verificationState === "VERIFIED"
      ? "VERIFIED"
      : gateway?.kind === "INTERNAL"
        ? "INTERNAL"
        : gateway?.riskClass === "HIGH_RISK"
          ? "HIGH_RISK"
          : "UNVERIFIED";

  return {
    scenarioResults,
    amountPipelineContractPassed: amountContract.passed,
    referenceFormatContractPassed: referenceContract.passed,
    cryptographicSignatureContractPassed: cryptoContract.passed,
    channels: channels.map((channel) => ({
      type: channel.type,
      verificationMethod: channel.verifyMethod,
      mustInquire: channel.mustInquire,
    })) as ChannelVerificationEvidence[],
    rollbackVersionId: version.rollbackVersionId,
    routeLimitsPreviewed:
      routes.length > 0 && routes.every((route) => route.minAmount !== null && route.maxAmount !== null),
    commissionProfilePreviewed:
      railCodes.length > 0 && railCodes.every((code) => commissionProfiles.some((profile) => profile.railCode === code)),
    statementParserPreviewed: sources.some((source) => {
      const parser = source.parserConfig as Record<string, unknown> | null;
      return Boolean(parser) && Object.keys(parser as Record<string, unknown>).length > 0;
    }),
    evidenceLevel,
    internalContractSuitePassed:
      amountContract.passed && referenceContract.passed && cryptoContract.passed,
    highRiskExecutiveAcceptanceSigned: executiveAcceptance?.signed === true,
    panFieldCount,
    pciScopeReviewPassed: pciReview?.reviewed === true,
    canaryTrafficPlanConfigured: isConfigured(canaryPlan),
    routeAlertsConfigured: isConfigured(routeAlerts),
    runbooksConfigured: isConfigured(runbooks),
    contractDetails: {
      amountPipeline: amountContract.details,
      referenceFormat: referenceContract.details,
      cryptographicSignature: cryptoContract.details,
    },
  };
};

/**
 * Persists the go-live evidence of a gateway version, so that the activation
 * reads the recorded facts back.
 */
const persistGoLiveEvidence = async (
  versionId: string,
  evidence: GoLiveEvidenceRecord,
): Promise<void> => {
  await client.gatewayVersionEvidence.upsert({
    where: { gatewayVersionId: versionId },
    update: { evidenceJson: json(evidence), ranAt: new Date() },
    create: { gatewayVersionId: versionId, evidenceJson: json(evidence), ranAt: new Date() },
  });
};

/**
 * The named rollback version of a gateway version.
 *
 * Design v5 §14 gate 7: a version that may become live names the version the
 * gateway falls back to. Without it the gate can never be satisfied, so the
 * rollback version is part of the version configuration.
 */
router.put("/gateway-versions/:vid/rollback-version", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { vid } = parseOrThrow(versionParamsSchema, request.params);
  const version = await loadVersion(vid);
  const body = parseOrThrow(
    z.object({ versionId: z.string().min(1).max(64) }).strict(),
    request.body,
  );
  const target = await client.gatewayVersion.findUnique({ where: { id: body.versionId } });
  if (!target || target.gatewayId !== version.gatewayId) {
    throw new ApiError(
      404,
      "GATEWAY_VERSION_NOT_FOUND",
      "The rollback version does not belong to the gateway of this version",
    );
  }
  if (target.versionNumber >= version.versionNumber) {
    throw new ApiError(
      400,
      "ROLLBACK_VERSION_INVALID",
      "The rollback version must be an older version of the gateway",
    );
  }
  const updated = await client.gatewayVersion.update({
    where: { id: version.id },
    data: { rollbackVersionId: target.id },
  });
  response.json({ id: updated.id, rollbackVersionId: updated.rollbackVersionId });
});

router.get("/rails", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["code", "nameEn", "nameAr"],
    equals: { collectionMode: "collectionMode", currency: "currency" },
    booleans: { blocked: "blocked" },
    ranges: { amount: { path: "minAmount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { code: "code", nameEn: "nameEn", collectionMode: "collectionMode", currency: "currency", status: "blocked" },
    defaultSort: { displayOrder: "asc" },
  });
  const [rails, total] = await Promise.all([
    client.rail.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        fields: true,
        _count: { select: { routes: true, flows: true, paymentAttempts: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.rail.count({ where: built.where as never }),
  ]);
  const railIds = rails.map((rail) => rail.id);
  const routeHealth = railIds.length === 0
    ? []
    : await client.railRoute.groupBy({
        by: ["railId", "healthState", "status"],
        where: { railId: { in: railIds } },
        _count: { _all: true },
      });
  const healthMap = new Map<string, { healthy: number; degraded: number; openBreaker: number; active: number }>();
  for (const row of routeHealth) {
    const current = healthMap.get(row.railId) ?? { healthy: 0, degraded: 0, openBreaker: 0, active: 0 };
    if (row.healthState === "HEALTHY") current.healthy += row._count._all;
    else if (row.healthState === "DEGRADED") current.degraded += row._count._all;
    else if (row.healthState === "OPEN_BREAKER") current.openBreaker += row._count._all;
    if (row.status === "ACTIVE") current.active += row._count._all;
    healthMap.set(row.railId, current);
  }
  response.json(listResponse(
    "rails",
    rails.map((rail) => ({
      ...rail,
      fieldCount: rail.fields.length,
      routeCount: rail._count.routes,
      flowCount: rail._count.flows,
      paymentAttemptCount: rail._count.paymentAttempts,
      routeHealth: healthMap.get(rail.id) ?? { healthy: 0, degraded: 0, openBreaker: 0, active: 0 },
    })),
    total,
    built,
  ));
});

router.get("/rails/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["code", "nameEn", "nameAr"],
    equals: { collectionMode: "collectionMode", currency: "currency" },
    booleans: { blocked: "blocked" },
    ranges: { amount: { path: "minAmount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { code: "code", nameEn: "nameEn", collectionMode: "collectionMode", currency: "currency", status: "blocked" },
    defaultSort: { displayOrder: "asc" },
  });
  const take = 5000;
  const [rails, total] = await Promise.all([
    client.rail.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        fields: true,
        _count: { select: { routes: true, flows: true, paymentAttempts: true } },
      },
      take,
    }),
    client.rail.count({ where: built.where as never }),
  ]);
  const railIds = rails.map((rail) => rail.id);
  const routeHealth = railIds.length === 0
    ? []
    : await client.railRoute.groupBy({
        by: ["railId", "healthState", "status"],
        where: { railId: { in: railIds } },
        _count: { _all: true },
      });
  const healthMap = new Map<string, { healthy: number; degraded: number; openBreaker: number; active: number }>();
  for (const row of routeHealth) {
    const current = healthMap.get(row.railId) ?? { healthy: 0, degraded: 0, openBreaker: 0, active: 0 };
    if (row.healthState === "HEALTHY") current.healthy += row._count._all;
    else if (row.healthState === "DEGRADED") current.degraded += row._count._all;
    else if (row.healthState === "OPEN_BREAKER") current.openBreaker += row._count._all;
    if (row.status === "ACTIVE") current.active += row._count._all;
    healthMap.set(row.railId, current);
  }
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "RAILS_EXPORTED",
      entityType: "RAIL",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: rails.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    rails: rails.map((rail) => ({
      id: rail.id,
      code: rail.code,
      nameAr: rail.nameAr,
      nameEn: rail.nameEn,
      collectionMode: rail.collectionMode,
      currency: rail.currency,
      minAmount: merchantMoney(rail.minAmount),
      maxAmount: merchantMoney(rail.maxAmount),
      blocked: rail.blocked,
      displayOrder: rail.displayOrder,
      fieldCount: rail.fields.length,
      routeCount: rail._count.routes,
      flowCount: rail._count.flows,
      paymentAttemptCount: rail._count.paymentAttempts,
      routeHealth: healthMap.get(rail.id) ?? { healthy: 0, degraded: 0, openBreaker: 0, active: 0 },
      createdAt: rail.createdAt,
      updatedAt: rail.updatedAt,
    })),
    total,
    exported: rails.length,
    truncated: total > rails.length,
  });
});

const buildRailSummary = async () => {
  const [total, blocked, modeRows, routeHealthRows] = await Promise.all([
    client.rail.count(),
    client.rail.count({ where: { blocked: true } }),
    client.rail.groupBy({ by: ["collectionMode"], _count: { _all: true } }),
    client.railRoute.groupBy({ by: ["healthState"], _count: { _all: true } }),
  ]);
  const byMode: Record<string, number> = {};
  for (const row of modeRows) byMode[row.collectionMode] = row._count._all;
  const routeHealth: Record<string, number> = {};
  for (const row of routeHealthRows) routeHealth[row.healthState] = row._count._all;
  return {
    total,
    active: total - blocked,
    blocked,
    byMode,
    routes: {
      healthy: routeHealth.HEALTHY ?? 0,
      degraded: routeHealth.DEGRADED ?? 0,
      openBreaker: routeHealth.OPEN_BREAKER ?? 0,
    },
  };
};

router.get("/rails/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  response.json(await buildRailSummary());
});

router.get("/rails/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const summary = await buildRailSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "RAIL_SCOPE_VERIFIED",
    "COLLECTION_MODE_REVIEWED",
    "ROUTE_HEALTH_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "RAIL_SUMMARY_EXPORTED",
      entityType: "RAIL",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: summary.total,
        active: summary.active,
        blocked: summary.blocked,
        routes: summary.routes,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/rails/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const rail = await client.rail.findUnique({ where: { id }, include: { fields: true, routes: true } });
  if (!rail) {
    throw new ApiError(404, "RAIL_NOT_FOUND", "The rail does not exist");
  }
  response.json({ rail });
});

router.post("/rails", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const body = parseOrThrow(
    z
      .object({
        code: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/),
        nameAr: z.string().min(1).max(160),
        nameEn: z.string().min(1).max(160),
        collectionMode: z.enum([
          "OTP_PULL",
          "REDIRECT",
          "EMBEDDED",
          "PUSH_APPROVAL",
          "QR_DISPLAY",
          "PAY_CODE",
          "DEEP_LINK",
          "MANUAL",
          "HYBRID",
        ]),
        subModes: z.array(z.string().max(64)).max(20).optional(),
        currency: z.string().length(3).default("LYD"),
        minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
        maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        displayOrder: z.number().int().min(0).max(9999).default(0),
        capabilities: z.record(z.string().max(40), z.boolean()).default({}),
        refundWindowDays: z.number().int().min(0).max(3650).optional(),
        instructionsAr: z.string().max(2000).optional(),
        instructionsEn: z.string().max(2000).optional(),
      })
      .strict(),
    request.body,
  );
  const rail = await client.rail.create({
    data: {
      code: body.code,
      nameAr: body.nameAr,
      nameEn: body.nameEn,
      collectionMode: body.collectionMode,
      subModes: jsonOptional(body.subModes),
      currency: body.currency.toUpperCase(),
      minAmount: new Prisma.Decimal(body.minAmount),
      maxAmount: body.maxAmount ? new Prisma.Decimal(body.maxAmount) : null,
      displayOrder: body.displayOrder,
      capabilities: body.capabilities,
      refundWindowDays: body.refundWindowDays,
      instructionsAr: body.instructionsAr,
      instructionsEn: body.instructionsEn,
    },
  });
  response.status(201).json({ id: rail.id, code: rail.code });
});

router.patch("/rails/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        nameAr: z.string().min(1).max(160).optional(),
        nameEn: z.string().min(1).max(160).optional(),
        blocked: z.boolean().optional(),
        displayOrder: z.number().int().min(0).max(9999).optional(),
        minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        capabilities: z.record(z.string().max(40), z.boolean()).optional(),
        instructionsAr: z.string().max(2000).optional(),
        instructionsEn: z.string().max(2000).optional(),
        // null clears the logo; a uuid must reference a registered asset.
        logoAssetId: z.string().uuid().nullable().optional(),
        checklist: z.array(z.enum([
          "NAMES_VERIFIED",
          "LIMITS_VERIFIED",
          "INSTRUCTIONS_REVIEWED",
          "AVAILABILITY_IMPACT_REVIEWED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const rail = await client.rail.findUnique({ where: { id } });
  if (!rail) {
    throw new ApiError(404, "RAIL_NOT_FOUND", "The rail does not exist");
  }
  if (body.logoAssetId) {
    const asset = await client.asset.findUnique({ where: { id: body.logoAssetId }, select: { id: true } });
    if (!asset) throw new ApiError(404, "ASSET_NOT_FOUND", "The logo asset does not exist");
  }
  const updated = await client.rail.update({
    where: { id },
    data: {
      logoAssetId: body.logoAssetId,
      nameAr: body.nameAr,
      nameEn: body.nameEn,
      blocked: body.blocked,
      displayOrder: body.displayOrder,
      minAmount: body.minAmount ? new Prisma.Decimal(body.minAmount) : undefined,
      maxAmount: body.maxAmount ? new Prisma.Decimal(body.maxAmount) : undefined,
      capabilities: body.capabilities,
      instructionsAr: body.instructionsAr,
      instructionsEn: body.instructionsEn,
    },
  });
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "RAIL_UPDATED",
      entityType: "RAIL",
      entityId: updated.id,
      beforeJson: { nameAr: rail.nameAr, nameEn: rail.nameEn, blocked: rail.blocked, minAmount: String(rail.minAmount), maxAmount: String(rail.maxAmount), logoAssetId: rail.logoAssetId },
      afterJson: { nameAr: updated.nameAr, nameEn: updated.nameEn, blocked: updated.blocked, minAmount: String(updated.minAmount), maxAmount: String(updated.maxAmount), logoAssetId: updated.logoAssetId, checklist: body.checklist ?? [] },
    },
  });
  response.json({ id: updated.id, blocked: updated.blocked, logoAssetId: updated.logoAssetId });
});

router.put("/rails/:id/fields", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const rail = await client.rail.findUnique({ where: { id } });
  if (!rail) {
    throw new ApiError(404, "RAIL_NOT_FOUND", "The rail does not exist");
  }
  const body = parseOrThrow(
    z
      .object({
        fields: z
          .array(
            z
              .object({
                key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
                type: z.enum(["phone", "number", "string", "otp", "birth_year", "card_number", "pan", "wallet_id", "from_list"]),
                checksum: z.enum(["NONE", "LUHN"]).default("NONE"),
                labelAr: z.string().min(1).max(200),
                labelEn: z.string().min(1).max(200),
                placeholderAr: z.string().max(200).optional(),
                placeholderEn: z.string().max(200).optional(),
                regex: z.string().max(200).optional(),
                minLength: z.number().int().min(0).max(64).optional(),
                maxLength: z.number().int().min(0).max(64).optional(),
                minVal: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
                maxVal: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
                optionsJson: z.record(z.string().max(64), z.unknown()).optional(),
                required: z.boolean().default(true),
                orderIndex: z.number().int().min(0).max(999),
                sensitivity: z.enum(["NORMAL", "SENSITIVE", "PAN"]).default("NORMAL"),
                normalizer: z.record(z.string().max(64), z.unknown()).optional(),
              }),
          )
          .max(40),
        checklist: z.array(z.enum([
          "FIELD_CODES_VERIFIED",
          "VALIDATION_RULES_REVIEWED",
          "SENSITIVITY_REVIEWED",
          "CHECKOUT_IMPACT_REVIEWED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  await client.railField.deleteMany({ where: { railId: id } });
  const fields = await Promise.all(
    body.fields.map((field) =>
      client.railField.create({
        data: {
          railId: id,
          key: field.key,
          type: field.type.toUpperCase() as never,
          checksum: field.checksum,
          labelAr: field.labelAr,
          labelEn: field.labelEn,
          placeholderAr: field.placeholderAr,
          placeholderEn: field.placeholderEn,
          regex: field.regex,
          minLength: field.minLength,
          maxLength: field.maxLength,
          minVal: field.minVal ? new Prisma.Decimal(field.minVal) : null,
          maxVal: field.maxVal ? new Prisma.Decimal(field.maxVal) : null,
          optionsJson: jsonOptional(field.optionsJson),
          required: field.required,
          orderIndex: field.orderIndex,
          sensitivity: field.sensitivity,
          normalizer: jsonOptional(field.normalizer),
        },
      }),
    ),
  );
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "RAIL_FIELDS_UPDATED",
      entityType: "RAIL",
      entityId: id,
      beforeJson: {},
      afterJson: { fields: fields.map((field) => field.key), checklist: body.checklist ?? [] },
    },
  });
  response.json({ fields: fields.map((field) => ({ id: field.id, key: field.key })) });
});

router.get("/routes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["rail.code", "gateway.code"],
    in: { status: "status" }, equals: {railId: "railId", gatewayId: "gatewayId", credentialPolicy: "credentialPolicy", healthState: "healthState"},
    ranges: { amount: { path: "minAmount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { railCode: "railId", gatewayCode: "gatewayId", priority: "priority", status: "status", healthState: "healthState", minAmount: "minAmount" },
    defaultSort: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  const [routes, total] = await Promise.all([
    client.railRoute.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        rail: { select: { id: true, code: true, nameEn: true } },
        gateway: { select: { id: true, code: true, name: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.railRoute.count({ where: built.where as never }),
  ]);
  response.json(listResponse(
    "routes",
    routes.map((route) => ({
      ...route,
      railCode: route.rail?.code ?? "",
      railName: route.rail?.nameEn ?? "",
      gatewayCode: route.gateway?.code ?? "",
      gatewayName: route.gateway?.name ?? "",
    })),
    total,
    built,
  ));
});

router.get("/routes/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const built = buildListQuery(request.query, {
    search: ["rail.code", "gateway.code"],
    in: { status: "status" }, equals: {railId: "railId", gatewayId: "gatewayId", credentialPolicy: "credentialPolicy", healthState: "healthState"},
    ranges: { amount: { path: "minAmount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { railCode: "railId", gatewayCode: "gatewayId", priority: "priority", status: "status", healthState: "healthState", minAmount: "minAmount" },
    defaultSort: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  const take = 5000;
  const [routes, total] = await Promise.all([
    client.railRoute.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        rail: { select: { id: true, code: true, nameEn: true } },
        gateway: { select: { id: true, code: true, name: true } },
      },
      take,
    }),
    client.railRoute.count({ where: built.where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "ROUTES_EXPORTED",
      entityType: "RAIL_ROUTE",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: routes.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    routes: routes.map((route) => ({
      ...route,
      railCode: route.rail?.code ?? "",
      railName: route.rail?.nameEn ?? "",
      gatewayCode: route.gateway?.code ?? "",
      gatewayName: route.gateway?.name ?? "",
    })),
    total,
    exported: routes.length,
    truncated: total > routes.length,
  });
});

const buildRouteSummary = async () => {
  const [statusRows, healthRows, pairRows, total] = await Promise.all([
    client.railRoute.groupBy({ by: ["status"], _count: { _all: true } }),
    client.railRoute.groupBy({ by: ["healthState"], _count: { _all: true } }),
    client.railRoute.groupBy({ by: ["railId", "gatewayId"], _count: { _all: true } }),
    client.railRoute.count(),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row._count._all;
  const byHealth: Record<string, number> = {};
  for (const row of healthRows) byHealth[row.healthState] = row._count._all;
  return {
    total,
    byStatus,
    byHealth,
    railGatewayPairs: pairRows.length,
    active: byStatus.ACTIVE ?? 0,
    paused: byStatus.PAUSED ?? 0,
    draining: byStatus.DRAINING ?? 0,
    openBreaker: byHealth.OPEN_BREAKER ?? 0,
  };
};

router.get("/routes/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  response.json(await buildRouteSummary());
});

router.get("/routes/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const summary = await buildRouteSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "ROUTE_SCOPE_VERIFIED",
    "STATUS_HEALTH_REVIEWED",
    "PAIR_SCOPE_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "ROUTE_SUMMARY_EXPORTED",
      entityType: "RAIL_ROUTE",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: summary.total,
        active: summary.active,
        paused: summary.paused,
        draining: summary.draining,
        openBreaker: summary.openBreaker,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/routes/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const route = await client.railRoute.findUnique({ where: { id }, include: { rail: true, gateway: true } });
  if (!route) {
    throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
  }
  response.json({ route });
});

router.post("/routes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const body = parseOrThrow(
    z
      .object({
        railId: z.string().min(1).max(64),
        gatewayId: z.string().min(1).max(64),
        credentialPolicy: z.enum(["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"]),
        priority: z.number().int().min(0).max(9999).default(0),
        routingStrategy: z.enum(["EFFECTIVE_COST", "STRICT_PRIORITY", "WEIGHTED"]).default("EFFECTIVE_COST"),
        weight: z.number().int().min(1).max(1000).default(100),
        costModel: z.record(z.string().max(64), z.unknown()).default({}),
        mismatchPolicy: z.record(z.string().max(64), z.unknown()).default({}),
        minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
        maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        dailyCapAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        scope: z.record(z.string().max(64), z.unknown()).default({}),
      })
      .strict(),
    request.body,
  );
  const route = await client.railRoute.create({
    data: {
      railId: body.railId,
      gatewayId: body.gatewayId,
      credentialPolicy: body.credentialPolicy,
      priority: body.priority,
      routingStrategy: body.routingStrategy,
      weight: body.weight,
      costModel: json(body.costModel),
      mismatchPolicy: json(body.mismatchPolicy),
      minAmount: new Prisma.Decimal(body.minAmount),
      maxAmount: body.maxAmount ? new Prisma.Decimal(body.maxAmount) : null,
      dailyCapAmount: body.dailyCapAmount ? new Prisma.Decimal(body.dailyCapAmount) : null,
      scope: json(body.scope),
      status: "ACTIVE",
      healthState: "HEALTHY",
    },
  });
  response.status(201).json({ id: route.id, status: route.status });
});

router.patch("/routes/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        priority: z.number().int().min(0).max(9999).optional(),
        weight: z.number().int().min(1).max(1000).optional(),
        minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        dailyCapAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        scope: z.record(z.string().max(64), z.unknown()).optional(),
        costModel: z.record(z.string().max(64), z.unknown()).optional(),
        // `tolerance_amount` is the only key the settlement engine reads; other keys are kept as stored.
        mismatchPolicy: z.record(z.string().max(64), z.unknown()).optional(),
        // Absolute UTC windows: the route is hidden while start <= now < end (VisibleRailsResolver). [] clears them.
        maintenanceWindows: z
          .array(z.object({ start: z.string().min(10).max(64), end: z.string().min(10).max(64) }).catchall(z.unknown()))
          .max(50)
          .optional(),
        checklist: z.array(z.enum([
          "PRIORITY_WEIGHT_REVIEWED",
          "LIMITS_CAP_VERIFIED",
          "SCOPE_COST_REVIEWED",
          "ROUTING_IMPACT_REVIEWED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const route = await client.railRoute.findUnique({ where: { id } });
  if (!route) {
    throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
  }
  const windows = body.maintenanceWindows;
  if (windows) {
    const parsed = windows.map((window) => ({ start: Date.parse(window.start), end: Date.parse(window.end) }));
    if (parsed.some((window) => Number.isNaN(window.start) || Number.isNaN(window.end))) {
      throw new ApiError(400, "MAINTENANCE_WINDOW_INVALID", "Every maintenance window needs a valid start and end instant");
    }
    if (parsed.some((window) => window.end <= window.start)) {
      throw new ApiError(400, "MAINTENANCE_WINDOW_INVALID", "A maintenance window must end after it starts");
    }
  }
  const tolerance = body.mismatchPolicy?.tolerance_amount ?? body.mismatchPolicy?.toleranceAmount;
  if (tolerance !== undefined && tolerance !== null && !/^\d{1,14}(\.\d{1,4})?$/.test(String(tolerance))) {
    throw new ApiError(400, "MISMATCH_TOLERANCE_INVALID", "The mismatch tolerance must be a non-negative amount with up to 4 decimals");
  }
  const updated = await client.railRoute.update({
    where: { id },
    data: {
      mismatchPolicy: body.mismatchPolicy === undefined ? undefined : json(body.mismatchPolicy),
      maintenanceWindows: windows === undefined ? undefined : json(windows),
      priority: body.priority,
      weight: body.weight,
      minAmount: body.minAmount ? new Prisma.Decimal(body.minAmount) : undefined,
      maxAmount: body.maxAmount ? new Prisma.Decimal(body.maxAmount) : undefined,
      dailyCapAmount: body.dailyCapAmount ? new Prisma.Decimal(body.dailyCapAmount) : undefined,
      scope: json(body.scope),
      costModel: jsonOptional(body.costModel),
    },
  });
  response.json({ id: updated.id, priority: updated.priority });
});

router.post("/routes/:id/state", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      status: z.enum(["ACTIVE", "PAUSED", "DRAINING"]),
      reason: z.string().max(500).optional(),
      checklist: z.array(z.enum([
        "PRIORITY_WEIGHT_REVIEWED",
        "LIMITS_CAP_VERIFIED",
        "SCOPE_COST_REVIEWED",
        "ROUTING_IMPACT_REVIEWED",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const route = await client.railRoute.findUnique({ where: { id } });
  if (!route) {
    throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
  }
  const updated = await client.railRoute.update({ where: { id }, data: { status: body.status } });
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "ROUTE_UPDATED",
      entityType: "RAIL_ROUTE",
      entityId: updated.id,
      beforeJson: { priority: route.priority, weight: route.weight, status: route.status },
      afterJson: { priority: updated.priority, weight: updated.weight, status: updated.status, checklist: body.checklist ?? [] },
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/assets", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const assets = await client.asset.findMany({ orderBy: { name: "asc" } });
  response.json({ assets });
});

router.get("/assets/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const asset = await client.asset.findUnique({ where: { id } });
  if (!asset) {
    throw new ApiError(404, "ASSET_NOT_FOUND", "The asset does not exist");
  }
  response.json({ asset });
});

router.post("/assets", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const body = parseOrThrow(
    z
      .object({
        name: z.string().min(1).max(120),
        mime: z.enum(["image/png", "image/svg+xml"]),
        sizeBytes: z.number().int().min(1).max(2_000_000),
        storageKey: z.string().min(1).max(300),
        sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    request.body,
  );
  const asset = await client.asset.create({
    data: {
      name: body.name,
      mime: body.mime === "image/png" ? "IMAGE_PNG" : "IMAGE_SVG_XML",
      sizeBytes: body.sizeBytes,
      storageKey: body.storageKey,
      sha256: body.sha256,
    },
  });
  response.status(201).json({ id: asset.id, name: asset.name });
});

const reconciliationSourceRow = (source: Record<string, any>) => {
  const parser = source.parserConfig && typeof source.parserConfig === "object" && !Array.isArray(source.parserConfig)
    ? source.parserConfig as Record<string, unknown>
    : {};
  return {
    id: source.id,
    name: source.gateway?.name ? `${source.gateway.name} · ${source.type}` : source.type,
    gatewayId: source.gatewayId,
    gatewayCode: source.gateway?.code ?? "",
    type: source.type,
    format: typeof parser.format === "string" ? parser.format : source.type,
    delimiter: typeof parser.delimiter === "string" ? parser.delimiter : ",",
    currency: typeof parser.currency === "string" ? parser.currency : "LYD",
    scheduleCron: source.scheduleCron,
    settlementLagDays: source.settlementLagDays,
    dedupeKeyTemplate: source.dedupeKeyTemplate,
    active: parser.active !== false,
    columnMapping: parser.columns ?? parser.columnMapping ?? {},
    parserConfig: parser,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

router.get("/reconciliation/sources", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const built = buildListQuery(request.query, {
    search: ["gateway.code", "gateway.name"],
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "gatewayId", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [sources, total] = await Promise.all([
    client.statementSource.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { gateway: { select: { id: true, code: true, name: true } } }, skip: built.skip, take: built.take }),
    client.statementSource.count({ where: built.where as never }),
  ]);
  response.json(listResponse("sources", sources.map((source) => reconciliationSourceRow(source as never)), total, built));
});

router.post("/reconciliation/sources", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:write"]);
  const body = parseOrThrow(
    z
      .object({
        gatewayId: z.string().min(1).max(64),
        type: z.enum(["API", "SFTP", "UPLOAD"]),
        scheduleCron: z.string().max(120).optional(),
        parserConfig: z.record(z.string().max(64), z.unknown()),
        settlementLagDays: z.number().int().min(0).max(365).default(0),
        dedupeKeyTemplate: z.string().max(200).optional(),
      })
      .strict(),
    request.body,
  );
  const source = await client.statementSource.create({
    data: {
      gatewayId: body.gatewayId,
      type: body.type,
      scheduleCron: body.scheduleCron,
      parserConfig: json(body.parserConfig),
      settlementLagDays: body.settlementLagDays,
      dedupeKeyTemplate: body.dedupeKeyTemplate,
    },
  });
  response.status(201).json({ id: source.id, type: source.type });
});

router.patch("/reconciliation/sources/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        scheduleCron: z.string().max(120).nullable().optional(),
        settlementLagDays: z.number().int().min(0).max(365).optional(),
        dedupeKeyTemplate: z.string().max(200).nullable().optional(),
        parserConfig: z.record(z.string().max(64), z.unknown()).optional(),
        active: z.boolean().optional(),
        checklist: z.array(z.enum([
          "PARSER_CONFIG_REVIEWED",
          "SCHEDULE_LAG_VERIFIED",
          "DEDUPE_TEMPLATE_REVIEWED",
          "SOURCE_IMPACT_REVIEWED",
        ])).max(10).optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.scheduleCron !== undefined ||
          value.settlementLagDays !== undefined ||
          value.dedupeKeyTemplate !== undefined ||
          value.parserConfig !== undefined ||
          value.active !== undefined,
        { message: "At least one field is required" },
      ),
    request.body ?? {},
  );
  const source = await client.statementSource.findUnique({ where: { id } });
  if (!source) throw new ApiError(404, "STATEMENT_SOURCE_NOT_FOUND", "The statement source does not exist");
  const currentParser = source.parserConfig && typeof source.parserConfig === "object" && !Array.isArray(source.parserConfig)
    ? source.parserConfig as Record<string, unknown>
    : {};
  const nextParser = {
    ...currentParser,
    ...(body.parserConfig ?? {}),
    ...(body.active !== undefined ? { active: body.active } : {}),
  };
  const actor = actorFromRequest(request);
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.statementSource.update({
      where: { id },
      data: {
        ...(body.scheduleCron !== undefined ? { scheduleCron: body.scheduleCron } : {}),
        ...(body.settlementLagDays !== undefined ? { settlementLagDays: body.settlementLagDays } : {}),
        ...(body.dedupeKeyTemplate !== undefined ? { dedupeKeyTemplate: body.dedupeKeyTemplate } : {}),
        parserConfig: json(nextParser),
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "OPERATOR",
        action: "RECONCILIATION_SOURCE_UPDATED",
        entityType: "STATEMENT_SOURCE",
        entityId: id,
        beforeJson: {
          scheduleCron: source.scheduleCron,
          settlementLagDays: source.settlementLagDays,
          dedupeKeyTemplate: source.dedupeKeyTemplate,
          active: currentParser.active !== false,
        },
        afterJson: {
          scheduleCron: row.scheduleCron,
          settlementLagDays: row.settlementLagDays,
          dedupeKeyTemplate: row.dedupeKeyTemplate,
          active: nextParser.active !== false,
          checklist: body.checklist ?? [],
        },
      },
    });
    return row;
  });
  response.json({
    id: updated.id,
    active: (updated.parserConfig as Record<string, unknown> | null)?.active !== false,
    settlementLagDays: updated.settlementLagDays,
    scheduleCron: updated.scheduleCron,
  });
});

const reconciliationRunRow = (run: Record<string, any>) => {
  const stats = run.statsJson && typeof run.statsJson === "object" && !Array.isArray(run.statsJson)
    ? run.statsJson as Record<string, unknown>
    : {};
  const totalRows = Number(stats.totalRows ?? stats.statementLines ?? run.items?.length ?? 0);
  const matchedRows = Number(stats.matched ?? 0);
  const amountMismatch = Number(stats.amountMismatch ?? stats.mismatched ?? 0);
  const missingAtGateway = Number(stats.missingAtGateway ?? 0);
  const missingLocally = Number(stats.missingLocally ?? 0);
  const duplicates = Number(stats.duplicates ?? 0);
  const feeVariances = Number(stats.feeVariances ?? 0);
  const unmatchedRows = Number(stats.mismatched ?? amountMismatch + missingAtGateway + missingLocally + duplicates);
  return {
    id: run.id,
    sourceId: run.statementSourceId,
    sourceName: run.statementSource?.gateway?.name
      ? `${run.statementSource.gateway.name} · ${run.statementSource.type}`
      : run.statementSource?.type ?? "",
    fileName: run.fileName ?? "—",
    state: run.ingestedAt ? "COMPLETED" : "PROCESSING",
    totalRows,
    matchedRows,
    unmatchedRows,
    amountMismatch,
    missingAtGateway,
    missingLocally,
    duplicates,
    feeVariances,
    matchRate: totalRows === 0 ? "0.0000" : ((matchedRows / totalRows) * 100).toFixed(4),
    drift: amountMismatch + missingAtGateway + missingLocally,
    stats,
    startedAt: run.createdAt,
    createdAt: run.createdAt,
    finishedAt: run.ingestedAt,
    ingestedAt: run.ingestedAt,
  };
};

router.get("/reconciliation/runs", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["fileName"],
    equals: { statementSourceId: "statementSourceId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { fileName: "fileName", createdAt: "createdAt", ingestedAt: "ingestedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const conditions: Record<string, unknown>[] = [built.where];
  if (query.state === "COMPLETED") conditions.push({ ingestedAt: { not: null } });
  else if (query.state === "PROCESSING") conditions.push({ ingestedAt: null });
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const [runs, total] = await Promise.all([
    client.reconciliationRun.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: {
        items: { select: { result: true } },
        statementSource: { select: { type: true, gateway: { select: { code: true, name: true } } } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.reconciliationRun.count({ where: where as never }),
  ]);
  response.json(listResponse("runs", runs.map((run) => reconciliationRunRow(run as never)), total, built));
});

const buildReconciliationSummary = async () => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [runs, resultRows, sourceCount] = await Promise.all([
    client.reconciliationRun.findMany({
      where: { createdAt: { gte: since } },
      select: { ingestedAt: true, statsJson: true, createdAt: true },
    }),
    client.reconciliationItem.groupBy({
      by: ["result"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    client.statementSource.count(),
  ]);
  const resultCounts: Record<string, number> = {};
  for (const row of resultRows) resultCounts[row.result] = row._count._all;
  let totalRows = 0;
  let matchedRows = 0;
  let mismatchedRows = 0;
  for (const run of runs) {
    const stats = run.statsJson && typeof run.statsJson === "object" && !Array.isArray(run.statsJson)
      ? run.statsJson as Record<string, unknown>
      : {};
    totalRows += Number(stats.totalRows ?? stats.statementLines ?? 0);
    matchedRows += Number(stats.matched ?? 0);
    mismatchedRows += Number(stats.mismatched ?? (Number(stats.amountMismatch ?? 0) + Number(stats.missingAtGateway ?? 0) + Number(stats.missingLocally ?? 0) + Number(stats.duplicates ?? 0)));
  }
  return {
    sources: sourceCount,
    runs: runs.length,
    completedRuns: runs.filter((run) => run.ingestedAt !== null).length,
    processingRuns: runs.filter((run) => run.ingestedAt === null).length,
    totalRows,
    matchedRows,
    mismatchedRows,
    matchRate: totalRows === 0 ? "0.0000" : ((matchedRows / totalRows) * 100).toFixed(4),
    resultCounts,
  };
};

router.get("/reconciliation/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  response.json(await buildReconciliationSummary());
});

router.get("/reconciliation/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const summary = await buildReconciliationSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "RUN_SCOPE_VERIFIED",
    "MATCH_RATE_REVIEWED",
    "RESULT_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "RECONCILIATION_SUMMARY_EXPORTED",
      entityType: "RECONCILIATION_RUN",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        sources: summary.sources,
        runs: summary.runs,
        processingRuns: summary.processingRuns,
        matchedRows: summary.matchedRows,
        mismatchedRows: summary.mismatchedRows,
        matchRate: summary.matchRate,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/reconciliation/runs/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const resultFilter = typeof request.query.result === "string" && request.query.result.trim()
    ? request.query.result.trim()
    : "";
  const itemWhere = resultFilter ? { runId: id, result: resultFilter } : { runId: id };
  const [run, items, itemsTotal, resultRows] = await Promise.all([
    client.reconciliationRun.findUnique({
      where: { id },
      include: {
        statementSource: { select: { type: true, gateway: { select: { code: true, name: true } } } },
      },
    }),
    client.reconciliationItem.findMany({
      where: itemWhere as never,
      take: 200,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        ourReference: true,
        providerReference: true,
        batchReference: true,
        statementAmount: true,
        statementFee: true,
        result: true,
        attemptId: true,
        operatorCaseId: true,
        operatorCase: { select: { id: true, state: true, priority: true } },
      },
    }),
    client.reconciliationItem.count({ where: itemWhere as never }),
    client.reconciliationItem.groupBy({
      by: ["result"],
      where: { runId: id },
      _count: { _all: true },
    }),
  ]);
  if (!run) throw new ApiError(404, "RECONCILIATION_RUN_NOT_FOUND", "The reconciliation run does not exist");
  const itemResultCounts = Object.fromEntries(resultRows.map((row) => [row.result, row._count._all]));
  response.json({
    run: {
      ...reconciliationRunRow(run as never),
      items: items.map((item) => ({
        ...item,
        statementAmount: merchantMoney(item.statementAmount),
        statementFee: merchantMoney(item.statementFee),
      })),
      itemResultCounts,
      itemsTotal,
      itemsTruncated: itemsTotal > items.length,
      itemResultFilter: resultFilter || null,
    },
  });
});

router.get("/reconciliation/runs/:id/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const resultFilter = typeof request.query.result === "string" && request.query.result.trim()
    ? request.query.result.trim()
    : "";
  const run = await client.reconciliationRun.findUnique({
    where: { id },
    include: {
      statementSource: { select: { type: true, gateway: { select: { code: true, name: true } } } },
    },
  });
  if (!run) throw new ApiError(404, "RECONCILIATION_RUN_NOT_FOUND", "The reconciliation run does not exist");
  const where = resultFilter ? { runId: id, result: resultFilter } : { runId: id };
  const take = 20000;
  const [items, total] = await Promise.all([
    client.reconciliationItem.findMany({
      where: where as never,
      orderBy: { createdAt: "asc" },
      take,
      select: {
        id: true,
        ourReference: true,
        providerReference: true,
        batchReference: true,
        statementAmount: true,
        statementFee: true,
        result: true,
        attemptId: true,
        operatorCaseId: true,
        operatorCase: { select: { id: true, state: true, priority: true } },
      },
    }),
    client.reconciliationItem.count({ where: where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "RECONCILIATION_RUN_EXPORTED",
      entityType: "RECONCILIATION_RUN",
      entityId: id,
      beforeJson: {},
      afterJson: { total, exported: items.length, result: resultFilter || null },
    },
  });
  response.json({
    run: reconciliationRunRow(run as never),
    items: items.map((item) => ({
      ...item,
      statementAmount: merchantMoney(item.statementAmount),
      statementFee: merchantMoney(item.statementFee),
    })),
    total,
    exported: items.length,
    truncated: total > items.length,
  });
});

// The statement is never parsed in the request: the upload stores the file
// in the run record, queues a reconciliation job and answers `202 Accepted`.
router.post("/reconciliation/upload", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:write"]);
  const upload = createReconciliationUploadHandler({
    db: client as never,
    repositories: getPlatformRuntime(client as never).repositories,
  });
  await upload(request, response);
});

const DISPUTE_OPEN_STATUSES: readonly string[] = ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"];
const DISPUTE_EVIDENCE_PENDING_STATUSES: readonly string[] = ["OPENED", "EVIDENCE_REQUESTED"];

const disputeEvidenceSubmittedAt = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const submittedAt = (value as Record<string, unknown>).submittedAt;
  return typeof submittedAt === "string" ? submittedAt : null;
};

const disputeListRow = (dispute: Record<string, any>) => {
  const dueAt = dispute.evidenceDueAt ? new Date(dispute.evidenceDueAt) : null;
  const now = Date.now();
  return {
    id: dispute.id,
    externalDisputeRef: dispute.externalDisputeRef,
    disputeRef: dispute.externalDisputeRef,
    source: dispute.source,
    status: dispute.status,
    state: dispute.status,
    reasonCode: dispute.reasonCode,
    amount: merchantMoney(dispute.amount),
    currency: dispute.currency,
    openedAt: dispute.openedAt,
    evidenceDueAt: dispute.evidenceDueAt,
    outcomeAt: dispute.outcomeAt,
    evidenceDueInHours: dueAt ? Math.ceil((dueAt.getTime() - now) / 3_600_000) : null,
    evidenceOverdue: Boolean(dueAt && dueAt.getTime() < now && DISPUTE_EVIDENCE_PENDING_STATUSES.includes(dispute.status)),
    evidenceSubmittedAt: disputeEvidenceSubmittedAt(dispute.evidenceJson),
    ageHours: dispute.openedAt ? approvalAgeHours(new Date(dispute.openedAt), now) : 0,
    merchantId: dispute.attempt?.merchant?.id ?? null,
    merchantName: dispute.attempt?.merchant?.tradeName ?? "",
    attemptId: dispute.attemptId,
    attemptReference: dispute.attempt?.reference ?? null,
    attemptStatus: dispute.attempt?.status ?? null,
    railCode: dispute.attempt?.rail?.code ?? dispute.rail?.code ?? "",
    railName: dispute.attempt?.rail?.nameEn ?? dispute.rail?.nameEn ?? "",
    gatewayCode: dispute.gateway?.code ?? "",
    gatewayName: dispute.gateway?.name ?? "",
    adjustmentId: dispute.adjustmentId,
    adjustmentState: dispute.adjustment?.state ?? null,
    adjustmentJournalEntryId: dispute.adjustment?.journalEntryId ?? null,
  };
};

router.get("/disputes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["externalDisputeRef", "reasonCode", "attempt.reference", "attempt.merchant.tradeName"],
    in: { status: "status", source: "source" },
    equals: { railId: "railId", gatewayId: "gatewayId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: {
      createdAt: { path: "openedAt" },
      openedAt: { path: "openedAt", fromKey: "openedFrom", toKey: "openedTo" },
      evidenceDueAt: { path: "evidenceDueAt", fromKey: "dateFrom", toKey: "dateTo" },
    },
    sortable: {
      externalDisputeRef: "externalDisputeRef",
      status: "status",
      source: "source",
      amount: "amount",
      openedAt: "openedAt",
      evidenceDueAt: "evidenceDueAt",
    },
    defaultSort: { openedAt: "desc" },
    defaultPageSize: 20,
  });
  const conditions: Record<string, unknown>[] = [built.where];
  const merchantId = typeof query.merchantId === "string" && query.merchantId.trim() ? query.merchantId.trim() : "";
  if (merchantId) {
    conditions.push({ attempt: { merchantId } });
  }
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const [disputes, total] = await Promise.all([
    client.dispute.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: {
        attempt: {
          select: {
            id: true,
            reference: true,
            status: true,
            merchant: { select: { id: true, tradeName: true, legalName: true } },
            rail: { select: { id: true, code: true, nameEn: true } },
          },
        },
        gateway: { select: { id: true, code: true, name: true } },
        rail: { select: { id: true, code: true, nameEn: true } },
        adjustment: { select: { id: true, state: true, journalEntryId: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.dispute.count({ where: where as never }),
  ]);
  response.json(listResponse("disputes", disputes.map((dispute) => disputeListRow(dispute as never)), total, built));
});

router.get("/disputes/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["externalDisputeRef", "reasonCode", "attempt.reference", "attempt.merchant.tradeName"],
    in: { status: "status", source: "source" },
    equals: { railId: "railId", gatewayId: "gatewayId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: {
      createdAt: { path: "openedAt" },
      openedAt: { path: "openedAt", fromKey: "openedFrom", toKey: "openedTo" },
      evidenceDueAt: { path: "evidenceDueAt", fromKey: "dateFrom", toKey: "dateTo" },
    },
    sortable: {
      externalDisputeRef: "externalDisputeRef",
      status: "status",
      source: "source",
      amount: "amount",
      openedAt: "openedAt",
      evidenceDueAt: "evidenceDueAt",
    },
    defaultSort: { openedAt: "desc" },
    defaultPageSize: 20,
  });
  const conditions: Record<string, unknown>[] = [built.where];
  const merchantId = typeof query.merchantId === "string" && query.merchantId.trim() ? query.merchantId.trim() : "";
  if (merchantId) conditions.push({ attempt: { merchantId } });
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const take = 5000;
  const [disputes, total] = await Promise.all([
    client.dispute.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: {
        attempt: {
          select: {
            id: true,
            reference: true,
            status: true,
            merchant: { select: { id: true, tradeName: true, legalName: true } },
            rail: { select: { id: true, code: true, nameEn: true } },
          },
        },
        gateway: { select: { id: true, code: true, name: true } },
        rail: { select: { id: true, code: true, nameEn: true } },
        adjustment: { select: { id: true, state: true, journalEntryId: true } },
      },
      take,
    }),
    client.dispute.count({ where: where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "DISPUTES_EXPORTED",
      entityType: "DISPUTE",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: disputes.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    disputes: disputes.map((dispute) => disputeListRow(dispute as never)),
    total,
    exported: disputes.length,
    truncated: total > disputes.length,
  });
});

const buildDisputeSummary = async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const [statusRows, openAggregate, overdue, dueSoon, earliestDue] = await Promise.all([
    client.dispute.groupBy({ by: ["status"], _count: { _all: true } }),
    client.dispute.aggregate({
      where: { status: { in: [...DISPUTE_OPEN_STATUSES] as never } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    client.dispute.count({
      where: { status: { in: [...DISPUTE_EVIDENCE_PENDING_STATUSES] as never }, evidenceDueAt: { lt: now } },
    }),
    client.dispute.count({
      where: { status: { in: [...DISPUTE_EVIDENCE_PENDING_STATUSES] as never }, evidenceDueAt: { gte: now, lte: soon } },
    }),
    client.dispute.findFirst({
      where: { status: { in: [...DISPUTE_EVIDENCE_PENDING_STATUSES] as never }, evidenceDueAt: { not: null } },
      orderBy: { evidenceDueAt: "asc" },
      select: { evidenceDueAt: true },
    }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row._count._all;
  const openCount = (openAggregate._count as { _all: number })._all;
  const openAmount = (openAggregate._sum as { amount: unknown } | undefined)?.amount;
  return {
    totalOpen: openCount,
    openAmount: merchantMoney(openAmount),
    byStatus,
    overdue,
    dueSoon,
    earliestEvidenceDueAt: earliestDue?.evidenceDueAt ?? null,
  };
};

router.get("/disputes/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  response.json(await buildDisputeSummary());
});

router.get("/disputes/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const summary = await buildDisputeSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "OPEN_SCOPE_VERIFIED",
    "DUE_DATE_REVIEWED",
    "STATUS_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "DISPUTE_SUMMARY_EXPORTED",
      entityType: "DISPUTE",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        totalOpen: summary.totalOpen,
        openAmount: summary.openAmount,
        overdue: summary.overdue,
        dueSoon: summary.dueSoon,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/disputes/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const dispute = await client.dispute.findUnique({
    where: { id },
    include: {
      attempt: {
        select: {
          id: true,
          reference: true,
          status: true,
          settledAmount: true,
          merchant: { select: { id: true, tradeName: true, legalName: true } },
          rail: { select: { id: true, code: true, nameEn: true } },
        },
      },
      gateway: { select: { id: true, code: true, name: true } },
      rail: { select: { id: true, code: true, nameEn: true } },
      adjustment: { select: { id: true, state: true, journalEntryId: true, reason: true } },
    },
  });
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  }
  const dueAt = dispute.evidenceDueAt ? new Date(dispute.evidenceDueAt) : null;
  const evidenceOpen = DISPUTE_OPEN_STATUSES.includes(dispute.status)
    && dispute.status !== "EVIDENCE_SUBMITTED"
    && (!dueAt || dueAt.getTime() >= Date.now());
  response.json({
    dispute: {
      ...disputeListRow(dispute as never),
      attemptSettledAmount: merchantMoney(dispute.attempt?.settledAmount),
      adjustmentReason: dispute.adjustment?.reason ?? null,
      evidenceJson: dispute.evidenceJson,
      canSubmitEvidence: evidenceOpen,
      evidenceBlockedReason: evidenceOpen
        ? null
        : dispute.status === "EVIDENCE_SUBMITTED"
          ? "EVIDENCE_ALREADY_SUBMITTED"
          : dueAt && dueAt.getTime() < Date.now()
            ? "EVIDENCE_WINDOW_CLOSED"
            : "DISPUTE_NOT_OPEN",
    },
  });
});

router.post("/disputes/:id/evidence", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      evidence: z.record(z.string().max(64), z.unknown()),
      notes: z.string().max(2000).optional(),
      checklist: z.array(z.enum([
        "EVIDENCE_REFERENCE_VERIFIED",
        "SUPPORTING_DOCUMENTS_ATTACHED",
        "EVIDENCE_WINDOW_VERIFIED",
        "SUMMARY_REVIEWED",
      ])).max(10).optional(),
    }).strict(),
    request.body ?? {},
  );
  const dispute = await client.dispute.findUnique({ where: { id } });
  if (!dispute) throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  if (!DISPUTE_OPEN_STATUSES.includes(dispute.status) || dispute.status === "EVIDENCE_SUBMITTED") {
    throw new ApiError(409, "DISPUTE_NOT_OPEN_FOR_EVIDENCE", "The dispute is not open for evidence submission");
  }
  if (dispute.evidenceDueAt && dispute.evidenceDueAt.getTime() < Date.now()) {
    throw new ApiError(409, "DISPUTE_EVIDENCE_WINDOW_CLOSED", "The dispute evidence window has closed");
  }
  const existing = dispute.evidenceJson && typeof dispute.evidenceJson === "object" && !Array.isArray(dispute.evidenceJson)
    ? dispute.evidenceJson as Record<string, unknown>
    : {};
  const submittedAt = new Date().toISOString();
  const evidenceJson = {
    ...existing,
    ...body.evidence,
    ...(body.notes ? { notes: body.notes } : {}),
    submittedAt,
  };
  const actor = actorFromRequest(request);
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.dispute.update({
      where: { id },
      data: { status: "EVIDENCE_SUBMITTED", evidenceJson: json(evidenceJson) },
    });
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "OPERATOR",
        action: "DISPUTE_EVIDENCE_SUBMITTED",
        entityType: "DISPUTE",
        entityId: id,
        beforeJson: { status: dispute.status, evidenceSubmittedAt: disputeEvidenceSubmittedAt(dispute.evidenceJson) },
        afterJson: { status: row.status, submittedAt, keys: Object.keys(body.evidence), checklist: body.checklist ?? [] },
      },
    });
    return row;
  });
  response.json({
    id: updated.id,
    status: updated.status,
    evidenceSubmittedAt: submittedAt,
    evidenceJson: updated.evidenceJson,
  });
});

router.post("/disputes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:write"]);
  const body = parseOrThrow(
    z
      .object({
        attemptId: z.string().min(1).max(64),
        gatewayId: z.string().min(1).max(64),
        railId: z.string().min(1).max(64),
        externalDisputeRef: z.string().min(2).max(120),
        source: z.enum(["WEBHOOK", "STATEMENT", "MANUAL"]),
        reasonCode: z.string().max(80).optional(),
        amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
        currency: z.string().length(3),
      })
      .strict(),
    request.body,
  );
  const actor = auditActorOf(request);
  const platform = getPlatformRuntime(client as never);
  // The dispute intake moves the money (the reserve posting) and writes the
  // audit trail, so it is a background job: the request queues the work and
  // answers `202 Accepted`. The job performs the whole intake in one
  // transaction, exactly as the request used to do.
  const job = await client.$transaction(async (tx) =>
    platform.repositories.jobs.enqueueJob(tx as never, {
      jobType: "ADJUSTMENT_EXECUTION",
      referenceType: "DISPUTE_INTAKE",
      referenceId: `${body.gatewayId}:${body.externalDisputeRef}`,
      payload: {
        kind: "DISPUTE_INTAKE",
        attemptId: body.attemptId,
        gatewayId: body.gatewayId,
        railId: body.railId,
        externalDisputeRef: body.externalDisputeRef,
        source: body.source,
        reasonCode: body.reasonCode ?? null,
        amount: body.amount,
        currency: body.currency,
        actorUserId: actor.userId,
        actorRole: actor.role,
      },
    }),
  );
  response.status(202).json({
    jobId: job.id,
    status: "QUEUED",
    externalDisputeRef: body.externalDisputeRef,
  });
});

const ADJUSTMENT_EXECUTED_STATES: readonly string[] = ["EXECUTED"];
const ADJUSTMENT_OPEN_STATES: readonly string[] = ["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTING"];

const adjustmentListRow = (adjustment: Record<string, any>, approval?: { id: string; state: string; checkerUserId: string | null } | null) => ({
  id: adjustment.id,
  type: adjustment.type,
  state: adjustment.state,
  amount: merchantMoney(adjustment.amount),
  currency: adjustment.targetGlAccount?.currency ?? adjustment.sourceAttempt?.currency ?? "LYD",
  reverseCommission: adjustment.reverseCommission,
  reason: adjustment.reason,
  externalDisputeRef: adjustment.externalDisputeRef,
  providerRefundRef: adjustment.providerRefundRef,
  draftedBySystem: adjustment.draftedBySystem,
  sourceAttemptId: adjustment.sourceAttemptId,
  sourceAttemptReference: adjustment.sourceAttempt?.reference ?? null,
  sourceAttemptStatus: adjustment.sourceAttempt?.status ?? null,
  disputeId: adjustment.disputeId,
  disputeReference: adjustment.dispute?.externalDisputeRef ?? null,
  disputeStatus: adjustment.dispute?.status ?? null,
  targetGlAccountId: adjustment.targetGlAccountId,
  targetAccountType: adjustment.targetGlAccount?.accountType ?? null,
  targetAccountOwnerId: adjustment.targetGlAccount?.ownerId ?? null,
  merchantId: adjustment.sourceAttempt?.merchant?.id ?? adjustment.targetGlAccount?.ownerId ?? null,
  merchantName: adjustment.sourceAttempt?.merchant?.tradeName ?? "",
  journalEntryId: adjustment.journalEntryId,
  approvalRequestId: approval?.id ?? null,
  approvalState: approval?.state ?? null,
  checkerUserId: approval?.checkerUserId ?? null,
  createdAt: adjustment.createdAt,
  updatedAt: adjustment.updatedAt,
  executedAt: adjustment.state === "EXECUTED" ? adjustment.updatedAt : null,
});

router.get("/adjustments", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["reason", "externalDisputeRef", "providerRefundRef", "id", "sourceAttempt.reference", "dispute.externalDisputeRef"],
    in: { state: "state", type: "type" },
    booleans: { draftedBySystem: "draftedBySystem" },
    equals: { sourceAttemptId: "sourceAttemptId", disputeId: "disputeId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" }, updatedAt: { path: "updatedAt", fromKey: "updatedFrom", toKey: "updatedTo" } },
    sortable: { type: "type", state: "state", amount: "amount", createdAt: "createdAt", updatedAt: "updatedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const conditions: Record<string, unknown>[] = [built.where];
  const merchantId = typeof query.merchantId === "string" && query.merchantId.trim() ? query.merchantId.trim() : "";
  if (merchantId) {
    conditions.push({
      OR: [
        { sourceAttempt: { merchantId } },
        { targetGlAccount: { ownerId: merchantId } },
      ],
    });
  }
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const [adjustments, total] = await Promise.all([
    client.adjustment.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: {
        sourceAttempt: { select: { id: true, reference: true, status: true, currency: true, merchant: { select: { id: true, tradeName: true, legalName: true } } } },
        dispute: { select: { id: true, externalDisputeRef: true, status: true } },
        targetGlAccount: { select: { id: true, accountType: true, currency: true, ownerId: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.adjustment.count({ where: where as never }),
  ]);
  const ids = adjustments.map((adjustment) => adjustment.id);
  const approvals = ids.length === 0
    ? []
    : await client.approvalRequest.findMany({
        where: {
          subjectType: { in: approvalSubjectTypeVariants("ADJUSTMENT") as never },
          subjectId: { in: ids },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, subjectId: true, state: true, checkerUserId: true },
      });
  const approvalByAdjustment = new Map<string, { id: string; state: string; checkerUserId: string | null }>();
  for (const approval of approvals) {
    if (!approvalByAdjustment.has(approval.subjectId)) {
      approvalByAdjustment.set(approval.subjectId, { id: approval.id, state: approval.state, checkerUserId: approval.checkerUserId });
    }
  }
  response.json(listResponse(
    "adjustments",
    adjustments.map((adjustment) => adjustmentListRow(adjustment as never, approvalByAdjustment.get(adjustment.id) ?? null)),
    total,
    built,
  ));
});

router.get("/adjustments/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const built = buildListQuery(request.query, {
    search: ["reason", "externalDisputeRef", "providerRefundRef", "id", "sourceAttempt.reference", "dispute.externalDisputeRef"],
    in: { state: "state", type: "type" },
    booleans: { draftedBySystem: "draftedBySystem" },
    equals: { sourceAttemptId: "sourceAttemptId", disputeId: "disputeId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" }, updatedAt: { path: "updatedAt", fromKey: "updatedFrom", toKey: "updatedTo" } },
    sortable: { type: "type", state: "state", amount: "amount", createdAt: "createdAt", updatedAt: "updatedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const conditions: Record<string, unknown>[] = [built.where];
  const merchantId = typeof query.merchantId === "string" && query.merchantId.trim() ? query.merchantId.trim() : "";
  if (merchantId) {
    conditions.push({
      OR: [
        { sourceAttempt: { merchantId } },
        { targetGlAccount: { ownerId: merchantId } },
      ],
    });
  }
  const where = conditions.length === 1 ? conditions[0] : { AND: conditions };
  const take = 5000;
  const [adjustments, total] = await Promise.all([
    client.adjustment.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      include: {
        sourceAttempt: { select: { id: true, reference: true, status: true, currency: true, merchant: { select: { id: true, tradeName: true, legalName: true } } } },
        dispute: { select: { id: true, externalDisputeRef: true, status: true } },
        targetGlAccount: { select: { id: true, accountType: true, currency: true, ownerId: true } },
      },
      take,
    }),
    client.adjustment.count({ where: where as never }),
  ]);
  const ids = adjustments.map((adjustment) => adjustment.id);
  const approvals = ids.length === 0
    ? []
    : await client.approvalRequest.findMany({
        where: {
          subjectType: { in: approvalSubjectTypeVariants("ADJUSTMENT") as never },
          subjectId: { in: ids },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, subjectId: true, state: true, checkerUserId: true },
      });
  const approvalByAdjustment = new Map<string, { id: string; state: string; checkerUserId: string | null }>();
  for (const approval of approvals) {
    if (!approvalByAdjustment.has(approval.subjectId)) {
      approvalByAdjustment.set(approval.subjectId, { id: approval.id, state: approval.state, checkerUserId: approval.checkerUserId });
    }
  }
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "ADJUSTMENTS_EXPORTED",
      entityType: "ADJUSTMENT",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: adjustments.length, filters: JSON.stringify(query) },
    },
  });
  response.json({
    adjustments: adjustments.map((adjustment) => adjustmentListRow(adjustment as never, approvalByAdjustment.get(adjustment.id) ?? null)),
    total,
    exported: adjustments.length,
    truncated: total > adjustments.length,
  });
});

const buildAdjustmentSummary = async () => {
  const [stateRows, typeRows, openAggregate, executedAggregate] = await Promise.all([
    client.adjustment.groupBy({ by: ["state"], _count: { _all: true }, _sum: { amount: true } }),
    client.adjustment.groupBy({ by: ["type"], _count: { _all: true }, _sum: { amount: true } }),
    client.adjustment.aggregate({
      where: { state: { in: [...ADJUSTMENT_OPEN_STATES] as never } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    client.adjustment.aggregate({
      where: { state: { in: [...ADJUSTMENT_EXECUTED_STATES] as never } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  const byState: Record<string, number> = {};
  const amountByState: Record<string, string> = {};
  for (const row of stateRows) {
    byState[row.state] = row._count._all;
    amountByState[row.state] = merchantMoney(row._sum.amount);
  }
  const byType: Record<string, number> = {};
  const amountByType: Record<string, string> = {};
  for (const row of typeRows) {
    byType[row.type] = row._count._all;
    amountByType[row.type] = merchantMoney(row._sum.amount);
  }
  return {
    totalOpen: (openAggregate._count as { _all: number })._all,
    openAmount: merchantMoney((openAggregate._sum as { amount?: unknown } | undefined)?.amount),
    executedCount: (executedAggregate._count as { _all: number })._all,
    executedAmount: merchantMoney((executedAggregate._sum as { amount?: unknown } | undefined)?.amount),
    byState,
    amountByState,
    byType,
    amountByType,
  };
};

router.get("/adjustments/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  response.json(await buildAdjustmentSummary());
});

router.get("/adjustments/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const summary = await buildAdjustmentSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "OPEN_SCOPE_VERIFIED",
    "AMOUNT_TOTALS_REVIEWED",
    "STATE_TYPE_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "ADJUSTMENT_SUMMARY_EXPORTED",
      entityType: "ADJUSTMENT",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        totalOpen: summary.totalOpen,
        openAmount: summary.openAmount,
        executedCount: summary.executedCount,
        executedAmount: summary.executedAmount,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/adjustments/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const adjustment = await client.adjustment.findUnique({
    where: { id },
    include: {
      sourceAttempt: { select: { id: true, reference: true, status: true, currency: true, merchant: { select: { id: true, tradeName: true, legalName: true } } } },
      dispute: { select: { id: true, externalDisputeRef: true, status: true, amount: true, openedAt: true } },
      targetGlAccount: { select: { id: true, accountType: true, currency: true, ownerId: true } },
      journalEntry: { select: { id: true, refType: true, refId: true, description: true } },
    },
  });
  if (!adjustment) throw new ApiError(404, "ADJUSTMENT_NOT_FOUND", "The adjustment does not exist");
  const approval = await client.approvalRequest.findFirst({
    where: { subjectType: { in: approvalSubjectTypeVariants("ADJUSTMENT") as never }, subjectId: adjustment.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, state: true, checkerUserId: true, makerUserId: true, rejectionReason: true, createdAt: true },
  });
  response.json({
    adjustment: {
      ...adjustmentListRow(adjustment as never, approval),
      disputeAmount: adjustment.dispute ? merchantMoney(adjustment.dispute.amount) : null,
      disputeOpenedAt: adjustment.dispute?.openedAt ?? null,
      journalEntry: adjustment.journalEntry ?? null,
      approval: approval ? {
        id: approval.id,
        state: approval.state,
        makerUserId: approval.makerUserId,
        checkerUserId: approval.checkerUserId,
        rejectionReason: approval.rejectionReason,
        createdAt: approval.createdAt,
      } : null,
    },
  });
});

router.post("/adjustments", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:write"]);
  const body = parseOrThrow(
    z
      .object({
        type: z.enum(["CHARGEBACK", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION", "CASHOUT_SUBTRACTION"]),
        targetGlAccountId: z.string().min(1).max(64),
        sourceAttemptId: z.string().max(64).optional(),
        disputeId: z.string().max(64).optional(),
        amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
        reverseCommission: z.boolean().default(false),
        reason: z.string().min(2).max(1000),
        externalDisputeRef: z.string().max(120).optional(),
        checklist: z.array(z.enum([
          "TARGET_ACCOUNT_VERIFIED",
          "AMOUNT_CURRENCY_VERIFIED",
          "REASON_DOCUMENTED",
          "SOURCE_LINKAGE_VERIFIED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const platform = getPlatformRuntime(client as never);
  // A draft adjustment is never executable until a human checker approves it,
  // so the draft and its approval request are created together.
  const { adjustment, approval } = await client.$transaction(async (tx) => {
    const draft = await tx.adjustment.create({
      data: {
        type: body.type,
        targetGlAccountId: body.targetGlAccountId,
        sourceAttemptId: body.sourceAttemptId,
        disputeId: body.disputeId,
        amount: new Prisma.Decimal(body.amount),
        reverseCommission: body.reverseCommission,
        reason: body.reason,
        externalDisputeRef: body.externalDisputeRef,
        draftedBySystem: false,
        state: "PENDING_REVIEW",
      },
    });
    const approvalRequest = await tx.approvalRequest.create({
      data: {
        subjectType: "ADJUSTMENT",
        subjectId: draft.id,
        payloadDiffJson: json({ type: body.type, amount: body.amount, reason: body.reason }),
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await platform.repositories.governance.writeAuditLog(tx as never, {
      actorId: actor.userId,
      role: actor.role,
      action: "ADJUSTMENT_DRAFTED",
      entityType: "ADJUSTMENT",
      entityId: draft.id,
      afterJson: {
        type: body.type,
        state: "PENDING_REVIEW",
        amount: body.amount,
        approvalRequestId: approvalRequest.id,
        checklist: body.checklist ?? [],
      },
      approvalRequestId: approvalRequest.id,
    });
    return { adjustment: draft, approval: approvalRequest };
  });
  response.status(201).json({
    id: adjustment.id,
    state: adjustment.state,
    approvalRequestId: approval.id,
  });
});

const CASHOUT_OPEN_STATES: readonly string[] = ["PENDING", "PROCESSING"];

const cashoutListRow = (cashout: Record<string, any>) => ({
  id: cashout.id,
  merchantId: cashout.merchantId,
  merchantName: cashout.merchant?.tradeName ?? "",
  walletId: cashout.walletId,
  currency: cashout.wallet?.currency ?? "LYD",
  amount: merchantMoney(cashout.amount),
  state: cashout.state,
  destination: merchantMaskedJson(cashout.destinationBankJson),
  adjustmentId: cashout.adjustmentId,
  adjustmentState: cashout.adjustment?.state ?? null,
  adjustmentJournalEntryId: cashout.adjustment?.journalEntryId ?? null,
  requestedAt: cashout.createdAt,
  createdAt: cashout.createdAt,
  updatedAt: cashout.updatedAt,
  ageHours: approvalAgeHours(new Date(cashout.createdAt)),
});

router.get("/cashouts", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:read"]);
  const built = buildListQuery(request.query, {
    search: ["merchant.tradeName", "walletId", "id"],
    in: { state: "state" },
    equals: { merchantId: "merchantId", walletId: "walletId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { state: "state", amount: "amount", requestedAt: "createdAt", createdAt: "createdAt", updatedAt: "updatedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const [cashouts, total] = await Promise.all([
    client.cashoutRequest.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        merchant: { select: { id: true, tradeName: true, legalName: true } },
        wallet: { select: { id: true, currency: true, status: true } },
        adjustment: { select: { id: true, state: true, journalEntryId: true } },
      },
      skip: built.skip,
      take: built.take,
    }),
    client.cashoutRequest.count({ where: built.where as never }),
  ]);
  response.json(listResponse("cashouts", cashouts.map((cashout) => cashoutListRow(cashout as never)), total, built));
});

router.get("/cashouts/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:read"]);
  const built = buildListQuery(request.query, {
    search: ["merchant.tradeName", "walletId", "id"],
    in: { state: "state" },
    equals: { merchantId: "merchantId", walletId: "walletId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { state: "state", amount: "amount", requestedAt: "createdAt", createdAt: "createdAt", updatedAt: "updatedAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const take = 5000;
  const [cashouts, total] = await Promise.all([
    client.cashoutRequest.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      include: {
        merchant: { select: { id: true, tradeName: true, legalName: true } },
        wallet: { select: { id: true, currency: true, status: true } },
        adjustment: { select: { id: true, state: true, journalEntryId: true } },
      },
      take,
    }),
    client.cashoutRequest.count({ where: built.where as never }),
  ]);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "CASHOUT_QUEUE_EXPORTED",
      entityType: "CASHOUT_REQUEST",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: cashouts.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    cashouts: cashouts.map((cashout) => cashoutListRow(cashout as never)),
    total,
    exported: cashouts.length,
    truncated: total > cashouts.length,
  });
});

const buildCashoutSummary = async () => {
  const now = new Date();
  const [statusRows, openAggregate, oldestPending] = await Promise.all([
    client.cashoutRequest.groupBy({ by: ["state"], _count: { _all: true }, _sum: { amount: true } }),
    client.cashoutRequest.aggregate({
      where: { state: { in: [...CASHOUT_OPEN_STATES] as never } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    client.cashoutRequest.findFirst({
      where: { state: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const byState: Record<string, number> = {};
  const amountByState: Record<string, string> = {};
  for (const row of statusRows) {
    byState[row.state] = row._count._all;
    amountByState[row.state] = merchantMoney(row._sum.amount);
  }
  return {
    totalOpen: (openAggregate._count as { _all: number })._all,
    openAmount: merchantMoney((openAggregate._sum as { amount?: unknown } | undefined)?.amount),
    pendingCount: byState.PENDING ?? 0,
    processingCount: byState.PROCESSING ?? 0,
    completedCount: byState.COMPLETE ?? 0,
    subtractedCount: byState.SUBTRACTED ?? 0,
    rejectedCount: byState.REJECTED ?? 0,
    oldestPendingAgeHours: oldestPending ? approvalAgeHours(oldestPending.createdAt, now.getTime()) : 0,
    byState,
    amountByState,
  };
};

router.get("/cashouts/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:read"]);
  response.json(await buildCashoutSummary());
});

router.get("/cashouts/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:read"]);
  const summary = await buildCashoutSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "OPEN_SCOPE_VERIFIED",
    "AMOUNT_TOTALS_REVIEWED",
    "STATE_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "CASHOUT_SUMMARY_EXPORTED",
      entityType: "CASHOUT_REQUEST",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        totalOpen: summary.totalOpen,
        openAmount: summary.openAmount,
        oldestPendingAgeHours: summary.oldestPendingAgeHours,
        checklist,
      },
    },
  });
  response.json({ ...summary, exportedAt: new Date().toISOString() });
});


router.get("/cashouts/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const cashout = await client.cashoutRequest.findUnique({
    where: { id },
    include: {
      merchant: { select: { id: true, tradeName: true, legalName: true } },
      wallet: { select: { id: true, currency: true, status: true } },
      adjustment: { select: { id: true, state: true, journalEntryId: true, reason: true, amount: true } },
    },
  });
  if (!cashout) throw new ApiError(404, "CASHOUT_NOT_FOUND", "The cash-out request does not exist");
  const balance = await merchantWalletBalance(client, cashout.merchantId);
  const wallet = balance.wallets.find((entry) => entry.id === cashout.walletId);
  response.json({
    cashout: {
      ...cashoutListRow(cashout as never),
      merchantLegalName: cashout.merchant.legalName,
      walletStatus: cashout.wallet.status,
      walletBalance: wallet?.balance ?? null,
      adjustmentReason: cashout.adjustment?.reason ?? null,
      adjustmentAmount: cashout.adjustment ? merchantMoney(cashout.adjustment.amount) : null,
      canProcess: cashout.state === "PENDING",
      processBlockedReason: cashout.state === "PENDING" ? null : "CASHOUT_NOT_PENDING",
    },
  });
});

router.post("/cashouts/:id/process", async (request: Request, response: Response) => {
  // The checker authority of a cash-out is cashout:review (finance:write alone no longer
  // processes money). The maker is the merchant user who requested it: a different principal
  // type that can never reach this staff route.
  requireAuthorities(request, ["cashout:review"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({
      decision: z.enum(["APPROVE", "REJECT"]),
      reason: z.string().max(1000).optional(),
      checklist: z.array(z.enum([
        "BANK_DETAILS_VERIFIED",
        "WALLET_BALANCE_VERIFIED",
        "MERCHANT_ACTIVE",
        "NO_AML_RESTRICTIONS",
      ])).max(10).optional(),
    }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const platform = getPlatformRuntime(client as never);
  // The cash-out decision moves the money (or releases it) in the very same
  // transaction as the state change of the request.
  const result = await client.$transaction(async (tx) =>
    executeCashout(governanceContext(platform), tx as never, {
      cashoutId: id,
      decision: body.decision,
      reason: body.reason ?? null,
      actorUserId: actor.userId,
      actorRole: actor.role,
    }),
  );
  const cashout = await client.cashoutRequest.findUnique({ where: { id } });
  if (result.idempotent !== true) {
    await writeAudit(client, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "UNKNOWN",
        action: "CASHOUT_PROCESS_CHECKLIST",
        entityType: "CASHOUT_REQUEST",
        entityId: id,
        beforeJson: {},
        afterJson: {
          decision: body.decision,
          checklist: body.checklist ?? [],
          checklistComplete: (body.checklist?.length ?? 0) >= 4,
        },
      },
    });
  }
  response.json({
    id,
    state: cashout?.state ?? null,
    adjustmentId: cashout?.adjustmentId ?? null,
    journalEntryId: result.journalEntryId ?? null,
    status: result.status,
    idempotent: result.idempotent === true,
  });
});

router.get("/commission-profiles", async (request: Request, response: Response) => {
  requireAuthorities(request, ["commission:read", "finance:read"]);
  const [profiles, pendingApprovals] = await Promise.all([
    client.commissionProfile.findMany({ orderBy: { railCode: "asc" } }),
    client.approvalRequest.findMany({
      where: { subjectType: "COMMISSION_PROFILE", state: { in: [...APPROVAL_PENDING_STATES] } },
      select: { id: true, subjectId: true },
    }),
  ]);
  const pendingByProfile = new Map(pendingApprovals.map((approval) => [approval.subjectId, approval.id]));
  response.json({
    profiles: profiles.map((profile) => ({
      ...profile,
      pendingApprovalId: pendingByProfile.get(profile.id) ?? null,
    })),
  });
});

router.get("/commission-profiles/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["commission:read", "finance:read"]);
  const [profiles, pendingApprovals] = await Promise.all([
    client.commissionProfile.findMany({
      select: { railCode: true, calcType: true, merchantId: true, applicationId: true, maxFee: true, id: true },
    }),
    client.approvalRequest.findMany({
      where: { subjectType: "COMMISSION_PROFILE", state: { in: [...APPROVAL_PENDING_STATES] } },
      select: { subjectId: true },
    }),
  ]);
  const pendingIds = new Set(pendingApprovals.map((approval) => approval.subjectId));
  const byCalcType: Record<string, number> = {};
  const byRail: Record<string, number> = {};
  for (const profile of profiles) {
    byCalcType[profile.calcType] = (byCalcType[profile.calcType] ?? 0) + 1;
    byRail[profile.railCode] = (byRail[profile.railCode] ?? 0) + 1;
  }
  response.json({
    summary: {
      total: profiles.length,
      merchantScoped: profiles.filter((profile) => profile.merchantId !== null).length,
      applicationScoped: profiles.filter((profile) => profile.applicationId !== null).length,
      globalScoped: profiles.filter((profile) => profile.merchantId === null && profile.applicationId === null).length,
      withMaxFee: profiles.filter((profile) => profile.maxFee !== null).length,
      pendingLifecycle: profiles.filter((profile) => pendingIds.has(profile.id)).length,
      byCalcType,
      byRail,
    },
  });
});

router.post("/commission-profiles", async (request: Request, response: Response) => {
  requireAuthorities(request, ["commission:write"]);
  const body = parseOrThrow(
    z
      .object({
        merchantId: z.string().max(64).optional(),
        applicationId: z.string().max(64).optional(),
        railCode: z.string().min(1).max(64),
        calcType: z.enum(["FLAT", "PERCENTAGE", "TIERED", "HYBRID"]),
        flatFee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
        percentageRate: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default("0.000000"),
        // An ordered tier list (what the fee calculator reads). The legacy index-keyed object is still accepted.
        tiersJson: z
          .union([z.array(z.record(z.string().max(64), z.unknown())).max(20), z.record(z.string().max(64), z.unknown())])
          .optional(),
        minFee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
        maxFee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        feeBearerDefault: z.enum(["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"]).default("MERCHANT_ABSORBS"),
        roundingMode: z.string().max(32).default("HALF_UP"),
        effectiveFrom: z.string().max(64).optional(),
      })
      .strict(),
    request.body,
  );
  const profile = await client.commissionProfile.create({
    data: {
      merchantId: body.merchantId,
      applicationId: body.applicationId,
      railCode: body.railCode,
      calcType: body.calcType,
      flatFee: new Prisma.Decimal(body.flatFee),
      percentageRate: new Prisma.Decimal(body.percentageRate),
      tiersJson: jsonOptional(body.tiersJson),
      minFee: new Prisma.Decimal(body.minFee),
      maxFee: body.maxFee ? new Prisma.Decimal(body.maxFee) : null,
      feeBearerDefault: body.feeBearerDefault,
      roundingMode: body.roundingMode,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
    },
  });
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "COMMISSION_PROFILE_CREATED",
      entityType: "COMMISSION_PROFILE",
      entityId: profile.id,
      beforeJson: {},
      afterJson: {
        railCode: profile.railCode,
        calcType: profile.calcType,
        merchantId: profile.merchantId,
        applicationId: profile.applicationId,
        version: profile.version,
      },
    },
  });
  response.status(201).json({ id: profile.id, version: profile.version });
});

router.get("/commission-profiles/:id/history", async (request: Request, response: Response) => {
  requireAuthorities(request, ["commission:read", "finance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const profile = await client.commissionProfile.findUnique({ where: { id }, select: { id: true, railCode: true } });
  if (!profile) throw new ApiError(404, "COMMISSION_PROFILE_NOT_FOUND", "The commission profile does not exist");
  const history = await client.auditLog.findMany({
    where: { entityType: "COMMISSION_PROFILE", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      createdAt: true,
      action: true,
      role: true,
      beforeJson: true,
      afterJson: true,
      approvalRequestId: true,
      actor: { select: { id: true, email: true } },
    },
  });
  response.json({ history });
});

router.post("/commission-profiles/:id/expire", async (request: Request, response: Response) => {
  requireAuthorities(request, ["commission:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        effectiveTo: z.string().max(64).optional(),
        reason: z.string().max(500).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const profile = await client.commissionProfile.findUnique({ where: { id } });
  if (!profile) {
    throw new ApiError(404, "COMMISSION_PROFILE_NOT_FOUND", "The commission profile does not exist");
  }
  const now = new Date();
  if (profile.effectiveTo && profile.effectiveTo.getTime() <= now.getTime()) {
    throw new ApiError(409, "COMMISSION_PROFILE_ALREADY_EXPIRED", "The commission profile is already expired");
  }
  const pendingCommissionApproval = await client.approvalRequest.findFirst({
    where: {
      subjectType: "COMMISSION_PROFILE",
      subjectId: profile.id,
      state: { in: [...APPROVAL_PENDING_STATES] },
    },
    select: { id: true },
  });
  if (pendingCommissionApproval) {
    throw new ApiError(409, "COMMISSION_PROFILE_PENDING_CHECKER", "A lifecycle change is already awaiting a checker", {
      approvalRequestId: pendingCommissionApproval.id,
    });
  }
  const effectiveTo = body.effectiveTo ? new Date(body.effectiveTo) : now;
  if (Number.isNaN(effectiveTo.getTime())) {
    throw new ApiError(400, "INVALID_EFFECTIVE_TO", "effectiveTo must be a valid date");
  }
  const actor = actorFromRequest(request);
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "COMMISSION_PROFILE",
      subjectId: profile.id,
      payloadDiffJson: {
        action: "EXPIRE",
        effectiveTo: effectiveTo.toISOString(),
        reason: body.reason ?? null,
      },
      makerReason: body.reason ?? null,
      mode: "STANDARD",
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
});

router.get("/velocity-rules", async (request: Request, response: Response) => {
  requireAuthorities(request, ["velocity:read", "compliance:read"]);
  const [rules, pendingApprovals] = await Promise.all([
    client.velocityRule.findMany({ orderBy: { createdAt: "desc" } }),
    client.approvalRequest.findMany({
      where: { subjectType: "VELOCITY_RULE", state: { in: [...APPROVAL_PENDING_STATES] } },
      select: { id: true, subjectId: true },
    }),
  ]);
  const pendingByRule = new Map(pendingApprovals.map((approval) => [approval.subjectId, approval.id]));
  response.json({
    rules: rules.map((rule) => ({
      ...rule,
      pendingApprovalId: pendingByRule.get(rule.id) ?? null,
    })),
  });
});

router.get("/velocity-rules/:id/history", async (request: Request, response: Response) => {
  requireAuthorities(request, ["velocity:read", "compliance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const rule = await client.velocityRule.findUnique({ where: { id }, select: { id: true, scopeType: true } });
  if (!rule) throw new ApiError(404, "VELOCITY_RULE_NOT_FOUND", "The velocity rule does not exist");
  const history = await client.auditLog.findMany({
    where: { entityType: "VELOCITY_RULE", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      createdAt: true,
      action: true,
      role: true,
      beforeJson: true,
      afterJson: true,
      approvalRequestId: true,
      actor: { select: { id: true, email: true } },
    },
  });
  response.json({ history });
});

router.post("/velocity-rules/:id/deactivate", async (request: Request, response: Response) => {
  requireAuthorities(request, ["velocity:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ reason: z.string().max(500).optional() }).strict(),
    request.body ?? {},
  );
  const rule = await client.velocityRule.findUnique({ where: { id } });
  if (!rule) {
    throw new ApiError(404, "VELOCITY_RULE_NOT_FOUND", "The velocity rule does not exist");
  }
  if (!rule.active) {
    throw new ApiError(409, "VELOCITY_RULE_ALREADY_INACTIVE", "The velocity rule is already inactive");
  }
  const pendingVelocityApproval = await client.approvalRequest.findFirst({
    where: {
      subjectType: "VELOCITY_RULE",
      subjectId: rule.id,
      state: { in: [...APPROVAL_PENDING_STATES] },
    },
    select: { id: true },
  });
  if (pendingVelocityApproval) {
    throw new ApiError(409, "VELOCITY_RULE_PENDING_CHECKER", "A lifecycle change is already awaiting a checker", {
      approvalRequestId: pendingVelocityApproval.id,
    });
  }
  const actor = actorFromRequest(request);
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "VELOCITY_RULE",
      subjectId: rule.id,
      payloadDiffJson: { action: "DEACTIVATE", reason: body.reason ?? null },
      makerReason: body.reason ?? null,
      mode: "STANDARD",
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
});

router.get("/velocity-rules/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["velocity:read", "compliance:read"]);
  const [rules, pendingApprovals] = await Promise.all([
    client.velocityRule.findMany({
      select: { id: true, scopeType: true, action: true, windowSeconds: true, maxAmount: true },
    }),
    client.approvalRequest.findMany({
      where: { subjectType: "VELOCITY_RULE", state: { in: [...APPROVAL_PENDING_STATES] } },
      select: { subjectId: true },
    }),
  ]);
  const pendingIds = new Set(pendingApprovals.map((approval) => approval.subjectId));
  const byScopeType: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const rule of rules) {
    byScopeType[rule.scopeType] = (byScopeType[rule.scopeType] ?? 0) + 1;
    byAction[rule.action] = (byAction[rule.action] ?? 0) + 1;
  }
  response.json({
    summary: {
      total: rules.length,
      reject: rules.filter((rule) => rule.action === "REJECT").length,
      flag: rules.filter((rule) => rule.action === "FLAG").length,
      withAmountCap: rules.filter((rule) => rule.maxAmount !== null).length,
      pendingLifecycle: rules.filter((rule) => pendingIds.has(rule.id)).length,
      longestWindowSeconds: rules.reduce((max, rule) => Math.max(max, rule.windowSeconds), 0),
      byScopeType,
      byAction,
    },
  });
});

router.post("/velocity-rules", async (request: Request, response: Response) => {
  requireAuthorities(request, ["velocity:write", "compliance:write"]);
  const body = parseOrThrow(
    z
      .object({
        scopeType: z.enum(["END_CLIENT_IP", "END_CLIENT_PHONE", "END_CLIENT_CARD", "MERCHANT", "APPLICATION", "RAIL", "LINK"]),
        scopeValue: z.string().max(160).optional(),
        windowSeconds: z.number().int().min(1).max(31_536_000),
        maxCount: z.number().int().min(1).max(1_000_000),
        maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        action: z.enum(["REJECT", "FLAG"]),
      })
      .strict(),
    request.body,
  );
  const rule = await client.velocityRule.create({
    data: {
      scopeType: body.scopeType,
      scopeValue: body.scopeValue,
      windowSeconds: body.windowSeconds,
      maxCount: body.maxCount,
      maxAmount: body.maxAmount ? new Prisma.Decimal(body.maxAmount) : null,
      action: body.action,
      effectiveFrom: new Date(),
    },
  });
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "VELOCITY_RULE_CREATED",
      entityType: "VELOCITY_RULE",
      entityId: rule.id,
      beforeJson: {},
      afterJson: {
        scopeType: rule.scopeType,
        action: rule.action,
        windowSeconds: rule.windowSeconds,
        maxCount: rule.maxCount,
        version: rule.version,
      },
    },
  });
  response.status(201).json({ id: rule.id, version: rule.version });
});

/**
 * The live balance of every GL account, grouped by account type.
 *
 * A live balance is the checkpoint balance plus the journal lines that were
 * posted after the checkpoint. Summing every line would double count the
 * window the checkpoint already covers.
 */
const loadLedgerBalances = async (): Promise<Map<string, Decimal>> => {
  // One grouped statement (shard totals, or checkpoint + post-checkpoint
  // lines) instead of one journal_lines query per account without shards.
  const live = await loadLiveAccountBalances(client as never);
  const balances = new Map<string, Decimal>();
  for (const account of live) {
    balances.set(
      account.accountType,
      (balances.get(account.accountType) ?? decimal(0)).plus(decimal(account.balance)),
    );
  }
  return balances;
};

const profitabilityQuerySchema = z
  .object({
    period: z.enum(["today", "last_7d", "last_30d", "last_90d"]).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
    currency: z.string().length(3).optional(),
  })
  .strict();

const buildProfitabilitySnapshot = async (rawQuery: Request["query"]) => {
  const query = parseOrThrow(profitabilityQuerySchema, rawQuery ?? {});
  const period = query.period ?? "last_30d";
  const periodDays = { today: 1, last_7d: 7, last_30d: 30, last_90d: 90 }[period];
  const now = new Date();
  let since = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  let until: Date | undefined;
  if (query.from) {
    const parsed = new Date(query.from);
    if (!Number.isNaN(parsed.getTime())) since = parsed;
  }
  if (query.to) {
    const parsed = new Date(query.to);
    if (!Number.isNaN(parsed.getTime())) until = parsed;
  }
  const windowEnd = until ?? now;
  const windowDays = Math.max(
    1,
    Math.ceil((windowEnd.getTime() - since.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const attempts = await client.paymentAttempt.findMany({
    where: { createdAt: until ? { gte: since, lte: until } : { gte: since } },
    select: {
      status: true,
      totalChargedAmount: true,
      platformCommissionAmount: true,
      netMerchantAmount: true,
      gatewayFeeAmount: true,
      createdAt: true,
      railId: true,
      routeId: true,
    },
  });
  const railCodes = new Map((await client.rail.findMany({ select: { id: true, code: true } })).map((rail) => [rail.id, rail.code]));
  const routeGateways = new Map(
    (await client.railRoute.findMany({ select: { id: true, gatewayId: true } })).map((route) => [route.id, route.gatewayId]),
  );
  const gatewayCodes = new Map(
    (await client.gateway.findMany({ select: { id: true, code: true } })).map((gateway) => [gateway.id, gateway.code]),
  );

  type ProfitBucket = { volume: Decimal; gross: Decimal; cost: Decimal };
  const bucket = (): ProfitBucket => ({ volume: decimal(0), gross: decimal(0), cost: decimal(0) });

  let grossVolume = decimal(0);
  let grossCommission = decimal(0);
  let netMerchant = decimal(0);
  let gatewayCostPeriod = decimal(0);
  const byRail = new Map<string, ProfitBucket>();
  const byDay = new Map<string, ProfitBucket>();
  const byGateway = new Map<string, ProfitBucket>();

  for (const attempt of attempts) {
    if (attempt.status !== "SUCCEEDED") {
      continue;
    }
    const volume = decimal(attempt.totalChargedAmount);
    const commission = decimal(attempt.platformCommissionAmount);
    const cost = decimal(attempt.gatewayFeeAmount ?? 0);
    grossVolume = grossVolume.plus(volume);
    grossCommission = grossCommission.plus(commission);
    netMerchant = netMerchant.plus(decimal(attempt.netMerchantAmount));
    gatewayCostPeriod = gatewayCostPeriod.plus(cost);

    const railCode = railCodes.get(attempt.railId) ?? "unknown";
    const railEntry = byRail.get(railCode) ?? bucket();
    railEntry.volume = railEntry.volume.plus(volume);
    railEntry.gross = railEntry.gross.plus(commission);
    railEntry.cost = railEntry.cost.plus(cost);
    byRail.set(railCode, railEntry);

    const day = attempt.createdAt.toISOString().slice(0, 10);
    const dayEntry = byDay.get(day) ?? bucket();
    dayEntry.volume = dayEntry.volume.plus(volume);
    dayEntry.gross = dayEntry.gross.plus(commission);
    dayEntry.cost = dayEntry.cost.plus(cost);
    byDay.set(day, dayEntry);

    const gatewayId = attempt.routeId ? routeGateways.get(attempt.routeId) ?? "unknown" : "unknown";
    const gatewayCode = gatewayCodes.get(gatewayId) ?? gatewayId;
    const gatewayEntry = byGateway.get(gatewayCode) ?? bucket();
    gatewayEntry.volume = gatewayEntry.volume.plus(volume);
    gatewayEntry.gross = gatewayEntry.gross.plus(commission);
    gatewayEntry.cost = gatewayEntry.cost.plus(cost);
    byGateway.set(gatewayCode, gatewayEntry);
  }

  const balances = await loadLedgerBalances();
  // The natural balance of an account: positive for a debit-normal account
  // (assets and expenses) and positive for a credit-normal account
  // (liabilities and income).
  const natural = (type: string): Decimal => {
    const raw = balances.get(type) ?? decimal(0);
    return naturalBalance(type, raw);
  };

  const gatewayCostRealized = natural("GATEWAY_FEE_EXPENSE").plus(natural("PROVIDER_FEE_EXPENSE"));
  const gatewayCostAccrued = natural("GATEWAY_FEE_ACCRUAL");
  const chargebackLosses = natural("CHARGEBACK_RESERVE");
  const commissionReceivable = natural("COMMISSION_RECEIVABLE");
  const netRevenue = grossCommission.minus(gatewayCostRealized);
  const netContribution = netRevenue.minus(chargebackLosses);
  const [chargebackPeriod, refundCommissionPeriod] = await Promise.all([
    client.adjustment.aggregate({
      where: { type: "CHARGEBACK", state: "EXECUTED", updatedAt: { gte: since, lte: windowEnd } },
      _sum: { amount: true },
    }),
    client.adjustment.aggregate({
      where: { type: "REFUND", reverseCommission: true, state: "EXECUTED", updatedAt: { gte: since, lte: windowEnd } },
      _sum: { amount: true },
    }),
  ]);
  const chargebackLossesPeriod = decimal(chargebackPeriod._sum.amount ?? 0);
  const refundCommissionReversed = decimal(refundCommissionPeriod._sum.amount ?? 0);
  const periodNetRevenue = grossCommission.minus(gatewayCostPeriod);
  const periodNetContribution = periodNetRevenue.minus(chargebackLossesPeriod);

  const toRows = (source: Map<string, ProfitBucket>, keyName: string) =>
    [...source.entries()]
      .map(([key, value]) => ({
        [keyName]: key,
        volume: value.volume.toFixed(4),
        gross: value.gross.toFixed(4),
        cost: value.cost.toFixed(4),
        net: value.gross.minus(value.cost).toFixed(4),
        commission: value.gross.toFixed(4),
      }))
      .sort((left, right) => String(left[keyName]).localeCompare(String(right[keyName])));

  const succeededAttempts = attempts.filter((attempt) => attempt.status === "SUCCEEDED").length;
  const percentage = (numerator: Decimal, denominator: Decimal): string =>
    denominator.isZero() ? "0.0000" : numerator.div(denominator).mul(100).toFixed(4);
  return {
    period,
    currency: query.currency?.toUpperCase() ?? "LYD",
    windowDays,
    windowStart: since.toISOString(),
    windowEnd: windowEnd.toISOString(),
    succeededAttempts,
    grossVolume: grossVolume.toFixed(4),
    grossCommissionRevenue: grossCommission.toFixed(4),
    netMerchantAmount: netMerchant.toFixed(4),
    gatewayCostRealized: gatewayCostRealized.toFixed(4),
    gatewayCostAccrued: gatewayCostAccrued.toFixed(4),
    netRevenue: netRevenue.toFixed(4),
    chargebackLosses: chargebackLosses.toFixed(4),
    netContribution: netContribution.toFixed(4),
    gatewayCostPeriod: gatewayCostPeriod.toFixed(4),
    periodNetRevenue: periodNetRevenue.toFixed(4),
    chargebackLossesPeriod: chargebackLossesPeriod.toFixed(4),
    periodNetContribution: periodNetContribution.toFixed(4),
    refundCommissionReversed: refundCommissionReversed.toFixed(4),
    commissionReceivable: commissionReceivable.toFixed(4),
    commissionMargin: percentage(periodNetRevenue, grossCommission),
    gatewayCostRatio: percentage(gatewayCostPeriod, grossCommission),
    netMargin: percentage(periodNetContribution, grossCommission),
    averageTicket: succeededAttempts === 0 ? "0.0000" : grossVolume.div(succeededAttempts).toFixed(4),
    averageCommission: succeededAttempts === 0 ? "0.0000" : grossCommission.div(succeededAttempts).toFixed(4),
    byRail: toRows(byRail, "railCode"),
    byDay: toRows(byDay, "day"),
    byGateway: toRows(byGateway, "gatewayCode"),
  };
};

router.get("/finance/profitability", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  response.json(await buildProfitabilitySnapshot(request.query));
});

router.get("/finance/profitability/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const snapshot = await buildProfitabilitySnapshot(request.query);
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "PROFITABILITY_EXPORTED",
      entityType: "PROFITABILITY",
      entityId: "snapshot",
      beforeJson: {},
      afterJson: {
        period: snapshot.period,
        windowStart: snapshot.windowStart,
        windowEnd: snapshot.windowEnd,
        grossVolume: snapshot.grossVolume,
        netContribution: snapshot.netContribution,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


/**
 * The operational reporting of the daily cap guard.
 *
 * The processed volume is derived from the succeeded attempts of the current
 * business day, exactly like the checkout resolution does, and the headroom
 * is evaluated with the very same helper the visible rails formula uses. An
 * operator therefore sees the same cap the customer sees.
 */
router.get("/finance/route-caps", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const now = new Date();
  const timeZone = await resolveGatewayTimezone(client as never);
  const window = dayWindowInTimeZone(now, timeZone);
  const repositories = new PrismaRepositories(client as never);
  const processed = await repositories.payments.sumSucceededAmountByRouteInWindow(
    client as never,
    window,
  );
  const routes = await client.railRoute.findMany({ include: { rail: true } });

  const rows = routes.map((route) => {
    const processedAmount = processed.get(route.id) ?? 0n;
    const cap = evaluateRouteDailyCap(
      {
        dailyCapAmount: route.dailyCapAmount,
        dailyProcessedAmount: moneyToString(processedAmount),
      },
      0,
    );
    // The very same evaluation the visible rails formula performs: a route
    // whose daily cap is exhausted is excluded with `DAILY_CAP_EXCEEDED`.
    return {
      routeId: route.id,
      railCode: route.rail.code,
      gatewayId: route.gatewayId,
      dailyCapAmount: cap.cap?.toFixed(4) ?? null,
      dailyProcessedAmount: cap.processed.toFixed(4),
      dailyCapRemaining: cap.remaining?.toFixed(4) ?? null,
      capExhausted: cap.cap !== null && cap.remaining !== null && cap.remaining.lte(0),
      exclusionReason: cap.withinCap ? null : "DAILY_CAP_EXCEEDED",
      utilisation:
        cap.cap !== null && cap.cap.gt(0)
          ? cap.processed.div(cap.cap).mul(100).toFixed(2)
          : null,
    };
  });

  response.json({
    currency: "LYD",
    timeZone,
    businessDay: {
      since: window.since.toISOString(),
      until: window.until.toISOString(),
    },
    routes: rows,
  });
});

const buildLiquiditySnapshot = async () => {
  const balances = await loadLedgerBalances();
  const debitPositive = (type: string): Decimal => balances.get(type) ?? decimal(0);
  const creditPositive = (type: string): Decimal => naturalBalance(type, balances.get(type) ?? decimal(0));

  const treasury = debitPositive("TREASURY");
  const clearing = debitPositive("GATEWAY_CLEARING");
  const walletObligations = creditPositive("MERCHANT_WALLET");
  const coverRatio = clearing.isZero() ? decimal(1) : treasury.div(clearing);

  const cashouts = await client.cashoutRequest.findMany({
    select: { state: true, amount: true, createdAt: true },
  });
  const pending = cashouts.filter((cashout) => cashout.state === "PENDING");
  const processing = cashouts.filter((cashout) => cashout.state === "PROCESSING");
  const completed = cashouts.filter((cashout) => cashout.state === "COMPLETE" || cashout.state === "SUBTRACTED");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const nextDayDemand = cashouts
    .filter((cashout) => cashout.createdAt <= tomorrow && (cashout.state === "PENDING" || cashout.state === "PROCESSING"))
    .reduce((sum, cashout) => sum.plus(decimal(cashout.amount)), decimal(0));

  const oldestCase = await client.operatorCase.findFirst({
    where: { state: { not: "RESOLVED" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const oldestItemAgeDays = oldestCase
    ? Math.max(0, Math.floor((Date.now() - oldestCase.createdAt.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  const unsettled = await client.paymentAttempt.findMany({
    where: { status: "SUCCEEDED", createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
    select: { createdAt: true, settledAmount: true, totalChargedAmount: true, routeId: true },
  });
  const routeGateways = new Map(
    (await client.railRoute.findMany({ select: { id: true, gatewayId: true } })).map((route) => [route.id, route.gatewayId]),
  );
  const clearingAccounts = await client.glAccount.findMany({
    where: { accountType: "GATEWAY_CLEARING" },
    select: { id: true, gatewayId: true },
  });
  const clearingAccountIds = clearingAccounts.map((account) => account.id);
  // Balance = the shard totals of each gateway's clearing accounts. The age buckets are the NET signed
  // movement (debit positive) of the lines of the last three days, bounded by `created_at` so the cost does not
  // grow with history and does not depend on any checkpoint; "older" is whatever is left of the balance.
  const clearingLive = await loadLiveAccountBalances(client as never, clearingAccountIds);
  const clearingMovement = clearingAccountIds.length === 0
    ? []
    : ((await client.$queryRawUnsafe(
        `SELECT a.gateway_id::text AS "gatewayId",
                COALESCE(SUM(x.signed) FILTER (WHERE x.age <= 0), 0)::text AS t0,
                COALESCE(SUM(x.signed) FILTER (WHERE x.age = 1), 0)::text AS t1,
                COALESCE(SUM(x.signed) FILTER (WHERE x.age = 2), 0)::text AS t2
         FROM (
           SELECT jl.gl_account_id,
                  FLOOR(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - jl.created_at)) / 86400)::int AS age,
                  CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END AS signed
           FROM journal_lines jl
           WHERE jl.gl_account_id = ANY($1::uuid[])
             AND jl.created_at >= (now() AT TIME ZONE 'UTC') - interval '3 days'
         ) x
         INNER JOIN gl_accounts a ON a.id = x.gl_account_id
         GROUP BY a.gateway_id`,
        clearingAccountIds,
      )) as Array<{ gatewayId: string | null; t0: string; t1: string; t2: string }>);
  const clearingBalanceByGateway = new Map<string, Decimal>();
  const clearingBucketsByGateway = new Map<string, { t0: Decimal; t1: Decimal; t2: Decimal; older: Decimal }>();
  const liveByAccount = new Map(clearingLive.map((row) => [row.id, decimal(row.balance)]));
  for (const account of clearingAccounts) {
    if (!account.gatewayId) continue;
    clearingBalanceByGateway.set(
      account.gatewayId,
      (clearingBalanceByGateway.get(account.gatewayId) ?? decimal(0)).plus(liveByAccount.get(account.id) ?? decimal(0)),
    );
  }
  for (const row of clearingMovement) {
    if (!row.gatewayId) continue;
    const balance = clearingBalanceByGateway.get(row.gatewayId) ?? decimal(0);
    const t0 = decimal(row.t0);
    const t1 = decimal(row.t1);
    const t2 = decimal(row.t2);
    clearingBucketsByGateway.set(row.gatewayId, { t0, t1, t2, older: balance.minus(t0).minus(t1).minus(t2) });
  }
  for (const [gatewayId, balance] of clearingBalanceByGateway) {
    if (!clearingBucketsByGateway.has(gatewayId)) {
      clearingBucketsByGateway.set(gatewayId, { t0: decimal(0), t1: decimal(0), t2: decimal(0), older: balance });
    }
  }
  const gatewayCodes = new Map(
    (await client.gateway.findMany({ select: { id: true, code: true, name: true } })).map((gateway) => [gateway.id, gateway]),
  );
  const clearingByGateway = [...clearingBalanceByGateway.entries()]
    .map(([gatewayId, balance]) => {
      const gateway = gatewayCodes.get(gatewayId);
      const buckets = clearingBucketsByGateway.get(gatewayId) ?? { t0: decimal(0), t1: decimal(0), t2: decimal(0), older: decimal(0) };
      return {
        gatewayId,
        gatewayCode: gateway?.code ?? gatewayId,
        gatewayName: gateway?.name ?? "",
        balance: balance.toFixed(4),
        t0: buckets.t0.toFixed(4),
        t1: buckets.t1.toFixed(4),
        t2: buckets.t2.toFixed(4),
        older: buckets.older.toFixed(4),
      };
    })
    .sort((left, right) => left.gatewayCode.localeCompare(right.gatewayCode));

  const ageingBucket = (label: string, minDays: number, maxDays: number) => {
    const rows = unsettled.filter((attempt) => {
      const age = Math.floor((Date.now() - attempt.createdAt.getTime()) / (24 * 60 * 60 * 1000));
      return age >= minDays && age <= maxDays;
    });
    return {
      bucket: label,
      count: rows.length,
      amount: rows
        .reduce((sum, attempt) => sum.plus(decimal(attempt.settledAmount ?? attempt.totalChargedAmount)), decimal(0))
        .toFixed(4),
    };
  };

  return {
    currency: "LYD",
    checkedAt: new Date().toISOString(),
    treasuryBalance: treasury.toFixed(4),
    clearingBalances: clearing.toFixed(4),
    obligations: walletObligations.toFixed(4),
    coverRatio: coverRatio.toFixed(4),
    cashoutQueue: {
      pending: pending.length,
      processing: processing.length,
      completed: completed.length,
      nextDayDemand: nextDayDemand.toFixed(4),
    },
    holdsAndReserves: {
      amlHold: creditPositive("AML_HOLD").toFixed(4),
      chargebackReserve: creditPositive("CHARGEBACK_RESERVE").toFixed(4),
      suspense: creditPositive("SUSPENSE").toFixed(4),
      oldestItemAgeDays,
    },
    receivables: {
      commissionReceivable: debitPositive("COMMISSION_RECEIVABLE").toFixed(4),
    },
    clearingAgeing: [
      ageingBucket("0-7 days", 0, 7),
      ageingBucket("8-30 days", 8, 30),
      ageingBucket("31+ days", 31, 3650),
    ],
    clearingByGateway,
  };
};

router.get("/finance/liquidity", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  response.json(await buildLiquiditySnapshot());
});

router.get("/finance/liquidity/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const snapshot = await buildLiquiditySnapshot();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "LIQUIDITY_EXPORTED",
      entityType: "LIQUIDITY",
      entityId: "snapshot",
      beforeJson: {},
      afterJson: {
        coverRatio: snapshot.coverRatio,
        treasuryBalance: snapshot.treasuryBalance,
        clearingBalances: snapshot.clearingBalances,
        gatewayCount: snapshot.clearingByGateway.length,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


const buildInvariantSnapshot = async () => {
  const verifier = new InvariantVerifier(client as never, { sql: true });
  const result = await verifier.verify();
  const sides = new Map<string, Decimal>();
  for (const balance of result.accountBalances) {
    const current = sides.get(balance.accountType) ?? decimal(0);
    sides.set(balance.accountType, current.plus(decimal(balance.liveBalance)));
  }
  const natural = (type: string): Decimal => {
    const raw = sides.get(type) ?? decimal(0);
    return naturalBalance(type, raw);
  };

  const treasury = natural("TREASURY");
  const clearing = natural("GATEWAY_CLEARING");
  const commissionReceivable = natural("COMMISSION_RECEIVABLE");
  const merchantWallet = natural("MERCHANT_WALLET");
  const platformIncome = natural("PLATFORM_INCOME");
  const providerFeeExpense = natural("PROVIDER_FEE_EXPENSE");
  const gatewayFeeExpense = natural("GATEWAY_FEE_EXPENSE");
  const gatewayFeeAccrual = natural("GATEWAY_FEE_ACCRUAL");
  const amlHold = natural("AML_HOLD");
  const chargebackReserve = natural("CHARGEBACK_RESERVE");
  const suspense = natural("SUSPENSE");

  const left = result.leftSide;
  const right = result.rightSide;
  const drift = result.drift;

  return {
    ok: drift.isZero(),
    drift: drift.toFixed(4),
    checkedAt: new Date().toISOString(),
    leftSide: left.toFixed(4),
    rightSide: right.toFixed(4),
    sides: {
      treasury: treasury.toFixed(4),
      clearing: clearing.toFixed(4),
      commissionReceivable: commissionReceivable.toFixed(4),
      merchantWallet: merchantWallet.toFixed(4),
      platformIncome: platformIncome.toFixed(4),
      providerFeeExpense: providerFeeExpense.toFixed(4),
      gatewayFeeExpense: gatewayFeeExpense.toFixed(4),
      gatewayFeeAccrual: gatewayFeeAccrual.toFixed(4),
      amlHold: amlHold.toFixed(4),
      chargebackReserve: chargebackReserve.toFixed(4),
      suspense: suspense.toFixed(4),
    },
    accounts: result.accountBalances.map((account) => ({
      accountId: account.accountId,
      accountType: account.accountType,
      liveBalance: account.liveBalance.toFixed(4),
      naturalBalance: naturalBalance(account.accountType, account.liveBalance).toFixed(4),
      checkpointAt: account.checkpointAt ?? null,
    })),
  };
};

router.get("/finance/invariant-check", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  response.json(await buildInvariantSnapshot());
});

router.get("/finance/invariant-check/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const snapshot = await buildInvariantSnapshot();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "INVARIANT_EXPORTED",
      entityType: "INVARIANT",
      entityId: "snapshot",
      beforeJson: {},
      afterJson: {
        ok: snapshot.ok,
        drift: snapshot.drift,
        leftSide: snapshot.leftSide,
        rightSide: snapshot.rightSide,
        accounts: snapshot.accounts.length,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


/**
 * The checkout help & support configuration of the four portal guides.
 *
 * The admin edits the support channels and the FAQ once; the checkout help
 * center reads them on every link load, so disabling the section here hides the
 * Contact Us block on every checkout page immediately.
 */
const CHECKOUT_SUPPORT_KEY = "checkout.support_config";

const checkoutSupportSchema = z
  .strictObject({
    enabled: z.boolean(),
    show_platform_contact: z.boolean().default(true),
    show_merchant_contact: z.boolean().default(true),
    support_phone: z.string().trim().max(40).optional(),
    support_whatsapp: z.string().trim().max(40).optional(),
    support_email: z.string().trim().max(160).optional(),
    working_hours_ar: z.string().max(300).optional(),
    working_hours_en: z.string().max(300).optional(),
    faq_items: z
      .array(
        z.strictObject({
          q_ar: z.string().max(1000),
          a_ar: z.string().max(4000),
          q_en: z.string().max(1000),
          a_en: z.string().max(4000),
        }),
      )
      .max(50)
      .default([]),
  });

const loadCheckoutSupport = async (): Promise<Record<string, unknown> | null> => {
  const setting = await client.platformSetting.findFirst({
    where: { key: CHECKOUT_SUPPORT_KEY },
    orderBy: { version: "desc" },
  });
  return (setting?.valueJson as Record<string, unknown> | undefined) ?? null;
};

router.get("/settings/checkout-support", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const setting = await client.platformSetting.findFirst({
    where: { key: CHECKOUT_SUPPORT_KEY },
    orderBy: { version: "desc" },
  });
  response.json({
    key: CHECKOUT_SUPPORT_KEY,
    value: (setting?.valueJson ?? null) as unknown,
    version: setting?.version ?? null,
    updatedAt: setting?.updatedAt ?? null,
  });
});

router.get("/settings/checkout-support/history", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const versions = await client.platformSetting.findMany({
    where: { key: CHECKOUT_SUPPORT_KEY },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      valueJson: true,
      effectiveFrom: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  response.json({ key: CHECKOUT_SUPPORT_KEY, versions });
});

const buildCheckoutSupportSummary = async () => {
  const rows = await client.platformSetting.findMany({
    where: { key: CHECKOUT_SUPPORT_KEY },
    orderBy: { version: "desc" },
    select: { version: true, valueJson: true, effectiveFrom: true, updatedAt: true },
  });
  const latest = rows[0];
  const value = (latest?.valueJson ?? {}) as Record<string, unknown>;
  const channels = ["support_phone", "support_whatsapp", "support_email"].filter((key) => {
    const entry = value[key];
    return typeof entry === "string" && entry.trim().length > 0;
  });
  const faqItems = Array.isArray(value.faq_items) ? value.faq_items.length : 0;
  return {
    summary: {
      enabled: value.enabled === true,
      showPlatformContact: value.show_platform_contact !== false,
      showMerchantContact: value.show_merchant_contact !== false,
      faqItems,
      channels,
      channelCount: channels.length,
      versions: rows.length,
      currentVersion: latest?.version ?? 0,
      updatedAt: latest?.updatedAt ?? null,
      effectiveFrom: latest?.effectiveFrom ?? null,
      futureEffective: latest ? latest.effectiveFrom.getTime() > Date.now() : false,
    },
  };
};

router.get("/settings/checkout-support/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  response.json(await buildCheckoutSupportSummary());
});

router.get("/settings/checkout-support/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const snapshot = await buildCheckoutSupportSummary();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "CHECKOUT_SUPPORT_SUMMARY_EXPORTED",
      entityType: "PLATFORM_SETTING",
      entityId: "checkout.support_config",
      beforeJson: {},
      afterJson: {
        enabled: snapshot.summary.enabled,
        versions: snapshot.summary.versions,
        currentVersion: snapshot.summary.currentVersion,
        faqItems: snapshot.summary.faqItems,
        channelCount: snapshot.summary.channelCount,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});

router.put("/settings/checkout-support", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:write"]);
  const body = parseOrThrow(z.strictObject({
    value: checkoutSupportSchema,
    checklist: z.array(z.enum([
      "SUPPORT_CHANNELS_VERIFIED",
      "FAQ_CONTENT_REVIEWED",
      "WORKING_HOURS_VERIFIED",
      "PAYER_VISIBILITY_REVIEWED",
    ])).max(10).optional(),
  }).strict(), request.body ?? {});
  const existing = await client.platformSetting.findFirst({
    where: { key: CHECKOUT_SUPPORT_KEY },
    orderBy: { version: "desc" },
  });
  const nextVersion = (existing?.version ?? 0) + 1;
  const value = json(body.value);
  const task = existing
    ? client.platformSetting.create({
        data: {
          key: CHECKOUT_SUPPORT_KEY,
          scope: existing.scope,
          version: nextVersion,
          valueJson: value,
          effectiveFrom: new Date(),
        },
      })
    : client.platformSetting.create({
        data: {
          key: CHECKOUT_SUPPORT_KEY,
          scope: "PLATFORM",
          version: nextVersion,
          valueJson: value,
          effectiveFrom: new Date(),
        },
      });
  const created = await task;
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "CHECKOUT_SUPPORT_UPDATED",
      entityType: "PLATFORM_SETTING",
      entityId: created.id,
      beforeJson: json(existing?.valueJson ?? null),
      afterJson: value,
    },
  });
  await writeAudit(client, {
    data: {
      actorId: actorFromRequest(request).userId,
      role: actorFromRequest(request).role,
      action: "CHECKOUT_SUPPORT_EDIT_CHECKLIST",
      entityType: "PLATFORM_SETTING",
      entityId: created.id,
      beforeJson: {},
      afterJson: { version: nextVersion, checklist: body.checklist ?? [] },
    },
  });
  response.json({ key: CHECKOUT_SUPPORT_KEY, value: body.value, version: nextVersion });
});

const auditStoreParamsFromRequest = (
  request: Request,
  built: ReturnType<typeof buildListQuery>,
  limit: number,
  offset: number,
) => {
  const first = (name: string): string | undefined => {
    const value = request.query[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const date = (name: string): Date | undefined => {
    const value = first(name);
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  return {
    entityType: first("entityType"),
    entityId: first("entityId"),
    actorId: first("actorId"),
    action: first("action"),
    role: first("role"),
    searchPrefix: first("search"),
    createdFrom: date("from") ?? date("dateFrom"),
    createdTo: date("to") ?? date("dateTo"),
    limit,
    offset,
  };
};

const auditStoreRowToApi = (row: {
  id: string;
  createdAt: Date;
  actorId: string;
  actorEmail?: string | null;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  approvalRequestId?: string | null;
}) => ({
  id: row.id,
  createdAt: row.createdAt,
  actorId: row.actorId,
  actorEmail: row.actorEmail ?? "",
  role: row.role,
  action: row.action,
  entityType: row.entityType,
  entityId: row.entityId,
  beforeJson: row.beforeJson,
  afterJson: row.afterJson,
  approvalRequestId: row.approvalRequestId ?? null,
});

router.get("/audit-logs", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const built = buildListQuery(request.query, {
    search: ["action", "entityType", "entityId", "actor.email"],
    contains: {
      action: "action",
      entityType: "entityType",
      entityId: "entityId",
    },
    in: { role: "role" },
    equals: { actorId: "actorId", approvalRequestId: "approvalRequestId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", action: "action", entityType: "entityType", role: "role" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const store = getConfiguredAuditStore();
  if (store) {
    const params = auditStoreParamsFromRequest(request, built, built.take, built.skip);
    const [page, total] = await Promise.all([
      store.queryAuditLogs(params),
      store.countAuditLogs ? store.countAuditLogs(params) : Promise.resolve(0),
    ]);
    response.json(listResponse("auditLogs", page.items.map(auditStoreRowToApi), total, built));
    return;
  }
  const [rows, total] = await Promise.all([
    client.auditLog.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      include: { actor: { select: { id: true, email: true, role: true } } },
    }),
    client.auditLog.count({ where: built.where as never }),
  ]);
  response.json(listResponse("auditLogs", rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorEmail: row.actor?.email ?? "",
    role: row.role,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    approvalRequestId: row.approvalRequestId,
  })), total, built));
});

router.get("/audit-logs/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const built = buildListQuery(request.query, {
    search: ["action", "entityType", "entityId", "actor.email"],
    contains: {
      action: "action",
      entityType: "entityType",
      entityId: "entityId",
    },
    in: { role: "role" },
    equals: { actorId: "actorId", approvalRequestId: "approvalRequestId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", action: "action", entityType: "entityType", role: "role" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 20,
  });
  const store = getConfiguredAuditStore();
  let rows: ReturnType<typeof auditStoreRowToApi>[] = [];
  let total = 0;
  if (store) {
    const params = auditStoreParamsFromRequest(request, built, 5_000, 0);
    const [page, count] = await Promise.all([
      store.queryAuditLogs(params),
      store.countAuditLogs ? store.countAuditLogs(params) : Promise.resolve(0),
    ]);
    rows = page.items.map(auditStoreRowToApi);
    total = count;
  } else {
    const [legacyRows, legacyTotal] = await Promise.all([
      client.auditLog.findMany({
        where: built.where as never,
        orderBy: built.orderBy as never,
        take: 5_000,
        include: { actor: { select: { email: true } } },
      }),
      client.auditLog.count({ where: built.where as never }),
    ]);
    rows = legacyRows.map((row) => auditStoreRowToApi({
      ...row,
      actorEmail: row.actor?.email ?? "",
    }));
    total = legacyTotal;
  }
  const actor = actorFromRequest(request);
  await client.auditOutbox.create({
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AUDIT_LOGS_EXPORTED",
      entityType: "AUDIT_LOG",
      entityId: "export",
      beforeJson: {},
      afterJson: { total, exported: rows.length, filters: JSON.stringify(request.query ?? {}) },
    },
  });
  response.json({
    auditLogs: rows,
    total,
    exported: rows.length,
    truncated: total > rows.length,
  });
});

const buildAuditLogSummary = async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [total, last24h, actionRows, entityRows, actorRows] = await Promise.all([
    client.auditLog.count(),
    client.auditLog.count({ where: { createdAt: { gte: since } } }),
    client.auditLog.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { _count: { action: "desc" } }, take: 25 }),
    client.auditLog.groupBy({ by: ["entityType"], _count: { _all: true } }),
    client.auditLog.groupBy({ by: ["actorId"], _count: { _all: true } }),
  ]);
  const byAction: Record<string, number> = {};
  for (const row of actionRows) byAction[row.action] = row._count._all;
  const byEntityType: Record<string, number> = {};
  for (const row of entityRows) byEntityType[row.entityType] = row._count._all;
  return {
    summary: {
      total,
      last24h,
      actors: actorRows.length,
      byAction,
      byEntityType,
    },
  };
};

router.get("/audit-logs/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  response.json(await buildAuditLogSummary());
});

router.get("/audit-logs/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  const snapshot = await buildAuditLogSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "ACTIVITY_SCOPE_VERIFIED",
    "ACTION_BREAKDOWN_REVIEWED",
    "ENTITY_BREAKDOWN_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "AUDIT_LOG_SUMMARY_EXPORTED",
      entityType: "AUDIT_LOG",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        total: snapshot.summary.total,
        last24h: snapshot.summary.last24h,
        actors: snapshot.summary.actors,
        checklist,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});

router.get("/audit-logs/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["security:read"]);
  response.setHeader("Cache-Control", "no-store");
  const { id } = parseOrThrow(idSchema, request.params);
  const store = getConfiguredAuditStore();
  if (store) {
    const record = await store.getAuditLogById(id);
    if (!record) {
      throw new ApiError(404, "AUDIT_LOG_NOT_FOUND", "The audit log entry does not exist");
    }
    response.json({ auditLog: auditStoreRowToApi(record) });
    return;
  }
  const row = await client.auditLog.findUnique({
    where: { id },
    include: { actor: { select: { id: true, email: true, role: true } } },
  });
  if (!row) {
    throw new ApiError(404, "AUDIT_LOG_NOT_FOUND", "The audit log entry does not exist");
  }
  response.json({
    auditLog: {
      id: row.id,
      createdAt: row.createdAt,
      actorId: row.actorId,
      actorEmail: row.actor?.email ?? "",
      role: row.role,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeJson: row.beforeJson,
      afterJson: row.afterJson,
      approvalRequestId: row.approvalRequestId,
    },
  });
});

router.get("/settings", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const settings = await client.platformSetting.findMany({ orderBy: [{ key: "asc" }, { version: "desc" }] });
  response.json({ settings });
});

router.post("/settings/restore-preview", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const body = parseOrThrow(z.object({ backup: z.unknown() }).strict(), request.body ?? {});
  const backup = body.backup && typeof body.backup === "object" && !Array.isArray(body.backup)
    ? body.backup as Record<string, unknown>
    : {};
  const source = Array.isArray(backup.settings) ? backup.settings.slice(0, 500) : [];
  if (source.length === 0) {
    throw new ApiError(400, "EMPTY_SETTINGS_BACKUP", "The backup contains no settings");
  }
  const rows = await client.platformSetting.findMany({
    orderBy: [{ key: "asc" }, { scope: "asc" }, { version: "desc" }],
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.scope}:${row.key}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const seen = new Set<string>();
  const entries = source.map((raw, index) => {
    const sourceEntry = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
    if (!sourceEntry) {
      return { index, key: "", scope: "PLATFORM", status: "INVALID" as const, reason: "Entry must be an object" };
    }
    const key = typeof sourceEntry.key === "string" ? sourceEntry.key.trim() : "";
    const scope = typeof sourceEntry.scope === "string" && sourceEntry.scope.trim()
      ? sourceEntry.scope.trim().toUpperCase()
      : "PLATFORM";
    if (!key || key.length > 120) {
      return { index, key, scope, status: "INVALID" as const, reason: "key must be 1-120 characters" };
    }
    const value = sourceEntry.valueJson;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { index, key, scope, status: "INVALID" as const, reason: "valueJson must be an object" };
    }
    if (sourceEntry.effectiveFrom !== undefined && typeof sourceEntry.effectiveFrom !== "string") {
      return { index, key, scope, status: "INVALID" as const, reason: "effectiveFrom must be a string" };
    }
    if (typeof sourceEntry.effectiveFrom === "string" && Number.isNaN(new Date(sourceEntry.effectiveFrom).getTime())) {
      return { index, key, scope, status: "INVALID" as const, reason: "effectiveFrom is not a valid date" };
    }
    const mapKey = `${scope}:${key}`;
    seen.add(mapKey);
    const current = latest.get(mapKey);
    const unchanged = current ? JSON.stringify(current.valueJson) === JSON.stringify(value) : false;
    return {
      index,
      key,
      scope,
      status: current ? (unchanged ? "UNCHANGED" as const : "CHANGED" as const) : "ADDED" as const,
      currentVersion: current?.version ?? null,
      nextVersion: (current?.version ?? 0) + 1,
      currentValue: current?.valueJson ?? null,
      backupValue: value,
      effectiveFrom: typeof sourceEntry.effectiveFrom === "string" ? sourceEntry.effectiveFrom : null,
    };
  });
  const summary = {
    backupKeys: source.length,
    added: entries.filter((entry) => entry.status === "ADDED").length,
    changed: entries.filter((entry) => entry.status === "CHANGED").length,
    unchanged: entries.filter((entry) => entry.status === "UNCHANGED").length,
    invalid: entries.filter((entry) => entry.status === "INVALID").length,
    missingInBackup: [...latest.keys()].filter((key) => !seen.has(key)).length,
  };
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "PLATFORM_SETTINGS_RESTORE_PREVIEWED",
      entityType: "PLATFORM_SETTING",
      entityId: "restore-preview",
      beforeJson: {},
      afterJson: summary,
    },
  });
  response.json({ summary, entries, missingInBackup: [...latest.keys()].filter((key) => !seen.has(key)) });
});

router.post("/settings/restore-apply", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:write"]);
  const body = parseOrThrow(
    z
      .object({
        confirm: z.literal(true),
        reason: z.string().min(3).max(500),
        checklist: z.array(z.enum([
          "BACKUP_REVIEWED",
          "INVALID_ENTRIES_CLEARED",
          "VERSION_CONFLICTS_REVIEWED",
          "RESTORE_SCOPE_CONFIRMED",
        ])).max(10).optional(),
        backup: z
          .object({
            settings: z
              .array(
                z
                  .object({
                    key: z.string().min(1).max(120),
                    scope: z.string().max(40).default("PLATFORM"),
                    valueJson: z.record(z.string().max(64), z.unknown()),
                    expectedCurrentVersion: z.number().int().min(0),
                    effectiveFrom: z.string().max(64).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      })
      .strict(),
    request.body ?? {},
  );
  const actor = actorFromRequest(request);
  const applied = await client.$transaction(async (tx) => {
    const written: Array<{ key: string; scope: string; version: number }> = [];
    for (const entry of body.backup.settings) {
      const key = entry.key.trim();
      const scope = entry.scope.trim().toUpperCase() || "PLATFORM";
      const current = await tx.platformSetting.findFirst({
        where: { key, scope },
        orderBy: { version: "desc" },
      });
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== entry.expectedCurrentVersion) {
        throw new ApiError(
          409,
          "SETTING_VERSION_CONFLICT",
          `The setting '${key}' changed after the preview was generated`,
          { key, scope, expectedVersion: entry.expectedCurrentVersion, actualVersion },
        );
      }
      const effectiveFrom = entry.effectiveFrom ? new Date(entry.effectiveFrom) : new Date();
      if (Number.isNaN(effectiveFrom.getTime())) {
        throw new ApiError(400, "INVALID_EFFECTIVE_FROM", `The setting '${key}' has an invalid effective date`, {
          key,
          scope,
        });
      }
      const created = await tx.platformSetting.create({
        data: {
          key,
          scope,
          version: actualVersion + 1,
          valueJson: json(entry.valueJson),
          effectiveFrom,
        },
      });
      written.push({ key, scope, version: created.version });
    }
    await writeAudit(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role ?? "UNKNOWN",
        action: "PLATFORM_SETTINGS_RESTORED",
        entityType: "PLATFORM_SETTING",
        entityId: "restore",
        beforeJson: {},
        afterJson: { reason: body.reason, settings: written, checklist: body.checklist ?? [] },
      },
    });
    return written;
  });
  response.json({ applied: applied.length, settings: applied });
});

router.get("/settings/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const rows = await client.platformSetting.findMany({
    orderBy: [{ key: "asc" }, { scope: "asc" }, { version: "desc" }],
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.scope}:${row.key}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const exportedAt = new Date().toISOString();
  const actor = actorFromRequest(request);
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "PLATFORM_SETTINGS_EXPORTED",
      entityType: "PLATFORM_SETTING",
      entityId: "export",
      beforeJson: {},
      afterJson: { keys: latest.size, versions: rows.length, exportedAt },
    },
  });
  response.json({
    exportedAt,
    keys: latest.size,
    versions: rows.length,
    settings: [...latest.values()].map((row) => ({
      key: row.key,
      scope: row.scope,
      version: row.version,
      valueJson: row.valueJson,
      effectiveFrom: row.effectiveFrom,
      updatedAt: row.updatedAt,
    })),
  });
});

const buildPlatformSettingsSummary = async () => {
  const rows = await client.platformSetting.findMany({
    select: { key: true, scope: true, version: true, effectiveFrom: true, updatedAt: true },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  const now = new Date();
  const latest = new Map<string, (typeof rows)[number]>();
  const scopes: Record<string, number> = {};
  for (const row of rows) {
    scopes[row.scope] = (scopes[row.scope] ?? 0) + 1;
    if (!latest.has(row.key)) latest.set(row.key, row);
  }
  const current = [...latest.values()];
  return {
    summary: {
      keys: current.length,
      versions: rows.length,
      scopes,
      futureEffective: current.filter((row) => row.effectiveFrom.getTime() > now.getTime()).length,
      updatedLast24h: current.filter((row) => now.getTime() - row.updatedAt.getTime() <= 24 * 60 * 60 * 1000).length,
    },
  };
};

router.get("/settings/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  response.json(await buildPlatformSettingsSummary());
});

router.get("/settings/summary/export", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const snapshot = await buildPlatformSettingsSummary();
  const actor = actorFromRequest(request);
  const allowedChecklist = new Set([
    "SETTINGS_SCOPE_VERIFIED",
    "VERSIONS_REVIEWED",
    "EFFECTIVE_DATES_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
  ]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role ?? "UNKNOWN",
      action: "PLATFORM_SETTINGS_SUMMARY_EXPORTED",
      entityType: "PLATFORM_SETTING",
      entityId: "summary",
      beforeJson: {},
      afterJson: {
        keys: snapshot.summary.keys,
        versions: snapshot.summary.versions,
        futureEffective: snapshot.summary.futureEffective,
        updatedLast24h: snapshot.summary.updatedLast24h,
        checklist,
      },
    },
  });
  response.json({ ...snapshot, exportedAt: new Date().toISOString() });
});


router.put("/settings", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:write"]);
  const body = parseOrThrow(
    z
      .object({
        settings: z
          .array(
            z
              .object({
                key: z.string().min(1).max(120),
                valueJson: z.record(z.string().max(64), z.unknown()),
                effectiveFrom: z.string().max(64).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(50),
        checklist: z.array(z.enum([
          "KEY_SCOPE_VERIFIED",
          "VALUE_SCHEMA_REVIEWED",
          "EFFECTIVE_DATE_REVIEWED",
          "IMMUTABLE_VERSION_ACKNOWLEDGED",
        ])).max(10).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const written = [];
  for (const setting of body.settings) {
    const latest = await client.platformSetting.findFirst({
      where: { key: setting.key },
      orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;
    const created = await client.platformSetting.create({
      data: {
        key: setting.key,
        scope: "PLATFORM",
        valueJson: json(setting.valueJson),
        version,
        effectiveFrom: setting.effectiveFrom ? new Date(setting.effectiveFrom) : new Date(),
      },
    });
    written.push({ key: created.key, version: created.version });
  }
  await writeAudit(client, {
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "PLATFORM_SETTINGS_UPDATED",
      entityType: "PLATFORM_SETTING",
      entityId: written[0]?.key ?? "settings",
      beforeJson: {},
      afterJson: { settings: written, checklist: body.checklist ?? [] },
    },
  });
  response.json({ settings: written });
});

export const adminInternalRouter = router;
export { LedgerPoster };
