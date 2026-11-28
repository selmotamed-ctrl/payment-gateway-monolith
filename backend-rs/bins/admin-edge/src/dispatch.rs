//! Request pipeline: LAN guard, cookies, limiters, guards, validation, forwarding and responses.
//!
//! Port of `admin-back/index.ts`, `api/index.ts`, `api/forward.ts`, `api/upload.ts`,
//! `api/sandboxProxy.ts`, `lib/security/*`, the request-id half of `lib/requestLogger` and the
//! hand-written buckets in `api/protected/{index,search,academy}.ts`.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use futures_util::StreamExt;
use ntex::http::StatusCode;
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};

use pg_upstream::{CoreMethod, Plane, QueryValue, RetryOptions};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::auth::{
    digest_key_part, is_read_method, require_authorities, require_session, roles_of, subject_of,
};
use crate::client::{core_headers, CoreClient, CoreRequest, CoreResponse};
use crate::config::Config;
use crate::error::{body_parser_error, map_core_http_error, not_found, ApiError, EdgeResult};
use crate::limits::{Decision, Limiters};
use crate::routes::{Guard, Kind, Local, RawMode, Route, UploadRoute, UploadSpec};
use crate::sandbox;
use crate::schema::{parse_or_throw, Schema};
use crate::upload::{self, UploadFile};

/// Everything a request needs.
pub struct AppState {
    pub config: Arc<Config>,
    pub client: Arc<CoreClient>,
    pub limiters: Limiters,
    pub routes: Vec<Route>,
    pub uploads: Vec<UploadSpec>,
    pub exact: HashMap<(&'static str, String), usize>,
    pub patterns: Vec<(usize, Vec<Segment>)>,
    pub started: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Literal(String),
    Param(String),
}

impl AppState {
    #[must_use]
    pub fn new(
        config: Arc<Config>,
        client: Arc<CoreClient>,
        routes: Vec<Route>,
        uploads: Vec<UploadSpec>,
    ) -> Self {
        let mut exact = HashMap::new();
        let mut patterns = Vec::new();
        for (index, route) in routes.iter().enumerate() {
            let segments = compile_pattern(route.pattern);
            if segments
                .iter()
                .all(|segment| matches!(segment, Segment::Literal(_)))
            {
                exact.insert((route.method, route.pattern.to_owned()), index);
            } else {
                patterns.push((index, segments));
            }
        }
        // Literal-heavy patterns win over parameter-heavy ones (Express declares them first).
        patterns.sort_by_key(|(_, segments)| {
            std::cmp::Reverse(
                segments
                    .iter()
                    .filter(|segment| matches!(segment, Segment::Literal(_)))
                    .count(),
            )
        });
        let limiters = Limiters::new(
            config.admin_rate_limit_max,
            config.admin_rate_limit_window_ms,
            config.auth_rate_limit_max,
            config.auth_rate_limit_window_ms,
            config.upload_rate_limit_max,
            config.admin_rate_limit_window_ms,
            config.backup_job_rate_limit_max,
        );
        Self {
            config,
            client,
            limiters,
            routes,
            uploads,
            exact,
            patterns,
            started: Instant::now(),
        }
    }

    fn match_route(&self, method: &str, path: &str) -> Option<(&Route, Map<String, Value>)> {
        if let Some(method_key) = intern_method(method) {
            if let Some(index) = self.exact.get(&(method_key, path.to_owned())) {
                if let Some(route) = self.routes.get(*index) {
                    return Some((route, Map::new()));
                }
            }
        }
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        for (index, pattern) in &self.patterns {
            let Some(route) = self.routes.get(*index) else {
                continue;
            };
            if route.method != method {
                continue;
            }
            if let Some(params) = match_segments(pattern, &segments) {
                return Some((route, params));
            }
        }
        None
    }

    fn match_upload(&self, method: &str, path: &str) -> Option<(&UploadSpec, Map<String, Value>)> {
        if method != "POST" {
            return None;
        }
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        for spec in &self.uploads {
            if let Some(params) = match_segments(&compile_pattern(spec.pattern), &segments) {
                return Some((spec, params));
            }
        }
        None
    }
}

fn intern_method(method: &str) -> Option<&'static str> {
    Some(match method {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => return None,
    })
}

fn compile_pattern(pattern: &str) -> Vec<Segment> {
    pattern
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| match segment.strip_prefix(':') {
            Some(name) => Segment::Param(name.to_owned()),
            None => Segment::Literal(segment.to_owned()),
        })
        .collect()
}

