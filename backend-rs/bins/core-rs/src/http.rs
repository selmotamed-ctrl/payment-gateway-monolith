//! The HTTP boundary of the core shell: request pipeline, body limits and the error envelope.
//!
//! Port of `core-back/index.ts:40-191` (middleware order, request id, JSON limits, error handler)
//! and `core-back/lib/rawBody/index.ts` (which routes take raw bytes and at what limit, chapter 2
//! §2).
//!
//! Pipeline order reproduced by [`crate::app::dispatch`]:
//!
//! 1. request id (`x-request-id` accepted when it matches `^[A-Za-z0-9._:-]{1,128}$`);
//! 2. the request timer and the short console id start;
//! 3. raw-body routes, then JSON (24 MB under `/internal/{admin,merchant}/report-engine`, else
//!    1 MB), then urlencoded (1 MB): an oversized body is refused before routing, like Express;
//! 4. the router (mTLS channel guard, then the route handler);
//! 5. the response headers (`x-request-id`), the request log and the access-log sink;
//! 6. the error envelope (`{code,message,reference?,details?}`).
//!
//! One deliberate quirk is copied from the TS error handler: an oversized **plain** JSON/raw body
//! becomes `500 SERVER_ERROR` (Express's `PayloadTooLargeError` is neither an `ApiError` nor a
//! `SyntaxError`), while the report-engine prefix is wrapped and answers `413 PAYLOAD_TOO_LARGE`.
//! A malformed JSON body is `400 SERVER_ERROR` (a `SyntaxError`).

#![forbid(unsafe_code)]

use ntex::http::header::{HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE};
use ntex::http::StatusCode;
use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_http::limits::{
    json_limit_for, raw_body_limit_for, REPORT_ENGINE_JSON_LIMIT, URLENCODED_LIMIT,
};
use pg_http::request_id::REQUEST_ID_HEADER;
use pg_http::{ApiError, RequestId};

use crate::logging::{self, AccessLogRecord, AccessLogSink, RequestLine, Started};

/// The request id extension stored on every request.
pub type RequestIdExtension = RequestId;

/// Read the request id the pipeline stored (`reference` of every error).
#[must_use]
pub fn request_id(request: &HttpRequest) -> Option<String> {
    request
        .extensions()
        .get::<RequestIdExtension>()
        .map(|id| id.0.clone())
}

/// The `x-request-id` header value, when present.
#[must_use]
pub fn incoming_request_id(request: &HttpRequest) -> Option<String> {
    request
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Attach the request id to a request so handlers and the error envelope can read it.
pub fn attach_request_id(request: &HttpRequest, request_id: &RequestId) {
    request.extensions_mut().insert(request_id.clone());
}

/// Build the JSON error response, attaching the request id as `reference`.
#[must_use]
pub fn error_response(request: &HttpRequest, error: ApiError) -> HttpResponse {
    let mut error = error;
    if error.reference.is_none() {
        error.reference = request_id(request);
    }
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    HttpResponse::builder(status)
        .content_type("application/json; charset=utf-8")
        .body(error.to_json())
}

/// `toErrorEnvelope` for a non-`ApiError` failure: `500 SERVER_ERROR` with the reference.
#[must_use]
pub fn server_error_response(request: &HttpRequest) -> HttpResponse {
    error_response(request, ApiError::server_error())
}

/// What kind of body a path accepts (chapter 2 §2 table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyLimit {
    Raw(u64),
    Json(u64),
    Urlencoded(u64),
    None,
}

impl BodyLimit {
    #[must_use]
    pub fn limit(self) -> Option<u64> {
        match self {
            Self::Raw(limit) | Self::Json(limit) | Self::Urlencoded(limit) => Some(limit),
            Self::None => None,
        }
    }
}

/// True when the content type is JSON for the Express parser (`application/json` or `+json`).
#[must_use]
pub fn is_json_content_type(content_type: &str) -> bool {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    base == "application/json" || (base.starts_with("application/") && base.ends_with("+json"))
}

/// True when the content type is the urlencoded parser's.
#[must_use]
pub fn is_urlencoded_content_type(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/x-www-form-urlencoded")
}

/// Select the parser (and limit) for a request, mirroring the middleware order.
#[must_use]
pub fn body_limit_for(path: &str, content_type: Option<&str>) -> BodyLimit {
    if let Some(limit) = raw_body_limit_for(path) {
        return BodyLimit::Raw(limit);
    }
    match content_type {
        Some(content_type) if is_json_content_type(content_type) => {
            BodyLimit::Json(json_limit_for(path))
        }
        Some(content_type) if is_urlencoded_content_type(content_type) => {
            BodyLimit::Urlencoded(URLENCODED_LIMIT)
        }
        _ => BodyLimit::None,
    }
}

