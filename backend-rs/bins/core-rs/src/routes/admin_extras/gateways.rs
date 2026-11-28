//! Gateway, rail and route JSON exports, the gateway health read and the inquiry summary export.
//!
//! Ports the export chunk of `core-back/api/internal/admin.ts` that the gateway module
//! deliberately leaves out:
//!
//! | Route | TypeScript |
//! | :--- | :--- |
//! | `GET /gateways/export` | `admin.ts:13064` |
//! | `GET /gateways/summary/export` | `admin.ts:13188` |
//! | `GET /rails/export` | `admin.ts:15910` |
//! | `GET /rails/summary/export` | `admin.ts:16022` |
//! | `GET /routes/export` | `admin.ts:16338` |
//! | `GET /routes/summary/export` | `admin.ts:16432` |
//! | `GET /gateway-inquiries/summary/export` | `admin.ts:11952` |
//! | `GET /gateways/:id/health` | `adminOperations.ts:554` |
//!
//! Exports are `take: 5000` snapshots (`total`/`exported`/`truncated`) and, exactly like TS, append
//! one audit row (`GATEWAYS_EXPORTED`, `RAIL_SUMMARY_EXPORTED`, ...). The summary endpoints return
//! the whole summary plus `exportedAt`. Money is `Money4`, timestamps are `toISOString()`, and the
//! route export re-applies the lazy override expiry of `effectiveRouteHealth`.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

use pg_http::ApiError;

use crate::state::AppState;

use super::support::{
    build_page, checklist, col_bool, col_char, col_date, col_decimal, col_i32, col_i64, col_json,
    col_opt_date, col_opt_decimal, col_opt_json, col_opt_text, col_opt_uuid, col_text, col_uuid,
    count_always, database_error, date_iso, decimal_json, filters_json, money4, object,
    uuid_path_param, write_audit,
};

const GATEWAY_FROM: &str =
    "gateways g LEFT JOIN gateway_versions av ON av.id = g.active_version_id";

const GATEWAY_SELECT: &str = "g.id, g.created_at, g.updated_at, g.code, g.name, g.operator,
    g.country::text AS country, g.aliases, g.kind::text AS kind, g.status::text AS status,
    g.active_version_id, g.verification_state::text AS verification_state,
    g.risk_class::text AS risk_class, av.version_number AS active_version_number,
    av.state::text AS active_version_state,
    (SELECT count(*) FROM credential_sets c WHERE c.gateway_id = g.id) AS credential_set_count,
    (SELECT count(*) FROM rail_routes r WHERE r.gateway_id = g.id) AS route_count,
    (SELECT count(*) FROM statement_sources s WHERE s.gateway_id = g.id) AS statement_source_count";

fn gateway_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "g.id", ColumnKind::Uuid)
        .with("code", "g.code", ColumnKind::Text)
        .with("name", "g.name", ColumnKind::Text)
        .with("operator", "g.operator", ColumnKind::Text)
        .with("status", "g.status::text", ColumnKind::Text)
        .with("kind", "g.kind::text", ColumnKind::Text)
        .with(
            "verificationState",
            "g.verification_state::text",
            ColumnKind::Text,
        )
        .with("riskClass", "g.risk_class::text", ColumnKind::Text)
        .with("country", "g.country::text", ColumnKind::Text)
        .with("createdAt", "g.created_at", ColumnKind::Timestamp)
}

fn gateway_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["code", "name", "operator"])
        .with_in("status", "status")
        .with_equals("kind", "kind")
        .with_equals("verificationState", "verificationState")
        .with_equals("riskClass", "riskClass")
        .with_equals("country", "country")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("code", "code")
        .with_sortable("name", "name")
        .with_sortable("operator", "operator")
        .with_sortable("status", "status")
        .with_sortable("kind", "kind")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("code", SortDirection::Asc)
}

struct VersionBrief {
    id: String,
    version_number: i32,
    state: String,
    created_at: String,
}

async fn versions_by_gateway(
    state: &AppState,
    ids: &[Uuid],
) -> Result<BTreeMap<String, Vec<VersionBrief>>, ApiError> {
    let mut grouped: BTreeMap<String, Vec<VersionBrief>> = BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT id, gateway_id, version_number, state::text AS state, created_at
           FROM gateway_versions WHERE gateway_id = ANY($1)
          ORDER BY gateway_id, version_number DESC, id DESC",
    )
    .bind(ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    for row in rows {
        let gateway_id = col_uuid(&row, "gateway_id")?;
        grouped.entry(gateway_id).or_default().push(VersionBrief {
            id: col_uuid(&row, "id")?,
            version_number: col_i32(&row, "version_number")?,
            state: col_text(&row, "state")?,
            created_at: col_date(&row, "created_at")?,
        });
    }
    Ok(grouped)
}

