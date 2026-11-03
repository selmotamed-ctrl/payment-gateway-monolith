import { Decimal } from "decimal.js";
import {
  GlBalanceStore,
  type GlAccountBalance,
  type GlBalanceStoreClient,
} from "./GlBalanceStore";
import type { DecimalInput, LedgerAccountRecord } from "./LedgerPoster";

export interface CheckpointRecord {
  id: string;
  glAccountId: string;
  asOf: Date;
  balance: DecimalInput;
  createdAt?: Date;
}

export interface CheckpointPrismaClient extends GlBalanceStoreClient {}

export interface AccountBalance {
  accountId: string;
  accountType: LedgerAccountRecord["accountType"];
  balance?: Decimal;
  currentBalance?: Decimal;
  checkpointBalance: Decimal;
  delta: Decimal;
  liveBalance: Decimal;
  checkpointAt?: Date;
  balanceMode?: "SYNC" | "SHARDED" | string;
}

export class CheckpointService {
  private readonly client: CheckpointPrismaClient;
  private readonly store: GlBalanceStore;

  constructor(client: CheckpointPrismaClient) {
    this.client = client;
    this.store = new GlBalanceStore(client);
  }

  async captureCheckpoint(accountId: string, asOf = new Date(), checkpointId?: string): Promise<CheckpointRecord> {
    const balance = await this.store.getBalance(this.client, accountId);
    return {
      id: checkpointId ?? `current:${accountId}`,
      glAccountId: accountId,
      asOf,
      balance,
    };
  }

  async getLiveBalance(accountId: string): Promise<AccountBalance> {
    const snapshot = await this.store.readBalance(this.client, accountId);
    return this.toAccountBalance(snapshot);
  }

  async getLiveBalances(accountIds?: readonly string[]): Promise<AccountBalance[]> {
    const snapshots = await this.store.readBalances(this.client, accountIds);
    return snapshots.map((snapshot) => this.toAccountBalance(snapshot));
  }

  async getBalance(accountId: string): Promise<Decimal> {
    return this.store.getBalance(this.client, accountId);
  }

  async getBalances(accountIds?: readonly string[]): Promise<AccountBalance[]> {
    return this.getLiveBalances(accountIds);
  }

  private toAccountBalance(snapshot: GlAccountBalance): AccountBalance {
    return {
      accountId: snapshot.accountId,
      accountType: snapshot.accountType as LedgerAccountRecord["accountType"],
      balance: snapshot.balance,
      currentBalance: snapshot.balance,
      checkpointBalance: new Decimal(0),
      delta: new Decimal(0),
      liveBalance: snapshot.balance,
      balanceMode: snapshot.balanceMode,
    };
  }
}
