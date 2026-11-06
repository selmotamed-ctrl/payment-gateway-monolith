import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetEnvCache } from "../lib/env";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { fullStaffToken, signSession } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back-ui-completion");
const core: TestCore = await startTestCore(pki);

const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const staff = fullStaffToken();
const tokenWith = (...authorities: string[]) =>
  signSession({ sub: "u-scoped", role: "SUPPORT", authorities });
/** A valid session that carries no authority relevant to any route under test. */
const nobody = tokenWith("user:read");

const ID = "0192f6a0-1111-7111-8111-111111111111";
const OWNER_ID = "0192f6a0-2222-7222-8222-222222222222";
const TOKEN_ID = "0192f6a0-3333-7333-8333-333333333333";
const REASON = "customer reported suspicious activity";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";
  // This file sends several hundred requests from one IP; the per-minute budget is shared with every
  // earlier file of a full `bun test` run, so lift it here (the limiter itself is covered in security-regressions).
  process.env.ADMIN_RATE_LIMIT_MAX = "1000000";
  resetEnvCache();
  const app = createApp();
  edgeServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  const address = edgeServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  edgeUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.ADMIN_RATE_LIMIT_MAX;
  resetEnvCache();
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${edgeUrl}/api/v1/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const lastCore = () => {
  const request = core.requests.at(-1);
  const raw = request?.body.toString("utf8") ?? "";
  return {
    method: request?.method,
    url: request?.url,
    body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
};

interface ReadRoute {
  path: string;
  core: string;
  /** Authority that must be sufficient on its own (any-of member of the core guard). */
  authority: string;
}

const READ_ROUTES: ReadRoute[] = [
  { path: "/wallets", core: "/internal/admin/wallets", authority: "merchant:read" },
  { path: "/wallets/summary", core: "/internal/admin/wallets/summary", authority: "merchant:read" },
  { path: `/wallets/${ID}`, core: `/internal/admin/wallets/${ID}`, authority: "merchant:read" },
  { path: "/applications", core: "/internal/admin/applications", authority: "merchant:read" },
  { path: "/applications/summary", core: "/internal/admin/applications/summary", authority: "merchant:read" },
  { path: `/applications/${ID}`, core: `/internal/admin/applications/${ID}`, authority: "merchant:read" },
  { path: "/payment-links", core: "/internal/admin/payment-links", authority: "merchant:read" },
  { path: "/pos-terminals", core: "/internal/admin/pos-terminals", authority: "merchant:read" },
  { path: `/merchants/${ID}/beneficial-owners`, core: `/internal/admin/merchants/${ID}/beneficial-owners`, authority: "merchant:read" },
  { path: "/transactions", core: "/internal/admin/transactions", authority: "attempt:read" },
  { path: "/transactions", core: "/internal/admin/transactions", authority: "merchant:read" },
  { path: "/transactions", core: "/internal/admin/transactions", authority: "finance:read" },
  { path: "/transactions/summary", core: "/internal/admin/transactions/summary", authority: "attempt:read" },
  { path: "/inbound-events", core: "/internal/admin/inbound-events", authority: "attempt:read" },
  { path: "/inbound-events", core: "/internal/admin/inbound-events", authority: "case:read" },
  { path: `/inbound-events/${ID}`, core: `/internal/admin/inbound-events/${ID}`, authority: "case:read" },
  { path: "/finance/journal-entries", core: "/internal/admin/finance/journal-entries", authority: "finance:read" },
  { path: "/finance/journal-entries/summary", core: "/internal/admin/finance/journal-entries/summary", authority: "finance:read" },
  { path: `/finance/journal-entries/${ID}`, core: `/internal/admin/finance/journal-entries/${ID}`, authority: "finance:read" },
  { path: `/finance/gl-accounts/${ID}`, core: `/internal/admin/finance/gl-accounts/${ID}`, authority: "finance:read" },
  { path: "/finance/route-caps", core: "/internal/admin/finance/route-caps", authority: "finance:read" },
  { path: `/gateways/${ID}/health`, core: `/internal/admin/gateways/${ID}/health`, authority: "gateway:read" },
  { path: "/system/jobs-outbox/summary", core: "/internal/admin/system/jobs-outbox/summary", authority: "security:read" },
  { path: "/system/jobs", core: "/internal/admin/system/jobs", authority: "security:read" },
  { path: "/system/outbox", core: "/internal/admin/system/outbox", authority: "security:read" },
  { path: "/system/audit-outbox", core: "/internal/admin/system/audit-outbox", authority: "security:read" },
  { path: "/system/notifications", core: "/internal/admin/system/notifications", authority: "security:read" },
  { path: "/settings/notification-templates", core: "/internal/admin/settings/notification-templates", authority: "settings:read" },
];

describe("new admin read routes", () => {
  for (const route of READ_ROUTES) {
    test(`GET ${route.path} forwards with ${route.authority} and is denied without any authority`, async () => {
      const allowed = await call("GET", route.path, tokenWith(route.authority));
      expect(allowed.status).toBe(200);
      expect(lastCore()).toMatchObject({ method: "GET", url: route.core });

      const before = core.requests.length;
      const denied = await call("GET", route.path, nobody);
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { code: string }).code).toBe("EDGE_AUTHORITY_DENIED");
      expect(core.requests.length).toBe(before);
    });
  }

  test("list filters reach core as a query string", async () => {
    const response = await call(
      "GET",
      "/transactions?status=FAILED&currency=LYD&page=2&pageSize=25&search=abc",
      staff,
    );
    expect(response.status).toBe(200);
    const url = lastCore().url ?? "";
    expect(url.startsWith("/internal/admin/transactions?")).toBe(true);
    for (const part of ["status=FAILED", "currency=LYD", "page=2", "pageSize=25", "search=abc"]) {
      expect(url).toContain(part);
    }
  });

  test("an out of range page is refused before core", async () => {
    const before = core.requests.length;
    const response = await call("GET", "/wallets?pageSize=5000", staff);
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("detail ids must be uuids", async () => {
    const before = core.requests.length;
    for (const path of ["/wallets/not-a-uuid", "/applications/x", "/inbound-events/1", "/finance/journal-entries/abc"]) {
      expect((await call("GET", path, staff)).status).toBe(400);
    }
    expect(core.requests.length).toBe(before);
  });

  test("the outbox is a monitor only: there is no retry route", async () => {
    const response = await call("POST", `/system/outbox/${ID}/retry`, staff, { reason: REASON });
    expect(response.status).toBe(404);
  });

  test("journal entries are read only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await call(method, `/finance/journal-entries/${ID}`, staff, {});
      expect(response.status).toBe(404);
    }
  });
});

