import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../../prisma/client";
import { adminLedgerRouter } from "../../api/internal/adminLedger";
import { auditRows, createStaffUser, dbAvailable, makePrincipal, startApp, uid, type TestApp, neutraliseLedgerSince } from "./harness";

let app: TestApp;
let userId: string;
const reader = () => makePrincipal(userId, ["finance:read"], "FINANCE");
const writer = () => makePrincipal(userId, ["finance:read", "finance:write"], "FINANCE");

type Line = { glAccountId: string; direction: "DEBIT" | "CREDIT"; amount: string };

const makeAccount = (accountType: "MERCHANT_WALLET" | "TREASURY" = "MERCHANT_WALLET", currency = "LYD") =>
  client.glAccount.create({ data: { accountType, currency, ownerId: randomUUID() } });

const post = async (lines: Line[], refType: "ADJUSTMENT" | "SETTLEMENT_SWEEP" = "ADJUSTMENT", description = "test entry") =>
  client.journalEntry.create({
    data: {
      refType,
      refId: uid("ref"),
      description,
      journalLines: { create: lines.map((line) => ({ ...line })) },
    },
  });

const startedAt = new Date(Date.now() - 2000);
if (dbAvailable) beforeAll(async () => {
  userId = await createStaffUser();
  app = await startApp([adminLedgerRouter]);
  app.setPrincipal(reader());
});
if (dbAvailable) afterAll(async () => {
  // The ledger is append-only: leave it system-wide balanced for the invariant suites.
  await neutraliseLedgerSince(startedAt);
  await app.close();
  await client.$disconnect();
});

