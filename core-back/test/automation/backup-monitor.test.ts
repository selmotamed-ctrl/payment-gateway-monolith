/**
 * AUTO-27 backup failures reach operators: the backup monitor check turns the daemon overview into keyed findings, and
 * through the platform monitor each becomes ONE case that clears on its own.
 */
import { describe, expect, test } from "bun:test";
import {
  PlatformMonitorWorker,
  type MonitorCaseClearInput,
  type MonitorCaseRaiseInput,
  type MonitorCaseSink,
} from "../../engine/workers/PlatformMonitorWorker";
import { createBackupMonitorCheck } from "../../engine/workers/backupMonitorChecks";
import { WorkerHealthRegistry } from "../../engine/workers/workerRuntime";
import type { BackupOverview, BackupRun, DrillReport } from "../../lib/storageEngine/backupControlClient";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const run = (overrides: Partial<BackupRun> = {}): BackupRun => ({
  id: `run-${Math.random().toString(16).slice(2, 8)}`,
  target: "postgres_core",
  kind: "full",
  engine: "pg-native",
  status: "PASSED",
  startedAt: ago(10 * HOUR),
  completedAt: ago(10 * HOUR - 60_000),
  ...overrides,
});

const drill = (overrides: Partial<DrillReport> = {}): DrillReport => ({
  id: "drill-1",
  status: "PASSED",
  startedAt: ago(48 * HOUR),
  completedAt: ago(47 * HOUR),
  durationMs: 1,
  targetTime: ago(48 * HOUR),
  replayedLsn: "0/1",
  doubleEntryDrift: "0.00",
  balanceMismatches: 0,
  auditBrokenLinks: 0,
  journalLineCount: 10,
  checks: { doubleEntry: { ok: true, detail: "" }, balanceParity: { ok: true, detail: "" }, auditChain: { ok: true, detail: "" } },
  ...overrides,
});

const overviewOf = (overrides: Partial<BackupOverview> = {}): BackupOverview => ({
  generatedAt: NOW.toISOString(),
  engineMode: "pg-native",
  healthy: true,
  wal: { archiveLagSeconds: 5, currentLsn: "0/2", lastArchivedLsn: "0/1", lagBytes: 10 },
  targets: [{ id: "t1", name: "primary", kind: "database", healthy: true }],
  schedule: { fullCron: "", deltaCron: "", drillCron: "", fullRetentionDays: 14, walRetentionDays: 14, alertLagSeconds: 60 },
  policy: { fullCron: "", deltaCron: "", drillCron: "", fullRetentionDays: 14, walRetentionDays: 14, alertLagSeconds: 60 },
  backups: [run()],
  latestDrill: drill(),
  drills: [],
  ...overrides,
});

const findingsOf = async (overview: BackupOverview | Error, options: { maxFullAgeMs?: number; maxDrillAgeMs?: number } = {}) => {
  const check = createBackupMonitorCheck({
    fetchOverview: async () => {
      if (overview instanceof Error) throw overview;
      return overview;
    },
    ...options,
  });
  return (await check.run({ now: NOW, db: {} as never } as never)) as Array<{ key?: string; priority?: string; title: string; detail: string }>;
};

const keysOf = (findings: Array<{ key?: string }>): string[] => findings.map((finding) => finding.key ?? "").sort();

