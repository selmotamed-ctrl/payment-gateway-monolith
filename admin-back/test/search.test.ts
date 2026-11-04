import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { complianceToken, operatorToken } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back");
const core: TestCore = await startTestCore(pki);

const { createApp } = await import("../index");
const { resetSearchRateLimiterForTests } = await import("../api/protected/search");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
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
  resetSearchRateLimiterForTests();
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});

beforeEach(() => resetSearchRateLimiterForTests());

const search = (body: unknown, token: string) =>
  fetch(`${edgeUrl}/api/v1/admin/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("admin search BFF", () => {
  test("forwards a valid query to core with trimmed text, default limit and no-store caching", async () => {
    const before = core.requests.length;
    const response = await search({ query: "  acme  " }, complianceToken());
    expect(response.status).not.toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(core.requests.length).toBe(before + 1);
    const forwarded = core.requests.at(-1)!;
    expect(forwarded.url.split("?")[0]).toBe("/internal/admin/search");
    expect(JSON.parse(forwarded.body.toString("utf8"))).toMatchObject({ query: "acme", limit: 5 });
  });

  test.each([
    [{ query: "a" }],
    [{ query: "x".repeat(121) }],
    [{ query: "acme", limit: 11 }],
    [{ query: "acme", limit: 0 }],
    [{ query: "acme", extra: true }],
    [{ query: "acme", types: Array.from({ length: 31 }, (_, i) => `t${i}`) }],
  ])("rejects invalid body %j without calling core", async (body) => {
    const before = core.requests.length;
    const response = await search(body, complianceToken());
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("rate-limits per session after 120 requests per minute and isolates other sessions", async () => {
    const token = complianceToken();
    for (let i = 0; i < 120; i += 1) {
      const ok = await search({ query: "acme" }, token);
      expect(ok.status).not.toBe(429);
    }
    const limited = await search({ query: "acme" }, token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ code: "SEARCH_RATE_LIMITED" });

    const other = await search({ query: "acme" }, operatorToken());
    expect(other.status).not.toBe(429);
  });
});
