//! Gateway status-inquiry schedules (list, summary, detail + audit trail).
//!
//! Ports `admin.ts:11398-11996`: the shared include, `flattenGatewayInquiry` and the three GET
//! routes. A schedule is joined to its operator case, attempt, merchant, rail, route, gateway and
//! gateway version exactly like the Prisma include, so the flattened payload carries the same
//! nullable fields and action flags.

#![forbid(unsafe_code)]

use chrono::{NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_http::ApiError;
use serde_json::{Map, Value};
use sqlx::Row;

use super::super::common;
use super::{
    build_page, col_date, col_i32, col_i64, col_json, col_opt_date, col_opt_decimal, col_opt_text,
    col_opt_uuid, col_text, col_uuid, decimal_json, get_json, list_body, not_found, object,
    uuid_param,
};
use crate::state::AppState;

const FROM: &str = "gateway_inquiry_schedules s
    LEFT JOIN operator_cases oc ON oc.id = s.operator_case_id
    LEFT JOIN payment_attempts oca ON oca.id = oc.attempt_id
    LEFT JOIN reconciliation_items ri ON ri.id = oc.reconciliation_item_id
    LEFT JOIN payment_attempts a ON a.id = s.attempt_id
    LEFT JOIN merchants m ON m.id = a.merchant_id
    LEFT JOIN rails r ON r.id = a.rail_id
    LEFT JOIN rail_routes rr ON rr.id = a.route_id
    LEFT JOIN gateways g ON g.id = rr.gateway_id
    LEFT JOIN gateway_versions gv ON gv.id = a.gateway_version_id
    LEFT JOIN gateway_settings gs ON gs.gateway_version_id = gv.id
    LEFT JOIN users sb ON sb.id = s.scheduled_by_user_id
    LEFT JOIN users cb ON cb.id = s.cancelled_by_user_id";

const COLUMNS: &str = "s.id, s.created_at, s.updated_at, s.attempt_id, s.operator_case_id,
    s.source::text AS source, s.status::text AS status, s.scheduled_by_user_id, s.reason,
    s.checklist, s.previous_next_check_at, s.window_started_at, s.next_run_at, s.last_run_at,
    s.attempts, s.last_result, s.last_error, s.completed_at, s.cancelled_at,
    s.cancelled_by_user_id, s.cancel_reason,
    oc.state::text AS case_state, oc.priority::text AS case_priority, oc.kind::text AS case_kind,
    oc.sla_due_at AS case_sla_due_at,
    oca.reference AS case_attempt_reference, ri.our_reference AS case_our_reference,
    ri.provider_reference AS case_provider_reference,
    sb.email AS scheduled_by_email, cb.email AS cancelled_by_email,
    a.reference AS attempt_reference, a.status::text AS attempt_status, a.substatus AS attempt_substatus,
    a.terminal_at, a.next_check_at, a.created_at AS attempt_created_at,
    a.total_charged_amount, a.currency::text AS attempt_currency,
    a.provider_reference AS attempt_provider_reference,
    m.id AS merchant_id, m.trade_name, m.legal_name,
    r.code AS rail_code, r.name_en AS rail_name,
    g.id AS gateway_id, g.code AS gateway_code, g.name AS gateway_name,
    gs.supports_status_check";

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "s.id::text", ColumnKind::Text)
        .with("attempt.reference", "a.reference", ColumnKind::Text)
        .with(
            "attempt.providerReference",
            "a.provider_reference",
            ColumnKind::Text,
        )
        .with(
            "attempt.merchant.tradeName",
            "m.trade_name",
            ColumnKind::Text,
        )
        .with(
            "attempt.merchant.legalName",
            "m.legal_name",
            ColumnKind::Text,
        )
        .with(
            "operatorCaseId",
            "s.operator_case_id::text",
            ColumnKind::Text,
        )
        .with("attemptId", "s.attempt_id", ColumnKind::Uuid)
        .with("gatewayId", "g.id", ColumnKind::Uuid)
        .with("status", "s.status::text", ColumnKind::Text)
        .with("source", "s.source::text", ColumnKind::Text)
        .with("createdAt", "s.created_at", ColumnKind::Timestamp)
        .with("nextRunAt", "s.next_run_at", ColumnKind::Timestamp)
        .with("lastRunAt", "s.last_run_at", ColumnKind::Timestamp)
        .with("attempts", "s.attempts", ColumnKind::Integer)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "id",
            "attempt.reference",
            "attempt.providerReference",
            "attempt.merchant.tradeName",
            "attempt.merchant.legalName",
            "operatorCaseId",
        ])
        .with_contains("attemptReference", &["attempt.reference"])
        .with_contains(
            "merchantName",
            &["attempt.merchant.tradeName", "attempt.merchant.legalName"],
        )
        .with_contains("providerReference", &["attempt.providerReference"])
        .with_in("status", "status")
        .with_in("source", "source")
        .with_equals("attemptId", "attemptId")
        .with_equals("operatorCaseId", "operatorCaseId")
        .with_equals("gatewayId", "gatewayId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("nextRunAt", "nextRunAt").with_keys("nextRunFrom", "nextRunTo"))
        .with_sortable("status", "status")
        .with_sortable("source", "source")
        .with_sortable("scheduledAt", "createdAt")
        .with_sortable("nextRunAt", "nextRunAt")
        .with_sortable("lastRunAt", "lastRunAt")
        .with_sortable("attempts", "attempts")
        .with_default_sort("status", SortDirection::Asc)
        .with_default_sort("createdAt", SortDirection::Desc)
}

