//! The outbound HTTP executor for gateway calls.
//!
//! Port of `ApiConsumer.request` / `send` / `requestToken` in
//! `core-back/engine/apiConsumer/ApiConsumer.ts:445-600`, `:764-893`, plus the SSRF posture of
//! `core-back/lib/webhooks/egress.ts`.
//!
//! Invariants of one call:
//!
//! 1. the URL is validated by [`validate_target_with`], which resolves the name **once** and pins
//!    exactly one address; the HTTP client then connects to that pinned address
//!    (`ClientBuilder::resolve`) while keeping the URL host for `Host` and SNI, so a second DNS
//!    answer can never redirect the request;
//! 2. HTTPS only unless [`EgressPolicy::allow_insecure_http`] is set (development / Fake Rails), no
//!    proxy, no redirects, connect/read/total timeouts and a hard response cap;
//! 3. the body is serialized before the authentication is applied, so a `REQUEST_SIGNATURE` covers
//!    exactly the transmitted bytes;
//! 4. a token method reuses the cached token and refreshes at most once after a 401/403, and a
//!    token never appears in `Debug` output or an error message.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use moka::sync::Cache;
use parking_lot::Mutex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Client, Method};
use serde_json::Value;
use url::Url;

use pg_mtls::ClientTlsPaths;

use crate::auth::ApiConsumerAuth;
use crate::body::{PreparedBody, RequestBody};
use crate::credentials::{
    apply_auth, assert_no_control_characters, place_body_api_key, AuthError, GatewayAuthConfig,
    GatewayCredentials,
};
use crate::error::GatewayError;
use crate::ip_rules::normalize_host;
use crate::target::{validate_target_with, EgressPolicy, ResolvedTarget, Resolver};
use crate::token_cache::{TokenCache, TokenKey, TokenValue};

/// Default gateway response cap (`ApiConsumer.ts:969`): 2 MiB.
pub const MAX_RESPONSE_BYTES: u64 = EgressPolicy::DEFAULT_MAX_RESPONSE_BYTES;
/// `request.timeoutMs ?? config.timeoutMs ?? 15000` (`ApiConsumer.ts:539`).
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// A gateway connect must not hang behind a slow SYN.
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 5_000;
/// `maxJsonDepth ?? 64` (`ApiConsumer.ts:568`).
pub const DEFAULT_MAX_JSON_DEPTH: usize = 64;
/// Token endpoints are given 10 s (`ApiConsumer.ts:823`).
pub const TOKEN_REQUEST_TIMEOUT_MS: u64 = 10_000;
/// `request.retryDelayMs ?? 100` (`ApiConsumer.ts:479`).
pub const DEFAULT_RETRY_DELAY_MS: u64 = 100;
/// `maxRetries ?? 1` (`ApiConsumer.ts:450`).
pub const DEFAULT_MAX_RETRIES: u32 = 1;
/// Bounded pool of per-destination clients (one per host + pinned address + TLS identity).
pub const DEFAULT_CLIENT_CACHE_CAPACITY: u64 = 64;

/// A monotonic-enough wall clock, injected so token expiry is testable.
pub trait Clock: Send + Sync {
    /// Unix milliseconds.
    fn now_ms(&self) -> u64;
}

/// The process clock (`Date.now()`).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
    }
}

/// `ConsumerSideEffect`: whether the step only reads, notifies, or moves money.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SideEffect {
    #[default]
    ReadOnly,
    SendsNotification,
    MovesMoney,
}

impl SideEffect {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "READ_ONLY" => Self::ReadOnly,
            "SENDS_NOTIFICATION" => Self::SendsNotification,
            "MOVES_MONEY" => Self::MovesMoney,
            _ => return None,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "READ_ONLY",
            Self::SendsNotification => "SENDS_NOTIFICATION",
            Self::MovesMoney => "MOVES_MONEY",
        }
    }

    /// A money-moving call is never replayed and its failure is uncertain.
    #[must_use]
    pub const fn moves_money(self) -> bool {
        matches!(self, Self::MovesMoney)
    }
}

/// `ConsumerRetryPolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RetryPolicy {
    #[default]
    Never,
    Safe,
    SafeWithCooldown,
}

impl RetryPolicy {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "NEVER" => Self::Never,
            "SAFE" => Self::Safe,
            "SAFE_WITH_COOLDOWN" => Self::SafeWithCooldown,
            _ => return None,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Never => "NEVER",
            Self::Safe => "SAFE",
            Self::SafeWithCooldown => "SAFE_WITH_COOLDOWN",
        }
    }
}

/// One outbound gateway call.
#[derive(Clone)]
pub struct EgressRequest {
    pub method: Method,
    pub url: String,
    /// Raw query pairs; keys and values are percent-encoded like `encodeURIComponent`.
    pub query: Vec<(String, String)>,
    pub body: RequestBody,
    /// Caller headers, applied before the authentication (which therefore wins).
    pub headers: Vec<(String, String)>,
    pub timeout: Option<Duration>,
    pub side_effect: SideEffect,
    pub retry_policy: RetryPolicy,
    pub point_of_no_return: bool,
    pub max_retries: Option<u32>,
    pub retry_delay: Option<Duration>,
}

impl EgressRequest {
    #[must_use]
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            query: Vec::new(),
            body: RequestBody::None,
            headers: Vec::new(),
            timeout: None,
            side_effect: SideEffect::ReadOnly,
            retry_policy: RetryPolicy::Never,
            point_of_no_return: false,
            max_retries: None,
            retry_delay: None,
        }
    }

    #[must_use]
    pub fn with_body(mut self, body: RequestBody) -> Self {
        self.body = body;
        self
    }

    #[must_use]
    pub fn with_query(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.push((key.into(), value.into()));
        self
    }

    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    #[must_use]
    pub fn with_side_effect(mut self, side_effect: SideEffect) -> Self {
        self.side_effect = side_effect;
        self
    }

    #[must_use]
    pub fn with_retry_policy(mut self, retry_policy: RetryPolicy) -> Self {
        self.retry_policy = retry_policy;
        self
    }

    #[must_use]
    pub fn with_point_of_no_return(mut self, point_of_no_return: bool) -> Self {
        self.point_of_no_return = point_of_no_return;
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    #[must_use]
    pub fn with_max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = Some(max_retries);
        self
    }

    #[must_use]
    pub fn with_retry_delay(mut self, retry_delay: Duration) -> Self {
        self.retry_delay = Some(retry_delay);
        self
    }

    /// A retry is only allowed before money moved (`safePreMoney`).
    #[must_use]
    pub fn safe_pre_money(&self) -> bool {
        !self.side_effect.moves_money() && !self.point_of_no_return
    }

    /// Whether a transport failure of this request is uncertain.
    #[must_use]
    pub fn money_uncertain(&self) -> bool {
        self.side_effect.moves_money() || self.point_of_no_return
    }
}

