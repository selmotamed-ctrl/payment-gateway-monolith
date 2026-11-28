//! Shared helpers of the admin ledger/audit read routes.
//!
//! Port of the small helpers in `core-back/api/internal/adminSliceHelpers.ts` and
//! `ledgerLines.ts` (query scalars, enum/uuid list filters, `Money4`, search clauses) plus the
//! shard balance readers of `core-back/lib/storageEngine/shardBalances.ts`.
//!
//! Everything here is read-only except [`write_audit_row`], which appends the compatibility
//! `audit_log` row (and the `audit_outbox` copy when a dedicated audit database is configured)
//! for the `*/export` GET handlers, exactly like `writeAudit`.

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_db::{BuiltListQuery, CursorValue, DbError, SqlBind};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::str::FromStr;
use uuid::Uuid;

use crate::state::AppState;

/// `JournalRefType` (core-back/prisma/schema.prisma).
pub(super) const JOURNAL_REF_TYPES: [&str; 8] = [
    "PAYMENT_ATTEMPT",
    "ADJUSTMENT",
    "AML_RELEASE",
    "AML_VOID",
    "SETTLEMENT_SWEEP",
    "FEE_VARIANCE",
    "COMMISSION_NETTING",
    "DISPUTE_OUTCOME",
];

/// `REFERENCE_ROUTES` of `adminLedger.ts:43`.
pub(super) fn reference_route(ref_type: &str) -> &'static str {
    match ref_type {
        "PAYMENT_ATTEMPT" => "attempt",
        "ADJUSTMENT" => "adjustment",
        "AML_RELEASE" | "AML_VOID" => "aml-case",
        "SETTLEMENT_SWEEP" => "settlement",
        "FEE_VARIANCE" => "reconciliation",
        "COMMISSION_NETTING" => "commission",
        "DISPUTE_OUTCOME" => "dispute",
        _ => "attempt",
    }
}

/// A parsed query string: the first value of each key (Express `req.query` for a scalar read).
#[must_use]
pub(super) fn query_map(request: &HttpRequest) -> Map<String, Value> {
    let raw = request.query_string();
    let mut map = Map::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        map.entry(key.into_owned())
            .or_insert_with(|| Value::String(value.into_owned()));
    }
    map
}

/// The first raw (untrimmed) non-empty scalar of a key (`auditStoreParamsFromRequest.first`).
#[must_use]
pub(super) fn scalar_raw<'a>(query: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    match query.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
        _ => None,
    }
}

/// `queryString` of `adminSliceHelpers.ts`: first scalar, trimmed, empty becomes `None`.
#[must_use]
pub(super) fn scalar_trimmed(query: &Map<String, Value>, key: &str) -> Option<String> {
    scalar_raw(query, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `UUID_PATTERN` of `lib/search/uuidSearch.ts` (hyphenated, 36 chars, case-insensitive).
#[must_use]
pub(super) fn is_uuid_pattern(value: &str) -> bool {
    let bytes = value.trim().as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

fn invalid_filter(name: &str, detail: Option<Value>) -> ApiError {
    let mut error = ApiError::new(
        400,
        "INVALID_FILTER",
        format!("The '{name}' filter is invalid"),
    );
    if let Some(detail) = detail {
        error = error.with_details(detail);
    }
    error
}

/// `enumListFilter`: comma separated, unknown members are a 400 (never a database error).
pub(super) fn enum_list_filter(
    query: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = scalar_trimmed(query, key) else {
        return Ok(None);
    };
    let values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    let unknown: Vec<&String> = values
        .iter()
        .filter(|entry| !allowed.contains(&entry.as_str()))
        .collect();
    if unknown.is_empty() && !values.is_empty() {
        return Ok(Some(values));
    }
    Err(invalid_filter(
        key,
        Some(serde_json::json!({
            "allowed": allowed,
            "unknown": unknown,
        })),
    ))
}

/// `uuidListFilter`: comma separated ids, all must be UUIDs.
pub(super) fn uuid_list_filter(
    query: &Map<String, Value>,
    key: &str,
) -> Result<Option<Vec<Uuid>>, ApiError> {
    let Some(raw) = scalar_trimmed(query, key) else {
        return Ok(None);
    };
    let values: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    if values.is_empty() {
        return Err(invalid_filter(key, None));
    }
    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        if !is_uuid_pattern(value) {
            return Err(invalid_filter(key, None));
        }
        let id = Uuid::parse_str(value).map_err(|_| invalid_filter(key, None))?;
        ids.push(id);
    }
    Ok(Some(ids))
}

/// The `checklist` query parameter of the export routes: comma separated, trimmed, allow-listed.
#[must_use]
pub(super) fn checklist(query: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    let Some(raw) = scalar_raw(query, "checklist") else {
        return Vec::new();
    };
    raw.split(',')
        .map(str::trim)
        .filter(|entry| allowed.contains(entry))
        .map(str::to_owned)
        .collect()
}

/// `resolveReportingCurrency` (`lib/reportingCurrency.ts`), with the deploy base currency.
#[must_use]
pub(super) fn resolve_reporting_currency(requested: Option<&str>) -> String {
    let value = requested
        .map(|value| value.trim().to_ascii_uppercase())
        .unwrap_or_default();
    if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return value;
    }
    base_currency()
}

/// `env.BASE_CURRENCY` (default `LYD`, `^[A-Za-z]{3}$`).
#[must_use]
pub(super) fn base_currency() -> String {
    let value = std::env::var("BASE_CURRENCY")
        .map(|value| value.trim().to_ascii_uppercase())
        .unwrap_or_default();
    if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        value
    } else {
        "LYD".to_owned()
    }
}

