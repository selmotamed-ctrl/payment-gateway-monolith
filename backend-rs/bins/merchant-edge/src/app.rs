//! Application state, request preparation and the dispatch pipeline.
//!
//! Port of `merchant-back/index.ts` (middleware order), `merchant-back/api/index.ts`
//! (`cookieSession`, `requireMerchantAudience`, the four routers) and
//! `merchant-back/api/{public,protected,external}/index.ts` (limiters and guards).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use http::HeaderMap;
use pg_edge::{
    cookie_session_decision, require_audience, CookieDecision, EdgeError, SessionChannel,
    SessionCookieConfig, UploadKind,
};
use serde_json::{Map, Value};

use crate::config::EdgeConfig;
use crate::error::EdgeApiError;
use crate::forward;
use crate::handlers;
use crate::http::{header_value, query_object, resolve_client, resolve_request_id, EdgeResponse};
use crate::limits::{digest_key_part, rate_limit_headers, rate_limit_key, LimitHit, WindowLimiter};
use crate::routes::{self, Action, BodyPolicy, RouteDef, RouteGroup};
use crate::upstream::CoreTransport;
use crate::validate::PathItem;

/// The rate limiters of one process (shared by every ntex worker).
#[derive(Debug)]
pub struct Limiters {
    pub auth_ip: WindowLimiter,
    pub auth_account: WindowLimiter,
    pub auth_ceiling: WindowLimiter,
    pub api: WindowLimiter,
    pub onboarding: WindowLimiter,
    pub external_client: WindowLimiter,
    pub external_token: WindowLimiter,
    pub upload: WindowLimiter,
}

impl Limiters {
    #[must_use]
    pub fn new(config: &EdgeConfig) -> Self {
        const MAX_KEYS: usize = 20_000;
        Self {
            auth_ip: WindowLimiter::new(
                config.auth_rate_limit_window_ms,
                config.auth_rate_limit_max,
                MAX_KEYS,
            ),
            auth_account: WindowLimiter::new(
                config.auth_rate_limit_window_ms,
                config.auth_rate_limit_max,
                MAX_KEYS,
            ),
            auth_ceiling: WindowLimiter::new(
                config.auth_rate_limit_window_ms,
                config.auth_rate_limit_max.saturating_mul(5),
                MAX_KEYS,
            ),
            api: WindowLimiter::new(
                config.api_rate_limit_window_ms,
                config.api_rate_limit_max,
                MAX_KEYS,
            ),
            onboarding: WindowLimiter::new(
                config.api_rate_limit_window_ms,
                config.api_rate_limit_max,
                MAX_KEYS,
            ),
            external_client: WindowLimiter::new(
                config.external_rate_limit_window_ms,
                config.external_rate_limit_max.saturating_mul(5),
                MAX_KEYS,
            ),
            external_token: WindowLimiter::new(
                config.external_rate_limit_window_ms,
                config.external_rate_limit_max,
                MAX_KEYS,
            ),
            upload: WindowLimiter::new(
                config.api_rate_limit_window_ms,
                config.upload_rate_limit_max,
                MAX_KEYS,
            ),
        }
    }
}

/// The per-client concurrency budget of long-lived streams (`MAX_STREAMS_PER_IP`).
#[derive(Debug, Clone)]
pub struct StreamSlots {
    inner: Arc<parking_lot::Mutex<std::collections::HashMap<String, usize>>>,
    max: usize,
    cursor: Arc<AtomicU64>,
}

