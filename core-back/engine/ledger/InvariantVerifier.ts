import { Decimal } from "decimal.js";
import { decimal, type JournalLineRecord, type LedgerAccountRecord } from "./LedgerPoster";

export interface AccountBalance {
  accountId: string;
  accountType: LedgerAccountRecord["accountType"];
  /** Sum of the shard checkpoints (debit-positive). */
  checkpointBalance: Decimal;
  /** Lines posted since the checkpoints (live minus checkpoint). */
  delta: Decimal;
  /** Live balance, debit-positive: the sum of the account's shards. */
  liveBalance: Decimal;
  /** Oldest shard checkpoint of the account, when it has any. */
  checkpointAt?: Date;
}

export interface InvariantPrismaClient {
  glAccount: {
    findMany(args?: { select?: Record<string, boolean> }): Promise<LedgerAccountRecord[]>;
  };
  journalLine: {
    findMany(args?: { where?: Record<string, unknown> }): Promise<JournalLineRecord[]>;
  };
  /** When present, every account is summed by PostgreSQL in ONE statement. */
  $queryRawUnsafe?: (query: string, ...values: unknown[]) => Promise<unknown>;
}

export interface InvariantBalanceProvider {
  (): Promise<readonly AccountBalance[]>;
}

export interface InvariantResult {
  ok: boolean;
  drift: Decimal;
  leftSide: Decimal;
  rightSide: Decimal;
  accountBalances: readonly AccountBalance[];
  checkedAt: Date;
}

export const DEBIT_POSITIVE_ACCOUNTS: readonly string[] = [
  "TREASURY",
  "GATEWAY_CLEARING",
  "COMMISSION_RECEIVABLE",
  "PROVIDER_FEE_EXPENSE",
  "GATEWAY_FEE_EXPENSE",
];

export const CREDIT_POSITIVE_ACCOUNTS: readonly string[] = [
  "MERCHANT_WALLET",
  "PLATFORM_INCOME",
  "GATEWAY_FEE_ACCRUAL",
  "AML_HOLD",
  "CHARGEBACK_RESERVE",
  "SUSPENSE",
];

export const naturalBalance = (accountType: string, debitPositiveBalance: Decimal): Decimal =>
  DEBIT_POSITIVE_ACCOUNTS.includes(accountType) ? debitPositiveBalance : debitPositiveBalance.neg();

export class InvariantVerifier {
  private readonly client?: InvariantPrismaClient;
  private readonly balanceProvider?: InvariantBalanceProvider;

  private readonly useSql: boolean;

  /**
   * `options.sql` opts into the single-statement SQL aggregation (production
   * PostgreSQL clients). Test doubles that only implement the Prisma model
   * methods keep the default per-account path.
   */
  constructor(
    clientOrProvider: InvariantPrismaClient | InvariantBalanceProvider,
    options: { sql?: boolean } = {},
  ) {
    this.useSql = options.sql === true;
    if (typeof clientOrProvider === "function") {
      this.balanceProvider = clientOrProvider;
    } else {
      this.client = clientOrProvider;
    }
  }

  async verify(): Promise<InvariantResult> {
    const balances = this.balanceProvider
      ? await this.balanceProvider()
      : await this.loadBalances();
    const grouped = new Map<string, Decimal>();
    for (const balance of balances) {
      const current = grouped.get(balance.accountType) ?? new Decimal(0);
      grouped.set(
        balance.accountType,
        current.plus(naturalBalance(balance.accountType, decimal(balance.liveBalance))),
      );
    }
    const get = (type: string): Decimal => grouped.get(type) ?? new Decimal(0);
    const leftSide = get("TREASURY")
      .plus(get("GATEWAY_CLEARING"))
      .plus(get("COMMISSION_RECEIVABLE"));
    const rightSide = get("MERCHANT_WALLET")
      .plus(get("PLATFORM_INCOME"))
      .minus(get("PROVIDER_FEE_EXPENSE"))
      .minus(get("GATEWAY_FEE_EXPENSE"))
      .plus(get("GATEWAY_FEE_ACCRUAL"))
      .plus(get("AML_HOLD"))
      .plus(get("CHARGEBACK_RESERVE"))
      .plus(get("SUSPENSE"));
    const drift = leftSide.minus(rightSide);
    return {
      ok: drift.isZero(),
      drift,
      leftSide,
      rightSide,
      accountBalances: balances,
      checkedAt: new Date(),
    };
  }

  async assertInvariant(): Promise<InvariantResult> {
    const result = await this.verify();
    if (!result.ok) {
      throw new Error(`Ledger invariant drift is ${result.drift.toFixed(4)}`);
    }
    return result;
  }

  /**
   * The live balance of an account is the sum of its shard balances (debit-positive); the checkpoint part
   * is the sum of the shard checkpoints, so `delta` is what has been posted since.
   *
   * The 60 s ledger equation is checked from the SHARD balances: O(shards), independent of how much
   * history the journal holds. What ties the shards to the journal is the checkpointer, which proves for
   * every shard that `checkpoint + lines in (checkpoint_seq, line_seq] = shard balance` before it moves
   * (see CheckpointService), and the restore drill, which re-derives it from the whole journal.
   */
  private async loadBalances(): Promise<AccountBalance[]> {
    if (!this.client) {
      return [];
    }
    if (this.useSql && typeof this.client.$queryRawUnsafe === "function") {
      const rows = (await this.client.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.account_type::text AS "accountType",
                COALESCE(SUM(c.checkpoint_balance), 0)::text AS "checkpointBalance",
                MIN(c.checkpoint_at) AS "checkpointAt",
                COALESCE(SUM(s.current_balance), 0)::text AS live
         FROM gl_accounts g
         LEFT JOIN gl_account_shards s ON s.gl_account_id = g.id
         LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
         GROUP BY g.id, g.account_type`,
      )) as Array<{ id: string; accountType: string; checkpointBalance: string | null; checkpointAt: Date | null; live: string }>;
      return rows.map((row) => {
        const checkpointBalance = decimal(row.checkpointBalance ?? 0);
        const liveBalance = decimal(row.live ?? 0);
        return {
          accountId: row.id,
          accountType: row.accountType as AccountBalance["accountType"],
          checkpointBalance,
          delta: liveBalance.minus(checkpointBalance),
          liveBalance,
          checkpointAt: row.checkpointAt ?? undefined,
        };
      });
    }
    // Test doubles without raw SQL: sum every journal line of every account.
    const accounts = await this.client.glAccount.findMany();
    const balances: AccountBalance[] = [];
    for (const account of accounts) {
      const lines = await this.client.journalLine.findMany({ where: { glAccountId: account.id } });
      let delta = new Decimal(0);
      for (const line of lines) {
        const amount = decimal(line.amount);
        delta = line.direction === "DEBIT" ? delta.plus(amount) : delta.minus(amount);
      }
      balances.push({
        accountId: account.id,
        accountType: account.accountType,
        checkpointBalance: new Decimal(0),
        delta,
        liveBalance: delta,
      });
    }
    return balances;
  }
}
