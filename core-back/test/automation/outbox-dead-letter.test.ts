import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  OUTBOX_UNKNOWN_TOPIC_ERROR,
  OutboxRelayWorker,
  outboxParkedSubjectKey,
  type OutboxBatchHandler,
} from "../../lib/storageEngine/outboxWorkers";
import type { OutboxEnvelope } from "../../lib/storageEngine/ports";
import {
  createWorkerSandbox,
  describeDatabase,
  uniqueId,
} from "../storage-engine/helpers/db";

/**
 * AUTO-02: outbox relay dead-lettering. The fake below evaluates the relay's
 * own SQL statements against an in-memory outbox (including savepoint
 * semantics for the consumer side effects), so the unit suite exercises the
 * real drain logic without a database.
 */

interface FakeRow {
  id: number;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  merchant_id: string | null;
  payload_json: unknown;
  created_at: Date;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
  parked_at: Date | null;
}

const createOutboxFake = () => {
  const rows: FakeRow[] = [];
  /** Side effects of the consumers (rolled back with their savepoint / transaction). */
  let projected: string[] = [];
  const statements: string[] = [];
  let nextId = 1;

  const insert = (topic: string, aggregateId: string, payload: Record<string, unknown> = {}, createdAt = new Date()) => {
    rows.push({
      id: nextId++,
      topic,
      aggregate_type: "test",
      aggregate_id: aggregateId,
      merchant_id: null,
      payload_json: payload,
      created_at: createdAt,
      processed_at: null,
      attempts: 0,
      last_error: null,
      parked_at: null,
    });
  };

  const byIds = (ids: unknown): FakeRow[] => {
    const wanted = new Set((ids as string[]).map(String));
    return rows.filter((row) => wanted.has(String(row.id)));
  };

  const snapshotRows = () => rows.map((row) => ({ ...row }));
  const restoreRows = (snapshot: FakeRow[]) => {
    rows.splice(0, rows.length, ...snapshot.map((row) => ({ ...row })));
  };

  const makeClient = (savepoints: Map<string, number>) => {
    const client = {
      project: (marker: string) => {
        projected.push(marker);
      },
      $queryRawUnsafe: async (sql: string, ...values: unknown[]): Promise<unknown[]> => {
        statements.push(sql);
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          const limit = Number(values[0]);
          return rows
            .filter((row) => row.processed_at === null && row.parked_at === null)
            .sort((left, right) => left.id - right.id)
            .slice(0, limit)
            .map((row) => ({ ...row, id: String(row.id) }));
        }
        if (sql.includes("SET attempts = o.attempts + 1")) {
          const [ids, errors, maxAttempts] = values as [string[], string[], number];
          return ids.map((id, index) => {
            const row = rows.find((candidate) => String(candidate.id) === String(id))!;
            row.attempts += 1;
            row.last_error = errors[index] ?? null;
            row.parked_at = row.attempts >= maxAttempts ? new Date() : null;
            return { id: String(row.id), topic: row.topic, attempts: row.attempts, parked_at: row.parked_at, last_error: row.last_error };
          });
        }
        if (sql.includes("SELECT created_at FROM outbox_events")) {
          const pending = rows
            .filter((row) => row.processed_at === null && row.parked_at === null)
            .sort((left, right) => left.id - right.id);
          return pending.length > 0 ? [{ created_at: pending[0]!.created_at }] : [];
        }
        if (sql.includes("count(*)::text AS count FROM outbox_events")) {
          return [{ count: String(rows.filter((row) => row.processed_at === null && row.parked_at !== null).length) }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]): Promise<number> => {
        statements.push(sql);
        const savepoint = /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) (\w+)$/.exec(sql.trim());
        if (savepoint) {
          const [, verb, name] = savepoint;
          if (verb === "SAVEPOINT") savepoints.set(name!, projected.length);
          if (verb === "ROLLBACK TO SAVEPOINT") projected = projected.slice(0, savepoints.get(name!) ?? 0);
          if (verb === "RELEASE SAVEPOINT") savepoints.delete(name!);
          return 0;
        }
        if (sql.includes("SET processed_at = now(), last_error = $2")) {
          const matched = byIds(values[0]);
          for (const row of matched) {
            row.processed_at = new Date();
            row.last_error = String(values[1]);
          }
          return matched.length;
        }
        if (sql.includes("SET processed_at = now() WHERE id = ANY")) {
          const matched = byIds(values[0]);
          for (const row of matched) row.processed_at = new Date();
          return matched.length;
        }
        if (sql.includes("SET parked_at = NULL, attempts = 0")) {
          const matched = rows.filter(
            (row) => row.processed_at === null && row.parked_at !== null && (values[0] === undefined || row.topic === values[0]),
          );
          for (const row of matched) {
            row.parked_at = null;
            row.attempts = 0;
          }
          return matched.length;
        }
        if (sql.includes("DELETE FROM outbox_events")) {
          const cutoff = values[0] as Date;
          const pendingIds = rows.filter((row) => row.processed_at === null && row.parked_at === null).map((row) => row.id);
          const floor = pendingIds.length > 0 ? Math.min(...pendingIds) : Number.MAX_SAFE_INTEGER;
          const doomed = rows
            .filter((row) => row.id < floor && row.processed_at !== null && row.parked_at === null && row.processed_at < cutoff)
            .slice(0, Number(values[1]));
          for (const row of doomed) rows.splice(rows.indexOf(row), 1);
          return doomed.length;
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
    };
    return client;
  };

  const db = {
    ...makeClient(new Map()),
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const rowSnapshot = snapshotRows();
      const projectedSnapshot = [...projected];
      try {
        return await fn(makeClient(new Map()));
      } catch (error) {
        restoreRows(rowSnapshot);
        projected = projectedSnapshot;
        throw error;
      }
    },
  };

  return {
    db: db as unknown as PrismaClient,
    rows,
    statements,
    insert,
    get projected() {
      return projected;
    },
    row: (aggregateId: string) => rows.find((row) => row.aggregate_id === aggregateId)!,
  };
};

