//! Staff (admin) Sandbox reads: overview, merchant portfolio, merchant detail and sync audits.
//!
//! Port of the six staff `GET /internal/sandbox/admin/**` handlers of
//! `core-back/api/internal/sandboxControl.ts` that are not Fake Rails proxies. Every handler calls
//! `requireStaff` after the Sandbox-plane gate, so a merchant principal or an API token answers
//! `403 STAFF_ONLY`.
//!
//! | Route | TS | Notes |
//! | :--- | :--- | :--- |
//! | `/internal/sandbox/admin/overview` | `sandboxControl.ts:2054` | plane row, reference counts, Fake Rails health |
//! | `/internal/sandbox/admin/merchants/summary` | `sandboxControl.ts:1959` | portfolio totals and balances per currency |
//! | `/internal/sandbox/admin/merchants` | `sandboxControl.ts:1980` | paginated portfolio (the first of the two TS registrations) |
//! | `/internal/sandbox/admin/merchants/:merchantId` | `sandboxControl.ts:2007` | merchant, wallets, applications, links, payments, cashouts, disputes, accounts, audits |
//! | `/internal/sandbox/admin/merchants/:merchantId/overview` | `sandboxControl.ts:2103` | compact counts |
//! | `/internal/sandbox/admin/audits` | `sandboxControl.ts:2036` | paginated sync audit |
//!
//! `GET /internal/sandbox/admin/merchants` is registered twice in the TS router (a paginated list at
//! line 1980 and an unreachable simple list at 2089; Express serves the first). Only the first is
//! mounted.

#![forbid(unsafe_code)]

use pg_db::list_query::{
    count_unless_skipped, ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection,
};
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use ntex::web::types::Payload;
use ntex::web::HttpRequest;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::merchant::{cursor_rows, CursorColumn, FieldKind};
use crate::routes::sandbox::control::ControlClient;
use crate::routes::sandbox::fields::{
    AUDIT_COLUMNS, AUDIT_FIELDS, MERCHANT_COLUMNS, MERCHANT_FIELDS, PLANE_COLUMNS, PLANE_FIELDS,
    WALLET_COLUMNS, WALLET_FIELDS,
};
use crate::routes::sandbox::support::{
    build_list, count_map, ensure_plane, invalid_path, list_envelope, money, ordered_row,
    ordered_rows, parse_decimal, require_staff, wallet_amounts, WalletRef,
};
use crate::routes::sandbox::{route, support};
use crate::routes::{HandlerFuture, MountedRoute};
use crate::state::AppState;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/sandbox/admin/overview",
            "core-back/api/internal/sandboxControl.ts:2054",
            overview,
        ),
        route(
            "/internal/sandbox/admin/merchants/summary",
            "core-back/api/internal/sandboxControl.ts:1959",
            merchants_summary,
        ),
        route(
            "/internal/sandbox/admin/merchants",
            "core-back/api/internal/sandboxControl.ts:1980",
            merchants,
        ),
        route(
            "/internal/sandbox/admin/merchants/:merchantId",
            "core-back/api/internal/sandboxControl.ts:2007",
            merchant_detail,
        ),
        route(
            "/internal/sandbox/admin/merchants/:merchantId/overview",
            "core-back/api/internal/sandboxControl.ts:2103",
            merchant_overview,
        ),
        route(
            "/internal/sandbox/admin/audits",
            "core-back/api/internal/sandboxControl.ts:2036",
            audits,
        ),
    ]
}

/// `parseOrThrow(merchantIdSchema, request.params)`.
fn merchant_id_param(request: &HttpRequest) -> Result<Uuid, ApiError> {
    let raw = request.path().split('/').nth(5).unwrap_or_default();
    Uuid::parse_str(raw).map_err(|_| invalid_path("merchantId", "Invalid UUID"))
}

