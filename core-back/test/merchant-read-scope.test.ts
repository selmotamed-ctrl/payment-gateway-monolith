/**
 * Merchant read routes: authority gates, `app_scope_ids` enforcement and the KYB duplicate lookup,
 * against a real PostgreSQL 18 test database (skipped when it is unreachable or not named "*test*").
 *
 * Regressions covered:
 * - wallet / balance / statement / export routes only checked the merchant, so any merchant user
 *   (even one holding a single unrelated authority) could read balances and a 50,000-row export;
 * - `users.app_scope_ids` was issued in the session but never enforced;
 * - the KYB upload response listed other merchants' document ids for the same file hash.
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
app.use("/internal/merchant/onboarding/kyb-documents", express.raw({ type: () => true, limit: "5mb" }));
app.use(express.json());
app.use("/internal/merchant", merchantInternalRouter);
app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
  response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
});

let server: ReturnType<typeof app.listen>;
let base = "";

type Res = { status: number; body: any; raw: string };
const call = async (
  path: string,
  token: string,
  init: { method?: string; body?: string | Uint8Array; headers?: Record<string, string> } = {},
): Promise<Res> => {
  const response = await fetch(`${base}/internal/merchant${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
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
const postJson = (path: string, token: string, payload: unknown): Res | Promise<Res> =>
  call(path, token, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });

interface Shop {
  merchantId: string;
  walletId: string;
  appFirst: string;
  appSecond: string;
  linkFirst: string;
  linkSecond: string;
}

const makeShop = async (label: string): Promise<Shop> => {
  const merchant = await client.merchant.create({
    data: {
      legalName: `Scope ${label} ${RUN}`,
      tradeName: `S-${label}-${RUN}`,
      onboardingChannel: "E2E",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      activatedAt: new Date(),
      contactEmail: `scope-${label}-${RUN}@gateway.test`,
      contactPhone: "+218910000002",
      negativeBalanceCeiling: new Prisma.Decimal(0),
    },
  });
  const glAccount = await client.glAccount.create({
    data: { accountType: "MERCHANT_WALLET", ownerId: merchant.id, currency: "LYD" },
  });
  const wallet = await client.wallet.create({
    data: { merchantId: merchant.id, glAccountId: glAccount.id, currency: "LYD", status: "ACTIVE" },
  });
  // Created second-first on purpose: the OLDEST application is the default for a new link.
  const appSecond = await client.application.create({
    data: {
      merchantId: merchant.id,
      name: `App2 ${label} ${RUN}`,
      expectedMonthlyVolume: new Prisma.Decimal(1000),
      assignedWalletId: wallet.id,
      status: "ACTIVE",
    },
  });
  const appFirst = await client.application.create({
    data: {
      merchantId: merchant.id,
      name: `App1 ${label} ${RUN}`,
      expectedMonthlyVolume: new Prisma.Decimal(1000),
      assignedWalletId: wallet.id,
      status: "ACTIVE",
    },
  });
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
  const linkSecond = await link(appSecond.id, `sc2-${label}-${RUN}`);
  const linkFirst = await link(appFirst.id, `sc1-${label}-${RUN}`);
  return {
    merchantId: merchant.id,
    walletId: wallet.id,
    appFirst: appFirst.id,
    appSecond: appSecond.id,
    linkFirst: linkFirst.id,
    linkSecond: linkSecond.id,
  };
};

/** A payment attempt with arbitrary foreign keys (the FK triggers are disabled for this transaction). */
const makeAttempt = async (shop: Shop, applicationId: string, linkId: string, reference: string): Promise<string> => {
  const id = randomUUID();
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.paymentAttempt.create({
      data: {
        id,
        reference,
        linkId,
        attemptGroupId: randomUUID(),
        applicationId,
        merchantId: shop.merchantId,
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
  return id;
};

let shopA: Shop;
let shopB: Shop;
const tokens: Record<string, string> = {};

const makeUser = async (
  key: string,
  merchantId: string,
  role: "MERCHANT_ADMIN" | "MERCHANT_STAFF",
  authorities: string[],
  appScopeIds: string[] = [],
): Promise<void> => {
  const user = await client.user.create({
    data: {
      email: `scope-${key}-${RUN}@gateway.test`,
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
  tokens[key] = signSession(
    { sub: user.id, role, merchantId, authorities, appScopeIds, mfa: true },
    "merchant",
  );
};

beforeAll(async () => {
  if (!reachable) return;
  setAuthStateStore(new MemoryAuthStateStore());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  shopA = await makeShop("a");
  shopB = await makeShop("b");
  await makeAttempt(shopA, shopA.appFirst, shopA.linkFirst, `SC-A1-${RUN}`);
  await makeAttempt(shopA, shopA.appSecond, shopA.linkSecond, `SC-A2-${RUN}`);
  await makeUser("admin", shopA.merchantId, "MERCHANT_ADMIN", ["merchant:read", "merchant:write"]);
  await makeUser("reader", shopA.merchantId, "MERCHANT_STAFF", ["merchant:read"]);
  await makeUser("payer", shopA.merchantId, "MERCHANT_STAFF", ["payment:read"]);
  await makeUser("linker", shopA.merchantId, "MERCHANT_STAFF", ["link:write"]);
  await makeUser("unrelated", shopA.merchantId, "MERCHANT_STAFF", ["user:manage"]);
  await makeUser("scoped", shopA.merchantId, "MERCHANT_STAFF", ["merchant:read", "link:write"], [shopA.appFirst]);
  await makeUser("uploaderA", shopA.merchantId, "MERCHANT_ADMIN", ["merchant:read", "merchant:write", "onboarding:write"]);
  await makeUser("uploaderB", shopB.merchantId, "MERCHANT_ADMIN", ["merchant:read", "merchant:write", "onboarding:write"]);
});

afterAll(() => {
  server?.close();
});

describe.skipIf(!reachable)("wallet, balance, statement and export routes need a merchant authority", () => {
  const month = new Date().toISOString().slice(0, 7);
  const walletRoutes = (walletId: string) => [
    "/wallets",
    `/wallets/${walletId}`,
    `/wallets/${walletId}/balance`,
    `/wallets/${walletId}/statements`,
  ];

  test("a user holding only an unrelated or payment-only authority is refused every wallet read", async () => {
    for (const who of ["unrelated", "payer", "linker"]) {
      for (const path of walletRoutes(shopA.walletId)) {
        const response = await call(path, tokens[who]!);
        expect([who, path, response.status]).toEqual([who, path, 403]);
        expect(response.body.code).toBe("AUTHORITY_REQUIRED");
      }
      const exported = await call(`/wallets/${shopA.walletId}/statements/${month}/export`, tokens[who]!);
      expect(exported.status).toBe(403);
    }
  });

  test("merchant:read and merchant:write still read; only merchant:write exports", async () => {
    for (const who of ["reader", "admin"]) {
      for (const path of walletRoutes(shopA.walletId)) {
        expect([who, path, (await call(path, tokens[who]!)).status]).toEqual([who, path, 200]);
      }
    }
    expect((await call(`/wallets/${shopA.walletId}/statements/${month}/export`, tokens.reader!)).status).toBe(403);
    const exported = await call(`/wallets/${shopA.walletId}/statements/${month}/export`, tokens.admin!);
    expect(exported.status).toBe(200);
    expect(exported.raw.split("\n")[0]).toBe("reference,created_at,total_charged,commission,net_merchant,currency,status");
  });

  test("another merchant's wallet is still a 404", async () => {
    const response = await call(`/wallets/${shopB.walletId}/balance`, tokens.admin!);
    expect(response.status).toBe(404);
  });
});

describe.skipIf(!reachable)("links, payments, disputes and the overview follow their catalogue authority", () => {
  test("payment:read reads payments but not links; link:write reads both", async () => {
    expect((await call("/payments", tokens.payer!)).status).toBe(200);
    expect((await call("/links", tokens.payer!)).status).toBe(403);
    expect((await call(`/links/${shopA.linkFirst}`, tokens.payer!)).status).toBe(403);
    expect((await call("/links", tokens.linker!)).status).toBe(200);
    expect((await call("/payments", tokens.linker!)).status).toBe(200);
    expect((await call("/payments", tokens.unrelated!)).status).toBe(403);
    expect((await call("/links", tokens.unrelated!)).status).toBe(403);
    expect((await call("/disputes", tokens.unrelated!)).status).toBe(403);
    expect((await call("/applications", tokens.payer!)).status).toBe(403);
    expect((await call("/stats/overview", tokens.unrelated!)).status).toBe(403);
  });
});

describe.skipIf(!reachable)("a user scoped to applications only reaches those applications", () => {
  test("applications: the list is narrowed and the other application is forbidden", async () => {
    const list = await call("/applications", tokens.scoped!);
    expect(list.status).toBe(200);
    expect(list.body.applications.map((row: any) => row.id)).toEqual([shopA.appFirst]);
    expect((await call(`/applications/${shopA.appFirst}`, tokens.scoped!)).status).toBe(200);
    const other = await call(`/applications/${shopA.appSecond}`, tokens.scoped!);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("APP_SCOPE_VIOLATION");
    // An unscoped user still sees both.
    const all = await call("/applications", tokens.admin!);
    expect(all.body.applications.map((row: any) => row.id).sort()).toEqual([shopA.appFirst, shopA.appSecond].sort());
  });

  test("links: list, read, attempts and cancel are limited to the scope", async () => {
    const list = await call("/links", tokens.scoped!);
    expect(list.body.links.map((row: any) => row.id)).toEqual([shopA.linkFirst]);
    expect((await call(`/links/${shopA.linkFirst}`, tokens.scoped!)).status).toBe(200);
    for (const path of [`/links/${shopA.linkSecond}`, `/links/${shopA.linkSecond}/attempts`]) {
      const response = await call(path, tokens.scoped!);
      expect([path, response.status, response.body.code]).toEqual([path, 403, "APP_SCOPE_VIOLATION"]);
    }
    const cancel = await call(`/links/${shopA.linkSecond}/cancel`, tokens.scoped!, { method: "POST" });
    expect(cancel.status).toBe(403);
    expect((await client.paymentLink.findUnique({ where: { id: shopA.linkSecond } }))?.state).toBe("PENDING");
    // Asking for the other application explicitly returns nothing rather than leaking it.
    const filtered = await call(`/links?applicationId=${shopA.appSecond}`, tokens.scoped!);
    expect(filtered.body.links).toEqual([]);
  });

  test("link creation: an out-of-scope application is refused and the default comes from the scope", async () => {
    const refused = await postJson("/links", tokens.scoped!, {
      title: "x", amount: "5.0000", currency: "LYD", applicationId: shopA.appSecond,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("APP_SCOPE_VIOLATION");
    const before = await client.paymentLink.count({ where: { applicationId: shopA.appSecond } });
    // No application given: an unscoped user gets the OLDEST application (the second one here),
    // a scoped user must get one of their own.
    const created = await postJson("/links", tokens.scoped!, { title: "x", amount: "5.0000", currency: "LYD" });
    expect(created.status).toBe(201);
    const row = await client.paymentLink.findUnique({ where: { id: created.body.id } });
    expect(row?.applicationId).toBe(shopA.appFirst);
    expect(await client.paymentLink.count({ where: { applicationId: shopA.appSecond } })).toBe(before);
  });

  test("payments and statements only list the scoped application's attempts", async () => {
    const scoped = await call("/payments", tokens.scoped!);
    expect(scoped.body.payments.map((row: any) => row.reference)).toEqual([`SC-A1-${RUN}`]);
    expect((await call(`/payments?applicationId=${shopA.appSecond}`, tokens.scoped!)).body.payments).toEqual([]);
    const all = await call("/payments", tokens.admin!);
    expect(all.body.payments.map((row: any) => row.reference).sort()).toEqual([`SC-A1-${RUN}`, `SC-A2-${RUN}`]);
    const statements = await call(`/wallets/${shopA.walletId}/statements`, tokens.scoped!);
    expect(statements.body.attempts.map((row: any) => row.reference)).toEqual([`SC-A1-${RUN}`]);
  });

  test("the merchant-wide overview is refused to a scoped user", async () => {
    const response = await call("/stats/overview", tokens.scoped!);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("APP_SCOPE_RESTRICTED");
    expect((await call("/stats/overview", tokens.admin!)).status).toBe(200);
  });
});

describe.skipIf(!reachable)("KYB upload: duplicate document ids never cross merchants", () => {
  const pdf = (marker: string): Buffer => Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
  const upload = (token: string, bytes: Buffer): Promise<Res> =>
    call("/onboarding/kyb-documents", token, {
      method: "POST",
      body: bytes,
      headers: {
        "content-type": "application/pdf",
        "x-upload-content-type": "application/pdf",
        "x-upload-metadata": Buffer.from(JSON.stringify({ documentType: "COMMERCIAL_REGISTRY", fileName: "cr.pdf" })).toString("base64url"),
      },
    });

  test("the uploader sees only their own earlier copies; staff keep the cross-merchant trail", async () => {
    const bytes = pdf(`shared-${RUN}`);
    const first = await upload(tokens.uploaderB!, bytes);
    expect(first.status).toBe(201);
    expect(first.body.duplicateDocuments).toEqual([]);

    // Merchant A uploads the SAME file: nothing of merchant B may be reported back.
    const second = await upload(tokens.uploaderA!, bytes);
    expect(second.status).toBe(201);
    expect(second.body.duplicateDocuments).toEqual([]);
    expect(JSON.stringify(second.body)).not.toContain(first.body.id);

    // The audit row (staff only) still records the match so a reviewer can follow it.
    const audit = await client.auditLog.findFirst({ where: { entityId: second.body.id, action: "KYB_DOCUMENT_UPLOADED" } });
    expect((audit?.afterJson as any)?.duplicateDocuments).toContain(first.body.id);

    // A's own repeat upload does list A's earlier copy, and still not B's.
    const third = await upload(tokens.uploaderA!, bytes);
    expect(third.status).toBe(201);
    expect(third.body.duplicateDocuments).toEqual([second.body.id]);
  });
});

describe.skipIf(!reachable)("token and IP-allowlist changes leave audit rows", () => {
  const auditActions = async (entityId: string): Promise<string[]> =>
    (await client.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } })).map((row) => row.action);

  test("create, IP allow-list change and revoke are each audited, with the before/after CIDRs", async () => {
    const created = await postJson("/tokens", tokens.admin!, { name: `audit-${RUN}`, scopes: ["payment:read"] });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const ips = await call(`/tokens/${id}/ips`, tokens.admin!, {
      method: "PUT",
      body: JSON.stringify({ allowedCidrs: ["203.0.113.0/24"] }),
      headers: { "content-type": "application/json" },
    });
    expect(ips.status).toBe(200);
    const again = await call(`/tokens/${id}/ips`, tokens.admin!, {
      method: "PUT",
      body: JSON.stringify({ allowedCidrs: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(again.status).toBe(200);
    expect((await call(`/tokens/${id}`, tokens.admin!, { method: "DELETE" })).status).toBe(200);

    expect(await auditActions(id)).toEqual([
      "ACCESS_TOKEN_CREATED",
      "ACCESS_TOKEN_IP_ALLOWLIST_CHANGED",
      "ACCESS_TOKEN_IP_ALLOWLIST_CHANGED",
      "ACCESS_TOKEN_REVOKED",
    ]);
    const changes = await client.auditLog.findMany({
      where: { entityId: id, action: "ACCESS_TOKEN_IP_ALLOWLIST_CHANGED" },
      orderBy: { createdAt: "asc" },
    });
    expect(changes[0]?.beforeJson).toEqual({ allowedCidrs: [] });
    expect(changes[0]?.afterJson).toEqual({ allowedCidrs: ["203.0.113.0/24"] });
    expect(changes[1]?.beforeJson).toEqual({ allowedCidrs: ["203.0.113.0/24"] });
  });

  test("a user without token:manage changes nothing and leaves no audit row", async () => {
    const created = await postJson("/tokens", tokens.admin!, { name: `audit2-${RUN}`, scopes: ["payment:read"] });
    const id = created.body.id as string;
    const denied = await call(`/tokens/${id}`, tokens.reader!, { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect(await auditActions(id)).toEqual(["ACCESS_TOKEN_CREATED"]);
    expect((await client.accessToken.findUnique({ where: { id } }))?.revokedAt).toBeNull();
  });
});
