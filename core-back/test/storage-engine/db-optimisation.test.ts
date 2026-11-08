import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "../../generated/prisma/client";
import { LedgerPoster } from "../../engine/ledger/LedgerPoster";
import { readThroughReplicaOrPrimary, setStorageEngine } from "../../lib/storageEngine";
import type { StorageEngine } from "../../lib/storageEngine/ports";
import { createLedgerShardWriter } from "../../lib/storageEngine/ledgerShardWriter";
import { clearShardWidthCache, foldShardBumps } from "../../lib/storageEngine/shardRouting";
import {
  aggregateAttemptTransitions,
  nextPollDelayMs,
  projectAttemptTransition,
  OutboxRelayWorker,
  AuditShipperWorker,
} from "../../lib/storageEngine/outboxWorkers";
import { loadLiveAccountBalances } from "../../lib/storageEngine/shardBalances";

const event = (payload: Record<string, unknown>) => ({
  topic: "attempt.transitioned" as const,
  aggregateType: "PAYMENT_ATTEMPT",
  aggregateId: "a",
  merchantId: "11111111-1111-4111-8111-111111111111",
  payload,
});

describe("attempt read-model deltas", () => {
  const base = {
    merchantId: "11111111-1111-4111-8111-111111111111",
    routeId: "22222222-2222-4222-8222-222222222222",
    currency: "LYD",
    occurredAt: "2026-11-04T10:00:00.000Z",
    totalChargedAmount: "100.0000",
    netMerchantAmount: "90.0000",
  };

  test("created adds attempts and gross; SUCCEEDED adds success amounts and route volume", () => {
    const deltas = aggregateAttemptTransitions([
      event({ ...base, event: "created", status: "CREATED" }),
      event({ ...base, event: "created", status: "CREATED" }),
      event({ ...base, event: "terminal", status: "SUCCEEDED" }),
      event({ ...base, event: "terminal", status: "FAILED" }),
      event({ ...base, event: "terminal", status: "REFUNDED" }),
    ]);
    expect(deltas.merchants).toHaveLength(1);
    const merchant = deltas.merchants[0]!;
    expect(merchant.attemptCount).toBe(2);
    expect(merchant.successCount).toBe(1);
    expect(merchant.failureCount).toBe(1);
    expect(merchant.grossAmount.toFixed(4)).toBe("200.0000");
    expect(merchant.successAmount.toFixed(4)).toBe("100.0000");
    expect(merchant.successNetAmount.toFixed(4)).toBe("90.0000");
    const route = deltas.routes[0]!;
    expect(route.attemptCount).toBe(2);
    expect(route.successCount).toBe(1);
    expect(route.volumeAmount.toFixed(4)).toBe("100.0000");
  });

  test("money never goes through a float", () => {
    const deltas = aggregateAttemptTransitions([
      event({ ...base, event: "terminal", status: "SUCCEEDED", totalChargedAmount: "9007199254740993.1234" }),
      event({ ...base, event: "terminal", status: "SUCCEEDED", totalChargedAmount: "0.1000" }),
      event({ ...base, event: "terminal", status: "SUCCEEDED", totalChargedAmount: "0.2000" }),
    ]);
    expect(deltas.merchants[0]!.successAmount.toFixed(4)).toBe("9007199254740993.4234");
  });

  test("legacy events without a marker count as created; keys sort deterministically; garbage is skipped", () => {
    const deltas = aggregateAttemptTransitions([
      event({ ...base, merchantId: "bbbbbbbb-1111-4111-8111-111111111111", status: "CREATED" }),
      event({ ...base, merchantId: "aaaaaaaa-1111-4111-8111-111111111111", status: "CREATED" }),
      event({ ...base, event: "terminal", status: "UNKNOWN" }),
    ]);
    expect(deltas.merchants.map((row) => row.merchantId[0])).toEqual(["a", "b"]);
    expect(deltas.merchants.every((row) => row.attemptCount === 1)).toBe(true);
  });

  test("a batch is projected with one statement per read model", async () => {
    const statements: string[] = [];
    const db = { $executeRawUnsafe: async (sql: string) => { statements.push(sql); return 1; } } as unknown as PrismaClient;
    await projectAttemptTransition(event({ ...base, event: "created", status: "CREATED" }), db);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("unnest");
  });
});

