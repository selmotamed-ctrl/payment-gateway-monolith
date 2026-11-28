//! Edge → core transport.
//!
//! Port of `merchant-back/lib/coreInternalClient.ts`: mTLS (TLS 1.3 only), the least-in-flight
//! pools of `pg_upstream`, the retry/health state machine, path confinement, response caps and
//! the SSE stream relay.
//!
//! [`CoreTransport`] is the seam used by the handlers. [`HttpCoreTransport`] is the production
//! implementation (reqwest + rustls, one client per plane); [`test_support::FakeCore`] records
//! requests and replays queued answers, which is how the ported edge tests run without a
//! PostgreSQL/Redis core.

#![forbid(unsafe_code)]

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::stream::Stream;
use futures_util::StreamExt as _;
use pg_upstream::{
    build_core_headers, prepare_request_headers, resolve_core_url, AttemptDecision, AttemptLoop,
    CoreMethod, CoreRequestMeta, HeaderSet, Limits, Plane, PoolError, QueryValue, TransportFailure,
    UpstreamPool,
};
use reqwest::Client;

use crate::config::{EdgeConfig, MtlsPaths};

/// A streamed core body (SSE, attachment download).
pub type CoreByteStream =
    Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static>>;

/// One logical edge → core call.
#[derive(Debug, Clone)]
pub struct CoreRequest {
    pub plane: Plane,
    pub method: CoreMethod,
    pub path: String,
    pub query: Vec<(String, QueryValue)>,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: Option<u64>,
}

impl CoreRequest {
    /// Build the two edge-owned header sets, exactly like `buildCoreHeaders` followed by
    /// `buildRequestHeaders` in `coreInternalClient.ts`.
    pub fn build_headers(
        caller: &[(&str, &str)],
        meta: &CoreRequestMeta<'_>,
        body_len: Option<usize>,
    ) -> Result<Vec<(String, String)>, PoolError> {
        let headers = build_core_headers(caller, meta)?;
        let pairs: Vec<(&str, &str)> = headers
            .entries()
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let prepared = prepare_request_headers(&pairs, body_len)?;
        Ok(prepared
            .entries()
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect())
    }
}

/// A buffered core response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl CoreResponse {
    /// `parseJsonBuffer`: empty → `{}`, invalid JSON → `{message: <text>}`.
    #[must_use]
    pub fn json_body(&self) -> serde_json::Value {
        parse_json_buffer(&self.body)
    }

    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// A streamed core response.
pub struct CoreStreamResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub stream: CoreByteStream,
}

impl std::fmt::Debug for CoreStreamResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CoreStreamResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .finish_non_exhaustive()
    }
}

impl CoreStreamResponse {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The transport seam.
#[async_trait]
pub trait CoreTransport: Send + Sync {
    /// A buffered call. `Err` carries a `CORE_*` edge error.
    async fn call(&self, request: CoreRequest) -> Result<CoreResponse, PoolError>;

    /// A streaming call (POS SSE, attachment download).
    async fn open_stream(&self, request: CoreRequest) -> Result<CoreStreamResponse, PoolError>;
}

/// `parseJsonBuffer` (`coreInternalClient.ts:731-739`).
#[must_use]
pub fn parse_json_buffer(buffer: &[u8]) -> serde_json::Value {
    let text = String::from_utf8_lossy(buffer);
    let text = text.trim();
    if text.is_empty() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({ "message": text }))
}

/// Production transport.
#[derive(Debug)]
pub struct HttpCoreTransport {
    limits: Limits,
    live: Arc<UpstreamPool>,
    sandbox: Option<Arc<UpstreamPool>>,
    live_client: Client,
    sandbox_client: Option<Client>,
}

