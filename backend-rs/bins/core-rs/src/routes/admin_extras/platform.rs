//! User, dashboard-activity and platform-settings JSON exports.
//!
//! Ports `admin.ts:1689` (`/users/export`), `admin.ts:1780` (`/users/summary/export`),
//! `admin.ts:1277` (`/stats/recent-activity/export`), `admin.ts:20477` (`/settings/export`),
//! `admin.ts:20548` (`/settings/summary/export`) and `admin.ts:19858`
//! (`/settings/checkout-support/summary/export`).
//!
//! Each route reproduces the TS list spec (`search`/`in`/`equals`/`dates`/`sort`), the `take: 5000`
//! or `limit` snapshot, the exact envelope and the `writeAudit` side effect. Platform-setting
//! secrets never leave in the export: `smtpPassword`, `webhookSecret` and `clientSecret` become
//! `"<redacted>"` (`redactSettingSecretsForExport`).

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::state::AppState;

use super::support::{
    build_page, checklist, col_bool, col_date, col_i32, col_json, col_opt_date, col_opt_text,
    col_opt_uuid, col_text, col_uuid, database_error, date_iso, filters_json, object, query_string,
    write_audit,
};

const USERS_FROM: &str = "users";

fn users_columns() -> ColumnMap {
    ColumnMap::new()
        .with("email", "email", ColumnKind::Text)
        .with("phone", "phone", ColumnKind::Text)
        .with("role", "role::text", ColumnKind::Text)
        .with("status", "status::text", ColumnKind::Text)
        .with("merchantId", "merchant_id", ColumnKind::Uuid)
        .with("createdAt", "created_at", ColumnKind::Timestamp)
}

fn users_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["email", "phone"])
        .with_in("status", "status")
        .with_equals("role", "role")
        .with_equals("merchantId", "merchantId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("email", "email")
        .with_sortable("role", "role")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
}

fn user_export_row(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("email", Value::String(col_text(row, "email")?)),
        (
            "phone",
            col_opt_text(row, "phone")?.map_or(Value::Null, Value::String),
        ),
        ("role", Value::String(col_text(row, "role")?)),
        (
            "merchantId",
            col_opt_uuid(row, "merchant_id")?.map_or(Value::Null, Value::String),
        ),
        ("authoritiesMap", col_json(row, "authorities_map")?),
        ("status", Value::String(col_text(row, "status")?)),
        ("isMaker", Value::Bool(col_bool(row, "is_maker")?)),
        ("isChecker", Value::Bool(col_bool(row, "is_checker")?)),
        ("mfaRequired", Value::Bool(col_bool(row, "mfa_required")?)),
        (
            "invitationExpiresAt",
            col_opt_date(row, "invitation_expires_at")?.map_or(Value::Null, Value::String),
        ),
        ("createdAt", Value::String(col_date(row, "created_at")?)),
        ("updatedAt", Value::String(col_date(row, "updated_at")?)),
    ]))
}

/// `GET /internal/admin/users/export` (`admin.ts:1689`).
pub(crate) async fn users_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_page(request, &users_spec(), &users_columns())?;
    let scope = query_string(request, "scope")
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let mut where_sql = built.where_sql.clone();
    match scope.as_str() {
        "admin" => where_sql = and_sql(&where_sql, "merchant_id IS NULL"),
        "merchant" => where_sql = and_sql(&where_sql, "merchant_id IS NOT NULL"),
        _ => {}
    }
    let sql = format!(
        "SELECT * FROM users {where_sql} ORDER BY {} LIMIT 5000",
        built.order_by_sql
    );
    let rows = super::support::bind_where(&sql, &built)
        .fetch_all(&state.pools.main)
        .await
        .map_err(database_error)?;
    let count_sql = format!("SELECT count(*) FROM {USERS_FROM} {where_sql}");
    let total: i64 = super::support::bind_where(&count_sql, &built)
        .fetch_one(&state.pools.main)
        .await
        .map_err(database_error)?
        .get(0);
    let items = rows
        .iter()
        .map(user_export_row)
        .collect::<Result<Vec<_>, _>>()?;
    let exported = items.len();
    let allowed = [
        "USER_SCOPE_REVIEWED",
        "ACCESS_DATA_REVIEWED",
        "EXPORT_AUTHORITY_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "ADMIN_USERS_EXPORTED",
        "USER",
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
        ("users", Value::Array(items)),
        ("total", Value::from(total)),
        ("exported", Value::from(exported)),
        ("truncated", Value::Bool(total > exported as i64)),
    ]))
}

fn and_sql(where_sql: &str, predicate: &str) -> String {
    if where_sql.trim().is_empty() {
        format!("WHERE {predicate}")
    } else {
        format!("{where_sql} AND {predicate}")
    }
}

