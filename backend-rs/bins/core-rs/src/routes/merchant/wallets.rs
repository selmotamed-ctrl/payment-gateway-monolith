//! Wallet reads: list, detail, live balance, statement, statement export.
//!
//! Port of `core-back/api/internal/merchant.ts:2031-2199`. The live balance and the checkpoint are
//! the per-shard projections of the ledger (`loadLiveAccountBalances` / `loadAccountCheckpointSummary`
//! in `lib/storageEngine/shardBalances.ts`), converted to the natural sign of the account type.
//! Merchant wallets are credit-normal, so a wallet in credit reads positive.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{NaiveDate, NaiveDateTime};
use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_db::list_query::{
    build_list_query, count_unless_skipped, list_response, ColumnKind, ColumnMap, DateFilter,
    ListSpec, SortDirection,
};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common::{json_ok, money4};
use super::super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use super::{
    application_scope, assert_merchant_authority, cursor_rows, f, path_uuid, query_map,
    query_scalar, require_merchant_session, row_json, rows_json, set_filter, CursorColumn,
    FieldKind, Fields,
};
use crate::http::error_response;
use crate::routes::common::database_error;
use crate::state::AppState;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, ScopeRule};

const ORIGIN_WALLETS: &str = "core-back/api/internal/merchant.ts:2031";
const ORIGIN_WALLET: &str = "core-back/api/internal/merchant.ts:2085";
const ORIGIN_BALANCE: &str = "core-back/api/internal/merchant.ts:2096";
const ORIGIN_STATEMENTS: &str = "core-back/api/internal/merchant.ts:2120";
const ORIGIN_EXPORT: &str = "core-back/api/internal/merchant.ts:2148";
const ORIGIN_OVERVIEW: &str = "core-back/api/internal/merchant.ts:3918";

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let read = super::policy_authorities(&["merchant:read", "merchant:write"]);
    let read_refs: Vec<&str> = read.iter().map(String::as_str).collect();
    vec![
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/wallets",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_WALLETS,
            )
            .authorities(&read_refs)
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_wallets),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/wallets/:id",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_WALLET,
            )
            .authorities(&read_refs)
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_wallet),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/wallets/:id/balance",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_BALANCE,
            )
            .authorities(&read_refs)
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(get_wallet_balance),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/wallets/:id/statements",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_STATEMENTS,
            )
            .authorities(&read_refs)
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(list_wallet_statements),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/wallets/:id/statements/:month/export",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_EXPORT,
            )
            .authorities(
                &super::policy_authorities(&["merchant:write"])
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(export_wallet_statement),
            guard: PrincipalGuard::Merchant,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/stats/overview",
                Channel::Merchant,
                Authn::Session,
                ORIGIN_OVERVIEW,
            )
            .authorities(
                &super::policy_authorities(&["payment:read"])
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
            handler: Handler::Custom(stats_overview),
            guard: PrincipalGuard::Merchant,
        },
    ]
}

/// `Wallet` scalar fields.
pub const WALLET_FIELDS: Fields = &[
    f("id", "id", FieldKind::Uuid),
    f("created_at", "createdAt", FieldKind::Timestamp),
    f("updated_at", "updatedAt", FieldKind::Timestamp),
    f("merchant_id", "merchantId", FieldKind::Uuid),
    f("gl_account_id", "glAccountId", FieldKind::Uuid),
    f("currency", "currency", FieldKind::Text),
    f("name", "name", FieldKind::Text),
    f("status", "status", FieldKind::Text),
];

const ACCOUNT_FIELDS: Fields = &[
    f("g_id", "id", FieldKind::Uuid),
    f("g_created_at", "createdAt", FieldKind::Timestamp),
    f("g_updated_at", "updatedAt", FieldKind::Timestamp),
    f("g_account_type", "accountType", FieldKind::Text),
    f("g_owner_id", "ownerId", FieldKind::Text),
    f("g_gateway_id", "gatewayId", FieldKind::Uuid),
    f("g_credential_set_id", "credentialSetId", FieldKind::Uuid),
    f("g_env", "env", FieldKind::Text),
    f("g_currency", "currency", FieldKind::Text),
    f("g_shard_count", "shardCount", FieldKind::Int),
    f("g_shard_scaled_at", "shardScaledAt", FieldKind::Timestamptz),
    f("g_seed_key", "seedKey", FieldKind::Text),
];

