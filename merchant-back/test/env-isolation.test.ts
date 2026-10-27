import { describe, expect, test } from "bun:test";
import { env, loadEnv } from "../lib/env";

describe("edge environment isolation", () => {
  test("the environment is not cached in the test environment", () => {
    const previous = { ...process.env };
    try {
      process.env.NODE_ENV = "test";
      process.env.CORE_BACK_URL = "https://first.internal:4000";
      process.env.MTLS_CLIENT_CERT_PATH = "/tmp/edge-isolation/client.crt";
      process.env.MTLS_CLIENT_KEY_PATH = "/tmp/edge-isolation/client.key";
      process.env.MTLS_CA_CERT_PATH = "/tmp/edge-isolation/ca.crt";
      expect(loadEnv().CORE_BACK_URL).toBe("https://first.internal:4000");
      // A second test file may configure its own environment. The edge must
      // never serve a configuration that was cached by another test file.
      process.env.CORE_BACK_URL = "https://second.internal:4000";
      expect(loadEnv().CORE_BACK_URL).toBe("https://second.internal:4000");
      expect(env.CORE_BACK_URL).toBe("https://second.internal:4000");
    } finally {
      process.env = previous;
    }
  });
});
