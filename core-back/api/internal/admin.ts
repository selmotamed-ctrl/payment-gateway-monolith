import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma, type ContentType } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { invalidationBus } from "../../lib/invalidationBus";
import { createReconciliationUploadHandler } from "./reconciliationUpload";
import { getPlatformRuntime } from "../../engine/runtime";
import { InvariantVerifier, naturalBalance } from "../../engine/ledger/InvariantVerifier";
import { moneyToString } from "../../engine/db/money";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, listResponse } from "../../lib/listQuery";
import {
  generateMfaCode,
  hashMfaCode,
  hashPassword,
  signMfaChallenge,
  signSession,
  verifyMfaChallengeToken,
  verifyPassword,
} from "../../lib/auth";
import { buildAdminUserInfo } from "../../lib/auth/uiAuthorities";
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
import { requireAuthentication, requireAuthorities, principalOf } from "../middleware/authDoubleCheck";
import { actorFromRequest, assertCheckerAuthority, assertCheckerIsNotMaker, SYSTEM_AUTOMATION_PRINCIPAL } from "../middleware/makerCheckerGuard";

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


const CONFIDENTIAL_ROLES = ["COMPLIANCE", "MLRO"];
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
  const role = principal.role ?? "";
  if (CONFIDENTIAL_ROLES.includes(role)) {
    return true;
  }
  return principal.authorities.includes("aml:read") || principal.authorities.includes("aml:write");
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
  },
  actor: { userId: string; role: string | null },
): Promise<{ reportId: string; approvalRequestId: string; status: string }> => {
  const payloadJson = JSON.stringify(input.payload);
  const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
  return db.$transaction(async (tx) => {
    const report = await tx.regulatoryReport.create({
      data: {
        reportType: input.reportType,
        authority: input.authority,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        amlCaseId: input.amlCaseId ?? null,
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
    await tx.auditLog.create({
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
    await tx.auditLog.create({
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
    await tx.auditLog.create({
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
    await tx.auditLog.create({
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
  const user = await client.user.findFirst({
    where: {
      OR: [
        { email: identifier },
        { phone: identifier },
        { identities: { some: { identifierNormalized: identifier } } },
      ],
    },
  });
  if (!user || !user.passwordHash) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "The supplied credentials are not valid");
  }
  if (!await verifyPassword(body.password, user.passwordHash)) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "The supplied credentials are not valid");
  }
  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "The account is not active");
  }
  if (user.mfaRequired) {
    const code = generateMfaCode();
    const challengeId = signMfaChallenge({
      userId: user.id,
      code,
      role: user.role,
      merchantId: user.merchantId,
    });
    await client.notification.create({
      data: {
        eventId: randomBytes(16).toString("hex"),
        recipientUserId: user.id,
        templateCode: "LOGIN_MFA",
        channel: "SMS",
        lang: "EN",
        payloadJson: json({ code }),
        addressCiphertext: "",
        status: "QUEUED",
        addressMasked: (user.phone ?? "").slice(-4),
      },
    });
    response.json({ mfaRequired: true, challengeId });
    return;
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
      mfa: false,
    }),
    expiresInSeconds: 12 * 60 * 60,
    userInfo: buildAdminUserInfo(user, authorities),
  });
});

router.post("/auth/mfa", async (request: Request, response: Response) => {
  const body = parseOrThrow(
    z.object({ code: z.string().regex(/^\d{6}$/), challengeId: z.string().min(4).max(4096) }).strict(),
    request.body,
  );
  let claims;
  try {
    claims = verifyMfaChallengeToken(body.challengeId);
  } catch {
    throw new ApiError(401, "MFA_CHALLENGE_INVALID", "The MFA challenge is invalid or expired");
  }
  if (hashMfaCode(claims.sub, body.code) !== claims.codeHash) {
    throw new ApiError(401, "MFA_CODE_INVALID", "The supplied MFA code is not valid");
  }
  const user = await client.user.findUnique({ where: { id: claims.sub } });
  if (!user || user.status !== "ACTIVE") {
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
    }),
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

router.get("/stats/overview", async (_request: Request, response: Response) => {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    merchantsActive,
    merchantsPending,
    attemptsByStateRows,
    unknownAggregate,
    approvalGroups,
    joinRequestSlaBreaches,
    amlSlaBreaches,
  ] = await Promise.all([
    client.merchant.count({ where: { status: "ACTIVE" } }),
    client.merchant.count({ where: { status: "PENDING" } }),
    client.paymentAttempt.groupBy({ by: ["status"], _count: { _all: true } }),
    client.paymentAttempt.aggregate({
      where: { status: "UNKNOWN" },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    client.approvalRequest.groupBy({
      by: ["state"],
      where: { state: "PENDING_REVIEW" },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    client.joinRequest.count({
      where: {
        status: { in: ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"] },
        createdAt: { lt: staleCutoff },
      },
    }),
    client.amlCase.count({
      where: { status: { in: ["OPEN", "IN_REVIEW"] }, createdAt: { lt: staleCutoff } },
    }),
  ]);

  const attemptsByState: Record<string, number> = {};
  for (const row of attemptsByStateRows) {
    attemptsByState[String(row.status)] = (row._count as { _all: number })._all;
  }

  const unknownOldest = unknownAggregate._min.createdAt;
  const approvalQueueAgeing = approvalGroups.map((group) => ({
    role: String(group.state),
    oldestHours: group._min.createdAt
      ? Math.max(0, Math.round((now.getTime() - group._min.createdAt.getTime()) / 3_600_000))
      : 0,
    count: (group._count as { _all: number })._all,
  }));

  response.json({
    attemptsByState,
    unknownBacklog: (unknownAggregate._count as { _all: number })._all,
    unknownOldestAgeSeconds: unknownOldest
      ? Math.max(0, Math.round((now.getTime() - unknownOldest.getTime()) / 1000))
      : 0,
    openCircuitBreakers: 0,
    webhookInboxLagSeconds: 0,
    reconciliationMatchRate: "0",
    approvalQueueAgeing,
    joinRequestSlaBreaches,
    amlSlaBreaches,
    merchantsActive,
    merchantsPending,
  });
});

const OPTION_LIMIT = 100;

router.get("/options/:kind", async (request: Request, response: Response) => {
  const kind = String(request.params.kind ?? "");
  const rawSearch = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const limit = Math.min(OPTION_LIMIT, Math.max(1, Number(request.query.limit ?? 50) || 50));
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
        orderBy: [{ accountType: "asc" }, { currency: "asc" }],
        take: limit,
        select: { id: true, accountType: true, currency: true },
      });
      items = rows.map((row) => ({ value: row.id, title: `${row.accountType} · ${row.currency}`, subtitle: row.id.slice(0, 8) }));
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
  })), total, built));
});

router.get("/users/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const user = await client.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  response.json({ user });
});

