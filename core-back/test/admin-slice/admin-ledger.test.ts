import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../../prisma/client";
import { adminLedgerRouter } from "../../api/internal/adminLedger";
import { clearShardWidthCache, routeLine } from "../../lib/storageEngine/shardRouting";
import { auditRows, createStaffUser, dbAvailable, makePrincipal, postEntry, startApp, uid, type TestApp, neutraliseLedgerSince } from "./harness";

let app: TestApp;
let userId: string;
const reader = () => makePrincipal(userId, ["finance:read"], "FINANCE");
const writer = () => makePrincipal(userId, ["finance:read", "finance:write"], "FINANCE");

type Line = { glAccountId: string; direction: "DEBIT" | "CREDIT"; amount: string };

const makeAccount = (accountType: "MERCHANT_WALLET" | "TREASURY" = "MERCHANT_WALLET", currency = "LYD") =>
  client.glAccount.create({ data: { accountType, currency, ownerId: randomUUID() } });

/** Balanced entries go through the real LedgerPoster, a deliberately unbalanced one through the shard writer (see harness). */
const post = async (lines: Line[], refType: "ADJUSTMENT" | "SETTLEMENT_SWEEP" = "ADJUSTMENT", description = "test entry") => {
  const entry = await postEntry(lines, refType, description);
  return { id: entry.id, refId: entry.refId };
};

/** A reference id whose posting routes a CREDIT of `accountType` to `shard` at routing width `width`. */
const refForShard = (accountType: string, width: number, shard: number): string => {
  for (let index = 0; index < 10_000; index += 1) {
    const refId = `${uid("ref")}-${index}`;
    if (routeLine(accountType, "CREDIT", refId, width) === shard) return refId;
  }
  throw new Error("no reference found for the shard");
};

const setShardBalance = (accountId: string, shardId: number, balance: string) =>
  client.$executeRawUnsafe(
    `UPDATE gl_account_shards SET current_balance = $3::numeric WHERE gl_account_id = $1::uuid AND shard_id = $2`,
    accountId,
    shardId,
    balance,
  );

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
    expect((await app.request("GET", `/finance/gl-accounts/${randomUUID()}/lines`)).status).toBe(403);
    app.setPrincipal(reader());
  });
});

