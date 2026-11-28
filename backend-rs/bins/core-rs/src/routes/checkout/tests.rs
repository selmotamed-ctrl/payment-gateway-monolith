//! Unit and database-gated tests for the checkout read routes.
//!
//! The database tests use the P3 development database (`PG_TEST_DATABASE_URL`, else
//! `DATABASE_URL`, else `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`,
//! schema 46). When it is unreachable every database test prints a skip line and returns; no test
//! fails for a missing database. Every row a test creates is removed by the test.
//!
//! The handlers are driven directly through their mounted route (the P3 dispatcher only matches
//! exact paths; the module doc records that limitation). Requests are real `TestRequest`s, so the
//! query string, headers and body are the ones the handler would see behind mTLS.

use std::sync::Arc;
use std::time::Duration;

use chrono::{Timelike, Utc};
use ntex::http::Method;
use ntex::util::Stream;
use ntex::web::test;
use ntex::web::types::Payload;
use serde_json::{json, Value};
use uuid::Uuid;

use pg_domain_auth::ExecutionPlane;

use super::*;
use crate::config::CoreConfig;
use crate::routes::Handler;
use crate::state::AppState;

const MASTER_KEY: &str = "core-rs-checkout-read-master-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip() -> Option<Arc<AppState>> {
    let url = database_url();
    let state = match AppState::connect(CoreConfig::for_tests(&url, MASTER_KEY)).await {
        Ok(state) => state,
        Err(error) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            return None;
        }
    };
    // A reachable but unmigrated database cannot host these tests; skip it like an unreachable one.
    let schema_ready = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables
                         WHERE table_schema = 'public' AND table_name = 'payment_links')",
    )
    .fetch_one(&state.pools.main)
    .await
    .unwrap_or(false);
    if !schema_ready {
        eprintln!("SKIP: database at {url} has no schema 46 (payment_links missing)");
        return None;
    }
    Some(state)
}

struct Response {
    status: u16,
    body: String,
    content_type: Option<String>,
    cache_control: Option<String>,
}

impl Response {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|_| panic!("expected JSON body, got {:?}", self.body))
    }

    fn code(&self) -> String {
        self.json()
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }
}

/// Call the mounted handler for a TS path template with an actual request path.
async fn call_route(
    state: &Arc<AppState>,
    template: &str,
    actual_path: &str,
    method: Method,
) -> Response {
    let route = super::routes()
        .into_iter()
        .find(|route| route.policy.path == template)
        .unwrap_or_else(|| panic!("route {template} is not mounted"));
    let Handler::Custom(handler) = route.handler else {
        panic!("{template} is not a custom handler");
    };
    let request = test::TestRequest::default()
        .method(method)
        .uri(actual_path)
        .to_http_request();
    let response = handler(state, &request, None, Payload(ntex::http::Payload::None)).await;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let cache_control = response
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = test::read_body(response).await;
    Response {
        status,
        body: String::from_utf8_lossy(&body).to_string(),
        content_type,
        cache_control,
    }
}

async fn get(state: &Arc<AppState>, template: &str, actual_path: &str) -> Response {
    call_route(state, template, actual_path, Method::GET).await
}

// ---- fixtures ------------------------------------------------------------------------------

struct LinkFixture {
    merchant: Uuid,
    gl_account: Uuid,
    wallet: Uuid,
    application: Uuid,
    link: Uuid,
    key: String,
}

