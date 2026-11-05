import { dirname } from "node:path";
import { parseNodeList, resolveBackupS3Mode, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { envAssign, pgpassField, shellQuote } from "../lib/quoting";
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
    BACKUP_SECONDARY_MIRROR_DELETE: config.BACKUP_SECONDARY_MIRROR_DELETE ? "true" : "false",
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
    BACKUP_ALLOWED_CLIENT_CNS: config.BACKUP_ALLOWED_CLIENT_CNS,
    ...(config.BACKUP_ENGINE_MODE === "wal-g" ? { WALG_ENV_FILE: "/etc/pg-backup/wal-g.env" } : {}),
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

/**
 * Renders KEY='value' lines. The file is both sourced by bash (archive_command,
 * restore drill) and used as a systemd EnvironmentFile; single-quoted values
 * are understood by both and keep `0 2 * * 0`, `;` and `$( )` inert.
 */
export const renderEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment variable name '${key}'`);
    return envAssign(key, value);
  }).join("\n")}\n`;

/** Fail-closed WAL-G install: pinned release + SHA-256 verified before it is made executable. */
export const walGInstallCommand = (config: DeployConfig): string => {
  const sha = config.BACKUP_WALG_SHA256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error("BACKUP_WALG_SHA256 is required to install WAL-G (refusing to run an unverified binary)");
  }
  const url = `https://github.com/wal-g/wal-g/releases/download/v${config.BACKUP_WALG_VERSION}/${config.BACKUP_WALG_ASSET}`;
  return `command -v wal-g >/dev/null 2>&1 || { tmp=$(umask 077 && mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellQuote(url)} -o "$tmp" && echo ${shellQuote(`${sha}  `)}"$tmp" | sha256sum -c - && install -m 0755 "$tmp" /usr/local/bin/wal-g; }`;
};

/** Pinned barman install for distributions without the package (pacman path). */
const barmanPipInstall = (config: DeployConfig): string =>
  `python3 -m pip install --break-system-packages ${shellQuote(`barman==${config.BACKUP_BARMAN_VERSION}`)}`;

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

/**
 * Account the backup daemon runs as. WAL-G's base backup reads PGDATA directly
 * (0700, owned by postgres) and connects over the local socket as `postgres`
 * (peer auth), so in wal-g mode the daemon must run as postgres. Barman pulls
 * over the replication protocol and keeps the dedicated, unprivileged account.
 */
export const backupDaemonUser = (config: Pick<DeployConfig, "BACKUP_ENGINE_MODE">): "postgres" | "pgbackup" =>
  config.BACKUP_ENGINE_MODE === "wal-g" ? "postgres" : "pgbackup";

