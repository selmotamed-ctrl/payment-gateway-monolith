import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { analyzeCron, backupPolicySchema } from "../api/protected/backups";
import { extractAuthorityHints, requireAuthorities } from "../api/middleware/authorityGuard";
import { buildCoreHeaders, callCoreRaw, CORE_SERVICE_NAME, resetCoreAgent } from "../lib/coreInternalClient";
import { resetEnvCache } from "../lib/env";
import { createTestPki, startTestCore } from "./helpers/core";
import { fullStaffToken, operatorToken, signSession } from "./helpers/session";
import { respondJson, startUpstream } from "./helpers/upstream";

const pki = createTestPki(CORE_SERVICE_NAME);
const core = await startTestCore(pki);

const b64 = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const SIGNATURE = "A".repeat(43);
const forge = (
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "none", typ: "JWT" },
  signature = "",
) => `${b64(header)}.${b64(payload)}.${signature}`;
const basePayload = { typ: "session", iss: "payment-gateway-core", aud: "payment-gateway-admin", sub: "attacker" };
const nowSeconds = () => Math.floor(Date.now() / 1000);

const runGuard = (guard: ReturnType<typeof requireAuthorities>, authorization?: string) => {
  let nextCalled = false;
  let error: unknown;
  try {
    guard({ headers: authorization ? { authorization } : {} } as never, {} as never, () => {
      nextCalled = true;
    });
  } catch (caught) {
    error = caught;
  }
  return { nextCalled, error: error as { statusCode?: number; code?: string } | undefined };
};

const setEnv = () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  delete process.env.CORE_BACK_URLS;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.CORE_REQUEST_TIMEOUT_MS = "5000";
  resetEnvCache();
  resetCoreAgent();
};
setEnv();

const { createApp } = await import("../index");
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
  resetCoreAgent();
});

