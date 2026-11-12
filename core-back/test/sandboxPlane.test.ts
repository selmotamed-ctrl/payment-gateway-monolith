import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../prisma/client";
import { generateAccessToken } from "../lib/auth";
import { authenticate } from "../api/middleware/authDoubleCheck";
import { ApiError } from "../lib/error";
import { reloadEnv } from "../lib/env";
import { assertOutboundPlaneAllowed, executionPlane, isFakeRailsUrl } from "../lib/plane";
import { ensureSandboxPrincipalProvisioned, resetMerchantSandboxWorkspace } from "../engine/sandbox/SandboxSyncService";
import { databaseIsReachable } from "./storage-engine/helpers/db";
import { adminInternalRouter } from "../api/internal/admin";
import { makePrincipal, startApp, type TestApp } from "./admin-slice/harness";

const dbAvailable = databaseIsReachable;
const ROLLBACK = "SANDBOX_TEST_ROLLBACK";

const setPlaneEnv = (plane: "LIVE" | "SANDBOX" | null, fakeRailsUrl = "http://127.0.0.1:8444", allowedHosts = "127.0.0.1") => {
  if (plane) {
    process.env.EXECUTION_PLANE = plane;
    process.env.FAKE_RAILS_PUBLIC_BASE_URL = fakeRailsUrl;
    process.env.FAKE_RAILS_ALLOWED_HOSTS = allowedHosts;
    process.env.ALLOW_FAKE_RAILS_HOSTS = "true";
  } else {
    delete process.env.EXECUTION_PLANE;
    delete process.env.FAKE_RAILS_PUBLIC_BASE_URL;
    delete process.env.FAKE_RAILS_ALLOWED_HOSTS;
    delete process.env.ALLOW_FAKE_RAILS_HOSTS;
  }
  reloadEnv();
};

