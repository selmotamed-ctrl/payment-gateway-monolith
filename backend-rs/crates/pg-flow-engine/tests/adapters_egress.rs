//! Egress adapter tests against a local HTTP server.
//!
//! These do not need PostgreSQL: the pinned configuration is built directly with
//! [`BoundEgress::new`], and the request mapping is observed by a loopback server.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pg_egress::credentials::{GatewayAuthConfig, GatewayCredentials};
use pg_egress::executor::{EgressClient, EgressConfig};
use pg_egress::target::{EgressPolicy, HostAllowlist, SystemResolver};
use pg_egress::token_cache::TokenKey;
use pg_egress::{ApiConsumerAuth, AuthPlacement};
use pg_flow_engine::adapters::{BoundEgress, EgressAdapterConfig};
use pg_flow_engine::{EgressBody, EgressPort, EgressRequest, HttpMethod, RetryPolicy, SideEffect};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Recorded> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
    };
    let headers_text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(&buffer[header_end..header_end + length]).into_owned();
    Some(Recorded {
        method,
        path,
        headers,
        body,
    })
}

async fn start_server(expected: usize) -> (u16, Arc<Mutex<Vec<Recorded>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let records = Arc::new(Mutex::new(Vec::new()));
    let sink = records.clone();
    tokio::spawn(async move {
        for _ in 0..expected {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let Some(request) = read_request(&mut stream).await else {
                continue;
            };
            let body = if request.path.starts_with("/fail") {
                r#"{"error":"boom"}"#
            } else {
                r#"{"status":"SUCCESS"}"#
            };
            let status = if request.path.starts_with("/fail") {
                "500 Internal Server Error"
            } else {
                "200 OK"
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
            if let Ok(mut records) = sink.lock() {
                records.push(request);
            }
        }
    });
    (port, records)
}

fn client(port: u16) -> Arc<EgressClient> {
    let mut policy = EgressPolicy::new(HostAllowlist::new(&["127.0.0.1"]));
    policy.allow_insecure_http = true;
    policy.allow_private_hosts = true;
    policy.extra_ports = vec![port];
    let config = EgressConfig::new(policy, Arc::new(SystemResolver)).with_timeouts(
        Duration::from_millis(500),
        Duration::from_millis(2_000),
        Duration::from_millis(2_000),
    );
    Arc::new(EgressClient::new(config).expect("egress client"))
}

fn bound(port: u16) -> BoundEgress {
    let mut auth = GatewayAuthConfig::new(ApiConsumerAuth::ApiKey {
        placement: AuthPlacement::Header,
    });
    auth.header_name = Some("X-API-KEY".to_owned());
    let credentials = GatewayCredentials::from_pairs([("apiKey", "secret-key")]);
    BoundEgress::new(
        client(port),
        auth,
        credentials,
        TokenKey::new("gateway-1", "credential-1", "LIVE"),
        5_000,
        "attempt-1",
    )
}

fn request(
    port: u16,
    path: &str,
    body: Option<EgressBody>,
    side_effect: SideEffect,
) -> EgressRequest {
    EgressRequest {
        method: HttpMethod::Post,
        url: format!("http://127.0.0.1:{port}{path}"),
        headers: BTreeMap::new(),
        body,
        timeout_ms: 2_000,
        side_effect,
        retry_policy: RetryPolicy::Never,
        point_of_no_return: false,
    }
}

#[tokio::test]
async fn maps_a_json_answer_and_sends_the_api_key() {
    let (port, records) = start_server(2).await;
    let egress = bound(port);

    let response = egress
        .send(request(
            port,
            "/ok",
            Some(EgressBody::Json(
                serde_json::json!({"invoice_no": "ADAPTERS-1"}),
            )),
            SideEffect::ReadOnly,
        ))
        .await
        .expect("gateway answer");
    assert_eq!(response.status, 200);
    assert_eq!(response.data["status"], Value::String("SUCCESS".to_owned()));
    assert!(response.url.contains("/ok"));
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );

    let _ = egress
        .send(request(port, "/auth", None, SideEffect::ReadOnly))
        .await
        .expect("second answer");

    let recorded = records.lock().expect("records").clone();
    assert_eq!(recorded[0].method, "POST");
    assert_eq!(recorded[0].path, "/ok");
    assert_eq!(
        recorded[0].headers.get("x-api-key").map(String::as_str),
        Some("secret-key")
    );
    assert!(recorded[0].body.contains("ADAPTERS-1"));
}

#[tokio::test]
async fn returns_a_non_2xx_gateway_answer_instead_of_a_transport_error() {
    let (port, _records) = start_server(1).await;
    let egress = bound(port);
    let response = egress
        .send(request(port, "/fail", None, SideEffect::ReadOnly))
        .await
        .expect("a gateway answer is mapped, not thrown");
    assert_eq!(response.status, 500);
    assert_eq!(response.data["error"], Value::String("boom".to_owned()));
}

#[tokio::test]
async fn multipart_body_is_encoded_with_a_generated_boundary() {
    let (port, records) = start_server(1).await;
    let egress = bound(port);
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_owned(), "multipart/form-data".to_owned());
    let mut request = request(
        port,
        "/multipart",
        Some(EgressBody::Multipart(vec![(
            "MID".to_owned(),
            "MID-1".to_owned(),
        )])),
        SideEffect::SendsNotification,
    );
    request.headers = headers;
    let response = egress.send(request).await.expect("multipart answer");
    assert_eq!(response.status, 200);
    let recorded = records.lock().expect("records").clone();
    let content_type = recorded[0]
        .headers
        .get("content-type")
        .cloned()
        .unwrap_or_default();
    assert!(
        content_type.starts_with("multipart/form-data; boundary="),
        "the adapter must own the boundary, got {content_type}"
    );
    assert!(recorded[0].body.contains("name=\"MID\""));
    assert!(recorded[0].body.contains("MID-1"));
}

#[tokio::test]
async fn transport_failure_of_a_money_step_is_uncertain() {
    // Bind then drop so the port is closed.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let egress = bound(port);
    let error = egress
        .send(request(port, "/charge", None, SideEffect::MovesMoney))
        .await
        .expect_err("connection refused");
    assert!(error.retryable);
    assert!(error.money_uncertain);
    assert_eq!(error.status, None);
}

#[test]
fn adapter_config_defaults_are_fail_closed() {
    let config = EgressAdapterConfig::default();
    assert!(!config.allow_insecure_http);
    assert!(!config.allow_private_hosts);
    assert!(!config.allow_any_host);
    assert!(config.extra_ports.is_empty());
    assert!(config.trust_roots_pem.is_empty());
}
