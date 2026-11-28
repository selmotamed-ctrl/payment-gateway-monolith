//! Finance dashboards: profitability, liquidity, the ledger invariant and daily route caps.
//!
//! Port of the `GET /internal/admin/finance/{profitability,liquidity,invariant-check,route-caps}`
//! handlers and their `*/export` twins in `core-back/api/internal/admin.ts` (`19157-19730`,
//! `19383-19440`). Money leaves as `toFixed(4)` (`Money4`); percentages as `toFixed(2)`/`toFixed(4)`
//! exactly like the decimal.js expressions they replace.
//!
//! The ledger is only read: balances come from the shard projection via
//! `loadLiveAccountBalances` (sum of `gl_account_shards.current_balance`), never from a hand-written
//! journal sum.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

use crate::state::AppState;

use super::support::{
    self, checklist, iso_utc, load_live_balances, money4, money_dec, natural_balance,
    parse_js_date, query_map, resolve_reporting_currency, scalar_raw, sqlx_error, write_audit_row,
};

/// The strict `profitabilityQuerySchema` (`admin.ts:19144-19154`).
struct ProfitQuery {
    period: String,
    from: Option<String>,
    to: Option<String>,
    currency: Option<String>,
}

fn parse_profit_query(query: &Map<String, Value>) -> Result<ProfitQuery, ApiError> {
    let allowed = ["period", "from", "to", "currency", "checklist"];
    for key in query.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(
                ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
                    "path": [],
                    "code": "unrecognized_keys",
                    "message": "Unrecognized key",
                }])),
            );
        }
    }
    let period = scalar_raw(query, "period").unwrap_or("last_30d");
    if !["today", "last_7d", "last_30d", "last_90d"].contains(&period) {
        return Err(
            ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
                "path": ["period"],
                "code": "invalid_enum_value",
                "message": "Invalid enum value",
            }])),
        );
    }
    for (key, max) in [("from", 64_usize), ("to", 64), ("checklist", 1000)] {
        if scalar_raw(query, key).is_some_and(|value| value.encode_utf16().count() > max) {
            return Err(
                ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
                    "path": [key],
                    "code": "too_big",
                    "message": "String must contain at most characters",
                }])),
            );
        }
    }
    if scalar_raw(query, "currency").is_some_and(|value| value.len() != 3) {
        return Err(
            ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
                "path": ["currency"],
                "code": "too_small",
                "message": "String must contain exactly 3 character(s)",
            }])),
        );
    }
    Ok(ProfitQuery {
        period: period.to_owned(),
        from: scalar_raw(query, "from").map(str::to_owned),
        to: scalar_raw(query, "to").map(str::to_owned),
        currency: scalar_raw(query, "currency").map(str::to_owned),
    })
}

#[derive(Debug, Default, Clone)]
struct ProfitBucket {
    volume: Decimal,
    gross: Decimal,
    cost: Decimal,
}

fn percent(numerator: Decimal, denominator: Decimal) -> String {
    if denominator.is_zero() {
        return "0.0000".to_owned();
    }
    let ratio = numerator.checked_div(denominator).unwrap_or_default() * Decimal::from(100);
    money4(ratio)
}

fn average(value: Decimal, count: usize) -> String {
    if count == 0 {
        return "0.0000".to_owned();
    }
    money4(value.checked_div(Decimal::from(count)).unwrap_or_default())
}

fn profit_rows(source: &HashMap<String, ProfitBucket>, key_name: &str) -> Vec<Value> {
    let mut keys: Vec<&String> = source.keys().collect();
    keys.sort_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    keys.into_iter()
        .map(|key| {
            let bucket = &source[key];
            let mut row = Map::new();
            row.insert(key_name.to_owned(), Value::String(key.clone()));
            row.insert("volume".to_owned(), Value::String(money4(bucket.volume)));
            row.insert("gross".to_owned(), Value::String(money4(bucket.gross)));
            row.insert("cost".to_owned(), Value::String(money4(bucket.cost)));
            row.insert(
                "net".to_owned(),
                Value::String(money4(bucket.gross - bucket.cost)),
            );
            row.insert("commission".to_owned(), Value::String(money4(bucket.gross)));
            Value::Object(row)
        })
        .collect()
}