impl fmt::Debug for EgressRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print header values or a body: they can carry the API key or PANs.
        let mut url = Url::parse(&self.url).ok();
        if let Some(parsed) = url.as_mut() {
            parsed.set_query(None);
        }
        formatter
            .debug_struct("EgressRequest")
            .field("method", &self.method.as_str())
            .field("url", &url.map(|parsed| parsed.to_string()))
            .field(
                "header_names",
                &self
                    .headers
                    .iter()
                    .map(|(name, _)| name.as_str())
                    .collect::<Vec<_>>(),
            )
            .field("body_kind", &self.body_kind_name())
            .field("side_effect", &self.side_effect.as_str())
            .finish()
    }
}

impl EgressRequest {
    fn body_kind_name(&self) -> &'static str {
        match &self.body {
            RequestBody::None => "none",
            RequestBody::Json(_) => "json",
            RequestBody::Form(_) => "form",
            RequestBody::Xml(_) => "xml",
            RequestBody::Text(_) => "text",
            RequestBody::Bytes { .. } => "bytes",
            RequestBody::Multipart(_) => "multipart",
        }
    }
}

/// The gateway answer (`ApiConsumerResponse`, `ApiConsumer.ts:117-124`).
#[derive(Clone, PartialEq)]
pub struct EgressResponse {
    pub ok: bool,
    pub status: u16,
    pub headers: HeaderMap,
    pub raw_text: String,
    /// Parsed JSON when the response was `application/*json*`, otherwise the raw text as a string.
    pub data: Value,
    pub url: String,
}

impl EgressResponse {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    #[must_use]
    pub fn json(&self) -> Option<&Value> {
        match &self.data {
            Value::String(_) => None,
            other => Some(other),
        }
    }

    #[must_use]
    pub fn content_type(&self) -> Option<&str> {
        self.header("content-type")
    }
}

impl fmt::Debug for EgressResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EgressResponse")
            .field("ok", &self.ok)
            .field("status", &self.status)
            .field("url", &self.url)
            .field("raw_text_bytes", &self.raw_text.len())
            .finish()
    }
}

/// The gateway/credential-set context of one call.
#[derive(Debug, Clone)]
pub struct CallContext<'a> {
    pub auth: &'a GatewayAuthConfig,
    pub credentials: &'a GatewayCredentials,
    /// Cache identity (`gatewayId` + `credentialSetId` + `env`).
    pub token_key: TokenKey,
    /// Optional deploy-managed mutual-TLS material; the credential values win when both exist.
    pub tls_paths: Option<&'a ClientTlsPaths>,
}

impl<'a> CallContext<'a> {
    #[must_use]
    pub fn new(
        auth: &'a GatewayAuthConfig,
        credentials: &'a GatewayCredentials,
        token_key: TokenKey,
    ) -> Self {
        Self {
            auth,
            credentials,
            token_key,
            tls_paths: None,
        }
    }

    #[must_use]
    pub fn with_tls_paths(mut self, paths: &'a ClientTlsPaths) -> Self {
        self.tls_paths = Some(paths);
        self
    }
}

/// A rotated refresh token that must be persisted (`rotatingRefreshTokenPersistence`).
#[derive(Clone, PartialEq, Eq)]
pub struct RotatedRefreshToken {
    pub refresh_token: String,
    pub gateway_id: String,
    pub environment: String,
    pub credential_set_id: String,
    pub selector: String,
}

impl fmt::Debug for RotatedRefreshToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RotatedRefreshToken")
            .field("refresh_token", &"<redacted>")
            .field("gateway_id", &self.gateway_id)
            .field("environment", &self.environment)
            .field("credential_set_id", &self.credential_set_id)
            .field("selector", &self.selector)
            .finish()
    }
}

/// Where a rotated refresh token is written.
#[async_trait::async_trait]
pub trait RefreshTokenSink: Send + Sync {
    async fn persist(&self, rotation: &RotatedRefreshToken) -> Result<(), GatewayError>;
}

/// Executor configuration.
#[derive(Clone)]
pub struct EgressConfig {
    pub policy: EgressPolicy,
    pub resolver: Arc<dyn Resolver + Send + Sync>,
    pub connect_timeout: Duration,
    /// Idle timeout between response reads.
    pub read_timeout: Duration,
    /// Hard deadline for the whole exchange, body included.
    pub total_timeout: Duration,
    pub max_json_depth: usize,
    /// Deployment-trusted CAs (PEM). Never populated from tenant input.
    pub trust_roots_pem: Vec<String>,
    pub client_cache_capacity: u64,
    pub token_cache_capacity: usize,
    pub token_margin_ms: u64,
}

impl EgressConfig {
    #[must_use]
    pub fn new(policy: EgressPolicy, resolver: Arc<dyn Resolver + Send + Sync>) -> Self {
        Self {
            policy,
            resolver,
            connect_timeout: Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS),
            read_timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            total_timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_json_depth: DEFAULT_MAX_JSON_DEPTH,
            trust_roots_pem: Vec::new(),
            client_cache_capacity: DEFAULT_CLIENT_CACHE_CAPACITY,
            token_cache_capacity: TokenCache::DEFAULT_CAPACITY,
            token_margin_ms: TokenCache::TS_MARGIN_MS,
        }
    }

    /// Shorter timeouts, for a test or a health probe.
    #[must_use]
    pub fn with_timeouts(mut self, connect: Duration, read: Duration, total: Duration) -> Self {
        self.connect_timeout = connect;
        self.read_timeout = read;
        self.total_timeout = total;
        self
    }

    #[must_use]
    pub fn with_trust_root(mut self, pem: impl Into<String>) -> Self {
        self.trust_roots_pem.push(pem.into());
        self
    }

    #[must_use]
    pub fn with_max_json_depth(mut self, depth: usize) -> Self {
        self.max_json_depth = depth;
        self
    }
}

