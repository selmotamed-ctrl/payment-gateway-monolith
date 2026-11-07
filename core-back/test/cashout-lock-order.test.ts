/**
 * Regression for the cash-out vs payment-confirmation deadlock (GAP-200), live PostgreSQL.
 *
 * A cash-out used to lock the wallet's shard-0 row for its balance check and only then post, which locks a
 * treasury shard; a payment confirmation locks the treasury shard FIRST and the wallet second. Two transactions on
 * the same pair of rows therefore waited for each other and PostgreSQL aborted one with 40P01. The cash-out now takes
 * a wallet debit advisory lock first and pre-locks the posting's shard rows in the global order.
 *
 * Both accounts are one shard wide, so every cash-out and every confirmation touches exactly the same two rows: the
 * worst case for the cycle.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LedgerPoster, buildLedgerTemplate, type JournalTemplate } from "../engine/ledger/LedgerPoster";
import { lockWalletLedgerBalance } from "../lib/cashoutBalance";
import { clearShardWidthCache } from "../lib/storageEngine/shardRouting";
import { cleanupLedger, createPrisma, databaseIsReachable, seedGlAccount, uniqueId } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 40 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const created: string[] = [];
const refPrefix = uniqueId("colo");

afterAll(async () => {
  if (created.length > 0) await cleanupLedger(client, created, refPrefix);
  await client.$disconnect();
});

const isDeadlock = (error: unknown): boolean => /deadlock detected|40P01/i.test(String((error as { message?: string })?.message ?? error));

const payment = (refId: string, treasury: string, wallet: string): JournalTemplate => ({
  refType: "PAYMENT_ATTEMPT",
  refId,
  description: "payment confirmation",
  lines: [
    { direction: "DEBIT", amount: "5.0000", account: { accountType: "TREASURY", accountId: treasury } },
    { direction: "CREDIT", amount: "5.0000", account: { accountType: "MERCHANT_WALLET", accountId: wallet } },
  ],
});

describeDb("cash-out lock order", () => {
  test("concurrent cash-outs and payment confirmations on the same rows never deadlock and never overdraw", async () => {
    const treasury = (await seedGlAccount(client, { accountType: "TREASURY", shardCount: 1 })).id;
    const wallet = (await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 })).id;
    created.push(treasury, wallet);
    clearShardWidthCache();
    const poster = new LedgerPoster(client as never);
    const accounts = { TREASURY: treasury, MERCHANT_WALLET: wallet };
    const ctx = { accounts, currency: "LYD" };

    // fund the wallet with exactly 40 payments of 5 = 200
    for (let i = 0; i < 40; i += 1) await poster.post(payment(`${refPrefix}-seed-${i}`, treasury, wallet), ctx);

    const deadlocks: string[] = [];
    const failures: string[] = [];
    let cashoutsDone = 0;
    let insufficient = 0;

    const cashout = async (n: number) => {
      const journal = buildLedgerTemplate("CASHOUT", { amount: "10.0000" });
      journal.refId = `${refPrefix}-cashout-${n}`;
      try {
        await client.$transaction(async (tx) => {
          const balance = await lockWalletLedgerBalance(tx, wallet, {
            lockShards: () => poster.lockShardsFor(journal, ctx, tx as never),
          });
          if (balance.lt(10)) {
            insufficient += 1;
            return;
          }
          await poster.post(journal, ctx, tx as never);
          cashoutsDone += 1;
        });
      } catch (error) {
        (isDeadlock(error) ? deadlocks : failures).push(String((error as Error).message));
      }
    };
    const confirmation = async (n: number) => {
      try {
        await poster.post(payment(`${refPrefix}-pay-${n}`, treasury, wallet), ctx);
      } catch (error) {
        (isDeadlock(error) ? deadlocks : failures).push(String((error as Error).message));
      }
    };

    await Promise.all(Array.from({ length: 60 }, (_, n) => [cashout(n), confirmation(n)]).flat());

    expect(deadlocks).toEqual([]);
    expect(failures).toEqual([]);
    // Money is conserved: wallet = 200 + 60 payments of 5 - 10 per executed cash-out, never negative.
    const shard = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: wallet, shardId: 0 } } });
    const balance = -Number(shard.currentBalance);
    expect(balance).toBeCloseTo(200 + 60 * 5 - cashoutsDone * 10, 4);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(cashoutsDone + insufficient).toBe(60);
  });

  test("two cash-outs of one wallet are serialized: the second sees the first one's debit", async () => {
    const treasury = (await seedGlAccount(client, { accountType: "TREASURY", shardCount: 4 })).id;
    const wallet = (await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 })).id;
    created.push(treasury, wallet);
    clearShardWidthCache();
    const poster = new LedgerPoster(client as never);
    const ctx = { accounts: { TREASURY: treasury, MERCHANT_WALLET: wallet }, currency: "LYD" };
    await poster.post(payment(`${refPrefix}-fund-${randomUUID()}`, treasury, wallet), ctx); // wallet holds 5

    const attempt = async (n: number): Promise<boolean> => {
      const journal = buildLedgerTemplate("CASHOUT", { amount: "5.0000" });
      journal.refId = `${refPrefix}-single-${n}-${randomUUID()}`;
      return client.$transaction(async (tx) => {
        const balance = await lockWalletLedgerBalance(tx, wallet, { lockShards: () => poster.lockShardsFor(journal, ctx, tx as never) });
        if (balance.lt(5)) return false;
        await poster.post(journal, ctx, tx as never);
        return true;
      });
    };
    const results = await Promise.all([attempt(1), attempt(2), attempt(3)]);
    expect(results.filter(Boolean)).toHaveLength(1); // 5 LYD only covers ONE cash-out of 5
    const shard = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: wallet, shardId: 0 } } });
    expect(Number(shard.currentBalance)).toBe(0);
  });
});
