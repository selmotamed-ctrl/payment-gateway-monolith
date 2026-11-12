import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import * as ipaddr from "ipaddr.js";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { assertCommerceActive, assertPosTerminalActive } from "../../lib/commerceStatus";
import { invalidationBus } from "../../lib/invalidationBus";
import { ApiError, parseOrThrow } from "../../lib/error";
import { detectDuplicateFlags, nationalIdHash, payoutAccountHash } from "../../lib/joinRequestOnboarding";
import { payoutOwnerMismatch } from "../../lib/kybReview";
import { queueKybNotification } from "../../lib/kybNotifications";
import { scanKybBytes } from "../../lib/kybScan";
import { buildListQuery, countUnlessSkipped, listResponse } from "../../lib/listQuery";
import { buildMerchantUserInfo } from "../../lib/auth/uiAuthorities";
import { generateAccessToken, hashAccessToken, hashPassword, signSession, verifyPasswordOrDummy } from "../../lib/auth";
import { issueMfaChallenge, verifyMfaChallenge } from "../../lib/auth/mfaChallenges";
import {
  assertLoginAllowed,
  assertMfaAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  recordMfaFailure,
} from "../../lib/auth/throttle";
import {
  assertGrantableMerchantAuthorities,
  assertGrantableMerchantRole,
  assertKnownMerchantAuthorities,
  assertKnownTokenScopes,
  assertMerchantAuthority,
  normalizeTokenScopes,
} from "../../lib/auth/merchantAuthorities";
import { lockWalletLedgerBalance, openCashoutTotal } from "../../lib/cashoutBalance";
import { Vault } from "../../engine/crypto/Vault";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { loadAccountCheckpointSummary, loadLiveAccountBalances, naturalShardBalance } from "../../lib/storageEngine/shardBalances";
import { moneyFromDecimal } from "../../engine/db/money";
import { getPlatformRuntime } from "../../engine/runtime";
import { readThroughReplicaOrPrimary } from "../../lib/storageEngine";
import type { BeneficialOwnerRow, MerchantRow, Tx } from "../../engine/db/ports";
import {
  MerchantScreeningService,
  type OnboardingScreeningOutcome,
} from "../../engine/guards/MerchantScreeningService";
import { WATCHLIST_SETTING_KEY } from "../../engine/guards/AttemptGuardPipeline";
import { publishWatchlist } from "../../engine/guards/ScreeningProvider";
import { asStringArray, resolveVisibleRails } from "../../engine/flow/VisibleRailsCatalog";
import { json, jsonOptional } from "./json";
import { merchantReportEngineRouter } from "./merchantReportEngine";
import {
  clientIp,
  principalOf,
  requireAuthentication,
  revokePrincipalSession,
  requireMerchantPrincipal,
  requireMerchantScope,
} from "../middleware/authDoubleCheck";
import { publishRealtimePos, subscribeRealtimeAttempt, subscribeRealtimePos } from "../../lib/realtimeBus";
import { writeAudit } from "../../lib/audit/writeAudit";
import { getObjectStorageSdk } from "../../lib/objectStorageSdk/runtime";
import { env } from "../../lib/env";
import { WebhookEndpointService } from "../../engine/webhooks/WebhookEndpointService";
import { WEBHOOK_EVENT_TYPES, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS } from "../../engine/webhooks/events";

const router = express.Router();

router.get("/health", (_request, response) => {
  response.json({ status: "ok", channel: "merchant", release: process.env.APP_RELEASE ?? null, commit: process.env.APP_COMMIT ?? null });
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
export const runOnboardingScreening = async (
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
  /** Expected monthly volume from the onboarding profile. */
  expectedMonthlyVolume?: unknown;
  /** The configured review threshold, when one is set. */
  volumeThreshold?: number | null;
  /** The payout account holder differs from the merchant legal/trade name. */
  payoutOwnerMismatch?: boolean;
  /** A duplicate/related-party flag was raised at submission. */
  duplicateOrRelated?: boolean;
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
    if (subject.duplicateOrRelated) {
      reasons.push("DUPLICATE_OR_RELATED");
    }
    if (subject.payoutOwnerMismatch) {
      reasons.push("PAYOUT_ACCOUNT_OWNERSHIP_MISMATCH");
    }
    const volumeThreshold = Number(subject.volumeThreshold);
    const expectedVolume = Number(subject.expectedMonthlyVolume);
    if (
      Number.isFinite(volumeThreshold)
      && volumeThreshold > 0
      && Number.isFinite(expectedVolume)
      && expectedVolume > volumeThreshold
    ) {
      reasons.push("VOLUME_ABOVE_THRESHOLD");
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
 * Reads the expected-volume threshold of the four-eyes policy. A value may be
 * a number, a numeric string or an object carrying `amount`.
 */
const readVolumeThreshold = async (): Promise<number | null> => {
  const setting = await client.platformSetting.findFirst({
    where: { key: "join_request.volume_threshold" },
    orderBy: { version: "desc" },
  });
  const value = setting?.valueJson;
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).amount ?? (value as Record<string, unknown>).value
    : value;
  const threshold = Number(raw);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
};

/**
 * The four-eyes decision of a join request at submission time.
 */
export const resolveFourEyesForSubmission = async (
  merchantId: string,
  screening: OnboardingScreeningOutcome,
  joinRequestId?: string,
): Promise<FourEyesDecision> => {
  const [merchant, owners, setting, priorRejection, joinRequest, volumeThreshold] = await Promise.all([
    client.merchant.findUnique({ where: { id: merchantId } }),
    client.beneficialOwner.findMany({ where: { merchantId, active: true } }),
    readFourEyesSetting(),
    client.joinRequest.findFirst({
      where: { merchantId, status: "REJECTED" },
      select: { id: true },
    }),
    joinRequestId
      ? client.joinRequest.findUnique({ where: { id: joinRequestId } })
      : client.joinRequest.findFirst({ where: { merchantId }, orderBy: { createdAt: "desc" } }),
    readVolumeThreshold(),
  ]);
  const matches = [...screening.report.confirmedMatches, ...screening.report.potentialMatches];
  const profile = joinRequest?.profileJson && typeof joinRequest.profileJson === "object" && !Array.isArray(joinRequest.profileJson)
    ? (joinRequest.profileJson as Record<string, unknown>)
    : {};
  const duplicateFlags = Array.isArray(joinRequest?.duplicateFlagsJson) ? joinRequest.duplicateFlagsJson : [];
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
      expectedMonthlyVolume: profile.expectedMonthlyVolume,
      volumeThreshold,
      payoutOwnerMismatch: payoutOwnerMismatch({
        payoutBankDetails: merchant?.payoutBankDetailsJson,
        legalName: merchant?.legalName,
        tradeName: merchant?.tradeName,
      }),
      duplicateOrRelated: duplicateFlags.length > 0,
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

/**
 * Columns a merchant list may return for a payment attempt. Lists never load
 * `context_ciphertext` (encrypted flow context), the masked customer fields
 * JSON, gateway public outputs, the raw wire amount or the payer IP / user
 * agent: they are wide, unused by the portal and must not leave core-back.
 */
const merchantAttemptListSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  reference: true,
  linkId: true,
  applicationId: true,
  merchantId: true,
  railId: true,
  routeId: true,
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
  expiresAt: true,
  terminalAt: true,
} as const;

/** [from, to) of a YYYY-MM month in UTC. */
const monthRangeUtc = (month: string): { from: Date; to: Date } => {
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  return {
    from: new Date(Date.UTC(year, monthIndex - 1, 1)),
    to: new Date(Date.UTC(year, monthIndex, 1)),
  };
};

const merchantIdOf = (request: Request): string => {
  const principal = principalOf(request);
  if (!principal.merchantId) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "The principal is not bound to a merchant");
  }
  return principal.merchantId;
};

/** Audit helper for merchant-session actions (these routes are never reachable with an API token). */
const auditMerchantAction = async (
  db: unknown,
  request: Request,
  entry: { action: string; entityType: string; entityId: string; before?: Record<string, unknown>; after?: Record<string, unknown> },
): Promise<void> => {
  const principal = principalOf(request);
  await writeAudit(db, {
    data: {
      actorId: principal.userId as string,
      role: principal.role ?? "MERCHANT_ADMIN",
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: entry.before ?? {},
      afterJson: entry.after ?? {},
    },
  });
};

/**
 * The applications a scoped merchant user (`app_scope_ids`) may touch, or `null` when the user is
 * not scoped. API tokens are bound to one application by the token itself.
 */
const appScopeOf = (request: Request): readonly string[] | null => {
  const principal = principalOf(request);
  if (principal.kind !== "session") return null;
  const ids = principal.appScopeIds ?? [];
  return ids.length > 0 ? ids : null;
};

/** 403 when a scoped user addresses an application outside their scope. */
const assertApplicationInScope = (request: Request, applicationId: string | null | undefined): void => {
  const scope = appScopeOf(request);
  if (scope && (!applicationId || !scope.includes(applicationId))) {
    throw new ApiError(
      403,
      "APP_SCOPE_VIOLATION",
      "The principal is restricted to specific applications and this one is not among them",
    );
  }
};

/** Narrows a Prisma `where` to the user's applications (a no-op for an unscoped principal). */
const withAppScope = (request: Request, where: Record<string, unknown>, field = "applicationId"): never => {
  const scope = appScopeOf(request);
  return (scope ? { AND: [where, { [field]: { in: [...scope] } }] } : where) as never;
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
  }, "merchant");
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

