import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Request } from "express";
import { resolveLanClientIp } from "../api/middleware/lanGuard";
import { CORE_SCHEMAS } from "./helpers/core-schema";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { amlAuthorityToken, complianceToken, mlroToken, operatorToken, signSession } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back");
const core: TestCore = await startTestCore(pki);


const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const operator = operatorToken();
const compliance = complianceToken();
const mlro = mlroToken();

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";
});
beforeAll(async () => {
  const app = createApp();
  edgeServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  const address = edgeServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  edgeUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});

const call = (
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    ip?: string;
    realIp?: string;
  } = {},
) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.ip) headers["x-real-client-ip"] = options.ip;
  if (options.realIp) headers["x-real-ip"] = options.realIp;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${edgeUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

const forwardedBody = (): Record<string, unknown> => {
  const raw = core.requests.at(-1)?.body.toString("utf8") ?? "";
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

describe("admin lan restriction", () => {
  test("rejects a client outside the lan allowlist", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operator,
      ip: "203.0.113.9",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("ADMIN_LAN_ONLY");
  });

  test("accepts a client inside the lan allowlist", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operator,
      ip: "10.20.30.40",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/merchants");
  });

  test("accepts a loopback client without a forwarded header", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", { token: operator });
    expect(response.status).toBe(200);
  });

  test("never reaches core when the lan guard rejects the call", async () => {
    const before = core.requests.length;
    await call("GET", "/api/v1/admin/merchants", { token: operator, ip: "198.51.100.7" });
    expect(core.requests.length).toBe(before);
  });

  test("honours the x-real-ip header sent by the shipped nginx proxy", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operator,
      realIp: "10.20.30.41",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/merchants");
  });

  test("rejects an x-real-ip client outside the lan allowlist", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operator,
      realIp: "203.0.113.11",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("ADMIN_LAN_ONLY");
  });

  test("ignores a forwarded header that arrives from an untrusted peer", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operator,
      realIp: "10.20.30.42",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.headers["x-real-client-ip"]).toBe("10.20.30.42");
  });

  test("prefers the proxy supplied x-real-ip over the caller supplied header", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/admin/merchants`, {
      headers: {
        authorization: `Bearer ${operator}`,
        "x-real-ip": "10.20.30.43",
        "x-real-client-ip": "203.0.113.77",
      },
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.headers["x-real-client-ip"]).toBe("10.20.30.43");
  });

  test("only trusts forwarded headers from a loopback or trusted proxy peer", () => {
    const proxyRequest = (headers: Record<string, string>, remoteAddress: string) =>
      ({ headers, socket: { remoteAddress } }) as unknown as Request;
    expect(
      resolveLanClientIp(proxyRequest({ "x-real-ip": "10.20.30.42" }, "127.0.0.1")),
    ).toBe("10.20.30.42");
    expect(
      resolveLanClientIp(proxyRequest({ "x-real-client-ip": "10.20.30.43" }, "::1")),
    ).toBe("10.20.30.43");
    expect(
      resolveLanClientIp(proxyRequest({ "x-real-ip": "10.20.30.42" }, "203.0.113.5")),
    ).toBe("203.0.113.5");
    expect(resolveLanClientIp(proxyRequest({}, "127.0.0.1"))).toBe("127.0.0.1");
  });
});

describe("admin authority hints", () => {
  test("denies an aml route without the confidential authority", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: operator });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("EDGE_AUTHORITY_DENIED");
  });

  test("allows an aml route for a compliance officer", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: compliance });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/aml/screenings");
  });

  test("allows an aml route for an mlro officer", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: mlro });
    expect(response.status).toBe(200);
  });

  test("allows an aml route for a session that only carries the aml authority", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", {
      token: amlAuthorityToken(),
    });
    expect(response.status).toBe(200);
  });

  test("denies an aml route when the credential cannot be read as a session", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: "opaque-session" });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("EDGE_AUTHORITY_DENIED");
  });

  test("denies an aml route for an mfa challenge token", async () => {
    const challenge = signSession({ sub: "u-compliance", role: "COMPLIANCE", typ: "mfa" });
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: challenge });
    expect(response.status).toBe(403);
  });

  test("leaves non jwt credentials on ordinary routes to the authoritative core", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", { token: "opaque-session" });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/merchants");
  });

  test("requires a bearer token on protected admin routes", async () => {
    const response = await call("GET", "/api/v1/admin/merchants");
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AUTH_REQUIRED");
  });
});

describe("admin asynchronous routes", () => {
  test("the dispute intake relays the accepted status of core", async () => {
    const response = await call("POST", "/api/v1/admin/disputes", {
      token: operator,
      body: {
        merchantId: "mch_1",
        gatewayId: "gw_1",
        railId: "rail_1",
        paymentReference: "PA-1",
        externalDisputeRef: "EXT-1",
        type: "CHARGEBACK",
        amount: "10.0000",
        currency: "LYD",
        reason: "duplicate capture",
        source: "WEBHOOK",
      },
    });
    expect(response.status).toBe(202);
    const payload = (await response.json()) as { jobId?: string };
    expect(payload.jobId).toBe("job-1");
  });

  test("an approval relays the accepted status of core", async () => {
    const response = await call("POST", "/api/v1/admin/approvals/apr_1/approve", {
      token: operator,
      body: { reason: "reviewed and approved" },
    });
    expect(response.status).toBe(202);
  });

  test("an approval forwards the dispute outcome and the risk acceptance to core", async () => {
    const response = await call("POST", "/api/v1/admin/approvals/apr_1/approve", {
      token: operator,
      body: {
        reason: "chargeback evidence reviewed",
        outcome: "WON",
        riskAcceptanceNote: "the evidence is conclusive",
      },
    });
    expect(response.status).toBe(202);
    expect(forwardedBody()).toMatchObject({
      notes: "chargeback evidence reviewed",
      outcome: "WON",
      riskAcceptanceNote: "the evidence is conclusive",
    });
  });

  test("a bulk user role change relays the accepted status of core", async () => {
    const response = await call("PATCH", "/api/v1/admin/users", {
      token: operator,
      body: { userIds: ["usr_1", "usr_2"], role: "SUPPORT" },
    });
    expect(response.status).toBe(202);
    const recent = core.requests.slice(-2);
    expect(recent.map((request) => request.url)).toEqual([
      "/internal/admin/users",
      "/internal/admin/users",
    ]);
  });

  test("a single user role change relays the accepted status of core", async () => {
    const response = await call("PATCH", "/api/v1/admin/users/usr_1", {
      token: operator,
      body: { role: "SUPPORT" },
    });
    expect(response.status).toBe(202);
    expect(forwardedBody()).toEqual({ role: "SUPPORT" });
  });

  test("a join request approval relays the accepted status of core", async () => {
    const response = await call("POST", "/api/v1/admin/join-requests/jr_1/decide", {
      token: compliance,
      body: { decision: "APPROVE", reason: "kyb complete" },
    });
    expect(response.status).toBe(202);
    expect(forwardedBody()).toMatchObject({ decision: "APPROVED" });
  });

  test("a merchant edit proposal relays the accepted status of core", async () => {
    const response = await call("POST", "/api/v1/admin/merchants/mch_1/propose-edit", {
      token: operator,
      body: {
        reason: "typo",
        patch: [{ op: "replace", path: "/name", value: "Acme Ltd" }],
        baseVersion: 1,
      },
    });
    expect(response.status).toBe(202);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/merchants/mch_1/propose-edit");
  });

  test("an aml case proposal relays the accepted status of core", async () => {
    const response = await call("POST", "/api/v1/admin/aml/cases/c_1/propose", {
      token: compliance,
      body: { severity: "HIGH", action: "AML_HOLD", reason: "structuring" },
    });
    expect(response.status).toBe(202);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/aml/cases/c_1/propose");
  });

  test("a gateway version approval relays the accepted status of core", async () => {
    const response = await call("POST", "/api/v1/admin/gateway-versions/gv_1/submit-approval", {
      token: operator,
      body: { reason: "ready for approval" },
    });
    expect(response.status).toBe(202);
    expect(core.requests.at(-1)?.url).toBe(
      "/internal/admin/gateway-versions/gv_1/submit-approval",
    );
  });
});

describe("admin statement upload", () => {
  test("forwards a validated csv statement to core", async () => {
    const form = new FormData();
    form.set("sourceId", "src_1");
    form.set("periodStart", "2026-01-01");
    form.set("periodEnd", "2026-01-31");
    form.set("statement", new Blob([new Uint8Array(Buffer.from("txn_ref,amount\nREF-1,10.0000\n"))], { type: "text/csv" }), "statement.csv");
    const response = await fetch(`${edgeUrl}/api/v1/admin/reconciliation/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${compliance}` },
      body: form,
    });
    expect(response.status).toBe(202);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/admin/reconciliation/upload");
    expect(forwarded?.headers["x-upload-content-type"]).toBe("text/csv");
    expect(forwarded?.headers["x-statement-source-id"]).toBe("src_1");
    // The statement file is forwarded as raw bytes so that `core-back` can
    // hash and parse the exact uploaded payload. The metadata travels in the
    // `x-upload-metadata` header.
    expect(forwarded?.headers["content-type"]).toBe("application/octet-stream");
    expect(forwarded?.body.toString("utf8")).toBe("txn_ref,amount\nREF-1,10.0000\n");
    const metadata = JSON.parse(
      Buffer.from(String(forwarded?.headers["x-upload-metadata"] ?? ""), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(metadata.sourceId).toBe("src_1");
    expect(metadata.periodStart).toBe("2026-01-01");
    expect(metadata.periodEnd).toBe("2026-01-31");
  });

  test("rejects a statement whose content does not match the declared type", async () => {
    const form = new FormData();
    form.set("sourceId", "src_1");
    form.set("periodStart", "2026-01-01");
    form.set("periodEnd", "2026-01-31");
    form.set("statement", new Blob([new Uint8Array(Buffer.from([0x00, 0x01, 0x02, 0x03]))], { type: "text/csv" }), "bad.csv");
    const response = await fetch(`${edgeUrl}/api/v1/admin/reconciliation/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${compliance}` },
      body: form,
    });
    expect(response.status).toBe(415);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });
});

describe("smart AI onboarding routes", () => {
  test("forwards the transcript request with the rail kind", async () => {
    const response = await call("GET", "/api/v1/admin/gateways/ai-transcript?railKind=OTP_PULL", {
      token: operator,
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/admin/gateways/ai-transcript?railKind=OTP_PULL");
  });

  test("forwards the spec verification request verbatim", async () => {
    const spec = { spec_version: "1.0", gateway: { code: "acme" } };
    const response = await call("POST", "/api/v1/admin/gateways/spec-verify", {
      token: operator,
      body: { spec },
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/admin/gateways/spec-verify");
    expect(JSON.parse(forwarded?.body.toString("utf8") ?? "{}")).toEqual({ spec });
  });

  test("forwards the spec import request and answers 201", async () => {
    const spec = { spec_version: "1.0" };
    const response = await call("POST", "/api/v1/admin/gateways/spec-import", {
      token: operator,
      body: {
        spec,
        credentialsValues: { MID: "m", MerchantSecretKey: "s" },
        mode: "NEW_VERSION",
      },
    });
    expect(response.status).toBe(201);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/admin/gateways/spec-import");
    expect(JSON.parse(forwarded?.body.toString("utf8") ?? "{}")).toEqual({
      spec,
      credentialsValues: { MID: "m", MerchantSecretKey: "s" },
      mode: "NEW_VERSION",
    });
  });

  test("rejects an unknown rail kind before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("GET", "/api/v1/admin/gateways/ai-transcript?railKind=UNKNOWN", {
      token: operator,
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });
});

describe("portal guide routes", () => {
  test("forwards the checkout support config read", async () => {
    const response = await call("GET", "/api/v1/admin/settings/checkout-support", { token: operator });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/settings/checkout-support");
  });

  test("forwards the checkout support config write as { value }", async () => {
    const value = {
      enabled: true,
      show_platform_contact: true,
      show_merchant_contact: false,
      support_phone: "+218910000000",
      support_whatsapp: "+218910000000",
      support_email: "support@example.ly",
      working_hours_en: "Sat - Thu: 09:00 - 18:00",
      faq_items: [{ q_ar: "س", a_ar: "ج", q_en: "Q", a_en: "A" }],
    };
    const response = await call("PUT", "/api/v1/admin/settings/checkout-support", {
      token: operator,
      body: value,
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/admin/settings/checkout-support");
    expect(JSON.parse(forwarded?.body.toString("utf8") ?? "{}")).toEqual({ value });
  });

  test("forwards the academy progress read, write and overview", async () => {
    const read = await call("GET", "/api/v1/admin/academy/progress", { token: operator });
    expect(read.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/progress");

    const progress = {
      progress: {
        completedModules: ["m1"],
        quizScores: { m1: 100 },
        completedLabs: ["lab-1"],
        badges: ["CERTIFIED_OPERATOR"],
      },
    };
    const write = await call("PUT", "/api/v1/admin/academy/progress", { token: operator, body: progress });
    expect(write.status).toBe(200);
    expect(JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}")).toEqual(progress);

    const overview = await call("GET", "/api/v1/admin/academy/progress/overview", { token: operator });
    expect(overview.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/progress/overview");
  });

  test("rejects an invalid checkout support body before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("PUT", "/api/v1/admin/settings/checkout-support", {
      token: operator,
      body: { enabled: "yes" },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });
});

describe("admin core contract forwarding", () => {
  test("forwards a canonical gateway create body", async () => {    const response = await call("POST", "/api/v1/admin/gateways", {
      token: operator,
      body: { code: "GW1", name: "Gateway one", category: "ACQUIRER", evidenceLevel: "VERIFIED" },
    });
    expect(response.status).toBe(201);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/gateways");
    expect(forwardedBody()).toEqual({
      code: "gw1",
      name: "Gateway one",
      operator: "ACQUIRER",
      kind: "DIRECT",
      verificationState: "VERIFIED",
    });
  });

  test("forwards a canonical user create body", async () => {
    const response = await call("POST", "/api/v1/admin/users", {
      token: operator,
      body: {
        email: "admin@example.com",
        fullName: "Admin",
        role: "COMPLIANCE",
        temporaryPassword: "Str0ngPassw0rd",
        authorities: { aml: ["read", "write"] },
      },
    });
    expect(response.status).toBe(201);
    expect(forwardedBody()).toEqual({
      email: "admin@example.com",
      role: "COMPLIANCE",
      password: "Str0ngPassw0rd",
      authoritiesMap: ["aml:read", "aml:write"],
    });
  });

  test("expands a bulk user patch into one core request per user", async () => {
    const response = await call("PATCH", "/api/v1/admin/users", {
      token: operator,
      body: { userIds: ["usr_1", "usr_2"], status: "LOCKED" },
    });
    expect(response.status).toBe(200);
    const recent = core.requests.slice(-2);
    expect(recent.map((request) => request.url)).toEqual([
      "/internal/admin/users",
      "/internal/admin/users",
    ]);
    expect(JSON.parse(recent[0]?.body.toString("utf8") ?? "{}")).toEqual({
      id: "usr_1",
      status: "SUSPENDED",
    });
    expect(JSON.parse(recent[1]?.body.toString("utf8") ?? "{}")).toEqual({
      id: "usr_2",
      status: "SUSPENDED",
    });
  });

  test("forwards a canonical join request decision", async () => {
    const response = await call("POST", "/api/v1/admin/join-requests/jr_1/decide", {
      token: compliance,
      body: { decision: "APPROVE", reason: "kyb complete" },
    });
    expect(response.status).toBe(202);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/join-requests/jr_1/decide");
    expect(forwardedBody()).toEqual({
      decision: "APPROVED",
      reasonCode: "kyb complete",
      notes: "kyb complete",
    });
  });

  test("forwards a canonical aml rule body", async () => {
    const response = await call("POST", "/api/v1/admin/aml/rules", {
      token: compliance,
      body: {
        code: "R1",
        name: "rule",
        ruleType: "SINGLE_AMOUNT",
        action: "BLOCK",
        baseSeverity: "HIGH",
        params: { amount: "1000.0000" },
      },
    });
    expect(response.status).toBe(201);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/aml/rules");
    expect(forwardedBody()).toEqual({
      code: "R1",
      name: "rule",
      ruleType: "SINGLE_AMOUNT",
      action: "BLOCK",
      baseSeverity: "HIGH",
      params: { amount: "1000.0000" },
    });
  });

  test("forwards a canonical gateway environment body", async () => {
    const response = await call("PUT", "/api/v1/admin/gateway-versions/gv_1/environments", {
      token: operator,
      body: { environments: [{ code: "live", baseUrl: "https://gw.example.com/pay", active: true }] },
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/gateway-versions/gv_1/environments");
    expect(forwardedBody()).toEqual({
      env: "LIVE",
      baseUrls: { live: "https://gw.example.com/pay" },
      allowedHosts: ["gw.example.com"],
      enabled: true,
    });
  });

  test("rejects a join request decision core cannot express", async () => {
    const response = await call("POST", "/api/v1/admin/join-requests/jr_1/decide", {
      token: compliance,
      body: { decision: "REQUEST_INFO", reason: "missing documents" },
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UNSUPPORTED_DECISION");
  });
});

describe("admin forwards payloads core accepts", () => {
  const contractRoutes: {
    method: string;
    path: string;
    body: unknown;
    contract: string;
    token?: string;
  }[] = [
    {
      method: "POST",
      path: "/api/v1/admin/gateways",
      body: { code: "GW1", name: "Gateway one", category: "ACQUIRER", evidenceLevel: "VERIFIED" },
      contract: "POST /gateways",
    },
    {
      method: "PATCH",
      path: "/api/v1/admin/gateways/gw_1",
      body: { name: "Gateway two", evidenceLevel: "PARTIAL", category: "PSSP" },
      contract: "PATCH /gateways/:id",
    },
    {
      method: "POST",
      path: "/api/v1/admin/gateways/gw_1/versions",
      body: { version: 2, changelog: "new routes" },
      contract: "POST /gateways/:id/versions",
    },
    {
      method: "POST",
      path: "/api/v1/admin/gateways/gw_1/rollback",
      body: { targetVersionId: "gv_1", reason: "rollback" },
      contract: "POST /gateways/:id/rollback",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/environments",
      body: { environments: [{ code: "live", baseUrl: "https://gw.example.com/pay", active: true }] },
      contract: "PUT /gateway-versions/:vid/environments",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/auth",
      body: { authMethod: "TOKEN_ENDPOINT", settings: { tokenUrl: "https://gw.example.com/token" } },
      contract: "PUT /gateway-versions/:vid/auth",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/settings",
      body: { settings: { amountScale: 100, amountPrecision: 2 }, timeoutMs: 20000 },
      contract: "PUT /gateway-versions/:vid/settings",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/crypto-profiles",
      body: {
        cryptoProfiles: [
          { code: "cp1", algorithm: "HMAC_SHA256", encoding: "HEX_UPPER", secretRef: "vault://hmac" },
        ],
      },
      contract: "PUT /gateway-versions/:vid/crypto-profiles",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/flows",
      body: {
        flows: [
          {
            code: "f1",
            name: "flow",
            phases: ["INITIATE", "VERIFY"],
            steps: [{ type: "HTTP", method: "POST", urlTemplate: "https://gw.example.com/pay" }],
          },
        ],
      },
      contract: "PUT /gateway-versions/:vid/flows",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/channels",
      body: { confirmationChannels: [{ type: "WEBHOOK", pathToken: "token_abcdef" }] },
      contract: "PUT /gateway-versions/:vid/channels",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/status-rules",
      body: { statusRules: [{ phase: "VERIFY", selector: "status", op: "equals", value: "OK" }] },
      contract: "PUT /gateway-versions/:vid/status-rules",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/gateway-versions/gv_1/error-maps",
      body: { errorMaps: [{ code: "E1", classification: "TERMINAL_DECLINE" }] },
      contract: "PUT /gateway-versions/:vid/error-maps",
    },
    {
      method: "POST",
      path: "/api/v1/admin/gateway-versions/gv_1/dry-run",
      body: { scenario: "otp-success", payload: { railCode: "CIB", amount: "10.0000", currency: "LYD" } },
      contract: "POST /gateway-versions/:vid/dry-run",
    },
    {
      method: "POST",
      path: "/api/v1/admin/gateway-versions/gv_1/run-suite",
      body: { suite: "CONTRACT_AMOUNT" },
      contract: "POST /gateway-versions/:vid/run-suite",
    },
    {
      method: "POST",
      path: "/api/v1/admin/users",
      body: {
        email: "admin@example.com",
        fullName: "Admin",
        role: "COMPLIANCE",
        temporaryPassword: "Str0ngPassw0rd",
        authorities: { aml: ["read", "write"] },
      },
      contract: "POST /users",
    },
    {
      method: "PATCH",
      path: "/api/v1/admin/users",
      body: { userIds: ["usr_1"], role: "SUPPORT", status: "SUSPENDED" },
      contract: "PATCH /users",
    },
    {
      method: "PATCH",
      path: "/api/v1/admin/users/usr_1",
      body: { role: "SUPPORT", status: "LOCKED" },
      contract: "PATCH /users/:id",
    },
    {
      method: "POST",
      path: "/api/v1/admin/join-requests/jr_1/assign",
      body: { assigneeUserId: "usr_1", note: "please review" },
      contract: "POST /join-requests/:id/assign",
    },
    {
      method: "POST",
      path: "/api/v1/admin/join-requests/jr_1/request-info",
      body: { requestedItems: ["national_id"], message: "please upload" },
      contract: "POST /join-requests/:id/request-info",
    },
    {
      method: "POST",
      path: "/api/v1/admin/join-requests/jr_1/decide",
      body: { decision: "REJECT", reason: "kyb incomplete" },
      contract: "POST /join-requests/:id/decide",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/kyb-documents/kyb_1/review",
      body: { decision: "REJECT", notes: "blurry scan" },
      contract: "POST /kyb-documents/:id/review",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/merchants/mch_1/suspend",
      body: { reason: "suspected fraud", emergency: true },
      contract: "POST /merchants/:id/suspend",
    },
    {
      method: "POST",
      path: "/api/v1/admin/merchants/mch_1/reinstate",
      body: { reason: "case cleared" },
      contract: "POST /merchants/:id/reinstate",
    },
    {
      method: "POST",
      path: "/api/v1/admin/merchants/mch_1/propose-edit",
      body: {
        reason: "typo",
        patch: [{ op: "replace", path: "/name", value: "Acme Ltd" }],
        baseVersion: 1,
      },
      contract: "POST /merchants/:id/propose-edit",
    },
    {
      method: "POST",
      path: "/api/v1/admin/approvals/ap_1/approve",
      body: { reason: "checked" },
      contract: "POST /approvals/:id/approve",
    },
    {
      method: "POST",
      path: "/api/v1/admin/approvals/ap_1/reject",
      body: { reason: "not checked" },
      contract: "POST /approvals/:id/reject",
    },
    {
      method: "POST",
      path: "/api/v1/admin/aml/matches/m_1/disposition",
      body: { disposition: "CONFIRMED_MATCH", notes: "real match" },
      contract: "POST /aml/matches/:id/disposition",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/aml/cases/c_1/propose",
      body: { severity: "HIGH", action: "AML_HOLD", reason: "structuring" },
      contract: "POST /aml/cases/:id/propose",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/aml/rules",
      body: {
        code: "R1",
        name: "rule",
        ruleType: "SINGLE_AMOUNT",
        action: "BLOCK",
        baseSeverity: "HIGH",
        params: { amount: "1000.0000" },
      },
      contract: "POST /aml/rules",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/aml/reporting-rules",
      body: {
        code: "CBL_LARGE",
        name: "cbl large transaction",
        mode: "PROVISIONAL",
        threshold: "1000.0000",
        currency: "LYD",
        windowDays: 30,
      },
      contract: "POST /aml/reporting-rules",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/aml/reports",
      body: {
        reportingRuleId: "rr_1",
        caseId: "aml_case_1",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
      contract: "POST /aml/reports",
      token: "compliance",
    },
    {
      method: "POST",
      path: "/api/v1/admin/rails",
      body: { code: "RAIL1", name: "Rail one", collectionMode: "REDIRECT" },
      contract: "POST /rails",
    },
    {
      method: "PATCH",
      path: "/api/v1/admin/rails/rail_1",
      body: { name: "Rail two", active: false },
      contract: "PATCH /rails/:id",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/rails/rail_1/fields",
      body: { fields: [{ code: "phone", label: "Phone", type: "PHONE" }] },
      contract: "PUT /rails/:id/fields",
    },
    {
      method: "POST",
      path: "/api/v1/admin/routes",
      body: {
        railId: "rail_1",
        gatewayId: "gw_1",
        environment: "live",
        credentialPolicy: "MERCHANT_OR_PLATFORM",
      },
      contract: "POST /routes",
    },
    {
      method: "PATCH",
      path: "/api/v1/admin/routes/route_1",
      body: { priority: 5 },
      contract: "PATCH /routes/:id",
    },
    {
      method: "POST",
      path: "/api/v1/admin/routes/route_1/state",
      body: { state: "DRAINING", reason: "maintenance window" },
      contract: "POST /routes/:id/state",
    },
    {
      method: "POST",
      path: "/api/v1/admin/assets",
      body: {
        kind: "LOGO",
        name: "logo",
        contentType: "image/png",
        storageKey: "assets/logo.png",
        sizeBytes: 1024,
        checksumSha256: "a".repeat(64),
      },
      contract: "POST /assets",
    },
    {
      method: "POST",
      path: "/api/v1/admin/operator-cases/oc_1/resolve",
      body: { resolution: "RETRY_INQUIRE", reason: "unknown state" },
      contract: "POST /operator-cases/:id/resolve",
    },
    {
      method: "POST",
      path: "/api/v1/admin/reconciliation/sources",
      body: {
        code: "SRC1",
        name: "source",
        gatewayId: "gw_1",
        fileType: "CSV",
        type: "UPLOAD",
      },
      contract: "POST /reconciliation/sources",
    },
    {
      method: "POST",
      path: "/api/v1/admin/disputes",
      body: {
        merchantId: "mch_1",
        gatewayId: "gw_1",
        railId: "rail_1",
        paymentReference: "PA-1",
        externalDisputeRef: "CB1",
        type: "CHARGEBACK",
        amount: "10.0000",
        currency: "LYD",
        reason: "fraud",
        source: "MANUAL",
      },
      contract: "POST /disputes",
    },
    {
      method: "POST",
      path: "/api/v1/admin/adjustments",
      body: {
        merchantId: "mch_1",
        attemptId: "att_1",
        type: "CHARGEBACK",
        amount: "10.0000",
        currency: "LYD",
        reason: "chargeback",
        targetGlAccountId: "gl_1",
      },
      contract: "POST /adjustments",
    },
    {
      method: "POST",
      path: "/api/v1/admin/cashouts/co_1/process",
      body: { decision: "APPROVE", reason: "verified the request" },
      contract: "POST /cashouts/:id/process",
    },
    {
      method: "POST",
      path: "/api/v1/admin/commission-profiles",
      body: {
        code: "STD",
        name: "standard",
        model: "PERCENTAGE",
        percentage: "3.0000",
        railCode: "cib",
      },
      contract: "POST /commission-profiles",
    },
    {
      method: "POST",
      path: "/api/v1/admin/velocity-rules",
      body: {
        code: "V1",
        name: "velocity",
        scope: "IP",
        windowSeconds: 60,
        maxAttempts: 5,
        action: "BLOCK",
      },
      contract: "POST /velocity-rules",
    },
    {
      method: "PUT",
      path: "/api/v1/admin/settings",
      body: { settings: { "join_request.four_eyes_policy": "RISK_BASED" } },
      contract: "PUT /settings",
    },
  ];

  for (const route of contractRoutes) {
    test(`${route.method} ${route.path} forwards a payload core accepts`, async () => {
      const before = core.requests.length;
      const response = await call(route.method, route.path, {
        token: route.token === "compliance" ? compliance : operator,
        body: route.body,
      });
      expect(response.status).not.toBe(400);
      expect(core.requests.length).toBeGreaterThan(before);
      const raw = core.requests.at(-1)?.body.toString("utf8") ?? "";
      const schema = CORE_SCHEMAS[route.contract];
      if (!schema) throw new Error(`no core schema transcribed for ${route.contract}`);
      const parsed = schema.safeParse(raw.length > 0 ? JSON.parse(raw) : undefined);
      if (!parsed.success) {
        console.error(route.contract, parsed.error.issues, raw);
      }
      expect(parsed.success).toBe(true);
    });
  }
});

describe("admin route surface", () => {
  const routes: { method: string; path: string; body?: unknown }[] = [
    { method: "POST", path: "/api/v1/admin/auth/login", body: { identifier: "a@b.c", password: "secret" } },
    { method: "POST", path: "/api/v1/admin/auth/mfa", body: { code: "123456" } },
    { method: "GET", path: "/api/v1/admin/users" },
    { method: "POST", path: "/api/v1/admin/users", body: { email: "admin@example.com", fullName: "Admin", role: "FINANCE" } },
    { method: "PATCH", path: "/api/v1/admin/users", body: { userIds: ["usr_1"], role: "SUPPORT" } },
    { method: "PATCH", path: "/api/v1/admin/users/usr_1", body: { fullName: "Admin Two" } },
    { method: "GET", path: "/api/v1/admin/join-requests" },
    { method: "GET", path: "/api/v1/admin/join-requests/jr_1" },
    { method: "POST", path: "/api/v1/admin/join-requests/jr_1/assign", body: { assigneeUserId: "usr_1" } },
    { method: "POST", path: "/api/v1/admin/join-requests/jr_1/request-info", body: { requestedItems: ["id"], message: "need more" } },
    { method: "POST", path: "/api/v1/admin/join-requests/jr_1/decide", body: { decision: "APPROVE", reason: "kyb ok" } },
    { method: "POST", path: "/api/v1/admin/kyb-documents/kyb_1/review", body: { decision: "ACCEPT" } },
    { method: "GET", path: "/api/v1/admin/merchants" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1" },
    { method: "POST", path: "/api/v1/admin/merchants/mch_1/suspend", body: { reason: "fraud" } },
    { method: "POST", path: "/api/v1/admin/merchants/mch_1/reinstate", body: { reason: "cleared" } },
    { method: "POST", path: "/api/v1/admin/merchants/mch_1/propose-edit", body: { reason: "typo", patch: [{ op: "replace", path: "/name", value: "x" }], baseVersion: 1 } },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/detail-changes" },
    { method: "GET", path: "/api/v1/admin/approvals" },
    { method: "GET", path: "/api/v1/admin/approvals/ap_1" },
    { method: "POST", path: "/api/v1/admin/approvals/ap_1/approve", body: { reason: "checked" } },
    { method: "POST", path: "/api/v1/admin/approvals/ap_1/reject", body: { reason: "not checked" } },
    { method: "GET", path: "/api/v1/admin/aml/screenings" },
    { method: "POST", path: "/api/v1/admin/aml/matches/m_1/disposition", body: { disposition: "FALSE_POSITIVE", notes: "clean" } },
    { method: "GET", path: "/api/v1/admin/aml/cases" },
    { method: "POST", path: "/api/v1/admin/aml/cases/c_1/propose", body: { severity: "HIGH", action: "AML_HOLD", reason: "structuring" } },
    { method: "GET", path: "/api/v1/admin/aml/rules" },
    { method: "POST", path: "/api/v1/admin/aml/rules", body: { code: "R1", name: "rule", ruleType: "SINGLE_AMOUNT", action: "BLOCK", baseSeverity: "HIGH", params: {} } },
    { method: "GET", path: "/api/v1/admin/aml/reporting-rules" },
    { method: "POST", path: "/api/v1/admin/aml/reporting-rules", body: { code: "CBL", name: "cbl", mode: "PROVISIONAL", threshold: "1000.0000", currency: "LYD", windowDays: 30 } },
    { method: "GET", path: "/api/v1/admin/aml/reports" },
    { method: "POST", path: "/api/v1/admin/aml/reports", body: { reportingRuleId: "rr_1", periodStart: "2026-01-01", periodEnd: "2026-01-31" } },
    { method: "GET", path: "/api/v1/admin/gateways" },
    { method: "POST", path: "/api/v1/admin/gateways", body: { code: "GW1", name: "Gateway one" } },
    { method: "PATCH", path: "/api/v1/admin/gateways/gw_1", body: { name: "Gateway two" } },
    { method: "GET", path: "/api/v1/admin/gateways/gw_1/versions" },
    { method: "POST", path: "/api/v1/admin/gateways/gw_1/versions", body: { version: 1 } },
    { method: "POST", path: "/api/v1/admin/gateways/gw_1/rollback", body: { targetVersionId: "gv_1", reason: "rollback" } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/environments", body: { environments: [{ code: "live", baseUrl: "https://gw.example.com" }] } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/auth", body: { authMethod: "API_KEY" } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/settings", body: { settings: {} } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/crypto-profiles", body: { cryptoProfiles: [{ code: "cp1", algorithm: "HMAC_SHA256", encoding: "HEX_UPPER" }] } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/flows", body: { flows: [{ code: "f1", name: "flow" }] } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/channels", body: {} },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/status-rules", body: { statusRules: [{ code: "s1" }] } },
    { method: "PUT", path: "/api/v1/admin/gateway-versions/gv_1/error-maps", body: { errorMaps: [{ code: "e1" }] } },
    { method: "POST", path: "/api/v1/admin/gateway-versions/gv_1/dry-run", body: { scenario: "otp-success" } },
    { method: "POST", path: "/api/v1/admin/gateway-versions/gv_1/run-suite", body: { suite: "SANDBOX_15" } },
    { method: "POST", path: "/api/v1/admin/gateway-versions/gv_1/submit-approval", body: { reason: "ready" } },
    { method: "GET", path: "/api/v1/admin/rails" },
    { method: "POST", path: "/api/v1/admin/rails", body: { code: "RAIL1", name: "Rail one", collectionMode: "REDIRECT" } },
    { method: "PATCH", path: "/api/v1/admin/rails/rail_1", body: { name: "Rail two" } },
    { method: "PUT", path: "/api/v1/admin/rails/rail_1/fields", body: { fields: [{ code: "phone", label: "Phone", type: "PHONE" }] } },
    { method: "GET", path: "/api/v1/admin/routes" },
    { method: "POST", path: "/api/v1/admin/routes", body: { railId: "rail_1", gatewayId: "gw_1", environment: "live", credentialPolicy: "PLATFORM" } },
    { method: "PATCH", path: "/api/v1/admin/routes/route_1", body: { priority: 5 } },
    { method: "POST", path: "/api/v1/admin/routes/route_1/state", body: { state: "DRAINING" } },
    { method: "GET", path: "/api/v1/admin/assets" },
    { method: "POST", path: "/api/v1/admin/assets", body: { kind: "LOGO", name: "logo", contentType: "image/png", storageKey: "assets/logo.png", sizeBytes: 1024, checksumSha256: "a".repeat(64) } },
    { method: "GET", path: "/api/v1/admin/operator-cases" },
    { method: "POST", path: "/api/v1/admin/operator-cases/oc_1/resolve", body: { resolution: "RETRY_INQUIRE", reason: "unknown state" } },
    { method: "POST", path: "/api/v1/admin/attempts/att_1/inquire", body: { force: true } },
    { method: "GET", path: "/api/v1/admin/reconciliation/sources" },
    { method: "POST", path: "/api/v1/admin/reconciliation/sources", body: { code: "SRC1", name: "source", gatewayId: "gw_1", fileType: "CSV", type: "UPLOAD" } },
    { method: "GET", path: "/api/v1/admin/reconciliation/runs" },
    { method: "GET", path: "/api/v1/admin/disputes" },
    { method: "POST", path: "/api/v1/admin/disputes", body: { merchantId: "mch_1", gatewayId: "gw_1", railId: "rail_1", paymentReference: "REF1", externalDisputeRef: "CB1", type: "CHARGEBACK", amount: "10.0000", currency: "LYD", reason: "fraud", source: "MANUAL" } },
    { method: "GET", path: "/api/v1/admin/adjustments" },
    { method: "POST", path: "/api/v1/admin/adjustments", body: { merchantId: "mch_1", targetGlAccountId: "gl_1", type: "CHARGEBACK", amount: "10.0000", currency: "LYD", reason: "chargeback" } },
    { method: "GET", path: "/api/v1/admin/cashouts" },
    { method: "POST", path: "/api/v1/admin/cashouts/co_1/process", body: { decision: "APPROVE" } },
    { method: "GET", path: "/api/v1/admin/commission-profiles" },
    { method: "POST", path: "/api/v1/admin/commission-profiles", body: { code: "STD", name: "standard", model: "PERCENTAGE", percentage: "3.0000", railCode: "cib" } },
    { method: "GET", path: "/api/v1/admin/velocity-rules" },
    { method: "POST", path: "/api/v1/admin/velocity-rules", body: { code: "V1", name: "velocity", scope: "MERCHANT", windowSeconds: 60, maxAttempts: 5, action: "BLOCK" } },
    { method: "GET", path: "/api/v1/admin/finance/profitability" },
    { method: "GET", path: "/api/v1/admin/finance/liquidity" },
    { method: "GET", path: "/api/v1/admin/finance/invariant-check" },
    { method: "GET", path: "/api/v1/admin/settings" },
    { method: "PUT", path: "/api/v1/admin/settings", body: { settings: { "join_request.four_eyes_policy": "RISK_BASED" } } },
  ];

  for (const route of routes) {
    test(`${route.method} ${route.path} is routed to core`, async () => {
      const before = core.requests.length;
      const response = await call(route.method, route.path, {
        token: compliance,
        body: route.body,
      });
      expect(response.status).not.toBe(404);
      expect(core.requests.length).toBeGreaterThan(before);
      const forwarded = core.requests.at(-1);
      expect(forwarded?.url.startsWith("/internal/admin/")).toBe(true);
    });
  }
});
