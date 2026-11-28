//! The global-search provider SQL.
//!
//! Port of the providers registered in `core-back/lib/globalSearch.ts` that this read slice
//! implements. Every query is parameterised; the term reaches PostgreSQL only as a bind value and
//! LIKE wildcards are composed in SQL (`'%' || $n || '%'`), never concatenated in Rust.
//!
//! Implemented providers (TS order): `merchant`, `payment_attempt`, `cashout`, `dispute`,
//! `adjustment`, `gateway`, `rail`, `route`, `user`.
//!
//! Not implemented yet (they belong to later slices or other agents):
//! `operator_case`, `gateway_inquiry`, `approval`, `join_request`, `kyb_document`,
//! `reconciliation_run`, `aml_case`, `aml_screening`, `aml_rule`, `aml_report`, `audit_log`
//! (the audit store port). Requests that reach one of them mark the response `partial`.
//!
//! The TS code has **no `application` provider** (`V1_SEARCH_TYPES` lists 21 types; the closest
//! commerce record is the merchant). This port does not invent one.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use pg_search::{MatchSignals, SearchCandidate, SearchHit, SearchType};
use rust_decimal::RoundingStrategy;
use sqlx::postgres::{PgRow, Postgres};
use sqlx::{PgPool, QueryBuilder, Row};
use uuid::Uuid;

use super::Actor;

/// The providers this slice runs.
pub const IMPLEMENTED: &[SearchType] = &[
    SearchType::Merchant,
    SearchType::PaymentAttempt,
    SearchType::Cashout,
    SearchType::Dispute,
    SearchType::Adjustment,
    SearchType::Gateway,
    SearchType::Rail,
    SearchType::Route,
    SearchType::User,
];

/// True when [`run`] understands this provider.
#[must_use]
pub fn implemented(provider: SearchType) -> bool {
    IMPLEMENTED.contains(&provider)
}

/// `canAccess` of every registered provider (the SQL of later ones is not ported yet).
#[must_use]
pub fn can_access(provider: SearchType, actor: Actor<'_>) -> bool {
    let confidential_aml = || {
        matches!(
            actor.role.to_ascii_uppercase().as_str(),
            "COMPLIANCE" | "MLRO"
        ) || actor.has_any(&["aml:read", "aml:write"])
    };
    match provider {
        SearchType::Merchant => actor.has("merchant:read"),
        SearchType::PaymentAttempt => actor.has("attempt:read") && actor.has("merchant:read"),
        SearchType::OperatorCase | SearchType::GatewayInquiry => {
            actor.has_any(&["case:read", "operator:read"])
        }
        SearchType::Approval => actor.has("approval:read"),
        SearchType::JoinRequest | SearchType::KybDocument => {
            actor.has_any(&["kyb:read", "compliance:read"])
        }
        SearchType::Dispute => actor.has("dispute:read"),
        SearchType::Adjustment => actor.has("finance:read"),
        SearchType::Cashout => actor.has("cashout:read"),
        SearchType::ReconciliationRun => actor.has("reconciliation:read"),
        SearchType::AmlCase
        | SearchType::AmlScreening
        | SearchType::AmlRule
        | SearchType::AmlReport => confidential_aml(),
        SearchType::Gateway => actor.has("gateway:read"),
        SearchType::CredentialSet => actor.has_any(&[
            "credential:read",
            "credential:write",
            "gateway:read",
            "gateway:write",
        ]),
        SearchType::Rail | SearchType::Route => actor.has("gateway:read"),
        SearchType::User => actor.has_any(&["user:read", "security:read"]),
        SearchType::AuditLog => actor.has("security:read"),
    }
}

