//! HTTP integration tests for the Rust Fake Rails daemon, ported from `fake-rails-back/test/**`.
//!
//! The app is served through `ntex::web::test::init_service` with a fresh in-memory SQLite store per
//! test (the daemon itself uses a WAL file; the persistence path is covered separately).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use ntex::http::{Method, Request, Response};
use ntex::web::{self, test, App, WebAppConfig};
use serde_json::{json, Value};

use fake_rails_rs::config::Config;
use fake_rails_rs::http::ntex_dispatch;
use fake_rails_rs::state::AppState;

const USER: &str = "tester_admin";
const PASSWORD: &str = "Strong-Tester-Pass-2026!";
const SEEDER_TOKEN: &str = "seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua";

fn config() -> Config {
    Config {
        portal_rate_limit: 100,
        ..Config::test_config(":memory:")
    }
}

fn state_with(config: Config) -> AppState {
    AppState::new(config).expect("state")
}

fn state() -> AppState {
    state_with(config())
}

type Pipeline =
    ntex::service::Pipeline<Request, Response, ntex::web::WebError<(), ntex::web::DefaultError>>;

async fn service(state: AppState) -> Pipeline {
    test::init_service(
        App::default()
            .with_config(WebAppConfig::new().set_value(state))
            .service(web::resource("/{tail}*").to(ntex_dispatch)),
    )
    .await
}

struct Reply {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

async fn send(app: &Pipeline, request: Request) -> Reply {
    let response = app.call(request).await.expect("service call");
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
        })
        .collect();
    let body = test::read_body(response).await.to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

async fn open_stream(app: &Pipeline, request: Request) -> (u16, BTreeMap<String, String>) {
    let response = app.call(request).await.expect("stream call");
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
        })
        .collect();
    // Dropping the response cancels the never-ending SSE body instead of blocking the test.
    drop(response);
    (status, headers)
}

async fn request(
    app: &Pipeline,
    method: Method,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> Reply {
    let mut builder = test::TestRequest::with_uri(uri)
        .method(method)
        .peer_addr("127.0.0.1:12345".parse().expect("peer"));
    if let Some(body) = body {
        builder = builder
            .header("content-type", "application/json")
            .payload(body.to_string());
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    send(app, builder.to_request()).await
}

async fn login(app: &Pipeline) -> String {
    let reply = request(
        app,
        Method::POST,
        "/portal-api/auth/login",
        Some(json!({"username": USER, "password": PASSWORD})),
        &[],
    )
    .await;
    assert_eq!(reply.status, 200, "login failed: {}", reply.text());
    reply.json()["token"].as_str().expect("token").to_owned()
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

async fn authed(
    app: &Pipeline,
    method: Method,
    uri: &str,
    body: Option<Value>,
    token: &str,
) -> Reply {
    let header = bearer(token);
    request(app, method, uri, body, &[("authorization", &header)]).await
}

// ---------------------------------------------------------------------------------------------
// Health, auth and seeder
// ---------------------------------------------------------------------------------------------

#[ntex::test]
async fn health_endpoints_match_the_ts_payloads() {
    let app = service(state()).await;
    let health = request(&app, Method::GET, "/health", None, &[]).await;
    assert_eq!(health.status, 200);
    assert_eq!(health.json()["service"], "fake-rails-back");
    assert_eq!(health.json()["status"], "ok");
    let hosted = request(&app, Method::GET, "/hosted/health", None, &[]).await;
    assert_eq!(hosted.status, 200);
    assert_eq!(hosted.json()["service"], "fake-rails-hosted");
}

#[ntex::test]
async fn login_rejects_a_wrong_password_and_issues_a_three_segment_jwt() {
    let app = service(state()).await;
    let bad = request(
        &app,
        Method::POST,
        "/portal-api/auth/login",
        Some(json!({"username": USER, "password": "wrong-password"})),
        &[],
    )
    .await;
    assert_eq!(bad.status, 401);
    assert_eq!(bad.json()["code"], "INVALID_CREDENTIALS");

    let token = login(&app).await;
    assert_eq!(token.split('.').count(), 3);
    let me = authed(&app, Method::GET, "/portal-api/auth/me", None, &token).await;
    assert_eq!(me.status, 200);
    assert_eq!(me.json()["user"]["role"], "FAKE_RAILS_TESTER");
}

#[ntex::test]
async fn protected_routes_require_the_tester_session() {
    let app = service(state()).await;
    assert_eq!(
        request(&app, Method::GET, "/portal-api/transactions", None, &[])
            .await
            .status,
        401
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/portal-api/transactions",
            None,
            &[("authorization", "Bearer garbage")]
        )
        .await
        .status,
        401
    );
    let token = login(&app).await;
    assert_eq!(
        authed(&app, Method::GET, "/portal-api/transactions", None, &token)
            .await
            .status,
        200
    );
}

#[ntex::test]
async fn seeder_handshake_authenticates_with_the_shared_token() {
    let app = service(state()).await;
    let missing = request(
        &app,
        Method::POST,
        "/portal-api/internal/seeder-handshake",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(missing.status, 401);
    let reply = request(
        &app,
        Method::POST,
        "/portal-api/internal/seeder-handshake",
        Some(json!({"check": "PRE_FLIGHT_SEEDER_SYNC"})),
        &[("x-fake-rails-seeder-token", SEEDER_TOKEN)],
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["ok"], true);
    assert_eq!(reply.json()["rails"], 20);
    assert_eq!(reply.json()["check"], "PRE_FLIGHT_SEEDER_SYNC");
}

#[ntex::test]
async fn session_token_is_never_accepted_from_the_query_string() {
    let app = service(state()).await;
    let token = login(&app).await;
    let reply = request(
        &app,
        Method::GET,
        &format!("/portal-api/auth/me?token={token}"),
        None,
        &[],
    )
    .await;
    assert_eq!(reply.status, 401);
    let ticket = authed(
        &app,
        Method::POST,
        "/portal-api/transactions/stream-ticket",
        None,
        &token,
    )
    .await;
    assert_eq!(ticket.status, 200);
    let ticket = ticket.json()["ticket"].as_str().expect("ticket").to_owned();
    assert_eq!(ticket.split('.').count(), 3);
    // The ticket is not a session.
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/portal-api/auth/me",
            None,
            &[("authorization", &bearer(&ticket))]
        )
        .await
        .status,
        401
    );
    // A valid ticket opens the SSE stream once; reuse is rejected before streaming.
    let stream_request =
        test::TestRequest::with_uri(&format!("/portal-api/transactions/stream?ticket={ticket}"))
            .method(Method::GET)
            .peer_addr("127.0.0.1:12345".parse().expect("peer"));
    let (stream_status, stream_headers) = open_stream(&app, stream_request.to_request()).await;
    assert_eq!(stream_status, 200);
    assert_eq!(
        stream_headers.get("content-type").map(String::as_str),
        Some("text/event-stream")
    );
    let reused = request(
        &app,
        Method::GET,
        &format!("/portal-api/transactions/stream?ticket={ticket}"),
        None,
        &[],
    )
    .await;
    assert_eq!(reused.status, 401);
}

// ---------------------------------------------------------------------------------------------
// OTP rails
// ---------------------------------------------------------------------------------------------

#[ntex::test]
async fn an_otp_rail_initiates_confirms_and_settles() {
    let app = service(state()).await;
    let verify = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": "API-TEST-1", "amount": "100.00", "phone": "0911234567"})),
        &[],
    )
    .await;
    assert_eq!(verify.status, 200);
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    assert_eq!(otp.len(), 4);
    assert_eq!(verify.json()["status"], "AWAITING_CUSTOMER");

    let confirm = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"reference": "API-TEST-1", "otp": otp})),
        &[],
    )
    .await;
    assert_eq!(confirm.status, 200);
    assert_eq!(confirm.json()["status"], "PAID");

    let status = request(
        &app,
        Method::GET,
        "/rails/edfali/status/API-TEST-1",
        None,
        &[],
    )
    .await;
    assert_eq!(status.status, 200);
    assert_eq!(status.json()["status"], "PAID");
    assert_eq!(status.json()["result"], "SUCCESS");
}