async fn insert_link(state: &AppState, sandbox: bool) -> LinkFixture {
    let pool = &state.pools.main;
    let merchant = Uuid::new_v4();
    let gl_account = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let application = Uuid::new_v4();
    let link = Uuid::new_v4();
    let key = format!(
        "{}{}",
        if sandbox { "sbx_" } else { "test_" },
        Uuid::new_v4().simple()
    );
    sqlx::query(
        "INSERT INTO merchants (id, updated_at, legal_name, trade_name, status,
                                onboarding_channel, country, risk_tier)
         VALUES ($1, now(), 'Checkout Test Legal', 'Checkout Test', 'ACTIVE'::\"MerchantStatus\",
                 'DIRECT', 'LY', 'STANDARD'::\"RiskTier\")",
    )
    .bind(merchant)
    .execute(pool)
    .await
    .expect("insert merchant");
    sqlx::query(
        "INSERT INTO gl_accounts (id, updated_at, account_type, currency, shard_count)
         VALUES ($1, now(), 'MERCHANT_WALLET'::\"GlAccountType\", 'LYD', 1)",
    )
    .bind(gl_account)
    .execute(pool)
    .await
    .expect("insert gl account");
    sqlx::query(
        "INSERT INTO wallets (id, updated_at, merchant_id, gl_account_id, currency, status)
         VALUES ($1, now(), $2, $3, 'LYD', 'ACTIVE'::\"WalletStatus\")",
    )
    .bind(wallet)
    .bind(merchant)
    .bind(gl_account)
    .execute(pool)
    .await
    .expect("insert wallet");
    sqlx::query(
        "INSERT INTO applications (id, updated_at, merchant_id, name, assigned_wallet_id, status)
         VALUES ($1, now(), $2, 'Checkout Test App', $3, 'ACTIVE'::\"ApplicationStatus\")",
    )
    .bind(application)
    .bind(merchant)
    .bind(wallet)
    .execute(pool)
    .await
    .expect("insert application");
    sqlx::query(
        "INSERT INTO payment_links (id, updated_at, key, application_id, wallet_id, amount,
                                    currency, fee_bearer, env, state)
         VALUES ($1, now(), $2, $3, $4, 100.0000, 'LYD',
                 'MERCHANT_ABSORBS'::\"FeeBearer\", $5::\"GatewayEnvironmentType\",
                 'PENDING'::\"PaymentLinkState\")",
    )
    .bind(link)
    .bind(&key)
    .bind(application)
    .bind(wallet)
    .bind(if sandbox { "SANDBOX" } else { "LIVE" })
    .execute(pool)
    .await
    .expect("insert payment link");
    LinkFixture {
        merchant,
        gl_account,
        wallet,
        application,
        link,
        key,
    }
}

async fn cleanup_link(state: &AppState, fixture: &LinkFixture) {
    let pool = &state.pools.main;
    let _ = sqlx::query("DELETE FROM payment_links WHERE id = $1")
        .bind(fixture.link)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM applications WHERE id = $1")
        .bind(fixture.application)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM wallets WHERE id = $1")
        .bind(fixture.wallet)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM gl_accounts WHERE id = $1")
        .bind(fixture.gl_account)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM merchants WHERE id = $1")
        .bind(fixture.merchant)
        .execute(pool)
        .await;
}

struct AttemptFixture {
    link: LinkFixture,
    user: Uuid,
    gateway: Uuid,
    gateway_version: Uuid,
    rail: Uuid,
    route: Uuid,
    credential: Uuid,
    profile: Uuid,
    group: Uuid,
    attempt: Uuid,
    reference: String,
}

async fn insert_attempt(state: &AppState, status: &str) -> AttemptFixture {
    let pool = &state.pools.main;
    let link = insert_link(state, false).await;
    let user = Uuid::new_v4();
    let gateway = Uuid::new_v4();
    let gateway_version = Uuid::new_v4();
    let rail = Uuid::new_v4();
    let route = Uuid::new_v4();
    let credential = Uuid::new_v4();
    let profile = Uuid::new_v4();
    let group = Uuid::new_v4();
    let attempt = Uuid::new_v4();
    let reference = format!("PG-{}", Uuid::new_v4().simple());
    let suffix = Uuid::new_v4().simple().to_string();
    let now = Utc::now().naive_utc();
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", '{}'::jsonb, true, true, false,
                 'ACTIVE'::\"UserStatus\")",
    )
    .bind(user)
    .bind(format!("{suffix}@checkout-read.test"))
    .execute(pool)
    .await
    .expect("insert user");
    sqlx::query(
        "INSERT INTO gateways (id, updated_at, code, name, operator, aliases, kind, status,
                               verification_state, risk_class)
         VALUES ($1, now(), $2, 'Checkout Test Gateway', 'Test',
                 '{}'::jsonb, 'DIRECT'::\"GatewayKind\", 'DRAFT'::\"GatewayStatus\",
                 'UNVERIFIED'::\"GatewayVerificationState\", 'NORMAL'::\"GatewayRiskClass\")",
    )
    .bind(gateway)
    .bind(format!("TCK_{suffix}"))
    .execute(pool)
    .await
    .expect("insert gateway");
    sqlx::query(
        "INSERT INTO gateway_versions (id, updated_at, gateway_id, version_number,
                                       snapshot_ciphertext, content_hash, state, created_by)
         VALUES ($1, now(), $2, 1, 'snapshot', $3, 'DRAFT'::\"GatewayVersionState\", $4)",
    )
    .bind(gateway_version)
    .bind(gateway)
    .bind(format!("{suffix:0<64}"))
    .bind(user)
    .execute(pool)
    .await
    .expect("insert gateway version");
    sqlx::query(
        "INSERT INTO rails (id, updated_at, code, name_ar, name_en, collection_mode, currency,
                            capabilities)
         VALUES ($1, now(), $2, 'اختبار', 'Test Rail', 'OTP_PULL'::\"CollectionMode\", 'LYD',
                 '{}'::jsonb)",
    )
    .bind(rail)
    .bind(format!("RAIL_{suffix}"))
    .execute(pool)
    .await
    .expect("insert rail");
    sqlx::query(
        "INSERT INTO rail_routes (id, updated_at, rail_id, gateway_id, credential_policy, priority,
                                  routing_strategy, weight, cost_model, mismatch_policy, min_amount,
                                  status, health_state, health_computed_state, scope)
         VALUES ($1, now(), $2, $3, 'PLATFORM'::\"CredentialPolicy\", 0,
                 'EFFECTIVE_COST'::\"RoutingStrategy\", 100, '{}'::jsonb, '{}'::jsonb, 0,
                 'ACTIVE'::\"RouteStatus\", 'HEALTHY'::\"HealthState\",
                 'HEALTHY'::\"HealthState\", '{}'::jsonb)",
    )
    .bind(route)
    .bind(rail)
    .bind(gateway)
    .execute(pool)
    .await
    .expect("insert rail route");
    sqlx::query(
        "INSERT INTO credential_sets (id, updated_at, gateway_id, env, owner_type,
                                      settlement_target, entries_ciphertext, status)
         VALUES ($1, now(), $2, 'LIVE'::\"GatewayEnvironmentType\", 'PLATFORM'::\"CredentialOwnerType\",
                 'PLATFORM_CLEARING'::\"SettlementTarget\", '{}'::jsonb,
                 'VERIFIED'::\"CredentialStatus\")",
    )
    .bind(credential)
    .bind(gateway)
    .execute(pool)
    .await
    .expect("insert credential set");
    sqlx::query(
        "INSERT INTO commission_profiles (id, updated_at, rail_code, calc_type, flat_fee,
                                          percentage_rate, min_fee, fee_bearer_default,
                                          rounding_mode, effective_from)
         VALUES ($1, now(), $2, 'FLAT'::\"CommissionCalcType\", 0, 0, 0,
                 'MERCHANT_ABSORBS'::\"FeeBearer\", 'HALF_UP', $3)",
    )
    .bind(profile)
    .bind(format!("RAIL_{suffix}"))
    .bind(now)
    .execute(pool)
    .await
    .expect("insert commission profile");
    sqlx::query(
        "INSERT INTO attempt_groups (id, updated_at, link_id, customer_fingerprint)
         VALUES ($1, now(), $2, $3)",
    )
    .bind(group)
    .bind(link.link)
    .bind("a".repeat(64))
    .execute(pool)
    .await
    .expect("insert attempt group");
    sqlx::query(
        "INSERT INTO payment_attempts (id, updated_at, reference, link_id, attempt_group_id,
                                       application_id, merchant_id, rail_id, route_id,
                                       credential_set_id, gateway_version_id,
                                       commission_profile_id, env, mode, status,
                                       requested_amount, total_charged_amount, fee_bearer,
                                       currency, customer_fields_masked, context_ciphertext,
                                       expires_at, grace_expires_at)
         VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'LIVE'::\"GatewayEnvironmentType\", 'OTP_PULL',
                 $12::\"AttemptStatus\", 100.0000, 100.0000, 'MERCHANT_ABSORBS'::\"FeeBearer\",
                 'LYD', '{}'::jsonb, '', $13, $14)",
    )
    .bind(attempt)
    .bind(&reference)
    .bind(link.link)
    .bind(group)
    .bind(link.application)
    .bind(link.merchant)
    .bind(rail)
    .bind(route)
    .bind(credential)
    .bind(gateway_version)
    .bind(profile)
    .bind(status)
    .bind(now + chrono::Duration::minutes(30))
    .bind(now + chrono::Duration::hours(24))
    .execute(pool)
    .await
    .expect("insert payment attempt");
    AttemptFixture {
        link,
        user,
        gateway,
        gateway_version,
        rail,
        route,
        credential,
        profile,
        group,
        attempt,
        reference,
    }
}

