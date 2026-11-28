//! Checkout read routes (P4-T03).
//!
//! Port of the nine `GET` handlers of `core-back/api/internal/checkout.ts` filtered from the
//! route inventory (`tests/golden-vectors/route-inventory/routes.json`):
//!
//! | Route | TS | Notes |
//! | :--- | :--- | :--- |
//! | `GET /internal/checkout/health` | `checkout.ts:42` | already mounted by `routes::mounted_routes` (channel health) |
//! | `GET /internal/checkout/academy/certificates/:publicId` | `checkout.ts:57` | opaque certificate verification (`academy.rs`) |
//! | `GET /internal/checkout/pay/:linkKey` | `checkout.ts:1158` | payer summary + visible rails + fees + help (`pay.rs`) |
//! | `GET /internal/checkout/pay/:linkKey/logs/:attemptId` | `checkout.ts:1552` | attempt log/status read |
//! | `GET /internal/checkout/pay/:linkKey/logs/:attemptId/status` | `checkout.ts:1573` | SSE `event: status` (`sse.rs`) |
//! | `GET /internal/checkout/return/:attemptToken` | `checkout.ts:1793` | browser return info |
//! | `GET /internal/checkout/pay/:linkKey/sandbox-accounts` | `checkout.ts:2068` | Sandbox inspector |
//! | `GET /internal/checkout/pay/:linkKey/sandbox-accounts/:accountId/movements` | `checkout.ts:2120` | Sandbox inspector |
//! | `GET /internal/checkout/pay/:linkKey/logs/:attemptId/sandbox-inspector` | `checkout.ts:2156` | Sandbox inspector |
//!
//! Every route is `Channel::Checkout`, `Authn::None` (the `mtlsGuard` CN check is the only guard
//! in the TS router) and has no authority requirement. No payer secret is logged: the attempt
//! reference and the client IP are the only identifiers this module reads, and neither is logged.
//!
//! ## Documented deviations (Track P parity markers)
//!
//! - **Dispatcher reachability:** the P3 shell's `routes::find` matches exact paths. This module
//!   mounts the TS path templates (`:linkKey`, …) as policies and extracts the parameters from
//!   `request.path()` itself, so each handler can be driven directly; the pattern match inside
//!   `routes::mod` (owned by the coordinator) must learn `:param` segments before the HTTP
//!   dispatcher reaches them. The handlers, shapes and errors are the TS ones.
//! - **SSE realtime bus:** the shell has no `subscribeRealtimeAttempt`; the stream is the TS
//!   two-second DB polling fallback (see `sse.rs`).
//! - **`return` inquiry:** `engine.inquire` is the P5 money path. The read route returns the
//!   stored attempt status and does not call the gateway; the rc of the TS cooldown flag is
//!   therefore not observed here.
//! - **Fake Rails client:** plain HTTP/1.1 control plane, same endpoints and error mapping (see
//!   `fake_rails.rs`).
//! - **Academy catalog:** embedded TS-generated content for the recertification floor (see
//!   `academy.rs`).
//! - **Malformed attempt id:** a non-UUID `:attemptId` answers `PAYMENT_ATTEMPT_NOT_FOUND` with
//!   404. Prisma casts the parameter and raises a 500 for the same input; the read route treats it
//!   as a missing attempt instead (no payer-visible difference for real ids).
//! - **Business-day window:** the daily cap window is computed by PostgreSQL from the configured
//!   IANA zone (`date_trunc('day', … AT TIME ZONE zone)`) instead of the JS `Intl` helper in
//!   `DailyRouteVolume.ts`. Both use the same zone database; Tripoli has no DST today.

#![forbid(unsafe_code)]

mod academy;
mod fake_rails;
mod pay;
mod sse;
mod visible_rails;

use chrono::{NaiveDateTime, SecondsFormat};
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_domain_auth::Principal;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy};
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::common::{database_error, json_ok, money4, Query};
use super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::http;
use crate::state::AppState;