impl fmt::Debug for EgressConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EgressConfig")
            .field("policy", &self.policy)
            .field("connect_timeout", &self.connect_timeout)
            .field("read_timeout", &self.read_timeout)
            .field("total_timeout", &self.total_timeout)
            .field("max_json_depth", &self.max_json_depth)
            .field("trust_roots", &self.trust_roots_pem.len())
            .field("client_cache_capacity", &self.client_cache_capacity)
            .field("token_margin_ms", &self.token_margin_ms)
            .finish()
    }
}

/// The per-destination client identity. `Debug` prints the TLS digest, never the PEM.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ClientKey {
    host: String,
    address: SocketAddr,
    tls: Option<String>,
}

/// Mutual-TLS material for one credential set.
#[derive(Clone)]
struct TlsIdentity {
    /// Certificate chain followed by the private key, as PEM (what `reqwest::Identity` reads).
    pem: Vec<u8>,
    /// Optional private CA bundle for this credential set.
    ca_pem: Option<Vec<u8>>,
    /// SHA-256 of the material; the client cache key and the only thing `Debug` may show.
    digest: String,
}

impl fmt::Debug for TlsIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TlsIdentity")
            .field("digest", &self.digest)
            .field("has_ca", &self.ca_pem.is_some())
            .finish()
    }
}

impl TlsIdentity {
    fn resolve(context: &CallContext<'_>) -> Result<Self, GatewayError> {
        if let Some(paths) = context.tls_paths {
            return Self::from_paths(paths);
        }
        let certificate = context
            .credentials
            .first(&crate::credentials::TLS_CERTIFICATE_NAMES)
            .ok_or(AuthError::MutualTlsMaterialMissing)?;
        let key = context
            .credentials
            .first(&crate::credentials::TLS_PRIVATE_KEY_NAMES)
            .ok_or(AuthError::MutualTlsMaterialMissing)?;
        let ca = context.credentials.first(&crate::credentials::TLS_CA_NAMES);
        Ok(Self::from_pem(
            certificate.as_bytes(),
            key.as_bytes(),
            ca.map(str::as_bytes),
        ))
    }

    /// Build from inline PEM material (`cert`/`key`/`ca` credential entries).
    fn from_pem(certificate_pem: &[u8], key_pem: &[u8], ca_pem: Option<&[u8]>) -> Self {
        let mut pem = certificate_pem.to_vec();
        if !pem.ends_with(b"\n") {
            pem.push(b'\n');
        }
        pem.extend_from_slice(key_pem);
        let mut digest_input = pem.clone();
        digest_input.push(0);
        if let Some(ca) = ca_pem {
            digest_input.extend_from_slice(ca);
        }
        Self {
            digest: pg_crypto::sha256_hex(&digest_input),
            pem,
            ca_pem: ca_pem.map(<[u8]>::to_vec),
        }
    }

    /// Build from deploy-managed files ([`pg_mtls::ClientTlsPaths`]).
    fn from_paths(paths: &ClientTlsPaths) -> Result<Self, GatewayError> {
        let certificate = std::fs::read(&paths.client_cert).map_err(|error| {
            GatewayError::InvalidRequest(format!(
                "cannot read the mutual TLS certificate {}: {error}",
                paths.client_cert.display()
            ))
        })?;
        let key = std::fs::read(&paths.client_key).map_err(|error| {
            GatewayError::InvalidRequest(format!(
                "cannot read the mutual TLS private key {}: {error}",
                paths.client_key.display()
            ))
        })?;
        let ca = std::fs::read(&paths.ca_cert).map_err(|error| {
            GatewayError::InvalidRequest(format!(
                "cannot read the mutual TLS CA {}: {error}",
                paths.ca_cert.display()
            ))
        })?;
        Ok(Self::from_pem(&certificate, &key, Some(&ca)))
    }
}

/// The gateway HTTP executor.
pub struct EgressClient {
    config: EgressConfig,
    clock: Arc<dyn Clock>,
    tokens: TokenCache,
    token_locks: Mutex<HashMap<TokenKey, Arc<tokio::sync::Mutex<()>>>>,
    rotation: Option<Arc<dyn RefreshTokenSink>>,
    clients: Cache<ClientKey, Client>,
}

impl fmt::Debug for EgressClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EgressClient")
            .field("config", &self.config)
            .field("tokens", &self.tokens)
            .field("clients", &self.clients.entry_count())
            .finish()
    }
}

impl EgressClient {
    pub fn new(config: EgressConfig) -> Result<Self, GatewayError> {
        pg_mtls::install_crypto_provider();
        // Parse the deployment roots once so a bad PEM fails at construction, not per request.
        for root in &config.trust_roots_pem {
            reqwest::Certificate::from_pem_bundle(root.as_bytes()).map_err(|error| {
                GatewayError::InvalidRequest(format!("invalid trust root: {error}"))
            })?;
        }
        Ok(Self {
            tokens: TokenCache::with_margin(config.token_cache_capacity, config.token_margin_ms),
            clients: Cache::builder()
                .max_capacity(config.client_cache_capacity.max(1))
                .build(),
            config,
            clock: Arc::new(SystemClock),
            token_locks: Mutex::new(HashMap::new()),
            rotation: None,
        })
    }

    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    #[must_use]
    pub fn with_rotation_sink(mut self, sink: Arc<dyn RefreshTokenSink>) -> Self {
        self.rotation = Some(sink);
        self
    }

    #[must_use]
    pub fn token_cache(&self) -> &TokenCache {
        &self.tokens
    }

    #[must_use]
    pub fn config(&self) -> &EgressConfig {
        &self.config
    }

    /// Drop one cached token (a rotated credential, a revoked credential set).
    pub fn invalidate_token(&self, key: &TokenKey) {
        self.tokens.invalidate(key);
    }

