//! Admin finance read routes: adjustments and cash-out requests.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/adjustments*`, `/cashouts*`). The list filters,
//! search fields, sorts, page-size defaults (20), summary groupings and 5,000-row export envelopes
//! follow the TypeScript handlers. Money is always `Money4`; a cash-out destination is masked with
//! the same key heuristic as `merchantMaskedJson`.

#![forbid(unsafe_code)]

use chrono::Utc;
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    age_hours, build_list, count_list, export_envelope, fetch_list, jsonb, list_envelope,
    masked_json_object, money, money_value, reporting_currency, require_uuid_param, text,
    timestamp, ts_json, uuid_json, uuid_value,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const ADJUSTMENT_EXECUTED_STATES: &[&str] = &["EXECUTED"];
const ADJUSTMENT_OPEN_STATES: &[&str] = &["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTING"];
const CASHOUT_OPEN_STATES: &[&str] = &["PENDING", "PROCESSING"];
const DEBIT_POSITIVE: &[&str] = &[
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "PROVIDER_FEE_EXPENSE",
    "GATEWAY_FEE_EXPENSE",
];

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/adjustments",
            "core-back/api/internal/admin.ts:18134",
            &["finance:read"],
            adjustments_list_handler,
        ),
        route(
            "/internal/admin/adjustments/export",
            "core-back/api/internal/admin.ts:18198",
            &["finance:read"],
            adjustments_export_handler,
        ),
        route(
            "/internal/admin/adjustments/summary",
            "core-back/api/internal/admin.ts:18333",
            &["finance:read"],
            adjustments_summary_handler,
        ),
        route(
            "/internal/admin/adjustments/summary/export",
            "core-back/api/internal/admin.ts:18338",
            &["finance:read"],
            adjustments_summary_export_handler,
        ),
        route(
            "/internal/admin/adjustments/:id",
            "core-back/api/internal/admin.ts:18372",
            &["finance:read"],
            adjustment_detail_handler,
        ),
        route(
            "/internal/admin/cashouts",
            "core-back/api/internal/admin.ts:18505",
            &["cashout:read"],
            cashouts_list_handler,
        ),
        route(
            "/internal/admin/cashouts/export",
            "core-back/api/internal/admin.ts:18534",
            &["cashout:read"],
            cashouts_export_handler,
        ),
        route(
            "/internal/admin/cashouts/summary",
            "core-back/api/internal/admin.ts:18632",
            &["cashout:read"],
            cashouts_summary_handler,
        ),
        route(
            "/internal/admin/cashouts/summary/export",
            "core-back/api/internal/admin.ts:18637",
            &["cashout:read"],
            cashouts_summary_export_handler,
        ),
        route(
            "/internal/admin/cashouts/:id",
            "core-back/api/internal/admin.ts:18670",
            &["cashout:read"],
            cashout_detail_handler,
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

// ---------------------------------------------------------------- adjustments

fn adjustment_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "a.id", ColumnKind::Uuid)
        .with("idText", "a.id::text", ColumnKind::Text)
        .with("state", "a.state::text", ColumnKind::Text)
        .with("type", "a.type::text", ColumnKind::Text)
        .with("amount", "a.amount", ColumnKind::Decimal)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "a.updated_at", ColumnKind::Timestamp)
        .with("draftedBySystem", "a.drafted_by_system", ColumnKind::Bool)
        .with("sourceAttemptId", "a.source_attempt_id", ColumnKind::Uuid)
        .with("disputeId", "a.dispute_id", ColumnKind::Uuid)
        .with(
            "merchantRef",
            "COALESCE(pa.merchant_id, ga.owner_id::uuid)",
            ColumnKind::Uuid,
        )
        .with("reason", "a.reason", ColumnKind::Text)
        .with(
            "externalDisputeRef",
            "a.external_dispute_ref",
            ColumnKind::Text,
        )
        .with(
            "providerRefundRef",
            "a.provider_refund_ref",
            ColumnKind::Text,
        )
        .with("sourceReference", "pa.reference", ColumnKind::Text)
        .with(
            "disputeReference",
            "d.external_dispute_ref",
            ColumnKind::Text,
        )
}