interface WriteRoute {
  name: string;
  method: string;
  path: string;
  core: string;
  body?: Record<string, unknown>;
  /** Authority that satisfies the guard on its own. */
  authority: string;
  /** A read-only authority that must NOT be enough. */
  readOnly: string;
}

const WRITE_ROUTES: WriteRoute[] = [
  { name: "wallet freeze", method: "POST", path: `/wallets/${ID}/status`, core: `/internal/admin/wallets/${ID}/status`, body: { status: "FROZEN", reason: REASON }, authority: "merchant:write", readOnly: "merchant:read" },
  { name: "application suspend", method: "PATCH", path: `/applications/${ID}`, core: `/internal/admin/applications/${ID}`, body: { status: "SUSPENDED", reason: REASON }, authority: "merchant:write", readOnly: "merchant:read" },
  { name: "token revoke", method: "POST", path: `/applications/${ID}/tokens/${TOKEN_ID}/revoke`, core: `/internal/admin/applications/${ID}/tokens/${TOKEN_ID}/revoke`, body: { reason: REASON }, authority: "merchant:write", readOnly: "merchant:read" },
  { name: "payment link cancel", method: "POST", path: `/payment-links/${ID}/state`, core: `/internal/admin/payment-links/${ID}/state`, body: { state: "CANCELLED", reason: REASON }, authority: "merchant:write", readOnly: "merchant:read" },
  { name: "pos block", method: "POST", path: `/pos-terminals/${ID}/status`, core: `/internal/admin/pos-terminals/${ID}/status`, body: { status: "BLOCKED", reason: REASON }, authority: "merchant:write", readOnly: "merchant:read" },
  { name: "gl checkpoint", method: "POST", path: `/finance/gl-accounts/${ID}/checkpoint`, core: `/internal/admin/finance/gl-accounts/${ID}/checkpoint`, body: { reason: REASON }, authority: "finance:write", readOnly: "finance:read" },
  { name: "job requeue", method: "POST", path: `/system/jobs/${ID}/requeue`, core: `/internal/admin/system/jobs/${ID}/requeue`, body: { reason: REASON }, authority: "security:write", readOnly: "security:read" },
  { name: "notification retry", method: "POST", path: `/system/notifications/${ID}/retry`, core: `/internal/admin/system/notifications/${ID}/retry`, body: { reason: REASON }, authority: "security:write", readOnly: "security:read" },
  { name: "template edit", method: "PUT", path: `/settings/notification-templates/${ID}`, core: `/internal/admin/settings/notification-templates/${ID}`, body: { subjectTemplate: "Hello {{name}}", bodyTemplate: "Hi {{name}}" }, authority: "settings:write", readOnly: "settings:read" },
  { name: "owner create", method: "POST", path: `/merchants/${ID}/beneficial-owners`, core: `/internal/admin/merchants/${ID}/beneficial-owners`, body: { fullName: "Amal Hassan", identityType: "NATIONAL_ID", identityNumber: "119900112233" }, authority: "kyb:write", readOnly: "merchant:read" },
  { name: "owner edit", method: "PATCH", path: `/merchants/${ID}/beneficial-owners/${OWNER_ID}`, core: `/internal/admin/merchants/${ID}/beneficial-owners/${OWNER_ID}`, body: { ownershipPercent: "30" }, authority: "kyb:write", readOnly: "merchant:read" },
  { name: "owner deactivate", method: "DELETE", path: `/merchants/${ID}/beneficial-owners/${OWNER_ID}`, core: `/internal/admin/merchants/${ID}/beneficial-owners/${OWNER_ID}`, authority: "merchant:write", readOnly: "merchant:read" },
  { name: "revalidation request", method: "POST", path: `/merchants/${ID}/revalidations`, core: `/internal/admin/merchants/${ID}/revalidations`, body: { docType: "COMMERCIAL_REGISTRY", dueAt: "2026-12-31", message: "Please upload a fresh copy" }, authority: "kyb:write", readOnly: "kyb:read" },
];

