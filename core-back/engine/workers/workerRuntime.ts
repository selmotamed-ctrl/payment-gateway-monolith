import type { PrismaLike, Repositories } from "../db/ports";

export interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const defaultWorkerLogger: WorkerLogger = {
  info: (message, meta) => console.log(`[worker] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[worker] ${message}`, meta ?? {}),
  error: (message, meta) => console.error(`[worker] ${message}`, meta ?? {}),
};

/**
 * Cluster-wide leader election for singleton workers (see
 * `lib/storageEngine/leaderElection.ts`). `tryAcquire` returns true while this
 * process is the leader for the key and false when another node is.
 */
export interface WorkerLeaderElection {
  tryAcquire(key: string): Promise<boolean>;
  release?(key: string): Promise<void>;
}

/**
 * What a tick may return so the health registry can count its work. Existing
 * workers return nothing; a worker that knows how many rows it handled returns
 * the count (or `{ processed, backlog }`).
 */
export interface WorkerTickResult {
  processed?: number;
  backlog?: number;
}

export type WorkerTickOutcome = void | number | WorkerTickResult;

/** The in-process health record of one worker (epoch milliseconds). */
export interface WorkerHealthRecord {
  name: string;
  intervalMs: number;
  singleton: boolean;
  running: boolean;
  /** True/false for a singleton under leader election; null otherwise. */
  leader: boolean | null;
  registeredAt: number;
  startedAt: number | null;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  /** The error message only (never the stack or the error object), bounded. */
  lastError: string | null;
  lastDurationMs: number | null;
  lastProcessed: number | null;
  processedTotal: number;
  backlog: number | null;
  ticks: number;
  failures: number;
  consecutiveFailures: number;
}

/** The JSON view of one worker served on the health endpoint. */
export interface WorkerHealthView {
  name: string;
  intervalMs: number;
  singleton: boolean;
  running: boolean;
  leader: boolean | null;
  startedAt: string | null;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastProcessed: number | null;
  processedTotal: number;
  backlog: number | null;
  ticks: number;
  failures: number;
  consecutiveFailures: number;
}

export interface WorkerHealthSnapshot {
  generatedAt: string;
  workers: WorkerHealthView[];
}

const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Message only, single line, bounded: the registry never keeps a stack or an error object. */
export const sanitizeWorkerError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  const line = raw.replace(/\s+/g, " ").trim() || "unknown error";
  return line.length > MAX_ERROR_MESSAGE_LENGTH ? `${line.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...` : line;
};

const toIso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/**
 * In-process registry of worker health (AUTO-03). `BaseWorker` fills it
 * automatically; workers that do not extend `BaseWorker` (the storage-engine
 * shippers) may report through the same methods. Every method is total: a
 * report for an unknown name registers it with defaults.
 */
export class WorkerHealthRegistry {
  private readonly entries = new Map<string, WorkerHealthRecord>();

  register(name: string, details: { intervalMs: number; singleton?: boolean }, now: Date = new Date()): void {
    const existing = this.entries.get(name);
    if (existing) {
      existing.intervalMs = details.intervalMs;
      existing.singleton = details.singleton ?? existing.singleton;
      return;
    }
    this.entries.set(name, {
      name,
      intervalMs: details.intervalMs,
      singleton: details.singleton ?? false,
      running: false,
      leader: null,
      registeredAt: now.getTime(),
      startedAt: null,
      lastTickAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      lastDurationMs: null,
      lastProcessed: null,
      processedTotal: 0,
      backlog: null,
      ticks: 0,
      failures: 0,
      consecutiveFailures: 0,
    });
  }

  private entry(name: string): WorkerHealthRecord {
    let record = this.entries.get(name);
    if (!record) {
      this.register(name, { intervalMs: 0 });
      record = this.entries.get(name) as WorkerHealthRecord;
    }
    return record;
  }

  markStarted(name: string, now: Date = new Date()): void {
    const record = this.entry(name);
    record.running = true;
    record.startedAt = now.getTime();
  }

  markStopped(name: string): void {
    this.entry(name).running = false;
  }