async fn profitability_snapshot(
    state: &AppState,
    query: &Map<String, Value>,
) -> Result<Value, ApiError> {
    let parsed = parse_profit_query(query)?;
    let days = match parsed.period.as_str() {
        "today" => 1,
        "last_7d" => 7,
        "last_30d" => 30,
        "last_90d" => 90,
        _ => 30,
    };
    let now = Utc::now();
    let mut since = now - chrono::Duration::days(days);
    let mut until: Option<DateTime<Utc>> = None;
    if let Some(value) = parsed.from.as_deref().and_then(parse_js_date) {
        since = value;
    }
    if let Some(value) = parsed.to.as_deref().and_then(parse_js_date) {
        until = Some(value);
    }
    let window_end = until.unwrap_or(now);
    let window_days = ((window_end - since).num_milliseconds() as f64 / 86_400_000.0)
        .ceil()
        .max(1.0) as i64;
    let currency = resolve_reporting_currency(parsed.currency.as_deref());
    let pool = &state.pools.main;

    let attempts = if let Some(until) = until {
        sqlx::query(
            "SELECT status::text AS status, total_charged_amount::text AS volume,
                    platform_commission_amount::text AS commission,
                    net_merchant_amount::text AS net_merchant,
                    gateway_fee_amount::text AS gateway_fee, created_at,
                    rail_id::text AS rail_id, route_id::text AS route_id
             FROM payment_attempts
             WHERE currency = $1::char(3) AND created_at >= $2 AND created_at <= $3",
        )
        .bind(&currency)
        .bind(since.naive_utc())
        .bind(until.naive_utc())
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?
    } else {
        sqlx::query(
            "SELECT status::text AS status, total_charged_amount::text AS volume,
                    platform_commission_amount::text AS commission,
                    net_merchant_amount::text AS net_merchant,
                    gateway_fee_amount::text AS gateway_fee, created_at,
                    rail_id::text AS rail_id, route_id::text AS route_id
             FROM payment_attempts
             WHERE currency = $1::char(3) AND created_at >= $2",
        )
        .bind(&currency)
        .bind(since.naive_utc())
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?
    };

    let currency_rows = if let Some(until) = until {
        sqlx::query(
            "SELECT currency::text AS currency,
                    SUM(total_charged_amount)::text AS volume,
                    SUM(platform_commission_amount)::text AS commission,
                    SUM(gateway_fee_amount)::text AS gateway_fee,
                    SUM(net_merchant_amount)::text AS net_merchant
             FROM payment_attempts WHERE created_at >= $1 AND created_at <= $2
             GROUP BY currency ORDER BY currency",
        )
        .bind(since.naive_utc())
        .bind(until.naive_utc())
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?
    } else {
        sqlx::query(
            "SELECT currency::text AS currency,
                    SUM(total_charged_amount)::text AS volume,
                    SUM(platform_commission_amount)::text AS commission,
                    SUM(gateway_fee_amount)::text AS gateway_fee,
                    SUM(net_merchant_amount)::text AS net_merchant
             FROM payment_attempts WHERE created_at >= $1
             GROUP BY currency ORDER BY currency",
        )
        .bind(since.naive_utc())
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?
    };

    let rail_rows = sqlx::query("SELECT id::text AS id, code FROM rails")
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let mut rail_codes = HashMap::with_capacity(rail_rows.len());
    for row in &rail_rows {
        rail_codes.insert(
            row.try_get::<String, _>("id").map_err(sqlx_error)?,
            row.try_get::<String, _>("code").map_err(sqlx_error)?,
        );
    }
    let route_rows =
        sqlx::query("SELECT id::text AS id, gateway_id::text AS gateway_id FROM rail_routes")
            .fetch_all(pool)
            .await
            .map_err(sqlx_error)?;
    let mut route_gateways = HashMap::with_capacity(route_rows.len());
    for row in &route_rows {
        route_gateways.insert(
            row.try_get::<String, _>("id").map_err(sqlx_error)?,
            row.try_get::<String, _>("gateway_id").map_err(sqlx_error)?,
        );
    }
    let gateway_rows = sqlx::query("SELECT id::text AS id, code FROM gateways")
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let mut gateway_codes = HashMap::with_capacity(gateway_rows.len());
    for row in &gateway_rows {
        gateway_codes.insert(
            row.try_get::<String, _>("id").map_err(sqlx_error)?,
            row.try_get::<String, _>("code").map_err(sqlx_error)?,
        );
    }

    let mut gross_volume = Decimal::ZERO;
    let mut gross_commission = Decimal::ZERO;
    let mut net_merchant = Decimal::ZERO;
    let mut gateway_cost_period = Decimal::ZERO;
    let mut by_rail: HashMap<String, ProfitBucket> = HashMap::new();
    let mut by_day: HashMap<String, ProfitBucket> = HashMap::new();
    let mut by_gateway: HashMap<String, ProfitBucket> = HashMap::new();
    let mut succeeded_attempts = 0_usize;
    for attempt in &attempts {
        if attempt.try_get::<String, _>("status").map_err(sqlx_error)? != "SUCCEEDED" {
            continue;
        }
        succeeded_attempts += 1;
        let volume = money_dec(&attempt.try_get::<String, _>("volume").map_err(sqlx_error)?);
        let commission = money_dec(
            &attempt
                .try_get::<String, _>("commission")
                .map_err(sqlx_error)?,
        );
        let cost = attempt
            .try_get::<Option<String>, _>("gateway_fee")
            .map_err(sqlx_error)?
            .map_or(Decimal::ZERO, |value| money_dec(&value));
        let net = money_dec(
            &attempt
                .try_get::<String, _>("net_merchant")
                .map_err(sqlx_error)?,
        );
        gross_volume += volume;
        gross_commission += commission;
        net_merchant += net;
        gateway_cost_period += cost;

        let rail_id: String = attempt.try_get("rail_id").map_err(sqlx_error)?;
        let rail_code = rail_codes
            .get(&rail_id)
            .cloned()
            .unwrap_or_else(|| "unknown".to_owned());
        let rail = by_rail.entry(rail_code).or_default();
        rail.volume += volume;
        rail.gross += commission;
        rail.cost += cost;

        let created_at: chrono::NaiveDateTime =
            attempt.try_get("created_at").map_err(sqlx_error)?;
        let day = created_at.format("%Y-%m-%d").to_string();
        let day_bucket = by_day.entry(day).or_default();
        day_bucket.volume += volume;
        day_bucket.gross += commission;
        day_bucket.cost += cost;

        let route_id: String = attempt.try_get("route_id").map_err(sqlx_error)?;
        let gateway_id = route_gateways
            .get(&route_id)
            .cloned()
            .unwrap_or_else(|| "unknown".to_owned());
        let gateway_code = gateway_codes
            .get(&gateway_id)
            .cloned()
            .unwrap_or(gateway_id);
        let gateway = by_gateway.entry(gateway_code).or_default();
        gateway.volume += volume;
        gateway.gross += commission;
        gateway.cost += cost;
    }

    // `loadLedgerBalances(currency)` followed by `naturalBalance` on the grouped value.
    let live = load_live_balances(pool, None).await?;
    let mut balances: HashMap<String, Decimal> = HashMap::new();
    for account in &live {
        if account.currency != currency {
            continue;
        }
        *balances.entry(account.account_type.clone()).or_default() += account.balance;
    }
    let natural = |account_type: &str| {
        natural_balance(
            account_type,
            balances.get(account_type).copied().unwrap_or_default(),
        )
    };
    let gateway_cost_realized = natural("GATEWAY_FEE_EXPENSE") + natural("PROVIDER_FEE_EXPENSE");
    let gateway_cost_accrued = natural("GATEWAY_FEE_ACCRUAL");
    let chargeback_losses = natural("CHARGEBACK_RESERVE");
    let commission_receivable = natural("COMMISSION_RECEIVABLE");
    let net_revenue = gross_commission - gateway_cost_realized;
    let net_contribution = net_revenue - chargeback_losses;

    let adjustment_row = sqlx::query(
        "SELECT COALESCE(SUM(a.amount) FILTER (WHERE a.type = 'CHARGEBACK'), 0)::text AS chargeback,
                COALESCE(SUM(a.amount) FILTER (WHERE a.type = 'REFUND' AND a.reverse_commission), 0)::text AS refund
         FROM adjustments a
         INNER JOIN gl_accounts g ON g.id = a.target_gl_account_id
         WHERE a.state = 'EXECUTED' AND g.currency = $1::char(3)
           AND a.updated_at >= $2 AND a.updated_at <= $3",
    )
    .bind(&currency)
    .bind(since.naive_utc())
    .bind(window_end.naive_utc())
    .fetch_one(pool)
    .await
    .map_err(sqlx_error)?;
    let chargeback_losses_period = money_dec(
        &adjustment_row
            .try_get::<String, _>("chargeback")
            .map_err(sqlx_error)?,
    );
    let refund_commission_reversed = money_dec(
        &adjustment_row
            .try_get::<String, _>("refund")
            .map_err(sqlx_error)?,
    );
    let period_net_revenue = gross_commission - gateway_cost_period;
    let period_net_contribution = period_net_revenue - chargeback_losses_period;

    let mut by_currency = Vec::with_capacity(currency_rows.len());
    for row in &currency_rows {
        let volume = money_dec(
            &row.try_get::<Option<String>, _>("volume")
                .map_err(sqlx_error)?
                .unwrap_or_default(),
        );
        let gross = money_dec(
            &row.try_get::<Option<String>, _>("commission")
                .map_err(sqlx_error)?
                .unwrap_or_default(),
        );
        let cost = money_dec(
            &row.try_get::<Option<String>, _>("gateway_fee")
                .map_err(sqlx_error)?
                .unwrap_or_default(),
        );
        by_currency.push(json!({
            "currency": row.try_get::<String, _>("currency").map_err(sqlx_error)?,
            "volume": money4(volume),
            "grossCommissionRevenue": money4(gross),
            "gatewayCost": money4(cost),
            "netContribution": money4(gross - cost),
        }));
    }

    Ok(json!({
        "period": parsed.period,
        "currency": currency,
        "byCurrency": by_currency,
        "windowDays": window_days,
        "windowStart": iso_utc(since),
        "windowEnd": iso_utc(window_end),
        "succeededAttempts": succeeded_attempts,
        "grossVolume": money4(gross_volume),
        "grossCommissionRevenue": money4(gross_commission),
        "netMerchantAmount": money4(net_merchant),
        "gatewayCostRealized": money4(gateway_cost_realized),
        "gatewayCostAccrued": money4(gateway_cost_accrued),
        "netRevenue": money4(net_revenue),
        "chargebackLosses": money4(chargeback_losses),
        "netContribution": money4(net_contribution),
        "gatewayCostPeriod": money4(gateway_cost_period),
        "periodNetRevenue": money4(period_net_revenue),
        "chargebackLossesPeriod": money4(chargeback_losses_period),
        "periodNetContribution": money4(period_net_contribution),
        "refundCommissionReversed": money4(refund_commission_reversed),
        "commissionReceivable": money4(commission_receivable),
        "commissionMargin": percent(period_net_revenue, gross_commission),
        "gatewayCostRatio": percent(gateway_cost_period, gross_commission),
        "netMargin": percent(period_net_contribution, gross_commission),
        "averageTicket": average(gross_volume, succeeded_attempts),
        "averageCommission": average(gross_commission, succeeded_attempts),
        "byRail": profit_rows(&by_rail, "railCode"),
        "byDay": profit_rows(&by_day, "day"),
        "byGateway": profit_rows(&by_gateway, "gatewayCode"),
    }))
}

