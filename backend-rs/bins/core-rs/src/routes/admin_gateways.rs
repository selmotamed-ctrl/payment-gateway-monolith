//! Admin gateway/rail/route configuration read routes (P4-T04 chunk).
//!
//! Ports the read half of the gateway-configuration surface of
//! `core-back/api/internal/admin.ts` plus the route-health reads:
//!
//! | Route | TypeScript |
//! | :--- | :--- |
//! | `GET /internal/admin/gateways` (+ `summary`) | `admin.ts:13006`, `:13183` |
//! | `GET /internal/admin/gateways/:id` (+ `/versions`) | `admin.ts:13221`, `:13336` |
//! | `GET /internal/admin/gateway-versions/:vid` | `admin.ts:14141` |
//! | `GET /internal/admin/gateway-inquiries` (+ `summary`, `/:id`) | `admin.ts:11868`, `:11947`, `:11979` |
//! | `GET /internal/admin/rails` (+ `summary`, `/:id`) | `admin.ts:15854`, `:16017`, `:16056` |
//! | `GET /internal/admin/routes` (+ `summary`, `/:id`, `/:id/health`) | `admin.ts:16299`, `:16427`, `:16467`, `:16584` |
//! | `GET /internal/admin/commission-profiles` (+ `summary`, `/:id/history`) | `admin.ts:18758`, `:18776`, `:18872` |
//! | `GET /internal/admin/velocity-rules` (+ `summary`, `/:id/history`) | `admin.ts:18955`, `:19043`, `:18973` |
//! | `GET /internal/admin/credential-sets` (+ `/:id`) | `admin.ts:13802`, `:13837` |
//!
//! Conventions reproduced on purpose:
//!
//! - every list uses the shared `listQuery` contract (`search`, `in`, `equals`, `booleans`,
//!   `ranges`, `dates`, `sortKey`/`sortDirection`, `page`/`pageSize`, `includeTotal`, cursor);
//! - Prisma `Decimal` reaches JSON as decimal.js text (`DecimalJs`), never a float;
//! - timestamps are `Date#toISOString()` (`JsDate`: three fraction digits, `Z`);
//! - `jsonb` passthrough is re-ordered with the JavaScript object-key rule;
//! - credential-set responses never select or emit the ciphertext columns and map entries to
//!   `[REDACTED]`/`[WRITE_ONLY]`, exactly like `credentialSetView`.
//!
//! Deliberate deviations (also listed in the module tabs of `README.md`):
//!
//! - the JSON `export` variants of these collections (`/gateways/export`, `/rails/export`,
//!   `/routes/export`, the `summary/export` routes) and `/gateways/ai-transcript` are **not**
//!   mounted here: they write audit rows or generate the AI kit and belong to the write/export
//!   chunk;
//! - `GET /internal/admin/gateways/:id/health` lives in `adminOperations.ts` and is owned by the
//!   `admin_operations` module;
//! - `/gateways/:id/versions` returns the `snapshot_ciphertext` column, as the unprojected Prisma
//!   `findMany` in TypeScript does, even though the gateway-detail projection excludes it. The
//!   version-detail document never includes it;
//! - `/routes/:id/health` selects `rail.name` in TypeScript, but the `rails` table has no `name`
//!   column (only `name_ar`/`name_en`); the Rust route emits `name_en` as `name` so the documented
//!   response shape is usable. It also projects the override actor's email into
//!   `overrideSetByName` because `users` has no `name` column;
//! - an id path segment that is not a UUID answers `400 INVALID_BODY` instead of the Prisma
//!   P2023/500 the unvalidated TS handler would produce.

#![forbid(unsafe_code)]

mod credentials;
mod gateways;
mod inquiries;
mod pricing;
mod rails;
mod route_health;
mod versions;

use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{BuiltListQuery, ColumnMap, CursorValue, ListSpec};
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy};
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

use super::common;
use super::{CustomHandler, Handler, MountedRoute, PrincipalGuard};
use crate::state::AppState;