// The phone-only verify-identity entrypoint is retired. It accepted any code, marked the
// identity verified and returned a challenge that /auth/mfa/verify exchanged for a full
// session: an account takeover from a phone number. The response is identical for every
// phone number so it can no longer be used to enumerate accounts. Identity verification
// happens through the authenticated onboarding flow; sign-in is password then MFA.
router.post("/auth/verify-identity", async (request: Request, _response: Response) => {
  parseOrThrow(verifyIdentitySchema, request.body);
  throw new ApiError(
    410,
    "IDENTITY_VERIFICATION_RETIRED",
    "Phone-only identity verification is no longer available. Sign in with your password and verification code",
  );
});

router.post("/auth/accept-invitation", async (request: Request, response: Response) => {
  const body = parseOrThrow(
    z.object({
      token: z.string().min(16).max(256),
      password: z.string().min(10).max(128),
    }).strict(),
    request.body,
  );
  const tokenHash = createHash("sha256").update(body.token).digest("hex");
  const user = await client.user.findFirst({
    where: {
      invitationTokenHash: tokenHash,
      status: "INVITED",
      invitationExpiresAt: { gt: new Date() },
    },
  });
  if (!user) {
    throw new ApiError(400, "INVITATION_INVALID", "The invitation is invalid or has expired");
  }
  const passwordHash = await hashPassword(body.password);
  await client.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        status: "ACTIVE",
        passwordHash,
        invitationTokenHash: null,
        invitationExpiresAt: null,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: user.id,
        role: user.role,
        action: "MERCHANT_INVITATION_ACCEPTED",
        entityType: "USER",
        entityId: user.id,
        beforeJson: { status: "INVITED" },
        afterJson: { status: "ACTIVE" },
      },
    });
  });
  response.json({ status: "ACTIVE", userId: user.id, merchantId: user.merchantId, loginRequired: true });
});

router.post("/auth/login", async (request: Request, response: Response) => {
  const body = parseOrThrow(loginSchema, request.body);
  const identifier = body.identifier.includes("@")
    ? normalizeEmail(body.identifier)
    : normalizePhone(body.identifier);
  const ip = clientIp(request);
  await assertLoginAllowed(identifier, ip);
  const found = identifier.includes("@")
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
  // Staff principals never authenticate on the merchant channel; they get the same
  // answer as an unknown user.
  const user = found && found.merchantId !== null && String(found.role).startsWith("MERCHANT_") ? found : null;
  const valid = await verifyPasswordOrDummy(body.password, user?.passwordHash);
  if (!user || !valid) {
    await recordLoginFailure(identifier, ip);
    throw new ApiError(401, "INVALID_CREDENTIALS", "The supplied credentials are not valid");
  }
  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "The account is not active");
  }
  await recordLoginSuccess(identifier, ip);
  if (user.mfaRequired) {
    const { challengeId } = await client.$transaction((tx) =>
      issueMfaChallenge(tx as never, {
        userId: user.id,
        channel: "MERCHANT",
        phone: user.phone,
        phoneLast4: (user.phone ?? "").slice(-4),
        ip,
      }),
    );
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
  const ip = clientIp(request);
  await assertMfaAllowed(ip);
  // Not wrapped in a transaction: a wrong guess must persist its attempt counter.
  let verified;
  try {
    verified = await verifyMfaChallenge(client as never, {
      challengeId: body.challengeId,
      code: body.code,
      channel: "MERCHANT",
    });
  } catch (error) {
    await recordMfaFailure(ip);
    throw error;
  }
  const user = await client.user.findUnique({ where: { id: verified.userId } });
  if (!user || user.status !== "ACTIVE" || user.merchantId === null || !String(user.role).startsWith("MERCHANT_")) {
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
// Principal-type separation: staff never reach a merchant route, and an API token only
// reaches the external API (it can never manage users, tokens or its own IP allowlist).
router.use(requireMerchantPrincipal);

/** Server-side logout (GAP-019): puts the presented session on the revoke list. */
router.post("/auth/logout", async (request: Request, response: Response) => {
  await revokePrincipalSession(request);
  response.json({ revoked: true });
});
router.use((request, _response, next) => {
  const principal = principalOf(request);
  if (principal.kind === "apiToken" && !request.path.startsWith("/external/")) {
    next(new ApiError(403, "API_TOKEN_SCOPE_VIOLATION", "API access tokens can only call the external API"));
    return;
  }
  next();
});
// The report-engine router paths already start with `/report-engine`.
router.use(merchantReportEngineRouter);

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
  assertMerchantAuthority(principalOf(request), ["onboarding:write"]);
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

router.get("/onboarding/kyb-revalidations", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const requests = await client.kybRevalidationRequest.findMany({
    where: { merchantId },
    orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
    include: {
      sourceDocument: { select: { id: true, docType: true, originalFileName: true, status: true, expiresOn: true } },
      fulfilledDocument: { select: { id: true, docType: true, status: true, avStatus: true } },
    },
  });
  response.json({ revalidations: requests });
});

router.post("/onboarding/kyb-documents", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["onboarding:write"]);
  const merchantId = merchantIdOf(request);
  const principal = principalOf(request);
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (raw.byteLength === 0) {
    throw new ApiError(400, "UPLOAD_REQUIRED", "A KYB document payload is required");
  }
  const declaredMime = typeof request.headers["x-upload-content-type"] === "string"
    ? (request.headers["x-upload-content-type"] as string)
    : undefined;
  const mime = assertUploadSignature(raw, declaredMime);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const metadataHeader = request.headers["x-upload-metadata"];
  const metadata = typeof metadataHeader === "string"
    ? (JSON.parse(Buffer.from(metadataHeader, "base64url").toString("utf8")) as Record<string, unknown>)
    : {};
  const revalidationRequestId = typeof metadata.revalidationRequestId === "string"
    ? metadata.revalidationRequestId
    : null;
  const revalidation = revalidationRequestId
    ? await client.kybRevalidationRequest.findFirst({
        where: { id: revalidationRequestId, merchantId, status: "OPEN" },
      })
    : null;
  if (revalidationRequestId && !revalidation) {
    throw new ApiError(404, "KYB_REVALIDATION_NOT_FOUND", "The open revalidation request does not exist");
  }
  // Staff need the cross-merchant matches (they are kept in the audit row and drive the duplicate
  // flags), but the uploader must only ever see their own: another merchant's document ids would
  // reveal that a competitor or a flagged party holds the same file.
  const existingDocument = await client.kybDocument.findMany({
    where: { sha256 },
    select: { id: true, merchantId: true },
  });
  const ownDuplicateDocuments = existingDocument
    .filter((entry) => entry.merchantId === merchantId)
    .map((entry) => entry.id);
  const sizeBytes = Number(request.headers["x-upload-size"] ?? raw.byteLength);
  const joinRequest = revalidation
    ? null
    : await client.joinRequest.findFirst({
        where: { merchantId },
        orderBy: { createdAt: "desc" },
      });
  const docType = revalidation
    ? String(revalidation.docType)
    : String(metadata.documentType ?? "OTHER").toUpperCase().replaceAll(" ", "_");
  const avStatus = scanKybBytes(raw);
  const now = new Date();
  const originalFileNameHeader = typeof request.headers["x-upload-filename"] === "string"
    ? request.headers["x-upload-filename"]
    : "";
  let originalFileName = String(metadata.fileName ?? "document").slice(0, 255);
  if (originalFileNameHeader) {
    try {
      originalFileName = decodeURIComponent(originalFileNameHeader).slice(0, 255);
    } catch {
      originalFileName = originalFileNameHeader.slice(0, 255);
    }
  }
  const expiresOn = typeof metadata.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(metadata.expiresAt)
    ? new Date(metadata.expiresAt)
    : null;
  const objectStorage = getObjectStorageSdk();
  const document = await objectStorage.routeClient.withStagedUpload(
    {
      namespace: "KYB_DOCUMENTS",
      data: raw,
      originalFilename: originalFileName,
      claimedMimeType: mime,
      ownerMerchantId: merchantId,
      actor: {
        actorType: "MERCHANT_USER",
        actorId: principal.userId ?? "merchant-upload",
        merchantId,
        authorities: principal.authorities ?? [],
        ipAddress: clientIp(request),
      },
      metadata: { merchantId, docType, revalidationRequestId: revalidation?.id ?? null },
    },
    async (staged) => {
      const created = await client.$transaction(async (tx) => {
        const row = await tx.kybDocument.create({
          data: {
            merchantId,
            joinRequestId: joinRequest?.id ?? null,
            subjectType: "MERCHANT",
            subjectId: merchantId,
            docType: docType as never,
            storageKey: staged.storageKey,
            originalFileName,
            storageObjectId: staged.objectId,
            sha256: staged.sha256Hex,
            mime: staged.detectedMimeType,
            sizeBytes: Number(staged.byteSize),
            avStatus,
            status: avStatus === "INFECTED" ? "REJECTED" : "UPLOADED",
            uploadedById: principal.userId ?? null,
            expiresOn,
            statusChangedAt: now,
          },
        });
        await objectStorage.routeClient.bind(tx as never, {
          objectId: staged.objectId,
          holderType: "KYB_DOCUMENT",
          holderId: row.id,
          actorId: principal.userId ?? "merchant-upload",
          reason: revalidation ? "KYB_REVALIDATION_DOCUMENT_UPLOAD" : "KYB_DOCUMENT_UPLOAD",
          // KYB documents always wait for the AV worker unless the upload
          // gate itself already found active content (then they are rejected).
          autoPromoteIfNoAvRequired: false,
        });
        if (revalidation && avStatus !== "INFECTED") {
          await tx.kybRevalidationRequest.update({
            where: { id: revalidation.id },
            data: {
              status: "FULFILLED",
              fulfilledAt: now,
              fulfilledDocumentId: row.id,
              resolutionNotes: originalFileName,
            },
          });
          await tx.merchant.update({
            where: { id: merchantId },
            data: { kybStatus: "PENDING" },
          });
        }
        const auditActorId = principal.userId
          ?? (await tx.user.findFirst({
            where: { merchantId, role: "MERCHANT_ADMIN" },
            select: { id: true },
          }))?.id;
        if (auditActorId) {
          await writeAudit(tx, {
            data: {
              actorId: auditActorId,
              role: principal.role ?? "MERCHANT_ADMIN",
              action: revalidation ? "KYB_REVALIDATION_DOCUMENT_UPLOADED" : "KYB_DOCUMENT_UPLOADED",
              entityType: "KYB_DOCUMENT",
              entityId: row.id,
              beforeJson: {},
              afterJson: {
                merchantId,
                docType,
                sha256: staged.sha256Hex,
                avStatus,
                revalidationRequestId: revalidation?.id ?? null,
                duplicateDocuments: existingDocument.map((entry) => entry.id),
              },
            },
          });
        }
        return row;
      });
      return created;
    },
  );
  if (avStatus === "INFECTED") {
    // The upload-time content gate already rejected it: release the domain
    // lock and quarantine the object immediately instead of leaving it
    // PENDING until a scanner examines bytes that are known to be unsafe.
    await objectStorage.workerClient
      .applyScanVerdict({ objectId: document.storageObjectId!, verdict: "INFECTED", signature: "ACTIVE_CONTENT_AT_UPLOAD" })
      .catch(() => undefined);
  }
  if (joinRequest) {
    const merchant = await client.merchant.findUnique({ where: { id: merchantId } });
    const owners = await client.beneficialOwner.findMany({
      where: { merchantId, active: true },
      select: { nationalIdHash: true },
    });
    const flags = merchant
      ? await detectDuplicateFlags(client, {
          merchantId,
          joinRequestId: joinRequest.id,
          taxId: merchant.taxId,
          registrationNo: merchant.registrationNo,
          contactPhone: merchant.contactPhone,
          contactEmail: merchant.contactEmail,
          payoutHash: merchant.payoutAccountHash ?? payoutAccountHash(merchant.payoutBankDetailsJson),
          ownerHashes: owners.map((owner) => owner.nationalIdHash).filter((value): value is string => Boolean(value)),
          documentHashes: (await client.kybDocument.findMany({ where: { joinRequestId: joinRequest.id }, select: { sha256: true } })).map((row) => row.sha256),
        })
      : [];
    await client.joinRequest.update({
      where: { id: joinRequest.id },
      data: { duplicateFlagsJson: flags as never },
    });
  }
  if (revalidation && avStatus !== "INFECTED") {
    await queueKybNotification(client, {
      merchantId,
      code: "KYB_DOCUMENT_REPLACEMENT_RECEIVED",
      payload: { documentType: docType, documentId: document.id },
      eventKey: `revalidation-received:${revalidation.id}`,
    });
  }
  if (avStatus === "INFECTED") {
    response.status(422).json({
      id: document.id,
      status: document.status,
      avStatus: document.avStatus,
      code: "KYB_DOCUMENT_INFECTED",
      message: "The uploaded document failed malware scanning",
    });
    return;
  }
  response.status(201).json({
    id: document.id,
    sha256,
    status: document.status,
    avStatus: document.avStatus,
    duplicateDocuments: ownDuplicateDocuments,
    revalidationRequestId: revalidation?.id ?? null,
  });
});