/// `GET /internal/sandbox/admin/overview`.
pub fn overview<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            require_staff(principal_ref)?;
            Ok(())
        })();
        if let Err(error) = result {
            return crate::http::error_response(request, error);
        }
        match load_overview(state).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_overview(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let merchants: i64 = sqlx::query_scalar("SELECT count(*) FROM merchants")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let wallets: i64 = sqlx::query_scalar("SELECT count(*) FROM wallets")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let applications: i64 = sqlx::query_scalar("SELECT count(*) FROM applications")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_links")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_attempts")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let tokens: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens WHERE env = 'SANDBOX' AND revoked_at IS NULL",
    )
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let plane = support::safe_query(format!(
        "SELECT {PLANE_COLUMNS} FROM system_execution_plane WHERE id = 1"
    ))
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?
    .map(|row| ordered_row(&row, PLANE_FIELDS))
    .transpose()?;
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
        "SELECT count(*) FROM commission_profiles WHERE merchant_id IS NULL AND application_id IS NULL",
    )
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = support::safe_query(format!(
        "SELECT {AUDIT_COLUMNS} FROM sandbox_sync_audits ORDER BY created_at DESC LIMIT 20"
    ))
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = ordered_rows(&audits, AUDIT_FIELDS)?;

    let mut fake_rails = json!({ "ok": true });
    if let Err(error) = ControlClient::from_env().accounts(&[]).await {
        fake_rails = json!({ "ok": false, "message": error.message });
    }
    let live_sync_revision = plane
        .as_ref()
        .and_then(|plane| plane.get("liveSyncRevision"))
        .cloned()
        .unwrap_or_else(|| Value::from(0));
    let last_synced = plane
        .as_ref()
        .and_then(|plane| plane.get("lastSyncedFromLive"))
        .cloned()
        .unwrap_or(Value::Null);

    Ok(json!({
        "plane": "SANDBOX",
        "planeState": plane,
        "sandbox": {
            "merchants": merchants,
            "wallets": wallets,
            "applications": applications,
            "links": links,
            "attempts": attempts,
            "tokens": tokens,
        },
        "reference": {
            "rails": rails,
            "gateways": gateways,
            "routes": routes,
            "commissionProfiles": commission_profiles,
            "ready": rails > 0 && gateways > 0 && routes > 0,
        },
        "fakeRails": fake_rails,
        "liveSyncRevision": live_sync_revision,
        "lastSyncedFromLive": last_synced,
        "syncAudits": audits,
    }))
}

/// `GET /internal/sandbox/admin/merchants/summary`.
pub fn merchants_summary<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            require_staff(principal_ref)?;
            Ok(())
        })();
        if let Err(error) = result {
            return crate::http::error_response(request, error);
        }
        match load_summary(state).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_summary(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM merchants")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let groups = sqlx::query(
        "SELECT status::text AS status, count(*)::bigint AS count
           FROM merchants GROUP BY status",
    )
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
    let wallets = support::safe_query(format!(
        "SELECT {WALLET_COLUMNS} FROM wallets w ORDER BY w.created_at DESC"
    ))
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let refs: Vec<(Uuid, Uuid, String)> = wallets
        .iter()
        .map(|row| {
            Ok((
                row.try_get("id").map_err(support::sqlx_error)?,
                row.try_get("gl_account_id").map_err(support::sqlx_error)?,
                row.try_get("currency").map_err(support::sqlx_error)?,
            ))
        })
        .collect::<Result<_, ApiError>>()?;
    let amounts = wallet_amounts(
        pool,
        &refs
            .iter()
            .map(|(id, gl_account_id, currency)| WalletRef {
                id: *id,
                gl_account_id: *gl_account_id,
                currency: currency.clone(),
            })
            .collect::<Vec<_>>(),
    )
    .await?;
    let mut by_currency: Map<String, Value> = Map::new();
    for (index, amount) in amounts.iter().enumerate() {
        let currency = &refs[index].2;
        let value = parse_decimal(&amount.available_balance);
        let current = by_currency
            .get(currency)
            .and_then(Value::as_str)
            .map(parse_decimal)
            .unwrap_or_default();
        by_currency.insert(
            currency.clone(),
            Value::String(money(Some(current + value))),
        );
    }
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_attempts")
        .fetch_one(pool)
        .await
        .map_err(support::sqlx_error)?;
    let cashouts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cashout_requests WHERE state IN ('PENDING','PROCESSING')",
    )
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let disputes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes
          WHERE status IN ('OPENED','EVIDENCE_REQUESTED','EVIDENCE_SUBMITTED')",
    )
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let fake_accounts = ControlClient::from_env()
        .accounts(&[])
        .await
        .map(|accounts| accounts.len())
        .unwrap_or(0);

    Ok(json!({
        "summary": {
            "total": total,
            "status": count_map(status),
            "wallets": wallets.len(),
            "attempts": attempts,
            "pendingCashouts": cashouts,
            "openDisputes": disputes,
            "fakeAccounts": fake_accounts,
            "byCurrency": by_currency,
        }
    }))
}

