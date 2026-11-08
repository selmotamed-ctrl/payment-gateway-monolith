import { afterAll, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "../../generated/prisma/client";
import { LedgerPoster, type JournalTemplate } from "../../engine/ledger/LedgerPoster";
import { clearShardWidthCache, routeLine } from "../../lib/storageEngine/shardRouting";
import {
  cleanupLedger,
  createPrisma,
  databaseIsReachable,
  describeDatabase,
  seedGlAccount,
  uniqueId,
} from "./helpers/db";

const client: PrismaClient = createPrisma({ max: 30 });

afterAll(async () => {
  await client.$disconnect().catch(() => undefined);
});

if (!databaseIsReachable) {
  test.skip("ledger shard suite requires the live database", () => undefined);
}

const templateFor = (
  refId: string,
  systemAccountId: string,
  merchantAccountId: string,
  amount: string,
): JournalTemplate => ({
  refType: "PAYMENT_ATTEMPT",
  refId,
  description: "shard projection test",
  lines: [
    { direction: "DEBIT", amount, account: { accountType: "TREASURY", accountId: systemAccountId } },
    {
      direction: "CREDIT",
      amount,
      account: { accountType: "MERCHANT_WALLET", accountId: merchantAccountId },
    },
  ],
});

const post = (
  poster: LedgerPoster,
  template: JournalTemplate,
  systemAccountId: string,
  merchantAccountId: string,
): Promise<unknown> =>
  poster.post(template, {
    accounts: {
      TREASURY: systemAccountId,
      MERCHANT_WALLET: merchantAccountId,
    },
    currency: "LYD",
  });

const shardSums = async (
  accountIds: string[],
): Promise<Map<string, Decimal>> => {
  const rows = await client.glAccountShard.findMany({
    where: { glAccountId: { in: accountIds } },
  });
  const sums = new Map<string, Decimal>();
  for (const accountId of accountIds) {
    sums.set(accountId, new Decimal(0));
  }
  for (const row of rows) {
    const current = sums.get(row.glAccountId) ?? new Decimal(0);
    sums.set(row.glAccountId, current.plus(row.currentBalance.toString()));
  }
  return sums;
};

const ledgerBalances = async (
  accountIds: string[],
): Promise<Map<string, Decimal>> => {
  const lines = await client.journalLine.findMany({
    where: { glAccountId: { in: accountIds } },
  });
  const balances = new Map<string, Decimal>();
  for (const accountId of accountIds) {
    balances.set(accountId, new Decimal(0));
  }
  for (const line of lines) {
    const current = balances.get(line.glAccountId) ?? new Decimal(0);
    const amount = new Decimal(line.amount.toString());
    balances.set(
      line.glAccountId,
      line.direction === "DEBIT" ? current.plus(amount) : current.minus(amount),
    );
  }
  return balances;
};

describeDatabase("ledger shard projection (live PostgreSQL)", () => {
  test("projects 200 balanced entries with a 16-way system spread and one wallet row", async () => {
    const refPrefix = uniqueId("ledger-shards");
    const system = await seedGlAccount(client, { shardCount: 16, accountType: "TREASURY" });
    const merchant = await seedGlAccount(client, {
      shardCount: 1,
      accountType: "MERCHANT_WALLET",
    });
    const accountIds = [system.id, merchant.id];
    clearShardWidthCache();
    const poster = new LedgerPoster(client);

    try {
      const refs = new Set<string>();
      // Guarantee at least one entry per shard, then fill to 200 entries.
      let counter = 0;
      for (let wantedShard = 0; wantedShard < 16; wantedShard += 1) {
        for (;;) {
          const candidate = `${refPrefix}-${counter}`;
          counter += 1;
          if (!refs.has(candidate) && routeLine("TREASURY", "DEBIT", candidate, 16) === wantedShard) {
            refs.add(candidate);
            break;
          }
        }
      }
      while (refs.size < 200) {
        refs.add(`${refPrefix}-${counter}`);
        counter += 1;
      }

      for (const refId of refs) {
        const result = (await post(
          poster,
          templateFor(refId, system.id, merchant.id, "10.0000"),
          system.id,
          merchant.id,
        )) as { created: boolean };
        expect(result.created).toBe(true);
      }

      const sums = await shardSums(accountIds);
      const ledger = await ledgerBalances(accountIds);
      expect(sums.get(system.id)?.toFixed(4)).toBe("2000.0000");
      expect(sums.get(merchant.id)?.toFixed(4)).toBe("-2000.0000");
      expect(sums.get(system.id)?.toFixed(4)).toBe(ledger.get(system.id)?.toFixed(4));
      expect(sums.get(merchant.id)?.toFixed(4)).toBe(ledger.get(merchant.id)?.toFixed(4));

      const systemShards = await client.glAccountShard.findMany({
        where: { glAccountId: system.id },
      });
      expect(systemShards).toHaveLength(16);
      expect(
        systemShards.filter((row) => !new Decimal(row.currentBalance.toString()).isZero()),
      ).toHaveLength(16);
      // every shard owns a gapless sequence: line_seq is the number of lines posted to it
      for (const shard of systemShards) {
        const onShard = await client.journalLine.count({ where: { glAccountId: system.id, shardId: shard.shardId } });
        expect(shard.lineSeq).toBe(BigInt(onShard));
        expect(onShard).toBeGreaterThan(0);
      }

      const merchantShards = await client.glAccountShard.findMany({
        where: { glAccountId: merchant.id },
      });
      expect(merchantShards).toHaveLength(1);
      expect(merchantShards[0]?.shardId).toBe(0);

      const firstRef = [...refs][0] as string;
      const before = await shardSums(accountIds);
      const replayed = (await post(
        poster,
        templateFor(firstRef, system.id, merchant.id, "10.0000"),
        system.id,
        merchant.id,
      )) as { created: boolean; idempotent: boolean };
      expect(replayed.created).toBe(false);
      expect(replayed.idempotent).toBe(true);
      const after = await shardSums(accountIds);
      expect(after.get(system.id)?.toFixed(4)).toBe(before.get(system.id)?.toFixed(4));
      expect(after.get(merchant.id)?.toFixed(4)).toBe(before.get(merchant.id)?.toFixed(4));
    } finally {
      await cleanupLedger(client, accountIds, refPrefix);
    }
  });

  test("concurrent posting preserves zero double-entry drift and shard parity", async () => {
    const refPrefix = uniqueId("ledger-concurrent");
    const system = await seedGlAccount(client, { shardCount: 16, accountType: "TREASURY" });
    const merchant = await seedGlAccount(client, {
      shardCount: 1,
      accountType: "MERCHANT_WALLET",
    });
    const accountIds = [system.id, merchant.id];
    clearShardWidthCache();
    const poster = new LedgerPoster(client);

    try {
      const refs = Array.from(
        { length: 50 },
        (_, index) => `${refPrefix}-${index}`,
      );
      const results = await Promise.all(
        refs.map((refId) =>
          post(poster, templateFor(refId, system.id, merchant.id, "3.2500"), system.id, merchant.id),
        ),
      );
      expect(results.every((result) => (result as { created: boolean }).created)).toBe(true);

      const lines = await client.journalLine.findMany({
        where: { glAccountId: { in: accountIds } },
      });
      let debits = new Decimal(0);
      let credits = new Decimal(0);
      for (const line of lines) {
        const amount = new Decimal(line.amount.toString());
        if (line.direction === "DEBIT") {
          debits = debits.plus(amount);
        } else {
          credits = credits.plus(amount);
        }
      }
      expect(debits.minus(credits).toFixed(4)).toBe("0.0000");
      expect(debits.toFixed(4)).toBe("162.5000");

      const sums = await shardSums(accountIds);
      const ledger = await ledgerBalances(accountIds);
      expect(sums.get(system.id)?.toFixed(4)).toBe(ledger.get(system.id)?.toFixed(4));
      expect(sums.get(merchant.id)?.toFixed(4)).toBe(ledger.get(merchant.id)?.toFixed(4));
    } finally {
      await cleanupLedger(client, accountIds, refPrefix);
    }
  });

  test("ensureAccountShards provisions the full shard set idempotently and never touches existing shard rows", async () => {
    const { ensureAccountShards } = await import("../../lib/storageEngine/ledgerShardWriter");
    // The account starts with shard 0 (created by the gl_accounts_create_shards trigger).
    const account = await seedGlAccount(client, { shardCount: 1 });
    const refPrefix = uniqueId("ensure-shards");
    try {
      const executor = client as unknown as {
        $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
      };
      expect(await client.glAccountShard.count({ where: { glAccountId: account.id } })).toBe(1);
      await new LedgerPoster(client).post(
        {
          refType: "ADJUSTMENT",
          refId: `${refPrefix}-seed`,
          description: "ensure shards",
          lines: [
            { direction: "DEBIT", amount: "2.0000", account: { accountType: "TREASURY", accountId: account.id } },
            { direction: "CREDIT", amount: "2.0000", account: { accountType: "TREASURY", accountId: account.id } },
          ],
        },
        { currency: "LYD" },
      );
      const before = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: account.id, shardId: 0 } } });
      expect(before.lineSeq).toBe(2n);

      await ensureAccountShards(executor, account.id, 16);
      expect(await client.glAccountShard.count({ where: { glAccountId: account.id } })).toBe(16);
      await ensureAccountShards(executor, account.id, 16);
      expect(await client.glAccountShard.count({ where: { glAccountId: account.id } })).toBe(16);
      // existing rows keep their sequence and balance (ON CONFLICT DO NOTHING)
      const after = await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: account.id, shardId: 0 } } });
      expect(after.lineSeq).toBe(2n);
      // `from` only creates the range above it; narrowing or an equal width is a no-op; the width is clamped to 256
      await ensureAccountShards(executor, account.id, 20, 16);
      expect(await client.glAccountShard.count({ where: { glAccountId: account.id } })).toBe(20);
      await ensureAccountShards(executor, account.id, 4);
      await ensureAccountShards(executor, account.id, 20, 20);
      expect(await client.glAccountShard.count({ where: { glAccountId: account.id } })).toBe(20);
      await ensureAccountShards(executor, account.id, 100_000, 250);
      expect(await client.glAccountShard.count({ where: { glAccountId: account.id } })).toBe(26);
    } finally {
      await cleanupLedger(client, [account.id], refPrefix);
    }
  });
});