fn match_segments(pattern: &[Segment], segments: &[&str]) -> Option<Map<String, Value>> {
    if pattern.len() != segments.len() {
        return None;
    }
    let mut params = Map::new();
    for (expected, actual) in pattern.iter().zip(segments.iter()) {
        match expected {
            Segment::Literal(value) => {
                if value != actual {
                    return None;
                }
            }
            Segment::Param(name) => {
                let decoded = percent_decode(actual)?;
                params.insert(name.clone(), Value::String(decoded));
            }
        }
    }
    Some(params)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes.get(index).copied() == Some(b'%') {
            let high = hex(bytes.get(index + 1).copied()?)?;
            let low = hex(bytes.get(index + 2).copied()?)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(*bytes.get(index)?);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn encode_uri_component(value: &str) -> String {
    crate::upload::encode_uri_component(value)
}

/// ntex handler: pull the shared state out of the app config and dispatch.
pub async fn handle(req: HttpRequest, body: Payload) -> HttpResponse {
    let Some(state) = req.app_value::<Arc<AppState>>().cloned() else {
        return error_response(&ApiError::new(
            500,
            "SERVER_ERROR",
            "Unexpected server error",
        ));
    };
    dispatch(state, req, body).await
}

/// The whole request pipeline.
pub async fn dispatch(state: Arc<AppState>, req: HttpRequest, payload: Payload) -> HttpResponse {
    let request_id = pg_http::request_id::request_id_from_header(
        req.headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok()),
    );
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let method = req.method().as_str().to_owned();
    let path = req.path().to_owned();
    let original_path = path.clone();

    let mut response = route_request(
        state.clone(),
        request_id.as_str(),
        method,
        path,
        origin.clone(),
        req,
        payload,
    )
    .await;

    for (name, value) in pg_http::security::security_headers() {
        if let (Ok(name), Ok(value)) = (
            ntex::http::header::HeaderName::from_bytes(name.as_bytes()),
            ntex::http::header::HeaderValue::from_str(value),
        ) {
            if !response.headers_mut().contains_key(&name) {
                response.headers_mut().insert(name, value);
            }
        }
    }
    // The TS edges resolve/generate `x-request-id` and forward it to core, but their request
    // logger does not attach it to the response. Track P (TS wins) therefore does not echo it;
    // chapter 2 §2 says echo, so this is recorded in README "Deviations".
    if req_path_is_search_or_academy(&original_path) {
        response.headers_mut().insert(
            ntex::http::header::CACHE_CONTROL,
            ntex::http::header::HeaderValue::from_static("no-store, no-cache, must-revalidate"),
        );
    }
    if state.config.cors.is_enabled() {
        if let Some(origin) = origin {
            if state.config.cors.allow_origin(Some(&origin)).is_some() {
                if let Ok(value) = ntex::http::header::HeaderValue::from_str(&origin) {
                    response.headers_mut().insert(
                        ntex::http::header::HeaderName::from_static("access-control-allow-origin"),
                        value,
                    );
                }
                response.headers_mut().insert(
                    ntex::http::header::HeaderName::from_static("vary"),
                    ntex::http::header::HeaderValue::from_static("Origin"),
                );
            }
        }
    }
    response
}

async fn route_request(
    state: Arc<AppState>,
    request_id: &str,
    method: String,
    path: String,
    origin: Option<String>,
    req: HttpRequest,
    payload: Payload,
) -> HttpResponse {
    if path == "/health" {
        return health(&state);
    }
    if !path.starts_with("/api/v1/admin") {
        return error_response(&not_found(&method, &path));
    }
    let peer = req
        .peer_addr()
        .unwrap_or_else(|| std::net::SocketAddr::from(([127, 0, 0, 1], 0)));
    let real_ip = req
        .headers()
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok());
    let real_client_ip = req
        .headers()
        .get("x-real-client-ip")
        .and_then(|value| value.to_str().ok());
    let client_ip = pg_edge::client_ip::resolve_client_ip(
        peer.ip(),
        &state.config.trusted_proxies,
        real_ip,
        real_client_ip,
    )
    .to_string();
    let lan_ip = pg_edge::client_ip::resolve_client_ip(
        peer.ip(),
        &state.config.lan_trusted_proxies,
        real_ip,
        real_client_ip,
    )
    .to_string();

    // CORS preflight is handled by the cors middleware before any route.
    if method == "OPTIONS" && state.config.cors.is_enabled() {
        if let Some(origin) = origin.as_deref() {
            if state.config.cors.allow_origin(Some(origin)).is_some() {
                let requested = req
                    .headers()
                    .get("access-control-request-headers")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or(
                        "authorization,content-type,x-pg-csrf,x-request-id,x-pg-min-lsn,idempotency-key",
                    )
                    .to_owned();
                let mut builder = HttpResponse::NoContent();
                builder.header("access-control-allow-origin", origin);
                builder.header("vary", "Origin");
                builder.header(
                    "access-control-allow-methods",
                    "GET,HEAD,PUT,PATCH,POST,DELETE",
                );
                builder.header("access-control-allow-headers", requested);
                return builder.body(ntex::http::body::Body::Empty);
            }
        }
    }

    let inside_lan = lan_ip
        .parse::<std::net::IpAddr>()
        .map(|address| {
            state
                .config
                .admin_lan
                .iter()
                .any(|network| network.contains(&address))
        })
        .unwrap_or(false);
    if !inside_lan {
        return error_response(
            &ApiError::new(
                403,
                "ADMIN_LAN_ONLY",
                "The admin back office is reachable from the private LAN only",
            )
            .with_details(json!({ "clientIp": lan_ip })),
        );
    }

    let relative = path.strip_prefix("/api/v1/admin").unwrap_or("/").to_owned();
    let relative = if relative.is_empty() {
        "/".to_owned()
    } else {
        relative
    };

    // cookieSession: cookie mode may turn the cookie into the bearer header (or demand CSRF).
    let mut authorization = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if state.config.session_cookie_mode {
        match cookie_decision(&method, &relative, &req, authorization.is_some()) {
            Ok(Some(token)) => authorization = Some(format!("Bearer {token}")),
            Ok(None) => {}
            Err(error) => return error_response(&error),
        }
    }

    if relative == crate::routes::SANDBOX_PREFIX || relative.starts_with("/sandbox/") {
        if let Some(response) = admin_limiter(&state, &client_ip) {
            return response;
        }
        if let Err(error) = require_session(authorization.as_deref()) {
            return error_response(&error);
        }
        let sandbox_path = relative.trim_start_matches("/sandbox");
        return sandbox_proxy(
            &state,
            request_id,
            &method,
            sandbox_path,
            &client_ip,
            authorization.as_deref(),
            req,
            payload,
        )
        .await;
    }

    let matched = state.match_route(&method, &relative).or_else(|| {
        // Express serves HEAD from the GET route.
        (method == "HEAD")
            .then(|| state.match_route("GET", &relative))
            .flatten()
    });
    let Some((route, params)) = matched else {
        if let Some((spec, params)) = state.match_upload(&method, &relative) {
            return upload_request(
                &state,
                spec,
                params,
                request_id,
                &client_ip,
                authorization.as_deref(),
                req,
                payload,
            )
            .await;
        }
        return error_response(&not_found(&method, &path));
    };
    let is_auth = relative.starts_with("/auth/");
    let is_logout = matches!(route.kind, Kind::Local(Local::Logout));

    if is_auth && !is_logout {
        if let Some(response) = limited(
            state.limiters.auth.check(&client_ip),
            "RATE_LIMITED",
            "Too many authentication attempts, please retry later",
        ) {
            return response;
        }
    }
    if !is_auth {
        if let Some(response) = admin_limiter(&state, &client_ip) {
            return response;
        }
    }

    // The body is parsed before the account limiter (which keys on the parsed body). The 24 MB
    // route-scoped cap applies to the JSON parser only; urlencoded keeps the global cap.
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let limit = if is_auth || content_type == "application/x-www-form-urlencoded" {
        state.config.max_json_bytes
    } else {
        state.config.json_limit_for(&path)
    };
    let body = match read_json_body(payload, &req, limit).await {
        Ok(body) => body,
        Err(error) => return error_response(&error),
    };
    let account = account_key(&relative, &body);
    if is_auth && !is_logout {
        if let Some(account) = &account {
            if let Some(response) = check_account_limits(&state, account, &client_ip) {
                return response;
            }
        }
    }

    if !is_auth {
        if let Err(error) = require_session(authorization.as_deref()) {
            return error_response(&error);
        }
        if let Guard::Authorities {
            read,
            write,
            read_paths,
        } = route.guard
        {
            let required = if is_read_method(&method, &relative, read_paths) {
                read
            } else {
                write
            };
            if let Err(error) = require_authorities(
                required,
                authorization.as_deref(),
                &state.config.authority_hints,
            ) {
                return error_response(&error);
            }
        }
        if (relative.starts_with("/academy/team")
            || (relative.starts_with("/academy/certificates/") && relative.ends_with("/revoke")))
            && !roles_of(authorization.as_deref())
                .iter()
                .any(|role| role == "SECURITY_ADMIN")
        {
            return error_response(&ApiError::new(
                403,
                "ACADEMY_TEAM_FORBIDDEN",
                "Only security administrators can open the team view",
            ));
        }
        if relative == "/search" {
            let subject = subject_of(authorization.as_deref()).unwrap_or_default();
            let key = digest_key_part(&format!("{client_ip}|{subject}"));
            let decision = state.limiters.search.check(&key);
            if !decision.allowed {
                return search_limited(decision);
            }
        }
        if relative.starts_with("/academy/") {
            let subject = subject_of(authorization.as_deref()).unwrap_or_else(|| {
                format!(
                    "t:{}",
                    digest_key_part(authorization.as_deref().unwrap_or("anonymous"))
                )
            });
            let decision = state.limiters.academy.check(&format!("u:{subject}"));
            if !decision.allowed {
                return academy_limited(decision);
            }
        }
        if relative.starts_with("/system/backups/")
            && (relative.ends_with("/trigger") || relative.ends_with("/drill"))
        {
            let key = format!("{client_ip}|backup-jobs");
            if let Some(response) = limited(
                state.limiters.backup.check(&key),
                "RATE_LIMITED",
                "Too many backup jobs requested, please retry later",
            ) {
                return response;
            }
        }
    }
    let _ = &account;

    let params = match route
        .params
        .as_ref()
        .map(|schema| parse_or_throw(schema, &Value::Object(params.clone())))
        .transpose()
    {
        Ok(Some(params)) => params.as_object().cloned().unwrap_or_default(),
        Ok(None) => params,
        Err(error) => return auth_failure(&state, &account, &client_ip, error_response(&error)),
    };
    let query = match parse_query(req.query_string()) {
        Ok(query) => query,
        Err(error) => return error_response(&error),
    };
    let query = match route
        .query
        .as_ref()
        .map(|schema| parse_or_throw(schema, &Value::Object(query)))
        .transpose()
    {
        Ok(Some(query)) => query,
        Ok(None) => Value::Object(Map::new()),
        Err(error) => return auth_failure(&state, &account, &client_ip, error_response(&error)),
    };
    let mut message = if matches!(method.as_str(), "GET" | "HEAD") {
        Value::Object(Map::new())
    } else {
        body
    };
    if let Some(schema) = &route.body {
        match parse_or_throw(schema, &message) {
            Ok(parsed) => message = parsed,
            Err(error) => {
                return auth_failure(&state, &account, &client_ip, error_response(&error));
            }
        }
    }
    if let Some(map) = route.map {
        match map(&message) {
            Ok(mapped) => message = mapped,
            Err(error) => {
                return auth_failure(&state, &account, &client_ip, error_response(&error));
            }
        }
    }

    let response = match route.kind {
        Kind::Local(Local::Logout) => {
            let mut response = logout(
                &state,
                request_id,
                &client_ip,
                authorization.as_deref(),
                &req,
            )
            .await;
            // `clearSessionCookie` runs unconditionally in TS, also when cookie mode is off.
            if let Ok(value) =
                ntex::http::header::HeaderValue::from_str(&clear_cookie_header(&state.config))
            {
                response.headers_mut().append(
                    ntex::http::header::HeaderName::from_static("set-cookie"),
                    value,
                );
            }
            response
        }
        Kind::Local(Local::ApprovalBulkReject) => {
            approval_bulk_reject(
                &state,
                request_id,
                &message,
                &client_ip,
                authorization.as_deref(),
                &req,
            )
            .await
        }
        Kind::Local(Local::UserBulkPatch) => {
            users_bulk_patch(
                &state,
                request_id,
                &message,
                &client_ip,
                authorization.as_deref(),
                &req,
            )
            .await
        }
        Kind::Raw(mode) => {
            forward_raw(
                &state,
                request_id,
                route,
                &params,
                &query,
                &client_ip,
                authorization.as_deref(),
                &req,
                mode,
            )
            .await
        }
        Kind::Forward => {
            forward(
                &state,
                request_id,
                route,
                &params,
                &query,
                &message,
                &client_ip,
                authorization.as_deref(),
                &req,
                route.capture_session,
            )
            .await
        }
    };
    auth_failure(&state, &account, &client_ip, response)
}