/// The error an oversized body produces.
///
/// `report-engine` answers the wrapped 413; every other body parser's `entity.too.large` reaches
/// the TS error handler as a non-`ApiError`/non-`SyntaxError` and becomes `500 SERVER_ERROR`.
#[must_use]
pub fn oversize_error(path: &str, limit: u64) -> ApiError {
    if (path.starts_with("/internal/admin/report-engine")
        || path.starts_with("/internal/merchant/report-engine"))
        && limit == REPORT_ENGINE_JSON_LIMIT
    {
        return ApiError::new(
            413,
            "PAYLOAD_TOO_LARGE",
            "The request body exceeds the report-engine size limit",
        )
        .with_details(serde_json::json!({ "limit": REPORT_ENGINE_JSON_LIMIT }));
    }
    ApiError::server_error()
}

/// The declared-content-length guard. Returns the refusal when the body is already known too big.
///
/// A chunked body without `Content-Length` is not refused here; a handler that reads a body must
/// use [`read_payload`], which enforces the same limit while streaming.
#[must_use]
pub fn declared_body_error(request: &HttpRequest) -> Option<ApiError> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let limit = body_limit_for(request.path(), content_type).limit()?;
    let declared = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())?;
    if declared > limit {
        return Some(oversize_error(request.path(), limit));
    }
    None
}

/// Read a payload with a hard byte limit (used by handlers that accept a body).
///
/// The TS parsers abort as soon as the limit is crossed, so this stops reading at `limit + 1`
/// bytes instead of buffering the whole stream first.
pub async fn read_payload(
    mut payload: ntex::web::types::Payload,
    limit: u64,
) -> Result<ntex::util::Bytes, ApiError> {
    let mut buffered = ntex::util::BytesMut::new();
    let mut seen: u64 = 0;
    loop {
        match payload.recv().await {
            None => break,
            Some(Ok(chunk)) => {
                seen = seen.saturating_add(chunk.len() as u64);
                if seen > limit {
                    return Err(ApiError::new(
                        413,
                        "PAYLOAD_TOO_LARGE",
                        "Request body is too large",
                    ));
                }
                buffered.extend_from_slice(&chunk);
            }
            Some(Err(_)) => return Err(ApiError::server_error()),
        }
    }
    Ok(buffered.freeze())
}

/// Parse a JSON body, mapping a syntax failure to the TS `400 SERVER_ERROR` envelope.
pub fn parse_json_body(body: &[u8]) -> Result<serde_json::Value, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError::malformed_json())
}

/// `clientIp(request)`: `x-real-client-ip` first, then the socket address.
#[must_use]
pub fn client_ip(request: &HttpRequest) -> Option<String> {
    if let Some(forwarded) = request
        .headers()
        .get("x-real-client-ip")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
    {
        return Some(forwarded.to_owned());
    }
    request.peer_addr().map(|address| address.ip().to_string())
}

/// Log-only peer address (the TS logger uses `request.ip`, never the forwarded header).
#[must_use]
pub fn peer_ip(request: &HttpRequest) -> Option<String> {
    request.peer_addr().map(|address| address.ip().to_string())
}

/// Response content length as the logger prints it.
#[must_use]
fn response_length(response: &HttpResponse) -> Option<u64> {
    response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

/// What the pipeline knows about the request when it finishes it.
#[derive(Debug, Clone)]
pub struct RequestMeta {
    pub request_id: RequestId,
    pub started: Started,
    pub short: String,
    pub method: String,
    pub path: String,
    pub peer: Option<String>,
}

impl RequestMeta {
    #[must_use]
    pub fn new(request_id: RequestId, started: Started, method: &str, path: &str) -> Self {
        Self {
            request_id,
            started,
            short: logging::short_id(),
            method: method.to_owned(),
            path: path.to_owned(),
            peer: None,
        }
    }
}

/// Finish a response: echo the request id, print the request line, queue the access-log row.
#[must_use]
pub fn finish(
    meta: &RequestMeta,
    sink: Option<&AccessLogSink>,
    mut response: HttpResponse,
) -> HttpResponse {
    if let Ok(value) = HeaderValue::from_str(&meta.request_id.0) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(REQUEST_ID_HEADER), value);
    }
    let status = response.status().as_u16();
    let duration_ms = meta.started.elapsed_ms();
    let line = logging::format_request_line(&RequestLine {
        started_at: meta.started.at,
        short: &meta.short,
        method: &meta.method,
        path: &meta.path,
        status,
        duration_ms,
        content_length: response_length(&response),
        client_ip: meta.peer.as_deref(),
        colour: false,
    });
    logging::emit_request_line(status, &line);
    if let Some(sink) = sink {
        sink.write(AccessLogRecord {
            request_id: meta.request_id.0.clone(),
            channel: logging::access_log_channel(&meta.path),
            method: meta.method.clone(),
            route_pattern: meta.path.clone(),
            status_code: i32::from(status),
            duration_ms,
            client_ip: meta.peer.clone(),
            created_at: meta.started.at,
        });
    }
    response
}

