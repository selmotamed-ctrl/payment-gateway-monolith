//! Rail collections and rail detail.
//!
//! Ports `admin.ts:15854-16064` (`GET /rails`, `/rails/summary`, `/rails/:id`). The list joins the
//! rail fields and the per-rail route-health buckets, the two extra reads of the TS handler.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_http::ApiError;
use serde_json::{Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common;
use super::{
    build_page, col_bool, col_date, col_decimal, col_i32, col_i64, col_json, col_opt_decimal,
    col_opt_i32, col_opt_json, col_opt_text, col_opt_uuid, col_text, col_uuid, decimal_json,
    get_json, list_body, not_found, object, uuid_param,
};
use crate::state::AppState;

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "r.id", ColumnKind::Uuid)
        .with("code", "r.code", ColumnKind::Text)
        .with("nameEn", "r.name_en", ColumnKind::Text)
        .with("nameAr", "r.name_ar", ColumnKind::Text)
        .with(
            "collectionMode",
            "r.collection_mode::text",
            ColumnKind::Text,
        )
        .with("currency", "r.currency::text", ColumnKind::Text)
        .with("blocked", "r.blocked", ColumnKind::Bool)
        .with("minAmount", "r.min_amount", ColumnKind::Decimal)
        .with("displayOrder", "r.display_order", ColumnKind::Integer)
        .with("createdAt", "r.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "r.updated_at", ColumnKind::Timestamp)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["code", "nameEn", "nameAr"])
        .with_equals("collectionMode", "collectionMode")
        .with_equals("currency", "currency")
        .with_boolean("blocked", "blocked")
        .with_range(RangeFilter::new("amount", "minAmount", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("code", "code")
        .with_sortable("nameEn", "nameEn")
        .with_sortable("collectionMode", "collectionMode")
        .with_sortable("currency", "currency")
        .with_sortable("status", "blocked")
        .with_default_sort("displayOrder", SortDirection::Asc)
}

const RAIL_FROM: &str = "rails r";

const RAIL_COLUMNS: &[&str] = &[
    "r.id",
    "r.created_at",
    "r.updated_at",
    "r.code",
    "r.name_ar",
    "r.name_en",
    "r.logo_asset_id",
    "r.collection_mode::text AS collection_mode",
    "r.sub_modes",
    "r.currency::text AS currency",
    "r.min_amount",
    "r.max_amount",
    "r.display_order",
    "r.blocked",
    "r.capabilities",
    "r.refund_window_days",
    "r.instructions_ar",
    "r.instructions_en",
    "r.help_guide_json",
    "r.metadata",
    "(SELECT count(*) FROM rail_routes x WHERE x.rail_id = r.id) AS route_count",
    "(SELECT count(*) FROM flows x WHERE x.rail_id = r.id) AS flow_count",
    "(SELECT count(*) FROM payment_attempts x WHERE x.rail_id = r.id) AS payment_attempt_count",
];

pub(super) fn rail_field(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("createdAt", Value::String(col_date(row, "created_at")?)),
        ("updatedAt", Value::String(col_date(row, "updated_at")?)),
        ("railId", Value::String(col_uuid(row, "rail_id")?)),
        ("key", Value::String(col_text(row, "key")?)),
        ("type", Value::String(col_text(row, "type")?)),
        ("checksum", Value::String(col_text(row, "checksum")?)),
        ("labelAr", Value::String(col_text(row, "label_ar")?)),
        ("labelEn", Value::String(col_text(row, "label_en")?)),
        (
            "placeholderAr",
            col_opt_text(row, "placeholder_ar")?.map_or(Value::Null, Value::String),
        ),
        (
            "placeholderEn",
            col_opt_text(row, "placeholder_en")?.map_or(Value::Null, Value::String),
        ),
        (
            "regex",
            col_opt_text(row, "regex")?.map_or(Value::Null, Value::String),
        ),
        (
            "minLength",
            col_opt_i32(row, "min_length")?.map_or(Value::Null, Value::from),
        ),
        (
            "maxLength",
            col_opt_i32(row, "max_length")?.map_or(Value::Null, Value::from),
        ),
        ("minVal", decimal_json(col_opt_decimal(row, "min_val")?)),
        ("maxVal", decimal_json(col_opt_decimal(row, "max_val")?)),
        (
            "optionsJson",
            col_opt_json(row, "options_json")?.unwrap_or(Value::Null),
        ),
        ("required", Value::Bool(col_bool(row, "required")?)),
        ("orderIndex", Value::from(col_i32(row, "order_index")?)),
        ("sensitivity", Value::String(col_text(row, "sensitivity")?)),
        (
            "normalizer",
            col_opt_json(row, "normalizer")?.unwrap_or(Value::Null),
        ),
    ]))
}

