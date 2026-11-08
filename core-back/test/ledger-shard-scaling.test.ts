/**
 * Shard scaling against live PostgreSQL: `applyShardWidth` widens / narrows the routing width of a GL account while
 * postings keep flowing, without ever losing a line, breaking the per-shard gapless sequence or moving a balance.
 *
 *   POSTGRES_TEST_DATABASE_URL=postgresql://... bun test test/ledger-shard-scaling.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { LedgerPoster, type JournalTemplate } from "../engine/ledger/LedgerPoster";
import { CheckpointService } from "../engine/ledger/CheckpointService";
import { applyShardWidth } from "../engine/ledger/shardScaling";
import { clearShardWidthCache } from "../lib/storageEngine/shardRouting";
import { loadLiveAccountBalances } from "../lib/storageEngine/shardBalances";
import { cleanupLedger, createPrisma, databaseIsReachable, seedActorUser, seedGlAccount, uniqueId } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 40 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const created: string[] = [];
const refPrefix = uniqueId("scaling");
let actorId = "";

beforeAll(async () => {
  if (databaseIsReachable) actorId = await seedActorUser(client);
});

afterAll(async () => {
  if (created.length > 0) await cleanupLedger(client, created, refPrefix);
  await client.$disconnect();
});

type Ids = { treasury: string; wallet: string };

const seed = async (treasuryWidth: number, walletWidth = 1): Promise<Ids> => {
  const treasury = await seedGlAccount(client, { accountType: "TREASURY", shardCount: treasuryWidth });
  const wallet = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: walletWidth });
  created.push(treasury.id, wallet.id);
  clearShardWidthCache();
  return { treasury: treasury.id, wallet: wallet.id };
};

const template = (refId: string, ids: Ids, amount = "1.0000"): JournalTemplate => ({
  refType: "PAYMENT_ATTEMPT",
  refId,
  description: "scaling test",
  lines: [
    { direction: "DEBIT", amount, account: { accountType: "TREASURY", accountId: ids.treasury } },
    { direction: "CREDIT", amount, account: { accountType: "MERCHANT_WALLET", accountId: ids.wallet } },
  ],
});

const postMany = async (poster: LedgerPoster, ids: Ids, count: number, concurrency: number): Promise<void> => {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        next += 1;
        await poster.post(template(`${refPrefix}-${randomUUID()}`, ids), {
          accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet },
          currency: "LYD",
        });
      }
    }),
  );
};

const scale = (glAccountId: string, newWidth: number, expectedOldWidth?: number, extra: Record<string, unknown> = { reason: "scaling test" }) =>
  applyShardWidth(client, {
    glAccountId,
    newWidth,
    expectedOldWidth,
    audit: { actorId, role: "SECURITY_ADMIN", action: "GL_ACCOUNT_SHARDS_SCALED", extra },
  });

const shardRows = (glAccountId: string) => client.glAccountShard.findMany({ where: { glAccountId }, orderBy: { shardId: "asc" } });
const audits = (glAccountId: string) => client.auditLog.findMany({ where: { action: "GL_ACCOUNT_SHARDS_SCALED", entityId: glAccountId }, orderBy: { createdAt: "asc" } });

/** Every shard: line_seq equals its line count and its lines carry exactly 1..n; the shard balances add up to the journal. */
const expectConsistent = async (glAccountId: string, expectedTotalLines: number, expectedBalance: string): Promise<Map<number, number>> => {
  const perShard = new Map<number, number>();
  let balance = new Decimal(0);
  let lines = 0;
  for (const shard of await shardRows(glAccountId)) {
    const rows = await client.journalLine.findMany({ where: { glAccountId, shardId: shard.shardId }, orderBy: { shardSeq: "asc" } });
    expect(rows.map((row) => row.shardSeq)).toEqual(Array.from({ length: rows.length }, (_, index) => BigInt(index + 1)));
    expect(shard.lineSeq).toBe(BigInt(rows.length));
    perShard.set(shard.shardId, rows.length);
    lines += rows.length;
    balance = balance.plus(shard.currentBalance.toString());
  }
  expect(lines).toBe(expectedTotalLines);
  expect(balance.toFixed(4)).toBe(expectedBalance);
  const journal = await client.$queryRawUnsafe<Array<{ total: string }>>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS total FROM journal_lines WHERE gl_account_id = $1::uuid`,
    glAccountId,
  );
  expect(new Decimal(journal[0]!.total).toFixed(4)).toBe(expectedBalance);
  return perShard;
};

describeDb("shard scaling (live PostgreSQL)", () => {
  test("widening an account while postings run conserves the balance and every per-shard sequence, creates shard rows once, and is audited", async () => {
    const ids = await seed(1);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 40, 10);

    // widen while 80 postings are in flight
    const [outcome] = await Promise.all([scale(ids.treasury, 8, 1, { reason: "hot account", automatic: false }), postMany(poster, ids, 80, 20)]);
    expect(outcome).toEqual({ changed: true, oldWidth: 1, newWidth: 8 });
    await postMany(poster, ids, 60, 10);

    const account = await client.glAccount.findUniqueOrThrow({ where: { id: ids.treasury } });
    expect(account.shardCount).toBe(8);
    expect(account.shardScaledAt).not.toBeNull();
    expect((await shardRows(ids.treasury)).map((row) => row.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // 180 postings of 1.0000, each a treasury DEBIT: nothing lost, nothing double counted, gapless per shard
    const perShard = await expectConsistent(ids.treasury, 180, "180.0000");
    expect([...perShard.entries()].filter(([shard, lines]) => shard > 0 && lines > 0).length).toBeGreaterThan(0); // the new shards are used
    expect(perShard.get(0)).toBeGreaterThanOrEqual(40); // the history stays where it was posted
    await expectConsistent(ids.wallet, 180, "-180.0000");

    // the checkpoint still proves every shard (the widened ones included)
    const service = new CheckpointService(client as never);
    const results = await service.captureAccount(ids.treasury);
    expect(results.map((result) => result.status).every((status) => status === "ADVANCED" || status === "NOOP")).toBe(true);
    const [live] = await loadLiveAccountBalances(client as never, [ids.treasury]);
    expect(live!.balance).toBe("180.0000");

    // audited once, as the actor, with before/after
    const rows = await audits(ids.treasury);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId, role: "SECURITY_ADMIN", entityType: "GL_ACCOUNT" });
    expect(rows[0]!.beforeJson).toEqual({ shardCount: 1 });
    expect(rows[0]!.afterJson).toMatchObject({ shardCount: 8, reason: "hot account", automatic: false });

    // a second identical request changes nothing: no new audit row, shard rows stay at 8 (created once)
    expect(await scale(ids.treasury, 8)).toEqual({ changed: false, oldWidth: 8, newWidth: 8 });
    expect(await audits(ids.treasury)).toHaveLength(1);
    expect(await shardRows(ids.treasury)).toHaveLength(8);
  });

  test("a stale expectedOldWidth is rejected (changed = false): nothing is written, audited or created", async () => {
    const ids = await seed(1);
    const outcome = await scale(ids.treasury, 8, 4);
    expect(outcome).toEqual({ changed: false, oldWidth: 1, newWidth: 1 });
    const account = await client.glAccount.findUniqueOrThrow({ where: { id: ids.treasury } });
    expect(account.shardCount).toBe(1);
    expect(account.shardScaledAt).toBeNull();
    expect(await shardRows(ids.treasury)).toHaveLength(1);
    expect(await audits(ids.treasury)).toHaveLength(0);

    // the same call with the right expectation succeeds
    expect(await scale(ids.treasury, 8, 1)).toEqual({ changed: true, oldWidth: 1, newWidth: 8 });
  });

  test("two racing scalers that both expect the old width: exactly one wins", async () => {
    const ids = await seed(1);
    const outcomes = await Promise.all([scale(ids.treasury, 4, 1), scale(ids.treasury, 8, 1), scale(ids.treasury, 16, 1)]);
    expect(outcomes.filter((outcome) => outcome.changed)).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.changed)!;
    expect((await client.glAccount.findUniqueOrThrow({ where: { id: ids.treasury } })).shardCount).toBe(winner.newWidth);
    expect(await shardRows(ids.treasury)).toHaveLength(winner.newWidth);
    expect(await audits(ids.treasury)).toHaveLength(1);
  });

  test("an unknown account is an error and a width beyond the range is clamped to 256", async () => {
    await expect(scale(randomUUID(), 4)).rejects.toThrow("does not exist");
    const ids = await seed(1);
    expect(await scale(ids.treasury, 10_000)).toEqual({ changed: true, oldWidth: 1, newWidth: 256 });
    expect(await shardRows(ids.treasury)).toHaveLength(256);
    expect(await scale(ids.treasury, 0)).toEqual({ changed: true, oldWidth: 256, newWidth: 1 });
    expect((await client.glAccount.findUniqueOrThrow({ where: { id: ids.treasury } })).shardCount).toBe(1);
    expect(await shardRows(ids.treasury)).toHaveLength(256); // narrowing never deletes shard rows
  });

  test("narrowing is routing-only: old shard rows keep summing and still checkpoint, new postings go to the narrow set", async () => {
    const ids = await seed(4);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 80, 10);
    const before = await expectConsistent(ids.treasury, 80, "80.0000");
    expect([...before.values()].filter((lines) => lines > 0).length).toBeGreaterThan(1);

    const service = new CheckpointService(client as never);
    await service.captureAccount(ids.treasury);

    expect(await scale(ids.treasury, 1, 4, { reason: "campaign over" })).toEqual({ changed: true, oldWidth: 4, newWidth: 1 });
    expect(await shardRows(ids.treasury)).toHaveLength(4);
    const rows = await audits(ids.treasury);
    expect(rows[0]!.beforeJson).toEqual({ shardCount: 4 });
    expect(rows[0]!.afterJson).toMatchObject({ shardCount: 1, reason: "campaign over" });

    await postMany(poster, ids, 30, 5);
    const after = await expectConsistent(ids.treasury, 110, "110.0000");
    // the history is untouched on shards 1..3; every new line landed on shard 0
    for (const shard of [1, 2, 3]) expect(after.get(shard)).toBe(before.get(shard));
    expect(after.get(0)).toBe(before.get(0)! + 30);

    // the old shards still checkpoint, and the account balance is still the sum of ALL its shard rows
    const results = await service.captureAccount(ids.treasury);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.status === "ADVANCED" || result.status === "NOOP")).toBe(true);
    expect(results.find((result) => result.shardId === 0)!.status).toBe("ADVANCED");
    const [live] = await loadLiveAccountBalances(client as never, [ids.treasury]);
    expect(live!.balance).toBe("110.0000");
    const checkpoints = await client.glShardCheckpoint.findMany({ where: { glAccountId: ids.treasury } });
    expect(checkpoints.reduce((sum, row) => sum.plus(row.checkpointBalance.toString()), new Decimal(0)).toFixed(4)).toBe("110.0000");
  });

  test("new postings use the widened routing once the width cache is cleared (a raw width change is picked up after clearShardWidthCache)", async () => {
    const ids = await seed(1);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 20, 5);
    const narrow = await expectConsistent(ids.treasury, 20, "20.0000");
    expect([...narrow.entries()].filter(([, lines]) => lines > 0).map(([shard]) => shard)).toEqual([0]);

    // widen behind the application's back (no applyShardWidth, so the 3 s width cache is not cleared by it)
    await client.$executeRawUnsafe(`UPDATE gl_accounts SET shard_count = 4 WHERE id = $1::uuid`, ids.treasury);
    await client.$executeRawUnsafe(
      `INSERT INTO gl_account_shards (gl_account_id, shard_id) SELECT $1::uuid, g FROM generate_series(1, 3) g ON CONFLICT DO NOTHING`,
      ids.treasury,
    );
    clearShardWidthCache();
    await postMany(poster, ids, 60, 10);
    const wide = await expectConsistent(ids.treasury, 80, "80.0000");
    expect(wide.get(0)).toBeGreaterThanOrEqual(20);
    expect([1, 2, 3].every((shard) => (wide.get(shard) ?? 0) > 0)).toBe(true);
    // the wallet (still one shard wide) is untouched by the treasury's width
    expect([...(await expectConsistent(ids.wallet, 80, "-80.0000")).keys()]).toEqual([0]);
  });
});
