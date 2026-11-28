//! Executor integration tests against a local HTTP/HTTPS server.
//!
//! Every test drives the real `EgressClient`: target validation, DNS pinning, authentication, the
//! token cache and the response handling. Assertions are made on what the server actually received.

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;

use pg_egress::body::{MultipartBody, RequestBody};
use pg_egress::credentials::{AuthError, GatewayAuthConfig, GatewayCredentials};
use pg_egress::executor::{
    CallContext, EgressClient, EgressConfig, EgressRequest, RetryPolicy, SideEffect,
};
use pg_egress::target::{EgressPolicy, HostAllowlist, Resolver, StaticResolver};
use pg_egress::token_cache::TokenKey;
use pg_egress::ApiConsumerAuth;

use support::{handler, ManualClock, TestPki, TestResponse, TestServer, TEST_HOST};

fn policy_for(server: &TestServer) -> EgressPolicy {
    let mut policy = EgressPolicy::new(HostAllowlist::new(&[TEST_HOST])).with_private_hosts();
    policy.allow_insecure_http = true;
    policy.extra_ports.push(server.port);
    policy
}

fn client_for(server: &TestServer) -> EgressClient {
    client_with(server, policy_for(server))
}

fn client_with(server: &TestServer, policy: EgressPolicy) -> EgressClient {
    let resolver: Arc<dyn Resolver + Send + Sync> =
        Arc::new(StaticResolver::new().with(TEST_HOST, &[server.address()]));
    EgressClient::new(EgressConfig::new(policy, resolver).with_timeouts(
        Duration::from_secs(2),
        Duration::from_secs(5),
        Duration::from_secs(5),
    ))
    .expect("egress client")
}

fn context<'a>(
    auth: &'a GatewayAuthConfig,
    credentials: &'a GatewayCredentials,
) -> CallContext<'a> {
    CallContext::new(
        auth,
        credentials,
        TokenKey::new("gw-test", "cs-test", "SANDBOX"),
    )
}

fn ok_json() -> TestResponse {
    TestResponse::json(200, &serde_json::json!({ "ok": true }))
}

fn echo_handler() -> support::Handler {
    handler(|_request| ok_json())
}

fn json_notes(value: &serde_json::Value) -> String {
    value.to_string()
}

#[tokio::test]
async fn none_api_key_permanent_token_and_basic_reach_the_gateway() {
    let server = TestServer::http(echo_handler()).await;
    let client = client_for(&server);
    let credentials = GatewayCredentials::from_pairs([
        ("apiKey", "key-123"),
        ("token", "tok-1"),
        ("username", "user"),
        ("password", "pass"),
    ]);

    // NONE: no credential headers at all.
    let auth = GatewayAuthConfig::none();
    let response = client
        .request(
            &context(&auth, &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/ping")),
        )
        .await
        .expect("none");
    assert_eq!(response.status, 200);
    assert!(response.ok);
    assert_eq!(
        response.json(),
        Some(&serde_json::json!({ "ok": true })),
        "a JSON response is parsed when the content type says so"
    );
    let captured = &server.requests()[0];
    assert_eq!(captured.method, "GET");
    assert_eq!(captured.path, "/ping");
    assert!(captured.header("authorization").is_none());
    assert!(captured.header("x-api-key").is_none());
    assert_eq!(
        captured.header("host"),
        Some(format!("{TEST_HOST}:{}", server.port).as_str())
    );

    // API_KEY header.
    let auth = GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("api key"));
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/ping")),
        )
        .await
        .expect("api key");
    assert_eq!(
        server.requests()[1].header("x-api-key"),
        Some("key-123"),
        "the default API key header is X-API-KEY"
    );

    // PERMANENT_TOKEN.
    let auth = GatewayAuthConfig::new(ApiConsumerAuth::PermanentToken);
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/ping")),
        )
        .await
        .expect("permanent");
    assert_eq!(
        server.requests()[2].header("authorization"),
        Some("Bearer tok-1")
    );

    // BASIC.
    let auth = GatewayAuthConfig::new(ApiConsumerAuth::Basic);
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/ping")),
        )
        .await
        .expect("basic");
    assert_eq!(
        server.requests()[3].header("authorization"),
        Some("Basic dXNlcjpwYXNz")
    );

    // A missing credential fails before a request is sent.
    let auth = GatewayAuthConfig::new(ApiConsumerAuth::ApiKey {
        placement: pg_egress::AuthPlacement::Header,
    });
    let error = client
        .request(
            &context(&auth, &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/ping")),
        )
        .await
        .expect_err("missing api key");
    assert_eq!(error.code(), "API_KEY_CREDENTIAL_MISSING");
    assert_eq!(server.request_count(), 4, "the failed call sent nothing");
}

