import { Decimal } from "decimal.js";
import { fnv1aHash } from "./shardBalances";

/**
 * Shard routing and sequencing for the ledger. Everything in this file is pure (no database), so it is
 * unit-tested directly; the SQL lives in `ledgerShardWriter.ts`.
 *
 * Model
 *   * An account has a routing WIDTH (`gl_accounts.shard_count`, 1..256). A line goes to shard
 *     `fnv1a(refId) % width`, so a retry of the same posting always lands on the same shard.
 *   * Every journal line stores the shard it was posted to, so changing the width never remaps history.
 *   * Each shard owns a gapless sequence (`gl_account_shards.line_seq`). A posting reserves the
 *     sequence numbers of its lines on a shard in the same statement that updates the shard balance.
 */

export const MIN_SHARD_WIDTH = 1;
export const MAX_SHARD_WIDTH = 256;

/** Width of an account that has not been scaled: system accounts are spread, wallets start at one shard. */
export const INITIAL_SYSTEM_SHARD_WIDTH = 16;

/**
 * The system accounts every confirmation touches (TREASURY or GATEWAY_CLEARING, and PLATFORM_INCOME): at the
 * 15,000 TPS target each sees about 15,000 lines/s, far more than a step-wise scaler absorbs in time.
 */
export const HOT_SYSTEM_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["TREASURY", "GATEWAY_CLEARING", "PLATFORM_INCOME"]);

/**
 * Interim provisioning width of the hot system accounts (decision D6, AUTO-10): width = ceil(lines/s x shard lock
 * hold seconds x 2) gives 90-180 at today's 3-6 ms hold time, so they start at 128 until the load test on target
 * hardware sets the final value.
 */
export const HOT_SYSTEM_SHARD_WIDTH = 128;

/** Account types whose balance is checked against an overdraft by a locking guard (cash-out, chargebacks). */
export const BALANCE_GUARDED_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["MERCHANT_WALLET"]);

/** Debit-natural accounts: a DEBIT grows the balance. Every other type is credit-natural. */
export const DEBIT_NATURAL_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "TREASURY",
  "GATEWAY_CLEARING",
  "COMMISSION_RECEIVABLE",
  "PROVIDER_FEE_EXPENSE",
  "GATEWAY_FEE_EXPENSE",
]);

export type LineDirection = "DEBIT" | "CREDIT";

export const clampShardWidth = (width: number): number =>
  Number.isFinite(width) ? Math.min(MAX_SHARD_WIDTH, Math.max(MIN_SHARD_WIDTH, Math.trunc(width))) : MIN_SHARD_WIDTH;

/**
 * The routing width a new account starts with: one shard for a balance-guarded wallet, `hotSystemWidth` for the hot
 * system accounts (TREASURY, GATEWAY_CLEARING, PLATFORM_INCOME) and `systemWidth` for every other account.
 */
export const initialShardWidth = (
  accountType: string,
  systemWidth: number = INITIAL_SYSTEM_SHARD_WIDTH,
  hotSystemWidth: number = HOT_SYSTEM_SHARD_WIDTH,
): number => {
  if (BALANCE_GUARDED_ACCOUNT_TYPES.has(accountType)) return 1;
  return clampShardWidth(HOT_SYSTEM_ACCOUNT_TYPES.has(accountType) ? hotSystemWidth : systemWidth);
};

/** True when this line lowers the account's natural balance. */
export const reducesBalance = (accountType: string, direction: LineDirection): boolean =>
  DEBIT_NATURAL_ACCOUNT_TYPES.has(accountType) ? direction === "CREDIT" : direction === "DEBIT";

/**
 * Chooses the shard of a line.
 *
 * A balance-guarded account (a merchant wallet) sends every balance-REDUCING line to shard 0. The
 * cash-out lock then only needs shard 0: debits stay serialized exactly as with a single shard,
 * while credits (payments, the hot traffic) spread over the other shards. Concurrent credits can only
 * raise the balance, so a check made under the shard-0 lock stays conservative.
 */
export const routeLine = (accountType: string, direction: LineDirection, refId: string, width: number): number => {
  const effective = clampShardWidth(width);
  if (effective === 1) return 0;
  if (BALANCE_GUARDED_ACCOUNT_TYPES.has(accountType) && reducesBalance(accountType, direction)) return 0;
  return fnv1aHash(refId) % effective;
};