describe.skipIf(!dbAvailable)("GL account detail and checkpoint rollup", () => {
  test("shard breakdown comes from the shard sum; checkpoint rollup advances every shard (O(delta)) and is audited", async () => {
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
    // Widen the wallet to two shards (the admin override), then post a credit that routes to shard 1.
    app.setPrincipal(writer());
    const scaled = await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, { width: 2, reason: "spread the wallet" });
    expect(scaled.status).toBe(200);
    expect(scaled.json.scaled).toEqual({ from: 1, to: 2 });
    clearShardWidthCache();
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "CREDIT", amount: "20.0000" },
        { glAccountId: treasury.id, direction: "DEBIT", amount: "20.0000" },
      ],
      "ADJUSTMENT",
      "second shard",
      refForShard("MERCHANT_WALLET", 2, 1),
    );
    app.setPrincipal(reader());

    // Shards are stored debit-positive: the wallet is in credit by 90 (shard 0: -70, shard 1: -20).
    const detail = await app.request("GET", `/finance/gl-accounts/${wallet.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.account).toMatchObject({ id: wallet.id, accountType: "MERCHANT_WALLET", currency: "LYD", checkpointBalance: "0.0000", shardCount: 2 });
    expect(detail.json.account.checkpointAt).toBeNull();
    expect(detail.json.account.shardScaledAt).not.toBeNull();
    expect(detail.json.shards.map((s: any) => [s.shardId, s.currentBalance, s.lineSeq, s.pendingLines, s.status])).toEqual([
      [0, "-70.0000", "2", "2", "OK"],
      [1, "-20.0000", "1", "1", "OK"],
    ]);
    expect(detail.json.shards.every((s: any) => s.checkpointSeq === "0" && s.checkpointBalance === "0.0000" && s.checkpointAt === null)).toBe(true);
    expect(detail.json.checkpoint).toEqual({ status: "OK", pendingLines: "3", shardsBehind: 2 });
    expect(detail.json.balanceSource).toBe("shards");
    expect(detail.json.liveBalance).toBe("-90.0000");
    expect(detail.json.naturalBalance).toBe("90.0000");
    // The snapshot no longer embeds a fixed page of lines: they have their own paginated call.
    expect(detail.json.recentLines).toBeUndefined();

    const lines = await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines`);
    expect(lines.status).toBe(200);
    expect(lines.json.total).toBe(3);
    expect(lines.json.lines).toHaveLength(3);
    expect(lines.json.lines[0]).toHaveProperty("refType");
    expect(lines.json.lines[0]).toHaveProperty("entryId");
    // Totals describe the whole filtered set, not the visible page.
    expect(lines.json.totals).toEqual({ lineCount: 3, totalDebit: "30.0000", totalCredit: "120.0000", netDebit: "-90.0000" });

    const firstPage = await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines?pageSize=1&page=1`);
    const secondPage = await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines?pageSize=1&page=2`);
    expect(firstPage.json.lines).toHaveLength(1);
    expect(secondPage.json.lines).toHaveLength(1);
    expect(firstPage.json.lines[0].lineId).not.toBe(secondPage.json.lines[0].lineId);
    expect(firstPage.json.total).toBe(3);
    expect(firstPage.json.totals.totalCredit).toBe("120.0000");

    const debits = await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines?direction=DEBIT`);
    expect(debits.json.lines.map((l: any) => l.direction)).toEqual(["DEBIT"]);
    expect(debits.json.totals).toMatchObject({ lineCount: 1, totalDebit: "30.0000", totalCredit: "0.0000" });
    expect((await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines?direction=SIDEWAYS`)).status).toBe(400);
    expect((await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines?refType=NOPE`)).status).toBe(400);
    const future = await app.request("GET", `/finance/gl-accounts/${wallet.id}/lines?from=2999-01-01`);
    expect(future.json.lines).toEqual([]);
    expect(future.json.totals).toMatchObject({ lineCount: 0, totalDebit: "0.0000", totalCredit: "0.0000" });
    expect((await app.request("GET", `/finance/gl-accounts/${randomUUID()}/lines`)).status).toBe(404);

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
    expect(rolled.json.account.checkpointBalance).toBe("-90.0000");
    expect(rolled.json.account.checkpointAt).not.toBeNull();
    expect(rolled.json.checkpoint).toEqual({ status: "OK", pendingLines: "0", shardsBehind: 0, shardsAdvanced: 2, linesCovered: "3" });
    expect(rolled.json.liveBalance).toBe("-90.0000");
    expect(rolled.json.shards.map((s: any) => [s.shardId, s.checkpointBalance, s.checkpointSeq, s.pendingLines])).toEqual([
      [0, "-70.0000", "2", "0"],
      [1, "-20.0000", "1", "0"],
    ]);

    const audits = await auditRows("GL_ACCOUNT_CHECKPOINT_TRIGGERED", wallet.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(userId);
    expect((audits[0]!.afterJson as any).reason).toBe("month end rollup");
    expect((audits[0]!.afterJson as any).checkpointBalance).toBe("-90.0000");
    expect(audits[0]!.afterJson).toMatchObject({ shardsAdvanced: 2, linesCovered: "3", pendingLines: "0", failedShard: null });
    expect((audits[0]!.beforeJson as any)).toMatchObject({ checkpointBalance: "0.0000", pendingLines: "3" });

    // A posting after the checkpoint moves the live balance, never the checkpoint ...
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "CREDIT", amount: "10.0000" },
        { glAccountId: treasury.id, direction: "DEBIT", amount: "10.0000" },
      ],
      "ADJUSTMENT",
      "after the checkpoint",
      refForShard("MERCHANT_WALLET", 2, 0),
    );
    const later = await app.request("GET", `/finance/gl-accounts/${wallet.id}`);
    expect(later.json.account.checkpointBalance).toBe("-90.0000");
    expect(later.json.liveBalance).toBe("-100.0000");
    expect(later.json.naturalBalance).toBe("100.0000");
    expect(later.json.checkpoint).toEqual({ status: "OK", pendingLines: "1", shardsBehind: 1 });
    // ... and the next rollup only covers the one new line (O(delta)).
    const again = await app.request("POST", `/finance/gl-accounts/${wallet.id}/checkpoint`, { reason: "second rollup" });
    expect(again.status).toBe(200);
    expect(again.json.checkpoint).toMatchObject({ shardsAdvanced: 1, linesCovered: "1", pendingLines: "0" });
    expect(again.json.account.checkpointBalance).toBe("-100.0000");
  });

  test("an account always has shard 0 (created by the database trigger): a fresh account is read from its shards", async () => {
    const treasury = await makeAccount("TREASURY");
    const wallet = await makeAccount("MERCHANT_WALLET");
    const fresh = await app.request("GET", `/finance/gl-accounts/${treasury.id}`);
    expect(fresh.status).toBe(200);
    expect(fresh.json.balanceSource).toBe("shards");
    expect(fresh.json.account).toMatchObject({ shardCount: 1, checkpointBalance: "0.0000", shardScaledAt: null });
    expect(fresh.json.account.checkpointAt).toBeNull();
    expect(fresh.json.shards).toHaveLength(1);
    expect(fresh.json.shards[0]).toMatchObject({
      shardId: 0, currentBalance: "0.0000", lineSeq: "0", checkpointBalance: "0.0000", checkpointSeq: "0", pendingLines: "0", status: "OK", consecutiveFailures: 0,
    });
    expect(fresh.json.checkpoint).toEqual({ status: "OK", pendingLines: "0", shardsBehind: 0 });
    expect(fresh.json.liveBalance).toBe("0.0000");

    await post([
      { glAccountId: treasury.id, direction: "DEBIT", amount: "40.0000" },
      { glAccountId: wallet.id, direction: "CREDIT", amount: "40.0000" },
    ]);
    const detail = await app.request("GET", `/finance/gl-accounts/${treasury.id}`);
    expect(detail.json.balanceSource).toBe("shards");
    expect(detail.json.shards.map((s: any) => [s.shardId, s.currentBalance, s.lineSeq, s.pendingLines])).toEqual([[0, "40.0000", "1", "1"]]);
    expect(detail.json.liveBalance).toBe("40.0000");
    expect(detail.json.naturalBalance).toBe("40.0000");
    expect(detail.json.checkpoint).toEqual({ status: "OK", pendingLines: "1", shardsBehind: 1 });
  });

  test("a shard total that disagrees with the journal refuses the checkpoint (409 naming the shard; the failure is recorded and audited)", async () => {
    const treasury = await makeAccount("TREASURY");
    const wallet = await makeAccount("MERCHANT_WALLET");
    await post([
      { glAccountId: treasury.id, direction: "DEBIT", amount: "25.0000" },
      { glAccountId: wallet.id, direction: "CREDIT", amount: "25.0000" },
    ]);
    await setShardBalance(treasury.id, 0, "999.0000");
    app.setPrincipal(writer());
    const refused = await app.request("POST", `/finance/gl-accounts/${treasury.id}/checkpoint`, { reason: "attempted rollup" });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("LEDGER_SHARD_PARITY_MISMATCH");
    expect(refused.json.details).toMatchObject({
      glAccountId: treasury.id, shardId: 0, kind: "PARITY", shardTotal: "999.0000", journalTotal: "25.0000", drift: "974.0000", linesFound: "1", linesExpected: "1",
    });
    // The attempt is audited together with the shard that failed; nothing moved.
    const audits = await auditRows("GL_ACCOUNT_CHECKPOINT_TRIGGERED", treasury.id);
    expect(audits).toHaveLength(1);
    expect((audits[0]!.afterJson as any).failedShard).toEqual({ shardId: 0, kind: "PARITY", drift: "974.0000" });
    expect((audits[0]!.afterJson as any).shardsAdvanced).toBe(0);
    const detail = await app.request("GET", `/finance/gl-accounts/${treasury.id}`);
    expect(detail.json.account.checkpointBalance).toBe("0.0000");
    expect(detail.json.checkpoint.status).toBe("PARITY");
    expect(detail.json.shards[0]).toMatchObject({ status: "PARITY", consecutiveFailures: 1, checkpointSeq: "0", pendingLines: "1" });
    await setShardBalance(treasury.id, 0, "25.0000"); // repaired: the same capture now succeeds and clears the failure
    const healed = await app.request("POST", `/finance/gl-accounts/${treasury.id}/checkpoint`, { reason: "rollup after repair" });
    expect(healed.status).toBe(200);
    expect(healed.json.checkpoint.status).toBe("OK");
    expect(healed.json.shards[0]).toMatchObject({ status: "OK", consecutiveFailures: 0, checkpointSeq: "1", checkpointBalance: "25.0000" });
  });

  test("a lost line (sequence gap) is refused as GAP, and on a spread account the failing shard is named while the healthy ones advance", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET");
    const treasury = await makeAccount("TREASURY");
    app.setPrincipal(writer());
    expect((await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, { width: 3, reason: "spread the wallet" })).status).toBe(200);
    clearShardWidthCache();
    for (const shard of [0, 1, 2]) {
      await postEntry(
        [
          { glAccountId: wallet.id, direction: "CREDIT", amount: "5.0000" },
          { glAccountId: treasury.id, direction: "DEBIT", amount: "5.0000" },
        ],
        "ADJUSTMENT",
        `shard ${shard}`,
        refForShard("MERCHANT_WALLET", 3, shard),
      );
    }
    // shard 1 claims one more line than the journal holds
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET line_seq = line_seq + 1 WHERE gl_account_id = $1::uuid AND shard_id = 1`, wallet.id);
    const refused = await app.request("POST", `/finance/gl-accounts/${wallet.id}/checkpoint`, { reason: "attempted rollup" });
    expect(refused.status).toBe(409);
    expect(refused.json.details).toMatchObject({ shardId: 1, kind: "GAP", linesFound: "1", linesExpected: "2", drift: "0.0000" });
    const detail = await app.request("GET", `/finance/gl-accounts/${wallet.id}`);
    expect(detail.json.checkpoint.status).toBe("GAP");
    expect(detail.json.shards.map((s: any) => [s.shardId, s.status, s.checkpointSeq])).toEqual([
      [0, "OK", "1"],
      [1, "GAP", "0"],
      [2, "OK", "1"],
    ]);
    expect(detail.json.account.checkpointBalance).toBe("-10.0000"); // only the healthy shards moved
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET line_seq = line_seq - 1 WHERE gl_account_id = $1::uuid AND shard_id = 1`, wallet.id);
  });

  test("manual shard scaling: validated, audited, widening creates shard rows once, narrowing keeps the old rows", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET");
    app.setPrincipal(reader());
    expect((await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, { width: 4, reason: "long enough reason" })).status).toBe(403);
    app.setPrincipal(writer());
    for (const body of [{ width: 0, reason: "long enough reason" }, { width: 257, reason: "long enough reason" }, { width: 2.5, reason: "long enough reason" }, { width: 4, reason: "short" }, { width: 4, reason: "long enough reason", extra: 1 }]) {
      expect((await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, body)).status).toBe(400);
    }
    expect((await app.request("POST", `/finance/gl-accounts/${randomUUID()}/shards/scale`, { width: 4, reason: "long enough reason" })).status).toBe(404);
    const same = await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, { width: 1, reason: "long enough reason" });
    expect(same.status).toBe(409);
    expect(same.json.code).toBe("SHARD_WIDTH_UNCHANGED");

    const wide = await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, { width: 4, reason: "prepare for the campaign" });
    expect(wide.status).toBe(200);
    expect(wide.json.account.shardCount).toBe(4);
    expect(wide.json.shards.map((s: any) => s.shardId)).toEqual([0, 1, 2, 3]);
    const narrow = await app.request("POST", `/finance/gl-accounts/${wallet.id}/shards/scale`, { width: 2, reason: "campaign is over" });
    expect(narrow.status).toBe(200);
    expect(narrow.json.scaled).toEqual({ from: 4, to: 2 });
    expect(narrow.json.account.shardCount).toBe(2);
    expect(narrow.json.shards.map((s: any) => s.shardId)).toEqual([0, 1, 2, 3]); // narrowing is routing-only

    const audits = await auditRows("GL_ACCOUNT_SHARDS_SCALED", wallet.id);
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.actorId === userId && (row.afterJson as any).automatic === false)).toBe(true);
    expect(audits.map((row) => [(row.beforeJson as any).shardCount, (row.afterJson as any).shardCount]).sort()).toEqual([[1, 4], [4, 2]]);
  });

  test("unknown or malformed GL account ids are 404", async () => {
    app.setPrincipal(reader());
    expect((await app.request("GET", `/finance/gl-accounts/${randomUUID()}`)).json.code).toBe("GL_ACCOUNT_NOT_FOUND");
    expect((await app.request("GET", "/finance/gl-accounts/xyz")).status).toBe(404);
  });
});
