//! Port of `checkout-back/test/security-regressions.test.ts`.

mod common;

use std::sync::Arc;

use checkout_edge::config::CheckoutConfig;
use checkout_edge::logging::{redact_secrets, redact_url};
use common::{post, MockReply, MockTransport, TestApp};
use ntex::http::header::HeaderValue;
use ntex::http::{Method, StatusCode};
use pg_edge::{parse_cidr_list, resolve_client_ip, CorsAllowList, TRUSTED_PROXY_DEFAULT};
use serde_json::json;

fn fake_core() -> Arc<MockTransport> {
    MockTransport::new(|call| {
        if call.path.contains("/denied-channel") {
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
        if call.path.contains("/inbound/") {
            return MockReply::ok(json!({ "received": call.body.len() }));
        }
        MockReply::ok(json!({ "currency": "LYD", "visible_rails": [] }))
    })
}

fn config_with(tweak: impl FnOnce(&mut CheckoutConfig)) -> CheckoutConfig {
    let mut config = CheckoutConfig::for_tests(
        vec!["https://core.live.internal:4000".to_owned()],
        Some(vec!["https://core.sandbox.internal:4005".to_owned()]),
    );
    tweak(&mut config);
    config
}

#[ntex::test]
async fn the_inbound_limiter_rejects_before_the_body_is_read_and_is_keyed_per_channel() {
    let core = fake_core();
    let config = config_with(|config| {
        config.inbound_rate_limit_max = 2;
    });
    let app = TestApp::start(config, core.clone()).await;
    let channel_a = "/api/v1/inbound/gw/sandbox/channel-token-a";
    for _ in 0..2 {
        let response = app.call(post(channel_a, "{}").to_request()).await;
        assert_eq!(response.status, StatusCode::OK);
    }
    let reads = app.service.body_reads();
    let limited = app.call(post(channel_a, "{}").to_request()).await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.json()["code"], "RATE_LIMITED");
    assert_eq!(app.service.body_reads(), reads, "the body must not be read");

    let other = app
        .call(post("/api/v1/inbound/gw/sandbox/channel-token-b", "{}").to_request())
        .await;
    assert_eq!(other.status, StatusCode::OK);
    assert_eq!(app.service.body_reads(), reads + 1);
}

#[ntex::test]
async fn a_body_above_the_raw_limit_is_rejected_and_never_reaches_core() {
    let core = fake_core();
    let config = config_with(|config| {
        config.inbound_limit = 100;
    });
    let app = TestApp::start(config, core.clone()).await;
    let body = "x".repeat(200);
    let response = app
        .call(post("/api/v1/inbound/gw/sandbox/channel-token-big", &body).to_request())
        .await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(core.count(), 0);
}

#[test]
fn the_raw_body_limit_is_the_documented_one_mebibyte() {
    let config = CheckoutConfig::for_tests(vec!["https://a".to_owned()], None);
    assert_eq!(config.inbound_limit, 1_048_576);
    assert_eq!(config.json_limit, 1_048_576);
}

#[ntex::test]
async fn only_get_head_and_post_are_accepted_on_inbound() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    for method in [Method::PUT, Method::DELETE, Method::PATCH] {
        let response = app
            .call(
                common::put("/api/v1/inbound/gw/sandbox/channel-token-m", "{}")
                    .method(method.clone())
                    .to_request(),
            )
            .await;
        assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
        assert_eq!(response.header("allow"), Some("GET, HEAD, POST"));
        assert_eq!(response.json()["code"], "METHOD_NOT_ALLOWED", "{method}");
    }
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn cores_error_envelope_is_replaced_by_a_safe_public_one() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(post("/api/v1/inbound/gw/sandbox/denied-channel", "{}").to_request())
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    let body = response.json();
    let mut keys: Vec<&String> = body.as_object().expect("object").keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["code", "message"]);
    assert_eq!(body["code"], "INBOUND_NOT_FOUND");
    let text = response.text();
    assert!(!text.contains("secret-gateway"));
    assert!(!text.contains("ref-internal-1"));
    assert!(!text.contains("INBOUND_GATEWAY_MISMATCH"));
}