router.get("/onboarding/beneficial-owners", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const owners = await client.beneficialOwner.findMany({ where: { merchantId } });
  response.json({ owners });
});

router.post("/onboarding/beneficial-owners", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["onboarding:write"]);
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
      nationalIdHash: nationalIdHash(body.identityNumber),
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
  assertMerchantAuthority(principalOf(request), ["onboarding:write"]);
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
  assertMerchantAuthority(principalOf(request), ["onboarding:write"]);
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
  const fourEyes = await resolveFourEyesForSubmission(merchantId, screening, joinRequest.id);
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
  assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write"]);
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    in: { status: "status" }, equals: {currency: "currency"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { currency: "currency", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const { wallets, total } = await readThroughReplicaOrPrimary(
    client as never,
    request.header("x-pg-min-lsn") ?? undefined,
    async (reader) => {
      const [rows, count] = await Promise.all([
        reader.wallet.findMany({ where, orderBy: built.orderBy as never, include: { glAccount: true }, skip: built.skip, take: built.take }),
        reader.wallet.count({ where }),
      ]);
      return { wallets: rows, total: count };
    },
  );
  response.json(listResponse("wallets", wallets, total, built));
});

router.post("/wallets", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["wallet:create"]);
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
      },
    });
    return tx.wallet.create({
      data: { merchantId, glAccountId: glAccount.id, currency: body.currency.toUpperCase(), status: "PENDING" },
    });
  });
  response.status(201).json({ id: wallet.id, currency: wallet.currency, status: wallet.status });
});

router.get("/wallets/:id", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findFirst({ where: { id, merchantId }, include: { glAccount: true } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  response.json({ wallet });
});

router.get("/wallets/:id/balance", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findFirst({
    where: { id, merchantId },
    select: { id: true, currency: true, glAccountId: true },
  });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  // The balance is the shard total; the checkpoint is derived from the shard checkpoints.
  const [live] = await loadLiveAccountBalances(client as never, [wallet.glAccountId]);
  const [checkpoint] = await loadAccountCheckpointSummary(client as never, [wallet.glAccountId]);
  const balance = decimal(live?.balance ?? 0);
  response.json({
    walletId: wallet.id,
    currency: wallet.currency,
    balance: balance.toFixed(4),
    // Natural sign like `balance` (a merchant in credit reads positive); the stored checkpoint is debit-positive.
    checkpointBalance: decimal(naturalShardBalance("MERCHANT_WALLET", checkpoint?.checkpointBalance ?? "0")).toFixed(4),
  });
});

router.get("/wallets/:id/statements", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findFirst({ where: { id, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  const query = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).parse(request.query ?? {});
  // The month parameter now bounds the query (it used to be echoed back while
  // the last 31 days were returned regardless).
  const range = query.month ? monthRangeUtc(query.month) : null;
  const attempts = await client.paymentAttempt.findMany({
    where: withAppScope(request, {
      merchantId,
      createdAt: range
        ? { gte: range.from, lt: range.to }
        : { gte: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    }),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
    select: merchantAttemptListSelect,
  });
  response.json({ walletId: wallet.id, month: query.month ?? null, attempts });
});

router.get("/wallets/:id/statements/:month/export", async (request: Request, response: Response) => {
  // The portal only offers the export (`statements.export`) to merchant:write.
  assertMerchantAuthority(principalOf(request), ["merchant:write"]);
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
  // Bounded by the month in SQL (served by [merchant_id, status, created_at]).
  // Previously the latest 1,000 successes were loaded and filtered in JS, so
  // any older month came back empty or truncated.
  const range = monthRangeUtc(month);
  const attempts = await client.paymentAttempt.findMany({
    where: withAppScope(request, { merchantId, status: "SUCCEEDED", currency: wallet.currency, createdAt: { gte: range.from, lt: range.to } }),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50_000,
    select: {
      reference: true,
      createdAt: true,
      totalChargedAmount: true,
      platformCommissionAmount: true,
      netMerchantAmount: true,
      currency: true,
      status: true,
    },
  });
  const rows = attempts
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
  assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write"]);
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    search: ["name", "businessUseDescription"],
    in: { status: "status" }, equals: {assignedWalletId: "assignedWalletId"},
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "name", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = withAppScope(request, { merchantId, ...built.where }, "id");
  const [applications, total] = await Promise.all([
    client.application.findMany({ where, orderBy: built.orderBy as never, include: { assignedWallet: true }, skip: built.skip, take: built.take }),
    client.application.count({ where }),
  ]);
  response.json(listResponse("applications", applications, total, built));
});

router.post("/applications", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["application:manage"]);
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
  assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const application = await client.application.findFirst({ where: { id, merchantId } });
  if (!application) {
    throw new ApiError(404, "APPLICATION_NOT_FOUND", "The application does not exist");
  }
  assertApplicationInScope(request, application.id);
  response.json({ application });
});

