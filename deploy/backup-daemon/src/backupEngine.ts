




import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ArtifactRepository } from "./artifactStore";
import type { CommandResult, CommandRunner } from "./commandRunner";
import { isAuditConfigured, isAuditDedicatedCluster, type BackupDaemonConfig } from "./config";
import { LogicalDumper } from "./logicalDump";
import { masterKeyFromHex } from "./cryptoEnvelope";
import { PgNativeEngine } from "./pgNativeEngine";
import { buildRepository } from "./repository";
import { parseWalArchiveStatus, pgRecoveryTimestamp } from "./walNames";

export const BACKUP_TARGETS = ["all", "postgres_core", "audit_db", "redis"] as const;
export type BackupTarget = (typeof BACKUP_TARGETS)[number];

export const RECOVERY_TARGETS = ["postgres_core", "audit_db"] as const;
export type RecoveryTarget = (typeof RECOVERY_TARGETS)[number];

export const BACKUP_KINDS = ["full", "delta"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export interface BackupStorageTarget {
  id: string;
  name: string;
  kind: "s3" | "ssh" | "redis" | "database";
  healthy: boolean;
  detail: string;
}

export interface WalHealth {
  archiveLagSeconds: number;
  currentLsn: string;
  lastArchivedLsn: string;
  lagBytes: number;
}

export interface EngineHealth {
  healthy: boolean;
  wal: WalHealth;
  targets: BackupStorageTarget[];
}

export interface BackupExecutionResult {
  sizeBytes?: number;
  startLsn?: string;
  endLsn?: string;
  storageTargets: string[];
}

export interface BackupSummary {
  backupId: string;
  startedAt: string;
  completedAt?: string;
  sizeBytes?: number;
  startLsn?: string;
  endLsn?: string;
}

export interface RecoverRequest {
  target: RecoveryTarget;
  /** Recovery target. Ignored when `latest` is set. */
  targetTime: Date;
  /**
   * Disaster recovery: replay everything that is available (every archived segment, and the streamed `.partial`
   * one) instead of stopping at a time. The cluster promotes when the WAL runs out.
   */
  latest?: boolean;
  targetDir: string;
  port: number;
}

export interface RecoverResult {
  replayedLsn?: string;
  recoveryConf?: string;
  /** Set only when the engine deliberately prepared an empty, initialized data dir. */
  initializedEmptyDir?: boolean;
  emptyDirInitialized?: boolean;
  initializedEmptyDataDir?: boolean;
}

export interface RecoverLogicalRequest {
  database: string;
  host: string;
  port: number;
  user: string;
}

export interface WalIngestOutcome {
  status: "stored" | "duplicate";
  key: string;
  bytes: number;
}

export interface BackupPolicyView {
  fullRetentionDays: number;
  walRetentionDays: number;
}

export interface BackupEngine {
  overviewHealth(): Promise<EngineHealth>;
  /** Restores the newest verified logical dump into a running scratch cluster (shared-cluster audit database). */
  restoreLogical?(request: RecoverLogicalRequest): Promise<{ restored: boolean; detail: string }>;
  /** Accepts a WAL file pushed by the database's archive_command (pg-native only). */
  ingestWal?(target: string, file: string, body: Readable, declaredLength: number | null): Promise<WalIngestOutcome>;
  /** Starts background workers (continuous WAL streaming, WAL mirroring). */
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** Live WAL ingest / streaming / mirror status for the overview. */
  walStatus?(): unknown;
  triggerBackup(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult>;
  listBackups(limit: number, target?: BackupTarget): Promise<BackupSummary[]>;
  latestDrill?(): Promise<unknown | null>;
  recover?(request: RecoverRequest): Promise<RecoverResult>;
  prune?(target: BackupTarget, kind?: BackupKind): Promise<void>;
}

export interface BuiltCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class BackupEngineError extends Error {
  constructor(
    message: string,
    public readonly target: BackupTarget,
    public readonly kind: BackupKind,
  ) {
    super(message);
    this.name = "BackupEngineError";
  }
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const backupDataDir = (config: BackupDaemonConfig, target: BackupTarget): string => {
  if (target === "audit_db") {
    if (!config.PG_AUDIT_DATA_DIR) {
      throw new Error(
        "PG_AUDIT_DATA_DIR is required for the audit_db WAL-G target; refusing to back up the core data directory",
      );
    }
    return config.PG_AUDIT_DATA_DIR;
  }
  return config.PG_DATA_DIR;
};

/**
 * What `target = "all"` means for this deployment. The audit database is a
 * target whenever one is configured: with a dedicated cluster it gets its own
 * physical backup, otherwise a logical dump (it is already inside the core
 * physical backup, but a standalone dump keeps it independently restorable).
 */
export const expandTargets = (config: BackupDaemonConfig, target: BackupTarget): BackupTarget[] => {
  if (target !== "all") return [target];
  return [
    "postgres_core",
    ...(isAuditConfigured(config) ? (["audit_db"] as const) : []),
    ...(config.REDIS_URL ? (["redis"] as const) : []),
  ];
};

export interface EngineDeps {
  repository?: ArtifactRepository;
  /** Live retention policy (maker-checker governed) so pruning follows what the Admin Portal approved. */
  getPolicy?: () => BackupPolicyView;
  clock?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/** WAL-G keeps whole base backups; the policy is expressed in days, so convert at one backup per week. */
export const retentionCount = (config: BackupDaemonConfig, policy?: BackupPolicyView): number =>
  policy ? Math.max(1, Math.ceil(policy.fullRetentionDays / 7)) : config.BACKUP_RETENTION_FULL_COUNT;

export const walGS3Prefix = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): string =>
  trimTrailingSlash(target === "audit_db" ? config.BACKUP_AUDIT_S3_PREFIX : config.BACKUP_CORE_S3_PREFIX);

export const walGEnvironment = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): Record<string, string> => {
  const env: Record<string, string> = {
    PGHOST: "/run/postgresql",
    PGPORT: String(target === "audit_db" ? config.PG_AUDIT_PORT : config.PG_PRIMARY_PORT),
    PGUSER: "postgres",
    ...(target === "audit_db"
      ? (config.PG_AUDIT_DATA_DIR ? { PGDATA: config.PG_AUDIT_DATA_DIR } : {})
      : (config.PG_DATA_DIR ? { PGDATA: config.PG_DATA_DIR } : {})),
    WALG_S3_PREFIX: walGS3Prefix(config, target),
    AWS_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_ENDPOINT_URL: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_ENDPOINT_URL_S3: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_S3_FORCE_PATH_STYLE: "true",
    AWS_REGION: "us-east-1",
    WALG_COMPRESSION_METHOD: config.BACKUP_COMPRESSION,
    WALG_LIBSODIUM_KEY: config.BACKUP_ENCRYPTION_KEY_HEX,
  };
  if (config.BACKUP_PRIMARY_S3_ACCESS_KEY) {
    env.AWS_ACCESS_KEY_ID = config.BACKUP_PRIMARY_S3_ACCESS_KEY;
  }
  if (config.BACKUP_PRIMARY_S3_SECRET_KEY) {
    env.AWS_SECRET_ACCESS_KEY = config.BACKUP_PRIMARY_S3_SECRET_KEY;
  }
  if (config.PG_PRIMARY_PASSWORD) {
    env.PGPASSWORD = config.PG_PRIMARY_PASSWORD;
  }
  return env;
};

const psqlEnvironment = (config: BackupDaemonConfig): Record<string, string> =>
  config.PG_PRIMARY_PASSWORD ? { PGPASSWORD: config.PG_PRIMARY_PASSWORD } : {};

/** Barman connects with the replication role and PGPASSFILE, not the app password. */
const barmanEnvironment = (): Record<string, string> => ({});

export const buildWalGBaseBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["backup-push", backupDataDir(config, target)],
  env: walGEnvironment(config, target),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGDeltaBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["backup-push", "--delta", backupDataDir(config, target)],
  env: walGEnvironment(config, target),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget,
  kind: BackupKind,
): BuiltCommand =>
  kind === "delta" ? buildWalGDeltaBackupCommand(config, target) : buildWalGBaseBackupCommand(config, target);

export const buildWalGListBackupsCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["backup-list", "--json"],
  env: walGEnvironment(config, target),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGMirrorCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand | null => {
  if (!config.BACKUP_SECONDARY_SSH_TARGET) return null;
  const source = walGS3Prefix(config, target);
  const destination = config.BACKUP_SECONDARY_SSH_TARGET;
  if (source.startsWith("s3://") || destination.startsWith("s3://") || destination.startsWith("rclone:")) {
    return {
      command: "rclone",
      // copy never deletes at the destination; true mirroring (sync) is an explicit opt-in.
      args: [config.BACKUP_SECONDARY_MIRROR_DELETE ? "sync" : "copy", source, destination],
      env: walGEnvironment(config, target),
      timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
    };
  }
  return {
    command: "rsync",
    args: ["-a", ...(config.BACKUP_SECONDARY_MIRROR_DELETE ? ["--delete"] : []), `${trimTrailingSlash(source)}/`, `${trimTrailingSlash(destination)}/`],
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const buildWalGVerifyBucketCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["st", "ls"],
  env: walGEnvironment(config, target),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGPruneCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
  policy?: BackupPolicyView,
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["delete", "retain", "FULL", String(retentionCount(config, policy)), "--confirm"],
  env: walGEnvironment(config, target),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const WAL_LAG_QUERY =
  "SELECT COALESCE(pg_last_wal_replay_lsn(), pg_last_wal_receive_lsn())::text AS last_replayed_lsn, pg_current_wal_lsn()::text AS current_lsn;";

/**
 * `last_archived_wal` is a segment FILE NAME, so it is returned as text and the
 * byte lag is computed from segment numbers in code (walNames.archiveLagBytes);
 * it is never fed to pg_wal_lsn_diff(). Row format (psql -A -t, `|` separated):
 * last_archived_wal | lag_seconds | archived_count | failed_count | current_lsn | current_wal_file | failing
 */
export const WAL_ARCHIVE_STATUS_QUERY =
  "SELECT COALESCE(last_archived_wal, '') AS last_archived_wal, " +
  "CASE WHEN last_archived_time IS NULL THEN 0 " +
  "ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - last_archived_time))))::bigint END::text AS lag_seconds, " +
  "COALESCE(archived_count, 0)::text AS archived_count, " +
  "COALESCE(failed_count, 0)::text AS failed_count, " +
  "pg_current_wal_lsn()::text AS current_lsn, " +
  "pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file, " +
  "(last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))::text AS failing " +
  "FROM pg_stat_archiver;";

export interface ReplicaEndpoint {
  id: string;
  host: string;
  port: number;
}

/**
 * Parses the deployment node format `nodeId@sshHost:sshPort:privateIp:servicePort`
 * as well as plain `host` / `host:port` entries.
 */
export const parseReplicaNodes = (value: string): ReplicaEndpoint[] => {
  const entries: ReplicaEndpoint[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const withoutNodeId = entry.includes("@") ? entry.slice(entry.indexOf("@") + 1) : entry;
    const pieces = withoutNodeId.split(":");
    const id = entry.includes("@") ? entry.slice(0, entry.indexOf("@")) : withoutNodeId;
    if (pieces.length >= 4) {
      const host = pieces[2] ?? "";
      const portValue = Number(pieces[3]);
      if (host) entries.push({ id, host, port: Number.isInteger(portValue) ? portValue : 5432 });
    } else if (pieces.length >= 2) {
      const host = pieces[0] ?? "";
      const portValue = Number(pieces[1]);
      if (host) entries.push({ id, host, port: Number.isInteger(portValue) ? portValue : 5432 });
    } else if (pieces[0]) {
      entries.push({ id, host: pieces[0], port: 5432 });
    }
  }
  return entries;
};

const primaryEndpoint = (config: BackupDaemonConfig): ReplicaEndpoint => {
  const replica = parseReplicaNodes(config.PG_REPLICA_NODES)[0];
  return replica ?? { id: "primary", host: config.PG_PRIMARY_HOST, port: config.PG_PRIMARY_PORT };
};

export const buildPsqlCommand = (
  config: BackupDaemonConfig,
  query: string,
  database: string,
  endpoint: ReplicaEndpoint = { id: "primary", host: config.PG_PRIMARY_HOST, port: config.PG_PRIMARY_PORT },
  /** Role to connect as; defaults to the primary role. A dedicated audit cluster has its own roles. */
  user: string = config.PG_PRIMARY_USER,
): BuiltCommand => ({
  command: `${trimTrailingSlash(config.PG_BIN_DIR)}/psql`,
  args: [
    "-h",
    endpoint.host,
    "-p",
    String(endpoint.port),
    "-U",
    user,
    "-d",
    database,
    "-X",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  ],
  env: psqlEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGLagQueryCommand = (
  config: BackupDaemonConfig,
  replica: ReplicaEndpoint = primaryEndpoint(config),
): BuiltCommand => buildPsqlCommand(config, WAL_LAG_QUERY, config.PG_PRIMARY_DB_NAME, replica);

export const buildWalGArchiveStatusCommand = (config: BackupDaemonConfig): BuiltCommand =>
  buildPsqlCommand(config, WAL_ARCHIVE_STATUS_QUERY, config.PG_PRIMARY_DB_NAME, {
    id: "primary",
    host: config.PG_PRIMARY_HOST,
    port: config.PG_PRIMARY_PORT,
  });

export const barmanServerName = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): string =>
  target === "audit_db"
    ? (config.BARMAN_AUDIT_SERVER ?? config.PG_AUDIT_DB_NAME)
    : (config.BARMAN_SERVER ?? config.PG_PRIMARY_HOST);

export const buildBarmanCheckCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: ["check", barmanServerName(config, target)],
  env: barmanEnvironment(),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanBackupCommand = (
  config: BackupDaemonConfig,
  kind: BackupKind,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args:
    kind === "delta"
      ? ["backup", "--incremental", barmanServerName(config, target)]
      : ["backup", barmanServerName(config, target)],
  env: barmanEnvironment(),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanListBackupsCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: ["list-backup", barmanServerName(config, target)],
  env: barmanEnvironment(),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanRecoverCommand = (
  config: BackupDaemonConfig,
  backupId: string,
  targetDir: string,
  targetTime: Date,
  target: BackupTarget = "postgres_core",
  latest = false,
): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: [
    "recover",
    barmanServerName(config, target),
    backupId,
    targetDir,
    ...(latest ? [] : ["--target-time", targetTime.toISOString()]),
  ],
  env: barmanEnvironment(),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanCloudBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.BARMAN_CLOUD_BIN,
  args: [
    "--cloud-provider",
    "aws-s3",
    "--endpoint-url",
    config.BACKUP_PRIMARY_S3_ENDPOINT,
    config.BACKUP_PRIMARY_S3_BUCKET,
    barmanServerName(config, target),
  ],
  env: walGEnvironment(config, target),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

const redisCliConnection = (config: BackupDaemonConfig): { args: string[]; env: Record<string, string> } | null => {
  if (!config.REDIS_URL) return null;
  try {
    const url = new URL(config.REDIS_URL);
    return {
      args: ["-h", url.hostname, "-p", url.port || "6379"],
      env: url.password ? { REDISCLI_AUTH: decodeURIComponent(url.password) } : {},
    };
  } catch {
    return null;
  }
};

export const buildRedisSnapshotCommand = (config: BackupDaemonConfig): BuiltCommand | null => {
  const connection = redisCliConnection(config);
  if (!connection) return null;
  return {
    command: config.REDIS_CLI_BIN,
    args: [...connection.args, "BGSAVE"],
    env: connection.env,
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const buildRedisRdbCommand = (
  config: BackupDaemonConfig,
  path: string,
): BuiltCommand | null => {
  const connection = redisCliConnection(config);
  if (!connection) return null;
  return {
    command: config.REDIS_CLI_BIN,
    args: [...connection.args, "--rdb", path],
    env: connection.env,
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const buildRedisUploadCommand = (
  config: BackupDaemonConfig,
  sourcePath: string,
): BuiltCommand => ({
  command: "rclone",
  args: ["copyto", sourcePath, `${walGS3Prefix(config, "postgres_core")}/redis/dump.rdb`],
  env: walGEnvironment(config, "postgres_core"),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildRedisPingCommand = (config: BackupDaemonConfig): BuiltCommand | null => {
  const connection = redisCliConnection(config);
  if (!connection) return null;
  return {
    command: config.REDIS_CLI_BIN,
    args: [...connection.args, "PING"],
    env: connection.env,
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const buildSecondaryTargetCheckCommand = (config: BackupDaemonConfig): BuiltCommand | null => {
  if (!config.BACKUP_SECONDARY_SSH_TARGET) return null;
  const target = config.BACKUP_SECONDARY_SSH_TARGET;
  if (target.startsWith("s3://") || target.startsWith("rclone:")) {
    return {
      command: "rclone",
      args: ["lsd", target.startsWith("rclone:") ? target.slice("rclone:".length) : target],
      env: walGEnvironment(config),
      timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
    };
  }
  const hostPart = target.slice(0, target.lastIndexOf(":")) || target;
  return {
    command: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", hostPart, "true"],
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const parseWalGBackupList = (stdout: string): BackupSummary[] => {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    const backupId = String(record.backup_name ?? record.backupName ?? record.name ?? "");
    if (!backupId) return [];
    const startedAt = new Date(
      String(record.time ?? record.start_time ?? record.startTime ?? new Date(0).toISOString()),
    );
    const completedAtValue = record.finish_time ?? record.finishTime;
    const sizeValue = record.size ?? record.size_bytes ?? record.sizeBytes;
    const startLsn = record.start_lsn ?? record.startLsn;
    const endLsn = record.end_lsn ?? record.endLsn;
    return [
      {
        backupId,
        startedAt: Number.isNaN(startedAt.getTime()) ? new Date(0).toISOString() : startedAt.toISOString(),
        completedAt:
          completedAtValue === undefined || completedAtValue === null
            ? undefined
            : new Date(String(completedAtValue)).toISOString(),
        sizeBytes: sizeValue === undefined ? undefined : Number(sizeValue),
        startLsn: startLsn === undefined || startLsn === null ? undefined : String(startLsn),
        endLsn: endLsn === undefined || endLsn === null ? undefined : String(endLsn),
      },
    ];
  });
};

export const parseBarmanBackupList = (stdout: string): BackupSummary[] => {
  const summaries: BackupSummary[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/(?:^|\s)(\d{8}T\d{6})(?:\s|$)/);
    if (!match?.[1]) continue;
    const stamp = match[1];
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    const sizeMatch = line.match(/Size:\s*([0-9.]+)\s*([KMGT]?i?B)?/i);
    summaries.push({
      backupId: stamp,
      startedAt: iso,
      completedAt: iso,
      sizeBytes: sizeMatch?.[1] ? Math.round(Number(sizeMatch[1])) : undefined,
    });
  }
  return summaries;
};

export const parseFieldRow = (stdout: string): string[] =>
  stdout
    .trim()
    .split(/\r?\n/)[0]
    ?.split("|")
    .map((value) => value.trim()) ?? [];


export const errorText = (result: CommandResult): string =>
  (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 500);

export const runChecked = async (
  runner: CommandRunner,
  command: BuiltCommand,
  target: BackupTarget,
  kind: BackupKind,
): Promise<CommandResult> => {
  let result: CommandResult;
  try {
    result = await runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
  } catch (error) {
    throw new BackupEngineError(
      `${command.command} failed: ${error instanceof Error ? error.message : String(error)}`,
      target,
      kind,
    );
  }
  if (result.code !== 0) {
    throw new BackupEngineError(`${command.command} failed: ${errorText(result)}`, target, kind);
  }
  return result;
};

export const emptyWalHealth = (): WalHealth => ({
  archiveLagSeconds: 0,
  currentLsn: "",
  lastArchivedLsn: "",
  lagBytes: 0,
});

export const walHealthFor = async (config: BackupDaemonConfig, runner: CommandRunner): Promise<WalHealth> => {
  const health = emptyWalHealth();
  try {
    const lagResult = await runner.run(buildWalGLagQueryCommand(config).command, buildWalGLagQueryCommand(config).args, {
      env: buildWalGLagQueryCommand(config).env,
      timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
    });
    if (lagResult.code === 0) {
      const [lastReplayed = "", current = ""] = parseFieldRow(lagResult.stdout);
      health.currentLsn = current;
      health.lastArchivedLsn = lastReplayed;
    }
  } catch {
    // Health is best-effort. The target detail records the failure.
  }
  try {
    const archiveCommand = buildWalGArchiveStatusCommand(config);
    const archiveResult = await runner.run(archiveCommand.command, archiveCommand.args, {
      env: archiveCommand.env,
      timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
    });
    if (archiveResult.code === 0) {
      const status = parseWalArchiveStatus(archiveResult.stdout);
      health.lastArchivedLsn = status.lastArchivedWal || health.lastArchivedLsn;
      if (status.currentLsn) health.currentLsn = status.currentLsn;
      health.archiveLagSeconds = status.lagSeconds;
      health.lagBytes = status.lagBytes;
    }
  } catch {
    // Keep the LSN values from the replica query, with a zeroed lag.
  }
  return health;
};

export const checkTarget = async (
  runner: CommandRunner,
  id: string,
  name: string,
  kind: BackupStorageTarget["kind"],
  command: BuiltCommand,
): Promise<BackupStorageTarget> => {
  try {
    const result = await runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    return {
      id,
      name,
      kind,
      healthy: result.code === 0,
      detail: result.code === 0 ? "reachable" : errorText(result),
    };
  } catch (error) {
    return {
      id,
      name,
      kind,
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

export const optionalTargetChecks = (config: BackupDaemonConfig, runner: CommandRunner): Array<Promise<BackupStorageTarget>> => {
  const checks: Array<Promise<BackupStorageTarget>> = [];
  const secondary = buildSecondaryTargetCheckCommand(config);
  if (secondary) {
    checks.push(checkTarget(runner, "secondary-ssh", "Secondary Off-site Target", "ssh", secondary));
  }
  const redis = buildRedisPingCommand(config);
  if (redis) {
    checks.push(checkTarget(runner, "redis", "Redis Snapshots", "redis", redis));
  }
  return checks;
};

const triggerRedisSnapshot = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  target: BackupTarget,
  kind: BackupKind,
): Promise<string[]> => {
  const snapshot = buildRedisSnapshotCommand(config);
  if (!snapshot) throw new BackupEngineError("REDIS_URL is not configured", target, kind);
  await runChecked(runner, snapshot, target, kind);

  const dumpPath = join(tmpdir(), `pg-backup-redis-${randomUUID()}.rdb`);
  const rdb = buildRedisRdbCommand(config, dumpPath);
  if (!rdb) throw new BackupEngineError("REDIS_URL is not configured", target, kind);

  try {
    await runChecked(runner, rdb, target, kind);
    const upload = buildRedisUploadCommand(config, dumpPath);
    try {
      await runChecked(runner, upload, target, kind);
    } catch (error) {
      throw new BackupEngineError(
        `Redis snapshot upload requires rclone and a reachable core S3 prefix: ${
          error instanceof Error ? error.message : String(error)
        }`,
        target,
        kind,
      );
    }
    return ["redis", "primary-s3"];
  } finally {
    await nodeFs.rm(dumpPath, { force: true }).catch(() => undefined);
  }
};

const triggerWalGTarget = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  target: BackupTarget,
  kind: BackupKind,
): Promise<string[]> => {
  if (target === "redis") {
    return triggerRedisSnapshot(config, runner, target, kind);
  }

  const backup = buildWalGBackupCommand(config, target, kind);
  let result: CommandResult;
  try {
    result = await runChecked(runner, backup, target, kind);
  } catch (error) {
    if (kind === "delta" && error instanceof BackupEngineError) {
      // WAL-G delta backups require a prior base backup. Surface that clearly
      // instead of silently turning a requested delta into a full backup.
      throw new BackupEngineError(`${error.message} (delta backup may require a base backup)`, target, kind);
    }
    throw error;
  }

  await runChecked(runner, buildWalGVerifyBucketCommand(config, target), target, kind);
  const storageTargets = ["primary-s3"];
  const mirror = buildWalGMirrorCommand(config, target);
  if (mirror) {
    try {
      await runChecked(runner, mirror, target, kind);
      storageTargets.push("secondary-ssh");
    } catch {
      // The secondary vault is optional. A primary WAL-G backup that already
      // succeeded must not be reported as failed because the off-site mirror
      // is misconfigured or temporarily unavailable.
    }
  }

  const startLsn = parseFieldRow(result.stdout)[0];
  return startLsn ? [...storageTargets, `start-lsn:${startLsn}`] : storageTargets;
};

/** Lazily builds the logical-dump service (and its storage tiers) the first time a shared audit target needs it. */
const lazyDumper = (config: BackupDaemonConfig, runner: CommandRunner, deps: EngineDeps): (() => LogicalDumper) => {
  let dumper: LogicalDumper | undefined;
  return () => {
    dumper ??= new LogicalDumper({
      config,
      runner,
      repository: deps.repository ?? buildRepository(config, runner),
      master: masterKeyFromHex(config.BACKUP_ENCRYPTION_KEY_HEX),
      clock: deps.clock,
    });
    return dumper;
  };
};

export class WalGEngine implements BackupEngine {
  private readonly dumper: () => LogicalDumper;

  constructor(
    private readonly config: BackupDaemonConfig,
    private readonly runner: CommandRunner,
    private readonly deps: EngineDeps = {},
  ) {
    this.dumper = lazyDumper(config, runner, deps);
  }

  public restoreLogical(request: RecoverLogicalRequest): Promise<{ restored: boolean; detail: string }> {
    return this.dumper().restoreLatest(request);
  }

  public async overviewHealth(): Promise<EngineHealth> {
    const targets = await Promise.all([
      checkTarget(
        this.runner,
        "primary-s3",
        "Primary S3 Bucket",
        "s3",
        buildWalGVerifyBucketCommand(this.config),
      ),
      checkTarget(
        this.runner,
        "postgres-primary",
        "PostgreSQL Primary",
        "database",
        buildPsqlCommand(this.config, "SELECT 1;", this.config.PG_PRIMARY_DB_NAME),
      ),
      ...optionalTargetChecks(this.config, this.runner),
    ]);

    const wal = await walHealthFor(this.config, this.runner);
    const healthy =
      targets.every((target) => target.healthy) && wal.archiveLagSeconds <= this.config.BACKUP_ALERT_LAG_SECONDS;
    return { healthy, wal, targets };
  }

  public async triggerBackup(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult> {
    const requested = expandTargets(this.config, target);
    const storageTargets = new Set<string>();

    for (const requestedTarget of requested) {
      if (requestedTarget === "audit_db" && !isAuditDedicatedCluster(this.config)) {
        // Shared cluster: the audit database is inside the core physical backup; take a standalone logical dump.
        const audit = await this.dumper().backupSharedAudit({ engine: "wal-g", skipIfMissing: target === "all" });
        for (const id of audit.storageTargets) storageTargets.add(id);
        continue;
      }
      for (const storageTarget of await triggerWalGTarget(this.config, this.runner, requestedTarget, kind)) {
        if (!storageTarget.startsWith("start-lsn:")) storageTargets.add(storageTarget);
      }
    }

    return { storageTargets: [...storageTargets] };
  }

  public async listBackups(
    limit: number,
    target: BackupTarget = "postgres_core",
  ): Promise<BackupSummary[]> {
    const command = buildWalGListBackupsCommand(this.config, target);
    const result = await this.runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    if (result.code !== 0) throw new BackupEngineError(`backup-list failed: ${errorText(result)}`, target, "full");
    return parseWalGBackupList(result.stdout).slice(0, Math.max(0, limit));
  }

  public async recover(request: RecoverRequest): Promise<RecoverResult> {
    const env = walGEnvironment(this.config, request.target);
    const fetch = await this.runner.run(this.config.WALG_BIN, ["backup-fetch", request.targetDir, "LATEST"], {
      env,
      timeoutMs: this.config.BACKUP_COMMAND_TIMEOUT_MS,
    });
    if (fetch.code !== 0) {
      throw new BackupEngineError(`backup-fetch failed: ${errorText(fetch)}`, request.target, "full");
    }
    const escapedTargetTime = pgRecoveryTimestamp(request.targetTime);
    // restore_command is a postgresql.conf single-quoted literal: every inner
    // single quote MUST be doubled. With WALG_ENV_FILE configured the secrets
    // stay in that 0640 file and only the (non-secret) prefix is on the line.
    const walgEnvFile = request.target === "audit_db"
      ? (this.config.WALG_ENV_FILE_AUDIT ?? this.config.WALG_ENV_FILE)
      : this.config.WALG_ENV_FILE;
    const walFetch = walgEnvFile
      ? `WALG_S3_PREFIX=${shellQuote(env.WALG_S3_PREFIX ?? "")} sh -c ${shellQuote(`set -a; . ${shellQuote(walgEnvFile)}; exec ${shellQuote(this.config.WALG_BIN)} wal-fetch %f %p`)}`
      : `${Object.entries(env)
        .filter(([key]) => key.startsWith("WALG_") || key.startsWith("AWS_"))
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join(" ")} ${shellQuote(this.config.WALG_BIN)} wal-fetch %f %p`;
    const restoreCommand = walFetch.replace(/'/g, "''");
    return {
      recoveryConf:
        `restore_command = '${restoreCommand}'\n` +
        (request.latest
          ? ""
          : `recovery_target_time = '${escapedTargetTime}'\n` + "recovery_target_action = 'promote'\n"),
    };
  }

  public async prune(target: BackupTarget, kind: BackupKind = "full"): Promise<void> {
    if (kind !== "full") return;
    const policy = this.deps.getPolicy?.();
    // The shared audit database has no WAL-G backup set of its own to prune.
    const wantsAudit = isAuditDedicatedCluster(this.config);
    const targets: BackupTarget[] =
      target === "all"
        ? ["postgres_core", ...(wantsAudit ? (["audit_db"] as const) : [])]
        : target === "redis" || (target === "audit_db" && !wantsAudit)
          ? []
          : [target];
    for (const pruneTarget of targets) {
      const command = buildWalGPruneCommand(this.config, pruneTarget, policy);
      await runChecked(this.runner, command, pruneTarget, kind);
    }
  }
}

const triggerBarmanTarget = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  target: BackupTarget,
  kind: BackupKind,
): Promise<string[]> => {
  if (target === "redis") {
    return triggerRedisSnapshot(config, runner, target, kind);
  }
  await runChecked(runner, buildBarmanCheckCommand(config, target), target, kind);
  await runChecked(runner, buildBarmanBackupCommand(config, kind, target), target, kind);
  await runChecked(runner, buildBarmanCloudBackupCommand(config, target), target, kind);
  return ["primary-s3"];
};

export class BarmanEngine implements BackupEngine {
  private readonly dumper: () => LogicalDumper;

  constructor(
    private readonly config: BackupDaemonConfig,
    private readonly runner: CommandRunner,
    private readonly deps: EngineDeps = {},
  ) {
    this.dumper = lazyDumper(config, runner, deps);
  }

  public restoreLogical(request: RecoverLogicalRequest): Promise<{ restored: boolean; detail: string }> {
    return this.dumper().restoreLatest(request);
  }

  /**
   * S3 reachability for Barman is proven with the daemon's own S3 client (write,
   * read back, delete). It must never call WAL-G: a Barman-only host has no
   * wal-g binary and used to report its object store unhealthy forever.
   */
  private async s3Target(): Promise<BackupStorageTarget> {
    try {
      const repository = this.deps.repository ?? buildRepository(this.config, this.runner);
      const store = repository.stores.find((candidate) => candidate.kind === "s3");
      if (!store) return { id: "primary-s3", name: "Primary S3 Bucket", kind: "s3", healthy: false, detail: "no S3 target is configured" };
      const health = await store.health();
      return { id: "primary-s3", name: "Primary S3 Bucket", kind: "s3", healthy: health.healthy, detail: health.detail };
    } catch (error) {
      return { id: "primary-s3", name: "Primary S3 Bucket", kind: "s3", healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  public async overviewHealth(): Promise<EngineHealth> {
    const check = buildBarmanCheckCommand(this.config);
    const targets = await Promise.all([
      checkTarget(this.runner, "barman", "Barman Backup Server", "ssh", check),
      ...(isAuditDedicatedCluster(this.config)
        ? [checkTarget(this.runner, "barman-audit", "Barman Audit Server", "ssh", buildBarmanCheckCommand(this.config, "audit_db"))]
        : []),
      this.s3Target(),
      checkTarget(
        this.runner,
        "postgres-primary",
        "PostgreSQL Primary",
        "database",
        buildPsqlCommand(this.config, "SELECT 1;", this.config.PG_PRIMARY_DB_NAME),
      ),
      ...optionalTargetChecks(this.config, this.runner),
    ]);

    const wal = await walHealthFor(this.config, this.runner);
    const healthy =
      targets.every((target) => target.healthy) && wal.archiveLagSeconds <= this.config.BACKUP_ALERT_LAG_SECONDS;
    return { healthy, wal, targets };
  }

  public async triggerBackup(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult> {
    const requested = expandTargets(this.config, target);
    const storageTargets = new Set<string>();
    for (const requestedTarget of requested) {
      if (requestedTarget === "audit_db" && !isAuditDedicatedCluster(this.config)) {
        const audit = await this.dumper().backupSharedAudit({ engine: "barman", skipIfMissing: target === "all" });
        for (const id of audit.storageTargets) storageTargets.add(id);
        continue;
      }
      for (const storageTarget of await triggerBarmanTarget(this.config, this.runner, requestedTarget, kind)) {
        storageTargets.add(storageTarget);
      }
    }
    return { storageTargets: [...storageTargets] };
  }

  public async listBackups(
    limit: number,
    target: BackupTarget = "postgres_core",
  ): Promise<BackupSummary[]> {
    const command = buildBarmanListBackupsCommand(this.config, target);
    const result = await this.runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    if (result.code !== 0) throw new BackupEngineError(`list-backup failed: ${errorText(result)}`, target, "full");
    return parseBarmanBackupList(result.stdout).slice(0, Math.max(0, limit));
  }

  public async recover(request: RecoverRequest): Promise<RecoverResult> {
    const backups = await this.listBackups(1, request.target);
    const backupId = backups[0]?.backupId ?? "latest";
    const command = buildBarmanRecoverCommand(
      this.config,
      backupId,
      request.targetDir,
      request.targetTime,
      request.target,
      request.latest === true,
    );
    const result = await this.runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    if (result.code !== 0) {
      throw new BackupEngineError(`barman recover failed: ${errorText(result)}`, request.target, "full");
    }
    return {};
  }

  public async prune(_target: BackupTarget, _kind: BackupKind = "full"): Promise<void> {
    // Barman applies its own retention_policy on the server; no destructive
    // commands are issued by the daemon.
  }
}

export const createBackupEngine = (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  deps: EngineDeps = {},
): BackupEngine => {
  switch (config.BACKUP_ENGINE_MODE) {
    case "pg-native":
      return new PgNativeEngine(config, runner, deps);
    case "wal-g":
      return new WalGEngine(config, runner, deps);
    default:
      return new BarmanEngine(config, runner, deps);
  }
};
