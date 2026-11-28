//! Shared helpers for the Sandbox control-plane read routes.
//!
//! Port of the router-level middleware and the small helpers of
//! `core-back/api/internal/sandboxControl.ts`:
//!
//! - `isSandboxPlane()` — [`ensure_plane`] answers `403 SANDBOX_PLANE_REQUIRED` off the Sandbox core;
//! - `assertSandboxControlAccess` — [`assert_control_access`] lets any staff principal through and
//!   requires a merchant read grant for everyone else;
//! - `resolveMerchantId` / `merchantScopeForAccounts` — the authenticated merchant wins, a staff
//!   principal must name one (`x-sandbox-merchant-id` header or `merchantId` query);
//! - `walletAmounts` — live shard balances and the per-shard checkpoint summary, in the natural sign
//!   of the account type (`loadLiveAccountBalances` / `loadAccountCheckpointSummary`);
//! - the list contract (`buildListQuery`/`listResponse`) through [`pg_db::list_query`].
//!
//! Two deliberate deviations are recorded here (the coordinator owns `DEVIATIONS.md`):
//!
//! - **DEV-SANDBOX-01 (list filter errors):** a non-decimal `amountMin`/`amountMax` answers
//!   `400 INVALID_FILTER` instead of Prisma's `Decimal` constructor throwing a 500.
//! - **DEV-SANDBOX-02 (malformed merchant id):** a staff `merchantId` that is not a UUID answers
//!   `400 SANDBOX_MERCHANT_REQUIRED`; Prisma raises a 500 for the same input. A merchant principal
//!   always carries a validated UUID from its session, so the error is staff-only.
//!
//! The SQL stays in the route modules so a reviewer can diff it against the TypeScript handler.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::list_query::{
    build_list_query, list_response, BuiltListQuery, ColumnMap, CursorValue, ListSpec, SqlBind,
};
use pg_domain_auth::{Principal, PrincipalKind};
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use pg_http::ApiError;

use crate::routes::common::database_error;
use crate::routes::merchant::{assert_merchant_authority, query_map};
use crate::state::AppState;

/// `SANDBOX_CONTROL_READ_AUTHORITIES`: any one grant lets a merchant principal read.
pub const SANDBOX_READ_AUTHORITIES: [&str; 4] = [
    "merchant:read",
    "merchant:write",
    "payment:read",
    "link:read",
];

/// The default sandbox payout profile (`SANDBOX_PAYOUT_DETAILS`).
pub const SANDBOX_PAYOUT_DETAILS: [(&str, &str); 4] = [
    ("bankName", "Sandbox Test Bank"),
    ("accountNumber", "SBX-0000000001"),
    ("iban", "LY0000000000000000000001"),
    ("accountHolder", "Sandbox Test Merchant"),
];

/// `isSandboxPlane()`: this router only exists on `pg-core-sandbox`.
pub fn ensure_plane(state: &AppState) -> Result<(), ApiError> {
    if state.config.execution_plane.as_str() != "SANDBOX" {
        return Err(ApiError::new(
            403,
            "SANDBOX_PLANE_REQUIRED",
            "This endpoint is only available on the SANDBOX execution plane (pg-core-sandbox)",
        ));
    }
    Ok(())
}

/// `principalOf(request)`: `requireAuthentication` ran in the policy, so a missing principal is a
/// shell bug rather than a request error; keep the TS 401 for the direct-call tests.
pub fn principal(principal: Option<&Principal>) -> Result<&Principal, ApiError> {
    principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })
}

/// `assertSandboxControlAccess`: staff pass, a merchant principal needs one read grant.
///
/// The TypeScript middleware is mounted on the router rather than declared on each route, so the
/// route policies carry no authority list: an authority in [`pg_http::Policy`] would deny a staff
/// principal whose role does not name one of the four grants, while the TS middleware lets every
/// staff principal through. The handler therefore performs the exact role-aware check.
pub fn assert_control_access(principal: &Principal, method: &str) -> Result<(), ApiError> {
    if principal.is_staff() {
        return Ok(());
    }
    let read = matches!(
        method.to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "OPTIONS"
    );
    let required: &[&str] = if read {
        &SANDBOX_READ_AUTHORITIES
    } else {
        &["merchant:write"]
    };
    assert_merchant_authority(principal, required)
}

