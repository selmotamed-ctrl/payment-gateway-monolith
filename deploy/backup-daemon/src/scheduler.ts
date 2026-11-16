import { randomUUID } from "node:crypto";
import type { BackupEngine, BackupKind } from "./backupEngine";
import type { BackupPolicy, CatalogStore } from "./catalogStore";
import { collectSecretValues, redactText, type BackupDaemonConfig } from "./config";
import { nextCronRun } from "./cron";
import type { JobQueue } from "./jobQueue";
import { signDrillReport, type DrillReport, type DrillRunOptions } from "./restoreDrillRunner";

export const SCHEDULED_JOBS = ["full", "delta", "drill"] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export interface SchedulerState {
  enabled: boolean;
  nextFullAt: string | null;
  nextDeltaAt: string | null;
  nextDrillAt: string | null;
}

export interface DrillRunnerLike {
  run(options?: DrillRunOptions): Promise<DrillReport>;
}

export interface BackupSchedulerOptions {
  config: BackupDaemonConfig;
  catalog: CatalogStore;
  engine: BackupEngine;
  drillRunner: DrillRunnerLike;
  /** Shared with the HTTP API: a scheduled slot never overlaps a manual run. */
  jobs?: JobQueue;
  clock?: () => Date;
  idFactory?: () => string;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** Copies/verifies the shared object-storage vault after a successful backup. Returns extra storage target ids. */
  syncObjectStorage?: () => Promise<string[]>;
}

const policyKey: Record<ScheduledJob, keyof BackupPolicy> = {
  full: "fullCron",
  delta: "deltaCron",
  drill: "drillCron",
};