#[tokio::test]
async fn api_key_can_travel_in_the_query_or_the_structured_body() {
    let server = TestServer::http(echo_handler()).await;
    let client = client_for(&server);
    let credentials = GatewayCredentials::from_pairs([("apiKey", "key-123")]);

    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("api key"));
    auth.placement = pg_egress::AuthPlacement::Query;
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")).with_query("amount", "1.00 LYD"),
        )
        .await
        .expect("query auth");
    let captured = &server.requests()[0];
    assert_eq!(captured.path, "/pay?amount=1.00%20LYD&api_key=key-123");

    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("api key"));
    auth.placement = pg_egress::AuthPlacement::Body;
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/pay"))
                .with_body(RequestBody::Json(serde_json::json!({ "amount": "1.00" }))),
        )
        .await
        .expect("body auth");
    let captured = &server.requests()[1];
    let body: serde_json::Value = serde_json::from_slice(&captured.body).expect("json body");
    assert_eq!(
        body,
        serde_json::json!({ "amount": "1.00", "api_key": "key-123" })
    );
    assert_eq!(captured.header("content-type"), Some("application/json"));

    // A multipart body is refused instead of silently dropping the key.
    let error = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/pay"))
                .with_body(RequestBody::Multipart(MultipartBody::new().field("a", "b"))),
        )
        .await
        .expect_err("multipart body placement");
    assert_eq!(error.code(), "API_BODY_PLACEMENT_UNSUPPORTED");
    assert_eq!(server.request_count(), 2);
}

#[tokio::test]
async fn request_signature_is_the_golden_hmac_of_the_timestamp_and_body() {
    let server = TestServer::http(echo_handler()).await;
    let clock = ManualClock::new(1_700_000_000_000);
    let client = client_for(&server).with_clock(clock.as_clock());
    let credentials = GatewayCredentials::from_pairs([("secret", "signing-secret")]);
    let auth =
        GatewayAuthConfig::new(ApiConsumerAuth::parse("REQUEST_SIGNATURE").expect("signature"));
    let body = RequestBody::Json(serde_json::json!({
        "amount": "1.00",
        "currency": "LYD"
    }));

    let response = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/pay")).with_body(body.clone()),
        )
        .await
        .expect("signed");
    assert!(response.ok);

    let captured = &server.requests()[0];
    assert_eq!(
        captured.text(),
        json_notes(&serde_json::json!({ "amount": "1.00", "currency": "LYD" }))
    );
    assert_eq!(captured.header("x-timestamp"), Some("1700000000"));
    assert_eq!(
        captured.header("x-signature"),
        Some("28b2dce66e018fd385efabd6d59266e44c151602886d3a2b02748b3fdf4f46f0"),
        "HMAC-SHA256 over the timestamp, a dot and the exact JSON body"
    );

    // A custom signature header and HMAC-SHA512 follow the same payload.
    let mut auth = auth.clone();
    auth.signature_header = Some("X-Sig".to_owned());
    auth.timestamp_header = Some("X-Ts".to_owned());
    auth.signature_algorithm = pg_egress::SignatureAlgorithm::HmacSha512;
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/pay")).with_body(body),
        )
        .await
        .expect("signed 512");
    let captured = &server.requests()[1];
    assert_eq!(captured.header("x-ts"), Some("1700000000"));
    assert_eq!(
        captured.header("x-sig"),
        Some(
            "05a163c79624423464ad53f1da950f5581add74d2f7f8f104bf410568b18937977e17a8fb245add033c25ddbb249e258\
ec2ae54cdbc827e221168803b7a86fda"
        )
    );
    assert!(captured.header("x-signature").is_none());
}

