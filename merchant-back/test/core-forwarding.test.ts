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

const auth = { authorization: "Bearer merchant-session-token" };

const forwarded = (): CoreRequestRecord | undefined => core.requests.at(-1);
const forwardedBody = (): Record<string, unknown> =>
  JSON.parse(forwarded()?.body.toString("utf8") ?? "{}") as Record<string, unknown>;

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);

const postJson = (path: string, body: unknown) =>
  fetch(`${edgeUrl}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patchJson = (path: string, body: unknown) =>
  fetch(`${edgeUrl}${path}`, {
    method: "PATCH",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const putJson = (path: string, body: unknown) =>
  fetch(`${edgeUrl}${path}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.MAX_UPLOAD_BYTES = "1048576";
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

describe("merchant write routes are translated into the canonical core payload", () => {
  test("POST /auth/register keeps the public payload", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/merchant/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "0912345678",
        password: "Sup3rSecretPass",
        fullName: "Test User",
      }),
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/auth/register");
    expect(forwardedBody()).toEqual({
      phone: "912345678",
      password: "Sup3rSecretPass",
      fullName: "Test User",
    });
  });

  test("POST /wallets", async () => {
    const response = await postJson("/api/v1/merchant/wallets", {
      applicationId: "app_1",
      label: "Main wallet",
      currency: "LYD",
      openingAmount: "10.0000",
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/wallets");
    expect(forwardedBody()).toEqual({ currency: "LYD", label: "Main wallet" });
  });

  test("POST /applications", async () => {
    const response = await postJson("/api/v1/merchant/applications", {
      name: "Storefront",
      description: "Online sales channel",
      website: "https://shop.example",
      category: "RETAIL",
      assignedWalletId: "wal_1",
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/applications");
    expect(forwardedBody()).toEqual({
      name: "Storefront",
      businessUseDescription: "Online sales channel",
      assignedWalletId: "wal_1",
    });
  });

  test("POST /applications is rejected when core requires a wallet that was not supplied", async () => {
    const before = core.requests.length;
    const response = await postJson("/api/v1/merchant/applications", {
      name: "Storefront",
      description: "Online sales channel",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("VALIDATION_FAILED");
    expect(core.requests.length).toBe(before);
  });

  test("PATCH /applications/:id", async () => {
    const response = await patchJson("/api/v1/merchant/applications/app_1", {
      name: "Storefront",
      description: "Online sales channel",
      website: "https://shop.example",
      baseVersion: 2,
    });
    expect(response.status).toBe(200);
    expect(forwarded()?.url).toBe("/internal/merchant/applications/app_1");
    expect(forwardedBody()).toEqual({ name: "Storefront", businessUseDescription: "Online sales channel" });
  });

  test("PATCH /applications/:id flattens the sensitive portal payload", async () => {
    const response = await patchJson("/api/v1/merchant/applications/app_1", {
      sensitive: {
        assignedWalletId: "wal_1",
        railWhitelist: ["CASH"],
        redirectDomainAllowlist: ["https://shop.example"],
      },
      reason: "settlement change",
    });
    expect(response.status).toBe(200);
    expect(forwarded()?.url).toBe("/internal/merchant/applications/app_1");
    expect(forwardedBody()).toEqual({
      assignedWalletId: "wal_1",
      railWhitelist: ["CASH"],
      redirectDomainAllowlist: ["https://shop.example"],
    });
  });

  test("POST /users", async () => {
    const response = await postJson("/api/v1/merchant/users", {
      email: "ops@example.com",
      phone: "0912345678",
      fullName: "Ops User",
      password: "Sup3rSecretPass",
      role: "MERCHANT_STAFF",
      locale: "en",
      authoritiesMap: { "merchant:read": true, "merchant:write": false },
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/users");
    expect(forwardedBody()).toEqual({
      email: "ops@example.com",
      phone: "912345678",
      password: "Sup3rSecretPass",
      role: "MERCHANT_STAFF",
      authoritiesMap: ["merchant:read"],
    });
  });

  test("PATCH /users fans the bulk request out over the canonical route", async () => {
    const before = core.requests.length;
    const response = await patchJson("/api/v1/merchant/users", {
      userIds: ["usr_1", "usr_2"],
      role: "MERCHANT_STAFF",
      status: "ACTIVE",
      reason: "rotation",
    });
    expect(response.status).toBe(200);
    expect(core.requests.length - before).toBe(2);
    const first = core.requests[before];
    const second = core.requests[before + 1];
    expect(first?.url).toBe("/internal/merchant/users");
    expect(second?.url).toBe("/internal/merchant/users");
    expect(JSON.parse(first?.body.toString("utf8") ?? "{}")).toEqual({
      id: "usr_1",
      role: "MERCHANT_STAFF",
      status: "ACTIVE",
    });
    expect(JSON.parse(second?.body.toString("utf8") ?? "{}")).toEqual({
      id: "usr_2",
      role: "MERCHANT_STAFF",
      status: "ACTIVE",
    });
  });

  test("PATCH /users/:id", async () => {
    const response = await patchJson("/api/v1/merchant/users/usr_1", {
      fullName: "Ops User",
      role: "MERCHANT_CASHIER",
      status: "SUSPENDED",
      locale: "ar",
      baseVersion: 2,
    });
    expect(response.status).toBe(200);
    expect(forwarded()?.url).toBe("/internal/merchant/users/usr_1");
    expect(forwardedBody()).toEqual({ role: "MERCHANT_CASHIER", status: "SUSPENDED" });
  });

  test("POST /credential-sets", async () => {
    const response = await postJson("/api/v1/merchant/credential-sets", {
      name: "Gateway credentials",
      gatewayId: "gw_1",
      environment: "sandbox",
      ownership: "MERCHANT_DIRECT",
      authMethod: "API_KEY",
      secrets: { apiKey: "secret-value" },
      settings: { timeout: 30 },
      externalMerchantId: "merch-42",
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/credential-sets");
    expect(forwardedBody()).toEqual({
      gatewayCode: "gw_1",
      env: "SANDBOX",
      externalMerchantId: "merch-42",
      settlementTarget: "MERCHANT_DIRECT",
      entries: [{ key: "apiKey", type: "HEADER", value: "secret-value", isSecret: true }],
    });
  });

  test("PUT /credential-sets/:id", async () => {
    const response = await putJson("/api/v1/merchant/credential-sets/cs_1", {
      name: "Gateway credentials",
      secrets: { apiKey: "secret-value" },
      settings: { timeout: 30 },
    });
    expect(response.status).toBe(200);
    expect(forwarded()?.url).toBe("/internal/merchant/credential-sets/cs_1");
    expect(forwardedBody()).toEqual({
      entries: [{ key: "apiKey", type: "HEADER", value: "secret-value", isSecret: true }],
    });
  });

  test("POST /cashouts", async () => {
    const response = await postJson("/api/v1/merchant/cashouts", {
      walletId: "wal_1",
      amount: "250.0000",
      currency: "LYD",
      bankAccountId: "bank_1",
      reference: "INV-1",
      idempotencyKey: "idem-00000001",
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/cashouts");
    expect(forwardedBody()).toEqual({
      walletId: "wal_1",
      amount: "250.0000",
      destinationBank: { bankAccountId: "bank_1" },
    });
  });

  test("POST /pos/terminals", async () => {
    const response = await postJson("/api/v1/merchant/pos/terminals", {
      name: "Till 1",
      applicationId: "app_1",
      location: "Tripoli",
      deviceId: "device-9",
    });
    expect(response.status).toBe(201);
    expect(forwarded()?.url).toBe("/internal/merchant/pos/terminals");
    expect(forwardedBody()).toEqual({ name: "Till 1", applicationId: "app_1", location: "Tripoli" });
  });

  test("POST /disputes/:id/evidence is forwarded as a canonical json payload", async () => {
    const form = new FormData();
    form.set("evidenceType", "RECEIPT");
    form.set("notes", "proof of delivery");
    form.set("evidence", new Blob([new Uint8Array(pngBytes)], { type: "image/png" }), "receipt.png");
    const response = await fetch(`${edgeUrl}/api/v1/merchant/disputes/dis_1/evidence`, {
      method: "POST",
      headers: auth,
      body: form,
    });
    expect(response.status).toBe(200);
    expect(forwarded()?.url).toBe("/internal/merchant/disputes/dis_1/evidence");
    expect(forwarded()?.headers["content-type"]).toBe("application/json");
    const sent = forwardedBody();
    expect(sent.notes).toBe("proof of delivery");
    const evidence = sent.evidence as Record<string, unknown>;
    expect(evidence.evidenceType).toBe("RECEIPT");
    expect(evidence.fileName).toBe("receipt.png");
    expect(evidence.contentType).toBe("image/png");
    expect(Buffer.from(evidence.contentBase64 as string, "base64").equals(pngBytes)).toBe(true);
  });
});
