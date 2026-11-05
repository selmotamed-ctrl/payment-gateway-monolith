import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunInstallCommand, planMigrations, preMigrationBackup } from "../deploy";
import { loadDeployConfig, weakSecretReason, type DeployConfig } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";
import { assertSingleLine, dollarTag, envAssign, pgbouncerQuoted, pgpassField, shellQuote, sqlLiteral } from "../lib/quoting";
import { shellQuote as exportedFromSshRunner } from "../lib/sshRunner";
import { provisionAuditAndLogDb } from "../provisioners/auditAndLogDbProvisioner";
import { backupDaemonEnv, provisionBackupEngine, renderEnvFile, scratchRestoreVerifierScript, walGEnvironment, walGInstallCommand } from "../provisioners/backupEngineProvisioner";
import { pgbouncerIni, pgbouncerUserlist, primaryBootstrapSql, provisionPostgres18, replicaCommands } from "../provisioners/postgres18Provisioner";

/**
 * Regression tests for the confirmed deploy-tooling security findings
 * (D1 quoting, D2 SQL, D4 env files, D5 weak config, B-H2/B-H3/B-H4/B-H6 ...).
 * Every shell-execution assertion runs inside a throw-away temp directory and is
 * skipped when bash is unavailable.
 */

const provSrc = readFileSync(path.join(import.meta.dir, "provisioners.test.ts"), "utf8");
const SOURCE = provSrc.slice(
  provSrc.indexOf("const SOURCE = `") + "const SOURCE = `".length,
  provSrc.indexOf("`;", provSrc.indexOf("const SOURCE = `")),
);
const load = (src = SOURCE): DeployConfig => {
  const r = loadDeployConfig(src);
  if (!r.ok || !r.config) throw new Error(r.problems.join("; "));
  return r.config;
};
const withKey = (src: string, key: string, value: string): string =>
  `${src.replace(new RegExp(`^${key}=.*$`, "m"), "")}
${key}="${value}"
`;

