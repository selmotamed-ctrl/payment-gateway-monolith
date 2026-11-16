import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../../lib/env";

/**
 * The isolated persistence of the emulator.
 *
 * It is a single embedded SQLite database in WAL mode. There is deliberately
 * no MySQL/MariaDB connection string in this service: the fake rails tier can
 * never read or corrupt the gateway ledger.
 */

let instance: Database | undefined;

const schemaSql = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

export const databasePath = (): string =>
  process.env.FAKE_RAILS_DB_PATH ?? join(env.FAKE_RAILS_DATA_DIR, "fake-rails.sqlite");

export const getDb = (): Database => {
  if (instance) return instance;
  const path = databasePath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(schemaSql);
  migrateLegacySchema(db);
  instance = db;
  return db;
};

/**
 * Adds the v2 columns to a database created by the stateless v1 emulator.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so the account
 * link and the held amount are added explicitly and idempotently.
 */
const tableColumns = (db: Database, table: string): Set<string> =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );

const addColumn = (db: Database, table: string, column: string, definition: string): void => {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

/**
 * `fake_accounts` originally had a table-level `UNIQUE(rail_code, identifier)`.
 * Merchant-owned copies need the same identifier as the shared preset, so the
 * table is rebuilt once with partial unique indexes.
 */
const rebuildAccountsForMerchantCopies = (db: Database): void => {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fake_accounts'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || !/UNIQUE\s*\(\s*rail_code\s*,\s*identifier\s*\)/i.test(row.sql)) {
    return;
  }
  const columns = tableColumns(db, "fake_accounts");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE fake_accounts_new (
        id TEXT PRIMARY KEY,
        rail_code TEXT NOT NULL,
        gateway_code TEXT NOT NULL,
        merchant_id TEXT,
        instrument_type TEXT NOT NULL DEFAULT 'MOBILE_WALLET',
        identifier TEXT NOT NULL,
        holder_name TEXT NOT NULL,
        secret_pin TEXT NOT NULL DEFAULT '1234',
        expiry TEXT DEFAULT '12/28',
        currency TEXT NOT NULL DEFAULT 'LYD',
        available_balance_lyd TEXT NOT NULL DEFAULT '5000.0000',
        reserved_balance_lyd TEXT NOT NULL DEFAULT '0.0000',
        daily_limit_lyd TEXT NOT NULL DEFAULT '10000.0000',
        daily_spent_lyd TEXT NOT NULL DEFAULT '0.0000',
        daily_spent_date TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        static_otp TEXT,
        preset_fault TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const carry = [
      "id", "rail_code", "gateway_code", "merchant_id", "instrument_type", "identifier",
      "holder_name", "secret_pin", "expiry", "currency", "available_balance_lyd",
      "reserved_balance_lyd", "daily_limit_lyd", "daily_spent_lyd", "status",
      "static_otp", "preset_fault", "notes", "created_at", "updated_at",
    ].filter((column) => columns.has(column));
    const daily = columns.has("daily_spent_date") ? "daily_spent_date" : "NULL";
    db.exec(
      `INSERT INTO fake_accounts_new (${carry.join(",")}, daily_spent_date)
       SELECT ${carry.join(",")}, ${daily} FROM fake_accounts`,
    );
    db.exec("DROP TABLE fake_accounts");
    db.exec("ALTER TABLE fake_accounts_new RENAME TO fake_accounts");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fake_accounts_global_identifier
        ON fake_accounts(rail_code, identifier) WHERE merchant_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fake_accounts_merchant_identifier
        ON fake_accounts(rail_code, identifier, merchant_id) WHERE merchant_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fake_accounts_rail ON fake_accounts(rail_code, status);
      CREATE INDEX IF NOT EXISTS idx_fake_accounts_gateway ON fake_accounts(gateway_code);
      CREATE INDEX IF NOT EXISTS idx_fake_accounts_merchant ON fake_accounts(merchant_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`fake-rails account migration left ${violations.length} foreign-key violation(s)`);
    }
  }
};

const migrateLegacySchema = (db: Database): void => {
  addColumn(db, "fake_transactions", "account_id", "TEXT");
  addColumn(db, "fake_transactions", "held_amount_lyd", "TEXT");
  addColumn(db, "fake_transactions", "merchant_id", "TEXT");
  addColumn(db, "fake_transactions", "qr_payload", "TEXT");
  addColumn(db, "fake_transactions", "deep_link_url", "TEXT");
  addColumn(db, "fake_transactions", "redirect_url", "TEXT");
  addColumn(db, "fake_account_holds", "expires_at", "TEXT");
  addColumn(db, "fake_accounts", "daily_spent_date", "TEXT");
  addColumn(db, "fake_clearing_entries", "our_reference", "TEXT");
  addColumn(db, "fake_clearing_entries", "provider_reference", "TEXT");
  addColumn(db, "fake_clearing_entries", "currency", "TEXT NOT NULL DEFAULT 'LYD'");
  addColumn(db, "fake_clearing_entries", "status", "TEXT NOT NULL DEFAULT 'PAID'");
  addColumn(db, "fake_clearing_entries", "statement_included_at", "TEXT");
  addColumn(db, "fake_clearing_entries", "statement_run_id", "TEXT");
  rebuildAccountsForMerchantCopies(db);
  db.exec("UPDATE fake_schema_version SET version = 2 WHERE version < 2");
};

export const closeDb = (): void => {
  instance?.close();
  instance = undefined;
};

export const nowIso = (): string => new Date().toISOString();

