import { Client } from "pg";

/**
 * Advisory-lock leader election for singleton workers (GAP-012).
 *
 * A session-level `pg_try_advisory_lock` is held on ONE dedicated connection
 * (never a pooled one: a pooled connection is recycled and the lock would
 * silently stay with whichever request borrows it next). If the process dies
 * or the connection drops, PostgreSQL releases the lock and another node's
 * next `tryAcquire` wins, which is the failover. When the connection is lost
 * this instance forgets the keys it held, so it stops acting as leader at the
 * next tick (the lock is only trusted after a liveness probe).
 *
 * Not usable through a transaction-pooling proxy (pgbouncer in transaction
 * mode): point `connectionString` at PostgreSQL or a session-pooled endpoint.
 */
export interface LeaderElectionPort {
  /** True while this process is the leader for `key` (acquires it if free). */
  tryAcquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
  /** Keys this process currently believes it leads. */
  held(): string[];
  close(): Promise<void>;
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

export class PgAdvisoryLeaderElection implements LeaderElectionPort {
  private readonly namespace: string;
  private readonly factory: () => PgClientLike;
  private client: PgClientLike | null = null;
  private connecting: Promise<PgClientLike> | null = null;
  private readonly leading = new Set<string>();

  constructor(options: PgAdvisoryLeaderElectionOptions) {
    this.namespace = options.namespace ?? "pgw";
    if (options.clientFactory) {
      this.factory = options.clientFactory;
    } else {
      const connectionString = options.connectionString;
      if (!connectionString) {
        throw new Error("PgAdvisoryLeaderElection needs a connectionString or a clientFactory");
      }
      this.factory = () =>
        new Client({
          connectionString,
          application_name: "pg-core-back-leader",
        }) as unknown as PgClientLike;
    }
  }

  private lockName(key: string): string {
    return `${this.namespace}:${key}`;
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
            this.leading.clear();
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
    if (client) {
      await Promise.resolve(client.end()).catch(() => undefined);
    }
  }

  async tryAcquire(key: string): Promise<boolean> {
    const client = await this.ensureClient();
    try {
      if (this.leading.has(key)) {
        // Liveness probe: a dead connection means the lock is already gone.
        await client.query("SELECT 1");
        return true;
      }
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [this.lockName(key)],
      );
      if (result.rows[0]?.locked === true) {
        this.leading.add(key);
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
      await this.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [this.lockName(key)]);
      this.leading.delete(key);
    } catch (error) {
      await this.drop();
      throw error;
    }
  }

  held(): string[] {
    return [...this.leading];
  }

  async close(): Promise<void> {
    await this.drop();
  }
}
