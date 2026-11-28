//! The tester portal API (`/portal-api`), the service-to-service control plane (`/control`) and
//! the public hosted pages. Ported from `api/portal/**` and `api/control/index.ts`.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::accounts::{
    adjust_account, capture_hold, create_account, generate_clearing_statement, get_account,
    list_account_holds, list_account_movements, list_accounts, list_accounts_page,
    list_clearing_pools, mark_clearing_settled, mark_statement_included, release_hold,
    reset_accounts, restore_preset_account, AccountFilters, AdjustAccount, ClearingFilters,
    NewAccount,
};
use crate::chaos::{
    apply_preset, descriptor_json, get_scenario, list_scenarios, merge_scenario,
    reset_all_scenarios, resolve_rail, save_scenario, RAIL_DESCRIPTORS,
};
use crate::crypto::{constant_time_eq, sha256_hex, sign_jwt, verify_jwt, JWT_TTL_SECONDS};
use crate::db::{
    find_transaction_any, list_step_events, list_transactions, now_iso, update_transaction,
    uuid_v7, SeedStepEvent, Transaction, TransactionFilters,
};
use crate::error::{invalid_body_details, ApiError, ApiResult};
use crate::http::{AppResponse, IncomingRequest};
use crate::money::{lyd, micros};
use crate::state::AppState;
use crate::statements::{generate_statement, statement_xlsx, to_csv, Anomalies};
use crate::webhook::{
    allowed_webhook_hosts, webhook_target_allowed, DispatchInput, WebhookBehavior,
};

pub const HOSTED_ACTION_ROLE: &str = "FAKE_RAILS_HOSTED_ACTION";
pub const SSE_TICKET_ROLE: &str = "FAKE_RAILS_SSE_TICKET";
pub const HOSTED_ACTION_TTL_SECONDS: i64 = 15 * 60;
pub const SSE_TICKET_TTL_SECONDS: i64 = 30;
pub const TESTER_ROLE: &str = "FAKE_RAILS_TESTER";

const TERMINAL_STATUSES: [&str; 3] = ["PAID", "REFUNDED", "CANCELLED"];

// ---------------------------------------------------------------------------------------------
// Entry points and authentication
// ---------------------------------------------------------------------------------------------

/// `/portal-api/*`.
pub async fn handle_portal(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let path = request.path.as_str();
    if path == "/auth/login" {
        return login(state, request);
    }
    if path.starts_with("/hosted/") {
        return handle_authenticated(state, request, "payer", false).await;
    }
    if path.starts_with("/internal/") {
        let token = request
            .header("x-fake-rails-seeder-token")
            .unwrap_or_default();
        if token.is_empty()
            || !constant_time_eq(
                &sha256_hex(token.as_bytes()),
                &sha256_hex(state.config.seeder_token.as_bytes()),
            )
        {
            return Err(ApiError::new(
                401,
                "INVALID_SEEDER_TOKEN",
                "A valid X-Fake-Rails-Seeder-Token header is required",
            ));
        }
        return handle_authenticated(state, request, "seeder", false).await;
    }
    if path == "/transactions/stream" {
        if let Some(ticket) = request.query.get("ticket") {
            if !consume_sse_ticket(state, ticket) {
                return Err(ApiError::new(
                    401,
                    "UNAUTHENTICATED",
                    "The stream ticket is invalid, expired or already used",
                ));
            }
            return handle_authenticated(state, request, "tester", false).await;
        }
    }
    let header = request.header("authorization").unwrap_or_default();
    let token = header
        .strip_prefix("Bearer ")
        .map(str::trim)
        .unwrap_or_default();
    let payload = if token.is_empty() {
        None
    } else {
        verify_jwt(token, &state.config.jwt_secret)
    };
    let Some(payload) = payload else {
        return Err(ApiError::new(
            401,
            "UNAUTHENTICATED",
            "A valid tester session is required",
        ));
    };
    if payload.get("role").and_then(Value::as_str) != Some(TESTER_ROLE) {
        return Err(ApiError::new(
            401,
            "UNAUTHENTICATED",
            "A valid tester session is required",
        ));
    }
    let subject = payload
        .get("sub")
        .and_then(Value::as_str)
        .unwrap_or("tester")
        .to_owned();
    handle_authenticated(state, request, &subject, true).await
}

/// `/control/*`. The Sandbox core plane presents `x-fake-rails-control-token`.
pub async fn handle_control(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let expected = state.config.control_token.clone().unwrap_or_default();
    if expected.is_empty() {
        if state.config.node_env == "production" {
            return Err(ApiError::new(
                503,
                "FAKE_RAILS_CONTROL_DISABLED",
                "The Fake Rails control plane requires FAKE_RAILS_CONTROL_TOKEN in production",
            ));
        }
    } else {
        let supplied = request
            .header("x-fake-rails-control-token")
            .unwrap_or_default()
            .trim()
            .to_owned();
        if supplied.is_empty()
            || !constant_time_eq(
                &sha256_hex(supplied.as_bytes()),
                &sha256_hex(expected.as_bytes()),
            )
        {
            return Err(ApiError::new(
                401,
                "FAKE_RAILS_CONTROL_UNAUTHORIZED",
                "A valid control token is required",
            ));
        }
    }
    handle_authenticated(state, request, "sandbox-control", false).await
}

fn environment_label(state: &AppState) -> &'static str {
    if state.config.node_env == "production" {
        "PRODUCTION TEST SERVER"
    } else {
        "SANDBOX"
    }
}

fn login(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let body = request.parse_json_strict()?;
    let attempted_user = body
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let ip_bucket = format!(
        "ip:{}",
        request
            .peer
            .map_or_else(|| "unknown".to_owned(), |peer| peer.to_string())
    );
    let account_bucket = format!("acct:{}", attempted_user.trim().to_ascii_lowercase());
    if is_rate_limited(state, &ip_bucket, state.config.portal_rate_limit)
        || (!attempted_user.is_empty()
            && is_rate_limited(state, &account_bucket, state.config.portal_account_lockout))
    {
        return Err(ApiError::new(
            429,
            "TOO_MANY_ATTEMPTS",
            "Too many failed login attempts; try again later",
        ));
    }
    let username = body
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| invalid_body_details("username", "must be 1-128 characters"))?
        .to_owned();
    let password = body
        .get("password")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| invalid_body_details("password", "must be 1-512 characters"))?;
    let valid_user = constant_time_eq(
        &sha256_hex(username.as_bytes()),
        &sha256_hex(state.config.admin_user.as_bytes()),
    );
    let valid_password = constant_time_eq(
        &sha256_hex(password.as_bytes()),
        &sha256_hex(state.config.admin_password.as_bytes()),
    );
    if !valid_user || !valid_password {
        record_failure(state, &ip_bucket);
        record_failure(state, &account_bucket);
        return Err(ApiError::new(
            401,
            "INVALID_CREDENTIALS",
            "Invalid username or password",
        ));
    }
    clear_failures(state, &ip_bucket);
    clear_failures(state, &account_bucket);
    let token = sign_jwt(
        &[
            ("sub", json!(state.config.admin_user)),
            ("role", json!(TESTER_ROLE)),
            ("allowInProduction", json!(state.config.allow_in_production)),
        ],
        &state.config.jwt_secret,
        JWT_TTL_SECONDS,
    );
    Ok(AppResponse::json(
        200,
        json!({
            "token": token,
            "user": {
                "username": state.config.admin_user,
                "allowInProduction": state.config.allow_in_production,
                "environment": environment_label(state),
            },
        }),
    ))
}

