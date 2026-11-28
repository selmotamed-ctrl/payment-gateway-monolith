//! Gateway collections, gateway detail, gateway summaries and the version list.
//!
//! Ports `admin.ts:13006-13344` (`GET /gateways`, `/gateways/summary`, `/gateways/:id`,
//! `/gateways/:id/versions`). The gateway list re-uses the `listQuery` contract and mirrors the
//! Prisma include projection: the page first loads the gateways, then their version summaries and
//! the per-gateway route-health buckets, exactly the three reads of the TS handler.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_http::ApiError;
use serde_json::{Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common;
use super::{
    build_page, col_char, col_date, col_i32, col_i64, col_json, col_opt_json, col_opt_text,
    col_opt_uuid, col_text, col_uuid, get_json, list_body, not_found, object, uuid_param,
};
use crate::state::AppState;

const GATEWAY_LIST_COLUMNS: &[&str] = &[
    "g.id",
    "g.created_at",
    "g.updated_at",
    "g.code",
    "g.name",
    "g.operator",
    "g.country::text AS country",
    "g.aliases",
    "g.kind::text AS kind",
    "g.status::text AS status",
    "g.active_version_id",
    "g.verification_state::text AS verification_state",
    "g.risk_class::text AS risk_class",
    "g.metadata",
    "av.version_number AS active_version_number",
    "av.state::text AS active_version_state",
    "(SELECT count(*) FROM credential_sets c WHERE c.gateway_id = g.id) AS credential_set_count",
    "(SELECT count(*) FROM rail_routes r WHERE r.gateway_id = g.id) AS route_count",
    "(SELECT count(*) FROM statement_sources s WHERE s.gateway_id = g.id) AS statement_source_count",
];

const GATEWAY_FROM: &str =
    "gateways g LEFT JOIN gateway_versions av ON av.id = g.active_version_id";

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
        .with("activeVersionId", "g.active_version_id", ColumnKind::Uuid)
        .with("createdAt", "g.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "g.updated_at", ColumnKind::Timestamp)
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

pub(super) fn gateway_scalars(row: &sqlx::postgres::PgRow) -> Result<Map<String, Value>, ApiError> {
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
    map.insert("name".to_owned(), Value::String(col_text(row, "name")?));
    map.insert(
        "operator".to_owned(),
        Value::String(col_text(row, "operator")?),
    );
    map.insert(
        "country".to_owned(),
        Value::String(col_char(row, "country")?),
    );
    map.insert("aliases".to_owned(), col_json(row, "aliases")?);
    map.insert("kind".to_owned(), Value::String(col_text(row, "kind")?));
    map.insert("status".to_owned(), Value::String(col_text(row, "status")?));
    map.insert(
        "activeVersionId".to_owned(),
        col_opt_uuid(row, "active_version_id")?.map_or(Value::Null, Value::String),
    );
    map.insert(
        "verificationState".to_owned(),
        Value::String(col_text(row, "verification_state")?),
    );
    map.insert(
        "riskClass".to_owned(),
        Value::String(col_text(row, "risk_class")?),
    );
    map.insert(
        "metadata".to_owned(),
        col_opt_json(row, "metadata")?.unwrap_or(Value::Null),
    );
    Ok(map)
}

fn version_brief(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        (
            "versionNumber",
            Value::from(col_i32(row, "version_number")?),
        ),
        ("state", Value::String(col_text(row, "state")?)),
        ("createdAt", Value::String(col_date(row, "created_at")?)),
    ]))
}

async fn versions_for(
    state: &AppState,
    ids: &[Uuid],
) -> Result<BTreeMap<String, Vec<Value>>, ApiError> {
    let mut grouped: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT id, gateway_id, version_number, state::text AS state, created_at
           FROM gateway_versions
          WHERE gateway_id = ANY($1)
          ORDER BY gateway_id, version_number DESC, id DESC",
    )
    .bind(ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    for row in rows {
        let gateway_id = col_uuid(&row, "gateway_id")?;
        grouped
            .entry(gateway_id)
            .or_default()
            .push(version_brief(&row)?);
    }
    Ok(grouped)
}

async fn route_health_for(
    state: &AppState,
    ids: &[Uuid],
) -> Result<BTreeMap<String, (i64, i64, i64)>, ApiError> {
    let mut grouped: BTreeMap<String, (i64, i64, i64)> = BTreeMap::new();
    if ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT gateway_id, health_state::text AS health_state, count(*) AS count
           FROM rail_routes
          WHERE gateway_id = ANY($1)
          GROUP BY gateway_id, health_state",
    )
    .bind(ids)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    for row in rows {
        let gateway_id = col_uuid(&row, "gateway_id")?;
        let state = col_text(&row, "health_state")?;
        let count = col_i64(&row, "count")?;
        let entry = grouped.entry(gateway_id).or_insert((0, 0, 0));
        match state.as_str() {
            "HEALTHY" => entry.0 += count,
            "DEGRADED" => entry.1 += count,
            "OPEN_BREAKER" => entry.2 += count,
            _ => {}
        }
    }
    Ok(grouped)
}