fn adjustment_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "reason",
            "externalDisputeRef",
            "providerRefundRef",
            "idText",
            "sourceReference",
            "disputeReference",
        ])
        .with_in("state", "state")
        .with_in("type", "type")
        .with_boolean("draftedBySystem", "draftedBySystem")
        .with_equals("sourceAttemptId", "sourceAttemptId")
        .with_equals("disputeId", "disputeId")
        .with_equals("merchantId", "merchantRef")
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("updatedAt", "updatedAt").with_keys("updatedFrom", "updatedTo"))
        .with_sortable("type", "type")
        .with_sortable("state", "state")
        .with_sortable("amount", "amount")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("updatedAt", "updatedAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

const ADJUSTMENT_FROM: &str = "adjustments a
    LEFT JOIN payment_attempts pa ON pa.id = a.source_attempt_id
    LEFT JOIN merchants pm ON pm.id = pa.merchant_id
    LEFT JOIN gl_accounts ga ON ga.id = a.target_gl_account_id
    LEFT JOIN disputes d ON d.id = a.dispute_id";

const ADJUSTMENT_PROJECTION: &str = "a.id, a.created_at, a.updated_at, a.type::text AS type,
    a.state::text AS state, a.amount,
    COALESCE(ga.currency, pa.currency, 'LYD') AS currency,
    a.reverse_commission, a.reason, a.external_dispute_ref, a.provider_refund_ref,
    a.drafted_by_system, a.source_attempt_id, pa.reference AS source_reference,
    pa.status::text AS source_status,
    a.dispute_id, d.external_dispute_ref AS dispute_reference, d.status::text AS dispute_status,
    a.target_gl_account_id, ga.account_type::text AS target_account_type, ga.owner_id::uuid AS target_owner_id,
    COALESCE(pa.merchant_id, ga.owner_id::uuid) AS merchant_ref,
    pm.trade_name AS merchant_name, a.journal_entry_id";

async fn approvals_for(state: &AppState, ids: &[String]) -> Result<Map<String, Value>, ApiError> {
    let mut map = Map::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT id, subject_id, state::text AS state, checker_user_id
         FROM approval_requests
         WHERE subject_type::text = ANY($1::text[]) AND subject_id = ANY($2::text[])
         ORDER BY created_at DESC",
    )
    .bind(approval_variants("ADJUSTMENT"))
    .bind(ids.to_vec())
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    for row in &rows {
        let subject = text(row, "subject_id");
        map.entry(subject).or_insert_with(|| {
            json!({
                "id": uuid_json(row, "id"),
                "state": text(row, "state"),
                "checkerUserId": uuid_json(row, "checker_user_id"),
            })
        });
    }
    Ok(map)
}

fn approval_variants(subject: &str) -> Vec<String> {
    let normalized = subject.trim().replace([' ', '-'], "_").to_ascii_uppercase();
    let pascal = normalized
        .to_lowercase()
        .split('_')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<String>();
    vec![normalized.clone(), pascal, normalized.to_lowercase()]
}

