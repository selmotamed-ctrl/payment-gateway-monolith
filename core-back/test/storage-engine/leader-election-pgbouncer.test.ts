/**
 * Live regression for the PgBouncer leader-election bug.
 *
 * Session advisory locks live on a PostgreSQL backend session. PgBouncer in
 * `transaction` mode recycles the backend between transactions, so two core
 * nodes can acquire the same key (reentrant on one backend), lose the lock
 * silently, or fail to release it. `session` mode is the supported endpoint.
 *
 * The test starts a throwaway PgBouncer with both aliases against the test
 * database and is skipped when PostgreSQL or the pgbouncer binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  LeaderElectionEndpointUnsafeError,
  PgAdvisoryLeaderElection,
} from "../../lib/storageEngine/leaderElection";

const DATABASE_URL =
  process.env.STORAGE_TEST_DATABASE_URL ??
  process.env.POSTGRES_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

const PGBOUNCER_BIN = process.env.PGBOUNCER_BIN ?? "pgbouncer";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const parseDatabaseUrl = (value: string) => {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || "5432"),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
};

const waitForPort = async (port: number, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = new Client({
        host: "127.0.0.1",
        port,
        database: "pgw_session",
        user: "pgbouncer_probe",
        password: "",
        connectionTimeoutMillis: 500,
      });
      void socket
        .connect()
        .then(() => socket.end())
        .then(() => resolve(true))
        .catch(() => {
          void socket.end().catch(() => undefined);
          resolve(false);
        });
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

const probeDatabase = async (): Promise<boolean> => {
  if (!DATABASE_URL) return false;
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_500 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
};

let pgbouncer: ChildProcess | null = null;
let directory = "";
let pgbouncerPort = 0;
let databaseAvailable = false;

const connection = (database: string): string =>
  `postgresql://${encodeURIComponent(parseDatabaseUrl(DATABASE_URL!).user)}:${encodeURIComponent(parseDatabaseUrl(DATABASE_URL!).password)}@127.0.0.1:${pgbouncerPort}/${database}`;

const waitForExit = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
};

describe.skipIf(!DATABASE_URL)("leader election through a real PgBouncer", () => {
  beforeAll(async () => {
    databaseAvailable = await probeDatabase();
    if (!databaseAvailable) return;
    if (typeof Bun !== "undefined" && !Bun.which(PGBOUNCER_BIN)) return;

    directory = mkdtempSync(join(tmpdir(), "pgw-pgbouncer-"));
    pgbouncerPort = await freePort();
    const database = parseDatabaseUrl(DATABASE_URL!);
    const password = database.password ? ` password='${database.password.replace(/'/g, "\\'")}'` : "";
    const server = `host=${database.host} port=${database.port} dbname=${database.database} user=${database.user}${password}`;
    writeFileSync(
      join(directory, "pgbouncer.ini"),
      [
        "[databases]",
        `pgw_txn = ${server} pool_mode=transaction pool_size=1`,
        `pgw_session = ${server} pool_mode=session pool_size=4`,
        "",
        "[pgbouncer]",
        "listen_addr = 127.0.0.1",
        `listen_port = ${pgbouncerPort}`,
        `unix_socket_dir = ${directory}`,
        `pidfile = ${join(directory, "pgbouncer.pid")}`,
        `logfile = ${join(directory, "pgbouncer.log")}`,
        "auth_type = trust",
        "server_reset_query_always = 0",
        "",
      ].join("\n"),
      "utf8",
    );
    pgbouncer = spawn(PGBOUNCER_BIN, [join(directory, "pgbouncer.ini")], {
      stdio: "ignore",
    });
    const ready = await waitForPort(pgbouncerPort);
    if (!ready) {
      await waitForExit(pgbouncer);
      pgbouncer = null;
    }
  }, 30_000);

  afterAll(async () => {
    if (pgbouncer) {
      pgbouncer.kill("SIGINT");
      await waitForExit(pgbouncer);
    }
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const runnable = (): boolean => pgbouncer !== null;

  test("transaction pooling lets two clients hold the same advisory lock", async () => {
    if (!runnable()) return;
    const first = new PgAdvisoryLeaderElection({ connectionString: connection("pgw_txn") });
    const second = new PgAdvisoryLeaderElection({ connectionString: connection("pgw_txn") });
    try {
      expect(await first.tryAcquire("shared")).toBe(true);
      expect(await second.tryAcquire("shared")).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  }, 20_000);

  test("the session alias gives exactly one leader and fails over when its backend dies", async () => {
    if (!runnable()) return;
    const first = new PgAdvisoryLeaderElection({ connectionString: connection("pgw_session") });
    const second = new PgAdvisoryLeaderElection({ connectionString: connection("pgw_session") });
    try {
      expect(await first.tryAcquire("single")).toBe(true);
      expect(await second.tryAcquire("single")).toBe(false);

      const pid = first.status().backendPid;
      expect(pid).not.toBeNull();
      const killer = new Client({ connectionString: DATABASE_URL });
      await killer.connect();
      await killer.query("SELECT pg_terminate_backend($1)", [pid!]);
      await killer.end();

      // The old leader must stop; the follower may now acquire.
      let oldLeaderStillLeads = false;
      try {
        oldLeaderStillLeads = await first.tryAcquire("single");
      } catch {
        oldLeaderStillLeads = false;
      }
      expect(oldLeaderStillLeads).toBe(false);
      expect(first.held()).toEqual([]);
      expect(await second.tryAcquire("single")).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  }, 20_000);

  test("the boot probe rejects transaction pooling and accepts the session alias", async () => {
    if (!runnable()) return;
    const pooled = new PgAdvisoryLeaderElection({ connectionString: connection("pgw_txn") });
    await expect(pooled.verifySessionSafety()).rejects.toBeInstanceOf(LeaderElectionEndpointUnsafeError);
    await pooled.close();

    const session = new PgAdvisoryLeaderElection({ connectionString: connection("pgw_session") });
    const status = await session.verifySessionSafety();
    expect(status.probeOk).toBe(true);
    expect(status.backendPid).not.toBeNull();
    await session.close();
  }, 20_000);
});