#[ntex::test]
async fn an_otp_rail_echoes_invoice_no_and_the_attempt_environment() {
    let app = service(state()).await;
    let reference = "INV-OTP-ECHO-1";
    let verify = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"invoice_no": reference, "amount": "25.00", "mobile_number": "0910000001", "env": "SANDBOX"})),
        &[],
    )
    .await;
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    let confirm = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"invoice_no": reference, "otp": otp})),
        &[],
    )
    .await;
    assert_eq!(confirm.status, 200);
    let body = confirm.json();
    assert_eq!(body["status"], "PAID");
    assert_eq!(body["reference"], reference);
    assert_eq!(body["env"], "SANDBOX");
    assert_eq!(body["environment"], "SANDBOX");
    let inquiry = request(
        &app,
        Method::GET,
        &format!("/rails/edfali/status/{reference}"),
        None,
        &[],
    )
    .await;
    assert_eq!(inquiry.json()["env"], "SANDBOX");
    assert_eq!(inquiry.json()["environment"], "SANDBOX");
}

#[ntex::test]
async fn the_core_environment_header_selects_the_live_plane() {
    let app = service(state()).await;
    let reference = "INV-OTP-LIVE-1";
    let headers = [("x-pg-environment", "LIVE")];
    let verify = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"invoice_no": reference, "amount": "15.00", "mobile_number": "0910000001"})),
        &headers,
    )
    .await;
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    let confirm = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"invoice_no": reference, "otp": otp})),
        &headers,
    )
    .await;
    assert_eq!(confirm.json()["status"], "PAID");
    assert_eq!(confirm.json()["env"], "LIVE");
    assert_eq!(confirm.json()["environment"], "LIVE");
    let inquiry = request(
        &app,
        Method::GET,
        &format!("/rails/edfali/status/{reference}"),
        None,
        &[],
    )
    .await;
    assert_eq!(inquiry.json()["env"], "LIVE");
}

#[ntex::test]
async fn a_wrong_otp_keeps_the_attempt_awaiting_the_customer() {
    let app = service(state()).await;
    request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": "API-TEST-WRONG-OTP", "amount": "10.00", "phone": "0911234567"})),
        &[],
    )
    .await;
    let confirm = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"reference": "API-TEST-WRONG-OTP", "otp": "0000"})),
        &[],
    )
    .await;
    assert_eq!(confirm.json()["status"], "AWAITING_CUSTOMER");
    assert_eq!(confirm.json()["retryable"], true);
}

#[ntex::test]
async fn a_sadad_flow_reserves_reveals_and_captures_a_real_test_account() {
    let app = service(state()).await;
    let accounts = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=sadad",
        None,
        &[],
    )
    .await;
    let accounts = accounts.json()["accounts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let rich = accounts
        .iter()
        .find(|account| account["available_balance_lyd"] == "50000.0000")
        .expect("rich account")
        .clone();
    let identifier = rich["identifier"].as_str().expect("identifier").to_owned();
    let reference = "API-V2-CAPTURE";
    let verify = request(
        &app,
        Method::POST,
        "/rails/sadad/verify",
        Some(json!({"reference": reference, "amount": "200.00", "phone": identifier})),
        &[],
    )
    .await;
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    let helper = request(
        &app,
        Method::GET,
        &format!("/control/checkout-helper/{reference}"),
        None,
        &[],
    )
    .await;
    let secret = &helper.json()["activeAttemptSecrets"];
    assert_eq!(secret["expectedOtp"], otp);
    assert_eq!(secret["boundAccountIdentifier"], identifier);
    assert_eq!(secret["heldAmountLyd"], "200.0000");
    let confirm = request(
        &app,
        Method::POST,
        "/rails/sadad/confirm",
        Some(json!({"reference": reference, "otp": otp})),
        &[],
    )
    .await;
    assert_eq!(confirm.json()["status"], "PAID");
    let after = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=sadad",
        None,
        &[],
    )
    .await;
    let after = after.json()["accounts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let updated = after
        .iter()
        .find(|account| account["identifier"] == identifier)
        .expect("account")
        .clone();
    assert_eq!(updated["available_balance_lyd"], "49800.0000");
    assert_eq!(updated["daily_spent_lyd"], "200.0000");
}

// ---------------------------------------------------------------------------------------------
// Chaos and scenarios
// ---------------------------------------------------------------------------------------------

