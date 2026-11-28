//! DB-gated tests for the admin operations read routes.
//!
//! The suite connects to `PG_TEST_DATABASE_URL`, `DATABASE_URL` or the project default test
//! database (schema 46). It skips every test when the database is unreachable. List/export tests
//! drive the real dispatcher; detail routes are declared with `:id` policies and are called
//! directly until P3 adds pattern matching to the exact-path dispatcher.

#![forbid(unsafe_code)]

use std::future::Future;
use std::sync::Arc;

use chrono::Utc;
use ntex::http::Method;
use ntex::web::test;
use ntex::web::HttpRequest;
use pg_domain_auth::{sign_session_at, Channel, Principal, PrincipalKind, SessionClaims};
use serde_json::Value;
use uuid::Uuid;

use crate::config::CoreConfig;
use crate::state::AppState;

const MASTER_KEY: &str = "core-rs-admin-operations-test-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip() -> Option<Arc<AppState>> {
    static TRACING: std::sync::Once = std::sync::Once::new();
    TRACING.call_once(|| {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::ERROR)
            .with_test_writer()
            .try_init();
    });
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
    body: Value,
}

async fn call(state: &Arc<AppState>, path: &str, authorities: &[&str]) -> Response {
    let Some(user_id) = insert_user(state, authorities).await else {
        return Response {
            status: 0,
            body: Value::Null,
        };
    };
    let now = Utc::now();
    let mut claims = SessionClaims::new(user_id.to_string(), "COMPLIANCE")
        .with_authorities(authorities.iter().map(|value| (*value).to_owned()))
        .with_channel(Channel::Admin)
        .expect("admin channel");
    let jti = Uuid::new_v4();
    claims.jti = Some(jti.to_string());
    claims.iat = Some(now.timestamp());
    claims.exp = Some(now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
    let token = sign_session_at(&claims, MASTER_KEY, now).expect("sign");
    let request = test::TestRequest::default()
        .method(Method::from_bytes(b"GET").expect("method"))
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .to_http_request();
    let response = crate::app::dispatch(
        state.clone(),
        request,
        ntex::web::types::Payload(ntex::http::Payload::None),
    )
    .await;
    let status = response.status().as_u16();
    let body: ntex::util::Bytes = test::read_body(response).await;
    delete_user(state, user_id).await;
    Response {
        status,
        body: serde_json::from_slice(body.as_ref()).unwrap_or(Value::Null),
    }
}

async fn insert_user(state: &AppState, authorities: &[&str]) -> Option<Uuid> {
    let id = Uuid::new_v4();
    let email = format!("{id}@admin-operations.test");
    let authorities = Value::Array(
        authorities
            .iter()
            .map(|value| Value::String((*value).to_owned()))
            .collect(),
    );
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", $3::jsonb, true, true, false, 'ACTIVE'::\"UserStatus\")",
    )
    .bind(id)
    .bind(email)
    .bind(authorities)
    .execute(&state.pools.main)
    .await
    .ok()?;
    Some(id)
}

async fn delete_user(state: &AppState, id: Uuid) {
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await;
}

