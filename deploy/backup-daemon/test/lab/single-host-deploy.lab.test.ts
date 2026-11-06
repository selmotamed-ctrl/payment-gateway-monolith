/**
 * DEPLOY-ENGINE LAB: runs the REAL deploy storage steps against a real machine, as a single-host deployment
 * (PostgreSQL primary + audit database + backup daemon on ONE host, `BACKUP_ENGINE_MODE=auto` -> pg-native):
 *
 *   buildPki -> uploadStorageCertificates -> provisionPostgres18 -> provisionAuditAndLogDb -> provisionBackupEngine
 *   -> deployBackupDaemon   (exactly the calls deploy.ts makes in steps 3 and 5)
 *
 * and then drives the backup API from this machine. Only the TRANSPORT differs from a production deploy: the
 * provisioners talk to a small password-based runner (sshpass) instead of the key-based SshRunner, so no key has to
 * be installed on the target. The commands, SQL, files and ordering are the engine's own.
 *
 * Skipped unless LAB_B_HOST / LAB_B_USER / LAB_B_PASSWORD are set (credentials only from the environment).
 * The target must be a disposable Ubuntu/Debian host with the PostgreSQL 18 packages installed, bun, rsync and
 * sudo. DESTRUCTIVE for that host's PostgreSQL: the stock `18/main` cluster is reconfigured and, at the end,
 * dropped (unless LAB_KEEP=1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { deployBackupDaemon, uploadStorageCertificates } from "../../../deploy";
import type { SshRunner } from "../../../lib/sshRunner";
import { buildPki } from "../../../lib/pkiManager";
import { planHosts, type SshTarget } from "../../../lib/hostPlanner";
import type { ProvisionRunner } from "../../../lib/converge";
import { provisionAuditAndLogDb } from "../../../provisioners/auditAndLogDbProvisioner";
import { provisionBackupEngine } from "../../../provisioners/backupEngineProvisioner";
import { provisionPostgres18 } from "../../../provisioners/postgres18Provisioner";
import { verifyDrillReportSignature, type DrillReport } from "../../src/restoreDrillRunner";
import { LEDGER_SCHEMA, auditRows } from "./ledgerFixtures";
import { labSingleHostConfig } from "./labConfig";

const HOST = process.env.LAB_B_HOST ?? "";
const USER = process.env.LAB_B_USER ?? "";
const PASSWORD = process.env.LAB_B_PASSWORD ?? "";
const enabled = HOST !== "" && USER !== "" && PASSWORD !== "";
const suite = enabled ? describe : describe.skip;
if (!enabled) console.warn("[deploy lab] SKIPPED: set LAB_B_HOST, LAB_B_USER and LAB_B_PASSWORD to run it");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async <T>(label: string, produce: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = await produce();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
};

const sshBase = ["-o", "PubkeyAuthentication=no", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15"];
const sshEnv = { ...process.env, SSHPASS: PASSWORD };

/** The provisioners' runner interface over password-based ssh: same commands, different transport. */
class PasswordRunner implements ProvisionRunner {
  public readonly dryRun = false;
  public readonly commandsRun: string[] = [];

