import { dirname } from "node:path";
import { backupS3Configured, parseNodeList, resolveBackupS3Mode, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { envAssign, pgpassField, shellQuote } from "../lib/quoting";
import { ensurePackagesScript, isChanged, outcomeBounced, pipPinnedGuard, type ApplyOutcome, type ProvisionRunner } from "../lib/converge";
import { applyPgbouncer, applyPostgresCluster, isSameCluster, pgClusterFor, postgresServerPackages, replicationRoleSql, type ProvisionReport } from "./postgres18Provisioner";

/**
 * Backup/PITR engine provisioning.
 *
 * The provisioner installs WAL-G or Barman, wires `archive_command`, writes the
 * pg-backup-daemon environment + systemd unit, verifies primary/secondary
 * storage access and installs the full/delta/drill schedule.
 */

export type BackupTarget = "postgres_core" | "audit_db";

/** Where deploy.ts installs the CA and the WAL-archive client cert on PostgreSQL hosts. */
export const STORAGE_CERT_DIR = "/etc/pg-deploy/certs";
/** Default physical replication slot the pg-native daemon streams WAL through. */
export const PG_BACKUP_REPLICATION_SLOT = "pg_backup_core";

/** Printed by the archive-config script: did ALTER SYSTEM change postgresql.auto.conf? */
const ARCHIVE_MARKER = "__PG_ARCHIVE__=";

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
  const s3 = backupS3Configured(config);
  // A separate audit cluster is reached on its own host; an audit DB that lives
  // inside the core cluster shares the primary's stream (PG_AUDIT_HOST empty).
  const dedicatedAudit = audit && !isSameCluster(primary, audit) ? audit : undefined;
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
    BACKUP_CORE_S3_PREFIX: s3 ? backupCoreS3Prefix(config) : "",
    BACKUP_AUDIT_S3_PREFIX: s3 ? backupAuditS3Prefix(config) : "",
    ...(config.BACKUP_ENGINE_MODE === "pg-native" ? { BACKUP_LOCAL_REPO_DIR: config.BACKUP_LOCAL_REPO_DIR } : {}),
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
    BACKUP_WAL_CLIENT_CNS: config.BACKUP_WAL_CLIENT_CNS,
    ...(config.BACKUP_ENGINE_MODE === "wal-g"
      ? {
          WALG_ENV_FILE: "/etc/pg-backup/wal-g-core.env",
          WALG_ENV_FILE_AUDIT: "/etc/pg-backup/wal-g-audit.env",
        }
      : {}),
    PG_PRIMARY_HOST: primary?.privateIp ?? "127.0.0.1",
    PG_PRIMARY_PORT: String(primary?.servicePort ?? 5432),
    PG_PRIMARY_USER: config.PG_DB_USER,
    PG_PRIMARY_PASSWORD: config.PG_DB_PASSWORD,
    PG_PRIMARY_DB_NAME: config.PG_DB_NAME,
    PG_DB_NAME: config.PG_DB_NAME,
    PG_AUDIT_HOST: dedicatedAudit?.privateIp ?? "",
    PG_AUDIT_PORT: String(parseNodeList(config.AUDIT_DB_NODE)[0]?.servicePort ?? 5434),
    PG_AUDIT_USER: config.AUDIT_DB_USER,
    PG_AUDIT_PASSWORD: config.AUDIT_DB_PASSWORD,
    PG_AUDIT_DB_NAME: config.AUDIT_DB_NAME,
    PG_LOG_DB_NAME: parseNodeList(config.LOG_DB_NODE)[0] ? config.LOG_DB_NAME : "",
    PG_REPLICATION_USER: config.PG_REPLICATION_USER,
    PG_REPLICATION_PASSWORD: config.PG_REPLICATION_PASSWORD,
    PG_REPLICATION_SLOT: PG_BACKUP_REPLICATION_SLOT,
    // The managed clusters use a self-signed server certificate: encrypt, do not verify.
    PG_SSLMODE: "require",
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

/**
 * Fail-closed WAL-G install: pinned release + SHA-256 verified before it is
 * made executable. An existing wal-g binary is reused, so a host that already
 * has WAL-G does not need the checksum; a host that must download it does.
 */
export const walGInstallCommand = (config: DeployConfig): string => {
  const sha = config.BACKUP_WALG_SHA256.trim().toLowerCase();
  const hasSha = /^[0-9a-f]{64}$/.test(sha);
  const url = `https://github.com/wal-g/wal-g/releases/download/v${config.BACKUP_WALG_VERSION}/${config.BACKUP_WALG_ASSET}`;
  if (!hasSha) {
    return "command -v wal-g >/dev/null 2>&1 || { echo 'WAL-G is not installed and BACKUP_WALG_SHA256 is not set: install wal-g manually or set the SHA-256 of the pinned release' >&2; exit 1; }";
  }
  return `command -v wal-g >/dev/null 2>&1 || { tmp=$(umask 077 && mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellQuote(url)} -o "$tmp" && echo ${shellQuote(`${sha}  `)}"$tmp" | sha256sum -c - && install -m 0755 "$tmp" /usr/local/bin/wal-g; }`;
};

/** Pinned barman install for distributions without the package (pacman path). */
const barmanPipInstall = (config: DeployConfig): string =>
  pipPinnedGuard("barman", config.BACKUP_BARMAN_VERSION, `python3 -m pip install --break-system-packages ${shellQuote(`barman==${config.BACKUP_BARMAN_VERSION}`)}`);

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

/** `https://<backup>:<port>/v1/wal/<target>` of the daemon's WAL ingest (pg-native). */
const walIngestUrl = (config: DeployConfig, target: BackupTarget | string): string =>
  `https://${backupPrivateIp(config)}:${config.BACKUP_DAEMON_PORT}/v1/wal/${isAuditTarget(target) ? "audit_db" : "postgres_core"}`;

const walClientTlsArgs = `--cacert ${STORAGE_CERT_DIR}/internal-ca.crt --cert ${STORAGE_CERT_DIR}/wal-archive-client.crt --key ${STORAGE_CERT_DIR}/wal-archive-client.key`;

export const archiveCommand = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => {
  if (config.BACKUP_ENGINE_MODE === "pg-native") {
    return `curl --fail --silent --show-error --max-time 120 ${walClientTlsArgs} --upload-file %p ${walIngestUrl(config, target)}/%f`;
  }
  if (config.BACKUP_ENGINE_MODE === "barman") {
    const backupIp = backupSpec(config)?.privateIp ?? "backup-1";
    return `barman-wal-archive ${backupIp} ${barmanServerName(config, target)} %p`;
  }
  const prefix = isAuditTarget(target) ? backupAuditS3Prefix(config) : backupCoreS3Prefix(config);
  return `WALG_S3_PREFIX=${shellQuote(prefix)} sh -c 'set -a; . ${walGEnvFile(target)}; exec wal-g wal-push %p'`;
};

export const restoreCommand = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => {
  if (config.BACKUP_ENGINE_MODE === "pg-native") {
    return `curl --fail --silent --show-error --max-time 120 ${walClientTlsArgs} --output %p ${walIngestUrl(config, target)}/%f`;
  }
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
 * True when the backup node is the PostgreSQL primary's machine (same private
 * IP; the legacy `DB_SSH_HOST` stands in when no PG_PRIMARY_NODE is configured).
 */
export const isBackupColocatedWithPrimary = (
  config: Pick<DeployConfig, "BACKUP_NODE" | "PG_PRIMARY_NODE" | "DB_SSH_HOST">,
): boolean => {
  const backupIp = parseNodeList(config.BACKUP_NODE)[0]?.privateIp;
  const primaryIp = parseNodeList(config.PG_PRIMARY_NODE)[0]?.privateIp ?? (config.DB_SSH_HOST?.trim() || undefined);
  return Boolean(backupIp && primaryIp && backupIp === primaryIp);
};

/** True when the backup host also runs a PostgreSQL cluster (primary, replica, audit or log DB). */
const backupHostRunsPostgres = (config: DeployConfig): boolean => {
  const spec = backupSpec(config);
  if (!spec) return false;
  const nodes = [config.PG_PRIMARY_NODE, config.PG_REPLICA_NODES, config.AUDIT_DB_NODE, config.LOG_DB_NODE].flatMap((value) => parseNodeList(value));
  if (nodes.some((node) => node.privateIp === spec.privateIp || node.sshHost === spec.sshHost)) return true;
  const legacy = config.DB_SSH_HOST?.trim();
  return Boolean(legacy && (legacy === spec.privateIp || legacy === spec.sshHost));
};

/**
 * Account the backup daemon runs as. WAL-G's base backup reads PGDATA directly
 * (0700, owned by postgres) and connects over the local socket as `postgres`
 * (peer auth), so a wal-g daemon CO-LOCATED with the primary must run as
 * postgres. Barman and pg-native pull over the replication protocol (and
 * pg-native ingests WAL over mTLS), so they keep the dedicated, unprivileged
 * account, as does any daemon on a host that is not the primary's machine.
 */
export const backupDaemonUser = (
  config: Pick<DeployConfig, "BACKUP_ENGINE_MODE" | "BACKUP_NODE" | "PG_PRIMARY_NODE" | "DB_SSH_HOST">,
): "postgres" | "pgbackup" =>
  config.BACKUP_ENGINE_MODE === "wal-g" && isBackupColocatedWithPrimary(config) ? "postgres" : "pgbackup";

export const backupDaemonSystemdUnit = (config: DeployConfig): string => `[Unit]
Description=Payment Gateway pg-backup-daemon (pg-native / WAL-G / Barman control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${backupDaemonUser(config)}
Group=${backupDaemonUser(config)}
WorkingDirectory=/opt/pg-backup-daemon
EnvironmentFile=/etc/pg-backup/backup.env
Environment=BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT}
Environment=HOME=/var/lib/pg-backup
Environment=BUN_INSTALL_CACHE_DIR=/var/lib/pg-backup/.bun-cache
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
  config.BACKUP_LOCAL_REPO_DIR,
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

/** The daemon owns the restore drill; the cron fallback just asks it to run one. */
const pgNativeDrillTriggerScript = (config: DeployConfig): string => `#!/usr/bin/env bash
set -euo pipefail
CERT_DIR="\${BACKUP_CERT_DIR:-${config.BACKUP_DAEMON_CERT_DIR}}"
DAEMON_HOST="\${BACKUP_DAEMON_BIND_HOST:-${daemonBindHost(config)}}"
DAEMON_PORT="\${BACKUP_DAEMON_PORT:-${config.BACKUP_DAEMON_PORT}}"
curl -fsS --max-time 300 \\
  --cacert "$CERT_DIR/internal-ca.crt" \\
  --cert "$CERT_DIR/backup-client.crt" \\
  --key "$CERT_DIR/backup-client.key" \\
  -H 'content-type: application/json' \\
  -X POST --data '{}' \\
  "https://$DAEMON_HOST:$DAEMON_PORT/v1/drills/run"
`;

/**
 * The cron drill fallback (used only when the daemon's own scheduler is disabled) asks the daemon to run a drill.
 * Every engine gets the SAME full drill as the scheduler: PITR to the target time, promotion wait, archiving forced
 * off in the scratch cluster, and all three invariants. The previous root shell script restored the latest base
 * backup with no WAL replay and checked double-entry only.
 */
export const scratchRestoreVerifierScript = (config: DeployConfig): string => pgNativeDrillTriggerScript(config);

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
  if (!backupS3Configured(config)) {
    log("object store: none (pg-native keeps a local repository only)");
    return commands;
  }
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
  const hasS3 = backupS3Configured(config);
  const endpoint = hasS3 ? s3Endpoint(config) : "";
  const managed = hasS3 && resolveBackupS3Mode(config) === "managed-minio";
  return [
    ...(hasS3 ? [
      `test -n ${JSON.stringify(config.BACKUP_PRIMARY_S3_BUCKET)}`,
      // MinIO exposes a health route; other S3 services (R2/AWS) do not, so for
      // them any HTTP response proves the endpoint is reachable.
      managed
        ? `curl -fsS --max-time 10 ${JSON.stringify(endpoint)}/minio/health/live >/dev/null`
        : `curl -sS --max-time 10 -o /dev/null ${JSON.stringify(endpoint)} || { echo "S3 endpoint ${endpoint} is unreachable from the backup host; set BACKUP_S3_MODE=managed-minio to let the engine install MinIO there, or fix BACKUP_PRIMARY_S3_ENDPOINT" >&2; exit 1; }`,
    ] : []),
    ...(config.BACKUP_SECONDARY_SSH_TARGET
      ? [`timeout 5 bash -c '</dev/tcp/${config.BACKUP_SECONDARY_SSH_TARGET.split(":")[0]!.split("@").pop()}/22'`]
      : []),
    `test -n ${JSON.stringify(config.BACKUP_ENCRYPTION_KEY_HEX)}`,
  ];
};

export const verifyBackupTargetDryRun = (config: DeployConfig): string[] =>
  verifyBackupTargetCommands(config).map((command) => `echo ${JSON.stringify(`[dry-run] ${command}`)}`);

/**
 * pg-native cluster settings: WAL is pushed to the daemon over mTLS and the
 * daemon pulls base backups / streams WAL as the replication role. Sender and
 * slot limits are only raised when they are below what the daemon needs, so a
 * cluster tuned higher (the managed profile uses 16) is never lowered.
 */
export const pgNativeArchiveSql = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => [
  `ALTER SYSTEM SET wal_level = 'replica';`,
  `ALTER SYSTEM SET archive_mode = 'on';`,
  `ALTER SYSTEM SET archive_command = '${archiveCommand(config, target).replace(/'/g, "''")}';`,
  // The daemon has no WAL fetch endpoint; make sure no stale WAL-G/Barman restore_command lingers.
  `ALTER SYSTEM RESET restore_command;`,
  `ALTER SYSTEM SET archive_timeout = '60s';`,
  `ALTER SYSTEM SET summarize_wal = 'on';`,
  `SELECT 'ALTER SYSTEM SET max_wal_senders = 10' WHERE current_setting('max_wal_senders')::int < 4\\gexec`,
  `SELECT 'ALTER SYSTEM SET max_replication_slots = 10' WHERE current_setting('max_replication_slots')::int < 4\\gexec`,
  replicationRoleSql(config),
].join("\n");

