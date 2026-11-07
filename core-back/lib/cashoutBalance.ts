import { Decimal } from "decimal.js";

type Any = Record<string, any>;

const toDecimal = (value: unknown): Decimal => {
  if (value instanceof Decimal) return value;
  if (value && typeof value === "object" && typeof (value as Any).toString === "function") {
    return new Decimal((value as Any).toString());
  }
  return new Decimal((value as string | number | undefined) ?? 0);
};

/** Cash-out states that already reserve part of the wallet balance. */
export const OPEN_CASHOUT_STATES = ["PENDING", "PROCESSING"] as const;

/**
 * Takes the wallet's balance lock and returns its ledger balance, credit positive.
 *
 * Wallet DEBITS (cash-outs, chargebacks) are serialized by a transaction-scoped ADVISORY lock on the wallet,
 * acquired FIRST, before the transaction holds any shard row. Only other debiters ever wait for it, and a
 * waiter holds no shard row, so it can not take part in a lock cycle. (Locking the wallet's shard-0 row for the
 * check and letting the posting lock the treasury shard afterwards is the opposite order to a payment
 * confirmation, which locks the treasury shard first: a classic deadlock.)
 *
 * `lockShards` runs right after the advisory lock and before the balance is read. A caller that knows the
 * posting it is about to make passes `poster.lockShardsFor(...)`, which locks every shard row that posting will
 * touch in the global order, so a refund posting to shard 0 can not slip in between the check and the debit.
 * The balance is the sum of ALL shards, read after the locks (a single CTE would take its snapshot before the
 * wait); credits that land on other shards meanwhile can only raise it, so the check stays conservative.
 *
 * On a transaction without raw SQL support (the in-memory test fakes) the balance is the sum of the journal
 * lines of the account; no lock is possible there and none is needed.
 */
export const lockWalletLedgerBalance = async (
  tx: unknown,
  glAccountId: string,
  options: { lockShards?: () => Promise<void> } = {},
): Promise<Decimal> => {
  const client = tx as Any;
  if (typeof client.$queryRaw === "function") {
    // The lock function returns void, which Prisma cannot deserialize: project a constant instead.
    await client.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"wallet-balance:" + glAccountId}, 0))) AS l`;
    if (options.lockShards) await options.lockShards();
    const rows = (await client.$queryRaw`
      SELECT COALESCE(SUM(current_balance), 0)::text AS total
      FROM gl_account_shards
      WHERE gl_account_id = ${glAccountId}::uuid
    `) as Array<{ total: unknown }>;
    // The wallet is a liability account: its shards carry a negative (credit) balance.
    return toDecimal(rows[0]?.total ?? 0).negated();
  }
  if (options.lockShards) await options.lockShards();
  const lines = (await client.journalLine.findMany({ where: { glAccountId } })) as Any[];
  return lines.reduce<Decimal>(
    (total, line) =>
      line.direction === "CREDIT" ? total.plus(toDecimal(line.amount)) : total.minus(toDecimal(line.amount)),
    new Decimal(0),
  );
};

/** The sum of the open cash-out requests of a wallet, optionally without one request. */
export const openCashoutTotal = async (tx: unknown, walletId: string, excludeId?: string): Promise<Decimal> => {
  const client = tx as Any;
  const rows = (await client.cashoutRequest.findMany({
    where: { walletId, state: { in: [...OPEN_CASHOUT_STATES] } },
  })) as Any[];
  return rows
    .filter((row) => excludeId === undefined || String(row.id) !== excludeId)
    .reduce<Decimal>((total, row) => total.plus(toDecimal(row.amount)), new Decimal(0));
};
