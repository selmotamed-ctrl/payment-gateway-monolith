//! Audit log reads: list, export, summary and detail.
//!
//! Port of the `GET /internal/admin/audit-logs*` handlers in `core-back/api/internal/admin.ts`
//! (`20005`, `20056`, `20147`, `20152`, `20184`).
//!
//! Two storage layouts exist, exactly like TS `getConfiguredAuditStore()`:
//!
//! - a dedicated audit database (`AUDIT_DATABASE_URL` → `audit_records`, with its own
//!   `actor_email` column and fixed `created_at DESC, id DESC` order; the filters are the subset
//!   `auditStoreParamsFromRequest` forwards);
//! - the legacy `audit_log` table in the main database, joined to `users` for the actor e-mail.
//!
//! `summary` always reads the legacy `audit_log` table (the TS summary does the same).

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{
    build_list_query, list_response, ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection,
};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::state::AppState;

use super::support::{
    audit_actor, audit_log_id, checklist, created_at_cursor, db_error, iso_naive, iso_utc,
    parse_js_date, query_map, scalar_raw, sqlx_error, write_audit_row,
};

/// `buildListQuery` spec of both audit list handlers.
fn audit_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["action", "entityType", "entityId", "actorEmail"])
        .with_contains("action", &["action"])
        .with_contains("entityType", &["entityType"])
        .with_contains("entityId", &["entityId"])
        .with_in("role", "role")
        .with_equals("actorId", "actorId")
        .with_equals("approvalRequestId", "approvalRequestId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("action", "action")
        .with_sortable("entityType", "entityType")
        .with_sortable("role", "role")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

/// Column map of the legacy (main database) layout.
fn audit_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "a.id", ColumnKind::Uuid)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp)
        .with("action", "a.action", ColumnKind::Text)
        .with("entityType", "a.entity_type", ColumnKind::Text)
        .with("entityId", "a.entity_id", ColumnKind::Text)
        .with("actorEmail", "u.email", ColumnKind::Text)
        .with("role", "a.role", ColumnKind::Text)
        .with("actorId", "a.actor_id", ColumnKind::Uuid)
        .with(
            "approvalRequestId",
            "a.approval_request_id",
            ColumnKind::Uuid,
        )
}

/// `auditStoreParamsFromRequest`: the subset of filters of the dedicated audit store.
struct StoreFilters {
    entity_type: Option<String>,
    entity_id: Option<String>,
    actor_id: Option<String>,
    action: Option<String>,
    role: Option<String>,
    search_prefix: Option<String>,
    created_from: Option<DateTime<Utc>>,
    created_to: Option<DateTime<Utc>>,
}

impl StoreFilters {
    fn from_query(query: &Map<String, Value>) -> Self {
        let date = |name: &str| scalar_raw(query, name).and_then(parse_js_date);
        Self {
            entity_type: scalar_raw(query, "entityType").map(str::to_owned),
            entity_id: scalar_raw(query, "entityId").map(str::to_owned),
            actor_id: scalar_raw(query, "actorId").map(str::to_owned),
            action: scalar_raw(query, "action").map(str::to_owned),
            role: scalar_raw(query, "role").map(str::to_owned),
            search_prefix: scalar_raw(query, "search").map(str::to_owned),
            created_from: date("from").or_else(|| date("dateFrom")),
            created_to: date("to").or_else(|| date("dateTo")),
        }
    }
}

enum AuditParam {
    Text(String),
    Uuid(String),
    Timestamp(DateTime<Utc>),
}

/// The WHERE clause builder of the dedicated audit store (`buildFilters`).
struct StoreSql {
    clauses: Vec<String>,
    params: Vec<AuditParam>,
}