fn is_rate_limited(state: &AppState, bucket: &str, limit: u32) -> bool {
    let now = AppState::now_ms();
    let window = state.config.portal_rate_window_ms;
    let Ok(mut attempts) = state.login_attempts.lock() else {
        return false;
    };
    let failures = attempts.entry(bucket.to_owned()).or_default();
    failures.retain(|at| now - *at < window);
    failures.len() >= limit as usize
}

fn record_failure(state: &AppState, bucket: &str) {
    if let Ok(mut attempts) = state.login_attempts.lock() {
        attempts
            .entry(bucket.to_owned())
            .or_default()
            .push(AppState::now_ms());
    }
}

fn clear_failures(state: &AppState, bucket: &str) {
    if let Ok(mut attempts) = state.login_attempts.lock() {
        attempts.remove(bucket);
    }
}

fn consume_sse_ticket(state: &AppState, ticket: &str) -> bool {
    let Some(payload) = verify_jwt(ticket, &state.config.jwt_secret) else {
        return false;
    };
    if payload.get("role").and_then(Value::as_str) != Some(SSE_TICKET_ROLE) {
        return false;
    }
    let (Some(jti), Some(exp)) = (
        payload.get("jti").and_then(Value::as_str),
        payload.get("exp").and_then(Value::as_i64),
    ) else {
        return false;
    };
    let now = AppState::now_ms();
    let Ok(mut used) = state.used_tickets.lock() else {
        return false;
    };
    used.retain(|_, expires_at| *expires_at * 1000 > now);
    if used.contains_key(jti) {
        return false;
    }
    used.insert(jti.to_owned(), exp);
    true
}

fn verified_hosted_action_token(
    state: &AppState,
    token: Option<&str>,
    transaction_id: &str,
) -> bool {
    let Some(token) = token else {
        return false;
    };
    let Some(payload) = verify_jwt(token, &state.config.jwt_secret) else {
        return false;
    };
    payload.get("role").and_then(Value::as_str) == Some(HOSTED_ACTION_ROLE)
        && payload.get("sub").and_then(Value::as_str) == Some(transaction_id)
}

// ---------------------------------------------------------------------------------------------
// Routing after authentication
// ---------------------------------------------------------------------------------------------

