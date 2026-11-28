//! Shared helpers of the admin commerce read routes.
//!
//! Everything here is presentation glue: query parsing, staff visibility flags, row decoding,
//! money/date formatting and the SQL-condition mutators that append the filters `buildListQuery`
//! cannot express (relation `some`, computed access-token status, open-case scopes).
//!
//! SQL stays in the resource modules so a reviewer can compare it with the TS handler.

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDate, NaiveDateTime, Timelike, Utc};
use ntex::web::HttpRequest;
use pg_db::{BuiltListQuery, CursorValue, DbError, KeysetPlan, SqlBind};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

/// The shared SQL failure envelope (`routes::common::database_error`).
pub use crate::routes::common::database_error;

/// Staff visibility flags, the port of `flagsOf` (`adminCommerce.ts:68`) and
/// `merchantOperationalFlags` (`admin.ts:4741`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Flags {
    pub support: bool,
    pub can_financial: bool,
    pub can_sensitive: bool,
    pub can_aml: bool,
}

fn holds(authorities: &[String], allowed: &[&str]) -> bool {
    allowed
        .iter()
        .any(|authority| authorities.iter().any(|held| held == authority))
}

/// `hasMerchantFinancialAccess` / `hasSensitiveMerchantAccess` / `hasMerchantAmlAccess`.
#[must_use]
pub fn flags(principal: Option<&Principal>) -> Flags {
    let Some(principal) = principal else {
        return Flags::default();
    };
    let support = principal.role.as_deref() == Some("SUPPORT");
    Flags {
        support,
        can_financial: !support
            && holds(
                &principal.authorities,
                &["*", "merchant:write", "finance:read", "finance:write"],
            ),
        can_sensitive: !support
            && holds(
                &principal.authorities,
                &["*", "merchant:write", "compliance:read", "compliance:write"],
            ),
        can_aml: !support
            && holds(
                &principal.authorities,
                &[
                    "*",
                    "aml:read",
                    "aml:write",
                    "compliance:read",
                    "compliance:write",
                ],
            ),
    }
}

/// A mounted session route always has a principal; the guard keeps the fallback explicit.
pub fn require_principal(principal: Option<&Principal>) -> Result<&Principal, ApiError> {
    principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })
}

/// The query string as Express `req.query` sees it: first value wins (`asString`).
#[must_use]
pub fn parse_query(raw: &str) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        map.entry(key.into_owned())
            .or_insert_with(|| Value::String(value.into_owned()));
    }
    map
}

#[must_use]
pub fn query_map(request: &HttpRequest) -> Map<String, Value> {
    parse_query(request.query_string())
}

