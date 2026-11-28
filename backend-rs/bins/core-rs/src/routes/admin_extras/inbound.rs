//! Inbound provider events: the admin list and the redacted event detail.
//!
//! Ports `adminOperations.ts:266` (`GET /inbound-events`) and `adminOperations.ts:336`
//! (`GET /inbound-events/:id`). The list applies the TS filters (`gatewayId`, `verified`,
//! `unmatchedOnly`, free search over the text columns and the three id columns), the
//! `receivedAt` date range and the keyset/list contract. `rawBodyBytes` is never selected by the
//! list; the detail reads it only to render the same 2 KB redacted preview, size and SHA-256 the
//! TS handler returns, and never echoes the raw body.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_domain_auth::Principal;
use serde_json::{Map, Value};
use sqlx::Row;
use uuid::Uuid;

use pg_http::ApiError;

use crate::state::AppState;

use super::support::{
    build_page_from, col_bool, col_char, col_date, col_opt_date, col_opt_text, col_text, col_uuid,
    database_error, list_body, object, query_string, query_without, uuid_path_param,
};

const BODY_PREVIEW_BYTES: usize = 2048;
const BODY_PARSE_LIMIT: usize = 256 * 1024;

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "e.id", ColumnKind::Uuid)
        .with("gatewayId", "e.gateway_id", ColumnKind::Uuid)
        .with("verified", "e.verified", ColumnKind::Bool)
        .with("receivedAt", "e.received_at", ColumnKind::Timestamp)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_date(DateFilter::new("receivedAt", "receivedAt").with_keys("from", "to"))
        .with_sortable("receivedAt", "receivedAt")
        .with_sortable("verified", "verified")
        .with_sortable("gatewayId", "gatewayId")
        .with_default_sort("receivedAt", SortDirection::Desc)
        .with_default_page_size(25.0)
        .with_keyset_field("receivedAt")
}

/// `booleanFilter`: only the exact strings `true`/`false` are accepted.
fn boolean_filter(request: &HttpRequest, key: &str) -> Result<Option<bool>, ApiError> {
    match query_string(request, key).as_deref() {
        None => Ok(None),
        Some("true") => Ok(Some(true)),
        Some("false") => Ok(Some(false)),
        Some(_) => Err(ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{key}' filter is invalid"),
        )),
    }
}

/// `uuidListFilter`: comma separated UUIDs; anything else is `400 INVALID_FILTER`.
fn uuid_list_filter(request: &HttpRequest, key: &str) -> Result<Option<Vec<String>>, ApiError> {
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

/// `UUID` shape test used by `searchClause`.
fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value.trim()).is_ok()
}

fn inbound_item(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("receivedAt", Value::String(col_date(row, "received_at")?)),
        ("gatewayId", Value::String(col_uuid(row, "gateway_id")?)),
        (
            "gateway",
            object(vec![
                ("id", Value::String(col_uuid(row, "gateway_id")?)),
                ("code", Value::String(col_text(row, "gateway_code")?)),
                ("name", Value::String(col_text(row, "gateway_name")?)),
            ]),
        ),
        ("channelId", Value::String(col_uuid(row, "channel_id")?)),
        ("env", Value::String(col_char(row, "env")?)),
        ("sourceIp", Value::String(col_text(row, "source_ip")?)),
        ("verified", Value::Bool(col_bool(row, "verified")?)),
        (
            "verificationError",
            col_opt_text(row, "verification_error")?.map_or(Value::Null, Value::String),
        ),
        (
            "attemptId",
            row.try_get::<Option<Uuid>, _>("attempt_id")
                .map_err(database_error)?
                .map_or(Value::Null, |value| Value::String(value.to_string())),
        ),
        (
            "processedAt",
            col_opt_date(row, "processed_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "processingResult",
            col_opt_text(row, "processing_result")?.map_or(Value::Null, Value::String),
        ),
        ("dedupeKey", Value::String(col_char(row, "dedupe_key")?)),
    ]))
}