#[tokio::test]
async fn oauth2_client_credentials_reuses_the_cached_token() {
    let token_calls = Arc::new(AtomicUsize::new(0));
    let pay_calls = Arc::new(AtomicUsize::new(0));
    let token_counter = token_calls.clone();
    let pay_counter = pay_calls.clone();
    let server = TestServer::http(handler(move |request| {
        if request.path.starts_with("/token") {
            token_counter.fetch_add(1, Ordering::SeqCst);
            return TestResponse::json(
                200,
                &serde_json::json!({ "access_token": "tok-1", "expires_in": 3600, "token_type": "Bearer" }),
            );
        }
        pay_counter.fetch_add(1, Ordering::SeqCst);
        ok_json()
    }))
    .await;
    let clock = ManualClock::new(1_700_000_000_000);
    let client = client_for(&server).with_clock(clock.as_clock());
    let credentials =
        GatewayCredentials::from_pairs([("clientId", "client-1"), ("clientSecret", "secret-1")]);
    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::OAuth2ClientCredentials);
    auth.token_endpoint = Some(server.url("/token"));

    for _ in 0..2 {
        client
            .request(
                &context(&auth, &credentials),
                EgressRequest::new(Method::GET, server.url("/pay")),
            )
            .await
            .expect("call");
        clock.advance(10_000);
    }
    assert_eq!(token_calls.load(Ordering::SeqCst), 1, "the token is cached");
    assert_eq!(pay_calls.load(Ordering::SeqCst), 2);
    let requests = server.requests();
    let token_request = requests
        .iter()
        .find(|request| request.path == "/token")
        .expect("token request");
    assert_eq!(
        token_request.text(),
        "grant_type=client_credentials&client_id=client-1&client_secret=secret-1"
    );
    assert_eq!(
        token_request.header("authorization"),
        Some("Basic Y2xpZW50LTE6c2VjcmV0LTE="),
        "a client id and secret are also sent as HTTP Basic"
    );
    assert_eq!(
        token_request.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    for request in requests.iter().filter(|request| request.path == "/pay") {
        assert_eq!(request.header("authorization"), Some("Bearer tok-1"));
    }
}

#[tokio::test]
async fn a_401_refreshes_the_token_exactly_once() {
    let token_calls = Arc::new(AtomicUsize::new(0));
    let token_counter = token_calls.clone();
    let server = TestServer::http(handler(move |request| {
        if request.path.starts_with("/token") {
            let issued = token_counter.fetch_add(1, Ordering::SeqCst) + 1;
            return TestResponse::json(
                200,
                &serde_json::json!({ "access_token": format!("tok-{issued}"), "expires_in": 3600 }),
            );
        }
        if request.header("authorization") == Some("Bearer tok-1") {
            return TestResponse::json(401, &serde_json::json!({ "error": "expired" }));
        }
        ok_json()
    }))
    .await;
    let clock = ManualClock::new(1_700_000_000_000);
    let client = client_for(&server).with_clock(clock.as_clock());
    let credentials = GatewayCredentials::new();
    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::TokenEndpoint);
    auth.token_endpoint = Some(server.url("/token"));

    let response = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect("refreshed");
    assert_eq!(response.status, 200);
    assert_eq!(token_calls.load(Ordering::SeqCst), 2);
    let pay: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/pay")
        .collect();
    assert_eq!(pay.len(), 2);
    assert_eq!(pay[0].header("authorization"), Some("Bearer tok-1"));
    assert_eq!(pay[1].header("authorization"), Some("Bearer tok-2"));
}

