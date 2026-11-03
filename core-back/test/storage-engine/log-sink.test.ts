import { afterAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import {
  DedicatedPostgresLogSink,
} from "../../lib/storageEngine/auditAndLogAdapters";
import type {
  HttpAccessLogRecord,
  StepLogRecord,
} from "../../lib/storageEngine/ports";
import {
  createLogSandbox,
  databaseIsReachable,
  uniqueId,
  uniqueUuid,
} from "./helpers/db";

const describeDatabase = databaseIsReachable ? describe : describe.skip;

class CapturePool {
  public readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  public fail = false;

  public async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    if (this.fail) {
      throw new Error("LOG_DATABASE_UNAVAILABLE");
    }
    this.calls.push({ sql, values });
    return { rows: [] };
  }

  public stepBatches(): unknown[][] {
    return this.calls
      .filter((call) => call.sql.includes("INSERT INTO attempt_step_logs"))
      .map((call) => call.values);
  }

  public accessBatches(): unknown[][] {
    return this.calls
      .filter((call) => call.sql.includes("INSERT INTO http_access_logs"))
      .map((call) => call.values);
  }
}

const makeStep = (index: number, attemptId = uniqueUuid()): StepLogRecord => ({
  attemptId,
  gatewayVersionId: uniqueUuid(),
  phase: "SUBMIT",
  stepId: null,
  stepOrder: index,
  redactedRequestJson: { index },
  redactedResponseText: `response-${index}`,
  httpStatus: 200,
  durationMs: index,
  outcome: "SUCCESS",
});

const makeAccess = (index: number): HttpAccessLogRecord => ({
  requestId: uniqueId(`request-${index}`),
  channel: "admin",
  method: "GET",
  routePattern: "/internal/test",
  statusCode: 200,
  durationMs: index,
  dbQueries: 1,
  dbDurationMs: 2,
  actorId: uniqueUuid(),
  clientIp: "127.0.0.1",
});

/**
 * The sink hardcodes the operational table names, so search_path on the pool
 * scopes it to the per-test schema.
 */
const asPool = (pool: CapturePool): Pool => pool as unknown as Pool;

afterAll(async () => {
  // Nothing global to close; each sandbox owns its pool.
});

describe("DedicatedPostgresLogSink buffering", () => {
  test("writes are non-blocking and never touch the database synchronously", async () => {
    const capture = new CapturePool();
    const sink = new DedicatedPostgresLogSink(asPool(capture), 500, 60_000);
    const attemptId = uniqueUuid();
    sink.writeStepLog(makeStep(1, attemptId));
    expect(capture.calls).toHaveLength(0);
    expect(sink.writeStepLog(makeStep(2, attemptId))).toBeUndefined();
    sink.writeAccessLog(makeAccess(1));
    expect(capture.calls).toHaveLength(0);
    await sink.close();
    expect(capture.stepBatches().reduce((sum, batch) => sum + batch.length / 12, 0)).toBe(2);
    expect(capture.accessBatches()).toHaveLength(1);
  });

  test("caps the buffer, dropping new access logs before evicting step logs", async () => {
    const capture = new CapturePool();
    const sink = new DedicatedPostgresLogSink(asPool(capture), 2, 60_000);
    const attemptId = uniqueUuid();
    for (let index = 0; index < 3; index += 1) {
      sink.writeStepLog(makeStep(index, attemptId));
    }
    const accessLogs = Array.from({ length: 3 }, (_, index) => makeAccess(index));
    for (const access of accessLogs) {
      sink.writeAccessLog(access);
    }
    await sink.flush();

    const stepBatch = capture.stepBatches()[0] as unknown[];
    const stepAttemptOrders = [];
    for (let offset = 0; offset < stepBatch.length; offset += 12) {
      stepAttemptOrders.push(stepBatch[offset + 5]);
    }
    expect(stepAttemptOrders).toEqual([1, 2]);

    const accessBatch = capture.accessBatches()[0] as unknown[];
    const requestIds: unknown[] = [];
    for (let offset = 0; offset < accessBatch.length; offset += 11) {
      requestIds.push(accessBatch[offset]);
    }
    expect(requestIds).toEqual([accessLogs[0]?.requestId, accessLogs[1]?.requestId]);

    await sink.close();
  });

  test("a failed flush requeues step logs without throwing and retries them", async () => {
    const capture = new CapturePool();
    capture.fail = true;
    const sink = new DedicatedPostgresLogSink(asPool(capture), 100, 60_000);
    const attemptId = uniqueUuid();
    sink.writeStepLog(makeStep(1, attemptId));
    sink.writeStepLog(makeStep(2, attemptId));
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(capture.stepBatches()).toHaveLength(0);

    capture.fail = false;
    await expect(sink.flush()).resolves.toBeUndefined();
    const batch = capture.stepBatches()[0] as unknown[];
    expect(batch.length).toBe(2 * 12);
    expect(batch[0 + 1]).toBe(attemptId);
    expect(batch[12 + 1]).toBe(attemptId);
    await sink.close();
  });

  test("splits flushes into batches of at most 500 rows", async () => {
    const capture = new CapturePool();
    const sink = new DedicatedPostgresLogSink(asPool(capture), 1_000, 60_000);
    const attemptId = uniqueUuid();
    for (let index = 0; index < 600; index += 1) {
      sink.writeStepLog(makeStep(index, attemptId));
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sink.flush();
      await Bun.sleep(5);
    }
    const batches = capture.stepBatches();
    const sizes = batches.map((batch) => batch.length / 12);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(600);
    expect(sizes.every((size) => size <= 500)).toBe(true);
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    await sink.close();
  });

  test("close flushes buffered rows and clears the timer", async () => {
    const capture = new CapturePool();
    const sink = new DedicatedPostgresLogSink(asPool(capture), 100, 5_000);
    sink.writeStepLog(makeStep(7));
    await sink.close();
    const batch = capture.stepBatches()[0] as unknown[];
    expect(batch.length).toBe(12);
    await sink.flush();
    expect(capture.stepBatches()).toHaveLength(1);
  });
});

