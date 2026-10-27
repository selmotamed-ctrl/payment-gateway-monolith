import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma, type ContentType } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { invalidationBus } from "../../lib/invalidationBus";
import { StatementIngestor } from "../../engine/reconciliation/StatementIngestor";
import { getPlatformRuntime } from "../../engine/runtime";
import { InvariantVerifier, naturalBalance } from "../../engine/ledger/InvariantVerifier";
import { moneyToString } from "../../engine/db/money";
import { ApiError, parseOrThrow } from "../../lib/error";
import {
  generateMfaCode,
  hashMfaCode,
  hashPassword,
  signMfaChallenge,
  signSession,
  verifyMfaChallengeToken,
  verifyPassword,
} from "../../lib/auth";
import type { Decimal } from "decimal.js";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { LedgerPoster } from "../../engine/ledger/LedgerPoster";
import { GoLiveGateValidator } from "../../engine/flow/GoLiveGateValidator";
import {
  executeApprovalSubject,
  executeCashout,
  openDisputeWithDraftedAdjustment,
  type GovernanceExecutionContext,
} from "../../engine/governance/GovernanceExecution";
import { evaluateRouteDailyCap } from "../../engine/flow/VisibleRailsResolver";
import { dayWindowInTimeZone, resolveGatewayTimezone } from "../../engine/flow/DailyRouteVolume";
import { PrismaRepositories } from "../../engine/db/repositories";
import { validateTransformUsage, type TransformPipe, type TransformUsage } from "../../engine/transforms/TransformPipeline";
import { json, jsonOptional } from "./json";
import { requireAuthentication, requireAuthorities, principalOf } from "../middleware/authDoubleCheck";
import { actorFromRequest, assertCheckerAuthority, assertCheckerIsNotMaker, SYSTEM_AUTOMATION_PRINCIPAL } from "../middleware/makerCheckerGuard";

const router = express.Router();

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
  });
});

router.use(requireAuthentication);

