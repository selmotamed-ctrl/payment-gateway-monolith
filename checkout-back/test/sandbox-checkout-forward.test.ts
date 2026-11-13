import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore } from "./helpers/core";

const pki = createTestPki();
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

describe("checkout sandbox forwarding", () => {
  test("a sandbox summary is forwarded through the sandbox pool", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/pay/sbx_test123`);
    expect(response.status).toBe(200);
    expect(core.requests[before]?.url).toBe("/internal/checkout/pay/sbx_test123");
  });

  test("a live summary stays on the live pool", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/pay/pl_test123`);
    expect(response.status).toBe(200);
    expect(core.requests[before]?.url).toBe("/internal/checkout/pay/pl_test123");
  });

  test("the inspector is refused on a live link without touching core", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/pay/pl_test123/sandbox-accounts`);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK");
    expect(core.requests.length).toBe(before);

    const inspector = await fetch(`${base}/api/v1/pay/pl_test123/logs/att_123/sandbox-inspector`);
    expect(inspector.status).toBe(403);
    expect(core.requests.length).toBe(before);
  });

  test("the inspector is forwarded on a sandbox link", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/pay/sbx_test123/logs/att_123/sandbox-inspector`);
    expect(response.status).toBe(200);
    expect(core.requests[before]?.url).toBe(
      "/internal/checkout/pay/sbx_test123/logs/att_123/sandbox-inspector",
    );
  });
});