/// `queryString` / `typeof query.x === "string"` with trimming, empty values dropped.
#[must_use]
pub fn query_text(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// The raw string of a query key, without trimming (the access-token boolean rule).
#[must_use]
pub fn query_raw<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// `assertEnumFilter`: a comma-separated enum list, unknown members are a 400.
pub fn assert_enum_filter(
    map: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<(), ApiError> {
    let Some(raw) = query_raw(map, key) else {
        return Ok(());
    };
    if raw.is_empty() {
        return Ok(());
    }
    let values: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    let invalid: Vec<&str> = values
        .iter()
        .copied()
        .filter(|entry| !allowed.contains(entry))
        .collect();
    if invalid.is_empty() && !values.is_empty() {
        return Ok(());
    }
    Err(
        ApiError::new(400, "INVALID_FILTER", format!("Unknown {key} filter value"))
            .with_details(json!({ "invalid": invalid, "allowed": allowed })),
    )
}

/// `assertUuidFilter`: a scalar UUID filter must parse when present.
pub fn assert_uuid_filter(map: &Map<String, Value>, key: &str) -> Result<(), ApiError> {
    if let Some(raw) = query_raw(map, key) {
        if !raw.is_empty() && Uuid::parse_str(raw).is_err() {
            return Err(ApiError::new(
                400,
                "INVALID_FILTER",
                format!("{key} must be a UUID"),
            ));
        }
    }
    Ok(())
}

/// A list-query build failure: an unmapped/invalid filter is a 400, never a 500.
#[must_use]
pub fn list_error(error: DbError) -> ApiError {
    match error {
        DbError::InvalidFilter { field } => ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{field}' filter is invalid"),
        ),
        other => {
            tracing::error!(error = %other, "admin commerce list query failed");
            ApiError::server_error()
        }
    }
}

fn push_where(built: &mut BuiltListQuery, clause: &str) {
    if built.where_sql.is_empty() {
        built.where_sql = format!("WHERE {clause}");
    } else {
        built.where_sql.push_str(" AND ");
        built.where_sql.push_str(clause);
    }
}

/// `column = $n::cast` appended to an already-built list query.
pub fn add_equals(built: &mut BuiltListQuery, column: &str, cast: &str, value: &str) {
    built.binds.push(SqlBind::Text(value.to_owned()));
    let placeholder = built.binds.len();
    push_where(built, &format!("{column} = ${placeholder}::{cast}"));
}

/// `column IN ($n, …)` appended to an already-built list query.
pub fn add_in(built: &mut BuiltListQuery, column: &str, cast: &str, values: &[String]) {
    if values.is_empty() {
        push_where(built, "FALSE");
        return;
    }
    let mut placeholders = Vec::with_capacity(values.len());
    for value in values {
        built.binds.push(SqlBind::Text(value.clone()));
        placeholders.push(format!("${}::{}", built.binds.len(), cast));
    }
    push_where(built, &format!("{column} IN ({})", placeholders.join(", ")));
}

/// `(a ILIKE $n OR b ILIKE $n …)` appended to an already-built list query.
pub fn add_contains_any(built: &mut BuiltListQuery, columns: &[&str], value: &str) {
    if columns.is_empty() {
        push_where(built, "FALSE");
        return;
    }
    built.binds.push(SqlBind::Text(format!("%{value}%")));
    let placeholder = built.binds.len();
    let clauses: Vec<String> = columns
        .iter()
        .map(|column| format!("{column} ILIKE ${placeholder}::text"))
        .collect();
    push_where(built, &format!("({})", clauses.join(" OR ")));
}

/// A literal SQL condition (no binds) appended to an already-built list query.
pub fn add_condition(built: &mut BuiltListQuery, clause: &str) {
    push_where(built, clause);
}

/// `nextCursor` source values for the common `createdAt`/`updatedAt`/`id` keyset plan.
#[must_use]
pub fn cursor_values(
    plan: &KeysetPlan,
    created_at: NaiveDateTime,
    updated_at: Option<NaiveDateTime>,
    id: &str,
) -> Vec<CursorValue> {
    plan.fields
        .iter()
        .filter_map(|field| match field.path.as_str() {
            "createdAt" => Some(CursorValue::Date(iso_naive(created_at))),
            "updatedAt" => updated_at.map(|value| CursorValue::Date(iso_naive(value))),
            "id" => Some(CursorValue::Text(id.to_owned())),
            _ => None,
        })
        .collect()
}

/// A JS `Date` rendered the way `JSON.stringify` does: always three fraction digits and `Z`.
#[must_use]
pub fn iso_naive(value: NaiveDateTime) -> String {
    // Columns are `timestamp(3) without time zone` holding UTC.
    let millis = (value.nanosecond() / 1_000_000) * 1_000_000;
    let truncated = value.with_nanosecond(millis).unwrap_or(value);
    pg_types::JsDate(DateTime::<Utc>::from_naive_utc_and_offset(truncated, Utc)).to_iso_string()
}

#[must_use]
pub fn iso_utc(value: DateTime<Utc>) -> String {
    pg_types::JsDate(value).to_iso_string()
}

#[must_use]
pub fn iso_value(value: Option<NaiveDateTime>) -> Value {
    value.map_or(Value::Null, |value| Value::String(iso_naive(value)))
}

#[must_use]
pub fn iso_utc_value(value: Option<DateTime<Utc>>) -> Value {
    value.map_or(Value::Null, |value| Value::String(iso_utc(value)))
}

/// A `@db.Date` column at UTC midnight, like `new Date("1960-01-01").toISOString()`.
#[must_use]
pub fn iso_date_value(value: Option<NaiveDate>) -> Value {
    value.map_or(Value::Null, |date| {
        Value::String(iso_naive(date.and_hms_opt(0, 0, 0).unwrap_or_default()))
    })
}

/// `Money4` as a JSON string (`toFixed(4)`), null stays null.
#[must_use]
pub fn money4_opt(value: Option<Decimal>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(pg_types::Money4(value).to_string())
    })
}

/// `Money4` with the handler's `null → "0.0000"` rule.
#[must_use]
pub fn money4_zero(value: Option<Decimal>) -> Value {
    Value::String(pg_types::Money4(value.unwrap_or_default()).to_string())
}

/// A Prisma `Decimal` returned directly: JSON `Decimal.toString()` (no trailing zeros).
#[must_use]
pub fn decimal_js(value: Decimal) -> Value {
    Value::String(pg_types::DecimalJs(value).to_decimal_js_string())
}