async fn handle_authenticated(
    state: &AppState,
    request: &IncomingRequest,
    actor: &str,
    allow_auth_routes: bool,
) -> ApiResult<AppResponse> {
    let path = request.path.as_str();
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match segments.as_slice() {
        ["auth", "me"] if allow_auth_routes => Ok(AppResponse::json(
            200,
            json!({"user": {"username": actor, "role": TESTER_ROLE, "environment": environment_label(state)}}),
        )),
        ["transactions"] if request.method == "GET" => list_transaction_route(state, request),
        ["transactions", "stream-ticket"] if request.method == "POST" => {
            let ticket = sign_jwt(
                &[
                    ("sub", json!(actor)),
                    ("role", json!(SSE_TICKET_ROLE)),
                    ("jti", json!(uuid_v7())),
                ],
                &state.config.jwt_secret,
                SSE_TICKET_TTL_SECONDS,
            );
            Ok(AppResponse::json(
                200,
                json!({"ticket": ticket, "expiresInSeconds": SSE_TICKET_TTL_SECONDS}),
            ))
        }
        ["transactions", "stream"] => Ok(AppResponse::sse()),
        ["transactions", "summary"] => transaction_summary(state),
        ["transactions", id] => transaction_detail(state, id),
        ["transactions", id, "action"] if request.method == "POST" => {
            transaction_action(state, request, actor, id)
        }
        ["transactions", id, "events"] => {
            let transaction = transaction_for(state, id)?;
            Ok(AppResponse::json(
                200,
                json!({"events": list_step_events(&state.db, &transaction.id)?}),
            ))
        }
        ["scenarios"] if request.method == "GET" => Ok(AppResponse::json(
            200,
            json!({
                "rails": RAIL_DESCRIPTORS.iter().map(descriptor_json).collect::<Vec<_>>(),
                "scenarios": list_scenarios(&state.db)?,
            }),
        )),
        ["scenarios", "reset"] if request.method == "POST" => {
            let scenarios = reset_all_scenarios(&state.db)?;
            state
                .hub
                .broadcast("scenario.reset", json!({"count": scenarios.len()}));
            Ok(AppResponse::json(200, json!({"scenarios": scenarios})))
        }
        ["scenarios", "global", preset] if request.method == "POST" => {
            let mut scenarios = Vec::new();
            for rail in &RAIL_DESCRIPTORS {
                let base = get_scenario(&state.db, rail.rail_code)?;
                let updated = apply_preset(&base, preset)
                    .ok_or_else(|| ApiError::new(400, "UNKNOWN_PRESET", "Unknown preset"))?;
                scenarios.push(save_scenario(&state.db, &updated)?);
            }
            state.hub.broadcast(
                "scenario.reset",
                json!({"preset": preset, "count": scenarios.len()}),
            );
            Ok(AppResponse::json(200, json!({"scenarios": scenarios})))
        }
        ["scenarios", "preset", rail, preset] if request.method == "POST" => {
            let descriptor = resolve_rail(rail)
                .ok_or_else(|| ApiError::new(404, "UNKNOWN_RAIL", "Unknown rail"))?;
            let base = get_scenario(&state.db, descriptor.rail_code)?;
            let updated = apply_preset(&base, preset)
                .ok_or_else(|| ApiError::new(400, "UNKNOWN_PRESET", "Unknown preset"))?;
            let saved = save_scenario(&state.db, &updated)?;
            state.hub.broadcast(
                "scenario.updated",
                json!({"railCode": saved.rail_code, "scenario": saved}),
            );
            Ok(AppResponse::json(200, json!({"scenario": saved})))
        }
        ["scenarios", rail, "audit"] if request.method == "GET" => {
            let rows = state.db.query_json(
                "SELECT * FROM fake_portal_audit WHERE target = ? ORDER BY created_at DESC LIMIT 100",
                vec![crate::db::text(*rail)],
            )?;
            Ok(AppResponse::json(
                200,
                json!({"audit": rows, "at": now_iso()}),
            ))
        }
        ["scenarios", rail] => scenario_route(state, request, rail),
        ["webhooks"] if request.method == "GET" => {
            let transaction_id = request.query.get("transactionId").map(String::as_str);
            Ok(AppResponse::json(
                200,
                json!({"deliveries": state.webhooks.list(transaction_id)?}),
            ))
        }
        ["webhooks", id, "replay"] if request.method == "POST" => {
            let tamper = request.query.get("tamper").map(String::as_str) == Some("true");
            let delivery = state
                .webhooks
                .replay(id, tamper)?
                .ok_or_else(|| ApiError::new(404, "DELIVERY_NOT_FOUND", "Unknown delivery"))?;
            state.hub.broadcast(
                "webhook.replayed",
                json!({"deliveryId": delivery["id"], "tamper": tamper}),
            );
            Ok(AppResponse::json(200, json!({"delivery": delivery})))
        }
        ["webhooks", id, "send-now"] if request.method == "POST" => {
            let delivery = state
                .webhooks
                .send(id)
                .await?
                .ok_or_else(|| ApiError::new(404, "DELIVERY_NOT_FOUND", "Unknown delivery"))?;
            Ok(AppResponse::json(200, json!({"delivery": delivery})))
        }
        ["webhooks", id, "fire"] if request.method == "POST" => fire_webhook(state, request, id),
        ["webhooks", id, "dispute"] if request.method == "POST" => dispute_webhook(state, id),
        ["statements"] if request.method == "GET" => {
            let rows = state.db.query_json(
                "SELECT * FROM fake_statements ORDER BY created_at DESC LIMIT 100",
                vec![],
            )?;
            Ok(AppResponse::json(200, json!({"statements": rows})))
        }
        ["statements", "generate"] if request.method == "POST" => {
            generate_statement_route(state, request)
        }
        ["accounts"] if request.method == "GET" => accounts_route(state, request),
        ["accounts"] if request.method == "POST" => create_account_route(state, request),
        ["accounts", "reset"] if request.method == "POST" => {
            let body = request.json_body();
            let merchant_id = body.get("merchantId").and_then(Value::as_str);
            let removed = reset_accounts(&state.db, merchant_id)?;
            Ok(AppResponse::json(
                200,
                json!({"ok": true, "removed": removed, "merchantId": merchant_id}),
            ))
        }
        ["accounts", id] if request.method == "GET" => {
            let account = get_account(&state.db, id)?.ok_or_else(|| {
                ApiError::new(
                    404,
                    "FAKE_ACCOUNT_NOT_FOUND",
                    format!("Account {id} not found"),
                )
            })?;
            Ok(AppResponse::json(
                200,
                json!({"account": account_json(&account)}),
            ))
        }
        ["accounts", id] if request.method == "PATCH" => patch_account_route(state, request, id),
        ["accounts", id, "movements"] => {
            ensure_account(state, id)?;
            let limit = query_i64(request, "limit", 100);
            Ok(AppResponse::json(
                200,
                json!({"movements": list_account_movements(&state.db, id, limit)?}),
            ))
        }
        ["accounts", id, "holds"] => {
            ensure_account(state, id)?;
            let limit = query_i64(request, "limit", 100);
            Ok(AppResponse::json(
                200,
                json!({"holds": list_account_holds(&state.db, id, limit)?}),
            ))
        }
        ["accounts", id, "restore"] if request.method == "POST" => {
            let restored = restore_preset_account(&state.db, id)?;
            state.hub.broadcast(
                "account.updated",
                json!({"account": account_json(&restored)}),
            );
            Ok(AppResponse::json(
                200,
                json!({"account": account_json(&restored)}),
            ))
        }
        ["checkout-helper", reference] if request.method == "GET" => {
            checkout_helper(state, reference)
        }
        ["checkout-helper", reference, "simulate-action"] if request.method == "POST" => {
            checkout_simulate(state, request, reference)
        }
        ["clearing", "pools"] => Ok(AppResponse::json(
            200,
            json!({"pools": list_clearing_pools(&state.db)?}),
        )),
        ["clearing", "generate-statement"] if request.method == "POST" => {
            clearing_statement(state, request)
        }
        ["clearing", "mark-included"] if request.method == "POST" => {
            let body = request.json_body();
            let entry_ids: Vec<String> = body
                .get("entryIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let run_id = body
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if run_id.is_empty() {
                return Ok(AppResponse::json(
                    400,
                    json!({"code": "RUN_ID_REQUIRED", "message": "runId is required"}),
                ));
            }
            let updated = mark_statement_included(&state.db, &entry_ids, run_id)?;
            Ok(AppResponse::json(
                200,
                json!({"ok": true, "updated": updated}),
            ))
        }
        ["clearing", "settle"] if request.method == "POST" => {
            let body = request.json_body();
            let gateway_code = body.get("gatewayCode").and_then(Value::as_str);
            let settled = mark_clearing_settled(&state.db, gateway_code)?;
            Ok(AppResponse::json(
                200,
                json!({"ok": true, "settled": settled}),
            ))
        }
        ["hosted", "session", id] if request.method == "GET" => hosted_session(state, id),
        ["hosted", "session", id, "action"] if request.method == "POST" => {
            hosted_action(state, request, id)
        }
        ["internal", "seeder-handshake"] if request.method == "POST" => {
            let count = state
                .db
                .count("SELECT COUNT(*) FROM fake_transactions", vec![])?;
            let check = request
                .json_body()
                .get("check")
                .cloned()
                .unwrap_or(Value::Null);
            Ok(AppResponse::json(
                200,
                json!({
                    "ok": true,
                    "service": "fake-rails-back",
                    "ready": true,
                    "rails": RAIL_DESCRIPTORS.len(),
                    "transactionCount": count,
                    "at": now_iso(),
                    "check": check,
                }),
            ))
        }
        ["internal", "bulk-seed"] if request.method == "POST" => bulk_seed(state, request),
        _ => Err(ApiError::new(404, "NOT_FOUND", "Route not found")),
    }
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

fn query_i64(request: &IncomingRequest, name: &str, default: i64) -> i64 {
    request
        .query
        .get(name)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(default)
}

fn list_transaction_route(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let (rows, total) = list_transactions(
        &state.db,
        &TransactionFilters {
            rail_code: request.query.get("railCode").cloned(),
            gateway_code: request.query.get("gatewayCode").cloned(),
            status: request.query.get("status").cloned(),
            reference: request.query.get("reference").cloned(),
            from: request.query.get("from").cloned(),
            to: request.query.get("to").cloned(),
            limit: request.query.get("limit").and_then(|v| v.parse().ok()),
            offset: request.query.get("offset").and_then(|v| v.parse().ok()),
        },
    )?;
    Ok(AppResponse::json(
        200,
        json!({"total": total, "rows": rows}),
    ))
}

fn transaction_summary(state: &AppState) -> ApiResult<AppResponse> {
    let totals = state.db.query_json(
        "SELECT status, COUNT(*) AS count, COALESCE(SUM(CAST(normalized_amount_lyd AS REAL)), 0) AS amount
         FROM fake_transactions GROUP BY status",
        vec![],
    )?;
    let rails = state.db.query_json(
        "SELECT rail_code, COUNT(*) AS count FROM fake_transactions GROUP BY rail_code ORDER BY count DESC",
        vec![],
    )?;
    let pending = state.db.query_json(
        "SELECT id, rail_code, gateway_code, our_reference, provider_reference, expected_otp,
                normalized_amount_lyd, collection_mode, created_at
         FROM fake_transactions WHERE status IN ('AWAITING_ACTION','INITIATED')
         ORDER BY created_at DESC LIMIT 50",
        vec![],
    )?;
    Ok(AppResponse::json(
        200,
        json!({
            "totals": totals,
            "rails": rails,
            "pendingActions": pending,
            "at": now_iso(),
        }),
    ))
}

fn transaction_for(state: &AppState, id: &str) -> ApiResult<Transaction> {
    find_transaction_any(&state.db, id)?.ok_or_else(|| {
        ApiError::new(
            404,
            "TRANSACTION_NOT_FOUND",
            format!("No fake transaction '{id}'"),
        )
    })
}

fn transaction_detail(state: &AppState, id: &str) -> ApiResult<AppResponse> {
    let transaction = transaction_for(state, id)?;
    Ok(AppResponse::json(
        200,
        json!({
            "transaction": transaction_json(&transaction),
            "events": list_step_events(&state.db, &transaction.id)?,
            "deliveries": state.webhooks.list(Some(&transaction.id))?,
        }),
    ))
}

fn transaction_action(
    state: &AppState,
    request: &IncomingRequest,
    actor: &str,
    id: &str,
) -> ApiResult<AppResponse> {
    let transaction = transaction_for(state, id)?;
    let body = request.json_body();
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_body_details("action", "is required"))?
        .to_owned();
    if ![
        "APPROVE",
        "REJECT",
        "APPROVE_MISMATCH",
        "APPROVE_LATE",
        "FORCE_OUTCOME",
        "CANCEL",
    ]
    .contains(&action.as_str())
    {
        return Err(invalid_body_details("action", "unknown action"));
    }
    assert_open(&transaction, &action)?;
    match action.as_str() {
        "APPROVE" => {
            let _ = capture_hold(&state.db, &transaction.id, None);
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    (
                        "settled_amount_lyd",
                        json!(transaction.normalized_amount_lyd),
                    ),
                ],
            )?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                json!({
                    "reference": transaction.our_reference,
                    "provider_reference": transaction.provider_reference,
                    "amount": transaction.normalized_amount_lyd,
                    "currency": transaction.currency,
                    "status": "PAID",
                }),
                WebhookBehavior::default(),
            )?;
        }
        "APPROVE_MISMATCH" => {
            let settled = lyd(micros(&transaction.normalized_amount_lyd) + 500);
            let _ = capture_hold(&state.db, &transaction.id, Some(&settled));
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    ("settled_amount_lyd", json!(settled)),
                ],
            )?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                json!({
                    "reference": transaction.our_reference,
                    "provider_reference": transaction.provider_reference,
                    "amount": settled,
                    "currency": transaction.currency,
                    "status": "PAID",
                }),
                WebhookBehavior::default(),
            )?;
        }
        "APPROVE_LATE" => {
            let _ = capture_hold(&state.db, &transaction.id, None);
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    (
                        "settled_amount_lyd",
                        json!(transaction.normalized_amount_lyd),
                    ),
                ],
            )?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                json!({
                    "reference": transaction.our_reference,
                    "provider_reference": transaction.provider_reference,
                    "amount": transaction.normalized_amount_lyd,
                    "currency": transaction.currency,
                    "status": "PAID",
                    "late": true,
                }),
                WebhookBehavior {
                    delay_seconds: 1.0,
                    ..WebhookBehavior::default()
                },
            )?;
        }
        "REJECT" => {
            let _ = release_hold(
                &state.db,
                &transaction.id,
                "Rejected by the Fake Rails tester",
            );
            update_transaction(&state.db, &transaction.id, &[("status", json!("FAILED"))])?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.failed",
                json!({
                    "reference": transaction.our_reference,
                    "provider_reference": transaction.provider_reference,
                    "status": "FAILED",
                    "error": "DECLINED_BY_CUSTOMER",
                }),
                WebhookBehavior::default(),
            )?;
        }
        "CANCEL" => {
            let _ = release_hold(
                &state.db,
                &transaction.id,
                "Cancelled by the Fake Rails tester",
            );
            update_transaction(
                &state.db,
                &transaction.id,
                &[("status", json!("CANCELLED"))],
            )?;
        }
        "FORCE_OUTCOME" => {
            let phase = body
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("SUBMIT");
            let mode = body
                .get("failureMode")
                .and_then(Value::as_str)
                .unwrap_or("TERMINAL_DECLINE_INSUFFICIENT_FUNDS");
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("assigned_fail_phase", json!(phase)),
                    ("assigned_failure_mode", json!(mode)),
                ],
            )?;
        }
        _ => {}
    }
    state.db.execute(
        "INSERT INTO fake_portal_audit (id, actor, action, target, payload_json, created_at) VALUES (?,?,?,?,?,?)",
        vec![
            crate::db::text(uuid_v7()),
            crate::db::text(actor),
            crate::db::text(action.clone()),
            crate::db::text(transaction.id.clone()),
            crate::db::text(body.to_string()),
            crate::db::text(now_iso()),
        ],
    )?;
    state.hub.broadcast(
        "transaction.action",
        json!({"transactionId": transaction.id, "action": action, "actor": actor}),
    );
    let updated = transaction_for(state, &transaction.id)?;
    Ok(AppResponse::json(
        200,
        json!({"ok": true, "transaction": transaction_json(&updated)}),
    ))
}

