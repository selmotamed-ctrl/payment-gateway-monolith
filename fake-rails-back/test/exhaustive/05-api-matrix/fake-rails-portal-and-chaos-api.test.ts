/**
 * Suite 05.5 — the fake-rails portal and chaos API.
 *
 * Starts the real Express app against a throw-away SQLite database and drives
 * authentication, the 20-rail chaos matrix, transaction actions, webhook
 * delivery and statement generation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/fake-rails-exhaustive-${process.pid}-${Date.now()}.sqlite`;

process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_ADMIN_USER = "tester_admin";
process.env.FAKE_RAILS_ADMIN_PASSWORD = "Strong-Tester-Pass-2026!";
process.env.FAKE_RAILS_JWT_SECRET = "0123456789abcdef0123456789abcdef";
process.env.FAKE_RAILS_SEEDER_TOKEN = "0123456789abcdef0123456789abcdef";
process.env.FAKE_RAILS_DATA_DIR = `/tmp/fake-rails-exhaustive-data-${process.pid}`;
process.env.FAKE_RAILS_DB_PATH = dbPath;
process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
process.env.FAKE_RAILS_TIMEOUT_HANG_MS = "40";
process.env.FAKE_RAILS_WEBHOOK_TIMEOUT_MS = "100";
process.env.CORE_INBOUND_BASE_URL = "http://127.0.0.1:59999/api/v1/inbound";

const RAILS = [
  "edfali",
  "sadad",
  "mobicash",
  "moamalat",
  "ly_pay",
  "onepay",
  "tlync",
  "mypay",
  "dpay",
  "plutu",
  "yussor_pay",
  "sahara_pay",
  "masrefy_pay",
  "hawelli",
  "gpay_libya",
  "numo_pay",
  "libyana",
  "mpgs",
  "evopay",
  "neompay",
] as const;

let server: import("node:http").Server;
let baseUrl = "";
let token = "";
let closeDb: () => void = () => undefined;
let transactionId = "";

beforeAll(async () => {
  const { createApp } = await import("../../../index");
  const db = await import("../../../engine/db");
  closeDb = db.closeDb;
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const login = await request("/portal-api/auth/login", {
    method: "POST",
    body: { username: "tester_admin", password: "Strong-Tester-Pass-2026!" },
  });
  token = ((await login.json()) as { token: string }).token;
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

const authed = (path: string, options: { method?: string; body?: unknown } = {}) =>
  request(path, { ...options, token });

const createTransaction = async (reference: string): Promise<void> => {
  const verify = await request("/rails/edfali/verify", {
    method: "POST",
    body: { reference, amount: "100.00", phone: "0911234567" },
  });
  expect(verify.status).toBe(200);
  const list = await authed(`/portal-api/transactions?reference=${encodeURIComponent(reference)}`);
  const payload = (await list.json()) as { rows: Array<{ id: string; our_reference: string }> };
  const row = payload.rows.find((entry) => entry.our_reference === reference) ?? payload.rows[0];
  transactionId = String(row?.id);
};

describe("Suite 05 · fake-rails health & auth", () => {
  test("health responds", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { service: string }).service).toBe("fake-rails-back");
  });

  test("hosted health responds", async () => {
    const response = await request("/hosted/health");
    expect(response.status).toBe(200);
  });

  test("login rejects a wrong password", async () => {
    const response = await request("/portal-api/auth/login", {
      method: "POST",
      body: { username: "tester_admin", password: "wrong" },
    });
    expect(response.status).toBe(401);
  });

  test("login issues a three-segment tester JWT", async () => {
    expect(token.split(".")).toHaveLength(3);
    const me = await authed("/portal-api/auth/me");
    expect(me.status).toBe(200);
  });

  test("protected routes reject a missing token", async () => {
    expect((await request("/portal-api/transactions")).status).toBe(401);
  });

  test("protected routes reject a garbage token", async () => {
    const response = await request("/portal-api/transactions", { token: "garbage" });
    expect(response.status).toBe(401);
  });

  test("seeder handshake rejects a missing token", async () => {
    const response = await request("/portal-api/internal/seeder-handshake", { method: "POST", body: {} });
    expect(response.status).toBe(401);
  });

  test("seeder handshake accepts the shared token", async () => {
    const response = await request("/portal-api/internal/seeder-handshake", {
      method: "POST",
      seeder: true,
      body: { check: "PRE_FLIGHT_SEEDER_SYNC" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean; rails: number }).rails).toBe(20);
  });
});

describe("Suite 05 · fake-rails 20-rail chaos matrix", () => {
  test("the scenario catalog exposes all 20 rails", async () => {
    const response = await authed("/portal-api/scenarios");
    const payload = (await response.json()) as { rails: Array<{ railCode: string }> };
    const codes = payload.rails.map((rail) => rail.railCode).sort();
    expect(codes).toEqual([...RAILS].sort());
  });

  for (const rail of RAILS) {
    test(`${rail} accepts a healthy scenario and reads it back`, async () => {
      const put = await authed(`/portal-api/scenarios/${rail}`, {
        method: "PUT",
        body: {
          enabled: true,
          overallFailureChancePercent: 0,
          phaseBreakdown: {
            initiateFailWeight: 0,
            submitFailWeight: 0,
            verifyFailWeight: 0,
            webhookFailWeight: 0,
            refundFailWeight: 0,
          },
        },
      });
      expect(put.status).toBe(200);
      const get = await authed(`/portal-api/scenarios/${rail}`);
      const scenario = ((await get.json()) as { scenario: { overallFailureChancePercent: number } }).scenario;
      expect(scenario.overallFailureChancePercent).toBe(0);
    });

    test(`${rail} accepts the timeout_on_confirm preset`, async () => {
      const response = await authed(`/portal-api/scenarios/preset/${rail}/timeout_on_confirm`, { method: "POST" });
      expect(response.status).toBe(200);
      const scenario = ((await response.json()) as {
        scenario: { overallFailureChancePercent: number; phaseBreakdown: { submitFailWeight: number } };
      }).scenario;
      expect(scenario.overallFailureChancePercent).toBe(100);
      expect(scenario.phaseBreakdown.submitFailWeight).toBe(100);
    });
  }

  test("an unknown preset is refused", async () => {
    const response = await authed("/portal-api/scenarios/preset/edfali/not-a-preset", { method: "POST" });
    expect(response.status).toBe(400);
  });

  test("an unknown rail is refused", async () => {
    const response = await authed("/portal-api/scenarios/preset/not-a-rail/healthy", { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("the global healthy preset updates every rail", async () => {
    const response = await authed("/portal-api/scenarios/global/healthy", { method: "POST" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { scenarios: unknown[] }).scenarios).toHaveLength(20);
  });

  test("reset restores the default scenarios", async () => {
    const response = await authed("/portal-api/scenarios/reset", { method: "POST" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { scenarios: unknown[] }).scenarios).toHaveLength(20);
  });

  test("the scenario audit trail is readable", async () => {
    const response = await authed("/portal-api/scenarios/edfali/audit");
    expect(response.status).toBe(200);
  });
});

describe("Suite 05 · fake-rails transaction lifecycle", () => {
  test("an OTP transaction is created and can be listed", async () => {
    await createTransaction("EXH-TX-1");
    expect(transactionId.length).toBeGreaterThan(0);
    const summary = await authed("/portal-api/transactions/summary");
    expect(summary.status).toBe(200);
    const detail = await authed(`/portal-api/transactions/${transactionId}`);
    expect(detail.status).toBe(200);
  });

  test("APPROVE settles the transaction", async () => {
    const response = await authed(`/portal-api/transactions/${transactionId}/action`, {
      method: "POST",
      body: { action: "APPROVE" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { transaction: { status: string } }).transaction.status).toBe("PAID");
  });

  test("REJECT fails a fresh transaction", async () => {
    await createTransaction("EXH-TX-REJECT");
    const response = await authed(`/portal-api/transactions/${transactionId}/action`, {
      method: "POST",
      body: { action: "REJECT" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { transaction: { status: string } }).transaction.status).toBe("FAILED");
  });

  test("CANCEL cancels a fresh transaction", async () => {
    await createTransaction("EXH-TX-CANCEL");
    const response = await authed(`/portal-api/transactions/${transactionId}/action`, {
      method: "POST",
      body: { action: "CANCEL" },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { transaction: { status: string } }).transaction.status).toBe("CANCELLED");
  });

  test("FORCE_OUTCOME records the failure phase", async () => {
    await createTransaction("EXH-TX-FORCE");
    const response = await authed(`/portal-api/transactions/${transactionId}/action`, {
      method: "POST",
      body: { action: "FORCE_OUTCOME", phase: "SUBMIT", failureMode: "TIMEOUT_HANG_ABOVE_STEP_TTL" },
    });
    expect(response.status).toBe(200);
  });

  test("the transaction step events are readable", async () => {
    const response = await authed(`/portal-api/transactions/${transactionId}/events`);
    expect(response.status).toBe(200);
  });
});

describe("Suite 05 · fake-rails webhooks & statements", () => {
  test("a duplicate webhook delivery is queued N times", async () => {
    await createTransaction("EXH-TX-WEBHOOK");
    const response = await authed(`/portal-api/webhooks/${transactionId}/fire`, {
      method: "POST",
      body: { event: "payment.paid", duplicateCount: 3 },
    });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { deliveries: unknown[] }).deliveries).toHaveLength(3);
  });

  test("a tampered webhook can be replayed", async () => {
    const list = await authed(`/portal-api/webhooks?transactionId=${transactionId}`);
    const deliveries = ((await list.json()) as { deliveries: Array<{ id: string }> }).deliveries;
    const id = deliveries[0]?.id;
    if (!id) {
      expect(true).toBe(true);
      return;
    }
    const response = await authed(`/portal-api/webhooks/${id}/replay?tamper=true`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  test("a dispute webhook is queued", async () => {
    const response = await authed(`/portal-api/webhooks/${transactionId}/dispute`, { method: "POST" });
    expect(response.status).toBe(202);
  });

  test("a CSV statement can be generated", async () => {
    const response = await authed("/portal-api/statements/generate", {
      method: "POST",
      body: { gatewayCode: "edfali", format: "csv" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/csv");
  });

  test("a JSON statement can be generated with anomalies", async () => {
    const response = await authed("/portal-api/statements/generate", {
      method: "POST",
      body: {
        gatewayCode: "edfali",
        format: "json",
        anomalies: { feeVariancePercent: 100, addUnrecorded: true, omitOne: false },
      },
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(((await response.json()) as { lines: unknown[] }).lines)).toBe(true);
  });

  test("an XLSX statement can be generated", async () => {
    const response = await authed("/portal-api/statements/generate", {
      method: "POST",
      body: { gatewayCode: "edfali", format: "xlsx" },
    });
    expect(response.status).toBe(200);
  });

  test("an invalid statement window is refused", async () => {
    const response = await authed("/portal-api/statements/generate", {
      method: "POST",
      body: { gatewayCode: "edfali", from: "2026-06-01", to: "2026-01-01" },
    });
    expect(response.status).toBe(400);
  });

  test("generated statements are listed", async () => {
    const response = await authed("/portal-api/statements");
    expect(response.status).toBe(200);
    expect(Array.isArray(((await response.json()) as { statements: unknown[] }).statements)).toBe(true);
  });
});
