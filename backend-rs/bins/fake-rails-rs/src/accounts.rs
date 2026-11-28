//! Stateful Fake Rails v2 account ledger: test customers, holds, capture/release/refund and the
//! merchant clearing pools. Ported from `engine/accounts/AccountLedgerService.ts`.
//!
//! Balances are 4-decimal LYD strings; every calculation runs on integer micros.

#![forbid(unsafe_code)]

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::chaos::{resolve_rail, RailDescriptor, RAIL_DESCRIPTORS};
use crate::db::{int, now_iso, text, uuid_v7, Db};
use crate::error::{ApiError, ApiResult};
use crate::money::{lyd, micros};

pub const INSTRUMENT_TYPES: [&str; 4] = ["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"];
pub const ACCOUNT_STATUSES: [&str; 4] = ["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"];
pub const QUICK_PRESETS: [&str; 4] = [
    "SET_ZERO",
    "SET_LINK_AMOUNT",
    "TOP_UP_5000",
    "RESET_DAILY_SPENT",
];

/// The business date (`YYYY-MM-DD`, Africa/Tripoli = fixed UTC+2) used by the daily limits.
#[must_use]
pub fn business_date() -> String {
    let shifted = chrono::Utc::now() + chrono::Duration::hours(2);
    shifted.format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone)]