/// The status values each provider accepts in `status:` (`scopedStatusIn`).
#[must_use]
pub fn scoped_status(provider: SearchType, status: Option<&str>) -> Option<String> {
    let value = status?;
    let allowed: &[&str] = match provider {
        SearchType::Merchant => &["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "CLOSED"],
        SearchType::PaymentAttempt => &[
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
        ],
        SearchType::Cashout => &[
            "PENDING",
            "REJECTED",
            "PROCESSING",
            "COMPLETE",
            "SUBTRACTED",
        ],
        SearchType::Dispute => &[
            "OPENED",
            "EVIDENCE_REQUESTED",
            "EVIDENCE_SUBMITTED",
            "WON",
            "LOST",
            "EXPIRED",
            "WITHDRAWN",
        ],
        SearchType::Adjustment => &[
            "DRAFT",
            "PENDING_REVIEW",
            "APPROVED",
            "EXECUTING",
            "EXECUTED",
            "REJECTED",
        ],
        SearchType::Gateway => &[
            "DRAFT",
            "SANDBOX_VERIFIED",
            "PENDING_APPROVAL",
            "LIVE",
            "SUSPENDED",
            "RETIRED",
        ],
        SearchType::Route => &["ACTIVE", "PAUSED", "DRAINING"],
        SearchType::User => &["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"],
        _ => &[],
    };
    allowed.contains(&value).then(|| value.to_owned())
}

fn or_like(builder: &mut QueryBuilder<Postgres>, first: &mut bool, column: &str, value: &str) {
    if *first {
        *first = false;
    } else {
        builder.push(" OR ");
    }
    builder
        .push(column)
        .push(" ILIKE '%' || ")
        .push_bind(value.to_owned())
        .push(" || '%'");
}

fn or_like_phone(
    builder: &mut QueryBuilder<Postgres>,
    first: &mut bool,
    column: &str,
    variants: &[String],
) {
    for variant in variants {
        if *first {
            *first = false;
        } else {
            builder.push(" OR ");
        }
        builder
            .push(column)
            .push(" ILIKE '%' || ")
            .push_bind(variant.clone())
            .push(" || '%'");
    }
}

fn or_id(
    builder: &mut QueryBuilder<Postgres>,
    first: &mut bool,
    column: &str,
    value: Option<Uuid>,
) {
    if let Some(id) = value {
        if *first {
            *first = false;
        } else {
            builder.push(" OR ");
        }
        builder.push(column).push(" = ").push_bind(id);
    }
}

fn parse_uuid(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value.trim()).ok()
}

fn opt(row: &PgRow, column: &str) -> Result<Option<String>, sqlx::Error> {
    row.try_get(column)
}

fn millis(naive: chrono::NaiveDateTime) -> i64 {
    DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).timestamp_millis()
}

