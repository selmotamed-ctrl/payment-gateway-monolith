//! Shared helpers for the P4 admin operations route modules.
//!
//! The TypeScript routes build a Prisma `where`/`orderBy` through `lib/listQuery.ts` and then
//! serialise a hand-shaped object. Rust builds the same SQL through
//! [`pg_db::build_list_query`] and shapes the JSON with the helpers here:
//!
//! - query parsing keeps Express semantics (first value wins, blank values dropped);
//! - enum/uuid/boolean filters refuse an invalid member with `400 INVALID_FILTER`, never a
//!   database error;
//! - timestamps are formatted like `Date.prototype.toISOString()` (three fraction digits, `Z`);
//! - money is `Money4` (`toFixed(4)`, null → `"0.0000"`), never a float;
//! - `jsonb` values keep their parsed shape and are re-ordered with
//!   [`pg_types::js_object_order`] before they leave the API;
//! - list envelopes are `{key, total, page, pageSize, nextCursor?}` and exports are
//!   `{key, total, exported, truncated}`.
//!
//! List SQL never interpolates a client value: every value goes through a `sqlx` bind. Literal
//! fragments are only used for fixed predicates (an AML visibility clause, `ingested_at IS NULL`,
//! and similar).

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{BuiltListQuery, ColumnMap, CursorValue, ListSpec, SqlBind};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, Row};
use uuid::Uuid;

use pg_http::ApiError;

pub(crate) use super::super::common::database_error;

/// Express `req.query`: the first occurrence of a repeated key wins, blank strings are dropped.
#[must_use]
pub fn query_map(request: &HttpRequest) -> Map<String, Value> {
    let mut map = Map::new();
    let raw = request.uri().query().map(|q| q.as_str()).unwrap_or("");
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        map.entry(key.into_owned())
            .or_insert_with(|| Value::String(value.into_owned()));
    }
    map
}

/// `queryString` from `adminSliceHelpers.ts`: first scalar, trimmed, non-empty.
#[must_use]
pub fn query_string(request: &HttpRequest, key: &str) -> Option<String> {
    let raw = request.uri().query().map(|q| q.as_str()).unwrap_or("");
    url::form_urlencoded::parse(raw.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// The last path segment (`/operator-cases/<id>`).
#[must_use]
pub fn last_path_segment(request: &HttpRequest) -> Option<String> {
    request
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
}

/// A path segment counted from the end (1 = last).
#[must_use]
pub fn path_segment(request: &HttpRequest, from_end: usize) -> Option<String> {
    let segments: Vec<&str> = request
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() < from_end || from_end == 0 {
        return None;
    }
    segments
        .get(segments.len() - from_end)
        .map(|value| (*value).to_owned())
}

/// `requireUuidParam`: an invalid or unknown id is the resource's 404, not a 400.
pub fn require_uuid_param(
    value: Option<&str>,
    code: &str,
    message: &str,
) -> Result<String, ApiError> {
    let value = value.unwrap_or_default();
    Uuid::parse_str(value)
        .map(|parsed| parsed.to_string())
        .map_err(|_| ApiError::new(404, code, message))
}

/// Bind a validated UUID path parameter as `uuid` instead of `text`.
///
/// `require_uuid_param` returns the canonical string for formatting and audit calls; PostgreSQL
/// uuid columns do not accept a text bind, so SQL binds use this helper.
#[must_use]
pub fn uuid_bind(value: &str) -> uuid::Uuid {
    uuid::Uuid::parse_str(value).unwrap_or_default()
}

/// `enumListFilter`: comma separated, every member must be in `allowed`.
pub fn enum_list_filter(
    request: &HttpRequest,
    key: &str,
    allowed: &[&str],
) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = query_string(request, key) else {
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
        Ok(Some(values))
    } else {
        Err(ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{key}' filter is invalid"),
        )
        .with_details(json!({ "allowed": allowed, "unknown": unknown })))
    }
}

/// `uuidListFilter`: comma separated UUIDs.
pub fn uuid_list_filter(request: &HttpRequest, key: &str) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = query_string(request, key) else {
        return Ok(None);
    };
    let values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    if values.is_empty() || values.iter().any(|entry| Uuid::parse_str(entry).is_err()) {
        return Err(ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{key}' filter is invalid"),
        ));
    }
    Ok(Some(values))
}

