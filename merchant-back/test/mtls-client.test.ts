import { beforeAll, describe, expect, test } from "bun:test";
import { ApiError } from "../lib/error";


const { env } = await import("../lib/env");
const { assertCorePath, buildCoreHeaders, mapCoreHttpError, mapCoreTransportError, resolveCoreUrl } =
  await import("../lib/mtlsClient");

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = "https://core-back.internal:4000";
  process.env.MTLS_CLIENT_CERT_PATH = "/tmp/opencode/edge-tests/client.crt";
  process.env.MTLS_CLIENT_KEY_PATH = "/tmp/opencode/edge-tests/client.key";
  process.env.MTLS_CA_CERT_PATH = "/tmp/opencode/edge-tests/ca.crt";
});
describe("merchant channel confinement", () => {
  test("accepts the merchant namespace", () => {
    expect(assertCorePath("/internal/merchant/wallets")).toBe("/internal/merchant/wallets");
  });

  test("rejects other service channels", () => {
    for (const path of ["/internal/admin/users", "/internal/checkout/pay/ABC"]) {
      expect(() => assertCorePath(path)).toThrow(ApiError);
    }
    try {
      assertCorePath("/internal/admin/users");
    } catch (error) {
      expect((error as ApiError).code).toBe("CORE_CHANNEL_VIOLATION");
    }
  });

  test("rejects arbitrary urls and traversal", () => {
    expect(() => assertCorePath("https://evil.example.com/x")).toThrow(ApiError);
    expect(() => assertCorePath("//evil.example.com/x")).toThrow(ApiError);
    expect(() => assertCorePath("/internal/merchant/../admin")).toThrow(ApiError);
  });

  test("pins the resolved url to the configured core origin", () => {
    const url = resolveCoreUrl("/internal/merchant/links", { page: "2" });
    expect(url.origin).toBe(new URL(env.CORE_BACK_URL).origin);
    expect(url.pathname).toBe("/internal/merchant/links");
    expect(url.search).toBe("?page=2");
  });
});

describe("merchant core error mapping", () => {
  test("keeps the core envelope", () => {
    const error = mapCoreHttpError(409, { code: "IDEMPOTENCY_CONFLICT", message: "key reused" });
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.message).toBe("key reused");
  });

  test("falls back to stable codes", () => {
    expect(mapCoreHttpError(500, {}).code).toBe("CORE_INTERNAL_ERROR");
    expect(mapCoreHttpError(401, {}).code).toBe("CORE_UNAUTHORIZED");
    expect(mapCoreHttpError(403, {}).code).toBe("CORE_FORBIDDEN");
  });

  test("maps transport failures", () => {
    expect(mapCoreTransportError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).code).toBe("CORE_TIMEOUT");
    expect(mapCoreTransportError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).code).toBe("CORE_UNREACHABLE");
    expect(mapCoreTransportError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" })).code).toBe("CORE_TLS_ERROR");
  });
});

describe("merchant core request headers", () => {
  test("forwards the identity headers and the bearer token", () => {
    const headers = buildCoreHeaders({
      method: "POST",
      path: "/internal/merchant/links",
      requestId: "req-9",
      clientIp: "198.51.100.4",
      userAgent: "merchant-portal/2.1",
      authorization: "Bearer pg_live_abc",
      body: { title: "x" },
    });
    expect(headers["x-request-id"]).toBe("req-9");
    expect(headers["x-real-client-ip"]).toBe("198.51.100.4");
    expect(headers["x-client-user-agent"]).toBe("merchant-portal/2.1");
    expect(headers["x-edge-service"]).toBe("merchant-back");
    expect(headers.authorization).toBe("Bearer pg_live_abc");
  });
});
