import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { InMemoryKeyProvider } from "../../lib/objectStorageSdk/crypto";
import { PrismaCallbackVerifier } from "../../engine/runtime/callbackVerifier";
import { Vault } from "../../engine/crypto/Vault";

/**
 * Regression pins for the 2026-11-16 review (HEAD 55fcedd).
 *
 *  - Merchant reads must not leak reviewer/AML/tipping-off material, payout
 *    bank data, another application's payments or another application's
 *    webhook delivery, and every sensitive read needs an authority.
 *  - Admin mutations must not be reachable with a read-only AML grant, and a
 *    LIVE gateway version must not be editable in place.
 *  - Inbound callbacks are bound to the URL's environment and an IP_ONLY
 *    channel without an allowlist fails closed.
 *  - The object-storage KEK has no deterministic production fallback.
 */

const core = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const merchant = core("api/internal/merchant.ts");
const admin = core("api/internal/admin.ts");
const verifierSource = core("engine/runtime/callbackVerifier.ts");
const storageCrypto = core("lib/objectStorageSdk/crypto.ts");

const routeBody = (source: string, signature: string): string => {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nrouter.", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
};

describe("merchant read exposure", () => {
  test("join-request and kyb revalidations need an onboarding/merchant read authority", () => {
    for (const signature of ['router.get("/onboarding/join-request"', 'router.get("/onboarding/kyb-revalidations"']) {
      const body = routeBody(merchant, signature);
      expect(body).toContain('assertMerchantAuthority(principalOf(request), ["onboarding:write", "merchant:read", "merchant:write"]);');
      expect(body).not.toContain("include:");
    }
  });

  test("onboarding submit and beneficial owner create do not return screening results", () => {
    const submit = routeBody(merchant, 'router.post("/onboarding/submit"');
    expect(submit).not.toContain("screeningId:");
    expect(submit).not.toContain("screeningResult:");
    expect(submit).not.toContain("fourEyesPolicy:");
    expect(submit).toContain("ONBOARDING_UNDER_REVIEW");
    const owner = routeBody(merchant, 'router.post("/onboarding/beneficial-owners"');
    expect(owner).not.toContain("screeningStatus");
  });

  test("the cash-out list never selects the payout bank, replay key or requester", () => {
    const body = routeBody(merchant, 'router.get("/cashouts"');
    expect(body).toContain("select: {");
    expect(body).not.toContain("destinationBankJson: true");
    expect(body).not.toContain("idempotencyKey: true");
    expect(body).not.toContain("requestedByUserId: true");
  });

  test("the POS stream needs a read authority and is limited to the screen's application", () => {
    const body = routeBody(merchant, 'router.get("/pos/screens/:screenCode/stream"');
    expect(body).toContain("assertMerchantAuthority(principalOf(request), POS_READ_AUTHORITIES);");
    expect(body).toContain("applicationId: screen.pos.applicationId");
    expect(body).toContain("event.applicationId !== screen.pos.applicationId");
  });

  test("redelivery always resolves the delivery's endpoint before the application-scope check", () => {
    const body = routeBody(merchant, 'router.post("/webhooks/deliveries/:id/redeliver"');
    expect(body).toContain("client.merchantWebhookDelivery.findFirst");
    expect(body).toContain("await scopedEndpoint(request, delivery.endpointId);");
  });

  test("a sandbox application's wallet must belong to the merchant", () => {
    const body = routeBody(merchant, 'router.patch("/applications/:id"');
    expect(body).toContain("client.wallet.findFirst({ where: { id: body.assignedWalletId, merchantId } })");
  });

  test("the options endpoint needs a read authority and narrows applications and rails", () => {
    const body = routeBody(merchant, 'router.get("/options/:kind"');
    expect(body).toContain('assertMerchantAuthority(principalOf(request), ["merchant:read", "merchant:write", "link:read", "payment:read"]);');
    expect(body).toContain('withAppScope(request, { merchantId, ...(rawSearch ? { name: contains! } : {}) }, "id")');
    expect(body).toContain("withAppScope(request, { merchantId })");
  });
});

