//! Dashboard reads: `/stats/overview` and `/stats/recent-activity`.
//!
//! Port of `core-back/api/internal/admin.ts:1270-1520` and the helpers
//! `merchantPeriodLabel`/`merchantStatsSince`/`resolveReportingCurrency`. The SQL replaces the
//! Prisma aggregates one-for-one; the response object keeps the TS key order so a JSON diff of the
//! dashboard payload is empty.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{Duration, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::js_number_value;
use serde_json::{json, Map, Value};
use sqlx::Row;

use super::helpers::{
    approval_age_hours, approval_domain, effective_health, fixed_4, is_problematic_status,
    is_success_status, now_iso, period_days, period_label, rate_fixed_4,
    resolve_reporting_currency, success_rate_percent, Params,
};
use crate::http::error_response;
use crate::routes::common::json_ok;
use crate::state::AppState;
use pg_http::ApiError;

/// `GET /internal/admin/stats/overview`.
pub async fn overview(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let now = Utc::now();
    let now_naive = now.naive_utc();
    let period = period_label(params.get("period"));
    let since = now - Duration::days(period_days(period));
    let since_naive = since.naive_utc();
    let requested_currency = resolve_reporting_currency(params.get("currency"));

    let merchants = sqlx::query(
        "SELECT count(*) FILTER (WHERE status = 'ACTIVE')::bigint AS active,
                count(*) FILTER (WHERE status = 'PENDING')::bigint AS pending
           FROM merchants",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let attempt_rows = sqlx::query(
        "SELECT status::text AS status, currency,
                count(*)::bigint AS count,
                COALESCE(sum(total_charged_amount), 0)::text AS charged
           FROM payment_attempts
          WHERE created_at >= $1
          GROUP BY status, currency
          ORDER BY status, currency",
    )
    .bind(since_naive)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let gross = sqlx::query(
        "SELECT count(*)::bigint AS count,
                COALESCE(sum(total_charged_amount), 0)::text AS charged
           FROM payment_attempts
          WHERE created_at >= $1 AND status = 'SUCCEEDED' AND currency = $2",
    )
    .bind(since_naive)
    .bind(&requested_currency)
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let unknown = sqlx::query(
        "SELECT count(*)::bigint AS count, min(created_at) AS oldest
           FROM payment_attempts
          WHERE status = 'UNKNOWN'",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let approvals = sqlx::query(
        "SELECT subject_type, mode::text AS mode, created_at, expires_at, ratify_due_at
           FROM approval_requests
          WHERE state IN ('DRAFT', 'PENDING_REVIEW')
          ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let join_requests = sqlx::query(
        "SELECT count(*)::bigint AS open,
                count(*) FILTER (WHERE sla_due_at < $1)::bigint AS breaches
           FROM join_requests
          WHERE status IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED', 'PENDING_CHECKER')",
    )
    .bind(now_naive)
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let aml = sqlx::query(
        "SELECT count(*)::bigint AS open,
                count(*) FILTER (WHERE sla_due_at < $1)::bigint AS breaches
           FROM aml_cases
          WHERE status IN ('OPEN', 'IN_REVIEW', 'PENDING_CHECKER', 'FROZEN', 'ESCALATED_STR')",
    )
    .bind(now_naive)
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let operator = sqlx::query(
        "SELECT count(*)::bigint AS open,
                count(*) FILTER (WHERE priority = 'P1')::bigint AS p1,
                count(*) FILTER (WHERE sla_due_at < $1)::bigint AS breaches
           FROM operator_cases
          WHERE state IN ('OPEN', 'IN_PROGRESS', 'PENDING_CHECKER')",
    )
    .bind(now_naive)
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let routes = sqlx::query(
        "SELECT health_state::text AS health_state,
                health_computed_state::text AS computed,
                health_override_state::text AS override_state,
                health_override_expires_at AS override_expires_at
           FROM rail_routes",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let inbound = sqlx::query(
        "SELECT received_at FROM inbound_events
          WHERE processed_at IS NULL
          ORDER BY received_at ASC
          LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let reconciliation = sqlx::query(
        "SELECT result::text AS result, count(*)::bigint AS count
           FROM reconciliation_items
          WHERE created_at >= $1
          GROUP BY result
          ORDER BY result",
    )
    .bind(since_naive)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;

    let mut attempts_by_state = Map::new();
    let mut volume_by_state = Map::new();
    let mut attempts_total: i64 = 0;
    let mut attempts_succeeded: i64 = 0;
    let mut attempts_counted: i64 = 0;
    let mut per_currency: BTreeMap<String, CurrencyAggregate> = BTreeMap::new();

    for row in &attempt_rows {
        let status: String = row
            .try_get("status")
            .map_err(crate::routes::common::database_error)?;
        let currency_raw: String = row
            .try_get("currency")
            .map_err(crate::routes::common::database_error)?;
        let currency = {
            let trimmed = currency_raw.trim();
            if trimmed.is_empty() {
                "UNKNOWN".to_owned()
            } else {
                trimmed.to_owned()
            }
        };
        let count: i64 = row
            .try_get("count")
            .map_err(crate::routes::common::database_error)?;
        let charged: String = row
            .try_get("charged")
            .map_err(crate::routes::common::database_error)?;
        let charged_text = fixed_4(parse_decimal(&charged));
        let aggregate = per_currency
            .entry(currency.clone())
            .or_insert_with(|| CurrencyAggregate {
                currency: currency.clone(),
                ..CurrencyAggregate::default()
            });
        aggregate.attempts = aggregate.attempts.saturating_add(count);
        aggregate
            .volume_by_state
            .insert(status.clone(), charged_text.clone());
        if is_success_status(&status) {
            aggregate.succeeded = aggregate.succeeded.saturating_add(count);
            aggregate.counted = aggregate.counted.saturating_add(count);
        } else if is_problematic_status(&status) {
            aggregate.counted = aggregate.counted.saturating_add(count);
        }
        if currency != requested_currency {
            continue;
        }
        attempts_by_state.insert(status.clone(), json!(count));
        attempts_total = attempts_total.saturating_add(count);
        volume_by_state.insert(status.clone(), Value::String(charged_text));
        if is_success_status(&status) {
            attempts_succeeded = attempts_succeeded.saturating_add(count);
            attempts_counted = attempts_counted.saturating_add(count);
        } else if is_problematic_status(&status) {
            attempts_counted = attempts_counted.saturating_add(count);
        }
    }

    let gross_charged: String = gross
        .try_get("charged")
        .map_err(crate::routes::common::database_error)?;
    let gross_volume_attempts: i64 = gross
        .try_get("count")
        .map_err(crate::routes::common::database_error)?;
    let unknown_count: i64 = unknown
        .try_get("count")
        .map_err(crate::routes::common::database_error)?;
    let unknown_oldest: Option<NaiveDateTime> = unknown
        .try_get("oldest")
        .map_err(crate::routes::common::database_error)?;

    let mut by_domain: Vec<ApprovalDomainAge> = Vec::new();
    let mut approval_expired: i64 = 0;
    let mut approval_emergency_due: i64 = 0;
    for row in &approvals {
        let subject_type: String = row
            .try_get("subject_type")
            .map_err(crate::routes::common::database_error)?;
        let domain = approval_domain(&subject_type);
        let created_at: NaiveDateTime = row
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        if let Some(entry) = by_domain.iter_mut().find(|entry| entry.domain == domain) {
            entry.count += 1;
            if created_at < entry.oldest {
                entry.oldest = created_at;
            }
        } else {
            by_domain.push(ApprovalDomainAge {
                domain: domain.to_owned(),
                count: 1,
                oldest: created_at,
            });
        }
        let expires_at: Option<NaiveDateTime> = row
            .try_get("expires_at")
            .map_err(crate::routes::common::database_error)?;
        if expires_at.is_some_and(|value| value < now_naive) {
            approval_expired += 1;
        }
        let mode: String = row
            .try_get("mode")
            .map_err(crate::routes::common::database_error)?;
        let ratify_due_at: Option<NaiveDateTime> = row
            .try_get("ratify_due_at")
            .map_err(crate::routes::common::database_error)?;
        if mode == "EMERGENCY_RATIFICATION" && ratify_due_at.is_some_and(|value| value <= now_naive)
        {
            approval_emergency_due += 1;
        }
    }
    by_domain.sort_by_key(|entry| std::cmp::Reverse(entry.count));

    let mut route_health: BTreeMap<String, i64> = BTreeMap::new();
    let mut forced: i64 = 0;
    let mut conflicts: i64 = 0;
    for row in &routes {
        let health_state: String = row
            .try_get("health_state")
            .map_err(crate::routes::common::database_error)?;
        let computed: String = row
            .try_get("computed")
            .map_err(crate::routes::common::database_error)?;
        let override_state: Option<String> = row
            .try_get("override_state")
            .map_err(crate::routes::common::database_error)?;
        let override_expires_at: Option<NaiveDateTime> = row
            .try_get("override_expires_at")
            .map_err(crate::routes::common::database_error)?;
        let effective = effective_health(
            &computed,
            &health_state,
            override_state.as_deref(),
            override_expires_at,
            now_naive,
        );
        *route_health.entry(effective).or_insert(0) += 1;
        if override_state.is_some() && override_expires_at.is_none_or(|expires| expires > now_naive)
        {
            forced += 1;
            if health_state != computed {
                conflicts += 1;
            }
        }
    }

    let oldest_inbound: Option<NaiveDateTime> = inbound
        .as_ref()
        .map(|row| {
            row.try_get("received_at")
                .map_err(crate::routes::common::database_error)
        })
        .transpose()?;

    let mut reconciliation_matched: i64 = 0;
    let mut reconciliation_items: i64 = 0;
    for row in &reconciliation {
        let result: String = row
            .try_get("result")
            .map_err(crate::routes::common::database_error)?;
        let count: i64 = row
            .try_get("count")
            .map_err(crate::routes::common::database_error)?;
        reconciliation_items = reconciliation_items.saturating_add(count);
        if result == "MATCHED" {
            reconciliation_matched = reconciliation_matched.saturating_add(count);
        }
    }

    let join_open: i64 = join_requests
        .try_get("open")
        .map_err(crate::routes::common::database_error)?;
    let join_breaches: i64 = join_requests
        .try_get("breaches")
        .map_err(crate::routes::common::database_error)?;
    let aml_open: i64 = aml
        .try_get("open")
        .map_err(crate::routes::common::database_error)?;
    let aml_breaches: i64 = aml
        .try_get("breaches")
        .map_err(crate::routes::common::database_error)?;
    let operator_open: i64 = operator
        .try_get("open")
        .map_err(crate::routes::common::database_error)?;
    let operator_p1: i64 = operator
        .try_get("p1")
        .map_err(crate::routes::common::database_error)?;
    let operator_breaches: i64 = operator
        .try_get("breaches")
        .map_err(crate::routes::common::database_error)?;

    let active_merchants: i64 = merchants
        .try_get("active")
        .map_err(crate::routes::common::database_error)?;
    let pending_merchants: i64 = merchants
        .try_get("pending")
        .map_err(crate::routes::common::database_error)?;

    let by_currency: Vec<Value> = per_currency
        .values()
        .map(|aggregate| {
            let volume: Map<String, Value> = aggregate
                .volume_by_state
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect();
            json!({
                "currency": aggregate.currency,
                "attempts": aggregate.attempts,
                "succeeded": aggregate.succeeded,
                "counted": aggregate.counted,
                "volumeByState": Value::Object(volume),
            })
        })
        .collect();

    let ageing: Vec<Value> = by_domain
        .iter()
        .map(|entry| {
            json!({
                "domain": entry.domain,
                "count": entry.count,
                "oldestHours": approval_age_hours(entry.oldest, now_naive),
            })
        })
        .collect();

    let unknown_age = unknown_oldest
        .map(|oldest| {
            ((now_naive - oldest).num_milliseconds() as f64 / 1000.0)
                .round()
                .max(0.0)
        })
        .unwrap_or(0.0);
    let inbox_lag = oldest_inbound
        .map(|oldest| {
            ((now_naive - oldest).num_milliseconds() as f64 / 1000.0)
                .round()
                .max(0.0)
        })
        .unwrap_or(0.0);

    let body = json!({
        "period": period,
        "since": now_iso(since),
        "merchantsActive": active_merchants,
        "merchantsPending": pending_merchants,
        "currency": requested_currency,
        "byCurrency": by_currency,
        "mixedCurrency": per_currency.len() > 1,
        "attemptsByState": Value::Object(attempts_by_state),
        "volumeByState": Value::Object(volume_by_state),
        "attemptsTotal": attempts_total,
        "attemptsSucceeded": attempts_succeeded,
        "attemptsCounted": attempts_counted,
        "successRate": success_rate_percent(attempts_succeeded, attempts_counted),
        "grossVolume": fixed_4(parse_decimal(&gross_charged)),
        "grossVolumeAttempts": gross_volume_attempts,
        "unknownBacklog": unknown_count,
        "unknownOldestAgeSeconds": js_number_value(unknown_age as f64),
        "openCircuitBreakers": route_health.get("OPEN_BREAKER").copied().unwrap_or(0),
        "routeHealth": {
            "healthy": route_health.get("HEALTHY").copied().unwrap_or(0),
            "degraded": route_health.get("DEGRADED").copied().unwrap_or(0),
            "openBreaker": route_health.get("OPEN_BREAKER").copied().unwrap_or(0),
            "forced": forced,
            "conflicts": conflicts,
        },
        "webhookInboxLagSeconds": js_number_value(inbox_lag as f64),
        "reconciliationMatchRate": rate_fixed_4(reconciliation_matched, reconciliation_items),
        "reconciliationItems": reconciliation_items,
        "approvalPending": approvals.len() as i64,
        "approvalExpired": approval_expired,
        "approvalEmergencyDue": approval_emergency_due,
        "approvalQueueAgeing": ageing,
        "joinRequestOpen": join_open,
        "joinRequestSlaBreaches": join_breaches,
        "amlOpen": aml_open,
        "amlSlaBreaches": aml_breaches,
        "operatorOpen": operator_open,
        "operatorP1": operator_p1,
        "operatorSlaBreaches": operator_breaches,
    });
    Ok(body)
}

/// `GET /internal/admin/stats/recent-activity`.
pub async fn recent_activity(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    let limit = super::helpers::js_limit(params.get("limit"), 8.0, 1.0, 20.0);
    let rows = sqlx::query(
        "SELECT a.id, a.created_at, COALESCE(u.email, '') AS actor_email, a.role, a.action,
                a.entity_type, a.entity_id, a.approval_request_id
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut activity = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: uuid::Uuid = row
            .try_get("id")
            .map_err(crate::routes::common::database_error)?;
        let created_at: NaiveDateTime = row
            .try_get("created_at")
            .map_err(crate::routes::common::database_error)?;
        let actor_email: String = row
            .try_get("actor_email")
            .map_err(crate::routes::common::database_error)?;
        let role: String = row
            .try_get("role")
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
        let approval_request_id: Option<uuid::Uuid> = row
            .try_get("approval_request_id")
            .map_err(crate::routes::common::database_error)?;
        activity.push(json!({
            "id": id,
            "createdAt": super::helpers::iso(created_at),
            "actorEmail": actor_email,
            "role": role,
            "action": action,
            "entityType": entity_type,
            "entityId": entity_id,
            "approvalRequestId": approval_request_id,
        }));
    }
    Ok(json!({ "recentActivity": activity }))
}

#[derive(Default)]
struct CurrencyAggregate {
    pub currency: String,
    pub attempts: i64,
    pub succeeded: i64,
    pub counted: i64,
    pub volume_by_state: BTreeMap<String, String>,
}

struct ApprovalDomainAge {
    pub domain: String,
    pub count: i64,
    pub oldest: NaiveDateTime,
}

fn parse_decimal(raw: &str) -> rust_decimal::Decimal {
    use std::str::FromStr;
    rust_decimal::Decimal::from_str(raw.trim()).unwrap_or_default()
}

/// Handler wrapper for the dispatcher.
pub fn overview_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a pg_domain_auth::Principal>,
    _payload: ntex::web::types::Payload,
) -> crate::routes::HandlerFuture<'a> {
    Box::pin(async move {
        match overview(state, request).await {
            Ok(body) => json_ok(&body),
            Err(error) => error_response(request, error),
        }
    })
}

/// Handler wrapper for the dispatcher.
pub fn recent_activity_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a pg_domain_auth::Principal>,
    _payload: ntex::web::types::Payload,
) -> crate::routes::HandlerFuture<'a> {
    Box::pin(async move {
        match recent_activity(state, request).await {
            Ok(body) => json_ok(&body),
            Err(error) => error_response(request, error),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_aggregate_keeps_the_dashboard_scalars_zero() {
        let aggregate = CurrencyAggregate::default();
        assert_eq!(aggregate.attempts, 0);
        assert!(aggregate.volume_by_state.is_empty());
        assert_eq!(success_rate_percent(0, 0), json!(0));
        assert_eq!(rate_fixed_4(0, 0), "0.0000");
    }
}
