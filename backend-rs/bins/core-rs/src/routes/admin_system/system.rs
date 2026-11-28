//! System monitors: background jobs, the event outbox, the audit outbox, notifications and
//! notification templates, plus the Jobs & Outbox summary.
//!
//! Port of `core-back/api/internal/adminSystem.ts` and the ledger automation block of
//! `/system/jobs-outbox/summary`. Payloads are deliberately not selected (`payloadJson` in jobs and
//! notifications, `beforeJson`/`afterJson` in the audit outbox), exactly like the TS selects.

#![forbid(unsafe_code)]

use chrono::{Duration, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::list_response;
use pg_http::ApiError;
use serde_json::{json, Value};
use sqlx::Row;

use super::helpers::{
    append_clause, append_in_text, append_search, boolean_filter, enum_list_filter,
    extract_template_variables, iso, iso_or_null, iso_tz, iso_tz_or_null, raw_query, Params,
};
use crate::http::error_response;
use crate::routes::common::json_ok;
use crate::state::AppState;

const JOB_STATES: &[&str] = &["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"];
const JOB_TYPES: &[&str] = &[
    "RECONCILIATION_RUN",
    "ADJUSTMENT_EXECUTION",
    "REFUND_INQUIRY",
];
const NOTIFICATION_STATUSES: &[&str] = &["QUEUED", "SENT", "DELIVERED", "FAILED", "SUPPRESSED"];
const CHANNELS: &[&str] = &["SMS", "EMAIL", "IN_APP"];
const LANGS: &[&str] = &["AR", "EN"];
const LAST_ERROR_LIMIT: usize = 1_000;

/// `GET /internal/admin/system/jobs-outbox/summary`.
pub async fn jobs_outbox_summary(
    state: &AppState,
    _request: &HttpRequest,
) -> Result<Value, ApiError> {
    let since = Utc::now().naive_utc() - Duration::hours(24);
    let unpublished: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM outbox_events WHERE processed_at IS NULL")
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
    let oldest_outbox: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
        "SELECT created_at FROM outbox_events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let audit_queued: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM audit_outbox WHERE shipped_at IS NULL")
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
    let oldest_audit: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
        "SELECT created_at FROM audit_outbox WHERE shipped_at IS NULL ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let job_rows = sqlx::query(
        "SELECT state::text AS state, count(*)::bigint AS count
           FROM background_jobs
          WHERE created_at >= $1
          GROUP BY state
          ORDER BY state",
    )
    .bind(since)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut jobs = [
        ("QUEUED", 0i64),
        ("RUNNING", 0),
        ("SUCCEEDED", 0),
        ("FAILED", 0),
    ];
    for row in &job_rows {
        let state: String = row
            .try_get("state")
            .map_err(crate::routes::common::database_error)?;
        let count: i64 = row
            .try_get("count")
            .map_err(crate::routes::common::database_error)?;
        if let Some(entry) = jobs.iter_mut().find(|(name, _)| *name == state) {
            entry.1 = count;
        }
    }
    let failed_notifications: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM notifications WHERE status = 'FAILED'")
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "unpublishedOutbox": unpublished,
        "oldestUnpublishedOutboxAt": iso_tz_or_null(oldest_outbox),
        "auditOutboxQueued": audit_queued,
        "oldestAuditOutboxAt": iso_tz_or_null(oldest_audit),
        "jobs24h": {
            "queued": jobs[0].1,
            "running": jobs[1].1,
            "succeeded": jobs[2].1,
            "failed": jobs[3].1,
        },
        "failedNotifications": failed_notifications,
        "ledger": ledger_automation_stats(state).await?,
    }))
}

