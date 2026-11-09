import { describe, expect, test } from "bun:test";
import {
  PlatformMonitorWorker,
  PrismaMonitorCaseSink,
  platformSubjectKey,
  type MonitorCaseClearInput,
  type MonitorCaseRaiseInput,
  type MonitorCaseSink,
  type MonitorFinding,
  type PlatformMonitorCheck,
} from "../../engine/workers/PlatformMonitorWorker";
import {
  auditOutboxAgeCheck,
  backgroundJobQueueAgeCheck,
  certificateExpiryCheck,
  checkpointStalenessCheck,
  createStandardPlatformChecks,
  journalDefaultPartitionCheck,
  outboxAgeCheck,
  redisReachabilityCheck,
  workerStalenessCheck,
} from "../../engine/workers/platformMonitorChecks";
import { WorkerHealthRegistry } from "../../engine/workers/workerRuntime";

const T0 = new Date("2026-11-09T10:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeSink implements MonitorCaseSink {
  raised: MonitorCaseRaiseInput[] = [];
  cleared: MonitorCaseClearInput[] = [];
  open = new Set<string>();
  initialActive: string[] = [];
  async raise(input: MonitorCaseRaiseInput): Promise<{ created: boolean }> {
    this.raised.push(input);
    const created = !this.open.has(input.subjectKey);
    this.open.add(input.subjectKey);
    return { created };
  }
  async clear(input: MonitorCaseClearInput): Promise<void> {
    this.cleared.push(input);
  }
  async listActiveKeys(prefix: string): Promise<string[]> {
    return this.initialActive.filter((key) => key.startsWith(prefix));
  }
}

/** A fake Prisma client whose raw queries are answered by `answer(sql, values)`. */
const fakeDb = (answer: (sql: string, values: unknown[]) => unknown[] | Promise<unknown[]>) => ({
  $queryRawUnsafe: async (sql: string, ...values: unknown[]) => answer(sql, values),
  $transaction: async () => undefined,
  $queryRaw: async () => [],
  $executeRaw: async () => 0,
  $executeRawUnsafe: async () => 0,
});

interface Harness {
  monitor: PlatformMonitorWorker;
  sink: FakeSink;
  setNow: (date: Date) => void;
}

const harness = (checks: PlatformMonitorCheck[], options: {
  db?: ReturnType<typeof fakeDb>;
  registry?: WorkerHealthRegistry;
  sink?: FakeSink;
  checkFailureThreshold?: number;
  checkTimeoutMs?: number;
} = {}): Harness => {
  let now = T0;
  const sink = options.sink ?? new FakeSink();
  const monitor = new PlatformMonitorWorker({
    db: (options.db ?? fakeDb(() => [])) as never,
    repositories: {} as never,
    logger: quietLogger,
    clock: () => now,
    healthRegistry: null,
    monitorRegistry: options.registry ?? new WorkerHealthRegistry(),
    caseSink: sink,
    checks,
    checkFailureThreshold: options.checkFailureThreshold,
    checkTimeoutMs: options.checkTimeoutMs,
  });
  return { monitor, sink, setNow: (date) => { now = date; } };
};

/**
 * Runs the canonical trip-once-and-clear scenario: tripped for two ticks (one
 * case), cleared for two ticks (one clearing).
 */
const expectTripsOnceAndClears = async (
  h: Harness,
  expectedKey: string,
  trip: () => void,
  clear: () => void,
): Promise<void> => {
  trip();
  await h.monitor.runOnce();
  await h.monitor.runOnce();
  expect(h.sink.raised.map((entry) => entry.subjectKey)).toEqual([expectedKey]);
  expect(h.monitor.activeKeys()).toEqual([expectedKey]);
  clear();
  await h.monitor.runOnce();
  await h.monitor.runOnce();
  expect(h.sink.cleared.map((entry) => entry.subjectKey)).toEqual([expectedKey]);
  expect(h.sink.raised).toHaveLength(1);
  expect(h.monitor.activeKeys()).toEqual([]);
};

