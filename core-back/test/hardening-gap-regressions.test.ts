import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CheckpointService, ShardParityError, checkShardParity } from "../engine/ledger/CheckpointService";
import { ExpirySweeperWorker } from "../engine/workers/ExpirySweeperWorker";
import { InboundInboxWorker } from "../engine/workers/InboundInboxWorker";
import { OutboxNotificationWorker } from "../engine/workers/OutboxNotificationWorker";
import { PollWorker } from "../engine/workers/PollWorker";
import { LedgerInvariantWorker } from "../engine/workers/LedgerInvariantWorker";
import { RetentionWorker } from "../engine/workers/RetentionWorker";
import type { WorkerLeaderElection } from "../engine/workers/workerRuntime";
import type { PrismaLike } from "../engine/db/ports";
import { emptyRepositories } from "./helpers/fakeRepositories";
import { createRetentionFake } from "./helpers/retentionFake";
import { PgAdvisoryLeaderElection, type PgClientLike } from "../lib/storageEngine/leaderElection";
import { pinUtcInConnectionUrl } from "../lib/storageEngine/utcSession";

/* -------------------------------------------------------------------------- */
/* GAP-011 checkpoint                                                          */
/* -------------------------------------------------------------------------- */

interface Trace {
  events: string[];
  updates: Array<Record<string, unknown>>;
}

const checkpointClient = (options: {
  shardTotal?: string;
  journalTotal?: string;
  dbNow?: Date;
  inTransaction?: { value: boolean };
}) => {
  const trace: Trace = { events: [], updates: [] };
  const state = { inTx: false };
  const make = (): Record<string, unknown> => ({
    glAccount: {
      findUnique: async () => ({ id: "acc-1", accountType: "TREASURY", checkpointBalance: 0, checkpointAt: null }),
      findMany: async () => [],
      update: async (args: { data: Record<string, unknown> }) => {
        trace.events.push(`update:${state.inTx ? "tx" : "outside"}`);
        trace.updates.push(args.data);
        return {};
      },
    },
    journalLine: { findMany: async () => [] },
    $queryRawUnsafe: async (sql: string) => {
      trace.events.push(`sql:${state.inTx ? "tx" : "outside"}:${sql.slice(0, 40)}`);
      if (sql.includes("FOR UPDATE")) return [{ id: "acc-1", accountType: "TREASURY" }];
      if (sql.includes("clock_timestamp")) return [{ now: options.dbNow ?? new Date("2030-01-01T00:00:00.000Z") }];
      if (sql.includes("gl_account_shards")) {
        if (options.shardTotal === undefined) return [];
        return [{ id: "acc-1", shardTotal: options.shardTotal, journalTotal: options.journalTotal ?? "0" }];
      }
      return [];
    },
  });
  const client = {
    ...make(),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.inTx = true;
      trace.events.push("begin");
      try {
        const result = await fn(make());
        trace.events.push("commit");
        return result;
      } catch (error) {
        trace.events.push("rollback");
        throw error;
      } finally {
        state.inTx = false;
      }
    },
  };
  return { client: client as never, trace };
};

