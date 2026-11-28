//! Merchant 360 statistics (`core-back/api/internal/admin.ts:6303`).
//!
//! The TS handler groups attempts by `(status, currency)` over the selected period, folds the
//! success statuses into the requested reporting currency (`resolveReportingCurrency`, default
//! `BASE_CURRENCY`), and returns the per-currency breakdown beside the requested-currency totals.
//! The wallet balance, pending cash-outs, open disputes and pending approvals are currency-aware
//! where the TS code is: cash-outs count only wallets in the requested currency, disputes are
//! merchant-wide.
//!
//! `merchantWalletBalance(client, id, currency)` is implemented by filtering the shared
//! `admin_commerce::wallets::merchant_wallet_balance` result, which is the same query with the
//! currency predicate the TS version pushes into Prisma.

#![forbid(unsafe_code)]

use chrono::Utc;
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::routes::admin_commerce::{common, wallets};

use super::support;

/// One per-currency aggregate (`perCurrency` in the TS handler).
#[derive(Default)]
struct CurrencyTotals {
    currency: String,
    attempt_count: i64,
    successful_count: i64,
    gross_volume: Decimal,
    net_credited: Decimal,
    commission: Decimal,
}

/// `merchantWalletBalance(client, id, currency)`: the shared reader filtered to one currency.
fn wallet_balance_for(value: &Value, currency: &str) -> Value {
    let empty = json!({ "balance": "0.0000", "byCurrency": [], "wallets": [] });
    let Some(entries) = value.get("wallets").and_then(Value::as_array) else {
        return empty;
    };
    let mut total = Decimal::ZERO;
    let mut wallets = Vec::new();
    for entry in entries {
        if entry.get("currency").and_then(Value::as_str) != Some(currency) {
            continue;
        }
        if let Some(balance) = entry
            .get("balance")
            .and_then(Value::as_str)
            .and_then(|text| text.parse::<Decimal>().ok())
        {
            total += balance;
        }
        wallets.push(entry.clone());
    }
    let by_currency = if wallets.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "currency": currency,
            "balance": pg_types::Money4(total).to_string(),
        })]
    };
    json!({
        "balance": pg_types::Money4(total).to_string(),
        "byCurrency": by_currency,
        "wallets": wallets,
    })
}

async fn merchant_wallet_ids(
    pool: &PgPool,
    merchant_id: uuid::Uuid,
    currency: &str,
) -> Result<Vec<uuid::Uuid>, ApiError> {
    sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM wallets WHERE merchant_id = $1 AND currency = $2 ORDER BY created_at ASC",
    )
    .bind(merchant_id)
    .bind(currency)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)
}