describe("poll scheduling", () => {
  test("full batch re-polls immediately, empty polls back off to the cap", () => {
    expect(nextPollDelayMs(100, 100, 0, 250, 2000)).toBe(0);
    expect(nextPollDelayMs(3, 100, 2000, 250, 2000)).toBe(250);
    expect(nextPollDelayMs(0, 100, 0, 250, 2000)).toBe(250);
    expect(nextPollDelayMs(0, 100, 250, 250, 2000)).toBe(500);
    expect(nextPollDelayMs(0, 100, 1500, 250, 2000)).toBe(2000);
  });
});

describe("outbox / audit retention", () => {
  test("pruning is disabled without a retention window and bounded when enabled", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => { calls.push({ sql, values }); return 7; },
    } as unknown as PrismaClient;
    expect(await new OutboxRelayWorker(db).prune()).toBe(0);
    expect(calls).toHaveLength(0);

    const now = new Date("2026-11-04T12:00:00.000Z");
    const relay = new OutboxRelayWorker(db, { retention: { retentionMs: 3_600_000, pruneBatchSize: 10 } });
    expect(await relay.prune(now)).toBe(7);
    expect(calls[0]!.sql).toContain("processed_at IS NOT NULL");
    expect(calls[0]!.sql).toContain("min(id) FROM outbox_events WHERE processed_at IS NULL");
    expect((calls[0]!.values[0] as Date).toISOString()).toBe("2026-11-04T11:00:00.000Z");
    expect(calls[0]!.values[1]).toBe(10);

    const shipper = new AuditShipperWorker(db, {} as never, { retention: { retentionMs: 60_000 } });
    await shipper.prune(now);
    expect(calls[1]!.sql).toContain("shipped_at IS NOT NULL");
  });

  test("the audit shipper claims with a lease in a single statement", async () => {
    const statements: string[] = [];
    const db = {
      $queryRawUnsafe: async (sql: string) => { statements.push(sql); return []; },
    } as unknown as PrismaClient;
    expect(await new AuditShipperWorker(db, {} as never).drain()).toBe(0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("lease_until");
    expect(statements[0]).toContain("FOR UPDATE SKIP LOCKED");
  });
});

describe("shard bumps", () => {
  const line = (glAccountId: string, direction: "DEBIT" | "CREDIT", amount: string, shardId = 0) => ({
    glAccountId, shardId, direction, amount,
  });

  test("lines of one shard fold into one signed delta and a line count, rows are sorted by (account, shard)", () => {
    const bumps = foldShardBumps([
      line("bbb", "DEBIT", "10.5000"),
      line("aaa", "CREDIT", "3.0000"),
      line("bbb", "CREDIT", "0.5000"),
      line("bbb", "DEBIT", "1.0000", 2),
    ]);
    expect(bumps.map((row) => [row.glAccountId, row.shardId])).toEqual([["aaa", 0], ["bbb", 0], ["bbb", 2]]);
    expect(bumps[0]!.delta.toFixed(4)).toBe("-3.0000");
    expect(bumps[1]!.delta.toFixed(4)).toBe("10.0000");
    expect(bumps.map((row) => row.count)).toEqual([1, 2, 1]);
  });

  const lineOf = (glAccountId: string, direction: "DEBIT" | "CREDIT", amount: string) => ({
    entryId: "e", refType: "PAYMENT_ATTEMPT", refId: "ref-1", glAccountId, accountType: "TREASURY" as const, direction, amount,
  });
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

  test("the writer issues one unnest upsert per posting (it loads the widths first) and hands every line its sequence", async () => {
    clearShardWidthCache();
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes("FROM gl_accounts")) return ids.map((id) => ({ id, shard_count: 1 }));
        return [
          { gl_account_id: ids[0], shard_id: 0, line_seq: "7" },
          { gl_account_id: ids[1], shard_id: 0, line_seq: "3" },
        ];
      },
    };
    const assignments = await createLedgerShardWriter()(tx as never, [lineOf(ids[0]!, "DEBIT", "1.0000"), lineOf(ids[1]!, "CREDIT", "1.0000")]);
    const upserts = statements.filter((entry) => entry.sql.includes("unnest"));
    expect(upserts).toHaveLength(1);
    expect(statements).toHaveLength(2); // widths (one batched read) + one upsert
    expect(upserts[0]!.sql).toContain("RETURNING");
    expect(upserts[0]!.sql).toContain("line_seq = s.line_seq + EXCLUDED.line_seq");
    expect(upserts[0]!.values[2]).toEqual(["1.0000", "-1.0000"]);
    expect(assignments).toEqual([{ shardId: 0, shardSeq: 7n }, { shardId: 0, shardSeq: 3n }]);
  });

  test("two lines on one shard get consecutive sequence numbers ending at the returned high-water", async () => {
    clearShardWidthCache();
    const tx = {
      $queryRawUnsafe: async (sql: string) =>
        sql.includes("FROM gl_accounts") ? [{ id: ids[0], shard_count: 1 }] : [{ gl_account_id: ids[0], shard_id: 0, line_seq: "12" }],
    };
    const assignments = await createLedgerShardWriter()(tx as never, [lineOf(ids[0]!, "DEBIT", "1.0000"), lineOf(ids[0]!, "CREDIT", "1.0000")]);
    expect(assignments.map((entry) => entry.shardSeq)).toEqual([11n, 12n]);
  });

  test("a double without raw SQL (or a statement without RETURNING rows) gets the neutral shard 0 / seq 0 assignment", async () => {
    expect(await createLedgerShardWriter()({} as never, [lineOf("a", "DEBIT", "1.0000")])).toEqual([{ shardId: 0, shardSeq: 0n }]);
    clearShardWidthCache();
    const silent = { $queryRawUnsafe: async () => [] };
    expect(await createLedgerShardWriter()(silent as never, [lineOf(ids[0]!, "DEBIT", "1.0000")])).toEqual([{ shardId: 0, shardSeq: 0n }]);
    expect(await createLedgerShardWriter()(silent as never, [])).toEqual([]);
  });
});

