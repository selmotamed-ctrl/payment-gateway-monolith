//! Staff user reads: `/users`, `/users/summary`, `/users/:id` and `/options/:kind`.
//!
//! Port of `core-back/api/internal/admin.ts:1552-1918`. The user endpoints never select
//! `password_hash`, `mfa_secret_ciphertext` or `invitation_token_hash`; the detail endpoint returns
//! the sanitised academy progress (`publicProgress`), never `_server`. Options are the shared
//! autocomplete sources (`OPTION_LIMIT = 100`).

#![forbid(unsafe_code)]

use chrono::NaiveDateTime;
use ntex::web::HttpRequest;
use pg_db::list_response;
use pg_domain_auth::Principal;
use pg_http::ApiError;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::helpers::{
    iso, iso_or_null, js_json, js_limit, last_path_segment, raw_query, require_authorities,
    require_uuid, Params, STAFF_READ_AUTHORITIES,
};
use crate::http::error_response;
use crate::routes::common::json_ok;
use crate::state::AppState;

fn user_columns() -> pg_db::ColumnMap {
    pg_db::ColumnMap::new()
        .with("id", "u.id", pg_db::ColumnKind::Uuid)
        .with("email", "u.email", pg_db::ColumnKind::Text)
        .with("phone", "u.phone", pg_db::ColumnKind::Text)
        .with("role", "u.role::text", pg_db::ColumnKind::Text)
        .with("status", "u.status::text", pg_db::ColumnKind::Text)
        .with("merchantId", "u.merchant_id", pg_db::ColumnKind::Uuid)
        .with("createdAt", "u.created_at", pg_db::ColumnKind::Timestamp)
        .with("updatedAt", "u.updated_at", pg_db::ColumnKind::Timestamp)
}

fn user_spec() -> pg_db::ListSpec {
    pg_db::ListSpec::default()
        .with_search(&["email", "phone"])
        .with_in("status", "status")
        .with_equals("role", "role")
        .with_equals("merchantId", "merchantId")
        .with_date(pg_db::DateFilter::new("createdAt", "createdAt"))
        .with_sortable("email", "email")
        .with_sortable("role", "role")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", pg_db::SortDirection::Desc)
}

const USER_SELECT: &[&str] = &[
    "u.id AS id",
    "u.email AS email",
    "u.phone AS phone",
    "u.role::text AS role",
    "u.merchant_id AS merchant_id",
    "u.authorities_map AS authorities_map",
    "u.status::text AS status",
    "u.is_maker AS is_maker",
    "u.is_checker AS is_checker",
    "u.mfa_required AS mfa_required",
    "u.invitation_expires_at AS invitation_expires_at",
    "u.created_at AS created_at",
    "u.updated_at AS updated_at",
];

fn user_row(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let email: String = row
        .try_get("email")
        .map_err(crate::routes::common::database_error)?;
    let phone: Option<String> = row
        .try_get("phone")
        .map_err(crate::routes::common::database_error)?;
    let role: String = row
        .try_get("role")
        .map_err(crate::routes::common::database_error)?;
    let merchant_id: Option<Uuid> = row
        .try_get("merchant_id")
        .map_err(crate::routes::common::database_error)?;
    let authorities_map: Value = row
        .try_get("authorities_map")
        .map_err(crate::routes::common::database_error)?;
    let status: String = row
        .try_get("status")
        .map_err(crate::routes::common::database_error)?;
    let is_maker: bool = row
        .try_get("is_maker")
        .map_err(crate::routes::common::database_error)?;
    let is_checker: bool = row
        .try_get("is_checker")
        .map_err(crate::routes::common::database_error)?;
    let mfa_required: bool = row
        .try_get("mfa_required")
        .map_err(crate::routes::common::database_error)?;
    let invitation_expires_at: Option<NaiveDateTime> = row
        .try_get("invitation_expires_at")
        .map_err(crate::routes::common::database_error)?;
    let created_at: NaiveDateTime = row
        .try_get("created_at")
        .map_err(crate::routes::common::database_error)?;
    let updated_at: NaiveDateTime = row
        .try_get("updated_at")
        .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "id": id,
        "email": email,
        "phone": phone,
        "role": role,
        "merchantId": merchant_id,
        "authoritiesMap": js_json(authorities_map),
        "status": status,
        "isMaker": is_maker,
        "isChecker": is_checker,
        "mfaRequired": mfa_required,
        "invitationExpiresAt": iso_or_null(invitation_expires_at),
        "createdAt": iso(created_at),
        "updatedAt": iso(updated_at),
    }))
}