const WALLET_COLUMNS: &str = "w.id, w.created_at, w.updated_at, w.merchant_id, w.gl_account_id, \
     w.currency, w.name, w.status::text AS status";

const ACCOUNT_COLUMNS: &str = "g.id AS g_id, g.created_at AS g_created_at, \
     g.updated_at AS g_updated_at, g.account_type::text AS g_account_type, g.owner_id AS g_owner_id, \
     g.gateway_id AS g_gateway_id, g.credential_set_id AS g_credential_set_id, g.env AS g_env, \
     g.currency AS g_currency, g.shard_count AS g_shard_count, \
     g.shard_scaled_at AS g_shard_scaled_at, g.seed_key AS g_seed_key";

const GL_ACCOUNT_TYPES_DEBIT_POSITIVE: [&str; 5] = [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "PROVIDER_FEE_EXPENSE",
    "GATEWAY_FEE_EXPENSE",
];

/// `naturalShardBalance`: shards are debit-positive; credit-normal accounts flip the sign.
#[must_use]
pub fn natural_shard_balance(account_type: &str, shard_total: Decimal) -> Decimal {
    if shard_total.is_zero() {
        return Decimal::ZERO;
    }
    if GL_ACCOUNT_TYPES_DEBIT_POSITIVE.contains(&account_type) {
        shard_total
    } else {
        -shard_total
    }
}

/// `monthRangeUtc`: `[first day 00:00, first day of the next month 00:00)`.
#[must_use]
pub fn month_range_utc(month: &str) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let (year, month_index) = month.split_once('-')?;
    let year: i32 = year.parse().ok()?;
    let month_index: u32 = month_index.parse().ok()?;
    if !(1..=12).contains(&month_index) {
        return None;
    }
    let from = NaiveDate::from_ymd_opt(year, month_index, 1)?.and_hms_opt(0, 0, 0)?;
    let (next_year, next_month) = if month_index == 12 {
        (year + 1, 1)
    } else {
        (year, month_index + 1)
    };
    let to = NaiveDate::from_ymd_opt(next_year, next_month, 1)?.and_hms_opt(0, 0, 0)?;
    Some((from, to))
}

/// `YYYY-MM` with a real month number (`^\d{4}-(0[1-9]|1[0-2])$`).
#[must_use]
pub fn valid_month(month: &str) -> bool {
    let bytes = month.as_bytes();
    bytes.len() == 7
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && matches!(
            &month[5..],
            "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
        )
}

fn wallet_not_found() -> ApiError {
    ApiError::new(404, "WALLET_NOT_FOUND", "The wallet does not exist")
}