async fn cleanup_attempt(state: &AppState, fixture: &AttemptFixture) {
    let pool = &state.pools.main;
    let _ = sqlx::query("DELETE FROM payment_attempts WHERE id = $1")
        .bind(fixture.attempt)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM attempt_groups WHERE id = $1")
        .bind(fixture.group)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM commission_profiles WHERE id = $1")
        .bind(fixture.profile)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM credential_sets WHERE id = $1")
        .bind(fixture.credential)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM rail_routes WHERE id = $1")
        .bind(fixture.route)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM rails WHERE id = $1")
        .bind(fixture.rail)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM gateway_versions WHERE id = $1")
        .bind(fixture.gateway_version)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM gateways WHERE id = $1")
        .bind(fixture.gateway)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(fixture.user)
        .execute(pool)
        .await;
    cleanup_link(state, &fixture.link).await;
}

// ---- policy and shape unit tests -----------------------------------------------------------

#[test]
fn policies_cover_the_eight_new_routes_and_the_channel_health() {
    let routes = super::routes();
    assert_eq!(routes.len(), 8);
    let expected = [
        CERTIFICATE_PATH,
        PAY_PATH,
        LOGS_PATH,
        STATUS_PATH,
        RETURN_PATH,
        SANDBOX_ACCOUNTS_PATH,
        SANDBOX_MOVEMENTS_PATH,
        SANDBOX_INSPECTOR_PATH,
    ];
    for expected_path in expected {
        let route = routes
            .iter()
            .find(|route| route.policy.path == expected_path)
            .unwrap_or_else(|| panic!("missing policy {expected_path}"));
        assert_eq!(route.policy.method, "GET");
        assert_eq!(route.policy.channel, pg_http::Channel::Checkout);
        assert_eq!(route.policy.authn, pg_http::Authn::None);
        assert!(route.policy.authorities.is_empty());
        assert_eq!(route.guard, crate::routes::PrincipalGuard::None);
        assert!(!route.policy.ts_origin.trim().is_empty());
    }
    let all: std::collections::BTreeSet<String> = routes
        .iter()
        .map(|route| route.policy.path.clone())
        .collect();
    assert_eq!(all.len(), 8, "duplicate checkout policy");
    // The ninth inventory GET is the channel health mounted centrally by the shell.
    assert!(crate::routes::find("GET", "/internal/checkout/health").is_some());
}

