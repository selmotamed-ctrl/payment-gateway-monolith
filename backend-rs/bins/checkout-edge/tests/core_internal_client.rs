//! Port of `checkout-back/test/core-internal-client.test.ts` and
//! `checkout-back/test/mtls-client.test.ts`.
//!
//! Node selection, passive health, replay rules, path confinement, header hygiene and the
//! buffered/streaming executors — all against a deterministic fake transport.

mod common;

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use checkout_edge::config::CheckoutConfig;
use checkout_edge::core::{
    consistency_header, CoreCall, CoreClient, CoreTransport, CoreTransportError, ReqwestTransport,
};
use checkout_edge::inbound::translate_inbound_environment;
use checkout_edge::logging::{redact_secrets, redact_url};
use common::{MockReply, MockTransport};
use pg_mtls::ClientTlsPaths;
use pg_upstream::{
    assert_core_path, build_core_headers, parse_core_back_urls, resolve_core_url, CoreMethod,
    CoreRequestMeta, EdgeChannel, Plane, PoolError, QueryValue, RetryOptions, TransportFailure,
};
use serde_json::json;

fn client(
    live: &[&str],
    transport: Arc<dyn CoreTransport>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
) -> CoreClient {
    let config =
        CheckoutConfig::for_tests(live.iter().map(|url| (*url).to_owned()).collect(), None);
    CoreClient::new(
        &config.core,
        transport,
        Duration::from_secs(5),
        Duration::from_secs(30),
        1024,
    )
    .with_clock(clock)
}

fn fixed_clock() -> Arc<dyn Fn() -> u64 + Send + Sync> {
    Arc::new(|| 1_000)
}

fn get_call(path: &str) -> CoreCall {
    CoreCall::new(Plane::Live, CoreMethod::Get, path).with_identity(
        "req-1",
        "203.0.113.7",
        "checkout-front/1.0",
    )
}

#[test]
fn core_back_urls_follow_the_ts_rules() {
    assert_eq!(
        parse_core_back_urls(None, "https://core-one.internal:4000").expect("fallback"),
        vec!["https://core-one.internal:4000"]
    );
    assert_eq!(
        parse_core_back_urls(Some("   "), "https://core-one.internal:4000").expect("blank"),
        vec!["https://core-one.internal:4000"]
    );
    assert_eq!(
        parse_core_back_urls(
            Some(" https://core-a.internal:4000 , https://core-b.internal:4000,https://core-a.internal:4000/ "),
            "https://ignored"
        )
        .expect("list"),
        vec![
            "https://core-a.internal:4000",
            "https://core-b.internal:4000"
        ]
    );
    assert!(parse_core_back_urls(Some("http://core-a.internal:4000"), "https://x").is_err());
    assert!(parse_core_back_urls(Some("not-a-url"), "https://x").is_err());
    assert!(parse_core_back_urls(
        Some("https://core-a.internal:4000,,https://core-b.internal:4000"),
        "https://x"
    )
    .is_err());
}

#[ntex::test]
async fn round_robins_among_nodes_with_equal_in_flight_counts() {
    let core = MockTransport::new(|call| MockReply::ok(json!({ "node": call.node })));
    let client = client(
        &["https://first.test", "https://second.test"],
        core.clone(),
        fixed_clock(),
    );
    let first = client
        .call(get_call("/internal/checkout/pay/a"))
        .await
        .expect("first");
    let first_node = serde_json::from_slice::<serde_json::Value>(&first.body).expect("json");
    let second = client
        .call(get_call("/internal/checkout/pay/b"))
        .await
        .expect("second");
    let second_node = serde_json::from_slice::<serde_json::Value>(&second.body).expect("json");
    assert_ne!(first_node["node"], second_node["node"]);
    let calls = core.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().any(|call| call.node == "https://first.test"));
    assert!(calls.iter().any(|call| call.node == "https://second.test"));
}

