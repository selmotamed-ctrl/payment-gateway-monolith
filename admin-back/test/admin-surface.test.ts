import { resetEnvCache } from "../lib/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Request } from "express";
import { resolveLanClientIp } from "../api/middleware/lanGuard";
import { CORE_SCHEMAS } from "./helpers/core-schema";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { amlAuthorityToken, complianceToken, fullStaffToken, mlroToken, operatorToken, signSession } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back");
const core: TestCore = await startTestCore(pki);


const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const operator = operatorToken();
const compliance = complianceToken();
const mlro = mlroToken();
const fullStaff = fullStaffToken();

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";
  process.env.BACKUP_JOB_RATE_LIMIT_MAX = "1000000";
  resetEnvCache();
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

  test("refuses an aml route when the credential cannot be read as a session", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: "opaque-session" });
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AUTH_INVALID");
  });

  test("denies an aml route for an mfa challenge token", async () => {
    const challenge = signSession({ sub: "u-compliance", role: "COMPLIANCE", typ: "mfa" });
    const response = await call("GET", "/api/v1/admin/aml/screenings", { token: challenge });
    expect(response.status).toBe(401);
  });

  test("refuses non jwt credentials on ordinary routes without loading core", async () => {
    const before = core.requests.length;
    const response = await call("GET", "/api/v1/admin/merchants", { token: "opaque-session" });
    expect(response.status).toBe(401);
    expect(core.requests.length).toBe(before);
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

  test("approval export forwards filters to core", async () => {
    const response = await call("GET", "/api/v1/admin/approvals/export?state=PENDING_REVIEW&domain=FINANCE", {
      token: operator,
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toContain("/internal/admin/approvals/export");
    expect(core.requests.at(-1)?.url).toContain("state=PENDING_REVIEW");
    expect(core.requests.at(-1)?.url).toContain("domain=FINANCE");
  });

  test("transaction summary export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/transactions/summary/export?checklist=TRANSACTION_SCOPE_VERIFIED,ESCALATION_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/transactions/summary/export");
    expect(target.searchParams.get("checklist")).toBe("TRANSACTION_SCOPE_VERIFIED,ESCALATION_REVIEWED");
  });

  test("MFA resend forwards the challenge id to core", async () => {
    const response = await call("POST", "/api/v1/admin/auth/mfa/resend", { body: { challengeId: "0192f6a0-1111-7111-8111-111111111111" } });
    expect(response.status).toBe(200);
    expect(forwardedBody()).toMatchObject({ challengeId: "0192f6a0-1111-7111-8111-111111111111" });
  });

  test("merchant 360 summary export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/merchants/mch_1/summary/export?checklist=MERCHANT_SCOPE_VERIFIED,RISK_AML_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/merchants/mch_1/summary/export");
    expect(target.searchParams.get("checklist")).toBe("MERCHANT_SCOPE_VERIFIED,RISK_AML_REVIEWED");
  });

  test("reconciliation run export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/reconciliation/runs/run_1/export?checklist=RUN_SCOPE_VERIFIED,ITEMS_FILTER_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/reconciliation/runs/run_1/export");
    expect(target.searchParams.get("checklist")).toBe("RUN_SCOPE_VERIFIED,ITEMS_FILTER_REVIEWED");
  });

  test("gateway inquiry summary export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/gateway-inquiries/summary/export?checklist=INQUIRY_SCOPE_VERIFIED,OVERDUE_BACKLOG_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/gateway-inquiries/summary/export");
    expect(target.searchParams.get("checklist")).toBe("INQUIRY_SCOPE_VERIFIED,OVERDUE_BACKLOG_REVIEWED");
  });

  test("operator case export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/operator-cases/export?checklist=CASE_SCOPE_VERIFIED,EXPORT_APPROVAL_CONFIRMED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/operator-cases/export");
    expect(target.searchParams.get("checklist")).toBe("CASE_SCOPE_VERIFIED,EXPORT_APPROVAL_CONFIRMED");
  });

  test("audit export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/audit-logs/export?checklist=DATE_RANGE_VERIFIED,EXPORT_APPROVAL_CONFIRMED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/audit-logs/export");
    expect(target.searchParams.get("checklist")).toBe("DATE_RANGE_VERIFIED,EXPORT_APPROVAL_CONFIRMED");
  });

  test("reporting schema promotion forwards the checklist to core", async () => {
    const response = await call("POST", "/api/v1/admin/aml/report-schemas/schema_1/promote", {
      token: compliance,
      body: { setAsDefault: true, checklist: ["SCHEMA_REVIEWED", "TEMPLATE_VERIFIED"] },
    });
    expect([200, 202]).toContain(response.status);
    expect(forwardedBody()).toMatchObject({ setAsDefault: true, checklist: ["SCHEMA_REVIEWED", "TEMPLATE_VERIFIED"] });
  });

  test("credential-set mutations forward their checklists to core", async () => {
    const checklist = ["CREDENTIAL_SET_SCOPE_VERIFIED", "SECRET_HANDLING_CONFIRMED", "ENVIRONMENT_AND_OWNER_REVIEWED", "AUTHORITY_CONFIRMED"];
    const create = await call("POST", "/api/v1/admin/credential-sets", {
      token: fullStaff,
      body: {
        gatewayCode: "TEST",
        env: "SANDBOX",
        ownerType: "PLATFORM",
        settlementTarget: "PLATFORM_CLEARING",
        entries: [{ key: "apiKey", type: "HEADER", value: "secret", isSecret: true }],
        checklist,
      },
    });
    expect(create.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist });
    const rotate = await call("PUT", "/api/v1/admin/credential-sets/cs_1", {
      token: fullStaff,
      body: { entries: [{ key: "apiKey", type: "HEADER", value: "secret2", isSecret: true }], checklist },
    });
    expect(rotate.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist });
    const revoke = await call("POST", "/api/v1/admin/credential-sets/cs_1/revoke", {
      token: fullStaff,
      body: { reason: "rotated after incident", checklist },
    });
    expect(revoke.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist });
  });

  test("academy exam start forwards the integrity checklist to core", async () => {
    const checklist = ["EXAM_INTEGRITY_ACCEPTED", "EXAM_NO_OUTSIDE_HELP", "EXAM_TIME_LIMIT_ACKNOWLEDGED"];
    const response = await call("POST", "/api/v1/admin/academy/exams/exam_1/start", {
      token: fullStaff,
      body: { integrityAccepted: true, checklist },
    });
    expect(response.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ integrityAccepted: true, checklist });
  });

  test("academy certificate verification forwards the track", async () => {
    const response = await call("GET", "/api/v1/admin/academy/certificates/FOUNDATION/verification", { token: fullStaff });
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/certificates/FOUNDATION/verification");
    expect(response.status).toBeLessThan(500);
  });

  test("academy certificate revocation forwards the display id and reason", async () => {
    const response = await call("POST", "/api/v1/admin/academy/certificates/PG-AC-ABCDEF01/revoke", {
      token: fullStaff,
      body: { reason: "Issued to the wrong person" },
    });
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/certificates/PG-AC-ABCDEF01/revoke");
    const forwarded = core.requests.at(-1)?.body;
    const body = Buffer.isBuffer(forwarded) ? JSON.parse(forwarded.toString()) : forwarded;
    expect(body).toMatchObject({ reason: "Issued to the wrong person" });
    expect(response.status).toBeLessThan(500);
  });

  test("academy team export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/academy/team/export?checklist=TEAM_SCOPE_VERIFIED,PERSONAL_DATA_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/academy/team/export");
    expect(target.searchParams.get("checklist")).toBe("TEAM_SCOPE_VERIFIED,PERSONAL_DATA_REVIEWED");
  });

  test("job and notification retries forward their checklists to core", async () => {
    const id = "0192f6a0-1111-7111-8111-111111111111";
    const job = await call("POST", `/api/v1/admin/system/jobs/${id}/requeue`, {
      token: fullStaff,
      body: { reason: "provider recovered", checklist: ["JOB_SCOPE_VERIFIED", "FAILURE_CAUSE_REVIEWED"] },
    });
    expect(job.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["JOB_SCOPE_VERIFIED", "FAILURE_CAUSE_REVIEWED"] });
    const notification = await call("POST", `/api/v1/admin/system/notifications/${id}/retry`, {
      token: fullStaff,
      body: { reason: "provider recovered", checklist: ["JOB_SCOPE_VERIFIED", "RETRY_IMPACT_ACKNOWLEDGED"] },
    });
    expect(notification.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["JOB_SCOPE_VERIFIED", "RETRY_IMPACT_ACKNOWLEDGED"] });
  });

  test("object storage legal-hold and maintenance forward their checklists to core", async () => {
    const objectId = "0192f6a0-1111-7111-8111-111111111111";
    const storageToken = signSession({ sub: "u-storage", role: "SECURITY_ADMIN", authorities: ["system:storage:legal-hold", "system:storage:admin", "system:storage:read"] });
    const hold = await call("POST", `/api/v1/admin/object-storage/objects/${objectId}/legal-hold`, {
      token: storageToken,
      body: { reason: "litigation hold", checklist: ["OBJECT_SCOPE_VERIFIED", "LEGAL_RETENTION_CONFIRMED"] },
    });
    expect(hold.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["OBJECT_SCOPE_VERIFIED", "LEGAL_RETENTION_CONFIRMED"] });
    const maintenance = await call("POST", "/api/v1/admin/object-storage/maintenance/scrub", {
      token: storageToken,
      body: { checklist: ["JOB_SCOPE_VERIFIED", "VAULT_IMPACT_REVIEWED"] },
    });
    expect(maintenance.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["JOB_SCOPE_VERIFIED", "VAULT_IMPACT_REVIEWED"] });
  });

  test("backup trigger and drill forward their checklists to core", async () => {
    const trigger = await call("POST", "/api/v1/admin/system/backups/trigger", {
      token: fullStaff,
      body: { target: "all", kind: "full", checklist: ["BACKUP_TARGET_VERIFIED", "LOAD_IMPACT_REVIEWED"] },
    });
    expect(trigger.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["BACKUP_TARGET_VERIFIED", "LOAD_IMPACT_REVIEWED"] });
    const drill = await call("POST", "/api/v1/admin/system/backups/drill", {
      token: fullStaff,
      body: { checklist: ["DRILL_SCOPE_VERIFIED", "SCRATCH_ISOLATION_REVIEWED"] },
    });
    expect(drill.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["DRILL_SCOPE_VERIFIED", "SCRATCH_ISOLATION_REVIEWED"] });
  });

  test("checkout help summary export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/settings/checkout-support/summary/export?checklist=CHECKOUT_SCOPE_VERIFIED,FAQ_AND_CHANNELS_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/settings/checkout-support/summary/export");
    expect(target.searchParams.get("checklist")).toBe("CHECKOUT_SCOPE_VERIFIED,FAQ_AND_CHANNELS_REVIEWED");
  });

  test("settings backup export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/settings/export?checklist=SETTINGS_SCOPE_VERIFIED,SENSITIVE_VALUES_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/settings/export");
    expect(target.searchParams.get("checklist")).toBe("SETTINGS_SCOPE_VERIFIED,SENSITIVE_VALUES_REVIEWED");
  });

  test("journal summary export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/finance/journal-entries/summary/export?checklist=JOURNAL_SCOPE_VERIFIED,BALANCE_AND_VOLUME_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/finance/journal-entries/summary/export");
    expect(target.searchParams.get("checklist")).toBe("JOURNAL_SCOPE_VERIFIED,BALANCE_AND_VOLUME_REVIEWED");
  });

  test("invariant export and checkpoint rollup forward their checklists to core", async () => {
    const exportResponse = await call("GET", "/api/v1/admin/finance/invariant-check/export?checklist=LEDGER_SCOPE_VERIFIED,INVARIANT_RESULT_REVIEWED", { token: fullStaff });
    expect(exportResponse.status).toBe(200);
    const exportTarget = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(exportTarget.pathname).toBe("/internal/admin/finance/invariant-check/export");
    expect(exportTarget.searchParams.get("checklist")).toBe("LEDGER_SCOPE_VERIFIED,INVARIANT_RESULT_REVIEWED");
    const rollup = await call("POST", "/api/v1/admin/finance/gl-accounts/0192f6a0-1111-7111-8111-111111111111/checkpoint", {
      token: fullStaff,
      body: { reason: "monthly close verification", checklist: ["ACCOUNT_SCOPE_VERIFIED", "JOURNAL_PARITY_REVIEWED"] },
    });
    expect(rollup.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist: ["ACCOUNT_SCOPE_VERIFIED", "JOURNAL_PARITY_REVIEWED"] });
  });

  test("liquidity export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/finance/liquidity/export?checklist=LIQUIDITY_SCOPE_VERIFIED,COVER_AND_OBLIGATIONS_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/finance/liquidity/export");
    expect(target.searchParams.get("checklist")).toBe("LIQUIDITY_SCOPE_VERIFIED,COVER_AND_OBLIGATIONS_REVIEWED");
  });

  test("profitability export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/finance/profitability/export?period=last_30d&checklist=PROFITABILITY_SCOPE_VERIFIED,MARGIN_AND_COST_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/finance/profitability/export");
    expect(target.searchParams.get("checklist")).toBe("PROFITABILITY_SCOPE_VERIFIED,MARGIN_AND_COST_REVIEWED");
  });

  test("pricing creates forward their checklists to core", async () => {
    const checklist = ["PRICING_SCOPE_VERIFIED", "FEE_OR_THRESHOLD_REVIEWED", "SCOPE_IMPACT_REVIEWED", "AUTHORITY_CONFIRMED"];
    const commission = await call("POST", "/api/v1/admin/commission-profiles", {
      token: fullStaff,
      body: { code: "CP1", name: "Profile one", railCode: "CARD", model: "PERCENTAGE", percentage: "0.03", checklist },
    });
    expect(commission.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist });
    const velocity = await call("POST", "/api/v1/admin/velocity-rules", {
      token: fullStaff,
      body: { code: "VR1", name: "Rule one", scope: "MERCHANT", windowSeconds: 60, maxAttempts: 10, action: "BLOCK", checklist },
    });
    expect(velocity.status).toBeLessThan(400);
    expect(forwardedBody()).toMatchObject({ checklist });
  });

  test("cash-out export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/cashouts/export?checklist=CASHOUT_SCOPE_VERIFIED,BALANCE_AND_HOLDS_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/cashouts/export");
    expect(target.searchParams.get("checklist")).toBe("CASHOUT_SCOPE_VERIFIED,BALANCE_AND_HOLDS_REVIEWED");
  });

  test("adjustment export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/adjustments/export?checklist=ADJUSTMENT_SCOPE_VERIFIED,APPROVAL_STATE_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/adjustments/export");
    expect(target.searchParams.get("checklist")).toBe("ADJUSTMENT_SCOPE_VERIFIED,APPROVAL_STATE_REVIEWED");
  });

  test("dispute export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/disputes/export?checklist=DISPUTE_SCOPE_VERIFIED,EVIDENCE_DEADLINE_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/disputes/export");
    expect(target.searchParams.get("checklist")).toBe("DISPUTE_SCOPE_VERIFIED,EVIDENCE_DEADLINE_REVIEWED");
  });

  test("route export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/routes/export?checklist=ROUTE_SCOPE_VERIFIED,ROUTE_HEALTH_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/routes/export");
    expect(target.searchParams.get("checklist")).toBe("ROUTE_SCOPE_VERIFIED,ROUTE_HEALTH_REVIEWED");
  });

  test("rail export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/rails/export?checklist=RAIL_SCOPE_VERIFIED,COLLECTION_MODE_REVIEWED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/rails/export");
    expect(target.searchParams.get("checklist")).toBe("RAIL_SCOPE_VERIFIED,COLLECTION_MODE_REVIEWED");
  });

  test("gateway export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/gateways/export?checklist=GATEWAY_SCOPE_VERIFIED,EXPORT_APPROVAL_CONFIRMED", { token: fullStaff });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/gateways/export");
    expect(target.searchParams.get("checklist")).toBe("GATEWAY_SCOPE_VERIFIED,EXPORT_APPROVAL_CONFIRMED");
  });

  test("summary export forwards the checklist to core", async () => {
    const response = await call("GET", "/api/v1/admin/aml/screenings/summary/export?checklist=SCREENING_SCOPE_VERIFIED,UNRESOLVED_MATCH_REVIEWED", {
      token: compliance,
    });
    expect(response.status).toBe(200);
    const target = new URL(core.requests.at(-1)?.url ?? "", "http://core");
    expect(target.pathname).toBe("/internal/admin/aml/screenings/summary/export");
    expect(target.searchParams.get("checklist")).toBe("SCREENING_SCOPE_VERIFIED,UNRESOLVED_MATCH_REVIEWED");
  });

  test("bulk approval rejection fans out and returns per-request results", async () => {
    const response = await call("POST", "/api/v1/admin/approvals/bulk-reject", {
      token: operator,
      body: { approvalIds: ["apr_1", "apr_2"], reason: "stale requests" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { rejected: number; failed: number; results: unknown[] };
    expect(payload.rejected).toBe(2);
    expect(payload.failed).toBe(0);
    expect(payload.results).toHaveLength(2);
    expect(core.requests.slice(-2).map((request) => request.url)).toEqual([
      "/internal/admin/approvals/apr_1/reject",
      "/internal/admin/approvals/apr_2/reject",
    ]);
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

  test("a bulk status-only user change relays success", async () => {
    const response = await call("PATCH", "/api/v1/admin/users", {
      token: operator,
      body: { userIds: ["usr_1", "usr_2"], status: "SUSPENDED", reason: "policy review" },
    });
    expect(response.status).toBe(200);
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

describe("application token revoke checklist", () => {
  test("forwards the checklist with the revoke reason", async () => {
    const id = "0192f6a0-1111-7111-8111-111111111111";
    const tokenId = "0192f6a0-3333-7333-8333-333333333333";
    const response = await call("POST", `/api/v1/admin/applications/${id}/tokens/${tokenId}/revoke`, {
      token: fullStaff,
      body: { reason: "Suspected token exposure", checklist: ["ACCESS_IMPACT_REVIEWED"] },
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe(`/internal/admin/applications/${id}/tokens/${tokenId}/revoke`);
    expect(forwardedBody()).toMatchObject({ reason: "Suspected token exposure", checklist: ["ACCESS_IMPACT_REVIEWED"] });
  });
});

describe("admin statement upload", () => {
  test("forwards a validated csv statement to core", async () => {
    const form = new FormData();
    form.set("sourceId", "src_1");
    form.set("periodStart", "2026-01-01");
    form.set("periodEnd", "2026-01-31");
    form.set("checklist", JSON.stringify(["SOURCE_VERIFIED", "FILE_REVIEWED"]));
    form.set("statement", new Blob([new Uint8Array(Buffer.from("txn_ref,amount\nREF-1,10.0000\n"))], { type: "text/csv" }), "statement.csv");
    const response = await fetch(`${edgeUrl}/api/v1/admin/reconciliation/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${fullStaff}` },
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
      headers: { authorization: `Bearer ${fullStaff}` },
      body: form,
    });
    expect(response.status).toBe(415);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
  });
});

describe("admin upload guards run before the file is buffered", () => {
  const statement = (): FormData => {
    const form = new FormData();
    form.set("sourceId", "src_1");
    form.set("periodStart", "2026-01-01");
    form.set("periodEnd", "2026-01-31");
    form.set("statement", new Blob([new Uint8Array(Buffer.from("txn_ref,amount\nREF-1,10.0000\n"))], { type: "text/csv" }), "statement.csv");
    return form;
  };

  test("a declared length above the limit is refused without reaching core", async () => {
    const before = core.requests.length;
    process.env.MAX_UPLOAD_BYTES = "1024";
    resetEnvCache();
    try {
      const response = await fetch(`${edgeUrl}/api/v1/admin/reconciliation/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${fullStaff}`, "content-type": "multipart/form-data; boundary=x", "content-length": String(1024 + 256 * 1024 + 1) },
        body: "x",
      });
      // The oversized declaration is refused by the guard; a client that lies about the length is cut off by the socket.
      expect([413, 400]).toContain(response.status);
      expect(core.requests.length).toBe(before);
    } catch {
      expect(core.requests.length).toBe(before);
    } finally {
      delete process.env.MAX_UPLOAD_BYTES;
      resetEnvCache();
    }
  });

  test("uploads have their own per-address budget on top of the general admin limiter", async () => {
    process.env.UPLOAD_RATE_LIMIT_MAX = "2";
    resetEnvCache();
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const response = await fetch(`${edgeUrl}/api/v1/admin/reconciliation/upload`, {
          method: "POST",
          headers: { authorization: `Bearer ${fullStaff}`, "x-real-ip": "10.20.30.40" },
          body: statement(),
        });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 2).every((status) => status === 202)).toBe(true);
      expect(statuses.slice(2)).toEqual([429, 429]);
      // A cheap read from the same address is not charged to the upload budget.
      const read = await call("GET", "/api/v1/admin/merchants", { token: operator, realIp: "10.20.30.40" });
      expect(read.status).not.toBe(429);
    } finally {
      delete process.env.UPLOAD_RATE_LIMIT_MAX;
      resetEnvCache();
    }
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

  test("forwards the checkout support config history", async () => {
    const response = await call("GET", "/api/v1/admin/settings/checkout-support/history", { token: operator });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/settings/checkout-support/history");
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

  test("forwards the academy progress read and write", async () => {
    const read = await call("GET", "/api/v1/admin/academy/progress", { token: operator });
    expect(read.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/progress");

    const body = {
      baseRev: 0,
      patch: { lessons: { "l-m0-1": { at: "2026-11-04T10:00:00.000Z", v: "1.0.0", checkScore: 2 } } },
    };
    const write = await call("PUT", "/api/v1/admin/academy/progress", { token: operator, body });
    expect(write.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/progress");
    expect(JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}")).toEqual(body);
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
        authorities: { aml: ["read", "write"] },
      },
    });
    expect(response.status).toBe(201);
    expect(forwardedBody()).toEqual({
      email: "admin@example.com",
      role: "COMPLIANCE",
      authoritiesMap: ["aml:read", "aml:write"],
    });
  });

  test("user creation refuses a maker-chosen password or phone and never forwards them", async () => {
    for (const extra of [{ temporaryPassword: "Str0ngPassw0rd" }, { phone: "+218910000000" }, { password: "Str0ngPassw0rd" }]) {
      const before = core.requests.length;
      const response = await call("POST", "/api/v1/admin/users", {
        token: operator,
        body: { email: "admin@example.com", role: "COMPLIANCE", ...extra },
      });
      expect(response.status).toBe(400);
      expect(core.requests.length).toBe(before);
    }
  });

  test("the invitation can be accepted without a session and is strictly validated", async () => {
    const accepted = await call("POST", "/api/v1/admin/auth/accept-invitation", {
      body: { token: "t".repeat(32), password: "Str0ngPassw0rd!", phone: "+218910000321" },
    });
    expect(accepted.status).toBe(200);
    expect(forwardedBody()).toEqual({ token: "t".repeat(32), password: "Str0ngPassw0rd!", phone: "+218910000321" });
    for (const body of [
      { token: "short", password: "Str0ngPassw0rd!", phone: "+218910000321" },
      { token: "t".repeat(32), password: "weak", phone: "+218910000321" },
      { token: "t".repeat(32), password: "Str0ngPassw0rd!", phone: "not a phone" },
      { token: "t".repeat(32), password: "Str0ngPassw0rd!", phone: "+218910000321", status: "ACTIVE" },
    ]) {
      expect((await call("POST", "/api/v1/admin/auth/accept-invitation", { body })).status).toBe(400);
    }
  });

  test("re-inviting a user forwards the checklist to core", async () => {
    const checklist = ["IDENTITY_VERIFIED", "INVITATION_EXPIRY_REVIEWED", "DELIVERY_CHANNEL_CONFIRMED"];
    const response = await call("POST", "/api/v1/admin/users/usr_9/invite", { token: operator, body: { checklist } });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)).toMatchObject({ method: "POST", url: "/internal/admin/users/usr_9/invite" });
    expect(forwardedBody()).toMatchObject({ checklist });
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
    expect(response.status).toBe(200);
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

  test("commission profile expiry and velocity deactivation relay the accepted status", async () => {
    const expire = await call("POST", "/api/v1/admin/commission-profiles/cp_1/expire", {
      token: operator,
      body: { effectiveTo: "2026-12-31T00:00:00.000Z", reason: "replace pricing", checklist: ["LIFECYCLE_SCOPE_REVIEWED"] },
    });
    expect(expire.status).toBe(202);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/commission-profiles/cp_1/expire");
    expect(forwardedBody()).toEqual({ effectiveTo: "2026-12-31T00:00:00.000Z", reason: "replace pricing", checklist: ["LIFECYCLE_SCOPE_REVIEWED"] });

    const deactivate = await call("POST", "/api/v1/admin/velocity-rules/vr_1/deactivate", {
      token: operator,
      body: { reason: "replace policy" },
    });
    expect(deactivate.status).toBe(202);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/velocity-rules/vr_1/deactivate");
    expect(forwardedBody()).toEqual({ reason: "replace policy" });
  });

  test("a gateway version clone forwards the changelog", async () => {
    const response = await call("POST", "/api/v1/admin/gateway-versions/gv_1/clone", {
      token: operator,
      body: { changelog: "copy live for editing" },
    });
    expect(response.status).toBe(201);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/gateway-versions/gv_1/clone");
    expect(forwardedBody()).toEqual({ changelog: "copy live for editing" });
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

  test("forwards the profitability period to core", async () => {
    const response = await call("GET", "/api/v1/admin/finance/profitability?period=last_7d", {
      token: operator,
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/finance/profitability?period=last_7d");
  });

  test("rejects an unknown profitability period before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("GET", "/api/v1/admin/finance/profitability?period=last_year", {
      token: operator,
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
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
      body: { reason: "checked", checklist: ["DIFF_REVIEWED", "SUBJECT_CONTEXT_REVIEWED", "MAKER_CHECKER_SEPARATION_VERIFIED", "RISK_ASSESSED"] },
      contract: "POST /approvals/:id/approve",
    },
    {
      method: "POST",
      path: "/api/v1/admin/approvals/ap_1/reject",
      body: { reason: "not checked", checklist: ["DIFF_REVIEWED", "SUBJECT_CONTEXT_REVIEWED", "MAKER_CHECKER_SEPARATION_VERIFIED", "RISK_ASSESSED"] },
      contract: "POST /approvals/:id/reject",
    },
    {
      method: "POST",
      path: "/api/v1/admin/approvals/ap_1/extend-emergency",
      body: { days: 3, reason: "A second officer needs more time to review the evidence" },
      contract: "POST /approvals/:id/extend-emergency",
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
      path: "/api/v1/admin/gateway-inquiries/giq_1/cancel",
      body: { reason: "duplicate schedule", checklist: ["SCHEDULE_STATE_VERIFIED", "ATTEMPT_IMPACT_REVIEWED", "CANCEL_REASON_VERIFIED", "ACTION_APPROVAL_CONFIRMED"] },
      contract: "POST /gateway-inquiries/:id/cancel",
    },
    {
      method: "POST",
      path: "/api/v1/admin/gateway-inquiries/giq_1/run-now",
      body: { reason: "operator requested", checklist: ["SCHEDULE_STATE_VERIFIED", "ATTEMPT_STATUS_VERIFIED", "RATE_LIMIT_REVIEWED", "ACTION_APPROVAL_CONFIRMED"] },
      contract: "POST /gateway-inquiries/:id/run-now",
    },
    {
      method: "POST",
      path: "/api/v1/admin/gateway-inquiries/giq_1/retry",
      body: { checklist: ["SCHEDULE_STATE_VERIFIED", "ATTEMPT_STATUS_VERIFIED", "RATE_LIMIT_REVIEWED", "ACTION_APPROVAL_CONFIRMED"] },
      contract: "POST /gateway-inquiries/:id/retry",
    },
    {
      method: "POST",
      path: "/api/v1/admin/operator-cases/bulk-inquire",
      body: { caseIds: ["oc_1"], reason: "unknown backlog" },
      contract: "POST /operator-cases/bulk-inquire",
    },
    {
      method: "PATCH",
      path: "/api/v1/admin/operator-cases/oc_1",
      body: { assigneeUserId: "user_1", state: "IN_PROGRESS" },
      contract: "PATCH /operator-cases/:id",
    },
    {
      method: "POST",
      path: "/api/v1/admin/operator-cases/oc_1/resolve",
      body: { action: "MARK_FAILED", reason: "gateway confirmed unpaid" },
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
      body: { decision: "APPROVE", reason: "verified the request", checklist: ["BANK_DETAILS_VERIFIED", "WALLET_BALANCE_VERIFIED", "MERCHANT_ACTIVE", "NO_AML_RESTRICTIONS"] },
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
    { method: "POST", path: "/api/v1/admin/auth/mfa/resend", body: { challengeId: "0192f6a0-1111-7111-8111-111111111111" } },

    { method: "GET", path: "/api/v1/admin/users" },
    { method: "GET", path: "/api/v1/admin/users/summary" },
    { method: "GET", path: "/api/v1/admin/users/summary/export" },
    { method: "GET", path: "/api/v1/admin/users/export?scope=admin&status=ACTIVE&checklist=USER_SCOPE_REVIEWED" },
    { method: "GET", path: "/api/v1/admin/stats/overview" },
    { method: "GET", path: "/api/v1/admin/stats/recent-activity?limit=8" },
    { method: "GET", path: "/api/v1/admin/stats/recent-activity/export?limit=200" },
    { method: "GET", path: "/api/v1/admin/stats/export?period=7d" },
    { method: "POST", path: "/api/v1/admin/stats/export-audit", body: { period: "7d" } },
    { method: "POST", path: "/api/v1/admin/users", body: { email: "admin@example.com", fullName: "Admin", role: "FINANCE" } },
    { method: "PATCH", path: "/api/v1/admin/users", body: { userIds: ["usr_1"], role: "SUPPORT" } },
    { method: "PATCH", path: "/api/v1/admin/users/usr_1", body: { fullName: "Admin Two" } },
    { method: "GET", path: "/api/v1/admin/join-requests" },
    { method: "GET", path: "/api/v1/admin/join-requests/summary" },
    { method: "GET", path: "/api/v1/admin/join-requests/summary/export" },
    { method: "GET", path: "/api/v1/admin/join-requests/export?status=SUBMITTED" },
    { method: "GET", path: "/api/v1/admin/join-requests/jr_1" },
    { method: "POST", path: "/api/v1/admin/join-requests/jr_1/assign", body: { assigneeUserId: "usr_1" } },
    { method: "POST", path: "/api/v1/admin/join-requests/jr_1/request-info", body: { requestedItems: ["id"], message: "need more" } },
    { method: "POST", path: "/api/v1/admin/join-requests/jr_1/decide", body: { decision: "APPROVE", reason: "kyb ok" } },
    { method: "POST", path: "/api/v1/admin/kyb-documents/kyb_1/review", body: { decision: "ACCEPT" } },
    { method: "GET", path: "/api/v1/admin/kyb-documents/summary" },
    { method: "GET", path: "/api/v1/admin/kyb-documents/summary/export" },
    { method: "GET", path: "/api/v1/admin/kyb-documents/export?status=UPLOADED" },
    { method: "GET", path: "/api/v1/admin/merchants" },
    { method: "GET", path: "/api/v1/admin/merchants/summary" },
    { method: "GET", path: "/api/v1/admin/merchants/summary/export" },
    { method: "GET", path: "/api/v1/admin/merchants/export?status=ACTIVE" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/summary/export" },
    { method: "POST", path: "/api/v1/admin/merchants/mch_1/suspend", body: { reason: "fraud" } },
    { method: "POST", path: "/api/v1/admin/merchants/mch_1/reinstate", body: { reason: "cleared" } },
    { method: "POST", path: "/api/v1/admin/merchants/mch_1/propose-edit", body: { reason: "typo", patch: [{ op: "replace", path: "/name", value: "x" }], baseVersion: 1 } },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/detail-changes" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/transactions" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/applications" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/wallets" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/cashouts" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/disputes" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/adjustments" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/notifications" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/audit-events" },
    { method: "GET", path: "/api/v1/admin/merchants/mch_1/stats" },
    { method: "GET", path: "/api/v1/admin/approvals" },
    { method: "GET", path: "/api/v1/admin/approvals/summary" },
    { method: "GET", path: "/api/v1/admin/approvals/summary/export" },
    { method: "GET", path: "/api/v1/admin/approvals/export?state=PENDING_REVIEW" },
    { method: "POST", path: "/api/v1/admin/approvals/bulk-reject", body: { approvalIds: ["apr_1"], reason: "stale" } },
    { method: "GET", path: "/api/v1/admin/approvals/ap_1" },
    { method: "POST", path: "/api/v1/admin/approvals/ap_1/approve", body: { reason: "checked" } },
    { method: "POST", path: "/api/v1/admin/approvals/ap_1/reject", body: { reason: "not checked" } },
    { method: "GET", path: "/api/v1/admin/aml/screenings" },
    { method: "GET", path: "/api/v1/admin/aml/screenings/summary" },
    { method: "GET", path: "/api/v1/admin/aml/screenings/summary/export" },
    { method: "GET", path: "/api/v1/admin/aml/screenings/export?result=POTENTIAL_MATCH&checklist=SCREENING_SCOPE_VERIFIED" },
    { method: "POST", path: "/api/v1/admin/aml/matches/m_1/disposition", body: { disposition: "FALSE_POSITIVE", notes: "clean" } },
    { method: "GET", path: "/api/v1/admin/aml/cases" },
    { method: "GET", path: "/api/v1/admin/aml/cases/summary" },
    { method: "GET", path: "/api/v1/admin/aml/cases/summary/export" },
    { method: "GET", path: "/api/v1/admin/aml/cases/export?status=OPEN&checklist=AML_SCOPE_VERIFIED" },
    { method: "POST", path: "/api/v1/admin/aml/cases/c_1/propose", body: { severity: "HIGH", action: "AML_HOLD", reason: "structuring" } },
    { method: "POST", path: "/api/v1/admin/aml/report-schemas/schema_1/promote", body: { setAsDefault: true, checklist: ["SCHEMA_REVIEWED", "MAPPING_VALIDATED", "TEMPLATE_VERIFIED", "APPROVAL_PATH_CONFIRMED"] } },
    { method: "GET", path: "/api/v1/admin/aml/rules" },
    { method: "GET", path: "/api/v1/admin/aml/rules/summary" },
    { method: "GET", path: "/api/v1/admin/aml/rules/summary/export" },
    { method: "GET", path: "/api/v1/admin/aml/rules/export?active=true&checklist=RULE_SCOPE_VERIFIED" },
    { method: "POST", path: "/api/v1/admin/aml/rules", body: { code: "R1", name: "rule", ruleType: "SINGLE_AMOUNT", action: "BLOCK", baseSeverity: "HIGH", params: {} } },
    { method: "GET", path: "/api/v1/admin/aml/reporting-rules" },
    { method: "POST", path: "/api/v1/admin/aml/reporting-rules", body: { code: "CBL", name: "cbl", mode: "PROVISIONAL", threshold: "1000.0000", currency: "LYD", windowDays: 30 } },
    { method: "GET", path: "/api/v1/admin/aml/incidents" },
    { method: "GET", path: "/api/v1/admin/aml/incidents/export?severity=SEV1&checklist=INCIDENT_SCOPE_VERIFIED" },
    { method: "GET", path: "/api/v1/admin/aml/incidents/summary/export?checklist=INCIDENT_SCOPE_VERIFIED" },
    { method: "GET", path: "/api/v1/admin/aml/reports" },
    { method: "GET", path: "/api/v1/admin/aml/reports/summary" },
    { method: "GET", path: "/api/v1/admin/aml/reports/summary/export" },
    { method: "GET", path: "/api/v1/admin/aml/reports/export?status=DRAFT&checklist=REPORT_SCOPE_VERIFIED" },
    { method: "POST", path: "/api/v1/admin/aml/reports", body: { reportingRuleId: "rr_1", periodStart: "2026-01-01", periodEnd: "2026-01-31" } },
    { method: "POST", path: "/api/v1/admin/aml/reports/rep_1/submit", body: { submissionRef: "CBL-1", checklist: ["REPORT_APPROVED_VERIFIED", "AUTHORITY_REFERENCE_VERIFIED", "DEADLINE_VERIFIED", "PAYLOAD_DIGEST_VERIFIED"] } },
    { method: "POST", path: "/api/v1/admin/aml/reports/rep_1/acknowledge", body: { status: "ACKNOWLEDGED", checklist: ["AUTHORITY_RESPONSE_VERIFIED", "DECISION_RECORDED", "REJECTION_REASON_DOCUMENTED", "REPORT_CLOSURE_CONFIRMED"] } },
    { method: "GET", path: "/api/v1/admin/gateways" },
    { method: "GET", path: "/api/v1/admin/gateways/export?status=LIVE" },
    { method: "GET", path: "/api/v1/admin/gateways/summary" },
    { method: "GET", path: "/api/v1/admin/gateways/summary/export" },
    { method: "POST", path: "/api/v1/admin/gateways", body: { code: "GW1", name: "Gateway one" } },
    { method: "PATCH", path: "/api/v1/admin/gateways/gw_1", body: { name: "Gateway two" } },
    { method: "GET", path: "/api/v1/admin/gateways/gw_1/versions" },
    { method: "POST", path: "/api/v1/admin/gateways/gw_1/versions", body: { version: 1 } },
    { method: "POST", path: "/api/v1/admin/gateways/gw_1/rollback", body: { targetVersionId: "gv_1", reason: "rollback" } },
    { method: "POST", path: "/api/v1/admin/gateway-versions/gv_1/clone", body: { changelog: "clone for edit" } },
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
    { method: "GET", path: "/api/v1/admin/rails/summary" },
    { method: "GET", path: "/api/v1/admin/rails/summary/export" },
    { method: "GET", path: "/api/v1/admin/rails/export?blocked=false" },
    { method: "POST", path: "/api/v1/admin/rails", body: { code: "RAIL1", name: "Rail one", collectionMode: "REDIRECT" } },
    { method: "PATCH", path: "/api/v1/admin/rails/rail_1", body: { name: "Rail two" } },
    { method: "PUT", path: "/api/v1/admin/rails/rail_1/fields", body: { fields: [{ code: "phone", label: "Phone", type: "PHONE" }] } },
    { method: "GET", path: "/api/v1/admin/routes" },
    { method: "GET", path: "/api/v1/admin/routes/summary" },
    { method: "GET", path: "/api/v1/admin/routes/summary/export" },
    { method: "GET", path: "/api/v1/admin/routes/export?status=ACTIVE" },
    { method: "POST", path: "/api/v1/admin/routes", body: { railId: "rail_1", gatewayId: "gw_1", environment: "live", credentialPolicy: "PLATFORM" } },
    { method: "PATCH", path: "/api/v1/admin/routes/route_1", body: { priority: 5 } },
    { method: "POST", path: "/api/v1/admin/routes/route_1/state", body: { state: "DRAINING" } },
    { method: "GET", path: "/api/v1/admin/assets" },
    { method: "POST", path: "/api/v1/admin/assets", body: { kind: "LOGO", name: "logo", contentType: "image/png", storageKey: "assets/logo.png", sizeBytes: 1024, checksumSha256: "a".repeat(64) } },
    { method: "GET", path: "/api/v1/admin/gateway-inquiries" },
    { method: "GET", path: "/api/v1/admin/gateway-inquiries/summary" },
    { method: "GET", path: "/api/v1/admin/gateway-inquiries/summary/export?checklist=INQUIRY_SCOPE_VERIFIED,SCHEDULE_STATUS_REVIEWED,OVERDUE_BACKLOG_REVIEWED,EXPORT_APPROVAL_CONFIRMED" },

    { method: "GET", path: "/api/v1/admin/gateway-inquiries/giq_1" },
    { method: "POST", path: "/api/v1/admin/gateway-inquiries/giq_1/cancel", body: { reason: "duplicate schedule" } },
    { method: "POST", path: "/api/v1/admin/gateway-inquiries/giq_1/run-now", body: { reason: "operator requested" } },
    { method: "POST", path: "/api/v1/admin/gateway-inquiries/giq_1/retry", body: {} },
    { method: "GET", path: "/api/v1/admin/operator-cases" },
    { method: "GET", path: "/api/v1/admin/operator-cases/summary" },
    { method: "GET", path: "/api/v1/admin/operator-cases/export?checklist=CASE_SCOPE_VERIFIED,SENSITIVE_FIELDS_REVIEWED,EXPORT_APPROVAL_CONFIRMED" },
    { method: "GET", path: "/api/v1/admin/operator-cases/summary/export" },
    { method: "GET", path: "/api/v1/admin/operator-cases/export?state=OPEN" },
    { method: "POST", path: "/api/v1/admin/operator-cases/bulk-assign", body: { caseIds: ["oc_1"], assigneeUserId: "usr_1", reason: "load balance" } },
    { method: "POST", path: "/api/v1/admin/operator-cases/bulk-state", body: { caseIds: ["oc_1"], state: "IN_PROGRESS", reason: "start work" } },
    { method: "POST", path: "/api/v1/admin/operator-cases/bulk-inquire", body: { caseIds: ["oc_1"], reason: "unknown backlog" } },
    { method: "PATCH", path: "/api/v1/admin/operator-cases/oc_1", body: { assigneeUserId: "user_1", state: "IN_PROGRESS" } },
    { method: "POST", path: "/api/v1/admin/operator-cases/oc_1/resolve", body: { action: "MARK_FAILED", reason: "gateway confirmed unpaid" } },
    { method: "POST", path: "/api/v1/admin/attempts/att_1/inquire", body: { checklist: ["INQUIRY_ELIGIBILITY_VERIFIED"] } },
    { method: "GET", path: "/api/v1/admin/reconciliation/sources" },
    { method: "POST", path: "/api/v1/admin/reconciliation/sources", body: { code: "SRC1", name: "source", gatewayId: "gw_1", fileType: "CSV", type: "UPLOAD" } },
    { method: "GET", path: "/api/v1/admin/reconciliation/runs" },
    { method: "GET", path: "/api/v1/admin/reconciliation/runs/summary" },
    { method: "GET", path: "/api/v1/admin/reconciliation/runs/summary/export" },
    { method: "PATCH", path: "/api/v1/admin/reconciliation/sources/src_1", body: { active: false, settlementLagDays: 2 } },
    { method: "GET", path: "/api/v1/admin/reconciliation/runs/run_1/export?result=AMOUNT_MISMATCH" },
    { method: "GET", path: "/api/v1/admin/disputes" },
    { method: "GET", path: "/api/v1/admin/disputes/summary" },
    { method: "GET", path: "/api/v1/admin/disputes/summary/export" },
    { method: "GET", path: "/api/v1/admin/disputes/export?status=OPENED" },
    { method: "POST", path: "/api/v1/admin/disputes", body: { merchantId: "mch_1", gatewayId: "gw_1", railId: "rail_1", paymentReference: "REF1", externalDisputeRef: "CB1", type: "CHARGEBACK", amount: "10.0000", currency: "LYD", reason: "fraud", source: "MANUAL" } },
    { method: "POST", path: "/api/v1/admin/disputes/dsp_1/evidence", body: { evidence: { reference: "CB-1" }, notes: "submitted", checklist: ["EVIDENCE_REFERENCE_VERIFIED", "SUPPORTING_DOCUMENTS_ATTACHED", "EVIDENCE_WINDOW_VERIFIED", "SUMMARY_REVIEWED"] } },
    { method: "GET", path: "/api/v1/admin/adjustments" },
    { method: "GET", path: "/api/v1/admin/adjustments/summary" },
    { method: "GET", path: "/api/v1/admin/adjustments/summary/export" },
    { method: "GET", path: "/api/v1/admin/adjustments/export?state=PENDING_REVIEW" },
    { method: "POST", path: "/api/v1/admin/adjustments", body: { merchantId: "mch_1", targetGlAccountId: "gl_1", type: "CHARGEBACK", amount: "10.0000", currency: "LYD", reason: "chargeback" } },
    { method: "GET", path: "/api/v1/admin/cashouts" },
    { method: "GET", path: "/api/v1/admin/cashouts/summary" },
    { method: "GET", path: "/api/v1/admin/cashouts/summary/export" },
    { method: "GET", path: "/api/v1/admin/cashouts/export?state=PENDING" },
    { method: "POST", path: "/api/v1/admin/cashouts/co_1/process", body: { decision: "APPROVE" } },
    { method: "GET", path: "/api/v1/admin/commission-profiles" },
    { method: "GET", path: "/api/v1/admin/commission-profiles/summary" },
    { method: "POST", path: "/api/v1/admin/commission-profiles/cp_1/expire", body: { effectiveTo: "2026-12-31T00:00:00.000Z", reason: "replace pricing" } },
    { method: "GET", path: "/api/v1/admin/commission-profiles/cp_1/history" },
    { method: "GET", path: "/api/v1/admin/velocity-rules/vr_1/history" },
    { method: "POST", path: "/api/v1/admin/velocity-rules/vr_1/deactivate", body: { reason: "replace policy" } },
    { method: "POST", path: "/api/v1/admin/commission-profiles", body: { code: "STD", name: "standard", model: "PERCENTAGE", percentage: "3.0000", railCode: "cib" } },
    { method: "GET", path: "/api/v1/admin/velocity-rules" },
    { method: "GET", path: "/api/v1/admin/velocity-rules/summary" },
    { method: "POST", path: "/api/v1/admin/velocity-rules", body: { code: "V1", name: "velocity", scope: "MERCHANT", windowSeconds: 60, maxAttempts: 5, action: "BLOCK" } },
    { method: "GET", path: "/api/v1/admin/finance/profitability" },
    { method: "GET", path: "/api/v1/admin/finance/profitability/export?period=last_7d" },
    { method: "GET", path: "/api/v1/admin/finance/liquidity" },
    { method: "GET", path: "/api/v1/admin/finance/liquidity/export" },
    { method: "GET", path: "/api/v1/admin/finance/invariant-check" },
    { method: "GET", path: "/api/v1/admin/finance/invariant-check/export" },
    { method: "GET", path: "/api/v1/admin/settings" },
    { method: "GET", path: "/api/v1/admin/settings/summary" },
    { method: "GET", path: "/api/v1/admin/settings/summary/export" },
    { method: "POST", path: "/api/v1/admin/search", body: { query: "acme", limit: 5 } },
    { method: "GET", path: "/api/v1/admin/audit-logs" },
    { method: "GET", path: "/api/v1/admin/audit-logs/summary" },
    { method: "GET", path: "/api/v1/admin/audit-logs/export?checklist=DATE_RANGE_VERIFIED,SENSITIVE_FIELDS_REVIEWED,EXPORT_APPROVAL_CONFIRMED" },
    { method: "GET", path: "/api/v1/admin/audit-logs/summary/export" },
    { method: "GET", path: "/api/v1/admin/audit-logs/export?action=APPROVAL" },
    { method: "GET", path: "/api/v1/admin/audit-logs/audit-1" },
    { method: "GET", path: "/api/v1/admin/settings/checkout-support/history" },
    { method: "GET", path: "/api/v1/admin/settings/checkout-support/summary" },
    { method: "GET", path: "/api/v1/admin/settings/checkout-support/summary/export" },
    { method: "GET", path: "/api/v1/admin/academy/exams/exam-foundation/eligibility" },
    { method: "POST", path: "/api/v1/admin/academy/exams/exam-foundation/start", body: { integrityAccepted: true } },
    { method: "GET", path: "/api/v1/admin/settings/export" },
    { method: "POST", path: "/api/v1/admin/settings/restore-preview", body: { backup: { settings: [{ key: "checkout.support_config", valueJson: {} }] } } },
    { method: "POST", path: "/api/v1/admin/settings/restore-apply", body: { confirm: true, reason: "restore approved backup", backup: { settings: [{ key: "checkout.support_config", valueJson: {}, expectedCurrentVersion: 1 }] } } },
    { method: "PUT", path: "/api/v1/admin/settings", body: { settings: { "join_request.four_eyes_policy": "RISK_BASED" } } },
  ];

  for (const route of routes) {
    test(`${route.method} ${route.path} is routed to core`, async () => {
      const before = core.requests.length;
      const response = await call(route.method, route.path, {
        token: fullStaff,
        body: route.body,
      });
      expect(response.status).not.toBe(404);
      expect(core.requests.length).toBeGreaterThan(before);
      const forwarded = core.requests.at(-1);
      expect(forwarded?.url.startsWith("/internal/admin/")).toBe(true);
    });
  }
});