#[tokio::test]
async fn an_expiring_token_is_refreshed_before_it_is_reused() {
    let token_calls = Arc::new(AtomicUsize::new(0));
    let token_counter = token_calls.clone();
    let server = TestServer::http(handler({
        let token_counter = token_counter.clone();
        move |request| {
            if request.path.starts_with("/token") {
                let issued = token_counter.fetch_add(1, Ordering::SeqCst) + 1;
                return TestResponse::json(
                    200,
                    &serde_json::json!({ "access_token": format!("tok-{issued}"), "expires_in": 100 }),
                );
            }
            ok_json()
        }
    }))
    .await;
    let clock = ManualClock::new(1_700_000_000_000);
    let client = client_for(&server).with_clock(clock.as_clock());
    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::OAuth2ClientCredentials);
    auth.token_endpoint = Some(server.url("/token"));
    let credentials = GatewayCredentials::new();

    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect("first");
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);
    // 100 s token, 30 s TS margin: at 71 s the token is stale.
    clock.advance(71_000);
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect("second");
    assert_eq!(token_calls.load(Ordering::SeqCst), 2);
    let pay: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/pay")
        .collect();
    assert_eq!(pay[1].header("authorization"), Some("Bearer tok-2"));
}

#[tokio::test]
async fn a_redirect_is_refused_and_never_followed() {
    let server = TestServer::http(handler(|_request| {
        TestResponse::empty(302).with_header("location", "https://evil.example/")
    }))
    .await;
    let client = client_for(&server);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect_err("redirect");
    assert_eq!(error.code(), "API_REDIRECT_FORBIDDEN");
    assert_eq!(error.status(), Some(302));
    assert_eq!(
        server.request_count(),
        1,
        "the target was contacted exactly once"
    );
}

#[tokio::test]
async fn a_private_destination_is_refused_before_any_connection() {
    let server = TestServer::http(echo_handler()).await;
    // Same allowlist and port, but the Fake Rails private-host relaxation is not set.
    let mut policy = EgressPolicy::new(HostAllowlist::new(&[TEST_HOST]));
    policy.allow_insecure_http = true;
    policy.extra_ports.push(server.port);
    let client = client_with(&server, policy);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect_err("private host");
    assert_eq!(error.code(), "PRIVATE_HOST");
    assert_eq!(server.request_count(), 0);

    // A host outside the allowlist fails closed too.
    let mut policy = EgressPolicy::new(HostAllowlist::new(&["other.test"])).with_private_hosts();
    policy.allow_insecure_http = true;
    policy.extra_ports.push(server.port);
    let client = client_with(&server, policy);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect_err("not allowed");
    assert_eq!(error.code(), "HOST_NOT_ALLOWED");
    assert_eq!(server.request_count(), 0);
}

#[tokio::test]
async fn an_answer_above_the_response_cap_is_refused() {
    let server = TestServer::http(handler(|_request| {
        TestResponse::text(200, "text/plain", "x".repeat(4096))
    }))
    .await;
    let mut policy = policy_for(&server);
    policy.max_response_bytes = 1024;
    let client = client_with(&server, policy);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect_err("cap");
    assert_eq!(error.code(), "API_RESPONSE_TOO_LARGE");
    assert_eq!(error.status(), Some(200));
}

