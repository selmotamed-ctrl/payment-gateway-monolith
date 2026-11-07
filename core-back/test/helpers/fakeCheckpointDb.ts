import { Decimal } from "decimal.js";

/**
 * In-memory model of the per-shard checkpoint tables (`gl_account_shards`, `journal_lines`, `gl_shard_checkpoints`)
 * that answers exactly the raw SQL statements issued by `CheckpointService`. It lets the unit tests exercise the
 * service logic (gapless proof, parity proof, monotonic advance, failure bookkeeping) without a database.
 * It is a double for the statement SHAPES; the real SQL is covered by the live PostgreSQL suites.
 */
export interface FakeLine {
  shardSeq: bigint;
  direction: "DEBIT" | "CREDIT";
  amount: string;
}

export interface FakeShardState {
  balance: Decimal;
  lineSeq: bigint;
  lines: FakeLine[];
  checkpoint?: {
    balance: Decimal;
    seq: bigint;
    status: "OK" | "GAP" | "PARITY";
    failureKind: string | null;
    consecutiveFailures: number;
    verifiedAt: Date | null;
  };
}

export const createFakeCheckpointDb = () => {
  const shards = new Map<string, FakeShardState>();
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const key = (account: string, shard: number): string => `${account}:${shard}`;

  const shard = (account: string, shardId = 0): FakeShardState => {
    const existing = shards.get(key(account, shardId));
    if (existing) return existing;
    const created: FakeShardState = { balance: new Decimal(0), lineSeq: 0n, lines: [] };
    shards.set(key(account, shardId), created);
    return created;
  };

  /** Posts one line the way the poster does: bump the balance and the sequence, record the line. */
  const post = (account: string, shardId: number, direction: "DEBIT" | "CREDIT", amount: string): void => {
    const state = shard(account, shardId);
    state.lineSeq += 1n;
    state.balance = direction === "DEBIT" ? state.balance.plus(amount) : state.balance.minus(amount);
    state.lines.push({ shardSeq: state.lineSeq, direction, amount });
  };

  const db = {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...args: unknown[]): Promise<T> => {
      statements.push({ sql, args });
      const account = String(args[0]);
      if (sql.includes("WITH s AS")) {
        const state = shards.get(key(account, Number(args[1])));
        if (!state) return [] as T;
        const cpSeq = state.checkpoint?.seq ?? 0n;
        const inRange = state.lines.filter((line) => line.shardSeq > cpSeq && line.shardSeq <= state.lineSeq);
        const delta = inRange.reduce(
          (sum, line) => (line.direction === "DEBIT" ? sum.plus(line.amount) : sum.minus(line.amount)),
          new Decimal(0),
        );
        return [
          {
            balance: state.balance.toFixed(4),
            line_seq: state.lineSeq.toString(),
            cp_balance: (state.checkpoint?.balance ?? new Decimal(0)).toFixed(4),
            cp_seq: cpSeq.toString(),
            found: (state.lineSeq > cpSeq ? inRange.length : 0).toString(),
            delta: delta.toFixed(4),
          },
        ] as T;
      }
      if (sql.includes("INSERT INTO gl_shard_checkpoints") && sql.includes("RETURNING 1 AS moved")) {
        const state = shard(account, Number(args[1]));
        const seq = BigInt(String(args[3]));
        if (state.checkpoint && state.checkpoint.seq >= seq) return [] as T;
        state.checkpoint = {
          balance: new Decimal(String(args[2])),
          seq,
          status: "OK",
          failureKind: null,
          consecutiveFailures: 0,
          verifiedAt: new Date(),
        };
        return [{ moved: 1 }] as T;
      }
      if (sql.includes("INSERT INTO gl_shard_checkpoints") && sql.includes("RETURNING consecutive_failures")) {
        const state = shard(account, Number(args[1]));
        const previous = state.checkpoint;
        state.checkpoint = {
          balance: previous?.balance ?? new Decimal(0),
          seq: previous?.seq ?? 0n,
          status: String(args[2]) as "GAP" | "PARITY",
          failureKind: String(args[3]),
          consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
          verifiedAt: previous?.verifiedAt ?? null,
        };
        return [{ consecutive_failures: state.checkpoint.consecutiveFailures }] as T;
      }
      if (sql.includes("UPDATE gl_shard_checkpoints SET verified_at")) {
        const state = shards.get(key(account, Number(args[1])));
        if (state?.checkpoint) {
          state.checkpoint = { ...state.checkpoint, status: "OK", failureKind: null, consecutiveFailures: 0, verifiedAt: new Date() };
        }
        return [] as T;
      }
      if (sql.includes("SELECT shard_id FROM gl_account_shards")) {
        return [...shards.keys()]
          .filter((entry) => entry.startsWith(`${account}:`))
          .map((entry) => ({ shard_id: Number(entry.split(":")[1]) }))
          .sort((left, right) => left.shard_id - right.shard_id) as T;
      }
      return [] as T;
    },
  };

  return { db, shards, shard, post, statements };
};
