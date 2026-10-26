import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetEnvCache } from "../lib/env";
import { resetCoreAgent } from "../lib/mtlsClient";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";

const pki: TestPki = createTestPki("merchant-back");
const core: TestCore = await startTestCore(pki);

process.env.NODE_ENV = "test";
process.env.CORE_BACK_URL = core.url;
process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
process.env.MTLS_CA_CERT_PATH = pki.caCert;
process.env.MAX_UPLOAD_BYTES = "1048576";
resetEnvCache();
resetCoreAgent();

const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
const fakeImage = Buffer.from("this is definitely not an image payload", "utf8");

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

const uploadKyb = (filename: string, mime: string, bytes: Buffer) => {
  const form = new FormData();
  form.set("documentType", "REGISTRATION_CERTIFICATE");
  form.set("document", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
  return fetch(`${edgeUrl}/api/v1/merchant/onboarding/kyb-documents`, {
    method: "POST",
    headers: { authorization: "Bearer merchant-session-token" },
    body: form,
  });
};

describe("merchant kyb upload validation", () => {
  test("accepts a real png document and forwards the bytes", async () => {
    const response = await uploadKyb("license.png", "image/png", pngBytes);
    expect(response.status).toBe(201);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/merchant/onboarding/kyb-documents");
    expect(forwarded?.body.equals(pngBytes)).toBe(true);
    expect(forwarded?.headers["x-upload-content-type"]).toBe("image/png");
    expect(forwarded?.headers["x-upload-sha256"]).toBeString();
    expect(forwarded?.headers["x-upload-metadata"]).toBeString();
  });

  test("accepts a real jpeg document", async () => {
    const response = await uploadKyb("id.jpg", "image/jpeg", jpegBytes);
    expect(response.status).toBe(201);
    expect(core.requests.at(-1)?.headers["x-upload-content-type"]).toBe("image/jpeg");
  });

  test("accepts a real pdf document", async () => {
    const response = await uploadKyb("registry.pdf", "application/pdf", pdfBytes);
    expect(response.status).toBe(201);
    expect(core.requests.at(-1)?.headers["x-upload-content-type"]).toBe("application/pdf");
  });

  test("rejects a payload whose magic bytes are not a supported document", async () => {
    const before = core.requests.length;
    const response = await uploadKyb("fake.png", "image/png", fakeImage);
    expect(response.status).toBe(415);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
    expect(core.requests.length).toBe(before);
  });

  test("rejects a declared mime type that is not allowed", async () => {
    const response = await uploadKyb("notes.txt", "text/plain", Buffer.from("hello", "utf8"));
    expect(response.status).toBe(415);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UNSUPPORTED_UPLOAD_TYPE");
  });

  test("rejects a document larger than the edge size cap", async () => {
    const oversized = Buffer.concat([pngBytes, Buffer.alloc(2 * 1024 * 1024, 0x41)]);
    const response = await uploadKyb("huge.png", "image/png", oversized);
    expect(response.status).toBe(413);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UPLOAD_TOO_LARGE");
  });

  test("rejects a missing document", async () => {
    const form = new FormData();
    form.set("documentType", "REGISTRATION_CERTIFICATE");
    const response = await fetch(`${edgeUrl}/api/v1/merchant/onboarding/kyb-documents`, {
      method: "POST",
      headers: { authorization: "Bearer merchant-session-token" },
      body: form,
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("UPLOAD_REQUIRED");
  });
});

describe("merchant authorization forwarding", () => {
  test("requires a bearer token on protected routes", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/merchant/wallets`);
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AUTH_REQUIRED");
  });

  test("forwards the merchant bearer token to core", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/merchant/wallets`, {
      headers: { authorization: "Bearer merchant-session-token" },
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/merchant/wallets");
    expect(forwarded?.headers.authorization).toBe("Bearer merchant-session-token");
    expect(forwarded?.headers["x-edge-service"]).toBe("merchant-back");
  });
});

describe("merchant external pg_live_ api", () => {
  test("rejects a request without a pg_live_ token", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/external/links/LINKKEY123`, {
      headers: { authorization: "Bearer merchant-session-token" },
    });
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("INVALID_API_TOKEN");
  });

  test("rejects a request without any authorization header", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/external/links/LINKKEY123`);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_API_TOKEN");
  });

  test("accepts a pg_live_ token and forwards it unchanged", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/external/links/LINKKEY123`, {
      headers: { authorization: "Bearer pg_live_abc123" },
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.url).toBe("/internal/merchant/external/links/LINKKEY123");
    expect(forwarded?.headers.authorization).toBe("Bearer pg_live_abc123");
  });

  test("merchant link creation carries the amount for core revalidation", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/external/links`, {
      method: "POST",
      headers: {
        authorization: "Bearer pg_live_abc123",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Invoice 42",
        amount: "125.5000",
        currency: "LYD",
        idempotencyKey: "idem-00000021",
      }),
    });
    expect(response.status).toBe(201);
    const forwarded = core.requests.at(-1);
    const sent = JSON.parse(forwarded?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect(sent.amount).toBe("125.5000");
    expect(sent.currency).toBe("LYD");
  });

  test("rejects a merchant link creation without an amount", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/external/links`, {
      method: "POST",
      headers: {
        authorization: "Bearer pg_live_abc123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Invoice 43", currency: "LYD" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("VALIDATION_FAILED");
  });
});

describe("merchant realtime rooms", () => {
  test("proxies the pos screen stream", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/merchant/pos/screens/SCREEN1/stream`, {
      headers: { authorization: "Bearer merchant-session-token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("CASHIER");
  });
});