/// `assertDecimalQuery`: `^-?\d{1,18}(\.\d{1,8})?$`.
pub fn assert_decimal_query(request: &HttpRequest, keys: &[&str]) -> Result<(), ApiError> {
    for key in keys {
        if let Some(raw) = query_string(request, key) {
            if !decimal_query_text(&raw) {
                return Err(ApiError::new(
                    400,
                    "INVALID_FILTER",
                    format!("The '{key}' filter is invalid"),
                ));
            }
        }
    }
    Ok(())
}

fn decimal_query_text(value: &str) -> bool {
    let body = value.strip_prefix('-').unwrap_or(value);
    let mut parts = body.split('.');
    let integer = parts.next().unwrap_or_default();
    if integer.is_empty() || integer.len() > 18 || !integer.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(fraction) => {
            parts.next().is_none()
                && !fraction.is_empty()
                && fraction.len() <= 8
                && fraction.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

/// `resolveReportingCurrency`: a valid requested code, else `BASE_CURRENCY` (`LYD`).
#[must_use]
pub fn reporting_currency(request: &HttpRequest) -> String {
    if let Some(value) = query_string(request, "currency") {
        let upper = value.to_ascii_uppercase();
        if upper.len() == 3 && upper.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            return upper;
        }
    }
    std::env::var("BASE_CURRENCY")
        .ok()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
        .unwrap_or_else(|| "LYD".to_owned())
}

/// Staff confidentiality gate (`assertConfidential`): COMPLIANCE/MLRO, `aml:read`, `aml:write` or
/// the `*` wildcard.
#[must_use]
pub fn has_confidential_aml_access(principal: Option<&Principal>) -> bool {
    let Some(principal) = principal else {
        return false;
    };
    if matches!(principal.role.as_deref(), Some("COMPLIANCE" | "MLRO")) {
        return true;
    }
    principal
        .authorities
        .iter()
        .any(|authority| authority == "*" || authority == "aml:read" || authority == "aml:write")
}

/// `assertConfidential` (`403 AML_CONFIDENTIAL_ROLE_REQUIRED`).
pub fn require_confidential_aml(principal: Option<&Principal>) -> Result<(), ApiError> {
    if has_confidential_aml_access(principal) {
        Ok(())
    } else {
        Err(ApiError::new(
            403,
            "AML_CONFIDENTIAL_ROLE_REQUIRED",
            "This resource is restricted to compliance roles",
        ))
    }
}

/// The TS `SUPPORT` role redaction used by the transaction/attempt views.
#[must_use]
pub fn is_support(principal: Option<&Principal>) -> bool {
    principal.and_then(|principal| principal.role.as_deref()) == Some("SUPPORT")
}

/// `page`/`pageSize` with the list contract caps (used only by the TS routes that validate the
/// query with zod instead of `buildListQuery`).
pub fn page_params(request: &HttpRequest, default_size: i64) -> (i64, i64) {
    let page = query_string(request, "page")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(1);
    let size = query_string(request, "pageSize")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| (1..=200).contains(value))
        .unwrap_or(default_size);
    (page, size)
}

/// Build a list query and translate the SQL mapping error into the route's 400.
pub fn build_list(
    request: &HttpRequest,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, ApiError> {
    pg_db::build_list_query(&query_map(request), spec, columns).map_err(|error| {
        let field = match error {
            pg_db::DbError::InvalidFilter { field } => field,
            other => return database_error(sqlx::Error::Protocol(other.to_string())),
        };
        ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{field}' filter is invalid"),
        )
    })
}

/// A literal-only extra predicate (`AND …`) and its values, numbered by the caller.
pub struct ExtraFilter {
    pub sql: String,
    pub binds: Vec<ExtraBind>,
}

/// A bind of an extra predicate.
pub enum ExtraBind {
    Text(String),
    Texts(Vec<String>),
}

impl ExtraBind {
    /// Number of placeholders one bind occupies (a `text[]` is one placeholder).
    #[must_use]
    pub fn slots(&self) -> usize {
        1
    }
}