const bashAvailable = (() => {
  try {
    return spawnSync("bash", ["-c", "true"]).status === 0;
  } catch {
    return false;
  }
})();
const shellTest = bashAvailable ? test : test.skip;
const sh = (script: string, cwd: string) => spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
const made: string[] = [];
const tmp = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `sec-${name}-`));
  made.push(dir);
  return dir;
};
import { afterAll } from "bun:test";
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  runs: string[];
  writes: Array<{ path: string; content: string; mode?: number }>;
}
const recordingRunner = (): { runner: any; rec: Recorded } => {
  const rec: Recorded = { runs: [], writes: [] };
  const runner = {
    dryRun: true,
    run: (_t: unknown, command: string) => {
      rec.runs.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    capture: () => "",
    writeRemoteFile: (i: { path: string; content: string | Buffer; mode?: number }) => {
      rec.writes.push({ path: i.path, content: i.content.toString(), mode: i.mode });
    },
  };
  return { runner, rec };
};

describe("shared quoting helpers (D1)", () => {
  test("lib/sshRunner re-exports the single shared shellQuote", () => {
    expect(exportedFromSshRunner).toBe(shellQuote);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
  shellTest("shellQuote round-trips hostile values through bash without executing them", () => {
    const dir = tmp("quote");
    const payload = `x'; touch MARKER_Q; '$(touch MARKER_Q2) \`touch MARKER_Q3\` "q" \\ end`;
    const r = sh(`printf '%s' ${shellQuote(payload)} > out`, dir);
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(dir, "out"), "utf8")).toBe(payload);
    for (const marker of ["MARKER_Q", "MARKER_Q2", "MARKER_Q3"]) expect(existsSync(path.join(dir, marker))).toBe(false);
  });
  test("line formats reject NUL and newlines", () => {
    expect(() => assertSingleLine("a\nb", "x")).toThrow();
    expect(() => sqlLiteral("a\0b")).toThrow();
    expect(() => pgbouncerQuoted("a\rb")).toThrow();
    expect(() => pgpassField("a\nb")).toThrow();
    expect(() => envAssign("K", "a'b")).toThrow();
  });
  test("pgpass and pgbouncer escapers", () => {
    expect(pgpassField("a:b\\c")).toBe("a\\:b\\\\c");
    expect(pgbouncerQuoted('a"b')).toBe('"a""b"');
  });
  test("dollarTag never occurs in the body", () => {
    const body = "x $pgd$ y $pgd1$ z";
    expect(body.includes(dollarTag(body))).toBe(false);
  });
});

describe("D1 postgres18Provisioner quoting", () => {
  const payload = `x'; touch MARKER_D1; '`;
  shellTest("replica commands do not execute an injected replication password", () => {
    const dir = tmp("d1");
    const cfg: DeployConfig = { ...load(), PG_REPLICATION_PASSWORD: payload };
    const cmds = replicaCommands("10.10.10.10:5432", "10.10.10.11:5432", cfg);
    const syntax = spawnSync("bash", ["-n"], { input: cmds.join("\n"), encoding: "utf8", cwd: dir });
    expect(syntax.status).toBe(0);
    // GAP-028: the password never appears in any command (argv); it travels over stdin as a file.
    expect(cmds.join("\n")).not.toContain(payload);
    expect(cmds.join("\n")).not.toContain("printf '%s");
    expect(existsSync(path.join(dir, "MARKER_D1"))).toBe(false);
    // The password is read from the 0600 .pgpass, not exposed through PGPASSWORD.
    expect(cmds.join("\n")).not.toContain("PGPASSWORD");
  });
  test("config schema rejects quotes/backslash/$/whitespace in secrets", () => {
    for (const bad of [`ab'cd-Xk7Qm2Zr-strong`, "ab$cd-Xk7Qm2Zr-strong", "ab cd-Xk7Qm2Zr-strong", "ab\\cd-Xk7Qm2Zr-strong"]) {
      expect(loadDeployConfig(withKey(SOURCE, "PG_REPLICATION_PASSWORD", bad)).ok).toBe(false);
      expect(loadDeployConfig(withKey(SOURCE, "PG_DB_PASSWORD", bad)).ok).toBe(false);
    }
  });
  test("config schema restricts paths, users and cron expressions to safe charsets", () => {
    expect(loadDeployConfig(withKey(SOURCE, "CORE_REMOTE_DIR", "/var/www/x; rm -rf /")).ok).toBe(false);
    expect(loadDeployConfig(withKey(SOURCE, "PG_SSH_USER", "ubuntu; id")).ok).toBe(false);
    expect(loadDeployConfig(withKey(SOURCE, "BACKUP_FULL_CRON", "0 2 * * 0 $(id) ; touch x")).ok).toBe(false);
    expect(loadDeployConfig(withKey(SOURCE, "PG_DATA_DIR", "/var/lib/../etc")).ok).toBe(false);
  });
});

describe("D2 SQL / pgbouncer escaping", () => {
  const evil = `pw'; DROP ROLE victim; --$$ x`;
  test("primaryBootstrapSql escapes quotes and uses a collision-free dollar tag", () => {
    const sql = primaryBootstrapSql({ ...load(), PG_DB_PASSWORD: evil, PG_REPLICATION_PASSWORD: evil }, ["10.10.10.11"]);
    expect(sql.includes(evil)).toBe(false);
    expect(sql).toContain(`'pw''; DROP ROLE victim; --$$ x'`);
    const line = sql.split("\n").find((l) => l.includes("CREATE ROLE"))!;
    const tag = line.match(/^DO (\$[a-z0-9]*\$) /)![1]!;
    expect(tag).not.toBe("$$");
    // The tag must open and close the block exactly once each.
    expect(line.split(tag).length).toBe(3);
  });
  test("a newline in a password is refused rather than rendered", () => {
    expect(() => primaryBootstrapSql({ ...load(), PG_DB_PASSWORD: "a\nb" }, [])).toThrow();
  });
  test("audit/log repository SQL escapes passwords", () => {
    const { runner, rec } = recordingRunner();
    provisionAuditAndLogDb({ runner, config: { ...load(), AUDIT_DB_PASSWORD: evil, LOG_DB_PASSWORD: evil }, dryRun: true, now: new Date("2026-11-03T00:00:00Z") });
    const sql = rec.writes.map((w) => w.content).find((w) => w.includes("CREATE ROLE"))!;
    expect(sql.includes(evil)).toBe(false);
    expect(sql).toContain(`'pw''; DROP ROLE victim; --$$ x'`);
  });
  test("pgbouncer.ini and userlist.txt escape quotes and reject newlines", () => {
    const cfg: DeployConfig = { ...load(), PG_DB_PASSWORD: 'p"w\'x' };
    expect(pgbouncerUserlist(cfg)).toContain('"p""w\'x"');
    expect(pgbouncerIni(cfg)).toContain("password='p\"w\\'x'");
    expect(() => pgbouncerUserlist({ ...cfg, PG_DB_PASSWORD: "a\nb" })).toThrow();
  });
});

describe("D3 restore_command literal", () => {
  test("recover() emits a valid postgresql.conf literal and can keep secrets out of the line", async () => {
    const { WalGEngine } = await import("../backup-daemon/src/backupEngine");
    const { RecordingRunner, makeConfig } = await import("../backup-daemon/test/helpers");
    const request = { target: "postgres_core" as const, targetTime: new Date("2026-11-03T09:55:00.000Z"), targetDir: "/var/lib/pg-backup/scratch", port: 55432 };
    const inline = await new WalGEngine(makeConfig({}), new RecordingRunner()).recover(request);
    expect(inline.recoveryConf!.split("\n")[0]).toMatch(/^restore_command = '(?:[^']|'')*'$/);
    const viaFile = await new WalGEngine(makeConfig({ WALG_ENV_FILE: "/etc/pg-backup/wal-g.env" }), new RecordingRunner()).recover(request);
    const line = viaFile.recoveryConf!.split("\n")[0]!;
    expect(line).toMatch(/^restore_command = '(?:[^']|'')*'$/);
    expect(line).toContain("/etc/pg-backup/wal-g.env");
    expect(line).not.toContain("SECRET_ACCESS_KEY");
    expect(line).not.toContain(makeConfig({}).BACKUP_PRIMARY_S3_SECRET_KEY);
  });
});