impl StoreSql {
    fn from_filters(filters: &StoreFilters) -> Self {
        let mut builder = Self {
            clauses: Vec::new(),
            params: Vec::new(),
        };
        if let Some(value) = &filters.entity_type {
            let placeholder = builder.param(AuditParam::Text(value.clone()), "text");
            builder.clauses.push(format!("entity_type = {placeholder}"));
        }
        if let Some(value) = &filters.entity_id {
            let placeholder = builder.param(AuditParam::Text(value.clone()), "text");
            builder.clauses.push(format!("entity_id = {placeholder}"));
        }
        if let Some(value) = &filters.actor_id {
            let placeholder = builder.param(AuditParam::Uuid(value.clone()), "uuid");
            builder.clauses.push(format!("actor_id = {placeholder}"));
        }
        if let Some(value) = &filters.role {
            let placeholder = builder.param(AuditParam::Text(value.clone()), "text");
            builder.clauses.push(format!("role = {placeholder}"));
        }
        if let Some(value) = &filters.action {
            let placeholder = builder.param(AuditParam::Text(value.clone()), "text");
            builder.clauses.push(format!("action = {placeholder}"));
        }
        if let Some(value) = filters.created_from {
            let placeholder = builder.param(AuditParam::Timestamp(value), "timestamptz");
            builder.clauses.push(format!("created_at >= {placeholder}"));
        }
        if let Some(value) = filters.created_to {
            let placeholder = builder.param(AuditParam::Timestamp(value), "timestamptz");
            builder.clauses.push(format!("created_at <= {placeholder}"));
        }
        if let Some(value) = &filters.search_prefix {
            // `searchContains ? %term% : term%`, with `%`/`_` escaped (PostgreSQL default escape).
            let escaped = value.replace('%', "\\%").replace('_', "\\_");
            let placeholder = builder.param(AuditParam::Text(format!("{escaped}%")), "text");
            builder.clauses.push(format!(
                "(action ILIKE {placeholder} OR entity_type ILIKE {placeholder} \
                 OR entity_id ILIKE {placeholder} OR actor_email ILIKE {placeholder})"
            ));
        }
        builder
    }

    fn param(&mut self, value: AuditParam, cast: &str) -> String {
        self.params.push(value);
        format!("${}::{cast}", self.params.len())
    }

    fn where_sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.clauses.join(" AND "))
        }
    }

    fn bind<'q>(
        &'q self,
        mut query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    ) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
        for param in &self.params {
            query = match param {
                AuditParam::Text(value) | AuditParam::Uuid(value) => query.bind(value.as_str()),
                AuditParam::Timestamp(value) => query.bind(*value),
            };
        }
        query
    }
}

/// `auditRowToRecord` for the dedicated layout: non-object JSON becomes `{}`.
fn json_object_or_empty(value: Value) -> Value {
    match value {
        Value::Object(_) => pg_types::js_object_order(&value),
        _ => json!({}),
    }
}

fn store_row_json(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: Uuid = row.try_get("id").map_err(sqlx_error)?;
    let created_at: DateTime<Utc> = row.try_get("created_at").map_err(sqlx_error)?;
    let actor_id: Uuid = row.try_get("actor_id").map_err(sqlx_error)?;
    let actor_email: Option<String> = row.try_get("actor_email").map_err(sqlx_error)?;
    let approval_request_id: Option<Uuid> =
        row.try_get("approval_request_id").map_err(sqlx_error)?;
    Ok(json!({
        "id": id,
        "createdAt": iso_utc(created_at),
        "actorId": actor_id,
        "actorEmail": actor_email.unwrap_or_default(),
        "role": row.try_get::<String, _>("role").map_err(sqlx_error)?,
        "action": row.try_get::<String, _>("action").map_err(sqlx_error)?,
        "entityType": row.try_get::<String, _>("entity_type").map_err(sqlx_error)?,
        "entityId": row.try_get::<String, _>("entity_id").map_err(sqlx_error)?,
        "beforeJson": json_object_or_empty(row.try_get::<Value, _>("before_json").map_err(sqlx_error)?),
        "afterJson": json_object_or_empty(row.try_get::<Value, _>("after_json").map_err(sqlx_error)?),
        "approvalRequestId": approval_request_id.map(|value| value.to_string()),
    }))
}