fn principal(authorities: &[&str]) -> Principal {
    Principal {
        kind: PrincipalKind::Session,
        user_id: Some(Uuid::new_v4().to_string()),
        role: Some("COMPLIANCE".to_owned()),
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

fn request_path(path: &str) -> HttpRequest {
    test::TestRequest::default().uri(path).to_http_request()
}

async fn detail_result(future: impl Future<Output = Result<Value, pg_http::ApiError>>) -> Response {
    match future.await {
        Ok(body) => Response { status: 200, body },
        Err(error) => Response {
            status: error.status,
            body: serde_json::from_str(&error.to_json()).unwrap_or(Value::Null),
        },
    }
}

async fn scalar_uuid(state: &AppState, sql: &str) -> Option<Uuid> {
    sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(sql))
        .fetch_optional(&state.pools.main)
        .await
        .ok()
        .flatten()
}

// ---------------------------------------------------------------- lists

#[tokio::test]
async fn admin_operation_lists_answer_with_their_keys() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let cases = [
        ("/internal/admin/operator-cases", "cases", vec!["case:read"]),
        ("/internal/admin/disputes", "disputes", vec!["dispute:read"]),
        (
            "/internal/admin/reconciliation/sources",
            "sources",
            vec!["reconciliation:read"],
        ),
        (
            "/internal/admin/reconciliation/runs",
            "runs",
            vec!["reconciliation:read"],
        ),
        (
            "/internal/admin/join-requests",
            "joinRequests",
            vec!["kyb:read"],
        ),
        (
            "/internal/admin/kyb-documents",
            "kybDocuments",
            vec!["kyb:read"],
        ),
        ("/internal/admin/incidents", "incidents", vec!["aml:read"]),
        (
            "/internal/admin/adjustments",
            "adjustments",
            vec!["finance:read"],
        ),
        ("/internal/admin/cashouts", "cashouts", vec!["cashout:read"]),
        (
            "/internal/admin/approvals",
            "approvals",
            vec!["approval:read"],
        ),
        (
            "/internal/admin/transactions",
            "transactions",
            vec!["attempt:read"],
        ),
    ];
    for (path, key, authorities) in cases {
        let response = call(&state, path, &authorities).await;
        assert_eq!(
            response.status, 200,
            "{path} answered {}: {}",
            response.status, response.body
        );
        assert!(
            response.body.get(key).and_then(Value::as_array).is_some(),
            "{path} has no {key} array: {}",
            response.body
        );
        assert!(
            response.body.get("total").and_then(Value::as_i64).is_some(),
            "{path} has no total: {}",
            response.body
        );
    }
}

#[tokio::test]
async fn admin_operation_summaries_and_catalog_answer() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let cases = [
        (
            "/internal/admin/operator-cases/summary",
            "summary",
            vec!["case:read"],
        ),
        (
            "/internal/admin/reconciliation/summary",
            "resultCounts",
            vec!["reconciliation:read"],
        ),
        (
            "/internal/admin/join-requests/summary",
            "summary",
            vec!["kyb:read"],
        ),
        (
            "/internal/admin/kyb-documents/summary",
            "summary",
            vec!["kyb:read"],
        ),
        (
            "/internal/admin/adjustments/summary",
            "byState",
            vec!["finance:read"],
        ),
        (
            "/internal/admin/cashouts/summary",
            "byState",
            vec!["cashout:read"],
        ),
        (
            "/internal/admin/disputes/summary",
            "byStatus",
            vec!["dispute:read"],
        ),
        (
            "/internal/admin/approvals/summary",
            "bySubjectType",
            vec!["approval:read"],
        ),
        (
            "/internal/admin/transactions/summary",
            "total24h",
            vec!["attempt:read"],
        ),
    ];
    for (path, key, authorities) in cases {
        let response = call(&state, path, &authorities).await;
        assert_eq!(
            response.status, 200,
            "{path} answered {}: {}",
            response.status, response.body
        );
        assert!(
            response.body.get(key).is_some(),
            "{path} has no {key}: {}",
            response.body
        );
    }

    let catalog = call(
        &state,
        "/internal/admin/operator-cases/catalog",
        &["case:read"],
    )
    .await;
    assert_eq!(catalog.status, 200);
    assert_eq!(
        catalog.body["types"].as_array().map(Vec::len),
        Some(67),
        "the catalog carries every case type"
    );
}

