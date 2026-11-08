/**
 * LedgerCheckpointWorker and LedgerShardScalerWorker against live PostgreSQL.
 *
 * Both workers scan the whole ledger, and the test database is shared with other suites, so the workers get a `db`
 * view that only reports the shards of the accounts this file created (the same SQL runs; foreign rows are filtered
 * out of the two scan queries), which keeps the assertions exact and the other suites' rows untouched.
 *
 *   POSTGRES_TEST_DATABASE_URL=postgresql://... bun test test/ledger-checkpoint-worker.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { LedgerPoster, type JournalTemplate } from "../engine/ledger/LedgerPoster";
import { SYSTEM_AUTOMATION_EMAIL } from "../engine/governance/GovernanceExecution";
import { LedgerCheckpointWorker } from "../engine/workers/LedgerCheckpointWorker";
import { LedgerShardScalerWorker } from "../engine/workers/LedgerShardScalerWorker";
import { clearShardWidthCache } from "../lib/storageEngine/shardRouting";
import { emptyRepositories } from "./helpers/fakeRepositories";
import { cleanupLedger, createPrisma, databaseIsReachable, seedGlAccount, uniqueId } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 30 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const refPrefix = uniqueId("ckptw");
const created: string[] = [];
const startedAt = new Date(Date.now() - 2_000);

afterAll(async () => {
  if (created.length > 0) {
    await client.operatorCase.deleteMany({
      where: { OR: created.map((id) => ({ subjectKey: { startsWith: `ledger.shard:${id}:` } })) },
    });
    await cleanupLedger(client, created, refPrefix);
  }
  await client.$disconnect();
});

/** The disabled automation user the workers audit as (created on first use, located by its unique e-mail). */
const systemActorId = async (): Promise<string> => {
  const user = await client.user.findUniqueOrThrow({ where: { email: SYSTEM_AUTOMATION_EMAIL } });
  expect(user).toMatchObject({ status: "DISABLED", isMaker: false, isChecker: false, role: "OPERATOR" });
  return user.id;
};

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A view of the client whose two worker scan queries only report the shards of `ids`; everything else is the real client. */
const scopedTo = (ids: readonly string[]) => {
  const own = new Set(ids);
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (property === "$queryRawUnsafe") {
        return async (sql: string, ...values: unknown[]) => {
          const rows = (await (value as (...args: unknown[]) => Promise<unknown>).call(target, sql, ...values)) as Array<{ id?: string }>;
          const scan = sql.includes("FROM gl_account_shards s") && (sql.includes("LEFT JOIN gl_shard_checkpoints") || sql.includes("INNER JOIN gl_accounts g"));
          return scan && Array.isArray(rows) ? rows.filter((row) => row.id === undefined || own.has(row.id)) : rows;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as PrismaLikeClient;
};
type PrismaLikeClient = typeof client;

type Pair = { treasury: string; wallet: string };

const seedPair = async (): Promise<Pair> => {
  const treasury = await seedGlAccount(client, { accountType: "TREASURY", shardCount: 1 });
  const wallet = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 });
  created.push(treasury.id, wallet.id);
  clearShardWidthCache();
  return { treasury: treasury.id, wallet: wallet.id };
};

const template = (refId: string, pair: Pair, amount = "1.0000"): JournalTemplate => ({
  refType: "PAYMENT_ATTEMPT",
  refId,
  description: "checkpoint worker test",
  lines: [
    { direction: "DEBIT", amount, account: { accountType: "TREASURY", accountId: pair.treasury } },
    { direction: "CREDIT", amount, account: { accountType: "MERCHANT_WALLET", accountId: pair.wallet } },
  ],
});

const poster = new LedgerPoster(client as never);
const post = async (pair: Pair, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await poster.post(template(`${refPrefix}-${randomUUID()}`, pair), { accounts: { TREASURY: pair.treasury, MERCHANT_WALLET: pair.wallet }, currency: "LYD" });
  }
};

const checkpointOf = async (account: string, shardId = 0) => {
  const row = await client.glShardCheckpoint.findUnique({ where: { glAccountId_shardId: { glAccountId: account, shardId } } });
  return { seq: row?.checkpointSeq ?? 0n, balance: new Decimal(row?.checkpointBalance.toString() ?? "0").toFixed(4), status: row?.status ?? "NONE", failures: row?.consecutiveFailures ?? 0 };
};

