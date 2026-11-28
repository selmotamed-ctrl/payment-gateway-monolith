//! Merchant list export, the merchant summary and the merchant-360 summary export.
//!
//! Ports `core-back/api/internal/admin.ts:5346` (`/merchants/export`), `:5492`
//! (`/merchants/summary`), `:5497` (`/merchants/summary/export`) and `:5522`
//! (`/merchants/:id/summary/export`), including the `MERCHANTS_EXPORTED`,
//! `MERCHANT_SUMMARY_EXPORTED` and `MERCHANT_360_SUMMARY_EXPORTED` audit rows.
//!
//! # Reuse
//!
//! The TS export serialises `serializeMerchantSummary` over `merchantListSelect`. Those helpers are
//! private to `admin_commerce::merchants`, so this module drives the already ported
//! `merchants::list`/`merchants::detail` instead of duplicating the projection: the export pages the
//! list at 200 rows (the list contract cap) until the TS `take: 5000` is reached, and the merchant
//! summary export lifts the `merchant` object the detail route already serialises, dropping the
//! detail-only sections and recounting `pendingApprovalCount` over the two states the TS export
//! uses (`DRAFT`, `PENDING_REVIEW`).
//!
//! `includeTotal` is stripped from the export query: `merchants::list` honours it, while every TS
//! export always returns a total.

#![forbid(unsafe_code)]

use chrono::Utc;
use pg_domain_auth::Principal;
use pg_http::ApiError;
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::routes::admin_commerce::{common, merchants, wallets};

use super::support;

/// TS `take: 5000`.
const EXPORT_LIMIT: usize = 5_000;
/// The list contract page-size cap.
const EXPORT_PAGE_SIZE: i64 = 200;
/// The sections `merchants::detail` appends beside `serializeMerchantSummary`.
const DETAIL_ONLY_KEYS: &[&str] = &[
    "joinRequests",
    "kybDocuments",
    "beneficialOwners",
    "revalidations",
    "amlCases",
    "pendingChanges",
    "wallets",
    "applications",
    "users",
    "accessTokens",
    "credentialSets",
    "fieldHistory",
    "walletBalance",
    "metrics",
    "openDisputes",
    "pendingCashouts",
];

/// `MERCHANT_360_SUMMARY_EXPORTED` checklist allow-list.
const SUMMARY_EXPORT_CHECKLIST: &[&str] = &[
    "MERCHANT_SCOPE_VERIFIED",
    "FINANCIAL_VISIBILITY_REVIEWED",
    "RISK_AML_REVIEWED",
    "EXPORT_APPROVAL_CONFIRMED",
];

fn encode_query(query: &Map<String, Value>) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in query {
        if let Some(text) = value.as_str() {
            serializer.append_pair(key, text);
        }
    }
    serializer.finish()
}

/// `GET /internal/admin/merchants/export`.
pub async fn export_merchants(
    pool: &PgPool,
    dedicated_audit_database: bool,
    principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    let mut filters = query.clone();
    for key in ["page", "pageSize", "includeTotal", "cursor"] {
        filters.remove(key);
    }

    let mut rows: Vec<Value> = Vec::new();
    let mut total = 0_i64;
    let mut page = 1_i64;
    while rows.len() < EXPORT_LIMIT {
        let mut paged = filters.clone();
        paged.insert("page".to_owned(), Value::String(page.to_string()));
        paged.insert(
            "pageSize".to_owned(),
            Value::String(EXPORT_PAGE_SIZE.to_string()),
        );
        let response = merchants::list(pool, principal, &encode_query(&paged)).await?;
        total = response
            .get("total")
            .and_then(Value::as_i64)
            .unwrap_or(rows.len() as i64);
        let batch = response
            .get("merchants")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = batch.len();
        rows.extend(batch);
        if count < EXPORT_PAGE_SIZE as usize {
            break;
        }
        page += 1;
    }
    rows.truncate(EXPORT_LIMIT);

    let exported = rows.len() as i64;
    support::write_audit(
        pool,
        dedicated_audit_database,
        principal,
        support::AuditEvent {
            action: "MERCHANTS_EXPORTED",
            entity_type: "MERCHANT",
            entity_id: "export",
            before: json!({}),
            after: json!({
                "total": total,
                "exported": exported,
                "filters": support::query_json(&query),
            }),
        },
    )
    .await?;

    Ok(json!({
        "merchants": rows,
        "total": total,
        "exported": exported,
        "truncated": total > exported,
    }))
}

