import { describe, expect, test } from "bun:test";
import { AttemptGuardPipeline, SELF_PAYMENT_POLICY_SETTING_KEY } from "../engine/guards/AttemptGuardPipeline";
import {
  CachedScreeningProvider,
  InternalWatchlistProvider,
  MockScreeningProvider,
  type ScreeningProvider,
  type ScreeningResult,
} from "../engine/guards/ScreeningProvider";
import { checkoutInternals, type RailFieldRule } from "../api/internal/checkout";
import { assertUploadSignature, detectUploadMime } from "../api/internal/merchant";
import { ApiError } from "../lib/error";
import { createGuardFixture } from "./helpers/guardsFake";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const guardRequest = (overrides: Record<string, unknown> = {}) => ({
  linkKey: "link-key-1",
  railCode: "edfali",
  applicationId: "application-1",
  merchantId: "merchant-1",
  env: "SANDBOX" as const,
  channel: "WEB" as const,
  mode: "OTP_PULL",
  idempotencyKey: "idem-compliance-1",
  ...overrides,
});

const screeningErrorResult = (): ScreeningResult => ({
  result: "ERROR",
  matches: [],
  highestScore: null,
  providerCode: "UNAVAILABLE",
  providerRequestRef: null,
  listVersions: {},
  inputHash: "",
  error: "provider unavailable",
});

const unavailableScreeningProvider = (): ScreeningProvider => {
  const provider: ScreeningProvider = new MockScreeningProvider({
    providerCode: "UNAVAILABLE",
    result: "ERROR",
    errorMessage: "provider unavailable",
  });
  provider.screenLocal = () => screeningErrorResult();
  return provider;
};

const apiErrorOf = (action: () => void): ApiError => {
  try {
    action();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected an ApiError");
};

describe("defect 124 - an unavailable screening fails closed on the hot path", () => {
  test("an ERROR screening result produces a terminal BLOCKED attempt and reserves no slot", async () => {
    const fixture = createGuardFixture();
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: unavailableScreeningProvider(),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toBe("SCREENING_UNAVAILABLE");
    expect(decision.slotReserved).toBe(false);
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.slotDeltas).toEqual([]);
  });

  test("a provider without a local list is unavailable, not clean", async () => {
    const fixture = createGuardFixture();
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new MockScreeningProvider({ result: "CLEAR" }),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toBe("SCREENING_UNAVAILABLE");
    expect(fixture.state.slotDeltas).toEqual([]);
  });
});

describe("defect 134 - the anti-self-dealing policy", () => {
  test("a payer wallet that is the merchant settlement wallet is blocked", async () => {
    const fixture = createGuardFixture();
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(
      guardRequest({ customer: { walletId: fixture.state.link.walletId } }),
    );

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toBe("SELF_PAYMENT_NOT_ALLOWED");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.slotDeltas).toEqual([]);
  });

  test("another payer wallet is allowed by the default policy", async () => {
    const fixture = createGuardFixture();
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(
      guardRequest({ customer: { walletId: "NP-010000000009" } }),
    );

    expect(decision.outcome).toBe("ALLOW");
    expect(fixture.state.slotDeltas).toEqual([1]);
  });

  test("a deployment can only loosen the policy explicitly", async () => {
    const fixture = createGuardFixture({
      platformSettings: { [SELF_PAYMENT_POLICY_SETTING_KEY]: "ALLOW" },
    });
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(
      guardRequest({ customer: { walletId: fixture.state.link.walletId } }),
    );

    expect(decision.outcome).toBe("ALLOW");
  });
});

describe("defects 131 and 138 - NeomPay rail field validation", () => {
  const walletField: RailFieldRule = {
    key: "wallet_id",
    type: "WALLET_ID",
    checksum: "LUHN",
    regex: "^NP-[0-9]{12}$",
    minLength: 15,
    maxLength: 15,
    required: false,
    optionsJson: {
      wallet_types: ["01", "02", "03", "04", "05"],
    },
  };
  const validate = (walletId: string): void =>
    checkoutInternals.validateRailFields([walletField], { wallet_id: walletId });

  test("a valid NeomPay wallet id passes regex, Luhn and the wallet-type allow-list", () => {
    expect(() => validate("NP-010000000009")).not.toThrow();
    expect(checkoutInternals.isValidLuhn("NP-010000000009")).toBe(true);
  });

  test("a wallet id that fails the regex is rejected with a field-level 400", () => {
    const error = apiErrorOf(() => validate("NP-00000000000A"));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("RAIL_FIELD_INVALID");
    expect(error.details).toMatchObject({ field: "wallet_id", reason: "REGEX" });
  });

  test("a wallet id that fails the Luhn check digit is rejected before any money moves", () => {
    const error = apiErrorOf(() => validate("NP-010000000000"));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("RAIL_FIELD_INVALID");
    expect(error.details).toMatchObject({ field: "wallet_id", reason: "CHECKSUM" });
  });

  test("a wallet type outside the options_json allow-list is rejected", () => {
    const error = apiErrorOf(() => validate("NP-990000000002"));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("RAIL_FIELD_INVALID");
    expect(error.details).toMatchObject({ field: "wallet_id", reason: "WALLET_TYPE_NOT_ALLOWED" });
  });

  test("a required field that is missing is rejected", () => {
    const error = apiErrorOf(() =>
      checkoutInternals.validateRailFields([{ ...walletField, required: true }], {}),
    );
    expect(error.statusCode).toBe(400);
    expect(error.details).toMatchObject({ field: "wallet_id", reason: "REQUIRED" });
  });

  test("min and max length are enforced from the rail descriptor", () => {
    const error = apiErrorOf(() =>
      checkoutInternals.validateRailFields(
        [{ key: "phone", type: "PHONE", minLength: 8, maxLength: 10, required: true }],
        { phone: "123" },
      ),
    );
    expect(error.details).toMatchObject({ field: "phone", reason: "MIN_LENGTH" });
  });
});

describe("defect 90 - KYB upload magic-byte verification", () => {
  test("a PE executable that claims to be a PDF is rejected", () => {
    const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(detectUploadMime(peHeader)).toBeNull();
    const error = apiErrorOf(() => assertUploadSignature(peHeader, "application/pdf"));
    expect(error.statusCode).toBe(415);
    expect(error.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });

  test("a real PDF is detected and accepted", () => {
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "utf8");
    expect(detectUploadMime(pdf)).toBe("application/pdf");
    expect(assertUploadSignature(pdf, "application/pdf")).toBe("application/pdf");
  });

  test("a real PNG declared as a PDF is rejected", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const error = apiErrorOf(() => assertUploadSignature(png, "application/pdf"));
    expect(error.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });

  test("an unrecognised payload is rejected even when the declared type is allowed", () => {
    const error = apiErrorOf(() =>
      assertUploadSignature(Buffer.from("not a document"), "application/pdf"),
    );
    expect(error.statusCode).toBe(415);
    expect(error.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });
});