describe("backup monitor check", () => {
  test("a healthy daemon with a recent full backup and drill raises nothing", async () => {
    expect(await findingsOf(overviewOf())).toEqual([]);
  });

  test("an unreachable daemon is one P1 finding and nothing else is concluded", async () => {
    const findings = await findingsOf(new Error("connect ECONNREFUSED"));
    expect(keysOf(findings)).toEqual(["daemon"]);
    expect(findings[0]!.priority).toBe("P1");
    expect(findings[0]!.detail).toMatch(/ECONNREFUSED/);
  });

  test("an unhealthy daemon names its unhealthy targets", async () => {
    const findings = await findingsOf(overviewOf({ healthy: false, targets: [{ id: "s3", name: "offsite", kind: "s3", healthy: false, detail: "403" }] }));
    expect(keysOf(findings)).toEqual(["unhealthy"]);
    expect(findings[0]!.detail).toContain("offsite (403)");
  });

  test("WAL lag above the policy limit trips, at the limit it does not", async () => {
    const at = overviewOf({ wal: { archiveLagSeconds: 60, currentLsn: "0/2", lastArchivedLsn: "0/1", lagBytes: 1 } });
    expect(await findingsOf(at)).toEqual([]);
    const over = overviewOf({ wal: { archiveLagSeconds: 61, currentLsn: "0/2", lastArchivedLsn: "0/9", lagBytes: 1 } });
    const findings = await findingsOf(over);
    expect(keysOf(findings)).toEqual(["wal-lag"]);
    expect(findings[0]!.detail).toContain("0/9");
  });

  test("the latest finished run of a target decides: a failure trips, a later success clears, running runs are ignored", async () => {
    const failing = overviewOf({
      backups: [
        run({ id: "ok", startedAt: ago(30 * HOUR), completedAt: ago(30 * HOUR) }),
        run({ id: "bad", status: "FAILED", startedAt: ago(5 * HOUR), completedAt: ago(5 * HOUR), errorMessage: "disk full" }),
        run({ id: "live", status: "RUNNING", startedAt: ago(HOUR), completedAt: undefined }),
      ],
    });
    const findings = await findingsOf(failing);
    expect(keysOf(findings)).toEqual(["backup-failed:postgres_core"]);
    expect(findings[0]!.detail).toContain("disk full");

    const recovered = overviewOf({
      backups: [run({ status: "FAILED", startedAt: ago(5 * HOUR), completedAt: ago(5 * HOUR) }), run({ id: "later", startedAt: ago(2 * HOUR), completedAt: ago(2 * HOUR) })],
    });
    expect(await findingsOf(recovered)).toEqual([]);
    // a failure of ANOTHER target does not hide behind a success of this one
    const other = overviewOf({ backups: [run(), run({ target: "audit_db", status: "FAILED", startedAt: ago(HOUR), completedAt: ago(HOUR) })] });
    expect(keysOf(await findingsOf(other))).toEqual(["backup-failed:audit_db"]);
  });

  test("no PASSED full backup within the limit is stale; a delta does not count; none at all is stale", async () => {
    expect(keysOf(await findingsOf(overviewOf({ backups: [run({ startedAt: ago(40 * HOUR), completedAt: ago(40 * HOUR) })] })))).toEqual(["backup-stale"]);
    expect(keysOf(await findingsOf(overviewOf({ backups: [run({ kind: "delta" })] })))).toEqual(["backup-stale"]);
    const none = await findingsOf(overviewOf({ backups: [] }));
    expect(keysOf(none)).toEqual(["backup-stale"]);
    expect(none[0]!.detail).toMatch(/no PASSED full backup/);
    expect(await findingsOf(overviewOf({ backups: [run({ startedAt: ago(40 * HOUR), completedAt: ago(40 * HOUR) })] }), { maxFullAgeMs: 48 * HOUR })).toEqual([]);
  });

  test("a failed drill is P1 and reports the ledger and audit-chain numbers; an old or missing drill is P2", async () => {
    const failed = await findingsOf(overviewOf({ latestDrill: drill({ status: "FAILED", balanceMismatches: 2, auditBrokenLinks: 1, errorMessage: "parity" }) }));
    expect(keysOf(failed)).toEqual(["drill-failed"]);
    expect(failed[0]!.priority).toBe("P1");
    expect(failed[0]!.detail).toMatch(/balance mismatches 2.*broken links 1/);
    const old = await findingsOf(overviewOf({ latestDrill: drill({ startedAt: ago(200 * HOUR), completedAt: ago(199 * HOUR) }) }));
    expect(keysOf(old)).toEqual(["drill-stale"]);
    expect(old[0]!.priority).toBe("P2");
    expect(keysOf(await findingsOf(overviewOf({ latestDrill: null })))).toEqual(["drill-stale"]);
  });

  test("several conditions at once give several independent findings", async () => {
    const findings = await findingsOf(overviewOf({ healthy: false, backups: [], latestDrill: null }));
    expect(keysOf(findings)).toEqual(["backup-stale", "drill-stale", "unhealthy"]);
  });
});

class Sink implements MonitorCaseSink {
  raised: MonitorCaseRaiseInput[] = [];
  cleared: MonitorCaseClearInput[] = [];
  async raise(input: MonitorCaseRaiseInput): Promise<{ created: boolean }> {
    this.raised.push(input);
    return { created: true };
  }
  async clear(input: MonitorCaseClearInput): Promise<void> {
    this.cleared.push(input);
  }
  async listActiveKeys(): Promise<string[]> {
    return [];
  }
}

describe("backup findings through the platform monitor", () => {
  test("each finding is ONE keyed case (platform.backup:<key>), repeated ticks do not reopen it, recovery clears only that key", async () => {
    let overview = overviewOf({
      backups: [run({ id: "bad", status: "FAILED", startedAt: ago(HOUR), completedAt: ago(HOUR), errorMessage: "bucket denied" })],
    });
    const sink = new Sink();
    const monitor = new PlatformMonitorWorker({
      db: {} as never,
      repositories: {} as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clock: () => NOW,
      healthRegistry: null,
      monitorRegistry: new WorkerHealthRegistry(),
      caseSink: sink,
      checks: [createBackupMonitorCheck({ fetchOverview: async () => overview })],
    });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(sink.raised.map((entry) => entry.subjectKey).sort()).toEqual(["platform.backup:backup-failed:postgres_core", "platform.backup:backup-stale"]);
    expect(monitor.activeKeys().sort()).toEqual(["platform.backup:backup-failed:postgres_core", "platform.backup:backup-stale"]);

    overview = overviewOf({ backups: [run({ id: "fixed", startedAt: ago(HOUR), completedAt: ago(HOUR) })] });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(sink.cleared.map((entry) => entry.subjectKey).sort()).toEqual(["platform.backup:backup-failed:postgres_core", "platform.backup:backup-stale"]);
    expect(monitor.activeKeys()).toEqual([]);
  });
});
