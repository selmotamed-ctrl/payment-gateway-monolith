import { beforeAll, describe, expect, test } from "bun:test";
import { ApiError } from "../lib/error";


const { env } = await import("../lib/env");

const {
  assertCorePath,
  mapCoreHttpError,
  mapCoreTransportError,
  resolveCoreUrl,
  buildCoreHeaders,
} = await import("../lib/mtlsClient");

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = "https://core-back.internal:4000";
  process.env.MTLS_CLIENT_CERT_PATH = "/tmp/opencode/edge-tests/client.crt";
  process.env.MTLS_CLIENT_KEY_PATH = "/tmp/opencode/edge-tests/client.key";
  process.env.MTLS_CA_CERT_PATH = "/tmp/opencode/edge-tests/ca.crt";
});
describe("core http error mapping", () => {
  test("keeps the core envelope code and message", () => {
    const error = mapCoreHttpError(404, { code: "LINK_NOT_FOUND", message: "payment link not found" });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("LINK_NOT_FOUND");
    expect(error.message).toBe("payment link not found");
  });

  test("preserves the core reference and details", () => {
    const error = mapCoreHttpError(409, {
      code: "SLOT_EXHAUSTED",
      message: "no active slot left",
      reference: "ref-42",
      details: { activeLockedCount: 5 },
    });
    expect(error.reference).toBe("ref-42");
    expect(error.details).toEqual({ activeLockedCount: 5 });
    expect(error.toEnvelope()).toEqual({
      code: "SLOT_EXHAUSTED",
      message: "no active slot left",
      reference: "ref-42",
      details: { activeLockedCount: 5 },
    });
  });

  test("falls back to a stable code per status", () => {
    expect(mapCoreHttpError(500, {}).code).toBe("CORE_INTERNAL_ERROR");
    expect(mapCoreHttpError(502, undefined).code).toBe("CORE_BAD_GATEWAY");
    expect(mapCoreHttpError(503, "plain text").code).toBe("CORE_UNAVAILABLE");
    expect(mapCoreHttpError(504, null).code).toBe("CORE_GATEWAY_TIMEOUT");
    expect(mapCoreHttpError(429, {}).code).toBe("CORE_RATE_LIMITED");
    expect(mapCoreHttpError(401, {}).code).toBe("CORE_UNAUTHORIZED");
    expect(mapCoreHttpError(403, {}).code).toBe("CORE_FORBIDDEN");
    expect(mapCoreHttpError(418, {}).code).toBe("CORE_ERROR");
    expect(mapCoreHttpError(500, {}).statusCode).toBe(500);
  });
});

describe("core transport error mapping", () => {
  test("maps timeouts to a gateway timeout", () => {
    const error = mapCoreTransportError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    expect(error.statusCode).toBe(504);
    expect(error.code).toBe("CORE_TIMEOUT");
  });

  test("maps refused connections to an unreachable core", () => {
    const error = mapCoreTransportError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    expect(error.statusCode).toBe(502);
    expect(error.code).toBe("CORE_UNREACHABLE");
  });

  test("maps dns failures", () => {
    const error = mapCoreTransportError(Object.assign(new Error("dns"), { code: "ENOTFOUND" }));
    expect(error.statusCode).toBe(502);
    expect(error.code).toBe("CORE_DNS_FAILURE");
  });

  test("maps tls handshake failures", () => {
    for (const code of ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "EPROTO", "SELF_SIGNED_CERT_IN_CHAIN"]) {
      const error = mapCoreTransportError(Object.assign(new Error("tls"), { code }));
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe("CORE_TLS_ERROR");
    }
  });

  test("never leaks an api error through the transport mapper", () => {
    const original = new ApiError(418, "TEAPOT", "short and stout");
    expect(mapCoreTransportError(original)).toBe(original);
  });

  test("maps unknown failures to a generic connection error", () => {
    const error = mapCoreTransportError(new Error("boom"));
    expect(error.statusCode).toBe(502);
    expect(error.code).toBe("CORE_CONNECTION_ERROR");
  });
});

describe("core path confinement", () => {
  test("accepts paths inside the service channel", () => {
    expect(assertCorePath("/internal/checkout/pay/ABC")).toBe("/internal/checkout/pay/ABC");
  });

  test("rejects paths outside the service channel", () => {
    expect(() => assertCorePath("/internal/admin/users")).toThrow(ApiError);
    try {
      assertCorePath("/internal/admin/users");
    } catch (error) {
      expect((error as ApiError).code).toBe("CORE_CHANNEL_VIOLATION");
      expect((error as ApiError).statusCode).toBe(403);
    }
  });

  test("rejects absolute urls and traversal", () => {
    expect(() => assertCorePath("https://evil.example.com/x")).toThrow(ApiError);
    expect(() => assertCorePath("//evil.example.com/x")).toThrow(ApiError);
    expect(() => assertCorePath("/internal/checkout/../../admin")).toThrow(ApiError);
    expect(() => assertCorePath("internal/checkout/pay")).toThrow(ApiError);
  });

  test("pins every resolved url to the configured core origin", () => {
    const url = resolveCoreUrl("/internal/checkout/pay/ABC", { attempt: "a1", skipped: undefined });
    expect(url.origin).toBe(new URL(env.CORE_BACK_URL).origin);
    expect(url.pathname).toBe("/internal/checkout/pay/ABC");
    expect(url.search).toBe("?attempt=a1");
  });
});

describe("core request headers", () => {
  test("forwards request identity, client ip, user agent and authorization", () => {
    const headers = buildCoreHeaders({
      method: "POST",
      path: "/internal/checkout/pay/ABC/initiate",
      requestId: "req-1",
      clientIp: "203.0.113.9",
      userAgent: "checkout-front/1.0",
      authorization: "Bearer token-123",
      body: { railCode: "X" },
    });
    expect(headers["x-request-id"]).toBe("req-1");
    expect(headers["x-real-client-ip"]).toBe("203.0.113.9");
    expect(headers["x-client-user-agent"]).toBe("checkout-front/1.0");
    expect(headers["x-edge-service"]).toBe("checkout-back");
    expect(headers.authorization).toBe("Bearer token-123");
    expect(headers["content-type"]).toBe("application/json");
  });
});
