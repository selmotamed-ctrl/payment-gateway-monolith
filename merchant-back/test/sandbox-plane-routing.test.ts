import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetEnvCache } from "../lib/env";
import { resetCoreAgent } from "../lib/coreInternalClient";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { SESSION_BEARER } from "./helpers/session";

const pki: TestPki = createTestPki("merchant-plane");
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

const call = (headers: Record<string, string>) =>
  fetch(`${edgeUrl}/api/v1/merchant/wallets`, { headers });

describe("merchant edge dual-pool routing", () => {
  test("a session request without X-Pg-Env goes to the live pool", async () => {
    const beforeLive = live.requests.length;
    const beforeSandbox = sandbox.requests.length;
    const response = await call({ authorization: SESSION_BEARER });
    expect(response.status).toBe(200);
    expect(live.requests.length).toBe(beforeLive + 1);
    expect(sandbox.requests.length).toBe(beforeSandbox);
  });

  test("X-Pg-Env: SANDBOX goes exclusively to the sandbox pool", async () => {
    const beforeLive = live.requests.length;
    const beforeSandbox = sandbox.requests.length;
    const response = await call({ authorization: SESSION_BEARER, "x-pg-env": "SANDBOX" });
    expect(response.status).toBe(200);
    expect(sandbox.requests.length).toBe(beforeSandbox + 1);
    expect(live.requests.length).toBe(beforeLive);
    expect(sandbox.requests.at(-1)?.headers["x-pg-env"]).toBe("SANDBOX");
  });

  test("a pg_test_ external API token goes to the sandbox pool", async () => {
    const token = `pg_test_${"A".repeat(43)}`;
    const beforeLive = live.requests.length;
    const beforeSandbox = sandbox.requests.length;
    const response = await fetch(`${edgeUrl}/api/v1/external/links/pl_TESTKEY1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(sandbox.requests.length).toBe(beforeSandbox + 1);
    expect(live.requests.length).toBe(beforeLive);
    expect(sandbox.requests.at(-1)?.headers.authorization).toBe(`Bearer ${token}`);
  });
});
