import { describe, expect, test } from "bun:test";
import {
  auditEndpoint,
  clusterTopology,
  collectSecretValues,
  isAuditConfigured,
  isAuditDedicatedCluster,
  isLogDbConfigured,
  isValidCron,
  replicationCredentials,
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

describe("pg-native mode and optional S3", () => {
  const native = { BACKUP_ENGINE_MODE: "pg-native" };
  const noS3 = { BACKUP_PRIMARY_S3_ENDPOINT: "", BACKUP_PRIMARY_S3_BUCKET: "", BACKUP_PRIMARY_S3_ACCESS_KEY: "", BACKUP_PRIMARY_S3_SECRET_KEY: "" };

  test("pg-native boots with a local repository only (air-gapped LAN) and defaults the repository directory", () => {
    const config = makeConfig({ ...native, ...noS3 });
    expect(config.BACKUP_ENGINE_MODE).toBe("pg-native");
    expect(config.BACKUP_LOCAL_REPO_DIR).toBe("/var/lib/pg-backup/repo");
    expect(config.BACKUP_PRIMARY_S3_ENDPOINT).toBe("");
    expect(config.BACKUP_CORE_S3_PREFIX).toBe("");
  });

  test("wal-g and barman still REQUIRE an S3 endpoint and bucket", () => {
    for (const mode of ["wal-g", "barman"]) {
      expect(() => makeConfig({ BACKUP_ENGINE_MODE: mode, ...noS3 })).toThrow(/BACKUP_PRIMARY_S3_(ENDPOINT|BUCKET)/);
    }
    expect(makeConfig({ BACKUP_ENGINE_MODE: "wal-g" }).BACKUP_LOCAL_REPO_DIR).toBe("");
  });

  test("an endpoint without a bucket (or the reverse) is rejected", () => {
    expect(() => makeConfig({ ...native, BACKUP_PRIMARY_S3_BUCKET: "" })).toThrow("provided together");
    expect(() => makeConfig({ ...native, BACKUP_PRIMARY_S3_ENDPOINT: "" })).toThrow("provided together");
  });

  test("the WAL stream alert threshold defaults to 256 MiB and is configurable", () => {
    expect(makeConfig(native).BACKUP_STREAM_ALERT_BYTES).toBe(256 * 1024 * 1024);
    expect(makeConfig({ ...native, BACKUP_STREAM_ALERT_BYTES: "1048576" }).BACKUP_STREAM_ALERT_BYTES).toBe(1048576);
    expect(() => makeConfig({ ...native, BACKUP_STREAM_ALERT_BYTES: "0" })).toThrow();
  });

  test("the WAL client allow-list defaults to the dedicated wal-archive-client and is separate from the control allow-list", () => {
    const config = makeConfig(native);
    expect(config.BACKUP_WAL_CLIENT_CNS).toBe("wal-archive-client");
    expect(config.BACKUP_ALLOWED_CLIENT_CNS).toBe("backup-client");
    expect(config.BACKUP_WAL_PUSH_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  test("replication and audit passwords are treated as secrets", () => {
    const config = makeConfig({ ...native, PG_REPLICATION_PASSWORD: "repl-secret-pw", PG_AUDIT_PASSWORD: "audit-secret-pw" });
    expect(collectSecretValues(config)).toEqual(expect.arrayContaining(["repl-secret-pw", "audit-secret-pw"]));
  });
});

describe("cluster topology helpers", () => {
  test("shared by default: the default audit PORT (5434) must not make a shared deployment look dedicated", () => {
    const config = makeConfig();
    expect(config.PG_AUDIT_PORT).toBe(5434);
    expect(config.PG_PRIMARY_PORT).toBe(5432);
    expect(isAuditDedicatedCluster(config)).toBe(false);
    expect(clusterTopology(config)).toBe("shared-audit");
  });

  test("dedicated when PG_AUDIT_DATA_DIR is set, or the audit host differs from the primary host", () => {
    expect(isAuditDedicatedCluster(makeConfig({ PG_AUDIT_DATA_DIR: "/var/lib/postgresql/18/audit" }))).toBe(true);
    expect(isAuditDedicatedCluster(makeConfig({ PG_PRIMARY_HOST: "10.0.0.5", PG_AUDIT_HOST: "10.0.0.6" }))).toBe(true);
    expect(isAuditDedicatedCluster(makeConfig({ PG_PRIMARY_HOST: "10.0.0.5", PG_AUDIT_HOST: "10.0.0.5" }))).toBe(false);
    expect(clusterTopology(makeConfig({ PG_AUDIT_DATA_DIR: "/x" }))).toBe("dedicated-audit");
  });

  test("audit and log database configuration flags", () => {
    expect(isAuditConfigured(makeConfig())).toBe(true);
    expect(isLogDbConfigured(makeConfig())).toBe(false);
    expect(isLogDbConfigured(makeConfig({ PG_LOG_DB_NAME: "pg_log_db" }))).toBe(true);
  });

  test("auditEndpoint: shared uses the primary host/port, dedicated uses the audit host/port, credentials fall back sensibly", () => {
    const shared = auditEndpoint(makeConfig({ PG_PRIMARY_HOST: "10.0.0.5" }));
    expect(shared).toMatchObject({ host: "10.0.0.5", port: 5432, user: "postgres" });
    const dedicated = auditEndpoint(makeConfig({ PG_PRIMARY_HOST: "10.0.0.5", PG_AUDIT_HOST: "10.0.0.6", PG_AUDIT_PORT: "5434", PG_AUDIT_USER: "audit_app", PG_AUDIT_PASSWORD: "ap" }));
    expect(dedicated).toEqual({ host: "10.0.0.6", port: 5434, user: "audit_app", password: "ap" });
    expect(auditEndpoint(makeConfig({ PG_PRIMARY_HOST: "10.0.0.5", PG_AUDIT_HOST: "10.0.0.6" })).password).toBe(PG_PASSWORD);
  });

  test("replication credentials fall back to the primary role", () => {
    expect(replicationCredentials(makeConfig())).toEqual({ user: "postgres", password: PG_PASSWORD });
    expect(replicationCredentials(makeConfig({ PG_REPLICATION_USER: "repl", PG_REPLICATION_PASSWORD: "rp" }))).toEqual({ user: "repl", password: "rp" });
  });
});
