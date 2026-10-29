import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { invalidationBus } from "../../lib/invalidationBus";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, listResponse } from "../../lib/listQuery";
import { buildMerchantUserInfo } from "../../lib/auth/uiAuthorities";
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
import { moneyFromDecimal } from "../../engine/db/money";
import { getPlatformRuntime } from "../../engine/runtime";
import type { BeneficialOwnerRow, MerchantRow, Tx } from "../../engine/db/ports";
import {
  MerchantScreeningService,
  type OnboardingScreeningOutcome,
} from "../../engine/guards/MerchantScreeningService";
import { WATCHLIST_SETTING_KEY } from "../../engine/guards/AttemptGuardPipeline";
import { publishWatchlist } from "../../engine/guards/ScreeningProvider";
import { asStringArray, resolveVisibleRails } from "../../engine/flow/VisibleRailsCatalog";
import { json, jsonOptional } from "./json";
import { requireAuthentication, requireMerchantScope, principalOf } from "../middleware/authDoubleCheck";

const router = express.Router();

router.get("/health", (_request, response) => {
  response.json({ status: "ok", channel: "merchant" });
});


const vault = new Vault();

const normalizePhone = (value: string): string => value.replace(/[\s\-().]/g, "").replace(/^218/, "0");
const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/**
 * The upload types accepted for KYB documents (Safeguard 15).
 *
 * The edge validates the file before it forwards it, but core never trusts a
 * header alone: the bytes are sniffed here again.
 */
export const ALLOWED_KYB_UPLOAD_MIMES = ["image/png", "image/jpeg", "application/pdf"] as const;

