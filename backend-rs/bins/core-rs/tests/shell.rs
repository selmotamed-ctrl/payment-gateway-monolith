//! Integration tests for the `core-rs` shell (P3-T07/T08/T10).
//!
//! They drive the real dispatcher (`core_rs::app::dispatch`) against the development PostgreSQL 18
//! database specified by `PG_TEST_DATABASE_URL`, `DATABASE_URL` or the project default
//! (`postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46). When the
//! database is unreachable every test prints a skip line and returns.
//!
//! Rows created by a test are removed at the end; generated ids never collide with the seed.

use std::sync::Arc;

use chrono::{Duration, Utc};
use core_rs::auth::RevocationStore;
use core_rs::config::CoreConfig;
use core_rs::routes;
use core_rs::state::AppState;
use ntex::http::header::{HeaderMap, HeaderValue};
use ntex::http::Method;
use ntex::web::test;
use pg_domain_auth::{
    generate_api_token, hash_access_token, sign_session_at, Channel, ExecutionPlane, SessionClaims,
};
use serde_json::Value;
use uuid::Uuid;

const MASTER_KEY: &str = "core-rs-integration-master-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip() -> Option<Arc<AppState>> {
    let url = database_url();
    match AppState::connect(CoreConfig::for_tests(&url, MASTER_KEY)).await {
        Ok(state) => Some(state),
        Err(error) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            None
        }
    }
}

struct Response {
    status: u16,
    headers: HeaderMap,
    body: String,
}

impl Response {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|_| panic!("expected JSON body, got {:?}", self.body))
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

async fn call(
    state: &Arc<AppState>,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Response {
    let mut request = test::TestRequest::default()
        .method(Method::from_bytes(method.as_bytes()).expect("method"))
        .uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let http_request = request.to_http_request();
    let response = core_rs::app::dispatch(
        state.clone(),
        http_request,
        ntex::web::types::Payload(ntex::http::Payload::None),
    )
    .await;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = test::read_body(response).await;
    Response {
        status,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    }
}

/// Insert a staff user and return its id.
async fn insert_user(state: &AppState, status: &str, authorities: Value) -> Uuid {
    let id = Uuid::new_v4();
    let email = format!("{id}@integration.local");
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", $3::jsonb, true, true, false, $4::\"UserStatus\")",
    )
    .bind(id)
    .bind(email)
    .bind(authorities)
    .bind(status)
    .execute(&state.pools.main)
    .await
    .expect("insert user");
    id
}

async fn delete_user(state: &AppState, id: Uuid) {
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await
        .expect("delete user");
}

fn mint_admin_session(user_id: Uuid, jti: Uuid, now: chrono::DateTime<Utc>) -> String {
    let claims = SessionClaims::new(user_id.to_string(), "COMPLIANCE")
        .with_authorities(["merchant:read"])
        .with_channel(Channel::Admin)
        .expect("admin channel");
    let mut claims = claims;
    claims.jti = Some(jti.to_string());
    claims.iat = Some(now.timestamp());
    claims.exp = Some(now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
    sign_session_at(&claims, MASTER_KEY, now).expect("sign")
}

fn auth_header(token: &str) -> Vec<(&'static str, String)> {
    vec![("authorization", format!("Bearer {token}"))]
}

fn as_pairs<'a>(pairs: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    pairs
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

#[tokio::test]
async fn health_payload_matches_the_contract() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(&state, "GET", "/health", &[]).await;
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["service"], "core-back");
    assert_eq!(body["implementation"], "rust");
    assert_eq!(body["release"], Value::Null);
    assert!(body["status"] == "ok" || body["status"] == "degraded");
    assert_eq!(
        body["msg"],
        if body["status"] == "ok" {
            "OK"
        } else {
            "DEGRADED"
        }
    );
    // `for_tests` disables the workers, so the queue is reported as disabled and the payload is
    // degraded even though the database answered.
    assert_eq!(body["queue"]["enabled"], false);
    assert_eq!(body["queue"]["thresholdMs"], 300_000);
    assert!(body["queue"]["degraded"].as_bool().is_some());
    assert_eq!(body["status"], "degraded");
    assert!(body["workers"].is_array());
    // A leader pool is configured, so the snapshot is present.
    let leader = &body["leader"];
    assert!(leader.is_object() || leader.is_null());
    if leader.is_object() {
        assert_eq!(leader["probeOk"], true, "the boot probe ran");
        assert!(leader["expected"]
            .as_array()
            .is_some_and(|keys| !keys.is_empty()));
        assert!(leader["backendPid"].as_i64().is_some());
        assert_eq!(
            leader["endpoint"]["database"],
            "payment_gateway_monolith_test"
        );
    }
    assert!(response.header("x-request-id").is_some());
}