/// `buildMerchantSummary` (`admin.ts:5451`): the `summary` object.
pub async fn build_summary(pool: &PgPool) -> Result<Value, ApiError> {
    let now = Utc::now();
    let rows = sqlx::query(
        "SELECT status::text AS status, kyb_status::text AS kyb, risk_tier::text AS risk, \
         onboarding_channel AS channel, next_kyb_review_at \
         FROM merchants ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;

    let mut by_status: Vec<(String, i64)> = Vec::new();
    let mut by_kyb: Vec<(String, i64)> = Vec::new();
    let mut by_risk: Vec<(String, i64)> = Vec::new();
    let mut by_channel: Vec<(String, i64)> = Vec::new();
    let mut review_overdue = 0_i64;
    let mut review_due_soon = 0_i64;

    let bump = |list: &mut Vec<(String, i64)>, key: &str| match list
        .iter_mut()
        .find(|(existing, _)| existing == key)
    {
        Some((_, count)) => *count += 1,
        None => list.push((key.to_owned(), 1)),
    };

    for row in &rows {
        let status = common::text(row, "status")?;
        let kyb = common::text(row, "kyb")?;
        let risk = common::text(row, "risk")?;
        let channel = common::text(row, "channel")?;
        bump(&mut by_status, &status);
        bump(&mut by_kyb, &kyb);
        bump(&mut by_risk, &risk);
        bump(&mut by_channel, &channel);
        if let Some(review_at) = common::opt_naive(row, "next_kyb_review_at")? {
            if review_at < now.naive_utc() {
                review_overdue += 1;
            } else if (review_at - now.naive_utc()).num_milliseconds() <= 30 * 24 * 60 * 60 * 1000 {
                review_due_soon += 1;
            }
        }
    }

    let pending_approvals: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT subject_id) FROM approval_requests \
         WHERE subject_type = 'MERCHANT' AND state::text IN ('DRAFT', 'PENDING_REVIEW')",
    )
    .fetch_one(pool)
    .await
    .map_err(common::database_error)?;

    let map = |entries: &[(String, i64)]| {
        entries.iter().fold(Map::new(), |mut map, (key, count)| {
            map.insert(key.clone(), Value::from(*count));
            map
        })
    };
    let count_of = |entries: &[(String, i64)], key: &str| {
        entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map_or(0, |(_, count)| *count)
    };

    Ok(json!({
        "total": rows.len() as i64,
        "active": count_of(&by_status, "ACTIVE"),
        "pending": count_of(&by_status, "PENDING"),
        "suspended": count_of(&by_status, "SUSPENDED"),
        "rejected": count_of(&by_status, "REJECTED"),
        "closed": count_of(&by_status, "CLOSED"),
        "kybPending": count_of(&by_kyb, "PENDING"),
        "kybVerified": count_of(&by_kyb, "VERIFIED"),
        "highRisk": count_of(&by_risk, "HIGH"),
        "reviewOverdue": review_overdue,
        "reviewDueSoon": review_due_soon,
        "pendingApprovals": pending_approvals,
        "byStatus": map(&by_status),
        "byKyb": map(&by_kyb),
        "byRisk": map(&by_risk),
        "byChannel": map(&by_channel),
    }))
}

/// `GET /internal/admin/merchants/summary`.
pub async fn summary(pool: &PgPool) -> Result<Value, ApiError> {
    Ok(json!({ "summary": build_summary(pool).await? }))
}

/// `GET /internal/admin/merchants/summary/export`.
pub async fn summary_export(
    pool: &PgPool,
    dedicated_audit_database: bool,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = build_summary(pool).await?;
    let number = |key: &str| snapshot.get(key).and_then(Value::as_i64).unwrap_or(0);
    support::write_audit(
        pool,
        dedicated_audit_database,
        principal,
        support::AuditEvent {
            action: "MERCHANT_SUMMARY_EXPORTED",
            entity_type: "MERCHANT",
            entity_id: "summary",
            before: json!({}),
            after: json!({
                "total": number("total"),
                "active": number("active"),
                "pending": number("pending"),
                "highRisk": number("highRisk"),
                "reviewOverdue": number("reviewOverdue"),
            }),
        },
    )
    .await?;
    Ok(json!({
        "summary": snapshot,
        "exportedAt": pg_types::JsDate(Utc::now()).to_iso_string(),
    }))
}

async fn count_metric(
    pool: &PgPool,
    sql: &'static str,
    merchant_id: uuid::Uuid,
) -> Result<i64, ApiError> {
    sqlx::query_scalar(sql)
        .bind(merchant_id)
        .fetch_one(pool)
        .await
        .map_err(common::database_error)
}

async fn load_metrics(pool: &PgPool, merchant_id: uuid::Uuid) -> Result<Vec<Value>, ApiError> {
    let since = Utc::now().naive_utc() - chrono::Duration::days(30);
    let rows = sqlx::query(
        "SELECT status::text AS status, count(*) AS count, \
         COALESCE(sum(total_charged_amount), 0) AS charged \
         FROM payment_attempts WHERE merchant_id = $1 AND created_at >= $2 \
         GROUP BY status ORDER BY status",
    )
    .bind(merchant_id)
    .bind(since)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "status": common::text(row, "status")?,
                "count": common::i64_of(row, "count")?,
                "chargedAmount": support::merchant_money(Some(common::decimal(row, "charged")?)),
            }))
        })
        .collect()
}