const UPLOAD_MAGIC_BYTES: ReadonlyArray<{ mime: string; signature: readonly number[] }> = [
  { mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { mime: "application/pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * Detects the type of an uploaded document from its magic bytes. An
 * unrecognised payload returns null, whatever its declared type is.
 */
export const detectUploadMime = (buffer: Buffer): string | null => {
  for (const candidate of UPLOAD_MAGIC_BYTES) {
    if (buffer.byteLength < candidate.signature.length) {
      continue;
    }
    if (candidate.signature.every((byte, index) => buffer[index] === byte)) {
      return candidate.mime;
    }
  }
  return null;
};

/**
 * Double-checks the declared type of an uploaded document against its bytes
 * (defence in depth, Safeguard 15). The returned type is the detected one,
 * which is what gets stored.
 */
export const assertUploadSignature = (
  buffer: Buffer,
  declaredMime: string | undefined,
  allowedMimes: readonly string[] = ALLOWED_KYB_UPLOAD_MIMES,
): string => {
  const normalized = (declaredMime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!allowedMimes.includes(normalized)) {
    throw new ApiError(415, "UNSUPPORTED_UPLOAD_TYPE", "The uploaded document type is not accepted", {
      allowed: [...allowedMimes],
      received: normalized,
    });
  }
  const detected = detectUploadMime(buffer);
  if (!detected) {
    throw new ApiError(
      415,
      "UPLOAD_SIGNATURE_MISMATCH",
      "The uploaded document is not a valid PNG, JPEG or PDF file",
    );
  }
  if (detected !== normalized) {
    throw new ApiError(
      415,
      "UPLOAD_SIGNATURE_MISMATCH",
      "The uploaded document content does not match its declared type",
      { declared: normalized, detected },
    );
  }
  return detected;
};

/**
 * The national identifier of a beneficial owner is stored encrypted. It is
 * decrypted for the screening only; a payload that cannot be decrypted is
 * screened without an identifier instead of failing the whole onboarding.
 */
const decryptOwnerIdentifiers = async (
  owners: readonly BeneficialOwnerRow[],
): Promise<Map<string, string | null>> => {
  const decrypted = new Map<string, string | null>();
  for (const owner of owners) {
    const ciphertext = owner.nationalIdCiphertext;
    if (!ciphertext) {
      decrypted.set(owner.id, null);
      continue;
    }
    try {
      decrypted.set(owner.id, await vault.decryptSecret(ciphertext));
    } catch {
      decrypted.set(owner.id, null);
    }
  }
  return decrypted;
};

/**
 * The onboarding screening (L1).
 *
 * The merchant and its beneficial owners are screened against the watch
 * list, the screening is linked to the join request and a confirmed match
 * raises an AML case and blocks the activation of the merchant.
 */
const runOnboardingScreening = async (
  merchantId: string,
  joinRequestId: string,
): Promise<OnboardingScreeningOutcome> => {
  const platform = getPlatformRuntime(client as never);
  const merchant = await client.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  }
  const owners = await client.beneficialOwner.findMany({ where: { merchantId, active: true } });
  const decryptedOwnerIdentifiers = await decryptOwnerIdentifiers(
    owners as unknown as BeneficialOwnerRow[],
  );
  const service = new MerchantScreeningService({
    repositories: platform.repositories,
    screening: platform.screening,
  });
  return platform.repositories.transaction(async (tx) => {
    // The watch list of the platform is published before the screening, so
    // the screening is run against the list the compliance team maintains
    // and not against the list the process started with.
    await publishPlatformWatchlist(platform, tx);
    return service.submitOnboarding(tx, {
      merchant: merchant as unknown as MerchantRow,
      joinRequestId,
      owners: owners as unknown as BeneficialOwnerRow[],
      decryptedOwnerIdentifiers,
    });
  });
};

/**
 * Publishes the watch list of the platform into the screening provider.
 *
 * The list is a versioned platform setting, so every screening layer reads
 * the published revision. A provider that holds no local list (an external
 * provider, a mock) is left untouched.
 */
const publishPlatformWatchlist = async (
  platform: ReturnType<typeof getPlatformRuntime>,
  tx: Tx,
): Promise<void> => {
  if (!platform.screening.setEntries) {
    return;
  }
  const setting = await platform.repositories.governance.getPlatformSetting(tx, WATCHLIST_SETTING_KEY);
  if (!setting) {
    return;
  }
  publishWatchlist(platform.screening, setting);
  await platform.screening.refreshListVersions?.();
};

/**
 * The four-eyes policy of the join request (design §18 and OD-2).
 *
 * The policy is a versioned platform setting. It is read under the design
 * key `join_request.four_eyes_policy` and under the decision register key
 * `OD-2`, so a deployment that carries only one of the two conventions
 * still gets the configured policy. The policy itself lives in the `policy`
 * field of the value.
 */
export const FOUR_EYES_SETTING_KEYS = ["join_request.four_eyes_policy", "OD-2"] as const;

export type FourEyesPolicy = "ALWAYS" | "RISK_BASED" | "NEVER";

export interface FourEyesPolicySetting {
  policy: FourEyesPolicy;
  ownerThresholdPercent: number;
  highRiskCategories: string[];
}

export interface ParsedFourEyesSetting {
  policy: FourEyesPolicy | null;
  ownerThresholdPercent: number | null;
  highRiskCategories: string[] | null;
}

export const DEFAULT_FOUR_EYES_POLICY: FourEyesPolicy = "RISK_BASED";

/**
 * The beneficial ownership threshold of OD-6: an owner at or above this
 * share is a controlling owner.
 */
export const DEFAULT_OWNER_THRESHOLD_PERCENT = 25;

/**
 * The business categories that are always reviewed by two pairs of eyes.
 */
export const DEFAULT_HIGH_RISK_CATEGORIES = [
  "ADULT",
  "ARMS",
  "CRYPTO",
  "CRYPTO_CURRENCY",
  "GAMBLING",
  "HIGH_VALUE_GOODS",
  "MONEY_TRANSMISSION",
  "P2P",
  "PHARMACEUTICALS",
  "PRECIOUS_METALS",
];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asPolicy = (value: unknown): FourEyesPolicy | null => {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  return raw === "ALWAYS" || raw === "RISK_BASED" || raw === "NEVER" ? raw : null;
};

/**
 * Reads the fields of a four-eyes setting.
 *
 * The seeded shape is `{ policy: "RISK_BASED", ... }`, so the policy is read
 * from the `policy` field of the value. The dotted and the snake case
 * spellings of the threshold and of the category list are accepted too, so
 * a hand written setting is never silently ignored.
 */
export const parseFourEyesSetting = (value: unknown): ParsedFourEyesSetting => {
  if (typeof value === "string") {
    return { policy: asPolicy(value), ownerThresholdPercent: null, highRiskCategories: null };
  }
  const record = asRecord(value);
  const policy = asPolicy(record.policy ?? record.fourEyesPolicy ?? record.value);
  const rawThreshold = record.ownerThresholdPercent ?? record.owner_threshold_percent;
  const threshold = typeof rawThreshold === "number" && Number.isFinite(rawThreshold)
    ? rawThreshold
    : typeof rawThreshold === "string" && rawThreshold.trim().length > 0 && Number.isFinite(Number(rawThreshold))
      ? Number(rawThreshold)
      : null;
  const rawCategories = record.highRiskCategories ?? record.high_risk_categories;
  const categories = Array.isArray(rawCategories)
    ? rawCategories
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim().toUpperCase())
    : null;
  return {
    policy,
    ownerThresholdPercent: threshold,
    highRiskCategories: categories,
  };
};

/**
 * Merges the four-eyes settings into the effective policy.
 *
 * The first setting that carries a value wins, so the canonical key
 * (`join_request.four_eyes_policy`) takes precedence over the decision
 * register key (`OD-2`).
 */
export const resolveFourEyesSetting = (values: readonly unknown[]): FourEyesPolicySetting => {
  const parsed = values.map((value) => parseFourEyesSetting(value));
  return {
    policy: parsed.find((entry) => entry.policy !== null)?.policy ?? DEFAULT_FOUR_EYES_POLICY,
    ownerThresholdPercent:
      parsed.find((entry) => entry.ownerThresholdPercent !== null)?.ownerThresholdPercent
      ?? DEFAULT_OWNER_THRESHOLD_PERCENT,
    highRiskCategories:
      parsed.find((entry) => entry.highRiskCategories !== null)?.highRiskCategories
      ?? DEFAULT_HIGH_RISK_CATEGORIES,
  };
};

export interface FourEyesSubject {
  /** The risk tier of the applicant. */
  riskTier: string | null;
  /** The result of the onboarding screening. */
  screeningResult: string | null;
  /** The lists the screening matched. */
  screeningListTypes: readonly string[];
  /** The beneficial owners of the applicant. */
  owners: ReadonlyArray<{
    ownershipPercent: unknown;
    pepDeclared: boolean;
    screeningStatus: string;
  }>;
  businessCategory: string | null;
  /** The applicant was rejected before. */
  previouslyRejected: boolean;
}

export interface FourEyesDecision {
  policy: FourEyesPolicy;
  required: boolean;
  reasons: string[];
}

/**
 * The four-eyes decision of a join request (design §18, OD-2).
 *
 * Under the default `RISK_BASED` policy a second reviewer is required when
 * the applicant is risky: a high risk tier, a sanctions or PEP screening
 * match, a controlling beneficial owner, an adverse media flag, a high risk
 * business category or a previous rejection. A clean applicant is decided by
 * a single authorized reviewer, so the activation path stays reachable.
 */
export const computeFourEyesDecision = (
  subject: FourEyesSubject,
  setting: FourEyesPolicySetting,
): FourEyesDecision => {
  const reasons: string[] = [];
  if (setting.policy === "ALWAYS") {
    reasons.push("POLICY_ALWAYS");
  } else if (setting.policy !== "NEVER") {
    if ((subject.riskTier ?? "").toUpperCase() === "HIGH") {
      reasons.push("RISK_TIER_HIGH");
    }
    const listTypes = new Set(subject.screeningListTypes.map((entry) => entry.toUpperCase()));
    const screeningResult = (subject.screeningResult ?? "CLEAR").toUpperCase();
    const notClear = screeningResult !== "CLEAR" && screeningResult !== "ERROR";
    if (listTypes.has("SANCTIONS")) {
      reasons.push("SCREENING_SANCTIONS_MATCH");
    }
    if (listTypes.has("PEP")) {
      reasons.push("SCREENING_PEP_MATCH");
    }
    if (listTypes.has("ADVERSE_MEDIA")) {
      reasons.push("SCREENING_ADVERSE_MEDIA_MATCH");
    }
    if (notClear && listTypes.size === 0) {
      reasons.push("SCREENING_NOT_CLEAR");
    }
    const threshold = moneyFromDecimal(String(setting.ownerThresholdPercent));
    for (const owner of subject.owners) {
      const detectedPep = owner.screeningStatus === "POTENTIAL_MATCH" || owner.screeningStatus === "CONFIRMED_MATCH";
      if (owner.pepDeclared || detectedPep) {
        reasons.push("PEP_BENEFICIAL_OWNER");
      }
      if (owner.ownershipPercent !== null && owner.ownershipPercent !== undefined) {
        try {
          if (moneyFromDecimal(owner.ownershipPercent as never) >= threshold) {
            reasons.push("LARGE_OWNERSHIP_SHARE");
          }
        } catch {
          // An ownership share that cannot be read is not a large share.
        }
      }
    }
    const category = (subject.businessCategory ?? "").trim().toUpperCase();
    if (category.length > 0 && setting.highRiskCategories.includes(category)) {
      reasons.push("HIGH_RISK_CATEGORY");
    }
    if (subject.previouslyRejected) {
      reasons.push("PREVIOUSLY_REJECTED");
    }
  }
  const unique = [...new Set(reasons)];
  return {
    policy: setting.policy,
    required: setting.policy === "ALWAYS" ? true : setting.policy === "NEVER" ? false : unique.length > 0,
    reasons: unique,
  };
};

/**
 * Reads the four-eyes policy of the platform.
 */
const readFourEyesSetting = async (): Promise<FourEyesPolicySetting> => {
  const values: unknown[] = [];
  for (const key of FOUR_EYES_SETTING_KEYS) {
    const setting = await client.platformSetting.findFirst({
      where: { key },
      orderBy: { version: "desc" },
    });
    if (setting) {
      values.push(setting.valueJson);
    }
  }
  return resolveFourEyesSetting(values);
};

/**
 * The four-eyes decision of a join request at submission time.
 */
const resolveFourEyesForSubmission = async (
  merchantId: string,
  screening: OnboardingScreeningOutcome,
): Promise<FourEyesDecision> => {
  const [merchant, owners, setting, priorRejection] = await Promise.all([
    client.merchant.findUnique({ where: { id: merchantId } }),
    client.beneficialOwner.findMany({ where: { merchantId, active: true } }),
    readFourEyesSetting(),
    client.joinRequest.findFirst({
      where: { merchantId, status: "REJECTED" },
      select: { id: true },
    }),
  ]);
  const matches = [...screening.report.confirmedMatches, ...screening.report.potentialMatches];
  return computeFourEyesDecision(
    {
      riskTier: merchant?.riskTier ?? null,
      screeningResult: screening.result,
      screeningListTypes: matches.map((match) => match.listType),
      owners: owners.map((owner) => ({
        ownershipPercent: owner.ownershipPercent,
        pepDeclared: owner.pepDeclared,
        screeningStatus: owner.screeningStatus,
      })),
      businessCategory: merchant?.businessCategory ?? null,
      previouslyRejected: priorRejection !== null,
    },
    setting,
  );
};

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

const buildSession = (
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    role: string;
    merchantId: string | null;
    isMaker: boolean;
    isChecker: boolean;
    authoritiesMap: unknown;
    appScopeIds: unknown;
  },
  mfaCompleted: boolean,
): {
  token: string;
  expiresInSeconds: number;
  userInfo: ReturnType<typeof buildMerchantUserInfo>;
  user: Record<string, unknown>;
} => {
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
    mfa: mfaCompleted,
  });
  return {
    token,
    expiresInSeconds: 12 * 60 * 60,
    userInfo: buildMerchantUserInfo(user, authorities, appScopeIds),
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
        // The four-eyes decision is taken at submission time, when the risk
        // of the applicant is known (design §18, OD-2). A draft request
        // carries no decision yet.
        fourEyesRequired: false,
        fourEyesReasons: [],
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
  response.json(buildSession(user, false));
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
  response.json(buildSession(user, true));
});

