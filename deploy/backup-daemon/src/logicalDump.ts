import { createReadStream, promises as nodeFs } from "node:fs";
import { join } from "node:path";
import type { ArtifactRepository } from "./artifactStore";
import type { CommandRunner } from "./commandRunner";
import { auditEndpoint, isAuditDedicatedCluster, type BackupDaemonConfig } from "./config";
import { openToFile, signManifest, verifyManifestSignature, type BackupManifest } from "./cryptoEnvelope";
import {
  buildDumpCommand,
  buildRestoreDumpCommand,
  buildRestoreListCommand,
  connectionEnv,
  pgBin,
  runTool,
  type PgCluster,
} from "./pgTools";
import { sealIntoRepository } from "./repository";
import { errorMessage, makeBackupId } from "./util";

export interface LogicalDumpDeps {
  config: BackupDaemonConfig;
  runner: CommandRunner;
  repository: ArtifactRepository;
  master: Buffer;
  clock?: () => Date;
}

export interface LogicalDumpResult {
  database: string;
  key: string;
  sha256Ciphertext: string;
  bytes: number;
  storageTargets: string[];
}

export const logicalDumpKey = (database: string, backupId: string): string =>
  `logical/${database}/${backupId}.dump.enc`;

export const logicalManifestKey = (target: string, backupId: string): string =>
  `backups/${target}/${backupId}.manifest.json`;

const sealTarget = (database: string): string => `logical:${database}`;

/**
 * Logical (`pg_dump --format=custom`) backups. They give every full backup a
 * granular, cluster-free restore path and are the ONLY backup of the audit
 * database when it shares the primary cluster as a standalone target.
 */
export class LogicalDumper {
  private readonly clock: () => Date;