describe.skipIf(!dbAvailable)("journal entries", () => {
  test("balanced and unbalanced entries are told apart in list, detail and summary", async () => {
    const a = await makeAccount();
    const b = await makeAccount("TREASURY");
    const before = (await app.request("GET", "/finance/journal-entries/summary")).json;
    const good = await post([
      { glAccountId: a.id, direction: "CREDIT", amount: "100.0000" },
      { glAccountId: b.id, direction: "DEBIT", amount: "100.0000" },
    ], "ADJUSTMENT", "balanced one");
    const bad = await post([
      { glAccountId: a.id, direction: "CREDIT", amount: "100.0000" },
      { glAccountId: b.id, direction: "DEBIT", amount: "90.5000" },
    ], "SETTLEMENT_SWEEP", "unbalanced one");

    const list = await app.request("GET", `/finance/journal-entries?glAccountId=${a.id}&pageSize=10`);
    expect(list.status).toBe(200);
    const byId = new Map<string, any>(list.json.journalEntries.map((entry: any) => [entry.id, entry]));
    expect(byId.get(good.id)).toMatchObject({ balanced: true, lineCount: 2, totalDebit: "100.0000", totalCredit: "100.0000", currency: "LYD" });
    expect(byId.get(bad.id)).toMatchObject({ balanced: false, totalDebit: "90.5000", totalCredit: "100.0000" });
    expect(list.json.total).toBe(2);

    const detail = await app.request("GET", `/finance/journal-entries/${bad.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.balanced).toBe(false);
    expect(detail.json.lines).toHaveLength(2);
    expect(detail.json.lines[0].glAccount).toHaveProperty("accountType");
    expect(detail.json.reference).toEqual({ type: "SETTLEMENT_SWEEP", id: bad.refId, route: "settlement" });

    const after = (await app.request("GET", "/finance/journal-entries/summary")).json;
    expect(after.window).toBe("7d");
    expect(after.unbalancedEntries).toBe(before.unbalancedEntries + 1);
    expect(after.totalEntries).toBe(before.totalEntries + 2);
    expect(after.entries24h).toBe(before.entries24h + 2);
    expect(after.volume24hByCurrency.find((row: any) => row.currency === "LYD")).toBeTruthy();
  });

  test("filters: refType, glAccountId, search, and invalid values are 400", async () => {
    const needle = uid("needle-description");
    const a = await makeAccount();
    const b = await makeAccount("TREASURY");
    const entry = await post([
      { glAccountId: a.id, direction: "CREDIT", amount: "5.0000" },
      { glAccountId: b.id, direction: "DEBIT", amount: "5.0000" },
    ], "SETTLEMENT_SWEEP", needle);
    const byType = await app.request("GET", `/finance/journal-entries?refType=SETTLEMENT_SWEEP&glAccountId=${a.id}`);
    expect(byType.json.journalEntries.map((e: any) => e.id)).toEqual([entry.id]);
    const none = await app.request("GET", `/finance/journal-entries?refType=ADJUSTMENT&glAccountId=${a.id}`);
    expect(none.json.journalEntries).toEqual([]);
    const bySearch = await app.request("GET", `/finance/journal-entries?search=${needle}`);
    expect(bySearch.json.journalEntries.map((e: any) => e.id)).toEqual([entry.id]);
    const byRef = await app.request("GET", `/finance/journal-entries?search=${entry.refId}`);
    expect(byRef.json.journalEntries.map((e: any) => e.id)).toEqual([entry.id]);
    const byUuid = await app.request("GET", `/finance/journal-entries?search=${entry.id}`);
    expect(byUuid.json.journalEntries.map((e: any) => e.id)).toEqual([entry.id]);
    expect((await app.request("GET", "/finance/journal-entries?refType=NOPE")).status).toBe(400);
    expect((await app.request("GET", "/finance/journal-entries?glAccountId=not-a-uuid")).status).toBe(400);
    expect((await app.request("GET", `/finance/journal-entries/${randomUUID()}`)).status).toBe(404);
    expect((await app.request("GET", "/finance/journal-entries/garbage")).json.code).toBe("JOURNAL_ENTRY_NOT_FOUND");
  });

  test("authority: finance:read is required", async () => {
    app.setPrincipal(makePrincipal(userId, ["merchant:read"]));
    const denied = await app.request("GET", "/finance/journal-entries");
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("AUTHORITY_REQUIRED");
    expect((await app.request("GET", "/finance/journal-entries/summary")).status).toBe(403);
    expect((await app.request("GET", `/finance/gl-accounts/${randomUUID()}`)).status).toBe(403);
    app.setPrincipal(reader());
  });
});

describe.skipIf(!dbAvailable)("GL account detail and checkpoint rollup", () => {
  test("shard breakdown comes from the shard sum; checkpoint rollup updates checkpointBalance and is audited", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET");
    const treasury = await makeAccount("TREASURY");
    await post([
      { glAccountId: wallet.id, direction: "CREDIT", amount: "100.0000" },
      { glAccountId: treasury.id, direction: "DEBIT", amount: "100.0000" },
    ]);
    await post([
      { glAccountId: wallet.id, direction: "DEBIT", amount: "30.0000" },
      { glAccountId: treasury.id, direction: "CREDIT", amount: "30.0000" },
    ]);
    // Shards are stored debit-positive: the wallet is in credit by 70.
    await client.glAccountShard.createMany({
      data: [
        { glAccountId: wallet.id, shardId: 0, currentBalance: "-50.0000" },
        { glAccountId: wallet.id, shardId: 1, currentBalance: "-20.0000" },
      ],
    });
    await client.glAccountShard.create({ data: { glAccountId: treasury.id, shardId: 0, currentBalance: "70.0000" } });

    const detail = await app.request("GET", `/finance/gl-accounts/${wallet.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.account).toMatchObject({ id: wallet.id, accountType: "MERCHANT_WALLET", currency: "LYD", checkpointBalance: "0.0000" });
    expect(detail.json.account.checkpointAt).toBeNull();
    expect(detail.json.shards.map((s: any) => [s.shardId, s.currentBalance])).toEqual([[0, "-50.0000"], [1, "-20.0000"]]);
    expect(detail.json.balanceSource).toBe("shards");
    expect(detail.json.liveBalance).toBe("-70.0000");
    expect(detail.json.naturalBalance).toBe("70.0000");
    expect(detail.json.recentLines).toHaveLength(2);
    expect(detail.json.recentLines[0]).toHaveProperty("refType");

    // Validation and authority gates.
    app.setPrincipal(reader());
    expect((await app.request("POST", `/finance/gl-accounts/${wallet.id}/checkpoint`, { reason: "long enough reason" })).status).toBe(403);
    app.setPrincipal(writer());
    const short = await app.request("POST", `/finance/gl-accounts/${wallet.id}/checkpoint`, { reason: "short" });
    expect(short.status).toBe(400);
    expect((await app.request("POST", `/finance/gl-accounts/${wallet.id}/checkpoint`, {})).status).toBe(400);
    expect((await app.request("POST", `/finance/gl-accounts/${randomUUID()}/checkpoint`, { reason: "long enough reason" })).status).toBe(404);

    const rolled = await app.request("POST", `/finance/gl-accounts/${wallet.id}/checkpoint`, { reason: "month end rollup" });
    expect(rolled.status).toBe(200);
    expect(rolled.json.account.checkpointBalance).toBe("-70.0000");
    expect(rolled.json.account.checkpointAt).not.toBeNull();
    expect(rolled.json.checkpoint.balance).toBe("-70.0000");
    expect(rolled.json.liveBalance).toBe("-70.0000");

    const audits = await auditRows("GL_ACCOUNT_CHECKPOINT_TRIGGERED", wallet.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(userId);
    expect((audits[0]!.afterJson as any).reason).toBe("month end rollup");
    expect((audits[0]!.afterJson as any).checkpointBalance).toBe("-70.0000");

    // A posting after the checkpoint moves the live balance, never the checkpoint.
    await post([
      { glAccountId: wallet.id, direction: "CREDIT", amount: "10.0000" },
      { glAccountId: treasury.id, direction: "DEBIT", amount: "10.0000" },
    ]);
    await client.glAccountShard.update({
      where: { glAccountId_shardId: { glAccountId: wallet.id, shardId: 0 } },
      data: { currentBalance: "-60.0000" },
    });
    const later = await app.request("GET", `/finance/gl-accounts/${wallet.id}`);
    expect(later.json.account.checkpointBalance).toBe("-70.0000");
    expect(later.json.liveBalance).toBe("-80.0000");
    expect(later.json.naturalBalance).toBe("80.0000");
  });

  test("an account without shard rows is read from checkpoint plus the journal", async () => {
    const treasury = await makeAccount("TREASURY");
    const wallet = await makeAccount("MERCHANT_WALLET");
    await post([
      { glAccountId: treasury.id, direction: "DEBIT", amount: "40.0000" },
      { glAccountId: wallet.id, direction: "CREDIT", amount: "40.0000" },
    ]);
    const detail = await app.request("GET", `/finance/gl-accounts/${treasury.id}`);
    expect(detail.json.balanceSource).toBe("journal");
    expect(detail.json.shards).toEqual([]);
    expect(detail.json.liveBalance).toBe("40.0000");
    expect(detail.json.naturalBalance).toBe("40.0000");
  });

  test("a shard total that disagrees with the journal refuses the checkpoint (409, no audit row)", async () => {
    const treasury = await makeAccount("TREASURY");
    const wallet = await makeAccount("MERCHANT_WALLET");
    await post([
      { glAccountId: treasury.id, direction: "DEBIT", amount: "25.0000" },
      { glAccountId: wallet.id, direction: "CREDIT", amount: "25.0000" },
    ]);
    await client.glAccountShard.create({ data: { glAccountId: treasury.id, shardId: 0, currentBalance: "999.0000" } });
    app.setPrincipal(writer());
    const refused = await app.request("POST", `/finance/gl-accounts/${treasury.id}/checkpoint`, { reason: "attempted rollup" });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("LEDGER_SHARD_PARITY_MISMATCH");
    expect(refused.json.details.drift).toBe("974.0000");
    expect(await auditRows("GL_ACCOUNT_CHECKPOINT_TRIGGERED", treasury.id)).toHaveLength(0);
    const detail = await app.request("GET", `/finance/gl-accounts/${treasury.id}`);
    expect(detail.json.account.checkpointBalance).toBe("0.0000");
  });

  test("unknown or malformed GL account ids are 404", async () => {
    app.setPrincipal(reader());
    expect((await app.request("GET", `/finance/gl-accounts/${randomUUID()}`)).json.code).toBe("GL_ACCOUNT_NOT_FOUND");
    expect((await app.request("GET", "/finance/gl-accounts/xyz")).status).toBe(404);
  });
});
