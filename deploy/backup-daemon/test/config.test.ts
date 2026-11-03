import { describe, expect, test } from "bun:test";
import {
  collectSecretValues,
  isValidCron,
  loadBackupDaemonConfig,
  redactSecrets,
  redactSensitiveData,
  redactText,
  validateBackupDaemonConfig,
} from "../src/config";
import { baseEnv, ENCRYPTION_KEY_HEX, PG_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY, makeConfig } from "./helpers";

describe("backup daemon configuration", () => {
  test("applies production-safe defaults", () => {
    const config = makeConfig();
    expect(config.BACKUP_ENGINE_MODE).toBe("wal-g");
    expect(config.BACKUP_COMPRESSION).toBe("zstd");
    expect(config.BACKUP_DAEMON_PORT).toBe(4090);
    expect(config.BACKUP_DAEMON_BIND_HOST).toBe("127.0.0.1");
    expect(config.BACKUP_SCRATCH_PORT).toBe(55432);
    expect(config.BACKUP_FULL_CRON).toBe("0 2 * * 0");
    expect(config.BACKUP_DELTA_CRON).toBe("0 2 * * 1-6");
    expect(config.BACKUP_DRILL_CRON).toBe("0 4 * * 0");
    expect(config.BACKUP_RETENTION_FULL_COUNT).toBe(8);
    expect(config.BACKUP_RETENTION_WAL_DAYS).toBe(14);
    expect(config.WALG_BIN).toBe("wal-g");
    expect(config.BARMAN_BIN).toBe("barman");
    expect(config.PG_BIN_DIR).toBe("/usr/lib/postgresql/18/bin");
    expect(config.BACKUP_CATALOG_PATH).toBe("/var/lib/pg-backup/catalog.json");
    expect(config.BACKUP_SCRATCH_DIR).toBe("/var/lib/pg-backup/scratch");
    expect(config.BACKUP_SCRATCH_AUDIT_DIR).toBe("/var/lib/pg-backup/scratch/audit");
    expect(config.BACKUP_SCRATCH_AUDIT_PORT).toBe(55433);
    expect(config.BACKUP_CORE_S3_PREFIX).toBe("s3://libya-pg-backups-primary/prod/postgres_core");
    expect(config.BACKUP_AUDIT_S3_PREFIX).toBe("s3://libya-pg-backups-primary/prod/audit_db");
    expect(config.BARMAN_AUDIT_SERVER).toBe(config.PG_AUDIT_DB_NAME);
    expect(config.SCHEDULER_ENABLED).toBe(true);
    expect(config.SCHEDULER_TICK_MS).toBe(30_000);
    expect(config.BACKUP_ALLOW_INSECURE_HTTP).toBe(false);
  });

  test("allows explicit S3 prefixes, audit scratch paths and scheduler overrides", () => {
    const config = makeConfig({
      BACKUP_CORE_S3_PREFIX: "s3://custom/core",
      BACKUP_AUDIT_S3_PREFIX: "s3://custom/audit",
      BACKUP_SCRATCH_AUDIT_DIR: "/tmp/audit-drill",
      BACKUP_SCRATCH_AUDIT_PORT: "55999",
      BARMAN_AUDIT_SERVER: "audit-barman",
      SCHEDULER_ENABLED: "no",
      SCHEDULER_TICK_MS: "5000",
    });
    expect(config.BACKUP_CORE_S3_PREFIX).toBe("s3://custom/core");
    expect(config.BACKUP_AUDIT_S3_PREFIX).toBe("s3://custom/audit");
    expect(config.BACKUP_SCRATCH_AUDIT_DIR).toBe("/tmp/audit-drill");
    expect(config.BACKUP_SCRATCH_AUDIT_PORT).toBe(55999);
    expect(config.BARMAN_AUDIT_SERVER).toBe("audit-barman");
    expect(config.SCHEDULER_ENABLED).toBe(false);
    expect(config.SCHEDULER_TICK_MS).toBe(5000);
  });

  test("accepts barman mode and environment overrides", () => {
    const config = makeConfig({
      BACKUP_ENGINE_MODE: "barman",
      BACKUP_COMPRESSION: "lz4",
      BACKUP_DAEMON_PORT: "4190",
      BACKUP_ALLOW_INSECURE_HTTP: "yes",
      BACKUP_SECONDARY_SSH_TARGET: "vault@198.51.100.99:/mnt/offsite",
    });
    expect(config.BACKUP_ENGINE_MODE).toBe("barman");
    expect(config.BACKUP_COMPRESSION).toBe("lz4");
    expect(config.BACKUP_DAEMON_PORT).toBe(4190);
    expect(config.BACKUP_ALLOW_INSECURE_HTTP).toBe(true);
    expect(config.BACKUP_SECONDARY_SSH_TARGET).toBe("vault@198.51.100.99:/mnt/offsite");
  });

  test("rejects unknown engines, malformed keys, bad cron and one-sided S3 credentials", () => {
    expect(() => makeConfig({ BACKUP_ENGINE_MODE: "pg_basebackup" })).toThrow();
    expect(() => makeConfig({ BACKUP_ENCRYPTION_KEY_HEX: "not-hex" })).toThrow();
    expect(() => makeConfig({ BACKUP_ENCRYPTION_KEY_HEX: "ab".repeat(8) })).toThrow();
    expect(() => makeConfig({ BACKUP_FULL_CRON: "every sunday" })).toThrow();
    expect(() => makeConfig({ BACKUP_PRIMARY_S3_SECRET_KEY: "" })).toThrow();
    expect(() => makeConfig({ BACKUP_DAEMON_CERT_PATH: "/tmp/server.crt" })).toThrow();
  });

  test("validates cron expressions used by the schedule", () => {
    expect(isValidCron("0 2 * * 0")).toBe(true);
    expect(isValidCron("*/5 0-6 1,15 * 1-5")).toBe(true);
    expect(isValidCron("0 2 * *")).toBe(false);
    expect(isValidCron("0 2 * * sunday")).toBe(false);
  });

  test("exports both load and validate entry points", () => {
    expect(validateBackupDaemonConfig(baseEnv)).toEqual(loadBackupDaemonConfig(baseEnv));
    expect(ENCRYPTION_KEY_HEX).toHaveLength(64);
  });

  test("redacts credentials from objects and free text", () => {
    const config = makeConfig();
    const redacted = redactSecrets(config);
    expect(redacted.BACKUP_ENCRYPTION_KEY_HEX).toBe("[REDACTED]");
    expect(redacted.BACKUP_PRIMARY_S3_ACCESS_KEY).toBe("[REDACTED]");
    expect(redacted.BACKUP_PRIMARY_S3_SECRET_KEY).toBe("[REDACTED]");
    expect(redacted.PG_PRIMARY_PASSWORD).toBe("[REDACTED]");
    expect(redacted.BACKUP_PRIMARY_S3_BUCKET).toBe(config.BACKUP_PRIMARY_S3_BUCKET);

    const secrets = collectSecretValues(config);
    expect(secrets).toContain(PG_PASSWORD);
    expect(secrets).toContain(S3_ACCESS_KEY);
    expect(secrets).toContain(S3_SECRET_KEY);

    expect(redactText(`password=${PG_PASSWORD}`, secrets)).not.toContain(PG_PASSWORD);
    expect(redactText(`token: ${S3_SECRET_KEY}`, secrets)).not.toContain(S3_SECRET_KEY);
    expect(redactSensitiveData({ nested: { secret: "abc", keep: "yes" } })).toEqual({
      nested: { secret: "[REDACTED]", keep: "yes" },
    });
  });
});
