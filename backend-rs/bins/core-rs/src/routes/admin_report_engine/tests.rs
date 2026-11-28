//! DB-gated tests for the Report Studio read routes.
//!
//! They drive the handlers directly (the P3 dispatcher matches policy paths exactly, so the
//! parameterised routes are not reachable through it yet). The database is
//! `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` (override with
//! `PG_TEST_DATABASE_URL`); when it is unreachable every test prints a skip line and returns.
//!
//! Every row this module writes carries a unique code/id and is removed at the end.

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

const MASTER_KEY: &str = "core-rs-report-slice-master-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip() -> Option<Arc<AppState>> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .with_test_writer()
        .try_init();
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

async fn insert_user(state: &AppState, role: &str, authorities: &[&str]) -> Uuid {
    let id = Uuid::new_v4();
    let email = format!("{id}@report-slice.local");
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, $3::\"UserRole\", $4::jsonb, true, true, false, 'ACTIVE')",
    )
    .bind(id)
    .bind(email)
    .bind(role)
    .bind(serde_json::json!(authorities))
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

fn descriptor() -> Value {
    json!({
        "spec_kind": "REPORT_DESCRIPTOR",
        "spec_version": "1.0",
        "report": {
            "code": "integration-report",
            "audience_scope": "BACKOFFICE_INTERNAL"
        },
        "datasets": [{
            "dataset_id": "d1",
            "from_model": "paymentAttempt",
            "select": [{"alias": "volume", "column": "total_charged_amount"}]
        }],
        "sections": [{
            "section_id": "kpis",
            "section_type": "KPI_GRID",
            "cards": [{"dataset_id": "d1", "value_field": "volume"}]
        }],
        "page_layout": {"header_mode": "NONE", "footer_mode": "NONE"}
    })
}

struct ReportFixture {
    id: Uuid,
    code: String,
}

#[allow(clippy::too_many_arguments)]
async fn insert_report(
    state: &AppState,
    creator: Uuid,
    code: &str,
    version: i32,
    status: &str,
    latest: bool,
    engine_version: &str,
    inferred_roles: &[&str],
    audience: &str,
) -> ReportFixture {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO report_definition_specs
           (id, code, version, category, audience_scope, status, is_latest_published,
            supported_locales, default_locale, spec_json, spec_sha256, verification_report_json,
            authority_mode, inferred_roles, inferred_authorities, conflict_status,
            requires_confidential_aml, override_allowed_roles, override_allowed_authorities,
            allow_confidential_aml_bypass, engine_version, spec_schema_version,
            authoring_transcript_version, published_at, created_by_user_id, updated_at)
         VALUES ($1, $2, $3, 'PAYMENTS', $4::\"ReportAudienceScope\", $5::\"ReportSpecStatus\", $6,
                 ARRAY['en','ar'], 'en', $7, repeat('a', 64), '{\"valid\":true}'::jsonb,
                 'INFERRED_STRICT'::\"ReportAuthorityMode\", $8, ARRAY[]::text[], 'CLEAR', false,
                 ARRAY[]::text[], ARRAY[]::text[], false, $9, '1.0', '1.1', now(), $10, now())",
    )
    .bind(id)
    .bind(code)
    .bind(version)
    .bind(audience)
    .bind(status)
    .bind(latest)
    .bind(descriptor())
    .bind(inferred_roles)
    .bind(engine_version)
    .bind(creator)
    .execute(&state.pools.main)
    .await
    .expect("insert report spec");
    ReportFixture {
        id,
        code: code.to_owned(),
    }
}

async fn delete_report(state: &AppState, fixture: &ReportFixture) {
    // `report_execution_audit` is append-only; the read tests never insert into it.
    sqlx::query("DELETE FROM approval_requests WHERE subject_id = $1")
        .bind(fixture.id.to_string())
        .execute(&state.pools.main)
        .await
        .expect("delete approvals");
    sqlx::query("DELETE FROM report_definition_specs WHERE id = $1")
        .bind(fixture.id)
        .execute(&state.pools.main)
        .await
        .expect("delete report spec");
}

