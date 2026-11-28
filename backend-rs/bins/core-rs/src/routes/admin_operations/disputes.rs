//! Admin dispute reads.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/disputes`, `/disputes/export`,
//! `/disputes/summary`, `/disputes/:id`, `/disputes/:id/attachments`). The byte download
//! (`/disputes/:id/attachments/:attachmentId/content`) needs the object-storage SDK and stays in
//! P4-T05; the attachment list is a database read and is ported here.

#![forbid(unsafe_code)]

use chrono::{Duration, Utc};
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    age_hours, build_list, count_list, export_envelope, fetch_list, jsonb, list_envelope, money,
    money_value, reporting_currency, require_uuid_param, text, timestamp, ts_json, uuid_json,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const OPEN_STATUSES: &[&str] = &["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"];
const EVIDENCE_PENDING_STATUSES: &[&str] = &["OPENED", "EVIDENCE_REQUESTED"];

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/disputes",
            "core-back/api/internal/admin.ts:17583",
            &["dispute:read"],
            list_handler,
        ),
        route(
            "/internal/admin/disputes/export",
            "core-back/api/internal/admin.ts:17643",
            &["dispute:read"],
            export_handler,
        ),
        route(
            "/internal/admin/disputes/summary",
            "core-back/api/internal/admin.ts:17763",
            &["dispute:read"],
            summary_handler,
        ),
        route(
            "/internal/admin/disputes/summary/export",
            "core-back/api/internal/admin.ts:17768",
            &["dispute:read"],
            summary_export_handler,
        ),
        route(
            "/internal/admin/disputes/:id/attachments",
            "core-back/api/internal/admin.ts:17924",
            &["dispute:read"],
            attachments_handler,
        ),
        route(
            "/internal/admin/disputes/:id",
            "core-back/api/internal/admin.ts:17802",
            &["dispute:read"],
            detail_handler,
        ),
    ]
}

