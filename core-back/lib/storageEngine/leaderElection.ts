import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * Advisory-lock leader election for singleton workers (GAP-012).
 *
 * A session-level `pg_try_advisory_lock` is held on ONE dedicated connection.
 * PostgreSQL attaches the lock to the BACKEND session, so the connector must
 * preserve session state: a direct PostgreSQL connection or a PgBouncer
 * database configured with `pool_mode=session`. Transaction pooling assigns a
 * different backend per transaction, which makes the lock meaningless: it can
 * be re-acquired reentrantly by a different node that later receives the same
 * backend, silently disappear when PgBouncer recycles the backend, or fail to
 * release.
 *
 * The class therefore verifies the endpoint (`verifySessionSafety`, called at
 * boot) and proves ownership on every liveness probe (backend PID + a
 * `pg_locks` row for the key). Any doubt drops the connection and clears the
 * held keys, so a singleton worker fails closed instead of double-running.
 */
export interface LeaderElectionEndpoint {
  host: string;
  port: number;
  database: string;
}

export interface LeaderElectionStatus {
  /** Sanitised endpoint identity (never the URL or credentials). */
  endpoint: LeaderElectionEndpoint | null;
  /** Keys this process currently believes it leads. */
  held: string[];
  /** Keys the runtime expects one leader for (singleton workers). */
  expected: string[];
  backendPid: number | null;
  lastProbeAt: string | null;
  lostCount: number;
  /** Result of the startup session-safety probe; null when it has not run. */
  probeOk: boolean | null;
}

export interface LeaderElectionPort {
  /** True while this process is the leader for `key` (acquires it if free). */
  tryAcquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
  /** Keys this process currently believes it leads. */
  held(): string[];
  close(): Promise<void>;
  /**
   * Proves that the endpoint preserves a session-scoped lock. Throws
   * `LeaderElectionEndpointUnsafeError` when it does not (transaction pooling).
   */
  verifySessionSafety?(): Promise<LeaderElectionStatus>;
  status?(): LeaderElectionStatus;
  /** Singleton keys health/deploy probes expect one leader for. */
  setExpected?(keys: readonly string[]): void;
}

export class LeaderElectionEndpointUnsafeError extends Error {
  readonly code = "LEADER_ELECTION_ENDPOINT_UNSAFE";

  constructor(message: string) {
    super(message);
    this.name = "LeaderElectionEndpointUnsafeError";
  }
}

export interface PgClientLike {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
  on(event: "error" | "end", listener: (error?: Error) => void): unknown;
}

export interface PgAdvisoryLeaderElectionOptions {
  connectionString?: string;
  /** Prefix that keeps the lock keys of several deployments sharing a database apart. */
  namespace?: string;
  clientFactory?: () => PgClientLike;
}

const ACQUIRE_SQL =
  "SELECT pg_backend_pid() AS pid, pg_try_advisory_lock(hashtextextended($1, 0)) AS locked";

/**
 * Proves that THIS backend (not merely the client connection) still holds the
 * advisory lock for `$1`. `pg_backend_pid()` is fixed for a real/session-pooled
 * connection; a change means the endpoint multiplexes backends.
 */
const OWNERSHIP_SQL =
  "SELECT pg_backend_pid() AS pid," +
  " pg_backend_pid() = $2::int AS same_session," +
  " EXISTS (" +
  "   SELECT 1 FROM pg_locks" +
  "   WHERE locktype = 'advisory'" +
  "     AND pid = pg_backend_pid()" +
  "     AND granted" +
  "     AND objsubid = 1" +
  "     AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)" +
  "     AND objid::bigint = (hashtextextended($1, 0) & 4294967295)" +
  " ) AS holds_lock";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const parseEndpoint = (connectionString: string): LeaderElectionEndpoint | null => {
  try {
    const url = new URL(connectionString);
    if (!url.hostname) {
      return null;
    }
    return {
      host: url.hostname,
      port: Number(url.port || "5432"),
      database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    };
  } catch {
    return null;
  }
};