fn main_row_json(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: Uuid = row.try_get("id").map_err(sqlx_error)?;
    let created_at: NaiveDateTime = row.try_get("created_at").map_err(sqlx_error)?;
    let actor_id: Uuid = row.try_get("actor_id").map_err(sqlx_error)?;
    let actor_email: Option<String> = row.try_get("actor_email").map_err(sqlx_error)?;
    let approval_request_id: Option<Uuid> =
        row.try_get("approval_request_id").map_err(sqlx_error)?;
    Ok(json!({
        "id": id,
        "createdAt": iso_naive(created_at),
        "actorId": actor_id,
        "actorEmail": actor_email.unwrap_or_default(),
        "role": row.try_get::<String, _>("role").map_err(sqlx_error)?,
        "action": row.try_get::<String, _>("action").map_err(sqlx_error)?,
        "entityType": row.try_get::<String, _>("entity_type").map_err(sqlx_error)?,
        "entityId": row.try_get::<String, _>("entity_id").map_err(sqlx_error)?,
        "beforeJson": pg_types::js_object_order(&row.try_get::<Value, _>("before_json").map_err(sqlx_error)?),
        "afterJson": pg_types::js_object_order(&row.try_get::<Value, _>("after_json").map_err(sqlx_error)?),
        "approvalRequestId": approval_request_id.map(|value| value.to_string()),
    }))
}

/// One page of the dedicated audit store (`queryAuditLogs`), with its filtered count.
async fn store_page(
    state: &AppState,
    filters: &StoreFilters,
    limit: i64,
    offset: i64,
) -> Result<(Vec<Value>, i64), ApiError> {
    let pool = state
        .pools
        .audit
        .as_ref()
        .ok_or_else(ApiError::server_error)?;
    let builder = StoreSql::from_filters(filters);
    let count_sql = format!(
        "SELECT count(*)::bigint FROM {}{}",
        pg_db::AUDIT_TABLE,
        builder.where_sql()
    );
    let count: i64 = builder
        .bind(sqlx::query(sqlx::AssertSqlSafe(count_sql.as_str())))
        .fetch_one(pool)
        .await
        .map_err(sqlx_error)?
        .try_get(0)
        .map_err(sqlx_error)?;

    // `queryAuditLogs` clamps the limit to 1..5000 and always orders created_at/id descending.
    let clamped = limit.clamp(1, 5_000);
    let sql = format!(
        "SELECT id, created_at, actor_id, actor_email, role, action, entity_type, entity_id,
                before_json, after_json, approval_request_id
         FROM {}{}
         ORDER BY created_at DESC, id DESC
         LIMIT ${} OFFSET ${}",
        pg_db::AUDIT_TABLE,
        builder.where_sql(),
        builder.params.len() + 1,
        builder.params.len() + 2
    );
    let rows = builder
        .bind(sqlx::query(sqlx::AssertSqlSafe(sql.as_str())))
        .bind(clamped)
        .bind(offset.max(0))
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(store_row_json(row)?);
    }
    Ok((items, count))
}

const MAIN_SELECT: &str = "SELECT a.id, a.created_at, a.actor_id, u.email AS actor_email,
        a.role, a.action, a.entity_type, a.entity_id, a.before_json, a.after_json,
        a.approval_request_id
 FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id";

