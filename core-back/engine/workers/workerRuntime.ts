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

export interface WorkerOptions {
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
    await this.tick();
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
      await this.tick();
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
