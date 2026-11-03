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