describe("authority guard fails closed on credentials it cannot trust", () => {
  const guard = requireAuthorities("security:write");

  test("an unsigned alg=none token with an expired exp is denied", () => {
    const token = forge({ ...basePayload, exp: 1, authorities: ["security:write"] });
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
  });

  test("a garbage signature with an expired exp and the wildcard authority is denied", () => {
    const token = forge({ ...basePayload, exp: 1, authorities: ["*"] }, { alg: "HS256", typ: "JWT" }, "garbage");
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
  });

  test("a token without an exp claim is denied (core always sets one)", () => {
    const header = b64({ alg: "HS256", typ: "JWT" });
    const payload = b64({ ...basePayload, authorities: ["security:write"] });
    const signature = createHmac("sha256", "attacker").update(`${header}.${payload}`).digest("base64url");
    expect(runGuard(guard, `Bearer ${header}.${payload}.${signature}`).nextCalled).toBe(false);
  });

  test("an alg=none token is denied even when it looks otherwise valid", () => {
    const token = forge({ ...basePayload, exp: nowSeconds() + 600, authorities: ["security:write"] });
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
  });

  test("a token that is not valid yet (nbf in the future) is denied", () => {
    const token = forge(
      { ...basePayload, exp: nowSeconds() + 600, nbf: nowSeconds() + 3600, authorities: ["security:write"] },
      { alg: "HS256", typ: "JWT" },
      SIGNATURE,
    );
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
  });

  test("a well formed live session carrying the authority is let through to core", () => {
    const token = forge(
      { ...basePayload, exp: nowSeconds() + 600, authorities: ["security:write"] },
      { alg: "HS256", typ: "JWT" },
      SIGNATURE,
    );
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(true);
  });

  test("authorities are compared case-sensitively", () => {
    const token = forge(
      { ...basePayload, exp: nowSeconds() + 600, authorities: ["SECURITY:WRITE"] },
      { alg: "HS256", typ: "JWT" },
      SIGNATURE,
    );
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
  });

  test("a token without authorities is denied", () => {
    const token = forge(
      { ...basePayload, exp: nowSeconds() + 600, authorities: [] },
      { alg: "HS256", typ: "JWT" },
      SIGNATURE,
    );
    expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
  });

  test("an authority list that lacks the required authority restricts instead of disabling the guard", () => {
    const token = forge(
      { ...basePayload, exp: nowSeconds() + 600, authorities: [] },
      { alg: "HS256", typ: "JWT" },
      SIGNATURE,
    );
    for (const hints of ["aml:read", "SECURITY:WRITE", ""]) {
      process.env.ADMIN_AUTHORITY_HINTS = hints;
      resetEnvCache();
      expect(runGuard(guard, `Bearer ${token}`).nextCalled).toBe(false);
    }
    delete process.env.ADMIN_AUTHORITY_HINTS;
    resetEnvCache();
  });

  test("a configured authority list that omits the guard's authorities denies even a valid holder", () => {
    process.env.ADMIN_AUTHORITY_HINTS = "aml:read";
    resetEnvCache();
    const token = signSession({ sub: "u", role: "SECURITY_ADMIN", authorities: ["security:write"] });
    const result = runGuard(guard, `Bearer ${token}`);
    delete process.env.ADMIN_AUTHORITY_HINTS;
    resetEnvCache();
    expect(result.nextCalled).toBe(false);
    expect(result.error?.statusCode).toBe(403);
  });

  test("extractAuthorityHints rejects expired and malformed sessions and accepts a live one", () => {
    const live = signSession({ sub: "u", role: "OPERATOR", authorities: ["merchant:read"] });
    expect(extractAuthorityHints(`Bearer ${live}`)?.authorities).toEqual(["merchant:read"]);
    const expired = signSession(
      { sub: "u", role: "OPERATOR", authorities: ["merchant:read"] },
      { issuedAt: nowSeconds() - 13 * 60 * 60 },
    );
    expect(extractAuthorityHints(`Bearer ${expired}`)).toBeNull();
    expect(extractAuthorityHints("Bearer a.b")).toBeNull();
    expect(extractAuthorityHints(`Bearer ${live} extra`)).toBeNull();
  });
});

