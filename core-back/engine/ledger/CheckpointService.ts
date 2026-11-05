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
  /** Present on the Prisma client; absent on a narrow test double. */
  $queryRawUnsafe?: (sql: string, ...params: unknown[]) => Promise<unknown>;
  /** Present on the Prisma client; absent on a narrow test double. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction?: (fn: (tx: any) => Promise<unknown>, options?: { timeout?: number }) => Promise<unknown>;
}

export interface AccountBalance {
  accountId: string;
  accountType: LedgerAccountRecord["accountType"];
  checkpointBalance: Decimal;
  delta: Decimal;
  liveBalance: Decimal;
  checkpointAt?: Date;
}

export type ParityMode = "enforce" | "warn" | "off";

export interface CheckpointServiceOptions {
  /**
   * What to do when the shard total of an account disagrees with its journal
   * total at capture time. "enforce" (default) refuses the checkpoint,
   * "warn" captures it and reports through `onParityMismatch`, "off" skips.
   */
  parity?: ParityMode;
  onParityMismatch?: (mismatch: ShardParityMismatch) => void;
}

export interface ShardParityMismatch {
  accountId: string;
  /** Sum of gl_account_shards.current_balance (debit-positive). */
  shardTotal: Decimal;
  /** checkpoint_balance + journal lines after the checkpoint (debit-positive). */
  journalTotal: Decimal;
  drift: Decimal;
}

export interface ShardParityResult {
  ok: boolean;
  /** Accounts that have shard rows and were compared. */
  checked: number;
  mismatches: ShardParityMismatch[];
}

export class ShardParityError extends Error {
  readonly code = "LEDGER_SHARD_PARITY_MISMATCH";
  readonly mismatch: ShardParityMismatch;
  constructor(mismatch: ShardParityMismatch) {
    super(
      `GL account '${mismatch.accountId}' shard total ${mismatch.shardTotal.toFixed(4)} ` +
        `differs from journal total ${mismatch.journalTotal.toFixed(4)} (drift ${mismatch.drift.toFixed(4)})`,
    );
    this.name = "ShardParityError";
    this.mismatch = mismatch;
  }
}

/**
 * ONE statement, therefore ONE snapshot: the shard total and the journal total
 * are read together, so a posting that commits in between cannot produce a
 * false mismatch.
 */
const PARITY_SQL =
  "SELECT g.id::text AS id," +
  ' s.total::text AS "shardTotal",' +
  " (g.checkpoint_balance + COALESCE((" +
  "SELECT SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END)" +
  " FROM journal_lines jl WHERE jl.gl_account_id = g.id" +
  ' AND (g.checkpoint_at IS NULL OR jl.created_at > g.checkpoint_at)), 0))::text AS "journalTotal"' +
  " FROM gl_accounts g" +
  " INNER JOIN (SELECT gl_account_id, SUM(current_balance) AS total FROM gl_account_shards GROUP BY gl_account_id) s" +
  " ON s.gl_account_id = g.id";

export class CheckpointService {
  private readonly client: CheckpointPrismaClient;
  private readonly parity: ParityMode;
  private readonly onParityMismatch?: (mismatch: ShardParityMismatch) => void;

  constructor(client: CheckpointPrismaClient, options: CheckpointServiceOptions = {}) {
    this.client = client;
    this.parity = options.parity ?? "enforce";
    this.onParityMismatch = options.onParityMismatch;
  }

  /**
   * Captures a checkpoint atomically: the account lock, the snapshot sum, the
   * parity check and the write happen in ONE database transaction, and the
   * default `asOf` is the DATABASE clock (`clock_timestamp()` after the lock
   * is held), never the application clock. Journal lines carry database
   * timestamps, so mixing in an app timestamp let a skewed node include or
   * skip lines at the checkpoint boundary.
   */
  async captureCheckpoint(accountId: string, asOf?: Date, checkpointId?: string): Promise<CheckpointRecord> {
    if (typeof this.client.$transaction === "function") {
      return (await this.client.$transaction(
        (tx) => this.captureWithin(tx as CheckpointPrismaClient, accountId, asOf, checkpointId),
        { timeout: 30_000 },
      )) as CheckpointRecord;
    }
    return this.captureWithin(this.client, accountId, asOf, checkpointId);
  }

