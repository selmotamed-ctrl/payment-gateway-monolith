import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Canonical contract of the merchant channel.
 *
 * `core-back` owns the canonical vocabulary of every `/internal/merchant/*`
 * route (see `core-back/api/internal/merchant.ts`). The schemas below mirror
 * the core schemas one-to-one, and the mappers translate the merchant portal
 * (public) payload into the canonical (core) payload.
 *
 * Rules obeyed by every mapper:
 * - only keys accepted by the core schema are emitted (core schemas are strict);
 * - keys required by the core schema are always emitted;
 * - renamed fields are mapped explicitly, unknown keys are never passed through;
 * - optional core fields that the public API does not expose are omitted.
 */

export type PublicPayload = Record<string, unknown>;
export type CorePayload = Record<string, unknown>;

/* -------------------------------------------------------------------------- *
 * helpers
 * -------------------------------------------------------------------------- */

const compact = (payload: CorePayload): CorePayload => {
  const result: CorePayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asPlainObject = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const normalizeAuthorities = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  const record = asPlainObject(value);
  if (!record) return undefined;
  return Object.entries(record)
    .filter(([, enabled]) => enabled === true)
    .map(([authority]) => authority);
};

const normalizeCredentialEnv = (value: unknown): "SANDBOX" | "LIVE" | undefined => {
  const normalized = asString(value)?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized === "LIVE" || normalized === "PRODUCTION") return "LIVE";
  if (
    normalized === "SANDBOX" ||
    normalized === "TEST" ||
    normalized === "UAT" ||
    normalized === "STAGING" ||
    normalized === "DEV" ||
    normalized === "DEVELOPMENT"
  ) {
    return "SANDBOX";
  }
  return undefined;
};

const normalizeSettlementTarget = (
  value: unknown,
): "PLATFORM_CLEARING" | "MERCHANT_DIRECT" | "PROVIDER_HELD" | undefined => {
  switch (asString(value)?.trim().toUpperCase()) {
    case "MERCHANT_DIRECT":
      return "MERCHANT_DIRECT";
    case "PLATFORM_CLEARING":
    case "PLATFORM_MANAGED":
      return "PLATFORM_CLEARING";
    case "PROVIDER_HELD":
      return "PROVIDER_HELD";
    default:
      return undefined;
  }
};

const CREDENTIAL_ENTRY_TYPES = ["HEADER", "QUERY", "BODY", "CERTIFICATE"] as const;

const normalizeCredentialEntries = (value: unknown): unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  const record = asPlainObject(value);
  if (!record) return undefined;
  return Object.entries(record).map(([key, raw]) => ({
    key,
    type: "HEADER" as (typeof CREDENTIAL_ENTRY_TYPES)[number],
    value: typeof raw === "string" ? raw : JSON.stringify(raw ?? null),
    isSecret: true,
  }));
};

const normalizeDestinationBank = (value: unknown): Record<string, unknown> | undefined => {
  const record = asPlainObject(value);
  if (record) return record;
  const accountId = asString(value);
  return accountId ? { bankAccountId: accountId } : undefined;
};

/* -------------------------------------------------------------------------- *
 * canonical core schemas (mirrors of core-back/api/internal/merchant.ts)
 * -------------------------------------------------------------------------- */

const coreId = z.string().min(1).max(64);
const coreAmount = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const coreVolume = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/);
const coreJsonRecord = z.record(z.string().max(64), z.unknown());
const coreUserRole = z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]);
const coreUserStatus = z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]);
const coreAuthorityList = z.array(z.string().min(2).max(64)).max(50);

export const coreCredentialEntrySchema = z.object({
  key: z.string().min(1).max(64),
  type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]),
  value: z.string().max(4096),
  isSecret: z.boolean().default(true),
});

export const coreWalletCreateSchema = z
  .object({
    currency: z.string().length(3).default("LYD"),
    label: z.string().max(80).optional(),
  })
  .strict();

export const coreApplicationCreateSchema = z
  .object({
    name: z.string().min(2).max(160),
    businessUseDescription: z.string().max(2000).optional(),
    expectedMonthlyVolume: coreVolume.optional(),
    assignedWalletId: coreId,
    railWhitelist: z.array(z.string().min(1).max(64)).min(1).optional(),
    redirectDomainAllowlist: z.array(z.string().min(1).max(200)).min(1).optional(),
  })
  .strict();

export const coreApplicationPatchSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    businessUseDescription: z.string().max(2000).optional(),
    expectedMonthlyVolume: coreVolume.optional(),
    assignedWalletId: coreId.optional(),
    railWhitelist: z.array(z.string().min(1).max(64)).min(1).optional(),
    redirectDomainAllowlist: z.array(z.string().min(1).max(200)).min(1).optional(),
  })
  .strict();