#[test]
fn trusted_proxy_defaults_are_loopback_only() {
    let trusted = parse_cidr_list(Some(TRUSTED_PROXY_DEFAULT));
    let ip = |value: &str| value.parse().expect("ip");
    assert_eq!(
        resolve_client_ip(ip("10.1.2.3"), &trusted, Some("1.2.3.4"), Some("9.9.9.9")),
        ip("10.1.2.3")
    );
    assert_eq!(
        resolve_client_ip(ip("192.168.5.5"), &trusted, None, Some("9.9.9.9")),
        ip("192.168.5.5")
    );
    assert_eq!(
        resolve_client_ip(ip("127.0.0.1"), &trusted, Some("203.0.113.7"), None),
        ip("203.0.113.7")
    );
    assert_eq!(
        resolve_client_ip(ip("127.0.0.1"), &trusted, Some("not-an-ip, 1.1.1.1"), None),
        ip("127.0.0.1")
    );
}

#[ntex::test]
async fn the_edge_overwrites_x_real_client_ip_towards_core() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            common::get("/api/v1/pay/LNKOKAY0001")
                .header("x-real-client-ip", "198.51.100.77")
                .header("x-forwarded-for", "198.51.100.78")
                .to_request(),
        )
        .await;
    assert!(response.status.is_success());
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.header("x-real-client-ip"), Some("198.51.100.77"));
    assert_eq!(forwarded.header("x-edge-service"), Some("checkout-back"));
}

#[ntex::test]
async fn edge_owned_headers_cannot_be_overridden_by_the_caller() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            common::get("/api/v1/pay/LNKOKAY0001")
                .header("x-edge-service", "core-back")
                .header("x-real-client-ip", "1.1.1.1")
                .header("authorization", "Bearer evil")
                .to_request(),
        )
        .await;
    assert!(response.status.is_success());
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.header("x-edge-service"), Some("checkout-back"));
    assert_eq!(forwarded.header("x-real-client-ip"), Some("1.1.1.1"));
    assert!(forwarded.header("authorization").is_none());
}

#[test]
fn capability_segments_and_sensitive_query_values_are_redacted() {
    assert_eq!(
        redact_url("/api/v1/inbound/gw/live/SECRETPATHTOKEN"),
        "/api/v1/inbound/gw/live/[REDACTED]"
    );
    assert!(!redact_url("/api/v1/pay/LNKOKAY0001/logs/att_123/status").contains("LNKOKAY0001"));
    assert!(!redact_url("/api/v1/pay/LNKOKAY0001/logs/att_123/status").contains("att_123"));
    assert_eq!(
        redact_url("/api/v1/return/ATTEMPTTOKEN123?reference=R1&token=abc"),
        "/api/v1/return/[REDACTED]?reference=R1&token=[REDACTED]"
    );
    let redacted = redact_secrets(&json!({
        "email": "payer@example.com",
        "nested": { "otp": "1234" },
        "note": "kept",
    }));
    assert_eq!(redacted["email"], "[REDACTED]");
    assert_eq!(redacted["nested"]["otp"], "[REDACTED]");
    assert_eq!(redacted["note"], "kept");
}

#[ntex::test]
async fn responses_carry_security_headers_and_never_allow_credentials() {
    let app = TestApp::with_core(fake_core()).await;
    let response = app
        .call(
            common::get("/health")
                .header("origin", "https://pay.example.com")
                .to_request(),
        )
        .await;
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(response.header("x-frame-options"), Some("DENY"));
    assert_eq!(
        response.header("content-security-policy"),
        Some("frame-ancestors 'none'")
    );
    assert_eq!(
        response.header("cross-origin-resource-policy"),
        Some("cross-origin")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.header("access-control-allow-credentials"), None);
    assert_eq!(response.header("x-powered-by"), None);
}