export class BackupScheduler {
  private readonly config: BackupDaemonConfig;
  private readonly catalog: CatalogStore;
  private readonly engine: BackupEngine;
  private readonly drillRunner: DrillRunnerLike;
  private readonly jobs?: JobQueue;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly syncObjectStorage?: () => Promise<string[]>;
  private readonly enabled: boolean;
  private readonly issuedIds = new Set<string>();
  private readonly crons: Record<ScheduledJob, string | null> = {
    full: null,
    delta: null,
    drill: null,
  };
  private readonly next: Record<ScheduledJob, Date | null> = {
    full: null,
    delta: null,
    drill: null,
  };
  private readonly lastSlot: Record<ScheduledJob, string | null> = {
    full: null,
    delta: null,
    drill: null,
  };
  private readonly running = new Set<ScheduledJob>();
  private readonly pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BackupSchedulerOptions) {
    this.config = options.config;
    this.catalog = options.catalog;
    this.engine = options.engine;
    this.drillRunner = options.drillRunner;
    this.jobs = options.jobs;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.logger = options.logger ?? console;
    this.syncObjectStorage = options.syncObjectStorage;
    this.enabled = options.config.SCHEDULER_ENABLED;
    const snapshot = this.catalog.snapshot();
    for (const run of snapshot.runs) this.issuedIds.add(run.id);
    for (const drill of snapshot.drills) this.issuedIds.add(drill.id);
    this.syncPolicy(this.clock());
  }

  public start(): void {
    if (!this.enabled || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error(`[pg-backup-daemon] scheduler tick failed: ${this.safeMessage(error)}`);
      });
    }, this.config.SCHEDULER_TICK_MS);
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  public getState(): SchedulerState {
    const now = this.clock();
    this.syncPolicy(now);
    return {
      enabled: this.enabled,
      nextFullAt: this.next.full?.toISOString() ?? null,
      nextDeltaAt: this.next.delta?.toISOString() ?? null,
      nextDrillAt: this.next.drill?.toISOString() ?? null,
    };
  }

  public get state(): SchedulerState {
    return this.getState();
  }

  public async tick(now: Date = this.clock()): Promise<void> {
    this.syncPolicy(now);
    if (!this.enabled) return;

    const due: Array<{ job: ScheduledJob; slotAt: Date }> = [];
    for (const job of SCHEDULED_JOBS) {
      const expression = this.crons[job];
      const nextAt = this.next[job];
      if (!expression || !nextAt || nextAt.getTime() > now.getTime()) continue;
      const slotAt = new Date(nextAt.getTime());
      this.next[job] = nextCronRun(expression, now);
      due.push({ job, slotAt });
    }
    due.sort((left, right) => left.slotAt.getTime() - right.slotAt.getTime());

    const started: Promise<void>[] = [];
    for (const { job, slotAt } of due) {
      const slotKey = slotAt.toISOString();
      if (this.lastSlot[job] === slotKey) continue;
      if (this.running.size > 0 || this.jobs?.isBusy()) {
        this.logger.warn(
          `[pg-backup-daemon] skipping ${job} run scheduled for ${slotKey}: another job is still running`,
        );
        continue;
      }
      this.lastSlot[job] = slotKey;
      this.running.add(job);
      let task: Promise<void>;
      task = this
        .runQueued(job, slotAt)
        .catch((error) => {
          this.logger.error(`[pg-backup-daemon] ${job} job failed: ${this.safeMessage(error)}`);
        })
        .finally(() => {
          this.running.delete(job);
          this.pending.delete(task);
        });
      this.pending.add(task);
      started.push(task);
    }

    await Promise.all(started);
  }

  private syncPolicy(now: Date): void {
    const policy = this.catalog.getPolicy();
    for (const job of SCHEDULED_JOBS) {
      const expression = String(policy[policyKey[job]]);
      if (this.crons[job] === expression) {
        if (!this.enabled) this.next[job] = null;
        continue;
      }
      this.crons[job] = expression;
      this.lastSlot[job] = null;
      this.next[job] = this.enabled ? nextCronRun(expression, now) : null;
    }
  }

  private reserveId(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = this.idFactory();
      if (id && !this.issuedIds.has(id)) {
        this.issuedIds.add(id);
        return id;
      }
    }
    throw new Error("unable to allocate a unique identifier");
  }

  private safeMessage(error: unknown): string {
    return redactText(
      error instanceof Error ? error.message : String(error),
      collectSecretValues(this.config),
    ).slice(0, 2000);
  }

  /** Runs through the shared queue (when there is one) so HTTP triggers and slots serialize. */
  private async runQueued(job: ScheduledJob, slotAt: Date): Promise<void> {
    if (!this.jobs) return this.runJob(job, slotAt);
    const ticket = this.jobs.enqueue({
      id: `scheduler-${job}-${slotAt.getTime()}`,
      kind: job === "drill" ? "drill" : "backup",
      run: () => this.runJob(job, slotAt),
    });
    await ticket.done;
  }

  private async runJob(job: ScheduledJob, slotAt: Date): Promise<void> {
    if (job === "drill") {
      await this.runDrill();
      return;
    }
    await this.runBackup(job, slotAt);
  }

  private async runBackup(kind: BackupKind, slotAt: Date): Promise<void> {
    const id = this.reserveId();
    const startedAt = this.clock().toISOString();
    await this.catalog.addRun({
      id,
      target: "all",
      kind,
      engine: this.config.BACKUP_ENGINE_MODE,
      status: "QUEUED",
      startedAt,
      storageTargets: [],
    });
    await this.catalog.updateRun(id, { status: "RUNNING" });
    try {
      const result = await this.engine.triggerBackup("all", kind);
      const extraTargets = await this.syncObjectStorage?.();
      if (extraTargets && extraTargets.length > 0) result.storageTargets.push(...extraTargets);
      const completed = this.clock();
      await this.catalog.updateRun(id, {
        status: "PASSED",
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - Date.parse(startedAt)),
        sizeBytes: result.sizeBytes,
        startLsn: result.startLsn,
        endLsn: result.endLsn,
        storageTargets: result.storageTargets ?? [],
      });
      if (kind === "full" && this.engine.prune) {
        try {
          await this.engine.prune("all", "full");
        } catch (error) {
          this.logger.warn(
            `[pg-backup-daemon] pruning after full backup scheduled for ${slotAt.toISOString()} failed: ${this.safeMessage(error)}`,
          );
        }
      }
    } catch (error) {
      const completed = this.clock();
      await this.catalog.updateRun(id, {
        status: "FAILED",
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - Date.parse(startedAt)),
        storageTargets: [],
        errorMessage: this.safeMessage(error),
      });
    }
  }

  private async runDrill(): Promise<void> {
    const id = this.reserveId();
    const startedAt = this.clock().toISOString();
    const startedMs = Date.parse(startedAt);
    try {
      const report = await this.drillRunner.run({ id, requestedBy: "scheduler" });
      await this.catalog.addDrill(report);
    } catch (error) {
      const completed = this.clock();
      const failed: DrillReport = {
        id,
        status: "FAILED",
        startedAt,
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - startedMs),
        targetTime: new Date(startedMs - 5 * 60 * 1000).toISOString(),
        replayedLsn: "",
        doubleEntryDrift: "",
        balanceMismatches: 0,
        auditBrokenLinks: 0,
        journalLineCount: 0,
        checks: {
          doubleEntry: { ok: false, detail: "not executed" },
          balanceParity: { ok: false, detail: "not executed" },
          auditChain: { ok: false, detail: "not executed" },
        },
        errorMessage: this.safeMessage(error),
      };
      await this.catalog.addDrill({
        ...failed,
        reportSignature: signDrillReport(failed, this.config.BACKUP_ENCRYPTION_KEY_HEX),
      });
    }
  }
}