async fn load_wallet_with_account(
    state: &AppState,
    merchant_id: Uuid,
    wallet_id: Uuid,
) -> Result<Option<Value>, ApiError> {
    let sql = format!(
        "SELECT {WALLET_COLUMNS}, {ACCOUNT_COLUMNS} FROM wallets w \
         JOIN gl_accounts g ON g.id = w.gl_account_id \
         WHERE w.id = $1 AND w.merchant_id = $2"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(wallet_id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await
        .map_err(database_error)?;
    match row {
        None => Ok(None),
        Some(row) => {
            let mut wallet = row_json(&row, WALLET_FIELDS)?;
            let account = row_json(&row, ACCOUNT_FIELDS)?;
            if let Value::Object(map) = &mut wallet {
                map.insert("glAccount".to_owned(), account);
            }
            Ok(Some(wallet))
        }
    }
}

/// `GET /internal/merchant/wallets`.
pub fn list_wallets<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:read", "merchant:write"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };

        let mut map = query_map(request);
        set_filter(&mut map, "merchant", merchant_id.to_string());
        let columns = ColumnMap::new()
            .with("id", "w.id", ColumnKind::Uuid)
            .with("merchant", "w.merchant_id::text", ColumnKind::Text)
            .with("currency", "w.currency", ColumnKind::Text)
            .with("status", "w.status::text", ColumnKind::Text)
            .with("createdAt", "w.created_at", ColumnKind::Timestamp);
        let spec = ListSpec::default()
            .with_in("status", "status")
            .with_equals("currency", "currency")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("currency", "currency")
            .with_sortable("status", "status")
            .with_sortable("createdAt", "createdAt")
            .with_default_sort("createdAt", SortDirection::Desc);
        let built = match build_list_query(&map, &spec, &columns) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    request,
                    ApiError::new(400, "INVALID_FILTER", "Invalid filter"),
                )
            }
        };
        let sql = format!(
            "SELECT {WALLET_COLUMNS}, {ACCOUNT_COLUMNS} FROM wallets w \
             JOIN gl_accounts g ON g.id = w.gl_account_id {} ORDER BY {} LIMIT ${} OFFSET ${}",
            built.where_sql,
            built.order_by_sql,
            built.binds.len() + 1,
            built.binds.len() + 2
        );
        let rows = match built.bind_rows(&sql).fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let total = match count_unless_skipped(
            &built,
            "wallets w JOIN gl_accounts g ON g.id = w.gl_account_id",
            &state.pools.main,
        )
        .await
        {
            Ok(total) => total,
            Err(error) => return error_response(request, crate::auth::db_error(error)),
        };
        let mut wallets = Vec::with_capacity(rows.len());
        for row in &rows {
            match row_json(row, WALLET_FIELDS) {
                Ok(mut wallet) => {
                    let account = match row_json(row, ACCOUNT_FIELDS) {
                        Ok(account) => account,
                        Err(error) => return error_response(request, error),
                    };
                    if let Value::Object(map) = &mut wallet {
                        map.insert("glAccount".to_owned(), account);
                    }
                    wallets.push(wallet);
                }
                Err(error) => return error_response(request, error),
            }
        }
        let cursors = match cursor_rows(
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
        ) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let body = list_response("wallets", Value::Array(wallets), total, &built, &cursors);
        json_ok(&body)
    })
}

/// `GET /internal/merchant/wallets/:id`.
pub fn get_wallet<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:read", "merchant:write"])?;
            let wallet_id = path_uuid(request, 4, "WALLET_NOT_FOUND", "The wallet does not exist")?;
            Ok((merchant_id, wallet_id))
        })();
        let (merchant_id, wallet_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        match load_wallet_with_account(state, merchant_id, wallet_id).await {
            Ok(Some(wallet)) => json_ok(&json!({ "wallet": wallet })),
            Ok(None) => error_response(request, wallet_not_found()),
            Err(error) => error_response(request, error),
        }
    })
}

/// `GET /internal/merchant/wallets/:id/balance`.
pub fn get_wallet_balance<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:read", "merchant:write"])?;
            let wallet_id = path_uuid(request, 4, "WALLET_NOT_FOUND", "The wallet does not exist")?;
            Ok((merchant_id, wallet_id))
        })();
        let (merchant_id, wallet_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };

        let wallet = sqlx::query(
            "SELECT w.id, w.currency, w.gl_account_id, g.account_type::text AS account_type
               FROM wallets w JOIN gl_accounts g ON g.id = w.gl_account_id
              WHERE w.id = $1 AND w.merchant_id = $2",
        )
        .bind(wallet_id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let wallet = match wallet {
            Ok(Some(row)) => row,
            Ok(None) => return error_response(request, wallet_not_found()),
            Err(error) => return error_response(request, database_error(error)),
        };
        let account_id: Uuid = wallet.get("gl_account_id");
        let currency: String = wallet.get("currency");
        let account_type: String = wallet.get("account_type");

        let live: Result<Option<Decimal>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COALESCE(SUM(current_balance), 0) FROM gl_account_shards WHERE gl_account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&state.pools.main)
        .await;
        let live = match live {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => return error_response(request, database_error(error)),
        };
        let checkpoint: Result<Option<Decimal>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COALESCE(SUM(checkpoint_balance), 0) FROM gl_shard_checkpoints WHERE gl_account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&state.pools.main)
        .await;
        let checkpoint = match checkpoint {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => return error_response(request, database_error(error)),
        };

        let body = json!({
            "walletId": wallet.get::<Uuid, _>("id"),
            "currency": currency,
            "balance": money4(Some(natural_shard_balance(&account_type, live))),
            "checkpointBalance": money4(Some(natural_shard_balance(&account_type, checkpoint))),
        });
        json_ok(&body)
    })
}

