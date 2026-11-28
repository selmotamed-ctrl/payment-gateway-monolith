//! Checkout edge → core mTLS client.
//!
//! Port of `checkout-back/lib/coreInternalClient.ts`, `checkout-back/lib/corePools.ts` and
//! `checkout-back/lib/env/index.ts` (`parseCoreBackUrls`, `coreBackUrls`,
//! `sandboxCoreBackUrls`).
//!
//! The rules live in `pg-upstream`; this module is the executor:
//! * one [`UpstreamPool`] per plane, never shared, never falling back from Sandbox to Live;
//! * per-node request with TLS 1.3 and `MTLS_CLIENT_*` material;
//! * `pg_upstream::AttemptLoop` for least-in-flight selection, passive health, half-open probes
//!   and the TS replay rules;
//! * `x-execution-plane: SANDBOX` + `x-sandbox-proxy: checkout-back` on every Sandbox call;
//! * buffered and streaming responses, response-size and idle/total deadlines from chapter 2 §10.

#![forbid(unsafe_code)]

use std::io;
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes as RawBytes;
use futures_util::{Stream, StreamExt};
use ntex::util::Bytes as NtexBytes;
use pg_mtls::ClientTlsPaths;
use pg_upstream::{
    build_core_headers, parse_core_back_urls, resolve_core_url, AttemptDecision, AttemptLoop,
    CoreMethod, CorePoolConfig, CoreRequestMeta, EdgeChannel, HeaderSet, LoopFinish, Plane,
    PoolError, QueryValue, RetryOptions, TransportFailure, UpstreamPool,
};
use url::Url;

use crate::config::CheckoutConfig;

/// The checkout channel name and prefix (`CORE_SERVICE_NAME`, `CORE_CHANNEL_PREFIX`).
pub const CHANNEL: EdgeChannel = EdgeChannel::Checkout;

/// A single request handed to one node.
#[derive(Debug, Clone)]
pub struct CoreHttpRequest {
    pub method: CoreMethod,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Overall request deadline (chapter 2 §10 `CORE_TOTAL_DEADLINE_MS`, or the route override).
    pub total_deadline: Duration,
    /// Per-chunk idle timeout (`CORE_REQUEST_TIMEOUT_MS`, or the SSE deadline).
    pub idle_timeout: Duration,
    /// `CORE_MAX_RESPONSE_BYTES`.
    pub max_response_bytes: u64,
}

/// A complete buffered core response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl CoreResponse {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The body of an established stream: either the live upstream byte stream or a buffered
/// fallback that was drained while retrying another node.
pub enum StreamBody {
    Live(Pin<Box<dyn Stream<Item = Result<NtexBytes, io::Error>> + Send + 'static>>),
    Buffered(Vec<u8>),
}

impl std::fmt::Debug for StreamBody {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Live(_) => formatter.write_str("StreamBody::Live"),
            Self::Buffered(body) => formatter
                .debug_tuple("StreamBody::Buffered")
                .field(&body.len())
                .finish(),
        }
    }
}

/// An established streaming response.
#[derive(Debug)]
pub struct CoreStreamResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: StreamBody,
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

/// A transport failure with the two bits the attempt loop needs.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreTransportError {
    pub failure: TransportFailure,
    /// TS `connectPhase`: nothing reached the wire, so even a non-idempotent method may retry.
    pub connect_phase: bool,
    /// A local pre-flight failure that must be returned as-is (never trips the breaker).
    pub local: Option<PoolError>,
}

impl CoreTransportError {
    #[must_use]
    pub fn new(failure: TransportFailure, connect_phase: bool) -> Self {
        Self {
            failure,
            connect_phase,
            local: None,
        }
    }

    #[must_use]
    pub fn local(error: PoolError) -> Self {
        Self {
            failure: TransportFailure::Other,
            connect_phase: false,
            local: Some(error),
        }
    }