impl HttpCoreTransport {
    pub fn new(config: &EdgeConfig) -> Result<Self, String> {
        pg_mtls::install_crypto_provider();
        let live = Arc::new(UpstreamPool::with_defaults(config.pools.live.clone()));
        let sandbox = config
            .pools
            .sandbox
            .as_ref()
            .filter(|urls| !urls.is_empty())
            .map(|urls| Arc::new(UpstreamPool::with_defaults(urls.clone())));
        let live_client = build_client(&config.mtls, config.request_timeout_ms)?;
        let sandbox_client = if sandbox.is_some() {
            Some(build_client(&config.mtls, config.request_timeout_ms)?)
        } else {
            None
        };
        Ok(Self {
            limits: Limits {
                request_timeout_ms: config.request_timeout_ms,
                total_deadline_ms: config.total_deadline_ms,
                max_response_bytes: config.max_response_bytes,
            },
            live,
            sandbox,
            live_client,
            sandbox_client,
        })
    }

    fn plane_parts(&self, plane: Plane) -> Result<(&UpstreamPool, &Client), PoolError> {
        match plane {
            Plane::Live => Ok((&self.live, &self.live_client)),
            Plane::Sandbox => match (&self.sandbox, &self.sandbox_client) {
                (Some(pool), Some(client)) => Ok((pool, client)),
                _ => Err(PoolError::sandbox_unavailable()),
            },
        }
    }

    async fn call_inner(&self, request: &CoreRequest) -> Result<CoreResponse, PoolError> {
        let (pool, client) = self.plane_parts(request.plane)?;
        let body = request.body.as_deref();
        let headers = header_set(&request.headers, body.map(<[u8]>::len))?;
        let idempotency_key = headers.get("idempotency-key").map(str::to_owned);
        let mut call = AttemptLoop::new(
            pool,
            request.method,
            idempotency_key.as_deref(),
            pg_upstream::RetryOptions::default(),
        );
        let mut last_response: Option<CoreResponse> = None;
        loop {
            let now = pg_upstream::now_millis();
            let Some(node) = call.next_node(now) else {
                break;
            };
            let timeout = request.timeout_ms.unwrap_or(self.limits.request_timeout_ms);
            let outcome = send_once(
                client,
                request,
                node.url(),
                &headers,
                body,
                timeout,
                self.limits.max_response_bytes,
            )
            .await;
            match outcome {
                Ok(response) => match call.record_response(response.status, now) {
                    AttemptDecision::Accept => return Ok(response),
                    AttemptDecision::Retry => {
                        last_response = Some(response);
                    }
                    AttemptDecision::Fail(error) => return Err(error),
                },
                Err(error) => {
                    if let Some(local) = error.local {
                        return Err(local);
                    }
                    let connect_phase = error.connect_phase;
                    let failure = error.failure;
                    match call.record_transport(failure, connect_phase, now) {
                        AttemptDecision::Retry | AttemptDecision::Accept => {}
                        AttemptDecision::Fail(error) => return Err(error),
                    }
                }
            }
        }
        if let Some(response) = last_response {
            return Ok(response);
        }
        match call.finish(pg_upstream::now_millis()) {
            pg_upstream::LoopFinish::Response(_) => Err(PoolError::connection_error()),
            pg_upstream::LoopFinish::Error(error) => Err(error),
        }
    }

    async fn open_stream_inner(
        &self,
        request: &CoreRequest,
    ) -> Result<CoreStreamResponse, PoolError> {
        let (pool, client) = self.plane_parts(request.plane)?;
        let mut headers = header_set(&request.headers, None)?;
        headers.set("accept", "text/event-stream");
        headers.set("cache-control", "no-cache");
        let idempotency_key = headers.get("idempotency-key").map(str::to_owned);
        let mut call = AttemptLoop::new(
            pool,
            request.method,
            idempotency_key.as_deref(),
            pg_upstream::RetryOptions::default(),
        );
        loop {
            let now = pg_upstream::now_millis();
            let Some(node) = call.next_node(now) else {
                break;
            };
            let timeout = request.timeout_ms.unwrap_or(self.limits.request_timeout_ms);
            match send_stream(client, request, node.url(), &headers, timeout).await {
                Ok(response) => match call.record_response(response.status, now) {
                    AttemptDecision::Accept => return Ok(response),
                    AttemptDecision::Retry => {
                        // Drop the buffered retryable body and try the next node.
                        drop(response.stream);
                    }
                    AttemptDecision::Fail(error) => return Err(error),
                },
                Err(error) => {
                    if let Some(local) = error.local {
                        return Err(local);
                    }
                    let connect_phase = error.connect_phase;
                    let failure = error.failure;
                    match call.record_transport(failure, connect_phase, now) {
                        AttemptDecision::Retry | AttemptDecision::Accept => {}
                        AttemptDecision::Fail(error) => return Err(error),
                    }
                }
            }
        }
        match call.finish(pg_upstream::now_millis()) {
            pg_upstream::LoopFinish::Response(_) => Err(PoolError::connection_error()),
            pg_upstream::LoopFinish::Error(error) => Err(error),
        }
    }
}