    /// Execute a call with the TS `request` semantics: refresh once on 401/403, and retry a
    /// transient failure only when the side effect is safe and money did not move.
    pub async fn request(
        &self,
        context: &CallContext<'_>,
        request: EgressRequest,
    ) -> Result<EgressResponse, GatewayError> {
        let safe_pre_money = request.safe_pre_money();
        let maximum_retries = if safe_pre_money && request.retry_policy != RetryPolicy::Never {
            request.max_retries.unwrap_or(DEFAULT_MAX_RETRIES)
        } else {
            0
        };
        let mut network_attempt: u32 = 0;
        loop {
            // Everything below runs inside the TS `try`: a non-2xx answer is thrown as an
            // `ApiConsumerError` and therefore goes through the same retry decision as a
            // transport failure (`ApiConsumer.ts:453-481`).
            let outcome: Result<EgressResponse, GatewayError> =
                match self.send(context, &request).await {
                    Ok(response)
                        if (response.status == 401 || response.status == 403) && safe_pre_money =>
                    {
                        if let Err(error) = self.refresh_auth(context).await {
                            Err(error)
                        } else {
                            // The resend is awaited inside the same `try` in TS, so its answer and its
                            // transport errors are subject to the same retry policy.
                            match self.send(context, &request).await {
                                Ok(refreshed) if refreshed.ok => Ok(refreshed),
                                Ok(refreshed) => Err(http_error(refreshed)),
                                Err(error) => Err(error),
                            }
                        }
                    }
                    Ok(response) if !response.ok => Err(http_error(response)),
                    Ok(response) => Ok(response),
                    Err(error) => Err(error),
                };
            match outcome {
                Ok(response) => return Ok(response),
                Err(error) => {
                    let can_retry = safe_pre_money
                        && request.retry_policy != RetryPolicy::Never
                        && network_attempt < maximum_retries
                        && error.retryable()
                        && !error.money_uncertain();
                    if !can_retry {
                        return Err(error);
                    }
                    network_attempt = network_attempt.saturating_add(1);
                    let delay = request
                        .retry_delay
                        .unwrap_or(Duration::from_millis(DEFAULT_RETRY_DELAY_MS));
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
    }

    /// Fetch (or reuse) the access token for a token method; `None` for every other method.
    pub async fn access_token(
        &self,
        context: &CallContext<'_>,
    ) -> Result<Option<String>, GatewayError> {
        self.access_token_inner(context, false).await
    }

    async fn access_token_inner(
        &self,
        context: &CallContext<'_>,
        force: bool,
    ) -> Result<Option<String>, GatewayError> {
        if !context.auth.method.needs_token_refresh() {
            return Ok(None);
        }
        // Read the refresh token before any stale access token is dropped: a rotating provider
        // issues a refresh token once and a stale `get` removes the whole entry.
        let cached_refresh_token = self
            .tokens
            .peek(&context.token_key)
            .and_then(|value| value.refresh_token);
        let now = self.clock.now_ms();
        if !force {
            if let Some(value) = self.tokens.get(&context.token_key, now) {
                return Ok(Some(value.access_token));
            }
        }
        // One refresh per key: concurrent callers wait and then hit the cache.
        let guard = self.token_lock(&context.token_key);
        let _held = guard.lock().await;
        let now = self.clock.now_ms();
        if !force {
            if let Some(value) = self.tokens.get(&context.token_key, now) {
                return Ok(Some(value.access_token));
            }
        }
        let (value, rotation) = self.fetch_token(context, now, cached_refresh_token).await?;
        let access_token = value.access_token.clone();
        self.tokens.put(context.token_key.clone(), value, now);
        if let Some(refresh_token) = rotation {
            if let Some(sink) = &self.rotation {
                sink.persist(&RotatedRefreshToken {
                    refresh_token,
                    gateway_id: context.token_key.gateway_id.clone(),
                    environment: context.token_key.environment.clone(),
                    credential_set_id: context.token_key.credential_set_id.clone(),
                    selector: context
                        .auth
                        .new_refresh_token_selector
                        .clone()
                        .unwrap_or_else(|| "refresh_token".to_owned()),
                })
                .await?;
            }
        }
        Ok(Some(access_token))
    }

    async fn refresh_auth(&self, context: &CallContext<'_>) -> Result<(), GatewayError> {
        if !context.auth.method.needs_token_refresh() {
            // TS rebuilds the fixed state and retries once; there is nothing to refresh here.
            return Ok(());
        }
        // A forced refresh keeps the cached *refresh* token: invalidating the whole entry would
        // drop a rotated refresh token that the provider will not issue twice.
        self.access_token_inner(context, true).await.map(|_| ())
    }

    async fn send(
        &self,
        context: &CallContext<'_>,
        request: &EgressRequest,
    ) -> Result<EgressResponse, GatewayError> {
        let target = validate_target_with(
            &request.url,
            &self.config.policy,
            self.config.resolver.as_ref(),
        )?;
        let tls = if context.auth.method.requires_client_certificate() {
            Some(TlsIdentity::resolve(context)?)
        } else {
            None
        };
        let access_token = self.access_token(context).await?;

        let mut body = request.body.clone();
        place_body_api_key(context.auth, context.credentials, &mut body)?;
        let prepared = body.prepare()?;

        let mut headers = HeaderMap::new();
        for (name, value) in &request.headers {
            set_header(&mut headers, name, value)?;
        }
        let mut query = request.query.clone();
        apply_auth(
            context.auth,
            context.credentials,
            access_token.as_deref(),
            i64::try_from(self.clock.now_ms() / 1000).unwrap_or(i64::MAX),
            &mut headers,
            &mut query,
            &prepared,
        )?;

        let url = compose_url(&target.url, &query)?;
        verify_final_url(&target, &url)?;
        self.exchange(Exchange {
            target: &target,
            url,
            method: request.method.clone(),
            headers,
            body: Some(prepared),
            tls: tls.as_ref(),
            timeout: request.timeout,
            money_uncertain: request.money_uncertain(),
        })
        .await
    }

    async fn exchange(&self, exchange: Exchange<'_>) -> Result<EgressResponse, GatewayError> {
        let Exchange {
            target,
            url,
            method,
            mut headers,
            body,
            tls,
            timeout,
            money_uncertain,
        } = exchange;
        // TS drops the body for GET and DELETE (`ApiConsumer.ts:550-554`).
        let body_allowed = method != Method::GET && method != Method::DELETE;
        let mut payload: Option<Vec<u8>> = None;
        if let Some(prepared) = body {
            if body_allowed {
                if let Some(bytes) = prepared.bytes {
                    if !headers.contains_key(CONTENT_TYPE) {
                        if let Some(content_type) = prepared.content_type {
                            set_header(&mut headers, "content-type", &content_type)?;
                        }
                    }
                    payload = Some(bytes);
                }
            }
        }

        let client = self.client_for(target, tls)?;
        let mut builder = client.request(method, url.clone()).headers(headers);
        if let Some(bytes) = payload {
            builder = builder.body(bytes);
        }
        if let Some(timeout) = timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| transport_error(error, money_uncertain))?;

        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err(GatewayError::Redirect { status });
        }
        let headers = response.headers().clone();
        let limit = self.config.policy.max_response_bytes;
        self.config
            .policy
            .check_declared_length(response.content_length())
            .map_err(|_| GatewayError::TooLarge {
                limit,
                status: Some(status),
            })?;
        let raw_bytes = self.read_capped(response, status, money_uncertain).await?;
        let raw_text = String::from_utf8_lossy(&raw_bytes).into_owned();
        let content_type = headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_ascii_lowercase);
        if content_type
            .as_deref()
            .is_some_and(|value| value.contains("xml"))
            && contains_dtd(&raw_text)
        {
            return Err(GatewayError::XmlDtd { status, raw_text });
        }

        let mut data = Value::String(raw_text.clone());
        if !raw_text.is_empty()
            && content_type
                .as_deref()
                .is_some_and(|value| value.contains("json"))
        {
            let parsed: Value =
                serde_json::from_str(&raw_text).map_err(|error| GatewayError::InvalidJson {
                    message: error.to_string(),
                    status,
                    raw_text: raw_text.clone(),
                })?;
            check_json_depth(&parsed, self.config.max_json_depth, status, &raw_text)?;
            data = parsed;
        }

        Ok(EgressResponse {
            ok: (200..300).contains(&status),
            status,
            headers,
            raw_text,
            data,
            url: url.to_string(),
        })
    }