fn assert_open(transaction: &Transaction, action: &str) -> ApiResult<()> {
    if TERMINAL_STATUSES.contains(&transaction.status.as_str())
        && !(action == "APPROVE" && transaction.status == "PAID")
    {
        return Err(ApiError::new(
            409,
            "TRANSACTION_STATE_INVALID",
            format!(
                "Cannot {} a transaction in status {}",
                action.to_ascii_lowercase().replace('_', " "),
                transaction.status
            ),
        ));
    }
    Ok(())
}

fn dispatch_action_webhook(
    state: &AppState,
    transaction: &Transaction,
    event: &str,
    payload: Value,
    behavior: WebhookBehavior,
) -> ApiResult<()> {
    state.webhooks.dispatch(&DispatchInput {
        transaction,
        event,
        payload,
        url: None,
        behavior,
        headers: BTreeMap::new(),
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

fn scenario_route(
    state: &AppState,
    request: &IncomingRequest,
    rail: &str,
) -> ApiResult<AppResponse> {
    match request.method.as_str() {
        "GET" => Ok(AppResponse::json(
            200,
            json!({"scenario": get_scenario(&state.db, rail)?}),
        )),
        "PUT" => {
            let descriptor = resolve_rail(rail)
                .ok_or_else(|| ApiError::new(404, "UNKNOWN_RAIL", "Unknown rail"))?;
            let base = get_scenario(&state.db, descriptor.rail_code)?;
            let merged = merge_scenario(&base, &request.json_body());
            let saved = save_scenario(&state.db, &merged)?;
            state.hub.broadcast(
                "scenario.updated",
                json!({"railCode": saved.rail_code, "scenario": saved}),
            );
            Ok(AppResponse::json(200, json!({"scenario": saved})))
        }
        _ => Err(ApiError::new(404, "NOT_FOUND", "Route not found")),
    }
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

fn fire_webhook(state: &AppState, request: &IncomingRequest, id: &str) -> ApiResult<AppResponse> {
    let transaction = transaction_for(state, id)?;
    let body = request.json_body();
    let event = body
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("payment.paid");
    let behavior = WebhookBehavior {
        delay_seconds: body
            .get("delaySeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 3600.0),
        duplicate_count: body
            .get("duplicateCount")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(1.0, 5.0),
        out_of_order_pending_after_paid: body
            .get("outOfOrderPendingAfterPaid")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        corrupt_signature_chance_percent: body
            .get("corruptSignatureChancePercent")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 100.0),
    };
    let status = body.get("status").and_then(Value::as_str).unwrap_or("PAID");
    let deliveries = state.webhooks.dispatch(&DispatchInput {
        transaction: &transaction,
        event,
        payload: json!({
            "reference": transaction.our_reference,
            "provider_reference": transaction.provider_reference,
            "amount": transaction.settled_amount_lyd.clone().unwrap_or_else(|| transaction.normalized_amount_lyd.clone()),
            "currency": transaction.currency,
            "status": status,
        }),
        url: None,
        behavior,
        headers: BTreeMap::new(),
    })?;
    state.hub.broadcast(
        "webhook.queued",
        json!({"transactionId": transaction.id, "count": deliveries.len()}),
    );
    Ok(AppResponse::json(202, json!({"deliveries": deliveries})))
}

fn dispute_webhook(state: &AppState, id: &str) -> ApiResult<AppResponse> {
    let transaction = transaction_for(state, id)?;
    let deliveries = state.webhooks.dispatch(&DispatchInput {
        transaction: &transaction,
        event: "DISPUTE_OPENED",
        payload: json!({
            "reference": transaction.our_reference,
            "provider_reference": transaction.provider_reference,
            "external_dispute_ref": format!("DSP-{}", transaction.provider_reference),
            "amount": transaction.settled_amount_lyd.clone().unwrap_or_else(|| transaction.normalized_amount_lyd.clone()),
            "currency": transaction.currency,
            "status": "DISPUTE_OPENED",
            "reason_code": "FRAUD",
        }),
        url: None,
        behavior: WebhookBehavior::default(),
        headers: BTreeMap::new(),
    })?;
    state.hub.broadcast(
        "webhook.dispute",
        json!({"transactionId": transaction.id, "count": deliveries.len()}),
    );
    Ok(AppResponse::json(202, json!({"deliveries": deliveries})))
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

fn generate_statement_route(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let body = request.json_body();
    let gateway_code = body
        .get("gatewayCode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 60)
        .ok_or_else(|| invalid_body_details("gatewayCode", "is required"))?
        .to_owned();
    let format = body.get("format").and_then(Value::as_str).unwrap_or("csv");
    if !["csv", "json", "xlsx"].contains(&format) {
        return Err(invalid_body_details("format", "must be csv, json or xlsx"));
    }
    let anomalies_body = body.get("anomalies").cloned().unwrap_or(Value::Null);
    let anomalies = Anomalies {
        fee_variance_percent: anomalies_body
            .get("feeVariancePercent")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 100.0),
        fee_variance_amount: anomalies_body
            .get("feeVarianceAmount")
            .and_then(Value::as_f64)
            .unwrap_or(0.15)
            .max(0.0),
        omit_one: anomalies_body
            .get("omitOne")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        add_unrecorded: anomalies_body
            .get("addUnrecorded")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let from = body.get("from").and_then(Value::as_str);
    let to = body.get("to").and_then(Value::as_str);
    let generated = generate_statement(&state.db, &gateway_code, from, to, format, &anomalies)?;
    state.hub.broadcast(
        "statement.generated",
        json!({
            "id": generated.id,
            "gatewayCode": generated.gateway_code,
            "format": generated.format,
            "rows": generated.lines.len(),
        }),
    );
    match format {
        "json" => {
            let lines: Vec<Value> = generated.lines.iter().map(|line| line.to_json()).collect();
            Ok(AppResponse::json(
                200,
                json!({
                    "id": generated.id,
                    "gatewayCode": generated.gateway_code,
                    "from": generated.from,
                    "to": generated.to,
                    "lines": lines,
                }),
            ))
        }
        "xlsx" => {
            let bytes = statement_xlsx(&gateway_code, &generated.lines);
            Ok(AppResponse::bytes(
                200,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                bytes,
            )
            .with_header(
                "content-disposition",
                format!("attachment; filename=\"{gateway_code}-statement.xlsx\""),
            ))
        }
        _ => Ok(
            AppResponse::text(200, "text/csv", to_csv(&generated.lines)).with_header(
                "content-disposition",
                format!("attachment; filename=\"{gateway_code}-statement.csv\""),
            ),
        ),
    }
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

fn account_json(account: &crate::accounts::Account) -> Value {
    json!({
        "id": account.id,
        "rail_code": account.rail_code,
        "gateway_code": account.gateway_code,
        "merchant_id": account.merchant_id,
        "instrument_type": account.instrument_type,
        "identifier": account.identifier,
        "holder_name": account.holder_name,
        "secret_pin": account.secret_pin,
        "expiry": account.expiry,
        "currency": account.currency,
        "available_balance_lyd": account.available_balance_lyd,
        "reserved_balance_lyd": account.reserved_balance_lyd,
        "daily_limit_lyd": account.daily_limit_lyd,
        "daily_spent_lyd": account.daily_spent_lyd,
        "daily_spent_date": account.daily_spent_date,
        "status": account.status,
        "static_otp": account.static_otp,
        "preset_fault": account.preset_fault,
        "notes": account.notes,
        "created_at": account.created_at,
        "updated_at": account.updated_at,
    })
}

fn accounts_route(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let page = request
        .query
        .get("page")
        .and_then(|value| value.parse::<i64>().ok());
    let page_size = request
        .query
        .get("pageSize")
        .and_then(|value| value.parse::<i64>().ok());
    let search = request.query.get("search").cloned();
    let filters = AccountFilters {
        rail_code: request.query.get("railCode").cloned(),
        gateway_code: request.query.get("gatewayCode").cloned(),
        merchant_id: request.query.get("merchantId").cloned(),
        status: request.query.get("status").cloned(),
        instrument_type: request.query.get("instrumentType").cloned(),
        scope: request.query.get("scope").cloned(),
        created_from: request.query.get("from").cloned(),
        created_to: request.query.get("to").cloned(),
        search: search.clone(),
        page,
        page_size,
        include_global: request.query.get("includeGlobal").map(String::as_str) == Some("true"),
    };
    if page.is_some() || page_size.is_some() || search.is_some() {
        let result = list_accounts_page(&state.db, &filters)?;
        return Ok(AppResponse::json(
            200,
            json!({
                "accounts": result.accounts,
                "total": result.total,
                "page": result.page,
                "pageSize": result.page_size,
            }),
        ));
    }
    Ok(AppResponse::json(
        200,
        json!({"accounts": list_accounts(&state.db, &filters)?}),
    ))
}

fn ensure_amount(field: &str, value: &str) -> ApiResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 19
        && value.chars().next().is_some_and(|ch| ch.is_ascii_digit())
        && value.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
        && value.matches('.').count() <= 1
        && value
            .split_once('.')
            .is_none_or(|(_, fraction)| fraction.len() <= 4);
    if valid {
        Ok(())
    } else {
        Err(invalid_body_details(
            field,
            "must be a decimal amount with at most 4 decimals",
        ))
    }
}

fn create_account_route(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let body = request.json_body();
    let rail_code = body
        .get("railCode")
        .and_then(Value::as_str)
        .filter(|value| value.len() >= 2 && value.len() <= 64)
        .ok_or_else(|| invalid_body_details("railCode", "is required"))?;
    let gateway_code = body
        .get("gatewayCode")
        .and_then(Value::as_str)
        .filter(|value| value.len() >= 2 && value.len() <= 64)
        .ok_or_else(|| invalid_body_details("gatewayCode", "is required"))?;
    let merchant_id = match body.get("merchantId") {
        Some(Value::String(value)) if is_uuid(value) => Some(value.as_str()),
        Some(Value::Null) | None => None,
        _ => return Err(invalid_body_details("merchantId", "must be a UUID")),
    };
    let instrument_type = body
        .get("instrumentType")
        .and_then(Value::as_str)
        .unwrap_or("MOBILE_WALLET");
    if !crate::accounts::INSTRUMENT_TYPES.contains(&instrument_type) {
        return Err(invalid_body_details(
            "instrumentType",
            "unknown instrument type",
        ));
    }
    let identifier = body
        .get("identifier")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.len() >= 3 && value.len() <= 64)
        .ok_or_else(|| invalid_body_details("identifier", "must be 3-64 characters"))?;
    let holder_name = body
        .get("holderName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.len() >= 2 && value.len() <= 120)
        .ok_or_else(|| invalid_body_details("holderName", "must be 2-120 characters"))?;
    let secret_pin = body
        .get("secretPin")
        .and_then(Value::as_str)
        .unwrap_or("1234");
    if secret_pin.len() < 3 || secret_pin.len() > 16 {
        return Err(invalid_body_details("secretPin", "must be 3-16 characters"));
    }
    let available = body
        .get("availableBalanceLyd")
        .and_then(Value::as_str)
        .unwrap_or("5000.0000");
    ensure_amount("availableBalanceLyd", available)?;
    let daily_limit = body
        .get("dailyLimitLyd")
        .and_then(Value::as_str)
        .unwrap_or("10000.0000");
    ensure_amount("dailyLimitLyd", daily_limit)?;
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("ACTIVE");
    if !crate::accounts::ACCOUNT_STATUSES.contains(&status) {
        return Err(invalid_body_details("status", "unknown account status"));
    }
    let static_otp = body.get("staticOtp").and_then(Value::as_str);
    if let Some(otp) = static_otp {
        if otp.len() < 4 || otp.len() > 8 || !otp.chars().all(|ch| ch.is_ascii_digit()) {
            return Err(invalid_body_details("staticOtp", "must be 4-8 digits"));
        }
    }
    let expiry = body.get("expiry").and_then(Value::as_str);
    let notes = body.get("notes").and_then(Value::as_str);
    let account = create_account(
        &state.db,
        &NewAccount {
            rail_code,
            gateway_code,
            merchant_id,
            instrument_type,
            identifier,
            holder_name,
            secret_pin,
            expiry,
            available_balance_lyd: available,
            daily_limit_lyd: daily_limit,
            status,
            static_otp,
            notes,
        },
    )?;
    Ok(AppResponse::json(
        201,
        json!({"account": account_json(&account)}),
    ))
}

fn patch_account_route(
    state: &AppState,
    request: &IncomingRequest,
    id: &str,
) -> ApiResult<AppResponse> {
    let body = request.json_body();
    let current = get_account(&state.db, id)?.ok_or_else(|| {
        ApiError::new(
            404,
            "FAKE_ACCOUNT_NOT_FOUND",
            format!("Account {id} not found"),
        )
    })?;
    let mut available = body
        .get("availableBalanceLyd")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let delta = body.get("deltaLyd").and_then(Value::as_str);
    if let Some(value) = &available {
        ensure_amount("availableBalanceLyd", value)?;
    }
    if let Some(value) = delta {
        ensure_amount("deltaLyd", value)?;
    }
    let mut daily_spent = body
        .get("dailySpentLyd")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let quick = body.get("quickPreset").and_then(Value::as_str);
    if let Some(quick) = quick {
        if !crate::accounts::QUICK_PRESETS.contains(&quick) {
            return Err(invalid_body_details("quickPreset", "unknown preset"));
        }
        match quick {
            "SET_ZERO" => available = Some("0.0000".to_owned()),
            "SET_LINK_AMOUNT" => {
                let amount = body
                    .get("linkAmountLyd")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_body_details("linkAmountLyd", "is required"))?;
                ensure_amount("linkAmountLyd", amount)?;
                available = Some(lyd(micros(amount)));
            }
            "TOP_UP_5000" => {
                available = Some(lyd(
                    micros(&current.available_balance_lyd) + micros("5000.0000")
                ));
            }
            "RESET_DAILY_SPENT" => daily_spent = Some("0.0000".to_owned()),
            _ => {}
        }
    }
    let daily_limit = body.get("dailyLimitLyd").and_then(Value::as_str);
    if let Some(value) = daily_limit {
        ensure_amount("dailyLimitLyd", value)?;
    }
    if let Some(value) = &daily_spent {
        ensure_amount("dailySpentLyd", value)?;
    }
    let status = body.get("status").and_then(Value::as_str);
    if let Some(status) = status {
        if !crate::accounts::ACCOUNT_STATUSES.contains(&status) {
            return Err(invalid_body_details("status", "unknown account status"));
        }
    }
    let static_otp = match body.get("staticOtp") {
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => {
            if value.len() < 4 || value.len() > 8 || !value.chars().all(|ch| ch.is_ascii_digit()) {
                return Err(invalid_body_details("staticOtp", "must be 4-8 digits"));
            }
            Some(Some(value.as_str()))
        }
        _ => None,
    };
    let preset_fault = match body.get("presetFault") {
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => None,
    };
    let reason = body.get("reason").and_then(Value::as_str).map_or_else(
        || format!("Quick preset: {}", quick.unwrap_or("manual edit")),
        str::to_owned,
    );
    let updated = adjust_account(
        &state.db,
        &AdjustAccount {
            account_id: id,
            available_balance_lyd: available.as_deref(),
            delta_lyd: delta,
            daily_limit_lyd: daily_limit,
            daily_spent_lyd: daily_spent.as_deref(),
            status,
            static_otp,
            preset_fault,
            actor: None,
            reason: Some(&reason),
        },
    )?;
    state.hub.broadcast(
        "account.updated",
        json!({"account": account_json(&updated)}),
    );
    Ok(AppResponse::json(
        200,
        json!({"account": account_json(&updated)}),
    ))
}

fn ensure_account(state: &AppState, id: &str) -> ApiResult<()> {
    get_account(&state.db, id)?.map(|_| ()).ok_or_else(|| {
        ApiError::new(
            404,
            "FAKE_ACCOUNT_NOT_FOUND",
            format!("Account {id} not found"),
        )
    })
}

fn checkout_helper(state: &AppState, reference: &str) -> ApiResult<AppResponse> {
    let Some(transaction) = find_transaction_any(&state.db, reference)? else {
        return Ok(AppResponse::json(
            200,
            json!({"activeAttemptSecrets": Value::Null}),
        ));
    };
    let hold = state.db.query_one_json(
        "SELECT * FROM fake_account_holds WHERE transaction_id = ?",
        vec![crate::db::text(transaction.id.clone())],
    )?;
    let account = match hold
        .as_ref()
        .and_then(|row| row.get("account_id"))
        .and_then(Value::as_str)
    {
        Some(account_id) => get_account(&state.db, account_id)?,
        None => None,
    };
    let events = state.db.query_json(
        "SELECT phase, response_status as status, injected_fault as fault,
                duration_ms as durationMs, created_at as createdAt
           FROM fake_step_events WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 10",
        vec![crate::db::text(transaction.id.clone())],
    )?;
    let async_modes = [
        "QR_DISPLAY",
        "PUSH_APPROVAL",
        "PAY_CODE",
        "DEEP_LINK",
        "REDIRECT",
        "EMBEDDED",
    ];
    Ok(AppResponse::json(
        200,
        json!({
            "activeAttemptSecrets": {
                "ourReference": transaction.our_reference,
                "providerReference": transaction.provider_reference,
                "expectedOtp": transaction.expected_otp,
                "collectionMode": transaction.collection_mode,
                "boundAccountIdentifier": account.as_ref().map_or_else(
                    || transaction.customer_identifier_masked.clone(),
                    |account| Some(account.identifier.clone()),
                ),
                "boundAccountBalanceAfterHoldLyd": account.as_ref().map(|account| account.available_balance_lyd.clone()),
                "heldAmountLyd": hold.as_ref().and_then(|row| row.get("amount_lyd")).cloned()
                    .or_else(|| transaction.held_amount_lyd.clone().map(Value::String)),
                "canSimulateMobilePushOrQrApproval": async_modes.contains(&transaction.collection_mode.as_str())
                    && transaction.status != "PAID",
                "qrPayload": transaction.qr_payload,
                "deepLinkUrl": transaction.deep_link_url,
                "redirectUrl": transaction.redirect_url,
                "expiresAt": transaction.updated_at,
                "recentWireEvents": events,
            },
        }),
    ))
}

fn checkout_simulate(
    state: &AppState,
    request: &IncomingRequest,
    reference: &str,
) -> ApiResult<AppResponse> {
    let transaction = find_transaction_any(&state.db, reference)?.ok_or_else(|| {
        ApiError::new(
            404,
            "FAKE_TX_NOT_FOUND",
            format!("Transaction {reference} not found"),
        )
    })?;
    let body = request.json_body();
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_body_details("action", "is required"))?;
    if ![
        "APPROVE_PUSH_OR_QR",
        "DECLINE_PUSH_OR_QR",
        "APPROVE_WITH_VARIANCE",
        "FIRE_WEBHOOK_NOW",
        "REPLAY_DUPLICATE_WEBHOOK",
        "FIRE_TAMPERED_WEBHOOK",
    ]
    .contains(&action)
    {
        return Err(invalid_body_details("action", "unknown action"));
    }
    let base_payload = json!({
        "reference": transaction.our_reference,
        "our_reference": transaction.our_reference,
        "provider_reference": transaction.provider_reference,
        "transaction_id": transaction.provider_reference,
        "amount": transaction.normalized_amount_lyd,
        "currency": transaction.currency,
    });
    match action {
        "APPROVE_PUSH_OR_QR" | "FIRE_WEBHOOK_NOW" => {
            let _ = capture_hold(&state.db, &transaction.id, None);
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    (
                        "settled_amount_lyd",
                        json!(transaction.normalized_amount_lyd),
                    ),
                ],
            )?;
            let mut payload = base_payload;
            payload["status"] = json!("PAID");
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior::default(),
            )?;
        }
        "APPROVE_WITH_VARIANCE" => {
            let settled = lyd(micros(&transaction.normalized_amount_lyd) + 500);
            let _ = capture_hold(&state.db, &transaction.id, Some(&settled));
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    ("settled_amount_lyd", json!(settled)),
                ],
            )?;
            let mut payload = base_payload;
            payload["amount"] = json!(settled);
            payload["settled_amount"] = json!(settled);
            payload["status"] = json!("PAID");
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior::default(),
            )?;
        }
        "DECLINE_PUSH_OR_QR" => {
            let _ = release_hold(
                &state.db,
                &transaction.id,
                "Customer rejected push/QR on the simulated mobile app",
            );
            update_transaction(&state.db, &transaction.id, &[("status", json!("FAILED"))])?;
            let mut payload = base_payload;
            payload["status"] = json!("FAILED");
            payload["error"] = json!("CUSTOMER_REJECTED");
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.failed",
                payload,
                WebhookBehavior::default(),
            )?;
        }
        "REPLAY_DUPLICATE_WEBHOOK" => {
            let mut payload = base_payload;
            payload["status"] = json!("PAID");
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior {
                    duplicate_count: 2.0,
                    ..WebhookBehavior::default()
                },
            )?;
        }
        "FIRE_TAMPERED_WEBHOOK" => {
            let mut payload = base_payload;
            payload["status"] = json!("PAID");
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior {
                    corrupt_signature_chance_percent: 100.0,
                    ..WebhookBehavior::default()
                },
            )?;
        }
        _ => {}
    }
    Ok(AppResponse::json(
        200,
        json!({"ok": true, "action": action, "transactionId": transaction.id}),
    ))
}