async fn profitability_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    profitability_snapshot(state, &query_map(request)).await
}

async fn profitability_export_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let query = query_map(request);
    let snapshot = profitability_snapshot(state, &query).await?;
    let checklist = checklist(
        &query,
        &[
            "PROFITABILITY_SCOPE_VERIFIED",
            "MARGIN_AND_COST_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit_row(
        state,
        principal,
        "PROFITABILITY_EXPORTED",
        "PROFITABILITY",
        "snapshot",
        json!({}),
        json!({
            "period": snapshot["period"],
            "windowStart": snapshot["windowStart"],
            "windowEnd": snapshot["windowEnd"],
            "grossVolume": snapshot["grossVolume"],
            "netContribution": snapshot["netContribution"],
            "checklist": checklist,
        }),
    )
    .await?;
    let mut response = snapshot;
    if let Value::Object(map) = &mut response {
        map.insert("exportedAt".to_owned(), json!(iso_utc(Utc::now())));
    }
    Ok(response)
}

#[derive(Debug, Default, Clone)]
struct CurrencyBalances {
    treasury: Decimal,
    clearing: Decimal,
    obligations: Decimal,
}

#[derive(Debug, Default, Clone)]
struct CurrencyCashouts {
    pending: i64,
    processing: i64,
    next_day_demand: Decimal,
}

