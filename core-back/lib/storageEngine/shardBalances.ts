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

export interface LiveAccountBalanceRow {
  id: string;
  accountType: string;
  /** Natural-sign balance (credit-normal accounts positive when in credit). */
  balance: string;
  /** Always "shards": every account has its shard rows (the `gl_accounts_create_shards` trigger). */
  source: "shards";
}

/**
 * Live natural-sign balance of GL accounts in ONE statement: the sum of the account's shard rows.
 *
 * Every account has at least shard 0 (created with the account by a trigger), so there is no journal
 * fallback any more and nothing to double count. An account that somehow has no shard rows reads 0.
 * Shards are stored debit-positive; the sum is converted to the natural sign of the account type.
 */
export const loadLiveAccountBalances = async (
  db: { $queryRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown> },
  accountIds?: readonly string[],
): Promise<LiveAccountBalanceRow[]> => {
  if (typeof db.$queryRawUnsafe !== "function") {
    return [];
  }
  const filtered = accountIds !== undefined;
  if (filtered && accountIds.length === 0) {
    return [];
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT g.id::text AS id,
            g.account_type::text AS "accountType",
            COALESCE(s.total, 0)::text AS raw
     FROM gl_accounts g
     LEFT JOIN (
       SELECT gl_account_id, SUM(current_balance) AS total
       FROM gl_account_shards
       ${filtered ? "WHERE gl_account_id = ANY($1::uuid[])" : ""}
       GROUP BY gl_account_id
     ) s ON s.gl_account_id = g.id
     ${filtered ? "WHERE g.id = ANY($1::uuid[])" : ""}`,
    ...(filtered ? [accountIds] : []),
  );
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = row as { id: string; accountType: string; raw: string | null };
    return {
      id: record.id,
      accountType: record.accountType,
      balance: naturalShardBalance(record.accountType, record.raw ?? "0"),
      source: "shards" as const,
    };
  });
};

export interface AccountCheckpointSummary {
  id: string;
  accountType: string;
  /** Routing width and the number of shard rows (rows can exceed the width after a scale-down). */
  shardCount: number;
  shardRows: number;
  /** Sum of the shard checkpoints, debit-positive (the sign shards are stored in). */
  checkpointBalance: string;
  /** Oldest checkpoint among the shards that have one; null when no shard was ever checkpointed. */
  checkpointAt: Date | null;
  /** Lines posted since the shard checkpoints (all shards), and how many shards have any. */
  pendingLines: string;
  shardsBehind: number;
  /** Worst checkpoint status among the shards: OK, GAP or PARITY. */
  status: "OK" | "GAP" | "PARITY";
}

/**
 * The checkpoint state of accounts, derived from their shards (the account itself stores none).
 * `checkpointBalance` + the lines posted since = the live balance, both debit-positive.
 */
export const loadAccountCheckpointSummary = async (
  db: { $queryRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown> },
  accountIds?: readonly string[],
): Promise<AccountCheckpointSummary[]> => {
  if (typeof db.$queryRawUnsafe !== "function") {
    return [];
  }
  const filtered = accountIds !== undefined;
  if (filtered && accountIds.length === 0) {
    return [];
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT s.gl_account_id::text AS id,
            g.account_type::text AS "accountType",
            g.shard_count AS "shardCount",
            COUNT(*)::int AS "shardRows",
            COALESCE(SUM(c.checkpoint_balance), 0)::text AS "checkpointBalance",
            MIN(c.checkpoint_at) AS "checkpointAt",
            COALESCE(SUM(s.line_seq - COALESCE(c.checkpoint_seq, 0)), 0)::text AS "pendingLines",
            COUNT(*) FILTER (WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0))::int AS "shardsBehind",
            CASE WHEN bool_or(c.status = 'PARITY') THEN 'PARITY'
                 WHEN bool_or(c.status = 'GAP') THEN 'GAP' ELSE 'OK' END AS status
     FROM gl_account_shards s
     INNER JOIN gl_accounts g ON g.id = s.gl_account_id
     LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
     ${filtered ? "WHERE s.gl_account_id = ANY($1::uuid[])" : ""}
     GROUP BY s.gl_account_id, g.account_type, g.shard_count`,
    ...(filtered ? [accountIds] : []),
  );
  return (Array.isArray(rows) ? rows : []) as AccountCheckpointSummary[];
};
