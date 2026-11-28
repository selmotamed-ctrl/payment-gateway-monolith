//! DB-gated tests for the Academy read routes.
//!
//! Same harness as the Report Studio slice: handlers are driven directly, the database is the
//! project test database (override with `PG_TEST_DATABASE_URL`) and every written row is removed.

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

const MASTER_KEY: &str = "core-rs-academy-slice-master-key-0123456789";
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

fn principal(user_id: Uuid, role: &str) -> Principal {
    Principal {
        kind: PrincipalKind::Session,
        user_id: Some(user_id.to_string()),
        role: Some(role.to_owned()),
        merchant_id: None,
        application_id: None,
        authorities: vec!["academy:read".to_owned()],
        scopes: Vec::new(),
        token_id: None,
        token_plane: None,
        session_jti: None,
        session_exp: None,
        session_channel: Some(Channel::Admin),
        app_scope_ids: Vec::new(),
    }
}

async fn insert_user(state: &AppState, role: &str, progress: Option<&Value>) -> Uuid {
    let id = Uuid::new_v4();
    let email = format!("{id}@academy-slice.local");
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status, academy_progress_json)
         VALUES ($1, now(), $2, $3::\"UserRole\", '[\"academy:read\"]'::jsonb, true, true, false,
                 'ACTIVE', $4)",
    )
    .bind(id)
    .bind(email)
    .bind(role)
    .bind(progress)
    .execute(&state.pools.main)
    .await
    .expect("insert user");
    id
}

async fn delete_user(state: &AppState, id: Uuid) {
    sqlx::query("DELETE FROM academy_certificates WHERE user_id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await
        .expect("delete certificates");
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await
        .expect("delete user");
}

async fn call(
    state: &Arc<AppState>,
    handler: CustomHandler,
    path: &str,
    principal: Option<&Principal>,
) -> (u16, Value) {
    let request = test::TestRequest::default()
        .method(Method::GET)
        .uri(path)
        .to_http_request();
    let response = handler(
        state,
        &request,
        principal,
        Payload(ntex::http::Payload::None),
    )
    .await;
    let status = response.status().as_u16();
    let body = test::read_body(response).await;
    let value = serde_json::from_slice(&body[..]).unwrap_or(Value::Null);
    (status, value)
}

fn badge(earned_at: &str, expires_at: &str) -> Value {
    json!({
        "id": "FOUNDATION_CERTIFIED",
        "track": "FOUNDATION",
        "earnedAt": earned_at,
        "expiresAt": expires_at,
        "v": "1.0.0"
    })
}

fn with_badge() -> Value {
    json!({
        "schema": 1,
        "rev": 7,
        "startedAt": "2026-11-01T10:00:00.000Z",
        "updatedAt": "2026-11-20T10:00:00.000Z",
        "contentVersion": "1.0.0",
        "guideRead": {},
        "lessons": {"l-m0-1": {"at": "2026-11-02T10:00:00.000Z", "v": "1.0.0", "checkScore": 2}},
        "labs": {},
        "exams": {},
        "badges": [badge("2026-11-01T10:00:00.000Z", "2027-11-01T10:00:00.000Z")],
        "_server": {"open": {}}
    })
}

#[tokio::test]
async fn the_module_registers_the_five_read_policies() {
    let routes = routes();
    assert_eq!(routes.len(), 5);
    for route in &routes {
        assert_eq!(route.policy.method, "GET");
        assert_eq!(route.policy.channel, pg_http::Channel::Admin);
        assert_eq!(route.guard, PrincipalGuard::Staff);
        assert!(route
            .policy
            .ts_origin
            .starts_with("core-back/api/internal/academy.ts:"));
    }
    let paths: Vec<&str> = routes
        .iter()
        .map(|route| route.policy.path.as_str())
        .collect();
    assert!(paths.contains(&"/internal/admin/academy/team/export"));
}

#[tokio::test]
async fn progress_return_publishes_the_sanitised_record() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", Some(&with_badge())).await;
    let caller = principal(user, "COMPLIANCE");
    let (status, body) = call(
        &state,
        progress,
        "/internal/admin/academy/progress",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["rev"], 7);
    assert_eq!(body["progress"]["schema"], 1);
    assert_eq!(body["progress"]["lessons"]["l-m0-1"]["checkScore"], 2);
    assert_eq!(body["progress"]["badges"][0]["track"], "FOUNDATION");
    assert!(body["progress"].get("_server").is_none());

    // A missing row is USER_NOT_FOUND (the TS store contract).
    let ghost = principal(Uuid::new_v4(), "COMPLIANCE");
    let (status, body) = call(
        &state,
        progress,
        "/internal/admin/academy/progress",
        Some(&ghost),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "USER_NOT_FOUND");

    delete_user(&state, user).await;
}

#[tokio::test]
async fn the_academy_refuses_merchant_users_and_api_tokens() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", None).await;
    let mut merchant_user = principal(user, "MERCHANT_ADMIN");
    merchant_user.merchant_id = Some(Uuid::new_v4().to_string());
    let (status, body) = call(
        &state,
        progress,
        "/internal/admin/academy/progress",
        Some(&merchant_user),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "ACADEMY_BACK_OFFICE_ONLY");

    let mut token = principal(user, "MERCHANT_API");
    token.kind = PrincipalKind::ApiToken;
    let (status, body) = call(
        &state,
        progress,
        "/internal/admin/academy/progress",
        Some(&token),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "ACADEMY_BACK_OFFICE_ONLY");

    delete_user(&state, user).await;
}

