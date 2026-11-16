import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { fullStaffToken, signSession } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back-report-engine");
const core: TestCore = await startTestCore(pki);

const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.CORE_BACK_URLS = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";
  edgeServer = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  const address = edgeServer.address();
  edgeUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  delete process.env.CORE_BACK_URLS; // CLEANUP_CORE_BACK_URLS

  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});

const runOnlyToken = (): string =>
  signSession({
    sub: "u-report-runner",
    role: "SUPPORT",
    authorities: ["report_engine:run"],
  });

const request = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${edgeUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("report-engine edge remediation", () => {
  test("B08: the publish route is proxied to core", async () => {
    const before = core.requests.length;
    const response = await request(
      "POST",
      "/api/v1/admin/report-engine/specs/11111111-1111-4111-8111-111111111111/publish",
      fullStaffToken(),
      {},
    );
    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(403);
    expect(core.requests.length).toBe(before + 1);
    expect(core.requests.at(-1)?.url).toBe(
      "/internal/admin/report-engine/specs/11111111-1111-4111-8111-111111111111/publish",
    );
  });

  test("B03: a report_engine:run principal may execute a report", async () => {
    const before = core.requests.length;
    const response = await request(
      "POST",
      "/api/v1/admin/report-engine/catalog/merchant-settlement-summary/execute",
      runOnlyToken(),
      { inputs: {} },
    );
    expect(response.status).toBe(200);
    expect(core.requests.length).toBe(before + 1);
  });

  test("B03: a report_engine:run principal may list the catalog", async () => {
    const response = await request(
      "GET",
      "/api/v1/admin/report-engine/catalog",
      runOnlyToken(),
    );
    expect(response.status).toBe(200);
  });

  test("B02: a report-engine body above the global 4 MB cap is parsed and forwarded", async () => {
    const before = core.requests.length;
    const bigSpec = "x".repeat(5 * 1024 * 1024);
    const response = await request(
      "POST",
      "/api/v1/admin/report-engine/specs/verify",
      fullStaffToken(),
      { specJson: bigSpec },
    );
    expect(response.status).toBe(200);
    expect(core.requests.length).toBe(before + 1);
    const forwarded = core.requests.at(-1)!;
    expect(forwarded.body.byteLength).toBeGreaterThan(5 * 1024 * 1024);
  });
});

describe("merchant reporting oversight forwarding", () => {
  test("lists merchant reports and forwards tenant search/paging", async () => {
    const response = await request(
      "GET",
      "/api/v1/admin/report-engine/merchant-reports?page=2&pageSize=10&search=acme",
      fullStaffToken(),
    );
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toContain("/internal/admin/report-engine/merchant-reports");
    expect(core.requests.at(-1)?.url).toContain("page=2");
  });

  test("suspends and resumes a merchant Studio", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const suspend = await request(
      "POST",
      `/api/v1/admin/report-engine/merchant-reports/${id}/suspend`,
      fullStaffToken(),
      { reason: "review required" },
    );
    expect(suspend.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe(`/internal/admin/report-engine/merchant-reports/${id}/suspend`);
    const resume = await request(
      "POST",
      `/api/v1/admin/report-engine/merchant-reports/${id}/resume`,
      fullStaffToken(),
      {},
    );
    expect(resume.status).toBe(200);
  });
});

describe("migration and chrome forwarding", () => {
  test("forwards report needs-migration and prompt routes", async () => {
    const list = await request(
      "GET",
      "/api/v1/admin/report-engine/specs/needs-migration?source=ALL&page=2&pageSize=5&search=ledger",
      fullStaffToken(),
    );
    expect(list.status).toBe(200);
    expect(core.requests.at(-1)?.url).toContain("/internal/admin/report-engine/specs/needs-migration");
    expect(core.requests.at(-1)?.url).toContain("page=2");
    expect(core.requests.at(-1)?.url).toContain("pageSize=5");
    expect(core.requests.at(-1)?.url).toContain("search=ledger");
    const id = "11111111-1111-4111-8111-111111111111";
    const prompt = await request("GET", `/api/v1/admin/report-engine/specs/${id}/migration-prompt`, fullStaffToken());
    expect(prompt.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe(`/internal/admin/report-engine/specs/${id}/migration-prompt`);
  });

  test("forwards chrome migration, reconciliation and merchant prompt routes", async () => {
    const list = await request(
      "GET",
      "/api/v1/admin/report-engine/chrome/needs-migration?page=2&pageSize=5&search=header",
      fullStaffToken(),
    );
    expect(list.status).toBe(200);
    expect(core.requests.at(-1)?.url).toContain("/internal/admin/report-engine/chrome/needs-migration");
    expect(core.requests.at(-1)?.url).toContain("page=2");
    expect(core.requests.at(-1)?.url).toContain("pageSize=5");
    expect(core.requests.at(-1)?.url).toContain("search=header");
    const chromeDetail = await request(
      "GET",
      "/api/v1/admin/report-engine/chrome/11111111-1111-4111-8111-111111111111",
      fullStaffToken(),
    );
    expect(chromeDetail.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe(
      "/internal/admin/report-engine/chrome/11111111-1111-4111-8111-111111111111",
    );
    const reconcile = await request("POST", "/api/v1/admin/report-engine/chrome/reconcile-defaults", fullStaffToken(), {});
    expect(reconcile.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/report-engine/chrome/reconcile-defaults");
    const id = "11111111-1111-4111-8111-111111111111";
    const merchantPrompt = await request(
      "GET",
      `/api/v1/admin/report-engine/merchant-reports/${id}/migration-prompt`,
      fullStaffToken(),
    );
    expect(merchantPrompt.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe(`/internal/admin/report-engine/merchant-reports/${id}/migration-prompt`);
  });
});