fn clearing_statement(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let body = request.json_body();
    let statement = generate_clearing_statement(
        &state.db,
        &ClearingFilters {
            from: body.get("from").and_then(Value::as_str),
            to: body.get("to").and_then(Value::as_str),
            gateway_code: body.get("gatewayCode").and_then(Value::as_str),
            merchant_id: body.get("merchantId").and_then(Value::as_str),
            include_settled: body
                .get("includeSettled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            include_included: body
                .get("includeIncluded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
    )?;
    Ok(AppResponse::json(
        200,
        json!({
            "rows": statement.rows,
            "totals": {
                "grossLyd": statement.gross_lyd,
                "refundsLyd": statement.refunds_lyd,
                "netLyd": statement.net_lyd,
                "feesLyd": statement.fees_lyd,
            },
            "csv": statement.csv,
        }),
    ))
}

// ---------------------------------------------------------------------------------------------
// Hosted pages
// ---------------------------------------------------------------------------------------------

fn hosted_session(state: &AppState, id: &str) -> ApiResult<AppResponse> {
    let transaction = transaction_for(state, id)?;
    let action_token = sign_jwt(
        &[
            ("sub", json!(transaction.id)),
            ("role", json!(HOSTED_ACTION_ROLE)),
        ],
        &state.config.jwt_secret,
        HOSTED_ACTION_TTL_SECONDS,
    );
    Ok(AppResponse::json(
        200,
        json!({
            "transaction": public_hosted_transaction(&transaction),
            "rail": resolve_rail(&transaction.rail_code).map(descriptor_json),
            "action_token": action_token,
        }),
    ))
}

fn public_hosted_transaction(transaction: &Transaction) -> Value {
    let mut object = transaction_json(transaction);
    if let Some(map) = object.as_object_mut() {
        map.remove("expected_otp");
        map.remove("webhook_url");
    }
    object
}

fn hosted_action(state: &AppState, request: &IncomingRequest, id: &str) -> ApiResult<AppResponse> {
    let transaction = transaction_for(state, id)?;
    if !verified_hosted_action_token(
        state,
        request.header("x-hosted-action-token"),
        &transaction.id,
    ) {
        return Err(ApiError::new(
            401,
            "HOSTED_ACTION_TOKEN_REQUIRED",
            "A valid X-Hosted-Action-Token for this session is required",
        ));
    }
    let body = request.json_body();
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_body_details("action", "is required"))?;
    let base = state.config.public_origin();
    let payload = json!({
        "reference": transaction.our_reference,
        "our_reference": transaction.our_reference,
        "provider_reference": transaction.provider_reference,
        "transaction_id": transaction.provider_reference,
        "amount": transaction.normalized_amount_lyd,
        "currency": transaction.currency,
        "status": "PAID",
    });
    let mut redirect_url = transaction
        .return_url
        .clone()
        .unwrap_or_else(|| format!("{base}/hosted/done"));
    match action {
        "APPROVE" => {
            let _ = capture_hold(&state.db, &transaction.id, None);
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    (
                        "settled_amount_lyd",
                        json!(transaction.normalized_amount_lyd),
                    ),
                ],
            )?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior::default(),
            )?;
        }
        "APPROVE_TAMPERED" => {
            let _ = capture_hold(&state.db, &transaction.id, None);
            update_transaction(
                &state.db,
                &transaction.id,
                &[
                    ("status", json!("PAID")),
                    (
                        "settled_amount_lyd",
                        json!(transaction.normalized_amount_lyd),
                    ),
                ],
            )?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior::default(),
            )?;
            let separator = if redirect_url.contains('?') { "&" } else { "?" };
            redirect_url = format!("{redirect_url}{separator}status=failed&amount=0.01");
        }
        "DROP_WEBHOOK" => {
            update_transaction(
                &state.db,
                &transaction.id,
                &[("status", json!("AWAITING_ACTION"))],
            )?;
        }
        "ABANDON" => {
            update_transaction(
                &state.db,
                &transaction.id,
                &[("status", json!("AWAITING_ACTION"))],
            )?;
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.paid",
                payload,
                WebhookBehavior {
                    delay_seconds: 30.0,
                    ..WebhookBehavior::default()
                },
            )?;
        }
        "DECLINE" => {
            let _ = release_hold(
                &state.db,
                &transaction.id,
                "Customer declined on the hosted page",
            );
            update_transaction(&state.db, &transaction.id, &[("status", json!("FAILED"))])?;
            let mut payload = payload;
            payload["status"] = json!("FAILED");
            payload["error"] = json!("INSUFFICIENT_FUNDS");
            dispatch_action_webhook(
                state,
                &transaction,
                "payment.failed",
                payload,
                WebhookBehavior::default(),
            )?;
            redirect_url = transaction.cancel_url.clone().unwrap_or(redirect_url);
        }
        "CANCEL" => {
            let _ = release_hold(
                &state.db,
                &transaction.id,
                "Customer cancelled on the hosted page",
            );
            update_transaction(
                &state.db,
                &transaction.id,
                &[("status", json!("CANCELLED"))],
            )?;
            redirect_url = transaction.cancel_url.clone().unwrap_or(redirect_url);
        }
        _ => return Err(invalid_body_details("action", "unknown action")),
    }
    state.hub.broadcast(
        "hosted.action",
        json!({"transactionId": transaction.id, "action": action}),
    );
    let updated = transaction_for(state, &transaction.id)?;
    Ok(AppResponse::json(
        200,
        json!({
            "ok": true,
            "action": action,
            "redirect_url": redirect_url,
            "transaction": public_hosted_transaction(&updated),
        }),
    ))
}

