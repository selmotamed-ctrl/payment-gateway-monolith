//! Admin transaction list, summary and the upgraded payment-attempt detail.
//!
//! Sources: `core-back/api/internal/adminOperations.ts` (`/transactions`,
//! `/transactions/summary`, `/transactions/summary/export`, `/attempts/:id`) and the shared helpers
//! in `adminSliceHelpers.ts`.
//!
//! Parity decisions:
//!
//! - the list applies the same status/rail/gateway/merchant/application/currency/amount/date
//!   filters, the same `SUPPORT` redaction and the same inquiry-eligibility computation as TS;
//! - the detail keeps the legacy `attempt` key (the ciphertext column is never selected), renders
//!   money as `Money4` and re-applies the vault redaction markers the TS route relies on (the
//!   columns are already redacted at write time; the Rust view does not decrypt them);
//! - `GET /attempts/:id` uses the shared `:id` template matcher; an invalid or unknown id is a
//!   typed 404 exactly like `requireUuidParam`.

#![forbid(unsafe_code)]

use chrono::{Duration, Utc};
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    assert_decimal_query, build_list, count_list, enum_list_filter, fetch_list, is_support,
    list_envelope, money, money_opt, query_string, require_uuid_param, text, timestamp, ts_json,
    uuid_json, uuid_list_filter, uuid_value, ExtraBind, ExtraFilter,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const SETTLED_STATUSES: &[&str] = &["SUCCEEDED"];
const IN_FLIGHT_STATUSES: &[&str] = &[
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
];
const FAILED_STATUSES: &[&str] = &["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"];
const ATTEMPT_STATUSES: &[&str] = &[
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
];

const ATTEMPT_REDACTED_FIELDS: &[&str] = &[
    "amounts",
    "providerReference",
    "networkReference",
    "gatewayReference",
    "ledgerEntryId",
];

const MERCHANT_BRIEF: &str =
    "jsonb_build_object('id', m.id, 'tradeName', m.trade_name, 'legalName', m.legal_name)";
const GATEWAY_BRIEF: &str = "jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name)";

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/transactions/summary",
            "core-back/api/internal/adminOperations.ts:73",
            &["attempt:read", "merchant:read", "finance:read"],
            summary_handler,
        ),
        route(
            "/internal/admin/transactions/summary/export",
            "core-back/api/internal/adminOperations.ts:78",
            &["attempt:read", "merchant:read", "finance:read"],
            summary_export_handler,
        ),
        route(
            "/internal/admin/transactions",
            "core-back/api/internal/adminOperations.ts:105",
            &["attempt:read", "merchant:read", "finance:read"],
            list_handler,
        ),
        route(
            "/internal/admin/attempts/:id",
            "core-back/api/internal/adminOperations.ts:538",
            &["attempt:read"],
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

// ---------------------------------------------------------------- summary

async fn transaction_summary(state: &AppState) -> Result<Value, ApiError> {
    let since = Utc::now().naive_utc() - Duration::hours(24);
    let rows = sqlx::query(
        "SELECT status::text AS status, count(*) AS count
         FROM payment_attempts WHERE created_at >= $1 GROUP BY status",
    )
    .bind(since)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let mut counts: Map<String, Value> = Map::new();
    for row in &rows {
        let status = text(row, "status");
        let count: i64 = row.try_get("count").unwrap_or_default();
        counts.insert(status, Value::from(count));
    }
    let count_of = |statuses: &[&str]| -> i64 {
        statuses
            .iter()
            .map(|status| counts.get(*status).and_then(Value::as_i64).unwrap_or(0))
            .sum()
    };
    let total: i64 = counts.values().filter_map(Value::as_i64).sum();
    let escalated: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_attempts a
         WHERE a.created_at >= $1
           AND EXISTS (SELECT 1 FROM operator_cases oc
                       WHERE oc.attempt_id = a.id AND oc.state <> 'RESOLVED')",
    )
    .bind(since)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    Ok(json!({
        "total24h": total,
        "settled24h": count_of(SETTLED_STATUSES),
        "inFlight24h": count_of(IN_FLIGHT_STATUSES),
        "failed24h": count_of(FAILED_STATUSES),
        "escalated24h": escalated,
    }))
}

async fn summary(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    transaction_summary(state).await
}

async fn summary_export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let summary = transaction_summary(state).await?;
    let mut body = summary;
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "exportedAt".to_owned(),
            super::support::iso_required(Utc::now()),
        );
    }
    let _ = request;
    Ok(body)
}