/// `new Date(value)` for the query values the handlers accept. Invalid values are ignored.
#[must_use]
pub(super) fn parse_js_date(value: &str) -> Option<DateTime<Utc>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.with_timezone(&Utc));
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(parsed.and_utc());
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S%.f") {
        return Some(parsed.and_utc());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc());
    }
    None
}

/// `decimal(value)` for a database text value; a malformed value reads as zero.
#[must_use]
pub(super) fn money_dec(value: &str) -> Decimal {
    Decimal::from_str(value).unwrap_or_default()
}

/// `money4`: `decimal.js` `toFixed(4)`, `-0` normalised.
#[must_use]
pub(super) fn money4(value: Decimal) -> String {
    pg_types::Money4(value).to_string()
}

/// `toFixed(2)` used by the route-cap utilisation percentage.
#[must_use]
pub(super) fn money2(value: Decimal) -> String {
    let rounded =
        value.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointAwayFromZero);
    let negative = rounded.is_sign_negative() && !rounded.is_zero();
    let cents = (rounded.abs() * Decimal::from(100))
        .round_dp_with_strategy(0, rust_decimal::RoundingStrategy::MidpointAwayFromZero);
    let cents = cents.to_i64().unwrap_or_default();
    format!(
        "{}{}.{:02}",
        if negative { "-" } else { "" },
        cents / 100,
        cents % 100
    )
}

/// `money4` of an optional database text column (`null` → `0.0000`).
#[must_use]
pub(super) fn money4_text(value: Option<&str>) -> String {
    money4(value.map(money_dec).unwrap_or_default())
}