describe("D4 env files", () => {
  shellTest("default cron and hostile secrets survive `. envfile` without execution", () => {
    const dir = tmp("d4");
    const cfg: DeployConfig = { ...load(), PG_DB_PASSWORD: "pw;touch MARKER_D4", BACKUP_PRIMARY_S3_SECRET_KEY: "s$(touch MARKER_D4B)x" };
    writeFileSync(path.join(dir, "backup.env"), renderEnvFile(backupDaemonEnv(cfg)));
    writeFileSync(path.join(dir, "wal-g.env"), renderEnvFile(walGEnvironment(cfg)));
    const r = sh(`set -a; . ./backup.env; printf '%s' "$BACKUP_FULL_CRON" > cron; printf '%s' "$PG_PRIMARY_PASSWORD" > pw; . ./wal-g.env; printf '%s' "$AWS_SECRET_ACCESS_KEY" > sk`, dir);
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(dir, "cron"), "utf8")).toBe("0 2 * * 0");
    expect(readFileSync(path.join(dir, "pw"), "utf8")).toBe("pw;touch MARKER_D4");
    expect(readFileSync(path.join(dir, "sk"), "utf8")).toBe("s$(touch MARKER_D4B)x");
    expect(existsSync(path.join(dir, "MARKER_D4"))).toBe(false);
    expect(existsSync(path.join(dir, "MARKER_D4B"))).toBe(false);
  });
  test("values are single-quoted (also valid systemd EnvironmentFile syntax)", () => {
    const text = renderEnvFile(backupDaemonEnv(load()));
    for (const line of text.trim().split("\n")) expect(line).toMatch(/^[A-Za-z_][A-Za-z0-9_]*='[^'\n]*'$/);
  });
  test("the restore drill script starts the scratch cluster with archive_mode=off", () => {
    expect(scratchRestoreVerifierScript(load())).toContain("archive_mode=off");
  });
});