fn adjustment_row(row: &sqlx::postgres::PgRow, approval: Option<&Value>) -> Value {
    json!({
        "id": uuid_json(row, "id"),
        "type": text(row, "type"),
        "state": text(row, "state"),
        "amount": money(row, "amount"),
        "currency": text(row, "currency"),
        "reverseCommission": super::support::bool_json(row, "reverse_commission"),
        "reason": text(row, "reason"),
        "externalDisputeRef": super::support::text_value(row, "external_dispute_ref"),
        "providerRefundRef": super::support::text_value(row, "provider_refund_ref"),
        "draftedBySystem": super::support::bool_json(row, "drafted_by_system"),
        "sourceAttemptId": uuid_json(row, "source_attempt_id"),
        "sourceAttemptReference": super::support::text_value(row, "source_reference"),
        "sourceAttemptStatus": super::support::text_value(row, "source_status"),
        "disputeId": uuid_json(row, "dispute_id"),
        "disputeReference": super::support::text_value(row, "dispute_reference"),
        "disputeStatus": super::support::text_value(row, "dispute_status"),
        "targetGlAccountId": uuid_json(row, "target_gl_account_id"),
        "targetAccountType": super::support::text_value(row, "target_account_type"),
        "targetAccountOwnerId": uuid_json(row, "target_owner_id"),
        "merchantId": uuid_json(row, "merchant_ref"),
        "merchantName": super::support::opt_text(row, "merchant_name").unwrap_or_default(),
        "journalEntryId": uuid_json(row, "journal_entry_id"),
        "approvalRequestId": approval.and_then(|value| value.get("id")).cloned().unwrap_or(Value::Null),
        "approvalState": approval.and_then(|value| value.get("state")).cloned().unwrap_or(Value::Null),
        "checkerUserId": approval.and_then(|value| value.get("checkerUserId")).cloned().unwrap_or(Value::Null),
        "createdAt": ts_json(row, "created_at"),
        "updatedAt": ts_json(row, "updated_at"),
        "executedAt": if text(row, "state") == "EXECUTED" { ts_json(row, "updated_at") } else { Value::Null },
    })
}

async fn adjustments_list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &adjustment_spec(), &adjustment_columns())?;
    let rows = fetch_list(
        &state.pools.main,
        &built,
        ADJUSTMENT_PROJECTION,
        ADJUSTMENT_FROM,
        None,
    )
    .await?;
    let total = count_list(&state.pools.main, &built, ADJUSTMENT_FROM, None).await?;
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| uuid_value(row, "id"))
        .collect();
    let approvals = approvals_for(state, &ids).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            adjustment_row(
                row,
                approvals.get(&uuid_value(row, "id").unwrap_or_default()),
            )
        })
        .collect();
    let response = list_envelope("adjustments", Value::Array(items), total, &built);
    Ok(super::support::with_cursor(
        response,
        &built,
        &rows,
        "created_at",
    ))
}

async fn adjustments_export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &adjustment_spec(), &adjustment_columns())?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {ADJUSTMENT_PROJECTION} FROM {ADJUSTMENT_FROM} {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    )))
    .bind_all_rows(&built)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let total = count_list(&state.pools.main, &built, ADJUSTMENT_FROM, None)
        .await?
        .unwrap_or(0);
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| uuid_value(row, "id"))
        .collect();
    let approvals = approvals_for(state, &ids).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            adjustment_row(
                row,
                approvals.get(&uuid_value(row, "id").unwrap_or_default()),
            )
        })
        .collect();
    let exported = items.len();
    Ok(export_envelope(
        "adjustments",
        Value::Array(items),
        total,
        exported,
    ))
}

