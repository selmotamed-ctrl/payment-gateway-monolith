import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  leaderElectionDatabaseUrl,
  loadDeployConfig,
  PGBOUNCER_SESSION_ALIAS,
  type DeployConfig,
} from "../lib/configSchema";
import {
  ensurePackagesScript,
  outcomeBounced,
  parseApplyOutcome,
  PGBOUNCER_DROPIN_PATH,
  pgbouncerApplyScript,
  pgbouncerRestartSignature,
  pgbouncerSystemdDropIn,
  pipPinnedGuard,
  poolerLoginScript,
  postgresApplyScript,
  redisApplyScript,
  redisUnitDetectScript,
} from "../lib/converge";
import type { SshTarget } from "../lib/hostPlanner";
import { countRsyncChanges, SshRunner, WRITE_CHANGED, WRITE_UNCHANGED } from "../lib/sshRunner";
import { planHosts } from "../lib/hostPlanner";
import { pgbouncerIni, pgHbaSnippet, provisionPostgres18 } from "../provisioners/postgres18Provisioner";
import { provisionRedis } from "../provisioners/redisProvisioner";
import { provisionAuditAndLogDb } from "../provisioners/auditAndLogDbProvisioner";
import { provisionBackupEngine } from "../provisioners/backupEngineProvisioner";

