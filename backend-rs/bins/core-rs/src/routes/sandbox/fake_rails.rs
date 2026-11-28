//! Fake Rails read routes (tester accounts, clearing pools and the staff control center).
//!
//! Port of the twelve `GET /internal/sandbox/{fake-rails,admin/fake-rails}/**` handlers of
//! `core-back/api/internal/sandboxControl.ts`. Every response is the emulator's own JSON, passed
//! through exactly like the TS `FakeRailsControlClient` wrappers:
//!
//! - `/fake-rails/accounts` is the paged account list (`{accounts, total, page, pageSize}`); a
//!   merchant principal is always scoped to its own merchant, staff may pass `?merchantId=` and
//!   `?includeGlobal=true`;
//! - `/fake-rails/accounts/:accountId` and its `movements`/`holds` reads refuse another merchant's
//!   account with `403 FAKE_ACCOUNT_FORBIDDEN`; an unknown account keeps the emulator's
//!   `404 FAKE_ACCOUNT_NOT_FOUND` (the TS `request()` helper throws before the handler's own null
//!   branch, see DEV-SANDBOX-06);
//! - the staff control center requires a staff principal (`403 STAFF_ONLY`) and proxies scenarios,
//!   transactions, webhook deliveries and statements.
//!
//! **DEV-SANDBOX-06 (unknown account):** the TS `getAccount()` types `null` but its `request()`
//! helper throws on a 404, so the emulator's `FAKE_ACCOUNT_NOT_FOUND` message is the observable
//! error. This port propagates it instead of re-creating the handler's dead null branch; a 200
//! without an `account` key still answers the handler's `404 FAKE_ACCOUNT_NOT_FOUND`.

#![forbid(unsafe_code)]

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::sandbox::control::{js_number_text, ControlClient};
use crate::routes::sandbox::route;
use crate::routes::sandbox::support::{
    assert_control_access, ensure_plane, money, parse_decimal, principal, query_scalar,
    require_staff,
};
use crate::routes::{HandlerFuture, MountedRoute};
use crate::state::AppState;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/sandbox/fake-rails/accounts",
            "core-back/api/internal/sandboxControl.ts:1113",
            list_accounts,
        ),
        route(
            "/internal/sandbox/fake-rails/accounts/:accountId",
            "core-back/api/internal/sandboxControl.ts:1169",
            get_account,
        ),
        route(
            "/internal/sandbox/fake-rails/accounts/:accountId/movements",
            "core-back/api/internal/sandboxControl.ts:1179",
            account_movements,
        ),
        route(
            "/internal/sandbox/fake-rails/accounts/:accountId/holds",
            "core-back/api/internal/sandboxControl.ts:1190",
            account_holds,
        ),
        route(
            "/internal/sandbox/fake-rails/clearing/pools",
            "core-back/api/internal/sandboxControl.ts:1357",
            clearing_pools,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/accounts/summary",
            "core-back/api/internal/sandboxControl.ts:1160",
            accounts_summary,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/scenarios",
            "core-back/api/internal/sandboxControl.ts:2135",
            scenarios,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/transactions",
            "core-back/api/internal/sandboxControl.ts:2175",
            transactions,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/transactions/summary",
            "core-back/api/internal/sandboxControl.ts:2197",
            transaction_summary,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/transactions/:transactionId",
            "core-back/api/internal/sandboxControl.ts:2202",
            transaction,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/webhooks",
            "core-back/api/internal/sandboxControl.ts:2238",
            webhooks,
        ),
        route(
            "/internal/sandbox/admin/fake-rails/statements",
            "core-back/api/internal/sandboxControl.ts:2267",
            statements,
        ),
    ]
}

fn client() -> ControlClient {
    ControlClient::from_env()
}

/// The `:accountId` path segment, read like Express `request.params`.
fn account_id(request: &HttpRequest) -> String {
    // `/internal/sandbox/fake-rails/accounts/:id` → segment 5 (0 is the empty head).
    request
        .path()
        .split('/')
        .nth(5)
        .unwrap_or_default()
        .to_owned()
}