const insertJournalEntry = async (
  input: { plane: "LIVE" | "SANDBOX"; strict: "on" | "off"; env: "LIVE" | "SANDBOX" },
): Promise<{ error: unknown; observedEnv?: string }> => {
  let error: unknown;
  let observedEnv: string | undefined;
  try {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL pgw.execution_plane = '${input.plane}'`);
      await tx.$executeRawUnsafe(`SET LOCAL pgw.strict_plane_fence = '${input.strict}'`);
      const entry = await tx.journalEntry.create({
        data: {
          refType: "PAYMENT_ATTEMPT",
          refId: `sandbox-fence-${randomUUID()}`,
          description: "sandbox plane fence test",
          env: input.env,
        },
      });
      observedEnv = entry.env;
      throw new Error(ROLLBACK);
    });
  } catch (caught) {
    if (!(caught instanceof Error) || caught.message !== ROLLBACK) error = caught;
  }
  return { error, observedEnv };
};

describe.skipIf(!dbAvailable)("parallel sandbox plane", () => {
  beforeAll(() => {
    setPlaneEnv("SANDBOX");
  });

  afterAll(async () => {
    setPlaneEnv(null);
    await client.$disconnect().catch(() => undefined);
  });

  test("API tokens carry the plane prefix", () => {
    expect(generateAccessToken("LIVE").startsWith("pg_live_")).toBe(true);
    expect(generateAccessToken("SANDBOX").startsWith("pg_test_")).toBe(true);
    setPlaneEnv("SANDBOX");
    expect(generateAccessToken().startsWith("pg_test_")).toBe(true);
    setPlaneEnv(null);
    expect(generateAccessToken().startsWith("pg_live_")).toBe(true);
    setPlaneEnv("SANDBOX");
  });

  test("a pg_test_ token is refused on the LIVE plane before any database lookup", async () => {
    setPlaneEnv("LIVE");
    const request = { headers: { authorization: "Bearer pg_test_abcdef" } } as never;
    await expect(authenticate(request)).rejects.toMatchObject({ code: "SANDBOX_TOKEN_ON_LIVE_PLANE" });
    setPlaneEnv("SANDBOX");
  });

  test("a pg_live_ token is refused on the SANDBOX plane before any database lookup", async () => {
    setPlaneEnv("SANDBOX");
    const request = { headers: { authorization: "Bearer pg_live_abcdef" } } as never;
    await expect(authenticate(request)).rejects.toMatchObject({ code: "LIVE_TOKEN_ON_SANDBOX_PLANE" });
  });

  test("the outbound fence blocks Fake Rails on LIVE and real gateways on SANDBOX", () => {
    expect(executionPlane()).toBe("SANDBOX");
    setPlaneEnv("LIVE");
    expect(() => assertOutboundPlaneAllowed("http://127.0.0.1:8444/rails/edfali/verify")).toThrow();
    try {
      assertOutboundPlaneAllowed("http://127.0.0.1:8444/rails/edfali/verify");
    } catch (error) {
      expect((error as ApiError).code).toBe("FAKE_RAILS_FORBIDDEN_ON_LIVE_PLANE");
    }
    expect(() => assertOutboundPlaneAllowed("https://api.moamalat.net/payment")).not.toThrow();

    setPlaneEnv("SANDBOX");
    expect(() => assertOutboundPlaneAllowed("https://api.moamalat.net/payment")).toThrow();
    try {
      assertOutboundPlaneAllowed("https://api.moamalat.net/payment");
    } catch (error) {
      expect((error as ApiError).code).toBe("LIVE_GATEWAY_FORBIDDEN_ON_SANDBOX_PLANE");
    }
    expect(() => assertOutboundPlaneAllowed("http://127.0.0.1:8444/rails/edfali/verify")).not.toThrow();

    setPlaneEnv(null);
    expect(() => assertOutboundPlaneAllowed("https://api.moamalat.net/payment")).not.toThrow();
    expect(() => assertOutboundPlaneAllowed("http://127.0.0.1:8444/rails/edfali/verify")).not.toThrow();
    setPlaneEnv("SANDBOX");
  });

  test("detects Fake Rails URLs by configured host and /rails/ path", () => {
    setPlaneEnv("SANDBOX", "http://127.0.0.1:8444", "fakerails.internal");
    expect(isFakeRailsUrl("http://127.0.0.1:8444/rails/edfali/verify")).toBe(true);
    expect(isFakeRailsUrl("http://fakerails.internal:8444/anything")).toBe(true);
    expect(isFakeRailsUrl("https://gateway.example.ly/rails/x")).toBe(true);
    expect(isFakeRailsUrl("https://api.moamalat.net/payment")).toBe(false);
  });

  test("the LIVE database rejects a SANDBOX row when the strict fence is on", async () => {
    const { error } = await insertJournalEntry({ plane: "LIVE", strict: "on", env: "SANDBOX" });
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("LIVE_LEDGER_SANDBOX_POST_FORBIDDEN");
  });

  test("the SANDBOX database rejects a LIVE row when the strict fence is on", async () => {
    const { error } = await insertJournalEntry({ plane: "SANDBOX", strict: "on", env: "LIVE" });
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("SANDBOX_LEDGER_LIVE_POST_FORBIDDEN");
  });

  test("the SANDBOX database forces rows onto the SANDBOX plane when strict mode is off", async () => {
    const { error, observedEnv } = await insertJournalEntry({ plane: "SANDBOX", strict: "off", env: "LIVE" });
    expect(error).toBeUndefined();
    expect(observedEnv).toBe("SANDBOX");
  });

  test("auto-provisions the sandbox merchant, wallet, application and user", async () => {
    const merchantId = randomUUID();
    const userId = randomUUID();
    const claims = {
      sub: userId,
      typ: "session" as const,
      role: "MERCHANT_ADMIN",
      merchantId,
      authorities: ["application:manage", "wallet:read"],
      appScopeIds: [],
      mfa: true,
      jti: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 3600,
      channel: "merchant" as const,
    };
    try {
      const user = await ensureSandboxPrincipalProvisioned(claims);
      expect(user.id).toBe(userId);
      expect(user.status).toBe("ACTIVE");
      const merchant = await client.merchant.findUniqueOrThrow({ where: { id: merchantId } });
      expect(merchant.status).toBe("ACTIVE");
      expect(merchant.onboardingChannel).toBe("SANDBOX");
      const wallet = await client.wallet.findFirstOrThrow({ where: { merchantId } });
      expect(wallet.status).toBe("ACTIVE");
      expect(wallet.env).toBe("SANDBOX");
      const application = await client.application.findFirstOrThrow({ where: { merchantId } });
      expect(application.status).toBe("ACTIVE");
      expect(application.env).toBe("SANDBOX");
    } finally {
      const applications = await client.application.findMany({ where: { merchantId }, select: { id: true } });
      for (const application of applications) {
        await client.application.deleteMany({ where: { id: application.id } });
      }
      const wallets = await client.wallet.findMany({ where: { merchantId }, select: { id: true, glAccountId: true } });
      for (const wallet of wallets) {
        await client.wallet.deleteMany({ where: { id: wallet.id } });
        await client.glAccountShard.deleteMany({ where: { glAccountId: wallet.glAccountId } });
        await client.glAccount.deleteMany({ where: { id: wallet.glAccountId } });
      }
      await client.user.deleteMany({ where: { id: userId } });
      await client.merchant.deleteMany({ where: { id: merchantId } });
    }
  });

  test("admin sandbox fast-approve is hard-blocked on the LIVE plane", async () => {
    const app: TestApp = await startApp([adminInternalRouter]);
    try {
      app.setPrincipal(
        makePrincipal(randomUUID(), ["approval:check", "approval:write"], "SECURITY_ADMIN"),
      );
      setPlaneEnv("LIVE");
      const response = await app.request(
        "POST",
        `/approvals/${randomUUID()}/sandbox-fast-approve`,
        {},
      );
      expect(response.status).toBe(403);
      expect(response.json.code).toBe("SANDBOX_FAST_APPROVE_FORBIDDEN_ON_LIVE");
    } finally {
      await app.close();
      setPlaneEnv("SANDBOX");
    }
  });

  test("workspace reset is forbidden on the LIVE plane and permitted on SANDBOX", async () => {
    setPlaneEnv("LIVE");
    await expect(resetMerchantSandboxWorkspace(randomUUID())).rejects.toMatchObject({
      code: "SANDBOX_RESET_FORBIDDEN_ON_LIVE",
    });
    setPlaneEnv("SANDBOX");
    const result = await resetMerchantSandboxWorkspace(randomUUID());
    expect(result.ok).toBe(true);
    expect(result.deletedAttempts).toBe(0);
    expect(result.deletedLinks).toBe(0);
  });
});

describe.skipIf(dbAvailable)("parallel sandbox plane (database unavailable)", () => {
  test("skipped because the test database is unreachable", () => {
    expect(dbAvailable).toBe(false);
  });
});