async fn route_health_by_gateway(
    state: &AppState,
    ids: &[Uuid],
) -> Result<BTreeMap<String, (i64, i64, i64)>, ApiError> {
    let mut grouped: BTreeMap<String, (i64, i64, i64)> = BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT gateway_id, health_state::text AS health_state, count(*) AS count
           FROM rail_routes WHERE gateway_id = ANY($1)
          GROUP BY gateway_id, health_state",
    )
    .bind(ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    for row in rows {
        let gateway_id = col_uuid(&row, "gateway_id")?;
        let health = col_text(&row, "health_state")?;
        let count = col_i64(&row, "count")?;
        let entry = grouped.entry(gateway_id).or_insert((0, 0, 0));
        match health.as_str() {
            "HEALTHY" => entry.0 += count,
            "DEGRADED" => entry.1 += count,
            "OPEN_BREAKER" => entry.2 += count,
            _ => {}
        }
    }
    Ok(grouped)
}

fn health_object(health: Option<&(i64, i64, i64)>) -> Value {
    let (healthy, degraded, open_breaker) = health.copied().unwrap_or((0, 0, 0));
    object(vec![
        ("healthy", Value::from(healthy)),
        ("degraded", Value::from(degraded)),
        ("openBreaker", Value::from(open_breaker)),
    ])
}

fn pending_version(versions: &[VersionBrief]) -> Value {
    versions
        .iter()
        .find(|version| version.state == "PENDING_APPROVAL")
        .map_or(Value::Null, |version| {
            object(vec![
                ("id", Value::String(version.id.clone())),
                ("versionNumber", Value::from(version.version_number)),
                ("state", Value::String(version.state.clone())),
                ("createdAt", Value::String(version.created_at.clone())),
            ])
        })
}

fn gateway_export_row(
    row: &PgRow,
    versions: &[VersionBrief],
    health: Option<&(i64, i64, i64)>,
) -> Result<Value, ApiError> {
    let active_version = col_opt_uuid(row, "active_version_id")?.map(|id| {
        object(vec![
            ("id", Value::String(id)),
            (
                "versionNumber",
                col_i32(row, "active_version_number")
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            ),
            (
                "state",
                col_opt_text(row, "active_version_state")
                    .ok()
                    .flatten()
                    .map_or(Value::Null, Value::String),
            ),
        ])
    });
    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("code", Value::String(col_text(row, "code")?)),
        ("name", Value::String(col_text(row, "name")?)),
        ("operator", Value::String(col_text(row, "operator")?)),
        ("country", Value::String(col_char(row, "country")?)),
        ("kind", Value::String(col_text(row, "kind")?)),
        (
            "verificationState",
            Value::String(col_text(row, "verification_state")?),
        ),
        ("riskClass", Value::String(col_text(row, "risk_class")?)),
        ("status", Value::String(col_text(row, "status")?)),
        ("aliases", col_json(row, "aliases")?),
        ("activeVersion", active_version.unwrap_or(Value::Null)),
        ("pendingVersion", pending_version(versions)),
        ("versionCount", Value::from(versions.len())),
        ("routeCount", Value::from(col_i64(row, "route_count")?)),
        (
            "credentialSetCount",
            Value::from(col_i64(row, "credential_set_count")?),
        ),
        (
            "statementSourceCount",
            Value::from(col_i64(row, "statement_source_count")?),
        ),
        ("routeHealth", health_object(health)),
        ("createdAt", Value::String(col_date(row, "created_at")?)),
        ("updatedAt", Value::String(col_date(row, "updated_at")?)),
    ]))
}