describe("PlatformMonitorWorker", () => {
  test("is a 60 s cluster singleton", () => {
    const { monitor } = harness([]);
    expect(monitor.clusterSingleton).toBe(true);
    expect(monitor.leaderKey).toBe("worker:PlatformMonitorWorker");
  });

  test("rejects duplicate, reserved or malformed check ids", () => {
    const check = (id: string): PlatformMonitorCheck => ({ id, run: async () => [] });
    expect(() => harness([check("a"), check("a")])).toThrow("duplicate");
    expect(() => harness([check("monitor_check_failed")])).toThrow("reserved");
    expect(() => harness([check("Bad Id")])).toThrow("invalid");
  });

  test("accepts extra checks without editing the worker", async () => {
    let tripped = true;
    const extra: PlatformMonitorCheck = {
      id: "stale_unknown",
      run: async () => (tripped ? [{ key: "a1", title: "UNKNOWN attempt", detail: "stuck" }] : []),
    };
    const sink = new FakeSink();
    const monitor = new PlatformMonitorWorker({
      db: fakeDb(() => []) as never,
      repositories: {} as never,
      logger: quietLogger,
      clock: () => T0,
      healthRegistry: null,
      caseSink: sink,
      checks: [],
      extraChecks: [extra],
    });
    await monitor.runOnce();
    expect(sink.raised.map((entry) => entry.subjectKey)).toEqual(["platform.stale_unknown:a1"]);
    tripped = false;
    await monitor.runOnce();
    expect(sink.cleared.map((entry) => entry.subjectKey)).toEqual(["platform.stale_unknown:a1"]);
  });

  test("an incomplete result never clears unseen keys", async () => {
    let result: { findings: MonitorFinding[]; complete: boolean } = {
      findings: [{ key: "a", title: "t", detail: "d" }, { key: "b", title: "t", detail: "d" }],
      complete: true,
    };
    const h = harness([{ id: "partial", run: async () => result }]);
    await h.monitor.runOnce();
    result = { findings: [{ key: "a", title: "t", detail: "d" }], complete: false };
    await h.monitor.runOnce();
    expect(h.sink.cleared).toHaveLength(0);
    result = { findings: [], complete: true };
    await h.monitor.runOnce();
    expect(h.sink.cleared.map((entry) => entry.subjectKey).sort()).toEqual(["platform.partial:a", "platform.partial:b"]);
  });

  test("findings default to P1 and keep the given priority", async () => {
    const h = harness([{
      id: "prio",
      run: async () => [{ key: "x", title: "t", detail: "d" }, { key: "y", title: "t", detail: "d", priority: "P3" }],
    }]);
    await h.monitor.runOnce();
    expect(h.sink.raised.map((entry) => entry.priority)).toEqual(["P1", "P3"]);
  });

  test("rehydrates open keys after a restart and clears them once when healthy", async () => {
    const sink = new FakeSink();
    sink.initialActive = ["platform.outbox_age", "platform.retired_check:x", "other.key"];
    const h = harness([{ id: "outbox_age", run: async () => [] }], { sink });
    await h.monitor.runOnce();
    await h.monitor.runOnce();
    expect(sink.cleared.map((entry) => entry.subjectKey)).toEqual(["platform.outbox_age"]);
    expect(sink.raised).toHaveLength(0);
  });

  test("rehydrated keys still tripped are not raised again", async () => {
    const sink = new FakeSink();
    sink.initialActive = ["platform.outbox_age"];
    const h = harness([{ id: "outbox_age", run: async () => [{ title: "t", detail: "d" }] }], { sink });
    await h.monitor.runOnce();
    expect(sink.raised).toHaveLength(0);
    expect(h.monitor.activeKeys()).toEqual(["platform.outbox_age"]);
  });

  test("a check failing repeatedly trips monitor_check_failed once and clears when it recovers", async () => {
    let failing = false;
    const h = harness(
      [{
        id: "flaky",
        run: async () => {
          if (failing) throw new Error("db timeout");
          return [{ title: "t", detail: "d" }];
        },
      }],
      { checkFailureThreshold: 2 },
    );
    await h.monitor.runOnce(); // flaky tripped
    failing = true;
    await h.monitor.runOnce(); // failure 1: nothing cleared, nothing raised
    expect(h.sink.cleared).toHaveLength(0);
    expect(h.sink.raised.map((entry) => entry.subjectKey)).toEqual(["platform.flaky"]);
    await h.monitor.runOnce(); // failure 2: threshold
    await h.monitor.runOnce(); // failure 3: still one case
    expect(h.sink.raised.map((entry) => entry.subjectKey)).toEqual(["platform.flaky", "platform.monitor_check_failed:flaky"]);
    expect(h.sink.raised[1]?.priority).toBe("P2");
    expect(h.sink.raised[1]?.detail).toContain("db timeout");
    failing = false;
    await h.monitor.runOnce();
    expect(h.sink.cleared.map((entry) => entry.subjectKey)).toEqual(["platform.monitor_check_failed:flaky"]);
    expect(h.monitor.activeKeys()).toEqual(["platform.flaky"]);
  });

  test("a check that hangs times out instead of blocking the tick", async () => {
    const h = harness(
      [
        { id: "hangs", run: () => new Promise(() => undefined) },
        { id: "fine", run: async () => [{ title: "t", detail: "d" }] },
      ],
      { checkTimeoutMs: 20 },
    );
    await h.monitor.runOnce();
    expect(h.monitor.lastSummary?.failedChecks).toEqual(["hangs"]);
    expect(h.sink.raised.map((entry) => entry.subjectKey)).toEqual(["platform.fine"]);
  });

  test("reports raised + cleared transitions to the health registry", async () => {
    const registry = new WorkerHealthRegistry();
    let tripped = true;
    const monitor = new PlatformMonitorWorker({
      db: fakeDb(() => []) as never,
      repositories: {} as never,
      logger: quietLogger,
      clock: () => T0,
      healthRegistry: registry,
      caseSink: new FakeSink(),
      checks: [{ id: "c", run: async () => (tripped ? [{ title: "t", detail: "d" }] : []) }],
    });
    await monitor.runOnce();
    expect(registry.get("PlatformMonitorWorker")?.lastProcessed).toBe(1);
    expect(registry.get("PlatformMonitorWorker")?.backlog).toBe(1);
    tripped = false;
    await monitor.runOnce();
    expect(registry.get("PlatformMonitorWorker")?.backlog).toBe(0);
    expect(registry.get("PlatformMonitorWorker")?.processedTotal).toBe(2);
  });
});