async fn adjustment_summary(state: &AppState, currency: &str) -> Result<Value, ApiError> {
    let state_rows = sqlx::query(
        "SELECT a.state::text AS state, count(*) AS count, COALESCE(SUM(a.amount),0) AS amount
         FROM adjustments a JOIN gl_accounts ga ON ga.id = a.target_gl_account_id
         WHERE ga.currency = $1 GROUP BY a.state",
    )
    .bind(currency)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let type_rows = sqlx::query(
        "SELECT a.type::text AS type, count(*) AS count, COALESCE(SUM(a.amount),0) AS amount
         FROM adjustments a JOIN gl_accounts ga ON ga.id = a.target_gl_account_id
         WHERE ga.currency = $1 GROUP BY a.type",
    )
    .bind(currency)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let open = sqlx::query(
        "SELECT count(*) AS count, COALESCE(SUM(a.amount),0) AS amount
         FROM adjustments a JOIN gl_accounts ga ON ga.id = a.target_gl_account_id
         WHERE ga.currency = $1 AND a.state::text = ANY($2::text[])",
    )
    .bind(currency)
    .bind(ADJUSTMENT_OPEN_STATES)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let executed = sqlx::query(
        "SELECT count(*) AS count, COALESCE(SUM(a.amount),0) AS amount
         FROM adjustments a JOIN gl_accounts ga ON ga.id = a.target_gl_account_id
         WHERE ga.currency = $1 AND a.state::text = ANY($2::text[])",
    )
    .bind(currency)
    .bind(ADJUSTMENT_EXECUTED_STATES)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let currency_rows = sqlx::query(
        "SELECT COALESCE(ga.currency, pa.currency)::text AS currency, count(*) AS count,
                COALESCE(SUM(a.amount),0) AS amount
         FROM adjustments a
         LEFT JOIN gl_accounts ga ON ga.id = a.target_gl_account_id
         LEFT JOIN payment_attempts pa ON pa.id = a.source_attempt_id
         GROUP BY 1 ORDER BY 1",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;

    let mut by_state = Map::new();
    let mut amount_by_state = Map::new();
    for row in &state_rows {
        by_state.insert(text(row, "state"), Value::from(count(row)));
        amount_by_state.insert(text(row, "state"), money(row, "amount"));
    }
    let mut by_type = Map::new();
    let mut amount_by_type = Map::new();
    for row in &type_rows {
        by_type.insert(text(row, "type"), Value::from(count(row)));
        amount_by_type.insert(text(row, "type"), money(row, "amount"));
    }
    Ok(json!({
        "currency": currency,
        "byCurrency": currency_rows.iter().map(|row| json!({
            "currency": text(row, "currency"),
            "count": count(row),
            "amount": money(row, "amount"),
        })).collect::<Vec<_>>(),
        "totalOpen": count(&open),
        "openAmount": money(&open, "amount"),
        "executedCount": count(&executed),
        "executedAmount": money(&executed, "amount"),
        "byState": by_state,
        "amountByState": amount_by_state,
        "byType": by_type,
        "amountByType": amount_by_type,
    }))
}

fn count(row: &sqlx::postgres::PgRow) -> i64 {
    row.try_get::<i64, _>("count").unwrap_or_default()
}

pub(super) async fn adjustment_detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "ADJUSTMENT_NOT_FOUND",
        "The adjustment does not exist",
    )?;
    let row = sqlx::query(
        sqlx::AssertSqlSafe(format!(
            "SELECT {ADJUSTMENT_PROJECTION}, d.amount AS dispute_amount, d.opened_at AS dispute_opened_at,
                    je.id AS journal_id, je.ref_type::text AS journal_ref_type, je.ref_id AS journal_ref_id,
                    je.description AS journal_description
             FROM {ADJUSTMENT_FROM}
             LEFT JOIN journal_entries je ON je.id = a.journal_entry_id
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
            "ADJUSTMENT_NOT_FOUND",
            "The adjustment does not exist",
        ));
    };
    let approval = sqlx::query(
        "SELECT id, state::text AS state, checker_user_id, maker_user_id, rejection_reason, created_at
         FROM approval_requests
         WHERE subject_type::text = ANY($1::text[]) AND subject_id = $2
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(approval_variants("ADJUSTMENT"))
    .bind(id.to_string())
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let approval_value = approval.as_ref().map(|approval| {
        json!({
            "id": uuid_json(approval, "id"),
            "state": text(approval, "state"),
            "makerUserId": uuid_json(approval, "maker_user_id"),
            "checkerUserId": uuid_json(approval, "checker_user_id"),
            "rejectionReason": super::support::text_value(approval, "rejection_reason"),
            "createdAt": ts_json(approval, "created_at"),
        })
    });
    let mut adjustment = adjustment_row(&row, approval_value.as_ref());
    if let Some(object) = adjustment.as_object_mut() {
        object.insert(
            "disputeAmount".to_owned(),
            if row
                .try_get::<Option<Decimal>, _>("dispute_amount")
                .ok()
                .flatten()
                .is_some()
            {
                money(&row, "dispute_amount")
            } else {
                Value::Null
            },
        );
        object.insert(
            "disputeOpenedAt".to_owned(),
            ts_json(&row, "dispute_opened_at"),
        );
        object.insert(
            "journalEntry".to_owned(),
            if row
                .try_get::<Option<uuid::Uuid>, _>("journal_id")
                .ok()
                .flatten()
                .is_some()
            {
                json!({
                    "id": uuid_json(&row, "journal_id"),
                    "refType": text(&row, "journal_ref_type"),
                    "refId": super::support::text_value(&row, "journal_ref_id"),
                    "description": super::support::text_value(&row, "journal_description"),
                })
            } else {
                Value::Null
            },
        );
        object.insert("approval".to_owned(), approval_value.unwrap_or(Value::Null));
    }
    Ok(json!({ "adjustment": adjustment }))
}