#[tokio::test]
async fn list_filters_and_pagination_are_applied() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(
        &state,
        "/internal/admin/operator-cases?page=1&pageSize=2&state=OPEN&sortKey=priority&sortDirection=asc",
        &["case:read"],
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let rows = response.body["cases"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(rows.len() <= 2);
    for row in &rows {
        assert_eq!(row["state"], "OPEN");
    }
    assert_eq!(response.body["pageSize"], 2);

    let disputes = call(
        &state,
        "/internal/admin/disputes?pageSize=1&status=OPENED&sortKey=openedAt&sortDirection=desc",
        &["dispute:read"],
    )
    .await;
    assert_eq!(disputes.status, 200, "{}", disputes.body);
    let rows = disputes.body["disputes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(rows.len() <= 1);
    for row in &rows {
        assert_eq!(row["status"], "OPENED");
    }

    let transactions = call(
        &state,
        "/internal/admin/transactions?pageSize=2&status=SUCCEEDED",
        &["attempt:read"],
    )
    .await;
    assert_eq!(transactions.status, 200, "{}", transactions.body);
    let rows = transactions
        .body
        .get("transactions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(rows.len() <= 2);
    for row in &rows {
        assert_eq!(row["status"], "SUCCEEDED");
        assert!(row.get("requestedAmount").is_some());
    }

    let approvals = call(
        &state,
        "/internal/admin/approvals?pageSize=1&state=PENDING_REVIEW",
        &["approval:read"],
    )
    .await;
    assert_eq!(approvals.status, 200, "{}", approvals.body);
    assert!(approvals.body["approvals"]
        .as_array()
        .is_some_and(|rows| rows.len() <= 1));

    let runs = call(
        &state,
        "/internal/admin/reconciliation/runs?pageSize=1&state=COMPLETED",
        &["reconciliation:read"],
    )
    .await;
    assert_eq!(runs.status, 200, "{}", runs.body);
    for row in runs.body["runs"].as_array().cloned().unwrap_or_default() {
        assert_eq!(row["state"], "COMPLETED");
    }
}

#[tokio::test]
async fn every_list_honours_page_size_one() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    for (path, key, authorities) in [
        ("/internal/admin/operator-cases", "cases", vec!["case:read"]),
        ("/internal/admin/disputes", "disputes", vec!["dispute:read"]),
        (
            "/internal/admin/reconciliation/sources",
            "sources",
            vec!["reconciliation:read"],
        ),
        (
            "/internal/admin/reconciliation/runs",
            "runs",
            vec!["reconciliation:read"],
        ),
        (
            "/internal/admin/join-requests",
            "joinRequests",
            vec!["kyb:read"],
        ),
        (
            "/internal/admin/kyb-documents",
            "kybDocuments",
            vec!["kyb:read"],
        ),
        ("/internal/admin/incidents", "incidents", vec!["aml:read"]),
        (
            "/internal/admin/adjustments",
            "adjustments",
            vec!["finance:read"],
        ),
        ("/internal/admin/cashouts", "cashouts", vec!["cashout:read"]),
        (
            "/internal/admin/approvals",
            "approvals",
            vec!["approval:read"],
        ),
        (
            "/internal/admin/transactions",
            "transactions",
            vec!["attempt:read"],
        ),
    ] {
        let path = format!("{path}?page=1&pageSize=1");
        let response = call(&state, &path, &authorities).await;
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert_eq!(response.body["pageSize"], 1, "{path}");
        assert!(
            response.body[key]
                .as_array()
                .is_some_and(|rows| rows.len() <= 1),
            "{path} returned more than one row: {}",
            response.body
        );
        assert!(response.body["total"].as_i64().is_some(), "{path}");
    }
}

#[tokio::test]
async fn list_authorities_are_enforced() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    for path in [
        "/internal/admin/operator-cases",
        "/internal/admin/disputes",
        "/internal/admin/reconciliation/sources",
        "/internal/admin/reconciliation/runs",
        "/internal/admin/join-requests",
        "/internal/admin/kyb-documents",
        "/internal/admin/adjustments",
        "/internal/admin/cashouts",
        "/internal/admin/approvals",
        "/internal/admin/transactions",
    ] {
        // `/transactions` accepts `merchant:read`; use an authority no route holds.
        let response = call(&state, path, &["none:read"]).await;
        assert_eq!(
            response.status, 403,
            "{path} should refuse a caller without the route authority: {}",
            response.body
        );
        assert!(
            response.body["code"]
                .as_str()
                .is_some_and(|code| code.contains("AUTHORIT")),
            "{path} did not fail on the route authority: {}",
            response.body
        );
    }
}

#[tokio::test]
async fn exports_use_the_read_only_envelope() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let cases = [
        (
            "/internal/admin/operator-cases/export",
            "cases",
            vec!["case:read"],
        ),
        (
            "/internal/admin/disputes/export",
            "disputes",
            vec!["dispute:read"],
        ),
        (
            "/internal/admin/kyb-documents/export",
            "documents",
            vec!["kyb:read"],
        ),
        (
            "/internal/admin/adjustments/export",
            "adjustments",
            vec!["finance:read"],
        ),
        (
            "/internal/admin/approvals/export",
            "approvals",
            vec!["approval:read"],
        ),
    ];
    for (path, key, authorities) in cases {
        let response = call(&state, path, &authorities).await;
        assert_eq!(
            response.status, 200,
            "{path} answered {}: {}",
            response.status, response.body
        );
        assert!(response.body[key].is_array(), "{path} has no {key}");
        assert!(response.body["total"].as_i64().is_some());
        assert!(response.body["exported"]
            .as_u64()
            .is_some_and(|count| count <= 5000));
        assert!(response.body["truncated"].as_bool().is_some());
    }
}