#[ntex::test]
async fn a_persisted_chaos_scenario_drives_the_next_confirm() {
    let app = service(state()).await;
    let token = login(&app).await;
    let put = authed(
        &app,
        Method::PUT,
        "/portal-api/scenarios/edfali",
        Some(json!({
            "enabled": true,
            "overallFailureChancePercent": 100,
            "phaseBreakdown": {
                "initiateFailWeight": 0, "submitFailWeight": 100, "verifyFailWeight": 0,
                "webhookFailWeight": 0, "refundFailWeight": 0
            },
            "failureModeWeights": {
                "TERMINAL_DECLINE_INSUFFICIENT_FUNDS": 0, "LIMIT_EXCEEDED_CUSTOMER_CEILING": 0,
                "WRONG_OTP_RETRYABLE": 0, "HTTP_500_GATEWAY_FAULT": 0,
                "TIMEOUT_HANG_ABOVE_STEP_TTL": 100, "SOCKET_RESET_MID_STREAM": 0,
                "MALFORMED_OR_UNMAPPED_200_BODY": 0, "RATE_LIMIT_HTTP_429": 0,
                "AMOUNT_ROUNDING_MISMATCH": 0, "CONFLICTING_WEBHOOK_VS_INQUIRY": 0
            }
        })),
        &token,
    )
    .await;
    assert_eq!(put.status, 200);
    let verify = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": "API-TEST-CHAOS", "amount": "10.00", "phone": "0911234567"})),
        &[],
    )
    .await;
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    let confirm = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"reference": "API-TEST-CHAOS", "otp": otp})),
        &[],
    )
    .await;
    assert_eq!(confirm.status, 504);
    assert_eq!(confirm.json()["error"], "gateway_timeout");
}

#[ntex::test]
async fn the_scenario_catalog_covers_all_twenty_rails_and_presets() {
    let app = service(state()).await;
    let token = login(&app).await;
    let rails = [
        "edfali",
        "sadad",
        "mobicash",
        "moamalat",
        "ly_pay",
        "onepay",
        "tlync",
        "mypay",
        "dpay",
        "plutu",
        "yussor_pay",
        "sahara_pay",
        "masrefy_pay",
        "hawelli",
        "gpay_libya",
        "numo_pay",
        "libyana",
        "mpgs",
        "evopay",
        "neompay",
    ];
    let catalog = authed(&app, Method::GET, "/portal-api/scenarios", None, &token).await;
    let mut codes: Vec<String> = catalog.json()["rails"]
        .as_array()
        .expect("rails")
        .iter()
        .map(|rail| rail["railCode"].as_str().unwrap_or_default().to_owned())
        .collect();
    codes.sort();
    let mut expected: Vec<String> = rails.iter().map(|rail| (*rail).to_owned()).collect();
    expected.sort();
    assert_eq!(codes, expected);

    for rail in rails {
        let put = authed(
            &app,
            Method::PUT,
            &format!("/portal-api/scenarios/{rail}"),
            Some(json!({
                "enabled": true,
                "overallFailureChancePercent": 0,
                "phaseBreakdown": {
                    "initiateFailWeight": 0, "submitFailWeight": 0, "verifyFailWeight": 0,
                    "webhookFailWeight": 0, "refundFailWeight": 0
                }
            })),
            &token,
        )
        .await;
        assert_eq!(put.status, 200, "{rail}");
        let get = authed(
            &app,
            Method::GET,
            &format!("/portal-api/scenarios/{rail}"),
            None,
            &token,
        )
        .await;
        assert_eq!(
            get.json()["scenario"]["overallFailureChancePercent"].as_f64(),
            Some(0.0)
        );
        let preset = authed(
            &app,
            Method::POST,
            &format!("/portal-api/scenarios/preset/{rail}/timeout_on_confirm"),
            None,
            &token,
        )
        .await;
        assert_eq!(preset.status, 200, "{rail}");
        assert_eq!(
            preset.json()["scenario"]["overallFailureChancePercent"].as_f64(),
            Some(100.0)
        );
        assert_eq!(
            preset.json()["scenario"]["phaseBreakdown"]["submitFailWeight"].as_f64(),
            Some(100.0)
        );
    }

    assert_eq!(
        authed(
            &app,
            Method::POST,
            "/portal-api/scenarios/preset/edfali/not-a-preset",
            None,
            &token
        )
        .await
        .status,
        400
    );
    assert_eq!(
        authed(
            &app,
            Method::POST,
            "/portal-api/scenarios/preset/not-a-rail/healthy",
            None,
            &token
        )
        .await
        .status,
        404
    );
    let global = authed(
        &app,
        Method::POST,
        "/portal-api/scenarios/global/healthy",
        None,
        &token,
    )
    .await;
    assert_eq!(global.status, 200);
    assert_eq!(
        global.json()["scenarios"].as_array().map(Vec::len),
        Some(20)
    );
    let reset = authed(
        &app,
        Method::POST,
        "/portal-api/scenarios/reset",
        None,
        &token,
    )
    .await;
    assert_eq!(reset.status, 200);
    assert_eq!(reset.json()["scenarios"].as_array().map(Vec::len), Some(20));
    assert_eq!(
        authed(
            &app,
            Method::GET,
            "/portal-api/scenarios/edfali/audit",
            None,
            &token
        )
        .await
        .status,
        200
    );
}

// ---------------------------------------------------------------------------------------------
// Transactions, webhooks, statements
// ---------------------------------------------------------------------------------------------

async fn create_transaction(app: &Pipeline, reference: &str) -> String {
    let verify = request(
        app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": reference, "amount": "100.00", "phone": "0911234567"})),
        &[],
    )
    .await;
    assert_eq!(verify.status, 200);
    verify.json()["transaction_id"]
        .as_str()
        .expect("transaction id")
        .to_owned()
}