  private async captureWithin(
    client: CheckpointPrismaClient,
    accountId: string,
    asOfInput: Date | undefined,
    checkpointId: string | undefined,
  ): Promise<CheckpointRecord> {
    // The checkpoint must serialise against a concurrent settlement sweep that
    // is writing lines to the same account, otherwise the balance captured is
    // a torn read. The row is locked for the duration of the transaction.
    const account = await lockAccount(client, accountId);
    if (!account) {
      throw new Error(`GL account '${accountId}' does not exist`);
    }
    const asOf = asOfInput ?? (await databaseNow(client));
    if (this.parity !== "off") {
      const result = await checkShardParity(client, [accountId]);
      for (const mismatch of result.mismatches) {
        this.onParityMismatch?.(mismatch);
        if (this.parity === "enforce") {
          throw new ShardParityError(mismatch);
        }
      }
    }
    const lines = await client.journalLine.findMany({ where: { glAccountId: accountId } });
    const balance = sumLines(lines, undefined, asOf);
    let id = checkpointId;
    if (!id && client.journalEntry) {
      const entry = await client.journalEntry.findFirst({
        where: {},
        orderBy: { createdAt: "desc" },
      });
      id = entry?.id;
    }
    if (!id) {
      id = `checkpoint:${accountId}:${asOf.toISOString()}`;
    }
    await client.glAccount.update({
      where: { id: accountId },
      data: {
        checkpointBalance: balance,
        checkpointAt: asOf,
        lastCheckpointId: id,
      },
    });
    return { id, glAccountId: accountId, asOf, balance };
  }

  /**
   * Runtime shard-vs-journal parity check (read only). Compares, for every
   * account that has shard rows, the shard total with checkpoint + journal
   * lines after the checkpoint. Returns the mismatches instead of throwing.
   */
  async verifyShardParity(accountIds?: readonly string[]): Promise<ShardParityResult> {
    return checkShardParity(this.client, accountIds);
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

/**
 * Reads the account under a row lock when the client supports it, so a
 * checkpoint cannot interleave with a posting that targets the same account.
 */
async function lockAccount(client: CheckpointPrismaClient, accountId: string): Promise<LedgerAccountRecord | null> {
  if (client.$queryRawUnsafe) {
    const rows = (await client.$queryRawUnsafe(
      "SELECT * FROM gl_accounts WHERE id = $1::uuid FOR UPDATE",
      accountId,
    )) as Array<Record<string, unknown>> | null;
    const locked = Array.isArray(rows) ? rows[0] : undefined;
    if (locked) {
      return locked as unknown as LedgerAccountRecord;
    }
  }
  return client.glAccount.findUnique({ where: { id: accountId } });
}

/** The database clock. The application clock is only a fallback for narrow test doubles. */
async function databaseNow(client: CheckpointPrismaClient): Promise<Date> {
  if (client.$queryRawUnsafe) {
    const rows = (await client.$queryRawUnsafe("SELECT clock_timestamp() AS now")) as Array<{ now?: unknown }> | null;
    const value = Array.isArray(rows) ? rows[0]?.now : undefined;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return new Date();
}

/**
 * Shard-vs-journal parity for the accounts that have shard rows. Rows that do
 * not look like parity rows (a narrow test double answering every raw query
 * with account rows) are ignored.
 */
export async function checkShardParity(
  client: Pick<CheckpointPrismaClient, "$queryRawUnsafe">,
  accountIds?: readonly string[],
): Promise<ShardParityResult> {
  if (typeof client.$queryRawUnsafe !== "function") {
    return { ok: true, checked: 0, mismatches: [] };
  }
  const filtered = accountIds !== undefined;
  if (filtered && accountIds.length === 0) {
    return { ok: true, checked: 0, mismatches: [] };
  }
  const rows = (await (filtered
    ? client.$queryRawUnsafe(`${PARITY_SQL} WHERE g.id = ANY($1::uuid[])`, accountIds)
    : client.$queryRawUnsafe(PARITY_SQL))) as Array<Record<string, unknown>> | null;
  const mismatches: ShardParityMismatch[] = [];
  let checked = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.shardTotal === undefined || row.journalTotal === undefined || row.id === undefined) {
      continue;
    }
    checked += 1;
    const shardTotal = decimal(row.shardTotal as DecimalInput);
    const journalTotal = decimal(row.journalTotal as DecimalInput);
    const drift = shardTotal.minus(journalTotal);
    if (!drift.isZero()) {
      mismatches.push({ accountId: String(row.id), shardTotal, journalTotal, drift });
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches };
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