/// The TS path templates. Kept as constants so the policy table and the extractor cannot drift.
pub(super) const CERTIFICATE_PATH: &str = "/internal/checkout/academy/certificates/:publicId";
pub(super) const PAY_PATH: &str = "/internal/checkout/pay/:linkKey";
pub(super) const LOGS_PATH: &str = "/internal/checkout/pay/:linkKey/logs/:attemptId";
pub(super) const STATUS_PATH: &str = "/internal/checkout/pay/:linkKey/logs/:attemptId/status";
pub(super) const RETURN_PATH: &str = "/internal/checkout/return/:attemptToken";
pub(super) const SANDBOX_ACCOUNTS_PATH: &str = "/internal/checkout/pay/:linkKey/sandbox-accounts";
pub(super) const SANDBOX_MOVEMENTS_PATH: &str =
    "/internal/checkout/pay/:linkKey/sandbox-accounts/:accountId/movements";
pub(super) const SANDBOX_INSPECTOR_PATH: &str =
    "/internal/checkout/pay/:linkKey/logs/:attemptId/sandbox-inspector";

/// Routes owned by this module (the channel `/health` is mounted centrally).
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        mounted(
            "GET",
            CERTIFICATE_PATH,
            "core-back/api/internal/checkout.ts:57",
            certificate_handler,
        ),
        mounted(
            "GET",
            PAY_PATH,
            "core-back/api/internal/checkout.ts:1158",
            pay::pay_link,
        ),
        mounted(
            "GET",
            LOGS_PATH,
            "core-back/api/internal/checkout.ts:1552",
            logs_handler,
        ),
        mounted(
            "GET",
            STATUS_PATH,
            "core-back/api/internal/checkout.ts:1573",
            status_handler,
        ),
        mounted(
            "GET",
            RETURN_PATH,
            "core-back/api/internal/checkout.ts:1793",
            return_handler,
        ),
        mounted(
            "GET",
            SANDBOX_ACCOUNTS_PATH,
            "core-back/api/internal/checkout.ts:2068",
            sandbox_accounts_handler,
        ),
        mounted(
            "GET",
            SANDBOX_MOVEMENTS_PATH,
            "core-back/api/internal/checkout.ts:2120",
            sandbox_movements_handler,
        ),
        mounted(
            "GET",
            SANDBOX_INSPECTOR_PATH,
            "core-back/api/internal/checkout.ts:2156",
            sandbox_inspector_handler,
        ),
    ]
}

fn mounted(
    method: &str,
    path: &str,
    ts_origin: &str,
    handler: super::CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new(method, path, Channel::Checkout, Authn::None, ts_origin)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::None,
    }
}

// ---- parameter extraction and the zod contracts -------------------------------------------

/// Extract `:name` segments from an actual path against a TS path template.
///
/// Express matches whole segments only; a parameter segment never matches an empty segment.
#[must_use]
pub(super) fn path_param<'a>(template: &str, actual: &'a str, name: &str) -> Option<&'a str> {
    let actual_segments: Vec<&str> = actual.split('/').collect();
    let template_segments: Vec<&str> = template.split('/').collect();
    if actual_segments.len() != template_segments.len() {
        return None;
    }
    let mut found = None;
    for (template_segment, actual_segment) in template_segments.iter().zip(&actual_segments) {
        if let Some(parameter) = template_segment.strip_prefix(':') {
            if actual_segment.is_empty() {
                return None;
            }
            if parameter == name {
                found = Some(*actual_segment);
            }
        } else if template_segment != actual_segment {
            return None;
        }
    }
    found
}

/// `parseOrThrow(linkParamsSchema)` — 6..64 and `^[A-Za-z0-9_-]+$`.
pub(super) fn link_key_parameter(raw: Option<&str>) -> Result<String, ApiError> {
    let raw = raw.ok_or_else(|| invalid_parameter("linkKey", "too_small", ">=6 characters"))?;
    validate_string("linkKey", raw, 6, 64, true)
}