  constructor(private readonly deps: LogicalDumpDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  public get stagingDir(): string {
    return this.deps.config.BACKUP_STAGING_DIR;
  }

  /** `pg_dump` -> header check with `pg_restore --list` -> encrypt -> every storage tier. */
  public async dump(cluster: PgCluster, database: string, backupId: string): Promise<LogicalDumpResult> {
    const { config, runner, repository, master } = this.deps;
    const workDir = join(config.BACKUP_STAGING_DIR, `${backupId}-${cluster}-dump`);
    await nodeFs.mkdir(workDir, { recursive: true, mode: 0o700 });
    const dumpFile = join(workDir, `${database}.dump`);
    try {
      await runTool(runner, buildDumpCommand(config, cluster, database, dumpFile), `pg_dump ${database}`);
      // A dump whose table of contents cannot be read is worthless; fail now, not at restore time.
      const listing = await runTool(runner, buildRestoreListCommand(config, dumpFile), `pg_restore --list ${database}`);
      if (listing.stdout.trim().length === 0) throw new Error(`pg_restore --list produced no table of contents for ${database}`);
      const key = logicalDumpKey(database, backupId);
      // pg_dump already compressed the archive with zstd, so do not compress twice.
      const { seal, outcome } = await sealIntoRepository(repository, key, createReadStream(dumpFile), {
        master,
        target: sealTarget(database),
        id: backupId,
        compress: false,
        stagingDir: config.BACKUP_STAGING_DIR,
      });
      return { database, key, sha256Ciphertext: seal.sha256Ciphertext, bytes: seal.compressedBytes, storageTargets: outcome.stored };
    } finally {
      await nodeFs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Standalone backup of the audit database when it shares the primary cluster:
   * logical dump + signed manifest in the `audit_db` prefix. Never needs PG_AUDIT_DATA_DIR.
   */
  public async backupSharedAudit(input: {
    engine: string;
    /** `all` skips a missing audit database; an explicit `audit_db` request fails loudly. */
    skipIfMissing: boolean;
  }): Promise<{ storageTargets: string[]; bytes: number; skipped?: string }> {
    const { config } = this.deps;
    const database = config.PG_AUDIT_DB_NAME;
    if (!(await this.databaseExists("audit", database))) {
      if (input.skipIfMissing) return { storageTargets: [], bytes: 0, skipped: `audit database ${database} does not exist in the primary cluster` };
      throw new Error(`audit database ${database} does not exist in the primary cluster`);
    }
    const startedAt = this.clock();
    const backupId = makeBackupId(startedAt, "audit", "full");
    const dump = await this.dump("audit", database, backupId);
    await this.writeManifest({
      target: "audit_db",
      backupId,
      startedAt: startedAt.toISOString(),
      dumps: [dump],
      engine: input.engine,
      clusterTopology: "shared-audit",
    });
    return { storageTargets: dump.storageTargets, bytes: dump.bytes };
  }

  /**
   * Whether `database` exists. `pg_database` is cluster-wide, so any database the role may connect to
   * answers: the audit database itself on a dedicated cluster (it is the one thing guaranteed to exist
   * there), the core database when the audit database shares the primary cluster (the audit database may
   * be the very thing that is missing, and pg_hba usually restricts which databases a role may open).
   */
  public async databaseExists(cluster: PgCluster, database: string): Promise<boolean> {
    const { config, runner } = this.deps;
    const dedicated = cluster === "audit" && isAuditDedicatedCluster(config);
    const endpoint =
      cluster === "audit"
        ? auditEndpoint(config)
        : { host: config.PG_PRIMARY_HOST, port: config.PG_PRIMARY_PORT, user: config.PG_PRIMARY_USER, password: config.PG_PRIMARY_PASSWORD };
    const connectDb = dedicated ? config.PG_AUDIT_DB_NAME : config.PG_PRIMARY_DB_NAME;
    const result = await runner.run(
      pgBin(config, "psql"),
      [
        "-h", endpoint.host, "-p", String(endpoint.port), "-U", endpoint.user, "-d", connectDb,
        "-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
        "-c", `SELECT 1 FROM pg_database WHERE datname = '${database.replace(/'/g, "''")}'`,
      ],
      { env: connectionEnv(config, endpoint.password), timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS },
    );
    if (result.code !== 0) throw new Error(`could not check for database ${database}: ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout.trim() === "1";
  }

  /** Signed manifest for a standalone logical backup (shared-cluster audit database). */
  public async writeManifest(input: {
    target: string;
    backupId: string;
    startedAt: string;
    dumps: LogicalDumpResult[];
    engine: string;
    clusterTopology: string;
  }): Promise<BackupManifest> {
    const { repository, master } = this.deps;
    const primary = input.dumps[0];
    if (!primary) throw new Error("a logical backup manifest needs at least one dump");
    const manifest = signManifest(
      {
        schemaVersion: 2,
        backupId: input.backupId,
        target: input.target,
        kind: "full",
        engine: input.engine,
        clusterTopology: input.clusterTopology,
        startedAt: input.startedAt,
        completedAt: this.clock().toISOString(),
        uncompressedBytes: 0,
        compressedBytes: input.dumps.reduce((sum, dump) => sum + dump.bytes, 0),
        sha256Plaintext: "",
        sha256Ciphertext: primary.sha256Ciphertext,
        encryption: { algorithm: "AES-256-GCM", kdf: "HKDF-SHA256", saltHex: "", ivHex: "", authTagHex: "" },
        artifacts: Object.fromEntries(input.dumps.map((dump) => [dump.key, { sha256Ciphertext: dump.sha256Ciphertext, bytes: dump.bytes }])),
        storageTargets: [...new Set(input.dumps.flatMap((dump) => dump.storageTargets))],
      },
      master,
    );
    await repository.putBuffer(logicalManifestKey(input.target, input.backupId), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return manifest;
  }

  /** Newest verified logical dump of `database`, or null. */
  public async latest(database: string): Promise<{ key: string; backupId: string } | null> {
    const { repository, master } = this.deps;
    const keys = (await repository.list(`logical/${database}`)).filter((key) => key.endsWith(".dump.enc"));
    const candidates: Array<{ key: string; backupId: string; completedAt: string }> = [];
    for (const key of keys) {
      const backupId = key.slice(key.lastIndexOf("/") + 1).replace(/\.dump\.enc$/, "");
      // A dump only counts when a manifest that names it verifies.
      for (const target of ["audit_db", "postgres_core"]) {
        const raw = await repository.getBuffer(logicalManifestKey(target, backupId)).catch(() => null);
        if (!raw) continue;
        try {
          const manifest = JSON.parse(raw.toString("utf8")) as BackupManifest;
          if (verifyManifestSignature(manifest, master) && manifest.artifacts?.[key]) {
            candidates.push({ key, backupId, completedAt: manifest.completedAt });
            break;
          }
        } catch {
          // an unreadable manifest simply disqualifies the dump
        }
      }
    }
    candidates.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    return candidates[0] ? { key: candidates[0].key, backupId: candidates[0].backupId } : null;
  }

  /** Restores the newest verified dump of `database` into a running (scratch) cluster. */
  public async restoreLatest(input: {
    database: string;
    host: string;
    port: number;
    user: string;
  }): Promise<{ restored: boolean; detail: string }> {
    const { config, runner, repository, master } = this.deps;
    const latest = await this.latest(input.database);
    if (!latest) return { restored: false, detail: `no verified logical dump of ${input.database} exists` };
    const workDir = join(config.BACKUP_STAGING_DIR, `restore-${latest.backupId}-${input.database}`);
    await nodeFs.mkdir(workDir, { recursive: true, mode: 0o700 });
    try {
      const sealed = join(workDir, "dump.enc");
      await repository.getFile(latest.key, sealed);
      const plain = join(workDir, "dump");
      await openToFile(sealed, plain, { master, target: sealTarget(input.database), id: latest.backupId, compress: false });
      const create = await runner.run(
        pgBin(config, "psql"),
        [
          "-h", input.host, "-p", String(input.port), "-U", input.user, "-d", "postgres", "-X", "-A", "-t", "-w",
          "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${input.database.replace(/"/g, '""')}"`,
        ],
        { env: { PGSSLMODE: "prefer" }, timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS },
      );
      if (create.code !== 0) throw new Error(`CREATE DATABASE ${input.database} failed: ${create.stderr.trim().slice(0, 300)}`);
      await runTool(
        runner,
        buildRestoreDumpCommand(config, plain, { host: input.host, port: input.port, user: input.user, database: input.database }),
        `pg_restore ${input.database}`,
      );
      return { restored: true, detail: `restored logical dump ${latest.backupId} into ${input.database}` };
    } catch (error) {
      return { restored: false, detail: errorMessage(error).slice(0, 400) };
    } finally {
      await nodeFs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