pub struct Account {
    pub id: String,
    pub rail_code: String,
    pub gateway_code: String,
    pub merchant_id: Option<String>,
    pub instrument_type: String,
    pub identifier: String,
    pub holder_name: String,
    pub secret_pin: String,
    pub expiry: Option<String>,
    pub currency: String,
    pub available_balance_lyd: String,
    pub reserved_balance_lyd: String,
    pub daily_limit_lyd: String,
    pub daily_spent_lyd: String,
    pub daily_spent_date: Option<String>,
    pub status: String,
    pub static_otp: Option<String>,
    pub preset_fault: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Account {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            rail_code: row.get("rail_code")?,
            gateway_code: row.get("gateway_code")?,
            merchant_id: row.get("merchant_id")?,
            instrument_type: row.get("instrument_type")?,
            identifier: row.get("identifier")?,
            holder_name: row.get("holder_name")?,
            secret_pin: row.get("secret_pin")?,
            expiry: row.get("expiry")?,
            currency: row.get("currency")?,
            available_balance_lyd: row.get("available_balance_lyd")?,
            reserved_balance_lyd: row.get("reserved_balance_lyd")?,
            daily_limit_lyd: row.get("daily_limit_lyd")?,
            daily_spent_lyd: row.get("daily_spent_lyd")?,
            daily_spent_date: row.get("daily_spent_date")?,
            status: row.get("status")?,
            static_otp: row.get("static_otp")?,
            preset_fault: row.get("preset_fault")?,
            notes: row.get("notes")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

struct InstrumentSpec {
    instrument_type: &'static str,
    identifiers: [String; 5],
    pin: &'static str,
}

fn instrument_for_rail(
    rail: &RailDescriptor,
    rail_index: usize,
    gateway_code: &str,
) -> InstrumentSpec {
    const CARD_GATEWAYS: [&str; 8] = [
        "moamalat", "mpgs", "numo_pay", "tadawul", "tlync", "mypay", "dpay", "plutu",
    ];
    if CARD_GATEWAYS.contains(&gateway_code) {
        let prefix = if gateway_code == "mpgs" {
            "512345"
        } else {
            "628000"
        }
        .to_owned();
        let mid = format!("{:02}", rail_index + 1);
        return InstrumentSpec {
            instrument_type: "CARD",
            identifiers: [
                format!("{prefix}{mid}0000001"),
                format!("{prefix}{mid}0000002"),
                format!("{prefix}{mid}0000005"),
                format!("{prefix}{mid}0000061"),
                format!("{prefix}{mid}0000999"),
            ],
            pin: "123",
        };
    }
    if gateway_code == "neompay" {
        return InstrumentSpec {
            instrument_type: "MOBILE_WALLET",
            identifiers: [
                format!("NEOM-WALLET-{rail_index}-RICH"),
                format!("NEOM-WALLET-{rail_index}-STD"),
                format!("NEOM-WALLET-{rail_index}-LOW"),
                format!("NEOM-WALLET-{rail_index}-LIM"),
                format!("NEOM-WALLET-{rail_index}-FRZ"),
            ],
            pin: "1234",
        };
    }
    let suffix = rail_index % 10;
    let _ = rail;
    InstrumentSpec {
        instrument_type: "MOBILE_WALLET",
        identifiers: [
            format!("091{suffix}000001"),
            format!("091{suffix}000002"),
            format!("091{suffix}000005"),
            format!("091{suffix}000061"),
            format!("091{suffix}000999"),
        ],
        pin: "1234",
    }
}

struct Persona {
    holder: String,
    available: &'static str,
    limit: &'static str,
    spent: &'static str,
    status: &'static str,
    fault: Option<&'static str>,
    notes: &'static str,
}

fn persona(rail: &RailDescriptor, index: usize) -> Persona {
    let name = rail.name;
    match index {
        0 => Persona {
            holder: format!("{name} — High-Balance Test Account"),
            available: "50000.0000",
            limit: "25000.0000",
            spent: "0.0000",
            status: "ACTIVE",
            fault: None,
            notes: "Default rich test account; succeeds for normal amounts",
        },
        1 => Persona {
            holder: format!("{name} — Standard Test Account"),
            available: "1500.0000",
            limit: "2000.0000",
            spent: "0.0000",
            status: "ACTIVE",
            fault: None,
            notes: "Standard retail balance (1,500 LYD)",
        },
        2 => Persona {
            holder: format!("{name} — Low Balance Account"),
            available: "5.0000",
            limit: "2000.0000",
            spent: "0.0000",
            status: "ACTIVE",
            fault: None,
            notes: "Fails with INSUFFICIENT_FUNDS above 5 LYD",
        },
        3 => Persona {
            holder: format!("{name} — Near Daily Limit"),
            available: "5000.0000",
            limit: "50.0000",
            spent: "45.0000",
            status: "ACTIVE",
            fault: None,
            notes: "Only 5 LYD left on the daily limit -> LIMIT_EXCEEDED",
        },
        _ => Persona {
            holder: format!("{name} — Frozen Test Account"),
            available: "10000.0000",
            limit: "5000.0000",
            spent: "0.0000",
            status: "FROZEN",
            fault: Some("TERMINAL_DECLINE_INSUFFICIENT_FUNDS"),
            notes: "FROZEN status declines immediately at INITIATE",
        },
    }
}

/// Seeds the five test personas of every rail and its clearing pool, idempotently.
pub fn ensure_default_accounts(db: &Db) -> ApiResult<()> {
    let now = now_iso();
    let today = business_date();
    db.transaction(|connection| {
        for (rail_index, rail) in RAIL_DESCRIPTORS.iter().enumerate() {
            connection.execute(
                "INSERT OR IGNORE INTO fake_merchant_clearing_pools (
                    id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
                    accumulated_gateway_fee_lyd, tx_count, updated_at
                 ) VALUES (?, ?, ?, '0.0000', '0.0000', '0.0000', 0, ?)",
                params![uuid_v7(), rail.gateway_code, rail.rail_code, now],
            )?;
            let spec = instrument_for_rail(rail, rail_index, rail.gateway_code);
            for (persona_index, identifier) in spec.identifiers.iter().enumerate() {
                let p = persona(rail, persona_index);
                connection.execute(
                    "INSERT OR IGNORE INTO fake_accounts (
                        id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
                        holder_name, secret_pin, expiry, currency, available_balance_lyd,
                        reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date, status,
                        static_otp, preset_fault, notes, created_at, updated_at
                     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '12/28', 'LYD', ?, '0.0000', ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
                    params![
                        uuid_v7(),
                        rail.rail_code,
                        rail.gateway_code,
                        spec.instrument_type,
                        identifier,
                        p.holder,
                        spec.pin,
                        p.available,
                        p.limit,
                        p.spent,
                        today,
                        p.status,
                        p.fault,
                        p.notes,
                        now,
                        now
                    ],
                )?;
            }
        }
        Ok(())
    })
}

#[derive(Debug, Default, Clone)]
pub struct AccountFilters {
    pub rail_code: Option<String>,
    pub gateway_code: Option<String>,
    pub merchant_id: Option<String>,
    pub status: Option<String>,
    pub instrument_type: Option<String>,
    pub scope: Option<String>,
    pub created_from: Option<String>,
    pub created_to: Option<String>,
    pub search: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
    pub include_global: bool,
}

fn account_where(filters: &AccountFilters) -> (String, Vec<SqlValue>) {
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
    if let Some(value) = &filters.merchant_id {
        clauses.push(if filters.include_global {
            "(merchant_id = ? OR merchant_id IS NULL)"
        } else {
            "merchant_id = ?"
        });
        params.push(text(value));
    }
    if let Some(value) = &filters.status {
        clauses.push("status = ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.instrument_type {
        clauses.push("instrument_type = ?");
        params.push(text(value));
    }
    if filters.scope.as_deref() == Some("GLOBAL") {
        clauses.push("merchant_id IS NULL");
    } else if filters.scope.as_deref() == Some("MERCHANT") {
        clauses.push("merchant_id IS NOT NULL");
    }
    if let Some(value) = &filters.created_from {
        clauses.push("created_at >= ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.created_to {
        clauses.push("created_at <= ?");
        params.push(text(value));
    }
    if let Some(value) = &filters.search {
        clauses.push("(identifier LIKE ? OR holder_name LIKE ? OR notes LIKE ?)");
        let term = format!("%{value}%");
        params.push(text(term.clone()));
        params.push(text(term.clone()));
        params.push(text(term));
    }
    (
        if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        },
        params,
    )
}

pub fn list_accounts(db: &Db, filters: &AccountFilters) -> ApiResult<Vec<Value>> {
    ensure_default_accounts(db)?;
    if let Some(merchant_id) = &filters.merchant_id {
        ensure_merchant_presets(db, merchant_id)?;
    }
    let (where_clause, params) = account_where(filters);
    db.query_json(
        &format!(
            "SELECT * FROM fake_accounts {where_clause} ORDER BY created_at ASC, identifier ASC"
        ),
        params,
    )
}

pub struct AccountPage {
    pub accounts: Vec<Value>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

pub fn list_accounts_page(db: &Db, filters: &AccountFilters) -> ApiResult<AccountPage> {
    ensure_default_accounts(db)?;
    if let Some(merchant_id) = &filters.merchant_id {
        ensure_merchant_presets(db, merchant_id)?;
    }
    let (where_clause, params) = account_where(filters);
    let page = filters.page.unwrap_or(1).max(1);
    let page_size = filters.page_size.unwrap_or(50).clamp(1, 200);
    let total = db.count(
        &format!("SELECT COUNT(*) FROM fake_accounts {where_clause}"),
        params.clone(),
    )?;
    let mut page_params = params;
    page_params.push(int(page_size));
    page_params.push(int((page - 1) * page_size));
    let accounts = db.query_json(
        &format!(
            "SELECT * FROM fake_accounts {where_clause} ORDER BY created_at ASC, identifier ASC LIMIT ? OFFSET ?"
        ),
        page_params,
    )?;
    Ok(AccountPage {
        accounts,
        total,
        page,
        page_size,
    })
}

pub fn get_account(db: &Db, account_id: &str) -> ApiResult<Option<Account>> {
    db.with(|connection| {
        let account = connection
            .query_row(
                "SELECT * FROM fake_accounts WHERE id = ?",
                params![account_id],
                Account::from_row,
            )
            .optional()?;
        Ok(account)
    })
}

fn by_rail_identifier(
    connection: &Connection,
    rail_code: &str,
    identifier: &str,
    merchant_id: Option<&str>,
) -> ApiResult<Option<Account>> {
    let account = if let Some(merchant_id) = merchant_id {
        connection
            .query_row(
                "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id = ? LIMIT 1",
                params![rail_code, identifier, merchant_id],
                Account::from_row,
            )
            .optional()?
    } else {
        None
    };
    if account.is_some() {
        return Ok(account);
    }
    Ok(connection
        .query_row(
            if merchant_id.is_some() {
                "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL LIMIT 1"
            } else {
                "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? LIMIT 1"
            },
            params![rail_code, identifier],
            Account::from_row,
        )
        .optional()?)
}

/// Creates the merchant-owned copies of the shared presets (idempotent, same identifiers).
pub fn ensure_merchant_presets(db: &Db, merchant_id: &str) -> ApiResult<()> {
    if merchant_id.is_empty() {
        return Ok(());
    }
    ensure_default_accounts(db)?;
    let now = now_iso();
    let today = business_date();
    db.transaction(|connection| {
        let mut statement = connection.prepare(
            "SELECT * FROM fake_accounts WHERE merchant_id IS NULL ORDER BY created_at ASC, identifier ASC",
        )?;
        let globals: Vec<Account> = statement
            .query_map([], Account::from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for account in globals {
            connection.execute(
                "INSERT OR IGNORE INTO fake_accounts (
                    id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
                    holder_name, secret_pin, expiry, currency, available_balance_lyd,
                    reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date,
                    status, static_otp, preset_fault, notes, created_at, updated_at
                 ) VALUES (?,?,?,?,?,?,?,?,?,?,?, '0.0000', ?, '0.0000', ?, ?, ?, ?, ?, ?, ?)",
                params![
                    uuid_v7(),
                    account.rail_code,
                    account.gateway_code,
                    merchant_id,
                    account.instrument_type,
                    account.identifier,
                    account.holder_name,
                    account.secret_pin,
                    account.expiry.unwrap_or_else(|| "12/28".to_owned()),
                    account.currency,
                    account.available_balance_lyd,
                    account.daily_limit_lyd,
                    today,
                    account.status,
                    account.static_otp,
                    account.preset_fault,
                    account.notes,
                    now,
                    now
                ],
            )?;
        }
        Ok(())
    })
}

fn materialize_global_for_merchant(
    connection: &Connection,
    global: &Account,
    merchant_id: &str,
) -> ApiResult<Account> {
    let now = now_iso();
    connection.execute(
        "INSERT OR IGNORE INTO fake_accounts (
            id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
            holder_name, secret_pin, expiry, currency, available_balance_lyd,
            reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date,
            status, static_otp, preset_fault, notes, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?, '0.0000', ?, '0.0000', ?, ?, ?, ?, ?, ?, ?)",
        params![
            uuid_v7(),
            global.rail_code,
            global.gateway_code,
            merchant_id,
            global.instrument_type,
            global.identifier,
            global.holder_name,
            global.secret_pin,
            global.expiry.clone().unwrap_or_else(|| "12/28".to_owned()),
            global.currency,
            global.available_balance_lyd,
            global.daily_limit_lyd,
            business_date(),
            global.status,
            global.static_otp,
            global.preset_fault,
            global.notes,
            now,
            now
        ],
    )?;
    Ok(connection
        .query_row(
            "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id = ?",
            params![global.rail_code, global.identifier, merchant_id],
            Account::from_row,
        )
        .optional()?
        .unwrap_or_else(|| global.clone()))
}

pub struct AutoCreate<'a> {
    pub rail_code: &'a str,
    pub gateway_code: &'a str,
    pub identifier: Option<&'a str>,
    pub merchant_id: Option<&'a str>,
}

pub fn find_or_auto_create_account(db: &Db, input: &AutoCreate<'_>) -> ApiResult<Account> {
    ensure_default_accounts(db)?;
    let merchant_id = input
        .merchant_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(merchant_id) = merchant_id {
        ensure_merchant_presets(db, merchant_id)?;
    }
    let clean: String = input
        .identifier
        .unwrap_or_default()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    db.transaction(|connection| {
        if !clean.is_empty() {
            if let Some(exact) = by_rail_identifier(connection, input.rail_code, &clean, merchant_id)? {
                if let Some(merchant_id) = merchant_id {
                    if exact.merchant_id.is_none() {
                        return materialize_global_for_merchant(connection, &exact, merchant_id);
                    }
                }
                return Ok(exact);
            }
            let by_gateway = if let Some(merchant_id) = merchant_id {
                connection
                    .query_row(
                        "SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? AND merchant_id = ? LIMIT 1",
                        params![input.gateway_code, clean, merchant_id],
                        Account::from_row,
                    )
                    .optional()?
            } else {
                connection
                    .query_row(
                        "SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? LIMIT 1",
                        params![input.gateway_code, clean],
                        Account::from_row,
                    )
                    .optional()?
            };
            if let Some(account) = by_gateway {
                return Ok(account);
            }
            if let Some(merchant_id) = merchant_id {
                let shared = connection
                    .query_row(
                        "SELECT * FROM fake_accounts WHERE gateway_code = ? AND identifier = ? AND merchant_id IS NULL LIMIT 1",
                        params![input.gateway_code, clean],
                        Account::from_row,
                    )
                    .optional()?;
                if let Some(shared) = shared {
                    return materialize_global_for_merchant(connection, &shared, merchant_id);
                }
            }

            let now = now_iso();
            let id = uuid_v7();
            let rail = resolve_rail(input.rail_code);
            let spec = rail.map(|rail| {
                instrument_for_rail(rail, rail_index(rail), rail.gateway_code)
            });
            connection.execute(
                "INSERT INTO fake_accounts (
                    id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
                    holder_name, secret_pin, expiry, currency, available_balance_lyd,
                    reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date,
                    status, static_otp, preset_fault, notes, created_at, updated_at
                 ) VALUES (?,?,?,?,?,?,?,?, '12/28', 'LYD', '2500.0000', '0.0000', '5000.0000', '0.0000', ?, 'ACTIVE', NULL, NULL, 'Auto-created on checkout', ?, ?)",
                params![
                    id,
                    input.rail_code,
                    input.gateway_code,
                    merchant_id,
                    spec.as_ref().map_or("MOBILE_WALLET", |s| s.instrument_type),
                    clean,
                    format!("Ad-hoc Test Account ({clean})"),
                    spec.as_ref().map_or("1234", |s| s.pin),
                    business_date(),
                    now,
                    now
                ],
            )?;
            return get_account_in(connection, &id)?
                .ok_or_else(|| ApiError::new(500, "FAKE_ACCOUNT_CREATE_FAILED", "account not created"));
        }

        let fallback = if let Some(merchant_id) = merchant_id {
            connection.query_row(
                "SELECT * FROM fake_accounts
                 WHERE (rail_code = ? OR gateway_code = ?) AND status = 'ACTIVE' AND merchant_id = ?
                 ORDER BY created_at ASC, identifier ASC LIMIT 1",
                params![input.rail_code, input.gateway_code, merchant_id],
                Account::from_row,
            ).optional()?
        } else {
            connection.query_row(
                "SELECT * FROM fake_accounts
                 WHERE (rail_code = ? OR gateway_code = ?) AND status = 'ACTIVE'
                 ORDER BY created_at ASC, identifier ASC LIMIT 1",
                params![input.rail_code, input.gateway_code],
                Account::from_row,
            ).optional()?
        };
        fallback.ok_or_else(|| {
            ApiError::new(
                409,
                "FAKE_ACCOUNT_NOT_FOUND",
                format!("No fake account available for rail={}", input.rail_code),
            )
        })
    })
}