#[tokio::test]
async fn channel_health_answers_all_three_edges() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    for channel in ["admin", "merchant", "checkout"] {
        let response = call(&state, "GET", &format!("/internal/{channel}/health"), &[]).await;
        assert_eq!(response.status, 200, "{channel}");
        let body = response.json();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["channel"], channel);
        assert_eq!(body["release"], Value::Null);
        assert_eq!(body["commit"], Value::Null);
    }
}

#[tokio::test]
async fn request_id_is_echoed_or_regenerated() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(
        &state,
        "GET",
        "/health",
        &[("x-request-id", "abc.DEF-1_2:3")],
    )
    .await;
    assert_eq!(response.header("x-request-id"), Some("abc.DEF-1_2:3"));

    let response = call(&state, "GET", "/health", &[("x-request-id", "not valid")]).await;
    let generated = response.header("x-request-id").expect("generated id");
    assert_eq!(generated.len(), 36, "UUIDv4 when the header is invalid");
    assert_ne!(generated, "not valid");

    let overlong = "a".repeat(130);
    let response = call(
        &state,
        "GET",
        "/health",
        &[("x-request-id", overlong.as_str())],
    )
    .await;
    assert_eq!(
        response.header("x-request-id").map(str::len),
        Some(36),
        "over 128 characters is replaced"
    );
}

#[tokio::test]
async fn unknown_paths_use_the_express_404_and_unported_routes_answer_501() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(&state, "GET", "/nope", &[]).await;
    assert_eq!(response.status, 404);
    assert!(response
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .starts_with("text/html"));
    assert!(response.body.contains("Cannot GET /nope"));

    // Write routes are not mounted yet (P7); use one as the stable unported probe.
    let response = call(&state, "POST", "/internal/admin/merchants", &[]).await;
    assert_eq!(response.status, 501);
    let body = response.json();
    assert_eq!(body["code"], "NOT_IMPLEMENTED_ROUTE");
    assert_eq!(body["path"], "/internal/admin/merchants");

    let response = call(&state, "GET", "/api/public/links", &[]).await;
    assert_eq!(response.status, 501);
}

#[tokio::test]
async fn body_limits_follow_the_ts_parsers() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    // Default JSON parser: Express's `PayloadTooLargeError` is not an ApiError/SyntaxError, so the
    // TS error handler answers 500 SERVER_ERROR with the request id as the reference.
    let response = call(
        &state,
        "POST",
        "/internal/admin/merchants",
        &[
            ("content-type", "application/json"),
            ("content-length", "2000000"),
            ("x-request-id", "body-limit-1"),
        ],
    )
    .await;
    assert_eq!(response.status, 500);
    let body = response.json();
    assert_eq!(body["code"], "SERVER_ERROR");
    assert_eq!(body["reference"], "body-limit-1");

    // The report-engine prefix is wrapped and answers 413 with the configured limit.
    let response = call(
        &state,
        "POST",
        "/internal/admin/report-engine/specs",
        &[
            ("content-type", "application/json"),
            ("content-length", "25000000"),
        ],
    )
    .await;
    assert_eq!(response.status, 413);
    let body = response.json();
    assert_eq!(body["code"], "PAYLOAD_TOO_LARGE");
    assert_eq!(body["details"]["limit"], 24_000_000);

    // A raw-body route keeps its own limit: 101 MB is over the 100 MB reconciliation limit.
    let response = call(
        &state,
        "POST",
        "/internal/admin/reconciliation/upload",
        &[
            ("content-type", "application/octet-stream"),
            ("content-length", "101000000"),
        ],
    )
    .await;
    assert_eq!(response.status, 500, "Express raw() parity");

    // A body that fits is not refused by the guard (the route then answers 501).
    let response = call(
        &state,
        "POST",
        "/internal/admin/merchants",
        &[
            ("content-type", "application/json"),
            ("content-length", "1024"),
        ],
    )
    .await;
    assert_eq!(response.status, 501);
}

