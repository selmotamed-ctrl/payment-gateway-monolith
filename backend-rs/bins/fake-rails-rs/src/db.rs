//! The isolated SQLite store of the emulator (WAL, foreign keys, 5 s busy timeout).
//!
//! TS: `engine/db/index.ts` + `engine/db/schema.sql`. The schema is embedded; a connection is
//! shared behind a mutex because the emulator is a single-box tester service (the TS Bun SQLite
//! driver is also a single connection).

#![forbid(unsafe_code)]

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{SecondsFormat, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

pub const SCHEMA_SQL: &str = include_str!("schema.sql");

/// RFC 3339 with milliseconds and `Z`, the exact shape of JS `new Date().toISOString()`.
#[must_use]
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// RFC 9562 UUIDv7 (time ordered), the primary key of every row.
#[must_use]
pub fn uuid_v7() -> String {
    Uuid::now_v7().to_string()
}

#[derive(Clone)]
pub struct Db {
    connection: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").finish_non_exhaustive()
    }
}

impl Db {
    pub fn open(path: &str) -> ApiResult<Self> {
        if path != ":memory:" {
            if let Some(parent) = Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|error| {
                        ApiError::new(
                            500,
                            "DB_DIRECTORY",
                            format!("could not create the data directory: {error}"),
                        )
                    })?;
                }
            }
        }
        let connection = Connection::open(path).map_err(|error| {
            ApiError::new(
                500,
                "DB_OPEN_FAILED",
                format!("could not open the Fake Rails database: {error}"),
            )
        })?;
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        db.with(|connection| {
            connection.execute_batch(
                "PRAGMA journal_mode = WAL;\n\
                 PRAGMA synchronous = NORMAL;\n\
                 PRAGMA foreign_keys = ON;\n\
                 PRAGMA busy_timeout = 5000;",
            )?;
            connection.execute_batch(SCHEMA_SQL)?;
            migrate_legacy_schema(connection)?;
            Ok(())
        })?;
        Ok(db)
    }

    pub fn memory() -> ApiResult<Self> {
        Self::open(":memory:")
    }

    /// Runs a closure while holding the connection. Never `.await` inside.
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> ApiResult<T>) -> ApiResult<T> {
        let mut guard: MutexGuard<'_, Connection> = self
            .connection
            .lock()
            .map_err(|_| ApiError::new(500, "DB_LOCK_POISONED", "The database lock is poisoned"))?;
        f(&mut guard)
    }

    pub fn execute(&self, sql: &str, params: Vec<SqlValue>) -> ApiResult<usize> {
        self.with(|connection| {
            let mut statement = connection.prepare(sql)?;
            Ok(statement.execute(params_from_iter(params))?)
        })
    }

    pub fn query_json(&self, sql: &str, params: Vec<SqlValue>) -> ApiResult<Vec<Value>> {
        self.with(|connection| {
            let mut statement = connection.prepare(sql)?;
            let mut rows = statement.query(params_from_iter(params))?;
            let mut output = Vec::new();
            while let Some(row) = rows.next()? {
                output.push(row_to_json(row)?);
            }
            Ok(output)
        })
    }

    pub fn query_one_json(&self, sql: &str, params: Vec<SqlValue>) -> ApiResult<Option<Value>> {
        Ok(self.query_json(sql, params)?.into_iter().next())
    }

    pub fn count(&self, sql: &str, params: Vec<SqlValue>) -> ApiResult<i64> {
        self.with(|connection| {
            let mut statement = connection.prepare(sql)?;
            let value: i64 = statement.query_row(params_from_iter(params), |row| row.get(0))?;
            Ok(value)
        })
    }

    pub fn transaction<T>(&self, f: impl FnOnce(&mut Connection) -> ApiResult<T>) -> ApiResult<T> {
        self.with(|connection| {
            connection.execute_batch("BEGIN IMMEDIATE")?;
            match f(connection) {
                Ok(value) => {
                    connection.execute_batch("COMMIT")?;
                    Ok(value)
                }
                Err(error) => {
                    let _ = connection.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })
    }
}

/// Adds the v2 columns to a database created by the stateless v1 emulator. `CREATE TABLE IF NOT
/// EXISTS` never alters an existing table, so each column is added idempotently.
fn migrate_legacy_schema(connection: &mut Connection) -> ApiResult<()> {
    for (table, column, definition) in [
        ("fake_transactions", "account_id", "TEXT"),
        ("fake_transactions", "held_amount_lyd", "TEXT"),
        ("fake_transactions", "merchant_id", "TEXT"),
        ("fake_transactions", "qr_payload", "TEXT"),
        ("fake_transactions", "deep_link_url", "TEXT"),
        ("fake_transactions", "redirect_url", "TEXT"),
        ("fake_account_holds", "expires_at", "TEXT"),
        ("fake_accounts", "daily_spent_date", "TEXT"),
        ("fake_clearing_entries", "our_reference", "TEXT"),
        ("fake_clearing_entries", "provider_reference", "TEXT"),
        (
            "fake_clearing_entries",
            "currency",
            "TEXT NOT NULL DEFAULT 'LYD'",
        ),
        (
            "fake_clearing_entries",
            "status",
            "TEXT NOT NULL DEFAULT 'PAID'",
        ),
        ("fake_clearing_entries", "statement_included_at", "TEXT"),
        ("fake_clearing_entries", "statement_run_id", "TEXT"),
    ] {
        let exists = {
            let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
            let names = statement.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for name in names {
                if name? == column {
                    found = true;
                    break;
                }
            }
            found
        };
        if !exists {
            connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    connection.execute_batch("UPDATE fake_schema_version SET version = 2 WHERE version < 2")?;
    Ok(())
}

fn row_to_json(row: &rusqlite::Row<'_>) -> ApiResult<Value> {
    let names = row.as_ref().column_names();
    let mut object = Map::new();
    for (index, name) in names.enumerate() {
        let value = row.get::<_, SqlValue>(index)?;
        object.insert((*name).to_owned(), sql_to_json(value));
    }
    Ok(Value::Object(object))
}

#[must_use]
pub fn sql_to_json(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(number) => Value::from(number),
        SqlValue::Real(number) => Value::from(number),
        SqlValue::Text(text) => Value::String(text),
        SqlValue::Blob(bytes) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
    }
}

#[must_use]
pub fn json_to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                SqlValue::Integer(integer)
            } else {
                SqlValue::Real(number.as_f64().unwrap_or_default())
            }
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

#[must_use]
pub fn text(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

#[must_use]
pub fn int(value: i64) -> SqlValue {
    SqlValue::Integer(value)
}

/// Typed view of one `fake_transactions` row.
#[derive(Debug, Clone)]
pub struct Transaction {
    pub id: String,
    pub gateway_code: String,
    pub rail_code: String,
    pub env: String,
    pub our_reference: String,
    pub provider_reference: String,
    pub network_reference: Option<String>,
    pub idempotency_key: Option<String>,
    pub requested_amount_wire: String,
    pub normalized_amount_lyd: String,
    pub settled_amount_lyd: Option<String>,
    pub gateway_fee_lyd: String,
    pub currency: String,
    pub collection_mode: String,
    pub customer_identifier_masked: Option<String>,
    pub expected_otp: Option<String>,
    pub merchant_id: Option<String>,
    pub qr_payload: Option<String>,
    pub deep_link_url: Option<String>,
    pub redirect_url: Option<String>,
    pub account_id: Option<String>,
    pub held_amount_lyd: Option<String>,
    pub status: String,
    pub assigned_fail_phase: Option<String>,
    pub assigned_failure_mode: Option<String>,
    pub inquiry_override_status: Option<String>,
    pub return_url: Option<String>,
    pub cancel_url: Option<String>,
    pub webhook_url: Option<String>,
    pub is_seeded_historical: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Transaction {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            gateway_code: row.get("gateway_code")?,
            rail_code: row.get("rail_code")?,
            env: row.get("env")?,
            our_reference: row.get("our_reference")?,
            provider_reference: row.get("provider_reference")?,
            network_reference: row.get("network_reference")?,
            idempotency_key: row.get("idempotency_key")?,
            requested_amount_wire: row.get("requested_amount_wire")?,
            normalized_amount_lyd: row.get("normalized_amount_lyd")?,
            settled_amount_lyd: row.get("settled_amount_lyd")?,
            gateway_fee_lyd: row.get("gateway_fee_lyd")?,
            currency: row.get("currency")?,
            collection_mode: row.get("collection_mode")?,
            customer_identifier_masked: row.get("customer_identifier_masked")?,
            expected_otp: row.get("expected_otp")?,
            merchant_id: row.get("merchant_id")?,
            qr_payload: row.get("qr_payload")?,
            deep_link_url: row.get("deep_link_url")?,
            redirect_url: row.get("redirect_url")?,
            account_id: row.get("account_id")?,
            held_amount_lyd: row.get("held_amount_lyd")?,
            status: row.get("status")?,
            assigned_fail_phase: row.get("assigned_fail_phase")?,
            assigned_failure_mode: row.get("assigned_failure_mode")?,
            inquiry_override_status: row.get("inquiry_override_status")?,
            return_url: row.get("return_url")?,
            cancel_url: row.get("cancel_url")?,
            webhook_url: row.get("webhook_url")?,
            is_seeded_historical: row.get("is_seeded_historical")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

pub fn insert_transaction(db: &Db, row: &Transaction) -> ApiResult<()> {
    db.with(|connection| insert_transaction_conn(connection, row))
}

/// Inserts a transaction on an explicit connection (used inside a caller-owned transaction).
pub fn insert_transaction_conn(
    connection: &rusqlite::Connection,
    row: &Transaction,
) -> ApiResult<()> {
    connection.execute(
        "INSERT OR REPLACE INTO fake_transactions (
            id, gateway_code, rail_code, env, our_reference, provider_reference, network_reference,
            idempotency_key, requested_amount_wire, normalized_amount_lyd, settled_amount_lyd,
            gateway_fee_lyd, currency, collection_mode, customer_identifier_masked, expected_otp,
            merchant_id, qr_payload, deep_link_url, redirect_url, account_id, held_amount_lyd,
            status, assigned_fail_phase, assigned_failure_mode, inquiry_override_status,
            return_url, cancel_url, webhook_url, is_seeded_historical, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            row.id,
            row.gateway_code,
            row.rail_code,
            row.env,
            row.our_reference,
            row.provider_reference,
            row.network_reference,
            row.idempotency_key,
            row.requested_amount_wire,
            row.normalized_amount_lyd,
            row.settled_amount_lyd,
            row.gateway_fee_lyd,
            row.currency,
            row.collection_mode,
            row.customer_identifier_masked,
            row.expected_otp,
            row.merchant_id,
            row.qr_payload,
            row.deep_link_url,
            row.redirect_url,
            row.account_id,
            row.held_amount_lyd,
            row.status,
            row.assigned_fail_phase,
            row.assigned_failure_mode,
            row.inquiry_override_status,
            row.return_url,
            row.cancel_url,
            row.webhook_url,
            row.is_seeded_historical,
            row.created_at,
            row.updated_at,
        ],
    )?;
    Ok(())
}

fn find_transaction(db: &Db, sql: &str, params: Vec<SqlValue>) -> ApiResult<Option<Transaction>> {
    db.with(|connection| {
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query(params_from_iter(params))?;
        match rows.next()? {
            Some(row) => Ok(Some(Transaction::from_row(row)?)),
            None => Ok(None),
        }
    })
}

pub fn find_transaction_by_reference(
    db: &Db,
    gateway_code: &str,
    reference: &str,
) -> ApiResult<Option<Transaction>> {
    find_transaction(
        db,
        "SELECT * FROM fake_transactions
         WHERE gateway_code = ? AND (our_reference = ? OR provider_reference = ? OR network_reference = ?)
         ORDER BY created_at DESC LIMIT 1",
        vec![
            text(gateway_code),
            text(reference),
            text(reference),
            text(reference),
        ],
    )
}

pub fn find_transaction_any(db: &Db, reference: &str) -> ApiResult<Option<Transaction>> {
    find_transaction(
        db,
        "SELECT * FROM fake_transactions
         WHERE our_reference = ? OR provider_reference = ? OR network_reference = ? OR id = ?
         ORDER BY created_at DESC LIMIT 1",
        vec![
            text(reference),
            text(reference),
            text(reference),
            text(reference),
        ],
    )
}

pub fn find_transaction_by_id(db: &Db, id: &str) -> ApiResult<Option<Transaction>> {
    find_transaction(
        db,
        "SELECT * FROM fake_transactions WHERE id = ? LIMIT 1",
        vec![text(id)],
    )
}

const TRANSACTION_COLUMNS: &[&str] = &[
    "gateway_code",
    "rail_code",
    "env",
    "our_reference",
    "provider_reference",
    "network_reference",
    "idempotency_key",
    "requested_amount_wire",
    "normalized_amount_lyd",
    "settled_amount_lyd",
    "gateway_fee_lyd",
    "currency",
    "collection_mode",
    "customer_identifier_masked",
    "expected_otp",
    "merchant_id",
    "qr_payload",
    "deep_link_url",
    "redirect_url",
    "account_id",
    "held_amount_lyd",
    "status",
    "assigned_fail_phase",
    "assigned_failure_mode",
    "inquiry_override_status",
    "return_url",
    "cancel_url",
    "webhook_url",
    "is_seeded_historical",
];

/// Updates the given columns and always refreshes `updated_at`. Column names are validated
/// against the table's own allowlist, so no caller can inject SQL.
pub fn update_transaction(db: &Db, id: &str, patch: &[(&str, Value)]) -> ApiResult<()> {
    let mut assignments = Vec::new();
    let mut params = Vec::new();
    for (column, value) in patch {
        if !TRANSACTION_COLUMNS.contains(column) {
            return Err(ApiError::new(
                500,
                "INVALID_UPDATE_COLUMN",
                format!("unknown transaction column '{column}'"),
            ));
        }
        assignments.push(format!("{column} = ?"));
        params.push(json_to_sql(value));
    }
    if assignments.is_empty() {
        return Ok(());
    }
    assignments.push("updated_at = ?".to_owned());
    params.push(text(now_iso()));
    params.push(text(id));
    db.execute(
        &format!(
            "UPDATE fake_transactions SET {} WHERE id = ?",
            assignments.join(", ")
        ),
        params,
    )?;
    Ok(())
}

pub struct NewStepEvent<'a> {
    pub transaction_id: Option<&'a str>,
    pub gateway_code: &'a str,
    pub phase: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub request_headers_json: &'a str,
    pub request_body_raw: &'a str,
    pub response_status: Option<i64>,
    pub response_body_raw: Option<&'a str>,
    pub injected_fault: Option<&'a str>,
    pub duration_ms: i64,
}

/// A seeded historical step event with its own id and timestamps.
pub struct SeedStepEvent {
    pub id: String,
    pub transaction_id: Option<String>,
    pub gateway_code: String,
    pub phase: String,
    pub method: String,
    pub path: String,
    pub request_headers_json: String,
    pub request_body_raw: String,
    pub response_status: Option<i64>,
    pub response_body_raw: Option<String>,
    pub injected_fault: Option<String>,
    pub duration_ms: i64,
    pub created_at: String,
}

pub fn insert_step_event(db: &Db, event: &NewStepEvent<'_>) -> ApiResult<String> {
    let id = uuid_v7();
    db.execute(
        "INSERT OR REPLACE INTO fake_step_events (
            id, transaction_id, gateway_code, phase, method, path, request_headers_json,
            request_body_raw, response_status, response_body_raw, injected_fault, duration_ms, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        vec![
            text(id.clone()),
            event.transaction_id.map_or(SqlValue::Null, text),
            text(event.gateway_code),
            text(event.phase),
            text(event.method),
            text(event.path),
            text(event.request_headers_json),
            text(event.request_body_raw),
            event.response_status.map_or(SqlValue::Null, int),
            event.response_body_raw.map_or(SqlValue::Null, text),
            event.injected_fault.map_or(SqlValue::Null, text),
            int(event.duration_ms),
            text(now_iso()),
        ],
    )?;
    Ok(id)
}

/// Inserts a seeded historical event on an explicit connection.
pub fn insert_step_event_conn(
    connection: &rusqlite::Connection,
    event: &SeedStepEvent,
) -> ApiResult<()> {
    connection.execute(
        "INSERT OR REPLACE INTO fake_step_events (
            id, transaction_id, gateway_code, phase, method, path, request_headers_json,
            request_body_raw, response_status, response_body_raw, injected_fault, duration_ms, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            event.id,
            event.transaction_id,
            event.gateway_code,
            event.phase,
            event.method,
            event.path,
            event.request_headers_json,
            event.request_body_raw,
            event.response_status,
            event.response_body_raw,
            event.injected_fault,
            event.duration_ms,
            event.created_at,
        ],
    )?;
    Ok(())
}

pub fn list_step_events(db: &Db, transaction_id: &str) -> ApiResult<Vec<Value>> {
    db.query_json(
        "SELECT * FROM fake_step_events WHERE transaction_id = ? ORDER BY created_at ASC",
        vec![text(transaction_id)],
    )
}

#[derive(Debug, Default, Clone)]
pub struct TransactionFilters {
    pub rail_code: Option<String>,
    pub gateway_code: Option<String>,
    pub status: Option<String>,
    pub reference: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

pub fn list_transactions(db: &Db, filters: &TransactionFilters) -> ApiResult<(Vec<Value>, i64)> {
    let mut clauses: Vec<&str> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    if let Some(value) = &filters.rail_code {
        clauses.push("rail_code = ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.gateway_code {
        clauses.push("gateway_code = ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.status {
        clauses.push("status = ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.reference {
        clauses.push(
            "(our_reference LIKE ? OR provider_reference LIKE ? OR network_reference LIKE ?)",
        );
        let term = format!("%{value}%");
        params.push(text(term.clone()));
        params.push(text(term.clone()));
        params.push(text(term));
    }
    if let Some(value) = &filters.from {
        clauses.push("created_at >= ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.to {
        clauses.push("created_at <= ?");
        params.push(text(value));
    }
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let limit = i64::from(filters.limit.unwrap_or(100).clamp(1, 1000));
    let offset = i64::from(filters.offset.unwrap_or(0));
    let total = db.count(
        &format!("SELECT COUNT(*) FROM fake_transactions {where_clause}"),
        params.clone(),
    )?;
    let mut page_params = params;
    page_params.push(int(limit));
    page_params.push(int(offset));
    let rows = db.query_json(
        &format!(
            "SELECT * FROM fake_transactions {where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?"
        ),
        page_params,
    )?;
    Ok((rows, total))
}

pub fn list_step_events_optional(db: &Db, transaction_id: &str) -> ApiResult<Option<Vec<Value>>> {
    Ok(Some(list_step_events(db, transaction_id)?))
}

pub fn table_exists(db: &Db, table: &str) -> ApiResult<bool> {
    let row = db.query_one_json(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![text(table)],
    )?;
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transaction(reference: &str) -> Transaction {
        Transaction {
            id: uuid_v7(),
            gateway_code: "edfali".to_owned(),
            rail_code: "edfali".to_owned(),
            env: "SANDBOX".to_owned(),
            our_reference: reference.to_owned(),
            provider_reference: format!("FK-EDFALI-{reference}"),
            network_reference: None,
            idempotency_key: None,
            requested_amount_wire: "100.00".to_owned(),
            normalized_amount_lyd: "100.0000".to_owned(),
            settled_amount_lyd: None,
            gateway_fee_lyd: "0.0000".to_owned(),
            currency: "LYD".to_owned(),
            collection_mode: "OTP_PULL".to_owned(),
            customer_identifier_masked: None,
            expected_otp: Some("1234".to_owned()),
            merchant_id: None,
            qr_payload: None,
            deep_link_url: None,
            redirect_url: None,
            account_id: None,
            held_amount_lyd: None,
            status: "INITIATED".to_owned(),
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            inquiry_override_status: None,
            return_url: None,
            cancel_url: None,
            webhook_url: None,
            is_seeded_historical: 0,
            created_at: now_iso(),
            updated_at: now_iso(),
        }
    }

    #[test]
    fn schema_is_created_and_round_trips_a_transaction() {
        let db = Db::memory().expect("db");
        let row = transaction("TEST-1");
        insert_transaction(&db, &row).expect("insert");
        let found = find_transaction_by_reference(&db, "edfali", "TEST-1")
            .expect("query")
            .expect("row");
        assert_eq!(found.our_reference, "TEST-1");
        update_transaction(
            &db,
            &row.id,
            &[("status", Value::String("PAID".to_owned()))],
        )
        .expect("update");
        let updated = find_transaction_by_id(&db, &row.id)
            .expect("query")
            .expect("row");
        assert_eq!(updated.status, "PAID");
    }

    #[test]
    fn legacy_columns_are_added_idempotently() {
        let path = std::env::temp_dir().join(format!(
            "fake-rails-legacy-{}.sqlite",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        {
            let connection = Connection::open(&path).expect("open");
            connection
                .execute_batch(
                    "CREATE TABLE fake_transactions (id TEXT PRIMARY KEY, gateway_code TEXT NOT NULL,
                     rail_code TEXT NOT NULL, env TEXT NOT NULL DEFAULT 'SANDBOX',
                     our_reference TEXT NOT NULL, provider_reference TEXT NOT NULL UNIQUE,
                     network_reference TEXT, idempotency_key TEXT, requested_amount_wire TEXT NOT NULL,
                     normalized_amount_lyd TEXT NOT NULL, settled_amount_lyd TEXT,
                     gateway_fee_lyd TEXT NOT NULL DEFAULT '0.0000', currency TEXT NOT NULL DEFAULT 'LYD',
                     collection_mode TEXT NOT NULL, customer_identifier_masked TEXT, expected_otp TEXT,
                     status TEXT NOT NULL, assigned_fail_phase TEXT, assigned_failure_mode TEXT,
                     inquiry_override_status TEXT, return_url TEXT, cancel_url TEXT, webhook_url TEXT,
                     is_seeded_historical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL);",
                )
                .expect("legacy schema");
        }
        let db = Db::open(path.to_string_lossy().as_ref()).expect("migrate");
        let columns = db
            .query_json("PRAGMA table_info(fake_transactions)", vec![])
            .expect("columns");
        assert!(columns
            .iter()
            .any(|column| column["name"] == Value::String("account_id".to_owned())));
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn list_transactions_filters_and_counts() {
        let db = Db::memory().expect("db");
        for index in 0..3 {
            let mut row = transaction(&format!("LIST-{index}"));
            row.status = if index == 0 { "PAID" } else { "INITIATED" }.to_owned();
            insert_transaction(&db, &row).expect("insert");
        }
        let (rows, total) = list_transactions(
            &db,
            &TransactionFilters {
                status: Some("PAID".to_owned()),
                ..TransactionFilters::default()
            },
        )
        .expect("list");
        assert_eq!(total, 1);
        assert_eq!(rows.len(), 1);
    }
}
