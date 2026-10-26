import { describe, expect, test } from "bun:test";
import {
  MAX_EVIDENCE_FILE_BYTES,
  toCoreApplicationCreate,
  toCoreApplicationPatch,
  toCoreCashoutCreate,
  toCoreCredentialSetCreate,
  toCoreCredentialSetUpdate,
  toCoreDisputeEvidence,
  toCorePosTerminalCreate,
  toCoreUserCreate,
  toCoreUserPatch,
  toCoreUserPatchById,
  toCoreWalletCreate,
} from "../api/contract";
import { applicationCreateSchema, applicationPatchSchema } from "../api/protected/applications";
import { cashoutCreateSchema } from "../api/protected/cashouts";
import { credentialCreateSchema, credentialUpdateSchema } from "../api/protected/credentialSets";
import { evidenceSchema } from "../api/protected/disputes";
import { terminalCreateSchema } from "../api/protected/pos";
import {
  userBulkPatchSchema,
  userCreateSchema,
  userPatchSchema,
} from "../api/protected/users";
import { walletCreateSchema } from "../api/protected/wallets";

/**
 * The canonical core contract of every merchant route.
 *
 * `core-back` is the owner of these schemas (see
 * `core-back/api/internal/merchant.ts`); the lists below are re-declared here
 * on purpose so the test stays dependency free and can prove that the edge
 * never emits a key core would reject.
 */
type FieldType = "string" | "number" | "boolean" | "object" | "array";

interface CoreField {
  type: FieldType;
  required: boolean;
  enum?: readonly string[];
  pattern?: RegExp;
}

const CORE_CONTRACTS: Record<string, Record<string, CoreField>> = {
  "POST /wallets": {
    currency: { type: "string", required: false, pattern: /^[A-Za-z]{3}$/ },
    label: { type: "string", required: false },
  },
  "POST /applications": {
    name: { type: "string", required: true },
    businessUseDescription: { type: "string", required: false },
    expectedMonthlyVolume: { type: "string", required: false, pattern: /^\d{1,12}(\.\d{1,4})?$/ },
    assignedWalletId: { type: "string", required: true },
    railWhitelist: { type: "array", required: false },
    redirectDomainAllowlist: { type: "array", required: false },
  },
  "PATCH /applications/:id": {
    name: { type: "string", required: false },
    businessUseDescription: { type: "string", required: false },
    expectedMonthlyVolume: { type: "string", required: false, pattern: /^\d{1,12}(\.\d{1,4})?$/ },
    assignedWalletId: { type: "string", required: false },
    railWhitelist: { type: "array", required: false },
    redirectDomainAllowlist: { type: "array", required: false },
  },
  "POST /users": {
    email: { type: "string", required: true },
    phone: { type: "string", required: false },
    password: { type: "string", required: true },
    role: {
      type: "string",
      required: true,
      enum: ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"],
    },
    authoritiesMap: { type: "array", required: false },
  },
  "PATCH /users": {
    id: { type: "string", required: true },
    authoritiesMap: { type: "array", required: false },
    role: {
      type: "string",
      required: false,
      enum: ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"],
    },
    status: {
      type: "string",
      required: false,
      enum: ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"],
    },
  },
  "PATCH /users/:id": {
    authoritiesMap: { type: "array", required: false },
    role: {
      type: "string",
      required: false,
      enum: ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"],
    },
    status: {
      type: "string",
      required: false,
      enum: ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"],
    },
  },
  "POST /credential-sets": {
    gatewayCode: { type: "string", required: true },
    env: { type: "string", required: true, enum: ["SANDBOX", "LIVE"] },
    externalMerchantId: { type: "string", required: true },
    settlementTarget: {
      type: "string",
      required: true,
      enum: ["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"],
    },
    entries: { type: "array", required: true },
  },
  "PUT /credential-sets/:id": {
    entries: { type: "array", required: true },
  },
  "POST /cashouts": {
    walletId: { type: "string", required: true },
    amount: { type: "string", required: true, pattern: /^\d{1,14}(\.\d{1,4})?$/ },
    destinationBank: { type: "object", required: true },
  },
  "POST /pos/terminals": {
    applicationId: { type: "string", required: true },
    name: { type: "string", required: true },
    location: { type: "string", required: false },
  },
  "POST /disputes/:id/evidence": {
    evidence: { type: "object", required: true },
    notes: { type: "string", required: false },
  },
};