/// `attemptParamsSchema.attemptId` — 4..64 and `^[A-Za-z0-9_-]+$`.
pub(super) fn attempt_id_parameter(raw: Option<&str>) -> Result<String, ApiError> {
    let raw = raw.ok_or_else(|| invalid_parameter("attemptId", "too_small", ">=4 characters"))?;
    validate_string("attemptId", raw, 4, 64, true)
}

/// `sandboxAccountParamsSchema.accountId` — 1..128, any characters.
pub(super) fn account_id_parameter(raw: Option<&str>) -> Result<String, ApiError> {
    let raw = raw.ok_or_else(|| invalid_parameter("accountId", "too_small", ">=1 character"))?;
    validate_string("accountId", raw, 1, 128, false)
}

/// `z.object({publicId: z.string().min(16).max(64)})`.
pub(super) fn certificate_id_parameter(raw: Option<&str>) -> Result<String, ApiError> {
    let raw = raw.ok_or_else(|| invalid_parameter("publicId", "too_small", ">=16 characters"))?;
    validate_string("publicId", raw, 16, 64, false)
}

fn validate_string(
    name: &str,
    raw: &str,
    min: usize,
    max: usize,
    alphanumeric_token: bool,
) -> Result<String, ApiError> {
    let length = raw.chars().count();
    if length < min {
        return Err(invalid_parameter(
            name,
            "too_small",
            &format!(">={min} character(s)"),
        ));
    }
    if length > max {
        return Err(invalid_parameter(
            name,
            "too_big",
            &format!("<={max} character(s)"),
        ));
    }
    if alphanumeric_token
        && !raw.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err(
            ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
                "path": [name],
                "code": "invalid_format",
                "message": "Invalid string: must match pattern /^[A-Za-z0-9_-]+$/",
            }])),
        );
    }
    Ok(raw.to_owned())
}

fn invalid_parameter(name: &str, code: &str, bound: &str) -> ApiError {
    let message = match code {
        "too_small" => format!("Too small: expected string to have {bound}"),
        _ => format!("Too big: expected string to have {bound}"),
    };
    ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
        "path": [name],
        "code": code,
        "message": message,
    }]))
}

// ---- link and attempt reads ----------------------------------------------------------------

/// `LoadedLink` (`checkout.ts:137`), restricted to the columns the GET handlers read.
#[derive(Debug, Clone)]
pub(super) struct LoadedLink {
    pub key: String,
    pub application_id: Uuid,
    pub merchant_id: Uuid,
    pub title: Option<String>,
    pub description: Option<String>,
    pub redirect_url: Option<String>,
    pub application_redirect_allowlist: Option<Value>,
    pub amount: rust_decimal::Decimal,
    pub currency: String,
    pub fee_bearer: String,
    pub split_ratio_json: Option<Value>,
    pub state: String,
    pub env: String,
    pub expires_at: Option<NaiveDateTime>,
    pub rail_whitelist: Option<Value>,
    pub application_rail_whitelist: Option<Value>,
    pub merchant_trade_name: String,
    pub merchant_risk_tier: String,
    pub merchant_contact_phone: Option<String>,
    pub merchant_contact_email: Option<String>,
}