/// `GET /internal/sandbox/admin/merchants`.
pub fn merchants<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            require_staff(principal_ref)?;
            Ok(())
        })();
        if let Err(error) = result {
            return crate::http::error_response(request, error);
        }
        match load_merchants(state, request).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_merchants(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_search(&["tradeName", "legalName", "displayName"])
        .with_in("status", "status")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("tradeName", "tradeName")
        .with_sortable("legalName", "legalName")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "m.id", ColumnKind::Uuid)
        .with("tradeName", "m.trade_name", ColumnKind::Text)
        .with("legalName", "m.legal_name", ColumnKind::Text)
        .with("displayName", "m.display_name", ColumnKind::Text)
        .with("status", "m.status::text", ColumnKind::Text)
        .with("createdAt", "m.created_at", ColumnKind::Timestamp);
    let built = build_list(request, &spec, &columns)?;
    let pool = &state.pools.main;
    let sql = built.select_sql(
        "merchants m",
        &[
            "m.id",
            "m.trade_name",
            "m.legal_name",
            "m.display_name",
            "m.status::text AS status",
            "m.onboarding_channel",
            "m.country",
            "m.created_at",
        ],
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let total = count_unless_skipped(&built, "merchants m", pool)
        .await
        .map_err(support::filter_error)?;

    let mut ids = Vec::with_capacity(rows.len());
    let mut counts: Vec<(Uuid, String, String, Option<String>, String)> =
        Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = row.try_get("id").map_err(support::sqlx_error)?;
        ids.push(id);
        counts.push((
            id,
            row.try_get::<String, _>("trade_name")
                .map_err(support::sqlx_error)?,
            row.try_get::<String, _>("legal_name")
                .map_err(support::sqlx_error)?,
            row.try_get::<Option<String>, _>("display_name")
                .map_err(support::sqlx_error)?,
            row.try_get::<String, _>("status")
                .map_err(support::sqlx_error)?,
        ));
    }
    let mut wallets_by = std::collections::HashMap::<Uuid, i64>::new();
    let mut applications_by = std::collections::HashMap::<Uuid, i64>::new();
    let mut payments_by = std::collections::HashMap::<Uuid, i64>::new();
    let mut cashouts_by = std::collections::HashMap::<Uuid, i64>::new();
    let mut balance_by = std::collections::HashMap::<Uuid, Decimal>::new();
    if !ids.is_empty() {
        for (table, column, target) in [
            ("wallets", "merchant_id", &mut wallets_by),
            ("applications", "merchant_id", &mut applications_by),
            ("payment_attempts", "merchant_id", &mut payments_by),
            ("cashout_requests", "merchant_id", &mut cashouts_by),
        ] {
            let sql = format!(
                "SELECT {column} AS merchant_id, count(*)::bigint AS count
                   FROM {table} WHERE {column} = ANY($1::uuid[]) GROUP BY {column}"
            );
            let grouped = sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&ids)
                .fetch_all(pool)
                .await
                .map_err(support::sqlx_error)?;
            for row in &grouped {
                target.insert(
                    row.try_get("merchant_id").map_err(support::sqlx_error)?,
                    row.try_get("count").map_err(support::sqlx_error)?,
                );
            }
        }
        let wallets = sqlx::query(
            "SELECT id, merchant_id, gl_account_id, currency FROM wallets
              WHERE merchant_id = ANY($1::uuid[])",
        )
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
        let mut refs = Vec::with_capacity(wallets.len());
        for row in &wallets {
            refs.push((
                row.try_get::<Uuid, _>("merchant_id")
                    .map_err(support::sqlx_error)?,
                WalletRef {
                    id: row.try_get("id").map_err(support::sqlx_error)?,
                    gl_account_id: row.try_get("gl_account_id").map_err(support::sqlx_error)?,
                    currency: row.try_get("currency").map_err(support::sqlx_error)?,
                },
            ));
        }
        let amounts = wallet_amounts(
            pool,
            &refs
                .iter()
                .map(|(_, wallet)| wallet.clone())
                .collect::<Vec<_>>(),
        )
        .await?;
        for (index, amount) in amounts.iter().enumerate() {
            let merchant_id = refs[index].0;
            *balance_by.entry(merchant_id).or_default() += parse_decimal(&amount.available_balance);
        }
    }

    let mut out = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let id = ids[index];
        out.push(json!({
            "id": id,
            "tradeName": counts[index].1,
            "legalName": counts[index].2,
            "displayName": counts[index].3.clone(),
            "status": counts[index].4,
            "onboardingChannel": row.try_get::<String, _>("onboarding_channel").map_err(support::sqlx_error)?,
            "country": row.try_get::<String, _>("country").map_err(support::sqlx_error)?,
            "createdAt": crate::routes::merchant::iso_timestamp(
                row.try_get("created_at").map_err(support::sqlx_error)?
            ),
            "wallets": wallets_by.get(&id).copied().unwrap_or(0),
            "applications": applications_by.get(&id).copied().unwrap_or(0),
            "payments": payments_by.get(&id).copied().unwrap_or(0),
            "cashouts": cashouts_by.get(&id).copied().unwrap_or(0),
            "availableBalance": money(Some(balance_by.get(&id).copied().unwrap_or_default())),
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
    Ok(list_envelope("merchants", out, total, &built, &source_rows))
}

/// `GET /internal/sandbox/admin/merchants/:merchantId`.
pub fn merchant_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            require_staff(principal_ref)?;
            let merchant_id = merchant_id_param(request)?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_merchant_detail(state, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_merchant_detail(state: &AppState, merchant_id: Uuid) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let merchant = support::safe_query(format!(
        "SELECT {MERCHANT_COLUMNS} FROM merchants m WHERE m.id = $1"
    ))
    .bind(merchant_id)
    .fetch_optional(pool)
    .await
    .map_err(support::sqlx_error)?;
    let Some(merchant) = merchant else {
        return Err(ApiError::new(
            404,
            "SANDBOX_MERCHANT_NOT_FOUND",
            "The sandbox merchant does not exist",
        ));
    };
    let merchant_json = ordered_row(&merchant, MERCHANT_FIELDS)?;
    let wallets = support::safe_query(format!(
        "SELECT {WALLET_COLUMNS} FROM wallets w
          WHERE w.merchant_id = $1 ORDER BY w.created_at DESC"
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let wallet_rows = ordered_rows(&wallets, WALLET_FIELDS)?;
    let refs: Vec<WalletRef> = wallets
        .iter()
        .map(|row| {
            Ok(WalletRef {
                id: row.try_get("id").map_err(support::sqlx_error)?,
                gl_account_id: row.try_get("gl_account_id").map_err(support::sqlx_error)?,
                currency: row.try_get("currency").map_err(support::sqlx_error)?,
            })
        })
        .collect::<Result<_, ApiError>>()?;
    let amounts = wallet_amounts(pool, &refs).await?;
    let amount_json: Vec<Value> = amounts
        .iter()
        .map(|amount| {
            json!({
                "walletId": amount.wallet_id,
                "availableBalance": amount.available_balance,
                "checkpointBalance": amount.checkpoint_balance,
                "checkpointAt": crate::routes::merchant::iso_timestamptz(amount.checkpoint_at),
                "pendingLines": amount.pending_lines,
                "shardCount": amount.shard_count,
                "checkpointStatus": amount.checkpoint_status,
            })
        })
        .collect();
    let wallet_json: Vec<Value> = wallet_rows
        .iter()
        .enumerate()
        .map(|(index, wallet)| {
            let amount = &amounts[index];
            json!({
                "id": wallet.get("id").cloned().unwrap_or(Value::Null),
                "name": wallet.get("name").cloned().unwrap_or(Value::Null),
                "currency": wallet.get("currency").cloned().unwrap_or(Value::Null),
                "status": wallet.get("status").cloned().unwrap_or(Value::Null),
                "createdAt": wallet.get("createdAt").cloned().unwrap_or(Value::Null),
                "walletId": amount.wallet_id,
                "availableBalance": amount.available_balance,
                "checkpointBalance": amount.checkpoint_balance,
                "checkpointAt": crate::routes::merchant::iso_timestamptz(amount.checkpoint_at),
                "pendingLines": amount.pending_lines,
                "shardCount": amount.shard_count,
                "checkpointStatus": amount.checkpoint_status,
            })
        })
        .collect();

    let applications = sqlx::query(
        "SELECT id, name, status::text AS status, assigned_wallet_id, expected_monthly_volume,
                created_at
           FROM applications WHERE merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let applications: Vec<Value> = applications
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
                "name": row.try_get::<String, _>("name").map_err(support::sqlx_error)?,
                "status": row.try_get::<String, _>("status").map_err(support::sqlx_error)?,
                "assignedWalletId": row.try_get::<Uuid, _>("assigned_wallet_id").map_err(support::sqlx_error)?,
                "expectedMonthlyVolume": money(row.try_get("expected_monthly_volume").map_err(support::sqlx_error)?),
                "createdAt": crate::routes::merchant::iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;

    let links = sqlx::query(
        "SELECT l.id, l.key, l.title, l.amount, l.currency, l.state::text AS state,
                l.use_count, l.confirmed_count, l.created_at
           FROM payment_links l JOIN applications a ON a.id = l.application_id
          WHERE a.merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let links: Vec<Value> = links
        .iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
                "key": row.try_get::<String, _>("key").map_err(support::sqlx_error)?,
                "title": row.try_get::<Option<String>, _>("title").map_err(support::sqlx_error)?,
                "amount": money(row.try_get("amount").map_err(support::sqlx_error)?),
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "state": row.try_get::<String, _>("state").map_err(support::sqlx_error)?,
                "useCount": row.try_get::<i32, _>("use_count").map_err(support::sqlx_error)?,
                "confirmedCount": row.try_get::<i32, _>("confirmed_count").map_err(support::sqlx_error)?,
                "createdAt": crate::routes::merchant::iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;

    let payments = sqlx::query(
        "SELECT id, reference, status::text AS status, total_charged_amount,
                net_merchant_amount, currency, created_at
           FROM payment_attempts WHERE merchant_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(merchant_id)
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
                "netMerchantAmount": money(row.try_get("net_merchant_amount").map_err(support::sqlx_error)?),
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "createdAt": crate::routes::merchant::iso_timestamp(row.try_get("created_at").map_err(support::sqlx_error)?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;

    let cashouts = support::safe_query(format!(
        "SELECT {} FROM cashout_requests WHERE merchant_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 20",
        crate::routes::sandbox::fields::CASHOUT_COLUMNS
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let cashouts = ordered_rows(&cashouts, crate::routes::sandbox::fields::CASHOUT_FIELDS)?;
    let cashouts: Vec<Value> = cashouts
        .into_iter()
        .map(|mut row| {
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

    let disputes = support::safe_query(format!(
        "SELECT {} FROM disputes d
          WHERE d.attempt_id IN (SELECT id FROM payment_attempts WHERE merchant_id = $1)
          ORDER BY d.opened_at DESC, d.id DESC LIMIT 20",
        crate::routes::sandbox::fields::DISPUTE_COLUMNS
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let disputes = ordered_rows(&disputes, crate::routes::sandbox::fields::DISPUTE_FIELDS)?;

    let accounts = ControlClient::from_env()
        .accounts(&[("merchantId", merchant_id.to_string())])
        .await
        .unwrap_or_default();
    let audits = support::safe_query(format!(
        "SELECT {AUDIT_COLUMNS} FROM sandbox_sync_audits
          WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50"
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = ordered_rows(&audits, AUDIT_FIELDS)?;

    Ok(json!({
        "merchant": merchant_json,
        "walletAmounts": amount_json,
        "wallets": wallet_json,
        "applications": applications,
        "links": links,
        "payments": payments,
        "cashouts": cashouts,
        "disputes": disputes,
        "accounts": accounts,
        "audits": audits,
    }))
}

/// `GET /internal/sandbox/admin/merchants/:merchantId/overview`.
pub fn merchant_overview<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            require_staff(principal_ref)?;
            let merchant_id = merchant_id_param(request)?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match load_merchant_overview(state, merchant_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_merchant_overview(state: &AppState, merchant_id: Uuid) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let wallets = support::safe_query(format!(
        "SELECT {WALLET_COLUMNS} FROM wallets w
          WHERE w.merchant_id = $1 ORDER BY w.created_at DESC"
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let refs: Vec<WalletRef> = wallets
        .iter()
        .map(|row| {
            Ok(WalletRef {
                id: row.try_get("id").map_err(support::sqlx_error)?,
                gl_account_id: row.try_get("gl_account_id").map_err(support::sqlx_error)?,
                currency: row.try_get("currency").map_err(support::sqlx_error)?,
            })
        })
        .collect::<Result<_, ApiError>>()?;
    let amounts = wallet_amounts(pool, &refs).await?;
    let application_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM applications WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let link_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_links l JOIN applications a ON a.id = l.application_id
          WHERE a.merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let attempt_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM payment_attempts WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let cashout_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cashout_requests WHERE merchant_id = $1")
            .bind(merchant_id)
            .fetch_one(pool)
            .await
            .map_err(support::sqlx_error)?;
    let dispute_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM disputes d
          WHERE d.attempt_id IN (SELECT id FROM payment_attempts WHERE merchant_id = $1)",
    )
    .bind(merchant_id)
    .fetch_one(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = support::safe_query(format!(
        "SELECT {AUDIT_COLUMNS} FROM sandbox_sync_audits
          WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 20"
    ))
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(support::sqlx_error)?;
    let audits = ordered_rows(&audits, AUDIT_FIELDS)?;
    let wallets_json: Vec<Value> = wallets
        .iter()
        .enumerate()
        .map(|(index, row)| {
            Ok(json!({
                "id": row.try_get::<Uuid, _>("id").map_err(support::sqlx_error)?,
                "name": row.try_get::<Option<String>, _>("name").map_err(support::sqlx_error)?,
                "currency": row.try_get::<String, _>("currency").map_err(support::sqlx_error)?,
                "status": row.try_get::<String, _>("status").map_err(support::sqlx_error)?,
                "availableBalance": amounts[index].available_balance,
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    Ok(json!({
        "merchantId": merchant_id,
        "counts": {
            "wallets": wallets.len(),
            "applications": application_count,
            "links": link_count,
            "attempts": attempt_count,
            "cashouts": cashout_count,
            "disputes": dispute_count,
        },
        "syncAudits": audits,
        "wallets": wallets_json,
    }))
}

/// `GET /internal/sandbox/admin/audits`.
pub fn audits<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            require_staff(principal_ref)?;
            Ok(())
        })();
        if let Err(error) = result {
            return crate::http::error_response(request, error);
        }
        match load_audits(state, request).await {
            Ok(body) => json_ok(&body),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn load_audits(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let spec = ListSpec::default()
        .with_in("type", "syncType")
        .with_equals("role", "actorRole")
        .with_equals("actorId", "actorId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("syncType", "syncType")
        .with_default_sort("createdAt", SortDirection::Desc);
    let columns = ColumnMap::new()
        .with("id", "id", ColumnKind::Uuid)
        .with("syncType", "sync_type", ColumnKind::Text)
        .with("actorRole", "actor_role", ColumnKind::Text)
        .with("actorId", "actor_id", ColumnKind::Uuid)
        .with("createdAt", "created_at", ColumnKind::Timestamp);
    let built = build_list(request, &spec, &columns)?;
    let pool = &state.pools.main;
    let sql = built.select_sql("sandbox_sync_audits", &[AUDIT_COLUMNS]);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(support::sqlx_error)?;
    let out = ordered_rows(&rows, AUDIT_FIELDS)?;
    let total = count_unless_skipped(&built, "sandbox_sync_audits", pool)
        .await
        .map_err(support::filter_error)?;
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
    Ok(list_envelope("audits", out, total, &built, &source_rows))
}
