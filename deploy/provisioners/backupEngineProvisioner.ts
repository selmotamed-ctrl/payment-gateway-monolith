import { parseNodeList, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import type { ProvisionReport, ProvisionRunner } from "./postgres18Provisioner";

/**
 * Backup/PITR engine provisioning.
 *
 * The provisioner installs WAL-G or Barman, wires `archive_command`, writes the
 * pg-backup-daemon environment + systemd unit, verifies primary/secondary
 * storage access and installs the full/delta/drill cron schedule.
 */

const backupSsh = (config: DeployConfig): SshTarget | null => {
  const spec = parseNodeList(config.BACKUP_NODE)[0];
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

export const backupDaemonEnv = (config: DeployConfig): Record<string, string> => ({
  NODE_ENV: "production",
  BACKUP_DAEMON_PORT: String(config.BACKUP_DAEMON_PORT),
  BACKUP_ENGINE_MODE: config.BACKUP_ENGINE_MODE,
  BACKUP_COMPRESSION: config.BACKUP_COMPRESSION,
  BACKUP_ENCRYPTION_KEY_HEX: config.BACKUP_ENCRYPTION_KEY_HEX,
  BACKUP_PRIMARY_S3_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT,
  BACKUP_PRIMARY_S3_BUCKET: config.BACKUP_PRIMARY_S3_BUCKET,
  BACKUP_PRIMARY_S3_ACCESS_KEY: config.BACKUP_PRIMARY_S3_ACCESS_KEY,
  BACKUP_PRIMARY_S3_SECRET_KEY: config.BACKUP_PRIMARY_S3_SECRET_KEY,
  BACKUP_SECONDARY_SSH_TARGET: config.BACKUP_SECONDARY_SSH_TARGET,
  BACKUP_FULL_CRON: config.BACKUP_FULL_CRON,
  BACKUP_DELTA_CRON: config.BACKUP_DELTA_CRON,
  BACKUP_DRILL_CRON: config.BACKUP_DRILL_CRON,
  BACKUP_RETENTION_FULL_COUNT: String(config.BACKUP_RETENTION_FULL_COUNT),
  BACKUP_RETENTION_WAL_DAYS: String(config.BACKUP_RETENTION_WAL_DAYS),
  MTLS_CA_CERT_PATH: "/var/lib/pg-backup/shared/certs/internal-ca.crt",
  MTLS_SERVER_CERT_PATH: "/var/lib/pg-backup/shared/certs/backup-daemon.crt",
  MTLS_SERVER_KEY_PATH: "/var/lib/pg-backup/shared/certs/backup-daemon.key",
  MTLS_CLIENT_CA_CERT_PATH: "/var/lib/pg-backup/shared/certs/internal-ca.crt",
  PG_PRIMARY_HOST: parseNodeList(config.PG_PRIMARY_NODE)[0]?.privateIp ?? "",
  PG_PRIMARY_PORT: String(parseNodeList(config.PG_PRIMARY_NODE)[0]?.servicePort ?? 5432),
  PG_DB_NAME: config.PG_DB_NAME,
  AUDIT_DB_HOST: parseNodeList(config.AUDIT_DB_NODE)[0]?.privateIp ?? "",
  AUDIT_DB_NAME: config.AUDIT_DB_NAME,
});

export const renderEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;

export const walGEnvironment = (config: DeployConfig): Record<string, string> => ({
  AWS_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT,
  AWS_S3_FORCE_PATH_STYLE: "true",
  AWS_ACCESS_KEY_ID: config.BACKUP_PRIMARY_S3_ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY: config.BACKUP_PRIMARY_S3_SECRET_KEY,
  WALG_S3_PREFIX: config.BACKUP_PRIMARY_S3_BUCKET,
  WALG_COMPRESSION_METHOD: config.BACKUP_COMPRESSION,
  WALG_LIBSODIUM_KEY: config.BACKUP_ENCRYPTION_KEY_HEX,
});

export const archiveCommand = (config: DeployConfig): string => {
  if (config.BACKUP_ENGINE_MODE === "barman") {
    const backupIp = parseNodeList(config.BACKUP_NODE)[0]?.privateIp ?? "backup-1";
    return `barman-wal-archive ${backupIp} ${config.PG_DB_NAME} %p`;
  }
  return "wal-g wal-push %p";
};

export const restoreCommand = (config: DeployConfig): string =>
  config.BACKUP_ENGINE_MODE === "barman"
    ? `barman-wal-restore ${parseNodeList(config.BACKUP_NODE)[0]?.privateIp ?? "backup-1"} ${config.PG_DB_NAME} %f %p`
    : "wal-g wal-fetch %f %p";

export const barmanConfig = (config: DeployConfig): string => `[barman]
barman_user = barman
configuration_files_directory = /etc/barman.d
barman_home = /var/lib/barman
log_file = /var/log/barman/barman.log
log_level = INFO
compression = ${config.BACKUP_COMPRESSION}
retention_policy = RECOVERY WINDOW OF ${config.BACKUP_RETENTION_WAL_DAYS} DAYS

[${config.PG_DB_NAME}]
description = "Payment Gateway PostgreSQL 18 primary"
conninfo = host=${parseNodeList(config.PG_PRIMARY_NODE)[0]?.privateIp ?? "127.0.0.1"} port=${parseNodeList(config.PG_PRIMARY_NODE)[0]?.servicePort ?? 5432} user=${config.PG_REPLICATION_USER} dbname=${config.PG_DB_NAME}
streaming_conninfo = host=${parseNodeList(config.PG_PRIMARY_NODE)[0]?.privateIp ?? "127.0.0.1"} port=${parseNodeList(config.PG_PRIMARY_NODE)[0]?.servicePort ?? 5432} user=${config.PG_REPLICATION_USER} dbname=${config.PG_DB_NAME}
backup_method = postgres
streaming_archiver = on
slot_name = barman
`;

export const backupDaemonSystemdUnit = (config: DeployConfig): string => `[Unit]
Description=Payment Gateway pg-backup-daemon (WAL-G / Barman control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pgbackup
Group=pgbackup
WorkingDirectory=/opt/pg-backup-daemon
EnvironmentFile=/etc/pg-backup/backup.env
Environment=BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT}
ExecStart=/usr/local/bin/bun run /opt/pg-backup-daemon/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pg-backup /var/log/pg-backup

[Install]
WantedBy=multi-user.target
`;

export const scratchRestoreVerifierScript = (config: DeployConfig): string => `#!/usr/bin/env bash
set -euo pipefail
# Weekly scratch PostgreSQL 18 restore + ledger invariant verification.
SCRATCH_DIR="\${SCRATCH_DIR:-/var/lib/pg-backup-scratch}"
SCRATCH_PORT="\${SCRATCH_PORT:-55432}"
TARGET_TIME="$(date -u -d '5 minutes ago' '+%Y-%m-%d %H:%M:%S+00')"
rm -rf "$SCRATCH_DIR"
mkdir -p "$SCRATCH_DIR"
chown postgres:postgres "$SCRATCH_DIR"
# Restore the latest base backup + WAL up to target_time with WAL-G/Barman.
if [ "${config.BACKUP_ENGINE_MODE}" = "barman" ]; then
  barman recover --target-time "$TARGET_TIME" --remote-ssh-command "ssh postgres@localhost" ${config.PG_DB_NAME} latest "$SCRATCH_DIR"
else
  su - postgres -c "wal-g backup-fetch '$SCRATCH_DIR' LATEST"
fi
su - postgres -c "pg_ctl -D '$SCRATCH_DIR' -o '-p $SCRATCH_PORT' -w start"
trap 'su - postgres -c "pg_ctl -D '"'"'$SCRATCH_DIR'"'"' -m immediate stop" || true' EXIT
psql -h 127.0.0.1 -p "$SCRATCH_PORT" -U ${config.PG_DB_USER} -d ${config.PG_DB_NAME} -v ON_ERROR_STOP=1 <<'SQL'
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
export const backupCronEntries = (config: DeployConfig): string[] => [
  `${config.BACKUP_FULL_CRON} pgbackup /usr/local/bin/pg-backup-daemon-trigger full`,
  `${config.BACKUP_DELTA_CRON} pgbackup /usr/local/bin/pg-backup-daemon-trigger delta`,
  `${config.BACKUP_DRILL_CRON} root /usr/local/bin/pg-backup-restore-drill`,
];

export const backupCronFile = (config: DeployConfig): string =>
  `# Payment Gateway backup + PITR verification schedule\n${backupCronEntries(config).join("\n")}\n`;

/**
 * Dry-run-safe command builders used to verify the primary S3 bucket and the
 * secondary SSH vault before the backup daemon is enabled.
 */
export const verifyBackupTargetCommands = (config: DeployConfig): string[] => [
  `test -n ${JSON.stringify(config.BACKUP_PRIMARY_S3_BUCKET)} && rclone lsd ${JSON.stringify(config.BACKUP_PRIMARY_S3_BUCKET)} --max-depth 1`,
  ...(config.BACKUP_SECONDARY_SSH_TARGET
    ? [`ssh -o BatchMode=yes -o ConnectTimeout=10 ${JSON.stringify(config.BACKUP_SECONDARY_SSH_TARGET.split(":")[0])} true`]
    : []),
  `test -n ${JSON.stringify(config.BACKUP_ENCRYPTION_KEY_HEX)}`,
];

export const verifyBackupTargetDryRun = (config: DeployConfig): string[] =>
  verifyBackupTargetCommands(config).map((command) => `echo ${JSON.stringify(`[dry-run] ${command}`)}`);

export const archiveCommandSql = (config: DeployConfig): string => [
  `ALTER SYSTEM SET wal_level = 'replica';`,
  `ALTER SYSTEM SET archive_mode = 'on';`,
  `ALTER SYSTEM SET archive_command = '${archiveCommand(config).replace(/'/g, "''")}';`,
  `ALTER SYSTEM SET restore_command = '${restoreCommand(config).replace(/'/g, "''")}';`,
  `ALTER SYSTEM SET archive_timeout = '60s';`,
  `SELECT pg_reload_conf();`,
].join("\n");

export interface BackupProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
}

export const provisionBackupEngine = (input: BackupProvisionInput): ProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const ssh = backupSsh(config);
  if (!ssh) return { commands, nodes };

  nodes.push(ssh.host);
  for (const command of [
    "apt-get update",
    `DEBIAN_FRONTEND=noninteractive apt-get install -y barman zstd rclone curl ca-certificates`,
    ...(config.BACKUP_ENGINE_MODE === "wal-g" ? ["command -v wal-g >/dev/null 2>&1 || (curl -fsSL https://github.com/wal-g/wal-g/releases/latest/download/wal-g-pg-ubuntu-20.04-amd64 -o /usr/local/bin/wal-g && chmod +x /usr/local/bin/wal-g)"] : []),
    "id -u pgbackup >/dev/null 2>&1 || useradd --system --home /var/lib/pg-backup --shell /usr/sbin/nologin pgbackup",
    "install -d -m 0750 -o pgbackup -g pgbackup /var/lib/pg-backup /var/lib/pg-backup/shared/certs /etc/pg-backup /var/log/pg-backup",
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
    path: "/usr/local/bin/pg-backup-restore-drill",
    content: scratchRestoreVerifierScript(config),
    mode: 0o755,
    sudo: true,
  });
  if (config.BACKUP_ENGINE_MODE === "barman") {
    runner.writeRemoteFile({ target: ssh, path: "/etc/barman.conf", content: barmanConfig(config), mode: 0o640, sudo: true });
  }

  for (const command of verifyBackupTargetCommands(config)) {
    commands.push(command);
    runner.run(ssh, command, { sudo: true });
  }

  const archiveSql = archiveCommandSql(config);
  const archivePath = `/tmp/pg-archive-config-${process.pid}.sql`;
  const primary = pgSsh(config);
  if (primary && (config.PG_MANAGE_VIA_SSH || config.BACKUP_ENABLED)) {
    runner.writeRemoteFile({ target: primary, path: archivePath, content: `${archiveSql}\n`, mode: 0o600, sudo: true });
    const command = `su - postgres -c "psql -v ON_ERROR_STOP=1 -d ${config.PG_DB_NAME} -f ${archivePath}"`;
    commands.push(command);
    runner.run(primary, command, { sudo: true });
    commands.push("systemctl restart postgresql");
    runner.run(primary, "systemctl restart postgresql", { sudo: true });
  }
  const audit = auditSsh(config);
  if (audit && config.AUDIT_DB_MANAGE_VIA_SSH) {
    const auditPath = `/tmp/pg-audit-archive-config-${process.pid}.sql`;
    runner.writeRemoteFile({ target: audit, path: auditPath, content: `${archiveSql}\n`, mode: 0o600, sudo: true });
    const command = `su - postgres -c "psql -v ON_ERROR_STOP=1 -d ${config.AUDIT_DB_NAME} -f ${auditPath}"`;
    commands.push(command);
    runner.run(audit, command, { sudo: true });
    commands.push("systemctl restart postgresql");
    runner.run(audit, "systemctl restart postgresql", { sudo: true });
  }

  const enable = "systemctl enable --now pg-backup-daemon";
  commands.push(enable);
  runner.run(ssh, enable, { sudo: true });
  return { commands, nodes };
};