fn route(
    path: &str,
    origin: &str,
    authorities: &[&str],
    handler: crate::routes::CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "d.id", ColumnKind::Uuid)
        .with("createdAt", "d.opened_at", ColumnKind::Timestamp)
        .with("openedAt", "d.opened_at", ColumnKind::Timestamp)
        .with("evidenceDueAt", "d.evidence_due_at", ColumnKind::Timestamp)
        .with("status", "d.status::text", ColumnKind::Text)
        .with("source", "d.source::text", ColumnKind::Text)
        .with("amount", "d.amount", ColumnKind::Decimal)
        .with(
            "externalDisputeRef",
            "d.external_dispute_ref",
            ColumnKind::Text,
        )
        .with("reasonCode", "d.reason_code", ColumnKind::Text)
        .with("attemptReference", "pa.reference", ColumnKind::Text)
        .with("merchantName", "m.trade_name", ColumnKind::Text)
        .with("railId", "d.rail_id", ColumnKind::Uuid)
        .with("gatewayId", "d.gateway_id", ColumnKind::Uuid)
        .with("attemptId", "d.attempt_id", ColumnKind::Uuid)
        .with("merchantId", "pa.merchant_id", ColumnKind::Uuid)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "externalDisputeRef",
            "reasonCode",
            "attemptReference",
            "merchantName",
        ])
        .with_in("status", "status")
        .with_in("source", "source")
        .with_equals("railId", "railId")
        .with_equals("gatewayId", "gatewayId")
        .with_equals("merchantId", "merchantId")
        .with_equals("attemptId", "attemptId")
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("openedAt", "openedAt").with_keys("openedFrom", "openedTo"))
        .with_date(
            DateFilter::new("evidenceDueAt", "evidenceDueAt").with_keys("dateFrom", "dateTo"),
        )
        .with_sortable("externalDisputeRef", "externalDisputeRef")
        .with_sortable("status", "status")
        .with_sortable("source", "source")
        .with_sortable("amount", "amount")
        .with_sortable("openedAt", "openedAt")
        .with_sortable("evidenceDueAt", "evidenceDueAt")
        .with_default_sort("openedAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

const FROM: &str = "disputes d
    JOIN payment_attempts pa ON pa.id = d.attempt_id
    JOIN merchants m ON m.id = pa.merchant_id
    JOIN rails r ON r.id = d.rail_id
    JOIN gateways g ON g.id = d.gateway_id
    LEFT JOIN rails ar ON ar.id = pa.rail_id
    LEFT JOIN adjustments adj ON adj.id = d.adjustment_id::uuid";

const PROJECTION: &str = "d.id, d.created_at, d.opened_at, d.evidence_due_at, d.outcome_at,
    d.external_dispute_ref, d.source::text AS source, d.status::text AS status, d.reason_code,
    d.amount, d.currency, d.evidence_json, d.adjustment_id::uuid AS adjustment_id,
    d.attempt_id, pa.reference AS attempt_reference, pa.status::text AS attempt_status,
    pa.settled_amount AS attempt_settled_amount,
    m.id AS merchant_id, m.trade_name AS merchant_name,
    COALESCE(ar.code, r.code) AS rail_code, COALESCE(ar.name_en, r.name_en) AS rail_name,
    g.code AS gateway_code, g.name AS gateway_name,
    adj.state::text AS adjustment_state, adj.journal_entry_id AS adjustment_journal_entry_id,
    adj.reason AS adjustment_reason";

fn evidence_submitted_at(evidence: &Value) -> Value {
    match evidence {
        Value::Object(map) => map
            .get("submittedAt")
            .filter(|value| value.is_string())
            .cloned()
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn dispute_row(row: &sqlx::postgres::PgRow) -> Value {
    let now = Utc::now();
    let due_at = timestamp(row, "evidence_due_at");
    let status = text(row, "status");
    let evidence_due_in_hours = due_at.map_or(Value::Null, |due| {
        let millis = (due - now.naive_utc()).num_milliseconds();
        Value::from((millis as f64 / 3_600_000.0).ceil() as i64)
    });
    let evidence_overdue = due_at.is_some_and(|due| due < now.naive_utc())
        && EVIDENCE_PENDING_STATUSES.contains(&status.as_str());
    json!({
        "id": uuid_json(row, "id"),
        "externalDisputeRef": text(row, "external_dispute_ref"),
        "disputeRef": text(row, "external_dispute_ref"),
        "source": text(row, "source"),
        "status": status,
        "state": status,
        "reasonCode": super::support::text_value(row, "reason_code"),
        "amount": money(row, "amount"),
        "currency": text(row, "currency"),
        "openedAt": ts_json(row, "opened_at"),
        "evidenceDueAt": ts_json(row, "evidence_due_at"),
        "outcomeAt": ts_json(row, "outcome_at"),
        "evidenceDueInHours": evidence_due_in_hours,
        "evidenceOverdue": evidence_overdue,
        "evidenceSubmittedAt": evidence_submitted_at(&jsonb(row, "evidence_json")),
        "ageHours": age_hours(timestamp(row, "opened_at"), now),
        "merchantId": uuid_json(row, "merchant_id"),
        "merchantName": super::support::opt_text(row, "merchant_name").unwrap_or_default(),
        "attemptId": uuid_json(row, "attempt_id"),
        "attemptReference": super::support::text_value(row, "attempt_reference"),
        "attemptStatus": super::support::text_value(row, "attempt_status"),
        "railCode": super::support::opt_text(row, "rail_code").unwrap_or_default(),
        "railName": super::support::opt_text(row, "rail_name").unwrap_or_default(),
        "gatewayCode": text(row, "gateway_code"),
        "gatewayName": text(row, "gateway_name"),
        "adjustmentId": uuid_json(row, "adjustment_id"),
        "adjustmentState": super::support::text_value(row, "adjustment_state"),
        "adjustmentJournalEntryId": uuid_json(row, "adjustment_journal_entry_id"),
    })
}

async fn list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &spec(), &columns())?;
    let rows = fetch_list(&state.pools.main, &built, PROJECTION, FROM, None).await?;
    let total = count_list(&state.pools.main, &built, FROM, None).await?;
    let items: Vec<Value> = rows.iter().map(dispute_row).collect();
    let response = list_envelope("disputes", Value::Array(items), total, &built);
    Ok(super::support::with_cursor(
        response,
        &built,
        &rows,
        "opened_at",
    ))
}

async fn export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &spec(), &columns())?;
    let sql = format!(
        "SELECT {PROJECTION} FROM {FROM} {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in &built.binds {
        query = match bind {
            pg_db::SqlBind::Text(value) => query.bind(value.as_str()),
            pg_db::SqlBind::Bool(value) => query.bind(*value),
        };
    }
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let total = count_list(&state.pools.main, &built, FROM, None)
        .await?
        .unwrap_or(0);
    let items: Vec<Value> = rows.iter().map(dispute_row).collect();
    Ok(export_envelope(
        "disputes",
        Value::Array(items),
        total,
        rows.len(),
    ))
}