/// `GET /internal/admin/gateways/export` (`admin.ts:13064`).
pub(crate) async fn gateways_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_page(request, &gateway_spec(), &gateway_columns())?;
    let sql = format!(
        "SELECT {GATEWAY_SELECT} FROM {GATEWAY_FROM} {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    );
    let rows = super::support::bind_where(&sql, &built)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let total = count_always(&state.pools.main, &built, GATEWAY_FROM).await?;
    let ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("id").ok())
        .collect();
    let versions = versions_by_gateway(state, &ids).await?;
    let health = route_health_by_gateway(state, &ids).await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = col_uuid(row, "id")?;
        let version_list = versions.get(&id).map(Vec::as_slice).unwrap_or(&[]);
        items.push(gateway_export_row(row, version_list, health.get(&id))?);
    }
    let exported = items.len();
    let allowed = [
        "GATEWAY_SCOPE_VERIFIED",
        "VERIFICATION_STATUS_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "GATEWAYS_EXPORTED",
        "GATEWAY",
        "export",
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(request),
            "checklist": checklist,
        }),
    )
    .await?;
    Ok(object(vec![
        ("gateways", Value::Array(items)),
        ("total", Value::from(total)),
        ("exported", Value::from(exported)),
        ("truncated", Value::Bool(total > exported as i64)),
    ]))
}