const matchesType = (value: unknown, type: FieldType): boolean => {
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
};

/**
 * Asserts that the mapped payload is a valid payload for the core route:
 * every emitted key is accepted by core, every required core key is present
 * and the values respect the canonical types.
 */
const assertCorePayload = (
  route: string,
  payload: Record<string, unknown>,
  options: { requireAll?: boolean } = {},
): void => {
  const contract = CORE_CONTRACTS[route];
  expect(contract, `no core contract declared for ${route}`).toBeDefined();
  if (!contract) return;
  for (const [key, value] of Object.entries(payload)) {
    const field = contract[key];
    expect(field, `${route} emitted "${key}" which core does not accept`).toBeDefined();
    if (!field) continue;
    expect(matchesType(value, field.type), `${route}.${key} has an unexpected type`).toBe(true);
    if (field.type === "string" && field.pattern) {
      expect(value as string).toMatch(field.pattern);
    }
    if (field.enum) {
      expect(field.enum as readonly string[]).toContain(value as string);
    }
  }
  if (options.requireAll === false) return;
  for (const [key, field] of Object.entries(contract)) {
    if (!field.required) continue;
    expect(payload, `${route} is missing the core key "${key}"`).toHaveProperty(key);
  }
};

describe("canonical core contract of the merchant channel", () => {
  test("POST /wallets drops the keys core does not accept", () => {
    const mapped = toCoreWalletCreate({
      applicationId: "app_1",
      label: "Main wallet",
      currency: "LYD",
      openingAmount: "10.0000",
    });
    expect(mapped).toEqual({ currency: "LYD", label: "Main wallet" });
    assertCorePayload("POST /wallets", mapped);
  });

  test("POST /applications maps the portal vocabulary onto the canonical one", () => {
    const mapped = toCoreApplicationCreate({
      name: "Storefront",
      description: "Online sales channel",
      website: "https://shop.example",
      category: "RETAIL",
      settlementCurrency: "LYD",
      contactEmail: "ops@example.com",
      contactPhone: "0912345678",
      assignedWalletId: "wal_1",
      expectedMonthlyVolume: "1500.0000",
      railWhitelist: ["CASH"],
      redirectDomainAllowlist: ["https://shop.example"],
    });
    expect(mapped).toEqual({
      name: "Storefront",
      businessUseDescription: "Online sales channel",
      expectedMonthlyVolume: "1500.0000",
      assignedWalletId: "wal_1",
      railWhitelist: ["CASH"],
      redirectDomainAllowlist: ["https://shop.example"],
    });
    assertCorePayload("POST /applications", mapped);
  });

  test("POST /applications omits the canonical keys the portal does not expose", () => {
    const mapped = toCoreApplicationCreate({ name: "Storefront", description: "Online sales" });
    expect(mapped).toEqual({ name: "Storefront", businessUseDescription: "Online sales" });
    expect(Object.keys(mapped)).not.toContain("expectedMonthlyVolume");
    expect(Object.keys(mapped)).not.toContain("railWhitelist");
    expect(Object.keys(mapped)).not.toContain("redirectDomainAllowlist");
    assertCorePayload("POST /applications", mapped, { requireAll: false });
  });

  test("PATCH /applications/:id maps the portal vocabulary onto the canonical one", () => {
    const mapped = toCoreApplicationPatch({
      name: "Storefront",
      description: "Online sales channel",
      website: "https://shop.example",
      category: "RETAIL",
      contactEmail: "ops@example.com",
      contactPhone: "0912345678",
      baseVersion: 3,
    });
    expect(mapped).toEqual({ name: "Storefront", businessUseDescription: "Online sales channel" });
    assertCorePayload("PATCH /applications/:id", mapped);
  });

  test("PATCH /applications/:id flattens the sensitive portal payload", () => {
    const mapped = toCoreApplicationPatch({
      sensitive: {
        assignedWalletId: "wal_1",
        railWhitelist: ["CASH"],
        redirectDomainAllowlist: ["https://shop.example"],
      },
      reason: "settlement change",
    });
    expect(mapped).toEqual({
      assignedWalletId: "wal_1",
      railWhitelist: ["CASH"],
      redirectDomainAllowlist: ["https://shop.example"],
    });
    assertCorePayload("PATCH /applications/:id", mapped);
  });

  test("POST /users maps the portal vocabulary onto the canonical one", () => {
    const mapped = toCoreUserCreate({
      email: "ops@example.com",
      phone: "0912345678",
      fullName: "Ops User",
      password: "Sup3rSecretPass",
      role: "MERCHANT_STAFF",
      locale: "en",
      authoritiesMap: { "merchant:read": true, "merchant:write": false },
    });
    expect(mapped).toEqual({
      email: "ops@example.com",
      phone: "0912345678",
      password: "Sup3rSecretPass",
      role: "MERCHANT_STAFF",
      authoritiesMap: ["merchant:read"],
    });
    assertCorePayload("POST /users", mapped);
  });

  test("POST /users accepts the canonical authority list as well", () => {
    const mapped = toCoreUserCreate({
      email: "ops@example.com",
      fullName: "Ops User",
      password: "Sup3rSecretPass",
      role: "MERCHANT_STAFF",
      authoritiesMap: ["merchant:read", "payment:read"],
    });
    expect(mapped.authoritiesMap).toEqual(["merchant:read", "payment:read"]);
    assertCorePayload("POST /users", mapped);
  });

  test("PATCH /users carries the target user in the body like core does", () => {
    const mapped = toCoreUserPatch({
      userIds: ["usr_1", "usr_2"],
      id: "usr_1",
      role: "MERCHANT_STAFF",
      status: "ACTIVE",
      reason: "rotation",
    });
    expect(mapped).toEqual({ id: "usr_1", role: "MERCHANT_STAFF", status: "ACTIVE" });
    assertCorePayload("PATCH /users", mapped);
  });

  test("PATCH /users/:id drops the keys core does not accept", () => {
    const mapped = toCoreUserPatchById({
      fullName: "Ops User",
      role: "MERCHANT_CASHIER",
      status: "SUSPENDED",
      locale: "ar",
      baseVersion: 2,
    });
    expect(mapped).toEqual({ role: "MERCHANT_CASHIER", status: "SUSPENDED" });
    assertCorePayload("PATCH /users/:id", mapped);
  });

  test("POST /credential-sets maps the portal vocabulary onto the canonical one", () => {
    const mapped = toCoreCredentialSetCreate({
      name: "Gateway credentials",
      gatewayId: "gw_1",
      environment: "sandbox",
      ownership: "MERCHANT_DIRECT",
      authMethod: "API_KEY",
      secrets: { apiKey: "secret-value" },
      settings: { timeout: 30 },
      externalMerchantId: "merch-42",
    });
    expect(mapped).toEqual({
      gatewayCode: "gw_1",
      env: "SANDBOX",
      externalMerchantId: "merch-42",
      settlementTarget: "MERCHANT_DIRECT",
      entries: [{ key: "apiKey", type: "HEADER", value: "secret-value", isSecret: true }],
    });
    assertCorePayload("POST /credential-sets", mapped);
  });

  test("POST /credential-sets maps the canonical payload one to one", () => {
    const mapped = toCoreCredentialSetCreate({
      name: "Gateway credentials",
      gatewayCode: "FASTERPAY",
      env: "LIVE",
      externalMerchantId: "merch-42",
      settlementTarget: "PLATFORM_CLEARING",
      entries: [{ key: "apiKey", type: "HEADER", value: "secret-value" }],
    });
    expect(mapped).toEqual({
      gatewayCode: "FASTERPAY",
      env: "LIVE",
      externalMerchantId: "merch-42",
      settlementTarget: "PLATFORM_CLEARING",
      entries: [{ key: "apiKey", type: "HEADER", value: "secret-value" }],
    });
    assertCorePayload("POST /credential-sets", mapped);
  });

  test("PUT /credential-sets/:id maps the portal secrets onto the canonical entries", () => {
    const mapped = toCoreCredentialSetUpdate({
      name: "Gateway credentials",
      secrets: { apiKey: "secret-value" },
      settings: { timeout: 30 },
    });
    expect(mapped).toEqual({
      entries: [{ key: "apiKey", type: "HEADER", value: "secret-value", isSecret: true }],
    });
    assertCorePayload("PUT /credential-sets/:id", mapped);
  });

  test("POST /cashouts maps the portal vocabulary onto the canonical one", () => {
    const mapped = toCoreCashoutCreate({
      walletId: "wal_1",
      amount: "250.0000",
      currency: "LYD",
      bankAccountId: "bank_1",
      reference: "INV-1",
      idempotencyKey: "idem-00000001",
    });
    expect(mapped).toEqual({
      walletId: "wal_1",
      amount: "250.0000",
      destinationBank: { bankAccountId: "bank_1" },
    });
    assertCorePayload("POST /cashouts", mapped);
  });

  test("POST /cashouts forwards the canonical destination bank untouched", () => {
    const mapped = toCoreCashoutCreate({
      walletId: "wal_1",
      amount: "250.0000",
      currency: "LYD",
      destinationBank: { iban: "LY00", swift: "LYBA" },
    });
    expect(mapped).toEqual({
      walletId: "wal_1",
      amount: "250.0000",
      destinationBank: { iban: "LY00", swift: "LYBA" },
    });
    assertCorePayload("POST /cashouts", mapped);
  });

  test("POST /pos/terminals drops the keys core does not accept", () => {
    const mapped = toCorePosTerminalCreate({
      name: "Till 1",
      applicationId: "app_1",
      location: "Tripoli",
      deviceId: "device-9",
    });
    expect(mapped).toEqual({ name: "Till 1", applicationId: "app_1", location: "Tripoli" });
    assertCorePayload("POST /pos/terminals", mapped);
  });

  test("POST /disputes/:id/evidence sends a canonical json payload", () => {
    const file = {
      originalname: "receipt.pdf",
      buffer: Buffer.from("%PDF-1.7\nreceipt\n%%EOF\n", "utf8"),
    };
    const mapped = toCoreDisputeEvidence(
      file,
      { evidenceType: "RECEIPT", notes: "proof of delivery", occurredAt: "2026-01-05" },
      "application/pdf",
    );
    expect(Object.keys(mapped).sort()).toEqual(["evidence", "notes"]);
    expect(mapped.notes).toBe("proof of delivery");
    const evidence = mapped.evidence as Record<string, unknown>;
    expect(evidence.evidenceType).toBe("RECEIPT");
    expect(evidence.occurredAt).toBe("2026-01-05");
    expect(evidence.fileName).toBe("receipt.pdf");
    expect(evidence.contentType).toBe("application/pdf");
    expect(evidence.sizeBytes).toBe(file.buffer.byteLength);
    expect(evidence.sha256).toBeString();
    expect(Buffer.from(evidence.contentBase64 as string, "base64").equals(file.buffer)).toBe(true);
    assertCorePayload("POST /disputes/:id/evidence", mapped);
  });

  test("the evidence payload stays inside the core json body limit", () => {
    expect(MAX_EVIDENCE_FILE_BYTES).toBeGreaterThan(0);
    expect(MAX_EVIDENCE_FILE_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe("public merchant contract stays backwards compatible", () => {
  test("the wallet payload of the portal is still accepted", () => {
    const parsed = walletCreateSchema.safeParse({
      applicationId: "app_1",
      label: "Main wallet",
      currency: "LYD",
      openingAmount: "10.0000",
    });
    expect(parsed.success).toBe(true);
  });

  test("the application payload of the portal is still accepted", () => {
    const parsed = applicationCreateSchema.safeParse({
      name: "Storefront",
      description: "Online sales channel",
      website: "https://shop.example",
      category: "RETAIL",
      settlementCurrency: "LYD",
      contactEmail: "ops@example.com",
      contactPhone: "0912345678",
    });
    expect(parsed.success).toBe(true);
  });

  test("the application patch payload of the portal is still accepted", () => {
    const parsed = applicationPatchSchema.safeParse({
      name: "Storefront",
      description: "Online sales channel",
      website: "https://shop.example",
      category: "RETAIL",
      contactEmail: "ops@example.com",
      contactPhone: "0912345678",
      baseVersion: 2,
    });
    expect(parsed.success).toBe(true);
  });

  test("the user payload of the portal is still accepted", () => {
    const parsed = userCreateSchema.safeParse({
      email: "ops@example.com",
      phone: "0912345678",
      fullName: "Ops User",
      role: "MERCHANT_STAFF",
      locale: "en",
    });
    expect(parsed.success).toBe(true);
  });

  test("the bulk user patch payload of the portal is still accepted", () => {
    const parsed = userBulkPatchSchema.safeParse({
      userIds: ["usr_1", "usr_2"],
      role: "MERCHANT_STAFF",
      status: "ACTIVE",
      reason: "rotation",
    });
    expect(parsed.success).toBe(true);
  });

  test("the user patch payload of the portal is still accepted", () => {
    const parsed = userPatchSchema.safeParse({
      fullName: "Ops User",
      role: "MERCHANT_CASHIER",
      status: "SUSPENDED",
      locale: "ar",
      baseVersion: 2,
    });
    expect(parsed.success).toBe(true);
  });

  test("the credential set payload of the portal is still accepted", () => {
    const parsed = credentialCreateSchema.safeParse({
      name: "Gateway credentials",
      gatewayId: "gw_1",
      environment: "sandbox",
      ownership: "MERCHANT_DIRECT",
      authMethod: "API_KEY",
      secrets: { apiKey: "secret-value" },
      settings: { timeout: 30 },
    });
    expect(parsed.success).toBe(true);
  });

  test("the credential set update payload of the portal is still accepted", () => {
    const parsed = credentialUpdateSchema.safeParse({
      name: "Gateway credentials",
      secrets: { apiKey: "secret-value" },
      settings: { timeout: 30 },
    });
    expect(parsed.success).toBe(true);
  });

  test("the cashout payload of the portal is still accepted", () => {
    const parsed = cashoutCreateSchema.safeParse({
      walletId: "wal_1",
      amount: "250.0000",
      currency: "LYD",
      bankAccountId: "bank_1",
      reference: "INV-1",
      idempotencyKey: "idem-00000001",
    });
    expect(parsed.success).toBe(true);
  });

  test("the pos terminal payload of the portal is still accepted", () => {
    const parsed = terminalCreateSchema.safeParse({
      name: "Till 1",
      applicationId: "app_1",
      location: "Tripoli",
      deviceId: "device-9",
    });
    expect(parsed.success).toBe(true);
  });

  test("the evidence metadata of the portal is still accepted", () => {
    const parsed = evidenceSchema.safeParse({
      evidenceType: "RECEIPT",
      notes: "proof of delivery",
      occurredAt: "2026-01-05",
    });
    expect(parsed.success).toBe(true);
  });

  test("the public schemas still reject unknown keys", () => {
    expect(
      walletCreateSchema.safeParse({
        applicationId: "app_1",
        label: "Main wallet",
        currency: "LYD",
        unknownKey: true,
      }).success,
    ).toBe(false);
    expect(
      applicationCreateSchema.safeParse({ name: "Storefront", unknownKey: true }).success,
    ).toBe(false);
  });
});