router.patch("/applications/:id", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["application:manage"]);
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
  assertApplicationInScope(request, application.id);
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

const createLink = async (
  merchantId: string,
  body: z.infer<typeof linkCreateSchema>,
  /** The applications a scoped user is restricted to; the default application is picked from them. */
  appScope: readonly string[] | null = null,
) => {
  if (appScope && body.applicationId && !appScope.includes(body.applicationId)) {
    throw new ApiError(
      403,
      "APP_SCOPE_VIOLATION",
      "The principal is restricted to specific applications and this one is not among them",
    );
  }
  const application = body.applicationId
    ? await client.application.findFirst({ where: { id: body.applicationId, merchantId } })
    : await client.application.findFirst({
        where: { merchantId, ...(appScope ? { id: { in: [...appScope] } } : {}) },
        orderBy: { createdAt: "asc" },
      });
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
  // A suspended application or a frozen wallet can not take in new payment links.
  assertCommerceActive({
    applicationStatus: application.status,
    walletStatus: wallet.status,
    env: merchant.status === "ACTIVE" ? "LIVE" : "SANDBOX",
  });
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
  assertMerchantAuthority(principalOf(request), ["link:read"]);
  const merchantId = merchantIdOf(request);
  const rawState = typeof request.query.state === "string" ? request.query.state : undefined;
  const state = rawState === "ACTIVE" ? "PENDING" : rawState;
  const built = buildListQuery(request.query, {
    search: ["key"],
    equals: { applicationId: "applicationId", walletId: "walletId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt" }, expiresAt: { path: "expiresAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { linkKey: "key", amount: "amount", useCount: "useCount", status: "state", expiresAt: "expiresAt", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  // payment_links has no merchant_id column: the former top-level
  // `merchantId` filter made Prisma reject every request. Ownership is the
  // application relation.
  const where = withAppScope(request, { application: { merchantId }, ...(state ? { state } : {}), ...built.where });
  const { links, total } = await readThroughReplicaOrPrimary(
    client as never,
    request.header("x-pg-min-lsn") ?? undefined,
    async (reader) => {
      const [rows, count] = await Promise.all([
        reader.paymentLink.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
        countUnlessSkipped(built, () => reader.paymentLink.count({ where })),
      ]);
      return { links: rows, total: count };
    },
  );
  response.json(listResponse("links", links, total, built));
});

router.post("/links", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["link:write"]);
  const merchantId = merchantIdOf(request);
  const body = parseOrThrow(linkCreateSchema, request.body);
  const { link, visible } = await createLink(merchantId, body, appScopeOf(request));
  await publishRealtimePos({
    merchantId,
    applicationId: link.applicationId,
    linkId: link.id,
    linkKey: link.key,
  });
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
  assertMerchantAuthority(principalOf(request), ["link:read"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const link = await client.paymentLink.findFirst({ where: { id, application: { merchantId } } });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  assertApplicationInScope(request, link.applicationId);
  response.json({ link });
});

router.post("/links/:id/cancel", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["link:write"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const link = await client.paymentLink.findFirst({ where: { id, application: { merchantId } } });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  assertApplicationInScope(request, link.applicationId);
  if (link.state === "COMPLETED") {
    throw new ApiError(409, "PAYMENT_LINK_COMPLETED", "A completed payment link cannot be cancelled");
  }
  const updated = await client.paymentLink.update({ where: { id: link.id }, data: { state: "CANCELLED" } });
  response.json({ id: updated.id, state: updated.state });
});

router.get("/links/:id/attempts", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["link:read"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const link = await client.paymentLink.findFirst({ where: { id, application: { merchantId } }, select: { id: true, applicationId: true } });
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  assertApplicationInScope(request, link.applicationId);
  // Bounded (an infinite-use link can carry a very long history) and served
  // by [link_id, created_at].
  const attempts = await client.paymentAttempt.findMany({
    where: { linkId: link.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 500,
    select: merchantAttemptListSelect,
  });
  response.json({ attempts });
});

router.get("/payments", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["payment:read"]);
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    search: ["reference"],
    in: { status: "status" }, equals: {railId: "railId", applicationId: "applicationId"},
    ranges: {
      amount: { path: "totalChargedAmount", kind: "decimal" },
      commission: { path: "platformCommissionAmount", kind: "decimal" },
      net: { path: "netMerchantAmount", kind: "decimal" },
    },
    // payment_attempts has no confirmed_at column; the confirmation instant is
    // terminal_at. Filtering/sorting on "confirmedAt" used to make Prisma
    // reject the request.
    dates: { createdAt: { path: "createdAt" }, confirmedAt: { path: "terminalAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { reference: "reference", amount: "totalChargedAmount", status: "status", createdAt: "createdAt", confirmedAt: "terminalAt" },
    defaultSort: { createdAt: "desc" },
    keysetFields: ["reference", "totalChargedAmount", "status"],
  });
  const where = withAppScope(request, { merchantId, ...built.where });
  const { payments, total } = await readThroughReplicaOrPrimary(
    client as never,
    request.header("x-pg-min-lsn") ?? undefined,
    async (reader) => {
      const [rows, count] = await Promise.all([
        reader.paymentAttempt.findMany({
          where,
          orderBy: built.orderBy as never,
          skip: built.skip,
          take: built.take,
          select: merchantAttemptListSelect,
        }),
        countUnlessSkipped(built, () => reader.paymentAttempt.count({ where })),
      ]);
      return { payments: rows, total: count };
    },
  );
  response.json(listResponse("payments", payments, total, built));
});

router.get("/disputes", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["payment:read", "dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const built = buildListQuery(request.query, {
    search: ["disputeRef", "reasonCode"],
    in: { status: "status" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "openedAt" }, evidenceDueAt: { path: "evidenceDueAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { disputeRef: "disputeRef", status: "status", amount: "amount", evidenceDueAt: "evidenceDueAt" },
    defaultSort: { openedAt: "desc" },
  });
  // Relation filter (one semi-join) instead of loading every DISPUTED attempt
  // id of the merchant and shipping it back twice as an IN list. It also
  // includes disputes whose attempt has since moved on from DISPUTED.
  const appScope = appScopeOf(request);
  const where = {
    attempt: { merchantId, ...(appScope ? { applicationId: { in: [...appScope] } } : {}) },
    ...built.where,
  } as never;
  const [disputes, total] = await Promise.all([
    client.dispute.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.dispute.count({ where }),
  ]);
  response.json(listResponse("disputes", disputes.map((entry) => ({ ...entry, state: entry.status })), total, built));
});

router.get("/disputes/:id", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["payment:read", "dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const appScope = appScopeOf(request);
  const dispute = await client.dispute.findFirst({
    where: { id, attempt: { merchantId, ...(appScope ? { applicationId: { in: [...appScope] } } : {}) } },
  });
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  }
  response.json({ dispute });
});

router.post("/disputes/:id/evidence", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ evidence: z.record(z.string().max(64), z.unknown()), notes: z.string().max(4000).optional() }).strict(),
    request.body,
  );
  const evidenceScope = appScopeOf(request);
  const dispute = await client.dispute.findFirst({
    where: { id, attempt: { merchantId, ...(evidenceScope ? { applicationId: { in: [...evidenceScope] } } : {}) } },
  });
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  }
  // Evidence is only accepted while the dispute is waiting for it; the conditional update
  // keeps a concurrent decision (won / lost / closed) from being overwritten.
  const EVIDENCE_OPEN_STATUSES = ["OPENED", "EVIDENCE_REQUESTED"];
  if (!EVIDENCE_OPEN_STATUSES.includes(String(dispute.status))) {
    throw new ApiError(409, "DISPUTE_NOT_ACCEPTING_EVIDENCE", "The dispute is not accepting evidence", {
      status: String(dispute.status),
    });
  }
  const evidenceUpdate = await client.dispute.updateMany({
    where: { id: dispute.id, status: { in: EVIDENCE_OPEN_STATUSES as never } },
    data: {
      status: "EVIDENCE_SUBMITTED",
      evidenceJson: json({ ...(dispute.evidenceJson as Record<string, unknown> | null), ...body.evidence }),
    },
  });
  if (evidenceUpdate.count !== 1) {
    throw new ApiError(409, "DISPUTE_NOT_ACCEPTING_EVIDENCE", "The dispute is not accepting evidence");
  }
  response.json({ id: dispute.id, status: "EVIDENCE_SUBMITTED" });
});