#[test]
fn path_parameters_follow_express_segments() {
    let actual = "/internal/checkout/pay/pl_abc/logs/018f-1/status";
    assert_eq!(path_param(STATUS_PATH, actual, "linkKey"), Some("pl_abc"));
    assert_eq!(path_param(STATUS_PATH, actual, "attemptId"), Some("018f-1"));
    assert_eq!(path_param(STATUS_PATH, actual, "publicId"), None);
    assert_eq!(
        path_param(PAY_PATH, "/internal/checkout/pay/pl_abc/extra", "linkKey"),
        None
    );
    assert_eq!(
        path_param(PAY_PATH, "/internal/checkout/other/pl_abc", "linkKey"),
        None
    );
    assert_eq!(
        path_param(PAY_PATH, "/internal/checkout/pay/", "linkKey"),
        None
    );
}

#[test]
fn parameter_validation_matches_the_zod_schemas() {
    let too_short = link_key_parameter(Some("abc")).expect_err("too short");
    assert_eq!(too_short.status, 400);
    assert_eq!(too_short.code, "INVALID_BODY");
    assert_eq!(
        too_short.details.as_ref().expect("details")[0]["code"],
        "too_small"
    );

    let too_long = link_key_parameter(Some(&"a".repeat(65))).expect_err("too long");
    assert_eq!(
        too_long.details.as_ref().expect("details")[0]["code"],
        "too_big"
    );

    let bad = link_key_parameter(Some("bad key")).expect_err("format");
    assert_eq!(
        bad.details.as_ref().expect("details")[0]["code"],
        "invalid_format"
    );
    assert_eq!(
        link_key_parameter(Some("pl_ok-1")).expect("valid"),
        "pl_ok-1"
    );

    assert!(attempt_id_parameter(Some("abc")).is_err());
    assert_eq!(attempt_id_parameter(Some("abcd")).expect("valid"), "abcd");
    assert_eq!(account_id_parameter(Some("a b")).expect("any chars"), "a b");
    assert!(certificate_id_parameter(Some("short")).is_err());
    assert_eq!(
        certificate_id_parameter(Some(&"p".repeat(16))).expect("16"),
        "p".repeat(16)
    );
}