async fn user_summary(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT role::text AS role, status::text AS status, is_maker, is_checker
           FROM users WHERE merchant_id IS NULL",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let mut by_role: Map<String, Value> = Map::new();
    let mut by_status: Map<String, Value> = Map::new();
    let mut makers = 0_i64;
    let mut checkers = 0_i64;
    let mut four_eyes = 0_i64;
    for row in &rows {
        let role = col_text(row, "role")?;
        let status = col_text(row, "status")?;
        increment(&mut by_role, &role);
        increment(&mut by_status, &status);
        let maker = col_bool(row, "is_maker")?;
        let checker = col_bool(row, "is_checker")?;
        if maker {
            makers += 1;
        }
        if checker {
            checkers += 1;
        }
        if maker && checker {
            four_eyes += 1;
        }
    }
    let active = by_status.get("ACTIVE").and_then(Value::as_i64).unwrap_or(0);
    let invited = by_status
        .get("INVITED")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let suspended = by_status
        .get("SUSPENDED")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let disabled = by_status
        .get("DISABLED")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Ok(object(vec![(
        "summary",
        object(vec![
            ("total", Value::from(rows.len() as i64)),
            ("active", Value::from(active)),
            ("invited", Value::from(invited)),
            ("suspended", Value::from(suspended)),
            ("disabled", Value::from(disabled)),
            ("makers", Value::from(makers)),
            ("checkers", Value::from(checkers)),
            ("fourEyes", Value::from(four_eyes)),
            ("byRole", Value::Object(by_role)),
            ("byStatus", Value::Object(by_status)),
        ]),
    )]))
}

fn increment(map: &mut Map<String, Value>, key: &str) {
    let current = map.get(key).and_then(Value::as_i64).unwrap_or(0);
    map.insert(key.to_owned(), Value::from(current + 1));
}

/// `GET /internal/admin/users/summary/export` (`admin.ts:1780`).
pub(crate) async fn users_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = user_summary(state).await?;
    let summary = snapshot.get("summary").cloned().unwrap_or(Value::Null);
    let allowed = [
        "ACCESS_SCOPE_VERIFIED",
        "ROLE_STATUS_REVIEWED",
        "MAKER_CHECKER_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "INTERNAL_USER_SUMMARY_EXPORTED",
        "USER",
        "summary",
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "active": summary.get("active").cloned().unwrap_or(Value::Null),
            "invited": summary.get("invited").cloned().unwrap_or(Value::Null),
            "makers": summary.get("makers").cloned().unwrap_or(Value::Null),
            "checkers": summary.get("checkers").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    with_exported_at(snapshot)
}

fn with_exported_at(mut value: Value) -> Result<Value, ApiError> {
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "exportedAt".to_owned(),
            Value::String(date_iso(chrono::Utc::now())),
        );
        Ok(value)
    } else {
        Err(ApiError::server_error())
    }
}

/// `Math.min(Math.max(Math.trunc(n), 1), max)` with the TS `Number()` coercion; a non-finite
/// value falls back to the default.
fn js_limit(raw: Option<String>, default: i64, max: i64) -> i64 {
    let Some(raw) = raw else {
        return default;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 1;
    }
    match trimmed.parse::<f64>() {
        Ok(value) if value.is_finite() => (value.trunc() as i64).clamp(1, max),
        _ => default,
    }
}