  recordLeadership(name: string, leader: boolean | null): void {
    this.entry(name).leader = leader;
  }

  recordTickStart(name: string, now: Date = new Date()): void {
    const record = this.entry(name);
    record.lastTickAt = now.getTime();
    record.ticks += 1;
  }

  recordSuccess(name: string, now: Date, durationMs: number, outcome?: WorkerTickOutcome): void {
    const record = this.entry(name);
    record.lastSuccessAt = now.getTime();
    record.lastDurationMs = Math.max(0, Math.round(durationMs));
    record.consecutiveFailures = 0;
    const processed = typeof outcome === "number"
      ? countOf(outcome)
      : outcome && typeof outcome === "object" ? countOf(outcome.processed) : null;
    if (processed !== null) {
      record.lastProcessed = processed;
      record.processedTotal += processed;
    }
    if (outcome && typeof outcome === "object" && "backlog" in outcome) {
      record.backlog = countOf(outcome.backlog);
    }
  }

  recordFailure(name: string, now: Date, durationMs: number, error: unknown): void {
    const record = this.entry(name);
    record.lastErrorAt = now.getTime();
    record.lastError = sanitizeWorkerError(error);
    record.lastDurationMs = Math.max(0, Math.round(durationMs));
    record.failures += 1;
    record.consecutiveFailures += 1;
  }

  /** Copies of the raw records (for the platform monitor). */
  records(): WorkerHealthRecord[] {
    return [...this.entries.values()].map((record) => ({ ...record }));
  }

  get(name: string): WorkerHealthRecord | undefined {
    const record = this.entries.get(name);
    return record ? { ...record } : undefined;
  }

  snapshot(now: Date = new Date()): WorkerHealthSnapshot {
    const workers = [...this.entries.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((record): WorkerHealthView => ({
        name: record.name,
        intervalMs: record.intervalMs,
        singleton: record.singleton,
        running: record.running,
        leader: record.leader,
        startedAt: toIso(record.startedAt),
        lastTickAt: toIso(record.lastTickAt),
        lastSuccessAt: toIso(record.lastSuccessAt),
        lastErrorAt: toIso(record.lastErrorAt),
        lastError: record.lastError,
        lastDurationMs: record.lastDurationMs,
        lastProcessed: record.lastProcessed,
        processedTotal: record.processedTotal,
        backlog: record.backlog,
        ticks: record.ticks,
        failures: record.failures,
        consecutiveFailures: record.consecutiveFailures,
      }));
    return { generatedAt: now.toISOString(), workers };
  }

  /** Test helper: forget every worker. */
  clear(): void {
    this.entries.clear();
  }
}

/** The process-wide registry used by default by every `BaseWorker` and the core health endpoint. */
export const defaultWorkerHealthRegistry = new WorkerHealthRegistry();

export interface WorkerOptions {
  leaderElection?: WorkerLeaderElection;
  /** How long a claimed row stays invisible to other nodes while it is processed. */
  claimLeaseSeconds?: number;
  db: PrismaLike;
  repositories: Repositories;
  intervalMs?: number;
  batchSize?: number;
  clock?: () => Date;
  logger?: WorkerLogger;
  random?: () => number;
  /**
   * Where the worker reports its health. Defaults to the process-wide
   * `defaultWorkerHealthRegistry`; `null` turns reporting off.
   */
  healthRegistry?: WorkerHealthRegistry | null;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const jitter = (value: number, random: () => number = Math.random): number => {
  const factor = 0.9 + random() * 0.2;
  return Math.max(1, Math.round(value * factor));
};

export const backoffDelayMs = (attempt: number, baseMs: number, maxMs: number): number => {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, maxMs);
};

export abstract class BaseWorker {
  protected readonly db: PrismaLike;
  protected readonly repositories: Repositories;
  protected readonly intervalMs: number;
  protected readonly batchSize: number;
  protected readonly clock: () => Date;
  protected readonly logger: WorkerLogger;
  protected readonly random: () => number;
  protected readonly claimLeaseSeconds: number;
  private readonly leaderElection: WorkerLeaderElection | undefined;
  protected readonly healthRegistry: WorkerHealthRegistry | null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.repositories = options.repositories;
    this.intervalMs = options.intervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 50;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? defaultWorkerLogger;
    this.random = options.random ?? Math.random;
    this.claimLeaseSeconds = options.claimLeaseSeconds ?? 120;
    this.leaderElection = options.leaderElection;
    this.healthRegistry = options.healthRegistry === undefined ? defaultWorkerHealthRegistry : options.healthRegistry;
    this.reportHealth((registry) =>
      registry.register(this.name, { intervalMs: this.intervalMs, singleton: this.singleton }, this.clock()),
    );
  }

