//! DB-gated tests for the global search route.
//!
//! Handlers are driven directly with a JSON payload. The database is the project test database
//! (override with `PG_TEST_DATABASE_URL`); the merchant and user rows are removed at the end.

use std::sync::Arc;

use ntex::http::Method;
use ntex::web::test;
use ntex::web::types::Payload;
use pg_domain_auth::{Channel, Principal, PrincipalKind};
use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::config::CoreConfig;
use crate::state::AppState;

const MASTER_KEY: &str = "core-rs-search-slice-master-key-0123456789";
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

fn principal(user_id: Uuid, role: &str, authorities: &[&str]) -> Principal {
    Principal {
        kind: PrincipalKind::Session,
        user_id: Some(user_id.to_string()),
        role: Some(role.to_owned()),
        merchant_id: None,
        application_id: None,
        authorities: authorities
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        scopes: Vec::new(),
        token_id: None,
        token_plane: None,
        session_jti: None,
        session_exp: None,
        session_channel: Some(Channel::Admin),
        app_scope_ids: Vec::new(),
    }
}

async fn insert_user(state: &AppState, email: &str, authorities: &[&str]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", $3::jsonb, true, true, false, 'ACTIVE')",
    )
    .bind(id)
    .bind(email)
    .bind(serde_json::json!(authorities))
    .execute(&state.pools.main)
    .await
    .expect("insert user");
    id
}

async fn insert_merchant(state: &AppState, display_name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO merchants (id, updated_at, version, legal_name, trade_name, display_name,
                                onboarding_channel, country, status, contact_email)
         VALUES ($1, now(), 1, $2, $2, $2, 'SELF_SERVICE', 'LY', 'ACTIVE', $3)",
    )
    .bind(id)
    .bind(display_name)
    .bind(format!("{id}@merchant-slice.local"))
    .execute(&state.pools.main)
    .await
    .expect("insert merchant");
    id
}

async fn cleanup(state: &AppState, merchant: Option<Uuid>, user: Uuid) {
    if let Some(merchant) = merchant {
        sqlx::query("DELETE FROM merchants WHERE id = $1")
            .bind(merchant)
            .execute(&state.pools.main)
            .await
            .expect("delete merchant");
    }
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("delete user");
}

async fn call_search(
    state: &Arc<AppState>,
    principal: Option<&Principal>,
    body: &Value,
) -> (u16, Value) {
    let (request, payload, ()) = test::TestRequest::default()
        .method(Method::POST)
        .uri("/internal/admin/search")
        .header("content-type", "application/json")
        .payload(serde_json::to_vec(body).expect("json"))
        .to_http_parts();
    let response = search(state, &request, principal, Payload(payload)).await;
    let status = response.status().as_u16();
    let body = test::read_body(response).await;
    let value = serde_json::from_slice(&body[..]).unwrap_or(Value::Null);
    (status, value)
}

fn providers(body: &Value) -> Vec<&str> {
    body["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|item| item["provider"].as_str())
        .collect()
}

#[tokio::test]
async fn merchant_and_user_hits_are_ranked_with_their_scores() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let unique = Uuid::new_v4().simple().to_string();
    let token = format!("Qq{unique}");
    let merchant = insert_merchant(&state, &token).await;
    let user = insert_user(
        &state,
        &format!("{}-ops@example.com", token.to_lowercase()),
        &["merchant:read"],
    )
    .await;
    let caller = principal(user, "COMPLIANCE", &["merchant:read", "user:read"]);

    let (status, body) = call_search(&state, Some(&caller), &json!({ "query": token })).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["partial"], false);
    assert_eq!(body["total"], 2);
    let items = body["items"].as_array().expect("items");
    assert_eq!(items[0]["provider"], "merchant");
    assert_eq!(items[0]["score"], 900, "primary exact");
    assert_eq!(items[0]["id"], merchant.to_string(), "{body}");
    assert_eq!(items[0]["merchantId"], merchant.to_string());
    assert_eq!(items[1]["provider"], "user");
    assert_eq!(items[1]["score"], 750, "exact-field prefix");
    assert_eq!(items[1]["id"], user.to_string(), "{body}");

    // Without `merchant:read` the merchant provider is silently skipped.
    let user_only = principal(user, "COMPLIANCE", &["security:read"]);
    let (status, body) = call_search(&state, Some(&user_only), &json!({ "query": token })).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(providers(&body), vec!["user"]);

    cleanup(&state, Some(merchant), user).await;
}