async fn audit_logs_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let query = query_map(request);
    let built = build_list_query(&query, &audit_spec(), &audit_columns()).map_err(db_error)?;

    if state.pools.audit.is_some() {
        let filters = StoreFilters::from_query(&query);
        let (items, total) = store_page(state, &filters, built.take, built.skip).await?;
        let mut source_rows = Vec::with_capacity(items.len());
        for item in &items {
            let created_at = item
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok());
            if let Some(id) = id {
                source_rows.push(created_at_cursor(&built, created_at, id));
            } else {
                source_rows.push(Vec::new());
            }
        }
        return Ok(list_response(
            "auditLogs",
            Value::Array(items),
            Some(total),
            &built,
            &source_rows,
        ));
    }

    let pool = &state.pools.main;
    let sql = format!(
        "{MAIN_SELECT} {} ORDER BY {} LIMIT ${} OFFSET ${}",
        built.where_sql,
        built.order_by_sql,
        built.binds.len() + 1,
        built.binds.len() + 2
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let count_sql = format!(
        "SELECT count(*)::bigint FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id {}",
        built.where_sql
    );
    let total: i64 = built
        .bind_count(&count_sql)
        .fetch_one(pool)
        .await
        .map_err(sqlx_error)?
        .try_get(0)
        .map_err(sqlx_error)?;
    let mut items = Vec::with_capacity(rows.len());
    let mut source_rows = Vec::with_capacity(rows.len());
    for row in &rows {
        let item = main_row_json(row)?;
        let created_at = item
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = row.try_get::<Uuid, _>("id").map_err(sqlx_error)?;
        source_rows.push(created_at_cursor(&built, created_at, id));
        items.push(item);
    }
    Ok(list_response(
        "auditLogs",
        Value::Array(items),
        Some(total),
        &built,
        &source_rows,
    ))
}

async fn audit_logs_export_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let query = query_map(request);
    let built = build_list_query(&query, &audit_spec(), &audit_columns()).map_err(db_error)?;

    let (rows, total) = if state.pools.audit.is_some() {
        let filters = StoreFilters::from_query(&query);
        store_page(state, &filters, 5_000, 0).await?
    } else {
        let pool = &state.pools.main;
        let sql = format!(
            "{MAIN_SELECT} {} ORDER BY {} LIMIT 5000",
            built.where_sql, built.order_by_sql
        );
        let rows = built
            .bind_count(&sql)
            .fetch_all(pool)
            .await
            .map_err(sqlx_error)?;
        let count_sql = format!(
            "SELECT count(*)::bigint FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id {}",
            built.where_sql
        );
        let total: i64 = built
            .bind_count(&count_sql)
            .fetch_one(pool)
            .await
            .map_err(sqlx_error)?
            .try_get(0)
            .map_err(sqlx_error)?;
        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            items.push(main_row_json(row)?);
        }
        (items, total)
    };

    let allowed = [
        "DATE_RANGE_VERIFIED",
        "SENSITIVE_FIELDS_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(&query, &allowed);
    // `JSON.stringify(request.query ?? {})`: the exported filter description.
    let filters_json =
        serde_json::to_string(&Value::Object(query.clone())).unwrap_or_else(|_| "{}".to_owned());
    let (actor_id, role) = audit_actor(principal).ok_or_else(|| {
        ApiError::forbidden(
            "APPROVAL_PRINCIPAL_REQUIRED",
            "A human user principal is required for maker-checker operations",
        )
    })?;
    let exported = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let after = json!({
        "total": total,
        "exported": exported,
        "filters": filters_json,
        "checklist": checklist,
    });
    // The TS handler writes only the audit outbox row (the shipper owns the dedicated audit row).
    sqlx::query(
        "INSERT INTO audit_outbox (id, actor_id, role, action, entity_type, entity_id,
                                   before_json, after_json, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 'AUDIT_LOGS_EXPORTED', 'AUDIT_LOG', 'export',
                 $4::jsonb, $5::jsonb, $6::timestamptz)",
    )
    .bind(pg_types::new_v7())
    .bind(actor_id)
    .bind(role)
    .bind(json!({}))
    .bind(after)
    .bind(Utc::now())
    .execute(&state.pools.main)
    .await
    .map_err(sqlx_error)?;

    Ok(json!({
        "auditLogs": rows,
        "total": total,
        "exported": exported,
        "truncated": total > exported,
    }))
}