#[ntex::test]
async fn the_transaction_lifecycle_actions_match_the_ts_portal() {
    let app = service(state()).await;
    let token = login(&app).await;
    let id = create_transaction(&app, "EXH-TX-1").await;
    let detail = authed(
        &app,
        Method::GET,
        &format!("/portal-api/transactions/{id}"),
        None,
        &token,
    )
    .await;
    assert_eq!(detail.status, 200);
    assert_eq!(detail.json()["transaction"]["status"], "AWAITING_ACTION");
    let approve = authed(
        &app,
        Method::POST,
        &format!("/portal-api/transactions/{id}/action"),
        Some(json!({"action": "APPROVE"})),
        &token,
    )
    .await;
    assert_eq!(approve.status, 200);
    assert_eq!(approve.json()["transaction"]["status"], "PAID");

    let reject_id = create_transaction(&app, "EXH-TX-REJECT").await;
    let reject = authed(
        &app,
        Method::POST,
        &format!("/portal-api/transactions/{reject_id}/action"),
        Some(json!({"action": "REJECT"})),
        &token,
    )
    .await;
    assert_eq!(reject.json()["transaction"]["status"], "FAILED");

    let cancel_id = create_transaction(&app, "EXH-TX-CANCEL").await;
    let cancel = authed(
        &app,
        Method::POST,
        &format!("/portal-api/transactions/{cancel_id}/action"),
        Some(json!({"action": "CANCEL"})),
        &token,
    )
    .await;
    assert_eq!(cancel.json()["transaction"]["status"], "CANCELLED");

    let force_id = create_transaction(&app, "EXH-TX-FORCE").await;
    let force = authed(
        &app,
        Method::POST,
        &format!("/portal-api/transactions/{force_id}/action"),
        Some(json!({"action": "FORCE_OUTCOME", "phase": "SUBMIT", "failureMode": "TIMEOUT_HANG_ABOVE_STEP_TTL"})),
        &token,
    )
    .await;
    assert_eq!(force.status, 200);
    assert_eq!(
        force.json()["transaction"]["assigned_failure_mode"],
        "TIMEOUT_HANG_ABOVE_STEP_TTL"
    );
    assert_eq!(
        authed(
            &app,
            Method::GET,
            &format!("/portal-api/transactions/{force_id}/events"),
            None,
            &token
        )
        .await
        .status,
        200
    );
    assert!(
        authed(&app, Method::GET, "/portal-api/transactions", None, &token)
            .await
            .json()["total"]
            .as_i64()
            .unwrap_or_default()
            > 0
    );
    assert_eq!(
        authed(
            &app,
            Method::GET,
            "/portal-api/transactions/summary",
            None,
            &token
        )
        .await
        .status,
        200
    );
}

