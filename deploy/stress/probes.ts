import { createRequire } from "node:module";
import { join } from "node:path";
import type { SshTarget } from "../lib/hostPlanner";
import type { SshRunner } from "../lib/sshRunner";

/** Identity of every managed service: if a value changes between two snapshots, that service was (re)started. */
export interface ServiceSnapshot {
  pg_start: string;
  pg_pending_restart: string;
  pg_archive_command: string;
  pgbouncer: string;
  minio: string;
  backup_daemon: string;
  nginx: string;
  redis_run_id: string;
  pg_apps: string;
}

export const BOUNCE_KEYS: Array<keyof ServiceSnapshot> = ["pg_start", "pgbouncer", "minio", "backup_daemon", "redis_run_id"];

/** Keys whose value changed between two snapshots. */
export const diffSnapshots = (before: ServiceSnapshot, after: ServiceSnapshot, keys: Array<keyof ServiceSnapshot> = BOUNCE_KEYS): string[] =>
  keys.filter((key) => before[key] !== after[key]);

export interface Target {
  pgPort: number;
  pgbouncerPort: number;
  redisPort: number;
  redisPassword: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

/** One sudo round-trip that prints `key=value` lines for every service. */
export const snapshotScript = (target: Target): string => `
psql() { runuser -u postgres -- psql -p ${target.pgPort} -d postgres -Atc "$1" 2>/dev/null; }
echo "pg_start=$(psql "select extract(epoch from pg_postmaster_start_time())::bigint")"
echo "pg_pending_restart=$(psql "select count(*) from pg_settings where pending_restart")"
echo "pg_archive_command=$(psql "show archive_command" | sha256sum | cut -c1-16)"
for unit in pgbouncer minio pg-backup-daemon nginx; do
  echo "$unit=$(systemctl show "$unit" -p MainPID --value 2>/dev/null):$(systemctl show "$unit" -p ExecMainStartTimestampMonotonic --value 2>/dev/null)"
done
echo "redis_run_id=$(REDISCLI_AUTH='${target.redisPassword.replace(/'/g, "'\\''")}' redis-cli -p ${target.redisPort} INFO server 2>/dev/null | awk -F: '/^run_id/{print $2}' | tr -d '\\r')"
`;

export const parseSnapshot = (output: string): ServiceSnapshot => {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const get = (key: string): string => map.get(key) ?? "";
  return {
    pg_start: get("pg_start"),
    pg_pending_restart: get("pg_pending_restart"),
    pg_archive_command: get("pg_archive_command"),
    pgbouncer: get("pgbouncer"),
    minio: get("minio"),
    backup_daemon: get("pg-backup-daemon"),
    nginx: get("nginx"),
    redis_run_id: get("redis_run_id"),
    pg_apps: get("pg_apps"),
  };
};

/** pg- PM2 apps and their status. PM2 belongs to the deploy user, not root, so this runs without sudo. */
export const pm2AppsScript = (): string =>
  `"$HOME/.bun/bin/pm2" jlist 2>/dev/null | "$HOME/.bun/bin/bun" -e 'const t=await Bun.stdin.text();const i=t.indexOf("[");if(i>=0)console.log(JSON.parse(t.slice(i)).filter(p=>p.name.startsWith("pg-")).map(p=>p.name+":"+p.pm2_env.status).sort().join(","))'`;

export const takeSnapshot = (runner: SshRunner, sudoTarget: SshTarget, target: Target): ServiceSnapshot => {
  const snapshot = parseSnapshot(runner.capture(sudoTarget, snapshotScript(target), { sudo: true }));
  snapshot.pg_apps = runner.capture(sudoTarget, pm2AppsScript(), { sudo: false }).trim();
  return snapshot;
};

// ---------------------------------------------------------------------------
// Outage accounting (pure, unit-tested)
// ---------------------------------------------------------------------------

export interface Sample {
  at: number;
  ok: boolean;
}

/** Contiguous failure windows (ms): from the first failed sample to the next success. */
export const outageWindows = (samples: readonly Sample[], endedAt: number): number[] => {
  const windows: number[] = [];
  let failingSince: number | null = null;
  for (const sample of samples) {
    if (!sample.ok && failingSince === null) failingSince = sample.at;
    if (sample.ok && failingSince !== null) {
      windows.push(sample.at - failingSince);
      failingSince = null;
    }
  }
  if (failingSince !== null) windows.push(endedAt - failingSince);
  return windows;
};

// ---------------------------------------------------------------------------
// Database load: long-lived client connections through PgBouncer, like core-back's pool
// ---------------------------------------------------------------------------

export interface LoadSummary {
  workers: number;
  queries: number;
  errors: number;
  /** Longest time any single worker was unable to run a query. */
  maxOutageMs: number;
  /** Workers that never recovered (still failing when the load stopped). */
  unrecovered: number;
  durationMs: number;
}

export interface LoadHandle {
  stop(): Promise<LoadSummary>;
  /** Live counters, for assertions made while the load is running. */
  snapshot(): { queries: number; errors: number };
}

/** The slice of `pg` the load generator uses (the package lives in core-back, not in deploy). */
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}
type PgClientConstructor = new (config: Record<string, unknown>) => PgClient;