fn compact(values: &[Option<&str>]) -> Option<String> {
    let parts: Vec<&str> = values
        .iter()
        .flatten()
        .copied()
        .filter(|value| !value.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

/// `amountText` without floats: two decimals, half away from zero.
fn amount_text(value: Option<rust_decimal::Decimal>) -> String {
    let mut amount = value
        .unwrap_or_default()
        .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
    amount.rescale(2);
    amount.to_string()
}

/// Run one provider (`fetchCandidates` + `extractMatchSignals` + `toResultItem`).
pub async fn run(
    pool: &PgPool,
    provider: SearchType,
    parsed: &pg_search::ParsedSearchQuery,
    actor: Actor<'_>,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    match provider {
        SearchType::Merchant => merchants(pool, parsed, actor, take).await,
        SearchType::PaymentAttempt => payment_attempts(pool, parsed, take).await,
        SearchType::Cashout => cashouts(pool, parsed, take).await,
        SearchType::Dispute => disputes(pool, parsed, take).await,
        SearchType::Adjustment => adjustments(pool, parsed, take).await,
        SearchType::Gateway => gateways(pool, parsed, take).await,
        SearchType::Rail => rails(pool, parsed, take).await,
        SearchType::Route => routes(pool, parsed, take).await,
        SearchType::User => users(pool, parsed, take).await,
        _ => Ok(Vec::new()),
    }
}

async fn merchants(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    actor: Actor<'_>,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    // `hasMerchantSensitiveAccess`: SUPPORT never sees tax id / registration number.
    let sensitive = actor.role != "SUPPORT"
        && actor.has_any(&["merchant:write", "compliance:read", "compliance:write"]);
    let mut builder = QueryBuilder::new(
        "SELECT m.id, m.legal_name, m.trade_name, m.display_name, m.contact_email, \
                m.contact_phone, m.status::text AS status, m.risk_tier::text AS risk_tier, \
                m.updated_at",
    );
    if sensitive {
        builder.push(", m.tax_id, m.registration_no");
    }
    builder.push(" FROM merchants m WHERE true");
    if let Some(status) = scoped_status(SearchType::Merchant, parsed.scoped_status.as_deref()) {
        builder.push(" AND m.status::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "m.id", parse_uuid(&parsed.term));
    or_like(&mut builder, &mut first, "m.legal_name", &parsed.term);
    or_like(&mut builder, &mut first, "m.trade_name", &parsed.term);
    or_like(&mut builder, &mut first, "m.display_name", &parsed.term);
    or_like(&mut builder, &mut first, "m.contact_email", &parsed.term);
    or_like(&mut builder, &mut first, "m.contact_phone", &parsed.term);
    or_like_phone(
        &mut builder,
        &mut first,
        "m.contact_phone",
        &parsed.phone_variants,
    );
    if sensitive {
        or_like(&mut builder, &mut first, "m.tax_id", &parsed.term);
        or_like(&mut builder, &mut first, "m.registration_no", &parsed.term);
    }
    builder
        .push(") ORDER BY m.updated_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let legal: Option<String> = opt(row, "legal_name")?;
            let trade: Option<String> = opt(row, "trade_name")?;
            let display: Option<String> = opt(row, "display_name")?;
            let email: Option<String> = opt(row, "contact_email")?;
            let phone: Option<String> = opt(row, "contact_phone")?;
            let status: String = row.try_get("status")?;
            let risk: Option<String> = opt(row, "risk_tier")?;
            let tax: Option<String> = if sensitive { opt(row, "tax_id")? } else { None };
            let registration: Option<String> = if sensitive {
                opt(row, "registration_no")?
            } else {
                None
            };
            let updated = millis(row.try_get("updated_at")?);
            let title = display
                .clone()
                .or(trade.clone())
                .or(legal.clone())
                .unwrap_or_else(|| id.to_string());
            let subtitle = compact(&[legal.as_deref(), email.as_deref(), risk.as_deref()]);
            let mut signals = MatchSignals::new().exact(id.to_string()).at(updated);
            for value in [
                email.as_deref(),
                phone.as_deref(),
                tax.as_deref(),
                registration.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                signals = signals.exact(value);
            }
            for value in [display.as_deref(), trade.as_deref(), legal.as_deref()]
                .into_iter()
                .flatten()
            {
                signals = signals.primary(value);
            }
            for value in [risk.as_deref()].into_iter().flatten() {
                signals = signals.secondary(value);
            }
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(id.to_string())
                .with_status(status)
                .with_merchant(id.to_string());
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(SearchType::Merchant, hit, signals))
        })
        .collect()
}

async fn payment_attempts(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT a.id, a.reference, a.provider_reference, a.network_reference, \
                a.gateway_reference, a.requested_amount, a.total_charged_amount, a.currency, \
                a.status::text AS status, a.merchant_id, a.created_at, \
                m.trade_name AS merchant_trade, m.legal_name AS merchant_legal, \
                r.code AS rail_code \
           FROM payment_attempts a \
           LEFT JOIN merchants m ON m.id = a.merchant_id \
           LEFT JOIN rails r ON r.id = a.rail_id \
          WHERE true",
    );
    if let Some(merchant) = parsed.scoped_merchant_id.as_deref().and_then(parse_uuid) {
        builder.push(" AND a.merchant_id = ").push_bind(merchant);
    }
    if let Some(status) = scoped_status(SearchType::PaymentAttempt, parsed.scoped_status.as_deref())
    {
        builder.push(" AND a.status::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "a.id", parse_uuid(&parsed.term));
    for column in [
        "a.reference",
        "a.provider_reference",
        "a.network_reference",
        "a.gateway_reference",
        "a.idempotency_key",
    ] {
        or_like(&mut builder, &mut first, column, &parsed.term);
    }
    or_like(&mut builder, &mut first, "m.trade_name", &parsed.term);
    or_like(&mut builder, &mut first, "m.legal_name", &parsed.term);
    builder
        .push(") ORDER BY a.created_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let reference: String = row.try_get("reference")?;
            let merchant_id: Uuid = row.try_get("merchant_id")?;
            let total: Option<rust_decimal::Decimal> = row.try_get("total_charged_amount")?;
            let requested: Option<rust_decimal::Decimal> = row.try_get("requested_amount")?;
            let currency: String = row.try_get("currency")?;
            let status: String = row.try_get("status")?;
            let created = millis(row.try_get("created_at")?);
            let provider: Option<String> = opt(row, "provider_reference")?;
            let merchant_trade: Option<String> = opt(row, "merchant_trade")?;
            let merchant_legal: Option<String> = opt(row, "merchant_legal")?;
            let rail: Option<String> = opt(row, "rail_code")?;
            let title = format!(
                "{reference} · {} {currency}",
                amount_text(total.or(requested))
            );
            let merchant_label = merchant_trade
                .as_deref()
                .or(merchant_legal.as_deref())
                .map(str::to_owned)
                .unwrap_or_else(|| merchant_id.to_string());
            let rail_upper = rail.as_deref().map(str::to_uppercase);
            let provider_label = provider.as_deref().map(|value| format!("Prov: {value}"));
            let subtitle = compact(&[
                Some(merchant_label.as_str()),
                rail_upper.as_deref(),
                provider_label.as_deref(),
            ]);
            let mut signals = MatchSignals::new().exact(id.to_string()).at(created);
            for column in [
                "reference",
                "provider_reference",
                "network_reference",
                "gateway_reference",
            ] {
                for value in [opt(row, column)?].into_iter().flatten() {
                    signals = signals.exact(value);
                }
            }
            for value in [merchant_trade.as_deref(), merchant_legal.as_deref()]
                .into_iter()
                .flatten()
            {
                signals = signals.primary(value);
            }
            for value in [rail.as_deref()].into_iter().flatten() {
                signals = signals.secondary(value);
            }
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(reference)
                .with_status(status)
                .with_merchant(merchant_id.to_string());
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(
                SearchType::PaymentAttempt,
                hit,
                signals,
            ))
        })
        .collect()
}

