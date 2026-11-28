//! HTTP entrypoint: body parsing, the peer allowlist and the route table shared by the rail
//! protocol, the tester portal, the control plane, the SDK scripts and the health endpoints.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::net::IpAddr;

use ipnet::IpNet;
use ntex::http::StatusCode;
use ntex::web::{self, HttpRequest, HttpResponse};
use serde_json::{json, Map, Value};

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct IncomingRequest {
    pub method: String,
    pub path: String,
    pub query: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub peer: Option<IpAddr>,
}

impl IncomingRequest {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    #[must_use]
    pub fn content_type(&self) -> Option<&str> {
        self.header("content-type")
    }

    #[must_use]
    pub fn raw_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The parsed request body. JSON objects stay objects; form bodies become string maps;
    /// multipart text parts become a string map; anything else is an empty object, matching the
    /// TS `asRecord` contract used by the rail handlers.
    #[must_use]
    pub fn json_body(&self) -> Value {
        if self.body.is_empty() {
            return Value::Object(Map::new());
        }
        let content_type = self.content_type().unwrap_or("application/json");
        if content_type.contains("application/json") || content_type.contains("+json") {
            return serde_json::from_slice(&self.body)
                .unwrap_or_else(|_| Value::Object(Map::new()));
        }
        if content_type.contains("application/x-www-form-urlencoded") {
            let mut object = Map::new();
            for (key, value) in url::form_urlencoded::parse(&self.body) {
                object.insert(key.into_owned(), Value::String(value.into_owned()));
            }
            return Value::Object(object);
        }
        if content_type.contains("multipart/form-data") {
            return Value::Object(parse_multipart(&self.body, content_type));
        }
        Value::Object(Map::new())
    }

    /// Strict JSON parse for endpoints whose body must be JSON (login, control writes).
    pub fn parse_json_strict(&self) -> Result<Value, ApiError> {
        if self.body.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        serde_json::from_slice(&self.body)
            .map_err(|_| ApiError::new(400, "SERVER_ERROR", "Internal server error"))
    }
}

pub enum ResponseBody {
    Json(Value),
    Text(String),
    Bytes(Vec<u8>),
    Empty,
    Sse,
}

pub struct AppResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: ResponseBody,
}

impl std::fmt::Debug for AppResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppResponse")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl AppResponse {
    #[must_use]
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: Some("application/json; charset=utf-8".to_owned()),
            headers: Vec::new(),
            body: ResponseBody::Json(body),
        }
    }

    #[must_use]
    pub fn text(status: u16, content_type: &str, body: String) -> Self {
        Self {
            status,
            content_type: Some(content_type.to_owned()),
            headers: Vec::new(),
            body: ResponseBody::Text(body),
        }
    }

    #[must_use]
    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: Some(content_type.to_owned()),
            headers: Vec::new(),
            body: ResponseBody::Bytes(body),
        }
    }

    #[must_use]
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: None,
            headers: Vec::new(),
            body: ResponseBody::Empty,
        }
    }

    #[must_use]
    pub fn sse() -> Self {
        Self {
            status: 200,
            content_type: Some("text/event-stream".to_owned()),
            headers: vec![
                (
                    "cache-control".to_owned(),
                    "no-cache, no-transform".to_owned(),
                ),
                ("x-accel-buffering".to_owned(), "no".to_owned()),
            ],
            body: ResponseBody::Sse,
        }
    }

    #[must_use]
    pub fn with_header(mut self, name: &str, value: String) -> Self {
        self.headers.push((name.to_owned(), value));
        self
    }
}

/// Parses the raw request path into percent-decoded segments (the gateway code and ids may be
/// encoded; a decoded `/` never becomes a separator).
#[must_use]
pub fn decoded_path(raw: &str) -> String {
    let segments: Vec<String> = raw
        .split('/')
        .filter(|part| !part.is_empty())
        .map(crate::rails::percent_decode)
        .collect();
    if segments.is_empty() {
        "/".to_owned()
    } else {
        format!("/{}", segments.join("/"))
    }
}

#[must_use]
pub fn parse_query(raw: &str) -> BTreeMap<String, String> {
    let mut query = BTreeMap::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        query.insert(key.into_owned(), value.into_owned());
    }
    query
}

#[must_use]
pub fn parse_multipart(body: &[u8], content_type: &str) -> Map<String, Value> {
    let boundary = content_type
        .split(';')
        .find_map(|part| part.trim().strip_prefix("boundary="))
        .map(|value| value.trim_matches('"').to_owned());
    let Some(boundary) = boundary else {
        return Map::new();
    };
    let text = String::from_utf8_lossy(body);
    let mut output = Map::new();
    for part in text.split(&format!("--{boundary}")) {
        let trimmed = part.trim();
        if trimmed.is_empty() || trimmed == "--" {
            continue;
        }
        let Some((headers, value)) = part.split_once("\r\n\r\n") else {
            continue;
        };
        let name = headers.split(';').find_map(|segment| {
            segment
                .trim()
                .strip_prefix("name=")
                .map(|value| value.trim_matches('"').to_owned())
        });
        if let Some(name) = name {
            output.insert(
                name,
                Value::String(value.trim_end_matches("\r\n").to_owned()),
            );
        }
    }
    output
}