describe("built-in checks trip once and clear", () => {
  test("worker_stale: no success for 3x the interval", async () => {
    const registry = new WorkerHealthRegistry();
    registry.register("PollWorker", { intervalMs: 5_000 }, T0);
    registry.markStarted("PollWorker", T0);
    registry.recordSuccess("PollWorker", T0, 5);
    const h = harness([workerStalenessCheck()], { registry });
    await h.monitor.runOnce();
    h.setNow(new Date(T0.getTime() + 15_000)); // exactly 3x: not yet
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(0);
    await expectTripsOnceAndClears(
      h,
      "platform.worker_stale:PollWorker",
      () => {
        registry.recordFailure("PollWorker", T0, 5, new Error("db down"));
        h.setNow(new Date(T0.getTime() + 15_001));
      },
      () => registry.recordSuccess("PollWorker", new Date(T0.getTime() + 15_001), 5),
    );
    expect(h.sink.raised[0]?.detail).toContain("db down");
  });

  test("worker_stale skips stopped workers, singletons led elsewhere and ignored names", async () => {
    const registry = new WorkerHealthRegistry();
    registry.register("Stopped", { intervalMs: 1_000 }, T0);
    registry.register("Follower", { intervalMs: 1_000, singleton: true }, T0);
    registry.markStarted("Follower", T0);
    registry.recordLeadership("Follower", false);
    registry.register("Ignored", { intervalMs: 1_000 }, T0);
    registry.markStarted("Ignored", T0);
    registry.register("NeverSucceeded", { intervalMs: 1_000 }, T0);
    registry.markStarted("NeverSucceeded", T0);
    const h = harness([workerStalenessCheck({ ignore: ["Ignored"] })], { registry });
    h.setNow(new Date(T0.getTime() + 10_000));
    await h.monitor.runOnce();
    expect(h.sink.raised.map((entry) => entry.subjectKey)).toEqual(["platform.worker_stale:NeverSucceeded"]);
  });

  test("checkpoint_stale: per shard, against maxAge x grace", async () => {
    let rows: unknown[] = [];
    const seen: unknown[][] = [];
    const db = fakeDb((sql, values) => {
      expect(sql).toContain("gl_shard_checkpoints");
      seen.push(values);
      return rows;
    });
    const h = harness([checkpointStalenessCheck({ maxAgeMs: 15 * MIN })], { db });
    await expectTripsOnceAndClears(
      h,
      "platform.checkpoint_stale:acc-1:3",
      () => {
        rows = [{ id: "acc-1", shard_id: 3, pending: "42", reference_at: new Date(T0.getTime() - 40 * MIN) }];
      },
      () => {
        rows = [];
      },
    );
    // The cut-off passed to SQL is now - 2 x maxAge.
    expect((seen[0]?.[0] as Date).toISOString()).toBe(new Date(T0.getTime() - 30 * MIN).toISOString());
    expect(h.sink.raised[0]?.detail).toContain("42 lines");
  });

  test("checkpoint_stale keeps keys when the LIMIT was hit", async () => {
    let rows: unknown[] = [{ id: "a", shard_id: 0, pending: "1", reference_at: T0 }, { id: "b", shard_id: 0, pending: "1", reference_at: T0 }];
    const h = harness([checkpointStalenessCheck({ maxAgeMs: MIN, limit: 2 })], { db: fakeDb(() => rows) });
    await h.monitor.runOnce();
    rows = [{ id: "a", shard_id: 0, pending: "1", reference_at: T0 }, { id: "c", shard_id: 0, pending: "1", reference_at: T0 }];
    await h.monitor.runOnce();
    expect(h.sink.cleared).toHaveLength(0);
    expect(h.monitor.activeKeys()).toHaveLength(3);
  });

  test("outbox_age: oldest unprocessed outbox event", async () => {
    let oldest: Date | null = null;
    const db = fakeDb((sql) => {
      expect(sql).toContain("FROM outbox_events WHERE processed_at IS NULL");
      return oldest ? [{ oldest_at: oldest }] : [];
    });
    const h = harness([outboxAgeCheck({ maxAgeMs: 5 * MIN })], { db });
    oldest = new Date(T0.getTime() - 5 * MIN); // at the limit: fine
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(0);
    await expectTripsOnceAndClears(
      h,
      "platform.outbox_age",
      () => { oldest = new Date(T0.getTime() - 6 * MIN); },
      () => { oldest = null; },
    );
  });

  test("audit_outbox_age: oldest unshipped audit row", async () => {
    let oldest: string | null = null;
    const db = fakeDb((sql) => {
      expect(sql).toContain("FROM audit_outbox WHERE shipped_at IS NULL");
      return [{ oldest_at: oldest }];
    });
    const h = harness([auditOutboxAgeCheck({ maxAgeMs: 5 * MIN })], { db });
    await expectTripsOnceAndClears(
      h,
      "platform.audit_outbox_age",
      () => { oldest = new Date(T0.getTime() - 60 * MIN).toISOString(); },
      () => { oldest = new Date(T0.getTime() - MIN).toISOString(); },
    );
  });

  test("background_job_age: oldest due QUEUED job", async () => {
    let oldest: Date | null = null;
    const db = fakeDb((sql, values) => {
      expect(sql).toContain("FROM background_jobs");
      expect(sql).toContain("state = 'QUEUED'");
      expect(values[0]).toEqual(T0);
      return oldest ? [{ oldest_at: oldest }] : [];
    });
    const h = harness([backgroundJobQueueAgeCheck({ maxAgeMs: 5 * MIN })], { db });
    await expectTripsOnceAndClears(
      h,
      "platform.background_job_age",
      () => { oldest = new Date(T0.getTime() - 10 * MIN); },
      () => { oldest = null; },
    );
  });

  test("journal_default_rows: rows in journal_lines_default", async () => {
    let count = 0;
    const db = fakeDb((sql) => {
      expect(sql).toContain("journal_lines_default");
      return [{ n: count }];
    });
    const h = harness([journalDefaultPartitionCheck()], { db });
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(0);
    await expectTripsOnceAndClears(h, "platform.journal_default_rows", () => { count = 3; }, () => { count = 0; });
    expect(h.sink.raised[0]?.detail).toContain("3 journal line");
  });

  test("journal_default_rows: a database without the partition reports nothing", async () => {
    const db = fakeDb(() => {
      throw Object.assign(new Error('relation "journal_lines_default" does not exist'), { code: "P2010", meta: { code: "42P01" } });
    });
    const h = harness([journalDefaultPartitionCheck()], { db });
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(0);
    expect(h.monitor.lastSummary?.failedChecks).toEqual([]);
  });

  test("cert_expiry: within 30 days", async () => {
    const validTo: Record<string, Date> = {
      "/certs/core.crt": new Date(T0.getTime() + 90 * DAY),
      "/certs/ca.crt": new Date(T0.getTime() + 365 * DAY),
    };
    const check = certificateExpiryCheck({
      files: [{ label: "mtls_server", path: "/certs/core.crt" }, { label: "mtls_ca", path: "/certs/ca.crt" }],
      readValidTo: (path) => validTo[path] as Date,
    });
    const h = harness([check]);
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(0);
    await expectTripsOnceAndClears(
      h,
      "platform.cert_expiry:mtls_server",
      () => { validTo["/certs/core.crt"] = new Date(T0.getTime() + 29 * DAY); },
      () => { validTo["/certs/core.crt"] = new Date(T0.getTime() + 400 * DAY); },
    );
  });

  test("cert_expiry: an unreadable file trips its own key", async () => {
    let readable = false;
    const check = certificateExpiryCheck({
      files: [{ label: "pg_client", path: "/missing.crt" }],
      readValidTo: () => {
        if (!readable) throw new Error("ENOENT");
        return new Date(T0.getTime() + 100 * DAY);
      },
    });
    const h = harness([check]);
    await expectTripsOnceAndClears(h, "platform.cert_expiry:pg_client:unreadable", () => { readable = false; }, () => { readable = true; });
    expect(h.sink.raised[0]?.priority).toBe("P2");
  });

  test("redis_unreachable: probe throws, returns false or times out", async () => {
    let mode: "ok" | "throw" | "false" | "hang" = "ok";
    const check = redisReachabilityCheck({
      timeoutMs: 20,
      probe: async () => {
        if (mode === "throw") throw new Error("ECONNREFUSED");
        if (mode === "false") return false;
        if (mode === "hang") return new Promise(() => undefined);
        return "PONG";
      },
    });
    const h = harness([check]);
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(0);
    await expectTripsOnceAndClears(h, "platform.redis_unreachable", () => { mode = "throw"; }, () => { mode = "ok"; });
    expect(h.sink.raised[0]?.detail).toContain("ECONNREFUSED");
    mode = "false";
    await h.monitor.runOnce();
    mode = "hang";
    await h.monitor.runOnce();
    expect(h.sink.raised).toHaveLength(2);
    expect(h.sink.raised[1]?.subjectKey).toBe("platform.redis_unreachable");
  });

  test("createStandardPlatformChecks includes only the configured checks", () => {
    expect(createStandardPlatformChecks({}).map((check) => check.id)).toEqual(["worker_stale", "journal_default_rows"]);
    expect(
      createStandardPlatformChecks({
        checkpointMaxAgeMs: MIN,
        outboxMaxAgeMs: MIN,
        auditOutboxMaxAgeMs: MIN,
        backgroundJobMaxAgeMs: MIN,
        certificateFiles: [{ label: "x", path: "/x" }],
        redisProbe: async () => true,
        journalDefaultPartition: false,
      }).map((check) => check.id),
    ).toEqual(["worker_stale", "checkpoint_stale", "outbox_age", "audit_outbox_age", "background_job_age", "cert_expiry", "redis_unreachable"]);
  });

  test("platformSubjectKey format", () => {
    expect(platformSubjectKey("outbox_age")).toBe("platform.outbox_age");
    expect(platformSubjectKey("worker_stale", "PollWorker")).toBe("platform.worker_stale:PollWorker");
  });
});

