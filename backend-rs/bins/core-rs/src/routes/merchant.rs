//! Merchant-channel read routes (P4-T02).
//!
//! Source of truth: `core-back/api/internal/merchant.ts` (registration order and handler bodies) and
//! `core-back/api/internal/merchantReportEngine.ts` (Studio reads). Every route below is a **GET**;
//! write routes stay 501 through the shell until P7.
//!
//! # Implemented (`GET`)
//!
//! | Path | TS origin |
//! | :--- | :--- |
//! | `/internal/merchant/auth/me` | `merchant.ts:1354` (public) |
//! | `/internal/merchant/options/:kind` | `merchant.ts:1403` |
//! | `/internal/merchant/onboarding/join-request` | `merchant.ts:1512` |
//! | `/internal/merchant/onboarding/kyb-revalidations` | `merchant.ts:1590` |
//! | `/internal/merchant/onboarding/beneficial-owners` | `merchant.ts:1855` |
//! | `/internal/merchant/wallets` | `merchant.ts:2031` |
//! | `/internal/merchant/wallets/:id` | `merchant.ts:2085` |
//! | `/internal/merchant/wallets/:id/balance` | `merchant.ts:2096` |
//! | `/internal/merchant/wallets/:id/statements` | `merchant.ts:2120` |
//! | `/internal/merchant/wallets/:id/statements/:month/export` | `merchant.ts:2148` |
//! | `/internal/merchant/applications` | `merchant.ts:2201` |
//! | `/internal/merchant/applications/:id` | `merchant.ts:2261` |
//! | `/internal/merchant/links` | `merchant.ts:2525` |
//! | `/internal/merchant/links/:id` | `merchant.ts:2579` |
//! | `/internal/merchant/links/:id/attempts` | `merchant.ts:2607` |
//! | `/internal/merchant/payments` | `merchant.ts:2627` |
//! | `/internal/merchant/disputes` | `merchant.ts:2667` |
//! | `/internal/merchant/disputes/:id` | `merchant.ts:2693` |
//! | `/internal/merchant/disputes/:id/attachments` | `merchant.ts:2771` |
//! | `/internal/merchant/disputes/:id/attachments/:attachmentId/content` | `merchant.ts:2852` |
//! | `/internal/merchant/cashouts` | `merchant.ts:2910` |
//! | `/internal/merchant/tokens` | `merchant.ts:3116` |
//! | `/internal/merchant/credential-sets` | `merchant.ts:3288` |
//! | `/internal/merchant/credential-sets/:id` | `merchant.ts:3442` |
//! | `/internal/merchant/users` | `merchant.ts:3512` |
//! | `/internal/merchant/pos/terminals` | `merchant.ts:3712` |
//! | `/internal/merchant/pos/terminals/:id` | `merchant.ts:3759` |
//! | `/internal/merchant/stats/overview` | `merchant.ts:3918` |
//! | `/internal/merchant/external/links/:key` | `merchant.ts:4124` |
//! | `/internal/merchant/external/payments/:reference` | `merchant.ts:4162` |
//! | `/internal/merchant/webhooks/event-types` | `merchant.ts:4218` |
//! | `/internal/merchant/webhooks/endpoints` | `merchant.ts:4227` |
//! | `/internal/merchant/webhooks/deliveries` | `merchant.ts:4275` |
//! | `/internal/merchant/report-engine/studio/specs` | `merchantReportEngine.ts:1405` |
//! | `/internal/merchant/report-engine/studio/specs/:id` | `merchantReportEngine.ts:1507` |
//! | `/internal/merchant/report-engine/studio/needs-migration` | `merchantReportEngine.ts:1434` |
//! | `/internal/merchant/report-engine/studio/usage` | `merchantReportEngine.ts:1680` |
//! | `/internal/merchant/report-engine/studio/chrome` | `merchantReportEngine.ts:770` |
//! | `/internal/merchant/report-engine/studio/chrome/:id` | `merchantReportEngine.ts:886` |
//! | `/internal/merchant/report-engine/studio/chrome/needs-migration` | `merchantReportEngine.ts:824` |
//! | `/internal/merchant/report-engine/catalog` | `merchantReportEngine.ts:576` |
//! | `/internal/merchant/report-engine/autocomplete/:sourceKey` | `merchantReportEngine.ts:735` |
//! | `/internal/merchant/report-engine/studio/transcript` | `merchantReportEngine.ts:1161` |
//! | `/internal/merchant/report-engine/studio/chrome/transcript` | `merchantReportEngine.ts:808` |
//! | `/internal/merchant/report-engine/studio/specs/:id/migration-prompt` | `merchantReportEngine.ts:1470` |
//! | `/internal/merchant/report-engine/studio/chrome/:id/migration-prompt` | `merchantReportEngine.ts:1120` |
//!
//! `GET /internal/merchant/health` is mounted by the P3 shell (`routes/mod.rs`).
//!
//! # Not implemented in P4-T02 (still 501) and why
//!
//! - `GET /internal/merchant/auth/google/callback` (`merchant.ts:1165`): the OAuth code exchange,
//!   ticket, cookie/session write and redirect are the P7-T02 authentication write path.
//! - `GET /internal/merchant/pos/screens/:screenCode/stream` (`merchant.ts:3826`): Server-Sent Events
//!   with realtime fan-out and a 15-minute deadline are P5-T08 (SSE), not a request/response read.
//!
//! # Deliberate P4 simplifications and known deviations
//!
//! - Reads use `state.pools.main` (the primary). Replica routing lands in P3-T02.
//! - `?merchantId=` and every other tenant id in the query are ignored: the merchant predicate is
//!   always the authenticated principal's merchant.
//! - Path ids must parse as UUIDs; a malformed id answers the route's 404 instead of the TS 500 that
//!   Prisma raises for an invalid `uuid` bind.
//! - Query scalars take the first value of a repeated key; Express turns repeats into an array and
//!   most TS handlers then treat the parameter as absent.
//! - `GET /disputes` maps the (non-existent) Prisma field `disputeRef` to `external_dispute_ref` in
//!   the search/sort; TS raises a 500 for `?search=`/`?sortKey=disputeRef`.
//! - `GET /stats/overview` counts zero pending cash-outs when the merchant has no wallet in the
//!   requested currency; TS binds the literal `"__none__"` to a `uuid` column and fails.
//! - Merchant report chrome views return `assetDataUrls: {}`: the asset bundle bytes live in the
//!   object-storage SDK, which the request state does not wire for Studio assets yet. The chrome
//!   `spec` is the stored JSON rather than the zod-parsed object, and the chrome compatibility schema
//!   check is structural (`chrome` object present) instead of the full schema.
//! - The authoring transcripts are the released SDK artefacts committed beside this module (the
//!   request timestamp is substituted); the catalog/autocomplete/migration routes use the same
//!   allow-list, tier and chrome-dependency rules as the TS host.
//! - `GET /auth/me` does not decrypt `platform_setting_secrets`, so a password/webhook secret that
//!   exists only encrypted reads as missing until the P8-T07 communication engine lands.
//! - The Studio reads implemented here are exactly those that do not execute a spec; execution,
//!   verification and preview are write/POST paths in P8.

#![forbid(unsafe_code)]

pub mod account;
pub mod commerce;
pub mod object_storage;
pub mod report_catalog;
pub mod report_engine;
pub mod wallets;

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::list_query::{CursorValue, KeysetPlan};
use pg_domain_auth::authorities::{
    has_authority, API_TOKEN_SCOPE_CATALOGUE, MERCHANT_AUTHORITY_CATALOGUE,
};
use pg_domain_auth::{MerchantPrincipal, Principal, PrincipalKind};
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row};
use uuid::Uuid;

use pg_http::ApiError;

use super::common::database_error;
use super::MountedRoute;

/// The union of every authority a merchant principal can hold (sessions and API tokens).
pub const CANDIDATE_AUTHORITIES: [&str; 17] = MERCHANT_AUTHORITY_CATALOGUE;
/// The scopes an API token may carry (`API_TOKEN_SCOPE_CATALOGUE`).
pub const CANDIDATE_TOKEN_SCOPES: [&str; 3] = API_TOKEN_SCOPE_CATALOGUE;

/// Routes owned by this module (and its submodules).
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let mut routes = Vec::new();
    routes.extend(wallets::routes());
    routes.extend(commerce::routes());
    routes.extend(account::routes());
    routes.extend(report_engine::routes());
    routes.extend(report_catalog::routes());
    routes
}

// ---------------------------------------------------------------------------------------------
// Authority and scope helpers
// ---------------------------------------------------------------------------------------------

/// The policy authority list for a TS `assertMerchantAuthority(principal, required)` call.
///
/// `Policy::authorities` matches the **raw** stored strings with OR semantics, while the TS check
/// uses `effectiveMerchantAuthorities` (coarse grants imply fine-grained ones; a `MERCHANT_ADMIN`
/// with `merchant:write` also holds the privileged set). The policy must not reject a principal the
/// handler would accept, so it lists every raw authority that can *effectively* grant one of
/// `required`, for either merchant role or an API token. The handler then applies the exact,
/// role-aware check, which also rejects the raw authority when its implication does not apply.
#[must_use]
pub fn policy_authorities(required: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = required.iter().map(|value| (*value).to_owned()).collect();
    let mut candidates: BTreeSet<&str> = CANDIDATE_AUTHORITIES.iter().copied().collect();
    candidates.extend(CANDIDATE_TOKEN_SCOPES.iter().copied());
    for candidate in candidates {
        if out.iter().any(|held| held == candidate) {
            continue;
        }
        let raw = vec![candidate.to_owned()];
        let admin = MerchantPrincipal::session("MERCHANT_ADMIN", raw.clone());
        let staff = MerchantPrincipal::session("MERCHANT_STAFF", raw.clone());
        let token = MerchantPrincipal::api_token(raw);
        if has_authority(&admin, required)
            || has_authority(&staff, required)
            || has_authority(&token, required)
        {
            out.push(candidate.to_owned());
        }
    }
    out
}