/// `buildGatewaySummary` (`admin.ts:13188`).
async fn gateway_summary(state: &AppState) -> Result<Value, ApiError> {
    let by_status = count_by(
        state,
        "SELECT status::text AS key, count(*) AS count FROM gateways GROUP BY status",
    )
    .await?;
    let by_kind = count_by(
        state,
        "SELECT kind::text AS key, count(*) AS count FROM gateways GROUP BY kind",
    )
    .await?;
    let by_verification = count_by(
        state,
        "SELECT verification_state::text AS key, count(*) AS count FROM gateways GROUP BY verification_state",
    )
    .await?;
    let by_risk = count_by(
        state,
        "SELECT risk_class::text AS key, count(*) AS count FROM gateways GROUP BY risk_class",
    )
    .await?;
    let by_health = count_by(
        state,
        "SELECT health_state::text AS key, count(*) AS count FROM rail_routes GROUP BY health_state",
    )
    .await?;
    let pending_versions: i64 =
        sqlx::query("SELECT count(*) FROM gateway_versions WHERE state = 'PENDING_APPROVAL'")
            .fetch_one(&state.pools.main)
            .await
            .map_err(database_error)?
            .get(0);
    let total: i64 = by_status.values().filter_map(Value::as_i64).sum();
    Ok(object(vec![
        ("total", Value::from(total)),
        ("byStatus", Value::Object(by_status)),
        ("byKind", Value::Object(by_kind)),
        ("byVerification", Value::Object(by_verification)),
        ("byRisk", Value::Object(by_risk)),
        ("pendingVersions", Value::from(pending_versions)),
        (
            "routes",
            object(vec![
                (
                    "healthy",
                    Value::from(
                        by_health
                            .get("HEALTHY")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                    ),
                ),
                (
                    "degraded",
                    Value::from(
                        by_health
                            .get("DEGRADED")
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
            ]),
        ),
    ]))
}

async fn count_by(state: &AppState, sql: &str) -> Result<Map<String, Value>, ApiError> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let mut map = Map::new();
    for row in rows {
        map.insert(col_text(&row, "key")?, Value::from(col_i64(&row, "count")?));
    }
    Ok(map)
}

/// `GET /internal/admin/gateways/summary/export` (`admin.ts:13188`).
pub(crate) async fn gateways_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let summary = gateway_summary(state).await?;
    let allowed = [
        "PORTFOLIO_SCOPE_VERIFIED",
        "STATUS_BREAKDOWN_REVIEWED",
        "VERSION_RISK_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "GATEWAY_SUMMARY_EXPORTED",
        "GATEWAY",
        "summary",
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "pendingVersions": summary.get("pendingVersions").cloned().unwrap_or(Value::Null),
            "routes": summary.get("routes").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    with_exported_at(summary)
}

fn with_exported_at(mut summary: Value) -> Result<Value, ApiError> {
    if let Some(map) = summary.as_object_mut() {
        map.insert("exportedAt".to_owned(), Value::String(date_iso(Utc::now())));
        Ok(summary)
    } else {
        Err(ApiError::server_error())
    }
}

/* ------------------------------------------------------------------- rails */

const RAIL_FROM: &str = "rails r";

const RAIL_SELECT: &str = "r.id, r.created_at, r.updated_at, r.code, r.name_ar, r.name_en,
    r.collection_mode::text AS collection_mode, r.currency::text AS currency, r.min_amount,
    r.max_amount, r.display_order, r.blocked,
    (SELECT count(*) FROM rail_fields f WHERE f.rail_id = r.id) AS field_count,
    (SELECT count(*) FROM rail_routes x WHERE x.rail_id = r.id) AS route_count,
    (SELECT count(*) FROM flows x WHERE x.rail_id = r.id) AS flow_count,
    (SELECT count(*) FROM payment_attempts x WHERE x.rail_id = r.id) AS payment_attempt_count";

fn rail_columns() -> ColumnMap {
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
}

fn rail_spec() -> ListSpec {
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

async fn rail_health(
    state: &AppState,
    ids: &[Uuid],
) -> Result<BTreeMap<String, (i64, i64, i64, i64)>, ApiError> {
    let mut grouped: BTreeMap<String, (i64, i64, i64, i64)> = BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT rail_id, health_state::text AS health_state, status::text AS status, count(*) AS count
           FROM rail_routes WHERE rail_id = ANY($1)
          GROUP BY rail_id, health_state, status",
    )
    .bind(ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    for row in rows {
        let rail_id = col_uuid(&row, "rail_id")?;
        let health = col_text(&row, "health_state")?;
        let status = col_text(&row, "status")?;
        let count = col_i64(&row, "count")?;
        let entry = grouped.entry(rail_id).or_insert((0, 0, 0, 0));
        match health.as_str() {
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

fn rail_health_object(health: Option<&(i64, i64, i64, i64)>) -> Value {
    let (healthy, degraded, open_breaker, active) = health.copied().unwrap_or((0, 0, 0, 0));
    object(vec![
        ("healthy", Value::from(healthy)),
        ("degraded", Value::from(degraded)),
        ("openBreaker", Value::from(open_breaker)),
        ("active", Value::from(active)),
    ])
}

/// `GET /internal/admin/rails/export` (`admin.ts:15910`).
pub(crate) async fn rails_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_page(request, &rail_spec(), &rail_columns())?;
    let sql = format!(
        "SELECT {RAIL_SELECT} FROM {RAIL_FROM} {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    );
    let rows = super::support::bind_where(&sql, &built)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let total = count_always(&state.pools.main, &built, RAIL_FROM).await?;
    let ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("id").ok())
        .collect();
    let health = rail_health(state, &ids).await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = col_uuid(row, "id")?;
        items.push(object(vec![
            ("id", Value::String(id.clone())),
            ("code", Value::String(col_text(row, "code")?)),
            ("nameAr", Value::String(col_text(row, "name_ar")?)),
            ("nameEn", Value::String(col_text(row, "name_en")?)),
            (
                "collectionMode",
                Value::String(col_text(row, "collection_mode")?),
            ),
            ("currency", Value::String(col_char(row, "currency")?)),
            (
                "minAmount",
                Value::String(money4(Some(col_decimal(row, "min_amount")?))),
            ),
            (
                "maxAmount",
                Value::String(money4(col_opt_decimal(row, "max_amount")?)),
            ),
            ("blocked", Value::Bool(col_bool(row, "blocked")?)),
            ("displayOrder", Value::from(col_i32(row, "display_order")?)),
            ("fieldCount", Value::from(col_i64(row, "field_count")?)),
            ("routeCount", Value::from(col_i64(row, "route_count")?)),
            ("flowCount", Value::from(col_i64(row, "flow_count")?)),
            (
                "paymentAttemptCount",
                Value::from(col_i64(row, "payment_attempt_count")?),
            ),
            ("routeHealth", rail_health_object(health.get(&id))),
            ("createdAt", Value::String(col_date(row, "created_at")?)),
            ("updatedAt", Value::String(col_date(row, "updated_at")?)),
        ]));
    }
    let exported = items.len();
    let allowed = [
        "RAIL_SCOPE_VERIFIED",
        "COLLECTION_MODE_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "RAILS_EXPORTED",
        "RAIL",
        "export",
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(request),
            "checklist": checklist,
        }),
    )
    .await?;
    Ok(object(vec![
        ("rails", Value::Array(items)),
        ("total", Value::from(total)),
        ("exported", Value::from(exported)),
        ("truncated", Value::Bool(total > exported as i64)),
    ]))
}

async fn rail_summary(state: &AppState) -> Result<Value, ApiError> {
    let total_row = sqlx::query(
        "SELECT count(*) AS total, count(*) FILTER (WHERE blocked) AS blocked FROM rails",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(database_error)?;
    let total = col_i64(&total_row, "total")?;
    let blocked = col_i64(&total_row, "blocked")?;
    let by_mode = count_by(
        state,
        "SELECT collection_mode::text AS key, count(*) AS count FROM rails GROUP BY collection_mode",
    )
    .await?;
    let by_health = count_by(
        state,
        "SELECT health_state::text AS key, count(*) AS count FROM rail_routes GROUP BY health_state",
    )
    .await?;
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
                    Value::from(
                        by_health
                            .get("HEALTHY")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                    ),
                ),
                (
                    "degraded",
                    Value::from(
                        by_health
                            .get("DEGRADED")
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
            ]),
        ),
    ]))
}

