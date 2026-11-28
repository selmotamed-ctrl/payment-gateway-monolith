//! Route-table and database-gated tests for the Sandbox read routes.
//!
//! The table tests are database-free. The handler tests run against `PG_TEST_DATABASE_URL`,
//! `DATABASE_URL` or the project default test database (schema 46) and skip with a printed line when
//! it is unreachable; every fixture row a test creates is removed by the test.
//!
//! Every handler is driven through the real dispatcher table ([`crate::routes::find`]), so a test
//! also proves the `:param` template resolution and the static-over-template precedence
//! (`…/wallets/summary` must not reach `…/wallets/:walletId`).

#![forbid(unsafe_code)]

use std::sync::Arc;

use ntex::http::Method;
use ntex::web::test;
use ntex::web::types::Payload;
use pg_domain_auth::{ExecutionPlane, Principal, PrincipalKind};
use serde_json::Value;
use uuid::Uuid;

use crate::config::CoreConfig;
use crate::routes::{find, Handler, PrincipalGuard};
use crate::state::AppState;

const MASTER_KEY: &str = "core-rs-sandbox-read-master-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip(plane: ExecutionPlane) -> Option<Arc<AppState>> {
    static TRACING: std::sync::Once = std::sync::Once::new();
    TRACING.call_once(|| {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::ERROR)
            .with_test_writer()
            .try_init();
    });
    let url = database_url();
    let mut config = CoreConfig::for_tests(&url, MASTER_KEY);
    config.execution_plane = plane;
    let state = match AppState::connect(config).await {
        Ok(state) => state,
        Err(error) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            return None;
        }
    };
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
    body: Value,
}

impl Response {
    fn code(&self) -> String {
        self.body
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }
}

/// Call the mounted handler for an actual request path.
async fn call(
    state: &Arc<AppState>,
    path: &str,
    principal: Option<&Principal>,
    headers: &[(&str, &str)],
) -> Response {
    let route_path = path.split_once('?').map_or(path, |(head, _)| head);
    let route = find("GET", route_path).unwrap_or_else(|| panic!("no route for {path}"));
    let Handler::Custom(handler) = route.handler else {
        panic!("{path} is not a custom handler");
    };
    let mut request = test::TestRequest::default().method(Method::GET).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = request.to_http_request();
    let response = handler(
        state,
        &request,
        principal,
        Payload(ntex::http::Payload::None),
    )
    .await;
    let status = response.status().as_u16();
    let body = test::read_body(response).await;
    Response {
        status,
        body: serde_json::from_slice(body.as_ref()).unwrap_or(Value::Null),
    }
}

fn merchant_principal(merchant_id: Uuid) -> Principal {
    crate::routes::sandbox::support::session_principal(
        Some(&merchant_id.to_string()),
        "MERCHANT_ADMIN",
        &["merchant:write"],
        PrincipalKind::Session,
    )
}

fn staff_principal() -> Principal {
    crate::routes::sandbox::support::session_principal(
        None,
        "COMPLIANCE",
        &[],
        PrincipalKind::Session,
    )
}

// ---------------------------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------------------------

#[test]
fn mounts_every_sandbox_get_route_once_with_sandbox_metadata() {
    let routes = crate::routes::sandbox::routes();
    assert_eq!(routes.len(), 37, "37 distinct sandbox GET routes");
    let mut keys = std::collections::BTreeSet::new();
    for route in &routes {
        assert_eq!(route.policy.method, "GET", "{}", route.key());
        assert_eq!(route.policy.channel, pg_http::Channel::Sandbox);
        assert_eq!(route.policy.authn, pg_http::Authn::Session);
        assert_eq!(route.guard, PrincipalGuard::None);
        assert!(route.policy.authorities.is_empty());
        assert!(route
            .policy
            .ts_origin
            .starts_with("core-back/api/internal/sandboxControl.ts:"));
        assert!(route.policy.path.starts_with("/internal/sandbox/"));
        assert!(keys.insert(route.key()), "duplicate {}", route.key());
    }
}

#[test]
fn mounted_paths_are_exactly_the_inventory_sandbox_gets() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/golden-vectors/route-inventory/routes.json"
    );
    let raw = std::fs::read_to_string(path).expect("read the committed route inventory");
    let rows: Vec<Value> = serde_json::from_str(&raw).expect("route inventory is valid JSON");
    let mut inventory = std::collections::BTreeSet::new();
    for row in &rows {
        let method = row.get("method").and_then(Value::as_str).unwrap_or("");
        let full = row
            .get("fullPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "GET" && full.starts_with("/internal/sandbox/") {
            inventory.insert(full.to_owned());
        }
    }
    // The inventory lists `GET /internal/sandbox/admin/merchants` twice (line 1980 and the
    // unreachable line 2089 registration); Express serves the first, so the mounted set is 37.
    assert_eq!(inventory.len(), 37, "inventory sandbox GET paths");
    let mounted: std::collections::BTreeSet<String> = crate::routes::sandbox::routes()
        .into_iter()
        .map(|route| route.policy.path)
        .collect();
    assert_eq!(mounted, inventory);
}