// ---------------------------------------------------------------- details

#[tokio::test]
async fn operator_case_and_dispute_details_answer_and_404() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let principal = principal(&["case:read", "dispute:read"]);
    if let Some(id) = scalar_uuid(
        &state,
        "SELECT id FROM operator_cases WHERE confidentiality <> 'AML' LIMIT 1",
    )
    .await
    {
        let request = request_path(&format!("/internal/admin/operator-cases/{id}"));
        let response = detail_result(super::operator_cases::detail(
            &state,
            &request,
            Some(&principal),
        ))
        .await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["operatorCase"]["id"], id.to_string());
    }
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM disputes LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/disputes/{id}"));
        let response =
            detail_result(super::disputes::detail(&state, &request, Some(&principal))).await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["dispute"]["id"], id.to_string());
    }
    let missing = Uuid::new_v4();
    let request = request_path(&format!("/internal/admin/disputes/{missing}"));
    let response = detail_result(super::disputes::detail(&state, &request, Some(&principal))).await;
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.body["code"], "DISPUTE_NOT_FOUND");
}

#[tokio::test]
async fn finance_and_reconciliation_details_answer() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let principal = principal(&["finance:read", "cashout:read", "reconciliation:read"]);
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM adjustments LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/adjustments/{id}"));
        let response = detail_result(super::finance::adjustment_detail(
            &state,
            &request,
            Some(&principal),
        ))
        .await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["adjustment"]["id"], id.to_string());
    }
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM cashout_requests LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/cashouts/{id}"));
        let response = detail_result(super::finance::cashout_detail(
            &state,
            &request,
            Some(&principal),
        ))
        .await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["cashout"]["id"], id.to_string());
        assert!(response.body["cashout"].get("walletBalance").is_some());
    }
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM reconciliation_runs LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/reconciliation/runs/{id}"));
        let response = detail_result(super::reconciliation::run_detail(
            &state,
            &request,
            Some(&principal),
        ))
        .await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["run"]["id"], id.to_string());
        assert!(response.body["run"]["items"].is_array());
    }
    let missing = Uuid::new_v4();
    let request = request_path(&format!("/internal/admin/reconciliation/runs/{missing}"));
    let response = detail_result(super::reconciliation::run_detail(
        &state,
        &request,
        Some(&principal),
    ))
    .await;
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.body["code"], "RECONCILIATION_RUN_NOT_FOUND");
}

#[tokio::test]
async fn onboarding_incident_approval_and_attempt_details_answer() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let principal = principal(&["kyb:read", "aml:read", "approval:read", "attempt:read"]);
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM join_requests LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/join-requests/{id}"));
        let response = detail_result(super::onboarding::join_detail(
            &state,
            &request,
            Some(&principal),
        ))
        .await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["joinRequest"]["id"], id.to_string());
    }
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM kyb_documents LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/kyb-documents/{id}"));
        let response = detail_result(super::onboarding::kyb_detail(
            &state,
            &request,
            Some(&principal),
        ))
        .await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["kybDocument"]["id"], id.to_string());
    }
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM incidents LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/incidents/{id}"));
        let response =
            detail_result(super::incidents::detail(&state, &request, Some(&principal))).await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["incident"]["id"], id.to_string());
    }
    if let Some(id) = scalar_uuid(
        &state,
        "SELECT id FROM approval_requests WHERE subject_type <> 'AML_CASE' LIMIT 1",
    )
    .await
    {
        let request = request_path(&format!("/internal/admin/approvals/{id}"));
        let response =
            detail_result(super::approvals::detail(&state, &request, Some(&principal))).await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["approval"]["id"], id.to_string());
    }
    if let Some(id) = scalar_uuid(&state, "SELECT id FROM payment_attempts LIMIT 1").await {
        let request = request_path(&format!("/internal/admin/attempts/{id}"));
        let response =
            detail_result(super::attempts::detail(&state, &request, Some(&principal))).await;
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["attempt"]["id"], id.to_string());
    }
}