fn rail_index(rail: &RailDescriptor) -> usize {
    RAIL_DESCRIPTORS
        .iter()
        .position(|candidate| candidate.rail_code == rail.rail_code)
        .unwrap_or(0)
}

fn get_account_in(connection: &Connection, id: &str) -> ApiResult<Option<Account>> {
    Ok(connection
        .query_row(
            "SELECT * FROM fake_accounts WHERE id = ?",
            params![id],
            Account::from_row,
        )
        .optional()?)
}

fn roll_daily_spent(connection: &Connection, account: &Account) -> ApiResult<Account> {
    let today = business_date();
    if account.daily_spent_date.as_deref() == Some(today.as_str()) {
        return Ok(account.clone());
    }
    let now = now_iso();
    connection.execute(
        "UPDATE fake_accounts SET daily_spent_lyd = '0.0000', daily_spent_date = ?, updated_at = ? WHERE id = ?",
        params![today, now, account.id],
    )?;
    let mut rolled = account.clone();
    rolled.daily_spent_lyd = "0.0000".to_owned();
    rolled.daily_spent_date = Some(today);
    rolled.updated_at = now;
    Ok(rolled)
}

#[derive(Debug, Clone)]
pub struct HoldResult {
    pub allowed: bool,
    pub decline_code: Option<&'static str>,
    pub decline_message: Option<String>,
    pub account: Account,
}

