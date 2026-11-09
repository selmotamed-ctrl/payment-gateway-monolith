/**
 * AUTO-34 merchant webhook management routes (`/internal/merchant/webhooks/*`) against a real PostgreSQL test database:
 * authority gates, application scope, merchant isolation, input validation, the secret shown exactly once, and the
 * test / rotate / redeliver flows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Prisma } from "../generated/prisma/client";
import { client } from "../prisma/client";
import { merchantInternalRouter } from "../api/internal/merchant";
import { signSession } from "../lib/auth";
import { MemoryAuthStateStore, setAuthStateStore } from "../lib/auth/sharedState";
import { isApiError, toErrorEnvelope } from "../lib/error";

const DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = DATABASE_URL;
const RUN = randomUUID().replace(/-/g, "").slice(0, 12);

const reachable = await (async (): Promise<boolean> => {
  try {
    if (!/test/i.test(new URL(DATABASE_URL).pathname.replace(/^\//, ""))) return false;
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
})();

const app = express();
app.use(express.json());
app.use("/internal/merchant", merchantInternalRouter);
app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
  response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
});

let server: ReturnType<typeof app.listen>;
let base = "";
type Res = { status: number; body: any; raw: string };
const call = async (path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<Res> => {
  const response = await fetch(`${base}/internal/merchant${path}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
  });
  const raw = await response.text();
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  return { status: response.status, body, raw };
};

interface Shop { merchantId: string; appFirst: string; appSecond: string }
const makeShop = async (label: string): Promise<Shop> => {
  const merchant = await client.merchant.create({
    data: {
      legalName: `Hook ${label} ${RUN}`,
      tradeName: `H-${label}-${RUN}`,
      onboardingChannel: "E2E",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      activatedAt: new Date(),
      contactEmail: `hook-${label}-${RUN}@gateway.test`,
      contactPhone: "+218910000003",
      negativeBalanceCeiling: new Prisma.Decimal(0),
    },
  });
  const glAccount = await client.glAccount.create({ data: { accountType: "MERCHANT_WALLET", ownerId: merchant.id, currency: "LYD" } });
  const wallet = await client.wallet.create({ data: { merchantId: merchant.id, glAccountId: glAccount.id, currency: "LYD", status: "ACTIVE" } });
  const application = (name: string) =>
    client.application.create({ data: { merchantId: merchant.id, name: `${name} ${label} ${RUN}`, expectedMonthlyVolume: new Prisma.Decimal(1), assignedWalletId: wallet.id, status: "ACTIVE" } });
  return { merchantId: merchant.id, appFirst: (await application("First")).id, appSecond: (await application("Second")).id };
};

const tokens: Record<string, string> = {};
const makeUser = async (key: string, merchantId: string, role: "MERCHANT_ADMIN" | "MERCHANT_STAFF", authorities: string[], appScopeIds: string[] = []): Promise<void> => {
  const user = await client.user.create({
    data: {
      email: `hook-${key}-${RUN}@gateway.test`,
      role,
      status: "ACTIVE",
      merchantId,
      authoritiesMap: Object.fromEntries(authorities.map((authority) => [authority, true])),
      appScopeIds,
      isMaker: false,
      isChecker: false,
      mfaRequired: false,
    },
  });
  tokens[key] = signSession({ sub: user.id, role, merchantId, authorities, appScopeIds, mfa: true }, "merchant");
};

let shopA: Shop;
let shopB: Shop;

beforeAll(async () => {
  if (!reachable) return;
  setAuthStateStore(new MemoryAuthStateStore());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  shopA = await makeShop("a");
  shopB = await makeShop("b");
  await makeUser("manager", shopA.merchantId, "MERCHANT_ADMIN", ["merchant:read", "application:manage"]);
  await makeUser("reader", shopA.merchantId, "MERCHANT_STAFF", ["merchant:read"]);
  await makeUser("unrelated", shopA.merchantId, "MERCHANT_STAFF", ["user:manage"]);
  await makeUser("scoped", shopA.merchantId, "MERCHANT_STAFF", ["merchant:read", "application:manage"], [shopA.appFirst]);
  await makeUser("other", shopB.merchantId, "MERCHANT_ADMIN", ["merchant:read", "application:manage"]);
});

afterAll(async () => {
  server?.close();
  if (!reachable) return;
  await client.$executeRawUnsafe(`DELETE FROM merchant_webhook_endpoints WHERE merchant_id = ANY($1::uuid[])`, [shopA.merchantId, shopB.merchantId]);
});

const create = (token: string, applicationId: string, extra: Record<string, unknown> = {}) =>
  call("/webhooks/endpoints", token, { method: "POST", body: { applicationId, url: `https://hooks.example.ly/${randomUUID().slice(0, 6)}`, ...extra } });

describe.skipIf(!reachable)("webhook management routes", () => {
  test("authority gates: reading needs a merchant read authority, changing needs application:manage", async () => {
    expect((await call("/webhooks/endpoints", tokens.unrelated!)).status).toBe(403);
    expect((await call("/webhooks/event-types", tokens.unrelated!)).status).toBe(403);
    expect((await call("/webhooks/endpoints", tokens.reader!)).status).toBe(200);
    expect((await call("/webhooks/event-types", tokens.reader!)).status).toBe(200);
    expect((await create(tokens.reader!, shopA.appFirst)).status).toBe(403);
    expect((await create(tokens.unrelated!, shopA.appFirst)).status).toBe(403);
    expect((await call("/webhooks/deliveries", tokens.unrelated!)).status).toBe(403);
  });

  test("create returns the secret once (no-store); listing and updating never show it", async () => {
    const created = await create(tokens.manager!, shopA.appFirst, { eventTypes: ["payment.succeeded", "payment.failed"], description: "orders" });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    expect(created.body.endpoint).toMatchObject({ status: "ACTIVE", eventTypes: ["payment.succeeded", "payment.failed"], description: "orders", applicationId: shopA.appFirst });
    const secret = created.body.secret as string;
    const listed = await call(`/webhooks/endpoints?applicationId=${shopA.appFirst}`, tokens.reader!);
    expect(listed.status).toBe(200);
    expect(listed.raw).not.toContain(secret);
    expect(listed.raw).not.toContain("ciphertext");
    expect(listed.body.endpoints.map((row: any) => row.id)).toContain(created.body.endpoint.id);
    const patched = await call(`/webhooks/endpoints/${created.body.endpoint.id}`, tokens.manager!, { method: "PATCH", body: { description: "orders v2", eventTypes: [] } });
    expect(patched.status).toBe(200);
    expect(patched.raw).not.toContain(secret);
    expect(patched.body).toMatchObject({ description: "orders v2", eventTypes: [] });
  });

  test("validation: HTTPS only, no private hosts, known event types, strict bodies", async () => {
    const bad = async (extra: Record<string, unknown>) => create(tokens.manager!, shopA.appFirst, extra);
    expect(await bad({ url: "http://hooks.example.ly/x" })).toMatchObject({ status: 422, body: { code: "WEBHOOK_INSECURE_URL" } });
    expect(await bad({ url: "https://127.0.0.1/x" })).toMatchObject({ status: 422, body: { code: "WEBHOOK_PRIVATE_HOST" } });
    expect(await bad({ url: "https://user:pw@hooks.example.ly/x" })).toMatchObject({ status: 422, body: { code: "WEBHOOK_URL_USERINFO" } });
    expect(await bad({ eventTypes: ["payment.exploded"] })).toMatchObject({ status: 422, body: { code: "WEBHOOK_EVENT_TYPE_UNKNOWN" } });
    expect((await bad({ unexpected: true })).status).toBe(400);
    expect((await call("/webhooks/endpoints", tokens.manager!, { method: "POST", body: { url: "https://hooks.example.ly/x" } })).status).toBe(400); // no applicationId
    expect((await call("/webhooks/endpoints/not-a-uuid", tokens.manager!, { method: "PATCH", body: {} })).status).toBe(400);
  });

  test("merchant isolation: another merchant's application, endpoints and deliveries do not exist for you", async () => {
    const mine = await create(tokens.manager!, shopA.appFirst);
    expect((await create(tokens.other!, shopA.appFirst)).status).toBe(404); // not their application
    for (const [method, path, body] of [
      ["PATCH", `/webhooks/endpoints/${mine.body.endpoint.id}`, { enabled: false }],
      ["POST", `/webhooks/endpoints/${mine.body.endpoint.id}/rotate-secret`, undefined],
      ["POST", `/webhooks/endpoints/${mine.body.endpoint.id}/test`, undefined],
    ] as const) {
      expect([method, path, (await call(path, tokens.other!, { method, body })).status]).toEqual([method, path, 404]);
    }
    const theirs = await call("/webhooks/endpoints", tokens.other!);
    expect(theirs.body.endpoints).toEqual([]);
    expect((await call(`/webhooks/deliveries?endpointId=${mine.body.endpoint.id}`, tokens.other!)).status).toBe(404);
  });

  test("an application-scoped user only sees and changes endpoints of their own application", async () => {
    const first = await create(tokens.manager!, shopA.appFirst);
    const second = await create(tokens.manager!, shopA.appSecond);
    expect((await create(tokens.scoped!, shopA.appSecond)).body.code).toBe("APP_SCOPE_VIOLATION");
    expect((await create(tokens.scoped!, shopA.appFirst)).status).toBe(201);
    const listed = await call("/webhooks/endpoints", tokens.scoped!);
    const ids = listed.body.endpoints.map((row: any) => row.id);
    expect(ids).toContain(first.body.endpoint.id);
    expect(ids).not.toContain(second.body.endpoint.id);
    expect((await call(`/webhooks/endpoints?applicationId=${shopA.appSecond}`, tokens.scoped!)).status).toBe(403);
    expect((await call(`/webhooks/endpoints/${second.body.endpoint.id}`, tokens.scoped!, { method: "PATCH", body: { enabled: false } })).status).toBe(403);
    expect((await call(`/webhooks/endpoints/${second.body.endpoint.id}/test`, tokens.scoped!, { method: "POST" })).status).toBe(403);
    expect((await call(`/webhooks/deliveries?endpointId=${second.body.endpoint.id}`, tokens.scoped!)).status).toBe(403);
  });

  test("rotate returns a new secret and an overlap; test queues a delivery; redeliver requeues a parked one", async () => {
    const created = await create(tokens.manager!, shopA.appFirst);
    const id = created.body.endpoint.id as string;
    const rotated = await call(`/webhooks/endpoints/${id}/rotate-secret`, tokens.manager!, { method: "POST" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).not.toBe(created.body.secret);
    expect(rotated.body.endpoint.rotationOverlapActive).toBe(true);
    expect(rotated.raw).not.toContain(created.body.secret);

    const test = await call(`/webhooks/endpoints/${id}/test`, tokens.manager!, { method: "POST" });
    expect(test.status).toBe(202);
    const deliveries = await call(`/webhooks/deliveries?endpointId=${id}`, tokens.reader!);
    expect(deliveries.body.deliveries).toHaveLength(1);
    expect(deliveries.body.deliveries[0]).toMatchObject({ eventType: "webhook.test", status: "PENDING", attempts: 0 });
    expect(deliveries.raw).not.toContain("body"); // payload text is not part of the list view

    expect((await call(`/webhooks/deliveries/${test.body.deliveryId}/redeliver`, tokens.manager!, { method: "POST" })).status).toBe(409); // already queued
    await client.$executeRawUnsafe(`UPDATE merchant_webhook_deliveries SET status = 'PARKED', park_reason = 'MAX_ATTEMPTS' WHERE id = $1::uuid`, test.body.deliveryId);
    expect((await call(`/webhooks/deliveries?status=PARKED`, tokens.reader!)).body.deliveries.map((row: any) => row.id)).toContain(test.body.deliveryId);
    expect((await call(`/webhooks/deliveries/${test.body.deliveryId}/redeliver`, tokens.reader!, { method: "POST" })).status).toBe(403);
    const redelivered = await call(`/webhooks/deliveries/${test.body.deliveryId}/redeliver`, tokens.manager!, { method: "POST" });
    expect(redelivered.status).toBe(202);
    expect(redelivered.body).toMatchObject({ status: "PENDING" });
    expect((await call(`/webhooks/deliveries/${test.body.deliveryId}/redeliver`, tokens.other!, { method: "POST" })).status).toBe(404);
  });

  test("the event-type catalogue tells the retry schedule and the signature scheme", async () => {
    const response = await call("/webhooks/event-types", tokens.reader!);
    expect(response.body.eventTypes).toEqual(["payment.succeeded", "payment.failed", "payment.expired", "payment.refunded", "dispute.opened", "dispute.closed", "cashout.paid", "cashout.failed", "link.expired"]);
    expect(response.body.retry).toMatchObject({ maxAttempts: 8, delaysSeconds: [5, 300, 1800, 7200, 18000, 36000, 36000], disableAfterDays: 5 });
    expect(response.body.signature.headers).toEqual(["webhook-id", "webhook-timestamp", "webhook-signature"]);
  });

  test("the endpoint limit per application is enforced", async () => {
    const shop = await makeShop("limit");
    await makeUser("limiter", shop.merchantId, "MERCHANT_ADMIN", ["merchant:read", "application:manage"]);
    for (let index = 0; index < 5; index += 1) expect((await create(tokens.limiter!, shop.appFirst)).status).toBe(201);
    expect(await create(tokens.limiter!, shop.appFirst)).toMatchObject({ status: 409, body: { code: "WEBHOOK_ENDPOINT_LIMIT" } });
    await client.$executeRawUnsafe(`DELETE FROM merchant_webhook_endpoints WHERE merchant_id = $1::uuid`, shop.merchantId);
  });
});