#[ntex::test]
async fn fails_over_on_connection_refused() {
    let counts = Arc::new(AtomicUsize::new(0));
    let counter = counts.clone();
    let core = MockTransport::new(move |call| {
        if call.node == "https://dead.test" {
            MockReply::Fail(CoreTransportError::new(
                TransportFailure::ConnectionRefused,
                true,
            ))
        } else {
            counter.fetch_add(1, Ordering::SeqCst);
            MockReply::ok(json!({ "ok": true }))
        }
    });
    let client = client(
        &["https://dead.test", "https://alive.test"],
        core.clone(),
        fixed_clock(),
    );
    let response = client
        .call(get_call("/internal/checkout/pay/a"))
        .await
        .expect("failover");
    assert_eq!(response.status, 200);
    assert_eq!(counts.load(Ordering::SeqCst), 1);
    let second = client
        .call(get_call("/internal/checkout/pay/b"))
        .await
        .expect("second");
    assert_eq!(second.status, 200);
    assert_eq!(counts.load(Ordering::SeqCst), 2);
}

#[ntex::test]
async fn fails_over_on_a_request_timeout() {
    let core = MockTransport::new(|call| {
        if call.node == "https://stalled.test" {
            MockReply::Fail(CoreTransportError::new(TransportFailure::Timeout, false))
        } else {
            MockReply::ok(json!({ "ok": true }))
        }
    });
    let client = client(
        &["https://stalled.test", "https://healthy.test"],
        core.clone(),
        fixed_clock(),
    );
    let call = get_call("/internal/checkout/pay/a").with_retry(RetryOptions {
        max_attempts: Some(2),
        ..RetryOptions::default()
    });
    let response = client.call(call).await.expect("timeout failover");
    assert_eq!(response.status, 200);
    assert!(core
        .calls()
        .iter()
        .any(|recorded| recorded.node == "https://healthy.test"));
}

#[ntex::test]
async fn does_not_fail_over_on_400_or_401() {
    let core = MockTransport::new(|call| {
        if call.node == "https://first.test" {
            MockReply::json(400, json!({ "code": "BAD_INPUT" }))
        } else {
            MockReply::ok(json!({}))
        }
    });
    let first_client = client(
        &["https://first.test", "https://second.test"],
        core.clone(),
        fixed_clock(),
    );
    let response = first_client
        .call(get_call("/internal/checkout/pay/a"))
        .await
        .expect("answer");
    assert_eq!(response.status, 400);
    assert_eq!(core.count(), 1);

    let core = MockTransport::new(|call| {
        if call.node == "https://first.test" {
            MockReply::json(401, json!({ "code": "UNAUTHORIZED" }))
        } else {
            MockReply::ok(json!({}))
        }
    });
    let second_client = client(
        &["https://first.test", "https://second.test"],
        core.clone(),
        fixed_clock(),
    );
    let response = second_client
        .call(get_call("/internal/checkout/pay/b"))
        .await
        .expect("answer");
    assert_eq!(response.status, 401);
    assert_eq!(core.count(), 1);
}

#[ntex::test]
async fn fails_over_on_502_and_503_for_read_only_calls() {
    for status in [502_u16, 503_u16] {
        let core = MockTransport::new(move |call| {
            if call.node == "https://bad.test" {
                MockReply::json(status, json!({ "code": "BAD_GATEWAY" }))
            } else {
                MockReply::ok(json!({ "ok": true }))
            }
        });
        let client = client(
            &["https://bad.test", "https://good.test"],
            core.clone(),
            fixed_clock(),
        );
        let response = client
            .call(get_call("/internal/checkout/pay/a"))
            .await
            .expect("get");
        assert_eq!(response.status, 200, "{status}");
        assert_eq!(core.count(), 2);
    }
}

