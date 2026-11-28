//! HTTP-level tests against the real ntex app with a fake core transport.
//!
//! These port the parts of `admin-back/test/*.test.ts` that do not need a live core:
//! `admin-ui-completion` forwarding and authority guards, `security-regressions` (LAN, limits,
//! headers, byte caps), `backups` (job limiter and relay), uploads and sandbox routing.

#![cfg(test)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use bytes::Bytes;
use ntex::http::StatusCode;
use ntex::web::{self, test, App, WebAppConfig};
use pg_upstream::HeaderSet;
use serde_json::{json, Value};

use crate::client::{CoreClient, CoreRequest, CoreResponse, NodeSender, SendError};
use crate::config::Config;
use crate::dispatch;

struct Recorded {
    node: String,
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: HeaderSet,
    body: Bytes,
}

#[derive(Default)]
struct FakeCore {
    requests: Mutex<Vec<Recorded>>,
    responses: Mutex<VecDeque<(u16, Value)>>,
}

impl FakeCore {
    fn enqueue(&self, status: u16, body: Value) {
        self.responses
            .lock()
            .expect("lock")
            .push_back((status, body));
    }

    fn requests(&self) -> Vec<Recorded> {
        let mut guard = self.requests.lock().expect("lock");
        std::mem::take(&mut *guard)
    }

    fn count(&self) -> usize {
        self.requests.lock().expect("lock").len()
    }
}

#[async_trait]
impl NodeSender for FakeCore {
    async fn send(
        &self,
        node: &str,
        request: &CoreRequest,
        _timeout: Duration,
    ) -> Result<CoreResponse, SendError> {
        let body = request.body.clone().unwrap_or_default();
        self.requests.lock().expect("lock").push(Recorded {
            node: node.to_owned(),
            method: request.method.as_str().to_owned(),
            path: request.path.clone(),
            query: request
                .query
                .iter()
                .map(|(key, value)| (key.clone(), value.as_text()))
                .collect(),
            headers: request.headers.clone(),
            body,
        });
        let (status, payload) = self
            .responses
            .lock()
            .expect("lock")
            .pop_front()
            .unwrap_or((200, json!({ "ok": true })));
        let mut headers = HeaderSet::new();
        headers.set("content-type", "application/json");
        headers.set("x-pg-served-by", "core-1");
        Ok(CoreResponse {
            status,
            headers,
            body: Bytes::from(serde_json::to_vec(&payload).unwrap_or_default()),
        })
    }
}

fn config(extra: &[(&str, &str)]) -> Config {
    let mut env = pg_config::Env::process()
        .with_value("CORE_BACK_URLS", "https://core-a.internal:4000")
        .with_value(
            "SANDBOX_CORE_BACK_URLS",
            "https://core-sandbox.internal:4005",
        )
        .with_value("MTLS_CLIENT_CERT_PATH", "/certs/client.pem")
        .with_value("MTLS_CLIENT_KEY_PATH", "/certs/client.key")
        .with_value("MTLS_CA_CERT_PATH", "/certs/ca.pem")
        .with_value("ADMIN_LAN_CIDRS", "127.0.0.0/8,::1/128");
    for (key, value) in extra {
        env = env.with_value(*key, *value);
    }
    Config::from_env(&env).expect("config")
}

struct Harness {
    core: Arc<FakeCore>,
    state: Arc<crate::dispatch::AppState>,
}

impl Harness {
    async fn new(extra: &[(&str, &str)]) -> Self {
        let config = Arc::new(config(extra));
        let core = Arc::new(FakeCore::default());
        let client = Arc::new(CoreClient::new(&config, core.clone()));
        let state = Arc::new(crate::dispatch::AppState::new(
            config.clone(),
            client,
            crate::routes::table(),
            crate::routes::uploads(),
        ));
        Self { core, state }
    }

