export const DEFAULT_SHARD_COUNT = 16;

export const ACCOUNT_TYPES_WITHOUT_SHARDING = new Set([
  "MERCHANT_WALLET",
]);

/**
 * FNV-1a 32-bit hash. Deterministic across nodes so every attempt always
 * touches the same GL shard, even without a lookup table.
 */
export const fnv1aHash = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const shardCountForAccountType = (
  accountType: string,
  shardCount: number = DEFAULT_SHARD_COUNT,
): number => (ACCOUNT_TYPES_WITHOUT_SHARDING.has(accountType) ? 1 : Math.max(1, shardCount));

export const shardIdForAttempt = (
  attemptId: string,
  accountType: string,
  shardCount: number = DEFAULT_SHARD_COUNT,
): number => {
  const count = shardCountForAccountType(accountType, shardCount);
  return count === 1 ? 0 : fnv1aHash(attemptId) % count;
};

export const shardKey = (glAccountId: string, shardId: number): string =>
  `${glAccountId}:${shardId}`;

export const signedShardDelta = (
  direction: "DEBIT" | "CREDIT",
  amount: { toString(): string },
): string => {
  const value = amount.toString();
  return direction === "DEBIT" ? value : `-${value}`;
};

export interface ShardBalanceRow {
  id: string;
  accountType: string;
  total: string;
}

export const loadShardBalanceRows = async (
  db: { $queryRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown> },
  accountIds?: readonly string[],
): Promise<ShardBalanceRow[]> => {
  if (typeof db.$queryRawUnsafe !== "function") {
    return [];
  }
  const rows = accountIds && accountIds.length > 0
    ? await db.$queryRawUnsafe(
        `SELECT s.gl_account_id::text AS id, g.account_type::text AS "accountType",
                SUM(s.current_balance)::text AS total
         FROM gl_account_shards s
         INNER JOIN gl_accounts g ON g.id = s.gl_account_id
         WHERE s.gl_account_id = ANY($1::uuid[])
         GROUP BY s.gl_account_id, g.account_type`,
        accountIds,
      )
    : await db.$queryRawUnsafe(
        `SELECT s.gl_account_id::text AS id, g.account_type::text AS "accountType",
                SUM(s.current_balance)::text AS total
         FROM gl_account_shards s
         INNER JOIN gl_accounts g ON g.id = s.gl_account_id
         GROUP BY s.gl_account_id, g.account_type`,
      );
  return Array.isArray(rows) ? rows as ShardBalanceRow[] : [];
};

const DEBIT_POSITIVE_ACCOUNT_TYPES = new Set([
  "TREASURY",
  "GATEWAY_CLEARING",
  "COMMISSION_RECEIVABLE",
  "PROVIDER_FEE_EXPENSE",
  "GATEWAY_FEE_EXPENSE",
]);

export const naturalShardBalance = (
  accountType: string,
  shardTotal: string | number | { toString(): string },
): string => {
  const value = shardTotal.toString();
  if (Number(value) === 0) return "0";
  return DEBIT_POSITIVE_ACCOUNT_TYPES.has(accountType)
    ? value
    : value.startsWith("-")
      ? value.slice(1)
      : `-${value}`;
};