#[ntex::test]
async fn does_not_retry_a_non_idempotent_post_unless_opted_in() {
    let core = MockTransport::new(|call| {
        if call.node == "https://bad.test" {
            MockReply::json(502, json!({ "code": "BAD_GATEWAY" }))
        } else {
            MockReply::ok(json!({}))
        }
    });
    let no_retry_client = client(
        &["https://bad.test", "https://good.test"],
        core.clone(),
        fixed_clock(),
    );
    let call = CoreCall::new(
        Plane::Live,
        CoreMethod::Post,
        "/internal/checkout/pay/a/initiate",
    )
    .with_identity("r", "10.0.0.1", "ua")
    .with_body(br#"{"value":1}"#.to_vec());
    let response = no_retry_client.call(call).await.expect("post");
    assert_eq!(response.status, 502);
    assert_eq!(core.count(), 1);

    let core = MockTransport::new(|call| {
        if call.node == "https://bad.test" {
            MockReply::json(502, json!({ "code": "BAD_GATEWAY" }))
        } else {
            MockReply::ok(json!({}))
        }
    });
    let retrying_client = client(
        &["https://bad.test", "https://good.test"],
        core.clone(),
        fixed_clock(),
    );
    let call = CoreCall::new(
        Plane::Live,
        CoreMethod::Post,
        "/internal/checkout/pay/a/initiate",
    )
    .with_identity("r", "10.0.0.1", "ua")
    .with_body(br#"{"value":1}"#.to_vec())
    .with_retry(RetryOptions {
        retry_if_unavailable: true,
        ..RetryOptions::default()
    });
    let response = retrying_client.call(call).await.expect("post retry");
    assert_eq!(response.status, 200);
    assert_eq!(core.count(), 2);
}

#[ntex::test]
async fn put_and_delete_are_not_replayed_after_send() {
    for method in [CoreMethod::Put, CoreMethod::Delete] {
        let core = MockTransport::new(|call| {
            if call.node == "https://bad.test" {
                MockReply::json(503, json!({ "code": "UNAVAILABLE" }))
            } else {
                MockReply::ok(json!({}))
            }
        });
        let client = client(
            &["https://bad.test", "https://good.test"],
            core.clone(),
            fixed_clock(),
        );
        let call = CoreCall::new(Plane::Live, method, "/internal/checkout/pay/a")
            .with_identity("r", "10.0.0.1", "ua")
            .with_body(b"{}".to_vec());
        let response = client.call(call).await.expect("answer");
        assert_eq!(response.status, 503, "{method:?}");
        assert_eq!(core.count(), 1, "{method:?}");
    }
}

#[ntex::test]
async fn put_is_retried_when_the_connection_never_established() {
    let core = MockTransport::new(|call| {
        if call.node == "https://dead.test" {
            MockReply::Fail(CoreTransportError::new(
                TransportFailure::ConnectionRefused,
                true,
            ))
        } else {
            MockReply::ok(json!({}))
        }
    });
    let client = client(
        &["https://dead.test", "https://alive.test"],
        core.clone(),
        fixed_clock(),
    );
    let call = CoreCall::new(Plane::Live, CoreMethod::Put, "/internal/checkout/pay/a")
        .with_identity("r", "10.0.0.1", "ua")
        .with_body(b"{}".to_vec());
    let response = client.call(call).await.expect("put retry");
    assert_eq!(response.status, 200);
    assert_eq!(core.count(), 2);
}

#[ntex::test]
async fn a_request_with_an_idempotency_key_may_be_replayed() {
    let core = MockTransport::new(|call| {
        if call.node == "https://first.test" {
            MockReply::json(503, json!({ "code": "UNAVAILABLE" }))
        } else {
            MockReply::ok(json!({}))
        }
    });
    let client = client(
        &["https://first.test", "https://second.test"],
        core.clone(),
        fixed_clock(),
    );
    let call = CoreCall::new(Plane::Live, CoreMethod::Put, "/internal/checkout/pay/a")
        .with_identity("r", "10.0.0.1", "ua")
        .with_body(b"{}".to_vec())
        .with_headers(vec![(
            "idempotency-key".to_owned(),
            "idem-key-0001".to_owned(),
        )]);
    let response = client.call(call).await.expect("idempotent");
    assert_eq!(response.status, 200);
    assert_eq!(core.count(), 2);
}

#[ntex::test]
async fn core_502_503_504_answers_never_eject_a_node() {
    let status = Arc::new(AtomicU64::new(503));
    let current = status.clone();
    let core = MockTransport::new(move |_| {
        let code = current.load(Ordering::SeqCst) as u16;
        if code == 200 {
            MockReply::ok(json!({ "ok": true }))
        } else {
            MockReply::json(code, json!({ "code": "SCREENING_UNAVAILABLE" }))
        }
    });
    let client = client(&["https://only.test"], core.clone(), Arc::new(|| 1_000));
    for code in [503_u64, 502, 504, 503, 503, 503, 503] {
        status.store(code, Ordering::SeqCst);
        let call = get_call("/internal/checkout/pay/a").with_retry(RetryOptions {
            max_attempts: Some(1),
            ..RetryOptions::default()
        });
        let response = client.call(call).await.expect("answer");
        assert_eq!(u64::from(response.status), code);
    }
    assert_eq!(core.count(), 7);
    status.store(200, Ordering::SeqCst);
    let recovered = client
        .call(get_call("/internal/checkout/pay/a"))
        .await
        .expect("recovered");
    assert_eq!(recovered.status, 200);
}

#[ntex::test]
async fn a_half_open_probe_after_the_cooldown_recovers_the_node() {
    let available = Arc::new(AtomicBool::new(false));
    let flag = available.clone();
    let core = MockTransport::new(move |_| {
        if flag.load(Ordering::SeqCst) {
            MockReply::ok(json!({ "ok": true }))
        } else {
            MockReply::Fail(CoreTransportError::new(
                TransportFailure::ConnectionReset,
                false,
            ))
        }
    });
    let now = Arc::new(AtomicU64::new(1_000));
    let clock_now = now.clone();
    let client = client(
        &["https://only.test"],
        core.clone(),
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
    );
    for _ in 0..3 {
        let call = get_call("/internal/checkout/pay/a").with_retry(RetryOptions {
            max_attempts: Some(1),
            ..RetryOptions::default()
        });
        client.call(call).await.expect_err("transport failure");
    }
    let before = core.count();
    assert_eq!(before, 3);
    let unavailable = client
        .call(get_call("/internal/checkout/pay/b"))
        .await
        .expect_err("ejected");
    assert_eq!(unavailable.code(), "CORE_UNAVAILABLE");
    assert_eq!(core.count(), before);

    available.store(true, Ordering::SeqCst);
    now.fetch_add(5_000, Ordering::SeqCst);
    let probe = client
        .call(get_call("/internal/checkout/pay/c"))
        .await
        .expect("probe");
    assert_eq!(probe.status, 200);
    assert_eq!(core.count(), before + 1);
    let recovered = client
        .call(get_call("/internal/checkout/pay/d"))
        .await
        .expect("recovered");
    assert_eq!(recovered.status, 200);
    assert_eq!(core.count(), before + 2);
}

#[ntex::test]
async fn reports_core_unavailable_when_every_node_is_down() {
    let core = MockTransport::new(|_| {
        MockReply::Fail(CoreTransportError::new(
            TransportFailure::ConnectionRefused,
            true,
        ))
    });
    let client = client(
        &["https://a.test", "https://b.test"],
        core.clone(),
        fixed_clock(),
    );
    let mut last = None;
    for _ in 0..3 {
        last = Some(
            client
                .call(get_call("/internal/checkout/pay/a"))
                .await
                .expect_err("down"),
        );
    }
    let error = last.expect("error");
    assert_eq!(error.code(), "CORE_UNAVAILABLE");
    assert_eq!(error.status(), 503);
}

#[ntex::test]
async fn framing_headers_are_stripped_and_content_length_is_recomputed() {
    let core = MockTransport::new(|_| MockReply::ok(json!({})));
    let client = client(&["https://only.test"], core.clone(), fixed_clock());
    let body = br#"{"decompressed":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#.to_vec();
    let call = CoreCall::new(Plane::Live, CoreMethod::Post, "/internal/checkout/inbound")
        .with_identity("r", "10.0.0.1", "ua")
        .with_body(body.clone())
        .with_headers(vec![
            ("Content-Length".to_owned(), "20".to_owned()),
            ("Transfer-Encoding".to_owned(), "chunked".to_owned()),
            ("Content-Encoding".to_owned(), "gzip".to_owned()),
            ("Connection".to_owned(), "upgrade".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ]);
    let response = client.call(call).await.expect("call");
    assert_eq!(response.status, 200);
    let seen = core.last().expect("recorded");
    assert_eq!(
        seen.header("content-length"),
        Some(body.len().to_string().as_str())
    );
    assert!(seen.header("transfer-encoding").is_none());
    assert!(seen.header("content-encoding").is_none());
    assert!(seen.header("connection").is_none());
    assert_eq!(seen.body, body);
}

#[ntex::test]
async fn x_pg_min_lsn_is_forwarded_when_declared() {
    let core = MockTransport::new(|_| MockReply::ok(json!({})));
    let client = client(&["https://only.test"], core.clone(), fixed_clock());
    let call = get_call("/internal/checkout/pay/a").with_min_lsn("0/16B6C50");
    client.call(call).await.expect("call");
    assert_eq!(
        core.last().expect("recorded").header("x-pg-min-lsn"),
        Some("0/16B6C50")
    );
    assert_eq!(
        consistency_header(Some("0/16B6C50")),
        vec![("x-pg-min-lsn".to_owned(), "0/16B6C50".to_owned())]
    );
    assert!(consistency_header(None).is_empty());
    assert!(consistency_header(Some("   ")).is_empty());
}

#[ntex::test]
async fn a_header_with_control_characters_is_rejected_before_dispatch() {
    let core = MockTransport::new(|_| MockReply::ok(json!({})));
    let client = client(&["https://only.test"], core.clone(), fixed_clock());
    let call = get_call("/internal/checkout/pay/a")
        .with_headers(vec![("x-test".to_owned(), "a\u{1}b".to_owned())]);
    let failure = client.call(call).await.expect_err("header invalid");
    assert_eq!(failure.status(), 400);
    assert_eq!(failure.code(), "CORE_HEADER_INVALID");
    assert_eq!(core.count(), 0);
    // The breaker is untouched: the next valid call reaches core.
    let valid = client
        .call(get_call("/internal/checkout/pay/b"))
        .await
        .expect("valid");
    assert_eq!(valid.status, 200);
}

#[test]
fn path_confinement_matches_the_checkout_channel() {
    assert_eq!(
        assert_core_path(EdgeChannel::Checkout, "/internal/checkout/pay/ABC").expect("inside"),
        "/internal/checkout/pay/ABC"
    );
    for path in [
        "/internal/other/channel",
        "https://evil.example/x",
        "//evil.example/x",
        "/internal/checkout/../other",
        "/internal/checkout/%2e%2e/other",
        "/internal/checkout\\other",
        "internal/admin/relative",
    ] {
        assert!(
            assert_core_path(EdgeChannel::Checkout, path).is_err(),
            "{path}"
        );
    }
    let error =
        assert_core_path(EdgeChannel::Checkout, "/internal/admin/users").expect_err("channel");
    assert_eq!(error.code(), "CORE_CHANNEL_VIOLATION");
    assert_eq!(error.status(), 403);
}

#[ntex::test]
async fn stream_fails_over_to_a_healthy_node() {
    let core = MockTransport::new(|call| {
        if call.node == "https://failing.test" {
            MockReply::json(503, json!({ "code": "UNAVAILABLE" }))
        } else {
            MockReply::Stream {
                status: 200,
                headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
                chunks: vec![b"data: {\"node\":\"recovered\"}\n\n".to_vec()],
            }
        }
    });
    let client = client(
        &["https://failing.test", "https://streaming.test"],
        core.clone(),
        fixed_clock(),
    );
    let stream = client
        .open_stream(
            CoreCall::new(
                Plane::Live,
                CoreMethod::Get,
                "/internal/checkout/pay/a/logs/x/status",
            )
            .with_identity("r", "10.0.0.7", "ua")
            .with_timeout(Duration::from_secs(5)),
        )
        .await
        .expect("stream");
    assert_eq!(stream.status, 200);
    match stream.body {
        checkout_edge::core::StreamBody::Live(mut body) => {
            use futures_util::StreamExt;
            let chunk = body.next().await.expect("chunk").expect("ok");
            assert!(String::from_utf8_lossy(&chunk).contains("recovered"));
        }
        other => panic!("expected a live stream, got {other:?}"),
    }
    assert_eq!(core.count(), 2);
}

#[test]
fn transport_errors_map_to_the_ts_codes() {
    assert_eq!(
        PoolError::from_transport(TransportFailure::Timeout).status(),
        504
    );
    assert_eq!(
        PoolError::from_transport(TransportFailure::Timeout).code(),
        "CORE_TIMEOUT"
    );
    assert_eq!(
        PoolError::from_transport(TransportFailure::ConnectionRefused).code(),
        "CORE_UNREACHABLE"
    );
    assert_eq!(
        PoolError::from_transport(TransportFailure::Dns).code(),
        "CORE_DNS_FAILURE"
    );
    assert_eq!(
        PoolError::from_transport(TransportFailure::Tls).code(),
        "CORE_TLS_ERROR"
    );
    assert_eq!(
        PoolError::from_transport(TransportFailure::Other).code(),
        "CORE_CONNECTION_ERROR"
    );
}

#[test]
fn header_identity_and_unknown_environments() {
    // `translateInboundEnvironment` is used by both the route and the pool selection.
    assert_eq!(
        translate_inbound_environment("live")
            .expect("live")
            .as_str(),
        "LIVE"
    );
    assert_eq!(
        translate_inbound_environment("uat").expect("uat").as_str(),
        "SANDBOX"
    );
    // Log helpers never print a capability segment or a payer secret.
    assert!(!redact_url("/api/v1/pay/LNKOKAY0001/logs/att_123/status").contains("LNKOKAY0001"));
    assert_eq!(
        redact_secrets(&json!({ "authorization": "Bearer abc", "note": "ok" }))["authorization"],
        json!("[REDACTED]")
    );
}

#[test]
fn reqwest_transport_builds_with_the_internal_client_certificate() {
    // `reqwest` is built with `rustls-no-provider`; this is the regression test for the ring
    // provider install. rcgen writes a throwaway CA + client certificate.
    pg_mtls::install_crypto_provider();
    let dir = tempfile::tempdir().expect("tempdir");
    let ca = rcgen::generate_simple_self_signed(vec!["internal-ca".to_owned()]).expect("ca");
    let client =
        rcgen::generate_simple_self_signed(vec!["checkout-back".to_owned()]).expect("client");
    let ca_path = dir.path().join("ca.crt");
    let cert_path = dir.path().join("client.crt");
    let key_path = dir.path().join("client.key");
    std::fs::write(&ca_path, ca.cert.pem()).expect("ca pem");
    std::fs::write(&cert_path, client.cert.pem()).expect("client pem");
    std::fs::write(&key_path, client.signing_key.serialize_pem()).expect("key pem");
    let paths = ClientTlsPaths {
        ca_cert: ca_path,
        client_cert: cert_path,
        client_key: key_path,
    };
    ReqwestTransport::new(&paths, Duration::from_secs(5)).expect("reqwest client");
}

#[test]
fn resolved_urls_are_pinned_to_the_configured_core_origin() {
    let url = resolve_core_url(
        EdgeChannel::Checkout,
        "https://core-back.internal:4000",
        "/internal/checkout/pay/ABC",
        &[("attempt".to_owned(), QueryValue::Text("a1".to_owned()))],
    )
    .expect("url");
    assert_eq!(
        url.origin().ascii_serialization(),
        "https://core-back.internal:4000"
    );
    assert_eq!(url.path(), "/internal/checkout/pay/ABC");
    assert_eq!(url.query(), Some("attempt=a1"));
    assert!(resolve_core_url(
        EdgeChannel::Checkout,
        "https://core-back.internal:4000",
        "/internal/admin/users",
        &[],
    )
    .is_err());
}

#[test]
fn request_headers_carry_identity_and_never_a_caller_authorization() {
    let headers = build_core_headers(
        &[
            ("x-edge-service", "core-back"),
            ("authorization", "Bearer evil"),
        ],
        &CoreRequestMeta {
            channel: EdgeChannel::Checkout,
            plane: Plane::Live,
            request_id: "req-1",
            client_ip: "203.0.113.9",
            user_agent: Some("checkout-front/1.0"),
            authorization: None,
            body_present: true,
            raw_content_type: None,
            min_lsn: None,
            idempotency_key: None,
        },
    )
    .expect("headers");
    assert_eq!(headers.get("x-request-id"), Some("req-1"));
    assert_eq!(headers.get("x-real-client-ip"), Some("203.0.113.9"));
    assert_eq!(
        headers.get("x-client-user-agent"),
        Some("checkout-front/1.0")
    );
    assert_eq!(headers.get("x-edge-service"), Some("checkout-back"));
    assert_eq!(headers.get("content-type"), Some("application/json"));
    assert!(!headers.contains("authorization"));
}