/// Compose the complete SELECT for a list query. `extra.sql` must use placeholders starting at
/// `built.binds.len() + 1`.
#[must_use]
pub fn list_sql(
    built: &BuiltListQuery,
    projection: &str,
    from: &str,
    extra: Option<&ExtraFilter>,
) -> String {
    let mut where_sql = built.where_sql.clone();
    if let Some(extra) = extra {
        let extra_sql = extra.sql.trim().trim_start_matches("AND ").trim();
        if !extra_sql.is_empty() {
            if where_sql.is_empty() {
                where_sql = format!("WHERE {extra_sql}");
            } else {
                where_sql = format!("{where_sql} AND {extra_sql}");
            }
        }
    }
    let offset_index = built.binds.len() + bind_slots(extra) + 1;
    format!(
        "SELECT {projection} FROM {from} {where_sql} ORDER BY {} LIMIT ${} OFFSET ${}",
        built.order_by_sql,
        offset_index,
        offset_index + 1
    )
}

fn bind_slots(extra: Option<&ExtraFilter>) -> usize {
    extra.map_or(0, |extra| extra.binds.iter().map(ExtraBind::slots).sum())
}

fn bind_all<'q>(
    sql: &'q str,
    built: &'q BuiltListQuery,
    extra: Option<&'q ExtraFilter>,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in &built.binds {
        query = match bind {
            SqlBind::Text(value) => query.bind(value.as_str()),
            SqlBind::Bool(value) => query.bind(*value),
        };
    }
    if let Some(extra) = extra {
        for bind in &extra.binds {
            query = match bind {
                ExtraBind::Text(value) => query.bind(value.as_str()),
                ExtraBind::Texts(values) => query.bind(values.clone()),
            };
        }
    }
    query
}

/// Run the page query.
pub async fn fetch_list(
    pool: &PgPool,
    built: &BuiltListQuery,
    projection: &str,
    from: &str,
    extra: Option<&ExtraFilter>,
) -> Result<Vec<PgRow>, ApiError> {
    let sql = list_sql(built, projection, from, extra);
    let mut query = bind_all(&sql, built, extra);
    query = query.bind(built.take).bind(built.skip);
    query.fetch_all(pool).await.map_err(database_error)
}

/// Run the filtered COUNT (`includeTotal=false` skips it, like `countUnlessSkipped`).
pub async fn count_list(
    pool: &PgPool,
    built: &BuiltListQuery,
    from: &str,
    extra: Option<&ExtraFilter>,
) -> Result<Option<i64>, ApiError> {
    if !built.include_total {
        return Ok(None);
    }
    count_always(pool, built, from, extra).await.map(Some)
}

/// COUNT regardless of `includeTotal` (the TS routes that call `.count()` unconditionally).
pub async fn count_always(
    pool: &PgPool,
    built: &BuiltListQuery,
    from: &str,
    extra: Option<&ExtraFilter>,
) -> Result<i64, ApiError> {
    let mut where_sql = built.where_sql.clone();
    if let Some(extra) = extra {
        let extra_sql = extra.sql.trim().trim_start_matches("AND ").trim();
        if !extra_sql.is_empty() {
            if where_sql.is_empty() {
                where_sql = format!("WHERE {extra_sql}");
            } else {
                where_sql = format!("{where_sql} AND {extra_sql}");
            }
        }
    }
    let sql = format!("SELECT count(*) FROM {from} {where_sql}");
    let query = bind_all(&sql, built, extra);
    let row = query.fetch_one(pool).await.map_err(database_error)?;
    Ok(row.get::<i64, _>(0))
}

/// `listResponse`: the base envelope without a cursor (see [`with_cursor`]).
#[must_use]
pub fn list_envelope(key: &str, rows: Value, total: Option<i64>, built: &BuiltListQuery) -> Value {
    pg_db::list_response(key, rows, total, built, &[])
}

/// Add `nextCursor` when the active keyset plan is `createdAt`/`updatedAt` + `id` and the page is
/// full. Other keyset plans need their sort values projected; those routes return no cursor rather
/// than a wrong one.
pub fn with_cursor(
    mut response: Value,
    built: &BuiltListQuery,
    rows: &[PgRow],
    timestamp_column: &str,
) -> Value {
    let Some(plan) = &built.keyset else {
        return response;
    };
    if (rows.len() as f64) < built.page_size || plan.fields.len() != 2 {
        return response;
    }
    let first = &plan.fields[0];
    let timestamp_path = first.path.as_str();
    if !matches!(timestamp_path, "createdAt" | "updatedAt") || plan.fields[1].path != "id" {
        return response;
    }
    let Some(last) = rows.last() else {
        return response;
    };
    let Some(timestamp) = timestamp(last, timestamp_column) else {
        return response;
    };
    let Some(id) = uuid_value(last, "id") else {
        return response;
    };
    let values = vec![
        CursorValue::Date(pg_types::JsDate(timestamp.and_utc()).to_iso_string()),
        CursorValue::Text(id),
    ];
    if let Some(cursor) = pg_db::encode_cursor(plan, &values) {
        if let Some(object) = response.as_object_mut() {
            object.insert("nextCursor".to_owned(), Value::String(cursor));
        }
    }
    response
}