describe("new admin mutation routes", () => {
  for (const route of WRITE_ROUTES) {
    test(`${route.name}: forwards to core, needs ${route.authority}`, async () => {
      const response = await call(route.method, route.path, tokenWith(route.authority), route.body);
      expect(response.status).toBeLessThan(300);
      expect(lastCore()).toMatchObject({ method: route.method, url: route.core });
      if (route.body !== undefined) expect(lastCore().body).toEqual(route.body);

      const before = core.requests.length;
      const readOnly = await call(route.method, route.path, tokenWith(route.readOnly), route.body);
      expect(readOnly.status).toBe(403);
      const none = await call(route.method, route.path, nobody, route.body);
      expect(none.status).toBe(403);
      expect(core.requests.length).toBe(before);
    });
  }

  const REASON_ROUTES = WRITE_ROUTES.filter((route) => route.body && "reason" in route.body);
  for (const route of REASON_ROUTES) {
    test(`${route.name}: rejects a short reason, an unknown key and a missing reason before core`, async () => {
      const before = core.requests.length;
      const tooShort = await call(route.method, route.path, staff, { ...route.body, reason: "short" });
      expect(tooShort.status).toBe(400);
      const blank = await call(route.method, route.path, staff, { ...route.body, reason: "         x " });
      expect(blank.status).toBe(400);
      const unknown = await call(route.method, route.path, staff, { ...route.body, surprise: true });
      expect(unknown.status).toBe(400);
      expect(((await unknown.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
      const { reason: _reason, ...withoutReason } = route.body ?? {};
      const missing = await call(route.method, route.path, staff, withoutReason);
      expect(missing.status).toBe(400);
      expect(core.requests.length).toBe(before);
    });
  }

  test("mutation route ids must be uuids", async () => {
    const before = core.requests.length;
    const bad = await call("POST", "/wallets/not-a-uuid/status", staff, { status: "FROZEN", reason: REASON });
    expect(bad.status).toBe(400);
    const badToken = await call("POST", `/applications/${ID}/tokens/nope/revoke`, staff, { reason: REASON });
    expect(badToken.status).toBe(400);
    const badOwner = await call("DELETE", `/merchants/${ID}/beneficial-owners/nope`, staff);
    expect(badOwner.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });
});

describe("new admin mutation enums and shapes", () => {
  const rejected = async (method: string, path: string, body: unknown) => {
    const before = core.requests.length;
    const response = await call(method, path, staff, body);
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  };

  test("wallet status only accepts FROZEN or ACTIVE", async () => {
    for (const status of ["CLOSED", "PENDING", "frozen", ""]) {
      await rejected("POST", `/wallets/${ID}/status`, { status, reason: REASON });
    }
    await rejected("POST", `/wallets/${ID}/status`, { reason: REASON });
  });

  test("application patch only accepts SUSPENDED or ACTIVE and needs at least one change", async () => {
    await rejected("PATCH", `/applications/${ID}`, { status: "FROZEN", reason: REASON });
    await rejected("PATCH", `/applications/${ID}`, { status: "CLOSED", reason: REASON });
    await rejected("PATCH", `/applications/${ID}`, { reason: REASON });
    await rejected("PATCH", `/applications/${ID}`, { assignedWalletId: "not-a-uuid", reason: REASON });
    await rejected("PATCH", `/applications/${ID}`, { railWhitelist: "ALL", reason: REASON });
    await rejected("PATCH", `/applications/${ID}`, { redirectDomainAllowlist: [""], reason: REASON });
  });

  test("application patch forwards the whitelist edit, including a null whitelist, as one approval", async () => {
    const edit = await call("PATCH", `/applications/${ID}`, staff, {
      railWhitelist: ["libyana_pay", "madar"],
      redirectDomainAllowlist: ["https://shop.example.ly"],
      assignedWalletId: OWNER_ID,
      reason: REASON,
    });
    expect(edit.status).toBe(202);
    expect(lastCore().body).toEqual({
      railWhitelist: ["libyana_pay", "madar"],
      redirectDomainAllowlist: ["https://shop.example.ly"],
      assignedWalletId: OWNER_ID,
      reason: REASON,
    });
    const cleared = await call("PATCH", `/applications/${ID}`, staff, { railWhitelist: null, reason: REASON });
    expect(cleared.status).toBe(202);
    expect(lastCore().body).toEqual({ railWhitelist: null, reason: REASON });
  });

  test("payment link state only accepts CANCELLED", async () => {
    for (const state of ["ACTIVE", "PENDING", "EXPIRED", "COMPLETED"]) {
      await rejected("POST", `/payment-links/${ID}/state`, { state, reason: REASON });
    }
  });

  test("pos status only accepts INACTIVE, BLOCKED or ACTIVE", async () => {
    for (const status of ["DISABLED", "SUSPENDED", "CLOSED"]) {
      await rejected("POST", `/pos-terminals/${ID}/status`, { status, reason: REASON });
    }
  });

  test("owner and revalidation bodies are strict", async () => {
    await rejected("POST", `/merchants/${ID}/beneficial-owners`, { fullName: "Amal Hassan", identityType: "VISA", identityNumber: "119900112233" });
    await rejected("POST", `/merchants/${ID}/beneficial-owners`, { fullName: "Amal Hassan", identityType: "PASSPORT", identityNumber: "A1234567", nationalIdHash: "x" });
    await rejected("PATCH", `/merchants/${ID}/beneficial-owners/${OWNER_ID}`, {});
    await rejected("POST", `/merchants/${ID}/revalidations`, { docType: "SELFIE", dueAt: "2026-12-31", message: "Please upload" });
    await rejected("POST", `/merchants/${ID}/revalidations`, { docType: "OTHER", message: "Please upload" });
  });

  test("notification template edit needs a body and a known confidentiality class", async () => {
    await rejected("PUT", `/settings/notification-templates/${ID}`, { subjectTemplate: "x" });
    await rejected("PUT", `/settings/notification-templates/${ID}`, { bodyTemplate: "x", confidentialityClass: "SECRET" });
    await rejected("PUT", `/settings/notification-templates/${ID}`, { bodyTemplate: "x", code: "OTP" });
  });
});

describe("approval statuses are relayed", () => {
  test("unfreezing a wallet is an approval: 202 passes through, freezing stays 200", async () => {
    const approval = await call("POST", `/wallets/${ID}/status`, staff, { status: "ACTIVE", reason: REASON });
    expect(approval.status).toBe(202);
    expect(((await approval.json()) as { jobId?: string }).jobId).toBe("job-1");
    const freeze = await call("POST", `/wallets/${ID}/status`, staff, { status: "FROZEN", reason: REASON });
    expect(freeze.status).toBe(200);
  });

  test("re-activating a POS terminal is an approval, blocking is immediate", async () => {
    const approval = await call("POST", `/pos-terminals/${ID}/status`, staff, { status: "ACTIVE", reason: REASON });
    expect(approval.status).toBe(202);
    for (const status of ["INACTIVE", "BLOCKED"]) {
      const immediate = await call("POST", `/pos-terminals/${ID}/status`, staff, { status, reason: REASON });
      expect(immediate.status).toBe(200);
    }
  });

  test("re-activating an application is an approval, suspending alone is immediate", async () => {
    const approval = await call("PATCH", `/applications/${ID}`, staff, { status: "ACTIVE", reason: REASON });
    expect(approval.status).toBe(202);
    const suspend = await call("PATCH", `/applications/${ID}`, staff, { status: "SUSPENDED", reason: REASON });
    expect(suspend.status).toBe(200);
  });

  test("promoting an aml reporting rule relays the accepted status of core", async () => {
    const response = await call(
      "POST",
      `/aml/reporting-rules/${ID}/promote`,
      tokenWith("aml:write"),
      {},
    );
    expect(lastCore()).toMatchObject({ method: "POST", url: `/internal/admin/aml/reporting-rules/${ID}/promote` });
    expect(response.status).toBe(200);
  });
});

describe("authority any-of lists mirror core", () => {
  test("kyb:write alone can manage owners and revalidations, merchant:write alone too", async () => {
    for (const authority of ["kyb:write", "merchant:write"]) {
      const response = await call("POST", `/merchants/${ID}/revalidations`, tokenWith(authority), {
        docType: "OTHER",
        dueAt: "2026-12-31",
        message: "Please upload a fresh copy",
      });
      expect(response.status).toBe(200);
    }
  });

  test("kyb:write does not unlock the rest of the merchant mount", async () => {
    const before = core.requests.length;
    const response = await call("POST", `/merchants/${ID}/suspend`, tokenWith("kyb:write"), { reasonCode: "FRAUD" });
    expect(response.status).toBe(403);
    expect(core.requests.length).toBe(before);
  });

  test("operations:* and system:* authorities do not exist and unlock nothing", async () => {
    const before = core.requests.length;
    for (const path of ["/system/jobs", "/transactions", "/wallets", "/inbound-events"]) {
      const response = await call("GET", path, tokenWith("operations:read", "system:read", "operations:write", "system:write"));
      expect(response.status).toBe(403);
    }
    expect(core.requests.length).toBe(before);
  });

  test("security:read cannot requeue or retry; finance:read cannot checkpoint", async () => {
    const before = core.requests.length;
    const read = tokenWith("security:read", "finance:read");
    expect((await call("POST", `/system/jobs/${ID}/requeue`, read, { reason: REASON })).status).toBe(403);
    expect((await call("POST", `/system/notifications/${ID}/retry`, read, { reason: REASON })).status).toBe(403);
    expect((await call("POST", `/finance/gl-accounts/${ID}/checkpoint`, read, { reason: REASON })).status).toBe(403);
    expect(core.requests.length).toBe(before);
  });

  test("requires a session", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/admin/wallets`);
    expect(response.status).toBe(401);
  });
});