// ---------------------------------------------------------------------------------------------
// Seeder sync
// ---------------------------------------------------------------------------------------------

fn bulk_seed(state: &AppState, request: &IncomingRequest) -> ApiResult<AppResponse> {
    let parsed: Value = if request
        .content_type()
        .is_some_and(|value| value.starts_with("text/plain"))
    {
        let raw = request.raw_text();
        let items: Vec<Value> = raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect();
        json!({ "transactions": items, "events": [] })
    } else {
        let body = request.json_body();
        if body.is_array() {
            json!({ "transactions": body, "events": [] })
        } else {
            body
        }
    };
    let transactions = parsed
        .get("transactions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let events = parsed
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if transactions.len() > 5000 || events.len() > 5000 {
        return Err(invalid_body_details(
            "transactions",
            "at most 5000 rows per batch",
        ));
    }
    let allowed = allowed_webhook_hosts(&state.config);
    let inserted = state.db.transaction(|connection| {
        for value in &transactions {
            let transaction = transaction_from_seed(value, &allowed)?;
            crate::db::insert_transaction_conn(connection, &transaction)?;
        }
        for value in &events {
            let event = event_from_seed(value)?;
            crate::db::insert_step_event_conn(connection, &event)?;
        }
        Ok((transactions.len(), events.len()))
    })?;
    state.hub.broadcast(
        "seeder.bulk",
        json!({"transactions": inserted.0, "events": inserted.1}),
    );
    Ok(AppResponse::json(
        200,
        json!({
            "ok": true,
            "insertedTransactions": inserted.0,
            "insertedEvents": inserted.1,
            "at": now_iso(),
        }),
    ))
}

fn transaction_from_seed(value: &Value, allowed: &[String]) -> ApiResult<Transaction> {
    let text = |field: &str| -> ApiResult<String> {
        value
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| invalid_body_details(field, "is required"))
    };
    let optional_text = |field: &str| value.get(field).and_then(Value::as_str).map(str::to_owned);
    let webhook_url = optional_text("webhook_url");
    if let Some(url) = &webhook_url {
        if !webhook_target_allowed(url, allowed) {
            return Err(invalid_body_details("webhook_url", "host is not allowed"));
        }
    }
    Ok(Transaction {
        id: text("id")?,
        gateway_code: text("gateway_code")?,
        rail_code: text("rail_code")?,
        env: optional_text("env").unwrap_or_else(|| "SANDBOX".to_owned()),
        our_reference: text("our_reference")?,
        provider_reference: text("provider_reference")?,
        network_reference: optional_text("network_reference"),
        idempotency_key: optional_text("idempotency_key"),
        requested_amount_wire: text("requested_amount_wire")?,
        normalized_amount_lyd: text("normalized_amount_lyd")?,
        settled_amount_lyd: optional_text("settled_amount_lyd"),
        gateway_fee_lyd: optional_text("gateway_fee_lyd").unwrap_or_else(|| "0.0000".to_owned()),
        currency: optional_text("currency").unwrap_or_else(|| "LYD".to_owned()),
        collection_mode: text("collection_mode")?,
        customer_identifier_masked: optional_text("customer_identifier_masked"),
        expected_otp: optional_text("expected_otp"),
        merchant_id: optional_text("merchant_id"),
        qr_payload: optional_text("qr_payload"),
        deep_link_url: optional_text("deep_link_url"),
        redirect_url: optional_text("redirect_url"),
        account_id: optional_text("account_id"),
        held_amount_lyd: optional_text("held_amount_lyd"),
        status: text("status")?,
        assigned_fail_phase: optional_text("assigned_fail_phase"),
        assigned_failure_mode: optional_text("assigned_failure_mode"),
        inquiry_override_status: optional_text("inquiry_override_status"),
        return_url: optional_text("return_url"),
        cancel_url: optional_text("cancel_url"),
        webhook_url,
        is_seeded_historical: value
            .get("is_seeded_historical")
            .and_then(Value::as_i64)
            .unwrap_or(1),
        created_at: text("created_at")?,
        updated_at: text("updated_at")?,
    })
}