/// `loadLink` (`checkout.ts:170`), including the wallet and application/merchant columns.
pub(super) async fn load_link(pool: &PgPool, key: &str) -> Result<Option<LoadedLink>, ApiError> {
    let row = sqlx::query(
        "SELECT pl.id, pl.key, pl.application_id, pl.title, pl.description, pl.redirect_url,
                pl.amount, pl.currency::text AS currency, pl.fee_bearer::text AS fee_bearer,
                pl.split_ratio_json, pl.state::text AS state, pl.env::text AS env, pl.expires_at,
                pl.rail_whitelist,
                a.merchant_id, a.rail_whitelist AS application_rail_whitelist,
                a.redirect_domain_allowlist,
                m.trade_name, m.risk_tier::text AS risk_tier, m.contact_phone, m.contact_email
           FROM payment_links pl
           JOIN applications a ON a.id = pl.application_id
           JOIN merchants m ON m.id = a.merchant_id
          WHERE pl.key = $1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .map_err(database_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(LoadedLink {
        key: get_string(&row, "key")?,
        application_id: get_uuid(&row, "application_id")?,
        merchant_id: get_uuid(&row, "merchant_id")?,
        title: get_opt_string(&row, "title")?,
        description: get_opt_string(&row, "description")?,
        redirect_url: get_opt_string(&row, "redirect_url")?,
        application_redirect_allowlist: get_opt_json(&row, "redirect_domain_allowlist")?,
        amount: get_decimal(&row, "amount")?,
        currency: get_string(&row, "currency")?,
        fee_bearer: get_string(&row, "fee_bearer")?,
        split_ratio_json: get_opt_json(&row, "split_ratio_json")?,
        state: get_string(&row, "state")?,
        env: get_string(&row, "env")?,
        expires_at: get_opt_naive(&row, "expires_at")?,
        rail_whitelist: get_opt_json(&row, "rail_whitelist")?,
        application_rail_whitelist: get_opt_json(&row, "application_rail_whitelist")?,
        merchant_trade_name: get_string(&row, "trade_name")?,
        merchant_risk_tier: get_string(&row, "risk_tier")?,
        merchant_contact_phone: get_opt_string(&row, "contact_phone")?,
        merchant_contact_email: get_opt_string(&row, "contact_email")?,
    }))
}

/// `assertPlaneMatchesLink` (`checkout.ts:317`).
pub(super) fn assert_plane_matches(state: &AppState, link: &LoadedLink) -> Result<(), ApiError> {
    let plane = state.config.execution_plane.as_str();
    if link.env != plane {
        return Err(ApiError::new(
            409,
            "ENVIRONMENT_PLANE_MISMATCH",
            format!(
                "Payment link environment ({}) does not match execution plane ({plane})",
                link.env
            ),
        ));
    }
    Ok(())
}

/// `assertSandboxLink` (`checkout.ts:252`).
pub(super) fn assert_sandbox_link(state: &AppState, link: &LoadedLink) -> Result<(), ApiError> {
    if state.config.execution_plane.as_str() != "SANDBOX"
        || link.env != "SANDBOX"
        || !link.key.starts_with("sbx_")
    {
        return Err(ApiError::new(
            403,
            "SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK",
            "The checkout inspector is only available for a Sandbox (sbx_) payment link",
        ));
    }
    Ok(())
}

/// `loadAttempt` (`checkout.ts:1538`): one relation-scoped read, the link probed only on 404.
#[derive(Debug, Clone)]
pub(super) struct LoadedAttempt {
    pub id: Uuid,
    pub reference: String,
    pub status: String,
    pub substatus: Option<String>,
    pub total_charged_amount: rust_decimal::Decimal,
    pub currency: String,
    pub fee_bearer: String,
    pub expires_at: NaiveDateTime,
    pub otp_attempts: i32,
    pub provider_reference: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

pub(super) async fn load_attempt(
    pool: &PgPool,
    link_key: &str,
    attempt_id: &str,
) -> Result<LoadedAttempt, ApiError> {
    let parsed_id = Uuid::parse_str(attempt_id).ok();
    let row = match parsed_id {
        Some(id) => sqlx::query(
            "SELECT pa.id, pa.reference, pa.status::text AS status, pa.substatus,
                        pa.total_charged_amount, pa.currency::text AS currency,
                        pa.fee_bearer::text AS fee_bearer, pa.expires_at, pa.otp_attempts,
                        pa.provider_reference, pa.created_at, pa.updated_at
                   FROM payment_attempts pa
                   JOIN payment_links pl ON pl.id = pa.link_id
                  WHERE pa.id = $1 AND pl.key = $2",
        )
        .bind(id)
        .bind(link_key)
        .fetch_optional(pool)
        .await
        .map_err(database_error)?,
        None => None,
    };
    let Some(row) = row else {
        let link = sqlx::query("SELECT id FROM payment_links WHERE key = $1")
            .bind(link_key)
            .fetch_optional(pool)
            .await
            .map_err(database_error)?;
        if link.is_none() {
            return Err(ApiError::new(
                404,
                "PAYMENT_LINK_NOT_FOUND",
                "The payment link does not exist",
            ));
        }
        return Err(ApiError::new(
            404,
            "PAYMENT_ATTEMPT_NOT_FOUND",
            "The payment attempt does not exist",
        ));
    };
    Ok(LoadedAttempt {
        id: get_uuid(&row, "id")?,
        reference: get_string(&row, "reference")?,
        status: get_string(&row, "status")?,
        substatus: get_opt_string(&row, "substatus")?,
        total_charged_amount: get_decimal(&row, "total_charged_amount")?,
        currency: get_string(&row, "currency")?,
        fee_bearer: get_string(&row, "fee_bearer")?,
        expires_at: get_naive(&row, "expires_at")?,
        otp_attempts: get_i32(&row, "otp_attempts")?,
        provider_reference: get_opt_string(&row, "provider_reference")?,
        created_at: get_naive(&row, "created_at")?,
        updated_at: get_naive(&row, "updated_at")?,
    })
}

// ---- handlers ------------------------------------------------------------------------------

/// `GET /internal/checkout/academy/certificates/:publicId`.
fn certificate_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let public_id = match certificate_id_parameter(path_param(
            CERTIFICATE_PATH,
            request.path(),
            "publicId",
        )) {
            Ok(public_id) => public_id,
            Err(error) => return http::error_response(request, error),
        };
        match academy::certificate(&state.pools.main, &public_id).await {
            Ok(body) => json_ok(&body),
            Err(error) => http::error_response(request, error),
        }
    })
}