    async fn call_peer(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
        peer: &str,
    ) -> ntex::http::Response {
        let app_config = WebAppConfig::new().set_value(self.state.clone());
        let app = test::init_service(
            App::new()
                .with_config(app_config)
                .service(web::resource("/{tail}*").to(dispatch::handle)),
        )
        .await;
        let mut request = test::TestRequest::get()
            .method(ntex::http::Method::from_bytes(method.as_bytes()).expect("method"))
            .uri(uri)
            .peer_addr(peer.parse().expect("peer"))
            .header("x-request-id", "req-test-1");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        if let Some(body) = body {
            request = request.payload(body);
        }
        test::call_service(&app, request.to_request()).await
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
    ) -> ntex::http::Response {
        self.call_peer(method, uri, token, content_type, body, "127.0.0.1:5555")
            .await
    }

    async fn call_headers(
        &self,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> ntex::http::Response {
        let app_config = WebAppConfig::new().set_value(self.state.clone());
        let app = test::init_service(
            App::new()
                .with_config(app_config)
                .service(web::resource("/{tail}*").to(dispatch::handle)),
        )
        .await;
        let mut request = test::TestRequest::get()
            .method(ntex::http::Method::from_bytes(method.as_bytes()).expect("method"))
            .uri(uri)
            .peer_addr("127.0.0.1:5555".parse().expect("peer"))
            .header("x-request-id", "req-test-1");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.payload(body);
        }
        test::call_service(&app, request.to_request()).await
    }

    async fn json(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = self
            .call(
                method,
                uri,
                token,
                Some("application/json"),
                Some(serde_json::to_vec(&body).expect("json")),
            )
            .await;
        let status = response.status();
        let bytes = test::read_body(response).await;
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }
}

fn token(claims: Value) -> String {
    let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(json!({"alg":"HS256","typ":"JWT"}).to_string());
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
    format!("{header}.{payload}.{}", "A".repeat(43))
}

fn staff() -> String {
    token(json!({
        "typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
        "sub":"u-1","role":"SECURITY_ADMIN",
        "authorities":[
            "merchant:read","merchant:write","gateway:read","gateway:write","security:read",
            "security:write","settings:read","settings:write","finance:read","finance:write",
            "reconciliation:read","reconciliation:write","kyb:read","kyb:write",
            "user:read","user:write","approval:read","approval:check","case:read","case:write",
            "operator:read","operator:write","attempt:read","attempt:inquire","dispute:read",
            "dispute:write","cashout:read","cashout:review","commission:read","commission:write",
            "velocity:read","velocity:write","credential:read","credential:write",
            "system:storage:read","system:storage:admin","report_engine:author",
            "report_engine:run","report:review","report:approve","aml:read","aml:write"
        ],
        "exp": 4_102_444_800u64
    }))
}

fn scoped(authorities: &[&str]) -> String {
    token(json!({
        "typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
        "sub":"u-scoped","role":"SUPPORT","authorities":authorities,
        "exp": 4_102_444_800u64
    }))
}

fn expired() -> String {
    token(json!({
        "typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
        "sub":"u-1","role":"SECURITY_ADMIN","authorities":["*"],"exp":1
    }))
}

async fn body_text(response: ntex::http::Response) -> String {
    String::from_utf8_lossy(&test::read_body(response).await).to_string()
}

#[ntex::test]
async fn health_and_security_headers() {
    let harness = Harness::new(&[]).await;
    let response = harness.call("GET", "/health", None, None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );
    // TS does not echo x-request-id on the response (chapter 2 §2 differs; TS wins).
    assert!(response.headers().get("x-request-id").is_none());
    let body = body_text(response).await;
    assert!(body.contains("\"service\":\"admin-back\""));
    assert!(body.contains("\"impl\":\"rust\""));
}

