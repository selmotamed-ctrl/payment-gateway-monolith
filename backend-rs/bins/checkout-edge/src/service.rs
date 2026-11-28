//! The checkout edge request pipeline.
//!
//! Port of `checkout-back/index.ts` and `checkout-back/api/public/*`:
//! * the global JSON/urlencoded parser runs after the pay limiter and before the API router;
//! * the inbound router runs before both, with its own method guard, raw parser and two limiters;
//! * every handler forwards to the core with `callCore`/`callCoreRaw`/`proxyCoreStream` semantics;
//! * the SSE route relays the core stream and enforces `MAX_STREAMS_PER_IP`.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures_util::{Stream, StreamExt};
use ntex::http::{HeaderMap, Method, StatusCode};
use ntex::util::Bytes as NtexBytes;
use ntex::web::HttpResponse;
use pg_edge::{digest_key_part, resolve_client_ip};
use pg_http::{FixedWindowLimiter, RateDecision};
use pg_upstream::{CoreMethod, Plane, PoolError, QueryValue};

use crate::body::{read_decoded, read_request_body, BodyReadCounter, ParsedBody};
use crate::config::CheckoutConfig;
use crate::core::{CoreCall, CoreClient, CoreResponse, StreamBody};
use crate::error::{
    map_core_http_error, parse_json_buffer, to_public_inbound_error, EdgeFailure, INBOUND_REJECTED,
    INBOUND_UNAVAILABLE,
};
use crate::inbound::{
    inbound_limiter_keys, pick_forwardable_headers, translate_inbound_environment,
    CoreInboundEnvironment,
};
use crate::monetary::assert_no_monetary_fields;
use crate::routes::{under_pay_prefix, Route, RouteMatch};
use crate::validation::{
    parse_cancel, parse_client_event, parse_confirm, parse_inbound_params, parse_initiate,
    parse_resend, parse_sandbox_create, parse_sandbox_patch, parse_sandbox_simulate,
    validate_attempt_id, validate_attempt_token, validate_link_key, validate_public_id,
};

/// The inbound webhook timeout (`checkout-back/api/public/inbound.ts` `timeoutMs: 10_000`).
pub const INBOUND_TIMEOUT: Duration = Duration::from_secs(10);
/// The checkout status stream deadline (chapter 2 §23).
pub const STATUS_STREAM_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// A request as the edge sees it, before any body has been read.
#[derive(Debug, Clone)]
pub struct RequestMeta {
    pub method: Method,
    /// The raw request path (no query string), exactly as `req.path` returns it.
    pub path: String,
    /// The raw query string without the leading `?`.
    pub query: String,
    pub headers: HeaderMap,
    pub peer: Option<SocketAddr>,
    pub request_id: String,
}

impl RequestMeta {
    /// The resolved client address (`TRUSTED_PROXY_CIDRS`; never a raw header from an untrusted
    /// peer).
    #[must_use]
    pub fn client_ip(&self, config: &CheckoutConfig) -> Option<IpAddr> {
        self.peer.map(|peer| {
            let real = self
                .headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok());
            let client = self
                .headers
                .get("x-real-client-ip")
                .and_then(|value| value.to_str().ok());
            resolve_client_ip(peer.ip(), &config.trusted_proxies, real, client)
        })
    }

    /// The `x-real-client-ip` value forwarded to core (empty when the peer is unknown).
    #[must_use]
    pub fn client_ip_string(&self, config: &CheckoutConfig) -> String {
        self.client_ip(config)
            .map_or_else(String::new, |address| address.to_string())
    }

    #[must_use]
    pub fn user_agent(&self) -> String {
        self.headers
            .get(ntex::http::header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    }

    /// The raw path segments (for mount detection and inbound channel keys).
    #[must_use]
    pub fn segments(&self) -> Vec<String> {
        crate::routes::path_segments(&self.path)
    }
}

/// The three top-level pipeline classes of the TS app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// `app.get("/health")`, before both body parsers.
    Health,
    /// `app.use("/api/v1/inbound", inboundRouter)`, before the pay limiter and the parsers.
    Inbound,
    /// Everything else: pay limiter (when mounted) → JSON/urlencoded → api router → 404.
    Api,
}

/// A per-IP stream slot; dropping it releases the slot (request end, client abort or upstream
/// error).
pub struct StreamSlot {
    service: Arc<EdgeService>,
    key: String,
}

