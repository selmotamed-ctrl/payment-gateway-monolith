import { describe, expect, test } from "bun:test";
import { CatalogStore, createDefaultPolicy, type BackupRun, type CatalogFileSystem } from "../src/catalogStore";
import type { BackupExecutionResult } from "../src/backupEngine";
import { JobQueue } from "../src/jobQueue";
import {
  createBackupDaemonHandler,
  loadTlsOptions,
  type HandlerBundle,
} from "../src/server";
import {
  ENCRYPTION_KEY_HEX,
  FakeEngine,
  FailingCatalogFileSystem,
  MemoryCatalogFileSystem,
  PG_PASSWORD,
  S3_SECRET_KEY,
  makeConfig,
  makeDrillReport,
} from "./helpers";

const NOW = new Date("2026-11-03T12:00:00.000Z");

const makeCatalog = async (fileSystem: CatalogFileSystem = new MemoryCatalogFileSystem()): Promise<CatalogStore> =>
  CatalogStore.load({
    path: "/virtual/catalog.json",
    defaultPolicy: createDefaultPolicy({ updatedAt: NOW.toISOString() }),
    fileSystem,
  });

const request = (path: string, method = "GET", body?: unknown): Request =>
  new Request(`http://127.0.0.1:4090${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const makeHandler = async (options: {
  engine?: FakeEngine;
  catalog?: CatalogStore;
  drillRunner?: { run: (options?: { id?: string; requestedBy?: string; targetTime?: Date }) => Promise<ReturnType<typeof makeDrillReport>> };
  idFactory?: () => string;
  config?: ReturnType<typeof makeConfig>;
  jobs?: JobQueue;
} = {}): Promise<{ bundle: HandlerBundle; catalog: CatalogStore; engine: FakeEngine }> => {
  const catalog = options.catalog ?? (await makeCatalog());
  const engine = options.engine ?? new FakeEngine();
  let drillCounter = 0;
  const drillRunner =
    options.drillRunner ??
    {
      run: async (runOptions?: { id?: string; requestedBy?: string; targetTime?: Date }) => {
        drillCounter += 1;
        return makeDrillReport(runOptions?.id ?? `drill-${drillCounter}`);
      },
    };
  let idCounter = 0;
  const bundle = createBackupDaemonHandler({
    config: options.config ?? makeConfig(),
    engine,
    drillRunner,
    catalog,
    jobs: options.jobs,
    clock: () => NOW,
    idFactory: options.idFactory ?? (() => `id-${(idCounter += 1)}`),
  });
  return { bundle, catalog, engine };
};

describe("HTTP contract", () => {
  test("GET /health exposes status, engine mode and version without secrets", async () => {
    const { bundle } = await makeHandler();
    const response = await bundle.handler(request("/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await json(response)).toEqual({ status: "ok", engineMode: "wal-g", version: "1.0.0" });
  });

  test("GET /v1/overview includes WAL health, targets, schedule, policy and recent runs", async () => {
    const catalog = await makeCatalog();
    await catalog.addRun({
      id: "run-1",
      target: "postgres_core",
      kind: "full",
      engine: "wal-g",
      status: "PASSED",
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      durationMs: 100,
      storageTargets: ["primary-s3"],
    });
    await catalog.addDrill(makeDrillReport("drill-1"));
    const { bundle } = await makeHandler({ catalog });
    const response = await bundle.handler(request("/v1/overview"));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.engineMode).toBe("wal-g");
    expect(body.healthy).toBe(true);
    expect(body.wal).toEqual({
      archiveLagSeconds: 2,
      currentLsn: "0/16B6C50",
      lastArchivedLsn: "0/16B6C00",
      lagBytes: 80,
    });
    expect((body.targets as unknown[]).length).toBe(2);
    expect(body.schedule).toMatchObject({
      fullCron: "0 2 * * 0",
      deltaCron: "0 2 * * 1-6",
      drillCron: "0 4 * * 0",
      fullRetentionDays: 56,
      walRetentionDays: 14,
      alertLagSeconds: 300,
    });
    expect((body.backups as BackupRun[])[0]?.id).toBe("run-1");
    expect((body.latestDrill as { id: string }).id).toBe("drill-1");
    expect((body.drills as unknown[]).length).toBe(1);
  });

  test("POST /v1/backups/trigger returns 202 and completes asynchronously", async () => {
    const seen: Array<{ target: string; kind: string }> = [];
    const engine = new FakeEngine(async (target, kind) => {
      seen.push({ target, kind });
      return { storageTargets: ["primary-s3"], sizeBytes: 1024, startLsn: "0/1", endLsn: "0/2" };
    });
    const { bundle, catalog } = await makeHandler({ engine });
    const response = await bundle.handler(
      request("/v1/backups/trigger", "POST", { target: "postgres_core", kind: "full", requestedBy: "admin" }),
    );
    expect(response.status).toBe(202);
    const body = await json(response);
    expect(typeof body.backupJobId).toBe("string");
    expect(typeof body.acceptedAt).toBe("string");

    await bundle.whenIdle();
    expect(seen).toEqual([{ target: "postgres_core", kind: "full" }]);
    const run = catalog.listRuns(1)[0];
    expect(run?.status).toBe("PASSED");
    expect(run?.storageTargets).toEqual(["primary-s3"]);
    expect(run?.sizeBytes).toBe(1024);
  });

  test("POST /v1/backups/trigger validates target and kind", async () => {
    const { bundle } = await makeHandler();
    expect((await bundle.handler(request("/v1/backups/trigger", "POST", { target: "mysql", kind: "full" }))).status).toBe(400);
    expect((await bundle.handler(request("/v1/backups/trigger", "POST", { target: "all", kind: "weekly" }))).status).toBe(400);
    expect((await bundle.handler(request("/v1/backups/trigger", "POST", {}))).status).toBe(400);
  });

  test("POST /v1/drills/run returns 202 and stores the report under the returned id", async () => {
    const calls: Array<{ id?: string; requestedBy?: string } | undefined> = [];
    const drillRunner = {
      run: async (options?: { id?: string; requestedBy?: string }) => {
        calls.push(options);
        return makeDrillReport(options?.id ?? "unexpected");
      },
    };
    const { bundle, catalog } = await makeHandler({ drillRunner });
    const response = await bundle.handler(request("/v1/drills/run", "POST", { requestedBy: "admin" }));
    expect(response.status).toBe(202);
    const body = await json(response);
    const drillId = body.drillId as string;
    expect(typeof drillId).toBe("string");
    await bundle.whenIdle();
    expect(calls[0]?.id).toBe(drillId);
    expect(catalog.latestDrill()?.id).toBe(drillId);
  });

  test("a rejected drill runner still records a signed FAILED report", async () => {
    const drillRunner = {
      run: async () => {
        throw new Error("drill orchestration exploded");
      },
    };
    const { bundle, catalog } = await makeHandler({ drillRunner });
    const response = await bundle.handler(request("/v1/drills/run", "POST", {}));
    const drillId = (await json(response)).drillId as string;
    await bundle.whenIdle();
    const report = catalog.latestDrill();
    expect(report?.id).toBe(drillId);
    expect(report?.status).toBe("FAILED");
    expect(report?.errorMessage).toContain("drill orchestration exploded");
    expect(report?.reportSignature).toHaveLength(64);
  });

  test("PUT /v1/policy updates scheduling and rejects invalid cron", async () => {
    const { bundle, catalog } = await makeHandler();
    const valid = await bundle.handler(
      request("/v1/policy", "PUT", {
        fullCron: "0 3 * * 0",
        deltaCron: "0 3 * * 1-6",
        drillCron: "0 5 * * 0",
        fullRetentionDays: 60,
        walRetentionDays: 21,
        alertLagSeconds: 120,
        updatedBy: "operator-1",
      }),
    );
    expect(valid.status).toBe(200);
    const updated = (await json(valid)).policy as Record<string, unknown>;
    expect(updated.fullCron).toBe("0 3 * * 0");
    expect(updated.fullRetentionDays).toBe(60);
    expect(updated.updatedAt).toBe(NOW.toISOString());
    expect(catalog.getPolicy().walRetentionDays).toBe(21);

    const invalid = await bundle.handler(
      request("/v1/policy", "PUT", {
        fullCron: "not a cron",
        deltaCron: "0 3 * * 1-6",
        drillCron: "0 5 * * 0",
        fullRetentionDays: 60,
        walRetentionDays: 21,
        alertLagSeconds: 120,
      }),
    );
    expect(invalid.status).toBe(400);
    expect(catalog.getPolicy().fullCron).toBe("0 3 * * 0");
  });

  test("GET /v1/runs and /v1/drills enforce limit validation", async () => {
    const { bundle } = await makeHandler();
    expect((await bundle.handler(request("/v1/runs?limit=10"))).status).toBe(200);
    expect((await bundle.handler(request("/v1/drills?limit=1"))).status).toBe(200);
    expect((await bundle.handler(request("/v1/runs?limit=0"))).status).toBe(400);
    expect((await bundle.handler(request("/v1/runs?limit=abc"))).status).toBe(400);
  });

  test("unknown routes return 404 JSON and wrong methods return 405 JSON", async () => {
    const { bundle } = await makeHandler();
    const missing = await bundle.handler(request("/v1/nope"));
    expect(missing.status).toBe(404);
    const missingBody = await json(missing);
    expect((missingBody.error as { code: string }).code).toBe("not_found");

    const wrongMethod = await bundle.handler(request("/health", "POST"));
    expect(wrongMethod.status).toBe(405);
    expect(((await json(wrongMethod)).error as { code: string }).code).toBe("method_not_allowed");
  });

  test("redacts secrets from overview detail and failed run errors", async () => {
    const engine = new FakeEngine(async () => {
      throw new Error(`backup failed password=${PG_PASSWORD} secret=${S3_SECRET_KEY}`);
    });
    engine.health.targets[0]!.detail = `token=${S3_SECRET_KEY}`;
    const { bundle } = await makeHandler({ engine });

    const overview = await bundle.handler(request("/v1/overview"));
    const overviewText = await overview.text();
    expect(overviewText).not.toContain(S3_SECRET_KEY);
    expect(overviewText).toContain("[REDACTED]");

    await bundle.handler(request("/v1/backups/trigger", "POST", { target: "all", kind: "full" }));
    await bundle.whenIdle();
    const runs = await bundle.handler(request("/v1/runs"));
    const runsText = await runs.text();
    expect(runsText).not.toContain(PG_PASSWORD);
    expect(runsText).not.toContain(S3_SECRET_KEY);
    const body = JSON.parse(runsText) as { runs: BackupRun[] };
    expect(body.runs[0]?.status).toBe("FAILED");
    expect(body.runs[0]?.errorMessage).toContain("[REDACTED]");
  });

  test("engine rejection is recorded as FAILED without crashing the daemon", async () => {
    const engine = new FakeEngine(async () => {
      throw new Error("engine is unavailable");
    });
    const { bundle, catalog } = await makeHandler({ engine });
    expect(
      (await bundle.handler(request("/v1/backups/trigger", "POST", { target: "audit_db", kind: "delta" }))).status,
    ).toBe(202);
    await bundle.whenIdle();
    expect(catalog.listRuns(1)[0]).toMatchObject({ status: "FAILED", errorMessage: "engine is unavailable" });
    expect((await bundle.handler(request("/health"))).status).toBe(200);
  });

  test("catalog write failure does not prevent accepted jobs from being tracked in memory", async () => {
    const catalog = await makeCatalog(new FailingCatalogFileSystem());
    const { bundle } = await makeHandler({ catalog });
    expect(
      (await bundle.handler(request("/v1/backups/trigger", "POST", { target: "postgres_core", kind: "full" }))).status,
    ).toBe(202);
    await bundle.whenIdle();
    expect(catalog.isPersistent()).toBe(false);
    expect(catalog.listRuns(1)[0]?.status).toBe("PASSED");
  });

  test("concurrent triggers get unique ids, are queued FIFO and NEVER run at the same time", async () => {
    const resolvers: Array<(result: BackupExecutionResult) => void> = [];
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const engine = new FakeEngine(
      async (target) =>
        new Promise<BackupExecutionResult>((resolve) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          order.push(target);
          resolvers.push((result) => {
            running -= 1;
            resolve(result);
          });
        }),
    );
    const { bundle, catalog } = await makeHandler({ engine });
    const targets = ["postgres_core", "audit_db", "redis", "postgres_core"] as const;
    const responses = await Promise.all(
      targets.map((target) => bundle.handler(request("/v1/backups/trigger", "POST", { target, kind: "delta" }))),
    );
    const ids = await Promise.all(responses.map(async (response) => (await json(response)).backupJobId as string));
    expect(new Set(ids).size).toBe(4);

    // Only the first job has started; the rest are QUEUED.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolvers).toHaveLength(1);
    expect(catalog.listRuns(10).map((run) => run.status).sort()).toEqual(["QUEUED", "QUEUED", "QUEUED", "RUNNING"]);

    for (let finished = 0; finished < 4; finished += 1) {
      for (let attempt = 0; attempt < 50 && resolvers.length <= finished; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      resolvers[finished]!({ storageTargets: ["primary-s3"] });
    }
    await bundle.whenIdle();
    expect(maxRunning).toBe(1);
    expect(order).toEqual([...targets]);
    expect(catalog.listRuns(30).every((run) => run.status === "PASSED")).toBe(true);
    expect(new Set(catalog.listRuns(30).map((run) => run.id)).size).toBe(4);
  });

  test("a backup and a restore drill share the same queue", async () => {
    let releaseBackup: (() => void) | undefined;
    const engine = new FakeEngine(
      async () => new Promise<BackupExecutionResult>((resolve) => { releaseBackup = () => resolve({ storageTargets: [] }); }),
    );
    let drillStarted = false;
    const { bundle } = await makeHandler({
      engine,
      drillRunner: { run: async (options) => { drillStarted = true; return makeDrillReport(options?.id ?? "d"); } },
    });
    await bundle.handler(request("/v1/backups/trigger", "POST", { target: "all", kind: "full" }));
    const drill = await bundle.handler(request("/v1/drills/run", "POST", {}));
    expect(drill.status).toBe(202);
    expect((await json(drill)).queuePosition).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drillStarted).toBe(false);
    releaseBackup!();
    await bundle.whenIdle();
    expect(drillStarted).toBe(true);
  });

  test("Idempotency-Key: a retried trigger returns the SAME job and never starts a second backup", async () => {
    const { bundle, catalog, engine } = await makeHandler();
    const send = () =>
      bundle.handler(new Request("http://127.0.0.1:4090/v1/backups/trigger", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "click-1" },
        body: JSON.stringify({ target: "postgres_core", kind: "full" }),
      }));
    const first = await send();
    const retry = await send();
    const concurrent = await Promise.all([send(), send()]);
    const firstBody = await json(first);
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    for (const response of [retry, ...concurrent]) {
      expect(await json(response)).toMatchObject({ backupJobId: firstBody.backupJobId, deduplicated: true });
    }
    await bundle.whenIdle();
    expect(engine.triggerCalls).toHaveLength(1);
    expect(catalog.listRuns(10)).toHaveLength(1);

    const other = await bundle.handler(new Request("http://127.0.0.1:4090/v1/backups/trigger", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "click-2" },
      body: JSON.stringify({ target: "postgres_core", kind: "full" }),
    }));
    expect((await json(other)).backupJobId).not.toBe(firstBody.backupJobId);
    await bundle.whenIdle();
    expect(engine.triggerCalls).toHaveLength(2);
  });

  test("the same Idempotency-Key is scoped per route (a backup key does not swallow a drill)", async () => {
    const { bundle } = await makeHandler();
    const headers = { "content-type": "application/json", "idempotency-key": "shared-key-1" };
    const backup = await bundle.handler(new Request("http://x/v1/backups/trigger", { method: "POST", headers, body: JSON.stringify({ target: "all", kind: "full" }) }));
    const drill = await bundle.handler(new Request("http://x/v1/drills/run", { method: "POST", headers, body: "{}" }));
    expect((await json(backup)).deduplicated).toBeUndefined();
    expect((await json(drill)).deduplicated).toBeUndefined();
    await bundle.whenIdle();
  });

  test("malformed Idempotency-Key is rejected with 400", async () => {
    const { bundle } = await makeHandler();
    const response = await bundle.handler(new Request("http://x/v1/backups/trigger", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "bad key with spaces!" },
      body: JSON.stringify({ target: "all", kind: "full" }),
    }));
    expect(response.status).toBe(400);
    expect(((await json(response)).error as { code: string }).code).toBe("invalid_idempotency_key");
  });

  test("a full queue answers 429 and the rejected request leaves a FAILED row, not a phantom QUEUED one", async () => {
    let release: (() => void) | undefined;
    const engine = new FakeEngine(async () => new Promise<BackupExecutionResult>((resolve) => { release = () => resolve({ storageTargets: [] }); }));
    const { bundle, catalog } = await makeHandler({ engine, jobs: new JobQueue({ maxQueued: 1 }) });
    const post = () => bundle.handler(request("/v1/backups/trigger", "POST", { target: "all", kind: "delta" }));
    expect((await post()).status).toBe(202); // starts running
    expect((await post()).status).toBe(202); // waits (1 queued)
    const rejected = await post();
    expect(rejected.status).toBe(429);
    expect(catalog.listRuns(10).filter((run) => run.status === "FAILED")).toHaveLength(1);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release!();
    await bundle.whenIdle();
  });

  test("drill accepts latest:true (disaster-recovery rehearsal) but not together with targetTime", async () => {
    let received: { latest?: boolean; targetTime?: Date } | undefined;
    const { bundle } = await makeHandler({
      drillRunner: { run: async (options) => { received = options; return makeDrillReport(options?.id ?? "d"); } },
    });
    expect((await bundle.handler(request("/v1/drills/run", "POST", { latest: true }))).status).toBe(202);
    await bundle.whenIdle();
    expect(received).toMatchObject({ latest: true });
    expect(received?.targetTime).toBeUndefined();
    const both = await bundle.handler(request("/v1/drills/run", "POST", { latest: true, targetTime: "2026-11-03T11:30:00.000Z" }));
    expect(both.status).toBe(400);
    expect(JSON.stringify(await json(both))).toContain("mutually exclusive");
    // latest:false behaves like omitting it
    await bundle.handler(request("/v1/drills/run", "POST", { latest: false }));
    await bundle.whenIdle();
    expect(received?.latest).toBeUndefined();
  });

  test("drill accepts an explicit targetTime and rejects a future or invalid one", async () => {
    let received: Date | undefined;
    const { bundle } = await makeHandler({
      drillRunner: { run: async (options) => { received = options?.targetTime; return makeDrillReport(options?.id ?? "d"); } },
    });
    const ok = await bundle.handler(request("/v1/drills/run", "POST", { targetTime: "2026-11-03T11:30:00.000Z" }));
    expect(ok.status).toBe(202);
    await bundle.whenIdle();
    expect(received?.toISOString()).toBe("2026-11-03T11:30:00.000Z");
    expect((await bundle.handler(request("/v1/drills/run", "POST", { targetTime: "2026-11-04T00:00:00.000Z" }))).status).toBe(400);
    expect((await bundle.handler(request("/v1/drills/run", "POST", { targetTime: "yesterday-ish" }))).status).toBe(400);
  });
});

describe("WAL upload route and caller roles", () => {
  const walRequest = (path: string, body: string, method = "PUT") =>
    new Request(`http://x${path}`, { method, body, headers: { "content-length": String(Buffer.byteLength(body)) } });

  const withWalEngine = async () => {
    const calls: Array<{ target: string; file: string; bytes: number }> = [];
    const engine = new FakeEngine();
    (engine as unknown as { ingestWal: unknown }).ingestWal = async (target: string, file: string, body: import("node:stream").Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      calls.push({ target, file, bytes: Buffer.concat(chunks).length });
      return { status: "stored", key: `wal/${target}/${file}.zst.enc`, bytes: Buffer.concat(chunks).length };
    };
    const { bundle } = await makeHandler({ engine });
    return { bundle, calls };
  };

  test("PUT /v1/wal/:target/:file streams the body to the engine", async () => {
    const { bundle, calls } = await withWalEngine();
    const response = await bundle.handler(walRequest("/v1/wal/postgres_core/000000010000000000000001", "x".repeat(1000)));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ status: "stored", bytes: 1000 });
    expect(calls).toEqual([{ target: "postgres_core", file: "000000010000000000000001", bytes: 1000 }]);
  });

  test("a non-PUT method and an engine without WAL support are refused", async () => {
    const { bundle } = await withWalEngine();
    expect((await bundle.handler(walRequest("/v1/wal/postgres_core/000000010000000000000001", "x", "POST"))).status).toBe(405);
    const { bundle: plain } = await makeHandler();
    const response = await plain.handler(walRequest("/v1/wal/postgres_core/000000010000000000000001", "x"));
    expect(response.status).toBe(501);
    expect(((await json(response)).error as { code: string }).code).toBe("wal_push_not_supported");
  });

  test("the WAL client role can ONLY upload WAL; the control role can do everything EXCEPT upload WAL", async () => {
    const { bundle } = await withWalEngine();
    const wal = bundle.handlerFor("wal");
    const control = bundle.handlerFor("control");
    expect((await wal(request("/v1/overview"))).status).toBe(403);
    expect((await wal(request("/v1/policy", "PUT", {}))).status).toBe(403);
    expect((await wal(request("/v1/backups/trigger", "POST", { target: "all", kind: "full" }))).status).toBe(403);
    expect((await wal(walRequest("/v1/wal/postgres_core/000000010000000000000001", "x"))).status).toBe(200);

    expect((await control(request("/v1/overview"))).status).toBe(200);
    expect((await control(walRequest("/v1/wal/postgres_core/000000010000000000000001", "x"))).status).toBe(403);
  });

  test("a client that disconnects mid-upload is not logged as a server failure", async () => {
    const logged: unknown[] = [];
    const engine = new FakeEngine();
    (engine as unknown as { ingestWal: unknown }).ingestWal = async () => {
      throw new DOMException("The connection was closed.", "AbortError");
    };
    const catalog = await makeCatalog();
    const bundle = createBackupDaemonHandler({
      config: makeConfig(),
      engine,
      drillRunner: { run: async () => makeDrillReport("d") },
      catalog,
      logger: { info: () => undefined, warn: () => undefined, error: (...args: unknown[]) => { logged.push(args); } },
    });
    const response = await bundle.handler(walRequest("/v1/wal/postgres_core/000000010000000000000001", "segment"));
    expect(response.status).toBe(499);
    expect(logged).toEqual([]);
    // a genuine failure is still logged and answered 500
    (engine as unknown as { ingestWal: unknown }).ingestWal = async () => { throw new Error("disk exploded"); };
    const failure = await bundle.handler(walRequest("/v1/wal/postgres_core/000000010000000000000002", "segment"));
    expect(failure.status).toBe(500);
    expect(logged).toHaveLength(1);
  });

  test("rejects an upload with no body", async () => {
    const { bundle } = await withWalEngine();
    const response = await bundle.handler(new Request("http://x/v1/wal/postgres_core/000000010000000000000001", { method: "PUT" }));
    expect(response.status).toBe(400);
  });
});