/// `GET /internal/sandbox/fake-rails/accounts`.
pub fn list_accounts<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            let principal = principal(principal_ref)?;
            assert_control_access(principal, "GET")?;
            let staff = principal.is_staff();
            let merchant_id = principal
                .merchant_id
                .clone()
                .or_else(|| query_scalar(request, "merchantId"));
            if merchant_id.is_none() && !staff {
                return Err(ApiError::new(
                    403,
                    "MERCHANT_CONTEXT_REQUIRED",
                    "A merchant principal is required",
                ));
            }
            Ok((staff, merchant_id))
        })();
        let (staff, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(merchant_id) = merchant_id {
            query.push(("merchantId", merchant_id));
        }
        for (param, key) in [
            ("railCode", "railCode"),
            ("gatewayCode", "gatewayCode"),
            ("status", "status"),
            ("instrumentType", "instrumentType"),
            ("scope", "scope"),
            ("from", "createdFrom"),
            ("to", "createdTo"),
            ("search", "search"),
        ] {
            if let Some(value) = query_scalar(request, param).filter(|value| !value.is_empty()) {
                query.push((key, value));
            }
        }
        if staff && query_scalar(request, "includeGlobal").as_deref() == Some("true") {
            query.push(("includeGlobal", "true".to_owned()));
        }
        query.push((
            "page",
            query_scalar(request, "page")
                .map(|value| js_number_text(&value))
                .unwrap_or_else(|| "1".to_owned()),
        ));
        query.push((
            "pageSize",
            query_scalar(request, "pageSize")
                .map(|value| js_number_text(&value))
                .unwrap_or_else(|| "50".to_owned()),
        ));
        match client().accounts_page(&query).await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// Read one account and enforce the merchant ownership rule of the TS handler.
async fn owned_account(
    client: &ControlClient,
    principal: &Principal,
    account_id: &str,
) -> Result<Value, ApiError> {
    let payload = client.account(account_id).await?;
    let account = payload.get("account").cloned().ok_or_else(|| {
        ApiError::new(
            404,
            "FAKE_ACCOUNT_NOT_FOUND",
            "The test account does not exist",
        )
    })?;
    let account_merchant = account.get("merchant_id").and_then(Value::as_str);
    if !principal.is_staff()
        && account_merchant.is_some()
        && account_merchant != principal.merchant_id.as_deref()
    {
        return Err(ApiError::new(
            403,
            "FAKE_ACCOUNT_FORBIDDEN",
            "The test account belongs to another merchant",
        ));
    }
    Ok(account)
}

/// `GET /internal/sandbox/fake-rails/accounts/:accountId`.
pub fn get_account<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            let principal = principal(principal_ref)?;
            assert_control_access(principal, "GET")?;
            Ok(principal)
        })();
        let principal = match result {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        match owned_account(&client(), principal, &account_id(request)).await {
            Ok(account) => json_ok(&json!({ "account": account })),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/fake-rails/accounts/:accountId/movements`.
pub fn account_movements<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            let principal = principal(principal_ref)?;
            assert_control_access(principal, "GET")?;
            Ok(principal)
        })();
        let principal = match result {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let client = client();
        let id = account_id(request);
        if let Err(error) = owned_account(&client, principal, &id).await {
            return crate::http::error_response(request, error);
        }
        let limit = query_scalar(request, "limit")
            .filter(|value| !value.is_empty())
            .map(|value| js_number_text(&value))
            .unwrap_or_else(|| "100".to_owned());
        match client.movements(&id, &limit).await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/fake-rails/accounts/:accountId/holds`.
pub fn account_holds<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            let principal = principal(principal_ref)?;
            assert_control_access(principal, "GET")?;
            Ok(principal)
        })();
        let principal = match result {
            Ok(value) => value,
            Err(error) => return crate::http::error_response(request, error),
        };
        let client = client();
        let id = account_id(request);
        if let Err(error) = owned_account(&client, principal, &id).await {
            return crate::http::error_response(request, error);
        }
        let limit = query_scalar(request, "limit")
            .filter(|value| !value.is_empty())
            .map(|value| js_number_text(&value))
            .unwrap_or_else(|| "100".to_owned());
        match client.holds(&id, &limit).await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/fake-rails/clearing/pools`.
pub fn clearing_pools<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal_ref: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            ensure_plane(state)?;
            let principal = principal(principal_ref)?;
            assert_control_access(principal, "GET")?;
            Ok(())
        })();
        if let Err(error) = result {
            return crate::http::error_response(request, error);
        }
        match client().clearing_pools().await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/admin/fake-rails/accounts/summary`.
