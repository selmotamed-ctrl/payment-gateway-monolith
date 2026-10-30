/**
 * Suite 06.3 — multi-node worker cluster against the live durable queue.
 *
 * Four `BackgroundJobWorker` instances drain 200 due jobs with
 * `SELECT ... FOR UPDATE SKIP LOCKED`; every job must be processed exactly
 * once. A crashed node's lease is recovered, and a failing handler is retried
 * with a backoff.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  assertZeroDrift,
  createExhaustiveClient,
  databaseIsReachable,
  exhaustiveClient,
} from "../_harness";
import { createRow } from "../_dbFactory";
import { BackgroundJobWorker } from "../../../engine/workers/BackgroundJobWorker";
import type { BackgroundJobRow } from "../../../engine/db/ports";

const db = exhaustiveClient();
const describeDb = databaseIsReachable ? describe : describe.skip;
const PREFIX = `worker6-${crypto.randomUUID()}`;
const jobIds: string[] = [];

const makeJob = async (overrides: Record<string, unknown> = {}): Promise<string> => {
  const row = await createRow("background_jobs", {
    job_type: "ADJUSTMENT_EXECUTION",
    reference_type: "EXHAUSTIVE",
    reference_id: `${PREFIX}-ref-${crypto.randomUUID()}`,
    payload_json: JSON.stringify({ prefix: PREFIX }),
    state: "QUEUED",
    ...overrides,
  });
  jobIds.push(String(row.id));
  return String(row.id);
};

const readJob = async (id: string) => {
  const rows = (await db.$queryRawUnsafe(
    "SELECT state, attempts, locked_at, last_error FROM background_jobs WHERE id = ?",
    id,
  )) as Array<Record<string, unknown>>;
  return rows[0] as { state: string; attempts: number | bigint; locked_at: Date | null; last_error: string | null };
};

const workerClients: ReturnType<typeof createExhaustiveClient>[] = [];

const worker = (handler: (job: BackgroundJobRow) => Promise<void>, batchSize = 50) => {
  const client = createExhaustiveClient();
  workerClients.push(client);
  return new BackgroundJobWorker({
    db: client as never,
    repositories: {} as never,
    handlers: { ADJUSTMENT_EXECUTION: { handle: handler } },
    batchSize,
    leaseSeconds: 300,
    baseBackoffMs: 1,
    maxBackoffMs: 5,
  });
};

afterEach(async () => {
  if (!databaseIsReachable) {
    return;
  }
  if (jobIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM background_jobs WHERE id IN (${jobIds.map(() => "?").join(",")})`,
      ...jobIds,
    );
    jobIds.length = 0;
  }
  await Promise.all(workerClients.splice(0).map((client) => client.$disconnect()));
});

afterAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  await db.$executeRawUnsafe("DELETE FROM background_jobs WHERE reference_type = 'EXHAUSTIVE'").catch(() => undefined);
  await assertZeroDrift(db);
  await db.$disconnect();
});

describeDb("Suite 06 · multi-node durable queue", () => {
  test("4 workers × 200 due jobs process every row exactly once", async () => {
    const ids = await Promise.all(Array.from({ length: 200 }, () => makeJob()));
    const handled = new Map<string, number>();
    const handler = async (job: BackgroundJobRow) => {
      handled.set(job.id, (handled.get(job.id) ?? 0) + 1);
    };
    const workers = Array.from({ length: 4 }, () => worker(handler));
    // SKIP LOCKED hands each node a disjoint batch. Under heavy contention a
    // node may legitimately see an empty batch because its peers hold the row
    // locks; the cluster therefore keeps ticking until the queue is drained.
    for (let round = 0; round < 10; round += 1) {
      await Promise.all(workers.map((instance) => instance.runOnce()));
      const pending = (await db.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM background_jobs WHERE id IN (${ids.map(() => "?").join(",")}) AND state IN ('QUEUED','RUNNING')`,
        ...ids,
      )) as Array<{ count: bigint }>;
      if (Number(pending[0]?.count) === 0) {
        break;
      }
    }
    expect(handled.size).toBe(200);
    expect([...handled.values()].every((count) => count === 1)).toBe(true);
    const rows = (await db.$queryRawUnsafe(
      `SELECT state, COUNT(*) AS count FROM background_jobs WHERE id IN (${ids.map(() => "?").join(",")}) GROUP BY state`,
      ...ids,
    )) as Array<{ state: string; count: bigint }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("SUCCEEDED");
    expect(Number(rows[0]?.count)).toBe(200);
  }, 120_000);

  test("a crashed node's RUNNING lease is recovered and processed", async () => {
    const id = await makeJob({ state: "RUNNING", locked_at: new Date(Date.now() - 3_600_000) });
    let processed = 0;
    const instance = worker(async () => {
      processed += 1;
    });
    await instance.runOnce();
    expect(processed).toBe(1);
    const job = await readJob(id);
    expect(job.state).toBe("SUCCEEDED");
  }, 60_000);

  test("a failing handler is re-queued with a bounded backoff", async () => {
    const id = await makeJob();
    let attempts = 0;
    const failing = worker(async () => {
      attempts += 1;
      throw new Error("transient upstream failure");
    });
    await failing.runOnce();
    expect(attempts).toBe(1);
    const job = await readJob(id);
    expect(job.state).toBe("QUEUED");
    expect(Number(job.attempts)).toBe(1);
    expect(String(job.last_error)).toContain("transient upstream failure");
  }, 60_000);

  test("a job is retried and then succeeds", async () => {
    const id = await makeJob();
    let attempts = 0;
    const flaky = worker(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("first attempt fails");
      }
    });
    await flaky.runOnce();
    expect((await readJob(id)).state).toBe("QUEUED");
    // Make the retry immediately available.
    await db.$executeRawUnsafe("UPDATE background_jobs SET available_at = NOW() WHERE id = ?", id);
    await flaky.runOnce();
    expect(attempts).toBe(2);
    expect((await readJob(id)).state).toBe("SUCCEEDED");
  }, 60_000);

  test("a job that exhausts its attempts is marked FAILED", async () => {
    const id = await makeJob({ max_attempts: 1 });
    const failing = worker(async () => {
      throw new Error("permanent failure");
    });
    await failing.runOnce();
    const job = await readJob(id);
    expect(job.state).toBe("FAILED");
    expect(Number(job.attempts)).toBe(1);
  }, 60_000);
});