#[test]
fn static_paths_win_over_parameter_templates() {
    let summary =
        find("GET", "/internal/sandbox/merchant/studio/wallets/summary").expect("summary route");
    assert_eq!(
        summary.policy.path,
        "/internal/sandbox/merchant/studio/wallets/summary"
    );
    let detail = find(
        "GET",
        "/internal/sandbox/merchant/studio/wallets/0b7f8f36-5f4e-4f1d-9d6f-6a3f0e1d2c3b",
    )
    .expect("wallet detail route");
    assert_eq!(
        detail.policy.path,
        "/internal/sandbox/merchant/studio/wallets/:walletId"
    );

    let transactions_summary = find(
        "GET",
        "/internal/sandbox/admin/fake-rails/transactions/summary",
    )
    .expect("transactions summary");
    assert_eq!(
        transactions_summary.policy.path,
        "/internal/sandbox/admin/fake-rails/transactions/summary"
    );
    assert_eq!(
        find(
            "GET",
            "/internal/sandbox/admin/fake-rails/transactions/tx_1"
        )
        .expect("transaction")
        .policy
        .path,
        "/internal/sandbox/admin/fake-rails/transactions/:transactionId"
    );
    assert_eq!(
        find("GET", "/internal/sandbox/admin/fake-rails/accounts/summary")
            .expect("staff accounts summary")
            .policy
            .path,
        "/internal/sandbox/admin/fake-rails/accounts/summary"
    );
    // The merchant-side accounts route has no `summary` variant, so the template owns that path.
    assert_eq!(
        find("GET", "/internal/sandbox/fake-rails/accounts/summary")
            .expect("merchant account template")
            .policy
            .path,
        "/internal/sandbox/fake-rails/accounts/:accountId"
    );
    assert_eq!(
        find("GET", "/internal/sandbox/merchant/studio/tokens/summary")
            .expect("tokens summary")
            .policy
            .path,
        "/internal/sandbox/merchant/studio/tokens/summary"
    );
    // Method still gates the lookup, and no Sandbox write route is mounted yet.
    assert!(find("POST", "/internal/sandbox/merchant/reset").is_none());
}

// ---------------------------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------------------------

struct Fixture {
    merchant_id: Uuid,
    wallet_id: Uuid,
    gl_account_id: Uuid,
}