fn scope_clause(built: &mut pg_db::BuiltListQuery, scope: Option<String>) {
    let clause = match scope.as_deref() {
        Some("admin") => Some("u.merchant_id IS NULL"),
        Some("merchant") => Some("u.merchant_id IS NOT NULL"),
        _ => None,
    };
    if let Some(clause) = clause {
        if built.where_sql.is_empty() {
            built.where_sql = format!("WHERE {clause}");
        } else {
            built.where_sql = format!("{} AND {clause}", built.where_sql);
        }
    }
}

fn source_rows(built: &pg_db::BuiltListQuery, rows: &[Value]) -> Vec<Vec<pg_db::CursorValue>> {
    let Some(plan) = &built.keyset else {
        return Vec::new();
    };
    if plan.fields.len() != 2 || plan.fields[0].path != "createdAt" || plan.fields[1].path != "id" {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let created = row.get("createdAt")?.as_str()?;
            let id = row.get("id")?.as_str()?;
            Some(vec![
                pg_db::CursorValue::Date(created.to_owned()),
                pg_db::CursorValue::Text(id.to_owned()),
            ])
        })
        .collect()
}

/// `GET /internal/admin/users`.
pub async fn list_users(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let raw = raw_query(request);
    let mut built = pg_db::build_list_query(&raw, &user_spec(), &user_columns())
        .map_err(crate::auth::db_error)?;
    scope_clause(
        &mut built,
        Params::parse(request.query_string()).string("scope"),
    );
    let sql = built.select_sql("users u", USER_SELECT);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let total = pg_db::count_unless_skipped(&built, "users u", &state.pools.main)
        .await
        .map_err(crate::auth::db_error)?;
    let mut users = Vec::with_capacity(rows.len());
    for row in &rows {
        users.push(user_row(row)?);
    }
    let source = source_rows(&built, &users);
    Ok(list_response(
        "users",
        Value::Array(users),
        total,
        &built,
        &source,
    ))
}

/// `GET /internal/admin/users/summary`.
pub async fn users_summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT role::text AS role, status::text AS status, is_maker, is_checker
           FROM users
          WHERE merchant_id IS NULL",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut by_role: Map<String, Value> = Map::new();
    let mut by_status: Map<String, Value> = Map::new();
    let mut makers = 0i64;
    let mut checkers = 0i64;
    let mut four_eyes = 0i64;
    for row in &rows {
        let role: String = row
            .try_get("role")
            .map_err(crate::routes::common::database_error)?;
        let status: String = row
            .try_get("status")
            .map_err(crate::routes::common::database_error)?;
        let is_maker: bool = row
            .try_get("is_maker")
            .map_err(crate::routes::common::database_error)?;
        let is_checker: bool = row
            .try_get("is_checker")
            .map_err(crate::routes::common::database_error)?;
        let role_count = by_role.get(&role).and_then(Value::as_i64).unwrap_or(0) + 1;
        by_role.insert(role, json!(role_count));
        let status_count = by_status.get(&status).and_then(Value::as_i64).unwrap_or(0) + 1;
        by_status.insert(status, json!(status_count));
        if is_maker {
            makers += 1;
        }
        if is_checker {
            checkers += 1;
        }
        if is_maker && is_checker {
            four_eyes += 1;
        }
    }
    let count = |status: &str| by_status.get(status).and_then(Value::as_i64).unwrap_or(0);
    Ok(json!({
        "summary": {
            "total": rows.len(),
            "active": count("ACTIVE"),
            "invited": count("INVITED"),
            "suspended": count("SUSPENDED"),
            "disabled": count("DISABLED"),
            "makers": makers,
            "checkers": checkers,
            "fourEyes": four_eyes,
            "byRole": by_role,
            "byStatus": by_status,
        }
    }))
}