#[ntex::test]
async fn webhooks_queue_duplicates_replay_tampering_and_disputes() {
    let app = service(state()).await;
    let token = login(&app).await;
    let id = create_transaction(&app, "EXH-TX-WEBHOOK").await;
    let detail = authed(
        &app,
        Method::GET,
        &format!("/portal-api/transactions/{id}"),
        None,
        &token,
    )
    .await;
    let internal_id = detail.json()["transaction"]["id"]
        .as_str()
        .expect("internal id")
        .to_owned();
    let fire = authed(
        &app,
        Method::POST,
        &format!("/portal-api/webhooks/{internal_id}/fire"),
        Some(json!({"event": "payment.paid", "duplicateCount": 3})),
        &token,
    )
    .await;
    assert_eq!(fire.status, 202);
    assert_eq!(fire.json()["deliveries"].as_array().map(Vec::len), Some(3));
    let list = authed(
        &app,
        Method::GET,
        &format!("/portal-api/webhooks?transactionId={internal_id}"),
        None,
        &token,
    )
    .await;
    let delivery = list.json()["deliveries"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["id"].as_str())
        .expect("delivery")
        .to_owned();
    let replay = authed(
        &app,
        Method::POST,
        &format!("/portal-api/webhooks/{delivery}/replay?tamper=true"),
        None,
        &token,
    )
    .await;
    assert_eq!(replay.status, 200);
    let replayed_headers = replay.json()["delivery"]["request_headers_json"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(replayed_headers.contains("forged-signature-0000"));
    assert!(replayed_headers.contains("\"x-fake-rails-signature-valid\":\"false\""));
    let dispute = authed(
        &app,
        Method::POST,
        &format!("/portal-api/webhooks/{internal_id}/dispute"),
        None,
        &token,
    )
    .await;
    assert_eq!(dispute.status, 202);
}

#[ntex::test]
async fn a_webhook_url_off_the_allowlist_is_refused_before_anything_is_stored() {
    let app = service(state()).await;
    for target in [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:4000/internal",
        "http://localhost:1/x",
    ] {
        let reply = request(
            &app,
            Method::POST,
            "/rails/tlync/payment/create",
            Some(json!({
                "reference": "SSRF-1",
                "amount": "10.00",
                "return_url": "https://merchant.test/return",
                "webhook_url": target,
            })),
            &[],
        )
        .await;
        assert_eq!(reply.status, 400, "{target}");
        assert_eq!(reply.json()["code"], "WEBHOOK_URL_NOT_ALLOWED");
    }
    let allowed = request(
        &app,
        Method::POST,
        "/rails/tlync/payment/create",
        Some(json!({
            "reference": "SSRF-OK",
            "amount": "10.00",
            "webhook_url": "http://receiver.lab.internal/hook",
        })),
        &[],
    )
    .await;
    assert!(allowed.status < 300);
}

#[ntex::test]
async fn statements_generate_csv_json_xlsx_and_reject_an_invalid_window() {
    let app = service(state()).await;
    let token = login(&app).await;
    create_transaction(&app, "STMT-1").await;
    let _ = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": "STMT-2", "amount": "12.00", "phone": "0911234567"})),
        &[],
    )
    .await;
    // Settle one attempt so the statement has a line.
    let id = create_transaction(&app, "STMT-3").await;
    authed(
        &app,
        Method::POST,
        &format!("/portal-api/transactions/{id}/action"),
        Some(json!({"action": "APPROVE"})),
        &token,
    )
    .await;

    let json_statement = authed(
        &app,
        Method::POST,
        "/portal-api/statements/generate",
        Some(json!({
            "gatewayCode": "edfali",
            "format": "json",
            "from": "2020-01-01T00:00:00.000Z",
            "to": "2030-01-01T00:00:00.000Z",
            "anomalies": {"feeVariancePercent": 0, "addUnrecorded": true}
        })),
        &token,
    )
    .await;
    assert_eq!(json_statement.status, 200);
    let lines = json_statement.json()["lines"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(lines.iter().any(|line| line["our_reference"]
        .as_str()
        .unwrap_or("")
        .starts_with("UNRECORDED-")));

    let csv = authed(
        &app,
        Method::POST,
        "/portal-api/statements/generate",
        Some(json!({"gatewayCode": "edfali", "format": "csv"})),
        &token,
    )
    .await;
    assert_eq!(csv.status, 200);
    assert!(csv
        .headers
        .get("content-type")
        .unwrap_or(&String::new())
        .contains("text/csv"));
    assert!(csv.text().starts_with("provider_reference,our_reference"));

    let xlsx = authed(
        &app,
        Method::POST,
        "/portal-api/statements/generate",
        Some(json!({"gatewayCode": "edfali", "format": "xlsx"})),
        &token,
    )
    .await;
    assert_eq!(xlsx.status, 200);
    assert_eq!(&xlsx.body[..2], b"PK");
    assert!(xlsx
        .headers
        .get("content-type")
        .unwrap_or(&String::new())
        .contains("spreadsheetml"));

    let invalid = authed(
        &app,
        Method::POST,
        "/portal-api/statements/generate",
        Some(json!({"gatewayCode": "edfali", "from": "2026-06-01", "to": "2026-01-01"})),
        &token,
    )
    .await;
    assert_eq!(invalid.status, 400);
    assert!(
        authed(&app, Method::GET, "/portal-api/statements", None, &token)
            .await
            .json()["statements"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default()
            > 0
    );
    // The gateway-side statement endpoint (used by core reconciliation).
    let gateway_csv = request(
        &app,
        Method::GET,
        "/rails/edfali/statement?format=csv",
        None,
        &[],
    )
    .await;
    assert_eq!(gateway_csv.status, 200);
    assert!(gateway_csv
        .headers
        .get("content-type")
        .unwrap_or(&String::new())
        .contains("text/csv"));
    let gateway_json = request(
        &app,
        Method::GET,
        "/rails/edfali/statement?format=json",
        None,
        &[],
    )
    .await;
    assert_eq!(gateway_json.json()["gateway"], "edfali");
}

#[ntex::test]
async fn bulk_seed_inserts_historical_transactions_and_events() {
    let app = service(state()).await;
    let token = login(&app).await;
    let reply = request(
        &app,
        Method::POST,
        "/portal-api/internal/bulk-seed",
        Some(json!({
            "transactions": [{
                "id": "00000000-0000-7000-8000-000000000001",
                "gateway_code": "moamalat",
                "rail_code": "moamalat",
                "env": "LIVE",
                "our_reference": "SEED-REF-1",
                "provider_reference": "FK-SEED-1",
                "requested_amount_wire": "10500",
                "normalized_amount_lyd": "10.5000",
                "settled_amount_lyd": "10.5000",
                "currency": "LYD",
                "collection_mode": "EMBEDDED",
                "status": "PAID",
                "is_seeded_historical": 1,
                "created_at": "2024-01-01T10:00:00.000Z",
                "updated_at": "2024-01-01T10:01:00.000Z"
            }],
            "events": [{
                "id": "00000000-0000-7000-8000-000000000002",
                "transaction_id": "00000000-0000-7000-8000-000000000001",
                "gateway_code": "moamalat",
                "phase": "INITIATE",
                "method": "POST",
                "path": "/rails/moamalat/FilterTransactions",
                "created_at": "2024-01-01T10:00:00.000Z"
            }]
        })),
        &[("x-fake-rails-seeder-token", SEEDER_TOKEN)],
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["insertedTransactions"], 1);
    assert_eq!(reply.json()["insertedEvents"], 1);
    let list = authed(
        &app,
        Method::GET,
        "/portal-api/transactions?reference=SEED-REF-1",
        None,
        &token,
    )
    .await;
    assert_eq!(list.json()["total"], 1);
    assert_eq!(list.json()["rows"][0]["our_reference"], "SEED-REF-1");
    // NDJSON body is accepted too (express.text + parseNdjson).
    let ndjson = format!(
        "{}\n",
        json!({
            "id": "00000000-0000-7000-8000-000000000003",
            "gateway_code": "edfali",
            "rail_code": "edfali",
            "our_reference": "SEED-NDJSON-1",
            "provider_reference": "FK-SEED-NDJSON-1",
            "requested_amount_wire": "5",
            "normalized_amount_lyd": "5.0000",
            "collection_mode": "OTP_PULL",
            "status": "PAID",
            "created_at": "2024-01-01T10:00:00.000Z",
            "updated_at": "2024-01-01T10:01:00.000Z"
        })
    );
    let builder = test::TestRequest::with_uri("/portal-api/internal/bulk-seed")
        .method(Method::POST)
        .peer_addr("127.0.0.1:12345".parse().expect("peer"))
        .header("content-type", "text/plain")
        .header("x-fake-rails-seeder-token", SEEDER_TOKEN)
        .payload(ndjson);
    let ndjson_reply = send(&app, builder.to_request()).await;
    assert_eq!(ndjson_reply.status, 200);
    assert_eq!(ndjson_reply.json()["insertedTransactions"], 1);
}

// ---------------------------------------------------------------------------------------------
// SDK, hosted pages
// ---------------------------------------------------------------------------------------------

#[ntex::test]
async fn sdk_scripts_are_served_with_their_drop_in_api_and_sri() {
    let app = service(state()).await;
    let index = request(&app, Method::GET, "/sdk", None, &[]).await;
    assert_eq!(index.status, 200);
    let scripts = index.json()["scripts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(scripts.len(), 2);
    assert!(scripts
        .iter()
        .all(|script| script["sri"].as_str().unwrap_or("").starts_with("sha384-")));
    let script = request(&app, Method::GET, "/sdk/moamalat-lightbox.js", None, &[]).await;
    assert_eq!(script.status, 200);
    assert!(script.text().contains("Lightbox.Checkout.configure"));
    assert_eq!(
        request(&app, Method::GET, "/sdk/nope.js", None, &[])
            .await
            .status,
        404
    );
    let mpgs = request(&app, Method::GET, "/sdk/mpgs-session.js", None, &[]).await;
    assert!(mpgs.text().contains("PaymentSession"));
}

#[ntex::test]
async fn hosted_session_hides_the_otp_and_requires_the_action_token() {
    let app = service(state()).await;
    let verify = request(
        &app,
        Method::POST,
        "/rails/tlync/payment/create",
        Some(json!({"reference": "HOSTED-1", "amount": "55.00", "return_url": "https://merchant.test/return"})),
        &[],
    )
    .await;
    let transaction_id = verify.json()["transaction_id"]
        .as_str()
        .expect("transaction")
        .to_owned();
    assert_eq!(verify.json()["status"], "AWAITING_CUSTOMER");
    assert!(verify.json()["redirect_url"]
        .as_str()
        .unwrap_or("")
        .starts_with("http://127.0.0.1:8444/hosted/redirect/"));
    let session = request(
        &app,
        Method::GET,
        &format!("/portal-api/hosted/session/{transaction_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(session.status, 200);
    let session_body = session.json();
    assert!(session_body["transaction"]["our_reference"].is_string());
    assert!(session_body["transaction"].get("expected_otp").is_none());
    assert!(session_body["transaction"].get("webhook_url").is_none());
    let action_token = session_body["action_token"]
        .as_str()
        .expect("action token")
        .to_owned();
    let path = format!("/portal-api/hosted/session/{transaction_id}/action");
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            Some(json!({"action": "APPROVE"})),
            &[]
        )
        .await
        .status,
        401
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            Some(json!({"action": "APPROVE"})),
            &[("x-hosted-action-token", "not-a-token")]
        )
        .await
        .status,
        401
    );
    let approved = request(
        &app,
        Method::POST,
        &path,
        Some(json!({"action": "APPROVE"})),
        &[("x-hosted-action-token", &action_token)],
    )
    .await;
    assert_eq!(approved.status, 200);
    assert_eq!(approved.json()["transaction"]["status"], "PAID");
    assert!(approved.json()["transaction"].get("expected_otp").is_none());
}

// ---------------------------------------------------------------------------------------------
// Accounts, clearing and the control plane
// ---------------------------------------------------------------------------------------------

#[ntex::test]
async fn control_plane_lists_and_adjusts_the_seeded_test_customers() {
    let app = service(state()).await;
    let list = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=sadad",
        None,
        &[],
    )
    .await;
    assert_eq!(list.status, 200);
    let accounts = list.json()["accounts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(accounts.len(), 5);
    assert!(accounts
        .iter()
        .any(|account| account["available_balance_lyd"] == "50000.0000"));
    assert!(accounts.iter().any(|account| account["status"] == "FROZEN"));
    let onepay = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=onepay",
        None,
        &[],
    )
    .await;
    let target = onepay.json()["accounts"]
        .as_array()
        .and_then(|accounts| {
            accounts
                .iter()
                .find(|account| account["available_balance_lyd"] == "50000.0000")
        })
        .expect("target")
        .clone();
    let id = target["id"].as_str().expect("id").to_owned();
    let patched = request(
        &app,
        Method::PATCH,
        &format!("/control/accounts/{id}"),
        Some(json!({"quickPreset": "SET_ZERO"})),
        &[],
    )
    .await;
    assert_eq!(patched.status, 200);
    assert_eq!(patched.json()["account"]["available_balance_lyd"], "0.0000");
    request(
        &app,
        Method::PATCH,
        &format!("/control/accounts/{id}"),
        Some(json!({"quickPreset": "TOP_UP_5000"})),
        &[],
    )
    .await;
    let restored = request(
        &app,
        Method::GET,
        &format!("/control/accounts/{id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(
        restored.json()["account"]["available_balance_lyd"],
        "5000.0000"
    );
    // Paginated mode, movements/holds, restore refusal for a shared preset, and reset.
    let page = request(
        &app,
        Method::GET,
        "/control/accounts?page=1&pageSize=10&search=091",
        None,
        &[],
    )
    .await;
    assert_eq!(page.status, 200);
    assert_eq!(page.json()["pageSize"], 10);
    let movements = request(
        &app,
        Method::GET,
        &format!("/control/accounts/{id}/movements"),
        None,
        &[],
    )
    .await;
    assert!(!movements.json()["movements"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .is_empty());
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/control/accounts/{id}/holds"),
            None,
            &[]
        )
        .await
        .status,
        200
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/control/accounts/{id}/restore"),
            None,
            &[]
        )
        .await
        .status,
        409
    );
    let reset = request(
        &app,
        Method::POST,
        "/control/accounts/reset",
        Some(json!({"merchantId": "11111111-1111-4111-8111-111111111111"})),
        &[],
    )
    .await;
    assert_eq!(reset.status, 200);
    assert_eq!(reset.json()["ok"], true);
}