#[test]
fn sandbox_account_payload_renames_and_drops_unknown_keys() {
    let account = json!({
        "id": "acc-1",
        "rail_code": "EDFALI",
        "gateway_code": "EDF",
        "instrument_type": "MOBILE_WALLET",
        "identifier": "0910000000",
        "holder_name": "Holder",
        "secret_pin": "1234",
        "expiry": null,
        "available_balance_lyd": "5000.0000",
        "reserved_balance_lyd": "0.0000",
        "daily_limit_lyd": "10000.0000",
        "daily_spent_lyd": "0.0000",
        "status": "ACTIVE",
        "static_otp": "123456",
        "notes": null,
        "currency": "LYD",
        "created_at": "2026-11-28T00:00:00.000Z"
    });
    let payload = sandbox_account_payload(&account);
    assert_eq!(payload["railCode"], "EDFALI");
    assert_eq!(payload["availableBalanceLyd"], "5000.0000");
    assert_eq!(payload["dailySpentDate"], Value::Null);
    assert_eq!(payload["merchantId"], Value::Null);
    assert!(payload.get("currency").is_none());
    assert!(payload.get("created_at").is_none());
    assert_eq!(payload["holderName"], "Holder");
}

#[test]
fn limit_and_percent_helpers_match_the_wire_contract() {
    assert_eq!(limit_argument(None), "100");
    assert_eq!(limit_argument(Some("25")), "25");
    assert_eq!(limit_argument(Some("025")), "25");
    assert_eq!(limit_argument(Some("abc")), "NaN");
    assert_eq!(percent_decode("PG-1%2F2"), "PG-1/2");
    assert_eq!(percent_decode("bad%zz"), "bad%zz");
    assert_eq!(percent_decode("é"), "é");
}

// ---- database-gated tests -----------------------------------------------------------------