async fn summary_value(state: &AppState, currency: &str) -> Result<Value, ApiError> {
    let now = Utc::now().naive_utc();
    let soon = now + Duration::hours(48);
    let status_rows = sqlx::query(
        "SELECT status::text AS status, count(*) AS count FROM disputes WHERE currency = $1 GROUP BY status",
    )
    .bind(currency)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let currency_rows = sqlx::query(
        "SELECT currency::text AS currency, count(*) AS count, COALESCE(SUM(amount),0) AS amount
         FROM disputes GROUP BY currency ORDER BY currency",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let open = sqlx::query(
        "SELECT count(*) AS count, COALESCE(SUM(amount),0) AS amount
         FROM disputes WHERE currency = $1 AND status::text = ANY($2::text[])",
    )
    .bind(currency)
    .bind(OPEN_STATUSES)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let overdue: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes
         WHERE currency = $1 AND status::text = ANY($2::text[]) AND evidence_due_at < $3",
    )
    .bind(currency)
    .bind(EVIDENCE_PENDING_STATUSES)
    .bind(now)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let due_soon: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes
         WHERE currency = $1 AND status::text = ANY($2::text[]) AND evidence_due_at >= $3 AND evidence_due_at <= $4",
    )
    .bind(currency)
    .bind(EVIDENCE_PENDING_STATUSES)
    .bind(now)
    .bind(soon)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let earliest = sqlx::query(
        "SELECT evidence_due_at FROM disputes
         WHERE currency = $1 AND status::text = ANY($2::text[]) AND evidence_due_at IS NOT NULL
         ORDER BY evidence_due_at ASC LIMIT 1",
    )
    .bind(currency)
    .bind(EVIDENCE_PENDING_STATUSES)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let mut by_status = serde_json::Map::new();
    for row in &status_rows {
        let count: i64 = row.try_get("count").unwrap_or_default();
        by_status.insert(text(row, "status"), Value::from(count));
    }
    let open_count: i64 = open.try_get("count").unwrap_or_default();
    Ok(json!({
        "currency": currency,
        "byCurrency": currency_rows.iter().map(|row| {
            let count: i64 = row.try_get("count").unwrap_or_default();
            json!({"currency": text(row,"currency"), "count": count, "amount": money(row,"amount")})
        }).collect::<Vec<_>>(),
        "totalOpen": open_count,
        "openAmount": money(&open, "amount"),
        "byStatus": by_status,
        "overdue": overdue,
        "dueSoon": due_soon,
        "earliestEvidenceDueAt": earliest.as_ref().map_or(Value::Null, |row| ts_json(row, "evidence_due_at")),
    }))
}

