//! Admin incident reads.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/incidents`, `/incidents/export`,
//! `/incidents/summary/export`, `/incidents/:id`). Access is restricted by the confidential AML
//! role gate (`assertConfidential`) exactly as in TS, so the policy carries no separate authority
//! list. The list/export query strings are validated against the same severity/status/category
//! enums, and the detail includes the timeline, responders, actions, links and communications with
//! the same ordering and truncation limits.

#![forbid(unsafe_code)]

use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    page_params, query_string, require_confidential_aml, require_uuid_param, text, ts_json,
    uuid_json,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const STATUSES: &[&str] = &[
    "DETECTED",
    "TRIAGED",
    "DECLARED",
    "CONTAINED",
    "MONITORING",
    "RESOLVED",
    "POSTMORTEM",
    "CLOSED",
];
const SEVERITIES: &[&str] = &["SEV1", "SEV2", "SEV3", "SEV4"];
const CATEGORIES: &[&str] = &[
    "AVAILABILITY",
    "DATA_INTEGRITY",
    "SECURITY",
    "FRAUD",
    "COMPLIANCE",
    "THIRD_PARTY",
    "PAYMENT_PROCESSING",
    "OTHER",
];

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/incidents/summary/export",
            "core-back/api/internal/admin.ts:21191",
            summary_export_handler,
        ),
        route(
            "/internal/admin/incidents/export",
            "core-back/api/internal/admin.ts:21218",
            export_handler,
        ),
        route(
            "/internal/admin/incidents",
            "core-back/api/internal/admin.ts:21256",
            list_handler,
        ),
        route(
            "/internal/admin/incidents/:id",
            "core-back/api/internal/admin.ts:21313",
            detail_handler,
        ),
    ]
}

fn route(path: &str, origin: &str, handler: crate::routes::CustomHandler) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

const PROJECTION: &str = "i.id, i.created_at, i.updated_at, i.reference, i.title, i.summary,
    i.category::text AS category, i.severity::text AS severity, i.status::text AS status,
    i.impact_scope::text AS impact_scope, i.detected_at, i.declared_at, i.contained_at,
    i.resolved_at, i.closed_at, i.commander_user_id, i.reporter_user_id, to_jsonb(i.affected_services) AS affected_services,
    to_jsonb(i.affected_merchant_ids) AS affected_merchant_ids,
    to_jsonb(i.affected_attempt_ids) AS affected_attempt_ids, i.regulators_notified, i.regulatory_report_id,
    i.postmortem_required, i.postmortem_due_at, i.root_cause, i.postmortem_summary,
    i.postmortem_json, i.closed_by_user_id";

fn validate_enum(request: &HttpRequest, key: &str, allowed: &[&str]) -> Result<(), ApiError> {
    if let Some(value) = query_string(request, key) {
        if !allowed.contains(&value.as_str()) {
            return Err(ApiError::new(400, "INVALID_BODY", "Invalid request data"));
        }
    }
    Ok(())
}

fn validate_query(request: &HttpRequest) -> Result<(), ApiError> {
    validate_enum(request, "status", STATUSES)?;
    validate_enum(request, "severity", SEVERITIES)?;
    validate_enum(request, "category", CATEGORIES)?;
    for key in ["page", "pageSize"] {
        if let Some(value) = query_string(request, key) {
            if value.parse::<i64>().is_err() {
                return Err(ApiError::new(400, "INVALID_BODY", "Invalid request data"));
            }
        }
    }
    Ok(())
}

fn base_row(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": uuid_json(row, "id"),
        "createdAt": ts_json(row, "created_at"),
        "updatedAt": ts_json(row, "updated_at"),
        "reference": text(row, "reference"),
        "title": text(row, "title"),
        "summary": super::support::text_value(row, "summary"),
        "category": text(row, "category"),
        "severity": text(row, "severity"),
        "status": text(row, "status"),
        "impactScope": text(row, "impact_scope"),
        "detectedAt": ts_json(row, "detected_at"),
        "declaredAt": ts_json(row, "declared_at"),
        "containedAt": ts_json(row, "contained_at"),
        "resolvedAt": ts_json(row, "resolved_at"),
        "closedAt": ts_json(row, "closed_at"),
        "commanderUserId": uuid_json(row, "commander_user_id"),
        "reporterUserId": uuid_json(row, "reporter_user_id"),
        "affectedServices": super::support::jsonb(row, "affected_services"),
        "affectedMerchantIds": super::support::jsonb(row, "affected_merchant_ids"),
        "affectedAttemptIds": super::support::jsonb(row, "affected_attempt_ids"),
        "regulatorsNotified": super::support::bool_json(row, "regulators_notified"),
        "regulatoryReportId": uuid_json(row, "regulatory_report_id"),
        "postmortemRequired": super::support::bool_json(row, "postmortem_required"),
        "postmortemDueAt": ts_json(row, "postmortem_due_at"),
        "rootCause": super::support::text_value(row, "root_cause"),
        "postmortemSummary": super::support::text_value(row, "postmortem_summary"),
        "postmortemJson": super::support::jsonb(row, "postmortem_json"),
        "closedByUserId": uuid_json(row, "closed_by_user_id"),
    })
}