/// `Date#toISOString()` of a `timestamp(3)` column (UTC, three fraction digits).
#[must_use]
pub(super) fn iso_naive(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date#toISOString()` of a `timestamptz` value.
#[must_use]
pub(super) fn iso_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A database failure becomes the generic 500 envelope (the TS error handler does the same).
#[must_use]
pub(super) fn db_error(error: DbError) -> ApiError {
    tracing::error!(error = %error, "admin ledger query failed");
    ApiError::server_error()
}

/// A `sqlx` failure becomes the generic 500 envelope.
#[must_use]
pub(super) fn sqlx_error(error: sqlx::Error) -> ApiError {
    db_error(DbError::from(error))
}

/// Append an extra `AND (...)` condition to a built list query, binding its placeholders.
pub(super) fn push_condition(built: &mut BuiltListQuery, clause: String) {
    if clause.is_empty() {
        return;
    }
    if built.where_sql.is_empty() {
        built.where_sql = format!("WHERE {clause}");
    } else {
        built.where_sql = format!("{} AND ({clause})", built.where_sql);
    }
}

/// Bind a text placeholder and return its SQL token.
pub(super) fn bind_text(built: &mut BuiltListQuery, value: String) -> String {
    built.binds.push(SqlBind::Text(value));
    format!("${}::text", built.binds.len())
}

/// Bind a uuid placeholder and return its SQL token.
pub(super) fn bind_uuid(built: &mut BuiltListQuery, value: Uuid) -> String {
    built.binds.push(SqlBind::Text(value.to_string()));
    format!("${}::uuid", built.binds.len())
}

/// The source row values for the `nextCursor` envelope when the plan is `createdAt, id`.
#[must_use]
pub(super) fn created_at_cursor(
    built: &BuiltListQuery,
    created_at: String,
    id: Uuid,
) -> Vec<CursorValue> {
    let is_created_at_plan = built.keyset.as_ref().is_some_and(|plan| {
        plan.fields.len() == 2 && plan.fields[0].path == "createdAt" && plan.fields[1].path == "id"
    });
    if is_created_at_plan {
        vec![
            CursorValue::Date(created_at),
            CursorValue::Text(id.to_string()),
        ]
    } else {
        Vec::new()
    }
}

/// `requireUuidParam`-style refusal for an invalid path value.
pub(super) fn uuid_or_not_found(
    value: &str,
    code: &'static str,
    message: &'static str,
) -> Result<Uuid, ApiError> {
    let value = value.trim();
    if !is_uuid_pattern(value) {
        return Err(ApiError::new(404, code, message));
    }
    Uuid::parse_str(value).map_err(|_| ApiError::new(404, code, message))
}

fn path_segments(request: &HttpRequest) -> Vec<&str> {
    request
        .path()
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// The `:id` of `GET /internal/admin/finance/journal-entries/:id`.
pub(super) fn journal_entry_id(request: &HttpRequest) -> Result<Uuid, ApiError> {
    let segments = path_segments(request);
    let value = segments.last().copied().unwrap_or_default();
    uuid_or_not_found(
        value,
        "JOURNAL_ENTRY_NOT_FOUND",
        "The journal entry does not exist",
    )
}

/// The `:id` of the GL-account routes.
pub(super) fn gl_account_id(request: &HttpRequest) -> Result<Uuid, ApiError> {
    let segments = path_segments(request);
    let value = segments
        .iter()
        .position(|segment| *segment == "gl-accounts")
        .and_then(|index| segments.get(index + 1))
        .copied()
        .unwrap_or_default();
    uuid_or_not_found(
        value,
        "GL_ACCOUNT_NOT_FOUND",
        "The GL account does not exist",
    )
}

/// The `:id` and `:shardId` of the shard repair-plan route.
pub(super) fn gl_account_shard(request: &HttpRequest) -> Result<(Uuid, i64), ApiError> {
    let account = gl_account_id(request)?;
    let segments = path_segments(request);
    let value = segments
        .iter()
        .position(|segment| *segment == "shards")
        .and_then(|index| segments.get(index + 1))
        .copied()
        .unwrap_or_default();
    let shard = value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|id| (0..=255).contains(id));
    match shard {
        Some(shard) => Ok((account, shard)),
        None => Err(ApiError::new(
            404,
            "GL_SHARD_NOT_FOUND",
            "The shard does not exist",
        )),
    }
}

/// The `:id` of `GET /internal/admin/audit-logs/:id` (`z.object({ id: /^[A-Za-z0-9_-]+$/ })`).
pub(super) fn audit_log_id(request: &HttpRequest) -> Result<Uuid, ApiError> {
    let segments = path_segments(request);
    let value = segments.last().copied().unwrap_or_default();
    let valid = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid {
        return Err(
            ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(
                serde_json::json!([{
                    "path": ["id"],
                    "code": "invalid_string",
                    "message": "Invalid",
                }]),
            ),
        );
    }
    // The column is a native uuid. `idSchema` only checks the character pattern, so a
    // pattern-valid but non-uuid id reaches Prisma's uuid validation and surfaces a 500 in TS.
    Uuid::parse_str(value).map_err(|_| ApiError::server_error())
}

/// A `Money4`/`Decimal` sum accumulator of one journal entry.
#[derive(Debug, Default, Clone)]
pub(super) struct LineTotals {
    pub count: usize,
    pub debit: Decimal,
    pub credit: Decimal,
    pub currencies: BTreeSet<String>,
}

impl LineTotals {
    pub(super) fn add(&mut self, direction: &str, amount: Decimal, currency: Option<&str>) {
        self.count += 1;
        if direction == "DEBIT" {
            self.debit += amount;
        } else {
            self.credit += amount;
        }
        if let Some(currency) = currency.filter(|value| !value.is_empty()) {
            self.currencies.insert(currency.to_owned());
        }
    }

    #[must_use]
    pub(super) fn balanced(&self) -> bool {
        // An entry without lines is not balanced; it is broken.
        self.count > 0 && self.debit == self.credit
    }

    #[must_use]
    pub(super) fn currency(&self) -> Option<String> {
        match self.currencies.len() {
            0 => None,
            1 => self.currencies.iter().next().cloned(),
            _ => Some("MIXED".to_owned()),
        }
    }
}

/// A live account balance (`loadLiveAccountBalances`), natural sign.
#[derive(Debug, Clone)]
pub(super) struct LiveBalance {
    pub id: Uuid,
    pub account_type: String,
    pub currency: String,
    pub balance: Decimal,
}

/// The account types stored debit-positive (`REPO` parity lists).
const DEBIT_POSITIVE_ACCOUNT_TYPES: [&str; 5] = [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "PROVIDER_FEE_EXPENSE",
    "GATEWAY_FEE_EXPENSE",
];

/// `naturalBalance(type, debitPositive)`.
#[must_use]
pub(super) fn natural_balance(account_type: &str, debit_positive: Decimal) -> Decimal {
    if DEBIT_POSITIVE_ACCOUNT_TYPES.contains(&account_type) {
        debit_positive
    } else {
        -debit_positive
    }
}

/// `naturalShardBalance`: a zero shard total stays `0`, never `-0`.
fn natural_shard_balance(account_type: &str, raw: &str) -> Decimal {
    let value = money_dec(raw);
    if value.is_zero() {
        Decimal::ZERO
    } else {
        natural_balance(account_type, value)
    }
}

/// `loadLiveAccountBalances`: one statement over the shard rows, optional account filter.
pub(super) async fn load_live_balances(
    pool: &PgPool,
    account_ids: Option<&[Uuid]>,
) -> Result<Vec<LiveBalance>, ApiError> {
    if account_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }
    let sql = match account_ids {
        Some(_) => {
            "SELECT g.id, g.account_type::text AS account_type, g.currency::text AS currency,
                        COALESCE(s.total, 0)::text AS raw
                 FROM gl_accounts g
                 LEFT JOIN (
                   SELECT gl_account_id, SUM(current_balance) AS total
                   FROM gl_account_shards
                   WHERE gl_account_id = ANY($1::uuid[])
                   GROUP BY gl_account_id
                 ) s ON s.gl_account_id = g.id
                 WHERE g.id = ANY($1::uuid[])"
        }
        None => {
            "SELECT g.id, g.account_type::text AS account_type, g.currency::text AS currency,
                        COALESCE(s.total, 0)::text AS raw
                 FROM gl_accounts g
                 LEFT JOIN (
                   SELECT gl_account_id, SUM(current_balance) AS total
                   FROM gl_account_shards
                   GROUP BY gl_account_id
                 ) s ON s.gl_account_id = g.id"
        }
    };
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(ids) = account_ids {
        query = query.bind(ids.to_vec());
    }
    let rows = query.fetch_all(pool).await.map_err(sqlx_error)?;
    let mut balances = Vec::with_capacity(rows.len());
    for row in rows {
        use sqlx::Row;
        let id: Uuid = row.try_get("id").map_err(sqlx_error)?;
        let account_type: String = row.try_get("account_type").map_err(sqlx_error)?;
        let currency: String = row.try_get("currency").map_err(sqlx_error)?;
        let raw: String = row.try_get("raw").map_err(sqlx_error)?;
        balances.push(LiveBalance {
            id,
            account_type: account_type.clone(),
            currency,
            balance: natural_shard_balance(&account_type, &raw),
        });
    }
    Ok(balances)
}