export const backupDaemonSystemdUnit = (config: DeployConfig): string => `[Unit]
Description=Payment Gateway pg-backup-daemon (WAL-G / Barman control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${backupDaemonUser(config)}
Group=${backupDaemonUser(config)}
SupplementaryGroups=postgres
WorkingDirectory=/opt/pg-backup-daemon
EnvironmentFile=/etc/pg-backup/backup.env
Environment=BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
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
case "$SCRATCH_DIR" in ""|"/"|"/var"|"/var/lib"|"/root"|"/home") echo "refusing unsafe scratch dir: $SCRATCH_DIR" >&2; exit 2 ;; esac
rm -rf "$SCRATCH_DIR"
mkdir -p "$SCRATCH_DIR"
chown postgres:postgres "$SCRATCH_DIR"
# Restore the latest base backup + WAL up to target_time with WAL-G/Barman.
if [ "${config.BACKUP_ENGINE_MODE}" = "barman" ]; then
  barman recover --target-time "$TARGET_TIME" --remote-ssh-command "ssh postgres@localhost" ${shellQuote(config.PG_DB_NAME)} latest "$SCRATCH_DIR"
else
  runuser -u postgres -- bash -c "set -a; . ${walGEnvFile("postgres_core")}; set +a; wal-g backup-fetch '$SCRATCH_DIR' LATEST"
fi
runuser -u postgres -- env PATH="$PG_BIN_DIR:$PATH" pg_ctl -D "$SCRATCH_DIR" -o "-p $SCRATCH_PORT -c archive_mode=off" -w start
trap 'runuser -u postgres -- env PATH="$PG_BIN_DIR:$PATH" pg_ctl -D "$SCRATCH_DIR" -m immediate stop || true' EXIT
PGPASSWORD="\${PG_PRIMARY_PASSWORD:-}" psql -h 127.0.0.1 -p "$SCRATCH_PORT" -U ${shellQuote(config.PG_DB_USER)} -d ${shellQuote(config.PG_DB_NAME)} -v ON_ERROR_STOP=1 <<'SQL'
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
        `${config.BACKUP_FULL_CRON} ${backupDaemonUser(config)} /usr/local/bin/pg-backup-daemon-trigger full`,
        `${config.BACKUP_DELTA_CRON} ${backupDaemonUser(config)} /usr/local/bin/pg-backup-daemon-trigger delta`,
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
 * Object-store (S3) layer. When the endpoint is served from the backup host
 * (`BACKUP_S3_MODE=managed-minio`, or `auto` resolving to it) the engine
 * detects a running MinIO, and installs + configures + starts one when it is
 * missing, using BACKUP_PRIMARY_S3_ACCESS_KEY/SECRET_KEY as the root
 * credentials and creating the bucket named in BACKUP_PRIMARY_S3_BUCKET.
 * External stores (R2/AWS/an existing MinIO) are never touched, only verified.
 */
const s3EndpointUrl = (config: DeployConfig): URL => new URL(config.BACKUP_PRIMARY_S3_ENDPOINT);

const s3Endpoint = (config: DeployConfig): string => trimTrailingSlash(config.BACKUP_PRIMARY_S3_ENDPOINT);

export const s3BucketName = (config: DeployConfig): string =>
  config.BACKUP_PRIMARY_S3_BUCKET.replace(/^s3:\/\//, "").split("/")[0] ?? "";

const MINIO_ENV_PATH = "/etc/default/minio";
const MINIO_UNIT_PATH = "/etc/systemd/system/minio.service";

export const minioEnvFile = (config: DeployConfig): string => {
  const endpoint = s3EndpointUrl(config);
  const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  // Bind all interfaces only when the endpoint is not loopback, so a loopback
  // dev endpoint is not exposed on the LAN.
  const host = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname) ? "127.0.0.1" : "0.0.0.0";
  return renderEnvFile({
    MINIO_ROOT_USER: config.BACKUP_PRIMARY_S3_ACCESS_KEY,
    MINIO_ROOT_PASSWORD: config.BACKUP_PRIMARY_S3_SECRET_KEY,
    MINIO_VOLUMES: config.BACKUP_MINIO_DATA_DIR,
    MINIO_OPTS: `--address ${host}:${port} --console-address ${host}:${config.BACKUP_MINIO_CONSOLE_PORT}`,
  });
};

export const minioSystemdUnit = (): string => `[Unit]
Description=MinIO object store (Payment Gateway backup target)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minio-user
Group=minio-user
EnvironmentFile=${MINIO_ENV_PATH}
ExecStart=/usr/local/bin/minio server $MINIO_OPTS $MINIO_VOLUMES
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;

const minioHealthWait = (config: DeployConfig, seconds = 60): string =>
  `for i in $(seq 1 ${seconds}); do curl -fsS --max-time 3 ${shellQuote(`${s3Endpoint(config)}/minio/health/live`)} >/dev/null 2>&1 && exit 0; sleep 1; done; echo "MinIO did not become healthy at ${s3Endpoint(config)}" >&2; journalctl -u minio -n 30 --no-pager >&2 || true; exit 1`;

