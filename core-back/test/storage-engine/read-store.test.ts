import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  PostgresReplicaReadStore,
  type ReplicaNodeHandle,
} from "../../lib/storageEngine/readStoreAdapter";
import type { ReadConsistency } from "../../lib/storageEngine/ports";

type Watermark = { replay_lsn: string | null; lag_ms: number | null } | Error;

interface FakeReplica {
  handle: ReplicaNodeHandle;
  calls: () => number;
  setWatermarks: (watermarks: Watermark[]) => void;
}

const makeFakeReplica = (
  id: string,
  options: {
    healthy?: boolean;
    lagMs?: number;
    lastReplayLsn?: string;
    watermarks?: Watermark[];
  } = {},
): FakeReplica => {
  let index = 0;
  let watermarks = options.watermarks ?? [
    { replay_lsn: options.lastReplayLsn ?? "0/0", lag_ms: options.lagMs ?? 0 },
  ];
  let calls = 0;

  const client = {
    $queryRaw: async (): Promise<unknown> => {
      calls += 1;
      const next = watermarks[Math.min(index, watermarks.length - 1)];
      index += 1;
      if (next instanceof Error) {
        throw next;
      }
      return [next];
    },
  } as unknown as PrismaClient;
  (client as unknown as { __marker: string }).__marker = id;

  return {
    handle: {
      id,
      client,
      healthy: options.healthy ?? true,
      lagMs: options.lagMs ?? 0,
      lastReplayLsn: options.lastReplayLsn ?? "0/0",
      consecutiveFailures: 0,
    },
    calls: () => calls,
    setWatermarks: (next) => {
      watermarks = next;
      index = 0;
    },
  };
};

const markerOf = (reader: PrismaClient): string =>
  (reader as unknown as { __marker?: string }).__marker ?? "primary";

const primary = {
  $queryRaw: async () => [{ ok: 1 }],
} as unknown as PrismaClient;
(primary as unknown as { __marker: string }).__marker = "primary";

const read = <T>(
  store: PostgresReplicaReadStore,
  consistency: ReadConsistency,
  reader: (client: PrismaClient) => Promise<T>,
  timeoutMs?: number,
): ReturnType<PostgresReplicaReadStore["execute"]> =>
  store.execute(consistency, reader, timeoutMs === undefined ? undefined : { timeoutMs });