#[tokio::test]
async fn unknown_links_and_attempts_keep_the_ts_error_codes() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let missing_key = format!("test_{}", Uuid::new_v4().simple());
    let pay = get(
        &state,
        PAY_PATH,
        &format!("/internal/checkout/pay/{missing_key}"),
    )
    .await;
    assert_eq!(pay.status, 404);
    assert_eq!(pay.code(), "PAYMENT_LINK_NOT_FOUND");

    let logs = get(
        &state,
        LOGS_PATH,
        &format!(
            "/internal/checkout/pay/{missing_key}/logs/{}",
            Uuid::new_v4()
        ),
    )
    .await;
    assert_eq!(logs.status, 404);
    assert_eq!(logs.code(), "PAYMENT_LINK_NOT_FOUND");

    let fixture = insert_link(&state, false).await;
    let logs = get(
        &state,
        LOGS_PATH,
        &format!(
            "/internal/checkout/pay/{}/logs/{}",
            fixture.key,
            Uuid::new_v4()
        ),
    )
    .await;
    assert_eq!(logs.status, 404);
    assert_eq!(logs.code(), "PAYMENT_ATTEMPT_NOT_FOUND");
    cleanup_link(&state, &fixture).await;
}

#[tokio::test]
async fn sandbox_inspector_is_forbidden_on_a_live_link() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_link(&state, false).await;
    let response = get(
        &state,
        SANDBOX_ACCOUNTS_PATH,
        &format!("/internal/checkout/pay/{}/sandbox-accounts", fixture.key),
    )
    .await;
    cleanup_link(&state, &fixture).await;
    assert_eq!(response.status, 403);
    assert_eq!(response.code(), "SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK");
}

#[tokio::test]
async fn a_sandbox_link_on_the_live_plane_is_a_plane_mismatch() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_link(&state, true).await;
    let response = get(
        &state,
        PAY_PATH,
        &format!("/internal/checkout/pay/{}", fixture.key),
    )
    .await;
    cleanup_link(&state, &fixture).await;
    assert_eq!(response.status, 409);
    assert_eq!(response.code(), "ENVIRONMENT_PLANE_MISMATCH");
}

#[tokio::test]
async fn pay_link_answers_the_summary_shape_even_without_rails() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_link(&state, false).await;
    // A currency no rail is configured for makes the visible set empty on a seeded database too,
    // so the fallback fee and the excluded reasons are deterministic.
    sqlx::query("UPDATE payment_links SET currency = 'ZZZ' WHERE id = $1")
        .bind(fixture.link)
        .execute(&state.pools.main)
        .await
        .expect("set test currency");
    let response = get(
        &state,
        PAY_PATH,
        &format!("/internal/checkout/pay/{}", fixture.key),
    )
    .await;
    cleanup_link(&state, &fixture).await;
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["env"], "LIVE");
    assert_eq!(body["linkKey"], fixture.key);
    assert_eq!(body["amount"], "100.0000");
    assert_eq!(body["currency"], "ZZZ");
    assert_eq!(body["feeBearerMode"], "MERCHANT_ABSORBS");
    assert_eq!(body["feeAmount"], "0.0000");
    assert_eq!(body["totalAmount"], "100.0000");
    assert_eq!(body["merchantAmount"], "100.0000");
    assert_eq!(body["visibleRails"], json!([]));
    assert!(body["excludedRails"].is_array());
    assert!(body.get("supportConfig").is_some());
    assert_eq!(body["splitPercent"], Value::Null);
    assert_eq!(body["allowlistedRedirectHosts"], json!([]));
}