#[tokio::test]
async fn explicit_types_and_aliases_narrow_the_providers() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let unique = Uuid::new_v4().simple().to_string();
    let token = format!("Rr{unique}");
    let merchant = insert_merchant(&state, &format!("{token} Commerce")).await;
    let user = insert_user(
        &state,
        &format!("{}-ops@example.com", token.to_lowercase()),
        &[],
    )
    .await;
    let caller = principal(user, "COMPLIANCE", &["merchant:read", "user:read"]);

    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": token, "types": ["merchant"] }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(providers(&body), vec!["merchant"]);

    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": format!("type:user {token}") }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(providers(&body), vec!["user"], "type: alias");

    // An explicit empty list means "nothing", like the TS `new Set([])` path.
    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": token, "types": [] }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 0);
    assert_eq!(body["partial"], false);

    cleanup(&state, Some(merchant), user).await;
}

#[tokio::test]
async fn an_unknown_term_returns_an_empty_non_partial_response() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, &format!("{}@search.local", Uuid::new_v4()), &[]).await;
    let caller = principal(user, "COMPLIANCE", &["merchant:read", "user:read"]);
    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": format!("zz-no-match-{}", Uuid::new_v4()) }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["items"].as_array().map(Vec::len), Some(0));
    assert_eq!(body["total"], 0);
    assert_eq!(body["partial"], false);
    assert_eq!(body["query"], body["query"].as_str().expect("query"));
    cleanup(&state, None, user).await;
}

#[tokio::test]
async fn validation_authority_and_staff_rules_are_enforced() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, &format!("{}@search.local", Uuid::new_v4()), &[]).await;
    let caller = principal(user, "COMPLIANCE", &["merchant:read"]);

    let (status, body) = call_search(&state, Some(&caller), &json!({ "query": "a" })).await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "INVALID_BODY");
    assert_eq!(body["details"][0]["path"][0], "query");

    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": "acme", "types": ["voucher"] }),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "SEARCH_TYPE_UNSUPPORTED");
    assert_eq!(body["details"]["types"][0], "voucher");

    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": "acme", "unexpected": true }),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["details"][0]["code"], "unrecognized_keys");

    // No staff-read authority at all.
    let no_read = principal(user, "COMPLIANCE", &[]);
    let (status, body) = call_search(&state, Some(&no_read), &json!({ "query": "acme" })).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "AUTHORITY_REQUIRED");
    assert_eq!(body["details"]["required"][0], "merchant:read");

    // A merchant principal never reaches the admin channel.
    let mut merchant_user = principal(user, "MERCHANT_ADMIN", &["merchant:read"]);
    merchant_user.merchant_id = Some(Uuid::new_v4().to_string());
    let (status, body) =
        call_search(&state, Some(&merchant_user), &json!({ "query": "acme" })).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "STAFF_PRINCIPAL_REQUIRED");

    let (status, body) = call_search(&state, None, &json!({ "query": "acme" })).await;
    assert_eq!(status, 401);
    assert_eq!(body["code"], "AUTH_REQUIRED");

    cleanup(&state, None, user).await;
}

#[tokio::test]
async fn an_explicitly_requested_unported_provider_marks_the_response_partial() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, &format!("{}@search.local", Uuid::new_v4()), &[]).await;
    let caller = principal(user, "COMPLIANCE", &["approval:read"]);
    let (status, body) = call_search(
        &state,
        Some(&caller),
        &json!({ "query": "approval-test", "types": ["approval"] }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 0);
    assert_eq!(body["partial"], true);

    // The default (no explicit types) is not reported partial for unported providers.
    let (status, body) =
        call_search(&state, Some(&caller), &json!({ "query": "approval-test" })).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["partial"], false);
    cleanup(&state, None, user).await;
}
