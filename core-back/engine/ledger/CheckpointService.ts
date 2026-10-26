import { Decimal } from "decimal.js";
import { decimal, type DecimalInput, type JournalLineRecord, type LedgerAccountRecord } from "./LedgerPoster";

export interface CheckpointRecord {
  id: string;
  glAccountId: string;
  asOf: Date;
  balance: DecimalInput;
  createdAt?: Date;
}

export interface CheckpointPrismaClient {
  glAccount: {
    findUnique(args: { where: { id: string } }): Promise<LedgerAccountRecord | null>;
    findMany(args?: { select?: Record<string, boolean> }): Promise<LedgerAccountRecord[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<LedgerAccountRecord>;
  };
  journalLine: {
    findMany(args: { where: Record<string, unknown> }): Promise<JournalLineRecord[]>;
  };
  journalEntry?: {
    findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
}

export interface AccountBalance {
  accountId: string;
  accountType: LedgerAccountRecord["accountType"];
  checkpointBalance: Decimal;
  delta: Decimal;
  liveBalance: Decimal;
  checkpointAt?: Date;
}

export class CheckpointService {
  private readonly client: CheckpointPrismaClient;

  constructor(client: CheckpointPrismaClient) {
    this.client = client;
  }

  async captureCheckpoint(accountId: string, asOf = new Date(), checkpointId?: string): Promise<CheckpointRecord> {
    const account = await this.client.glAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new Error(`GL account '${accountId}' does not exist`);
    }
    const lines = await this.client.journalLine.findMany({ where: { glAccountId: accountId } });
    const balance = sumLines(lines, undefined, asOf);
    let id = checkpointId;
    if (!id && this.client.journalEntry) {
      const entry = await this.client.journalEntry.findFirst({
        where: {},
        orderBy: { createdAt: "desc" },
      });
      id = entry?.id;
    }
    if (!id) {
      id = `checkpoint:${accountId}:${asOf.toISOString()}`;
    }
    await this.client.glAccount.update({
      where: { id: accountId },
      data: {
        checkpointBalance: balance,
        checkpointAt: asOf,
        lastCheckpointId: id,
      },
    });
    return { id, glAccountId: accountId, asOf, balance };
  }

  async getLiveBalance(accountId: string): Promise<AccountBalance> {
    const account = await this.client.glAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new Error(`GL account '${accountId}' does not exist`);
    }
    const lines = await this.client.journalLine.findMany({ where: { glAccountId: accountId } });
    const checkpointBalance = decimal(account.checkpointBalance ?? 0);
    const delta = sumLines(lines, account.checkpointAt ?? undefined, undefined, true);
    return {
      accountId,
      accountType: account.accountType,
      checkpointBalance,
      delta,
      liveBalance: checkpointBalance.plus(delta),
      checkpointAt: account.checkpointAt ?? undefined,
    };
  }

  async getLiveBalances(accountIds?: readonly string[]): Promise<AccountBalance[]> {
    if (accountIds) {
      return Promise.all(accountIds.map((accountId) => this.getLiveBalance(accountId)));
    }
    const balances: AccountBalance[] = [];
    for (const account of await this.client.glAccount.findMany({ select: { id: true } })) {
      balances.push(await this.getLiveBalance(account.id));
    }
    return balances;
  }
}

function lineDate(line: JournalLineRecord): Date | undefined {
  const candidate = line as JournalLineRecord & {
    createdAt?: Date;
    entry?: { createdAt?: Date };
  };
  return candidate.createdAt ?? candidate.entry?.createdAt;
}

function sumLines(
  lines: readonly JournalLineRecord[],
  after: Date | undefined,
  before: Date | undefined,
  afterExclusive = false,
): Decimal {
  let total = new Decimal(0);
  for (const line of lines) {
    const date = lineDate(line);
    if (after && date) {
      if (afterExclusive ? date.getTime() <= after.getTime() : date.getTime() < after.getTime()) {
        continue;
      }
    }
    if (before && date && date.getTime() > before.getTime()) {
      continue;
    }
    const amount = decimal(line.amount);
    total = line.direction === "DEBIT" ? total.plus(amount) : total.minus(amount);
  }
  return total;
}
