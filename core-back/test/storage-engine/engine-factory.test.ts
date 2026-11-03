import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  createStorageEngine,
  readThroughReplica,
  setStorageEngine,
} from "../../lib/storageEngine";
import type { ReadConsistency, StorageEngine } from "../../lib/storageEngine/ports";
import {
  DATABASE_URL,
  databaseIsReachable,
  describeDatabase,
} from "./helpers/db";

if (!databaseIsReachable) {
  test.skip("storage engine factory suite requires the live database", () => undefined);
}

describeDatabase("createStorageEngine with real PostgreSQL", () => {
  test("reports primary, memory cache, audit and log health and shuts down cleanly", async () => {
    const engine = createStorageEngine({
      primaryUrl: DATABASE_URL,
      replicaUrls: [],
      auditDatabaseUrl: null,
      logDatabaseUrl: null,
      redisUrl: null,
      logFlushIntervalMs: 60_000,
    });
    try {
      const health = await engine.health();
      expect(health.primary.ok).toBe(true);
      expect(health.primary.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.replicas).toEqual([]);
      expect(health.cache).toMatchObject({ ok: true, driver: "memory" });
      expect(health.audit).toEqual({ ok: false, configured: false });
      expect(health.logs).toEqual({ ok: false, configured: false });

      const uowResult = await engine.uow.run(async (tx) => {
        const rows = await tx.db.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
        return rows[0]?.ok;
      });
      expect(uowResult.data).toBe(1);
      expect(uowResult.commitLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/i);
    } finally {
      await engine.shutdown();
    }

    const resourcesBefore = process.getActiveResourcesInfo().length;
    await expect(engine.shutdown()).resolves.toBeUndefined();
    const resourcesAfter = process.getActiveResourcesInfo().length;
    expect(resourcesAfter).toBeLessThanOrEqual(resourcesBefore);
  });
});

describe("readThroughReplica", () => {
  test("routes a headerless read to the replica and a header to atLeastLsn", async () => {
    const consistencies: ReadConsistency[] = [];
    const engine = {
      readStore: {
        execute: async (
          consistency: ReadConsistency,
          fn: (reader: PrismaClient) => Promise<unknown>,
        ) => {
          consistencies.push(consistency);
          return {
            data: await fn({} as PrismaClient),
            servedBy: "replica-1",
            replicaLagMs: 0,
          };
        },
      },
      primary: {} as PrismaClient,
    } as unknown as StorageEngine;
    setStorageEngine(engine);
    try {
      const noHeader = await readThroughReplica(undefined, async () => "replica-value");
      expect(noHeader).toBe("replica-value");
      const withHeader = await readThroughReplica("0/1234", async () => "lsn-value", 100);
      expect(withHeader).toBe("lsn-value");
    } finally {
      setStorageEngine(undefined);
    }
    expect(consistencies).toEqual(["replica", { atLeastLsn: "0/1234", maxWaitMs: 250 }]);
  });

  test("falls back to the primary when the read store throws", async () => {
    const primaryMarker = { __marker: "primary" } as unknown as PrismaClient;
    const engine = {
      readStore: {
        execute: async () => {
          throw new Error("READ_STORE_DOWN");
        },
      },
      primary: primaryMarker,
    } as unknown as StorageEngine;
    setStorageEngine(engine);
    try {
      const value = await readThroughReplica("0/1", async (reader) =>
        (reader as unknown as { __marker: string }).__marker,
      );
      expect(value).toBe("primary");
    } finally {
      setStorageEngine(undefined);
    }
  });
});