#[tokio::test]
async fn a_streamed_answer_is_cut_at_the_cap_even_without_a_content_length() {
    let server = TestServer::http(handler(|_request| {
        TestResponse::text(200, "text/plain", "y".repeat(4096)).chunked()
    }))
    .await;
    let mut policy = policy_for(&server);
    policy.max_response_bytes = 1024;
    let client = client_with(&server, policy);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/stream")),
        )
        .await
        .expect_err("streamed cap");
    assert_eq!(error.code(), "API_RESPONSE_TOO_LARGE");
    assert_eq!(error.status(), Some(200));

    // A chunked answer under the cap is read completely.
    let small = TestServer::http(handler(|_request| {
        TestResponse::text(200, "text/plain", "ok".repeat(10)).chunked()
    }))
    .await;
    let client = client_for(&small);
    let response = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, small.url("/stream")),
        )
        .await
        .expect("chunked");
    assert_eq!(response.raw_text.len(), 20);
}

#[tokio::test]
async fn a_slow_gateway_times_out() {
    let server = TestServer::http(handler(|_request| {
        ok_json().with_delay(Duration::from_millis(400))
    }))
    .await;
    let client = client_for(&server);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/pay"))
                .with_timeout(Duration::from_millis(80)),
        )
        .await
        .expect_err("timeout");
    assert_eq!(error.code(), "API_TIMEOUT");
    assert!(error.retryable());
    assert!(
        !error.money_uncertain(),
        "a read-only call has no money risk"
    );
}

#[tokio::test]
async fn a_five_hundred_is_retried_only_when_the_side_effect_is_safe() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let server = TestServer::http(handler(move |_request| {
        if counter.fetch_add(1, Ordering::SeqCst) == 0 {
            return TestResponse::json(503, &serde_json::json!({ "retry": true }));
        }
        ok_json()
    }))
    .await;
    let client = client_for(&server);
    let read_only = EgressRequest::new(Method::GET, server.url("/pay"))
        .with_retry_policy(RetryPolicy::Safe)
        .with_retry_delay(Duration::ZERO);
    client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            read_only,
        )
        .await
        .expect("retried");
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    // A money-moving call is never replayed: the first answer is the result.
    calls.store(0, Ordering::SeqCst);
    let money = EgressRequest::new(Method::POST, server.url("/pay"))
        .with_side_effect(SideEffect::MovesMoney)
        .with_retry_policy(RetryPolicy::Safe);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            money,
        )
        .await
        .expect_err("no replay");
    assert_eq!(error.code(), "API_HTTP_ERROR");
    assert_eq!(error.status(), Some(503));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn xml_dtd_json_depth_and_non_json_bodies_are_handled() {
    let server = TestServer::http(handler(|request| match request.path.as_str() {
        "/dtd" => TestResponse::text(
            200,
            "application/xml",
            "<!DOCTYPE x [<!ENTITY e \"y\">]><x/>",
        ),
        "/deep" => TestResponse::json(
            200,
            &serde_json::json!({ "a": { "b": { "c": { "d": 1 } } } }),
        ),
        "/plain" => TestResponse::text(200, "text/plain", "hello"),
        _ => ok_json(),
    }))
    .await;
    let mut policy = policy_for(&server);
    policy.max_response_bytes = 8192;
    let resolver: Arc<dyn Resolver + Send + Sync> =
        Arc::new(StaticResolver::new().with(TEST_HOST, &[server.address()]));
    let client = EgressClient::new(EgressConfig::new(policy, resolver).with_max_json_depth(2))
        .expect("client");
    let auth = GatewayAuthConfig::none();
    let credentials = GatewayCredentials::new();

    let error = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/dtd")),
        )
        .await
        .expect_err("dtd");
    assert_eq!(error.code(), "API_XML_DTD_FORBIDDEN");

    let error = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/deep")),
        )
        .await
        .expect_err("depth");
    assert_eq!(error.code(), "API_JSON_DEPTH_EXCEEDED");
    assert_eq!(error.status(), Some(200));
    assert!(error.raw_text().is_some());

    let response = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/plain")),
        )
        .await
        .expect("plain");
    assert_eq!(response.raw_text, "hello");
    assert_eq!(response.data, serde_json::Value::String("hello".to_owned()));
    assert!(response.json().is_none());
}