describeDatabase("DedicatedPostgresLogSink against the sandbox log database", () => {
  test("queryStepLogsForAttempt returns step-order ordering after a real flush", async () => {
    const sandbox = await createLogSandbox("logs-order");
    const sink = new DedicatedPostgresLogSink(sandbox.pool, 5_000, 60_000);
    const attemptId = uniqueUuid();
    try {
      sink.writeStepLog({ ...makeStep(2, attemptId), outcome: "SECOND" });
      sink.writeStepLog({ ...makeStep(1, attemptId), outcome: "FIRST" });
      sink.writeStepLog({ ...makeStep(3, attemptId), outcome: "THIRD" });
      await sink.flush();
      const rows = await sink.queryStepLogsForAttempt(attemptId);
      expect(rows.map((row) => row.outcome)).toEqual(["FIRST", "SECOND", "THIRD"]);
      expect(rows.map((row) => row.stepOrder)).toEqual([1, 2, 3]);
      expect(await sink.queryStepLogsForAttempt(uniqueUuid())).toEqual([]);
    } finally {
      await sink.close();
      await sandbox.cleanup();
    }
  });

  test("a database outage never throws and remembered logs remain queryable", async () => {
    const capture = new CapturePool();
    capture.fail = true;
    const sink = new DedicatedPostgresLogSink(asPool(capture), 100, 60_000);
    const attemptId = uniqueUuid();
    expect(() => sink.writeStepLog(makeStep(1, attemptId))).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    const rows = await sink.queryStepLogsForAttempt(attemptId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attemptId).toBe(attemptId);
    await expect(sink.close()).resolves.toBeUndefined();
  });

  test("flushes both step logs and access logs to the sandbox tables", async () => {
    const sandbox = await createLogSandbox("logs-both");
    const sink = new DedicatedPostgresLogSink(sandbox.pool, 5_000, 60_000);
    const attemptId = uniqueUuid();
    const access = makeAccess(1);
    try {
      sink.writeStepLog(makeStep(1, attemptId));
      sink.writeAccessLog(access);
      await sink.flush();
      const steps = await sandbox.pool.query<{ attempt_id: string }>(
        "SELECT attempt_id FROM attempt_step_logs WHERE attempt_id = $1::uuid",
        [attemptId],
      );
      expect(steps.rows).toHaveLength(1);
      const accesses = await sandbox.pool.query<{ request_id: string }>(
        "SELECT request_id FROM http_access_logs WHERE request_id = $1",
        [access.requestId],
      );
      expect(accesses.rows).toHaveLength(1);
    } finally {
      await sink.close();
      await sandbox.cleanup();
    }
  });
});