describe("GAP-011 CheckpointService", () => {
  test("lock, parity read and write run inside one transaction", async () => {
    const { client, trace } = checkpointClient({});
    await new CheckpointService(client).captureCheckpoint("acc-1");
    expect(trace.events[0]).toBe("begin");
    expect(trace.events.at(-1)).toBe("commit");
    expect(trace.events.filter((event) => event.endsWith(":outside") || event.startsWith("update:outside"))).toEqual([]);
    expect(trace.events.some((event) => event.startsWith("update:tx"))).toBe(true);
  });

  test("the default asOf is the database clock, not the application clock", async () => {
    const dbNow = new Date("2031-05-05T05:05:05.000Z");
    const { client, trace } = checkpointClient({ dbNow });
    const before = Date.now();
    const record = await new CheckpointService(client).captureCheckpoint("acc-1");
    expect(record.asOf.toISOString()).toBe(dbNow.toISOString());
    expect(record.asOf.getTime()).toBeGreaterThan(before + 1000 * 60 * 60 * 24 * 365);
    expect(trace.updates[0]?.checkpointAt).toEqual(dbNow);
  });

  test("an explicit asOf is honoured", async () => {
    const { client } = checkpointClient({});
    const asOf = new Date("2025-01-01T00:00:00.000Z");
    const record = await new CheckpointService(client).captureCheckpoint("acc-1", asOf);
    expect(record.asOf).toEqual(asOf);
  });

  test("a shard-vs-journal mismatch refuses the checkpoint and rolls back", async () => {
    const { client, trace } = checkpointClient({ shardTotal: "100.0000", journalTotal: "90.0000" });
    const error = await new CheckpointService(client).captureCheckpoint("acc-1").catch((e) => e);
    expect(error).toBeInstanceOf(ShardParityError);
    expect((error as ShardParityError).mismatch.drift.toFixed(4)).toBe("10.0000");
    expect(trace.updates).toEqual([]);
    expect(trace.events.at(-1)).toBe("rollback");
  });

  test("warn mode captures but reports the mismatch", async () => {
    const { client, trace } = checkpointClient({ shardTotal: "5", journalTotal: "4" });
    const seen: string[] = [];
    await new CheckpointService(client, {
      parity: "warn",
      onParityMismatch: (mismatch) => seen.push(mismatch.accountId),
    }).captureCheckpoint("acc-1");
    expect(seen).toEqual(["acc-1"]);
    expect(trace.updates).toHaveLength(1);
  });

  test("matching totals and accounts without shards pass", async () => {
    const equal = checkpointClient({ shardTotal: "10.0000", journalTotal: "10" });
    await new CheckpointService(equal.client).captureCheckpoint("acc-1");
    expect(equal.trace.updates).toHaveLength(1);
    const none = checkpointClient({});
    expect((await new CheckpointService(none.client).verifyShardParity()).checked).toBe(0);
  });

  test("checkShardParity reports every drifting account", async () => {
    const result = await checkShardParity({
      $queryRawUnsafe: async () => [
        { id: "a", shardTotal: "1", journalTotal: "1" },
        { id: "b", shardTotal: "2", journalTotal: "3" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.mismatches.map((m) => m.accountId)).toEqual(["b"]);
  });
});

/* -------------------------------------------------------------------------- */
/* GAP-012 worker claims and leader election                                   */
/* -------------------------------------------------------------------------- */

const claimDb = () => {
  const calls: Array<{ sql: string; inTx: boolean; args: unknown[] }> = [];
  const state = { inTx: false };
  const db: Record<string, unknown> = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, inTx: state.inTx, args });
      return [];
    },
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    state.inTx = true;
    try {
      return await fn(db);
    } finally {
      state.inTx = false;
    }
  };
  return { db: db as unknown as PrismaLike, calls };
};

describe("GAP-012 SKIP LOCKED claims run inside a transaction", () => {
  const cases: Array<[string, (db: PrismaLike) => { runOnce(): Promise<void> }, string]> = [
    ["PollWorker", (db) => new PollWorker({ db, repositories: emptyRepositories() }), "FROM payment_attempts"],
    ["ExpirySweeperWorker", (db) => new ExpirySweeperWorker({ db, repositories: emptyRepositories() }), "FROM payment_attempts"],
    [
      "InboundInboxWorker",
      (db) =>
        new InboundInboxWorker({
          db,
          repositories: emptyRepositories(),
          handler: { handle: async () => ({ processed: true }) },
        }),
      "FROM inbound_events",
    ],
    ["OutboxNotificationWorker", (db) => new OutboxNotificationWorker({ db, repositories: emptyRepositories() }), "FROM notifications"],
  ];
  for (const [name, build, table] of cases) {
    test(`${name} claims in a transaction`, async () => {
      const { db, calls } = claimDb();
      await build(db).runOnce();
      const claim = calls.find((call) => call.sql.includes(table) && call.sql.includes("FOR UPDATE SKIP LOCKED"));
      expect(claim).toBeDefined();
      expect(claim?.inTx).toBe(true);
    });
  }

  test("PollWorker and OutboxNotificationWorker lease the claimed rows before the lock is released", async () => {
    const poll = claimDb();
    await new PollWorker({ db: poll.db, repositories: emptyRepositories(), claimLeaseSeconds: 90, clock: () => new Date(0) }).runOnce();
    const pollClaim = poll.calls.find((call) => call.sql.includes("SKIP LOCKED"));
    expect(pollClaim?.sql).toMatch(/UPDATE payment_attempts p SET next_check_at = \$\d+/);
    expect(pollClaim?.args.at(-1)).toEqual(new Date(90_000));

    const outbox = claimDb();
    await new OutboxNotificationWorker({ db: outbox.db, repositories: emptyRepositories(), claimLeaseSeconds: 30, clock: () => new Date(0) }).runOnce();
    const outboxClaim = outbox.calls.find((call) => call.sql.includes("SKIP LOCKED"));
    expect(outboxClaim?.sql).toContain("UPDATE notifications n SET next_attempt_at = $3");
    expect(outboxClaim?.args.at(-1)).toEqual(new Date(30_000));
  });
});

const electionFake = (leader: boolean | Error): WorkerLeaderElection & { keys: string[] } => {
  const keys: string[] = [];
  return {
    keys,
    tryAcquire: async (key: string) => {
      keys.push(key);
      if (leader instanceof Error) throw leader;
      return leader;
    },
  };
};