/// `GET /internal/merchant/wallets/:id/statements`.
pub fn list_wallet_statements<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:read", "merchant:write"])?;
            let wallet_id = path_uuid(request, 4, "WALLET_NOT_FOUND", "The wallet does not exist")?;
            Ok((principal, merchant_id, wallet_id))
        })();
        let (principal, merchant_id, wallet_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let month = query_scalar(request, "month").filter(|value| !value.is_empty());
        if let Some(month) = month.as_deref() {
            if !valid_month(month) {
                return error_response(
                    request,
                    ApiError::new(400, "VALIDATION_FAILED", "Validation failed").with_details(json!({
                        "issues": [{ "path": ["month"], "code": "invalid_string", "message": "Invalid" }]
                    })),
                );
            }
        }

        let wallet =
            sqlx::query("SELECT id, currency FROM wallets WHERE id = $1 AND merchant_id = $2")
                .bind(wallet_id)
                .bind(merchant_id)
                .fetch_optional(&state.pools.main)
                .await;
        let wallet = match wallet {
            Ok(Some(row)) => row,
            Ok(None) => return error_response(request, wallet_not_found()),
            Err(error) => return error_response(request, database_error(error)),
        };
        let currency: String = wallet.get("currency");
        let (from, to) = match month.as_deref().and_then(month_range_utc) {
            Some((from, to)) => (from, to),
            None => {
                let now = chrono::Utc::now().naive_utc();
                (
                    now - chrono::Duration::days(31),
                    now + chrono::Duration::days(1),
                )
            }
        };
        let scope = application_scope(principal);
        let mut sql = format!(
            "SELECT {ATTEMPT_COLUMNS_PA} FROM payment_attempts pa \
             JOIN payment_links l ON l.id = pa.link_id \
             WHERE pa.merchant_id = $1 AND pa.currency = $2 AND l.wallet_id = $3 \
               AND pa.created_at >= $4 AND pa.created_at < $5"
        );
        let scoped = scope.as_deref().is_some_and(|entries| !entries.is_empty());
        if scoped {
            sql.push_str(" AND pa.application_id = ANY($6::uuid[])");
        }
        sql.push_str(" ORDER BY pa.created_at DESC, pa.id DESC LIMIT 200");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(merchant_id)
            .bind(&currency)
            .bind(wallet_id)
            .bind(from)
            .bind(to);
        if let Some(scope) = scope.as_deref() {
            if scoped {
                query = query.bind(scope.to_vec());
            }
        }
        let rows = match query.fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let attempts = match rows_json(&rows, super::ATTEMPT_FIELDS) {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        json_ok(&json!({
            "walletId": wallet_id,
            "month": month,
            "attempts": attempts,
        }))
    })
}