#[ntex::test]
async fn lan_guard_refuses_non_private_peers_before_auth() {
    let harness = Harness::new(&[]).await;
    let response = harness
        .call_peer(
            "GET",
            "/api/v1/admin/wallets",
            None,
            None,
            None,
            "8.8.8.8:1234",
        )
        .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(body["code"], "ADMIN_LAN_ONLY");
    assert_eq!(body["details"]["clientIp"], "8.8.8.8");
}

#[ntex::test]
async fn session_and_authority_hints_fail_closed() {
    let harness = Harness::new(&[]).await;
    let (status, body) = harness
        .json("GET", "/api/v1/admin/wallets", None, json!({}))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "AUTH_REQUIRED");

    let (status, body) = harness
        .json("GET", "/api/v1/admin/wallets", Some(&expired()), json!({}))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "AUTH_INVALID");
    assert_eq!(harness.core.count(), 0);

    let token = scoped(&["user:read"]);
    let (status, body) = harness
        .json("GET", "/api/v1/admin/wallets", Some(&token), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "EDGE_AUTHORITY_DENIED");
    assert_eq!(harness.core.count(), 0);

    let token = scoped(&["merchant:read"]);
    let (status, _) = harness
        .json(
            "GET",
            "/api/v1/admin/wallets?page=2",
            Some(&token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let core = harness.core.requests();
    assert_eq!(core[0].method, "GET");
    assert_eq!(core[0].path, "/internal/admin/wallets");
    assert_eq!(core[0].query, vec![("page".to_owned(), "2".to_owned())]);
    assert_eq!(core[0].headers.get("x-real-client-ip"), Some("127.0.0.1"));
    assert_eq!(core[0].headers.get("x-edge-service"), Some("admin-back"));
}

#[ntex::test]
async fn configured_authority_hints_can_only_restrict() {
    let harness = Harness::new(&[("ADMIN_AUTHORITY_HINTS", "security:read")]).await;
    let token = staff();
    let (status, body) = harness
        .json("GET", "/api/v1/admin/wallets", Some(&token), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "EDGE_AUTHORITY_DENIED");
}

#[ntex::test]
async fn protected_reads_are_forwarded_and_core_errors_are_mapped() {
    let harness = Harness::new(&[]).await;
    harness.core.enqueue(
        409,
        json!({"code":"CONFLICT","message":"nope","reference":"core-ref","details":{"x":1}}),
    );
    let (status, body) = harness
        .json(
            "GET",
            "/api/v1/admin/wallets/0192f6a0-1111-7111-8111-111111111111",
            Some(&staff()),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "CONFLICT");
    assert_eq!(body["reference"], "core-ref");
    assert_eq!(body["details"]["x"], 1);
}

#[ntex::test]
async fn unknown_route_is_a_404_with_the_express_body() {
    let harness = Harness::new(&[]).await;
    let (status, body) = harness
        .json("GET", "/api/v1/admin/nope", Some(&staff()), json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "NOT_FOUND");
    assert_eq!(body["message"], "No route matches GET /api/v1/admin/nope");
    assert_eq!(harness.core.count(), 0);
}

#[ntex::test]
async fn strict_schemas_reject_unknown_keys_before_core() {
    let harness = Harness::new(&[]).await;
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/gateways",
            Some(&staff()),
            json!({"code":"edfali","name":"Edfali","surprise":true}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "VALIDATION_FAILED");
    assert_eq!(body["details"][0]["code"], "unrecognized_keys");
    assert_eq!(harness.core.count(), 0);
}

#[ntex::test]
async fn contract_translation_reaches_core_with_canonical_fields() {
    let harness = Harness::new(&[]).await;
    let (status, _) = harness
        .json(
            "POST",
            "/api/v1/admin/gateways",
            Some(&staff()),
            json!({"code":"Edfali","name":"Edfali","category":"bank","aliases":["Edfali"]}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let core = harness.core.requests();
    let body: Value = serde_json::from_slice(&core[0].body).expect("json");
    assert_eq!(body["code"], "edfali");
    assert_eq!(body["operator"], "bank");
    assert_eq!(body["kind"], "DIRECT");
}

#[ntex::test]
async fn report_engine_prefix_accepts_more_than_four_megabytes() {
    let harness = Harness::new(&[]).await;
    let big = "x".repeat(4 * 1024 * 1024 + 1000);
    let response = harness
        .call(
            "POST",
            "/api/v1/admin/report-engine/specs/verify",
            Some(&staff()),
            Some("application/json"),
            Some(serde_json::to_vec(&json!({ "specJson": big })).expect("json")),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let core = harness.core.requests();
    assert!(core[0].body.len() > 4 * 1024 * 1024);

    // The same size on a normal route is refused with 413.
    let big = "x".repeat(4 * 1024 * 1024 + 1000);
    let response = harness
        .call(
            "POST",
            "/api/v1/admin/gateways/spec-verify",
            Some(&staff()),
            Some("application/json"),
            Some(serde_json::to_vec(&json!({ "spec": big })).expect("json")),
        )
        .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(body["code"], "PAYLOAD_TOO_LARGE");
}

#[ntex::test]
async fn malformed_json_is_a_400_bad_request() {
    let harness = Harness::new(&[]).await;
    let response = harness
        .call(
            "POST",
            "/api/v1/admin/gateways",
            Some(&staff()),
            Some("application/json"),
            Some(b"{not json".to_vec()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(body["code"], "BAD_REQUEST");
}

#[ntex::test]
async fn admin_rate_limit_is_enforced() {
    let harness = Harness::new(&[("ADMIN_RATE_LIMIT_MAX", "2")]).await;
    for _ in 0..2 {
        let (status, _) = harness
            .json("GET", "/api/v1/admin/wallets", Some(&staff()), json!({}))
            .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, body) = harness
        .json("GET", "/api/v1/admin/wallets", Some(&staff()), json!({}))
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "RATE_LIMITED");
}

#[ntex::test]
async fn auth_limit_counts_failures_only() {
    let harness = Harness::new(&[("AUTH_RATE_LIMIT_MAX", "2")]).await;
    harness
        .core
        .enqueue(401, json!({"code":"INVALID_CREDENTIALS","message":"nope"}));
    harness
        .core
        .enqueue(401, json!({"code":"INVALID_CREDENTIALS","message":"nope"}));
    let login = json!({"identifier":"admin@example.com","password":"Password123!"});
    let (status, _) = harness
        .json("POST", "/api/v1/admin/auth/login", None, login.clone())
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = harness
        .json("POST", "/api/v1/admin/auth/login", None, login.clone())
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Two failures consumed the per-address budget for a limit of two.
    let (status, body) = harness
        .json("POST", "/api/v1/admin/auth/login", None, login)
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "RATE_LIMITED");
}

#[ntex::test]
async fn backup_jobs_have_their_own_limiter_and_relay_status() {
    let harness = Harness::new(&[("BACKUP_JOB_RATE_LIMIT_MAX", "2")]).await;
    harness
        .core
        .enqueue(202, json!({"jobId":"job-1","status":"QUEUED"}));
    let trigger = json!({"target":"all","kind":"full"});
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/system/backups/trigger",
            Some(&staff()),
            trigger.clone(),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["jobId"], "job-1");
    let (status, _) = harness
        .json(
            "POST",
            "/api/v1/admin/system/backups/trigger",
            Some(&staff()),
            trigger.clone(),
        )
        .await;
    assert!(status.is_success());
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/system/backups/trigger",
            Some(&staff()),
            trigger,
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "RATE_LIMITED");
}

#[ntex::test]
async fn sandbox_requests_use_the_sandbox_pool_and_rewrite_the_path() {
    let harness = Harness::new(&[]).await;
    let merchant = "0192f6a0-1111-7111-8111-111111111111";
    let (status, _) = harness
        .json(
            "POST",
            &format!("/api/v1/admin/sandbox/merchants/{merchant}/seed"),
            Some(&staff()),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let core = harness.core.requests();
    assert_eq!(core[0].node, "https://core-sandbox.internal:4005");
    assert_eq!(core[0].path, "/internal/sandbox/merchant/seed-demo");
    assert_eq!(
        core[0].query,
        vec![("merchantId".to_owned(), merchant.to_owned())]
    );
    assert_eq!(core[0].headers.get("x-execution-plane"), Some("SANDBOX"));
    assert_eq!(core[0].headers.get("x-sandbox-proxy"), Some("admin-back"));
}

#[ntex::test]
async fn sandbox_mirror_relays_the_core_response() {
    let harness = Harness::new(&[]).await;
    harness
        .core
        .enqueue(404, json!({"code":"NOT_FOUND","message":"missing"}));
    let (status, body) = harness
        .json(
            "GET",
            "/api/v1/admin/sandbox/mirror/reconciliation/runs/summary",
            Some(&staff()),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "NOT_FOUND");
    let core = harness.core.requests();
    assert_eq!(core[0].path, "/internal/admin/reconciliation/summary");
    assert_eq!(core[0].node, "https://core-sandbox.internal:4005");
}

#[ntex::test]
async fn sandbox_without_a_node_fails_closed() {
    let env = pg_config::Env::process()
        .with_value("CORE_BACK_URL", "https://core-a.internal:4000")
        .with_value("MTLS_CLIENT_CERT_PATH", "/certs/client.pem")
        .with_value("MTLS_CLIENT_KEY_PATH", "/certs/client.key")
        .with_value("MTLS_CA_CERT_PATH", "/certs/ca.pem")
        .with_value("ADMIN_LAN_CIDRS", "127.0.0.0/8");
    let config = Arc::new(Config::from_env(&env).expect("config"));
    let core = Arc::new(FakeCore::default());
    let client = Arc::new(CoreClient::new(&config, core.clone()));
    let state = Arc::new(crate::dispatch::AppState::new(
        config,
        client,
        crate::routes::table(),
        crate::routes::uploads(),
    ));
    let app_config = WebAppConfig::new().set_value(state);
    let app = test::init_service(
        App::new()
            .with_config(app_config)
            .service(web::resource("/{tail}*").to(crate::dispatch::handle)),
    )
    .await;
    let request = test::TestRequest::get()
        .uri("/api/v1/admin/sandbox/overview")
        .peer_addr("127.0.0.1:5555".parse().expect("peer"))
        .header("authorization", format!("Bearer {}", staff()))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(body["code"], "SANDBOX_NODE_UNAVAILABLE");
}

fn multipart(
    boundary: &str,
    fields: &[(&str, &str)],
    file: Option<(&str, &str, &[u8])>,
) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    if let Some((field, filename, content)) = file {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: application/pdf\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(content);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

#[ntex::test]
async fn multipart_upload_forwards_x_upload_headers_and_raw_bytes() {
    let harness = Harness::new(&[]).await;
    let id = "0192f6a0-1111-7111-8111-111111111111";
    let body = multipart(
        "edge",
        &[("label", "bank letter")],
        Some(("file", "evidence.pdf", b"%PDF-1.7\nbody")),
    );
    let response = harness
        .call(
            "POST",
            &format!("/api/v1/admin/disputes/{id}/attachments"),
            Some(&staff()),
            Some("multipart/form-data; boundary=edge"),
            Some(body),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let core = harness.core.requests();
    assert_eq!(
        core[0].path,
        format!("/internal/admin/disputes/{id}/attachments")
    );
    assert_eq!(&core[0].body[..], b"%PDF-1.7\nbody");
    assert_eq!(
        core[0].headers.get("x-upload-content-type"),
        Some("application/pdf")
    );
    assert_eq!(core[0].headers.get("x-upload-size"), Some("13"));
    assert!(core[0].headers.get("x-upload-sha256").is_some());
    assert_eq!(
        core[0].headers.get("x-upload-filename"),
        Some("evidence.pdf")
    );
    let metadata = core[0].headers.get("x-upload-metadata").expect("metadata");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(metadata)
        .expect("base64");
    let metadata: Value = serde_json::from_slice(&decoded).expect("json");
    assert_eq!(metadata["label"], "bank letter");
}

#[ntex::test]
async fn multipart_upload_rejects_a_mismatched_signature() {
    let harness = Harness::new(&[]).await;
    let id = "0192f6a0-1111-7111-8111-111111111111";
    let body = multipart("edge", &[], Some(("file", "evidence.pdf", b"just text")));
    let response = harness
        .call(
            "POST",
            &format!("/api/v1/admin/disputes/{id}/attachments"),
            Some(&staff()),
            Some("multipart/form-data; boundary=edge"),
            Some(body),
        )
        .await;
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let payload: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(payload["code"], "UPLOAD_SIGNATURE_MISMATCH");
    assert_eq!(harness.core.count(), 0);
}

#[ntex::test]
async fn upload_limiter_and_declared_length_are_enforced() {
    let harness = Harness::new(&[("UPLOAD_RATE_LIMIT_MAX", "1")]).await;
    let id = "0192f6a0-1111-7111-8111-111111111111";
    let body = multipart("edge", &[], Some(("file", "a.pdf", b"%PDF-1.7")));
    let first = harness
        .call(
            "POST",
            &format!("/api/v1/admin/disputes/{id}/attachments"),
            Some(&staff()),
            Some("multipart/form-data; boundary=edge"),
            Some(body.clone()),
        )
        .await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let second = harness
        .call(
            "POST",
            &format!("/api/v1/admin/disputes/{id}/attachments"),
            Some(&staff()),
            Some("multipart/form-data; boundary=edge"),
            Some(body),
        )
        .await;
    assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    let payload: Value = serde_json::from_slice(&test::read_body(second).await).expect("json");
    assert_eq!(payload["code"], "RATE_LIMITED");
}

#[ntex::test]
async fn cookie_mode_moves_the_token_and_requires_csrf() {
    let harness = Harness::new(&[
        ("SESSION_COOKIE_MODE", "true"),
        ("SESSION_COOKIE_SECURE", "false"),
    ])
    .await;
    let session = staff();
    harness.core.enqueue(200, json!({"token": session}));
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/auth/login",
            None,
            json!({"identifier":"admin@example.com","password":"Password123!"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sessionCookie"], true);
    assert!(body.get("token").is_none());

    // A cookie-authenticated write without x-pg-csrf is refused.
    let cookie = format!("pg_admin_session={session}");
    let body = serde_json::to_vec(&json!({"status":"FROZEN","reason":"suspicious activity"}))
        .expect("json");
    let response = harness
        .call_headers(
            "POST",
            "/api/v1/admin/wallets/0192f6a0-1111-7111-8111-111111111111/status",
            &[
                ("cookie", cookie.as_str()),
                ("content-type", "application/json"),
            ],
            Some(body.clone()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let payload: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(payload["code"], "CSRF_HEADER_REQUIRED");

    let response = harness
        .call_headers(
            "POST",
            "/api/v1/admin/wallets/0192f6a0-1111-7111-8111-111111111111/status",
            &[
                ("cookie", cookie.as_str()),
                ("x-pg-csrf", "1"),
                ("content-type", "application/json"),
            ],
            Some(body),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let core = harness.core.requests();
    let expected = format!("Bearer {session}");
    assert_eq!(
        core.last()
            .and_then(|request| request.headers.get("authorization")),
        Some(expected.as_str())
    );
}

#[ntex::test]
async fn cors_is_only_emitted_for_an_allowed_origin() {
    let harness = Harness::new(&[("CORS_ALLOWED_ORIGINS", "https://admin.example.com")]).await;
    let response = harness
        .call_headers(
            "GET",
            "/health",
            &[("origin", "https://admin.example.com")],
            None,
        )
        .await;
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("https://admin.example.com")
    );
    let response = harness
        .call_headers(
            "GET",
            "/health",
            &[("origin", "https://evil.example.com")],
            None,
        )
        .await;
    assert!(response
        .headers()
        .get("access-control-allow-origin")
        .is_none());
}

#[ntex::test]
async fn min_lsn_is_validated_before_core() {
    let harness = Harness::new(&[]).await;
    let authorization = format!("Bearer {}", staff());
    let response = harness
        .call_headers(
            "GET",
            "/api/v1/admin/wallets",
            &[
                ("authorization", authorization.as_str()),
                ("x-pg-min-lsn", "not-an-lsn"),
            ],
            None,
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(&test::read_body(response).await).expect("json");
    assert_eq!(body["code"], "INVALID_MIN_LSN");
    assert_eq!(harness.core.count(), 0);
}

#[ntex::test]
async fn academy_team_view_is_security_admin_only() {
    let harness = Harness::new(&[]).await;
    let (status, body) = harness
        .json(
            "GET",
            "/api/v1/admin/academy/team",
            Some(&scoped(&["user:read"])),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "ACADEMY_TEAM_FORBIDDEN");
}

#[ntex::test]
async fn relay_status_is_preserved_and_declared_status_wins_otherwise() {
    let harness = Harness::new(&[]).await;
    harness
        .core
        .enqueue(202, json!({"state":"PENDING_APPROVAL"}));
    let (status, _) = harness
        .json(
            "POST",
            "/api/v1/admin/wallets/0192f6a0-1111-7111-8111-111111111111/status",
            Some(&staff()),
            json!({"status":"ACTIVE","reason":"restore access for merchant"}),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let (status, _) = harness
        .json(
            "POST",
            "/api/v1/admin/users",
            Some(&staff()),
            json!({"email":"new@example.com","role":"OPERATOR"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[ntex::test]
async fn trusted_proxy_headers_are_honoured_only_from_a_trusted_peer() {
    let harness = Harness::new(&[("ADMIN_LAN_CIDRS", "127.0.0.0/8,::1/128,10.0.0.0/8")]).await;
    // 127.0.0.1 is a trusted proxy by default; its x-real-ip is the client address.
    let authorization = format!("Bearer {}", staff());
    let response = harness
        .call_headers(
            "GET",
            "/api/v1/admin/wallets",
            &[
                ("authorization", authorization.as_str()),
                ("x-real-ip", "10.5.6.7"),
            ],
            None,
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let core = harness.core.requests();
    assert_eq!(core[0].headers.get("x-real-client-ip"), Some("10.5.6.7"));
}

#[ntex::test]
async fn bulk_approval_reject_aggregates_per_subject_results() {
    let harness = Harness::new(&[]).await;
    harness.core.enqueue(200, json!({"state":"REJECTED"}));
    harness
        .core
        .enqueue(409, json!({"code":"CONFLICT","message":"already decided"}));
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/approvals/bulk-reject",
            Some(&staff()),
            json!({"approvalIds":["a1","a2"],"reason":"missing evidence"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["requested"], 2);
    assert_eq!(body["rejected"], 1);
    assert_eq!(body["failed"], 1);
    assert_eq!(body["results"][0]["status"], "REJECTED");
    assert_eq!(body["results"][1]["status"], "FAILED");
    assert_eq!(body["results"][1]["httpStatus"], 409);
}

#[ntex::test]
async fn bulk_user_patch_fans_out_and_reports_202() {
    let harness = Harness::new(&[]).await;
    harness
        .core
        .enqueue(200, json!({"id":"u1","status":"SUSPENDED"}));
    harness.core.enqueue(202, json!({"approvalId":"a1"}));
    let (status, body) = harness
        .json(
            "PATCH",
            "/api/v1/admin/users",
            Some(&staff()),
            json!({"userIds":["u1","u2"],"status":"SUSPENDED","reason":"security review"}),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body.as_array().map(Vec::len), Some(2));
    let core = harness.core.requests();
    assert_eq!(core.len(), 2);
    let first: Value = serde_json::from_slice(&core[0].body).expect("json");
    assert_eq!(first["id"], "u1");
    assert_eq!(first["status"], "SUSPENDED");
    assert_eq!(first["authoritiesMap"], Value::Null);
    assert_eq!(first["role"], Value::Null);
}

#[ntex::test]
async fn search_is_limited_per_session() {
    let harness = Harness::new(&[]).await;
    for _ in 0..120 {
        let (status, _) = harness
            .json(
                "POST",
                "/api/v1/admin/search",
                Some(&staff()),
                json!({"query":"merchant"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/search",
            Some(&staff()),
            json!({"query":"merchant"}),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["code"], "SEARCH_RATE_LIMITED");
    assert!(body["retryAfterSec"].as_u64().unwrap_or(0) >= 1);
}

#[ntex::test]
async fn report_engine_declared_length_above_24_mb_is_refused() {
    let harness = Harness::new(&[]).await;
    let authorization = format!("Bearer {}", staff());
    let response = harness
        .call_headers(
            "POST",
            "/api/v1/admin/report-engine/specs/verify",
            &[
                ("authorization", authorization.as_str()),
                ("content-type", "application/json"),
                ("content-length", "25165825"),
            ],
            None,
        )
        .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(harness.core.count(), 0);
}

#[ntex::test]
async fn head_is_served_from_the_get_route() {
    let harness = Harness::new(&[]).await;
    let response = harness.call("HEAD", "/health", None, None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[ntex::test]
async fn logout_clears_the_cookie_and_revokes_in_core() {
    let harness = Harness::new(&[]).await;
    let (status, body) = harness
        .json(
            "POST",
            "/api/v1/admin/auth/logout",
            Some(&staff()),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revoked"], true);
    assert!(response_has_cookie(&harness, "POST", "/api/v1/admin/auth/logout").await);
}

async fn response_has_cookie(harness: &Harness, method: &str, uri: &str) -> bool {
    let authorization = format!("Bearer {}", staff());
    let response = harness
        .call_headers(
            method,
            uri,
            &[("authorization", authorization.as_str())],
            Some(b"{}".to_vec()),
        )
        .await;
    response.headers().get("set-cookie").is_some()
}

#[ntex::test]
async fn incident_filters_are_forwarded_to_the_core_compliance_namespace() {
    let harness = Harness::new(&[]).await;
    let token = token(json!({
        "typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
        "sub":"u-aml","role":"COMPLIANCE","authorities":["aml:read"],
        "exp": 4_102_444_800u64
    }));
    let (status, _) = harness
        .json(
            "GET",
            "/api/v1/admin/aml/incidents?search=INC-1&status=DETECTED&severity=SEV1&page=2&pageSize=50",
            Some(&token),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let core = harness.core.requests();
    assert_eq!(core[0].path, "/internal/admin/incidents");
    for expected in [
        ("search", "INC-1"),
        ("status", "DETECTED"),
        ("severity", "SEV1"),
        ("page", "2"),
        ("pageSize", "50"),
    ] {
        assert!(
            core[0]
                .query
                .iter()
                .any(|(key, value)| key == expected.0 && value == expected.1),
            "{expected:?} was not forwarded: {:?}",
            core[0].query
        );
    }
}

#[ntex::test]
async fn unsupported_methods_never_fall_back_to_get() {
    let harness = Harness::new(&[]).await;
    let response = harness
        .call("TRACE", "/api/v1/admin/wallets", Some(&staff()), None, None)
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(harness.core.count(), 0);
}