describe("GAP-012 singleton workers need the advisory-lock leader", () => {
  const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

  test("a non-leader never ticks; the leader does", async () => {
    const follower = claimDb();
    const election = electionFake(false);
    await new ExpirySweeperWorker({
      db: follower.db,
      repositories: emptyRepositories(),
      leaderElection: election,
    }).runOnce();
    expect(election.keys).toEqual(["worker:ExpirySweeperWorker"]);
    expect(follower.calls).toEqual([]);

    const leader = claimDb();
    await new ExpirySweeperWorker({
      db: leader.db,
      repositories: emptyRepositories(),
      leaderElection: electionFake(true),
    }).runOnce();
    expect(leader.calls.length).toBeGreaterThan(0);
  });

  test("an election failure fails closed", async () => {
    const { db, calls } = claimDb();
    await new InboundInboxWorker({
      db,
      repositories: emptyRepositories(),
      handler: { handle: async () => ({ processed: true }) },
      leaderElection: electionFake(new Error("db down")),
      logger: quietLogger,
    }).runOnce();
    expect(calls).toEqual([]);
  });

  test("non-singleton workers ignore the election", async () => {
    const { db, calls } = claimDb();
    const election = electionFake(false);
    await new OutboxNotificationWorker({ db, repositories: emptyRepositories(), leaderElection: election }).runOnce();
    expect(election.keys).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("the cluster singletons are marked as such", () => {
    const election = electionFake(false);
    const repositories = emptyRepositories();
    const { db } = claimDb();
    const keys = [
      new ExpirySweeperWorker({ db, repositories, leaderElection: election }),
      new LedgerInvariantWorker({ db, repositories, leaderElection: election } as never),
      new RetentionWorker({ db, repositories, leaderElection: election } as never),
    ];
    return Promise.all(keys.map((worker) => worker.runOnce().catch(() => undefined))).then(() => {
      expect(election.keys.sort()).toEqual([
        "worker:ExpirySweeperWorker",
        "worker:LedgerInvariantWorker",
        "worker:RetentionWorker",
      ]);
    });
  });
});

const fakePgClient = (script: { lockResult?: boolean; failOn?: string }) => {
  const queries: string[] = [];
  const handlers: Record<string, ((error?: Error) => void)[]> = {};
  const client: PgClientLike & { queries: string[]; emit(event: string): void; ended: boolean } = {
    queries,
    ended: false,
    connect: async () => undefined,
    query: async (sql: string) => {
      queries.push(sql);
      if (script.failOn && sql.includes(script.failOn)) throw new Error("connection terminated");
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: script.lockResult ?? true }] };
      return { rows: [] };
    },
    end: async () => {
      client.ended = true;
    },
    on: (event: string, listener: (error?: Error) => void) => {
      (handlers[event] ??= []).push(listener);
    },
    emit: (event: string) => {
      for (const listener of handlers[event] ?? []) listener(new Error(event));
    },
  };
  return client;
};