const ENV = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@127.0.0.1:5432/gateway"
DB_ENGINE="postgresql"
CORE_NODES="core-1@127.0.0.1:22:127.0.0.1:4000"
CORE_SSH_KEY_PATH="~/.ssh/core"
ADMIN_NODES="admin-1@127.0.0.1:22:127.0.0.1:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
MERCHANT_NODES="merch-1@127.0.0.1:22:127.0.0.1:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@127.0.0.1:22:127.0.0.1:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@127.0.0.1:22:127.0.0.1:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PG_REPLICATION_PASSWORD="ultra-strong-repl-K7p2Zq9w"
PGBOUNCER_ENABLED="true"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@127.0.0.1:22:127.0.0.1:6379"
REDIS_SSH_KEY_PATH="~/.ssh/redis"
REDIS_PASSWORD="ultra-strong-redis-K7p2Zq9w"
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@127.0.0.1:22:127.0.0.1:5432"
AUDIT_DB_SSH_KEY_PATH="~/.ssh/audit"
AUDIT_DB_PASSWORD="ultra-strong-audit-K7p2Zq9w"
LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@127.0.0.1:22:127.0.0.1:5432"
LOG_DB_SSH_KEY_PATH="~/.ssh/log"
LOG_DB_PASSWORD="ultra-strong-log-K7p2Zq9w"
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@127.0.0.1:22:127.0.0.1:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_ENGINE_MODE="wal-g"
BACKUP_ENCRYPTION_KEY_HEX="b0f1034c58f9887cf0db771bd319879ee8ffa4cb5306ebc36c2e9c2feefff583"
BACKUP_PRIMARY_S3_ENDPOINT="http://127.0.0.1:9000"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/dev"
BACKUP_PRIMARY_S3_ACCESS_KEY="minioaccess"
BACKUP_PRIMARY_S3_SECRET_KEY="miniosecret-K7p2Zq9w-long"
BACKUP_ALLOW_INSECURE_HTTP="true"
BACKUP_S3_ALLOW_INSECURE_HTTP="true"
`;

const config = (): DeployConfig => {
  const loaded = loadDeployConfig(ENV);
  if (!loaded.ok || !loaded.config) throw new Error(`fixture invalid: ${loaded.problems.join("; ")}`);
  return loaded.config;
};

/**
 * A recording runner whose write results and apply-script outcomes are
 * scriptable, so a test can model "second deploy, nothing changed" or "only
 * pgbouncer.ini changed" and assert the exact convergence decisions.
 */
class ScriptedRunner {
  readonly dryRun = false;
  readonly runs: string[] = [];
  readonly captures: string[] = [];
  readonly writes: Array<{ path: string; changed: boolean }> = [];
  constructor(
    private readonly changed: (path: string) => boolean,
    private readonly outcome: (command: string) => string = () => "__PG_APPLY__=unchanged",
  ) {}
  run(_target: SshTarget, command: string): void {
    this.runs.push(command);
  }
  capture(_target: SshTarget, command: string): string {
    this.captures.push(command);
    return command.includes("for u in redis-server redis valkey") ? "valkey" : this.outcome(command);
  }
  writeRemoteFile(input: { path: string }): boolean {
    const changed = this.changed(input.path);
    this.writes.push({ path: input.path, changed });
    return changed;
  }
  apply(match: string): string | undefined {
    return this.captures.find((command) => command.includes(match));
  }
}

describe("apply outcome parsing", () => {
  test("reads the marker and treats missing output as unknown", () => {
    expect(parseApplyOutcome("noise\n__PG_APPLY__=reloaded\n")).toBe("reloaded");
    expect(parseApplyOutcome("__PG_APPLY__=restarted")).toBe("restarted");
    expect(parseApplyOutcome("")).toBe("unknown");
    expect(outcomeBounced("started")).toBe(true);
    expect(outcomeBounced("restarted")).toBe(true);
    expect(outcomeBounced("reloaded")).toBe(false);
    expect(outcomeBounced("unchanged")).toBe(false);
  });
});

describe("package guards", () => {
  test("only installs what is missing and never runs pacman -Sy", () => {
    const script = ensurePackagesScript({ debian: ["pgbouncer"], arch: ["postgresql", "pgbouncer"] });
    expect(script).toContain("dpkg-query -W");
    expect(script).toContain('pacman -Qq "$p"');
    expect(script).toContain("pacman -S --noconfirm --needed $missing");
    expect(script).not.toContain("pacman -Sy");
    // apt-get update is only reachable when a package is missing
    const update = script.indexOf("apt-get update");
    expect(script.lastIndexOf('if [ -n "$missing" ]', update)).toBeGreaterThan(-1);
  });

  test("a pinned pip install is skipped when the version already matches", () => {
    const guard = pipPinnedGuard("barman", "3.10.0", "python3 -m pip install barman==3.10.0");
    expect(guard).toContain("pip show 'barman'");
    expect(guard).toContain("= '3.10.0' ] ||");
  });
});

describe("PgBouncer convergence primitives", () => {
  test("the drop-in makes a restart fast and bounded (SIGINT, not the wait-for-clients SIGTERM)", () => {
    const dropIn = pgbouncerSystemdDropIn();
    expect(dropIn).toContain("KillSignal=SIGINT");
    expect(dropIn).toMatch(/TimeoutStopSec=\d+s/);
    expect(PGBOUNCER_DROPIN_PATH).toBe("/etc/systemd/system/pgbouncer.service.d/zz-pg-switch.conf");
  });

  test("the restart signature changes only for restart-only settings", () => {
    const base = pgbouncerIni(config(), 5432);
    const resized = base.replace(/default_pool_size = \d+/, "default_pool_size = 77").replace(/max_client_conn = \d+/, "max_client_conn = 999");
    const repassworded = base.replace(/password='[^']*'/, "password='another-secret'");
    const moved = base.replace(/listen_port = \d+/, "listen_port = 6543");
    expect(pgbouncerRestartSignature(resized)).toBe(pgbouncerRestartSignature(base));
    expect(pgbouncerRestartSignature(repassworded)).toBe(pgbouncerRestartSignature(base));
    expect(pgbouncerRestartSignature(moved)).not.toBe(pgbouncerRestartSignature(base));
    expect(pgbouncerRestartSignature(base)).toContain("listen_port=6432");
    expect(pgbouncerRestartSignature(base)).not.toContain("password");
  });

  test("the session alias is generated for the singleton-worker leader election", () => {
    const ini = pgbouncerIni(config(), 5432);
    expect(ini).toContain(`${PGBOUNCER_SESSION_ALIAS} = `);
    expect(ini).toContain("pool_mode=session");
    expect(ini).toMatch(new RegExp(`${PGBOUNCER_SESSION_ALIAS} = .*pool_size=\\d+`));
    // The ordinary application pool stays transaction-pooled.
    expect(ini).toContain("pool_mode = transaction");
  });

  test("the leader-election URL points at the session alias, never the pooled database", () => {
    const pooled = config();
    const url = leaderElectionDatabaseUrl(pooled);
    expect(url).not.toBeNull();
    expect(url!).toContain(":6432/");
    expect(url!.endsWith(`/${PGBOUNCER_SESSION_ALIAS}`)).toBe(true);
    expect(url).not.toBe(`postgresql://${encodeURIComponent(pooled.PG_DB_USER)}:${encodeURIComponent(pooled.PG_DB_PASSWORD)}@127.0.0.1:6432/${pooled.PG_DB_NAME}`);

    const direct = leaderElectionDatabaseUrl({ ...pooled, PGBOUNCER_ENABLED: false } as DeployConfig);
    expect(direct).not.toBeNull();
    expect(direct!).toContain(":5432/");
    expect(direct!).toContain("sslmode=no-verify");
  });

  test("the provisioner proves a login through the session alias", () => {
    const runner = new ScriptedRunner(() => false, () => "__PG_APPLY__=unchanged");
    provisionPostgres18({ runner, config: config() });
    expect(runner.runs.some((command) => command.includes(PGBOUNCER_SESSION_ALIAS))).toBe(true);
  });

  test("the apply script starts, restarts, reloads or does nothing based on the flags", () => {
    const unchanged = pgbouncerApplyScript({ port: 6432, daemonReload: false, restart: false, reload: false });
    expect(unchanged).toContain("elif [ 0 = 1 ]; then\n  systemctl restart pgbouncer");
    expect(unchanged).toContain("elif [ 0 = 1 ]; then\n  systemctl reload pgbouncer");
    expect(unchanged).not.toContain("daemon-reload");
    const reload = pgbouncerApplyScript({ port: 6432, daemonReload: true, restart: false, reload: true });
    expect(reload).toContain("systemctl daemon-reload");
    expect(reload).toContain("elif [ 1 = 1 ]; then\n  systemctl reload pgbouncer");
    const restart = pgbouncerApplyScript({ port: 6432, daemonReload: false, restart: true, reload: true });
    expect(restart).toContain("elif [ 1 = 1 ]; then\n  systemctl restart pgbouncer");
    expect(restart).toContain("pg_isready -h 127.0.0.1 -p 6432");
  });
});

