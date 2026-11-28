//! Port of `checkout-back/test/checkout-zero-trust.test.ts`.
//!
//! The payer-facing edge never accepts money, currency, identity or status from the browser; the
//! core resolves them from the payment link.

mod common;

use common::{get, post, MockReply, MockTransport, TestApp};
use ntex::http::{Method, StatusCode};
use serde_json::json;

fn fake_core() -> std::sync::Arc<MockTransport> {
    MockTransport::new(|call| {
        let path = call.path.as_str();
        if path.ends_with("/status") {
            return MockReply::Stream {
                status: 200,
                headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
                chunks: vec![b"data: {\"status\":\"VERIFYING\"}\n\n".to_vec()],
            };
        }
        if path.contains("/inbound/") && path.ends_with("/denied-channel") {
            return MockReply::json(
                403,
                json!({
                    "code": "INBOUND_GATEWAY_MISMATCH",
                    "message": "The inbound gateway does not match the channel",
                    "details": { "expectedGateway": "secret-gateway" },
                    "reference": "ref-internal-1",
                }),
            );
        }
        if path.contains("/inbound/") {
            return MockReply::ok(json!({ "received": call.body.len() }));
        }
        if path.ends_with("/initiate") || path.ends_with("/confirm") {
            return MockReply::json(
                201,
                json!({
                    "attemptId": "att_test_1",
                    "reference": "REF-1",
                    "status": "AWAITING_CUSTOMER",
                    "clientAction": { "type": "SHOW_OTP_FORM" },
                    "received": String::from_utf8_lossy(&call.body),
                }),
            );
        }
        if path.starts_with("/internal/checkout/return/") {
            return MockReply::ok(json!({ "reference": "REF-RETURN-1", "status": "SUCCEEDED" }));
        }
        if path.starts_with("/internal/checkout/academy/certificates/") {
            return MockReply::ok(json!({
                "certificateId": "ABCDEF0123456789",
                "status": "valid",
                "holderName": "operator",
                "trackId": "FOUNDATION",
                "trackTitle": "Foundation",
                "badgeCode": "FOUNDATION_CERTIFIED",
                "earnedAt": "2026-11-23T07:00:00.000Z",
                "expiresAt": "2027-11-23T07:00:00.000Z",
                "contentVersion": "1.0.0",
            }));
        }
        if path.starts_with("/internal/checkout/pay/") {
            if path.contains("LNKMISSING1") {
                return MockReply::json(
                    404,
                    json!({ "code": "LINK_NOT_FOUND", "message": "payment link not found" }),
                );
            }
            return MockReply::ok(json!({
                "linkKey": path.rsplit('/').next().unwrap_or_default(),
                "amount": "100.0000",
                "currency": "LYD",
                "visible_rails": [],
            }));
        }
        MockReply::json(
            404,
            json!({ "code": "CORE_NOT_FOUND", "message": "core resource missing" }),
        )
    })
}

#[ntex::test]
async fn rejects_an_amount_on_initiate_without_touching_core() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/initiate",
                r#"{"railCode":"MOAMALAT","formData":{"phone":"0912345678"},"idempotencyKey":"idem-00000001","amount":"250.0000"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "AMOUNT_NOT_ACCEPTED");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn rejects_a_currency_on_initiate() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/initiate",
                r#"{"railCode":"MOAMALAT","formData":{},"idempotencyKey":"idem-00000002","currency":"LYD"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "AMOUNT_NOT_ACCEPTED");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn rejects_an_amount_nested_in_form_data_with_its_path() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/initiate",
                r#"{"railCode":"MOAMALAT","formData":{"phone":"0912345678","amount":"10"},"idempotencyKey":"idem-00000003"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    let body = response.json();
    assert_eq!(body["code"], "AMOUNT_NOT_ACCEPTED");
    assert_eq!(body["details"]["field"], "formData.amount");
}

#[ntex::test]
async fn rejects_an_amount_on_confirm() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/confirm",
                r#"{"otp":"1234","idempotencyKey":"idem-00000004","amount":"10.0000"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "AMOUNT_NOT_ACCEPTED");
}

#[ntex::test]
async fn forwards_a_compliant_initiate_and_never_transmits_money() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/initiate",
                r#"{"railCode":"MOAMALAT","formData":{"phone":"0912345678"},"idempotencyKey":"idem-00000005"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.method, "POST");
    assert_eq!(
        forwarded.path,
        "/internal/checkout/pay/LNKTESTKEY1/initiate"
    );
    let sent = forwarded.json();
    assert!(sent.get("amount").is_none());
    assert!(sent.get("currency").is_none());
    assert_eq!(sent["railCode"], "MOAMALAT");
    assert_eq!(forwarded.header("x-edge-service"), Some("checkout-back"));
    assert_eq!(forwarded.header("x-request-id").expect("id").len(), 36);
}

#[ntex::test]
async fn rejects_unknown_request_fields() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/initiate",
                r#"{"railCode":"MOAMALAT","formData":{},"idempotencyKey":"idem-00000006","extra":true}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "VALIDATION_FAILED");
}

#[ntex::test]
async fn resolves_a_link_without_accepting_client_money() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app.call(get("/api/v1/pay/LNKTESTKEY1").to_request()).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["currency"], "LYD");
    assert_eq!(
        core.last().expect("forwarded").path,
        "/internal/checkout/pay/LNKTESTKEY1"
    );
}