async fn user_labels(state: &AppState, ids: &[String]) -> Result<Map<String, Value>, ApiError> {
    let mut map = Map::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT id, email, phone, role::text AS role FROM users WHERE id = ANY($1::uuid[])",
    )
    .bind(
        ids.iter()
            .filter_map(|id| uuid::Uuid::parse_str(id).ok())
            .collect::<Vec<_>>(),
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    for row in &rows {
        let email = super::support::opt_text(row, "email");
        let phone = super::support::opt_text(row, "phone");
        let id = uuid_json(row, "id");
        map.insert(
            id.as_str().unwrap_or_default().to_owned(),
            json!({
                "label": email.clone().or(phone).unwrap_or_else(|| id.as_str().unwrap_or_default().to_owned()),
                "email": email,
                "role": text(row, "role"),
            }),
        );
    }
    Ok(map)
}

fn incident_user_ids(incidents: &[Value]) -> Vec<String> {
    let mut ids = std::collections::BTreeSet::new();
    for incident in incidents {
        for key in ["commanderUserId", "reporterUserId", "closedByUserId"] {
            if let Some(value) = incident.get(key).and_then(Value::as_str) {
                ids.insert(value.to_owned());
            }
        }
    }
    ids.into_iter().collect()
}

fn view(incident: &Value, users: &Map<String, Value>) -> Value {
    let name_of = |key: &str| -> Value {
        let Some(id) = incident.get(key).and_then(Value::as_str) else {
            return Value::Null;
        };
        users
            .get(id)
            .and_then(|entry| entry.get("label"))
            .cloned()
            .unwrap_or_else(|| Value::String(id.to_owned()))
    };
    let mut object = incident.clone();
    if let Some(map) = object.as_object_mut() {
        map.insert("commanderName".to_owned(), name_of("commanderUserId"));
        map.insert("reporterName".to_owned(), name_of("reporterUserId"));
        map.insert("closedByName".to_owned(), name_of("closedByUserId"));
        for key in [
            "affectedMerchantIds",
            "affectedAttemptIds",
            "affectedServices",
        ] {
            if map.get(key).is_none_or(Value::is_null) {
                map.insert(key.to_owned(), json!([]));
            }
        }
    }
    object
}

async fn views(state: &AppState, rows: &[sqlx::postgres::PgRow]) -> Result<Vec<Value>, ApiError> {
    let base: Vec<Value> = rows.iter().map(base_row).collect();
    let users = user_labels(state, &incident_user_ids(&base)).await?;
    Ok(base.iter().map(|incident| view(incident, &users)).collect())
}

fn where_clause(request: &HttpRequest) -> (String, Vec<String>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    for (key, column) in [
        ("status", "i.status::text"),
        ("severity", "i.severity::text"),
        ("category", "i.category::text"),
    ] {
        if let Some(value) = query_string(request, key) {
            binds.push(value);
            conditions.push(format!("{column} = ${}::text", binds.len()));
        }
    }
    if let Some(search) = query_string(request, "search") {
        binds.push(format!("%{search}%"));
        let index = binds.len();
        conditions.push(format!(
            "(i.reference ILIKE ${index}::text OR i.title ILIKE ${index}::text OR i.summary ILIKE ${index}::text)"
        ));
    }
    let sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    (sql, binds)
}

fn bind_search<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    binds: &'q [String],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for bind in binds {
        query = query.bind(bind.as_str());
    }
    query
}

