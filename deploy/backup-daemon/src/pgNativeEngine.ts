import { createReadStream, promises as nodeFs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ArtifactRepository } from "./artifactStore";
import {
  buildRedisPingCommand,
  buildRedisRdbCommand,
  buildRedisSnapshotCommand,
  checkTarget,
  expandTargets,
  runChecked,
  walHealthFor,
  type BackupExecutionResult,
  type BackupKind,
  type BackupPolicyView,
  type BackupStorageTarget,
  type BackupSummary,
  type BackupTarget,
  type BackupEngine,
  type EngineDeps,
  type EngineHealth,
  type RecoverLogicalRequest,
  type RecoverRequest,
  type RecoverResult,
  type WalIngestOutcome,
  BackupEngineError,
} from "./backupEngine";
import type { CommandRunner } from "./commandRunner";
import {
  clusterTopology,
  isAuditDedicatedCluster,
  type BackupDaemonConfig,
} from "./config";
import {
  ProcessFilter,
  openFile,
  masterKeyFromHex,
  signManifest,
  verifyManifestSignature,
  type BackupManifest,
} from "./cryptoEnvelope";
import type { BackupRun } from "./catalogStore";
import { LogicalDumper, logicalManifestKey, type LogicalDumpResult } from "./logicalDump";
import {
  buildBaseBackupCommand,
  buildCombineBackupCommand,
  buildVerifyBackupCommand,
  connectionEnv,
  pgBin,
  runTool,
  sqlEndpoint,
  type PgCluster,
} from "./pgTools";
import { buildRepository, sealIntoRepository } from "./repository";
import { errorMessage, makeBackupId, pathExists, sha256File, writeFileAtomic } from "./util";
import { WalArchive, WalStreamer } from "./walArchive";
import { lsnToSegmentName, pgRecoveryTimestamp, walSegmentNumber, type WalTarget } from "./walNames";

/** Short id fragment and WAL target for each physical backup target. */
const SHORT = { postgres_core: "core", audit_db: "audit", redis: "redis" } as const;