#[ntex::test]
async fn streams_the_attempt_status_without_buffering() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(get("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/status").to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response
        .header("content-type")
        .is_some_and(|value| value.contains("text/event-stream")));
    assert!(response.text().contains("VERIFYING"));
    assert_eq!(
        response.header("cache-control"),
        Some("no-cache, no-transform")
    );
    assert_eq!(response.header("x-accel-buffering"), Some("no"));
}

#[ntex::test]
async fn forwards_the_raw_inbound_webhook_body_byte_for_byte() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let raw = "{\"event\":\"paid\",\"amount\":\"100.0000\"}";
    let response = app
        .call(
            common::post("/api/v1/inbound/moamalat/live/abc123token", raw)
                .header("x-gateway-signature", "sig-123")
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(
        forwarded.path,
        "/internal/checkout/inbound/moamalat/LIVE/abc123token"
    );
    assert_eq!(
        String::from_utf8(forwarded.body.clone()).expect("utf8"),
        raw
    );
    assert_eq!(forwarded.header("x-gateway-signature"), Some("sig-123"));
    assert_eq!(forwarded.header("content-type"), Some("application/json"));
    assert_eq!(
        forwarded.header("content-length"),
        Some(raw.len().to_string().as_str())
    );
}

#[ntex::test]
async fn redirects_a_browser_return_to_the_hosted_checkout_receipt() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(get("/api/v1/return/attempttoken123").to_request())
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let location = response.header("location").expect("location");
    assert!(location.contains("/pay/status"));
    assert!(location.contains("attempt_token=attempttoken123"));
    assert!(location.contains("reference=REF-RETURN-1"));
    assert_eq!(
        core.last().expect("forwarded").path,
        "/internal/checkout/return/attempttoken123"
    );
}

#[ntex::test]
async fn rejects_an_inbound_webhook_with_an_unknown_environment_segment() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(common::post("/api/v1/inbound/moamalat/staging/abc123token", "{}").to_request())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "VALIDATION_FAILED");
}

#[ntex::test]
async fn maps_a_core_failure_into_the_stable_envelope() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app.call(get("/api/v1/pay/LNKMISSING1").to_request()).await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    let body = response.json();
    assert_eq!(body["code"], "LINK_NOT_FOUND");
    assert_eq!(body["message"], "payment link not found");
}

#[ntex::test]
async fn forwards_a_legacy_client_event_alias_as_the_canonical_core_event() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event",
                r#"{"event":"COMPLETE_CALLBACK"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(
        forwarded.path,
        "/internal/checkout/pay/LNKTESTKEY1/logs/att_test_1/client-event"
    );
    assert_eq!(forwarded.json()["event"], "completeCallback");
}

#[ntex::test]
async fn forwards_a_kebab_case_client_event_alias() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event",
                r#"{"event":"widget-closed"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        core.last().expect("forwarded").json()["event"],
        "widgetEvent"
    );
}

#[ntex::test]
async fn rejects_an_unsupported_client_event_without_touching_core() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event",
                r#"{"event":"NOT_AN_EVENT"}"#,
            )
            .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "VALIDATION_FAILED");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn forwards_the_inbound_environment_aliases_as_the_canonical_core_pair() {
    for (alias, canonical) in [
        ("test", "SANDBOX"),
        ("uat", "SANDBOX"),
        ("production", "LIVE"),
    ] {
        let core = fake_core();
        let app = TestApp::with_core(core.clone()).await;
        let response = app
            .call(
                common::post(
                    &format!("/api/v1/inbound/moamalat/{alias}/abc123token"),
                    "{}",
                )
                .to_request(),
            )
            .await;
        assert_eq!(response.status, StatusCode::OK, "{alias}");
        assert_eq!(
            core.last().expect("forwarded").path,
            format!("/internal/checkout/inbound/moamalat/{canonical}/abc123token")
        );
    }
}

#[ntex::test]
async fn never_forwards_inbound_credentials_or_identity_headers() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            common::post("/api/v1/inbound/moamalat/live/abc123token", "{}")
                .header("authorization", "Bearer super-secret")
                .header("cookie", "session=super-secret")
                .header("x-user-id", "user-42")
                .header("x-authorities", "MERCHANT_ADMIN")
                .header("x-roles", "MERCHANT_ADMIN")
                .header("x-signature", "sig-allow")
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let forwarded = core.last().expect("forwarded");
    assert!(forwarded.header("authorization").is_none());
    assert!(forwarded.header("cookie").is_none());
    assert!(forwarded.header("x-user-id").is_none());
    assert!(forwarded.header("x-authorities").is_none());
    assert!(forwarded.header("x-roles").is_none());
    assert_eq!(forwarded.header("x-signature"), Some("sig-allow"));
}

#[ntex::test]
async fn unknown_routes_use_the_express_not_found_envelope() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(
            ntex::web::test::TestRequest::with_uri("/api/v1/nope")
                .method(Method::GET)
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(
        response.json(),
        json!({ "code": "NOT_FOUND", "message": "No route matches GET /api/v1/nope" })
    );
}

#[ntex::test]
async fn rejects_an_amount_on_resend_and_cancel_too() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    for action in ["resend", "cancel"] {
        let response = app
            .call(
                post(
                    &format!("/api/v1/pay/LNKTESTKEY1/logs/att_test_1/{action}"),
                    r#"{"amount":"10.0000"}"#,
                )
                .to_request(),
            )
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{action}");
        assert_eq!(response.json()["code"], "AMOUNT_NOT_ACCEPTED", "{action}");
    }
    assert_eq!(core.count(), 0);
}