fn auth_failure(
    state: &AppState,
    account: &Option<AccountKey>,
    client_ip: &str,
    response: HttpResponse,
) -> HttpResponse {
    let status = response.status().as_u16();
    if status >= 400 && status != 429 {
        if let Some(account) = account {
            let limit = state.config.auth_rate_limit_max;
            match account {
                AccountKey::Account(value) => {
                    state.limiters.account_per_address.record_failure(&format!(
                        "account:{}|{}",
                        digest_key_part(value),
                        client_ip
                    ));
                    state
                        .limiters
                        .account_ceiling
                        .record_failure(&format!("account-ceiling:{}", digest_key_part(value)));
                }
                AccountKey::Challenge(value) => state
                    .limiters
                    .account_per_address
                    .record_failure(&format!("challenge:{}", digest_key_part(value))),
            }
            let _ = limit;
        }
    }
    response
}

fn check_account_limits(
    state: &AppState,
    account: &AccountKey,
    client_ip: &str,
) -> Option<HttpResponse> {
    let limit = state.config.auth_rate_limit_max;
    let key = match account {
        AccountKey::Account(value) => {
            format!("account:{}|{}", digest_key_part(value), client_ip)
        }
        AccountKey::Challenge(value) => format!("challenge:{}", digest_key_part(value)),
    };
    if let Some(response) = limited(
        state.limiters.account_per_address.peek(&key, limit),
        "RATE_LIMITED",
        "Too many authentication attempts, please retry later",
    ) {
        return Some(response);
    }
    if let AccountKey::Account(value) = account {
        let ceiling = format!("account-ceiling:{}", digest_key_part(value));
        if let Some(response) = limited(
            state
                .limiters
                .account_ceiling
                .peek(&ceiling, limit.saturating_mul(5)),
            "RATE_LIMITED",
            "Too many authentication attempts, please retry later",
        ) {
            return Some(response);
        }
    }
    None
}

fn account_key(relative: &str, body: &Value) -> Option<AccountKey> {
    let field = match relative {
        "/auth/login" => "identifier",
        "/auth/mfa" => "challengeId",
        _ => return None,
    };
    let value = body
        .get(field)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())?;
    Some(if field == "identifier" {
        AccountKey::Account(value)
    } else {
        AccountKey::Challenge(value)
    })
}

#[derive(Debug, Clone)]
enum AccountKey {
    Account(String),
    Challenge(String),
}

fn admin_limiter(state: &AppState, client_ip: &str) -> Option<HttpResponse> {
    limited(
        state.limiters.admin.check(client_ip),
        "RATE_LIMITED",
        "Too many admin requests, please retry later",
    )
}

fn limited(decision: Decision, code: &str, message: &str) -> Option<HttpResponse> {
    if decision.allowed {
        return None;
    }
    let mut response = error_response(&ApiError::rate_limited(code, message));
    if let Ok(value) =
        ntex::http::header::HeaderValue::from_str(&decision.retry_after_seconds.to_string())
    {
        response
            .headers_mut()
            .insert(ntex::http::header::RETRY_AFTER, value);
    }
    Some(response)
}

fn search_limited(decision: Decision) -> HttpResponse {
    let retry = decision.retry_after_seconds.max(1);
    let mut response = json_response(
        429,
        &json!({
            "code": "SEARCH_RATE_LIMITED",
            "message": "Too many search requests. Please wait a moment and try again.",
            "retryAfterSec": retry,
        }),
    );
    if let Ok(value) = ntex::http::header::HeaderValue::from_str(&retry.to_string()) {
        response
            .headers_mut()
            .insert(ntex::http::header::RETRY_AFTER, value);
    }
    response.headers_mut().insert(
        ntex::http::header::CACHE_CONTROL,
        ntex::http::header::HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    response
}

fn academy_limited(decision: Decision) -> HttpResponse {
    let retry = decision.retry_after_seconds.max(1);
    let mut response = json_response(
        429,
        &json!({
            "code": "ACADEMY_RATE_LIMITED",
            "message": "Too many academy requests. Please wait a moment and try again.",
            "retryAfterSec": retry,
        }),
    );
    if let Ok(value) = ntex::http::header::HeaderValue::from_str(&retry.to_string()) {
        response
            .headers_mut()
            .insert(ntex::http::header::RETRY_AFTER, value);
    }
    response
}

fn health(state: &AppState) -> HttpResponse {
    json_response(
        200,
        &json!({
            "status": "ok",
            "service": "admin-back",
            "release": state.config.release,
            "commit": state.config.commit,
            "uptime": state.started.elapsed().as_secs_f64(),
            "impl": "rust",
        }),
    )
}

fn req_path_is_search_or_academy(path: &str) -> bool {
    path == "/api/v1/admin/search" || path.starts_with("/api/v1/admin/academy/")
}

fn json_response(status: u16, value: &Value) -> HttpResponse {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    body_response(status, "application/json; charset=utf-8", Bytes::from(body))
}

fn body_response(status: u16, content_type: &str, body: Bytes) -> HttpResponse {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    HttpResponse::builder(code)
        .content_type(content_type)
        .body(body.to_vec())
}

fn error_response(error: &ApiError) -> HttpResponse {
    json_response(error.status, &error.envelope())
}

fn cookie_decision(
    method: &str,
    relative: &str,
    req: &HttpRequest,
    has_authorization: bool,
) -> Result<Option<String>, ApiError> {
    if has_authorization || is_cookie_exempt(relative) {
        return Ok(None);
    }
    let Some(token) = read_session_cookie(req) else {
        return Ok(None);
    };
    let safe = matches!(method, "GET" | "HEAD" | "OPTIONS");
    if !safe {
        let csrf = req
            .headers()
            .get("x-pg-csrf")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if csrf != "1" {
            return Err(ApiError::new(
                403,
                "CSRF_HEADER_REQUIRED",
                "Cookie-authenticated writes must send the x-pg-csrf header",
            ));
        }
    }
    Ok(Some(token))
}

fn is_cookie_exempt(relative: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "/login",
        "/mfa",
        "/mfa/resend",
        "/mfa/verify",
        "/accept-invitation",
        "/register",
        "/verify-identity",
        "/google",
    ];
    SUFFIXES.iter().any(|suffix| {
        relative == *suffix || relative.ends_with(&format!("/{}", suffix.trim_start_matches('/')))
    })
}