const FIELD_COLUMNS: &str = "id, created_at, updated_at, rail_id, key, type::text AS type,
    checksum::text AS checksum, label_ar, label_en, placeholder_ar, placeholder_en, regex,
    min_length, max_length, min_val, max_val, options_json, required, order_index,
    sensitivity::text AS sensitivity, normalizer";

async fn fields_for(
    state: &AppState,
    ids: &[Uuid],
) -> Result<std::collections::BTreeMap<String, Vec<Value>>, ApiError> {
    let mut grouped: std::collections::BTreeMap<String, Vec<Value>> =
        std::collections::BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let sql = format!(
        "SELECT {FIELD_COLUMNS} FROM rail_fields WHERE rail_id = ANY($1) ORDER BY rail_id, order_index ASC, id ASC"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    for row in rows {
        let rail_id = col_uuid(&row, "rail_id")?;
        grouped.entry(rail_id).or_default().push(rail_field(&row)?);
    }
    Ok(grouped)
}

async fn health_for(
    state: &AppState,
    ids: &[Uuid],
) -> Result<std::collections::BTreeMap<String, (i64, i64, i64, i64)>, ApiError> {
    let mut grouped: std::collections::BTreeMap<String, (i64, i64, i64, i64)> =
        std::collections::BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT rail_id, health_state::text AS health_state, status::text AS status, count(*) AS count
           FROM rail_routes
          WHERE rail_id = ANY($1)
          GROUP BY rail_id, health_state, status",
    )
    .bind(ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    for row in rows {
        let rail_id = col_uuid(&row, "rail_id")?;
        let state = col_text(&row, "health_state")?;
        let status = col_text(&row, "status")?;
        let count = col_i64(&row, "count")?;
        let entry = grouped.entry(rail_id).or_insert((0, 0, 0, 0));
        match state.as_str() {
            "HEALTHY" => entry.0 += count,
            "DEGRADED" => entry.1 += count,
            "OPEN_BREAKER" => entry.2 += count,
            _ => {}
        }
        if status == "ACTIVE" {
            entry.3 += count;
        }
    }
    Ok(grouped)
}

pub(super) fn rail_scalars(row: &sqlx::postgres::PgRow) -> Result<Map<String, Value>, ApiError> {
    let mut map = Map::new();
    map.insert("id".to_owned(), Value::String(col_uuid(row, "id")?));
    map.insert(
        "createdAt".to_owned(),
        Value::String(col_date(row, "created_at")?),
    );
    map.insert(
        "updatedAt".to_owned(),
        Value::String(col_date(row, "updated_at")?),
    );
    map.insert("code".to_owned(), Value::String(col_text(row, "code")?));
    map.insert(
        "nameAr".to_owned(),
        Value::String(col_text(row, "name_ar")?),
    );
    map.insert(
        "nameEn".to_owned(),
        Value::String(col_text(row, "name_en")?),
    );
    map.insert(
        "logoAssetId".to_owned(),
        col_opt_uuid(row, "logo_asset_id")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "collectionMode".to_owned(),
        Value::String(col_text(row, "collection_mode")?),
    );
    map.insert(
        "subModes".to_owned(),
        col_opt_json(row, "sub_modes")?.unwrap_or(Value::Null),
    );
    map.insert(
        "currency".to_owned(),
        Value::String(col_text(row, "currency")?),
    );
    map.insert(
        "minAmount".to_owned(),
        decimal_json(Some(col_decimal(row, "min_amount")?)),
    );
    map.insert(
        "maxAmount".to_owned(),
        decimal_json(col_opt_decimal(row, "max_amount")?),
    );
    map.insert(
        "displayOrder".to_owned(),
        Value::from(col_i32(row, "display_order")?),
    );
    map.insert("blocked".to_owned(), Value::Bool(col_bool(row, "blocked")?));
    map.insert("capabilities".to_owned(), col_json(row, "capabilities")?);
    map.insert(
        "refundWindowDays".to_owned(),
        col_opt_i32(row, "refund_window_days")?.map_or(Value::Null, Value::from),
    );
    map.insert(
        "instructionsAr".to_owned(),
        col_opt_text(row, "instructions_ar")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "instructionsEn".to_owned(),
        col_opt_text(row, "instructions_en")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "helpGuideJson".to_owned(),
        col_opt_json(row, "help_guide_json")?.unwrap_or(Value::Null),
    );
    map.insert(
        "metadata".to_owned(),
        col_opt_json(row, "metadata")?.unwrap_or(Value::Null),
    );
    Ok(map)
}

get_json!(list, rail_list);
async fn rail_list(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let built = build_page(request, &spec(), &columns())?;
    let sql = built.select_sql(RAIL_FROM, RAIL_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let total: i64 = built
        .bind_count(&built.count_sql(RAIL_FROM))
        .fetch_one(&state.pools.main)
        .await
        .map(|row| row.get::<i64, _>(0))
        .map_err(common::database_error)?;
    let ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("id").ok())
        .collect();
    let mut fields = fields_for(state, &ids).await?;
    let health = health_for(state, &ids).await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = col_uuid(row, "id")?;
        let rail_fields = fields.remove(&id).unwrap_or_default();
        let field_count = rail_fields.len() as i64;
        let route_count = col_i64(row, "route_count")?;
        let flow_count = col_i64(row, "flow_count")?;
        let payment_attempt_count = col_i64(row, "payment_attempt_count")?;
        let (healthy, degraded, open_breaker, active) =
            health.get(&id).copied().unwrap_or((0, 0, 0, 0));
        let mut map = rail_scalars(row)?;
        map.insert("fields".to_owned(), Value::Array(rail_fields));
        map.insert(
            "_count".to_owned(),
            object(vec![
                ("routes", Value::from(route_count)),
                ("flows", Value::from(flow_count)),
                ("paymentAttempts", Value::from(payment_attempt_count)),
            ]),
        );
        map.insert("fieldCount".to_owned(), Value::from(field_count));
        map.insert("routeCount".to_owned(), Value::from(route_count));
        map.insert("flowCount".to_owned(), Value::from(flow_count));
        map.insert(
            "paymentAttemptCount".to_owned(),
            Value::from(payment_attempt_count),
        );
        map.insert(
            "routeHealth".to_owned(),
            object(vec![
                ("healthy", Value::from(healthy)),
                ("degraded", Value::from(degraded)),
                ("openBreaker", Value::from(open_breaker)),
                ("active", Value::from(active)),
            ]),
        );
        items.push(Value::Object(map));
    }
    Ok(list_body("rails", items, total, &built))
}

