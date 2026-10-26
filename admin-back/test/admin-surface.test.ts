import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";

const pki: TestPki = createTestPki("admin-back");
const core: TestCore = await startTestCore(pki);

process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = core.url;
process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
process.env.MTLS_CA_CERT_PATH = pki.caCert;
process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";

const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const makeToken = (payload: Record<string, unknown>): string =>
  `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url(payload)}.signature`;

const operatorToken = makeToken({ sub: "u-1", roles: ["OPERATOR"], authorities_map: {} });
const complianceToken = makeToken({ sub: "u-2", roles: ["COMPLIANCE"], authorities_map: {} });

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

const call = (method: string, path: string, options: { token?: string; body?: unknown; ip?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.ip) headers["x-real-client-ip"] = options.ip;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${edgeUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

describe("admin lan restriction", () => {
  test("rejects a client outside the lan allowlist", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operatorToken,
      ip: "203.0.113.9",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("ADMIN_LAN_ONLY");
  });

  test("accepts a client inside the lan allowlist", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", {
      token: operatorToken,
      ip: "10.20.30.40",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/merchants");
  });

  test("accepts a loopback client without a forwarded header", async () => {
    const response = await call("GET", "/api/v1/admin/merchants", { token: operatorToken });
    expect(response.status).toBe(200);
  });

  test("never reaches core when the lan guard rejects the call", async () => {
    const before = core.requests.length;
    await call("GET", "/api/v1/admin/merchants", { token: operatorToken, ip: "198.51.100.7" });
    expect(core.requests.length).toBe(before);
  });
});

describe("admin authority hints", () => {
  test("denies an aml route without the confidential authority", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: operatorToken });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("EDGE_AUTHORITY_DENIED");
  });

  test("allows an aml route for a compliance officer", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: complianceToken });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/aml/screenings");
  });

  test("leaves non jwt credentials to the authoritative core", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: "opaque-session" });
    expect(response.status).toBe(200);
  });

  test("requires a bearer token on protected admin routes", async () => {
    const response = await call("GET", "/api/v1/admin/merchants");
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AUTH_REQUIRED");
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
      headers: { authorization: `Bearer ${complianceToken}` },
      body: form,
    });
    expect(response.status).toBe(202);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/admin/reconciliation/upload");
    expect(forwarded?.headers["x-upload-content-type"]).toBe("text/csv");
    expect(forwarded?.body.toString("utf8")).toContain("REF-1");
  });

  test("rejects a statement whose content does not match the declared type", async () => {
    const form = new FormData();
    form.set("sourceId", "src_1");
    form.set("periodStart", "2026-01-01");
    form.set("periodEnd", "2026-01-31");
    form.set("statement", new Blob([new Uint8Array(Buffer.from([0x00, 0x01, 0x02, 0x03]))], { type: "text/csv" }), "bad.csv");
    const response = await fetch(`${edgeUrl}/api/v1/admin/reconciliation/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${complianceToken}` },
      body: form,
    });
    expect(response.status).toBe(415);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });
});

describe("admin route surface", () => {
  const routes: { method: string; path: string; body?: unknown }[] = [
    { method: "POST", path: "/api/v1/admin/auth/login", body: { identifier: "a@b.c", password: "secret" } },
    { method: "POST", path: "/api/v1/admin/auth/mfa", body: { code: "123456" } },
    { method: "GET", path: "/api/v1/admin/users" },
    { method: "POST", path: "/api/v1/admin/users", body: { email: "a@b.c", fullName: "Admin", role: "FINANCE" } },
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
    { method: "POST", path: "/api/v1/admin/aml/rules", body: { code: "R1", name: "rule", layer: 3, type: "SINGLE_AMOUNT", parameters: {}, action: "REVIEW" } },
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
    { method: "POST", path: "/api/v1/admin/routes", body: { railId: "rail_1", environment: "live" } },
    { method: "PATCH", path: "/api/v1/admin/routes/route_1", body: { priority: 5 } },
    { method: "POST", path: "/api/v1/admin/routes/route_1/state", body: { state: "DRAINING" } },
    { method: "GET", path: "/api/v1/admin/assets" },
    { method: "POST", path: "/api/v1/admin/assets", body: { kind: "LOGO", name: "logo", contentType: "image/png", storageKey: "assets/logo.png" } },
    { method: "GET", path: "/api/v1/admin/operator-cases" },
    { method: "POST", path: "/api/v1/admin/operator-cases/oc_1/resolve", body: { resolution: "RETRY_INQUIRE", reason: "unknown state" } },
    { method: "POST", path: "/api/v1/admin/attempts/att_1/inquire", body: { force: true } },
    { method: "GET", path: "/api/v1/admin/reconciliation/sources" },
    { method: "POST", path: "/api/v1/admin/reconciliation/sources", body: { code: "SRC1", name: "source", fileType: "CSV" } },
    { method: "GET", path: "/api/v1/admin/reconciliation/runs" },
    { method: "GET", path: "/api/v1/admin/disputes" },
    { method: "POST", path: "/api/v1/admin/disputes", body: { merchantId: "mch_1", paymentReference: "REF1", externalDisputeRef: "CB1", type: "CHARGEBACK", amount: "10.0000", currency: "LYD", reason: "fraud" } },
    { method: "GET", path: "/api/v1/admin/adjustments" },
    { method: "POST", path: "/api/v1/admin/adjustments", body: { merchantId: "mch_1", type: "CHARGEBACK", amount: "10.0000", currency: "LYD", reason: "chargeback" } },
    { method: "GET", path: "/api/v1/admin/cashouts" },
    { method: "GET", path: "/api/v1/admin/cashouts/co_1/process" },
    { method: "POST", path: "/api/v1/admin/cashouts/co_1/process", body: { decision: "APPROVE" } },
    { method: "GET", path: "/api/v1/admin/commission-profiles" },
    { method: "POST", path: "/api/v1/admin/commission-profiles", body: { code: "STD", name: "standard", model: "PERCENTAGE", percentage: "3.0000" } },
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
      const response = await call(route.method, route.path, {
        token: complianceToken,
        body: route.body,
      });
      expect(response.status).not.toBe(404);
      const forwarded = core.requests.at(-1);
      expect(forwarded?.url.startsWith("/internal/admin/")).toBe(true);
    });
  }
});