describe("edge authority requirements on the administrative routes", () => {
  const send = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${base}/api/v1/admin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const limited = signSession({ sub: "u-limited", role: "SUPPORT", authorities: ["merchant:read"] });

  test("a bearer that is not a live core session never reaches core", async () => {
    setEnv();
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/admin/merchants`, { headers: { authorization: "Bearer x" } });
    expect(response.status).toBe(401);
    expect(core.requests.length).toBe(before);
  });

  const denied: Array<[string, string, unknown?]> = [
    ["GET", "/users"],
    ["POST", "/users", { email: "a@example.com", fullName: "A", role: "FINANCE" }],
    ["GET", "/settings"],
    ["POST", "/settings/restore-apply", { confirm: true, reason: "restore", backup: { settings: [] } }],
    ["POST", "/cashouts/co_1/process", { decision: "APPROVE" }],
    ["POST", "/adjustments", { merchantId: "m" }],
    ["POST", "/merchants/mch_1/suspend", { reason: "fraud" }],
    ["POST", "/merchants/mch_1/close", { reason: "fraud" }],
    ["POST", "/gateways", { name: "g" }],
    ["PUT", "/rails/rail_1/fields", { fields: [] }],
    ["GET", "/kyb-documents/summary"],
    ["GET", "/audit-logs"],
    ["POST", "/system/backups/trigger", { target: "all", kind: "full" }],
  ];
  for (const [method, path, body] of denied) {
    test(`${method} ${path} is refused at the edge for a session without the authority`, async () => {
      setEnv();
      const before = core.requests.length;
      const response = await send(method, path, limited, body);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("EDGE_AUTHORITY_DENIED");
      expect(core.requests.length).toBe(before);
    });
  }

  test("a session with the matching authority is forwarded to core", async () => {
    setEnv();
    const before = core.requests.length;
    const response = await send("GET", "/users", fullStaffToken());
    expect(response.status).toBe(200);
    expect(core.requests.length).toBeGreaterThan(before);
  });

  test("restore-preview needs only the read authority while restore-apply needs the write authority", async () => {
    setEnv();
    const reader = signSession({ sub: "u-reader", role: "OPERATOR", authorities: ["settings:read"] });
    const preview = await send("POST", "/settings/restore-preview", reader, {
      backup: { settings: [{ key: "checkout.support_config", valueJson: {} }] },
    });
    expect(preview.status).toBe(200);
    const apply = await send("POST", "/settings/restore-apply", reader, {
      confirm: true,
      reason: "restore approved backup",
      backup: { settings: [] },
    });
    expect(apply.status).toBe(403);
  });
});

describe("core client circuit breaker and headers", () => {
  test("a poisoned header is rejected locally and does not take a healthy node out of rotation", async () => {
    const upstream = await startUpstream(pki, (_request, response) => respondJson(response, 200, { ok: true }));
    process.env.NODE_ENV = "test";
    process.env.CORE_BACK_URL = upstream.url;
    process.env.CORE_BACK_URLS = upstream.url;
    process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
    process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
    process.env.MTLS_CA_CERT_PATH = pki.caCert;
    resetEnvCache();
    resetCoreAgent();
    const common = { path: "/internal/admin/x", requestId: "r", clientIp: "10.0.0.1" };
    const poisoned = await callCoreRaw({
      ...common,
      method: "POST",
      body: {},
      headers: { "x-upload-content-type": "a\u0001b" },
    }).catch((error: unknown) => error as { statusCode?: number; code?: string });
    expect((poisoned as { statusCode?: number }).statusCode).toBe(400);
    expect((poisoned as { code?: string }).code).toBe("CORE_HEADER_INVALID");
    expect(upstream.requests.length).toBe(0);
    const next = await callCoreRaw({ ...common, method: "GET" });
    expect(next.statusCode).toBe(200);
    expect(upstream.requests.length).toBe(1);
    await upstream.close();
    setEnv();
  });

  test("an aborted request does not mark the node unhealthy", async () => {
    const upstream = await startUpstream(pki, (_request, response) => respondJson(response, 200, { ok: true }));
    process.env.CORE_BACK_URL = upstream.url;
    process.env.CORE_BACK_URLS = upstream.url;
    resetEnvCache();
    resetCoreAgent();
    const controller = new AbortController();
    controller.abort();
    const common = { path: "/internal/admin/x", requestId: "r", clientIp: "10.0.0.1" };
    const aborted = await callCoreRaw({ ...common, method: "GET", signal: controller.signal }).catch(
      (error: unknown) => error as { code?: string },
    );
    expect((aborted as { code?: string }).code).toBe("CLIENT_CLOSED_REQUEST");
    const next = await callCoreRaw({ ...common, method: "GET" });
    expect(next.statusCode).toBe(200);
    await upstream.close();
    setEnv();
  });

  test("edge owned headers cannot be overridden by the caller", () => {
    const headers = buildCoreHeaders({
      method: "POST",
      path: "/internal/admin/x",
      requestId: "r",
      clientIp: "10.9.9.9",
      authorization: "Bearer real",
      body: {},
      headers: {
        "X-Edge-Service": "core-back",
        "x-real-client-ip": "1.1.1.1",
        Authorization: "Bearer evil",
        "Content-Type": "text/plain",
        "x-request-id": "evil",
      },
    });
    expect(headers["x-edge-service"]).toBe(CORE_SERVICE_NAME);
    expect(headers["x-real-client-ip"]).toBe("10.9.9.9");
    expect(headers.authorization).toBe("Bearer real");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-request-id"]).toBe("r");
  });

  test("a caller supplied authorization is dropped when the edge sets none", () => {
    const headers = buildCoreHeaders({
      method: "GET",
      path: "/internal/admin/x",
      requestId: "r",
      clientIp: "10.9.9.9",
      headers: { Authorization: "Bearer evil" },
    });
    expect(headers.authorization).toBeUndefined();
  });

  test("a malformed x-pg-min-lsn is rejected before core is contacted", async () => {
    setEnv();
    const before = core.requests.length;
    const response = await fetch(`${base}/api/v1/admin/merchants`, {
      headers: { authorization: `Bearer ${operatorToken()}`, "x-pg-min-lsn": "0/16B6C50; evil" },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
    const valid = await fetch(`${base}/api/v1/admin/merchants`, {
      headers: { authorization: `Bearer ${operatorToken()}`, "x-pg-min-lsn": "0/16B6C50" },
    });
    expect(valid.status).toBe(200);
  });
});

describe("backup policy", () => {
  const valid = {
    fullCron: "0 2 * * 0",
    deltaCron: "*/15 * * * *",
    drillCron: "0 3 * * 0",
    fullRetentionDays: 56,
    walRetentionDays: 14,
    alertLagSeconds: 300,
  };

  test("a sane policy is accepted", () => {
    expect(backupPolicySchema.safeParse(valid).success).toBe(true);
  });

  test("an every-minute schedule and a zero alert lag are rejected", () => {
    const result = backupPolicySchema.safeParse({
      fullCron: "* * * * *",
      deltaCron: "* * * * *",
      drillCron: "* * * * *",
      fullRetentionDays: 1,
      walRetentionDays: 1,
      alertLagSeconds: 0,
    });
    expect(result.success).toBe(false);
  });

  test("a low-retention policy can be proposed for maker-checker review", () => {
    const low = { ...valid, fullRetentionDays: 2, walRetentionDays: 1 };
    expect(backupPolicySchema.safeParse(low).success).toBe(true);
    expect(backupPolicySchema.safeParse({ ...low, approvalRequestId: "apr_1" }).success).toBe(true);
  });

  test("cron expressions are validated strictly", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "a b c d e", "*/0 * * * *", "5-1 * * * *", "@daily"]) {
      expect(analyzeCron(bad)).toBeNull();
    }
    expect(analyzeCron("0 2 * * 0")?.minGapMinutes).toBe(1440);
    expect(analyzeCron("*/5 * * * *")?.minGapMinutes).toBe(5);
    expect(analyzeCron("0 */6 * * *")?.minGapMinutes).toBe(360);
  });

  const backupCall = (path: string, body: unknown, idempotencyKey?: string) =>
    fetch(`${base}/api/v1/admin/system/backups/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fullStaffToken()}`,
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    });

  test("trigger and drill relay an Idempotency-Key when supplied", async () => {
    setEnv();
    process.env.BACKUP_JOB_RATE_LIMIT_MAX = "1000";
    for (const [path, body] of [
      ["trigger", { target: "all", kind: "full" }],
      ["drill", {}],
    ] as const) {
      const accepted = await backupCall(path, body);
      expect(accepted.status).toBeLessThan(300);
      const keyed = await backupCall(path, body, "idem-key-0001");
      expect(keyed.status).toBeLessThan(300);
      expect(core.requests.at(-1)?.headers["idempotency-key"]).toBe("idem-key-0001");
    }
  });
});

describe("client ip based rate limiting", () => {
  test("clients behind a trusted proxy get their own bucket, a single client is still limited", async () => {
    setEnv();
    process.env.ADMIN_RATE_LIMIT_MAX = "3";
    resetEnvCache();
    const statuses: number[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const response = await fetch(`${base}/api/v1/admin/merchants`, {
        headers: {
          authorization: "Bearer x",
          "x-forwarded-for": `203.0.113.${index}`,
          "x-real-client-ip": `10.7.0.${index}`,
        },
      });
      statuses.push(response.status);
    }
    expect(statuses.every((status) => status !== 429)).toBe(true);
    const single: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${base}/api/v1/admin/merchants`, {
        headers: { authorization: "Bearer x", "x-real-client-ip": "10.8.0.1", "x-forwarded-for": `198.51.100.${index}` },
      });
      single.push(response.status);
    }
    // back to the suite-wide test budget set by test/setup.ts (not the 600/min default)
    process.env.ADMIN_RATE_LIMIT_MAX = "1000000";
    resetEnvCache();
    expect(single.slice(0, 3).every((status) => status !== 429)).toBe(true);
    expect(single.at(-1)).toBe(429);
  });
});