const disputeAttachmentRow = (row: Record<string, any>) => ({
  id: row.id,
  disputeId: row.disputeId,
  label: row.label,
  uploadedById: row.uploadedById,
  createdAt: row.createdAt,
  fileName: row.storageObject?.originalFilename ?? null,
  mimeType: row.storageObject?.detectedMimeType ?? null,
  byteSize: row.storageObject?.byteSize?.toString?.() ?? null,
  sha256: row.storageObject?.sha256Hex ?? null,
  status: row.storageObject?.status ?? null,
  avScanStatus: row.storageObject?.avScanStatus ?? null,
});

router.get("/disputes/:id/attachments", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["payment:read", "dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const dispute = await client.dispute.findFirst({ where: { id, attempt: { merchantId } } });
  if (!dispute) throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  const attachments = await client.disputeAttachment.findMany({
    where: { disputeId: id, merchantId },
    orderBy: { createdAt: "desc" },
    include: { storageObject: true },
  });
  response.json({ attachments: attachments.map(disputeAttachmentRow) });
});

router.post("/disputes/:id/attachments", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const dispute = await client.dispute.findFirst({
    where: { id, attempt: { merchantId, ...(appScopeOf(request) ? { applicationId: { in: [...appScopeOf(request)!] } } : {}) } },
  });
  if (!dispute) throw new ApiError(404, "DISPUTE_NOT_FOUND", "The dispute does not exist");
  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (raw.byteLength === 0) throw new ApiError(400, "UPLOAD_REQUIRED", "An evidence file is required");
  let metadata: Record<string, unknown> = {};
  const metadataHeader = request.headers["x-upload-metadata"];
  if (typeof metadataHeader === "string") {
    try {
      metadata = JSON.parse(Buffer.from(metadataHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new ApiError(400, "UPLOAD_METADATA_INVALID", "The upload metadata is not valid JSON");
    }
  }
  const fileName = typeof request.headers["x-upload-filename"] === "string"
    ? decodeURIComponent(String(request.headers["x-upload-filename"]))
    : "evidence";
  const label = String(metadata.label ?? fileName).slice(0, 255);
  const objectStorage = getObjectStorageSdk();
  const attachment = await objectStorage.routeClient.withStagedUpload(
    {
      namespace: "DISPUTE_EVIDENCE",
      data: raw,
      originalFilename: fileName,
      claimedMimeType: typeof request.headers["x-upload-content-type"] === "string"
        ? String(request.headers["x-upload-content-type"])
        : null,
      ownerMerchantId: merchantId,
      actor: {
        actorType: "MERCHANT_USER",
        actorId: principal.userId ?? merchantId,
        merchantId,
        authorities: principal.authorities ?? [],
        ipAddress: clientIp(request),
      },
      metadata: { disputeId: dispute.id, label },
    },
    async (staged) => client.$transaction(async (tx) => {
      const row = await tx.disputeAttachment.create({
        data: {
          disputeId: dispute.id,
          merchantId,
          storageObjectId: staged.objectId,
          label,
          uploadedById: principal.userId ?? merchantId,
        },
        include: { storageObject: true },
      });
      await objectStorage.routeClient.bind(tx as never, {
        objectId: staged.objectId,
        holderType: "DISPUTE_ATTACHMENT",
        holderId: row.id,
        actorId: principal.userId ?? merchantId,
        reason: "DISPUTE_EVIDENCE_UPLOAD",
        autoPromoteIfNoAvRequired: false,
      });
      return row;
    }),
  );
  response.status(201).json({ attachment: disputeAttachmentRow(attachment as never) });
});

router.get("/disputes/:id/attachments/:attachmentId/content", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["payment:read", "dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const { id, attachmentId } = parseOrThrow(
    z.object({ id: z.string().min(1).max(64), attachmentId: z.string().min(1).max(64) }).strict(),
    request.params,
  );
  const attachment = await client.disputeAttachment.findFirst({
    where: { id: attachmentId, disputeId: id, merchantId },
  });
  if (!attachment) throw new ApiError(404, "DISPUTE_ATTACHMENT_NOT_FOUND", "The dispute attachment does not exist");
  const stored = await getObjectStorageSdk().routeClient.readAuthorized({
    objectId: attachment.storageObjectId,
    actor: {
      actorType: "MERCHANT_USER",
      actorId: principal.userId ?? merchantId,
      merchantId,
      authorities: principal.authorities ?? [],
      ipAddress: clientIp(request),
    },
    holderContext: { holderType: "DISPUTE_ATTACHMENT", holderId: attachment.id },
  });
  response.setHeader("Content-Type", stored.detectedMimeType);
  response.setHeader("Content-Disposition", `attachment; filename="${(stored.originalFilename ?? "evidence").replace(/["\r\n]/g, "_")}"`);
  response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.send(Buffer.from(stored.bytes));
});

router.delete("/disputes/:id/attachments/:attachmentId", async (request: Request, response: Response) => {
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["dispute:respond"]);
  const merchantId = merchantIdOf(request);
  const { id, attachmentId } = parseOrThrow(
    z.object({ id: z.string().min(1).max(64), attachmentId: z.string().min(1).max(64) }).strict(),
    request.params,
  );
  const attachment = await client.disputeAttachment.findFirst({
    where: { id: attachmentId, disputeId: id, merchantId },
  });
  if (!attachment) throw new ApiError(404, "DISPUTE_ATTACHMENT_NOT_FOUND", "The dispute attachment does not exist");
  await client.$transaction(async (tx) => {
    await tx.disputeAttachment.delete({ where: { id: attachment.id } });
    await getObjectStorageSdk().routeClient.release(tx as never, {
      objectId: attachment.storageObjectId,
      holderType: "DISPUTE_ATTACHMENT",
      holderId: attachment.id,
      actorId: principal.userId ?? merchantId,
      reason: "DISPUTE_ATTACHMENT_DELETED",
    });
  });
  response.json({ id: attachment.id, deleted: true });
});

router.get("/cashouts", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["cashout:read","cashout:request"]);
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

const cashoutDestinationSchema = z
  .object({
    bankName: z.string().min(2).max(120).optional(),
    bank: z.string().min(2).max(120).optional(),
    accountNumber: z.string().regex(/^[0-9A-Za-z\- ]{4,40}$/).optional(),
    iban: z.string().regex(/^[A-Za-z]{2}[0-9]{2}[0-9A-Za-z ]{10,34}$/).optional(),
    accountHolder: z.string().min(2).max(140).optional(),
    swift: z.string().regex(/^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/).optional(),
    bankAccountId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.accountNumber || value.iban), {
    // The KYB payout hash is derived from the bank + account number/IBAN;
    // a bankAccountId alone can never match it.
    error: "an account number or an IBAN is required",
  });

