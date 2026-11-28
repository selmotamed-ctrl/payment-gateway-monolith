//! Route templates and the shared `coreForward` executor.
//!
//! Port of `merchant-back/api/forward.ts`: validate params/query/body, translate the public
//! payload, re-validate the canonical payload, call core, relay `x-pg-served-by` /
//! `x-pg-min-lsn`, and answer with either the declared status or the one core returned
//! (`relayStatus`).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use pg_upstream::{CoreMethod, Plane, QueryValue};
use serde_json::{Map, Value};

use crate::app::{AppState, Prepared};
use crate::error::EdgeApiError;
use crate::http::{decode_uri_component, encode_uri_component, EdgeResponse};
use crate::upstream::{plane_for_authorization, relayed_headers, CoreRequest, CoreResponse};
use crate::validate::{validate_to_error, Schema};

/// One segment of a path template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathSeg {
    Literal(&'static str),
    Param(&'static str),
}

/// A rooted path template with `:param` segments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTemplate {
    pub segments: Vec<PathSeg>,
    pub wildcard: bool,
}

impl PathTemplate {
    /// Parse `/a/:id/b` (a trailing `{*rest}` marks a wildcard prefix route).
    #[must_use]
    pub fn parse(pattern: &'static str) -> Self {
        let mut segments = Vec::new();
        let mut wildcard = false;
        for part in pattern.split('/').skip(1) {
            if part == "{*rest}" {
                wildcard = true;
                continue;
            }
            if let Some(name) = part.strip_prefix(':') {
                segments.push(PathSeg::Param(name));
            } else {
                segments.push(PathSeg::Literal(part));
            }
        }
        Self { segments, wildcard }
    }

    /// Render the path, `encodeURIComponent`-encoding every parameter.
    #[must_use]
    pub fn render(&self, params: &BTreeMap<String, String>) -> String {
        let mut output = String::new();
        for segment in &self.segments {
            output.push('/');
            match segment {
                PathSeg::Literal(text) => output.push_str(text),
                PathSeg::Param(name) => {
                    output.push_str(&encode_uri_component(
                        params.get(*name).map(String::as_str).unwrap_or(""),
                    ));
                }
            }
        }
        if self.segments.is_empty() {
            output.push('/');
        }
        output
    }

    /// Match a wildcard prefix route (`/api/v1/merchant/sandbox` and everything below).
    #[must_use]
    pub fn matches_prefix(&self, path: &str) -> bool {
        if !self.wildcard {
            return path == self.render(&BTreeMap::new());
        }
        let prefix = self.render(&BTreeMap::new());
        path == prefix || path.starts_with(&format!("{prefix}/"))
    }
}

/// Capture the parameters of a concrete path (static or `:param` segments).
#[must_use]
pub fn capture(template: &PathTemplate, path: &str, params: &mut BTreeMap<String, String>) -> bool {
    let pieces: Vec<&str> = path.split('/').skip(1).collect();
    if pieces.len() != template.segments.len() {
        return false;
    }
    for (piece, segment) in pieces.iter().zip(&template.segments) {
        match segment {
            PathSeg::Literal(text) => {
                if piece != text {
                    return false;
                }
            }
            PathSeg::Param(name) => {
                if piece.is_empty() {
                    return false;
                }
                let decoded = decode_uri_component(piece).unwrap_or_else(|| (*piece).to_owned());
                params.insert((*name).to_owned(), decoded);
            }
        }
    }
    true
}

/// A public→core mapper (`toCore*` in `merchant-back/api/contract.ts`).
pub type Mapper = fn(&Value) -> Value;

/// A payload enrichment step applied after the public schema and before the mapper.
pub type Enrich = fn(Value) -> Result<Value, EdgeApiError>;

/// The declaration of one forwarded route.
#[derive(Clone)]
pub struct ForwardSpec {
    pub method: CoreMethod,
    pub path: PathTemplate,
    pub public_pattern: &'static str,
    pub body_schema: Option<Schema>,
    pub core_schema: Option<Schema>,
    pub params_schema: Option<Schema>,
    pub query_schema: Option<Schema>,
    pub status: u16,
    pub relay_status: bool,
    pub require_auth: bool,
    pub mapper: Option<Mapper>,
    pub capture_cookie: bool,
    pub idempotency_header: bool,
    pub enrich: Option<Enrich>,
}