fn read_session_cookie(req: &HttpRequest) -> Option<String> {
    let header = req.headers().get("cookie")?.to_str().ok()?;
    for part in header.split(';') {
        if let Some(value) = part.trim().strip_prefix("pg_admin_session=") {
            let value = value.trim();
            if (20..=4096).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn clear_cookie_header(config: &Config) -> String {
    set_cookie_header(config, "", 0)
}

fn set_cookie_header(config: &Config, token: &str, max_age: u64) -> String {
    let secure = if config.session_cookie_secure {
        "; Secure"
    } else {
        ""
    };
    format!(
        "pg_admin_session={token}; Path=/api/v1/admin; HttpOnly; SameSite=Strict{secure}; Max-Age={max_age}"
    )
}

async fn read_json_body(
    payload: Payload,
    req: &HttpRequest,
    limit: u64,
) -> Result<Value, ApiError> {
    let declared = req
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > limit) {
        return Err(body_parser_error(413));
    }
    let body = read_body(payload, limit).await?;
    if body.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match content_type.as_str() {
        "application/json" => {
            let parsed: Value =
                serde_json::from_slice(&body).map_err(|_| body_parser_error(400))?;
            // `express.json()` defaults to `strict: true`: only objects and arrays are accepted.
            match parsed {
                Value::Object(_) | Value::Array(_) => Ok(parsed),
                _ => Err(body_parser_error(400)),
            }
        }
        "application/x-www-form-urlencoded" => Ok(parse_urlencoded(&body)),
        _ => Ok(Value::Object(Map::new())),
    }
}

async fn read_body(mut payload: Payload, limit: u64) -> Result<Bytes, ApiError> {
    let mut output = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return Err(body_parser_error(400));
        };
        if output.len() as u64 + chunk.len() as u64 > limit {
            return Err(body_parser_error(413));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(output))
}

fn accumulate(map: &mut Map<String, Value>, key: String, value: Value) {
    match map.get_mut(&key) {
        Some(Value::Array(list)) => list.push(value),
        Some(existing) => {
            let first = existing.take();
            map.insert(key, Value::Array(vec![first, value]));
        }
        None => {
            map.insert(key, value);
        }
    }
}

fn parse_urlencoded(body: &[u8]) -> Value {
    let mut map: Map<String, Value> = Map::new();
    for (key, value) in url::form_urlencoded::parse(body) {
        accumulate(
            &mut map,
            key.into_owned(),
            Value::String(value.into_owned()),
        );
    }
    Value::Object(map)
}

fn parse_query(raw: &str) -> Result<Map<String, Value>, ApiError> {
    let mut map: Map<String, Value> = Map::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        accumulate(
            &mut map,
            key.into_owned(),
            Value::String(value.into_owned()),
        );
    }
    Ok(map)
}

fn scalar_query(query: &Value) -> Vec<(String, QueryValue)> {
    let Some(map) = query.as_object() else {
        return Vec::new();
    };
    let mut output = Vec::new();
    for (key, value) in map {
        match value {
            Value::String(value) => output.push((key.clone(), QueryValue::Text(value.clone()))),
            Value::Bool(value) => output.push((key.clone(), QueryValue::Bool(*value))),
            Value::Number(number) => {
                if let Some(integer) = number.as_i64() {
                    output.push((key.clone(), QueryValue::Integer(integer)));
                } else if let Some(float) = number.as_f64() {
                    output.push((key.clone(), QueryValue::Text(float.to_string())));
                }
            }
            _ => {}
        }
    }
    output
}

fn render_core_path(template: &str, params: &Map<String, Value>) -> EdgeResult<String> {
    let mut path = String::with_capacity(template.len());
    for segment in template.split('/') {
        if segment.is_empty() {
            continue;
        }
        path.push('/');
        if let Some(name) = segment.strip_prefix(':') {
            let value = match params.get(name) {
                Some(Value::String(value)) => value.clone(),
                Some(Value::Number(number)) => number.to_string(),
                Some(Value::Bool(flag)) => flag.to_string(),
                _ => String::new(),
            };
            path.push_str(&encode_uri_component(&value));
        } else {
            path.push_str(segment);
        }
    }
    if path.is_empty() {
        path.push('/');
    }
    Ok(path)
}

fn min_lsn_of(req: &HttpRequest) -> EdgeResult<Option<String>> {
    let Some(value) = req
        .headers()
        .get("x-pg-min-lsn")
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if pg_upstream::valid_min_lsn(value) {
        Ok(Some(value.to_owned()))
    } else {
        Err(ApiError::new(
            400,
            "INVALID_MIN_LSN",
            "x-pg-min-lsn must look like <hex>/<hex>",
        ))
    }
}

fn idempotency_key(req: &HttpRequest) -> Option<String> {
    req.headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| pg_upstream::valid_idempotency_key(value))
        .map(str::to_owned)
}

struct CallContext<'a> {
    state: &'a AppState,
    request_id: &'a str,
    client_ip: &'a str,
    authorization: Option<&'a str>,
    req: &'a HttpRequest,
}

impl CallContext<'_> {
    #[allow(clippy::too_many_arguments)]
    async fn call(
        &self,
        method: CoreMethod,
        path: String,
        query: Vec<(String, QueryValue)>,
        body: Option<Bytes>,
        extra_headers: &[(String, String)],
        raw_content_type: Option<&str>,
        timeout_ms: u64,
        plane: Plane,
    ) -> EdgeResult<CoreResponse> {
        let min_lsn = min_lsn_of(self.req)?;
        let idempotency = idempotency_key(self.req);
        let caller: Vec<(&str, &str)> = extra_headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let headers = core_headers(
            &caller,
            self.request_id,
            self.client_ip,
            self.req
                .headers()
                .get("user-agent")
                .and_then(|value| value.to_str().ok()),
            self.authorization,
            body.is_some(),
            raw_content_type,
            min_lsn.as_deref(),
            idempotency.as_deref(),
            plane,
        )?;
        let headers = headers
            .with_content_length(body.as_ref().map(Bytes::len))
            .map_err(|error| crate::error::map_transport_error(&error))?;
        let request = CoreRequest {
            method,
            path,
            query,
            headers,
            body,
            timeout_ms,
            retry: RetryOptions::default(),
            idempotency_key: idempotency,
        };
        self.state.client.call(plane, &request).await
    }
}