/// `GET /internal/admin/rails/summary/export` (`admin.ts:16022`).
pub(crate) async fn rails_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let summary = rail_summary(state).await?;
    let allowed = [
        "RAIL_SCOPE_VERIFIED",
        "COLLECTION_MODE_REVIEWED",
        "ROUTE_HEALTH_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "RAIL_SUMMARY_EXPORTED",
        "RAIL",
        "summary",
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "active": summary.get("active").cloned().unwrap_or(Value::Null),
            "blocked": summary.get("blocked").cloned().unwrap_or(Value::Null),
            "routes": summary.get("routes").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    with_exported_at(summary)
}

/* ------------------------------------------------------------------ routes */

const ROUTE_FROM: &str = "rail_routes rr
    JOIN rails r ON r.id = rr.rail_id
    JOIN gateways g ON g.id = rr.gateway_id";

const ROUTE_SELECT: &str = "rr.id, rr.created_at, rr.updated_at, rr.rail_id, rr.gateway_id,
    rr.credential_policy::text AS credential_policy, rr.priority,
    rr.routing_strategy::text AS routing_strategy, rr.weight, rr.cost_model, rr.mismatch_policy,
    rr.min_amount, rr.max_amount, rr.daily_cap_amount, rr.status::text AS status,
    rr.health_state::text AS health_state, rr.health_computed_state::text AS health_computed_state,
    rr.health_computed_reason, rr.health_computed_at,
    rr.health_override_state::text AS health_override_state, rr.health_override_reason,
    rr.health_override_set_at, rr.health_override_set_by, rr.health_override_expires_at,
    rr.health_override_approval_id, rr.health_reason, rr.health_changed_at,
    rr.health_consecutive_failures, rr.health_probe_successes, rr.health_probe_failures,
    rr.health_last_probe_at, rr.health_next_probe_at, rr.maintenance_windows, rr.scope,
    r.code AS rail_code, r.name_en AS rail_name, g.code AS gateway_code, g.name AS gateway_name";

fn route_columns() -> ColumnMap {
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
}

fn route_spec() -> ListSpec {
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

fn route_scalars(row: &PgRow) -> Result<Map<String, Value>, ApiError> {
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

fn effective_health(route: &Map<String, Value>, now: DateTime<Utc>) -> String {
    if let Some(override_state) = route.get("healthOverrideState").and_then(Value::as_str) {
        let unexpired = match route.get("healthOverrideExpiresAt").and_then(Value::as_str) {
            None => true,
            Some(expires) => DateTime::parse_from_rfc3339(expires)
                .map(|expires| expires.with_timezone(&Utc) > now)
                .unwrap_or(false),
        };
        if unexpired {
            return override_state.to_owned();
        }
        return route
            .get("healthComputedState")
            .and_then(Value::as_str)
            .unwrap_or(override_state)
            .to_owned();
    }
    route
        .get("healthComputedState")
        .and_then(Value::as_str)
        .or_else(|| route.get("healthState").and_then(Value::as_str))
        .unwrap_or("HEALTHY")
        .to_owned()
}

/// `GET /internal/admin/routes/export` (`admin.ts:16338`).
pub(crate) async fn routes_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_page(request, &route_spec(), &route_columns())?;
    let sql = format!(
        "SELECT {ROUTE_SELECT} FROM {ROUTE_FROM} {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    );
    let rows = super::support::bind_where(&sql, &built)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let total = count_always(&state.pools.main, &built, ROUTE_FROM).await?;
    let now = Utc::now();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut route = route_scalars(row)?;
        route.insert(
            "rail".to_owned(),
            object(vec![
                ("id", Value::String(col_uuid(row, "rail_id")?)),
                ("code", Value::String(col_text(row, "rail_code")?)),
                ("nameEn", Value::String(col_text(row, "rail_name")?)),
            ]),
        );
        route.insert(
            "gateway".to_owned(),
            object(vec![
                ("id", Value::String(col_uuid(row, "gateway_id")?)),
                ("code", Value::String(col_text(row, "gateway_code")?)),
                ("name", Value::String(col_text(row, "gateway_name")?)),
            ]),
        );
        let health = effective_health(&route, now);
        route.insert("healthState".to_owned(), Value::String(health));
        route.insert(
            "railCode".to_owned(),
            Value::String(col_text(row, "rail_code")?),
        );
        route.insert(
            "railName".to_owned(),
            Value::String(col_text(row, "rail_name")?),
        );
        route.insert(
            "gatewayCode".to_owned(),
            Value::String(col_text(row, "gateway_code")?),
        );
        route.insert(
            "gatewayName".to_owned(),
            Value::String(col_text(row, "gateway_name")?),
        );
        items.push(Value::Object(route));
    }
    let exported = items.len();
    let allowed = [
        "ROUTE_SCOPE_VERIFIED",
        "ROUTE_HEALTH_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "ROUTES_EXPORTED",
        "RAIL_ROUTE",
        "export",
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(request),
            "checklist": checklist,
        }),
    )
    .await?;
    Ok(object(vec![
        ("routes", Value::Array(items)),
        ("total", Value::from(total)),
        ("exported", Value::from(exported)),
        ("truncated", Value::Bool(total > exported as i64)),
    ]))
}