export const coreUserCreateSchema = z
  .object({
    email: z.email(),
    phone: z.string().min(6).max(20).optional(),
    password: z.string().min(10).max(128),
    role: coreUserRole,
    authoritiesMap: coreAuthorityList.default([]),
  })
  .strict();

export const coreUserPatchSchema = z
  .object({
    id: coreId,
    authoritiesMap: coreAuthorityList.optional(),
    role: coreUserRole.optional(),
    status: coreUserStatus.optional(),
  })
  .strict();

export const coreUserPatchByIdSchema = z
  .object({
    authoritiesMap: coreAuthorityList.optional(),
    role: coreUserRole.optional(),
    status: coreUserStatus.optional(),
  })
  .strict();

export const coreCredentialSetCreateSchema = z
  .object({
    gatewayCode: z.string().min(2).max(64),
    env: z.enum(["SANDBOX", "LIVE"]),
    externalMerchantId: z.string().min(2).max(120),
    settlementTarget: z.enum(["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]),
    entries: z.array(coreCredentialEntrySchema).min(1).max(40),
  })
  .strict();

export const coreCredentialSetUpdateSchema = z
  .object({
    entries: z.array(coreCredentialEntrySchema).min(1).max(40),
  })
  .strict();

export const coreCashoutCreateSchema = z
  .object({
    walletId: coreId,
    amount: coreAmount,
    destinationBank: coreJsonRecord,
  })
  .strict();

export const corePosTerminalCreateSchema = z
  .object({
    applicationId: coreId,
    name: z.string().min(1).max(120),
    location: z.string().max(200).optional(),
  })
  .strict();

export const corePosTerminalPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    location: z.string().max(200).optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]).optional(),
  })
  .strict();

export const coreDisputeEvidenceSchema = z
  .object({
    evidence: coreJsonRecord,
    notes: z.string().max(4000).optional(),
  })
  .strict();