/// `loadAccountCheckpointSummary` (per shard checkpoints, summed; oldest checkpoint time).
#[derive(Debug, Clone, Default)]
pub(super) struct CheckpointSummary {
    pub checkpoint_balance: Decimal,
    pub checkpoint_at: Option<DateTime<Utc>>,
    pub pending_lines: String,
    pub shards_behind: i64,
    pub status: String,
}

/// The checkpoint state of one account, or `None` when the account does not exist.
pub(super) async fn load_checkpoint_summary(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<Option<CheckpointSummary>, ApiError> {
    let rows = sqlx::query(
        "SELECT COALESCE(SUM(c.checkpoint_balance), 0)::text AS checkpoint_balance,
                MIN(c.checkpoint_at) AS checkpoint_at,
                COALESCE(SUM(s.line_seq - COALESCE(c.checkpoint_seq, 0)), 0)::text AS pending_lines,
                COUNT(*) FILTER (WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0))::bigint AS shards_behind,
                CASE WHEN bool_or(c.status = 'PARITY') THEN 'PARITY'
                     WHEN bool_or(c.status = 'GAP') THEN 'GAP' ELSE 'OK' END AS status
         FROM gl_account_shards s
         INNER JOIN gl_accounts g ON g.id = s.gl_account_id
         LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
         WHERE s.gl_account_id = $1::uuid
         GROUP BY s.gl_account_id, g.account_type, g.shard_count",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    use sqlx::Row;
    Ok(Some(CheckpointSummary {
        checkpoint_balance: money_dec(
            &row.try_get::<String, _>("checkpoint_balance")
                .map_err(sqlx_error)?,
        ),
        checkpoint_at: row.try_get("checkpoint_at").map_err(sqlx_error)?,
        pending_lines: row.try_get("pending_lines").map_err(sqlx_error)?,
        shards_behind: row.try_get("shards_behind").map_err(sqlx_error)?,
        status: row.try_get("status").map_err(sqlx_error)?,
    }))
}

/// The audit identity of a staff principal (`auditActor`): `None` when there is no human user.
#[must_use]
pub(super) fn audit_actor(principal: Option<&Principal>) -> Option<(Uuid, String)> {
    let principal = principal?;
    let id = principal.user_id.as_deref()?;
    let id = Uuid::parse_str(id).ok()?;
    Some((
        id,
        principal
            .role
            .clone()
            .unwrap_or_else(|| "UNKNOWN".to_owned()),
    ))
}

/// `writeAudit`: the compatibility `audit_log` row plus, when a dedicated audit database is
/// configured, the transactional `audit_outbox` copy (one transaction).
pub(super) async fn write_audit_row(
    state: &AppState,
    principal: Option<&Principal>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    before_json: Value,
    after_json: Value,
) -> Result<(), ApiError> {
    let (actor_id, role) = audit_actor(principal).ok_or_else(|| {
        ApiError::forbidden(
            "APPROVAL_PRINCIPAL_REQUIRED",
            "A human user principal is required for maker-checker operations",
        )
    })?;
    let id = pg_types::new_v7();
    let now = Utc::now().naive_utc();
    let mut tx = state.pools.main.begin().await.map_err(sqlx_error)?;
    sqlx::query(
        "INSERT INTO audit_log (id, created_at, updated_at, actor_id, role, action,
                                entity_type, entity_id, before_json, after_json)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10::jsonb)",
    )
    .bind(id)
    .bind(now)
    .bind(now)
    .bind(actor_id)
    .bind(role.as_str())
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(before_json.clone())
    .bind(after_json.clone())
    .execute(&mut *tx)
    .await
    .map_err(sqlx_error)?;
    if state.pools.audit.is_some() {
        sqlx::query(
            "INSERT INTO audit_outbox (id, actor_id, role, action, entity_type, entity_id,
                                       before_json, after_json, created_at)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz)",
        )
        .bind(id)
        .bind(actor_id)
        .bind(role.as_str())
        .bind(action)
        .bind(entity_type)
        .bind(entity_id)
        .bind(before_json)
        .bind(after_json)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await
        .map_err(sqlx_error)?;
    }
    tx.commit().await.map_err(sqlx_error)?;
    Ok(())
}