#[tokio::test]
async fn eligibility_checks_the_exam_before_the_user_and_resumes_live_sessions() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", None).await;
    let caller = principal(user, "COMPLIANCE");

    let (status, body) = call(
        &state,
        eligibility,
        "/internal/admin/academy/exams/no-such-exam/eligibility",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "ACADEMY_EXAM_NOT_FOUND");

    let (status, body) = call(
        &state,
        eligibility,
        "/internal/admin/academy/exams/exam-foundation/eligibility",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["eligible"], false);
    let missing = body["missing"].as_array().expect("missing");
    assert!(missing
        .iter()
        .any(|entry| entry["kind"] == "lesson" && entry["id"] == "l-m0-1"));
    assert!(missing.iter().any(|entry| entry["kind"] == "lab"));

    // A live session is resumable without any eligibility check.
    let live = json!({
        "schema": 1,
        "rev": 1,
        "startedAt": "2026-11-01T10:00:00.000Z",
        "updatedAt": "2026-11-01T10:00:00.000Z",
        "contentVersion": "1.0.0",
        "guideRead": {}, "lessons": {}, "labs": {}, "badges": [],
        "exams": {"exam-foundation": {"attempts": [], "v": "1.0.0"}},
        "_server": {"open": {"exam-foundation": {"sessionId": "session-1",
            "startedAt": "2026-11-01T10:00:00.000Z", "expiresAt": "2099-11-01T10:00:00.000Z",
            "attemptNumber": 1, "questions": []}}}
    });
    sqlx::query("UPDATE users SET academy_progress_json = $2 WHERE id = $1")
        .bind(user)
        .bind(&live)
        .execute(&state.pools.main)
        .await
        .expect("set live session");
    let (status, body) = call(
        &state,
        eligibility,
        "/internal/admin/academy/exams/exam-foundation/eligibility",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["eligible"], true);
    assert_eq!(body["missing"].as_array().map(Vec::len), Some(0));

    delete_user(&state, user).await;
}

#[tokio::test]
async fn certificate_verification_issues_once_and_reuses_the_identity() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", Some(&with_badge())).await;
    let caller = principal(user, "COMPLIANCE");

    let (status, body) = call(
        &state,
        certificate_verification,
        "/internal/admin/academy/certificates/FOUNDATION/verification",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let display = body["displayId"].as_str().expect("displayId").to_owned();
    assert_eq!(body["certificateId"], display);
    assert!(display.starts_with("PG-AC-") && display.len() == 14);
    let public_id = body["publicId"].as_str().expect("publicId").to_owned();
    assert_eq!(public_id.len(), 32);
    assert!(public_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')));
    assert_eq!(body["status"], "ACTIVE");

    // A second read returns the same issuance (unique user/track/earnedAt).
    let (status, body) = call(
        &state,
        certificate_verification,
        "/internal/admin/academy/certificates/FOUNDATION/verification",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["publicId"], public_id);
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM academy_certificates WHERE user_id = $1")
            .bind(user)
            .fetch_one(&state.pools.main)
            .await
            .expect("certificate count");
    assert_eq!(rows, 1);

    let (status, body) = call(
        &state,
        certificate_verification,
        "/internal/admin/academy/certificates/NOPE/verification",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "ACADEMY_TRACK_NOT_FOUND");

    // No badge for that track → CERTIFICATE_NOT_FOUND (the progress carries FOUNDATION only).
    let (status, body) = call(
        &state,
        certificate_verification,
        "/internal/admin/academy/certificates/OPERATOR/verification",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "CERTIFICATE_NOT_FOUND");

    delete_user(&state, user).await;
}

#[tokio::test]
async fn team_is_security_admin_only_and_export_adds_the_checklist() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let reader = insert_user(&state, "COMPLIANCE", None).await;
    let admin = insert_user(&state, "SECURITY_ADMIN", None).await;
    let reader_principal = principal(reader, "COMPLIANCE");
    let (status, body) = call(
        &state,
        team,
        "/internal/admin/academy/team",
        Some(&reader_principal),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "ACADEMY_TEAM_FORBIDDEN");

    let admin_principal = principal(admin, "SECURITY_ADMIN");
    let (status, body) = call(
        &state,
        team,
        "/internal/admin/academy/team",
        Some(&admin_principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["contentVersion"].is_string());
    assert!(body["generatedAt"].is_string());
    let rows = body["rows"].as_array().expect("rows");
    assert!(rows.iter().any(|row| row["userId"] == admin.to_string()));
    let own = rows
        .iter()
        .find(|row| row["userId"] == admin.to_string())
        .expect("own row");
    assert_eq!(own["status"], "NOT_STARTED");
    assert_eq!(own["isMaker"], true);
    // Merchant users are never in the team view.
    assert!(rows.iter().all(|row| row["role"] != "MERCHANT_ADMIN"));

    let (status, body) = call(
        &state,
        team_export,
        "/internal/admin/academy/team/export?checklist=TEAM_SCOPE_VERIFIED,NOT_ALLOWED",
        Some(&admin_principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["exportedAt"].is_string());
    assert_eq!(body["checklist"], json!(["TEAM_SCOPE_VERIFIED"]));

    delete_user(&state, reader).await;
    delete_user(&state, admin).await;
}