async fn cashouts(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT c.id, c.wallet_id, c.amount, c.state::text AS state, c.merchant_id, c.created_at, \
                w.currency AS wallet_currency, m.trade_name AS merchant_trade, \
                m.legal_name AS merchant_legal \
           FROM cashout_requests c \
           LEFT JOIN wallets w ON w.id = c.wallet_id \
           LEFT JOIN merchants m ON m.id = c.merchant_id \
          WHERE true",
    );
    if let Some(status) = scoped_status(SearchType::Cashout, parsed.scoped_status.as_deref()) {
        builder.push(" AND c.state::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "c.id", parse_uuid(&parsed.term));
    or_id(
        &mut builder,
        &mut first,
        "c.wallet_id",
        parse_uuid(&parsed.term),
    );
    or_like(&mut builder, &mut first, "m.trade_name", &parsed.term);
    or_like(&mut builder, &mut first, "m.legal_name", &parsed.term);
    builder
        .push(") ORDER BY c.created_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let wallet_id: Uuid = row.try_get("wallet_id")?;
            let amount: Option<rust_decimal::Decimal> = row.try_get("amount")?;
            let state: String = row.try_get("state")?;
            let merchant_id: Uuid = row.try_get("merchant_id")?;
            let created = millis(row.try_get("created_at")?);
            let currency = opt(row, "wallet_currency")?.unwrap_or_else(|| "LYD".to_owned());
            let trade = opt(row, "merchant_trade")?;
            let legal = opt(row, "merchant_legal")?;
            let title = format!("Cash-out {} {currency}", amount_text(amount));
            let wallet_label = format!("Wallet: {wallet_id}");
            let subtitle = compact(&[
                trade.as_deref().or(legal.as_deref()),
                Some(wallet_label.as_str()),
            ]);
            let mut signals = MatchSignals::new()
                .exact(id.to_string())
                .exact(wallet_id.to_string())
                .secondary(state.clone())
                .at(created);
            for value in [trade.as_deref(), legal.as_deref()].into_iter().flatten() {
                signals = signals.primary(value);
            }
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(id.to_string())
                .with_status(state)
                .with_merchant(merchant_id.to_string());
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(SearchType::Cashout, hit, signals))
        })
        .collect()
}

