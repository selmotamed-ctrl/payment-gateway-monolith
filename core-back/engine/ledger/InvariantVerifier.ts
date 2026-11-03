import { Decimal } from "decimal.js";
import { decimal, type LedgerAccountRecord } from "./LedgerPoster";
import type { AccountBalance } from "./CheckpointService";
import {
  GlBalanceStore,
  type AccountBalanceVerification,
  type ClosedPeriodVerification,
  type GlBalanceStoreClient,
  type PeriodTotalOptions,
} from "./GlBalanceStore";

export interface InvariantPrismaClient extends GlBalanceStoreClient {
  glAccount?: any;
  journalLine?: any;
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

  async verifyClosedPeriod(
    day: Date | string | PeriodTotalOptions,
    accountId?: string,
  ): Promise<ClosedPeriodVerification> {
    if (!this.client) {
      throw new Error("The invariant verifier has no database client for period verification");
    }
    const options: PeriodTotalOptions = day instanceof Date || typeof day === "string"
      ? { day, ...(accountId ? { accountId } : {}) }
      : day;
    return new GlBalanceStore(this.client).verifyClosedPeriod(this.client, options);
  }

  async verifyPeriodTotals(
    day: Date | string | PeriodTotalOptions,
    accountId?: string,
  ): Promise<ClosedPeriodVerification> {
    return this.verifyClosedPeriod(day, accountId);
  }

  async verifyAccountBalance(
    accountId: string,
    firstOpenDay?: Date | string,
  ): Promise<AccountBalanceVerification> {
    if (!this.client) {
      throw new Error("The invariant verifier has no database client for account verification");
    }
    return new GlBalanceStore(this.client).verifyAccountBalance(this.client, accountId, firstOpenDay);
  }

  async verifyAccount(
    accountId: string,
    firstOpenDay?: Date | string,
  ): Promise<AccountBalanceVerification> {
    return this.verifyAccountBalance(accountId, firstOpenDay);
  }

  private async loadBalances(): Promise<AccountBalance[]> {
    if (!this.client) {
      return [];
    }
    const store = new GlBalanceStore(this.client);
    const accounts = await this.loadAccounts();
    const balances: AccountBalance[] = [];
    for (const account of accounts) {
      const snapshot = await store.readBalance(this.client, account);
      balances.push({
        accountId: snapshot.accountId,
        accountType: snapshot.accountType as LedgerAccountRecord["accountType"],
        balance: snapshot.balance,
        currentBalance: snapshot.balance,
        checkpointBalance: new Decimal(0),
        delta: new Decimal(0),
        liveBalance: snapshot.balance,
        balanceMode: snapshot.balanceMode,
      });
    }
    return balances;
  }

  private async loadAccounts(): Promise<LedgerAccountRecord[]> {
    if (!this.client) {
      return [];
    }
    const delegate = this.client.glAccount;
    if (delegate && typeof delegate.findMany === "function") {
      const rows = await delegate.findMany({
        select: {
          id: true,
          accountType: true,
          balanceMode: true,
          currentBalance: true,
          balanceFloor: true,
          currency: true,
        },
      });
      return Array.isArray(rows) ? rows as LedgerAccountRecord[] : [];
    }
    if (typeof this.client.$queryRawUnsafe === "function") {
      const rows = await this.client.$queryRawUnsafe(
        "SELECT `id`, `account_type` AS `accountType`, `balance_mode` AS `balanceMode`, `current_balance` AS `currentBalance`, `balance_floor` AS `balanceFloor`, `currency` FROM `gl_accounts`",
      );
      return Array.isArray(rows) ? rows as LedgerAccountRecord[] : [];
    }
    return [];
  }
}