#[tokio::test]
async fn populated_logs_and_a_terminal_status_stream() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_attempt(&state, "AWAITING_CUSTOMER").await;
    let logs = get(
        &state,
        LOGS_PATH,
        &format!(
            "/internal/checkout/pay/{}/logs/{}",
            fixture.link.key, fixture.attempt
        ),
    )
    .await;
    assert_eq!(logs.status, 200, "{}", logs.body);
    let body = logs.json();
    assert_eq!(body["attemptId"], fixture.attempt.to_string());
    assert_eq!(body["reference"], fixture.reference);
    assert_eq!(body["status"], "AWAITING_CUSTOMER");
    assert_eq!(body["amount"], "100.0000");
    assert_eq!(body["currency"], "LYD");
    assert_eq!(body["feeBearer"], "MERCHANT_ABSORBS");
    assert_eq!(body["otpAttempts"], 0);
    assert_eq!(body["clientAction"], Value::Null);
    assert_eq!(body["publicOutputs"], json!({}));

    sqlx::query(
        "UPDATE payment_attempts SET status = 'SUCCEEDED'::\"AttemptStatus\" WHERE id = $1",
    )
    .bind(fixture.attempt)
    .execute(&state.pools.main)
    .await
    .expect("update status");
    let streamed = get(
        &state,
        STATUS_PATH,
        &format!(
            "/internal/checkout/pay/{}/logs/{}/status",
            fixture.link.key, fixture.attempt
        ),
    )
    .await;
    assert_eq!(streamed.status, 200);
    assert_eq!(streamed.content_type.as_deref(), Some("text/event-stream"));
    assert_eq!(
        streamed.cache_control.as_deref(),
        Some("no-cache, no-transform")
    );
    assert!(
        streamed.body.contains("event: status\n"),
        "{}",
        streamed.body
    );
    assert!(
        streamed.body.contains("\"status\":\"SUCCEEDED\""),
        "{}",
        streamed.body
    );
    assert!(
        streamed.body.ends_with("\n\n"),
        "a terminal status must close the stream: {:?}",
        streamed.body
    );
    cleanup_attempt(&state, &fixture).await;
}

#[tokio::test]
async fn status_stream_emits_the_change_and_closes_on_terminal() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_attempt(&state, "AWAITING_CUSTOMER").await;
    let mut stream = super::sse::open_with(
        state.pools.main.clone(),
        fixture.attempt,
        fixture.reference.clone(),
        "AWAITING_CUSTOMER".to_owned(),
        None,
        Duration::from_millis(25),
    );
    let first = next_frame(&mut stream).await.expect("initial frame");
    let first = String::from_utf8_lossy(&first).to_string();
    assert!(
        first.contains("\"status\":\"AWAITING_CUSTOMER\""),
        "{first}"
    );

    let pool = state.pools.main.clone();
    let attempt = fixture.attempt;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        let _ = sqlx::query(
            "UPDATE payment_attempts SET status = 'SUCCEEDED'::\"AttemptStatus\" WHERE id = $1",
        )
        .bind(attempt)
        .execute(&pool)
        .await;
    });
    let second = tokio::time::timeout(Duration::from_secs(3), next_frame(&mut stream))
        .await
        .expect("a status change within the deadline")
        .expect("frame");
    let second = String::from_utf8_lossy(&second).to_string();
    assert!(second.contains("\"status\":\"SUCCEEDED\""), "{second}");
    let closed = tokio::time::timeout(Duration::from_secs(2), next_frame(&mut stream)).await;
    assert!(
        matches!(closed, Ok(None)),
        "the terminal frame must close the stream"
    );
    cleanup_attempt(&state, &fixture).await;
}

async fn next_frame(stream: &mut sse::StatusStream) -> Option<ntex::util::Bytes> {
    let frame =
        std::future::poll_fn(|context| std::pin::Pin::new(&mut *stream).poll_next(context)).await;
    frame.map(|result| result.unwrap_or_default())
}

#[tokio::test]
async fn return_info_reads_by_reference_and_rejects_unknown_tokens() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_attempt(&state, "VERIFYING").await;
    let found = get(
        &state,
        RETURN_PATH,
        &format!("/internal/checkout/return/{}", fixture.reference),
    )
    .await;
    assert_eq!(found.status, 200, "{}", found.body);
    let body = found.json();
    assert_eq!(body["attemptId"], fixture.attempt.to_string());
    assert_eq!(body["reference"], fixture.reference);
    assert_eq!(body["status"], "VERIFYING");
    assert_eq!(
        body["redirect"],
        format!("/pay/{}/status", fixture.reference)
    );

    let unknown = get(
        &state,
        RETURN_PATH,
        "/internal/checkout/return/PG-DOES-NOT-EXIST",
    )
    .await;
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.code(), "PAYMENT_ATTEMPT_NOT_FOUND");
    assert_eq!(
        unknown.json()["message"],
        "The attempt token is not recognised"
    );
    cleanup_attempt(&state, &fixture).await;
}

