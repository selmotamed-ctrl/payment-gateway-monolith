/**
 * LIVE integration test: real PostgreSQL (17+) binaries, the real daemon over real mTLS,
 * `curl` as archive_command, `pg_receivewal` streaming, real encrypted artifacts and real
 * restore drills with point-in-time recovery and fault injection.
 *
 * It skips (loudly) when the PostgreSQL client/server binaries, zstd, curl, tar or openssl are missing.
 * Everything runs in a private throwaway cluster under /tmp (Unix socket paths are limited to
 * 107 bytes, so paths are deliberately short) on free ports; nothing touches a real database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as nodeFs } from "node:fs";
import https from "node:https";
import net from "node:net";
import { dirname, join } from "node:path";
import { ArtifactRepository, LocalRepoStore, MemoryArtifactStore } from "../src/artifactStore";
import { CatalogStore, createDefaultPolicy } from "../src/catalogStore";
import { SpawnCommandRunner } from "../src/commandRunner";
import { PgNativeEngine } from "../src/pgNativeEngine";
import { RestoreDrillRunner, verifyDrillReportSignature, type DrillReport } from "../src/restoreDrillRunner";
import { startBackupDaemonServer, type RunningBackupDaemonServer } from "../src/server";
import { ENCRYPTION_KEY_HEX, MemoryCatalogFileSystem, makeConfig } from "./helpers";
import { LEDGER_SCHEMA, auditRows } from "./lab/ledgerFixtures";

const which = (binary: string): string | null => {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
const REQUIRED = ["initdb", "pg_ctl", "pg_basebackup", "pg_verifybackup", "pg_combinebackup", "pg_dump", "pg_restore", "pg_receivewal", "psql", "zstd", "curl", "tar", "openssl"];
const missing = REQUIRED.filter((binary) => which(binary) === null);
const pgMajor = (() => {
  const out = spawnSync("postgres", ["--version"], { encoding: "utf8" }).stdout ?? "";
  return Number(/(\d+)(?:\.\d+)?\s*$/.exec(out.trim())?.[1] ?? 0);
})();
const canRun = missing.length === 0 && pgMajor >= 17;
if (!canRun) {
  console.warn(`[live-pg18-pitr] SKIPPED: missing binaries [${missing.join(", ")}] or PostgreSQL ${pgMajor} < 17`);
}
const suite = canRun ? describe : describe.skip;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async <T>(label: string, produce: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = await produce();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
};

interface Env {
  root: string;
  pgBin: string;
  pgPort: number;
  daemonPort: number;
  scratchPort: number;
  repoDir: string;
  server: RunningBackupDaemonServer;
  engine: PgNativeEngine;
  local: LocalRepoStore;
  s3: MemoryArtifactStore;
  catalog: CatalogStore;
  agent: https.Agent;
  psql: (sql: string, database?: string) => string;
  savedEnv: Record<string, string | undefined>;
}

let env: Env;
/** Set as soon as the sandbox exists so afterAll can clean up even when beforeAll fails half way. */
let sandbox: { root: string; pgBin: string } | undefined;

const api = <T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: T }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(
      {
        host: "127.0.0.1",
        port: env.daemonPort,
        servername: "localhost",
        path,
        method,
        agent: env.agent,
        headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T }));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });

interface RunRow {
  id: string;
  status: string;
  storageTargets: string[];
  errorMessage?: string;
  endLsn?: string;
}

const runBackup = async (kind: "full" | "delta"): Promise<RunRow> => {
  const accepted = await api<{ backupJobId: string }>("/v1/backups/trigger", "POST", { target: "all", kind });
  expect(accepted.status).toBe(202);
  const id = accepted.json.backupJobId;
  return waitFor(`backup ${id}`, async () => {
    const runs = (await api<{ runs: RunRow[] }>("/v1/runs?limit=50")).json.runs;
    const run = runs.find((candidate) => candidate.id === id);
    return run && (run.status === "PASSED" || run.status === "FAILED") ? run : null;
  }, 180_000);
};

const runDrill = async (targetTime: string): Promise<DrillReport> => runDrillWith({ targetTime });

const runDrillWith = async (body: { targetTime?: string; latest?: boolean }): Promise<DrillReport> => {
  const accepted = await api<{ drillId: string }>("/v1/drills/run", "POST", body);
  expect(accepted.status).toBe(202);
  const id = accepted.json.drillId;
  return waitFor(`drill ${id}`, async () => {
    const drills = (await api<{ drills: DrillReport[] }>("/v1/drills?limit=50")).json.drills;
    return drills.find((candidate) => candidate.id === id) ?? null;
  }, 240_000);
};