get_json!(summary, rail_summary);
async fn rail_summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let (total, blocked, mode_rows, health_rows) = tokio::try_join!(
        scalar_count(state, "SELECT count(*) FROM rails"),
        scalar_count(state, "SELECT count(*) FROM rails WHERE blocked = true"),
        string_count_rows(
            state,
            "SELECT collection_mode::text AS key, count(*) AS count FROM rails GROUP BY collection_mode"
        ),
        string_count_rows(
            state,
            "SELECT health_state::text AS key, count(*) AS count FROM rail_routes GROUP BY health_state"
        ),
    )?;
    let mut by_mode = Map::new();
    for (key, value) in &mode_rows {
        by_mode.insert(key.clone(), Value::from(*value));
    }
    Ok(object(vec![
        ("total", Value::from(total)),
        ("active", Value::from(total - blocked)),
        ("blocked", Value::from(blocked)),
        ("byMode", Value::Object(by_mode)),
        (
            "routes",
            object(vec![
                (
                    "healthy",
                    Value::from(health_rows.get("HEALTHY").copied().unwrap_or(0)),
                ),
                (
                    "degraded",
                    Value::from(health_rows.get("DEGRADED").copied().unwrap_or(0)),
                ),
                (
                    "openBreaker",
                    Value::from(health_rows.get("OPEN_BREAKER").copied().unwrap_or(0)),
                ),
            ]),
        ),
    ]))
}