/// Finish a handler: JSON on success, the error envelope on failure.
#[must_use]
pub(super) fn respond(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => super::super::common::json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}

/// Define a mounted handler from an async inner function `(state, request, principal)`.
macro_rules! custom_route {
    ($name:ident, $inner:expr) => {
        pub(super) fn $name<'a>(
            state: &'a crate::state::AppState,
            request: &'a ntex::web::HttpRequest,
            principal: Option<&'a pg_domain_auth::Principal>,
            _payload: ntex::web::types::Payload,
        ) -> crate::routes::HandlerFuture<'a> {
            Box::pin(async move {
                let result = $inner(state, request, principal).await;
                $crate::routes::admin_ledger::support::respond(request, result)
            })
        }
    };
}

/// Define a mounted handler whose response carries `Cache-Control: no-store`.
macro_rules! custom_route_no_store {
    ($name:ident, $inner:expr) => {
        pub(super) fn $name<'a>(
            state: &'a crate::state::AppState,
            request: &'a ntex::web::HttpRequest,
            principal: Option<&'a pg_domain_auth::Principal>,
            _payload: ntex::web::types::Payload,
        ) -> crate::routes::HandlerFuture<'a> {
            Box::pin(async move {
                let result = $inner(state, request, principal).await;
                let mut response = $crate::routes::admin_ledger::support::respond(request, result);
                response.headers_mut().insert(
                    ntex::http::header::CACHE_CONTROL,
                    ntex::http::header::HeaderValue::from_static("no-store"),
                );
                response
            })
        }
    };
}