export const archiveCommandSql = (config: DeployConfig, target: BackupTarget | string = "postgres_core"): string => config.BACKUP_ENGINE_MODE === "pg-native" ? pgNativeArchiveSql(config, target) : [
  `ALTER SYSTEM SET wal_level = 'replica';`,
  `ALTER SYSTEM SET archive_mode = 'on';`,
  `ALTER SYSTEM SET archive_command = '${archiveCommand(config, target).replace(/'/g, "''")}';`,
  `ALTER SYSTEM SET restore_command = '${restoreCommand(config, target).replace(/'/g, "''")}';`,
  `ALTER SYSTEM SET archive_timeout = '60s';`,
  // No pg_reload_conf() here: applyPostgresCluster reloads (and restarts only on
  // pending_restart) when postgresql.auto.conf actually changed.
].join("\n");

/**
 * Barman streaming settings plus the physical slot(s) Barman streams through.
 * The `barman` slot belongs to the core cluster, `barman_audit` to the audit
 * cluster. Without a config (legacy call) only `barman` is created. When the
 * audit DB lives inside the core cluster it shares that cluster's WAL, so the
 * core target also creates `barman_audit` there; a dedicated audit cluster
 * creates `barman_audit` on itself (never a dangling slot on the primary).
 */
export const barmanStreamingSql = (config?: DeployConfig, target: BackupTarget | string = "postgres_core"): string => {
  const primary = config ? parseNodeList(config.PG_PRIMARY_NODE)[0] : undefined;
  const audit = config ? parseNodeList(config.AUDIT_DB_NODE)[0] : undefined;
  const slots = isAuditTarget(target)
    ? ["barman_audit"]
    : ["barman", ...(audit && isSameCluster(primary, audit) ? ["barman_audit"] : [])];
  return [
    `ALTER SYSTEM SET wal_level = 'replica';`,
    `ALTER SYSTEM SET archive_mode = 'off';`,
    ...slots.map((slot) => `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = '${slot}') THEN PERFORM pg_create_physical_replication_slot('${slot}'); END IF; END $$;`),
  ].join("\n");
};

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
  /**
   * True when the daemon's environment, systemd unit or archive environment
   * changed. deployBackupDaemon restarts the daemon only then (or when the
   * source changed or it is down): a restart can interrupt a running backup.
   */
  daemonConfigChanged: boolean;
}