async fn summary_counts(state: &AppState) -> Result<Value, ApiError> {
    let row = sqlx::query(
        "SELECT count(*) AS total,
                count(*) FILTER (WHERE status::text <> 'CLOSED') AS open,
                count(*) FILTER (WHERE severity::text IN ('SEV1','SEV2') AND status::text <> 'CLOSED') AS high,
                count(*) FILTER (WHERE postmortem_required AND postmortem_summary IS NULL) AS postmortem_due
         FROM incidents",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    Ok(json!({
        "total": row.try_get::<i64,_>("total").unwrap_or_default(),
        "open": row.try_get::<i64,_>("open").unwrap_or_default(),
        "high": row.try_get::<i64,_>("high").unwrap_or_default(),
        "postmortemDue": row.try_get::<i64,_>("postmortem_due").unwrap_or_default(),
    }))
}

async fn list(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    require_confidential_aml(principal)?;
    validate_query(request)?;
    let (page, page_size) = page_params(request, 50);
    let (where_sql, binds) = where_clause(request);
    let sql = format!(
        "SELECT {PROJECTION} FROM incidents i {where_sql} ORDER BY i.detected_at DESC LIMIT ${} OFFSET ${}",
        binds.len() + 1,
        binds.len() + 2
    );
    let query = bind_search(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .bind(page_size)
        .bind((page - 1) * page_size);
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let count_sql = format!("SELECT count(*) FROM incidents i {where_sql}");
    let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql));
    for bind in &binds {
        count_query = count_query.bind(bind.as_str());
    }
    let total = count_query
        .fetch_one(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let incidents = views(state, &rows).await?;
    let summary = summary_counts(state).await?;
    Ok(json!({
        "incidents": incidents,
        "total": total,
        "summary": summary,
        "page": page,
        "pageSize": page_size,
    }))
}

async fn export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    require_confidential_aml(principal)?;
    validate_query(request)?;
    let (where_sql, binds) = where_clause(request);
    let sql = format!(
        "SELECT {PROJECTION} FROM incidents i {where_sql} ORDER BY i.detected_at DESC LIMIT 5000"
    );
    let rows = bind_search(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let count_sql = format!("SELECT count(*) FROM incidents i {where_sql}");
    let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql));
    for bind in &binds {
        count_query = count_query.bind(bind.as_str());
    }
    let total = count_query
        .fetch_one(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let incidents = views(state, &rows).await?;
    Ok(json!({
        "incidents": incidents,
        "total": total,
        "exported": rows.len(),
        "truncated": total > i64::try_from(rows.len()).unwrap_or(i64::MAX),
    }))
}