/**
 * Idempotent install of the MinIO server. MinIO no longer publishes binaries
 * (dl.min.io answers 410), so the order is: an existing `minio` on the host,
 * the operator-supplied BACKUP_MINIO_BINARY_URL (http(s):// or file://), then a
 * source build with Go (`go install github.com/minio/minio@<version>`).
 * Every step fails loudly; nothing is left half-installed at /usr/local/bin/minio.
 */
export const minioInstallScript = (config: DeployConfig): string => {
  const url = config.BACKUP_MINIO_BINARY_URL.trim();
  const version = config.BACKUP_MINIO_VERSION.trim() || "latest";
  return `set -eu
MINIO_BIN=/usr/local/bin/minio
install_minio() {
  if [ -x "$MINIO_BIN" ]; then return 0; fi
  if command -v minio >/dev/null 2>&1; then ln -sf "$(command -v minio)" "$MINIO_BIN"; return 0; fi
  ${url
    ? `echo "installing MinIO from ${url.replace(/"/g, "")}" >&2
  curl -fsSL ${shellQuote(url)} -o "$MINIO_BIN.tmp" || { echo "download of ${url.replace(/"/g, "")} failed" >&2; rm -f "$MINIO_BIN.tmp"; return 1; }
  chmod +x "$MINIO_BIN.tmp" && mv "$MINIO_BIN.tmp" "$MINIO_BIN"
  return 0`
    : `if ! command -v go >/dev/null 2>&1; then
    echo "MinIO is not installed and no longer ships binaries. Install Go on this host, or set BACKUP_MINIO_BINARY_URL to a MinIO binary you host." >&2
    return 1
  fi
  echo "building MinIO ${version} from source with Go (several minutes)" >&2
  GOBIN=/usr/local/bin GOPATH="$(mktemp -d)" GOFLAGS=-mod=mod go install github.com/minio/minio@${version} || { echo "go install github.com/minio/minio@${version} failed" >&2; return 1; }
  return 0`}
}
install_minio
[ -x "$MINIO_BIN" ] || { echo "MinIO binary missing after install" >&2; exit 1; }
getent group minio-user >/dev/null 2>&1 || groupadd --system minio-user
id -u minio-user >/dev/null 2>&1 || useradd --system --gid minio-user --home /var/lib/minio --shell /usr/sbin/nologin minio-user
install -d -m 0750 -o minio-user -g minio-user ${shellQuote(config.BACKUP_MINIO_DATA_DIR)}`;
};

/** Creates the bucket (idempotent) with a SigV4-signed PUT; no mc needed. */
export const minioBucketScript = (config: DeployConfig): string => {
  const bucket = s3BucketName(config);
  return `set -u
CODE="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X PUT --aws-sigv4 'aws:amz:us-east-1:s3' --user ${shellQuote(`${config.BACKUP_PRIMARY_S3_ACCESS_KEY}:${config.BACKUP_PRIMARY_S3_SECRET_KEY}`)} ${shellQuote(`${s3Endpoint(config)}/${bucket}`)})"
case "$CODE" in
  200|409) echo "bucket ${bucket} ready (HTTP $CODE)" ;;
  *) echo "creating bucket ${bucket} failed (HTTP $CODE)" >&2; exit 1 ;;
esac`;
};

/**
 * Ensures the managed MinIO is installed, configured and serving. Returns the
 * list of commands it ran (empty for external stores). A healthy endpoint is
 * left untouched.
 */