describe("D5 config hardening", () => {
  const example = readFileSync(path.join(import.meta.dir, "..", "deploy.env.example"), "utf8");
  test("the shipped example (placeholders) does not validate", () => {
    const r = loadDeployConfig(example);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("replace this placeholder");
  });
  test("placeholder, short and patterned secrets are rejected", () => {
    expect(weakSecretReason("change-me-strong-db-password")).toBeDefined();
    expect(weakSecretReason("0123456789abcdef0123456789abcdef")).toBeDefined();
    expect(weakSecretReason("aaaaaaaaaaaaaaaaaaaaaaaa")).toBeDefined();
    expect(weakSecretReason("Xk7Qm2Zr9Lp4Vn8Bc3Wd6Th1Yg5Js0Af")).toBeUndefined();
    expect(loadDeployConfig(withKey(SOURCE, "KMS_MASTER_KEY", "short-kms-key-16chr")).ok).toBe(false);
    expect(loadDeployConfig(withKey(SOURCE, "KMS_MASTER_KEY", "0123456789abcdef0123456789abcdef")).ok).toBe(false);
    expect(loadDeployConfig(withKey(SOURCE, "PG_DB_PASSWORD", "change-me-strong-db-password")).ok).toBe(false);
  });
  const fakeRails = (extra = "") => `
FAKE_RAILS_ENABLED="true"
FAKE_RAILS_ALLOW_IN_PRODUCTION="true"
FAKE_RAILS_NODE="fr-1@10.10.5.11:22:10.10.5.11:4104"
FAKE_RAILS_SSH_KEY_PATH="~/.ssh/fr"
FAKE_RAILS_ADMIN_USER="tester-admin"
FAKE_RAILS_ADMIN_PASSWORD="Tester-Strong-Pass-Xk7Qm2Zr!"
FAKE_RAILS_JWT_SECRET="jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af"
FAKE_RAILS_SEEDER_TOKEN="seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua"
${extra}`;
  const base = SOURCE.replace(/^DEPLOY_ENV=.*$/m, "");
  test("unset DEPLOY_ENV is production: Fake Rails / test flags are refused", () => {
    const r = loadDeployConfig(base + fakeRails());
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("FAKE_RAILS_ENABLED is refused");
    expect(loadDeployConfig(`${base}\nDEPLOY_ENV="production"${fakeRails('FAKE_RAILS_ALLOW_IN_PRODUCTION="true"\nIS_TEST_SERVER="true"')}`).ok).toBe(false);
    expect(loadDeployConfig(`${base}\nIS_TEST_SERVER="true"`).ok).toBe(false);
  });
  test("explicit development/staging/test allows Fake Rails", () => {
    for (const env of ["development", "staging", "test"]) {
      const r = loadDeployConfig(`${base}\nDEPLOY_ENV="${env}"${fakeRails()}`);
      expect(r.problems).toEqual([]);
    }
  });
  test("JWT secret must differ from the seeder token", () => {
    const same = "same-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af";
    const r = loadDeployConfig(`${base}\nDEPLOY_ENV="test"${fakeRails().replace(/FAKE_RAILS_JWT_SECRET=.*\n/, `FAKE_RAILS_JWT_SECRET="${same}"\n`).replace(/FAKE_RAILS_SEEDER_TOKEN=.*\n/, `FAKE_RAILS_SEEDER_TOKEN="${same}"\n`)}`);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("must differ");
  });
});