/// `assertMerchantAuthority`: deny by default, OR semantics, role-aware implications.
pub fn assert_merchant_authority(principal: &Principal, required: &[&str]) -> Result<(), ApiError> {
    principal
        .require_merchant_authority(required)
        .map_err(crate::auth::api_error)
}

/// A merchant SESSION principal for the non-`/external/` routes.
///
/// TS mounts `requireMerchantPrincipal` and then refuses an API token on every path outside
/// `/external/` with `403 API_TOKEN_SCOPE_VIOLATION`.
pub fn require_merchant_session(
    principal: Option<&Principal>,
) -> Result<(&Principal, Uuid), ApiError> {
    let principal = principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })?;
    if principal.kind == PrincipalKind::ApiToken {
        return Err(ApiError::new(
            403,
            "API_TOKEN_SCOPE_VIOLATION",
            "API access tokens can only call the external API",
        ));
    }
    Ok((principal, principal_merchant_id(principal)?))
}

/// A merchant principal of either kind (`/external/*` and `/auth/me`).
pub fn require_merchant_principal(
    principal: Option<&Principal>,
) -> Result<(&Principal, Uuid), ApiError> {
    let principal = principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })?;
    Ok((principal, principal_merchant_id(principal)?))
}

/// `merchantIdOf`: the merchant the principal is bound to, never a query value.
pub fn principal_merchant_id(principal: &Principal) -> Result<Uuid, ApiError> {
    let raw = principal.merchant_id.as_deref().ok_or_else(|| {
        ApiError::new(
            403,
            "MERCHANT_CONTEXT_REQUIRED",
            "The principal is not bound to a merchant",
        )
    })?;
    Uuid::parse_str(raw).map_err(|_| {
        ApiError::new(
            403,
            "MERCHANT_CONTEXT_REQUIRED",
            "The principal is not bound to a merchant",
        )
    })
}

/// The applications the principal may touch (`app_scope_ids` for sessions, the issued application
/// for an API token); `None` means the whole merchant.
#[must_use]
pub fn application_scope(principal: &Principal) -> Option<Vec<Uuid>> {
    if principal.kind == PrincipalKind::ApiToken {
        return principal
            .application_id
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw).ok())
            .map(|id| vec![id]);
    }
    if principal.app_scope_ids.is_empty() {
        None
    } else {
        Some(
            principal
                .app_scope_ids
                .iter()
                .filter_map(|raw| Uuid::parse_str(raw).ok())
                .collect(),
        )
    }
}

/// `assertApplicationInScope`: 403 when a scoped principal addresses another application.
pub fn assert_application_in_scope(
    scope: Option<&[Uuid]>,
    application_id: Option<Uuid>,
) -> Result<(), ApiError> {
    if let Some(scope) = scope {
        if !application_id.is_some_and(|id| scope.contains(&id)) {
            return Err(ApiError::new(
                403,
                "APP_SCOPE_VIOLATION",
                "The principal is restricted to specific applications and this one is not among them",
            ));
        }
    }
    Ok(())
}

/// A UUID path segment, or the route's 404 for a malformed id.
pub fn path_uuid(
    request: &HttpRequest,
    index: usize,
    code: &str,
    message: &str,
) -> Result<Uuid, ApiError> {
    let raw = path_segment(request, index).ok_or_else(|| ApiError::new(404, code, message))?;
    Uuid::parse_str(raw).map_err(|_| ApiError::new(404, code, message))
}

/// The raw path segment at `index` (0 is the empty string before the leading `/`).
#[must_use]
pub fn path_segment(request: &HttpRequest, index: usize) -> Option<&str> {
    request.path().split('/').nth(index)
}

/// The last path segment (a key, a reference, a month).
#[must_use]
pub fn last_segment(request: &HttpRequest) -> Option<&str> {
    request
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
}

/// The raw query map with repeated keys as arrays (Express `req.query` shape).
#[must_use]
pub fn query_map(request: &HttpRequest) -> Map<String, Value> {
    let mut map: Map<String, Value> = Map::new();
    for (key, value) in url::form_urlencoded::parse(request.query_string().as_bytes()) {
        let key = key.into_owned();
        let value = Value::String(value.into_owned());
        match map.get_mut(&key) {
            None => {
                map.insert(key, value);
            }
            Some(existing) => {
                if let Value::Array(entries) = existing {
                    entries.push(value);
                } else {
                    let first = std::mem::replace(existing, Value::Null);
                    *existing = Value::Array(vec![first, value]);
                }
            }
        }
    }
    map
}

/// The first scalar value of a query key (`asString` in `listQuery.ts` trims it; scalar readers in
/// the handlers do not, so this does not either).
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

/// `Promise`-free `Math.min(MAX, Math.max(1, Number(raw ?? fallback) || fallback))`.
#[must_use]
pub fn positive_int(raw: Option<&str>, fallback: u32, max: u32) -> u32 {
    let parsed = raw
        .map(str::trim)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value != 0.0)
        .map(|value| value.trunc() as i64)
        .unwrap_or(i64::from(fallback));
    parsed.clamp(1, i64::from(max)) as u32
}

/// Add a synthetic equality filter to a `pg_db` list query. The key is prefixed so a client cannot
/// collide with it; the value always comes from the server.
pub fn set_filter(map: &mut Map<String, Value>, key: &str, value: impl Into<String>) {
    map.insert(format!("__{key}"), Value::String(value.into()));
}

/// Add a synthetic `IN` filter (`pg_db` splits the value on commas).
pub fn set_in_filter(map: &mut Map<String, Value>, key: &str, values: &[Uuid]) {
    if values.is_empty() {
        return;
    }
    map.insert(
        format!("__{key}"),
        Value::String(
            values
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
    );
}

/// The `IN` list for a handful of enum strings.
pub fn set_in_list(map: &mut Map<String, Value>, key: &str, values: &[&str]) {
    if values.is_empty() {
        return;
    }
    map.insert(format!("__{key}"), Value::String(values.join(",")));
}

// ---------------------------------------------------------------------------------------------
// Row serialisation
// ---------------------------------------------------------------------------------------------

/// How a selected column is rendered in the JSON body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Text,
    Uuid,
    /// `timestamp(3)` without time zone holding UTC.
    Timestamp,
    /// `timestamptz(3)`.
    Timestamptz,
    /// `date`.
    DateOnly,
    /// Prisma `Decimal` inside `JSON.stringify` (decimal.js `toString()`).
    Decimal,
    /// `toFixed(4)` (handler-level money fields).
    Money4,
    Bool,
    Int,
    /// BigInt rendered as a string (`sizeBytes.toString()`).
    BigIntText,
    Json,
    TextArray,
}

/// One selected column and the JSON key it becomes (Prisma model field order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Field {
    pub column: &'static str,
    pub key: &'static str,
    pub kind: FieldKind,
}

/// Build a [`Field`] (a short constructor keeps the field tables readable).
#[must_use]
pub const fn f(column: &'static str, key: &'static str, kind: FieldKind) -> Field {
    Field { column, key, kind }
}

fn get_opt<'r, T>(row: &'r PgRow, column: &str) -> Result<Option<T>, ApiError>
where
    T: sqlx::Decode<'r, Postgres> + sqlx::Type<Postgres>,
{
    row.try_get::<Option<T>, _>(column).map_err(database_error)
}

/// `Date#toISOString()` from a `timestamp(3)` UTC column.
#[must_use]
pub fn iso_timestamp(value: Option<NaiveDateTime>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(pg_types::JsDate(value.and_utc()).to_iso_string())
    })
}

/// `Date#toISOString()` from a `timestamptz(3)` column.
#[must_use]
pub fn iso_timestamptz(value: Option<DateTime<Utc>>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(pg_types::JsDate(value).to_iso_string())
    })
}

/// `Date#toISOString()` from a `date` column (midnight UTC).
#[must_use]
pub fn iso_date(value: Option<NaiveDate>) -> Value {
    value.map_or(Value::Null, |value| {
        let midnight = value.and_hms_opt(0, 0, 0).unwrap_or_else(|| {
            NaiveDate::from_ymd_opt(1970, 1, 1)
                .unwrap_or_default()
                .and_hms_opt(0, 0, 0)
                .unwrap_or_default()
        });
        Value::String(pg_types::JsDate(midnight.and_utc()).to_iso_string())
    })
}

/// Render one selected row as a JSON object with Prisma field names and JS value shapes.
pub fn row_json(row: &PgRow, fields: &[Field]) -> Result<Value, ApiError> {
    let mut map = Map::new();
    for field in fields {
        let value = match field.kind {
            FieldKind::Text => {
                get_opt::<String>(row, field.column)?.map_or(Value::Null, Value::String)
            }
            FieldKind::Uuid => get_opt::<Uuid>(row, field.column)?
                .map_or(Value::Null, |value| Value::String(value.to_string())),
            FieldKind::Timestamp => iso_timestamp(get_opt::<NaiveDateTime>(row, field.column)?),
            FieldKind::Timestamptz => iso_timestamptz(get_opt::<DateTime<Utc>>(row, field.column)?),
            FieldKind::DateOnly => iso_date(get_opt::<NaiveDate>(row, field.column)?),
            FieldKind::Decimal => get_opt::<Decimal>(row, field.column)?
                .map_or(Value::Null, |value| {
                    Value::String(pg_types::DecimalJs(value).to_decimal_js_string())
                }),
            FieldKind::Money4 => get_opt::<Decimal>(row, field.column)?
                .map_or(Value::Null, |value| {
                    Value::String(pg_types::Money4(value).to_fixed_4())
                }),
            FieldKind::Bool => get_opt::<bool>(row, field.column)?.map_or(Value::Null, Value::Bool),
            FieldKind::Int => get_opt::<i32>(row, field.column)?.map_or(Value::Null, Value::from),
            FieldKind::BigIntText => get_opt::<i64>(row, field.column)?
                .map_or(Value::Null, |value| Value::String(value.to_string())),
            FieldKind::Json => get_opt::<Value>(row, field.column)?
                .map(|value| pg_types::js_object_order(&value))
                .unwrap_or(Value::Null),
            FieldKind::TextArray => get_opt::<Vec<String>>(row, field.column)?
                .map_or(Value::Null, |values| {
                    Value::Array(values.into_iter().map(Value::String).collect())
                }),
        };
        map.insert(field.key.to_owned(), value);
    }
    Ok(Value::Object(map))
}

