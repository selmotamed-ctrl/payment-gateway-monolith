import { z } from "zod";
import { isValidCronExpression } from "./cron";

/**
 * Environment configuration for pg-backup-daemon.
 *
 * The daemon wraps WAL-G / Barman. Everything that can be checked before the
 * first subprocess is started is validated here: a typo in a bucket URL or an
 * odd-length encryption key must fail at boot, not during a restore drill.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  });

const port = z.coerce.number().int().min(1).max(65535);
const nonEmpty = z.string().trim().min(1);
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalNonEmpty = z.preprocess(emptyToUndefined, nonEmpty.optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const hexKey = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]+$/, "must be a hexadecimal string")
  .refine((value) => value.length >= 32, "must contain at least 16 bytes")
  .refine((value) => value.length % 2 === 0, "must contain an even number of hex characters");

/** A deliberately small five-field cron validator (no @macros or seconds). */
export const isValidCron = (value: string): boolean => isValidCronExpression(value);

const cron = z.string().trim().refine(isValidCron, "must be a five-field cron expression");

export const BACKUP_ENGINE_MODES = ["pg-native", "wal-g", "barman"] as const;
export type BackupEngineMode = (typeof BACKUP_ENGINE_MODES)[number];

export const BACKUP_COMPRESSION_METHODS = ["zstd", "lz4", "lzma", "brotli", "none"] as const;
export type BackupCompression = (typeof BACKUP_COMPRESSION_METHODS)[number];