// ---------------------------------------------------------------- row readers

/// A required text column.
#[must_use]
pub fn text(row: &PgRow, column: &str) -> String {
    row.try_get::<Option<String>, _>(column)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// A nullable text column.
#[must_use]
pub fn opt_text(row: &PgRow, column: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(column).ok().flatten()
}

/// A nullable text column as JSON (`null` when absent).
#[must_use]
pub fn text_value(row: &PgRow, column: &str) -> Value {
    opt_text(row, column).map_or(Value::Null, Value::String)
}

/// A UUID column, projected as `uuid::Uuid`, as a JSON string.
#[must_use]
pub fn uuid_value(row: &PgRow, column: &str) -> Option<String> {
    row.try_get::<Option<Uuid>, _>(column)
        .ok()
        .flatten()
        .map(|value| value.to_string())
}

/// A UUID column as JSON.
#[must_use]
pub fn uuid_json(row: &PgRow, column: &str) -> Value {
    uuid_value(row, column).map_or(Value::Null, Value::String)
}

/// A `timestamp(3)` column.
#[must_use]
pub fn timestamp(row: &PgRow, column: &str) -> Option<NaiveDateTime> {
    row.try_get::<Option<NaiveDateTime>, _>(column)
        .ok()
        .flatten()
}

/// A `date` column (e.g. `expires_on`).
#[must_use]
pub fn date(row: &PgRow, column: &str) -> Option<chrono::NaiveDate> {
    row.try_get::<Option<chrono::NaiveDate>, _>(column)
        .ok()
        .flatten()
}

/// A timestamp as `toISOString()` or `null`.
#[must_use]
pub fn ts_json(row: &PgRow, column: &str) -> Value {
    iso(timestamp(row, column))
}

/// A date column as `YYYY-MM-DD` or `null`.
#[must_use]
pub fn date_json(row: &PgRow, column: &str) -> Value {
    date(row, column).map_or(Value::Null, |value| Value::String(value.to_string()))
}

/// `toISOString()`: three fraction digits, `Z`.
#[must_use]
pub fn iso(value: Option<NaiveDateTime>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(pg_types::JsDate(value.and_utc()).to_iso_string())
    })
}

/// `toISOString()` for a required instant.
#[must_use]
pub fn iso_required(value: DateTime<Utc>) -> Value {
    Value::String(pg_types::JsDate(value).to_iso_string())
}

/// A boolean column.
#[must_use]
pub fn bool_value(row: &PgRow, column: &str) -> bool {
    row.try_get::<Option<bool>, _>(column)
        .ok()
        .flatten()
        .unwrap_or(false)
}

/// A boolean column as JSON.
#[must_use]
pub fn bool_json(row: &PgRow, column: &str) -> Value {
    Value::Bool(bool_value(row, column))
}

/// An integer column as JSON (`i32`).
#[must_use]
pub fn int_json(row: &PgRow, column: &str) -> Value {
    row.try_get::<Option<i32>, _>(column)
        .ok()
        .flatten()
        .map_or(Value::Null, Value::from)
}

/// A decimal column (`None` when NULL).
#[must_use]
pub fn decimal(row: &PgRow, column: &str) -> Option<Decimal> {
    row.try_get::<Option<Decimal>, _>(column).ok().flatten()
}

/// `money4`: `toFixed(4)`, null → `"0.0000"`.
#[must_use]
pub fn money(row: &PgRow, column: &str) -> Value {
    Value::String(pg_types::Money4(decimal(row, column).unwrap_or_default()).to_string())
}

/// `money4OrNull`: `null` stays `null`.
#[must_use]
pub fn money_opt(row: &PgRow, column: &str) -> Value {
    decimal(row, column)
        .map(|value| Value::String(pg_types::Money4(value).to_string()))
        .unwrap_or(Value::Null)
}

