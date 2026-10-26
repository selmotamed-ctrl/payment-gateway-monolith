import { describe, expect, test } from "bun:test";
import { ApiError } from "../lib/error";

process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = "https://core-back.internal:4000";
process.env.MTLS_CLIENT_CERT_PATH = "/tmp/opencode/edge-tests/client.crt";
process.env.MTLS_CLIENT_KEY_PATH = "/tmp/opencode/edge-tests/client.key";
process.env.MTLS_CA_CERT_PATH = "/tmp/opencode/edge-tests/ca.crt";

const { env } = await import("../lib/env");
const { assertCorePath, buildCoreHeaders, mapCoreHttpError, mapCoreTransportError, resolveCoreUrl } =
  await import("../lib/mtlsClient");

describe("admin channel confinement", () => {
  test("accepts the admin namespace", () => {
    expect(assertCorePath("/internal/admin/merchants")).toBe("/internal/admin/merchants");
  });

  test("rejects other service channels", () => {
    for (const path of ["/internal/merchant/wallets", "/internal/checkout/pay/ABC"]) {
      expect(() => assertCorePath(path)).toThrow(ApiError);
    }
    try {
      assertCorePath("/internal/checkout/pay/ABC");
    } catch (error) {
      expect((error as ApiError).code).toBe("CORE_CHANNEL_VIOLATION");
      expect((error as ApiError).statusCode).toBe(403);
    }
  });

  test("rejects arbitrary urls and traversal", () => {
    expect(() => assertCorePath("https://evil.example.com/x")).toThrow(ApiError);
    expect(() => assertCorePath("//evil.example.com/x")).toThrow(ApiError);
    expect(() => assertCorePath("/internal/admin/../../etc")).toThrow(ApiError);
  });

  test("pins the resolved url to the configured core origin", () => {
    const url = resolveCoreUrl("/internal/admin/aml/cases", { page: "1" });
    expect(url.origin).toBe(new URL(env.CORE_BACK_URL).origin);
    expect(url.pathname).toBe("/internal/admin/aml/cases");
  });
});

describe("admin core error mapping", () => {
  test("keeps the core envelope", () => {
    const error = mapCoreHttpError(403, { code: "MAKER_CHECKER_VIOLATION", message: "checker cannot be maker" });
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("MAKER_CHECKER_VIOLATION");
  });

  test("falls back to stable codes", () => {
    expect(mapCoreHttpError(500, {}).code).toBe("CORE_INTERNAL_ERROR");
    expect(mapCoreHttpError(404, {}).code).toBe("CORE_NOT_FOUND");
    expect(mapCoreHttpError(422, {}).code).toBe("CORE_VALIDATION_FAILED");
  });

  test("maps transport failures", () => {
    expect(mapCoreTransportError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).code).toBe("CORE_TIMEOUT");
    expect(mapCoreTransportError(Object.assign(new Error("x"), { code: "ENOTFOUND" })).code).toBe("CORE_DNS_FAILURE");
    expect(mapCoreTransportError(Object.assign(new Error("x"), { code: "EPROTO" })).code).toBe("CORE_TLS_ERROR");
  });
});

describe("admin core request headers", () => {
  test("forwards the identity headers and the bearer token", () => {
    const headers = buildCoreHeaders({
      method: "GET",
      path: "/internal/admin/merchants",
      requestId: "req-admin",
      clientIp: "10.10.0.5",
      userAgent: "admin-spa/1.0",
      authorization: "Bearer admin-session",
    });
    expect(headers["x-request-id"]).toBe("req-admin");
    expect(headers["x-real-client-ip"]).toBe("10.10.0.5");
    expect(headers["x-client-user-agent"]).toBe("admin-spa/1.0");
    expect(headers["x-edge-service"]).toBe("admin-back");
    expect(headers.authorization).toBe("Bearer admin-session");
  });
});