const poisonAwareHandler: OutboxBatchHandler = async (events: OutboxEnvelope[], tx) => {
  for (const event of events) {
    if (event.payload.poison) {
      throw new Error(`cannot project ${event.aggregateId}`);
    }
    (tx as unknown as { project: (marker: string) => void }).project(event.aggregateId);
  }
};

const createEscalations = () => {
  const openCases = new Map<string, string>();
  const raised: string[] = [];
  const audits: Array<{ action: string; entityId: string; after?: unknown }> = [];
  return {
    openCases,
    raised,
    audits,
    raiseCase: async (input: { subjectKey: string; notes: string }) => {
      raised.push(input.subjectKey);
      if (openCases.has(input.subjectKey)) return false;
      openCases.set(input.subjectKey, input.notes);
      return true;
    },
    audit: async (input: { action: string; entityId: string; after?: unknown }) => {
      audits.push(input);
    },
  };
};

const recordingLogger = () => {
  const lines: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  return {
    lines,
    info: (message: string, meta?: Record<string, unknown>) => lines.push({ level: "info", message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => lines.push({ level: "warn", message, meta }),
    error: (message: string, meta?: Record<string, unknown>) => lines.push({ level: "error", message, meta }),
  };
};

describe("AUTO-02 outbox relay dead-lettering (fake outbox)", () => {
  test("a poison event between two good ones: the good ones are projected, the poison one parks after N ticks, one case", async () => {
    const fake = createOutboxFake();
    fake.insert("attempt.transitioned", "good-1");
    fake.insert("attempt.transitioned", "poison", { poison: true });
    fake.insert("attempt.transitioned", "good-2");
    const escalations = createEscalations();
    const relay = new OutboxRelayWorker(fake.db, {
      batchSize: 10,
      batchHandlers: { "attempt.transitioned": poisonAwareHandler },
      deadLetter: { raiseCase: escalations.raiseCase, audit: escalations.audit },
      logger: recordingLogger(),
    });

    expect(await relay.drain()).toBe(2);
    expect(fake.projected).toEqual(["good-1", "good-2"]);
    expect(fake.row("good-1").processed_at).not.toBeNull();
    expect(fake.row("good-2").processed_at).not.toBeNull();
    expect(fake.row("poison").processed_at).toBeNull();
    expect(fake.row("poison").attempts).toBe(1);
    expect(fake.row("poison").last_error).toBe("cannot project poison");
    expect(fake.row("poison").parked_at).toBeNull();

    for (let tick = 2; tick < DEFAULT_OUTBOX_MAX_ATTEMPTS; tick += 1) {
      expect(await relay.drain()).toBe(0);
      expect(fake.row("poison").parked_at).toBeNull();
    }
    expect(escalations.raised).toHaveLength(0);
    expect(await relay.drain()).toBe(0);
    expect(fake.row("poison").attempts).toBe(DEFAULT_OUTBOX_MAX_ATTEMPTS);
    expect(fake.row("poison").parked_at).not.toBeNull();
    expect(fake.projected).toEqual(["good-1", "good-2"]);

    const subjectKey = outboxParkedSubjectKey("attempt.transitioned");
    expect([...escalations.openCases.keys()]).toEqual([subjectKey]);
    expect(escalations.audits).toHaveLength(1);
    expect(escalations.audits[0]!.action).toBe("OUTBOX_EVENT_PARKED");
    expect(escalations.audits[0]!.entityId).toBe(String(fake.row("poison").id));

    // A parked event is no longer claimed: the relay is idle again.
    expect(await relay.drain()).toBe(0);
    expect(fake.row("poison").attempts).toBe(DEFAULT_OUTBOX_MAX_ATTEMPTS);
    expect(relay.counters.parked).toBe(1);
    expect(relay.counters.processed).toBe(2);
    expect(relay.counters.failedDeliveries).toBe(DEFAULT_OUTBOX_MAX_ATTEMPTS);

    // A second poison event of the same topic does not open a second case.
    fake.insert("attempt.transitioned", "poison-2", { poison: true });
    const fast = new OutboxRelayWorker(fake.db, {
      batchSize: 10,
      batchHandlers: { "attempt.transitioned": poisonAwareHandler },
      deadLetter: { maxAttempts: 1, raiseCase: escalations.raiseCase, audit: escalations.audit },
    });
    await fast.drain();
    expect(fake.row("poison-2").parked_at).not.toBeNull();
    expect(escalations.openCases.size).toBe(1);
    expect(escalations.audits).toHaveLength(2);
  });

  test("a healthy batch is delivered once inside one savepoint and acknowledged with one statement", async () => {
    const fake = createOutboxFake();
    for (let index = 0; index < 5; index += 1) fake.insert("attempt.transitioned", `ok-${index}`);
    const relay = new OutboxRelayWorker(fake.db, {
      batchSize: 10,
      batchHandlers: { "attempt.transitioned": poisonAwareHandler },
    });
    expect(await relay.drain()).toBe(5);
    expect(fake.statements.filter((sql) => sql.startsWith("SAVEPOINT"))).toEqual(["SAVEPOINT outbox_batch"]);
    expect(fake.statements.filter((sql) => sql.includes("SET processed_at = now()"))).toHaveLength(1);
    expect(fake.rows.every((row) => row.attempts === 0 && row.processed_at !== null)).toBe(true);
  });

  test("per-event handlers keep their side effects only when they succeed", async () => {
    const fake = createOutboxFake();
    fake.insert("config.invalidated", "a");
    fake.insert("config.invalidated", "b", { poison: true });
    fake.insert("config.invalidated", "c");
    const relay = new OutboxRelayWorker(fake.db, {
      batchSize: 10,
      handlers: {
        "config.invalidated": async (event, tx) => {
          (tx as unknown as { project: (marker: string) => void }).project(event.aggregateId);
          if (event.payload.poison) throw new Error("bad config event");
        },
      },
      deadLetter: { raiseCase: async () => true, audit: async () => undefined },
    });
    expect(await relay.drain()).toBe(2);
    // "b" projected before throwing; its savepoint rolled that back.
    expect(fake.projected).toEqual(["a", "c"]);
    expect(fake.row("b").attempts).toBe(1);
  });

  test("unknown topics are acknowledged, logged, counted and marked instead of silently dropped", async () => {
    const fake = createOutboxFake();
    fake.insert("mystery.topic", "m-1");
    fake.insert("mystery.topic", "m-2");
    fake.insert("config.invalidated", "known");
    const logger = recordingLogger();
    const relay = new OutboxRelayWorker(fake.db, { batchSize: 10, logger });
    expect(await relay.drain()).toBe(3);
    expect(fake.row("m-1").processed_at).not.toBeNull();
    expect(fake.row("m-1").last_error).toBe(OUTBOX_UNKNOWN_TOPIC_ERROR);
    expect(fake.row("known").last_error).toBeNull();
    expect(relay.counters.unknownTopics).toEqual({ "mystery.topic": 2 });
    const warning = logger.lines.find((line) => line.message.includes("unknown topic"));
    expect(warning?.level).toBe("warn");
    expect(warning?.meta).toEqual({ topic: "mystery.topic", count: 2 });
  });

  test("a case that cannot be raised is retried on the next drain", async () => {
    const fake = createOutboxFake();
    fake.insert("config.invalidated", "p", { poison: true });
    let failures = 1;
    const raised: string[] = [];
    const logger = recordingLogger();
    const relay = new OutboxRelayWorker(fake.db, {
      handlers: { "config.invalidated": async (event) => { if (event.payload.poison) throw new Error("boom"); } },
      deadLetter: {
        maxAttempts: 1,
        audit: async () => undefined,
        raiseCase: async (input) => {
          if (failures-- > 0) throw new Error("case store down");
          raised.push(input.subjectKey);
          return true;
        },
      },
      logger,
    });
    await relay.drain();
    expect(raised).toHaveLength(0);
    expect(logger.lines.some((line) => line.level === "error" && line.message.includes("parked-event case"))).toBe(true);
    await relay.drain();
    expect(raised).toEqual([outboxParkedSubjectKey("config.invalidated")]);
    await relay.drain();
    expect(raised).toHaveLength(1);
  });

  test("backlog stats report the oldest pending age and the parked count; requeue returns parked events", async () => {
    const fake = createOutboxFake();
    const now = new Date("2026-11-09T12:00:00.000Z");
    fake.insert("config.invalidated", "p", { poison: true }, new Date(now.getTime() - 120_000));
    fake.insert("config.invalidated", "q", {}, new Date(now.getTime() - 30_000));
    const relay = new OutboxRelayWorker(fake.db, {
      batchSize: 1,
      handlers: { "config.invalidated": async (event) => { if (event.payload.poison) throw new Error("boom"); } },
      deadLetter: { maxAttempts: 1, raiseCase: async () => true, audit: async () => undefined },
    });
    expect(await relay.backlogStats(now)).toEqual({
      oldestPendingCreatedAt: new Date(now.getTime() - 120_000),
      oldestPendingAgeMs: 120_000,
      parkedCount: 0,
    });
    await relay.drain(); // parks "p"
    const stats = await relay.backlogStats(now);
    expect(stats.parkedCount).toBe(1);
    expect(stats.oldestPendingAgeMs).toBe(30_000);
    await relay.drain(); // processes "q"
    expect(await relay.backlogStats(now)).toEqual({ oldestPendingCreatedAt: null, oldestPendingAgeMs: null, parkedCount: 1 });

    expect(await relay.requeueParked("other.topic")).toBe(0);
    expect(await relay.requeueParked("config.invalidated")).toBe(1);
    expect(fake.row("p").parked_at).toBeNull();
    expect(fake.row("p").attempts).toBe(0);
  });

  test("the retention prune never deletes parked rows and is not held back by them", async () => {
    const fake = createOutboxFake();
    const relay = new OutboxRelayWorker(fake.db, {
      handlers: { "config.invalidated": async (event) => { if (event.payload.poison) throw new Error("boom"); } },
      deadLetter: { maxAttempts: 1, raiseCase: async () => true, audit: async () => undefined },
      retention: { retentionMs: 1, pruneBatchSize: 100 },
    });
    fake.insert("config.invalidated", "parked", { poison: true });
    fake.insert("config.invalidated", "done");
    await relay.drain();
    expect(fake.row("parked").parked_at).not.toBeNull();
    const deleted = await relay.prune(new Date(Date.now() + 60_000));
    expect(deleted).toBe(1);
    expect(fake.rows.map((row) => row.aggregate_id)).toEqual(["parked"]);
    const pruneSql = fake.statements.find((sql) => sql.includes("DELETE FROM outbox_events"))!;
    expect(pruneSql).toContain("AND parked_at IS NULL");
  });
});

describeDatabase("AUTO-02 outbox relay dead-lettering (live PostgreSQL)", () => {
  test("a poison event between two good ones is parked after N drains and raises one case", async () => {
    const sandbox = await createWorkerSandbox("outbox-dead-letter");
    const prefix = uniqueId("outbox-dead-letter");
    try {
      for (const [suffix, poison] of [["good-1", false], ["poison", true], ["good-2", false]] as const) {
        await sandbox.client.$executeRawUnsafe(
          `INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, payload_json)
           VALUES ('config.invalidated', 'test', $1, $2::jsonb)`,
          `${prefix}-${suffix}`,
          JSON.stringify({ poison }),
        );
      }
      const delivered: string[] = [];
      const escalations = createEscalations();
      const relay = new OutboxRelayWorker(sandbox.client, {
        batchSize: 10,
        handlers: {
          "config.invalidated": async (event) => {
            if (event.payload.poison) throw new Error("POISON");
            delivered.push(event.aggregateId);
          },
        },
        deadLetter: { maxAttempts: 3, raiseCase: escalations.raiseCase, audit: escalations.audit },
      });
      expect(await relay.drain()).toBe(2);
      expect(await relay.drain()).toBe(0);
      expect(await relay.drain()).toBe(0);
      expect(await relay.drain()).toBe(0);
      const state = await sandbox.client.$queryRawUnsafe<
        Array<{ aggregate_id: string; processed_at: Date | null; attempts: number; parked_at: Date | null; last_error: string | null }>
      >(`SELECT aggregate_id, processed_at, attempts, parked_at, last_error FROM outbox_events ORDER BY id`);
      expect(state.map((row) => row.processed_at !== null)).toEqual([true, false, true]);
      expect(Number(state[1]!.attempts)).toBe(3);
      expect(state[1]!.parked_at).not.toBeNull();
      expect(state[1]!.last_error).toBe("POISON");
      expect([...escalations.openCases.keys()]).toEqual([outboxParkedSubjectKey("config.invalidated")]);
      expect(escalations.audits).toHaveLength(1);
      expect((await relay.backlogStats()).parkedCount).toBe(1);
      // Two good deliveries in the failed batch were rolled back and redelivered alone.
      expect(new Set(delivered)).toEqual(new Set([`${prefix}-good-1`, `${prefix}-good-2`]));
    } finally {
      await sandbox.cleanup();
    }
  });
});
