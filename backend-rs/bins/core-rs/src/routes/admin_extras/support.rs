//! Shared helpers for the admin "extras" read routes (file bytes, inbound events, backups and the
//! collection exports that no family module owns).
//!
//! The helpers are deliberately local copies of the patterns the family modules use
//! (`admin_gateways`, `admin_operations`, `admin_ledger`) because their helpers are `pub(super)`
//! to their own module. Keeping the copies here makes the TS comparison for this module explicit.

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{BuiltListQuery, ColumnMap, CursorValue, ListSpec, SqlBind};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

use pg_http::ApiError;

pub(crate) use super::super::common::database_error;

/// `req.query`: first occurrence wins, blank strings are dropped (`queryString`).
#[must_use]
pub(crate) fn query_map(request: &HttpRequest) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in url::form_urlencoded::parse(request.query_string().as_bytes()) {
        map.entry(key.into_owned())
            .or_insert_with(|| Value::String(value.into_owned()));
    }
    map
}

/// The same map without the keys a handler consumes itself (`queryWithout`).
#[must_use]
pub(crate) fn query_without(request: &HttpRequest, keys: &[&str]) -> Map<String, Value> {
    let mut map = query_map(request);
    for key in keys {
        map.remove(*key);
    }
    map
}

/// `queryString`: trimmed, non-empty scalar.
#[must_use]
pub(crate) fn query_string(request: &HttpRequest, key: &str) -> Option<String> {
    url::form_urlencoded::parse(request.query_string().as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Parse a UUID path parameter. `code`/`message` are the resource's 404 for a malformed segment
/// (`requireUuidParam`).
pub(crate) fn uuid_path_param(
    request: &HttpRequest,
    from_end: usize,
    code: &str,
    message: &str,
) -> Result<String, ApiError> {
    let raw = path_segment(request, from_end)
        .ok_or_else(|| ApiError::new(400, "INVALID_BODY", "The path parameter is required"))?;
    Uuid::parse_str(&raw)
        .map(|value| value.to_string())
        .map_err(|_| ApiError::new(404, code, message))
}

/// Parse a UUID path parameter, refusing a malformed value with `400 INVALID_BODY` (the zod
/// `idSchema` + Prisma convention of the content routes).
pub(crate) fn uuid_param_400(request: &HttpRequest, from_end: usize) -> Result<String, ApiError> {
    let raw = path_segment(request, from_end)
        .ok_or_else(|| ApiError::new(400, "INVALID_BODY", "The path parameter is required"))?;
    Uuid::parse_str(&raw)
        .map(|value| value.to_string())
        .map_err(|_| ApiError::new(400, "INVALID_BODY", "The path parameter must be a UUID"))
}

/// A path segment counted from the end (1 = last).
#[must_use]
pub(crate) fn path_segment(request: &HttpRequest, from_end: usize) -> Option<String> {
    if from_end == 0 {
        return None;
    }
    let segments: Vec<&str> = request
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    segments
        .get(segments.len().checked_sub(from_end)?)
        .map(|value| (*value).to_owned())
}

/// `buildListQuery` with its internal failures mapped like the gateway module (a bad cursor is
/// ignored by TS, so it never becomes a 400).
pub(crate) fn build_page(
    request: &HttpRequest,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, ApiError> {
    pg_db::build_list_query(&query_map(request), spec, columns).map_err(|error| {
        tracing::error!(error = %error, "admin extras list query could not be built");
        ApiError::server_error()
    })
}

/// The same, over an explicit query map (handlers that strip their own filters first).
pub(crate) fn build_page_from(
    map: &Map<String, Value>,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, ApiError> {
    pg_db::build_list_query(map, spec, columns).map_err(|error| {
        tracing::error!(error = %error, "admin extras list query could not be built");
        ApiError::server_error()
    })
}

/// `listResponse` with `nextCursor` support; `None` total is omitted like `countUnlessSkipped`.
#[must_use]
pub(crate) fn list_body(
    key: &str,
    rows: Vec<Value>,
    total: Option<i64>,
    built: &BuiltListQuery,
) -> Value {
    let sources = cursor_sources(built, &rows);
    pg_db::list_response(key, Value::Array(rows), total, built, &sources)
}

fn cursor_sources(built: &BuiltListQuery, rows: &[Value]) -> Vec<Vec<CursorValue>> {
    let Some(plan) = &built.keyset else {
        return Vec::new();
    };
    let mut sources = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = Vec::with_capacity(plan.fields.len());
        for field in &plan.fields {
            let Some(value) = row.get(&field.path) else {
                return Vec::new();
            };
            let Some(text) = value.as_str() else {
                return Vec::new();
            };
            if field.path == "createdAt" || field.path == "updatedAt" {
                values.push(CursorValue::Date(text.to_owned()));
            } else {
                values.push(CursorValue::Text(text.to_owned()));
            }
        }
        sources.push(values);
    }
    sources
}

/// Bind the WHERE values of a list query into an already-built statement (no `LIMIT`/`OFFSET`).
pub(crate) fn bind_where<'q>(
    sql: &'q str,
    built: &'q BuiltListQuery,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in &built.binds {
        query = match bind {
            SqlBind::Text(value) => query.bind(value.as_str()),
            SqlBind::Bool(value) => query.bind(*value),
        };
    }
    query
}

/// `count()` regardless of `includeTotal` (the TS exports call `.count()` unconditionally).
pub(crate) async fn count_always(
    pool: &sqlx::PgPool,
    built: &BuiltListQuery,
    table: &str,
) -> Result<i64, ApiError> {
    let sql = built.count_sql(table);
    let row = bind_where(&sql, built)
        .fetch_one(pool)
        .await
        .map_err(database_error)?;
    Ok(row.get::<i64, _>(0))
}

/// `checklist` query value, trimmed and filtered against the route's allow-list.
#[must_use]
pub(crate) fn checklist(request: &HttpRequest, allowed: &[&str]) -> Vec<String> {
    query_string(request, "checklist")
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|entry| allowed.contains(entry))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Insert the audit row the TS export handlers write (`writeAudit`).
pub(crate) async fn write_audit(
    state: &crate::state::AppState,
    principal: Option<&Principal>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    after_json: Value,
) -> Result<(), ApiError> {
    let actor_id = principal
        .and_then(|principal| principal.user_id.as_deref())
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(ApiError::server_error)?;
    let role = principal
        .and_then(|principal| principal.role.clone())
        .unwrap_or_else(|| "UNKNOWN".to_owned());
    let id = pg_types::new_v7();
    let now = Utc::now().naive_utc();
    let mut tx = state.pools.main.begin().await.map_err(database_error)?;
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
    .bind(serde_json::json!({}))
    .bind(after_json.clone())
    .execute(&mut *tx)
    .await
    .map_err(database_error)?;
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
        .bind(serde_json::json!({}))
        .bind(after_json)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await
        .map_err(database_error)?;
    }
    tx.commit().await.map_err(database_error)?;
    Ok(())
}