describe("PostgresReplicaReadStore routing", () => {
  test("primary consistency always uses the primary", async () => {
    const replica = makeFakeReplica("replica-1");
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const result = await read(store, "primary", async (client) => markerOf(client));
    expect(result.data).toBe("primary");
    expect(result.servedBy).toBe("primary");
    expect(result.replicaLagMs).toBeUndefined();
  });

  test("replica consistency serves from a healthy replica and reports lag", async () => {
    const replica = makeFakeReplica("replica-1", { lagMs: 42 });
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const result = await read(store, "replica", async (client) => markerOf(client));
    expect(result.data).toBe("replica-1");
    expect(result.servedBy).toBe("replica-1");
    expect(result.replicaLagMs).toBe(42);
  });

  test("round-robins across healthy replicas", async () => {
    const first = makeFakeReplica("replica-1");
    const second = makeFakeReplica("replica-2");
    const store = new PostgresReplicaReadStore(primary, [first.handle, second.handle]);
    const served: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await read(store, "replica", async (client) => markerOf(client));
      served.push(result.servedBy);
    }
    expect(served).toEqual(["replica-1", "replica-2", "replica-1", "replica-2", "replica-1"]);
  });

  test("rejects replicas above the lag threshold and falls back to primary", async () => {
    const replicaLagging = makeFakeReplica("replica-1", { lagMs: 101 });
    const replicaHealthy = makeFakeReplica("replica-2", { lagMs: 100 });
    const store = new PostgresReplicaReadStore(
      primary,
      [replicaLagging.handle, replicaHealthy.handle],
      100,
    );
    const first = await read(store, "replica", async (client) => markerOf(client));
    expect(first.servedBy).toBe("replica-2");
    replicaHealthy.handle.healthy = false;
    const second = await read(store, "replica", async (client) => markerOf(client));
    expect(second.servedBy).toBe("primary");
  });

  test("selects only replicas that reached the requested LSN", async () => {
    const behind = makeFakeReplica("replica-1", { lastReplayLsn: "0/80" });
    const caughtUp = makeFakeReplica("replica-2", { lastReplayLsn: "0/100" });
    const store = new PostgresReplicaReadStore(primary, [behind.handle, caughtUp.handle]);
    const result = await read(store, { atLeastLsn: "0/90", maxWaitMs: 0 }, async (client) =>
      markerOf(client),
    );
    expect(result.servedBy).toBe("replica-2");

    const equality = await read(store, { atLeastLsn: "0/100", maxWaitMs: 0 }, async (client) =>
      markerOf(client),
    );
    expect(equality.servedBy).toBe("replica-2");
  });

  test("waits for a replica watermark when maxWaitMs allows it", async () => {
    const replica = makeFakeReplica("replica-1", {
      lastReplayLsn: "0/100",
      watermarks: [
        { replay_lsn: "0/150", lag_ms: 0 },
        { replay_lsn: "0/250", lag_ms: 0 },
        { replay_lsn: "0/250", lag_ms: 0 },
      ],
    });
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const started = performance.now();
    const result = await read(
      store,
      { atLeastLsn: "0/200", maxWaitMs: 300 },
      async (client) => markerOf(client),
    );
    expect(result.servedBy).toBe("replica-1");
    expect(performance.now() - started).toBeGreaterThanOrEqual(0);
    expect(replica.calls()).toBeGreaterThan(0);
  });

  test("returns primary when the watermark is not reached before the deadline", async () => {
    const replica = makeFakeReplica("replica-1", {
      lastReplayLsn: "0/100",
      watermarks: [{ replay_lsn: "0/100", lag_ms: 0 }],
    });
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const result = await read(
      store,
      { atLeastLsn: "0/999", maxWaitMs: 30 },
      async (client) => markerOf(client),
    );
    expect(result.servedBy).toBe("primary");
  });

  test("invalid watermark targets never select a replica", async () => {
    const replica = makeFakeReplica("replica-1", { lastReplayLsn: "0/100" });
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const result = await read(
      store,
      { atLeastLsn: "0/ZZZZ", maxWaitMs: 0 },
      async (client) => markerOf(client),
    );
    expect(result.servedBy).toBe("primary");
  });

  test("a mid-flight replica error marks it unhealthy and falls back to primary", async () => {
    const replica = makeFakeReplica("replica-1");
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const result = await read(store, "replica", async (client) => {
      if (markerOf(client) === "replica-1") {
        throw new Error("REPLICA_BROKEN");
      }
      return "primary-result";
    });
    expect(result.data).toBe("primary-result");
    expect(result.servedBy).toBe("primary");
    expect(replica.handle.healthy).toBe(false);
    expect(replica.handle.consecutiveFailures).toBe(1);
  });

  test("a timeout is converted into a primary fallback", async () => {
    const replica = makeFakeReplica("replica-1");
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    const started = performance.now();
    const result = await read(
      store,
      "replica",
      async (client) =>
        markerOf(client) === "replica-1"
          ? new Promise<string>(() => undefined)
          : Promise.resolve("primary-result"),
      20,
    );
    expect(result).toEqual({ data: "primary-result", servedBy: "primary" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(replica.handle.healthy).toBe(false);
  });

  test("parses replica watermarks and degrades after two refresh failures", async () => {
    const replica = makeFakeReplica("replica-1");
    const store = new PostgresReplicaReadStore(primary, [replica.handle]);
    replica.setWatermarks([{ replay_lsn: "1/ABCD", lag_ms: 123.6 }]);
    await store.refreshReplicaWatermarks();
    expect(replica.handle.lastReplayLsn).toBe("1/ABCD");
    expect(replica.handle.lagMs).toBe(124);
    expect(replica.handle.healthy).toBe(true);
    expect(replica.handle.consecutiveFailures).toBe(0);

    replica.setWatermarks([new Error("down")]);
    await store.refreshReplicaWatermarks();
    expect(replica.handle.healthy).toBe(true);
    expect(replica.handle.consecutiveFailures).toBe(1);
    await store.refreshReplicaWatermarks();
    expect(replica.handle.healthy).toBe(false);
    expect(replica.handle.consecutiveFailures).toBe(2);
  });

  test("exposes replica states and pickHealthyReplica", () => {
    const unhealthy = makeFakeReplica("replica-1", { healthy: false, lagMs: 10 });
    const healthy = makeFakeReplica("replica-2", { lagMs: 20, lastReplayLsn: "0/9" });
    const store = new PostgresReplicaReadStore(primary, [unhealthy.handle, healthy.handle]);
    expect(store.getReplicaStates()).toEqual([
      {
        id: "replica-1",
        healthy: false,
        lagMs: 10,
        lastReplayLsn: "0/0",
        consecutiveFailures: 0,
      },
      {
        id: "replica-2",
        healthy: true,
        lagMs: 20,
        lastReplayLsn: "0/9",
        consecutiveFailures: 0,
      },
    ]);
    expect(store.pickHealthyReplica()).toBe("replica-2");
    unhealthy.handle.healthy = false;
    healthy.handle.healthy = false;
    expect(store.pickHealthyReplica()).toBeNull();
  });

  test("without replicas every read is served by the primary", async () => {
    const store = new PostgresReplicaReadStore(primary, []);
    const result = await read(store, "replica", async (client) => markerOf(client));
    expect(result).toEqual({ data: "primary", servedBy: "primary" });
    expect(store.pickHealthyReplica("replica")).toBeNull();
    store.startLsnMonitor(10);
    store.stopLsnMonitor();
  });

  test("monitor start is idempotent and stop is safe", () => {
    const replica = makeFakeReplica("replica-1", { watermarks: [{ replay_lsn: "0/1", lag_ms: 0 }] });
    const store = new PostgresReplicaReadStore(primary, [replica.handle], 1000);
    store.startLsnMonitor(10);
    store.startLsnMonitor(10);
    store.stopLsnMonitor();
    store.stopLsnMonitor();
  });
});