/// Build one mounted `GET` admin route with the shared staff/session policy.
fn get(path: &str, authorities: &[&str], ts_origin: &str, handler: CustomHandler) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, ts_origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

/// Routes owned by this module.
///
/// The order follows the TypeScript registration order so literal segments (`summary`) stay before
/// a parameterised sibling (`:id`) if the dispatcher later supports templates.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        get(
            "/internal/admin/gateways",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:13006",
            gateways::list,
        ),
        get(
            "/internal/admin/gateways/summary",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:13183",
            gateways::summary,
        ),
        get(
            "/internal/admin/gateways/:id",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:13221",
            gateways::detail,
        ),
        get(
            "/internal/admin/gateways/:id/versions",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:13336",
            gateways::versions,
        ),
        get(
            "/internal/admin/gateway-versions/:vid",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:14141",
            versions::detail,
        ),
        get(
            "/internal/admin/credential-sets",
            &[
                "credential:read",
                "credential:write",
                "gateway:read",
                "gateway:write",
            ],
            "core-back/api/internal/admin.ts:13802",
            credentials::list,
        ),
        get(
            "/internal/admin/credential-sets/:id",
            &[
                "credential:read",
                "credential:write",
                "gateway:read",
                "gateway:write",
            ],
            "core-back/api/internal/admin.ts:13837",
            credentials::detail,
        ),
        get(
            "/internal/admin/gateway-inquiries",
            &["case:read", "operator:read"],
            "core-back/api/internal/admin.ts:11868",
            inquiries::list,
        ),
        get(
            "/internal/admin/gateway-inquiries/summary",
            &["case:read", "operator:read"],
            "core-back/api/internal/admin.ts:11947",
            inquiries::summary,
        ),
        get(
            "/internal/admin/gateway-inquiries/:id",
            &["case:read", "operator:read"],
            "core-back/api/internal/admin.ts:11979",
            inquiries::detail,
        ),
        get(
            "/internal/admin/rails",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:15854",
            rails::list,
        ),
        get(
            "/internal/admin/rails/summary",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16017",
            rails::summary,
        ),
        get(
            "/internal/admin/rails/:id",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16056",
            rails::detail,
        ),
        get(
            "/internal/admin/routes",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16299",
            route_health::list,
        ),
        get(
            "/internal/admin/routes/summary",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16427",
            route_health::summary,
        ),
        get(
            "/internal/admin/routes/:id",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16467",
            route_health::detail,
        ),
        get(
            "/internal/admin/routes/:id/health",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16584",
            route_health::health,
        ),
        get(
            "/internal/admin/commission-profiles",
            &["commission:read", "finance:read"],
            "core-back/api/internal/admin.ts:18758",
            pricing::commission_profiles,
        ),
        get(
            "/internal/admin/commission-profiles/summary",
            &["commission:read", "finance:read"],
            "core-back/api/internal/admin.ts:18776",
            pricing::commission_summary,
        ),
        get(
            "/internal/admin/commission-profiles/:id/history",
            &["commission:read", "finance:read"],
            "core-back/api/internal/admin.ts:18872",
            pricing::commission_history,
        ),
        get(
            "/internal/admin/velocity-rules",
            &["velocity:read", "compliance:read"],
            "core-back/api/internal/admin.ts:18955",
            pricing::velocity_rules,
        ),
        get(
            "/internal/admin/velocity-rules/summary",
            &["velocity:read", "compliance:read"],
            "core-back/api/internal/admin.ts:19043",
            pricing::velocity_summary,
        ),
        get(
            "/internal/admin/velocity-rules/:id/history",
            &["velocity:read", "compliance:read"],
            "core-back/api/internal/admin.ts:18973",
            pricing::velocity_history,
        ),
    ]
}

