/**
 * AUTO-34 the merchant portal's webhook routes are forwarded to core with the exact path, method, strict body and
 * query; unknown fields never reach core; secrets are never cached; unauthenticated calls are refused.
 */
import { SESSION_BEARER } from "./helpers/session";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetEnvCache } from "../lib/env";
import { resetCoreAgent } from "../lib/mtlsClient";
import { createTestPki, startTestCore, type CoreRequestRecord, type TestCore, type TestPki } from "./helpers/core";

const pki: TestPki = createTestPki("merchant-back");
const core: TestCore = await startTestCore(pki);

resetEnvCache();
resetCoreAgent();

const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;
const auth = { authorization: SESSION_BEARER };
const forwarded = (): CoreRequestRecord | undefined => core.requests.at(-1);
const forwardedBody = (): Record<string, unknown> => JSON.parse(forwarded()?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) =>
  fetch(`${edgeUrl}/api/v1/merchant/webhooks${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
});
beforeAll(async () => {
  edgeServer = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  const address = edgeServer.address();
  edgeUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});

describe("webhook routes are forwarded to core", () => {
  test("GET /event-types and GET /endpoints (with the application filter)", async () => {
    expect((await send("GET", "/event-types")).status).toBe(200);
    expect(forwarded()).toMatchObject({ method: "GET", url: "/internal/merchant/webhooks/event-types" });
    expect((await send("GET", "/endpoints?applicationId=app_1")).status).toBe(200);
    expect(forwarded()).toMatchObject({ method: "GET", url: "/internal/merchant/webhooks/endpoints?applicationId=app_1" });
    expect((await send("GET", "/endpoints?extra=1")).status).toBe(400); // strict query
  });

  test("POST /endpoints forwards the body, answers 201 and is never cacheable", async () => {
    const response = await send("POST", "/endpoints", { applicationId: "app_1", url: "https://hooks.example.ly/pay", eventTypes: ["payment.succeeded"], description: "orders" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(forwarded()).toMatchObject({ method: "POST", url: "/internal/merchant/webhooks/endpoints" });
    expect(forwardedBody()).toEqual({ applicationId: "app_1", url: "https://hooks.example.ly/pay", eventTypes: ["payment.succeeded"], description: "orders" });
  });

  test("a body with an unknown field, a missing url or a missing application is refused at the edge", async () => {
    const before = core.requests.length;
    for (const body of [
      { applicationId: "app_1", url: "https://hooks.example.ly/x", secret: "whsec_mine" },
      { applicationId: "app_1" },
      { url: "https://hooks.example.ly/x" },
      { applicationId: "app_1", url: "https://hooks.example.ly/x", eventTypes: Array.from({ length: 33 }, (_, i) => `e${i}`) },
    ]) {
      expect((await send("POST", "/endpoints", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(core.requests.length).toBe(before);
  });

  test("PATCH /endpoints/:id, rotate-secret and test are forwarded with the id in the path", async () => {
    expect((await send("PATCH", "/endpoints/ep_1", { enabled: false, description: null })).status).toBe(200);
    expect(forwarded()).toMatchObject({ method: "PATCH", url: "/internal/merchant/webhooks/endpoints/ep_1" });
    expect(forwardedBody()).toEqual({ enabled: false, description: null });
    expect((await send("PATCH", "/endpoints/ep_1", { applicationId: "app_2" })).status).toBe(400); // the application cannot be changed

    const rotated = await send("POST", "/endpoints/ep_1/rotate-secret", {});
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    expect(forwarded()).toMatchObject({ method: "POST", url: "/internal/merchant/webhooks/endpoints/ep_1/rotate-secret" });
    expect((await send("POST", "/endpoints/ep_1/rotate-secret", { sneaky: 1 })).status).toBe(400);

    expect((await send("POST", "/endpoints/ep_1/test", {})).status).toBe(202);
    expect(forwarded()).toMatchObject({ method: "POST", url: "/internal/merchant/webhooks/endpoints/ep_1/test" });
  });

  test("GET /deliveries forwards its filters; POST /deliveries/:id/redeliver answers 202", async () => {
    expect((await send("GET", "/deliveries?endpointId=ep_1&status=PARKED&limit=20")).status).toBe(200);
    const url = new URL(`http://x${forwarded()!.url}`);
    expect(url.pathname).toBe("/internal/merchant/webhooks/deliveries");
    expect(Object.fromEntries(url.searchParams)).toEqual({ endpointId: "ep_1", status: "PARKED", limit: "20" });
    expect((await send("GET", "/deliveries?status=LOST")).status).toBe(400);
    expect((await send("GET", "/deliveries?limit=1000")).status).toBe(400);
    expect((await send("POST", "/deliveries/dl_1/redeliver", {})).status).toBe(202);
    expect(forwarded()).toMatchObject({ method: "POST", url: "/internal/merchant/webhooks/deliveries/dl_1/redeliver" });
  });

  test("every webhook route needs a session", async () => {
    const before = core.requests.length;
    for (const [method, path] of [["GET", "/endpoints"], ["POST", "/endpoints"], ["PATCH", "/endpoints/ep_1"], ["POST", "/endpoints/ep_1/rotate-secret"], ["GET", "/deliveries"], ["POST", "/deliveries/dl_1/redeliver"]] as const) {
      const response = await send(method, path, method === "GET" ? undefined : {}, {});
      expect([method, path, response.status]).toEqual([method, path, 401]);
    }
    expect(core.requests.length).toBe(before);
  });
});