/// Render selected rows.
pub fn rows_json(rows: &[PgRow], fields: &[Field]) -> Result<Vec<Value>, ApiError> {
    rows.iter().map(|row| row_json(row, fields)).collect()
}

/// One ORDER BY term and the selected column that carries its value (for `nextCursor`).
#[derive(Debug, Clone, Copy)]
pub struct CursorColumn {
    pub path: &'static str,
    pub column: &'static str,
    pub kind: FieldKind,
}

/// Build the cursor source rows for [`pg_db::list_query::list_response`].
pub fn cursor_rows(
    keyset: Option<&KeysetPlan>,
    rows: &[PgRow],
    columns: &[CursorColumn],
) -> Result<Vec<Vec<CursorValue>>, ApiError> {
    let Some(keyset) = keyset else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = Vec::with_capacity(keyset.fields.len());
        for field in &keyset.fields {
            let Some(column) = columns.iter().find(|column| column.path == field.path) else {
                return Ok(Vec::new());
            };
            values.push(cursor_value(row, column)?);
        }
        out.push(values);
    }
    Ok(out)
}

fn cursor_value(row: &PgRow, column: &CursorColumn) -> Result<CursorValue, ApiError> {
    Ok(match column.kind {
        FieldKind::Text | FieldKind::Uuid => CursorValue::Text(match column.kind {
            FieldKind::Text => get_opt::<String>(row, column.column)?.unwrap_or_default(),
            _ => get_opt::<Uuid>(row, column.column)?
                .map(|value| value.to_string())
                .unwrap_or_default(),
        }),
        FieldKind::Timestamp => {
            let value = get_opt::<NaiveDateTime>(row, column.column)?;
            CursorValue::Date(
                value
                    .map(|value| pg_types::JsDate(value.and_utc()).to_iso_string())
                    .unwrap_or_default(),
            )
        }
        FieldKind::Decimal => CursorValue::Numeric(
            get_opt::<Decimal>(row, column.column)?
                .map(|value| pg_types::DecimalJs(value).to_decimal_js_string())
                .unwrap_or_default(),
        ),
        FieldKind::Bool => CursorValue::Bool(get_opt::<bool>(row, column.column)?.unwrap_or(false)),
        FieldKind::Int => CursorValue::Number(f64::from(
            get_opt::<i32>(row, column.column)?.unwrap_or_default(),
        )),
        _ => return Ok(CursorValue::Text(String::new())),
    })
}

/// A `Field` table for the columns of one SELECT reused by several handlers.
pub type Fields = &'static [Field];

