import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CheckpointService, ShardParityError } from "../engine/ledger/CheckpointService";
import { createFakeCheckpointDb } from "./helpers/fakeCheckpointDb";
import { LedgerCheckpointWorker } from "../engine/workers/LedgerCheckpointWorker";
import { LedgerShardScalerWorker } from "../engine/workers/LedgerShardScalerWorker";
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
import { crossFieldIssues, envSchema } from "../lib/env";
import { pinUtcInConnectionUrl } from "../lib/storageEngine/utcSession";

/* -------------------------------------------------------------------------- */
/* GAP-011 checkpoint                                                          */
/* -------------------------------------------------------------------------- */

describe("GAP-011 CheckpointService (per-shard, lock-free, verified)", () => {
  test("a capture is one snapshot read plus one monotonic upsert, with no lock and no transaction", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "10.0000");
    const result = await new CheckpointService(fake.db).captureShard("acc-1", 0);
    expect(result.status).toBe("ADVANCED");
    expect(fake.statements).toHaveLength(2);
    expect(fake.statements[0]!.sql).toContain("WITH s AS");
    expect(fake.statements[1]!.sql).toContain("WHERE c.checkpoint_seq < EXCLUDED.checkpoint_seq");
    for (const statement of fake.statements) {
      expect(statement.sql).not.toContain("FOR UPDATE");
      expect(statement.sql).not.toMatch(/\bgl_accounts\b/);
    }
  });

  test("the checkpoint time is the database clock, never a value computed by the application", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "10.0000");
    await new CheckpointService(fake.db).captureShard("acc-1", 0);
    const advance = fake.statements.find((statement) => statement.sql.includes("INSERT INTO gl_shard_checkpoints"))!;
    expect(advance.sql).toContain("checkpoint_at = now()");
    expect(advance.args.some((arg) => arg instanceof Date)).toBe(false);
    expect(advance.args).toEqual(["acc-1", 0, "10.0000", "1"]);
  });

  test("a shard-vs-journal mismatch is refused: PARITY, nothing moves, the first failure is flagged", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "100.0000");
    fake.shard("acc-1").balance = fake.shard("acc-1").balance.minus("10.0000"); // the shard disagrees with the journal
    const service = new CheckpointService(fake.db);
    const first = await service.captureShard("acc-1", 0);
    expect(first.status).toBe("PARITY");
    expect(first.drift.toFixed(4)).toBe("-10.0000");
    expect(first.firstFailure).toBe(true);
    expect(fake.shard("acc-1").checkpoint?.seq).toBe(0n);
    expect(fake.shard("acc-1").checkpoint?.status).toBe("PARITY");
    const second = await service.captureShard("acc-1", 0);
    expect(second.firstFailure).toBe(false);
    expect(fake.shard("acc-1").checkpoint?.consecutiveFailures).toBe(2);
    const error = new ShardParityError(first);
    expect(error.code).toBe("LEDGER_SHARD_PARITY_MISMATCH");
    expect(error.result.drift.toFixed(4)).toBe("-10.0000");
    expect(error.message).toContain("shard 0");
  });

  test("a missing line is a GAP, found after a retry without the partition-pruning hint", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "10.0000");
    fake.post("acc-1", 0, "DEBIT", "5.0000");
    fake.shard("acc-1").lines.pop(); // line_seq says 2, only 1 line exists
    const result = await new CheckpointService(fake.db).captureShard("acc-1", 0);
    expect(result.status).toBe("GAP");
    expect(result.linesFound).toBe(1n);
    const snapshots = fake.statements.filter((statement) => statement.sql.includes("WITH s AS"));
    expect(snapshots).toHaveLength(2); // hinted read, then the full read before alarming
    expect(snapshots[0]!.sql).toContain("make_interval");
    expect(snapshots[1]!.sql).not.toContain("make_interval");
    expect(new ShardParityError(result).message).toContain("1 line(s) found");
  });

  test("a capture that lost the race to a further checkpoint reports NOOP and never moves it back", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "10.0000");
    const base = fake.db.$queryRawUnsafe;
    let raced = false;
    const racing = {
      $queryRawUnsafe: async <T = unknown>(sql: string, ...args: unknown[]): Promise<T> => {
        const rows = await base<T>(sql, ...args);
        if (!raced && sql.includes("WITH s AS")) {
          raced = true;
          fake.shard("acc-1").checkpoint = {
            balance: fake.shard("acc-1").balance, seq: 1n, status: "OK", failureKind: null, consecutiveFailures: 0, verifiedAt: new Date(),
          };
        }
        return rows;
      },
    };
    const result = await new CheckpointService(racing).captureShard("acc-1", 0);
    expect(result.status).toBe("NOOP");
    expect(result.checkpointSeq).toBe(0n);
    expect(fake.shard("acc-1").checkpoint?.seq).toBe(1n);
  });

  test("an unchanged, healthy shard only refreshes verified_at and an unknown shard is an error", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "10.0000");
    const service = new CheckpointService(fake.db);
    await service.captureShard("acc-1", 0);
    expect((await service.captureShard("acc-1", 0)).status).toBe("NOOP");
    expect(fake.statements.at(-1)!.sql).toContain("UPDATE gl_shard_checkpoints SET verified_at");
    await expect(service.captureShard("missing", 3)).rejects.toThrow("has no shard 3");
  });

  test("captureAccount walks every shard row and findCandidates is bounded and respects the failure back-off", async () => {
    const fake = createFakeCheckpointDb();
    fake.post("acc-1", 0, "DEBIT", "1.0000");
    fake.post("acc-1", 1, "DEBIT", "2.0000");
    fake.post("acc-1", 2, "DEBIT", "3.0000");
    const service = new CheckpointService(fake.db);
    const results = await service.captureAccount("acc-1");
    expect(results.map((entry) => [entry.shardId, entry.status])).toEqual([[0, "ADVANCED"], [1, "ADVANCED"], [2, "ADVANCED"]]);

    const seen: unknown[][] = [];
    const candidates = await new CheckpointService({
      $queryRawUnsafe: async <T = unknown>(sql: string, ...args: unknown[]): Promise<T> => {
        seen.push([sql, ...args]);
        return [{ id: "acc-1", shard_id: 2, pending: "7" }] as T;
      },
    }).findCandidates({ minLines: 100, maxAgeSeconds: 60, limit: 5 });
    expect(candidates).toEqual([{ glAccountId: "acc-1", shardId: 2, pendingLines: 7n }]);
    expect(seen[0]!.slice(1)).toEqual([100, 60, 600, 5]);
    expect(String(seen[0]![0])).toContain("last_failure_at");
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

  test("the inbound inbox claim is a durable lease, not only a transaction-scoped lock", async () => {
    const { db, calls } = claimDb();
    await new InboundInboxWorker({
      db,
      repositories: emptyRepositories(),
      handler: { handle: async () => ({ processed: true }) },
      workerId: "node-a",
    }).runOnce();
    const claim = calls.find(
      (call) => call.sql.includes("FROM inbound_events") && call.sql.includes("FOR UPDATE SKIP LOCKED"),
    );
    expect(claim?.sql).toContain("claimed_at = $3::timestamptz");
    expect(claim?.sql).toContain("updated_at = ($3::timestamptz AT TIME ZONE 'UTC')");
    expect(claim?.sql).toContain("claimed_by = $4");
    expect(claim?.args[3]).toBe("node-a");
    expect(claim?.inTx).toBe(true);
  });

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
      new LedgerCheckpointWorker({ db, repositories, leaderElection: election } as never),
      new LedgerShardScalerWorker({ db, repositories, leaderElection: election } as never),
      new RetentionWorker({ db, repositories, leaderElection: election } as never),
    ];
    return Promise.all(keys.map((worker) => worker.runOnce().catch(() => undefined))).then(() => {
      expect(election.keys.sort()).toEqual([
        "worker:ExpirySweeperWorker",
        "worker:LedgerCheckpointWorker",
        "worker:LedgerInvariantWorker",
        "worker:LedgerShardScalerWorker",
        "worker:RetentionWorker",
      ]);
    });
  });
});