fn decline_for_status(account: &Account) -> Option<HoldResult> {
    if account.status == "ACTIVE" {
        return None;
    }
    let code = match account.status.as_str() {
        "FROZEN" => "ACCOUNT_FROZEN",
        "EXPIRED" => "ACCOUNT_EXPIRED",
        _ => "ACCOUNT_BLOCKED",
    };
    Some(HoldResult {
        allowed: false,
        decline_code: Some(code),
        decline_message: Some(format!(
            "Account {} is {}",
            account.identifier, account.status
        )),
        account: account.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
fn insert_movement(
    connection: &Connection,
    account_id: &str,
    transaction_id: Option<&str>,
    direction: &str,
    amount_lyd: &str,
    before: &str,
    after: &str,
    reason: &str,
    actor: &str,
) -> ApiResult<()> {
    connection.execute(
        "INSERT INTO fake_account_movements (
            id, account_id, transaction_id, direction, amount_lyd,
            available_before_lyd, available_after_lyd, reason, actor, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)",
        params![
            uuid_v7(),
            account_id,
            transaction_id,
            direction,
            amount_lyd,
            before,
            after,
            reason,
            actor,
            now_iso()
        ],
    )?;
    Ok(())
}

pub struct Reserve<'a> {
    pub rail_code: &'a str,
    pub gateway_code: &'a str,
    pub identifier: Option<&'a str>,
    pub transaction_id: &'a str,
    pub amount_lyd: &'a str,
    pub merchant_id: Option<&'a str>,
}

/// INITIATE: validates status/balance/daily limit and atomically moves the amount from available
/// to reserved. Repeating the call for the same transaction is idempotent.
pub fn reserve_account_funds(db: &Db, input: &Reserve<'_>) -> ApiResult<HoldResult> {
    let account = find_or_auto_create_account(
        db,
        &AutoCreate {
            rail_code: input.rail_code,
            gateway_code: input.gateway_code,
            identifier: input.identifier,
            merchant_id: input.merchant_id,
        },
    )?;
    db.transaction(|connection| {
        let account = roll_daily_spent(connection, &account)?;
        if let Some(decline) = decline_for_status(&account) {
            return Ok(decline);
        }
        let requested = micros(input.amount_lyd);
        let available = micros(&account.available_balance_lyd);
        let reserved = micros(&account.reserved_balance_lyd);
        let remaining_daily = micros(&account.daily_limit_lyd) - micros(&account.daily_spent_lyd);
        let existing: Option<(String, String, String)> = connection
            .query_row(
                "SELECT id, state, amount_lyd FROM fake_account_holds WHERE transaction_id = ?",
                params![input.transaction_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if existing.is_none() {
            if available < requested {
                return Ok(HoldResult {
                    allowed: false,
                    decline_code: Some("INSUFFICIENT_FUNDS"),
                    decline_message: Some(format!(
                        "Account {} available balance ({} LYD) is less than requested ({} LYD)",
                        account.identifier, account.available_balance_lyd, input.amount_lyd
                    )),
                    account: account.clone(),
                });
            }
            if requested > remaining_daily {
                return Ok(HoldResult {
                    allowed: false,
                    decline_code: Some("LIMIT_EXCEEDED"),
                    decline_message: Some(format!(
                        "Account {} daily limit exceeded (limit {} LYD, spent {} LYD)",
                        account.identifier, account.daily_limit_lyd, account.daily_spent_lyd
                    )),
                    account: account.clone(),
                });
            }
            let now = now_iso();
            let next_available = lyd(available - requested);
            let next_reserved = lyd(reserved + requested);
            connection.execute(
                "UPDATE fake_accounts SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ? WHERE id = ?",
                params![next_available, next_reserved, now, account.id],
            )?;
            let expires_at =
                (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            connection.execute(
                "INSERT INTO fake_account_holds (id, account_id, transaction_id, amount_lyd, state, expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'HELD', ?, ?, ?)",
                params![uuid_v7(), account.id, input.transaction_id, lyd(requested), expires_at, now, now],
            )?;
            insert_movement(
                connection,
                &account.id,
                Some(input.transaction_id),
                "HOLD",
                &lyd(requested),
                &account.available_balance_lyd,
                &next_available,
                "Payment initiated hold",
                "switch",
            )?;
        }
        connection.execute(
            "UPDATE fake_transactions SET account_id = ?, held_amount_lyd = ?, updated_at = ? WHERE id = ?",
            params![account.id, lyd(requested), now_iso(), input.transaction_id],
        )?;
        let refreshed = get_account_in(connection, &account.id)?.unwrap_or(account.clone());
        Ok(HoldResult {
            allowed: true,
            decline_code: None,
            decline_message: None,
            account: refreshed,
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn add_clearing_entry(
    connection: &Connection,
    transaction_id: &str,
    gateway_code: &str,
    rail_code: &str,
    account_id: Option<&str>,
    our_reference: Option<&str>,
    provider_reference: Option<&str>,
    currency: &str,
    status: &str,
    entry_type: &str,
    amount_lyd: &str,
    gateway_fee_lyd: &str,
) -> ApiResult<()> {
    connection.execute(
        "INSERT INTO fake_clearing_entries (
            id, transaction_id, gateway_code, rail_code, account_id,
            our_reference, provider_reference, currency, status, entry_type,
            amount_lyd, gateway_fee_lyd, settled_at, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
        params![
            uuid_v7(),
            transaction_id,
            gateway_code,
            rail_code,
            account_id,
            our_reference,
            provider_reference,
            currency,
            status,
            entry_type,
            amount_lyd,
            gateway_fee_lyd,
            now_iso()
        ],
    )?;
    let delta = if entry_type == "REFUND" {
        -micros(amount_lyd)
    } else {
        micros(amount_lyd)
    };
    let fee = if entry_type == "CAPTURE" {
        micros(gateway_fee_lyd)
    } else {
        0
    };
    connection.execute(
        "INSERT OR IGNORE INTO fake_merchant_clearing_pools (
            id, gateway_code, rail_code, pending_settlement_lyd, settled_lyd,
            accumulated_gateway_fee_lyd, tx_count, updated_at
         ) VALUES (?,?,?,'0.0000','0.0000','0.0000',0,?)",
        params![uuid_v7(), gateway_code, rail_code, now_iso()],
    )?;
    let (pending, accumulated): (String, String) = connection.query_row(
        "SELECT pending_settlement_lyd, accumulated_gateway_fee_lyd
         FROM fake_merchant_clearing_pools WHERE gateway_code = ? AND rail_code = ?",
        params![gateway_code, rail_code],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    connection.execute(
        "UPDATE fake_merchant_clearing_pools
            SET pending_settlement_lyd = ?, accumulated_gateway_fee_lyd = ?,
                tx_count = tx_count + ?, updated_at = ?
          WHERE gateway_code = ? AND rail_code = ?",
        params![
            lyd(micros(&pending) + delta),
            lyd(micros(&accumulated) + fee),
            i64::from(entry_type == "CAPTURE"),
            now_iso(),
            gateway_code,
            rail_code
        ],
    )?;
    Ok(())
}

/// SUBMIT / hosted APPROVE: captures the held amount and credits the clearing pool.
pub fn capture_hold(
    db: &Db,
    transaction_id: &str,
    settled_override: Option<&str>,
) -> ApiResult<Option<Account>> {
    db.transaction(|connection| {
        let hold: Option<(String, String, String)> = connection
            .query_row(
                "SELECT id, account_id, state FROM fake_account_holds WHERE transaction_id = ?",
                params![transaction_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((hold_id, account_id, hold_state)) = hold else {
            return Ok(None);
        };
        let Some(found) = get_account_in(connection, &account_id)? else {
            return Ok(None);
        };
        if hold_state == "CAPTURED" {
            return Ok(Some(found));
        }
        let account = roll_daily_spent(connection, &found)?;
        let transaction = connection
            .query_row(
                "SELECT gateway_code, rail_code, our_reference, provider_reference, currency, gateway_fee_lyd
                 FROM fake_transactions WHERE id = ?",
                params![transaction_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let (held, hold_amount): (String, String) = connection.query_row(
            "SELECT id, amount_lyd FROM fake_account_holds WHERE id = ?",
            params![hold_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let _ = held;
        let held_micros = micros(&hold_amount);
        let captured = settled_override.map_or(held_micros, micros);
        let reserved = micros(&account.reserved_balance_lyd);
        let available = micros(&account.available_balance_lyd);
        let extra = captured - held_micros;
        if extra > available {
            return Err(ApiError::new(
                409,
                "CAPTURE_EXCEEDS_AVAILABLE",
                "The captured amount exceeds the available test balance",
            ));
        }
        let next_available = available - extra;
        let next_reserved = if reserved >= held_micros {
            reserved - held_micros
        } else {
            0
        };
        let next_spent = micros(&account.daily_spent_lyd) + captured;
        let now = now_iso();
        connection.execute(
            "UPDATE fake_accounts
                SET available_balance_lyd = ?, reserved_balance_lyd = ?, daily_spent_lyd = ?, daily_spent_date = ?, updated_at = ?
              WHERE id = ?",
            params![
                lyd(next_available),
                lyd(next_reserved),
                lyd(next_spent),
                business_date(),
                now,
                account.id
            ],
        )?;
        connection.execute(
            "UPDATE fake_account_holds SET state = 'CAPTURED', updated_at = ? WHERE id = ?",
            params![now, hold_id],
        )?;
        insert_movement(
            connection,
            &account.id,
            Some(transaction_id),
            "CAPTURE",
            &lyd(captured),
            &account.available_balance_lyd,
            &lyd(next_available),
            "Payment confirmed & settled",
            "switch",
        )?;
        if let Some((gateway_code, rail_code, our_reference, provider_reference, currency, fee)) =
            transaction
        {
            add_clearing_entry(
                connection,
                transaction_id,
                &gateway_code,
                &rail_code,
                Some(&account.id),
                Some(&our_reference),
                Some(&provider_reference),
                &currency,
                "PAID",
                "CAPTURE",
                &lyd(captured),
                &fee,
            )?;
        }
        get_account_in(connection, &account.id)
    })
}

/// CANCEL / DECLINE / expiry: returns the held amount to the available balance.
pub fn release_hold(db: &Db, transaction_id: &str, reason: &str) -> ApiResult<Option<Account>> {
    db.transaction(|connection| {
        let hold: Option<(String, String, String, String)> = connection
            .query_row(
                "SELECT id, account_id, state, amount_lyd FROM fake_account_holds WHERE transaction_id = ?",
                params![transaction_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((hold_id, account_id, hold_state, amount)) = hold else {
            return Ok(None);
        };
        let Some(account) = get_account_in(connection, &account_id)? else {
            return Ok(None);
        };
        if hold_state != "HELD" {
            return Ok(Some(account));
        }
        let held = micros(&amount);
        let available = micros(&account.available_balance_lyd);
        let reserved = micros(&account.reserved_balance_lyd);
        let next_available = available + held;
        let next_reserved = if reserved >= held { reserved - held } else { 0 };
        let now = now_iso();
        connection.execute(
            "UPDATE fake_accounts SET available_balance_lyd = ?, reserved_balance_lyd = ?, updated_at = ? WHERE id = ?",
            params![lyd(next_available), lyd(next_reserved), now, account.id],
        )?;
        connection.execute(
            "UPDATE fake_account_holds SET state = 'RELEASED', updated_at = ? WHERE id = ?",
            params![now, hold_id],
        )?;
        insert_movement(
            connection,
            &account.id,
            Some(transaction_id),
            "RELEASE",
            &amount,
            &account.available_balance_lyd,
            &lyd(next_available),
            reason,
            "switch",
        )?;
        get_account_in(connection, &account.id)
    })
}

/// REFUND: credits the customer back; can never exceed the captured amount.
pub fn refund_transaction(
    db: &Db,
    transaction_id: &str,
    amount_lyd: Option<&str>,
    reason: &str,
) -> ApiResult<Option<Account>> {
    db.transaction(|connection| {
        let transaction = connection
            .query_row(
                "SELECT account_id, gateway_code, rail_code, our_reference, provider_reference, currency
                 FROM fake_transactions WHERE id = ?",
                params![transaction_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((account_id, gateway_code, rail_code, our_reference, provider_reference, currency)) =
            transaction
        else {
            return Ok(None);
        };
        let Some(account_id) = account_id else {
            return Ok(None);
        };
        let Some(account) = get_account_in(connection, &account_id)? else {
            return Ok(None);
        };
        let mut captured = 0i64;
        let mut refunded = 0i64;
        {
            let mut statement = connection.prepare(
                "SELECT entry_type, amount_lyd FROM fake_clearing_entries WHERE transaction_id = ?",
            )?;
            let rows = statement.query_map(params![transaction_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (entry_type, amount) = row?;
                match entry_type.as_str() {
                    "CAPTURE" => captured += micros(&amount),
                    "REFUND" => refunded += micros(&amount),
                    _ => {}
                }
            }
        }
        let requested = amount_lyd.map_or(captured - refunded, micros);
        if requested <= 0 {
            return Err(ApiError::new(
                409,
                "REFUND_EXCEEDS_CAPTURED_AMOUNT",
                "The transaction has nothing left to refund",
            ));
        }
        if refunded + requested > captured {
            return Err(ApiError::new(
                409,
                "REFUND_EXCEEDS_CAPTURED_AMOUNT",
                format!(
                    "Refund {} LYD would exceed the captured amount {} LYD",
                    lyd(requested),
                    lyd(captured)
                ),
            ));
        }
        let next_available = micros(&account.available_balance_lyd) + requested;
        connection.execute(
            "UPDATE fake_accounts SET available_balance_lyd = ?, updated_at = ? WHERE id = ?",
            params![lyd(next_available), now_iso(), account.id],
        )?;
        insert_movement(
            connection,
            &account.id,
            Some(transaction_id),
            "REFUND_CREDIT",
            &lyd(requested),
            &account.available_balance_lyd,
            &lyd(next_available),
            reason,
            "switch",
        )?;
        add_clearing_entry(
            connection,
            transaction_id,
            &gateway_code,
            &rail_code,
            Some(&account.id),
            Some(&our_reference),
            Some(&provider_reference),
            &currency,
            "REFUNDED",
            "REFUND",
            &lyd(requested),
            "0.0000",
        )?;
        get_account_in(connection, &account.id)
    })
}

pub struct AdjustAccount<'a> {
    pub account_id: &'a str,
    pub available_balance_lyd: Option<&'a str>,
    pub delta_lyd: Option<&'a str>,
    pub daily_limit_lyd: Option<&'a str>,
    pub daily_spent_lyd: Option<&'a str>,
    pub status: Option<&'a str>,
    pub static_otp: Option<Option<&'a str>>,
    pub preset_fault: Option<Option<&'a str>>,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
}

pub fn adjust_account(db: &Db, input: &AdjustAccount<'_>) -> ApiResult<Account> {
    db.transaction(|connection| {
        let found = get_account_in(connection, input.account_id)?.ok_or_else(|| {
            ApiError::new(
                404,
                "FAKE_ACCOUNT_NOT_FOUND",
                format!("Fake account {} not found", input.account_id),
            )
        })?;
        let account = roll_daily_spent(connection, &found)?;
        let next_available = if let Some(value) = input.available_balance_lyd {
            micros(value)
        } else if let Some(delta) = input.delta_lyd {
            micros(&account.available_balance_lyd) + micros(delta)
        } else {
            micros(&account.available_balance_lyd)
        };
        let next_limit = input
            .daily_limit_lyd
            .map_or_else(|| micros(&account.daily_limit_lyd), micros);
        let next_spent = input
            .daily_spent_lyd
            .map_or_else(|| micros(&account.daily_spent_lyd), micros);
        if next_available < 0 {
            return Err(ApiError::new(
                409,
                "NEGATIVE_ACCOUNT_BALANCE",
                "The test account balance cannot be negative",
            ));
        }
        if next_limit < 0 || next_spent < 0 {
            return Err(ApiError::new(
                409,
                "NEGATIVE_DAILY_LIMIT",
                "The daily limit and spent amount cannot be negative",
            ));
        }
        let next_status = input.status.unwrap_or(&account.status);
        let next_otp = match input.static_otp {
            Some(value) => value.map(str::to_owned),
            None => account.static_otp.clone(),
        };
        let next_fault = match input.preset_fault {
            Some(value) => value.map(str::to_owned),
            None => account.preset_fault.clone(),
        };
        let now = now_iso();
        connection.execute(
            "UPDATE fake_accounts
                SET available_balance_lyd = ?, daily_limit_lyd = ?, daily_spent_lyd = ?, daily_spent_date = ?,
                    status = ?, static_otp = ?, preset_fault = ?, updated_at = ?
              WHERE id = ?",
            params![
                lyd(next_available),
                lyd(next_limit),
                lyd(next_spent),
                business_date(),
                next_status,
                next_otp,
                next_fault,
                now,
                account.id
            ],
        )?;
        if next_available != micros(&account.available_balance_lyd) {
            let difference = next_available - micros(&account.available_balance_lyd);
            insert_movement(
                connection,
                &account.id,
                None,
                "BALANCE_ADJUSTMENT",
                &lyd(difference.abs()),
                &account.available_balance_lyd,
                &lyd(next_available),
                input.reason.unwrap_or("Manual sandbox balance adjustment"),
                input.actor.unwrap_or("sandbox-user"),
            )?;
        }
        get_account_in(connection, &account.id)?
            .ok_or_else(|| ApiError::new(500, "FAKE_ACCOUNT_NOT_FOUND", "account vanished"))
    })
}

pub fn list_account_movements(db: &Db, account_id: &str, limit: i64) -> ApiResult<Vec<Value>> {
    db.query_json(
        "SELECT * FROM fake_account_movements WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
        vec![text(account_id), int(limit.clamp(1, 500))],
    )
}

pub fn list_account_holds(db: &Db, account_id: &str, limit: i64) -> ApiResult<Vec<Value>> {
    db.query_json(
        "SELECT * FROM fake_account_holds WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
        vec![text(account_id), int(limit.clamp(1, 500))],
    )
}

/// Restores a merchant-owned copy from its shared preset.
pub fn restore_preset_account(db: &Db, account_id: &str) -> ApiResult<Account> {
    let account = get_account(db, account_id)?.ok_or_else(|| {
        ApiError::new(
            404,
            "FAKE_ACCOUNT_NOT_FOUND",
            format!("Fake account {account_id} not found"),
        )
    })?;
    if account.merchant_id.is_none() {
        return Err(ApiError::new(
            409,
            "GLOBAL_ACCOUNT_READONLY",
            "Shared preset accounts are restored by editing the preset itself",
        ));
    }
    let preset = db
        .with(|connection| {
            Ok(connection
                .query_row(
                    "SELECT * FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL LIMIT 1",
                    params![account.rail_code, account.identifier],
                    Account::from_row,
                )
                .optional()?)
        })?
        .ok_or_else(|| {
            ApiError::new(
                409,
                "FAKE_ACCOUNT_PRESET_NOT_FOUND",
                "This account has no shared preset to restore",
            )
        })?;
    adjust_account(
        db,
        &AdjustAccount {
            account_id,
            available_balance_lyd: Some(&preset.available_balance_lyd),
            delta_lyd: None,
            daily_limit_lyd: Some(&preset.daily_limit_lyd),
            daily_spent_lyd: Some("0.0000"),
            status: Some(&preset.status),
            static_otp: Some(preset.static_otp.as_deref()),
            preset_fault: Some(preset.preset_fault.as_deref()),
            actor: Some("sandbox-user"),
            reason: Some("Restored from the shared Fake Rails preset"),
        },
    )
}

pub fn reset_accounts(db: &Db, merchant_id: Option<&str>) -> ApiResult<i64> {
    ensure_default_accounts(db)?;
    let removed = db.transaction(|connection| {
        let rows: Vec<String> = {
            let mut statement = if merchant_id.is_some() {
                connection.prepare("SELECT id FROM fake_accounts WHERE merchant_id = ?")?
            } else {
                connection.prepare("SELECT id FROM fake_accounts WHERE merchant_id IS NOT NULL")?
            };
            let mapped = if let Some(merchant_id) = merchant_id {
                statement.query_map(params![merchant_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            mapped
        };
        for id in &rows {
            connection.execute("DELETE FROM fake_accounts WHERE id = ?", params![id])?;
        }
        if merchant_id.is_none() {
            connection.execute("DELETE FROM fake_accounts WHERE merchant_id IS NULL", [])?;
        }
        connection.execute(
            "INSERT INTO fake_account_resets (id, merchant_id, actor, summary_json, created_at) VALUES (?,?,?,?,?)",
            params![
                uuid_v7(),
                merchant_id,
                "sandbox-control",
                json!({ "removed": rows.len() }).to_string(),
                now_iso()
            ],
        )?;
        Ok(rows.len() as i64)
    })?;
    if merchant_id.is_none() {
        ensure_default_accounts(db)?;
    }
    Ok(removed)
}

pub fn list_clearing_pools(db: &Db) -> ApiResult<Vec<Value>> {
    db.query_json(
        "SELECT * FROM fake_merchant_clearing_pools ORDER BY gateway_code ASC",
        vec![],
    )
}

pub struct ClearingStatement {
    pub rows: Vec<Value>,
    pub gross_lyd: String,
    pub refunds_lyd: String,
    pub net_lyd: String,
    pub fees_lyd: String,
    pub csv: String,
}

pub struct ClearingFilters<'a> {
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub gateway_code: Option<&'a str>,
    pub merchant_id: Option<&'a str>,
    pub include_settled: bool,
    pub include_included: bool,
}

pub fn generate_clearing_statement(
    db: &Db,
    input: &ClearingFilters<'_>,
) -> ApiResult<ClearingStatement> {
    let mut clauses: Vec<&str> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    if !input.include_settled {
        clauses.push("settled_at IS NULL");
    }
    if !input.include_included {
        clauses.push("statement_included_at IS NULL");
    }
    if let Some(merchant_id) = input.merchant_id {
        clauses.push(
            "(SELECT ftt.merchant_id FROM fake_transactions ftt WHERE ftt.id = fake_clearing_entries.transaction_id) = ?",
        );
        params.push(text(merchant_id));
    }
    if let Some(from) = input.from {
        clauses.push("created_at >= ?");
        params.push(text(from));
    }
    if let Some(to) = input.to {
        clauses.push("created_at <= ?");
        params.push(text(to));
    }
    if let Some(gateway_code) = input.gateway_code {
        clauses.push("gateway_code = ?");
        params.push(text(gateway_code));
    }
    let where_clause = if clauses.is_empty() {
        "1 = 1".to_owned()
    } else {
        clauses.join(" AND ")
    };
    let rows = db.query_json(
        &format!(
            "SELECT * FROM fake_clearing_entries WHERE {where_clause} ORDER BY created_at ASC"
        ),
        params,
    )?;
    let mut gross = 0i64;
    let mut refunds = 0i64;
    let mut fees = 0i64;
    let mut lines = Vec::new();
    let mut csv_lines = Vec::new();
    for row in &rows {
        let entry_type = row.get("entry_type").and_then(Value::as_str).unwrap_or("");
        let amount = row
            .get("amount_lyd")
            .and_then(Value::as_str)
            .unwrap_or("0.0000");
        let fee = row
            .get("gateway_fee_lyd")
            .and_then(Value::as_str)
            .unwrap_or("0.0000");
        match entry_type {
            "CAPTURE" => {
                gross += micros(amount);
                fees += micros(fee);
            }
            "REFUND" => refunds += micros(amount),
            _ => {}
        }
        let line = json!({
            "id": row.get("id").cloned().unwrap_or(Value::Null),
            "transactionId": row.get("transaction_id").cloned().unwrap_or(Value::Null),
            "gatewayCode": row.get("gateway_code").cloned().unwrap_or(Value::Null),
            "railCode": row.get("rail_code").cloned().unwrap_or(Value::Null),
            "accountId": row.get("account_id").cloned().unwrap_or(Value::Null),
            "ourReference": row.get("our_reference").cloned().unwrap_or(Value::Null),
            "providerReference": row.get("provider_reference").cloned().unwrap_or(Value::Null),
            "currency": row.get("currency").cloned().unwrap_or(Value::Null),
            "status": row.get("status").cloned().unwrap_or(Value::Null),
            "entryType": entry_type,
            "amountLyd": amount,
            "gatewayFeeLyd": fee,
            "createdAt": row.get("created_at").cloned().unwrap_or(Value::Null),
        });
        csv_lines.push(
            [
                row.get("our_reference")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                row.get("provider_reference")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                row.get("gateway_code")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                row.get("rail_code")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                row.get("currency")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                row.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                match entry_type {
                    "CAPTURE" => "SETTLEMENT".to_owned(),
                    "REFUND" => "REVERSAL".to_owned(),
                    other => other.to_owned(),
                },
                amount.to_owned(),
                fee.to_owned(),
                row.get("created_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ]
            .join(","),
        );
        lines.push(line);
    }
    let csv = format!(
        "our_reference,provider_reference,gateway_code,rail_code,currency,status,entry_type,amount_lyd,fee_lyd,occurred_at\n{}",
        csv_lines.join("\n")
    );
    Ok(ClearingStatement {
        rows: lines,
        gross_lyd: lyd(gross),
        refunds_lyd: lyd(refunds),
        net_lyd: lyd(gross - refunds),
        fees_lyd: lyd(fees),
        csv,
    })
}

pub fn mark_statement_included(db: &Db, entry_ids: &[String], run_id: &str) -> ApiResult<i64> {
    if entry_ids.is_empty() {
        return Ok(0);
    }
    db.transaction(|connection| {
        let now = now_iso();
        let mut changed = 0i64;
        for id in entry_ids {
            changed += connection.execute(
                "UPDATE fake_clearing_entries SET statement_included_at = ?, statement_run_id = ?
                 WHERE id = ? AND statement_included_at IS NULL",
                params![now, run_id, id],
            )? as i64;
        }
        Ok(changed)
    })
}

pub fn release_expired_holds(db: &Db, now: &str) -> ApiResult<i64> {
    let rows = db.query_json(
        "SELECT transaction_id FROM fake_account_holds
         WHERE state = 'HELD' AND expires_at IS NOT NULL AND expires_at <= ?",
        vec![text(now)],
    )?;
    let mut released = 0i64;
    for row in rows {
        if let Some(transaction_id) = row.get("transaction_id").and_then(Value::as_str) {
            if release_hold(db, transaction_id, "Sandbox hold expired")?.is_some() {
                released += 1;
            }
        }
    }
    Ok(released)
}

pub fn mark_clearing_settled(db: &Db, gateway_code: Option<&str>) -> ApiResult<i64> {
    db.transaction(|connection| {
        let changed = if let Some(gateway_code) = gateway_code {
            connection.execute(
                "UPDATE fake_clearing_entries SET settled_at = ? WHERE settled_at IS NULL AND gateway_code = ?",
                params![now_iso(), gateway_code],
            )?
        } else {
            connection.execute(
                "UPDATE fake_clearing_entries SET settled_at = ? WHERE settled_at IS NULL",
                params![now_iso()],
            )?
        };
        if let Some(gateway_code) = gateway_code {
            connection.execute(
                "UPDATE fake_merchant_clearing_pools
                    SET settled_lyd = pending_settlement_lyd, pending_settlement_lyd = '0.0000', updated_at = ?
                  WHERE gateway_code = ?",
                params![now_iso(), gateway_code],
            )?;
        } else {
            connection.execute(
                "UPDATE fake_merchant_clearing_pools
                    SET settled_lyd = pending_settlement_lyd, pending_settlement_lyd = '0.0000', updated_at = ?",
                params![now_iso()],
            )?;
        }
        Ok(changed as i64)
    })
}

pub struct NewAccount<'a> {
    pub rail_code: &'a str,
    pub gateway_code: &'a str,
    pub merchant_id: Option<&'a str>,
    pub instrument_type: &'a str,
    pub identifier: &'a str,
    pub holder_name: &'a str,
    pub secret_pin: &'a str,
    pub expiry: Option<&'a str>,
    pub available_balance_lyd: &'a str,
    pub daily_limit_lyd: &'a str,
    pub status: &'a str,
    pub static_otp: Option<&'a str>,
    pub notes: Option<&'a str>,
}

pub fn create_account(db: &Db, input: &NewAccount<'_>) -> ApiResult<Account> {
    ensure_default_accounts(db)?;
    let identifier = input.identifier.trim();
    db.transaction(|connection| {
        let existing: Option<String> = if let Some(merchant_id) = input.merchant_id {
            connection
                .query_row(
                    "SELECT id FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND (merchant_id = ? OR merchant_id IS NULL)",
                    params![input.rail_code, identifier, merchant_id],
                    |row| row.get(0),
                )
                .optional()?
        } else {
            connection
                .query_row(
                    "SELECT id FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL",
                    params![input.rail_code, identifier],
                    |row| row.get(0),
                )
                .optional()?
        };
        if existing.is_some() {
            return Err(ApiError::new(
                409,
                "FAKE_ACCOUNT_EXISTS",
                "An account with this rail and identifier already exists",
            ));
        }
        let id = uuid_v7();
        let now = now_iso();
        connection.execute(
            "INSERT INTO fake_accounts (
                id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
                holder_name, secret_pin, expiry, currency, available_balance_lyd,
                reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date, status,
                static_otp, preset_fault, notes, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?, 'LYD', ?, '0.0000', ?, '0.0000', ?, ?, ?, NULL, ?, ?, ?)",
            params![
                id,
                input.rail_code,
                input.gateway_code,
                input.merchant_id,
                input.instrument_type,
                identifier,
                input.holder_name.trim(),
                input.secret_pin,
                input.expiry.unwrap_or("12/28"),
                lyd(micros(input.available_balance_lyd)),
                lyd(micros(input.daily_limit_lyd)),
                business_date(),
                input.status,
                input.static_otp,
                input.notes,
                now,
                now
            ],
        )?;
        get_account_in(connection, &id)?
            .ok_or_else(|| ApiError::new(500, "FAKE_ACCOUNT_CREATE_FAILED", "account not created"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rich_account(db: &Db, rail: &str) -> Account {
        list_accounts(
            db,
            &AccountFilters {
                rail_code: Some(rail.to_owned()),
                ..AccountFilters::default()
            },
        )
        .expect("list")
        .into_iter()
        .filter_map(|row| {
            get_account(db, row.get("id").and_then(Value::as_str).unwrap_or(""))
                .ok()
                .flatten()
        })
        .find(|account| account.available_balance_lyd == "50000.0000")
        .expect("rich account")
    }

    fn insert_tx(db: &Db, id: &str, rail: &str, reference: &str, amount: &str, fee: &str) {
        let now = now_iso();
        crate::db::insert_transaction(
            db,
            &crate::db::Transaction {
                id: id.to_owned(),
                gateway_code: rail.to_owned(),
                rail_code: rail.to_owned(),
                env: "SANDBOX".to_owned(),
                our_reference: reference.to_owned(),
                provider_reference: format!("PROV-{reference}"),
                network_reference: None,
                idempotency_key: None,
                requested_amount_wire: amount.to_owned(),
                normalized_amount_lyd: amount.to_owned(),
                settled_amount_lyd: None,
                gateway_fee_lyd: fee.to_owned(),
                currency: "LYD".to_owned(),
                collection_mode: "OTP_PULL".to_owned(),
                customer_identifier_masked: None,
                expected_otp: Some("123456".to_owned()),
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
                created_at: now.clone(),
                updated_at: now,
            },
        )
        .expect("tx");
    }

    #[test]
    fn seeds_five_personas_per_rail() {
        let db = Db::memory().expect("db");
        let accounts = list_accounts(&db, &AccountFilters::default()).expect("list");
        assert_eq!(accounts.len(), 100);
        let mut rails = std::collections::BTreeSet::new();
        for account in &accounts {
            rails.insert(account["rail_code"].as_str().unwrap_or("").to_owned());
        }
        assert_eq!(rails.len(), 20);
        let sadad: Vec<Value> = accounts
            .into_iter()
            .filter(|account| account["rail_code"] == "sadad")
            .collect();
        assert_eq!(sadad.len(), 5);
        assert_eq!(
            sadad
                .iter()
                .filter(|account| account["status"] == "FROZEN")
                .count(),
            1
        );
    }

    #[test]
    fn reserves_captures_and_credits_the_clearing_pool() {
        let db = Db::memory().expect("db");
        let rich = rich_account(&db, "sadad");
        insert_tx(
            &db,
            "TX-CAPTURE-1",
            "sadad",
            "REF-CAPTURE-1",
            "200.0000",
            "0.0000",
        );
        let hold = reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some(&rich.identifier),
                transaction_id: "TX-CAPTURE-1",
                amount_lyd: "200.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        assert!(hold.allowed);
        assert_eq!(hold.account.available_balance_lyd, "49800.0000");
        assert_eq!(hold.account.reserved_balance_lyd, "200.0000");

        let captured = capture_hold(&db, "TX-CAPTURE-1", None)
            .expect("capture")
            .expect("account");
        assert_eq!(captured.reserved_balance_lyd, "0.0000");
        assert_eq!(captured.available_balance_lyd, "49800.0000");
        assert_eq!(captured.daily_spent_lyd, "200.0000");

        let pools: Vec<Value> = list_clearing_pools(&db)
            .expect("pools")
            .into_iter()
            .filter(|pool| pool["rail_code"] == "sadad")
            .collect();
        assert_eq!(pools.len(), 1);
        assert_eq!(pools[0]["pending_settlement_lyd"], "200.0000");
        assert_eq!(pools[0]["tx_count"], 1);
    }

    #[test]
    fn declines_insufficient_limit_and_frozen() {
        let db = Db::memory().expect("db");
        let accounts: Vec<Account> = list_accounts(
            &db,
            &AccountFilters {
                rail_code: Some("sadad".to_owned()),
                ..AccountFilters::default()
            },
        )
        .expect("list")
        .into_iter()
        .filter_map(|row| {
            get_account(&db, row.get("id").and_then(Value::as_str).unwrap_or(""))
                .ok()
                .flatten()
        })
        .collect();
        let low = &accounts[2];
        let limited = &accounts[3];
        let frozen = &accounts[4];
        let low_hold = reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some(&low.identifier),
                transaction_id: "TX-LOW",
                amount_lyd: "200.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        assert!(!low_hold.allowed);
        assert_eq!(low_hold.decline_code, Some("INSUFFICIENT_FUNDS"));
        let limit_hold = reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some(&limited.identifier),
                transaction_id: "TX-LIMIT",
                amount_lyd: "10.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        assert_eq!(limit_hold.decline_code, Some("LIMIT_EXCEEDED"));
        let frozen_hold = reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some(&frozen.identifier),
                transaction_id: "TX-FROZEN",
                amount_lyd: "10.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        assert_eq!(frozen_hold.decline_code, Some("ACCOUNT_FROZEN"));
    }

    #[test]
    fn release_returns_the_held_amount() {
        let db = Db::memory().expect("db");
        let rich = rich_account(&db, "mobicash");
        insert_tx(
            &db,
            "TX-RELEASE-1",
            "mobicash",
            "REF-RELEASE-1",
            "125.0000",
            "0.0000",
        );
        reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "mobicash",
                gateway_code: "mobicash",
                identifier: Some(&rich.identifier),
                transaction_id: "TX-RELEASE-1",
                amount_lyd: "125.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        let released = release_hold(&db, "TX-RELEASE-1", "customer cancelled")
            .expect("release")
            .expect("account");
        assert_eq!(released.available_balance_lyd, "50000.0000");
        assert_eq!(released.reserved_balance_lyd, "0.0000");
    }

    #[test]
    fn refunds_are_capped_at_the_captured_amount() {
        let db = Db::memory().expect("db");
        let rich = rich_account(&db, "onepay");
        insert_tx(
            &db,
            "TX-REFUND-1",
            "onepay",
            "REF-REFUND-1",
            "100.0000",
            "0.0000",
        );
        reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "onepay",
                gateway_code: "onepay",
                identifier: Some(&rich.identifier),
                transaction_id: "TX-REFUND-1",
                amount_lyd: "100.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        capture_hold(&db, "TX-REFUND-1", None).expect("capture");
        let first = refund_transaction(&db, "TX-REFUND-1", Some("40.0000"), "refund")
            .expect("refund")
            .expect("account");
        assert_eq!(first.available_balance_lyd, "49940.0000");
        let error = refund_transaction(&db, "TX-REFUND-1", Some("70.0000"), "refund")
            .expect_err("must exceed");
        assert!(error.message.contains("exceed the captured"));
        let second = refund_transaction(&db, "TX-REFUND-1", Some("60.0000"), "refund")
            .expect("refund")
            .expect("account");
        assert_eq!(second.available_balance_lyd, "50000.0000");
    }

    #[test]
    fn auto_enrols_an_unknown_identifier() {
        let db = Db::memory().expect("db");
        let account = find_or_auto_create_account(
            &db,
            &AutoCreate {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some("0915559999"),
                merchant_id: None,
            },
        )
        .expect("account");
        assert_eq!(account.available_balance_lyd, "2500.0000");
        assert_eq!(account.status, "ACTIVE");
        let adjusted = adjust_account(
            &db,
            &AdjustAccount {
                account_id: &account.id,
                available_balance_lyd: Some("77.5000"),
                delta_lyd: None,
                daily_limit_lyd: None,
                daily_spent_lyd: None,
                status: None,
                static_otp: Some(Some("424242")),
                preset_fault: None,
                actor: None,
                reason: Some("test"),
            },
        )
        .expect("adjust");
        assert_eq!(adjusted.available_balance_lyd, "77.5000");
        assert_eq!(adjusted.static_otp.as_deref(), Some("424242"));
        assert!(!list_account_movements(&db, &account.id, 100)
            .expect("movements")
            .is_empty());
    }

    #[test]
    fn merchant_reset_removes_only_that_merchants_accounts() {
        let db = Db::memory().expect("db");
        let merchant_a = "11111111-1111-4111-8111-111111111111";
        let merchant_b = "22222222-2222-4222-8222-222222222222";
        let account_a = find_or_auto_create_account(
            &db,
            &AutoCreate {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some("0917770001"),
                merchant_id: Some(merchant_a),
            },
        )
        .expect("a");
        let account_b = find_or_auto_create_account(
            &db,
            &AutoCreate {
                rail_code: "sadad",
                gateway_code: "sadad",
                identifier: Some("0917770002"),
                merchant_id: Some(merchant_b),
            },
        )
        .expect("b");
        let removed = reset_accounts(&db, Some(merchant_a)).expect("reset");
        assert_eq!(removed, 101);
        let remaining = list_accounts(&db, &AccountFilters::default()).expect("list");
        assert!(!remaining
            .iter()
            .any(|account| account["id"] == Value::String(account_a.id.clone())));
        assert!(remaining
            .iter()
            .any(|account| account["id"] == Value::String(account_b.id.clone())));
    }

    #[test]
    fn clearing_statements_total_and_settle() {
        let db = Db::memory().expect("db");
        let rich = rich_account(&db, "mobicash");
        insert_tx(
            &db,
            "TX-CLEARING-1",
            "mobicash",
            "REF-CLEARING-1",
            "100.0000",
            "1.5000",
        );
        reserve_account_funds(
            &db,
            &Reserve {
                rail_code: "mobicash",
                gateway_code: "mobicash",
                identifier: Some(&rich.identifier),
                transaction_id: "TX-CLEARING-1",
                amount_lyd: "100.0000",
                merchant_id: None,
            },
        )
        .expect("reserve");
        capture_hold(&db, "TX-CLEARING-1", None).expect("capture");
        refund_transaction(&db, "TX-CLEARING-1", Some("25.0000"), "refund").expect("refund");
        let statement = generate_clearing_statement(
            &db,
            &ClearingFilters {
                from: None,
                to: None,
                gateway_code: Some("mobicash"),
                merchant_id: None,
                include_settled: false,
                include_included: false,
            },
        )
        .expect("statement");
        assert_eq!(statement.gross_lyd, "100.0000");
        assert_eq!(statement.refunds_lyd, "25.0000");
        assert_eq!(statement.net_lyd, "75.0000");
        assert_eq!(statement.fees_lyd, "1.5000");
        assert_eq!(statement.csv.split('\n').count(), 3);
        let settled = mark_clearing_settled(&db, Some("mobicash")).expect("settle");
        assert_eq!(settled, 2);
        let empty = generate_clearing_statement(
            &db,
            &ClearingFilters {
                from: None,
                to: None,
                gateway_code: Some("mobicash"),
                merchant_id: None,
                include_settled: false,
                include_included: false,
            },
        )
        .expect("statement");
        assert!(empty.rows.is_empty());
    }
}