router.post("/cashouts", async (request: Request, response: Response) => {
  const merchantId = merchantIdOf(request);
  const principal = principalOf(request);
  assertMerchantAuthority(principal, ["cashout:request"]);
  const body = parseOrThrow(
    z
      .object({
        walletId: z.string().min(1).max(64),
        amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
        currency: z.string().length(3).optional(),
        destinationBank: cashoutDestinationSchema,
        idempotencyKey: z.string().min(8).max(128).optional(),
      })
      .strict(),
    request.body,
  );
  const headerKey = request.header("idempotency-key");
  const idempotencyKey = body.idempotencyKey ?? (headerKey && headerKey.length >= 8 && headerKey.length <= 128 ? headerKey : undefined);
  if (!idempotencyKey) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key (8 to 128 characters) is required to request a cash-out");
  }
  if (decimal(body.amount).lte(0)) {
    throw new ApiError(400, "CASHOUT_AMOUNT_INVALID", "The cash-out amount must be greater than zero");
  }
  const merchant = await client.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || merchant.status !== "ACTIVE") {
    throw new ApiError(409, "MERCHANT_NOT_ACTIVE", "Cash-outs are only available to active merchants");
  }
  const wallet = await client.wallet.findFirst({ where: { id: body.walletId, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  }
  if (wallet.status !== "ACTIVE") {
    throw new ApiError(409, "WALLET_NOT_ACTIVE", "Cash-outs are only available from an active wallet");
  }
  if (body.currency && body.currency.toUpperCase() !== wallet.currency) {
    throw new ApiError(400, "CASHOUT_CURRENCY_MISMATCH", "The cash-out currency must match the wallet currency");
  }
  // GAP-017: the payout destination is ALWAYS bound to the KYB-verified payout account.
  // Legacy merchants may have the bank details but a null hash (the column was
  // introduced after they onboarded): derive and backfill it instead of locking
  // them out.
  let verifiedPayoutHash = merchant.payoutAccountHash;
  if (!verifiedPayoutHash) {
    verifiedPayoutHash = payoutAccountHash(merchant.payoutBankDetailsJson);
    if (verifiedPayoutHash) {
      await client.merchant.update({
        where: { id: merchant.id },
        data: { payoutAccountHash: verifiedPayoutHash },
      });
    }
  }
  if (!verifiedPayoutHash) {
    throw new ApiError(
      403,
      "CASHOUT_PAYOUT_ACCOUNT_NOT_VERIFIED",
      "No KYB-verified payout account is on record for this merchant, so a cash-out cannot be requested",
    );
  }
  const destinationHash = payoutAccountHash(body.destinationBank);
  if (!destinationHash || destinationHash !== verifiedPayoutHash) {
    throw new ApiError(
      403,
      "CASHOUT_DESTINATION_NOT_VERIFIED",
      "The destination account does not match the payout account verified during onboarding",
    );
  }
  const destination = { ...body.destinationBank, payoutVerified: true };
  const existing = await client.cashoutRequest.findFirst({ where: { merchantId, idempotencyKey } });
  const replay = (row: { id: string; state: string; walletId: string; amount: unknown }) => {
    if (row.walletId !== wallet.id || !decimal(row.amount as never).eq(decimal(body.amount))) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different cash-out");
    }
    response.status(200).json({ id: row.id, state: row.state, idempotent: true });
  };
  if (existing) {
    replay(existing as never);
    return;
  }
  let freshlyCreated = false;
  let replayedInTransaction = false;
  const created = await client.$transaction(async (tx) => {
    // Re-check the idempotency key inside the wallet lock: a concurrent retry
    // must replay the winner, not fail the balance check against its reservation.
    const racedBeforeLock = await tx.cashoutRequest.findFirst({ where: { merchantId, idempotencyKey } });
    if (racedBeforeLock) {
      replayedInTransaction = true;
      return racedBeforeLock;
    }
    // Serialise concurrent requests of the wallet, then check the available balance:
    // the ledger balance minus the cash-outs that are already waiting.
    const ledgerBalance = await lockWalletLedgerBalance(tx, wallet.glAccountId);
    const reserved = await openCashoutTotal(tx, wallet.id);
    if (ledgerBalance.minus(reserved).lt(decimal(body.amount))) {
      // The winner may have committed while this transaction waited for the lock.
      const raced = await tx.cashoutRequest.findFirst({ where: { merchantId, idempotencyKey } });
      if (raced) {
        replayedInTransaction = true;
        return raced;
      }
      throw new ApiError(409, "INSUFFICIENT_BALANCE", "The available balance does not cover this cash-out");
    }
    const row = await tx.cashoutRequest.create({
      data: {
        merchantId,
        walletId: wallet.id,
        amount: new Prisma.Decimal(body.amount),
        destinationBankJson: json(destination),
        state: "PENDING",
        idempotencyKey,
        requestedByUserId: principal.userId,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: principal.userId ?? merchantId,
        role: principal.role ?? "MERCHANT_API",
        action: "CASHOUT_REQUESTED",
        entityType: "CASHOUT_REQUEST",
        entityId: row.id,
        beforeJson: {},
        afterJson: { walletId: wallet.id, amount: body.amount, payoutVerified: destination.payoutVerified },
      },
    });
    freshlyCreated = true;
    return row;
  }).catch(async (error: unknown) => {
    // A concurrent retry with the same key lost the unique index race: answer with the winner.
    if ((error as { code?: string })?.code === "P2002") {
      return client.cashoutRequest.findFirst({ where: { merchantId, idempotencyKey } });
    }
    throw error;
  });
  if (!created) {
    throw new ApiError(409, "CASHOUT_CONFLICT", "The cash-out could not be created");
  }
  if (freshlyCreated && !replayedInTransaction) {
    response.status(201).json({ id: created.id, state: created.state });
    return;
  }
  replay(created as never);
});

const cidrSchema = z.string().min(3).max(64).refine((value) => {
  try {
    const [network, prefix] = value.split("/");
    ipaddr.parse(network ?? "");
    return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128);
  } catch {
    return false;
  }
}, "must be an IP address or a CIDR range");

router.get("/tokens", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["token:manage"]);
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
    expiresAt: token.expiresAt,
    ipWhitelistEnabled: token.ipWhitelistEnabled,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    allowedCidrs: token.ips.map((entry) => entry.cidr),
  })), total, built));
});

router.post("/tokens", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["token:manage"]);
  const merchantId = merchantIdOf(request);
  const principal = principalOf(request);
  const body = parseOrThrow(
    z
      .object({
        name: z.string().min(2).max(120),
        scopes: z.array(z.string().min(2).max(64)).min(1).max(50),
        allowedCidrs: z.array(cidrSchema).max(64).optional(),
        applicationId: z.string().min(1).max(64).optional(),
        expiresAt: z.string().datetime().optional(),
      })
      .strict(),
    request.body,
  );
  const tokenScopes = normalizeTokenScopes(body.scopes);
  assertKnownTokenScopes(tokenScopes);
  assertGrantableMerchantAuthorities(principal, tokenScopes);
  let tokenExpiresAt: Date | null = null;
  if (body.expiresAt) {
    tokenExpiresAt = new Date(body.expiresAt);
    const maxLifetimeMs = 2 * 365 * 24 * 60 * 60 * 1000;
    if (tokenExpiresAt.getTime() <= Date.now() || tokenExpiresAt.getTime() > Date.now() + maxLifetimeMs) {
      throw new ApiError(400, "TOKEN_EXPIRY_INVALID", "The expiry must be in the future and within two years");
    }
  }
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
      scopes: tokenScopes,
      expiresAt: tokenExpiresAt,
      ipWhitelistEnabled: Boolean(body.allowedCidrs?.length),
      ips: body.allowedCidrs
        ? { create: body.allowedCidrs.map((cidr) => ({ cidr })) }
        : undefined,
    },
  });
  await writeAudit(client, {
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
  assertMerchantAuthority(principalOf(request), ["token:manage"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({ allowedCidrs: z.array(cidrSchema).max(64) }).strict(), request.body);
  const token = await client.accessToken.findFirst({ where: { id, merchantId } });
  if (!token) {
    throw new ApiError(404, "ACCESS_TOKEN_NOT_FOUND", "The access token does not exist");
  }
  await client.$transaction(async (tx) => {
    const previousCidrs = (await tx.accessTokenIp.findMany({ where: { tokenId: token.id }, select: { cidr: true } })).map((row) => row.cidr);
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
    await auditMerchantAction(tx, request, {
      action: "ACCESS_TOKEN_IP_ALLOWLIST_CHANGED",
      entityType: "ACCESS_TOKEN",
      entityId: token.id,
      before: { allowedCidrs: previousCidrs },
      after: { allowedCidrs: body.allowedCidrs },
    });
  });
  response.json({ id: token.id, allowedCidrs: body.allowedCidrs });
});

router.delete("/tokens/:id", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["token:manage"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const token = await client.accessToken.findFirst({ where: { id, merchantId } });
  if (!token) {
    throw new ApiError(404, "ACCESS_TOKEN_NOT_FOUND", "The access token does not exist");
  }
  const revokedAt = new Date();
  await client.$transaction(async (tx) => {
    await tx.accessToken.update({ where: { id: token.id }, data: { revokedAt } });
    await auditMerchantAction(tx, request, {
      action: "ACCESS_TOKEN_REVOKED",
      entityType: "ACCESS_TOKEN",
      entityId: token.id,
      before: { name: token.name, revoked: Boolean(token.revokedAt) },
      after: { revoked: true },
    });
  });
  response.json({ id: token.id, revokedAt: revokedAt.toISOString() });
});

router.get("/credential-sets", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["credential:manage"]);
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
  assertMerchantAuthority(principalOf(request), ["credential:manage"]);
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
  // Key names and versions only: a secret value (or its ciphertext) never enters the audit trail.
  await auditMerchantAction(client, request, {
    action: "CREDENTIAL_SET_CREATED",
    entityType: "CREDENTIAL_SET",
    entityId: credentialSet.id,
    after: {
      gatewayCode: body.gatewayCode,
      env: body.env,
      settlementTarget: body.settlementTarget,
      entryKeys: body.entries.map((entry) => entry.key),
    },
  });
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
  assertMerchantAuthority(principalOf(request), ["credential:manage"]);
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
  await auditMerchantAction(client, request, {
    action: "CREDENTIAL_SET_ROTATED",
    entityType: "CREDENTIAL_SET",
    entityId: updated.id,
    before: { status: credentialSet.status },
    after: { status: updated.status, entryKeys: body.entries.map((entry) => entry.key), secretVersion: 2 },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.get("/credential-sets/:id", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["credential:manage"]);
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
  assertMerchantAuthority(principalOf(request), ["credential:manage"]);
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
  await auditMerchantAction(client, request, {
    action: "CREDENTIAL_SET_VERIFIED",
    entityType: "CREDENTIAL_SET",
    entityId: id,
    before: { status: credentialSet.status },
    after: { status: result.status, method: result.method },
  });
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
  assertMerchantAuthority(principalOf(request), ["user:manage"]);
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
  assertMerchantAuthority(principalOf(request), ["user:manage"]);
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
  const creator = principalOf(request);
  assertKnownMerchantAuthorities(body.authoritiesMap);
  assertGrantableMerchantAuthorities(creator, body.authoritiesMap);
  assertGrantableMerchantRole(creator, body.role);
  const existing = await client.user.findFirst({ where: { email: normalizeEmail(body.email) } });
  if (existing) {
    throw new ApiError(409, "USER_ALREADY_EXISTS", "A user with this email already exists");
  }
  const passwordHash = await hashPassword(body.password);
  const user = await client.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        merchantId,
        email: normalizeEmail(body.email),
        phone: body.phone ? normalizePhone(body.phone) : null,
        passwordHash,
        role: body.role,
        authoritiesMap: body.authoritiesMap,
        mfaRequired: true,
        status: "INVITED",
        invitedById: creator.userId,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: creator.userId ?? merchantId,
        role: creator.role ?? "MERCHANT_API",
        action: "MERCHANT_USER_CREATED",
        entityType: "USER",
        entityId: created.id,
        beforeJson: {},
        afterJson: { role: created.role, authoritiesMap: body.authoritiesMap, status: created.status },
      },
    });
    return created;
  });
  response.status(201).json({ id: user.id, email: user.email, role: user.role, status: user.status });
});