// ---------------------------------------------------------------- cash-outs

fn cashout_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "c.id", ColumnKind::Uuid)
        .with("idText", "c.id::text", ColumnKind::Text)
        .with("state", "c.state::text", ColumnKind::Text)
        .with("amount", "c.amount", ColumnKind::Decimal)
        .with("createdAt", "c.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "c.updated_at", ColumnKind::Timestamp)
        .with("merchantId", "c.merchant_id", ColumnKind::Uuid)
        .with("walletId", "c.wallet_id", ColumnKind::Uuid)
        .with("walletText", "c.wallet_id::text", ColumnKind::Text)
        .with("merchantName", "m.trade_name", ColumnKind::Text)
}

fn cashout_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["merchantName", "walletText", "idText"])
        .with_in("state", "state")
        .with_equals("merchantId", "merchantId")
        .with_equals("walletId", "walletId")
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("state", "state")
        .with_sortable("amount", "amount")
        .with_sortable("requestedAt", "createdAt")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("updatedAt", "updatedAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

const CASHOUT_FROM: &str = "cashout_requests c
    JOIN merchants m ON m.id = c.merchant_id
    JOIN wallets w ON w.id = c.wallet_id
    LEFT JOIN adjustments a ON a.id = c.adjustment_id";

const CASHOUT_PROJECTION: &str = "c.id, c.created_at, c.updated_at, c.merchant_id, c.wallet_id,
    c.amount, c.state::text AS state, c.destination_bank_json, c.adjustment_id,
    a.state::text AS adjustment_state, a.journal_entry_id,
    m.trade_name AS merchant_name, m.legal_name AS merchant_legal_name,
    w.currency, w.status::text AS wallet_status";

fn cashout_row(row: &sqlx::postgres::PgRow) -> Value {
    let now = Utc::now();
    json!({
        "id": uuid_json(row, "id"),
        "merchantId": uuid_json(row, "merchant_id"),
        "merchantName": super::support::opt_text(row, "merchant_name").unwrap_or_default(),
        "walletId": uuid_json(row, "wallet_id"),
        "currency": text(row, "currency"),
        "amount": money(row, "amount"),
        "state": text(row, "state"),
        "destination": masked_json_object(&jsonb(row, "destination_bank_json")),
        "adjustmentId": uuid_json(row, "adjustment_id"),
        "adjustmentState": super::support::text_value(row, "adjustment_state"),
        "adjustmentJournalEntryId": uuid_json(row, "journal_entry_id"),
        "requestedAt": ts_json(row, "created_at"),
        "createdAt": ts_json(row, "created_at"),
        "updatedAt": ts_json(row, "updated_at"),
        "ageHours": age_hours(timestamp(row, "created_at"), now),
    })
}

async fn cashouts_list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &cashout_spec(), &cashout_columns())?;
    let rows = fetch_list(
        &state.pools.main,
        &built,
        CASHOUT_PROJECTION,
        CASHOUT_FROM,
        None,
    )
    .await?;
    let total = count_list(&state.pools.main, &built, CASHOUT_FROM, None).await?;
    let items: Vec<Value> = rows.iter().map(cashout_row).collect();
    let response = list_envelope("cashouts", Value::Array(items), total, &built);
    Ok(super::support::with_cursor(
        response,
        &built,
        &rows,
        "created_at",
    ))
}

