import { databasePath, getDb, nowIso, updateTransaction, uuidv7 } from "../db";
import { RAIL_DESCRIPTORS, resolveRail, type RailDescriptor } from "../chaos/DefaultRailScenarios";

/**
 * Stateful Fake Rails v2 customer accounts.
 *
 * Every test phone number, bank account, card PAN and voucher has a real
 * balance, a daily limit, a status and a hold/movement history. The balances
 * are stored as 4-decimal LYD strings and every mutation is applied through
 * integer micro-unit (`1/10000 LYD`) arithmetic inside one SQLite immediate
 * transaction, so two concurrent checkouts cannot both spend the same money.
 */

export type FakeInstrumentType = "MOBILE_WALLET" | "BANK_ACCOUNT" | "CARD" | "VOUCHER";
export type FakeAccountStatus = "ACTIVE" | "FROZEN" | "EXPIRED" | "BLOCKED";
export type FakeDeclineCode = "ACCOUNT_FROZEN" | "INSUFFICIENT_FUNDS" | "LIMIT_EXCEEDED";

export interface FakeAccountRow {
  id: string;
  rail_code: string;
  gateway_code: string;
  merchant_id: string | null;
  instrument_type: FakeInstrumentType;
  identifier: string;
  holder_name: string;
  secret_pin: string;
  expiry: string | null;
  currency: string;
  available_balance_lyd: string;
  reserved_balance_lyd: string;
  daily_limit_lyd: string;
  daily_spent_lyd: string;
  status: FakeAccountStatus;
  static_otp: string | null;
  preset_fault: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FakeAccountHoldRow {
  id: string;
  account_id: string;
  transaction_id: string;
  amount_lyd: string;
  state: "HELD" | "CAPTURED" | "RELEASED";
  created_at: string;
  updated_at: string;
}

export interface FakeAccountMovementRow {
  id: string;
  account_id: string;
  transaction_id: string | null;
  direction: "HOLD" | "CAPTURE" | "RELEASE" | "REFUND_CREDIT" | "BALANCE_ADJUSTMENT";
  amount_lyd: string;
  available_before_lyd: string;
  available_after_lyd: string;
  reason: string;
  actor: string;
  created_at: string;
}

export interface HoldCheckResult {
  allowed: boolean;
  declineCode?: FakeDeclineCode;
  declineMessage?: string;
  account: FakeAccountRow;
}

const MICROS = 10_000n;

/** Parses a 4-decimal LYD string into integer micro-units without floating point. */
export const toMicros = (lyd: string | number): bigint => {
  let raw = String(lyd ?? "0").trim().replace(/,/g, "").replace(/[^\d.+-]/g, "");
  if (raw === "" || raw === "+" || raw === "-" || raw === ".") return 0n;
  const negative = raw.startsWith("-");
  if (negative || raw.startsWith("+")) raw = raw.slice(1);
  const [wholePart = "0", fractionPart = ""] = raw.split(".");
  const whole = BigInt(wholePart === "" ? "0" : wholePart);
  const fraction = BigInt((fractionPart + "0000").slice(0, 4).padEnd(4, "0"));
  const value = whole * MICROS + fraction;
  return negative ? -value : value;
};

export const fromMicros = (micros: bigint): string => {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / MICROS;
  const fraction = (absolute % MICROS).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
};

export const addLyd = (left: string, right: string): string => fromMicros(toMicros(left) + toMicros(right));
export const maxLyd = (value: string, zero = "0.0000"): string =>
  fromMicros(toMicros(value) < toMicros(zero) ? toMicros(zero) : toMicros(value));

const instrumentForRail = (rail: RailDescriptor): {
  type: FakeInstrumentType;
  ids: [string, string, string, string, string];
  pin: string;
} => {
  if (rail.gatewayCode === "moamalat" || rail.gatewayCode === "mpgs") {
    const prefix = rail.gatewayCode === "mpgs" ? "512345" : "628000";
    return {
      type: "CARD",
      ids: [
        `${prefix}1111111111`,
        `${prefix}2222222222`,
        `${prefix}0000000005`,
        `${prefix}0000000061`,
        `${prefix}0000000999`,
      ],
      pin: "123",
    };
  }
  if (rail.gatewayCode === "neompay") {
    return {
      type: "MOBILE_WALLET",
      ids: [
        "NEOM-WALLET-RICH-01",
        "NEOM-WALLET-STD-02",
        "NEOM-WALLET-LOW-05",
        "NEOM-WALLET-LIM-61",
        "NEOM-WALLET-FRZ-99",
      ],
      pin: "1234",
    };
  }
  return {
    type: "MOBILE_WALLET",
    ids: ["0911111111", "0912222222", "0910000005", "0910000061", "0910000999"],
    pin: "1234",
  };
};

export const defaultAccountForRail = (rail: RailDescriptor): { identifier: string } =>
  ({ identifier: instrumentForRail(rail).ids[0] });

const personasFor = (rail: RailDescriptor): Array<{
  identifier: string;
  name: string;
  available: string;
  limit: string;
  spent: string;
  status: FakeAccountStatus;
  fault: string | null;
  notes: string;
  staticOtp: string | null;
}> => {
  const spec = instrumentForRail(rail);
  return [
    {
      identifier: spec.ids[0],
      name: `${rail.name} — High-Balance Test Account`,
      available: "50000.0000",
      limit: "25000.0000",
      spent: "0.0000",
      status: "ACTIVE",
      fault: null,
      notes: "Default rich test account; succeeds for all normal amounts",
      staticOtp: null,
    },
    {
      identifier: spec.ids[1],
      name: `${rail.name} — Standard Test Account`,
      available: "1500.0000",
      limit: "2000.0000",
      spent: "0.0000",
      status: "ACTIVE",
      fault: null,
      notes: "Standard retail customer balance (1,500 LYD)",
      staticOtp: null,
    },
    {
      identifier: spec.ids[2],
      name: `${rail.name} — Low Balance Account (5 LYD)`,
      available: "5.0000",
      limit: "2000.0000",
      spent: "0.0000",
      status: "ACTIVE",
      fault: null,
      notes: "Fails with INSUFFICIENT_FUNDS for any charge above 5.0000 LYD",
      staticOtp: null,
    },
    {
      identifier: spec.ids[3],
      name: `${rail.name} — Near Daily Limit (5 LYD Remaining)`,
      available: "5000.0000",
      limit: "50.0000",
      spent: "45.0000",
      status: "ACTIVE",
      fault: null,
      notes: "Has 5,000 LYD balance but only 5 LYD left on the daily limit -> LIMIT_EXCEEDED",
      staticOtp: null,
    },
    {
      identifier: spec.ids[4],
      name: `${rail.name} — Frozen / Blocked Account`,
      available: "10000.0000",
      limit: "5000.0000",
      spent: "0.0000",
      status: "FROZEN",
      fault: "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
      notes: "Account status is FROZEN -> rejected immediately at INITIATE",
      staticOtp: null,
    },
  ];
};

let seededForPath: string | null = null;

/** Seeds the five canonical personas for every emulated rail, exactly once per process. */
export function ensureDefaultFakeAccountsSeeded(): void {
  const path = databasePath();
  if (seededForPath === path) return;
  const db = getDb();
  const now = nowIso();
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO fake_accounts (
      id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
      holder_name, secret_pin, expiry, currency, available_balance_lyd,
      reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, status,
      static_otp, preset_fault, notes, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '12/28', 'LYD', ?, '0.0000', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPool = db.prepare(`
    INSERT OR IGNORE INTO fake_merchant_clearing_pools (
      id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
      accumulated_gateway_fee_lyd, tx_count, updated_at
    ) VALUES (?, ?, ?, '0.0000', '0.0000', '0.0000', 0, ?)
  `);

  db.transaction(() => {
    for (const rail of RAIL_DESCRIPTORS) {
      insertPool.run(uuidv7(), rail.gatewayCode, rail.railCode, now);
      const spec = instrumentForRail(rail);
      for (const persona of personasFor(rail)) {
        insertAccount.run(
          uuidv7(),
          rail.railCode,
          rail.gatewayCode,
          spec.type,
          persona.identifier,
          persona.name,
          spec.pin,
          persona.available,
          persona.limit,
          persona.spent,
          persona.status,
          persona.staticOtp,
          persona.fault,
          persona.notes,
          now,
          now,
        );
      }
    }
  })();
  seededForPath = path;
}

export function listFakeAccounts(filters?: {
  railCode?: string;
  gatewayCode?: string;
  merchantId?: string;
}): FakeAccountRow[] {
  ensureDefaultFakeAccountsSeeded();
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters?.railCode) {
    clauses.push("rail_code = ?");
    params.push(filters.railCode);
  }
  if (filters?.gatewayCode) {
    clauses.push("gateway_code = ?");
    params.push(filters.gatewayCode);
  }
  if (filters?.merchantId) {
    clauses.push("(merchant_id IS NULL OR merchant_id = ?)");
    params.push(filters.merchantId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT * FROM fake_accounts ${where} ORDER BY rail_code ASC, created_at ASC, identifier ASC`)
    .all(...(params as never[])) as FakeAccountRow[];
}

export function getFakeAccount(accountId: string): FakeAccountRow | null {
  ensureDefaultFakeAccountsSeeded();
  return (getDb().prepare("SELECT * FROM fake_accounts WHERE id = ?").get(accountId) as FakeAccountRow | null) ?? null;
}

export function listAccountMovements(accountId: string, limit = 100): FakeAccountMovementRow[] {
  const bounded = Math.min(Math.max(limit, 1), 500);
  return getDb()
    .prepare("SELECT * FROM fake_account_movements WHERE account_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(accountId, bounded) as FakeAccountMovementRow[];
}

export function findAccountHoldForTransaction(transactionId: string): FakeAccountHoldRow | null {
  return (getDb()
    .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
    .get(transactionId) as FakeAccountHoldRow | null) ?? null;
}

export function findOrAutoCreateAccount(
  railCode: string,
  gatewayCode: string,
  identifier: string | null,
): FakeAccountRow {
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  const cleanId = (identifier ?? "").replace(/\s+/g, "").trim();

  if (cleanId) {
    const exact = db
      .prepare("SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? LIMIT 1")
      .get(railCode, cleanId) as FakeAccountRow | undefined;
    if (exact) return exact;

    const byGateway = db
      .prepare("SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? LIMIT 1")
      .get(gatewayCode, cleanId) as FakeAccountRow | undefined;
    if (byGateway) return byGateway;

    const rail = resolveRail(railCode) ?? RAIL_DESCRIPTORS.find((entry) => entry.gatewayCode === gatewayCode);
    const spec = rail ? instrumentForRail(rail) : { type: "MOBILE_WALLET" as const, pin: "1234" };
    const now = nowIso();
    const newId = uuidv7();
    db.prepare(`
      INSERT INTO fake_accounts (
        id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
        holder_name, secret_pin, expiry, currency, available_balance_lyd,
        reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, status,
        static_otp, preset_fault, notes, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '12/28', 'LYD', '2500.0000', '0.0000', '5000.0000', '0.0000', 'ACTIVE', NULL, NULL, 'Auto-created on checkout', ?, ?)
    `).run(newId, railCode, gatewayCode, spec.type, cleanId, `Ad-hoc Test Account (${cleanId})`, spec.pin, now, now);
    return db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(newId) as FakeAccountRow;
  }

  const fallback = db
    .prepare(
      "SELECT * FROM fake_accounts WHERE (rail_code = ? OR gateway_code = ?) AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1",
    )
    .get(railCode, gatewayCode) as FakeAccountRow | undefined;
  if (fallback) return fallback;

  throw new Error(`No fake account available for rail=${railCode}`);
}

const decline = (
  account: FakeAccountRow,
  code: FakeDeclineCode,
  message: string,
): HoldCheckResult => ({ allowed: false, declineCode: code, declineMessage: message, account });

/**
 * Executed when a payment starts: checks status, daily limit and available
 * balance, then places an atomic reservation hold on the account.
 */
export function reserveAccountFundsForTransaction(params: {
  railCode: string;
  gatewayCode: string;
  identifier: string | null;
  transactionId: string;
  amountLyd: string;
}): HoldCheckResult {
  const db = getDb();
  return db.transaction(() => {
    const account = findOrAutoCreateAccount(params.railCode, params.gatewayCode, params.identifier);
    const existingHold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(params.transactionId) as FakeAccountHoldRow | undefined;
    if (existingHold) {
      return { allowed: true, account };
    }

    const forcedFault = account.preset_fault?.toUpperCase() ?? "";
    if (account.status !== "ACTIVE") {
      return decline(account, "ACCOUNT_FROZEN", `Account ${account.identifier} is ${account.status}`);
    }
    if (forcedFault === "INSUFFICIENT_FUNDS") {
      return decline(account, "INSUFFICIENT_FUNDS", `Account ${account.identifier} was preset to decline for insufficient funds`);
    }
    if (forcedFault === "LIMIT_EXCEEDED") {
      return decline(account, "LIMIT_EXCEEDED", `Account ${account.identifier} was preset to decline for its daily limit`);
    }

    const requested = toMicros(params.amountLyd);
    const available = toMicros(account.available_balance_lyd);
    const reserved = toMicros(account.reserved_balance_lyd);
    const limit = toMicros(account.daily_limit_lyd);
    const spent = toMicros(account.daily_spent_lyd);

    if (requested <= 0n) {
      return decline(account, "INSUFFICIENT_FUNDS", `The requested amount must be greater than zero`);
    }
    if (available < requested) {
      return decline(
        account,
        "INSUFFICIENT_FUNDS",
        `Account ${account.identifier} available balance (${account.available_balance_lyd} LYD) is less than requested (${params.amountLyd} LYD)`,
      );
    }
    if (spent + requested > limit) {
      return decline(
        account,
        "LIMIT_EXCEEDED",
        `Account ${account.identifier} daily limit (${account.daily_limit_lyd} LYD) exceeded (already spent: ${account.daily_spent_lyd} LYD)`,
      );
    }

    const newAvailable = fromMicros(available - requested);
    const newReserved = fromMicros(reserved + requested);
    const now = nowIso();
    db.prepare(
      "UPDATE fake_accounts SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ? WHERE id = ?",
    ).run(newAvailable, newReserved, now, account.id);
    db.prepare(
      `INSERT INTO fake_account_holds (id, account_id, transaction_id, amount_lyd, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'HELD', ?, ?)`,
    ).run(uuidv7(), account.id, params.transactionId, fromMicros(requested), now, now);
    db.prepare(
      `INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?, ?, ?, 'HOLD', ?, ?, ?, 'Payment initiated hold', 'switch', ?)`,
    ).run(uuidv7(), account.id, params.transactionId, fromMicros(requested), account.available_balance_lyd, newAvailable, now);
    updateTransaction(params.transactionId, {
      account_id: account.id,
      held_amount_lyd: fromMicros(requested),
    });

    const updated = db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(account.id) as FakeAccountRow;
    return { allowed: true, account: updated };
  })();
}

const creditClearingPool = (
  db: ReturnType<typeof getDb>,
  transaction: { gateway_code: string; rail_code: string; gateway_fee_lyd: string } | null,
  amountLyd: string,
  now: string,
): void => {
  if (!transaction) return;
  const existing = db
    .prepare("SELECT * FROM fake_merchant_clearing_pools WHERE gateway_code = ? AND rail_code = ?")
    .get(transaction.gateway_code, transaction.rail_code) as
      | { id: string; pending_settlement_lyd: string; accumulated_gateway_fee_lyd: string; tx_count: number }
      | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO fake_merchant_clearing_pools (
        id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
        accumulated_gateway_fee_lyd, tx_count, updated_at
      ) VALUES (?, ?, ?, ?, '0.0000', ?, 1, ?)`,
    ).run(uuidv7(), transaction.gateway_code, transaction.rail_code, amountLyd, transaction.gateway_fee_lyd, now);
    return;
  }
  db.prepare(
    `UPDATE fake_merchant_clearing_pools
        SET pending_settlement_lyd = ?, accumulated_gateway_fee_lyd = ?, tx_count = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    addLyd(existing.pending_settlement_lyd, amountLyd),
    addLyd(existing.accumulated_gateway_fee_lyd, transaction.gateway_fee_lyd),
    existing.tx_count + 1,
    now,
    existing.id,
  );
};

/** Captures the held funds, increments the daily spend and credits the clearing pool. */
export function captureAccountHoldForTransaction(
  transactionId: string,
  settledOverrideLyd?: string,
): FakeAccountRow | null {
  const db = getDb();
  return db.transaction(() => {
    const hold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(transactionId) as FakeAccountHoldRow | undefined;
    if (!hold) return null;
    const account = db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(hold.account_id) as FakeAccountRow;
    if (!account) return null;
    if (hold.state === "CAPTURED") return account;

    const holdMicros = toMicros(hold.amount_lyd);
    const captureMicros = settledOverrideLyd ? toMicros(settledOverrideLyd) : holdMicros;
    const reservedMicros = toMicros(account.reserved_balance_lyd);
    const spentMicros = toMicros(account.daily_spent_lyd);
    const availableMicros = toMicros(account.available_balance_lyd);

    const nextReserved = reservedMicros >= holdMicros ? reservedMicros - holdMicros : 0n;
    // A partial capture returns the unused part of the hold; a capture above
    // the hold (the variance scenario) draws the difference from available.
    const delta = captureMicros - holdMicros;
    const nextAvailable = availableMicros - delta;
    const nextSpent = spentMicros + captureMicros;
    const now = nowIso();

    db.prepare(
      `UPDATE fake_accounts
          SET available_balance_lyd = ?, reserved_balance_lyd = ?, daily_spent_lyd = ?, updated_at = ?
        WHERE id = ?`,
    ).run(fromMicros(nextAvailable), fromMicros(nextReserved), fromMicros(nextSpent), now, account.id);
    db.prepare("UPDATE fake_account_holds SET state = 'CAPTURED', updated_at = ? WHERE id = ?").run(now, hold.id);
    db.prepare(
      `INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?, ?, ?, 'CAPTURE', ?, ?, ?, 'Payment confirmed & settled', 'switch', ?)`,
    ).run(uuidv7(), account.id, transactionId, fromMicros(captureMicros), account.available_balance_lyd, fromMicros(nextAvailable), now);

    const transaction = db
      .prepare("SELECT gateway_code, rail_code, gateway_fee_lyd FROM fake_transactions WHERE id = ?")
      .get(transactionId) as { gateway_code: string; rail_code: string; gateway_fee_lyd: string } | undefined;
    creditClearingPool(db, transaction ?? null, fromMicros(captureMicros), now);
    updateTransaction(transactionId, { account_id: account.id, held_amount_lyd: hold.amount_lyd });

    return db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(account.id) as FakeAccountRow;
  })();
}

/** Releases a hold back to the available balance (cancel, decline or expiry). */
export function releaseAccountHoldForTransaction(
  transactionId: string,
  reason = "Payment cancelled or declined",
): FakeAccountRow | null {
  const db = getDb();
  return db.transaction(() => {
    const hold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(transactionId) as FakeAccountHoldRow | undefined;
    if (!hold) return null;
    const account = db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(hold.account_id) as FakeAccountRow;
    if (!account) return null;
    if (hold.state !== "HELD") return account;

    const holdMicros = toMicros(hold.amount_lyd);
    const availableMicros = toMicros(account.available_balance_lyd);
    const reservedMicros = toMicros(account.reserved_balance_lyd);
    const nextAvailable = fromMicros(availableMicros + holdMicros);
    const nextReserved = fromMicros(reservedMicros >= holdMicros ? reservedMicros - holdMicros : 0n);
    const now = nowIso();

    db.prepare(
      "UPDATE fake_accounts SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ? WHERE id = ?",
    ).run(nextAvailable, nextReserved, now, account.id);
    db.prepare("UPDATE fake_account_holds SET state = 'RELEASED', updated_at = ? WHERE id = ?").run(now, hold.id);
    db.prepare(
      `INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?, ?, ?, 'RELEASE', ?, ?, ?, ?, 'switch', ?)`,
    ).run(uuidv7(), account.id, transactionId, hold.amount_lyd, account.available_balance_lyd, nextAvailable, reason, now);
    return db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(account.id) as FakeAccountRow;
  })();
}

/** Refunds a captured payment back to the customer account. */
export function creditRefundToAccount(
  transactionId: string,
  amountLyd?: string,
  reason = "Payment refunded",
): FakeAccountRow | null {
  const db = getDb();
  return db.transaction(() => {
    const hold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(transactionId) as FakeAccountHoldRow | undefined;
    const transaction = db
      .prepare("SELECT account_id, normalized_amount_lyd FROM fake_transactions WHERE id = ?")
      .get(transactionId) as { account_id: string | null; normalized_amount_lyd: string } | undefined;
    const accountId = hold?.account_id ?? transaction?.account_id ?? null;
    if (!accountId) return null;
    const account = db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(accountId) as FakeAccountRow;
    if (!account) return null;

    const credit = toMicros(amountLyd ?? hold?.amount_lyd ?? transaction?.normalized_amount_lyd ?? "0");
    if (credit <= 0n) return account;
    const before = toMicros(account.available_balance_lyd);
    const after = fromMicros(before + credit);
    const now = nowIso();
    db.prepare("UPDATE fake_accounts SET available_balance_lyd = ?, updated_at = ? WHERE id = ?").run(
      after,
      now,
      account.id,
    );
    db.prepare(
      `INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?, ?, ?, 'REFUND_CREDIT', ?, ?, ?, ?, 'switch', ?)`,
    ).run(uuidv7(), account.id, transactionId, fromMicros(credit), account.available_balance_lyd, after, reason, now);
    return db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(account.id) as FakeAccountRow;
  })();
}

export interface SettlementResult {
  allowed: boolean;
  declineCode?: FakeDeclineCode;
  declineMessage?: string;
  account: FakeAccountRow | null;
}

/**
 * Settles a payment success: captures an existing hold or, when the rail has no
 * separate initiate phase (e.g. the Moamalat confirm path), reserves and
 * captures in one step.
 */
export function settleAccountForTransaction(params: {
  railCode: string;
  gatewayCode: string;
  identifier: string | null;
  transactionId: string;
  amountLyd: string;
  settledAmountLyd?: string;
}): SettlementResult {
  const existing = findAccountHoldForTransaction(params.transactionId);
  if (existing?.state === "CAPTURED") {
    return { allowed: true, account: getFakeAccount(existing.account_id) };
  }
  if (existing?.state === "HELD") {
    return { allowed: true, account: captureAccountHoldForTransaction(params.transactionId, params.settledAmountLyd) };
  }
  if (existing?.state === "RELEASED") {
    return { allowed: true, account: getFakeAccount(existing.account_id) };
  }
  const reservation = reserveAccountFundsForTransaction(params);
  if (!reservation.allowed) {
    return { allowed: false, declineCode: reservation.declineCode, declineMessage: reservation.declineMessage, account: reservation.account };
  }
  return {
    allowed: true,
    account: captureAccountHoldForTransaction(params.transactionId, params.settledAmountLyd) ?? reservation.account,
  };
}

/** User/test-driven balance, limit, status, OTP or fault adjustment. */
export function adjustFakeAccountBalance(params: {
  accountId: string;
  availableBalanceLyd?: string;
  dailyLimitLyd?: string;
  dailySpentLyd?: string;
  status?: FakeAccountStatus;
  staticOtp?: string | null;
  presetFault?: string | null;
  actor?: string;
  reason?: string;
}): FakeAccountRow {
  const db = getDb();
  return db.transaction(() => {
    const account = db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(params.accountId) as
      | FakeAccountRow
      | undefined;
    if (!account) {
      throw new Error(`Fake account ${params.accountId} not found`);
    }
    const nextAvailable =
      params.availableBalanceLyd !== undefined ? fromMicros(toMicros(params.availableBalanceLyd)) : account.available_balance_lyd;
    const nextLimit =
      params.dailyLimitLyd !== undefined ? fromMicros(toMicros(params.dailyLimitLyd)) : account.daily_limit_lyd;
    const nextSpent =
      params.dailySpentLyd !== undefined ? fromMicros(toMicros(params.dailySpentLyd)) : account.daily_spent_lyd;
    const nextStatus = params.status ?? account.status;
    const nextOtp = params.staticOtp !== undefined ? params.staticOtp : account.static_otp;
    const nextFault = params.presetFault !== undefined ? params.presetFault : account.preset_fault;
    const now = nowIso();

    db.prepare(
      `UPDATE fake_accounts
          SET available_balance_lyd = ?, daily_limit_lyd = ?, daily_spent_lyd = ?, status = ?,
              static_otp = ?, preset_fault = ?, updated_at = ?
        WHERE id = ?`,
    ).run(nextAvailable, nextLimit, nextSpent, nextStatus, nextOtp, nextFault, now, account.id);

    if (nextAvailable !== account.available_balance_lyd) {
      const difference = toMicros(nextAvailable) - toMicros(account.available_balance_lyd);
      db.prepare(
        `INSERT INTO fake_account_movements (
          id, account_id, transaction_id, direction, amount_lyd,
          available_before_lyd, available_after_lyd, reason, actor, created_at
        ) VALUES (?, ?, NULL, 'BALANCE_ADJUSTMENT', ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuidv7(),
        account.id,
        fromMicros(difference >= 0n ? difference : -difference),
        account.available_balance_lyd,
        nextAvailable,
        params.reason ?? "Manual sandbox balance adjustment",
        params.actor ?? "sandbox-user",
        now,
      );
    }
    return db.prepare("SELECT * FROM fake_accounts WHERE id = ?").get(account.id) as FakeAccountRow;
  })();
}