#[tokio::test]
async fn auth_required_without_a_bearer_token() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(&state, "GET", "/internal/admin/auth/me", &[]).await;
    assert_eq!(response.status, 401);
    let body = response.json();
    assert_eq!(body["code"], "AUTH_REQUIRED");
    assert!(body["reference"].is_string());
}

#[tokio::test]
async fn session_double_check_happy_path_and_failures() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let now = Utc::now();
    let user = insert_user(&state, "ACTIVE", serde_json::json!(["merchant:read"])).await;
    let jti = Uuid::new_v4();
    let token = mint_admin_session(user, jti, now);
    let pairs = auth_header(&token);
    let headers = as_pairs(&pairs);

    let response = call(&state, "GET", "/internal/admin/auth/me", &headers).await;
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["platformName"], "Payment Gateway");
    assert_eq!(body["version"], "dev");
    assert_eq!(body["suspended"], false);
    assert_eq!(body["communication"], Value::Null);
    assert_eq!(body["principal"]["kind"], "session");
    assert_eq!(body["principal"]["userId"], user.to_string());
    assert_eq!(body["principal"]["role"], "COMPLIANCE");
    assert_eq!(body["principal"]["sessionChannel"], "admin");
    assert_eq!(
        body["principal"]["authorities"],
        serde_json::json!(["merchant:read"])
    );

    // Revoked by the durable table (Redis is not configured in the test).
    sqlx::query("INSERT INTO session_revocations (jti, expires_at) VALUES ($1, $2)")
        .bind(jti.to_string())
        .bind(now + Duration::hours(1))
        .execute(&state.pools.main)
        .await
        .expect("revocation row");
    let response = call(&state, "GET", "/internal/admin/auth/me", &headers).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "SESSION_REVOKED");
    sqlx::query("DELETE FROM session_revocations WHERE jti = $1")
        .bind(jti.to_string())
        .execute(&state.pools.main)
        .await
        .expect("cleanup revocation");

    // `sessionsInvalidBefore` invalidates older tokens.
    sqlx::query("UPDATE users SET sessions_invalid_before = $2 WHERE id = $1")
        .bind(user)
        .bind(now + Duration::minutes(5))
        .execute(&state.pools.main)
        .await
        .expect("invalidate");
    let response = call(&state, "GET", "/internal/admin/auth/me", &headers).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "SESSION_REVOKED");
    sqlx::query("UPDATE users SET sessions_invalid_before = NULL WHERE id = $1")
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("reset invalid-before");

    // Empty authorities.
    sqlx::query("UPDATE users SET authorities_map = '[]'::jsonb WHERE id = $1")
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("empty authorities");
    let response = call(&state, "GET", "/internal/admin/auth/me", &headers).await;
    assert_eq!(response.status, 403);
    assert_eq!(response.json()["code"], "SESSION_AUTHORITIES_EMPTY");
    sqlx::query("UPDATE users SET authorities_map = $2::jsonb WHERE id = $1")
        .bind(user)
        .bind(serde_json::json!(["merchant:read"]))
        .execute(&state.pools.main)
        .await
        .expect("restore authorities");

    // Inactive user.
    sqlx::query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1")
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("suspend");
    let response = call(&state, "GET", "/internal/admin/auth/me", &headers).await;
    assert_eq!(response.status, 403);
    assert_eq!(response.json()["code"], "SESSION_USER_INACTIVE");
    sqlx::query("UPDATE users SET status = 'ACTIVE' WHERE id = $1")
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("reactivate");

    // Missing user.
    let ghost = mint_admin_session(Uuid::new_v4(), Uuid::new_v4(), now);
    let pairs = auth_header(&ghost);
    let response = call(&state, "GET", "/internal/admin/auth/me", &as_pairs(&pairs)).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "SESSION_USER_MISSING");

    // Expired token.
    let expired_now = now - Duration::hours(13);
    let expired = mint_admin_session(user, Uuid::new_v4(), expired_now);
    let pairs = auth_header(&expired);
    let response = call(&state, "GET", "/internal/admin/auth/me", &as_pairs(&pairs)).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "SESSION_INVALID");

    // A merchant-audience token cannot open the admin channel.
    let claims = SessionClaims::new(user.to_string(), "COMPLIANCE")
        .with_authorities(["merchant:read"])
        .with_channel(Channel::Merchant)
        .expect("merchant channel");
    let token = sign_session_at(&claims, MASTER_KEY, now).expect("sign");
    let pairs = auth_header(&token);
    let response = call(&state, "GET", "/internal/admin/auth/me", &as_pairs(&pairs)).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "SESSION_AUDIENCE_INVALID");

    // A merchant user session is not a staff principal.
    let merchant_user = insert_user(&state, "ACTIVE", serde_json::json!(["merchant:read"])).await;
    sqlx::query("UPDATE users SET role = 'MERCHANT_ADMIN', merchant_id = $2 WHERE id = $1")
        .bind(merchant_user)
        .bind(active_merchant_id(&state).await)
        .execute(&state.pools.main)
        .await
        .expect("merchant role");
    let claims = SessionClaims::new(merchant_user.to_string(), "MERCHANT_ADMIN")
        .with_merchant(active_merchant_id(&state).await.to_string())
        .with_authorities(["merchant:read"])
        .with_channel(Channel::Merchant)
        .expect("merchant channel");
    let token = sign_session_at(&claims, MASTER_KEY, now).expect("sign");
    let pairs = auth_header(&token);
    let response = call(&state, "GET", "/internal/admin/auth/me", &as_pairs(&pairs)).await;
    assert_eq!(response.status, 403);
    assert_eq!(response.json()["code"], "STAFF_PRINCIPAL_REQUIRED");
    delete_user(&state, merchant_user).await;

    // Garbage token.
    let response = call(
        &state,
        "GET",
        "/internal/admin/auth/me",
        &[("authorization", "Bearer not.a.jwt")],
    )
    .await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "SESSION_INVALID");

    delete_user(&state, user).await;
}