async fn disputes(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT d.id, d.external_dispute_ref, d.reason_code, d.amount, d.currency, \
                d.status::text AS status, d.created_at, a.reference AS attempt_reference, \
                a.merchant_id, m.trade_name AS merchant_trade, m.legal_name AS merchant_legal \
           FROM disputes d \
           LEFT JOIN payment_attempts a ON a.id = d.attempt_id \
           LEFT JOIN merchants m ON m.id = a.merchant_id \
          WHERE true",
    );
    if let Some(status) = scoped_status(SearchType::Dispute, parsed.scoped_status.as_deref()) {
        builder.push(" AND d.status::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "d.id", parse_uuid(&parsed.term));
    or_like(
        &mut builder,
        &mut first,
        "d.external_dispute_ref",
        &parsed.term,
    );
    or_like(&mut builder, &mut first, "d.reason_code", &parsed.term);
    or_like(&mut builder, &mut first, "a.reference", &parsed.term);
    or_like(&mut builder, &mut first, "m.trade_name", &parsed.term);
    or_like(&mut builder, &mut first, "m.legal_name", &parsed.term);
    builder
        .push(") ORDER BY d.created_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let external: Option<String> = opt(row, "external_dispute_ref")?;
            let reason: Option<String> = opt(row, "reason_code")?;
            let amount: Option<rust_decimal::Decimal> = row.try_get("amount")?;
            let currency: String = row.try_get("currency")?;
            let status: String = row.try_get("status")?;
            let created = millis(row.try_get("created_at")?);
            let attempt_reference: Option<String> = opt(row, "attempt_reference")?;
            let merchant_id: Option<Uuid> = row.try_get("merchant_id")?;
            let trade = opt(row, "merchant_trade")?;
            let legal = opt(row, "merchant_legal")?;
            let title = format!(
                "Dispute {}{}",
                external.clone().unwrap_or_else(|| id.to_string()),
                reason
                    .as_deref()
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default()
            );
            let amount_label = format!("{} {currency}", amount_text(amount));
            let attempt_label = attempt_reference
                .as_deref()
                .map(|value| format!("Attempt: {value}"));
            let subtitle = compact(&[
                trade.as_deref().or(legal.as_deref()),
                attempt_label.as_deref(),
                Some(amount_label.as_str()),
            ]);
            let mut signals = MatchSignals::new().exact(id.to_string()).at(created);
            for value in [
                external.as_deref(),
                reason.as_deref(),
                attempt_reference.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                signals = signals.exact(value);
            }
            for value in [trade.as_deref(), legal.as_deref()].into_iter().flatten() {
                signals = signals.primary(value);
            }
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(
                    external
                        .clone()
                        .or(attempt_reference)
                        .unwrap_or_else(|| id.to_string()),
                )
                .with_status(status);
            if let Some(merchant_id) = merchant_id {
                hit = hit.with_merchant(merchant_id.to_string());
            }
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(SearchType::Dispute, hit, signals))
        })
        .collect()
}