/**
 * Restores the canonical personas and (optionally) clears every merchant-owned
 * test account, so a sandbox workspace reset starts from a known state.
 */
export function resetFakeAccountsToDefaults(merchantId?: string): { removedAccounts: number; resetAccounts: number } {
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  return db.transaction(() => {
    let removedAccounts = 0;
    if (merchantId) {
      const rows = db.prepare("SELECT id FROM fake_accounts WHERE merchant_id = ?").all(merchantId) as Array<{ id: string }>;
      for (const row of rows) {
        db.prepare("DELETE FROM fake_accounts WHERE id = ?").run(row.id);
        removedAccounts += 1;
      }
    }

    let resetAccounts = 0;
    const now = nowIso();
    for (const rail of RAIL_DESCRIPTORS) {
      for (const persona of personasFor(rail)) {
        db.prepare(
          `UPDATE fake_accounts
              SET available_balance_lyd = ?, reserved_balance_lyd = '0.0000', daily_limit_lyd = ?,
                  daily_spent_lyd = ?, status = ?, static_otp = ?, preset_fault = ?, updated_at = ?
            WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL`,
        ).run(
          persona.available,
          persona.limit,
          persona.spent,
          persona.status,
          persona.staticOtp,
          persona.fault,
          now,
          rail.railCode,
          persona.identifier,
        );
        const account = db
          .prepare("SELECT id FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL")
          .get(rail.railCode, persona.identifier) as { id: string } | undefined;
        if (account) {
          db.prepare("DELETE FROM fake_account_holds WHERE account_id = ?").run(account.id);
          db.prepare("DELETE FROM fake_account_movements WHERE account_id = ?").run(account.id);
          resetAccounts += 1;
        }
      }
    }
    db.prepare("DELETE FROM fake_merchant_clearing_pools").run();
    for (const rail of RAIL_DESCRIPTORS) {
      db.prepare(
        `INSERT OR IGNORE INTO fake_merchant_clearing_pools (
          id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
          accumulated_gateway_fee_lyd, tx_count, updated_at
        ) VALUES (?, ?, ?, '0.0000', '0.0000', '0.0000', 0, ?)`,
      ).run(uuidv7(), rail.gatewayCode, rail.railCode, now);
    }
    return { removedAccounts, resetAccounts };
  })();
}

/** The five personas for a rail, used by tests and by the checkout inspector. */
export function canonicalPersonaIdentifiers(rail: RailDescriptor): string[] {
  return personasFor(rail).map((persona) => persona.identifier);
}
