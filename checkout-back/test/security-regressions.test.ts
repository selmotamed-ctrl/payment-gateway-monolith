import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { createTestPki, startTestCore } from "./helpers/core";

const pki = createTestPki();
const core = await startTestCore(pki);
process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = core.url;
process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
process.env.MTLS_CA_CERT_PATH = pki.caCert;
process.env.INBOUND_RATE_LIMIT_MAX = "2";

const { createApp } = await import("../index");
const { resolveClientIp, parseCidrList } = await import("../lib/net");
const { buildCoreHeaders, callCoreRaw, resetCoreAgent } = await import("../lib/coreInternalClient");
const { redactUrl } = await import("../lib/requestLogger");
const { env, resetEnvCache } = await import("../lib/env");

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let port = 0;
/** Whether the request body had been fully read when the response headers were written. */
let bodyConsumedAtResponse: boolean | undefined;

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0, "127.0.0.1");
  server.prependListener("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    (res as unknown as { writeHead: unknown }).writeHead = (...args: unknown[]) => {
      bodyConsumedAtResponse ??= req.readableEnded;
      return writeHead(...args);
    };
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
  resetCoreAgent();
});

/** Each test posts as its own client (the loopback proxy is trusted) so buckets never overlap. */
const post = (path: string, size: number, method = "POST", clientIp = "198.51.100.1") =>
  new Promise<{ status: number; body: string } | "reset">((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
          connection: "close",
          "x-real-client-ip": clientIp,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", () => resolve("reset"));
    request.end(Buffer.alloc(size, 0x41));
  });

describe("inbound webhooks", () => {
  test("the rate limiter rejects before the body is read and is keyed per channel", async () => {
    const channelA = "/api/v1/inbound/gw/sandbox/channel-token-a";
    expect(await post(channelA, 10, "POST", "198.51.100.10")).toMatchObject({ status: 200 });
    expect(await post(channelA, 10, "POST", "198.51.100.10")).toMatchObject({ status: 200 });
    bodyConsumedAtResponse = undefined;
    const limited = await post(channelA, 900_000, "POST", "198.51.100.10");
    // The edge answers (or resets the connection) while the large body is still unread.
    if (limited !== "reset") expect(limited.status).toBe(429);
    expect(bodyConsumedAtResponse === undefined || bodyConsumedAtResponse === false).toBe(true);
    // A different channel from the same client still has its own budget.
    expect(await post("/api/v1/inbound/gw/sandbox/channel-token-b", 10, "POST", "198.51.100.10")).toMatchObject({ status: 200 });
  });

  test("a body above the raw limit is rejected with 413 and never reaches core", async () => {
    const before = core.requests.length;
    const result = await post("/api/v1/inbound/gw/sandbox/channel-token-big", env.MAX_INBOUND_BODY_BYTES + 1024, "POST", "198.51.100.11");
    if (result !== "reset") expect(result.status).toBe(413);
    expect(core.requests.length).toBe(before);
  });

  test("the raw body limit is the documented 1 MiB", () => {
    expect(env.MAX_INBOUND_BODY_BYTES).toBe(1048576);
  });

  test("only GET and POST are accepted", async () => {
    const before = core.requests.length;
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const result = await post("/api/v1/inbound/gw/sandbox/channel-token-m", 4, method, "198.51.100.12");
      expect(result).not.toBe("reset");
      if (result !== "reset") expect(result.status).toBe(405);
    }
    expect(core.requests.length).toBe(before);
  });

  test("core's error envelope is replaced by a safe public one", async () => {
    const result = await post("/api/v1/inbound/gw/sandbox/denied-channel", 4, "POST", "198.51.100.13");
    expect(result).not.toBe("reset");
    if (result === "reset") return;
    expect(result.status).toBe(404);
    const payload = JSON.parse(result.body) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["code", "message"]);
    expect(payload.code).toBe("INBOUND_NOT_FOUND");
    expect(result.body).not.toContain("secret-gateway");
    expect(result.body).not.toContain("ref-internal-1");
    expect(result.body).not.toContain("INBOUND_GATEWAY_MISMATCH");
  });
});

