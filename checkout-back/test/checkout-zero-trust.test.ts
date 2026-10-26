import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";

const pki: TestPki = createTestPki();
const core: TestCore = await startTestCore(pki);

process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = core.url;
process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
process.env.MTLS_CA_CERT_PATH = pki.caCert;

const { createApp } = await import("../index");
const { pickForwardableHeaders, translateInboundEnvironment } = await import("../api/public/inbound");
const { translateClientEvent } = await import("../lib/zReady");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const post = (path: string, body: unknown) =>
  fetch(`${edgeUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

describe("checkout zero-trust boundary", () => {
  test("rejects an amount supplied on initiate without touching core", async () => {
    const before = core.requests.length;
    const response = await post("/api/v1/pay/LNKTESTKEY1/initiate", {
      railCode: "MOAMALAT",
      formData: { phone: "0912345678" },
      idempotencyKey: "idem-00000001",
      amount: "250.0000",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string; message: string };
    expect(payload.code).toBe("AMOUNT_NOT_ACCEPTED");
    expect(core.requests.length).toBe(before);
  });

  test("rejects a currency supplied on initiate", async () => {
    const before = core.requests.length;
    const response = await post("/api/v1/pay/LNKTESTKEY1/initiate", {
      railCode: "MOAMALAT",
      formData: {},
      idempotencyKey: "idem-00000002",
      currency: "LYD",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AMOUNT_NOT_ACCEPTED");
    expect(core.requests.length).toBe(before);
  });

  test("rejects an amount nested inside the customer form data", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/initiate", {
      railCode: "MOAMALAT",
      formData: { phone: "0912345678", amount: "10" },
      idempotencyKey: "idem-00000003",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string; details?: { field?: string } };
    expect(payload.code).toBe("AMOUNT_NOT_ACCEPTED");
    expect(payload.details?.field).toBe("formData.amount");
  });

  test("rejects an amount supplied on confirm", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/confirm", {
      otp: "1234",
      idempotencyKey: "idem-00000004",
      amount: "10.0000",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AMOUNT_NOT_ACCEPTED");
  });

  test("forwards a compliant initiate and never transmits amount or currency", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/initiate", {
      railCode: "MOAMALAT",
      formData: { phone: "0912345678" },
      idempotencyKey: "idem-00000005",
    });
    expect(response.status).toBe(201);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.url).toBe("/internal/checkout/pay/LNKTESTKEY1/initiate");
    const sent = JSON.parse(forwarded?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect(sent).not.toHaveProperty("amount");
    expect(sent).not.toHaveProperty("currency");
    expect(sent.railCode).toBe("MOAMALAT");
    expect(forwarded?.headers["x-edge-service"]).toBe("checkout-back");
    expect(String(forwarded?.headers["x-request-id"])).toHaveLength(36);
  });

  test("rejects unknown request fields with a validation failure", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/initiate", {
      railCode: "MOAMALAT",
      formData: {},
      idempotencyKey: "idem-00000006",
      extra: true,
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("VALIDATION_FAILED");
  });

  test("resolves a link without accepting client money", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/pay/LNKTESTKEY1`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { currency: string };
    expect(payload.currency).toBe("LYD");
    expect(core.requests.at(-1)?.url).toBe("/internal/checkout/pay/LNKTESTKEY1");
  });
});