describe("PrismaMonitorCaseSink", () => {
  interface CaseRow {
    id: string;
    kind: string;
    priority: string;
    state: string;
    subjectKey: string;
    resolutionNotes: string | null;
    slaDueAt: Date;
  }

  const fakeCaseDb = () => {
    const rows: CaseRow[] = [];
    const audits: Array<{ action: string; entityId: string }> = [];
    let raceOnCreate = false;
    const matches = (row: CaseRow, where: Record<string, any>): boolean =>
      row.kind === where.kind &&
      row.state !== "RESOLVED" &&
      (typeof where.subjectKey === "string" ? row.subjectKey === where.subjectKey : row.subjectKey.startsWith(where.subjectKey.startsWith));
    const db = {
      operatorCase: {
        findFirst: async ({ where }: { where: Record<string, any> }) => rows.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, any> }) => rows.filter((row) => matches(row, where)),
        create: async ({ data }: { data: Omit<CaseRow, "id"> }) => {
          if (raceOnCreate) throw Object.assign(new Error("unique"), { code: "P2002" });
          const row = { ...data, id: `case-${rows.length + 1}` } as CaseRow;
          rows.push(row);
          return { id: row.id };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<CaseRow> }) => {
          const row = rows.find((candidate) => candidate.id === where.id) as CaseRow;
          Object.assign(row, data);
          return row;
        },
      },
    };
    const sink = new PrismaMonitorCaseSink(db as never, {
      audit: async (_db, input) => {
        audits.push({ action: input.action, entityId: input.entityId });
      },
    });
    return { rows, audits, sink, race: () => { raceOnCreate = true; } };
  };

  const raise = (key: string) => ({ subjectKey: key, title: "Outbox relay is behind", detail: "6 min", priority: "P1" as const, now: T0 });

  test("opens one case per key, records clearing and re-trips on the same open case", async () => {
    const { rows, audits, sink } = fakeCaseDb();
    expect(await sink.raise(raise("platform.outbox_age"))).toEqual({ created: true });
    expect(await sink.raise(raise("platform.outbox_age"))).toEqual({ created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("MANUAL_REVIEW");
    expect(rows[0]?.priority).toBe("P1");
    expect(rows[0]?.slaDueAt.toISOString()).toBe(new Date(T0.getTime() + 4 * 3_600_000).toISOString());
    expect(await sink.listActiveKeys("platform.")).toEqual(["platform.outbox_age"]);

    await sink.clear({ subjectKey: "platform.outbox_age", detail: "ok again", now: T0 });
    await sink.clear({ subjectKey: "platform.outbox_age", detail: "ok again", now: T0 });
    expect(rows[0]?.resolutionNotes).toContain("[CLEARED 2026-11-09T10:00:00.000Z] ok again");
    expect(rows[0]?.state).toBe("OPEN");
    expect(await sink.listActiveKeys("platform.")).toEqual([]);

    expect(await sink.raise(raise("platform.outbox_age"))).toEqual({ created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolutionNotes).toContain("[RETRIPPED ");
    expect(await sink.listActiveKeys("platform.")).toEqual(["platform.outbox_age"]);
    expect(audits.map((entry) => entry.action)).toEqual([
      "PLATFORM_MONITOR_CASE_RAISED",
      "PLATFORM_MONITOR_CLEARED",
      "PLATFORM_MONITOR_RETRIPPED",
    ]);
  });

  test("a resolved case lets the next trip open a new one", async () => {
    const { rows, sink } = fakeCaseDb();
    await sink.raise(raise("platform.redis_unreachable"));
    (rows[0] as CaseRow).state = "RESOLVED";
    expect(await sink.raise(raise("platform.redis_unreachable"))).toEqual({ created: true });
    expect(rows).toHaveLength(2);
  });

  test("clearing without an open case is a no-op; a unique-index race is not an error", async () => {
    const { audits, sink, race } = fakeCaseDb();
    await sink.clear({ subjectKey: "platform.none", detail: "", now: T0 });
    expect(audits).toHaveLength(0);
    race();
    expect(await sink.raise(raise("platform.x"))).toEqual({ created: false });
  });
});