/// `GET /internal/checkout/pay/:linkKey/logs/:attemptId`.
fn logs_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let link_key = match link_key_parameter(link_key_of(LOGS_PATH, request.path())) {
            Ok(link_key) => link_key,
            Err(error) => return http::error_response(request, error),
        };
        let attempt_id = match attempt_id_parameter(attempt_id_of(LOGS_PATH, request.path())) {
            Ok(attempt_id) => attempt_id,
            Err(error) => return http::error_response(request, error),
        };
        let attempt = match load_attempt(&state.pools.main, &link_key, &attempt_id).await {
            Ok(attempt) => attempt,
            Err(error) => return http::error_response(request, error),
        };
        // Field order is the TS object literal (`checkout.ts:1555`).
        json_ok(&json!({
            "attemptId": attempt.id.to_string(),
            "reference": attempt.reference,
            "status": attempt.status,
            "substatus": attempt.substatus,
            "amount": money4(Some(attempt.total_charged_amount)),
            "currency": attempt.currency,
            "feeBearer": attempt.fee_bearer,
            "expiresAt": iso_naive(attempt.expires_at),
            "otpAttempts": attempt.otp_attempts,
            "providerReference": attempt.provider_reference,
            "clientAction": null,
            "publicOutputs": {},
            "createdAt": iso_naive(attempt.created_at),
            "updatedAt": iso_naive(attempt.updated_at),
        }))
    })
}