describe("checkout realtime and webhook proxying", () => {
  test("streams the attempt status without buffering", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/pay/LNKTESTKEY1/logs/att_test_1/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("VERIFYING");
  });

  test("forwards the raw inbound webhook body byte for byte", async () => {
    const raw = "{\"event\":\"paid\",\"amount\":\"100.0000\"}";
    const response = await fetch(`${edgeUrl}/api/v1/inbound/moamalat/live/abc123token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-signature": "sig-123" },
      body: raw,
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/checkout/inbound/moamalat/LIVE/abc123token");
    expect(forwarded?.body.toString("utf8")).toBe(raw);
    expect(forwarded?.headers["x-gateway-signature"]).toBe("sig-123");
    expect(forwarded?.headers["content-type"]).toBe("application/json");
    expect(forwarded?.headers["content-length"]).toBe(String(Buffer.byteLength(raw)));
  });

  test("redirects a browser return to the hosted checkout receipt", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/return/attempttoken123`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/pay/status");
    expect(location).toContain("attempt_token=attempttoken123");
    expect(location).toContain("reference=REF-RETURN-1");
    expect(core.requests.at(-1)?.url).toBe("/internal/checkout/return/attempttoken123");
  });

  test("rejects an inbound webhook with an unknown environment segment", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/inbound/moamalat/staging/abc123token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("VALIDATION_FAILED");
  });

  test("maps a core failure into the stable envelope", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/pay/LNKMISSING1`);
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { code: string; message: string };
    expect(payload.code).toBe("LINK_NOT_FOUND");
    expect(payload.message).toBe("payment link not found");
  });
});

describe("edge to core contract alignment", () => {
  test("maps every legacy client event alias onto a canonical core event", () => {
    expect(translateClientEvent("completeCallback")).toBe("completeCallback");
    expect(translateClientEvent("errorCallback")).toBe("errorCallback");
    expect(translateClientEvent("widgetEvent")).toBe("widgetEvent");
    expect(translateClientEvent("returnHint")).toBe("returnHint");
    expect(translateClientEvent("COMPLETE_CALLBACK")).toBe("completeCallback");
    expect(translateClientEvent("complete-callback")).toBe("completeCallback");
    expect(translateClientEvent("complete_callback")).toBe("completeCallback");
    expect(translateClientEvent("ERROR_CALLBACK")).toBe("errorCallback");
    expect(translateClientEvent("error-callback")).toBe("errorCallback");
    expect(translateClientEvent("CANCEL_CALLBACK")).toBe("errorCallback");
    expect(translateClientEvent("cancel-callback")).toBe("errorCallback");
    expect(translateClientEvent("WIDGET_READY")).toBe("widgetEvent");
    expect(translateClientEvent("widget-ready")).toBe("widgetEvent");
    expect(translateClientEvent("WIDGET_CLOSED")).toBe("widgetEvent");
    expect(translateClientEvent("widget-closed")).toBe("widgetEvent");
    expect(translateClientEvent("NOT_AN_EVENT")).toBeUndefined();
  });

  test("forwards a legacy client event alias as the canonical core event", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event", {
      event: "COMPLETE_CALLBACK",
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/checkout/pay/LNKTESTKEY1/logs/att_test_1/client-event");
    const sent = JSON.parse(forwarded?.body.toString("utf8") ?? "{}") as { event?: string };
    expect(sent.event).toBe("completeCallback");
  });

  test("forwards a kebab case client event alias as the canonical core event", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event", {
      event: "widget-closed",
    });
    expect(response.status).toBe(200);
    const sent = JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}") as {
      event?: string;
    };
    expect(sent.event).toBe("widgetEvent");
  });

  test("forwards a canonical client event unchanged", async () => {
    const response = await post("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event", {
      event: "returnHint",
    });
    expect(response.status).toBe(200);
    const sent = JSON.parse(core.requests.at(-1)?.body.toString("utf8") ?? "{}") as {
      event?: string;
    };
    expect(sent.event).toBe("returnHint");
  });

  test("rejects an unsupported client event without touching core", async () => {
    const before = core.requests.length;
    const response = await post("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event", {
      event: "NOT_AN_EVENT",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("VALIDATION_FAILED");
    expect(core.requests.length).toBe(before);
  });

  test("maps the friendly inbound environments onto the canonical core pair", () => {
    expect(translateInboundEnvironment("sandbox")).toBe("SANDBOX");
    expect(translateInboundEnvironment("test")).toBe("SANDBOX");
    expect(translateInboundEnvironment("uat")).toBe("SANDBOX");
    expect(translateInboundEnvironment("live")).toBe("LIVE");
    expect(translateInboundEnvironment("production")).toBe("LIVE");
  });

  test("forwards a sandbox alias as the canonical sandbox environment", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/inbound/moamalat/test/abc123token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/checkout/inbound/moamalat/SANDBOX/abc123token");
  });

  test("forwards a uat alias as the canonical sandbox environment", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/inbound/moamalat/uat/abc123token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/checkout/inbound/moamalat/SANDBOX/abc123token");
  });

  test("forwards a production alias as the canonical live environment", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/inbound/moamalat/production/abc123token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/checkout/inbound/moamalat/LIVE/abc123token");
  });

  test("keeps only the allowlisted inbound headers", () => {
    const forwarded = pickForwardableHeaders({
      "content-type": "application/json",
      "user-agent": "gateway-agent/1.0",
      "content-length": "12",
      "x-signature": "sig-1",
      "x-gateway-signature": "sig-2",
      "x-hub-signature-256": "sha256=sig-3",
      "x-moomalat-signature": "sig-4",
      "x-timestamp": "1700000000",
      "x-nonce": "nonce-1",
      authorization: "Bearer super-secret",
      cookie: "session=super-secret",
      "x-user-id": "user-42",
      "x-authorities": "MERCHANT_ADMIN",
      "x-roles": "MERCHANT_ADMIN",
      "x-forwarded-for": "203.0.113.9",
      "x-request-id": "spoofed-request-id",
      "x-real-client-ip": "203.0.113.9",
      host: "pay.example.com",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    });
    expect(forwarded).toEqual({
      "content-type": "application/json",
      "user-agent": "gateway-agent/1.0",
      "content-length": "12",
      "x-signature": "sig-1",
      "x-gateway-signature": "sig-2",
      "x-hub-signature-256": "sha256=sig-3",
      "x-moomalat-signature": "sig-4",
      "x-timestamp": "1700000000",
      "x-nonce": "nonce-1",
    });
  });

  test("never forwards inbound credentials or identity headers to core", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/inbound/moamalat/live/abc123token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer super-secret",
        cookie: "session=super-secret",
        "x-user-id": "user-42",
        "x-authorities": "MERCHANT_ADMIN",
        "x-roles": "MERCHANT_ADMIN",
        "x-signature": "sig-allow",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.headers.cookie).toBeUndefined();
    expect(forwarded?.headers["x-user-id"]).toBeUndefined();
    expect(forwarded?.headers["x-authorities"]).toBeUndefined();
    expect(forwarded?.headers["x-roles"]).toBeUndefined();
    expect(forwarded?.headers["x-signature"]).toBe("sig-allow");
  });
});