/// Express's default 404 page (`finalhandler`), reproduced for parity.
///
/// The core has no explicit 404 handler (`chapter 2 §3`), so an unknown route answers this HTML
/// page instead of a JSON envelope.
#[must_use]
pub fn not_found_response(method: &str, path: &str) -> HttpResponse {
    let escaped = path
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot {method} {escaped}</pre>\n</body>\n</html>\n"
    );
    HttpResponse::builder(StatusCode::NOT_FOUND)
        .content_type("text/html; charset=utf-8")
        .body(body)
}

/// The scaffold's answer for a core route that P4+ has not ported yet.
///
/// TS serves these routes today; answering 501 with a stable code lets the parity harness classify
/// them instead of misreading the Express 404.
#[must_use]
pub fn not_implemented_response(path: &str) -> HttpResponse {
    HttpResponse::builder(StatusCode::NOT_IMPLEMENTED)
        .content_type("application/json; charset=utf-8")
        .body(
            serde_json::json!({
                "code": "NOT_IMPLEMENTED_ROUTE",
                "message": "This route is not ported yet",
                "path": path,
            })
            .to_string(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_http::limits::{
        MAX_JSON_BODY_BYTES_DEFAULT, RAW_AML_EVIDENCE, RAW_RECONCILIATION_UPLOAD,
    };

    #[test]
    fn raw_routes_win_over_json_limits() {
        assert_eq!(
            body_limit_for(
                "/internal/admin/reconciliation/upload",
                Some("application/json")
            ),
            BodyLimit::Raw(RAW_RECONCILIATION_UPLOAD)
        );
        assert_eq!(
            body_limit_for("/internal/admin/aml/cases/abc/evidence", Some("image/png")),
            BodyLimit::Raw(RAW_AML_EVIDENCE)
        );
        assert_eq!(
            body_limit_for("/internal/checkout/inbound/foo", Some("application/json")),
            BodyLimit::Raw(25_000_000)
        );
        assert_eq!(
            body_limit_for("/internal/admin/merchants", Some("application/json")),
            BodyLimit::Json(MAX_JSON_BODY_BYTES_DEFAULT)
        );
        assert_eq!(
            body_limit_for(
                "/internal/merchant/report-engine/specs",
                Some("application/json; charset=utf-8")
            ),
            BodyLimit::Json(REPORT_ENGINE_JSON_LIMIT)
        );
        assert_eq!(
            body_limit_for("/internal/admin/merchants", Some("text/plain")),
            BodyLimit::None,
            "Express skips both parsers for an unexpected content type"
        );
        assert_eq!(
            body_limit_for(
                "/internal/admin/x",
                Some("application/x-www-form-urlencoded")
            ),
            BodyLimit::Urlencoded(URLENCODED_LIMIT)
        );
    }

    #[test]
    fn json_content_type_accepts_structured_suffixes() {
        assert!(is_json_content_type("application/json"));
        assert!(is_json_content_type("Application/JSON; charset=utf-8"));
        assert!(is_json_content_type("application/merge-patch+json"));
        assert!(!is_json_content_type("application/xml"));
    }

    #[test]
    fn oversize_is_413_only_for_the_report_engine_prefix() {
        let report = oversize_error(
            "/internal/admin/report-engine/specs",
            REPORT_ENGINE_JSON_LIMIT,
        );
        assert_eq!(report.status, 413);
        assert_eq!(report.code, "PAYLOAD_TOO_LARGE");
        assert_eq!(
            report.details.as_ref().and_then(|value| value.get("limit")),
            Some(&serde_json::json!(REPORT_ENGINE_JSON_LIMIT))
        );

        let default = oversize_error("/internal/admin/merchants", MAX_JSON_BODY_BYTES_DEFAULT);
        assert_eq!(default.status, 500);
        assert_eq!(default.code, "SERVER_ERROR");
    }

    #[test]
    fn malformed_json_is_a_400_server_error() {
        let error = parse_json_body(b"{not json").expect_err("syntax");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "SERVER_ERROR");
        assert_eq!(
            parse_json_body(br#"{"a":1}"#).expect("json"),
            serde_json::json!({"a": 1})
        );
    }

    #[test]
    fn express_404_page_is_reproduced() {
        let response = not_found_response("GET", "/nope");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(format!("{:?}", response.headers().get(CONTENT_TYPE))
            .contains("text/html; charset=utf-8"));
    }
}