/// `GET /internal/checkout/pay/:linkKey/logs/:attemptId/status` (`text/event-stream`).
fn status_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let link_key = match link_key_parameter(link_key_of(STATUS_PATH, request.path())) {
            Ok(link_key) => link_key,
            Err(error) => return http::error_response(request, error),
        };
        let attempt_id = match attempt_id_parameter(attempt_id_of(STATUS_PATH, request.path())) {
            Ok(attempt_id) => attempt_id,
            Err(error) => return http::error_response(request, error),
        };
        let attempt = match load_attempt(&state.pools.main, &link_key, &attempt_id).await {
            Ok(attempt) => attempt,
            Err(error) => return http::error_response(request, error),
        };
        let stream = sse::open(
            state.pools.main.clone(),
            attempt.id,
            attempt.reference,
            attempt.status,
            attempt.substatus,
        );
        HttpResponse::Ok()
            .content_type("text/event-stream")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no")
            .streaming(stream)
    })
}

/// `GET /internal/checkout/return/:attemptToken`.
fn return_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let attempt_token = path_param(RETURN_PATH, request.path(), "attemptToken")
            .map(percent_decode)
            .unwrap_or_default();
        let row = sqlx::query(
            "SELECT id, reference, status::text AS status
               FROM payment_attempts
              WHERE reference = $1",
        )
        .bind(&attempt_token)
        .fetch_optional(&state.pools.main)
        .await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                return http::error_response(
                    request,
                    ApiError::new(
                        404,
                        "PAYMENT_ATTEMPT_NOT_FOUND",
                        "The attempt token is not recognised",
                    ),
                )
            }
            Err(error) => return http::error_response(request, database_error(error)),
        };
        let id = match get_uuid(&row, "id") {
            Ok(id) => id,
            Err(error) => return http::error_response(request, error),
        };
        let reference = match get_string(&row, "reference") {
            Ok(reference) => reference,
            Err(error) => return http::error_response(request, error),
        };
        let status = match get_string(&row, "status") {
            Ok(status) => status,
            Err(error) => return http::error_response(request, error),
        };
        json_ok(&json!({
            "attemptId": id.to_string(),
            "reference": reference,
            "status": status,
            "redirect": format!("/pay/{reference}/status"),
        }))
    })
}

/// `GET /internal/checkout/pay/:linkKey/sandbox-accounts`.
fn sandbox_accounts_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let link_key = match link_key_parameter(link_key_of(SANDBOX_ACCOUNTS_PATH, request.path()))
        {
            Ok(link_key) => link_key,
            Err(error) => return http::error_response(request, error),
        };
        let link = match load_sandbox_link(state, request, &link_key).await {
            Ok(link) => link,
            Err(response) => return response,
        };
        let query = Query::parse(request.query_string());
        let client = fake_rails::ControlClient::from_env();
        match client
            .list_accounts(Some(&link.merchant_id.to_string()), query.get("railCode"))
            .await
        {
            Ok(accounts) => json_ok(&json!({
                "accounts": accounts.iter().map(sandbox_account_payload).collect::<Vec<_>>(),
            })),
            Err(error) => http::error_response(
                request,
                ApiError::new(502, "SANDBOX_FAKE_RAILS_UNAVAILABLE", error.message),
            ),
        }
    })
}

/// `GET /internal/checkout/pay/:linkKey/sandbox-accounts/:accountId/movements`.
fn sandbox_movements_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let link_key = match link_key_parameter(link_key_of(SANDBOX_MOVEMENTS_PATH, request.path()))
        {
            Ok(link_key) => link_key,
            Err(error) => return http::error_response(request, error),
        };
        let account_id = match account_id_parameter(path_param(
            SANDBOX_MOVEMENTS_PATH,
            request.path(),
            "accountId",
        )) {
            Ok(account_id) => account_id,
            Err(error) => return http::error_response(request, error),
        };
        let link = match load_sandbox_link(state, request, &link_key).await {
            Ok(link) => link,
            Err(response) => return response,
        };
        let client = fake_rails::ControlClient::from_env();
        let account = match client.get_account(&account_id).await {
            Ok(account) => account,
            Err(error) => return http::error_response(request, error),
        };
        let account = match account {
            Some(account) => account,
            None => return fake_account_not_found(request),
        };
        if let Some(owner) = account.get("merchant_id").and_then(Value::as_str) {
            if owner != link.merchant_id.to_string().as_str() {
                return fake_account_not_found(request);
            }
        }
        let limit = limit_argument(Query::parse(request.query_string()).get("limit"));
        let movements = match client.account_movements(&account_id, &limit).await {
            Ok(movements) => movements,
            Err(error) => return http::error_response(request, error),
        };
        let holds = match client.account_holds(&account_id, &limit).await {
            Ok(holds) => holds,
            Err(error) => return http::error_response(request, error),
        };
        json_ok(&json!({ "movements": movements, "holds": holds }))
    })
}