export const ensureObjectStore = (input: {
  runner: ProvisionRunner;
  config: DeployConfig;
  ssh: SshTarget;
  log?: (message: string) => void;
}): string[] => {
  const { runner, config, ssh } = input;
  const commands: string[] = [];
  const log = input.log ?? (() => undefined);
  if (resolveBackupS3Mode(config) !== "managed-minio") {
    log(`object store: external (${s3Endpoint(config)}), not managed by the deploy engine`);
    return commands;
  }
  const health = `curl -fsS --max-time 5 ${shellQuote(`${s3Endpoint(config)}/minio/health/live`)} >/dev/null 2>&1`;
  const alive = (): boolean => {
    if (runner.dryRun) return false;
    try {
      runner.run(ssh, health, { sudo: false });
      return true;
    } catch {
      return false;
    }
  };
  if (alive()) {
    log(`object store: MinIO already healthy at ${s3Endpoint(config)}; ensuring bucket ${s3BucketName(config)}`);
  } else {
    log(`object store: MinIO not reachable at ${s3Endpoint(config)}; installing and starting it on ${ssh.host}`);
    const install = minioInstallScript(config);
    commands.push(install);
    runner.run(ssh, install, { sudo: true });
    runner.writeRemoteFile({ target: ssh, path: MINIO_ENV_PATH, content: minioEnvFile(config), mode: 0o600, sudo: true });
    runner.run(ssh, `chown root:minio-user ${MINIO_ENV_PATH} && chmod 0640 ${MINIO_ENV_PATH}`, { sudo: true });
    runner.writeRemoteFile({ target: ssh, path: MINIO_UNIT_PATH, content: minioSystemdUnit(), mode: 0o644, sudo: true });
    for (const command of ["systemctl daemon-reload", "systemctl enable minio", "systemctl restart minio"]) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
  }
  const wait = minioHealthWait(config);
  commands.push(wait);
  runner.run(ssh, wait, { sudo: false });
  const bucket = minioBucketScript(config);
  commands.push(bucket);
  runner.run(ssh, bucket, { sudo: true });
  return commands;
};

/**
 * Dry-run-safe command builders used to verify the primary S3 endpoint and the
 * secondary SSH vault before the backup daemon is enabled.
 */
export const verifyBackupTargetCommands = (config: DeployConfig): string[] => {
  const endpoint = s3Endpoint(config);
  const managed = resolveBackupS3Mode(config) === "managed-minio";
  return [
    `test -n ${JSON.stringify(config.BACKUP_PRIMARY_S3_BUCKET)}`,
    // MinIO exposes a health route; other S3 services (R2/AWS) do not, so for
    // them any HTTP response proves the endpoint is reachable.
    managed
      ? `curl -fsS --max-time 10 ${JSON.stringify(endpoint)}/minio/health/live >/dev/null`
      : `curl -sS --max-time 10 -o /dev/null ${JSON.stringify(endpoint)} || { echo "S3 endpoint ${endpoint} is unreachable from the backup host; set BACKUP_S3_MODE=managed-minio to let the engine install MinIO there, or fix BACKUP_PRIMARY_S3_ENDPOINT" >&2; exit 1; }`,
    ...(config.BACKUP_SECONDARY_SSH_TARGET
      ? [`timeout 5 bash -c '</dev/tcp/${config.BACKUP_SECONDARY_SSH_TARGET.split(":")[0]!.split("@").pop()}/22'`]
      : []),
    `test -n ${JSON.stringify(config.BACKUP_ENCRYPTION_KEY_HEX)}`,
  ];
};

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
  ${barmanPipInstall(config)}
