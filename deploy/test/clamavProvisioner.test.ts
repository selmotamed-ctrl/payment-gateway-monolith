/**
 * AUTO-06 the deploy engine installs and converges ClamAV on every core host: loopback-only clamd, a stream limit
 * above the KYB upload limit, packages only when missing, restart only on change, and the failure modes (no signature
 * database yet, too little memory) end as warnings, not as a failed deploy.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadDeployConfig, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import {
  CLAMD_MIN_MEMORY_MB,
  clamdApplyScript,
  clamdConfig,
  parseClamdOutcome,
  provisionClamav,
} from "../provisioners/clamavProvisioner";

const BASE = `
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_KEY_PATH="~/.ssh/db"
DB_PRIVATE_IP="10.10.0.10"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.0.10:5432/gateway"
CORE_SSH_HOST="10.10.0.20"
CORE_SSH_KEY_PATH="~/.ssh/core"
CORE_PRIVATE_IP="10.10.0.20"
ADMIN_SSH_HOST="10.10.0.30"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
ADMIN_PRIVATE_IP="10.10.0.30"
MERCHANT_SSH_HOST="203.0.113.10"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_PRIVATE_IP="10.10.0.40"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_SSH_HOST="203.0.113.20"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_PRIVATE_IP="10.10.0.50"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
`;
const config = (extra: string): DeployConfig => {
  const result = loadDeployConfig(`${BASE}\n${extra}\n`);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};
const host = (name: string): SshTarget => ({ host: name, port: 22, user: "deploy", keyPath: "/k", sudoPassword: "" });

interface Recorded { kind: "run" | "capture" | "write"; host: string; command?: string; path?: string; content?: string }
const fakeRunner = (answers: { memoryMb?: string; apply?: string; configChanged?: boolean } = {}) => {
  const calls: Recorded[] = [];
  return {
    calls,
    runner: {
      run: (target: SshTarget, command: string) => { calls.push({ kind: "run", host: target.host, command }); },
      capture: (target: SshTarget, command: string) => {
        calls.push({ kind: "capture", host: target.host, command });
        return command.includes("MemTotal") ? (answers.memoryMb ?? "8192") : (answers.apply ?? "__PG_CLAMD__=unchanged\n");
      },
      writeRemoteFile: (input: { target: SshTarget; path: string; content: string | Buffer }) => {
        calls.push({ kind: "write", host: input.target.host, path: input.path, content: String(input.content) });
        return answers.configChanged ?? true;
      },
    },
  };
};

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("clamd configuration", () => {
  test("loopback only, a stream limit above the 25 MB KYB upload limit, the local socket kept", () => {
    const text = clamdConfig();
    expect(text).toMatch(/^TCPSocket 3310$/m);
    expect(text).toMatch(/^TCPAddr 127\.0\.0\.1$/m);
    expect(text).not.toMatch(/TCPAddr 0\.0\.0\.0/);
    expect(text).toMatch(/^LocalSocket \/run\/clamav\/clamd\.ctl$/m);
    for (const key of ["StreamMaxLength", "MaxFileSize"]) {
      const megabytes = Number(new RegExp(`^${key} (\\d+)M$`, "m").exec(text)?.[1]);
      expect(megabytes, key).toBeGreaterThanOrEqual(25);
    }
    expect(text).toMatch(/^User clamav$/m);
  });
});

describe("provisioning", () => {
  test("installs the packages, writes the configuration and converges every core host; reports what happened", () => {
    const { calls, runner } = fakeRunner({ apply: "__PG_CLAMD__=started\n" });
    const report = provisionClamav({ runner, config: config('KYB_SCANNER_MODE="clamd"'), hosts: [{ ssh: host("core-1") }, { ssh: host("core-2") }] });
    expect(report.nodes).toEqual(["core-1", "core-2"]);
    expect(report.outcomes).toEqual({ "core-1:clamav-daemon": "started", "core-2:clamav-daemon": "started" });
    const writes = calls.filter((call) => call.kind === "write");
    expect(writes.map((call) => `${call.host}:${call.path}`)).toEqual(["core-1:/etc/clamav/clamd.conf", "core-2:/etc/clamav/clamd.conf"]);
    expect(writes[0]!.content).toBe(clamdConfig());
    const install = calls.find((call) => call.kind === "run")!.command!;
    expect(install).toContain("clamav-daemon");
    expect(install).toContain("clamav-freshclam");
    expect(install).toContain("'clamav'"); // the Arch package
  });

  test("nothing is installed when the scanner is not clamd or an external daemon address is given", () => {
    for (const extra of ['KYB_SCANNER_MODE="eicar"', 'KYB_SCANNER_MODE="disabled"', 'KYB_SCANNER_MODE="clamd"\nKYB_CLAMD_ADDRESS="10.10.0.60:3310"']) {
      const { calls, runner } = fakeRunner();
      const report = provisionClamav({ runner, config: config(extra), hosts: [{ ssh: host("core-1") }] });
      expect(report.nodes, extra).toEqual([]);
      expect(calls, extra).toEqual([]);
    }
  });

  test("the daemon is restarted only when the configuration changed or --force-restart", () => {
    const scriptOf = (configChanged: boolean, forceRestart?: boolean) => {
      const { calls, runner } = fakeRunner({ configChanged });
      provisionClamav({ runner, config: config('KYB_SCANNER_MODE="clamd"'), hosts: [{ ssh: host("core-1") }], forceRestart });
      return calls.filter((call) => call.kind === "capture").at(-1)!.command!;
    };
    expect(scriptOf(false)).toContain("elif [ 0 = 1 ]");
    expect(scriptOf(true)).toContain("elif [ 1 = 1 ]");
    expect(scriptOf(false, true)).toContain("elif [ 1 = 1 ]");
  });

  test("a host with too little memory and a first download that failed are warnings, never a thrown error", () => {
    const small = fakeRunner({ memoryMb: String(CLAMD_MIN_MEMORY_MB - 1) });
    expect(provisionClamav({ runner: small.runner, config: config('KYB_SCANNER_MODE="clamd"'), hosts: [{ ssh: host("core-1") }] }).notes?.join(" ")).toMatch(/only 2047 MB of RAM/);
    const big = fakeRunner({ memoryMb: String(CLAMD_MIN_MEMORY_MB) });
    expect(provisionClamav({ runner: big.runner, config: config('KYB_SCANNER_MODE="clamd"'), hosts: [{ ssh: host("core-1") }] }).notes).toEqual([]);

    const offline = fakeRunner({ apply: "__PG_CLAMD__=no-database\n" });
    const report = provisionClamav({ runner: offline.runner, config: config('KYB_SCANNER_MODE="clamd"'), hosts: [{ ssh: host("core-1") }] });
    expect(report.notes?.join(" ")).toMatch(/signature download failed.*stay PENDING/);
    expect(report.outcomes).toEqual({ "core-1:clamav-daemon": "unknown" });
  });

  test("outcome parsing", () => {
    expect(parseClamdOutcome("x\n__PG_CLAMD__=restarted\n")).toBe("restarted");
    expect(parseClamdOutcome("__PG_CLAMD__=no-database")).toBe("no-database");
    expect(parseClamdOutcome("nothing")).toBe("unknown");
  });
});

describe("the converge script, run against stubbed systemctl and freshclam", () => {
  const sandbox = (options: { database: boolean; active: boolean; freshclamCreatesDb?: boolean }) => {
    const dir = mkdtempSync(join(tmpdir(), "pg-clamd-"));
    dirs.push(dir);
    const db = join(dir, "db");
    const log = join(dir, "calls.log");
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    // systemctl is-active answers from the scenario; everything else succeeds
    stub("systemctl", `if [ "$1" = "is-active" ]; then exit ${options.active ? 0 : 3}; fi\nexit 0`);
    stub("freshclam", options.freshclamCreatesDb ? `mkdir -p "${db}" && : > "${db}/main.cvd"` : "exit 1");
    if (options.database) { writeFileSync(join(dir, "marker"), ""); }
    return { dir, db, log };
  };
  const run = (options: Parameters<typeof sandbox>[0], changed: boolean) => {
    const { dir, db, log } = sandbox(options);
    // the database lives under /var/lib/clamav in production; the test points the script at a temp directory
    const script = clamdApplyScript({ changed, readySeconds: 2, readyCommand: "true" })
      .replaceAll("/var/lib/clamav/main.c?d", `${db}/main.c?d`)
      .replaceAll("/var/lib/clamav/daily.c?d", `${db}/daily.c?d`);
    if (options.database) spawnSync("sh", ["-c", `mkdir -p "${db}" && : > "${db}/main.cvd"`]);
    const file = join(dir, "script.sh");
    writeFileSync(file, script);
    const result = spawnSync("/bin/sh", [file], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` }, timeout: 20_000 });
    let calls = "";
    try { calls = readFileSync(log, "utf8"); } catch { calls = ""; }
    return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
  };

  test("a first deploy downloads the signatures, starts the updater and the daemon", () => {
    const result = run({ database: false, active: false, freshclamCreatesDb: true }, true);
    expect(result.status).toBe(0);
    expect(result.out).toContain("__PG_CLAMD__=started");
    expect(result.calls).toContain("freshclam --quiet");
    expect(result.calls).toContain("systemctl enable --now clamav-freshclam");
    expect(result.calls).toContain("systemctl disable --now clamav-daemon.socket"); // Debian socket activation would own the sockets
    expect(result.calls).toContain("systemctl start clamav-daemon");
  });

  test("an active daemon is restarted on a configuration change and left alone otherwise", () => {
    const changed = run({ database: true, active: true }, true);
    expect(changed.out).toContain("__PG_CLAMD__=restarted");
    expect(changed.calls).toContain("systemctl restart clamav-daemon");
    const same = run({ database: true, active: true }, false);
    expect(same.out).toContain("__PG_CLAMD__=unchanged");
    expect(same.calls).not.toContain("restart clamav-daemon");
    expect(same.calls).not.toContain("freshclam --quiet"); // the database exists: no download at deploy time
  });

  test("without a database and no network the daemon is NOT started and the script still succeeds", () => {
    const result = run({ database: false, active: false }, true);
    expect(result.status).toBe(0);
    expect(result.out).toContain("__PG_CLAMD__=no-database");
    expect(result.calls).not.toContain("start clamav-daemon");
    expect(result.calls).toContain("systemctl enable --now clamav-freshclam"); // the updater keeps trying
  });

  test("a daemon that never answers PING fails the deploy with a clear message", () => {
    const { dir, db } = sandbox({ database: true, active: true });
    spawnSync("sh", ["-c", `mkdir -p "${db}" && : > "${db}/main.cvd"`]);
    const script = clamdApplyScript({ changed: false, readySeconds: 2, readyCommand: "false" }).replaceAll("/var/lib/clamav/main.c?d", `${db}/main.c?d`);
    writeFileSync(join(dir, "s.sh"), script);
    const result = spawnSync("/bin/sh", [join(dir, "s.sh")], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` }, timeout: 20_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("clamd did not answer PING within 2s");
  });

  test("the default readiness probe is valid bash that speaks the clamd PING protocol", () => {
    const script = clamdApplyScript({ changed: false });
    expect(script).toContain("/dev/tcp/127.0.0.1/3310");
    expect(script).toMatch(/zPING/);
    expect(spawnSync("sh", ["-n", "-c", script]).status).toBe(0);
  });
});