#[tokio::test]
async fn certificate_verification_is_opaque_and_status_aware() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let missing = get(
        &state,
        CERTIFICATE_PATH,
        &format!(
            "/internal/checkout/academy/certificates/{}",
            Uuid::new_v4().simple()
        ),
    )
    .await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.code(), "CERTIFICATE_NOT_FOUND");

    let pool = &state.pools.main;
    let user = Uuid::new_v4();
    let certificate = Uuid::new_v4();
    let public_id = Uuid::new_v4().simple().to_string();
    let display_id = format!("PG-AC-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let earned = Utc::now().with_nanosecond(0).unwrap_or_else(Utc::now);
    let expires = earned + chrono::Duration::days(365);
    let progress = json!({
        "schema": 1,
        "badges": [{
            "id": "FOUNDATION_CERTIFIED",
            "track": "FOUNDATION",
            "earnedAt": earned.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "expiresAt": expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "v": "1.0.0"
        }]
    });
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status, academy_progress_json)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", '{}'::jsonb, false, false, false,
                 'ACTIVE'::\"UserStatus\", $3)",
    )
    .bind(user)
    .bind(format!("{}@checkout-cert.test", Uuid::new_v4().simple()))
    .bind(progress)
    .execute(pool)
    .await
    .expect("insert user");
    sqlx::query(
        "INSERT INTO academy_certificates (id, updated_at, public_id, display_id, user_id,
                                           track_id, badge_code, holder_name, earned_at,
                                           expires_at, content_version, status)
         VALUES ($1, now(), $2, $3, $4, 'FOUNDATION', 'FOUNDATION_CERTIFIED', 'Test Holder',
                 $5, $6, '1.0.0', 'ACTIVE'::\"AcademyCertificateStatus\")",
    )
    .bind(certificate)
    .bind(&public_id)
    .bind(&display_id)
    .bind(user)
    .bind(earned)
    .bind(expires)
    .execute(pool)
    .await
    .expect("insert certificate");

    let valid = get(
        &state,
        CERTIFICATE_PATH,
        &format!("/internal/checkout/academy/certificates/{public_id}"),
    )
    .await;
    assert_eq!(valid.status, 200, "{}", valid.body);
    let body = valid.json();
    assert_eq!(body["certificateId"], display_id);
    assert_eq!(body["publicId"], public_id);
    assert_eq!(body["status"], "valid");
    assert_eq!(body["trackTitle"], "Foundation (everyone)");
    assert_eq!(body["badgeCode"], "FOUNDATION_CERTIFIED");
    assert_eq!(body["holderName"], "Test Holder");
    assert!(
        !body.to_string().contains(&user.to_string()),
        "no user id leaks"
    );

    sqlx::query(
        "UPDATE academy_certificates SET status = 'REVOKED'::\"AcademyCertificateStatus\" WHERE id = $1",
    )
    .bind(certificate)
    .execute(pool)
    .await
    .expect("revoke");
    let revoked = get(
        &state,
        CERTIFICATE_PATH,
        &format!("/internal/checkout/academy/certificates/{public_id}"),
    )
    .await;
    assert_eq!(revoked.json()["status"], "revoked");

    let _ = sqlx::query("DELETE FROM academy_certificates WHERE id = $1")
        .bind(certificate)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user)
        .execute(pool)
        .await;
}

#[tokio::test]
async fn checkout_health_reports_the_channel() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let route = crate::routes::find("GET", "/internal/checkout/health").expect("health route");
    let request = test::TestRequest::default()
        .method(Method::GET)
        .uri("/internal/checkout/health")
        .to_http_request();
    let response = match route.handler {
        Handler::ChannelHealth => {
            crate::routes::health::channel(&state, route.policy.channel, &request)
        }
        _ => panic!("checkout health is not the channel handler"),
    };
    let status = response.status().as_u16();
    let body = test::read_body(response).await;
    let body: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(status, 200);
    assert_eq!(body["channel"], "checkout");
    assert_eq!(body["status"], "ok");
    assert_eq!(state.config.execution_plane, ExecutionPlane::Live);
}