/// `GET /internal/checkout/pay/:linkKey/logs/:attemptId/sandbox-inspector`.
fn sandbox_inspector_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let link_key = match link_key_parameter(link_key_of(SANDBOX_INSPECTOR_PATH, request.path()))
        {
            Ok(link_key) => link_key,
            Err(error) => return http::error_response(request, error),
        };
        let attempt_id =
            match attempt_id_parameter(attempt_id_of(SANDBOX_INSPECTOR_PATH, request.path())) {
                Ok(attempt_id) => attempt_id,
                Err(error) => return http::error_response(request, error),
            };
        let link = match load_sandbox_link(state, request, &link_key).await {
            Ok(link) => link,
            Err(response) => return response,
        };
        let attempt = match load_attempt(&state.pools.main, &link_key, &attempt_id).await {
            Ok(attempt) => attempt,
            Err(error) => return http::error_response(request, error),
        };
        let client = fake_rails::ControlClient::from_env();
        let mut active_attempt_secrets = Value::Null;
        for reference in [
            attempt.provider_reference.as_deref(),
            Some(attempt.reference.as_str()),
        ]
        .into_iter()
        .flatten()
        .filter(|reference| !reference.is_empty())
        {
            if let Ok(helper) = client.checkout_helper(reference).await {
                let secrets = helper
                    .get("activeAttemptSecrets")
                    .cloned()
                    .unwrap_or(Value::Null);
                if !secrets.is_null() {
                    active_attempt_secrets = secrets;
                    break;
                }
            }
        }
        let (rail_accounts, unavailable) = match client
            .list_accounts(Some(&link.merchant_id.to_string()), None)
            .await
        {
            Ok(accounts) => (
                accounts
                    .iter()
                    .map(sandbox_account_payload)
                    .collect::<Vec<_>>(),
                Value::Null,
            ),
            Err(error) => (Vec::new(), Value::String(error.message)),
        };
        json_ok(&json!({
            "enabled": true,
            "mode": "OPEN_IN_SANDBOX",
            "unlocked": true,
            "unavailable": unavailable,
            "railAccounts": rail_accounts,
            "activeAttemptSecrets": active_attempt_secrets,
        }))
    })
}

async fn load_sandbox_link(
    state: &AppState,
    request: &HttpRequest,
    link_key: &str,
) -> Result<LoadedLink, HttpResponse> {
    let link = match load_link(&state.pools.main, link_key).await {
        Ok(Some(link)) => link,
        Ok(None) => {
            return Err(http::error_response(
                request,
                ApiError::new(
                    404,
                    "PAYMENT_LINK_NOT_FOUND",
                    "The payment link does not exist",
                ),
            ))
        }
        Err(error) => return Err(http::error_response(request, error)),
    };
    if let Err(error) = assert_sandbox_link(state, &link) {
        return Err(http::error_response(request, error));
    }
    Ok(link)
}

fn fake_account_not_found(request: &HttpRequest) -> HttpResponse {
    http::error_response(
        request,
        ApiError::new(
            404,
            "FAKE_ACCOUNT_NOT_FOUND",
            "The test account does not exist",
        ),
    )
}