  /** Health reporting is best effort and must never break a tick. */
  private reportHealth(fn: (registry: WorkerHealthRegistry) => void): void {
    if (!this.healthRegistry) return;
    try {
      fn(this.healthRegistry);
    } catch {
      // ignore
    }
  }

  /**
   * A singleton worker must only tick on ONE node of the cluster. When a
   * leader election is wired (the production runtime does) the tick only runs
   * on the node that holds the advisory lock; without one the worker behaves as
   * before (single-process deployments and unit tests).
   */
  protected get singleton(): boolean {
    return false;
  }

  /** The advisory-lock key of a singleton worker. */
  get leaderKey(): string {
    return `worker:${this.name}`;
  }

  /** Public read-only view used to build the expected singleton-key list. */
  get clusterSingleton(): boolean {
    return this.singleton;
  }

  /** Runs one tick unless this node is not the leader of a singleton worker. */
  private async tickIfLeader(): Promise<void> {
    if (this.singleton && this.leaderElection) {
      let leader = false;
      try {
        leader = await this.leaderElection.tryAcquire(this.leaderKey);
      } catch (error) {
        // Fail closed: without a confirmed lock a singleton must not run.
        this.logger.warn(`${this.name}: leader election failed, skipping tick`, {
          error: (error as Error).message,
        });
        this.reportHealth((registry) => registry.recordLeadership(this.name, false));
        return;
      }
      if (!leader) {
        this.reportHealth((registry) => registry.recordLeadership(this.name, false));
        return;
      }
      this.reportHealth((registry) => registry.recordLeadership(this.name, true));
    }
    const startedAt = performance.now();
    this.reportHealth((registry) => registry.recordTickStart(this.name, this.clock()));
    let outcome: WorkerTickOutcome;
    try {
      outcome = await this.tick();
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      this.reportHealth((registry) => registry.recordFailure(this.name, this.clock(), durationMs, error));
      throw error;
    }
    const durationMs = performance.now() - startedAt;
    this.reportHealth((registry) => registry.recordSuccess(this.name, this.clock(), durationMs, outcome));
  }

  /**
   * Runs `fn` inside ONE database transaction. A `FOR UPDATE SKIP LOCKED`
   * claim only holds its row locks until the transaction ends, so the claim
   * MUST be in a transaction (outside one the lock is released the instant the
   * statement ends and gives no protection). Narrow test doubles without
   * `$transaction` run the callback directly.
   */
  protected async inTransaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T> {
    if (typeof this.db.$transaction === "function") {
      return (await this.db.$transaction(fn, { timeout: 15_000, maxWait: 5_000 })) as T;
    }
    return fn(this.db);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.reportHealth((registry) => registry.markStarted(this.name, this.clock()));
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.reportHealth((registry) => registry.markStopped(this.name));
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<void> {
    await this.tickIfLeader();
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.execute();
    }, delayMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private async execute(): Promise<void> {
    try {
      await this.tickIfLeader();
    } catch (error) {
      this.logger.error(`${this.name}: tick failed`, { error: (error as Error).message });
    }
    if (!this.stopped) {
      this.scheduleNext(jitter(this.intervalMs, this.random));
    }
  }

  get name(): string {
    return this.constructor.name;
  }

  /** One unit of work. May return a processed count (or `{ processed, backlog }`) for the health registry. */
  protected abstract tick(): Promise<WorkerTickOutcome>;
}