#[ntex::test]
async fn cors_is_emitted_only_from_the_explicit_allow_list_and_never_with_credentials() {
    let config = config_with(|config| {
        config.cors = CorsAllowList::from_csv(Some("https://pay.example.com"));
    });
    let app = TestApp::start(config, fake_core()).await;
    let response = app
        .call(
            common::get("/api/v1/pay/LNKOKAY0001")
                .header("origin", "https://pay.example.com")
                .to_request(),
        )
        .await;
    assert_eq!(
        response.header("access-control-allow-origin"),
        Some("https://pay.example.com")
    );
    assert_eq!(response.header("access-control-allow-credentials"), None);
    assert_eq!(response.header("vary"), Some("Origin"));

    let preflight = app
        .call(
            ntex::web::test::TestRequest::default()
                .method(Method::OPTIONS)
                .uri("/api/v1/pay/LNKOKAY0001")
                .peer_addr("127.0.0.1:50000".parse().expect("peer"))
                .header("origin", "https://pay.example.com")
                .header("access-control-request-method", "POST")
                .to_request(),
        )
        .await;
    assert_eq!(preflight.status, StatusCode::NO_CONTENT);
    assert_eq!(
        preflight.header("access-control-allow-origin"),
        Some("https://pay.example.com")
    );
    assert_eq!(preflight.header("access-control-allow-credentials"), None);

    let denied = app
        .call(
            common::get("/api/v1/pay/LNKOKAY0001")
                .header("origin", "https://evil.example")
                .to_request(),
        )
        .await;
    assert_eq!(denied.header("access-control-allow-origin"), None);
    assert_eq!(denied.header("vary"), Some("Origin"));
}

#[ntex::test]
async fn the_json_body_limit_is_one_mebibyte() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let body = format!(
        r#"{{"railCode":"MOAMALAT","formData":{{"note":"{}"}},"idempotencyKey":"idem-00000001"}}"#,
        "x".repeat(1_048_576)
    );
    let response = app
        .call(post("/api/v1/pay/LNKTESTKEY1/initiate", &body).to_request())
        .await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.json()["code"], "PAYLOAD_TOO_LARGE");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn the_pay_limiter_runs_before_the_body_is_read() {
    let core = fake_core();
    let config = config_with(|config| {
        config.pay_rate_limit_max = 1;
    });
    let app = TestApp::start(config, core.clone()).await;
    let body = r#"{"railCode":"MOAMALAT","formData":{},"idempotencyKey":"idem-00000001"}"#;
    let first = app
        .call(post("/api/v1/pay/LNKTESTKEY1/initiate", body).to_request())
        .await;
    assert_eq!(first.status, StatusCode::CREATED);
    assert_eq!(app.service.body_reads(), 1);
    let second = app
        .call(post("/api/v1/pay/LNKTESTKEY1/initiate", body).to_request())
        .await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        second.json()["message"],
        "Too many checkout requests, please retry later"
    );
    assert_eq!(app.service.body_reads(), 1, "the body must not be read");
    assert_eq!(core.count(), 1);
}

#[ntex::test]
async fn a_request_id_is_forwarded_but_not_echoed_on_the_response() {
    let core = fake_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            common::get("/api/v1/pay/LNKOKAY0001")
                .header("x-request-id", "request-id-123")
                .to_request(),
        )
        .await;
    // TS parity: the edge forwards the id but never sets the response header.
    assert_eq!(response.header("x-request-id"), None);
    assert_eq!(
        core.last().expect("forwarded").header("x-request-id"),
        Some("request-id-123")
    );

    let generated = app
        .call(common::get("/api/v1/pay/LNKOKAY0001").to_request())
        .await;
    assert_eq!(generated.header("x-request-id"), None);
    assert_eq!(
        core.last()
            .expect("forwarded")
            .header("x-request-id")
            .map(str::len),
        Some(36)
    );
}

#[test]
fn invalid_forwarded_header_values_are_printable_ascii_only() {
    let value = HeaderValue::from_str("ok").expect("value");
    assert_eq!(value.to_str().expect("str"), "ok");
}