pub(super) async fn detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    require_confidential_aml(principal)?;
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "INCIDENT_NOT_FOUND",
        "The incident does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PROJECTION} FROM incidents i WHERE i.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "INCIDENT_NOT_FOUND",
            "The incident does not exist",
        ));
    };
    let timeline = sqlx::query(
        "SELECT id, created_at, occurred_at, type::text AS type, actor_user_id, actor_name, summary, detail_json
         FROM incident_timeline_entries WHERE incident_id = $1 ORDER BY occurred_at DESC LIMIT 500",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let responders = sqlx::query(
        "SELECT id, created_at, user_id, name, role, is_commander, paged_at, acknowledged_at, released_at
         FROM incident_responders WHERE incident_id = $1 ORDER BY created_at ASC",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let actions = sqlx::query(
        "SELECT id, created_at, updated_at, title, owner_user_id, priority, status::text AS status,
                due_at, completed_at, notes
         FROM incident_action_items WHERE incident_id = $1 ORDER BY status ASC, due_at ASC",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let links = sqlx::query(
        "SELECT id, created_at, link_type::text AS link_type, target_id, label
         FROM incident_links WHERE incident_id = $1 ORDER BY created_at ASC",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let communications = sqlx::query(
        "SELECT id, created_at, channel::text AS channel, audience, subject, body, sent_at,
                sent_by_user_id, external_ref
         FROM incident_communications WHERE incident_id = $1 ORDER BY created_at DESC LIMIT 200",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;

    let base = base_row(&row);
    let mut ids = incident_user_ids(std::slice::from_ref(&base));
    for entry in &timeline {
        if let Some(id) = super::support::opt_text(entry, "actor_user_id") {
            ids.push(id);
        }
    }
    for action in &actions {
        if let Some(id) = super::support::opt_text(action, "owner_user_id") {
            ids.push(id);
        }
    }
    for responder in &responders {
        if let Some(id) = super::support::opt_text(responder, "user_id") {
            ids.push(id);
        }
    }
    for communication in &communications {
        if let Some(id) = super::support::opt_text(communication, "sent_by_user_id") {
            ids.push(id);
        }
    }
    ids.sort();
    ids.dedup();
    let users = user_labels(state, &ids).await?;
    let name_of = |id: Option<String>| -> Value {
        id.and_then(|id| users.get(&id).and_then(|entry| entry.get("label")).cloned())
            .unwrap_or(Value::Null)
    };
    let mut incident = view(&base, &users);
    if let Some(object) = incident.as_object_mut() {
        object.insert(
            "timeline".to_owned(),
            Value::Array(
                timeline
                    .iter()
                    .map(|entry| {
                        let actor = super::support::opt_text(entry, "actor_user_id");
                        json!({
                            "id": uuid_json(entry, "id"),
                            "createdAt": ts_json(entry, "created_at"),
                            "occurredAt": ts_json(entry, "occurred_at"),
                            "type": text(entry, "type"),
                            "actorUserId": uuid_json(entry, "actor_user_id"),
                            "actorName": super::support::opt_text(entry, "actor_name").map_or_else(|| name_of(actor), Value::String),
                            "summary": text(entry, "summary"),
                            "detailJson": super::support::jsonb(entry, "detail_json"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert(
            "responders".to_owned(),
            Value::Array(
                responders
                    .iter()
                    .map(|entry| {
                        let user = super::support::opt_text(entry, "user_id");
                        json!({
                            "id": uuid_json(entry, "id"),
                            "createdAt": ts_json(entry, "created_at"),
                            "userId": uuid_json(entry, "user_id"),
                            "name": text(entry, "name"),
                            "role": text(entry, "role"),
                            "isCommander": super::support::bool_json(entry, "is_commander"),
                            "pagedAt": ts_json(entry, "paged_at"),
                            "acknowledgedAt": ts_json(entry, "acknowledged_at"),
                            "releasedAt": ts_json(entry, "released_at"),
                            "userName": name_of(user),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert(
            "actions".to_owned(),
            Value::Array(
                actions
                    .iter()
                    .map(|entry| {
                        let owner = super::support::opt_text(entry, "owner_user_id");
                        json!({
                            "id": uuid_json(entry, "id"),
                            "createdAt": ts_json(entry, "created_at"),
                            "updatedAt": ts_json(entry, "updated_at"),
                            "title": text(entry, "title"),
                            "ownerUserId": uuid_json(entry, "owner_user_id"),
                            "priority": super::support::int_json(entry, "priority"),
                            "status": text(entry, "status"),
                            "dueAt": ts_json(entry, "due_at"),
                            "completedAt": ts_json(entry, "completed_at"),
                            "notes": super::support::text_value(entry, "notes"),
                            "ownerName": name_of(owner),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert(
            "links".to_owned(),
            Value::Array(
                links
                    .iter()
                    .map(|entry| {
                        json!({
                            "id": uuid_json(entry, "id"),
                            "createdAt": ts_json(entry, "created_at"),
                            "linkType": text(entry, "link_type"),
                            "targetId": text(entry, "target_id"),
                            "label": super::support::text_value(entry, "label"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert(
            "communications".to_owned(),
            Value::Array(
                communications
                    .iter()
                    .map(|entry| {
                        let sender = super::support::opt_text(entry, "sent_by_user_id");
                        json!({
                            "id": uuid_json(entry, "id"),
                            "createdAt": ts_json(entry, "created_at"),
                            "channel": text(entry, "channel"),
                            "audience": text(entry, "audience"),
                            "subject": text(entry, "subject"),
                            "body": text(entry, "body"),
                            "sentAt": ts_json(entry, "sent_at"),
                            "sentByUserId": uuid_json(entry, "sent_by_user_id"),
                            "externalRef": super::support::text_value(entry, "external_ref"),
                            "sentByName": name_of(sender),
                        })
                    })
                    .collect(),
            ),
        );
    }
    Ok(json!({ "incident": incident }))
}

async fn summary_export(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    require_confidential_aml(principal)?;
    let mut summary = summary_counts(state).await?;
    if let Some(object) = summary.as_object_mut() {
        object.insert(
            "exportedAt".to_owned(),
            super::support::iso_required(chrono::Utc::now()),
        );
    }
    Ok(summary)
}

// ---------------------------------------------------------------- handlers

fn list_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, list(state, request, principal).await) })
}

fn export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, export(state, request, principal).await) })
}

fn summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(
        async move { result_response(request, summary_export(state, request, principal).await) },
    )
}

fn detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, detail(state, request, principal).await) })
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}