describe("transport security", () => {
  test("plain HTTP is refused unless explicitly enabled", async () => {
    const secureConfig = makeConfig();
    await expect(loadTlsOptions(secureConfig)).rejects.toThrow("TLS requires");
    const insecure = makeConfig({ BACKUP_ALLOW_INSECURE_HTTP: "true" });
    expect(await loadTlsOptions(insecure)).toBeUndefined();
  });

  test("TLS requires the CA as well as the server certificate pair", async () => {
    const missingCa = makeConfig({
      BACKUP_DAEMON_CERT_PATH: "/certs/server.crt",
      BACKUP_DAEMON_KEY_PATH: "/certs/server.key",
    });
    await expect(loadTlsOptions(missingCa, async () => "PEM")).rejects.toThrow("CA_CERT_PATH");
  });

  test("mTLS requires client certificates when a CA is configured", async () => {
    const config = makeConfig({
      BACKUP_DAEMON_CERT_PATH: "/certs/server.crt",
      BACKUP_DAEMON_KEY_PATH: "/certs/server.key",
      BACKUP_DAEMON_CA_CERT_PATH: "/certs/ca.crt",
    });
    const read = async (path: string): Promise<string> => `PEM:${path}`;
    const tls = await loadTlsOptions(config, read);
    expect(tls).toMatchObject({
      cert: "PEM:/certs/server.crt",
      key: "PEM:/certs/server.key",
      ca: "PEM:/certs/ca.crt",
      requestCert: true,
      rejectUnauthorized: true,
    });
    expect(useEncryptionKey()).toBe(ENCRYPTION_KEY_HEX.length);
  });
});

const useEncryptionKey = (): number => ENCRYPTION_KEY_HEX.length;
