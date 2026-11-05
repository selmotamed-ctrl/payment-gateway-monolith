import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore } from "./helpers/core";

const pki = createTestPki("merchant-back");
const core = await startTestCore(pki);
process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = core.url;
process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
process.env.MTLS_CA_CERT_PATH = pki.caCert;
process.env.MAX_UPLOAD_BYTES = "20971520";

const { createApp } = await import("../index");
const { resolveClientIp, parseCidrList } = await import("../lib/net");
const { buildCoreHeaders } = await import("../lib/coreInternalClient");
const { env, resetEnvCache } = await import("../lib/env");
const express = (await import("express")).default;

/** Whether the request body had been fully read when the response headers were written. */
let bodyConsumedAtResponse: boolean | undefined;
const outer = express();
outer.use((req, res, next) => {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
  (res as unknown as { writeHead: unknown }).writeHead = (...args: unknown[]) => {
    bodyConsumedAtResponse ??= req.readableEnded;
    return writeHead(...args);
  };
  next();
});
outer.use(createApp());

let server: ReturnType<typeof outer.listen>;
let base = "";

beforeAll(async () => {
  // Other test files share this process and configure the environment too.
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.MAX_UPLOAD_BYTES = "20971520";
  resetEnvCache();
  server = outer.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
});

const LIVE_TOKEN = `pg_live_${"B".repeat(43)}`;

