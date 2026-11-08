import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupS3Configured, loadDeployConfig, type DeployConfig } from "../lib/configSchema";
import { backupCoreEnv, planHosts, type SshTarget } from "../lib/hostPlanner";
import { buildPki, certFilesForHost, verifyPki, WAL_ARCHIVE_CLIENT } from "../lib/pkiManager";
import type { ProvisionRunner } from "../provisioners/postgres18Provisioner";
import {
  archiveCommand,
  archiveCommandSql,
  backupDaemonEnv,
  backupDaemonSystemdUnit,
  backupDaemonUser,
  barmanStreamingSql,
  ensureObjectStore,
  isBackupColocatedWithPrimary,
  provisionBackupEngine,
  restoreCommand,
  scratchRestoreVerifierScript,
  verifyBackupTargetCommands,
} from "../provisioners/backupEngineProvisioner";
import { bunInstallCommand, daemonReadinessWait } from "../deploy";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";

const COMMON = `
DEPLOY_ENV="test"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000"
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
BACKUP_ENABLED="true"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_ENCRYPTION_KEY_HEX="9f3a7c1e5b2d84f06a1c3e7b9d2f4a8c5e0b6d1a3f7c9e2b4d8a0c6e1f5b3a79"
`;

/** Externally managed database (DB_*): no PG_* storage nodes at all. */
const DB_MODE = `${COMMON}
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.10.10:5432/gateway"
DB_ENGINE="postgresql"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_ENGINE_MODE="pg-native"
`;

/** deploy-managed cluster: primary + dedicated audit/log DBs + a remote backup node. */
const PG_MODE = `${COMMON}
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.10.10:5432/gateway"
DB_ENGINE="postgresql"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PG_REPLICATION_PASSWORD="ultra-strong-repl-K7p2Zq9w"
PGBOUNCER_ENABLED="true"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_KEY_PATH="~/.ssh/redis"
REDIS_PASSWORD="ultra-strong-redis-K7p2Zq9w"
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@10.10.12.10:22:10.10.12.10:5434"
AUDIT_DB_SSH_KEY_PATH="~/.ssh/audit"
AUDIT_DB_PASSWORD="ultra-strong-audit-K7p2Zq9w"
LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@10.10.12.20:22:10.10.12.20:5435"
LOG_DB_SSH_KEY_PATH="~/.ssh/log"
LOG_DB_PASSWORD="ultra-strong-log-K7p2Zq9w"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.example.invalid"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
`;

const load = (source: string): DeployConfig => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

