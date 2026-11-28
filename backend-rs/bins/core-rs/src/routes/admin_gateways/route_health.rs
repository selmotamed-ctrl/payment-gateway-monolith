//! Route collection, route detail and the route-health read.
//!
//! Ports `admin.ts:16299-16636` (`GET /routes`, `/routes/summary`, `/routes/:id`,
//! `/routes/:id/health`). The list applies the lazy override expiry exactly like
//! `effectiveRouteHealth` (`healthOverrideState` wins while unexpired, else the computed state), so
//! an expired override never hides a healthy or broken route from an operator.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common;
use super::{
    build_page, col_date, col_decimal, col_i32, col_i64, col_json, col_opt_date, col_opt_decimal,
    col_opt_i32, col_opt_json, col_opt_text, col_opt_uuid, col_text, col_uuid, decimal_json,
    get_json, list_body, not_found, object, uuid_param,
};
use crate::state::AppState;

const ROUTE_COLUMNS: &[&str] = &[
    "rr.id",
    "rr.created_at",
    "rr.updated_at",
    "rr.rail_id",
    "rr.gateway_id",
    "rr.credential_policy::text AS credential_policy",
    "rr.priority",
    "rr.routing_strategy::text AS routing_strategy",
    "rr.weight",
    "rr.cost_model",
    "rr.mismatch_policy",
    "rr.min_amount",
    "rr.max_amount",
    "rr.daily_cap_amount",
    "rr.status::text AS status",
    "rr.health_state::text AS health_state",
    "rr.health_computed_state::text AS health_computed_state",
    "rr.health_computed_reason",
    "rr.health_computed_at",
    "rr.health_override_state::text AS health_override_state",
    "rr.health_override_reason",
    "rr.health_override_set_at",
    "rr.health_override_set_by",
    "rr.health_override_expires_at",
    "rr.health_override_approval_id",
    "rr.health_reason",
    "rr.health_changed_at",
    "rr.health_consecutive_failures",
    "rr.health_probe_successes",
    "rr.health_probe_failures",
    "rr.health_last_probe_at",
    "rr.health_next_probe_at",
    "rr.maintenance_windows",
    "rr.scope",
    "r.code AS rail_code",
    "r.name_en AS rail_name",
    "g.code AS gateway_code",
    "g.name AS gateway_name",
];

