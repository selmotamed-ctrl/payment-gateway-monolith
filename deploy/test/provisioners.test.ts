import { describe, expect, test } from "bun:test";
import { loadDeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import type { ProvisionRunner } from "../provisioners/postgres18Provisioner";
import {
  bootstrapCommands,
  pgbouncerIni,
  postgresConfigPath,
  postgresConfigSnippet,
  postgresMainConfigPath,
  provisionPostgres18,
  replicaCommands,
} from "../provisioners/postgres18Provisioner";
import { provisionRedis, redisConfigSnippet, redisFirewallCommands } from "../provisioners/redisProvisioner";
import {
  AUDIT_DB_DDL,
  LOG_DB_DDL,
  auditDatabaseDdl,
  ensureLogPartitions,
  logDatabaseDdl,
  logPartitionCronLine,
  provisionAuditAndLogDb,
} from "../provisioners/auditAndLogDbProvisioner";
import {
  archiveCommand,
  archiveCommandSql,
  backupCronEntries,
  backupCronFile,
  backupDaemonSystemdUnit,
  backupDaemonEnv,
  backupDaemonTriggerScript,
  journalLinePartitionCronLine,
  provisionBackupEngine,
  verifyBackupTargetCommands,
  walGEnvironment,
} from "../provisioners/backupEngineProvisioner";

const SOURCE = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.10.10:5432/gateway"
DB_ENGINE="postgresql"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000"
CORE_SSH_KEY_PATH="~/.ssh/core"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
MERCHANT_NODES="merch-1@10.10.3.11:22:10.10.3.11:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@10.10.4.11:22:10.10.4.11:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PG_REPLICATION_PASSWORD="ultra-strong-repl-K7p2Zq9w"
PG_AUDIT_DATA_DIR="/var/lib/postgresql/18/audit"
PGBOUNCER_ENABLED="true"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_KEY_PATH="~/.ssh/redis"
REDIS_PASSWORD="ultra-strong-redis-K7p2Zq9w"
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@10.10.12.10:22:10.10.12.10:5432"
AUDIT_DB_SSH_KEY_PATH="~/.ssh/audit"
AUDIT_DB_PASSWORD="ultra-strong-audit-K7p2Zq9w"
LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@10.10.12.20:22:10.10.12.20:5432"
LOG_DB_SSH_KEY_PATH="~/.ssh/log"
LOG_DB_PASSWORD="ultra-strong-log-K7p2Zq9w"
LOG_RETENTION_MONTHS="12"
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_ENGINE_MODE="barman"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.example.invalid"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
BACKUP_PRIMARY_S3_ACCESS_KEY="access"
BACKUP_PRIMARY_S3_SECRET_KEY="secret"
BACKUP_ENCRYPTION_KEY_HEX="9f3a7c1e5b2d84f06a1c3e7b9d2f4a8c5e0b6d1a3f7c9e2b4d8a0c6e1f5b3a79"
BACKUP_SECONDARY_SSH_TARGET="vault@198.51.100.99:/mnt/offsite"
`;

const config = () => {
  const result = loadDeployConfig(SOURCE);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

class FakeRunner implements ProvisionRunner {
  readonly dryRun = true;
  readonly runs: Array<{ target: SshTarget; command: string }> = [];
  readonly writes: Array<{ target: SshTarget; path: string; content: string; mode?: number }> = [];
  run(target: SshTarget, command: string): void {
    this.runs.push({ target, command });
  }
  capture(): string {
    return "";
  }
  writeRemoteFile(input: { target: SshTarget; path: string; content: string | Buffer; mode?: number }): void {
    this.writes.push({ target: input.target, path: input.path, content: input.content.toString(), mode: input.mode });
  }
}

describe("PostgreSQL 18 provisioner", () => {
  test("renders the exact tuning block", () => {
    const snippet = postgresConfigSnippet(config());
    for (const line of [
      "listen_addresses = '*'",
      "max_connections = 300",
      "shared_buffers = 8GB",
      "effective_cache_size = 24GB",
      "work_mem = 32MB",
      "maintenance_work_mem = 1GB",
      "io_method = 'worker'",
      "synchronous_commit = on",
      "wal_level = replica",
      "max_wal_senders = 16",
      "max_replication_slots = 16",
      "max_wal_size = 16GB",
      "min_wal_size = 2GB",
      "checkpoint_completion_target = 0.9",
      "random_page_cost = 1.1",
      "shared_preload_libraries = 'pg_stat_statements'",
      "track_io_timing = on",
    ]) {
      expect(snippet).toContain(line);
    }
  });

  test("bootstrap installs PostgreSQL 18 and PgBouncer", () => {
    const commands = bootstrapCommands(config());
    expect(commands.join("\n")).toContain("postgresql-18");
    expect(commands.join("\n")).toContain("pgbouncer");
  });

  test("replica commands use streaming basebackup with -R, a password and the created slot", () => {
    const commands = replicaCommands(
      { nodeId: "pg-pri", privateIp: "10.10.10.10", servicePort: 5432 },
      { nodeId: "pg-rep-1", privateIp: "10.10.10.11", servicePort: 5432 },
      config(),
    ).join("\n");
    // The password is read from the 0600 .pgpass, never passed as PGPASSWORD on a command line.
    expect(commands).toContain("PGPASSFILE=/var/lib/postgresql/.pgpass");
    expect(commands).not.toContain("PGPASSWORD=");
    expect(commands).toContain("/var/lib/postgresql/.pgpass");
    expect(commands).toContain("pg_basebackup -h '10.10.10.10' -p 5432 -U 'pg_replicator'");
    expect(commands).toContain("-Fp -Xs -P -R -S");
    expect(commands).toContain("primary_slot_name");
  });

  test("PgBouncer listens for remote cores, uses server TLS, transaction mode and prepared statements", () => {
    const ini = pgbouncerIni(config());
    expect(ini).toContain("listen_addr = 0.0.0.0");
    expect(ini).toContain("listen_port = 6432");
    expect(ini).toContain("pool_mode = transaction");
    expect(ini).toContain("server_tls_sslmode = prefer");
    expect(ini).toContain("max_client_conn = 2000");
    expect(ini).toContain("default_pool_size = 50");
    expect(ini).toContain("reserve_pool_size = 10");
    expect(ini).toContain("max_prepared_statements = 256");
    expect(ini).toContain("server_reset_query_always = 0");
    expect(ini).toContain("ignore_startup_parameters = extra_float_digits,search_path");
  });

  test("provisioning writes config, pg_hba, roles, slots and replica basebackup", () => {
    const runner = new FakeRunner();
    const report = provisionPostgres18({ runner, config: config(), dryRun: true });
    expect(report.nodes).toEqual(["10.10.10.10", "10.10.10.11"]);
    expect(runner.writes.some((write) => write.path.endsWith("/postgresql.conf"))).toBe(true);
    expect(runner.writes.some((write) => write.path.endsWith("pg_hba.conf") && write.content.includes("hostssl"))).toBe(true);
    expect(runner.writes.some((write) => write.path.endsWith("pg_hba.conf") && write.content.includes("10.10.13.10"))).toBe(true);
    const sql = runner.writes.find((write) => write.content.includes("CREATE DATABASE"));
    expect(sql?.content).toContain('CREATE DATABASE "payment_gateway_prod"');
    expect(sql?.content).toContain("pg_create_physical_replication_slot");
    expect(runner.runs.some((run) => run.command.includes("pg_basebackup"))).toBe(true);
    expect(runner.writes.some((write) => write.path === "/etc/pgbouncer/pgbouncer.ini")).toBe(true);
  });

  test("is idempotent and never performs real network work in dry-run", () => {
    const first = new FakeRunner();
    const second = new FakeRunner();
    const reportA = provisionPostgres18({ runner: first, config: config(), dryRun: true });
    const reportB = provisionPostgres18({ runner: second, config: config(), dryRun: true });
    expect(reportA.commands).toEqual(reportB.commands);
    expect(first.writes.map((write) => write.path)).toEqual(second.writes.map((write) => write.path));
    expect(first.dryRun).toBe(true);
  });
});

describe("Redis provisioner", () => {
  test("binds the private IP, requires a password and saves hourly", () => {
    const snippet = redisConfigSnippet(config(), "10.10.11.10");
    expect(snippet).toContain("bind 10.10.11.10 127.0.0.1");
    expect(snippet).toContain("requirepass ultra-strong-redis-K7p2Zq9w");
    expect(snippet).toContain("save 3600 1");
    expect(snippet).toContain("maxmemory 4gb");
    expect(redisFirewallCommands(config()).join("\n")).toContain("10.10.1.11");
    expect(redisFirewallCommands(config()).join("\n")).toContain("10.10.13.10");
  });

  test("provisions every redis node through the runner", () => {
    const runner = new FakeRunner();
    const report = provisionRedis({ runner, config: config(), dryRun: true });
    expect(report.nodes).toEqual(["10.10.11.10"]);
    expect(runner.writes.some((write) => write.path === "/etc/redis/redis.conf")).toBe(true);
    expect(runner.runs.some((run) => run.command.includes("redis-server"))).toBe(true);
  });
});

describe("Audit and log database provisioner", () => {
  test("the audit DDL contains the hash chain, immutable trigger and least-privilege grants", () => {
    expect(AUDIT_DB_DDL).toContain("prev_hash           CHAR(64)");
    expect(AUDIT_DB_DDL).toContain("row_hash            CHAR(64)");
    expect(AUDIT_DB_DDL).toContain("forbid_audit_mutation");
    expect(AUDIT_DB_DDL).toContain("BEFORE UPDATE OR DELETE OR TRUNCATE");
    expect(AUDIT_DB_DDL).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM PUBLIC");
    const ddl = auditDatabaseDdl(config());
    expect(ddl).toContain('GRANT SELECT, INSERT ON audit_records TO "pg_audit_writer"');
    expect(ddl).toContain("GRANT USAGE, SELECT ON ALL SEQUENCES");
    expect(ddl).toContain("ALTER DEFAULT PRIVILEGES");
    expect(ddl).not.toContain("GRANT UPDATE");
  });

  test("the log DDL is monthly partitioned and grants only SELECT/INSERT to the writer", () => {
    expect(LOG_DB_DDL).toContain("PARTITION BY RANGE (created_at)");
    expect(LOG_DB_DDL).toContain("attempt_step_logs");
    expect(LOG_DB_DDL).toContain("http_access_logs");
    const ddl = logDatabaseDdl(config());
    expect(ddl).toContain('GRANT SELECT, INSERT ON attempt_step_logs, http_access_logs TO "pg_log_writer"');
    expect(ddl).toContain("GRANT USAGE, SELECT ON ALL SEQUENCES");
    expect(ddl).not.toContain("GRANT UPDATE");
  });

  test("ensureLogPartitions creates six months for both tables plus the maintenance function", () => {
    const sql = ensureLogPartitions(new Date("2026-11-03T00:00:00Z"), 6);
    for (const suffix of ["2026_11", "2026_12", "2027_01", "2027_02", "2027_03", "2027_04"]) {
      expect(sql).toContain(`attempt_step_logs_${suffix}`);
      expect(sql).toContain(`http_access_logs_${suffix}`);
    }
    expect((sql.match(/CREATE TABLE IF NOT EXISTS attempt_step_logs_\d{4}_\d{2}/g) ?? []).length).toBe(6);
    expect((sql.match(/CREATE TABLE IF NOT EXISTS http_access_logs_\d{4}_\d{2}/g) ?? []).length).toBe(6);
    expect(sql).toContain("CREATE OR REPLACE FUNCTION ensure_log_partitions");
    expect(sql).toContain("retention_months");
    expect(sql).toContain("DROP TABLE IF EXISTS");
    expect(sql).toContain("make_interval(months => retention_months)");
  });

  test("the log retention cron passes LOG_RETENTION_MONTHS to the maintenance function", () => {
    expect(logPartitionCronLine(config())).toContain("ensure_log_partitions(6, 12)");
  });

  test("provisions both databases and installs the partition cron", () => {
    const runner = new FakeRunner();
    const report = provisionAuditAndLogDb({ runner, config: config(), dryRun: true, now: new Date("2026-11-03T00:00:00Z") });
    expect(report.nodes).toEqual(["10.10.12.10", "10.10.12.20"]);
    expect(runner.writes.some((write) => write.content.includes("audit_records"))).toBe(true);
    expect(runner.writes.some((write) => write.content.includes("PARTITION OF http_access_logs"))).toBe(true);
    expect(runner.writes.some((write) => write.path === "/etc/cron.d/pg-log-partitions")).toBe(true);
  });
});

describe("Backup engine provisioner", () => {
  test("emits the daemon env contract, unit, cron and target verification", () => {
    const cfg = config();
    const env = backupDaemonEnv(cfg);
    expect(archiveCommand(cfg)).toContain("barman-wal-archive");
    expect(archiveCommand(cfg, "audit_db")).toContain("pg_audit_db");
    expect(walGEnvironment(cfg).WALG_COMPRESSION_METHOD).toBe("zstd");
    expect(walGEnvironment(cfg).WALG_LIBSODIUM_KEY).toBe(cfg.BACKUP_ENCRYPTION_KEY_HEX);
    expect(walGEnvironment(cfg).WALG_S3_PREFIX).toBe("s3://payment-gateway-backups/prod/postgres_core");
    expect(walGEnvironment(cfg, "audit_db").WALG_S3_PREFIX).toBe("s3://payment-gateway-backups/prod/audit_db");
    expect(env.BACKUP_DAEMON_CERT_PATH).toBe("/var/lib/pg-backup/shared/certs/backup-daemon.crt");
    expect(env.BACKUP_DAEMON_KEY_PATH).toContain("backup-daemon.key");
    expect(env.BACKUP_DAEMON_CA_CERT_PATH).toContain("internal-ca.crt");
    expect(env.BACKUP_DAEMON_BIND_HOST).toBe("10.10.13.10");
    expect(env.BACKUP_CORE_S3_PREFIX).toContain("/postgres_core");
    expect(env.BACKUP_AUDIT_S3_PREFIX).toContain("/audit_db");
    expect(env.PG_PRIMARY_HOST).toBe("10.10.10.10");
    expect(env.PG_PRIMARY_PORT).toBe("5432");
    expect(env.PG_PRIMARY_DB_NAME).toBe("payment_gateway_prod");
    expect(env.PG_REPLICA_NODES).toContain("pg-rep-1@");
    expect(env.PG_DATA_DIR).toContain("/var/lib/postgresql/18/main");
    expect(env.BARMAN_SERVER).toBe("payment_gateway_prod");
    expect(env.BARMAN_AUDIT_SERVER).toBe("pg_audit_db");
    expect(env.BACKUP_CATALOG_PATH).toBe("/var/lib/pg-backup/catalog.json");
    expect(env.SCHEDULER_ENABLED).toBe("true");
    expect(env.BACKUP_ALERT_LAG_SECONDS).toBe("300");
    const unit = backupDaemonSystemdUnit(cfg);
    expect(unit).toContain("WorkingDirectory=/opt/pg-backup-daemon");
    expect(unit).toContain("ExecStart=/usr/local/bin/bun run src/index.ts");
    expect(unit).toContain("EnvironmentFile=/etc/pg-backup/backup.env");
    expect(unit).toContain("User=postgres");
    expect(unit).toContain("ReadWritePaths=/var/lib/pg-backup /var/log/pg-backup");
    expect(backupCronEntries(cfg)).toEqual([]);
    expect(backupCronFile(cfg)).toContain("scheduler");
    expect(verifyBackupTargetCommands(cfg).join("\n")).toContain("/minio/health/live");
    expect(verifyBackupTargetCommands(cfg).join("\n")).toContain("/dev/tcp/");
  });

  test("generates every daemon path, port, timeout and scheduler setting from deploy.env", () => {
    const source = `${SOURCE}
BACKUP_DAEMON_CERT_DIR="/srv/pg-backup/certs"
BACKUP_CATALOG_PATH="/srv/pg-backup/catalog.json"
BACKUP_PGPASSFILE="/srv/pg-backup/.pgpass"
BACKUP_SCRATCH_DIR="/srv/pg-backup/scratch"
BACKUP_SCRATCH_AUDIT_DIR="/srv/pg-backup/audit-scratch"
BACKUP_SCRATCH_PORT="55442"
BACKUP_SCRATCH_AUDIT_PORT="55443"
BACKUP_COMMAND_TIMEOUT_MS="900000"
BACKUP_ALLOW_INSECURE_HTTP="true"
BACKUP_SCHEDULER_TICK_MS="15000"
BACKUP_WALG_BIN="/opt/bin/wal-g"
BACKUP_BARMAN_BIN="/opt/bin/barman"
BACKUP_BARMAN_CLOUD_BIN="/opt/bin/barman-cloud-backup"
BACKUP_REDIS_CLI_BIN="/opt/bin/redis-cli"
`;
    const parsed = loadDeployConfig(source);
    expect(parsed.ok).toBe(true);
    const cfg = parsed.config!;
    const env = backupDaemonEnv(cfg);
    expect(env.BACKUP_DAEMON_CERT_PATH).toBe("/srv/pg-backup/certs/backup-daemon.crt");
    expect(env.BACKUP_CATALOG_PATH).toBe("/srv/pg-backup/catalog.json");
    expect(env.PGPASSFILE).toBe("/srv/pg-backup/.pgpass");
    expect(env.BACKUP_SCRATCH_DIR).toBe("/srv/pg-backup/scratch");
    expect(env.BACKUP_SCRATCH_AUDIT_DIR).toBe("/srv/pg-backup/audit-scratch");
    expect(env.BACKUP_SCRATCH_PORT).toBe("55442");
    expect(env.BACKUP_SCRATCH_AUDIT_PORT).toBe("55443");
    expect(env.BACKUP_COMMAND_TIMEOUT_MS).toBe("900000");
    expect(env.BACKUP_ALLOW_INSECURE_HTTP).toBe("true");
    expect(env.SCHEDULER_TICK_MS).toBe("15000");
    expect(env.WALG_BIN).toBe("/opt/bin/wal-g");
    expect(env.BARMAN_BIN).toBe("/opt/bin/barman");
    expect(env.BARMAN_CLOUD_BIN).toBe("/opt/bin/barman-cloud-backup");
    expect(env.REDIS_CLI_BIN).toBe("/opt/bin/redis-cli");
    const unit = backupDaemonSystemdUnit(cfg);
    for (const path of [
      "/srv/pg-backup",
      "/srv/pg-backup/scratch",
      "/srv/pg-backup/audit-scratch",
    ]) {
      expect(unit).toContain(path);
    }
  });

  test("uses per-target WAL-G prefixes when the engine mode is wal-g", () => {
    const source = SOURCE
      .replace('BACKUP_ENGINE_MODE="barman"', 'BACKUP_ENGINE_MODE="wal-g"\nBACKUP_WALG_SHA256="5d41402abc4b2a76b9719d911017c592a1b2c3d4e5f60718293a4b5c6d7e8f90"')
      .replace('BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"', 'BACKUP_NODE="backup-1@10.10.10.10:22:10.10.10.10:4090"');
    const cfg = loadDeployConfig(source);
    expect(cfg.ok).toBe(true);
    expect(archiveCommand(cfg.config!)).toContain("wal-g wal-push %p");
    expect(archiveCommand(cfg.config!)).toContain("postgres_core");
    expect(archiveCommand(cfg.config!, "audit_db")).toContain("audit_db");
    expect(archiveCommandSql(cfg.config!, "audit_db")).toContain("audit_db");
  });

  test("rejects WAL-G when the backup node does not share the primary data directories", () => {
    const cfg = loadDeployConfig(SOURCE.replace('BACKUP_ENGINE_MODE="barman"', 'BACKUP_ENGINE_MODE="wal-g"'));
    expect(cfg.ok).toBe(false);
    expect(cfg.problems.join(" ")).toContain("BACKUP_NODE private IP must equal PG_PRIMARY_NODE private IP");
  });

  test("writes daemon env, unit, trigger, cron, restore verifier and archive command", () => {
    const runner = new FakeRunner();
    const report = provisionBackupEngine({ runner, config: config(), dryRun: true });
    expect(report.nodes).toEqual(["10.10.13.10"]);
    expect(report.daemon?.installDir).toBe("/opt/pg-backup-daemon");
    expect(runner.writes.some((write) => write.path === "/etc/pg-backup/backup.env")).toBe(true);
    expect(runner.writes.some((write) => write.path === "/etc/systemd/system/pg-backup-daemon.service")).toBe(true);
    expect(runner.writes.some((write) => write.path === "/etc/cron.d/pg-backup")).toBe(true);
    expect(runner.writes.some((write) => write.path === "/usr/local/bin/pg-backup-daemon-trigger")).toBe(true);
    expect(runner.writes.some((write) => write.path === "/usr/local/bin/pg-backup-restore-drill")).toBe(true);
    expect(runner.writes.some((write) => write.path === "/etc/cron.d/pg-journal-partitions")).toBe(true);
    expect(runner.writes.some((write) => write.content.includes("ensure_journal_line_partitions(18)"))).toBe(true);
    expect(
      runner.writes.some(
        (write) =>
          write.content.includes("archive_mode = 'off'") &&
          write.content.includes("pg_create_physical_replication_slot('barman')"),
      ),
    ).toBe(true);
    expect(runner.writes.some((write) => write.content.includes("wal-g-audit.env") || write.content.includes("pg_audit_db"))).toBe(true);
    expect(runner.runs.some((run) => run.command.includes("/minio/health/live"))).toBe(true);
    expect(backupDaemonTriggerScript(config())).toContain("/v1/backups/trigger");
    expect(backupDaemonTriggerScript(config())).toContain("--cert");
    expect(journalLinePartitionCronLine(config())).toContain("ensure_journal_line_partitions(18)");
  });
});
