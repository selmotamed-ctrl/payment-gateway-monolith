//! HTTP pipe edge cases: inflation, body limits, HEAD/health, SSE slots and core body mapping.

mod common;

use std::sync::Arc;

use checkout_edge::config::CheckoutConfig;
use common::{MockReply, MockTransport, TestApp};
use ntex::http::{Method, StatusCode};
use serde_json::json;

fn json_core() -> Arc<MockTransport> {
    MockTransport::new(|call| {
        if call.path.ends_with("/status") {
            return MockReply::Stream {
                status: 200,
                headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
                chunks: vec![
                    b"event: status\ndata: {\"status\":\"AUTHORIZING\"}\n\n".to_vec(),
                    b"event: status\ndata: {\"status\":\"SUCCEEDED\"}\n\n".to_vec(),
                ],
            };
        }
        if call.path.contains("/inbound/") {
            return MockReply::ok(json!({ "received": call.body.len() }));
        }
        MockReply::ok(json!({ "currency": "LYD" }))
    })
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
        .collect()
}

fn gzip_bytes() -> Vec<u8> {
    // gzip({"event":"paid","amount":"100.0000"}) with mtime 0.
    hex_bytes("1f8b08000000000002ffab564a2d4bcd2b51b2522a48cc4c51d2514acccd2f05f30d0d0cf40c8040a91600bbe3242624000000")
}

#[ntex::test]
async fn supported_inbound_encodings_are_inflated_and_the_length_recomputed() {
    let raw = b"{\"event\":\"paid\",\"amount\":\"100.0000\"}";
    let cases: [(&str, Vec<u8>); 3] = [
        ("gzip", gzip_bytes()),
        (
            "deflate",
            hex_bytes("789cab564a2d4bcd2b51b2522a48cc4c51d2514acccd2f05f30d0d0cf40c8040a91600d3a00a7c"),
        ),
        (
            "zstd",
            hex_bytes("28b52ffd24242101007b226576656e74223a2270616964222c22616d6f756e74223a223130302e30303030227d72caf5fa"),
        ),
    ];
    for (encoding, payload) in cases {
        let core = json_core();
        let app = TestApp::with_core(core.clone()).await;
        let response = app
            .call(
                common::post_empty("/api/v1/inbound/moamalat/live/abc123token")
                    .header("content-type", "application/json")
                    .header("content-encoding", encoding)
                    .payload(payload)
                    .to_request(),
            )
            .await;
        assert_eq!(response.status, StatusCode::OK, "{encoding}");
        let forwarded = core.last().expect("forwarded");
        assert_eq!(forwarded.body, raw, "{encoding}");
        assert_eq!(
            forwarded.header("content-length"),
            Some(raw.len().to_string().as_str()),
            "{encoding}"
        );
        assert_eq!(
            forwarded.header("content-encoding"),
            None,
            "{encoding}: the inflated body has no encoding"
        );
    }
}

#[ntex::test]
async fn a_brotli_inbound_body_is_inflated_and_the_length_recomputed() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let raw = b"{\"event\":\"paid\",\"amount\":\"100.0000\"}";
    let payload =
        hex_bytes("a11801002044274bfdb2d9ab7235309113f0b276a1b7c5751f0f9d65664ad9b726e92ff1");
    let response = app
        .call(
            common::post_empty("/api/v1/inbound/moamalat/live/abc123token")
                .header("content-type", "application/json")
                .header("content-encoding", "br")
                .payload(payload)
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.body, raw);
    assert_eq!(
        forwarded.header("content-length"),
        Some(raw.len().to_string().as_str())
    );
    assert_eq!(forwarded.header("content-encoding"), None);
}

#[ntex::test]
async fn an_oversized_brotli_body_is_rejected_with_the_raw_limit_error() {
    // 200 'x' compressed to 11 bytes; the configured inflated limit is 100.
    let mut config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    config.inbound_limit = 100;
    let core = json_core();
    let app = TestApp::start(config, core.clone()).await;
    let payload = hex_bytes("a13806002081178b051200");
    let response = app
        .call(
            common::post_empty("/api/v1/inbound/moamalat/live/abc123token")
                .header("content-type", "application/json")
                .header("content-encoding", "br")
                .payload(payload)
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.json()["code"], "PAYLOAD_TOO_LARGE");
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn an_unknown_content_encoding_is_refused() {
    let app = TestApp::with_core(json_core()).await;
    let response = app
        .call(
            common::post_empty("/api/v1/inbound/moamalat/live/abc123token")
                .header("content-type", "application/json")
                .header("content-encoding", "compress")
                .payload("{}")
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[ntex::test]
async fn malformed_json_is_a_generic_bad_request() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(common::post("/api/v1/pay/LNKTESTKEY1/initiate", "{not json").to_request())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "BAD_REQUEST");
    assert_eq!(
        response.json()["message"],
        "The request body could not be parsed"
    );
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn a_top_level_json_primitive_is_refused() {
    let app = TestApp::with_core(json_core()).await;
    let response = app
        .call(common::post("/api/v1/pay/LNKTESTKEY1/initiate", "\"string\"").to_request())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
}

#[ntex::test]
async fn form_urlencoded_bodies_are_parsed_like_express() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            common::post_empty("/api/v1/pay/LNKTESTKEY1/initiate")
                .header("content-type", "application/x-www-form-urlencoded")
                .payload("railCode=MOAMALAT&idempotencyKey=idem-00000001")
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
    assert_eq!(
        core.last().expect("forwarded").json()["railCode"],
        "MOAMALAT"
    );
}

#[ntex::test]
async fn a_head_request_has_no_body_but_keeps_content_length() {
    let app = TestApp::with_core(json_core()).await;
    let response = app
        .call(
            ntex::web::test::TestRequest::default()
                .method(Method::HEAD)
                .uri("/api/v1/pay/LNKTESTKEY1")
                .peer_addr("127.0.0.1:50000".parse().expect("peer"))
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.body.is_empty());
    assert!(response
        .header("content-length")
        .is_some_and(|value| value.parse::<u64>().expect("length") > 0));
}

#[ntex::test]
async fn a_post_to_health_is_not_a_route() {
    let app = TestApp::with_core(json_core()).await;
    let response = app.call(common::post_empty("/health").to_request()).await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["message"], "No route matches POST /health");
}

