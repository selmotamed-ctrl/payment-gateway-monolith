import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../prisma/client";
import { checkoutInternalRouter } from "../api/internal/checkout";
import { reloadEnv } from "../lib/env";
import { dbAvailable, startApp, type TestApp } from "./admin-slice/harness";

const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
const linkKey = `sbx_integration_${suffix}`;
const merchantId = randomUUID();
const applicationId = randomUUID();
const walletId = randomUUID();
const glAccountId = randomUUID();
const linkId = randomUUID();

let app: TestApp | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let patchedAccountId = "";

const account = (overrides: Record<string, unknown> = {}) => ({
  id: "acc-integration-1",
  rail_code: "edfali",
  gateway_code: "edfali",
  merchant_id: null,
  instrument_type: "MOBILE_WALLET",
  identifier: "0912222222",
  holder_name: "Integration Standard Account",
  secret_pin: "1234",
  expiry: "12/28",
  currency: "LYD",
  available_balance_lyd: "1500.0000",
  reserved_balance_lyd: "0.0000",
  daily_limit_lyd: "2000.0000",
  daily_spent_lyd: "0.0000",
  status: "ACTIVE",
  static_otp: null,
  preset_fault: null,
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

beforeAll(async () => {
  if (!dbAvailable) return;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.headers.get("x-fake-rails-seeder-token") !== "seed-integration-0123456789abcdef") {
        return new Response(JSON.stringify({ code: "INVALID_SEEDER_TOKEN" }), { status: 401 });
      }
      if (url.pathname === "/portal-api/accounts" && request.method === "GET") {
        return Response.json({ accounts: [account()] });
      }
      if (/^\/portal-api\/accounts\/[^/]+\/movements$/.test(url.pathname) && request.method === "GET") {
        return Response.json({
          movements: [{
            id: "move-integration-1",
            account_id: "acc-integration-1",
            transaction_id: null,
            direction: "BALANCE_ADJUSTMENT",
            amount_lyd: "50.0000",
            available_before_lyd: "1500.0000",
            available_after_lyd: "50.0000",
            reason: "integration test",
            actor: "sandbox-user",
            created_at: new Date().toISOString(),
          }],
        });
      }
      if (url.pathname.startsWith("/portal-api/accounts/") && request.method === "PATCH") {
        const body = (await request.json()) as Record<string, unknown>;
        patchedAccountId = url.pathname.split("/").at(-1) ?? "";
        return Response.json({
          account: account({
            available_balance_lyd: typeof body.availableBalanceLyd === "string" ? body.availableBalanceLyd : "1500.0000",
            status: typeof body.status === "string" ? body.status : "ACTIVE",
          }),
        });
      }
      return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
    },
  });

  process.env.EXECUTION_PLANE = "SANDBOX";
  process.env.FAKE_RAILS_PUBLIC_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.FAKE_RAILS_SEEDER_TOKEN = "seed-integration-0123456789abcdef";
  process.env.ALLOW_FAKE_RAILS_HOSTS = "true";
  process.env.FAKE_RAILS_ALLOWED_HOSTS = "127.0.0.1";
  reloadEnv();

  await client.merchant.create({
    data: {
      id: merchantId,
      legalName: "Sandbox Integration Store",
      tradeName: "Sandbox Integration",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      onboardingChannel: "SANDBOX",
      country: "LY",
    },
  });
  await client.glAccount.create({
    data: { id: glAccountId, accountType: "MERCHANT_WALLET", ownerId: merchantId, env: "SANDBOX", currency: "LYD" },
  });
  await client.wallet.create({
    data: { id: walletId, merchantId, glAccountId, currency: "LYD", status: "ACTIVE", env: "SANDBOX" },
  });
  await client.application.create({
    data: {
      id: applicationId,
      merchantId,
      name: "Sandbox Integration Application",
      assignedWalletId: walletId,
      status: "ACTIVE",
      env: "SANDBOX",
      sandboxInspectorMode: "OPEN_IN_SANDBOX",
    },
  });
  await client.paymentLink.create({
    data: {
      id: linkId,
      key: linkKey,
      applicationId,
      walletId,
      amount: "100.0000",
      currency: "LYD",
      feeBearer: "MERCHANT_ABSORBS",
      state: "PENDING",
      env: "SANDBOX",
    },
  });
  app = await startApp([checkoutInternalRouter], { channelPrefixes: true });
});