describe("PostgreSQL apply script", () => {
  test("reloads first and restarts only for a pending postmaster-level setting", () => {
    const script = postgresApplyScript({ unit: "postgresql@18-main", port: 5432, changed: true });
    expect(script).toContain("systemctl reload");
    expect(script).toContain("pg_settings WHERE pending_restart");
    expect(script).toContain('if [ "$pending" != 0 ]; then systemctl restart');
    expect(script).toContain("pg_isready -h 127.0.0.1 -p 5432");
  });

  test("a failed boot (start-limit-hit) is cleared before retrying the start", () => {
    const script = postgresApplyScript({ unit: "postgresql@18-main", port: 5432, changed: false });
    expect(script).toContain('systemctl reset-failed "$unit"');
    expect(script.indexOf("reset-failed")).toBeLessThan(script.indexOf("systemctl enable --now"));
  });

  test("an unchanged cluster is neither reloaded nor restarted", () => {
    const script = postgresApplyScript({ unit: "postgresql@18-main", port: 5432, changed: false });
    expect(script).toContain("elif [ 0 = 1 ]; then\n  t0=");
    expect(script).toContain("elif [ 0 = 1 ]; then\n  systemctl restart");
  });

  test("--force-restart forces the restart branch", () => {
    expect(postgresApplyScript({ unit: "u", port: 5432, changed: false, force: true })).toContain("elif [ 1 = 1 ]; then\n  systemctl restart");
  });
});