/** Path of the WAL fetch helper PostgreSQL's restore_command runs during a restore. */
export const walFetchScriptPath = (): string => fileURLToPath(new URL("./walFetchCli.ts", import.meta.url));

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** `restore_command` that decrypts WAL straight out of the repository. Single quotes doubled for postgresql.conf. */
export const buildRestoreCommand = (target: WalTarget, bunPath = process.execPath, script = walFetchScriptPath()): string =>
  `${shellQuote(bunPath)} ${shellQuote(script)} ${target} %f %p`.replace(/'/g, "''");

const tarCreate = (directory: string): ProcessFilter => {
  const tar = new ProcessFilter("tar", ["-C", directory, "-cf", "-", "."]);
  tar.end();
  return tar;
};

const tarExtract = async (source: Readable, destination: string, onlyPattern?: string): Promise<void> => {
  await nodeFs.mkdir(destination, { recursive: true, mode: 0o700 });
  const extract = new ProcessFilter("tar", [
    "-x",
    "-C",
    destination,
    "--no-same-owner",
    ...(onlyPattern ? ["--wildcards", onlyPattern] : []),
  ]);
  extract.resume();
  await pipeline(source, extract);
};

interface BackupManifestFile {
  "WAL-Ranges"?: Array<{ Timeline: number; "Start-LSN": string; "End-LSN": string }>;
}

/** Files a tar-format base backup of a default-tablespace cluster consists of. Anything else is an extra tablespace. */
export const EXPECTED_BACKUP_FILES = ["base.tar", "pg_wal.tar", "backup_manifest"] as const;

export const unexpectedBackupFiles = (names: string[]): string[] =>
  names.filter((name) => !(EXPECTED_BACKUP_FILES as readonly string[]).includes(name));

/**
 * Health of one continuous WAL stream. Running is not enough: a stream that is a gigabyte behind is running AND
 * not protecting the data, so the lag decides. Unknown lag does not fail health (the stream itself is judged).
 */
export const streamHealthTarget = (
  status: { target: string; running: boolean; startedAt: string | null; lastError: string | null },
  lagBytes: number | null,
  alertBytes: number,
): BackupStorageTarget => {
  const lag = lagBytes === null ? "lag unknown" : `${(lagBytes / (1024 * 1024)).toFixed(1)} MiB behind the primary`;
  const tooFar = lagBytes !== null && lagBytes > alertBytes;
  return {
    id: `wal-stream-${status.target}`,
    name: `WAL Stream (${status.target})`,
    kind: "database",
    healthy: status.running && !tooFar,
    detail: !status.running
      ? (status.lastError ?? "pg_receivewal is not running")
      : tooFar
        ? `streaming but ${lag} (alert above ${(alertBytes / (1024 * 1024)).toFixed(0)} MiB)`
        : `streaming since ${status.startedAt}, ${lag}`,
  };
};

export interface WalRange {
  timeline: number;
  startLsn: string;
  endLsn: string;
}

export const parseWalRanges = (manifestJson: string): WalRange[] => {
  const parsed = JSON.parse(manifestJson) as BackupManifestFile;
  return (parsed["WAL-Ranges"] ?? []).map((range) => ({
    timeline: range.Timeline,
    startLsn: range["Start-LSN"],
    endLsn: range["End-LSN"],
  }));
};

export class PgNativeEngine implements BackupEngine {
  private readonly master: Buffer;
  private readonly repository: ArtifactRepository;
  private readonly dumper: LogicalDumper;
  private readonly clock: () => Date;
  public readonly walArchive: WalArchive;
  private readonly streamers: WalStreamer[] = [];
  /** cluster + slot of each streamer, to ask the primary how far behind it is. */
  private readonly streamSlots = new Map<WalStreamer, { cluster: PgCluster; slot: string }>();
  private readonly logger?: Pick<Console, "info" | "warn" | "error">;

  constructor(
    private readonly config: BackupDaemonConfig,
    private readonly runner: CommandRunner,
    private readonly deps: EngineDeps = {},
  ) {
    this.master = masterKeyFromHex(config.BACKUP_ENCRYPTION_KEY_HEX);
    this.repository = deps.repository ?? buildRepository(config, runner);
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger;
    this.dumper = new LogicalDumper({ config, runner, repository: this.repository, master: this.master, clock: this.clock });
    this.walArchive = new WalArchive({ config, repository: this.repository, master: this.master, clock: this.clock, logger: deps.logger });
  }

  public get repo(): ArtifactRepository {
    return this.repository;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  public async start(): Promise<void> {
    this.walArchive.mirror.start();
    if (!this.config.BACKUP_WAL_STREAMING_ENABLED) return;
    const clusters: Array<{ cluster: PgCluster; target: WalTarget; slot: string }> = [
      { cluster: "core", target: "postgres_core", slot: this.config.PG_REPLICATION_SLOT },
      ...(isAuditDedicatedCluster(this.config)
        ? [{ cluster: "audit" as const, target: "audit_db" as const, slot: this.config.PG_AUDIT_REPLICATION_SLOT }]
        : []),
    ];
    for (const entry of clusters) {
      const streamer = new WalStreamer({
        config: this.config,
        runner: this.runner,
        archive: this.walArchive,
        cluster: entry.cluster,
        target: entry.target,
        slot: entry.slot,
        spoolDir: join(this.config.BACKUP_WAL_SPOOL_DIR, entry.target),
        logger: this.logger,
      });
      this.streamers.push(streamer);
      this.streamSlots.set(streamer, { cluster: entry.cluster, slot: entry.slot });
      await streamer.start();
    }
  }

  public async stop(): Promise<void> {
    this.walArchive.mirror.stop();
    await Promise.all(this.streamers.map((streamer) => streamer.stop()));
  }

  public walStatus(): unknown {
    return {
      ...this.walArchive.state(),
      streams: this.streamers.map((streamer) => streamer.getStatus()),
      mirror: { pending: this.walArchive.mirror.pendingCount(), mirrored: this.walArchive.mirror.mirrored, lastError: this.walArchive.mirror.lastError },
    };
  }

  public ingestWal(target: string, file: string, body: Readable, declaredLength: number | null): Promise<WalIngestOutcome> {
    return this.walArchive.ingestStream(target, file, body, declaredLength);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private get stateDir(): string {
    return join(dirname(this.config.BACKUP_CATALOG_PATH), "manifests");
  }

  private clusterFor(target: BackupTarget): PgCluster {
    return target === "audit_db" ? "audit" : "core";
  }

  /**
   * "Now" according to the PRIMARY. Manifest times are compared with recovery targets, which are commit times taken
   * from the primary's clock; on a dedicated backup host the two clocks can disagree, so the manifest uses the
   * primary's. Falls back to the local clock when the primary cannot be asked.
   */
  public async primaryClock(cluster: PgCluster): Promise<Date> {
    try {
      const value = await this.scalar(cluster, `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`);
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    } catch {
      // fall through to the local clock
    }
    return this.clock();
  }

  /**
   * How many bytes of WAL the primary has produced that the stream has not flushed yet. Read from
   * `pg_replication_slots.restart_lsn` (visible to every role, unlike `pg_stat_replication`), which follows the
   * receiver's flush position. null when it cannot be determined (slot not created yet, primary unreachable).
   */
  private async streamLagBytes(streamer: WalStreamer): Promise<number | null> {
    const entry = this.streamSlots.get(streamer);
    if (!entry) return null;
    try {
      const value = await this.scalar(
        entry.cluster,
        `SELECT COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::bigint::text FROM pg_replication_slots WHERE slot_name = '${entry.slot.replace(/'/g, "''")}';`,
      );
      if (value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
    } catch {
      return null;
    }
  }

  /** A database the role is allowed to connect to (pg_hba usually restricts databases): never the `postgres` maintenance DB. */
  private connectDb(cluster: PgCluster): string {
    return cluster === "audit" ? this.config.PG_AUDIT_DB_NAME : this.config.PG_PRIMARY_DB_NAME;
  }

  private async scalar(cluster: PgCluster, sql: string): Promise<string> {
    const endpoint = sqlEndpoint(this.config, cluster);
    const result = await runTool(
      this.runner,
      {
        command: pgBin(this.config, "psql"),
        args: ["-h", endpoint.host, "-p", String(endpoint.port), "-U", endpoint.user, "-d", this.connectDb(cluster), "-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-c", sql],
        env: connectionEnv(this.config, endpoint.password),
        timeoutMs: this.config.BACKUP_COMMAND_TIMEOUT_MS,
      },
      "psql",
    );
    return result.stdout.trim();
  }

  /** Every manifest of `target` whose HMAC verifies, oldest first. Tampered manifests are ignored loudly. */
  public async listManifests(target: BackupTarget): Promise<BackupManifest[]> {
    const keys = (await this.repository.list(`backups/${target}`)).filter((key) => key.endsWith(".manifest.json"));
    const manifests: BackupManifest[] = [];
    for (const key of keys) {
      const raw = await this.repository.getBuffer(key);
      if (!raw) continue;
      try {
        const manifest = JSON.parse(raw.toString("utf8")) as BackupManifest;
        if (!verifyManifestSignature(manifest, this.master)) {
          this.logger?.error(`[pg-backup-daemon] manifest ${key} failed signature verification and was ignored`);
          continue;
        }
        manifests.push(manifest);
      } catch {
        this.logger?.error(`[pg-backup-daemon] manifest ${key} is unreadable and was ignored`);
      }
    }
    return manifests.sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  }

  private artifactKey(target: BackupTarget, backupId: string): string {
    return `backups/${target}/${backupId}.tar.zst.enc`;
  }

  private manifestKey(target: BackupTarget, backupId: string): string {
    return logicalManifestKey(target, backupId);
  }

  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------

  public async overviewHealth(): Promise<EngineHealth> {
    const storageChecks = this.repository.stores.map(async (store): Promise<BackupStorageTarget> => {
      const health = await store.health();
      return {
        id: store.id,
        name: store.name,
        kind: store.kind === "local" ? "database" : store.kind,
        healthy: health.healthy,
        detail: health.detail,
      };
    });
    const psqlCheck = (id: string, name: string, cluster: PgCluster): Promise<BackupStorageTarget> => {
      const endpoint = sqlEndpoint(this.config, cluster);
      return checkTarget(this.runner, id, name, "database", {
        command: pgBin(this.config, "psql"),
        args: ["-h", endpoint.host, "-p", String(endpoint.port), "-U", endpoint.user, "-d", this.connectDb(cluster), "-X", "-A", "-t", "-w", "-c", "SELECT 1;"],
        env: connectionEnv(this.config, endpoint.password),
        timeoutMs: this.config.BACKUP_COMMAND_TIMEOUT_MS,
      });
    };
    const redis = buildRedisPingCommand(this.config);
    const targets = await Promise.all([
      ...storageChecks,
      psqlCheck("postgres-primary", "PostgreSQL Primary", "core"),
      ...(isAuditDedicatedCluster(this.config) ? [psqlCheck("postgres-audit", "PostgreSQL Audit Cluster", "audit")] : []),
      ...(redis ? [checkTarget(this.runner, "redis", "Redis Snapshots", "redis", redis)] : []),
    ]);

    for (const streamer of this.streamers) {
      targets.push(streamHealthTarget(streamer.getStatus(), await this.streamLagBytes(streamer), this.config.BACKUP_STREAM_ALERT_BYTES));
    }
    if (this.walArchive.mirror.pendingCount() > 0) {
      const lag = this.walArchive.mirror.pendingCount();
      const mirrorOk = this.walArchive.mirror.lastError === null;
      targets.push({
        id: "wal-mirror",
        name: "WAL Mirror Queue",
        kind: "database",
        healthy: mirrorOk,
        detail: `${lag} WAL file(s) waiting to be mirrored${mirrorOk ? "" : `: ${this.walArchive.mirror.lastError}`}`,
      });
    }

    const wal = await walHealthFor(this.config, this.runner);
    const healthy = targets.every((target) => target.healthy) && wal.archiveLagSeconds <= this.config.BACKUP_ALERT_LAG_SECONDS;
    return { healthy, wal, targets };
  }

  // -------------------------------------------------------------------------
  // backup
  // -------------------------------------------------------------------------

  public async triggerBackup(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult> {
    const requested = expandTargets(this.config, target);
    const storageTargets = new Set<string>();
    let sizeBytes = 0;
    let startLsn: string | undefined;
    let endLsn: string | undefined;

    for (const requestedTarget of requested) {
      if (requestedTarget === "redis") {
        const redis = await this.backupRedis(kind);
        redis.storageTargets.forEach((id) => storageTargets.add(id));
        sizeBytes += redis.sizeBytes ?? 0;
        continue;
      }
      if (requestedTarget === "audit_db" && !isAuditDedicatedCluster(this.config)) {
        const audit = await this.dumper.backupSharedAudit({ engine: "pg-native", skipIfMissing: target === "all" });
        audit.storageTargets.forEach((id) => storageTargets.add(id));
        sizeBytes += audit.bytes;
        continue;
      }
      const result = await this.backupPhysical(requestedTarget, kind);
      result.storageTargets.forEach((id) => storageTargets.add(id));
      sizeBytes += result.sizeBytes ?? 0;
      // The headline LSNs are the core cluster's.
      if (requestedTarget === "postgres_core" || (!startLsn && !endLsn)) {
        startLsn = result.startLsn;
        endLsn = result.endLsn;
      }
    }
    return { storageTargets: [...storageTargets], sizeBytes, startLsn, endLsn };
  }

  private async backupPhysical(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult> {
    const cluster = this.clusterFor(target);
    const short = SHORT[target as "postgres_core" | "audit_db"];
    const startedAt = await this.primaryClock(cluster);
    const backupId = makeBackupId(this.clock(), short, kind);
    const staging = join(this.config.BACKUP_STAGING_DIR, backupId);
    await nodeFs.rm(staging, { recursive: true, force: true });
    await nodeFs.mkdir(this.config.BACKUP_STAGING_DIR, { recursive: true, mode: 0o700 });

    let parent: BackupManifest | undefined;
    let incrementalFrom: string | undefined;
    const written: string[] = [];
    try {
      if (kind === "delta") {
        const summarize = await this.scalar(cluster, "SHOW summarize_wal;");
        if (summarize !== "on") {
          throw new BackupEngineError(
            `a delta backup needs summarize_wal = on on the ${target} cluster (it is "${summarize}"); enable it or run a full backup`,
            target,
            kind,
          );
        }
        const history = await this.listManifests(target);
        parent = history.filter((entry) => entry.kind === "full" || entry.kind === "delta").at(-1);
        if (!parent) {
          throw new BackupEngineError("a delta backup needs a previous full backup of this target", target, kind);
        }
        incrementalFrom = await this.parentBackupManifest(target, parent);
      }

      // The native restore handles the default tablespace layout only. Refuse BEFORE producing a backup that
      // looks fine and cannot be restored (pg_basebackup would emit one extra <oid>.tar per tablespace).
      const extraTablespaces = Number(
        await this.scalar(cluster, "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global');"),
      );
      if (extraTablespaces > 0) {
        throw new BackupEngineError(
          `the ${target} cluster has ${extraTablespaces} non-default tablespace(s); the pg-native engine cannot restore them, so no backup was taken`,
          target,
          kind,
        );
      }
      await runTool(
        this.runner,
        buildBaseBackupCommand(this.config, cluster, { destination: staging, label: backupId, incrementalFrom }),
        `pg_basebackup (${target})`,
      );
      const produced = unexpectedBackupFiles(await nodeFs.readdir(staging));
      if (produced.length > 0) {
        throw new BackupEngineError(
          `pg_basebackup produced unexpected files (${produced.slice(0, 3).join(", ")}): extra tablespaces are not supported by the pg-native restore`,
          target,
          kind,
        );
      }
      // Tar-format verification cannot parse WAL (pg_verifybackup needs -n); the restore drill proves the WAL.
      const verify = await runTool(
        this.runner,
        { ...buildVerifyBackupCommand(this.config, staging), args: ["--format=tar", "--no-parse-wal", staging] },
        `pg_verifybackup (${target})`,
      );

      const manifestText = await nodeFs.readFile(join(staging, "backup_manifest"), "utf8");
      const ranges = parseWalRanges(manifestText);
      const first = ranges[0];
      const last = ranges.at(-1);

      const key = this.artifactKey(target, backupId);
      const { seal, outcome } = await sealIntoRepository(this.repository, key, tarCreate(staging), {
        master: this.master,
        target,
        id: backupId,
        stagingDir: this.config.BACKUP_STAGING_DIR,
      });
      written.push(key);

      // Keep this backup's manifest so the NEXT delta can be taken against it.
      await writeFileAtomic(join(this.stateDir, target, `${backupId}.backup_manifest`), manifestText);

      const dumps: LogicalDumpResult[] = [];
      if (kind === "full") {
        const database = target === "audit_db" ? this.config.PG_AUDIT_DB_NAME : this.config.PG_PRIMARY_DB_NAME;
        dumps.push(await this.dumper.dump(cluster, database, backupId));
        written.push(dumps[0]!.key);
      }

      const manifest = signManifest(
        {
          schemaVersion: 2,
          backupId,
          target,
          kind,
          engine: "pg-native",
          clusterTopology: clusterTopology(this.config),
          startedAt: startedAt.toISOString(),
          completedAt: (await this.primaryClock(cluster)).toISOString(),
          startLsn: first?.startLsn,
          endLsn: last?.endLsn,
          walSegmentStart: first ? (lsnToSegmentName(first.startLsn, first.timeline) ?? undefined) : undefined,
          walSegmentEnd: last ? (lsnToSegmentName(last.endLsn, last.timeline) ?? undefined) : undefined,
          ...(parent ? { parentBackupId: parent.backupId } : {}),
          uncompressedBytes: seal.uncompressedBytes,
          compressedBytes: seal.compressedBytes,
          sha256Plaintext: seal.sha256Plaintext,
          sha256Ciphertext: seal.sha256Ciphertext,
          encryption: {
            algorithm: "AES-256-GCM",
            kdf: "HKDF-SHA256",
            saltHex: seal.saltHex,
            ivHex: seal.ivHex,
            authTagHex: seal.authTagHex,
          },
          pgVerifyBackup: {
            verified: true,
            manifestChecksumAlgorithm: "SHA256",
            detail: verify.stdout.trim().split(/\r?\n/).at(-1) ?? "backup successfully verified",
          },
          ...(dumps.length > 0
            ? { artifacts: Object.fromEntries(dumps.map((dump) => [dump.key, { sha256Ciphertext: dump.sha256Ciphertext, bytes: dump.bytes }])) }
            : {}),
          storageTargets: [...new Set([...outcome.stored, ...dumps.flatMap((dump) => dump.storageTargets)])],
        },
        this.master,
      );
      // The manifest is written LAST: until it exists the backup does not exist.
      const manifestOutcome = await this.repository.putBuffer(this.manifestKey(target, backupId), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      written.push(this.manifestKey(target, backupId));

      return {
        sizeBytes: seal.compressedBytes + dumps.reduce((sum, dump) => sum + dump.bytes, 0),
        startLsn: first?.startLsn,
        endLsn: last?.endLsn,
        storageTargets: [...new Set([...manifest.storageTargets, ...manifestOutcome.stored])],
      };
    } catch (error) {
      // A failed run leaves no half-written artifact behind.
      await Promise.all(written.map((key) => this.repository.delete(key).catch(() => undefined)));
      if (error instanceof BackupEngineError) throw error;
      throw new BackupEngineError(errorMessage(error), target, kind);
    } finally {
      await nodeFs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Path to the parent backup's `backup_manifest`, recovered from the artifact itself when local state is gone. */
  private async parentBackupManifest(target: BackupTarget, parent: BackupManifest): Promise<string> {
    const local = join(this.stateDir, target, `${parent.backupId}.backup_manifest`);
    if (await pathExists(local)) return local;
    const work = join(this.config.BACKUP_STAGING_DIR, `parent-${parent.backupId}`);
    await nodeFs.mkdir(work, { recursive: true, mode: 0o700 });
    try {
      const sealed = join(work, "artifact.enc");
      await this.repository.getFile(this.artifactKey(target, parent.backupId), sealed);
      await tarExtract(openFile(sealed, { master: this.master, target, id: parent.backupId }), work, "*backup_manifest");
      const extracted = (await nodeFs.readdir(work)).find((name) => name === "backup_manifest");
      if (!extracted) throw new Error("backup_manifest not found in the parent artifact");
      await writeFileAtomic(local, await nodeFs.readFile(join(work, extracted)));
      return local;
    } finally {
      await nodeFs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async backupRedis(kind: BackupKind): Promise<BackupExecutionResult> {
    const snapshot = buildRedisSnapshotCommand(this.config);
    if (!snapshot) throw new BackupEngineError("REDIS_URL is not configured", "redis", kind);
    await runChecked(this.runner, snapshot, "redis", kind);
    const startedAt = this.clock();
    const backupId = makeBackupId(startedAt, "redis", kind);
    const work = join(this.config.BACKUP_STAGING_DIR, backupId);
    await nodeFs.mkdir(work, { recursive: true, mode: 0o700 });
    const dump = join(work, "dump.rdb");
    try {
      const rdb = buildRedisRdbCommand(this.config, dump);
      if (!rdb) throw new BackupEngineError("REDIS_URL is not configured", "redis", kind);
      await runChecked(this.runner, rdb, "redis", kind);
      const key = `backups/redis/${backupId}.rdb.enc`;
      const { seal, outcome } = await sealIntoRepository(this.repository, key, createReadStream(dump), {
        master: this.master,
        target: "redis",
        id: backupId,
        stagingDir: this.config.BACKUP_STAGING_DIR,
      });
      const manifest = signManifest(
        {
          schemaVersion: 2,
          backupId,
          target: "redis",
          kind,
          engine: "pg-native",
          clusterTopology: clusterTopology(this.config),
          startedAt: startedAt.toISOString(),
          completedAt: this.clock().toISOString(),
          uncompressedBytes: seal.uncompressedBytes,
          compressedBytes: seal.compressedBytes,
          sha256Plaintext: seal.sha256Plaintext,
          sha256Ciphertext: seal.sha256Ciphertext,
          encryption: { algorithm: "AES-256-GCM", kdf: "HKDF-SHA256", saltHex: seal.saltHex, ivHex: seal.ivHex, authTagHex: seal.authTagHex },
          storageTargets: outcome.stored,
        },
        this.master,
      );
      await this.repository.putBuffer(this.manifestKey("redis", backupId), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      return { sizeBytes: seal.compressedBytes, storageTargets: ["redis", ...outcome.stored] };
    } finally {
      await nodeFs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // listing
  // -------------------------------------------------------------------------

  /**
   * Run history rebuilt from the signed manifests in the repository. Used on a
   * replacement host when no (valid) mirrored catalog exists, so the Admin
   * Portal still shows the backups that are really there.
   */
  public async reconstructRuns(): Promise<BackupRun[]> {
    const runs: BackupRun[] = [];
    for (const target of ["postgres_core", "audit_db", "redis"] as const) {
      for (const manifest of await this.listManifests(target)) {
        runs.push({
          id: manifest.backupId,
          target,
          kind: manifest.kind,
          engine: "pg-native",
          status: "PASSED",
          startedAt: manifest.startedAt,
          completedAt: manifest.completedAt,
          durationMs: Math.max(0, Date.parse(manifest.completedAt) - Date.parse(manifest.startedAt)),
          sizeBytes: manifest.compressedBytes,
          startLsn: manifest.startLsn,
          endLsn: manifest.endLsn,
          storageTargets: manifest.storageTargets,
        });
      }
    }
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public async listBackups(limit: number, target: BackupTarget = "postgres_core"): Promise<BackupSummary[]> {
    const manifests = await this.listManifests(target === "all" ? "postgres_core" : target);
    return manifests
      .slice()
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((manifest) => ({
        backupId: manifest.backupId,
        startedAt: manifest.startedAt,
        completedAt: manifest.completedAt,
        sizeBytes: manifest.compressedBytes,
        startLsn: manifest.startLsn,
        endLsn: manifest.endLsn,
      }));
  }

  // -------------------------------------------------------------------------
  // restore
  // -------------------------------------------------------------------------

  /** The newest verified backup that finished at or before `targetTime`, and its chain back to a full backup. */
  public async resolveChain(target: BackupTarget, targetTime: Date): Promise<BackupManifest[]> {
    const manifests = await this.listManifests(target);
    const byId = new Map(manifests.map((manifest) => [manifest.backupId, manifest]));
    const eligible = manifests.filter((manifest) => Date.parse(manifest.completedAt) <= targetTime.getTime());
    const head = eligible.at(-1);
    if (!head) {
      throw new BackupEngineError(
        manifests.length === 0
          ? `no verified ${target} backup exists in the repository`
          : `no ${target} backup completed before the recovery target time ${targetTime.toISOString()}`,
        target,
        "full",
      );
    }
    const chain: BackupManifest[] = [head];
    let cursor = head;
    while (cursor.kind === "delta") {
      const parent = cursor.parentBackupId ? byId.get(cursor.parentBackupId) : undefined;
      if (!parent) throw new BackupEngineError(`backup ${cursor.backupId} depends on ${cursor.parentBackupId ?? "an unknown parent"}, which is missing or failed verification`, target, "full");
      chain.unshift(parent);
      cursor = parent;
    }
    return chain;
  }

  public async recover(request: RecoverRequest): Promise<RecoverResult> {
    const target: BackupTarget = request.target;
    // "latest" (disaster recovery) restores from the newest verified backup that exists right now.
    const chain = await this.resolveChain(target, request.latest ? this.clock() : request.targetTime);
    const work = join(this.config.BACKUP_STAGING_DIR, `restore-${chain.at(-1)!.backupId}`);
    await nodeFs.rm(work, { recursive: true, force: true });
    await nodeFs.mkdir(work, { recursive: true, mode: 0o700 });
    try {
      const extractedDirs: string[] = [];
      for (const manifest of chain) {
        const sealed = join(work, `${manifest.backupId}.enc`);
        // Gate 1: the ciphertext must be exactly what the signed manifest recorded. A damaged copy on
        // one tier is skipped in favour of a verified copy on another.
        try {
          await this.repository.getFileVerified(this.artifactKey(target, manifest.backupId), sealed, async (path) => {
            const actual = await sha256File(path);
            if (actual !== manifest.sha256Ciphertext) {
              throw new Error(`ciphertext checksum mismatch for ${manifest.backupId}`);
            }
          });
        } catch (error) {
          throw new BackupEngineError(errorMessage(error), target, "full");
        }
        const dir = join(work, manifest.backupId);
        // AES-GCM authentication happens as the stream ends: any flipped bit aborts the extraction.
        await tarExtract(openFile(sealed, { master: this.master, target, id: manifest.backupId }), dir);
        await nodeFs.rm(sealed, { force: true });
        extractedDirs.push(dir);
      }

      const dataDirs: string[] = [];
      for (const dir of extractedDirs) {
        const data = join(dir, "data");
        await nodeFs.mkdir(data, { recursive: true, mode: 0o700 });
        await tarExtract(createReadStream(join(dir, "base.tar")), data);
        await nodeFs.copyFile(join(dir, "backup_manifest"), join(data, "backup_manifest"));
        dataDirs.push(data);
      }

      await nodeFs.mkdir(request.targetDir, { recursive: true, mode: 0o700 });
      if (dataDirs.length === 1) {
        await nodeFs.cp(dataDirs[0]!, request.targetDir, { recursive: true });
      } else {
        // pg_combinebackup wants an empty (or new) output directory.
        await nodeFs.rm(request.targetDir, { recursive: true, force: true });
        await runTool(this.runner, buildCombineBackupCommand(this.config, dataDirs, request.targetDir), "pg_combinebackup");
      }
      // The WAL streamed during the NEWEST backup carries the restore to a consistent state.
      const newest = extractedDirs.at(-1)!;
      await tarExtract(createReadStream(join(newest, "pg_wal.tar")), join(request.targetDir, "pg_wal"));
      await nodeFs.chmod(request.targetDir, 0o700);

      const escapedTime = pgRecoveryTimestamp(request.targetTime);
      return {
        recoveryConf:
          `restore_command = '${buildRestoreCommand(target === "audit_db" ? "audit_db" : "postgres_core")}'\n` +
          // No target for "latest": PostgreSQL replays until the archive (and the streamed partial segment) runs out, then promotes.
          (request.latest ? "" : `recovery_target_time = '${escapedTime}'\n` + "recovery_target_action = 'promote'\n"),
      };
    } finally {
      await nodeFs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public restoreLogical(request: RecoverLogicalRequest): Promise<{ restored: boolean; detail: string }> {
    return this.dumper.restoreLatest(request);
  }

  // -------------------------------------------------------------------------
  // retention (policy driven)
  // -------------------------------------------------------------------------

  public async prune(target: BackupTarget, kind: BackupKind = "full"): Promise<void> {
    if (kind !== "full") return;
    const policy: BackupPolicyView = this.deps.getPolicy?.() ?? {
      fullRetentionDays: this.config.BACKUP_RETENTION_FULL_COUNT * 7,
      walRetentionDays: this.config.BACKUP_RETENTION_WAL_DAYS,
    };
    const now = this.clock().getTime();
    const backupCutoff = now - policy.fullRetentionDays * 86_400_000;
    const walCutoff = now - policy.walRetentionDays * 86_400_000;
    const targets = expandTargets(this.config, target).filter((entry) => entry !== "redis");
    for (const entry of targets) {
      const manifests = await this.listManifests(entry);
      const fulls = manifests.filter((manifest) => manifest.kind === "full");
      if (fulls.length === 0) continue;

      // A "chain" is a full backup plus the deltas taken against it; chains are kept or dropped whole.
      const keepIds = new Set<string>();
      const newestFull = fulls.at(-1)!;
      const chainOf = (head: BackupManifest): BackupManifest[] => {
        const members = [head];
        for (const manifest of manifests) {
          let cursor: BackupManifest | undefined = manifest;
          while (cursor && cursor.kind === "delta") {
            cursor = manifests.find((candidate) => candidate.backupId === cursor!.parentBackupId);
          }
          if (cursor?.backupId === head.backupId && manifest.backupId !== head.backupId) members.push(manifest);
        }
        return members;
      };
      for (const full of fulls) {
        if (full.backupId === newestFull.backupId || Date.parse(full.completedAt) >= backupCutoff) {
          chainOf(full).forEach((member) => keepIds.add(member.backupId));
        }
      }
      for (const manifest of manifests) {
        if (keepIds.has(manifest.backupId)) continue;
        await this.deleteBackup(entry, manifest);
      }

      // WAL: nothing older than the oldest retained base backup's first segment is needed for any restore.
      const retained = manifests.filter((manifest) => keepIds.has(manifest.backupId) && manifest.kind === "full");
      const oldestStart = retained
        .map((manifest) => (manifest.walSegmentStart ? walSegmentNumber(manifest.walSegmentStart) : null))
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right)[0];
      if (oldestStart !== undefined && (entry === "postgres_core" || entry === "audit_db")) {
        await this.pruneWal(entry, oldestStart, walCutoff);
      }
    }
  }

  private async deleteBackup(target: BackupTarget, manifest: BackupManifest): Promise<void> {
    const keys = [
      this.artifactKey(target, manifest.backupId),
      ...Object.keys(manifest.artifacts ?? {}),
      // Delete the manifest LAST so a crash mid-way never leaves a manifest pointing at nothing.
      this.manifestKey(target, manifest.backupId),
    ];
    for (const key of keys) await this.repository.delete(key);
    await nodeFs.rm(join(this.stateDir, target, `${manifest.backupId}.backup_manifest`), { force: true });
  }

  private async pruneWal(target: "postgres_core" | "audit_db", oldestStartSegment: number, ageCutoffMs: number): Promise<void> {
    const keys = await this.repository.list(`wal/${target}`);
    for (const key of keys) {
      const name = key.slice(key.lastIndexOf("/") + 1).replace(/\.zst\.enc$/, "");
      if (name.endsWith(".history")) continue; // timeline history is tiny and always needed
      const number = walSegmentNumber(name.slice(0, 24));
      if (number === null || number >= oldestStartSegment) continue;
      const local = this.repository.local;
      if (local) {
        try {
          const stat = await nodeFs.stat(local.pathFor(key));
          if (stat.mtimeMs > ageCutoffMs) continue; // still inside the WAL retention window
        } catch {
          // not on the local tier: fall through to the segment rule alone
        }
      }
      await this.repository.delete(key);
    }
  }
}