async fn ledger_automation_stats(state: &AppState) -> Result<Value, ApiError> {
    let row = sqlx::query(
        "SELECT COUNT(*) FILTER (WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0))::int AS shards_behind,
                COALESCE(MAX(s.line_seq - COALESCE(c.checkpoint_seq, 0)), 0)::text AS max_pending_lines,
                MIN(c.checkpoint_at) FILTER (WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0)) AS oldest_pending_checkpoint_at,
                COUNT(*) FILTER (WHERE c.status <> 'OK')::int AS failed_shards,
                COUNT(*)::int AS shards
           FROM gl_account_shards s
           LEFT JOIN gl_shard_checkpoints c
             ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let shards: i32 = row
        .try_get("shards")
        .map_err(crate::routes::common::database_error)?;
    let shards_behind: i32 = row
        .try_get("shards_behind")
        .map_err(crate::routes::common::database_error)?;
    let max_pending_lines: String = row
        .try_get("max_pending_lines")
        .map_err(crate::routes::common::database_error)?;
    let oldest_pending: Option<chrono::DateTime<Utc>> = row
        .try_get("oldest_pending_checkpoint_at")
        .map_err(crate::routes::common::database_error)?;
    let failed: i32 = row
        .try_get("failed_shards")
        .map_err(crate::routes::common::database_error)?;
    let last_scaled = sqlx::query(
        "SELECT id, shard_count, shard_scaled_at
           FROM gl_accounts
          WHERE shard_scaled_at IS NOT NULL
          ORDER BY shard_scaled_at DESC
          LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let last_scaling = match last_scaled {
        None => Value::Null,
        Some(row) => {
            let id: uuid::Uuid = row
                .try_get("id")
                .map_err(crate::routes::common::database_error)?;
            let shard_count: i16 = row
                .try_get("shard_count")
                .map_err(crate::routes::common::database_error)?;
            let at: Option<chrono::DateTime<Utc>> = row
                .try_get("shard_scaled_at")
                .map_err(crate::routes::common::database_error)?;
            json!({ "glAccountId": id, "shardCount": shard_count, "at": iso_tz_or_null(at) })
        }
    };
    Ok(json!({
        "shards": shards,
        "shardsBehind": shards_behind,
        "maxPendingLines": max_pending_lines,
        "oldestPendingCheckpointAt": iso_tz_or_null(oldest_pending),
        "failedShards": failed,
        "lastScaling": last_scaling,
    }))
}

fn job_columns() -> pg_db::ColumnMap {
    pg_db::ColumnMap::new()
        .with("id", "j.id", pg_db::ColumnKind::Uuid)
        .with("state", "j.state::text", pg_db::ColumnKind::Text)
        .with("jobType", "j.job_type::text", pg_db::ColumnKind::Text)
        .with(
            "availableAt",
            "j.available_at",
            pg_db::ColumnKind::Timestamp,
        )
        .with("attempts", "j.attempts", pg_db::ColumnKind::Integer)
        .with("createdAt", "j.created_at", pg_db::ColumnKind::Timestamp)
}

fn job_item(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: uuid::Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let created_at: NaiveDateTime = row
        .try_get("created_at")
        .map_err(crate::routes::common::database_error)?;
    let updated_at: NaiveDateTime = row
        .try_get("updated_at")
        .map_err(crate::routes::common::database_error)?;
    let job_type: String = row
        .try_get("job_type")
        .map_err(crate::routes::common::database_error)?;
    let reference_type: String = row
        .try_get("reference_type")
        .map_err(crate::routes::common::database_error)?;
    let reference_id: String = row
        .try_get("reference_id")
        .map_err(crate::routes::common::database_error)?;
    let state: String = row
        .try_get("state")
        .map_err(crate::routes::common::database_error)?;
    let attempts: i32 = row
        .try_get("attempts")
        .map_err(crate::routes::common::database_error)?;
    let max_attempts: i32 = row
        .try_get("max_attempts")
        .map_err(crate::routes::common::database_error)?;
    let available_at: NaiveDateTime = row
        .try_get("available_at")
        .map_err(crate::routes::common::database_error)?;
    let locked_at: Option<NaiveDateTime> = row
        .try_get("locked_at")
        .map_err(crate::routes::common::database_error)?;
    let last_error: Option<String> = row
        .try_get("last_error")
        .map_err(crate::routes::common::database_error)?;
    let completed_at: Option<NaiveDateTime> = row
        .try_get("completed_at")
        .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "id": id,
        "jobType": job_type,
        "referenceType": reference_type,
        "referenceId": reference_id,
        "state": state,
        "attempts": attempts,
        "maxAttempts": max_attempts,
        "availableAt": iso(available_at),
        "lockedAt": iso_or_null(locked_at),
        "lastError": last_error.map(|value| value.chars().take(LAST_ERROR_LIMIT).collect::<String>()),
        "completedAt": iso_or_null(completed_at),
        "createdAt": iso(created_at),
        "updatedAt": iso(updated_at),
    }))
}