/// Wrap a `Result<Value, ApiError>` body as a mounted handler.
///
/// The submodules use it so every route has the same error-envelope and JSON-content-type path.
macro_rules! get_json {
    ($name:ident, $body:path) => {
        pub(super) fn $name<'a>(
            state: &'a crate::state::AppState,
            request: &'a ntex::web::HttpRequest,
            _principal: Option<&'a pg_domain_auth::Principal>,
            _payload: ntex::web::types::Payload,
        ) -> crate::routes::HandlerFuture<'a> {
            Box::pin(async move {
                match $body(state, request).await {
                    Ok(value) => crate::routes::common::json_ok(&value),
                    Err(error) => crate::http::error_response(request, error),
                }
            })
        }
    };
}
pub(crate) use get_json;

/// `req.query` as a map: first value wins for a repeated key (`asString` behaviour).
pub(super) fn query_map(request: &HttpRequest) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in url::form_urlencoded::parse(request.query_string().as_bytes()) {
        if !map.contains_key(key.as_ref()) {
            map.insert(key.into_owned(), Value::String(value.into_owned()));
        }
    }
    map
}

/// Run `buildListQuery` and map its internal failures to the generic 500 (the TS spec keys are
/// constants, so only a bad cursor reaches this path and TS silently ignores it).
pub(super) fn build_page(
    request: &HttpRequest,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, ApiError> {
    pg_db::build_list_query(&query_map(request), spec, columns).map_err(|error| {
        tracing::error!(error = %error, "admin gateway list query could not be built");
        ApiError::server_error()
    })
}

/// Standard list envelope with `nextCursor` support.
pub(super) fn list_body(key: &str, rows: Vec<Value>, total: i64, built: &BuiltListQuery) -> Value {
    let sources = cursor_sources(built, &rows);
    pg_db::list_response(key, Value::Array(rows), Some(total), built, &sources)
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

/// Read one route parameter, by router capture or by the last path segment.
pub(super) fn path_param(request: &HttpRequest, name: &str, suffix: usize) -> Option<String> {
    if let Some(value) = request.match_info().get(name) {
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    let path = request.path().trim_end_matches('/');
    let mut segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    for _ in 0..suffix {
        segments.pop();
    }
    segments.pop().map(str::to_owned)
}

/// Parse a UUID path parameter. TS validates shape only and lets Prisma fail on a non-UUID; the
/// port refuses it with the same `400 INVALID_BODY` envelope a zod issue produces.
pub(super) fn uuid_param(
    request: &HttpRequest,
    name: &str,
    suffix: usize,
) -> Result<Uuid, ApiError> {
    let raw = path_param(request, name, suffix)
        .ok_or_else(|| ApiError::new(400, "INVALID_BODY", format!("{name} is required")))?;
    Uuid::parse_str(&raw)
        .map_err(|_| ApiError::new(400, "INVALID_BODY", format!("{name} must be a UUID")))
}

/// `404 <code>`.
pub(super) fn not_found(code: &str, message: &str) -> ApiError {
    ApiError::new(404, code, message)
}

fn decode_error(column: &str) -> ApiError {
    // The column name is schema metadata, never customer data.
    tracing::error!(column, "admin gateway row could not be decoded");
    ApiError::server_error()
}

pub(super) fn col_text(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<String, _>(column)
        .map_err(|_| decode_error(column))
}

/// `CHAR(n)`/`BPCHAR` columns can arrive space padded; trim the padding Prisma hid.
pub(super) fn col_char(row: &PgRow, column: &str) -> Result<String, ApiError> {
    col_text(row, column).map(|value| value.trim_end().to_owned())
}

pub(super) fn col_opt_text(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_uuid(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<Uuid, _>(column)
        .map(|value| value.to_string())
        .map_err(|_| decode_error(column))
}

pub(super) fn col_opt_uuid(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<Uuid>, _>(column)
        .map(|value| value.map(|id| id.to_string()))
        .map_err(|_| decode_error(column))
}

pub(super) fn col_bool(row: &PgRow, column: &str) -> Result<bool, ApiError> {
    row.try_get::<bool, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_i32(row: &PgRow, column: &str) -> Result<i32, ApiError> {
    row.try_get::<i32, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_opt_i32(row: &PgRow, column: &str) -> Result<Option<i32>, ApiError> {
    row.try_get::<Option<i32>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_i64(row: &PgRow, column: &str) -> Result<i64, ApiError> {
    row.try_get::<i64, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_decimal(row: &PgRow, column: &str) -> Result<Decimal, ApiError> {
    row.try_get::<Decimal, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_opt_decimal(row: &PgRow, column: &str) -> Result<Option<Decimal>, ApiError> {
    row.try_get::<Option<Decimal>, _>(column)
        .map_err(|_| decode_error(column))
}

pub(super) fn col_date(row: &PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<NaiveDateTime, _>(column)
        .map(|value| date_iso(value.and_utc()))
        .map_err(|_| decode_error(column))
}

pub(super) fn col_opt_date(row: &PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<NaiveDateTime>, _>(column)
        .map(|value| value.map(|date| date_iso(date.and_utc())))
        .map_err(|_| decode_error(column))
}

pub(super) fn date_iso(value: DateTime<Utc>) -> String {
    pg_types::JsDate(value).to_iso_string()
}

pub(super) fn col_json(row: &PgRow, column: &str) -> Result<Value, ApiError> {
    row.try_get::<Value, _>(column)
        .map(|value| pg_types::js_object_order(&value))
        .map_err(|_| decode_error(column))
}

pub(super) fn col_opt_json(row: &PgRow, column: &str) -> Result<Option<Value>, ApiError> {
    row.try_get::<Option<Value>, _>(column)
        .map(|value| value.map(|value| pg_types::js_object_order(&value)))
        .map_err(|_| decode_error(column))
}

/// Prisma `Decimal` in JSON: decimal.js text. `None` stays JSON `null`.
pub(super) fn decimal_json(value: Option<Decimal>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(pg_types::DecimalJs(value).to_string())
    })
}

pub(super) fn decimal_text(value: Decimal) -> String {
    pg_types::DecimalJs(value).to_string()
}

/// `asStringArray`: only strings survive.
pub(super) fn as_string_array(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_string())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// `asRecordValue`: an object or `{}`.
pub(super) fn as_record(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

/// `asRecordArray`: object elements only.
pub(super) fn as_record_array(value: &Value) -> Vec<Map<String, Value>> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

/// `asNumberArray`: every element through `Number()`, non-finite dropped.
pub(super) fn as_number_array(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(number_value)
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default()
}

fn number_value(value: &Value) -> Option<Value> {
    if let Some(number) = value.as_f64() {
        return number.is_finite().then(|| pg_db::js_number_value(number));
    }
    let text = value.as_str()?;
    let number = text.trim().parse::<f64>().ok()?;
    number.is_finite().then(|| pg_db::js_number_value(number))
}

/// Build an insertion-ordered JSON object (serde_json keeps the order with `preserve_order`).
pub(super) fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::with_capacity(entries.len());
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

/// The pending-approval subject lookup used by several read models
/// (`APPROVAL_PENDING_STATES = DRAFT, PENDING_REVIEW`).
pub(super) async fn pending_approval_ids(
    state: &AppState,
    subject_type: &str,
) -> Result<BTreeMap<String, String>, ApiError> {
    let rows = sqlx::query(
        "SELECT subject_id, id
           FROM approval_requests
          WHERE subject_type = $1
            AND state IN ('DRAFT', 'PENDING_REVIEW')
          ORDER BY created_at ASC, id ASC",
    )
    .bind(subject_type)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let mut pending = BTreeMap::new();
    for row in rows {
        // `approval_requests.subject_id` is text (a UUID string for these subjects).
        let subject: String = row
            .try_get::<String, _>("subject_id")
            .map_err(|_| decode_error("subject_id"))?;
        let id = col_uuid(&row, "id")?;
        pending.insert(subject, id);
    }
    Ok(pending)
}
