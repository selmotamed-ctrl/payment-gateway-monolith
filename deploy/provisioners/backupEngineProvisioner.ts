import { dirname } from "node:path";
import { parseNodeList, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { pgClusterFor, type ProvisionReport, type ProvisionRunner } from "./postgres18Provisioner";

/**
 * Backup/PITR engine provisioning.
 *
 * The provisioner installs WAL-G or Barman, wires `archive_command`, writes the
 * pg-backup-daemon environment + systemd unit, verifies primary/secondary
 * storage access and installs the full/delta/drill schedule.
 */

export type BackupTarget = "postgres_core" | "audit_db";

const isAuditTarget = (target: BackupTarget | string): boolean =>
  target === "audit_db" || target === "audit";

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const backupSpec = (config: DeployConfig) => parseNodeList(config.BACKUP_NODE)[0] ?? null;

const backupSsh = (config: DeployConfig): SshTarget | null => {
  const spec = backupSpec(config);
  if (!spec) return null;
  return {
    host: spec.sshHost,
    port: spec.sshPort,
    user: config.BACKUP_SSH_USER,
    keyPath: config.BACKUP_SSH_KEY_PATH ?? "",
    sudoPassword: config.BACKUP_SUDO_PASSWORD,
  };
};

const pgSsh = (config: DeployConfig): SshTarget | null => {
  const spec = parseNodeList(config.PG_PRIMARY_NODE)[0];
  if (!spec) return null;
  return {
    host: spec.sshHost,
    port: spec.sshPort,
    user: config.PG_SSH_USER,
    keyPath: config.PG_SSH_KEY_PATH ?? "",
    sudoPassword: config.PG_SUDO_PASSWORD,
  };
};

const auditSsh = (config: DeployConfig): SshTarget | null => {
  const spec = parseNodeList(config.AUDIT_DB_NODE)[0];
  if (!spec) return null;
  return {
    host: spec.sshHost,
    port: spec.sshPort,
    user: config.AUDIT_DB_SSH_USER,
    keyPath: config.AUDIT_DB_SSH_KEY_PATH ?? "",
    sudoPassword: config.AUDIT_DB_SUDO_PASSWORD,
  };
};

const backupPrivateIp = (config: DeployConfig): string =>
  backupSpec(config)?.privateIp ?? "127.0.0.1";

const daemonBindHost = (config: DeployConfig): string =>
  config.BACKUP_DAEMON_BIND_HOST.trim() || backupPrivateIp(config);

export const backupCoreS3Prefix = (config: DeployConfig): string =>
  config.BACKUP_CORE_S3_PREFIX.trim() || `${trimTrailingSlash(config.BACKUP_PRIMARY_S3_BUCKET)}/postgres_core`;

export const backupAuditS3Prefix = (config: DeployConfig): string =>
  config.BACKUP_AUDIT_S3_PREFIX.trim() || `${trimTrailingSlash(config.BACKUP_PRIMARY_S3_BUCKET)}/audit_db`;

const redisUrl = (config: DeployConfig): string => {
  if (config.REDIS_URL) return config.REDIS_URL;
  const node = parseNodeList(config.REDIS_NODES)[0];
  if (!node) return "";
  return `redis://:${encodeURIComponent(config.REDIS_PASSWORD)}@${node.privateIp}:${node.servicePort}/0`;
};

export const backupDaemonEnv = (config: DeployConfig): Record<string, string> => {
  const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
  const audit = parseNodeList(config.AUDIT_DB_NODE)[0];
  const primaryCluster = primary ? pgClusterFor(config, "primary", primary) : null;
  const auditCluster = audit ? pgClusterFor(config, "audit", audit) : null;
  const redis = redisUrl(config);
  return {
    NODE_ENV: "production",
    BACKUP_ENGINE_MODE: config.BACKUP_ENGINE_MODE,
    BACKUP_COMPRESSION: config.BACKUP_COMPRESSION,
    BACKUP_ENCRYPTION_KEY_HEX: config.BACKUP_ENCRYPTION_KEY_HEX,
    BACKUP_PRIMARY_S3_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT,
    BACKUP_PRIMARY_S3_BUCKET: config.BACKUP_PRIMARY_S3_BUCKET,
    BACKUP_PRIMARY_S3_ACCESS_KEY: config.BACKUP_PRIMARY_S3_ACCESS_KEY,
    BACKUP_PRIMARY_S3_SECRET_KEY: config.BACKUP_PRIMARY_S3_SECRET_KEY,
    BACKUP_CORE_S3_PREFIX: backupCoreS3Prefix(config),
    BACKUP_AUDIT_S3_PREFIX: backupAuditS3Prefix(config),
    BACKUP_SECONDARY_SSH_TARGET: config.BACKUP_SECONDARY_SSH_TARGET,
    BACKUP_FULL_CRON: config.BACKUP_FULL_CRON,
    BACKUP_DELTA_CRON: config.BACKUP_DELTA_CRON,
    BACKUP_DRILL_CRON: config.BACKUP_DRILL_CRON,
    BACKUP_RETENTION_FULL_COUNT: String(config.BACKUP_RETENTION_FULL_COUNT),
    BACKUP_RETENTION_WAL_DAYS: String(config.BACKUP_RETENTION_WAL_DAYS),
    BACKUP_ALERT_LAG_SECONDS: String(config.BACKUP_ALERT_LAG_SECONDS),
    BACKUP_DAEMON_PORT: String(config.BACKUP_DAEMON_PORT),
    BACKUP_DAEMON_BIND_HOST: daemonBindHost(config),
    BACKUP_DAEMON_CERT_PATH: `${config.BACKUP_DAEMON_CERT_DIR}/backup-daemon.crt`,
    BACKUP_DAEMON_KEY_PATH: `${config.BACKUP_DAEMON_CERT_DIR}/backup-daemon.key`,
    BACKUP_DAEMON_CA_CERT_PATH: `${config.BACKUP_DAEMON_CERT_DIR}/internal-ca.crt`,
    PG_PRIMARY_HOST: primary?.privateIp ?? "127.0.0.1",
    PG_PRIMARY_PORT: String(primary?.servicePort ?? 5432),
    PG_PRIMARY_USER: config.PG_DB_USER,
    PG_PRIMARY_PASSWORD: config.PG_DB_PASSWORD,
    PG_PRIMARY_DB_NAME: config.PG_DB_NAME,
    PG_DB_NAME: config.PG_DB_NAME,
    PG_AUDIT_PORT: String(parseNodeList(config.AUDIT_DB_NODE)[0]?.servicePort ?? 5434),
    PG_AUDIT_DB_NAME: config.AUDIT_DB_NAME,
    PG_REPLICA_NODES: config.PG_REPLICA_NODES,
    PG_DATA_DIR: config.PG_DATA_DIR.trim() || primaryCluster?.dataDir || "/var/lib/postgresql/18/main",
    PG_AUDIT_DATA_DIR: config.PG_AUDIT_DATA_DIR.trim() || auditCluster?.dataDir || "",
    PG_BIN_DIR: `/usr/lib/postgresql/${config.PG_VERSION}/bin`,
    PGPASSFILE: config.BACKUP_PGPASSFILE,
    BARMAN_SERVER: config.PG_DB_NAME,
    BARMAN_AUDIT_SERVER: config.BARMAN_AUDIT_SERVER.trim() || config.AUDIT_DB_NAME,
    BACKUP_CATALOG_PATH: config.BACKUP_CATALOG_PATH,
    SCHEDULER_ENABLED: config.BACKUP_SCHEDULER_ENABLED ? "true" : "false",
    SCHEDULER_TICK_MS: String(config.BACKUP_SCHEDULER_TICK_MS),
    BACKUP_SCRATCH_DIR: config.BACKUP_SCRATCH_DIR,
    BACKUP_SCRATCH_AUDIT_DIR:
      config.BACKUP_SCRATCH_AUDIT_DIR.trim() || `${config.BACKUP_SCRATCH_DIR}/audit`,
    BACKUP_SCRATCH_PORT: String(config.BACKUP_SCRATCH_PORT),
    BACKUP_SCRATCH_AUDIT_PORT: String(config.BACKUP_SCRATCH_AUDIT_PORT),
    BACKUP_ALLOW_INSECURE_HTTP: config.BACKUP_ALLOW_INSECURE_HTTP ? "true" : "false",
    BACKUP_COMMAND_TIMEOUT_MS: String(config.BACKUP_COMMAND_TIMEOUT_MS),
    WALG_BIN: config.BACKUP_WALG_BIN,
    BARMAN_BIN: config.BACKUP_BARMAN_BIN,
    BARMAN_CLOUD_BIN: config.BACKUP_BARMAN_CLOUD_BIN,
    REDIS_CLI_BIN: config.BACKUP_REDIS_CLI_BIN,
    ...(redis ? { REDIS_URL: redis } : {}),
  };
};

export const renderEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;

export const walGEnvironment = (
  config: DeployConfig,
  target: BackupTarget | string = "postgres_core",
): Record<string, string> => ({
  AWS_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT,
  AWS_ENDPOINT_URL: config.BACKUP_PRIMARY_S3_ENDPOINT,
  AWS_ENDPOINT_URL_S3: config.BACKUP_PRIMARY_S3_ENDPOINT,
  AWS_S3_FORCE_PATH_STYLE: "true",
  AWS_ACCESS_KEY_ID: config.BACKUP_PRIMARY_S3_ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY: config.BACKUP_PRIMARY_S3_SECRET_KEY,
  WALG_S3_PREFIX: isAuditTarget(target) ? backupAuditS3Prefix(config) : backupCoreS3Prefix(config),
  WALG_COMPRESSION_METHOD: config.BACKUP_COMPRESSION,
  WALG_LIBSODIUM_KEY: config.BACKUP_ENCRYPTION_KEY_HEX,
});

const walGEnvFile = (target: BackupTarget | string): string =>
  isAuditTarget(target) ? "/etc/pg-backup/wal-g-audit.env" : "/etc/pg-backup/wal-g-core.env";

const barmanServerName = (config: DeployConfig, target: BackupTarget | string): string =>
  isAuditTarget(target)
    ? (config.BARMAN_AUDIT_SERVER.trim() || config.AUDIT_DB_NAME)
    : config.PG_DB_NAME;

export const archiveCommand = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => {
  if (config.BACKUP_ENGINE_MODE === "barman") {
    const backupIp = backupSpec(config)?.privateIp ?? "backup-1";
    return `barman-wal-archive ${backupIp} ${barmanServerName(config, target)} %p`;
  }
  const prefix = isAuditTarget(target) ? backupAuditS3Prefix(config) : backupCoreS3Prefix(config);
  return `WALG_S3_PREFIX=${shellQuote(prefix)} sh -c 'set -a; . ${walGEnvFile(target)}; exec wal-g wal-push %p'`;
};

export const restoreCommand = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => {
  if (config.BACKUP_ENGINE_MODE === "barman") {
    const backupIp = backupSpec(config)?.privateIp ?? "backup-1";
    return `barman-wal-restore ${backupIp} ${barmanServerName(config, target)} %f %p`;
  }
  const prefix = isAuditTarget(target) ? backupAuditS3Prefix(config) : backupCoreS3Prefix(config);
  return `WALG_S3_PREFIX=${shellQuote(prefix)} sh -c 'set -a; . ${walGEnvFile(target)}; exec wal-g wal-fetch %f %p'`;
};

const barmanServerSection = (input: {
  config: DeployConfig;
  name: string;
  host: string;
  port: number;
  database: string;
  slotName: string;
}): string => `[${input.name}]
description = "Payment Gateway PostgreSQL 18 ${input.database}"
conninfo = host=${input.host} port=${input.port} user=${input.config.PG_REPLICATION_USER} dbname=${input.database}
streaming_conninfo = host=${input.host} port=${input.port} user=${input.config.PG_REPLICATION_USER} dbname=${input.database}
backup_method = postgres
streaming_archiver = on
slot_name = ${input.slotName}
`;

export const barmanConfig = (config: DeployConfig): string => {
  const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
  const audit = parseNodeList(config.AUDIT_DB_NODE)[0];
  const primaryHost = primary?.privateIp ?? "127.0.0.1";
  const primaryPort = primary?.servicePort ?? 5432;
  const auditHost = audit?.privateIp ?? primaryHost;
  const auditPort = audit?.servicePort ?? primaryPort;
  return `[barman]
barman_user = barman
configuration_files_directory = /etc/barman.d
barman_home = /var/lib/pg-backup/barman
log_file = /var/log/pg-backup/barman.log
log_level = INFO
compression = ${config.BACKUP_COMPRESSION}
retention_policy = RECOVERY WINDOW OF ${config.BACKUP_RETENTION_WAL_DAYS} DAYS

${barmanServerSection({
  config,
  name: config.PG_DB_NAME,
  host: primaryHost,
  port: primaryPort,
  database: config.PG_DB_NAME,
  slotName: "barman",
})}${audit ? barmanServerSection({
  config,
  name: config.BARMAN_AUDIT_SERVER.trim() || config.AUDIT_DB_NAME,
  host: auditHost,
  port: auditPort,
  database: config.AUDIT_DB_NAME,
  slotName: "barman_audit",
}) : ""}`;
};

export const backupDaemonSystemdUnit = (config: DeployConfig): string => `[Unit]
Description=Payment Gateway pg-backup-daemon (WAL-G / Barman control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=postgres
Group=postgres
WorkingDirectory=/opt/pg-backup-daemon
EnvironmentFile=/etc/pg-backup/backup.env
Environment=BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${[
  "/var/lib/pg-backup",
  "/var/log/pg-backup",
  dirname(config.BACKUP_CATALOG_PATH),
  config.BACKUP_DAEMON_CERT_DIR,
  config.BACKUP_SCRATCH_DIR,
  config.BACKUP_SCRATCH_AUDIT_DIR.trim() || `${config.BACKUP_SCRATCH_DIR}/audit`,
  dirname(config.BACKUP_PGPASSFILE),
].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index).join(" ")}

[Install]
WantedBy=multi-user.target
`;

export const backupDaemonTriggerScript = (config: DeployConfig): string => `#!/usr/bin/env bash
set -euo pipefail
KIND="\${1:-full}"
TARGET="\${2:-all}"
case "$KIND" in
  full|delta) ;;
  *) echo "usage: $0 [full|delta] [all|postgres_core|audit_db|redis]" >&2; exit 64 ;;
esac
case "$TARGET" in
  all|postgres_core|audit_db|redis) ;;
  *) echo "invalid target: $TARGET" >&2; exit 64 ;;
esac
CERT_DIR="\${BACKUP_CERT_DIR:-${config.BACKUP_DAEMON_CERT_DIR}}"
DAEMON_HOST="\${BACKUP_DAEMON_BIND_HOST:-${daemonBindHost(config)}}"
DAEMON_PORT="\${BACKUP_DAEMON_PORT:-${config.BACKUP_DAEMON_PORT}}"
curl -fsS --max-time 300 \\
  --cacert "$CERT_DIR/internal-ca.crt" \\
  --cert "$CERT_DIR/backup-client.crt" \\
  --key "$CERT_DIR/backup-client.key" \\
  -H 'content-type: application/json' \\
  -X POST \\
  --data "{\\"target\\":\\"$TARGET\\",\\"kind\\":\\"$KIND\\"}" \\
  "https://$DAEMON_HOST:$DAEMON_PORT/v1/backups/trigger"
`;

export const scratchRestoreVerifierScript = (config: DeployConfig): string => `#!/usr/bin/env bash
set -euo pipefail
set -a
if [ -f /etc/pg-backup/backup.env ]; then . /etc/pg-backup/backup.env; fi
set +a
# Weekly scratch PostgreSQL 18 restore + ledger invariant verification.
SCRATCH_DIR="\${BACKUP_SCRATCH_DIR:-/var/lib/pg-backup/scratch}"
SCRATCH_PORT="\${BACKUP_SCRATCH_PORT:-55432}"
TARGET_TIME="$(date -u -d '5 minutes ago' '+%Y-%m-%d %H:%M:%S+00')"
rm -rf "$SCRATCH_DIR"
mkdir -p "$SCRATCH_DIR"
chown postgres:postgres "$SCRATCH_DIR"
# Restore the latest base backup + WAL up to target_time with WAL-G/Barman.
if [ "${config.BACKUP_ENGINE_MODE}" = "barman" ]; then
  barman recover --target-time "$TARGET_TIME" --remote-ssh-command "ssh postgres@localhost" ${config.PG_DB_NAME} latest "$SCRATCH_DIR"
else
  runuser -u postgres -- bash -c "set -a; . ${walGEnvFile("postgres_core")}; set +a; wal-g backup-fetch '$SCRATCH_DIR' LATEST"
fi
runuser -u postgres -- env PATH="$PG_BIN_DIR:$PATH" pg_ctl -D "$SCRATCH_DIR" -o "-p $SCRATCH_PORT" -w start
trap 'runuser -u postgres -- env PATH="$PG_BIN_DIR:$PATH" pg_ctl -D "$SCRATCH_DIR" -m immediate stop || true' EXIT
PGPASSWORD="\${PG_PRIMARY_PASSWORD:-}" psql -h 127.0.0.1 -p "$SCRATCH_PORT" -U ${config.PG_DB_USER} -d ${config.PG_DB_NAME} -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE drift NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) INTO drift FROM journal_lines;
  IF drift <> 0 THEN RAISE EXCEPTION 'LEDGER_DOUBLE_ENTRY_DRIFT=%', drift; END IF;
END $$;
SELECT 1 AS restore_drill_ok;
SQL
`;

export const backupDaemonUnit = backupDaemonSystemdUnit;
export const backupCronEntries = (config: DeployConfig): string[] =>
  config.BACKUP_SCHEDULER_ENABLED
    ? []
    : [
        `${config.BACKUP_FULL_CRON} pgbackup /usr/local/bin/pg-backup-daemon-trigger full`,
        `${config.BACKUP_DELTA_CRON} pgbackup /usr/local/bin/pg-backup-daemon-trigger delta`,
        `${config.BACKUP_DRILL_CRON} root /usr/local/bin/pg-backup-restore-drill`,
      ];

export const backupCronFile = (config: DeployConfig): string =>
  config.BACKUP_SCHEDULER_ENABLED
    ? "# The pg-backup-daemon scheduler owns the full/delta/drill schedule.\n"
    : `# Payment Gateway backup + PITR verification schedule\n${backupCronEntries(config).join("\n")}\n`;

export const JOURNAL_LINE_PARTITION_MAINTENANCE_CRON = "30 1 * * *";
export const journalLinePartitionCronLine = (config: DeployConfig): string => {
  const port = parseNodeList(config.PG_PRIMARY_NODE)[0]?.servicePort ?? 5432;
  return `${JOURNAL_LINE_PARTITION_MAINTENANCE_CRON} root runuser -u postgres -- psql -p ${port} -d ${config.PG_DB_NAME} -c 'SELECT ensure_journal_line_partitions(18)' >/var/log/pg-journal-partitions.log 2>&1`;
};

/**
 * Dry-run-safe command builders used to verify the primary S3 bucket and the
 * secondary SSH vault before the backup daemon is enabled.
 */
export const verifyBackupTargetCommands = (config: DeployConfig): string[] => [
  `test -n ${JSON.stringify(config.BACKUP_PRIMARY_S3_BUCKET)}`,
  `curl -fsS --max-time 10 ${JSON.stringify(config.BACKUP_PRIMARY_S3_ENDPOINT.replace(/\/$/, ""))}/minio/health/live >/dev/null`,
  ...(config.BACKUP_SECONDARY_SSH_TARGET
    ? [`timeout 5 bash -c '</dev/tcp/${config.BACKUP_SECONDARY_SSH_TARGET.split(":")[0]!.split("@").pop()}/22'`]
    : []),
  `test -n ${JSON.stringify(config.BACKUP_ENCRYPTION_KEY_HEX)}`,
];

export const verifyBackupTargetDryRun = (config: DeployConfig): string[] =>
  verifyBackupTargetCommands(config).map((command) => `echo ${JSON.stringify(`[dry-run] ${command}`)}`);

export const archiveCommandSql = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => [
  `ALTER SYSTEM SET wal_level = 'replica';`,
  `ALTER SYSTEM SET archive_mode = 'on';`,
  `ALTER SYSTEM SET archive_command = '${archiveCommand(config, target).replace(/'/g, "''")}';`,
  `ALTER SYSTEM SET restore_command = '${restoreCommand(config, target).replace(/'/g, "''")}';`,
  `ALTER SYSTEM SET archive_timeout = '60s';`,
  `SELECT pg_reload_conf();`,
].join("\n");

export const barmanStreamingSql = (): string => [
  `ALTER SYSTEM SET wal_level = 'replica';`,
  `ALTER SYSTEM SET archive_mode = 'off';`,
  `SELECT pg_reload_conf();`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = 'barman') THEN PERFORM pg_create_physical_replication_slot('barman'); END IF; END $$;`,
].join("\n");

export interface BackupDaemonDeployment {
  nodeId?: string;
  sshHost: string;
  privateIp: string;
  port: number;
  bindHost: string;
  installDir: string;
  envPath: string;
  serviceName: string;
  sourceDir: string;
}

export interface BackupProvisionReport extends ProvisionReport {
  daemon?: BackupDaemonDeployment;
}

export interface BackupProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
}

export const provisionBackupEngine = (input: BackupProvisionInput): BackupProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const ssh = backupSsh(config);
  if (!ssh) return { commands, nodes };
  const spec = backupSpec(config);

  nodes.push(ssh.host);
  for (const command of [
    `if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y barman zstd lz4 brotli xz-utils rclone curl ca-certificates
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm zstd lz4 brotli xz rclone curl ca-certificates python-pip
  python3 -m pip install --break-system-packages barman
fi`,
    ...(config.BACKUP_ENGINE_MODE === "wal-g" ? ["command -v wal-g >/dev/null 2>&1 || (curl -fsSL https://github.com/wal-g/wal-g/releases/download/v3.0.9/wal-g-pg-24.04-amd64 -o /usr/local/bin/wal-g && chmod +x /usr/local/bin/wal-g)"] : []),
    "id -u pgbackup >/dev/null 2>&1 || useradd --system --home /var/lib/pg-backup --shell /usr/sbin/nologin pgbackup",
    "id -u barman >/dev/null 2>&1 || useradd --system --home /var/lib/barman --shell /usr/sbin/nologin barman",
    `install -d -m 0750 -o postgres -g postgres /var/lib/pg-backup ${config.BACKUP_DAEMON_CERT_DIR} /var/log/pg-backup && chown -R postgres:postgres ${config.BACKUP_DAEMON_CERT_DIR}`,
    "install -d -m 0755 /etc/pg-backup",
    "systemctl daemon-reload",
  ]) {
    commands.push(command);
    runner.run(ssh, command, { sudo: true });
  }

  runner.writeRemoteFile({
    target: ssh,
    path: "/etc/pg-backup/backup.env",
    content: renderEnvFile(backupDaemonEnv(config)),
    mode: 0o600,
    sudo: true,
  });
  runner.writeRemoteFile({
    target: ssh,
    path: "/etc/pg-backup/wal-g.env",
    content: renderEnvFile(walGEnvironment(config)),
    mode: 0o600,
    sudo: true,
  });
  runner.writeRemoteFile({
    target: ssh,
    path: "/etc/systemd/system/pg-backup-daemon.service",
    content: backupDaemonSystemdUnit(config),
    mode: 0o644,
    sudo: true,
  });
  runner.writeRemoteFile({
    target: ssh,
    path: "/etc/cron.d/pg-backup",
    content: backupCronFile(config),
    mode: 0o644,
    sudo: true,
  });
  runner.writeRemoteFile({
    target: ssh,
    path: "/usr/local/bin/pg-backup-daemon-trigger",
    content: backupDaemonTriggerScript(config),
    mode: 0o755,
    sudo: true,
  });
  runner.writeRemoteFile({
    target: ssh,
    path: "/usr/local/bin/pg-backup-restore-drill",
    content: scratchRestoreVerifierScript(config),
    mode: 0o755,
    sudo: true,
  });
  if (config.BACKUP_ENGINE_MODE === "barman") {
    const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
    const audit = parseNodeList(config.AUDIT_DB_NODE)[0];
    const pgpass = [
      `${primary?.privateIp ?? "127.0.0.1"}:${primary?.servicePort ?? 5432}:*:${config.PG_REPLICATION_USER}:${config.PG_REPLICATION_PASSWORD}`,
      ...(audit ? [`${audit.privateIp}:${audit.servicePort}:*:${config.PG_REPLICATION_USER}:${config.PG_REPLICATION_PASSWORD}`] : []),
    ].join("\n");
    runner.run(ssh, `install -d -m 0700 -o postgres -g postgres /var/lib/pg-backup /var/lib/pg-backup/barman ${dirname(config.BACKUP_PGPASSFILE)}`, { sudo: true });
    runner.writeRemoteFile({
      target: ssh,
      path: config.BACKUP_PGPASSFILE,
      content: `${pgpass}\n`,
      mode: 0o600,
      sudo: true,
    });
    runner.run(ssh, `chown postgres:postgres ${config.BACKUP_PGPASSFILE} && chmod 0600 ${config.BACKUP_PGPASSFILE}`, { sudo: true });
    runner.writeRemoteFile({ target: ssh, path: "/etc/barman.conf", content: barmanConfig(config), mode: 0o644, sudo: true });
  }

  for (const command of verifyBackupTargetCommands(config)) {
    commands.push(command);
    runner.run(ssh, command, { sudo: true });
  }

  const writeWalGEnvironment = (target: SshTarget, path: string, archiveTarget: BackupTarget | string): void => {
    runner.run(target, "install -d -m 0755 /etc/pg-backup", { sudo: true });
    runner.writeRemoteFile({
      target,
      path,
      content: renderEnvFile(walGEnvironment(config, archiveTarget)),
      mode: 0o640,
      sudo: true,
    });
    runner.run(target, `chown root:postgres ${path} && chmod 0640 ${path}`, { sudo: true });
  };

  const installArchiveClient = (target: SshTarget): void => {
    const commandsForHost = config.BACKUP_ENGINE_MODE === "wal-g"
      ? [
          "command -v wal-g >/dev/null 2>&1 || (curl -fsSL https://github.com/wal-g/wal-g/releases/download/v3.0.9/wal-g-pg-24.04-amd64 -o /usr/local/bin/wal-g && chmod +x /usr/local/bin/wal-g)",
        ]
      : [
          `if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y barman
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm python-pip
  python3 -m pip install --break-system-packages barman
fi`,
        ];
    for (const command of commandsForHost) {
      commands.push(command);
      runner.run(target, command, { sudo: true });
    }
  };

  const primary = pgSsh(config);
  if (primary && (config.PG_MANAGE_VIA_SSH || config.BACKUP_ENABLED)) {
    installArchiveClient(primary);
    if (config.BACKUP_ENGINE_MODE === "wal-g") {
      writeWalGEnvironment(primary, walGEnvFile("postgres_core"), "postgres_core");
    }
    const archiveSql = config.BACKUP_ENGINE_MODE === "barman"
      ? barmanStreamingSql()
      : archiveCommandSql(config, "postgres_core");
    const archivePath = `/tmp/pg-archive-config-${process.pid}.sql`;
    runner.writeRemoteFile({ target: primary, path: archivePath, content: `${archiveSql}\n`, mode: 0o644, sudo: true });
    const primarySpec = parseNodeList(config.PG_PRIMARY_NODE)[0];
    const primaryPort = primarySpec?.servicePort ?? 5432;
    const command = `runuser -u postgres -- psql -p ${primaryPort} -v ON_ERROR_STOP=1 -d ${config.PG_DB_NAME} -f ${archivePath}`;
    commands.push(command);
    runner.run(primary, command, { sudo: true });
    const primaryService = primarySpec ? pgClusterFor(config, "primary", primarySpec).service : "postgresql";
    commands.push(`systemctl restart ${primaryService}`);
    runner.run(primary, `systemctl restart ${primaryService}`, { sudo: true });
    const primaryReady = `for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p ${primaryPort} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;
    commands.push(primaryReady);
    runner.run(primary, primaryReady, { sudo: true });
    if (config.PGBOUNCER_ENABLED) {
      commands.push("systemctl restart pgbouncer");
      runner.run(primary, "systemctl restart pgbouncer || true", { sudo: true });
      const poolerReady = `for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p ${config.PGBOUNCER_PORT} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;
      commands.push(poolerReady);
      runner.run(primary, poolerReady, { sudo: true });
    }
    runner.writeRemoteFile({
      target: primary,
      path: "/etc/cron.d/pg-journal-partitions",
      content: `${journalLinePartitionCronLine(config)}\n`,
      mode: 0o644,
      sudo: true,
    });
    commands.push("install /etc/cron.d/pg-journal-partitions");
  }
  const audit = auditSsh(config);
  if (audit && config.AUDIT_DB_MANAGE_VIA_SSH) {
    installArchiveClient(audit);
    if (config.BACKUP_ENGINE_MODE === "wal-g") {
      writeWalGEnvironment(audit, walGEnvFile("audit_db"), "audit_db");
    }
    const archiveSql = config.BACKUP_ENGINE_MODE === "barman"
      ? barmanStreamingSql()
      : archiveCommandSql(config, "audit_db");
    const auditPath = `/tmp/pg-audit-archive-config-${process.pid}.sql`;
    runner.writeRemoteFile({ target: audit, path: auditPath, content: `${archiveSql}\n`, mode: 0o644, sudo: true });
    const auditSpec = parseNodeList(config.AUDIT_DB_NODE)[0];
    const auditPort = auditSpec?.servicePort ?? 5432;
    const command = `runuser -u postgres -- psql -p ${auditPort} -v ON_ERROR_STOP=1 -d ${config.AUDIT_DB_NAME} -f ${auditPath}`;
    commands.push(command);
    runner.run(audit, command, { sudo: true });
    const auditService = auditSpec ? pgClusterFor(config, "audit", auditSpec).service : "postgresql";
    commands.push(`systemctl restart ${auditService}`);
    runner.run(audit, `systemctl restart ${auditService}`, { sudo: true });
    const auditReady = `for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p ${auditPort} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;
    commands.push(auditReady);
    runner.run(audit, auditReady, { sudo: true });
  }

  // The audit target can share the primary cluster, so its archive restart may
  // have happened after the earlier PgBouncer restart. Restart the pooler last
  // and clear any cached "database system is shutting down" login failure
  // before the core release runs migrations through PgBouncer.
  if (primary && config.PGBOUNCER_ENABLED) {
    commands.push("systemctl restart pgbouncer");
    runner.run(primary, "systemctl restart pgbouncer || true", { sudo: true });
    const poolerReady = `for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p ${config.PGBOUNCER_PORT} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;
    commands.push(poolerReady);
    runner.run(primary, poolerReady, { sudo: true });
  }

  return {
    commands,
    nodes,
    daemon: {
      nodeId: spec?.nodeId,
      sshHost: ssh.host,
      privateIp: spec?.privateIp ?? "127.0.0.1",
      port: config.BACKUP_DAEMON_PORT,
      bindHost: daemonBindHost(config),
      installDir: "/opt/pg-backup-daemon",
      envPath: "/etc/pg-backup/backup.env",
      serviceName: "pg-backup-daemon",
      sourceDir: "deploy/backup-daemon",
    },
  };
};
