//! Port of `checkout-back/test/sandbox-checkout-forward.test.ts` and
//! `checkout-back/test/sandbox-routing.test.ts`.
//!
//! A `sbx_` link key is the only public Sandbox marker; Sandbox requests never fall back to the
//! Live pool.

mod common;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use checkout_edge::config::CheckoutConfig;
use checkout_edge::core::{
    CoreCall, CoreClient, CoreHttpRequest, CoreResponse, CoreStreamResponse, CoreTransport,
    CoreTransportError,
};
use common::{get, MockReply, MockTransport, TestApp};
use ntex::http::StatusCode;
use pg_upstream::{CoreMethod, Plane};
use serde_json::json;

/// Routes a logical core call to the fake matching its node host.
struct SplitTransport {
    live: Arc<MockTransport>,
    sandbox: Arc<MockTransport>,
}

#[async_trait]
impl CoreTransport for SplitTransport {
    async fn send(
        &self,
        node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreResponse, CoreTransportError> {
        if node_url.contains("sandbox") {
            self.sandbox.send(node_url, request).await
        } else {
            self.live.send(node_url, request).await
        }
    }

    async fn open(
        &self,
        node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreStreamResponse, CoreTransportError> {
        if node_url.contains("sandbox") {
            self.sandbox.open(node_url, request).await
        } else {
            self.live.open(node_url, request).await
        }
    }
}

fn fake_core() -> std::sync::Arc<MockTransport> {
    MockTransport::new(|call| {
        let path = call.path.as_str();
        if path.starts_with("/internal/checkout/academy/certificates/") {
            return MockReply::ok(json!({
                "certificateId": "ABCDEF0123456789",
                "status": "valid",
            }));
        }
        if path.contains("/sandbox-accounts") || path.ends_with("/sandbox-inspector") {
            return MockReply::ok(json!({ "inspector": true }));
        }
        MockReply::ok(json!({
            "linkKey": path.rsplit('/').next().unwrap_or_default(),
            "amount": "100.0000",
            "currency": "LYD",
            "visible_rails": [],
        }))
    })
}

async fn app_with_split() -> (TestApp, Arc<MockTransport>, Arc<MockTransport>) {
    let live = fake_core();
    let sandbox = fake_core();
    let split = Arc::new(SplitTransport {
        live: live.clone(),
        sandbox: sandbox.clone(),
    });
    let config = CheckoutConfig::for_tests(
        vec!["https://core.live.internal:4000".to_owned()],
        Some(vec!["https://core.sandbox.internal:4005".to_owned()]),
    );
    (TestApp::start(config, split).await, live, sandbox)
}

#[ntex::test]
async fn a_sandbox_summary_is_forwarded_through_the_sandbox_pool() {
    let (app, live, sandbox) = app_with_split().await;
    let response = app.call(get("/api/v1/pay/sbx_test123").to_request()).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(sandbox.count(), 1);
    assert_eq!(live.count(), 0);
    assert_eq!(
        sandbox.last().expect("sandbox").path,
        "/internal/checkout/pay/sbx_test123"
    );
    assert_eq!(
        sandbox.last().expect("sandbox").header("x-execution-plane"),
        Some("SANDBOX")
    );
    assert_eq!(
        sandbox.last().expect("sandbox").header("x-sandbox-proxy"),
        Some("checkout-back")
    );
}

#[ntex::test]
async fn a_live_summary_stays_on_the_live_pool_without_sandbox_headers() {
    let (app, live, sandbox) = app_with_split().await;
    let response = app.call(get("/api/v1/pay/pl_test123").to_request()).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(live.count(), 1);
    assert_eq!(sandbox.count(), 0);
    assert_eq!(
        live.last().expect("live").path,
        "/internal/checkout/pay/pl_test123"
    );
    assert!(live
        .last()
        .expect("live")
        .header("x-execution-plane")
        .is_none());
}

#[ntex::test]
async fn a_public_certificate_verification_is_forwarded_to_the_checkout_core() {
    let (app, live, sandbox) = app_with_split().await;
    let public_id = "opaquePublicId0123456789abcdef";
    let response = app
        .call(get(&format!("/api/v1/verify/certificate/{public_id}")).to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        live.last().expect("live").path,
        format!("/internal/checkout/academy/certificates/{public_id}")
    );
    assert_eq!(sandbox.count(), 0);
    assert_eq!(response.json()["status"], "valid");
    assert_eq!(response.json()["certificateId"], "ABCDEF0123456789");
    assert_eq!(response.header("cache-control"), Some("no-store"));
}

#[ntex::test]
async fn the_inspector_is_refused_on_a_live_link_without_touching_core() {
    let (app, live, sandbox) = app_with_split().await;
    let response = app
        .call(get("/api/v1/pay/pl_test123/sandbox-accounts").to_request())
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        response.json()["code"],
        "SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK"
    );
    let inspector = app
        .call(get("/api/v1/pay/pl_test123/logs/att_123/sandbox-inspector").to_request())
        .await;
    assert_eq!(inspector.status, StatusCode::FORBIDDEN);
    assert_eq!(live.count(), 0);
    assert_eq!(sandbox.count(), 0);
}

#[ntex::test]
async fn the_inspector_is_forwarded_on_a_sandbox_link() {
    let (app, live, sandbox) = app_with_split().await;
    let response = app
        .call(get("/api/v1/pay/sbx_test123/logs/att_123/sandbox-inspector").to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(live.count(), 0);
    assert_eq!(
        sandbox.last().expect("sandbox").path,
        "/internal/checkout/pay/sbx_test123/logs/att_123/sandbox-inspector"
    );
}

#[ntex::test]
async fn the_sandbox_account_list_forwards_rail_code_as_a_query() {
    let (app, _live, sandbox) = app_with_split().await;
    let response = app
        .call(get("/api/v1/pay/sbx_test123/sandbox-accounts?railCode=MOAMALAT").to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let forwarded = sandbox.last().expect("sandbox");
    assert_eq!(
        forwarded.path,
        "/internal/checkout/pay/sbx_test123/sandbox-accounts"
    );
    assert_eq!(
        forwarded.query,
        vec![("railCode".to_owned(), "MOAMALAT".to_owned())]
    );
}

#[ntex::test]
async fn an_sbx_link_without_a_configured_sandbox_node_is_refused() {
    let live = fake_core();
    let config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    let app = TestApp::start(config, live.clone()).await;
    let response = app.call(get("/api/v1/pay/sbx_abc123").to_request()).await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.json()["code"], "SANDBOX_NODE_UNAVAILABLE");
    assert_eq!(live.count(), 0);
}

#[test]
fn only_the_sbx_prefix_selects_the_sandbox_plane() {
    assert_eq!(Plane::from_link_key("sbx_abc"), Plane::Sandbox);
    assert_eq!(Plane::from_link_key("pl_abc"), Plane::Live);
    assert_eq!(Plane::from_link_key("LNKTESTKEY1"), Plane::Live);
}

#[ntex::test]
async fn the_sandbox_pool_is_absent_when_not_configured_and_never_reuses_live() {
    let live = fake_core();
    let config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    let config = Arc::new(config);
    let client = CoreClient::new(
        &config.core,
        live.clone(),
        Duration::from_secs(5),
        Duration::from_secs(30),
        1024,
    );
    let error = client
        .call(CoreCall::new(
            Plane::Sandbox,
            CoreMethod::Get,
            "/internal/checkout/pay/sbx_abc",
        ))
        .await
        .expect_err("sandbox unavailable");
    assert_eq!(error.code(), "SANDBOX_NODE_UNAVAILABLE");
    assert_eq!(error.status(), 503);
    assert_eq!(live.count(), 0);
}

#[ntex::test]
async fn a_sandbox_draft_keeps_the_plane_on_the_core_attempt_routes() {
    let (app, live, sandbox) = app_with_split().await;
    let response = app
        .call(
            common::post(
                "/api/v1/pay/sbx_test123/initiate",
                r#"{"railCode":"MOAMALAT","formData":{},"idempotencyKey":"idem-00000001"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
    assert_eq!(live.count(), 0);
    assert_eq!(sandbox.count(), 1);
    assert_eq!(
        sandbox.last().expect("sandbox").header("x-execution-plane"),
        Some("SANDBOX")
    );
}
