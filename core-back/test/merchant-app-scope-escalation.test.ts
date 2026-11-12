/**
 * A merchant user restricted to some applications (`users.app_scope_ids`) must not be able to
 * step outside that restriction through team management or API tokens, and an API token only
 * reaches the application it was issued for. Real PostgreSQL 18 test database (skipped when it is
 * unreachable or not named "*test*").
 *
 * Regressions covered (2026-11-12 review):
 * - `POST /users` created an UNRESTRICTED user for a restricted creator (who chose its password
 *   and could activate it), and `PATCH /users` let a restricted manager change anyone;
 * - `POST /tokens` gave a restricted user a token for an arbitrary application, and the token
 *   list, IP allowlist and revoke routes ignored the restriction;
 * - the external API checked only the merchant: a token of one application created, read and
 *   cancelled links and read payments of the merchant's other applications.
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

type Res = { status: number; body: any };
const call = async (path: string, token: string, method = "GET", payload?: unknown): Promise<Res> => {
  const response = await fetch(`${base}/internal/merchant${path}`, {
    method,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
  });
  const raw = await response.text();
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  return { status: response.status, body };
};

let merchantId = "";
let appA = "";
let appB = "";
let linkKeyA = "";
let linkKeyB = "";
const sessions: Record<string, string> = {};
const userIds: Record<string, string> = {};

const makeUser = async (
  key: string,
  role: "MERCHANT_ADMIN" | "MERCHANT_STAFF" | "MERCHANT_CASHIER",
  authorities: string[],
  appScopeIds: string[] = [],
): Promise<void> => {
  const user = await client.user.create({
    data: {
      email: `esc-${key}-${RUN}@gateway.test`,
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
  userIds[key] = user.id;
  sessions[key] = signSession({ sub: user.id, role, merchantId, authorities, appScopeIds, mfa: true }, "merchant");
};

const MANAGER_AUTHORITIES = ["user:manage", "token:manage", "link:write", "link:read", "payment:read", "merchant:read"];

beforeAll(async () => {
  if (!reachable) return;
  setAuthStateStore(new MemoryAuthStateStore());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const merchant = await client.merchant.create({
    data: {
      legalName: `Escalation ${RUN}`,
      tradeName: `E-${RUN}`,
      onboardingChannel: "E2E",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      activatedAt: new Date(),
      contactEmail: `esc-${RUN}@gateway.test`,
      contactPhone: "+218910000003",
      negativeBalanceCeiling: new Prisma.Decimal(0),
    },
  });
  merchantId = merchant.id;
  const glAccount = await client.glAccount.create({ data: { accountType: "MERCHANT_WALLET", ownerId: merchantId, currency: "LYD" } });
  const wallet = await client.wallet.create({ data: { merchantId, glAccountId: glAccount.id, currency: "LYD", status: "ACTIVE" } });
  const application = (name: string) =>
    client.application.create({
      data: { merchantId, name: `${name} ${RUN}`, expectedMonthlyVolume: new Prisma.Decimal(1000), assignedWalletId: wallet.id, status: "ACTIVE" },
    });
  // B is created FIRST on purpose: "the merchant's oldest application" used to be the default.
  appB = (await application("B")).id;
  appA = (await application("A")).id;
  const link = (applicationId: string, key: string) =>
    client.paymentLink.create({
      data: {
        key,
        applicationId,
        walletId: wallet.id,
        amount: new Prisma.Decimal("10.0000"),
        currency: "LYD",
        feeBearer: "MERCHANT_ABSORBS",
        useCount: 1,
        state: "PENDING",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  linkKeyA = (await link(appA, `escA-${RUN}`)).key;
  linkKeyB = (await link(appB, `escB-${RUN}`)).key;

  for (const [applicationId, linkKey, reference] of [[appA, linkKeyA, `ESC-A-${RUN}`], [appB, linkKeyB, `ESC-B-${RUN}`]] as const) {
    const linkRow = await client.paymentLink.findFirstOrThrow({ where: { key: linkKey } });
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.paymentAttempt.create({
        data: {
          id: randomUUID(),
          reference,
          linkId: linkRow.id,
          attemptGroupId: randomUUID(),
          applicationId,
          merchantId,
          railId: randomUUID(),
          routeId: randomUUID(),
          credentialSetId: randomUUID(),
          gatewayVersionId: randomUUID(),
          commissionProfileId: randomUUID(),
          env: "LIVE",
          mode: "OTP_PULL",
          status: "SUCCEEDED",
          requestedAmount: new Prisma.Decimal("10.0000"),
          totalChargedAmount: new Prisma.Decimal("10.0000"),
          platformCommissionAmount: new Prisma.Decimal("0.3000"),
          netMerchantAmount: new Prisma.Decimal("9.7000"),
          feeBearer: "MERCHANT_ABSORBS",
          currency: "LYD",
          customerFieldsMasked: {},
          contextCiphertext: "x",
          expiresAt: new Date(Date.now() + 3_600_000),
          graceExpiresAt: new Date(Date.now() + 7_200_000),
          terminalAt: new Date(),
        },
      });
    });
  }

  await makeUser("admin", "MERCHANT_ADMIN", MANAGER_AUTHORITIES);
  await makeUser("scoped", "MERCHANT_STAFF", MANAGER_AUTHORITIES, [appA]);
  await makeUser("peerA", "MERCHANT_CASHIER", ["link:read"], [appA]);
  await makeUser("peerB", "MERCHANT_CASHIER", ["link:read"], [appB]);
  await makeUser("unrestricted", "MERCHANT_CASHIER", ["link:read"]);
});

afterAll(() => {
  server?.close();
});

describe.skipIf(!reachable)("a restricted manager cannot create or change users outside their applications", () => {
  test("the user they create inherits their restriction", async () => {
    const created = await call("/users", sessions.scoped!, "POST", {
      email: `esc-new-${RUN}@gateway.test`,
      password: "a-long-test-password-1",
      role: "MERCHANT_CASHIER",
      authoritiesMap: ["link:read"],
    });
    expect(created.status).toBe(201);
    const row = await client.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.appScopeIds).toEqual([appA]);
    // Activating their own restricted creation is still allowed (the team page does this).
    const activated = await call(`/users/${created.body.id}`, sessions.scoped!, "PATCH", { status: "ACTIVE" });
    expect(activated.status).toBe(200);
  });

  test("a user created by an unrestricted administrator stays unrestricted", async () => {
    const created = await call("/users", sessions.admin!, "POST", {
      email: `esc-open-${RUN}@gateway.test`,
      password: "a-long-test-password-2",
      role: "MERCHANT_CASHIER",
      authoritiesMap: ["link:read"],
    });
    expect(created.status).toBe(201);
    const row = await client.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(Array.isArray(row.appScopeIds) ? row.appScopeIds : []).toEqual([]);
  });

  test("an unrestricted user and a user of another application cannot be changed", async () => {
    for (const target of ["unrestricted", "peerB"]) {
      for (const [path, payload] of [
        [`/users/${userIds[target]}`, { status: "SUSPENDED" }],
        ["/users", { id: userIds[target], authoritiesMap: ["link:read", "payment:read"] }],
      ] as const) {
        const response = await call(path, sessions.scoped!, "PATCH", payload);
        expect([target, path, response.status, response.body.code]).toEqual([target, path, 403, "APP_SCOPE_VIOLATION"]);
      }
      const row = await client.user.findUniqueOrThrow({ where: { id: userIds[target]! } });
      expect(row.status).toBe("ACTIVE");
    }
  });

  test("a user of the same application can be changed, and an administrator changes anyone", async () => {
    const same = await call(`/users/${userIds.peerA}`, sessions.scoped!, "PATCH", { status: "SUSPENDED" });
    expect(same.status).toBe(200);
    const byAdmin = await call(`/users/${userIds.peerB}`, sessions.admin!, "PATCH", { status: "SUSPENDED" });
    expect(byAdmin.status).toBe(200);
  });
});

describe.skipIf(!reachable)("API tokens stay inside the application they were issued for", () => {
  let tokenA = "";
  let tokenB = "";
  let tokenBId = "";

  test("a restricted user gets a token for their application, never for another one", async () => {
    const refused = await call("/tokens", sessions.scoped!, "POST", { name: "other app", scopes: ["link:read"], applicationId: appB });
    expect([refused.status, refused.body.code]).toEqual([403, "APP_SCOPE_VIOLATION"]);

    // No application named: the default is one of THEIR applications (B is the merchant's oldest).
    const issued = await call("/tokens", sessions.scoped!, "POST", { name: "scoped default", scopes: ["link:read", "link:write", "payment:read"] });
    expect(issued.status).toBe(201);
    const row = await client.accessToken.findUniqueOrThrow({ where: { id: issued.body.id } });
    expect(row.applicationId).toBe(appA);
    tokenA = issued.body.token;

    const forB = await call("/tokens", sessions.admin!, "POST", { name: "app B", scopes: ["link:read", "link:write", "payment:read"], applicationId: appB });
    expect(forB.status).toBe(201);
    tokenB = forB.body.token;
    tokenBId = forB.body.id;
  });

  test("a restricted user neither sees nor manages another application's token", async () => {
    const listed = await call("/tokens", sessions.scoped!);
    expect(listed.status).toBe(200);
    const ids = (listed.body.tokens ?? listed.body.items ?? []).map((token: { id: string }) => token.id);
    expect(ids).not.toContain(tokenBId);

    const ips = await call(`/tokens/${tokenBId}/ips`, sessions.scoped!, "PUT", { allowedCidrs: [] });
    expect([ips.status, ips.body.code]).toEqual([403, "APP_SCOPE_VIOLATION"]);
    const revoked = await call(`/tokens/${tokenBId}`, sessions.scoped!, "DELETE");
    expect([revoked.status, revoked.body.code]).toEqual([403, "APP_SCOPE_VIOLATION"]);
    expect((await client.accessToken.findUniqueOrThrow({ where: { id: tokenBId } })).revokedAt).toBeNull();
  });

  test("a token reads its own application's link and payment", async () => {
    const link = await call(`/external/links/${linkKeyA}`, tokenA);
    expect([link.status, link.body.key]).toEqual([200, linkKeyA]);
    const payment = await call(`/external/payments/ESC-A-${RUN}`, tokenA);
    expect([payment.status, payment.body.reference]).toEqual([200, `ESC-A-${RUN}`]);
  });

  test("another application's link and payment do not exist for the token", async () => {
    const link = await call(`/external/links/${linkKeyB}`, tokenA);
    expect([link.status, link.body.code]).toEqual([404, "PAYMENT_LINK_NOT_FOUND"]);
    const cancel = await call(`/external/links/${linkKeyB}/cancel`, tokenA, "POST", {});
    expect([cancel.status, cancel.body.code]).toEqual([404, "PAYMENT_LINK_NOT_FOUND"]);
    expect((await client.paymentLink.findFirstOrThrow({ where: { key: linkKeyB } })).state).toBe("PENDING");
    const payment = await call(`/external/payments/ESC-B-${RUN}`, tokenA);
    expect([payment.status, payment.body.code]).toEqual([404, "PAYMENT_ATTEMPT_NOT_FOUND"]);

    // And the other way round, so the check is the application and not the issuer.
    const reverse = await call(`/external/links/${linkKeyA}`, tokenB);
    expect(reverse.status).toBe(404);
  });

  test("a token cannot create a link in another application", async () => {
    const refused = await call("/external/links", tokenA, "POST", { title: "x", amount: "5.0000", currency: "LYD", applicationId: appB });
    expect([refused.status, refused.body.code]).toEqual([403, "APP_SCOPE_VIOLATION"]);
    expect(await client.paymentLink.count({ where: { applicationId: appB } })).toBe(1);
  });
});