get_json!(list, gateway_list);
async fn gateway_list(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let built = build_page(request, &gateway_spec(), &gateway_columns())?;
    let sql = built.select_sql(GATEWAY_FROM, GATEWAY_LIST_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let total: i64 = built
        .bind_count(&built.count_sql("gateways g"))
        .fetch_one(&state.pools.main)
        .await
        .map(|row| row.get::<i64, _>(0))
        .map_err(common::database_error)?;

    let ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| row.try_get::<Uuid, _>("id").ok())
        .collect();
    let mut versions = versions_for(state, &ids).await?;
    let health = route_health_for(state, &ids).await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = col_uuid(row, "id")?;
        let mut map = gateway_scalars(row)?;
        let gateway_versions = versions.remove(&id).unwrap_or_default();
        let active = match col_opt_uuid(row, "active_version_id")? {
            Some(active_id) => object(vec![
                ("id", Value::String(active_id)),
                (
                    "versionNumber",
                    Value::from(col_i32(row, "active_version_number")?),
                ),
                (
                    "state",
                    Value::String(col_text(row, "active_version_state")?),
                ),
            ]),
            None => Value::Null,
        };
        let pending = gateway_versions
            .iter()
            .find(|version| {
                version.get("state").and_then(Value::as_str) == Some("PENDING_APPROVAL")
            })
            .cloned()
            .unwrap_or(Value::Null);
        let credential_set_count = col_i64(row, "credential_set_count")?;
        let route_count = col_i64(row, "route_count")?;
        let statement_source_count = col_i64(row, "statement_source_count")?;
        let (healthy, degraded, open_breaker) = health.get(&id).copied().unwrap_or((0, 0, 0));

        map.insert(
            "versions".to_owned(),
            Value::Array(gateway_versions.clone()),
        );
        map.insert("activeVersion".to_owned(), active.clone());
        map.insert(
            "_count".to_owned(),
            object(vec![
                ("credentialSets", Value::from(credential_set_count)),
                ("railRoutes", Value::from(route_count)),
                ("statementSources", Value::from(statement_source_count)),
            ]),
        );
        map.insert(
            "versionCount".to_owned(),
            Value::from(gateway_versions.len() as i64),
        );
        map.insert("activeVersion".to_owned(), active);
        map.insert("pendingVersion".to_owned(), pending);
        map.insert("routeCount".to_owned(), Value::from(route_count));
        map.insert(
            "credentialSetCount".to_owned(),
            Value::from(credential_set_count),
        );
        map.insert(
            "statementSourceCount".to_owned(),
            Value::from(statement_source_count),
        );
        map.insert(
            "routeHealth".to_owned(),
            object(vec![
                ("healthy", Value::from(healthy)),
                ("degraded", Value::from(degraded)),
                ("openBreaker", Value::from(open_breaker)),
            ]),
        );
        items.push(Value::Object(map));
    }
    Ok(list_body("gateways", items, total, &built))
}

get_json!(summary, gateway_summary);
async fn gateway_summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let (status_rows, kind_rows, verification_rows, risk_rows, health_rows, pending_versions) = tokio::try_join!(
        group_counts(state, "SELECT status::text AS key, count(*) AS count FROM gateways GROUP BY status"),
        group_counts(state, "SELECT kind::text AS key, count(*) AS count FROM gateways GROUP BY kind"),
        group_counts(
            state,
            "SELECT verification_state::text AS key, count(*) AS count FROM gateways GROUP BY verification_state"
        ),
        group_counts(
            state,
            "SELECT risk_class::text AS key, count(*) AS count FROM gateways GROUP BY risk_class"
        ),
        group_counts(
            state,
            "SELECT health_state::text AS key, count(*) AS count FROM rail_routes GROUP BY health_state"
        ),
        pending_version_count(state),
    )?;

    let total: i64 = status_rows.values().sum();
    let by_status = number_map(&status_rows);
    let by_kind = number_map(&kind_rows);
    let by_verification = number_map(&verification_rows);
    let by_risk = number_map(&risk_rows);
    let routes = object(vec![
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
    ]);
    Ok(object(vec![
        ("total", Value::from(total)),
        ("byStatus", by_status),
        ("byKind", by_kind),
        ("byVerification", by_verification),
        ("byRisk", by_risk),
        ("pendingVersions", Value::from(pending_versions)),
        ("routes", routes),
    ]))
}

async fn pending_version_count(state: &AppState) -> Result<i64, ApiError> {
    sqlx::query("SELECT count(*) FROM gateway_versions WHERE state = 'PENDING_APPROVAL'")
        .fetch_one(&state.pools.main)
        .await
        .map(|row| row.get::<i64, _>(0))
        .map_err(common::database_error)
}