    async fn read_capped(
        &self,
        response: reqwest::Response,
        status: u16,
        money_uncertain: bool,
    ) -> Result<Vec<u8>, GatewayError> {
        let limit = self.config.policy.max_response_bytes;
        let mut stream = response.bytes_stream();
        let mut collected: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| transport_error(error, money_uncertain))?;
            if u64::try_from(collected.len())
                .unwrap_or(u64::MAX)
                .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
                > limit
            {
                return Err(GatewayError::TooLarge {
                    limit,
                    status: Some(status),
                });
            }
            collected.extend_from_slice(&chunk);
        }
        Ok(collected)
    }

    async fn fetch_token(
        &self,
        context: &CallContext<'_>,
        now_ms: u64,
        cached_refresh_token: Option<String>,
    ) -> Result<(TokenValue, Option<String>), GatewayError> {
        let method = context.auth.method;
        let endpoint = match method {
            ApiConsumerAuth::RefreshToken => context.auth.refresh_url.as_deref(),
            _ => context.auth.token_endpoint.as_deref(),
        }
        .filter(|value| !value.is_empty())
        .ok_or(AuthError::TokenEndpointRequired {
            method: method.as_str(),
        })?
        .to_owned();
        let target = validate_target_with(
            &endpoint,
            &self.config.policy,
            self.config.resolver.as_ref(),
        )?;

        let client_id = context
            .auth
            .client_id
            .as_deref()
            .and_then(|key| context.credentials.get(key))
            .or_else(|| context.credentials.first(&["clientId", "client_id"]));
        let client_secret = context
            .auth
            .client_secret
            .as_deref()
            .and_then(|key| context.credentials.get(key))
            .or_else(|| {
                context
                    .credentials
                    .first(&["clientSecret", "client_secret"])
            });

        let mut form: Vec<(String, String)> = Vec::new();
        match method {
            ApiConsumerAuth::RefreshToken => {
                form.push(("grant_type".to_owned(), "refresh_token".to_owned()))
            }
            ApiConsumerAuth::UsernamePassword => {
                form.push(("grant_type".to_owned(), "password".to_owned()))
            }
            _ => form.push(("grant_type".to_owned(), "client_credentials".to_owned())),
        }
        if let Some(client_id) = client_id {
            form.push((
                context
                    .auth
                    .username_field
                    .clone()
                    .unwrap_or_else(|| "client_id".to_owned()),
                client_id.to_owned(),
            ));
        }
        if let Some(client_secret) = client_secret {
            form.push((
                context
                    .auth
                    .password_field
                    .clone()
                    .unwrap_or_else(|| "client_secret".to_owned()),
                client_secret.to_owned(),
            ));
        }
        if method == ApiConsumerAuth::UsernamePassword {
            let username = context
                .credentials
                .first(&["username", "user"])
                .ok_or(AuthError::UsernamePasswordMissing)?;
            let password = context
                .credentials
                .get("password")
                .or_else(|| context.credentials.get("pass"))
                .ok_or(AuthError::UsernamePasswordMissing)?;
            form.push((
                context
                    .auth
                    .username_field
                    .clone()
                    .unwrap_or_else(|| "username".to_owned()),
                username.to_owned(),
            ));
            form.push((
                context
                    .auth
                    .password_field
                    .clone()
                    .unwrap_or_else(|| "password".to_owned()),
                password.to_owned(),
            ));
        }
        if method == ApiConsumerAuth::RefreshToken {
            // A rotated refresh token supersedes the stored credential immediately; the sink (when
            // configured) persists it, and TS would otherwise keep the stale credential until the
            // next process start. The cache is read before the stale access token is dropped.
            let refresh_token = cached_refresh_token
                .or_else(|| {
                    context
                        .credentials
                        .first(&["refreshToken", "refresh_token"])
                        .map(str::to_owned)
                })
                .ok_or(AuthError::RefreshTokenMissing)?;
            form.push((
                context
                    .auth
                    .refresh_token_field
                    .clone()
                    .unwrap_or_else(|| "refresh_token".to_owned()),
                refresh_token,
            ));
        }
        if let Some(scope) = context.auth.scope.as_deref() {
            form.push(("scope".to_owned(), scope.to_owned()));
        }

        let mut headers = HeaderMap::new();
        set_header(&mut headers, "content-type", crate::body::FORM_CONTENT_TYPE)?;
        if let (Some(client_id), Some(client_secret)) = (client_id, client_secret) {
            set_header(
                &mut headers,
                "authorization",
                &format!(
                    "Basic {}",
                    base64_encode(&format!("{client_id}:{client_secret}"))
                ),
            )?;
        }
        let response = self
            .exchange(Exchange {
                target: &target,
                url: target.url.clone(),
                method: Method::POST,
                headers,
                body: Some(
                    RequestBody::Form(form)
                        .prepare()
                        .map_err(GatewayError::Body)?,
                ),
                tls: None,
                timeout: Some(Duration::from_millis(TOKEN_REQUEST_TIMEOUT_MS)),
                money_uncertain: false,
            })
            .await?;
        if !response.ok {
            return Err(http_error(response));
        }
        let payload = response.data;

        let access_token = select_string(
            &payload,
            context.auth.access_token_selector.as_deref(),
            &["access_token", "accessToken", "token"],
        )
        .ok_or(AuthError::TokenMissingInResponse)?;
        let refresh_token = select_string(
            &payload,
            context.auth.refresh_token_selector.as_deref(),
            &["refresh_token", "refreshToken"],
        );
        let rotated = select_string(
            &payload,
            context.auth.new_refresh_token_selector.as_deref(),
            &["new_refresh_token", "newRefreshToken"],
        );
        let expires_in = select_string(
            &payload,
            context.auth.expires_in_selector.as_deref(),
            &["expires_in", "expiresIn"],
        )
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|seconds| *seconds > 0);
        let expires_at_ms = expires_in.map(|seconds| {
            now_ms.saturating_add(u64::try_from(seconds).unwrap_or(0).saturating_mul(1000))
        });

        let mut value = TokenValue::new(access_token);
        if let Some(refresh_token) = refresh_token.or_else(|| rotated.clone()) {
            value = value.with_refresh_token(refresh_token);
        }
        if let Some(expires_at_ms) = expires_at_ms {
            value = value.with_expires_at(expires_at_ms);
        }
        if let Some(period) = context.auth.refresh_period_ms.filter(|period| *period > 0) {
            value = value.with_refresh_period(period);
        }
        if let Some(scope) = context.auth.scope.clone() {
            value = value.with_scope(scope);
        }
        Ok((value, rotated))
    }

    fn token_lock(&self, key: &TokenKey) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.token_locks.lock();
        if locks.len() > self.tokens.capacity().saturating_mul(4) {
            locks.clear();
        }
        locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn client_for(
        &self,
        target: &ResolvedTarget,
        tls: Option<&TlsIdentity>,
    ) -> Result<Client, GatewayError> {
        let key = ClientKey {
            host: target.host.clone(),
            address: SocketAddr::new(target.pinned, target.port),
            tls: tls.map(|identity| identity.digest.clone()),
        };
        if let Some(client) = self.clients.get(&key) {
            return Ok(client);
        }
        let client = self.build_client(&key, tls)?;
        self.clients.insert(key, client.clone());
        Ok(client)
    }

    fn build_client(
        &self,
        key: &ClientKey,
        tls: Option<&TlsIdentity>,
    ) -> Result<Client, GatewayError> {
        pg_mtls::install_crypto_provider();
        let mut builder = Client::builder()
            // No redirect: the only acceptable answer is the endpoint's own response.
            .redirect(reqwest::redirect::Policy::none())
            // Never route a pinned gateway connection through an ambient HTTP proxy.
            .no_proxy()
            // Defence in depth; the policy already refuses a non-HTTPS target.
            .https_only(!self.config.policy.allow_insecure_http)
            .connect_timeout(self.config.connect_timeout)
            .read_timeout(self.config.read_timeout)
            .timeout(self.config.total_timeout)
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(8)
            .tls_backend_rustls()
            // The pin: this host always connects to the address that passed validation.
            .resolve(&key.host, key.address);
        for root in &self.config.trust_roots_pem {
            for certificate in
                reqwest::Certificate::from_pem_bundle(root.as_bytes()).map_err(|error| {
                    GatewayError::InvalidRequest(format!("invalid trust root: {error}"))
                })?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        if let Some(identity) = tls {
            if let Some(ca) = &identity.ca_pem {
                for certificate in reqwest::Certificate::from_pem_bundle(ca).map_err(|error| {
                    GatewayError::InvalidRequest(format!(
                        "invalid mutual TLS CA certificate: {error}"
                    ))
                })? {
                    builder = builder.add_root_certificate(certificate);
                }
            }
            let identity = reqwest::Identity::from_pem(&identity.pem).map_err(|error| {
                GatewayError::InvalidRequest(format!("invalid mutual TLS identity: {error}"))
            })?;
            builder = builder.identity(identity);
        }
        builder.build().map_err(|error| {
            GatewayError::InvalidRequest(format!("cannot build the gateway client: {error}"))
        })
    }
}