describe("B-H6 secrets at rest", () => {
  test("PostgreSQL bootstrap SQL is written 0600 in a private dir, never /tmp, and removed", () => {
    const { runner, rec } = recordingRunner();
    provisionPostgres18({ runner, config: load(), dryRun: true });
    const sqlWrites = rec.writes.filter((w) => w.content.includes("CREATE ROLE"));
    expect(sqlWrites.length).toBeGreaterThan(0);
    for (const w of sqlWrites) {
      expect(w.path.startsWith("/tmp/")).toBe(false);
      expect(w.mode).toBe(0o600);
    }
    expect(rec.runs.some((c) => c.includes("install -d -m 0700") && c.includes(".pg18-bootstrap-"))).toBe(true);
    expect(rec.runs.some((c) => c.includes("trap") && c.includes("rm -rf"))).toBe(true);
  });
  test("audit/log and archive SQL files are 0600 in private dirs", () => {
    const { runner, rec } = recordingRunner();
    provisionAuditAndLogDb({ runner, config: load(), dryRun: true, now: new Date("2026-11-03T00:00:00Z") });
    provisionBackupEngine({ runner, config: load(), dryRun: true });
    const sqlWrites = rec.writes.filter((w) => w.path.endsWith(".sql"));
    expect(sqlWrites.length).toBeGreaterThan(0);
    for (const w of sqlWrites) {
      expect(w.path.startsWith("/tmp/")).toBe(false);
      expect(w.mode).toBe(0o600);
    }
  });
  test("the pre-migration dump never carries the password on the command line", () => {
    const backup = preMigrationBackup(load(), "/var/www/pg-core/shared/backups/pre-migrate-1");
    expect(backup.command).not.toContain(load().PG_DB_PASSWORD);
    expect(backup.command).toContain("umask 077");
    expect(backup.pgpassContent).toContain(load().PG_DB_PASSWORD);
  });
});

describe("D6/B-H3 migration planning", () => {
  const base = { fresh: false, firstCoreNode: true, databaseNonEmpty: true, pendingMigrations: true, forceFresh: false };
  test("update deploys run migrate deploy when migrations are pending, dumping first", () => {
    expect(planMigrations(base)).toEqual({ runMigrate: true, dumpBeforeMigrate: true });
  });
  test("update deploys skip everything when nothing is pending", () => {
    expect(planMigrations({ ...base, pendingMigrations: false })).toEqual({ runMigrate: false, dumpBeforeMigrate: false });
  });
  test("unknown state is treated conservatively (migrate + dump)", () => {
    expect(planMigrations({ ...base, databaseNonEmpty: undefined, pendingMigrations: undefined })).toEqual({ runMigrate: true, dumpBeforeMigrate: true });
  });
  test("only the first core node migrates", () => {
    expect(planMigrations({ ...base, firstCoreNode: false })).toEqual({ runMigrate: false, dumpBeforeMigrate: false });
  });
  test("--fresh against a non-empty database is refused without --force-fresh", () => {
    const refused = planMigrations({ ...base, fresh: true });
    expect(refused.refuse).toContain("--force-fresh");
    expect(refused.runMigrate).toBe(false);
    expect(planMigrations({ ...base, fresh: true, forceFresh: true })).toEqual({ runMigrate: true, dumpBeforeMigrate: true });
  });
  test("--fresh on an empty database migrates without a dump", () => {
    expect(planMigrations({ ...base, fresh: true, databaseNonEmpty: false })).toEqual({ runMigrate: true, dumpBeforeMigrate: false });
  });
});

describe("B-H4 replication credentials stay off the core app env", () => {
  test("planned core env has no PG_REPLICATION_* keys", () => {
    const plan = planHosts(load());
    const envs = plan.hosts.flatMap((host) => host.services.map((service) => service.env));
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(Object.keys(env).some((key) => key.startsWith("PG_REPLICATION"))).toBe(false);
      expect(Object.values(env)).not.toContain(load().PG_REPLICATION_PASSWORD);
    }
  });
});

