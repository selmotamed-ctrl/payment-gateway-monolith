import type { LedgerShardLine, LedgerShardWriter } from "../../engine/ledger/LedgerPoster";
import { DEFAULT_SHARD_COUNT, shardIdForAttempt } from "./shardBalances";

type RawExecutor = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

export const createLedgerShardWriter = (
  shardCount: number = DEFAULT_SHARD_COUNT,
): LedgerShardWriter => {
  return async (transaction, line: LedgerShardLine): Promise<void> => {
    const executor = transaction as unknown as RawExecutor;
    if (typeof executor.$executeRawUnsafe !== "function") {
      return;
    }
    const shardId = shardIdForAttempt(line.refId, line.accountType, shardCount);
    const signedDelta =
      line.direction === "DEBIT"
        ? line.amount.toString()
        : `-${line.amount.toString()}`;
    await executor.$executeRawUnsafe(
      `INSERT INTO gl_account_shards (gl_account_id, shard_id, current_balance, updated_at)
       VALUES ($1::uuid, $2::smallint, $3::numeric, now())
       ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
         current_balance = gl_account_shards.current_balance + EXCLUDED.current_balance,
         updated_at = now()`,
      line.glAccountId,
      shardId,
      signedDelta,
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
