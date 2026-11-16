import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore } from "./helpers/core";

const pki = createTestPki("merchant-back");
const core = await startTestCore(pki);

const setEnv = () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  delete process.env.CORE_BACK_URLS;
  process.env.SANDBOX_CORE_BACK_URL = core.url;
  delete process.env.SANDBOX_CORE_BACK_URLS;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.SESSION_COOKIE_MODE = "false";
};
setEnv();

const { createApp } = await import("../index");
const { resetEnvCache } = await import("../lib/env");

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

beforeAll(async () => {
  setEnv();
  resetEnvCache();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
});

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJwYXltZW50LWdhdGV3YXktbWVyY2hhbnQifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbg";

describe("merchant sandbox proxy forwarding", () => {
  test("control routes go to /internal/sandbox on the sandbox pool", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/merchant/sandbox/seed-demo`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect([200, 201, 404]).toContain(response.status);
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/sandbox/merchant/seed-demo");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("studio read routes go to /internal/sandbox/merchant/studio", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/merchant/sandbox/studio/wallets?page=1&pageSize=20`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect([200, 404]).toContain(response.status);
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/sandbox/merchant/studio/wallets?page=1&pageSize=20");
  });

  test("resource routes go to /internal/merchant on the sandbox pool", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/merchant/sandbox/wallets?limit=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect([200, 404]).toContain(response.status);
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/merchant/wallets?limit=5");
  });

  test("wallet detail and payment detail use the sandbox control handler", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/merchant/sandbox/wallets/wal_1/ledger`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect([200, 404]).toContain(response.status);
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/sandbox/merchant/wallets/wal_1/ledger");

    const beforePayment = core.requests.length;
    const payment = await fetch(`${base}/api/v1/merchant/sandbox/payments/pay_1/refund`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect([200, 201, 404, 409]).toContain(payment.status);
    const paymentCall = core.requests[beforePayment]!;
    expect(paymentCall.url).toBe("/internal/sandbox/merchant/payments/pay_1/refund");
  });

  test("fake-rails account routes go to /internal/sandbox/fake-rails", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/merchant/sandbox/fake-rails/accounts?railCode=sadad`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect([200, 404]).toContain(response.status);
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/sandbox/fake-rails/accounts?railCode=sadad");
  });

  test("a pg_test_ external token is forwarded to the sandbox core", async () => {
    const before = core.requests.length;
    const testToken = `pg_test_${"A".repeat(43)}`;
    const response = await fetch(`${base}/api/v1/external/links`, {
      method: "POST",
      headers: { authorization: `Bearer ${testToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Sandbox link",
        amount: "10.0000",
        currency: "LYD",
      }),
    });
    expect([200, 201, 400, 404]).toContain(response.status);
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/merchant/external/links");
    expect(call.headers.authorization).toBe(`Bearer ${testToken}`);
  });
});