/// `GET /internal/admin/merchants/:id/stats`.
pub async fn stats(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    if !flags.can_financial {
        return Err(support::financial_access_required(
            "Financial access is required to view merchant statistics",
        ));
    }
    let query = common::parse_query(query_string);
    let now = Utc::now();
    let (period, days) = support::stats_period(&query);
    let since = support::stats_since(days, now);
    let requested_currency = support::reporting_currency(&query);

    let merchant = sqlx::query(
        "SELECT next_kyb_review_at, negative_balance_ceiling FROM merchants WHERE id = $1",
    )
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(common::database_error)?
    .ok_or_else(support::merchant_not_found)?;

    let status_rows = sqlx::query(
        "SELECT status::text AS status, currency::text AS currency, count(*) AS count, \
         COALESCE(sum(total_charged_amount), 0) AS charged, \
         COALESCE(sum(net_merchant_amount), 0) AS net, \
         COALESCE(sum(platform_commission_amount), 0) AS commission \
         FROM payment_attempts WHERE merchant_id = $1 AND created_at >= $2 \
         GROUP BY status, currency ORDER BY status, currency",
    )
    .bind(merchant_id)
    .bind(since)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;

    let mut per_currency: Vec<CurrencyTotals> = Vec::new();
    let mut attempt_count = 0_i64;
    let mut successful_count = 0_i64;
    let mut gross_volume = Decimal::ZERO;
    let mut net_credited = Decimal::ZERO;
    let mut commission = Decimal::ZERO;
    let mut failed_count = 0_i64;
    let mut expired_count = 0_i64;
    let mut blocked_count = 0_i64;
    let mut unknown_count = 0_i64;
    let mut statuses: Vec<Value> = Vec::new();

    for row in &status_rows {
        let status = common::text(row, "status")?;
        let currency = common::text(row, "currency")?;
        let currency = if currency.trim().is_empty() {
            "UNKNOWN".to_owned()
        } else {
            currency.trim().to_owned()
        };
        let count = common::i64_of(row, "count")?;
        let charged = common::decimal(row, "charged")?;
        let net = common::decimal(row, "net")?;
        let fee = common::decimal(row, "commission")?;
        let success = support::MERCHANT_SUCCESS_STATUSES.contains(&status.as_str());

        let index = match per_currency
            .iter()
            .position(|entry| entry.currency == currency)
        {
            Some(index) => index,
            None => {
                per_currency.push(CurrencyTotals {
                    currency: currency.clone(),
                    ..CurrencyTotals::default()
                });
                per_currency.len() - 1
            }
        };
        let entry = &mut per_currency[index];
        entry.attempt_count += count;
        if success {
            entry.successful_count += count;
            entry.gross_volume += charged;
            entry.net_credited += net;
            entry.commission += fee;
        }

        if currency != requested_currency {
            continue;
        }
        attempt_count += count;
        if success {
            successful_count += count;
            gross_volume += charged;
            net_credited += net;
            commission += fee;
        }
        match status.as_str() {
            "FAILED" => failed_count += count,
            "EXPIRED" => expired_count += count,
            "BLOCKED" => blocked_count += count,
            "UNKNOWN" => unknown_count += count,
            _ => {}
        }
        statuses.push(json!({
            "status": status,
            "count": count,
            "chargedAmount": support::merchant_money(Some(charged)),
        }));
    }

    let wallet_ids = merchant_wallet_ids(pool, merchant_id, &requested_currency).await?;
    let (pending_cashout_count, pending_cashout_amount) = if wallet_ids.is_empty() {
        (0_i64, Decimal::ZERO)
    } else {
        let row = sqlx::query(
            "SELECT count(*) AS count, COALESCE(sum(amount), 0) AS amount \
             FROM cashout_requests WHERE merchant_id = $1 \
             AND state::text IN ('PENDING', 'PROCESSING') AND wallet_id = ANY($2::uuid[])",
        )
        .bind(merchant_id)
        .bind(&wallet_ids)
        .fetch_one(pool)
        .await
        .map_err(common::database_error)?;
        (
            common::i64_of(&row, "count")?,
            common::decimal(&row, "amount")?,
        )
    };

    let open_disputes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes d JOIN payment_attempts pa ON pa.id = d.attempt_id \
         WHERE pa.merchant_id = $1 AND d.status::text IN \
         ('OPENED', 'EVIDENCE_REQUESTED', 'EVIDENCE_SUBMITTED')",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(common::database_error)?;
    let pending_approvals: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval_requests \
         WHERE subject_type = 'MERCHANT' AND subject_id = $1::text AND state::text = 'PENDING_REVIEW'",
    )
    .bind(merchant_id.to_string())
    .fetch_one(pool)
    .await
    .map_err(common::database_error)?;

    let all_balances = wallets::merchant_wallet_balance(pool, &merchant_id.to_string()).await?;
    let wallet_balance = wallet_balance_for(&all_balances, &requested_currency);
    let negative_balance_ceiling = common::decimal(&merchant, "negative_balance_ceiling")?;
    let next_kyb_review_at = common::opt_naive(&merchant, "next_kyb_review_at")?;

    let by_currency: Vec<Value> = per_currency
        .iter()
        .map(|entry| {
            json!({
                "currency": entry.currency,
                "attemptCount": entry.attempt_count,
                "successfulCount": entry.successful_count,
                "grossVolume": pg_types::Money4(entry.gross_volume).to_string(),
                "netCredited": pg_types::Money4(entry.net_credited).to_string(),
                "commission": pg_types::Money4(entry.commission).to_string(),
            })
        })
        .collect();

    let average_ticket = if successful_count == 0 {
        "0.0000".to_owned()
    } else {
        pg_types::Money4(gross_volume / Decimal::from(successful_count)).to_string()
    };

    let mut totals = Map::new();
    totals.insert("attemptCount".to_owned(), Value::from(attempt_count));
    totals.insert("successfulCount".to_owned(), Value::from(successful_count));
    totals.insert(
        "successRate".to_owned(),
        support::success_rate_percent(successful_count, attempt_count),
    );
    totals.insert(
        "grossVolume".to_owned(),
        Value::String(pg_types::Money4(gross_volume).to_string()),
    );
    totals.insert(
        "netCredited".to_owned(),
        Value::String(pg_types::Money4(net_credited).to_string()),
    );
    totals.insert(
        "commission".to_owned(),
        Value::String(pg_types::Money4(commission).to_string()),
    );
    totals.insert("averageTicket".to_owned(), Value::String(average_ticket));
    totals.insert("failedCount".to_owned(), Value::from(failed_count));
    totals.insert("expiredCount".to_owned(), Value::from(expired_count));
    totals.insert("blockedCount".to_owned(), Value::from(blocked_count));
    totals.insert("unknownCount".to_owned(), Value::from(unknown_count));

    Ok(json!({
        "period": period,
        "since": pg_types::JsDate(chrono::DateTime::<Utc>::from_naive_utc_and_offset(since, Utc))
            .to_iso_string(),
        "currency": requested_currency,
        "byCurrency": by_currency,
        "mixedCurrency": per_currency.len() > 1,
        "totals": Value::Object(totals),
        "statuses": statuses,
        "walletBalance": wallet_balance,
        "negativeBalanceCeiling": support::merchant_money(Some(negative_balance_ceiling)),
        "pendingCashouts": {
            "count": pending_cashout_count,
            "amount": support::merchant_money(Some(pending_cashout_amount)),
        },
        "openDisputes": open_disputes,
        "pendingApprovals": pending_approvals,
        "nextKybReviewAt": common::iso_value(next_kyb_review_at),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_balance_filters_one_currency_and_keeps_the_shape() {
        let value = json!({
            "balance": "30.0000",
            "byCurrency": [
                { "currency": "LYD", "balance": "25.0000" },
                { "currency": "USD", "balance": "5.0000" }
            ],
            "wallets": [
                { "id": "a", "walletId": "a", "currency": "LYD", "status": "ACTIVE", "balance": "25.0000" },
                { "id": "b", "walletId": "b", "currency": "USD", "status": "ACTIVE", "balance": "5.0000" }
            ],
        });
        let filter = wallet_balance_for(&value, "LYD");
        assert_eq!(filter["balance"], "25.0000");
        assert_eq!(filter["wallets"].as_array().map(Vec::len), Some(1));
        assert_eq!(filter["byCurrency"][0]["currency"], "LYD");
        let empty = wallet_balance_for(&value, "EUR");
        assert_eq!(empty["balance"], "0.0000");
        assert_eq!(empty["byCurrency"].as_array().map(Vec::len), Some(0));
        assert_eq!(empty["wallets"].as_array().map(Vec::len), Some(0));
        assert_eq!(wallet_balance_for(&json!({}), "LYD")["balance"], "0.0000");
    }

    #[test]
    fn success_statuses_match_the_shared_list() {
        assert_eq!(support::MERCHANT_SUCCESS_STATUSES.len(), 4);
        assert!(support::MERCHANT_SUCCESS_STATUSES.contains(&"DISPUTED"));
        assert!(!support::MERCHANT_SUCCESS_STATUSES.contains(&"FAILED"));
        assert!(!support::MERCHANT_SUCCESS_STATUSES.contains(&"PENDING"));
    }
}