async fn audit_summary_snapshot(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let since = Utc::now() - chrono::Duration::hours(24);
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
        .fetch_one(pool)
        .await
        .map_err(sqlx_error)?;
    let last_24h: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE created_at >= $1")
        .bind(since.naive_utc())
        .fetch_one(pool)
        .await
        .map_err(sqlx_error)?;
    let actors: i64 = sqlx::query_scalar("SELECT count(DISTINCT actor_id) FROM audit_log")
        .fetch_one(pool)
        .await
        .map_err(sqlx_error)?;
    let action_rows = sqlx::query(
        "SELECT action, count(*)::bigint AS total FROM audit_log
         GROUP BY action ORDER BY total DESC, action ASC LIMIT 25",
    )
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut by_action = Map::new();
    for row in &action_rows {
        let action: String = row.try_get("action").map_err(sqlx_error)?;
        let count: i64 = row.try_get("total").map_err(sqlx_error)?;
        by_action.insert(action, json!(count));
    }
    let entity_rows = sqlx::query(
        "SELECT entity_type, count(*)::bigint AS total FROM audit_log
         GROUP BY entity_type ORDER BY entity_type ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut by_entity = Map::new();
    for row in &entity_rows {
        let entity_type: String = row.try_get("entity_type").map_err(sqlx_error)?;
        let count: i64 = row.try_get("total").map_err(sqlx_error)?;
        by_entity.insert(entity_type, json!(count));
    }
    Ok(json!({
        "summary": {
            "total": total,
            "last24h": last_24h,
            "actors": actors,
            "byAction": Value::Object(by_action),
            "byEntityType": Value::Object(by_entity),
        },
    }))
}

async fn audit_summary_inner(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    audit_summary_snapshot(state).await
}

async fn audit_summary_export_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = audit_summary_snapshot(state).await?;
    let query = query_map(request);
    let allowed = [
        "ACTIVITY_SCOPE_VERIFIED",
        "ACTION_BREAKDOWN_REVIEWED",
        "ENTITY_BREAKDOWN_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(&query, &allowed);
    let summary = &snapshot["summary"];
    write_audit_row(
        state,
        principal,
        "AUDIT_LOG_SUMMARY_EXPORTED",
        "AUDIT_LOG",
        "summary",
        json!({}),
        json!({
            "total": summary["total"],
            "last24h": summary["last24h"],
            "actors": summary["actors"],
            "checklist": checklist,
        }),
    )
    .await?;
    let mut response = snapshot;
    if let Value::Object(map) = &mut response {
        map.insert("exportedAt".to_owned(), json!(iso_utc(Utc::now())));
    }
    Ok(response)
}

async fn audit_log_detail_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = audit_log_id(request)?;
    let row = if let Some(pool) = &state.pools.audit {
        let row = sqlx::query(
            "SELECT id, created_at, actor_id, actor_email, role, action, entity_type, entity_id,
                    before_json, after_json, approval_request_id
             FROM audit_records WHERE id = $1::uuid LIMIT 1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(sqlx_error)?;
        row.map(|row| store_row_json(&row)).transpose()?
    } else {
        let sql = format!("{MAIN_SELECT} WHERE a.id = $1::uuid LIMIT 1");
        let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(sqlx_error)?;
        row.map(|row| main_row_json(&row)).transpose()?
    };
    let audit_log = row.ok_or_else(|| {
        ApiError::new(
            404,
            "AUDIT_LOG_NOT_FOUND",
            "The audit log entry does not exist",
        )
    })?;
    Ok(json!({ "auditLog": audit_log }))
}

super::support::custom_route!(audit_logs, audit_logs_inner);
super::support::custom_route!(audit_logs_export, audit_logs_export_inner);
super::support::custom_route!(audit_summary, audit_summary_inner);
super::support::custom_route!(audit_summary_export, audit_summary_export_inner);
super::support::custom_route_no_store!(audit_log_detail, audit_log_detail_inner);
