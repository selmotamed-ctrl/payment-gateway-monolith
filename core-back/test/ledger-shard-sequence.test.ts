/**
 * Sequenced per-shard ledger (live PostgreSQL): the poster reserves a gapless per-shard sequence under the shard row
 * lock, and checkpoints advance over it without ever blocking a posting or missing a line.
 *
 *   POSTGRES_TEST_DATABASE_URL=postgresql://... bun test test/ledger-shard-sequence.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LedgerPoster, buildLedgerTemplate, type JournalTemplate } from "../engine/ledger/LedgerPoster";
import { CheckpointService } from "../engine/ledger/CheckpointService";
import { lockWalletLedgerBalance } from "../lib/cashoutBalance";
import { clearShardWidthCache, routeLine } from "../lib/storageEngine/shardRouting";
import { fnv1aHash } from "../lib/storageEngine/shardBalances";
import { cleanupLedger, createPrisma, databaseIsReachable, seedGlAccount, uniqueId } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 40 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const created: string[] = [];
const refPrefix = uniqueId("seq");

afterAll(async () => {
  if (created.length > 0) await cleanupLedger(client, created, refPrefix);
  await client.$disconnect();
});

const template = (refId: string, treasury: string, wallet: string, amount = "1.0000"): JournalTemplate => ({
  refType: "PAYMENT_ATTEMPT",
  refId,
  description: "seq test",
  lines: [
    { direction: "DEBIT", amount, account: { accountType: "TREASURY", accountId: treasury } },
    { direction: "CREDIT", amount, account: { accountType: "MERCHANT_WALLET", accountId: wallet } },
  ],
});

const seed = async (treasuryShards: number, walletShards = 1) => {
  const treasury = await seedGlAccount(client, { accountType: "TREASURY", shardCount: treasuryShards });
  const wallet = await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: walletShards });
  created.push(treasury.id, wallet.id);
  clearShardWidthCache();
  return { treasury: treasury.id, wallet: wallet.id };
};

const postMany = async (poster: LedgerPoster, ids: { treasury: string; wallet: string }, count: number, concurrency: number) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const n = (next += 1);
        await poster.post(template(`${refPrefix}-${randomUUID()}-${n}`, ids.treasury, ids.wallet), {
          accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet },
          currency: "LYD",
        });
      }
    }),
  );
};

describeDb("sequenced shard ledger", () => {
  test("concurrent postings on one hot shard get a gapless, duplicate-free sequence and the balance matches the journal", async () => {
    const ids = await seed(1);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 120, 30);

    for (const account of [ids.treasury, ids.wallet]) {
      const shard = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: account, shardId: 0 } } });
      expect(shard.lineSeq).toBe(120n);
      const lines = await client.journalLine.findMany({ where: { glAccountId: account }, orderBy: { shardSeq: "asc" } });
      expect(lines.map((line) => line.shardSeq)).toEqual(Array.from({ length: 120 }, (_, i) => BigInt(i + 1)));
      expect(new Set(lines.map((line) => line.shardId))).toEqual(new Set([0]));
    }
    const treasuryShard = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: ids.treasury, shardId: 0 } } });
    expect(treasuryShard.currentBalance.toFixed(4)).toBe("120.0000");
  });

  test("a spread account keeps one gapless sequence PER shard, and wallet debits stay on shard 0", async () => {
    const ids = await seed(8, 4);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 200, 20);
    // wallet DEBIT lines (a refund) go to shard 0 whatever the hash says
    for (let i = 0; i < 12; i += 1) {
      await poster.post(
        {
          refType: "ADJUSTMENT",
          refId: `${refPrefix}-refund-${randomUUID()}`,
          description: "refund",
          lines: [
            { direction: "DEBIT", amount: "1.0000", account: { accountType: "MERCHANT_WALLET", accountId: ids.wallet } },
            { direction: "CREDIT", amount: "1.0000", account: { accountType: "TREASURY", accountId: ids.treasury } },
          ],
        },
        { accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet }, currency: "LYD" },
      );
    }
    for (const account of [ids.treasury, ids.wallet]) {
      const shards = await client.glAccountShard.findMany({ where: { glAccountId: account }, orderBy: { shardId: "asc" } });
      let total = 0n;
      for (const shard of shards) {
        const lines = await client.journalLine.findMany({ where: { glAccountId: account, shardId: shard.shardId }, orderBy: { shardSeq: "asc" } });
        expect(lines.map((line) => line.shardSeq)).toEqual(Array.from({ length: lines.length }, (_, i) => BigInt(i + 1)));
        expect(shard.lineSeq).toBe(BigInt(lines.length));
        total += BigInt(lines.length);
      }
      expect(total).toBe(account === ids.treasury ? 212n : 212n);
    }
    const walletDebits = await client.journalLine.findMany({ where: { glAccountId: ids.wallet, direction: "DEBIT" } });
    expect(walletDebits).toHaveLength(12);
    expect(new Set(walletDebits.map((line) => line.shardId))).toEqual(new Set([0]));
    const walletShards = await client.journalLine.groupBy({ by: ["shardId"], where: { glAccountId: ids.wallet, direction: "CREDIT" } });
    expect(walletShards.length).toBeGreaterThan(1); // credits really spread over the 4 shards
  });

  test("an idempotent replay does not bump the sequence", async () => {
    const ids = await seed(1);
    const poster = new LedgerPoster(client as never);
    const ref = `${refPrefix}-replay-${randomUUID()}`;
    const ctx = { accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet }, currency: "LYD" };
    await poster.post(template(ref, ids.treasury, ids.wallet), ctx);
    const second = await poster.post(template(ref, ids.treasury, ids.wallet), ctx);
    expect(second.idempotent).toBe(true);
    const shard = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: ids.treasury, shardId: 0 } } });
    expect(shard.lineSeq).toBe(1n);
  });

  test("a failed posting rolls back its sequence bump (no gap)", async () => {
    const ids = await seed(1);
    const poster = new LedgerPoster(client as never);
    const ctx = { accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet }, currency: "LYD" };
    await poster.post(template(`${refPrefix}-ok1-${randomUUID()}`, ids.treasury, ids.wallet), ctx);
    await expect(
      client.$transaction(async (tx) => {
        await poster.post(template(`${refPrefix}-boom-${randomUUID()}`, ids.treasury, ids.wallet), ctx, tx as never);
        throw new Error("abort after the shard bump");
      }),
    ).rejects.toThrow("abort");
    await poster.post(template(`${refPrefix}-ok2-${randomUUID()}`, ids.treasury, ids.wallet), ctx);
    const lines = await client.journalLine.findMany({ where: { glAccountId: ids.treasury }, orderBy: { shardSeq: "asc" } });
    expect(lines.map((line) => line.shardSeq)).toEqual([1n, 2n]);
  });

  test("a capture advances the checkpoint over the delta and a second capture is a no-op", async () => {
    const ids = await seed(4, 2);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 60, 10);
    const service = new CheckpointService(client as never);
    const results = await service.captureAccount(ids.treasury);
    expect(results.every((result) => result.status === "ADVANCED" || result.status === "NOOP")).toBe(true);
    const advanced = results.filter((result) => result.status === "ADVANCED");
    expect(advanced.reduce((sum, result) => sum + result.linesCovered, 0n)).toBe(60n);
    const again = await service.captureAccount(ids.treasury);
    expect(again.every((result) => result.status === "NOOP")).toBe(true);
    const checkpoints = await client.glShardCheckpoint.findMany({ where: { glAccountId: ids.treasury } });
    const sum = checkpoints.reduce((total, row) => total + Number(row.checkpointBalance), 0);
    expect(sum).toBe(60);
  });

  test("capturing while postings run never fails and always ends fully caught up", async () => {
    const ids = await seed(4, 2);
    const poster = new LedgerPoster(client as never);
    const service = new CheckpointService(client as never);
    let stop = false;
    const failures: string[] = [];
    const capturer = (async () => {
      while (!stop) {
        for (const account of [ids.treasury, ids.wallet]) {
          for (const result of await service.captureAccount(account)) {
            if (result.status === "GAP" || result.status === "PARITY") failures.push(`${result.status} shard ${result.shardId} drift ${result.drift}`);
          }
        }
      }
    })();
    await postMany(poster, ids, 300, 25);
    stop = true;
    await capturer;
    expect(failures).toEqual([]);
    for (const account of [ids.treasury, ids.wallet]) {
      for (const result of await service.captureAccount(account)) expect(["ADVANCED", "NOOP"]).toContain(result.status);
    }
    const pending = await client.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT COALESCE(SUM(s.line_seq - COALESCE(c.checkpoint_seq,0)),0)::text AS n FROM gl_account_shards s
       LEFT JOIN gl_shard_checkpoints c USING (gl_account_id, shard_id) WHERE s.gl_account_id = ANY($1::uuid[])`,
      [ids.treasury, ids.wallet],
    );
    expect(pending[0]!.n).toBe("0");
  });

  test("a missing line is detected as a GAP and a tampered balance as PARITY; neither moves the checkpoint", async () => {
    const ids = await seed(1);
    const poster = new LedgerPoster(client as never);
    await postMany(poster, ids, 10, 2);
    const service = new CheckpointService(client as never);
    await service.captureShard(ids.treasury, 0);

    // PARITY: the shard balance drifts away from the journal.
    await postMany(poster, ids, 5, 1);
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 0.5 WHERE gl_account_id = $1::uuid AND shard_id = 0`, ids.treasury);
    const parity = await service.captureShard(ids.treasury, 0);
    expect(parity.status).toBe("PARITY");
    expect(parity.drift.toFixed(4)).toBe("0.5000");
    expect(parity.firstFailure).toBe(true);
    const again = await service.captureShard(ids.treasury, 0);
    expect(again.status).toBe("PARITY");
    expect(again.firstFailure).toBe(false);
    const row = await client.glShardCheckpoint.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: ids.treasury, shardId: 0 } } });
    expect(row.checkpointSeq).toBe(10n);
    expect(row.status).toBe("PARITY");
    expect(row.consecutiveFailures).toBe(2);

    // GAP: the sequence says more lines than exist (a line was lost).
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance - 0.5, line_seq = line_seq + 1 WHERE gl_account_id = $1::uuid AND shard_id = 0`, ids.treasury);
    const gap = await service.captureShard(ids.treasury, 0);
    expect(gap.status).toBe("GAP");
    expect(gap.linesFound).toBe(5n);
  });
});

describeDb("cash-out balance lock on a spread wallet", () => {
  const lockAttempt = (account: string, shardId: number) =>
    client
      .$transaction((tx) =>
        tx.$queryRawUnsafe(`SELECT 1 FROM gl_account_shards WHERE gl_account_id = $1::uuid AND shard_id = $2 FOR UPDATE NOWAIT`, account, shardId),
      )
      .then(() => "free" as const)
      .catch((error: Error) => (/could not obtain lock|lock_not_available|55P03/i.test(JSON.stringify({ message: error?.message, meta: (error as { meta?: unknown }).meta })) ? ("locked" as const) : (`other:${error?.message}` as const)));

  const credit = (poster: LedgerPoster, ids: { treasury: string; wallet: string }, shard: number, amount: string) => {
    let refId = "";
    for (let index = 0; index < 10_000; index += 1) {
      refId = `${refPrefix}-credit-${randomUUID()}`;
      if (routeLine("MERCHANT_WALLET", "CREDIT", refId, 4) === shard) break;
    }
    return poster.post(template(refId, ids.treasury, ids.wallet, amount), { accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet }, currency: "LYD" });
  };

  test("lockWalletLedgerBalance sums ALL wallet shards; with the posting's shards pre-locked only shard 0 is held: other debiters and debits wait, credits do not", async () => {
    const ids = await seed(4, 4);
    const poster = new LedgerPoster(client as never);
    for (const [shard, amount] of [[0, "10.0000"], [1, "20.0000"], [2, "30.0000"], [3, "40.0000"]] as const) await credit(poster, ids, shard, amount);
    const walletShards = await client.glAccountShard.findMany({ where: { glAccountId: ids.wallet }, orderBy: { shardId: "asc" } });
    expect(walletShards.map((row) => row.currentBalance.toFixed(4))).toEqual(["-10.0000", "-20.0000", "-30.0000", "-40.0000"]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inside!: (balance: string) => void;
    const locked = new Promise<string>((resolve) => {
      inside = resolve;
    });
    const transaction = client.$transaction(
      async (tx) => {
        const planned = buildLedgerTemplate("CASHOUT", { amount: "1.0000" });
        // The cash-out pre-locks the treasury shard its reference hashes to. Pick one that is NOT the shard the
        // credit below uses (shard 2), so "a credit does not wait" is deterministic.
        do {
          planned.refId = `${refPrefix}-planned-${randomUUID()}`;
        } while (fnv1aHash(planned.refId) % 4 !== 3);
        const plannedContext = { accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet }, currency: "LYD" };
        const balance = await lockWalletLedgerBalance(tx, ids.wallet, {
          lockShards: () => poster.lockShardsFor(planned, plannedContext, tx as never),
        });
        inside(balance.toFixed(4));
        await held;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    let secondDebiterIn = false;
    let secondDebiter: Promise<unknown> = Promise.resolve();
    try {
      // credit-positive sum of all four shards (not just the locked one)
      expect(await locked).toBe("100.0000");

      // only shard 0 is locked
      expect(await lockAttempt(ids.wallet, 0)).toBe("locked");
      for (const shard of [1, 2, 3]) expect(await lockAttempt(ids.wallet, shard)).toBe("free");

      // another debiter of the same wallet waits for the wallet debit lock (it holds no shard row while waiting)
      secondDebiter = client
        .$transaction(async (tx2) => {
          await lockWalletLedgerBalance(tx2, ids.wallet);
          secondDebiterIn = true;
        }, { timeout: 30_000, maxWait: 10_000 });
      await Bun.sleep(300);
      expect(secondDebiterIn).toBe(false);

      // a credit on another shard goes through while the lock is held (it can only raise the balance) ...
      await credit(poster, ids, 2, "5.0000");

      // ... a balance-reducing line of the same wallet is pinned to shard 0 and waits for the lock holder
      let debitDone = false;
      const debit = poster
        .post(
          {
            refType: "ADJUSTMENT",
            refId: `${refPrefix}-cashout-${randomUUID()}`,
            description: "cash-out",
            lines: [
              { direction: "DEBIT", amount: "1.0000", account: { accountType: "MERCHANT_WALLET", accountId: ids.wallet } },
              { direction: "CREDIT", amount: "1.0000", account: { accountType: "TREASURY", accountId: ids.treasury } },
            ],
          },
          { accounts: { TREASURY: ids.treasury, MERCHANT_WALLET: ids.wallet }, currency: "LYD" },
        )
        .then(() => {
          debitDone = true;
        });
      await Bun.sleep(400);
      expect(debitDone).toBe(false);
    } finally {
      release();
    }
    await transaction;
    await secondDebiter;
    expect(secondDebiterIn).toBe(true);
    await Bun.sleep(0);
    // the waiting debit completes once the lock is released, and it landed on shard 0
    await Bun.sleep(300);
    const debits = await client.journalLine.findMany({ where: { glAccountId: ids.wallet, direction: "DEBIT" } });
    expect(debits).toHaveLength(1);
    expect(debits[0]!.shardId).toBe(0);
    expect(debits[0]!.shardSeq).toBe(2n); // shard 0 already carried the 10.0000 credit
    // after the commit the lock is gone and the balance reflects the credit and the debit: 105 - 1
    expect(await lockAttempt(ids.wallet, 0)).toBe("free");
    expect((await client.$transaction((tx) => lockWalletLedgerBalance(tx, ids.wallet))).toFixed(4)).toBe("104.0000");
  });

  test("on a transaction without raw SQL the balance is the credit-positive journal sum (the in-memory fakes)", async () => {
    const lines = [
      { direction: "CREDIT", amount: "7.5000" },
      { direction: "DEBIT", amount: "2.0000" },
    ];
    const fake = { journalLine: { findMany: async () => lines } };
    expect((await lockWalletLedgerBalance(fake, "acc")).toFixed(4)).toBe("5.5000");
  });
});
