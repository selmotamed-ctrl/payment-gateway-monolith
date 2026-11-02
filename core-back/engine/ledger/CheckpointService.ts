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
    findMany(args?: { where?: Record<string, unknown>; select?: Record<string, boolean> }): Promise<LedgerAccountRecord[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<LedgerAccountRecord>;
  };
  journalLine: {
    findMany(args: { where: Record<string, unknown> }): Promise<JournalLineRecord[]>;
    findFirst?(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
      select?: Record<string, boolean>;
    }): Promise<Pick<JournalLineRecord, "id" | "createdAt"> | null>;
  };
  journalEntry?: {
    findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
  /** Present on the Prisma client; absent on a narrow test double. */
  $queryRawUnsafe?: (sql: string, ...params: unknown[]) => Promise<unknown>;
}

export interface AccountBalance {
  accountId: string;
  accountType: LedgerAccountRecord["accountType"];
  checkpointBalance: Decimal;
  delta: Decimal;
  liveBalance: Decimal;
  checkpointAt?: Date;
}

function hasCurrentBalance(account: LedgerAccountRecord): boolean {
  return account.currentBalance !== undefined && account.currentBalance !== null;
}

export class CheckpointService {
  private readonly client: CheckpointPrismaClient;

  constructor(client: CheckpointPrismaClient) {
    this.client = client;
  }

  async captureCheckpoint(accountId: string, asOf = new Date(), checkpointId?: string): Promise<CheckpointRecord> {
    // The checkpoint must serialise against a concurrent settlement sweep that
    // is writing lines to the same account, otherwise the balance captured is
    // a torn read. The row is locked for the duration of the snapshot.
    const account = await this.lockAccount(accountId);
    if (!account) {
      throw new Error(`GL account '${accountId}' does not exist`);
    }

    const nearNow = asOf.getTime() >= Date.now() - 1_000;
    let latestLine: Pick<JournalLineRecord, "id" | "createdAt"> | null | undefined;
    if (hasCurrentBalance(account) && this.client.journalLine.findFirst) {
      latestLine = await this.client.journalLine.findFirst({
        where: { glAccountId: accountId },
        orderBy: { id: "desc" },
        select: { id: true, createdAt: true },
      });
    }
    const latestIsCovered = latestLine
      ? latestLine.createdAt
        ? latestLine.createdAt.getTime() <= asOf.getTime()
        : nearNow
      : true;
    const useCurrentBalance = hasCurrentBalance(account)
      && nearNow
      && (this.client.journalLine.findFirst ? latestIsCovered : true);

    let balance: Decimal;
    let id = checkpointId;

    if (useCurrentBalance) {
      // The materialised balance already contains every committed line.
      balance = decimal(account.currentBalance ?? 0);
      if (!id) {
        id = latestLine?.id ?? account.lastCheckpointId ?? `checkpoint:${accountId}:${asOf.toISOString()}`;
      }
    } else {
      const lines = await this.client.journalLine.findMany({ where: { glAccountId: accountId } });
      balance = sumLines(lines, undefined, asOf);
      if (!id && this.client.journalLine.findFirst) {
        const atOrBefore = await this.client.journalLine.findFirst({
          where: { glAccountId: accountId, createdAt: { lte: asOf } },
          orderBy: { id: "desc" },
          select: { id: true },
        });
        id = atOrBefore?.id ?? account.lastCheckpointId ?? undefined;
      }
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
    }

    const data: Record<string, unknown> = {
      checkpointBalance: balance,
      checkpointAt: asOf,
      lastCheckpointId: id,
    };
    if (useCurrentBalance) {
      data.linesSinceCheckpoint = 0;
    }
    await this.client.glAccount.update({
      where: { id: accountId },
      data,
    });
    return { id, glAccountId: accountId, asOf, balance };
  }

  /**
   * Reads the account under a row lock when the client supports it, so a
   * checkpoint cannot interleave with a posting that targets the same account.
   */
  private async lockAccount(accountId: string): Promise<LedgerAccountRecord | null> {
    if (this.client.$queryRawUnsafe) {
      const rows = (await this.client.$queryRawUnsafe(
        "SELECT * FROM `gl_accounts` WHERE `id` = ? FOR UPDATE",
        accountId,
      )) as Array<Record<string, unknown>> | null;
      const locked = Array.isArray(rows) ? rows[0] : undefined;
      if (locked) {
        return {
          ...(locked as unknown as LedgerAccountRecord),
          accountType: (locked.accountType ?? locked.account_type) as LedgerAccountRecord["accountType"],
          checkpointBalance: locked.checkpointBalance ?? locked.checkpoint_balance,
          checkpointAt: (locked.checkpointAt ?? locked.checkpoint_at ?? null) as Date | null,
          lastCheckpointId: (locked.lastCheckpointId ?? locked.last_checkpoint_id ?? null) as string | null,
          currentBalance: locked.currentBalance ?? locked.current_balance,
          linesSinceCheckpoint: locked.linesSinceCheckpoint ?? locked.lines_since_checkpoint,
        } as LedgerAccountRecord;
      }
    }
    return this.client.glAccount.findUnique({ where: { id: accountId } });
  }

  async getLiveBalance(accountId: string): Promise<AccountBalance> {
    const account = await this.client.glAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new Error(`GL account '${accountId}' does not exist`);
    }
    return this.balanceForAccount(account);
  }

  async getLiveBalances(accountIds?: readonly string[]): Promise<AccountBalance[]> {
    if (accountIds) {
      const accounts = await this.client.glAccount.findMany({
        where: { id: { in: [...accountIds] } },
      });
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const balances: AccountBalance[] = [];
      for (const accountId of accountIds) {
        const account = byId.get(accountId);
        if (!account) {
          throw new Error(`GL account '${accountId}' does not exist`);
        }
        balances.push(await this.balanceForAccount(account));
      }
      return balances;
    }
    const balances: AccountBalance[] = [];
    for (const account of await this.client.glAccount.findMany()) {
      balances.push(await this.balanceForAccount(account));
    }
    return balances;
  }

  private async balanceForAccount(account: LedgerAccountRecord): Promise<AccountBalance> {
    const checkpointBalance = decimal(account.checkpointBalance ?? 0);
    if (hasCurrentBalance(account)) {
      const liveBalance = decimal(account.currentBalance ?? 0);
      return {
        accountId: account.id,
        accountType: account.accountType,
        checkpointBalance,
        delta: liveBalance.minus(checkpointBalance),
        liveBalance,
        checkpointAt: account.checkpointAt ?? undefined,
      };
    }
    const lines = await this.client.journalLine.findMany({ where: { glAccountId: account.id } });
    const delta = sumLines(lines, account.checkpointAt ?? undefined, undefined, true);
    return {
      accountId: account.id,
      accountType: account.accountType,
      checkpointBalance,
      delta,
      liveBalance: checkpointBalance.plus(delta),
      checkpointAt: account.checkpointAt ?? undefined,
    };
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