/// `publicProgress` subset: drops `_server` and any open exam that already expired. Catalog
/// validation of every entry is P8-T08 (`DEV` note in the module report); the user detail endpoint
/// must never expose `_server` regardless.
fn public_progress(raw: Option<Value>, now: NaiveDateTime) -> Value {
    let Some(Value::Object(mut progress)) = raw else {
        let now = iso(now);
        return json!({
            "schema": 1,
            "rev": 0,
            "startedAt": now,
            "updatedAt": now,
            "contentVersion": "1.0.0",
            "guideRead": {},
            "lessons": {},
            "labs": {},
            "exams": {},
            "badges": [],
        });
    };
    if progress.get("schema").and_then(Value::as_i64) != Some(1) {
        let now = iso(now);
        return json!({
            "schema": 1,
            "rev": 0,
            "startedAt": now,
            "updatedAt": now,
            "contentVersion": progress
                .get("contentVersion")
                .cloned()
                .unwrap_or_else(|| Value::String("1.0.0".to_owned())),
            "guideRead": {},
            "lessons": {},
            "labs": {},
            "exams": {},
            "badges": [],
        });
    }
    progress.remove("_server");
    if let Some(Value::Object(exams)) = progress.get_mut("exams") {
        for entry in exams.values_mut() {
            let expired = entry
                .get("open")
                .and_then(|open| open.get("expiresAt"))
                .and_then(Value::as_str)
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|expires| expires.naive_utc() <= now);
            if expired {
                if let Value::Object(entry) = entry {
                    entry.remove("open");
                }
            }
        }
    }
    js_json(Value::Object(progress))
}

