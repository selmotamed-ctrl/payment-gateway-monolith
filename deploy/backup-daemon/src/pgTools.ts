import { join } from "node:path";
import type { BackupDaemonConfig } from "./config";
import { auditEndpoint, replicationCredentials } from "./config";
import type { CommandResult, CommandRunner } from "./commandRunner";

/**
 * Pure builders for the PostgreSQL 18 client tools the native engine drives.
 * Passwords only ever travel in the child's environment (PGPASSWORD), never on
 * the command line, so they cannot show up in `ps` or in error text.
 */

export interface PgEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface ToolCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export type PgCluster = "core" | "audit";

export const pgBin = (config: BackupDaemonConfig, tool: string): string => join(config.PG_BIN_DIR, tool);

export const connectionEnv = (config: BackupDaemonConfig, password: string, sslmode = config.PG_SSLMODE): Record<string, string> => ({
  ...(password ? { PGPASSWORD: password } : {}),
  PGSSLMODE: sslmode,
  PGCONNECT_TIMEOUT: "15",
  PGAPPNAME: "pg-backup-daemon",
});

/** The core cluster and (when dedicated) the audit cluster, as seen by the replication tools. */
export const replicationEndpoint = (config: BackupDaemonConfig, cluster: PgCluster): PgEndpoint => {
  const credentials = replicationCredentials(config);
  if (cluster === "audit") {
    const audit = auditEndpoint(config);
    return { host: audit.host, port: audit.port, user: credentials.user, password: credentials.password };
  }
  return { host: config.PG_PRIMARY_HOST, port: config.PG_PRIMARY_PORT, user: credentials.user, password: credentials.password };
};

export const sqlEndpoint = (config: BackupDaemonConfig, cluster: PgCluster): PgEndpoint =>
  cluster === "audit"
    ? auditEndpoint(config)
    : { host: config.PG_PRIMARY_HOST, port: config.PG_PRIMARY_PORT, user: config.PG_PRIMARY_USER, password: config.PG_PRIMARY_PASSWORD };

const base = (config: BackupDaemonConfig, tool: string, endpoint: PgEndpoint): ToolCommand & { connection: string[] } => ({
  command: pgBin(config, tool),
  args: [],
  env: connectionEnv(config, endpoint.password),
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
  connection: ["-h", endpoint.host, "-p", String(endpoint.port), "-U", endpoint.user, "-w"],
});

export interface BaseBackupOptions {
  destination: string;
  label: string;
  /** Path to the previous backup's `backup_manifest` (PostgreSQL 17+ incremental backup). */
  incrementalFrom?: string;
}

export const buildBaseBackupCommand = (
  config: BackupDaemonConfig,
  cluster: PgCluster,
  options: BaseBackupOptions,
): ToolCommand => {
  const built = base(config, "pg_basebackup", replicationEndpoint(config, cluster));
  return {
    command: built.command,
    args: [
      ...built.connection,
      "-D",
      options.destination,
      "--format=tar",
      "--checkpoint=fast",
      "--manifest-checksums=SHA256",
      "--wal-method=stream",
      `--label=${options.label}`,
      "--no-password",
      ...(options.incrementalFrom ? [`--incremental=${options.incrementalFrom}`] : []),
    ],
    env: built.env,
    timeoutMs: built.timeoutMs,
  };
};

export const buildVerifyBackupCommand = (config: BackupDaemonConfig, backupDir: string): ToolCommand => ({
  command: pgBin(config, "pg_verifybackup"),
  args: ["--format=tar", backupDir],
  env: {},
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildCombineBackupCommand = (
  config: BackupDaemonConfig,
  inputDirs: string[],
  outputDir: string,
): ToolCommand => ({
  command: pgBin(config, "pg_combinebackup"),
  args: ["-o", outputDir, ...inputDirs],
  env: {},
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildReceiveWalCommand = (
  config: BackupDaemonConfig,
  cluster: PgCluster,
  spoolDir: string,
  slot: string,
): ToolCommand => {
  const built = base(config, "pg_receivewal", replicationEndpoint(config, cluster));
  return {
    command: built.command,
    args: [
      ...built.connection,
      "-D",
      spoolDir,
      `--slot=${slot}`,
      // Flush WAL to disk as it arrives so the .partial file always reflects committed data.
      "--synchronous",
      "--status-interval=1",
      "--no-password",
    ],
    env: built.env,
    timeoutMs: 0,
  };
};

export const buildCreateSlotCommand = (
  config: BackupDaemonConfig,
  cluster: PgCluster,
  slot: string,
): ToolCommand => {
  const built = base(config, "pg_receivewal", replicationEndpoint(config, cluster));
  return {
    command: built.command,
    args: [...built.connection, `--slot=${slot}`, "--create-slot", "--if-not-exists", "--no-password"],
    env: built.env,
    timeoutMs: built.timeoutMs,
  };
};

export const buildDumpCommand = (
  config: BackupDaemonConfig,
  cluster: PgCluster,
  database: string,
  outputFile: string,
): ToolCommand => {
  const endpoint = sqlEndpoint(config, cluster);
  const built = base(config, "pg_dump", endpoint);
  return {
    command: built.command,
    args: [
      "-h",
      endpoint.host,
      "-p",
      String(endpoint.port),
      "-U",
      endpoint.user,
      "-w",
      "-d",
      database,
      "--format=custom",
      "--compress=zstd:6",
      "--no-password",
      "--file",
      outputFile,
    ],
    env: built.env,
    timeoutMs: built.timeoutMs,
  };
};

export const buildRestoreListCommand = (config: BackupDaemonConfig, dumpFile: string): ToolCommand => ({
  command: pgBin(config, "pg_restore"),
  args: ["--list", dumpFile],
  env: {},
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

export const buildRestoreDumpCommand = (
  config: BackupDaemonConfig,
  dumpFile: string,
  target: { host: string; port: number; user: string; database: string },
): ToolCommand => ({
  command: pgBin(config, "pg_restore"),
  args: [
    "-h",
    target.host,
    "-p",
    String(target.port),
    "-U",
    target.user,
    "-d",
    target.database,
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    dumpFile,
  ],
  env: { PGSSLMODE: "prefer" },
  timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
});

/** Runs a built tool command and throws a redaction-friendly error on a non-zero exit. */
export const runTool = async (
  runner: CommandRunner,
  command: ToolCommand,
  label: string,
): Promise<CommandResult> => {
  let result: CommandResult;
  try {
    result = await runner.run(command.command, command.args, {
      env: command.env,
      timeoutMs: command.timeoutMs > 0 ? command.timeoutMs : undefined,
    });
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 500)}`);
  }
  return result;
};
