/**
 * One FIFO queue for every long-running job (backups AND restore drills),
 * shared by the HTTP API and the scheduler.
 *
 * Two rapid clicks on "Run backup now", or a manual trigger that lands on the
 * scheduler's slot, must never start overlapping `pg_basebackup` / `pg_ctl`
 * processes on the same scratch directory. Jobs therefore run strictly one at
 * a time, in acceptance order.
 *
 * `Idempotency-Key` retries (same scope + key) return the already-accepted job
 * instead of enqueueing a second one. The map is in-memory by design: a daemon
 * restart forgets keys, which only matters for a client retrying across a restart.
 */

export type JobKind = "backup" | "drill";

export interface JobSpec {
  id: string;
  kind: JobKind;
  /** Namespace of the idempotency key (e.g. the route). */
  scope?: string;
  idempotencyKey?: string;
  run: () => Promise<void>;
}

export interface EnqueueResult {
  id: string;
  deduplicated: boolean;
  acceptedAt: string;
  /** 0 = starts immediately; N = N jobs are ahead of it. */
  position: number;
  /** Settles (never rejects) when the job has finished. For a deduplicated request it resolves immediately. */
  done: Promise<void>;
}

export class QueueFullError extends Error {
  constructor(public readonly limit: number) {
    super(`the job queue is full (${limit} jobs waiting); retry later`);
    this.name = "QueueFullError";
  }
}

import { promises as nodeFs } from "node:fs";
import { writeFileAtomic } from "./util";

export interface JobQueueOptions {
  /** Where accepted idempotency keys are persisted so a retry after a restart still deduplicates. */
  persistPath?: string;
  clock?: () => Date;
  maxQueued?: number;
  maxIdempotencyEntries?: number;
  idempotencyTtlMs?: number;
  logger?: Pick<Console, "error">;
}

interface IdempotencyEntry {
  id: string;
  acceptedAt: string;
  expiresAtMs: number;
}

export class JobQueue {
  private readonly clock: () => Date;
  private readonly maxQueued: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly logger?: Pick<Console, "error">;
  private readonly waiting: JobSpec[] = [];
  private readonly keys = new Map<string, IdempotencyEntry>();
  private active: JobSpec | null = null;
  private draining: Promise<void> | null = null;
  private readonly persistPath?: string;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: JobQueueOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.maxQueued = options.maxQueued ?? 25;
    this.maxEntries = options.maxIdempotencyEntries ?? 1000;
    this.ttlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
    this.logger = options.logger;
    this.persistPath = options.persistPath;
  }

  /**
   * Restores persisted keys. `isFinished(id)` must say whether that job completed (PASSED/FAILED): a key whose job
   * was interrupted by the restart is DROPPED, so the client's retry runs a fresh job instead of being
   * "deduplicated" to one that no longer exists.
   */
  public async loadKeys(isFinished: (id: string) => boolean): Promise<number> {
    if (!this.persistPath) return 0;
    let raw: string;
    try {
      raw = await nodeFs.readFile(this.persistPath, "utf8");
    } catch {
      return 0;
    }
    let entries: Array<[string, IdempotencyEntry]>;
    try {
      entries = JSON.parse(raw) as Array<[string, IdempotencyEntry]>;
      if (!Array.isArray(entries)) return 0;
    } catch {
      return 0;
    }
    const nowMs = this.clock().getTime();
    let restored = 0;
    for (const [key, entry] of entries) {
      if (typeof key !== "string" || !entry || entry.expiresAtMs <= nowMs || !isFinished(entry.id)) continue;
      this.keys.set(key, entry);
      restored += 1;
    }
    return restored;
  }

  /** Resolves when every queued key write has reached disk. */
  public async whenPersisted(): Promise<void> {
    await this.persistChain;
  }

  private persistKeys(): void {
    if (!this.persistPath) return;
    const path = this.persistPath;
    const snapshot = JSON.stringify([...this.keys.entries()]);
    this.persistChain = this.persistChain
      .then(() => writeFileAtomic(path, snapshot))
      .catch((error) => this.logger?.error(`idempotency keys could not be persisted: ${error instanceof Error ? error.message : String(error)}`));
  }

  public enqueue(spec: JobSpec): EnqueueResult {
    const now = this.clock();
    const mapKey = spec.idempotencyKey ? `${spec.scope ?? spec.kind}:${spec.idempotencyKey}` : undefined;
    if (mapKey) {
      this.expireKeys(now.getTime());
      const existing = this.keys.get(mapKey);
      if (existing) {
        return { id: existing.id, deduplicated: true, acceptedAt: existing.acceptedAt, position: this.positionOf(existing.id), done: Promise.resolve() };
      }
    }
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError(this.maxQueued);

    const acceptedAt = now.toISOString();
    const position = this.waiting.length + (this.active ? 1 : 0);
    if (mapKey) {
      if (this.keys.size >= this.maxEntries) {
        const oldest = this.keys.keys().next().value;
        if (oldest !== undefined) this.keys.delete(oldest);
      }
      this.keys.set(mapKey, { id: spec.id, acceptedAt, expiresAtMs: now.getTime() + this.ttlMs });
      this.persistKeys();
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.waiting.push({ ...spec, run: async () => { try { await spec.run(); } finally { finish(); } } });
    this.draining ??= this.drain();
    return { id: spec.id, deduplicated: false, acceptedAt, position, done };
  }

  /** The job a previous request with this key was accepted as, if it is still remembered. */
  public lookupKey(scope: string, key: string): { id: string; acceptedAt: string } | undefined {
    this.expireKeys(this.clock().getTime());
    const entry = this.keys.get(`${scope}:${key}`);
    return entry ? { id: entry.id, acceptedAt: entry.acceptedAt } : undefined;
  }

  /** True while a job runs or waits. The scheduler skips a due slot instead of queueing behind a manual run. */
  public isBusy(): boolean {
    return this.active !== null || this.waiting.length > 0;
  }

  public activeJob(): { id: string; kind: JobKind } | null {
    return this.active ? { id: this.active.id, kind: this.active.kind } : null;
  }

  public queuedCount(): number {
    return this.waiting.length;
  }

  public async whenIdle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private positionOf(id: string): number {
    if (this.active?.id === id) return 0;
    const index = this.waiting.findIndex((job) => job.id === id);
    return index === -1 ? 0 : index + (this.active ? 1 : 0);
  }

  private expireKeys(nowMs: number): void {
    for (const [key, entry] of this.keys) {
      if (entry.expiresAtMs <= nowMs) this.keys.delete(key);
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiting.length > 0) {
        const job = this.waiting.shift()!;
        this.active = job;
        try {
          await job.run();
        } catch (error) {
          // Job bodies record their own failures in the catalog; this is a last resort.
          this.logger?.error(`job ${job.id} (${job.kind}) threw: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.draining = null;
    }
  }
}