#[tokio::test]
async fn bodies_keep_their_content_types_and_get_drops_them() {
    let server = TestServer::http(echo_handler()).await;
    let client = client_for(&server);
    let auth = GatewayAuthConfig::none();
    let credentials = GatewayCredentials::new();

    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/form"))
                .with_body(RequestBody::form([("amount", "1.00"), ("memo", "a b+c")])),
        )
        .await
        .expect("form");
    let captured = &server.requests()[0];
    assert_eq!(
        captured.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(captured.text(), "amount=1.00&memo=a+b%2Bc");

    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/xml")).with_body(RequestBody::Xml(
                "<pay><amount>1.00</amount></pay>".to_owned(),
            )),
        )
        .await
        .expect("xml");
    let captured = &server.requests()[1];
    assert_eq!(captured.header("content-type"), Some("application/xml"));
    assert_eq!(captured.text(), "<pay><amount>1.00</amount></pay>");

    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/text"))
                .with_body(RequestBody::Text("hello".to_owned())),
        )
        .await
        .expect("text");
    assert_eq!(
        server.requests()[2].header("content-type"),
        Some("text/plain; charset=utf-8")
    );

    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::POST, server.url("/multipart")).with_body(
                RequestBody::Multipart(MultipartBody::new().field("amount", "1.00").file(
                    "receipt",
                    "r.txt",
                    "text/plain",
                    b"proof".to_vec(),
                )),
            ),
        )
        .await
        .expect("multipart");
    let captured = &server.requests()[3];
    let content_type = captured.header("content-type").expect("multipart type");
    assert!(content_type.starts_with("multipart/form-data; boundary=----pgw"));
    let text = captured.text();
    assert!(text.contains("name=\"amount\"\r\n\r\n1.00\r\n"));
    assert!(text.contains("filename=\"r.txt\"\r\ncontent-type: text/plain\r\n\r\nproof\r\n"));

    // TS drops the body for GET and DELETE.
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/get"))
                .with_body(RequestBody::Json(serde_json::json!({ "ignored": true }))),
        )
        .await
        .expect("get");
    let captured = &server.requests()[4];
    assert!(captured.body.is_empty());
    assert!(captured.header("content-type").is_none());
}

#[tokio::test]
async fn https_uses_the_configured_root_and_keeps_the_host_and_sni() {
    let pki = TestPki::generate(TEST_HOST);
    let server = TestServer::https(echo_handler(), &pki, false).await;
    let mut policy = policy_for(&server);
    policy.allow_insecure_http = false;
    let resolver: Arc<dyn Resolver + Send + Sync> =
        Arc::new(StaticResolver::new().with(TEST_HOST, &[server.address()]));
    let client =
        EgressClient::new(EgressConfig::new(policy, resolver).with_trust_root(pki.ca_pem.clone()))
            .expect("client");

    let response = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/tls")),
        )
        .await
        .expect("https");
    assert_eq!(response.status, 200);
    let captured = &server.requests()[0];
    assert_eq!(
        captured.header("host"),
        Some(format!("{TEST_HOST}:{}", server.port).as_str()),
        "the pinned connection still presents the real host"
    );

    // An untrusted certificate is refused by TLS.
    let untrusted = EgressClient::new(EgressConfig::new(
        policy_for(&server),
        Arc::new(StaticResolver::new().with(TEST_HOST, &[server.address()])),
    ))
    .expect("client");
    let error = untrusted
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/tls")),
        )
        .await
        .expect_err("untrusted");
    assert_eq!(error.code(), "API_NETWORK_ERROR");
}