async fn active_merchant_id(state: &AppState) -> Uuid {
    sqlx::query_scalar("SELECT id FROM merchants WHERE status = 'ACTIVE' LIMIT 1")
        .fetch_one(&state.pools.main)
        .await
        .expect("an ACTIVE merchant exists in the seeded database")
}

struct TokenFixture {
    token_id: Uuid,
    raw: String,
}

/// Insert an access token bound to an existing application of a merchant in `merchant_status`.
async fn insert_token(
    state: &AppState,
    raw: &str,
    merchant_status: &str,
    env: &str,
    ip_whitelist: Option<&str>,
) -> Option<TokenFixture> {
    let pair: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT a.id, a.merchant_id
           FROM applications a
           JOIN merchants m ON m.id = a.merchant_id
          WHERE m.status::text = $1
          LIMIT 1",
    )
    .bind(merchant_status)
    .fetch_optional(&state.pools.main)
    .await
    .expect("application lookup");
    let Some((application_id, merchant_id)) = pair else {
        eprintln!("SKIP: no application for a {merchant_status} merchant");
        return None;
    };
    let token_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO access_tokens (id, updated_at, merchant_id, application_id, name,
                                    token_hash, last_four, scopes, ip_whitelist_enabled, env)
         VALUES ($1, now(), $2, $3, 'integration-test', $4, 'test', $5::jsonb, $6,
                 $7::\"GatewayEnvironmentType\")",
    )
    .bind(token_id)
    .bind(merchant_id)
    .bind(application_id)
    .bind(hash_access_token(raw))
    .bind(serde_json::json!(["payment:read"]))
    .bind(ip_whitelist.is_some())
    .bind(env)
    .execute(&state.pools.main)
    .await
    .expect("insert access token");
    if let Some(cidr) = ip_whitelist {
        sqlx::query(
            "INSERT INTO access_token_ips (id, updated_at, token_id, cidr)
             VALUES ($1, now(), $2, $3)",
        )
        .bind(Uuid::new_v4())
        .bind(token_id)
        .bind(cidr)
        .execute(&state.pools.main)
        .await
        .expect("insert token ip");
    }
    Some(TokenFixture {
        token_id,
        raw: raw.to_owned(),
    })
}