impl std::fmt::Debug for StreamSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StreamSlot")
            .field("key", &self.key)
            .finish()
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut slots = self
            .service
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = slots.get(&self.key).copied().unwrap_or(1);
        if current <= 1 {
            slots.remove(&self.key);
        } else {
            slots.insert(self.key.clone(), current - 1);
        }
    }
}

struct GuardedStream {
    inner: Pin<Box<dyn Stream<Item = Result<NtexBytes, io::Error>> + Send + 'static>>,
    _slot: StreamSlot,
}

impl Stream for GuardedStream {
    type Item = Result<NtexBytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

/// The checkout edge.
pub struct EdgeService {
    config: Arc<CheckoutConfig>,
    core: Arc<CoreClient>,
    pay_limiter: FixedWindowLimiter,
    return_limiter: FixedWindowLimiter,
    certificate_limiter: FixedWindowLimiter,
    inbound_client_limiter: FixedWindowLimiter,
    inbound_channel_limiter: FixedWindowLimiter,
    streams: Mutex<HashMap<String, usize>>,
    body_reads: BodyReadCounter,
    started: Instant,
    stream_sequence: AtomicU64,
}

impl std::fmt::Debug for EdgeService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EdgeService")
            .field("config", &self.config)
            .field("core", &self.core)
            .finish_non_exhaustive()
    }
}

impl EdgeService {
    #[must_use]
    pub fn new(config: Arc<CheckoutConfig>, core: Arc<CoreClient>) -> Self {
        Self {
            pay_limiter: FixedWindowLimiter::new(config.pay_rate_limit_window, 50_000),
            return_limiter: FixedWindowLimiter::new(config.pay_rate_limit_window, 50_000),
            certificate_limiter: FixedWindowLimiter::new(config.pay_rate_limit_window, 50_000),
            inbound_client_limiter: FixedWindowLimiter::new(
                config.inbound_rate_limit_window,
                50_000,
            ),
            inbound_channel_limiter: FixedWindowLimiter::new(
                config.inbound_rate_limit_window,
                50_000,
            ),
            config,
            core,
            streams: Mutex::new(HashMap::new()),
            body_reads: BodyReadCounter::default(),
            started: Instant::now(),
            stream_sequence: AtomicU64::new(0),
        }
    }

    #[must_use]
    pub fn config(&self) -> &Arc<CheckoutConfig> {
        &self.config
    }

    #[must_use]
    pub fn core(&self) -> &Arc<CoreClient> {
        &self.core
    }

    /// Test hook: how many body reads have started (proves a limiter ran before the body).
    #[must_use]
    pub fn body_reads(&self) -> u64 {
        self.body_reads.get()
    }

    /// Test hook: stream slots currently open for one address.
    #[must_use]
    pub fn active_streams(&self, ip: &str) -> usize {
        self.streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(ip)
            .copied()
            .unwrap_or(0)
    }

    #[must_use]
    pub fn started(&self) -> Instant {
        self.started
    }

    #[must_use]
    pub fn classify(&self, meta: &RequestMeta) -> Classification {
        let segments = meta.segments();
        if segments.len() == 1
            && segments[0].eq_ignore_ascii_case("health")
            && (meta.method == Method::GET || meta.method == Method::HEAD)
        {
            return Classification::Health;
        }
        if crate::routes::under_inbound_prefix(&segments) {
            return Classification::Inbound;
        }
        Classification::Api
    }

    /// `app.use("/api/v1/pay", payLimiter)`: runs before the JSON parser for any path under the
    /// mount, including an unknown sub-path.
    pub fn check_pay_limiter(&self, meta: &RequestMeta) -> Option<HttpResponse> {
        let segments = meta.segments();
        if !under_pay_prefix(&segments) {
            return None;
        }
        let key = self.config.limiter_key(meta.client_ip(&self.config));
        let decision = self.pay_limiter.check(&key, self.config.pay_rate_limit_max);
        (!decision.allowed).then(|| {
            rate_limited_response(
                EdgeFailure::rate_limited("Too many checkout requests, please retry later"),
                decision,
            )
        })
    }

