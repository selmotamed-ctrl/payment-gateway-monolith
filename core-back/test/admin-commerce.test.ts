/**
 * Admin commerce surface (wallets, applications, tokens, payment links, POS
 * terminals, beneficial owners, revalidations) against a real PostgreSQL 18
 * database, plus the enforcement of application / wallet / POS status on the
 * payment intake paths.
 *
 * Point it at a scratch database (never a live one):
 *   POSTGRES_TEST_DATABASE_URL=postgresql://... bun test test/admin-commerce.test.ts
 * The suite is skipped when the database is unreachable or its name does not
 * contain "test".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Prisma } from "../generated/prisma/client";
import { client } from "../prisma/client";
import { adminCommerceRouter } from "../api/internal/adminCommerce";
import { checkoutInternalRouter } from "../api/internal/checkout";
import { merchantInternalRouter } from "../api/internal/merchant";
import type { Principal } from "../api/middleware/authDoubleCheck";
import { LedgerPoster } from "../engine/ledger/LedgerPoster";
import { CheckpointService } from "../engine/ledger/CheckpointService";
import { executeApprovalSubject } from "../engine/governance/GovernanceExecution";
import { PrismaRepositories } from "../engine/db/repositories";
import { generateAccessToken, hashAccessToken, signSession } from "../lib/auth";
import { MemoryAuthStateStore } from "../lib/auth/sharedState";
import { setAuthStateStore } from "../lib/auth/sharedState";
import { isApiError, toErrorEnvelope } from "../lib/error";

const DATABASE_URL =
  process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = DATABASE_URL;

const RUN = randomUUID().replace(/-/g, "").slice(0, 12);

const databaseName = (): string => {
  try {
    return new URL(DATABASE_URL).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
};

const probe = async (): Promise<boolean> => {
  if (!/test/i.test(databaseName())) return false;
  try {
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
};
const reachable = await probe();

const principal = (over: Partial<Principal>): Principal => ({
  kind: "session",
  userId: null,
  role: "FINANCE",
  merchantId: null,
  applicationId: null,
  authorities: [],
  scopes: [],
  tokenId: null,
  sessionId: "s",
  sessionChannel: "admin",
  ...over,
});

const adminApp = express();
adminApp.use(express.json());
adminApp.use((request, _response, next) => {
  const key = request.header("x-principal");
  if (key && principals[key]) request.principal = principals[key];
  next();
});
adminApp.use("/", adminCommerceRouter);
const errorHandler = (error: unknown, _request: Request, response: Response, _next: unknown) => {
  response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
};
adminApp.use(errorHandler);

const edgeApp = express();
edgeApp.use(express.json());
edgeApp.use("/internal/merchant", merchantInternalRouter);
edgeApp.use("/internal/checkout", checkoutInternalRouter);
edgeApp.use(errorHandler);

const principals: Record<string, Principal> = {};
let adminServer: ReturnType<typeof adminApp.listen>;
let edgeServer: ReturnType<typeof edgeApp.listen>;
let adminUrl = "";
let edgeUrl = "";

type Res = { status: number; body: any; raw: string };
const send = async (base: string, path: string, init: RequestInit & { as?: string } = {}): Promise<Res> => {
  const { as, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: { "content-type": "application/json", ...(as ? { "x-principal": as } : {}), ...(rest.headers ?? {}) },
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
const admin = (path: string, as: string, method = "GET", payload?: unknown) =>
  send(adminUrl, path, { as, method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
const REASON = "Reviewed by the operations team";

interface Commerce {
  merchantId: string;
  walletId: string;
  glAccountId: string;
  applicationId: string;
  linkId: string;
  linkKey: string;
  terminalId: string;
  tokenId: string;
  tokenHash: string;
  tokenPlain: string;
}

let makerId = "";
let checkerId = "";
let railCode = "";
let commerce: Commerce;
let otherMerchantWalletId = "";
const governanceCtx = () => ({ ledgerPoster: {} as never, repositories: new PrismaRepositories(client as never) }) as never;

const makeCommerce = async (label: string): Promise<Commerce> => {
  const merchant = await client.merchant.create({
    data: {
      legalName: `Commerce ${label} ${RUN}`,
      tradeName: `C-${label}-${RUN}`,
      onboardingChannel: "E2E",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      activatedAt: new Date(),
      contactEmail: `commerce-${label}-${RUN}@gateway.test`,
      contactPhone: "+218910000001",
      negativeBalanceCeiling: new Prisma.Decimal(0),
    },
  });
  const glAccount = await client.glAccount.create({
    data: { accountType: "MERCHANT_WALLET", ownerId: merchant.id, currency: "LYD" },
  });
  // The wallet is funded with REAL postings (a balanced entry through the poster, so the ledger stays balanced and the
  // shard is consistent): 10.0000, then a shard checkpoint over it, then another 15.0000. Live balance 25.0000, derived
  // checkpoint 10.0000 with one line pending. The stored (debit-positive) shard values are -25 and -10.
  const funding = await client.glAccount.create({ data: { accountType: "TREASURY", currency: "LYD" } });
  const poster = new LedgerPoster(client as never);
  const fund = (amount: string, ref: string) =>
    poster.post(
      {
        refType: "ADJUSTMENT",
        refId: `commerce-fund-${label}-${RUN}-${ref}`,
        description: "commerce test funding",
        lines: [
          { direction: "DEBIT", amount, account: { accountType: "TREASURY", accountId: funding.id } },
          { direction: "CREDIT", amount, account: { accountType: "MERCHANT_WALLET", accountId: glAccount.id } },
        ],
      },
      { currency: "LYD" },
    );
  await fund("10.0000", "1");
  await new CheckpointService(client as never).captureAccount(glAccount.id);
  await fund("15.0000", "2");
  const wallet = await client.wallet.create({
    data: { merchantId: merchant.id, glAccountId: glAccount.id, currency: "LYD", status: "ACTIVE" },
  });
  const application = await client.application.create({
    data: {
      merchantId: merchant.id,
      name: `App ${label} ${RUN}`,
      expectedMonthlyVolume: new Prisma.Decimal(1000),
      assignedWalletId: wallet.id,
      status: "ACTIVE",
    },
  });
  const linkKey = `cm-${label}-${RUN}`;
  const link = await client.paymentLink.create({
    data: {
      key: linkKey,
      applicationId: application.id,
      walletId: wallet.id,
      amount: new Prisma.Decimal("10.0000"),
      currency: "LYD",
      feeBearer: "MERCHANT_ABSORBS",
      useCount: 1,
      state: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const terminal = await client.posTerminal.create({
    data: { applicationId: application.id, name: `POS ${label}`, location: "Tripoli", status: "ACTIVE" },
  });
  await client.posScreen.create({
    data: {
      posId: terminal.id,
      screenCode: `scr_${label}_${RUN}`,
      authTokenHash: createHash("sha256").update(`screen-${label}-${RUN}`).digest("hex"),
      lastActiveAt: new Date(),
    },
  });
  const tokenPlain = generateAccessToken();
  const token = await client.accessToken.create({
    data: {
      merchantId: merchant.id,
      applicationId: application.id,
      name: `token ${label}`,
      tokenHash: hashAccessToken(tokenPlain),
      lastFour: tokenPlain.slice(-4),
      scopes: ["link:write", "link:read"],
      ips: { create: [{ cidr: "10.0.0.0/8" }] },
      ipWhitelistEnabled: true,
    },
  });
  return {
    merchantId: merchant.id,
    walletId: wallet.id,
    glAccountId: glAccount.id,
    applicationId: application.id,
    linkId: link.id,
    linkKey,
    terminalId: terminal.id,
    tokenId: token.id,
    tokenHash: token.tokenHash,
    tokenPlain,
  };
};

const executeApproval = async (approvalId: string, checkerUserId: string) => {
  const approval = await client.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  return client.$transaction(async (tx) => {
    const result = await executeApprovalSubject(governanceCtx(), tx as never, {
      approval: approval as never,
      checkerUserId,
      checkerRole: "FINANCE",
    });
    await tx.approvalRequest.update({ where: { id: approvalId }, data: { state: "EXECUTED", checkerUserId } });
    return result;
  });
};

const auditActions = async (entityId: string): Promise<string[]> =>
  (await client.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } })).map((row) => row.action);

beforeAll(async () => {
  if (!reachable) return;
  // Session revocation state stays in memory: this suite never touches Redis.
  setAuthStateStore(new MemoryAuthStateStore());
  adminServer = adminApp.listen(0);
  edgeServer = edgeApp.listen(0);
  adminUrl = `http://127.0.0.1:${(adminServer.address() as { port: number }).port}`;
  edgeUrl = `http://127.0.0.1:${(edgeServer.address() as { port: number }).port}`;
  const userData = (label: string, checker: boolean) => ({
    email: `commerce-${label}-${RUN}@gateway.test`,
    role: "FINANCE" as const,
    status: "ACTIVE" as const,
    authoritiesMap: { "merchant:read": true },
    appScopeIds: [],
    isMaker: !checker,
    isChecker: checker,
    mfaRequired: false,
  });
  makerId = (await client.user.create({ data: userData("maker", false) })).id;
  checkerId = (await client.user.create({ data: userData("checker", true) })).id;
  principals.maker = principal({ userId: makerId, authorities: ["merchant:read", "merchant:write", "kyb:write"] });
  principals.checker = principal({ userId: checkerId, authorities: ["merchant:read", "approval:check"] });
  principals.finance = principal({ userId: makerId, authorities: ["merchant:read", "finance:read"] });
  principals.support = principal({ userId: makerId, role: "SUPPORT", authorities: ["merchant:read", "merchant:write"] });
  principals.reader = principal({ userId: makerId, authorities: ["merchant:read"] });
  principals.nobody = principal({ userId: makerId, authorities: ["settings:read"] });
  principals.kybOnly = principal({ userId: makerId, authorities: ["kyb:write"] });
  railCode = `cm-rail-${RUN}`;
  await client.rail.create({
    data: {
      code: railCode,
      nameAr: `سكة ${RUN}`,
      nameEn: `Rail ${RUN}`,
      collectionMode: "OTP_PULL",
      subModes: [],
      currency: "LYD",
      minAmount: new Prisma.Decimal(0),
      maxAmount: new Prisma.Decimal(1000),
      capabilities: {},
      metadata: {},
    },
  });
  commerce = await makeCommerce("a");
  const other = await makeCommerce("other");
  otherMerchantWalletId = other.walletId;
});

afterAll(async () => {
  adminServer?.close();
  edgeServer?.close();
});

describe.skipIf(!reachable)("wallets: visibility, authority and the freeze / unfreeze governance", () => {
  test("balances are redacted for principals without financial visibility", async () => {
    const support = await admin(`/wallets?merchantId=${commerce.merchantId}`, "support");
    expect(support.status).toBe(200);
    const row = support.body.wallets[0];
    expect(row.liveBalance).toBeNull();
    expect(row.checkpointBalance).toBeNull();
    expect(row.redactedFields).toContain("liveBalance");
    expect(row.merchant.legalName).toContain("Commerce a");

    const reader = await admin(`/wallets?merchantId=${commerce.merchantId}`, "reader");
    expect(reader.body.wallets[0].liveBalance).toBeNull();

    const finance = await admin(`/wallets?merchantId=${commerce.merchantId}`, "finance");
    expect(finance.body.wallets[0].liveBalance).toBe("25.0000");
    expect(finance.body.wallets[0].redactedFields).toEqual([]);
    expect(finance.body.wallets[0].pendingCashoutCount).toBe(0);
  });

  test("detail and summary redact money for support and show it to finance", async () => {
    const supportDetail = await admin(`/wallets/${commerce.walletId}`, "support");
    expect(supportDetail.status).toBe(200);
    expect(supportDetail.body.wallet.liveBalance).toBeNull();
    expect(supportDetail.body.wallet.shards).toEqual([]);
    expect(supportDetail.body.wallet.statementLines).toBeUndefined();
    expect(supportDetail.body.wallet.redactedFields).toContain("shards");

    const financeDetail = await admin(`/wallets/${commerce.walletId}`, "finance");
    expect(financeDetail.body.wallet.liveBalance).toBe("25.0000");
    expect(financeDetail.body.wallet.shards[0].currentBalance).toBe("-25.0000");
    expect(financeDetail.body.wallet.shards[0]).toMatchObject({ lineSeq: "2", checkpointSeq: "1", pendingLines: "1" });
    expect(financeDetail.body.wallet.glAccount.accountType).toBe("MERCHANT_WALLET");
    // The account stores no checkpoint: it is derived from the shard checkpoints, and shown in the natural sign like the
    // live balance (stored -10.0000 for a wallet in credit is 10.0000 here).
    expect(financeDetail.body.wallet.checkpointBalance).toBe("10.0000");
    expect(financeDetail.body.wallet.glAccount.checkpointBalance).toBe("10.0000");
    expect(financeDetail.body.wallet.glAccount.checkpointAt).not.toBeNull();
    expect(financeDetail.body.wallet.glAccount.pendingLines).toBe("1");
    expect(financeDetail.body.wallet.glAccount.shardCount).toBe(1);
    expect(supportDetail.body.wallet.checkpointBalance).toBeNull();
    expect(supportDetail.body.wallet.glAccount.checkpointBalance).toBeNull();
    expect(financeDetail.body.wallet.applications[0].id).toBe(commerce.applicationId);

    const supportSummary = await admin("/wallets/summary", "support");
    expect(supportSummary.body.totalBalanceByCurrency.every((entry: { total: unknown }) => entry.total === null)).toBe(true);
    const financeSummary = await admin("/wallets/summary", "finance");
    expect(financeSummary.status).toBe(200);
    expect(financeSummary.body.totalWallets).toBeGreaterThanOrEqual(2);
    const lyd = financeSummary.body.totalBalanceByCurrency.find((entry: { currency: string }) => entry.currency === "LYD");
    expect(typeof lyd.total).toBe("string");
    expect(lyd.total).toMatch(/^-?\d+\.\d{4}$/);
  });

  test("the statement is paginated, totalled and redacted for roles without financial visibility", async () => {
    const support = await admin(`/wallets/${commerce.walletId}/statement`, "support");
    expect(support.status).toBe(200);
    expect(support.body.lines).toEqual([]);
    expect(support.body.redactedFields).toEqual(["statementLines"]);
    expect(support.body.totals.totalDebit).toBeNull();

    const finance = await admin(`/wallets/${commerce.walletId}/statement?pageSize=5`, "finance");
    expect(finance.status).toBe(200);
    expect(finance.body.redactedFields).toEqual([]);
    expect(finance.body.currency).toBe("LYD");
    expect(Array.isArray(finance.body.lines)).toBe(true);
    expect(finance.body.pageSize).toBe(5);
    expect(finance.body.totals.lineCount).toBe(finance.body.total);
    expect(finance.body.totals.totalDebit).toMatch(/^\d+\.\d{4}$/);
    // The two funding postings are the wallet's whole statement: credits of 10.0000 and 15.0000.
    expect(finance.body.total).toBe(2);
    expect(finance.body.totals.totalCredit).toBe("25.0000");
    expect(finance.body.totals.totalDebit).toBe("0.0000");

    expect((await admin(`/wallets/${commerce.walletId}/statement?direction=SIDEWAYS`, "finance")).status).toBe(400);
    expect((await admin("/wallets/not-a-uuid/statement", "finance")).status).toBe(400);
    expect((await admin(`/wallets/${randomUUID()}/statement`, "finance")).status).toBe(404);
    expect((await admin(`/wallets/${commerce.walletId}/statement`, "nobody")).status).toBe(403);
  });

  test("authority and filter checks", async () => {
    expect((await admin("/wallets", "nobody")).status).toBe(403);
    expect((await admin("/wallets", "unknown-principal")).status).toBe(401);
    expect((await admin(`/wallets/${commerce.walletId}/status`, "reader", "POST", { status: "FROZEN", reason: REASON })).status).toBe(403);
    expect((await admin(`/wallets/${commerce.walletId}/status`, "kybOnly", "POST", { status: "FROZEN", reason: REASON })).status).toBe(403);
    expect((await admin("/wallets?status=BOGUS", "reader")).status).toBe(400);
    expect((await admin("/wallets/not-a-uuid", "reader")).status).toBe(400);
    expect((await admin(`/wallets/${randomUUID()}`, "reader")).status).toBe(404);
  });

  test("freeze is immediate and audited; invalid transitions are 409; the reason is mandatory", async () => {
    const short = await admin(`/wallets/${commerce.walletId}/status`, "maker", "POST", { status: "FROZEN", reason: "short" });
    expect(short.status).toBe(400);
    const missing = await admin(`/wallets/${commerce.walletId}/status`, "maker", "POST", { status: "FROZEN" });
    expect(missing.status).toBe(400);
    expect((await client.wallet.findUniqueOrThrow({ where: { id: commerce.walletId } })).status).toBe("ACTIVE");

    const frozen = await admin(`/wallets/${commerce.walletId}/status`, "maker", "POST", { status: "FROZEN", reason: REASON });
    expect(frozen.status).toBe(200);
    expect(frozen.body.wallet.status).toBe("FROZEN");
    expect(await auditActions(commerce.walletId)).toContain("WALLET_FROZEN");
    const history = await admin(`/wallets/${commerce.walletId}/audit-events`, "finance");
    expect(history.status).toBe(200);
    expect(history.body.auditEvents.map((event: { action: string }) => event.action)).toContain("WALLET_FROZEN");
    expect(history.body.total).toBeGreaterThanOrEqual(1);
    expect((await admin(`/wallets/${randomUUID()}/audit-events`, "finance")).status).toBe(404);
    expect((await admin(`/wallets/${commerce.walletId}/audit-events`, "nobody")).status).toBe(403);

    const again = await admin(`/wallets/${commerce.walletId}/status`, "maker", "POST", { status: "FROZEN", reason: REASON });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("WALLET_INVALID_TRANSITION");
  });

  test("unfreeze needs a checker: 202, one pending approval, wallet stays frozen until executed", async () => {
    const proposed = await admin(`/wallets/${commerce.walletId}/status`, "maker", "POST", { status: "ACTIVE", reason: REASON });
    expect(proposed.status).toBe(202);
    expect(proposed.body.state).toBe("PENDING_REVIEW");
    const approval = await client.approvalRequest.findUniqueOrThrow({ where: { id: proposed.body.approvalRequestId } });
    expect(approval.subjectType).toBe("WALLET");
    expect(approval.makerUserId).toBe(makerId);
    expect((approval.payloadDiffJson as Record<string, unknown>).fromStatus).toBe("FROZEN");
    expect((await client.wallet.findUniqueOrThrow({ where: { id: commerce.walletId } })).status).toBe("FROZEN");

    const duplicate = await admin(`/wallets/${commerce.walletId}/status`, "maker", "POST", { status: "ACTIVE", reason: REASON });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("WALLET_APPROVAL_PENDING");

    const detail = await admin(`/wallets/${commerce.walletId}`, "reader");
    expect(detail.body.wallet.pendingApprovals[0].id).toBe(approval.id);

    // maker != checker is enforced by the approval machinery.
    await expect(executeApproval(approval.id, makerId)).rejects.toMatchObject({ code: "APPROVAL_MAKER_EQUALS_CHECKER" });
    expect((await client.wallet.findUniqueOrThrow({ where: { id: commerce.walletId } })).status).toBe("FROZEN");

    const executed = await executeApproval(approval.id, checkerId);
    expect(executed.status).toBe("EXECUTED");
    expect((await client.wallet.findUniqueOrThrow({ where: { id: commerce.walletId } })).status).toBe("ACTIVE");
    const audit = await client.auditLog.findFirstOrThrow({ where: { entityId: commerce.walletId, action: "WALLET_UNFROZEN" } });
    expect(audit.approvalRequestId).toBe(approval.id);
    expect(audit.actorId).toBe(checkerId);
  });

  test("the executor re-validates the current state instead of trusting the request", async () => {
    const spare = await makeCommerce("spare");
    await client.wallet.update({ where: { id: spare.walletId }, data: { status: "FROZEN" } });
    const proposed = await admin(`/wallets/${spare.walletId}/status`, "maker", "POST", { status: "ACTIVE", reason: REASON });
    expect(proposed.status).toBe(202);
    // The wallet is closed before the checker acts.
    await client.wallet.update({ where: { id: spare.walletId }, data: { status: "CLOSED" } });
    await expect(executeApproval(proposed.body.approvalRequestId, checkerId)).rejects.toMatchObject({ code: "WALLET_STATE_CHANGED" });
    expect((await client.wallet.findUniqueOrThrow({ where: { id: spare.walletId } })).status).toBe("CLOSED");
    expect(await auditActions(spare.walletId)).not.toContain("WALLET_UNFROZEN");
    // An unrelated state (ACTIVE already) is an idempotent no-op, never a second audit row.
    await client.wallet.update({ where: { id: spare.walletId }, data: { status: "ACTIVE" } });
    const noop = await executeApproval(proposed.body.approvalRequestId, checkerId);
    expect(noop.idempotent).toBe(true);
  });
});

describe.skipIf(!reachable)("applications and access tokens", () => {
  test("list and detail expose the contract fields and never the token hash", async () => {
    const list = await admin(`/applications?merchantId=${commerce.merchantId}`, "reader");
    expect(list.status).toBe(200);
    const item = list.body.applications[0];
    expect(item.railWhitelist).toBeNull();
    expect(item.railWhitelistMode).toBe("ALL");
    expect(item.accessTokenCount).toBe(1);
    expect(item.assignedWallet.currency).toBe("LYD");
    expect(item.merchant.tradeName).toContain("C-a");

    const detail = await admin(`/applications/${commerce.applicationId}`, "reader");
    expect(detail.status).toBe(200);
    const token = detail.body.application.accessTokens[0];
    expect(token.status).toBe("ACTIVE");
    expect(token.cidrs).toEqual(["10.0.0.0/8"]);
    expect(token.scopes).toContain("link:write");
    expect(detail.raw).not.toContain(commerce.tokenHash);
    expect(detail.raw).not.toContain("tokenHash");
    expect(detail.body.application.paymentLinks[0].key).toBe(commerce.linkKey);
    expect(detail.body.application.posTerminals[0].screenCount).toBe(1);

    const summary = await admin("/applications/summary", "reader");
    expect(summary.body.total).toBeGreaterThanOrEqual(2);
    expect(summary.body.withoutWhitelist).toBeGreaterThanOrEqual(2);
  });

  test("suspension is immediate and audited; it can not be mixed with configuration edits", async () => {
    const mixed = await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", {
      status: "SUSPENDED",
      railWhitelist: [railCode],
      reason: REASON,
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.code).toBe("APPLICATION_SUSPEND_MUST_BE_ALONE");
    expect((await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", { status: "SUSPENDED", reason: "no" })).status).toBe(400);

    const suspended = await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", { status: "SUSPENDED", reason: REASON });
    expect(suspended.status).toBe(200);
    expect(suspended.body.application.status).toBe("SUSPENDED");
    expect(await auditActions(commerce.applicationId)).toContain("APPLICATION_SUSPENDED");

    const again = await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", { status: "SUSPENDED", reason: REASON });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("APPLICATION_INVALID_TRANSITION");
    expect((await admin(`/applications/${commerce.applicationId}`, "reader", "PATCH", { status: "SUSPENDED", reason: REASON })).status).toBe(403);
  });

  test("reactivation goes through an approval, re-validated at execution", async () => {
    const proposed = await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", { status: "ACTIVE", reason: REASON });
    expect(proposed.status).toBe(202);
    const approval = await client.approvalRequest.findUniqueOrThrow({ where: { id: proposed.body.approvalRequestId } });
    expect(approval.subjectType).toBe("APPLICATION");
    expect((await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } })).status).toBe("SUSPENDED");
    expect((await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", { status: "ACTIVE", reason: REASON })).body.code)
      .toBe("APPLICATION_APPROVAL_PENDING");

    await expect(executeApproval(approval.id, makerId)).rejects.toMatchObject({ code: "APPROVAL_MAKER_EQUALS_CHECKER" });

    // Someone else already moved the application: the stale approval is refused.
    await client.application.update({ where: { id: commerce.applicationId }, data: { status: "CLOSED" } });
    await expect(executeApproval(approval.id, checkerId)).rejects.toMatchObject({ code: "APPLICATION_STATE_CHANGED" });
    expect((await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } })).status).toBe("CLOSED");
    await client.application.update({ where: { id: commerce.applicationId }, data: { status: "SUSPENDED" } });
    await client.approvalRequest.update({ where: { id: approval.id }, data: { state: "REJECTED" } });

    const fresh = await admin(`/applications/${commerce.applicationId}`, "maker", "PATCH", { status: "ACTIVE", reason: REASON });
    expect(fresh.status).toBe(202);
    const executed = await executeApproval(fresh.body.approvalRequestId, checkerId);
    expect(executed.status).toBe("EXECUTED");
    expect((await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } })).status).toBe("ACTIVE");
    const audit = await client.auditLog.findFirstOrThrow({ where: { entityId: commerce.applicationId, action: "APPLICATION_REACTIVATED" } });
    expect(audit.approvalRequestId).toBe(fresh.body.approvalRequestId);
  });

  test("whitelist / allowlist / wallet edits are one approval each, validated up front", async () => {
    const path = `/applications/${commerce.applicationId}`;
    const unknownRail = await admin(path, "maker", "PATCH", { railWhitelist: ["no-such-rail"], reason: REASON });
    expect(unknownRail.status).toBe(422);
    expect(unknownRail.body.code).toBe("RAIL_NOT_FOUND");
    expect((await admin(path, "maker", "PATCH", { redirectDomainAllowlist: ["http://insecure.example"], reason: REASON })).body.code)
      .toBe("REDIRECT_DOMAIN_INVALID");
    expect((await admin(path, "maker", "PATCH", { redirectDomainAllowlist: ["https://shop.example.com/path"], reason: REASON })).status).toBe(400);
    const foreignWallet = await admin(path, "maker", "PATCH", { assignedWalletId: otherMerchantWalletId, reason: REASON });
    expect(foreignWallet.status).toBe(404);
    expect((await admin(path, "maker", "PATCH", { reason: REASON })).body.code).toBe("APPLICATION_UPDATE_REQUIRED");
    expect((await admin(path, "maker", "PATCH", { railWhitelist: null, reason: REASON })).body.code).toBe("APPLICATION_NO_CHANGE");

    const proposed = await admin(path, "maker", "PATCH", {
      railWhitelist: [railCode],
      redirectDomainAllowlist: ["Shop.Example.com", "https://pay.example.com"],
      reason: REASON,
    });
    expect(proposed.status).toBe(202);
    expect((await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } })).railWhitelist).toBeNull();
    expect(await client.approvalRequest.count({ where: { subjectId: commerce.applicationId, state: "PENDING_REVIEW" } })).toBe(1);

    const executed = await executeApproval(proposed.body.approvalRequestId, checkerId);
    expect(executed.status).toBe("EXECUTED");
    const updated = await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } });
    expect(updated.railWhitelist).toEqual([railCode]);
    expect(updated.redirectDomainAllowlist).toEqual(["shop.example.com", "https://pay.example.com"]);

    // Back to "all rails" (null) goes through the same approval and clears the column.
    const clear = await admin(path, "maker", "PATCH", { railWhitelist: null, reason: REASON });
    expect(clear.status).toBe(202);
    await executeApproval(clear.body.approvalRequestId, checkerId);
    expect((await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } })).railWhitelist).toBeNull();
  });

  test("an approval of a rail removed meanwhile is refused at execution", async () => {
    const path = `/applications/${commerce.applicationId}`;
    const ephemeral = `cm-eph-${RUN}`;
    const rail = await client.rail.create({
      data: { code: ephemeral, nameAr: "x", nameEn: "x", collectionMode: "OTP_PULL", subModes: [], currency: "LYD", minAmount: new Prisma.Decimal(0), capabilities: {}, metadata: {} },
    });
    const proposed = await admin(path, "maker", "PATCH", { railWhitelist: [ephemeral], reason: REASON });
    expect(proposed.status).toBe(202);
    await client.rail.delete({ where: { id: rail.id } });
    await expect(executeApproval(proposed.body.approvalRequestId, checkerId)).rejects.toMatchObject({ code: "RAIL_NOT_FOUND" });
    expect((await client.application.findUniqueOrThrow({ where: { id: commerce.applicationId } })).railWhitelist).toBeNull();
    await client.approvalRequest.update({ where: { id: proposed.body.approvalRequestId }, data: { state: "REJECTED" } });
  });

  test("token revoke is immediate, audited, idempotent (409) and never exposes the hash", async () => {
    const path = `/applications/${commerce.applicationId}/tokens/${commerce.tokenId}/revoke`;
    expect((await admin(path, "maker", "POST", { reason: "short" })).status).toBe(400);
    expect((await admin(path, "reader", "POST", { reason: REASON })).status).toBe(403);
    expect((await admin(`/applications/${commerce.applicationId}/tokens/${randomUUID()}/revoke`, "maker", "POST", { reason: REASON })).status).toBe(404);

    const revoked = await admin(path, "maker", "POST", { reason: REASON });
    expect(revoked.status).toBe(200);
    expect(revoked.body.token.status).toBe("REVOKED");
    expect(revoked.raw).not.toContain(commerce.tokenHash);
    expect(revoked.raw).not.toContain("tokenHash");
    const row = await client.accessToken.findUniqueOrThrow({ where: { id: commerce.tokenId } });
    expect(row.revokedAt).not.toBeNull();
    const audit = await client.auditLog.findFirstOrThrow({ where: { entityId: commerce.tokenId, action: "ACCESS_TOKEN_REVOKED" } });
    expect(JSON.stringify(audit)).not.toContain(commerce.tokenHash);

    const again = await admin(path, "maker", "POST", { reason: REASON });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("TOKEN_ALREADY_REVOKED");

    // The merchant channel reads the row on every request: the revoked token is refused.
    const refused = await send(edgeUrl, "/internal/merchant/external/links", {
      method: "POST",
      headers: { authorization: `Bearer ${commerce.tokenPlain}`, "x-real-client-ip": "10.1.1.1" },
      body: JSON.stringify({ title: "x", amount: "1.0000", currency: "LYD" }),
    });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("ACCESS_TOKEN_REVOKED");

    const detail = await admin(`/applications/${commerce.applicationId}`, "reader");
    expect(detail.body.application.accessTokens[0].status).toBe("REVOKED");
  });
});

describe.skipIf(!reachable)("payment links and POS terminals", () => {
  test("a pending link is cancelled immediately with an audit; other states are 409", async () => {
    const list = await admin(`/payment-links?applicationId=${commerce.applicationId}&state=PENDING&search=cm-a`, "reader");
    expect(list.status).toBe(200);
    expect(list.body.paymentLinks[0].key).toBe(commerce.linkKey);
    expect(list.body.paymentLinks[0].amount).toBe("10.0000");
    expect(list.body.paymentLinks[0].merchant.id).toBe(commerce.merchantId);

    const path = `/payment-links/${commerce.linkId}/state`;
    expect((await admin(path, "maker", "POST", { state: "CANCELLED", reason: "x" })).status).toBe(400);
    expect((await admin(path, "maker", "POST", { state: "PENDING", reason: REASON })).status).toBe(400);
    expect((await admin(path, "reader", "POST", { state: "CANCELLED", reason: REASON })).status).toBe(403);
    const cancelled = await admin(path, "maker", "POST", { state: "CANCELLED", reason: REASON });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.paymentLink.state).toBe("CANCELLED");
    expect(await auditActions(commerce.linkId)).toContain("PAYMENT_LINK_CANCELLED");
    const again = await admin(path, "maker", "POST", { state: "CANCELLED", reason: REASON });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PAYMENT_LINK_INVALID_TRANSITION");
  });

  test("POS: tightening is immediate, an unblock is an approval; the screen token hash never leaks", async () => {
    const list = await admin(`/pos-terminals?applicationId=${commerce.applicationId}`, "reader");
    expect(list.status).toBe(200);
    expect(list.body.posTerminals[0].screenCount).toBe(1);
    expect(list.body.posTerminals[0].lastActiveAt).not.toBeNull();
    expect(list.raw).not.toContain("authTokenHash");
    expect(list.raw).not.toContain(createHash("sha256").update(`screen-a-${RUN}`).digest("hex"));

    const path = `/pos-terminals/${commerce.terminalId}/status`;
    expect((await admin(path, "maker", "POST", { status: "BLOCKED", reason: "short" })).status).toBe(400);
    expect((await admin(path, "reader", "POST", { status: "BLOCKED", reason: REASON })).status).toBe(403);
    expect((await admin(path, "maker", "POST", { status: "ACTIVE", reason: REASON })).body.code).toBe("POS_TERMINAL_INVALID_TRANSITION");

    const blocked = await admin(path, "maker", "POST", { status: "BLOCKED", reason: REASON });
    expect(blocked.status).toBe(200);
    expect(blocked.body.posTerminal.status).toBe("BLOCKED");
    expect(blocked.raw).not.toContain("authTokenHash");
    expect(await auditActions(commerce.terminalId)).toContain("POS_TERMINAL_STATUS_CHANGED");
    expect((await admin(path, "maker", "POST", { status: "INACTIVE", reason: REASON })).status).toBe(409);

    const proposed = await admin(path, "maker", "POST", { status: "ACTIVE", reason: REASON });
    expect(proposed.status).toBe(202);
    expect((await client.posTerminal.findUniqueOrThrow({ where: { id: commerce.terminalId } })).status).toBe("BLOCKED");
    await expect(executeApproval(proposed.body.approvalRequestId, makerId)).rejects.toMatchObject({ code: "APPROVAL_MAKER_EQUALS_CHECKER" });

    // The terminal changed state meanwhile: the approval is stale.
    await client.posTerminal.update({ where: { id: commerce.terminalId }, data: { status: "INACTIVE" } });
    await expect(executeApproval(proposed.body.approvalRequestId, checkerId)).rejects.toMatchObject({ code: "POS_TERMINAL_STATE_CHANGED" });
    await client.posTerminal.update({ where: { id: commerce.terminalId }, data: { status: "BLOCKED" } });

    expect((await executeApproval(proposed.body.approvalRequestId, checkerId)).status).toBe("EXECUTED");
    expect((await client.posTerminal.findUniqueOrThrow({ where: { id: commerce.terminalId } })).status).toBe("ACTIVE");
    expect(await auditActions(commerce.terminalId)).toEqual([
      "POS_TERMINAL_STATUS_CHANGED",
      "POS_TERMINAL_REACTIVATE_REQUESTED",
      "POS_TERMINAL_STATUS_CHANGED",
    ]);
  });
});

describe.skipIf(!reachable)("merchant beneficial owners and revalidations", () => {
  const ownerPath = () => `/merchants/${commerce.merchantId}/beneficial-owners`;
  const NATIONAL_ID = "119900112233";

  test("create stores the national id encrypted and never returns it", async () => {
    expect((await admin(ownerPath(), "reader", "POST", { fullName: "Ali Test", identityType: "NATIONAL_ID", identityNumber: NATIONAL_ID })).status).toBe(403);
    expect((await admin(ownerPath(), "maker", "POST", { fullName: "A", identityType: "NATIONAL_ID", identityNumber: NATIONAL_ID })).status).toBe(400);
    const created = await admin(ownerPath(), "maker", "POST", {
      fullName: "Ali Test",
      fullNameEn: "Ali Test",
      identityType: "NATIONAL_ID",
      identityNumber: NATIONAL_ID,
      dateOfBirth: "1980-01-02",
      ownershipPercent: "60",
      nationality: "ly",
    });
    expect(created.status).toBe(201);
    expect(created.raw).not.toContain(NATIONAL_ID);
    expect(created.raw.toLowerCase()).not.toContain("ciphertext");
    expect(created.body.beneficialOwner.nationality).toBe("LY");
    expect(created.body.beneficialOwner.screeningStatus).toBe("NOT_SCREENED");
    const row = await client.beneficialOwner.findUniqueOrThrow({ where: { id: created.body.beneficialOwner.id } });
    expect(row.nationalIdCiphertext).not.toContain(NATIONAL_ID);
    expect(row.nationalIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditActions(row.id)).toContain("BENEFICIAL_OWNER_ADDED");
    expect(JSON.stringify(await client.auditLog.findMany({ where: { entityId: row.id } }))).not.toContain(NATIONAL_ID);

    const list = await admin(ownerPath(), "reader");
    expect(list.status).toBe(200);
    expect(list.body.beneficialOwners).toHaveLength(1);
    expect(list.raw).not.toContain(NATIONAL_ID);
    expect(list.raw.toLowerCase()).not.toContain("nationalid");
  });

  test("edit resets the screening status; ownership above 100 percent and edits of inactive owners are refused", async () => {
    const owner = (await client.beneficialOwner.findFirstOrThrow({ where: { merchantId: commerce.merchantId } }));
    await client.beneficialOwner.update({ where: { id: owner.id }, data: { screeningStatus: "CLEAR" } });
    expect((await admin(`${ownerPath()}/${owner.id}`, "maker", "PATCH", {})).status).toBe(400);
    const edited = await admin(`${ownerPath()}/${owner.id}`, "maker", "PATCH", { fullName: "Ali Renamed" });
    expect(edited.status).toBe(200);
    expect(edited.body.beneficialOwner.fullNameAr).toBe("Ali Renamed");
    expect(edited.body.beneficialOwner.screeningStatus).toBe("NOT_SCREENED");
    // A role change alone does not invalidate the screening.
    await client.beneficialOwner.update({ where: { id: owner.id }, data: { screeningStatus: "CLEAR" } });
    const roleOnly = await admin(`${ownerPath()}/${owner.id}`, "maker", "PATCH", { role: "DIRECTOR" });
    expect(roleOnly.body.beneficialOwner.screeningStatus).toBe("CLEAR");

    const tooMuch = await admin(ownerPath(), "maker", "POST", {
      fullName: "Second Owner", identityType: "PASSPORT", identityNumber: "P1234567", ownershipPercent: "45",
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe("OWNERSHIP_PERCENT_EXCEEDED");

    const removed = await admin(`${ownerPath()}/${owner.id}`, "maker", "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.body.active).toBe(false);
    const row = await client.beneficialOwner.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.active).toBe(false);
    expect(row.validTo).not.toBeNull();
    expect(await auditActions(owner.id)).toContain("BENEFICIAL_OWNER_DEACTIVATED");
    expect((await admin(`${ownerPath()}/${owner.id}`, "maker", "DELETE")).status).toBe(404);
    expect((await admin(`${ownerPath()}/${owner.id}`, "maker", "PATCH", { fullName: "Nope Nope" })).status).toBe(409);
  });

  test("a revalidation request is created once per document type and audited", async () => {
    const path = `/merchants/${commerce.merchantId}/revalidations`;
    const due = new Date(Date.now() + 14 * 86_400_000).toISOString();
    expect((await admin(path, "reader", "POST", { docType: "OWNER_ID", dueAt: due, message: "Please upload" })).status).toBe(403);
    expect((await admin(path, "maker", "POST", { docType: "NOPE", dueAt: due, message: "Please upload" })).status).toBe(400);
    expect((await admin(path, "maker", "POST", { docType: "OWNER_ID", dueAt: "2020-01-01", message: "Please upload" })).status).toBe(400);
    const created = await admin(path, "maker", "POST", { docType: "OWNER_ID", dueAt: due, message: "Please upload a fresh ID" });
    expect(created.status).toBe(201);
    expect(created.body.revalidation.status).toBe("OPEN");
    expect(created.body.revalidation.reasonCode).toBe("MERCHANT_REVALIDATION");
    expect(await auditActions(created.body.revalidation.id)).toContain("KYB_REVALIDATION_REQUESTED");
    const duplicate = await admin(path, "maker", "POST", { docType: "OWNER_ID", dueAt: due, message: "Please upload a fresh ID" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("KYB_REVALIDATION_ALREADY_OPEN");
  });
});

describe.skipIf(!reachable)("enforcement: a suspended application / frozen wallet / blocked terminal takes in no payment", () => {
  let enforced: Commerce;
  const initiate = (key: string) =>
    send(edgeUrl, `/internal/checkout/pay/${key}/initiate`, {
      method: "POST",
      body: JSON.stringify({ railCode: "edfali", formData: {}, idempotencyKey: `idem-${randomUUID().slice(0, 12)}` }),
    });
  const externalLink = (token: string) =>
    send(edgeUrl, "/internal/merchant/external/links", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-real-client-ip": "10.1.1.1" },
      body: JSON.stringify({ title: "Invoice", amount: "5.0000", currency: "LYD" }),
    });
  let sessionToken = "";
  const streamStatus = async (merchantToken: string, code: string) => {
    const controller = new AbortController();
    const response = await fetch(`${edgeUrl}/internal/merchant/pos/screens/${code}/stream`, {
      headers: { authorization: `Bearer ${merchantToken}`, "x-real-client-ip": "10.1.1.1" },
      signal: controller.signal,
    });
    const status = response.status;
    const body = status === 200 ? "" : await response.text();
    controller.abort();
    return { status, body };
  };

  beforeAll(async () => {
    enforced = await makeCommerce("enf");
    const user = await client.user.create({
      data: {
        email: `commerce-merchant-${RUN}@gateway.test`,
        role: "MERCHANT_ADMIN",
        status: "ACTIVE",
        merchantId: enforced.merchantId,
        authoritiesMap: { "pos:manage": true },
        appScopeIds: [],
        isMaker: false,
        isChecker: false,
        mfaRequired: false,
      },
    });
    sessionToken = signSession(
      { sub: user.id, role: "MERCHANT_ADMIN", merchantId: enforced.merchantId, authorities: ["pos:manage"], appScopeIds: [], mfa: true },
      "merchant",
    );
  });

  test("control: an active application and wallet pass the status gate", async () => {
    const response = await initiate(enforced.linkKey);
    expect(["APPLICATION_NOT_ACTIVE", "WALLET_NOT_ACTIVE"]).not.toContain(response.body.code);
    const created = await externalLink(enforced.tokenPlain);
    expect(created.status).toBe(201);
    expect(created.body.key).toBeTruthy();
  });

  test("a frozen wallet blocks checkout intake and link creation (WALLET_NOT_ACTIVE)", async () => {
    await client.wallet.update({ where: { id: enforced.walletId }, data: { status: "FROZEN" } });
    const linksBefore = await client.paymentLink.count({ where: { applicationId: enforced.applicationId } });
    const checkout = await initiate(enforced.linkKey);
    expect(checkout.status).toBe(409);
    expect(checkout.body.code).toBe("WALLET_NOT_ACTIVE");
    const link = await externalLink(enforced.tokenPlain);
    expect(link.status).toBe(409);
    expect(link.body.code).toBe("WALLET_NOT_ACTIVE");
    expect(await client.paymentLink.count({ where: { applicationId: enforced.applicationId } })).toBe(linksBefore);
    expect(await client.paymentAttempt.count({ where: { linkId: enforced.linkId } })).toBe(0);
    await client.wallet.update({ where: { id: enforced.walletId }, data: { status: "ACTIVE" } });
  });

  test("a suspended application blocks checkout intake and link creation (APPLICATION_NOT_ACTIVE)", async () => {
    await client.application.update({ where: { id: enforced.applicationId }, data: { status: "SUSPENDED" } });
    const checkout = await initiate(enforced.linkKey);
    expect(checkout.status).toBe(409);
    expect(checkout.body.code).toBe("APPLICATION_NOT_ACTIVE");
    const confirm = await send(edgeUrl, `/internal/checkout/pay/${enforced.linkKey}/logs/${randomUUID()}/confirm`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "idem-confirm-0001" }),
    });
    expect(confirm.status).toBe(404);
    const link = await externalLink(enforced.tokenPlain);
    expect(link.status).toBe(409);
    expect(link.body.code).toBe("APPLICATION_NOT_ACTIVE");
    await client.application.update({ where: { id: enforced.applicationId }, data: { status: "ACTIVE" } });
  });

  test("a screen of a non-active terminal does not authenticate (POS_TERMINAL_NOT_ACTIVE)", async () => {
    await client.posTerminal.update({ where: { id: enforced.terminalId }, data: { status: "BLOCKED" } });
    const refused = await streamStatus(sessionToken, `scr_enf_${RUN}`);
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body).code).toBe("POS_TERMINAL_NOT_ACTIVE");
    await client.posTerminal.update({ where: { id: enforced.terminalId }, data: { status: "INACTIVE" } });
    expect((await streamStatus(sessionToken, `scr_enf_${RUN}`)).status).toBe(409);
    await client.posTerminal.update({ where: { id: enforced.terminalId }, data: { status: "ACTIVE" } });
    expect((await streamStatus(sessionToken, `scr_enf_${RUN}`)).status).toBe(200);
  });

  test("the merchant can neither lift a BLOCKED terminal nor mint screens for a non-active one", async () => {
    const merchantCall = (path: string, method: string, payload?: unknown) =>
      send(edgeUrl, `/internal/merchant${path}`, {
        method,
        headers: { authorization: `Bearer ${sessionToken}`, "x-real-client-ip": "10.1.1.1" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    await client.posTerminal.update({ where: { id: enforced.terminalId }, data: { status: "BLOCKED" } });
    const lift = await merchantCall(`/pos/terminals/${enforced.terminalId}`, "PATCH", { status: "ACTIVE" });
    expect(lift.status).toBe(409);
    expect(lift.body.code).toBe("POS_TERMINAL_BLOCKED");
    const screen = await merchantCall(`/pos/terminals/${enforced.terminalId}/screens`, "POST");
    expect(screen.status).toBe(409);
    expect(screen.body.code).toBe("POS_TERMINAL_NOT_ACTIVE");
    expect((await client.posTerminal.findUniqueOrThrow({ where: { id: enforced.terminalId } })).status).toBe("BLOCKED");
    await client.posTerminal.update({ where: { id: enforced.terminalId }, data: { status: "ACTIVE" } });
  });
});