async fn delete_token(state: &AppState, token_id: Uuid) {
    sqlx::query("DELETE FROM access_tokens WHERE id = $1")
        .bind(token_id)
        .execute(&state.pools.main)
        .await
        .expect("delete token");
}

fn bearer(raw: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ntex::http::header::HeaderName::from_static("authorization"),
        HeaderValue::from_str(&format!("Bearer {raw}")).expect("header"),
    );
    headers
}

#[tokio::test]
async fn api_token_double_check_happy_path_and_failures() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let now = Utc::now();

    // Happy path.
    let raw = generate_api_token(ExecutionPlane::Live);
    let Some(fixture) = insert_token(&state, &raw, "ACTIVE", "LIVE", None).await else {
        return;
    };
    let principal = state
        .auth
        .authenticate(&bearer(&fixture.raw), now)
        .await
        .expect("valid token");
    assert_eq!(principal.kind, pg_domain_auth::PrincipalKind::ApiToken);
    assert_eq!(principal.role.as_deref(), Some("MERCHANT_API"));
    assert!(principal.merchant_id.is_some());
    assert_eq!(principal.scopes, vec!["payment:read".to_owned()]);
    assert_eq!(
        principal.token_id.as_deref(),
        Some(fixture.token_id.to_string().as_str())
    );
    // `lastUsedAt` is touched.
    let last_used: Option<chrono::NaiveDateTime> =
        sqlx::query_scalar("SELECT last_used_at FROM access_tokens WHERE id = $1")
            .bind(fixture.token_id)
            .fetch_one(&state.pools.main)
            .await
            .expect("last used");
    assert!(last_used.is_some());

    // Unknown token (valid shape, no row).
    let unknown = generate_api_token(ExecutionPlane::Live);
    let error = state
        .auth
        .authenticate(&bearer(&unknown), now)
        .await
        .expect_err("unknown token");
    assert_eq!(error.code, "ACCESS_TOKEN_INVALID");

    // Revoked.
    sqlx::query("UPDATE access_tokens SET revoked_at = now() WHERE id = $1")
        .bind(fixture.token_id)
        .execute(&state.pools.main)
        .await
        .expect("revoke");
    let error = state
        .auth
        .authenticate(&bearer(&fixture.raw), now)
        .await
        .expect_err("revoked token");
    assert_eq!(error.code, "ACCESS_TOKEN_REVOKED");
    sqlx::query("UPDATE access_tokens SET revoked_at = NULL WHERE id = $1")
        .bind(fixture.token_id)
        .execute(&state.pools.main)
        .await
        .expect("unrevoke");

    // Expired.
    sqlx::query("UPDATE access_tokens SET expires_at = $2 WHERE id = $1")
        .bind(fixture.token_id)
        .bind((now - Duration::minutes(1)).naive_utc())
        .execute(&state.pools.main)
        .await
        .expect("expire");
    let error = state
        .auth
        .authenticate(&bearer(&fixture.raw), now)
        .await
        .expect_err("expired token");
    assert_eq!(error.code, "ACCESS_TOKEN_EXPIRED");
    sqlx::query("UPDATE access_tokens SET expires_at = NULL WHERE id = $1")
        .bind(fixture.token_id)
        .execute(&state.pools.main)
        .await
        .expect("unexpire");
    delete_token(&state, fixture.token_id).await;

    // IP allow-list: allowed and refused.
    let raw = generate_api_token(ExecutionPlane::Live);
    let Some(fixture) = insert_token(&state, &raw, "ACTIVE", "LIVE", Some("10.0.0.0/8")).await
    else {
        return;
    };
    let mut headers = bearer(&fixture.raw);
    headers.insert(
        ntex::http::header::HeaderName::from_static("x-real-client-ip"),
        HeaderValue::from_static("10.1.2.3"),
    );
    let principal = state
        .auth
        .authenticate(&headers, now)
        .await
        .expect("allowed address");
    assert!(principal.merchant_id.is_some());
    headers.insert(
        ntex::http::header::HeaderName::from_static("x-real-client-ip"),
        HeaderValue::from_static("11.1.2.3"),
    );
    let error = state
        .auth
        .authenticate(&headers, now)
        .await
        .expect_err("refused address");
    assert_eq!(error.code, "ACCESS_TOKEN_IP_NOT_ALLOWED");
    // A request without the forwarded address cannot satisfy a list.
    let error = state
        .auth
        .authenticate(&bearer(&fixture.raw), now)
        .await
        .expect_err("no address");
    assert_eq!(error.code, "ACCESS_TOKEN_IP_NOT_ALLOWED");
    delete_token(&state, fixture.token_id).await;

    // Suspended merchant.
    let raw = generate_api_token(ExecutionPlane::Live);
    let Some(fixture) = insert_token(&state, &raw, "SUSPENDED", "LIVE", None).await else {
        return;
    };
    let error = state
        .auth
        .authenticate(&bearer(&fixture.raw), now)
        .await
        .expect_err("suspended merchant");
    assert_eq!(error.code, "MERCHANT_NOT_ACTIVE");
    assert_eq!(
        error.details.as_ref().and_then(|value| value.get("status")),
        Some(&serde_json::json!("SUSPENDED"))
    );
    delete_token(&state, fixture.token_id).await;

    // Plane prefix mismatch (checked before any lookup).
    let sandbox = generate_api_token(ExecutionPlane::Sandbox);
    let error = state
        .auth
        .authenticate(&bearer(&sandbox), now)
        .await
        .expect_err("sandbox token on live");
    assert_eq!(error.code, "SANDBOX_TOKEN_ON_LIVE_PLANE");

    // The HTTP route refuses a token principal on the staff channel.
    let raw = generate_api_token(ExecutionPlane::Live);
    let Some(fixture) = insert_token(&state, &raw, "ACTIVE", "LIVE", None).await else {
        return;
    };
    let pairs = auth_header(&fixture.raw);
    let response = call(&state, "GET", "/internal/admin/auth/me", &as_pairs(&pairs)).await;
    assert_eq!(response.status, 403);
    assert_eq!(response.json()["code"], "STAFF_PRINCIPAL_REQUIRED");
    delete_token(&state, fixture.token_id).await;
}