const fakePgClient = (script: {
  lockResult?: boolean;
  failOn?: string;
  pid?: number;
  sameSession?: boolean;
  holdsLock?: boolean;
  unlocked?: boolean;
  pidSequence?: number[];
}) => {
  const queries: string[] = [];
  const handlers: Record<string, ((error?: Error) => void)[]> = {};
  let backendPid = script.pid ?? 4242;
  let pidChecks = 0;
  const client: PgClientLike & { queries: string[]; emit(event: string): void; ended: boolean } = {
    queries,
    ended: false,
    connect: async () => undefined,
    query: async (sql: string) => {
      queries.push(sql);
      if (script.failOn && sql.includes(script.failOn)) throw new Error("connection terminated");
      if (sql.includes("holds_lock")) {
        return {
          rows: [
            {
              pid: backendPid,
              same_session: script.sameSession ?? true,
              holds_lock: script.holdsLock ?? true,
            },
          ],
        };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ released: script.unlocked ?? true }] };
      }
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ pid: backendPid, locked: script.lockResult ?? true }] };
      }
      if (sql.includes("SELECT pg_backend_pid() AS pid")) {
        if (script.pidSequence && pidChecks < script.pidSequence.length) {
          backendPid = script.pidSequence[pidChecks]!;
        }
        pidChecks += 1;
        return { rows: [{ pid: backendPid }] };
      }
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
    const failing = fakePgClient({ failOn: "holds_lock" });
    (election as unknown as { client: unknown }).client = failing;
    await expect(election.tryAcquire("w")).rejects.toThrow("connection terminated");
    expect(election.held()).toEqual([]);
  });

  test("a changed backend PID drops leadership instead of trusting the client connection", async () => {
    const client = fakePgClient({});
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => client });
    await election.tryAcquire("w");
    (election as unknown as { client: unknown }).client = fakePgClient({ sameSession: false });
    expect(await election.tryAcquire("w")).toBe(false);
    expect(election.held()).toEqual([]);
    expect(election.status().lostCount).toBeGreaterThan(0);
  });

  test("a missing advisory lock row drops leadership", async () => {
    const client = fakePgClient({});
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => client });
    await election.tryAcquire("w");
    (election as unknown as { client: unknown }).client = fakePgClient({ holdsLock: false });
    expect(await election.tryAcquire("w")).toBe(false);
    expect(election.held()).toEqual([]);
  });

  test("a refused unlock drops the session instead of pretending the release succeeded", async () => {
    const client = fakePgClient({ unlocked: false });
    const election = new PgAdvisoryLeaderElection({ clientFactory: () => client });
    await election.tryAcquire("w");
    await election.release("w");
    expect(election.held()).toEqual([]);
    expect(client.ended).toBe(true);
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

  test("the session-safety probe rejects an endpoint where two clients share one backend", async () => {
    const clients = [fakePgClient({}), fakePgClient({ lockResult: true })];
    let index = 0;
    const election = new PgAdvisoryLeaderElection({
      clientFactory: () => clients[Math.min(index++, clients.length - 1)]!,
    });
    await expect(election.verifySessionSafety()).rejects.toThrow(
      "Two leader-election clients acquired the same advisory lock",
    );
    expect(election.status().probeOk).toBe(false);
  });

  test("the session-safety probe accepts a genuinely session-scoped endpoint", async () => {
    const clients = [fakePgClient({}), fakePgClient({ lockResult: false })];
    let index = 0;
    const election = new PgAdvisoryLeaderElection({
      clientFactory: () => clients[Math.min(index++, clients.length - 1)]!,
    });
    const status = await election.verifySessionSafety();
    expect(status.probeOk).toBe(true);
    expect(status.backendPid).toBe(4242);
  });

  test("the session-safety probe rejects an endpoint that changes backend between statements", async () => {
    const main = fakePgClient({ pidSequence: [4242, 4242, 4242, 9999, 9999, 9999, 9999, 9999] });
    const second = fakePgClient({ lockResult: false });
    const clients = [main, second];
    let index = 0;
    const election = new PgAdvisoryLeaderElection({
      clientFactory: () => clients[Math.min(index++, clients.length - 1)]!,
    });
    await expect(election.verifySessionSafety()).rejects.toThrow(
      "The leader-election backend changed between statements",
    );
    expect(election.status().probeOk).toBe(false);
  });
});