describe("supply-chain pinning", () => {
  test("WAL-G install is pinned and checksum verified; missing checksum fails closed", () => {
    const cmd = walGInstallCommand({ ...load(), BACKUP_WALG_SHA256: "a".repeat(64) });
    expect(cmd).toContain("sha256sum -c");
    expect(cmd).toContain("/v3.0.9/");
    expect(() => walGInstallCommand({ ...load(), BACKUP_WALG_SHA256: "" })).toThrow("BACKUP_WALG_SHA256");
    expect(loadDeployConfig(SOURCE.replace(/^BACKUP_WALG_SHA256=.*$/m, "").replace('BACKUP_ENGINE_MODE="barman"', 'BACKUP_ENGINE_MODE="wal-g"').replace('BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"', 'BACKUP_NODE="backup-1@10.10.10.10:22:10.10.10.10:4090"')).ok).toBe(false);
  });
  test("bun is never installed with curl | bash", () => {
    const withSha = bunInstallCommand({ BUN_VERSION: "1.3.5", BUN_SHA256: "b".repeat(64) });
    expect(withSha).toContain("sha256sum -c");
    expect(withSha).not.toContain("| bash");
    const without = bunInstallCommand({ BUN_VERSION: "1.3.5", BUN_SHA256: "" });
    expect(without).not.toContain("curl");
    expect(without).toContain("exit 1");
  });
});

describe("PostgreSQL / backup / nginx hardening", () => {
  test("replica rebuild is skipped for an initialised standby unless PG_REPLICA_REBUILD=true", () => {
    const script = replicaCommands("10.10.10.10:5432", "10.10.10.11:5432", load()).join("\n");
    expect(script).toContain("standby.signal");
    expect(script).toContain("skipping rebuild");
    const rebuild = replicaCommands("10.10.10.10:5432", "10.10.10.11:5432", { ...load(), PG_REPLICA_REBUILD: true }).join("\n");
    expect(rebuild).toContain("-eq 1 ]; then echo");
    expect(rebuild).toContain("[ 0 -eq 1 ]");
  });
  test("PostgreSQL binds loopback + private IP and derives memory from PG_RAM_GB", async () => {
    const { postgresMainConfigSnippet, pgClusterFor } = await import("../provisioners/postgres18Provisioner");
    const cfg = { ...load(), PG_RAM_GB: 64 };
    const snippet = postgresMainConfigSnippet(cfg, pgClusterFor(cfg, "primary", { privateIp: "10.10.10.10", servicePort: 5432 }), "10.10.10.10");
    expect(snippet).toContain("listen_addresses = '127.0.0.1,10.10.10.10'");
    expect(snippet).toContain("shared_buffers = 16GB");
    expect(snippet).toContain("effective_cache_size = 48GB");
    expect(snippet).toContain("io_method = 'worker'");
  });
  test("nginx templates rate limit, hide the version and the fake-rails vhost has an allowlist and tight CSP", () => {
    const dir = path.join(import.meta.dir, "..", "templates");
    for (const name of ["admin.lan", "checkout.lan", "checkout.ssl", "fakerails", "merchant.lan", "merchant.ssl"]) {
      const text = readFileSync(path.join(dir, `nginx.${name}.conf.tpl`), "utf8");
      expect(text, name).toContain("limit_req_zone");
      expect(text, name).toContain("limit_req zone=");
      expect(text, name).toContain("server_tokens off");
    }
    const fake = readFileSync(path.join(dir, "nginx.fakerails.conf.tpl"), "utf8");
    expect(fake).toContain("{{LAN_ALLOW_RULES}}");
    expect(fake).not.toContain("frame-ancestors 'self' *");
    expect(fake).not.toContain("script-src 'self' 'unsafe-inline'");
  });
  test("the rewritten backup mirror never deletes unless configured (see backup-daemon tests)", () => {
    expect(backupDaemonEnv(load()).BACKUP_SECONDARY_MIRROR_DELETE).toBe("false");
    expect(backupDaemonEnv(load()).BACKUP_ALLOWED_CLIENT_CNS).toBe("backup-client");
  });
});

// Keep the temp root referenced so unused-import linting stays quiet on platforms without bash.
void mkdirSync;