#[ntex::test]
async fn accounts_can_be_created_patched_and_listed_with_their_ledger() {
    let app = service(state()).await;
    let created = request(
        &app,
        Method::POST,
        "/control/accounts",
        Some(json!({
            "railCode": "sadad",
            "gatewayCode": "sadad",
            "identifier": "0918887777",
            "holderName": "Custom Test Customer",
            "availableBalanceLyd": "321.5000",
            "staticOtp": "424242"
        })),
        &[],
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.text());
    let account = created.json()["account"].clone();
    assert_eq!(account["available_balance_lyd"], "321.5000");
    assert_eq!(account["static_otp"], "424242");
    let id = account["id"].as_str().expect("id").to_owned();
    let duplicate = request(
        &app,
        Method::POST,
        "/control/accounts",
        Some(json!({
            "railCode": "sadad",
            "gatewayCode": "sadad",
            "identifier": "0918887777",
            "holderName": "Another"
        })),
        &[],
    )
    .await;
    assert_eq!(duplicate.status, 409);
    let patched = request(
        &app,
        Method::PATCH,
        &format!("/control/accounts/{id}"),
        Some(
            json!({"availableBalanceLyd": "300.0000", "status": "FROZEN", "reason": "test freeze"}),
        ),
        &[],
    )
    .await;
    assert_eq!(patched.status, 200);
    assert_eq!(
        patched.json()["account"]["available_balance_lyd"],
        "300.0000"
    );
    assert_eq!(patched.json()["account"]["status"], "FROZEN");
    // A static OTP overrides the derived OTP on the next initiate.
    let verify = request(
        &app,
        Method::POST,
        "/rails/sadad/verify",
        Some(json!({"reference": "ACCT-OTP-1", "amount": "5.00", "phone": "0918887777"})),
        &[],
    )
    .await;
    assert_eq!(verify.json()["status"], "FAILED");
    assert_eq!(verify.json()["error_code"], "ACCOUNT_FROZEN");
}

#[ntex::test]
async fn clearing_pools_statements_and_marking_work_end_to_end() {
    let app = service(state()).await;
    let token = login(&app).await;
    let accounts = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=mobicash",
        None,
        &[],
    )
    .await;
    let rich = accounts.json()["accounts"]
        .as_array()
        .and_then(|accounts| {
            accounts
                .iter()
                .find(|account| account["available_balance_lyd"] == "50000.0000")
        })
        .expect("rich")
        .clone();
    let identifier = rich["identifier"].as_str().expect("identifier").to_owned();
    let verify = request(
        &app,
        Method::POST,
        "/rails/mobicash/open",
        Some(json!({"reference": "CLEAR-1", "amount": "40.00", "phone": identifier})),
        &[],
    )
    .await;
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    request(
        &app,
        Method::POST,
        "/rails/mobicash/confirm",
        Some(json!({"reference": "CLEAR-1", "otp": otp})),
        &[],
    )
    .await;
    let pools = request(&app, Method::GET, "/control/clearing/pools", None, &[]).await;
    assert_eq!(pools.status, 200);
    let statement = request(
        &app,
        Method::POST,
        "/control/clearing/generate-statement",
        Some(json!({"gatewayCode": "mobicash"})),
        &[],
    )
    .await;
    assert_eq!(statement.status, 200);
    assert_eq!(statement.json()["totals"]["grossLyd"], "40.0000");
    let entry_ids: Vec<Value> = statement.json()["rows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|row| row["id"].as_str().map(|id| json!(id)))
        .collect();
    assert!(!entry_ids.is_empty());
    let included = request(
        &app,
        Method::POST,
        "/control/clearing/mark-included",
        Some(json!({"entryIds": entry_ids, "runId": "RUN-1"})),
        &[],
    )
    .await;
    assert_eq!(included.json()["updated"], 1);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/control/clearing/mark-included",
            Some(json!({"entryIds": [], "runId": ""})),
            &[]
        )
        .await
        .status,
        400
    );
    let settled = request(
        &app,
        Method::POST,
        "/control/clearing/settle",
        Some(json!({"gatewayCode": "mobicash"})),
        &[],
    )
    .await;
    assert_eq!(settled.json()["ok"], true);
    // The demo control plane is also reachable from the authenticated portal.
    assert_eq!(
        authed(
            &app,
            Method::GET,
            "/portal-api/accounts?railCode=edfali",
            None,
            &token
        )
        .await
        .status,
        200
    );
}