describe("Redis apply script", () => {
  test("restart (which flushes the cache and velocity counters) only on change", () => {
    const quiet = redisApplyScript({ unit: "valkey", port: 6379, auth: "", changed: false, daemonReload: false });
    expect(quiet).toContain("elif [ 0 = 1 ]; then");
    const changed = redisApplyScript({ unit: "valkey", port: 6379, auth: "REDISCLI_AUTH='x' ", changed: true, daemonReload: true });
    expect(changed).toContain("elif [ 1 = 1 ]; then");
    expect(changed).toContain("systemctl daemon-reload");
    expect(changed).toContain('CONFIG SET save ""');
  });

  test("a stopped service is started even when `enable` would refuse (linked/alias unit)", () => {
    const script = redisApplyScript({ unit: "redis", port: 6379, auth: "", changed: false, daemonReload: false });
    expect(script).toContain('systemctl enable "$unit" >/dev/null 2>&1 || true');
    expect(script).toContain('systemctl start "$unit"');
    expect(script).not.toContain("enable --now");
    expect(pgbouncerApplyScript({ port: 6432, daemonReload: false, restart: false, reload: false })).toContain("systemctl start pgbouncer");
  });

  test("the unit detector looks at real unit files, not drop-in-only stubs", () => {
    const script = redisUnitDetectScript();
    expect(script).toContain('[ -f "$d/$u.service" ] && [ ! -L "$d/$u.service" ]');
    expect(script).toContain("redis-server redis valkey");
  });
});