export class PgAdvisoryLeaderElection implements LeaderElectionPort {
  private readonly namespace: string;
  private readonly factory: () => PgClientLike;
  private readonly endpoint: LeaderElectionEndpoint | null;
  private client: PgClientLike | null = null;
  private connecting: Promise<PgClientLike> | null = null;
  private readonly leading = new Set<string>();
  private expectedKeys: string[] = [];
  private backendPid: number | null = null;
  private lastProbeAtMs: number | null = null;
  private lostCount = 0;
  private probeOk: boolean | null = null;

  constructor(options: PgAdvisoryLeaderElectionOptions) {
    this.namespace = options.namespace ?? "pgw";
    if (options.clientFactory) {
      this.factory = options.clientFactory;
      this.endpoint = options.connectionString ? parseEndpoint(options.connectionString) : null;
    } else {
      const connectionString = options.connectionString;
      if (!connectionString) {
        throw new Error("PgAdvisoryLeaderElection needs a connectionString or a clientFactory");
      }
      this.endpoint = parseEndpoint(connectionString);
      this.factory = () =>
        new Client({
          connectionString,
          application_name: "pg-core-back-leader",
          // A stuck pooler must fail the tick, not hang the worker loop.
          connectionTimeoutMillis: 5_000,
          query_timeout: 5_000,
          keepAlive: true,
        }) as unknown as PgClientLike;
    }
  }