describe("leader-election environment guard", () => {
  const parsed = () =>
    envSchema.parse({
      DATABASE_URL: "postgresql://gw:secret@10.0.0.5:6432/payment_gateway",
      PGBOUNCER_ENABLED: "true",
      MTLS_CA_CERT_PATH: "/certs/ca.crt",
      MTLS_SERVER_CERT_PATH: "/certs/core.crt",
      MTLS_SERVER_KEY_PATH: "/certs/core.key",
      KMS_MASTER_KEY: "test-only-master-key-value",
    });

  test("PgBouncer without a dedicated session URL refuses to boot the workers", () => {
    expect(crossFieldIssues(parsed())).toContain(
      "LEADER_ELECTION_DATABASE_URL is required when WORKER_ENABLED and PGBOUNCER_ENABLED are true " +
        "(point it at the PgBouncer session alias, never the transaction-pooled DATABASE_URL)",
    );
  });

  test("the transactional DATABASE_URL is refused as the leader endpoint", () => {
    const value = { ...parsed(), LEADER_ELECTION_DATABASE_URL: "postgresql://gw:secret@10.0.0.5:6432/payment_gateway" };
    expect(crossFieldIssues(value)).toContain(
      "LEADER_ELECTION_DATABASE_URL must not be the transaction-pooled DATABASE_URL " +
        "(use the session-pooled alias or a direct PostgreSQL URL)",
    );
  });

  test("a distinct session alias is accepted", () => {
    const value = { ...parsed(), LEADER_ELECTION_DATABASE_URL: "postgresql://gw:secret@10.0.0.5:6432/pgw_session" };
    expect(crossFieldIssues(value)).toEqual([]);
  });

  test("a direct endpoint without PgBouncer needs no extra URL", () => {
    const value = { ...parsed(), PGBOUNCER_ENABLED: false };
    expect(crossFieldIssues(value)).toEqual([]);
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