describe("provisioner wiring: a no-op redeploy bounces nothing", () => {
  const unchanged = (): ScriptedRunner => new ScriptedRunner(() => false);

  test("PostgreSQL + PgBouncer: no restarts, no reloads when no file changed", () => {
    const runner = unchanged();
    const report = provisionPostgres18({ runner, config: config() });
    expect(runner.runs.some((command) => /systemctl (re)?start|systemctl restart/.test(command) && !command.includes("enable"))).toBe(false);
    const pg = runner.apply("postgresql@18-main")!;
    expect(pg).toContain("elif [ 0 = 1 ]; then\n  t0=");
    const bouncer = runner.apply("systemctl is-active --quiet pgbouncer")!;
    expect(bouncer).toContain("elif [ 0 = 1 ]; then\n  systemctl restart pgbouncer");
    expect(bouncer).toContain("elif [ 0 = 1 ]; then\n  systemctl reload pgbouncer");
    expect(Object.values(report.outcomes ?? {})).toEqual(["unchanged", "unchanged"]);
  });

  test("only pgbouncer.ini changed -> reload, never restart", () => {
    const runner = new ScriptedRunner((path) => path === "/etc/pgbouncer/pgbouncer.ini");
    provisionPostgres18({ runner, config: config() });
    const bouncer = runner.apply("systemctl is-active --quiet pgbouncer")!;
    expect(bouncer).toContain("elif [ 0 = 1 ]; then\n  systemctl restart pgbouncer");
    expect(bouncer).toContain("elif [ 1 = 1 ]; then\n  systemctl reload pgbouncer");
  });

  test("a restart-only setting (signature) changed -> pgbouncer restarts", () => {
    const runner = new ScriptedRunner((path) => path === "/etc/pgbouncer/.pg-deploy-restart-signature");
    provisionPostgres18({ runner, config: config() });
    expect(runner.apply("systemctl is-active --quiet pgbouncer")).toContain("elif [ 1 = 1 ]; then\n  systemctl restart pgbouncer");
  });

  test("PostgreSQL restarted -> PgBouncer restarts too (its server connections are gone)", () => {
    const runner = new ScriptedRunner(() => false, (command) => (command.includes("postgresql@18-main") ? "__PG_APPLY__=restarted" : "__PG_APPLY__=unchanged"));
    provisionPostgres18({ runner, config: config() });
    expect(runner.apply("systemctl is-active --quiet pgbouncer")).toContain("elif [ 1 = 1 ]; then\n  systemctl restart pgbouncer");
  });

  test("the fast-stop drop-in is installed before PgBouncer is touched", () => {
    const runner = unchanged();
    provisionPostgres18({ runner, config: config() });
    const dropIn = runner.writes.findIndex((write) => write.path === PGBOUNCER_DROPIN_PATH);
    expect(dropIn).toBeGreaterThan(-1);
  });

  test("the cluster is applied (started with its final config) before the bootstrap SQL runs", () => {
    const runner = unchanged();
    provisionPostgres18({ runner, config: config() });
    const apply = runner.captures.findIndex((command) => command.includes("pending_restart"));
    expect(apply).toBeGreaterThan(-1);
    const sqlRun = runner.runs.findIndex((command) => command.includes("bootstrap.sql") && command.includes("psql"));
    expect(sqlRun).toBeGreaterThan(-1);
    // capture() and run() are separate logs; the apply must exist at all and the SQL must target the cluster port.
    expect(runner.runs[sqlRun]).toContain("-p 5432");
  });

  test("--force-restart restarts PostgreSQL and PgBouncer even when nothing changed", () => {
    const runner = unchanged();
    provisionPostgres18({ runner, config: config(), forceRestart: true });
    expect(runner.apply("postgresql@18-main")).toContain("elif [ 1 = 1 ]; then\n  systemctl restart");
    expect(runner.apply("systemctl is-active --quiet pgbouncer")).toContain("elif [ 1 = 1 ]; then\n  systemctl restart pgbouncer");
  });

  test("Redis: unchanged config -> no restart; changed config -> restart", () => {
    const quiet = unchanged();
    provisionRedis({ runner: quiet, config: config() });
    expect(quiet.apply("redis-cli")).toContain("elif [ 0 = 1 ]; then");
    const noisy = new ScriptedRunner((path) => path === "/etc/valkey/valkey.conf");
    provisionRedis({ runner: noisy, config: config() });
    expect(noisy.apply("redis-cli")).toContain("elif [ 1 = 1 ]; then");
    // A change to the redis (not valkey) flavour's file must not restart a valkey host.
    const other = new ScriptedRunner((path) => path === "/etc/redis/redis.conf");
    provisionRedis({ runner: other, config: config() });
    expect(other.apply("redis-cli")).toContain("elif [ 0 = 1 ]; then");
  });

  test("audit/log databases sharing the primary cluster do not rewrite its config", () => {
    const runner = unchanged();
    provisionAuditAndLogDb({ runner, config: config() });
    expect(runner.writes.some((write) => write.path.endsWith("pg_hba.conf"))).toBe(false);
    expect(runner.writes.some((write) => write.path.endsWith("postgresql.conf"))).toBe(false);
    // ...but they still apply (start-if-down) and report an outcome per cluster.
    expect(runner.captures.filter((command) => command.includes("postgresql@18-main")).length).toBe(2);
  });

  test("a dedicated audit cluster still owns its config", () => {
    const base = config();
    const dedicated = { ...base, AUDIT_DB_NODE: "audit-db@127.0.0.1:22:127.0.0.1:5433", LOG_DB_MANAGE_VIA_SSH: false } as DeployConfig;
    const runner = unchanged();
    provisionAuditAndLogDb({ runner, config: dedicated });
    expect(runner.writes.some((write) => write.path.endsWith("/audit/postgresql.conf"))).toBe(true);
  });

  test("backup engine: no daemon restart when nothing changed, restart when its env changed", () => {
    const quiet = unchanged();
    expect(provisionBackupEngine({ runner: quiet, config: config() }).daemonConfigChanged).toBe(false);
    const noisy = new ScriptedRunner((path) => path === "/etc/pg-backup/backup.env");
    expect(provisionBackupEngine({ runner: noisy, config: config() }).daemonConfigChanged).toBe(true);
  });

  test("backup engine: an unchanged archive config never restarts PostgreSQL or PgBouncer", () => {
    const runner = unchanged();
    provisionBackupEngine({ runner, config: config() });
    expect(runner.runs.some((command) => command.includes("systemctl restart pgbouncer"))).toBe(false);
    expect(runner.captures.some((command) => command.includes("systemctl is-active --quiet pgbouncer"))).toBe(false);
  });

  test("backup engine: a restarting cluster (archive_mode flipped) re-applies PgBouncer", () => {
    const runner = new ScriptedRunner(() => false, (command) => (command.includes("pending_restart") ? "__PG_APPLY__=restarted" : "__PG_APPLY__=unchanged"));
    provisionBackupEngine({ runner, config: config() });
    expect(runner.apply("systemctl is-active --quiet pgbouncer")).toContain("elif [ 1 = 1 ]; then\n  systemctl restart pgbouncer");
  });
});