// ---------------------------------------------------------------- list

fn list_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "a.id", ColumnKind::Uuid)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp)
        .with("status", "a.status::text", ColumnKind::Text)
        .with("requestedAmount", "a.requested_amount", ColumnKind::Decimal)
        .with("amount", "a.requested_amount", ColumnKind::Decimal)
        .with("currency", "a.currency", ColumnKind::Text)
        .with("railId", "a.rail_id", ColumnKind::Uuid)
        .with("gatewayId", "rr.gateway_id", ColumnKind::Uuid)
        .with("merchantId", "a.merchant_id", ColumnKind::Uuid)
        .with("applicationId", "a.application_id", ColumnKind::Uuid)
}

fn list_spec(support: bool) -> ListSpec {
    let mut spec = ListSpec::default()
        .with_in("status", "status")
        .with_in("railId", "railId")
        .with_in("gatewayId", "gatewayId")
        .with_in("merchantId", "merchantId")
        .with_in("applicationId", "applicationId")
        .with_range(RangeFilter::new(
            "amount",
            "requestedAmount",
            RangeKind::Decimal,
        ))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("status", "status")
        .with_sortable("requestedAmount", "requestedAmount")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0);
    if support {
        // Search is built as an extra predicate because it also needs the exact UUID id match.
        spec = spec.with_search(&["reference"]);
    } else {
        spec = spec.with_search(&[
            "reference",
            "gatewayReference",
            "providerReference",
            "networkReference",
        ]);
    }
    spec
}

fn list_columns_with_search() -> ColumnMap {
    list_columns()
        .with("reference", "a.reference", ColumnKind::Text)
        .with("gatewayReference", "a.gateway_reference", ColumnKind::Text)
        .with(
            "providerReference",
            "a.provider_reference",
            ColumnKind::Text,
        )
        .with("networkReference", "a.network_reference", ColumnKind::Text)
}