    /// `GET /health` (`app.get` before the parsers).
    #[must_use]
    pub fn health(&self) -> HttpResponse {
        let body = pg_http::EdgeHealth::new(
            "checkout-back",
            &self.config.release,
            &self.config.commit,
            self.started.elapsed().as_secs(),
        );
        json_response(
            StatusCode::OK,
            &serde_json::to_value(body).unwrap_or_default(),
        )
    }

    /// The global body parser (`express.json` + `express.urlencoded`). Returns
    /// [`ParsedBody::Missing`] when no parser matches the content type.
    pub async fn read_body(
        &self,
        meta: &RequestMeta,
        payload: ntex::web::types::Payload,
    ) -> Result<ParsedBody, EdgeFailure> {
        read_request_body(
            payload,
            &meta.headers,
            self.config.json_limit,
            Some(&self.body_reads),
        )
        .await
    }

    /// `POST|GET /api/v1/inbound/:gateway/:env/:pathToken` and the router-level guards.
    pub async fn handle_inbound(
        self: &Arc<Self>,
        meta: RequestMeta,
        payload: ntex::web::types::Payload,
    ) -> HttpResponse {
        // The method guard is the first router middleware.
        if !matches!(meta.method, Method::GET | Method::HEAD | Method::POST) {
            let mut response = HttpResponse::builder(StatusCode::METHOD_NOT_ALLOWED);
            response.header("allow", "GET, HEAD, POST");
            return response
                .content_type("application/json; charset=utf-8")
                .body(
                    serde_json::to_vec(&serde_json::json!({
                        "code": "METHOD_NOT_ALLOWED",
                        "message": "Only GET and POST are accepted",
                    }))
                    .unwrap_or_default(),
                );
        }

        let segments = meta.segments();
        let inbound_segments: Vec<&str> = segments.iter().skip(3).map(String::as_str).collect();
        // The limiter is keyed on the raw path (Express `req.path`), the validation and the core
        // path use the `decodeURIComponent` form.
        let client_key = self.config.limiter_key(meta.client_ip(&self.config));
        let keys = inbound_limiter_keys(&client_key, &inbound_segments);

        let client_limit = self.config.inbound_rate_limit_max.saturating_mul(5);
        let client_decision = self
            .inbound_client_limiter
            .check(&keys.client, client_limit);
        if !client_decision.allowed {
            return rate_limited_response(
                EdgeFailure::rate_limited("Inbound webhook rate limit exceeded"),
                client_decision,
            );
        }
        let channel_decision = self
            .inbound_channel_limiter
            .check(&keys.channel, self.config.inbound_rate_limit_max);
        if !channel_decision.allowed {
            return rate_limited_response(
                EdgeFailure::rate_limited("Inbound webhook rate limit exceeded"),
                channel_decision,
            );
        }

        let raw = match read_decoded(
            payload,
            &meta.headers,
            self.config.inbound_limit,
            Some(&self.body_reads),
        )
        .await
        {
            Ok(raw) => raw,
            Err(failure) => return failure.to_response(),
        };

        if inbound_segments.len() != 3 {
            return EdgeFailure::not_found(meta.method.as_str(), &meta.path).to_response();
        }
        let mut decoded = Vec::with_capacity(3);
        for segment in &inbound_segments {
            match crate::routes::decode_segment(segment) {
                Some(value) => decoded.push(value),
                None => return EdgeFailure::body_parser(400).to_response(),
            }
        }
        let params = match parse_inbound_params(&decoded[0], &decoded[1], &decoded[2]) {
            Ok(params) => params,
            Err(failure) => return failure.to_response(),
        };
        let environment = match translate_inbound_environment(&params.env) {
            Ok(environment) => environment,
            Err(failure) => return failure.to_response(),
        };
        let plane = match environment {
            CoreInboundEnvironment::Sandbox => Plane::Sandbox,
            CoreInboundEnvironment::Live => Plane::Live,
        };
        let method = match meta.method {
            Method::GET => CoreMethod::Get,
            Method::HEAD => CoreMethod::Head,
            _ => CoreMethod::Post,
        };
        let path = format!(
            "/internal/checkout/inbound/{}/{}/{}",
            encode_uri_component(&params.gateway),
            environment.as_str(),
            encode_uri_component(&params.path_token)
        );
        let content_type = meta
            .headers
            .get(ntex::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut call = CoreCall::new(plane, method, path)
            .with_identity(
                meta.request_id.clone(),
                meta.client_ip_string(&self.config),
                meta.user_agent(),
            )
            .with_headers(pick_forwardable_headers(&meta.headers))
            .with_body(raw)
            .with_timeout(INBOUND_TIMEOUT);
        if let Some(content_type) = content_type {
            call = call.with_raw_content_type(content_type);
        }
        let response = match self.core.call(call).await {
            Ok(response) => response,
            Err(error) => {
                let failure = if error.status() == 400 && error.code() == "CORE_HEADER_INVALID" {
                    INBOUND_REJECTED.to_failure()
                } else {
                    INBOUND_UNAVAILABLE.to_failure()
                };
                return failure.to_response();
            }
        };
        if response.status >= 400 {
            return to_public_inbound_error(response.status).to_response();
        }
        inbound_success_response(response)
    }

    /// The `apiRouter` (`/api/v1`), after the pay limiter and the global body parser.
    pub async fn handle_api(
        self: &Arc<Self>,
        meta: RequestMeta,
        matched: RouteMatch,
        body: ParsedBody,
    ) -> HttpResponse {
        if matched.malformed_path {
            return EdgeFailure::body_parser(400).to_response();
        }
        match self.dispatch_api(&meta, &matched, &body).await {
            Ok(response) => response,
            Err(failure) => failure.to_response(),
        }
    }

    async fn dispatch_api(
        self: &Arc<Self>,
        meta: &RequestMeta,
        matched: &RouteMatch,
        body: &ParsedBody,
    ) -> Result<HttpResponse, EdgeFailure> {
        match matched.route {
            Route::Health => Ok(self.health()),
            Route::Inbound => Err(EdgeFailure::not_found(meta.method.as_str(), &meta.path)),
            Route::PayLink => {
                let link_key = validate_link_key(require_param(&matched.link_key)?)?;
                let path = format!("/internal/checkout/pay/{}", encode_uri_component(&link_key));
                let call =
                    self.api_call(meta, Plane::from_link_key(&link_key), CoreMethod::Get, path);
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::Initiate => {
                assert_no_monetary_fields(body.as_value())?;
                let link_key = validate_link_key(require_param(&matched.link_key)?)?;
                let payload = parse_initiate(body.as_value())?;
                let path = format!(
                    "/internal/checkout/pay/{}/initiate",
                    encode_uri_component(&link_key)
                );
                let call = self
                    .api_call(
                        meta,
                        Plane::from_link_key(&link_key),
                        CoreMethod::Post,
                        path,
                    )
                    .with_body(serde_json::to_vec(&payload).unwrap_or_default());
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::CREATED, &value))
            }
            Route::AttemptLogs => {
                let (link_key, attempt_id) = self.link_and_attempt(matched)?;
                let path = format!(
                    "/internal/checkout/pay/{}/logs/{}",
                    encode_uri_component(&link_key),
                    encode_uri_component(&attempt_id)
                );
                let call =
                    self.api_call(meta, Plane::from_link_key(&link_key), CoreMethod::Get, path);
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::AttemptStatus => {
                let (link_key, attempt_id) = self.link_and_attempt(matched)?;
                let path = format!(
                    "/internal/checkout/pay/{}/logs/{}/status",
                    encode_uri_component(&link_key),
                    encode_uri_component(&attempt_id)
                );
                self.proxy_status_stream(meta, Plane::from_link_key(&link_key), path)
                    .await
            }
            Route::Confirm | Route::Resend | Route::Cancel | Route::ClientEvent => {
                assert_no_monetary_fields(body.as_value())?;
                let (link_key, attempt_id) = self.link_and_attempt(matched)?;
                let (payload, suffix) = match matched.route {
                    Route::Confirm => (parse_confirm(body.as_value())?, "confirm"),
                    Route::Resend => (parse_resend(Some(&body.value_or_empty_object()))?, "resend"),
                    Route::Cancel => (parse_cancel(Some(&body.value_or_empty_object()))?, "cancel"),
                    Route::ClientEvent => (parse_client_event(body.as_value())?, "client-event"),
                    _ => return Err(EdgeFailure::server_error()),
                };
                let path = format!(
                    "/internal/checkout/pay/{}/logs/{}/{}",
                    encode_uri_component(&link_key),
                    encode_uri_component(&attempt_id),
                    suffix
                );
                let call = self
                    .api_call(
                        meta,
                        Plane::from_link_key(&link_key),
                        CoreMethod::Post,
                        path,
                    )
                    .with_body(serde_json::to_vec(&payload).unwrap_or_default());
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::SandboxAccountsList => {
                let link_key = validate_link_key(require_param(&matched.link_key)?)?;
                assert_sandbox_link(&link_key)?;
                let mut query = Vec::new();
                if let Some(rail_code) =
                    single_query_value(&meta.query, "railCode").filter(|value| !value.is_empty())
                {
                    query.push(("railCode".to_owned(), QueryValue::Text(rail_code)));
                }
                let path = format!(
                    "/internal/checkout/pay/{}/sandbox-accounts",
                    encode_uri_component(&link_key)
                );
                let call = self
                    .api_call(meta, Plane::Sandbox, CoreMethod::Get, path)
                    .with_query(query);
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::SandboxAccountsCreate => {
                let link_key = validate_link_key(require_param(&matched.link_key)?)?;
                assert_sandbox_link(&link_key)?;
                let payload = parse_sandbox_create(body.as_value())?;
                let path = format!(
                    "/internal/checkout/pay/{}/sandbox-accounts",
                    encode_uri_component(&link_key)
                );
                let call = self
                    .api_call(meta, Plane::Sandbox, CoreMethod::Post, path)
                    .with_body(serde_json::to_vec(&payload).unwrap_or_default());
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::CREATED, &value))
            }
            Route::SandboxAccountMovements => {
                let (link_key, account_id) = self.link_and_account(matched)?;
                assert_sandbox_link(&link_key)?;
                let path = format!(
                    "/internal/checkout/pay/{}/sandbox-accounts/{}/movements",
                    encode_uri_component(&link_key),
                    encode_uri_component(&account_id)
                );
                let call = self.api_call(meta, Plane::Sandbox, CoreMethod::Get, path);
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::SandboxAccountPatch => {
                let (link_key, account_id) = self.link_and_account(matched)?;
                assert_sandbox_link(&link_key)?;
                let payload = parse_sandbox_patch(body.as_value())?;
                let path = format!(
                    "/internal/checkout/pay/{}/sandbox-accounts/{}",
                    encode_uri_component(&link_key),
                    encode_uri_component(&account_id)
                );
                let call = self
                    .api_call(meta, Plane::Sandbox, CoreMethod::Patch, path)
                    .with_body(serde_json::to_vec(&payload).unwrap_or_default());
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::SandboxInspector => {
                let (link_key, attempt_id) = self.link_and_attempt(matched)?;
                assert_sandbox_link(&link_key)?;
                let path = format!(
                    "/internal/checkout/pay/{}/logs/{}/sandbox-inspector",
                    encode_uri_component(&link_key),
                    encode_uri_component(&attempt_id)
                );
                let call = self.api_call(meta, Plane::Sandbox, CoreMethod::Get, path);
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::SandboxSimulate => {
                let (link_key, attempt_id) = self.link_and_attempt(matched)?;
                assert_sandbox_link(&link_key)?;
                let payload = parse_sandbox_simulate(body.as_value())?;
                let path = format!(
                    "/internal/checkout/pay/{}/logs/{}/sandbox-simulate",
                    encode_uri_component(&link_key),
                    encode_uri_component(&attempt_id)
                );
                let call = self
                    .api_call(meta, Plane::Sandbox, CoreMethod::Post, path)
                    .with_body(serde_json::to_vec(&payload).unwrap_or_default());
                let (_, _, value) = self.call_json(call).await?;
                Ok(json_response(StatusCode::OK, &value))
            }
            Route::Return => {
                let token = validate_attempt_token(require_param(&matched.attempt_token)?)?;
                self.handle_return(meta, token).await
            }
            Route::Certificate => {
                let public_id = validate_public_id(require_param(&matched.public_id)?)?;
                self.handle_certificate(meta, public_id).await
            }
        }
    }

    fn link_and_attempt(&self, matched: &RouteMatch) -> Result<(String, String), EdgeFailure> {
        let link_key = validate_link_key(require_param(&matched.link_key)?)?;
        let attempt_id = validate_attempt_id(require_param(&matched.attempt_id)?)?;
        Ok((link_key, attempt_id))
    }

    fn link_and_account(&self, matched: &RouteMatch) -> Result<(String, String), EdgeFailure> {
        let link_key = validate_link_key(require_param(&matched.link_key)?)?;
        let account_id = validate_account_id(require_param(&matched.account_id)?)?;
        Ok((link_key, account_id))
    }

    fn api_call(
        &self,
        meta: &RequestMeta,
        plane: Plane,
        method: CoreMethod,
        path: String,
    ) -> CoreCall {
        CoreCall::new(plane, method, path).with_identity(
            meta.request_id.clone(),
            meta.client_ip_string(&self.config),
            meta.user_agent(),
        )
    }

    async fn call_json(
        &self,
        call: CoreCall,
    ) -> Result<(u16, Vec<u8>, serde_json::Value), EdgeFailure> {
        let response = self.core.call(call).await.map_err(map_pool_error)?;
        let value = parse_json_buffer(&response.body);
        if response.status >= 400 {
            return Err(map_core_http_error(response.status, &value));
        }
        let serialized = serde_json::to_vec(&value).unwrap_or(response.body);
        Ok((response.status, serialized, value))
    }

    async fn handle_return(
        &self,
        meta: &RequestMeta,
        attempt_token: String,
    ) -> Result<HttpResponse, EdgeFailure> {
        let decision = self.return_limiter.check(
            &return_limiter_key(&self.config, meta),
            self.config.pay_rate_limit_max,
        );
        if !decision.allowed {
            return Err(EdgeFailure::rate_limited(
                "Too many return callbacks, please retry later",
            ));
        }
        let path = format!(
            "/internal/checkout/return/{}",
            encode_uri_component(&attempt_token)
        );
        let mut call = self.api_call(meta, Plane::Live, CoreMethod::Get, path);
        // TS: `method: req.method === "GET" ? "GET" : "POST"`. Express routes HEAD through the
        // GET handler but `req.method` remains HEAD, so a HEAD probe becomes a POST (parity).
        if meta.method == Method::GET {
            let query = single_value_query(&meta.query);
            call = call.with_query(query);
        } else {
            call.method = CoreMethod::Post;
            call = call.with_body(
                serde_json::to_vec(&serde_json::json!({
                    "hint": "browser_return"
                }))
                .unwrap_or_default(),
            );
        }
        let (_, _, value) = self.call_json(call).await?;
        let reference = value
            .get("reference")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty());
        let location = self.build_status_url(&attempt_token, reference);
        let mut response = HttpResponse::builder(StatusCode::FOUND);
        response.header("location", location.clone());
        Ok(response
            .content_type("text/plain; charset=utf-8")
            .body(format!("Found. Redirecting to {location}")))
    }

    #[must_use]
    pub fn build_status_url(&self, attempt_token: &str, reference: Option<&str>) -> String {
        build_status_url(
            &self.config.checkout_front_base_url,
            &self.config.checkout_front_status_path,
            attempt_token,
            reference,
        )
    }

    async fn handle_certificate(
        &self,
        meta: &RequestMeta,
        public_id: String,
    ) -> Result<HttpResponse, EdgeFailure> {
        let decision = self.certificate_limiter.check(
            &format!(
                "{}|certificate",
                self.config.limiter_key(meta.client_ip(&self.config))
            ),
            self.config.pay_rate_limit_max,
        );
        if !decision.allowed {
            return Err(EdgeFailure::rate_limited(
                "Too many certificate verification requests, please retry later",
            ));
        }
        let path = format!(
            "/internal/checkout/academy/certificates/{}",
            encode_uri_component(&public_id)
        );
        let call = self.api_call(meta, Plane::Live, CoreMethod::Get, path);
        let (_, _, value) = self.call_json(call).await?;
        let body = serde_json::to_vec(&value).unwrap_or_default();
        let mut response = HttpResponse::builder(StatusCode::OK);
        response.header("cache-control", "no-store");
        Ok(response
            .content_type("application/json; charset=utf-8")
            .body(body))
    }

    async fn proxy_status_stream(
        self: &Arc<Self>,
        meta: &RequestMeta,
        plane: Plane,
        path: String,
    ) -> Result<HttpResponse, EdgeFailure> {
        let client_ip = meta.client_ip_string(&self.config);
        // TS keys the stream slots by the resolved client address (not the /56 limiter group).
        let slot_key = if client_ip.is_empty() {
            "unknown".to_owned()
        } else {
            client_ip
        };
        let slot = self.acquire_stream_slot(&slot_key)?;
        let call = self
            .api_call(meta, plane, CoreMethod::Get, path)
            .with_timeout(STATUS_STREAM_TIMEOUT);
        let response = match self.core.open_stream(call).await {
            Ok(response) => response,
            Err(error) => {
                return Err(map_pool_error(error));
            }
        };
        if response.status >= 400 {
            let body = match response.body {
                StreamBody::Buffered(body) => body,
                StreamBody::Live(mut stream) => {
                    let mut collected = Vec::new();
                    while let Some(chunk) = stream.next().await {
                        if let Ok(chunk) = chunk {
                            if collected.len() as u64 + chunk.len() as u64
                                > self.config.max_response_bytes
                            {
                                return Err(map_pool_error(PoolError::response_too_large(
                                    self.config.max_response_bytes,
                                )));
                            }
                            collected.extend_from_slice(&chunk);
                        }
                    }
                    collected
                }
            };
            let value = parse_json_buffer(&body);
            return Err(map_core_http_error(response.status, &value));
        }
        let content_type = response
            .header("content-type")
            .unwrap_or("text/event-stream")
            .to_owned();
        let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::OK);
        let mut builder = HttpResponse::builder(status);
        builder.content_type(content_type);
        builder.header("cache-control", "no-cache, no-transform");
        builder.header("connection", "keep-alive");
        builder.header("x-accel-buffering", "no");
        match response.body {
            StreamBody::Buffered(body) => {
                drop(slot);
                Ok(builder.body(body))
            }
            StreamBody::Live(stream) => {
                let guarded = GuardedStream {
                    inner: stream,
                    _slot: slot,
                };
                Ok(builder.streaming(Box::pin(guarded)))
            }
        }
    }

    fn acquire_stream_slot(self: &Arc<Self>, key: &str) -> Result<StreamSlot, EdgeFailure> {
        let mut slots = self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = slots.get(key).copied().unwrap_or(0);
        if current >= self.config.max_streams_per_ip {
            return Err(EdgeFailure::new(
                429,
                "STREAM_LIMIT_REACHED",
                "Too many concurrent event streams for this client",
            ));
        }
        slots.insert(key.to_owned(), current + 1);
        let _sequence = self.stream_sequence.fetch_add(1, Ordering::Relaxed);
        drop(slots);
        Ok(StreamSlot {
            service: Arc::clone(self),
            key: key.to_owned(),
        })
    }
}

fn require_param(value: &Option<String>) -> Result<&str, EdgeFailure> {
    value.as_deref().ok_or_else(EdgeFailure::server_error)
}

fn assert_sandbox_link(link_key: &str) -> Result<(), EdgeFailure> {
    if link_key.starts_with("sbx_") {
        Ok(())
    } else {
        Err(EdgeFailure::sandbox_inspector_forbidden())
    }
}

fn validate_account_id(raw: &str) -> Result<String, EdgeFailure> {
    let length = raw.chars().count();
    if length == 0 {
        return Err(EdgeFailure::validation(serde_json::json!([{
            "code": "too_small",
            "path": ["accountId"],
            "message": "Too small: expected string to have >= 1 character",
        }])));
    }
    if length > 128 {
        return Err(EdgeFailure::validation(serde_json::json!([{
            "code": "too_big",
            "path": ["accountId"],
            "message": "Too big: expected string to have <= 128 characters",
        }])));
    }
    Ok(raw.to_owned())
}

/// Port of `buildStatusUrl` (`checkout-back/api/public/return.ts:34-43`).
#[must_use]
pub fn build_status_url(
    base_url: &str,
    status_path: &str,
    attempt_token: &str,
    reference: Option<&str>,
) -> String {
    let base = base_url.trim_end_matches('/');
    let status_path = if status_path.starts_with('/') {
        status_path.to_owned()
    } else {
        format!("/{status_path}")
    };
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("attempt_token", attempt_token);
    if let Some(reference) = reference.filter(|value| !value.is_empty()) {
        serializer.append_pair("reference", reference);
    }
    format!("{base}{status_path}?{}", serializer.finish())
}

fn map_pool_error(error: PoolError) -> EdgeFailure {
    EdgeFailure::new(error.status(), error.code(), error.message())
}

fn rate_limited_response(failure: EdgeFailure, decision: RateDecision) -> HttpResponse {
    let mut response = HttpResponse::builder(StatusCode::TOO_MANY_REQUESTS);
    response.header("ratelimit-limit", decision.limit.to_string());
    response.header("ratelimit-remaining", decision.remaining.to_string());
    response.header("ratelimit-reset", decision.retry_after_seconds.to_string());
    if decision.retry_after_seconds > 0 {
        response.header("retry-after", decision.retry_after_seconds.to_string());
    }
    let body = serde_json::to_vec(&failure.envelope()).unwrap_or_else(|_| {
        br#"{"code":"SERVER_ERROR","message":"Unexpected server error"}"#.to_vec()
    });
    response
        .content_type("application/json; charset=utf-8")
        .body(body)
}

/// `res.json(status, payload)`: `application/json; charset=utf-8`.
#[must_use]
pub fn json_response(status: StatusCode, value: &serde_json::Value) -> HttpResponse {
    let body = serde_json::to_vec(value).unwrap_or_default();
    let mut response = HttpResponse::builder(status);
    response
        .content_type("application/json; charset=utf-8")
        .body(body)
}

fn inbound_success_response(response: CoreResponse) -> HttpResponse {
    let mut builder = HttpResponse::builder(
        StatusCode::from_u16(response.status).unwrap_or(StatusCode::BAD_GATEWAY),
    );
    if let Some(content_type) = response.header("content-type") {
        builder.content_type(content_type);
    }
    // HEAD suppression happens once in the ntex adapter so `content-length` keeps the length the
    // body would have had.
    builder.body(response.body)
}

fn return_limiter_key(config: &CheckoutConfig, meta: &RequestMeta) -> String {
    config.limiter_key(meta.client_ip(config))
}

/// `URLSearchParams` semantics for the return query: a repeated key becomes an array and the TS
/// code drops it (`typeof value === "string"`).
#[must_use]
pub fn single_value_query(query: &str) -> Vec<(String, QueryValue)> {
    let mut seen: Vec<(String, Vec<String>)> = Vec::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let key = key.into_owned();
        let value = value.into_owned();
        match seen.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, values)) => values.push(value),
            None => seen.push((key, vec![value])),
        }
    }
    seen.into_iter()
        .filter_map(|(key, values)| {
            (values.len() == 1).then(|| (key, QueryValue::Text(values[0].clone())))
        })
        .collect()
}

