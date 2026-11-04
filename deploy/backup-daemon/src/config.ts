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
const optionalNonEmpty = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  nonEmpty.optional(),
);

const hexKey = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]+$/, "must be a hexadecimal string")
  .refine((value) => value.length >= 32, "must contain at least 16 bytes")
  .refine((value) => value.length % 2 === 0, "must contain an even number of hex characters");

/** A deliberately small five-field cron validator (no @macros or seconds). */
export const isValidCron = (value: string): boolean => isValidCronExpression(value);

const cron = z.string().trim().refine(isValidCron, "must be a five-field cron expression");

export const BACKUP_ENGINE_MODES = ["wal-g", "barman"] as const;
export type BackupEngineMode = (typeof BACKUP_ENGINE_MODES)[number];

export const BACKUP_COMPRESSION_METHODS = ["zstd", "lz4", "lzma", "brotli", "none"] as const;
export type BackupCompression = (typeof BACKUP_COMPRESSION_METHODS)[number];

export const backupDaemonEnvSchema = z
  .object({
    BACKUP_ENGINE_MODE: z.enum(BACKUP_ENGINE_MODES),
    BACKUP_COMPRESSION: z.enum(BACKUP_COMPRESSION_METHODS).default("zstd"),
    BACKUP_ENCRYPTION_KEY_HEX: hexKey,
    BACKUP_PRIMARY_S3_ENDPOINT: z.url(),
    BACKUP_PRIMARY_S3_BUCKET: nonEmpty,
    BACKUP_PRIMARY_S3_ACCESS_KEY: z.string().default(""),
    BACKUP_PRIMARY_S3_SECRET_KEY: z.string().default(""),
    BACKUP_CORE_S3_PREFIX: optionalNonEmpty,
    BACKUP_AUDIT_S3_PREFIX: optionalNonEmpty,
    BACKUP_SECONDARY_SSH_TARGET: optionalNonEmpty,
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
    PG_PRIMARY_HOST: nonEmpty.default("127.0.0.1"),
    PG_PRIMARY_PORT: port.default(5432),
    PG_PRIMARY_USER: nonEmpty.default("postgres"),
    PG_PRIMARY_PASSWORD: z.string().default(""),
    PG_PRIMARY_DB_NAME: nonEmpty.default("payment_gateway_prod"),
    PG_AUDIT_DB_NAME: nonEmpty.default("pg_audit_db"),
    PG_AUDIT_PORT: port.default(5434),
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
    SCHEDULER_ENABLED: booleanish.default(true),
    SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30_000),
    REDIS_URL: optionalNonEmpty,
    REDIS_CLI_BIN: nonEmpty.default("redis-cli"),
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
    return {
      ...config,
      BACKUP_CORE_S3_PREFIX:
        config.BACKUP_CORE_S3_PREFIX ?? joinPrefix(config.BACKUP_PRIMARY_S3_BUCKET, "postgres_core"),
      BACKUP_AUDIT_S3_PREFIX:
        config.BACKUP_AUDIT_S3_PREFIX ?? joinPrefix(config.BACKUP_PRIMARY_S3_BUCKET, "audit_db"),
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
  ].filter((value) => value.length > 0);