#[async_trait]
impl CoreTransport for HttpCoreTransport {
    async fn call(&self, request: CoreRequest) -> Result<CoreResponse, PoolError> {
        let deadline = self.limits.effective_deadline_ms(request.timeout_ms);
        match tokio::time::timeout(Duration::from_millis(deadline), self.call_inner(&request)).await
        {
            Ok(result) => result,
            Err(_) => Err(PoolError::timeout()),
        }
    }

    async fn open_stream(&self, request: CoreRequest) -> Result<CoreStreamResponse, PoolError> {
        self.open_stream_inner(&request).await
    }
}

fn build_client(paths: &MtlsPaths, timeout_ms: u64) -> Result<Client, String> {
    let ca = std::fs::read(&paths.ca_cert)
        .map_err(|error| format!("MTLS_CA_CERT_PATH is not readable: {error}"))?;
    let mut pem = std::fs::read(&paths.client_cert)
        .map_err(|error| format!("MTLS_CLIENT_CERT_PATH is not readable: {error}"))?;
    pem.extend_from_slice(
        &std::fs::read(&paths.client_key)
            .map_err(|error| format!("MTLS_CLIENT_KEY_PATH is not readable: {error}"))?,
    );
    let certificate = reqwest::Certificate::from_pem(&ca)
        .map_err(|error| format!("MTLS_CA_CERT_PATH is not a valid PEM certificate: {error}"))?;
    let identity = reqwest::Identity::from_pem(&pem)
        .map_err(|error| format!("the mTLS client identity is not a valid PEM pair: {error}"))?;
    Client::builder()
        .use_rustls_tls()
        .min_tls_version(reqwest::tls::Version::TLS_1_3)
        .max_tls_version(reqwest::tls::Version::TLS_1_3)
        .add_root_certificate(certificate)
        .identity(identity)
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(64)
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("core mTLS client could not be built: {error}"))
}

fn header_set(
    headers: &[(String, String)],
    body_len: Option<usize>,
) -> Result<HeaderSet, PoolError> {
    let pairs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    prepare_request_headers(&pairs, body_len)
}

struct AttemptError {
    failure: TransportFailure,
    connect_phase: bool,
    /// A local edge failure (response cap, invalid path) that must not count against the node.
    local: Option<PoolError>,
}

impl AttemptError {
    fn transport(error: &reqwest::Error) -> Self {
        Self {
            failure: TransportFailure::from_reqwest(error),
            connect_phase: error.is_connect(),
            local: None,
        }
    }

    fn local(error: PoolError) -> Self {
        Self {
            failure: TransportFailure::Other,
            connect_phase: false,
            local: Some(error),
        }
    }
}

