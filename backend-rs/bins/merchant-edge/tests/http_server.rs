//! HTTP-level smoke tests of the ntex shell (body limits, upload preflight, security headers,
//! 404 body, JSON parsing) with a fake core behind the dispatcher.

use std::sync::Arc;
use std::time::Duration;

use merchant_edge::app::AppState;
use merchant_edge::config::EdgeConfig;
use merchant_edge::server::handle;
use merchant_edge::upstream::test_support::FakeCore;
use ntex::web::{self, App, HttpServer};
use serde_json::json;

struct TestServer {
    base: String,
    port: u16,
    core: FakeCore,
}

async fn start(cors: bool) -> TestServer {
    let core = FakeCore::new();
    let mut config = EdgeConfig::for_embedding(vec!["https://core.test".to_owned()], None);
    if cors {
        config.cors = pg_edge::CorsAllowList::from_csv(Some("https://portal.example.com"));
    }
    let state = Arc::new(AppState::new(
        config,
        Arc::new(core.clone()),
        "http-test".to_owned(),
        "commit".to_owned(),
    ));
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("port");
    let port = probe.local_addr().expect("addr").port();
    drop(probe);
    let server = HttpServer::new(async move |_| {
        let state = Arc::clone(&state);
        App::new().service(web::resource("/{tail}*").to(
            async move |req, payload: web::types::Payload| {
                handle(Arc::clone(&state), req, payload).await
            },
        ))
    })
    .workers(1)
    .bind(
        ("127.0.0.1", port),
        ntex::SharedCfg::new("merchant-edge-test"),
    )
    .expect("bind")
    .run();
    ntex::rt::spawn(server);
    ntex::time::sleep(ntex::time::Millis(120)).await;
    TestServer {
        base: format!("http://127.0.0.1:{port}"),
        port,
        core,
    }
}

/// Send only the request head (no body) and read the early response. This is how a browser with a
/// large upload behaves when the edge refuses the credential before buffering the file.
async fn head_only(port: u16, head: &str) -> String {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    stream.write_all(head.as_bytes()).await.expect("write");
    stream.shutdown().await.expect("shutdown");
    let mut output = Vec::new();
    stream.read_to_end(&mut output).await.expect("read");
    String::from_utf8_lossy(&output).into_owned()
}

fn client() -> reqwest::Client {
    pg_mtls::install_crypto_provider();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("client")
}

#[ntex::test]
async fn health_is_served_with_the_edge_headers() {
    let server = start(false).await;
    let response = client()
        .get(format!("{}/health", server.base))
        .send()
        .await
        .expect("health");
    assert_eq!(response.status(), 200);
    assert_eq!(
        response
            .headers()
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let payload: serde_json::Value = response.json().await.expect("json");
    assert_eq!(payload["service"], json!("merchant-back"));
}

#[ntex::test]
async fn unknown_routes_answer_the_express_404_body() {
    let server = start(false).await;
    let response = client()
        .get(format!("{}/api/v1/nope", server.base))
        .send()
        .await
        .expect("404");
    assert_eq!(response.status(), 404);
    let status = response.status();
    let headers = format!("{:?}", response.headers());
    let bytes = response.bytes().await.expect("bytes");
    assert!(!bytes.is_empty(), "status={status} headers={headers}");
    let payload: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(payload["code"], json!("NOT_FOUND"));
    assert_eq!(
        payload["message"],
        json!("No route matches GET /api/v1/nope")
    );
}

#[ntex::test]
async fn logs_in_through_the_real_http_stack() {
    let server = start(false).await;
    server
        .core
        .push_json(200, json!({ "token": "x", "userInfo": { "id": "u" } }));
    let response = client()
        .post(format!("{}/api/v1/merchant/auth/login", server.base))
        .json(&json!({ "identifier": "ops@example.com", "password": "secret" }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200);
    assert_eq!(
        server.core.last_call().expect("call").path,
        "/internal/merchant/auth/login"
    );
}

#[ntex::test]
async fn an_oversized_json_body_is_refused_before_auth() {
    let server = start(false).await;
    let response = head_only(
        server.port,
        "POST /api/v1/merchant/auth/login HTTP/1.1\r\nHost: edge.test\r\nContent-Type: application/json\r\nContent-Length: 2097169\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 413"), "{response}");
    assert_eq!(server.core.call_count(), 0);
}

#[ntex::test]
async fn uploads_are_refused_before_the_multipart_body_is_read() {
    let server = start(false).await;
    // No credential: the 401 must win over UPLOAD_INVALID / a 1.5 MB body.
    let response = head_only(
        server.port,
        "POST /api/v1/merchant/onboarding/kyb-documents HTTP/1.1\r\nHost: edge.test\r\nContent-Type: multipart/form-data; boundary=nope\r\nContent-Length: 1500000\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 401"), "{response}");
    assert_eq!(server.core.call_count(), 0);

    // A malformed session is refused before the declared length is even considered.
    let response = head_only(
        server.port,
        "POST /api/v1/merchant/onboarding/kyb-documents HTTP/1.1\r\nHost: edge.test\r\nContent-Type: multipart/form-data; boundary=nope\r\nAuthorization: Bearer x\r\nContent-Length: 1500000\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 401"), "{response}");
    assert_eq!(server.core.call_count(), 0);
}

#[ntex::test]
async fn cors_preflight_answers_only_for_configured_origins() {
    let server = start(true).await;
    let allowed = client()
        .request(reqwest::Method::OPTIONS, format!("{}/health", server.base))
        .header("origin", "https://portal.example.com")
        .header("access-control-request-method", "GET")
        .send()
        .await
        .expect("preflight");
    assert_eq!(allowed.status(), 204);
    assert_eq!(
        allowed
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("https://portal.example.com")
    );
    let other = client()
        .request(reqwest::Method::OPTIONS, format!("{}/health", server.base))
        .header("origin", "https://evil.example")
        .header("access-control-request-method", "GET")
        .send()
        .await
        .expect("preflight");
    assert!(other.headers().get("access-control-allow-origin").is_none());
}