/** RFC 9562 UUIDv7 (time ordered), used as the primary key of every row. */
export const uuidv7 = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const timestamp = BigInt(Date.now());
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export interface FakeTransactionRow {
  id: string;
  gateway_code: string;
  rail_code: string;
  env: string;
  our_reference: string;
  provider_reference: string;
  network_reference: string | null;
  idempotency_key: string | null;
  requested_amount_wire: string;
  normalized_amount_lyd: string;
  settled_amount_lyd: string | null;
  gateway_fee_lyd: string;
  currency: string;
  collection_mode: string;
  customer_identifier_masked: string | null;
  expected_otp: string | null;
  merchant_id?: string | null;
  qr_payload?: string | null;
  deep_link_url?: string | null;
  redirect_url?: string | null;
  account_id?: string | null;
  held_amount_lyd?: string | null;
  status: string;
  assigned_fail_phase: string | null;
  assigned_failure_mode: string | null;
  inquiry_override_status: string | null;
  return_url: string | null;
  cancel_url: string | null;
  webhook_url: string | null;
  is_seeded_historical: number;
  created_at: string;
  updated_at: string;
}

export interface FakeStepEventRow {
  id: string;
  transaction_id: string | null;
  gateway_code: string;
  phase: string;
  method: string;
  path: string;
  request_headers_json: string;
  request_body_raw: string;
  response_status: number | null;
  response_body_raw: string | null;
  injected_fault: string | null;
  duration_ms: number;
  created_at: string;
}

export const insertTransaction = (row: FakeTransactionRow): void => {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO fake_transactions (
        id, gateway_code, rail_code, env, our_reference, provider_reference, network_reference,
        idempotency_key, requested_amount_wire, normalized_amount_lyd, settled_amount_lyd,
        gateway_fee_lyd, currency, collection_mode, customer_identifier_masked, expected_otp,
        status, assigned_fail_phase, assigned_failure_mode, inquiry_override_status,
        return_url, cancel_url, webhook_url, is_seeded_historical, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id, row.gateway_code, row.rail_code, row.env, row.our_reference, row.provider_reference,
      row.network_reference, row.idempotency_key, row.requested_amount_wire, row.normalized_amount_lyd,
      row.settled_amount_lyd, row.gateway_fee_lyd, row.currency, row.collection_mode,
      row.customer_identifier_masked, row.expected_otp, row.status, row.assigned_fail_phase,
      row.assigned_failure_mode, row.inquiry_override_status, row.return_url, row.cancel_url,
      row.webhook_url, row.is_seeded_historical, row.created_at, row.updated_at,
    );
};

export const findTransactionByReference = (
  gatewayCode: string,
  reference: string,
): FakeTransactionRow | null => {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM fake_transactions
         WHERE gateway_code = ? AND (our_reference = ? OR provider_reference = ? OR network_reference = ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(gatewayCode, reference, reference, reference) as FakeTransactionRow | null) ?? null
  );
};

export const findTransactionAnyReference = (reference: string): FakeTransactionRow | null => {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM fake_transactions
         WHERE our_reference = ? OR provider_reference = ? OR network_reference = ? OR id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(reference, reference, reference, reference) as FakeTransactionRow | null) ?? null
  );
};

export const updateTransaction = (id: string, patch: Partial<FakeTransactionRow>): void => {
  const columns = Object.keys(patch).filter((key) => key !== "id");
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  const values = columns.map((column) => (patch as Record<string, unknown>)[column]);
  getDb()
    .prepare(`UPDATE fake_transactions SET ${assignments}, updated_at = ? WHERE id = ?`)
    .run(...(values as never[]), nowIso(), id);
};

export const insertStepEvent = (row: FakeStepEventRow): void => {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO fake_step_events (
        id, transaction_id, gateway_code, phase, method, path, request_headers_json,
        request_body_raw, response_status, response_body_raw, injected_fault, duration_ms, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id, row.transaction_id, row.gateway_code, row.phase, row.method, row.path,
      row.request_headers_json, row.request_body_raw, row.response_status, row.response_body_raw,
      row.injected_fault, row.duration_ms, row.created_at,
    );
};

export const listTransactions = (filters: {
  railCode?: string;
  gatewayCode?: string;
  status?: string;
  reference?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): { rows: FakeTransactionRow[]; total: number } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.railCode) { clauses.push("rail_code = ?"); params.push(filters.railCode); }
  if (filters.gatewayCode) { clauses.push("gateway_code = ?"); params.push(filters.gatewayCode); }
  if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
  if (filters.reference) {
    clauses.push("(our_reference LIKE ? OR provider_reference LIKE ? OR network_reference LIKE ?)");
    params.push(`%${filters.reference}%`, `%${filters.reference}%`, `%${filters.reference}%`);
  }
  if (filters.from) { clauses.push("created_at >= ?"); params.push(filters.from); }
  if (filters.to) { clauses.push("created_at <= ?"); params.push(filters.to); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = getDb()
    .prepare(`SELECT * FROM fake_transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...(params as never[]), limit, offset) as FakeTransactionRow[];
  const total = (getDb()
    .prepare(`SELECT COUNT(*) AS count FROM fake_transactions ${where}`)
    .get(...(params as never[])) as { count: number }).count;
  return { rows, total };
};

export const listStepEvents = (transactionId: string): FakeStepEventRow[] =>
  getDb()
    .prepare(`SELECT * FROM fake_step_events WHERE transaction_id = ? ORDER BY created_at ASC`)
    .all(transactionId) as FakeStepEventRow[];
