import type { LedgerShardAssignment, LedgerShardLine, LedgerShardWriter } from "../../engine/ledger/LedgerPoster";
import {
  assignShardSeqs,
  clampShardWidth,
  foldShardBumps,
  loadShardWidths,
  routeLine,
  shardKey,
  type RoutedLine,
} from "./shardRouting";

type RawExecutor = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
};

/**
 * Reserves the shard and the sequence number of every line of a posting, and applies the balance deltas.
 *
 * It runs BEFORE the journal lines are inserted, in the posting transaction. One statement
 *   * locks the shard rows (sorted by account, then shard: one global order, no deadlock window),
 *   * adds the signed balance delta and the number of lines to `line_seq`,
 *   * returns the new `line_seq` of each shard.
 * The row lock is held until commit, so the sequence of a shard is serialized and commit order equals
 * sequence order. A snapshot that sees a shard at (balance B, line_seq S) therefore sees every line with
 * `shard_seq <= S`, and committed sequences are gapless (an aborted posting rolls back its bump too).
 *
 * Without a raw-SQL executor (the in-memory unit-test doubles) there is nothing to project; the lines
 * get the neutral assignment (shard 0, seq 0).
 */
export const createLedgerShardWriter = (): LedgerShardWriter => {
  return async (transaction, lines: readonly LedgerShardLine[]): Promise<LedgerShardAssignment[]> => {
    const executor = transaction as unknown as Partial<RawExecutor>;
    if (typeof executor.$queryRawUnsafe !== "function" || lines.length === 0) {
      return lines.map(() => ({ shardId: 0, shardSeq: 0n }));
    }
    const widths = await loadShardWidths(executor as RawExecutor, lines.map((line) => line.glAccountId));
    const routed: RoutedLine[] = lines.map((line) => ({
      glAccountId: line.glAccountId,
      shardId: routeLine(line.accountType, line.direction, line.refId, widths.get(line.glAccountId) ?? 1),
      direction: line.direction,
      amount: line.amount,
    }));
    const bumps = foldShardBumps(routed);
    const rows = await executor.$queryRawUnsafe<Array<{ gl_account_id: string; shard_id: number; line_seq: string }>>(
      `INSERT INTO gl_account_shards AS s (gl_account_id, shard_id, current_balance, line_seq, updated_at)
       SELECT t.gl_account_id, t.shard_id, t.delta, t.n, now()
       FROM unnest($1::uuid[], $2::smallint[], $3::numeric[], $4::bigint[]) AS t(gl_account_id, shard_id, delta, n)
       ORDER BY t.gl_account_id, t.shard_id
       ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
         current_balance = s.current_balance + EXCLUDED.current_balance,
         line_seq = s.line_seq + EXCLUDED.line_seq,
         updated_at = now()
       RETURNING s.gl_account_id::text AS gl_account_id, s.shard_id, s.line_seq::text AS line_seq`,
      bumps.map((row) => row.glAccountId),
      bumps.map((row) => row.shardId),
      bumps.map((row) => row.delta.toFixed(4)),
      bumps.map((row) => row.count),
    );
    const highWater = new Map<string, bigint>();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && typeof row.line_seq === "string") {
        highWater.set(shardKey(row.gl_account_id, Number(row.shard_id)), BigInt(row.line_seq));
      }
    }
    if (!bumps.every((bump) => highWater.has(shardKey(bump.glAccountId, bump.shardId)))) {
      // A test double answered the statement without RETURNING rows. Against PostgreSQL the statement always returns
      // every bumped shard, and a line without a sequence is refused by `journal_lines_shard_seq_positive`.
      return routed.map((line) => ({ shardId: line.shardId, shardSeq: 0n }));
    }
    const seqs = assignShardSeqs(routed, bumps, highWater);
    return routed.map((line, index) => ({ shardId: line.shardId, shardSeq: seqs[index]! }));
  };
};

/**
 * Creates shard rows `0 .. width - 1` of an account (idempotent). New accounts get theirs from the
 * `gl_accounts_create_shards` trigger; this is for scaling an existing account up.
 */
export const ensureAccountShards = async (
  executor: Pick<RawExecutor, "$executeRawUnsafe">,
  glAccountId: string,
  width: number,
  from = 0,
): Promise<void> => {
  const target = clampShardWidth(width);
  if (target <= from) return;
  await executor.$executeRawUnsafe(
    `INSERT INTO gl_account_shards (gl_account_id, shard_id)
     SELECT $1::uuid, g.shard_id FROM generate_series($2::int, $3::int) AS g(shard_id)
     ON CONFLICT (gl_account_id, shard_id) DO NOTHING`,
    glAccountId,
    from,
    target - 1,
  );
};

/**
 * Locks, in ONE statement and in the global (account, shard) order, every shard row a posting of `lines` is about
 * to touch (`FOR UPDATE`). Postings lock their shard rows in that same order, so an operation that must hold shard
 * locks BEFORE it reads a balance (a cash-out checking the wallet) acquires them in the same order as everyone else
 * and can never form a lock cycle with a concurrent posting. Routing here is identical to the real posting (same
 * widths, same `routeLine`), so the rows locked are the rows the posting will update.
 *
 * Without a raw-SQL executor (test doubles) there is nothing to lock.
 */
export const lockShardsForLines = async (
  transaction: unknown,
  lines: readonly LedgerShardLine[],
): Promise<void> => {
  const executor = transaction as Partial<RawExecutor>;
  if (typeof executor.$queryRawUnsafe !== "function" || lines.length === 0) return;
  const widths = await loadShardWidths(executor as RawExecutor, lines.map((line) => line.glAccountId));
  const routed: RoutedLine[] = lines.map((line) => ({
    glAccountId: line.glAccountId,
    shardId: routeLine(line.accountType, line.direction, line.refId, widths.get(line.glAccountId) ?? 1),
    direction: line.direction,
    amount: line.amount,
  }));
  const targets = foldShardBumps(routed);
  await executor.$queryRawUnsafe(
    `SELECT 1 FROM gl_account_shards s
     WHERE (s.gl_account_id, s.shard_id) IN (SELECT t.gl_account_id, t.shard_id FROM unnest($1::uuid[], $2::smallint[]) AS t(gl_account_id, shard_id))
     ORDER BY s.gl_account_id, s.shard_id
     FOR UPDATE`,
    targets.map((row) => row.glAccountId),
    targets.map((row) => row.shardId),
  );
};
