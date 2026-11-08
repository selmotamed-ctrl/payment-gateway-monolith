import { afterAll, describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { CatalogStore, createDefaultPolicy, type BackupRun } from "../src/catalogStore";
import { JobQueue } from "../src/jobQueue";
import { restoreJobState } from "../src/startup";
import { MemoryCatalogFileSystem, makeDrillReport, tempDir } from "./helpers";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

const run = (id: string, status: BackupRun["status"]): BackupRun => ({
  id, target: "all", kind: "full", engine: "pg-native", status, startedAt: "2026-11-06T02:00:00.000Z", storageTargets: [],
});

describe("restart reconciliation (what index.ts does at boot)", () => {
  test("a retry after a CRASH starts a fresh job; a retry of a job that really finished is still deduplicated", async () => {
    const dir = await tempDir("bd-start-");
    dirs.push(dir);
    const persistPath = join(dir, "idempotency-keys.json");
    const fileSystem = new MemoryCatalogFileSystem();
    const catalogOptions = { path: "/virtual/c.json", fileSystem, defaultPolicy: createDefaultPolicy() };

    // --- first process: one job completed, one was mid-flight, one drill was mid-flight, then it dies ---
    const catalog1 = await CatalogStore.load(catalogOptions);
    const queue1 = new JobQueue({ persistPath });
    await catalog1.addRun(run("finished-backup", "PASSED"));
    await catalog1.addRun(run("midflight-backup", "RUNNING"));
    queue1.enqueue({ id: "finished-backup", kind: "backup", scope: "backup", idempotencyKey: "k-finished", run: async () => {} });
    queue1.enqueue({ id: "midflight-backup", kind: "backup", scope: "backup", idempotencyKey: "k-midflight", run: () => new Promise(() => {}) });
    queue1.enqueue({ id: "midflight-drill", kind: "drill", scope: "drill", idempotencyKey: "k-drill", run: async () => {} });
    await queue1.whenPersisted();

    // --- second process boots from the same state ---
    const catalog2 = await CatalogStore.load(catalogOptions);
    const queue2 = new JobQueue({ persistPath });
    const restored = await restoreJobState(catalog2, queue2);

    expect(restored.interrupted).toEqual(["midflight-backup"]);
    expect(restored.restoredKeys).toBe(1); // only the finished backup's key
    expect(catalog2.listRuns(10).find((entry) => entry.id === "midflight-backup")).toMatchObject({ status: "FAILED" });

    const finishedRetry = queue2.enqueue({ id: "x1", kind: "backup", scope: "backup", idempotencyKey: "k-finished", run: async () => {} });
    expect(finishedRetry).toMatchObject({ id: "finished-backup", deduplicated: true });
    // The interrupted job is FAILED in the catalog now, but its key must NOT hand the client a dead job.
    const crashRetry = queue2.enqueue({ id: "x2", kind: "backup", scope: "backup", idempotencyKey: "k-midflight", run: async () => {} });
    expect(crashRetry).toMatchObject({ id: "x2", deduplicated: false });
    const drillRetry = queue2.enqueue({ id: "x3", kind: "drill", scope: "drill", idempotencyKey: "k-drill", run: async () => {} });
    expect(drillRetry).toMatchObject({ id: "x3", deduplicated: false }); // never produced a report
    await queue2.whenIdle();
  });

  test("a drill that finished (has a report in the catalog) keeps its key", async () => {
    const dir = await tempDir("bd-start-");
    dirs.push(dir);
    const persistPath = join(dir, "keys.json");
    const catalog = await CatalogStore.load({ path: "/virtual/c.json", fileSystem: new MemoryCatalogFileSystem(), defaultPolicy: createDefaultPolicy() });
    await catalog.addDrill(makeDrillReport("drill-1"));
    const before = new JobQueue({ persistPath });
    before.enqueue({ id: "drill-1", kind: "drill", scope: "drill", idempotencyKey: "kd", run: async () => {} });
    await before.whenPersisted();
    const after = new JobQueue({ persistPath });
    expect((await restoreJobState(catalog, after)).restoredKeys).toBe(1);
  });
});