#[derive(Debug, Default, Clone)]
struct ClearingBuckets {
    t0: Decimal,
    t1: Decimal,
    t2: Decimal,
    older: Decimal,
}

struct CashoutRow {
    state: String,
    amount: Decimal,
    created_at: chrono::NaiveDateTime,
    currency: String,
}

struct UnsettledRow {
    created_at: chrono::NaiveDateTime,
    amount: Decimal,
}

async fn liquidity_snapshot(state: &AppState, currency: &str) -> Result<Value, ApiError> {
    let now = Utc::now();
    let pool = &state.pools.main;
    let live = load_live_balances(pool, None).await?;

    let mut balances: HashMap<String, Decimal> = HashMap::new();
    let mut balance_by_currency: HashMap<String, CurrencyBalances> = HashMap::new();
    for account in &live {
        if account.currency == currency {
            *balances.entry(account.account_type.clone()).or_default() += account.balance;
        }
        let entry = balance_by_currency
            .entry(account.currency.clone())
            .or_default();
        match account.account_type.as_str() {
            "TREASURY" => entry.treasury += account.balance,
            "GATEWAY_CLEARING" => entry.clearing += account.balance,
            "MERCHANT_WALLET" => entry.obligations += account.balance,
            _ => {}
        }
    }
    let debit_positive =
        |account_type: &str| balances.get(account_type).copied().unwrap_or_default();
    let credit_positive = |account_type: &str| {
        natural_balance(
            account_type,
            balances.get(account_type).copied().unwrap_or_default(),
        )
    };
    let treasury = debit_positive("TREASURY");
    let clearing = debit_positive("GATEWAY_CLEARING");
    let wallet_obligations = credit_positive("MERCHANT_WALLET");
    let cover_ratio = if clearing.is_zero() {
        Decimal::ONE
    } else {
        treasury.checked_div(clearing).unwrap_or_default()
    };

    let cashout_rows = sqlx::query(
        "SELECT c.state::text AS state, c.amount::text AS amount, c.created_at,
                w.currency::text AS currency
         FROM cashout_requests c INNER JOIN wallets w ON w.id = c.wallet_id",
    )
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut cashouts = Vec::with_capacity(cashout_rows.len());
    for row in &cashout_rows {
        cashouts.push(CashoutRow {
            state: row.try_get("state").map_err(sqlx_error)?,
            amount: money_dec(&row.try_get::<String, _>("amount").map_err(sqlx_error)?),
            created_at: row.try_get("created_at").map_err(sqlx_error)?,
            currency: row.try_get("currency").map_err(sqlx_error)?,
        });
    }

    let tomorrow = now + chrono::Duration::hours(24);
    let mut cashout_by_currency: HashMap<String, CurrencyCashouts> = HashMap::new();
    for cashout in &cashouts {
        let entry = cashout_by_currency
            .entry(cashout.currency.clone())
            .or_default();
        if cashout.state == "PENDING" {
            entry.pending += 1;
        }
        if cashout.state == "PROCESSING" {
            entry.processing += 1;
        }
        if cashout.created_at <= tomorrow.naive_utc()
            && (cashout.state == "PENDING" || cashout.state == "PROCESSING")
        {
            entry.next_day_demand += cashout.amount;
        }
    }
    let selected: Vec<&CashoutRow> = cashouts
        .iter()
        .filter(|cashout| cashout.currency == currency)
        .collect();
    let pending = selected
        .iter()
        .filter(|cashout| cashout.state == "PENDING")
        .count() as i64;
    let processing = selected
        .iter()
        .filter(|cashout| cashout.state == "PROCESSING")
        .count() as i64;
    let completed = selected
        .iter()
        .filter(|cashout| cashout.state == "COMPLETE" || cashout.state == "SUBTRACTED")
        .count() as i64;
    let next_day_demand: Decimal = selected
        .iter()
        .filter(|cashout| {
            cashout.created_at <= tomorrow.naive_utc()
                && (cashout.state == "PENDING" || cashout.state == "PROCESSING")
        })
        .map(|cashout| cashout.amount)
        .sum();

    let oldest_case: Option<chrono::NaiveDateTime> = sqlx::query_scalar(
        "SELECT created_at FROM operator_cases WHERE state::text <> 'RESOLVED'
         ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(sqlx_error)?;
    let oldest_item_age_days = oldest_case.map_or(0, |created| {
        ((now.naive_utc() - created).num_milliseconds() / 86_400_000).max(0)
    });

    let unsettled_rows = sqlx::query(
        "SELECT created_at, COALESCE(settled_amount, total_charged_amount)::text AS amount
         FROM payment_attempts
         WHERE status::text = 'SUCCEEDED' AND currency = $1::char(3)
           AND created_at >= $2",
    )
    .bind(currency)
    .bind((now - chrono::Duration::days(90)).naive_utc())
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut unsettled = Vec::with_capacity(unsettled_rows.len());
    for row in &unsettled_rows {
        unsettled.push(UnsettledRow {
            created_at: row.try_get("created_at").map_err(sqlx_error)?,
            amount: money_dec(&row.try_get::<String, _>("amount").map_err(sqlx_error)?),
        });
    }

    let clearing_rows = sqlx::query(
        "SELECT id, gateway_id::text AS gateway_id FROM gl_accounts
         WHERE account_type = 'GATEWAY_CLEARING' AND currency = $1::char(3)",
    )
    .bind(currency)
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut clearing_accounts: Vec<(Uuid, Option<String>)> =
        Vec::with_capacity(clearing_rows.len());
    for row in &clearing_rows {
        clearing_accounts.push((
            row.try_get::<Uuid, _>("id").map_err(sqlx_error)?,
            row.try_get::<Option<String>, _>("gateway_id")
                .map_err(sqlx_error)?,
        ));
    }
    let clearing_ids: Vec<Uuid> = clearing_accounts.iter().map(|(id, _)| *id).collect();
    let clearing_live = load_live_balances(pool, Some(&clearing_ids)).await?;
    let live_by_account: HashMap<Uuid, Decimal> = clearing_live
        .iter()
        .map(|row| (row.id, row.balance))
        .collect();
    let mut clearing_balance_by_gateway: HashMap<String, Decimal> = HashMap::new();
    for (account_id, gateway_id) in &clearing_accounts {
        if let Some(gateway_id) = gateway_id {
            *clearing_balance_by_gateway
                .entry(gateway_id.clone())
                .or_default() += live_by_account.get(account_id).copied().unwrap_or_default();
        }
    }

    let movement_rows = if clearing_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            "SELECT a.gateway_id::text AS gateway_id,
                    COALESCE(SUM(x.signed) FILTER (WHERE x.age <= 0), 0)::text AS t0,
                    COALESCE(SUM(x.signed) FILTER (WHERE x.age = 1), 0)::text AS t1,
                    COALESCE(SUM(x.signed) FILTER (WHERE x.age = 2), 0)::text AS t2
             FROM (
               SELECT jl.gl_account_id,
                      FLOOR(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - jl.created_at)) / 86400)::int AS age,
                      CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END AS signed
               FROM journal_lines jl
               WHERE jl.gl_account_id = ANY($1::uuid[])
                 AND jl.created_at >= (now() AT TIME ZONE 'UTC') - interval '3 days'
             ) x
             INNER JOIN gl_accounts a ON a.id = x.gl_account_id
             GROUP BY a.gateway_id",
        )
        .bind(&clearing_ids)
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?
    };
    let mut clearing_buckets: HashMap<String, ClearingBuckets> = HashMap::new();
    for row in &movement_rows {
        let Some(gateway_id) = row
            .try_get::<Option<String>, _>("gateway_id")
            .map_err(sqlx_error)?
        else {
            continue;
        };
        let balance = clearing_balance_by_gateway
            .get(&gateway_id)
            .copied()
            .unwrap_or_default();
        let t0 = money_dec(&row.try_get::<String, _>("t0").map_err(sqlx_error)?);
        let t1 = money_dec(&row.try_get::<String, _>("t1").map_err(sqlx_error)?);
        let t2 = money_dec(&row.try_get::<String, _>("t2").map_err(sqlx_error)?);
        clearing_buckets.insert(
            gateway_id,
            ClearingBuckets {
                t0,
                t1,
                t2,
                older: balance - t0 - t1 - t2,
            },
        );
    }
    for (gateway_id, balance) in &clearing_balance_by_gateway {
        clearing_buckets
            .entry(gateway_id.clone())
            .or_insert_with(|| ClearingBuckets {
                t0: Decimal::ZERO,
                t1: Decimal::ZERO,
                t2: Decimal::ZERO,
                older: *balance,
            });
    }

    let gateway_rows = sqlx::query("SELECT id::text AS id, code, name FROM gateways")
        .fetch_all(pool)
        .await
        .map_err(sqlx_error)?;
    let mut gateways: HashMap<String, (String, String)> =
        HashMap::with_capacity(gateway_rows.len());
    for row in &gateway_rows {
        gateways.insert(
            row.try_get::<String, _>("id").map_err(sqlx_error)?,
            (
                row.try_get::<String, _>("code").map_err(sqlx_error)?,
                row.try_get::<String, _>("name").map_err(sqlx_error)?,
            ),
        );
    }
    let mut clearing_by_gateway: Vec<Value> = clearing_balance_by_gateway
        .iter()
        .map(|(gateway_id, balance)| {
            let (code, name) = gateways
                .get(gateway_id)
                .cloned()
                .unwrap_or_else(|| (gateway_id.clone(), String::new()));
            let buckets = clearing_buckets
                .get(gateway_id)
                .cloned()
                .unwrap_or_default();
            json!({
                "gatewayId": gateway_id,
                "gatewayCode": code,
                "gatewayName": name,
                "balance": money4(*balance),
                "t0": money4(buckets.t0),
                "t1": money4(buckets.t1),
                "t2": money4(buckets.t2),
                "older": money4(buckets.older),
            })
        })
        .collect();
    clearing_by_gateway.sort_by(|left, right| {
        left["gatewayCode"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .cmp(
                &right["gatewayCode"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase(),
            )
    });

    let ageing_bucket = |label: &str, min_days: i64, max_days: i64| {
        let rows: Vec<&UnsettledRow> = unsettled
            .iter()
            .filter(|attempt| {
                let age = (now.naive_utc() - attempt.created_at).num_milliseconds() / 86_400_000;
                (min_days..=max_days).contains(&age)
            })
            .collect();
        let amount: Decimal = rows.iter().map(|attempt| attempt.amount).sum();
        json!({
            "bucket": label,
            "count": rows.len(),
            "amount": money4(amount),
        })
    };

    let currencies: BTreeSet<String> = balance_by_currency
        .keys()
        .chain(cashout_by_currency.keys())
        .cloned()
        .collect();
    let mut by_currency = Vec::with_capacity(currencies.len());
    for code in currencies {
        let balance = balance_by_currency.get(&code).cloned().unwrap_or_default();
        let queue = cashout_by_currency.get(&code).cloned().unwrap_or_default();
        by_currency.push(json!({
            "currency": code,
            "treasuryBalance": money4(balance.treasury),
            "clearingBalances": money4(balance.clearing),
            "obligations": money4(balance.obligations),
            "coverRatio": if balance.clearing.is_zero() {
                money4(Decimal::ONE)
            } else {
                money4(balance.treasury.checked_div(balance.clearing).unwrap_or_default())
            },
            "pending": queue.pending,
            "processing": queue.processing,
            "nextDayDemand": money4(queue.next_day_demand),
        }));
    }

    Ok(json!({
        "currency": currency,
        "byCurrency": by_currency,
        "checkedAt": iso_utc(now),
        "treasuryBalance": money4(treasury),
        "clearingBalances": money4(clearing),
        "obligations": money4(wallet_obligations),
        "coverRatio": money4(cover_ratio),
        "cashoutQueue": {
            "pending": pending,
            "processing": processing,
            "completed": completed,
            "nextDayDemand": money4(next_day_demand),
        },
        "holdsAndReserves": {
            "amlHold": money4(credit_positive("AML_HOLD")),
            "chargebackReserve": money4(credit_positive("CHARGEBACK_RESERVE")),
            "suspense": money4(credit_positive("SUSPENSE")),
            "oldestItemAgeDays": oldest_item_age_days,
        },
        "receivables": {
            "commissionReceivable": money4(debit_positive("COMMISSION_RECEIVABLE")),
        },
        "clearingAgeing": [
            ageing_bucket("0-7 days", 0, 7),
            ageing_bucket("8-30 days", 8, 30),
            ageing_bucket("31+ days", 31, 3650),
        ],
        "clearingByGateway": clearing_by_gateway,
    }))
}

async fn liquidity_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let query = query_map(request);
    let currency = resolve_reporting_currency(scalar_raw(&query, "currency"));
    liquidity_snapshot(state, &currency).await
}