    #[must_use]
    pub fn timeout(connect_phase: bool) -> Self {
        Self::new(TransportFailure::Timeout, connect_phase)
    }
}

/// The socket boundary. The production implementation is [`ReqwestTransport`]; tests provide a
/// deterministic fake so no live core or TLS server is required.
#[async_trait]
pub trait CoreTransport: Send + Sync {
    async fn send(
        &self,
        node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreResponse, CoreTransportError>;

    async fn open(
        &self,
        node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreStreamResponse, CoreTransportError>;
}

/// One logical edge → core call.
#[derive(Debug, Clone)]
pub struct CoreCall {
    pub plane: Plane,
    pub method: CoreMethod,
    pub path: String,
    pub query: Vec<(String, QueryValue)>,
    pub body: Option<Vec<u8>>,
    pub raw_content_type: Option<String>,
    pub extra_headers: Vec<(String, String)>,
    pub request_id: String,
    pub client_ip: String,
    pub user_agent: String,
    pub timeout: Option<Duration>,
    pub retry: RetryOptions,
    /// `x-pg-min-lsn`, when a caller declares a read-consistency requirement.
    pub min_lsn: Option<String>,
}

impl CoreCall {
    #[must_use]
    pub fn new(plane: Plane, method: CoreMethod, path: impl Into<String>) -> Self {
        Self {
            plane,
            method,
            path: path.into(),
            query: Vec::new(),
            body: None,
            raw_content_type: None,
            extra_headers: Vec::new(),
            request_id: String::new(),
            client_ip: String::new(),
            user_agent: String::new(),
            timeout: None,
            retry: RetryOptions::default(),
            min_lsn: None,
        }
    }

    #[must_use]
    pub fn with_identity(
        mut self,
        request_id: impl Into<String>,
        client_ip: impl Into<String>,
        user_agent: impl Into<String>,
    ) -> Self {
        self.request_id = request_id.into();
        self.client_ip = client_ip.into();
        self.user_agent = user_agent.into();
        self
    }

    #[must_use]
    pub fn with_body(mut self, body: Vec<u8>) -> Self {
        self.body = Some(body);
        self
    }

    #[must_use]
    pub fn with_raw_content_type(mut self, content_type: impl Into<String>) -> Self {
        self.raw_content_type = Some(content_type.into());
        self
    }

    #[must_use]
    pub fn with_headers(mut self, headers: Vec<(String, String)>) -> Self {
        self.extra_headers = headers;
        self
    }

    #[must_use]
    pub fn with_query(mut self, query: Vec<(String, QueryValue)>) -> Self {
        self.query = query;
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    #[must_use]
    pub fn with_retry(mut self, retry: RetryOptions) -> Self {
        self.retry = retry;
        self
    }

    #[must_use]
    pub fn with_min_lsn(mut self, lsn: impl Into<String>) -> Self {
        self.min_lsn = Some(lsn.into());
        self
    }
}

/// Executes logical calls against the two independent planes.
pub struct CoreClient {
    live: UpstreamPool,
    sandbox: Option<UpstreamPool>,
    transport: std::sync::Arc<dyn CoreTransport>,
    request_timeout: Duration,
    total_deadline: Duration,
    max_response_bytes: u64,
    clock: std::sync::Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl std::fmt::Debug for CoreClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CoreClient")
            .field("live", &self.live.urls())
            .field("sandbox", &self.sandbox.as_ref().map(UpstreamPool::urls))
            .finish_non_exhaustive()
    }
}

impl CoreClient {
    #[must_use]
    pub fn new(
        core: &CorePoolConfig,
        transport: std::sync::Arc<dyn CoreTransport>,
        request_timeout: Duration,
        total_deadline: Duration,
        max_response_bytes: u64,
    ) -> Self {
        Self {
            live: UpstreamPool::with_defaults(core.live.clone()),
            sandbox: core.sandbox.clone().map(UpstreamPool::with_defaults),
            transport,
            request_timeout,
            total_deadline,
            max_response_bytes,
            clock: std::sync::Arc::new(pg_upstream::now_millis),
        }
    }

    /// Read the pool configuration from a validated edge config.
    pub fn from_config(
        config: &CheckoutConfig,
        transport: std::sync::Arc<dyn CoreTransport>,
    ) -> Self {
        Self::new(
            &config.core,
            transport,
            config.request_timeout,
            config.total_deadline,
            config.max_response_bytes,
        )
    }

    /// Test hook: replace the monotonic clock used for cooldowns.
    #[must_use]
    pub fn with_clock(mut self, clock: std::sync::Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    /// The live pool (read-only, used by health/config tests).
    #[must_use]
    pub fn live_pool(&self) -> &UpstreamPool {
        &self.live
    }

    /// The sandbox pool, when configured.
    #[must_use]
    pub fn sandbox_pool(&self) -> Option<&UpstreamPool> {
        self.sandbox.as_ref()
    }

    fn pool(&self, plane: Plane) -> Result<&UpstreamPool, PoolError> {
        match plane {
            Plane::Live => Ok(&self.live),
            Plane::Sandbox => self
                .sandbox
                .as_ref()
                .ok_or_else(PoolError::sandbox_unavailable),
        }
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn build_request(&self, call: &CoreCall, headers: &HeaderSet, url: Url) -> CoreHttpRequest {
        CoreHttpRequest {
            method: call.method,
            url,
            headers: headers
                .entries()
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
            body: call.body.clone(),
            // Node has an idle timeout and a separate wall-clock deadline:
            // `max(CORE_TOTAL_DEADLINE_MS, timeoutMs)`.
            total_deadline: call.timeout.map_or(self.total_deadline, |timeout| {
                self.total_deadline.max(timeout)
            }),
            idle_timeout: call.timeout.unwrap_or(self.request_timeout),
            max_response_bytes: self.max_response_bytes,
        }
    }

    fn headers(&self, call: &CoreCall) -> Result<HeaderSet, PoolError> {
        let body_present = call.body.is_some();
        let caller: Vec<(&str, &str)> = call
            .extra_headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let meta = CoreRequestMeta {
            channel: CHANNEL,
            plane: call.plane,
            request_id: &call.request_id,
            client_ip: &call.client_ip,
            user_agent: Some(&call.user_agent),
            authorization: None,
            body_present,
            raw_content_type: call.raw_content_type.as_deref(),
            min_lsn: call.min_lsn.as_deref(),
            idempotency_key: None,
        };
        let headers = build_core_headers(&caller, &meta)?;
        // The exact body length the edge writes, never a forwarded `content-length`.
        headers.with_content_length(call.body.as_ref().map(Vec::len))
    }

    fn idempotency_key(call: &CoreCall) -> Option<&str> {
        call.extra_headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("idempotency-key"))
            .map(|(_, value)| value.as_str())
    }

    /// Perform one buffered call.
    pub async fn call(&self, call: CoreCall) -> Result<CoreResponse, PoolError> {
        let pool = self.pool(call.plane)?;
        if pool.is_empty() {
            return Err(PoolError::unavailable());
        }
        let headers = self.headers(&call)?;
        let mut attempt =
            AttemptLoop::new(pool, call.method, Self::idempotency_key(&call), call.retry);
        let mut last_response: Option<CoreResponse> = None;
        loop {
            let now = self.now();
            let Some(node) = attempt.next_node(now) else {
                break;
            };
            let url = match resolve_core_url(CHANNEL, node.url(), &call.path, &call.query) {
                Ok(url) => url,
                Err(error) => return Err(error),
            };
            let request = self.build_request(&call, &headers, url);
            let node_url = node.url().to_owned();
            match self.transport.send(&node_url, request).await {
                Ok(response) => match attempt.record_response(response.status, now) {
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
                    match attempt.record_transport(error.failure, error.connect_phase, now) {
                        AttemptDecision::Retry => {}
                        AttemptDecision::Accept => {}
                        AttemptDecision::Fail(failure) => return Err(failure),
                    }
                }
            }
        }
        match attempt.finish(self.now()) {
            LoopFinish::Response(_) => last_response.ok_or_else(PoolError::unavailable),
            LoopFinish::Error(error) => Err(error),
        }
    }

    /// Establish a stream, retrying only before bytes are relayed (chapter 2 §23).
    pub async fn open_stream(&self, call: CoreCall) -> Result<CoreStreamResponse, PoolError> {
        let pool = self.pool(call.plane)?;
        if pool.is_empty() {
            return Err(PoolError::unavailable());
        }
        let headers = self.headers(&call)?;
        let mut attempt =
            AttemptLoop::new(pool, call.method, Self::idempotency_key(&call), call.retry);
        let mut last_stream: Option<CoreStreamResponse> = None;
        loop {
            let now = self.now();
            let Some(node) = attempt.next_node(now) else {
                break;
            };
            let url = match resolve_core_url(CHANNEL, node.url(), &call.path, &call.query) {
                Ok(url) => url,
                Err(error) => return Err(error),
            };
            let request = self.build_request(&call, &headers, url);
            let node_url = node.url().to_owned();
            match self.transport.open(&node_url, request).await {
                Ok(response) => {
                    let retryable = matches!(response.status, 502..=504)
                        && attempt.attempts_used() < attempt.max_attempts()
                        && pool.has_selectable(attempt.exclusions(), now);
                    if retryable {
                        let status = response.status;
                        let headers = response.headers;
                        let body = match response.body {
                            StreamBody::Buffered(body) => body,
                            StreamBody::Live(mut stream) => {
                                let mut collected = Vec::new();
                                while let Some(chunk) = stream.next().await {
                                    match chunk {
                                        Ok(chunk) => collected.extend_from_slice(&chunk),
                                        Err(_) => break,
                                    }
                                }
                                collected
                            }
                        };
                        let decision = attempt.record_response(status, now);
                        if matches!(decision, AttemptDecision::Accept) {
                            return Ok(CoreStreamResponse {
                                status,
                                headers,
                                body: StreamBody::Buffered(body),
                            });
                        }
                        last_stream = Some(CoreStreamResponse {
                            status,
                            headers,
                            body: StreamBody::Buffered(body),
                        });
                        continue;
                    }
                    match attempt.record_response(response.status, now) {
                        AttemptDecision::Accept => return Ok(response),
                        AttemptDecision::Retry => {
                            last_stream = Some(response);
                        }
                        AttemptDecision::Fail(error) => return Err(error),
                    }
                }
                Err(error) => {
                    if let Some(local) = error.local {
                        return Err(local);
                    }
                    match attempt.record_transport(error.failure, error.connect_phase, now) {
                        AttemptDecision::Retry => {}
                        AttemptDecision::Accept => {}
                        AttemptDecision::Fail(failure) => return Err(failure),
                    }
                }
            }
        }
        match attempt.finish(self.now()) {
            LoopFinish::Response(_) => last_stream.ok_or_else(PoolError::unavailable),
            LoopFinish::Error(error) => Err(error),
        }
    }
}

/// The production transport: reqwest over rustls with the internal client certificate.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl std::fmt::Debug for ReqwestTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ReqwestTransport")
    }
}

impl ReqwestTransport {
    /// Build the client once. TLS 1.3 only, the internal CA as the sole root and the client
    /// identity from `MTLS_CLIENT_CERT_PATH`/`MTLS_CLIENT_KEY_PATH`.
    pub fn new(paths: &ClientTlsPaths, connect_timeout: Duration) -> Result<Self, String> {
        // `reqwest` is built with `rustls-no-provider`: installing the ring provider before the
        // first TLS config avoids a runtime panic inside rustls.
        pg_mtls::install_crypto_provider();
        let tls = pg_mtls::client_config(paths).map_err(|error| error.to_string())?;
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(tls.config.as_ref().clone())
            .connect_timeout(connect_timeout)
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(64)
            .tcp_keepalive(Duration::from_secs(30))
            // The TypeScript https client does not advertise content encodings; keep the core
            // request headers (and the response size budget) identical.
            .gzip(false)
            .brotli(false)
            .deflate(false)
            .zstd(false)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { client })
    }

