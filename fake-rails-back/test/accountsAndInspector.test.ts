import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Server } from "node:http";

const dbPath = `/tmp/fake-rails-accounts-${process.pid}-${Date.now()}.sqlite`;
process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_ADMIN_USER = "tester_admin";
process.env.FAKE_RAILS_ADMIN_PASSWORD = "Strong-Tester-Pass-2026!";
process.env.FAKE_RAILS_JWT_SECRET = "jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af";
process.env.FAKE_RAILS_SEEDER_TOKEN = "seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua";
process.env.FAKE_RAILS_DATA_DIR = "/tmp/fake-rails-accounts-data";
process.env.FAKE_RAILS_DB_PATH = dbPath;
process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
process.env.FAKE_RAILS_WEBHOOK_TIMEOUT_MS = "200";
process.env.CORE_INBOUND_BASE_URL = "http://127.0.0.1:59999/api/v1/inbound";
process.env.FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS = "";
process.env.FAKE_RAILS_TIMEOUT_HANG_MS = "40";

let server: Server | undefined;
let baseUrl = "";
let closeDb: () => void = () => undefined;

const request = async (
  path: string,
  options: { method?: string; body?: unknown; seeder?: boolean } = {},
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.seeder ? { "x-fake-rails-seeder-token": process.env.FAKE_RAILS_SEEDER_TOKEN! } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

interface Account {
  id: string;
  rail_code: string;
  identifier: string;
  status: string;
  available_balance_lyd: string;
  reserved_balance_lyd: string;
  daily_limit_lyd: string;
  daily_spent_lyd: string;
}

const accountsForRail = async (railCode: string): Promise<Account[]> => {
  const response = await request(`/portal-api/accounts?railCode=${encodeURIComponent(railCode)}`, { seeder: true });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { accounts: Account[] };
  return payload.accounts;
};

const accountByIdentifier = async (railCode: string, identifier: string): Promise<Account> => {
  const accounts = await accountsForRail(railCode);
  const account = accounts.find((entry) => entry.identifier === identifier);
  expect(account, `account ${railCode}/${identifier} missing`).toBeDefined();
  return account!;
};

const initiateOtp = (reference: string, amount: string, phone: string) =>
  request("/rails/edfali/verify", { method: "POST", body: { reference, amount, phone } });

const confirmOtp = (reference: string, otp: string) =>
  request("/rails/edfali/confirm", { method: "POST", body: { reference, otp } });

beforeAll(async () => {
  const { closeDb: close } = await import("../engine/db");
  closeDb = close;
  closeDb();
  const { createApp } = await import("../index");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

describe("stateful Fake Rails accounts", () => {
  test("seeds five canonical personas for every emulated rail", async () => {
    const { RAIL_DESCRIPTORS } = await import("../engine/chaos/DefaultRailScenarios");
    const response = await request("/portal-api/accounts", { seeder: true });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { accounts: Account[] };
    expect(payload.accounts.length).toBe(RAIL_DESCRIPTORS.length * 5);
    for (const rail of RAIL_DESCRIPTORS) {
      const accounts = payload.accounts.filter((account) => account.rail_code === rail.railCode);
      expect(accounts.length, `${rail.railCode} persona count`).toBe(5);
      expect(accounts.some((account) => account.available_balance_lyd === "50000.0000")).toBe(true);
      expect(accounts.some((account) => account.available_balance_lyd === "5.0000")).toBe(true);
      expect(accounts.some((account) => account.status === "FROZEN")).toBe(true);
    }
  });

  test("initiate holds funds, confirm captures them and increments the daily spend", async () => {
    const before = await accountByIdentifier("edfali", "0912222222");
    const initiated = await initiateOtp("SBX-HOLD-1", "150.0000", "0912222222");
    expect(initiated.status).toBe(200);
    const body = (await initiated.json()) as { status: string; otp: string; expected_otp: string };
    expect(body.status).toBe("AWAITING_CUSTOMER");

    const afterHold = await accountByIdentifier("edfali", "0912222222");
    expect(afterHold.available_balance_lyd).toBe("1350.0000");
    expect(afterHold.reserved_balance_lyd).toBe("150.0000");

    const confirmed = await confirmOtp("SBX-HOLD-1", body.otp);
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { status: string }).status).toBe("PAID");

    const afterCapture = await accountByIdentifier("edfali", "0912222222");
    expect(afterCapture.available_balance_lyd).toBe("1350.0000");
    expect(afterCapture.reserved_balance_lyd).toBe("0.0000");
    expect(afterCapture.daily_spent_lyd).toBe(
      (Number(before.daily_spent_lyd) + 150).toFixed(4),
    );
  });

  test("cancel releases the reservation back to the available balance", async () => {
    const initiated = await request("/rails/hawelli/request", {
      method: "POST",
      body: { reference: "SBX-RELEASE-1", amount: "100.0000", phone: "0911111111" },
    });
    expect(initiated.status).toBe(200);
    const afterHold = await accountByIdentifier("hawelli", "0911111111");
    expect(Number(afterHold.reserved_balance_lyd)).toBeGreaterThanOrEqual(100);

    const cancelled = await request("/rails/hawelli/cancel", {
      method: "POST",
      body: { reference: "SBX-RELEASE-1" },
    });
    expect(cancelled.status).toBe(200);
    const afterCancel = await accountByIdentifier("hawelli", "0911111111");
    expect(afterCancel.reserved_balance_lyd).toBe("0.0000");
    expect(Number(afterCancel.available_balance_lyd)).toBeGreaterThanOrEqual(49000);
  });

  test("low balance, exhausted daily limit and frozen status decline realistically", async () => {
    const low = await initiateOtp("SBX-LOW-1", "100.0000", "0910000005");
    const lowBody = (await low.json()) as { status: string; error: string; ActionCode: string };
    expect(lowBody.status).toBe("FAILED");
    expect(lowBody.error).toBe("INSUFFICIENT_FUNDS");
    expect(lowBody.ActionCode).toBe("51");

    const limit = await initiateOtp("SBX-LIMIT-1", "20.0000", "0910000061");
    const limitBody = (await limit.json()) as { status: string; error: string; ActionCode: string };
    expect(limitBody.status).toBe("FAILED");
    expect(limitBody.error).toBe("LIMIT_EXCEEDED");
    expect(limitBody.ActionCode).toBe("61");

    const frozen = await initiateOtp("SBX-FROZEN-1", "10.0000", "0910000999");
    const frozenBody = (await frozen.json()) as { status: string; error: string; ActionCode: string };
    expect(frozenBody.status).toBe("FAILED");
    expect(frozenBody.error).toBe("ACCOUNT_FROZEN");
    expect(frozenBody.ActionCode).toBe("05");
  });

  test("the inspector balances an account and unblocks the next payment", async () => {
    const low = await accountByIdentifier("edfali", "0910000005");
    const patched = await request(`/portal-api/accounts/${encodeURIComponent(low.id)}`, {
      method: "PATCH",
      seeder: true,
      body: { availableBalanceLyd: "500.0000", reason: "Test top-up" },
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { account: Account }).account.available_balance_lyd).toBe("500.0000");

    const paid = await initiateOtp("SBX-LOW-2", "100.0000", "0910000005");
    const body = (await paid.json()) as { status: string; otp: string };
    expect(body.status).toBe("AWAITING_CUSTOMER");
    const confirmed = await confirmOtp("SBX-LOW-2", body.otp);
    expect(((await confirmed.json()) as { status: string }).status).toBe("PAID");
  });

  test("the checkout helper reveals the live OTP and simulates a push approval", async () => {
    const initiated = await request("/rails/hawelli/request", {
      method: "POST",
      body: { reference: "SBX-QR-1", amount: "75.0000", phone: "0912222222" },
    });
    expect(initiated.status).toBe(200);
    const body = (await initiated.json()) as { otp: string; provider_reference: string };
    const helper = await request("/portal-api/checkout-helper/SBX-QR-1", { seeder: true });
    expect(helper.status).toBe(200);
    const secrets = ((await helper.json()) as {
      activeAttemptSecrets: {
        expectedOtp: string;
        heldAmountLyd: string;
        canSimulateMobilePushOrQrApproval: boolean;
        boundAccountIdentifier: string;
      };
    }).activeAttemptSecrets;
    expect(secrets.expectedOtp).toBe(body.otp);
    expect(secrets.heldAmountLyd).toBe("75.0000");
    expect(secrets.canSimulateMobilePushOrQrApproval).toBe(true);
    expect(secrets.boundAccountIdentifier).toBe("0912222222");

    const simulated = await request("/portal-api/checkout-helper/SBX-QR-1/simulate-action", {
      method: "POST",
      seeder: true,
      body: { action: "APPROVE_PUSH_OR_QR" },
    });
    expect(simulated.status).toBe(200);
    const account = await accountByIdentifier("hawelli", "0912222222");
    expect(account.reserved_balance_lyd).toBe("0.0000");
  });

  test("a refund credits the captured amount back to the customer", async () => {
    const initiated = await request("/rails/mpgs/session", {
      method: "POST",
      body: { reference: "SBX-REFUND-1", amount: "100.0000", phone: "5123452222222222" },
    });
    expect(initiated.status).toBe(200);
    const confirmed = await request("/rails/mpgs/order/SBX-REFUND-1/confirm", {
      method: "POST",
      body: { reference: "SBX-REFUND-1" },
    });
    expect(confirmed.status).toBe(200);
    const before = await accountByIdentifier("mpgs", "5123452222222222");

    const refunded = await request("/rails/mpgs/order/SBX-REFUND-1/refund", {
      method: "POST",
      body: { reference: "SBX-REFUND-1" },
    });
    expect(refunded.status).toBe(200);
    expect(((await refunded.json()) as { status: string }).status).toBe("REFUNDED");
    const after = await accountByIdentifier("mpgs", "5123452222222222");
    expect(Number(after.available_balance_lyd)).toBeCloseTo(Number(before.available_balance_lyd) + 100, 4);
  });

  test("a reset restores the canonical personas and removes merchant accounts", async () => {
    const created = await request("/portal-api/accounts", {
      method: "POST",
      seeder: true,
      body: {
        railCode: "edfali",
        gatewayCode: "edfali",
        merchantId: "11111111-1111-4111-8111-111111111111",
        identifier: "0917777777",
        holderName: "Merchant Test Account",
        availableBalanceLyd: "320.0000",
      },
    });
    expect(created.status).toBe(201);
    const reset = await request("/portal-api/accounts/reset", {
      method: "POST",
      seeder: true,
      body: { merchantId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(reset.status).toBe(200);
    const accounts = await accountsForRail("edfali");
    expect(accounts.some((account) => account.identifier === "0917777777")).toBe(false);
    const rich = accounts.find((account) => account.identifier === "0911111111")!;
    expect(rich.available_balance_lyd).toBe("50000.0000");
    expect(rich.reserved_balance_lyd).toBe("0.0000");
  });
});