async fn list(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let support = is_support(principal);
    // Validate the comma filters eagerly, like the TS handler (the list builder would otherwise
    // accept any string).
    enum_list_filter(request, "status", ATTEMPT_STATUSES)?;
    uuid_list_filter(request, "railId")?;
    uuid_list_filter(request, "gatewayId")?;
    uuid_list_filter(request, "merchantId")?;
    uuid_list_filter(request, "applicationId")?;
    if let Some(currency) = query_string(request, "currency") {
        if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            return Err(ApiError::new(
                400,
                "INVALID_FILTER",
                "The 'currency' filter is invalid",
            ));
        }
    }
    assert_decimal_query(request, &["amountMin", "amountMax"])?;

    let built = build_list(request, &list_spec(support), &list_columns_with_search())?;
    let from = "payment_attempts a
        JOIN merchants m ON m.id = a.merchant_id
        JOIN applications ap ON ap.id = a.application_id
        JOIN rails r ON r.id = a.rail_id
        JOIN rail_routes rr ON rr.id = a.route_id
        JOIN gateways g ON g.id = rr.gateway_id
        LEFT JOIN gateway_settings gs ON gs.gateway_version_id = a.gateway_version_id";

    let mut extra = ExtraFilter {
        sql: String::new(),
        binds: Vec::new(),
    };
    if let Some(search) = query_string(request, "search") {
        let start = built.binds.len() + 1;
        let fields: &[&str] = if support {
            &["a.reference"]
        } else {
            &[
                "a.reference",
                "a.gateway_reference",
                "a.provider_reference",
                "a.network_reference",
            ]
        };
        extra.binds.push(ExtraBind::Text(format!("%{search}%")));
        let mut predicate = format!(
            "({})",
            fields
                .iter()
                .map(|field| format!("{field} ILIKE ${start}::text"))
                .collect::<Vec<_>>()
                .join(" OR ")
        );
        if uuid::Uuid::parse_str(&search).is_ok() {
            let placeholder = start + 1;
            extra
                .binds
                .push(ExtraBind::Text(search.to_ascii_lowercase()));
            predicate = format!("({predicate} OR a.id = ${placeholder}::uuid)");
        }
        extra.sql = predicate;
    }
    if let Some(currency) = query_string(request, "currency") {
        let start = built.binds.len() + extra.binds.len() + 1;
        let predicate = format!("a.currency = upper(${start}::text)");
        extra.sql = if extra.sql.is_empty() {
            predicate
        } else {
            format!("{} AND {}", extra.sql, predicate)
        };
        extra.binds.push(ExtraBind::Text(currency));
    }

    let projection = format!(
        "a.id, a.created_at, a.status::text AS status, a.terminal_at, a.requested_amount,
         a.currency, a.reference, a.gateway_reference, a.provider_reference, a.network_reference,
         a.merchant_id, a.application_id, a.rail_id, a.ledger_entry_id,
         {MERCHANT_BRIEF} AS merchant_json,
         {GATEWAY_BRIEF} AS gateway_json,
         jsonb_build_object('id', ap.id, 'name', ap.name) AS application_json,
         jsonb_build_object('id', r.id, 'code', r.code, 'nameEn', r.name_en) AS rail_json,
         rr.gateway_id,
         COALESCE(gs.supports_status_check, false) AS supports_status_check,
         EXISTS (SELECT 1 FROM operator_cases oc
                 WHERE oc.attempt_id = a.id AND oc.state <> 'RESOLVED') AS has_open_case"
    );
    let rows = fetch_list(&state.pools.main, &built, &projection, from, Some(&extra)).await?;
    let total = count_list(&state.pools.main, &built, from, Some(&extra)).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let status = text(row, "status");
            let terminal = timestamp(row, "terminal_at");
            let supports = row
                .try_get::<Option<bool>, _>("supports_status_check")
                .ok()
                .flatten()
                .unwrap_or(false);
            let (eligible, _reason) = inquiry_eligibility(None, Some(&status), terminal, supports);
            json!({
                "id": uuid_json(row, "id"),
                "createdAt": ts_json(row, "created_at"),
                "status": status,
                "requestedAmount": if support { Value::Null } else { money(row, "requested_amount") },
                "currency": text(row, "currency"),
                "merchantId": uuid_json(row, "merchant_id"),
                "merchant": super::support::jsonb(row, "merchant_json"),
                "applicationId": uuid_json(row, "application_id"),
                "application": super::support::jsonb(row, "application_json"),
                "railId": uuid_json(row, "rail_id"),
                "rail": super::support::jsonb(row, "rail_json"),
                "gatewayId": uuid_json(row, "gateway_id"),
                "gateway": super::support::jsonb(row, "gateway_json"),
                "reference": text(row, "reference"),
                "gatewayReference": if support { Value::Null } else { super::support::text_value(row, "gateway_reference") },
                "providerReference": if support { Value::Null } else { super::support::text_value(row, "provider_reference") },
                "networkReference": if support { Value::Null } else { super::support::text_value(row, "network_reference") },
                "ledgerEntryId": if support { Value::Null } else { uuid_json(row, "ledger_entry_id") },
                "hasOpenCase": super::support::bool_value(row, "has_open_case"),
                "inquiryEligible": eligible,
                "redactedFields": if support { json!(ATTEMPT_REDACTED_FIELDS) } else { json!([]) },
            })
        })
        .collect();
    let mut response = list_envelope("transactions", Value::Array(items.clone()), total, &built);
    response = super::support::with_cursor(response, &built, &rows, "created_at");
    if support {
        if let Some(object) = response.as_object_mut() {
            object.insert("redactedFields".to_owned(), json!(ATTEMPT_REDACTED_FIELDS));
        }
    }
    Ok(response)
}

/// `operatorCaseInquiryEligibility`.
fn inquiry_eligibility(
    case_state: Option<&str>,
    attempt_status: Option<&str>,
    terminal_at: Option<chrono::NaiveDateTime>,
    supports_status_check: bool,
) -> (bool, String) {
    let case_state = case_state.unwrap_or_default().to_ascii_uppercase();
    if case_state == "RESOLVED" {
        return (false, "CASE_RESOLVED".to_owned());
    }
    if case_state == "PENDING_CHECKER" {
        return (false, "CASE_PENDING_CHECKER".to_owned());
    }
    let Some(status) = attempt_status else {
        return (false, "NO_ATTEMPT".to_owned());
    };
    if terminal_at.is_some() {
        return (false, "ATTEMPT_TERMINAL".to_owned());
    }
    let status = status.to_ascii_uppercase();
    if !matches!(status.as_str(), "UNKNOWN" | "VERIFYING") {
        return (false, "ATTEMPT_NOT_INQUIRABLE".to_owned());
    }
    if !supports_status_check {
        return (false, "GATEWAY_HAS_NO_STATUS_INQUIRY".to_owned());
    }
    (true, "ELIGIBLE".to_owned())
}

// ---------------------------------------------------------------- detail