afterAll(async () => {
  delete process.env.EXECUTION_PLANE;
  delete process.env.FAKE_RAILS_PUBLIC_BASE_URL;
  delete process.env.FAKE_RAILS_SEEDER_TOKEN;
  delete process.env.ALLOW_FAKE_RAILS_HOSTS;
  delete process.env.FAKE_RAILS_ALLOWED_HOSTS;
  reloadEnv();
  server?.stop(true);
  if (dbAvailable) {
    await client.paymentLink.deleteMany({ where: { id: linkId } });
    await client.application.deleteMany({ where: { id: applicationId } });
    await client.wallet.deleteMany({ where: { id: walletId } });
    await client.glAccountShard.deleteMany({ where: { glAccountId } });
    await client.glAccount.deleteMany({ where: { id: glAccountId } });
    await client.merchant.deleteMany({ where: { id: merchantId } });
  }
  await app?.close();
});

describe.skipIf(!dbAvailable)("core sandbox inspector integration", () => {
  test("a sandbox link summary includes the env and the Fake Rails rail accounts", async () => {
    const response = await app!.request("GET", `/pay/${linkKey}`);
    expect(response.status).toBe(200);
    expect(response.json.env).toBe("SANDBOX");
    expect(response.json.sandboxInspector).toBeDefined();
    expect(response.json.sandboxInspector.enabled).toBe(true);
    expect(response.json.sandboxInspector.unlocked).toBe(true);
    expect(response.json.sandboxInspector.railAccounts).toHaveLength(1);
    expect(response.json.sandboxInspector.railAccounts[0].identifier).toBe("0912222222");
    expect(response.json.sandboxInspector.railAccounts[0].secretPin).toBe("1234");
  });

  test("the sandbox account PATCH is forwarded to Fake Rails and re-read", async () => {
    const response = await app!.request("PATCH", `/pay/${linkKey}/sandbox-accounts/acc-integration-1`, {
      availableBalanceLyd: "50.0000",
      reason: "integration test",
    });
    expect(response.status).toBe(200);
    expect(patchedAccountId).toBe("acc-integration-1");
    expect(response.json.account.availableBalanceLyd).toBe("50.0000");
  });

  test("the account movements route is forwarded to Fake Rails", async () => {
    const response = await app!.request("GET", `/pay/${linkKey}/sandbox-accounts/acc-integration-1/movements`);
    expect(response.status).toBe(200);
    expect(response.json.movements).toHaveLength(1);
    expect(response.json.movements[0].direction).toBe("BALANCE_ADJUSTMENT");
  });

  test("a live link cannot expose the inspector or the sandbox endpoints", async () => {
    const liveKey = `pay_integration_${suffix}`;
    await client.paymentLink.create({
      data: {
        id: randomUUID(),
        key: liveKey,
        applicationId,
        walletId,
        amount: "100.0000",
        currency: "LYD",
        feeBearer: "MERCHANT_ABSORBS",
        state: "PENDING",
        env: "LIVE",
      },
    });
    try {
      const summary = await app!.request("GET", `/pay/${liveKey}`);
      expect(summary.status).toBe(200);
      expect(summary.json.env).toBe("LIVE");
      expect(summary.json.sandboxInspector).toBeUndefined();

      const accounts = await app!.request("GET", `/pay/${liveKey}/sandbox-accounts`);
      expect(accounts.status).toBe(403);
      expect(accounts.json.code).toBe("SANDBOX_ONLY_ENDPOINT");
    } finally {
      await client.paymentLink.deleteMany({ where: { key: liveKey } });
    }
  });
});