/// `GET /internal/admin/inbound-events` (`adminOperations.ts:266`).
pub(crate) async fn list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let gateway_ids = uuid_list_filter(request, "gatewayId")?;
    let verified = boolean_filter(request, "verified")?;
    let unmatched_only = boolean_filter(request, "unmatchedOnly")?;
    let search = query_string(request, "search");
    let map = query_without(
        request,
        &["search", "gatewayId", "verified", "unmatchedOnly"],
    );
    let built = build_page_from(&map, &spec(), &columns())?;

    let mut predicates: Vec<String> = Vec::new();
    let mut binds: Vec<InboundBind> = Vec::new();
    if let Some(ids) = &gateway_ids {
        binds.push(InboundBind::Texts(ids.clone()));
        predicates.push(format!(
            "e.gateway_id::text = ANY(${}::text[])",
            binds.len()
        ));
    }
    if let Some(flag) = verified {
        binds.push(InboundBind::Bool(flag));
        predicates.push(format!("e.verified = ${}", binds.len()));
    }
    if unmatched_only == Some(true) {
        predicates.push("e.attempt_id IS NULL".to_owned());
    }
    if let Some(text) = &search {
        let mut parts: Vec<String> = Vec::new();
        for column in [
            "e.source_ip",
            "e.verification_error",
            "e.processing_result",
            "e.dedupe_key",
        ] {
            binds.push(InboundBind::Text(format!("%{text}%")));
            parts.push(format!("{column} ILIKE ${}", binds.len()));
        }
        if is_uuid(text) {
            for column in ["e.id", "e.attempt_id", "e.gateway_id"] {
                binds.push(InboundBind::Text(text.trim().to_owned()));
                parts.push(format!("{column}::text = ${}", binds.len()));
            }
        }
        if parts.is_empty() {
            // A query that cannot match any column must match nothing, not everything.
            predicates.push("false".to_owned());
        } else {
            predicates.push(format!("({})", parts.join(" OR ")));
        }
    }

    let mut where_sql = built.where_sql.clone();
    for predicate in &predicates {
        if where_sql.is_empty() {
            where_sql = format!("WHERE {predicate}");
        } else {
            where_sql = format!("{where_sql} AND {predicate}");
        }
    }
    let offset_index = built.binds.len() + binds.len() + 1;
    let sql = format!(
        "SELECT e.id, e.received_at, e.gateway_id, g.code AS gateway_code, g.name AS gateway_name,
                e.channel_id, e.env, e.source_ip, e.verified, e.verification_error, e.attempt_id,
                e.processed_at, e.processing_result, e.dedupe_key
           FROM inbound_events e
           JOIN gateways g ON g.id = e.gateway_id
           {where_sql}
          ORDER BY {}
          LIMIT ${offset_index} OFFSET ${}",
        built.order_by_sql,
        offset_index + 1
    );
    let mut query = super::support::bind_where(&sql, &built);
    for bind in &binds {
        query = match bind {
            InboundBind::Text(value) => query.bind(value.as_str()),
            InboundBind::Bool(value) => query.bind(*value),
            InboundBind::Texts(values) => query.bind(values.clone()),
        };
    }
    let rows = query
        .bind(built.take)
        .bind(built.skip)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let items = rows
        .iter()
        .map(inbound_item)
        .collect::<Result<Vec<_>, _>>()?;

    // `countUnlessSkipped` replays the same WHERE without pagination.
    let total = if built.include_total {
        let count_sql = format!(
            "SELECT count(*) FROM inbound_events e JOIN gateways g ON g.id = e.gateway_id {where_sql}"
        );
        let mut count_query = super::support::bind_where(&count_sql, &built);
        for bind in &binds {
            count_query = match bind {
                InboundBind::Text(value) => count_query.bind(value.as_str()),
                InboundBind::Bool(value) => count_query.bind(*value),
                InboundBind::Texts(values) => count_query.bind(values.clone()),
            };
        }
        Some(
            count_query
                .fetch_one(&state.pools.main)
                .await
                .map_err(database_error)?
                .get::<i64, _>(0),
        )
    } else {
        None
    };
    Ok(list_body("inboundEvents", items, total, &built))
}