/// `requireStaff(request)`: `403 STAFF_ONLY` for a merchant principal or API token.
pub fn require_staff(principal_ref: Option<&Principal>) -> Result<&Principal, ApiError> {
    let principal = principal(principal_ref)?;
    if !principal.is_staff() {
        return Err(ApiError::new(
            403,
            "STAFF_ONLY",
            "A staff principal is required",
        ));
    }
    Ok(principal)
}

/// `resolveMerchantId(request)`: the bound merchant, or the staff-named one.
pub fn resolve_merchant_id(principal: &Principal, request: &HttpRequest) -> Result<Uuid, ApiError> {
    if let Some(raw) = principal.merchant_id.as_deref() {
        return Uuid::parse_str(raw).map_err(|_| {
            ApiError::new(
                403,
                "MERCHANT_CONTEXT_REQUIRED",
                "A merchant principal is required",
            )
        });
    }
    if !principal.is_staff() {
        return Err(ApiError::new(
            403,
            "MERCHANT_CONTEXT_REQUIRED",
            "A merchant principal is required",
        ));
    }
    let candidate = header_value(request, "x-sandbox-merchant-id")
        .or_else(|| query_scalar(request, "merchantId"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let Some(candidate) = candidate else {
        return Err(ApiError::new(
            400,
            "SANDBOX_MERCHANT_REQUIRED",
            "A staff Sandbox operation must name the merchant",
        ));
    };
    // DEV-SANDBOX-02: Prisma answers 500 for a non-UUID here; the read routes answer 400.
    Uuid::parse_str(&candidate).map_err(|_| {
        ApiError::new(
            400,
            "SANDBOX_MERCHANT_REQUIRED",
            "A staff Sandbox operation must name the merchant",
        )
    })
}

/// `merchantScopeForAccounts`: the Fake Rails account scope of this request.
///
/// The TypeScript version forwards the raw string to the emulator (which owns the id format), so
/// this returns the header/query value unchanged. `x-sandbox-merchant-id` wins over `merchantId`,
/// exactly like `String(header ?? body.merchantId ?? query.merchantId)`.
pub fn merchant_scope_for_accounts(
    principal: &Principal,
    request: &HttpRequest,
    required: bool,
) -> Result<Option<String>, ApiError> {
    if let Some(raw) = principal.merchant_id.as_deref() {
        return Ok(Some(raw.to_owned()));
    }
    let candidate = header_value(request, "x-sandbox-merchant-id")
        .or_else(|| query_scalar(request, "merchantId"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if candidate.is_some() {
        return Ok(candidate);
    }
    if required {
        return Err(ApiError::new(
            400,
            "SANDBOX_MERCHANT_REQUIRED",
            "A merchant id is required for this account operation",
        ));
    }
    if !principal.is_staff() {
        return Err(ApiError::new(
            403,
            "MERCHANT_CONTEXT_REQUIRED",
            "A merchant principal is required",
        ));
    }
    Ok(None)
}

/// A request header as a string.
#[must_use]
pub fn header_value(request: &HttpRequest, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// The first value of a query key (Express scalar read; not trimmed).
#[must_use]
pub fn query_scalar(request: &HttpRequest, key: &str) -> Option<String> {
    match query_map(request).get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(entries)) => entries.first().and_then(|entry| match entry {
            Value::String(text) => Some(text.clone()),
            _ => None,
        }),
        _ => None,
    }
}

/// `queryString`: the first scalar, trimmed, empty dropped.
#[must_use]
pub fn query_trimmed(request: &HttpRequest, key: &str) -> Option<String> {
    query_scalar(request, key)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// `resolveReportingCurrency`: a requested ISO code, else `BASE_CURRENCY`.
#[must_use]
pub fn resolve_reporting_currency(requested: Option<&str>) -> String {
    let value = requested
        .map(|raw| raw.trim().to_ascii_uppercase())
        .unwrap_or_default();
    if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return value;
    }
    base_currency()
}

/// `env.BASE_CURRENCY` (default `LYD`).
#[must_use]
pub fn base_currency() -> String {
    let configured = std::env::var("BASE_CURRENCY").unwrap_or_default();
    let trimmed = configured.trim().to_ascii_uppercase();
    if trimmed.len() == 3 && trimmed.bytes().all(|byte| byte.is_ascii_uppercase()) {
        trimmed
    } else {
        "LYD".to_owned()
    }
}

/// `Money4`: four fixed decimals; null/absent is `0.0000`.
#[must_use]
pub fn money(value: Option<Decimal>) -> String {
    crate::routes::common::money4(value)
}

/// A decimal value or zero.
#[must_use]
pub fn decimal(value: Option<Decimal>) -> Decimal {
    value.unwrap_or_default()
}

/// `GL_ACCOUNT_TYPES_DEBIT_POSITIVE` / `naturalShardBalance`.
#[must_use]
pub fn natural_balance(account_type: &str, shard_total: Decimal) -> Decimal {
    if shard_total.is_zero() {
        return Decimal::ZERO;
    }
    if matches!(
        account_type,
        "TREASURY"
            | "GATEWAY_CLEARING"
            | "COMMISSION_RECEIVABLE"
            | "PROVIDER_FEE_EXPENSE"
            | "GATEWAY_FEE_EXPENSE"
    ) {
        shard_total
    } else {
        -shard_total
    }
}

/// One wallet and its GL account, as `walletAmounts` reads them.
#[derive(Debug, Clone)]
pub struct WalletRef {
    pub id: Uuid,
    pub gl_account_id: Uuid,
    pub currency: String,
}

/// `walletAmounts()`: live shard balance and checkpoint summary per wallet.
#[derive(Debug, Clone)]
pub struct WalletAmount {
    pub wallet_id: Uuid,
    pub available_balance: String,
    pub checkpoint_balance: String,
    pub checkpoint_at: Option<DateTime<Utc>>,
    pub pending_lines: i64,
    pub shard_count: i32,
    pub checkpoint_status: String,
}

/// The live balances of `wallets`, in the natural sign of their GL accounts.
pub async fn wallet_amounts(
    pool: &PgPool,
    wallets: &[WalletRef],
) -> Result<Vec<WalletAmount>, ApiError> {
    if wallets.is_empty() {
        return Ok(Vec::new());
    }
    let account_ids: Vec<Uuid> = wallets.iter().map(|wallet| wallet.gl_account_id).collect();

    // Live balance: the sum of the account's shard rows (every account has shard 0).
    let live = sqlx::query(
        "SELECT g.id AS gl_account_id, g.account_type::text AS account_type,
                COALESCE(s.total, 0)::text AS total
           FROM gl_accounts g
           LEFT JOIN (
             SELECT gl_account_id, SUM(current_balance) AS total
               FROM gl_account_shards
              WHERE gl_account_id = ANY($1::uuid[])
              GROUP BY gl_account_id
           ) s ON s.gl_account_id = g.id
          WHERE g.id = ANY($1::uuid[])",
    )
    .bind(&account_ids)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    let mut live_by_account: std::collections::HashMap<Uuid, (String, Decimal)> =
        std::collections::HashMap::new();
    for row in &live {
        let account_type: String = row.try_get("account_type").map_err(database_error)?;
        let total: String = row.try_get("total").map_err(database_error)?;
        live_by_account.insert(
            row.try_get("gl_account_id").map_err(database_error)?,
            (account_type, parse_decimal(&total)),
        );
    }

    // Checkpoint summary: the same shape as `loadAccountCheckpointSummary`.
    let checkpoints = sqlx::query(
        "SELECT s.gl_account_id AS gl_account_id,
                g.account_type::text AS account_type,
                g.shard_count::int AS shard_count,
                COALESCE(SUM(c.checkpoint_balance), 0)::text AS checkpoint_balance,
                MIN(c.checkpoint_at) AS checkpoint_at,
                COALESCE(SUM(s.line_seq - COALESCE(c.checkpoint_seq, 0)), 0)::bigint
                  AS pending_lines,
                CASE WHEN bool_or(c.status = 'PARITY') THEN 'PARITY'
                     WHEN bool_or(c.status = 'GAP') THEN 'GAP' ELSE 'OK' END AS status
           FROM gl_account_shards s
           INNER JOIN gl_accounts g ON g.id = s.gl_account_id
           LEFT JOIN gl_shard_checkpoints c
             ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
          WHERE s.gl_account_id = ANY($1::uuid[])
          GROUP BY s.gl_account_id, g.account_type, g.shard_count",
    )
    .bind(&account_ids)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    struct Checkpoint {
        status: String,
        checkpoint_balance: Decimal,
        checkpoint_at: Option<DateTime<Utc>>,
        pending_lines: i64,
        shard_count: i32,
    }
    let mut checkpoint_by_account: std::collections::HashMap<Uuid, Checkpoint> =
        std::collections::HashMap::new();
    for row in &checkpoints {
        let balance: String = row.try_get("checkpoint_balance").map_err(database_error)?;
        checkpoint_by_account.insert(
            row.try_get("gl_account_id").map_err(database_error)?,
            Checkpoint {
                status: row.try_get("status").map_err(database_error)?,
                checkpoint_balance: parse_decimal(&balance),
                checkpoint_at: row.try_get("checkpoint_at").map_err(database_error)?,
                pending_lines: row.try_get("pending_lines").map_err(database_error)?,
                shard_count: row.try_get("shard_count").map_err(database_error)?,
            },
        );
    }

    Ok(wallets
        .iter()
        .map(|wallet| {
            let (account_type, live_total) = live_by_account
                .get(&wallet.gl_account_id)
                .cloned()
                .unwrap_or_else(|| ("MERCHANT_WALLET".to_owned(), Decimal::ZERO));
            let checkpoint = checkpoint_by_account.get(&wallet.gl_account_id);
            // `walletAmounts` negates the debit-positive checkpoint of a merchant wallet.
            let checkpoint_balance = checkpoint
                .map(|checkpoint| natural_balance(&account_type, checkpoint.checkpoint_balance))
                .unwrap_or_default();
            WalletAmount {
                wallet_id: wallet.id,
                available_balance: money(Some(natural_balance(&account_type, live_total))),
                checkpoint_balance: money(Some(checkpoint_balance)),
                checkpoint_at: checkpoint.and_then(|checkpoint| checkpoint.checkpoint_at),
                pending_lines: checkpoint.map_or(0, |checkpoint| checkpoint.pending_lines),
                shard_count: checkpoint.map_or(0, |checkpoint| checkpoint.shard_count),
                checkpoint_status: checkpoint
                    .map(|checkpoint| checkpoint.status.clone())
                    .unwrap_or_else(|| "OK".to_owned()),
            }
        })
        .collect())
}

/// `parseDecimal` without a panic: an unparseable database value reads zero.
#[must_use]
pub fn parse_decimal(value: &str) -> Decimal {
    use std::str::FromStr;
    Decimal::from_str(value.trim()).unwrap_or_default()
}

/// A merchant row as `ensureSandboxMerchantEnvelope` returns it.
#[derive(Debug, Clone)]
pub struct MerchantEnvelope {
    pub trade_name: String,
    pub payout_bank_details: Value,
}

/// `ensureSandboxMerchantEnvelope` + `ensureSandboxPayoutProfile`.
///
/// The GET sandbox overview endpoints create the envelope on first use (a side effect of the
/// TypeScript handler; kept so a fresh Sandbox merchant sees the same screen).
pub async fn ensure_merchant_envelope(
    pool: &PgPool,
    merchant_id: Uuid,
    business_name: Option<&str>,
    email: Option<&str>,
) -> Result<MerchantEnvelope, ApiError> {
    let existing = sqlx::query(
        "SELECT trade_name, payout_bank_details_json, payout_account_hash
           FROM merchants WHERE id = $1",
    )
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?;
    let row = match existing {
        Some(row) => row,
        None => {
            let name = business_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Sandbox Merchant {}", &merchant_id.to_string()[..8]));
            let contact = email
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("sandbox+{merchant_id}@sandbox.local"));
            let details = payout_details_json();
            let hash = payout_account_hash(&details);
            sqlx::query(
                "INSERT INTO merchants (id, updated_at, legal_name, trade_name,
                                        status, kyb_status, onboarding_channel, country,
                                        contact_email, payout_bank_details_json,
                                        payout_account_hash)
                 VALUES ($1, now(), $2, $2, 'ACTIVE'::\"MerchantStatus\",
                         'VERIFIED'::\"KybStatus\", 'SANDBOX', 'LY', $3, $4::jsonb, $5)
                 RETURNING trade_name, payout_bank_details_json, payout_account_hash",
            )
            .bind(merchant_id)
            .bind(&name)
            .bind(&contact)
            .bind(&details)
            .bind(&hash)
            .fetch_one(pool)
            .await
            .map_err(database_error)?
        }
    };
    let hash: Option<String> = row.try_get("payout_account_hash").map_err(database_error)?;
    let mut details: Value = row
        .try_get::<Option<Value>, _>("payout_bank_details_json")
        .map_err(database_error)?
        .unwrap_or(Value::Null);
    if hash.is_none() {
        if details.is_null() {
            details = payout_details_json();
        }
        if let Some(computed) = payout_account_hash(&details) {
            sqlx::query("UPDATE merchants SET payout_account_hash = $2 WHERE id = $1")
                .bind(merchant_id)
                .bind(&computed)
                .execute(pool)
                .await
                .map_err(database_error)?;
        }
    }
    Ok(MerchantEnvelope {
        trade_name: row.try_get("trade_name").map_err(database_error)?,
        payout_bank_details: details,
    })
}

/// `SANDBOX_PAYOUT_DETAILS` as JSON.
#[must_use]
pub fn payout_details_json() -> Value {
    let mut map = Map::new();
    for (key, value) in SANDBOX_PAYOUT_DETAILS {
        map.insert(key.to_owned(), Value::String(value.to_owned()));
    }
    Value::Object(map)
}

/// `payoutAccountHash`: `sha256Hex('payout-account:<bank>:<account>')` over normalized parts.
#[must_use]
pub fn payout_account_hash(value: &Value) -> Option<String> {
    let source = value.as_object()?;
    let text = |key: &str| source.get(key).and_then(Value::as_str).unwrap_or_default();
    let account = ["iban", "accountNumber", "account", "account_number"]
        .iter()
        .map(|key| text(key))
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
        .trim();
    if account.is_empty() {
        return None;
    }
    let bank = ["bank", "bankName", "bank_name"]
        .iter()
        .map(|key| text(key))
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
        .trim();
    Some(pg_crypto::sha256_hex(
        format!(
            "payout-account:{}:{}",
            normalize_identity(bank),
            normalize_identity(account)
        )
        .as_bytes(),
    ))
}

fn normalize_identity(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .collect::<String>()
        .to_uppercase()
}

// ---------------------------------------------------------------------------------------------
// List contract helpers (the admin ledger/operations modules keep private equivalents)
// ---------------------------------------------------------------------------------------------

/// `buildListQuery`: the request query map through the caller's spec and column map.
pub fn build_list(
    request: &HttpRequest,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, ApiError> {
    build_list_query(&query_map(request), spec, columns).map_err(invalid_filter)
}

fn invalid_filter(error: pg_db::DbError) -> ApiError {
    // DEV-SANDBOX-01: Prisma throws a 500 for a non-decimal range; the read routes answer 400.
    ApiError::new(400, "INVALID_FILTER", error.to_string())
}

/// A `sqlx` failure in the TS error envelope (a thin public wrapper for the route modules).
#[must_use]
pub fn sqlx_error(error: sqlx::Error) -> ApiError {
    database_error(error)
}

/// A query from a dynamically composed SQL string.
///
/// Every fragment of these strings is a fixed constant (a projection table, a `WHERE` built by
/// [`pg_db::list_query`], a fixed predicate); client values are always `sqlx` binds. sqlx 0.9
/// requires the `AssertSqlSafe` audit for an owned `String`, which this helper applies once.
pub fn safe_query(
    sql: String,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    sqlx::query(sqlx::AssertSqlSafe(sql))
}

/// A rejected list spec/filter (`DbError`) as `400 INVALID_FILTER`.
#[must_use]
pub fn filter_error(error: pg_db::DbError) -> ApiError {
    invalid_filter(error)
}

/// Add a bind and return its placeholder, e.g. `$3`.
pub fn bind_text(built: &mut BuiltListQuery, value: String) -> String {
    built.binds.push(SqlBind::Text(value));
    format!("${}", built.binds.len())
}

/// Bind a UUID as text with an explicit cast.
pub fn bind_uuid(built: &mut BuiltListQuery, value: Uuid) -> String {
    format!("{}::uuid", bind_text(built, value.to_string()))
}

/// `andWhere`: append a fixed predicate to the built WHERE clause.
pub fn push_condition(built: &mut BuiltListQuery, clause: String) {
    if built.where_sql.is_empty() {
        built.where_sql = format!("WHERE {clause}");
    } else {
        built.where_sql.push_str(&format!(" AND {clause}"));
    }
}

/// A list envelope with `nextCursor` when the keyset plan is eligible and the page is full.
pub fn list_envelope(
    key: &str,
    rows: Vec<Value>,
    total: Option<i64>,
    built: &BuiltListQuery,
    source_rows: &[Vec<CursorValue>],
) -> Value {
    list_response(key, Value::Array(rows), total, built, source_rows)
}

/// One model row as JSON, with every nested JSON object in JavaScript property order.
pub fn ordered_row(
    row: &sqlx::postgres::PgRow,
    fields: &[crate::routes::merchant::Field],
) -> Result<Value, ApiError> {
    crate::routes::merchant::row_json(row, fields).map(|value| pg_types::js_object_order(&value))
}

/// Model rows as JSON, nested JSON objects ordered like JavaScript.
pub fn ordered_rows(
    rows: &[sqlx::postgres::PgRow],
    fields: &[crate::routes::merchant::Field],
) -> Result<Vec<Value>, ApiError> {
    rows.iter().map(|row| ordered_row(row, fields)).collect()
}

/// A JSON object keyed by a database enum with integer counts (`reduce` order preserved).
#[must_use]
pub fn count_map(entries: Vec<(String, i64)>) -> Value {
    let mut map = Map::new();
    for (key, count) in entries {
        map.insert(key, Value::from(count));
    }
    Value::Object(map)
}

/// A principal bound to a merchant (or a staff principal) for direct handler tests.
#[must_use]
pub fn session_principal(
    merchant_id: Option<&str>,
    role: &str,
    authorities: &[&str],
    kind: PrincipalKind,
) -> Principal {
    Principal {
        kind,
        user_id: Some(Uuid::new_v4().to_string()),
        role: Some(role.to_owned()),
        merchant_id: merchant_id.map(str::to_owned),
        application_id: None,
        authorities: authorities
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        scopes: Vec::new(),
        token_id: None,
        token_plane: None,
        session_jti: None,
        session_exp: None,
        session_channel: None,
        app_scope_ids: Vec::new(),
    }
}

/// A `400 INVALID_BODY` with the `parseOrThrow` shape (only the path-id parser uses it here).
#[must_use]
pub fn invalid_path(field: &str, message: &str) -> ApiError {
    ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!({
        "issues": [{ "path": [field], "code": "invalid_format", "message": message }]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payout_hash_matches_the_typescript_recipe() {
        let details = payout_details_json();
        let hash = payout_account_hash(&details).expect("hash");
        assert_eq!(hash.len(), 64);
        assert_eq!(
            hash,
            pg_crypto::sha256_hex(b"payout-account:SANDBOXTESTBANK:LY0000000000000000000001")
        );
        assert!(payout_account_hash(&json!({ "bankName": "x" })).is_none());
    }

    #[test]
    fn natural_balance_flips_credit_normal_accounts() {
        assert_eq!(
            natural_balance("MERCHANT_WALLET", Decimal::new(2500, 2)),
            Decimal::new(-2500, 2)
        );
        assert_eq!(
            natural_balance("TREASURY", Decimal::new(2500, 2)),
            Decimal::new(2500, 2)
        );
        assert_eq!(
            natural_balance("MERCHANT_WALLET", Decimal::ZERO),
            Decimal::ZERO
        );
    }

    #[test]
    fn reporting_currency_is_an_iso_code_or_the_base() {
        assert_eq!(resolve_reporting_currency(Some("usd")), "USD");
        assert_eq!(resolve_reporting_currency(Some("US")), base_currency());
        assert_eq!(resolve_reporting_currency(Some("US1")), base_currency());
    }

    #[test]
    fn malformed_merchant_ids_are_a_400() {
        let principal = session_principal(
            None,
            "COMPLIANCE",
            &["merchant:read"],
            PrincipalKind::Session,
        );
        let request = ntex::web::test::TestRequest::default()
            .uri("/internal/sandbox/merchant/overview?merchantId=not-a-uuid")
            .to_http_request();
        let error = resolve_merchant_id(&principal, &request).expect_err("invalid");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "SANDBOX_MERCHANT_REQUIRED");
    }

    #[test]
    fn merchant_principals_never_name_another_merchant() {
        let principal = session_principal(
            Some("00000000-0000-4000-8000-000000000001"),
            "MERCHANT_ADMIN",
            &["merchant:write"],
            PrincipalKind::Session,
        );
        let request = ntex::web::test::TestRequest::default()
            .uri("/internal/sandbox/merchant/overview?merchantId=00000000-0000-4000-8000-000000000009")
            .to_http_request();
        let resolved = resolve_merchant_id(&principal, &request).expect("bound merchant");
        assert_eq!(resolved.to_string(), "00000000-0000-4000-8000-000000000001");
    }
}
