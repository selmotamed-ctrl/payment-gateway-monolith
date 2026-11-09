import { describe, expect, test } from "bun:test";
import {
  BaseWorker,
  WorkerHealthRegistry,
  defaultWorkerHealthRegistry,
  sanitizeWorkerError,
  type WorkerLeaderElection,
  type WorkerOptions,
  type WorkerTickOutcome,
} from "../../engine/workers/workerRuntime";
import { createApp } from "../../index";

const T0 = new Date("2026-11-09T10:00:00.000Z");

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class ScriptedWorker extends BaseWorker {
  outcomes: Array<WorkerTickOutcome | Error> = [];
  ticks = 0;
  protected async tick(): Promise<WorkerTickOutcome> {
    this.ticks += 1;
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

class LegacyVoidWorker extends BaseWorker {
  ran = false;
  protected async tick(): Promise<void> {
    this.ran = true;
  }
}

class SingletonWorker extends ScriptedWorker {
  protected override get singleton(): boolean {
    return true;
  }
}

const baseOptions = (registry: WorkerHealthRegistry | null, extra: Partial<WorkerOptions> = {}): WorkerOptions => {
  let now = T0.getTime();
  return {
    db: {} as never,
    repositories: {} as never,
    intervalMs: 1_000,
    logger: quietLogger,
    clock: () => new Date((now += 10)),
    healthRegistry: registry,
    ...extra,
  };
};

describe("WorkerHealthRegistry filled by BaseWorker", () => {
  test("registers on construction with interval and singleton flag", () => {
    const registry = new WorkerHealthRegistry();
    new ScriptedWorker(baseOptions(registry));
    new SingletonWorker(baseOptions(registry, { intervalMs: 60_000 }));
    const scripted = registry.get("ScriptedWorker");
    const singleton = registry.get("SingletonWorker");
    expect(scripted?.intervalMs).toBe(1_000);
    expect(scripted?.singleton).toBe(false);
    expect(scripted?.running).toBe(false);
    expect(singleton?.intervalMs).toBe(60_000);
    expect(singleton?.singleton).toBe(true);
  });

  test("records tick, success, duration and the processed count a tick returns", async () => {
    const registry = new WorkerHealthRegistry();
    const worker = new ScriptedWorker(baseOptions(registry));
    worker.outcomes = [7, { processed: 3, backlog: 12 }, undefined];
    await worker.runOnce();
    let record = registry.get("ScriptedWorker");
    expect(record?.ticks).toBe(1);
    expect(record?.lastTickAt).not.toBeNull();
    expect(record?.lastSuccessAt).not.toBeNull();
    expect(record?.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(record?.lastProcessed).toBe(7);
    await worker.runOnce();
    record = registry.get("ScriptedWorker");
    expect(record?.lastProcessed).toBe(3);
    expect(record?.processedTotal).toBe(10);
    expect(record?.backlog).toBe(12);
    await worker.runOnce();
    record = registry.get("ScriptedWorker");
    // A tick that returns nothing keeps the previous count and backlog.
    expect(record?.lastProcessed).toBe(3);
    expect(record?.ticks).toBe(3);
  });

  test("records the error message only and rethrows from runOnce; success resets consecutive failures", async () => {
    const registry = new WorkerHealthRegistry();
    const worker = new ScriptedWorker(baseOptions(registry));
    const error = new Error("database\n  unreachable");
    error.stack = "SECRET STACK";
    worker.outcomes = [error, new Error("again"), 1];
    await expect(worker.runOnce()).rejects.toThrow("database");
    let record = registry.get("ScriptedWorker");
    expect(record?.lastError).toBe("database unreachable");
    expect(record?.lastSuccessAt).toBeNull();
    expect(record?.failures).toBe(1);
    await expect(worker.runOnce()).rejects.toThrow("again");
    expect(registry.get("ScriptedWorker")?.consecutiveFailures).toBe(2);
    await worker.runOnce();
    record = registry.get("ScriptedWorker");
    expect(record?.consecutiveFailures).toBe(0);
    expect(record?.failures).toBe(2);
    expect(record?.lastError).toBe("again");
    expect(JSON.stringify(registry.snapshot())).not.toContain("SECRET STACK");
  });

  test("bounds long error messages", () => {
    expect(sanitizeWorkerError(new Error("x".repeat(1000))).length).toBe(300);
    expect(sanitizeWorkerError("plain")).toBe("plain");
    expect(sanitizeWorkerError({})).toBe("unknown error");
  });

  test("records leader / not-leader for singleton workers and does not tick when not leader", async () => {
    const registry = new WorkerHealthRegistry();
    let isLeader = false;
    const election: WorkerLeaderElection = { tryAcquire: async () => isLeader };
    const worker = new SingletonWorker(baseOptions(registry, { leaderElection: election }));
    await worker.runOnce();
    expect(worker.ticks).toBe(0);
    expect(registry.get("SingletonWorker")?.leader).toBe(false);
    expect(registry.get("SingletonWorker")?.ticks).toBe(0);
    isLeader = true;
    await worker.runOnce();
    expect(worker.ticks).toBe(1);
    expect(registry.get("SingletonWorker")?.leader).toBe(true);
  });

  test("a failing leader election is recorded as not leader", async () => {
    const registry = new WorkerHealthRegistry();
    const election: WorkerLeaderElection = {
      tryAcquire: async () => {
        throw new Error("lock db down");
      },
    };
    const worker = new SingletonWorker(baseOptions(registry, { leaderElection: election }));
    await worker.runOnce();
    expect(worker.ticks).toBe(0);
    expect(registry.get("SingletonWorker")?.leader).toBe(false);
  });

  test("non-singleton workers keep leader null", async () => {
    const registry = new WorkerHealthRegistry();
    const worker = new ScriptedWorker(baseOptions(registry, { leaderElection: { tryAcquire: async () => false } }));
    await worker.runOnce();
    expect(worker.ticks).toBe(1);
    expect(registry.get("ScriptedWorker")?.leader).toBeNull();
  });

  test("start and stop mark the worker running", () => {
    const registry = new WorkerHealthRegistry();
    const worker = new ScriptedWorker(baseOptions(registry));
    worker.start();
    expect(registry.get("ScriptedWorker")?.running).toBe(true);
    expect(registry.get("ScriptedWorker")?.startedAt).not.toBeNull();
    worker.stop();
    expect(registry.get("ScriptedWorker")?.running).toBe(false);
  });

  test("legacy workers that return void keep working; null disables reporting", async () => {
    const registry = new WorkerHealthRegistry();
    const legacy = new LegacyVoidWorker(baseOptions(registry));
    await legacy.runOnce();
    expect(legacy.ran).toBe(true);
    expect(registry.get("LegacyVoidWorker")?.lastProcessed).toBeNull();
    expect(registry.get("LegacyVoidWorker")?.lastSuccessAt).not.toBeNull();

    class UnreportedWorkerForHealthTest extends LegacyVoidWorker {}
    const silent = new UnreportedWorkerForHealthTest(baseOptions(null));
    await silent.runOnce();
    expect(silent.ran).toBe(true);
    expect(defaultWorkerHealthRegistry.get("UnreportedWorkerForHealthTest")).toBeUndefined();
  });

  test("workers without an explicit registry report to the process-wide default", async () => {
    class DefaultRegistryWorkerForHealthTest extends LegacyVoidWorker {}
    const options = baseOptions(null);
    delete (options as { healthRegistry?: unknown }).healthRegistry;
    const worker = new DefaultRegistryWorkerForHealthTest(options);
    await worker.runOnce();
    expect(defaultWorkerHealthRegistry.get("DefaultRegistryWorkerForHealthTest")?.ticks).toBe(1);
  });

  test("snapshot serialises ISO timestamps sorted by name", async () => {
    const registry = new WorkerHealthRegistry();
    new SingletonWorker(baseOptions(registry));
    const worker = new ScriptedWorker(baseOptions(registry));
    worker.outcomes = [2];
    await worker.runOnce();
    const snapshot = registry.snapshot(T0);
    expect(snapshot.generatedAt).toBe(T0.toISOString());
    expect(snapshot.workers.map((entry) => entry.name)).toEqual(["ScriptedWorker", "SingletonWorker"]);
    expect(snapshot.workers[0]?.lastSuccessAt).toMatch(/^2026-11-09T10:00:00\.\d{3}Z$/);
    expect(snapshot.workers[1]?.lastSuccessAt).toBeNull();
  });
});

describe("core /health lists the registered workers", () => {
  test("serves every registered worker under `workers` without changing status", async () => {
    const registry = new WorkerHealthRegistry();
    const worker = new ScriptedWorker(baseOptions(registry));
    new SingletonWorker(baseOptions(registry, { intervalMs: 60_000 }));
    worker.outcomes = [new Error("boom")];
    await worker.runOnce().catch(() => undefined);
    const db = {
      backgroundJob: {
        count: async () => 0,
        findFirst: async () => null,
      },
    };
    const app = createApp({ db: db as never, now: () => T0, workerHealth: registry });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await response.json()) as {
        queue: unknown;
        workers: Array<{ name: string; lastError: string | null; singleton: boolean; intervalMs: number }>;
      };
      expect(response.status).toBe(200);
      expect(body.queue).toBeDefined();
      expect(body.workers.map((entry) => entry.name)).toEqual(["ScriptedWorker", "SingletonWorker"]);
      expect(body.workers[0]?.lastError).toBe("boom");
      expect(body.workers[1]?.singleton).toBe(true);
      expect(body.workers[1]?.intervalMs).toBe(60_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