/// One query parameter when it occurs exactly once.
#[must_use]
pub fn single_query_value(query: &str, key: &str) -> Option<String> {
    single_value_query(query)
        .into_iter()
        .find(|(name, _)| name == key)
        .and_then(|(_, value)| match value {
            QueryValue::Text(text) => Some(text),
            _ => None,
        })
}

/// `encodeURIComponent` (the WHATWG/JSC set of unreserved characters).
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(*byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

/// Digest used by the tests to mirror `channelOf`.
#[must_use]
pub fn channel_digest(value: &str) -> String {
    digest_key_part(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_url_matches_the_ts_builder() {
        assert_eq!(
            build_status_url(
                "http://localhost:5103/",
                "/pay/status",
                "attempttoken123",
                Some("REF-RETURN-1")
            ),
            "http://localhost:5103/pay/status?attempt_token=attempttoken123&reference=REF-RETURN-1"
        );
        assert_eq!(
            build_status_url(
                "http://localhost:5103",
                "pay/status",
                "attempttoken123",
                None
            ),
            "http://localhost:5103/pay/status?attempt_token=attempttoken123"
        );
    }

    #[test]
    fn query_parsing_drops_repeated_keys() {
        assert_eq!(
            single_value_query("reference=R1&token=abc&token=def"),
            vec![("reference".to_owned(), QueryValue::Text("R1".to_owned()))]
        );
        assert_eq!(
            single_query_value("railCode=MOAMALAT", "railCode").as_deref(),
            Some("MOAMALAT")
        );
        assert_eq!(
            single_query_value("railCode=A&railCode=B", "railCode"),
            None
        );
    }

    #[test]
    fn uri_component_encoding_matches_javascript() {
        assert_eq!(encode_uri_component("LNKTESTKEY1"), "LNKTESTKEY1");
        assert_eq!(encode_uri_component("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(encode_uri_component("!'()*~-._"), "!'()*~-._");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }
}