impl std::fmt::Debug for ForwardSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ForwardSpec")
            .field("method", &self.method)
            .field("public_pattern", &self.public_pattern)
            .field("status", &self.status)
            .field("relay_status", &self.relay_status)
            .field("require_auth", &self.require_auth)
            .finish_non_exhaustive()
    }
}

impl ForwardSpec {
    #[must_use]
    pub fn new(method: CoreMethod, public_pattern: &'static str, core_path: &'static str) -> Self {
        Self {
            method,
            path: PathTemplate::parse(core_path),
            public_pattern,
            body_schema: None,
            core_schema: None,
            params_schema: None,
            query_schema: None,
            status: 200,
            relay_status: false,
            require_auth: true,
            mapper: None,
            capture_cookie: false,
            idempotency_header: false,
            enrich: None,
        }
    }

    #[must_use]
    pub fn body(mut self, schema: Schema) -> Self {
        self.body_schema = Some(schema);
        self
    }

    #[must_use]
    pub fn core_schema(mut self, schema: Schema) -> Self {
        self.core_schema = Some(schema);
        self
    }

    #[must_use]
    pub fn params(mut self, schema: Schema) -> Self {
        self.params_schema = Some(schema);
        self
    }

    #[must_use]
    pub fn query(mut self, schema: Schema) -> Self {
        self.query_schema = Some(schema);
        self
    }

    #[must_use]
    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    #[must_use]
    pub fn relay(mut self) -> Self {
        self.relay_status = true;
        self
    }

    #[must_use]
    pub fn public_route(mut self) -> Self {
        self.require_auth = false;
        self
    }

    #[must_use]
    pub fn mapper(mut self, mapper: Mapper) -> Self {
        self.mapper = Some(mapper);
        self
    }

    #[must_use]
    pub fn capture_cookie(mut self) -> Self {
        self.capture_cookie = true;
        self
    }

    #[must_use]
    pub fn idempotency_header(mut self) -> Self {
        self.idempotency_header = true;
        self
    }

    #[must_use]
    pub fn enrich(mut self, enrich: Enrich) -> Self {
        self.enrich = Some(enrich);
        self
    }
}

/// `scalarQuery`: keep only string/number/boolean values (arrays and objects are dropped).
#[must_use]
pub fn scalar_query(query: &Map<String, Value>) -> Vec<(String, QueryValue)> {
    query
        .iter()
        .filter_map(|(key, value)| match value {
            Value::String(text) => Some((key.clone(), QueryValue::Text(text.clone()))),
            Value::Bool(boolean) => Some((key.clone(), QueryValue::Bool(*boolean))),
            Value::Number(number) => number
                .as_i64()
                .map(|integer| (key.clone(), QueryValue::Integer(integer))),
            Value::Null | Value::Array(_) | Value::Object(_) => None,
        })
        .collect()
}

/// Execute a forwarded route.
pub async fn deliver(
    app: &AppState,
    prepared: &Prepared,
    spec: &ForwardSpec,
) -> Result<EdgeResponse, EdgeApiError> {
    if spec.require_auth && prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }

    // Params.
    let mut params = prepared.params.clone();
    if let Some(schema) = &spec.params_schema {
        let value = Value::Object(
            params
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect(),
        );
        let validated = validate_to_error(schema, &value)?;
        if let Value::Object(object) = validated {
            params = object
                .into_iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_owned())))
                .collect();
        }
    }

    // Query.
    let query = if let Some(schema) = &spec.query_schema {
        let value = Value::Object(prepared.query_object.clone());
        match validate_to_error(schema, &value)? {
            Value::Object(object) => object,
            _ => Map::new(),
        }
    } else {
        Map::new()
    };

    // Body.
    let read_only = matches!(spec.method, CoreMethod::Get | CoreMethod::Head);
    let mut body = if read_only {
        None
    } else {
        Some(prepared.json_body.clone())
    };
    if let Some(body_value) = body.as_mut() {
        if spec.idempotency_header {
            if let (Some(header), Value::Object(object)) =
                (prepared.idempotency_key.as_deref(), &mut *body_value)
            {
                if !object.contains_key("idempotencyKey") {
                    object.insert(
                        "idempotencyKey".to_owned(),
                        Value::String(header.to_owned()),
                    );
                }
            }
        }
        if let Some(schema) = &spec.body_schema {
            *body_value = validate_to_error(schema, body_value)?;
        }
        if let Some(enrich) = spec.enrich {
            *body_value = enrich(body_value.clone())?;
        }
        if let Some(mapper) = spec.mapper {
            *body_value = mapper(body_value);
        }
        if let Some(schema) = &spec.core_schema {
            *body_value = validate_to_error(schema, body_value)?;
        }
    }

    let path = spec.path.render(&params);
    let body_bytes = body
        .as_ref()
        .map(|value| serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()));
    send_to_core(app, prepared, spec, path, scalar_query(&query), body_bytes).await
}