pub(super) async fn detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "PAYMENT_ATTEMPT_NOT_FOUND",
        "The payment attempt does not exist",
    )?;
    let support = is_support(principal);
    let row = sqlx::query(
        sqlx::AssertSqlSafe(format!(
            "SELECT a.*, {MERCHANT_BRIEF} AS merchant_json, {GATEWAY_BRIEF} AS gateway_json,
                    jsonb_build_object('id', ap.id, 'name', ap.name, 'status', ap.status::text) AS application_json,
                    jsonb_build_object('id', r.id, 'code', r.code, 'nameEn', r.name_en, 'nameAr', r.name_ar) AS rail_json,
                    jsonb_build_object('id', rr.id, 'gatewayId', rr.gateway_id) AS route_json,
                    COALESCE(gs.supports_status_check, false) AS supports_status_check,
                    jsonb_build_object('id', pl.id, 'key', pl.key) AS link_json
             FROM payment_attempts a
             JOIN merchants m ON m.id = a.merchant_id
             JOIN applications ap ON ap.id = a.application_id
             JOIN rails r ON r.id = a.rail_id
             JOIN rail_routes rr ON rr.id = a.route_id
             JOIN gateways g ON g.id = rr.gateway_id
             JOIN payment_links pl ON pl.id = a.link_id
             LEFT JOIN gateway_settings gs ON gs.gateway_version_id = a.gateway_version_id
             WHERE a.id = $1"
        )),
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "PAYMENT_ATTEMPT_NOT_FOUND",
            "The payment attempt does not exist",
        ));
    };

    let step_logs = sqlx::query(
        "SELECT id, created_at, phase, step_id, step_order, redacted_request_json,
                left(redacted_response_text, 16384) AS redacted_response_text,
                http_status, duration_ms, outcome
         FROM attempt_step_logs WHERE attempt_id = $1
         ORDER BY step_order ASC, created_at ASC LIMIT 500",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let inbound = sqlx::query(
        "SELECT ie.id, ie.received_at, ie.gateway_id, ie.channel_id, ie.env, ie.source_ip,
                ie.verified, ie.verification_error, ie.attempt_id, ie.processed_at,
                ie.processing_result, ie.dedupe_key, g.code AS gateway_code, g.name AS gateway_name
         FROM inbound_events ie JOIN gateways g ON g.id = ie.gateway_id
         WHERE ie.attempt_id = $1 ORDER BY ie.received_at DESC LIMIT 50",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let attempt_group_id = uuid_value(&row, "attempt_group_id");
    let group = match attempt_group_id {
        Some(group_id) => {
            let group_row =
                sqlx::query("SELECT id, success_count FROM attempt_groups WHERE id = $1")
                    .bind(super::support::uuid_bind(&group_id))
                    .fetch_optional(&state.pools.main)
                    .await
                    .map_err(super::support::database_error)?;
            match group_row {
                Some(group_row) => {
                    let entries = sqlx::query(
                        "SELECT a.id, a.status::text AS status, a.rail_id, rr.gateway_id,
                                a.requested_amount, a.created_at
                         FROM payment_attempts a JOIN rail_routes rr ON rr.id = a.route_id
                         WHERE a.attempt_group_id = $1 ORDER BY a.created_at DESC LIMIT 25",
                    )
                    .bind(super::support::uuid_bind(&group_id))
                    .fetch_all(&state.pools.main)
                    .await
                    .map_err(super::support::database_error)?;
                    Some(json!({
                        "id": uuid_json(&group_row, "id"),
                        "successCount": super::support::int_json(&group_row, "success_count"),
                        "attempts": entries.iter().map(|entry| json!({
                            "id": uuid_json(entry, "id"),
                            "status": text(entry, "status"),
                            "railId": uuid_json(entry, "rail_id"),
                            "gatewayId": uuid_json(entry, "gateway_id"),
                            "requestedAmount": if support { Value::Null } else { money(entry, "requested_amount") },
                            "createdAt": ts_json(entry, "created_at"),
                        })).collect::<Vec<_>>(),
                    }))
                }
                None => None,
            }
        }
        None => None,
    };
    let cases = sqlx::query(
        "SELECT id, kind::text AS kind, state::text AS state, priority::text AS priority, sla_due_at
         FROM operator_cases WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 25",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let disputes = sqlx::query(
        "SELECT id, status::text AS status, amount, reason_code, created_at
         FROM disputes WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 25",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let adjustments = sqlx::query(
        "SELECT id, type::text AS type, state::text AS state, amount, created_at, journal_entry_id
         FROM adjustments WHERE source_attempt_id = $1 ORDER BY created_at DESC LIMIT 25",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;

    let mut attempt = Map::new();
    let id_value = uuid_json(&row, "id");
    attempt.insert("id".to_owned(), id_value);
    for (name, column) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("lastOtpSentAt", "last_otp_sent_at"),
        ("expiresAt", "expires_at"),
        ("graceExpiresAt", "grace_expires_at"),
        ("nextCheckAt", "next_check_at"),
        ("terminalAt", "terminal_at"),
        ("firstTerminalAt", "first_terminal_at"),
        ("firstUnknownAt", "first_unknown_at"),
    ] {
        attempt.insert(name.to_owned(), ts_json(&row, column));
    }
    for (name, column) in [
        ("reference", "reference"),
        ("idempotencyKey", "idempotency_key"),
        ("mode", "mode"),
        ("subMode", "sub_mode"),
        ("substatus", "substatus"),
        ("gatewayReference", "gateway_reference"),
        ("providerReference", "provider_reference"),
        ("networkReference", "network_reference"),
        ("gatewayAmountWire", "gateway_amount_wire"),
        ("currency", "currency"),
        ("clientIp", "client_ip"),
        ("userAgent", "user_agent"),
        ("canonicalError", "canonical_error"),
    ] {
        let value = super::support::text_value(&row, column);
        attempt.insert(
            name.to_owned(),
            if support
                && matches!(
                    name,
                    "gatewayReference"
                        | "providerReference"
                        | "networkReference"
                        | "gatewayAmountWire"
                )
            {
                Value::Null
            } else {
                value
            },
        );
    }
    for (name, column) in [
        ("env", "env"),
        ("status", "status"),
        ("feeBearer", "fee_bearer"),
        ("settlementTarget", "settlement_target"),
    ] {
        attempt.insert(name.to_owned(), Value::String(text(&row, column)));
    }
    for (name, column) in [
        ("linkId", "link_id"),
        ("attemptGroupId", "attempt_group_id"),
        ("applicationId", "application_id"),
        ("merchantId", "merchant_id"),
        ("railId", "rail_id"),
        ("routeId", "route_id"),
        ("credentialSetId", "credential_set_id"),
        ("gatewayVersionId", "gateway_version_id"),
        ("commissionProfileId", "commission_profile_id"),
        ("walletId", "wallet_id"),
        ("walletGlAccountId", "wallet_gl_account_id"),
    ] {
        attempt.insert(name.to_owned(), uuid_json(&row, column));
    }
    attempt.insert(
        "ledgerEntryId".to_owned(),
        if support {
            Value::Null
        } else {
            uuid_json(&row, "ledger_entry_id")
        },
    );
    attempt.insert(
        "pointOfNoReturn".to_owned(),
        super::support::bool_json(&row, "point_of_no_return"),
    );
    attempt.insert(
        "otpAttempts".to_owned(),
        super::support::int_json(&row, "otp_attempts"),
    );
    for (name, column) in [
        ("requestedAmount", "requested_amount"),
        ("surchargeAmount", "surcharge_amount"),
        ("totalChargedAmount", "total_charged_amount"),
        ("settledAmount", "settled_amount"),
        ("gatewayFeeAmount", "gateway_fee_amount"),
        ("platformCommissionAmount", "platform_commission_amount"),
        ("netMerchantAmount", "net_merchant_amount"),
    ] {
        let value = if column == "settled_amount" || column == "gateway_fee_amount" {
            money_opt(&row, column)
        } else {
            money(&row, column)
        };
        attempt.insert(name.to_owned(), if support { Value::Null } else { value });
    }
    attempt.insert(
        "customerFieldsMasked".to_owned(),
        super::support::jsonb_or_empty_object(&row, "customer_fields_masked"),
    );
    attempt.insert(
        "publicOutputs".to_owned(),
        super::support::jsonb(&row, "public_outputs"),
    );
    attempt.insert("link".to_owned(), super::support::jsonb(&row, "link_json"));

    let status = text(&row, "status");
    let terminal = timestamp(&row, "terminal_at");
    let supports = row
        .try_get::<Option<bool>, _>("supports_status_check")
        .ok()
        .flatten()
        .unwrap_or(false);
    let (eligible, reason) = inquiry_eligibility(None, Some(&status), terminal, supports);

    let mut payload = Map::new();
    payload.insert("attempt".to_owned(), Value::Object(attempt));
    payload.insert(
        "merchant".to_owned(),
        super::support::jsonb(&row, "merchant_json"),
    );
    payload.insert(
        "application".to_owned(),
        super::support::jsonb(&row, "application_json"),
    );
    payload.insert("rail".to_owned(), super::support::jsonb(&row, "rail_json"));
    payload.insert(
        "gateway".to_owned(),
        super::support::jsonb(&row, "gateway_json"),
    );
    payload.insert(
        "gatewaySupportsStatusCheck".to_owned(),
        Value::Bool(supports),
    );
    payload.insert(
        "inquiryEligibility".to_owned(),
        json!({ "eligible": eligible, "reason": reason }),
    );
    payload.insert(
        "stepLogs".to_owned(),
        Value::Array(
            step_logs
                .iter()
                .map(|log| {
                    json!({
                        "id": uuid_json(log, "id"),
                        "createdAt": ts_json(log, "created_at"),
                        "phase": text(log, "phase"),
                        "stepId": uuid_json(log, "step_id"),
                        "stepOrder": super::support::int_json(log, "step_order"),
                        "redactedRequestJson": super::support::jsonb(log, "redacted_request_json"),
                        "redactedResponseText": text(log, "redacted_response_text"),
                        "httpStatus": super::support::int_json(log, "http_status"),
                        "durationMs": super::support::int_json(log, "duration_ms"),
                        "outcome": text(log, "outcome"),
                    })
                })
                .collect(),
        ),
    );
    payload.insert(
        "inboundEvents".to_owned(),
        Value::Array(
            inbound
                .iter()
                .map(|event| {
                    json!({
                        "id": uuid_json(event, "id"),
                        "receivedAt": ts_json(event, "received_at"),
                        "gatewayId": uuid_json(event, "gateway_id"),
                        "gateway": {
                            "id": uuid_json(event, "gateway_id"),
                            "code": text(event, "gateway_code"),
                            "name": text(event, "gateway_name"),
                        },
                        "channelId": uuid_json(event, "channel_id"),
                        "env": text(event, "env"),
                        "sourceIp": text(event, "source_ip"),
                        "verified": super::support::bool_json(event, "verified"),
                        "verificationError": super::support::text_value(event, "verification_error"),
                        "attemptId": uuid_json(event, "attempt_id"),
                        "processedAt": ts_json(event, "processed_at"),
                        "processingResult": super::support::text_value(event, "processing_result"),
                        "dedupeKey": text(event, "dedupe_key"),
                    })
                })
                .collect(),
        ),
    );
    payload.insert("attemptGroup".to_owned(), group.unwrap_or(Value::Null));
    payload.insert(
        "operatorCases".to_owned(),
        Value::Array(
            cases
                .iter()
                .map(|case| {
                    json!({
                        "id": uuid_json(case, "id"),
                        "kind": text(case, "kind"),
                        "state": text(case, "state"),
                        "priority": text(case, "priority"),
                        "slaDueAt": ts_json(case, "sla_due_at"),
                    })
                })
                .collect(),
        ),
    );
    payload.insert(
        "disputes".to_owned(),
        Value::Array(
            disputes
                .iter()
                .map(|dispute| {
                    json!({
                        "id": uuid_json(dispute, "id"),
                        "status": text(dispute, "status"),
                        "disputedAmount": if support { Value::Null } else { money(dispute, "amount") },
                        "reasonCode": super::support::text_value(dispute, "reason_code"),
                        "createdAt": ts_json(dispute, "created_at"),
                    })
                })
                .collect(),
        ),
    );
    payload.insert(
        "adjustments".to_owned(),
        Value::Array(
            adjustments
                .iter()
                .map(|adjustment| {
                    json!({
                        "id": uuid_json(adjustment, "id"),
                        "type": text(adjustment, "type"),
                        "state": text(adjustment, "state"),
                        "amount": if support { Value::Null } else { money(adjustment, "amount") },
                        "createdAt": ts_json(adjustment, "created_at"),
                        "journalEntryId": if support { Value::Null } else { uuid_json(adjustment, "journal_entry_id") },
                    })
                })
                .collect(),
        ),
    );
    payload.insert(
        "redactedFields".to_owned(),
        if support {
            json!(ATTEMPT_REDACTED_FIELDS)
        } else {
            json!([])
        },
    );
    Ok(Value::Object(payload))
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

fn summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, summary(state, request, principal).await) })
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