impl StreamSlots {
    #[must_use]
    pub fn new(max: usize) -> Self {
        Self {
            inner: Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
            max,
            cursor: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Acquire one slot; `None` when the address already holds `MAX_STREAMS_PER_IP` streams.
    #[must_use]
    pub fn acquire(&self, client_ip: &str) -> Option<StreamSlotGuard> {
        let mut map = self.inner.lock();
        let open = map.get(client_ip).copied().unwrap_or(0);
        if open >= self.max {
            return None;
        }
        map.insert(client_ip.to_owned(), open + 1);
        Some(StreamSlotGuard {
            inner: Arc::clone(&self.inner),
            client_ip: client_ip.to_owned(),
            id: self.cursor.fetch_add(1, Ordering::Relaxed),
        })
    }

    #[must_use]
    pub fn open_for(&self, client_ip: &str) -> usize {
        self.inner.lock().get(client_ip).copied().unwrap_or(0)
    }
}

/// Releases the stream slot on drop (client disconnect, deadline or error).
#[derive(Debug)]
pub struct StreamSlotGuard {
    inner: Arc<parking_lot::Mutex<std::collections::HashMap<String, usize>>>,
    client_ip: String,
    id: u64,
}

impl StreamSlotGuard {
    #[must_use]
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for StreamSlotGuard {
    fn drop(&mut self) {
        let mut map = self.inner.lock();
        let open = map.get(&self.client_ip).copied().unwrap_or(1);
        if open <= 1 {
            map.remove(&self.client_ip);
        } else {
            map.insert(self.client_ip.clone(), open - 1);
        }
    }
}

/// Everything a handler needs.
pub struct AppState {
    pub config: Arc<EdgeConfig>,
    pub transport: Arc<dyn CoreTransport>,
    pub limiters: Limiters,
    pub streams: StreamSlots,
    pub release: String,
    pub commit: String,
    pub started: Instant,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppState")
            .field("release", &self.release)
            .field("commit", &self.commit)
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

impl AppState {
    #[must_use]
    pub fn new(
        config: EdgeConfig,
        transport: Arc<dyn CoreTransport>,
        release: String,
        commit: String,
    ) -> Self {
        let limiters = Limiters::new(&config);
        let streams = StreamSlots::new(config.max_streams_per_ip);
        Self {
            config: Arc::new(config),
            transport,
            limiters,
            streams,
            release,
            commit,
            started: Instant::now(),
        }
    }

    /// Build the production state (installs the rustls provider and the mTLS client).
    pub fn production(config: EdgeConfig, release: String, commit: String) -> Result<Self, String> {
        let transport = crate::upstream::HttpCoreTransport::new(&config)?;
        Ok(Self::new(config, Arc::new(transport), release, commit))
    }

    /// Whether the Sandbox plane is configured (`SANDBOX_CORE_BACK_URL(S)`). The Sandbox plane
    /// never falls back to Live; an unset pool is a hard `503 SANDBOX_NODE_UNAVAILABLE`.
    #[must_use]
    pub fn sandbox_configured(&self) -> bool {
        self.config.pools.has_sandbox()
    }

    #[must_use]
    pub fn cookie_config(&self) -> SessionCookieConfig {
        SessionCookieConfig::for_channel(
            SessionChannel::Merchant,
            self.config.session_cookie_secure,
        )
    }

    /// `cookieSession` + `requireMerchantAudience` for one request.
    ///
    /// Returns the effective `Authorization` value, or a rendered refusal.
    pub fn effective_authorization(
        &self,
        method: &str,
        path: &str,
        headers: &HeaderMap,
    ) -> Result<Option<String>, EdgeApiError> {
        let raw = header_value(headers, "authorization")
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let cookie = header_value(headers, "cookie");
        let csrf = header_value(headers, "x-pg-csrf");
        let decision = cookie_session_decision(
            self.config.session_cookie_mode,
            raw.as_deref(),
            method,
            path,
            cookie.as_deref(),
            csrf.as_deref(),
            &self.cookie_config(),
        );
        let effective = match decision {
            CookieDecision::Skip => raw,
            CookieDecision::Bearer(value) => Some(value),
            CookieDecision::CsrfRequired => {
                return Err(EdgeApiError::from_edge(EdgeError::CsrfHeaderRequired));
            }
        };
        require_audience(effective.as_deref(), pg_edge::MERCHANT_SESSION_AUDIENCE)
            .map_err(EdgeApiError::from_edge)?;
        Ok(effective)
    }

    /// The pre-multipart upload gate of the HTTP layer: the per-address budget, a plausible live
    /// merchant session and the declared length are checked before a single byte is buffered.
    pub fn preflight_upload(
        &self,
        headers: &HeaderMap,
        client_ip: &str,
        content_length: Option<u64>,
        method: &str,
        path: &str,
    ) -> Result<(), EdgeResponse> {
        let hit = self
            .limiters
            .upload
            .hit(&rate_limit_key(client_ip, &["upload"]));
        if !hit.allowed {
            return Err(rate_limited(hit, "Too many uploads, please retry later"));
        }
        let authorization = self
            .effective_authorization(method, path, headers)
            .map_err(|error| EdgeResponse::from_error(&error))?;
        if let Err(error) = pg_edge::assert_session_shape(
            authorization.as_deref(),
            pg_edge::MERCHANT_SESSION_AUDIENCE,
            now_millis(),
        ) {
            return Err(EdgeResponse::from_error(&EdgeApiError::from_edge(error)));
        }
        pg_edge::check_upload_length(
            content_length,
            self.config.max_upload_bytes,
            UploadKind::Document,
        )
        .map_err(|error| EdgeResponse::from_error(&EdgeApiError::from_edge(error)))?;
        Ok(())
    }
}

fn now_millis() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(i64::MAX)
}

/// One incoming HTTP request with its body already buffered by the transport layer.
#[derive(Debug, Clone)]
pub struct IncomingRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HeaderMap,
    pub peer: IpAddr,
    pub body: Vec<u8>,
    pub content_length: Option<u64>,
    /// `true` when the HTTP layer already ran the multipart preflight (budget, session, length).
    pub upload_admitted: bool,
}

impl IncomingRequest {
    #[must_use]
    pub fn synthetic(method: &str, path: &str) -> Self {
        Self {
            method: method.to_owned(),
            path: path.to_owned(),
            query: String::new(),
            headers: HeaderMap::new(),
            peer: IpAddr::from([127, 0, 0, 1]),
            body: Vec::new(),
            content_length: None,
            upload_admitted: false,
        }
    }

    #[must_use]
    pub fn with_json(mut self, body: &Value) -> Self {
        self.body = serde_json::to_vec(body).unwrap_or_default();
        self.content_length = Some(u64::try_from(self.body.len()).unwrap_or(u64::MAX));
        self.headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        self
    }

    #[must_use]
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        if let (Ok(name), Ok(value)) = (
            http::header::HeaderName::from_bytes(name.as_bytes()),
            http::HeaderValue::from_str(value),
        ) {
            self.headers.insert(name, value);
        }
        self
    }

    #[must_use]
    pub fn with_query(mut self, query: &str) -> Self {
        self.query = query.to_owned();
        self
    }

    #[must_use]
    pub fn with_body(mut self, content_type: &str, body: Vec<u8>) -> Self {
        self.content_length = Some(u64::try_from(body.len()).unwrap_or(u64::MAX));
        if let Ok(value) = http::HeaderValue::from_str(content_type) {
            self.headers.insert(http::header::CONTENT_TYPE, value);
        }
        self.body = body;
        self
    }

    #[must_use]
    pub fn with_peer(mut self, peer: &str) -> Self {
        if let Some(address) = pg_edge::parse_ip(peer) {
            self.peer = address;
        }
        self
    }

    #[must_use]
    pub fn header(&self, name: &str) -> Option<String> {
        header_value(&self.headers, name)
    }

    #[must_use]
    pub fn origin(&self) -> Option<String> {
        self.header("origin").filter(|value| !value.is_empty())
    }
}

/// Which failure-only counter to release when the request succeeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoBucket {
    Account,
    Ceiling,
}

