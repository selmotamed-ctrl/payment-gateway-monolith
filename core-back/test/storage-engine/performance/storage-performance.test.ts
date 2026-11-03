import { afterAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "../../../generated/prisma/client";
import { compareLsn } from "../../../lib/storageEngine/lsn";
import { uuidv7 } from "../../../lib/storageEngine/uuid";
import { stableJson } from "../../../lib/storageEngine/auditAndLogAdapters";
import { PostgresUnitOfWorkAdapter } from "../../../lib/storageEngine/uowAdapter";
import { OutboxRelayWorker } from "../../../lib/storageEngine/outboxWorkers";
import { PostgresReplicaReadStore } from "../../../lib/storageEngine/readStoreAdapter";
import type { ReplicaNodeHandle } from "../../../lib/storageEngine/readStoreAdapter";
import { MemoryCacheAdapter, RedisCacheAdapter } from "../../../lib/storageEngine/redisCacheAndVelocityAdapter";
import type { VelocityCheckDescriptor } from "../../../lib/storageEngine/ports";
import {
  REDIS_URL,
  cleanupLedger,
  createAuditSandbox,
  createPrisma,
  createWorkerSandbox,
  databaseIsReachable,
  describeDatabase,
  describeRedis,
  redisIsReachable,
  seedGlAccount,
  uniqueId,
  uniqueUuid,
} from "../helpers/db";

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
};

const report = (label: string, value: number): void => {
  console.log(`[perf] ${label}: ${value.toFixed(1)}ms`);
};

describe("pure storage primitives performance", () => {
  test("compareLsn 1,000,000 operations median < 1000ms", () => {
    const runs: number[] = [];
    let sink = 0;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      for (let index = 0; index < 1_000_000; index += 1) {
        sink += compareLsn(index % 2 === 0 ? "16/B374D848" : "0/1", "0/1");
      }
      runs.push(performance.now() - started);
    }
    expect(sink).toBeGreaterThan(0);
    const value = median(runs);
    report("compareLsn 1M median", value);
    expect(value).toBeLessThan(1_000);
  });

  test("uuidv7 100,000 ids median < 2000ms", () => {
    const runs: number[] = [];
    let last = "";
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      for (let index = 0; index < 100_000; index += 1) {
        last = uuidv7(1_761_000_000_000 + index);
      }
      runs.push(performance.now() - started);
    }
    expect(last).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    const value = median(runs);
    report("uuidv7 100k median", value);
    expect(value).toBeLessThan(2_000);
  });

  test("stableJson 10,000 rows median < 2000ms", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      zebra: index,
      alpha: { nested: [{ b: index, a: index + 1 }], values: [1, 2, 3] },
      beta: `row-${index}`,
    }));
    const runs: number[] = [];
    let length = 0;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      for (const row of rows) {
        length += stableJson(row).length;
      }
      runs.push(performance.now() - started);
    }
    expect(length).toBeGreaterThan(0);
    const value = median(runs);
    report("stableJson 10k median", value);
    expect(value).toBeLessThan(2_000);
  });

  test("cache sliding-window evaluation 10,000 times median < 2000ms", () => {
    const cache = new MemoryCacheAdapter();
    const rule: VelocityCheckDescriptor = {
      ruleId: "perf",
      scopeKey: "perf",
      windowSeconds: 1,
      maxCount: 1_000_000,
      maxAmountMinor: null,
    };
    const runs: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      for (let index = 0; index < 10_000; index += 1) {
        void cache.incrWindowCounter([rule], 1n, index * 2_000);
      }
      runs.push(performance.now() - started);
    }
    const value = median(runs);
    report("memory velocity 10k median", value);
    expect(value).toBeLessThan(2_000);
  });

  test("read-store routing selection 100,000 times median < 1000ms", () => {
    const replicas: ReplicaNodeHandle[] = [1, 2, 3].map((index) => ({
      id: `replica-${index}`,
      client: {} as PrismaClient,
      healthy: true,
      lastReplayLsn: "0/100",
      lagMs: 0,
      consecutiveFailures: 0,
    }));
    const store = new PostgresReplicaReadStore({} as PrismaClient, replicas);
    const runs: number[] = [];
    let selected = 0;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      for (let index = 0; index < 100_000; index += 1) {
        if (store.pickHealthyReplica("replica")) {
          selected += 1;
        }
      }
      runs.push(performance.now() - started);
    }
    expect(selected).toBe(300_000);
    const value = median(runs);
    report("read routing 100k median", value);
    expect(value).toBeLessThan(1_000);
  });
});

