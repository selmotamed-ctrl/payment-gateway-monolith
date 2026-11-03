import type { BackupDaemonConfig } from "./config";
import type { CommandResult, CommandRunner } from "./commandRunner";

export const BACKUP_TARGETS = ["all", "postgres_core", "audit_db", "redis"] as const;
export type BackupTarget = (typeof BACKUP_TARGETS)[number];

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
  targetTime: Date;
  targetDir: string;
  port: number;
}

export interface RecoverResult {
  replayedLsn?: string;
  recoveryConf?: string;
}

export interface BackupEngine {
  overviewHealth(): Promise<EngineHealth>;
  triggerBackup(target: BackupTarget, kind: BackupKind): Promise<BackupExecutionResult>;
  listBackups(limit: number): Promise<BackupSummary[]>;
  latestDrill?(): Promise<unknown | null>;
  recover?(request: RecoverRequest): Promise<RecoverResult>;
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

export const backupDataDir = (config: BackupDaemonConfig, target: BackupTarget): string => {
  if (target === "audit_db") return config.PG_AUDIT_DATA_DIR ?? config.PG_DATA_DIR;
  return config.PG_DATA_DIR;
};

export const walGEnvironment = (config: BackupDaemonConfig): Record<string, string> => {
  const env: Record<string, string> = {
    WALG_S3_PREFIX: config.BACKUP_PRIMARY_S3_BUCKET,
    AWS_ENDPOINT_URL: config.BACKUP_PRIMARY_S3_ENDPOINT,
    AWS_ENDPOINT_URL_S3: config.BACKUP_PRIMARY_S3_ENDPOINT,
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

export const buildWalGBaseBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["backup-push", backupDataDir(config, target)],
  env: walGEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGDeltaBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget = "postgres_core",
): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["backup-push", "--delta", backupDataDir(config, target)],
  env: walGEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGBackupCommand = (
  config: BackupDaemonConfig,
  target: BackupTarget,
  kind: BackupKind,
): BuiltCommand =>
  kind === "delta" ? buildWalGDeltaBackupCommand(config, target) : buildWalGBaseBackupCommand(config, target);

export const buildWalGListBackupsCommand = (config: BackupDaemonConfig): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["backup-list", "--json"],
  env: walGEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildWalGMirrorCommand = (
  config: BackupDaemonConfig,
  source: string = config.BACKUP_PRIMARY_S3_BUCKET,
): BuiltCommand | null => {
  if (!config.BACKUP_SECONDARY_SSH_TARGET) return null;
  const destination = config.BACKUP_SECONDARY_SSH_TARGET;
  if (source.startsWith("s3://") || destination.startsWith("s3://") || destination.startsWith("rclone:")) {
    return {
      command: "rclone",
      args: ["sync", source, destination],
      env: walGEnvironment(config),
      timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
    };
  }
  return {
    command: "rsync",
    args: ["-a", "--delete", `${trimTrailingSlash(source)}/`, `${trimTrailingSlash(destination)}/`],
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const buildWalGVerifyBucketCommand = (config: BackupDaemonConfig): BuiltCommand => ({
  command: config.WALG_BIN,
  args: ["st", "ls", config.BACKUP_PRIMARY_S3_BUCKET],
  env: walGEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const WAL_LAG_QUERY =
  "SELECT COALESCE(pg_last_wal_replay_lsn(), pg_last_wal_receive_lsn())::text AS last_replayed_lsn, pg_current_wal_lsn()::text AS current_lsn;";

export const WAL_ARCHIVE_STATUS_QUERY =
  "SELECT COALESCE(last_archived_wal, '') AS last_archived_lsn, " +
  "COALESCE(EXTRACT(EPOCH FROM (now() - last_archived_time)), 0)::text AS lag_seconds, " +
  "COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), last_archived_wal), 0)::text AS lag_bytes " +
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
): BuiltCommand => ({
  command: `${trimTrailingSlash(config.PG_BIN_DIR)}/psql`,
  args: [
    "-h",
    endpoint.host,
    "-p",
    String(endpoint.port),
    "-U",
    config.PG_PRIMARY_USER,
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

export const barmanServerName = (config: BackupDaemonConfig): string =>
  config.BARMAN_SERVER ?? config.PG_PRIMARY_HOST;

export const buildBarmanCheckCommand = (config: BackupDaemonConfig): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: ["check", barmanServerName(config)],
  env: psqlEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanBackupCommand = (
  config: BackupDaemonConfig,
  kind: BackupKind,
): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: kind === "delta" ? ["backup", "--incremental", barmanServerName(config)] : ["backup", barmanServerName(config)],
  env: psqlEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanListBackupsCommand = (config: BackupDaemonConfig): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: ["list-backup", barmanServerName(config)],
  env: psqlEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanRecoverCommand = (
  config: BackupDaemonConfig,
  backupId: string,
  targetDir: string,
  targetTime: Date,
): BuiltCommand => ({
  command: config.BARMAN_BIN,
  args: [
    "recover",
    barmanServerName(config),
    backupId,
    targetDir,
    "--target-time",
    targetTime.toISOString(),
  ],
  env: psqlEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildBarmanCloudBackupCommand = (config: BackupDaemonConfig): BuiltCommand => ({
  command: config.BARMAN_CLOUD_BIN,
  args: [
    "--cloud-provider",
    "aws-s3",
    "--endpoint-url",
    config.BACKUP_PRIMARY_S3_ENDPOINT,
    config.BACKUP_PRIMARY_S3_BUCKET,
    barmanServerName(config),
  ],
  env: walGEnvironment(config),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildRedisSnapshotCommand = (config: BackupDaemonConfig): BuiltCommand | null => {
  if (!config.REDIS_URL) return null;
  return {
    command: config.REDIS_CLI_BIN,
    args: ["-u", config.REDIS_URL, "BGSAVE"],
    timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  };
};

export const buildRedisPingCommand = (config: BackupDaemonConfig): BuiltCommand | null => {
  if (!config.REDIS_URL) return null;
  return {
    command: config.REDIS_CLI_BIN,
    args: ["-u", config.REDIS_URL, "PING"],
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

const parseFieldRow = (stdout: string): string[] =>
  stdout
    .trim()
    .split(/\r?\n/)[0]
    ?.split("|")
    .map((value) => value.trim()) ?? [];

const toNumber = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const errorText = (result: CommandResult): string =>
  (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 500);

const runChecked = async (
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

const emptyWalHealth = (): WalHealth => ({
  archiveLagSeconds: 0,
  currentLsn: "",
  lastArchivedLsn: "",
  lagBytes: 0,
});

const walHealthFor = async (config: BackupDaemonConfig, runner: CommandRunner): Promise<WalHealth> => {
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
      const [lastArchived = "", lagSeconds = "0", lagBytes = "0"] = parseFieldRow(archiveResult.stdout);
      health.lastArchivedLsn = lastArchived || health.lastArchivedLsn;
      health.archiveLagSeconds = Math.max(0, Math.round(toNumber(lagSeconds)));
      health.lagBytes = Math.max(0, Math.round(toNumber(lagBytes)));
    }
  } catch {
    // Keep the LSN values from the replica query, with a zeroed lag.
  }
  return health;
};

const checkTarget = async (
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

const optionalTargetChecks = (config: BackupDaemonConfig, runner: CommandRunner): Array<Promise<BackupStorageTarget>> => {
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

const triggerWalGTarget = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  target: BackupTarget,
  kind: BackupKind,
): Promise<string[]> => {
  if (target === "redis") {
    const redis = buildRedisSnapshotCommand(config);
    if (!redis) throw new BackupEngineError("REDIS_URL is not configured", target, kind);
    await runChecked(runner, redis, target, kind);
    return ["redis"];
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

  await runChecked(runner, buildWalGVerifyBucketCommand(config), target, kind);
  const storageTargets = ["primary-s3"];
  const mirror = buildWalGMirrorCommand(config);
  if (mirror) {
    await runChecked(runner, mirror, target, kind);
    storageTargets.push("secondary-ssh");
  }

  const startLsn = parseFieldRow(result.stdout)[0];
  return startLsn ? [...storageTargets, `start-lsn:${startLsn}`] : storageTargets;
};

export class WalGEngine implements BackupEngine {
  constructor(
    private readonly config: BackupDaemonConfig,
    private readonly runner: CommandRunner,
  ) {}

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
    const requested: BackupTarget[] =
      target === "all" ? (this.config.REDIS_URL ? ["postgres_core", "audit_db", "redis"] : ["postgres_core", "audit_db"]) : [target];
    const storageTargets = new Set<string>();
    const seenDataDirs = new Set<string>();

    for (const requestedTarget of requested) {
      if (requestedTarget !== "redis") {
        const dataDir = backupDataDir(this.config, requestedTarget);
        if (seenDataDirs.has(dataDir)) continue;
        seenDataDirs.add(dataDir);
      }
      for (const storageTarget of await triggerWalGTarget(this.config, this.runner, requestedTarget, kind)) {
        if (!storageTarget.startsWith("start-lsn:")) storageTargets.add(storageTarget);
      }
    }

    return { storageTargets: [...storageTargets] };
  }

  public async listBackups(limit: number): Promise<BackupSummary[]> {
    const command = buildWalGListBackupsCommand(this.config);
    const result = await this.runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    if (result.code !== 0) throw new BackupEngineError(`backup-list failed: ${errorText(result)}`, "all", "full");
    return parseWalGBackupList(result.stdout).slice(0, Math.max(0, limit));
  }

  public async recover(request: RecoverRequest): Promise<RecoverResult> {
    const env = walGEnvironment(this.config);
    const fetch = await this.runner.run(this.config.WALG_BIN, ["backup-fetch", request.targetDir, "LATEST"], {
      env,
      timeoutMs: this.config.BACKUP_COMMAND_TIMEOUT_MS,
    });
    if (fetch.code !== 0) {
      throw new BackupEngineError(`backup-fetch failed: ${errorText(fetch)}`, "postgres_core", "full");
    }
    const escapedTargetTime = request.targetTime.toISOString().replace(/'/g, "''");
    return {
      recoveryConf:
        `restore_command = '${this.config.WALG_BIN} wal-fetch %f %p'\n` +
        `recovery_target_time = '${escapedTargetTime}'\n` +
        "recovery_target_action = 'promote'\n",
    };
  }
}

const triggerBarmanTarget = async (
  config: BackupDaemonConfig,
  runner: CommandRunner,
  target: BackupTarget,
  kind: BackupKind,
): Promise<string[]> => {
  if (target === "redis") {
    const redis = buildRedisSnapshotCommand(config);
    if (!redis) throw new BackupEngineError("REDIS_URL is not configured", target, kind);
    await runChecked(runner, redis, target, kind);
    return ["redis"];
  }
  await runChecked(runner, buildBarmanCheckCommand(config), target, kind);
  await runChecked(runner, buildBarmanBackupCommand(config, kind), target, kind);
  await runChecked(runner, buildBarmanCloudBackupCommand(config), target, kind);
  return ["primary-s3"];
};

export class BarmanEngine implements BackupEngine {
  constructor(
    private readonly config: BackupDaemonConfig,
    private readonly runner: CommandRunner,
  ) {}

  public async overviewHealth(): Promise<EngineHealth> {
    const check = buildBarmanCheckCommand(this.config);
    const targets = await Promise.all([
      checkTarget(this.runner, "barman", "Barman Backup Server", "ssh", check),
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
    const requested: BackupTarget[] =
      target === "all" ? (this.config.REDIS_URL ? ["postgres_core", "audit_db", "redis"] : ["postgres_core", "audit_db"]) : [target];
    const storageTargets = new Set<string>();
    const seenDataDirs = new Set<string>();
    for (const requestedTarget of requested) {
      if (requestedTarget !== "redis") {
        const dataDir = backupDataDir(this.config, requestedTarget);
        if (seenDataDirs.has(dataDir)) continue;
        seenDataDirs.add(dataDir);
      }
      for (const storageTarget of await triggerBarmanTarget(this.config, this.runner, requestedTarget, kind)) {
        storageTargets.add(storageTarget);
      }
    }
    return { storageTargets: [...storageTargets] };
  }

  public async listBackups(limit: number): Promise<BackupSummary[]> {
    const command = buildBarmanListBackupsCommand(this.config);
    const result = await this.runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    if (result.code !== 0) throw new BackupEngineError(`list-backup failed: ${errorText(result)}`, "all", "full");
    return parseBarmanBackupList(result.stdout).slice(0, Math.max(0, limit));
  }

  public async recover(request: RecoverRequest): Promise<RecoverResult> {
    const backups = await this.listBackups(1);
    const backupId = backups[0]?.backupId ?? "latest";
    const command = buildBarmanRecoverCommand(this.config, backupId, request.targetDir, request.targetTime);
    const result = await this.runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs,
    });
    if (result.code !== 0) {
      throw new BackupEngineError(`barman recover failed: ${errorText(result)}`, "postgres_core", "full");
    }
    return {};
  }
}

export const createBackupEngine = (config: BackupDaemonConfig, runner: CommandRunner): BackupEngine =>
  config.BACKUP_ENGINE_MODE === "wal-g" ? new WalGEngine(config, runner) : new BarmanEngine(config, runner);