async fn route_summary(state: &AppState) -> Result<Value, ApiError> {
    let by_status = count_by(
        state,
        "SELECT status::text AS key, count(*) AS count FROM rail_routes GROUP BY status",
    )
    .await?;
    let rows = sqlx::query(
        "SELECT health_state::text AS health_state, health_computed_state::text AS health_computed_state,
                health_override_state::text AS health_override_state,
                health_override_expires_at
           FROM rail_routes",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let now = Utc::now();
    let mut by_health: Map<String, Value> = Map::new();
    for row in &rows {
        let mut value = Map::new();
        value.insert(
            "healthState".to_owned(),
            Value::String(col_text(row, "health_state")?),
        );
        value.insert(
            "healthComputedState".to_owned(),
            Value::String(col_text(row, "health_computed_state")?),
        );
        value.insert(
            "healthOverrideState".to_owned(),
            col_opt_text(row, "health_override_state")?.map_or(Value::Null, Value::String),
        );
        value.insert("healthOverrideExpiresAt".to_owned(), {
            let expires: Option<NaiveDateTime> = row
                .try_get("health_override_expires_at")
                .map_err(database_error)?;
            expires.map_or(Value::Null, |value| {
                Value::String(date_iso(value.and_utc()))
            })
        });
        let health = effective_health(&value, now);
        let entry = by_health.get(&health).and_then(Value::as_i64).unwrap_or(0);
        by_health.insert(health, Value::from(entry + 1));
    }
    let pair_rows =
        sqlx::query("SELECT rail_id, gateway_id FROM rail_routes GROUP BY rail_id, gateway_id")
            .fetch_all(&state.pools.main)
            .await
            .map_err(database_error)?;
    let total: i64 = sqlx::query("SELECT count(*) FROM rail_routes")
        .fetch_one(&state.pools.main)
        .await
        .map_err(database_error)?
        .get(0);
    Ok(object(vec![
        ("total", Value::from(total)),
        ("byStatus", Value::Object(by_status.clone())),
        ("byHealth", Value::Object(by_health.clone())),
        ("railGatewayPairs", Value::from(pair_rows.len())),
        (
            "active",
            by_status.get("ACTIVE").cloned().unwrap_or(Value::from(0)),
        ),
        (
            "paused",
            by_status.get("PAUSED").cloned().unwrap_or(Value::from(0)),
        ),
        (
            "draining",
            by_status.get("DRAINING").cloned().unwrap_or(Value::from(0)),
        ),
        (
            "openBreaker",
            by_health
                .get("OPEN_BREAKER")
                .cloned()
                .unwrap_or(Value::from(0)),
        ),
    ]))
}

/// `GET /internal/admin/routes/summary/export` (`admin.ts:16432`).
pub(crate) async fn routes_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let summary = route_summary(state).await?;
    let allowed = [
        "ROUTE_SCOPE_VERIFIED",
        "STATUS_HEALTH_REVIEWED",
        "PAIR_SCOPE_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "ROUTE_SUMMARY_EXPORTED",
        "RAIL_ROUTE",
        "summary",
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "active": summary.get("active").cloned().unwrap_or(Value::Null),
            "paused": summary.get("paused").cloned().unwrap_or(Value::Null),
            "draining": summary.get("draining").cloned().unwrap_or(Value::Null),
            "openBreaker": summary.get("openBreaker").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    with_exported_at(summary)
}

/* -------------------------------------------------------- inquiry summary */

/// `GET /internal/admin/gateway-inquiries/summary/export` (`admin.ts:11952`).
pub(crate) async fn inquiry_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let by_status = count_by(
        state,
        "SELECT status::text AS key, count(*) AS count FROM gateway_inquiry_schedules GROUP BY status",
    )
    .await?;
    let overdue: i64 = sqlx::query(
        "SELECT count(*) FROM gateway_inquiry_schedules
          WHERE status IN ('SCHEDULED', 'RETRYING') AND next_run_at <= now()",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(database_error)?
    .get(0);
    let total: i64 = by_status.values().filter_map(Value::as_i64).sum();
    let summary = object(vec![
        ("total", Value::from(total)),
        (
            "scheduled",
            by_status
                .get("SCHEDULED")
                .cloned()
                .unwrap_or(Value::from(0)),
        ),
        (
            "running",
            by_status.get("RUNNING").cloned().unwrap_or(Value::from(0)),
        ),
        (
            "retrying",
            by_status.get("RETRYING").cloned().unwrap_or(Value::from(0)),
        ),
        (
            "completed",
            by_status
                .get("COMPLETED")
                .cloned()
                .unwrap_or(Value::from(0)),
        ),
        (
            "failed",
            by_status.get("FAILED").cloned().unwrap_or(Value::from(0)),
        ),
        (
            "cancelled",
            by_status
                .get("CANCELLED")
                .cloned()
                .unwrap_or(Value::from(0)),
        ),
        (
            "expired",
            by_status.get("EXPIRED").cloned().unwrap_or(Value::from(0)),
        ),
        ("overdue", Value::from(overdue)),
        ("byStatus", Value::Object(by_status)),
    ]);
    let mut audit_after = summary.as_object().cloned().unwrap_or_default();
    let allowed = [
        "INQUIRY_SCOPE_VERIFIED",
        "SCHEDULE_STATUS_REVIEWED",
        "OVERDUE_BACKLOG_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    audit_after.insert(
        "checklist".to_owned(),
        Value::Array(
            checklist(request, &allowed)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    write_audit(
        state,
        principal,
        "GATEWAY_INQUIRY_SUMMARY_EXPORTED",
        "GATEWAY_INQUIRY",
        "summary",
        Value::Object(audit_after),
    )
    .await?;
    with_exported_at(summary)
}

/* ------------------------------------------------------------ gateway health */

const HEALTH_SAMPLES: i64 = 100;
const HEALTH_VOLUME_DAYS: i64 = 30;

fn success_rate(successes: i64, failures: i64, unknowns: i64) -> Value {
    let denominator = successes + failures + unknowns;
    if denominator == 0 {
        Value::Null
    } else {
        pg_db::js_number_value(successes as f64 / denominator as f64)
    }
}

/// `GET /internal/admin/gateways/:id/health` (`adminOperations.ts:554`).
pub(crate) async fn gateway_health(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = uuid_path_param(
        request,
        2,
        "GATEWAY_NOT_FOUND",
        "The gateway does not exist",
    )?;
    let exists: Option<Uuid> = sqlx::query("SELECT id FROM gateways WHERE id = $1::uuid")
        .bind(&id)
        .fetch_optional(&state.pools.main)
        .await
        .map_err(database_error)?
        .and_then(|row| row.try_get("id").ok());
    if exists.is_none() {
        return Err(ApiError::new(
            404,
            "GATEWAY_NOT_FOUND",
            "The gateway does not exist",
        ));
    }
    let routes = sqlx::query(
        "SELECT rr.id, r.code AS rail_code FROM rail_routes rr
           JOIN rails r ON r.id = rr.rail_id
          WHERE rr.gateway_id = $1::uuid
          ORDER BY rr.priority ASC, rr.created_at ASC",
    )
    .bind(&id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let now = Utc::now();
    let since_24h = now - chrono::Duration::hours(24);
    let since_volume = (now - chrono::Duration::days(HEALTH_VOLUME_DAYS))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .ok_or_else(ApiError::server_error)?;
    let mut successes_24h = 0_i64;
    let mut failures_24h = 0_i64;
    let mut unknowns_24h = 0_i64;
    let mut p95_weighted = 0_f64;
    let mut p95_weight = 0_f64;
    let mut result = Vec::with_capacity(routes.len());
    for route in &routes {
        let route_id = col_uuid(route, "id")?;
        let rail_code = col_text(route, "rail_code")?;
        let samples = sqlx::query(
            "SELECT window_start, successes, definitive_failures, ambiguous_unknowns,
                    rate_limits_429, p50_ms, p95_ms, p99_ms
               FROM gateway_health_samples
              WHERE route_id = $1::uuid
              ORDER BY window_start DESC
              LIMIT $2",
        )
        .bind(Uuid::parse_str(&route_id).map_err(|_| ApiError::server_error())?)
        .bind(HEALTH_SAMPLES)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
        let volumes = sqlx::query(
            "SELECT day, currency::text AS currency, attempt_count, success_count, volume_amount
               FROM rm_route_daily_volumes
              WHERE route_id = $1::uuid AND day >= $2::date
              ORDER BY day ASC, currency ASC",
        )
        .bind(Uuid::parse_str(&route_id).map_err(|_| ApiError::server_error())?)
        .bind(since_volume)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
        let mut sample_values: Vec<Value> = Vec::with_capacity(samples.len());
        for sample in &samples {
            let window_start: NaiveDateTime =
                sample.try_get("window_start").map_err(database_error)?;
            let successes: i32 = sample.try_get("successes").map_err(database_error)?;
            let failures: i32 = sample
                .try_get("definitive_failures")
                .map_err(database_error)?;
            let unknowns: i32 = sample
                .try_get("ambiguous_unknowns")
                .map_err(database_error)?;
            let rate_limits: i32 = sample.try_get("rate_limits_429").map_err(database_error)?;
            let p50: Option<i32> = sample.try_get("p50_ms").map_err(database_error)?;
            let p95: Option<i32> = sample.try_get("p95_ms").map_err(database_error)?;
            let p99: Option<i32> = sample.try_get("p99_ms").map_err(database_error)?;
            if window_start.and_utc() >= since_24h {
                let (successes, failures, unknowns) = (
                    i64::from(successes),
                    i64::from(failures),
                    i64::from(unknowns),
                );
                successes_24h += successes;
                failures_24h += failures;
                unknowns_24h += unknowns;
                let weight = successes + failures + unknowns;
                if let Some(p95_ms) = p95 {
                    if weight > 0 {
                        p95_weighted += f64::from(p95_ms) * weight as f64;
                        p95_weight += weight as f64;
                    }
                }
            }
            sample_values.push(object(vec![
                (
                    "windowStart",
                    Value::String(date_iso(window_start.and_utc())),
                ),
                ("successes", Value::from(successes)),
                ("definitiveFailures", Value::from(failures)),
                ("ambiguousUnknowns", Value::from(unknowns)),
                ("rateLimits429", Value::from(rate_limits)),
                ("p50Ms", p50.map_or(Value::Null, Value::from)),
                ("p95Ms", p95.map_or(Value::Null, Value::from)),
                ("p99Ms", p99.map_or(Value::Null, Value::from)),
                (
                    "successRate",
                    success_rate(successes.into(), failures.into(), unknowns.into()),
                ),
            ]));
        }
        // TS reverses the descending page into ascending order for the response.
        sample_values.reverse();
        let daily = volumes
            .iter()
            .map(|volume| {
                let day: chrono::NaiveDate = volume.try_get("day").map_err(database_error)?;
                Ok(object(vec![
                    ("day", Value::String(day.format("%Y-%m-%d").to_string())),
                    ("currency", Value::String(col_char(volume, "currency")?)),
                    (
                        "attemptCount",
                        Value::from(col_i32(volume, "attempt_count")?),
                    ),
                    (
                        "successCount",
                        Value::from(col_i32(volume, "success_count")?),
                    ),
                    (
                        "volumeAmount",
                        Value::String(money4(Some(col_decimal(volume, "volume_amount")?))),
                    ),
                ]))
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        result.push(object(vec![
            ("routeId", Value::String(route_id)),
            ("railCode", Value::String(rail_code)),
            ("samples", Value::Array(sample_values)),
            ("dailyVolume", Value::Array(daily)),
        ]));
    }
    let p95 = if p95_weight > 0.0 {
        Value::from((p95_weighted / p95_weight).round() as i64)
    } else {
        Value::Null
    };
    Ok(object(vec![
        ("routes", Value::Array(result)),
        (
            "summary",
            object(vec![
                (
                    "successRate24h",
                    success_rate(successes_24h, failures_24h, unknowns_24h),
                ),
                ("p95Ms24h", p95),
            ]),
        ),
    ]))
}