  private exec(script: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
    const body = options.cwd ? `cd ${JSON.stringify(options.cwd)} && { ${script}\n}` : script;
    const sudo = options.sudo || options.sudoUser;
    const remote = sudo ? `sudo -S -p '' ${options.sudoUser ? `-u ${options.sudoUser} ` : ""}bash -s` : "bash -s";
    const input = sudo ? `${PASSWORD}\n${body}\n` : `${body}\n`;
    const result = spawnSync("sshpass", ["-e", "ssh", ...sshBase, `${USER}@${HOST}`, remote], { input, encoding: "utf8", env: sshEnv, timeout: options.timeoutMs ?? 900_000, maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  public run(_target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): void {
    this.commandsRun.push(command.slice(0, 120));
    const result = this.exec(command, options);
    if (result.status !== 0) throw new Error(`remote command failed (${result.status}): ${command.slice(0, 200)}\n${(result.stderr || result.stdout).slice(0, 800)}`);
  }

  public capture(_target: SshTarget, command: string, options: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number } = {}): string {
    this.commandsRun.push(command.slice(0, 120));
    const result = this.exec(command, options);
    if (result.status !== 0) throw new Error(`remote command failed (${result.status}): ${command.slice(0, 200)}\n${(result.stderr || result.stdout).slice(0, 800)}`);
    return result.stdout;
  }

  /** Returns whether the content changed (same contract as SshRunner: an identical file is left alone). */
  public writeRemoteFile(input: { target: SshTarget; path: string; content: string | Buffer; mode?: number; sudo?: boolean }): boolean {
    const content = Buffer.from(input.content);
    const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    const mode = (input.mode ?? 0o644).toString(8);
    const path = JSON.stringify(input.path);
    const script = [
      `mkdir -p "$(dirname ${path})"`,
      `if [ -f ${path} ] && [ "$(sha256sum < ${path} | cut -d' ' -f1)" = "${hash}" ]; then chmod ${mode} ${path}; echo __LAB__=unchanged; else`,
      `base64 -d > ${path}.lab-new <<'LAB_B64_EOF'`,
      content.toString("base64"),
      "LAB_B64_EOF",
      `chmod ${mode} ${path}.lab-new && mv -f ${path}.lab-new ${path}; echo __LAB__=changed; fi`,
    ].join("\n");
    const result = this.exec(script, { sudo: input.sudo });
    if (result.status !== 0) throw new Error(`write ${input.path} failed: ${result.stderr.slice(0, 400)}`);
    return !result.stdout.includes("__LAB__=unchanged");
  }

  /** rsync of the daemon source tree (deployBackupDaemon). Runs as the ssh user, like the engine's rsync. */
  public sync(input: { target: SshTarget; local: string; remote: string; delete?: boolean; excludes?: string[] }): { changed: boolean } {
    const result = spawnSync(
      "sshpass",
      ["-e", "rsync", "-a", "--itemize-changes", ...(input.delete ? ["--delete"] : []), ...(input.excludes ?? []).flatMap((pattern) => ["--exclude", pattern]), "-e", `ssh ${sshBase.join(" ")}`, `${input.local}/`, `${USER}@${HOST}:${input.remote}/`],
      { encoding: "utf8", env: sshEnv, timeout: 300_000 },
    );
    if (result.status !== 0) throw new Error(`rsync failed: ${result.stderr.slice(0, 400)}`);
    return { changed: result.stdout.split("\n").some((line) => line.trim().length > 0) };
  }

  /** Ad-hoc access for assertions and seeding. */
  public sh(script: string, options: { sudo?: boolean; sudoUser?: string; allowFail?: boolean } = {}): string {
    const result = this.exec(script, options);
    if (result.status !== 0 && !options.allowFail) throw new Error(`remote script failed (${result.status}): ${(result.stderr || result.stdout).slice(0, 600)}\n${script.slice(0, 300)}`);
    return result.stdout.trim();
  }

  public psql(sql: string, database = "payment_gateway_prod"): string {
    return this.sh(`psql -X -A -t -v ON_ERROR_STOP=1 -d ${database} -f - <<'LAB_SQL_EOF'\n${sql}\nLAB_SQL_EOF`, { sudoUser: "postgres" });
  }
}

suite("deploy-engine lab: the real storage steps on one real host (BACKUP_ENGINE_MODE=auto)", () => {
  const runner = new PasswordRunner();
  // Built in beforeAll, never at collection time: a normal `bun test` must not run openssl or touch /tmp.
  let config: ReturnType<typeof labSingleHostConfig>;
  let plan: ReturnType<typeof planHosts>;
  let host: ReturnType<typeof planHosts>["hosts"][number];
  let pki: ReturnType<typeof buildPki>;
  let pkiDir = "";
  let agent: https.Agent;
  let provisioned = false;
  let localIp = "";

  const provision = (): { daemonConfigChanged: boolean; outcomes: Record<string, string> } => {
    uploadStorageCertificates(runner as unknown as SshRunner, plan, pki, config, false);
    const pg = provisionPostgres18({ runner, config, dryRun: false, forceRestart: false });
    const audit = provisionAuditAndLogDb({ runner, config, dryRun: false, forceRestart: false });
    const backup = provisionBackupEngine({ runner, config, dryRun: false, forceRestart: false });
    deployBackupDaemon({ runner: runner as unknown as SshRunner, config, host, configChanged: backup.daemonConfigChanged, forceRestart: false });
    return { daemonConfigChanged: backup.daemonConfigChanged, outcomes: { ...pg.outcomes, ...audit.outcomes, ...backup.outcomes } };
  };

  const api = <T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: T }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = https.request(
        { host: HOST, port: config.BACKUP_DAEMON_PORT, path, method, agent, timeout: 60_000, headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T }));
        },
      );
      request.on("timeout", () => request.destroy(new Error("daemon request timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  const material = (name: string) => [...pki.clients, ...pki.storageClients].find((entry) => entry.name === name)!;

  const runBackup = async (kind: "full" | "delta"): Promise<{ id: string; status: string; errorMessage?: string }> => {
    const accepted = await api<{ backupJobId: string }>("/v1/backups/trigger", "POST", { target: "all", kind });
    expect(accepted.status).toBe(202);
    return waitFor(`backup ${accepted.json.backupJobId}`, async () => {
      const runs = (await api<{ runs: Array<{ id: string; status: string; errorMessage?: string }> }>("/v1/runs?limit=50")).json.runs;
      const run = runs.find((entry) => entry.id === accepted.json.backupJobId);
      return run && (run.status === "PASSED" || run.status === "FAILED") ? run : null;
    }, 300_000);
  };
  const runDrill = async (body: { targetTime?: string; latest?: boolean }): Promise<DrillReport> => {
    const accepted = await api<{ drillId: string }>("/v1/drills/run", "POST", body);
    expect(accepted.status).toBe(202);
    return waitFor(`drill ${accepted.json.drillId}`, async () => ((await api<{ drills: DrillReport[] }>("/v1/drills?limit=50")).json.drills.find((entry) => entry.id === accepted.json.drillId) ?? null), 300_000);
  };

  beforeAll(() => {
    config = labSingleHostConfig({ host: HOST, user: USER, sudoPassword: PASSWORD });
    plan = planHosts(config);
    host = plan.hosts.find((candidate) => candidate.roles.includes("backup"))!;
    pkiDir = mkdtempSync("/tmp/labpki-");
    pki = buildPki({ config, directory: pkiDir });
    localIp = /src (\d+\.\d+\.\d+\.\d+)/.exec(spawnSync("ip", ["-4", "route", "get", HOST], { encoding: "utf8" }).stdout)?.[1] ?? "";
    if (!localIp) throw new Error("cannot determine this machine's address towards the target");
    // The packages are installed but the default service is masked/disabled and the stock cluster is down.
    runner.sh("systemctl unmask postgresql >/dev/null 2>&1; true", { sudo: true });
    // The deploy firewall policy opens the daemon port to the core hosts; this lab's "core" is this machine.
    runner.sh(`if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow from ${localIp} to any port ${config.BACKUP_DAEMON_PORT} proto tcp comment 'pg-backup deploy lab' >/dev/null; fi`, { sudo: true });
    provisioned = true;
  }, 300_000);

  afterAll(() => {
    agent?.destroy();
    if (provisioned && process.env.LAB_KEEP !== "1") {
      runner.sh(
        [
          `ufw delete allow from ${localIp} to any port ${config.BACKUP_DAEMON_PORT} proto tcp >/dev/null 2>&1`,
          "systemctl disable --now pg-backup-daemon >/dev/null 2>&1",
          "rm -f /etc/systemd/system/pg-backup-daemon.service /etc/cron.d/pg-backup /usr/local/bin/pg-backup-daemon-trigger /usr/local/bin/pg-backup-restore-drill",
          "systemctl daemon-reload",
          "pkill -u pgbackup 2>/dev/null",
          "pg_dropcluster --stop 18 main >/dev/null 2>&1",
          "systemctl disable --now postgresql >/dev/null 2>&1; systemctl mask postgresql >/dev/null 2>&1",
          "rm -rf /opt/pg-backup-daemon /var/lib/pg-backup /etc/pg-backup /var/log/pg-backup /etc/pg-deploy /etc/postgresql/18 /var/lib/postgresql/18",
          "userdel pgbackup 2>/dev/null",
          "pg_createcluster 18 main >/dev/null 2>&1; systemctl mask postgresql >/dev/null 2>&1",
          "true",
        ].join("\n"),
        { sudo: true, allowFail: true },
      );
    }
    if (pkiDir) rmSync(pkiDir, { recursive: true, force: true });
  }, 300_000);

  const t: { lines?: number; before?: Record<string, string> } = {};

  test("the config resolves BACKUP_ENGINE_MODE=auto to pg-native and plans ONE host with pg-primary + audit-db + backup roles", () => {
    expect(config.BACKUP_ENGINE_MODE).toBe("pg-native");
    expect(host.roles.sort()).toEqual(["audit-db", "backup", "pg-primary"]);
  });

  test("PASS 1: the engine's storage steps provision PostgreSQL, the audit database, the certificates and the daemon on a real host", () => {
    const result = provision();
    expect(Object.keys(result.outcomes).length).toBeGreaterThan(0);
    const report = runner.sh(
      [
        "echo PG=$(systemctl is-active postgresql@18-main)",
        "echo DAEMON=$(systemctl is-active pg-backup-daemon)",
        "echo DAEMONUSER=$(ps -o user= -C bun | sort -u | tr '\\n' ' ')",
        "echo LISTEN5432=$(ss -ltn | grep -c ':5432 ')",
        "echo LISTEN4090=$(ss -ltn | grep -c ':4090 ')",
        "echo REPLROLE=$(sudo -u postgres psql -X -A -t -c \"select rolreplication from pg_roles where rolname='gw_replicator'\")",
        "echo APPDB=$(sudo -u postgres psql -X -A -t -c \"select count(*) from pg_database where datname in ('payment_gateway_prod','pg_audit_db')\")",
        "echo ARCHIVEMODE=$(sudo -u postgres psql -X -A -t -c 'show archive_mode')",
        "echo SUMMARIZE=$(sudo -u postgres psql -X -A -t -c 'show summarize_wal')",
        "echo ARCHIVECMD=$(sudo -u postgres psql -X -A -t -c 'show archive_command' | cut -c1-200)",
        "echo WALKEY=$(sudo -u postgres test -r /etc/pg-deploy/certs/wal-archive-client.key && echo readable-by-postgres)",
        "echo DAEMONKEY=$(sudo -u pgbackup test -r /var/lib/pg-backup/shared/certs/backup-daemon.key && echo readable-by-pgbackup)",
        "echo UNITGROUPS=$(grep -c SupplementaryGroups /etc/systemd/system/pg-backup-daemon.service)",
      ].join("\n"),
      { sudo: true },
    );
    console.log(`[deploy lab] after pass 1:\n${report}`);
    expect(report).toContain("PG=active");
    expect(report).toContain("DAEMON=active");
    expect(report).toContain("DAEMONUSER=pgbackup"); // pg-native on the primary's host still runs unprivileged
    expect(report).toContain("LISTEN5432=1");
    expect(report).toContain("LISTEN4090=1");
    expect(report).toContain("REPLROLE=t");
    expect(report).toContain("APPDB=2");
    expect(report).toContain("ARCHIVEMODE=on");
    expect(report).toContain("SUMMARIZE=on");
    expect(report).toMatch(/ARCHIVECMD=curl .*wal-archive-client.*\/v1\/wal\/postgres_core\/%f/);
    expect(report).toContain("WALKEY=readable-by-postgres");
    expect(report).toContain("DAEMONKEY=readable-by-pgbackup");
    expect(report).toContain("UNITGROUPS=0");
    agent = new https.Agent({ keepAlive: true, maxSockets: 8, minVersion: "TLSv1.3", ca: readFileSync(pki.ca.certPath), cert: readFileSync(material("backup-client").certPath), key: readFileSync(material("backup-client").keyPath) });
  }, 1_200_000);

  test("the daemon answers mTLS from this machine and reports healthy targets", async () => {
    const health = await api<{ engineMode: string }>("/health");
    expect(health.json.engineMode).toBe("pg-native");
    const overview = await api<{ healthy: boolean; targets: Array<{ id: string; healthy: boolean; detail: string }> }>("/v1/overview");
    expect(overview.status).toBe(200);
    for (const id of ["local-repo", "postgres-primary"]) {
      expect(overview.json.targets.find((target) => target.id === id), JSON.stringify(overview.json.targets)).toMatchObject({ healthy: true });
    }
  }, 120_000);

  test("seed the ledger and audit data, then FULL backup of the engine-provisioned cluster", async () => {
    runner.psql(`SET ROLE "gw_app";\n${LEDGER_SCHEMA}\nSELECT post_balanced(1000.0000);`);
    runner.psql(auditRows(1, 50), "pg_audit_db");
    expect(runner.psql("SELECT count(*) FROM journal_lines;")).toBe("32");
    const run = await runBackup("full");
    expect(run.errorMessage).toBeUndefined();
    expect(run.status).toBe("PASSED");
  }, 600_000);

  test("WAL flows through the engine-configured archive_command (curl over mTLS to the daemon on the same host)", async () => {
    runner.psql("SET ROLE \"gw_app\"; SELECT post_balanced(500.0000);");
    runner.psql(auditRows(51, 75), "pg_audit_db");
    t.lines = Number(runner.psql("SELECT count(*) FROM journal_lines;"));
    await sleep(1200);
    const mark = runner.psql(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`);
    await sleep(1200);
    runner.psql("SET ROLE \"gw_app\"; INSERT INTO heartbeat DEFAULT VALUES;");
    const segment = runner.psql("SELECT pg_walfile_name(pg_current_wal_lsn());");
    runner.psql("SELECT pg_switch_wal();");
    await waitFor(`segment ${segment} archived`, () => runner.sh(`ls /var/lib/pg-backup/repo/wal/postgres_core 2>/dev/null | grep -c ${segment}`, { sudo: true, allowFail: true }) === "1", 90_000);
    expect(Number(runner.psql("SELECT archived_count FROM pg_stat_archiver;"))).toBeGreaterThan(0);
    expect(Number(runner.psql("SELECT failed_count FROM pg_stat_archiver;"))).toBe(0);
    (t as { mark?: string }).mark = mark;
  }, 300_000);

  test("RESTORE DRILL on the same host passes all three invariants with the audit database read as the audit role", async () => {
    const report = await runDrill({ targetTime: (t as { mark?: string }).mark });
    expect(report.errorMessage).toBeUndefined();
    expect(report.status).toBe("PASSED");
    expect(report.journalLineCount).toBe(t.lines!);
    expect(Number(report.doubleEntryDrift)).toBe(0);
    expect(report.checks.auditChain.detail).toContain("verified 75 audit rows");
    expect(verifyDrillReportSignature(report, config.BACKUP_ENCRYPTION_KEY_HEX)).toBe(true);
    // the scratch cluster is destroyed and nothing leaked into the production archive
    expect(runner.sh("ls /var/lib/pg-backup/scratch | wc -l", { sudo: true })).toBe("0");
    expect(Number(runner.sh("find /var/lib/pg-backup/repo/wal -name '00000002*' | wc -l", { sudo: true }))).toBe(0);
  }, 600_000);

  test("PASS 2 (idempotency): provisioning again changes nothing and bounces neither PostgreSQL nor the daemon", () => {
    const stamp = (): Record<string, string> => ({
      pg: runner.sh("systemctl show postgresql@18-main -p ActiveEnterTimestampMonotonic --value", { sudo: true }),
      daemon: runner.sh("systemctl show pg-backup-daemon -p ActiveEnterTimestampMonotonic --value", { sudo: true }),
      postmaster: runner.sh("head -3 /var/lib/postgresql/18/main/postmaster.pid | tr '\\n' ' '", { sudo: true }),
    });
    const before = stamp();
    const result = provision();
    const after = stamp();
    console.log(`[deploy lab] pass 2 outcomes: ${JSON.stringify(result.outcomes)} daemonConfigChanged=${result.daemonConfigChanged}`);
    expect(result.daemonConfigChanged).toBe(false);
    for (const [name, outcome] of Object.entries(result.outcomes)) {
      expect(["started", "restarted"], `${name} was bounced on a no-op deploy`).not.toContain(outcome);
    }
    expect(after).toEqual(before);
  }, 1_200_000);

  test("DISASTER: stop the primary, then recover everything from the repository alone with a 'latest' drill", async () => {
    runner.psql("SET ROLE \"gw_app\"; SELECT post_balanced(10.0000);");
    const expected = Number(runner.psql("SELECT count(*) FROM journal_lines;"));
    await waitFor("stream to flush the final commits", () => runner.psql("SELECT COALESCE(bool_and(flush_lsn >= pg_current_wal_lsn()), false) FROM pg_stat_replication WHERE application_name = 'pg-backup-daemon' AND state = 'streaming';", "postgres") === "t", 60_000);
    runner.sh("systemctl stop postgresql@18-main", { sudo: true });
    const report = await runDrill({ latest: true });
    expect(report.errorMessage).toBeUndefined();
    expect(report.status).toBe("PASSED");
    expect(report.journalLineCount).toBe(expected);
    expect(Number(report.doubleEntryDrift)).toBe(0);
    console.log(`[deploy lab] primary stopped; latest drill recovered ${report.journalLineCount}/${expected} ledger lines`);
  }, 600_000);
});
