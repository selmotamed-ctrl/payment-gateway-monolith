import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, selectScenarios } from "../stress/cli";
import { parseEnv, scaleNodes, sshLoopbackEnv, withOverrides } from "../stress/env";
import { parseOutcomes } from "../stress/harness";
import { diffSnapshots, isDown, outageWindows, parseSnapshot, pm2AppsScript, snapshotScript } from "../stress/probes";
import { renderReport, writeReport } from "../stress/report";
import { SCENARIOS } from "../stress/scenarios";

const SAMPLE = `# comment
DEPLOY_MODE="auto"
PGBOUNCER_DEFAULT_POOL_SIZE="20"      # ~2-3x cores of real concurrency
KEEP_RELEASES=3
CORE_SSH_HOST="127.0.0.1"
CORE_SSH_KEY_PATH="/home/u/.ssh/id_ed25519"
CORE_NODES="core-1@127.0.0.1:22:127.0.0.1:4000"
ADMIN_NODES="admin-1@127.0.0.1:22:127.0.0.1:4101"
PG_PRIMARY_NODE="pg-pri@127.0.0.1:22:127.0.0.1:5432"
REDIS_PASSWORD="pa'ss word"
`;

describe("env helpers", () => {
  test("parseEnv handles quoted values with trailing comments, bare values and escapes", () => {
    const env = parseEnv(SAMPLE);
    expect(env.get("PGBOUNCER_DEFAULT_POOL_SIZE")).toBe("20");
    expect(env.get("KEEP_RELEASES")).toBe("3");
    expect(env.get("CORE_NODES")).toBe("core-1@127.0.0.1:22:127.0.0.1:4000");
    expect(env.has("comment")).toBe(false);
  });

  test("withOverrides replaces in place, appends new keys and drops the old trailing comment", () => {
    const out = withOverrides(SAMPLE, { PGBOUNCER_DEFAULT_POOL_SIZE: "25", NEW_KEY: "x y" });
    expect(parseEnv(out).get("PGBOUNCER_DEFAULT_POOL_SIZE")).toBe("25");
    expect(parseEnv(out).get("NEW_KEY")).toBe("x y");
    expect(out.match(/PGBOUNCER_DEFAULT_POOL_SIZE/g)?.length).toBe(1);
    expect(parseEnv(out).get("DEPLOY_MODE")).toBe("auto");
  });

  test("withOverrides keeps awkward values intact and refuses ones the engine format cannot hold", () => {
    const tricky = `a\\b $d #not-a-comment 'x'`;
    expect(parseEnv(withOverrides("X=1\n", { X: tricky })).get("X")).toBe(tricky);
    expect(() => withOverrides("X=1\n", { X: 'has"quote' })).toThrow(/cannot be written/);
    expect(() => withOverrides("X=1\n", { X: "two\nlines" })).toThrow(/cannot be written/);
  });

  test("sshLoopbackEnv re-routes only the ssh hop, never the service addresses", () => {
    const out = sshLoopbackEnv(SAMPLE, { keyPath: "/k/lab" });
    const env = parseEnv(out);
    expect(env.get("CORE_SSH_HOST")).toBe("127.0.0.2");
    expect(env.get("CORE_NODES")).toBe("core-1@127.0.0.2:22:127.0.0.1:4000");
    expect(env.get("PG_PRIMARY_NODE")).toBe("pg-pri@127.0.0.2:22:127.0.0.1:5432");
    expect(env.get("CORE_SSH_KEY_PATH")).toBe("/k/lab");
  });

  test("scaleNodes makes N same-host nodes on distinct ports", () => {
    const out = scaleNodes(SAMPLE, "CORE_NODES", 3);
    expect(parseEnv(out).get("CORE_NODES")).toBe("core-1@127.0.0.1:22:127.0.0.1:4000,core-2@127.0.0.1:22:127.0.0.1:4010,core-3@127.0.0.1:22:127.0.0.1:4020");
    expect(() => scaleNodes(SAMPLE, "NOPE_NODES", 2)).toThrow(/not set/);
  });
});