/// The private Redis/Valkey of the development stack, or `None` when it is not running.
async fn redis_manager() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("PG_TEST_REDIS_URL")
        .or_else(|_| std::env::var("STORAGE_TEST_REDIS_URL"))
        .unwrap_or_else(|_| "redis://127.0.0.1:56379".to_owned());
    let client = match redis::Client::open(url.clone()) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("SKIP: Redis URL {url} is invalid: {error}");
            return None;
        }
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        client.get_connection_manager(),
    )
    .await
    {
        Ok(Ok(manager)) => Some(manager),
        _ => {
            eprintln!("SKIP: Redis is unreachable at {url}");
            None
        }
    }
}

#[tokio::test]
async fn session_revocation_uses_redis_then_the_table() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let Some(manager) = redis_manager().await else {
        return;
    };
    let store = RevocationStore::new(state.pools.main.clone(), Some(manager.clone()));
    let jti = format!("integration-{}", Uuid::new_v4());
    let key = pg_redis::revocation_key(&jti);
    let now = Utc::now();
    let mut commands = manager.clone();

    // Table only: a durable row decides and re-warms the Redis flag.
    sqlx::query("INSERT INTO session_revocations (jti, expires_at) VALUES ($1, $2)")
        .bind(&jti)
        .bind(now + Duration::hours(1))
        .execute(&state.pools.main)
        .await
        .expect("revocation row");
    assert!(store.is_revoked(Some(&jti), now).await);
    let warmed: i64 = redis::cmd("PTTL")
        .arg(&key)
        .query_async(&mut commands)
        .await
        .expect("pttl");
    assert!(warmed > 0, "a table hit writes the flag back");

    // Neither copy: not revoked.
    sqlx::query("DELETE FROM session_revocations WHERE jti = $1")
        .bind(&jti)
        .execute(&state.pools.main)
        .await
        .expect("cleanup row");
    let _: i64 = redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut commands)
        .await
        .expect("del");
    assert!(!store.is_revoked(Some(&jti), now).await);

    // Redis-only flag (evicted-row case): revoked without touching the table.
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("PX")
        .arg(60_000)
        .query_async(&mut commands)
        .await
        .expect("set flag");
    assert!(store.is_revoked(Some(&jti), now).await);

    // `revoke()` writes both copies.
    let other = format!("integration-{}", Uuid::new_v4());
    store
        .revoke(&other, now.timestamp() + 3_600, now)
        .await
        .expect("revoke");
    assert!(store.is_revoked(Some(&other), now).await);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM session_revocations WHERE jti = $1")
        .bind(&other)
        .fetch_one(&state.pools.main)
        .await
        .expect("revocation rows");
    assert_eq!(rows, 1);
    let other_key = pg_redis::revocation_key(&other);
    let ttl: i64 = redis::cmd("PTTL")
        .arg(&other_key)
        .query_async(&mut commands)
        .await
        .expect("pttl");
    assert!(ttl > 0);

    // An empty `jti` is never revoked (`isSessionRevoked(null)`).
    assert!(!store.is_revoked(None, now).await);

    // Cleanup.
    for jti in [&jti, &other] {
        sqlx::query("DELETE FROM session_revocations WHERE jti = $1")
            .bind(jti)
            .execute(&state.pools.main)
            .await
            .expect("cleanup row");
        let _: i64 = redis::cmd("DEL")
            .arg(pg_redis::revocation_key(jti))
            .query_async(&mut commands)
            .await
            .expect("cleanup key");
    }
}

