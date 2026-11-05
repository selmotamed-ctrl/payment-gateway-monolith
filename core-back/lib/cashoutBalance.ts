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
 * Locks the shards of a wallet GL account (`FOR UPDATE`, ascending shard id, so
 * two cash-outs of one wallet serialise and never deadlock) and returns the
 * ledger balance of the wallet, credit positive.
 *
 * On a transaction without raw SQL support (the in-memory test fakes) the
 * balance is the sum of the journal lines of the account; no lock is possible
 * there and none is needed.
 */
export const lockWalletLedgerBalance = async (tx: unknown, glAccountId: string): Promise<Decimal> => {
  const client = tx as Any;
  if (typeof client.$queryRaw === "function") {
    const rows = (await client.$queryRaw`
      SELECT current_balance
      FROM gl_account_shards
      WHERE gl_account_id = ${glAccountId}::uuid
      ORDER BY shard_id ASC
      FOR UPDATE
    `) as Array<{ current_balance: unknown }>;
    // The wallet is a liability account: its shards carry a negative (credit) balance.
    return rows.reduce<Decimal>((total, row) => total.minus(toDecimal(row.current_balance)), new Decimal(0));
  }
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