const pgNative = () => load(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"`);
/** pg-native, everything on one machine (backup node shares the primary's private IP). */
const colocated = () => load(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"`.replace('BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"', 'BACKUP_NODE="backup-1@10.10.10.10:22:10.10.10.10:4090"'));

class FakeRunner implements ProvisionRunner {
  readonly dryRun = true;
  readonly runs: Array<{ target: SshTarget; command: string }> = [];
  readonly captures: Array<{ target: SshTarget; command: string }> = [];
  readonly writes: Array<{ target: SshTarget; path: string; content: string }> = [];
  run(target: SshTarget, command: string): void {
    this.runs.push({ target, command });
  }
  capture(target: SshTarget, command: string): string {
    this.captures.push({ target, command });
    return "";
  }
  writeRemoteFile(input: { target: SshTarget; path: string; content: string | Buffer }): void {
    this.writes.push({ target: input.target, path: input.path, content: input.content.toString() });
  }
}

describe("backupCoreEnv (core-back -> backup daemon)", () => {
  test("reaches core's .env in DB_* mode where no PG storage env exists", () => {
    const config = load(DB_MODE);
    const plan = planHosts(config);
    const core = plan.hosts.flatMap((host) => host.services).find((service) => service.role === "core")!;
    expect(core.env.PG_PRIMARY_HOST).toBeUndefined();
    expect(core.env.BACKUP_DAEMON_URL).toBe("https://10.10.13.10:4090");
    expect(core.env.BACKUP_DAEMON_CA_CERT_PATH).toBe("shared/certs/internal-ca.crt");
    expect(core.env.BACKUP_DAEMON_CLIENT_CERT_PATH).toBe("shared/certs/backup-client.crt");
    expect(core.env.BACKUP_DAEMON_CLIENT_KEY_PATH).toBe("shared/certs/backup-client.key");
    expect(core.env.BACKUP_DAEMON_TIMEOUT_MS).toBe("15000");
  });

  test("is empty when backups are off, http only when explicitly allowed, loopback without a node", () => {
    expect(backupCoreEnv({ ...load(DB_MODE), BACKUP_ENABLED: false })).toEqual({});
    expect(backupCoreEnv({ ...load(DB_MODE), BACKUP_ALLOW_INSECURE_HTTP: true }).BACKUP_DAEMON_URL).toBe("http://10.10.13.10:4090");
    expect(backupCoreEnv({ ...load(DB_MODE), BACKUP_NODE: "" }).BACKUP_DAEMON_URL).toBe("https://127.0.0.1:4090");
  });

  test("backup-client certificate is planned for core hosts in DB_* mode; wal-archive-client is not", () => {
    const plan = planHosts(load(DB_MODE));
    const core = plan.hosts.find((host) => host.roles.includes("core"))!;
    expect(core.certs).toContain("backup-client");
    expect(core.certs).not.toContain("wal-archive-client");
    const bundle = buildPki({ config: load(DB_MODE), dryRun: true, directory: "/tmp/pg-pki-backup-dbmode" });
    expect(certFilesForHost(bundle, ["core"]).map((file) => file.name)).toContain("backup-client");
  });
});

describe("wal-archive-client least-privilege certificate", () => {
  const directories: string[] = [];
  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  test("is generated for backup deployments and distributed only to pg-primary / audit-db hosts", () => {
    const bundle = buildPki({ config: pgNative(), dryRun: true, directory: "/tmp/pg-pki-wal-dist" });
    const names = (roles: Parameters<typeof certFilesForHost>[1]) => certFilesForHost(bundle, roles).map((file) => file.name);
    expect(names(["pg-primary"])).toContain(WAL_ARCHIVE_CLIENT);
    expect(names(["audit-db"])).toContain(WAL_ARCHIVE_CLIENT);
    for (const role of ["core", "backup", "pgbouncer", "pg-replica", "redis", "log-db", "admin", "merchant", "checkout"] as const) {
      expect(names([role])).not.toContain(WAL_ARCHIVE_CLIENT);
    }
    expect(names(["pg-primary"])).toContain("pg-client");
  });

  test("is not generated when backups are not configured", () => {
    const config = { ...pgNative(), BACKUP_ENABLED: false, BACKUP_NODE: "" };
    const bundle = buildPki({ config, dryRun: true, directory: "/tmp/pg-pki-wal-off" });
    expect(bundle.storageClients.map((client) => client.name)).not.toContain(WAL_ARCHIVE_CLIENT);
  });

  test("host plan lists the bundle only for the PostgreSQL hosts and verifyPki checks it (CN wal-archive-client)", () => {
    const config = pgNative();
    const plan = planHosts(config);
    for (const host of plan.hosts) {
      const holdsIt = host.certs.includes("wal-archive-client");
      expect(holdsIt).toBe(host.roles.includes("pg-primary") || host.roles.includes("audit-db"));
    }
    const directory = mkdtempSync(join(tmpdir(), "pg-pki-wal-real-"));
    directories.push(directory);
    const bundle = buildPki({ config, directory });
    const wal = verifyPki(bundle).find((entry) => entry.name === WAL_ARCHIVE_CLIENT);
    expect(wal).toBeDefined();
    expect(wal!.subject).toContain("CN=wal-archive-client");
    expect(wal!.valid).toBe(true);
  });

  test("adding the new client to an existing PKI keeps the CA and every other client certificate untouched", () => {
    const directory = mkdtempSync(join(tmpdir(), "pg-pki-wal-upgrade-"));
    directories.push(directory);
    const config = pgNative();
    const first = buildPki({ config, directory });
    // Server leaves are always re-signed when a file is missing (pre-existing behaviour); clients and the CA are not.
    const keep = (entry: { name: string }) => entry.name === "internal-ca" || entry.name.endsWith("-client");
    const before = verifyPki(first).filter(keep).map((entry) => `${entry.name}:${entry.notBefore}`);
    rmSync(join(directory, `${WAL_ARCHIVE_CLIENT}.crt`));
    rmSync(join(directory, `${WAL_ARCHIVE_CLIENT}.key`));
    const second = buildPki({ config, directory });
    const after = verifyPki(second).filter(keep).map((entry) => `${entry.name}:${entry.notBefore}`);
    expect(after.filter((entry) => !entry.startsWith(WAL_ARCHIVE_CLIENT))).toEqual(before.filter((entry) => !entry.startsWith(WAL_ARCHIVE_CLIENT)));
    expect(after.some((entry) => entry.startsWith(WAL_ARCHIVE_CLIENT))).toBe(true);
  });
});

describe("backup daemon account and unit", () => {
  const node = (backupIp: string, primaryIp?: string, dbSshHost?: string) => ({
    BACKUP_NODE: `b@${backupIp}:22:${backupIp}:4090`,
    PG_PRIMARY_NODE: primaryIp ? `p@${primaryIp}:22:${primaryIp}:5432` : "",
    DB_SSH_HOST: dbSshHost,
  });

  test("runs as postgres only for a wal-g daemon co-located with the primary", () => {
    expect(backupDaemonUser({ ...node("10.0.0.5", "10.0.0.5"), BACKUP_ENGINE_MODE: "wal-g" })).toBe("postgres");
    expect(backupDaemonUser({ ...node("10.0.0.9", "10.0.0.5"), BACKUP_ENGINE_MODE: "wal-g" })).toBe("pgbackup");
    expect(backupDaemonUser({ ...node("10.0.0.5", "10.0.0.5"), BACKUP_ENGINE_MODE: "barman" })).toBe("pgbackup");
    expect(backupDaemonUser({ ...node("10.0.0.5", "10.0.0.5"), BACKUP_ENGINE_MODE: "pg-native" })).toBe("pgbackup");
    expect(backupDaemonUser({ ...node("10.0.0.9", "10.0.0.5"), BACKUP_ENGINE_MODE: "pg-native" })).toBe("pgbackup");
  });

  test("co-location falls back to DB_SSH_HOST when there is no PG_PRIMARY_NODE", () => {
    expect(isBackupColocatedWithPrimary(node("10.0.0.5", undefined, "10.0.0.5"))).toBe(true);
    expect(isBackupColocatedWithPrimary(node("10.0.0.5", undefined, "10.0.0.6"))).toBe(false);
    expect(isBackupColocatedWithPrimary(node("10.0.0.5"))).toBe(false);
  });

  test("the unit has no SupplementaryGroups, sets HOME and the bun cache, and can write the local repo", () => {
    const unit = backupDaemonSystemdUnit(pgNative());
    expect(unit).not.toContain("SupplementaryGroups");
    expect(unit).toContain("User=pgbackup");
    expect(unit).toContain("Environment=HOME=/var/lib/pg-backup");
    expect(unit).toContain("Environment=BUN_INSTALL_CACHE_DIR=/var/lib/pg-backup/.bun-cache");
    expect(unit).toMatch(/ReadWritePaths=[^\n]*\/var\/lib\/pg-backup\/repo/);
  });

  test("a custom BACKUP_LOCAL_REPO_DIR is writable and created for pg-native", () => {
    const config = load(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"\nBACKUP_LOCAL_REPO_DIR="/srv/backup-repo"`);
    expect(backupDaemonSystemdUnit(config)).toMatch(/ReadWritePaths=[^\n]*\/srv\/backup-repo/);
    const runner = new FakeRunner();
    provisionBackupEngine({ runner, config });
    expect(runner.runs.some((run) => run.command.includes("'/srv/backup-repo'"))).toBe(true);
  });
});

describe("pg-native engine", () => {
  test("archive_command pushes WAL over mTLS with the least-privilege client", () => {
    const config = pgNative();
    expect(archiveCommand(config)).toBe(
      "curl --fail --silent --show-error --max-time 120 --cacert /etc/pg-deploy/certs/internal-ca.crt --cert /etc/pg-deploy/certs/wal-archive-client.crt --key /etc/pg-deploy/certs/wal-archive-client.key --upload-file %p https://10.10.13.10:4090/v1/wal/postgres_core/%f",
    );
    expect(archiveCommand(config, "audit_db")).toContain("https://10.10.13.10:4090/v1/wal/audit_db/%f");
    expect(archiveCommand(config)).not.toContain("backup-client.");
    expect(restoreCommand(config)).toContain("/v1/wal/postgres_core/%f");
  });

  test("with BACKUP_ALLOW_INSECURE_HTTP the WAL commands use plain http and no client certificate, like the daemon listener", () => {
    const config = load(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"\nBACKUP_ALLOW_INSECURE_HTTP="true"`);
    const archive = archiveCommand(config);
    expect(archive).toContain("--upload-file %p http://10.10.13.10:4090/v1/wal/postgres_core/%f");
    expect(archive).not.toContain("https://");
    expect(archive).not.toContain("--cert");
    const restore = restoreCommand(config);
    expect(restore).toContain("--output %p http://10.10.13.10:4090/v1/wal/postgres_core/%f");
    expect(restore).not.toContain("--cacert");
  });

  test("cluster SQL sets the pg-native settings, never lowers sender/slot limits, creates the replication role", () => {
    const sql = archiveCommandSql(pgNative());
    for (const expected of [
      "ALTER SYSTEM SET wal_level = 'replica';",
      "ALTER SYSTEM SET archive_mode = 'on';",
      "ALTER SYSTEM SET archive_timeout = '60s';",
      "ALTER SYSTEM SET summarize_wal = 'on';",
      "/v1/wal/postgres_core/%f",
      "WHERE current_setting('max_wal_senders')::int < 4",
      "WHERE current_setting('max_replication_slots')::int < 4",
      "CREATE ROLE \"gw_replicator\" WITH REPLICATION LOGIN",
    ]) {
      expect(sql).toContain(expected);
    }
    expect(sql).not.toContain("wal-g");
    expect(sql).not.toContain("barman-wal");
  });

  test("provisioning applies it to the primary and the DEDICATED audit cluster, with client-cert checks", () => {
    const runner = new FakeRunner();
    const report = provisionBackupEngine({ runner, config: pgNative() });
    const archiveSql = runner.writes.filter((write) => write.path.endsWith("/archive.sql"));
    expect(archiveSql).toHaveLength(2);
    expect(archiveSql[0]!.content).toContain("/v1/wal/postgres_core/%f");
    expect(archiveSql[1]!.content).toContain("/v1/wal/audit_db/%f");
    // no S3/WAL-G env files, no barman config for pg-native
    expect(runner.writes.map((write) => write.path)).not.toContain("/etc/pg-backup/wal-g-core.env");
    expect(runner.writes.map((write) => write.path)).not.toContain("/etc/barman.conf");
    // the WAL client key must be readable by postgres or the deploy fails loudly
    expect(runner.runs.filter((run) => run.command.includes("wal-archive-client.key")).length).toBe(2);
    expect(runner.runs.some((run) => run.command.includes("runuser -u postgres -- test -r"))).toBe(true);
    // PostgreSQL is only restarted by the shared pending_restart logic
    expect(report.outcomes).toBeDefined();
    const env = runner.writes.find((write) => write.path === "/etc/pg-backup/backup.env")!.content;
    expect(env).toContain("BACKUP_ENGINE_MODE='pg-native'");
  });

  test("a dedicated backup host gets PostgreSQL 18 client+server binaries and the default cluster is disabled", () => {
    const runner = new FakeRunner();
    provisionBackupEngine({ runner, config: pgNative() });
    const backupRuns = runner.runs.filter((run) => run.target.host === "10.10.13.10").map((run) => run.command);
    const packages = backupRuns.find((command) => command.includes("dpkg-query"))!;
    for (const pkg of ["postgresql-18", "postgresql-client-18", "curl"]) expect(packages).toContain(`'${pkg}'`);
    expect(packages).not.toContain("'barman'");
    expect(backupRuns.some((command) => command.includes("systemctl disable --now postgresql") && command.includes("systemctl mask postgresql"))).toBe(true);
    expect(backupRuns).toContain("getent group postgres >/dev/null 2>&1 && usermod -aG postgres pgbackup || true");
    expect(backupRuns).toContain("usermod -aG pgbackup postgres 2>/dev/null || true");
  });

  test("the default cluster is NOT disabled when the backup node is also a PostgreSQL host", () => {
    const runner = new FakeRunner();
    provisionBackupEngine({ runner, config: colocated() });
    expect(runner.runs.some((run) => run.command.includes("systemctl mask postgresql"))).toBe(false);
  });

  test("the cron drill fallback asks the daemon for EVERY engine, never restoring by itself", () => {
    for (const mode of ["pg-native", "wal-g", "barman"]) {
      const script = scratchRestoreVerifierScript({ ...pgNative(), BACKUP_ENGINE_MODE: mode as DeployConfig["BACKUP_ENGINE_MODE"] });
      expect(script).toContain("/v1/drills/run");
      expect(script).toContain("--cert");
      for (const forbidden of ["wal-g", "barman recover", "rm -rf", "pg_ctl", "runuser"]) expect(script).not.toContain(forbidden);
    }
  });
});

describe("pg-native without an S3 object store (air-gapped, local repo only)", () => {
  const airGapped = () => load(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"\nBACKUP_PRIMARY_S3_ENDPOINT=""\nBACKUP_PRIMARY_S3_BUCKET=""`);

  test("validates without endpoint, bucket or S3 mode, while barman and wal-g still require them", () => {
    expect(airGapped().BACKUP_PRIMARY_S3_ENDPOINT).toBe("");
    expect(backupS3Configured(airGapped())).toBe(false);
    for (const mode of ["barman"]) {
      const result = loadDeployConfig(`${PG_MODE}\nBACKUP_ENGINE_MODE="${mode}"\nBACKUP_PRIMARY_S3_ENDPOINT=""\nBACKUP_PRIMARY_S3_BUCKET=""`);
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toContain("BACKUP_PRIMARY_S3_BUCKET is required");
    }
    expect(backupS3Configured(pgNative())).toBe(true);
  });

  test("a bucket without an endpoint is rejected", () => {
    const result = loadDeployConfig(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"\nBACKUP_PRIMARY_S3_ENDPOINT=""`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("BACKUP_PRIMARY_S3_BUCKET requires BACKUP_PRIMARY_S3_ENDPOINT");
  });

  test("no S3 commands, no MinIO and no S3 prefixes are produced", () => {
    const config = airGapped();
    const runner = new FakeRunner();
    expect(ensureObjectStore({ runner, config, ssh: { host: "h", port: 22, user: "u", keyPath: "", sudoPassword: "" } })).toEqual([]);
    expect(runner.runs).toEqual([]);
    const verify = verifyBackupTargetCommands(config).join("\n");
    expect(verify).not.toContain("s3");
    expect(verify).not.toContain("curl");
    const env = backupDaemonEnv(config);
    expect(env.BACKUP_PRIMARY_S3_ENDPOINT).toBe("");
    expect(env.BACKUP_PRIMARY_S3_BUCKET).toBe("");
    expect(env.BACKUP_CORE_S3_PREFIX).toBe("");
    expect(env.BACKUP_AUDIT_S3_PREFIX).toBe("");
    expect(env.BACKUP_LOCAL_REPO_DIR).toBe("/var/lib/pg-backup/repo");
    const provisioning = new FakeRunner();
    provisionBackupEngine({ runner: provisioning, config });
    expect(provisioning.runs.some((run) => /minio|s3|bucket/i.test(run.command))).toBe(false);
  });
});

describe("daemon env contract", () => {
  test("emits the audit, replication, TLS and WAL-client keys", () => {
    const env = backupDaemonEnv(pgNative());
    expect(env.BACKUP_ENGINE_MODE).toBe("pg-native");
    expect(env.PG_AUDIT_HOST).toBe("10.10.12.10");
    expect(env.PG_AUDIT_PORT).toBe("5434");
    expect(env.PG_AUDIT_USER).toBe("gw_audit_writer");
    expect(env.PG_AUDIT_PASSWORD).toBe("ultra-strong-audit-K7p2Zq9w");
    expect(env.PG_REPLICATION_USER).toBe("gw_replicator");
    expect(env.PG_REPLICATION_PASSWORD).toBe("ultra-strong-repl-K7p2Zq9w");
    expect(env.PG_REPLICATION_SLOT).toBe("pg_backup_core");
    expect(env.PG_SSLMODE).toBe("require");
    expect(env.PG_LOG_DB_NAME).toBe("pg_logs_db");
    expect(env.BACKUP_WAL_CLIENT_CNS).toBe("wal-archive-client");
    expect(env.BACKUP_ALLOWED_CLIENT_CNS).toBe("backup-client");
  });

  test("PG_AUDIT_HOST is empty when audit shares the core cluster, PG_LOG_DB_NAME when there is no log DB", () => {
    const shared = load(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"\nAUDIT_DB_NODE="audit-db@10.10.10.10:22:10.10.10.10:5432"\nLOG_DB_NODE=""\nLOG_DB_MANAGE_VIA_SSH="false"`);
    const env = backupDaemonEnv(shared);
    expect(env.PG_AUDIT_HOST).toBe("");
    expect(env.PG_LOG_DB_NAME).toBe("");
  });

  test("non-pg-native modes do not emit a local repo", () => {
    expect(backupDaemonEnv(load(`${PG_MODE}\nBACKUP_ENGINE_MODE="barman"`)).BACKUP_LOCAL_REPO_DIR).toBeUndefined();
  });

  test("barman: the audit cluster creates barman_audit on itself; a shared cluster creates both", () => {
    const dedicated = load(`${PG_MODE}\nBACKUP_ENGINE_MODE="barman"`);
    expect(barmanStreamingSql(dedicated, "postgres_core")).toContain("slot_name = 'barman'");
    expect(barmanStreamingSql(dedicated, "postgres_core")).not.toContain("barman_audit");
    expect(barmanStreamingSql(dedicated, "audit_db")).toContain("slot_name = 'barman_audit'");
    const shared = load(`${PG_MODE}\nBACKUP_ENGINE_MODE="barman"\nAUDIT_DB_NODE="audit-db@10.10.10.10:22:10.10.10.10:5432"`);
    expect(barmanStreamingSql(shared, "postgres_core")).toContain("slot_name = 'barman_audit'");
    expect(barmanStreamingSql()).toContain("slot_name = 'barman'");
  });
});

describe("deploy.ts daemon readiness wait", () => {
  test("polls is-active for ~10 s and dumps the journal to stderr on failure", () => {
    const script = daemonReadinessWait();
    expect(script).toContain("seq 1 10");
    expect(script).toContain("systemctl is-active --quiet pg-backup-daemon");
    expect(script).toContain("journalctl -u pg-backup-daemon -n 40 --no-pager >&2");
    expect(script).toContain("exit 1");
  });
});

describe("audit/log role names (PostgreSQL reserves the pg_ prefix)", () => {
  test("defaults are creatable role names, and any pg_-prefixed name is rejected at config load", () => {
    const config = pgNative();
    expect(config.AUDIT_DB_USER).toBe("gw_audit_writer");
    expect(config.LOG_DB_USER).toBe("gw_log_writer");
    expect(config.PG_DB_USER).toBe("gw_core_user");
    expect(config.PG_REPLICATION_USER).toBe("gw_replicator");
    for (const line of ['AUDIT_DB_USER="pg_audit_writer"', 'LOG_DB_USER="PG_log"', 'PG_DB_USER="pg_core_user"', 'PG_REPLICATION_USER="pg_replicator"', 'DB_USER="pg_app"']) {
      const bad = loadDeployConfig(`${PG_MODE}\nBACKUP_ENGINE_MODE="pg-native"\n${line}`);
      expect(bad.ok).toBe(false);
      expect(bad.problems.join(" ")).toContain("pg_");
    }
  });
});

describe("bun install for the service user (found by the two-host lab)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const directory of dirs) rmSync(directory, { recursive: true, force: true });
  });
  const sandbox = (): { dir: string; run: (extraPath?: string) => { status: number | null; stderr: string } } => {
    const dir = mkdtempSync(join(tmpdir(), "bun-install-"));
    dirs.push(dir);
    mkdirSync(join(dir, "usr-local-bin"), { recursive: true });
    const command = bunInstallCommand({ BUN_VERSION: "1.3.5", BUN_SHA256: "" }).split("/usr/local/bin").join(join(dir, "usr-local-bin"));
    return {
      dir,
      run: (extraPath = "") => {
        const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, HOME: join(dir, "home"), PATH: `${extraPath}${extraPath ? ":" : ""}/usr/bin:/bin` } });
        return { status: result.status, stderr: result.stderr };
      },
    };
  };
  const fakeBun = (dir: string): string => {
    mkdirSync(join(dir, "home", ".bun", "bin"), { recursive: true });
    const path = join(dir, "home", ".bun", "bin", "bun");
    writeFileSync(path, "#!/bin/sh\necho fake-bun\n");
    chmodSync(path, 0o755);
    return path;
  };

  test("an existing symlink into a home directory is replaced by a REAL file (a service user cannot traverse /home/<user>)", () => {
    const { dir, run } = sandbox();
    const target = fakeBun(dir);
    symlinkSync(target, join(dir, "usr-local-bin", "bun"));
    expect(lstatSync(join(dir, "usr-local-bin", "bun")).isSymbolicLink()).toBe(true);
    expect(run().status).toBe(0);
    const installed = join(dir, "usr-local-bin", "bun");
    expect(lstatSync(installed).isSymbolicLink()).toBe(false);
    expect(lstatSync(installed).isFile()).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(target, "utf8"));
    expect(lstatSync(installed).mode & 0o111).not.toBe(0);
    expect(run().status).toBe(0); // idempotent
    expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  });

  test("a bun found only on PATH (per-user install) is copied, not symlinked", () => {
    const { dir, run } = sandbox();
    const target = fakeBun(dir);
    expect(run(join(dir, "home", ".bun", "bin")).status).toBe(0);
    const installed = join(dir, "usr-local-bin", "bun");
    expect(lstatSync(installed).isSymbolicLink()).toBe(false);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(target, "utf8"));
    expect(readlinkSync(join(dir, "usr-local-bin", "bunx"))).toBe("bun"); // bunx stays a relative link beside it
  });

  test("a dangling symlink is replaced when a bun exists on PATH, and with no bun anywhere the command fails closed", () => {
    const { dir, run } = sandbox();
    symlinkSync("/nonexistent/bun", join(dir, "usr-local-bin", "bun"));
    const target = fakeBun(dir);
    expect(run(join(dir, "home", ".bun", "bin")).status).toBe(0);
    expect(lstatSync(join(dir, "usr-local-bin", "bun")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "usr-local-bin", "bun"), "utf8")).toBe(readFileSync(target, "utf8"));

    // A PATH holding only the tools the command needs (no bun anywhere), a dangling link, and no ~/.bun.
    const empty = sandbox();
    const tools = join(empty.dir, "tools");
    mkdirSync(tools);
    for (const tool of ["install", "mv", "rm", "readlink", "ln", "mktemp", "curl"]) {
      const found = spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(tools, tool));
    }
    symlinkSync("/nonexistent/bun", join(empty.dir, "usr-local-bin", "bun"));
    const command = bunInstallCommand({ BUN_VERSION: "1.3.5", BUN_SHA256: "" }).split("/usr/local/bin").join(join(empty.dir, "usr-local-bin"));
    const result = spawnSync(spawnSync("which", ["bash"], { encoding: "utf8" }).stdout.trim(), ["-c", command], { encoding: "utf8", env: { HOME: join(empty.dir, "home"), PATH: tools } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bun is not installed");
  });
});