#[tokio::test]
async fn detail_unknown_ids_are_typed_404s() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let principal = principal(&[
        "kyb:read",
        "finance:read",
        "cashout:read",
        "attempt:read",
        "case:read",
        "approval:read",
        "aml:read",
    ]);
    let missing = Uuid::new_v4();
    let cases: [(&str, Response); 8] = [
        (
            "join",
            detail_result(super::onboarding::join_detail(
                &state,
                &request_path(&format!("/internal/admin/join-requests/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "kyb",
            detail_result(super::onboarding::kyb_detail(
                &state,
                &request_path(&format!("/internal/admin/kyb-documents/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "adjustment",
            detail_result(super::finance::adjustment_detail(
                &state,
                &request_path(&format!("/internal/admin/adjustments/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "case",
            detail_result(super::operator_cases::detail(
                &state,
                &request_path(&format!("/internal/admin/operator-cases/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "attempt",
            detail_result(super::attempts::detail(
                &state,
                &request_path(&format!("/internal/admin/attempts/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "cashout",
            detail_result(super::finance::cashout_detail(
                &state,
                &request_path(&format!("/internal/admin/cashouts/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "approval",
            detail_result(super::approvals::detail(
                &state,
                &request_path(&format!("/internal/admin/approvals/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
        (
            "incident",
            detail_result(super::incidents::detail(
                &state,
                &request_path(&format!("/internal/admin/incidents/{missing}")),
                Some(&principal),
            ))
            .await,
        ),
    ];
    for (label, response) in cases {
        assert_eq!(response.status, 404, "{label}: {}", response.body);
        assert!(
            response.body["code"].as_str().is_some(),
            "{label} has no error code: {}",
            response.body
        );
    }
}

#[test]
fn every_operation_route_is_an_admin_staff_get() {
    use crate::routes::PrincipalGuard;
    use pg_http::{Authn, Channel};

    let routes = super::routes();
    assert_eq!(routes.len(), 51, "51 read routes are mounted");
    let mut keys = std::collections::BTreeSet::new();
    for route in &routes {
        assert_eq!(route.policy.method, "GET", "{}", route.key());
        assert_eq!(route.policy.channel, Channel::Admin, "{}", route.key());
        assert_eq!(route.policy.authn, Authn::Session, "{}", route.key());
        assert_eq!(route.guard, PrincipalGuard::Staff, "{}", route.key());
        assert!(route.policy.ts_origin.starts_with("core-back/"));
        assert!(keys.insert(route.key()), "duplicate {}", route.key());
    }
    for (path, expected) in [
        (
            "/internal/admin/operator-cases",
            vec!["case:read", "operator:read"],
        ),
        (
            "/internal/admin/kyb-documents",
            vec!["kyb:read", "compliance:read"],
        ),
        ("/internal/admin/disputes", vec!["dispute:read"]),
        (
            "/internal/admin/transactions",
            vec!["attempt:read", "merchant:read", "finance:read"],
        ),
    ] {
        let route = routes
            .iter()
            .find(|route| route.policy.path == path)
            .expect("route");
        assert_eq!(route.policy.authorities, expected, "{path}");
    }
}

#[tokio::test]
async fn detail_routes_match_the_path_template_and_authorize() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let Some(id) = scalar_uuid(&state, "SELECT id FROM disputes LIMIT 1").await else {
        let missing = Uuid::new_v4();
        let path = format!("/internal/admin/disputes/{missing}");
        let response = call(&state, &path, &["dispute:read"]).await;
        assert_eq!(response.status, 404, "{}", response.body);
        return;
    };
    let path = format!("/internal/admin/disputes/{id}");
    let allowed = call(&state, &path, &["dispute:read"]).await;
    assert_eq!(allowed.status, 200, "{}", allowed.body);
    assert_eq!(allowed.body["dispute"]["id"], id.to_string());
    let denied = call(&state, &path, &["merchant:read"]).await;
    assert_eq!(denied.status, 403, "{}", denied.body);
    let missing = Uuid::new_v4();
    let response = call(
        &state,
        &format!("/internal/admin/disputes/{missing}"),
        &["dispute:read"],
    )
    .await;
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.body["code"], "DISPUTE_NOT_FOUND");
}