router.post("/users", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:write", "security:write"]);
  const body = parseOrThrow(
    z
      .object({
        email: z.string().email(),
        phone: z.string().min(6).max(20).optional(),
        password: z.string().min(10).max(128).optional(),
        role: z.enum([
          "GATEWAY_ADMIN",
          "SECURITY_ADMIN",
          "FINANCE",
          "OPERATOR",
          "COMPLIANCE",
          "MLRO",
          "SUPPORT",
        ]),
        authoritiesMap: z.array(z.string().min(2).max(64)).max(60).default([]),
        isMaker: z.boolean().default(false),
        isChecker: z.boolean().default(false),
      })
      .strict(),
    request.body,
  );
  const user = await client.user.create({
    data: {
      email: body.email.trim().toLowerCase(),
      phone: body.phone ?? null,
      passwordHash: body.password ? await hashPassword(body.password) : null,
      role: body.role,
      authoritiesMap: body.authoritiesMap,
      isMaker: body.isMaker,
      isChecker: body.isChecker,
      mfaRequired: true,
      status: "INVITED",
    },
  });
  response.status(201).json({ id: user.id, email: user.email, role: user.role, status: user.status });
});

router.patch("/users", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:write", "security:write"]);
  const body = parseOrThrow(
    z
      .object({
        id: z.string().min(1).max(64),
        authoritiesMap: z.array(z.string().min(2).max(64)).max(60).optional(),
        role: z.string().max(40).optional(),
        status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
        isMaker: z.boolean().optional(),
        isChecker: z.boolean().optional(),
      })
      .strict(),
    request.body,
  );
  const user = await client.user.findUnique({ where: { id: body.id } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  const actor = actorFromRequest(request);
  if (body.authoritiesMap || body.role) {
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
  response.json({ id: updated.id, role: updated.role, status: updated.status });
});

router.patch("/users/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:write", "security:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        authoritiesMap: z.array(z.string().min(2).max(64)).max(60).optional(),
        role: z.string().max(40).optional(),
        status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
      })
      .strict(),
    request.body,
  );
  const user = await client.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  const updated = await client.user.update({
    where: { id: user.id },
    data: { authoritiesMap: body.authoritiesMap, role: body.role as never, status: body.status },
  });
  response.json({ id: updated.id, role: updated.role, status: updated.status });
});