router.get("/auth/me", (_request: Request, response: Response) => {
  response.json({
    platformName: "Payment Gateway",
    version: process.env.GIT_COMMIT?.slice(0, 12) ?? "dev",
    suspended: false,
  });
});

router.use(requireAuthentication);

const OPTION_LIMIT = 100;

router.get("/options/:kind", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const kind = String(request.params.kind ?? "");
  const rawSearch = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const limit = Math.min(OPTION_LIMIT, Math.max(1, Number(request.query.limit ?? 50) || 50));
  const contains = rawSearch ? { contains: rawSearch } : undefined;
  let items: Array<{ value: string; title: string; subtitle?: string }> = [];

  switch (kind) {
    case "applications": {
      const rows = await client.application.findMany({ where: { merchantId, ...(rawSearch ? { name: contains! } : {}) }, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, status: true } });
      items = rows.map((row) => ({ value: row.id, title: row.name, subtitle: row.status }));
      break;
    }
    case "wallets": {
      const rows = await client.wallet.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, currency: true, status: true } });
      items = rows.map((row) => ({ value: row.id, title: `${row.currency} · ${row.id.slice(0, 8)}`, subtitle: row.status }));
      break;
    }
    case "users": {
      const rows = await client.user.findMany({ where: { merchantId, ...(rawSearch ? { OR: [{ email: contains! }, { phone: contains! }] } : {}) }, orderBy: { email: "asc" }, take: limit, select: { id: true, email: true, role: true } });
      items = rows.map((row) => ({ value: row.id, title: row.email, subtitle: row.role }));
      break;
    }
    case "rails": {
      const rows = await client.paymentAttempt.findMany({ where: { merchantId }, select: { railId: true, rail: { select: { code: true, nameEn: true } } }, distinct: ["railId"], take: 200 });
      const seen = new Set<string>();
      for (const row of rows) {
        const code = row.rail?.code ?? "";
        if (!code || seen.has(code) || (rawSearch && !code.toLowerCase().includes(rawSearch.toLowerCase()) && !(row.rail?.nameEn ?? "").toLowerCase().includes(rawSearch.toLowerCase()))) continue;
        seen.add(code);
        items.push({ value: row.railId, title: `${row.rail?.nameEn ?? code} (${code})` });
        if (items.length >= limit) break;
      }
      break;
    }
    case "gateways": {
      const rows = await client.credentialSet.findMany({ where: { ownerType: "MERCHANT", ownerMerchantId: merchantId }, select: { gatewayId: true, gateway: { select: { code: true, name: true } } }, distinct: ["gatewayId"], take: 100 });
      items = rows
        .filter((row) => !rawSearch || (row.gateway?.code ?? "").toLowerCase().includes(rawSearch.toLowerCase()) || (row.gateway?.name ?? "").toLowerCase().includes(rawSearch.toLowerCase()))
        .slice(0, limit)
        .map((row) => ({ value: row.gatewayId, title: `${row.gateway?.name ?? ""} (${row.gateway?.code ?? ""})` }));
      break;
    }
    case "credential-sets": {
      const rows = await client.credentialSet.findMany({ where: { ownerType: "MERCHANT", ownerMerchantId: merchantId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, env: true, gateway: { select: { code: true } } } });
      items = rows.map((row) => ({ value: row.id, title: `${row.gateway.code} · ${row.env}` }));
      break;
    }
    default:
      throw new ApiError(400, "UNKNOWN_OPTION_KIND", "Unknown option kind");
  }
  response.json({ items, total: items.length });
});


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
  const declaredMime = typeof request.headers["x-upload-content-type"] === "string"
    ? (request.headers["x-upload-content-type"] as string)
    : undefined;
  // The declared MIME is never trusted on its own: the magic bytes decide the
  // stored type, and a mismatch is rejected (Safeguard 15).
  const mime = assertUploadSignature(raw, declaredMime);
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

  // The onboarding screening (L1) screens the merchant and its beneficial
  // owners. A confirmed match raises an AML case and blocks the activation.
  const screening = await runOnboardingScreening(merchantId, joinRequest.id);
  // An unavailable screening is never a clean result: the submission is
  // refused and the join request stays in review (design §20, edge case 124).
  if (screening.result === "ERROR") {
    throw new ApiError(
      503,
      "SCREENING_UNAVAILABLE",
      "The AML screening provider is unavailable; the onboarding request cannot be submitted",
      {
        screeningId: screening.screeningId,
        joinRequestStatus: screening.joinRequestStatus,
      },
    );
  }
  if (screening.blocked) {
    throw new ApiError(
      403,
      "AML_CONFIRMED_MATCH",
      "The onboarding screening produced a confirmed watch list match",
      {
        screeningId: screening.screeningId,
        amlCaseId: screening.amlCaseId,
      },
    );
  }

  // The four-eyes policy (design §18, OD-2) is evaluated at submission time:
  // a risky applicant needs a second pair of eyes, a clean one is decided by
  // a single authorized reviewer.
  const fourEyes = await resolveFourEyesForSubmission(merchantId, screening);
  const submitted = await client.joinRequest.update({
    where: { id: joinRequest.id },
    data: {
      fourEyesRequired: fourEyes.required,
      fourEyesReasons: fourEyes.reasons,
    },
  });

  response.json({
    id: joinRequest.id,
    status: screening.joinRequestStatus,
    slaDueAt: joinRequest.slaDueAt,
    screeningId: screening.screeningId,
    screeningResult: screening.result,
    fourEyesRequired: submitted.fourEyesRequired,
    fourEyesReasons: submitted.fourEyesReasons ?? [],
    fourEyesPolicy: fourEyes.policy,
  });
});