async fn send_once(
    client: &Client,
    request: &CoreRequest,
    base_url: &str,
    headers: &HeaderSet,
    body: Option<&[u8]>,
    timeout_ms: u64,
    max_bytes: u64,
) -> Result<CoreResponse, AttemptError> {
    let url = resolve_core_url(
        pg_upstream::EdgeChannel::Merchant,
        base_url,
        &request.path,
        &request.query,
    )
    .map_err(AttemptError::local)?;
    let mut builder = client
        .request(to_reqwest_method(request.method), url)
        .timeout(Duration::from_millis(timeout_ms));
    for (name, value) in headers.entries() {
        builder = builder.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        builder = builder.body(body.to_vec());
    }
    let response = builder
        .send()
        .await
        .map_err(|error| AttemptError::transport(&error))?;
    let status = response.status().as_u16();
    let headers = collect_headers(response.headers());
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AttemptError::transport(&error))?;
        if body.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(AttemptError::local(PoolError::response_too_large(
                max_bytes,
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(CoreResponse {
        status,
        headers,
        body,
    })
}

async fn send_stream(
    client: &Client,
    request: &CoreRequest,
    base_url: &str,
    headers: &HeaderSet,
    timeout_ms: u64,
) -> Result<CoreStreamResponse, AttemptError> {
    let url = resolve_core_url(
        pg_upstream::EdgeChannel::Merchant,
        base_url,
        &request.path,
        &request.query,
    )
    .map_err(AttemptError::local)?;
    let mut builder = client
        .request(to_reqwest_method(request.method), url)
        .timeout(Duration::from_millis(timeout_ms));
    for (name, value) in headers.entries() {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = builder
        .send()
        .await
        .map_err(|error| AttemptError::transport(&error))?;
    let status = response.status().as_u16();
    let headers = collect_headers(response.headers());
    let stream: CoreByteStream = Box::pin(
        response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|error| std::io::Error::other(error.to_string()))),
    );
    Ok(CoreStreamResponse {
        status,
        headers,
        stream,
    })
}

fn collect_headers(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
        })
        .collect()
}

fn to_reqwest_method(method: CoreMethod) -> reqwest::Method {
    match method {
        CoreMethod::Get => reqwest::Method::GET,
        CoreMethod::Head => reqwest::Method::HEAD,
        CoreMethod::Post => reqwest::Method::POST,
        CoreMethod::Put => reqwest::Method::PUT,
        CoreMethod::Patch => reqwest::Method::PATCH,
        CoreMethod::Delete => reqwest::Method::DELETE,
        CoreMethod::Options => reqwest::Method::OPTIONS,
    }
}

/// Select the relayed response headers (`x-pg-served-by`, `x-pg-min-lsn`).
#[must_use]
pub fn relayed_headers(response: &CoreResponse) -> Vec<(String, String)> {
    pg_upstream::RELAYED_RESPONSE_HEADERS
        .iter()
        .filter_map(|name| {
            response
                .header(name)
                .map(|value| ((*name).to_owned(), value.to_owned()))
        })
        .collect()
}

/// Sandbox routing decision of one bearer credential (`bearerOf` + `requestPlane`).
#[must_use]
pub fn plane_for_authorization(authorization: Option<&str>) -> Plane {
    let Some(authorization) = authorization else {
        return Plane::Live;
    };
    let mut parts = authorization.split_whitespace();
    let scheme = parts.next().unwrap_or_default();
    let token = parts.next().unwrap_or_default();
    if scheme.eq_ignore_ascii_case("bearer") && token.starts_with(pg_upstream::SANDBOX_TOKEN_PREFIX)
    {
        Plane::Sandbox
    } else {
        Plane::Live
    }
}

/// `bearerOf`: the token of a `Bearer` header, or the empty string.
#[must_use]
pub fn bearer_of(authorization: Option<&str>) -> &str {
    let Some(authorization) = authorization else {
        return "";
    };
    let trimmed = authorization.trim();
    let Some(index) = trimmed.find(char::is_whitespace) else {
        return "";
    };
    if trimmed[..index].eq_ignore_ascii_case("bearer") {
        trimmed[index..].trim_start()
    } else {
        ""
    }
}

/// Exclusions helper re-exported for the tests.
#[must_use]
pub fn empty_exclusions() -> pg_upstream::Exclusions {
    pg_upstream::Exclusions::new()
}

/// Test doubles. Kept in the library so the integration tests in `bins/merchant-edge/tests`
/// exercise the same dispatcher as the service.
pub mod test_support {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// One recorded call.
    #[derive(Debug, Clone, PartialEq)]
    pub struct RecordedCall {
        pub plane: Plane,
        pub method: CoreMethod,
        pub path: String,
        pub query: Vec<(String, QueryValue)>,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl RecordedCall {
        #[must_use]
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }

        #[must_use]
        pub fn json_body(&self) -> serde_json::Value {
            parse_json_buffer(&self.body)
        }

