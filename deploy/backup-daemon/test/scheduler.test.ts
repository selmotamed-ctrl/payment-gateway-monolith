import { describe, expect, test } from "bun:test";
import { CatalogStore, createDefaultPolicy } from "../src/catalogStore";
import { BackupScheduler } from "../src/scheduler";
import { createBackupDaemonHandler } from "../src/server";
import {
  FakeEngine,
  MemoryCatalogFileSystem,
  makeConfig,
  makeDrillReport,
} from "./helpers";

const makeCatalog = async (): Promise<CatalogStore> =>
  CatalogStore.load({
    path: "/virtual/scheduler-catalog.json",
    defaultPolicy: createDefaultPolicy({
      fullCron: "0 2 * * *",
      deltaCron: "30 2 * * *",
      drillCron: "0 3 * * *",
      updatedAt: "2026-11-03T00:00:00.000Z",
    }),
    fileSystem: new MemoryCatalogFileSystem(),
  });

const makeDrillRunner = () => ({
  calls: [] as Array<{ id?: string; requestedBy?: string } | undefined>,
  run: async (options?: { id?: string; requestedBy?: string }) => {
    return makeDrillReport(options?.id ?? "drill");
  },
});

describe("backup scheduler", () => {
  test("triggers full, delta and drill exactly once from the current policy", async () => {
    const config = makeConfig();
    const catalog = await makeCatalog();
    const engine = new FakeEngine();
    const drillRunner = makeDrillRunner();
    let now = new Date("2026-11-03T01:58:00.000Z");
    let idCounter = 0;
    const scheduler = new BackupScheduler({
      config,
      catalog,
      engine,
      drillRunner,
      clock: () => now,
      idFactory: () => `scheduled-${(idCounter += 1)}`,
    });

    now = new Date("2026-11-03T02:00:00.000Z");
    await scheduler.tick();
    await scheduler.tick(new Date("2026-11-03T02:00:30.000Z"));
    expect(engine.triggerCalls).toEqual([{ target: "all", kind: "full" }]);
    expect(engine.pruneCalls).toEqual([{ target: "all", kind: "full" }]);
    expect(catalog.listRuns(10)).toHaveLength(1);
    expect(catalog.listRuns(1)[0]).toMatchObject({ target: "all", kind: "full", status: "PASSED" });

    now = new Date("2026-11-03T02:30:00.000Z");
    await scheduler.tick();
    await scheduler.tick(new Date("2026-11-03T02:30:30.000Z"));
    expect(engine.triggerCalls).toEqual([
      { target: "all", kind: "full" },
      { target: "all", kind: "delta" },
    ]);

    now = new Date("2026-11-03T03:00:00.000Z");
    await scheduler.tick();
    await scheduler.tick(new Date("2026-11-03T03:00:30.000Z"));
    expect(catalog.listDrills(10)).toHaveLength(1);
    expect(catalog.listDrills(1)[0]?.status).toBe("PASSED");

    scheduler.stop();
  });

  test("reloads a policy persisted through the HTTP API without restarting", async () => {
    const config = makeConfig();
    const catalog = await makeCatalog();
    const engine = new FakeEngine();
    const drillRunner = makeDrillRunner();
    let now = new Date("2026-11-03T12:00:00.000Z");
    const scheduler = new BackupScheduler({
      config,
      catalog,
      engine,
      drillRunner,
      clock: () => now,
      idFactory: () => "scheduled-policy",
    });
    expect(scheduler.getState().nextFullAt).toBe("2026-11-04T02:00:00.000Z");

    const handler = createBackupDaemonHandler({
      config,
      engine,
      drillRunner,
      catalog,
      scheduler,
      clock: () => now,
      idFactory: () => "http-id",
    });
    const response = await handler.handler(
      new Request("http://127.0.0.1:4090/v1/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullCron: "0 14 * * *",
          deltaCron: "30 2 * * *",
          drillCron: "0 3 * * *",
          fullRetentionDays: 56,
          walRetentionDays: 14,
          alertLagSeconds: 300,
          updatedBy: "operator-1",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(catalog.getPolicy().fullCron).toBe("0 14 * * *");
    expect(scheduler.getState().nextFullAt).toBe("2026-11-03T14:00:00.000Z");

    now = new Date("2026-11-03T14:00:00.000Z");
    await scheduler.tick();
    expect(engine.triggerCalls).toEqual([{ target: "all", kind: "full" }]);
    scheduler.stop();
  });

  test("skips overlapping jobs and logs a warning", async () => {
    const config = makeConfig();
    const catalog = await makeCatalog();
    await catalog.updatePolicy({ fullCron: "0 2 * * *", deltaCron: "0 2 * * *" });
    const engine = new FakeEngine();
    const drillRunner = makeDrillRunner();
    const warnings: string[] = [];
    let now = new Date("2026-11-03T01:58:00.000Z");
    const scheduler = new BackupScheduler({
      config,
      catalog,
      engine,
      drillRunner,
      clock: () => now,
      idFactory: () => "scheduled-overlap",
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(String(message)),
        error: () => undefined,
      },
    });

    now = new Date("2026-11-03T02:00:00.000Z");
    await scheduler.tick();
    await scheduler.tick(new Date("2026-11-03T02:00:05.000Z"));
    expect(engine.triggerCalls).toEqual([{ target: "all", kind: "full" }]);
    expect(warnings.some((warning) => warning.includes("skipping delta"))).toBe(true);
    expect(catalog.listRuns(10)).toHaveLength(1);
    scheduler.stop();
  });
});