describe("response headers and cross origin access", () => {
  test("responses carry the basic security headers and no CORS headers by default", async () => {
    setEnv();
    const response = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an origin on CORS_ALLOWED_ORIGINS is allowed and any other origin is not", async () => {
    setEnv();
    process.env.CORS_ALLOWED_ORIGINS = "https://admin.example.com";
    resetEnvCache();
    const allowed = await fetch(`${base}/health`, { headers: { origin: "https://admin.example.com" } });
    const other = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    delete process.env.CORS_ALLOWED_ORIGINS;
    resetEnvCache();
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://admin.example.com");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("core client retry and size policy", () => {
  const configure = (urls: string[]) => {
    process.env.CORE_BACK_URL = urls[0] ?? "";
    process.env.CORE_BACK_URLS = urls.join(",");
    resetEnvCache();
    resetCoreAgent();
  };
  const common = { path: "/internal/admin/x", requestId: "r", clientIp: "10.0.0.1" };

  test("a PUT that reached core is never replayed on another node (core PUTs version on every call)", async () => {
    const failing = await startUpstream(pki, (_request, response) => respondJson(response, 503, { code: "DOWN" }));
    const healthy = await startUpstream(pki, (_request, response) => respondJson(response, 200, { ok: true }));
    configure([failing.url, healthy.url]);
    const first = await callCoreRaw({ ...common, method: "PUT", body: {} });
    expect(first.statusCode).toBe(503);
    expect(failing.requests.length).toBe(1);
    expect(healthy.requests.length).toBe(0);
    // Rebuild the pool so the round-robin cursor starts at the failing node again.
    configure([failing.url, healthy.url]);
    const deleted = await callCoreRaw({ ...common, method: "DELETE" });
    expect(deleted.statusCode).toBe(503);
    expect(failing.requests.length).toBe(2);
    expect(healthy.requests.length).toBe(0);
    await failing.close();
    await healthy.close();
    setEnv();
  });

  test("the same PUT with an idempotency key fails over, and a GET always does", async () => {
    const failing = await startUpstream(pki, (_request, response) => respondJson(response, 503, { code: "DOWN" }));
    const healthy = await startUpstream(pki, (_request, response) => respondJson(response, 200, { ok: true }));
    configure([failing.url, healthy.url]);
    const keyed = await callCoreRaw({ ...common, method: "PUT", body: {}, headers: { "Idempotency-Key": "idem-key-0001" } });
    expect(keyed.statusCode).toBe(200);
    expect(healthy.requests.length).toBe(1);
    await failing.close();
    await healthy.close();
    setEnv();
  });

  test("a buffered core response above CORE_MAX_RESPONSE_BYTES is refused", async () => {
    const big = await startUpstream(pki, (_request, response) => respondJson(response, 200, { data: "x".repeat(5000) }));
    configure([big.url]);
    process.env.CORE_MAX_RESPONSE_BYTES = "1024";
    resetEnvCache();
    const error = await callCoreRaw({ ...common, method: "GET" }).catch((caught: unknown) => caught as { code?: string });
    delete process.env.CORE_MAX_RESPONSE_BYTES;
    resetEnvCache();
    expect((error as { code?: string }).code).toBe("CORE_RESPONSE_TOO_LARGE");
    await big.close();
    setEnv();
  });
});
