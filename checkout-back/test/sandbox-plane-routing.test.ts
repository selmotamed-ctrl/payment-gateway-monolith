import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetEnvCache } from "../lib/env";
import { resetCoreAgent } from "../lib/coreInternalClient";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";

const pki: TestPki = createTestPki();
const live: TestCore = await startTestCore(pki);
const sandbox: TestCore = await startTestCore(pki);

const { createApp } = await import("../index");
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;
let edgeUrl = "";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = live.url;
  process.env.CORE_BACK_URLS = live.url;
  process.env.SANDBOX_CORE_BACK_URL = sandbox.url;
  process.env.SANDBOX_CORE_BACK_URLS = sandbox.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.PAY_RATE_LIMIT_MAX = "100000";
  process.env.TRUSTED_PROXY_CIDRS = "127.0.0.0/8,::1/128";
  resetEnvCache();
  resetCoreAgent();
  const app = createApp();
  edgeServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  edgeUrl = `http://127.0.0.1:${(edgeServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  delete process.env.SANDBOX_CORE_BACK_URL;
  delete process.env.SANDBOX_CORE_BACK_URLS;
  delete process.env.CORE_BACK_URLS;
  resetEnvCache();
  resetCoreAgent();
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await live.close();
  await sandbox.close();
});

describe("checkout edge dual-pool routing", () => {
  test("a live-looking link key goes to the live pool and never exposes sandbox endpoints", async () => {
    const beforeLive = live.requests.length;
    const beforeSandbox = sandbox.requests.length;
    const response = await fetch(`${edgeUrl}/api/v1/pay/pay_TESTKEY1`);
    expect(response.status).toBe(200);
    expect(live.requests.length).toBe(beforeLive + 1);
    expect(sandbox.requests.length).toBe(beforeSandbox);

    const forbidden = await fetch(`${edgeUrl}/api/v1/pay/pay_TESTKEY1/sandbox-accounts`);
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe("SANDBOX_ONLY_ENDPOINT");
    expect(live.requests.length).toBe(beforeLive + 1);
  });

  test("an sbx_ link key goes exclusively to the sandbox pool", async () => {
    const beforeLive = live.requests.length;
    const beforeSandbox = sandbox.requests.length;
    const response = await fetch(`${edgeUrl}/api/v1/pay/sbx_TESTKEY1`, {
      headers: { "x-pg-sandbox-pin": "4321" },
    });
    expect(response.status).toBe(200);
    expect(sandbox.requests.length).toBe(beforeSandbox + 1);
    expect(live.requests.length).toBe(beforeLive);
    expect(sandbox.requests.at(-1)?.headers["x-pg-env"]).toBe("SANDBOX");
    expect(sandbox.requests.at(-1)?.headers["x-pg-sandbox-pin"]).toBe("4321");
  });

  test("the sandbox accounts endpoint forwards a PATCH to the sandbox pool", async () => {
    const beforeSandbox = sandbox.requests.length;
    const response = await fetch(`${edgeUrl}/api/v1/pay/sbx_TESTKEY1/sandbox-accounts/acc-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quickPreset: "SET_ZERO" }),
    });
    expect(response.status).toBe(200);
    expect(sandbox.requests.length).toBe(beforeSandbox + 1);
    expect(sandbox.requests.at(-1)?.url).toContain("/sandbox-accounts/acc-1");
  });
});