    fn method(method: CoreMethod) -> reqwest::Method {
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET)
    }

    fn headers(request: &CoreHttpRequest) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &request.headers {
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                headers.insert(name, value);
            }
        }
        headers
    }

    fn classify(error: &reqwest::Error) -> CoreTransportError {
        CoreTransportError::new(TransportFailure::from_reqwest(error), error.is_connect())
    }

    async fn read_body(
        response: reqwest::Response,
        max_response_bytes: u64,
        idle_timeout: Duration,
    ) -> Result<Vec<u8>, CoreTransportError> {
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        loop {
            match tokio::time::timeout(idle_timeout, stream.next()).await {
                Err(_) => return Err(CoreTransportError::timeout(false)),
                Ok(None) => return Ok(body),
                Ok(Some(Err(error))) => return Err(Self::classify(&error)),
                Ok(Some(Ok(chunk))) => {
                    let received = body.len() as u64 + chunk.len() as u64;
                    if received > max_response_bytes {
                        return Err(CoreTransportError::local(PoolError::response_too_large(
                            max_response_bytes,
                        )));
                    }
                    body.extend_from_slice(&chunk);
                }
            }
        }
    }
}

#[async_trait]
impl CoreTransport for ReqwestTransport {
    async fn send(
        &self,
        _node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreResponse, CoreTransportError> {
        let mut builder = self
            .client
            .request(Self::method(request.method), request.url.clone())
            .timeout(request.total_deadline)
            .headers(Self::headers(&request));
        if let Some(body) = &request.body {
            builder = builder.body(RawBytes::copy_from_slice(body));
        }
        let response = builder
            .send()
            .await
            .map_err(|error| Self::classify(&error))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let body =
            Self::read_body(response, request.max_response_bytes, request.idle_timeout).await?;
        Ok(CoreResponse {
            status,
            headers,
            body,
        })
    }

    async fn open(
        &self,
        _node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreStreamResponse, CoreTransportError> {
        let mut builder = self
            .client
            .request(Self::method(request.method), request.url.clone())
            .timeout(request.total_deadline)
            .headers(Self::headers(&request));
        if let Some(body) = &request.body {
            builder = builder.body(RawBytes::copy_from_slice(body));
        }
        let response = builder
            .send()
            .await
            .map_err(|error| Self::classify(&error))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let stream = response.bytes_stream().map(|result| {
            result
                .map(|chunk| NtexBytes::copy_from_slice(&chunk))
                .map_err(|error| io::Error::other(error.to_string()))
        });
        Ok(CoreStreamResponse {
            status,
            headers,
            body: StreamBody::Live(Box::pin(stream)),
        })
    }
}

/// `consistencyHeader`: `x-pg-min-lsn` only when a non-blank LSN is declared.
#[must_use]
pub fn consistency_header(lsn: Option<&str>) -> Vec<(String, String)> {
    lsn.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| vec![("x-pg-min-lsn".to_owned(), value.to_owned())])
        .unwrap_or_default()
}

/// `coreBackUrls()` with the explicit fallback, used by `config validate`.
pub fn parse_live_urls(raw: Option<&str>, fallback: &str) -> Result<Vec<String>, PoolError> {
    parse_core_back_urls(raw, fallback)
        .map_err(|error| PoolError::config_invalid(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockTransport {
        status: u16,
        calls: Mutex<Vec<(String, CoreHttpRequest)>>,
    }

    #[async_trait]
    impl CoreTransport for MockTransport {
        async fn send(
            &self,
            node_url: &str,
            request: CoreHttpRequest,
        ) -> Result<CoreResponse, CoreTransportError> {
            self.calls
                .lock()
                .expect("lock")
                .push((node_url.to_owned(), request));
            Ok(CoreResponse {
                status: self.status,
                headers: Vec::new(),
                body: b"{}".to_vec(),
            })
        }

        async fn open(
            &self,
            _node_url: &str,
            _request: CoreHttpRequest,
        ) -> Result<CoreStreamResponse, CoreTransportError> {
            Err(CoreTransportError::new(
                TransportFailure::ConnectionRefused,
                true,
            ))
        }
    }

    fn client(transport: std::sync::Arc<dyn CoreTransport>) -> CoreClient {
        let config = CorePoolConfig::from_values(
            Some("https://core-a:4000,https://core-b:4000"),
            "https://core-fallback:4000",
            Some("https://sandbox:4005"),
            None,
        )
        .expect("config");
        CoreClient::new(
            &config,
            transport,
            Duration::from_secs(30),
            Duration::from_secs(300),
            1024,
        )
    }

    #[ntex::test]
    async fn sandbox_plane_never_falls_back_to_live() {
        let config = CorePoolConfig::from_values(
            Some("https://core-a:4000"),
            "https://core-a:4000",
            None,
            None,
        )
        .expect("config");
        let transport = std::sync::Arc::new(MockTransport::default());
        let client = CoreClient::new(
            &config,
            transport,
            Duration::from_secs(30),
            Duration::from_secs(300),
            1024,
        );
        let error = client
            .call(CoreCall::new(
                Plane::Sandbox,
                CoreMethod::Get,
                "/internal/checkout/pay/sbx_1",
            ))
            .await
            .expect_err("sandbox unavailable");
        assert_eq!(error.code(), "SANDBOX_NODE_UNAVAILABLE");
        assert!(client.sandbox_pool().is_none());
    }

    #[ntex::test]
    async fn build_headers_sets_identity_and_sandbox_markers() {
        let transport = std::sync::Arc::new(MockTransport::default());
        let client = client(transport.clone());
        let call = CoreCall::new(
            Plane::Sandbox,
            CoreMethod::Post,
            "/internal/checkout/pay/sbx_1/initiate",
        )
        .with_identity("req-1", "203.0.113.7", "checkout-front/1.0")
        .with_body(br#"{"railCode":"MOAMALAT"}"#.to_vec());
        client.call(call).await.expect("call");
        let calls = transport.calls.lock().expect("lock");
        let (_, request) = calls.first().expect("call");
        assert_eq!(
            request
                .headers
                .iter()
                .find(|(name, _)| name == "x-edge-service")
                .map(|(_, value)| value.as_str()),
            Some("checkout-back")
        );
        assert_eq!(
            request
                .headers
                .iter()
                .find(|(name, _)| name == "x-execution-plane")
                .map(|(_, value)| value.as_str()),
            Some("SANDBOX")
        );
        assert_eq!(
            request
                .headers
                .iter()
                .find(|(name, _)| name == "x-sandbox-proxy")
                .map(|(_, value)| value.as_str()),
            Some("checkout-back")
        );
        assert_eq!(
            request
                .headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .map(|(_, value)| value.as_str()),
            Some("23")
        );
    }

    #[test]
    fn retry_options_and_methods_are_the_contract() {
        let _ = RetryOptions::default();
        assert_eq!(CoreMethod::Get.as_str(), "GET");
        assert_eq!(CoreMethod::Post.as_str(), "POST");
        let config =
            CorePoolConfig::from_values(Some("https://a:4000"), "https://a:4000", None, None)
                .expect("config");
        assert_eq!(config.urls(Plane::Live).expect("live").len(), 1);
    }
}