#[tokio::test]
async fn mtls_cn_table_and_guard() {
    // The CN table (chapter 2 §1) is pure.
    assert_eq!(
        pg_mtls::allowed_channel_cns("/internal/admin/health"),
        Some(&["admin-back"][..])
    );
    assert_eq!(
        pg_mtls::allowed_channel_cns("/internal/merchant/health"),
        Some(&["merchant-back"][..])
    );
    assert_eq!(
        pg_mtls::allowed_channel_cns("/internal/checkout/health"),
        Some(&["checkout-back"][..])
    );
    assert_eq!(
        pg_mtls::allowed_channel_cns("/internal/sandbox/overview"),
        Some(&["merchant-back", "admin-back"][..])
    );
    assert_eq!(pg_mtls::allowed_channel_cns("/health"), None);

    // The guard itself: dev mode skips it, mTLS mode without a peer certificate is
    // `401 MTLS_UNAUTHORIZED "could not be inspected"`.
    let request = test::TestRequest::default()
        .uri("/internal/admin/health")
        .to_http_request();
    assert!(core_rs::auth::require_channel_identity(&request, false).is_ok());
    let error = core_rs::auth::require_channel_identity(&request, true).expect_err("no cert");
    assert_eq!(error.status, 401);
    assert_eq!(error.code, "MTLS_UNAUTHORIZED");
}

#[tokio::test]
async fn routes_policy_document_covers_every_mounted_route() {
    // CI-style check: the committed document names exactly the mounted routes.
    routes::check_policy_document(routes::COMMITTED_POLICY).expect("committed policy is current");
    let stale = r#"[{"method":"GET","path":"/health","tsOrigin":"x"},{"method":"GET","path":"/gone","tsOrigin":"y"}]"#;
    assert!(routes::check_policy_document(stale)
        .expect_err("unknown route")
        .contains("unknown route"));
}