enum InboundBind {
    Text(String),
    Bool(bool),
    Texts(Vec<String>),
}

/// `GET /internal/admin/inbound-events/:id` (`adminOperations.ts:336`).
pub(crate) async fn detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = uuid_path_param(
        request,
        1,
        "INBOUND_EVENT_NOT_FOUND",
        "The inbound event does not exist",
    )?;
    let row = sqlx::query(
        "SELECT e.id, e.received_at, e.gateway_id, g.code AS gateway_code, g.name AS gateway_name,
                e.channel_id, e.env, e.source_ip, e.verified, e.verification_error, e.attempt_id,
                e.processed_at, e.processing_result, e.dedupe_key,
                e.redacted_headers_json, e.raw_body_bytes
           FROM inbound_events e
           JOIN gateways g ON g.id = e.gateway_id
          WHERE e.id = $1::uuid",
    )
    .bind(&id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "INBOUND_EVENT_NOT_FOUND",
            "The inbound event does not exist",
        )
    })?;
    let body: Vec<u8> = row.try_get("raw_body_bytes").map_err(database_error)?;
    let headers: Value = row
        .try_get("redacted_headers_json")
        .map_err(database_error)?;
    let mut value = inbound_item(&row)?.as_object().cloned().unwrap_or_default();
    value.insert(
        "redactedHeaders".to_owned(),
        pg_crypto::redact_payload(&pg_types::js_object_order(&headers), &[]),
    );
    value.insert(
        "bodyPreview".to_owned(),
        Value::String(redacted_body_preview(&body)),
    );
    value.insert("bodySize".to_owned(), Value::from(body.len()));
    value.insert(
        "bodySha256".to_owned(),
        Value::String(pg_crypto::sha256_hex(&body)),
    );
    Ok(Value::Object(value))
}

/// The exact TS preview: JSON/form bodies are redacted field by field, anything else by text.
fn redacted_body_preview(raw: &[u8]) -> String {
    let parse_bytes = raw.len().min(BODY_PARSE_LIMIT);
    let text = String::from_utf8_lossy(&raw[..parse_bytes]).into_owned();
    let trimmed = text.trim_start();
    let mut rendered: Option<String> = None;
    if raw.len() <= BODY_PARSE_LIMIT && (trimmed.starts_with('{') || trimmed.starts_with('[')) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            rendered = Some(pg_crypto::redact_payload(&value, &[]).to_string());
        }
    }
    if rendered.is_none() && raw.len() <= BODY_PARSE_LIMIT && looks_form_encoded(trimmed) {
        let mut fields = Map::new();
        for (key, value) in url::form_urlencoded::parse(text.as_bytes()) {
            fields.insert(key.into_owned(), Value::String(value.into_owned()));
        }
        rendered = Some(pg_crypto::redact_payload(&Value::Object(fields), &[]).to_string());
    }
    let rendered = rendered.unwrap_or_else(|| {
        let preview = &raw[..raw.len().min(BODY_PREVIEW_BYTES)];
        pg_crypto::redact_text(&String::from_utf8_lossy(preview), &[])
    });
    let capped = &rendered.as_bytes()[..rendered.len().min(BODY_PREVIEW_BYTES)];
    String::from_utf8_lossy(capped).into_owned()
}

/// `/^[^\s{<][^\n]*=/` on the trimmed body.
fn looks_form_encoded(trimmed: &str) -> bool {
    let mut characters = trimmed.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if first.is_whitespace() || matches!(first, '{' | '<') {
        return false;
    }
    !trimmed.contains('\n') && trimmed.contains('=')
}