/// Execute a route whose body was validated by a custom handler (token creation).
pub async fn deliver_with_body(
    app: &AppState,
    prepared: &Prepared,
    spec: &ForwardSpec,
    body: Value,
) -> Result<EdgeResponse, EdgeApiError> {
    if spec.require_auth && prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    let mut body = Some(body);
    if let Some(body_value) = body.as_mut() {
        if let Some(schema) = &spec.core_schema {
            *body_value = validate_to_error(schema, body_value)?;
        }
    }
    let path = spec.path.render(&prepared.params);
    let body_bytes = body
        .as_ref()
        .map(|value| serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()));
    send_to_core(app, prepared, spec, path, Vec::new(), body_bytes).await
}

async fn send_to_core(
    app: &AppState,
    prepared: &Prepared,
    spec: &ForwardSpec,
    path: String,
    query: Vec<(String, QueryValue)>,
    body_bytes: Option<Vec<u8>>,
) -> Result<EdgeResponse, EdgeApiError> {
    let plane = plane_for_authorization(prepared.authorization.as_deref());
    if plane == Plane::Sandbox && !app.sandbox_configured() {
        return Err(EdgeApiError::from_pool(
            &pg_upstream::PoolError::sandbox_unavailable(),
        ));
    }
    let caller_headers: Vec<(&str, &str)> = Vec::new();
    let meta = pg_upstream::CoreRequestMeta {
        channel: pg_upstream::EdgeChannel::Merchant,
        plane,
        request_id: &prepared.request_id,
        client_ip: &prepared.client_ip,
        user_agent: prepared.user_agent.as_deref(),
        authorization: prepared.authorization.as_deref(),
        body_present: body_bytes.is_some(),
        raw_content_type: None,
        min_lsn: None,
        idempotency_key: None,
    };
    let headers =
        CoreRequest::build_headers(&caller_headers, &meta, body_bytes.as_ref().map(Vec::len))
            .map_err(|error| EdgeApiError::from_pool(&error))?;
    let request = CoreRequest {
        plane,
        method: spec.method,
        path,
        query,
        headers,
        body: body_bytes,
        timeout_ms: None,
    };
    let response: CoreResponse = app
        .transport
        .call(request)
        .await
        .map_err(|error| EdgeApiError::from_pool(&error))?;
    if response.status >= 400 {
        return Err(EdgeApiError::from_core(
            response.status,
            &response.json_body(),
        ));
    }
    let mut body_value = response.json_body();
    let mut set_cookie = None;
    if spec.capture_cookie && app.config.session_cookie_mode {
        let config = pg_edge::SessionCookieConfig::for_channel(
            pg_edge::SessionChannel::Merchant,
            app.config.session_cookie_secure,
        );
        set_cookie = pg_edge::capture_session_token(&config, response.status, &mut body_value);
    }
    let status = if spec.relay_status {
        response.status
    } else {
        spec.status
    };
    let mut edge = EdgeResponse::json(status, &body_value);
    for (name, value) in relayed_headers(&response) {
        edge.set_header(&name, &value);
    }
    if let Some(cookie) = set_cookie {
        edge.headers.push(("set-cookie".to_owned(), cookie));
    }
    Ok(edge)
}