router.get("/join-requests", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const built = buildListQuery(request.query, {
    search: ["merchant.legalName", "merchant.tradeName"],
    in: { status: "status" }, equals: {proposedRiskTier: "proposedRiskTier", onboardingChannel: "onboardingChannel", assignedReviewerId: "assignedReviewerId"},
    dates: { createdAt: { path: "createdAt" }, slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { status: "status", submittedAt: "createdAt", slaDueAt: "slaDueAt", riskTier: "proposedRiskTier" },
    defaultSort: { createdAt: "desc" },
  });
  const [joinRequests, total] = await Promise.all([
    client.joinRequest.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { merchant: true, kybDocuments: true, assignedReviewer: { select: { email: true } } }, skip: built.skip, take: built.take }),
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

router.get("/join-requests/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:read", "compliance:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const joinRequest = await client.joinRequest.findUnique({
    where: { id },
    include: { merchant: true, kybDocuments: true },
  });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "The join request does not exist");
  }
  response.json({ joinRequest });
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
  const updated = await client.joinRequest.update({
    where: { id },
    data: { status: "INFO_REQUESTED", infoRequestJson: body.items },
  });
  response.json({ id: updated.id, status: updated.status });
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
  if (!["IN_REVIEW", "INFO_REQUESTED", "SUBMITTED", "PENDING_CHECKER"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_DECIDABLE", "The join request is not in a decidable state");
  }
  if (body.decision === "APPROVED") {
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
  const fourEyesRequired = joinRequest.fourEyesRequired;
  if (fourEyesRequired && body.decision === "APPROVED") {
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "JOIN_REQUEST",
        subjectId: joinRequest.id,
        payloadDiffJson: body,
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await client.joinRequest.update({ where: { id }, data: { status: "PENDING_CHECKER", approvalRequestId: approval.id } });
    response.status(202).json({ status: "PENDING_CHECKER", approvalRequestId: approval.id });
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
  const updated = await client.joinRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      decision: "REJECTED",
      decisionReasonCode: body.reasonCode,
      decisionNotes: body.notes,
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.post("/kyb-documents/:id/review", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "compliance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        decision: z.enum(["ACCEPTED", "REJECTED"]),
        reasonCode: z.string().max(64).optional(),
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const document = await client.kybDocument.findUnique({ where: { id } });
  if (!document) {
    throw new ApiError(404, "KIB_DOCUMENT_NOT_FOUND", "The KYB document does not exist");
  }
  if (document.avStatus !== "CLEAN") {
    throw new ApiError(409, "KIB_DOCUMENT_NOT_SCANNED", "The KYB document has not passed malware scanning");
  }
  const updated = await client.kybDocument.update({
    where: { id },
    data: {
      status: body.decision,
      reviewedById: actor.userId,
      reviewedAt: new Date(),
      rejectionReasonCode: body.reasonCode,
      expiresOn: body.expiresOn ? new Date(body.expiresOn) : null,
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/merchants", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const built = buildListQuery(request.query, {
    search: ["legalName", "tradeName", "email", "phone"],
    in: { status: "status" }, equals: {kybStatus: "kybStatus", riskTier: "riskTier"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { legalName: "legalName", tradeName: "tradeName", status: "status", riskTier: "riskTier", kybStatus: "kybStatus", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [merchants, total] = await Promise.all([
    client.merchant.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.merchant.count({ where: built.where as never }),
  ]);
  response.json(listResponse("merchants", merchants, total, built));
});

router.get("/merchants/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({
    where: { id },
    include: { wallets: true, applications: true },
  });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  response.json({ merchant });
});

router.post("/merchants/:id/suspend", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ reasonCode: z.string().min(2).max(64), notes: z.string().max(2000).optional() }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  const updated = await client.merchant.update({
    where: { id },
    data: {
      status: "SUSPENDED",
      suspendedAt: new Date(),
      suspensionReasonCode: body.reasonCode,
    },
  });
  await client.auditLog.create({
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "MERCHANT_SUSPENDED",
      entityType: "MERCHANT",
      entityId: id,
      beforeJson: { status: merchant.status },
      afterJson: { status: updated.status, reasonCode: body.reasonCode },
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.post("/merchants/:id/reinstate", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  const updated = await client.merchant.update({
    where: { id },
    data: { status: "ACTIVE", suspendedAt: null, suspensionReasonCode: null },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.post("/merchants/:id/propose-edit", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ patch: z.array(z.record(z.string().max(64), z.unknown())).min(1) }).strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const merchant = await client.merchant.findUnique({ where: { id } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "MERCHANT",
      subjectId: merchant.id,
      payloadDiffJson: json(body.patch),
      mode: "STANDARD",
      makerUserId: actor.userId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
});

router.get("/merchants/:id/detail-changes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const logs = await client.detailChangeLog.findMany({
    where: { merchantId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  response.json({ detailChanges: logs });
});

router.get("/approvals", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  const built = buildListQuery(request.query, {
    search: ["subjectId"],
    in: { state: "state" }, equals: {subjectType: "subjectType", domain: "domain", makerUserId: "makerUserId", checkerUserId: "checkerUserId"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { state: "state", subjectType: "subjectType", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [approvals, total] = await Promise.all([
    client.approvalRequest.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { maker: { select: { email: true } }, checker: { select: { email: true } } }, skip: built.skip, take: built.take }),
    client.approvalRequest.count({ where: built.where as never }),
  ]);
  response.json(listResponse("approvals", approvals.map((approval) => ({
    ...approval,
    makerName: approval.maker?.email ?? "",
    checkerName: approval.checker?.email ?? "",
  })), total, built));
});

router.get("/approvals/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval) {
    throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The approval request does not exist");
  }
  response.json({ approval });
});

router.post("/approvals/:id/approve", async (request: Request, response: Response) => {
  requireAuthorities(request, ["approval:check", "approval:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        notes: z.string().max(2000).optional(),
        riskAcceptanceNote: z.string().max(2000).optional(),
        outcome: z.enum(["WON", "LOST"]).optional(),
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
  assertCheckerIsNotMaker(approval.makerUserId, actor.userId);
  if (approval.state !== "PENDING_REVIEW" && approval.state !== "DRAFT") {
    throw new ApiError(409, "APPROVAL_NOT_PENDING", "The approval request is not pending review");
  }
  const platform = getPlatformRuntime(client as never);
  if (approval.subjectType === "ADJUSTMENT") {
    // The execution of an adjustment moves the money, so it is a background
    // job: the request records the checker and queues the execution. The job
    // never invents a checker, it executes with the one that is recorded on
    // the approval request.
    const { updated, job } = await client.$transaction(async (tx) => {
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
    const result = await executeApprovalSubject(governanceContext(platform), tx as never, {
      approval: {
        id: approval.id,
        subjectType: approval.subjectType,
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
  if (approval.subjectType === "GATEWAY_VERSION") {
    // The state change committed with the go-live gate decision; only the
    // outbound cache is invalidated after the commit.
    const version = await client.gatewayVersion.findUnique({ where: { id: approval.subjectId } });
    if (version) {
      await invalidationBus.invalidateGateway(version.gatewayId, "gateway-version-live");
    }
  }
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
  const body = parseOrThrow(z.object({ reason: z.string().min(2).max(2000) }).strict(), request.body);
  const actor = actorFromRequest(request);
  assertCheckerAuthority(actor);
  const approval = await client.approvalRequest.findUnique({ where: { id } });
  if (!approval) {
    throw new ApiError(404, "APPROVAL_REQUEST_NOT_FOUND", "The approval request does not exist");
  }
  assertCheckerIsNotMaker(approval.makerUserId, actor.userId);
  const updated = await client.approvalRequest.update({
    where: { id },
    data: { checkerUserId: actor.userId, state: "REJECTED", rejectionReason: body.reason },
  });
  response.json({ id: updated.id, state: updated.state });
});

router.get("/aml/screenings", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["subjectId", "providerCode"],
    in: { result: "result" }, equals: {subjectType: "subjectType", providerCode: "providerCode"},
    ranges: { score: { path: "highestScore", kind: "decimal" } },
    dates: { createdAt: { path: "requestedAt" } },
    sortable: { result: "result", requestedAt: "requestedAt", score: "highestScore" },
    defaultSort: { requestedAt: "desc" },
  });
  const [screenings, total] = await Promise.all([
    client.amlScreening.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { matches: true }, skip: built.skip, take: built.take }),
    client.amlScreening.count({ where: built.where as never }),
  ]);
  response.json(listResponse("screenings", screenings.map((screening) => ({
    ...screening,
    provider: screening.providerCode,
    score: screening.highestScore,
    screenedAt: screening.requestedAt,
  })), total, built));
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
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const match = await client.amlScreeningMatch.findUnique({ where: { id } });
  if (!match) {
    throw new ApiError(404, "SCREENING_MATCH_NOT_FOUND", "The screening match does not exist");
  }
  const updated = await client.amlScreeningMatch.update({
    where: { id },
    data: {
      disposition: body.disposition,
      dispositionById: actor.userId,
      dispositionNotes: body.notes,
      suppressFuture: body.suppressFuture,
      suppressUntil: body.suppressUntil ? new Date(body.suppressUntil) : null,
    },
  });
  response.json({ id: updated.id, disposition: updated.disposition });
});

router.get("/aml/cases", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["caseRef"],
    in: { status: "status" }, equals: {severity: "severity", subjectType: "subjectType", ruleCode: "rule.code"},
    dates: { createdAt: { path: "createdAt" }, slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { caseRef: "caseRef", status: "status", severity: "severity", openedAt: "createdAt", slaDueAt: "slaDueAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [cases, total] = await Promise.all([
    client.amlCase.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.amlCase.count({ where: built.where as never }),
  ]);
  response.json(listResponse("cases", cases.map((entry) => ({ ...entry, openedAt: entry.createdAt })), total, built));
});

router.post("/aml/cases/:id/propose", async (request: Request, response: Response) => {
  assertConfidential(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ action: z.enum(["HOLD", "RELEASE", "REJECT", "ESCALATE"]), notes: z.string().max(2000).optional() }).strict(),
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
  response.json(listResponse("rules", rules, total, built));
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
      })
      .strict(),
    request.body,
  );
  const rule = await client.amlRule.create({
    data: {
      code: body.code,
      name: body.name,
      ruleType: body.ruleType,
      scope: json(body.scope),
      params: json(body.params),
      action: body.action,
      baseSeverity: body.baseSeverity,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
    },
  });
  response.status(201).json({ id: rule.id, code: rule.code, version: rule.version });
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

router.get("/aml/reports", async (request: Request, response: Response) => {
  assertConfidential(request);
  const built = buildListQuery(request.query, {
    search: ["subjectId", "submissionRef"],
    in: { status: "status" }, equals: {reportType: "reportType", authority: "authority",},
    dates: { createdAt: { path: "createdAt" }, submittedAt: { path: "submittedAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { reportType: "reportType", authority: "authority", status: "status", createdAt: "createdAt", submittedAt: "submittedAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [reports, total] = await Promise.all([
    client.regulatoryReport.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.regulatoryReport.count({ where: built.where as never }),
  ]);
  response.json(listResponse("reports", reports.map((report) => ({
    id: report.id,
    reportType: report.reportType,
    authority: report.authority,
    status: report.status,
    confidential: report.confidential,
    submissionRef: report.submissionRef,
    submittedAt: report.submittedAt,
    approvalRequestId: report.approvalRequestId,
  })), total, built));
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
  response.json(report);
});

router.get("/operator-cases", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const built = buildListQuery(request.query, {
    search: ["attempt.reference"],
    in: { state: "state" }, equals: {kind: "kind", priority: "priority", assigneeUserId: "assigneeUserId"},
    dates: { createdAt: { path: "createdAt" }, slaDueAt: { path: "slaDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { priority: "priority", state: "state", openedAt: "createdAt", slaDueAt: "slaDueAt" },
    defaultSort: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  const [cases, total] = await Promise.all([
    client.operatorCase.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { attempt: { select: { reference: true, totalChargedAmount: true, merchant: { select: { tradeName: true } }, rail: { select: { code: true } } } } }, skip: built.skip, take: built.take }),
    client.operatorCase.count({ where: built.where as never }),
  ]);
  response.json(listResponse("cases", cases.map((entry) => ({
    ...entry,
    caseRef: entry.attempt?.reference ?? entry.id,
    caseType: entry.kind,
    openedAt: entry.createdAt,
    merchantName: entry.attempt?.merchant?.tradeName ?? "",
    railCode: entry.attempt?.rail?.code ?? "",
    amount: entry.attempt?.totalChargedAmount ?? null,
  })), total, built));
});

router.get("/operator-cases/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const operatorCase = await client.operatorCase.findUnique({ where: { id } });
  if (!operatorCase) {
    throw new ApiError(404, "OPERATOR_CASE_NOT_FOUND", "The operator case does not exist");
  }
  response.json({ operatorCase });
});

router.post("/operator-cases/:id/resolve", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:write", "operator:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ resolution: z.string().min(2).max(4000), state: z.enum(["RESOLVED", "IN_PROGRESS"]).default("RESOLVED") }).strict(),
    request.body,
  );
  const operatorCase = await client.operatorCase.findUnique({ where: { id } });
  if (!operatorCase) {
    throw new ApiError(404, "OPERATOR_CASE_NOT_FOUND", "The operator case does not exist");
  }
  const updated = await client.operatorCase.update({
    where: { id },
    data: { state: body.state, resolutionNotes: body.resolution },
  });
  response.json({ id: updated.id, state: updated.state });
});

router.get("/attempts/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const attempt = await client.paymentAttempt.findUnique({ where: { id } });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  }
  response.json({ attempt });
});

router.post("/attempts/:id/inquire", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:inquire"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const attempt = await client.paymentAttempt.findUnique({ where: { id } });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  }
  const updated = await client.paymentAttempt.update({
    where: { id },
    data: { status: "VERIFYING", nextCheckAt: new Date(Date.now() + 1000) },
  });
  response.json({ id: updated.id, status: updated.status, inquiryScheduled: true });
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
    client.gateway.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.gateway.count({ where: built.where as never }),
  ]);
  response.json(listResponse("gateways", gateways, total, built));
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
        name: z.string().min(2).max(160).optional(),
        operator: z.string().min(2).max(160).optional(),
        aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
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
      name: body.name,
      operator: body.operator,
      aliases: body.aliases,
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
  const body = parseOrThrow(z.object({ versionId: z.string().min(1).max(64) }).strict(), request.body);
  const actor = actorFromRequest(request);
  const gateway = await client.$transaction(async (tx) =>
    rollbackGatewayVersionInTransaction(tx as never, id, body.versionId, actor.userId)
  );
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
  await client.auditLog.create({
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
      })
      .strict(),
    request.body ?? {},
  );
  const flows = await client.flow.findMany({
    where: { gatewayVersionId: vid },
    include: { steps: { orderBy: { orderIndex: "asc" } } },
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
    z.object({ scenarios: z.array(z.string().max(64)).max(30).optional() }).strict(),
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
  const version = await loadVersion(vid);
  const actor = actorFromRequest(request);
  const approval = await client.approvalRequest.create({
    data: {
      subjectType: "GATEWAY_VERSION",
      subjectId: version.id,
      payloadDiffJson: { gatewayVersionId: version.id },
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
    client.rail.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { fields: true }, skip: built.skip, take: built.take }),
    client.rail.count({ where: built.where as never }),
  ]);
  response.json(listResponse("rails", rails, total, built));
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
      })
      .strict(),
    request.body,
  );
  const rail = await client.rail.findUnique({ where: { id } });
  if (!rail) {
    throw new ApiError(404, "RAIL_NOT_FOUND", "The rail does not exist");
  }
  const updated = await client.rail.update({
    where: { id },
    data: {
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
  response.json({ id: updated.id, blocked: updated.blocked });
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
    client.railRoute.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { rail: true, gateway: true }, skip: built.skip, take: built.take }),
    client.railRoute.count({ where: built.where as never }),
  ]);
  response.json(listResponse("routes", routes.map((route) => ({ ...route, railCode: route.rail?.code ?? "", gatewayCode: route.gateway?.code ?? "" })), total, built));
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
      })
      .strict(),
    request.body,
  );
  const route = await client.railRoute.findUnique({ where: { id } });
  if (!route) {
    throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
  }
  const updated = await client.railRoute.update({
    where: { id },
    data: {
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
    z.object({ status: z.enum(["ACTIVE", "PAUSED", "DRAINING"]), reason: z.string().max(500).optional() }).strict(),
    request.body,
  );
  const route = await client.railRoute.findUnique({ where: { id } });
  if (!route) {
    throw new ApiError(404, "ROUTE_NOT_FOUND", "The route does not exist");
  }
  const updated = await client.railRoute.update({ where: { id }, data: { status: body.status } });
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

router.get("/reconciliation/sources", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const built = buildListQuery(request.query, {
    search: ["gateway.code"],
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "gatewayId", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [sources, total] = await Promise.all([
    client.statementSource.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { gateway: true }, skip: built.skip, take: built.take }),
    client.statementSource.count({ where: built.where as never }),
  ]);
  response.json(listResponse("sources", sources, total, built));
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

router.get("/reconciliation/runs", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:read"]);
  const built = buildListQuery(request.query, {
    search: ["fileName"],
    equals: { statementSourceId: "statementSourceId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { fileName: "fileName", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [runs, total] = await Promise.all([
    client.reconciliationRun.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { items: true }, skip: built.skip, take: built.take }),
    client.reconciliationRun.count({ where: built.where as never }),
  ]);
  response.json(listResponse("runs", runs, total, built));
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

router.get("/disputes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const built = buildListQuery(request.query, {
    search: ["disputeRef", "externalDisputeRef", "reasonCode"],
    in: { status: "status" }, equals: {railId: "railId", gatewayId: "gatewayId"},
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "openedAt" }, evidenceDueAt: { path: "evidenceDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { disputeRef: "disputeRef", status: "status", amount: "amount", openedAt: "openedAt", evidenceDueAt: "evidenceDueAt" },
    defaultSort: { openedAt: "desc" },
  });
  const [disputes, total] = await Promise.all([
    client.dispute.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { attempt: { select: { merchant: { select: { tradeName: true } }, rail: { select: { code: true } } } } }, skip: built.skip, take: built.take }),
    client.dispute.count({ where: built.where as never }),
  ]);
  response.json(listResponse("disputes", disputes.map((dispute) => ({
    ...dispute,
    state: dispute.status,
    merchantName: dispute.attempt?.merchant?.tradeName ?? "",
    railCode: dispute.attempt?.rail?.code ?? "",
  })), total, built));
});