#[ntex::test]
async fn checkout_helper_simulates_push_approval_variance_and_decline() {
    let app = service(state()).await;
    let created = request(
        &app,
        Method::POST,
        "/rails/onepay/qr",
        Some(json!({"reference": "PUSH-1", "amount": "30.00", "phone": "0915000001"})),
        &[],
    )
    .await;
    assert_eq!(created.status, 200);
    assert_eq!(
        created.json()["qr_code"]
            .as_str()
            .unwrap_or("")
            .split('|')
            .next(),
        Some("EMVCO")
    );
    let helper = request(
        &app,
        Method::GET,
        "/control/checkout-helper/PUSH-1",
        None,
        &[],
    )
    .await;
    assert_eq!(
        helper.json()["activeAttemptSecrets"]["canSimulateMobilePushOrQrApproval"],
        true
    );
    let approved = request(
        &app,
        Method::POST,
        "/control/checkout-helper/PUSH-1/simulate-action",
        Some(json!({"action": "APPROVE_WITH_VARIANCE"})),
        &[],
    )
    .await;
    assert_eq!(approved.status, 200);
    let listed = request(
        &app,
        Method::GET,
        "/control/transactions?reference=PUSH-1",
        None,
        &[],
    )
    .await;
    assert_eq!(listed.json()["rows"][0]["status"], "PAID");
    assert_eq!(listed.json()["rows"][0]["settled_amount_lyd"], "30.0500");
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/control/checkout-helper/does-not-exist",
            None,
            &[]
        )
        .await
        .json()["activeAttemptSecrets"],
        Value::Null
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/control/checkout-helper/does-not-exist/simulate-action",
            Some(json!({"action": "APPROVE_WITH_VARIANCE"})),
            &[]
        )
        .await
        .status,
        404
    );
}

#[ntex::test]
async fn the_control_plane_requires_its_token_when_configured() {
    let state = state_with(Config {
        control_token: Some("control-token-for-tests-012345".to_owned()),
        ..config()
    });
    let app = service(state).await;
    assert_eq!(
        request(&app, Method::GET, "/control/accounts", None, &[])
            .await
            .status,
        401
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/control/accounts",
            None,
            &[("x-fake-rails-control-token", "wrong-token-wrong-token")]
        )
        .await
        .status,
        401
    );
    let reply = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=edfali",
        None,
        &[(
            "x-fake-rails-control-token",
            "control-token-for-tests-012345",
        )],
    )
    .await;
    assert_eq!(reply.status, 200);
}

// ---------------------------------------------------------------------------------------------
// Remaining rail families and generic protocol behaviour
// ---------------------------------------------------------------------------------------------

#[ntex::test]
async fn redirect_embedded_push_and_wallet_rails_answer_their_protocol_shapes() {
    let app = service(state()).await;
    // Redirect (T-LYNC).
    let create = request(
        &app,
        Method::POST,
        "/rails/tlync/payment/create",
        Some(
            json!({"merchantRef": "T-1", "amount": "10.00", "return_url": "https://m.test/return"}),
        ),
        &[],
    )
    .await;
    assert_eq!(create.status, 200);
    assert!(create.json()["redirect_url"]
        .as_str()
        .unwrap_or("")
        .contains("/hosted/redirect/"));
    // Embedded / hosted session (MPGS).
    let session = request(
        &app,
        Method::POST,
        "/rails/mpgs/session",
        Some(json!({"reference": "MPGS-1", "amount": "11.00"})),
        &[],
    )
    .await;
    assert_eq!(session.status, 200);
    assert_eq!(session.json()["status"], "AWAITING_CUSTOMER");
    let confirm = request(
        &app,
        Method::POST,
        "/rails/mpgs/order/MPGS-1/confirm",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(confirm.json()["status"], "PAID");
    let order = request(&app, Method::GET, "/rails/mpgs/order/MPGS-1", None, &[]).await;
    assert_eq!(order.json()["status"], "PAID");
    let refund = request(
        &app,
        Method::POST,
        "/rails/mpgs/order/MPGS-1/refund",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(refund.json()["status"], "REFUNDED");
    // Push approval with a token + cancel.
    let token = request(
        &app,
        Method::POST,
        "/rails/mypay/auth/token",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(token.json()["token_type"], "Bearer");
    assert_eq!(token.json()["expires_in"], 600);
    let request_push = request(
        &app,
        Method::POST,
        "/rails/hawelli/request",
        Some(json!({"reference": "PUSH-H-1", "amount": "20.00"})),
        &[],
    )
    .await;
    assert_eq!(request_push.status, 200);
    assert!(request_push.json()["pay_code"].is_string());
    let cancel = request(
        &app,
        Method::POST,
        "/rails/hawelli/cancel",
        Some(json!({"reference": "PUSH-H-1"})),
        &[],
    )
    .await;
    assert_eq!(cancel.json()["status"], "CANCELLED");
    // CBL LYPay token + funds transfer + enquiry.
    request(
        &app,
        Method::POST,
        "/rails/cbl_lypay/api/v1/auth/token",
        Some(json!({})),
        &[],
    )
    .await;
    request(
        &app,
        Method::POST,
        "/rails/cbl_lypay/api/v1/payments/funds-transfers",
        Some(json!({"reference": "LY-1", "amount": "12.00"})),
        &[],
    )
    .await;
    let enquiry = request(
        &app,
        Method::GET,
        "/rails/cbl_lypay/api/v1/payments/funds-transfers/enquiry?reference=LY-1",
        None,
        &[],
    )
    .await;
    assert_eq!(enquiry.status, 200);
    // NeomPay ledger export.
    let export = request(&app, Method::GET, "/rails/neompay/ledger-export", None, &[]).await;
    assert_eq!(export.json()["gateway"], "neompay");
    assert!(export.json()["entries"].is_array());
}

#[ntex::test]
async fn unknown_gateways_and_endpoints_return_the_ts_error_codes() {
    let app = service(state()).await;
    let unknown = request(
        &app,
        Method::POST,
        "/rails/not-a-rail/verify",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.json()["code"], "UNKNOWN_GATEWAY");
    let endpoint = request(
        &app,
        Method::POST,
        "/rails/edfali/not-an-endpoint",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(endpoint.status, 404);
    assert_eq!(endpoint.json()["code"], "UNKNOWN_RAIL_ENDPOINT");
    assert_eq!(
        request(&app, Method::GET, "/nothing-here", None, &[])
            .await
            .status,
        404
    );
}

#[ntex::test]
async fn period_and_otp_magic_values_drive_the_fifteen_scenario_contract() {
    let app = service(state()).await;
    let scenario = |otp: &str, amount: &str, phone: &str| json!({"reference": format!("MAGIC-{otp}-{amount}"), "amount": amount, "phone": phone, "otp": otp});
    // Magic OTP 999999: terminal decline (HTTP 200 business failure).
    request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(scenario("999999", "10.00", "0911234567")),
        &[],
    )
    .await;
    let decline = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(scenario("999999", "10.00", "0911234567")),
        &[],
    )
    .await;
    assert_eq!(decline.json()["status"], "FAILED");
    assert_eq!(decline.json()["error"], "INSUFFICIENT_FUNDS");
    // Magic phone 9905: HTTP 500 gateway fault at SUBMIT.
    let reference = "MAGIC-PHONE-9905";
    let verify = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": reference, "amount": "10.00", "phone": "0911239905"})),
        &[],
    )
    .await;
    let otp = verify.json()["otp"].as_str().expect("otp").to_owned();
    let fault = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"reference": reference, "otp": otp, "phone": "0911239905"})),
        &[],
    )
    .await;
    assert_eq!(fault.status, 500);
    // Magic OTP 500500: HTTP 500.
    request(
        &app,
        Method::POST,
        "/rails/sadad/verify",
        Some(json!({"reference": "MAGIC-500500", "amount": "10.00", "phone": "0911234567"})),
        &[],
    )
    .await;
    let fault = request(
        &app,
        Method::POST,
        "/rails/sadad/confirm",
        Some(json!({"reference": "MAGIC-500500", "otp": "500500"})),
        &[],
    )
    .await;
    assert_eq!(fault.status, 500);
}