// ---------------------------------------------------------------------------------------------
// CIDR allowlist
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CidrAllowlist {
    networks: Vec<IpNet>,
}

impl CidrAllowlist {
    #[must_use]
    pub fn parse(cidrs: &str) -> Self {
        let networks = cidrs
            .split(',')
            .filter_map(|entry| entry.trim().parse::<IpNet>().ok())
            .collect();
        Self { networks }
    }

    #[must_use]
    pub fn allows(&self, address: IpAddr) -> bool {
        let normalized = match address {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
            other => other,
        };
        if normalized.is_loopback() {
            // TS: `::1` is allowed when either loopback form is listed.
            if self
                .networks
                .iter()
                .any(|network| network.contains(&IpAddr::from([127, 0, 0, 1])))
            {
                return true;
            }
        }
        self.networks
            .iter()
            .any(|network| network.contains(&normalized))
    }
}

/// TS `parseTrustProxy`, kept for configuration parity (the login limiter keys on the real peer).
#[must_use]
pub fn parse_trust_proxy(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "false" || trimmed.is_empty() {
        "false".to_owned()
    } else {
        // TS returns a hop count for digits and a keyword/CIDR string otherwise; the Rust config
        // keeps the textual form of both.
        trimmed.to_owned()
    }
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

pub async fn route(state: &AppState, request: &IncomingRequest) -> Result<AppResponse, ApiError> {
    if request.method == "GET" && request.path == "/health" {
        let release = std::env::var("APP_RELEASE").ok();
        let commit = std::env::var("APP_COMMIT")
            .or_else(|_| std::env::var("GIT_COMMIT"))
            .ok();
        return Ok(AppResponse::json(
            200,
            json!({
                "status": "ok",
                "service": "fake-rails-back",
                "release": release,
                "commit": commit,
            }),
        ));
    }
    if request.method == "GET" && request.path == "/hosted/health" {
        return Ok(AppResponse::json(
            200,
            json!({"ok": true, "service": "fake-rails-hosted"}),
        ));
    }
    if request.path == "/sdk" && request.method == "GET" {
        return Ok(AppResponse::json(
            200,
            json!({"scripts": crate::sdk::sdk_list(&state.config)}),
        ));
    }
    if let Some(name) = request.path.strip_prefix("/sdk/") {
        if request.method == "GET" {
            if let Some(script) = crate::sdk::sdk_script(&state.config, name) {
                return Ok(AppResponse::text(200, "application/javascript", script));
            }
        }
        return Err(ApiError::new(404, "NOT_FOUND", "Route not found"));
    }
    if let Some(rest) = request.path.strip_prefix("/rails/") {
        let mut parts = rest.splitn(2, '/');
        let gateway = parts.next().unwrap_or_default().to_owned();
        let rail_path = parts
            .next()
            .map_or_else(|| "/".to_owned(), |value| format!("/{value}"));
        let rail_request = crate::rails::RailRequest {
            gateway_code: gateway,
            method: request.method.clone(),
            path: rail_path,
            query: request.query.clone(),
            headers: request.headers.clone(),
            body: request.json_body(),
            raw_body: request.raw_text(),
        };
        let response = crate::rails::handle_rails(state, &rail_request).await?;
        let mut result = response.raw.map_or_else(
            || AppResponse::json(response.status, response.body),
            |(content_type, body)| AppResponse::text(response.status, &content_type, body),
        );
        for (name, value) in response.headers {
            result.headers.push((name, value));
        }
        if response.close_connection {
            result
                .headers
                .push(("connection".to_owned(), "close".to_owned()));
        }
        return Ok(result);
    }
    if let Some(rest) = request.path.strip_prefix("/portal-api") {
        let relative = if rest.is_empty() { "/" } else { rest };
        let scoped = IncomingRequest {
            path: relative.to_owned(),
            ..request.clone()
        };
        return crate::portal::handle_portal(state, &scoped).await;
    }
    if let Some(rest) = request.path.strip_prefix("/control") {
        let relative = if rest.is_empty() { "/" } else { rest };
        let scoped = IncomingRequest {
            path: relative.to_owned(),
            ..request.clone()
        };
        return crate::portal::handle_control(state, &scoped).await;
    }
    Err(ApiError::new(404, "NOT_FOUND", "Route not found"))
}

/// Builds the ntex `HttpResponse` for a routed request.
pub async fn ntex_dispatch(req: HttpRequest, mut payload: web::types::Payload) -> HttpResponse {
    let Some(state) = req.app_value::<AppState>() else {
        return error_response(&ApiError::server_error());
    };
    let peer = req.peer_addr().map(|address| address.ip());
    let allowlist = CidrAllowlist::parse(&state.config.allowed_cidrs);
    let peer_allowed = match peer {
        Some(address) => allowlist.allows(address),
        // No transport peer exists only in the in-process test harness; production refuses it.
        None => state.config.node_env != "production",
    };
    if !peer_allowed {
        return error_response(&ApiError::new(
            403,
            "FORBIDDEN_NETWORK",
            "This network is not allowed to reach Fake Rails",
        ));
    }
    let mut body = Vec::new();
    loop {
        match payload.recv().await {
            Some(Ok(chunk)) => {
                if body.len() + chunk.len() > state.config.max_body_bytes {
                    return error_response(&ApiError::new(
                        413,
                        "PAYLOAD_TOO_LARGE",
                        "Request body is too large",
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Some(Err(_)) => {
                return error_response(&ApiError::new(
                    400,
                    "PAYLOAD_ERROR",
                    "The request body could not be read",
                ))
            }
            None => break,
        }
    }
    let mut headers = BTreeMap::new();
    for (name, value) in req.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), value.to_owned());
        }
    }
    let request = IncomingRequest {
        method: req.method().as_str().to_owned(),
        path: decoded_path(req.path()),
        query: parse_query(req.query_string()),
        headers,
        body,
        peer,
    };
    match route(state, &request).await {
        Ok(response) => response.into_http(state),
        Err(error) => error_response(&error),
    }
}

impl AppResponse {
    #[must_use]
    pub fn into_http(self, state: &AppState) -> HttpResponse {
        if matches!(self.body, ResponseBody::Sse) {
            let mut builder = HttpResponse::builder(StatusCode::OK);
            builder.content_type("text/event-stream");
            for (name, value) in &self.headers {
                builder.header(name.as_str(), value.as_str());
            }
            builder.header("connection", "keep-alive");
            return builder.streaming(state.hub.subscribe());
        }
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut builder = HttpResponse::builder(status);
        match self.body {
            ResponseBody::Json(value) => {
                builder.content_type(
                    self.content_type
                        .as_deref()
                        .unwrap_or("application/json; charset=utf-8"),
                );
                for (name, value) in &self.headers {
                    builder.header(name.as_str(), value.as_str());
                }
                builder.body(value.to_string())
            }
            ResponseBody::Text(text) => {
                builder.content_type(self.content_type.as_deref().unwrap_or("text/plain"));
                for (name, value) in &self.headers {
                    builder.header(name.as_str(), value.as_str());
                }
                builder.body(text)
            }
            ResponseBody::Bytes(bytes) => {
                builder.content_type(
                    self.content_type
                        .as_deref()
                        .unwrap_or("application/octet-stream"),
                );
                for (name, value) in &self.headers {
                    builder.header(name.as_str(), value.as_str());
                }
                builder.body(bytes)
            }
            ResponseBody::Empty => {
                for (name, value) in &self.headers {
                    builder.header(name.as_str(), value.as_str());
                }
                builder.build()
            }
            ResponseBody::Sse => builder.build(),
        }
    }
}

fn error_response(error: &ApiError) -> HttpResponse {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    HttpResponse::builder(status)
        .content_type("application/json; charset=utf-8")
        .body(error.body().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_allowlist_matches_the_ts_matcher() {
        let allowed = CidrAllowlist::parse("127.0.0.1/32,10.0.0.0/8");
        assert!(allowed.allows("127.0.0.1".parse().expect("ip")));
        assert!(allowed.allows("::ffff:10.1.2.3".parse().expect("ip")));
        assert!(allowed.allows("::1".parse().expect("ip")));
        assert!(!allowed.allows("203.0.113.9".parse().expect("ip")));
        assert_eq!(parse_trust_proxy("loopback"), "loopback");
        assert_eq!(parse_trust_proxy("false"), "false");
        assert_eq!(parse_trust_proxy("2"), "2");
    }

    #[test]
    fn multipart_text_parts_are_parsed() {
        let body = b"--BOUND\r\nContent-Disposition: form-data; name=\"amount\"\r\n\r\n10.00\r\n--BOUND--\r\n";
        let parts = parse_multipart(body, "multipart/form-data; boundary=BOUND");
        assert_eq!(parts.get("amount"), Some(&json!("10.00")));
    }

    #[test]
    fn decoded_path_keeps_encoded_slashes_inside_a_segment() {
        assert_eq!(
            decoded_path("/rails/edfali/status/A%2FB"),
            "/rails/edfali/status/A/B"
        );
        assert_eq!(decoded_path("/"), "/");
    }
}