describe("probe maths", () => {
  test("outageWindows measures first failure to next success, including a failure that never ends", () => {
    const samples = [
      { at: 0, ok: true }, { at: 100, ok: false }, { at: 200, ok: false }, { at: 450, ok: true },
      { at: 500, ok: true }, { at: 600, ok: false }, { at: 700, ok: true }, { at: 800, ok: false },
    ];
    expect(outageWindows(samples, 1000)).toEqual([350, 100, 200]);
    expect(outageWindows([], 1000)).toEqual([]);
    expect(outageWindows([{ at: 0, ok: true }], 1000)).toEqual([]);
  });

  test("only connection errors and 502/503/504 count as down (a 404 from the backend means it is up)", () => {
    expect(isDown(null)).toBe(true);
    for (const status of [502, 503, 504]) expect(isDown(status)).toBe(true);
    for (const status of [200, 301, 401, 404, 500]) expect(isDown(status)).toBe(false);
  });

  test("snapshots parse and diff on identity keys only", () => {
    const text = "pg_start=1700000000\npg_pending_restart=0\npgbouncer=123:99\nminio=7:1\npg-backup-daemon=8:2\nnginx=9:3\nredis_run_id=abc\npg_apps=pg-a:online\npg_archive_command=ffee\n";
    const a = parseSnapshot(text);
    expect(a.backup_daemon).toBe("8:2");
    expect(a.redis_run_id).toBe("abc");
    const b = { ...a, pgbouncer: "124:100", nginx: "10:4" };
    expect(diffSnapshots(a, b)).toEqual(["pgbouncer"]); // nginx reloads are not a bounce
    expect(diffSnapshots(a, a)).toEqual([]);
  });

  test("the snapshot script quotes the redis password and only lists pg- apps", () => {
    const script = snapshotScript({ pgPort: 5432, pgbouncerPort: 6432, redisPort: 6379, redisPassword: "it's", dbName: "d", dbUser: "u", dbPassword: "p" });
    expect(script).toContain(`REDISCLI_AUTH='it'\\''s'`);
    expect(script).not.toContain("pm2"); // PM2 is the deploy user's, read without sudo
    expect(pm2AppsScript()).toContain('startsWith("pg-")');
  });

  test("deploy outcomes are parsed from the `services:` lines", () => {
    const output = "x\n  services: 127.0.0.1:postgresql@18-main=unchanged, 127.0.0.1:pgbouncer=restarted\n  services: 127.0.0.1:valkey=reloaded\ny";
    expect(parseOutcomes(output)).toEqual([
      { service: "127.0.0.1:postgresql@18-main", outcome: "unchanged" },
      { service: "127.0.0.1:pgbouncer", outcome: "restarted" },
      { service: "127.0.0.1:valkey", outcome: "reloaded" },
    ]);
  });
});

describe("cli and scenarios", () => {
  test("every scenario has a unique id, a title and a reason", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of SCENARIOS) {
      expect(scenario.title.length).toBeGreaterThan(10);
      expect(scenario.why.length).toBeGreaterThan(10);
    }
  });

  test("destructive scenarios run only with --destructive", () => {
    const normal = selectScenarios({ scenarios: [], destructive: false });
    expect(normal.run.some((scenario) => scenario.destructive)).toBe(false);
    expect(normal.skippedDestructive.length).toBeGreaterThan(0);
    expect(selectScenarios({ scenarios: [], destructive: true }).run.some((scenario) => scenario.destructive)).toBe(true);
    expect(selectScenarios({ scenarios: ["noop-redeploy"], destructive: false }).run.map((scenario) => scenario.id)).toEqual(["noop-redeploy"]);
  });

  test("argument parsing validates numbers and scenario names", () => {
    expect(parseArgs(["--intensity=2", "--budget-factor=1.5", "--seed=7", "--destructive"])).toMatchObject({ intensity: 2, budgetFactor: 1.5, seed: 7, destructive: true });
    expect(() => parseArgs(["--intensity=0"])).toThrow(/positive/);
    expect(() => parseArgs(["--scenarios=nope"])).toThrow(/Unknown scenario/);
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown option/);
    expect(parseArgs(["--", "--scenarios=soak"]).scenarios).toEqual(["soak"]);
  });
});

describe("report", () => {
  const meta = { runId: "r1", startedAt: "s", finishedAt: "f", commit: "abc", host: "h", intensity: 1, budgetFactor: 1, seed: 1, destructive: false };
  const results = [
    { id: "a", title: "A scenario", status: "pass" as const, ms: 1500, checks: [{ name: "ok", ok: true }], measures: [{ name: "t", value: 1.5, unit: "s" }], notes: ["n"] },
    { id: "b", title: "B scenario", status: "fail" as const, ms: 2000, checks: [{ name: "boom", ok: false, detail: "why" }], measures: [], notes: [], error: "stack" },
    { id: "c", title: "C scenario", status: "skipped" as const, ms: 0, checks: [], measures: [], notes: [], skipReason: "destructive" },
  ];

  test("renders a summary table, failed checks and skip reasons", () => {
    const md = renderReport(meta, results);
    expect(md).toContain("**1 passed, 1 failed, 1 skipped**");
    expect(md).toContain("| a | PASS | 1.5s | 1/1 |");
    expect(md).toContain("- boom — why");
    expect(md).toContain("Skipped: destructive");
  });

  test("writes markdown and json files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-stress-report-"));
    try {
      const files = writeReport(dir, meta, results);
      expect(readFileSync(files.markdown, "utf8")).toContain("# Deploy stress report r1");
      expect(JSON.parse(readFileSync(files.json, "utf8")).results.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