async fn adjustments(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT j.id, j.type, j.amount, j.reason, j.external_dispute_ref, j.provider_refund_ref, \
                j.state::text AS state, j.created_at, a.reference AS attempt_reference, \
                a.merchant_id, a.currency AS attempt_currency \
           FROM adjustments j \
           LEFT JOIN payment_attempts a ON a.id = j.source_attempt_id \
          WHERE true",
    );
    if let Some(status) = scoped_status(SearchType::Adjustment, parsed.scoped_status.as_deref()) {
        builder.push(" AND j.state::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "j.id", parse_uuid(&parsed.term));
    or_like(&mut builder, &mut first, "j.reason", &parsed.term);
    or_like(
        &mut builder,
        &mut first,
        "j.external_dispute_ref",
        &parsed.term,
    );
    or_like(
        &mut builder,
        &mut first,
        "j.provider_refund_ref",
        &parsed.term,
    );
    or_like(&mut builder, &mut first, "a.reference", &parsed.term);
    builder
        .push(") ORDER BY j.created_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let kind: String = row.try_get("type")?;
            let amount: Option<rust_decimal::Decimal> = row.try_get("amount")?;
            let reason: Option<String> = opt(row, "reason")?;
            let external: Option<String> = opt(row, "external_dispute_ref")?;
            let provider_refund: Option<String> = opt(row, "provider_refund_ref")?;
            let state: String = row.try_get("state")?;
            let created = millis(row.try_get("created_at")?);
            let attempt_reference: Option<String> = opt(row, "attempt_reference")?;
            let merchant_id: Option<Uuid> = row.try_get("merchant_id")?;
            let currency = opt(row, "attempt_currency")?.unwrap_or_else(|| "LYD".to_owned());
            let title = format!("{kind} · {} {currency}", amount_text(amount));
            let attempt_label = attempt_reference
                .as_deref()
                .map(|value| format!("Attempt: {value}"));
            let subtitle = compact(&[reason.as_deref(), attempt_label.as_deref()]);
            let mut signals = MatchSignals::new().exact(id.to_string()).at(created);
            for value in [
                provider_refund.as_deref(),
                external.as_deref(),
                attempt_reference.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                signals = signals.exact(value);
            }
            for value in [Some(kind.as_str()), reason.as_deref()]
                .into_iter()
                .flatten()
            {
                signals = signals.primary(value);
            }
            signals = signals.secondary(state.clone());
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(
                    provider_refund
                        .clone()
                        .or(external)
                        .or(attempt_reference)
                        .unwrap_or_else(|| id.to_string()),
                )
                .with_status(state);
            if let Some(merchant_id) = merchant_id {
                hit = hit.with_merchant(merchant_id.to_string());
            }
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(SearchType::Adjustment, hit, signals))
        })
        .collect()
}

async fn gateways(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT g.id, g.code, g.name, g.operator, g.status::text AS status, g.updated_at \
           FROM gateways g WHERE true",
    );
    if let Some(status) = scoped_status(SearchType::Gateway, parsed.scoped_status.as_deref()) {
        builder.push(" AND g.status::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "g.id", parse_uuid(&parsed.term));
    or_like(&mut builder, &mut first, "g.code", &parsed.term);
    or_like(&mut builder, &mut first, "g.name", &parsed.term);
    or_like(&mut builder, &mut first, "g.operator", &parsed.term);
    builder
        .push(") ORDER BY g.updated_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let code: String = row.try_get("code")?;
            let name: String = row.try_get("name")?;
            let operator: Option<String> = opt(row, "operator")?;
            let status: String = row.try_get("status")?;
            let updated = millis(row.try_get("updated_at")?);
            let mut signals = MatchSignals::new()
                .exact(id.to_string())
                .exact(code.clone())
                .primary(name.clone())
                .at(updated);
            for value in [operator.as_deref()].into_iter().flatten() {
                signals = signals.primary(value);
            }
            let mut hit = SearchHit::new(id.to_string(), format!("{name} ({code})"))
                .with_reference(code)
                .with_status(status);
            if let Some(operator) = operator {
                hit = hit.with_subtitle(operator);
            }
            Ok(SearchCandidate::new(SearchType::Gateway, hit, signals))
        })
        .collect()
}