pub(super) async fn detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "DISPUTE_NOT_FOUND",
        "The dispute does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PROJECTION} FROM {FROM} WHERE d.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "DISPUTE_NOT_FOUND",
            "The dispute does not exist",
        ));
    };
    let due_at = timestamp(&row, "evidence_due_at");
    let status = text(&row, "status");
    let now = Utc::now().naive_utc();
    let evidence_open = OPEN_STATUSES.contains(&status.as_str())
        && status != "EVIDENCE_SUBMITTED"
        && due_at.is_none_or(|due| due >= now);
    let blocked = if evidence_open {
        Value::Null
    } else if status == "EVIDENCE_SUBMITTED" {
        Value::String("EVIDENCE_ALREADY_SUBMITTED".to_owned())
    } else if due_at.is_some_and(|due| due < now) {
        Value::String("EVIDENCE_WINDOW_CLOSED".to_owned())
    } else {
        Value::String("DISPUTE_NOT_OPEN".to_owned())
    };
    let mut dispute = dispute_row(&row);
    if let Some(object) = dispute.as_object_mut() {
        let settled = row
            .try_get::<Option<Decimal>, _>("attempt_settled_amount")
            .ok()
            .flatten();
        object.insert(
            "attemptSettledAmount".to_owned(),
            if settled.is_some() {
                money(&row, "attempt_settled_amount")
            } else {
                money_value(None)
            },
        );
        object.insert(
            "adjustmentReason".to_owned(),
            super::support::text_value(&row, "adjustment_reason"),
        );
        object.insert("evidenceJson".to_owned(), jsonb(&row, "evidence_json"));
        object.insert("canSubmitEvidence".to_owned(), Value::Bool(evidence_open));
        object.insert("evidenceBlockedReason".to_owned(), blocked);
    }
    Ok(json!({ "dispute": dispute }))
}

pub(super) async fn attachments(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::path_segment(request, 2).as_deref(),
        "DISPUTE_NOT_FOUND",
        "The dispute does not exist",
    )?;
    let exists: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM disputes WHERE id = $1")
        .bind(super::support::uuid_bind(&id))
        .fetch_optional(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    if exists.is_none() {
        return Err(ApiError::new(
            404,
            "DISPUTE_NOT_FOUND",
            "The dispute does not exist",
        ));
    }
    let rows = sqlx::query(
        "SELECT da.id, da.dispute_id, da.merchant_id, da.label, da.uploaded_by_id, da.created_at,
                so.original_filename, so.detected_mime_type, so.byte_size, so.sha256_hex,
                so.status::text AS status, so.av_scan_status::text AS av_scan_status
         FROM dispute_attachments da LEFT JOIN storage_objects so ON so.id = da.storage_object_id
         WHERE da.dispute_id = $1 ORDER BY da.created_at DESC",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    Ok(json!({
        "attachments": rows.iter().map(|row| json!({
            "id": uuid_json(row, "id"),
            "disputeId": uuid_json(row, "dispute_id"),
            "merchantId": uuid_json(row, "merchant_id"),
            "label": text(row, "label"),
            "uploadedById": uuid_json(row, "uploaded_by_id"),
            "createdAt": ts_json(row, "created_at"),
            "fileName": super::support::text_value(row, "original_filename"),
            "mimeType": super::support::text_value(row, "detected_mime_type"),
            "byteSize": row.try_get::<Option<i64>, _>("byte_size").ok().flatten().map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "sha256": super::support::text_value(row, "sha256_hex"),
            "status": super::support::text_value(row, "status"),
            "avScanStatus": super::support::text_value(row, "av_scan_status"),
        })).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------- handler wrappers

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

fn summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = summary_value(state, &reporting_currency(request)).await;
        result_response(request, result)
    })
}

fn summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = summary_value(state, &reporting_currency(request))
            .await
            .map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "exportedAt".to_owned(),
                        super::support::iso_required(Utc::now()),
                    );
                }
                value
            });
        result_response(request, result)
    })
}

fn detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, detail(state, request, principal).await) })
}

fn attachments_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, attachments(state, request, principal).await) })
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}