pub fn accounts_summary<'a>(
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
        let page = match client()
            .accounts_page(&[
                ("includeGlobal", "true".to_owned()),
                ("page", "1".to_owned()),
                ("pageSize", "200".to_owned()),
            ])
            .await
        {
            Ok(payload) => payload,
            Err(error) => return crate::http::error_response(request, error),
        };
        let accounts = page
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut status: Map<String, Value> = Map::new();
        let mut global = 0_i64;
        let mut merchant = 0_i64;
        let mut available = Decimal::ZERO;
        let mut held = Decimal::ZERO;
        for account in &accounts {
            if let Some(state) = account.get("status").and_then(Value::as_str) {
                let count = status.get(state).and_then(Value::as_i64).unwrap_or(0);
                status.insert(state.to_owned(), Value::from(count + 1));
            }
            match account.get("merchant_id").and_then(Value::as_str) {
                Some(_) => merchant += 1,
                None => global += 1,
            }
            available += account
                .get("available_balance_lyd")
                .and_then(Value::as_str)
                .map(parse_decimal)
                .unwrap_or_default();
            held += account
                .get("reserved_balance_lyd")
                .and_then(Value::as_str)
                .map(parse_decimal)
                .unwrap_or_default();
        }
        let total = page.get("total").and_then(Value::as_i64).unwrap_or(0);
        json_ok(&json!({
            "summary": {
                "total": total,
                "global": global,
                "merchant": merchant,
                "status": status,
                "available": money(Some(available)),
                "held": money(Some(held)),
            }
        }))
    })
}

/// `GET /internal/sandbox/admin/fake-rails/scenarios`.
pub fn scenarios<'a>(
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
        match client().scenarios().await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/admin/fake-rails/transactions`.
pub fn transactions<'a>(
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
        let mut query: Vec<(&str, String)> = Vec::new();
        for key in [
            "railCode",
            "gatewayCode",
            "status",
            "reference",
            "from",
            "to",
        ] {
            if let Some(value) = query_scalar(request, key).filter(|value| !value.is_empty()) {
                query.push((key, value));
            }
        }
        // `limit`/`offset` are `Number(...)` in TS; an invalid value is forwarded as "NaN".
        let limit_raw = query_scalar(request, "limit").filter(|value| !value.is_empty());
        let page_size_raw = query_scalar(request, "pageSize").filter(|value| !value.is_empty());
        let limit = match (&limit_raw, &page_size_raw) {
            (Some(limit), _) => js_number_text(limit),
            (None, Some(page_size)) => js_number_text(page_size),
            (None, None) => "100".to_owned(),
        };
        let offset_raw = query_scalar(request, "offset").filter(|value| !value.is_empty());
        let page_raw = query_scalar(request, "page").filter(|value| !value.is_empty());
        let offset = match (&offset_raw, &page_raw) {
            (Some(offset), _) => js_number_text(offset),
            (None, Some(page)) => {
                let page_number = number_of(page);
                let page_size = page_size_raw.as_deref().map(number_of).unwrap_or(100.0);
                // `Math.max(1, NaN)` is NaN in JavaScript; keep that instead of clamping to 0.
                let offset = if page_number.is_nan() || page_size.is_nan() {
                    f64::NAN
                } else {
                    (page_number.max(1.0) - 1.0) * page_size
                };
                js_number_text(&format!("{offset}"))
            }
            (None, None) => "0".to_owned(),
        };
        query.push(("limit", limit));
        query.push(("offset", offset));
        match client().transactions(&query).await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

fn number_of(raw: &str) -> f64 {
    raw.trim().parse::<f64>().unwrap_or(f64::NAN)
}

/// `GET /internal/sandbox/admin/fake-rails/transactions/summary`.
pub fn transaction_summary<'a>(
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
        match client().transaction_summary().await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/admin/fake-rails/transactions/:transactionId`.
pub fn transaction<'a>(
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
        let id = request
            .path()
            .split('/')
            .nth(6)
            .unwrap_or_default()
            .to_owned();
        match client().transaction(&id).await {
            Ok(payload) => json_ok(&payload),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/admin/fake-rails/webhooks`.
pub fn webhooks<'a>(
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
        let transaction_id =
            query_scalar(request, "transactionId").filter(|value| !value.is_empty());
        match client().webhook_deliveries(transaction_id.as_deref()).await {
            Ok(deliveries) => json_ok(&json!({ "deliveries": deliveries })),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

/// `GET /internal/sandbox/admin/fake-rails/statements`.
pub fn statements<'a>(
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
        match client().statements().await {
            Ok(statements) => json_ok(&json!({ "statements": statements })),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}
