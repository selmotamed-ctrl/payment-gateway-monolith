//! Shared harness for the ported `merchant-back/test/**` suites.

#![allow(dead_code)]

use std::sync::Arc;

use merchant_edge::app::{AppState, IncomingRequest};
use merchant_edge::config::EdgeConfig;
use merchant_edge::http::EdgeResponse;
use merchant_edge::upstream::test_support::{FakeCore, RecordedCall};
use serde_json::Value;

pub struct Harness {
    pub app: AppState,
    pub core: FakeCore,
}

impl Harness {
    #[must_use]
    pub fn new() -> Self {
        Self::with_config(|_| {})
    }

    #[must_use]
    pub fn with_config(configure: impl FnOnce(&mut EdgeConfig)) -> Self {
        let core = FakeCore::new();
        let mut config = EdgeConfig::for_embedding(vec!["https://core.test".to_owned()], None);
        config.session_cookie_secure = false;
        configure(&mut config);
        let app = AppState::new(
            config,
            Arc::new(core.clone()),
            "test-release".to_owned(),
            "test-commit".to_owned(),
        );
        Self { app, core }
    }

    #[must_use]
    pub fn with_sandbox() -> Self {
        Self::with_config(|config| {
            config.pools.sandbox = Some(vec!["https://sandbox.core.test".to_owned()]);
        })
    }

    #[must_use]
    pub fn without_sandbox() -> Self {
        Self::with_config(|config| {
            config.pools.sandbox = None;
        })
    }

    pub async fn send(&self, request: IncomingRequest) -> EdgeResponse {
        merchant_edge::app::serve(&self.app, request).await
    }

    #[must_use]
    pub fn last_call(&self) -> Option<RecordedCall> {
        self.core.last_call()
    }

    #[must_use]
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.core.calls()
    }

    #[must_use]
    pub fn call_count(&self) -> usize {
        self.core.call_count()
    }

    pub fn clear(&self) {
        self.core.clear();
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

#[must_use]
pub fn body(response: &EdgeResponse) -> Value {
    serde_json::from_slice(response.body_bytes().unwrap_or(b"{}")).unwrap_or(Value::Null)
}

#[must_use]
pub fn session_bearer() -> String {
    let header = base64_url(&serde_json::json!({ "alg": "HS256", "typ": "JWT" }));
    let payload = base64_url(&serde_json::json!({
        "sub": "user-1",
        "typ": "session",
        "aud": "payment-gateway-merchant",
        "role": "MERCHANT_ADMIN",
        "exp": now_seconds() + 3600
    }));
    format!("Bearer {header}.{payload}.signature")
}

/// A merchant session JWT that expired ten seconds ago.
#[must_use]
pub fn expired_bearer() -> String {
    let header = base64_url(&serde_json::json!({ "alg": "HS256", "typ": "JWT" }));
    let payload = base64_url(&serde_json::json!({
        "typ": "session",
        "aud": "payment-gateway-merchant",
        "exp": now_seconds() - 10
    }));
    format!("Bearer {header}.{payload}.signature")
}

#[must_use]
pub fn bearer_for_audience(audience: &str) -> String {
    let header = base64_url(&serde_json::json!({ "alg": "HS256", "typ": "JWT" }));
    let payload = base64_url(&serde_json::json!({
        "typ": "session",
        "aud": audience,
        "exp": now_seconds() + 3600
    }));
    format!("Bearer {header}.{payload}.signature")
}

fn base64_url(value: &Value) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(value).expect("json"))
}

#[must_use]
pub fn now_seconds() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
    )
    .unwrap_or(i64::MAX)
}

/// A request with the merchant session bearer.
#[must_use]
pub fn authenticated(method: &str, path: &str) -> IncomingRequest {
    IncomingRequest::synthetic(method, path).with_header("authorization", &session_bearer())
}

/// One multipart part: a field (`filename` is `None`) or a file.
pub struct Part<'a> {
    pub name: &'a str,
    pub filename: Option<(&'a str, &'a str)>,
    pub bytes: &'a [u8],
}

impl<'a> Part<'a> {
    #[must_use]
    pub fn field(name: &'a str, value: &'a str) -> Self {
        Self {
            name,
            filename: None,
            bytes: value.as_bytes(),
        }
    }

    #[must_use]
    pub fn file(name: &'a str, filename: &'a str, mime: &'a str, bytes: &'a [u8]) -> Self {
        Self {
            name,
            filename: Some((filename, mime)),
            bytes,
        }
    }
}

/// Build a multipart/form-data body with a fixed boundary.
#[must_use]
pub fn multipart(parts: &[Part<'_>]) -> (String, Vec<u8>) {
    const BOUNDARY: &str = "----merchant-edge-test-boundary";
    let mut output = Vec::new();
    for part in parts {
        output.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        match part.filename {
            Some((filename, mime)) => output.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n",
                    part.name
                )
                .as_bytes(),
            ),
            None => output.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                    part.name
                )
                .as_bytes(),
            ),
        }
        output.extend_from_slice(part.bytes);
        output.extend_from_slice(b"\r\n");
    }
    output.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    let content_type = format!("multipart/form-data; boundary={BOUNDARY}");
    (content_type, output)
}

pub const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRtestpayload";
pub const JPEG: &[u8] = b"\xff\xd8\xff\xe0\x00\x10JFIFtestpayload";
pub const PDF: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

#[must_use]
pub fn kyb_form(document: &[u8], filename: &str, mime: &str) -> (String, Vec<u8>) {
    multipart(&[
        Part::field("documentType", "COMMERCIAL_REGISTRY"),
        Part::file("document", filename, mime, document),
    ])
}