export const coreJoinRequestSchema = z
  .object({
    legalName: z.string().min(2).max(160).optional(),
    tradeName: z.string().min(2).max(160).optional(),
    country: z.string().length(2).optional(),
    businessType: z.string().min(2).max(64).optional(),
    registrationNumber: z.string().min(2).max(64).optional(),
    taxNumber: z.string().min(2).max(64).optional(),
    address: z.string().min(4).max(400).optional(),
    phone: z.string().min(6).max(20).optional(),
    email: z.email().optional(),
    website: z.string().max(200).optional(),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict();

export const coreBeneficialOwnerSchema = z
  .object({
    fullName: z.string().min(2).max(160),
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
    identityNumber: z.string().min(4).max(32),
    nationality: z.string().min(2).max(64).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ownershipPercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
    position: z.string().min(2).max(80).optional(),
  })
  .strict();

export const coreOnboardingSubmitSchema = z
  .object({
    acknowledgement: z.literal(true),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

export const coreLinkCreateSchema = z
  .object({
    title: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    amount: coreAmount,
    currency: z.string().length(3),
    feeBearer: z
      .enum(["PAYER", "MERCHANT", "PLATFORM", "MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"])
      .optional(),
    applicationId: coreId.optional(),
    walletId: coreId.optional(),
    expiresAt: z.string().max(64).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    infiniteUse: z.boolean().optional(),
    activeSlots: z.number().int().min(1).max(100_000).optional(),
    allowedRails: z.array(z.string().min(1).max(64)).max(50).optional(),
    metadata: coreJsonRecord.optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

export const coreTokenCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    scopes: z.array(z.string().min(2).max(64)).min(1).max(50),
    allowedCidrs: z.array(z.string().min(3).max(64)).max(64).optional(),
    applicationId: coreId.optional(),
    expiresAt: z.string().max(64).optional(),
  })
  .strict();

export const coreTokenIpsSchema = z
  .object({
    allowedCidrs: z.array(z.string().min(3).max(64)).max(64),
  })
  .strict();

export const coreRegisterSchema = z
  .object({
    phone: z.string().min(6).max(20).optional(),
    email: z.email().optional(),
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

export const coreVerifyIdentitySchema = z
  .object({
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
    identityNumber: z.string().min(4).max(32),
    phone: z.string().min(6).max(20),
    code: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

export const coreLoginSchema = z
  .object({
    identifier: z.string().min(3).max(128),
    password: z.string().min(1).max(128),
  })
  .strict();

export const coreGoogleSchema = z.object({ idToken: z.string().min(20).max(4096) }).strict();

export const coreMfaSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    challengeId: z.string().min(4).max(4096).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- *
 * mappers: public payload -> canonical core payload
 * -------------------------------------------------------------------------- */

/** POST /wallets */
export const toCoreWalletCreate = (body: PublicPayload): CorePayload =>
  compact({
    currency: asString(body.currency),
    label: asString(body.label),
  });

/** POST /applications */
export const toCoreApplicationCreate = (body: PublicPayload): CorePayload =>
  compact({
    name: body.name,
    businessUseDescription: body.description ?? body.businessUseDescription,
    expectedMonthlyVolume: body.expectedMonthlyVolume,
    assignedWalletId: body.assignedWalletId,
    railWhitelist: body.railWhitelist,
    redirectDomainAllowlist: body.redirectDomainAllowlist,
  });

/** PATCH /applications/:id */
export const toCoreApplicationPatch = (body: PublicPayload): CorePayload => {
  const sensitive = asPlainObject(body.sensitive) ?? {};
  return compact({
    name: body.name,
    businessUseDescription: body.description ?? body.businessUseDescription,
    expectedMonthlyVolume: body.expectedMonthlyVolume,
    assignedWalletId: body.assignedWalletId ?? sensitive.assignedWalletId,
    railWhitelist: body.railWhitelist ?? sensitive.railWhitelist,
    redirectDomainAllowlist: body.redirectDomainAllowlist ?? sensitive.redirectDomainAllowlist,
  });
};

/** POST /users */
export const toCoreUserCreate = (body: PublicPayload): CorePayload =>
  compact({
    email: body.email,
    phone: body.phone,
    password: body.password,
    role: body.role,
    authoritiesMap: normalizeAuthorities(body.authoritiesMap),
  });

/** PATCH /users (core carries the target user in the body) */
export const toCoreUserPatch = (body: PublicPayload): CorePayload =>
  compact({
    id: body.id,
    authoritiesMap: normalizeAuthorities(body.authoritiesMap),
    role: body.role,
    status: body.status,
  });

/** PATCH /users/:id */
export const toCoreUserPatchById = (body: PublicPayload): CorePayload =>
  compact({
    authoritiesMap: normalizeAuthorities(body.authoritiesMap),
    role: body.role,
    status: body.status,
  });

/** POST /credential-sets */
export const toCoreCredentialSetCreate = (body: PublicPayload): CorePayload =>
  compact({
    gatewayCode: asString(body.gatewayCode) ?? asString(body.gatewayId),
    env: normalizeCredentialEnv(body.env ?? body.environment),
    externalMerchantId: asString(body.externalMerchantId),
    settlementTarget: normalizeSettlementTarget(body.settlementTarget ?? body.ownership),
    entries: normalizeCredentialEntries(body.entries ?? body.secrets),
  });

/** PUT /credential-sets/:id */
export const toCoreCredentialSetUpdate = (body: PublicPayload): CorePayload =>
  compact({
    entries: normalizeCredentialEntries(body.entries ?? body.secrets),
  });

/** POST /cashouts */
export const toCoreCashoutCreate = (body: PublicPayload): CorePayload =>
  compact({
    walletId: body.walletId,
    amount: body.amount,
    destinationBank: normalizeDestinationBank(body.destinationBank ?? body.bankAccountId),
  });

/** POST /pos/terminals */
export const toCorePosTerminalCreate = (body: PublicPayload): CorePayload =>
  compact({
    applicationId: body.applicationId,
    name: body.name,
    location: body.location,
  });

/* -------------------------------------------------------------------------- *
 * dispute evidence (multipart -> canonical JSON)
 * -------------------------------------------------------------------------- */

/** core-back parses JSON bodies with a 1mb limit, the evidence travels base64 encoded. */
export const CORE_JSON_BODY_LIMIT_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_FILE_BYTES = Math.floor(
  ((CORE_JSON_BODY_LIMIT_BYTES - 96 * 1024) * 3) / 4,
);

export interface EvidenceUpload {
  originalname: string;
  buffer: Buffer;
}

/**
 * POST /disputes/:id/evidence
 *
 * core-back expects `{ evidence, notes? }` where `evidence` is a flat record.
 * The uploaded document is embedded base64 encoded so the payload stays a
 * regular JSON body.
 */
export const toCoreDisputeEvidence = (
  file: EvidenceUpload,
  metadata: PublicPayload,
  detectedMime: string,
): CorePayload => {
  const evidence: Record<string, unknown> = {
    fileName: file.originalname.slice(0, 200),
    contentType: detectedMime,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    sizeBytes: file.buffer.byteLength,
    contentBase64: file.buffer.toString("base64"),
  };
  const evidenceType = asString(metadata.evidenceType);
  if (evidenceType) evidence.evidenceType = evidenceType;
  const occurredAt = asString(metadata.occurredAt);
  if (occurredAt) evidence.occurredAt = occurredAt;
  const notes = asString(metadata.notes);
  return notes ? { evidence, notes } : { evidence };
};
