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
    expect(forwarded?.url).toBe("/internal/checkout/inbound/moamalat/live/abc123token");
    expect(forwarded?.body.toString("utf8")).toBe(raw);
    expect(forwarded?.headers["x-gateway-signature"]).toBe("sig-123");
    expect(forwarded?.headers["content-type"]).toBe("application/json");
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