fn is_active(status: &str) -> bool {
    matches!(status, "SCHEDULED" | "RUNNING" | "RETRYING")
}

fn terminal_status(status: &str) -> bool {
    matches!(
        status,
        "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED" | "BLOCKED"
    )
}

fn due_in_past(value: NaiveDateTime, now: NaiveDateTime) -> bool {
    value <= now
}

/// `flattenGatewayInquiry`.
fn flatten(row: &sqlx::postgres::PgRow, now: NaiveDateTime) -> Result<Value, ApiError> {
    let status = col_text(row, "status")?;
    let attempt_status = col_opt_text(row, "attempt_status")?.unwrap_or_default();
    let terminal_at = row
        .try_get::<Option<NaiveDateTime>, _>("terminal_at")
        .ok()
        .flatten();
    let attempt_terminal = terminal_at.is_some() || terminal_status(&attempt_status);
    let next_run_at = row
        .try_get::<Option<NaiveDateTime>, _>("next_run_at")
        .ok()
        .flatten();
    let active = is_active(&status);
    let overdue = active && next_run_at.is_some_and(|next| due_in_past(next, now));
    let can_cancel = matches!(status.as_str(), "SCHEDULED" | "RETRYING") && !attempt_terminal;
    let can_retry =
        matches!(status.as_str(), "FAILED" | "EXPIRED" | "CANCELLED") && !attempt_terminal;

    let case_ref = col_opt_text(row, "case_attempt_reference")?
        .or(col_opt_text(row, "case_our_reference")?)
        .or(col_opt_text(row, "case_provider_reference")?)
        .or(col_opt_uuid(row, "operator_case_id")?);

    let merchant_name = col_opt_text(row, "trade_name")?
        .filter(|value| !value.is_empty())
        .or(col_opt_text(row, "legal_name")?)
        .unwrap_or_default();

    Ok(object(vec![
        ("id", Value::String(col_uuid(row, "id")?)),
        ("status", Value::String(status)),
        ("source", Value::String(col_text(row, "source")?)),
        (
            "operatorCaseId",
            col_opt_uuid(row, "operator_case_id")?.map_or(Value::Null, Value::String),
        ),
        ("caseRef", case_ref.map_or(Value::Null, Value::String)),
        (
            "caseState",
            col_opt_text(row, "case_state")?.map_or(Value::Null, Value::String),
        ),
        (
            "casePriority",
            col_opt_text(row, "case_priority")?.map_or(Value::Null, Value::String),
        ),
        (
            "caseType",
            col_opt_text(row, "case_kind")?.map_or(Value::Null, Value::String),
        ),
        ("attemptId", Value::String(col_uuid(row, "attempt_id")?)),
        (
            "attemptReference",
            col_opt_text(row, "attempt_reference")?.map_or(Value::Null, Value::String),
        ),
        (
            "attemptStatus",
            col_opt_text(row, "attempt_status")?.map_or(Value::Null, Value::String),
        ),
        (
            "attemptSubstatus",
            col_opt_text(row, "attempt_substatus")?.map_or(Value::Null, Value::String),
        ),
        ("attemptTerminal", Value::Bool(attempt_terminal)),
        (
            "merchantId",
            col_opt_uuid(row, "merchant_id")?.map_or(Value::Null, Value::String),
        ),
        ("merchantName", Value::String(merchant_name)),
        (
            "railCode",
            col_opt_text(row, "rail_code")?.map_or(Value::Null, Value::String),
        ),
        (
            "railName",
            col_opt_text(row, "rail_name")?.map_or(Value::Null, Value::String),
        ),
        (
            "gatewayId",
            col_opt_uuid(row, "gateway_id")?.map_or(Value::Null, Value::String),
        ),
        (
            "gatewayCode",
            col_opt_text(row, "gateway_code")?.map_or(Value::Null, Value::String),
        ),
        (
            "gatewayName",
            col_opt_text(row, "gateway_name")?.map_or(Value::Null, Value::String),
        ),
        (
            "gatewaySupportsStatusCheck",
            Value::Bool(
                row.try_get::<Option<bool>, _>("supports_status_check")
                    .ok()
                    .flatten()
                    .unwrap_or(false),
            ),
        ),
        (
            "amount",
            decimal_json(col_opt_decimal(row, "total_charged_amount")?),
        ),
        (
            "currency",
            col_opt_text(row, "attempt_currency")?.map_or(Value::Null, Value::String),
        ),
        (
            "providerReference",
            col_opt_text(row, "attempt_provider_reference")?.map_or(Value::Null, Value::String),
        ),
        (
            "scheduledByEmail",
            col_opt_text(row, "scheduled_by_email")?.map_or(Value::Null, Value::String),
        ),
        ("scheduledAt", Value::String(col_date(row, "created_at")?)),
        (
            "previousNextCheckAt",
            col_opt_date(row, "previous_next_check_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "windowStartedAt",
            col_opt_date(row, "window_started_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "nextRunAt",
            col_opt_date(row, "next_run_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "lastRunAt",
            col_opt_date(row, "last_run_at")?.map_or(Value::Null, Value::String),
        ),
        ("attempts", Value::from(col_i32(row, "attempts")?)),
        (
            "lastResult",
            col_opt_text(row, "last_result")?.map_or(Value::Null, Value::String),
        ),
        (
            "lastError",
            col_opt_text(row, "last_error")?.map_or(Value::Null, Value::String),
        ),
        (
            "completedAt",
            col_opt_date(row, "completed_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "cancelledAt",
            col_opt_date(row, "cancelled_at")?.map_or(Value::Null, Value::String),
        ),
        (
            "cancelledByEmail",
            col_opt_text(row, "cancelled_by_email")?.map_or(Value::Null, Value::String),
        ),
        (
            "cancelReason",
            col_opt_text(row, "cancel_reason")?.map_or(Value::Null, Value::String),
        ),
        ("isOverdue", Value::Bool(overdue)),
        ("canCancel", Value::Bool(can_cancel)),
        ("canRunNow", Value::Bool(can_cancel)),
        ("canRetry", Value::Bool(can_retry)),
    ]))
}

get_json!(list, inquiry_list);
async fn inquiry_list(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let built = build_page(request, &spec(), &columns())?;
    let sql = built.select_sql(FROM, &[COLUMNS]);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(common::database_error)?;
    let total: i64 = built
        .bind_count(&built.count_sql(FROM))
        .fetch_one(&state.pools.main)
        .await
        .map(|row| row.get::<i64, _>(0))
        .map_err(common::database_error)?;
    let now = Utc::now().naive_utc();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(flatten(row, now)?);
    }
    Ok(list_body("schedules", items, total, &built))
}

get_json!(summary, inquiry_summary);
async fn inquiry_summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT status::text AS key, count(*) AS count FROM gateway_inquiry_schedules GROUP BY status",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let mut by_status = Map::new();
    let mut total = 0_i64;
    for row in &rows {
        let count = col_i64(row, "count")?;
        total += count;
        by_status.insert(col_text(row, "key")?, Value::from(count));
    }
    let overdue: i64 = sqlx::query(
        "SELECT count(*) FROM gateway_inquiry_schedules
          WHERE status IN ('SCHEDULED', 'RETRYING') AND next_run_at <= $1",
    )
    .bind(Utc::now().naive_utc())
    .fetch_one(&state.pools.main)
    .await
    .map(|row| row.get::<i64, _>(0))
    .map_err(common::database_error)?;
    let count = |key: &str| by_status.get(key).and_then(Value::as_i64).unwrap_or(0);
    Ok(object(vec![(
        "summary",
        object(vec![
            ("total", Value::from(total)),
            ("scheduled", Value::from(count("SCHEDULED"))),
            ("running", Value::from(count("RUNNING"))),
            ("retrying", Value::from(count("RETRYING"))),
            ("completed", Value::from(count("COMPLETED"))),
            ("failed", Value::from(count("FAILED"))),
            ("cancelled", Value::from(count("CANCELLED"))),
            ("expired", Value::from(count("EXPIRED"))),
            ("overdue", Value::from(overdue)),
            ("byStatus", Value::Object(by_status)),
        ]),
    )]))
}

get_json!(detail, inquiry_detail);
async fn inquiry_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = uuid_param(request, "id", 0)?;
    let sql = format!("SELECT {COLUMNS} FROM {FROM} WHERE s.id = $1");
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&state.pools.main)
        .await
        .map_err(common::database_error)?
        .ok_or_else(|| {
            not_found(
                "GATEWAY_INQUIRY_NOT_FOUND",
                "The gateway inquiry schedule does not exist",
            )
        })?;
    let schedule = flatten(&row, Utc::now().naive_utc())?;

    let audit_rows = sqlx::query(
        "SELECT a.id, a.created_at, a.updated_at, a.actor_id, a.role, a.action, a.entity_type,
                a.entity_id, a.before_json, a.after_json, a.approval_request_id,
                u.id AS actor_user_id, u.email AS actor_email, u.role::text AS actor_role
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = 'GATEWAY_INQUIRY' AND a.entity_id = $1
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 200",
    )
    .bind(id.to_string())
    .fetch_all(&state.pools.main)
    .await
    .map_err(common::database_error)?;
    let mut audit_trail = Vec::with_capacity(audit_rows.len());
    for audit in &audit_rows {
        let mut entry = Map::new();
        entry.insert("id".to_owned(), Value::String(col_uuid(audit, "id")?));
        entry.insert(
            "createdAt".to_owned(),
            Value::String(col_date(audit, "created_at")?),
        );
        entry.insert(
            "updatedAt".to_owned(),
            Value::String(col_date(audit, "updated_at")?),
        );
        entry.insert(
            "actorId".to_owned(),
            Value::String(col_uuid(audit, "actor_id")?),
        );
        entry.insert("role".to_owned(), Value::String(col_text(audit, "role")?));
        entry.insert(
            "action".to_owned(),
            Value::String(col_text(audit, "action")?),
        );
        entry.insert(
            "entityType".to_owned(),
            Value::String(col_text(audit, "entity_type")?),
        );
        entry.insert(
            "entityId".to_owned(),
            Value::String(col_text(audit, "entity_id")?),
        );
        entry.insert("beforeJson".to_owned(), col_json(audit, "before_json")?);
        entry.insert("afterJson".to_owned(), col_json(audit, "after_json")?);
        entry.insert(
            "approvalRequestId".to_owned(),
            col_opt_uuid(audit, "approval_request_id")?.map_or(Value::Null, Value::String),
        );
        let actor = match col_opt_uuid(audit, "actor_user_id")? {
            Some(actor_id) => object(vec![
                ("id", Value::String(actor_id)),
                (
                    "email",
                    col_opt_text(audit, "actor_email")?.map_or(Value::Null, Value::String),
                ),
                (
                    "role",
                    col_opt_text(audit, "actor_role")?.map_or(Value::Null, Value::String),
                ),
            ]),
            None => Value::Null,
        };
        entry.insert("actor".to_owned(), actor);
        audit_trail.push(Value::Object(entry));
    }

    Ok(object(vec![
        ("schedule", schedule),
        ("auditTrail", Value::Array(audit_trail)),
    ]))
}
