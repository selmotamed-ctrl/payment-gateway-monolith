import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import {
  generateAccessToken,
  generateMfaCode,
  hashAccessToken,
  hashMfaCode,
  hashPassword,
  signMfaChallenge,
  signSession,
  verifyMfaChallengeToken,
  verifyPassword,
} from "../../lib/auth";
import { Vault } from "../../engine/crypto/Vault";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { json, jsonOptional } from "./json";
import { requireAuthentication, requireMerchantScope, principalOf } from "../middleware/authDoubleCheck";

const router = express.Router();

router.get("/health", (_request, response) => {
  response.json({ status: "ok", channel: "merchant" });
});


const vault = new Vault();

const normalizePhone = (value: string): string => value.replace(/[\s\-().]/g, "").replace(/^218/, "0");
const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const idSchema = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });

const registerSchema = z
  .object({
    phone: z.string().min(6).max(20).optional(),
    email: z.string().email().optional(),
    password: z.string().min(10).max(128),
    fullName: z.string().min(2).max(120),
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]).optional(),
    identityNumber: z.string().min(4).max(32).optional(),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.phone || value.email), {
    error: "a phone number or an email address is required",
    path: ["phone"],
  });

const verifyIdentitySchema = z
  .object({
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
    identityNumber: z.string().min(4).max(32),
    phone: z.string().min(6).max(20),
    code: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

const loginSchema = z
  .object({
    identifier: z.string().min(3).max(128),
    password: z.string().min(1).max(128),
  })
  .strict();

const googleSchema = z.object({ idToken: z.string().min(20).max(4096) }).strict();

const mfaSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    challengeId: z.string().min(4).max(4096).optional(),
  })
  .strict();

const requireMerchantId = (principal: { merchantId: string | null }): string => {
  if (!principal.merchantId) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "The principal is not bound to a merchant");
  }
  return principal.merchantId;
};

const merchantIdOf = (request: Request): string => {
  const principal = principalOf(request);
  if (!principal.merchantId) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "The principal is not bound to a merchant");
  }
  return principal.merchantId;
};

const buildSession = (user: {
  id: string;
  role: string;
  merchantId: string | null;
  authoritiesMap: unknown;
  appScopeIds: unknown;
}): { token: string; expiresInSeconds: number; user: Record<string, unknown> } => {
  const authorities = Array.isArray(user.authoritiesMap)
    ? user.authoritiesMap.map(String)
    : Object.entries((user.authoritiesMap ?? {}) as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([authority]) => authority);
  const appScopeIds = Array.isArray(user.appScopeIds) ? user.appScopeIds.map(String) : [];
  const token = signSession({
    sub: user.id,
    role: user.role,
    merchantId: user.merchantId,
    authorities,
    appScopeIds,
    mfa: true,
  });
  return {
    token,
    expiresInSeconds: 12 * 60 * 60,
    user: {
      id: user.id,
      role: user.role,
      merchantId: user.merchantId,
      authorities,
      appScopeIds,
    },
  };
};

router.post("/auth/register", async (request: Request, response: Response) => {
  const body = parseOrThrow(registerSchema, request.body);
  const phone = body.phone ? normalizePhone(body.phone) : null;
  const email = body.email ? normalizeEmail(body.email) : null;

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
  }

  const passwordHash = await hashPassword(body.password);

  const created = await client.$transaction(async (tx) => {
    const merchant = await tx.merchant.create({
      data: {
        legalName: body.fullName,
        tradeName: body.fullName,
        status: "PENDING",
        kybStatus: "UNVERIFIED",
        riskTier: "STANDARD",
        onboardingChannel: "SELF_SERVICE",
        country: "LY",
        contactPhone: phone,
        contactEmail: email,
      },
    });
    const user = await tx.user.create({
      data: {
        merchantId: merchant.id,
        email: email ?? `${phone ?? randomBytes(6).toString("hex")}@pending.payment-gateway.local`,
        phone,
        passwordHash,
        role: "MERCHANT_ADMIN",
        authoritiesMap: ["merchant:read", "merchant:write", "link:write", "payment:read"],
        isMaker: true,
        isChecker: false,
        mfaRequired: true,
        status: "ACTIVE",
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
        checkpointBalance: new Prisma.Decimal(0),
      },
    });
    const wallet = await tx.wallet.create({
      data: { merchantId: merchant.id, glAccountId: glAccount.id, currency: "LYD", status: "PENDING" },
    });
    await tx.joinRequest.create({
      data: {
        merchantId: merchant.id,
        submittedByUserId: user.id,
        status: "DRAFT",
        onboardingChannel: "SELF_SERVICE",
        slaDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        proposedRiskTier: "STANDARD",
        fourEyesRequired: true,
        fourEyesReasons: ["ONBOARDING"],
      },
    });
    return { merchant, user, wallet };
  });

  response.status(201).json({
    merchantId: created.merchant.id,
    walletId: created.wallet.id,
    userId: created.user.id,
    status: "REGISTERED",
    mfaRequired: true,
  });
});

