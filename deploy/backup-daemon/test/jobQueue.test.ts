import { describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { JobQueue, QueueFullError } from "../src/jobQueue";
import { tempDir } from "./helpers";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("JobQueue", () => {
  test("runs jobs strictly one at a time, in acceptance order", async () => {
    const queue = new JobQueue();
    const log: string[] = [];
    let running = 0;
    let max = 0;
    const gates = [deferred(), deferred(), deferred()];
    const tickets = gates.map((gate, index) =>
      queue.enqueue({
        id: `j${index}`,
        kind: "backup",
        run: async () => {
          running += 1;
          max = Math.max(max, running);
          log.push(`start:${index}`);
          await gate.promise;
          log.push(`end:${index}`);
          running -= 1;
        },
      }),
    );
    expect(tickets.map((ticket) => ticket.position)).toEqual([0, 1, 2]);
    expect(queue.activeJob()).toEqual({ id: "j0", kind: "backup" });
    expect(queue.queuedCount()).toBe(2);
    expect(queue.isBusy()).toBe(true);
    for (const gate of gates) {
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await queue.whenIdle();
    expect(max).toBe(1);
    expect(log).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
    expect(queue.isBusy()).toBe(false);
  });

  test("a throwing job does not stop the queue or reject its done promise", async () => {
    const errors: string[] = [];
    const queue = new JobQueue({ logger: { error: (message: string) => errors.push(message) } });
    const first = queue.enqueue({ id: "bad", kind: "backup", run: async () => { throw new Error("boom"); } });
    let ran = false;
    const second = queue.enqueue({ id: "good", kind: "drill", run: async () => { ran = true; } });
    await Promise.all([first.done, second.done]);
    await queue.whenIdle();
    expect(ran).toBe(true);
    expect(errors[0]).toContain("boom");
  });

  test("idempotency keys deduplicate within a scope and are independent across scopes", async () => {
    const queue = new JobQueue();
    let runs = 0;
    const gate = deferred();
    const run = async () => { runs += 1; await gate.promise; };
    const first = queue.enqueue({ id: "a", kind: "backup", scope: "backup", idempotencyKey: "k", run });
    const retry = queue.enqueue({ id: "b", kind: "backup", scope: "backup", idempotencyKey: "k", run });
    const other = queue.enqueue({ id: "c", kind: "drill", scope: "drill", idempotencyKey: "k", run });
    expect(retry).toMatchObject({ id: "a", deduplicated: true, acceptedAt: first.acceptedAt });
    expect(other).toMatchObject({ id: "c", deduplicated: false });
    expect(queue.lookupKey("backup", "k")?.id).toBe("a");
    gate.resolve();
    await queue.whenIdle();
    expect(runs).toBe(2);
  });

  test("idempotency keys expire after the TTL", async () => {
    let now = new Date("2026-11-06T00:00:00Z");
    const queue = new JobQueue({ clock: () => now, idempotencyTtlMs: 1000 });
    queue.enqueue({ id: "a", kind: "backup", scope: "backup", idempotencyKey: "k", run: async () => {} });
    await queue.whenIdle();
    now = new Date(now.getTime() + 500);
    expect(queue.enqueue({ id: "b", kind: "backup", scope: "backup", idempotencyKey: "k", run: async () => {} }).deduplicated).toBe(true);
    now = new Date(now.getTime() + 600);
    expect(queue.enqueue({ id: "c", kind: "backup", scope: "backup", idempotencyKey: "k", run: async () => {} }).deduplicated).toBe(false);
    await queue.whenIdle();
  });

  test("the key map is bounded", async () => {
    const queue = new JobQueue({ maxIdempotencyEntries: 3 });
    for (let index = 0; index < 6; index += 1) {
      queue.enqueue({ id: `j${index}`, kind: "backup", scope: "s", idempotencyKey: `key${index}`, run: async () => {} });
      await queue.whenIdle();
    }
    expect(queue.lookupKey("s", "key0")).toBeUndefined();
    expect(queue.lookupKey("s", "key5")).toBeDefined();
  });

  test("a bounded queue refuses new work with QueueFullError", async () => {
    const queue = new JobQueue({ maxQueued: 1 });
    const gate = deferred();
    queue.enqueue({ id: "running", kind: "backup", run: () => gate.promise });
    queue.enqueue({ id: "waiting", kind: "backup", run: async () => {} });
    expect(() => queue.enqueue({ id: "overflow", kind: "backup", run: async () => {} })).toThrow(QueueFullError);
    gate.resolve();
    await queue.whenIdle();
  });
});

describe("idempotency keys survive a restart", () => {
  test("a retry after a restart deduplicates to the FINISHED job, but an interrupted job's key is dropped so the retry runs fresh", async () => {
    const dir = await tempDir("bd-keys-");
    const persistPath = join(dir, "idempotency-keys.json");
    try {
      const before = new JobQueue({ persistPath });
      before.enqueue({ id: "done-job", kind: "backup", scope: "backup", idempotencyKey: "k-done", run: async () => {} });
      const gate = deferred();
      before.enqueue({ id: "lost-job", kind: "backup", scope: "backup", idempotencyKey: "k-lost", run: () => gate.promise });
      await before.whenPersisted();
      expect(JSON.parse(await nodeFs.readFile(persistPath, "utf8"))).toHaveLength(2);

      // --- the daemon restarts; only "done-job" had finished ---
      const after = new JobQueue({ persistPath });
      expect(await after.loadKeys((id) => id === "done-job")).toBe(1);
      expect(after.enqueue({ id: "new-1", kind: "backup", scope: "backup", idempotencyKey: "k-done", run: async () => {} })).toMatchObject({ id: "done-job", deduplicated: true });
      const rerun = after.enqueue({ id: "new-2", kind: "backup", scope: "backup", idempotencyKey: "k-lost", run: async () => {} });
      expect(rerun).toMatchObject({ id: "new-2", deduplicated: false });
      await after.whenIdle();
      gate.resolve();
      await before.whenIdle();
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("expired, corrupt or missing key files restore nothing and never throw", async () => {
    const dir = await tempDir("bd-keys-");
    try {
      const path = join(dir, "keys.json");
      let now = new Date("2026-11-06T00:00:00Z");
      const queue = new JobQueue({ persistPath: path, clock: () => now, idempotencyTtlMs: 1000 });
      queue.enqueue({ id: "a", kind: "backup", scope: "s", idempotencyKey: "k", run: async () => {} });
      await queue.whenPersisted();
      now = new Date(now.getTime() + 5000);
      expect(await new JobQueue({ persistPath: path, clock: () => now }).loadKeys(() => true)).toBe(0);
      await nodeFs.writeFile(path, "{corrupt");
      expect(await new JobQueue({ persistPath: path }).loadKeys(() => true)).toBe(0);
      expect(await new JobQueue({ persistPath: join(dir, "nope.json") }).loadKeys(() => true)).toBe(0);
      expect(await new JobQueue().loadKeys(() => true)).toBe(0);
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });
});
