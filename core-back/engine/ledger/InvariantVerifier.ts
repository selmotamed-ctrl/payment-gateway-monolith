import { Decimal } from "decimal.js";
import { decimal, type JournalLineRecord, type LedgerAccountRecord } from "./LedgerPoster";
import type { AccountBalance } from "./CheckpointService";

export interface InvariantPrismaClient {
  glAccount: {
    findMany(args?: { select?: Record<string, boolean> }): Promise<LedgerAccountRecord[]>;
  };
  journalLine: {
    findMany(args?: { where?: Record<string, unknown> }): Promise<JournalLineRecord[]>;
  };
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

  constructor(clientOrProvider: InvariantPrismaClient | InvariantBalanceProvider) {
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
   * The live balance of an account is the checkpoint balance plus the journal
   * lines that were posted after the checkpoint. Summing every line would
   * double count the window that the checkpoint already covers.
   */
  private async loadBalances(): Promise<AccountBalance[]> {
    if (!this.client) {
      return [];
    }
    const accounts = await this.client.glAccount.findMany();
    const balances: AccountBalance[] = [];
    for (const account of accounts) {
      const checkpointBalance = decimal(account.checkpointBalance ?? 0);
      const lines = await this.client.journalLine.findMany({
        where: account.checkpointAt
          ? { glAccountId: account.id, createdAt: { gt: account.checkpointAt } }
          : { glAccountId: account.id },
      });
      let delta = new Decimal(0);
      for (const line of lines) {
        const amount = decimal(line.amount);
        delta = line.direction === "DEBIT" ? delta.plus(amount) : delta.minus(amount);
      }
      balances.push({
        accountId: account.id,
        accountType: account.accountType,
        checkpointBalance,
        delta,
        liveBalance: checkpointBalance.plus(delta),
        checkpointAt: account.checkpointAt ?? undefined,
      });
    }
    return balances;
  }
}