/// `money4` for a raw decimal.
#[must_use]
pub fn money_value(value: Option<Decimal>) -> Value {
    Value::String(pg_types::Money4(value.unwrap_or_default()).to_string())
}

/// A jsonb column in JS key order.
#[must_use]
pub fn jsonb(row: &PgRow, column: &str) -> Value {
    let value = row
        .try_get::<Option<sqlx::types::Json<Value>>, _>(column)
        .ok()
        .flatten()
        .map(|wrapped| wrapped.0)
        .unwrap_or(Value::Null);
    pg_types::js_object_order(&value)
}

/// A jsonb column with a `{}`/`[]`/`null` default.
#[must_use]
pub fn jsonb_or_empty_object(row: &PgRow, column: &str) -> Value {
    match jsonb(row, column) {
        Value::Null => json!({}),
        other => other,
    }
}

/// Age in whole hours, floored at zero (`approvalAgeHours`).
#[must_use]
pub fn age_hours(created_at: Option<NaiveDateTime>, now: DateTime<Utc>) -> i64 {
    let Some(created_at) = created_at else {
        return 0;
    };
    (now.naive_utc() - created_at).num_hours().max(0)
}

/// `maskBankAccount`: the last four characters, else `****`.
#[must_use]
pub fn mask_bank_account(value: &Value) -> Value {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if text.len() <= 4 {
        return Value::String(if text.is_empty() {
            String::new()
        } else {
            "****".to_owned()
        });
    }
    let tail: String = text
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Value::String(format!("****{tail}"))
}

/// `merchantMaskedJson`: object keys that look financial/contact are masked, scalars kept.
#[must_use]
pub fn masked_json_object(value: &Value) -> Value {
    let Value::Object(source) = value else {
        return json!({});
    };
    let mut result = Map::new();
    for (key, entry) in source {
        let lower = key.to_ascii_lowercase();
        if ["account", "iban", "number", "phone", "email"]
            .iter()
            .any(|needle| lower.contains(needle))
        {
            result.insert(key.clone(), mask_bank_account(entry));
        } else if matches!(
            entry,
            Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
        ) {
            result.insert(key.clone(), entry.clone());
        }
    }
    Value::Object(result)
}

/// `statement source` display name (`Gateway · TYPE`).
#[must_use]
pub fn source_display_name(gateway_name: Option<&str>, source_type: &str) -> String {
    match gateway_name {
        Some(name) if !name.is_empty() => format!("{name} · {source_type}"),
        _ => source_type.to_owned(),
    }
}

/// True when the query carries a value (used by the TS `duplicateOnly`/`expiringSoon` switches).
#[must_use]
pub fn query_is_true(request: &HttpRequest, key: &str) -> bool {
    query_string(request, key).as_deref() == Some("true")
}

/// JSON body of an audit row is not exposed; keep the helper so tests can assert the shape of an
/// export without reaching into the SQL.
#[must_use]
pub fn export_envelope(key: &str, rows: Value, total: i64, exported: usize) -> Value {
    let mut map = Map::new();
    map.insert(key.to_owned(), rows);
    map.insert("total".to_owned(), Value::from(total));
    map.insert("exported".to_owned(), Value::from(exported));
    map.insert(
        "truncated".to_owned(),
        Value::Bool(total > i64::try_from(exported).unwrap_or(i64::MAX)),
    );
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_filter_matches_the_ts_regex() {
        assert!(decimal_query_text("12"));
        assert!(decimal_query_text("12.3456"));
        assert!(decimal_query_text("-0.5"));
        assert!(!decimal_query_text("1e3"));
        assert!(!decimal_query_text("12."));
        assert!(!decimal_query_text("1234567890123456789"));
    }

    #[test]
    fn masks_bank_accounts_like_the_merchant_drawer() {
        assert_eq!(
            mask_bank_account(&Value::String("LY1234567890".to_owned())),
            Value::String("****7890".to_owned())
        );
        assert_eq!(
            mask_bank_account(&Value::String("12".to_owned())),
            Value::String("****".to_owned())
        );
    }

    #[test]
    fn age_is_floored_at_zero() {
        let now = Utc::now();
        assert_eq!(age_hours(Some(now.naive_utc()), now), 0);
        assert_eq!(
            age_hours(Some((now - chrono::Duration::hours(5)).naive_utc()), now),
            5
        );
    }
}