export const backupDaemonEnvSchema = z
  .object({
    BACKUP_ENGINE_MODE: z.enum(BACKUP_ENGINE_MODES),
    BACKUP_COMPRESSION: z.enum(BACKUP_COMPRESSION_METHODS).default("zstd"),
    BACKUP_ENCRYPTION_KEY_HEX: hexKey,
    // Optional in pg-native mode (a local repository alone is a valid air-gapped setup); required for wal-g/barman.
    BACKUP_PRIMARY_S3_ENDPOINT: optionalUrl,
    BACKUP_PRIMARY_S3_BUCKET: optionalNonEmpty,
    BACKUP_PRIMARY_S3_ACCESS_KEY: z.string().default(""),
    BACKUP_PRIMARY_S3_SECRET_KEY: z.string().default(""),
    BACKUP_CORE_S3_PREFIX: optionalNonEmpty,
    BACKUP_AUDIT_S3_PREFIX: optionalNonEmpty,
    BACKUP_SECONDARY_SSH_TARGET: optionalNonEmpty,
    // Local content repository (tier 1). Defaults to /var/lib/pg-backup/repo in pg-native mode, disabled otherwise.
    BACKUP_LOCAL_REPO_DIR: optionalNonEmpty,
    // Plain WAL streamed by pg_receivewal waits here (0700) until it is encrypted into the repository.
    BACKUP_WAL_SPOOL_DIR: nonEmpty.default("/var/lib/pg-backup/wal_spool"),
    // pg_basebackup / pg_combinebackup / pg_dump working area.
    BACKUP_STAGING_DIR: nonEmpty.default("/var/lib/pg-backup/staging"),
    // Comma separated client CNs allowed to PUT /v1/wal/... (and nothing else).
    BACKUP_WAL_CLIENT_CNS: nonEmpty.default("wal-archive-client"),
    BACKUP_WAL_PUSH_MAX_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
    BACKUP_WAL_STREAMING_ENABLED: booleanish.default(true),
    // The continuous WAL stream is "unhealthy" once it is this many bytes behind the primary (default 256 MiB = 16 segments).
    BACKUP_STREAM_ALERT_BYTES: z.coerce.number().int().positive().default(256 * 1024 * 1024),
    // Off-site copy never deletes by default; set true to mirror deletions (rclone sync / rsync --delete).
    BACKUP_SECONDARY_MIRROR_DELETE: booleanish.default(false),
    BACKUP_FULL_CRON: cron.default("0 2 * * 0"),
    BACKUP_DELTA_CRON: cron.default("0 2 * * 1-6"),
    BACKUP_DRILL_CRON: cron.default("0 4 * * 0"),
    BACKUP_RETENTION_FULL_COUNT: z.coerce.number().int().min(1).default(8),
    BACKUP_RETENTION_WAL_DAYS: z.coerce.number().int().min(1).default(14),
    BACKUP_ALERT_LAG_SECONDS: z.coerce.number().int().min(1).default(300),
    BACKUP_DAEMON_PORT: port.default(4090),
    BACKUP_DAEMON_BIND_HOST: nonEmpty.default("127.0.0.1"),
    BACKUP_DAEMON_CERT_PATH: optionalNonEmpty,
    BACKUP_DAEMON_KEY_PATH: optionalNonEmpty,
    BACKUP_DAEMON_CA_CERT_PATH: optionalNonEmpty,
    // Comma separated subject CNs (or DNS SANs) of client certificates allowed to call the API.
    BACKUP_ALLOWED_CLIENT_CNS: nonEmpty.default("backup-client"),
    // Optional env files that restore_command sources instead of embedding S3/encryption secrets in postgresql.auto.conf.
    // The audit target must use its own prefix, so it has a separate file.
    WALG_ENV_FILE: optionalNonEmpty,
    WALG_ENV_FILE_AUDIT: optionalNonEmpty,
    PG_PRIMARY_HOST: nonEmpty.default("127.0.0.1"),
    PG_PRIMARY_PORT: port.default(5432),
    PG_PRIMARY_USER: nonEmpty.default("postgres"),
    PG_PRIMARY_PASSWORD: z.string().default(""),
    PG_PRIMARY_DB_NAME: nonEmpty.default("payment_gateway_prod"),
    PG_AUDIT_DB_NAME: nonEmpty.default("pg_audit_db"),
    // Set only when the audit database lives on a different host than the primary (dedicated cluster).
    PG_AUDIT_HOST: optionalNonEmpty,
    PG_AUDIT_USER: optionalNonEmpty,
    PG_AUDIT_PASSWORD: z.string().default(""),
    PG_AUDIT_PORT: port.default(5434),
    PG_LOG_DB_NAME: optionalNonEmpty,
    // Replication role used by pg_basebackup / pg_receivewal (falls back to the primary user).
    PG_REPLICATION_USER: optionalNonEmpty,
    PG_REPLICATION_PASSWORD: z.string().default(""),
    PG_REPLICATION_SLOT: nonEmpty.default("pg_backup_core"),
    PG_AUDIT_REPLICATION_SLOT: nonEmpty.default("pg_backup_audit"),
    PG_SSLMODE: z.enum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]).default("prefer"),
    PG_REPLICA_NODES: z.string().default(""),
    PG_DATA_DIR: nonEmpty.default("/var/lib/postgresql/18/main"),
    PG_AUDIT_DATA_DIR: optionalNonEmpty,
    WALG_BIN: nonEmpty.default("wal-g"),
    BARMAN_BIN: nonEmpty.default("barman"),
    BARMAN_CLOUD_BIN: nonEmpty.default("barman-cloud-backup"),
    BARMAN_SERVER: optionalNonEmpty,
    BARMAN_AUDIT_SERVER: optionalNonEmpty,
    PG_BIN_DIR: nonEmpty.default("/usr/lib/postgresql/18/bin"),
    BACKUP_CATALOG_PATH: nonEmpty.default("/var/lib/pg-backup/catalog.json"),
    BACKUP_SCRATCH_DIR: nonEmpty.default("/var/lib/pg-backup/scratch"),
    BACKUP_SCRATCH_PORT: port.default(55432),
    BACKUP_SCRATCH_AUDIT_DIR: optionalNonEmpty,
    BACKUP_SCRATCH_AUDIT_PORT: port.default(55433),
    BACKUP_ALLOW_INSECURE_HTTP: booleanish.default(false),
    BACKUP_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
    // How long a restore drill waits for WAL replay to reach the target time and promote.
    BACKUP_RECOVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
    SCHEDULER_ENABLED: booleanish.default(true),
    SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30_000),
    REDIS_URL: optionalNonEmpty,
    REDIS_CLI_BIN: nonEmpty.default("redis-cli"),
    // Shared object & asset storage vault: parity sync and the escrowed-KEK
    // decryption drill. Present only when OBJECT_STORAGE_NODE is configured.
    OBJECT_STORAGE_DAEMON_URL: optionalUrl,
    OBJECT_STORAGE_TLS_CA_PATH: optionalNonEmpty,
    OBJECT_STORAGE_TLS_CLIENT_CERT_PATH: optionalNonEmpty,
    OBJECT_STORAGE_TLS_CLIENT_KEY_PATH: optionalNonEmpty,
    OBJECT_STORAGE_ROOT_DIR: optionalNonEmpty,
    OBJECT_STORAGE_KEK_KEYRING: z.string().default(""),
    OBJECT_STORAGE_ACTIVE_KEK_VERSION: z.coerce.number().int().positive().default(1),
    OBJECT_STORAGE_VERIFY_PARITY: booleanish.default(true),
    OBJECT_STORAGE_DRILL_SAMPLE: z.coerce.number().int().min(0).max(100).default(10),
  })
  .superRefine((config, ctx) => {
    if (Boolean(config.BACKUP_DAEMON_CERT_PATH) !== Boolean(config.BACKUP_DAEMON_KEY_PATH)) {
      ctx.addIssue({
        code: "custom",
        message: "BACKUP_DAEMON_CERT_PATH and BACKUP_DAEMON_KEY_PATH must be provided together",
        path: ["BACKUP_DAEMON_CERT_PATH"],
      });
    }
    if (config.BACKUP_DAEMON_CA_CERT_PATH && !config.BACKUP_DAEMON_CERT_PATH) {
      ctx.addIssue({
        code: "custom",
        message: "mTLS requires BACKUP_DAEMON_CERT_PATH and BACKUP_DAEMON_KEY_PATH as well as the CA",
        path: ["BACKUP_DAEMON_CA_CERT_PATH"],
      });
    }
    if (config.BACKUP_ENGINE_MODE !== "pg-native") {
      for (const key of ["BACKUP_PRIMARY_S3_ENDPOINT", "BACKUP_PRIMARY_S3_BUCKET"] as const) {
        if (!config[key]) {
          ctx.addIssue({
            code: "custom",
            message: `${key} is required when BACKUP_ENGINE_MODE=${config.BACKUP_ENGINE_MODE}`,
            path: [key],
          });
        }
      }
    }
    if (Boolean(config.BACKUP_PRIMARY_S3_ENDPOINT) !== Boolean(config.BACKUP_PRIMARY_S3_BUCKET)) {
      ctx.addIssue({
        code: "custom",
        message: "BACKUP_PRIMARY_S3_ENDPOINT and BACKUP_PRIMARY_S3_BUCKET must be provided together",
        path: ["BACKUP_PRIMARY_S3_ENDPOINT"],
      });
    }
    if (config.OBJECT_STORAGE_DAEMON_URL && !config.OBJECT_STORAGE_KEK_KEYRING) {
      ctx.addIssue({
        code: "custom",
        message: "OBJECT_STORAGE_KEK_KEYRING is required when OBJECT_STORAGE_DAEMON_URL is set (restore drills decrypt sampled objects)",
        path: ["OBJECT_STORAGE_KEK_KEYRING"],
      });
    }
    if (Boolean(config.OBJECT_STORAGE_TLS_CLIENT_CERT_PATH) !== Boolean(config.OBJECT_STORAGE_TLS_CLIENT_KEY_PATH)) {
      ctx.addIssue({
        code: "custom",
        message: "OBJECT_STORAGE_TLS_CLIENT_CERT_PATH and OBJECT_STORAGE_TLS_CLIENT_KEY_PATH must be provided together",
        path: ["OBJECT_STORAGE_TLS_CLIENT_CERT_PATH"],
      });
    }
    if (Boolean(config.BACKUP_PRIMARY_S3_ACCESS_KEY) !== Boolean(config.BACKUP_PRIMARY_S3_SECRET_KEY)) {
      ctx.addIssue({
        code: "custom",
        message: "BACKUP_PRIMARY_S3_ACCESS_KEY and BACKUP_PRIMARY_S3_SECRET_KEY must be provided together",
        path: ["BACKUP_PRIMARY_S3_ACCESS_KEY"],
      });
    }
  })
  .transform((config) => {
    const joinPrefix = (base: string, suffix: string): string =>
      `${base.replace(/\/+$/, "")}/${suffix}`;
    const bucket = config.BACKUP_PRIMARY_S3_BUCKET ?? "";
    return {
      ...config,
      BACKUP_PRIMARY_S3_ENDPOINT: config.BACKUP_PRIMARY_S3_ENDPOINT ?? "",
      BACKUP_PRIMARY_S3_BUCKET: bucket,
      BACKUP_LOCAL_REPO_DIR:
        config.BACKUP_LOCAL_REPO_DIR ??
        (config.BACKUP_ENGINE_MODE === "pg-native" ? "/var/lib/pg-backup/repo" : ""),
      BACKUP_CORE_S3_PREFIX:
        config.BACKUP_CORE_S3_PREFIX ?? (bucket ? joinPrefix(bucket, "postgres_core") : ""),
      BACKUP_AUDIT_S3_PREFIX:
        config.BACKUP_AUDIT_S3_PREFIX ?? (bucket ? joinPrefix(bucket, "audit_db") : ""),
      BARMAN_AUDIT_SERVER: config.BARMAN_AUDIT_SERVER ?? config.PG_AUDIT_DB_NAME,
      BACKUP_SCRATCH_AUDIT_DIR:
        config.BACKUP_SCRATCH_AUDIT_DIR ?? joinPrefix(config.BACKUP_SCRATCH_DIR, "audit"),
    };
  });