const requirePg = createRequire(import.meta.url);

/**
 * Starts `workers` long-lived connections that each run a small query every
 * 50-250 ms and sit idle in between (exactly the shape that makes
 * `systemctl restart pgbouncer` hang under the default SIGTERM). Errors are
 * counted, the worker reconnects, and the time without service is recorded.
 */
export const startDbLoad = (input: { repoRoot: string; target: Target; port?: number; workers: number }): LoadHandle => {
  const pg = requirePg(join(input.repoRoot, "core-back", "node_modules", "pg")) as { Client: PgClientConstructor };
  const port = input.port ?? input.target.pgbouncerPort;
  const startedAt = Date.now();
  let queries = 0;
  let errors = 0;
  let stopping = false;
  const outages: number[] = [];
  let failingNow = 0;

  const worker = async (): Promise<void> => {
    let client: PgClient | null = null;
    let failingSince: number | null = null;
    while (!stopping) {
      try {
        if (!client) {
          client = new pg.Client({
            host: "127.0.0.1",
            port,
            user: input.target.dbUser,
            password: input.target.dbPassword,
            database: input.target.dbName,
            connectionTimeoutMillis: 2500,
            ssl: false,
          });
          client.on("error", () => undefined);
          await client.connect();
        }
        await client.query("SELECT 1");
        queries += 1;
        if (failingSince !== null) {
          outages.push(Date.now() - failingSince);
          failingSince = null;
          failingNow -= 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
      } catch {
        errors += 1;
        if (failingSince === null) {
          failingSince = Date.now();
          failingNow += 1;
        }
        try {
          await client?.end();
        } catch {
          // the connection is already gone
        }
        client = null;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (failingSince !== null) outages.push(Date.now() - failingSince);
    try {
      await client?.end();
    } catch {
      // closing a dead connection
    }
  };

  const running = Array.from({ length: input.workers }, () => worker());
  return {
    snapshot: () => ({ queries, errors }),
    stop: async () => {
      const unrecovered = failingNow;
      stopping = true;
      await Promise.all(running);
      return { workers: input.workers, queries, errors, maxOutageMs: Math.max(0, ...outages), unrecovered, durationMs: Date.now() - startedAt };
    },
  };
};

// ---------------------------------------------------------------------------
// HTTP availability: what a user of the portals sees while a deploy runs
// ---------------------------------------------------------------------------

export interface ProbeSummary {
  url: string;
  requests: number;
  failures: number;
  maxOutageMs: number;
}

export interface ProbeHandle {
  stop(): Promise<ProbeSummary[]>;
}

/** A 502/503/504 or a connection error means the backend behind the vhost is down. */
export const isDown = (status: number | null): boolean => status === null || status === 502 || status === 503 || status === 504;

export const startAvailabilityProbe = (urls: string[], intervalMs = 100): ProbeHandle => {
  let stopping = false;
  const state = urls.map((url) => ({ url, samples: [] as Sample[], requests: 0 }));
  const loops = state.map(async (entry) => {
    while (!stopping) {
      let status: number | null = null;
      try {
        const response = await fetch(entry.url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
        status = response.status;
        await response.arrayBuffer();
      } catch {
        status = null;
      }
      entry.requests += 1;
      entry.samples.push({ at: Date.now(), ok: !isDown(status) });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  });
  return {
    stop: async () => {
      stopping = true;
      await Promise.all(loops);
      const endedAt = Date.now();
      return state.map((entry) => {
        const windows = outageWindows(entry.samples, endedAt);
        return {
          url: entry.url,
          requests: entry.requests,
          failures: entry.samples.filter((sample) => !sample.ok).length,
          maxOutageMs: Math.max(0, ...windows),
        };
      });
    },
  };
};