/// A request that passed the route match, the body check, the cookie/CSRF/audience checks and the
/// group limiters.
#[derive(Debug)]
pub struct Prepared {
    pub route: &'static RouteDef,
    pub params: BTreeMap<String, String>,
    pub query_object: Map<String, Value>,
    pub json_body: Value,
    pub authorization: Option<String>,
    pub idempotency_key: Option<String>,
    pub request_id: String,
    pub client_ip: String,
    pub user_agent: Option<String>,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub upload_admitted: bool,
    pub undo: Vec<(UndoBucket, String)>,
}

impl Prepared {
    #[must_use]
    pub fn route(&self) -> &'static RouteDef {
        self.route
    }
}

pub(crate) fn rate_limited(hit: LimitHit, message: &str) -> EdgeResponse {
    let mut response = EdgeResponse::json(429, &EdgeApiError::rate_limited(message).to_json());
    for (name, value) in rate_limit_headers(hit) {
        response.set_header(&name, &value);
    }
    response
}

fn json_content_type(content_type: &str) -> bool {
    let lowered = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    lowered == "application/json" || lowered.ends_with("+json")
}

fn urlencoded_content_type(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/x-www-form-urlencoded")
}

/// Parse the buffered body exactly like `express.json` + `express.urlencoded`.
fn parse_body(method: &str, req: &IncomingRequest) -> Result<Value, EdgeApiError> {
    if method == "GET" || method == "HEAD" {
        return Ok(Value::Object(Map::new()));
    }
    let content_type = req.header("content-type").unwrap_or_default();
    if json_content_type(&content_type) {
        if req.body.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        return serde_json::from_slice(&req.body).map_err(|_| EdgeApiError::bad_request_body());
    }
    if urlencoded_content_type(&content_type) {
        let text = String::from_utf8_lossy(&req.body);
        return Ok(Value::Object(crate::http::query_object(&text)));
    }
    // `express.json` ignores other content types; `req.body` stays undefined → `{}`.
    Ok(Value::Object(Map::new()))
}