#[tokio::test]
async fn catalog_filters_audience_policy_and_migration_health() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", &["report:review"]).await;
    let principal = principal(user, "COMPLIANCE", &["report:review"]);
    let unique = Uuid::new_v4().simple().to_string();
    let allowed = insert_report(
        &state,
        user,
        &format!("it-re-catalog-a-{unique}"),
        1,
        "PUBLISHED",
        true,
        "1.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;
    let other_role = insert_report(
        &state,
        user,
        &format!("it-re-catalog-b-{unique}"),
        1,
        "PUBLISHED",
        true,
        "1.0.0",
        &["FINANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;
    let merchant_only = insert_report(
        &state,
        user,
        &format!("it-re-catalog-c-{unique}"),
        1,
        "PUBLISHED",
        true,
        "1.0.0",
        &["COMPLIANCE"],
        "MERCHANT_FACING",
    )
    .await;
    let unpublished = insert_report(
        &state,
        user,
        &format!("it-re-catalog-d-{unique}"),
        1,
        "VERIFIED",
        false,
        "1.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;

    let (status, body) = call(
        &state,
        catalog,
        "/internal/admin/report-engine/catalog?audience=BACKOFFICE_INTERNAL&pageSize=200",
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let codes: Vec<&str> = body["reports"]
        .as_array()
        .expect("reports")
        .iter()
        .filter_map(|row| row["code"].as_str())
        .collect();
    assert!(codes.contains(&allowed.code.as_str()));
    assert!(
        !codes.contains(&other_role.code.as_str()),
        "policy of another role"
    );
    assert!(
        !codes.contains(&merchant_only.code.as_str()),
        "audience filter"
    );
    assert!(!codes.contains(&unpublished.code.as_str()), "not published");

    // The merchant audience is a separate listing.
    let merchant_only_code = merchant_only.code.clone();
    let (status, body) = call(
        &state,
        catalog,
        &format!(
            "/internal/admin/report-engine/catalog?audience=MERCHANT_FACING&search={merchant_only_code}"
        ),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let codes: Vec<&str> = body["reports"]
        .as_array()
        .expect("reports")
        .iter()
        .filter_map(|row| row["code"].as_str())
        .collect();
    assert_eq!(codes, vec![merchant_only.code.as_str()]);
    assert!(body["health"]["brokenReportSpecs"].as_u64().is_some());

    delete_report(&state, &allowed).await;
    delete_report(&state, &other_role).await;
    delete_report(&state, &merchant_only).await;
    delete_report(&state, &unpublished).await;
    delete_user(&state, user).await;
}

#[tokio::test]
async fn catalog_requires_staff_and_lists_no_specs_for_a_merchant_principal() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", &["report:review"]).await;
    let mut merchant_user = principal(user, "MERCHANT_ADMIN", &["report:review"]);
    merchant_user.merchant_id = Some(Uuid::new_v4().to_string());
    let (status, body) = call(
        &state,
        catalog,
        "/internal/admin/report-engine/catalog",
        Some(&merchant_user),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "STAFF_PRINCIPAL_REQUIRED");

    let (status, body) = call(
        &state,
        catalog,
        "/internal/admin/report-engine/catalog",
        None,
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(body["code"], "AUTH_REQUIRED");
    delete_user(&state, user).await;
}

#[tokio::test]
async fn spec_list_never_returns_the_spec_body_and_detail_does() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", &["report:review"]).await;
    let principal = principal(user, "COMPLIANCE", &["report:review"]);
    let unique = Uuid::new_v4().simple().to_string();
    let fixture = insert_report(
        &state,
        user,
        &format!("it-re-detail-{unique}"),
        2,
        "PUBLISHED",
        true,
        "1.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;

    let (status, body) = call(
        &state,
        specs,
        &format!("/internal/admin/report-engine/specs?code={}", fixture.code),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let items = body["specs"].as_array().expect("specs");
    assert_eq!(items.len(), 1);
    assert!(
        items[0].get("spec").is_none(),
        "the list must not leak the spec"
    );
    assert_eq!(items[0]["version"], 2);
    assert_eq!(items[0]["compatibility"]["status"], "COMPATIBLE");

    let (status, body) = call(
        &state,
        spec_detail,
        &format!("/internal/admin/report-engine/specs/{}", fixture.id),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["id"], fixture.id.to_string());
    assert_eq!(body["spec"]["spec_kind"], "REPORT_DESCRIPTOR");
    assert_eq!(body["specSha256"].as_str().map(str::len), Some(64));

    let unknown = Uuid::new_v4();
    let (status, body) = call(
        &state,
        spec_detail,
        &format!("/internal/admin/report-engine/specs/{unknown}"),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "REPORT_SPEC_NOT_FOUND");

    delete_report(&state, &fixture).await;
    delete_user(&state, user).await;
}

#[tokio::test]
async fn spec_list_refuses_a_principal_without_the_authority() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", &["merchant:read"]).await;
    let principal = principal(user, "COMPLIANCE", &["merchant:read"]);
    let (status, body) = call(
        &state,
        specs,
        "/internal/admin/report-engine/specs",
        Some(&principal),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "AUTHORITY_REQUIRED");
    assert_eq!(body["details"]["required"][0], "report:review");
    delete_user(&state, user).await;
}

#[tokio::test]
async fn needs_migration_reports_staff_and_merchant_rows_with_compatibility() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "SECURITY_ADMIN", &["security:write"]).await;
    let principal = principal(user, "SECURITY_ADMIN", &["security:write"]);
    let unique = Uuid::new_v4().simple().to_string();
    let fixture = insert_report(
        &state,
        user,
        &format!("it-re-migrate-{unique}"),
        3,
        "PUBLISHED",
        true,
        "2.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;

    let (status, body) = call(
        &state,
        specs_needs_migration,
        &format!(
            "/internal/admin/report-engine/specs/needs-migration?source=STAFF&search={}",
            fixture.code
        ),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let items = body["specs"].as_array().expect("specs");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["source"], "STAFF");
    assert_eq!(items[0]["compatibility"]["status"], "NEEDS_MIGRATION");
    assert_eq!(
        items[0]["compatibility"]["reasonCode"],
        "ENGINE_MAJOR_VERSION_MISMATCH"
    );
    assert_eq!(items[0]["promptAvailable"], true);
    assert_eq!(body["total"], 1);

    // A COMPATIBLE spec never appears in the migration queue.
    let compatible = insert_report(
        &state,
        user,
        &format!("it-re-migrate-ok-{unique}"),
        1,
        "PUBLISHED",
        true,
        "1.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;
    let (status, body) = call(
        &state,
        specs_needs_migration,
        &format!(
            "/internal/admin/report-engine/specs/needs-migration?search={}",
            compatible.code
        ),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 0);

    delete_report(&state, &fixture).await;
    delete_report(&state, &compatible).await;
    delete_user(&state, user).await;
}

async fn insert_chrome(
    state: &AppState,
    creator: Uuid,
    code: &str,
    status: &str,
    default_global: bool,
    chrome_type: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let spec = json!({
        "spec_kind": "REPORT_CHROME",
        "spec_version": "1.0",
        "chrome": {"code": code, "name": "Integration chrome", "chrome_type": chrome_type},
        "required_assets": [],
        "i18n": {"default_locale": "en", "locales": {"en": {}, "ar": {}}}
    });
    sqlx::query(
        "INSERT INTO report_chrome_specs
           (id, code, version, name, chrome_type, status, is_default_global, supported_locales,
            spec_json, spec_sha256, engine_version, spec_schema_version,
            authoring_transcript_version, published_at, created_by_user_id, updated_at)
         VALUES ($1, $2, 1, 'Integration chrome', $3::\"ReportChromeType\", $4::\"ReportSpecStatus\",
                 $5, ARRAY['en'], $6, repeat('b', 64), '1.0.0', '1.0', '1.1', now(), $7, now())",
    )
    .bind(id)
    .bind(code)
    .bind(chrome_type)
    .bind(status)
    .bind(default_global)
    .bind(spec)
    .bind(creator)
    .execute(&state.pools.main)
    .await
    .expect("insert chrome");
    id
}

async fn delete_chrome(state: &AppState, id: Uuid) {
    sqlx::query("DELETE FROM report_chrome_specs WHERE id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await
        .expect("delete chrome");
}

#[tokio::test]
async fn chrome_list_hides_drafts_from_non_authors_and_shows_them_to_authors() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let reader = insert_user(&state, "COMPLIANCE", &["merchant:read"]).await;
    let author = insert_user(&state, "COMPLIANCE", &["report:approve"]).await;
    let unique = Uuid::new_v4().simple().to_string();
    let code = format!("it-re-chrome-{unique}");
    let draft = insert_chrome(&state, author, &code, "VERIFIED", false, "HEADER").await;
    let published = insert_chrome(
        &state,
        author,
        &format!("{code}-pub"),
        "PUBLISHED",
        false,
        "FOOTER",
    )
    .await;

    let reader_principal = principal(reader, "COMPLIANCE", &["merchant:read"]);
    let (status, body) = call(
        &state,
        chrome_list,
        &format!("/internal/admin/report-engine/chrome?search={code}"),
        Some(&reader_principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let ids: Vec<&str> = body["specs"]
        .as_array()
        .expect("specs")
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    assert!(!ids.contains(&draft.to_string().as_str()));
    assert!(ids.contains(&published.to_string().as_str()));

    let author_principal = principal(author, "COMPLIANCE", &["report:approve"]);
    let (status, body) = call(
        &state,
        chrome_list,
        &format!("/internal/admin/report-engine/chrome?search={code}&includeIncompatible=1"),
        Some(&author_principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let ids: Vec<&str> = body["specs"]
        .as_array()
        .expect("specs")
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    assert!(
        ids.contains(&draft.to_string().as_str()),
        "authors see drafts"
    );
    assert!(body["specs"][0]["assetDataUrls"].is_object());

    // The detail route applies the same published-only rule.
    let (status, body) = call(
        &state,
        chrome_detail,
        &format!("/internal/admin/report-engine/chrome/{draft}"),
        Some(&reader_principal),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "REPORT_CHROME_SPEC_NOT_FOUND");
    let (status, body) = call(
        &state,
        chrome_detail,
        &format!("/internal/admin/report-engine/chrome/{draft}"),
        Some(&author_principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["compatibility"]["status"], "COMPATIBLE");

    delete_chrome(&state, draft).await;
    delete_chrome(&state, published).await;
    delete_user(&state, reader).await;
    delete_user(&state, author).await;
}

#[tokio::test]
async fn chrome_needs_migration_flags_versions_and_default_state() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "SECURITY_ADMIN", &["security:write"]).await;
    let principal = principal(user, "SECURITY_ADMIN", &["security:write"]);
    let unique = Uuid::new_v4().simple().to_string();
    let code = format!("it-re-chrome-mig-{unique}");
    let id = insert_chrome(&state, user, &code, "PUBLISHED", false, "HEADER").await;
    // Move the stored version out of the supported range without rewriting the spec body.
    sqlx::query("UPDATE report_chrome_specs SET engine_version = '2.0.0' WHERE id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await
        .expect("bump engine version");

    let (status, body) = call(
        &state,
        chrome_needs_migration,
        &format!("/internal/admin/report-engine/chrome/needs-migration?search={code}"),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let items = body["specs"].as_array().expect("specs");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["compatibility"]["reasonCode"],
        "ENGINE_MAJOR_VERSION_MISMATCH"
    );
    assert_eq!(items[0]["defaultState"], "NONE");
    assert!(body["defaults"]["header"].is_string());

    delete_chrome(&state, id).await;
    delete_user(&state, user).await;
}

#[tokio::test]
async fn executions_and_aml_bypass_reads_apply_limits_and_roles() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "MLRO", &["security:write", "report:approve"]).await;
    let checker = principal(user, "MLRO", &["security:write", "report:approve"]);
    let unique = Uuid::new_v4().simple().to_string();
    let fixture = insert_report(
        &state,
        user,
        &format!("it-re-audit-{unique}"),
        1,
        "PUBLISHED",
        true,
        "1.0.0",
        &["MLRO"],
        "BACKOFFICE_INTERNAL",
    )
    .await;
    sqlx::query(
        "INSERT INTO approval_requests
           (id, updated_at, subject_type, subject_id, payload_diff_json, maker_reason,
            maker_user_id, state, expires_at)
         VALUES ($1, now(), 'REPORT_AML_BYPASS', $2, $3::jsonb, 'why', $4,
                 'PENDING_REVIEW'::\"ApprovalState\", now() + interval '1 day')",
    )
    .bind(Uuid::new_v4())
    .bind(fixture.id.to_string())
    .bind(json!({
        "reportSpecId": fixture.id.to_string(),
        "reportCode": fixture.code,
        "allowedRoles": ["MLRO"],
        "allowedAuthorities": ["report:approve"],
        "justification": "Integration justification of sufficient length"
    }))
    .bind(user)
    .execute(&state.pools.main)
    .await
    .expect("insert approval");

    let (status, body) = call(
        &state,
        executions,
        "/internal/admin/report-engine/executions?limit=1",
        Some(&checker),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let rows = body["executions"].as_array().expect("executions");
    assert!(rows.len() <= 1);
    if let Some(row) = rows.first() {
        assert!(row.get("verificationSha256").is_some());
    }

    let (status, body) = call(
        &state,
        aml_bypass_pending,
        "/internal/admin/report-engine/aml-bypass/pending",
        Some(&checker),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let approvals = body["approvals"].as_array().expect("approvals");
    let ours: Vec<&Value> = approvals
        .iter()
        .filter(|approval| approval["reportCode"] == fixture.code)
        .collect();
    assert_eq!(ours.len(), 1);
    assert_eq!(ours[0]["canDecide"], false, "maker cannot decide");

    // An operator without a checker role is refused.
    sqlx::query("UPDATE users SET role = 'OPERATOR' WHERE id = $1")
        .bind(user)
        .execute(&state.pools.main)
        .await
        .expect("demote role");
    let operator = principal(user, "OPERATOR", &["security:write", "report:approve"]);
    let (status, body) = call(
        &state,
        aml_bypass_pending,
        "/internal/admin/report-engine/aml-bypass/pending",
        Some(&operator),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "AML_BYPASS_CHECKER_REQUIRED");

    delete_report(&state, &fixture).await;
    delete_user(&state, user).await;
}

#[tokio::test]
async fn merchant_reports_and_executions_are_paginated_and_scoped() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let merchant_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM merchants LIMIT 1")
        .fetch_optional(&state.pools.main)
        .await
        .expect("merchant lookup");
    let Some(merchant_id) = merchant_id else {
        eprintln!("SKIP: the test database has no merchant");
        return;
    };
    let user = insert_user(&state, "SECURITY_ADMIN", &["security:write"]).await;
    let principal = principal(user, "SECURITY_ADMIN", &["security:write"]);
    let unique = Uuid::new_v4().simple().to_string();
    let spec_id = Uuid::new_v4();
    let code = format!("it-re-merchant-{unique}");
    sqlx::query(
        "INSERT INTO merchant_report_specs
           (id, merchant_id, code, version, category, status, is_latest_published,
            supported_locales, default_locale, spec_json, spec_sha256, verification_report_json,
            engine_version, spec_schema_version, authoring_transcript_version, published_at,
            created_by_user_id, updated_at)
         VALUES ($1, $2, $3, 1, 'PAYMENTS', 'PUBLISHED'::\"ReportSpecStatus\", true,
                 ARRAY['en'], 'en', $4, repeat('d', 64), '{\"valid\":true}'::jsonb,
                 '1.0.0', '1.0', '1.1', now(), $5, now())",
    )
    .bind(spec_id)
    .bind(merchant_id)
    .bind(&code)
    .bind(descriptor())
    .bind(user)
    .execute(&state.pools.main)
    .await
    .expect("insert merchant spec");

    let (status, body) = call(
        &state,
        merchant_reports,
        &format!(
            "/internal/admin/report-engine/merchant-reports?merchantId={merchant_id}&search={code}"
        ),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 1);
    assert_eq!(body["reports"][0]["code"], code);
    assert!(body["reports"][0]["merchantName"].is_string());
    assert_eq!(body["reports"][0]["studioSuspended"], false);

    let (status, body) = call(
        &state,
        merchant_executions,
        &format!(
            "/internal/admin/report-engine/merchant-executions?merchantId={merchant_id}&limit=1"
        ),
        Some(&principal),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["executions"].is_array());

    // A non-UUID merchant filter is refused rather than reaching PostgreSQL.
    let (status, body) = call(
        &state,
        merchant_reports,
        "/internal/admin/report-engine/merchant-reports?merchantId=not-a-uuid",
        Some(&principal),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "INVALID_BODY");

    sqlx::query("DELETE FROM merchant_report_specs WHERE id = $1")
        .bind(spec_id)
        .execute(&state.pools.main)
        .await
        .expect("delete merchant spec");
    delete_user(&state, user).await;
}

#[tokio::test]
async fn the_module_registers_every_policy_with_an_origin() {
    let routes = routes();
    assert_eq!(routes.len(), 15);
    for route in &routes {
        assert_eq!(route.policy.channel, pg_http::Channel::Admin);
        assert_eq!(route.policy.method, "GET");
        assert!(route
            .policy
            .path
            .starts_with("/internal/admin/report-engine/"));
        assert!(route
            .policy
            .ts_origin
            .starts_with("core-back/api/internal/adminReportEngine.ts:"));
        assert_eq!(route.guard, PrincipalGuard::Staff);
    }
    // Every route has a handler, and none of them is the shared health handler.
    for route in &routes {
        assert!(matches!(route.handler, Handler::Custom(_)));
    }
    // Two policies share no key; duplicate registrations would fail the registry.
    let keys: std::collections::BTreeSet<String> = routes.iter().map(MountedRoute::key).collect();
    assert_eq!(keys.len(), routes.len());
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
    .bind(format!("{id}@autocomplete-slice.local"))
    .execute(&state.pools.main)
    .await
    .expect("insert merchant");
    id
}

async fn insert_merchant_spec(
    state: &AppState,
    creator: Uuid,
    merchant_id: Uuid,
    code: &str,
    engine_version: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO merchant_report_specs
           (id, merchant_id, code, version, category, status, is_latest_published,
            supported_locales, default_locale, spec_json, spec_sha256, verification_report_json,
            engine_version, spec_schema_version, authoring_transcript_version, published_at,
            created_by_user_id, updated_at)
         VALUES ($1, $2, $3, 1, 'PAYMENTS', 'PUBLISHED'::\"ReportSpecStatus\", true,
                 ARRAY['en'], 'en', $4, repeat('f', 64), '{\"valid\":true}'::jsonb,
                 $5, '1.0', '1.1', now(), $6, now())",
    )
    .bind(id)
    .bind(merchant_id)
    .bind(code)
    .bind(descriptor())
    .bind(engine_version)
    .bind(creator)
    .execute(&state.pools.main)
    .await
    .expect("insert merchant spec");
    id
}

#[tokio::test]
async fn migration_prompts_gate_on_404_compatibility_and_the_missing_builder() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "SECURITY_ADMIN", &["security:write"]).await;
    let caller = principal(user, "SECURITY_ADMIN", &["security:write"]);
    let unique = Uuid::new_v4().simple().to_string();

    // 404: no such spec.
    let (status, body) = call(
        &state,
        spec_migration_prompt,
        &format!(
            "/internal/admin/report-engine/specs/{}/migration-prompt",
            Uuid::new_v4()
        ),
        Some(&caller),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "REPORT_SPEC_NOT_FOUND");

    // 409: the compatible spec does not need a migration prompt.
    let compatible = insert_report(
        &state,
        user,
        &format!("it-re-prompt-ok-{unique}"),
        1,
        "PUBLISHED",
        true,
        "1.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;
    let (status, body) = call(
        &state,
        spec_migration_prompt,
        &format!(
            "/internal/admin/report-engine/specs/{}/migration-prompt",
            compatible.id
        ),
        Some(&caller),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "REPORT_SPEC_NOT_MIGRATABLE");

    // 501: migration is needed but the transcript builder is P8-T01.
    let stale = insert_report(
        &state,
        user,
        &format!("it-re-prompt-stale-{unique}"),
        1,
        "PUBLISHED",
        true,
        "2.0.0",
        &["COMPLIANCE"],
        "BACKOFFICE_INTERNAL",
    )
    .await;
    let (status, body) = call(
        &state,
        spec_migration_prompt,
        &format!(
            "/internal/admin/report-engine/specs/{}/migration-prompt",
            stale.id
        ),
        Some(&caller),
    )
    .await;
    assert_eq!(status, 501);
    assert_eq!(body["code"], "NOT_IMPLEMENTED_ROUTE");
    assert_eq!(body["details"]["artifact"], "ReportTranscriptBuilder");

    // Chrome: 409 when compatible, 501 when migration is needed.
    let chrome = insert_chrome(
        &state,
        user,
        &format!("it-re-prompt-{unique}"),
        "PUBLISHED",
        false,
        "HEADER",
    )
    .await;
    let (status, body) = call(
        &state,
        chrome_migration_prompt,
        &format!("/internal/admin/report-engine/chrome/{chrome}/migration-prompt"),
        Some(&caller),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "REPORT_CHROME_NOT_MIGRATABLE");
    sqlx::query("UPDATE report_chrome_specs SET engine_version = '2.0.0' WHERE id = $1")
        .bind(chrome)
        .execute(&state.pools.main)
        .await
        .expect("bump chrome version");
    let (status, body) = call(
        &state,
        chrome_migration_prompt,
        &format!("/internal/admin/report-engine/chrome/{chrome}/migration-prompt"),
        Some(&caller),
    )
    .await;
    assert_eq!(status, 501);
    assert_eq!(body["details"]["artifact"], "ChromeTranscriptBuilder");

    // Merchant line: 404, 409, 501.
    let merchant_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM merchants LIMIT 1")
        .fetch_optional(&state.pools.main)
        .await
        .expect("merchant lookup");
    if let Some(merchant_id) = merchant_id {
        let missing = Uuid::new_v4();
        let (status, body) = call(
            &state,
            merchant_migration_prompt,
            &format!("/internal/admin/report-engine/merchant-reports/{missing}/migration-prompt"),
            Some(&caller),
        )
        .await;
        assert_eq!(status, 404);
        assert_eq!(body["code"], "MERCHANT_REPORT_SPEC_NOT_FOUND");

        let merchant_ok = insert_merchant_spec(
            &state,
            user,
            merchant_id,
            &format!("it-re-mprompt-ok-{unique}"),
            "1.0.0",
        )
        .await;
        let (status, body) = call(
            &state,
            merchant_migration_prompt,
            &format!(
                "/internal/admin/report-engine/merchant-reports/{merchant_ok}/migration-prompt"
            ),
            Some(&caller),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "REPORT_SPEC_NOT_MIGRATABLE");

        let merchant_stale = insert_merchant_spec(
            &state,
            user,
            merchant_id,
            &format!("it-re-mprompt-stale-{unique}"),
            "2.0.0",
        )
        .await;
        let (status, body) = call(
            &state,
            merchant_migration_prompt,
            &format!(
                "/internal/admin/report-engine/merchant-reports/{merchant_stale}/migration-prompt"
            ),
            Some(&caller),
        )
        .await;
        assert_eq!(status, 501);
        assert_eq!(
            body["details"]["artifact"],
            "MerchantReportAuthoringTranscript"
        );
        sqlx::query("DELETE FROM merchant_report_specs WHERE id = ANY($1)")
            .bind(vec![merchant_ok, merchant_stale])
            .execute(&state.pools.main)
            .await
            .expect("delete merchant specs");
    }

    // Authority: merchant:read alone cannot read the prompt.
    let reader = principal(user, "SECURITY_ADMIN", &["merchant:read"]);
    let (status, body) = call(
        &state,
        spec_migration_prompt,
        &format!(
            "/internal/admin/report-engine/specs/{}/migration-prompt",
            compatible.id
        ),
        Some(&reader),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "AUTHORITY_REQUIRED");

    delete_report(&state, &compatible).await;
    delete_report(&state, &stale).await;
    delete_chrome(&state, chrome).await;
    delete_user(&state, user).await;
}

#[tokio::test]
async fn autocomplete_honours_the_host_allow_list_authority_and_scope() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let user = insert_user(&state, "COMPLIANCE", &["merchant:read", "finance:read"]).await;
    let caller = principal(user, "COMPLIANCE", &["merchant:read", "finance:read"]);

    // Unknown source key (the host map is the allow-list).
    let (status, body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/not_a_source",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "AUTOCOMPLETE_SOURCE_NOT_FOUND");

    // A source whose required authority is not held is refused.
    let finance_only = principal(user, "COMPLIANCE", &["finance:read"]);
    let (status, body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/merchants?q=x",
        Some(&finance_only),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "AUTHORITY_REQUIRED");
    assert!(body["message"]
        .as_str()
        .unwrap_or_default()
        .contains("merchant:read"));

    // A real search: the merchant row is returned with the TS item shape.
    let unique = Uuid::new_v4().simple().to_string();
    let token = format!("Ac{unique}");
    let merchant = insert_merchant(&state, &format!("{token} Trading")).await;
    let (status, body) = call(
        &state,
        autocomplete_source,
        &format!("/internal/admin/report-engine/autocomplete/merchants?q={token}&limit=5"),
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let items = body["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["value"], merchant.to_string());
    assert_eq!(items[0]["label"], format!("{token} Trading"));
    assert_eq!(items[0]["badge"], "ACTIVE");

    // Static currency source and the limit clamp.
    let (status, body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/currencies",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["items"].as_array().map(Vec::len), Some(3));
    // The TS `currencies` provider is static and ignores `limit`; the cap applies to SQL sources.
    let (status, body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/currencies?limit=1",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["items"].as_array().map(Vec::len), Some(3));

    // `dependent` scope values are typed before they reach PostgreSQL.
    let (status, body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/applications?q=a&dependent=%7B%22merchantId%22%3A%22nope%22%7D",
        Some(&caller),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "INVALID_BODY");

    // The confidential AML source answers an empty list without AML access.
    let aml_reader = principal(user, "COMPLIANCE", &["merchant:read", "aml:read"]);
    let (status, body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/aml_cases?q=x",
        Some(&aml_reader),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["items"].as_array().map(Vec::len), Some(0));

    // `security:write` is the override for every source.
    let security = principal(user, "SECURITY_ADMIN", &["security:write"]);
    let (status, _body) = call(
        &state,
        autocomplete_source,
        "/internal/admin/report-engine/autocomplete/merchants?q=zzzz-no-match",
        Some(&security),
    )
    .await;
    assert_eq!(status, 200);

    sqlx::query("DELETE FROM merchants WHERE id = $1")
        .bind(merchant)
        .execute(&state.pools.main)
        .await
        .expect("delete merchant");
    delete_user(&state, user).await;
}