/// `GET /internal/admin/stats/recent-activity/export` (`admin.ts:1277`).
pub(crate) async fn recent_activity_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let limit = js_limit(query_string(request, "limit"), 200, 5000);
    let rows = sqlx::query(
        "SELECT a.id, a.created_at, COALESCE(u.email, '') AS actor_email, a.role, a.action,
                a.entity_type, a.entity_id, a.approval_request_id
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.created_at DESC
          LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let items = rows
        .iter()
        .map(|row| {
            Ok(object(vec![
                ("id", Value::String(col_uuid(row, "id")?)),
                ("createdAt", Value::String(col_date(row, "created_at")?)),
                ("actorEmail", Value::String(col_text(row, "actor_email")?)),
                ("role", Value::String(col_text(row, "role")?)),
                ("action", Value::String(col_text(row, "action")?)),
                ("entityType", Value::String(col_text(row, "entity_type")?)),
                ("entityId", Value::String(col_text(row, "entity_id")?)),
                (
                    "approvalRequestId",
                    col_opt_uuid(row, "approval_request_id")?.map_or(Value::Null, Value::String),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let exported = items.len();
    let allowed = [
        "ACTIVITY_SCOPE_VERIFIED",
        "ACTORS_REVIEWED",
        "SECURITY_SCOPE_CONFIRMED",
        "EXPORT_AUDIT_ACKNOWLEDGED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "DASHBOARD_RECENT_ACTIVITY_EXPORTED",
        "AUDIT_LOG",
        "dashboard-recent-activity",
        json!({ "exported": exported, "checklist": checklist }),
    )
    .await?;
    Ok(object(vec![
        ("recentActivity", Value::Array(items)),
        ("exported", Value::from(exported)),
        ("exportedAt", Value::String(date_iso(chrono::Utc::now()))),
    ]))
}

/* ---------------------------------------------------------------- settings */

const SECRET_FIELDS: &[(&str, &[&str])] = &[
    ("communication.email", &["smtpPassword"]),
    ("communication.sms", &["webhookSecret"]),
    ("auth.google", &["clientSecret"]),
];

fn redact_settings_row(key: &str, value_json: &Value) -> Value {
    let secret_fields = SECRET_FIELDS
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, fields)| *fields)
        .unwrap_or(&[]);
    if secret_fields.is_empty() {
        return value_json.clone();
    }
    let Some(source) = value_json.as_object() else {
        return value_json.clone();
    };
    let mut value = source.clone();
    for field in secret_fields {
        if value.contains_key(*field) {
            value.insert((*field).to_owned(), Value::String("<redacted>".to_owned()));
        }
    }
    Value::Object(value)
}

/// `GET /internal/admin/settings/export` (`admin.ts:20477`).
pub(crate) async fn settings_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT key, scope, version, value_json, effective_from, updated_at
           FROM platform_settings ORDER BY key ASC, scope ASC, version DESC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let mut latest: Map<String, Value> = Map::new();
    for row in &rows {
        let scope = col_text(row, "scope")?;
        let key = col_text(row, "key")?;
        let map_key = format!("{scope}:{key}");
        if latest.contains_key(&map_key) {
            continue;
        }
        let value_json = col_json(row, "value_json")?;
        latest.insert(
            map_key,
            object(vec![
                ("key", Value::String(key.clone())),
                ("scope", Value::String(scope)),
                ("version", Value::from(col_i32(row, "version")?)),
                ("valueJson", redact_settings_row(&key, &value_json)),
                (
                    "effectiveFrom",
                    Value::String(col_date(row, "effective_from")?),
                ),
                ("updatedAt", Value::String(col_date(row, "updated_at")?)),
            ]),
        );
    }
    let exported_at = date_iso(chrono::Utc::now());
    let keys = latest.len();
    let versions = rows.len();
    let allowed = [
        "SETTINGS_SCOPE_VERIFIED",
        "SENSITIVE_VALUES_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "PLATFORM_SETTINGS_EXPORTED",
        "PLATFORM_SETTING",
        "export",
        json!({
            "keys": keys,
            "versions": versions,
            "exportedAt": exported_at,
            "checklist": checklist,
        }),
    )
    .await?;
    Ok(object(vec![
        ("exportedAt", Value::String(exported_at)),
        ("keys", Value::from(keys as i64)),
        ("versions", Value::from(versions as i64)),
        ("settings", Value::Array(latest.into_values().collect())),
    ]))
}

async fn settings_summary(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT key, scope, version, effective_from, updated_at
           FROM platform_settings ORDER BY key ASC, version DESC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let now = chrono::Utc::now();
    let mut latest: std::collections::BTreeMap<String, (String, String)> =
        std::collections::BTreeMap::new();
    let mut scopes: Map<String, Value> = Map::new();
    for row in &rows {
        let key = col_text(row, "key")?;
        let scope = col_text(row, "scope")?;
        increment(&mut scopes, &scope);
        latest.entry(key).or_insert((
            col_date(row, "effective_from")?,
            col_date(row, "updated_at")?,
        ));
    }
    let future_effective = latest
        .values()
        .filter(|(effective_from, _)| {
            chrono::DateTime::parse_from_rfc3339(effective_from)
                .map(|value| value.with_timezone(&chrono::Utc) > now)
                .unwrap_or(false)
        })
        .count();
    let updated_last_24h = latest
        .values()
        .filter(|(_, updated_at)| {
            chrono::DateTime::parse_from_rfc3339(updated_at)
                .map(|value| {
                    now.with_timezone(&chrono::Utc) - value.with_timezone(&chrono::Utc)
                        <= chrono::Duration::hours(24)
                })
                .unwrap_or(false)
        })
        .count();
    Ok(object(vec![(
        "summary",
        object(vec![
            ("keys", Value::from(latest.len() as i64)),
            ("versions", Value::from(rows.len() as i64)),
            ("scopes", Value::Object(scopes)),
            ("futureEffective", Value::from(future_effective as i64)),
            ("updatedLast24h", Value::from(updated_last_24h as i64)),
        ]),
    )]))
}

/// `GET /internal/admin/settings/summary/export` (`admin.ts:20548`).
pub(crate) async fn settings_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = settings_summary(state).await?;
    let summary = snapshot.get("summary").cloned().unwrap_or(Value::Null);
    let allowed = [
        "SETTINGS_SCOPE_VERIFIED",
        "VERSIONS_REVIEWED",
        "EFFECTIVE_DATES_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "PLATFORM_SETTINGS_SUMMARY_EXPORTED",
        "PLATFORM_SETTING",
        "summary",
        json!({
            "keys": summary.get("keys").cloned().unwrap_or(Value::Null),
            "versions": summary.get("versions").cloned().unwrap_or(Value::Null),
            "futureEffective": summary.get("futureEffective").cloned().unwrap_or(Value::Null),
            "updatedLast24h": summary.get("updatedLast24h").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    with_exported_at(snapshot)
}

const CHECKOUT_SUPPORT_KEY: &str = "checkout.support_config";

async fn checkout_support_summary(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT version, value_json, effective_from, updated_at
           FROM platform_settings WHERE key = $1 ORDER BY version DESC",
    )
    .bind(CHECKOUT_SUPPORT_KEY)
    .fetch_all(&state.pools.main)
    .await
    .map_err(database_error)?;
    let latest = rows.first();
    let value = latest
        .map(|row| col_json(row, "value_json"))
        .transpose()?
        .unwrap_or(Value::Null);
    let channels: Vec<Value> = ["support_phone", "support_whatsapp", "support_email"]
        .iter()
        .filter(|key| {
            value
                .get(**key)
                .and_then(Value::as_str)
                .is_some_and(|entry| !entry.trim().is_empty())
        })
        .map(|key| Value::String((*key).to_owned()))
        .collect();
    let faq_items = value
        .get("faq_items")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let effective_from = match latest {
        Some(row) => col_date(row, "effective_from")?,
        None => String::new(),
    };
    let updated_at = match latest {
        Some(row) => col_date(row, "updated_at")?,
        None => String::new(),
    };
    let future_effective = latest.is_some_and(|_| {
        chrono::DateTime::parse_from_rfc3339(&effective_from)
            .map(|value| value.with_timezone(&chrono::Utc) > chrono::Utc::now())
            .unwrap_or(false)
    });
    Ok(object(vec![(
        "summary",
        object(vec![
            (
                "enabled",
                Value::Bool(value.get("enabled").and_then(Value::as_bool) == Some(true)),
            ),
            (
                "showPlatformContact",
                Value::Bool(
                    value
                        .get("show_platform_contact")
                        .is_none_or(|entry| entry != &Value::Bool(false)),
                ),
            ),
            (
                "showMerchantContact",
                Value::Bool(
                    value
                        .get("show_merchant_contact")
                        .is_none_or(|entry| entry != &Value::Bool(false)),
                ),
            ),
            ("faqItems", Value::from(faq_items as i64)),
            ("channels", Value::Array(channels.clone())),
            ("channelCount", Value::from(channels.len() as i64)),
            ("versions", Value::from(rows.len() as i64)),
            (
                "currentVersion",
                latest.map_or(Value::from(0), |row| {
                    col_i32(row, "version")
                        .map(Value::from)
                        .unwrap_or(Value::from(0))
                }),
            ),
            (
                "updatedAt",
                if updated_at.is_empty() {
                    Value::Null
                } else {
                    Value::String(updated_at)
                },
            ),
            (
                "effectiveFrom",
                if effective_from.is_empty() {
                    Value::Null
                } else {
                    Value::String(effective_from)
                },
            ),
            ("futureEffective", Value::Bool(future_effective)),
        ]),
    )]))
}

/// `GET /internal/admin/settings/checkout-support/summary/export` (`admin.ts:19858`).
pub(crate) async fn checkout_support_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = checkout_support_summary(state).await?;
    let summary = snapshot.get("summary").cloned().unwrap_or(Value::Null);
    let allowed = [
        "CHECKOUT_SCOPE_VERIFIED",
        "FAQ_AND_CHANNELS_REVIEWED",
        "EXPORT_APPROVAL_CONFIRMED",
    ];
    let checklist = checklist(request, &allowed);
    write_audit(
        state,
        principal,
        "CHECKOUT_SUPPORT_SUMMARY_EXPORTED",
        "PLATFORM_SETTING",
        CHECKOUT_SUPPORT_KEY,
        json!({
            "enabled": summary.get("enabled").cloned().unwrap_or(Value::Null),
            "versions": summary.get("versions").cloned().unwrap_or(Value::Null),
            "currentVersion": summary.get("currentVersion").cloned().unwrap_or(Value::Null),
            "faqItems": summary.get("faqItems").cloned().unwrap_or(Value::Null),
            "channelCount": summary.get("channelCount").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    with_exported_at(snapshot)
}