/// The account key of `lib/authLimiters.ts`: `identifier`, `email`, `phone` or `challengeId`.
fn account_key(body: &Value) -> Option<(bool, String)> {
    let object = body.as_object()?;
    for field in ["identifier", "email", "phone", "challengeId"] {
        if let Some(value) = object.get(field).and_then(Value::as_str) {
            if !value.is_empty() {
                return Some((
                    field == "challengeId",
                    value.to_lowercase().trim().to_owned(),
                ));
            }
        }
    }
    None
}

/// Match the route, read/validate the body policy, run cookie/CSRF/audience and the group
/// limiters. A refusal is a complete response (no body side effects).
pub fn prepare(app: &AppState, req: &IncomingRequest) -> Result<Prepared, EdgeResponse> {
    let Some((route, params)) = routes::match_route(&req.method, &req.path) else {
        return Err(EdgeResponse::from_error(&EdgeApiError::not_found(
            &req.method,
            &req.path,
        )));
    };
    let policy = routes::body_policy(route, &req.path, &app.config);

    // JSON/urlencoded parsing happens before authentication in Express (`express.json` is app
    // level), so an oversized or malformed body is answered before a missing credential.
    if let BodyPolicy::Json(limit) = policy {
        if let Some(declared) = req.content_length {
            if declared > limit {
                return Err(EdgeResponse::from_error(&EdgeApiError::payload_too_large()));
            }
        }
        if req.body.len() as u64 > limit {
            return Err(EdgeResponse::from_error(&EdgeApiError::payload_too_large()));
        }
    }
    let json_body = if matches!(policy, BodyPolicy::Multipart | BodyPolicy::None) {
        Value::Object(Map::new())
    } else {
        parse_body(&req.method, req).map_err(|error| EdgeResponse::from_error(&error))?
    };

    let client_ip = resolve_client(&req.headers, req.peer, &app.config.trusted_proxies);
    let authorization = app
        .effective_authorization(&req.method, &req.path, &req.headers)
        .map_err(|error| EdgeResponse::from_error(&error))?;

    let mut undo: Vec<(UndoBucket, String)> = Vec::new();
    // `cookieSession` / `requireMerchantAudience` run for the whole `/api/v1` router.
    if req.path.starts_with("/api/v1") {
        match route.group {
            RouteGroup::Public => {}
            RouteGroup::Auth => {
                // Logout is deliberately outside the login limiter.
                if !matches!(route.action, Action::Logout) {
                    let ip_hit = app.limiters.auth_ip.hit(&rate_limit_key(&client_ip, &[]));
                    if !ip_hit.allowed {
                        return Err(rate_limited(
                            ip_hit,
                            "Too many authentication attempts, please retry later",
                        ));
                    }
                    if req.method == "POST" {
                        if let Some((is_challenge, account)) = account_key(&json_body) {
                            let digest = digest_key_part(&account);
                            let (address_key, ceiling_key) = if is_challenge {
                                (format!("challenge:{digest}"), None)
                            } else {
                                (
                                    format!("account:{digest}|{}", rate_limit_key(&client_ip, &[])),
                                    Some(format!("account-ceiling:{digest}")),
                                )
                            };
                            let account_hit = app.limiters.auth_account.hit(&address_key);
                            if !account_hit.allowed {
                                return Err(rate_limited(
                                    account_hit,
                                    "Too many authentication attempts, please retry later",
                                ));
                            }
                            undo.push((UndoBucket::Account, address_key));
                            if let Some(ceiling_key) = ceiling_key {
                                let ceiling_hit = app.limiters.auth_ceiling.hit(&ceiling_key);
                                if !ceiling_hit.allowed {
                                    return Err(rate_limited(
                                        ceiling_hit,
                                        "Too many authentication attempts, please retry later",
                                    ));
                                }
                                undo.push((UndoBucket::Ceiling, ceiling_key));
                            }
                        }
                    }
                }
            }
            RouteGroup::Onboarding => {
                let hit = app
                    .limiters
                    .onboarding
                    .hit(&rate_limit_key(&client_ip, &[]));
                if !hit.allowed {
                    return Err(rate_limited(
                        hit,
                        "Too many onboarding requests, please retry later",
                    ));
                }
                if authorization.is_none() {
                    return Err(EdgeResponse::from_error(&EdgeApiError::auth_required()));
                }
            }
            RouteGroup::Protected => {
                let hit = app.limiters.api.hit(&rate_limit_key(&client_ip, &[]));
                if !hit.allowed {
                    return Err(rate_limited(
                        hit,
                        "Too many merchant portal requests, please retry later",
                    ));
                }
            }
            RouteGroup::External => {
                let client_hit = app
                    .limiters
                    .external_client
                    .hit(&rate_limit_key(&client_ip, &[]));
                if !client_hit.allowed {
                    return Err(rate_limited(
                        client_hit,
                        "Too many external API requests, please retry later",
                    ));
                }
                let token = authorization
                    .as_deref()
                    .map(|value| crate::upstream::bearer_of(Some(value)))
                    .unwrap_or("");
                if !crate::handlers::valid_external_token(app, token) {
                    return Err(EdgeResponse::from_error(&EdgeApiError::invalid_api_token()));
                }
                let token_hit = app
                    .limiters
                    .external_token
                    .hit(&rate_limit_key(&client_ip, &[&digest_key_part(token)]));
                if !token_hit.allowed {
                    return Err(rate_limited(
                        token_hit,
                        "Too many external API requests, please retry later",
                    ));
                }
            }
        }
    }

    Ok(Prepared {
        route,
        params,
        query_object: query_object(&req.query),
        json_body,
        authorization,
        idempotency_key: req
            .header("idempotency-key")
            .filter(|value| !value.is_empty()),
        request_id: resolve_request_id(&req.headers),
        client_ip,
        user_agent: req.header("user-agent").filter(|value| !value.is_empty()),
        content_type: req.header("content-type"),
        content_length: req.content_length,
        upload_admitted: req.upload_admitted,
        undo,
    })
}