/// The BTreeMap form of a JSON object (some helpers need deterministic iteration).
pub fn json_map(value: &Value) -> BTreeMap<String, Value> {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        _ => BTreeMap::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// Shared row field tables
// ---------------------------------------------------------------------------------------------

/// `merchantAttemptListSelect` (`merchant.ts:680`): the merchant-safe attempt columns.
pub const ATTEMPT_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("reference", "reference", FieldKind::Text),
    f("link_id", "linkId", FieldKind::Uuid),
    f("application_id", "applicationId", FieldKind::Uuid),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("rail_id", "railId", FieldKind::Uuid),
    f("route_id", "routeId", FieldKind::Uuid),
    f("env", "env", FieldKind::Text),
    f("mode", "mode", FieldKind::Text),
    f("sub_mode", "subMode", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("substatus", "substatus", FieldKind::Text),
    f("gateway_reference", "gatewayReference", FieldKind::Text),
    f("provider_reference", "providerReference", FieldKind::Text),
    f("network_reference", "networkReference", FieldKind::Text),
    f("requested_amount", "requestedAmount", FieldKind::Decimal),
    f("surcharge_amount", "surchargeAmount", FieldKind::Decimal),
    f(
        "total_charged_amount",
        "totalChargedAmount",
        FieldKind::Decimal,
    ),
    f("settled_amount", "settledAmount", FieldKind::Decimal),
    f(
        "platform_commission_amount",
        "platformCommissionAmount",
        FieldKind::Decimal,
    ),
    f(
        "net_merchant_amount",
        "netMerchantAmount",
        FieldKind::Decimal,
    ),
    f("fee_bearer", "feeBearer", FieldKind::Text),
    f("settlement_target", "settlementTarget", FieldKind::Text),
    f("currency", "currency", FieldKind::Text),
    f("expires_at", "expiresAt", FieldKind::Timestamp),
    f("terminal_at", "terminalAt", FieldKind::Timestamp),
];

/// The projection that yields [`ATTEMPT_FIELDS`] in order (`pa` alias).
pub const ATTEMPT_COLUMNS: &str = "pa.id, pa.created_at, pa.updated_at, pa.reference, pa.link_id, \
     pa.application_id, pa.merchant_id, pa.rail_id, pa.route_id, pa.env::text AS env, pa.mode, \
     pa.sub_mode, pa.status::text AS status, pa.substatus, pa.gateway_reference, \
     pa.provider_reference, pa.network_reference, pa.requested_amount, pa.surcharge_amount, \
     pa.total_charged_amount, pa.settled_amount, pa.platform_commission_amount, \
     pa.net_merchant_amount, pa.fee_bearer::text AS fee_bearer, \
     pa.settlement_target::text AS settlement_target, pa.currency, pa.expires_at, pa.terminal_at";

/// The attempt cursor columns.
pub const ATTEMPT_CURSORS: &[CursorColumn] = &[
    CursorColumn {
        path: "createdAt",
        column: "created_at",
        kind: FieldKind::Timestamp,
    },
    CursorColumn {
        path: "id",
        column: "id",
        kind: FieldKind::Uuid,
    },
    CursorColumn {
        path: "reference",
        column: "reference",
        kind: FieldKind::Text,
    },
    CursorColumn {
        path: "totalChargedAmount",
        column: "total_charged_amount",
        kind: FieldKind::Decimal,
    },
    CursorColumn {
        path: "status",
        column: "status",
        kind: FieldKind::Text,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(role: &str, authorities: &[&str], kind: PrincipalKind) -> Principal {
        let raw = pg_domain_auth::generate_api_token(pg_domain_auth::ExecutionPlane::Live);
        let token = pg_domain_auth::ApiToken::parse(&raw).expect("valid generated token");
        let mut principal = Principal::from_api_token(
            &token,
            "token-id",
            Some("00000000-0000-4000-8000-000000000001".to_owned()),
            Some("00000000-0000-4000-8000-000000000002".to_owned()),
            authorities
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        );
        principal.kind = kind;
        principal.role = Some(role.to_owned());
        principal
    }

    #[test]
    fn coarse_grants_satisfy_the_fine_grained_policy() {
        // `merchant:write` implies payment:read, link:read and report_engine:run.
        let write = principal(
            "MERCHANT_STAFF",
            &["merchant:write"],
            PrincipalKind::Session,
        );
        assert_merchant_authority(&write, &["payment:read"]).expect("implied payment:read");
        assert_merchant_authority(&write, &["link:read"]).expect("implied link:read");
        assert_merchant_authority(&write, &["report_engine:run"]).expect("implied run");
        // ... but only a MERCHANT_ADMIN gets the authoring and privileged authorities.
        assert!(assert_merchant_authority(&write, &["report_engine:author"]).is_err());
        assert!(assert_merchant_authority(&write, &["user:manage"]).is_err());
        let admin = principal(
            "MERCHANT_ADMIN",
            &["merchant:write"],
            PrincipalKind::Session,
        );
        assert_merchant_authority(&admin, &["report_engine:author"]).expect("admin author");
        assert_merchant_authority(&admin, &["token:manage"]).expect("admin token");
    }

    #[test]
    fn read_grants_cover_the_read_routes() {
        let read = principal("MERCHANT_STAFF", &["merchant:read"], PrincipalKind::Session);
        assert_merchant_authority(&read, &["payment:read"]).expect("implied payment:read");
        assert_merchant_authority(&read, &["cashout:read"]).expect("implied cashout:read");
        assert_merchant_authority(&read, &["report_engine:run"]).expect("implied run");
        assert!(assert_merchant_authority(&read, &["dispute:respond"]).is_err());
        assert!(assert_merchant_authority(&read, &["onboarding:write"]).is_err());
    }

    #[test]
    fn api_tokens_hold_exactly_their_scopes() {
        let token = principal("MERCHANT_API", &["link:write"], PrincipalKind::ApiToken);
        assert_merchant_authority(&token, &["link:read"]).expect("link:write implies link:read");
        assert!(assert_merchant_authority(&token, &["payment:read"]).is_err());
        let token = principal("MERCHANT_API", &["payment:read"], PrincipalKind::ApiToken);
        assert_merchant_authority(&token, &["payment:read"]).expect("scope");
    }

    #[test]
    fn policy_lists_every_raw_authority_that_can_pass() {
        let payment = policy_authorities(&["payment:read"]);
        for raw in [
            "payment:read",
            "merchant:read",
            "merchant:write",
            "link:write",
        ] {
            assert!(payment.iter().any(|value| value == raw), "{raw} missing");
        }
        let author = policy_authorities(&["report_engine:author"]);
        assert!(author.iter().any(|value| value == "merchant:write"));
        assert!(!author.iter().any(|value| value == "merchant:read"));
        let cashout = policy_authorities(&["cashout:read", "cashout:request"]);
        assert!(cashout.iter().any(|value| value == "merchant:read"));
        assert!(cashout.iter().any(|value| value == "cashout:request"));
    }

    #[test]
    fn merchant_scope_rejects_a_principal_without_a_merchant() {
        // A merchant SESSION that is not bound to a merchant cannot name one.
        let mut session = principal("MERCHANT_STAFF", &["merchant:read"], PrincipalKind::Session);
        session.merchant_id = None;
        let error = require_merchant_session(Some(&session)).expect_err("no merchant");
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "MERCHANT_CONTEXT_REQUIRED");
        // An API token never reaches a non-external route (the TS middleware runs before the handler).
        let mut token = principal("MERCHANT_API", &["payment:read"], PrincipalKind::ApiToken);
        token.merchant_id = Some("00000000-0000-4000-8000-000000000001".to_owned());
        let error = require_merchant_session(Some(&token)).expect_err("token on a session route");
        assert_eq!(error.code, "API_TOKEN_SCOPE_VIOLATION");
        require_merchant_principal(Some(&token)).expect("the external API accepts tokens");
    }

    #[test]
    fn application_scope_is_empty_for_unrestricted_users() {
        let mut session = principal("MERCHANT_STAFF", &["merchant:read"], PrincipalKind::Session);
        session.app_scope_ids = Vec::new();
        assert!(application_scope(&session).is_none());
        session.app_scope_ids = vec!["00000000-0000-4000-8000-000000000002".to_owned()];
        let scope = application_scope(&session).expect("restricted");
        assert_eq!(scope.len(), 1);
        assert!(assert_application_in_scope(Some(&scope), Some(scope[0])).is_ok());
        assert_eq!(
            assert_application_in_scope(Some(&scope), None)
                .expect_err("outside")
                .code,
            "APP_SCOPE_VIOLATION"
        );
    }

    #[test]
    fn positive_int_matches_the_js_expression() {
        assert_eq!(positive_int(None, 50, 100), 50);
        assert_eq!(positive_int(Some("0"), 50, 100), 50);
        assert_eq!(positive_int(Some("abc"), 50, 100), 50);
        assert_eq!(positive_int(Some("500"), 50, 100), 100);
        assert_eq!(positive_int(Some("3.9"), 50, 100), 3);
        assert_eq!(positive_int(Some("-2"), 50, 100), 1);
    }

    #[test]
    fn query_scalar_reads_the_first_repeated_value() {
        // `query_map` mirrors Express: repeated keys become arrays and `asString` takes `[0]`.
        let mut map = Map::new();
        for (key, value) in url::form_urlencoded::parse(b"state=ACTIVE&state=PENDING") {
            let value = Value::String(value.into_owned());
            match map.get_mut(key.as_ref()) {
                None => {
                    map.insert(key.into_owned(), value);
                }
                Some(existing) => {
                    let first = std::mem::replace(existing, Value::Null);
                    *existing = Value::Array(vec![first, value]);
                }
            }
        }
        assert_eq!(map["state"], serde_json::json!(["ACTIVE", "PENDING"]));
    }
}

#[cfg(test)]
mod db_tests {
    use std::sync::Arc;

    use chrono::Utc;
    use ntex::http::Method;
    use ntex::web::test;
    use ntex::web::types::Payload;
    use pg_domain_auth::{
        generate_api_token, hash_access_token, sign_session_at, Channel, ExecutionPlane,
        SessionClaims,
    };
    use serde_json::Value;
    use uuid::Uuid;

    use super::super::common::json_ok;
    use super::report_catalog::TEMPLATE_GENERATED_AT;
    use super::{require_merchant_session, routes};
    use crate::config::CoreConfig;
    use crate::routes::Handler;
    use crate::state::AppState;

    const MASTER_KEY: &str = "core-rs-merchant-read-integration-key-0123456789";
    const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

    fn database_url() -> String {
        std::env::var("PG_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| DEFAULT_URL.to_owned())
    }

    async fn state_or_skip() -> Option<Arc<AppState>> {
        let url = database_url();
        match AppState::connect(CoreConfig::for_tests(&url, MASTER_KEY)).await {
            Ok(state) => Some(state),
            Err(error) => {
                eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
                None
            }
        }
    }

    struct Response {
        status: u16,
        body: Value,
    }

    async fn call(
        state: &Arc<AppState>,
        method: &str,
        path: &str,
        token: Option<&str>,
    ) -> Response {
        let mut request = test::TestRequest::default()
            .method(Method::from_bytes(method.as_bytes()).expect("method"))
            .uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = crate::app::dispatch(
            state.clone(),
            request.to_http_request(),
            Payload(ntex::http::Payload::None),
        )
        .await;
        let status = response.status().as_u16();
        let body = ntex::web::test::read_body(response).await;
        Response {
            status,
            body: serde_json::from_slice(&body).unwrap_or(Value::Null),
        }
    }

    /// Dispatch a CSV response (status, content-type, body text).
    async fn csv_call(
        state: &Arc<AppState>,
        path: &str,
        token: &str,
    ) -> (u16, Option<String>, String) {
        let request = test::TestRequest::default()
            .uri(path)
            .header("authorization", format!("Bearer {token}"))
            .to_http_request();
        let response =
            crate::app::dispatch(state.clone(), request, Payload(ntex::http::Payload::None)).await;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = ntex::web::test::read_body(response).await;
        (
            status,
            content_type,
            String::from_utf8_lossy(&body).to_string(),
        )
    }

    async fn insert_user(
        state: &AppState,
        merchant_id: Option<Uuid>,
        role: &str,
        authorities: Value,
        app_scope: Value,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let email = format!("{id}@merchant-read.integration.local");
        sqlx::query(
            "INSERT INTO users (id, updated_at, merchant_id, email, role, authorities_map, \
                                app_scope_ids, is_maker, is_checker, mfa_required, status) \
             VALUES ($1, now(), $2, $3, $4::\"UserRole\", $5::jsonb, $6::jsonb, false, false, false, 'ACTIVE')",
        )
        .bind(id)
        .bind(merchant_id)
        .bind(email)
        .bind(role)
        .bind(authorities)
        .bind(app_scope)
        .execute(&state.pools.main)
        .await
        .expect("insert merchant user");
        id
    }

    async fn delete_user(state: &AppState, id: Uuid) {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id)
            .execute(&state.pools.main)
            .await
            .expect("delete merchant user");
    }

    fn mint_session(
        user_id: Uuid,
        role: &str,
        merchant_id: Option<Uuid>,
        authorities: &[&str],
        app_scope: &[Uuid],
    ) -> String {
        let now = Utc::now();
        let jti = Uuid::new_v4();
        let mut claims = SessionClaims::new(user_id.to_string(), role)
            .with_authorities(authorities.iter().copied())
            .with_app_scope_ids(app_scope.iter().map(|id| id.to_string()))
            .with_channel(Channel::Merchant)
            .expect("merchant channel");
        if let Some(merchant_id) = merchant_id {
            claims = claims.with_merchant(merchant_id.to_string());
        }
        claims.jti = Some(jti.to_string());
        claims.iat = Some(now.timestamp());
        claims.exp = Some(now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
        sign_session_at(&claims, MASTER_KEY, now).expect("sign session")
    }

    /// A merchant with at least two attempts, one wallet, one link and one application.
    async fn populated_merchant(state: &AppState) -> Option<(Uuid, Uuid, Uuid, Uuid, Uuid)> {
        let row: Option<(Uuid, Uuid, Uuid, Uuid, Uuid)> = sqlx::query_as(
            "SELECT pa.merchant_id, pa.application_id, pa.link_id, w.id, l.id \
               FROM payment_attempts pa \
               JOIN payment_links l ON l.id = pa.link_id \
               JOIN applications ap ON ap.id = pa.application_id \
               JOIN wallets w ON w.id = l.wallet_id \
              GROUP BY pa.merchant_id, pa.application_id, pa.link_id, w.id, l.id \
             HAVING (SELECT count(*) FROM payment_attempts x WHERE x.merchant_id = pa.merchant_id) >= 2 \
              ORDER BY (SELECT count(*) FROM payment_attempts x WHERE x.merchant_id = pa.merchant_id) DESC \
              LIMIT 1",
        )
        .fetch_optional(&state.pools.main)
        .await
        .expect("populated merchant lookup");
        row
    }

    #[tokio::test]
    async fn merchant_lists_are_scoped_paged_and_cursored() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let Some((merchant_id, application_id, link_id, wallet_id, _)) =
            populated_merchant(&state).await
        else {
            eprintln!("SKIP: no merchant with two attempts in the test database");
            return;
        };
        let user = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_STAFF",
            serde_json::json!(["merchant:read"]),
            serde_json::json!([]),
        )
        .await;
        let token = mint_session(
            user,
            "MERCHANT_STAFF",
            Some(merchant_id),
            &["merchant:read"],
            &[],
        );

        // A populated list with keyset pagination on the default sort.
        let first = call(
            &state,
            "GET",
            "/internal/merchant/payments?pageSize=1",
            Some(&token),
        )
        .await;
        assert_eq!(first.status, 200, "{:?}", first.body);
        assert_eq!(first.body["page"], 1);
        assert_eq!(first.body["pageSize"], 1);
        assert!(first.body["total"].as_i64().is_some_and(|total| total >= 2));
        let payments = first.body["payments"].as_array().expect("payments array");
        assert_eq!(payments.len(), 1);
        assert_eq!(payments[0]["merchantId"], merchant_id.to_string());
        assert_eq!(payments[0]["applicationId"], application_id.to_string());
        let cursor = first.body["nextCursor"]
            .as_str()
            .expect("nextCursor on a full page")
            .to_owned();
        let second = call(
            &state,
            "GET",
            &format!("/internal/merchant/payments?pageSize=1&cursor={cursor}"),
            Some(&token),
        )
        .await;
        assert_eq!(second.status, 200);
        let second_payments = second.body["payments"].as_array().expect("payments array");
        assert_eq!(second_payments.len(), 1);
        assert_ne!(
            second_payments[0]["reference"], payments[0]["reference"],
            "the cursor moves past the first row"
        );
        assert!(
            second.body.get("nextCursor").is_some(),
            "a full page keeps carrying a cursor"
        );

        // An unknown filter returns an empty page, not an error.
        let empty = call(
            &state,
            "GET",
            "/internal/merchant/payments?search=zzz-no-such-reference",
            Some(&token),
        )
        .await;
        assert_eq!(empty.status, 200);
        assert_eq!(empty.body["total"], 0);
        assert_eq!(empty.body["payments"].as_array().map(Vec::len), Some(0));

        // A merchant id in the query must never widen the scope.
        let other = Uuid::new_v4();
        let ignored = call(
            &state,
            "GET",
            &format!("/internal/merchant/payments?merchantId={other}"),
            Some(&token),
        )
        .await;
        assert_eq!(ignored.status, 200);
        for payment in ignored.body["payments"].as_array().expect("payments") {
            assert_eq!(payment["merchantId"], merchant_id.to_string());
        }

        for path in [
            "/internal/merchant/wallets?pageSize=1",
            "/internal/merchant/applications?pageSize=1",
            "/internal/merchant/links?pageSize=1",
            "/internal/merchant/cashouts?pageSize=1",
        ] {
            let response = call(&state, "GET", path, Some(&token)).await;
            assert_eq!(response.status, 200, "{path}: {:?}", response.body);
            assert!(response.body["total"].as_i64().is_some(), "{path} total");
            assert!(
                response.body["pageSize"].as_i64().is_some(),
                "{path} pageSize"
            );
        }

        // The overview aggregates the same merchant: attempts, currency breakdown and rate.
        let overview = call(
            &state,
            "GET",
            "/internal/merchant/stats/overview",
            Some(&token),
        )
        .await;
        assert_eq!(overview.status, 200, "{:?}", overview.body);
        assert!(overview.body["currency"].is_string());
        assert!(overview.body["attempts"].as_i64().is_some());
        assert!(overview.body["byStatus"].is_object());
        assert!(overview.body["byCurrency"].is_array());
        assert!(overview.body["successRate"]
            .as_str()
            .is_some_and(|value| value.contains('.')));
        assert!(overview.body["recentPayments"].is_array());

        // Detail routes (dynamic segments) through the real dispatcher.
        let wallet = call(
            &state,
            "GET",
            &format!("/internal/merchant/wallets/{wallet_id}"),
            Some(&token),
        )
        .await;
        assert_eq!(wallet.status, 200, "{:?}", wallet.body);
        assert_eq!(wallet.body["wallet"]["id"], wallet_id.to_string());
        assert!(wallet.body["wallet"]["glAccount"]["currency"].is_string());

        let balance = call(
            &state,
            "GET",
            &format!("/internal/merchant/wallets/{wallet_id}/balance"),
            Some(&token),
        )
        .await;
        assert_eq!(balance.status, 200, "{:?}", balance.body);
        assert!(balance.body["balance"]
            .as_str()
            .is_some_and(|value| value.contains('.')));
        assert!(balance.body["checkpointBalance"].as_str().is_some());

        // The statement export is a CSV response (the month comes from a settled attempt).
        let month: Option<String> = sqlx::query_scalar(
            "SELECT to_char(pa.created_at, 'YYYY-MM') FROM payment_attempts pa \
             JOIN payment_links l ON l.id = pa.link_id \
              WHERE l.wallet_id = $1 AND pa.status = 'SUCCEEDED' \
              ORDER BY pa.created_at DESC LIMIT 1",
        )
        .bind(wallet_id)
        .fetch_optional(&state.pools.main)
        .await
        .expect("statement month");
        if let Some(month) = month {
            let export = csv_call(
                &state,
                &format!("/internal/merchant/wallets/{wallet_id}/statements/{month}/export"),
                &token,
            )
            .await;
            assert_eq!(export.0, 200);
            assert_eq!(export.1.as_deref(), Some("text/csv; charset=utf-8"));
            assert!(export.2.starts_with(
                "reference,created_at,total_charged,commission,net_merchant,currency,status"
            ));
        }
        let invalid = call(
            &state,
            "GET",
            &format!("/internal/merchant/wallets/{wallet_id}/statements/2026-13/export"),
            Some(&token),
        )
        .await;
        assert_eq!(invalid.status, 400);
        assert_eq!(invalid.body["code"], "STATEMENT_MONTH_INVALID");

        let application = call(
            &state,
            "GET",
            &format!("/internal/merchant/applications/{application_id}"),
            Some(&token),
        )
        .await;
        assert_eq!(application.status, 200, "{:?}", application.body);
        assert_eq!(
            application.body["application"]["id"],
            application_id.to_string()
        );

        let link = call(
            &state,
            "GET",
            &format!("/internal/merchant/links/{link_id}"),
            Some(&token),
        )
        .await;
        assert_eq!(link.status, 200, "{:?}", link.body);
        assert_eq!(link.body["link"]["id"], link_id.to_string());

        let attempts = call(
            &state,
            "GET",
            &format!("/internal/merchant/links/{link_id}/attempts"),
            Some(&token),
        )
        .await;
        assert_eq!(attempts.status, 200, "{:?}", attempts.body);
        assert!(attempts.body["attempts"].as_array().is_some());

        // The onboarding and webhook reads answer their envelopes.
        for (path, key) in [
            ("/internal/merchant/onboarding/join-request", "joinRequest"),
            (
                "/internal/merchant/onboarding/kyb-revalidations",
                "revalidations",
            ),
            ("/internal/merchant/onboarding/beneficial-owners", "owners"),
            ("/internal/merchant/webhooks/event-types", "eventTypes"),
            ("/internal/merchant/webhooks/endpoints", "endpoints"),
            ("/internal/merchant/webhooks/deliveries", "deliveries"),
        ] {
            let response = call(&state, "GET", path, Some(&token)).await;
            assert_eq!(response.status, 200, "{path}: {:?}", response.body);
            assert!(response.body.get(key).is_some(), "{path} key {key}");
        }

        delete_user(&state, user).await;
    }

    #[tokio::test]
    async fn scoped_principals_and_api_tokens_are_rejected() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let Some((merchant_id, application_id, _, _, _)) = populated_merchant(&state).await else {
            eprintln!("SKIP: no populated merchant");
            return;
        };

        // A user restricted to an application cannot read the merchant-wide overview.
        let scoped = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_STAFF",
            serde_json::json!(["merchant:read"]),
            serde_json::json!([application_id.to_string()]),
        )
        .await;
        let token = mint_session(
            scoped,
            "MERCHANT_STAFF",
            Some(merchant_id),
            &["merchant:read"],
            &[application_id],
        );
        let response = call(
            &state,
            "GET",
            "/internal/merchant/stats/overview",
            Some(&token),
        )
        .await;
        assert_eq!(response.status, 403);
        assert_eq!(response.body["code"], "APP_SCOPE_RESTRICTED");

        // The scoped list still answers, narrowed to the application.
        let response = call(
            &state,
            "GET",
            "/internal/merchant/applications",
            Some(&token),
        )
        .await;
        assert_eq!(response.status, 200);
        for application in response.body["applications"]
            .as_array()
            .expect("applications")
        {
            assert_eq!(application["id"], application_id.to_string());
        }

        // Another merchant's wallet is not found, never returned and never leaked.
        let foreign_wallet: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM wallets WHERE merchant_id <> $1 LIMIT 1")
                .bind(merchant_id)
                .fetch_optional(&state.pools.main)
                .await
                .expect("foreign wallet");
        if let Some(foreign_wallet) = foreign_wallet {
            let response = call(
                &state,
                "GET",
                &format!("/internal/merchant/wallets/{foreign_wallet}"),
                Some(&token),
            )
            .await;
            assert_eq!(response.status, 404);
            assert_eq!(response.body["code"], "WALLET_NOT_FOUND");
        }

        // No authority: token management is privileged and never implied by merchant:read.
        let unprivileged = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_STAFF",
            serde_json::json!(["merchant:read"]),
            serde_json::json!([]),
        )
        .await;
        let token = mint_session(
            unprivileged,
            "MERCHANT_STAFF",
            Some(merchant_id),
            &["merchant:read"],
            &[],
        );
        let response = call(&state, "GET", "/internal/merchant/tokens", Some(&token)).await;
        assert_eq!(response.status, 403);
        assert_eq!(response.body["code"], "AUTHORITY_REQUIRED");
        assert_eq!(response.body["details"]["required"][0], "token:manage");

        // A staff session never reaches a merchant route.
        let staff = insert_user(
            &state,
            None,
            "COMPLIANCE",
            serde_json::json!(["merchant:read"]),
            serde_json::json!([]),
        )
        .await;
        let token = mint_session(staff, "COMPLIANCE", None, &["merchant:read"], &[]);
        let response = call(&state, "GET", "/internal/merchant/wallets", Some(&token)).await;
        assert_eq!(response.status, 403);
        assert_eq!(response.body["code"], "STAFF_PRINCIPAL_REQUIRED");

        // An API token is confined to `/external/*`.
        let raw = generate_api_token(ExecutionPlane::Live);
        let token_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO access_tokens (id, updated_at, merchant_id, application_id, name, \
                                        token_hash, last_four, scopes, ip_whitelist_enabled, env) \
             VALUES ($1, now(), $2, $3, 'merchant-read-test', $4, 'test', $5::jsonb, false, \
                     'LIVE'::\"GatewayEnvironmentType\")",
        )
        .bind(token_id)
        .bind(merchant_id)
        .bind(application_id)
        .bind(hash_access_token(&raw))
        .bind(serde_json::json!(["payment:read"]))
        .execute(&state.pools.main)
        .await
        .expect("insert access token");
        let response = call(&state, "GET", "/internal/merchant/payments", Some(&raw)).await;
        assert_eq!(response.status, 403);
        assert_eq!(response.body["code"], "API_TOKEN_SCOPE_VIOLATION");
        let response = call(
            &state,
            "GET",
            "/internal/merchant/external/payments/does-not-exist",
            Some(&raw),
        )
        .await;
        assert_eq!(response.status, 404);
        assert_eq!(response.body["code"], "PAYMENT_ATTEMPT_NOT_FOUND");
        sqlx::query("DELETE FROM access_tokens WHERE id = $1")
            .bind(token_id)
            .execute(&state.pools.main)
            .await
            .expect("delete token");

        delete_user(&state, scoped).await;
        delete_user(&state, unprivileged).await;
        delete_user(&state, staff).await;
    }

    #[tokio::test]
    async fn report_engine_reads_and_public_auth_status_answer() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let Some((merchant_id, _, _, _, _)) = populated_merchant(&state).await else {
            eprintln!("SKIP: no populated merchant");
            return;
        };

        // `auth/me` is public (registered before `requireAuthentication`).
        let response = call(&state, "GET", "/internal/merchant/auth/me", None).await;
        assert_eq!(response.status, 200);
        assert_eq!(response.body["platformName"], "Payment Gateway");
        assert_eq!(response.body["suspended"], false);
        assert!(response.body["communication"]["emailConfigured"].is_boolean());

        // A merchant admin holds `report_engine:author` through `merchant:write`.
        let admin = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_ADMIN",
            serde_json::json!(["merchant:write"]),
            serde_json::json!([]),
        )
        .await;
        let token = mint_session(
            admin,
            "MERCHANT_ADMIN",
            Some(merchant_id),
            &["merchant:write"],
            &[],
        );
        for path in [
            "/internal/merchant/report-engine/studio/specs",
            "/internal/merchant/report-engine/studio/needs-migration",
            "/internal/merchant/report-engine/studio/chrome",
            "/internal/merchant/report-engine/studio/chrome/needs-migration",
            "/internal/merchant/report-engine/studio/usage",
        ] {
            let response = call(&state, "GET", path, Some(&token)).await;
            assert_eq!(response.status, 200, "{path}: {:?}", response.body);
        }
        let response = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/studio/usage",
            Some(&token),
        )
        .await;
        assert_eq!(response.body["maxCodes"], 50);
        assert!(response.body["codes"].as_i64().is_some());

        // A staff member with `merchant:write` does not get the authoring line.
        let staff_writer = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_STAFF",
            serde_json::json!(["merchant:write"]),
            serde_json::json!([]),
        )
        .await;
        let token = mint_session(
            staff_writer,
            "MERCHANT_STAFF",
            Some(merchant_id),
            &["merchant:write"],
            &[],
        );
        let response = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/studio/specs",
            Some(&token),
        )
        .await;
        assert_eq!(response.status, 403);
        assert_eq!(response.body["code"], "AUTHORITY_REQUIRED");

        delete_user(&state, admin).await;
        delete_user(&state, staff_writer).await;
    }

    #[test]
    fn every_registered_route_is_a_get_with_a_policy_and_scope() {
        let all = routes();
        assert!(all.len() >= 38, "registered {} routes", all.len());
        for route in &all {
            assert_eq!(route.policy.method, "GET", "{}", route.key());
            assert_eq!(route.policy.channel, pg_http::Channel::Merchant);
            // `auth/me` is public; every other read is merchant-scoped.
            if route.policy.path != "/internal/merchant/auth/me" {
                assert_eq!(
                    route.policy.merchant_scope,
                    pg_http::ScopeRule::Required,
                    "{}",
                    route.key()
                );
            }
            assert!(!route.policy.ts_origin.trim().is_empty());
            if route.policy.path != "/internal/merchant/auth/me" {
                assert!(!route.policy.authorities.is_empty(), "{}", route.key());
            }
            assert!(matches!(route.handler, Handler::Custom(_)));
            // The policy must be satisfiable by at least one raw authority.
            let mut registry = pg_http::RouteRegistry::new();
            registry
                .register(route.policy.clone())
                .expect("unique policy");
        }
        // POST is not part of P4.
        assert!(all.iter().all(|route| route.policy.method != "POST"));
        // The list is unique.
        let mut keys: Vec<String> = all.iter().map(|route| route.key()).collect();
        let total = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), total, "duplicate mounted route");
    }

    #[test]
    fn body_rule_is_none_for_every_read() {
        for route in routes() {
            assert_eq!(
                route.policy.body,
                pg_http::BodyRule::None,
                "{}",
                route.key()
            );
        }
    }

    /// The route inventory is the contract: every `GET /internal/merchant/*` entry is mounted here
    /// (or by the shell for `/health`) or listed with its deferral reason in the module doc.
    #[test]
    fn every_inventory_merchant_get_is_mounted_or_deferred() {
        use std::collections::BTreeSet;

        // The inventory is a sibling of the crate inside `backend-rs/`.
        let inventory: Value = serde_json::from_str(include_str!(
            "../../../../tests/golden-vectors/route-inventory/routes.json"
        ))
        .expect("route inventory json");
        let inventory_paths: BTreeSet<String> = inventory
            .as_array()
            .expect("inventory array")
            .iter()
            .filter(|entry| entry["method"] == "GET")
            .filter_map(|entry| entry["fullPath"].as_str())
            .filter(|path| path.starts_with("/internal/merchant/"))
            .map(str::to_owned)
            .collect();
        assert_eq!(inventory_paths.len(), 49, "the P4-T02 inventory");

        let mut mounted: BTreeSet<String> = routes()
            .into_iter()
            .map(|route| route.policy.path)
            .collect();
        // The P3 shell mounts the channel health route.
        mounted.insert("/internal/merchant/health".to_owned());

        let deferred: BTreeSet<&str> = [
            // P7-T02: OAuth code exchange, ticket and cookie/session writes.
            "/internal/merchant/auth/google/callback",
            // P5-T08: Server-Sent Events with realtime fan-out.
            "/internal/merchant/pos/screens/:screenCode/stream",
        ]
        .into_iter()
        .collect();

        for path in &mounted {
            assert!(
                inventory_paths.contains(path),
                "{path} is mounted but not in the route inventory"
            );
        }
        for path in &inventory_paths {
            assert!(
                mounted.contains(path) || deferred.contains(path.as_str()),
                "{path} is neither mounted nor deferred with a reason"
            );
        }
        assert_eq!(
            mounted.len() + deferred.len(),
            inventory_paths.len(),
            "mounted and deferred must cover the inventory exactly"
        );
        assert_eq!(mounted.len(), 47, "P4-T02 mounts 46 reads plus /health");
        assert_eq!(
            deferred.len(),
            2,
            "only the OAuth callback and the SSE stream remain deferred"
        );
    }

    #[test]
    fn require_scope_helpers_are_exported_for_the_edge() {
        // `require_merchant_scope` is what the dispatcher and the edges share.
        let _ = json_ok(&serde_json::json!({ "ok": true }));
        assert!(require_merchant_session(None).is_err());
    }
    // -----------------------------------------------------------------------------------------
    // P4-T02 follow-up: catalog, autocomplete, transcripts, prompts and attachment bytes
    // -----------------------------------------------------------------------------------------

    const OLD_ENGINE: &str = "0.9.0";
    const SHA: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn merchant_spec_json(code: &str) -> Value {
        serde_json::json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "spec_version": "1.0",
            "report": {
                "code": code,
                "version": 1,
                "category": "MERCHANT_SETTLEMENT",
                "audience_scope": "MERCHANT_FACING",
                "merchant_scope_input_key": "merchantId",
                "classification": "MERCHANT_CONFIDENTIAL"
            },
            "page_layout": {
                "paper_size": "A4",
                "orientation": "PORTRAIT",
                "header_mode": "GLOBAL_DEFAULT",
                "footer_mode": "GLOBAL_DEFAULT"
            },
            "required_assets": [],
            "i18n": {
                "default_locale": "en",
                "prompt_user_when_multi_locale": true,
                "locales": {
                    "en": { "report.title": "Catalog test" },
                    "ar": { "report.title": "اختبار" }
                }
            },
            "inputs": [
                {
                    "key": "merchantId",
                    "label_i18n_key": "report.title",
                    "type": "entity_autocomplete",
                    "autocomplete": { "source": "merchants" }
                },
                {
                    "key": "periodRange",
                    "label_i18n_key": "report.title",
                    "type": "daterange",
                    "validation": { "max_range_days": 30 }
                }
            ],
            "datasets": [{
                "dataset_id": "daily",
                "description": "Daily totals",
                "from_model": "payment_attempts",
                "from_alias": "pa",
                "select": [{
                    "alias": "total",
                    "column": "total_charged_amount",
                    "expression": "COLUMN",
                    "aggregate": "SUM",
                    "format_hint": "CURRENCY_MINOR"
                }],
                "where": {
                    "kind": "GROUP",
                    "logic": "AND",
                    "conditions": [
                        {
                            "kind": "PREDICATE",
                            "column": "merchant_id",
                            "op": "eq",
                            "binding": { "source": "INPUT", "input_key": "merchantId" }
                        },
                        {
                            "kind": "PREDICATE",
                            "column": "created_at",
                            "op": "between",
                            "binding": { "source": "INPUT", "input_key": "periodRange", "range_bound": "BOTH" }
                        }
                    ]
                },
                "limit": 10
            }],
            "transforms": [],
            "sections": [{
                "section_id": "kpi",
                "section_type": "KPI_GRID",
                "title_i18n_key": "report.title",
                "columns": 2,
                "cards": [{
                    "label_i18n_key": "report.title",
                    "dataset_id": "daily",
                    "value_field": "total",
                    "format_hint": "CURRENCY_MINOR"
                }]
            }]
        })
    }

    fn chrome_spec_json(code: &str) -> Value {
        serde_json::json!({
            "spec_kind": "REPORT_CHROME",
            "spec_version": "1.0",
            "chrome": {
                "code": code,
                "name": "Test chrome",
                "chrome_type": "HEADER",
                "height_mm": 22,
                "show_on_first_page": true,
                "border_style": "THIN_RULE"
            },
            "required_assets": [],
            "i18n": { "default_locale": "en", "locales": { "en": {}, "ar": {} } },
            "template": { "html": "<div>test</div>", "scoped_css": "", "used_variables": [] }
        })
    }

    async fn insert_template_spec(state: &AppState, code: &str, engine: &str, user: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO report_definition_specs \
                (id, code, version, category, audience_scope, status, is_latest_published, \
                 supported_locales, default_locale, spec_json, spec_sha256, \
                 verification_report_json, created_by_user_id, created_at, updated_at, \
                 engine_version, spec_schema_version) \
             VALUES ($1, $2, 1, 'MERCHANT_SETTLEMENT', 'MERCHANT_FACING', 'PUBLISHED', true, \
                     ARRAY['en','ar'], 'en', $3::jsonb, $4, '{}'::jsonb, $5, now(), now(), $6, '1.0')",
        )
        .bind(id)
        .bind(code)
        .bind(merchant_spec_json(code))
        .bind(SHA)
        .bind(user)
        .bind(engine)
        .execute(&state.pools.main)
        .await
        .expect("insert template spec");
        id
    }

    async fn insert_merchant_spec(
        state: &AppState,
        merchant_id: Uuid,
        code: &str,
        version: i32,
        engine: &str,
        latest: bool,
        user: Uuid,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO merchant_report_specs \
                (id, merchant_id, code, version, category, status, is_latest_published, \
                 supported_locales, default_locale, spec_json, spec_sha256, \
                 verification_report_json, created_by_user_id, published_by_user_id, \
                 published_at, created_at, updated_at, engine_version, spec_schema_version) \
             VALUES ($1, $2, $3, $4, 'MERCHANT_SETTLEMENT', 'PUBLISHED', $5, \
                     ARRAY['en','ar'], 'en', $6::jsonb, $7, '{}'::jsonb, $8, $8, \
                     CASE WHEN $5 THEN now() ELSE NULL END, now(), now(), $9, '1.0')",
        )
        .bind(id)
        .bind(merchant_id)
        .bind(code)
        .bind(version)
        .bind(latest)
        .bind(merchant_spec_json(code))
        .bind(SHA)
        .bind(user)
        .bind(engine)
        .execute(&state.pools.main)
        .await
        .expect("insert merchant spec");
        id
    }

    async fn insert_chrome_default(
        state: &AppState,
        code: &str,
        chrome_type: &str,
        user: Uuid,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let mut spec = chrome_spec_json(code);
        spec["chrome"]["chrome_type"] = Value::String(chrome_type.to_owned());
        sqlx::query(
            "INSERT INTO report_chrome_specs \
                (id, code, version, name, chrome_type, status, is_default_global, \
                 supported_locales, spec_json, spec_sha256, created_by_user_id, \
                 published_by_user_id, published_at, created_at, updated_at, engine_version, \
                 spec_schema_version) \
             VALUES ($1, $2, 1, 'Test chrome', $3::\"ReportChromeType\", 'PUBLISHED', true, \
                     ARRAY['en','ar'], $4::jsonb, $5, $6, $6, now(), now(), now(), '1.0.0', '1.0')",
        )
        .bind(id)
        .bind(code)
        .bind(chrome_type)
        .bind(spec)
        .bind(SHA)
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("insert chrome default");
        id
    }

    async fn insert_merchant_chrome(
        state: &AppState,
        merchant_id: Uuid,
        code: &str,
        engine: &str,
        user: Uuid,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO merchant_report_chrome_specs \
                (id, merchant_id, code, version, name, chrome_type, status, \
                 is_default_for_merchant, supported_locales, spec_json, spec_sha256, \
                 created_by_user_id, created_at, updated_at, engine_version, spec_schema_version) \
             VALUES ($1, $2, $3, 1, 'Test chrome', 'HEADER'::\"ReportChromeType\", 'PUBLISHED', \
                     false, ARRAY['en','ar'], $4::jsonb, $5, $6, now(), now(), $7, '1.0')",
        )
        .bind(id)
        .bind(merchant_id)
        .bind(code)
        .bind(chrome_spec_json(code))
        .bind(SHA)
        .bind(user)
        .bind(engine)
        .execute(&state.pools.main)
        .await
        .expect("insert merchant chrome");
        id
    }

    async fn delete_report_fixtures(
        state: &AppState,
        merchant_id: Uuid,
        template_id: Uuid,
        spec_ids: &[Uuid],
        chrome_ids: &[Uuid],
        platform_chrome_ids: &[Uuid],
    ) {
        for id in chrome_ids {
            let _ = sqlx::query("DELETE FROM merchant_report_chrome_specs WHERE id = $1")
                .bind(id)
                .execute(&state.pools.main)
                .await;
        }
        for id in spec_ids {
            let _ =
                sqlx::query("DELETE FROM merchant_report_specs WHERE id = $1 AND merchant_id = $2")
                    .bind(id)
                    .bind(merchant_id)
                    .execute(&state.pools.main)
                    .await;
        }
        let _ = sqlx::query("DELETE FROM report_definition_specs WHERE id = $1")
            .bind(template_id)
            .execute(&state.pools.main)
            .await;
        for id in platform_chrome_ids {
            let _ = sqlx::query("DELETE FROM report_chrome_specs WHERE id = $1")
                .bind(id)
                .execute(&state.pools.main)
                .await;
        }
    }

    #[tokio::test]
    async fn catalog_autocomplete_transcripts_and_prompts_answer() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let Some((merchant_id, _, _, _, _)) = populated_merchant(&state).await else {
            eprintln!("SKIP: no populated merchant");
            return;
        };
        let user = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_ADMIN",
            serde_json::json!(["merchant:write"]),
            serde_json::json!([]),
        )
        .await;
        let token = mint_session(
            user,
            "MERCHANT_ADMIN",
            Some(merchant_id),
            &["merchant:write"],
            &[],
        );
        let suffix = Uuid::new_v4().simple().to_string();
        let template_code = format!("catalog-template-{suffix}");
        let own_code = format!("catalog-own-{suffix}");
        let old_code = format!("catalog-old-{suffix}");
        let chrome_old_code = format!("chrome-old-{suffix}");
        let chrome_ok_code = format!("chrome-ok-{suffix}");
        let header_code = format!("platform-header-{suffix}");
        let footer_code = format!("platform-footer-{suffix}");
        let template_id = insert_template_spec(&state, &template_code, "1.0.0", user).await;
        let own_id =
            insert_merchant_spec(&state, merchant_id, &own_code, 1, "1.0.0", true, user).await;
        let old_id =
            insert_merchant_spec(&state, merchant_id, &old_code, 1, OLD_ENGINE, false, user).await;
        let chrome_old =
            insert_merchant_chrome(&state, merchant_id, &chrome_old_code, OLD_ENGINE, user).await;
        let chrome_ok =
            insert_merchant_chrome(&state, merchant_id, &chrome_ok_code, "1.0.0", user).await;
        let header = insert_chrome_default(&state, &header_code, "HEADER", user).await;
        let footer = insert_chrome_default(&state, &footer_code, "FOOTER", user).await;

        // Catalog: the released template and the merchant's own published report.
        let catalog = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/catalog?search=catalog-&pageSize=50",
            Some(&token),
        )
        .await;
        assert_eq!(catalog.status, 200, "{:?}", catalog.body);
        let reports = catalog.body["reports"].as_array().expect("reports");
        let codes: Vec<&str> = reports
            .iter()
            .filter_map(|report| report["code"].as_str())
            .collect();
        assert!(
            codes.contains(&template_code.as_str()),
            "template missing: {codes:?}"
        );
        assert!(
            codes.contains(&own_code.as_str()),
            "own report missing: {codes:?}"
        );
        for report in reports {
            assert!(report["spec"].get("suggested_access").is_none());
            if let Some(datasets) = report["spec"]["datasets"].as_array() {
                for dataset in datasets {
                    assert!(dataset.get("from_model").is_none());
                    assert!(dataset.get("joins").is_none());
                }
            }
        }
        assert!(catalog.body["health"]["brokenChromeSpecs"]
            .as_i64()
            .is_some());

        // Autocomplete: the merchant-safe sources, and the staff sources are refused.
        let app_name: Option<String> =
            sqlx::query_scalar("SELECT name FROM applications WHERE merchant_id = $1 LIMIT 1")
                .bind(merchant_id)
                .fetch_optional(&state.pools.main)
                .await
                .expect("application name");
        if let Some(app_name) = app_name {
            let response = call(
                &state,
                "GET",
                &format!(
                    "/internal/merchant/report-engine/autocomplete/applications?q={}",
                    url::form_urlencoded::byte_serialize(app_name.as_bytes()).collect::<String>()
                ),
                Some(&token),
            )
            .await;
            assert_eq!(response.status, 200, "{:?}", response.body);
            assert!(response.body["items"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["label"] == app_name)));
        }
        let currencies = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/autocomplete/currencies?q=ly",
            Some(&token),
        )
        .await;
        assert_eq!(currencies.status, 200);
        assert_eq!(currencies.body["items"][0]["value"], "LYD");
        let forbidden = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/autocomplete/gateways",
            Some(&token),
        )
        .await;
        assert_eq!(forbidden.status, 403);
        assert_eq!(
            forbidden.body["code"],
            "MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED"
        );

        // The released transcripts (merchant mode, assets policy).
        let transcript = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/studio/transcript",
            Some(&token),
        )
        .await;
        assert_eq!(transcript.status, 200, "{:?}", transcript.body);
        assert_eq!(transcript.body["contentType"], "text/markdown");
        assert_eq!(
            transcript.body["filename"],
            "report-engine-ai-transcript-v1.1.md"
        );
        let markdown = transcript.body["markdown"].as_str().expect("markdown");
        assert!(markdown.starts_with(
            "# Libyan National Payment Gateway — Merchant Report Authoring Transcript (v1.1)"
        ));
        assert!(!markdown.contains(TEMPLATE_GENERATED_AT));
        let chrome_transcript = call(
            &state,
            "GET",
            "/internal/merchant/report-engine/studio/chrome/transcript",
            Some(&token),
        )
        .await;
        assert_eq!(
            chrome_transcript.status, 200,
            "{:?}",
            chrome_transcript.body
        );
        assert_eq!(
            chrome_transcript.body["filename"],
            "chrome-engine-ai-transcript-v1.1.md"
        );
        assert!(chrome_transcript.body["markdown"]
            .as_str()
            .is_some_and(|markdown| markdown.contains("Merchant Report Branding")));

        // Migration prompts: old specs prompt, compatible specs refuse with 409.
        let prompt = call(
            &state,
            "GET",
            &format!("/internal/merchant/report-engine/studio/specs/{old_id}/migration-prompt"),
            Some(&token),
        )
        .await;
        assert_eq!(prompt.status, 200, "{:?}", prompt.body);
        assert_eq!(
            prompt.body["filename"],
            format!("migrate-{old_code}-v1-to-engine-1.0.0.md")
        );
        assert!(prompt.body["prompt"]
            .as_str()
            .is_some_and(|value| value.starts_with("# Report Descriptor Migration")));
        assert!(prompt.body["prompt"]
            .as_str()
            .is_some_and(|value| value.contains("Target Authoring Transcript")));
        let not_migratable = call(
            &state,
            "GET",
            &format!("/internal/merchant/report-engine/studio/specs/{own_id}/migration-prompt"),
            Some(&token),
        )
        .await;
        assert_eq!(not_migratable.status, 409);
        assert_eq!(
            not_migratable.body["code"],
            "MERCHANT_REPORT_SPEC_NOT_MIGRATABLE"
        );
        let chrome_prompt = call(
            &state,
            "GET",
            &format!(
                "/internal/merchant/report-engine/studio/chrome/{chrome_old}/migration-prompt"
            ),
            Some(&token),
        )
        .await;
        assert_eq!(chrome_prompt.status, 200, "{:?}", chrome_prompt.body);
        assert!(chrome_prompt.body["prompt"]
            .as_str()
            .is_some_and(|value| value.starts_with("# Report Header/Footer Migration")));
        let chrome_not_migratable = call(
            &state,
            "GET",
            &format!("/internal/merchant/report-engine/studio/chrome/{chrome_ok}/migration-prompt"),
            Some(&token),
        )
        .await;
        assert_eq!(chrome_not_migratable.status, 409);
        assert_eq!(
            chrome_not_migratable.body["code"],
            "MERCHANT_REPORT_CHROME_NOT_MIGRATABLE"
        );

        delete_report_fixtures(
            &state,
            merchant_id,
            template_id,
            &[own_id, old_id],
            &[chrome_old, chrome_ok],
            &[header, footer],
        )
        .await;
        delete_user(&state, user).await;
    }

    static ATTACHMENT_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn purge_storage_fixture(state: &AppState, object_id: Uuid, attachment_id: Uuid) {
        let Ok(mut connection) = state.pools.main.acquire().await else {
            return;
        };
        let _ = sqlx::query("SET session_replication_role = replica")
            .execute(&mut *connection)
            .await;
        let _ = sqlx::query("DELETE FROM storage_object_access_logs WHERE object_id = $1")
            .bind(object_id)
            .execute(&mut *connection)
            .await;
        let _ = sqlx::query("DELETE FROM dispute_attachments WHERE id = $1")
            .bind(attachment_id)
            .execute(&mut *connection)
            .await;
        let _ = sqlx::query("DELETE FROM storage_object_locks WHERE object_id = $1")
            .bind(object_id)
            .execute(&mut *connection)
            .await;
        let _ = sqlx::query("DELETE FROM storage_objects WHERE id = $1")
            .bind(object_id)
            .execute(&mut *connection)
            .await;
        let _ = sqlx::query("SET session_replication_role = DEFAULT")
            .execute(&mut *connection)
            .await;
    }

    #[tokio::test]
    async fn dispute_attachment_content_decrypts_the_shared_vault() {
        use pg_objstore::blob_store::{BlobStore, BucketTier, FsBlobStore};
        use pg_objstore::pgos1::{seal_pgos1, KekKeyring};

        let Some(state) = state_or_skip().await else {
            return;
        };
        let dispute: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT d.id, a.merchant_id FROM disputes d \
             JOIN payment_attempts a ON a.id = d.attempt_id LIMIT 1",
        )
        .fetch_optional(&state.pools.main)
        .await
        .expect("dispute fixture");
        let Some((dispute_id, merchant_id)) = dispute else {
            eprintln!("SKIP: no dispute in the test database");
            return;
        };
        let _guard = ATTACHMENT_ENV_LOCK.lock().await;
        let previous_root = std::env::var("OBJECT_STORAGE_ROOT_DIR").ok();
        let previous_keyring = std::env::var("OBJECT_STORAGE_KEK_KEYRING").ok();
        let previous_daemon = std::env::var("OBJECT_STORAGE_DAEMON_URL").ok();
        let root = std::env::temp_dir().join(format!("pg-object-storage-test-{}", Uuid::new_v4()));
        std::env::set_var("OBJECT_STORAGE_ROOT_DIR", &root);
        std::env::set_var(
            "OBJECT_STORAGE_KEK_KEYRING",
            format!("v1:{}", "11".repeat(32)),
        );
        std::env::remove_var("OBJECT_STORAGE_DAEMON_URL");
        let keyring = KekKeyring::parse(
            "v1:1111111111111111111111111111111111111111111111111111111111111111",
            Some(1),
        )
        .expect("test keyring");

        let object_id = Uuid::new_v4();
        let attachment_id = Uuid::new_v4();
        let plaintext = b"the sealed evidence bytes";
        let (ciphertext, metadata) =
            seal_pgos1(object_id, plaintext, &keyring, None).expect("seal object");
        let store = FsBlobStore::new(root.clone()).await.expect("fs store");
        let storage_key = format!("dispute-evidence-test/{object_id}.bin");
        store
            .put(BucketTier::Hot, &storage_key, &ciphertext)
            .await
            .expect("write blob");

        let wrapped =
            super::object_storage::base64_decode(&metadata.wrapped_dek).expect("wrapped dek");
        let nonce = super::object_storage::base64_decode(&metadata.dek_nonce).expect("dek nonce");
        let prefix =
            super::object_storage::base64_decode(&metadata.stream_prefix).expect("stream prefix");
        sqlx::query(
            "INSERT INTO storage_objects \
                (id, bucket, namespace, storage_key, status, sha256_hex, byte_size, \
                 chunk_size_bytes, chunk_count, detected_mime_type, original_filename, \
                 kek_key_version, wrapped_dek, dek_nonce, stream_nonce_prefix, owner_merchant_id, \
                 uploaded_by_actor_type, uploaded_by_actor_id, required_authority, \
                 confidentiality_tier, metadata, staging_expires_at, activated_at, created_at, \
                 updated_at) \
             VALUES ($1, 'HOT', 'DISPUTE_EVIDENCE', $2, 'ACTIVE', $3, $4, $5, $6, 'image/png', \
                     'evidence.png', 1, $7, $8, $9, $10, 'MERCHANT_USER', $11, 'disputes:read', \
                     'CONFIDENTIAL', '{}'::jsonb, now(), now(), now(), now())",
        )
        .bind(object_id)
        .bind(&storage_key)
        .bind(&metadata.plaintext_sha256)
        .bind(plaintext.len() as i64)
        .bind(metadata.chunk_size as i32)
        .bind(metadata.chunk_count as i32)
        .bind(&wrapped)
        .bind(&nonce)
        .bind(&prefix)
        .bind(merchant_id)
        .bind(format!("merchant-read-test-{merchant_id}"))
        .execute(&state.pools.main)
        .await
        .expect("insert storage object");
        sqlx::query(
            "INSERT INTO storage_object_locks \
                (object_id, holder_type, holder_id, acquired_by_actor_id, acquired_reason) \
             VALUES ($1, 'DISPUTE_ATTACHMENT', $2, 'merchant-read-test', 'DISPUTE_EVIDENCE_UPLOAD')",
        )
        .bind(object_id)
        .bind(attachment_id.to_string())
        .execute(&state.pools.main)
        .await
        .expect("insert lock");
        sqlx::query(
            "INSERT INTO dispute_attachments \
                (id, dispute_id, merchant_id, storage_object_id, label, uploaded_by_id, created_at) \
             VALUES ($1, $2, $3, $4, 'evidence', 'merchant-read-test', now())",
        )
        .bind(attachment_id)
        .bind(dispute_id)
        .bind(merchant_id)
        .bind(object_id)
        .execute(&state.pools.main)
        .await
        .expect("insert attachment");

        let admin = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_ADMIN",
            serde_json::json!(["merchant:write"]),
            serde_json::json!([]),
        )
        .await;
        let admin_token = mint_session(
            admin,
            "MERCHANT_ADMIN",
            Some(merchant_id),
            &["merchant:write"],
            &[],
        );
        let path =
            format!("/internal/merchant/disputes/{dispute_id}/attachments/{attachment_id}/content");
        let response = call(&state, "GET", &path, Some(&admin_token)).await;
        assert_eq!(response.status, 200, "{:?}", response.body);
        // The JSON helper cannot read binary bodies; call the route again through a raw request.
        let request = test::TestRequest::default()
            .uri(&path)
            .header("authorization", format!("Bearer {admin_token}"))
            .to_http_request();
        let response =
            crate::app::dispatch(state.clone(), request, Payload(ntex::http::Payload::None)).await;
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("image/png")
        );
        assert_eq!(
            response
                .headers()
                .get("content-disposition")
                .and_then(|value| value.to_str().ok()),
            Some("attachment; filename=\"evidence.png\"")
        );
        assert_eq!(
            response
                .headers()
                .get("content-security-policy")
                .and_then(|value| value.to_str().ok()),
            Some("sandbox; default-src 'none'")
        );
        let body = ntex::web::test::read_body(response).await;
        assert_eq!(&body[..], plaintext);

        // A read-only user passes the route authority (payment:read) but not the
        // DISPUTE_EVIDENCE object authority (dispute:respond).
        let reader = insert_user(
            &state,
            Some(merchant_id),
            "MERCHANT_STAFF",
            serde_json::json!(["merchant:read"]),
            serde_json::json!([]),
        )
        .await;
        let reader_token = mint_session(
            reader,
            "MERCHANT_STAFF",
            Some(merchant_id),
            &["merchant:read"],
            &[],
        );
        let denied = call(&state, "GET", &path, Some(&reader_token)).await;
        assert_eq!(denied.status, 403);
        assert_eq!(denied.body["code"], "STORAGE_ACCESS_DENIED");

        purge_storage_fixture(&state, object_id, attachment_id).await;
        let _ = std::fs::remove_dir_all(&root);
        match previous_root {
            Some(value) => std::env::set_var("OBJECT_STORAGE_ROOT_DIR", value),
            None => std::env::remove_var("OBJECT_STORAGE_ROOT_DIR"),
        }
        match previous_keyring {
            Some(value) => std::env::set_var("OBJECT_STORAGE_KEK_KEYRING", value),
            None => std::env::remove_var("OBJECT_STORAGE_KEK_KEYRING"),
        }
        if let Some(value) = previous_daemon {
            std::env::set_var("OBJECT_STORAGE_DAEMON_URL", value);
        }
        delete_user(&state, admin).await;
        delete_user(&state, reader).await;
    }
}
