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
        return;
      }
      if (!leader) {
        return;
      }
    }
    await this.tick();
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
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
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

  protected abstract tick(): Promise<void>;
}