async fn group_counts(
    state: &AppState,
    sql: &'static str,
) -> Result<BTreeMap<String, i64>, ApiError> {
    let rows = sqlx::query(sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let mut counts = BTreeMap::new();
    for row in rows {
        counts.insert(col_text(&row, "key")?, col_i64(&row, "count")?);
    }
    Ok(counts)
}

fn number_map(counts: &BTreeMap<String, i64>) -> Value {
    let mut map = Map::new();
    for (key, value) in counts {
        map.insert(key.clone(), Value::from(*value));
    }
    Value::Object(map)
}

get_json!(detail, gateway_detail);
async fn gateway_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 0)?;
    let row = sqlx::query(
        "SELECT id, created_at, updated_at, code, name, operator, country::text AS country,
                aliases, kind::text AS kind, status::text AS status, active_version_id,
                verification_state::text AS verification_state, risk_class::text AS risk_class,
                metadata
           FROM gateways
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| not_found("GATEWAY_NOT_FOUND", "The gateway does not exist"))?;

    // The snapshot ciphertext and the credential ciphertext are secrets; the explicit select
    // keeps them out of this response (admin.ts:13227).
    let versions = sqlx::query(
        "SELECT id, created_at, updated_at, gateway_id, version_number, content_hash,
                state::text AS state, created_by, approval_request_id, change_note,
                rollback_version_id
           FROM gateway_versions
          WHERE gateway_id = $1
          ORDER BY version_number ASC, id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let credential_rows = sqlx::query(
        "SELECT c.id, c.env::text AS env, c.owner_type::text AS owner_type,
                c.owner_merchant_id, c.external_merchant_id, c.settlement_target::text AS settlement_target,
                c.status::text AS status, c.last_verified_at, c.expires_at, g.code AS gateway_code
           FROM credential_sets c
           JOIN gateways g ON g.id = c.gateway_id
          WHERE c.gateway_id = $1
          ORDER BY c.created_at ASC, c.id ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;

    let mut version_items = Vec::with_capacity(versions.len());
    for version in &versions {
        version_items.push(object(vec![
            ("id", Value::String(col_uuid(version, "id")?)),
            ("createdAt", Value::String(col_date(version, "created_at")?)),
            ("updatedAt", Value::String(col_date(version, "updated_at")?)),
            ("gatewayId", Value::String(col_uuid(version, "gateway_id")?)),
            (
                "versionNumber",
                Value::from(col_i32(version, "version_number")?),
            ),
            (
                "contentHash",
                Value::String(col_text(version, "content_hash")?),
            ),
            ("state", Value::String(col_text(version, "state")?)),
            (
                "createdById",
                Value::String(col_uuid(version, "created_by")?),
            ),
            (
                "approvalRequestId",
                col_opt_uuid(version, "approval_request_id")?.map_or(Value::Null, Value::String),
            ),
            (
                "changeNote",
                col_opt_text(version, "change_note")?.map_or(Value::Null, Value::String),
            ),
            (
                "rollbackVersionId",
                col_opt_uuid(version, "rollback_version_id")?.map_or(Value::Null, Value::String),
            ),
        ]));
    }

    let mut credential_items = Vec::with_capacity(credential_rows.len());
    for credential in &credential_rows {
        credential_items.push(super::credentials::credential_set_view(
            credential,
            Some(&col_text(credential, "gateway_code")?),
        )?);
    }

    let mut gateway = gateway_scalars(&row)?;
    gateway.insert("versions".to_owned(), Value::Array(version_items));
    gateway.insert("credentialSets".to_owned(), Value::Array(credential_items));
    Ok(object(vec![("gateway", Value::Object(gateway))]))
}

get_json!(versions, gateway_versions);
async fn gateway_versions(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 1)?;
    // The TS route does not verify that the gateway exists; an unknown id answers an empty list.
    let rows = sqlx::query(
        "SELECT id, created_at, updated_at, gateway_id, version_number, snapshot_ciphertext,
                content_hash, state::text AS state, created_by, approval_request_id, change_note,
                rollback_version_id
           FROM gateway_versions
          WHERE gateway_id = $1
          ORDER BY version_number DESC, id DESC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let mut versions = Vec::with_capacity(rows.len());
    for row in &rows {
        versions.push(object(vec![
            ("id", Value::String(col_uuid(row, "id")?)),
            ("createdAt", Value::String(col_date(row, "created_at")?)),
            ("updatedAt", Value::String(col_date(row, "updated_at")?)),
            ("gatewayId", Value::String(col_uuid(row, "gateway_id")?)),
            (
                "versionNumber",
                Value::from(col_i32(row, "version_number")?),
            ),
            (
                "snapshotCiphertext",
                Value::String(col_text(row, "snapshot_ciphertext")?),
            ),
            ("contentHash", Value::String(col_text(row, "content_hash")?)),
            ("state", Value::String(col_text(row, "state")?)),
            ("createdById", Value::String(col_uuid(row, "created_by")?)),
            (
                "approvalRequestId",
                col_opt_uuid(row, "approval_request_id")?.map_or(Value::Null, Value::String),
            ),
            (
                "changeNote",
                col_opt_text(row, "change_note")?.map_or(Value::Null, Value::String),
            ),
            (
                "rollbackVersionId",
                col_opt_uuid(row, "rollback_version_id")?.map_or(Value::Null, Value::String),
            ),
        ]));
    }
    Ok(object(vec![("versions", Value::Array(versions))]))
}