/// `GET /internal/admin/users/:id`.
pub async fn user_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = require_uuid(last_path_segment(request.path()), "id")?;
    let row = sqlx::query(
        "SELECT id, created_at, updated_at, merchant_id, email, phone, role::text AS role,
                authorities_map, app_scope_ids, is_maker, is_checker, mfa_required,
                status::text AS status, invited_by, invitation_expires_at, academy_progress_json
           FROM users
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| ApiError::new(404, "USER_NOT_FOUND", "The user does not exist"))?;

    let user_id: Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let created_at: NaiveDateTime = row
        .try_get("created_at")
        .map_err(crate::routes::common::database_error)?;
    let updated_at: NaiveDateTime = row
        .try_get("updated_at")
        .map_err(crate::routes::common::database_error)?;
    let merchant_id: Option<Uuid> = row
        .try_get("merchant_id")
        .map_err(crate::routes::common::database_error)?;
    let email: String = row
        .try_get("email")
        .map_err(crate::routes::common::database_error)?;
    let phone: Option<String> = row
        .try_get("phone")
        .map_err(crate::routes::common::database_error)?;
    let role: String = row
        .try_get("role")
        .map_err(crate::routes::common::database_error)?;
    let authorities_map: Value = row
        .try_get("authorities_map")
        .map_err(crate::routes::common::database_error)?;
    let app_scope_ids: Option<Value> = row
        .try_get("app_scope_ids")
        .map_err(crate::routes::common::database_error)?;
    let is_maker: bool = row
        .try_get("is_maker")
        .map_err(crate::routes::common::database_error)?;
    let is_checker: bool = row
        .try_get("is_checker")
        .map_err(crate::routes::common::database_error)?;
    let mfa_required: bool = row
        .try_get("mfa_required")
        .map_err(crate::routes::common::database_error)?;
    let status: String = row
        .try_get("status")
        .map_err(crate::routes::common::database_error)?;
    let invited_by: Option<Uuid> = row
        .try_get("invited_by")
        .map_err(crate::routes::common::database_error)?;
    let invitation_expires_at: Option<NaiveDateTime> = row
        .try_get("invitation_expires_at")
        .map_err(crate::routes::common::database_error)?;
    let academy_progress_json: Option<Value> = row
        .try_get("academy_progress_json")
        .map_err(crate::routes::common::database_error)?;
    let now = chrono::Utc::now().naive_utc();

    let approvals = sqlx::query(
        "SELECT a.id, a.subject_type, a.subject_id, a.state::text AS state, a.mode::text AS mode,
                a.maker_user_id, a.checker_user_id, a.maker_reason, a.rejection_reason,
                a.created_at, a.updated_at, a.expires_at,
                m.email AS maker_email, c.email AS checker_email
           FROM approval_requests a
           JOIN users m ON m.id = a.maker_user_id
           LEFT JOIN users c ON c.id = a.checker_user_id
          WHERE a.maker_user_id = $1 OR a.checker_user_id = $1
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 25",
    )
    .bind(user_id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let audit = sqlx::query(
        "SELECT id, created_at, action, role, entity_type, entity_id, before_json, after_json,
                approval_request_id
           FROM audit_log
          WHERE actor_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 50",
    )
    .bind(user_id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let mut approval_history = Vec::with_capacity(approvals.len());
    for entry in &approvals {
        let approval_id: Uuid = entry
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let subject_type: String = entry
            .try_get("subject_type")
            .map_err(crate::routes::common::database_error)?;
        let subject_id: String = entry
            .try_get("subject_id")
            .map_err(crate::routes::common::database_error)?;
        let state: String = entry
            .try_get("state")
            .map_err(crate::routes::common::database_error)?;
        let mode: String = entry
            .try_get("mode")
            .map_err(crate::routes::common::database_error)?;
        let maker_user_id: Uuid = entry
            .try_get("maker_user_id")
            .map_err(crate::routes::common::database_error)?;
        let checker_user_id: Option<Uuid> = entry
            .try_get("checker_user_id")
            .map_err(crate::routes::common::database_error)?;
        let maker_reason: Option<String> = entry
            .try_get("maker_reason")
            .map_err(crate::routes::common::database_error)?;
        let rejection_reason: Option<String> = entry
            .try_get("rejection_reason")
            .map_err(crate::routes::common::database_error)?;
        let approval_created_at: NaiveDateTime = entry
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let approval_updated_at: NaiveDateTime = entry
            .try_get("updated_at")
            .map_err(crate::routes::common::database_error)?;
        let expires_at: Option<NaiveDateTime> = entry
            .try_get("expires_at")
            .map_err(crate::routes::common::database_error)?;
        let maker_email: String = entry
            .try_get("maker_email")
            .map_err(crate::routes::common::database_error)?;
        let checker_email: Option<String> = entry
            .try_get("checker_email")
            .map_err(crate::routes::common::database_error)?;
        approval_history.push(json!({
            "id": approval_id,
            "subjectType": subject_type,
            "subjectId": subject_id,
            "state": state,
            "mode": mode,
            "makerUserId": maker_user_id,
            "checkerUserId": checker_user_id,
            "makerReason": maker_reason,
            "rejectionReason": rejection_reason,
            "createdAt": iso(approval_created_at),
            "updatedAt": iso(approval_updated_at),
            "expiresAt": iso_or_null(expires_at),
            "maker": { "id": maker_user_id, "email": maker_email },
            "checker": checker_user_id.map_or(Value::Null, |checker_id| json!({
                "id": checker_id,
                "email": checker_email.unwrap_or_default(),
            })),
        }));
    }

    let mut audit_trail = Vec::with_capacity(audit.len());
    for entry in &audit {
        let audit_id: Uuid = entry
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let audit_created_at: NaiveDateTime = entry
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let action: String = entry
            .try_get("action")
            .map_err(crate::routes::common::database_error)?;
        let role: String = entry
            .try_get("role")
            .map_err(crate::routes::common::database_error)?;
        let entity_type: String = entry
            .try_get("entity_type")
            .map_err(crate::routes::common::database_error)?;
        let entity_id: String = entry
            .try_get("entity_id")
            .map_err(crate::routes::common::database_error)?;
        let before_json: Value = entry
            .try_get("before_json")
            .map_err(crate::routes::common::database_error)?;
        let after_json: Value = entry
            .try_get("after_json")
            .map_err(crate::routes::common::database_error)?;
        let approval_request_id: Option<Uuid> = entry
            .try_get("approval_request_id")
            .map_err(crate::routes::common::database_error)?;
        audit_trail.push(json!({
            "id": audit_id,
            "createdAt": iso(audit_created_at),
            "action": action,
            "role": role,
            "entityType": entity_type,
            "entityId": entity_id,
            "beforeJson": js_json(before_json),
            "afterJson": js_json(after_json),
            "approvalRequestId": approval_request_id,
        }));
    }

    Ok(json!({
        "user": {
            "id": user_id,
            "createdAt": iso(created_at),
            "updatedAt": iso(updated_at),
            "merchantId": merchant_id,
            "email": email,
            "phone": phone,
            "role": role,
            "authoritiesMap": js_json(authorities_map),
            "appScopeIds": app_scope_ids.map(js_json),
            "isMaker": is_maker,
            "isChecker": is_checker,
            "mfaRequired": mfa_required,
            "status": status,
            "invitedById": invited_by,
            "invitationExpiresAt": iso_or_null(invitation_expires_at),
            "academyProgressJson": public_progress(academy_progress_json, now),
        },
        "approvalHistory": approval_history,
        "auditTrail": audit_trail,
    }))
}

/// `GET /internal/admin/options/:kind`.
pub async fn options(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let kind = last_path_segment(request.path()).to_owned();
    let params = Params::parse(request.query_string());
    let required: &[&str] = if kind == "users" {
        &["user:read", "security:read"]
    } else {
        STAFF_READ_AUTHORITIES
    };
    let principal = principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })?;
    require_authorities(principal, required)?;
    let search = params.string("search");
    let pattern = search.as_ref().map(|value| format!("%{value}%"));
    let limit = js_limit(params.get("limit"), 50.0, 1.0, 100.0);
    let owner_id = params.string("ownerId");
    let mut items: Vec<Value> = Vec::new();
    match kind.as_str() {
        "merchants" => {
            let rows = sqlx::query(
                "SELECT id, trade_name, legal_name
                   FROM merchants
                  WHERE $1::text IS NULL OR trade_name ILIKE $1 OR legal_name ILIKE $1
                  ORDER BY trade_name ASC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                items.push(json!({
                    "value": row.try_get::<Uuid, _>("id").map_err(crate::routes::common::database_error)?,
                    "title": row.try_get::<String, _>("trade_name").map_err(crate::routes::common::database_error)?,
                    "subtitle": row.try_get::<String, _>("legal_name").map_err(crate::routes::common::database_error)?,
                }));
            }
        }
        "rails" => {
            let rows = sqlx::query(
                "SELECT id, code, name_en, name_ar
                   FROM rails
                  WHERE $1::text IS NULL OR code ILIKE $1 OR name_en ILIKE $1 OR name_ar ILIKE $1
                  ORDER BY code ASC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                let id: Uuid = row
                    .try_get("id")
                    .map_err(crate::routes::common::database_error)?;
                let code: String = row
                    .try_get("code")
                    .map_err(crate::routes::common::database_error)?;
                let name_en: String = row
                    .try_get("name_en")
                    .map_err(crate::routes::common::database_error)?;
                let name_ar: String = row
                    .try_get("name_ar")
                    .map_err(crate::routes::common::database_error)?;
                items.push(json!({
                    "value": id,
                    "title": format!("{name_en} ({code})"),
                    "subtitle": name_ar,
                }));
            }
        }
        "gateways" => {
            let rows = sqlx::query(
                "SELECT id, code, name
                   FROM gateways
                  WHERE $1::text IS NULL OR code ILIKE $1 OR name ILIKE $1
                  ORDER BY code ASC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                let id: Uuid = row
                    .try_get("id")
                    .map_err(crate::routes::common::database_error)?;
                let code: String = row
                    .try_get("code")
                    .map_err(crate::routes::common::database_error)?;
                let name: String = row
                    .try_get("name")
                    .map_err(crate::routes::common::database_error)?;
                items.push(json!({ "value": id, "title": format!("{name} ({code})") }));
            }
        }
        "users" => {
            let rows = sqlx::query(
                "SELECT id, email, role::text AS role
                   FROM users
                  WHERE $1::text IS NULL OR email ILIKE $1 OR phone ILIKE $1
                  ORDER BY email ASC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                items.push(json!({
                    "value": row.try_get::<Uuid, _>("id").map_err(crate::routes::common::database_error)?,
                    "title": row.try_get::<String, _>("email").map_err(crate::routes::common::database_error)?,
                    "subtitle": row.try_get::<String, _>("role").map_err(crate::routes::common::database_error)?,
                }));
            }
        }
        "applications" => {
            let rows = sqlx::query(
                "SELECT a.id, a.name, m.trade_name
                   FROM applications a
                   LEFT JOIN merchants m ON m.id = a.merchant_id
                  WHERE $1::text IS NULL OR a.name ILIKE $1
                  ORDER BY a.name ASC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                items.push(json!({
                    "value": row.try_get::<Uuid, _>("id").map_err(crate::routes::common::database_error)?,
                    "title": row.try_get::<String, _>("name").map_err(crate::routes::common::database_error)?,
                    "subtitle": row.try_get::<Option<String>, _>("trade_name").map_err(crate::routes::common::database_error)?,
                }));
            }
        }
        "wallets" => {
            let rows = sqlx::query(
                "SELECT w.id, w.currency, m.trade_name
                   FROM wallets w
                   LEFT JOIN merchants m ON m.id = w.merchant_id
                  WHERE $1::text IS NULL OR w.currency ILIKE $1
                  ORDER BY w.created_at DESC, w.id DESC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                let id: Uuid = row
                    .try_get("id")
                    .map_err(crate::routes::common::database_error)?;
                let currency: String = row
                    .try_get("currency")
                    .map_err(crate::routes::common::database_error)?;
                let trade_name: Option<String> = row
                    .try_get("trade_name")
                    .map_err(crate::routes::common::database_error)?;
                let title = format!(
                    "{} · {currency}",
                    trade_name.unwrap_or_else(|| id.to_string())
                );
                items.push(json!({ "value": id, "title": title }));
            }
        }
        "credential-sets" => {
            let rows = sqlx::query(
                "SELECT c.id, c.external_merchant_id, c.env::text AS env, g.code
                   FROM credential_sets c
                   JOIN gateways g ON g.id = c.gateway_id
                  WHERE $1::text IS NULL OR c.external_merchant_id ILIKE $1
                  ORDER BY c.created_at DESC, c.id DESC
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                let id: Uuid = row
                    .try_get("id")
                    .map_err(crate::routes::common::database_error)?;
                let external: Option<String> = row
                    .try_get("external_merchant_id")
                    .map_err(crate::routes::common::database_error)?;
                let env: String = row
                    .try_get("env")
                    .map_err(crate::routes::common::database_error)?;
                let code: String = row
                    .try_get("code")
                    .map_err(crate::routes::common::database_error)?;
                items.push(json!({
                    "value": id,
                    "title": format!("{code} · {}", external.unwrap_or_else(|| id.to_string())),
                    "subtitle": env,
                }));
            }
        }
        "gl-accounts" => {
            let rows = sqlx::query(
                "SELECT id, account_type::text AS account_type, currency, owner_id
                   FROM gl_accounts
                  WHERE ($1::text IS NULL OR (owner_id = $1 AND account_type = 'MERCHANT_WALLET'))
                  ORDER BY account_type ASC, currency ASC, id ASC
                  LIMIT $2",
            )
            .bind(&owner_id)
            .bind(limit)
            .fetch_all(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            for row in &rows {
                let id: Uuid = row
                    .try_get("id")
                    .map_err(crate::routes::common::database_error)?;
                let account_type: String = row
                    .try_get("account_type")
                    .map_err(crate::routes::common::database_error)?;
                let currency: String = row
                    .try_get("currency")
                    .map_err(crate::routes::common::database_error)?;
                let owner: Option<String> = row
                    .try_get("owner_id")
                    .map_err(crate::routes::common::database_error)?;
                let subtitle = owner
                    .map(|value| value.chars().take(12).collect::<String>())
                    .unwrap_or_else(|| id.to_string().chars().take(8).collect::<String>());
                items.push(json!({
                    "value": id,
                    "title": format!("{account_type} · {currency}"),
                    "subtitle": subtitle,
                }));
            }
        }
        _ => {
            return Err(ApiError::new(
                400,
                "UNKNOWN_OPTION_KIND",
                "Unknown option kind",
            ))
        }
    }
    let total = items.len();
    Ok(json!({ "items": items, "total": total }))
}