async fn cashouts_export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &cashout_spec(), &cashout_columns())?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {CASHOUT_PROJECTION} FROM {CASHOUT_FROM} {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    )))
    .bind_all_rows(&built)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let total = count_list(&state.pools.main, &built, CASHOUT_FROM, None)
        .await?
        .unwrap_or(0);
    let items: Vec<Value> = rows.iter().map(cashout_row).collect();
    let exported = items.len();
    Ok(export_envelope(
        "cashouts",
        Value::Array(items),
        total,
        exported,
    ))
}

async fn cashout_summary(state: &AppState, currency: &str) -> Result<Value, ApiError> {
    let state_rows = sqlx::query(
        "SELECT c.state::text AS state, count(*) AS count, COALESCE(SUM(c.amount),0) AS amount
         FROM cashout_requests c JOIN wallets w ON w.id = c.wallet_id
         WHERE w.currency = $1 GROUP BY c.state",
    )
    .bind(currency)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let currency_rows = sqlx::query(
        "SELECT w.currency::text AS currency, count(*) AS count, COALESCE(SUM(c.amount),0) AS amount
         FROM cashout_requests c JOIN wallets w ON w.id = c.wallet_id
         GROUP BY w.currency ORDER BY w.currency",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let open = sqlx::query(
        "SELECT count(*) AS count, COALESCE(SUM(c.amount),0) AS amount
         FROM cashout_requests c JOIN wallets w ON w.id = c.wallet_id
         WHERE w.currency = $1 AND c.state::text = ANY($2::text[])",
    )
    .bind(currency)
    .bind(CASHOUT_OPEN_STATES)
    .fetch_one(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let oldest = sqlx::query(
        "SELECT c.created_at FROM cashout_requests c JOIN wallets w ON w.id = c.wallet_id
         WHERE w.currency = $1 AND c.state = 'PENDING' ORDER BY c.created_at ASC LIMIT 1",
    )
    .bind(currency)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;

    let mut by_state = Map::new();
    let mut amount_by_state = Map::new();
    for row in &state_rows {
        by_state.insert(text(row, "state"), Value::from(count(row)));
        amount_by_state.insert(text(row, "state"), money(row, "amount"));
    }
    Ok(json!({
        "currency": currency,
        "byCurrency": currency_rows.iter().map(|row| json!({
            "currency": text(row, "currency"),
            "count": count(row),
            "amount": money(row, "amount"),
        })).collect::<Vec<_>>(),
        "totalOpen": count(&open),
        "openAmount": money(&open, "amount"),
        "pendingCount": by_state.get("PENDING").cloned().unwrap_or(Value::from(0)),
        "processingCount": by_state.get("PROCESSING").cloned().unwrap_or(Value::from(0)),
        "completedCount": by_state.get("COMPLETE").cloned().unwrap_or(Value::from(0)),
        "subtractedCount": by_state.get("SUBTRACTED").cloned().unwrap_or(Value::from(0)),
        "rejectedCount": by_state.get("REJECTED").cloned().unwrap_or(Value::from(0)),
        "oldestPendingAgeHours": oldest.as_ref().map_or(0, |row| age_hours(timestamp(row, "created_at"), Utc::now())),
        "byState": by_state,
        "amountByState": amount_by_state,
    }))
}

async fn wallet_balance(state: &AppState, wallet_id: &str) -> Result<Value, ApiError> {
    let row = sqlx::query(
        "SELECT ga.account_type::text AS account_type, COALESCE(SUM(s.current_balance),0) AS total
         FROM wallets w JOIN gl_accounts ga ON ga.id = w.gl_account_id
         LEFT JOIN gl_account_shards s ON s.gl_account_id = ga.id
         WHERE w.id = $1 GROUP BY ga.account_type",
    )
    .bind(wallet_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let total: Decimal = row.try_get("total").unwrap_or_default();
    let account_type = text(&row, "account_type");
    let natural = if DEBIT_POSITIVE.contains(&account_type.as_str()) {
        total
    } else {
        -total
    };
    Ok(money_value(Some(natural)))
}

pub(super) async fn cashout_detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "CASHOUT_NOT_FOUND",
        "The cash-out request does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {CASHOUT_PROJECTION}, a.reason AS adjustment_reason, a.amount AS adjustment_amount
             FROM {CASHOUT_FROM}
             WHERE c.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "CASHOUT_NOT_FOUND",
            "The cash-out request does not exist",
        ));
    };
    let wallet_id = uuid_value(&row, "wallet_id").unwrap_or_default();
    let balance = wallet_balance(state, &wallet_id).await?;
    let cashout_state = text(&row, "state");
    let mut cashout = cashout_row(&row);
    if let Some(object) = cashout.as_object_mut() {
        object.insert(
            "merchantLegalName".to_owned(),
            super::support::text_value(&row, "merchant_legal_name"),
        );
        object.insert(
            "walletStatus".to_owned(),
            super::support::text_value(&row, "wallet_status"),
        );
        object.insert("walletBalance".to_owned(), balance);
        object.insert(
            "adjustmentReason".to_owned(),
            super::support::text_value(&row, "adjustment_reason"),
        );
        object.insert(
            "adjustmentAmount".to_owned(),
            if row
                .try_get::<Option<Decimal>, _>("adjustment_amount")
                .ok()
                .flatten()
                .is_some()
            {
                money(&row, "adjustment_amount")
            } else {
                Value::Null
            },
        );
        object.insert(
            "canProcess".to_owned(),
            Value::Bool(cashout_state == "PENDING"),
        );
        object.insert(
            "processBlockedReason".to_owned(),
            if cashout_state == "PENDING" {
                Value::Null
            } else {
                Value::String("CASHOUT_NOT_PENDING".to_owned())
            },
        );
    }
    Ok(json!({ "cashout": cashout }))
}