fn relay_response_headers(response: &CoreResponse, out: &mut HttpResponse, names: &[&str]) {
    for name in names {
        if let Some(value) = response.header(name) {
            if let (Ok(name), Ok(value)) = (
                ntex::http::header::HeaderName::from_bytes(name.as_bytes()),
                ntex::http::header::HeaderValue::from_str(value),
            ) {
                out.headers_mut().insert(name, value);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn forward(
    state: &AppState,
    request_id: &str,
    route: &Route,
    params: &Map<String, Value>,
    query: &Value,
    body: &Value,
    client_ip: &str,
    authorization: Option<&str>,
    req: &HttpRequest,
    capture: bool,
) -> HttpResponse {
    let Some(method) = CoreMethod::parse(route.method) else {
        return error_response(&ApiError::new(
            501,
            "NOT_IMPLEMENTED_ROUTE",
            "Unsupported forward method",
        ));
    };
    let payload = if matches!(route.method, "GET" | "HEAD") {
        None
    } else {
        Some(Bytes::from(
            serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec()),
        ))
    };
    let path = match render_core_path(&route.core, params) {
        Ok(path) => path,
        Err(error) => return error_response(&error),
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization,
        req,
    };
    let response = match context
        .call(
            method,
            path,
            scalar_query(query),
            payload,
            &[],
            None,
            state.config.request_timeout_ms,
            Plane::Live,
        )
        .await
    {
        Ok(response) => response,
        Err(error) => return error_response(&error),
    };
    if response.status >= 400 {
        return error_response(&map_core_http_error(response.status, &response.json()));
    }
    let status = if route.relay_status {
        response.status
    } else {
        route.status
    };
    let mut body = response.body.clone();
    let mut content_type = response
        .header("content-type")
        .unwrap_or("application/json; charset=utf-8")
        .to_owned();
    let mut cookie: Option<String> = None;
    if capture && state.config.session_cookie_mode {
        if let Ok(mut parsed) = serde_json::from_slice::<Value>(&body) {
            if let Some(token) = parsed.get("token").and_then(Value::as_str) {
                let token = token.to_owned();
                if let Some(object) = parsed.as_object_mut() {
                    object.remove("token");
                    object.insert("sessionCookie".to_owned(), Value::Bool(true));
                }
                body = Bytes::from(serde_json::to_vec(&parsed).unwrap_or_default());
                content_type = "application/json; charset=utf-8".to_owned();
                cookie = Some(token);
            }
        }
    }
    let mut out = body_response(status, &content_type, body);
    relay_response_headers(&response, &mut out, &["x-pg-served-by", "x-pg-min-lsn"]);
    if let Some(token) = cookie {
        if let Ok(value) = ntex::http::header::HeaderValue::from_str(&set_cookie_header(
            &state.config,
            &token,
            43_200,
        )) {
            out.headers_mut().append(
                ntex::http::header::HeaderName::from_static("set-cookie"),
                value,
            );
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
async fn forward_raw(
    state: &AppState,
    request_id: &str,
    route: &Route,
    params: &Map<String, Value>,
    query: &Value,
    client_ip: &str,
    authorization: Option<&str>,
    req: &HttpRequest,
    mode: RawMode,
) -> HttpResponse {
    let Some(method) = CoreMethod::parse(route.method) else {
        return error_response(&ApiError::new(
            501,
            "NOT_IMPLEMENTED_ROUTE",
            "Unsupported forward method",
        ));
    };
    let path = match render_core_path(&route.core, params) {
        Ok(path) => path,
        Err(error) => return error_response(&error),
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization,
        req,
    };
    let response = match context
        .call(
            method,
            path,
            scalar_query(query),
            None,
            &[],
            None,
            state.config.request_timeout_ms,
            Plane::Live,
        )
        .await
    {
        Ok(response) => response,
        Err(error) => return error_response(&error),
    };
    if response.status >= 400 {
        return error_response(&map_core_http_error(response.status, &response.json()));
    }
    let content_type = response
        .header("content-type")
        .unwrap_or("application/octet-stream")
        .to_owned();
    let mut out = body_response(response.status, &content_type, response.body.clone());
    match mode {
        RawMode::Plain => relay_response_headers(
            &response,
            &mut out,
            &[
                "content-type",
                "content-disposition",
                "x-content-sha256",
                "x-pg-served-by",
                "x-pg-min-lsn",
            ],
        ),
        // The KYB and brand-asset handlers read the core response directly in TS and set their
        // own type/disposition/CSP; they do not relay the checksum header.
        RawMode::KybContent | RawMode::AssetContent => {
            relay_response_headers(&response, &mut out, &["content-disposition"])
        }
    }
    match mode {
        RawMode::Plain => {}
        RawMode::KybContent => {
            let base = content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let allowed = matches!(
                base.as_str(),
                "image/png" | "image/jpeg" | "application/pdf"
            );
            let id = params.get("id").and_then(Value::as_str).unwrap_or_default();
            let disposition =
                safe_attachment_disposition(response.header("content-disposition"), id);
            let headers = out.headers_mut();
            headers.insert(
                ntex::http::header::CONTENT_TYPE,
                ntex::http::header::HeaderValue::from_str(if allowed {
                    &base
                } else {
                    "application/octet-stream"
                })
                .unwrap_or_else(|_| {
                    ntex::http::header::HeaderValue::from_static("application/octet-stream")
                }),
            );
            if let Ok(value) = ntex::http::header::HeaderValue::from_str(&disposition) {
                headers.insert(ntex::http::header::CONTENT_DISPOSITION, value);
            }
            headers.insert(
                ntex::http::header::CONTENT_SECURITY_POLICY,
                ntex::http::header::HeaderValue::from_static("sandbox; default-src 'none'"),
            );
            headers.insert(
                ntex::http::header::CACHE_CONTROL,
                ntex::http::header::HeaderValue::from_static("private, no-store"),
            );
            headers.insert(
                ntex::http::header::X_CONTENT_TYPE_OPTIONS,
                ntex::http::header::HeaderValue::from_static("nosniff"),
            );
        }
        RawMode::AssetContent => {
            let base = content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let allowed = matches!(base.as_str(), "image/png" | "image/svg+xml");
            let headers = out.headers_mut();
            headers.insert(
                ntex::http::header::CONTENT_TYPE,
                ntex::http::header::HeaderValue::from_str(if allowed {
                    &base
                } else {
                    "application/octet-stream"
                })
                .unwrap_or_else(|_| {
                    ntex::http::header::HeaderValue::from_static("application/octet-stream")
                }),
            );
            headers.insert(
                ntex::http::header::CONTENT_DISPOSITION,
                ntex::http::header::HeaderValue::from_static("inline"),
            );
            headers.insert(
                ntex::http::header::CONTENT_SECURITY_POLICY,
                ntex::http::header::HeaderValue::from_static("sandbox; default-src 'none'"),
            );
            headers.insert(
                ntex::http::header::CACHE_CONTROL,
                ntex::http::header::HeaderValue::from_static("private, max-age=300"),
            );
            headers.insert(
                ntex::http::header::X_CONTENT_TYPE_OPTIONS,
                ntex::http::header::HeaderValue::from_static("nosniff"),
            );
        }
    }
    out
}

fn safe_attachment_disposition(upstream: Option<&str>, id: &str) -> String {
    let fallback = format!(
        "kyb-document-{}",
        id.chars()
            .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
            .take(64)
            .collect::<String>()
    );
    let name = upstream
        .and_then(|value| {
            let start = value.find("filename=")?;
            let rest = value[start + "filename=".len()..].trim();
            let rest = rest.trim_matches('"');
            let candidate: String = rest
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
                .take(120)
                .collect();
            (!candidate.is_empty()).then_some(candidate)
        })
        .unwrap_or(fallback);
    format!("attachment; filename=\"{name}\"")
}

async fn logout(
    state: &AppState,
    request_id: &str,
    client_ip: &str,
    authorization: Option<&str>,
    req: &HttpRequest,
) -> HttpResponse {
    let Some(authorization) = authorization else {
        return json_response(200, &json!({ "revoked": false }));
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization: Some(authorization),
        req,
    };
    let result = context
        .call(
            CoreMethod::Post,
            "/internal/admin/auth/logout".to_owned(),
            Vec::new(),
            Some(Bytes::from_static(b"{}")),
            &[],
            None,
            state.config.request_timeout_ms,
            Plane::Live,
        )
        .await;
    match result {
        Ok(response) if response.status == 401 => json_response(200, &json!({ "revoked": false })),
        Ok(response) if response.status >= 400 => {
            error_response(&map_core_http_error(response.status, &response.json()))
        }
        Ok(_) => json_response(200, &json!({ "revoked": true })),
        Err(error) => error_response(&error),
    }
}

async fn approval_bulk_reject(
    state: &AppState,
    request_id: &str,
    body: &Value,
    client_ip: &str,
    authorization: Option<&str>,
    req: &HttpRequest,
) -> HttpResponse {
    let approval_ids: Vec<String> = body
        .get("approvalIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let payload = match crate::contract::to_core_approval_reject(body) {
        Ok(payload) => payload,
        Err(error) => return error_response(&error),
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization,
        req,
    };
    let mut results = Vec::new();
    let mut rejected = 0u64;
    let mut failed = 0u64;
    for approval_id in &approval_ids {
        let result = context
            .call(
                CoreMethod::Post,
                format!(
                    "/internal/admin/approvals/{}/reject",
                    encode_uri_component(approval_id)
                ),
                Vec::new(),
                Some(Bytes::from(
                    serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec()),
                )),
                &[],
                None,
                state.config.request_timeout_ms,
                Plane::Live,
            )
            .await;
        match result {
            Ok(response) if (200..300).contains(&response.status) => {
                rejected += 1;
                let parsed = response.json();
                results.push(json!({
                    "approvalId": approval_id,
                    "status": "REJECTED",
                    "state": parsed.get("state").cloned().unwrap_or_else(|| json!("REJECTED")),
                }));
            }
            Ok(response) => {
                failed += 1;
                let parsed = response.json();
                results.push(json!({
                    "approvalId": approval_id,
                    "status": "FAILED",
                    "httpStatus": response.status,
                    "code": parsed.get("code").cloned().unwrap_or(Value::Null),
                    "message": parsed.get("message").cloned().unwrap_or(Value::Null),
                }));
            }
            Err(error) => {
                failed += 1;
                results.push(json!({
                    "approvalId": approval_id,
                    "status": "FAILED",
                    "message": error.message,
                }));
            }
        }
    }
    json_response(
        200,
        &json!({
            "requested": approval_ids.len(),
            "rejected": rejected,
            "failed": failed,
            "results": results,
        }),
    )
}

async fn users_bulk_patch(
    state: &AppState,
    request_id: &str,
    body: &Value,
    client_ip: &str,
    authorization: Option<&str>,
    req: &HttpRequest,
) -> HttpResponse {
    let parts = match crate::contract::to_core_user_updates(body) {
        Ok(parts) => parts,
        Err(error) => return error_response(&error),
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization,
        req,
    };
    let mut results = Vec::new();
    let mut accepted = false;
    let mut last_status = 200u16;
    for part in parts {
        let result = context
            .call(
                CoreMethod::Patch,
                "/internal/admin/users".to_owned(),
                Vec::new(),
                Some(Bytes::from(
                    serde_json::to_vec(&part).unwrap_or_else(|_| b"{}".to_vec()),
                )),
                &[],
                None,
                state.config.request_timeout_ms,
                Plane::Live,
            )
            .await;
        match result {
            Ok(response) => {
                last_status = response.status;
                if response.status == 202 {
                    accepted = true;
                }
                if response.status >= 400 {
                    return error_response(&map_core_http_error(response.status, &response.json()));
                }
                results.push(response.json());
            }
            Err(error) => return error_response(&error),
        }
    }
    json_response(
        if accepted { 202 } else { last_status },
        &Value::Array(results),
    )
}

#[allow(clippy::too_many_arguments)]
async fn upload_request(
    state: &AppState,
    spec: &UploadSpec,
    params: Map<String, Value>,
    request_id: &str,
    client_ip: &str,
    authorization: Option<&str>,
    req: HttpRequest,
    payload: Payload,
) -> HttpResponse {
    if let Some(response) = admin_limiter(state, client_ip) {
        return response;
    }
    if let Err(error) = require_session(authorization) {
        return error_response(&error);
    }
    if let Guard::Authorities { write, .. } = spec.guard {
        if let Err(error) = require_authorities(write, authorization, &state.config.authority_hints)
        {
            return error_response(&error);
        }
    }
    let upload_key = format!("{client_ip}|upload");
    if let Some(response) = limited(
        state.limiters.upload.check(&upload_key),
        "RATE_LIMITED",
        "Too many uploads, please retry later",
    ) {
        return response;
    }
    let declared = req
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let budget = state
        .config
        .max_upload_bytes
        .saturating_add(upload::MULTIPART_OVERHEAD_BYTES);
    if declared.is_some_and(|length| length > budget) {
        return error_response(&ApiError::new(
            413,
            "UPLOAD_TOO_LARGE",
            "The uploaded file exceeds the size limit",
        ));
    }
    let body = match read_body(payload, budget).await {
        Ok(body) => body,
        Err(_) => {
            return error_response(&ApiError::new(
                413,
                "UPLOAD_TOO_LARGE",
                "The uploaded file exceeds the size limit",
            ));
        }
    };
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let form = match upload::parse_multipart(
        content_type,
        &body,
        spec.field,
        state.config.max_upload_bytes,
        32,
    ) {
        Ok(form) => form,
        Err(error) => return error_response(&error),
    };
    let parse_params = |schema: &Schema| -> Result<Map<String, Value>, HttpResponse> {
        parse_or_throw(schema, &Value::Object(params.clone()))
            .map(|value| value.as_object().cloned().unwrap_or_default())
            .map_err(|error| error_response(&error))
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization,
        req: &req,
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut result = match spec.route {
        UploadRoute::JoinRequestKyb => {
            let id = match parse_params(&crate::schemas::join_request_id_params()) {
                Ok(params) => params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                Err(response) => return response,
            };
            let fields = form.fields_json();
            let fields = match parse_or_throw(&join_kyb_fields(), &fields) {
                Ok(fields) => fields,
                Err(error) => return error_response(&error),
            };
            let Some(file) = &form.file else {
                return error_response(&ApiError::new(
                    400,
                    "UPLOAD_REQUIRED",
                    "A KYB document file is required",
                ));
            };
            let detected = match upload::assert_allowed_upload(
                &file.bytes,
                Some(&file.content_type),
                &kyb_mimes(),
                state.config.max_upload_bytes,
            ) {
                Ok(detected) => detected,
                Err(error) => return error_response(&error),
            };
            let mut metadata = serde_json::Map::new();
            metadata.insert(
                "documentType".to_owned(),
                fields
                    .get("documentType")
                    .cloned()
                    .unwrap_or_else(|| json!("OTHER")),
            );
            metadata.insert(
                "fileName".to_owned(),
                Value::String(file.filename.chars().take(255).collect::<String>()),
            );
            if let Some(expires) = fields.get("expiresOn") {
                metadata.insert("expiresOn".to_owned(), expires.clone());
            }
            let metadata = Value::Object(metadata);
            let (upload_headers, _) = upload_headers(file, detected, &metadata, false);
            headers.extend(upload_headers);
            context
                .call(
                    CoreMethod::Post,
                    spec.core.replace(":id", &encode_uri_component(&id)),
                    Vec::new(),
                    Some(Bytes::from(file.bytes.clone())),
                    &headers,
                    Some("application/octet-stream"),
                    state.config.request_timeout_ms,
                    Plane::Live,
                )
                .await
                .map(|response| (response, true))
        }
        UploadRoute::DisputeAttachment => {
            let id = match parse_params(&crate::schemas::finance_id_params()) {
                Ok(params) => params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                Err(response) => return response,
            };
            let Some(file) = &form.file else {
                return error_response(&ApiError::new(
                    400,
                    "UPLOAD_REQUIRED",
                    "An evidence file is required",
                ));
            };
            let detected = match upload::assert_allowed_upload(
                &file.bytes,
                Some(&file.content_type),
                &kyb_mimes(),
                state.config.max_upload_bytes,
            ) {
                Ok(detected) => detected,
                Err(error) => return error_response(&error),
            };
            let label = form
                .field("label")
                .map(str::to_owned)
                .unwrap_or_else(|| file.filename.clone());
            let metadata = json!({ "label": label.chars().take(255).collect::<String>() });
            let (upload_headers, _) = upload_headers(file, detected, &metadata, true);
            headers.extend(upload_headers);
            context
                .call(
                    CoreMethod::Post,
                    spec.core.replace(":id", &encode_uri_component(&id)),
                    Vec::new(),
                    Some(Bytes::from(file.bytes.clone())),
                    &headers,
                    Some("application/octet-stream"),
                    state.config.request_timeout_ms,
                    Plane::Live,
                )
                .await
                .map(|response| (response, false))
        }
        UploadRoute::AmlEvidence => {
            let id = match parse_params(&crate::schemas::aml_id_params()) {
                Ok(params) => params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                Err(response) => return response,
            };
            let Some(file) = &form.file else {
                return error_response(&ApiError::new(
                    400,
                    "UPLOAD_REQUIRED",
                    "An evidence file is required",
                ));
            };
            let detected = match upload::assert_allowed_upload(
                &file.bytes,
                Some(&file.content_type),
                &kyb_mimes(),
                state.config.max_upload_bytes,
            ) {
                Ok(detected) => detected,
                Err(error) => return error_response(&error),
            };
            let label = form
                .field("label")
                .map(str::to_owned)
                .unwrap_or_else(|| file.filename.clone());
            let mut metadata = serde_json::Map::new();
            metadata.insert(
                "label".to_owned(),
                Value::String(label.chars().take(255).collect::<String>()),
            );
            metadata.insert(
                "evidenceType".to_owned(),
                Value::String(form.field("evidenceType").unwrap_or("DOCUMENT").to_owned()),
            );
            if let Some(notes) = form.field("notes") {
                metadata.insert("notes".to_owned(), Value::String(notes.to_owned()));
            }
            let metadata = Value::Object(metadata);
            let (upload_headers, _) = upload_headers(file, detected, &metadata, true);
            headers.extend(upload_headers);
            context
                .call(
                    CoreMethod::Post,
                    spec.core.replace(":id", &encode_uri_component(&id)),
                    Vec::new(),
                    Some(Bytes::from(file.bytes.clone())),
                    &headers,
                    Some("application/octet-stream"),
                    state.config.request_timeout_ms,
                    Plane::Live,
                )
                .await
                .map(|response| (response, false))
        }
        UploadRoute::ReconciliationStatement => {
            let mut fields = form.fields_json();
            if let Some(Value::String(raw)) = fields.get("checklist").cloned() {
                if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                    if let Some(object) = fields.as_object_mut() {
                        object.insert("checklist".to_owned(), parsed);
                    }
                }
            }
            let metadata = match parse_or_throw(&crate::schemas::reconciliation_upload(), &fields) {
                Ok(metadata) => metadata,
                Err(error) => return error_response(&error),
            };
            let mapped = match crate::contract::to_core_reconciliation_upload(&metadata) {
                Ok(mapped) => mapped,
                Err(error) => return error_response(&error),
            };
            let Some(file) = &form.file else {
                return error_response(&ApiError::new(
                    400,
                    "UPLOAD_REQUIRED",
                    "A statement file is required in the statement field",
                ));
            };
            let detected = match upload::assert_allowed_upload(
                &file.bytes,
                Some(&file.content_type),
                &state.config.upload_allowed_mime,
                state.config.max_upload_bytes,
            ) {
                Ok(detected) => detected,
                Err(error) => return error_response(&error),
            };
            let (upload_headers, _) = upload_headers(file, detected, &metadata, true);
            headers.extend(upload_headers);
            headers.push((
                "x-statement-source-id".to_owned(),
                mapped
                    .get("sourceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ));
            context
                .call(
                    CoreMethod::Post,
                    spec.core.to_owned(),
                    Vec::new(),
                    Some(Bytes::from(file.bytes.clone())),
                    &headers,
                    Some("application/octet-stream"),
                    state.config.reconciliation_timeout_ms,
                    Plane::Live,
                )
                .await
                .map(|response| (response, false))
        }
        UploadRoute::Asset => {
            let name = form.field("name").map(str::trim).unwrap_or("");
            if name.is_empty() || name.chars().count() > 120 {
                return error_response(&ApiError::new(
                    400,
                    "ASSET_NAME_INVALID",
                    "The asset name must be 1-120 characters",
                ));
            }
            let Some(file) = &form.file else {
                return error_response(&ApiError::new(
                    400,
                    "UPLOAD_REQUIRED",
                    "An asset file is required",
                ));
            };
            let detected = match upload::brand_asset_mime(&file.bytes) {
                Ok(detected) => detected,
                Err(error) => return error_response(&error),
            };
            let metadata = json!({ "name": name });
            let (upload_headers, _) = upload_headers(file, detected, &metadata, true);
            headers.extend(upload_headers);
            context
                .call(
                    CoreMethod::Post,
                    spec.core.to_owned(),
                    Vec::new(),
                    Some(Bytes::from(file.bytes.clone())),
                    &headers,
                    Some("application/octet-stream"),
                    state.config.request_timeout_ms,
                    Plane::Live,
                )
                .await
                .map(|response| (response, false))
        }
    };
    match &mut result {
        Ok((response, _)) if response.status >= 400 => {
            error_response(&map_core_http_error(response.status, &response.json()))
        }
        Ok((response, relay)) => {
            let status = if *relay { response.status } else { spec.status };
            json_response(status, &response.json())
        }
        Err(error) => error_response(error),
    }
}

fn join_kyb_fields() -> Schema {
    crate::schema::object()
        .def(
            "documentType",
            crate::schema::pattern(2, 64, "^[A-Za-z0-9_]{2,64}$"),
            json!("OTHER"),
        )
        .opt("expiresOn", crate::schema::date())
        .strict()
        .build()
}

fn kyb_mimes() -> Vec<String> {
    vec![
        "image/png".to_owned(),
        "image/jpeg".to_owned(),
        "application/pdf".to_owned(),
    ]
}

fn upload_headers(
    file: &UploadFile,
    detected: &str,
    metadata: &Value,
    with_filename: bool,
) -> (Vec<(String, String)>, ()) {
    let mut headers = Vec::new();
    if with_filename {
        headers.push((
            "x-upload-filename".to_owned(),
            upload::encode_uri_component(&file.filename.chars().take(200).collect::<String>()),
        ));
    }
    headers.push(("x-upload-content-type".to_owned(), detected.to_owned()));
    headers.push((
        "x-upload-sha256".to_owned(),
        hex::encode(Sha256::digest(&file.bytes)),
    ));
    headers.push(("x-upload-size".to_owned(), file.bytes.len().to_string()));
    headers.push((
        "x-upload-metadata".to_owned(),
        upload::base64url(serde_json::to_vec(metadata).unwrap_or_default().as_slice()),
    ));
    (headers, ())
}

#[allow(clippy::too_many_arguments)]
async fn sandbox_proxy(
    state: &AppState,
    request_id: &str,
    method: &str,
    path: &str,
    client_ip: &str,
    authorization: Option<&str>,
    req: HttpRequest,
    payload: Payload,
) -> HttpResponse {
    let Some(authorization) = authorization else {
        return error_response(&ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        ));
    };
    let limit = state.config.json_limit_for(req.path());
    let body = if matches!(method, "GET" | "HEAD") {
        Value::Object(Map::new())
    } else {
        match read_json_body(payload, &req, limit).await {
            Ok(body) => body,
            Err(error) => return error_response(&error),
        }
    };
    let target = match sandbox::target_path(path, Some(&body)) {
        Ok(target) => target,
        Err(error) => return error_response(&error),
    };
    let mut query: Vec<(String, QueryValue)> = target
        .query
        .iter()
        .map(|(key, value)| (key.clone(), QueryValue::Text(value.clone())))
        .collect();
    if let Ok(original) = parse_query(req.query_string()) {
        query.extend(scalar_query(&Value::Object(original)));
    }
    let is_mirror = path == "/mirror" || path.starts_with("/mirror/");
    let mut forward_body = body.clone();
    if !is_mirror && path == "/reset" && method == "POST" {
        forward_body = sandbox::reset_body(&body);
    }
    let mut extra_headers = vec![
        ("x-execution-plane".to_owned(), "SANDBOX".to_owned()),
        ("x-sandbox-proxy".to_owned(), "admin-back".to_owned()),
    ];
    let merchant_from_body = body.get("merchantId").and_then(Value::as_str);
    let merchant_from_query = parse_query(req.query_string()).ok().and_then(|query| {
        query
            .get("merchantId")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let merchant_from_header = req
        .headers()
        .get("x-sandbox-merchant-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Some(merchant) = merchant_from_body
        .map(str::to_owned)
        .or(merchant_from_query)
        .or(merchant_from_header)
    {
        extra_headers.push(("x-sandbox-merchant-id".to_owned(), merchant));
    }
    let payload_bytes = if matches!(method, "GET" | "HEAD") {
        None
    } else {
        Some(Bytes::from(
            serde_json::to_vec(&forward_body).unwrap_or_else(|_| b"{}".to_vec()),
        ))
    };
    let Some(core_method) = CoreMethod::parse(method) else {
        return error_response(&ApiError::new(
            501,
            "NOT_IMPLEMENTED_ROUTE",
            "Unsupported forward method",
        ));
    };
    let context = CallContext {
        state,
        request_id,
        client_ip,
        authorization: Some(authorization),
        req: &req,
    };
    let response = match context
        .call(
            core_method,
            target.path,
            query,
            payload_bytes,
            &extra_headers,
            None,
            state.config.request_timeout_ms,
            Plane::Sandbox,
        )
        .await
    {
        Ok(response) => response,
        Err(error) => return error_response(&error),
    };
    if is_mirror {
        let content_type = response
            .header("content-type")
            .unwrap_or("application/json; charset=utf-8")
            .to_owned();
        let mut out = body_response(response.status, &content_type, response.body.clone());
        relay_response_headers(
            &response,
            &mut out,
            &["content-type", "content-disposition"],
        );
        return out;
    }
    if response.status >= 400 {
        return error_response(&map_core_http_error(response.status, &response.json()));
    }
    json_response(response.status, &response.json())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_literal_before_parameter() {
        let config = Arc::new(
            crate::config::Config::from_env(
                &pg_config::Env::process()
                    .with_value("CORE_BACK_URL", "https://core.internal:4000")
                    .with_value("MTLS_CLIENT_CERT_PATH", "/certs/c.pem")
                    .with_value("MTLS_CLIENT_KEY_PATH", "/certs/k.pem")
                    .with_value("MTLS_CA_CERT_PATH", "/certs/ca.pem"),
            )
            .expect("config"),
        );
        let sender: Arc<dyn crate::client::NodeSender> = Arc::new(NoopSender);
        let client = Arc::new(CoreClient::new(&config, sender));
        let state = AppState::new(
            config,
            client,
            crate::routes::table(),
            crate::routes::uploads(),
        );
        let (route, _) = state
            .match_route("GET", "/merchants/summary")
            .expect("route");
        assert_eq!(route.pattern, "/merchants/summary");
        let (route, params) = state.match_route("GET", "/merchants/abc").expect("route");
        assert_eq!(route.pattern, "/merchants/:id");
        assert_eq!(params.get("id").and_then(Value::as_str), Some("abc"));
    }

    struct NoopSender;

    #[async_trait::async_trait]
    impl crate::client::NodeSender for NoopSender {
        async fn send(
            &self,
            _node_url: &str,
            _request: &CoreRequest,
            _timeout: std::time::Duration,
        ) -> Result<CoreResponse, crate::client::SendError> {
            Err(crate::client::SendError::Local(
                pg_upstream::PoolError::unavailable(),
            ))
        }
    }

    #[test]
    fn session_cookie_attributes_match_the_ts_helper() {
        let config = crate::config::Config::from_env(
            &pg_config::Env::process()
                .with_value("CORE_BACK_URL", "https://core.internal:4000")
                .with_value("MTLS_CLIENT_CERT_PATH", "/certs/c.pem")
                .with_value("MTLS_CLIENT_KEY_PATH", "/certs/k.pem")
                .with_value("MTLS_CA_CERT_PATH", "/certs/ca.pem"),
        )
        .expect("config");
        let header = set_cookie_header(&config, "token", 43_200);
        assert!(header.starts_with("pg_admin_session=token; "));
        assert!(header.contains("Path=/api/v1/admin"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Strict"));
        assert!(header.contains("Secure"));
        assert!(header.contains("Max-Age=43200"));
        let cleared = clear_cookie_header(&config);
        assert!(cleared.starts_with("pg_admin_session=; "));
        assert!(cleared.contains("Max-Age=0"));
    }

    #[test]
    fn path_segments_are_percent_decoded_and_re_encoded() {
        let route = crate::routes::table()
            .into_iter()
            .find(|route| route.pattern == "/merchants/:id")
            .expect("route");
        let mut params = Map::new();
        params.insert("id".to_owned(), Value::String("a b/c".to_owned()));
        assert_eq!(
            render_core_path(&route.core, &params).expect("path"),
            "/internal/admin/merchants/a%20b%2Fc"
        );
    }
}