export interface BackupProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
  /** Restart every service even when nothing changed (`--force-restart`). */
  forceRestart?: boolean;
}

export const provisionBackupEngine = (input: BackupProvisionInput): BackupProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const outcomes: Record<string, ApplyOutcome> = {};
  const forceRestart = input.forceRestart === true;
  const ssh = backupSsh(config);
  if (!ssh) return { commands, nodes, outcomes, daemonConfigChanged: false };
  const spec = backupSpec(config);
  let daemonConfigChanged = false;
  const writeTracked = (input: { target: SshTarget; path: string; content: string; mode: number }): boolean => {
    const changed = isChanged(runner.writeRemoteFile({ ...input, sudo: true }));
    if (changed) daemonConfigChanged = true;
    return changed;
  };

  nodes.push(ssh.host);
  const pgNative = config.BACKUP_ENGINE_MODE === "pg-native";
  const daemonUser = backupDaemonUser(config);
  const pgPackages = postgresServerPackages(config);
  // The daemon drives pg_basebackup / pg_receivewal / pg_verifybackup /
  // pg_combinebackup / pg_dump / pg_restore and scratch restores (pg_ctl,
  // initdb, psql), so the backup host needs the full PostgreSQL 18 client AND
  // server binaries even when it is a dedicated backup-only machine.
  for (const command of [
    ensurePackagesScript({
      debian: [...(pgNative ? [] : ["barman"]), ...pgPackages.debian, "zstd", "lz4", "brotli", "xz-utils", "rclone", "curl", "ca-certificates"],
      arch: [...pgPackages.arch, "zstd", "lz4", "brotli", "xz", "rclone", "curl", "ca-certificates", ...(pgNative ? [] : ["python-pip"])],
      after: pgNative ? undefined : `if ! command -v apt-get >/dev/null 2>&1 && command -v pacman >/dev/null 2>&1; then ${barmanPipInstall(config)}; fi`,
    }),
    // The distro packages start a default cluster on 5432. A dedicated backup
    // host must not run it (it would squat the port and burn RAM); a host that
    // also runs a managed cluster is left alone.
    ...(backupHostRunsPostgres(config)
      ? []
      : [`systemctl disable --now postgresql ${shellQuote(`postgresql@${config.PG_VERSION}-main`)} >/dev/null 2>&1 || true; systemctl mask postgresql >/dev/null 2>&1 || true`]),
    ...(config.BACKUP_ENGINE_MODE === "wal-g" ? [walGInstallCommand(config)] : []),
    "id -u pgbackup >/dev/null 2>&1 || useradd --system --home /var/lib/pg-backup --shell /usr/sbin/nologin pgbackup",
    "usermod -aG pgbackup postgres 2>/dev/null || true",
    "getent group postgres >/dev/null 2>&1 && usermod -aG postgres pgbackup || true",
    "id -u barman >/dev/null 2>&1 || useradd --system --home /var/lib/barman --shell /usr/sbin/nologin barman",
    // Ownership is fixed with find (only entries that are wrong) so a multi-TB
    // local repo is not re-chowned file by file on every deploy.
    `install -d -m 0750 -o ${daemonUser} -g ${daemonUser} /var/lib/pg-backup /var/lib/pg-backup/.bun-cache ${shellQuote(config.BACKUP_DAEMON_CERT_DIR)} /var/log/pg-backup${pgNative ? ` ${shellQuote(config.BACKUP_LOCAL_REPO_DIR)}` : ""} && find /var/lib/pg-backup /var/log/pg-backup ${shellQuote(config.BACKUP_DAEMON_CERT_DIR)}${pgNative ? ` ${shellQuote(config.BACKUP_LOCAL_REPO_DIR)}` : ""} \\( ! -user ${daemonUser} -o ! -group ${daemonUser} \\) -exec chown ${daemonUser}:${daemonUser} {} +`,
    "install -d -m 0755 /etc/pg-backup",
    "systemctl daemon-reload",
  ]) {
    commands.push(command);
    runner.run(ssh, command, { sudo: true });
  }

  writeTracked({
    target: ssh,
    path: "/etc/pg-backup/backup.env",
    content: renderEnvFile(backupDaemonEnv(config)),
    mode: 0o600,
  });
  for (const [envPath, target] of pgNative ? [] : [
    ["/etc/pg-backup/wal-g-core.env", "postgres_core"],
    ["/etc/pg-backup/wal-g-audit.env", "audit_db"],
  ] as const) {
    writeTracked({
      target: ssh,
      path: envPath,
      content: renderEnvFile(walGEnvironment(config, target)),
      mode: 0o640,
    });
    // restore_command (run by the scratch postgres as user postgres) sources these files.
    runner.run(ssh, `chown root:${backupDaemonUser(config)} ${envPath} && chmod 0640 ${envPath}`, { sudo: true });
  }
  writeTracked({
    target: ssh,
    path: "/etc/systemd/system/pg-backup-daemon.service",
    content: backupDaemonSystemdUnit(config),
    mode: 0o644,
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
  if (config.BACKUP_ENGINE_MODE === "barman" || pgNative) {
    const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
    const audit = parseNodeList(config.AUDIT_DB_NODE)[0];
    // Replication-protocol credentials: Barman and the pg-native daemon both
    // authenticate as PG_REPLICATION_USER through PGPASSFILE.
    const pgpass = [
      `${pgpassField(primary?.privateIp ?? "127.0.0.1")}:${primary?.servicePort ?? 5432}:*:${pgpassField(config.PG_REPLICATION_USER)}:${pgpassField(config.PG_REPLICATION_PASSWORD)}`,
      ...(audit ? [`${pgpassField(audit.privateIp)}:${audit.servicePort}:*:${pgpassField(config.PG_REPLICATION_USER)}:${pgpassField(config.PG_REPLICATION_PASSWORD)}`] : []),
    ].join("\n");
    runner.run(ssh, `install -d -m 0700 -o ${daemonUser} -g ${daemonUser} /var/lib/pg-backup${pgNative ? "" : " /var/lib/pg-backup/barman"} ${shellQuote(dirname(config.BACKUP_PGPASSFILE))}`, { sudo: true });
    runner.writeRemoteFile({
      target: ssh,
      path: config.BACKUP_PGPASSFILE,
      content: `${pgpass}\n`,
      mode: 0o600,
      sudo: true,
    });
    runner.run(ssh, `chown ${daemonUser}:${daemonUser} ${shellQuote(config.BACKUP_PGPASSFILE)} && chmod 0600 ${shellQuote(config.BACKUP_PGPASSFILE)}`, { sudo: true });
    if (!pgNative) {
      runner.writeRemoteFile({ target: ssh, path: "/etc/barman.conf", content: barmanConfig(config), mode: 0o644, sudo: true });
    }
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
    const commandsForHost = pgNative
      ? [
          ensurePackagesScript({ debian: ["curl", "ca-certificates"], arch: ["curl", "ca-certificates"] }),
          // archive_command runs as the postgres OS user; fail the deploy loudly
          // (instead of archiving silently never) if it cannot read its client key.
          `d=${shellQuote(STORAGE_CERT_DIR)}; if getent group postgres >/dev/null 2>&1 && [ -f "$d/wal-archive-client.key" ]; then chgrp postgres "$d" "$d/wal-archive-client.key" && chmod 0750 "$d" && chmod 0640 "$d/wal-archive-client.key"; fi; for f in internal-ca.crt wal-archive-client.crt wal-archive-client.key; do runuser -u postgres -- test -r "$d/$f" || { echo "pg-native WAL archiving: $d/$f is missing or not readable by postgres" >&2; exit 1; }; done`,
        ]
      : config.BACKUP_ENGINE_MODE === "wal-g"
      ? [
          walGInstallCommand(config),
        ]
      : [
          ensurePackagesScript({
            debian: ["barman"],
            arch: ["python-pip"],
            after: `if ! command -v apt-get >/dev/null 2>&1 && command -v pacman >/dev/null 2>&1; then ${barmanPipInstall(config)}; fi`,
          }),
        ];
    for (const command of commandsForHost) {
      commands.push(command);
      runner.run(target, command, { sudo: true });
    }
  };

  /**
   * Applies archive_mode / archive_command to a cluster. The ALTER SYSTEM SQL is
   * idempotent; the cluster is reloaded and restarted ONLY when a setting is
   * actually `pending_restart` (archive_mode off -> on, the first deploy).
   */
  const applyArchiveConfig = (input: {
    target: SshTarget;
    archiveDir: string;
    sql: string;
    port: number;
    database: string;
    cluster: ReturnType<typeof pgClusterFor> | null;
  }): ApplyOutcome => {
    const archivePath = `${input.archiveDir}/archive.sql`;
    runner.run(input.target, `install -d -m 0700 -o postgres -g postgres ${shellQuote(input.archiveDir)}`, { sudo: true });
    runner.writeRemoteFile({ target: input.target, path: archivePath, content: `${input.sql}\n`, mode: 0o600, sudo: true });
    // ALTER SYSTEM rewrites postgresql.auto.conf with identical bytes when the
    // values already match, so hashing it before/after tells us whether the
    // archive settings really changed (and thus whether a reload is needed).
    const autoConf = input.cluster ? shellQuote(`${input.cluster.dataDir}/postgresql.auto.conf`) : null;
    const hash = autoConf ? `$(sha256sum ${autoConf} 2>/dev/null | cut -d' ' -f1)` : "none";
    const command = `chown postgres:postgres ${shellQuote(archivePath)}; trap ${shellQuote(`rm -rf ${shellQuote(input.archiveDir)}`)} EXIT; before=${hash}; runuser -u postgres -- psql -p ${input.port} -v ON_ERROR_STOP=1 -d ${shellQuote(input.database)} -f ${shellQuote(archivePath)} || exit $?; after=${hash}; if [ "$before" = "$after" ]; then echo ${ARCHIVE_MARKER}unchanged; else echo ${ARCHIVE_MARKER}changed; fi`;
    commands.push(command);
    const archiveChanged = !String(runner.capture(input.target, command, { sudo: true })).includes(`${ARCHIVE_MARKER}unchanged`);
    if (!input.cluster) {
      commands.push("systemctl reload postgresql");
      runner.run(input.target, "systemctl reload postgresql || true", { sudo: true });
      return "reloaded";
    }
    return applyPostgresCluster({ runner, ssh: input.target, cluster: input.cluster, changed: archiveChanged, force: forceRestart, commands, outcomes });
  };

  const primary = pgSsh(config);
  let clusterBounced = false;
  if (primary && (config.PG_MANAGE_VIA_SSH || config.BACKUP_ENABLED)) {
    installArchiveClient(primary);
    if (config.BACKUP_ENGINE_MODE === "wal-g") {
      writeWalGEnvironment(primary, walGEnvFile("postgres_core"), "postgres_core");
    }
    const archiveSql = config.BACKUP_ENGINE_MODE === "barman"
      ? barmanStreamingSql(config, "postgres_core")
      : archiveCommandSql(config, "postgres_core");
    const primarySpec = parseNodeList(config.PG_PRIMARY_NODE)[0];
    const outcome = applyArchiveConfig({
      target: primary,
      archiveDir: `/var/lib/postgresql/.pg-archive-config-${process.pid}`,
      sql: archiveSql,
      port: primarySpec?.servicePort ?? 5432,
      database: config.PG_DB_NAME,
      cluster: primarySpec ? pgClusterFor(config, "primary", primarySpec) : null,
    });
    clusterBounced = clusterBounced || outcomeBounced(outcome);
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
    const auditSpec = parseNodeList(config.AUDIT_DB_NODE)[0];
    // Audit living inside the core cluster (same host and port) shares ONE WAL
    // stream. Re-pointing archive_command at the audit prefix here would undo
    // the core setting above and flip it on every deploy, so the core target
    // owns the stream and the audit step leaves the cluster alone.
    if (isSameCluster(parseNodeList(config.PG_PRIMARY_NODE)[0], auditSpec) && primary) {
      commands.push("audit_db shares the primary cluster: archive_command stays owned by the postgres_core target");
    } else {
      const archiveSql = config.BACKUP_ENGINE_MODE === "barman"
        ? barmanStreamingSql(config, "audit_db")
        : archiveCommandSql(config, "audit_db");
      const outcome = applyArchiveConfig({
        target: audit,
        archiveDir: `/var/lib/postgresql/.pg-audit-archive-config-${process.pid}`,
        sql: archiveSql,
        port: auditSpec?.servicePort ?? 5432,
        database: config.AUDIT_DB_NAME,
        cluster: auditSpec ? pgClusterFor(config, "audit", auditSpec) : null,
      });
      clusterBounced = clusterBounced || outcomeBounced(outcome);
    }
  }

  // PgBouncer only needs attention when a cluster behind it was restarted: its
  // server connections are gone and a cached "database system is shutting down"
  // login failure would otherwise linger before core runs migrations through
  // it. It used to be restarted twice, unconditionally (2 x 90 s on a pool with
  // live clients).
  if (primary && config.PGBOUNCER_ENABLED && clusterBounced) {
    const primarySpec = parseNodeList(config.PG_PRIMARY_NODE)[0];
    applyPgbouncer({
      runner,
      ssh: primary,
      config,
      serverPort: primarySpec?.servicePort ?? 5432,
      upstreamBounced: true,
      force: forceRestart,
      commands,
      outcomes,
    });
  }

  return {
    commands,
    nodes,
    outcomes,
    daemonConfigChanged,
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
