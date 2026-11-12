import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { signSession } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back-object-storage");
const core: TestCore = await startTestCore(pki);
const { createApp } = await import("../index");

let edgeUrl = "";
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const storageToken = (): string =>
  signSession({
    sub: "u-storage",
    role: "SECURITY_ADMIN",
    authorities: ["system:storage:read", "system:storage:admin", "system:storage:legal-hold"],
  });

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
  delete process.env.CORE_BACK_URLS;
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});

const request = (method: string, path: string, body?: unknown) =>
  fetch(`${edgeUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${storageToken()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("admin object-storage BFF", () => {
  test("forwards every object-list filter, page, sort and search parameter", async () => {
    const before = core.requests.length;
    const owner = "11111111-1111-4111-8111-111111111111";
    const sha = "a".repeat(64);
    const response = await request(
      "GET",
      `/api/v1/admin/object-storage/objects?page=2&pageSize=50&namespace=KYB_DOCUMENTS&status=ACTIVE&bucket=HOT&ownerMerchantId=${owner}&legalHold=true&sha256Hex=${sha}&search=invoice&sortKey=createdAt&sortDirection=asc`,
    );
    expect(response.status).toBe(200);
    expect(core.requests.length).toBe(before + 1);
    const forwarded = core.requests.at(-1)!;
    expect(forwarded.url).toContain("/internal/admin/object-storage/objects");
    expect(forwarded.url).toContain("page=2");
    expect(forwarded.url).toContain("pageSize=50");
    expect(forwarded.url).toContain("namespace=KYB_DOCUMENTS");
    expect(forwarded.url).toContain("status=ACTIVE");
    expect(forwarded.url).toContain("bucket=HOT");
    expect(forwarded.url).toContain(`ownerMerchantId=${owner}`);
    expect(forwarded.url).toContain("legalHold=true");
    expect(forwarded.url).toContain(`sha256Hex=${sha}`);
    expect(forwarded.url).toContain("search=invoice");
    expect(forwarded.url).toContain("sortKey=createdAt");
    expect(forwarded.url).toContain("sortDirection=asc");
  });

  test("forwards the quarantine status set and access-log filters", async () => {
    await request("GET", "/api/v1/admin/object-storage/objects?statuses=QUARANTINE_PENDING_AV,QUARANTINE_REJECTED");
    expect(core.requests.at(-1)?.url).toContain("statuses=QUARANTINE_PENDING_AV%2CQUARANTINE_REJECTED");

    await request("GET", "/api/v1/admin/object-storage/access-logs?allowed=false&action=READ_DENIED_AUTHORITY&objectId=11111111-1111-4111-8111-111111111111&search=denied");
    const url = core.requests.at(-1)!.url;
    expect(url).toContain("allowed=false");
    expect(url).toContain("action=READ_DENIED_AUTHORITY");
    expect(url).toContain("objectId=11111111-1111-4111-8111-111111111111");
    expect(url).toContain("search=denied");
  });

  test("a legal-hold lift is submitted instead of applied directly", async () => {
    const response = await request(
      "DELETE",
      "/api/v1/admin/object-storage/objects/11111111-1111-4111-8111-111111111111/legal-hold",
      { reason: "Court order 2026-17 is closed" },
    );
    expect([200, 202]).toContain(response.status);
    expect(core.requests.at(-1)?.url).toContain("/internal/admin/object-storage/objects/11111111-1111-4111-8111-111111111111/legal-hold");
    expect(core.requests.at(-1)?.method).toBe("DELETE");
  });
});