/// `Date#toISOString()`.
#[must_use]
pub(crate) fn date_iso(value: DateTime<Utc>) -> String {
    pg_types::JsDate(value).to_iso_string()
}

fn decode_error(column: &str) -> ApiError {
    tracing::error!(column, "admin extras row could not be decoded");
    ApiError::server_error()
}

pub(crate) fn col_text(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<String, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_char(row: &PgRow, column: &str) -> Result<String, ApiError> {
    col_text(row, column).map(|value| value.trim_end().to_owned())
}

pub(crate) fn col_opt_text(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_uuid(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<Uuid, _>(column)
        .map(|value| value.to_string())
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_uuid(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<Uuid>, _>(column)
        .map(|value| value.map(|id| id.to_string()))
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_bool(row: &PgRow, column: &str) -> Result<bool, ApiError> {
    row.try_get::<bool, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_i32(row: &PgRow, column: &str) -> Result<i32, ApiError> {
    row.try_get::<i32, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_i32(row: &PgRow, column: &str) -> Result<Option<i32>, ApiError> {
    row.try_get::<Option<i32>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_i64(row: &PgRow, column: &str) -> Result<i64, ApiError> {
    row.try_get::<i64, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_i64(row: &PgRow, column: &str) -> Result<Option<i64>, ApiError> {
    row.try_get::<Option<i64>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_decimal(row: &PgRow, column: &str) -> Result<Decimal, ApiError> {
    row.try_get::<Decimal, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_decimal(row: &PgRow, column: &str) -> Result<Option<Decimal>, ApiError> {
    row.try_get::<Option<Decimal>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_date(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<NaiveDateTime, _>(column)
        .map(|value| date_iso(value.and_utc()))
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_timestamptz(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<DateTime<Utc>, _>(column)
        .map(date_iso)
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_date(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<NaiveDateTime>, _>(column)
        .map(|value| value.map(|date| date_iso(date.and_utc())))
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_timestamptz(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<DateTime<Utc>>, _>(column)
        .map(|value| value.map(date_iso))
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_json(row: &PgRow, column: &str) -> Result<Value, ApiError> {
    row.try_get::<Value, _>(column)
        .map(|value| pg_types::js_object_order(&value))
        .map_err(|_| decode_error(column))
}

pub(crate) fn col_opt_json(row: &PgRow, column: &str) -> Result<Option<Value>, ApiError> {
    row.try_get::<Option<Value>, _>(column)
        .map(|value| value.map(|value| pg_types::js_object_order(&value)))
        .map_err(|_| decode_error(column))
}

/// `toFixed(4)`, null/undefined → `"0.0000"` (`money4`).
#[must_use]
pub(crate) fn money4(value: Option<Decimal>) -> String {
    pg_types::Money4(value.unwrap_or_default()).to_string()
}

/// Build an insertion-ordered JSON object.
#[must_use]
pub(crate) fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::with_capacity(entries.len());
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

/// Prisma `Decimal` in JSON: decimal.js text.
#[must_use]
pub(crate) fn decimal_json(value: Option<Decimal>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(pg_types::DecimalJs(value).to_string())
    })
}

/// The query as Express would pass it to `JSON.stringify` for the export audit `filters` field.
#[must_use]
pub(crate) fn filters_json(request: &HttpRequest) -> String {
    Value::Object(query_map(request)).to_string()
}