router.get("/wallets", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    in: { status: "status" }, equals: {currency: "currency"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { currency: "currency", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [wallets, total] = await Promise.all([
    client.wallet.findMany({ where, orderBy: built.orderBy as never, include: { glAccount: true }, skip: built.skip, take: built.take }),
    client.wallet.count({ where }),
  ]);
  response.json(listResponse("wallets", wallets, total, built));
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
  const built = buildListQuery(request.query, {
    search: ["name", "businessUseDescription"],
    in: { status: "status" }, equals: {assignedWalletId: "assignedWalletId"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "name", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [applications, total] = await Promise.all([
    client.application.findMany({ where, orderBy: built.orderBy as never, include: { assignedWallet: true }, skip: built.skip, take: built.take }),
    client.application.count({ where }),
  ]);
  response.json(listResponse("applications", applications, total, built));
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
  const merchant = await client.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) {
    throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
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
  // The rails of the new link are resolved with the same formula as the
  // checkout, so the daily cap of the current business day is already
  // applied when the link is created.
  const visible = await resolveVisibleRails(client as never, {
    application: {
      id: application.id,
      merchantId,
      riskTier: merchant.riskTier,
      railWhitelist: asStringArray(application.railWhitelist),
    },
    link: {
      amount: link.amount,
      currency: link.currency,
      railWhitelist: asStringArray(link.railWhitelist),
    },
    channel: "WEB",
    env: merchant.status === "ACTIVE" ? "LIVE" : "SANDBOX",
  });
  return { link, visible };
};

router.get("/links", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const rawState = typeof request.query.state === "string" ? request.query.state : undefined;
  const state = rawState === "ACTIVE" ? "PENDING" : rawState;
  const built = buildListQuery(request.query, {
    search: ["key", "description"],
    equals: { applicationId: "applicationId", walletId: "walletId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" }, expiresAt: { path: "expiresAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { linkKey: "key", amount: "amount", useCount: "useCount", status: "state", expiresAt: "expiresAt", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, application: { merchantId }, ...(state ? { state } : {}), ...built.where } as never;
  const [links, total] = await Promise.all([
    client.paymentLink.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.paymentLink.count({ where }),
  ]);
  response.json(listResponse("links", links, total, built));
});

router.post("/links", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(linkCreateSchema, request.body);
  const { link, visible } = await createLink(merchantId, body);
  response.status(201).json({
    id: link.id,
    key: link.key,
    amount: decimal(link.amount).toFixed(4),
    currency: link.currency,
    feeBearer: link.feeBearer,
    state: link.state,
    visibleRails: visible.rails.map((entry) => entry.rail.code),
    excludedRails: visible.excluded,
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
  const built = buildListQuery(request.query, {
    search: ["reference"],
    in: { status: "status" }, equals: {railId: "railId", applicationId: "applicationId"},
    ranges: {
      amount: { path: "totalChargedAmount", kind: "decimal" },
      commission: { path: "platformCommissionAmount", kind: "decimal" },
      net: { path: "netMerchantAmount", kind: "decimal" },
    },
    dates: { createdAt: { path: "createdAt" }, confirmedAt: { path: "confirmedAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { reference: "reference", amount: "totalChargedAmount", status: "status", createdAt: "createdAt", confirmedAt: "confirmedAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [payments, total] = await Promise.all([
    client.paymentAttempt.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.paymentAttempt.count({ where }),
  ]);
  response.json(listResponse("payments", payments, total, built));
});

router.get("/disputes", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const attempts = await client.paymentAttempt.findMany({ where: { merchantId, status: "DISPUTED" }, select: { id: true } });
  const built = buildListQuery(request.query, {
    search: ["disputeRef", "reasonCode"],
    in: { status: "status" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "openedAt" }, evidenceDueAt: { path: "evidenceDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { disputeRef: "disputeRef", status: "status", amount: "amount", evidenceDueAt: "evidenceDueAt" },
    defaultSort: { openedAt: "desc" },
  });
  const where = { attemptId: { in: attempts.map((attempt) => attempt.id) }, ...built.where } as never;
  const [disputes, total] = await Promise.all([
    client.dispute.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.dispute.count({ where }),
  ]);
  response.json(listResponse("disputes", disputes.map((entry) => ({ ...entry, state: entry.status })), total, built));
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
      evidenceJson: json({ ...(dispute.evidenceJson as Record<string, unknown> | null), ...body.evidence }),
    },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/cashouts", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    search: ["walletId"],
    in: { state: "state" }, equals: {walletId: "walletId"},
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { state: "state", amount: "amount", requestedAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [cashouts, total] = await Promise.all([
    client.cashoutRequest.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.cashoutRequest.count({ where }),
  ]);
  response.json(listResponse("cashouts", cashouts.map((entry) => ({ ...entry, requestedAt: entry.createdAt })), total, built));
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
  const rawRevoked = typeof request.query.revoked === "string" ? request.query.revoked : undefined;
  const built = buildListQuery(request.query, {
    search: ["name", "lastFour"],
    booleans: { ipWhitelistEnabled: "ipWhitelistEnabled" },
    dates: { createdAt: { path: "createdAt" }, lastUsedAt: { path: "lastUsedAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { name: "name", lastUsedAt: "lastUsedAt", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = {
    merchantId,
    ...built.where,
    ...(rawRevoked === "true" ? { revokedAt: { not: null } } : rawRevoked === "false" ? { revokedAt: null } : {}),
  } as never;
  const [tokens, total] = await Promise.all([
    client.accessToken.findMany({ where, orderBy: built.orderBy as never, include: { ips: true }, skip: built.skip, take: built.take }),
    client.accessToken.count({ where }),
  ]);
  response.json(listResponse("tokens", tokens.map((token) => ({
    id: token.id,
    name: token.name,
    lastFour: token.lastFour,
    scopes: token.scopes,
    ipWhitelistEnabled: token.ipWhitelistEnabled,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    allowedCidrs: token.ips.map((entry) => entry.cidr),
  })), total, built));
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
  const built = buildListQuery(request.query, {
    search: ["externalMerchantId", "gateway.code"],
    in: { status: "status" }, equals: {gatewayCode: "gateway.code", env: "env", settlementTarget: "settlementTarget",},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { gatewayCode: "gatewayId", env: "env", status: "status" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { ownerType: "MERCHANT", ownerMerchantId: merchantId, ...built.where } as never;
  const [credentialSets, total] = await Promise.all([
    client.credentialSet.findMany({ where, orderBy: built.orderBy as never, include: { gateway: true }, skip: built.skip, take: built.take }),
    client.credentialSet.count({ where }),
  ]);
  response.json(listResponse("credentialSets", credentialSets.map((entry) => ({
    id: entry.id,
    gatewayCode: entry.gateway.code,
    env: entry.env,
    ownerType: entry.ownerType,
    settlementTarget: entry.settlementTarget,
    status: entry.status,
    lastVerifiedAt: entry.lastVerifiedAt,
    expiresAt: entry.expiresAt,
  })), total, built));
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
  await invalidationBus.invalidateCredential(credentialSet.id, "credential-set-created");
  // The credential check runs as soon as the merchant registers the
  // credentials, so a set that works is trusted (and a route that needs it
  // becomes visible) without an operator in the loop.
  const verification = await getPlatformRuntime(client as never).credentialCheck.verify(credentialSet.id);
  await invalidationBus.invalidateCredential(credentialSet.id, "credential-set-verified");
  response.status(201).json({
    id: credentialSet.id,
    status: verification.status,
    verification: {
      status: verification.status,
      method: verification.method,
      reason: verification.reason ?? null,
    },
  });
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
  // Any cached outbound consumer for this credential set must be evicted so
  // that the rotated secret is used from now on.
  await invalidationBus.invalidateCredential(updated.id, "credential-set-rotated");
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
    lastVerifiedAt: credentialSet.lastVerifiedAt,
    entries: (credentialSet.entriesCiphertext as Array<{ key: string; type: string; isSecret: boolean }>).map((entry) => ({
      key: entry.key,
      type: entry.type,
      isSecret: entry.isSecret,
      value: entry.isSecret ? "[REDACTED]" : "[WRITE_ONLY]",
    })),
  });
});

/**
 * Runs the credential check of a credential set (design v5 §16.2).
 *
 * The merchant proves that the credentials it registered work; the platform
 * records the verdict on the credential set (`VERIFIED` with the
 * verification time, or `FAILING`).
 */
router.post("/credential-sets/:id/verify", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const credentialSet = await client.credentialSet.findFirst({
    where: { id, ownerType: "MERCHANT", ownerMerchantId: merchantId },
  });
  if (!credentialSet) {
    throw new ApiError(404, "CREDENTIAL_SET_NOT_FOUND", "The credential set does not exist");
  }
  const platform = getPlatformRuntime(client as never);
  const result = await platform.credentialCheck.verify(id);
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

router.get("/users", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    search: ["email", "phone"],
    in: { status: "status" }, equals: {role: "role",},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { email: "email", role: "role", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [users, total] = await Promise.all([
    client.user.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.user.count({ where }),
  ]);
  response.json(listResponse("users", users.map((user) => ({
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    authoritiesMap: user.authoritiesMap,
    status: user.status,
    mfaRequired: user.mfaRequired,
  })), total, built));
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
  const built = buildListQuery(request.query, {
    search: ["name", "location"],
    in: { status: "status" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "name", location: "location", status: "status" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { application: { merchantId }, ...built.where } as never;
  const [terminals, total] = await Promise.all([
    client.posTerminal.findMany({ where, orderBy: built.orderBy as never, include: { screens: true }, skip: built.skip, take: built.take }),
    client.posTerminal.count({ where }),
  ]);
  response.json(listResponse("terminals", terminals, total, built));
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
  const period = String(request.query.period ?? "last_30d");
  const days = period === "last_7d" ? 7 : period === "last_90d" ? 90 : 30;
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const attempts = await client.paymentAttempt.findMany({
    where: { merchantId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      reference: true,
      status: true,
      totalChargedAmount: true,
      platformCommissionAmount: true,
      netMerchantAmount: true,
      currency: true,
      createdAt: true,
      rail: { select: { code: true } },
    },
  });

  let volume = decimal(0);
  let commission = decimal(0);
  let net = decimal(0);
  let todayVolume = decimal(0);
  const byStatus: Record<string, number> = {};
  const dayTotals = new Map<string, { gross: ReturnType<typeof decimal>; commission: ReturnType<typeof decimal>; net: ReturnType<typeof decimal> }>();
  const railTotals = new Map<string, { gross: ReturnType<typeof decimal>; count: number }>();

  for (const attempt of attempts) {
    byStatus[attempt.status] = (byStatus[attempt.status] ?? 0) + 1;
    if (attempt.status !== "SUCCEEDED") {
      continue;
    }
    const gross = decimal(attempt.totalChargedAmount);
    const commissionAmount = decimal(attempt.platformCommissionAmount);
    const netAmount = decimal(attempt.netMerchantAmount);
    volume = volume.plus(gross);
    commission = commission.plus(commissionAmount);
    net = net.plus(netAmount);
    if (attempt.createdAt >= startOfDay) {
      todayVolume = todayVolume.plus(gross);
    }

    const day = attempt.createdAt.toISOString().slice(0, 10);
    const dayEntry = dayTotals.get(day) ?? { gross: decimal(0), commission: decimal(0), net: decimal(0) };
    dayTotals.set(day, {
      gross: dayEntry.gross.plus(gross),
      commission: dayEntry.commission.plus(commissionAmount),
      net: dayEntry.net.plus(netAmount),
    });

    const railCode = attempt.rail?.code ?? "UNKNOWN";
    const railEntry = railTotals.get(railCode) ?? { gross: decimal(0), count: 0 };
    railTotals.set(railCode, { gross: railEntry.gross.plus(gross), count: railEntry.count + 1 });
  }

  const [wallets, pendingCashouts] = await Promise.all([
    client.wallet.findMany({
      where: { merchantId },
      select: { currency: true, glAccount: { select: { checkpointBalance: true } } },
    }),
    client.cashoutRequest.count({ where: { merchantId, state: { in: ["PENDING", "PROCESSING"] } } }),
  ]);

  const walletBalance = wallets.reduce(
    (total, wallet) => total.plus(decimal(wallet.glAccount?.checkpointBalance ?? 0)),
    decimal(0),
  );
  const currency = wallets[0]?.currency ?? attempts[0]?.currency ?? "LYD";
  const succeeded = byStatus.SUCCEEDED ?? 0;
  const successRate = attempts.length > 0 ? ((succeeded / attempts.length) * 100).toFixed(2) : "0.00";

  response.json({
    merchantId,
    period,
    windowDays: days,
    attempts: attempts.length,
    byStatus,
    volume: volume.toFixed(4),
    commission: commission.toFixed(4),
    netMerchantAmount: net.toFixed(4),
    currency,
    walletBalance: walletBalance.toFixed(4),
    todayVolume: todayVolume.toFixed(4),
    successRate,
    pendingCashouts: String(pendingCashouts),
    recentPayments: attempts.slice(0, 6).map((attempt) => ({
      id: attempt.id,
      reference: attempt.reference,
      railCode: attempt.rail?.code ?? "UNKNOWN",
      amount: decimal(attempt.totalChargedAmount).toFixed(4),
      currency: attempt.currency,
      status: attempt.status,
      createdAt: attempt.createdAt.toISOString(),
    })),
    volumeByDay: [...dayTotals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({
        day,
        gross: totals.gross.toFixed(4),
        commission: totals.commission.toFixed(4),
        net: totals.net.toFixed(4),
      })),
    volumeByRail: [...railTotals.entries()].map(([railCode, totals]) => ({
      railCode,
      gross: totals.gross.toFixed(4),
      count: totals.count,
    })),
  });
});

router.post("/external/links", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  if (principal.kind !== "apiToken") {
    throw new ApiError(403, "API_TOKEN_REQUIRED", "An API access token is required for the external API");
  }
  const body = parseOrThrow(linkCreateSchema, request.body);
  const { link, visible } = await createLink(principal.merchantId as string, body);
  response.status(201).json({
    key: link.key,
    amount: decimal(link.amount).toFixed(4),
    currency: link.currency,
    feeBearer: link.feeBearer,
    state: link.state,
    visibleRails: visible.rails.map((entry) => entry.rail.code),
    excludedRails: visible.excluded,
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