async fn rails(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let blocked = match parsed.scoped_status.as_deref() {
        Some("BLOCKED") => Some(true),
        Some("ACTIVE") => Some(false),
        _ => None,
    };
    let mut builder = QueryBuilder::new(
        "SELECT r.id, r.code, r.name_en, r.name_ar, r.collection_mode::text AS collection_mode, \
                r.currency, r.blocked, r.updated_at \
           FROM rails r WHERE true",
    );
    if let Some(blocked) = blocked {
        builder.push(" AND r.blocked = ").push_bind(blocked);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "r.id", parse_uuid(&parsed.term));
    or_like(&mut builder, &mut first, "r.code", &parsed.term);
    or_like(&mut builder, &mut first, "r.name_en", &parsed.term);
    or_like(&mut builder, &mut first, "r.name_ar", &parsed.term);
    builder
        .push(") ORDER BY r.updated_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let code: String = row.try_get("code")?;
            let name_en: String = row.try_get("name_en")?;
            let name_ar: Option<String> = opt(row, "name_ar")?;
            let collection: Option<String> = opt(row, "collection_mode")?;
            let currency: Option<String> = opt(row, "currency")?;
            let blocked: bool = row.try_get("blocked")?;
            let updated = millis(row.try_get("updated_at")?);
            let title = match name_ar.as_deref() {
                Some(name_ar) if !name_ar.is_empty() => format!("{name_en} ({name_ar})"),
                _ => name_en.clone(),
            };
            let subtitle = compact(&[collection.as_deref(), currency.as_deref()]);
            let mut signals = MatchSignals::new()
                .exact(id.to_string())
                .exact(code.clone())
                .primary(name_en)
                .at(updated);
            for value in [name_ar.as_deref()].into_iter().flatten() {
                signals = signals.primary(value);
            }
            for value in [collection.as_deref(), currency.as_deref()]
                .into_iter()
                .flatten()
            {
                signals = signals.secondary(value);
            }
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(code)
                .with_status(if blocked { "BLOCKED" } else { "ACTIVE" });
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(SearchType::Rail, hit, signals))
        })
        .collect()
}

