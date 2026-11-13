import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const previous = { ...process.env };
process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = "https://core.live.internal:4000";
process.env.SANDBOX_CORE_BACK_URLS = "https://core.sandbox.internal:4005";
process.env.MTLS_CLIENT_CERT_PATH = "./certs/merchant-back-client.crt";
process.env.MTLS_CLIENT_KEY_PATH = "./certs/merchant-back-client.key";
process.env.MTLS_CA_CERT_PATH = "./certs/internal-ca.crt";

type Pools = typeof import("../lib/corePools");
type External = typeof import("../api/external/index");
type EnvModule = typeof import("../lib/env");

let pools: Pools;
let external: External;
let envModule: EnvModule;

beforeAll(async () => {
  envModule = await import("../lib/env");
  pools = await import("../lib/corePools");
  external = await import("../api/external/index");
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
  envModule?.resetEnvCache();
});

const request = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as never;

describe("merchant sandbox routing", () => {
  test("a pg_test_ token targets the sandbox pool and a pg_live_ token targets Live", () => {
    expect(pools.requestPlane(request("Bearer pg_test_abc"))).toBe("SANDBOX");
    expect(pools.requestPlane(request("Bearer pg_live_abc"))).toBe("LIVE");
    expect(pools.targetUrlsForRequest(request("Bearer pg_test_abc"))).toEqual([
      "https://core.sandbox.internal:4005",
    ]);
    expect(pools.targetUrlsForRequest(request("Bearer pg_live_abc"))).toBeUndefined();
  });

  test("an unconfigured sandbox node fails closed with 503", () => {
    envModule.resetEnvCache();
    delete process.env.SANDBOX_CORE_BACK_URLS;
    delete process.env.SANDBOX_CORE_BACK_URL;
    try {
      expect(() => pools.requireSandboxCoreBackUrls()).toThrow(/not configured/);
      try {
        pools.requireSandboxCoreBackUrls();
      } catch (error) {
        expect((error as { statusCode?: number }).statusCode).toBe(503);
        expect((error as { code?: string }).code).toBe("SANDBOX_NODE_UNAVAILABLE");
      }
    } finally {
      process.env.SANDBOX_CORE_BACK_URLS = "https://core.sandbox.internal:4005";
      envModule.resetEnvCache();
    }
  });

  test("the external API accepts both token prefixes and rejects a malformed token", () => {
    const body = "A".repeat(43);
    const accept = (authorization: string) => {
      let nextCalled = false;
      let error: unknown;
      try {
        external.requirePgLiveToken(
          { headers: { authorization } } as never,
          {} as never,
          ((value?: unknown) => {
            if (value) error = value;
            else nextCalled = true;
          }) as never,
        );
      } catch (caught) {
        error = caught;
      }
      return { nextCalled, error };
    };
    expect(accept(`Bearer pg_live_${body}`).nextCalled).toBe(true);
    expect(accept(`Bearer pg_test_${body}`).nextCalled).toBe(true);
    expect(accept("Bearer pg_test_short").error).toBeDefined();
    expect(accept("Bearer other").error).toBeDefined();
  });
});