async fn scalar_count(state: &AppState, sql: &'static str) -> Result<i64, ApiError> {
    sqlx::query(sql)
        .fetch_one(&state.pools.main)
        .await
        .map(|row| row.get::<i64, _>(0))
        .map_err(common::database_error)
}

async fn string_count_rows(
    state: &AppState,
    sql: &'static str,
) -> Result<std::collections::BTreeMap<String, i64>, ApiError> {
    let rows = sqlx::query(sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let mut counts = std::collections::BTreeMap::new();
    for row in rows {
        counts.insert(col_text(&row, "key")?, col_i64(&row, "count")?);
    }
    Ok(counts)
}

get_json!(detail, rail_detail);
async fn rail_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 0)?;
    let row = sqlx::query(
        "SELECT id, created_at, updated_at, code, name_ar, name_en, logo_asset_id,
                collection_mode::text AS collection_mode, sub_modes, currency::text AS currency,
                min_amount, max_amount, display_order, blocked, capabilities, refund_window_days,
                instructions_ar, instructions_en, help_guide_json, metadata
           FROM rails
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| not_found("RAIL_NOT_FOUND", "The rail does not exist"))?;

    let fields = sqlx::query(
        "SELECT id, created_at, updated_at, rail_id, key, type::text AS type,
                checksum::text AS checksum, label_ar, label_en, placeholder_ar, placeholder_en,
                regex, min_length, max_length, min_val, max_val, options_json, required,
                order_index, sensitivity::text AS sensitivity, normalizer
           FROM rail_fields
          WHERE rail_id = $1
          ORDER BY order_index ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let routes = sqlx::query(
        "SELECT id, created_at, updated_at, rail_id, gateway_id, credential_policy::text AS credential_policy,
                priority, routing_strategy::text AS routing_strategy, weight, cost_model,
                mismatch_policy, min_amount, max_amount, daily_cap_amount, status::text AS status,
                health_state::text AS health_state, health_computed_state::text AS health_computed_state,
                health_computed_reason, health_computed_at, health_override_state::text AS health_override_state,
                health_override_reason, health_override_set_at, health_override_set_by,
                health_override_expires_at, health_override_approval_id, health_reason,
                health_changed_at, health_consecutive_failures, health_probe_successes,
                health_probe_failures, health_last_probe_at, health_next_probe_at,
                maintenance_windows, scope
           FROM rail_routes
          WHERE rail_id = $1
          ORDER BY priority DESC, created_at ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;

    let mut rail = rail_scalars(&row)?;
    let mut field_items = Vec::with_capacity(fields.len());
    for field in &fields {
        field_items.push(rail_field(field)?);
    }
    rail.insert("fields".to_owned(), Value::Array(field_items));
    let mut route_items = Vec::with_capacity(routes.len());
    for route in &routes {
        route_items.push(Value::Object(super::route_health::route_scalars(route)?));
    }
    rail.insert("routes".to_owned(), Value::Array(route_items));
    Ok(object(vec![("rail", Value::Object(rail))]))
}