/** A timestamp taken strictly after the preceding commit; recovery targets use it. */
const mark = async (): Promise<string> => {
  await sleep(1200);
  return env.psql(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`);
};

/** Commits something AFTER the mark, switches WAL and waits until that segment is archived. */
const tail = async (): Promise<void> => {
  await sleep(1200);
  env.psql("INSERT INTO heartbeat DEFAULT VALUES;");
  const segment = env.psql("SELECT pg_walfile_name(pg_current_wal_lsn());");
  env.psql("SELECT pg_switch_wal();");
  const key = `wal/postgres_core/${segment}.zst.enc`;
  await waitFor(`WAL segment ${segment} to be archived`, () => env.local.exists(key), 60_000);
};

const generateCerts = (dir: string): void => {
  const run = (args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${result.stderr}`);
  };
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Test CA"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  for (const name of ["server", "backup-client", "wal-archive-client"]) {
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
    run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", "ext.cnf"]);
  }
};

suite("live PostgreSQL PITR: backup -> WAL -> restore drill -> fault injection", () => {
  beforeAll(async () => {
    const root = mkdtempSync("/tmp/bdpg-");
    const pgBin = dirname(which("pg_ctl")!);
    sandbox = { root, pgBin };
    const pgPort = await freePort();
    const daemonPort = await freePort();
    const scratchPort = await freePort();
    const certs = join(root, "certs");
    mkdirSync(certs);
    generateCerts(certs);

    const run = (command: string, args: string[], allowFail = false): string => {
      const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, PGSSLMODE: "disable" } });
      if (result.status !== 0 && !allowFail) throw new Error(`${command} ${args.join(" ").slice(0, 200)} failed: ${result.stderr || result.stdout}`);
      return (result.stdout ?? "").trim();
    };
    const psql = (sql: string, database = "payment_gateway_prod"): string =>
      run(join(pgBin, "psql"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", "-d", database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql]);

    // --- the primary: Debian-style (configuration OUTSIDE PGDATA), archiving applied with ALTER SYSTEM like the provisioner does
    const data = join(root, "data");
    const conf = join(root, "conf");
    mkdirSync(conf);
    run(join(pgBin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "-E", "UTF8"]);
    for (const file of ["postgresql.conf", "pg_hba.conf", "pg_ident.conf"]) {
      await nodeFs.rename(join(data, file), join(conf, file));
    }
    mkdirSync(join(root, "sock"));
    writeFileSync(
      join(conf, "postgresql.conf"),
      [
        `data_directory = '${data}'`,
        `hba_file = '${join(conf, "pg_hba.conf")}'`,
        `ident_file = '${join(conf, "pg_ident.conf")}'`,
        `port = ${pgPort}`,
        "listen_addresses = '127.0.0.1'",
        `unix_socket_directories = '${join(root, "sock")}'`,
        "max_connections = 150", // non-default on purpose: the scratch cluster must be sized from pg_controldata
        "wal_level = replica",
        "summarize_wal = on",
        "max_wal_senders = 10",
        "max_replication_slots = 10",
        "fsync = off",
        "full_page_writes = off",
        "",
      ].join("\n"),
    );

    // The daemon (and the secrets it needs in its environment, which the scratch cluster's restore_command inherits).
    const repoDir = join(root, "repo");
    const daemonEnv: Record<string, string> = {
      BACKUP_ENGINE_MODE: "pg-native",
      BACKUP_ENCRYPTION_KEY_HEX: ENCRYPTION_KEY_HEX,
      BACKUP_PRIMARY_S3_ENDPOINT: "",
      BACKUP_PRIMARY_S3_BUCKET: "",
      BACKUP_PRIMARY_S3_ACCESS_KEY: "",
      BACKUP_PRIMARY_S3_SECRET_KEY: "",
      BACKUP_LOCAL_REPO_DIR: repoDir,
      BACKUP_STAGING_DIR: join(root, "staging"),
      BACKUP_WAL_SPOOL_DIR: join(root, "spool"),
      BACKUP_CATALOG_PATH: join(root, "state", "catalog.json"),
      BACKUP_SCRATCH_DIR: join(root, "scratch"),
      BACKUP_SCRATCH_PORT: String(scratchPort),
      PG_BIN_DIR: pgBin,
      PG_PRIMARY_HOST: "127.0.0.1",
      PG_PRIMARY_PORT: String(pgPort),
      PG_PRIMARY_USER: "postgres",
      PG_PRIMARY_PASSWORD: "",
      PG_AUDIT_USER: "audit_app",
      PG_SSLMODE: "disable",
      BACKUP_ALLOW_INSECURE_HTTP: "false",
      BACKUP_DAEMON_BIND_HOST: "127.0.0.1",
      BACKUP_DAEMON_PORT: String(daemonPort),
      BACKUP_DAEMON_CERT_PATH: join(certs, "server.crt"),
      BACKUP_DAEMON_KEY_PATH: join(certs, "server.key"),
      BACKUP_DAEMON_CA_CERT_PATH: join(certs, "ca.crt"),
      BACKUP_COMMAND_TIMEOUT_MS: "170000",
      BACKUP_RECOVERY_TIMEOUT_MS: "120000",
      SCHEDULER_ENABLED: "false",
    };
    const savedEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(daemonEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    const config = makeConfig(daemonEnv);

    const runner = new SpawnCommandRunner({ defaultTimeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS });
    const local = new LocalRepoStore(repoDir);
    const s3 = new MemoryArtifactStore("primary-s3", "S3 (in-memory stand-in)", "s3");
    const catalog = await CatalogStore.load({
      path: config.BACKUP_CATALOG_PATH,
      defaultPolicy: createDefaultPolicy({ updatedAt: new Date().toISOString() }),
      fileSystem: new MemoryCatalogFileSystem(),
    });
    const engine = new PgNativeEngine(config, runner, {
      repository: new ArtifactRepository([local, s3]),
      getPolicy: () => catalog.getPolicy(),
      logger: console,
    });
    const drillRunner = new RestoreDrillRunner({ config, engine, runner });
    const server = await startBackupDaemonServer({ config, engine, drillRunner, catalog });
    await engine.start();

    // archive_command is the REAL one: curl over mutual TLS with the least-privilege WAL client certificate.
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(root, "pg.log"), "-o", `-c config_file=${join(conf, "postgresql.conf")}`, "-w", "start"]);
    const archiveCommand = [
      "curl --fail --silent --show-error --max-time 60",
      `--cacert ${join(certs, "ca.crt")} --cert ${join(certs, "wal-archive-client.crt")} --key ${join(certs, "wal-archive-client.key")}`,
      `--upload-file %p https://127.0.0.1:${daemonPort}/v1/wal/postgres_core/%f`,
    ].join(" ");
    // Exactly what the provisioner does: ALTER SYSTEM (which lands in PGDATA/postgresql.auto.conf and is therefore
    // INSIDE every physical backup), then a restart because archive_mode is a postmaster setting.
    psql(`ALTER SYSTEM SET archive_command = $q$${archiveCommand}$q$`, "postgres");
    psql("ALTER SYSTEM SET archive_mode = on", "postgres");
    run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(root, "pg.log"), "-o", `-c config_file=${join(conf, "postgresql.conf")}`, "-w", "restart"]);

    psql("CREATE DATABASE payment_gateway_prod;", "postgres");
    psql("CREATE DATABASE pg_audit_db;", "postgres");
    // The audit database is reached as the deployment's LEAST-PRIVILEGE runtime role (SELECT/INSERT on audit_records and
    // nothing else), exactly as in production, for both the logical dump and the drill's chain verification.
    psql("CREATE ROLE audit_app LOGIN;", "postgres");
    psql(LEDGER_SCHEMA);
    // The provisioner's real DDL (trigger, verify_audit_chain, immutability), applied the way a deployment does.
    const provisioner = (await import(join(import.meta.dir, "../../provisioners/auditAndLogDbProvisioner.ts"))) as {
      auditDatabaseDdl: (config: { AUDIT_DB_USER: string }) => string;
    };
    const auditDdl = provisioner.auditDatabaseDdl({ AUDIT_DB_USER: "audit_app" });
    expect(auditDdl).toContain("compute_audit_chain_hash_trg");
    psql(auditDdl, "pg_audit_db");

    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      minVersion: "TLSv1.3",
      ca: readFileSync(join(certs, "ca.crt")),
      cert: readFileSync(join(certs, "backup-client.crt")),
      key: readFileSync(join(certs, "backup-client.key")),
    });
    env = { root, pgBin, pgPort, daemonPort, scratchPort, repoDir, server, engine, local, s3, catalog, agent, psql, savedEnv };
  }, 180_000);

  afterAll(async () => {
    if (env) {
      env.agent.destroy();
      try {
        await env.engine.stop();
      } catch {
        /* best effort */
      }
      env.server.stop(true);
      for (const [key, value] of Object.entries(env.savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    if (sandbox) {
      // Stop exactly the instances this test started, then remove exactly its own directory.
      for (const dir of ["data", "scratch"]) {
        spawnSync(join(sandbox.pgBin, "pg_ctl"), ["-D", join(sandbox.root, dir), "-m", "immediate", "stop"], { stdio: "ignore" });
      }
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  // Marks and expectations shared across the ordered tests below.
  const t: { tA?: string; tC?: string; linesAtA?: number; linesAtC?: number; fullId?: string; deltaId?: string } = {};

  test("the audit role really is least-privilege (cannot read the ledger, cannot update or delete audit rows)", () => {
    const asAudit = (sql: string, database: string) =>
      spawnSync(join(env.pgBin, "psql"), ["-h", "127.0.0.1", "-p", String(env.pgPort), "-U", "audit_app", "-d", database, "-X", "-A", "-t", "-c", sql], { encoding: "utf8", env: { ...process.env, PGSSLMODE: "disable" } });
    expect(asAudit("SELECT count(*) FROM audit_records", "pg_audit_db").status).toBe(0);
    expect(asAudit("DELETE FROM audit_records", "pg_audit_db").status).not.toBe(0);
    expect(asAudit("SELECT count(*) FROM journal_lines", "payment_gateway_prod").status).not.toBe(0);
  });

  test("T1: seed a balanced 1000.0000 LYD ledger across 16 shards and 50 chained audit rows", () => {
    env.psql("SELECT post_balanced(1000.0000);");
    env.psql(auditRows(1, 50), "pg_audit_db");
    expect(env.psql("SELECT count(*) FROM journal_lines;")).toBe("32");
    expect(env.psql("SELECT count(*) FROM audit_records;", "pg_audit_db")).toBe("50");
    expect(env.psql("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM journal_lines;")).toMatch(/^0(\.0+)?$/);
  });

  test("the audit trigger really hashes JSONB TEXT (the reason the old drill failed on real data)", () => {
    const row = env.psql("SELECT before_json::text FROM audit_records WHERE seq_no = 1;", "pg_audit_db");
    expect(row).toContain('"status": "old"'); // PostgreSQL's JSONB text has a space after the colon...
    expect(row).not.toBe(JSON.stringify(JSON.parse(row))); // ...which JSON.stringify never produces
    expect(env.psql("SELECT valid FROM verify_audit_chain();", "pg_audit_db")).toBe("t");
  });

  test("FULL backup of all targets: verified, encrypted, signed and stored on every tier", async () => {
    const run = await runBackup("full");
    expect(run.errorMessage).toBeUndefined();
    expect(run.status).toBe("PASSED");
    expect(run.storageTargets).toEqual(expect.arrayContaining(["local-repo", "primary-s3"]));
    t.fullId = run.id;

    const keys = await env.local.list("");
    const manifestKey = keys.find((key) => key.startsWith("backups/postgres_core/") && key.endsWith(".manifest.json"))!;
    expect(manifestKey).toBeDefined();
    const manifest = JSON.parse((await env.local.getBuffer(manifestKey))!.toString("utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 2, target: "postgres_core", kind: "full", engine: "pg-native", clusterTopology: "shared-audit" });
    expect(manifest.pgVerifyBackup).toMatchObject({ verified: true, manifestChecksumAlgorithm: "SHA256" });
    expect(manifest.startLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    expect(manifest.walSegmentStart).toMatch(/^[0-9A-F]{24}$/);
    expect(manifest.signature).toMatch(/^[0-9a-f]{64}$/);
    // logical dumps of BOTH databases, plus the standalone audit manifest
    expect(keys.some((key) => key.startsWith("logical/payment_gateway_prod/") && key.endsWith(".dump.enc"))).toBe(true);
    expect(keys.some((key) => key.startsWith("logical/pg_audit_db/") && key.endsWith(".dump.enc"))).toBe(true);
    expect(keys.some((key) => key.startsWith("backups/audit_db/") && key.endsWith(".manifest.json"))).toBe(true);
    // artifacts are ciphertext: no PostgreSQL tar magic or plaintext SQL names visible
    const artifact = (await env.local.getBuffer(`backups/postgres_core/${manifest.backupId}.tar.zst.enc`))!;
    expect(artifact.subarray(0, 6).toString("ascii")).toBe("PGBKv2");
    expect(artifact.includes(Buffer.from("PG_VERSION"))).toBe(false);
    // and mirrored to the second tier
    expect(env.s3.objects.has(`backups/postgres_core/${manifest.backupId}.tar.zst.enc`)).toBe(true);
  }, 240_000);

  test("T2 + T3: 500 more LYD and 25 more audit rows, then an operator error AFTER the safe point", async () => {
    env.psql("SELECT post_balanced(500.0000);");
    env.psql(auditRows(51, 75), "pg_audit_db");
    t.linesAtA = Number(env.psql("SELECT count(*) FROM journal_lines;"));
    expect(t.linesAtA).toBe(64);
    t.tA = await mark();
    // T3: an unbalanced +777 DEBIT (an "operator error") committed AFTER tA
    await sleep(1200);
    env.psql("SELECT post_line('A', 'DEBIT', 777.0000);");
    await tail();
    expect(env.psql("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM journal_lines;")).toMatch(/^777/);
  }, 120_000);

  test("DRILL #1 (full backup + WAL replay to tA): recovers T1+T2, EXCLUDES T3, all invariants hold, report is signed", async () => {
    const report = await runDrill(t.tA!);
    expect(report.errorMessage).toBeUndefined();
    expect(report.status).toBe("PASSED");
    expect(Number(report.doubleEntryDrift)).toBe(0); // T3's +777 is NOT in the restored state
    expect(report.balanceMismatches).toBe(0);
    expect(report.auditBrokenLinks).toBe(0);
    expect(report.journalLineCount).toBe(t.linesAtA!); // 64 = 32 (T1) + 32 (T2)
    expect(report.checks.doubleEntry.ok && report.checks.balanceParity.ok && report.checks.auditChain.ok).toBe(true);
    expect(report.checks.auditChain.detail).toContain("verified 75 audit rows");
    expect(report.targetTime).toBe(new Date(t.tA!).toISOString());
    expect(report.replayedLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    expect(verifyDrillReportSignature(report, ENCRYPTION_KEY_HEX)).toBe(true);
  }, 300_000);

  test("the drill cannot have written into the production archive, and it cleans up after itself", async () => {
    const wal = await env.local.list("wal/postgres_core");
    // A promoted scratch cluster would create timeline 2 (00000002...). Archiving is forced off there.
    expect(wal.filter((key) => /\/00000002/.test(key))).toEqual([]);
    await expect(nodeFs.access(join(env.root, "scratch"))).rejects.toThrow();
    // exactly one cluster listening on the scratch port is not left behind
    const probe = spawnSync(join(env.pgBin, "psql"), ["-h", "127.0.0.1", "-p", String(env.scratchPort), "-U", "postgres", "-d", "postgres", "-c", "select 1"], { encoding: "utf8" });
    expect(probe.status).not.toBe(0);
  });

  test("continuous WAL: pg_receivewal is streaming and nothing is stuck in the conflicts quarantine", async () => {
    const status = (env.engine.walStatus() as { streams: Array<{ running: boolean; target: string }>; conflicts: number; received: number; duplicates: number });
    expect(status.streams[0]).toMatchObject({ target: "postgres_core", running: true });
    expect(status.conflicts).toBe(0);
    expect(status.received + status.duplicates).toBeGreaterThan(0);
    const quarantine = await nodeFs.readdir(join(env.root, "spool", "postgres_core", "conflicts")).catch(() => []);
    expect(quarantine).toEqual([]);
    // archived_count proves archive_command (curl over mTLS) is delivering, not just the streamer
    expect(Number(env.psql("SELECT archived_count FROM pg_stat_archiver;"))).toBeGreaterThan(0);
    expect(Number(env.psql("SELECT failed_count FROM pg_stat_archiver;"))).toBe(0);
  });

  test("overview WAL health no longer errors: real 24-char segment name, lag computed without pg_wal_lsn_diff", async () => {
    const overview = await api<{ wal: { lastArchivedLsn: string; currentLsn: string; archiveLagSeconds: number; lagBytes: number }; targets: Array<{ id: string; healthy: boolean; detail: string }> }>("/v1/overview");
    expect(overview.json.wal.lastArchivedLsn).toMatch(/^[0-9A-F]{24}$/);
    expect(overview.json.wal.currentLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    expect(overview.json.targets.find((target) => target.id === "local-repo")).toMatchObject({ healthy: true });
    expect(overview.json.targets.find((target) => target.id === "postgres-primary")).toMatchObject({ healthy: true });
    expect(overview.json.targets.find((target) => target.id === "wal-stream-postgres_core")).toMatchObject({ healthy: true });
    // the stream target now says how far behind it is, read from the primary's replication slot
    expect(overview.json.targets.find((target) => target.id === "wal-stream-postgres_core")!.detail).toMatch(/\d+\.\d MiB behind the primary/);
  });

  test("compensate T3, then DELTA (incremental) backup against the full", async () => {
    env.psql("SELECT post_line('A', 'CREDIT', 777.0000);"); // brings the ledger back to zero drift
    const run = await runBackup("delta");
    expect(run.errorMessage).toBeUndefined();
    expect(run.status).toBe("PASSED");
    t.deltaId = run.id;
    const manifests = await env.engine.listManifests("postgres_core");
    const delta = manifests.find((manifest) => manifest.kind === "delta")!;
    const full = manifests.find((manifest) => manifest.kind === "full")!;
    expect(delta.parentBackupId).toBe(full.backupId);
    expect(delta.compressedBytes).toBeLessThan(full.compressedBytes); // only changed blocks
  }, 240_000);

  test("DRILL #2 (full + delta chain combined with pg_combinebackup, then WAL replay) passes", async () => {
    env.psql("SELECT post_balanced(100.0000);");
    env.psql(auditRows(76, 80), "pg_audit_db");
    t.linesAtC = Number(env.psql("SELECT count(*) FROM journal_lines;"));
    t.tC = await mark();
    await tail();
    const report = await runDrill(t.tC);
    expect(report.errorMessage).toBeUndefined();
    expect(report.status).toBe("PASSED");
    expect(Number(report.doubleEntryDrift)).toBe(0);
    expect(report.journalLineCount).toBe(t.linesAtC!);
    expect(report.checks.auditChain.detail).toContain("verified 80 audit rows");
    const chain = await env.engine.resolveChain("postgres_core", new Date(t.tC!));
    expect(chain.map((manifest) => manifest.kind)).toEqual(["full", "delta"]);
  }, 300_000);

  test("ZERO RPO: rows committed AFTER the last WAL switch are recovered from the streamed partial segment (latest drill)", async () => {
    // Nothing below is ever archived by archive_command: no segment switch happens after these commits.
    env.psql("SELECT post_balanced(10.0000);");
    const expected = Number(env.psql("SELECT count(*) FROM journal_lines;"));
    const lastSegment = env.psql("SELECT pg_walfile_name(pg_current_wal_lsn());");
    await waitFor("pg_receivewal to flush the commits", () => env.psql("SELECT COALESCE(bool_and(flush_lsn >= pg_current_wal_lsn()), false) FROM pg_stat_replication WHERE application_name = 'pg-backup-daemon' AND state = 'streaming';") === "t", 30_000);
    expect(await env.local.exists(`wal/postgres_core/${lastSegment}.zst.enc`)).toBe(false); // not archived: only streamed

    const report = await runDrillWith({ latest: true });
    expect(report.errorMessage).toBeUndefined();
    expect(report.status).toBe("PASSED");
    expect(report.journalLineCount).toBe(expected); // includes the 32 lines that exist ONLY in the .partial file
    expect(Number(report.doubleEntryDrift)).toBe(0);
    expect(report.checks.auditChain.detail).toContain("verified 80 audit rows");
  }, 300_000);

  test("FAULT: an unbalanced ledger line (+0.0001 LYD) in the recorded history fails ONLY the double-entry check", async () => {
    env.psql("SELECT post_line('A', 'DEBIT', 0.0001);");
    const mark1 = await mark();
    await tail();
    const report = await runDrill(mark1);
    expect(report.status).toBe("FAILED");
    expect(report.checks.doubleEntry.ok).toBe(false);
    expect(report.doubleEntryDrift).toBe("0.0001");
    expect(report.checks.balanceParity.ok).toBe(true);
    expect(report.checks.auditChain.ok).toBe(true);
    env.psql("SELECT post_line('A', 'CREDIT', 0.0001);"); // compensate so later faults are isolated
  }, 300_000);

  test("FAULT: a shard that drifted by +1.0000 fails ONLY the sharded-balance parity check", async () => {
    env.psql("UPDATE gl_account_shards SET current_balance = current_balance + 1.0000 WHERE shard_id = 3 AND gl_account_id = (SELECT id FROM gl_accounts WHERE code = 'A');");
    const mark2 = await mark();
    await tail();
    const report = await runDrill(mark2);
    expect(report.status).toBe("FAILED");
    expect(report.checks.balanceParity.ok).toBe(false);
    expect(report.balanceMismatches).toBe(1);
    expect(report.checks.doubleEntry.ok).toBe(true);
    expect(report.checks.auditChain.ok).toBe(true);
    env.psql("UPDATE gl_account_shards SET current_balance = current_balance - 1.0000 WHERE shard_id = 3 AND gl_account_id = (SELECT id FROM gl_accounts WHERE code = 'A');");
  }, 300_000);

  test("FAULT: ONE-BYTE CORRUPTION of the local copy is survived (verified S3 copy used); corrupting BOTH copies fails at the integrity gate", async () => {
    const manifests = await env.engine.listManifests("postgres_core");
    const newest = manifests.at(-1)!;
    const key = `backups/postgres_core/${newest.backupId}.tar.zst.enc`;
    const localPath = env.local.pathFor(key);
    const original = await nodeFs.readFile(localPath);
    const flip = (bytes: Buffer): Buffer => {
      const copy = Buffer.from(bytes);
      copy[1000] = copy[1000]! ^ 0xff;
      return copy;
    };
    const mark3 = await mark();
    await tail();
    try {
      await nodeFs.writeFile(localPath, flip(original));
      const survived = await runDrill(mark3);
      expect(survived.errorMessage).toBeUndefined(); // restored from the S3 tier
      expect(survived.checks.doubleEntry.ok).toBe(true);

      env.s3.objects.set(key, flip(env.s3.objects.get(key)!));
      const failed = await runDrill(mark3);
      expect(failed.status).toBe("FAILED");
      expect(failed.errorMessage).toMatch(/checksum mismatch|failed verification/);
      expect(failed.checks.doubleEntry).toEqual({ ok: false, detail: "not executed" });
      expect(verifyDrillReportSignature(failed, ENCRYPTION_KEY_HEX)).toBe(true);
      await expect(nodeFs.access(join(env.root, "scratch"))).rejects.toThrow();
    } finally {
      await nodeFs.writeFile(localPath, original);
      env.s3.objects.set(key, original);
    }
  }, 400_000);

  test("FAULT: tampering with audit row 12 (trigger bypassed as superuser) is caught by the hash chain", async () => {
    env.psql("ALTER TABLE audit_records DISABLE TRIGGER USER;", "pg_audit_db");
    env.psql(`UPDATE audit_records SET after_json = jsonb_set(after_json, '{status}', '"TAMPERED"') WHERE seq_no = 12;`, "pg_audit_db");
    env.psql("ALTER TABLE audit_records ENABLE TRIGGER USER;", "pg_audit_db");
    const mark4 = await mark();
    await tail();
    const report = await runDrill(mark4);
    expect(report.status).toBe("FAILED");
    expect(report.checks.auditChain.ok).toBe(false);
    expect(report.auditBrokenLinks).toBeGreaterThanOrEqual(1);
    expect(report.checks.auditChain.detail).toContain("first at seq_no 12");
    expect(report.checks.doubleEntry.ok).toBe(true);
    expect(report.checks.balanceParity.ok).toBe(true);
  }, 300_000);

  test("FAULT: a deleted audit row is caught by the gap-free sequence check even though hashes still link", async () => {
    // Remove the last row by bypassing the immutability trigger; the surviving chain still verifies hash-wise
    // up to the gap, but seq_no is no longer contiguous with what came next.
    env.psql("ALTER TABLE audit_records DISABLE TRIGGER USER;", "pg_audit_db");
    env.psql("DELETE FROM audit_records WHERE seq_no = 30;", "pg_audit_db");
    env.psql("ALTER TABLE audit_records ENABLE TRIGGER USER;", "pg_audit_db");
    const mark5 = await mark();
    await tail();
    const report = await runDrill(mark5);
    expect(report.checks.auditChain.ok).toBe(false);
    expect(report.auditBrokenLinks).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
