import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore, createDefaultPolicy, type BackupRun } from "../src/catalogStore";
import { FailingCatalogFileSystem, MemoryCatalogFileSystem, makeConfig } from "./helpers";

const temporaryDirectories: string[] = [];

const tempCatalogPath = async (): Promise<string> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pg-backup-catalog-"));
  temporaryDirectories.push(directory);
  return join(directory, "catalog.json");
};

const makeRun = (id: string, startedAt = "2026-11-03T10:00:00.000Z"): BackupRun => ({
  id,
  target: "postgres_core",
  kind: "full",
  engine: "wal-g",
  status: "QUEUED",
  startedAt,
  storageTargets: [],
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("catalog store", () => {
  test("creates a default catalog and persists runs atomically", async () => {
    const path = await tempCatalogPath();
    const policy = createDefaultPolicy({ fullCron: "0 1 * * 0", updatedAt: "2026-11-03T00:00:00.000Z" });
    const store = await CatalogStore.load({ path, defaultPolicy: policy });
    expect(store.isPersistent()).toBe(true);
    expect(store.getPolicy().fullCron).toBe("0 1 * * 0");

    await store.addRun(makeRun("run-1"));
    await store.updateRun("run-1", {
      status: "PASSED",
      completedAt: "2026-11-03T10:05:00.000Z",
      durationMs: 300_000,
      storageTargets: ["primary-s3", "secondary-ssh"],
    });

    const raw = await fs.readFile(path, "utf8");
    const persisted = JSON.parse(raw) as { runs: BackupRun[] };
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0]?.status).toBe("PASSED");
    expect(persisted.runs[0]?.durationMs).toBe(300_000);

    const directoryEntries = await fs.readdir(join(path, ".."));
    expect(directoryEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);

    const reloaded = await CatalogStore.load({ path, defaultPolicy: policy });
    expect(reloaded.listRuns(10)[0]?.id).toBe("run-1");
    expect(reloaded.getLoadWarning()).toBeUndefined();
  });

  test("handles corrupt catalogs without throwing and writes a clean replacement", async () => {
    const path = await tempCatalogPath();
    await fs.writeFile(path, "{ this is not json", "utf8");
    const store = await CatalogStore.load({ path, defaultPolicy: createDefaultPolicy() });
    expect(store.listRuns()).toEqual([]);
    expect(store.getLoadWarning()).toContain("corrupt");

    const reloaded = await CatalogStore.load({ path, defaultPolicy: createDefaultPolicy() });
    expect(reloaded.getLoadWarning()).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toMatchObject({ runs: [], drills: [] });
  });

  test("prunes old records according to retention limits", async () => {
    const path = await tempCatalogPath();
    const store = await CatalogStore.load({
      path,
      defaultPolicy: createDefaultPolicy(),
      maxRuns: 2,
      maxDrills: 1,
    });
    await store.addRun(makeRun("old", "2026-11-01T00:00:00.000Z"));
    await store.addRun(makeRun("middle", "2026-11-02T00:00:00.000Z"));
    await store.addRun(makeRun("new", "2026-11-03T00:00:00.000Z"));
    expect(store.listRuns(10).map((run) => run.id)).toEqual(["new", "middle"]);
  });

  test("falls back to memory when the catalog path is unwritable", async () => {
    const fileSystem = new FailingCatalogFileSystem();
    const store = await CatalogStore.load({
      path: "/proc/pg-backup-daemon/catalog.json",
      defaultPolicy: createDefaultPolicy(),
      fileSystem,
    });
    expect(store.isPersistent()).toBe(false);
    await store.addRun(makeRun("memory-run"));
    expect(store.listRuns(10)[0]?.id).toBe("memory-run");
    expect(store.getPersistenceError()).toContain("EACCES");
  });

  test("supports an injectable in-memory filesystem", async () => {
    const fileSystem = new MemoryCatalogFileSystem();
    const store = await CatalogStore.load({
      path: "/virtual/catalog.json",
      defaultPolicy: createDefaultPolicy(),
      fileSystem,
    });
    await store.addRun(makeRun("virtual-run"));
    expect(fileSystem.files.get("/virtual/catalog.json")).toContain("virtual-run");
    const reloaded = await CatalogStore.load({
      path: "/virtual/catalog.json",
      defaultPolicy: createDefaultPolicy(),
      fileSystem,
    });
    expect(reloaded.listRuns(10)[0]?.id).toBe("virtual-run");
  });

  test("updates policy and keeps the config default when omitted", async () => {
    const path = await tempCatalogPath();
    const store = await CatalogStore.load({
      path,
      defaultPolicy: createDefaultPolicy({
        fullCron: "0 2 * * 0",
        fullRetentionDays: 56,
        updatedAt: "2026-11-03T00:00:00.000Z",
      }),
    });
    const updated = await store.updatePolicy({ fullRetentionDays: 70, updatedBy: "operator-1" });
    expect(updated.fullRetentionDays).toBe(70);
    expect(updated.updatedBy).toBe("operator-1");
    expect(updated.fullCron).toBe("0 2 * * 0");
    expect(makeConfig().BACKUP_ENGINE_MODE).toBe("wal-g");
  });
});