        #[must_use]
        pub fn url(&self) -> String {
            if self.query.is_empty() {
                return self.path.clone();
            }
            let mut parts = Vec::new();
            for (key, value) in &self.query {
                parts.push(format!("{key}={}", value.as_text()));
            }
            format!("{}?{}", self.path, parts.join("&"))
        }
    }

    #[derive(Debug, Default)]
    struct FakeState {
        calls: Vec<RecordedCall>,
        responses: VecDeque<Result<CoreResponse, PoolError>>,
    }

    /// A core that records requests and replays queued answers.
    #[derive(Debug, Clone, Default)]
    pub struct FakeCore {
        state: Arc<Mutex<FakeState>>,
        sandbox: Arc<Mutex<bool>>,
        default_status: Arc<Mutex<u16>>,
    }

    impl FakeCore {
        #[must_use]
        pub fn new() -> Self {
            let core = Self::default();
            *core
                .sandbox
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            *core
                .default_status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = 200;
            core
        }

        /// A fake whose Sandbox plane is not configured.
        #[must_use]
        pub fn without_sandbox() -> Self {
            let core = Self::new();
            *core
                .sandbox
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
            core
        }

        pub fn set_sandbox(&self, configured: bool) {
            *self
                .sandbox
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = configured;
        }

        pub fn set_default_status(&self, status: u16) {
            *self
                .default_status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = status;
        }

        /// Queue one buffered answer (status + JSON body).
        pub fn push_json(&self, status: u16, body: serde_json::Value) {
            self.push_response(CoreResponse {
                status,
                headers: vec![
                    ("content-type".to_owned(), "application/json".to_owned()),
                    ("x-pg-served-by".to_owned(), "core-test-1".to_owned()),
                ],
                body: serde_json::to_vec(&body).unwrap_or_default(),
            });
        }

        pub fn push_response(&self, response: CoreResponse) {
            self.state
                .lock()
                .expect("lock")
                .responses
                .push_back(Ok(response));
        }

        pub fn push_error(&self, error: PoolError) {
            self.state
                .lock()
                .expect("lock")
                .responses
                .push_back(Err(error));
        }

        pub fn calls(&self) -> Vec<RecordedCall> {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .calls
                .clone()
        }

        pub fn last_call(&self) -> Option<RecordedCall> {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .calls
                .last()
                .cloned()
        }

        pub fn call_count(&self) -> usize {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .calls
                .len()
        }

        pub fn clear(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.calls.clear();
            state.responses.clear();
        }
    }

    #[async_trait]
    impl CoreTransport for FakeCore {
        async fn call(&self, request: CoreRequest) -> Result<CoreResponse, PoolError> {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.calls.push(RecordedCall {
                plane: request.plane,
                method: request.method,
                path: request.path.clone(),
                query: request.query.clone(),
                headers: request.headers.clone(),
                body: request.body.clone().unwrap_or_default(),
            });
            if let Some(response) = state.responses.pop_front() {
                return response;
            }
            let status = *self
                .default_status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            Ok(CoreResponse {
                status,
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: br#"{"ok":true}"#.to_vec(),
            })
        }

