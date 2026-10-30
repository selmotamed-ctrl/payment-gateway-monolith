import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/fake-rails-api-test-${process.pid}-${Date.now()}.sqlite`;

process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_ADMIN_USER = "tester_admin";
process.env.FAKE_RAILS_ADMIN_PASSWORD = "Strong-Tester-Pass-2026!";
process.env.FAKE_RAILS_JWT_SECRET = "0123456789abcdef0123456789abcdef";
process.env.FAKE_RAILS_SEEDER_TOKEN = "0123456789abcdef0123456789abcdef";
process.env.FAKE_RAILS_DATA_DIR = "/tmp/fake-rails-api-test-data";
process.env.FAKE_RAILS_DB_PATH = dbPath;
process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
process.env.FAKE_RAILS_TIMEOUT_HANG_MS = "40";
process.env.FAKE_RAILS_WEBHOOK_TIMEOUT_MS = "200";
process.env.CORE_INBOUND_BASE_URL = "http://127.0.0.1:59999/api/v1/inbound";

let server: import("node:http").Server;
let baseUrl = "";
let token = "";
let closeDb: () => void = () => undefined;

beforeAll(async () => {
  const { createApp } = await import("../index");
  const db = await import("../engine/db");
  closeDb = db.closeDb;
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  closeDb();
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  } catch {
    // ignore
  }
});

const request = async (
  path: string,
  options: { method?: string; body?: unknown; token?: string; seeder?: boolean; raw?: string } = {},
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.seeder ? { "x-fake-rails-seeder-token": process.env.FAKE_RAILS_SEEDER_TOKEN! } : {}),
    },
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });

describe("fake-rails-back API", () => {
  test("seeder handshake authenticates with the shared token", async () => {
    const response = await request("/portal-api/internal/seeder-handshake", {
      method: "POST",
      seeder: true,
      body: { check: "PRE_FLIGHT_SEEDER_SYNC" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; rails: number };
    expect(body.ok).toBe(true);
    expect(body.rails).toBe(20);
  });

  test("seeder handshake rejects a missing token", async () => {
    const response = await request("/portal-api/internal/seeder-handshake", { method: "POST", body: {} });
    expect(response.status).toBe(401);
  });

  test("login issues a tester JWT and rejects a wrong password", async () => {
    const bad = await request("/portal-api/auth/login", {
      method: "POST",
      body: { username: "tester_admin", password: "wrong-password" },
    });
    expect(bad.status).toBe(401);

    const response = await request("/portal-api/auth/login", {
      method: "POST",
      body: { username: "tester_admin", password: "Strong-Tester-Pass-2026!" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; user: { role?: string } };
    expect(body.token.split(".")).toHaveLength(3);
    token = body.token;
  });

  test("protected routes require the tester session", async () => {
    const response = await request("/portal-api/transactions");
    expect(response.status).toBe(401);
    const authorized = await request("/portal-api/transactions", { token });
    expect(authorized.status).toBe(200);
  });

  test("an OTP rail initiates, confirms and settles", async () => {
    const verify = await request("/rails/edfali/verify", {
      method: "POST",
      body: { reference: "API-TEST-1", amount: "100.00", phone: "0911234567" },
    });
    expect(verify.status).toBe(200);
    const verification = (await verify.json()) as { otp: string; provider_reference: string };
    expect(verification.otp).toHaveLength(4);

    const confirm = await request("/rails/edfali/confirm", {
      method: "POST",
      body: { reference: "API-TEST-1", otp: verification.otp },
    });
    expect(confirm.status).toBe(200);
    const confirmed = (await confirm.json()) as { status: string };
    expect(confirmed.status).toBe("PAID");

    const inquiry = await request("/rails/edfali/status/API-TEST-1");
    expect(inquiry.status).toBe(200);
    const status = (await inquiry.json()) as { status: string };
    expect(status.status).toBe("PAID");
  });

  test("a wrong OTP keeps the attempt awaiting the customer", async () => {
    await request("/rails/edfali/verify", {
      method: "POST",
      body: { reference: "API-TEST-WRONG-OTP", amount: "10.00", phone: "0911234567" },
    });
    const confirm = await request("/rails/edfali/confirm", {
      method: "POST",
      body: { reference: "API-TEST-WRONG-OTP", otp: "0000" },
    });
    const body = (await confirm.json()) as { status: string; retryable: boolean };
    expect(body.status).toBe("AWAITING_CUSTOMER");
    expect(body.retryable).toBe(true);
  });

  test("chaos scenario is persisted and drives the next confirm", async () => {
    const put = await request("/portal-api/scenarios/edfali", {
      method: "PUT",
      token,
      body: {
        enabled: true,
        overallFailureChancePercent: 100,
        phaseBreakdown: {
          initiateFailWeight: 0,
          submitFailWeight: 100,
          verifyFailWeight: 0,
          webhookFailWeight: 0,
          refundFailWeight: 0,
        },
        failureModeWeights: {
          TERMINAL_DECLINE_INSUFFICIENT_FUNDS: 0,
          LIMIT_EXCEEDED_CUSTOMER_CEILING: 0,
          WRONG_OTP_RETRYABLE: 0,
          HTTP_500_GATEWAY_FAULT: 0,
          TIMEOUT_HANG_ABOVE_STEP_TTL: 100,
          SOCKET_RESET_MID_STREAM: 0,
          MALFORMED_OR_UNMAPPED_200_BODY: 0,
          RATE_LIMIT_HTTP_429: 0,
          AMOUNT_ROUNDING_MISMATCH: 0,
          CONFLICTING_WEBHOOK_VS_INQUIRY: 0,
        },
      },
    });
    expect(put.status).toBe(200);

    const verify = await request("/rails/edfali/verify", {
      method: "POST",
      body: { reference: "API-TEST-CHAOS", amount: "10.00", phone: "0911234567" },
    });
    const verification = (await verify.json()) as { otp: string };
    const confirm = await request("/rails/edfali/confirm", {
      method: "POST",
      body: { reference: "API-TEST-CHAOS", otp: verification.otp },
    });
    expect(confirm.status).toBe(504);

    await request("/portal-api/scenarios/edfali", {
      method: "PUT",
      token,
      body: { overallFailureChancePercent: 0, failureModeWeights: { TIMEOUT_HANG_ABOVE_STEP_TTL: 0 } },
    });
  });

  test("bulk seed inserts historical transactions and events", async () => {
    const response = await request("/portal-api/internal/bulk-seed", {
      method: "POST",
      seeder: true,
      body: {
        transactions: [
          {
            id: "00000000-0000-7000-8000-000000000001",
            gateway_code: "moamalat",
            rail_code: "moamalat",
            env: "LIVE",
            our_reference: "SEED-REF-1",
            provider_reference: "FK-SEED-1",
            requested_amount_wire: "10500",
            normalized_amount_lyd: "10.5000",
            settled_amount_lyd: "10.5000",
            currency: "LYD",
            collection_mode: "EMBEDDED",
            status: "PAID",
            is_seeded_historical: 1,
            created_at: "2024-01-01T10:00:00.000Z",
            updated_at: "2024-01-01T10:01:00.000Z",
          },
        ],
        events: [
          {
            id: "00000000-0000-7000-8000-000000000002",
            transaction_id: "00000000-0000-7000-8000-000000000001",
            gateway_code: "moamalat",
            phase: "INITIATE",
            method: "POST",
            path: "/rails/moamalat/FilterTransactions",
            created_at: "2024-01-01T10:00:00.000Z",
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { insertedTransactions: number; insertedEvents: number };
    expect(result.insertedTransactions).toBe(1);
    expect(result.insertedEvents).toBe(1);

    const list = await request("/portal-api/transactions?reference=SEED-REF-1", { token });
    const body = (await list.json()) as { total: number; rows: Array<{ our_reference: string }> };
    expect(body.total).toBe(1);
    expect(body.rows[0]?.our_reference).toBe("SEED-REF-1");
  });

  test("statements generate JSON with anomaly injection", async () => {
    const response = await request("/portal-api/statements/generate", {
      method: "POST",
      token,
      body: {
        gatewayCode: "edfali",
        format: "json",
        from: "2020-01-01T00:00:00.000Z",
        to: "2030-01-01T00:00:00.000Z",
        anomalies: { feeVariancePercent: 0, omitOne: false, addUnrecorded: true },
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lines: Array<{ our_reference: string }> };
    expect(body.lines.some((line) => line.our_reference.startsWith("UNRECORDED-"))).toBe(true);
  });

  test("the SDK script is served with the drop-in API", async () => {
    const response = await request("/sdk/moamalat-lightbox.js");
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toContain("Lightbox.Checkout.configure");
  });

  test("hosted session actions settle the transaction", async () => {
    const verify = await request("/rails/tlync/payment/create", {
      method: "POST",
      body: { reference: "HOSTED-1", amount: "55.00", return_url: "https://merchant.test/return" },
    });
    const created = (await verify.json()) as { transaction_id: string };
    const session = await request(`/portal-api/hosted/session/${encodeURIComponent(created.transaction_id)}`);
    expect(session.status).toBe(200);
    const action = await request(`/portal-api/hosted/session/${encodeURIComponent(created.transaction_id)}/action`, {
      method: "POST",
      body: { action: "APPROVE" },
    });
    expect(action.status).toBe(200);
    const body = (await action.json()) as { transaction: { status: string } };
    expect(body.transaction.status).toBe("PAID");
  });
});
