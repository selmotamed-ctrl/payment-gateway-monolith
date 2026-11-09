import { writeSystemAudit } from "../ledger/ledgerAlerts";
import type { PrismaLike } from "../db/ports";
import {
  BaseWorker,
  defaultWorkerHealthRegistry,
  sanitizeWorkerError,
  type WorkerHealthRegistry,
  type WorkerLogger,
  type WorkerOptions,
  type WorkerTickResult,
} from "./workerRuntime";

export type MonitorPriority = "P1" | "P2" | "P3";

/** One tripped condition. `key` distinguishes several findings of one check (a shard, a file, a worker). */
export interface MonitorFinding {
  key?: string;
  title: string;
  detail: string;
  priority?: MonitorPriority;
}

export interface MonitorCheckResult {
  findings: MonitorFinding[];
  /**
   * False when the check could not see every subject (for example a LIMIT was
   * hit). Previously tripped keys of the check that are absent from an
   * incomplete result are kept, not cleared.
   */
  complete?: boolean;
}

export interface MonitorCheckContext {
  now: Date;
  db: PrismaLike;
  registry: WorkerHealthRegistry;
  logger: WorkerLogger;
}

/**
 * A pluggable platform check. Later phases add checks (stale UNKNOWN attempts,
 * backup freshness, ...) by passing more of these to the worker; the worker
 * itself never changes. `id` must be unique, short and stable: it becomes
 * part of the operator case `subjectKey` (`platform.<id>[:<finding.key>]`).
 */
export interface PlatformMonitorCheck {
  id: string;
  run(context: MonitorCheckContext): Promise<MonitorCheckResult | MonitorFinding[]>;
}

export interface MonitorCaseRaiseInput {
  subjectKey: string;
  title: string;
  detail: string;
  priority: MonitorPriority;
  now: Date;
}

export interface MonitorCaseClearInput {
  subjectKey: string;
  detail: string;
  now: Date;
}

/** Where the monitor raises and clears its keyed escalations. */
export interface MonitorCaseSink {
  /** Opens a case unless an unresolved one exists for `subjectKey`. */
  raise(input: MonitorCaseRaiseInput): Promise<{ created: boolean }>;
  /** Records that the condition behind `subjectKey` cleared. */
  clear(input: MonitorCaseClearInput): Promise<void>;
  /** The keys under `prefix` whose case is unresolved and not marked cleared (rehydrates state after a restart). */
  listActiveKeys?(prefix: string): Promise<string[]>;
}

export const PLATFORM_SUBJECT_PREFIX = "platform.";

export const platformSubjectKey = (checkId: string, findingKey?: string): string =>
  `${PLATFORM_SUBJECT_PREFIX}${checkId}${findingKey ? `:${findingKey}` : ""}`;

const CLEARED_MARKER = "[CLEARED ";
const RETRIPPED_MARKER = "[RETRIPPED ";
const MAX_NOTES_LENGTH = 8000;

const isClearedNotes = (notes: string | null | undefined): boolean => {
  if (!notes) return false;
  return notes.lastIndexOf(CLEARED_MARKER) > notes.lastIndexOf(RETRIPPED_MARKER);
};

const appendNote = (notes: string | null | undefined, line: string): string => {
  const next = notes ? `${notes}\n${line}` : line;
  if (next.length <= MAX_NOTES_LENGTH) return next;
  // Keep the original description and the most recent timeline.
  return `${next.slice(0, 2000)}\n...\n${next.slice(next.length - (MAX_NOTES_LENGTH - 2010))}`;
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null &&
  ((error as { code?: unknown }).code === "P2002" || (error as { code?: unknown }).code === "23505");

type AuditWriter = (
  db: PrismaLike,
  input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown },
) => Promise<void>;

export interface PrismaMonitorCaseSinkOptions {
  /** Operator case kind used for platform alerts (default `MANUAL_REVIEW`). */
  kind?: string;
  /** SLA per priority in hours (default P1 4 h, P2 24 h, P3 72 h). */
  slaHours?: Partial<Record<MonitorPriority, number>>;
  /** Audit writer (default `writeSystemAudit`, the system actor). */
  audit?: AuditWriter;
}

/**
 * Operator case sink for platform alerts. Same de-duplication contract as
 * `raiseLedgerCase` (one unresolved case per kind + `subjectKey`, enforced by
 * the partial unique index `operator_cases_open_subject_key_uniq`), with a
 * configurable kind and priority. The case is never resolved automatically:
 * clearing is recorded as a `[CLEARED <ts>]` line on the case and an audit
 * row, and a re-trip while the case is still open appends `[RETRIPPED <ts>]`.
 */
export class PrismaMonitorCaseSink implements MonitorCaseSink {
  private readonly kind: string;
  private readonly slaHours: Record<MonitorPriority, number>;
  private readonly audit: AuditWriter;

  constructor(private readonly db: PrismaLike, options: PrismaMonitorCaseSinkOptions = {}) {
    this.kind = options.kind ?? "MANUAL_REVIEW";
    this.slaHours = { P1: 4, P2: 24, P3: 72, ...options.slaHours };
    this.audit = options.audit ?? (writeSystemAudit as AuditWriter);
  }