const dbClient: PrismaClient = createPrisma({ max: 30 });

afterAll(async () => {
  await dbClient.$disconnect().catch(() => undefined);
});

if (!databaseIsReachable) {
  test.skip("database performance suite requires the live database", () => undefined);
}

describeDatabase("PostgreSQL storage performance", () => {
  test("500 sequential UoWs with outbox+audit finish under 10s", async () => {
    const prefix = uniqueId("perf-uow-sequential");
    const uow = new PostgresUnitOfWorkAdapter(dbClient);
    const started = performance.now();
    try {
      for (let index = 0; index < 500; index += 1) {
        await uow.run(async (tx) => {
          await tx.outbox.enqueue({
            topic: "config.invalidated",
            aggregateType: "perf",
            aggregateId: `${prefix}-${index}`,
            payload: { index },
          });
          await tx.audit.record({
            actorId: uniqueUuid(),
            role: "SECURITY_ADMIN",
            action: "PERF",
            entityType: "PERF",
            entityId: `${prefix}-${index}`,
            beforeJson: { index },
            afterJson: { index },
          });
        });
      }
      const elapsed = performance.now() - started;
      report("UoW 500 sequential", elapsed);
      expect(elapsed).toBeLessThan(10_000);
      expect(
        await dbClient.outboxEvent.count({ where: { aggregateId: { startsWith: prefix } } }),
      ).toBe(500);
      expect(
        await dbClient.auditOutbox.count({ where: { entityId: { startsWith: prefix } } }),
      ).toBe(500);
    } finally {
      await dbClient.outboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
      await dbClient.auditOutbox.deleteMany({ where: { entityId: { startsWith: prefix } } });
    }
  });

  test("50 concurrent UoWs have a p95 below 500ms", async () => {
    const prefix = uniqueId("perf-uow-concurrent");
    const uow = new PostgresUnitOfWorkAdapter(dbClient);
    try {
      const durations = await Promise.all(
        Array.from({ length: 50 }, async (_, index) => {
          const started = performance.now();
          await uow.run(async (tx) => {
            await tx.outbox.enqueue({
              topic: "config.invalidated",
              aggregateType: "perf",
              aggregateId: `${prefix}-${index}`,
              payload: { index },
            });
            await tx.audit.record({
              actorId: uniqueUuid(),
              role: "SECURITY_ADMIN",
              action: "PERF",
              entityType: "PERF",
              entityId: `${prefix}-${index}`,
              beforeJson: { index },
              afterJson: { index },
            });
          });
          return performance.now() - started;
        }),
      );
      const value = p95(durations);
      report("UoW 50 concurrent p95", value);
      expect(value).toBeLessThan(500);
      expect(durations.reduce((sum, duration) => sum + duration, 0)).toBeGreaterThan(0);
    } finally {
      await dbClient.outboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
      await dbClient.auditOutbox.deleteMany({ where: { entityId: { startsWith: prefix } } });
    }
  });

  test("outbox drain of 1,000 events finishes under 5s", async () => {
    const sandbox = await createWorkerSandbox("perf-outbox-drain");
    const prefix = uniqueId("perf-outbox-drain");
    try {
      for (let chunk = 0; chunk < 4; chunk += 1) {
        const placeholders: string[] = [];
        const values: unknown[] = [];
        for (let offset = 0; offset < 250; offset += 1) {
          const index = chunk * 250 + offset;
          const base = offset * 4;
          placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`,
          );
          values.push(
            "config.invalidated",
            "perf",
            `${prefix}-${index}`,
            JSON.stringify({ index }),
          );
        }
        await sandbox.client.$executeRawUnsafe(
          `INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, payload_json)
           VALUES ${placeholders.join(", ")}`,
          ...values,
        );
      }
      const worker = new OutboxRelayWorker(sandbox.client, { batchSize: 1_000 });
      const started = performance.now();
      const drained = await worker.drain();
      const elapsed = performance.now() - started;
      report("outbox drain 1000", elapsed);
      expect(drained).toBe(1_000);
      expect(elapsed).toBeLessThan(5_000);
      const pending = await sandbox.client.$queryRawUnsafe<Array<{ count: string }>>(
        "SELECT count(*)::text AS count FROM outbox_events WHERE processed_at IS NULL",
      );
      expect(Number(pending[0]?.count ?? "0")).toBe(0);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("16 shard rows load in <50ms and the PK lookup avoids a sequential scan", async () => {
    const prefix = uniqueId("perf-shard-query");
    const account = await seedGlAccount(dbClient, { shardCount: 16 });
    try {
      const durations: number[] = [];
      for (let run = 0; run < 30; run += 1) {
        const started = performance.now();
        const rows = await dbClient.glAccountShard.findMany({
          where: { glAccountId: account.id },
        });
        durations.push(performance.now() - started);
        expect(rows).toHaveLength(16);
      }
      const value = median(durations);
      report("shard 16-row query median", value);
      expect(value).toBeLessThan(50);

      const plan = await dbClient.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        "EXPLAIN SELECT gl_account_id, shard_id, current_balance FROM gl_account_shards WHERE gl_account_id = $1::uuid",
        account.id,
      );
      const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(planText.toLowerCase()).not.toContain("seq scan");
      expect(planText.toLowerCase()).toMatch(/index scan|bitmap/);
    } finally {
      await cleanupLedger(dbClient, [account.id], prefix);
    }
  });

  test("1,000-row hash chain append plus verification finishes under 5s", async () => {
    const sandbox = await createAuditSandbox("perf-audit");
    try {
      const entries = Array.from({ length: 1_000 }, (_, index) => ({
        actorId: uniqueUuid(),
        actorEmail: "perf@example.test",
        role: "SECURITY_ADMIN",
        action: "PERF_APPEND",
        entityType: "PERF",
        entityId: `perf-${index}`,
        beforeJson: { index },
        afterJson: { index, ok: true },
      }));
      const started = performance.now();
      const rows = await sandbox.driver.appendBatch(entries);
      const verification = await sandbox.driver.verifyHashChainIntegrity();
      const elapsed = performance.now() - started;
      report("audit 1000 append+verify", elapsed);
      expect(rows).toHaveLength(1_000);
      expect(verification).toEqual({ verifiedCount: 1_000, valid: true });
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await sandbox.cleanup();
    }
  });
});

if (!redisIsReachable) {
  test.skip("Redis performance requires the live Redis", () => undefined);
}

describeRedis("Redis velocity performance", () => {
  test("1,000 sliding-window evaluations finish under 3s", async () => {
    const prefix = `${uniqueId("perf-redis")}:`;
    const cache = new RedisCacheAdapter({ url: REDIS_URL, keyPrefix: prefix });
    try {
      const rule: VelocityCheckDescriptor = {
        ruleId: "perf",
        scopeKey: "perf",
        windowSeconds: 1,
        maxCount: 1_000_000,
        maxAmountMinor: null,
      };
      const started = performance.now();
      for (let index = 0; index < 1_000; index += 1) {
        await cache.incrWindowCounter([rule], 1n, index * 2_000);
      }
      const elapsed = performance.now() - started;
      report("redis velocity 1k", elapsed);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await cache.del("");
      await cache.close();
    }
  });
});