/// `stringList`: a JSON array mapped through `String()`, otherwise `null`.
#[must_use]
pub fn string_list(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::Array(entries) => Some(entries.iter().map(string_of).collect()),
        _ => None,
    }
}

fn string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// The subject-type spellings `approvalSubjectTypeVariants` accepts
/// (`lib/approvalQueue.ts:49`): exact, PascalCase and lowercase.
#[must_use]
pub fn subject_variants(value: &str) -> Vec<String> {
    let upper = value.to_ascii_uppercase();
    let mut pascal = String::new();
    for part in upper.split('_') {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            pascal.push(first);
            pascal.push_str(&chars.as_str().to_ascii_lowercase());
        }
    }
    vec![upper, pascal, value.to_ascii_lowercase()]
}

// ---------------------------------------------------------------- row decoding

fn decode_error(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %pg_db::error_detail(&error), "admin commerce row decode failed");
    ApiError::server_error()
}

pub fn text(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_text(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn uuid_text(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<Uuid, _>(column)
        .map(|value| value.to_string())
        .map_err(decode_error)
}

pub fn opt_uuid_text(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<Uuid>, _>(column)
        .map(|value| value.map(|value| value.to_string()))
        .map_err(decode_error)
}

pub fn decimal(row: &PgRow, column: &str) -> Result<Decimal, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_decimal(row: &PgRow, column: &str) -> Result<Option<Decimal>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn i32_of(row: &PgRow, column: &str) -> Result<i32, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_i32(row: &PgRow, column: &str) -> Result<Option<i32>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn i64_of(row: &PgRow, column: &str) -> Result<i64, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn bool_of(row: &PgRow, column: &str) -> Result<bool, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_bool(row: &PgRow, column: &str) -> Result<Option<bool>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

/// UUID-array bind values for the internal `ANY($n::uuid[])` lookups (ids already validated).
#[must_use]
pub fn uuid_values(values: &[String]) -> Vec<Uuid> {
    values
        .iter()
        .filter_map(|value| Uuid::parse_str(value).ok())
        .collect()
}

pub fn naive(row: &PgRow, column: &str) -> Result<NaiveDateTime, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_naive(row: &PgRow, column: &str) -> Result<Option<NaiveDateTime>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn timestamptz(row: &PgRow, column: &str) -> Result<DateTime<Utc>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_timestamptz(row: &PgRow, column: &str) -> Result<Option<DateTime<Utc>>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_date(row: &PgRow, column: &str) -> Result<Option<NaiveDate>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn json_value(row: &PgRow, column: &str) -> Result<Value, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn opt_json(row: &PgRow, column: &str) -> Result<Option<Value>, ApiError> {
    row.try_get(column).map_err(decode_error)
}

pub fn bigint_text(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<i64, _>(column)
        .map(|value| value.to_string())
        .map_err(decode_error)
}

/// A merchant reference object (`{id, legalName, tradeName}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MerchantRef {
    pub id: String,
    pub legal_name: String,
    pub trade_name: String,
}

impl MerchantRef {
    pub fn from_row(
        row: &PgRow,
        id_column: &str,
        legal_column: &str,
        trade_column: &str,
    ) -> Result<Self, ApiError> {
        Ok(Self {
            id: uuid_text(row, id_column)?,
            legal_name: text(row, legal_column)?,
            trade_name: text(row, trade_column)?,
        })
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "legalName": self.legal_name,
            "tradeName": self.trade_name,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_db::{ColumnKind, ColumnMap, ListSpec, SortDirection};
    use pg_domain_auth::PrincipalKind;
    use serde_json::json;

    fn principal(role: &str, authorities: &[&str]) -> Principal {
        Principal {
            kind: PrincipalKind::Session,
            user_id: Some("0190f5c0-0000-7000-8000-000000000001".to_owned()),
            role: Some(role.to_owned()),
            merchant_id: None,
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

    #[test]
    fn staff_flags_follow_the_ts_authority_sets() {
        let support = principal("SUPPORT", &["*", "finance:read"]);
        let flags_value = flags(Some(&support));
        assert!(flags_value.support);
        assert!(!flags_value.can_financial, "support never sees balances");
        assert!(!flags_value.can_sensitive);

        let reader = principal("OPERATOR", &["merchant:read"]);
        let flags_value = flags(Some(&reader));
        assert!(!flags_value.can_financial);
        assert!(!flags_value.can_sensitive);

        let finance = principal("FINANCE", &["finance:read"]);
        let flags_value = flags(Some(&finance));
        assert!(flags_value.can_financial);
        assert!(!flags_value.can_sensitive);

        let compliance = principal("COMPLIANCE", &["compliance:read"]);
        let flags_value = flags(Some(&compliance));
        assert!(flags_value.can_sensitive);
        assert!(flags_value.can_aml);
        assert!(!flags_value.can_financial);

        let wildcard = principal("GATEWAY_ADMIN", &["*"]);
        let flags_value = flags(Some(&wildcard));
        assert!(flags_value.can_financial && flags_value.can_sensitive && flags_value.can_aml);
        assert_eq!(flags(None), Flags::default());
    }

    #[test]
    fn enum_and_uuid_filters_reject_unknown_values() {
        let map: Map<String, Value> = serde_json::from_value(json!({
            "status": "ACTIVE,BOGUS",
            "merchantId": "not-a-uuid",
        }))
        .expect("map");
        let error = assert_enum_filter(&map, "status", &["ACTIVE", "FROZEN"]).expect_err("invalid");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "INVALID_FILTER");
        assert!(assert_uuid_filter(&map, "merchantId").is_err());
        assert!(assert_enum_filter(&map, "missing", &["ACTIVE"]).is_ok());
        assert!(assert_uuid_filter(&map, "missing").is_ok());
    }

    #[test]
    fn string_lists_match_js_stringification() {
        assert_eq!(
            string_list(&json!(["a", "b"])),
            Some(vec!["a".to_owned(), "b".to_owned()])
        );
        assert_eq!(string_list(&json!(null)), None);
        assert_eq!(string_list(&json!("a")), None);
        assert_eq!(
            string_list(&json!([1, true, null])),
            Some(vec!["1".to_owned(), "true".to_owned(), "null".to_owned()])
        );
    }

    #[test]
    fn money_and_dates_use_the_handler_formats() {
        assert_eq!(money4_opt(None), Value::Null);
        assert_eq!(
            money4_opt(Some(Decimal::new(5, 0))),
            Value::String("5.0000".to_owned())
        );
        assert_eq!(money4_zero(None), Value::String("0.0000".to_owned()));
        assert_eq!(
            decimal_js(Decimal::new(100000, 2)),
            Value::String("1000".to_owned())
        );
        let value = chrono::NaiveDate::from_ymd_opt(2026, 1, 2)
            .and_then(|date| date.and_hms_milli_opt(3, 4, 5, 6))
            .expect("date");
        assert_eq!(iso_naive(value), "2026-01-02T03:04:05.006Z");
    }

    #[test]
    fn appended_conditions_keep_placeholder_order() {
        let spec = ListSpec::default()
            .with_search(&["name"])
            .with_default_sort("createdAt", SortDirection::Desc);
        let columns = ColumnMap::new()
            .with("name", "t.name", ColumnKind::Text)
            .with("createdAt", "t.created_at", ColumnKind::Timestamp)
            .with("id", "t.id", ColumnKind::Uuid);
        let mut built = pg_db::build_list_query(&Map::new(), &spec, &columns).expect("build");
        add_contains_any(&mut built, &["t.name", "t.id::text"], "acme");
        add_equals(
            &mut built,
            "t.application_id",
            "uuid",
            "0190f5c0-0000-7000-8000-000000000002",
        );
        add_in(
            &mut built,
            "t.status::text",
            "text",
            &["ACTIVE".to_owned(), "FROZEN".to_owned()],
        );
        let sql = built.select_sql("things t", &["t.id"]);
        assert!(sql.contains("ORDER BY t.created_at DESC, t.id DESC LIMIT $5 OFFSET $6"));
        assert_eq!(built.binds.len(), 4);
    }

    #[test]
    fn cursor_values_follow_the_keyset_plan() {
        let plan = pg_db::KeysetPlan {
            fields: vec![
                pg_db::KeysetField {
                    path: "createdAt".to_owned(),
                    direction: SortDirection::Desc,
                },
                pg_db::KeysetField {
                    path: "id".to_owned(),
                    direction: SortDirection::Desc,
                },
            ],
        };
        let created = chrono::NaiveDate::from_ymd_opt(2026, 2, 3)
            .and_then(|date| date.and_hms_milli_opt(4, 5, 6, 700))
            .expect("date");
        let values = cursor_values(&plan, created, None, "abc");
        assert_eq!(values.len(), 2);
        assert_eq!(
            values[0],
            CursorValue::Date("2026-02-03T04:05:06.700Z".to_owned())
        );
        assert_eq!(values[1], CursorValue::Text("abc".to_owned()));
    }
}