/// Prepare, execute and finalize one request.
pub async fn serve(app: &AppState, req: IncomingRequest) -> EdgeResponse {
    let prepared = match prepare(app, &req) {
        Ok(prepared) => prepared,
        Err(mut response) => {
            response.finalize(&app.config.cors, req.origin().as_deref());
            return response;
        }
    };
    let mut response = execute(app, &prepared, &req).await;
    if response.status < 400 {
        for (bucket, key) in &prepared.undo {
            match bucket {
                UndoBucket::Account => app.limiters.auth_account.undo(key),
                UndoBucket::Ceiling => app.limiters.auth_ceiling.undo(key),
            }
        }
    }
    response.finalize(&app.config.cors, req.origin().as_deref());
    response
}

/// Run the matched action.
pub async fn execute(app: &AppState, prepared: &Prepared, req: &IncomingRequest) -> EdgeResponse {
    let outcome = match &prepared.route.action {
        Action::Health => handlers::health(app),
        Action::Forward(spec) => forward::deliver(app, prepared, spec).await,
        Action::TokenCreate(spec) => handlers::token_create(app, prepared, spec).await,
        Action::Logout => handlers::logout(app, prepared, req).await,
        Action::GoogleCallback => handlers::google_callback(app, prepared, req).await,
        Action::BulkUsers => handlers::bulk_users(app, prepared).await,
        Action::KybDocument => handlers::kyb_document(app, prepared, req).await,
        Action::DisputeEvidence => handlers::dispute_evidence(app, prepared, req).await,
        Action::DisputeAttachment => handlers::dispute_attachment(app, prepared, req).await,
        Action::SandboxUpload => handlers::sandbox_upload(app, prepared, req).await,
        Action::SandboxProxy => handlers::sandbox_proxy(app, prepared, req).await,
        Action::PosStream { path, params } => {
            handlers::pos_stream(app, prepared, req, path, params).await
        }
        Action::AttachmentContent { path, params } => {
            handlers::attachment_content(app, prepared, req, path, params).await
        }
    };
    match outcome {
        Ok(response) => response,
        Err(error) => EdgeResponse::from_error(&error),
    }
}