const ROUTE_FROM: &str = "rail_routes rr
    JOIN rails r ON r.id = rr.rail_id
    JOIN gateways g ON g.id = rr.gateway_id";

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "rr.id", ColumnKind::Uuid)
        .with("rail.code", "r.code", ColumnKind::Text)
        .with("gateway.code", "g.code", ColumnKind::Text)
        .with("railId", "rr.rail_id", ColumnKind::Uuid)
        .with("gatewayId", "rr.gateway_id", ColumnKind::Uuid)
        .with(
            "credentialPolicy",
            "rr.credential_policy::text",
            ColumnKind::Text,
        )
        .with("priority", "rr.priority", ColumnKind::Integer)
        .with("status", "rr.status::text", ColumnKind::Text)
        .with("healthState", "rr.health_state::text", ColumnKind::Text)
        .with("minAmount", "rr.min_amount", ColumnKind::Decimal)
        .with("createdAt", "rr.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "rr.updated_at", ColumnKind::Timestamp)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["rail.code", "gateway.code"])
        .with_in("status", "status")
        .with_equals("railId", "railId")
        .with_equals("gatewayId", "gatewayId")
        .with_equals("credentialPolicy", "credentialPolicy")
        .with_equals("healthState", "healthState")
        .with_range(RangeFilter::new("amount", "minAmount", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("railCode", "railId")
        .with_sortable("gatewayCode", "gatewayId")
        .with_sortable("priority", "priority")
        .with_sortable("status", "status")
        .with_sortable("healthState", "healthState")
        .with_sortable("minAmount", "minAmount")
        .with_default_sort("priority", SortDirection::Asc)
        .with_default_sort("createdAt", SortDirection::Desc)
}

/// Every `rail_routes` scalar, in Prisma's select order. List callers override `healthState`
/// with the effective value afterwards.
pub(super) fn route_scalars(row: &sqlx::postgres::PgRow) -> Result<Map<String, Value>, ApiError> {
    let mut map = Map::new();
    let entries = vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("createdAt", Value::String(col_date(row, "created_at")?)),
        ("updatedAt", Value::String(col_date(row, "updated_at")?)),
        ("railId", Value::String(col_uuid(row, "rail_id")?)),
        ("gatewayId", Value::String(col_uuid(row, "gateway_id")?)),
        (
            "credentialPolicy",
            Value::String(col_text(row, "credential_policy")?),
        ),
        ("priority", Value::from(col_i32(row, "priority")?)),
        (
            "routingStrategy",
            Value::String(col_text(row, "routing_strategy")?),
        ),
        ("weight", Value::from(col_i32(row, "weight")?)),
        ("costModel", col_json(row, "cost_model")?),
        ("mismatchPolicy", col_json(row, "mismatch_policy")?),
        (
            "minAmount",
            decimal_json(Some(col_decimal(row, "min_amount")?)),
        ),
        (
            "maxAmount",
            decimal_json(col_opt_decimal(row, "max_amount")?),
        ),
        (
            "dailyCapAmount",
            decimal_json(col_opt_decimal(row, "daily_cap_amount")?),
        ),
        ("status", Value::String(col_text(row, "status")?)),
        ("healthState", Value::String(col_text(row, "health_state")?)),
        (
            "healthComputedState",
            Value::String(col_text(row, "health_computed_state")?),
        ),
        (
            "healthComputedReason",
            col_opt_text(row, "health_computed_reason")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthComputedAt",
            col_opt_date(row, "health_computed_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthOverrideState",
            col_opt_text(row, "health_override_state")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthOverrideReason",
            col_opt_text(row, "health_override_reason")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthOverrideSetAt",
            col_opt_date(row, "health_override_set_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthOverrideSetBy",
            col_opt_uuid(row, "health_override_set_by")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthOverrideExpiresAt",
            col_opt_date(row, "health_override_expires_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthOverrideApprovalId",
            col_opt_uuid(row, "health_override_approval_id")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthReason",
            col_opt_text(row, "health_reason")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthChangedAt",
            col_opt_date(row, "health_changed_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthConsecutiveFailures",
            Value::from(col_i32(row, "health_consecutive_failures")?),
        ),
        (
            "healthProbeSuccesses",
            Value::from(col_i32(row, "health_probe_successes")?),
        ),
        (
            "healthProbeFailures",
            Value::from(col_i32(row, "health_probe_failures")?),
        ),
        (
            "healthLastProbeAt",
            col_opt_date(row, "health_last_probe_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "healthNextProbeAt",
            col_opt_date(row, "health_next_probe_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "maintenanceWindows",
            col_opt_json(row, "maintenance_windows")?.unwrap_or(Value::Null),
        ),
        ("scope", col_json(row, "scope")?),
    ];
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Ok(map)
}

/// `effectiveRouteHealth` over a serialized row.
fn effective_health(route: &Map<String, Value>, now: DateTime<Utc>) -> String {
    if let Some(override_state) = route.get("healthOverrideState").and_then(Value::as_str) {
        let unexpired = match route.get("healthOverrideExpiresAt").and_then(Value::as_str) {
            None => true,
            Some(expires) => DateTime::parse_from_rfc3339(expires)
                .map(|expires| expires.with_timezone(&Utc) > now)
                .unwrap_or(false),
        };
        if !unexpired {
            // fall through to the computed state
            return route
                .get("healthComputedState")
                .and_then(Value::as_str)
                .unwrap_or(override_state)
                .to_owned();
        }
        return override_state.to_owned();
    }
    route
        .get("healthComputedState")
        .and_then(Value::as_str)
        .or_else(|| route.get("healthState").and_then(Value::as_str))
        .unwrap_or("HEALTHY")
        .to_owned()
}

get_json!(list, route_list);
async fn route_list(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let built = build_page(request, &spec(), &columns())?;
    let sql = built.select_sql(ROUTE_FROM, ROUTE_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let total: i64 = built
        .bind_count(&built.count_sql(ROUTE_FROM))
        .fetch_one(&state.pools.main)
        .await
        .map(|row| row.get::<i64, _>(0))
        .map_err(common::database_error)?;
    let now = Utc::now();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut route = route_scalars(row)?;
        let health = effective_health(&route, now);
        let rail = object(vec![
            ("id", Value::String(col_uuid(row, "rail_id")?)),
            ("code", Value::String(col_text(row, "rail_code")?)),
            (
                "nameEn",
                col_opt_text(row, "rail_name")?.map_or(Value::Null, Value::String),
            ),
        ]);
        let gateway = object(vec![
            ("id", Value::String(col_uuid(row, "gateway_id")?)),
            ("code", Value::String(col_text(row, "gateway_code")?)),
            ("name", Value::String(col_text(row, "gateway_name")?)),
        ]);
        let rail_code = col_text(row, "rail_code")?;
        let rail_name = col_opt_text(row, "rail_name")?.unwrap_or_default();
        let gateway_code = col_text(row, "gateway_code")?;
        let gateway_name = col_text(row, "gateway_name")?;
        route.insert("rail".to_owned(), rail);
        route.insert("gateway".to_owned(), gateway);
        route.insert("healthState".to_owned(), Value::String(health));
        route.insert("railCode".to_owned(), Value::String(rail_code));
        route.insert("railName".to_owned(), Value::String(rail_name));
        route.insert("gatewayCode".to_owned(), Value::String(gateway_code));
        route.insert("gatewayName".to_owned(), Value::String(gateway_name));
        items.push(Value::Object(route));
    }
    Ok(list_body("routes", items, total, &built))
}

get_json!(summary, route_summary);
async fn route_summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let status_rows = sqlx::query(
        "SELECT status::text AS key, count(*) AS count FROM rail_routes GROUP BY status",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let mut by_status = Map::new();
    for row in &status_rows {
        by_status.insert(col_text(row, "key")?, Value::from(col_i64(row, "count")?));
    }

    let health_rows = sqlx::query(
        "SELECT health_state::text AS health_state, health_computed_state::text AS health_computed_state,
                health_override_state::text AS health_override_state, health_override_expires_at
           FROM rail_routes",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let now = Utc::now();
    let mut by_health = Map::new();
    for row in &health_rows {
        let mut route = Map::new();
        route.insert(
            "healthState".to_owned(),
            Value::String(col_text(row, "health_state")?),
        );
        route.insert(
            "healthComputedState".to_owned(),
            Value::String(col_text(row, "health_computed_state")?),
        );
        route.insert(
            "healthOverrideState".to_owned(),
            col_opt_text(row, "health_override_state")?.map_or(Value::Null, Value::String),
        );
        route.insert(
            "healthOverrideExpiresAt".to_owned(),
            col_opt_date(row, "health_override_expires_at")?.map_or(Value::Null, Value::String),
        );
        let state = effective_health(&route, now);
        let count = by_health.get(&state).and_then(Value::as_i64).unwrap_or(0) + 1;
        by_health.insert(state, Value::from(count));
    }

    let pair_rows = sqlx::query(
        "SELECT count(*) FROM (SELECT DISTINCT rail_id, gateway_id FROM rail_routes) pairs",
    )
    .fetch_one(&state.pools.main)
    .await
    .map(|row| row.get::<i64, _>(0))
    .map_err(common::database_error)?;
    let total: i64 = by_status.values().filter_map(Value::as_i64).sum();

    Ok(object(vec![
        ("total", Value::from(total)),
        ("byStatus", Value::Object(by_status.clone())),
        ("byHealth", Value::Object(by_health.clone())),
        ("railGatewayPairs", Value::from(pair_rows)),
        (
            "active",
            Value::from(by_status.get("ACTIVE").and_then(Value::as_i64).unwrap_or(0)),
        ),
        (
            "paused",
            Value::from(by_status.get("PAUSED").and_then(Value::as_i64).unwrap_or(0)),
        ),
        (
            "draining",
            Value::from(
                by_status
                    .get("DRAINING")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            ),
        ),
        (
            "openBreaker",
            Value::from(
                by_health
                    .get("OPEN_BREAKER")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            ),
        ),
    ]))
}

get_json!(detail, route_detail);
async fn route_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 0)?;
    let row = sqlx::query(
        "SELECT id, created_at, updated_at, rail_id, gateway_id,
                credential_policy::text AS credential_policy, priority,
                routing_strategy::text AS routing_strategy, weight, cost_model, mismatch_policy,
                min_amount, max_amount, daily_cap_amount, status::text AS status,
                health_state::text AS health_state,
                health_computed_state::text AS health_computed_state, health_computed_reason,
                health_computed_at, health_override_state::text AS health_override_state,
                health_override_reason, health_override_set_at, health_override_set_by,
                health_override_expires_at, health_override_approval_id, health_reason,
                health_changed_at, health_consecutive_failures, health_probe_successes,
                health_probe_failures, health_last_probe_at, health_next_probe_at,
                maintenance_windows, scope
           FROM rail_routes
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| not_found("ROUTE_NOT_FOUND", "The route does not exist"))?;

    let rail_id = Uuid::parse_str(&col_uuid(&row, "rail_id")?).unwrap_or_default();
    let gateway_id = Uuid::parse_str(&col_uuid(&row, "gateway_id")?).unwrap_or_default();
    let rail_row = load_rail(state, rail_id).await?;
    let gateway_row = load_gateway(state, gateway_id).await?;

    let mut route = route_scalars(&row)?;
    route.insert(
        "rail".to_owned(),
        Value::Object(super::rails::rail_scalars(&rail_row)?),
    );
    route.insert(
        "gateway".to_owned(),
        Value::Object(super::gateways::gateway_scalars(&gateway_row)?),
    );
    // Prisma puts the plain scalars first, then the included relations; the map above already has
    // that order because the relations were appended last.
    Ok(object(vec![("route", Value::Object(route))]))
}

async fn load_rail(state: &AppState, id: Uuid) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query(
        "SELECT id, created_at, updated_at, code, name_ar, name_en, logo_asset_id,
                collection_mode::text AS collection_mode, sub_modes, currency::text AS currency,
                min_amount, max_amount, display_order, blocked, capabilities, refund_window_days,
                instructions_ar, instructions_en, help_guide_json, metadata
           FROM rails WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(ApiError::server_error)
}

async fn load_gateway(state: &AppState, id: Uuid) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query(
        "SELECT id, created_at, updated_at, code, name, operator, country::text AS country,
                aliases, kind::text AS kind, status::text AS status, active_version_id,
                verification_state::text AS verification_state, risk_class::text AS risk_class,
                metadata
           FROM gateways WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(ApiError::server_error)
}

get_json!(health, route_health);
async fn route_health(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 1)?;
    let route = sqlx::query(
        "SELECT id, rail_id, gateway_id, health_state::text AS health_state,
                health_computed_state::text AS health_computed_state, health_computed_reason,
                health_computed_at, health_override_state::text AS health_override_state,
                health_override_reason, health_override_set_at, health_override_set_by,
                health_override_expires_at, health_override_approval_id, health_reason,
                health_changed_at, health_consecutive_failures, health_probe_successes,
                health_probe_failures, health_last_probe_at, health_next_probe_at
           FROM rail_routes
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| not_found("ROUTE_NOT_FOUND", "The route does not exist"))?;

    let rail_id = col_uuid(&route, "rail_id")?;
    let gateway_id = col_uuid(&route, "gateway_id")?;
    let rail = sqlx::query("SELECT code, name_en FROM rails WHERE id = $1")
        .bind(Uuid::parse_str(&rail_id).unwrap_or_default())
        .fetch_optional(&state.pools.main)
        .await
        .map_err(common::database_error)?
        .ok_or_else(ApiError::server_error)?;
    let gateway = sqlx::query("SELECT code, name FROM gateways WHERE id = $1")
        .bind(Uuid::parse_str(&gateway_id).unwrap_or_default())
        .fetch_optional(&state.pools.main)
        .await
        .map_err(common::database_error)?
        .ok_or_else(ApiError::server_error)?;

    let override_set_by = col_opt_uuid(&route, "health_override_set_by")?;
    let override_set_by_name = match &override_set_by {
        // The TS include asks for `{ email, name }`; `users` has no `name` column, so the email is
        // the only usable label (documented deviation).
        Some(user_id) => sqlx::query("SELECT email FROM users WHERE id = $1")
            .bind(Uuid::parse_str(user_id).unwrap_or_default())
            .fetch_optional(&state.pools.main)
            .await
            .map_err(common::database_error)?
            .and_then(|row| col_opt_text(&row, "email").ok().flatten())
            .map_or(Value::Null, Value::String),
        None => Value::Null,
    };

    let samples = sqlx::query(
        "SELECT id, created_at, updated_at, route_id, window_start, definitive_failures,
                ambiguous_unknowns, rate_limits_429, ignored_outcomes, successes, p50_ms, p95_ms, p99_ms
           FROM gateway_health_samples
          WHERE route_id = $1
          ORDER BY window_start DESC, id DESC
          LIMIT 100",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let probes = sqlx::query(
        "SELECT id, created_at, route_id, credential_set_id, gateway_version_id,
                method::text AS method, status::text AS status, reason, http_status, latency_ms
           FROM route_health_probes
          WHERE route_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let events = sqlx::query(
        "SELECT id, created_at, route_id, from_state::text AS from_state, to_state::text AS to_state,
                source::text AS source, reason, evidence_json, actor_user_id, approval_request_id
           FROM route_health_events
          WHERE route_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let policy = read_policy(state).await?;

    let mut sample_items = Vec::with_capacity(samples.len());
    for sample in &samples {
        sample_items.push(object(vec![
            ("id", Value::String(col_uuid(sample, "id")?)),
            ("createdAt", Value::String(col_date(sample, "created_at")?)),
            ("updatedAt", Value::String(col_date(sample, "updated_at")?)),
            ("routeId", Value::String(col_uuid(sample, "route_id")?)),
            (
                "windowStart",
                Value::String(col_date(sample, "window_start")?),
            ),
            (
                "definitiveFailures",
                Value::from(col_i32(sample, "definitive_failures")?),
            ),
            (
                "ambiguousUnknowns",
                Value::from(col_i32(sample, "ambiguous_unknowns")?),
            ),
            (
                "rateLimits429",
                Value::from(col_i32(sample, "rate_limits_429")?),
            ),
            (
                "ignoredOutcomes",
                Value::from(col_i32(sample, "ignored_outcomes")?),
            ),
            ("successes", Value::from(col_i32(sample, "successes")?)),
            (
                "p50Ms",
                col_opt_i32(sample, "p50_ms")?.map_or(Value::Null, Value::from),
            ),
            (
                "p95Ms",
                col_opt_i32(sample, "p95_ms")?.map_or(Value::Null, Value::from),
            ),
            (
                "p99Ms",
                col_opt_i32(sample, "p99_ms")?.map_or(Value::Null, Value::from),
            ),
        ]));
    }
    let mut probe_items = Vec::with_capacity(probes.len());
    for probe in &probes {
        probe_items.push(object(vec![
            ("id", Value::String(col_uuid(probe, "id")?)),
            ("createdAt", Value::String(col_date(probe, "created_at")?)),
            ("routeId", Value::String(col_uuid(probe, "route_id")?)),
            (
                "credentialSetId",
                col_opt_uuid(probe, "credential_set_id")?.map_or(Value::Null, Value::String),
            ),
            (
                "gatewayVersionId",
                col_opt_uuid(probe, "gateway_version_id")?.map_or(Value::Null, Value::String),
            ),
            ("method", Value::String(col_text(probe, "method")?)),
            ("status", Value::String(col_text(probe, "status")?)),
            (
                "reason",
                col_opt_text(probe, "reason")?.map_or(Value::Null, Value::String),
            ),
            (
                "httpStatus",
                col_opt_i32(probe, "http_status")?.map_or(Value::Null, Value::from),
            ),
            (
                "latencyMs",
                col_opt_i32(probe, "latency_ms")?.map_or(Value::Null, Value::from),
            ),
        ]));
    }
    let mut event_items = Vec::with_capacity(events.len());
    for event in &events {
        event_items.push(object(vec![
            ("id", Value::String(col_uuid(event, "id")?)),
            ("createdAt", Value::String(col_date(event, "created_at")?)),
            ("routeId", Value::String(col_uuid(event, "route_id")?)),
            (
                "fromState",
                col_opt_text(event, "from_state")?.map_or(Value::Null, Value::String),
            ),
            ("toState", Value::String(col_text(event, "to_state")?)),
            ("source", Value::String(col_text(event, "source")?)),
            (
                "reason",
                col_opt_text(event, "reason")?.map_or(Value::Null, Value::String),
            ),
            (
                "evidenceJson",
                col_opt_json(event, "evidence_json")?.unwrap_or(Value::Null),
            ),
            (
                "actorUserId",
                col_opt_uuid(event, "actor_user_id")?.map_or(Value::Null, Value::String),
            ),
            (
                "approvalRequestId",
                col_opt_uuid(event, "approval_request_id")?.map_or(Value::Null, Value::String),
            ),
        ]));
    }

    Ok(object(vec![
        ("routeId", Value::String(id.to_string())),
        (
            "rail",
            object(vec![
                ("code", Value::String(col_text(&rail, "code")?)),
                (
                    "name",
                    col_opt_text(&rail, "name_en")?.map_or(Value::Null, Value::String),
                ),
            ]),
        ),
        (
            "gateway",
            object(vec![
                ("code", Value::String(col_text(&gateway, "code")?)),
                ("name", Value::String(col_text(&gateway, "name")?)),
            ]),
        ),
        (
            "health",
            object(vec![
                (
                    "effectiveState",
                    Value::String(col_text(&route, "health_state")?),
                ),
                (
                    "computedState",
                    Value::String(col_text(&route, "health_computed_state")?),
                ),
                (
                    "computedReason",
                    col_opt_text(&route, "health_computed_reason")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "computedAt",
                    col_opt_date(&route, "health_computed_at")?.map_or(Value::Null, Value::String),
                ),
                (
                    "overrideState",
                    col_opt_text(&route, "health_override_state")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "overrideReason",
                    col_opt_text(&route, "health_override_reason")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "overrideSetAt",
                    col_opt_date(&route, "health_override_set_at")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "overrideSetBy",
                    override_set_by.map_or(Value::Null, Value::String),
                ),
                ("overrideSetByName", override_set_by_name),
                (
                    "overrideExpiresAt",
                    col_opt_date(&route, "health_override_expires_at")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "overrideApprovalId",
                    col_opt_uuid(&route, "health_override_approval_id")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "reason",
                    col_opt_text(&route, "health_reason")?.map_or(Value::Null, Value::String),
                ),
                (
                    "changedAt",
                    col_opt_date(&route, "health_changed_at")?.map_or(Value::Null, Value::String),
                ),
                (
                    "consecutiveFailures",
                    Value::from(col_i32(&route, "health_consecutive_failures")?),
                ),
                (
                    "probeSuccesses",
                    Value::from(col_i32(&route, "health_probe_successes")?),
                ),
                (
                    "probeFailures",
                    Value::from(col_i32(&route, "health_probe_failures")?),
                ),
                (
                    "lastProbeAt",
                    col_opt_date(&route, "health_last_probe_at")?
                        .map_or(Value::Null, Value::String),
                ),
                (
                    "nextProbeAt",
                    col_opt_date(&route, "health_next_probe_at")?
                        .map_or(Value::Null, Value::String),
                ),
            ]),
        ),
        (
            "canary",
            object(vec![
                ("percent", pg_db::js_number_value(policy.canary_percent)),
                ("maxAmount", policy.canary_max_amount),
            ]),
        ),
        (
            "policy",
            object(vec![
                (
                    "sampleBucketSeconds",
                    pg_db::js_number_value(policy.sample_bucket_seconds),
                ),
                (
                    "overrideDefaultExpiryDays",
                    pg_db::js_number_value(policy.override_default_expiry_days),
                ),
                (
                    "overrideMaxExpiryDays",
                    pg_db::js_number_value(policy.override_max_expiry_days),
                ),
                (
                    "overrideReviewHours",
                    pg_db::js_number_value(policy.override_review_hours),
                ),
            ]),
        ),
        ("samples", Value::Array(sample_items)),
        ("probes", Value::Array(probe_items)),
        ("events", Value::Array(event_items)),
    ]))
}

/// The output subset of `RouteHealthPolicy` this endpoint exposes.
struct RouteHealthSettings {
    canary_percent: f64,
    canary_max_amount: Value,
    sample_bucket_seconds: f64,
    override_default_expiry_days: f64,
    override_max_expiry_days: f64,
    override_review_hours: f64,
}

impl Default for RouteHealthSettings {
    fn default() -> Self {
        Self {
            canary_percent: 5.0,
            canary_max_amount: Value::Null,
            sample_bucket_seconds: 300.0,
            override_default_expiry_days: 7.0,
            override_max_expiry_days: 30.0,
            override_review_hours: 24.0,
        }
    }
}

fn clamp_number(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    let Some(value) = value else {
        return fallback;
    };
    if value.is_boolean() || value.is_null() {
        return fallback;
    }
    let number = if let Some(number) = value.as_f64() {
        number
    } else if let Some(text) = value.as_str() {
        if text.trim().is_empty() {
            return fallback;
        }
        match text.trim().parse::<f64>() {
            Ok(number) => number,
            Err(_) => return fallback,
        }
    } else {
        return fallback;
    };
    if !number.is_finite() {
        return fallback;
    }
    number.clamp(min, max)
}

fn canary_amount(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let text = match value {
        Value::String(text) => text.trim().to_owned(),
        Value::Number(number) => number.to_string(),
        _ => return Value::Null,
    };
    if text.is_empty() {
        return Value::Null;
    }
    match Decimal::from_str_exact(&text) {
        Ok(amount) if amount.is_sign_positive() && !amount.is_zero() => {
            Value::String(pg_types::Money4(amount).to_fixed_4())
        }
        _ => Value::Null,
    }
}

fn parse_policy(value: Option<&Value>) -> RouteHealthSettings {
    let raw = value.and_then(Value::as_object);
    let max_expiry = clamp_number(
        raw.and_then(|map| map.get("overrideMaxExpiryDays")),
        30.0,
        1.0,
        30.0,
    );
    let default_expiry = clamp_number(
        raw.and_then(|map| map.get("overrideDefaultExpiryDays")),
        7.0,
        1.0,
        30.0,
    )
    .min(max_expiry);
    RouteHealthSettings {
        canary_percent: clamp_number(
            raw.and_then(|map| map.get("canaryPercent")),
            5.0,
            0.0,
            100.0,
        ),
        canary_max_amount: canary_amount(raw.and_then(|map| map.get("canaryMaxAmount"))),
        sample_bucket_seconds: clamp_number(
            raw.and_then(|map| map.get("sampleBucketSeconds")),
            300.0,
            60.0,
            3600.0,
        ),
        override_default_expiry_days: default_expiry,
        override_max_expiry_days: max_expiry,
        override_review_hours: clamp_number(
            raw.and_then(|map| map.get("overrideReviewHours")),
            24.0,
            1.0,
            720.0,
        ),
    }
}

async fn read_policy(state: &AppState) -> Result<RouteHealthSettings, ApiError> {
    let row = sqlx::query(
        "SELECT value_json FROM platform_settings
          WHERE key = 'route_health.policy' AND scope = 'PLATFORM'
          ORDER BY version DESC
          LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    Ok(match row {
        Some(row) => match row.try_get::<Value, _>("value_json") {
            Ok(value) => parse_policy(Some(&value)),
            Err(_) => RouteHealthSettings::default(),
        },
        None => RouteHealthSettings::default(),
    })
}