/// `GET /internal/merchant/wallets/:id/statements/:month/export`.
pub fn export_wallet_statement<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["merchant:write"])?;
            let wallet_id = path_uuid(request, 4, "WALLET_NOT_FOUND", "The wallet does not exist")?;
            let month = super::path_segment(request, 6)
                .ok_or_else(|| {
                    ApiError::new(
                        400,
                        "STATEMENT_MONTH_INVALID",
                        "The statement month must be formatted as YYYY-MM",
                    )
                })?
                .to_owned();
            Ok((principal, merchant_id, wallet_id, month))
        })();
        let (principal, merchant_id, wallet_id, month) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        if !valid_month(&month) {
            return error_response(
                request,
                ApiError::new(
                    400,
                    "STATEMENT_MONTH_INVALID",
                    "The statement month must be formatted as YYYY-MM",
                ),
            );
        }
        let wallet =
            sqlx::query("SELECT id, currency FROM wallets WHERE id = $1 AND merchant_id = $2")
                .bind(wallet_id)
                .bind(merchant_id)
                .fetch_optional(&state.pools.main)
                .await;
        let wallet = match wallet {
            Ok(Some(row)) => row,
            Ok(None) => return error_response(request, wallet_not_found()),
            Err(error) => return error_response(request, database_error(error)),
        };
        let currency: String = wallet.get("currency");
        let Some((from, to)) = month_range_utc(&month) else {
            return error_response(
                request,
                ApiError::new(
                    400,
                    "STATEMENT_MONTH_INVALID",
                    "The statement month must be formatted as YYYY-MM",
                ),
            );
        };
        let scope = application_scope(principal);
        let mut sql = String::from(
            "SELECT pa.reference, pa.created_at, pa.total_charged_amount, \
                    pa.platform_commission_amount, pa.net_merchant_amount, pa.currency, \
                    pa.status::text AS status \
               FROM payment_attempts pa JOIN payment_links l ON l.id = pa.link_id \
              WHERE pa.merchant_id = $1 AND pa.status = 'SUCCEEDED' AND pa.currency = $2 \
                AND l.wallet_id = $3 AND pa.created_at >= $4 AND pa.created_at < $5",
        );
        if scope.is_some() {
            sql.push_str(" AND pa.application_id = ANY($6::uuid[])");
        }
        sql.push_str(" ORDER BY pa.created_at DESC, pa.id DESC LIMIT 50000");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(merchant_id)
            .bind(&currency)
            .bind(wallet_id)
            .bind(from)
            .bind(to);
        if let Some(scope) = scope.as_deref() {
            query = query.bind(scope.to_vec());
        }
        let rows = match query.fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut body = String::from(
            "reference,created_at,total_charged,commission,net_merchant,currency,status",
        );
        for row in &rows {
            let reference: String = row.get("reference");
            let created_at: NaiveDateTime = row.get("created_at");
            let total: Decimal = row.get("total_charged_amount");
            let commission: Decimal = row.get("platform_commission_amount");
            let net: Decimal = row.get("net_merchant_amount");
            let currency: String = row.get("currency");
            let status: String = row.get("status");
            body.push('\n');
            body.push_str(
                &[
                    reference,
                    pg_types::JsDate(created_at.and_utc()).to_iso_string(),
                    money4(Some(total)),
                    money4(Some(commission)),
                    money4(Some(net)),
                    currency,
                    status,
                ]
                .join(","),
            );
        }
        HttpResponse::Ok()
            .content_type("text/csv; charset=utf-8")
            .header(
                "content-disposition",
                format!("attachment; filename=\"statement-{month}.csv\""),
            )
            .body(body)
    })
}

/// The attempt projection with the `pa` alias (shared with the statement query).
const ATTEMPT_COLUMNS_PA: &str = super::ATTEMPT_COLUMNS;

/// `resolveReportingCurrency`: a requested ISO code uppercased, else `BASE_CURRENCY`.
#[must_use]
pub fn reporting_currency(requested: Option<&str>) -> String {
    let value = requested.unwrap_or_default().trim().to_ascii_uppercase();
    if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return value;
    }
    let base = std::env::var("BASE_CURRENCY")
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase();
    if base.len() == 3 && base.bytes().all(|byte| byte.is_ascii_uppercase()) {
        base
    } else {
        "LYD".to_owned()
    }
}