// ---------------------------------------------------------------- handler wrappers

fn adjustments_list_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(
        async move { result_response(request, adjustments_list(state, request, principal).await) },
    )
}

fn adjustments_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        result_response(request, adjustments_export(state, request, principal).await)
    })
}

fn adjustments_summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = adjustment_summary(state, &reporting_currency(request)).await;
        result_response(request, result)
    })
}

fn adjustments_summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = adjustment_summary(state, &reporting_currency(request))
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

fn adjustment_detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(
        async move { result_response(request, adjustment_detail(state, request, principal).await) },
    )
}

fn cashouts_list_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(
        async move { result_response(request, cashouts_list(state, request, principal).await) },
    )
}

fn cashouts_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(
        async move { result_response(request, cashouts_export(state, request, principal).await) },
    )
}

fn cashouts_summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = cashout_summary(state, &reporting_currency(request)).await;
        result_response(request, result)
    })
}

fn cashouts_summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = cashout_summary(state, &reporting_currency(request))
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

fn cashout_detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(
        async move { result_response(request, cashout_detail(state, request, principal).await) },
    )
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}

/// Bind a built list query's WHERE values for an export (the LIMIT is literal 5000 in the caller).
trait BindBuiltRows<'q> {
    fn bind_all_rows(self, built: &'q pg_db::BuiltListQuery) -> Self;
}

impl<'q> BindBuiltRows<'q> for sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    fn bind_all_rows(mut self, built: &'q pg_db::BuiltListQuery) -> Self {
        for bind in &built.binds {
            self = match bind {
                pg_db::SqlBind::Text(value) => self.bind(value.as_str()),
                pg_db::SqlBind::Bool(value) => self.bind(*value),
            };
        }
        self
    }
}
