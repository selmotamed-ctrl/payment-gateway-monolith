//! Merchant Sandbox reads: overview, Studio lists/details, wallet ledger and payment detail.
//!
//! Port of the nineteen merchant-scoped `GET /internal/sandbox/merchant/**` handlers of
//! `core-back/api/internal/sandboxControl.ts`. Every handler resolves the merchant with
//! `resolveMerchantId` (the authenticated merchant, or a staff principal naming one with the
//! `x-sandbox-merchant-id` header / `?merchantId=`) and every lookup is scoped by that merchant, so
//! another merchant's id reads the route's 404, never its row.
//!
//! ## Money
//!
//! Balances are the per-shard projections (`gl_account_shards` / `gl_shard_checkpoints`) converted to
//! the natural sign of the GL account type; every amount goes through [`rust_decimal::Decimal`] and
//! is rendered with the shared `Money4` helper or the Prisma `Decimal#toString` shape, never a float.
//!
//! ## List contract
//!
//! The Studio lists use [`pg_db::list_query`] with the same spec as the TS `buildListQuery` calls:
//! `search`, `in`, `equals`, date-range and decimal-range filters, the client `sortKey`/
//! `sortDirection` (unknown keys fall back to the default), `page`/`pageSize` (1..200), offset
//! pagination and the keyset `cursor`/`nextCursor` envelope.
//!
//! ## Deviations
//!
//! - **DEV-SANDBOX-04:** malformed path ids answer the route's 404 (see the module-level list in
//!   [`super`]); `:applicationId` and `:linkId` are merchant-scoped `findFirst` reads and answer
//!   `404 SANDBOX_APPLICATION_NOT_FOUND` / `SANDBOX_LINK_NOT_FOUND`.
//! - **DEV-SANDBOX-08 (token IP order):** `allowedCidrs` is ordered by `(created_at, cidr)`; Prisma's
//!   nested `ips` read has no `orderBy`, so its order was never defined.
//! - **DEV-SANDBOX-09 (payment includes):** step logs and journal lines use a deterministic tie
//!   order (`created_at, id`) where the TS include only names one column.
//! - **DEV-SANDBOX-10 (`statusCounts` order):** the TS `reduce` over an unordered `findMany` has no
//!   defined key order; the port uses a `BTreeMap` (alphabetical) so the response is stable.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashMap};

use chrono::{Duration, NaiveDateTime, Utc};
use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_db::list_query::{
    count_unless_skipped, encode_cursor, ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter,
    RangeKind, SortDirection,
};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::merchant::{
    cursor_rows, f, iso_timestamp, iso_timestamptz, query_map, CursorColumn, FieldKind, Fields,
};
use crate::routes::sandbox::control::ControlClient;
use crate::routes::sandbox::fields::{
    ADJUSTMENT_COLUMNS, ADJUSTMENT_FIELDS, APPLICATION_COLUMNS, APPLICATION_FIELDS,
    ATTEMPT_COLUMNS, ATTEMPT_FIELDS, AUDIT_COLUMNS, AUDIT_FIELDS, CASHOUT_COLUMNS, CASHOUT_FIELDS,
    DISPUTE_COLUMNS, DISPUTE_FIELDS, JOURNAL_ENTRY_COLUMNS, JOURNAL_ENTRY_FIELDS,
    JOURNAL_LINE_COLUMNS, JOURNAL_LINE_FIELDS, JOURNAL_REF_TYPES, LINK_COLUMNS, LINK_FIELDS,
    STEP_LOG_COLUMNS, STEP_LOG_FIELDS,
};
use crate::routes::sandbox::support::{
    assert_control_access, bind_text, bind_uuid, build_list, count_map, decimal,
    ensure_merchant_envelope, ensure_plane, header_value, list_envelope, money, ordered_row,
    ordered_rows, parse_decimal, principal, push_condition, query_scalar, query_trimmed,
    resolve_merchant_id, resolve_reporting_currency, wallet_amounts, MerchantEnvelope,
    WalletAmount, WalletRef,
};
use crate::routes::sandbox::{route, support};
use crate::routes::{HandlerFuture, MountedRoute};
use crate::state::AppState;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/sandbox/merchant/overview",
            "core-back/api/internal/sandboxControl.ts:232",
            overview,
        ),
        route(
            "/internal/sandbox/merchant/wallets/:walletId",
            "core-back/api/internal/sandboxControl.ts:733",
            wallet_detail,
        ),
        route(
            "/internal/sandbox/merchant/wallets/:walletId/ledger",
            "core-back/api/internal/sandboxControl.ts:765",
            wallet_ledger,
        ),
        route(
            "/internal/sandbox/merchant/payments/:attemptId",
            "core-back/api/internal/sandboxControl.ts:831",
            payment_detail,
        ),
        route(
            "/internal/sandbox/merchant/studio/overview",
            "core-back/api/internal/sandboxControl.ts:1571",
            studio_overview,
        ),
        route(
            "/internal/sandbox/merchant/studio/wallets/summary",
            "core-back/api/internal/sandboxControl.ts:1698",
            studio_wallets_summary,
        ),
        route(
            "/internal/sandbox/merchant/studio/wallets",
            "core-back/api/internal/sandboxControl.ts:1720",
            studio_wallets,
        ),
        route(
            "/internal/sandbox/merchant/studio/wallets/:walletId",
            "core-back/api/internal/sandboxControl.ts:1738",
            studio_wallet_detail,
        ),
        route(
            "/internal/sandbox/merchant/studio/applications/summary",
            "core-back/api/internal/sandboxControl.ts:1779",
            studio_applications_summary,
        ),
        route(
            "/internal/sandbox/merchant/studio/applications",
            "core-back/api/internal/sandboxControl.ts:1789",
            studio_applications,
        ),
        route(
            "/internal/sandbox/merchant/studio/applications/:applicationId",
            "core-back/api/internal/sandboxControl.ts:1814",
            studio_application_detail,
        ),
        route(
            "/internal/sandbox/merchant/studio/links/summary",
            "core-back/api/internal/sandboxControl.ts:1825",
            studio_links_summary,
        ),
        route(
            "/internal/sandbox/merchant/studio/links",
            "core-back/api/internal/sandboxControl.ts:1835",
            studio_links,
        ),
        route(
            "/internal/sandbox/merchant/studio/links/:linkId",
            "core-back/api/internal/sandboxControl.ts:1857",
            studio_link_detail,
        ),
        route(
            "/internal/sandbox/merchant/studio/payments/summary",
            "core-back/api/internal/sandboxControl.ts:1865",
            studio_payments_summary,
        ),
        route(
            "/internal/sandbox/merchant/studio/payments",
            "core-back/api/internal/sandboxControl.ts:1880",
            studio_payments,
        ),
        route(
            "/internal/sandbox/merchant/studio/tokens/summary",
            "core-back/api/internal/sandboxControl.ts:1916",
            studio_tokens_summary,
        ),
        route(
            "/internal/sandbox/merchant/studio/tokens",
            "core-back/api/internal/sandboxControl.ts:1927",
            studio_tokens,
        ),
        route(
            "/internal/sandbox/merchant/studio/tokens/:tokenId",
            "core-back/api/internal/sandboxControl.ts:1952",
            studio_token_detail,
        ),
    ]
}

// ---------------------------------------------------------------------------------------------
// Shared merchant-scoped helpers
// ---------------------------------------------------------------------------------------------

/// The `:segment` at `index` of the request path (0 is the empty string before the leading `/`).
fn path_segment(request: &HttpRequest, index: usize) -> String {
    request
        .path()
        .split('/')
        .nth(index)
        .unwrap_or_default()
        .to_owned()
}

fn wallet_not_found() -> ApiError {
    ApiError::new(
        404,
        "SANDBOX_WALLET_NOT_FOUND",
        "The sandbox wallet does not exist",
    )
}

fn attempt_not_found() -> ApiError {
    ApiError::new(
        404,
        "PAYMENT_ATTEMPT_NOT_FOUND",
        "The sandbox payment does not exist",
    )
}

fn application_not_found() -> ApiError {
    ApiError::new(
        404,
        "SANDBOX_APPLICATION_NOT_FOUND",
        "The sandbox application does not exist",
    )
}

fn link_not_found() -> ApiError {
    ApiError::new(
        404,
        "SANDBOX_LINK_NOT_FOUND",
        "The sandbox link does not exist",
    )
}

fn token_not_found() -> ApiError {
    ApiError::new(
        404,
        "SANDBOX_TOKEN_NOT_FOUND",
        "The sandbox token does not exist",
    )
}

/// The setup every handler repeats: plane gate, principal, access check, merchant.
fn context(
    state: &AppState,
    request: &HttpRequest,
    principal_ref: Option<&Principal>,
) -> Result<(Uuid, Principal), ApiError> {
    ensure_plane(state)?;
    let principal = principal(principal_ref)?.clone();
    assert_control_access(&principal, request.method().as_str())?;
    let merchant_id = resolve_merchant_id(&principal, request)?;
    Ok((merchant_id, principal))
}

/// One wallet row (`id, name, currency, status, gl_account_id, created_at, updated_at`).
type WalletRow = (
    Uuid,
    Option<String>,
    String,
    String,
    Uuid,
    NaiveDateTime,
    NaiveDateTime,
);

async fn merchant_wallets(state: &AppState, merchant_id: Uuid) -> Result<Vec<WalletRow>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, currency, status::text AS status, gl_account_id, created_at, updated_at
           FROM wallets WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC",
    )
    .bind(merchant_id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(support::sqlx_error)?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get("id").map_err(support::sqlx_error)?,
                row.try_get("name").map_err(support::sqlx_error)?,
                row.try_get("currency").map_err(support::sqlx_error)?,
                row.try_get("status").map_err(support::sqlx_error)?,
                row.try_get("gl_account_id").map_err(support::sqlx_error)?,
                row.try_get("created_at").map_err(support::sqlx_error)?,
                row.try_get("updated_at").map_err(support::sqlx_error)?,
            ))
        })
        .collect()
}

fn wallet_refs(wallets: &[WalletRow]) -> Vec<WalletRef> {
    wallets
        .iter()
        .map(|(id, _, currency, _, gl_account_id, _, _)| WalletRef {
            id: *id,
            gl_account_id: *gl_account_id,
            currency: currency.clone(),
        })
        .collect()
}

fn amount_by_wallet(amounts: &[WalletAmount]) -> HashMap<Uuid, &WalletAmount> {
    amounts
        .iter()
        .map(|amount| (amount.wallet_id, amount))
        .collect()
}

/// Counts of `applications`, `links`, pending `cashouts` and `payments` per wallet.
#[derive(Debug, Default)]
struct WalletCounts {
    applications: HashMap<Uuid, i64>,
    links: HashMap<Uuid, i64>,
    cashouts: HashMap<Uuid, i64>,
    payments: HashMap<Uuid, i64>,
}

async fn wallet_counts(state: &AppState, wallet_ids: &[Uuid]) -> Result<WalletCounts, ApiError> {
    let mut counts = WalletCounts::default();
    if wallet_ids.is_empty() {
        return Ok(counts);
    }
    let pool = &state.pools.main;
    let applications = sqlx::query(
        "SELECT assigned_wallet_id, count(*)::bigint AS count FROM applications
          WHERE assigned_wallet_id = ANY($1::uuid[]) GROUP BY assigned_wallet_id",
    )
    .bind(wallet_ids)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    for row in &applications {
        counts.applications.insert(
            row.try_get("assigned_wallet_id")
                .map_err(support::sqlx_error)?,
            row.try_get("count").map_err(support::sqlx_error)?,
        );
    }
    let links = sqlx::query(
        "SELECT wallet_id, count(*)::bigint AS count FROM payment_links
          WHERE wallet_id = ANY($1::uuid[]) GROUP BY wallet_id",
    )
    .bind(wallet_ids)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    for row in &links {
        counts.links.insert(
            row.try_get("wallet_id").map_err(support::sqlx_error)?,
            row.try_get("count").map_err(support::sqlx_error)?,
        );
    }
    let cashouts = sqlx::query(
        "SELECT wallet_id, count(*)::bigint AS count FROM cashout_requests
          WHERE wallet_id = ANY($1::uuid[]) AND state IN ('PENDING','PROCESSING')
          GROUP BY wallet_id",
    )
    .bind(wallet_ids)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    for row in &cashouts {
        counts.cashouts.insert(
            row.try_get("wallet_id").map_err(support::sqlx_error)?,
            row.try_get("count").map_err(support::sqlx_error)?,
        );
    }
    let payments = sqlx::query(
        "SELECT l.wallet_id, count(*)::bigint AS count
           FROM payment_attempts pa JOIN payment_links l ON l.id = pa.link_id
          WHERE l.wallet_id = ANY($1::uuid[]) GROUP BY l.wallet_id",
    )
    .bind(wallet_ids)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    for row in &payments {
        counts.payments.insert(
            row.try_get("wallet_id").map_err(support::sqlx_error)?,
            row.try_get("count").map_err(support::sqlx_error)?,
        );
    }
    Ok(counts)
}

