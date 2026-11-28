//! Certificate verification and the browser return redirect.

mod common;

use std::sync::Arc;

use checkout_edge::config::CheckoutConfig;
use common::{get, MockReply, MockTransport, TestApp};
use ntex::http::StatusCode;
use serde_json::json;

fn core() -> Arc<MockTransport> {
    MockTransport::new(|call| {
        if call
            .path
            .starts_with("/internal/checkout/academy/certificates/")
        {
            return MockReply::ok(json!({
                "certificateId": "ABCDEF0123456789",
                "status": "valid",
                "contentVersion": "1.0.0",
            }));
        }
        if call.path.starts_with("/internal/checkout/return/") {
            return MockReply::ok(json!({ "reference": "REF-RETURN-1", "status": "SUCCEEDED" }));
        }
        MockReply::json(404, json!({ "code": "NOT_FOUND", "message": "missing" }))
    })
}

#[ntex::test]
async fn a_short_public_id_is_a_validation_failure_without_a_core_call() {
    let core = core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(get("/api/v1/verify/certificate/short").to_request())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "VALIDATION_FAILED");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn a_public_id_is_uri_encoded_on_the_core_path() {
    let core = core();
    let app = TestApp::with_core(core.clone()).await;
    let encoded = "opaque%2FPublic%2BId0123456789";
    let response = app
        .call(get(&format!("/api/v1/verify/certificate/{encoded}")).to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        core.last().expect("forwarded").path,
        format!("/internal/checkout/academy/certificates/{encoded}")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.json()["status"], "valid");
}

#[ntex::test]
async fn certificate_verification_is_rate_limited() {
    let config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    let mut config = config;
    config.pay_rate_limit_max = 1;
    let app = TestApp::start(config, core()).await;
    let id = "opaquePublicId0123456789abcdef";
    let first = app
        .call(get(&format!("/api/v1/verify/certificate/{id}")).to_request())
        .await;
    assert_eq!(first.status, StatusCode::OK);
    let second = app
        .call(get(&format!("/api/v1/verify/certificate/{id}")).to_request())
        .await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        second.json()["message"],
        "Too many certificate verification requests, please retry later"
    );
}

#[ntex::test]
async fn a_post_return_forwards_the_browser_return_hint() {
    let core = core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(common::post_empty("/api/v1/return/attempttoken123").to_request())
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.method, "POST");
    assert_eq!(forwarded.path, "/internal/checkout/return/attempttoken123");
    assert_eq!(forwarded.json(), json!({ "hint": "browser_return" }));
    assert!(response
        .header("location")
        .expect("location")
        .contains("attempt_token=attempttoken123"));
}

#[ntex::test]
async fn a_get_return_forwards_only_single_valued_query_parameters() {
    let core = core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            get("/api/v1/return/attempttoken123?reference=R1&reference=R2&channel=web")
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.method, "GET");
    assert_eq!(
        forwarded.query,
        vec![("channel".to_owned(), "web".to_owned())]
    );
    let location = response.header("location").expect("location");
    assert!(location.contains("reference=REF-RETURN-1"));
}

#[ntex::test]
async fn a_short_attempt_token_is_a_validation_failure() {
    let core = core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app.call(get("/api/v1/return/short").to_request()).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "VALIDATION_FAILED");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn the_redirect_uses_the_configured_front_base_url_and_path() {
    let mut config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    config.checkout_front_base_url = "https://pay.example.com/".to_owned();
    config.checkout_front_status_path = "checkout/status".to_owned();
    let app = TestApp::start(config, core()).await;
    let response = app
        .call(get("/api/v1/return/attempttoken123").to_request())
        .await;
    assert_eq!(
        response.header("location"),
        Some("https://pay.example.com/checkout/status?attempt_token=attempttoken123&reference=REF-RETURN-1")
    );
    assert!(response.text().contains("Found. Redirecting to"));
}