describe("LedgerPoster batched writes", () => {
  const accounts: Record<string, string> = { TREASURY: "t", MERCHANT_WALLET: "w" };
  const makeClient = () => {
    const calls: string[] = [];
    const inserted: unknown[] = [];
    const client: any = {
      glAccount: {
        findFirst: async () => { calls.push("findFirst"); return null; },
        findMany: async () => { calls.push("glAccount.findMany"); return []; },
      },
      journalEntry: {
        findFirst: async () => { calls.push("entry.findFirst"); return null; },
        create: async () => { calls.push("entry.create"); return { id: "e1", refType: "PAYMENT_ATTEMPT", refId: "r" }; },
        createManyAndReturn: async () => { calls.push("entry.createManyAndReturn"); return [{ id: "e1", refType: "PAYMENT_ATTEMPT", refId: "r" }]; },
      },
      journalLine: {
        create: async () => { calls.push("line.create"); return {}; },
        createManyAndReturn: async ({ data }: { data: unknown[] }) => { calls.push(`line.createMany:${data.length}`); inserted.push(...data); return data; },
      },
    };
    return { client, calls, inserted };
  };

  test("one entry insert, one line insert, one shard statement; accounts come from the context", async () => {
    const { client, calls, inserted } = makeClient();
    const shardCalls: number[] = [];
    const poster = new LedgerPoster(client as never, undefined, async (_tx, lines) => {
      shardCalls.push(lines.length);
      return lines.map((_line, index) => ({ shardId: index, shardSeq: BigInt(index + 5) }));
    });
    const result = await poster.post(
      {
        refType: "PAYMENT_ATTEMPT", refId: "r", description: "d",
        lines: [
          { direction: "DEBIT", amount: new Decimal("10"), account: { accountType: "TREASURY" } },
          { direction: "CREDIT", amount: new Decimal("10"), account: { accountType: "MERCHANT_WALLET" } },
        ],
      },
      { accounts: accounts as never },
    );
    expect(result.created).toBe(true);
    expect(calls).toEqual(["entry.createManyAndReturn", "line.createMany:2"]);
    expect(shardCalls).toEqual([2]);
    // the reserved shard and sequence number travel with each line
    expect(inserted).toMatchObject([{ shardId: 0, shardSeq: 5n }, { shardId: 1, shardSeq: 6n }]);
  });

  test("the default shard writer reserves before the lines are inserted, and a double without raw SQL gets shard 0 / seq 0", async () => {
    const { client, inserted } = makeClient();
    await new LedgerPoster(client as never).post(
      {
        refType: "PAYMENT_ATTEMPT", refId: "r", description: "d",
        lines: [
          { direction: "DEBIT", amount: "1", account: { accountType: "TREASURY", accountId: "t" } },
          { direction: "CREDIT", amount: "1", account: { accountType: "MERCHANT_WALLET", accountId: "w" } },
        ],
      },
    );
    expect(inserted).toMatchObject([{ shardId: 0, shardSeq: 0n }, { shardId: 0, shardSeq: 0n }]);
  });

  test("a conflicting reference returns the existing entry without aborting", async () => {
    const { client } = makeClient();
    client.journalEntry.createManyAndReturn = async () => [];
    client.journalEntry.findFirst = async () => ({ id: "old", refType: "PAYMENT_ATTEMPT", refId: "r" });
    const result = await new LedgerPoster(client as never).post(
      {
        refType: "PAYMENT_ATTEMPT", refId: "r", description: "d",
        lines: [
          { direction: "DEBIT", amount: "1", account: { accountType: "TREASURY", accountId: "t" } },
          { direction: "CREDIT", amount: "1", account: { accountType: "MERCHANT_WALLET", accountId: "w" } },
        ],
      },
    );
    expect(result).toMatchObject({ created: false, idempotent: true });
  });

  test("unmapped accounts are resolved with one findMany, scoped before platform-wide", async () => {
    const { client, calls } = makeClient();
    client.glAccount.findMany = async () => {
      calls.push("glAccount.findMany");
      return [
        { id: "global-treasury", accountType: "TREASURY", ownerId: null, gatewayId: null, credentialSetId: null, env: null, currency: "LYD" },
        { id: "wallet-m1", accountType: "MERCHANT_WALLET", ownerId: "m1", gatewayId: null, credentialSetId: null, env: null, currency: "LYD" },
      ] as never;
    };
    await new LedgerPoster(client as never).post(
      {
        refType: "PAYMENT_ATTEMPT", refId: "r", description: "d",
        lines: [
          { direction: "DEBIT", amount: "5", account: { accountType: "TREASURY" } },
          { direction: "CREDIT", amount: "5", account: { accountType: "MERCHANT_WALLET" } },
        ],
      },
      { merchantId: "m1", currency: "LYD" },
    );
    expect(calls.filter((name) => name === "glAccount.findMany")).toHaveLength(1);
    expect(calls).not.toContain("findFirst");
  });
});

