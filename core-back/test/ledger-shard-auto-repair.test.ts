/**
 * Automatic shard repair by LedgerCheckpointWorker (live PostgreSQL): only a persistent PARITY failure with an intact
 * sequence and a correction within the limit is recomputed from the journal. A GAP, a large correction, a disabled
 * policy or too few consecutive failures are never repaired by the system.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { LedgerPoster, type JournalTemplate } from "../engine/ledger/LedgerPoster";
import { LedgerCheckpointWorker } from "../engine/workers/LedgerCheckpointWorker";
import { clearShardWidthCache } from "../lib/storageEngine/shardRouting";
import { withLedgerMaintenance } from "./helpers/ledgerMaintenance";
import { emptyRepositories } from "./helpers/fakeRepositories";
import { cleanupLedger, createPrisma, databaseIsReachable, seedGlAccount, uniqueId } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 30 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const refPrefix = uniqueId("autorep");
const created: string[] = [];

afterAll(async () => {
  if (created.length > 0) {
    await client.operatorCase.deleteMany({ where: { OR: created.map((id) => ({ subjectKey: { startsWith: `ledger.shard:${id}:` } })) } });
    await cleanupLedger(client, created, refPrefix);
  }
  await client.$disconnect();
});

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The shared test database holds other suites' shards: the worker only sees the ones this file created. */
const scopedTo = (ids: readonly string[]) => {
  const own = new Set(ids);
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "$queryRawUnsafe") {
        return async (sql: string, ...values: unknown[]) => {
          const rows = (await (value as (...args: unknown[]) => Promise<unknown>).call(target, sql, ...values)) as Array<{ id?: string }>;
          const scan =
            (sql.includes("FROM gl_account_shards s") && sql.includes("LEFT JOIN gl_shard_checkpoints")) ||
            (sql.includes("FROM gl_shard_checkpoints") && sql.includes("consecutive_failures >="));
          return scan && Array.isArray(rows) ? rows.filter((row) => row.id === undefined || own.has(row.id)) : rows;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as typeof client;
};

const worker = (ids: readonly string[], autoRepair: { enabled: boolean; minConsecutiveFailures: number; maxAbsDelta: Decimal }) =>
  new LedgerCheckpointWorker({
    db: scopedTo(ids) as never,
    repositories: emptyRepositories(),
    logger: quiet,
    batchSize: 1_000,
    minLines: 1,
    maxAgeMs: 15 * 60 * 1000,
    retryFailedMs: 0, // retry a failed shard on every tick so the test does not wait ten minutes
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
    autoRepair,
  });

const seedBroken = async (kind: "drift" | "gap") => {
  const treasury = (await seedGlAccount(client, { accountType: "TREASURY", shardCount: 1 })).id;
  const wallet = (await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 })).id;
  created.push(treasury, wallet);
  clearShardWidthCache();
  const poster = new LedgerPoster(client as never);
  const tpl = (n: number): JournalTemplate => ({
    refType: "PAYMENT_ATTEMPT",
    refId: `${refPrefix}-${randomUUID()}-${n}`,
    description: "auto repair test",
    lines: [
      { direction: "DEBIT", amount: "3.0000", account: { accountType: "TREASURY", accountId: treasury } },
      { direction: "CREDIT", amount: "3.0000", account: { accountType: "MERCHANT_WALLET", accountId: wallet } },
    ],
  });
  const ctx = { accounts: { TREASURY: treasury, MERCHANT_WALLET: wallet }, currency: "LYD" };
  for (let i = 0; i < 6; i += 1) await poster.post(tpl(i), ctx);
  await worker([treasury, wallet], { enabled: false, minConsecutiveFailures: 99, maxAbsDelta: new Decimal(0) }).runOnce();
  for (let i = 0; i < 3; i += 1) await poster.post(tpl(100 + i), ctx);
  if (kind === "drift") {
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 0.5 WHERE gl_account_id = $1::uuid AND shard_id = 0`, treasury);
  } else {
    await withLedgerMaintenance(client, (tx) => tx.journalLine.deleteMany({ where: { glAccountId: treasury, shardId: 0, shardSeq: 8n } }));
  }
  return { treasury, wallet };
};

const journalTotal = async (account: string): Promise<string> =>
  (await client.$queryRawUnsafe<Array<{ t: string }>>(`SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)::text AS t FROM journal_lines WHERE gl_account_id = $1::uuid`, account))[0]!.t;
const shardRow = (account: string) => client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: account, shardId: 0 } }, include: { checkpoint: true } });

describeDb("automatic shard repair", () => {
  test("a persistent PARITY drift is recomputed from the journal once it failed enough times, audited and annotated", async () => {
    const { treasury, wallet } = await seedBroken("drift");
    const w = worker([treasury, wallet], { enabled: true, minConsecutiveFailures: 2, maxAbsDelta: new Decimal(100) });
    await w.runOnce(); // first failure: opens the case, not repaired yet
    expect((await shardRow(treasury)).checkpoint?.status).toBe("PARITY");
    expect(await client.glShardRepair.count({ where: { glAccountId: treasury } })).toBe(0);
    await w.runOnce(); // second consecutive failure: repaired
    const row = await shardRow(treasury);
    expect(row.currentBalance.toFixed(4)).toBe(new Decimal(await journalTotal(treasury)).toFixed(4));
    expect(row.checkpoint?.status).toBe("OK");
    const repairs = await client.glShardRepair.findMany({ where: { glAccountId: treasury } });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ kind: "RECOMPUTE", mode: "AUTO" });
    expect(repairs[0]!.delta.toFixed(4)).toBe("-0.5000");
    const audit = await client.auditLog.findMany({ where: { entityId: treasury, action: "GL_SHARD_REPAIRED" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.role).toBe("SYSTEM");
    const kase = await client.operatorCase.findFirst({ where: { subjectKey: `ledger.shard:${treasury}:0` } });
    expect(kase?.state).toBe("OPEN"); // a person still reviews and resolves it
    expect(kase?.resolutionNotes).toContain("[AUTO] RECOMPUTE applied");
  });

  test("fewer consecutive failures than required, a disabled policy and a correction above the limit are not repaired", async () => {
    const early = await seedBroken("drift");
    await worker([early.treasury, early.wallet], { enabled: true, minConsecutiveFailures: 5, maxAbsDelta: new Decimal(100) }).runOnce();
    await worker([early.treasury, early.wallet], { enabled: true, minConsecutiveFailures: 5, maxAbsDelta: new Decimal(100) }).runOnce();
    expect(await client.glShardRepair.count({ where: { glAccountId: early.treasury } })).toBe(0);

    const off = await seedBroken("drift");
    for (let i = 0; i < 3; i += 1) await worker([off.treasury, off.wallet], { enabled: false, minConsecutiveFailures: 1, maxAbsDelta: new Decimal(100) }).runOnce();
    expect(await client.glShardRepair.count({ where: { glAccountId: off.treasury } })).toBe(0);
    expect((await shardRow(off.treasury)).checkpoint?.status).toBe("PARITY");

    const big = await seedBroken("drift"); // drift of 0.5 with a limit of 0.1
    for (let i = 0; i < 3; i += 1) await worker([big.treasury, big.wallet], { enabled: true, minConsecutiveFailures: 1, maxAbsDelta: new Decimal("0.1") }).runOnce();
    expect(await client.glShardRepair.count({ where: { glAccountId: big.treasury } })).toBe(0);
    expect((await shardRow(big.treasury)).checkpoint?.status).toBe("PARITY");
  });

  test("a damaged sequence (GAP) is never repaired by the system", async () => {
    const { treasury, wallet } = await seedBroken("gap");
    for (let i = 0; i < 4; i += 1) await worker([treasury, wallet], { enabled: true, minConsecutiveFailures: 1, maxAbsDelta: new Decimal(1_000_000) }).runOnce();
    expect((await shardRow(treasury)).checkpoint?.status).toBe("GAP");
    expect(await client.glShardRepair.count({ where: { glAccountId: treasury } })).toBe(0);
  });
});