const merchantUserPatchSchema = z
  .object({
    authoritiesMap: z.array(z.string().min(2).max(64)).max(50).optional(),
    role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
    status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
  })
  .strict();

const applyMerchantUserPatch = async (
  request: Request,
  response: Response,
  merchantId: string,
  id: string,
  body: z.infer<typeof merchantUserPatchSchema>,
): Promise<void> => {
  const principal = principalOf(request);
  const user = await client.user.findFirst({ where: { id, merchantId } });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  }
  if (user.id === principal.userId) {
    throw new ApiError(403, "SELF_MODIFICATION_FORBIDDEN", "You cannot change your own account");
  }
  if (user.role === "MERCHANT_ADMIN" && principal.role !== "MERCHANT_ADMIN") {
    throw new ApiError(403, "ROLE_ESCALATION_FORBIDDEN", "Only a merchant administrator can change an administrator");
  }
  if (body.authoritiesMap) {
    assertKnownMerchantAuthorities(body.authoritiesMap);
    assertGrantableMerchantAuthorities(principal, body.authoritiesMap);
  }
  if (body.role) {
    assertGrantableMerchantRole(principal, body.role);
  }
  const updated = await client.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: user.id },
      data: {
        authoritiesMap: body.authoritiesMap,
        role: body.role,
        status: body.status,
      },
    });
    await writeAudit(tx, {
      data: {
        actorId: principal.userId ?? merchantId,
        role: principal.role ?? "MERCHANT_API",
        action: "MERCHANT_USER_UPDATED",
        entityType: "USER",
        entityId: user.id,
        beforeJson: { role: user.role, status: user.status, authoritiesMap: user.authoritiesMap },
        afterJson: { role: row.role, status: row.status, authoritiesMap: row.authoritiesMap },
      },
    });
    return row;
  });
  response.json({ id: updated.id, role: updated.role, status: updated.status });
};

router.patch("/users", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["user:manage"]);
  const merchantId = merchantIdOf(request);
  const { id, ...body } = parseOrThrow(
    merchantUserPatchSchema.extend({ id: z.string().min(1).max(64) }).strict(),
    request.body,
  );
  await applyMerchantUserPatch(request, response, merchantId, id, body);
});

router.patch("/users/:id", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["user:manage"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(merchantUserPatchSchema, request.body);
  await applyMerchantUserPatch(request, response, merchantId, id, body);
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
  assertMerchantAuthority(principalOf(request), ["pos:manage"]);
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
  assertMerchantAuthority(principalOf(request), ["pos:manage"]);
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
  // A BLOCKED terminal is a staff decision: only an approved admin
  // reactivation lifts it, never the merchant's own PATCH.
  if (terminal.status === "BLOCKED" && body.status !== undefined && body.status !== "BLOCKED") {
    throw new ApiError(409, "POS_TERMINAL_BLOCKED", "A blocked terminal can only be reactivated by the platform");
  }
  const updated = await client.posTerminal.update({
    where: { id: terminal.id },
    data: { name: body.name, location: body.location, status: body.status },
  });
  response.json({ id: updated.id, status: updated.status });
});

router.post("/pos/terminals/:id/screens", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["pos:manage"]);
  const merchantId = merchantIdOf(request);
  const { id } = parseOrThrow(idSchema, request.params);
  const terminal = await client.posTerminal.findFirst({ where: { id, application: { merchantId } } });
  if (!terminal) {
    throw new ApiError(404, "POS_TERMINAL_NOT_FOUND", "The POS terminal does not exist");
  }
  assertPosTerminalActive(terminal.status);
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
    select: { id: true, posId: true, pos: { select: { status: true } } },
  });
  if (!screen) {
    throw new ApiError(404, "POS_SCREEN_NOT_FOUND", "The POS screen does not exist");
  }
  // A screen of an inactive or blocked terminal does not authenticate.
  assertPosTerminalActive(screen.pos.status);
  let lastHeartbeatAt = 0;
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
  const deadline = Date.now() + 15 * 60 * 1000;
  const sendAttempts = (attempts: unknown[]): void => {
    if (!response.writableEnded) {
      response.write(`event: attempts\ndata: ${JSON.stringify(attempts)}\n\n`);
    }
  };
  const unsubscribeAttempt = subscribeRealtimeAttempt((event) => {
    if (response.writableEnded || event.merchantId !== merchantId) {
      return;
    }
    sendAttempts([{
      id: event.attemptId,
      status: event.status,
      substatus: event.substatus ?? null,
    }]);
  });
  const unsubscribePos = subscribeRealtimePos((event) => {
    if (response.writableEnded || event.merchantId !== merchantId) {
      return;
    }
    sendAttempts([]);
  });
  const poll = async (): Promise<void> => {
    if (response.writableEnded || Date.now() > deadline) {
      response.end();
      return;
    }
    // Heartbeat at most once a minute instead of an UPDATE every 3 s per
    // open screen (nothing reads last_active_at at finer resolution).
    if (Date.now() - lastHeartbeatAt >= 60_000) {
      lastHeartbeatAt = Date.now();
      // A terminal deactivated or blocked while the stream is open ends it.
      const terminal = await client.posTerminal.findUnique({ where: { id: screen.posId }, select: { status: true } });
      if (terminal?.status !== "ACTIVE") {
        response.end();
        return;
      }
      await client.posScreen.update({ where: { id: screen.id }, data: { lastActiveAt: new Date() }, select: { id: true } });
    }
    // Filter on the merchant_id column ([merchant_id, created_at] index)
    // rather than through the applications relation, and never ship the
    // encrypted context or customer fields to the screen.
    const attempts = await client.paymentAttempt.findMany({
      where: { merchantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
      select: merchantAttemptListSelect,
    });
    sendAttempts(attempts);
    setTimeout(() => {
      void poll();
    }, 3000);
  };
  request.on("close", () => {
    unsubscribeAttempt();
    unsubscribePos();
    response.end();
  });
  await poll();
});