export interface RoutedLine {
  glAccountId: string;
  shardId: number;
  direction: LineDirection;
  /** Absolute amount; the sign comes from the direction (debit positive, credit negative). */
  amount: Decimal.Value | { toString(): string };
}

export interface ShardBump {
  glAccountId: string;
  shardId: number;
  /** Signed: debit positive, credit negative. */
  delta: Decimal;
  /** Number of lines this posting puts on the shard. */
  count: number;
}

export const shardKey = (glAccountId: string, shardId: number): string => `${glAccountId}:${shardId}`;

/**
 * Folds the lines of one posting into one (balance delta, line count) per (account, shard), sorted by
 * (account, shard). Folding is required (ON CONFLICT DO UPDATE cannot touch the same row twice in a
 * statement) and the sort makes every posting lock its shard rows in the same global order, which
 * removes the deadlock window between concurrent postings.
 */
export const foldShardBumps = (lines: readonly RoutedLine[]): ShardBump[] => {
  const byKey = new Map<string, ShardBump>();
  for (const line of lines) {
    const amount = new Decimal(line.amount.toString());
    const signed = line.direction === "DEBIT" ? amount : amount.negated();
    const key = shardKey(line.glAccountId, line.shardId);
    const existing = byKey.get(key);
    if (existing) {
      existing.delta = existing.delta.plus(signed);
      existing.count += 1;
    } else {
      byKey.set(key, { glAccountId: line.glAccountId, shardId: line.shardId, delta: signed, count: 1 });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.glAccountId !== right.glAccountId
      ? left.glAccountId < right.glAccountId ? -1 : 1
      : left.shardId - right.shardId,
  );
};

/**
 * Turns the new high-water mark of every bumped shard into the sequence number of each line. For a shard
 * whose new high-water is H and that received n lines, the j-th line (1-based, in template order) gets
 * H - n + j. Pure, so the arithmetic is tested without a database.
 */
export const assignShardSeqs = (
  lines: readonly Pick<RoutedLine, "glAccountId" | "shardId">[],
  bumps: readonly ShardBump[],
  highWater: ReadonlyMap<string, bigint>,
): bigint[] => {
  const countByKey = new Map(bumps.map((bump) => [shardKey(bump.glAccountId, bump.shardId), bump.count]));
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = shardKey(line.glAccountId, line.shardId);
    const top = highWater.get(key);
    const count = countByKey.get(key);
    if (top === undefined || count === undefined) {
      throw new Error(`shard sequence for ${key} was not reserved`);
    }
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return top - BigInt(count) + BigInt(ordinal);
  });
};

// ---------------------------------------------------------------------------------------------
// Account width cache
// ---------------------------------------------------------------------------------------------

type RawQuery = { $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T> };

const WIDTH_TTL_MS = 3_000;
const widthCache = new Map<string, { width: number; expiresAt: number }>();

/** Drops the cached widths (after a scale operation, and in tests). */
export const clearShardWidthCache = (): void => widthCache.clear();

/**
 * Routing widths of the given accounts, from a short-lived process cache and one batched query for the
 * misses. A stale width is harmless: each line stores its own shard and shard rows are never deleted, so
 * a few seconds of an old width only means a few postings spread a little less (or more) than the
 * newest width asks for.
 */
export const loadShardWidths = async (
  executor: RawQuery,
  accountIds: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, number>> => {
  const widths = new Map<string, number>();
  const missing: string[] = [];
  for (const id of new Set(accountIds)) {
    const cached = widthCache.get(id);
    if (cached && cached.expiresAt > now) {
      widths.set(id, cached.width);
    } else {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    const rows = await executor.$queryRawUnsafe<Array<{ id: string; shard_count: number }>>(
      `SELECT id::text AS id, shard_count FROM gl_accounts WHERE id = ANY($1::uuid[])`,
      missing,
    );
    for (const row of rows) {
      const width = clampShardWidth(Number(row.shard_count));
      widths.set(row.id, width);
      widthCache.set(row.id, { width, expiresAt: now + WIDTH_TTL_MS });
    }
  }
  return widths;
};
