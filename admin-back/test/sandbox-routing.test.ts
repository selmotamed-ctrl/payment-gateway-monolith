import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const previous = { ...process.env };
process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = "https://core.live.internal:4000";
process.env.SANDBOX_CORE_BACK_URLS = "https://core.sandbox.internal:4005";
process.env.MTLS_CLIENT_CERT_PATH = "./certs/admin-back-client.crt";
process.env.MTLS_CLIENT_KEY_PATH = "./certs/admin-back-client.key";
process.env.MTLS_CA_CERT_PATH = "./certs/internal-ca.crt";

type Pools = typeof import("../lib/corePools");
type EnvModule = typeof import("../lib/env");
let pools: Pools;
let envModule: EnvModule;

beforeAll(async () => {
  envModule = await import("../lib/env");
  pools = await import("../lib/corePools");
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
  envModule?.resetEnvCache();
});

describe("admin sandbox routing", () => {
  test("maps Studio control paths to the sandbox admin namespace", async () => {
    const { targetPath } = await import("../api/sandboxProxy");
    const request = (path: string, body: Record<string, unknown> = {}) => ({ path, body, query: {}, header: () => undefined }) as any;
    expect(targetPath(request("/merchants"))).toBe("/internal/sandbox/admin/merchants");
    expect(targetPath(request("/merchants/summary"))).toBe("/internal/sandbox/admin/merchants/summary");
    expect(targetPath(request("/merchants/11111111-1111-4111-8111-111111111111"))).toBe("/internal/sandbox/admin/merchants/11111111-1111-4111-8111-111111111111");
    expect(targetPath(request("/audits"))).toBe("/internal/sandbox/admin/audits");
  });
  test("uses the sandbox core pool and never falls back to Live", () => {
    expect(pools.requireSandboxCoreBackUrls()).toEqual(["https://core.sandbox.internal:4005"]);
  });

  test("fails closed when no sandbox node is configured", () => {
    envModule.resetEnvCache();
    delete process.env.SANDBOX_CORE_BACK_URLS;
    delete process.env.SANDBOX_CORE_BACK_URL;
    try {
      try {
        pools.requireSandboxCoreBackUrls();
        throw new Error("expected a 503");
      } catch (error) {
        expect((error as { statusCode?: number }).statusCode).toBe(503);
        expect((error as { code?: string }).code).toBe("SANDBOX_NODE_UNAVAILABLE");
      }
    } finally {
      process.env.SANDBOX_CORE_BACK_URLS = "https://core.sandbox.internal:4005";
      envModule.resetEnvCache();
    }
  });
});