/// `sandboxAccountPayload` (`checkout.ts:262`).
///
/// TypeScript drops a key whose value is `undefined`; the Fake Rails account is fully typed, so
/// the only optional reads are the last two, which TS always emits (`?? null`).
#[must_use]
pub(super) fn sandbox_account_payload(account: &Value) -> Value {
    let mut object = Map::new();
    for (source, target) in [
        ("id", "id"),
        ("rail_code", "railCode"),
        ("gateway_code", "gatewayCode"),
        ("instrument_type", "instrumentType"),
        ("identifier", "identifier"),
        ("holder_name", "holderName"),
        ("secret_pin", "secretPin"),
        ("expiry", "expiry"),
        ("available_balance_lyd", "availableBalanceLyd"),
        ("reserved_balance_lyd", "reservedBalanceLyd"),
        ("daily_limit_lyd", "dailyLimitLyd"),
        ("daily_spent_lyd", "dailySpentLyd"),
        ("status", "status"),
        ("static_otp", "staticOtp"),
        ("notes", "notes"),
    ] {
        if let Some(value) = account.get(source) {
            object.insert(target.to_owned(), value.clone());
        }
    }
    object.insert(
        "dailySpentDate".to_owned(),
        account
            .get("daily_spent_date")
            .cloned()
            .unwrap_or(Value::Null),
    );
    object.insert(
        "merchantId".to_owned(),
        account.get("merchant_id").cloned().unwrap_or(Value::Null),
    );
    Value::Object(object)
}

/// `Number(request.query.limit ?? 100)` for the emulator query. Integers keep their value; a
/// non-numeric value becomes `NaN`, exactly like `String(Number(value))` in the TS route.
#[must_use]
fn limit_argument(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return "100".to_owned();
    };
    match raw.trim().parse::<f64>() {
        Ok(number) if number.is_finite() => {
            if number.fract() == 0.0 {
                format!("{number:.0}")
            } else {
                number.to_string()
            }
        }
        _ => "NaN".to_owned(),
    }
}

// ---- small helpers -------------------------------------------------------------------------

fn link_key_of<'a>(template: &str, actual: &'a str) -> Option<&'a str> {
    path_param(template, actual, "linkKey")
}

fn attempt_id_of<'a>(template: &str, actual: &'a str) -> Option<&'a str> {
    path_param(template, actual, "attemptId")
}

/// `toISOString()`: always milliseconds and `Z`.
#[must_use]
pub(super) fn iso_naive(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Express decodes percent escapes in route parameters. Byte-based so a malformed escape can
/// never split a UTF-8 character (and never panic in a request path).
#[must_use]
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn get_uuid(row: &sqlx::postgres::PgRow, column: &str) -> Result<Uuid, ApiError> {
    row.try_get::<Uuid, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_string(row: &sqlx::postgres::PgRow, column: &str) -> Result<String, ApiError> {
    row.try_get::<String, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_opt_string(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<String>, ApiError> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<i32, ApiError> {
    row.try_get::<i32, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_decimal(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<rust_decimal::Decimal, ApiError> {
    row.try_get::<rust_decimal::Decimal, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_naive(row: &sqlx::postgres::PgRow, column: &str) -> Result<NaiveDateTime, ApiError> {
    row.try_get::<NaiveDateTime, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_opt_naive(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<NaiveDateTime>, ApiError> {
    row.try_get::<Option<NaiveDateTime>, _>(column)
        .map_err(|_| decode_error(column))
}

fn get_opt_json(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<Value>, ApiError> {
    row.try_get::<Option<Value>, _>(column)
        .map_err(|_| decode_error(column))
}

fn decode_error(column: &str) -> ApiError {
    tracing::error!(column, "checkout row could not be decoded");
    ApiError::server_error()
}

#[cfg(test)]
mod tests;