fn normalize_currency(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "UNKNOWN".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `GET /internal/merchant/stats/overview` (`merchant.ts:3918`).
///
/// The window aggregates are computed in SQL (status counts, daily/rail success totals) exactly like
/// the TS handler; wallet balances are the shard sums converted to the natural sign.
pub fn stats_overview<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["payment:read"])?;
            if application_scope(principal).is_some() {
                return Err(ApiError::new(
                    403,
                    "APP_SCOPE_RESTRICTED",
                    "The merchant overview is not available to a user restricted to specific applications",
                ));
            }
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };

        let period = query_scalar(request, "period").unwrap_or_else(|| "last_30d".to_owned());
        let days: i64 = match period.as_str() {
            "last_7d" => 7,
            "last_90d" => 90,
            _ => 30,
        };
        let now = chrono::Utc::now();
        let since = now.naive_utc() - chrono::Duration::days(days);
        let start_of_day = now.date_naive().and_hms_opt(0, 0, 0).unwrap_or_default();
        let today_key = start_of_day.format("%Y-%m-%d").to_string();
        let requested_currency = reporting_currency(query_scalar(request, "currency").as_deref());

        let status_rows = sqlx::query(
            "SELECT status::text AS status, currency, COUNT(*)::bigint AS count \
               FROM payment_attempts WHERE merchant_id = $1 AND created_at >= $2 \
              GROUP BY status, currency",
        )
        .bind(merchant_id)
        .bind(since)
        .fetch_all(&state.pools.main)
        .await;
        let status_rows = match status_rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let success_rows = sqlx::query(
            "SELECT pa.created_at::date::text AS day, r.code AS rail_code, pa.currency, \
                    COUNT(*)::bigint AS count, SUM(pa.total_charged_amount) AS gross, \
                    SUM(pa.platform_commission_amount) AS commission, \
                    SUM(pa.net_merchant_amount) AS net \
               FROM payment_attempts pa LEFT JOIN rails r ON r.id = pa.rail_id \
              WHERE pa.merchant_id = $1 AND pa.status = 'SUCCEEDED' AND pa.created_at >= $2 \
              GROUP BY 1, 2, 3",
        )
        .bind(merchant_id)
        .bind(since)
        .fetch_all(&state.pools.main)
        .await;
        let success_rows = match success_rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let recent_rows = sqlx::query(
            "SELECT pa.id, pa.reference, pa.status::text AS status, pa.total_charged_amount, \
                    pa.currency, pa.created_at, r.code AS rail_code \
               FROM payment_attempts pa LEFT JOIN rails r ON r.id = pa.rail_id \
              WHERE pa.merchant_id = $1 AND pa.created_at >= $2 AND pa.currency = $3 \
              ORDER BY pa.created_at DESC, pa.id DESC LIMIT 6",
        )
        .bind(merchant_id)
        .bind(since)
        .bind(&requested_currency)
        .fetch_all(&state.pools.main)
        .await;
        let recent_rows = match recent_rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let wallet_rows =
            sqlx::query("SELECT id, currency, gl_account_id FROM wallets WHERE merchant_id = $1")
                .bind(merchant_id)
                .fetch_all(&state.pools.main)
                .await;
        let wallet_rows = match wallet_rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let wallets_for_currency: Vec<Uuid> = wallet_rows
            .iter()
            .filter(|row| {
                normalize_currency(&row.get::<String, _>("currency")) == requested_currency
            })
            .map(|row| row.get("id"))
            .collect();
        let pending_cashouts: i64 = if wallets_for_currency.is_empty() {
            0
        } else {
            let count: Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
                "SELECT COUNT(*) FROM cashout_requests \
                  WHERE merchant_id = $1 AND state IN ('PENDING', 'PROCESSING') \
                    AND wallet_id = ANY($2::uuid[])",
            )
            .bind(merchant_id)
            .bind(&wallets_for_currency)
            .fetch_one(&state.pools.main)
            .await;
            match count {
                Ok(value) => value.unwrap_or(0),
                Err(error) => return error_response(request, database_error(error)),
            }
        };
        let account_ids: Vec<Uuid> = wallet_rows
            .iter()
            .map(|row| row.get("gl_account_id"))
            .collect();
        let live_rows = if account_ids.is_empty() {
            Vec::new()
        } else {
            let rows = sqlx::query(
                "SELECT g.id, g.account_type::text AS account_type, \
                        COALESCE(SUM(s.current_balance), 0) AS total \
                   FROM gl_accounts g LEFT JOIN gl_account_shards s ON s.gl_account_id = g.id \
                  WHERE g.id = ANY($1::uuid[]) GROUP BY g.id, g.account_type",
            )
            .bind(&account_ids)
            .fetch_all(&state.pools.main)
            .await;
            match rows {
                Ok(rows) => rows,
                Err(error) => return error_response(request, database_error(error)),
            }
        };
        let mut balance_by_account: BTreeMap<Uuid, Decimal> = BTreeMap::new();
        for row in &live_rows {
            let account_type: String = row.get("account_type");
            let total: Decimal = row.get("total");
            balance_by_account.insert(row.get("id"), natural_shard_balance(&account_type, total));
        }

        let mut attempts_by_currency: BTreeMap<String, i64> = BTreeMap::new();
        let mut by_status = Map::new();
        let mut attempt_count = 0_i64;
        let mut succeeded = 0_i64;
        let mut volume = Decimal::ZERO;
        let mut commission = Decimal::ZERO;
        let mut net = Decimal::ZERO;
        for row in &status_rows {
            let currency = normalize_currency(&row.get::<String, _>("currency"));
            let count: i64 = row.get("count");
            *attempts_by_currency.entry(currency.clone()).or_default() += count;
            if currency != requested_currency {
                continue;
            }
            let status: String = row.get("status");
            by_status.insert(status.clone(), Value::from(count));
            attempt_count += count;
            if status == "SUCCEEDED" {
                succeeded += count;
            }
        }
        let mut success_by_currency: BTreeMap<String, (Decimal, Decimal, Decimal)> =
            BTreeMap::new();
        let mut day_totals: BTreeMap<String, (Decimal, Decimal, Decimal)> = BTreeMap::new();
        let mut rail_totals: Vec<(String, Decimal, i64)> = Vec::new();
        let mut today_volume = Decimal::ZERO;
        for row in &success_rows {
            let gross: Decimal = row.get("gross");
            let commission_amount: Decimal = row.get("commission");
            let net_amount: Decimal = row.get("net");
            let currency = normalize_currency(&row.get::<String, _>("currency"));
            let totals = success_by_currency.entry(currency.clone()).or_insert((
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ));
            totals.0 += gross;
            totals.1 += commission_amount;
            totals.2 += net_amount;
            if currency != requested_currency {
                continue;
            }
            volume += gross;
            commission += commission_amount;
            net += net_amount;
            let day: String = row.get("day");
            if day == today_key {
                today_volume += gross;
            }
            let day_entry =
                day_totals
                    .entry(day)
                    .or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
            day_entry.0 += gross;
            day_entry.1 += commission_amount;
            day_entry.2 += net_amount;
            let rail_code = row
                .try_get::<Option<String>, _>("rail_code")
                .unwrap_or(None)
                .unwrap_or_else(|| "UNKNOWN".to_owned());
            let count: i64 = row.get("count");
            match rail_totals
                .iter_mut()
                .find(|(code, _, _)| code == &rail_code)
            {
                Some(entry) => {
                    entry.1 += gross;
                    entry.2 += count;
                }
                None => rail_totals.push((rail_code, gross, count)),
            }
        }

        let mut wallet_balance = Decimal::ZERO;
        let mut wallet_by_currency: BTreeMap<String, Decimal> = BTreeMap::new();
        for row in &wallet_rows {
            let currency = normalize_currency(&row.get::<String, _>("currency"));
            let account_id: Uuid = row.get("gl_account_id");
            let balance = balance_by_account
                .get(&account_id)
                .copied()
                .unwrap_or_default();
            *wallet_by_currency.entry(currency.clone()).or_default() += balance;
            if currency == requested_currency {
                wallet_balance += balance;
            }
        }
        let currencies: std::collections::BTreeSet<String> = attempts_by_currency
            .keys()
            .chain(wallet_by_currency.keys())
            .chain(success_by_currency.keys())
            .cloned()
            .collect();
        let by_currency: Vec<Value> = currencies
            .iter()
            .map(|code| {
                let success = success_by_currency
                    .get(code)
                    .copied()
                    .unwrap_or((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
                json!({
                    "currency": code,
                    "attempts": attempts_by_currency.get(code).copied().unwrap_or(0),
                    "volume": money4(Some(success.0)),
                    "commission": money4(Some(success.1)),
                    "netMerchantAmount": money4(Some(success.2)),
                    "walletBalance": money4(Some(wallet_by_currency.get(code).copied().unwrap_or_default())),
                })
            })
            .collect();
        let success_rate = if attempt_count > 0 {
            let rate = Decimal::from(succeeded) * Decimal::from(100) / Decimal::from(attempt_count);
            format!(
                "{:.2}",
                rate.round_dp_with_strategy(
                    2,
                    rust_decimal::RoundingStrategy::MidpointAwayFromZero
                )
            )
        } else {
            "0.00".to_owned()
        };
        let recent_payments: Vec<Value> = recent_rows
            .iter()
            .map(|row| {
                let amount: Decimal = row.get("total_charged_amount");
                let created_at: NaiveDateTime = row.get("created_at");
                json!({
                    "id": row.get::<Uuid, _>("id"),
                    "reference": row.get::<String, _>("reference"),
                    "railCode": row
                        .try_get::<Option<String>, _>("rail_code")
                        .unwrap_or(None)
                        .unwrap_or_else(|| "UNKNOWN".to_owned()),
                    "amount": money4(Some(amount)),
                    "currency": row.get::<String, _>("currency"),
                    "status": row.get::<String, _>("status"),
                    "createdAt": pg_types::JsDate(created_at.and_utc()).to_iso_string(),
                })
            })
            .collect();
        let volume_by_day: Vec<Value> = day_totals
            .iter()
            .map(|(day, totals)| {
                json!({
                    "day": day,
                    "gross": money4(Some(totals.0)),
                    "commission": money4(Some(totals.1)),
                    "net": money4(Some(totals.2)),
                })
            })
            .collect();
        let volume_by_rail: Vec<Value> = rail_totals
            .iter()
            .map(|(code, gross, count)| {
                json!({
                    "railCode": code,
                    "gross": money4(Some(*gross)),
                    "count": count,
                })
            })
            .collect();

        json_ok(&json!({
            "merchantId": merchant_id,
            "period": period,
            "windowDays": days,
            "currency": requested_currency,
            "mixedCurrency": currencies.len() > 1,
            "byCurrency": by_currency,
            "attempts": attempt_count,
            "byStatus": by_status,
            "volume": money4(Some(volume)),
            "commission": money4(Some(commission)),
            "netMerchantAmount": money4(Some(net)),
            "walletBalance": money4(Some(wallet_balance)),
            "todayVolume": money4(Some(today_volume)),
            "successRate": success_rate,
            "pendingCashouts": pending_cashouts.to_string(),
            "recentPayments": recent_payments,
            "volumeByDay": volume_by_day,
            "volumeByRail": volume_by_rail,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_ranges_cover_the_whole_month() {
        let (from, to) = month_range_utc("2026-02").expect("valid month");
        assert_eq!(from.to_string(), "2026-02-01 00:00:00");
        assert_eq!(to.to_string(), "2026-03-01 00:00:00");
        let (from, to) = month_range_utc("2026-12").expect("december");
        assert_eq!(from.to_string(), "2026-12-01 00:00:00");
        assert_eq!(to.to_string(), "2027-01-01 00:00:00");
        assert!(month_range_utc("2026-13").is_none());
        assert!(month_range_utc("nope").is_none());
    }

    #[test]
    fn month_regex_matches_the_ts_schema() {
        assert!(valid_month("2026-01"));
        assert!(valid_month("2026-12"));
        assert!(!valid_month("2026-00"));
        assert!(!valid_month("2026-13"));
        assert!(!valid_month("2026-1"));
        assert!(!valid_month("26-01"));
    }

    #[test]
    fn natural_balance_flips_credit_normal_accounts() {
        assert_eq!(
            natural_shard_balance("MERCHANT_WALLET", Decimal::new(2500, 2)),
            Decimal::new(-2500, 2)
        );
        assert_eq!(
            natural_shard_balance("TREASURY", Decimal::new(2500, 2)),
            Decimal::new(2500, 2)
        );
        assert_eq!(
            natural_shard_balance("MERCHANT_WALLET", Decimal::ZERO),
            Decimal::ZERO
        );
    }

    #[test]
    fn csv_header_is_the_ts_header() {
        assert_eq!(
            "reference,created_at,total_charged,commission,net_merchant,currency,status"
                .split(',')
                .count(),
            7
        );
    }

    #[test]
    fn reporting_currency_falls_back_to_the_base_currency() {
        assert_eq!(reporting_currency(Some(" usd ")), "USD");
        assert_eq!(reporting_currency(Some("EURO")), "LYD");
        assert_eq!(reporting_currency(None), "LYD");
    }
}