router.post("/auth/verify-identity", async (request: Request, response: Response) => {
  const body = parseOrThrow(verifyIdentitySchema, request.body);
  const phone = normalizePhone(body.phone);
  const identity = await client.userIdentity.findFirst({
    where: { kind: "PHONE", identifierNormalized: phone },
    include: { user: true },
  });
  if (!identity) {
    throw new ApiError(404, "IDENTITY_NOT_FOUND", "The phone number is not registered");
  }
  const code = generateMfaCode();
  await client.userIdentity.update({
    where: { id: identity.id },
    data: { verifiedAt: new Date(), lastUsedAt: new Date() },
  });
  await client.notification.create({
    data: {
      eventId: randomBytes(16).toString("hex"),
      recipientUserId: identity.userId,
      templateCode: "IDENTITY_VERIFICATION",
      channel: "SMS",
      lang: "EN",
      payloadJson: json({ code }),
      addressCiphertext: "",
      status: "QUEUED",
      addressMasked: phone.slice(-4),
    },
  });
  response.json({ verified: true, challengeId: signMfaChallenge({
    userId: identity.userId,
    code,
    role: identity.user.role,
    merchantId: identity.user.merchantId,
  }) });
});

router.post("/auth/login", async (request: Request, response: Response) => {
  const body = parseOrThrow(loginSchema, request.body);
  const identifier = body.identifier.includes("@")
    ? normalizeEmail(body.identifier)
    : normalizePhone(body.identifier);
  const user = identifier.includes("@")
    ? await client.user.findFirst({
        where: {
          OR: [
            { email: identifier },
            { identities: { some: { kind: "EMAIL", identifierNormalized: identifier } } },
          ],
        },
      })
    : await client.user.findFirst({
        where: { OR: [{ phone: identifier }, { identities: { some: { kind: "PHONE", identifierNormalized: identifier } } }] },
      });
  if (!user || !user.passwordHash) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "The supplied credentials are not valid");
  }
  const valid = await verifyPassword(body.password, user.passwordHash);
  if (!valid) {
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
  response.json(buildSession(user));
});

router.post("/auth/google", async (request: Request, response: Response) => {
  parseOrThrow(googleSchema, request.body);
  throw new ApiError(
    501,
    "GOOGLE_IDENTITY_NOT_CONFIGURED",
    "Google sign-in requires a configured OIDC provider",
  );
});

router.post("/auth/mfa/verify", async (request: Request, response: Response) => {
  const body = parseOrThrow(mfaSchema, request.body);
  if (!body.challengeId) {
    throw new ApiError(400, "MFA_CHALLENGE_REQUIRED", "An MFA challenge identifier is required");
  }
  let claims;
  try {
    claims = verifyMfaChallengeToken(body.challengeId);
  } catch {
    throw new ApiError(401, "MFA_CHALLENGE_INVALID", "The MFA challenge is invalid or expired");
  }
  const expected = hashMfaCode(claims.sub, body.code);
  if (expected !== claims.codeHash) {
    throw new ApiError(401, "MFA_CODE_INVALID", "The supplied MFA code is not valid");
  }
  const user = await client.user.findUnique({ where: { id: claims.sub } });
  if (!user || user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "The account is not active");
  }
  response.json(buildSession(user));
});

router.use(requireAuthentication);

router.get("/onboarding/join-request", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const joinRequest = await client.joinRequest.findFirst({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
    include: { kybDocuments: true },
  });
  response.json({ joinRequest });
});

router.put("/onboarding/join-request", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        legalName: z.string().min(2).max(160).optional(),
        tradeName: z.string().min(2).max(160).optional(),
        country: z.string().length(2).optional(),
        businessType: z.string().min(2).max(64).optional(),
        registrationNumber: z.string().min(2).max(64).optional(),
        taxNumber: z.string().min(2).max(64).optional(),
        address: z.string().min(4).max(400).optional(),
        phone: z.string().min(6).max(20).optional(),
        email: z.string().email().optional(),
        website: z.string().max(200).optional(),
        locale: z.enum(["ar", "en"]).optional(),
      })
      .strict(),
    request.body,
  );
  await client.merchant.update({
    where: { id: merchantId },
    data: {
      legalName: body.legalName,
      tradeName: body.tradeName,
      country: body.country,
      businessCategory: body.businessType,
      registrationNo: body.registrationNumber,
      taxId: body.taxNumber,
      contactPhone: body.phone,
      contactEmail: body.email,
    },
  });
  const existing = await client.joinRequest.findFirst({
    where: { merchantId, status: { in: ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    await client.joinRequest.update({
      where: { id: existing.id },
      data: { status: "DRAFT" },
    });
  }
  response.json({ updated: true, merchantId });
});

router.post("/onboarding/kyb-documents", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (raw.byteLength === 0) {
    throw new ApiError(400, "UPLOAD_REQUIRED", "A KYB document payload is required");
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const duplicates = await client.kybDocument.findMany({ where: { sha256 } });
  if (duplicates.length > 0) {
    throw new ApiError(409, "KIB_DOCUMENT_DUPLICATE", "This document was already submitted by another merchant", {
      existingIds: duplicates.map((entry) => entry.id),
    });
  }
  const metadataHeader = request.headers["x-upload-metadata"];
  const metadata = typeof metadataHeader === "string"
    ? (JSON.parse(Buffer.from(metadataHeader, "base64url").toString("utf8")) as Record<string, unknown>)
    : {};
  const mime = typeof request.headers["x-upload-content-type"] === "string"
    ? (request.headers["x-upload-content-type"] as string)
    : "application/octet-stream";
  const sizeBytes = Number(request.headers["x-upload-size"] ?? raw.byteLength);
  const storageKey = `kyb/${merchantId}/${sha256}`;
  const joinRequest = await client.joinRequest.findFirst({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
  });
  const document = await client.kybDocument.create({
    data: {
      merchantId,
      joinRequestId: joinRequest?.id ?? null,
      subjectType: "MERCHANT",
      subjectId: merchantId,
      docType: String(metadata.documentType ?? "OTHER").toUpperCase().replaceAll(" ", "_") as never,
      storageKey,
      sha256,
      mime,
      sizeBytes,
      avStatus: "PENDING",
      status: "UPLOADED",
    },
  });
  response.status(201).json({ id: document.id, sha256, status: document.status, avStatus: document.avStatus });
});

router.get("/onboarding/beneficial-owners", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const owners = await client.beneficialOwner.findMany({ where: { merchantId } });
  response.json({ owners });
});

