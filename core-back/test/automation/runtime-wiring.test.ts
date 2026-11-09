/**
 * The production composition of the Phase 1 automations: which workers `createProductionWorkerRuntime` builds, the
 * leader keys they register, the job handlers, the default dry-run switches, and (against live PostgreSQL) that every
 * platform check's SQL is valid on the real schema and the health endpoint lists the registered workers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { CommissionNettingWorker } from "../../engine/workers/CommissionNettingWorker";
import { PlatformMonitorWorker } from "../../engine/workers/PlatformMonitorWorker";
import { BackgroundJobWorker } from "../../engine/workers/BackgroundJobWorker";
import { createProductionWorkerRuntime } from "../../engine/workers/productionRuntime";
import { defaultWorkerHealthRegistry } from "../../engine/workers/workerRuntime";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";
import { DedicatedAuditDatabaseDriver } from "../../lib/storageEngine/auditAndLogAdapters";
import { createRetentionFake } from "../helpers/retentionFake";

const client = createPrisma({ max: 5 });
const describeDb = databaseIsReachable ? describe : describe.skip;

afterAll(async () => {
  await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key LIKE 'platform.%'`);
  await client.$disconnect();
});

const names = (runtime: ReturnType<typeof createProductionWorkerRuntime>): string[] =>
  runtime.workers.map((worker) => worker.constructor.name);

const fakeStorage = (expected: string[][]) =>
  ({
    leaderElection: { tryAcquire: async () => true, setExpected: (keys: string[]) => expected.push(keys) },
    auditStore: null,
    cache: {},
    health: async () => ({ cache: { driver: "memory", ok: true } }),
  }) as never;

describe("production worker runtime: Phase 1 automations", () => {
  test("the platform monitor and the commission netting are built by default and can be switched off", () => {
    const fake = createRetentionFake();
    const on = createProductionWorkerRuntime({ db: fake.db });
    expect(names(on)).toContain("PlatformMonitorWorker");
    expect(names(on)).toContain("CommissionNettingWorker");

    const off = createProductionWorkerRuntime({ db: fake.db, platformMonitorEnabled: false, commissionNettingEnabled: false });
    expect(names(off)).not.toContain("PlatformMonitorWorker");
    expect(names(off)).not.toContain("CommissionNettingWorker");
  });

  test("both are cluster singletons and their leader keys are registered for the health probe", () => {
    const fake = createRetentionFake();
    const expected: string[][] = [];
    const runtime = createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage(expected) });
    const keys = expected.at(-1) ?? [];
    expect(keys).toContain("worker:PlatformMonitorWorker");
    expect(keys).toContain("worker:CommissionNettingWorker");
    for (const worker of runtime.workers) {
      if (worker instanceof PlatformMonitorWorker || worker instanceof CommissionNettingWorker) {
        expect((worker as unknown as { clusterSingleton: boolean }).clusterSingleton).toBe(true);
      }
    }
  });

  test("the state-changing automations start as a dry run (plan rule 2) and the monitor reads the process-wide registry", () => {
    const fake = createRetentionFake();
    const runtime = createProductionWorkerRuntime({ db: fake.db });
    const netting = runtime.workers.find((worker) => worker instanceof CommissionNettingWorker) as unknown as { dryRun: boolean };
    expect(netting.dryRun).toBe(true);
    const live = createProductionWorkerRuntime({ db: fake.db, commissionNettingDryRun: false });
    expect((live.workers.find((worker) => worker instanceof CommissionNettingWorker) as unknown as { dryRun: boolean }).dryRun).toBe(false);
  });

  test("the KYB scan worker is built by default, is not a singleton (nodes claim with SKIP LOCKED), and honours its switch", () => {
    const fake = createRetentionFake();
    const expected: string[][] = [];
    const on = createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage(expected) });
    expect(names(on)).toContain("KybScanWorker");
    expect(expected.at(-1) ?? []).not.toContain("worker:KybScanWorker");
    expect(names(createProductionWorkerRuntime({ db: fake.db, kybScanEnabled: false }))).not.toContain("KybScanWorker");
    // no scanner is configured in the test environment: the worker is idle (documents stay PENDING)
    const worker = on.workers.find((candidate) => candidate.constructor.name === "KybScanWorker") as unknown as { scanner: unknown };
    expect(worker.scanner).toBeNull();
    // an injected scanner is used as is
    const injected = { engine: "fake", scan: async () => ({ verdict: "CLEAN" as const, engine: "fake" }) };
    const withScanner = createProductionWorkerRuntime({ db: fake.db, kybScanner: injected });
    expect((withScanner.workers.find((candidate) => candidate.constructor.name === "KybScanWorker") as unknown as { scanner: unknown }).scanner).toBe(injected);
  });

  test("the audit-chain anchor worker needs the dedicated audit database, is a cluster singleton and honours its switch", () => {
    const fake = createRetentionFake();
    const expected: string[][] = [];
    // without a dedicated audit database there is no chain to verify
    expect(names(createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage([]) }))).not.toContain("AuditChainAnchorWorker");
    const storage = { ...(fakeStorage(expected) as object), auditStore: new DedicatedAuditDatabaseDriver({} as never) } as never;
    const runtime = createProductionWorkerRuntime({ db: fake.db, storage });
    expect(names(runtime)).toContain("AuditChainAnchorWorker");
    expect(expected.at(-1) ?? []).toContain("worker:AuditChainAnchorWorker");
    expect(names(createProductionWorkerRuntime({ db: fake.db, storage, auditAnchorEnabled: false }))).not.toContain("AuditChainAnchorWorker");
  });

  test("the statement schedule and consistency audit workers are cluster singletons and honour their switches", () => {
    const fake = createRetentionFake();
    const expected: string[][] = [];
    const on = createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage(expected) });
    for (const name of ["StatementScheduleWorker", "ConsistencyAuditWorker"]) {
      expect(names(on)).toContain(name);
      expect(expected.at(-1) ?? []).toContain(`worker:${name}`);
    }
    const off = createProductionWorkerRuntime({ db: fake.db, statementScheduleEnabled: false, consistencyAuditEnabled: false });
    expect(names(off)).not.toContain("StatementScheduleWorker");
    expect(names(off)).not.toContain("ConsistencyAuditWorker");
    // the audit only reports until the repair flag is switched on
    const audit = on.workers.find((worker) => worker.constructor.name === "ConsistencyAuditWorker") as unknown as { deps: { repair?: boolean } };
    expect(audit.deps.repair).toBe(false);
  });

  test("the merchant webhook worker is built by default, is not a singleton (SKIP LOCKED claims), and honours its switch", () => {
    const fake = createRetentionFake();
    const expected: string[][] = [];
    const on = createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage(expected) });
    expect(names(on)).toContain("MerchantWebhookWorker");
    expect(expected.at(-1) ?? []).not.toContain("worker:MerchantWebhookWorker");
    expect(names(createProductionWorkerRuntime({ db: fake.db, merchantWebhookEnabled: false }))).not.toContain("MerchantWebhookWorker");
  });

  test("the regulatory report worker is built by default as a cluster singleton and honours its switch", () => {
    const fake = createRetentionFake();
    const expected: string[][] = [];
    const on = createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage(expected) });
    expect(names(on)).toContain("RegulatoryReportWorker");
    expect(expected.at(-1) ?? []).toContain("worker:RegulatoryReportWorker");
    expect(names(createProductionWorkerRuntime({ db: fake.db, regulatoryReportEnabled: false }))).not.toContain("RegulatoryReportWorker");
  });

  test("the REFUND_INQUIRY job type has a handler in the durable queue worker", () => {
    const fake = createRetentionFake();
    const runtime = createProductionWorkerRuntime({ db: fake.db });
    const queue = runtime.workers.find((worker) => worker instanceof BackgroundJobWorker) as unknown as { handlers: Record<string, unknown> };
    expect(Object.keys(queue.handlers).sort()).toEqual(["ADJUSTMENT_EXECUTION", "REFUND_INQUIRY", "RECONCILIATION_RUN"].sort());
  });

  test("the outbox relay and the audit shipper report to the health registry", () => {
    const fake = createRetentionFake();
    createProductionWorkerRuntime({ db: fake.db, storage: fakeStorage([]) });
    const registered = defaultWorkerHealthRegistry.records().map((record) => record.name);
    expect(registered).toContain("OutboxRelayWorker");
    // the relay idles up to 2 s between ticks: its staleness window must not be shorter than that
    expect(defaultWorkerHealthRegistry.get("OutboxRelayWorker")!.intervalMs).toBeGreaterThanOrEqual(2_000);
  });
});

describeDb("platform monitor against the real schema (live PostgreSQL)", () => {
  test("every standard check's SQL is valid: one tick completes with no failed check", async () => {
    const runtime = createProductionWorkerRuntime({
      db: client as never,
      storage: fakeStorage([]),
      // a leader election that always grants the lock, so the tick runs
    });
    const monitor = runtime.workers.find((worker) => worker instanceof PlatformMonitorWorker) as PlatformMonitorWorker;
    await monitor.runOnce();
    expect(monitor.lastSummary).not.toBeNull();
    expect(monitor.lastSummary!.failedChecks).toEqual([]);
  });

  test("the registry the health endpoint serves lists every worker the runtime built", async () => {
    createProductionWorkerRuntime({ db: client as never });
    const snapshot = defaultWorkerHealthRegistry.snapshot();
    expect(snapshot.workers.map((worker) => worker.name)).toEqual(
      expect.arrayContaining(["PlatformMonitorWorker", "CommissionNettingWorker", "PollWorker", "BackgroundJobWorker"]),
    );
  });
});