        async fn open_stream(&self, request: CoreRequest) -> Result<CoreStreamResponse, PoolError> {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.calls.push(RecordedCall {
                plane: request.plane,
                method: request.method,
                path: request.path.clone(),
                query: request.query.clone(),
                headers: request.headers.clone(),
                body: request.body.clone().unwrap_or_default(),
            });
            let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
                Ok(Bytes::from_static(b"event: attempts\ndata: CASHIER\n\n")),
                Ok(Bytes::from_static(b"event: heartbeat\ndata: {}\n\n")),
            ];
            Ok(CoreStreamResponse {
                status: 200,
                headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
                stream: Box::pin(futures_util::stream::iter(chunks)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_upstream::HealthPolicy;
    use serde_json::json;

    #[test]
    fn parse_json_buffer_matches_the_typescript_helper() {
        assert_eq!(parse_json_buffer(b""), json!({}));
        assert_eq!(parse_json_buffer(b"  "), json!({}));
        assert_eq!(parse_json_buffer(b"{\"a\":1}"), json!({"a": 1}));
        assert_eq!(
            parse_json_buffer(b"plain text"),
            json!({ "message": "plain text" })
        );
    }

    #[test]
    fn plane_detection_uses_the_bearer_prefix_only() {
        assert_eq!(plane_for_authorization(None), Plane::Live);
        assert_eq!(
            plane_for_authorization(Some("Bearer pg_live_x")),
            Plane::Live
        );
        assert_eq!(
            plane_for_authorization(Some("Bearer pg_test_x")),
            Plane::Sandbox
        );
        assert_eq!(
            plane_for_authorization(Some("bearer pg_test_x")),
            Plane::Sandbox
        );
        assert_eq!(plane_for_authorization(Some("pg_test_x")), Plane::Live);
        assert_eq!(bearer_of(Some("Bearer abc")), "abc");
        assert_eq!(bearer_of(Some("Token abc")), "");
        assert_eq!(bearer_of(None), "");
    }

    #[test]
    fn relayed_headers_are_the_two_core_headers() {
        let response = CoreResponse {
            status: 200,
            headers: vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("x-pg-served-by".to_owned(), "core-1".to_owned()),
                ("x-pg-min-lsn".to_owned(), "0/16B6C50".to_owned()),
            ],
            body: b"{}".to_vec(),
        };
        assert_eq!(
            relayed_headers(&response),
            vec![
                ("x-pg-served-by".to_owned(), "core-1".to_owned()),
                ("x-pg-min-lsn".to_owned(), "0/16B6C50".to_owned()),
            ]
        );
    }

    #[test]
    fn core_request_headers_cannot_be_spoofed() {
        let meta = CoreRequestMeta {
            channel: pg_upstream::EdgeChannel::Merchant,
            plane: Plane::Sandbox,
            request_id: "req-1",
            client_ip: "203.0.113.9",
            user_agent: Some("Agent"),
            authorization: Some("Bearer token"),
            body_present: true,
            raw_content_type: None,
            min_lsn: None,
            idempotency_key: None,
        };
        let headers = CoreRequest::build_headers(
            &[
                ("x-edge-service", "core-back"),
                ("x-real-client-ip", "1.1.1.1"),
                ("authorization", "Bearer evil"),
                ("content-length", "999"),
            ],
            &meta,
            Some(7),
        )
        .expect("headers");
        let find = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(find("x-edge-service"), Some("merchant-back"));
        assert_eq!(find("x-real-client-ip"), Some("203.0.113.9"));
        assert_eq!(find("authorization"), Some("Bearer token"));
        assert_eq!(find("content-length"), Some("7"));
        assert_eq!(find("x-execution-plane"), Some("SANDBOX"));
        assert_eq!(find("x-sandbox-proxy"), Some("merchant-back"));
    }

    #[test]
    fn pool_defaults_are_the_ts_health_policy() {
        let pool = UpstreamPool::with_defaults(vec!["https://a".to_owned()]);
        assert_eq!(pool.policy(), HealthPolicy::default());
        assert_eq!(HealthPolicy::DEFAULT_FAILURE_THRESHOLD, 3);
    }

    #[tokio::test]
    async fn fake_core_records_and_replays() {
        let core = test_support::FakeCore::new();
        core.push_json(201, json!({ "id": "wal_1" }));
        let request = CoreRequest {
            plane: Plane::Live,
            method: CoreMethod::Post,
            path: "/internal/merchant/wallets".to_owned(),
            query: vec![("page".to_owned(), QueryValue::Integer(2))],
            headers: vec![("authorization".to_owned(), "Bearer x".to_owned())],
            body: Some(b"{}".to_vec()),
            timeout_ms: None,
        };
        let response = core.call(request).await.expect("response");
        assert_eq!(response.status, 201);
        assert_eq!(response.json_body(), json!({ "id": "wal_1" }));
        let call = core.last_call().expect("call");
        assert_eq!(call.url(), "/internal/merchant/wallets?page=2");
        assert_eq!(call.header("authorization"), Some("Bearer x"));
    }
}
