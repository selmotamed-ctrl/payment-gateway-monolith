import { describe, expect, test } from "bun:test";
import { CatalogStore, createDefaultPolicy, type BackupRun, type CatalogFileSystem } from "../src/catalogStore";
import type { BackupExecutionResult } from "../src/backupEngine";
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
  drillRunner?: { run: (options?: { id?: string; requestedBy?: string }) => Promise<ReturnType<typeof makeDrillReport>> };
  idFactory?: () => string;
} = {}): Promise<{ bundle: HandlerBundle; catalog: CatalogStore; engine: FakeEngine }> => {
  const catalog = options.catalog ?? (await makeCatalog());
  const engine = options.engine ?? new FakeEngine();
  let drillCounter = 0;
  const drillRunner =
    options.drillRunner ??
    {
      run: async (runOptions?: { id?: string; requestedBy?: string }) => {
        drillCounter += 1;
        return makeDrillReport(runOptions?.id ?? `drill-${drillCounter}`);
      },
    };
  let idCounter = 0;
  const bundle = createBackupDaemonHandler({
    config: makeConfig(),
    engine,
    drillRunner,
    catalog,
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

  test("concurrent triggers receive unique ids and all complete", async () => {
    const resolvers: Array<(result: BackupExecutionResult) => void> = [];
    const engine = new FakeEngine(
      async () =>
        new Promise<BackupExecutionResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { bundle, catalog } = await makeHandler({ engine });
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        bundle.handler(request("/v1/backups/trigger", "POST", { target: "postgres_core", kind: "delta" })),
      ),
    );
    const ids = await Promise.all(
      responses.map(async (response) => (await json(response)).backupJobId as string),
    );
    expect(new Set(ids).size).toBe(12);

    for (let attempt = 0; attempt < 50 && resolvers.length < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(resolvers).toHaveLength(12);
    for (const resolve of resolvers) resolve({ storageTargets: ["primary-s3"] });
    await bundle.whenIdle();
    expect(catalog.listRuns(30).every((run) => run.status === "PASSED")).toBe(true);
    expect(new Set(catalog.listRuns(30).map((run) => run.id)).size).toBe(12);
  });
});

describe("transport security", () => {
  test("plain HTTP is refused unless explicitly enabled", async () => {
    const secureConfig = makeConfig();
    await expect(loadTlsOptions(secureConfig)).rejects.toThrow("TLS requires");
    const insecure = makeConfig({ BACKUP_ALLOW_INSECURE_HTTP: "true" });
    expect(await loadTlsOptions(insecure)).toBeUndefined();
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