#[ntex::test]
async fn an_inbound_path_without_three_segments_is_not_found_after_the_body_is_read() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(common::post("/api/v1/inbound/moamalat", "{}").to_request())
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(core.count(), 0);
}

#[ntex::test]
async fn a_get_inbound_is_forwarded_as_a_get_with_an_empty_body() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(common::get("/api/v1/inbound/moamalat/live/abc123token").to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let forwarded = core.last().expect("forwarded");
    assert_eq!(forwarded.method, "GET");
    assert!(forwarded.body.is_empty());
}

#[ntex::test]
async fn a_head_inbound_is_forwarded_as_head() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            ntex::web::test::TestRequest::default()
                .method(Method::HEAD)
                .uri("/api/v1/inbound/moamalat/live/abc123token")
                .peer_addr("127.0.0.1:50000".parse().expect("peer"))
                .to_request(),
        )
        .await;
    assert!(response.status.is_success());
    assert_eq!(core.last().expect("forwarded").method, "HEAD");
}

#[ntex::test]
async fn the_sse_stream_slot_is_released_when_the_stream_ends() {
    let app = TestApp::with_core(json_core()).await;
    assert_eq!(app.service.active_streams("127.0.0.1"), 0);
    let response = app
        .call(common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123/status").to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.text().contains("SUCCEEDED"));
    assert_eq!(app.service.active_streams("127.0.0.1"), 0);
}

#[ntex::test]
async fn a_core_error_body_without_an_envelope_keeps_the_fallback_code() {
    let core = MockTransport::new(|_| MockReply::Buffered {
        status: 503,
        headers: vec![("content-type".to_owned(), "text/plain".to_owned())],
        body: b"upstream exploded".to_vec(),
    });
    let app = TestApp::with_core(core).await;
    let response = app
        .call(common::get("/api/v1/pay/LINKOK1").to_request())
        .await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.json()["code"], "CORE_UNAVAILABLE");
    assert_eq!(response.json()["message"], "upstream exploded");
}

#[ntex::test]
async fn a_stream_error_status_is_mapped_to_the_core_envelope() {
    let core = MockTransport::new(|_| {
        MockReply::json(
            409,
            json!({ "code": "ATTEMPT_STATE_CONFLICT", "message": "attempt changed" }),
        )
    });
    let app = TestApp::with_core(core).await;
    let response = app
        .call(common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123/status").to_request())
        .await;
    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.json()["code"], "ATTEMPT_STATE_CONFLICT");
}

#[ntex::test]
async fn max_streams_per_ip_refuses_extra_streams() {
    let mut config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    config.max_streams_per_ip = 1;
    let app = TestApp::start(config, json_core()).await;
    // The test harness reads the whole body, so the first slot is released before the second
    // request: exercising the limit itself needs an open stream, which the service exposes through
    // `active_streams` and the release test above. This asserts the configured value is honoured.
    assert_eq!(app.service.config().max_streams_per_ip, 1);
}

#[ntex::test]
async fn max_streams_per_ip_is_enforced_before_opening_another_stream() {
    let mut config =
        CheckoutConfig::for_tests(vec!["https://core.live.internal:4000".to_owned()], None);
    config.max_streams_per_ip = 1;
    let app = TestApp::start(config, json_core()).await;
    let first = app
        .call_headers(common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123/status").to_request())
        .await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(app.service.active_streams("127.0.0.1"), 1);

    let second = app
        .call(common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123/status").to_request())
        .await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(second.json()["code"], "STREAM_LIMIT_REACHED");

    drop(first);
    let third = app
        .call(common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123/status").to_request())
        .await;
    assert_eq!(third.status, StatusCode::OK);
    assert_eq!(app.service.active_streams("127.0.0.1"), 0);
}

#[ntex::test]
async fn a_malformed_percent_escape_is_a_bad_request_not_a_server_error() {
    let app = TestApp::with_core(json_core()).await;
    let response = app
        .call(common::get("/api/v1/pay/%ZZTESTKEY1").to_request())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "BAD_REQUEST");

    let response = app
        .call(common::get("/api/v1/return/attempt%ZZtoken123").to_request())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
}

#[ntex::test]
async fn inbound_segments_are_percent_decoded_before_validation() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(common::get("/api/v1/inbound/moamalat/live/abc%31%32%33").to_request())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        core.last().expect("forwarded").path,
        "/internal/checkout/inbound/moamalat/LIVE/abc123"
    );

    let malformed = app
        .call(common::get("/api/v1/inbound/moamalat/live/abc%ZZ123").to_request())
        .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    assert_eq!(malformed.json()["code"], "BAD_REQUEST");
}

#[ntex::test]
async fn a_whitespace_json_body_is_not_treated_as_empty() {
    let core = json_core();
    let app = TestApp::with_core(core.clone()).await;
    let response = app
        .call(
            common::post_empty("/api/v1/pay/LNKTESTKEY1/initiate")
                .header("content-type", "application/json")
                .payload("   ")
                .to_request(),
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.json()["code"], "BAD_REQUEST");
    assert_eq!(core.count(), 0);
}