/// `GET /internal/admin/system/jobs`.
pub async fn jobs(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let states = enum_list_filter(&params, "state", JOB_STATES)?;
    let types = enum_list_filter(&params, "jobType", JOB_TYPES)?;
    let raw = raw_query(request);
    let mut spec = pg_db::ListSpec::default()
        .with_date(pg_db::DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("state", "state")
        .with_sortable("availableAt", "availableAt")
        .with_sortable("attempts", "attempts")
        .with_default_sort("createdAt", pg_db::SortDirection::Desc)
        .with_default_page_size(25.0);
    if states.is_some() {
        spec = spec.with_in("state", "state");
    }
    if types.is_some() {
        spec = spec.with_in("jobType", "jobType");
    }
    let mut built =
        pg_db::build_list_query(&raw, &spec, &job_columns()).map_err(crate::auth::db_error)?;
    if let Some(search) = params.string("search") {
        append_search(
            &mut built,
            &["j.reference_id", "j.reference_type"],
            &["j.id"],
            &search,
        );
    }
    let sql = built.select_sql(
        "background_jobs j",
        &[
            "j.id AS id",
            "j.created_at AS created_at",
            "j.updated_at AS updated_at",
            "j.job_type::text AS job_type",
            "j.reference_type AS reference_type",
            "j.reference_id AS reference_id",
            "j.state::text AS state",
            "j.attempts AS attempts",
            "j.max_attempts AS max_attempts",
            "j.available_at AS available_at",
            "j.locked_at AS locked_at",
            "j.last_error AS last_error",
            "j.completed_at AS completed_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let total = pg_db::count_unless_skipped(&built, "background_jobs j", &state.pools.main)
        .await
        .map_err(crate::auth::db_error)?;
    let mut jobs = Vec::with_capacity(rows.len());
    for row in &rows {
        jobs.push(job_item(row)?);
    }
    let source: Vec<Vec<pg_db::CursorValue>> = jobs
        .iter()
        .filter_map(|row| {
            Some(vec![
                pg_db::CursorValue::Date(row.get("createdAt")?.as_str()?.to_owned()),
                pg_db::CursorValue::Text(row.get("id")?.as_str()?.to_owned()),
            ])
        })
        .collect();
    Ok(list_response(
        "jobs",
        Value::Array(jobs),
        total,
        &built,
        &source,
    ))
}

/// `GET /internal/admin/system/outbox`.
pub async fn outbox(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let published = boolean_filter(&params, "published")?;
    let raw = raw_query(request);
    let spec = pg_db::ListSpec::default()
        .with_date(pg_db::DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("topic", "topic")
        .with_equals("topic", "topic")
        .with_equals("aggregateType", "aggregateType")
        .with_default_sort("createdAt", pg_db::SortDirection::Desc)
        .with_default_page_size(25.0);
    let columns = pg_db::ColumnMap::new()
        .with("id", "o.id", pg_db::ColumnKind::BigInt)
        .with("topic", "o.topic", pg_db::ColumnKind::Text)
        .with("aggregateType", "o.aggregate_type", pg_db::ColumnKind::Text)
        .with("createdAt", "o.created_at", pg_db::ColumnKind::Timestamptz);
    let mut built =
        pg_db::build_list_query(&raw, &spec, &columns).map_err(crate::auth::db_error)?;
    match published {
        Some(true) => append_clause(&mut built, "o.processed_at IS NOT NULL"),
        Some(false) => append_clause(&mut built, "o.processed_at IS NULL"),
        None => {}
    }
    if let Some(search) = params.string("search") {
        append_search(&mut built, &["o.aggregate_id", "o.topic"], &[], &search);
    }
    let sql = built.select_sql(
        "outbox_events o",
        &[
            "o.id AS id",
            "o.topic AS topic",
            "o.aggregate_type AS aggregate_type",
            "o.aggregate_id AS aggregate_id",
            "o.merchant_id AS merchant_id",
            "o.created_at AS created_at",
            "o.processed_at AS processed_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let total = pg_db::count_unless_skipped(&built, "outbox_events o", &state.pools.main)
        .await
        .map_err(crate::auth::db_error)?;
    let now = Utc::now();
    let mut events = Vec::with_capacity(rows.len());
    let mut source = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: i64 = row
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let topic: String = row
            .try_get("topic")
            .map_err(crate::routes::common::database_error)?;
        let aggregate_type: String = row
            .try_get("aggregate_type")
            .map_err(crate::routes::common::database_error)?;
        let aggregate_id: String = row
            .try_get("aggregate_id")
            .map_err(crate::routes::common::database_error)?;
        let merchant_id: Option<uuid::Uuid> = row
            .try_get("merchant_id")
            .map_err(crate::routes::common::database_error)?;
        let created_at: chrono::DateTime<Utc> = row
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let processed_at: Option<chrono::DateTime<Utc>> = row
            .try_get("processed_at")
            .map_err(crate::routes::common::database_error)?;
        events.push(json!({
            "id": id.to_string(),
            "topic": topic,
            "aggregateType": aggregate_type,
            "aggregateId": aggregate_id,
            "merchantId": merchant_id,
            "createdAt": iso_tz(created_at),
            "processedAt": iso_tz_or_null(processed_at),
            "published": processed_at.is_some(),
            "ageSeconds": processed_at.map_or_else(
                || Value::from(((now - created_at).num_milliseconds() as f64 / 1000.0).round().max(0.0) as i64),
                |_| Value::Null,
            ),
        }));
        source.push(vec![
            pg_db::CursorValue::Date(iso_tz(created_at)),
            pg_db::CursorValue::Numeric(id.to_string()),
        ]);
    }
    Ok(list_response(
        "outbox",
        Value::Array(events),
        total,
        &built,
        &source,
    ))
}

/// `GET /internal/admin/system/audit-outbox`.
pub async fn audit_outbox(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let shipped = boolean_filter(&params, "shipped")?;
    let raw = raw_query(request);
    let spec = pg_db::ListSpec::default()
        .with_date(pg_db::DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("action", "action")
        .with_equals("action", "action")
        .with_equals("entityType", "entityType")
        .with_default_sort("createdAt", pg_db::SortDirection::Desc)
        .with_default_page_size(25.0);
    let columns = pg_db::ColumnMap::new()
        .with("id", "a.id", pg_db::ColumnKind::Uuid)
        .with("action", "a.action", pg_db::ColumnKind::Text)
        .with("entityType", "a.entity_type", pg_db::ColumnKind::Text)
        .with("createdAt", "a.created_at", pg_db::ColumnKind::Timestamptz);
    let mut built =
        pg_db::build_list_query(&raw, &spec, &columns).map_err(crate::auth::db_error)?;
    match shipped {
        Some(true) => append_clause(&mut built, "a.shipped_at IS NOT NULL"),
        Some(false) => append_clause(&mut built, "a.shipped_at IS NULL"),
        None => {}
    }
    if let Some(search) = params.string("search") {
        append_search(&mut built, &["a.action", "a.entity_id"], &["a.id"], &search);
    }
    let sql = built.select_sql(
        "audit_outbox a",
        &[
            "a.id AS id",
            "a.action AS action",
            "a.entity_type AS entity_type",
            "a.entity_id AS entity_id",
            "a.actor_id AS actor_id",
            "a.role AS role",
            "a.created_at AS created_at",
            "a.shipped_at AS shipped_at",
            "a.lease_until AS lease_until",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let total = pg_db::count_unless_skipped(&built, "audit_outbox a", &state.pools.main)
        .await
        .map_err(crate::auth::db_error)?;
    let mut out = Vec::with_capacity(rows.len());
    let mut source = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: uuid::Uuid = row
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let action: String = row
            .try_get("action")
            .map_err(crate::routes::common::database_error)?;
        let entity_type: String = row
            .try_get("entity_type")
            .map_err(crate::routes::common::database_error)?;
        let entity_id: String = row
            .try_get("entity_id")
            .map_err(crate::routes::common::database_error)?;
        let actor_id: uuid::Uuid = row
            .try_get("actor_id")
            .map_err(crate::routes::common::database_error)?;
        let role: String = row
            .try_get("role")
            .map_err(crate::routes::common::database_error)?;
        let created_at: chrono::DateTime<Utc> = row
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let shipped_at: Option<chrono::DateTime<Utc>> = row
            .try_get("shipped_at")
            .map_err(crate::routes::common::database_error)?;
        let lease_until: Option<chrono::DateTime<Utc>> = row
            .try_get("lease_until")
            .map_err(crate::routes::common::database_error)?;
        out.push(json!({
            "id": id,
            "action": action,
            "entityType": entity_type,
            "entityId": entity_id,
            "actorId": actor_id,
            "role": role,
            "createdAt": iso_tz(created_at),
            "shippedAt": iso_tz_or_null(shipped_at),
            "leaseUntil": iso_tz_or_null(lease_until),
            "shipped": shipped_at.is_some(),
        }));
        source.push(vec![
            pg_db::CursorValue::Date(iso_tz(created_at)),
            pg_db::CursorValue::Text(id.to_string()),
        ]);
    }
    Ok(list_response(
        "auditOutbox",
        Value::Array(out),
        total,
        &built,
        &source,
    ))
}

/// `GET /internal/admin/system/notifications`.
pub async fn notifications(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let status_raw = params.string("status");
    let statuses = if status_raw.as_deref() == Some("ALL") {
        None
    } else {
        match enum_list_filter(&params, "status", NOTIFICATION_STATUSES)? {
            Some(values) => Some(values),
            None => Some(vec!["FAILED".to_owned()]),
        }
    };
    let channels = enum_list_filter(&params, "channel", CHANNELS)?;
    let langs = enum_list_filter(&params, "lang", LANGS)?;
    let raw = raw_query(request);
    let mut spec = pg_db::ListSpec::default()
        .with_date(pg_db::DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("status", "status")
        .with_sortable("attempts", "attempts")
        .with_sortable("templateCode", "templateCode")
        .with_default_sort("createdAt", pg_db::SortDirection::Desc)
        .with_default_page_size(25.0);
    if channels.is_some() {
        spec = spec.with_in("channel", "channel");
    }
    if langs.is_some() {
        spec = spec.with_in("lang", "lang");
    }
    if params.string("templateCode").is_some() {
        spec = spec.with_contains("templateCode", &["templateCode"]);
    }
    let columns = pg_db::ColumnMap::new()
        .with("id", "n.id", pg_db::ColumnKind::Uuid)
        .with("status", "n.status::text", pg_db::ColumnKind::Text)
        .with("channel", "n.channel::text", pg_db::ColumnKind::Text)
        .with("lang", "n.lang::text", pg_db::ColumnKind::Text)
        .with("templateCode", "n.template_code", pg_db::ColumnKind::Text)
        .with("attempts", "n.attempts", pg_db::ColumnKind::Integer)
        .with("createdAt", "n.created_at", pg_db::ColumnKind::Timestamp)
        .with(
            "recipientUserId",
            "n.recipient_user_id",
            pg_db::ColumnKind::Uuid,
        )
        .with(
            "recipientMerchantId",
            "n.recipient_merchant_id",
            pg_db::ColumnKind::Uuid,
        );
    let mut built =
        pg_db::build_list_query(&raw, &spec, &columns).map_err(crate::auth::db_error)?;
    if let Some(statuses) = &statuses {
        append_in_text(&mut built, "n.status::text", statuses);
    }
    if let Some(search) = params.string("search") {
        append_search(
            &mut built,
            &["n.template_code", "n.address_masked", "n.event_id"],
            &["n.id", "n.recipient_user_id", "n.recipient_merchant_id"],
            &search,
        );
    }
    let sql = built.select_sql(
        "notifications n",
        &[
            "n.id AS id",
            "n.created_at AS created_at",
            "n.updated_at AS updated_at",
            "n.event_id AS event_id",
            "n.recipient_user_id AS recipient_user_id",
            "n.recipient_merchant_id AS recipient_merchant_id",
            "n.address_masked AS address_masked",
            "n.template_code AS template_code",
            "n.channel::text AS channel",
            "n.lang::text AS lang",
            "n.status::text AS status",
            "n.provider_message_id AS provider_message_id",
            "n.attempts AS attempts",
            "n.next_attempt_at AS next_attempt_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let total = pg_db::count_unless_skipped(&built, "notifications n", &state.pools.main)
        .await
        .map_err(crate::auth::db_error)?;
    let mut out = Vec::with_capacity(rows.len());
    let mut source = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: uuid::Uuid = row
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let created_at: NaiveDateTime = row
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let updated_at: NaiveDateTime = row
            .try_get("updated_at")
            .map_err(crate::routes::common::database_error)?;
        let event_id: String = row
            .try_get("event_id")
            .map_err(crate::routes::common::database_error)?;
        let recipient_user_id: Option<uuid::Uuid> = row
            .try_get("recipient_user_id")
            .map_err(crate::routes::common::database_error)?;
        let recipient_merchant_id: Option<uuid::Uuid> = row
            .try_get("recipient_merchant_id")
            .map_err(crate::routes::common::database_error)?;
        let address_masked: String = row
            .try_get("address_masked")
            .map_err(crate::routes::common::database_error)?;
        let template_code: String = row
            .try_get("template_code")
            .map_err(crate::routes::common::database_error)?;
        let channel: String = row
            .try_get("channel")
            .map_err(crate::routes::common::database_error)?;
        let lang: String = row
            .try_get("lang")
            .map_err(crate::routes::common::database_error)?;
        let status: String = row
            .try_get("status")
            .map_err(crate::routes::common::database_error)?;
        let provider_message_id: Option<String> = row
            .try_get("provider_message_id")
            .map_err(crate::routes::common::database_error)?;
        let attempts: i32 = row
            .try_get("attempts")
            .map_err(crate::routes::common::database_error)?;
        let next_attempt_at: Option<NaiveDateTime> = row
            .try_get("next_attempt_at")
            .map_err(crate::routes::common::database_error)?;
        out.push(json!({
            "id": id,
            "createdAt": iso(created_at),
            "updatedAt": iso(updated_at),
            "eventId": event_id,
            "recipientUserId": recipient_user_id,
            "recipientMerchantId": recipient_merchant_id,
            "addressMasked": address_masked,
            "templateCode": template_code,
            "channel": channel,
            "lang": lang,
            "status": status,
            "providerMessageId": provider_message_id,
            "attempts": attempts,
            "nextAttemptAt": iso_or_null(next_attempt_at),
        }));
        source.push(vec![
            pg_db::CursorValue::Date(iso(created_at)),
            pg_db::CursorValue::Text(id.to_string()),
        ]);
    }
    Ok(list_response(
        "notifications",
        Value::Array(out),
        total,
        &built,
        &source,
    ))
}

fn template_variables(subject: Option<&str>, body: &str) -> Vec<String> {
    let mut names = Vec::new();
    for name in extract_template_variables(subject.unwrap_or(""))
        .into_iter()
        .chain(extract_template_variables(body))
    {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

fn template_item(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: uuid::Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let created_at: NaiveDateTime = row
        .try_get("created_at")
        .map_err(crate::routes::common::database_error)?;
    let updated_at: NaiveDateTime = row
        .try_get("updated_at")
        .map_err(crate::routes::common::database_error)?;
    let code: String = row
        .try_get("code")
        .map_err(crate::routes::common::database_error)?;
    let channel: String = row
        .try_get("channel")
        .map_err(crate::routes::common::database_error)?;
    let lang: String = row
        .try_get("lang")
        .map_err(crate::routes::common::database_error)?;
    let subject: Option<String> = row
        .try_get("subject_template")
        .map_err(crate::routes::common::database_error)?;
    let body: String = row
        .try_get("body_template")
        .map_err(crate::routes::common::database_error)?;
    let confidentiality: String = row
        .try_get("confidentiality_class")
        .map_err(crate::routes::common::database_error)?;
    let version: i32 = row
        .try_get("version")
        .map_err(crate::routes::common::database_error)?;
    let active: bool = row
        .try_get("active")
        .map_err(crate::routes::common::database_error)?;
    let variables = template_variables(subject.as_deref(), &body);
    Ok(json!({
        "id": id,
        "code": code,
        "channel": channel,
        "lang": lang,
        "subjectTemplate": subject,
        "bodyTemplate": body,
        "confidentialityClass": confidentiality,
        "version": version,
        "active": active,
        "variables": variables,
        "createdAt": iso(created_at),
        "updatedAt": iso(updated_at),
    }))
}

/// `GET /internal/admin/settings/notification-templates`.
pub async fn notification_templates(
    state: &AppState,
    request: &HttpRequest,
) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let history = boolean_filter(&params, "history")?.unwrap_or(false);
    let channels = enum_list_filter(&params, "channel", CHANNELS)?;
    let langs = enum_list_filter(&params, "lang", LANGS)?;
    let active = boolean_filter(&params, "active")?;
    let raw = raw_query(request);
    let mut spec = pg_db::ListSpec::default()
        .with_sortable("code", "code")
        .with_sortable("channel", "channel")
        .with_sortable("lang", "lang")
        .with_sortable("version", "version")
        .with_sortable("updatedAt", "updatedAt")
        .with_default_sort("code", pg_db::SortDirection::Asc)
        .with_default_sort("channel", pg_db::SortDirection::Asc)
        .with_default_sort("lang", pg_db::SortDirection::Asc)
        .with_default_sort("version", pg_db::SortDirection::Desc)
        .with_default_page_size(50.0);
    if channels.is_some() {
        spec = spec.with_in("channel", "channel");
    }
    if langs.is_some() {
        spec = spec.with_in("lang", "lang");
    }
    if params.string("code").is_some() {
        spec = spec.with_contains("code", &["code"]);
    }
    let columns = pg_db::ColumnMap::new()
        .with("id", "t.id", pg_db::ColumnKind::Uuid)
        .with("code", "t.code", pg_db::ColumnKind::Text)
        .with("channel", "t.channel::text", pg_db::ColumnKind::Text)
        .with("lang", "t.lang::text", pg_db::ColumnKind::Text)
        .with("version", "t.version", pg_db::ColumnKind::Integer)
        .with("active", "t.active", pg_db::ColumnKind::Bool)
        .with("updatedAt", "t.updated_at", pg_db::ColumnKind::Timestamp);
    let mut built =
        pg_db::build_list_query(&raw, &spec, &columns).map_err(crate::auth::db_error)?;
    match (history, active) {
        (true, Some(true)) => append_clause(&mut built, "t.active = TRUE"),
        (true, Some(false)) => append_clause(&mut built, "t.active = FALSE"),
        (false, _) => append_clause(&mut built, "t.active = TRUE"),
        (true, None) => {}
    }
    if let Some(search) = params.string("search") {
        append_search(
            &mut built,
            &["t.code", "t.subject_template", "t.body_template"],
            &["t.id"],
            &search,
        );
    }
    let sql = built.select_sql(
        "notification_templates t",
        &[
            "t.id AS id",
            "t.created_at AS created_at",
            "t.updated_at AS updated_at",
            "t.code AS code",
            "t.channel::text AS channel",
            "t.lang::text AS lang",
            "t.subject_template AS subject_template",
            "t.body_template AS body_template",
            "t.confidentiality_class::text AS confidentiality_class",
            "t.version AS version",
            "t.active AS active",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let total = pg_db::count_unless_skipped(&built, "notification_templates t", &state.pools.main)
        .await
        .map_err(crate::auth::db_error)?;
    let mut templates = Vec::with_capacity(rows.len());
    for row in &rows {
        templates.push(template_item(row)?);
    }
    Ok(list_response(
        "templates",
        Value::Array(templates),
        total,
        &built,
        &[],
    ))
}

macro_rules! handler {
    ($name:ident, $target:path) => {
        pub fn $name<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            _principal: Option<&'a pg_domain_auth::Principal>,
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

handler!(jobs_outbox_summary_handler, jobs_outbox_summary);
handler!(jobs_handler, jobs);
handler!(outbox_handler, outbox);
handler!(audit_outbox_handler, audit_outbox);
handler!(notifications_handler, notifications);
handler!(notification_templates_handler, notification_templates);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_variables_are_deduplicated_in_document_order() {
        let names = template_variables(Some("Hello {{name}}"), "{{code}} {{name}}");
        assert_eq!(names, vec!["name".to_owned(), "code".to_owned()]);
    }
}