router.get("/disputes/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const dispute = await client.dispute.findUnique({ where: { id } });
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  }
  response.json({ dispute });
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

router.get("/adjustments", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const built = buildListQuery(request.query, {
    search: ["reason", "externalDisputeRef"],
    in: { state: "state" }, equals: {type: "type",},
    booleans: { draftedBySystem: "draftedBySystem" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { type: "type", state: "state", amount: "amount", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [adjustments, total] = await Promise.all([
    client.adjustment.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { sourceAttempt: { select: { merchant: { select: { tradeName: true } } } } }, skip: built.skip, take: built.take }),
    client.adjustment.count({ where: built.where as never }),
  ]);
  response.json(listResponse("adjustments", adjustments.map((adjustment) => ({
    ...adjustment,
    merchantName: adjustment.sourceAttempt?.merchant?.tradeName ?? "",
  })), total, built));
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

router.get("/cashouts", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:read"]);
  const built = buildListQuery(request.query, {
    search: ["merchant.tradeName", "walletId"],
    in: { state: "state" }, equals: {merchantId: "merchantId", walletId: "walletId"},
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { merchantName: "merchantId", state: "state", amount: "amount", requestedAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [cashouts, total] = await Promise.all([
    client.cashoutRequest.findMany({ where: built.where as never, orderBy: built.orderBy as never, include: { merchant: { select: { tradeName: true } } }, skip: built.skip, take: built.take }),
    client.cashoutRequest.count({ where: built.where as never }),
  ]);
  response.json(listResponse("cashouts", cashouts.map((cashout) => ({
    ...cashout,
    merchantName: cashout.merchant?.tradeName ?? "",
    requestedAt: cashout.createdAt,
  })), total, built));
});

router.post("/cashouts/:id/process", async (request: Request, response: Response) => {
  requireAuthorities(request, ["cashout:review", "finance:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ decision: z.enum(["APPROVE", "REJECT"]), reason: z.string().max(1000).optional() }).strict(),
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
  const profiles = await client.commissionProfile.findMany({ orderBy: { railCode: "asc" } });
  response.json({ profiles });
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
        tiersJson: z.record(z.string().max(64), z.unknown()).optional(),
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
  response.status(201).json({ id: profile.id, version: profile.version });
});

router.get("/velocity-rules", async (request: Request, response: Response) => {
  requireAuthorities(request, ["velocity:read", "compliance:read"]);
  const rules = await client.velocityRule.findMany({ orderBy: { createdAt: "desc" } });
  response.json({ rules });
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
  const accounts = await client.glAccount.findMany();
  const balances = new Map<string, Decimal>();
  for (const account of accounts) {
    const lines = await client.journalLine.findMany({
      where: account.checkpointAt
        ? { glAccountId: account.id, createdAt: { gt: account.checkpointAt } }
        : { glAccountId: account.id },
      select: { direction: true, amount: true },
    });
    let balance = decimal(account.checkpointBalance ?? 0);
    for (const line of lines) {
      const value = decimal(line.amount);
      balance = line.direction === "DEBIT" ? balance.plus(value) : balance.minus(value);
    }
    balances.set(account.accountType, (balances.get(account.accountType) ?? decimal(0)).plus(balance));
  }
  return balances;
};

router.get("/finance/profitability", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const attempts = await client.paymentAttempt.findMany({
    where: { createdAt: { gte: since } },
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

  let grossVolume = decimal(0);
  let grossCommission = decimal(0);
  let netMerchant = decimal(0);
  let accruedGatewayCost = decimal(0);
  const byRail = new Map<string, { volume: Decimal; commission: Decimal }>();
  const byDay = new Map<string, { volume: Decimal; commission: Decimal }>();
  const byGateway = new Map<string, { volume: Decimal; commission: Decimal }>();

  for (const attempt of attempts) {
    if (attempt.status !== "SUCCEEDED") {
      continue;
    }
    const volume = decimal(attempt.totalChargedAmount);
    const commission = decimal(attempt.platformCommissionAmount);
    grossVolume = grossVolume.plus(volume);
    grossCommission = grossCommission.plus(commission);
    netMerchant = netMerchant.plus(decimal(attempt.netMerchantAmount));
    accruedGatewayCost = accruedGatewayCost.plus(decimal(attempt.gatewayFeeAmount ?? 0));

    const railCode = railCodes.get(attempt.railId) ?? "unknown";
    const railEntry = byRail.get(railCode) ?? { volume: decimal(0), commission: decimal(0) };
    railEntry.volume = railEntry.volume.plus(volume);
    railEntry.commission = railEntry.commission.plus(commission);
    byRail.set(railCode, railEntry);

    const day = attempt.createdAt.toISOString().slice(0, 10);
    const dayEntry = byDay.get(day) ?? { volume: decimal(0), commission: decimal(0) };
    dayEntry.volume = dayEntry.volume.plus(volume);
    dayEntry.commission = dayEntry.commission.plus(commission);
    byDay.set(day, dayEntry);

    const gatewayId = attempt.routeId ? routeGateways.get(attempt.routeId) ?? "unknown" : "unknown";
    const gatewayEntry = byGateway.get(gatewayId) ?? { volume: decimal(0), commission: decimal(0) };
    gatewayEntry.volume = gatewayEntry.volume.plus(volume);
    gatewayEntry.commission = gatewayEntry.commission.plus(commission);
    byGateway.set(gatewayId, gatewayEntry);
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

  const toRows = (source: Map<string, { volume: Decimal; commission: Decimal }>, keyName: string) =>
    [...source.entries()]
      .map(([key, value]) => ({
        [keyName]: key,
        volume: value.volume.toFixed(4),
        commission: value.commission.toFixed(4),
        net: value.volume.minus(value.commission).toFixed(4),
      }))
      .sort((left, right) => String(left[keyName]).localeCompare(String(right[keyName])));

  response.json({
    currency: "LYD",
    windowDays: 30,
    succeededAttempts: attempts.filter((attempt) => attempt.status === "SUCCEEDED").length,
    grossVolume: grossVolume.toFixed(4),
    grossCommissionRevenue: grossCommission.toFixed(4),
    netMerchantAmount: netMerchant.toFixed(4),
    gatewayCostRealized: gatewayCostRealized.toFixed(4),
    gatewayCostAccrued: gatewayCostAccrued.toFixed(4),
    netRevenue: netRevenue.toFixed(4),
    chargebackLosses: chargebackLosses.toFixed(4),
    netContribution: netContribution.toFixed(4),
    commissionReceivable: commissionReceivable.toFixed(4),
    byRail: toRows(byRail, "railCode"),
    byDay: toRows(byDay, "day"),
    byGateway: toRows(byGateway, "gatewayId"),
  });
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

router.get("/finance/liquidity", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const balances = await loadLedgerBalances();
  const debitPositive = (type: string): Decimal => balances.get(type) ?? decimal(0);
  const creditPositive = (type: string): Decimal => (balances.get(type) ?? decimal(0)).neg();

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
    select: { createdAt: true, settledAmount: true, totalChargedAmount: true },
  });
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

  response.json({
    currency: "LYD",
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
      amlHold: debitPositive("AML_HOLD").toFixed(4),
      chargebackReserve: debitPositive("CHARGEBACK_RESERVE").toFixed(4),
      suspense: debitPositive("SUSPENSE").toFixed(4),
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
  });
});

router.get("/finance/invariant-check", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  // The invariant has exactly ONE implementation: the `InvariantVerifier`.
  // A second copy of the formula in the admin API is how a sign error reaches
  // the operator panel and halts the payouts for a ledger that is balanced.
  const verifier = new InvariantVerifier(client as never);
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

  response.json({
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
  });
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

router.put("/settings/checkout-support", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:write"]);
  const body = parseOrThrow(z.strictObject({ value: checkoutSupportSchema }).strict(), request.body ?? {});
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
  await client.auditLog.create({
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
  response.json({ key: CHECKOUT_SUPPORT_KEY, value: body.value, version: nextVersion });
});

/**
 * The Employee Academy progress of the authenticated admin.
 *
 * It is deliberately stored on the user row: management can see whether a new
 * hire completed the curriculum before granting `is_maker` / `is_checker`.
 */
const academyProgressSchema = z
  .strictObject({
    completedModules: z.array(z.string().max(40)).max(40).default([]),
    quizScores: z.record(z.string().max(40), z.number().min(0).max(100)).default({}),
    completedLabs: z.array(z.string().max(60)).max(100).default([]),
    badges: z.array(z.string().max(60)).max(20).default([]),
    lastModuleId: z.string().max(40).optional(),
    updatedAt: z.string().max(40).optional(),
  });

router.get("/academy/progress", async (request: Request, response: Response) => {
  const actor = actorFromRequest(request);
  const user = await client.user.findUnique({ where: { id: actor.userId } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  response.json({
    userId: user.id,
    progress: (user.academyProgressJson ?? {
      completedModules: [],
      quizScores: {},
      completedLabs: [],
      badges: [],
    }) as unknown,
  });
});

router.put("/academy/progress", async (request: Request, response: Response) => {
  const actor = actorFromRequest(request);
  const body = parseOrThrow(z.strictObject({ progress: academyProgressSchema }).strict(), request.body ?? {});
  await client.user.update({
    where: { id: actor.userId },
    data: { academyProgressJson: json({ ...body.progress, updatedAt: new Date().toISOString() }) },
  });
  response.json({ userId: actor.userId, progress: body.progress });
});

/** Management view: the academy progress of every admin user. */
router.get("/academy/progress/overview", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read"]);
  const users = await client.user.findMany({
    where: { merchantId: null },
    select: { id: true, email: true, role: true, academyProgressJson: true, isMaker: true, isChecker: true },
    orderBy: { email: "asc" },
  });
  response.json({
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      role: user.role,
      isMaker: user.isMaker,
      isChecker: user.isChecker,
      progress: user.academyProgressJson ?? null,
    })),
  });
});

router.get("/settings", async (request: Request, response: Response) => {
  requireAuthorities(request, ["settings:read"]);
  const settings = await client.platformSetting.findMany({ orderBy: [{ key: "asc" }, { version: "desc" }] });
  response.json({ settings });
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
              }),
          )
          .min(1)
          .max(50),
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
  await client.auditLog.create({
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "PLATFORM_SETTINGS_UPDATED",
      entityType: "PLATFORM_SETTING",
      entityId: written[0]?.key ?? "settings",
      beforeJson: {},
      afterJson: { settings: written },
    },
  });
  response.json({ settings: written });
});

export const adminInternalRouter = router;
export { LedgerPoster };