async fn routes(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT rt.id, rt.priority, rt.status::text AS status, rt.health_state::text AS health_state, \
                rt.updated_at, r.code AS rail_code, r.name_en AS rail_name_en, \
                r.name_ar AS rail_name_ar, g.code AS gateway_code, g.name AS gateway_name, \
                g.operator AS gateway_operator \
           FROM rail_routes rt \
           LEFT JOIN rails r ON r.id = rt.rail_id \
           LEFT JOIN gateways g ON g.id = rt.gateway_id \
          WHERE true",
    );
    if let Some(status) = scoped_status(SearchType::Route, parsed.scoped_status.as_deref()) {
        builder.push(" AND rt.status::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "rt.id", parse_uuid(&parsed.term));
    for column in [
        "r.code",
        "r.name_en",
        "r.name_ar",
        "g.code",
        "g.name",
        "g.operator",
    ] {
        or_like(&mut builder, &mut first, column, &parsed.term);
    }
    builder
        .push(") ORDER BY rt.updated_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let priority: i32 = row.try_get("priority")?;
            let status: String = row.try_get("status")?;
            let health: String = row.try_get("health_state")?;
            let updated = millis(row.try_get("updated_at")?);
            let rail_code: Option<String> = opt(row, "rail_code")?;
            let rail_name_en: Option<String> = opt(row, "rail_name_en")?;
            let rail_name_ar: Option<String> = opt(row, "rail_name_ar")?;
            let gateway_code: Option<String> = opt(row, "gateway_code")?;
            let gateway_name: Option<String> = opt(row, "gateway_name")?;
            let gateway_operator: Option<String> = opt(row, "gateway_operator")?;
            let title = format!(
                "{} → {}",
                rail_code.clone().unwrap_or_default(),
                gateway_code.clone().unwrap_or_default()
            );
            let subtitle = format!("Priority {priority} · Health: {health}");
            let mut signals = MatchSignals::new().exact(id.to_string()).at(updated);
            for value in [rail_code.as_deref(), gateway_code.as_deref()]
                .into_iter()
                .flatten()
            {
                signals = signals.exact(value);
            }
            for value in [
                rail_name_en.as_deref(),
                rail_name_ar.as_deref(),
                gateway_name.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                signals = signals.primary(value);
            }
            let priority_label = priority.to_string();
            for value in [
                gateway_operator.as_deref(),
                Some(priority_label.as_str()),
                Some(health.as_str()),
                Some(status.as_str()),
            ]
            .into_iter()
            .flatten()
            {
                signals = signals.secondary(value);
            }
            Ok(SearchCandidate::new(
                SearchType::Route,
                SearchHit::new(id.to_string(), title)
                    .with_subtitle(subtitle)
                    .with_reference(id.to_string())
                    .with_status(status),
                signals,
            ))
        })
        .collect()
}

async fn users(
    pool: &PgPool,
    parsed: &pg_search::ParsedSearchQuery,
    take: i64,
) -> Result<Vec<SearchCandidate>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT u.id, u.email, u.phone, u.role::text AS role, u.status::text AS status, \
                u.created_at \
           FROM users u WHERE true",
    );
    if let Some(merchant) = parsed.scoped_merchant_id.as_deref().and_then(parse_uuid) {
        builder.push(" AND u.merchant_id = ").push_bind(merchant);
    }
    if let Some(status) = scoped_status(SearchType::User, parsed.scoped_status.as_deref()) {
        builder.push(" AND u.status::text = ").push_bind(status);
    }
    builder.push(" AND (");
    let mut first = true;
    or_id(&mut builder, &mut first, "u.id", parse_uuid(&parsed.term));
    or_like(&mut builder, &mut first, "u.email", &parsed.term);
    or_like(&mut builder, &mut first, "u.phone", &parsed.term);
    or_like_phone(&mut builder, &mut first, "u.phone", &parsed.phone_variants);
    builder
        .push(") ORDER BY u.created_at DESC LIMIT ")
        .push_bind(take);
    let rows = builder.build().fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let email: String = row.try_get("email")?;
            let phone: Option<String> = opt(row, "phone")?;
            let role: String = row.try_get("role")?;
            let status: String = row.try_get("status")?;
            let created = millis(row.try_get("created_at")?);
            let title = if !email.is_empty() {
                email.clone()
            } else {
                phone.clone().unwrap_or_else(|| id.to_string())
            };
            let subtitle = compact(&[
                Some(role.as_str()),
                if email.is_empty() {
                    None
                } else {
                    phone.as_deref()
                },
            ]);
            let mut signals = MatchSignals::new()
                .exact(id.to_string())
                .exact(email)
                .secondary(role)
                .at(created);
            for value in [phone.as_deref()].into_iter().flatten() {
                signals = signals.exact(value);
            }
            let mut hit = SearchHit::new(id.to_string(), title)
                .with_reference(id.to_string())
                .with_status(status);
            if let Some(subtitle) = subtitle {
                hit = hit.with_subtitle(subtitle);
            }
            Ok(SearchCandidate::new(SearchType::User, hit, signals))
        })
        .collect()
}