export type BackupDaemonConfig = z.infer<typeof backupDaemonEnvSchema>;

export const validateBackupDaemonConfig = (
  env: Record<string, string | undefined>,
): BackupDaemonConfig => backupDaemonEnvSchema.parse(env);

export const loadBackupDaemonConfig = (
  env: Record<string, string | undefined> = process.env,
): BackupDaemonConfig => validateBackupDaemonConfig(env);

export const validate = loadBackupDaemonConfig;

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|encryption[_-]?key|private[_-]?key|authorization)/i;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces values that look like credentials, even when they are embedded in text. */
export const redactText = (text: string, secretValues: string[] = []): string => {
  let redacted = text;
  for (const secret of [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (secret.length < 4) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  return redacted.replace(
    /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2[REDACTED]",
  );
};

/** Recursively removes credential-shaped keys/values from an object before it is returned. */
export const redactSensitiveData = <T>(value: T, secretValues: string[] = []): T => {
  if (typeof value === "string") {
    return redactText(value, secretValues) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveData(entry, secretValues)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitiveData(entry, secretValues);
    }
    return result as T;
  }
  return value;
};

export const redactSecrets = <T>(value: T): T => redactSensitiveData(value, []);

/** Secret values that must never appear in an HTTP response or a log line. */
export const collectSecretValues = (config: BackupDaemonConfig): string[] =>
  [
    config.BACKUP_ENCRYPTION_KEY_HEX,
    config.BACKUP_PRIMARY_S3_ACCESS_KEY,
    config.BACKUP_PRIMARY_S3_SECRET_KEY,
    config.PG_PRIMARY_PASSWORD,
    config.PG_AUDIT_PASSWORD,
    config.PG_REPLICATION_PASSWORD,
    config.OBJECT_STORAGE_KEK_KEYRING,
  ].filter((value) => value.length > 0);

/**
 * Topology helpers. The audit database either lives inside the primary cluster
 * (shared: it is captured by the core physical backup) or in its own cluster
 * (dedicated: it needs its own physical backup and drill cluster).
 *
 * `PG_AUDIT_PORT` is deliberately NOT part of the decision: it defaults to
 * 5434 and would make every shared deployment look dedicated.
 */
/** True when the daemon is wired to the shared object-storage vault. */
export const objectStorageBackupConfigured = (
  config: Pick<BackupDaemonConfig, "OBJECT_STORAGE_DAEMON_URL" | "OBJECT_STORAGE_ROOT_DIR">,
): boolean => Boolean(config.OBJECT_STORAGE_DAEMON_URL || config.OBJECT_STORAGE_ROOT_DIR);

export const isAuditDedicatedCluster = (
  config: Pick<BackupDaemonConfig, "PG_AUDIT_DATA_DIR" | "PG_AUDIT_HOST" | "PG_PRIMARY_HOST">,
): boolean =>
  Boolean(config.PG_AUDIT_DATA_DIR) ||
  Boolean(config.PG_AUDIT_HOST && config.PG_AUDIT_HOST !== config.PG_PRIMARY_HOST);

export const isAuditConfigured = (config: Pick<BackupDaemonConfig, "PG_AUDIT_DB_NAME">): boolean =>
  config.PG_AUDIT_DB_NAME.trim().length > 0;

export const isLogDbConfigured = (config: Pick<BackupDaemonConfig, "PG_LOG_DB_NAME">): boolean =>
  Boolean(config.PG_LOG_DB_NAME && config.PG_LOG_DB_NAME.trim().length > 0);

export type ClusterTopology = "shared-audit" | "dedicated-audit";

export const clusterTopology = (config: Parameters<typeof isAuditDedicatedCluster>[0]): ClusterTopology =>
  isAuditDedicatedCluster(config) ? "dedicated-audit" : "shared-audit";

/** Host/port/user/password of the cluster that holds the audit database. */
export const auditEndpoint = (
  config: BackupDaemonConfig,
): { host: string; port: number; user: string; password: string } =>
  isAuditDedicatedCluster(config)
    ? {
        host: config.PG_AUDIT_HOST ?? config.PG_PRIMARY_HOST,
        port: config.PG_AUDIT_PORT,
        user: config.PG_AUDIT_USER ?? config.PG_PRIMARY_USER,
        password: config.PG_AUDIT_PASSWORD || config.PG_PRIMARY_PASSWORD,
      }
    : {
        host: config.PG_PRIMARY_HOST,
        port: config.PG_PRIMARY_PORT,
        user: config.PG_AUDIT_USER ?? config.PG_PRIMARY_USER,
        password: config.PG_AUDIT_PASSWORD || config.PG_PRIMARY_PASSWORD,
      };

/** Replication credentials, falling back to the primary role. */
export const replicationCredentials = (
  config: BackupDaemonConfig,
): { user: string; password: string } => ({
  user: config.PG_REPLICATION_USER ?? config.PG_PRIMARY_USER,
  password: config.PG_REPLICATION_PASSWORD || config.PG_PRIMARY_PASSWORD,
});

export const parseCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