  private findOpen(subjectKey: string): Promise<{ id: string; resolutionNotes: string | null } | null> {
    return this.db.operatorCase.findFirst({
      where: { kind: this.kind, subjectKey, state: { not: "RESOLVED" } },
      select: { id: true, resolutionNotes: true },
    });
  }

  async raise(input: MonitorCaseRaiseInput): Promise<{ created: boolean }> {
    const line = `${input.title}: ${input.detail}`;
    const open = await this.findOpen(input.subjectKey);
    if (open) {
      if (isClearedNotes(open.resolutionNotes)) {
        await this.db.operatorCase.update({
          where: { id: open.id },
          data: { resolutionNotes: appendNote(open.resolutionNotes, `${RETRIPPED_MARKER}${input.now.toISOString()}] ${line}`) },
        });
        await this.audit(this.db, {
          action: "PLATFORM_MONITOR_RETRIPPED",
          entityType: "OPERATOR_CASE",
          entityId: String(open.id),
          after: { subjectKey: input.subjectKey, priority: input.priority, detail: input.detail },
        });
      }
      return { created: false };
    }
    let createdId: string;
    try {
      const created = await this.db.operatorCase.create({
        data: {
          kind: this.kind,
          priority: input.priority,
          state: "OPEN",
          subjectKey: input.subjectKey,
          resolutionNotes: appendNote(null, line),
          slaDueAt: new Date(input.now.getTime() + this.slaHours[input.priority] * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      createdId = String(created.id);
    } catch (error) {
      if (isUniqueViolation(error)) return { created: false }; // another node raised it first
      throw error;
    }
    await this.audit(this.db, {
      action: "PLATFORM_MONITOR_CASE_RAISED",
      entityType: "OPERATOR_CASE",
      entityId: createdId,
      after: { subjectKey: input.subjectKey, priority: input.priority, detail: input.detail },
    });
    return { created: true };
  }

  async clear(input: MonitorCaseClearInput): Promise<void> {
    const open = await this.findOpen(input.subjectKey);
    if (!open || isClearedNotes(open.resolutionNotes)) return;
    await this.db.operatorCase.update({
      where: { id: open.id },
      data: { resolutionNotes: appendNote(open.resolutionNotes, `${CLEARED_MARKER}${input.now.toISOString()}] ${input.detail}`) },
    });
    await this.audit(this.db, {
      action: "PLATFORM_MONITOR_CLEARED",
      entityType: "OPERATOR_CASE",
      entityId: String(open.id),
      after: { subjectKey: input.subjectKey, detail: input.detail },
    });
  }

  async listActiveKeys(prefix: string): Promise<string[]> {
    const rows = (await this.db.operatorCase.findMany({
      where: { kind: this.kind, subjectKey: { startsWith: prefix }, state: { not: "RESOLVED" } },
      select: { subjectKey: true, resolutionNotes: true },
      take: 1000,
    })) as Array<{ subjectKey: string | null; resolutionNotes: string | null }>;
    return rows
      .filter((row) => typeof row.subjectKey === "string" && !isClearedNotes(row.resolutionNotes))
      .map((row) => row.subjectKey as string);
  }
}

export interface PlatformMonitorWorkerOptions extends WorkerOptions {
  /** The checks to evaluate each tick (see `createStandardPlatformChecks`). */
  checks?: PlatformMonitorCheck[];
  /** Additional checks appended to `checks` (later phases). */
  extraChecks?: PlatformMonitorCheck[];
  /** Escalation sink; defaults to `PrismaMonitorCaseSink` on `db`. */
  caseSink?: MonitorCaseSink;
  /** The registry the checks read worker health from (default: the worker's own registry). */
  monitorRegistry?: WorkerHealthRegistry;
  /** A check that takes longer than this is treated as failed for the tick (default 15 s). */
  checkTimeoutMs?: number;
  /** Consecutive check failures before a `platform.monitor_check_failed:<id>` case is raised (default 3). */
  checkFailureThreshold?: number;
}

export interface PlatformMonitorTickSummary extends WorkerTickResult {
  raised: string[];
  cleared: string[];
  failedChecks: string[];
}

const MONITOR_CHECK_FAILED_ID = "monitor_check_failed";

/**
 * Evaluates the platform checks every minute on the cluster leader and turns
 * their findings into keyed operator cases: a condition opens one case when it
 * first trips and records its clearing when it stops, so a repeated tick never
 * opens a second case. State is held in memory and rehydrated from the sink
 * after a restart or leader change.
 */
export class PlatformMonitorWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly checks: PlatformMonitorCheck[];
  private readonly sink: MonitorCaseSink;
  private readonly monitorRegistry: WorkerHealthRegistry;
  private readonly checkTimeoutMs: number;
  private readonly checkFailureThreshold: number;
  /** subjectKey -> owning check id, for every condition currently tripped. */
  private readonly active = new Map<string, string>();
  private readonly checkFailures = new Map<string, number>();
  private hydrated = false;
  lastSummary: PlatformMonitorTickSummary | null = null;

  constructor(options: PlatformMonitorWorkerOptions) {
    super({ ...options, intervalMs: options.intervalMs ?? 60_000 });
    this.checks = [...(options.checks ?? []), ...(options.extraChecks ?? [])];
    const ids = new Set<string>();
    for (const check of this.checks) {
      if (!/^[a-z0-9_]{1,48}$/.test(check.id)) {
        throw new Error(`PlatformMonitorWorker: invalid check id '${check.id}'`);
      }
      if (check.id === MONITOR_CHECK_FAILED_ID || ids.has(check.id)) {
        throw new Error(`PlatformMonitorWorker: duplicate or reserved check id '${check.id}'`);
      }
      ids.add(check.id);
    }
    this.sink = options.caseSink ?? new PrismaMonitorCaseSink(options.db);
    this.monitorRegistry = options.monitorRegistry ?? this.healthRegistry ?? defaultWorkerHealthRegistry;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 15_000;
    this.checkFailureThreshold = Math.max(1, options.checkFailureThreshold ?? 3);
  }

  /** The keys currently tripped (test/diagnostic view). */
  activeKeys(): string[] {
    return [...this.active.keys()].sort();
  }

  private ownerOf(subjectKey: string): string | null {
    const rest = subjectKey.slice(PLATFORM_SUBJECT_PREFIX.length);
    const id = rest.split(":")[0] ?? "";
    if (id === MONITOR_CHECK_FAILED_ID) return id;
    return this.checks.some((check) => check.id === id) ? id : null;
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (this.sink.listActiveKeys) {
      const keys = await this.sink.listActiveKeys(PLATFORM_SUBJECT_PREFIX);
      for (const key of keys) {
        const owner = this.ownerOf(key);
        // Keys of checks that are no longer configured are left alone.
        if (owner) this.active.set(key, owner);
      }
    }
    this.hydrated = true;
  }

  private runWithTimeout(check: PlatformMonitorCheck, context: MonitorCheckContext): Promise<MonitorCheckResult | MonitorFinding[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`check timed out after ${this.checkTimeoutMs} ms`)), this.checkTimeoutMs);
    });
    return Promise.race([check.run(context), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async apply(
    checkId: string,
    findings: MonitorFinding[],
    complete: boolean,
    now: Date,
    summary: PlatformMonitorTickSummary,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const finding of findings) {
      const subjectKey = platformSubjectKey(checkId, finding.key);
      if (seen.has(subjectKey)) continue;
      seen.add(subjectKey);
      if (this.active.has(subjectKey)) continue;
      const result = await this.sink.raise({
        subjectKey,
        title: finding.title,
        detail: finding.detail,
        priority: finding.priority ?? "P1",
        now,
      });
      this.active.set(subjectKey, checkId);
      summary.raised.push(subjectKey);
      this.logger.warn(`${this.name}: condition tripped`, { subjectKey, created: result.created, title: finding.title });
    }
    if (!complete) return;
    for (const [subjectKey, owner] of [...this.active]) {
      if (owner !== checkId || seen.has(subjectKey)) continue;
      await this.sink.clear({ subjectKey, detail: "Condition no longer observed by the platform monitor", now });
      this.active.delete(subjectKey);
      summary.cleared.push(subjectKey);
      this.logger.info(`${this.name}: condition cleared`, { subjectKey });
    }
  }

  protected async tick(): Promise<PlatformMonitorTickSummary> {
    const now = this.clock();
    const summary: PlatformMonitorTickSummary = { raised: [], cleared: [], failedChecks: [] };
    await this.hydrate();
    const context: MonitorCheckContext = { now, db: this.db, registry: this.monitorRegistry, logger: this.logger };
    const failedFindings: MonitorFinding[] = [];
    for (const check of this.checks) {
      let outcome: MonitorCheckResult | MonitorFinding[];
      try {
        outcome = await this.runWithTimeout(check, context);
      } catch (error) {
        const failures = (this.checkFailures.get(check.id) ?? 0) + 1;
        this.checkFailures.set(check.id, failures);
        summary.failedChecks.push(check.id);
        const message = sanitizeWorkerError(error);
        this.logger.warn(`${this.name}: check failed`, { check: check.id, failures, error: message });
        if (failures >= this.checkFailureThreshold) {
          failedFindings.push({
            key: check.id,
            title: "Platform monitor check failing",
            detail: `Check '${check.id}' failed ${failures} times in a row: ${message}`,
            priority: "P2",
          });
        }
        continue;
      }
      this.checkFailures.set(check.id, 0);
      const result = Array.isArray(outcome) ? { findings: outcome } : outcome;
      await this.apply(check.id, result.findings ?? [], result.complete !== false, now, summary);
    }
    // The monitor's own blind spots: complete, because every check reported (ok or failed) this tick.
    await this.apply(MONITOR_CHECK_FAILED_ID, failedFindings, true, now, summary);
    summary.processed = summary.raised.length + summary.cleared.length;
    summary.backlog = this.active.size;
    this.lastSummary = summary;
    return summary;
  }
}