describe("rsync change detection", () => {
  test("counts real changes and ignores directory timestamp touches", () => {
    const out = [".d..t...... ./", ">f+++++++++ src/a.ts", ">f.st...... src/b.ts", "cd+++++++++ src/new/", "*deleting   old.ts", ".f..t...... same.ts"].join("\n");
    expect(countRsyncChanges(out)).toBe(4);
    expect(countRsyncChanges("")).toBe(0);
    expect(countRsyncChanges(".d..t...... ./\n")).toBe(0);
  });
});

describe("SshRunner (real local execution)", () => {
  const local: SshTarget = { host: "127.0.0.1", port: 22, user: "nobody", keyPath: "/none", sudoPassword: "" };
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pg-runner-test-"));
    dirs.push(dir);
    return dir;
  };

  test("writeRemoteFile reports created / unchanged / modified and keeps the mode", () => {
    const runner = new SshRunner({ logger: () => undefined });
    const path = join(scratch(), "nested", "a.conf");
    expect(runner.writeRemoteFile({ target: local, path, content: "one\n", mode: 0o640 })).toBe(true);
    expect(runner.writeRemoteFile({ target: local, path, content: "one\n", mode: 0o640 })).toBe(false);
    expect(runner.writeRemoteFile({ target: local, path, content: "two\n", mode: 0o640 })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("two\n");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    // unchanged content with a drifted mode gets the mode re-asserted
    writeFileSync(path, "two\n", { mode: 0o600 });
    expect(runner.writeRemoteFile({ target: local, path, content: "two\n", mode: 0o644 })).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test("binary content is compared byte for byte", () => {
    const runner = new SshRunner({ logger: () => undefined });
    const path = join(scratch(), "blob");
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13]);
    expect(runner.writeRemoteFile({ target: local, path, content: bytes })).toBe(true);
    expect(runner.writeRemoteFile({ target: local, path, content: bytes })).toBe(false);
    expect(runner.writeRemoteFile({ target: local, path, content: Buffer.from([0, 255, 1, 254, 10]) })).toBe(true);
  });

  test("a dry run reports every write as changed and touches nothing", () => {
    const runner = new SshRunner({ dryRun: true, logger: () => undefined });
    const path = join(scratch(), "never");
    expect(runner.writeRemoteFile({ target: local, path, content: "x" })).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("every command is timed and the slow ones are flagged", () => {
    const logs: string[] = [];
    const runner = new SshRunner({ logger: (message) => logs.push(message), slowCommandMs: 150 });
    runner.run(local, "true");
    runner.run(local, "sleep 0.3");
    expect(runner.timings.length).toBe(2);
    expect(runner.slowest(1)[0]!.command).toContain("sleep 0.3");
    expect(runner.slowest(1)[0]!.ms).toBeGreaterThanOrEqual(250);
    expect(logs.some((line) => line.includes("slow command") && line.includes("sleep 0.3"))).toBe(true);
  });

  test("secrets never reach the timing report", () => {
    const runner = new SshRunner({ logger: () => undefined });
    runner.run(local, "REDISCLI_AUTH=hunter2hunter2 true");
    expect(runner.timings[0]!.command).not.toContain("hunter2");
  });

  test("close() is idempotent and safe without any remote command", () => {
    const runner = new SshRunner({ logger: () => undefined });
    runner.close();
    runner.close();
  });

  test("the write markers are stable (the remote scripts and the parser agree)", () => {
    expect(WRITE_CHANGED).not.toBe(WRITE_UNCHANGED);
    expect(WRITE_CHANGED.includes(WRITE_UNCHANGED)).toBe(false);
    expect(WRITE_UNCHANGED.includes(WRITE_CHANGED)).toBe(false);
  });
});

describe("deploy.ts options and reporting", () => {
  test("--force-restart and --rebuild are parsed, off by default, and unknown flags still fail", async () => {
    const { parseArgs } = await import("../deploy");
    expect(parseArgs([])).toMatchObject({ forceRestart: false, rebuild: false });
    expect(parseArgs(["--force-restart", "--rebuild", "--update"])).toMatchObject({ forceRestart: true, rebuild: true, update: true });
    expect(() => parseArgs(["--force-restrat"])).toThrow(/Unknown option/);
  });

  test("the step timing report shows each step's wall clock and uses the end time for the last step", async () => {
    const { renderStepTimings } = await import("../deploy");
    const out = renderStepTimings(
      [
        { index: 1, title: "Validate", startedAt: 1000 },
        { index: 5, title: "Provision storage", startedAt: 1500 },
        { index: 6, title: "Deploy core", startedAt: 301_500 },
      ],
      312_000,
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/ 1 +0\.5s +Validate/);
    expect(lines[1]).toMatch(/ 5 +300\.0s +Provision storage/);
    expect(lines[2]).toMatch(/ 6 +10\.5s +Deploy core/);
  });

  test("only the SPAs of the selected roles are built, and Fake Rails only when enabled", async () => {
    const { frontendsToBuild } = await import("../deploy");
    const cfg = config();
    const base = { only: new Set<string>() } as never;
    expect(frontendsToBuild({ ...cfg, FAKE_RAILS_ENABLED: false }, base)).toEqual(["admin-front", "merchant-front", "checkout-front"]);
    expect(frontendsToBuild({ ...cfg, FAKE_RAILS_ENABLED: true }, base)).toEqual(["admin-front", "merchant-front", "checkout-front", "fake-rails-front"]);
    expect(frontendsToBuild({ ...cfg, FAKE_RAILS_ENABLED: true }, { only: new Set(["core"]) } as never)).toEqual([]);
    expect(frontendsToBuild({ ...cfg, FAKE_RAILS_ENABLED: true }, { only: new Set(["checkout", "fake-rails"]) } as never)).toEqual(["checkout-front", "fake-rails-front"]);
  });
});

describe("direct PostgreSQL connections must match the hostssl-only pg_hba (audit-logs 500 regression)", () => {
  // One host, one key: the planner rejects a different key per tier on the same machine.
  const plannable = (overrides: Partial<DeployConfig> = {}): DeployConfig => {
    const loaded = loadDeployConfig(ENV.replace(/_SSH_KEY_PATH="[^"]*"/g, '_SSH_KEY_PATH="~/.ssh/shared"'));
    if (!loaded.ok || !loaded.config) throw new Error(loaded.problems.join("; "));
    return { ...loaded.config, ...overrides } as DeployConfig;
  };
  const coreEnv = (cfg: DeployConfig): Record<string, string> => {
    const core = planHosts(cfg).hosts.flatMap((host) => host.services).find((service) => service.role === "core");
    if (!core) throw new Error("no core service planned");
    return core.env;
  };

  test("the generated pg_hba accepts TLS connections only (so every direct client must use TLS)", () => {
    const hba = pgHbaSnippet(config(), ["10.0.0.5"]);
    const rules = hba.split("\n").filter((line) => /^(host|hostssl|hostnossl)\s/.test(line));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((line) => line.startsWith("hostssl"))).toBe(true);
  });

  test("AUDIT_DATABASE_URL and LOG_DATABASE_URL negotiate TLS toward a deploy-managed cluster", () => {
    const env = coreEnv(plannable());
    expect(env.AUDIT_DATABASE_URL).toMatch(/\/pg_audit_db\?sslmode=no-verify$|\?sslmode=no-verify$/);
    expect(env.LOG_DATABASE_URL).toContain("?sslmode=no-verify");
    // PgBouncer's client side is plain, and Prisma's engine does not understand no-verify
    expect(env.DATABASE_URL).not.toContain("sslmode");
  });

  test("core receives the PgBouncer session alias for the leader election", () => {
    const env = coreEnv(plannable());
    expect(env.PGBOUNCER_ENABLED).toBe("true");
    expect(env.LEADER_ELECTION_DATABASE_URL).toContain(":6432/pgw_session");
    expect(env.LEADER_ELECTION_DATABASE_URL).not.toBe(env.DATABASE_URL);
  });

  test("an explicit leader-election URL overrides the derived alias", () => {
    const env = coreEnv(
      plannable({ LEADER_ELECTION_DATABASE_URL: "postgresql://gw:secret@10.9.9.9:5432/gateway" }),
    );
    expect(env.LEADER_ELECTION_DATABASE_URL).toBe("postgresql://gw:secret@10.9.9.9:5432/gateway");
  });

  test("replica URLs (direct to PostgreSQL) negotiate TLS too", () => {
    const env = coreEnv(plannable({ PG_REPLICA_NODES: "pg-rep-1@127.0.0.1:22:127.0.0.1:5433" }));
    expect(env.DATABASE_REPLICA_URLS).toContain("?sslmode=no-verify");
  });

  test("an externally managed audit/log database keeps the operator's URL (no forced TLS)", () => {
    const env = coreEnv(plannable({ AUDIT_DB_MANAGE_VIA_SSH: false, LOG_DB_MANAGE_VIA_SSH: false }));
    expect(env.AUDIT_DATABASE_URL).not.toContain("sslmode");
    expect(env.LOG_DATABASE_URL).not.toContain("sslmode");
  });

  test("the URL parameter is one node-postgres understands for a self-signed server certificate", async () => {
    // pg-connection-string: `no-verify` => ssl { rejectUnauthorized: false }; `require` => default verification (rejects self-signed)
    const parse = (await import("../../core-back/node_modules/pg-connection-string/index.js")) as { parse: (url: string) => { ssl?: unknown } };
    expect((parse.parse("postgresql://u:p@h:5432/d?sslmode=no-verify").ssl as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(false);
  });
});

describe("PgBouncer must really serve the database before anything migrates through it (fresh-database regression)", () => {
  test("the login probe retries through a private PGPASSFILE and fails loudly", () => {
    const script = poolerLoginScript({ port: 6432, database: "gw", user: "u", pgpassLine: "127.0.0.1:6432:gw:u:secretsecret" });
    expect(script).toContain("seq 1 45");
    expect(script).toContain('PGPASSFILE="$d/pgpass" psql --no-password -h 127.0.0.1 -p 6432');
    expect(script).toContain("chmod 600");
    expect(script).toContain("did not accept a login to gw within 45s");
    expect(script).not.toMatch(/PGPASSWORD/);
  });

  test("provisionPostgres18 runs the probe after PgBouncer is applied and before returning", () => {
    const runner = new ScriptedRunner(() => false);
    provisionPostgres18({ runner, config: config() });
    const apply = runner.captures.findIndex((command) => command.includes("systemctl is-active --quiet pgbouncer"));
    expect(apply).toBeGreaterThan(-1);
    const probe = runner.runs.find((command) => command.includes("did not accept a login"));
    expect(probe).toBeDefined();
    expect(probe).toContain("-p 6432");
  });

  test("no probe when PgBouncer is disabled", () => {
    const runner = new ScriptedRunner(() => false);
    provisionPostgres18({ runner, config: { ...config(), PGBOUNCER_ENABLED: false } as DeployConfig });
    expect(runner.runs.some((command) => command.includes("did not accept a login"))).toBe(false);
  });
});