/// `parseOrThrow` for a params object.
pub fn params_value(params: &BTreeMap<String, String>) -> Value {
    Value::Object(
        params
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

/// A validation issue for a request-wide guard (used by the custom handlers).
#[must_use]
pub fn custom_issue(path: &str, message: &str) -> Vec<crate::validate::Issue> {
    vec![crate::validate::Issue::new(
        "custom",
        vec![PathItem::Key(path.to_owned())],
        message,
        Vec::new(),
    )]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::EdgeConfig;
    use crate::upstream::test_support::FakeCore;
    use serde_json::json;

    fn state() -> (AppState, FakeCore) {
        state_with(|_| {})
    }

    fn state_with(configure: impl FnOnce(&mut EdgeConfig)) -> (AppState, FakeCore) {
        let core = FakeCore::new();
        let mut config = EdgeConfig::for_embedding(vec!["https://core.test".to_owned()], None);
        configure(&mut config);
        (
            AppState::new(
                config,
                Arc::new(core.clone()),
                "r".to_owned(),
                "c".to_owned(),
            ),
            core,
        )
    }

    fn session_bearer() -> String {
        let header = base64_url(json!({ "alg": "HS256", "typ": "JWT" }));
        let payload = base64_url(json!({
            "typ": "session",
            "aud": "payment-gateway-merchant",
            "exp": now_millis() / 1000 + 3600
        }));
        format!("Bearer {header}.{payload}.signature")
    }

    fn base64_url(value: Value) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).expect("json"))
    }

    struct Harness {
        app: AppState,
        core: FakeCore,
    }

    impl Harness {
        fn new() -> Self {
            let (app, core) = state();
            Self { app, core }
        }

        async fn send(&self, request: IncomingRequest) -> EdgeResponse {
            serve(&self.app, request).await
        }

        fn body(response: &EdgeResponse) -> Value {
            serde_json::from_slice(response.body_bytes().unwrap_or(b"{}")).unwrap_or(Value::Null)
        }
    }

    #[tokio::test]
    async fn unknown_routes_answer_the_express_404_body() {
        let harness = Harness::new();
        let response = harness
            .send(IncomingRequest::synthetic("GET", "/api/v1/nope"))
            .await;
        assert_eq!(response.status, 404);
        assert_eq!(
            Harness::body(&response),
            json!({
                "code": "NOT_FOUND",
                "message": "No route matches GET /api/v1/nope"
            })
        );
        assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    }

    #[tokio::test]
    async fn malformed_json_is_a_bad_request_before_auth() {
        let harness = Harness::new();
        let response = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login")
                    .with_body("application/json", b"{nope".to_vec()),
            )
            .await;
        assert_eq!(response.status, 400);
        assert_eq!(Harness::body(&response)["code"], json!("BAD_REQUEST"));
        assert_eq!(harness.core.call_count(), 0);
    }

    #[tokio::test]
    async fn an_oversized_json_body_is_refused_before_auth() {
        let harness = Harness::new();
        let mut request = IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login");
        request.content_length = Some(harness.app.config.max_json_body_bytes + 1);
        let response = harness.send(request).await;
        assert_eq!(response.status, 413);
        assert_eq!(Harness::body(&response)["code"], json!("PAYLOAD_TOO_LARGE"));
    }

    #[tokio::test]
    async fn a_missing_bearer_is_auth_required() {
        let harness = Harness::new();
        let response = harness
            .send(IncomingRequest::synthetic(
                "GET",
                "/api/v1/merchant/wallets",
            ))
            .await;
        assert_eq!(response.status, 401);
        assert_eq!(Harness::body(&response)["code"], json!("AUTH_REQUIRED"));
        assert_eq!(harness.core.call_count(), 0);
    }

    #[tokio::test]
    async fn a_valid_bearer_is_forwarded() {
        let harness = Harness::new();
        harness.core.push_json(200, json!({ "wallets": [] }));
        let response = harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/merchant/wallets")
                    .with_header("authorization", &session_bearer()),
            )
            .await;
        assert_eq!(response.status, 200);
        let call = harness.core.last_call().expect("call");
        assert_eq!(call.path, "/internal/merchant/wallets");
        assert_eq!(call.header("x-edge-service"), Some("merchant-back"));
        assert_eq!(
            call.header("authorization"),
            Some(session_bearer().as_str())
        );
    }

    #[tokio::test]
    async fn wrong_audience_is_refused_before_core() {
        let harness = Harness::new();
        let header = base64_url(json!({ "alg": "HS256" }));
        let payload = base64_url(json!({
            "aud": "payment-gateway-admin",
            "exp": now_millis() / 1000 + 3600
        }));
        let token = format!("Bearer {header}.{payload}.signature");
        let response = harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/merchant/applications")
                    .with_header("authorization", &token),
            )
            .await;
        assert_eq!(response.status, 401);
        assert_eq!(
            Harness::body(&response)["code"],
            json!("AUTH_AUDIENCE_INVALID")
        );
        assert_eq!(harness.core.call_count(), 0);
    }

    #[tokio::test]
    async fn deep_pagination_is_forwarded() {
        let harness = Harness::new();
        let response = harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/merchant/payments")
                    .with_header("authorization", &session_bearer())
                    .with_query("page=23397&pageSize=25"),
            )
            .await;
        assert_eq!(response.status, 200);
        let call = harness.core.last_call().expect("call");
        assert_eq!(
            call.url(),
            "/internal/merchant/payments?page=23397&pageSize=25"
        );
    }

    #[tokio::test]
    async fn cookie_mode_requires_the_csrf_header_on_writes() {
        let (app, core) = state_with(|config| config.session_cookie_mode = true);
        let harness = Harness { app, core };
        let cookie = "pg_merchant_session=abcdefghijklmnopqrstuvwx";
        let refused = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/logout")
                    .with_header("cookie", cookie),
            )
            .await;
        assert_eq!(refused.status, 403);
        assert_eq!(
            Harness::body(&refused)["code"],
            json!("CSRF_HEADER_REQUIRED")
        );
        assert_eq!(harness.core.call_count(), 0);
    }

    #[tokio::test]
    async fn login_captures_the_session_cookie() {
        let (app, core) = state_with(|config| config.session_cookie_mode = true);
        let harness = Harness { app, core };
        harness.core.push_json(
            200,
            json!({ "token": "abcdefghijklmnopqrstuvwx", "userInfo": { "id": "u" } }),
        );
        let response = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login")
                    .with_json(&json!({ "identifier": "ops@example.com", "password": "secret" })),
            )
            .await;
        assert_eq!(response.status, 200);
        let body = Harness::body(&response);
        assert_eq!(body["sessionCookie"], json!(true));
        assert!(body.get("token").is_none());
        let cookie = response.header("set-cookie").expect("cookie");
        assert!(cookie.starts_with("pg_merchant_session=abcdefghijklmnopqrstuvwx;"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Secure"));
    }

    #[tokio::test]
    async fn auth_failures_are_limited_per_account_and_address() {
        let (app, core) = state_with(|config| config.auth_rate_limit_max = 2);
        let harness = Harness { app, core };
        // Core always answers 401, so every request counts as a failure.
        for _ in 0..2 {
            harness
                .core
                .push_json(401, json!({ "code": "INVALID_CREDENTIALS" }));
        }
        let attempt = |identifier: &str, ip: &str| {
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login")
                .with_peer(ip)
                .with_json(&json!({ "identifier": identifier, "password": "wrong-password-1" }))
        };
        assert_ne!(
            harness
                .send(attempt("Owner@Example.com", "198.51.100.40"))
                .await
                .status,
            429
        );
        assert_ne!(
            harness
                .send(attempt("owner@example.com", "198.51.100.40"))
                .await
                .status,
            429
        );
        assert_eq!(
            harness
                .send(attempt("owner@example.com", "198.51.100.40"))
                .await
                .status,
            429
        );
        // The owner from another address is not locked out.
        harness
            .core
            .push_json(401, json!({ "code": "INVALID_CREDENTIALS" }));
        assert_eq!(
            harness
                .send(attempt("owner@example.com", "198.51.100.41"))
                .await
                .status,
            401
        );
    }

    #[tokio::test]
    async fn successful_logins_release_the_failure_budget() {
        let (app, core) = state_with(|config| config.auth_rate_limit_max = 3);
        let harness = Harness { app, core };
        let request = || {
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login")
                .with_peer("198.51.100.70")
                .with_json(&json!({ "identifier": "busy@example.com", "password": "right" }))
        };
        for _ in 0..3 {
            assert_eq!(harness.send(request()).await.status, 200);
        }
        // The per-address account bucket was released after every success (the address-wide auth
        // limiter is the separate, non-skipping budget and reached exactly 3).
        let digest = crate::limits::digest_key_part("busy@example.com");
        let account_key = format!("account:{digest}|198.51.100.70");
        assert_eq!(harness.app.limiters.auth_account.count(&account_key), 0);
        assert_eq!(
            harness
                .app
                .limiters
                .auth_account
                .count(&format!("account-ceiling:{digest}")),
            0
        );
    }

    #[tokio::test]
    async fn the_account_ceiling_stops_distributed_guessing() {
        let (app, core) = state_with(|config| config.auth_rate_limit_max = 2);
        let harness = Harness { app, core };
        for _ in 0..10 {
            harness
                .core
                .push_json(401, json!({ "code": "INVALID_CREDENTIALS" }));
        }
        for index in 0..10 {
            let ip = format!("198.51.100.{}", 60 + index);
            let response = harness
                .send(
                    IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login")
                        .with_peer(&ip)
                        .with_json(
                            &json!({ "identifier": "target@example.com", "password": "wrong" }),
                        ),
                )
                .await;
            assert_eq!(response.status, 401, "attempt {index}");
        }
        let response = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/login")
                    .with_peer("198.51.100.99")
                    .with_json(&json!({ "identifier": "target@example.com", "password": "wrong" })),
            )
            .await;
        assert_eq!(response.status, 429);
    }

    #[tokio::test]
    async fn external_tokens_need_the_issued_shape() {
        let harness = Harness::new();
        for header in [
            None,
            Some("Bearer pg_live_totallymadeup".to_owned()),
            Some("Bearer pg_live_".to_owned()),
            Some("Bearer merchant-session".to_owned()),
            Some(format!("Bearer pg_live_{} extra", "B".repeat(43))),
        ] {
            let mut request =
                IncomingRequest::synthetic("GET", "/api/v1/external/links/abcdef123456");
            if let Some(header) = header {
                request = request.with_header("authorization", &header);
            }
            let response = harness.send(request).await;
            assert_eq!(response.status, 401);
            assert_eq!(Harness::body(&response)["code"], json!("INVALID_API_TOKEN"));
        }
        assert_eq!(harness.core.call_count(), 0);

        let good = format!("Bearer pg_live_{}", "B".repeat(43));
        let response = harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/external/links/abcdef123456")
                    .with_header("authorization", &good),
            )
            .await;
        assert_eq!(response.status, 200);
        assert_eq!(
            harness
                .core
                .last_call()
                .expect("call")
                .header("authorization"),
            Some(good.as_str())
        );
    }

    #[tokio::test]
    async fn the_external_budget_is_per_token_and_address() {
        let (app, core) = state_with(|config| config.external_rate_limit_max = 2);
        let harness = Harness { app, core };
        let call = |token: &str| {
            IncomingRequest::synthetic("GET", "/api/v1/external/links/abcdef123456")
                .with_header(
                    "authorization",
                    &format!("Bearer pg_live_{}", token.repeat(43)),
                )
                .with_header("x-real-client-ip", "198.51.100.20")
        };
        let first = [
            harness.send(call("C")).await.status,
            harness.send(call("C")).await.status,
            harness.send(call("C")).await.status,
        ];
        assert_eq!(first, [200, 200, 429]);
        assert_eq!(harness.send(call("D")).await.status, 200);
    }

    #[tokio::test]
    async fn trust_proxy_cidrs_decide_which_forwarded_ip_is_used() {
        let harness = Harness::new();
        harness.core.push_json(200, json!({}));
        // Loopback is trusted, so the header wins.
        harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/merchant/wallets")
                    .with_header("authorization", &session_bearer())
                    .with_header("x-real-client-ip", "203.0.113.7"),
            )
            .await;
        assert_eq!(
            harness
                .core
                .last_call()
                .expect("call")
                .header("x-real-client-ip"),
            Some("203.0.113.7")
        );
        // A private network peer is not trusted; the socket address wins.
        harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/merchant/wallets")
                    .with_header("authorization", &session_bearer())
                    .with_header("x-real-client-ip", "1.1.1.1")
                    .with_peer("10.1.2.3"),
            )
            .await;
        assert_eq!(
            harness
                .core
                .last_call()
                .expect("call")
                .header("x-real-client-ip"),
            Some("10.1.2.3")
        );
    }
}