#[tokio::test]
async fn mutual_tls_presents_the_per_credential_client_certificate() {
    let pki = TestPki::generate(TEST_HOST);
    let server = TestServer::https(echo_handler(), &pki, true).await;
    let mut policy = policy_for(&server);
    policy.allow_insecure_http = false;
    let resolver: Arc<dyn Resolver + Send + Sync> =
        Arc::new(StaticResolver::new().with(TEST_HOST, &[server.address()]));
    let client = EgressClient::new(EgressConfig::new(policy.clone(), resolver)).expect("client");
    let credentials = GatewayCredentials::from_pairs(pki.client_credentials());
    let auth = GatewayAuthConfig::new(ApiConsumerAuth::MutualTls);

    let response = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/mtls")),
        )
        .await
        .expect("mutual tls");
    assert_eq!(response.status, 200);
    assert!(
        server.saw_client_certificate(),
        "the server verified a client certificate"
    );

    // The client certificate is mandatory: without it the handshake fails.
    let anonymous = GatewayCredentials::new();
    let error = client
        .request(
            &context(&auth, &anonymous),
            EgressRequest::new(Method::GET, server.url("/mtls")),
        )
        .await
        .expect_err("material missing");
    assert_eq!(error.code(), "API_MUTUAL_TLS_MATERIAL_MISSING");

    // With credentials but a client that does not trust the CA, TLS fails.
    let credentials_without_ca = GatewayCredentials::from_pairs([
        ("certificate", pki.client_cert_pem.clone()),
        ("privateKey", pki.client_key_pem.clone()),
    ]);
    let no_trust = EgressClient::new(EgressConfig::new(
        policy,
        Arc::new(StaticResolver::new().with(TEST_HOST, &[server.address()])),
    ))
    .expect("client");
    let error = no_trust
        .request(
            &context(&auth, &credentials_without_ca),
            EgressRequest::new(Method::GET, server.url("/mtls")),
        )
        .await
        .expect_err("untrusted server");
    assert_eq!(error.code(), "API_NETWORK_ERROR");
}

#[tokio::test]
async fn a_client_error_is_returned_with_its_status_and_body() {
    let server = TestServer::http(handler(|_request| {
        TestResponse::json(
            422,
            &serde_json::json!({ "code": "INVALID_AMOUNT", "message": "too small" }),
        )
    }))
    .await;
    let client = client_for(&server);
    let error = client
        .request(
            &context(&GatewayAuthConfig::none(), &GatewayCredentials::new()),
            EgressRequest::new(Method::POST, server.url("/pay"))
                .with_body(RequestBody::Json(serde_json::json!({ "amount": "0.01" })))
                .with_retry_policy(RetryPolicy::Safe),
        )
        .await
        .expect_err("422");
    assert_eq!(error.code(), "API_HTTP_ERROR");
    assert_eq!(error.status(), Some(422));
    assert!(!error.retryable());
    assert_eq!(
        error.data(),
        Some(&serde_json::json!({ "code": "INVALID_AMOUNT", "message": "too small" }))
    );
    assert_eq!(server.request_count(), 1, "a 4xx is never retried");
}