/// Carries a rotated refresh token beside the value without exposing it in `TokenValue`.
struct Exchange<'a> {
    target: &'a ResolvedTarget,
    url: Url,
    method: Method,
    headers: HeaderMap,
    body: Option<PreparedBody>,
    tls: Option<&'a TlsIdentity>,
    timeout: Option<Duration>,
    money_uncertain: bool,
}

fn http_error(response: EgressResponse) -> GatewayError {
    GatewayError::Http {
        status: response.status,
        raw_text: response.raw_text,
        data: response.data,
    }
}

fn transport_error(error: reqwest::Error, money_uncertain: bool) -> GatewayError {
    let timeout = error.is_timeout();
    // `without_url` keeps an `API_KEY` query value out of the message.
    let message = if timeout {
        "Gateway request timed out".to_owned()
    } else {
        format!("Gateway request failed: {}", error.without_url())
    };
    GatewayError::Transport {
        message: message.chars().take(300).collect(),
        timeout,
        money_uncertain,
    }
}

fn set_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), GatewayError> {
    assert_no_control_characters(name, "header name").map_err(|_| {
        GatewayError::HeaderInjection {
            label: "header name",
        }
    })?;
    assert_no_control_characters(value, "header")
        .map_err(|_| GatewayError::HeaderInjection { label: "header" })?;
    let name = HeaderName::from_bytes(name.trim().as_bytes())
        .map_err(|_| GatewayError::InvalidRequest(format!("invalid header name '{name}'")))?;
    let value = HeaderValue::from_str(value)
        .map_err(|_| GatewayError::InvalidRequest(format!("invalid value for header '{name}'")))?;
    headers.insert(name, value);
    Ok(())
}