router.get("/users", async (request: Request, response: Response) => {
  requireAuthorities(request, ["user:read", "security:read"]);
  const users = await client.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
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
    })),
  });
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
  const query = z
    .object({
      status: z.string().max(40).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      pageSize: z.coerce.number().int().min(1).max(200).optional(),
    })
    .parse(request.query ?? {});
  const take = query.pageSize ?? 50;
  const skip = ((query.page ?? 1) - 1) * take;
  const joinRequests = await client.joinRequest.findMany({
    where: query.status ? { status: query.status as never } : {},
    include: { merchant: true, kybDocuments: true },
    orderBy: { createdAt: "desc" },
    take,
    skip,
  });
  response.json({ joinRequests });
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
    await client.$transaction(async (tx) => {
      await tx.joinRequest.update({
        where: { id },
        data: {
          status: "APPROVED",
          decision: "APPROVED",
          decisionReasonCode: body.reasonCode,
          decisionNotes: body.notes,
          proposedRiskTier: body.proposedRiskTier,
        },
      });
      await tx.merchant.update({
        where: { id: joinRequest.merchantId },
        data: {
          status: "ACTIVE",
          kybStatus: "VERIFIED",
          riskTier: body.proposedRiskTier ?? joinRequest.proposedRiskTier,
          activatedAt: new Date(),
        },
      });
      await tx.wallet.updateMany({
        where: { merchantId: joinRequest.merchantId },
        data: { status: "ACTIVE" },
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
  const merchants = await client.merchant.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  response.json({ merchants });
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
  const query = z
    .object({
      state: z.string().max(40).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      pageSize: z.coerce.number().int().min(1).max(200).optional(),
    })
    .parse(request.query ?? {});
  const take = query.pageSize ?? 50;
  const skip = ((query.page ?? 1) - 1) * take;
  const approvals = await client.approvalRequest.findMany({
    where: query.state ? { state: query.state as never } : {},
    orderBy: { createdAt: "desc" },
    take,
    skip,
  });
  response.json({ approvals });
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
    const state = result.status === "HELD"
      ? "PENDING_REVIEW"
      : result.reason === "NO_EXECUTABLE_SUBJECT"
        ? "APPROVED"
        : "EXECUTED";
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
    await activateGatewayVersion(approval.subjectId);
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
 * Promotes a gateway version to LIVE. The previous live version is
 * superseded and the outbound consumer cache of the gateway is invalidated.
 */
const activateGatewayVersion = async (versionId: string): Promise<void> => {
  const version = await client.gatewayVersion.findUnique({ where: { id: versionId } });
  if (!version) {
    return;
  }
  await client.$transaction(async (tx) => {
    await tx.gatewayVersion.updateMany({
      where: { gatewayId: version.gatewayId, state: "LIVE", id: { not: version.id } },
      data: { state: "SUPERSEDED" },
    });
    await tx.gatewayVersion.update({ where: { id: version.id }, data: { state: "LIVE" } });
    await tx.gateway.update({
      where: { id: version.gatewayId },
      data: { activeVersionId: version.id, status: "LIVE" },
    });
  });
  await invalidationBus.invalidateGateway(version.gatewayId, "gateway-version-live");
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
  const screenings = await client.amlScreening.findMany({
    include: { matches: true },
    orderBy: { requestedAt: "desc" },
    take: 200,
  });
  response.json({ screenings });
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
  const cases = await client.amlCase.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  response.json({ cases });
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
  const rules = await client.amlRule.findMany({ orderBy: { code: "asc" } });
  response.json({ rules });
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

router.get("/aml/reports", async (request: Request, response: Response) => {
  assertConfidential(request);
  const reports = await client.regulatoryReport.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  response.json({
    reports: reports.map((report) => ({
      id: report.id,
      reportType: report.reportType,
      authority: report.authority,
      status: report.status,
      confidential: report.confidential,
      submittedAt: report.submittedAt,
    })),
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
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  const payloadJson = JSON.stringify(body.payload);
  const report = await client.regulatoryReport.create({
    data: {
      reportType: body.reportType,
      authority: body.authority,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      amlCaseId: body.amlCaseId ?? null,
      payloadCiphertext: payloadJson,
      payloadSha256: createHash("sha256").update(payloadJson).digest("hex"),
      status: "PENDING_CHECKER",
      confidential: true,
    },
  });
  await client.auditLog.create({
    data: {
      actorId: actor.userId,
      role: actor.role,
      action: "REGULATORY_REPORT_DRAFTED",
      entityType: "REGULATORY_REPORT",
      entityId: report.id,
      beforeJson: {},
      afterJson: { reportType: report.reportType, authority: report.authority },
    },
  });
  response.status(201).json({ id: report.id, status: report.status });
});

router.get("/operator-cases", async (request: Request, response: Response) => {
  requireAuthorities(request, ["case:read", "operator:read"]);
  const cases = await client.operatorCase.findMany({
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  response.json({ cases });
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

router.get("/gateways", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const gateways = await client.gateway.findMany({ orderBy: { code: "asc" } });
  response.json({ gateways });
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

router.post("/gateways/:id/rollback", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({ versionId: z.string().min(1).max(64) }).strict(), request.body);
  const target = await client.gatewayVersion.findFirst({ where: { id: body.versionId, gatewayId: id } });
  if (!target) {
    throw new ApiError(404, "GATEWAY_VERSION_NOT_FOUND", "The gateway version does not exist");
  }
  const gateway = await client.$transaction(async (tx) => {
    const previous = await tx.gatewayVersion.findMany({
      where: { gatewayId: id, state: "LIVE" },
      select: { id: true },
    });
    for (const version of previous) {
      await tx.gatewayVersion.update({ where: { id: version.id }, data: { state: "ROLLED_BACK" } });
    }
    await tx.gatewayVersion.update({ where: { id: target.id }, data: { state: "LIVE" } });
    return tx.gateway.update({
      where: { id },
      data: { activeVersionId: target.id, status: "LIVE" },
    });
  });
  // The outbound consumers of the gateway are now stale.
  await invalidationBus.invalidateGateway(id, "gateway-version-rolled-back");
  response.json({ id: gateway.id, activeVersionId: gateway.activeVersionId });
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
  const gates = new GoLiveGateValidator();
  const channels = await client.confirmationChannel.findMany({ where: { gatewayVersionId: vid } });
  const gateway = await client.gateway.findUnique({ where: { id: version.gatewayId } });
  const routes = await client.railRoute.findMany({ where: { gatewayId: version.gatewayId } });
  const profiles = await client.commissionProfile.findMany({ where: { railCode: { in: (await client.rail.findMany({ where: { routes: { some: { gatewayId: version.gatewayId } } } })).map((rail) => rail.code) } } });
  const sources = await client.statementSource.findMany({ where: { gatewayId: version.gatewayId } });
  const checker = await client.approvalRequest.findFirst({
    where: { subjectType: "GATEWAY_VERSION", subjectId: vid, checkerUserId: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  const report = await gates.validate({
    makerUserId: version.createdById,
    checkerUserId: checker?.checkerUserId ?? "",
    scenarioResults: [],
    amountPipelineContractPassed: false,
    referenceFormatContractPassed: false,
    cryptographicSignatureContractPassed: false,
    channels: channels.map((channel) => ({
      type: channel.type,
      verificationMethod: channel.verifyMethod,
      mustInquire: channel.mustInquire,
    })),
    rollbackVersionId: version.rollbackVersionId,
    routeLimitsPreviewed: routes.length > 0,
    commissionProfilePreviewed: profiles.length > 0,
    statementParserPreviewed: sources.length > 0,
    evidenceLevel: gateway?.verificationState === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
    internalContractSuitePassed: false,
    highRiskExecutiveAcceptanceSigned: false,
    panFieldCount: 0,
    pciScopeReviewPassed: false,
    canaryTrafficPlanConfigured: false,
    routeAlertsConfigured: false,
    runbooksConfigured: false,
  });
  response.json({
    gatewayVersionId: version.id,
    requestedScenarios: body.scenarios ?? [],
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

router.get("/rails", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const rails = await client.rail.findMany({ include: { fields: true }, orderBy: { displayOrder: "asc" } });
  response.json({ rails });
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
  const routes = await client.railRoute.findMany({ include: { rail: true, gateway: true } });
  response.json({ routes });
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
  const sources = await client.statementSource.findMany({ include: { gateway: true } });
  response.json({ sources });
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
  const runs = await client.reconciliationRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { items: true },
  });
  response.json({ runs });
});

router.post("/reconciliation/upload", async (request: Request, response: Response) => {
  requireAuthorities(request, ["reconciliation:write"]);
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (raw.byteLength === 0) {
    throw new ApiError(400, "STATEMENT_FILE_REQUIRED", "A statement file payload is required");
  }
  const sourceId = String(request.headers["x-statement-source-id"] ?? "");
  if (!sourceId) {
    throw new ApiError(400, "STATEMENT_SOURCE_REQUIRED", "The statement source identifier header is required");
  }
  const metadataHeader = request.headers["x-upload-metadata"];
  let metadata: Record<string, unknown> = {};
  if (typeof metadataHeader === "string" && metadataHeader.length > 0) {
    try {
      metadata = JSON.parse(Buffer.from(metadataHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  const windowStart = typeof metadata.periodStart === "string"
    ? new Date(metadata.periodStart)
    : new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const windowEnd = typeof metadata.periodEnd === "string"
    ? new Date(metadata.periodEnd)
    : new Date();

  // The statement is parsed and matched against the local attempts, and the
  // fee variance is trued up through the ledger.
  const platform = getPlatformRuntime(client as never);
  const ingestor = new StatementIngestor({
    db: client as never,
    repositories: platform.repositories,
    feeVariancePoster: {
      postFeeVariance: async (posting) => {
        const variance = moneyToString(posting.variance);
        if (variance === "0.0000") {
          return { journalEntryId: null };
        }
        const result = await platform.ledgerPoster.postScenario(
          "FEE_VARIANCE_TRUE_UP",
          posting.attemptId ?? `fee-variance:${posting.statementSourceId}`,
          { amount: "0.0001", varianceAmount: variance },
          {
            gatewayId: posting.gatewayId,
          },
        );
        return { journalEntryId: result.entry.id };
      },
    },
  });

  const result = await ingestor.ingest({
    statementSourceId: sourceId,
    content: raw,
    fileName: typeof request.headers["x-upload-filename"] === "string"
      ? decodeURIComponent(String(request.headers["x-upload-filename"]))
      : undefined,
    windowStart: Number.isNaN(windowStart.getTime()) ? undefined : windowStart,
    windowEnd: Number.isNaN(windowEnd.getTime()) ? undefined : windowEnd,
  });

  response.status(result.idempotent ? 200 : 201).json({
    runId: result.runId,
    fileHash: result.fileHash,
    idempotent: result.idempotent,
    totalRows: result.totalRows,
    matched: result.matched,
    amountMismatch: result.amountMismatch,
    missingAtGateway: result.missingAtGateway,
    missingLocally: result.missingLocally,
    duplicates: result.duplicates,
    feeVariances: result.feeVariances,
  });
});

router.get("/disputes", async (request: Request, response: Response) => {
  requireAuthorities(request, ["dispute:read"]);
  const disputes = await client.dispute.findMany({ orderBy: { openedAt: "desc" }, take: 200 });
  response.json({ disputes });
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
  // The dispute, the drafted chargeback adjustment, the approval request and
  // the reserve posting are written in one transaction.
  const result = await client.$transaction(async (tx) =>
    openDisputeWithDraftedAdjustment(governanceContext(platform), tx as never, {
      attemptId: body.attemptId,
      gatewayId: body.gatewayId,
      railId: body.railId,
      externalDisputeRef: body.externalDisputeRef,
      source: body.source,
      reasonCode: body.reasonCode ?? null,
      amount: decimal(body.amount),
      currency: body.currency,
      actorUserId: actor.userId,
      actorRole: actor.role,
    }),
  );
  response.status(201).json({
    id: result.disputeId,
    status: "OPENED",
    adjustmentId: result.adjustmentId,
    approvalRequestId: result.approvalRequestId,
    escrowed: result.escrowed,
    journalEntryId: result.journalEntryId,
  });
});

router.get("/adjustments", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const adjustments = await client.adjustment.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  response.json({ adjustments });
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
  const cashouts = await client.cashoutRequest.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  response.json({ cashouts });
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