describe("GAP-012 PgAdvisoryLeaderElection", () => {
  test("acquires once, then probes liveness instead of re-locking", async () => {
    const client = fakePgClient({});
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => client });
    expect(await election.tryAcquire("w")).toBe(true);
    expect(await election.tryAcquire("w")).toBe(true);
    expect(client.queries.filter((q) => q.includes("pg_try_advisory_lock"))).toHaveLength(1);
    expect(election.held()).toEqual(["w"]);
  });

  test("a follower is told it is not the leader", async () => {
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => fakePgClient({ lockResult: false }) });
    expect(await election.tryAcquire("w")).toBe(false);
    expect(election.held()).toEqual([]);
  });

  test("a lost connection drops leadership and reconnects", async () => {
    const clients: Array<ReturnType<typeof fakePgClient>> = [];
    const election = new PgAdvisoryLeaderElection({
      clientFactory: () => {
        const client = fakePgClient({});
        clients.push(client);
        return client;
      },
    });
    await election.tryAcquire("w");
    clients[0]?.emit("error");
    expect(election.held()).toEqual([]);
    expect(await election.tryAcquire("w")).toBe(true);
    expect(clients).toHaveLength(2);
  });

  test("a failing liveness probe throws and forgets the lock", async () => {
    const client = fakePgClient({});
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => client });
    await election.tryAcquire("w");
    const failing = fakePgClient({ failOn: "SELECT 1" });
    (election as unknown as { client: unknown }).client = failing;
    await expect(election.tryAcquire("w")).rejects.toThrow("connection terminated");
    expect(election.held()).toEqual([]);
  });

  test("release unlocks and close ends the session", async () => {
    const client = fakePgClient({});
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => client });
    await election.tryAcquire("w");
    await election.release("w");
    expect(client.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    await election.close();
    expect(client.ended).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* GAP-013 append-only migration and retention bypass                          */
/* -------------------------------------------------------------------------- */

describe("GAP-013 append-only guards", () => {
  const migrationsDir = path.join(import.meta.dir, "..", "prisma", "migrations");
  const dir = readdirSync(migrationsDir).find((name) => name.endsWith("_append_only_ledger_guards"));
  const sql = dir ? readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8") : "";

  test("the migration exists and is ordered after the storage hardening migration", () => {
    expect(dir).toBeDefined();
    expect(dir! > "20261104120000_mfa_challenges").toBe(true);
  });

  test("UPDATE, DELETE and TRUNCATE are rejected on the three tables", () => {
    for (const table of ["journal_entries", "journal_lines", "audit_log"]) {
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"\\s+FOR EACH ROW`));
      if (table !== "journal_lines") {
        expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"\\s+FOR EACH STATEMENT`));
      }
    }
  });

  test("journal_lines partitions get their own TRUNCATE guard", () => {
    expect(sql).toContain("pg_inherits WHERE inhparent = 'journal_lines'::regclass");
    expect(sql).toContain("pgw_journal_lines_no_truncate");
  });

  test("the maintenance bypass needs a superuser or the maintenance role, never just the GUC", () => {
    expect(sql).toContain("r.rolsuper");
    expect(sql).toContain("pg_has_role(session_user, m.oid, 'MEMBER')");
  });

  test("the retention bypass is DELETE-only and audit_log-only", () => {
    const auditFn = sql.slice(sql.indexOf("pgw_reject_audit_log_mutation() RETURNS trigger"));
    expect(auditFn).toContain("TG_OP = 'DELETE' AND COALESCE(current_setting('pgw.audit_retention'");
    const ledgerFn = sql.slice(
      sql.indexOf("pgw_reject_ledger_mutation() RETURNS trigger"),
      sql.indexOf("pgw_reject_ledger_truncate() RETURNS trigger"),
    );
    expect(ledgerFn).not.toContain("audit_retention");
  });

  test("the non-owner application role loses UPDATE/DELETE/TRUNCATE on the journal", () => {
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, journal_lines FROM pgw_app");
    expect(sql).toContain("REVOKE UPDATE, TRUNCATE ON audit_log FROM pgw_app");
  });

  test("the retention purge declares itself for audit_log only, inside the batch transaction", async () => {
    const fake = createRetentionFake();
    const old = new Date(Date.now() - 4000 * 24 * 3600 * 1000);
    fake.seed("audit_log", [{ id: "audit-old", created_at: old }]);
    fake.seed("detail_change_logs", [{ id: "detail-old", created_at: old }]);
    const worker = new RetentionWorker({
      db: fake.db,
      repositories: emptyRepositories(),
      retentionDays: 365,
      dryRun: false,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never);
    await worker.runOnce();
    expect(fake.rows("audit_log")).toEqual([]);
    expect(fake.setConfigCalls).toHaveLength(1);
    expect(String(fake.setConfigCalls[0]?.[0])).toContain("pgw.audit_retention");
    // transaction-local flag (third argument true), never a session setting
    expect(String(fake.setConfigCalls[0]?.[0])).toContain("'on', true");
  });
});

/* -------------------------------------------------------------------------- */
/* GAP-030 timezone                                                            */
/* -------------------------------------------------------------------------- */

describe("GAP-030 UTC pinning", () => {
  const options = (url: string): string => new URL(pinUtcInConnectionUrl(url)).searchParams.get("options") ?? "";

  test("adds timezone=UTC as a startup option", () => {
    expect(options("postgresql://u:p@h:5432/db")).toBe("-c timezone=UTC");
  });

  test("keeps other options and replaces a different timezone", () => {
    expect(options("postgresql://u@h/db?options=-c%20search_path%3Dpublic")).toBe("-c search_path=public -c timezone=UTC");
    expect(options("postgresql://u@h/db?options=-c%20timezone%3DAsia/Tripoli")).toBe("-c timezone=UTC");
  });

  test("the pinned URL survives node-postgres parsing", async () => {
    const { parse } = await import("pg-connection-string");
    const parsed = parse(pinUtcInConnectionUrl("postgresql://u:p@h:5432/db?connection_limit=5"));
    expect(parsed.options).toBe("-c timezone=UTC");
  });

  test("is idempotent", () => {
    const once = pinUtcInConnectionUrl("postgresql://u@h/db");
    expect(pinUtcInConnectionUrl(once)).toBe(once);
  });
});