describe("external token format and limiter", () => {
  test("a bearer that is not shaped like an issued token is refused without loading core", async () => {
    const before = core.requests.length;
    for (const header of ["Bearer pg_live_totallymadeup", "Bearer pg_live_", "Bearer merchant-session", `Bearer ${LIVE_TOKEN} extra`]) {
      const response = await fetch(`${base}/api/v1/external/links/abcdef123456`, { headers: { authorization: header } });
      expect(response.status).toBe(401);
    }
    expect(core.requests.length).toBe(before);
  });

  test("a well formed token is forwarded unchanged", async () => {
    const response = await fetch(`${base}/api/v1/external/links/abcdef123456`, {
      headers: { authorization: `Bearer ${LIVE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.headers.authorization).toBe(`Bearer ${LIVE_TOKEN}`);
  });

  test("the limiter budget is per token and client, not per ip alone", async () => {
    process.env.EXTERNAL_RATE_LIMIT_MAX = "2";
    resetEnvCache();
    const call = (token: string, ip: string) =>
      fetch(`${base}/api/v1/external/links/abcdef123456`, {
        headers: { authorization: `Bearer pg_live_${token.repeat(43)}`, "x-real-client-ip": ip },
      }).then((response) => response.status);
    const first = [await call("C", "198.51.100.20"), await call("C", "198.51.100.20"), await call("C", "198.51.100.20")];
    const other = await call("D", "198.51.100.20");
    delete process.env.EXTERNAL_RATE_LIMIT_MAX;
    resetEnvCache();
    expect(first).toEqual([200, 200, 429]);
    expect(other).toBe(200);
  });
});

describe("access token creation policy", () => {
  const create = (body: unknown) =>
    fetch(`${base}/api/v1/merchant/tokens`, {
      method: "POST",
      headers: { authorization: "Bearer session", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const valid = {
    name: "integration token",
    scopes: ["links:read"],
    allowedCidrs: ["10.0.0.0/8"],
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };

  test("a sane request is forwarded to core", async () => {
    const response = await create(valid);
    expect(response.status).toBe(201);
    expect(core.requests.at(-1)?.url).toBe("/internal/merchant/tokens");
  });

  test("allow-everyone and malformed CIDRs are rejected before core", async () => {
    const before = core.requests.length;
    for (const allowedCidrs of [["0.0.0.0/0"], ["::/0"], ["1.0.0.0/4"], ["999.1.1.1/8"], ["not-a-cidr"], ["10.0.0.0/33"], ["10.0.0.0/8", "::/0"]]) {
      const response = await create({ ...valid, allowedCidrs });
      expect(response.status).toBe(400);
    }
    expect(core.requests.length).toBe(before);
  });

  test("single addresses and narrow ranges are accepted", async () => {
    expect((await create({ ...valid, allowedCidrs: ["203.0.113.7", "2001:db8::/48"] })).status).toBe(201);
  });

  test("wildcard, upper case, free-form, duplicate and too many scopes are rejected", async () => {
    const before = core.requests.length;
    const tooMany = Array.from({ length: 21 }, (_unused, index) => `links:action${String.fromCharCode(97 + (index % 26))}${index}`);
    for (const scopes of [["*"], ["*:*"], ["admin:*"], ["Links:Read"], ["no.such.scope"], ["links:read", "links:read"], tooMany]) {
      const response = await create({ ...valid, scopes });
      expect(response.status).toBe(400);
    }
    expect(core.requests.length).toBe(before);
  });

  test("a missing expiry defaults to the configured lifetime", async () => {
    const { expiresAt: _omitted, ...withoutExpiry } = valid;
    const response = await create(withoutExpiry);
    expect(response.status).toBe(201);
    const sent = JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}") as { expiresAt?: string };
    const days = (Date.parse(sent.expiresAt ?? "") - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(env.TOKEN_DEFAULT_TTL_DAYS);
  });

  test("an expiry in the past, beyond the maximum or malformed is rejected", async () => {
    const day = 86_400_000;
    for (const expiresAt of [
      new Date(Date.now() - day).toISOString(),
      new Date(Date.now() + (env.TOKEN_MAX_TTL_DAYS + 5) * day).toISOString(),
      "tomorrow",
      "2999",
    ]) {
      expect((await create({ ...valid, expiresAt })).status).toBe(400);
    }
  });

  test("the ip allow-list update applies the same CIDR rules", async () => {
    const send = (allowedCidrs: string[]) =>
      fetch(`${base}/api/v1/merchant/tokens/tok_1/ips`, {
        method: "PUT",
        headers: { authorization: "Bearer session", "content-type": "application/json" },
        body: JSON.stringify({ allowedCidrs }),
      });
    expect((await send(["0.0.0.0/0"])).status).toBe(400);
    expect((await send(["10.1.0.0/16"])).status).toBe(200);
  });
});

describe("onboarding and upload routes", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2_000_000, 1)]);
  const form = () => {
    const data = new FormData();
    data.append("documentType", "OTHER");
    data.append("document", new Blob([png], { type: "image/png" }), "x.png");
    return data;
  };

  const smallForm = () => {
    const data = new FormData();
    data.append("documentType", "OTHER");
    data.append("document", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" }), "x.png");
    return data;
  };

  test("an unauthenticated upload is rejected before the body is parsed", async () => {
    const before = core.requests.length;
    bodyConsumedAtResponse = undefined;
    const response = await fetch(`${base}/api/v1/merchant/onboarding/kyb-documents`, {
      method: "POST",
      headers: { "x-real-client-ip": "198.51.100.50" },
      body: form(),
    });
    expect(response.status).toBe(401);
    expect(bodyConsumedAtResponse as boolean | undefined).toBe(false);
    expect(core.requests.length).toBe(before);
  });

  test("an unauthenticated onboarding call never reaches core", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/merchant/onboarding/join-request`);
    expect(response.status).toBe(401);
    expect(core.requests.length).toBe(before);
  });

  test("an upload declaring more than the limit is refused without buffering", async () => {
    process.env.MAX_UPLOAD_BYTES = "1024";
    resetEnvCache();
    bodyConsumedAtResponse = undefined;
    const response = await fetch(`${base}/api/v1/merchant/onboarding/kyb-documents`, {
      method: "POST",
      headers: { authorization: "Bearer session", "x-real-client-ip": "198.51.100.51" },
      body: form(),
    });
    process.env.MAX_UPLOAD_BYTES = "20971520";
    resetEnvCache();
    expect(response.status).toBe(413);
    expect(bodyConsumedAtResponse as boolean | undefined).toBe(false);
  });

  test("an authenticated upload with a wrong signature is refused, a valid one is forwarded", async () => {
    const fake = new FormData();
    fake.append("documentType", "OTHER");
    fake.append("document", new Blob([Buffer.alloc(64, 0x41)], { type: "image/png" }), "x.png");
    const bad = await fetch(`${base}/api/v1/merchant/onboarding/kyb-documents`, {
      method: "POST",
      headers: { authorization: "Bearer session", "x-real-client-ip": "198.51.100.52" },
      body: fake,
    });
    expect(bad.status).toBe(415);
    const good = await fetch(`${base}/api/v1/merchant/onboarding/kyb-documents`, {
      method: "POST",
      headers: { authorization: "Bearer session", "x-real-client-ip": "198.51.100.52" },
      body: smallForm(),
    });
    expect(good.status).toBeLessThan(300);
  });

  test("uploads are limited per client ip", async () => {
    process.env.UPLOAD_RATE_LIMIT_MAX = "2";
    resetEnvCache();
    const small = () => {
      const data = new FormData();
      data.append("documentType", "OTHER");
      data.append("document", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" }), "x.png");
      return data;
    };
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${base}/api/v1/merchant/onboarding/kyb-documents`, {
        method: "POST",
        headers: { authorization: "Bearer session", "x-real-client-ip": "198.51.100.30" },
        body: small(),
      });
      statuses.push(response.status);
    }
    delete process.env.UPLOAD_RATE_LIMIT_MAX;
    resetEnvCache();
    expect(statuses.at(-1)).toBe(429);
    expect(statuses[0]).toBeLessThan(300);
  });

  test("a website must be an http(s) address", async () => {
    const put = (website: string) =>
      fetch(`${base}/api/v1/merchant/onboarding/join-request`, {
        method: "PUT",
        headers: { authorization: "Bearer session", "content-type": "application/json" },
        body: JSON.stringify({ website }),
      }).then((response) => response.status);
    expect(await put("javascript:alert(1)")).toBe(400);
    expect(await put("data:text/html,<script>1</script>")).toBe(400);
    expect(await put("ftp://example.com")).toBe(400);
    expect(await put("https://example.com")).toBeLessThan(300);
  });
});

describe("cash-out idempotency", () => {
  const payload = { walletId: "wal_1", amount: "10.0000", currency: "LYD", bankAccountId: "bank_1" };
  const send = (headers: Record<string, string>, body: Record<string, unknown>) =>
    fetch(`${base}/api/v1/merchant/cashouts`, {
      method: "POST",
      headers: { authorization: "Bearer session", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  test("the body idempotencyKey is forwarded to core", async () => {
    const response = await send({}, { ...payload, idempotencyKey: "cashout-key-0001" });
    expect(response.status).toBe(201);
    const sent = JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect(sent.idempotencyKey).toBe("cashout-key-0001");
  });

  test("the Idempotency-Key header is accepted and forwarded to core", async () => {
    const response = await send({ "idempotency-key": "cashout-header-0002" }, payload);
    expect(response.status).toBe(201);
    const sent = JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect(sent.idempotencyKey).toBe("cashout-header-0002");
  });

  test("a malformed key is rejected before core", async () => {
    const before = core.requests.length;
    const response = await send({ "idempotency-key": "short" }, payload);
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });
});

describe("client ip resolution and core headers", () => {
  const cidrs = () => parseCidrList(env.TRUSTED_PROXY_CIDRS);

  test("the default trusted proxies are loopback only", () => {
    expect(env.TRUSTED_PROXY_CIDRS).toBe("127.0.0.0/8,::1/128");
  });

  test("forwarded headers from private network peers are ignored", () => {
    expect(
      resolveClientIp({ socket: { remoteAddress: "10.1.2.3" }, headers: { "x-real-ip": "1.2.3.4" } } as never, cidrs()),
    ).toBe("10.1.2.3");
    expect(
      resolveClientIp({ socket: { remoteAddress: "192.168.5.5" }, headers: { "x-real-client-ip": "9.9.9.9" } } as never, cidrs()),
    ).toBe("192.168.5.5");
    expect(
      resolveClientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": "garbage" } } as never, cidrs()),
    ).toBe("127.0.0.1");
  });

  test("edge owned headers cannot be overridden and control characters are refused", () => {
    const headers = buildCoreHeaders({
      method: "GET",
      path: "/internal/merchant/x",
      requestId: "r",
      clientIp: "10.9.9.9",
      authorization: "Bearer real",
      headers: { "x-edge-service": "core-back", "X-Real-Client-IP": "1.1.1.1", Authorization: "Bearer evil" },
    });
    expect(headers["x-edge-service"]).toBe("merchant-back");
    expect(headers["x-real-client-ip"]).toBe("10.9.9.9");
    expect(headers.authorization).toBe("Bearer real");
    expect(() =>
      buildCoreHeaders({
        method: "GET",
        path: "/internal/merchant/x",
        requestId: "r",
        clientIp: "10.9.9.9",
        headers: { "x-test": "a\u0001b" },
      }),
    ).toThrow();
  });
});

describe("authentication limiter", () => {
  test("login attempts are limited per account even when the client ip changes", async () => {
    process.env.AUTH_RATE_LIMIT_MAX = "2";
    resetEnvCache();
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${base}/api/v1/merchant/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-client-ip": `198.51.100.${40 + index}` },
        body: JSON.stringify({ identifier: "Victim@Example.com", password: "wrong-password-1" }),
      });
      statuses.push(response.status);
    }
    delete process.env.AUTH_RATE_LIMIT_MAX;
    resetEnvCache();
    expect(statuses.slice(0, 2).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("response headers and cross origin access", () => {
  test("security headers are set and no CORS header is emitted by default", async () => {
    const response = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("only origins on CORS_ALLOWED_ORIGINS are allowed", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://portal.example.com";
    resetEnvCache();
    const allowed = await fetch(`${base}/health`, { headers: { origin: "https://portal.example.com" } });
    const other = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    delete process.env.CORS_ALLOWED_ORIGINS;
    resetEnvCache();
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://portal.example.com");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