describe("client ip resolution", () => {
  const cidrs = () => parseCidrList(env.TRUSTED_PROXY_CIDRS);

  test("the default trusted proxies are loopback only", () => {
    expect(env.TRUSTED_PROXY_CIDRS).toBe("127.0.0.0/8,::1/128");
  });

  test("forwarded headers from a private network peer are ignored under the default", () => {
    const viaRealIp = resolveClientIp(
      { socket: { remoteAddress: "10.1.2.3" }, headers: { "x-real-ip": "1.2.3.4" } } as never,
      cidrs(),
    );
    const viaClientIp = resolveClientIp(
      { socket: { remoteAddress: "192.168.5.5" }, headers: { "x-real-client-ip": "9.9.9.9" } } as never,
      cidrs(),
    );
    expect(viaRealIp).toBe("10.1.2.3");
    expect(viaClientIp).toBe("192.168.5.5");
  });

  test("a loopback proxy is trusted, a malformed forwarded value is not", () => {
    const trusted = resolveClientIp(
      { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": "203.0.113.7" } } as never,
      cidrs(),
    );
    const malformed = resolveClientIp(
      { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": "not-an-ip, 1.1.1.1" } } as never,
      cidrs(),
    );
    expect(trusted).toBe("203.0.113.7");
    expect(malformed).toBe("127.0.0.1");
  });

  test("the edge overwrites x-real-client-ip towards core with the resolved address", async () => {
    process.env.NODE_ENV = "test";
    const before = core.requests.length;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/pay/LNKOKAY0001`, {
      headers: { "x-real-client-ip": "198.51.100.77", "x-forwarded-for": "198.51.100.78" },
    });
    expect(response.status).toBeLessThan(500);
    expect(core.requests.length).toBeGreaterThan(before);
    // The peer is loopback (trusted), so the proxy supplied value is what core receives.
    expect(core.requests.at(-1)?.headers["x-real-client-ip"]).toBe("198.51.100.77");
    expect(core.requests.at(-1)?.headers["x-edge-service"]).toBe("checkout-back");
  });
});

describe("core client", () => {
  test("edge owned headers cannot be overridden by the caller", () => {
    const headers = buildCoreHeaders({
      method: "POST",
      path: "/internal/checkout/x",
      requestId: "r",
      clientIp: "10.9.9.9",
      body: {},
      headers: { "X-Edge-Service": "core-back", "x-real-client-ip": "1.1.1.1", Authorization: "Bearer evil" },
    });
    expect(headers["x-edge-service"]).toBe("checkout-back");
    expect(headers["x-real-client-ip"]).toBe("10.9.9.9");
    expect(headers.authorization).toBeUndefined();
  });

  test("a header with control characters is rejected before dispatch and does not trip the breaker", async () => {
    resetEnvCache();
    resetCoreAgent();
    const before = core.requests.length;
    const poisoned = await callCoreRaw({
      method: "GET",
      path: "/internal/checkout/pay/LNKOKAY0001",
      requestId: "r",
      clientIp: "10.0.0.1",
      headers: { "x-test": "a\u0001b" },
    }).catch((error: unknown) => error as { statusCode?: number; code?: string });
    expect((poisoned as { statusCode?: number }).statusCode).toBe(400);
    expect(core.requests.length).toBe(before);
    const valid = await callCoreRaw({
      method: "GET",
      path: "/internal/checkout/pay/LNKOKAY0001",
      requestId: "r",
      clientIp: "10.0.0.1",
    });
    expect(valid.statusCode).toBe(200);
  });
});

describe("log redaction", () => {
  test("capability path segments and sensitive query values are masked", () => {
    expect(redactUrl("/api/v1/inbound/gw/live/SECRETPATHTOKEN")).toBe("/api/v1/inbound/gw/live/[REDACTED]");
    expect(redactUrl("/api/v1/pay/LNKOKAY0001/logs/att_123/status")).not.toContain("LNKOKAY0001");
    expect(redactUrl("/api/v1/pay/LNKOKAY0001/logs/att_123/status")).not.toContain("att_123");
    expect(redactUrl("/api/v1/return/ATTEMPTTOKEN123?reference=R1&token=abc")).toBe(
      "/api/v1/return/[REDACTED]?reference=R1&token=[REDACTED]",
    );
  });
});

describe("response headers", () => {
  test("responses carry the basic security headers and never allow credentials", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: "https://pay.example.com" } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