router.post("/onboarding/beneficial-owners", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        fullName: z.string().min(2).max(160),
        identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
        identityNumber: z.string().min(4).max(32),
        nationality: z.string().min(2).max(64).optional(),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ownershipPercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
        position: z.string().min(2).max(80).optional(),
      })
      .strict(),
    request.body,
  );
  const ciphertext = await vault.encryptSecret(body.identityNumber, "kyb-national-id");
  const owner = await client.beneficialOwner.create({
    data: {
      merchantId,
      fullNameAr: body.fullName,
      nationalIdCiphertext: ciphertext,
      dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : new Date(),
      nationality: (body.nationality ?? "LY").slice(0, 2).toUpperCase(),
      ownershipPercent: body.ownershipPercent ? new Prisma.Decimal(body.ownershipPercent) : null,
      role: "OWNER",
      validFrom: new Date(),
    },
  });
  response.status(201).json({ id: owner.id, fullName: owner.fullNameAr, screeningStatus: owner.screeningStatus });
});

router.delete("/onboarding/beneficial-owners/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const owner = await client.beneficialOwner.findFirst({ where: { id, merchantId } });
  if (!owner) {
    throw new ApiError(404, "BENEFICIAL_OWNER_NOT_FOUND", "The beneficial owner does not exist");
  }
  await client.beneficialOwner.update({ where: { id }, data: { active: false } });
  response.json({ id, active: false });
});

router.post("/onboarding/submit", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  parseOrThrow(
    z.object({ acknowledgement: z.literal(true), idempotencyKey: z.string().min(8).max(128).optional() }).strict(),
    request.body ?? {},
  );
  const joinRequest = await client.joinRequest.findFirst({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
  });
  if (!joinRequest) {
    throw new ApiError(404, "JOIN_REQUEST_NOT_FOUND", "No join request exists for this merchant");
  }
  if (!["DRAFT", "INFO_REQUESTED"].includes(joinRequest.status)) {
    throw new ApiError(409, "JOIN_REQUEST_NOT_SUBMITTABLE", "The join request is not in a submittable state");
  }
  const documents = await client.kybDocument.count({ where: { merchantId, status: { not: "REJECTED" } } });
  if (documents === 0) {
    throw new ApiError(409, "KIB_DOCUMENTS_REQUIRED", "At least one KYB document is required before submission");
  }
  const updated = await client.joinRequest.update({
    where: { id: joinRequest.id },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
  response.json({ id: updated.id, status: updated.status, slaDueAt: updated.slaDueAt });
});

router.get("/wallets", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const wallets = await client.wallet.findMany({ where: { merchantId }, include: { glAccount: true } });
  response.json({ wallets });
});

router.post("/wallets", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z.object({ currency: z.string().length(3).default("LYD"), label: z.string().max(80).optional() }).strict(),
    request.body ?? {},
  );
  const wallet = await client.$transaction(async (tx) => {
    const glAccount = await tx.glAccount.create({
      data: {
        accountType: "MERCHANT_WALLET",
        ownerId: merchantId,
        currency: body.currency.toUpperCase(),
        checkpointBalance: new Prisma.Decimal(0),
      },
    });
    return tx.wallet.create({
      data: { merchantId, glAccountId: glAccount.id, currency: body.currency.toUpperCase(), status: "PENDING" },
    });
  });
  response.status(201).json({ id: wallet.id, currency: wallet.currency, status: wallet.status });
});

router.get("/wallets/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findFirst({ where: { id, merchantId }, include: { glAccount: true } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  response.json({ wallet });
});