pub(super) use custom_route;
pub(super) use custom_route_no_store;

/// Unit-test coverage of the helper contracts (no database).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_pattern_matches_the_ts_regex() {
        assert!(is_uuid_pattern("018f0b4e-7a7b-7000-8000-000000000000"));
        assert!(is_uuid_pattern("018F0B4E-7A7B-7000-8000-000000000000"));
        assert!(!is_uuid_pattern("018f0b4e7a7b70008000000000000000"));
        assert!(!is_uuid_pattern("018f0b4e-7a7b-7000-8000-00000000000g"));
        assert!(!is_uuid_pattern(""));
    }

    #[test]
    fn natural_signs_follow_the_account_type() {
        assert_eq!(
            natural_balance("TREASURY", Decimal::new(10, 0)),
            Decimal::new(10, 0)
        );
        assert_eq!(
            natural_balance("MERCHANT_WALLET", Decimal::new(10, 0)),
            Decimal::new(-10, 0)
        );
    }

    #[test]
    fn money_formats_like_money4() {
        assert_eq!(money4(Decimal::new(5, 0)), "5.0000");
        assert_eq!(money4(Decimal::new(-5, 2)), "-0.0500");
        assert_eq!(money4(Decimal::ZERO), "0.0000");
        assert_eq!(money4_text(None), "0.0000");
        assert_eq!(money2(Decimal::new(35, 1)), "3.50");
        assert_eq!(money2(Decimal::new(12345, 3)), "12.35");
        assert_eq!(money2(Decimal::ZERO), "0.00");
    }

    #[test]
    fn currency_resolution_uses_the_base_when_invalid() {
        assert_eq!(resolve_reporting_currency(Some("lyd")), "LYD");
        assert_eq!(resolve_reporting_currency(Some("USD")), "USD");
        assert_eq!(resolve_reporting_currency(None).len(), 3);
    }

    #[test]
    fn checklist_filters_unknown_entries() {
        let mut query = Map::new();
        query.insert("checklist".to_owned(), Value::String("A, B ,X".to_owned()));
        assert_eq!(
            checklist(&query, &["A", "B"]),
            vec!["A".to_owned(), "B".to_owned()]
        );
    }

    #[test]
    fn js_dates_accept_bare_dates_and_rfc3339() {
        assert_eq!(
            parse_js_date("2026-01-01").map(|value| value.to_rfc3339()),
            Some("2026-01-01T00:00:00+00:00".to_owned())
        );
        assert!(parse_js_date("2026-01-01T10:00:00Z").is_some());
        assert_eq!(parse_js_date("yesterday"), None);
    }
}