const checkpointWorker = (ids: readonly string[], over: Record<string, unknown> = {}) =>
  new LedgerCheckpointWorker({
    db: scopedTo(ids) as never,
    repositories: emptyRepositories(),
    logger: quiet,
    batchSize: 1_000,
    minLines: 10,
    maxAgeMs: 15 * 60 * 1000,
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
    ...over,
  });

describeDb("LedgerCheckpointWorker (live PostgreSQL)", () => {
  test("it checkpoints the shards that reach minLines or whose checkpoint is older than maxAgeMs, and leaves the others", async () => {
    const busy = await seedPair(); // 12 lines, never checkpointed: over minLines
    const quiet1 = await seedPair(); // checkpointed at 5 lines, then 3 more: below minLines and fresh -> left alone
    const stale = await seedPair(); // checkpointed at 4 lines, then 2 more, and the checkpoint is an hour old -> by age
    const ids = [busy, quiet1, stale].flatMap((pair) => [pair.treasury, pair.wallet]);

    await post(busy, 12);
    await post(quiet1, 5);
    await post(stale, 4);
    const direct = checkpointWorker(ids, { minLines: 1 });
    await direct.runOnce(); // baseline: checkpoint everything that exists so far
    expect((await checkpointOf(quiet1.treasury)).seq).toBe(5n);
    expect((await checkpointOf(stale.treasury)).seq).toBe(4n);
    // `busy` was captured by the baseline run too: reset it so that it is a candidate by volume again
    await client.glShardCheckpoint.deleteMany({ where: { glAccountId: { in: [busy.treasury, busy.wallet] } } });

    await post(quiet1, 3);
    await post(stale, 2);
    await client.$executeRawUnsafe(
      `UPDATE gl_shard_checkpoints SET checkpoint_at = now() - interval '1 hour' WHERE gl_account_id = ANY($1::uuid[])`,
      [stale.treasury, stale.wallet],
    );

    await checkpointWorker(ids).runOnce();

    for (const account of [busy.treasury, busy.wallet]) expect((await checkpointOf(account)).seq).toBe(12n);
    for (const account of [stale.treasury, stale.wallet]) expect((await checkpointOf(account)).seq).toBe(6n);
    for (const account of [quiet1.treasury, quiet1.wallet]) {
      const state = await checkpointOf(account);
      expect(state.seq).toBe(5n); // not touched
      expect(state.balance).toBe(account === quiet1.treasury ? "5.0000" : "-5.0000");
    }
    expect((await checkpointOf(busy.treasury)).balance).toBe("12.0000");
    expect((await checkpointOf(busy.wallet)).balance).toBe("-12.0000");
    expect((await checkpointOf(stale.treasury)).balance).toBe("6.0000");
    // routine successes write no per-shard audit row and open no case
    expect(await client.operatorCase.count({ where: { subjectKey: { startsWith: `ledger.shard:${busy.treasury}` } } })).toBe(0);
    expect(await client.auditLog.count({ where: { action: "LEDGER_SHARD_CHECKPOINT_FAILED", entityId: { in: ids } } })).toBe(0);

    // a second tick has nothing left to do for these shards
    await checkpointWorker(ids).runOnce();
    expect((await checkpointOf(busy.treasury)).seq).toBe(12n);
    expect((await checkpointOf(quiet1.treasury)).seq).toBe(5n);

    // and the quiet shards are caught up once their volume or age qualifies
    await checkpointWorker(ids, { minLines: 3 }).runOnce();
    expect((await checkpointOf(quiet1.treasury)).seq).toBe(8n);
    expect((await checkpointOf(quiet1.wallet)).balance).toBe("-8.0000");
  });

  test("it writes one aggregated LEDGER_CHECKPOINT_SWEEP audit row per interval (not one per shard)", async () => {
    const pair = await seedPair();
    const ids = [pair.treasury, pair.wallet];
    await post(pair, 3);
    let now = new Date("2030-02-01T00:00:00.000Z");
    const worker = checkpointWorker(ids, { minLines: 1, sweepAuditEveryMs: 60_000, clock: () => now });
    await worker.runOnce(); // first tick: starts the window, checkpoints both shards
    expect((await checkpointOf(pair.treasury)).seq).toBe(3n);
    const sweeps = () => client.auditLog.findMany({ where: { action: "LEDGER_CHECKPOINT_SWEEP", createdAt: { gte: startedAt } } });
    const before = (await sweeps()).length;
    await post(pair, 2);
    now = new Date(now.getTime() + 61_000);
    await worker.runOnce(); // the window elapsed: the aggregate is written
    const rows = await sweeps();
    expect(rows.length).toBe(before + 1);
    const latest = rows.at(-1)!;
    expect(latest).toMatchObject({ actorId: await systemActorId(), role: "SYSTEM", entityType: "LEDGER" });
    expect(latest.afterJson).toMatchObject({ shardsCheckpointed: 4, linesCovered: "10", failures: 0 }); // 3+3 lines, then 2+2
    // nothing happened since: no new row
    now = new Date(now.getTime() + 120_000);
    await worker.runOnce();
    expect((await sweeps()).length).toBe(before + 1);
  });

  test("the first failure of a forged-drift shard opens exactly ONE P1 case and ONE audit row; the checkpoint never moves", async () => {
    const pair = await seedPair();
    const ids = [pair.treasury, pair.wallet];
    await post(pair, 15);
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 0.5 WHERE gl_account_id = $1::uuid AND shard_id = 0`, pair.treasury);

    const worker = checkpointWorker(ids);
    await worker.runOnce();

    // the healthy shard advanced; the forged one did not
    expect((await checkpointOf(pair.wallet)).seq).toBe(15n);
    const bad = await checkpointOf(pair.treasury);
    expect(bad).toMatchObject({ seq: 0n, status: "PARITY", failures: 1 });

    const key = `ledger.shard:${pair.treasury}:0`;
    const cases = await client.operatorCase.findMany({ where: { subjectKey: key } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: "MISMATCH", priority: "P1", state: "OPEN" });
    expect(cases[0]!.slaDueAt.toISOString()).toBe("2030-01-01T04:00:00.000Z"); // injected clock + 4 h
    expect(cases[0]!.resolutionNotes).toContain("failed its checkpoint proof (PARITY)");
    expect(cases[0]!.resolutionNotes).toContain(pair.treasury);

    const audit = await client.auditLog.findMany({ where: { action: "LEDGER_SHARD_CHECKPOINT_FAILED", entityId: pair.treasury } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: await systemActorId(), role: "SYSTEM", entityType: "GL_ACCOUNT" });
    expect(audit[0]!.afterJson).toEqual({ shardId: 0, kind: "PARITY", drift: "0.5000", linesFound: "15", linesExpected: "15" });
    // the healthy wallet shard raised nothing
    expect(await client.operatorCase.count({ where: { subjectKey: `ledger.shard:${pair.wallet}:0` } })).toBe(0);

    // The failed shard waits for the retry back-off: a worker with the default one does not look at it again ...
    await checkpointWorker(ids).runOnce();
    expect((await checkpointOf(pair.treasury)).failures).toBe(1);
    // ... and when it IS retried (back-off 0) it fails again, but the case and the audit row are not duplicated.
    // (`last_failure_at` is stamped by the database; backdate it so the zero back-off cannot race the clock resolution)
    const backdate = () => client.$executeRawUnsafe(`UPDATE gl_shard_checkpoints SET last_failure_at = now() - interval '5 seconds' WHERE gl_account_id = $1::uuid`, pair.treasury);
    const eager = checkpointWorker(ids, { retryFailedMs: 0 });
    await backdate();
    await eager.runOnce();
    await backdate();
    await eager.runOnce();
    expect((await checkpointOf(pair.treasury)).failures).toBe(3);
    expect(await client.operatorCase.count({ where: { subjectKey: key } })).toBe(1);
    expect(await client.auditLog.count({ where: { action: "LEDGER_SHARD_CHECKPOINT_FAILED", entityId: pair.treasury } })).toBe(1);

    // repaired: the next retry advances the checkpoint and clears the failure state (the case stays for the operator)
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance - 0.5 WHERE gl_account_id = $1::uuid AND shard_id = 0`, pair.treasury);
    await backdate();
    await eager.runOnce();
    expect(await checkpointOf(pair.treasury)).toMatchObject({ seq: 15n, status: "OK", failures: 0, balance: "15.0000" });
    expect(await client.operatorCase.count({ where: { subjectKey: key, state: "OPEN" } })).toBe(1);
  });

  test("a lost line (GAP) is a separate case keyed per shard, even on the same account", async () => {
    const pair = await seedPair();
    const ids = [pair.treasury, pair.wallet];
    await post(pair, 12);
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET line_seq = line_seq + 1 WHERE gl_account_id = $1::uuid AND shard_id = 0`, pair.wallet);
    await checkpointWorker(ids).runOnce();
    expect(await checkpointOf(pair.wallet)).toMatchObject({ seq: 0n, status: "GAP", failures: 1 });
    expect((await checkpointOf(pair.treasury)).seq).toBe(12n);
    expect(await client.operatorCase.count({ where: { subjectKey: `ledger.shard:${pair.wallet}:0`, kind: "MISMATCH", priority: "P1" } })).toBe(1);
    const audit = await client.auditLog.findMany({ where: { action: "LEDGER_SHARD_CHECKPOINT_FAILED", entityId: pair.wallet } });
    expect(audit[0]!.afterJson).toMatchObject({ shardId: 0, kind: "GAP", linesFound: "12", linesExpected: "13" });
  });
});

/* -------------------------------------------------------------------------- */

describeDb("LedgerShardScalerWorker (live PostgreSQL, dry run)", () => {
  const bump = (account: string, shardId: number, by: number) =>
    client.$executeRawUnsafe(`UPDATE gl_account_shards SET line_seq = line_seq + $3 WHERE gl_account_id = $1::uuid AND shard_id = $2`, account, shardId, by);

  const scaler = (ids: readonly string[], clock: () => Date, over: Record<string, unknown> = {}) =>
    new LedgerShardScalerWorker({
      db: scopedTo(ids) as never,
      repositories: emptyRepositories(),
      logger: quiet,
      clock,
      config: { upLinesPerSec: 5, consecutive: 1, alpha: 1, cooldownMs: 0, maxWidth: 64, maxStep: 4 },
      ...over,
    });

  test("a hot shard is proposed (audited) once per proposed width; nothing is changed; calm and debit-pinned accounts are not proposed", async () => {
    const hotPair = await seedPair();
    const calm = await seedPair();
    const wallet2 = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 2 }); // shard 0 hot, shard 1 quiet: pinned by debits
    created.push(wallet2.id);
    const ids = [hotPair.treasury, hotPair.wallet, calm.treasury, calm.wallet, wallet2.id];
    for (const pair of [hotPair, calm]) await post(pair, 1); // every scanned shard needs line_seq > 0 to be sampled
    await bump(wallet2.id, 0, 1);

    let now = new Date("2030-03-01T00:00:00.000Z");
    const worker = scaler(ids, () => now);
    const advance = (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    };
    const proposals = () => client.auditLog.findMany({ where: { action: "GL_ACCOUNT_SHARDS_SCALE_PROPOSED", entityId: hotPair.treasury }, orderBy: { createdAt: "asc" } });

    await worker.runOnce(); // baseline only (no rate without a previous sample)
    expect(await proposals()).toHaveLength(0);

    advance(10);
    await bump(hotPair.treasury, 0, 90); // 9 lines/s > 5
    await bump(calm.treasury, 0, 10); // 1 line/s
    await bump(wallet2.id, 0, 100); // shard 0 at 10/s, shard 1 idle: pinned by balance-reducing lines
    await worker.runOnce();
    let rows = await proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: await systemActorId(), role: "SYSTEM", entityType: "GL_ACCOUNT" });
    expect(rows[0]!.beforeJson).toEqual({ shardCount: 1 });
    expect(rows[0]!.afterJson).toMatchObject({ shardCount: 4, dryRun: true, accountType: "TREASURY", automatic: true, hottestShardLinesPerSec: 9, accountLinesPerSec: 9 });
    expect(String((rows[0]!.afterJson as { reason: string }).reason)).toContain("hottest shard 9 lines/s over 5");

    // the same proposal again is not re-audited
    advance(10);
    await bump(hotPair.treasury, 0, 90);
    await worker.runOnce();
    expect(await proposals()).toHaveLength(1);

    // a different proposed width (the load fell to 6 lines/s: ceil(6 / 2.5) = 3 shards) is a new proposal
    advance(10);
    await bump(hotPair.treasury, 0, 60);
    await worker.runOnce();
    rows = await proposals();
    expect(rows).toHaveLength(2);
    expect((rows[1]!.afterJson as { shardCount: number }).shardCount).toBe(3);
    advance(10);
    await bump(hotPair.treasury, 0, 60);
    await worker.runOnce();
    expect(await proposals()).toHaveLength(2);

    // dry run changes nothing
    const account = await client.glAccount.findUniqueOrThrow({ where: { id: hotPair.treasury } });
    expect(account.shardCount).toBe(1);
    expect(account.shardScaledAt).toBeNull();
    expect(await client.glAccountShard.count({ where: { glAccountId: hotPair.treasury } })).toBe(1);
    expect(await client.auditLog.count({ where: { action: "GL_ACCOUNT_SHARDS_SCALED", entityId: hotPair.treasury } })).toBe(0);
    // the calm account and the debit-pinned wallet were never proposed
    for (const id of [calm.treasury, calm.wallet, wallet2.id]) {
      expect(await client.auditLog.count({ where: { action: "GL_ACCOUNT_SHARDS_SCALE_PROPOSED", entityId: id } })).toBe(0);
    }
  });

  test("outside dry-run the account is widened: shard rows created, GL_ACCOUNT_SHARDS_SCALED audited as the system user, cooldown honoured", async () => {
    const pair = await seedPair();
    const ids = [pair.treasury, pair.wallet];
    await post(pair, 1);
    let now = new Date("2030-04-01T00:00:00.000Z");
    const worker = scaler(ids, () => now, { dryRun: false, config: { upLinesPerSec: 5, consecutive: 1, alpha: 1, cooldownMs: 3_600_000, maxWidth: 64, maxStep: 4 } });
    await worker.runOnce();
    now = new Date(now.getTime() + 10_000);
    await bump(pair.treasury, 0, 90);
    await worker.runOnce();

    const account = await client.glAccount.findUniqueOrThrow({ where: { id: pair.treasury } });
    expect(account.shardCount).toBe(4);
    expect(account.shardScaledAt).not.toBeNull();
    expect((await client.glAccountShard.findMany({ where: { glAccountId: pair.treasury }, orderBy: { shardId: "asc" } })).map((row) => row.shardId)).toEqual([0, 1, 2, 3]);
    const audit = await client.auditLog.findMany({ where: { action: "GL_ACCOUNT_SHARDS_SCALED", entityId: pair.treasury } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: await systemActorId(), role: "SYSTEM" });
    expect(audit[0]!.beforeJson).toEqual({ shardCount: 1 });
    expect(audit[0]!.afterJson).toMatchObject({ shardCount: 4, automatic: true, accountType: "TREASURY" });
    expect(await client.auditLog.count({ where: { action: "GL_ACCOUNT_SHARDS_SCALE_PROPOSED", entityId: pair.treasury } })).toBe(0);

    // still hot, but inside the (persisted) cooldown: no second scaling. `shard_scaled_at` is stamped with the database
    // clock; this test's injected clock is in 2030, so re-stamp it on the injected timeline.
    await client.$executeRawUnsafe(`UPDATE gl_accounts SET shard_scaled_at = $2 WHERE id = $1::uuid`, pair.treasury, now);
    now = new Date(now.getTime() + 10_000);
    await bump(pair.treasury, 0, 900);
    await worker.runOnce();
    expect((await client.glAccount.findUniqueOrThrow({ where: { id: pair.treasury } })).shardCount).toBe(4);
    expect(await client.auditLog.count({ where: { action: "GL_ACCOUNT_SHARDS_SCALED", entityId: pair.treasury } })).toBe(1);
  });
});