fn event_from_seed(value: &Value) -> ApiResult<SeedStepEvent> {
    let text = |field: &str| -> ApiResult<String> {
        value
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| invalid_body_details(field, "is required"))
    };
    Ok(SeedStepEvent {
        id: text("id")?,
        transaction_id: value
            .get("transaction_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        gateway_code: text("gateway_code")?,
        phase: text("phase")?,
        method: text("method")?,
        path: text("path")?,
        request_headers_json: value
            .get("request_headers_json")
            .and_then(Value::as_str)
            .unwrap_or("{}")
            .to_owned(),
        request_body_raw: value
            .get("request_body_raw")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        response_status: value.get("response_status").and_then(Value::as_i64),
        response_body_raw: value
            .get("response_body_raw")
            .and_then(Value::as_str)
            .map(str::to_owned),
        injected_fault: value
            .get("injected_fault")
            .and_then(Value::as_str)
            .map(str::to_owned),
        duration_ms: value
            .get("duration_ms")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        created_at: text("created_at")?,
    })
}

fn transaction_json(transaction: &Transaction) -> Value {
    json!({
        "id": transaction.id,
        "gateway_code": transaction.gateway_code,
        "rail_code": transaction.rail_code,
        "env": transaction.env,
        "our_reference": transaction.our_reference,
        "provider_reference": transaction.provider_reference,
        "network_reference": transaction.network_reference,
        "idempotency_key": transaction.idempotency_key,
        "requested_amount_wire": transaction.requested_amount_wire,
        "normalized_amount_lyd": transaction.normalized_amount_lyd,
        "settled_amount_lyd": transaction.settled_amount_lyd,
        "gateway_fee_lyd": transaction.gateway_fee_lyd,
        "currency": transaction.currency,
        "collection_mode": transaction.collection_mode,
        "customer_identifier_masked": transaction.customer_identifier_masked,
        "expected_otp": transaction.expected_otp,
        "merchant_id": transaction.merchant_id,
        "qr_payload": transaction.qr_payload,
        "deep_link_url": transaction.deep_link_url,
        "redirect_url": transaction.redirect_url,
        "account_id": transaction.account_id,
        "held_amount_lyd": transaction.held_amount_lyd,
        "status": transaction.status,
        "assigned_fail_phase": transaction.assigned_fail_phase,
        "assigned_failure_mode": transaction.assigned_failure_mode,
        "inquiry_override_status": transaction.inquiry_override_status,
        "return_url": transaction.return_url,
        "cancel_url": transaction.cancel_url,
        "webhook_url": transaction.webhook_url,
        "is_seeded_historical": transaction.is_seeded_historical,
        "created_at": transaction.created_at,
        "updated_at": transaction.updated_at,
    })
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}
