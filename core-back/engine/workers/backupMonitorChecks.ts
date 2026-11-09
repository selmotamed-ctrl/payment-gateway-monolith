import type { MonitorFinding, PlatformMonitorCheck } from "./PlatformMonitorWorker";
import type { BackupOverview, BackupRun } from "../../lib/storageEngine/backupControlClient";

/**
 * AUTO-27: backup failures that used to stay inside the backup daemon's own catalog become keyed operator cases.
 *
 * The check polls the daemon overview that `BackupControlClient` already exposes (runs, latest drill, WAL archive lag,
 * policy), so the daemon needs no push channel. Every finding carries its own key, so a failing target and a stale
 * drill are separate cases and each clears on its own when the condition stops.
 *
 *   daemon              the daemon cannot be reached (P1)
 *   unhealthy           the daemon reports itself unhealthy (P1)
 *   wal-lag             WAL archive lag above the policy's `alertLagSeconds` (P1)
 *   backup-failed:<t>   the latest finished run of target <t> FAILED (P1)
 *   backup-stale        no PASSED full backup within `maxFullAgeMs` (P1)
 *   drill-failed        the latest restore drill FAILED, which includes a ledger or audit-chain mismatch (P1)
 *   drill-stale         no restore drill within `maxDrillAgeMs` (P2)
 */
export interface BackupMonitorOptions {
  /** Reads the daemon overview; rejects when the daemon is unreachable. */
  fetchOverview: () => Promise<BackupOverview>;
  /** A PASSED `full` backup must exist within this window. Default 36 h. */
  maxFullAgeMs?: number;
  /** A restore drill must have run within this window. Default 8 days. */
  maxDrillAgeMs?: number;
}

export const DEFAULT_BACKUP_MAX_FULL_AGE_MS = 36 * 60 * 60 * 1000;
export const DEFAULT_BACKUP_MAX_DRILL_AGE_MS = 8 * 24 * 60 * 60 * 1000;

const hours = (ms: number): string => `${Math.round(ms / 3_600_000)} h`;

const finishedAt = (run: BackupRun): number => Date.parse(run.completedAt ?? run.startedAt);

export const createBackupMonitorCheck = (options: BackupMonitorOptions): PlatformMonitorCheck => ({
  id: "backup",
  async run({ now }): Promise<MonitorFinding[]> {
    const maxFullAgeMs = options.maxFullAgeMs ?? DEFAULT_BACKUP_MAX_FULL_AGE_MS;
    const maxDrillAgeMs = options.maxDrillAgeMs ?? DEFAULT_BACKUP_MAX_DRILL_AGE_MS;
    let overview: BackupOverview;
    try {
      overview = await options.fetchOverview();
    } catch (error) {
      return [{
        key: "daemon",
        title: "The backup daemon cannot be reached",
        detail: `The backup daemon did not answer the overview request (${(error as Error).message}). Backups, WAL archiving and restore drills cannot be confirmed.`,
        priority: "P1",
      }];
    }
    const findings: MonitorFinding[] = [];

    if (overview.healthy === false) {
      findings.push({
        key: "unhealthy",
        title: "The backup daemon reports itself unhealthy",
        detail: `The daemon (engine ${overview.engineMode}) reports healthy=false. Unhealthy targets: ${
          overview.targets.filter((target) => !target.healthy).map((target) => `${target.name}${target.detail ? ` (${target.detail})` : ""}`).join(", ") || "none listed"
        }.`,
        priority: "P1",
      });
    }

    const lagSeconds = overview.wal?.archiveLagSeconds ?? 0;
    const lagLimit = overview.policy?.alertLagSeconds;
    if (typeof lagLimit === "number" && lagLimit > 0 && lagSeconds > lagLimit) {
      findings.push({
        key: "wal-lag",
        title: "WAL archiving is behind",
        detail: `The WAL archive lags ${lagSeconds} s (limit ${lagLimit} s, ${overview.wal.lagBytes} bytes behind). Point-in-time recovery is not possible past the last archived LSN ${overview.wal.lastArchivedLsn}.`,
        priority: "P1",
      });
    }

    const runs = (overview.backups ?? []).filter((run) => run.status === "PASSED" || run.status === "FAILED");
    const latestByTarget = new Map<string, BackupRun>();
    for (const run of runs) {
      const current = latestByTarget.get(run.target);
      if (!current || finishedAt(run) > finishedAt(current)) latestByTarget.set(run.target, run);
    }
    for (const [target, run] of latestByTarget) {
      if (run.status === "FAILED") {
        findings.push({
          key: `backup-failed:${target}`,
          title: `The latest ${target} backup failed`,
          detail: `Backup ${run.id} (${run.kind}, ${run.engine}) of ${target} failed at ${run.completedAt ?? run.startedAt}: ${run.errorMessage ?? "no error message recorded"}.`,
          priority: "P1",
        });
      }
    }

    const lastFull = runs.filter((run) => run.status === "PASSED" && run.kind === "full").reduce<BackupRun | null>(
      (best, run) => (best === null || finishedAt(run) > finishedAt(best) ? run : best),
      null,
    );
    if (!lastFull || now.getTime() - finishedAt(lastFull) > maxFullAgeMs) {
      findings.push({
        key: "backup-stale",
        title: "No recent full backup",
        detail: lastFull
          ? `The last PASSED full backup finished ${hours(now.getTime() - finishedAt(lastFull))} ago (limit ${hours(maxFullAgeMs)}).`
          : `The daemon lists no PASSED full backup (limit ${hours(maxFullAgeMs)}).`,
        priority: "P1",
      });
    }

    const drill = overview.latestDrill;
    if (drill && drill.status === "FAILED") {
      findings.push({
        key: "drill-failed",
        title: "The latest restore drill failed",
        detail:
          `Drill ${drill.id} failed at ${drill.completedAt}: ${drill.errorMessage ?? "see the report"}. ` +
          `Double-entry drift ${drill.doubleEntryDrift}, balance mismatches ${drill.balanceMismatches}, audit chain broken links ${drill.auditBrokenLinks}.`,
        priority: "P1",
      });
    }
    const drillAt = drill ? Date.parse(drill.completedAt ?? drill.startedAt) : null;
    if (drillAt === null || now.getTime() - drillAt > maxDrillAgeMs) {
      findings.push({
        key: "drill-stale",
        title: "No recent restore drill",
        detail: drillAt === null
          ? "No restore drill has ever been recorded."
          : `The last restore drill finished ${hours(now.getTime() - drillAt)} ago (limit ${hours(maxDrillAgeMs)}).`,
        priority: "P2",
      });
    }
    return findings;
  },
});