router.get("/stats/overview", async (request: Request, response: Response) => {
  assertMerchantAuthority(principalOf(request), ["payment:read"]);
  // The overview mixes merchant-wide wallet balances and cash-outs into the figures, so it cannot be
  // narrowed to a few applications: a user scoped to applications gets the per-application lists instead.
  if (appScopeOf(request)) {
    throw new ApiError(
      403,
      "APP_SCOPE_RESTRICTED",
      "The merchant overview is not available to a user restricted to specific applications",
    );
  }
  const merchantId = merchantIdOf(request);
  const period = String(request.query.period ?? "last_30d");
  const days = period === "last_7d" ? 7 : period === "last_90d" ? 90 : 30;
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Aggregated by PostgreSQL instead of loading every attempt of the window
  // (up to 90 days) and summing in JS. Same response contract.
  const [statusGroups, successGroups, recent, walletRows, pendingCashouts] = await Promise.all([
    client.paymentAttempt.groupBy({
      by: ["status"],
      where: { merchantId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    client.$queryRaw<Array<{ day: string; railCode: string | null; count: number; gross: string; commission: string; net: string }>>`
      SELECT (pa.created_at)::date::text AS day,
             r.code AS "railCode",
             COUNT(*)::int AS count,
             SUM(pa.total_charged_amount)::text AS gross,
             SUM(pa.platform_commission_amount)::text AS commission,
             SUM(pa.net_merchant_amount)::text AS net
      FROM payment_attempts pa
      LEFT JOIN rails r ON r.id = pa.rail_id
      WHERE pa.merchant_id = ${merchantId}::uuid
        AND pa.status = 'SUCCEEDED'
        AND pa.created_at >= ${since}
      GROUP BY 1, 2
    `,
    client.paymentAttempt.findMany({
      where: { merchantId, createdAt: { gte: since } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 6,
      select: {
        id: true,
        reference: true,
        status: true,
        totalChargedAmount: true,
        currency: true,
        createdAt: true,
        rail: { select: { code: true } },
      },
    }),
    client.wallet.findMany({ where: { merchantId }, select: { currency: true, glAccountId: true } }),
    client.cashoutRequest.count({ where: { merchantId, state: { in: ["PENDING", "PROCESSING"] } } }),
  ]);

  let volume = decimal(0);
  let commission = decimal(0);
  let net = decimal(0);
  let todayVolume = decimal(0);
  const todayKey = startOfDay.toISOString().slice(0, 10);
  const byStatus: Record<string, number> = {};
  let attemptCount = 0;
  for (const group of statusGroups) {
    byStatus[group.status] = group._count._all;
    attemptCount += group._count._all;
  }
  const dayTotals = new Map<string, { gross: ReturnType<typeof decimal>; commission: ReturnType<typeof decimal>; net: ReturnType<typeof decimal> }>();
  const railTotals = new Map<string, { gross: ReturnType<typeof decimal>; count: number }>();
  for (const group of successGroups) {
    const gross = decimal(group.gross ?? 0);
    const commissionAmount = decimal(group.commission ?? 0);
    const netAmount = decimal(group.net ?? 0);
    volume = volume.plus(gross);
    commission = commission.plus(commissionAmount);
    net = net.plus(netAmount);
    if (group.day === todayKey) {
      todayVolume = todayVolume.plus(gross);
    }
    const dayEntry = dayTotals.get(group.day) ?? { gross: decimal(0), commission: decimal(0), net: decimal(0) };
    dayTotals.set(group.day, {
      gross: dayEntry.gross.plus(gross),
      commission: dayEntry.commission.plus(commissionAmount),
      net: dayEntry.net.plus(netAmount),
    });
    const railCode = group.railCode ?? "UNKNOWN";
    const railEntry = railTotals.get(railCode) ?? { gross: decimal(0), count: 0 };
    railTotals.set(railCode, { gross: railEntry.gross.plus(gross), count: railEntry.count + Number(group.count) });
  }

  // Live wallet balance (shards, or checkpoint + post-checkpoint lines). The
  // previous code summed gl_accounts.checkpoint_balance only, which is stale
  // between checkpoints (and debit-positive).
  const liveBalances = await loadLiveAccountBalances(client as never, walletRows.map((wallet) => wallet.glAccountId));
  const walletBalance = liveBalances.reduce((total, row) => total.plus(decimal(row.balance)), decimal(0));
  const attempts = { length: attemptCount };
  const currency = walletRows[0]?.currency ?? recent[0]?.currency ?? "LYD";
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
    recentPayments: recent.map((attempt) => ({
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
  assertMerchantAuthority(principal, ["link:write"]);
  if (principal.kind !== "apiToken") {
    throw new ApiError(403, "API_TOKEN_REQUIRED", "An API access token is required for the external API");
  }
  const body = parseOrThrow(linkCreateSchema, request.body);
  const { link, visible } = await createLink(principal.merchantId as string, body);
  await publishRealtimePos({
    merchantId: principal.merchantId as string,
    applicationId: link.applicationId,
    linkId: link.id,
    linkKey: link.key,
  });
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
  assertMerchantAuthority(principal, ["link:read","link:write"]);
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
  assertMerchantAuthority(principal, ["link:write"]);
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
  assertMerchantAuthority(principal, ["payment:read"]);
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

// ---- Outbound webhooks (AUTO-34) -----------------------------------------------------------------------------------
// The merchant manages its endpoints here (portal contract, proxied by merchant-back). Reading needs a merchant read
// authority, changing anything needs `application:manage`; a scoped user only reaches endpoints of their applications.
// The signing secret is returned exactly once, by create and rotate, and never read back.

const webhookService = new WebhookEndpointService({
  db: client as never,
  vault,
  allowInsecure: env.MERCHANT_WEBHOOK_ALLOW_INSECURE,
  rotationOverlapMs: env.MERCHANT_WEBHOOK_ROTATION_OVERLAP_HOURS * 3_600_000,
});

const webhookActor = (request: Request) => {
  const principal = principalOf(request);
  return { userId: principal.userId ?? null, role: principal.role ?? "MERCHANT_ADMIN" };
};

const assertWebhookRead = (request: Request): void => assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write", "application:manage"]);
const assertWebhookWrite = (request: Request): void => assertMerchantAuthority(principalOf(request), ["application:manage"]);

/** 404 when the endpoint is not the merchant's, 403 when a scoped user may not touch its application. */
const scopedEndpoint = async (request: Request, endpointId: string) => {
  const found = (await webhookService.list(merchantIdOf(request))).find((endpoint) => endpoint.id === endpointId);
  if (!found) throw new ApiError(404, "WEBHOOK_ENDPOINT_NOT_FOUND", "The webhook endpoint does not exist");
  assertApplicationInScope(request, found.applicationId);
  return found;
};

const webhookEndpointBody = z
  .object({
    url: z.string().min(1).max(2000),
    eventTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
    description: z.string().max(200).nullable().optional(),
  })
  .strict();

router.get("/webhooks/event-types", async (request: Request, response: Response) => {
  assertWebhookRead(request);
  response.json({
    eventTypes: WEBHOOK_EVENT_TYPES,
    signature: { scheme: "standard-webhooks", headers: ["webhook-id", "webhook-timestamp", "webhook-signature"], algorithm: "HMAC-SHA256 (base64) over `id.timestamp.body`" },
    retry: { maxAttempts: WEBHOOK_MAX_ATTEMPTS, delaysSeconds: WEBHOOK_RETRY_DELAYS_MS.map((ms) => Math.round(ms / 1000)), disableAfterDays: env.MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS },
  });
});

router.get("/webhooks/endpoints", async (request: Request, response: Response) => {
  assertWebhookRead(request);
  const { applicationId } = parseOrThrow(z.object({ applicationId: z.string().uuid().optional() }).passthrough(), request.query);
  if (applicationId) assertApplicationInScope(request, applicationId);
  const scope = appScopeOf(request);
  const endpoints = (await webhookService.list(merchantIdOf(request), applicationId)).filter((endpoint) => !scope || scope.includes(endpoint.applicationId));
  response.json({ endpoints });
});

router.post("/webhooks/endpoints", async (request: Request, response: Response) => {
  assertWebhookWrite(request);
  const body = parseOrThrow(webhookEndpointBody.extend({ applicationId: z.string().uuid() }).strict(), request.body);
  assertApplicationInScope(request, body.applicationId);
  const created = await webhookService.create({
    merchantId: merchantIdOf(request),
    applicationId: body.applicationId,
    url: body.url,
    eventTypes: body.eventTypes,
    description: body.description ?? null,
    actor: webhookActor(request),
  });
  response.setHeader("Cache-Control", "no-store");
  response.status(201).json(created);
});

router.patch("/webhooks/endpoints/:id", async (request: Request, response: Response) => {
  assertWebhookWrite(request);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
  const body = parseOrThrow(webhookEndpointBody.partial().extend({ enabled: z.boolean().optional() }).strict(), request.body);
  await scopedEndpoint(request, id);
  response.json(await webhookService.update({ merchantId: merchantIdOf(request), endpointId: id, ...body, actor: webhookActor(request) }));
});

router.post("/webhooks/endpoints/:id/rotate-secret", async (request: Request, response: Response) => {
  assertWebhookWrite(request);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
  await scopedEndpoint(request, id);
  response.setHeader("Cache-Control", "no-store");
  response.json(await webhookService.rotateSecret({ merchantId: merchantIdOf(request), endpointId: id, actor: webhookActor(request) }));
});

router.post("/webhooks/endpoints/:id/test", async (request: Request, response: Response) => {
  assertWebhookWrite(request);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
  await scopedEndpoint(request, id);
  response.status(202).json(await webhookService.sendTest({ merchantId: merchantIdOf(request), endpointId: id, actor: webhookActor(request) }));
});

router.get("/webhooks/deliveries", async (request: Request, response: Response) => {
  assertWebhookRead(request);
  const query = parseOrThrow(
    z
      .object({
        endpointId: z.string().uuid().optional(),
        status: z.enum(["PENDING", "DELIVERED", "PARKED"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        before: z.string().datetime().optional(),
      })
      .passthrough(),
    request.query,
  );
  if (query.endpointId) await scopedEndpoint(request, query.endpointId);
  const scope = appScopeOf(request);
  let deliveries = await webhookService.listDeliveries({ merchantId: merchantIdOf(request), ...query });
  if (scope) {
    const allowed = new Set((await webhookService.list(merchantIdOf(request))).filter((endpoint) => scope.includes(endpoint.applicationId)).map((endpoint) => endpoint.id));
    deliveries = deliveries.filter((delivery) => allowed.has(String(delivery.endpointId)));
  }
  response.json({ deliveries });
});

router.post("/webhooks/deliveries/:id/redeliver", async (request: Request, response: Response) => {
  assertWebhookWrite(request);
  const { id } = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
  if (appScopeOf(request)) {
    const deliveries = await webhookService.listDeliveries({ merchantId: merchantIdOf(request), limit: 200 });
    const row = deliveries.find((delivery) => delivery.id === id);
    if (row) await scopedEndpoint(request, String(row.endpointId));
  }
  response.status(202).json(await webhookService.redeliver({ merchantId: merchantIdOf(request), deliveryId: id, actor: webhookActor(request) }));
});

export const merchantInternalRouter = router;
export { requireMerchantScope };