macro_rules! handler {
    ($name:ident, $target:path) => {
        pub fn $name<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            _principal: Option<&'a Principal>,
            _payload: ntex::web::types::Payload,
        ) -> crate::routes::HandlerFuture<'a> {
            Box::pin(async move {
                match $target(state, request).await {
                    Ok(body) => json_ok(&body),
                    Err(error) => error_response(request, error),
                }
            })
        }
    };
}

handler!(list_users_handler, list_users);
handler!(users_summary_handler, users_summary);
handler!(user_detail_handler, user_detail);

/// The options handler needs the authenticated principal for the conditional `user:read` floor.
pub fn options_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> crate::routes::HandlerFuture<'a> {
    Box::pin(async move {
        match options(state, request, principal).await {
            Ok(body) => json_ok(&body),
            Err(error) => error_response(request, error),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_progress_drops_server_state_and_expired_sessions() {
        let now = NaiveDateTime::parse_from_str("2026-11-28T12:00:00", "%Y-%m-%dT%H:%M:%S")
            .expect("date");
        let raw = json!({
            "schema": 1,
            "rev": 2,
            "contentVersion": "1.0.0",
            "exams": {
                "m0": {
                    "attempts": [],
                    "v": "1.0.0",
                    "open": { "sessionId": "s", "startedAt": "2026-11-28T11:00:00.000Z", "expiresAt": "2026-11-28T11:30:00.000Z" }
                }
            },
            "_server": { "open": { "m0": {} } }
        });
        let sanitised = public_progress(Some(raw), now);
        assert!(sanitised.get("_server").is_none());
        assert!(sanitised["exams"]["m0"].get("open").is_none());
        assert_eq!(sanitised["rev"], 2);
    }

    #[test]
    fn public_progress_fills_a_fresh_record_for_null() {
        let now = NaiveDateTime::parse_from_str("2026-11-28T12:00:00", "%Y-%m-%dT%H:%M:%S")
            .expect("date");
        let sanitised = public_progress(None, now);
        assert_eq!(sanitised["schema"], 1);
        assert_eq!(sanitised["rev"], 0);
        assert_eq!(sanitised["contentVersion"], "1.0.0");
        assert!(sanitised["badges"].as_array().is_some_and(Vec::is_empty));
    }
}