async fn liquidity_export_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let query = query_map(request);
    let currency = resolve_reporting_currency(scalar_raw(&query, "currency"));
    let snapshot = liquidity_snapshot(state, &currency).await?;
    let checklist = checklist(
        &query,
        &[
            "LIQUIDITY_SCOPE_VERIFIED",
            "COVER_AND_OBLIGATIONS_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit_row(
        state,
        principal,
        "LIQUIDITY_EXPORTED",
        "LIQUIDITY",
        "snapshot",
        json!({}),
        json!({
            "coverRatio": snapshot["coverRatio"],
            "treasuryBalance": snapshot["treasuryBalance"],
            "clearingBalances": snapshot["clearingBalances"],
            "gatewayCount": snapshot["clearingByGateway"].as_array().map_or(0, Vec::len),
            "checklist": checklist,
        }),
    )
    .await?;
    let mut response = snapshot;
    if let Value::Object(map) = &mut response {
        map.insert("exportedAt".to_owned(), json!(iso_utc(Utc::now())));
    }
    Ok(response)
}

async fn invariant_snapshot(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT g.id::text AS id, g.account_type::text AS account_type,
                COALESCE(SUM(c.checkpoint_balance), 0)::text AS checkpoint_balance,
                MIN(c.checkpoint_at) AS checkpoint_at,
                COALESCE(SUM(s.current_balance), 0)::text AS live
         FROM gl_accounts g
         LEFT JOIN gl_account_shards s ON s.gl_account_id = g.id
         LEFT JOIN gl_shard_checkpoints c
                ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
         GROUP BY g.id, g.account_type
         ORDER BY g.id ASC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(sqlx_error)?;

    let mut sides: HashMap<String, Decimal> = HashMap::new();
    let mut accounts = Vec::with_capacity(rows.len());
    for row in &rows {
        let account_type: String = row.try_get("account_type").map_err(sqlx_error)?;
        let live = money_dec(&row.try_get::<String, _>("live").map_err(sqlx_error)?);
        *sides.entry(account_type.clone()).or_default() += live;
        accounts.push(json!({
            "accountId": row.try_get::<String, _>("id").map_err(sqlx_error)?,
            "accountType": account_type.clone(),
            "liveBalance": money4(live),
            "naturalBalance": money4(natural_balance(&account_type, live)),
            "checkpointAt": row.try_get::<Option<DateTime<Utc>>, _>("checkpoint_at")
                .map_err(sqlx_error)?.map(iso_utc),
        }));
    }
    let natural = |account_type: &str| {
        natural_balance(
            account_type,
            sides.get(account_type).copied().unwrap_or_default(),
        )
    };
    let left_side =
        natural("TREASURY") + natural("GATEWAY_CLEARING") + natural("COMMISSION_RECEIVABLE");
    let right_side = natural("MERCHANT_WALLET") + natural("PLATFORM_INCOME")
        - natural("PROVIDER_FEE_EXPENSE")
        - natural("GATEWAY_FEE_EXPENSE")
        + natural("GATEWAY_FEE_ACCRUAL")
        + natural("AML_HOLD")
        + natural("CHARGEBACK_RESERVE")
        + natural("SUSPENSE");
    let drift = left_side - right_side;

    Ok(json!({
        "ok": drift.is_zero(),
        "drift": money4(drift),
        "checkedAt": iso_utc(Utc::now()),
        "leftSide": money4(left_side),
        "rightSide": money4(right_side),
        "sides": {
            "treasury": money4(natural("TREASURY")),
            "clearing": money4(natural("GATEWAY_CLEARING")),
            "commissionReceivable": money4(natural("COMMISSION_RECEIVABLE")),
            "merchantWallet": money4(natural("MERCHANT_WALLET")),
            "platformIncome": money4(natural("PLATFORM_INCOME")),
            "providerFeeExpense": money4(natural("PROVIDER_FEE_EXPENSE")),
            "gatewayFeeExpense": money4(natural("GATEWAY_FEE_EXPENSE")),
            "gatewayFeeAccrual": money4(natural("GATEWAY_FEE_ACCRUAL")),
            "amlHold": money4(natural("AML_HOLD")),
            "chargebackReserve": money4(natural("CHARGEBACK_RESERVE")),
            "suspense": money4(natural("SUSPENSE")),
        },
        "accounts": accounts,
    }))
}