async fn create_fixture(state: &AppState, label: &str) -> Option<Fixture> {
    let merchant_id = Uuid::new_v4();
    let wallet_id = Uuid::new_v4();
    let gl_account_id = Uuid::new_v4();
    let name = format!("Sandbox Test {label} {}", &merchant_id.to_string()[..8]);
    let email = format!("{merchant_id}@sandbox.test");
    sqlx::query(
        "INSERT INTO merchants (id, updated_at, legal_name, trade_name, status, kyb_status,
                                onboarding_channel, country, contact_email)
         VALUES ($1, now(), $2, $2, 'ACTIVE'::\"MerchantStatus\", 'VERIFIED'::\"KybStatus\",
                 'SANDBOX', 'LY', $3)",
    )
    .bind(merchant_id)
    .bind(&name)
    .bind(&email)
    .execute(&state.pools.main)
    .await
    .ok()?;
    sqlx::query(
        "INSERT INTO gl_accounts (id, updated_at, account_type, owner_id, currency)
         VALUES ($1, now(), 'MERCHANT_WALLET'::\"GlAccountType\", $2, 'LYD')",
    )
    .bind(gl_account_id)
    .bind(merchant_id.to_string())
    .execute(&state.pools.main)
    .await
    .ok()?;
    sqlx::query(
        "INSERT INTO wallets (id, updated_at, merchant_id, gl_account_id, currency, name, status)
         VALUES ($1, now(), $2, $3, 'LYD', $4, 'ACTIVE'::\"WalletStatus\")",
    )
    .bind(wallet_id)
    .bind(merchant_id)
    .bind(gl_account_id)
    .bind(format!("Test wallet {label}"))
    .execute(&state.pools.main)
    .await
    .ok()?;
    Some(Fixture {
        merchant_id,
        wallet_id,
        gl_account_id,
    })
}

async fn remove_fixture(state: &AppState, fixture: &Fixture) {
    let pool = &state.pools.main;
    let _ = sqlx::query("DELETE FROM wallets WHERE id = $1")
        .bind(fixture.wallet_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM gl_shard_checkpoints WHERE gl_account_id = $1")
        .bind(fixture.gl_account_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM gl_account_shards WHERE gl_account_id = $1")
        .bind(fixture.gl_account_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM gl_accounts WHERE id = $1")
        .bind(fixture.gl_account_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM merchants WHERE id = $1")
        .bind(fixture.merchant_id)
        .execute(pool)
        .await;
}

// ---------------------------------------------------------------------------------------------
// Database-gated behaviour
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_live_plane_refuses_every_sandbox_route() {
    let Some(state) = state_or_skip(ExecutionPlane::Live).await else {
        return;
    };
    let principal = staff_principal();
    let response = call(
        &state,
        "/internal/sandbox/admin/overview",
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(response.status, 403);
    assert_eq!(response.code(), "SANDBOX_PLANE_REQUIRED");
}

#[tokio::test]
async fn another_merchants_wallet_is_a_404_but_its_own_wallet_reads() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let Some(fixture) = create_fixture(&state, "scope").await else {
        eprintln!("SKIP: could not create the sandbox fixture");
        return;
    };
    let path = format!("/internal/sandbox/merchant/wallets/{}", fixture.wallet_id);

    let other = merchant_principal(Uuid::new_v4());
    let denied = call(&state, &path, Some(&other), &[]).await;
    assert_eq!(denied.status, 404, "{}", denied.body);
    assert_eq!(denied.code(), "SANDBOX_WALLET_NOT_FOUND");

    let owner = merchant_principal(fixture.merchant_id);
    let allowed = call(&state, &path, Some(&owner), &[]).await;
    assert_eq!(allowed.status, 200, "{}", allowed.body);
    assert_eq!(
        allowed.body["wallet"]["id"].as_str(),
        Some(fixture.wallet_id.to_string().as_str())
    );
    assert_eq!(allowed.body["wallet"]["currency"].as_str(), Some("LYD"));
    assert_eq!(allowed.body["availableBalance"].as_str(), Some("0.0000"));
    assert_eq!(allowed.body["applications"].as_i64(), Some(0));

    remove_fixture(&state, &fixture).await;
}

#[tokio::test]
async fn a_staff_principal_must_name_the_sandbox_merchant() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let Some(fixture) = create_fixture(&state, "staff").await else {
        eprintln!("SKIP: could not create the sandbox fixture");
        return;
    };
    let staff = staff_principal();

    let missing = call(
        &state,
        "/internal/sandbox/merchant/overview",
        Some(&staff),
        &[],
    )
    .await;
    assert_eq!(missing.status, 400, "{}", missing.body);
    assert_eq!(missing.code(), "SANDBOX_MERCHANT_REQUIRED");

    let header = fixture.merchant_id.to_string();
    let named = call(
        &state,
        "/internal/sandbox/merchant/overview",
        Some(&staff),
        &[("x-sandbox-merchant-id", header.as_str())],
    )
    .await;
    assert_eq!(named.status, 200, "{}", named.body);
    assert_eq!(
        named.body["merchantId"].as_str(),
        Some(fixture.merchant_id.to_string().as_str())
    );
    assert_eq!(named.body["plane"].as_str(), Some("SANDBOX"));
    assert!(named.body["counts"]["wallets"].as_i64().unwrap_or(0) >= 1);
    assert!(named.body.get("syncAudits").is_some());

    remove_fixture(&state, &fixture).await;
}

#[tokio::test]
async fn a_merchant_without_a_read_grant_is_forbidden() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let principal = crate::routes::sandbox::support::session_principal(
        Some(&Uuid::new_v4().to_string()),
        "MERCHANT_STAFF",
        &["onboarding:write"],
        PrincipalKind::Session,
    );
    let response = call(
        &state,
        "/internal/sandbox/merchant/studio/overview",
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(response.status, 403, "{}", response.body);
    assert_eq!(response.code(), "AUTHORITY_REQUIRED");
}

#[tokio::test]
async fn the_admin_portfolio_list_and_summary_have_the_typescript_shape() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let Some(fixture) = create_fixture(&state, "portfolio").await else {
        eprintln!("SKIP: could not create the sandbox fixture");
        return;
    };
    let staff = staff_principal();

    let summary = call(
        &state,
        "/internal/sandbox/admin/merchants/summary",
        Some(&staff),
        &[],
    )
    .await;
    assert_eq!(summary.status, 200, "{}", summary.body);
    let summary = &summary.body["summary"];
    assert!(summary["total"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["status"].is_object());
    assert!(summary["wallets"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["attempts"].is_number());
    assert!(summary["pendingCashouts"].is_number());
    assert!(summary["openDisputes"].is_number());
    assert!(summary["fakeAccounts"].is_number());
    assert!(summary["byCurrency"].is_object());

    let search = format!(
        "Sandbox Test portfolio {}",
        &fixture.merchant_id.to_string()[..8]
    );
    let path = format!(
        "/internal/sandbox/admin/merchants?search={}&pageSize=1",
        url::form_urlencoded::byte_serialize(search.as_bytes()).collect::<String>()
    );
    let list = call(&state, &path, Some(&staff), &[]).await;
    assert_eq!(list.status, 200, "{}", list.body);
    assert_eq!(list.body["total"].as_i64(), Some(1));
    assert_eq!(list.body["page"].as_i64(), Some(1));
    assert_eq!(list.body["pageSize"].as_i64(), Some(1));
    let row = &list.body["merchants"][0];
    assert_eq!(
        row["id"].as_str(),
        Some(fixture.merchant_id.to_string().as_str())
    );
    assert_eq!(row["tradeName"].as_str(), Some(search.as_str()));
    assert_eq!(row["status"].as_str(), Some("ACTIVE"));
    assert_eq!(row["availableBalance"].as_str(), Some("0.0000"));
    assert!(row["wallets"].as_i64().unwrap_or(0) >= 1);
    assert!(row["createdAt"]
        .as_str()
        .is_some_and(|value| value.ends_with('Z')));
    // The envelope carries the filter metadata of the TS listResponse.
    assert!(list.body.get("nextCursor").is_none() || list.body["nextCursor"].is_string());

    let detail = call(
        &state,
        &format!("/internal/sandbox/admin/merchants/{}", fixture.merchant_id),
        Some(&staff),
        &[],
    )
    .await;
    assert_eq!(detail.status, 200, "{}", detail.body);
    assert_eq!(
        detail.body["merchant"]["id"].as_str(),
        Some(fixture.merchant_id.to_string().as_str())
    );
    assert_eq!(
        detail.body["merchant"]["onboardingChannel"].as_str(),
        Some("SANDBOX")
    );
    assert!(detail.body["walletAmounts"].is_array());
    assert_eq!(detail.body["wallets"].as_array().map(Vec::len), Some(1));
    assert!(detail.body["applications"].is_array());
    assert!(detail.body["audits"].is_array());

    // A merchant principal cannot use the staff surface.
    let merchant = merchant_principal(fixture.merchant_id);
    let forbidden = call(
        &state,
        "/internal/sandbox/admin/overview",
        Some(&merchant),
        &[],
    )
    .await;
    assert_eq!(forbidden.status, 403, "{}", forbidden.body);
    assert_eq!(forbidden.code(), "STAFF_ONLY");

    remove_fixture(&state, &fixture).await;
}

#[tokio::test]
async fn a_populated_wallet_reads_through_the_summary_and_detail_routes() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let Some(fixture) = create_fixture(&state, "populated").await else {
        eprintln!("SKIP: could not create the sandbox fixture");
        return;
    };
    let principal = merchant_principal(fixture.merchant_id);

    let summary = call(
        &state,
        "/internal/sandbox/merchant/studio/wallets/summary",
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(summary.status, 200, "{}", summary.body);
    assert_eq!(summary.body["summary"]["total"].as_i64(), Some(1));
    assert_eq!(
        summary.body["summary"]["status"]["ACTIVE"].as_i64(),
        Some(1)
    );
    assert!(summary.body["summary"]["byCurrency"]["LYD"].is_string());
    assert_eq!(
        summary.body["summary"]["byCurrency"]["LYD"].as_str(),
        Some("0.0000")
    );

    let list = call(
        &state,
        "/internal/sandbox/merchant/studio/wallets?pageSize=10",
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(list.status, 200, "{}", list.body);
    assert_eq!(list.body["total"].as_i64(), Some(1));
    let row = &list.body["wallets"][0];
    assert_eq!(
        row["id"].as_str(),
        Some(fixture.wallet_id.to_string().as_str())
    );
    assert_eq!(
        row["merchantId"].as_str(),
        Some(fixture.merchant_id.to_string().as_str())
    );
    assert_eq!(row["checkpointStatus"].as_str(), Some("OK"));
    assert_eq!(row["shardCount"].as_i64(), Some(1));
    assert_eq!(row["applications"].as_i64(), Some(0));

    let detail = call(
        &state,
        &format!(
            "/internal/sandbox/merchant/studio/wallets/{}",
            fixture.wallet_id
        ),
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(detail.status, 200, "{}", detail.body);
    assert_eq!(
        detail.body["wallet"]["glAccount"]["accountType"].as_str(),
        Some("MERCHANT_WALLET")
    );
    assert_eq!(
        detail.body["applications"].as_array().map(Vec::len),
        Some(0)
    );
    assert_eq!(detail.body["cashouts"].as_array().map(Vec::len), Some(0));
    assert_eq!(detail.body["attempts"].as_i64(), Some(0));

    let ledger = call(
        &state,
        &format!(
            "/internal/sandbox/merchant/wallets/{}/ledger?pageSize=5",
            fixture.wallet_id
        ),
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(ledger.status, 200, "{}", ledger.body);
    assert_eq!(ledger.body["currency"].as_str(), Some("LYD"));
    assert_eq!(ledger.body["total"].as_i64(), Some(0));
    assert_eq!(ledger.body["lines"].as_array().map(Vec::len), Some(0));
    assert_eq!(ledger.body["totals"]["lineCount"].as_i64(), Some(0));
    assert_eq!(ledger.body["totals"]["totalDebit"].as_str(), Some("0.0000"));

    let invalid = call(
        &state,
        "/internal/sandbox/merchant/studio/wallets/not-a-uuid",
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(invalid.status, 404);
    assert_eq!(invalid.code(), "SANDBOX_WALLET_NOT_FOUND");

    remove_fixture(&state, &fixture).await;
}

#[tokio::test]
async fn the_studio_overview_reports_the_currency_and_money_shape() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let Some(fixture) = create_fixture(&state, "overview").await else {
        eprintln!("SKIP: could not create the sandbox fixture");
        return;
    };
    let principal = merchant_principal(fixture.merchant_id);
    let response = call(
        &state,
        "/internal/sandbox/merchant/studio/overview?currency=LYD",
        Some(&principal),
        &[],
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["currency"].as_str(), Some("LYD"));
    assert_eq!(response.body["counts"]["wallets"].as_i64(), Some(1));
    assert!(response.body["money"]["available"].is_string());
    assert!(response.body["money"]["charged24h"].is_string());
    assert!(response.body["byCurrency"].is_array());
    assert!(response.body["reference"]["ready"].is_boolean());
    assert!(response.body["recentPayments"].is_array());
    assert!(response.body.get("syncAudits").is_some());
    assert!(response.body["statusCounts"].is_object());

    remove_fixture(&state, &fixture).await;
}

#[tokio::test]
async fn unknown_admin_path_ids_are_a_validation_error() {
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let staff = staff_principal();
    let malformed = call(
        &state,
        "/internal/sandbox/admin/merchants/not-a-uuid",
        Some(&staff),
        &[],
    )
    .await;
    assert_eq!(malformed.status, 400, "{}", malformed.body);
    assert_eq!(malformed.code(), "INVALID_BODY");

    let missing = call(
        &state,
        "/internal/sandbox/admin/merchants/00000000-0000-4000-8000-0000000000ff",
        Some(&staff),
        &[],
    )
    .await;
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(missing.code(), "SANDBOX_MERCHANT_NOT_FOUND");
}

#[tokio::test]
async fn unknown_accounts_and_fake_rails_unavailability_are_mapped() {
    // The Fake Rails control plane is not running in this test environment; the client must answer
    // the TS mapping instead of panicking. This also covers the 5xx/transport tests in
    // `sandbox::control` at the handler boundary.
    let Some(state) = state_or_skip(ExecutionPlane::Sandbox).await else {
        return;
    };
    let staff = staff_principal();
    let previous = std::env::var("FAKE_RAILS_CONTROL_URL").ok();
    std::env::set_var("FAKE_RAILS_CONTROL_URL", "http://127.0.0.1:1");
    let response = call(
        &state,
        "/internal/sandbox/admin/fake-rails/scenarios",
        Some(&staff),
        &[],
    )
    .await;
    match previous {
        Some(value) => std::env::set_var("FAKE_RAILS_CONTROL_URL", value),
        None => std::env::remove_var("FAKE_RAILS_CONTROL_URL"),
    }
    assert_eq!(response.status, 502, "{}", response.body);
    assert_eq!(response.code(), "FAKE_RAILS_UNAVAILABLE");
}