describe("admin mutation guards", () => {
  test("AML disposition, evidence, propose and rule creation require a write authority", () => {
    for (const signature of [
      'router.post("/aml/matches/:id/disposition"',
      'router.post("/aml/cases/:id/propose"',
      'router.post("/aml/cases/:id/evidence"',
      'router.post("/aml/rules"',
    ]) {
      expect(routeBody(admin, signature)).toContain("assertAmlWrite(request);");
    }
    expect(admin).toContain('authority === "aml:write" || authority === "compliance:write"');
  });

  test("every gateway-version configuration write refuses a non-DRAFT version", () => {
    for (const path of ["environments", "auth", "settings", "crypto-profiles", "flows", "channels", "status-rules", "error-maps"]) {
      const body = routeBody(admin, `router.put("/gateway-versions/:vid/${path}"`);
      expect(body).toContain("assertVersionEditable(await loadVersion(vid));");
    }
    expect(routeBody(admin, 'router.put("/gateway-versions/:vid/rollback-version"')).toContain("assertVersionEditable(version);");
  });

  test("operator case bodies are redacted and credential/gateway reads never select ciphertext", () => {
    expect(admin).toContain("vault.redactText(text)");
    const list = routeBody(admin, 'router.get("/credential-sets"');
    expect(list).toContain("credentialSetView(entry)");
    expect(list).not.toContain("entriesCiphertext");
    expect(list).not.toContain("mtlsCertCiphertext");
    const gateway = routeBody(admin, 'router.get("/gateways/:id"');
    expect(gateway).not.toContain("versions: true");
    expect(gateway).not.toContain("credentialSets: true");
    expect(gateway).not.toContain("snapshotCiphertext");
  });
});

describe("inbound callback verification", () => {
  const verifier = (options: { attemptEnv?: string; ipAllowlist?: unknown; requestEnv?: "LIVE" | "SANDBOX" } = {}) => {
    const attempt = { id: "attempt-1", env: options.attemptEnv ?? "LIVE", credentialSetId: "cred-1" };
    const client = {
      confirmationChannel: {
        findUnique: async () => ({
          id: "channel-1",
          pathToken: "token",
          bodyFormat: "JSON",
          verifyMethod: "IP_ONLY",
          timestampToleranceSec: 0,
          correlationSelector: "reference",
          ipAllowlist: options.ipAllowlist ?? [],
          cryptoProfile: null,
          gatewayVersionId: "version-1",
        }),
      },
      paymentAttempt: { findFirst: async () => attempt },
      credentialSet: { findUnique: async () => null },
    };
    const callbackVerifier = new PrismaCallbackVerifier(client as never, new Vault({ masterKey: randomBytes(32) }));
    return callbackVerifier.verify("token", {
      rawBody: Buffer.from(JSON.stringify({ reference: "ref-1" })),
      headers: {},
      sourceIp: "203.0.113.5",
      ...(options.requestEnv ? { environment: options.requestEnv } : {}),
    });
  };

  test("an IP_ONLY channel with an empty allowlist fails closed", async () => {
    await expect(verifier()).resolves.toMatchObject({ verified: false, reason: "INBOUND_IP_ALLOWLIST_MISSING" });
  });

  test("a callback from the other environment is refused", async () => {
    await expect(verifier({ ipAllowlist: ["203.0.113.5"], attemptEnv: "LIVE", requestEnv: "SANDBOX" }))
      .resolves.toMatchObject({ verified: false, reason: "INBOUND_ENVIRONMENT_MISMATCH" });
  });

  test("matching environment, allowlist and attempt verify", async () => {
    await expect(verifier({ ipAllowlist: ["203.0.113.5"], attemptEnv: "LIVE", requestEnv: "LIVE" }))
      .resolves.toMatchObject({ verified: true, attemptId: "attempt-1", mustInquire: true });
  });

  test("the crypto profile's secretKeyRef is the only key tried, and a merchant-owned set forces an inquiry", () => {
    expect(verifierSource).toContain("resolveSecrets(attempt.credentialSetId, secretKeyRef)");
    expect(verifierSource).toContain("if (secretKeyRef && entry.key !== secretKeyRef)");
    expect(verifierSource).toContain('String(credentialSet.ownerType ?? "") === "MERCHANT"');
    expect(verifierSource).toContain("mustInquire: (resolved.merchantOwned");
  });
});

describe("object-storage key ring", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalKeyring = process.env.OBJECT_STORAGE_KEK_KEYRING;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalKeyring === undefined) delete process.env.OBJECT_STORAGE_KEK_KEYRING;
    else process.env.OBJECT_STORAGE_KEK_KEYRING = originalKeyring;
  });

  test("production refuses the deterministic development KEK", () => {
    delete process.env.OBJECT_STORAGE_KEK_KEYRING;
    process.env.NODE_ENV = "production";
    expect(() => InMemoryKeyProvider.fromEnv()).toThrow(/OBJECT_STORAGE_KEK_KEYRING must be set in production/);
    expect(storageCrypto).toContain("NODE_ENV === 'production'");
  });

  test("a configured keyring still loads in production", () => {
    process.env.NODE_ENV = "production";
    process.env.OBJECT_STORAGE_KEK_KEYRING = `v1:${"11".repeat(32)}`;
    expect(InMemoryKeyProvider.fromEnv().getActiveVersion()).toBe(1);
  });
});