fn studio_wallet_row(
    merchant_id: Uuid,
    wallet: &WalletRow,
    amount: Option<&WalletAmount>,
    counts: &WalletCounts,
) -> Value {
    let (id, name, currency, status, gl_account_id, created_at, updated_at) = wallet;
    json!({
        "id": id,
        "name": name,
        "merchantId": merchant_id,
        "currency": currency,
        "status": status,
        "glAccountId": gl_account_id,
        "availableBalance": amount.map(|value| value.available_balance.clone()).unwrap_or_else(|| "0.0000".to_owned()),
        "checkpointBalance": amount.map(|value| value.checkpoint_balance.clone()).unwrap_or_else(|| "0.0000".to_owned()),
        "checkpointAt": amount.and_then(|value| value.checkpoint_at).map(|value| iso_timestamptz(Some(value))).unwrap_or(Value::Null),
        "checkpointStatus": amount.map(|value| value.checkpoint_status.clone()).unwrap_or_else(|| "OK".to_owned()),
        "pendingLines": amount.map_or(0, |value| value.pending_lines),
        "shardCount": amount.map_or(0, |value| value.shard_count),
        "applications": counts.applications.get(id).copied().unwrap_or(0),
        "links": counts.links.get(id).copied().unwrap_or(0),
        "payments": counts.payments.get(id).copied().unwrap_or(0),
        "pendingCashouts": counts.cashouts.get(id).copied().unwrap_or(0),
        "createdAt": iso_timestamp(Some(*created_at)),
        "updatedAt": iso_timestamp(Some(*updated_at)),
    })
}

fn sum_decimals(values: impl Iterator<Item = Decimal>) -> Decimal {
    values.fold(Decimal::ZERO, |total, value| total + value)
}

fn optional_amount(value: Option<Decimal>) -> Value {
    value.map_or(Value::Null, |value| Value::String(money(Some(value))))
}

// The selected application fields of the wallet detail (`applications {select …}`).
const WALLET_APPLICATION_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("name", "name", FieldKind::Text),
    f("status", "status", FieldKind::Text),
    f("created_at", "createdAt", FieldKind::Timestamp),
];

// The selected link fields of the wallet detail (`paymentLinks {select …}`).
const WALLET_LINK_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("key", "key", FieldKind::Text),
    f("title", "title", FieldKind::Text),
    f("amount", "amount", FieldKind::Decimal),
    f("currency", "currency", FieldKind::Text),
    f("state", "state", FieldKind::Text),
    f("use_count", "useCount", FieldKind::Int),
    f("confirmed_count", "confirmedCount", FieldKind::Int),
    f("created_at", "createdAt", FieldKind::Timestamp),
];