describe("read-through-replica helper", () => {
  test("a failing query is not executed a second time", async () => {
    let runs = 0;
    const primary = { marker: "primary" } as unknown as PrismaClient;
    setStorageEngine({
      readStore: {
        execute: async (_c: unknown, fn: (reader: PrismaClient) => Promise<unknown>) => ({ data: await fn(primary), servedBy: "primary" }),
      },
      primary,
    } as unknown as StorageEngine);
    try {
      await expect(readThroughReplicaOrPrimary(primary, undefined, async () => { runs += 1; throw new Error("bad query"); }))
        .rejects.toThrow("bad query");
      expect(runs).toBe(1);
    } finally {
      setStorageEngine(undefined);
    }
  });
});

describe("live account balances", () => {
  test("one statement over the shards only; the stored debit-positive sum is converted to the natural sign", async () => {
    const statements: string[] = [];
    const db = {
      $queryRawUnsafe: async (sql: string) => {
        statements.push(sql);
        return [
          { id: "w", accountType: "MERCHANT_WALLET", raw: "-40.0000" },
          { id: "t", accountType: "TREASURY", raw: "40.0000" },
          { id: "empty", accountType: "PLATFORM_INCOME", raw: "0.0000" },
        ];
      },
    };
    const rows = await loadLiveAccountBalances(db, ["w", "t", "empty"]);
    expect(statements).toHaveLength(1);
    // shards only: there is no journal fallback any more
    expect(statements[0]).toContain("gl_account_shards");
    expect(statements[0]).not.toContain("journal_lines");
    expect(rows.find((row) => row.id === "w")).toMatchObject({ balance: "40.0000", source: "shards" });
    expect(rows.find((row) => row.id === "t")).toMatchObject({ balance: "40.0000", source: "shards" });
    expect(rows.find((row) => row.id === "empty")).toMatchObject({ balance: "0", source: "shards" });
    expect(await loadLiveAccountBalances(db, [])).toEqual([]);
    expect(statements).toHaveLength(1); // an empty filter never hits the database
    expect(await loadLiveAccountBalances({}, ["w"])).toEqual([]);
  });
});
