import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const previous = { ...process.env };
process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = "https://core.live.internal:4000";
process.env.SANDBOX_CORE_BACK_URLS = "https://core.sandbox.internal:4005";
process.env.MTLS_CLIENT_CERT_PATH = "./certs/checkout-back-client.crt";
process.env.MTLS_CLIENT_KEY_PATH = "./certs/checkout-back-client.key";
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

describe("checkout sandbox link routing", () => {
  test("only the sbx_ prefix selects the isolated sandbox pool", () => {
    expect(pools.isSandboxLinkKey("sbx_abc")).toBe(true);
    expect(pools.isSandboxLinkKey("pl_abc")).toBe(false);
    expect(pools.linkTargetUrls("sbx_abc")).toEqual(["https://core.sandbox.internal:4005"]);
    expect(pools.linkTargetUrls("pl_abc")).toBeUndefined();
  });

  test("an sbx_ link without a configured sandbox node is refused with 503", () => {
    envModule.resetEnvCache();
    delete process.env.SANDBOX_CORE_BACK_URLS;
    delete process.env.SANDBOX_CORE_BACK_URL;
    try {
      expect(() => pools.requireSandboxCoreBackUrls()).toThrow(/not configured/);
      try {
        pools.linkTargetUrls("sbx_abc");
      } catch (error) {
        expect((error as { statusCode?: number }).statusCode).toBe(503);
      }
    } finally {
      process.env.SANDBOX_CORE_BACK_URLS = "https://core.sandbox.internal:4005";
      envModule.resetEnvCache();
    }
  });
});
