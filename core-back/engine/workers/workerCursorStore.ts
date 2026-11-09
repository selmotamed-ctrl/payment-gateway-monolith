import type { WorkerLogger } from "./workerRuntime";

/**
 * Keyset cursors that a worker persists between ticks (AUTO-25), so a pass
 * that is bounded by a batch size walks the whole table over successive ticks
 * and resumes after a restart or a leader change instead of starting at the
 * first row again.
 */
export interface WorkerCursorStore {
  read(name: string): Promise<string | null>;
  write(name: string, value: string | null): Promise<void>;
}

/** Process-local store (tests, and the fallback when the table is missing). */
export class InMemoryWorkerCursorStore implements WorkerCursorStore {
  private readonly values = new Map<string, string | null>();

  async read(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async write(name: string, value: string | null): Promise<void> {
    this.values.set(name, value);
  }
}

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Stores cursors in `worker_cursors` (migration
 * `20261109120000_outbox_dead_letter_worker_cursors`) through raw SQL. When the
 * table is not reachable (migration not applied yet, a transient error, narrow
 * test doubles) the store logs once and serves the in-memory copy for that
 * call, so the worker still makes progress within the process. Re-evaluating a
 * row because of a stale cursor is harmless: every pass is idempotent.
 */
export class SqlWorkerCursorStore implements WorkerCursorStore {
  private readonly fallback = new InMemoryWorkerCursorStore();
  private degraded = false;

  constructor(
    private readonly db: unknown,
    private readonly logger?: Pick<WorkerLogger, "warn">,
  ) {}

  private get raw(): RawClient | null {
    const candidate = this.db as Partial<RawClient> | null;
    return candidate
      && typeof candidate.$queryRawUnsafe === "function"
      && typeof candidate.$executeRawUnsafe === "function"
      ? (candidate as RawClient)
      : null;
  }

  private degrade(error: unknown): void {
    if (!this.degraded) {
      this.degraded = true;
      this.logger?.warn("worker cursor store unavailable, keeping cursors in memory", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async read(name: string): Promise<string | null> {
    const raw = this.raw;
    if (!raw) {
      this.degrade(new Error("database client has no raw SQL access"));
      return this.fallback.read(name);
    }
    try {
      const rows = await raw.$queryRawUnsafe<Array<{ cursor_value: string | null }>>(
        `SELECT cursor_value FROM worker_cursors WHERE name = $1`,
        name,
      );
      return rows[0]?.cursor_value ?? null;
    } catch (error) {
      this.degrade(error);
      return this.fallback.read(name);
    }
  }

  async write(name: string, value: string | null): Promise<void> {
    await this.fallback.write(name, value);
    const raw = this.raw;
    if (!raw) return;
    try {
      await raw.$executeRawUnsafe(
        `INSERT INTO worker_cursors (name, cursor_value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
        name,
        value,
      );
    } catch (error) {
      this.degrade(error);
    }
  }
}