// ---------------------------------------------------------------------------------------------
// `GET /internal/sandbox/merchant/overview`
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/overview`.
pub fn overview<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let envelope = match ensure_merchant_envelope(
            &state.pools.main,
            merchant_id,
            header_value(request, "x-merchant-name").as_deref(),
            header_value(request, "x-merchant-email").as_deref(),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_overview(state, merchant_id, envelope).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_overview(
    state: &AppState,
    merchant_id: Uuid,
    envelope: MerchantEnvelope,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let wallets = merchant_wallets(state, merchant_id).await?;
    let amounts = wallet_amounts(pool, &wallet_refs(&wallets)).await?;
    let by_wallet = amount_by_wallet(&amounts);

    let applications: i64 =
        sqlx::query_scalar("SELECT count(*) FROM applications WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let links: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_links l JOIN applications a ON a.id = l.application_id
          WHERE a.merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let attempts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM payment_attempts WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let tokens: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens
          WHERE merchant_id = $1 AND env = 'SANDBOX' AND revoked_at IS NULL",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let pending_cashouts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cashout_requests
          WHERE merchant_id = $1 AND state IN ('PENDING','PROCESSING')",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let plane = sqlx::query(
        "SELECT live_sync_revision, last_synced_from_live
           FROM system_execution_plane WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = support::safe_query(format!(
        "SELECT {AUDIT_COLUMNS} FROM sandbox_sync_audits
          WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 10"
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = ordered_rows(&audits, AUDIT_FIELDS)?;
    let rails: i64 = sqlx::query_scalar("SELECT count(*) FROM rails")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let gateways: i64 = sqlx::query_scalar("SELECT count(*) FROM gateways")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let routes: i64 = sqlx::query_scalar("SELECT count(*) FROM rail_routes")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let commission_profiles: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM commission_profiles
          WHERE merchant_id IS NULL AND application_id IS NULL",
    )
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;

    let (fake_rails, fake_accounts) = match ControlClient::from_env()
        .accounts(&[("merchantId", merchant_id.to_string())])
        .await
    {
        Ok(accounts) => (json!({ "ok": true }), accounts.len()),
        Err(error) => (json!({ "ok": false, "message": error.message }), 0),
    };

    let live_sync_revision = plane
        .as_ref()
        .and_then(|row| row.try_get::<i32, _>("live_sync_revision").ok())
        .map(Value::from)
        .unwrap_or_else(|| Value::from(0));
    let last_synced = plane
        .as_ref()
        .and_then(|row| {
            row.try_get::<Option<NaiveDateTime>, _>("last_synced_from_live")
                .ok()
                .flatten()
        })
        .map(|value| iso_timestamp(Some(value)))
        .unwrap_or(Value::Null);

    Ok(json!({
        "plane": "SANDBOX",
        "merchantId": merchant_id,
        "merchantName": envelope.trade_name,
        "payoutBankDetails": envelope.payout_bank_details,
        "liveSyncRevision": live_sync_revision,
        "lastSyncedFromLive": last_synced,
        "fakeRails": fake_rails,
        "reference": {
            "rails": rails,
            "gateways": gateways,
            "routes": routes,
            "commissionProfiles": commission_profiles,
            "ready": rails > 0 && gateways > 0 && routes > 0,
        },
        "counts": {
            "wallets": wallets.len(),
            "applications": applications,
            "links": links,
            "payments": attempts,
            "pendingCashouts": pending_cashouts,
            "activeTestTokens": tokens,
            "fakeCustomerAccounts": fake_accounts,
        },
        "syncAudits": audits,
        "wallets": wallets.iter().map(|wallet| {
            let (id, name, currency, status, _, _, _) = wallet;
            json!({
                "id": id,
                "name": name,
                "currency": currency,
                "status": status,
                "availableBalance": by_wallet.get(id).map(|amount| amount.available_balance.clone()).unwrap_or_else(|| "0.0000".to_owned()),
            })
        }).collect::<Vec<Value>>(),
    }))
}

// ---------------------------------------------------------------------------------------------
// `GET /internal/sandbox/merchant/wallets/:walletId`
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/wallets/:walletId`.
pub fn wallet_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(wallet_id) = Uuid::parse_str(&path_segment(request, 5)) else {
            return crate::http::error_response(request, wallet_not_found());
        };
        match load_wallet_detail(state, merchant_id, wallet_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_wallet_detail(
    state: &AppState,
    merchant_id: Uuid,
    wallet_id: Uuid,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let wallet = sqlx::query(
        "SELECT id, name, merchant_id, currency, status::text AS status, gl_account_id, created_at
           FROM wallets WHERE id = $1 AND merchant_id = $2",
    )
    .bind(wallet_id)
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(wallet) = wallet else {
        return Err(wallet_not_found());
    };
    let gl_account_id: Uuid = wallet
        .try_get("gl_account_id")
        .map_err(support::sqlx_error)?;
    let amounts = wallet_amounts(
        pool,
        &[WalletRef {
            id: wallet_id,
            gl_account_id,
            currency: wallet.try_get("currency").map_err(support::sqlx_error)?,
        }],
    )
    .await?;
    let pending_cashouts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cashout_requests
          WHERE wallet_id = $1 AND state IN ('PENDING','PROCESSING')",
    )
    .bind(wallet_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let applications: i64 =
        sqlx::query_scalar("SELECT count(*) FROM applications WHERE assigned_wallet_id = $1")
            .bind(wallet_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_links WHERE wallet_id = $1")
        .bind(wallet_id)
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let attempts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_attempts pa JOIN payment_links l ON l.id = pa.link_id
          WHERE l.wallet_id = $1",
    )
    .bind(wallet_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    Ok(json!({
        "wallet": {
            "id": wallet.get::<Uuid, _>("id"),
            "name": wallet.get::<Option<String>, _>("name"),
            "merchantId": wallet.get::<Uuid, _>("merchant_id"),
            "currency": wallet.get::<String, _>("currency"),
            "status": wallet.get::<String, _>("status"),
            "glAccountId": gl_account_id,
            "createdAt": iso_timestamp(wallet.try_get("created_at").map_err(support::sqlx_error)?),
        },
        "availableBalance": amounts.first().map(|amount| amount.available_balance.clone()).unwrap_or_else(|| "0.0000".to_owned()),
        "pendingCashouts": pending_cashouts,
        "applications": applications,
        "links": links,
        "attempts": attempts,
    }))
}

// ---------------------------------------------------------------------------------------------
// `GET /internal/sandbox/merchant/wallets/:walletId/ledger`
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/wallets/:walletId/ledger`.
pub fn wallet_ledger<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(wallet_id) = Uuid::parse_str(&path_segment(request, 5)) else {
            return crate::http::error_response(request, wallet_not_found());
        };
        let wallet = sqlx::query(
            "SELECT id, gl_account_id, currency FROM wallets
              WHERE id = $1 AND merchant_id = $2",
        )
        .bind(wallet_id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let wallet = match wallet {
            Ok(Some(row)) => row,
            Ok(None) => return crate::http::error_response(request, wallet_not_found()),
            Err(error) => return crate::http::error_response(request, support::sqlx_error(error)),
        };
        let account_id: Uuid = match wallet.try_get("gl_account_id") {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, support::sqlx_error(error)),
        };
        let currency: String = wallet
            .try_get("currency")
            .unwrap_or_else(|_| "LYD".to_owned());
        let lines = match list_account_lines(state, account_id, request).await {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let mut body = json!({ "walletId": wallet_id, "currency": currency });
        if let (Value::Object(map), Value::Object(lines)) = (&mut body, lines) {
            for (key, value) in lines {
                map.insert(key, value);
            }
        }
        json_ok(&body)
    })
}

/// `enumListFilter`: comma separated, every member must be in `allowed`.
fn enum_list_filter(
    request: &HttpRequest,
    key: &str,
    allowed: &[&str],
) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = query_trimmed(request, key) else {
        return Ok(None);
    };
    let values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    let unknown: Vec<&String> = values
        .iter()
        .filter(|value| !allowed.contains(&value.as_str()))
        .collect();
    if !unknown.is_empty() || values.is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{key}' filter is invalid"),
        )
        .with_details(json!({ "allowed": allowed, "unknown": unknown })));
    }
    Ok(Some(values))
}

/// `listAccountLines` (`ledgerLines.ts:46`): the `{lines,total,page,pageSize,nextCursor?,totals}`
/// object the wallet ledger spreads.
async fn list_account_lines(
    state: &AppState,
    account_id: Uuid,
    request: &HttpRequest,
) -> Result<Value, ApiError> {
    let mut query = query_map(request);
    let ref_types = enum_list_filter(request, "refType", &JOURNAL_REF_TYPES)?;
    let direction = enum_list_filter(request, "direction", &["DEBIT", "CREDIT"])?;
    let direction = match direction {
        None => None,
        Some(values) if values.len() == 1 => values.into_iter().next(),
        Some(_) => {
            return Err(
                ApiError::new(400, "INVALID_FILTER", "The 'direction' filter is invalid")
                    .with_details(json!({ "allowed": ["DEBIT", "CREDIT"] })),
            )
        }
    };
    let search = query_trimmed(request, "search");
    for key in ["search", "refType", "direction"] {
        query.remove(key);
    }
    let spec = ListSpec::default()
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("amount", "amount")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0);
    let columns = ColumnMap::new()
        .with("id", "jl.id", ColumnKind::Uuid)
        .with("createdAt", "jl.created_at", ColumnKind::Timestamp)
        .with("amount", "jl.amount", ColumnKind::Decimal);
    let mut built = pg_db::list_query::build_list_query(&query, &spec, &columns)
        .map_err(support::filter_error)?;
    let account = bind_uuid(&mut built, account_id);
    push_condition(&mut built, format!("jl.gl_account_id = {account}"));
    if let Some(direction) = &direction {
        let placeholder = bind_text(&mut built, direction.clone());
        push_condition(&mut built, format!("jl.direction::text = {placeholder}"));
    }
    let mut entry_clauses = Vec::new();
    if let Some(ref_types) = &ref_types {
        let placeholders: Vec<String> = ref_types
            .iter()
            .map(|ref_type| bind_text(&mut built, ref_type.clone()))
            .collect();
        entry_clauses.push(format!(
            "je.ref_type::text IN ({})",
            placeholders.join(", ")
        ));
    }
    if let Some(search) = &search {
        let pattern = bind_text(&mut built, format!("%{search}%"));
        entry_clauses.push(format!(
            "(je.description ILIKE {pattern} OR je.ref_id ILIKE {pattern})"
        ));
    }
    if !entry_clauses.is_empty() {
        push_condition(&mut built, entry_clauses.join(" AND "));
    }

    let pool = &state.pools.main;
    let sql = built.select_sql(
        "journal_lines jl INNER JOIN journal_entries je ON je.id = jl.entry_id",
        &[
            "jl.id",
            "jl.entry_id",
            "jl.created_at",
            "jl.direction::text",
            "jl.amount::text AS amount",
            "je.ref_type::text",
            "je.ref_id",
            "je.description",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(
        &built,
        "journal_lines jl INNER JOIN journal_entries je ON je.id = jl.entry_id",
        pool,
    )
    .await
    .map_err(support::filter_error)?;
    let mut lines = Vec::with_capacity(rows.len());
    for row in &rows {
        lines.push(json!({
            "lineId": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
            "entryId": row.try_get::<Uuid, _>("entry_id").map_err(support::sqlx_error)?,
            "direction": row.try_get::<String, _>("direction").map_err(support::sqlx_error)?,
            "amount": money(Some(parse_decimal(&row.try_get::<String, _>("amount").map_err(support::sqlx_error)?))),
            "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            "refType": row.try_get::<String, _>("ref_type").map_err(support::sqlx_error)?,
            "refId": row.try_get::<String, _>("ref_id").map_err(support::sqlx_error)?,
            "description": row.try_get::<Option<String>, _>("description").map_err(support::sqlx_error)?,
        }));
    }
    let totals_sql = format!(
        "SELECT jl.direction::text AS direction, count(*)::bigint AS line_count,
                COALESCE(SUM(jl.amount), 0)::text AS total
           FROM journal_lines jl INNER JOIN journal_entries je ON je.id = jl.entry_id
          {} GROUP BY jl.direction",
        built.where_sql
    );
    let totals_rows = built
        .bind_count(&totals_sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let mut line_count = 0_i64;
    let mut total_debit = Decimal::ZERO;
    let mut total_credit = Decimal::ZERO;
    for row in &totals_rows {
        let direction: String = row.try_get("direction").map_err(support::sqlx_error)?;
        let count: i64 = row.try_get("line_count").map_err(support::sqlx_error)?;
        let sum = parse_decimal(
            &row.try_get::<String, _>("total")
                .map_err(support::sqlx_error)?,
        );
        line_count += count;
        if direction == "DEBIT" {
            total_debit = sum;
        } else {
            total_credit = sum;
        }
    }
    let net = total_debit - total_credit;
    let mut response = json!({
        "lines": lines,
        "total": total,
        "page": js_number(built.page),
        "pageSize": js_number(built.page_size),
        "totals": {
            "lineCount": line_count,
            "totalDebit": money(Some(total_debit)),
            "totalCredit": money(Some(total_credit)),
            "netDebit": money(Some(net)),
        },
    });
    if let (Value::Object(map), Some(plan)) = (&mut response, &built.keyset) {
        if rows.len() as f64 >= built.page_size {
            let source_rows = cursor_rows(
                built.keyset.as_ref(),
                &rows,
                &[
                    CursorColumn {
                        path: "createdAt",
                        column: "created_at",
                        kind: FieldKind::Timestamp,
                    },
                    CursorColumn {
                        path: "id",
                        column: "id",
                        kind: FieldKind::Uuid,
                    },
                ],
            )?;
            if let Some(last) = source_rows.last() {
                if let Some(cursor) = encode_cursor(plan, last) {
                    map.insert("nextCursor".to_owned(), Value::String(cursor));
                }
            }
        }
    }
    Ok(response)
}

fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

// ---------------------------------------------------------------------------------------------
// `GET /internal/sandbox/merchant/payments/:attemptId`
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/payments/:attemptId`.
pub fn payment_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(attempt_id) = Uuid::parse_str(&path_segment(request, 5)) else {
            return crate::http::error_response(request, attempt_not_found());
        };
        match load_payment_detail(state, merchant_id, attempt_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_payment_detail(
    state: &AppState,
    merchant_id: Uuid,
    attempt_id: Uuid,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let attempt = support::safe_query(format!(
        "SELECT {ATTEMPT_COLUMNS} FROM payment_attempts pa
          WHERE pa.id = $1 AND pa.merchant_id = $2"
    ))
    .bind(attempt_id)
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(attempt) = attempt else {
        return Err(attempt_not_found());
    };
    let mut attempt_json = ordered_row(&attempt, ATTEMPT_FIELDS)?;
    let link_id: Uuid = attempt.try_get("link_id").map_err(support::sqlx_error)?;
    let gateway_version_id: Uuid = attempt
        .try_get("gateway_version_id")
        .map_err(support::sqlx_error)?;
    let rail_id: Uuid = attempt.try_get("rail_id").map_err(support::sqlx_error)?;
    let application_id: Uuid = attempt
        .try_get("application_id")
        .map_err(support::sqlx_error)?;
    let ledger_entry_id: Option<Uuid> = attempt
        .try_get("ledger_entry_id")
        .map_err(support::sqlx_error)?;
    let reference: String = attempt
        .try_get::<Option<String>, _>("provider_reference")
        .map_err(support::sqlx_error)?
        .unwrap_or_else(|| {
            attempt
                .try_get::<String, _>("reference")
                .unwrap_or_default()
        });
    let total_charged: Decimal = decimal(
        attempt
            .try_get("total_charged_amount")
            .map_err(support::sqlx_error)?,
    );
    let settled: Option<Decimal> = attempt
        .try_get("settled_amount")
        .map_err(support::sqlx_error)?;

    let link = sqlx::query(
        "SELECT l.id, l.key, l.title, l.application_id, l.wallet_id,
                w.id AS wallet_id_w, w.name AS wallet_name, w.currency AS wallet_currency,
                w.status::text AS wallet_status,
                a.id AS application_id_a, a.name AS application_name,
                a.status::text AS application_status
           FROM payment_links l
           JOIN wallets w ON w.id = l.wallet_id
           JOIN applications a ON a.id = l.application_id
          WHERE l.id = $1",
    )
    .bind(link_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let link_json = match &link {
        Some(row) => json!({
            "id": row.get::<Uuid, _>("id"),
            "key": row.get::<String, _>("key"),
            "title": row.get::<Option<String>, _>("title"),
            "applicationId": row.get::<Uuid, _>("application_id"),
            "walletId": row.get::<Uuid, _>("wallet_id"),
            "wallet": {
                "id": row.get::<Uuid, _>("wallet_id_w"),
                "name": row.get::<Option<String>, _>("wallet_name"),
                "currency": row.get::<String, _>("wallet_currency"),
                "status": row.get::<String, _>("wallet_status"),
            },
            "application": {
                "id": row.get::<Uuid, _>("application_id_a"),
                "name": row.get::<String, _>("application_name"),
                "status": row.get::<String, _>("application_status"),
            },
        }),
        None => Value::Null,
    };

    let application =
        sqlx::query("SELECT id, name, status::text AS status FROM applications WHERE id = $1")
            .bind(application_id)
            .fetch_optional(pool)
            .await
            .map_err(support::sqlx_error)?;
    let application_json = application
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "name": row.get::<String, _>("name"),
                "status": row.get::<String, _>("status"),
            })
        })
        .unwrap_or(Value::Null);

    let rail = sqlx::query("SELECT code, name_en, name_ar FROM rails WHERE id = $1")
        .bind(rail_id)
        .fetch_optional(pool)
        .await
        .map_err(support::sqlx_error)?;
    let rail_json = rail
        .map(|row| {
            json!({
                "code": row.get::<String, _>("code"),
                "nameEn": row.get::<String, _>("name_en"),
                "nameAr": row.get::<String, _>("name_ar"),
            })
        })
        .unwrap_or(Value::Null);

    let gateway = sqlx::query(
        "SELECT gv.version_number, g.code, g.name
           FROM gateway_versions gv JOIN gateways g ON g.id = gv.gateway_id
          WHERE gv.id = $1",
    )
    .bind(gateway_version_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let (gateway_version_json, gateway_json) = match gateway {
        Some(row) => (
            json!({
                "gateway": {
                    "code": row.get::<String, _>("code"),
                    "name": row.get::<String, _>("name"),
                },
                "versionNumber": row.get::<i32, _>("version_number"),
            }),
            json!({
                "code": row.get::<String, _>("code"),
                "name": row.get::<String, _>("name"),
            }),
        ),
        None => (Value::Null, Value::Null),
    };

    let ledger_entry = match ledger_entry_id {
        Some(entry_id) => {
            let entry = support::safe_query(format!(
                "SELECT {JOURNAL_ENTRY_COLUMNS} FROM journal_entries WHERE id = $1"
            ))
            .bind(entry_id)
            .fetch_optional(pool)
            .await
            .map_err(support::sqlx_error)?;
            match entry {
                Some(entry) => {
                    let lines = support::safe_query(format!(
                        "SELECT {JOURNAL_LINE_COLUMNS} FROM journal_lines
                          WHERE entry_id = $1 ORDER BY created_at, id"
                    ))
                    .bind(entry_id)
                    .fetch_all(pool)
                    .await
                    .map_err(support::sqlx_error)?;
                    let mut entry_json = ordered_row(&entry, JOURNAL_ENTRY_FIELDS)?;
                    let lines_json = Value::Array(ordered_rows(&lines, JOURNAL_LINE_FIELDS)?);
                    if let Value::Object(map) = &mut entry_json {
                        map.insert("journalLines".to_owned(), lines_json);
                    }
                    Some(entry_json)
                }
                None => None,
            }
        }
        None => None,
    };

    let step_logs = support::safe_query(format!(
        "SELECT {STEP_LOG_COLUMNS} FROM attempt_step_logs
          WHERE attempt_id = $1 ORDER BY created_at, id LIMIT 200"
    ))
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let step_logs = ordered_rows(&step_logs, STEP_LOG_FIELDS)?;

    let disputes = support::safe_query(format!(
        "SELECT {DISPUTE_COLUMNS} FROM disputes WHERE attempt_id = $1
          ORDER BY opened_at DESC, id DESC"
    ))
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let disputes_json = ordered_rows(&disputes, DISPUTE_FIELDS)?;

    let adjustments = support::safe_query(format!(
        "SELECT {ADJUSTMENT_COLUMNS} FROM adjustments WHERE source_attempt_id = $1
          ORDER BY created_at DESC, id DESC"
    ))
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let adjustments_json = ordered_rows(&adjustments, ADJUSTMENT_FIELDS)?;

    let refunds: Decimal = sum_decimals(adjustments_json.iter().filter_map(|adjustment| {
        if adjustment.get("type").and_then(Value::as_str) != Some("REFUND") {
            return None;
        }
        if !matches!(
            adjustment.get("state").and_then(Value::as_str),
            Some("EXECUTED") | Some("EXECUTING")
        ) {
            return None;
        }
        adjustment
            .get("amount")
            .and_then(Value::as_str)
            .map(parse_decimal)
    }));
    let refundable = (settled.unwrap_or(total_charged) - refunds).max(Decimal::ZERO);

    let inspector = if reference.is_empty() {
        Value::Null
    } else {
        ControlClient::from_env()
            .checkout_helper(&reference)
            .await
            .unwrap_or(Value::Null)
    };

    // `{...attempt, …}`: include keys follow the scalars in the include order.
    if let Value::Object(map) = &mut attempt_json {
        map.insert("link".to_owned(), link_json.clone());
        map.insert("application".to_owned(), application_json.clone());
        map.insert("rail".to_owned(), rail_json.clone());
        map.insert("gatewayVersion".to_owned(), gateway_version_json);
        map.insert(
            "ledgerEntry".to_owned(),
            ledger_entry.clone().unwrap_or(Value::Null),
        );
        map.insert("stepLogs".to_owned(), Value::Array(step_logs.clone()));
        map.insert("disputes".to_owned(), Value::Array(disputes_json.clone()));
        map.insert(
            "adjustments".to_owned(),
            Value::Array(adjustments_json.clone()),
        );
    }

    let refunds_json: Vec<Value> = adjustments_json
        .iter()
        .filter(|adjustment| adjustment.get("type").and_then(Value::as_str) == Some("REFUND"))
        .map(|adjustment| {
            let mut row = adjustment.clone();
            if let Value::Object(map) = &mut row {
                if let Some(amount) = map.get("amount").and_then(Value::as_str) {
                    map.insert(
                        "amount".to_owned(),
                        Value::String(money(Some(parse_decimal(amount)))),
                    );
                }
            }
            row
        })
        .collect();

    let ledger_lines: Vec<Value> = ledger_entry
        .as_ref()
        .and_then(|entry| entry.get("journalLines"))
        .and_then(Value::as_array)
        .map(|lines| {
            let ref_type = ledger_entry
                .as_ref()
                .and_then(|entry| entry.get("refType"))
                .cloned()
                .unwrap_or_else(|| Value::String("PAYMENT_ATTEMPT".to_owned()));
            let ref_id = ledger_entry
                .as_ref()
                .and_then(|entry| entry.get("refId"))
                .cloned()
                .unwrap_or_else(|| Value::String(attempt_id.to_string()));
            let description = ledger_entry
                .as_ref()
                .and_then(|entry| entry.get("description"))
                .cloned()
                .unwrap_or_else(|| Value::String("Sandbox payment ledger line".to_owned()));
            lines
                .iter()
                .map(|line| {
                    json!({
                        "lineId": line.get("id").cloned().unwrap_or(Value::Null),
                        "entryId": line.get("entryId").cloned().unwrap_or(Value::Null),
                        "direction": line.get("direction").cloned().unwrap_or(Value::Null),
                        "amount": money(line.get("amount").and_then(Value::as_str).map(parse_decimal)),
                        "createdAt": line.get("createdAt").cloned().unwrap_or(Value::Null),
                        "refType": ref_type,
                        "refId": ref_id,
                        "description": description,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "attempt": attempt_json,
        "link": link_json,
        "application": application_json,
        "rail": rail_json,
        "gateway": gateway_json,
        "stepLogs": step_logs,
        "adjustments": adjustments_json,
        "ledgerLines": ledger_lines,
        "refunds": refunds_json,
        "disputes": disputes_json,
        "refundableAmount": money(Some(refundable)),
        "inspector": inspector,
    }))
}

// ---------------------------------------------------------------------------------------------
// Studio overview
// ---------------------------------------------------------------------------------------------

/// One attempt of the Studio overview aggregation.
struct OverviewAttempt {
    status: String,
    created_at: NaiveDateTime,
    total_charged: Decimal,
    settled: Decimal,
    fee: Decimal,
    commission: Decimal,
    net: Decimal,
}

/// `GET /internal/sandbox/merchant/studio/overview`.
pub fn studio_overview<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let envelope = match ensure_merchant_envelope(
            &state.pools.main,
            merchant_id,
            header_value(request, "x-merchant-name").as_deref(),
            header_value(request, "x-merchant-email").as_deref(),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_studio_overview(state, request, merchant_id, envelope).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_overview(
    state: &AppState,
    request: &HttpRequest,
    merchant_id: Uuid,
    envelope: MerchantEnvelope,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let currency = resolve_reporting_currency(query_scalar(request, "currency").as_deref());
    let selected_wallets: Vec<WalletRow> = merchant_wallets(state, merchant_id)
        .await?
        .into_iter()
        .filter(|wallet| wallet.2 == currency)
        .collect();
    let all_wallets = merchant_wallets(state, merchant_id).await?;
    let selected_amounts = wallet_amounts(pool, &wallet_refs(&selected_wallets)).await?;
    let all_amounts = wallet_amounts(pool, &wallet_refs(&all_wallets)).await?;

    let aggregates = sqlx::query(
        "SELECT currency,
                SUM(total_charged_amount)::text AS charged,
                SUM(settled_amount)::text AS settled,
                SUM(gateway_fee_amount)::text AS fees,
                SUM(platform_commission_amount)::text AS commission,
                SUM(net_merchant_amount)::text AS net
           FROM payment_attempts WHERE merchant_id = $1 GROUP BY currency",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;

    let applications: i64 =
        sqlx::query_scalar("SELECT count(*) FROM applications WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let links: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_links l
           JOIN applications a ON a.id = l.application_id
           JOIN wallets w ON w.id = l.wallet_id
          WHERE a.merchant_id = $1 AND w.currency = $2",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let attempt_rows = sqlx::query(
        "SELECT status::text AS status, created_at, total_charged_amount, settled_amount,
                gateway_fee_amount, platform_commission_amount, net_merchant_amount
           FROM payment_attempts WHERE merchant_id = $1 AND currency = $2",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let attempts: Vec<OverviewAttempt> = attempt_rows
        .iter()
        .map(|row| {
            Ok(OverviewAttempt {
                status: row.try_get("status").map_err(support::sqlx_error)?,
                created_at: row.try_get("created_at").map_err(support::sqlx_error)?,
                total_charged: decimal(
                    row.try_get("total_charged_amount")
                        .map_err(support::sqlx_error)?,
                ),
                settled: decimal(row.try_get("settled_amount").map_err(support::sqlx_error)?),
                fee: decimal(
                    row.try_get("gateway_fee_amount")
                        .map_err(support::sqlx_error)?,
                ),
                commission: decimal(
                    row.try_get("platform_commission_amount")
                        .map_err(support::sqlx_error)?,
                ),
                net: decimal(
                    row.try_get("net_merchant_amount")
                        .map_err(support::sqlx_error)?,
                ),
            })
        })
        .collect::<Result<_, ApiError>>()?;
    let tokens: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens
          WHERE merchant_id = $1 AND env = 'SANDBOX' AND revoked_at IS NULL",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let pending_cashouts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cashout_requests cr JOIN wallets w ON w.id = cr.wallet_id
          WHERE cr.merchant_id = $1 AND w.currency = $2
            AND cr.state IN ('PENDING','PROCESSING')",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let disputes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes d
           JOIN payment_attempts pa ON pa.id = d.attempt_id
          WHERE pa.merchant_id = $1 AND pa.currency = $2
            AND d.status IN ('OPENED','EVIDENCE_REQUESTED','EVIDENCE_SUBMITTED')",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let accounts = ControlClient::from_env()
        .accounts(&[("merchantId", merchant_id.to_string())])
        .await
        .unwrap_or_default();
    let rails: i64 = sqlx::query_scalar("SELECT count(*) FROM rails")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let gateways: i64 = sqlx::query_scalar("SELECT count(*) FROM gateways")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let routes: i64 = sqlx::query_scalar("SELECT count(*) FROM rail_routes")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let commission_profiles: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM commission_profiles
          WHERE merchant_id IS NULL AND application_id IS NULL",
    )
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let recent = sqlx::query(
        "SELECT pa.id, pa.reference, pa.status::text AS status, pa.currency,
                pa.total_charged_amount, pa.net_merchant_amount, pa.created_at,
                r.code AS rail_code, l.key AS link_key
           FROM payment_attempts pa
           JOIN rails r ON r.id = pa.rail_id
           JOIN payment_links l ON l.id = pa.link_id
          WHERE pa.merchant_id = $1 AND pa.currency = $2
          ORDER BY pa.created_at DESC, pa.id DESC LIMIT 8",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let recent: Vec<Value> = recent
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
                "reference": row.try_get::<String, _>("reference").map_err(support::sqlx_error)?,
                "status": row.try_get::<String, _>("status").map_err(support::sqlx_error)?,
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "amount": money(row.try_get("total_charged_amount").map_err(support::sqlx_error)?),
                "net": money(row.try_get("net_merchant_amount").map_err(support::sqlx_error)?),
                "railCode": row.try_get::<String, _>("rail_code").map_err(support::sqlx_error)?,
                "linkKey": row.try_get::<String, _>("link_key").map_err(support::sqlx_error)?,
                "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    let audits = support::safe_query(format!(
        "SELECT {AUDIT_COLUMNS} FROM sandbox_sync_audits
          WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 10"
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = ordered_rows(&audits, AUDIT_FIELDS)?;

    // `byCurrency`: wallets seed `available`, the aggregate adds the attempt sums.
    let mut by_currency: BTreeMap<String, [Decimal; 6]> = BTreeMap::new();
    for (index, wallet) in all_wallets.iter().enumerate() {
        let entry = by_currency
            .entry(wallet.2.clone())
            .or_insert([Decimal::ZERO; 6]);
        entry[0] += parse_decimal(&all_amounts[index].available_balance);
    }
    for row in &aggregates {
        let currency: String = row.try_get("currency").map_err(support::sqlx_error)?;
        let entry = by_currency.entry(currency).or_insert([Decimal::ZERO; 6]);
        entry[1] = parse_decimal(
            &row.try_get::<Option<String>, _>("charged")
                .map_err(support::sqlx_error)?
                .unwrap_or_default(),
        );
        entry[2] = parse_decimal(
            &row.try_get::<Option<String>, _>("settled")
                .map_err(support::sqlx_error)?
                .unwrap_or_default(),
        );
        entry[3] = parse_decimal(
            &row.try_get::<Option<String>, _>("fees")
                .map_err(support::sqlx_error)?
                .unwrap_or_default(),
        );
        entry[4] = parse_decimal(
            &row.try_get::<Option<String>, _>("commission")
                .map_err(support::sqlx_error)?
                .unwrap_or_default(),
        );
        entry[5] = parse_decimal(
            &row.try_get::<Option<String>, _>("net")
                .map_err(support::sqlx_error)?
                .unwrap_or_default(),
        );
    }
    let by_currency_json: Vec<Value> = by_currency
        .iter()
        .map(|(currency, values)| {
            json!({
                "currency": currency,
                "available": money(Some(values[0])),
                "charged": money(Some(values[1])),
                "settled": money(Some(values[2])),
                "fees": money(Some(values[3])),
                "commission": money(Some(values[4])),
                "net": money(Some(values[5])),
            })
        })
        .collect();

    let mut status_counts: BTreeMap<String, i64> = BTreeMap::new();
    for attempt in &attempts {
        *status_counts.entry(attempt.status.clone()).or_default() += 1;
    }
    let since = Utc::now().naive_utc() - Duration::hours(24);
    let recent24: Vec<&OverviewAttempt> = attempts
        .iter()
        .filter(|attempt| attempt.created_at >= since)
        .collect();
    let available = sum_decimals(
        selected_amounts
            .iter()
            .map(|amount| parse_decimal(&amount.available_balance)),
    );
    let checkpoint = sum_decimals(
        selected_amounts
            .iter()
            .map(|amount| parse_decimal(&amount.checkpoint_balance)),
    );

    Ok(json!({
        "plane": "SANDBOX",
        "currency": currency,
        "merchantId": merchant_id,
        "merchantName": envelope.trade_name,
        "payoutBankDetails": envelope.payout_bank_details,
        "fakeRails": { "ok": true, "accounts": accounts.len() },
        "reference": {
            "rails": rails,
            "gateways": gateways,
            "routes": routes,
            "commissionProfiles": commission_profiles,
            "ready": rails > 0 && gateways > 0 && routes > 0,
        },
        "counts": {
            "wallets": selected_wallets.len(),
            "applications": applications,
            "links": links,
            "payments": attempts.len(),
            "pendingCashouts": pending_cashouts,
            "disputes": disputes,
            "activeTestTokens": tokens,
            "fakeCustomerAccounts": accounts.len(),
        },
        "byCurrency": by_currency_json,
        "money": {
            "available": money(Some(available)),
            "checkpoint": money(Some(checkpoint)),
            "charged": money(Some(sum_decimals(attempts.iter().map(|attempt| attempt.total_charged)))),
            "settled": money(Some(sum_decimals(attempts.iter().map(|attempt| attempt.settled)))),
            "fees": money(Some(sum_decimals(attempts.iter().map(|attempt| attempt.fee)))),
            "commission": money(Some(sum_decimals(attempts.iter().map(|attempt| attempt.commission)))),
            "net": money(Some(sum_decimals(attempts.iter().map(|attempt| attempt.net)))),
            "charged24h": money(Some(sum_decimals(recent24.iter().map(|attempt| attempt.total_charged)))),
            "settled24h": money(Some(sum_decimals(recent24.iter().map(|attempt| attempt.settled)))),
        },
        "statusCounts": count_map(status_counts.into_iter().collect()),
        "wallets": selected_wallets.iter().map(|wallet| {
            let amount = selected_amounts.iter().find(|amount| amount.wallet_id == wallet.0);
            json!({
                "id": wallet.0,
                "name": wallet.1,
                "currency": wallet.2,
                "status": wallet.3,
                "availableBalance": amount.map(|value| value.available_balance.clone()).unwrap_or_else(|| "0.0000".to_owned()),
                "checkpointBalance": amount.map(|value| value.checkpoint_balance.clone()).unwrap_or_else(|| "0.0000".to_owned()),
            })
        }).collect::<Vec<Value>>(),
        "recentPayments": recent,
        "syncAudits": audits,
    }))
}

// ---------------------------------------------------------------------------------------------
// Studio wallets
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/studio/wallets/summary`.
pub fn studio_wallets_summary<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_wallets_summary(state, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_wallets_summary(state: &AppState, merchant_id: Uuid) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let wallets = merchant_wallets(state, merchant_id).await?;
    let amounts = wallet_amounts(pool, &wallet_refs(&wallets)).await?;
    let mut by_currency: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut checkpoint_by_currency: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut status: BTreeMap<String, i64> = BTreeMap::new();
    for (index, wallet) in wallets.iter().enumerate() {
        *status.entry(wallet.3.clone()).or_default() += 1;
        *by_currency.entry(wallet.2.clone()).or_default() +=
            parse_decimal(&amounts[index].available_balance);
        *checkpoint_by_currency.entry(wallet.2.clone()).or_default() +=
            parse_decimal(&amounts[index].checkpoint_balance);
    }
    let applications: i64 =
        sqlx::query_scalar("SELECT count(*) FROM applications WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let links: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_links l JOIN applications a ON a.id = l.application_id
          WHERE a.merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let payments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM payment_attempts WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let pending_cashouts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cashout_requests
          WHERE merchant_id = $1 AND state IN ('PENDING','PROCESSING')",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    Ok(json!({
        "summary": {
            "total": wallets.len(),
            "status": count_map(status.into_iter().collect()),
            "byCurrency": by_currency.iter().map(|(currency, value)| (currency.clone(), Value::String(money(Some(*value))))).collect::<serde_json::Map<String, Value>>(),
            "checkpointByCurrency": checkpoint_by_currency.iter().map(|(currency, value)| (currency.clone(), Value::String(money(Some(*value))))).collect::<serde_json::Map<String, Value>>(),
            "applications": applications,
            "links": links,
            "payments": payments,
            "pendingCashouts": pending_cashouts,
        }
    }))
}

/// `GET /internal/sandbox/merchant/studio/wallets`.
pub fn studio_wallets<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_studio_wallets(state, request, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_wallets(
    state: &AppState,
    request: &HttpRequest,
    merchant_id: Uuid,
) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_search(&["name"])
        .with_in("status", "status")
        .with_equals("currency", "currency")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("name", "name")
        .with_sortable("currency", "currency")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("updatedAt", "updatedAt")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "w.id", ColumnKind::Uuid)
        .with("name", "w.name", ColumnKind::Text)
        .with("currency", "w.currency", ColumnKind::Text)
        .with("status", "w.status::text", ColumnKind::Text)
        .with("createdAt", "w.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "w.updated_at", ColumnKind::Timestamp);
    let mut built = build_list(request, &spec, &columns)?;
    let merchant = bind_uuid(&mut built, merchant_id);
    push_condition(&mut built, format!("w.merchant_id = {merchant}"));
    let pool = &state.pools.main;
    let sql = built.select_sql(
        "wallets w",
        &[
            "w.id",
            "w.name",
            "w.created_at",
            "w.updated_at",
            "w.currency",
            "w.status::text AS status",
            "w.gl_account_id",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(&built, "wallets w", pool)
        .await
        .map_err(support::filter_error)?;
    let wallets: Vec<WalletRow> = rows
        .iter()
        .map(|row| {
            Ok((
                row.try_get("id").map_err(support::sqlx_error)?,
                row.try_get("name").map_err(support::sqlx_error)?,
                row.try_get("currency").map_err(support::sqlx_error)?,
                row.try_get("status").map_err(support::sqlx_error)?,
                row.try_get("gl_account_id").map_err(support::sqlx_error)?,
                row.try_get("created_at").map_err(support::sqlx_error)?,
                row.try_get("updated_at").map_err(support::sqlx_error)?,
            ))
        })
        .collect::<Result<_, ApiError>>()?;
    let ids: Vec<Uuid> = wallets.iter().map(|wallet| wallet.0).collect();
    let amounts = wallet_amounts(pool, &wallet_refs(&wallets)).await?;
    let by_wallet = amount_by_wallet(&amounts);
    let counts = wallet_counts(state, &ids).await?;
    let out: Vec<Value> = wallets
        .iter()
        .map(|wallet| {
            studio_wallet_row(
                merchant_id,
                wallet,
                by_wallet.get(&wallet.0).copied(),
                &counts,
            )
        })
        .collect();
    let source_rows = cursor_rows(
        built.keyset.as_ref(),
        &rows,
        &[
            CursorColumn {
                path: "createdAt",
                column: "created_at",
                kind: FieldKind::Timestamp,
            },
            CursorColumn {
                path: "id",
                column: "id",
                kind: FieldKind::Uuid,
            },
        ],
    )?;
    Ok(list_envelope("wallets", out, total, &built, &source_rows))
}

/// `GET /internal/sandbox/merchant/studio/wallets/:walletId`.
pub fn studio_wallet_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(wallet_id) = Uuid::parse_str(&path_segment(request, 6)) else {
            return crate::http::error_response(request, wallet_not_found());
        };
        match load_studio_wallet_detail(state, merchant_id, wallet_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_wallet_detail(
    state: &AppState,
    merchant_id: Uuid,
    wallet_id: Uuid,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let wallet = sqlx::query(
        "SELECT w.id, w.name, w.merchant_id, w.currency, w.status::text AS status,
                w.gl_account_id, w.created_at, w.updated_at,
                g.id AS gl_id, g.account_type::text AS gl_account_type,
                g.currency AS gl_currency, g.shard_count::int AS gl_shard_count
           FROM wallets w JOIN gl_accounts g ON g.id = w.gl_account_id
          WHERE w.id = $1 AND w.merchant_id = $2",
    )
    .bind(wallet_id)
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(wallet) = wallet else {
        return Err(wallet_not_found());
    };
    let row: WalletRow = (
        wallet.try_get("id").map_err(support::sqlx_error)?,
        wallet.try_get("name").map_err(support::sqlx_error)?,
        wallet.try_get("currency").map_err(support::sqlx_error)?,
        wallet.try_get("status").map_err(support::sqlx_error)?,
        wallet
            .try_get("gl_account_id")
            .map_err(support::sqlx_error)?,
        wallet.try_get("created_at").map_err(support::sqlx_error)?,
        wallet.try_get("updated_at").map_err(support::sqlx_error)?,
    );
    let amounts = wallet_amounts(pool, &wallet_refs(std::slice::from_ref(&row))).await?;
    let counts = wallet_counts(state, &[wallet_id]).await?;
    let studio_row = studio_wallet_row(merchant_id, &row, amounts.first(), &counts);

    let applications = sqlx::query(
        "SELECT id, name, status::text AS status, created_at
           FROM applications WHERE assigned_wallet_id = $1 ORDER BY created_at DESC, id DESC",
    )
    .bind(wallet_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let applications = ordered_rows(&applications, WALLET_APPLICATION_FIELDS)?;
    let links = sqlx::query(
        "SELECT id, key, title, amount, currency, state::text AS state, use_count,
                confirmed_count, created_at
           FROM payment_links WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC",
    )
    .bind(wallet_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let links_json = ordered_rows(&links, WALLET_LINK_FIELDS)?;
    let cashouts = support::safe_query(format!(
        "SELECT {CASHOUT_COLUMNS} FROM cashout_requests WHERE wallet_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 20"
    ))
    .bind(wallet_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let cashouts = ordered_rows(&cashouts, CASHOUT_FIELDS)?;
    let attempts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_attempts pa JOIN payment_links l ON l.id = pa.link_id
          WHERE pa.merchant_id = $1 AND l.wallet_id = $2",
    )
    .bind(merchant_id)
    .bind(wallet_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let disputes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes d
           JOIN payment_attempts pa ON pa.id = d.attempt_id
           JOIN payment_links l ON l.id = pa.link_id
          WHERE l.wallet_id = $1",
    )
    .bind(wallet_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let pending_cashouts = cashouts
        .iter()
        .filter(|cashout| {
            matches!(
                cashout.get("state").and_then(Value::as_str),
                Some("PENDING") | Some("PROCESSING")
            )
        })
        .count();

    // `{wallet, ...row, applications, links, cashouts, attempts, disputes, pendingCashouts}`.
    let mut body = json!({
        "wallet": {
            "id": wallet.get::<Uuid, _>("id"),
            "name": wallet.get::<Option<String>, _>("name"),
            "merchantId": wallet.get::<Uuid, _>("merchant_id"),
            "currency": wallet.get::<String, _>("currency"),
            "status": wallet.get::<String, _>("status"),
            "glAccountId": wallet.get::<Uuid, _>("gl_account_id"),
            "createdAt": iso_timestamp(Some(wallet.get::<NaiveDateTime, _>("created_at"))),
            "updatedAt": iso_timestamp(Some(wallet.get::<NaiveDateTime, _>("updated_at"))),
            "glAccount": {
                "id": wallet.get::<Uuid, _>("gl_id"),
                "accountType": wallet.get::<String, _>("gl_account_type"),
                "currency": wallet.get::<String, _>("gl_currency"),
                "shardCount": wallet.get::<i32, _>("gl_shard_count"),
            },
        },
    });
    if let (Value::Object(map), Value::Object(row)) = (&mut body, studio_row) {
        for (key, value) in row {
            map.insert(key, value);
        }
        map.insert("applications".to_owned(), Value::Array(applications));
        map.insert("links".to_owned(), Value::Array(links_json));
        map.insert("cashouts".to_owned(), Value::Array(cashouts));
        map.insert("attempts".to_owned(), Value::from(attempts));
        map.insert("disputes".to_owned(), Value::from(disputes));
        map.insert(
            "pendingCashouts".to_owned(),
            Value::from(pending_cashouts as i64),
        );
    }
    Ok(body)
}

// ---------------------------------------------------------------------------------------------
// Studio applications
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/studio/applications/summary`.
pub fn studio_applications_summary<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_applications_summary(state, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_applications_summary(state: &AppState, merchant_id: Uuid) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let groups = sqlx::query(
        "SELECT status::text AS status, count(*)::bigint AS count
           FROM applications WHERE merchant_id = $1 GROUP BY status",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let mut status = Vec::with_capacity(groups.len());
    for row in &groups {
        status.push((
            row.try_get::<String, _>("status")
                .map_err(support::sqlx_error)?,
            row.try_get::<i64, _>("count")
                .map_err(support::sqlx_error)?,
        ));
    }
    let links: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_links l JOIN applications a ON a.id = l.application_id
          WHERE a.merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let payments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM payment_attempts WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let total: i64 = status.iter().map(|(_, count)| count).sum();
    Ok(json!({
        "summary": {
            "total": total,
            "status": count_map(status),
            "links": links,
            "payments": payments,
        }
    }))
}

/// `GET /internal/sandbox/merchant/studio/applications`.
pub fn studio_applications<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_studio_applications(state, request, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_applications(
    state: &AppState,
    request: &HttpRequest,
    merchant_id: Uuid,
) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_search(&["name", "businessUseDescription"])
        .with_in("status", "status")
        .with_equals("assignedWalletId", "assignedWalletId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("name", "name")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "a.id", ColumnKind::Uuid)
        .with("name", "a.name", ColumnKind::Text)
        .with(
            "businessUseDescription",
            "a.business_use_description",
            ColumnKind::Text,
        )
        .with("status", "a.status::text", ColumnKind::Text)
        .with("assignedWalletId", "a.assigned_wallet_id", ColumnKind::Uuid)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp);
    let mut built = build_list(request, &spec, &columns)?;
    let merchant = bind_uuid(&mut built, merchant_id);
    push_condition(&mut built, format!("a.merchant_id = {merchant}"));
    let pool = &state.pools.main;
    let sql = built.select_sql(
        "applications a JOIN wallets w ON w.id = a.assigned_wallet_id",
        &[
            "a.id",
            "a.created_at",
            "a.updated_at",
            "a.merchant_id",
            "a.name",
            "a.business_use_description",
            "a.expected_monthly_volume",
            "a.assigned_wallet_id",
            "a.rail_whitelist",
            "a.redirect_domain_allowlist",
            "a.status::text AS status",
            "w.name AS wallet_name",
            "w.currency AS wallet_currency",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(
        &built,
        "applications a JOIN wallets w ON w.id = a.assigned_wallet_id",
        pool,
    )
    .await
    .map_err(support::filter_error)?;
    let ids: Vec<Uuid> = rows
        .iter()
        .map(|row| row.try_get("id").map_err(support::sqlx_error))
        .collect::<Result<_, ApiError>>()?;
    let mut link_counts: HashMap<Uuid, i64> = HashMap::new();
    let mut payment_counts: HashMap<Uuid, i64> = HashMap::new();
    if !ids.is_empty() {
        for row in &sqlx::query(
            "SELECT application_id, count(*)::bigint AS count FROM payment_links
              WHERE application_id = ANY($1::uuid[]) GROUP BY application_id",
        )
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?
        {
            link_counts.insert(
                row.try_get("application_id").map_err(support::sqlx_error)?,
                row.try_get("count").map_err(support::sqlx_error)?,
            );
        }
        for row in &sqlx::query(
            "SELECT application_id, count(*)::bigint AS count FROM payment_attempts
              WHERE application_id = ANY($1::uuid[]) GROUP BY application_id",
        )
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?
        {
            payment_counts.insert(
                row.try_get("application_id").map_err(support::sqlx_error)?,
                row.try_get("count").map_err(support::sqlx_error)?,
            );
        }
    }
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut app = ordered_row(row, APPLICATION_FIELDS)?;
        let wallet = json!({
            "id": row.try_get::<Uuid, _>("assigned_wallet_id").map_err(support::sqlx_error)?,
            "name": row.try_get::<Option<String>, _>("wallet_name").map_err(support::sqlx_error)?,
            "currency": row.try_get::<String, _>("wallet_currency").map_err(support::sqlx_error)?,
        });
        if let Value::Object(map) = &mut app {
            map.insert(
                "expectedMonthlyVolume".to_owned(),
                Value::String(money(
                    map.get("expectedMonthlyVolume")
                        .and_then(Value::as_str)
                        .map(parse_decimal),
                )),
            );
            map.insert("assignedWallet".to_owned(), wallet);
            map.insert(
                "walletName".to_owned(),
                row.try_get::<Option<String>, _>("wallet_name")
                    .map_err(support::sqlx_error)?
                    .map_or(Value::Null, Value::String),
            );
            map.insert(
                "walletCurrency".to_owned(),
                Value::String(
                    row.try_get::<String, _>("wallet_currency")
                        .map_err(support::sqlx_error)?,
                ),
            );
            map.insert(
                "links".to_owned(),
                Value::from(
                    link_counts
                        .get(&row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?)
                        .copied()
                        .unwrap_or(0),
                ),
            );
            map.insert(
                "payments".to_owned(),
                Value::from(
                    payment_counts
                        .get(&row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?)
                        .copied()
                        .unwrap_or(0),
                ),
            );
        }
        out.push(app);
    }
    let source_rows = cursor_rows(
        built.keyset.as_ref(),
        &rows,
        &[
            CursorColumn {
                path: "createdAt",
                column: "created_at",
                kind: FieldKind::Timestamp,
            },
            CursorColumn {
                path: "id",
                column: "id",
                kind: FieldKind::Uuid,
            },
        ],
    )?;
    Ok(list_envelope(
        "applications",
        out,
        total,
        &built,
        &source_rows,
    ))
}

/// `GET /internal/sandbox/merchant/studio/applications/:applicationId`.
pub fn studio_application_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(application_id) = Uuid::parse_str(&path_segment(request, 6)) else {
            return crate::http::error_response(request, application_not_found());
        };
        match load_application_detail(state, merchant_id, application_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_application_detail(
    state: &AppState,
    merchant_id: Uuid,
    application_id: Uuid,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let application = support::safe_query(format!(
        "SELECT {APPLICATION_COLUMNS},
                w.id AS w_id, w.created_at AS w_created_at, w.updated_at AS w_updated_at,
                w.merchant_id AS w_merchant_id, w.gl_account_id AS w_gl_account_id,
                w.currency AS w_currency, w.name AS w_name, w.status::text AS w_status
           FROM applications a JOIN wallets w ON w.id = a.assigned_wallet_id
          WHERE a.id = $1 AND a.merchant_id = $2"
    ))
    .bind(application_id)
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(application) = application else {
        return Err(application_not_found());
    };
    let mut application_json = ordered_row(&application, APPLICATION_FIELDS)?;
    let wallet_json = json!({
        "id": application.get::<Uuid, _>("w_id"),
        "createdAt": iso_timestamp(Some(application.get::<NaiveDateTime, _>("w_created_at"))),
        "updatedAt": iso_timestamp(Some(application.get::<NaiveDateTime, _>("w_updated_at"))),
        "merchantId": application.get::<Uuid, _>("w_merchant_id"),
        "glAccountId": application.get::<Uuid, _>("w_gl_account_id"),
        "currency": application.get::<String, _>("w_currency"),
        "name": application.get::<Option<String>, _>("w_name"),
        "status": application.get::<String, _>("w_status"),
    });
    if let Value::Object(map) = &mut application_json {
        map.insert("assignedWallet".to_owned(), wallet_json.clone());
        map.insert(
            "expectedMonthlyVolume".to_owned(),
            Value::String(money(
                map.get("expectedMonthlyVolume")
                    .and_then(Value::as_str)
                    .map(parse_decimal),
            )),
        );
    }
    let links = support::safe_query(format!(
        "SELECT {LINK_COLUMNS} FROM payment_links l WHERE l.application_id = $1
          ORDER BY l.created_at DESC, l.id DESC LIMIT 50"
    ))
    .bind(application_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let links: Vec<Value> = ordered_rows(&links, LINK_FIELDS)?
        .into_iter()
        .map(|mut link| {
            if let Value::Object(map) = &mut link {
                if let Some(amount) = map.get("amount").and_then(Value::as_str) {
                    map.insert(
                        "amount".to_owned(),
                        Value::String(money(Some(parse_decimal(amount)))),
                    );
                }
            }
            link
        })
        .collect();
    let payments = sqlx::query(
        "SELECT id, reference, status::text AS status, total_charged_amount, currency, created_at
           FROM payment_attempts WHERE application_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(application_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let payments: Vec<Value> = payments
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
                "reference": row.try_get::<String, _>("reference").map_err(support::sqlx_error)?,
                "status": row.try_get::<String, _>("status").map_err(support::sqlx_error)?,
                "totalChargedAmount": money(row.try_get("total_charged_amount").map_err(support::sqlx_error)?),
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    Ok(json!({
        "application": application_json,
        "wallet": wallet_json,
        "links": links,
        "payments": payments,
    }))
}

// ---------------------------------------------------------------------------------------------
// Studio links
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/studio/links/summary`.
pub fn studio_links_summary<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let currency = resolve_reporting_currency(query_scalar(request, "currency").as_deref());
        match load_links_summary(state, merchant_id, currency).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_links_summary(
    state: &AppState,
    merchant_id: Uuid,
    currency: String,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let groups = sqlx::query(
        "SELECT l.state::text AS state, count(*)::bigint AS count
           FROM payment_links l
           JOIN applications a ON a.id = l.application_id
           JOIN wallets w ON w.id = l.wallet_id
          WHERE a.merchant_id = $1 AND w.currency = $2
          GROUP BY l.state",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let mut states = Vec::with_capacity(groups.len());
    for row in &groups {
        states.push((
            row.try_get::<String, _>("state")
                .map_err(support::sqlx_error)?,
            row.try_get::<i64, _>("count")
                .map_err(support::sqlx_error)?,
        ));
    }
    let aggregate = sqlx::query(
        "SELECT COALESCE(SUM(l.amount), 0)::text AS amount,
                COALESCE(SUM(l.use_count), 0)::bigint AS uses,
                COALESCE(SUM(l.confirmed_count), 0)::bigint AS confirmed
           FROM payment_links l
           JOIN applications a ON a.id = l.application_id
           JOIN wallets w ON w.id = l.wallet_id
          WHERE a.merchant_id = $1 AND w.currency = $2",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let by_currency_rows = sqlx::query(
        "SELECT l.currency, count(*)::bigint AS count, COALESCE(SUM(l.amount), 0)::text AS amount
           FROM payment_links l JOIN applications a ON a.id = l.application_id
          WHERE a.merchant_id = $1 GROUP BY l.currency",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let by_currency: Vec<Value> = by_currency_rows
        .iter()
        .map(|row| {
            Ok(json!({
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "count": row.try_get::<i64, _>("count").map_err(support::sqlx_error)?,
                "amount": money(Some(parse_decimal(&row.try_get::<String, _>("amount").map_err(support::sqlx_error)?))),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    let total: i64 = states.iter().map(|(_, count)| count).sum();
    Ok(json!({
        "currency": currency,
        "byCurrency": by_currency,
        "summary": {
            "total": total,
            "states": count_map(states),
            "amount": money(Some(parse_decimal(&aggregate.try_get::<String, _>("amount").map_err(support::sqlx_error)?))),
            "uses": aggregate.try_get::<i64, _>("uses").map_err(support::sqlx_error)?,
            "confirmed": aggregate.try_get::<i64, _>("confirmed").map_err(support::sqlx_error)?,
        }
    }))
}

/// `GET /internal/sandbox/merchant/studio/links`.
pub fn studio_links<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_studio_links(state, request, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_links(
    state: &AppState,
    request: &HttpRequest,
    merchant_id: Uuid,
) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_search(&["key", "title", "description"])
        .with_in("state", "state")
        .with_equals("applicationId", "applicationId")
        .with_equals("walletId", "walletId")
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("expiresAt", "expiresAt").with_keys("expiryFrom", "expiryTo"))
        .with_sortable("key", "key")
        .with_sortable("title", "title")
        .with_sortable("amount", "amount")
        .with_sortable("state", "state")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("expiresAt", "expiresAt")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "l.id", ColumnKind::Uuid)
        .with("key", "l.key", ColumnKind::Text)
        .with("title", "l.title", ColumnKind::Text)
        .with("description", "l.description", ColumnKind::Text)
        .with("amount", "l.amount", ColumnKind::Decimal)
        .with("state", "l.state::text", ColumnKind::Text)
        .with("applicationId", "l.application_id", ColumnKind::Uuid)
        .with("walletId", "l.wallet_id", ColumnKind::Uuid)
        .with("createdAt", "l.created_at", ColumnKind::Timestamp)
        .with("expiresAt", "l.expires_at", ColumnKind::Timestamp);
    let mut built = build_list(request, &spec, &columns)?;
    let merchant = bind_uuid(&mut built, merchant_id);
    push_condition(
        &mut built,
        format!("l.application_id IN (SELECT id FROM applications WHERE merchant_id = {merchant})"),
    );
    let pool = &state.pools.main;
    let sql = built.select_sql(
        "payment_links l
         JOIN applications a ON a.id = l.application_id
         JOIN wallets w ON w.id = l.wallet_id",
        &[
            "l.id",
            "l.key",
            "l.title",
            "l.description",
            "l.amount",
            "l.currency",
            "l.state::text AS state",
            "l.fee_bearer::text AS fee_bearer",
            "l.use_count",
            "l.confirmed_count",
            "l.active_locked_count",
            "l.infinite_use",
            "l.application_id",
            "a.name AS application_name",
            "l.wallet_id",
            "w.name AS wallet_name",
            "w.currency AS wallet_currency",
            "l.expires_at",
            "l.redirect_url",
            "l.rail_whitelist",
            "l.created_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(
        &built,
        "payment_links l
         JOIN applications a ON a.id = l.application_id
         JOIN wallets w ON w.id = l.wallet_id",
        pool,
    )
    .await
    .map_err(support::filter_error)?;
    let ids: Vec<Uuid> = rows
        .iter()
        .map(|row| row.try_get("id").map_err(support::sqlx_error))
        .collect::<Result<_, ApiError>>()?;
    let mut payment_counts: HashMap<Uuid, i64> = HashMap::new();
    if !ids.is_empty() {
        for row in &sqlx::query(
            "SELECT link_id, count(*)::bigint AS count FROM payment_attempts
              WHERE link_id = ANY($1::uuid[]) GROUP BY link_id",
        )
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?
        {
            payment_counts.insert(
                row.try_get("link_id").map_err(support::sqlx_error)?,
                row.try_get("count").map_err(support::sqlx_error)?,
            );
        }
    }
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(support::sqlx_error)?;
        out.push(json!({
            "id": id,
            "key": row.try_get::<String, _>("key").map_err(support::sqlx_error)?,
            "linkKey": row.try_get::<String, _>("key").map_err(support::sqlx_error)?,
            "title": row.try_get::<Option<String>, _>("title").map_err(support::sqlx_error)?,
            "description": row.try_get::<Option<String>, _>("description").map_err(support::sqlx_error)?,
            "amount": money(row.try_get("amount").map_err(support::sqlx_error)?),
            "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
            "state": row.try_get::<String, _>("state").map_err(support::sqlx_error)?,
            "feeBearer": row.try_get::<String, _>("fee_bearer").map_err(support::sqlx_error)?,
            "useCount": row.try_get::<i32, _>("use_count").map_err(support::sqlx_error)?,
            "confirmedCount": row.try_get::<i32, _>("confirmed_count").map_err(support::sqlx_error)?,
            "activeLockedCount": row.try_get::<i32, _>("active_locked_count").map_err(support::sqlx_error)?,
            "infiniteUse": row.try_get::<bool, _>("infinite_use").map_err(support::sqlx_error)?,
            "applicationId": row.try_get::<Uuid, _>("application_id").map_err(support::sqlx_error)?,
            "applicationName": row.try_get::<String, _>("application_name").map_err(support::sqlx_error)?,
            "walletId": row.try_get::<Uuid, _>("wallet_id").map_err(support::sqlx_error)?,
            "walletName": row.try_get::<Option<String>, _>("wallet_name").map_err(support::sqlx_error)?,
            "walletCurrency": row.try_get::<String, _>("wallet_currency").map_err(support::sqlx_error)?,
            "expiresAt": iso_timestamp(row.try_get("expires_at").map_err(support::sqlx_error)?),
            "redirectUrl": row.try_get::<Option<String>, _>("redirect_url").map_err(support::sqlx_error)?,
            "railWhitelist": row.try_get::<Option<Value>, _>("rail_whitelist").map_err(support::sqlx_error)?,
            "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            "payments": payment_counts.get(&id).copied().unwrap_or(0),
        }));
    }
    let source_rows = cursor_rows(
        built.keyset.as_ref(),
        &rows,
        &[
            CursorColumn {
                path: "createdAt",
                column: "created_at",
                kind: FieldKind::Timestamp,
            },
            CursorColumn {
                path: "id",
                column: "id",
                kind: FieldKind::Uuid,
            },
        ],
    )?;
    Ok(list_envelope("links", out, total, &built, &source_rows))
}

/// `GET /internal/sandbox/merchant/studio/links/:linkId`.
pub fn studio_link_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(link_id) = Uuid::parse_str(&path_segment(request, 6)) else {
            return crate::http::error_response(request, link_not_found());
        };
        match load_link_detail(state, merchant_id, link_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_link_detail(
    state: &AppState,
    merchant_id: Uuid,
    link_id: Uuid,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let link = support::safe_query(format!(
        "SELECT {LINK_COLUMNS} FROM payment_links l
           JOIN applications a ON a.id = l.application_id
          WHERE l.id = $1 AND a.merchant_id = $2"
    ))
    .bind(link_id)
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(link) = link else {
        return Err(link_not_found());
    };
    let mut link_json = ordered_row(&link, LINK_FIELDS)?;
    if let Value::Object(map) = &mut link_json {
        if let Some(amount) = map.get("amount").and_then(Value::as_str) {
            map.insert(
                "amount".to_owned(),
                Value::String(money(Some(parse_decimal(amount)))),
            );
        }
    }
    let application_id: Uuid = link
        .try_get("application_id")
        .map_err(support::sqlx_error)?;
    let wallet_id: Uuid = link.try_get("wallet_id").map_err(support::sqlx_error)?;
    let application =
        sqlx::query("SELECT id, name, status::text AS status FROM applications WHERE id = $1")
            .bind(application_id)
            .fetch_optional(pool)
            .await
            .map_err(support::sqlx_error)?;
    let application_json = application
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "name": row.get::<String, _>("name"),
                "status": row.get::<String, _>("status"),
            })
        })
        .unwrap_or(Value::Null);
    let wallet =
        sqlx::query("SELECT id, name, currency, status::text AS status FROM wallets WHERE id = $1")
            .bind(wallet_id)
            .fetch_optional(pool)
            .await
            .map_err(support::sqlx_error)?;
    let wallet_json = wallet
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "name": row.get::<Option<String>, _>("name"),
                "currency": row.get::<String, _>("currency"),
                "status": row.get::<String, _>("status"),
            })
        })
        .unwrap_or(Value::Null);
    let attempts = sqlx::query(
        "SELECT id, reference, status::text AS status, total_charged_amount, currency,
                created_at, terminal_at
           FROM payment_attempts WHERE link_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .bind(link_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let attempts: Vec<Value> = attempts
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
                "reference": row.try_get::<String, _>("reference").map_err(support::sqlx_error)?,
                "status": row.try_get::<String, _>("status").map_err(support::sqlx_error)?,
                "totalChargedAmount": money(row.try_get("total_charged_amount").map_err(support::sqlx_error)?),
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
                "terminalAt": iso_timestamp(row.try_get("terminal_at").map_err(support::sqlx_error)?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    Ok(json!({
        "link": link_json,
        "application": application_json,
        "wallet": wallet_json,
        "attempts": attempts,
    }))
}

// ---------------------------------------------------------------------------------------------
// Studio payments
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/studio/payments/summary`.
pub fn studio_payments_summary<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let currency = resolve_reporting_currency(query_scalar(request, "currency").as_deref());
        match load_payments_summary(state, merchant_id, currency).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_payments_summary(
    state: &AppState,
    merchant_id: Uuid,
    currency: String,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let groups = sqlx::query(
        "SELECT status::text AS status, count(*)::bigint AS count
           FROM payment_attempts WHERE merchant_id = $1 AND currency = $2 GROUP BY status",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let mut status = Vec::with_capacity(groups.len());
    for row in &groups {
        status.push((
            row.try_get::<String, _>("status")
                .map_err(support::sqlx_error)?,
            row.try_get::<i64, _>("count")
                .map_err(support::sqlx_error)?,
        ));
    }
    let aggregate = sqlx::query(
        "SELECT COALESCE(SUM(total_charged_amount), 0)::text AS charged,
                COALESCE(SUM(settled_amount), 0)::text AS settled,
                COALESCE(SUM(gateway_fee_amount), 0)::text AS fees,
                COALESCE(SUM(platform_commission_amount), 0)::text AS commission,
                COALESCE(SUM(net_merchant_amount), 0)::text AS net
           FROM payment_attempts WHERE merchant_id = $1 AND currency = $2",
    )
    .bind(merchant_id)
    .bind(&currency)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let by_currency_rows = sqlx::query(
        "SELECT currency,
                SUM(total_charged_amount)::text AS charged,
                SUM(settled_amount)::text AS settled,
                SUM(gateway_fee_amount)::text AS fees,
                SUM(platform_commission_amount)::text AS commission,
                SUM(net_merchant_amount)::text AS net
           FROM payment_attempts WHERE merchant_id = $1 GROUP BY currency",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let by_currency: Vec<Value> = by_currency_rows
        .iter()
        .map(|row| {
            Ok(json!({
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "charged": money(row.try_get::<Option<String>, _>("charged").map_err(support::sqlx_error)?.as_deref().map(parse_decimal)),
                "settled": money(row.try_get::<Option<String>, _>("settled").map_err(support::sqlx_error)?.as_deref().map(parse_decimal)),
                "fees": money(row.try_get::<Option<String>, _>("fees").map_err(support::sqlx_error)?.as_deref().map(parse_decimal)),
                "commission": money(row.try_get::<Option<String>, _>("commission").map_err(support::sqlx_error)?.as_deref().map(parse_decimal)),
                "net": money(row.try_get::<Option<String>, _>("net").map_err(support::sqlx_error)?.as_deref().map(parse_decimal)),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    let total: i64 = status.iter().map(|(_, count)| count).sum();
    let amount = |key: &str| {
        aggregate
            .try_get::<Option<String>, _>(key)
            .map_err(support::sqlx_error)
            .map(|value| money(value.as_deref().map(parse_decimal)))
    };
    Ok(json!({
        "currency": currency,
        "byCurrency": by_currency,
        "summary": {
            "total": total,
            "status": count_map(status),
            "charged": amount("charged")?,
            "settled": amount("settled")?,
            "fees": amount("fees")?,
            "commission": amount("commission")?,
            "net": amount("net")?,
        }
    }))
}

/// `GET /internal/sandbox/merchant/studio/payments`.
pub fn studio_payments<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_studio_payments(state, request, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_payments(
    state: &AppState,
    request: &HttpRequest,
    merchant_id: Uuid,
) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_search(&["reference"])
        .with_in("status", "status")
        .with_equals("railId", "railId")
        .with_equals("applicationId", "applicationId")
        .with_equals("linkId", "linkId")
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_range(RangeFilter::new(
            "commission",
            "commission",
            RangeKind::Decimal,
        ))
        .with_range(RangeFilter::new("net", "net", RangeKind::Decimal))
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("confirmedAt", "confirmedAt").with_keys("dateFrom", "dateTo"))
        .with_sortable("reference", "reference")
        .with_sortable("amount", "amount")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("confirmedAt", "confirmedAt")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "pa.id", ColumnKind::Uuid)
        .with("reference", "pa.reference", ColumnKind::Text)
        .with("status", "pa.status::text", ColumnKind::Text)
        .with("railId", "pa.rail_id", ColumnKind::Uuid)
        .with("applicationId", "pa.application_id", ColumnKind::Uuid)
        .with("linkId", "pa.link_id", ColumnKind::Uuid)
        .with("amount", "pa.total_charged_amount", ColumnKind::Decimal)
        .with(
            "commission",
            "pa.platform_commission_amount",
            ColumnKind::Decimal,
        )
        .with("net", "pa.net_merchant_amount", ColumnKind::Decimal)
        .with("createdAt", "pa.created_at", ColumnKind::Timestamp)
        .with("confirmedAt", "pa.terminal_at", ColumnKind::Timestamp);
    let mut built = build_list(request, &spec, &columns)?;
    let merchant = bind_uuid(&mut built, merchant_id);
    push_condition(&mut built, format!("pa.merchant_id = {merchant}"));
    let pool = &state.pools.main;
    let sql = built.select_sql(
        "payment_attempts pa
         JOIN payment_links l ON l.id = pa.link_id
         JOIN applications a ON a.id = pa.application_id
         JOIN rails r ON r.id = pa.rail_id
         JOIN gateway_versions gv ON gv.id = pa.gateway_version_id
         JOIN gateways g ON g.id = gv.gateway_id",
        &[
            "pa.id",
            "pa.reference",
            "pa.created_at",
            "pa.terminal_at",
            "pa.updated_at",
            "pa.status::text AS status",
            "pa.substatus",
            "pa.mode",
            "pa.sub_mode",
            "pa.env::text AS env",
            "pa.rail_id",
            "r.code AS rail_code",
            "COALESCE(NULLIF(r.name_en, ''), r.name_ar, '') AS rail_name",
            "g.code AS gateway_code",
            "g.name AS gateway_name",
            "pa.application_id",
            "a.name AS application_name",
            "pa.link_id",
            "l.key AS link_key",
            "l.title AS link_title",
            "l.wallet_id",
            "pa.requested_amount",
            "pa.surcharge_amount",
            "pa.total_charged_amount",
            "pa.settled_amount",
            "pa.gateway_fee_amount",
            "pa.platform_commission_amount",
            "pa.net_merchant_amount",
            "pa.provider_reference",
            "pa.network_reference",
            "pa.fee_bearer::text AS fee_bearer",
            "pa.settlement_target::text AS settlement_target",
            "pa.currency",
            "pa.expires_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(
        &built,
        "payment_attempts pa
         JOIN payment_links l ON l.id = pa.link_id
         JOIN applications a ON a.id = pa.application_id
         JOIN rails r ON r.id = pa.rail_id
         JOIN gateway_versions gv ON gv.id = pa.gateway_version_id
         JOIN gateways g ON g.id = gv.gateway_id",
        pool,
    )
    .await
    .map_err(support::filter_error)?;
    let ids: Vec<Uuid> = rows
        .iter()
        .map(|row| row.try_get("id").map_err(support::sqlx_error))
        .collect::<Result<_, ApiError>>()?;
    let mut refunds: HashMap<Uuid, Decimal> = HashMap::new();
    if !ids.is_empty() {
        for row in &sqlx::query(
            "SELECT source_attempt_id, SUM(amount)::text AS total FROM adjustments
              WHERE source_attempt_id = ANY($1::uuid[]) AND type = 'REFUND'
                AND state IN ('EXECUTED','EXECUTING')
              GROUP BY source_attempt_id",
        )
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?
        {
            refunds.insert(
                row.try_get("source_attempt_id")
                    .map_err(support::sqlx_error)?,
                parse_decimal(
                    &row.try_get::<String, _>("total")
                        .map_err(support::sqlx_error)?,
                ),
            );
        }
    }
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(support::sqlx_error)?;
        out.push(json!({
            "id": id,
            "reference": row.try_get::<String, _>("reference").map_err(support::sqlx_error)?,
            "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            "terminalAt": iso_timestamp(row.try_get("terminal_at").map_err(support::sqlx_error)?),
            "updatedAt": iso_timestamp(row.try_get("updated_at").map_err(support::sqlx_error)?),
            "status": row.try_get::<String, _>("status").map_err(support::sqlx_error)?,
            "substatus": row.try_get::<Option<String>, _>("substatus").map_err(support::sqlx_error)?,
            "mode": row.try_get::<String, _>("mode").map_err(support::sqlx_error)?,
            "subMode": row.try_get::<Option<String>, _>("sub_mode").map_err(support::sqlx_error)?,
            "env": row.try_get::<String, _>("env").map_err(support::sqlx_error)?,
            "railId": row.try_get::<Uuid, _>("rail_id").map_err(support::sqlx_error)?,
            "railCode": row.try_get::<String, _>("rail_code").map_err(support::sqlx_error)?,
            "railName": row.try_get::<String, _>("rail_name").map_err(support::sqlx_error)?,
            "gatewayCode": row.try_get::<String, _>("gateway_code").map_err(support::sqlx_error)?,
            "gatewayName": row.try_get::<String, _>("gateway_name").map_err(support::sqlx_error)?,
            "applicationId": row.try_get::<Uuid, _>("application_id").map_err(support::sqlx_error)?,
            "applicationName": row.try_get::<String, _>("application_name").map_err(support::sqlx_error)?,
            "linkId": row.try_get::<Uuid, _>("link_id").map_err(support::sqlx_error)?,
            "linkKey": row.try_get::<String, _>("link_key").map_err(support::sqlx_error)?,
            "linkTitle": row.try_get::<Option<String>, _>("link_title").map_err(support::sqlx_error)?,
            "walletId": row.try_get::<Uuid, _>("wallet_id").map_err(support::sqlx_error)?,
            "requestedAmount": money(row.try_get("requested_amount").map_err(support::sqlx_error)?),
            "surchargeAmount": money(row.try_get("surcharge_amount").map_err(support::sqlx_error)?),
            "totalChargedAmount": money(row.try_get("total_charged_amount").map_err(support::sqlx_error)?),
            "settledAmount": optional_amount(row.try_get("settled_amount").map_err(support::sqlx_error)?),
            "gatewayFeeAmount": optional_amount(row.try_get("gateway_fee_amount").map_err(support::sqlx_error)?),
            "platformCommissionAmount": money(row.try_get("platform_commission_amount").map_err(support::sqlx_error)?),
            "netMerchantAmount": money(row.try_get("net_merchant_amount").map_err(support::sqlx_error)?),
            "refundedAmount": money(refunds.get(&id).copied()),
            "providerReference": row.try_get::<Option<String>, _>("provider_reference").map_err(support::sqlx_error)?,
            "networkReference": row.try_get::<Option<String>, _>("network_reference").map_err(support::sqlx_error)?,
            "feeBearer": row.try_get::<String, _>("fee_bearer").map_err(support::sqlx_error)?,
            "settlementTarget": row.try_get::<String, _>("settlement_target").map_err(support::sqlx_error)?,
            "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
            "expiresAt": iso_timestamp(row.try_get("expires_at").map_err(support::sqlx_error)?),
        }));
    }
    let source_rows = cursor_rows(
        built.keyset.as_ref(),
        &rows,
        &[
            CursorColumn {
                path: "createdAt",
                column: "created_at",
                kind: FieldKind::Timestamp,
            },
            CursorColumn {
                path: "id",
                column: "id",
                kind: FieldKind::Uuid,
            },
        ],
    )?;
    Ok(list_envelope("payments", out, total, &built, &source_rows))
}

// ---------------------------------------------------------------------------------------------
// Studio tokens
// ---------------------------------------------------------------------------------------------

/// `GET /internal/sandbox/merchant/studio/tokens/summary`.
pub fn studio_tokens_summary<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_tokens_summary(state, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_tokens_summary(state: &AppState, merchant_id: Uuid) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens WHERE merchant_id = $1 AND env = 'SANDBOX'",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens
          WHERE merchant_id = $1 AND env = 'SANDBOX' AND revoked_at IS NULL",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let revoked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens
          WHERE merchant_id = $1 AND env = 'SANDBOX' AND revoked_at IS NOT NULL",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let expiring: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens
          WHERE merchant_id = $1 AND env = 'SANDBOX' AND revoked_at IS NULL
            AND expires_at <= now() + interval '7 days'",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    Ok(json!({
        "summary": {
            "total": total,
            "active": active,
            "revoked": revoked,
            "expiring": expiring,
        }
    }))
}

/// `GET /internal/sandbox/merchant/studio/tokens`.
pub fn studio_tokens<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_studio_tokens(state, request, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_studio_tokens(
    state: &AppState,
    request: &HttpRequest,
    merchant_id: Uuid,
) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_search(&["name", "lastFour"])
        .with_boolean("ipWhitelistEnabled", "ipWhitelistEnabled")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("lastUsedAt", "lastUsedAt").with_keys("lastFrom", "lastTo"))
        .with_sortable("name", "name")
        .with_sortable("lastUsedAt", "lastUsedAt")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "t.id", ColumnKind::Uuid)
        .with("name", "t.name", ColumnKind::Text)
        .with("lastFour", "t.last_four", ColumnKind::Text)
        .with(
            "ipWhitelistEnabled",
            "t.ip_whitelist_enabled",
            ColumnKind::Bool,
        )
        .with("createdAt", "t.created_at", ColumnKind::Timestamp)
        .with("lastUsedAt", "t.last_used_at", ColumnKind::Timestamp);
    let mut built = build_list(request, &spec, &columns)?;
    let merchant = bind_uuid(&mut built, merchant_id);
    push_condition(&mut built, format!("t.merchant_id = {merchant}"));
    push_condition(&mut built, "t.env = 'SANDBOX'".to_owned());
    match query_trimmed(request, "status")
        .unwrap_or_default()
        .to_ascii_uppercase()
        .as_str()
    {
        "ACTIVE" => push_condition(&mut built, "t.revoked_at IS NULL".to_owned()),
        "REVOKED" => push_condition(&mut built, "t.revoked_at IS NOT NULL".to_owned()),
        "EXPIRING" => push_condition(
            &mut built,
            "t.revoked_at IS NULL AND t.expires_at <= now() + interval '7 days'".to_owned(),
        ),
        _ => {}
    }
    let pool = &state.pools.main;
    let sql = built.select_sql(
        "access_tokens t JOIN applications a ON a.id = t.application_id",
        &[
            "t.id",
            "t.name",
            "t.last_four",
            "t.application_id",
            "a.name AS application_name",
            "t.scopes",
            "t.expires_at",
            "t.revoked_at",
            "t.last_used_at",
            "t.ip_whitelist_enabled",
            "t.created_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(
        &built,
        "access_tokens t JOIN applications a ON a.id = t.application_id",
        pool,
    )
    .await
    .map_err(support::filter_error)?;
    let ids: Vec<Uuid> = rows
        .iter()
        .map(|row| row.try_get("id").map_err(support::sqlx_error))
        .collect::<Result<_, ApiError>>()?;
    let mut cidrs: HashMap<Uuid, Vec<String>> = HashMap::new();
    if !ids.is_empty() {
        for row in &sqlx::query(
            "SELECT token_id, cidr FROM access_token_ips
              WHERE token_id = ANY($1::uuid[]) ORDER BY created_at, cidr",
        )
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?
        {
            cidrs
                .entry(row.try_get("token_id").map_err(support::sqlx_error)?)
                .or_default()
                .push(row.try_get("cidr").map_err(support::sqlx_error)?);
        }
    }
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(support::sqlx_error)?;
        out.push(json!({
            "id": id,
            "name": row.try_get::<String, _>("name").map_err(support::sqlx_error)?,
            "lastFour": row.try_get::<String, _>("last_four").map_err(support::sqlx_error)?,
            "applicationId": row.try_get::<Uuid, _>("application_id").map_err(support::sqlx_error)?,
            "applicationName": row.try_get::<String, _>("application_name").map_err(support::sqlx_error)?,
            "scopes": row.try_get::<Value, _>("scopes").map_err(support::sqlx_error)?,
            "expiresAt": iso_timestamp(row.try_get("expires_at").map_err(support::sqlx_error)?),
            "revokedAt": iso_timestamp(row.try_get("revoked_at").map_err(support::sqlx_error)?),
            "lastUsedAt": iso_timestamp(row.try_get("last_used_at").map_err(support::sqlx_error)?),
            "ipWhitelistEnabled": row.try_get::<bool, _>("ip_whitelist_enabled").map_err(support::sqlx_error)?,
            "allowedCidrs": cidrs.get(&id).cloned().unwrap_or_default(),
            "createdAt": iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
        }));
    }
    let source_rows = cursor_rows(
        built.keyset.as_ref(),
        &rows,
        &[
            CursorColumn {
                path: "createdAt",
                column: "created_at",
                kind: FieldKind::Timestamp,
            },
            CursorColumn {
                path: "id",
                column: "id",
                kind: FieldKind::Uuid,
            },
        ],
    )?;
    Ok(list_envelope("tokens", out, total, &built, &source_rows))
}

/// `GET /internal/sandbox/merchant/studio/tokens/:tokenId`.
pub fn studio_token_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let (merchant_id, _) = match context(state, request, principal_ref) {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let Ok(token_id) = Uuid::parse_str(&path_segment(request, 6)) else {
            return crate::http::error_response(request, token_not_found());
        };
        match load_token_detail(state, merchant_id, token_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_token_detail(
    state: &AppState,
    merchant_id: Uuid,
    token_id: Uuid,
) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let token = sqlx::query(
        "SELECT t.id, t.name, t.last_four, t.application_id,
                a.name AS application_name, a.id AS application_id_a,
                t.scopes, t.expires_at, t.revoked_at, t.last_used_at,
                t.ip_whitelist_enabled, t.created_at
           FROM access_tokens t JOIN applications a ON a.id = t.application_id
          WHERE t.id = $1 AND t.merchant_id = $2 AND t.env = 'SANDBOX'",
    )
    .bind(token_id)
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(token) = token else {
        return Err(token_not_found());
    };
    let cidrs: Vec<String> = sqlx::query_scalar(
        "SELECT cidr FROM access_token_ips WHERE token_id = $1 ORDER BY created_at, cidr",
    )
    .bind(token_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    Ok(json!({
        "token": {
            "id": token.get::<Uuid, _>("id"),
            "name": token.get::<String, _>("name"),
            "lastFour": token.get::<String, _>("last_four"),
            "applicationName": token.get::<String, _>("application_name"),
            "scopes": token.get::<Value, _>("scopes"),
            "expiresAt": iso_timestamp(token.try_get("expires_at").map_err(support::sqlx_error)?),
            "revokedAt": iso_timestamp(token.try_get("revoked_at").map_err(support::sqlx_error)?),
            "lastUsedAt": iso_timestamp(token.try_get("last_used_at").map_err(support::sqlx_error)?),
            "ipWhitelistEnabled": token.get::<bool, _>("ip_whitelist_enabled"),
            "allowedCidrs": cidrs,
            "createdAt": iso_timestamp(token.try_get("created_at").map_err(support::sqlx_error)?),
        }
    }))
}