async fn invariant_inner(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    invariant_snapshot(state).await
}

async fn invariant_export_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let snapshot = invariant_snapshot(state).await?;
    let query = query_map(request);
    let checklist = checklist(
        &query,
        &[
            "LEDGER_SCOPE_VERIFIED",
            "INVARIANT_RESULT_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit_row(
        state,
        principal,
        "INVARIANT_EXPORTED",
        "INVARIANT",
        "snapshot",
        json!({}),
        json!({
            "ok": snapshot["ok"],
            "drift": snapshot["drift"],
            "leftSide": snapshot["leftSide"],
            "rightSide": snapshot["rightSide"],
            "accounts": snapshot["accounts"].as_array().map_or(0, Vec::len),
            "checklist": checklist,
        }),
    )
    .await?;
    let mut response = snapshot;
    if let Value::Object(map) = &mut response {
        map.insert("exportedAt".to_owned(), json!(iso_utc(Utc::now())));
    }
    Ok(response)
}

async fn route_caps_snapshot(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let query = query_map(request);
    let pool = &state.pools.main;
    let timezone: Option<String> = sqlx::query_scalar(
        "SELECT gateway_timezone FROM gateway_settings ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .unwrap_or(None);
    let timezone = timezone
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Africa/Tripoli".to_owned());

    // `dayWindowInTimeZone`: the local business day, evaluated by PostgreSQL's tz database so the
    // window is identical to the checkout resolution (no new crate dependency).
    let window = sqlx::query(
        "SELECT ((date_trunc('day', now() AT TIME ZONE $1)) AT TIME ZONE $1) AS since,
                ((date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1) AS until",
    )
    .bind(&timezone)
    .fetch_one(pool)
    .await;
    let (since, until): (DateTime<Utc>, DateTime<Utc>) = match window {
        Ok(row) => (
            row.try_get("since").map_err(sqlx_error)?,
            row.try_get("until").map_err(sqlx_error)?,
        ),
        // `dayWindowInTimeZone` never fails: an invalid timezone falls back to UTC.
        Err(_) => (
            Utc::now()
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .unwrap_or_default()
                .and_utc(),
            {
                let now = Utc::now();
                (now.date_naive() + chrono::Duration::days(1))
                    .and_hms_opt(0, 0, 0)
                    .unwrap_or_default()
                    .and_utc()
            },
        ),
    };

    let processed_rows = sqlx::query(
        "SELECT route_id::text AS route_id, SUM(total_charged_amount)::text AS processed
         FROM payment_attempts
         WHERE status::text = 'SUCCEEDED' AND route_id IS NOT NULL
           AND COALESCE(terminal_at, created_at) >= $1
           AND COALESCE(terminal_at, created_at) < $2
         GROUP BY route_id",
    )
    .bind(since.naive_utc())
    .bind(until.naive_utc())
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut processed: HashMap<String, Decimal> = HashMap::with_capacity(processed_rows.len());
    for row in &processed_rows {
        processed.insert(
            row.try_get::<String, _>("route_id").map_err(sqlx_error)?,
            money_dec(&row.try_get::<String, _>("processed").map_err(sqlx_error)?),
        );
    }

    let routes = sqlx::query(
        "SELECT rr.id::text AS id, rr.gateway_id::text AS gateway_id,
                rr.daily_cap_amount::text AS daily_cap,
                r.code AS rail_code, r.currency::text AS currency
         FROM rail_routes rr INNER JOIN rails r ON r.id = rr.rail_id",
    )
    .fetch_all(pool)
    .await
    .map_err(sqlx_error)?;
    let mut rows = Vec::with_capacity(routes.len());
    let mut currencies = BTreeSet::new();
    for route in &routes {
        let route_id: String = route.try_get("id").map_err(sqlx_error)?;
        let currency: String = route.try_get("currency").map_err(sqlx_error)?;
        currencies.insert(currency.clone());
        let processed_amount = processed.get(&route_id).copied().unwrap_or_default();
        let cap = route
            .try_get::<Option<String>, _>("daily_cap")
            .map_err(sqlx_error)?
            .map(|value| money_dec(&value));
        let within_cap = cap.is_none_or(|cap| processed_amount <= cap);
        let remaining = cap.map(|cap| cap - processed_amount);
        let exhausted = remaining.is_some_and(|remaining| remaining <= Decimal::ZERO);
        let utilisation = cap.filter(|cap| *cap > Decimal::ZERO).map(|cap| {
            support::money2(
                processed_amount.checked_div(cap).unwrap_or_default() * Decimal::from(100),
            )
        });
        rows.push(json!({
            "routeId": route_id,
            "railCode": route.try_get::<String, _>("rail_code").map_err(sqlx_error)?,
            "currency": currency,
            "gatewayId": route.try_get::<String, _>("gateway_id").map_err(sqlx_error)?,
            "dailyCapAmount": cap.map(money4),
            "dailyProcessedAmount": money4(processed_amount),
            "dailyCapRemaining": remaining.map(money4),
            "capExhausted": exhausted,
            "exclusionReason": if within_cap { Value::Null } else { Value::String("DAILY_CAP_EXCEEDED".to_owned()) },
            "utilisation": utilisation,
        }));
    }

    let response_currency = match currencies.len() {
        0 => resolve_reporting_currency(scalar_raw(&query, "currency")),
        1 => currencies.iter().next().cloned().unwrap_or_default(),
        _ => "MIXED".to_owned(),
    };

    Ok(json!({
        "currency": response_currency,
        "timeZone": timezone,
        "businessDay": {
            "since": iso_utc(since),
            "until": iso_utc(until),
        },
        "routes": rows,
    }))
}

async fn route_caps_inner(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    route_caps_snapshot(state, request).await
}

super::support::custom_route!(profitability, profitability_inner);
super::support::custom_route!(profitability_export, profitability_export_inner);
super::support::custom_route!(liquidity, liquidity_inner);
super::support::custom_route!(liquidity_export, liquidity_export_inner);
super::support::custom_route!(invariant_check, invariant_inner);
super::support::custom_route!(invariant_export, invariant_export_inner);
super::support::custom_route!(route_caps, route_caps_inner);