/// `encodeURIComponent`: unreserved characters and `!'()*` stay literal, a space becomes `%20`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => encoded.push(char::from(byte)),
            _ => {
                encoded.push('%');
                encoded.push(char::from(HEX[usize::from(byte >> 4)]));
                encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
            }
        }
    }
    encoded
}

fn compose_url(base: &Url, query: &[(String, String)]) -> Result<Url, GatewayError> {
    let mut url = base.clone();
    if query.is_empty() {
        return Ok(url);
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(existing) = url.query().filter(|existing| !existing.is_empty()) {
        parts.push(existing.to_owned());
    }
    for (key, value) in query {
        assert_no_control_characters(key, "query key")
            .map_err(|_| GatewayError::HeaderInjection { label: "query key" })?;
        assert_no_control_characters(value, "query value").map_err(|_| {
            GatewayError::HeaderInjection {
                label: "query value",
            }
        })?;
        parts.push(format!(
            "{}={}",
            encode_uri_component(key),
            encode_uri_component(value)
        ));
    }
    url.set_query(Some(&parts.join("&")));
    Ok(url)
}

fn verify_final_url(target: &ResolvedTarget, url: &Url) -> Result<(), GatewayError> {
    let unchanged = url.scheme() == target.url.scheme()
        && normalize_host(url.host_str().unwrap_or_default()) == target.host
        && url.port_or_known_default() == Some(target.port)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    if unchanged {
        Ok(())
    } else {
        Err(GatewayError::InvalidRequest(
            "the final URL no longer matches the validated destination".to_owned(),
        ))
    }
}

fn contains_dtd(raw_text: &str) -> bool {
    let lowered = raw_text.to_ascii_lowercase();
    lowered.contains("<!doctype") || lowered.contains("<!entity")
}

fn check_json_depth(
    value: &Value,
    limit: usize,
    status: u16,
    raw_text: &str,
) -> Result<(), GatewayError> {
    let mut stack: Vec<(&Value, usize)> = vec![(value, 0)];
    while let Some((current, depth)) = stack.pop() {
        if depth > limit {
            return Err(GatewayError::JsonDepth {
                limit,
                status,
                raw_text: raw_text.to_owned(),
            });
        }
        match current {
            Value::Array(items) => {
                for item in items {
                    stack.push((item, depth.saturating_add(1)));
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    stack.push((item, depth.saturating_add(1)));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn select_string(payload: &Value, selector: Option<&str>, fallback: &[&str]) -> Option<String> {
    if let Some(selector) = selector {
        if let Some(value) = recursive_select(payload, selector).and_then(value_to_string) {
            return Some(value);
        }
    }
    for path in fallback {
        if let Some(value) = recursive_select(payload, path).and_then(value_to_string) {
            return Some(value);
        }
    }
    None
}

fn recursive_select<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return None;
    }
    let mut current = value;
    for segment in path.split('.') {
        if segment.is_empty() || matches!(segment, "__proto__" | "constructor" | "prototype") {
            return None;
        }
        current = current.get(segment)?;
    }
    Some(current)
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn base64_encode(value: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    STANDARD.encode(value.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ip_rules::is_public_ip;
    use crate::target::StaticResolver;

    fn policy() -> EgressPolicy {
        EgressPolicy::new(crate::target::HostAllowlist::new(&["gateway.example"]))
    }

    fn client(policy: EgressPolicy) -> EgressClient {
        EgressClient::new(EgressConfig::new(
            policy,
            Arc::new(StaticResolver::new().with("gateway.example", &["93.184.216.34"])),
        ))
        .expect("client")
    }

    #[test]
    fn encode_uri_component_matches_javascript() {
        assert_eq!(encode_uri_component("a b+c/d"), "a%20b%2Bc%2Fd");
        assert_eq!(encode_uri_component("AZaz09-_.!~*'()"), "AZaz09-_.!~*'()");
        assert_eq!(encode_uri_component("ä"), "%C3%A4");
        assert_eq!(encode_uri_component("\u{1f600}"), "%F0%9F%98%80");
    }

    #[test]
    fn query_pairs_keep_an_existing_query_and_encode_values() {
        let base = Url::parse("https://gateway.example/pay?lang=ar").expect("url");
        let url =
            compose_url(&base, &[("amount".to_owned(), "1.00 2".to_owned())]).expect("compose");
        assert_eq!(
            url.as_str(),
            "https://gateway.example/pay?lang=ar&amount=1.00%202"
        );
        let unchanged = compose_url(&base, &[]).expect("empty");
        assert_eq!(unchanged.as_str(), base.as_str());

        let control =
            compose_url(&base, &[("x".to_owned(), "a\nb".to_owned())]).expect_err("control");
        assert_eq!(control.code(), "HEADER_INJECTION_BLOCKED");
    }

    #[test]
    fn the_final_url_cannot_change_the_destination() {
        let resolver = StaticResolver::new().with("gateway.example", &["93.184.216.34"]);
        let target = validate_target_with("https://gateway.example/pay", &policy(), &resolver)
            .expect("target");
        assert!(verify_final_url(
            &target,
            &Url::parse("https://gateway.example/pay?x=1").expect("same")
        )
        .is_ok());
        for other in [
            "https://other.example/pay",
            "http://gateway.example/pay",
            "https://gateway.example:8443/pay",
            "https://user:pass@gateway.example/pay",
            "https://gateway.example/pay#f",
        ] {
            assert!(
                verify_final_url(&target, &Url::parse(other).expect("url")).is_err(),
                "{other}"
            );
        }
    }

    #[test]
    fn json_depth_is_bounded_like_the_ts_walk() {
        let shallow = serde_json::json!({ "a": { "b": 1 } });
        assert!(check_json_depth(&shallow, 64, 200, "{}").is_ok());
        assert!(check_json_depth(&shallow, 1, 200, "{}").is_err());
        let deep = serde_json::json!([[["x"]]]);
        let error = check_json_depth(&deep, 2, 200, "[[[\"x\"]]]").expect_err("depth");
        assert_eq!(error.code(), "API_JSON_DEPTH_EXCEEDED");
        assert_eq!(error.status(), Some(200));
    }

    #[test]
    fn token_selectors_use_paths_with_forbidden_segments() {
        let payload = serde_json::json!({
            "data": { "access_token": "tok", "expires_in": 3600 },
            "access_token": "top",
            "expiresIn": "120"
        });
        assert_eq!(
            select_string(&payload, Some("data.access_token"), &["access_token"]),
            Some("tok".to_owned())
        );
        assert_eq!(
            select_string(&payload, Some("missing.path"), &["access_token"]),
            Some("top".to_owned())
        );
        assert_eq!(
            select_string(&payload, None, &["expiresIn"]),
            Some("120".to_owned())
        );
        assert_eq!(select_string(&payload, Some("__proto__.x"), &[]), None);
    }

    #[test]
    fn a_xml_response_with_a_doctype_is_refused() {
        assert!(contains_dtd("<!DOCTYPE foo [<!ENTITY x \"y\">]>"));
        assert!(contains_dtd("  <!doctype html>"));
        assert!(contains_dtd("<a><!ENTITY x></a>"));
        assert!(!contains_dtd("<a>ok</a>"));
    }

    #[test]
    fn a_request_debug_never_prints_values_or_bodies() {
        let request =
            EgressRequest::new(Method::POST, "https://gateway.example/pay?api_key=secret")
                .with_header("authorization", "Bearer super-secret")
                .with_body(RequestBody::Json(
                    serde_json::json!({ "pan": "4111111111111111" }),
                ));
        let rendered = format!("{request:?}");
        assert!(!rendered.contains("api_key=secret"));
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("4111111111111111"));
        assert!(rendered.contains("authorization"));
    }

    #[test]
    fn side_effects_and_retry_policies_round_trip() {
        for side_effect in [
            SideEffect::ReadOnly,
            SideEffect::SendsNotification,
            SideEffect::MovesMoney,
        ] {
            assert_eq!(SideEffect::parse(side_effect.as_str()), Some(side_effect));
        }
        for retry in [
            RetryPolicy::Never,
            RetryPolicy::Safe,
            RetryPolicy::SafeWithCooldown,
        ] {
            assert_eq!(RetryPolicy::parse(retry.as_str()), Some(retry));
        }
        assert_eq!(
            SideEffect::parse("MOVES_MONEY"),
            Some(SideEffect::MovesMoney)
        );
        assert!(!SideEffect::ReadOnly.moves_money());
        assert!(SideEffect::MovesMoney.moves_money());
        assert_eq!(SideEffect::parse("READ"), None);
        assert_eq!(RetryPolicy::parse("ALWAYS"), None);
        assert_eq!(SideEffect::default(), SideEffect::ReadOnly);
        assert_eq!(RetryPolicy::default(), RetryPolicy::Never);

        let read = EgressRequest::new(Method::GET, "https://gateway.example/");
        assert!(read.safe_pre_money());
        assert!(!read.money_uncertain());
        let money = EgressRequest::new(Method::POST, "https://gateway.example/")
            .with_side_effect(SideEffect::MovesMoney);
        assert!(!money.safe_pre_money());
        assert!(money.money_uncertain());
        let pinned = EgressRequest::new(Method::POST, "https://gateway.example/")
            .with_point_of_no_return(true);
        assert!(!pinned.safe_pre_money());
        assert!(pinned.money_uncertain());
    }

    #[test]
    fn a_client_is_built_with_the_policy_and_never_logs_a_token() {
        let client = client(policy());
        assert_eq!(
            client.config().policy.max_response_bytes,
            MAX_RESPONSE_BYTES
        );
        assert_eq!(
            client.token_cache().capacity(),
            TokenCache::DEFAULT_CAPACITY
        );
        let key = TokenKey::new("gw-1", "cs-1", "LIVE");
        client
            .token_cache()
            .put(key.clone(), TokenValue::new("super-secret"), 0);
        let rendered = format!("{client:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("EgressClient"));
        client.invalidate_token(&key);
        assert!(client.token_cache().is_empty());
    }

    #[test]
    fn mutual_tls_material_is_read_from_the_credentials() {
        let auth = GatewayAuthConfig::new(ApiConsumerAuth::MutualTls);
        let credentials = GatewayCredentials::from_pairs([
            (
                "certificate",
                "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n",
            ),
            (
                "privateKey",
                "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n",
            ),
            (
                "ca",
                "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
            ),
        ]);
        let context = CallContext::new(&auth, &credentials, TokenKey::new("gw", "cs", "LIVE"));
        let identity = TlsIdentity::resolve(&context).expect("identity");
        assert!(identity.pem.starts_with(b"-----BEGIN CERTIFICATE-----"));
        assert!(identity.pem.windows(3).any(|window| window == b"KEY"));
        assert!(identity.ca_pem.is_some());
        assert_eq!(identity.digest.len(), 64);
        assert!(!format!("{identity:?}").contains("PRIVATE KEY"));

        let missing = GatewayCredentials::new();
        let context = CallContext::new(&auth, &missing, TokenKey::new("gw", "cs", "LIVE"));
        assert_eq!(
            TlsIdentity::resolve(&context).expect_err("missing"),
            GatewayError::Auth(AuthError::MutualTlsMaterialMissing)
        );
    }

    #[test]
    fn headers_cannot_be_injected_through_a_caller_header() {
        let mut headers = HeaderMap::new();
        let error = set_header(&mut headers, "x-test", "value\r\nx-evil: 1").expect_err("crlf");
        assert_eq!(error.code(), "HEADER_INJECTION_BLOCKED");
        let error = set_header(&mut headers, "bad name", "value").expect_err("name");
        assert_eq!(error.code(), "API_REQUEST_INVALID");
        assert!(headers.is_empty());
    }

    #[test]
    fn the_executor_is_send_and_sync_for_the_worker_runtime() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EgressClient>();
        assert_send_sync::<EgressConfig>();
        assert_send_sync::<EgressRequest>();
        assert_send_sync::<EgressResponse>();
        assert_send_sync::<CallContext<'static>>();
    }

    #[test]
    fn a_public_address_is_accepted_by_the_default_policy() {
        assert!(is_public_ip("93.184.216.34".parse().expect("ip")));
    }
}