#[ntex::test]
async fn persisted_sqlite_survives_a_restart() {
    let path = std::env::temp_dir().join(format!(
        "fake-rails-rs-http-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    {
        let state = AppState::new(Config {
            db_path: path.to_string_lossy().into_owned(),
            ..config()
        })
        .expect("state");
        let app = service(state).await;
        request(
            &app,
            Method::POST,
            "/rails/edfali/verify",
            Some(json!({"reference": "PERSIST-1", "amount": "10.00", "phone": "0911234567"})),
            &[],
        )
        .await;
    }
    let state = AppState::new(Config {
        db_path: path.to_string_lossy().into_owned(),
        ..config()
    })
    .expect("reopen");
    let app = service(state).await;
    let found = request(
        &app,
        Method::GET,
        "/rails/edfali/status/PERSIST-1",
        None,
        &[],
    )
    .await;
    assert_eq!(found.json()["status"], "PENDING");
    drop(app);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.to_string_lossy()));
    }
}

#[ntex::test]
async fn per_account_lockout_applies_regardless_of_the_source_address() {
    let state = state_with(Config {
        portal_account_lockout: 3,
        ..config()
    });
    let app = service(state).await;
    let mut locked = false;
    for index in 0..7 {
        let reply = request(
            &app,
            Method::POST,
            "/portal-api/auth/login",
            Some(json!({"username": "victim_user", "password": format!("wrong-{index}")})),
            &[("x-forwarded-for", "203.0.113.1")],
        )
        .await;
        assert!(reply.status == 401 || reply.status == 429);
        locked = reply.status == 429;
        if locked {
            break;
        }
    }
    assert!(locked, "the per-account lockout must trip");
    let again = request(
        &app,
        Method::POST,
        "/portal-api/auth/login",
        Some(json!({"username": "victim_user", "password": "wrong-again"})),
        &[("x-forwarded-for", "198.51.100.77")],
    )
    .await;
    assert_eq!(again.status, 429);
}

#[ntex::test]
async fn malformed_json_login_is_a_400_server_error_like_express() {
    let app = service(state()).await;
    let builder = test::TestRequest::with_uri("/portal-api/auth/login")
        .method(Method::POST)
        .peer_addr("127.0.0.1:12345".parse().expect("peer"))
        .header("content-type", "application/json")
        .payload("{not-json");
    let reply = send(&app, builder.to_request()).await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json()["code"], "SERVER_ERROR");
}

#[ntex::test]
async fn otp_static_account_otp_is_honoured_on_confirm() {
    let app = service(state()).await;
    // Adjust the rich account's static OTP, then confirm with it.
    let accounts = request(
        &app,
        Method::GET,
        "/control/accounts?railCode=edfali",
        None,
        &[],
    )
    .await;
    let rich = accounts.json()["accounts"]
        .as_array()
        .and_then(|accounts| {
            accounts
                .iter()
                .find(|account| account["available_balance_lyd"] == "50000.0000")
        })
        .expect("rich")
        .clone();
    let identifier = rich["identifier"].as_str().expect("identifier").to_owned();
    let account_id = rich["id"].as_str().expect("id").to_owned();
    request(
        &app,
        Method::PATCH,
        &format!("/control/accounts/{account_id}"),
        Some(json!({"staticOtp": "777777", "reason": "static otp test"})),
        &[],
    )
    .await;
    let verify = request(
        &app,
        Method::POST,
        "/rails/edfali/verify",
        Some(json!({"reference": "STATIC-OTP-1", "amount": "2.00", "phone": identifier})),
        &[],
    )
    .await;
    assert_eq!(verify.json()["otp"], "777777");
    let confirm = request(
        &app,
        Method::POST,
        "/rails/edfali/confirm",
        Some(json!({"reference": "STATIC-OTP-1", "otp": "777777"})),
        &[],
    )
    .await;
    assert_eq!(confirm.json()["status"], "PAID");
}