fi`,
    ...(config.BACKUP_ENGINE_MODE === "wal-g" ? [walGInstallCommand(config)] : []),
    "id -u pgbackup >/dev/null 2>&1 || useradd --system --home /var/lib/pg-backup --shell /usr/sbin/nologin pgbackup",
    "usermod -aG pgbackup postgres 2>/dev/null || true",
    "id -u barman >/dev/null 2>&1 || useradd --system --home /var/lib/barman --shell /usr/sbin/nologin barman",
    `install -d -m 0750 -o ${backupDaemonUser(config)} -g ${backupDaemonUser(config)} /var/lib/pg-backup ${shellQuote(config.BACKUP_DAEMON_CERT_DIR)} /var/log/pg-backup && chown -R ${backupDaemonUser(config)}:${backupDaemonUser(config)} /var/lib/pg-backup /var/log/pg-backup ${shellQuote(config.BACKUP_DAEMON_CERT_DIR)}`,
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
    mode: 0o640,
    sudo: true,
  });
  // restore_command (run by the scratch postgres as user postgres) sources this file.
  runner.run(ssh, `chown root:${backupDaemonUser(config)} /etc/pg-backup/wal-g.env && chmod 0640 /etc/pg-backup/wal-g.env`, { sudo: true });
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
      `${pgpassField(primary?.privateIp ?? "127.0.0.1")}:${primary?.servicePort ?? 5432}:*:${pgpassField(config.PG_REPLICATION_USER)}:${pgpassField(config.PG_REPLICATION_PASSWORD)}`,
      ...(audit ? [`${pgpassField(audit.privateIp)}:${audit.servicePort}:*:${pgpassField(config.PG_REPLICATION_USER)}:${pgpassField(config.PG_REPLICATION_PASSWORD)}`] : []),
    ].join("\n");
    runner.run(ssh, `install -d -m 0700 -o pgbackup -g pgbackup /var/lib/pg-backup /var/lib/pg-backup/barman ${shellQuote(dirname(config.BACKUP_PGPASSFILE))}`, { sudo: true });
    runner.writeRemoteFile({
      target: ssh,
      path: config.BACKUP_PGPASSFILE,
      content: `${pgpass}\n`,
      mode: 0o600,
      sudo: true,
    });
    runner.run(ssh, `chown pgbackup:pgbackup ${shellQuote(config.BACKUP_PGPASSFILE)} && chmod 0600 ${shellQuote(config.BACKUP_PGPASSFILE)}`, { sudo: true });
    runner.writeRemoteFile({ target: ssh, path: "/etc/barman.conf", content: barmanConfig(config), mode: 0o644, sudo: true });
  }

  commands.push(...ensureObjectStore({ runner, config, ssh }));

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
    runner.run(target, `chown root:postgres ${shellQuote(path)} && chmod 0640 ${shellQuote(path)}`, { sudo: true });
  };

  const installArchiveClient = (target: SshTarget): void => {
    const commandsForHost = config.BACKUP_ENGINE_MODE === "wal-g"
      ? [
          walGInstallCommand(config),
        ]
      : [
          `if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y barman
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm python-pip
  ${barmanPipInstall(config)}
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
    const archiveDir = `/var/lib/postgresql/.pg-archive-config-${process.pid}`;
    const archivePath = `${archiveDir}/archive.sql`;
    runner.run(primary, `install -d -m 0700 -o postgres -g postgres ${shellQuote(archiveDir)}`, { sudo: true });
    runner.writeRemoteFile({ target: primary, path: archivePath, content: `${archiveSql}\n`, mode: 0o600, sudo: true });
    const primarySpec = parseNodeList(config.PG_PRIMARY_NODE)[0];
    const primaryPort = primarySpec?.servicePort ?? 5432;
    const command = `chown postgres:postgres ${shellQuote(archivePath)}; trap ${shellQuote(`rm -rf ${shellQuote(archiveDir)}`)} EXIT; runuser -u postgres -- psql -p ${primaryPort} -v ON_ERROR_STOP=1 -d ${shellQuote(config.PG_DB_NAME)} -f ${shellQuote(archivePath)}`;
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
    const auditDir = `/var/lib/postgresql/.pg-audit-archive-config-${process.pid}`;
    const auditPath = `${auditDir}/archive.sql`;
    runner.run(audit, `install -d -m 0700 -o postgres -g postgres ${shellQuote(auditDir)}`, { sudo: true });
    runner.writeRemoteFile({ target: audit, path: auditPath, content: `${archiveSql}\n`, mode: 0o600, sudo: true });
    const auditSpec = parseNodeList(config.AUDIT_DB_NODE)[0];
    const auditPort = auditSpec?.servicePort ?? 5432;
    const command = `chown postgres:postgres ${shellQuote(auditPath)}; trap ${shellQuote(`rm -rf ${shellQuote(auditDir)}`)} EXIT; runuser -u postgres -- psql -p ${auditPort} -v ON_ERROR_STOP=1 -d ${shellQuote(config.AUDIT_DB_NAME)} -f ${shellQuote(auditPath)}`;
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
