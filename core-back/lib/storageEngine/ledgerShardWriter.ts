import type { LedgerShardLine, LedgerShardWriter } from "../../engine/ledger/LedgerPoster";
import { Decimal } from "decimal.js";
import { DEFAULT_SHARD_COUNT, shardIdForAttempt } from "./shardBalances";

type RawExecutor = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

export interface ShardDelta {
  glAccountId: string;
  shardId: number;
  /** Signed: debit positive, credit negative. */
  delta: Decimal;
}

/**
 * Folds the lines of one posting into one signed delta per (account, shard),
 * sorted by (account, shard). Pure, so it is unit-tested without a database.
 * Folding is required (ON CONFLICT DO UPDATE cannot touch the same row twice
 * in one statement) and the sort makes every posting lock its shard rows in
 * the same global order, which removes the deadlock window that per-line
 * upserts in template order had between concurrent postings.
 */
export const foldShardDeltas = (
  lines: readonly LedgerShardLine[],
  shardCount: number = DEFAULT_SHARD_COUNT,
): ShardDelta[] => {
  const byKey = new Map<string, ShardDelta>();
  for (const line of lines) {
    const shardId = shardIdForAttempt(line.refId, line.accountType, shardCount);
    const amount = new Decimal(line.amount.toString());
    const signed = line.direction === "DEBIT" ? amount : amount.negated();
    const key = `${line.glAccountId}:${shardId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.delta = existing.delta.plus(signed);
    } else {
      byKey.set(key, { glAccountId: line.glAccountId, shardId, delta: signed });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.glAccountId !== right.glAccountId
      ? left.glAccountId < right.glAccountId ? -1 : 1
      : left.shardId - right.shardId,
  );
};

export const createLedgerShardWriter = (
  shardCount: number = DEFAULT_SHARD_COUNT,
): LedgerShardWriter => {
  return async (transaction, lines: readonly LedgerShardLine[]): Promise<void> => {
    const executor = transaction as unknown as RawExecutor;
    if (typeof executor.$executeRawUnsafe !== "function" || lines.length === 0) {
      return;
    }
    const deltas = foldShardDeltas(lines, shardCount);
    // One statement for every shard row the posting touches (was one upsert
    // per journal line).
    await executor.$executeRawUnsafe(
      `INSERT INTO gl_account_shards (gl_account_id, shard_id, current_balance, updated_at)
       SELECT t.gl_account_id, t.shard_id, t.delta, now()
       FROM unnest($1::uuid[], $2::smallint[], $3::numeric[]) AS t(gl_account_id, shard_id, delta)
       ORDER BY t.gl_account_id, t.shard_id
       ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
         current_balance = gl_account_shards.current_balance + EXCLUDED.current_balance,
         updated_at = now()`,
      deltas.map((row) => row.glAccountId),
      deltas.map((row) => row.shardId),
      deltas.map((row) => row.delta.toFixed(4)),
    );
  };
};

export const ensureAccountShards = async (
  executor: RawExecutor,
  glAccountId: string,
  shardCount: number = DEFAULT_SHARD_COUNT,
): Promise<void> => {
  const tuples: string[] = [];
  const values: unknown[] = [glAccountId];
  for (let shardId = 0; shardId < shardCount; shardId++) {
    tuples.push(`($1::uuid, $${shardId + 2}::smallint)`);
    values.push(shardId);
  }
  await executor.$executeRawUnsafe(
    `INSERT INTO gl_account_shards (gl_account_id, shard_id)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (gl_account_id, shard_id) DO NOTHING`,
    ...values,
  );
};