  private lockName(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private markLost(): void {
    this.lostCount += 1;
    this.backendPid = null;
    this.probeOk = false;
    this.leading.clear();
  }

  private async ensureClient(): Promise<PgClientLike> {
    if (this.client) {
      return this.client;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.factory();
        // A dropped connection releases every advisory lock server side.
        const lost = (): void => {
          if (this.client === client) {
            this.client = null;
            this.markLost();
          }
        };
        client.on("error", lost);
        client.on("end", lost);
        try {
          await client.connect();
        } catch (error) {
          await Promise.resolve(client.end()).catch(() => undefined);
          throw error;
        }
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async drop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.leading.clear();
    this.backendPid = null;
    if (client) {
      await Promise.resolve(client.end()).catch(() => undefined);
    }
  }

  async tryAcquire(key: string): Promise<boolean> {
    const client = await this.ensureClient();
    try {
      if (this.leading.has(key)) {
        if (this.backendPid === null) {
          this.markLost();
          await this.drop();
          return false;
        }
        // Ownership probe: the same backend must still hold the lock. A
        // liveness-only probe is not enough through a transaction pooler.
        const probe = await client.query(OWNERSHIP_SQL, [this.lockName(key), this.backendPid]);
        this.lastProbeAtMs = Date.now();
        const row = probe.rows[0] ?? {};
        if (row.same_session !== true || row.holds_lock !== true) {
          this.markLost();
          await this.drop();
          return false;
        }
        this.probeOk = true;
        return true;
      }
      const result = await client.query(ACQUIRE_SQL, [this.lockName(key)]);
      this.lastProbeAtMs = Date.now();
      const row = result.rows[0] ?? {};
      if (row.locked === true) {
        const pid = Number(row.pid);
        if (!Number.isFinite(pid)) {
          this.markLost();
          await this.drop();
          throw new LeaderElectionEndpointUnsafeError(
            "The leader-election backend did not report a backend PID; the endpoint cannot prove lock ownership",
          );
        }
        this.backendPid = pid;
        this.leading.add(key);
        this.probeOk = true;
        return true;
      }
      return false;
    } catch (error) {
      await this.drop();
      throw error;
    }
  }

  async release(key: string): Promise<void> {
    if (!this.leading.has(key) || !this.client) {
      this.leading.delete(key);
      return;
    }
    try {
      const result = await this.client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
        [this.lockName(key)],
      );
      this.leading.delete(key);
      if (result.rows[0]?.released !== true) {
        // The unlock reached a backend that does not own the lock. The
        // endpoint is not session-stable; stop trusting it.
        this.markLost();
        await this.drop();
      }
    } catch (error) {
      await this.drop();
      throw error;
    }
  }

  /**
   * Boot-time proof that the endpoint preserves session state.
   *
   * 1. Acquire a probe key and read the backend PID.
   * 2. A second connection must NOT be able to acquire the same key. Through
   *    transaction pooling (especially a single-backend pool) it can, because
   *    `pg_try_advisory_lock` is reentrant on the same backend.
   * 3. The backend PID must stay stable while the second client generates
   *    traffic, and the unlock must succeed on the same session.
   *
   * Any positive evidence of multiplexing throws. A second connection that
   * cannot be served in time is treated as inconclusive (pool starvation) and
   * logged, because the per-tick ownership probe still guards the workers.
   */
  async verifySessionSafety(): Promise<LeaderElectionStatus> {
    const probeKey = this.lockName(`probe:${randomUUID()}`);
    const main = await this.ensureClient();
    const acquired = await main.query(ACQUIRE_SQL, [probeKey]);
    const pid = Number(acquired.rows[0]?.pid);
    if (acquired.rows[0]?.locked !== true || !Number.isFinite(pid)) {
      this.probeOk = false;
      await this.drop();
      throw new LeaderElectionEndpointUnsafeError(
        "The leader-election endpoint refused the advisory-lock probe",
      );
    }

    let second: PgClientLike | null = null;
    let secondConnected = false;
    try {
      try {
        second = this.factory();
        await second.connect();
        secondConnected = true;
        const competing = await second.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [probeKey],
        );
        if (competing.rows[0]?.locked === true) {
          // Two clients on one backend can hold the "same" reentrant lock.
          await second
            .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [probeKey])
            .catch(() => undefined);
          this.probeOk = false;
          await this.drop();
          throw new LeaderElectionEndpointUnsafeError(
            "Two leader-election clients acquired the same advisory lock from one backend; " +
              "this endpoint is transaction-pooled or shared. Point LEADER_ELECTION_DATABASE_URL at " +
              "a session-pooled PgBouncer database or PostgreSQL directly.",
          );
        }
      } catch (error) {
        if (error instanceof LeaderElectionEndpointUnsafeError) {
          throw error;
        }
        console.warn(
          "Leader-election session probe could not open a second connection; relying on per-tick ownership checks",
          { error: (error as Error).message },
        );
      }

      // Keep the second connection busy so a transaction pool has a reason to
      // move the main connection to another backend between statements.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const checks: Array<Promise<{ rows: Array<Record<string, unknown>> }>> = [
          main.query("SELECT pg_backend_pid() AS pid"),
        ];
        if (secondConnected && second) {
          checks.push(
            second.query("SELECT 1").catch(() => ({ rows: [] })) as Promise<{
              rows: Array<Record<string, unknown>>;
            }>,
          );
        }
        const check = (await Promise.all(checks))[0]!;
        if (Number(check.rows[0]?.pid) !== pid) {
          this.probeOk = false;
          await this.drop();
          throw new LeaderElectionEndpointUnsafeError(
            "The leader-election backend changed between statements; the endpoint does not preserve " +
              "a session. Point LEADER_ELECTION_DATABASE_URL at a session-pooled endpoint.",
          );
        }
        await sleep(10);
      }
      const unlocked = await main.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
        [probeKey],
      );
      if (unlocked.rows[0]?.released !== true) {
        this.probeOk = false;
        await this.drop();
        throw new LeaderElectionEndpointUnsafeError(
          "The leader-election unlock reached a different backend; the endpoint does not preserve a session",
        );
      }
      this.probeOk = true;
      this.backendPid = pid;
      this.lastProbeAtMs = Date.now();
      return this.status();
    } catch (error) {
      this.probeOk = false;
      await this.drop();
      throw error;
    } finally {
      await Promise.resolve(second?.end()).catch(() => undefined);
    }
  }

  held(): string[] {
    return [...this.leading];
  }

  setExpected(keys: readonly string[]): void {
    this.expectedKeys = [...keys];
  }

  status(): LeaderElectionStatus {
    return {
      endpoint: this.endpoint,
      held: [...this.leading],
      expected: [...this.expectedKeys],
      backendPid: this.backendPid,
      lastProbeAt: this.lastProbeAtMs === null ? null : new Date(this.lastProbeAtMs).toISOString(),
      lostCount: this.lostCount,
      probeOk: this.probeOk,
    };
  }

  async close(): Promise<void> {
    await this.drop();
  }
}
