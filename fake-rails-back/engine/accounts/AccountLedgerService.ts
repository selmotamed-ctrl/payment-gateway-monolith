import { getDb, nowIso, uuidv7, type FakeTransactionRow } from "../db";
import {
  RAIL_DESCRIPTORS,
  resolveRail,
  type RailDescriptor,
} from "../chaos/DefaultRailScenarios";

/**
 * Stateful Fake Rails v2 account ledger.
 *
 * Every emulated rail now has real test customer accounts with a controllable
 * available/reserved balance, a daily limit, a status and an optional static
 * OTP. A payment reserves the amount at INITIATE, captures it at SUBMIT and
 * releases it on decline/cancel. Balances are stored as 4-decimal LYD strings
 * and manipulated as integer micros (`1 LYD = 10_000 micros`) so no floating
 * point rounding can leak into a test balance.
 */

export type FakeInstrumentType = "MOBILE_WALLET" | "BANK_ACCOUNT" | "CARD" | "VOUCHER";
export type FakeAccountStatus = "ACTIVE" | "FROZEN" | "EXPIRED" | "BLOCKED";
export type FakeHoldState = "HELD" | "CAPTURED" | "RELEASED";

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
  daily_spent_date: string | null;
  status: FakeAccountStatus;
  static_otp: string | null;
  preset_fault: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeHoldRow {
  id: string;
  account_id: string;
  transaction_id: string;
  amount_lyd: string;
  state: FakeHoldState;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const MICROS = 10_000n;

const TIME_ZONE = (): string => String(process.env.FAKE_RAILS_TIMEZONE ?? "Africa/Tripoli").trim() || "Africa/Tripoli";

/** The business date (`YYYY-MM-DD`) used by the daily limits. */
export const businessDate = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

export const toMicros = (lyd: string | number): bigint => {
  const raw = String(lyd).replace(/[^0-9.-]/g, "");
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return 0n;
  return BigInt(Math.round(numeric * Number(MICROS)));
};

export const fromMicros = (micros: bigint): string => {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const whole = abs / MICROS;
  const fraction = (abs % MICROS).toString().padStart(4, "0");
  return `${sign}${whole.toString()}.${fraction}`;
};

const CARD_GATEWAYS = new Set([
  "moamalat",
  "mpgs",
  "numo_pay",
  "tadawul",
  "tlync",
  "mypay",
  "dpay",
  "plutu",
]);

interface InstrumentSpec {
  type: FakeInstrumentType;
  identifiers: [string, string, string, string, string];
  pin: string;
}

const instrumentForRail = (rail: RailDescriptor, railIndex: number): InstrumentSpec => {
  if (CARD_GATEWAYS.has(rail.gatewayCode)) {
    const prefix = rail.gatewayCode === "mpgs" ? "512345" : "628000";
    const mid = String(railIndex + 1).padStart(2, "0");
    return {
      type: "CARD",
      identifiers: [
        `${prefix}${mid}0000001`,
        `${prefix}${mid}0000002`,
        `${prefix}${mid}0000005`,
        `${prefix}${mid}0000061`,
        `${prefix}${mid}0000999`,
      ],
      pin: "123",
    };
  }
  if (rail.gatewayCode === "neompay") {
    return {
      type: "MOBILE_WALLET",
      identifiers: [
        `NEOM-WALLET-${railIndex}-RICH`,
        `NEOM-WALLET-${railIndex}-STD`,
        `NEOM-WALLET-${railIndex}-LOW`,
        `NEOM-WALLET-${railIndex}-LIM`,
        `NEOM-WALLET-${railIndex}-FRZ`,
      ],
      pin: "1234",
    };
  }
  const suffix = String(railIndex % 10);
  return {
    type: "MOBILE_WALLET",
    identifiers: [
      `091${suffix}000001`,
      `091${suffix}000002`,
      `091${suffix}000005`,
      `091${suffix}000061`,
      `091${suffix}000999`,
    ],
    pin: "1234",
  };
};

const persona = (rail: RailDescriptor, index: number) => {
  switch (index) {
    case 0:
      return {
        holder: `${rail.name} — High-Balance Test Account`,
        available: "50000.0000",
        limit: "25000.0000",
        spent: "0.0000",
        status: "ACTIVE" as FakeAccountStatus,
        fault: null as string | null,
        notes: "Default rich test account; succeeds for normal amounts",
      };
    case 1:
      return {
        holder: `${rail.name} — Standard Test Account`,
        available: "1500.0000",
        limit: "2000.0000",
        spent: "0.0000",
        status: "ACTIVE" as FakeAccountStatus,
        fault: null as string | null,
        notes: "Standard retail balance (1,500 LYD)",
      };
    case 2:
      return {
        holder: `${rail.name} — Low Balance Account`,
        available: "5.0000",
        limit: "2000.0000",
        spent: "0.0000",
        status: "ACTIVE" as FakeAccountStatus,
        fault: null as string | null,
        notes: "Fails with INSUFFICIENT_FUNDS above 5 LYD",
      };
    case 3:
      return {
        holder: `${rail.name} — Near Daily Limit`,
        available: "5000.0000",
        limit: "50.0000",
        spent: "45.0000",
        status: "ACTIVE" as FakeAccountStatus,
        fault: null as string | null,
        notes: "Only 5 LYD left on the daily limit -> LIMIT_EXCEEDED",
      };
    default:
      return {
        holder: `${rail.name} — Frozen Test Account`,
        available: "10000.0000",
        limit: "5000.0000",
        spent: "0.0000",
        status: "FROZEN" as FakeAccountStatus,
        fault: "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
        notes: "FROZEN status declines immediately at INITIATE",
      };
  }
};

export const ensureDefaultFakeAccountsSeeded = (): void => {
  const db = getDb();
  const now = nowIso();
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO fake_accounts (
      id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
      holder_name, secret_pin, expiry, currency, available_balance_lyd,
      reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date, status,
      static_otp, preset_fault, notes, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '12/28', 'LYD', ?, '0.0000', ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `);
  const insertPool = db.prepare(`
    INSERT OR IGNORE INTO fake_merchant_clearing_pools (
      id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
      accumulated_gateway_fee_lyd, tx_count, updated_at
    ) VALUES (?, ?, ?, '0.0000', '0.0000', '0.0000', 0, ?)
  `);

  db.transaction(() => {
    RAIL_DESCRIPTORS.forEach((rail, railIndex) => {
      insertPool.run(uuidv7(), rail.gatewayCode, rail.railCode, now);
      const spec = instrumentForRail(rail, railIndex);
      spec.identifiers.forEach((identifier, personaIndex) => {
        const p = persona(rail, personaIndex);
        insertAccount.run(
          uuidv7(),
          rail.railCode,
          rail.gatewayCode,
          spec.type,
          identifier,
          p.holder,
          spec.pin,
          p.available,
          p.limit,
          p.spent,
          businessDate(),
          p.status,
          p.fault,
          p.notes,
          now,
          now,
        );
      });
    });
  }).immediate();
};

export interface ListAccountFilters {
  railCode?: string;
  gatewayCode?: string;
  merchantId?: string;
  status?: string;
  instrumentType?: string;
  scope?: string;
  createdFrom?: string;
  createdTo?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  /** Include the shared preset rows together with the merchant copies. */
  includeGlobal?: boolean;
}

const accountWhere = (filters: ListAccountFilters): { where: string; params: Array<string | number> } => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filters.railCode) {
    clauses.push("rail_code = ?");
    params.push(filters.railCode);
  }
  if (filters.gatewayCode) {
    clauses.push("gateway_code = ?");
    params.push(filters.gatewayCode);
  }
  if (filters.merchantId) {
    clauses.push(filters.includeGlobal ? "(merchant_id = ? OR merchant_id IS NULL)" : "merchant_id = ?");
    params.push(filters.merchantId);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.instrumentType) {
    clauses.push("instrument_type = ?");
    params.push(filters.instrumentType);
  }
  if (filters.scope === "GLOBAL") {
    clauses.push("merchant_id IS NULL");
  } else if (filters.scope === "MERCHANT") {
    clauses.push("merchant_id IS NOT NULL");
  }
  if (filters.createdFrom) {
    clauses.push("created_at >= ?");
    params.push(filters.createdFrom);
  }
  if (filters.createdTo) {
    clauses.push("created_at <= ?");
    params.push(filters.createdTo);
  }
  if (filters.search) {
    clauses.push("(identifier LIKE ? OR holder_name LIKE ? OR notes LIKE ?)");
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
};

/**
 * Creates the merchant-owned copies of the shared presets. The copy is
 * idempotent and keeps the same identifier, so the checkout form, card
 * validators and protocol fields stay valid.
 */
export const ensureMerchantPresetAccounts = (merchantId: string): void => {
  if (!merchantId) return;
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  const now = nowIso();
  const today = businessDate();
  const globals = db
    .prepare("SELECT * FROM fake_accounts WHERE merchant_id IS NULL")
    .all() as FakeAccountRow[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO fake_accounts (
      id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
      holder_name, secret_pin, expiry, currency, available_balance_lyd,
      reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date,
      status, static_otp, preset_fault, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?, '0.0000', ?, '0.0000', ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const account of globals) {
      insert.run(
        uuidv7(),
        account.rail_code,
        account.gateway_code,
        merchantId,
        account.instrument_type,
        account.identifier,
        account.holder_name,
        account.secret_pin,
        account.expiry ?? "12/28",
        account.currency,
        account.available_balance_lyd,
        account.daily_limit_lyd,
        today,
        account.status,
        account.static_otp,
        account.preset_fault,
        account.notes,
        now,
        now,
      );
    }
  }).immediate();
};

const materializeGlobalForMerchant = (global: FakeAccountRow, merchantId: string): FakeAccountRow => {
  const db = getDb();
  const now = nowIso();
  const id = uuidv7();
  db.prepare(`
    INSERT OR IGNORE INTO fake_accounts (
      id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
      holder_name, secret_pin, expiry, currency, available_balance_lyd,
      reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date,
      status, static_otp, preset_fault, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?, '0.0000', ?, '0.0000', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    global.rail_code,
    global.gateway_code,
    merchantId,
    global.instrument_type,
    global.identifier,
    global.holder_name,
    global.secret_pin,
    global.expiry ?? "12/28",
    global.currency,
    global.available_balance_lyd,
    global.daily_limit_lyd,
    businessDate(),
    global.status,
    global.static_otp,
    global.preset_fault,
    global.notes,
    now,
    now,
  );
  return (db.prepare("SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id = ?")
    .get(global.rail_code, global.identifier, merchantId) as FakeAccountRow | null) ?? global;
};

export const listFakeAccounts = (filters: ListAccountFilters = {}): FakeAccountRow[] => {
  ensureDefaultFakeAccountsSeeded();
  if (filters.merchantId) ensureMerchantPresetAccounts(filters.merchantId);
  const { where, params } = accountWhere(filters);
  return getDb()
    .prepare(`SELECT * FROM fake_accounts ${where} ORDER BY created_at ASC, identifier ASC`)
    .all(...(params as never[])) as FakeAccountRow[];
};

export const listFakeAccountsPage = (
  filters: ListAccountFilters = {},
): { accounts: FakeAccountRow[]; total: number; page: number; pageSize: number } => {
  ensureDefaultFakeAccountsSeeded();
  if (filters.merchantId) ensureMerchantPresetAccounts(filters.merchantId);
  const { where, params } = accountWhere(filters);
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(filters.pageSize ?? 50)));
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM fake_accounts ${where}`).get(...(params as never[])) as { count: number }).count;
  const accounts = db
    .prepare(`SELECT * FROM fake_accounts ${where} ORDER BY created_at ASC, identifier ASC LIMIT ? OFFSET ?`)
    .all(...(params as never[]), pageSize, (page - 1) * pageSize) as FakeAccountRow[];
  return { accounts, total, page, pageSize };
};

export const getFakeAccount = (accountId: string): FakeAccountRow | null =>
  (getDb().prepare("SELECT * FROM fake_accounts WHERE id = ?").get(accountId) as FakeAccountRow | null) ?? null;

export const findFakeAccountByRailIdentifier = (
  railCode: string,
  identifier: string,
  merchantId?: string | null,
): FakeAccountRow | null => {
  if (merchantId) {
    const owned = getDb()
      .prepare("SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id = ? LIMIT 1")
      .get(railCode, identifier, merchantId) as FakeAccountRow | null;
    if (owned) return owned;
  }
  return (
    getDb()
      .prepare(
        merchantId
          ? "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL LIMIT 1"
          : "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? LIMIT 1",
      )
      .get(railCode, identifier) as FakeAccountRow | null
  ) ?? null;
};

export const findAccountForTransaction = (transactionId: string): FakeAccountRow | null => {
  const tx = getDb()
    .prepare("SELECT account_id FROM fake_transactions WHERE id = ?")
    .get(transactionId) as { account_id: string | null } | null;
  return tx?.account_id ? getFakeAccount(tx.account_id) : null;
};

const insertMovement = (input: {
  accountId: string;
  transactionId: string | null;
  direction: string;
  amountLyd: string;
  beforeLyd: string;
  afterLyd: string;
  reason: string;
  actor?: string;
}): void => {
  getDb()
    .prepare(`
      INSERT INTO fake_account_movements (
        id, account_id, transaction_id, direction, amount_lyd,
        available_before_lyd, available_after_lyd, reason, actor, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `)
    .run(
      uuidv7(),
      input.accountId,
      input.transactionId,
      input.direction,
      input.amountLyd,
      input.beforeLyd,
      input.afterLyd,
      input.reason,
      input.actor ?? "switch",
      nowIso(),
    );
};

export const findOrAutoCreateAccount = (input: {
  railCode: string;
  gatewayCode: string;
  identifier: string | null;
  merchantId?: string | null;
}): FakeAccountRow => {
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  const merchantId = input.merchantId?.trim() || null;
  if (merchantId) ensureMerchantPresetAccounts(merchantId);
  const clean = (input.identifier ?? "").replace(/\s+/g, "").trim();

  if (clean) {
    const exact = findFakeAccountByRailIdentifier(input.railCode, clean, merchantId);
    if (exact) {
      // A shared preset is used through a private, editable merchant copy.
      if (merchantId && exact.merchant_id === null) {
        return materializeGlobalForMerchant(exact, merchantId);
      }
      return exact;
    }
    const byGateway = db
      .prepare(
        merchantId
          ? "SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? AND merchant_id = ? LIMIT 1"
          : "SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? LIMIT 1",
      )
      .get(...(merchantId ? [input.gatewayCode, clean, merchantId] : [input.gatewayCode, clean]) as never[]) as FakeAccountRow | undefined;
    if (byGateway) return byGateway;
    if (merchantId) {
      const shared = db
        .prepare("SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? AND merchant_id IS NULL LIMIT 1")
        .get(input.gatewayCode, clean) as FakeAccountRow | undefined;
      if (shared) return materializeGlobalForMerchant(shared, merchantId);
    }

    const now = nowIso();
    const id = uuidv7();
    const rail = resolveRail(input.railCode);
    const spec = rail ? instrumentForRail(rail, RAIL_DESCRIPTORS.indexOf(rail)) : null;
    db.prepare(`
      INSERT INTO fake_accounts (
        id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
        holder_name, secret_pin, expiry, currency, available_balance_lyd,
        reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date,
        status, static_otp, preset_fault, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?, '12/28', 'LYD', '2500.0000', '0.0000', '5000.0000', '0.0000', ?, 'ACTIVE', NULL, NULL, 'Auto-created on checkout', ?, ?)
    `).run(
      id,
      input.railCode,
      input.gatewayCode,
      merchantId,
      spec?.type ?? "MOBILE_WALLET",
      clean,
      `Ad-hoc Test Account (${clean})`,
      spec?.pin ?? "1234",
      businessDate(),
      now,
      now,
    );
    return getFakeAccount(id)!;
  }

  const fallback = db
    .prepare(
      merchantId
        ? `SELECT * FROM fake_accounts
           WHERE (rail_code = ? OR gateway_code = ?) AND status = 'ACTIVE' AND merchant_id = ?
           ORDER BY created_at ASC, identifier ASC LIMIT 1`
        : `SELECT * FROM fake_accounts
           WHERE (rail_code = ? OR gateway_code = ?) AND status = 'ACTIVE'
           ORDER BY created_at ASC, identifier ASC LIMIT 1`,
    )
    .get(...(merchantId ? [input.railCode, input.gatewayCode, merchantId] : [input.railCode, input.gatewayCode]) as never[]) as FakeAccountRow | undefined;
  if (fallback) return fallback;

  throw new Error(`No fake account available for rail=${input.railCode}`);
};

export interface HoldResult {
  allowed: boolean;
  declineCode?: "ACCOUNT_FROZEN" | "ACCOUNT_EXPIRED" | "ACCOUNT_BLOCKED" | "INSUFFICIENT_FUNDS" | "LIMIT_EXCEEDED";
  declineMessage?: string;
  account: FakeAccountRow;
}

/**
 * Daily limits are per business date. A new day starts from zero spent; the
 * date is persisted so a restart does not reset it twice.
 */
const rollDailySpent = (account: FakeAccountRow): FakeAccountRow => {
  const today = businessDate();
  if (account.daily_spent_date === today) return account;
  const now = nowIso();
  getDb()
    .prepare("UPDATE fake_accounts SET daily_spent_lyd = '0.0000', daily_spent_date = ?, updated_at = ? WHERE id = ?")
    .run(today, now, account.id);
  return { ...account, daily_spent_lyd: "0.0000", daily_spent_date: today, updated_at: now };
};

const declineForStatus = (account: FakeAccountRow): HoldResult | null => {
  if (account.status === "ACTIVE") return null;
  const code = account.status === "FROZEN"
    ? "ACCOUNT_FROZEN"
    : account.status === "EXPIRED"
      ? "ACCOUNT_EXPIRED"
      : "ACCOUNT_BLOCKED";
  return {
    allowed: false,
    declineCode: code,
    declineMessage: `Account ${account.identifier} is ${account.status}`,
    account,
  };
};

/**
 * INITIATE: validates status, balance and daily limit and atomically moves the
 * requested amount from available to reserved. Repeating the call for the same
 * transaction is idempotent (the hold row is unique per transaction).
 */
export const reserveAccountFundsForTransaction = (input: {
  railCode: string;
  gatewayCode: string;
  identifier: string | null;
  transactionId: string;
  amountLyd: string;
  merchantId?: string | null;
}): HoldResult => {
  const db = getDb();
  return db.transaction((): HoldResult => {
    let account = findOrAutoCreateAccount({
      railCode: input.railCode,
      gatewayCode: input.gatewayCode,
      identifier: input.identifier,
      merchantId: input.merchantId,
    });
    account = rollDailySpent(account);
    const statusDecline = declineForStatus(account);
    if (statusDecline) return statusDecline;

    const requested = toMicros(input.amountLyd);
    const available = toMicros(account.available_balance_lyd);
    const reserved = toMicros(account.reserved_balance_lyd);
    const remainingDaily = toMicros(account.daily_limit_lyd) - toMicros(account.daily_spent_lyd);

    const existing = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(input.transactionId) as FakeHoldRow | undefined;
    if (!existing) {
      if (available < requested) {
        return {
          allowed: false,
          declineCode: "INSUFFICIENT_FUNDS",
          declineMessage: `Account ${account.identifier} available balance (${account.available_balance_lyd} LYD) is less than requested (${input.amountLyd} LYD)`,
          account,
        };
      }
      if (requested > remainingDaily) {
        return {
          allowed: false,
          declineCode: "LIMIT_EXCEEDED",
          declineMessage: `Account ${account.identifier} daily limit exceeded (limit ${account.daily_limit_lyd} LYD, spent ${account.daily_spent_lyd} LYD)`,
          account,
        };
      }
      const now = nowIso();
      const nextAvailable = fromMicros(available - requested);
      const nextReserved = fromMicros(reserved + requested);
      db.prepare(
        "UPDATE fake_accounts SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ? WHERE id = ?",
      ).run(nextAvailable, nextReserved, now, account.id);
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      db.prepare(`
        INSERT INTO fake_account_holds (id, account_id, transaction_id, amount_lyd, state, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'HELD', ?, ?, ?)
      `).run(uuidv7(), account.id, input.transactionId, fromMicros(requested), expiresAt, now, now);
      insertMovement({
        accountId: account.id,
        transactionId: input.transactionId,
        direction: "HOLD",
        amountLyd: fromMicros(requested),
        beforeLyd: account.available_balance_lyd,
        afterLyd: nextAvailable,
        reason: "Payment initiated hold",
      });
    }

    db.prepare("UPDATE fake_transactions SET account_id = ?, held_amount_lyd = ?, updated_at = ? WHERE id = ?")
      .run(
        account.id,
        fromMicros(requested),
        nowIso(),
        input.transactionId,
      );
    return {
      allowed: true,
      account: getFakeAccount(account.id) ?? account,
    };
  }).immediate();
};

const addClearingEntry = (input: {
  transactionId: string;
  gatewayCode: string;
  railCode: string;
  accountId: string | null;
  ourReference?: string | null;
  providerReference?: string | null;
  currency?: string | null;
  status?: string | null;
  entryType: "CAPTURE" | "REFUND" | "RELEASE";
  amountLyd: string;
  gatewayFeeLyd?: string;
}): void => {
  const db = getDb();
  db.prepare(`
    INSERT INTO fake_clearing_entries (
      id, transaction_id, gateway_code, rail_code, account_id,
      our_reference, provider_reference, currency, status, entry_type,
      amount_lyd, gateway_fee_lyd, settled_at, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
  `).run(
    uuidv7(),
    input.transactionId,
    input.gatewayCode,
    input.railCode,
    input.accountId,
    input.ourReference ?? null,
    input.providerReference ?? null,
    input.currency ?? "LYD",
    input.status ?? "PAID",
    input.entryType,
    input.amountLyd,
    input.gatewayFeeLyd ?? "0.0000",
    nowIso(),
  );

  const delta = input.entryType === "REFUND" ? -toMicros(input.amountLyd) : toMicros(input.amountLyd);
  const fee = input.entryType === "CAPTURE" ? toMicros(input.gatewayFeeLyd ?? "0") : 0n;
  db.prepare(`
    INSERT OR IGNORE INTO fake_merchant_clearing_pools (
      id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
      accumulated_gateway_fee_lyd, tx_count, updated_at
    ) VALUES (?,?,?,'0.0000','0.0000','0.0000',0,?)
  `).run(uuidv7(), input.gatewayCode, input.railCode, nowIso());
  const pool = db
    .prepare("SELECT * FROM fake_merchant_clearing_pools WHERE gateway_code = ? AND rail_code = ?")
    .get(input.gatewayCode, input.railCode) as {
      pending_settlement_lyd: string;
      accumulated_gateway_fee_lyd: string;
      tx_count: number;
    };
  const nextPending = fromMicros(toMicros(pool.pending_settlement_lyd) + delta);
  const nextFee = fromMicros(toMicros(pool.accumulated_gateway_fee_lyd) + fee);
  db.prepare(`
    UPDATE fake_merchant_clearing_pools
       SET pending_settlement_lyd = ?, accumulated_gateway_fee_lyd = ?,
           tx_count = tx_count + ?, updated_at = ?
     WHERE gateway_code = ? AND rail_code = ?
  `).run(
    nextPending,
    nextFee,
    input.entryType === "CAPTURE" ? 1 : 0,
    nowIso(),
    input.gatewayCode,
    input.railCode,
  );
};

/** SUBMIT / hosted APPROVE: captures the held amount and credits the clearing pool. */
export const captureAccountHoldForTransaction = (
  transactionId: string,
  settledOverrideLyd?: string,
): FakeAccountRow | null => {
  const db = getDb();
  return db.transaction((): FakeAccountRow | null => {
    const hold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(transactionId) as FakeHoldRow | undefined;
    if (!hold) return null;
    const found = getFakeAccount(hold.account_id);
    if (!found) return null;
    if (hold.state === "CAPTURED") return found;
    const account = rollDailySpent(found);

    const transaction = db
      .prepare("SELECT * FROM fake_transactions WHERE id = ?")
      .get(transactionId) as FakeTransactionRow | null;
    const heldMicros = toMicros(hold.amount_lyd);
    const capturedMicros = settledOverrideLyd ? toMicros(settledOverrideLyd) : heldMicros;
    const reserved = toMicros(account.reserved_balance_lyd);
    const available = toMicros(account.available_balance_lyd);
    const extra = capturedMicros - heldMicros;
    if (extra > available) {
      throw Object.assign(new Error("The captured amount exceeds the available test balance"), {
        code: "CAPTURE_EXCEEDS_AVAILABLE",
      });
    }
    const nextAvailable = available - extra;
    const nextReserved = reserved >= heldMicros ? reserved - heldMicros : 0n;
    const nextSpent = toMicros(account.daily_spent_lyd) + capturedMicros;
    const now = nowIso();

    db.prepare(`
      UPDATE fake_accounts
         SET available_balance_lyd = ?, reserved_balance_lyd = ?, daily_spent_lyd = ?, daily_spent_date = ?, updated_at = ?
       WHERE id = ?
    `).run(fromMicros(nextAvailable), fromMicros(nextReserved), fromMicros(nextSpent), businessDate(), now, account.id);
    db.prepare("UPDATE fake_account_holds SET state = 'CAPTURED', updated_at = ? WHERE id = ?")
      .run(now, hold.id);
    insertMovement({
      accountId: account.id,
      transactionId,
      direction: "CAPTURE",
      amountLyd: fromMicros(capturedMicros),
      beforeLyd: account.available_balance_lyd,
      afterLyd: fromMicros(nextAvailable),
      reason: "Payment confirmed & settled",
    });
    if (transaction) {
      addClearingEntry({
        transactionId,
        gatewayCode: transaction.gateway_code,
        railCode: transaction.rail_code,
        accountId: account.id,
        ourReference: transaction.our_reference,
        providerReference: transaction.provider_reference,
        currency: transaction.currency,
        status: "PAID",
        entryType: "CAPTURE",
        amountLyd: fromMicros(capturedMicros),
        gatewayFeeLyd: transaction.gateway_fee_lyd,
      });
    }
    return getFakeAccount(account.id);
  }).immediate();
};

/** CANCEL / DECLINE / expiry: returns the held amount to the available balance. */
export const releaseAccountHoldForTransaction = (
  transactionId: string,
  reason = "Payment cancelled or declined",
): FakeAccountRow | null => {
  const db = getDb();
  return db.transaction((): FakeAccountRow | null => {
    const hold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(transactionId) as FakeHoldRow | undefined;
    if (!hold) return null;
    const account = getFakeAccount(hold.account_id);
    if (!account) return null;
    if (hold.state !== "HELD") return account;

    const heldMicros = toMicros(hold.amount_lyd);
    const available = toMicros(account.available_balance_lyd);
    const reserved = toMicros(account.reserved_balance_lyd);
    const nextAvailable = fromMicros(available + heldMicros);
    const nextReserved = fromMicros(reserved >= heldMicros ? reserved - heldMicros : 0n);
    const now = nowIso();
    db.prepare(`
      UPDATE fake_accounts
         SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ?
       WHERE id = ?
    `).run(nextAvailable, nextReserved, now, account.id);
    db.prepare("UPDATE fake_account_holds SET state = 'RELEASED', updated_at = ? WHERE id = ?")
      .run(now, hold.id);
    insertMovement({
      accountId: account.id,
      transactionId,
      direction: "RELEASE",
      amountLyd: hold.amount_lyd,
      beforeLyd: account.available_balance_lyd,
      afterLyd: nextAvailable,
      reason,
    });
    return getFakeAccount(account.id);
  }).immediate();
};

/**
 * REFUND: credits the customer back. A cumulative refund can never exceed the
 * captured amount (`REFUND_EXCEEDS_CAPTURED_AMOUNT`).
 */
export const refundAccountForTransaction = (
  transactionId: string,
  amountLyd?: string,
  reason = "Merchant refund",
): FakeAccountRow | null => {
  const db = getDb();
  return db.transaction((): FakeAccountRow | null => {
    const transaction = db
      .prepare("SELECT * FROM fake_transactions WHERE id = ?")
      .get(transactionId) as FakeTransactionRow | null;
    if (!transaction) return null;
    const account = findAccountForTransaction(transactionId);
    if (!account) return null;

    const captures = db
      .prepare("SELECT amount_lyd FROM fake_clearing_entries WHERE transaction_id = ? AND entry_type = 'CAPTURE'")
      .all(transactionId) as Array<{ amount_lyd: string }>;
    const priorRefunds = db
      .prepare("SELECT amount_lyd FROM fake_clearing_entries WHERE transaction_id = ? AND entry_type = 'REFUND'")
      .all(transactionId) as Array<{ amount_lyd: string }>;
    const capturedMicros = captures.reduce((sum, row) => sum + toMicros(row.amount_lyd), 0n);
    const refundedMicros = priorRefunds.reduce((sum, row) => sum + toMicros(row.amount_lyd), 0n);
    const requested = amountLyd
      ? toMicros(amountLyd)
      : capturedMicros - refundedMicros;
    if (requested <= 0n) {
      throw Object.assign(new Error("The transaction has nothing left to refund"), {
        code: "REFUND_EXCEEDS_CAPTURED_AMOUNT",
      });
    }
    if (refundedMicros + requested > capturedMicros) {
      throw Object.assign(
        new Error(
          `Refund ${fromMicros(requested)} LYD would exceed the captured amount ${fromMicros(capturedMicros)} LYD`,
        ),
        { code: "REFUND_EXCEEDS_CAPTURED_AMOUNT" },
      );
    }

    const nextAvailable = toMicros(account.available_balance_lyd) + requested;
    db.prepare("UPDATE fake_accounts SET available_balance_lyd = ?, updated_at = ? WHERE id = ?")
      .run(fromMicros(nextAvailable), nowIso(), account.id);
    insertMovement({
      accountId: account.id,
      transactionId,
      direction: "REFUND_CREDIT",
      amountLyd: fromMicros(requested),
      beforeLyd: account.available_balance_lyd,
      afterLyd: fromMicros(nextAvailable),
      reason,
    });
    addClearingEntry({
      transactionId,
      gatewayCode: transaction.gateway_code,
      railCode: transaction.rail_code,
      accountId: account.id,
      ourReference: transaction.our_reference,
      providerReference: transaction.provider_reference,
      currency: transaction.currency,
      status: "REFUNDED",
      entryType: "REFUND",
      amountLyd: fromMicros(requested),
    });
    return getFakeAccount(account.id);
  }).immediate();
};

export interface AdjustAccountInput {
  accountId: string;
  availableBalanceLyd?: string;
  deltaLyd?: string;
  dailyLimitLyd?: string;
  dailySpentLyd?: string;
  status?: FakeAccountStatus;
  staticOtp?: string | null;
  presetFault?: string | null;
  actor?: string;
  reason?: string;
}

export const adjustFakeAccountBalance = (input: AdjustAccountInput): FakeAccountRow => {
  const db = getDb();
  return db.transaction((): FakeAccountRow => {
    const found = getFakeAccount(input.accountId);
    if (!found) {
      throw new Error(`Fake account ${input.accountId} not found`);
    }
    const account = rollDailySpent(found);
    const nextAvailable = input.availableBalanceLyd !== undefined
      ? fromMicros(toMicros(input.availableBalanceLyd))
      : input.deltaLyd !== undefined
        ? fromMicros(toMicros(account.available_balance_lyd) + toMicros(input.deltaLyd))
        : account.available_balance_lyd;
    const nextLimit = input.dailyLimitLyd !== undefined
      ? fromMicros(toMicros(input.dailyLimitLyd))
      : account.daily_limit_lyd;
    const nextSpent = input.dailySpentLyd !== undefined
      ? fromMicros(toMicros(input.dailySpentLyd))
      : account.daily_spent_lyd;
    if (toMicros(nextAvailable) < 0n) {
      throw Object.assign(new Error("The test account balance cannot be negative"), {
        code: "NEGATIVE_ACCOUNT_BALANCE",
      });
    }
    if (toMicros(nextLimit) < 0n || toMicros(nextSpent) < 0n) {
      throw Object.assign(new Error("The daily limit and spent amount cannot be negative"), {
        code: "NEGATIVE_DAILY_LIMIT",
      });
    }
    const nextStatus = input.status ?? account.status;
    const nextOtp = input.staticOtp !== undefined ? input.staticOtp : account.static_otp;
    const nextFault = input.presetFault !== undefined ? input.presetFault : account.preset_fault;
    const now = nowIso();
    db.prepare(`
      UPDATE fake_accounts
         SET available_balance_lyd = ?, daily_limit_lyd = ?, daily_spent_lyd = ?, daily_spent_date = ?,
             status = ?, static_otp = ?, preset_fault = ?, updated_at = ?
       WHERE id = ?
    `).run(nextAvailable, nextLimit, nextSpent, businessDate(), nextStatus, nextOtp, nextFault, now, account.id);

    if (nextAvailable !== account.available_balance_lyd) {
      const diff = toMicros(nextAvailable) - toMicros(account.available_balance_lyd);
      insertMovement({
        accountId: account.id,
        transactionId: null,
        direction: "BALANCE_ADJUSTMENT",
        amountLyd: fromMicros(diff >= 0n ? diff : -diff),
        beforeLyd: account.available_balance_lyd,
        afterLyd: nextAvailable,
        reason: input.reason ?? "Manual sandbox balance adjustment",
        actor: input.actor ?? "sandbox-user",
      });
    }
    return getFakeAccount(account.id)!;
  }).immediate();
};

export const listAccountMovements = (accountId: string, limit = 100): unknown[] =>
  getDb()
    .prepare("SELECT * FROM fake_account_movements WHERE account_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(accountId, Math.min(Math.max(limit, 1), 500));

export const listAccountHolds = (accountId: string, limit = 100): unknown[] =>
  getDb()
    .prepare("SELECT * FROM fake_account_holds WHERE account_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(accountId, Math.min(Math.max(limit, 1), 500));

/**
 * Restores a merchant-owned copy from its shared preset. Custom identifiers
 * have no preset and are refused.
 */
export const restorePresetAccount = (accountId: string): FakeAccountRow => {
  const account = getFakeAccount(accountId);
  if (!account) {
    throw Object.assign(new Error(`Fake account ${accountId} not found`), { code: "FAKE_ACCOUNT_NOT_FOUND" });
  }
  if (!account.merchant_id) {
    throw Object.assign(new Error("Shared preset accounts are restored by editing the preset itself"), {
      code: "GLOBAL_ACCOUNT_READONLY",
    });
  }
  const preset = getDb()
    .prepare("SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL LIMIT 1")
    .get(account.rail_code, account.identifier) as FakeAccountRow | null;
  if (!preset) {
    throw Object.assign(new Error("This account has no shared preset to restore"), {
      code: "FAKE_ACCOUNT_PRESET_NOT_FOUND",
    });
  }
  return adjustFakeAccountBalance({
    accountId,
    availableBalanceLyd: preset.available_balance_lyd,
    dailyLimitLyd: preset.daily_limit_lyd,
    dailySpentLyd: "0.0000",
    status: preset.status,
    staticOtp: preset.static_otp,
    presetFault: preset.preset_fault,
    reason: "Restored from the shared Fake Rails preset",
    actor: "sandbox-user",
  });
};

export const resetFakeAccounts = (input: { merchantId?: string | null }): number => {
  ensureDefaultFakeAccountsSeeded();
  const db = getDb();
  let removed = 0;
  db.transaction(() => {
    if (input.merchantId) {
      const rows = db
        .prepare("SELECT id FROM fake_accounts WHERE merchant_id = ?")
        .all(input.merchantId) as Array<{ id: string }>;
      for (const row of rows) {
        db.prepare("DELETE FROM fake_accounts WHERE id = ?").run(row.id);
      }
      removed = rows.length;
    } else {
      const rows = db
        .prepare("SELECT id FROM fake_accounts WHERE merchant_id IS NOT NULL")
        .all() as Array<{ id: string }>;
      for (const row of rows) {
        db.prepare("DELETE FROM fake_accounts WHERE id = ?").run(row.id);
      }
      db.prepare("DELETE FROM fake_accounts WHERE merchant_id IS NULL").run();
      removed = rows.length;
    }
    db.prepare(
      "INSERT INTO fake_account_resets (id, merchant_id, actor, summary_json, created_at) VALUES (?,?,?,?,?)",
    ).run(
      uuidv7(),
      input.merchantId ?? null,
      "sandbox-control",
      JSON.stringify({ removed }),
      nowIso(),
    );
  }).immediate();
  if (!input.merchantId) {
    ensureDefaultFakeAccountsSeeded();
  }
  return removed;
};

export interface ClearingPoolRow {
  gateway_code: string;
  rail_code: string;
  pending_settlement_lyd: string;
  settled_lyd: string;
  accumulated_gateway_fee_lyd: string;
  tx_count: number;
  updated_at: string;
}

export const listClearingPools = (): ClearingPoolRow[] =>
  getDb().prepare("SELECT * FROM fake_merchant_clearing_pools ORDER BY gateway_code ASC").all() as ClearingPoolRow[];

export interface ClearingStatementLine {
  id: string;
  transactionId: string;
  gatewayCode: string;
  railCode: string;
  accountId: string | null;
  ourReference: string | null;
  providerReference: string | null;
  currency: string;
  status: string;
  entryType: string;
  amountLyd: string;
  gatewayFeeLyd: string;
  createdAt: string;
}

export const generateClearingStatement = (input: {
  from?: string;
  to?: string;
  gatewayCode?: string;
  merchantId?: string;
  includeSettled?: boolean;
  includeIncluded?: boolean;
}): { rows: ClearingStatementLine[]; totals: { grossLyd: string; refundsLyd: string; netLyd: string; feesLyd: string }; csv: string } => {
  const clauses: string[] = [];
  if (!input.includeSettled) clauses.push("settled_at IS NULL");
  if (!input.includeIncluded) clauses.push("statement_included_at IS NULL");
  const params: string[] = [];
  if (input.merchantId) {
    clauses.push("(SELECT ftt.merchant_id FROM fake_transactions ftt WHERE ftt.id = fake_clearing_entries.transaction_id) = ?");
    params.push(input.merchantId);
  }
  if (input.from) {
    clauses.push("created_at >= ?");
    params.push(input.from);
  }
  if (input.to) {
    clauses.push("created_at <= ?");
    params.push(input.to);
  }
  if (input.gatewayCode) {
    clauses.push("gateway_code = ?");
    params.push(input.gatewayCode);
  }
  const where = clauses.length > 0 ? clauses.join(" AND ") : "1 = 1";
  const rows = getDb()
    .prepare(`SELECT * FROM fake_clearing_entries WHERE ${where} ORDER BY created_at ASC`)
    .all(...(params as never[])) as Array<{
      id: string;
      transaction_id: string;
      gateway_code: string;
      rail_code: string;
      account_id: string | null;
      our_reference: string | null;
      provider_reference: string | null;
      currency: string;
      status: string;
      entry_type: string;
      amount_lyd: string;
      gateway_fee_lyd: string;
      created_at: string;
    }>;

  let gross = 0n;
  let refunds = 0n;
  let fees = 0n;
  for (const row of rows) {
    if (row.entry_type === "CAPTURE") {
      gross += toMicros(row.amount_lyd);
      fees += toMicros(row.gateway_fee_lyd);
    } else if (row.entry_type === "REFUND") {
      refunds += toMicros(row.amount_lyd);
    }
  }
  const lines: ClearingStatementLine[] = rows.map((row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    gatewayCode: row.gateway_code,
    railCode: row.rail_code,
    accountId: row.account_id,
    ourReference: row.our_reference,
    providerReference: row.provider_reference,
    currency: row.currency,
    status: row.status,
    entryType: row.entry_type,
    amountLyd: row.amount_lyd,
    gatewayFeeLyd: row.gateway_fee_lyd,
    createdAt: row.created_at,
  }));
  const csvHeader = "our_reference,provider_reference,gateway_code,rail_code,currency,status,entry_type,amount_lyd,fee_lyd,occurred_at";
  const csv = [
    csvHeader,
    ...lines.map((line) =>
      [
        line.ourReference ?? "",
        line.providerReference ?? "",
        line.gatewayCode,
        line.railCode,
        line.currency,
        line.status,
        line.entryType === "CAPTURE" ? "SETTLEMENT" : line.entryType === "REFUND" ? "REVERSAL" : line.entryType,
        line.amountLyd,
        line.gatewayFeeLyd,
        line.createdAt,
      ].join(","),
    ),
  ].join("\n");
  return {
    rows: lines,
    totals: {
      grossLyd: fromMicros(gross),
      refundsLyd: fromMicros(refunds),
      netLyd: fromMicros(gross - refunds),
      feesLyd: fromMicros(fees),
    },
    csv,
  };
};

export const markStatementIncluded = (input: { entryIds: string[]; runId: string }): number => {
  if (input.entryIds.length === 0) return 0;
  const db = getDb();
  const now = nowIso();
  return db.transaction((): number => {
    const update = db.prepare(
      "UPDATE fake_clearing_entries SET statement_included_at = ?, statement_run_id = ? WHERE id = ? AND statement_included_at IS NULL",
    );
    let changed = 0;
    for (const id of input.entryIds) changed += Number(update.run(now, input.runId, id).changes ?? 0);
    return changed;
  }).immediate();
};

export const releaseExpiredHolds = (input: { now?: Date } = {}): number => {
  const db = getDb();
  const now = input.now ?? new Date();
  const rows = db
    .prepare("SELECT transaction_id FROM fake_account_holds WHERE state = 'HELD' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(now.toISOString()) as Array<{ transaction_id: string }>;
  let released = 0;
  for (const row of rows) {
    const account = releaseAccountHoldForTransaction(row.transaction_id, "Sandbox hold expired");
    if (account) released += 1;
  }
  return released;
};

export const markClearingSettled = (input: { gatewayCode?: string }): number => {
  const db = getDb();
  return db.transaction((): number => {
    const where = input.gatewayCode ? "WHERE settled_at IS NULL AND gateway_code = ?" : "WHERE settled_at IS NULL";
    const result = input.gatewayCode
      ? db.prepare(`UPDATE fake_clearing_entries SET settled_at = ? ${where}`).run(nowIso(), input.gatewayCode)
      : db.prepare(`UPDATE fake_clearing_entries SET settled_at = ? ${where}`).run(nowIso());
    const clauses = input.gatewayCode ? "WHERE gateway_code = ?" : "";
    db.prepare(`
      UPDATE fake_merchant_clearing_pools
         SET settled_lyd = pending_settlement_lyd, pending_settlement_lyd = '0.0000', updated_at = ?
       ${clauses}
    `).run(...(input.gatewayCode ? [nowIso(), input.gatewayCode] : [nowIso()]));
    return Number(result.changes ?? 0);
  }).immediate();
};