router.get("/wallets/:id/balance", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findFirst({ where: { id, merchantId }, include: { glAccount: true } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  const lines = await client.journalLine.findMany({
    where: { glAccountId: wallet.glAccountId },
    select: { direction: true, amount: true },
  });
  let balance = decimal(0);
  for (const line of lines) {
    const value = decimal(line.amount);
    balance = line.direction === "CREDIT" ? balance.plus(value) : balance.minus(value);
  }
  response.json({
    walletId: wallet.id,
    currency: wallet.currency,
    balance: balance.toFixed(4),
    checkpointBalance: decimal(wallet.glAccount.checkpointBalance).toFixed(4),
  });
});

router.get("/wallets/:id/statements", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findFirst({ where: { id, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  const query = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).parse(request.query ?? {});
  const attempts = await client.paymentAttempt.findMany({
    where: { merchantId, createdAt: { gte: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  response.json({ walletId: wallet.id, month: query.month ?? null, attempts });
});

router.get("/wallets/:id/statements/:month/export", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const month = String(request.params.month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new ApiError(400, "STATEMENT_MONTH_INVALID", "The statement month must be formatted as YYYY-MM");
  }
  const wallet = await client.wallet.findFirst({ where: { id, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  const attempts = await client.paymentAttempt.findMany({
    where: { merchantId, status: "SUCCEEDED" },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  const rows = attempts
    .filter((attempt) => attempt.createdAt.toISOString().startsWith(month))
    .map((attempt) => [
      attempt.reference,
      attempt.createdAt.toISOString(),
      decimal(attempt.totalChargedAmount).toFixed(4),
      decimal(attempt.platformCommissionAmount).toFixed(4),
      decimal(attempt.netMerchantAmount).toFixed(4),
      attempt.currency,
      attempt.status,
    ].join(","));
  const header = "reference,created_at,total_charged,commission,net_merchant,currency,status";
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="statement-${month}.csv"`);
  response.send([header, ...rows].join("\n"));
});

router.get("/applications", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const applications = await client.application.findMany({ where: { merchantId }, include: { assignedWallet: true } });
  response.json({ applications });
});

router.post("/applications", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        name: z.string().min(2).max(160),
        businessUseDescription: z.string().max(2000).optional(),
        expectedMonthlyVolume: z.string().regex(/^\d{1,12}(\.\d{1,4})?$/).optional(),
        assignedWalletId: z.string().min(1).max(64),
        railWhitelist: z.array(z.string().min(1).max(64)).min(1).optional(),
        redirectDomainAllowlist: z.array(z.string().min(1).max(200)).min(1).optional(),
      })
      .strict(),
    request.body,
  );
  const wallet = await client.wallet.findFirst({ where: { id: body.assignedWalletId, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The assigned wallet does not exist");
  }
  const application = await client.application.create({
    data: {
      merchantId,
      name: body.name,
      businessUseDescription: body.businessUseDescription,
      expectedMonthlyVolume: body.expectedMonthlyVolume ? new Prisma.Decimal(body.expectedMonthlyVolume) : new Prisma.Decimal(0),
      assignedWalletId: wallet.id,
      railWhitelist: jsonOptional(body.railWhitelist),
      redirectDomainAllowlist: jsonOptional(body.redirectDomainAllowlist),
      status: "PENDING",
    },
  });
  response.status(201).json({ id: application.id, name: application.name, status: application.status });
});

router.get("/applications/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const application = await client.application.findFirst({ where: { id, merchantId } });
  if (!application) {
    throw new ApiError(404, "APPLICATION_NOT_FOUND", "The application does not exist");
  }
  response.json({ application });
});

router.patch("/applications/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        name: z.string().min(2).max(160).optional(),
        businessUseDescription: z.string().max(2000).optional(),
        expectedMonthlyVolume: z.string().regex(/^\d{1,12}(\.\d{1,4})?$/).optional(),
        assignedWalletId: z.string().min(1).max(64).optional(),
        railWhitelist: z.array(z.string().min(1).max(64)).min(1).optional(),
        redirectDomainAllowlist: z.array(z.string().min(1).max(200)).min(1).optional(),
      })
      .strict(),
    request.body,
  );
  const application = await client.application.findFirst({ where: { id, merchantId } });
  if (!application) {
    throw new ApiError(404,APPLICATION_NOT_FOUND_CODE, "The application does not exist");
  }
  const sensitive = body.assignedWalletId !== undefined
    || body.railWhitelist !== undefined
    || body.redirectDomainAllowlist !== undefined;
  if (sensitive) {
    const principal = principalOf(request);
    const approval = await client.approvalRequest.create({
      data: {
        subjectType: "APPLICATION",
        subjectId: application.id,
        payloadDiffJson: body,
        mode: "STANDARD",
        makerUserId: principal.userId ?? application.merchantId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    response.status(202).json({ status: "PENDING_REVIEW", approvalRequestId: approval.id });
    return;
  }
  const updated = await client.application.update({
    where: { id: application.id },
    data: {
      name: body.name,
      businessUseDescription: body.businessUseDescription,
      expectedMonthlyVolume: body.expectedMonthlyVolume ? new Prisma.Decimal(body.expectedMonthlyVolume) : undefined,
    },
  });
  response.json({ id: updated.id, name: updated.name, status: updated.status });
});

const APPLICATION_NOT_FOUND_CODE = "APPLICATION_NOT_FOUND";

const normalizeFeeBearer = (value: string | undefined): "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT" => {
  switch ((value ?? "").toUpperCase()) {
    case "PAYER":
    case "PAYER_SURCHARGE":
      return "PAYER_SURCHARGE";
    case "SPLIT":
      return "SPLIT";
    default:
      return "MERCHANT_ABSORBS";
  }
};

const linkCreateSchema = z
  .object({
    title: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
    currency: z.string().length(3),
    feeBearer: z.enum(["PAYER", "MERCHANT", "PLATFORM", "MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"]).optional(),
    applicationId: z.string().min(1).max(64).optional(),
    walletId: z.string().min(1).max(64).optional(),
    expiresAt: z.string().max(64).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    infiniteUse: z.boolean().optional(),
    activeSlots: z.number().int().min(1).max(100_000).optional(),
    allowedRails: z.array(z.string().min(1).max(64)).max(50).optional(),
    metadata: z.record(z.string().max(64), z.unknown()).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

const createLink = async (merchantId: string, body: z.infer<typeof linkCreateSchema>) => {
  const application = body.applicationId
    ? await client.application.findFirst({ where: { id: body.applicationId, merchantId } })
    : await client.application.findFirst({ where: { merchantId }, orderBy: { createdAt: "asc" } });
  if (!application) {
    throw new ApiError(409, "APPLICATION_REQUIRED", "A merchant application is required before creating links");
  }
  const wallet = body.walletId
    ? await client.wallet.findFirst({ where: { id: body.walletId, merchantId } })
    : await client.wallet.findUnique({ where: { id: application.assignedWalletId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The settlement wallet does not exist");
  }
  const key = `pl_${randomBytes(12).toString("base64url")}`;
  const link = await client.paymentLink.create({
    data: {
      key,
      applicationId: application.id,
      walletId: wallet.id,
      amount: new Prisma.Decimal(body.amount),
      currency: body.currency.toUpperCase(),
      feeBearer: normalizeFeeBearer(body.feeBearer),
      infiniteUse: body.infiniteUse ?? false,
      useCount: body.infiniteUse ? 1_000_000 : body.maxUses ?? 1,
      redirectUrl: null,
      railWhitelist: jsonOptional(body.allowedRails),
      state: "PENDING",
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    },
  });
  return link;
};

router.get("/links", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const query = z
    .object({
      status: z.enum(["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"]).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      pageSize: z.coerce.number().int().min(1).max(200).optional(),
    })
    .parse(request.query ?? {});
  const take = query.pageSize ?? 50;
  const skip = ((query.page ?? 1) - 1) * take;
  const where: Record<string, unknown> = { application: { merchantId } };
  if (query.status) {
    where.state = query.status === "ACTIVE" ? "PENDING" : query.status;
  }
  const links = await client.paymentLink.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    skip,
  });
  response.json({ links, page: query.page ?? 1, pageSize: take });
});

router.post("/links", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(linkCreateSchema, request.body);
  const link = await createLink(merchantId, body);
  response.status(201).json({
    id: link.id,
    key: link.key,
    amount: decimal(link.amount).toFixed(4),
    currency: link.currency,
    feeBearer: link.feeBearer,
    state: link.state,
  });
});

router.get("/links/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const link = await client.paymentLink.findFirst({ where: { id, application: { merchantId } } });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  response.json({ link });
});

router.post("/links/:id/cancel", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const link = await client.paymentLink.findFirst({ where: { id, application: { merchantId } } });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  if (link.state === "COMPLETED") {
    throw new ApiError(409, "PAYMENT_LINK_COMPLETED", "A completed payment link cannot be cancelled");
  }
  const updated = await client.paymentLink.update({ where: { id: link.id }, data: { state: "CANCELLED" } });
  response.json({ id: updated.id, state: updated.state });
});

router.get("/links/:id/attempts", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const link = await client.paymentLink.findFirst({ where: { id, application: { merchantId } } });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  const attempts = await client.paymentAttempt.findMany({
    where: { linkId: link.id },
    orderBy: { createdAt: "desc" },
  });
  response.json({ attempts });
});

router.get("/payments", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const query = z
    .object({
      status: z.string().max(32).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      pageSize: z.coerce.number().int().min(1).max(200).optional(),
    })
    .parse(request.query ?? {});
  const take = query.pageSize ?? 50;
  const skip = ((query.page ?? 1) - 1) * take;
  const attempts = await client.paymentAttempt.findMany({
    where: { merchantId, ...(query.status ? { status: query.status as never } : {}) },
    orderBy: { createdAt: "desc" },
    take,
    skip,
  });
  response.json({ payments: attempts });
});

router.get("/disputes", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const attempts = await client.paymentAttempt.findMany({
    where: { merchantId, status: "DISPUTED" },
    select: { id: true },
  });
  const disputes = await client.dispute.findMany({
    where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    orderBy: { openedAt: "desc" },
  });
  response.json({ disputes });
});

router.get("/disputes/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const dispute = await client.dispute.findFirst({
    where: { id, attempt: { merchantId } },
  });
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  }
  response.json({ dispute });
});

router.post("/disputes/:id/evidence", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ evidence: z.record(z.string().max(64), z.unknown()), notes: z.string().max(4000).optional() }).strict(),
    request.body,
  );
  const dispute = await client.dispute.findFirst({ where: { id, attempt: { merchantId } } });
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  }
  const updated = await client.dispute.update({
    where: { id: dispute.id },
    data: {
      status: "EVIDENCE_SUBMITTED",
      evidenceJson: json({ ...((dispute.evidenceJson as Record<string, unknown> | null) ?? {}), ...body.evidence }),
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/cashouts", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const cashouts = await client.cashoutRequest.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
  });
  response.json({ cashouts });
});

router.post("/cashouts", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        walletId: z.string().min(1).max(64),
        amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
        destinationBank: z.record(z.string().max(64), z.unknown()),
      })
      .strict(),
    request.body,
  );
  const wallet = await client.wallet.findFirst({ where: { id: body.walletId, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  if (decimal(body.amount).lte(0)) {
    throw new ApiError(400, "CASHOUT_AMOUNT_INVALID", "The cash-out amount must be greater than zero");
  }
  const cashout = await client.cashoutRequest.create({
    data: {
      merchantId,
      walletId: wallet.id,
      amount: new Prisma.Decimal(body.amount),
      destinationBankJson: json(body.destinationBank),
      state: "PENDING",
    },
  });
  response.status(201).json({ id: cashout.id, state: cashout.state });
});

router.get("/tokens", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const tokens = await client.accessToken.findMany({
    where: { merchantId },
    include: { ips: true },
  });
  response.json({
    tokens: tokens.map((token) => ({
      id: token.id,
      name: token.name,
      lastFour: token.lastFour,
      scopes: token.scopes,
      ipWhitelistEnabled: token.ipWhitelistEnabled,
      revokedAt: token.revokedAt,
      lastUsedAt: token.lastUsedAt,
      allowedCidrs: token.ips.map((entry) => entry.cidr),
    })),
  });
});

router.post("/tokens", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const principal = principalOf(request);
  const body = parseOrThrow(
    z
      .object({
        name: z.string().min(2).max(120),
        scopes: z.array(z.string().min(2).max(64)).min(1).max(50),
        allowedCidrs: z.array(z.string().min(3).max(64)).max(64).optional(),
        applicationId: z.string().min(1).max(64).optional(),
        expiresAt: z.string().max(64).optional(),
      })
      .strict(),
    request.body,
  );
  const application = body.applicationId
    ? await client.application.findFirst({ where: { id: body.applicationId, merchantId } })
    : await client.application.findFirst({ where: { merchantId } });
  if (!application) {
    throw new ApiError(409, "APPLICATION_REQUIRED", "An application is required to issue an access token");
  }
  const plaintext = generateAccessToken();
  const created = await client.accessToken.create({
    data: {
      merchantId,
      applicationId: application.id,
      name: body.name,
      tokenHash: hashAccessToken(plaintext),
      lastFour: plaintext.slice(-4),
      scopes: body.scopes,
      ipWhitelistEnabled: Boolean(body.allowedCidrs?.length),
      ips: body.allowedCidrs
        ? { create: body.allowedCidrs.map((cidr) => ({ cidr })) }
        : undefined,
    },
  });
  await client.auditLog.create({
    data: {
      actorId: principal.userId ?? created.id,
      role: principal.role ?? "MERCHANT_API",
      action: "ACCESS_TOKEN_CREATED",
      entityType: "ACCESS_TOKEN",
      entityId: created.id,
      beforeJson: {},
      afterJson: { name: created.name, scopes: body.scopes },
    },
  });
  response.status(201).json({
    id: created.id,
    token: plaintext,
    lastFour: created.lastFour,
    warning: "This token is shown once and cannot be retrieved again",
  });
});

router.put("/tokens/:id/ips", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({ allowedCidrs: z.array(z.string().min(3).max(64)).max(64) }).strict(), request.body);
  const token = await client.accessToken.findFirst({ where: { id, merchantId } });
  if (!token) {
    throw new ApiError(404, "ACCESS_TOKEN_NOT_FOUND", "The access token does not exist");
  }
  await client.$transaction(async (tx) => {
    await tx.accessTokenIp.deleteMany({ where: { tokenId: token.id } });
    if (body.allowedCidrs.length > 0) {
      await tx.accessTokenIp.createMany({
        data: body.allowedCidrs.map((cidr) => ({ tokenId: token.id, cidr })),
      });
    }
    await tx.accessToken.update({
      where: { id: token.id },
      data: { ipWhitelistEnabled: body.allowedCidrs.length > 0 },
    });
  });
  response.json({ id: token.id, allowedCidrs: body.allowedCidrs });
});

router.delete("/tokens/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const token = await client.accessToken.findFirst({ where: { id, merchantId } });
  if (!token) {
    throw new ApiError(404, "ACCESS_TOKEN_NOT_FOUND", "The access token does not exist");
  }
  await client.accessToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
  response.json({ id: token.id, revokedAt: new Date().toISOString() });
});

router.get("/credential-sets", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const credentialSets = await client.credentialSet.findMany({
    where: { ownerType: "MERCHANT", ownerMerchantId: merchantId },
    include: { gateway: true },
  });
  response.json({
    credentialSets: credentialSets.map((entry) => ({
      id: entry.id,
      gatewayCode: entry.gateway.code,
      env: entry.env,
      ownerType: entry.ownerType,
      settlementTarget: entry.settlementTarget,
      status: entry.status,
      lastVerifiedAt: entry.lastVerifiedAt,
      expiresAt: entry.expiresAt,
    })),
  });
});

router.post("/credential-sets", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        gatewayCode: z.string().min(2).max(64),
        env: z.enum(["SANDBOX", "LIVE"]),
        externalMerchantId: z.string().min(2).max(120),
        settlementTarget: z.enum(["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]),
        entries: z.array(
          z.object({
            key: z.string().min(1).max(64),
            type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
            value: z.string().max(4096),
            isSecret: z.boolean().default(true),
          }),
        ).min(1).max(40),
      })
      .strict(),
    request.body,
  );
  const gateway = await client.gateway.findUnique({ where: { code: body.gatewayCode } });
  if (!gateway) {
    throw new ApiError(404, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  }
  const encryptedEntries = await Promise.all(
    body.entries.map(async (entry) => ({
      key: entry.key,
      type: entry.type,
      value: entry.isSecret ? await vault.encryptSecret(entry.value, "credential-set") : entry.value,
      isSecret: entry.isSecret,
      secretVersion: 1,
    })),
  );
  const credentialSet = await client.credentialSet.create({
    data: {
      gatewayId: gateway.id,
      env: body.env,
      ownerType: "MERCHANT",
      ownerMerchantId: merchantId,
      externalMerchantId: body.externalMerchantId,
      settlementTarget: body.settlementTarget,
      entriesCiphertext: encryptedEntries,
      status: "UNTESTED",
    },
  });
  response.status(201).json({ id: credentialSet.id, status: credentialSet.status });
});

router.put("/credential-sets/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        entries: z.array(
          z.object({
            key: z.string().min(1).max(64),
            type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
            value: z.string().max(4096),
            isSecret: z.boolean().default(true),
          }),
        ).min(1).max(40),
      })
      .strict(),
    request.body,
  );
  const credentialSet = await client.credentialSet.findFirst({
    where: { id, ownerType: "MERCHANT", ownerMerchantId: merchantId },
  });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  const encryptedEntries = await Promise.all(
    body.entries.map(async (entry) => ({
      key: entry.key,
      type: entry.type,
      value: entry.isSecret ? await vault.encryptSecret(entry.value, "credential-set") : entry.value,
      isSecret: entry.isSecret,
      secretVersion: 2,
    })),
  );
  const updated = await client.credentialSet.update({
    where: { id: credentialSet.id },
    data: { entriesCiphertext: encryptedEntries, status: "UNTESTED" },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/credential-sets/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const credentialSet = await client.credentialSet.findFirst({
    where: { id, ownerType: "MERCHANT", ownerMerchantId: merchantId },
    include: { gateway: true },
  });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  response.json({
    id: credentialSet.id,
    gatewayCode: credentialSet.gateway.code,
    env: credentialSet.env,
    status: credentialSet.status,
    settlementTarget: credentialSet.settlementTarget,
    entries: (credentialSet.entriesCiphertext as Array<{ key: string; type: string; isSecret: boolean }>).map((entry) => ({
      key: entry.key,
      type: entry.type,
      isSecret: entry.isSecret,
      value: entry.isSecret ? "[REDACTED]" : "[WRITE_ONLY]",
    })),
  });
});

router.get("/users", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const users = await client.user.findMany({ where: { merchantId } });
  response.json({
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      authoritiesMap: user.authoritiesMap,
      status: user.status,
      mfaRequired: user.mfaRequired,
    })),
  });
});

router.post("/users", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        email: z.string().email(),
        phone: z.string().min(6).max(20).optional(),
        password: z.string().min(10).max(128),
        role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]),
        authoritiesMap: z.array(z.string().min(2).max(64)).max(50).default([]),
      })
      .strict(),
    request.body,
  );
  const existing = await client.user.findFirst({ where: { email: normalizeEmail(body.email) } });
  if (existing) {
    throw new ApiError(409, "USER_ALREADY_EXISTS", "A user with this email already exists");
  }
  const user = await client.user.create({
    data: {
      merchantId,
      email: normalizeEmail(body.email),
      phone: body.phone ? normalizePhone(body.phone) : null,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      authoritiesMap: body.authoritiesMap,
      mfaRequired: true,
      status: "INVITED",
    },
  });
  response.status(201).json({ id: user.id, email: user.email, role: user.role, status: user.status });
});

router.patch("/users", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        id: z.string().min(1).max(64),
        authoritiesMap: z.array(z.string().min(2).max(64)).max(50).optional(),
        role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
        status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
      })
      .strict(),
    request.body,
  );
  const user = await client.user.findFirst({ where: { id: body.id, merchantId } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  const updated = await client.user.update({
    where: { id: user.id },
    data: {
      authoritiesMap: body.authoritiesMap,
      role: body.role,
      status: body.status,
    },
  });
  response.json({ id: updated.id, role: updated.role, status: updated.status });
});

router.patch("/users/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        authoritiesMap: z.array(z.string().min(2).max(64)).max(50).optional(),
        role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
        status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
      })
      .strict(),
    request.body,
  );
  const user = await client.user.findFirst({ where: { id, merchantId } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  const updated = await client.user.update({
    where: { id: user.id },
    data: {
      authoritiesMap: body.authoritiesMap,
      role: body.role,
      status: body.status,
    },
  });
  response.json({ id: updated.id, role: updated.role, status: updated.status });
});

router.get("/pos/terminals", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const terminals = await client.posTerminal.findMany({
    where: { application: { merchantId } },
    include: { screens: true },
  });
  response.json({ terminals });
});

router.post("/pos/terminals", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(
    z
      .object({
        applicationId: z.string().min(1).max(64),
        name: z.string().min(1).max(120),
        location: z.string().max(200).optional(),
      })
      .strict(),
    request.body,
  );
  const application = await client.application.findFirst({ where: { id: body.applicationId, merchantId } });
  if (!application) {
    throw new ApiError(404, "APPLICATION_NOT_FOUND", "The application does not exist");
  }
  const terminal = await client.posTerminal.create({
    data: {
      applicationId: application.id,
      name: body.name,
      location: body.location,
      status: "ACTIVE",
    },
  });
  response.status(201).json({ id: terminal.id, name: terminal.name, status: terminal.status });
});

router.get("/pos/terminals/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const terminal = await client.posTerminal.findFirst({
    where: { id, application: { merchantId } },
    include: { screens: true },
  });
  if (!terminal) {
    throw new ApiError(404, "POS_TERMINAL_NOT_FOUND", "The POS terminal does not exist");
  }
  response.json({ terminal });
});

router.patch("/pos/terminals/:id", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        name: z.string().min(1).max(120).optional(),
        location: z.string().max(200).optional(),
        status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]).optional(),
      })
      .strict(),
    request.body,
  );
  const terminal = await client.posTerminal.findFirst({ where: { id, application: { merchantId } } });
  if (!terminal) {
    throw new ApiError(404, "POS_TERMINAL_NOT_FOUND", "The POS terminal does not exist");
  }
  const updated = await client.posTerminal.update({
    where: { id: terminal.id },
    data: { name: body.name, location: body.location, status: body.status },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.post("/pos/terminals/:id/screens", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const terminal = await client.posTerminal.findFirst({ where: { id, application: { merchantId } } });
  if (!terminal) {
    throw new ApiError(404, "POS_TERMINAL_NOT_FOUND", "The POS terminal does not exist");
  }
  const screenCode = `scr_${randomBytes(9).toString("base64url")}`;
  const authToken = randomBytes(24).toString("base64url");
  const screen = await client.posScreen.create({
    data: {
      posId: terminal.id,
      screenCode,
      authTokenHash: createHash("sha256").update(authToken).digest("hex"),
      realtimeRoomId: `room_${randomBytes(8).toString("hex")}`,
      lastActiveAt: new Date(),
    },
  });
  response.status(201).json({
    id: screen.id,
    screenCode: screen.screenCode,
    realtimeRoomId: screen.realtimeRoomId,
    authToken,
  });
});

router.get("/pos/screens/:screenCode/stream", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const screenCode = String(request.params.screenCode ?? "");
  const screen = await client.posScreen.findFirst({
    where: { screenCode, pos: { application: { merchantId } } },
  });
  if (!screen) {
    throw new ApiError(404, "POS_SCREEN_NOT_FOUND", "The POS screen does not exist");
  }
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
  const deadline = Date.now() + 15 * 60 * 1000;
  const poll = async (): Promise<void> => {
    if (response.writableEnded || Date.now() > deadline) {
      response.end();
      return;
    }
    await client.posScreen.update({ where: { id: screen.id }, data: { lastActiveAt: new Date() } });
    const attempts = await client.paymentAttempt.findMany({
      where: { application: { merchantId } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    response.write(`event: attempts\ndata: ${JSON.stringify(attempts)}\n\n`);
    setTimeout(() => {
      void poll();
    }, 3000);
  };
  request.on("close", () => response.end());
  await poll();
});

router.get("/stats/overview", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const attempts = await client.paymentAttempt.findMany({
    where: { merchantId, createdAt: { gte: since } },
    select: {
      status: true,
      totalChargedAmount: true,
      platformCommissionAmount: true,
      netMerchantAmount: true,
      currency: true,
      createdAt: true,
    },
  });
  let volume = decimal(0);
  let commission = decimal(0);
  let net = decimal(0);
  const byStatus: Record<string, number> = {};
  for (const attempt of attempts) {
    byStatus[attempt.status] = (byStatus[attempt.status] ?? 0) + 1;
    if (attempt.status === "SUCCEEDED") {
      volume = volume.plus(decimal(attempt.totalChargedAmount));
      commission = commission.plus(decimal(attempt.platformCommissionAmount));
      net = net.plus(decimal(attempt.netMerchantAmount));
    }
  }
  response.json({
    merchantId,
    windowDays: 30,
    attempts: attempts.length,
    byStatus,
    volume: volume.toFixed(4),
    commission: commission.toFixed(4),
    netMerchantAmount: net.toFixed(4),
  });
});

router.post("/external/links", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  if (principal.kind !== "apiToken") {
    throw new ApiError(403, "API_TOKEN_REQUIRED", "An API access token is required for the external API");
  }
  const body = parseOrThrow(linkCreateSchema, request.body);
  const link = await createLink(principal.merchantId as string, body);
  response.status(201).json({
    key: link.key,
    amount: decimal(link.amount).toFixed(4),
    currency: link.currency,
    feeBearer: link.feeBearer,
    state: link.state,
  });
});

router.get("/external/links/:key", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const merchantId = requireMerchantId(principal);
  const key = String(request.params.key ?? "");
  const link = await client.paymentLink.findFirst({
    where: { key, application: { merchantId } },
  });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  response.json({
    key: link.key,
    amount: decimal(link.amount).toFixed(4),
    currency: link.currency,
    state: link.state,
    confirmedCount: link.confirmedCount,
    useCount: link.useCount,
  });
});

router.post("/external/links/:key/cancel", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const merchantId = requireMerchantId(principal);
  const key = String(request.params.key ?? "");
  const link = await client.paymentLink.findFirst({
    where: { key, application: { merchantId } },
  });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  const updated = await client.paymentLink.update({ where: { id: link.id }, data: { state: "CANCELLED" } });
  response.json({ key: updated.key, state: updated.state });
});

router.get("/external/payments/:reference", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  const merchantId = requireMerchantId(principal);
  const reference = String(request.params.reference ?? "");
  const attempt = await client.paymentAttempt.findFirst({
    where: { reference, merchantId },
  });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  }
  response.json({
    reference: attempt.reference,
    status: attempt.status,
    amount: decimal(attempt.totalChargedAmount).toFixed(4),
    currency: attempt.currency,
    createdAt: attempt.createdAt.toISOString(),
  });
});

export const merchantInternalRouter = router;
export { requireMerchantScope };