#[tokio::test]
async fn a_refresh_token_grant_persists_the_rotated_token() {
    use pg_egress::executor::{RefreshTokenSink, RotatedRefreshToken};
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<RotatedRefreshToken>>);

    #[async_trait::async_trait]
    impl RefreshTokenSink for RecordingSink {
        async fn persist(
            &self,
            rotation: &RotatedRefreshToken,
        ) -> Result<(), pg_egress::GatewayError> {
            self.0.lock().expect("sink").push(rotation.clone());
            Ok(())
        }
    }

    let token_calls = Arc::new(AtomicUsize::new(0));
    let token_counter = token_calls.clone();
    let server = TestServer::http(handler(move |request| {
        if request.path.starts_with("/token") {
            let issued = token_counter.fetch_add(1, Ordering::SeqCst) + 1;
            return TestResponse::json(
                200,
                &serde_json::json!({
                    "access_token": format!("tok-{issued}"),
                    "new_refresh_token": format!("refresh-{issued}"),
                    "expires_in": 3600
                }),
            );
        }
        ok_json()
    }))
    .await;
    let clock = ManualClock::new(1_700_000_000_000);
    let sink = Arc::new(RecordingSink::default());
    let sink_view = sink.clone();
    let client = client_for(&server)
        .with_clock(clock.as_clock())
        .with_rotation_sink(sink_view);
    let credentials = GatewayCredentials::from_pairs([("refresh_token", "refresh-0")]);
    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::RefreshToken);
    auth.refresh_url = Some(server.url("/token"));

    let response = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect("refresh grant");
    assert_eq!(response.status, 200);
    let token_request = &server.requests()[0];
    assert_eq!(
        token_request.text(),
        "grant_type=refresh_token&refresh_token=refresh-0"
    );

    // A second call uses the cached access token, not the endpoint.
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect("cached");
    assert_eq!(token_calls.load(Ordering::SeqCst), 1);

    // Once the token expires the rotated refresh token is used.
    clock.advance(3_600_000);
    client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect("rotated");
    assert_eq!(token_calls.load(Ordering::SeqCst), 2);
    let token_requests: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/token")
        .collect();
    assert_eq!(
        token_requests[1].text(),
        "grant_type=refresh_token&refresh_token=refresh-1"
    );

    let rotations = sink.0.lock().expect("sink");
    assert_eq!(
        rotations.len(),
        2,
        "each issued refresh token is handed to the sink"
    );
    assert_eq!(rotations[0].refresh_token, "refresh-1");
    assert_eq!(rotations[0].selector, "refresh_token");
    assert_eq!(rotations[0].gateway_id, "gw-test");
    assert_eq!(rotations[0].credential_set_id, "cs-test");
    assert_eq!(rotations[0].environment, "SANDBOX");
    assert_eq!(rotations[1].refresh_token, "refresh-2");
    assert!(!format!("{:?}", rotations[0]).contains("refresh-1"));
}

#[tokio::test]
async fn a_token_endpoint_that_returns_no_access_token_is_an_error() {
    let server = TestServer::http(handler(|request| {
        if request.path.starts_with("/token") {
            return TestResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        ok_json()
    }))
    .await;
    let client = client_for(&server);
    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::OAuth2ClientCredentials);
    auth.token_endpoint = Some(server.url("/token"));
    let error = client
        .request(
            &context(&auth, &GatewayCredentials::new()),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect_err("missing token");
    assert_eq!(error.code(), "API_TOKEN_MISSING_IN_RESPONSE");
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn a_token_endpoint_is_required_for_token_methods() {
    let server = TestServer::http(echo_handler()).await;
    let client = client_for(&server);
    let credentials = GatewayCredentials::new();
    for method in [
        ApiConsumerAuth::TokenEndpoint,
        ApiConsumerAuth::OAuth2ClientCredentials,
        ApiConsumerAuth::UsernamePassword,
    ] {
        let auth = GatewayAuthConfig::new(method);
        let error = client
            .request(
                &context(&auth, &credentials),
                EgressRequest::new(Method::GET, server.url("/pay")),
            )
            .await
            .expect_err("no endpoint");
        assert_eq!(error.code(), "API_TOKEN_ENDPOINT_REQUIRED");
    }
    let auth = GatewayAuthConfig::new(ApiConsumerAuth::RefreshToken);
    let error = client
        .request(
            &context(&auth, &credentials),
            EgressRequest::new(Method::GET, server.url("/pay")),
        )
        .await
        .expect_err("no refresh url");
    assert_eq!(error.code(), "API_TOKEN_ENDPOINT_REQUIRED");
    assert_eq!(server.request_count(), 0);
}

#[test]
fn the_auth_error_codes_are_stable() {
    assert_eq!(
        AuthError::ApiKeyMissing.code(),
        "API_KEY_CREDENTIAL_MISSING"
    );
    assert_eq!(
        AuthError::TokenEndpointRequired {
            method: "TOKEN_ENDPOINT"
        }
        .code(),
        "API_TOKEN_ENDPOINT_REQUIRED"
    );
}