/// `GET /internal/admin/merchants/:id/summary/export`.
pub async fn merchant_summary_export(
    pool: &PgPool,
    dedicated_audit_database: bool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::parse_uuid(id)?;
    let flags = common::flags(principal);
    let query = common::parse_query(query_string);

    let detail = merchants::detail(pool, principal, &merchant_id.to_string()).await?;
    let mut summary = detail.get("merchant").cloned().unwrap_or(Value::Null);
    let pending_approval_count = count_metric(
        pool,
        "SELECT count(*) FROM approval_requests WHERE subject_type = 'MERCHANT' \
         AND subject_id = $1::text AND state::text IN ('DRAFT', 'PENDING_REVIEW')",
        merchant_id,
    )
    .await?;

    let (metrics, balance, open_disputes, pending_cashouts) = if flags.can_financial {
        let metrics = load_metrics(pool, merchant_id).await?;
        let balance = wallets::merchant_wallet_balance(pool, &merchant_id.to_string()).await?;
        let open_disputes = count_metric(
            pool,
            "SELECT count(*) FROM disputes d JOIN payment_attempts pa ON pa.id = d.attempt_id \
             WHERE pa.merchant_id = $1 AND d.status::text IN \
             ('OPENED', 'EVIDENCE_REQUESTED', 'EVIDENCE_SUBMITTED')",
            merchant_id,
        )
        .await?;
        let pending_cashouts = count_metric(
            pool,
            "SELECT count(*) FROM cashout_requests WHERE merchant_id = $1 \
             AND state::text IN ('PENDING', 'PROCESSING')",
            merchant_id,
        )
        .await?;
        (
            Value::Array(metrics),
            balance,
            open_disputes,
            pending_cashouts,
        )
    } else {
        (Value::Array(Vec::new()), Value::Null, 0, 0)
    };
    let open_aml_cases = if flags.can_aml {
        count_metric(
            pool,
            "SELECT count(*) FROM aml_cases WHERE subject_type::text = 'MERCHANT' \
             AND subject_id = $1::text AND status::text IN ('OPEN', 'IN_REVIEW', 'PENDING_CHECKER')",
            merchant_id,
        )
        .await?
    } else {
        0
    };

    let status = summary
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if let Value::Object(map) = &mut summary {
        for key in DETAIL_ONLY_KEYS {
            map.remove(*key);
        }
        map.insert(
            "pendingApprovalCount".to_owned(),
            Value::from(pending_approval_count),
        );
    }

    let checklist = support::checklist(&query, SUMMARY_EXPORT_CHECKLIST);
    support::write_audit(
        pool,
        dedicated_audit_database,
        principal,
        support::AuditEvent {
            action: "MERCHANT_360_SUMMARY_EXPORTED",
            entity_type: "MERCHANT",
            entity_id: &merchant_id.to_string(),
            before: json!({}),
            after: json!({
                "status": status,
                "pendingApprovalCount": pending_approval_count,
                "openDisputes": open_disputes,
                "pendingCashouts": pending_cashouts,
                "openAmlCases": open_aml_cases,
                "checklist": checklist,
            }),
        },
    )
    .await?;

    Ok(json!({
        "merchant": summary,
        "walletBalance": balance,
        "metrics": metrics,
        "openDisputes": open_disputes,
        "pendingCashouts": pending_cashouts,
        "openAmlCases": open_aml_cases,
        "generatedAt": pg_types::JsDate(Utc::now()).to_iso_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_query_is_encoded_in_insertion_order() {
        let mut query = Map::new();
        query.insert("search".to_owned(), Value::String("acme co".to_owned()));
        query.insert("status".to_owned(), Value::String("ACTIVE".to_owned()));
        assert_eq!(encode_query(&query), "search=acme+co&status=ACTIVE");
    }

    #[test]
    fn detail_only_sections_cover_every_section_the_detail_adds() {
        // `admin_commerce::merchants::detail` appends exactly these keys to the summary.
        for key in [
            "joinRequests",
            "kybDocuments",
            "beneficialOwners",
            "revalidations",
            "amlCases",
            "pendingChanges",
            "wallets",
            "applications",
            "users",
            "accessTokens",
            "credentialSets",
            "fieldHistory",
            "walletBalance",
            "metrics",
            "openDisputes",
            "pendingCashouts",
        ] {
            assert!(DETAIL_ONLY_KEYS.contains(&key), "{key}");
        }
    }

    #[test]
    fn summary_checklist_allow_list_matches_the_ts_set() {
        assert_eq!(SUMMARY_EXPORT_CHECKLIST.len(), 4);
        assert!(SUMMARY_EXPORT_CHECKLIST.contains(&"EXPORT_APPROVAL_CONFIRMED"));
    }
}
