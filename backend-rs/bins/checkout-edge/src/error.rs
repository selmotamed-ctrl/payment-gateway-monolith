//! Checkout edge error envelope and the public inbound error vocabulary.
//!
//! Port of `checkout-back/lib/error/index.ts` (`ApiError`, `notFoundHandler`,
//! `apiErrorHandler`), `checkout-back/lib/coreInternalClient.ts` (`mapCoreHttpError`) and
//! `checkout-back/api/public/inbound.ts` (`toPublicInboundError`).
//!
//! The envelope is `{"code","message","reference"?,"details"?}`. Checkout never adds a
//! `reference` of its own; a core response's reference and details are preserved untouched.

#![forbid(unsafe_code)]

use ntex::http::StatusCode;
use ntex::web::HttpResponse;
use pg_http::ErrorEnvelope;
use serde_json::{json, Value};

/// Fallback `{code,message}` per core status (`STATUS_FALLBACKS`).
fn status_fallback(status: u16) -> (&'static str, String) {
    match status {
        400 => (
            "CORE_BAD_REQUEST",
            "Core rejected the request payload".to_owned(),
        ),
        401 => (
            "CORE_UNAUTHORIZED",
            "Core rejected the supplied credentials".to_owned(),
        ),
        403 => (
            "CORE_FORBIDDEN",
            "Core denied the operation for this principal".to_owned(),
        ),
        404 => ("CORE_NOT_FOUND", "Core resource was not found".to_owned()),
        405 => (
            "CORE_METHOD_NOT_ALLOWED",
            "Core does not allow this method".to_owned(),
        ),
        408 => ("CORE_TIMEOUT", "Core request timed out".to_owned()),
        409 => ("CORE_CONFLICT", "Core reported a state conflict".to_owned()),
        410 => (
            "CORE_GONE",
            "Core resource is no longer available".to_owned(),
        ),
        413 => (
            "CORE_PAYLOAD_TOO_LARGE",
            "Core rejected the payload size".to_owned(),
        ),
        415 => (
            "CORE_UNSUPPORTED_MEDIA_TYPE",
            "Core rejected the media type".to_owned(),
        ),
        422 => (
            "CORE_VALIDATION_FAILED",
            "Core failed payload validation".to_owned(),
        ),
        429 => (
            "CORE_RATE_LIMITED",
            "Core rate limited the request".to_owned(),
        ),
        500 => (
            "CORE_INTERNAL_ERROR",
            "Core service failed internally".to_owned(),
        ),
        502 => (
            "CORE_BAD_GATEWAY",
            "Core service returned an invalid response".to_owned(),
        ),
        503 => (
            "CORE_UNAVAILABLE",
            "Core service is temporarily unavailable".to_owned(),
        ),
        504 => (
            "CORE_GATEWAY_TIMEOUT",
            "Core service did not respond in time".to_owned(),
        ),
        other => (
            "CORE_ERROR",
            format!("Core service returned status {other}"),
        ),
    }
}

/// A request-scoped failure that renders as the platform error envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeFailure {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub reference: Option<String>,
    pub details: Option<Value>,
}

impl EdgeFailure {
    #[must_use]
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            reference: None,
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn with_reference(mut self, reference: impl Into<String>) -> Self {
        self.reference = Some(reference.into());
        self
    }

    /// `400 VALIDATION_FAILED` with the zod-shaped issue list.
    #[must_use]
    pub fn validation(details: Value) -> Self {
        Self::new(
            400,
            "VALIDATION_FAILED",
            "Request payload failed validation",
        )
        .with_details(details)
    }

    /// `400 AMOUNT_NOT_ACCEPTED` from `assertNoMonetaryFields`.
    #[must_use]
    pub fn amount_not_accepted(field: &str) -> Self {
        Self::new(
            400,
            "AMOUNT_NOT_ACCEPTED",
            "Checkout requests must never carry amount or currency; the core resolves them from the payment link",
        )
        .with_details(json!({ "field": field }))
    }

    /// `404 NOT_FOUND` from `notFoundHandler`, with the raw path and method.
    #[must_use]
    pub fn not_found(method: &str, path: &str) -> Self {
        Self::new(
            404,
            "NOT_FOUND",
            format!("No route matches {method} {path}"),
        )
    }

    /// `429 RATE_LIMITED` with the route's own message.
    #[must_use]
    pub fn rate_limited(message: impl Into<String>) -> Self {
        Self::new(429, "RATE_LIMITED", message)
    }

    /// `403 SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK`.
    #[must_use]
    pub fn sandbox_inspector_forbidden() -> Self {
        Self::new(
            403,
            "SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK",
            "The checkout inspector is only available for a Sandbox (sbx_) payment link",
        )
    }

    /// `503 SANDBOX_NODE_UNAVAILABLE` (`requireSandboxCoreBackUrls`).
    #[must_use]
    pub fn sandbox_unavailable() -> Self {
        Self::new(
            503,
            "SANDBOX_NODE_UNAVAILABLE",
            "The Sandbox environment is not configured on this gateway",
        )
    }

    /// `413 PAYLOAD_TOO_LARGE` from the body-parser branch.
    #[must_use]
    pub fn payload_too_large() -> Self {
        Self::new(
            413,
            "PAYLOAD_TOO_LARGE",
            "The request body exceeds the size limit",
        )
    }

    /// A `400`/`413`/`415` body-parser failure.
    ///
    /// Port of the `parserStatus` branch in `apiErrorHandler`: a 4xx parser error is relayed with
    /// the parser's status and the generic `BAD_REQUEST` code, except a 413 which keeps
    /// `PAYLOAD_TOO_LARGE`.
    #[must_use]
    pub fn body_parser(status: u16) -> Self {
        if status == 413 {
            return Self::payload_too_large();
        }
        Self::new(
            status,
            "BAD_REQUEST",
            "The request body could not be parsed",
        )
    }

    /// `500 SERVER_ERROR` for an unexpected edge failure.
    #[must_use]
    pub fn server_error() -> Self {
        Self::new(500, "SERVER_ERROR", "Unexpected server error")
    }

    /// The exact envelope, omitting absent optional fields.
    #[must_use]
    pub fn envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            code: self.code.clone(),
            message: self.message.clone(),
            reference: self.reference.clone(),
            details: self.details.clone(),
        }
    }

    /// Render the failure as a JSON response.
    #[must_use]
    pub fn to_response(&self) -> HttpResponse {
        let body = serde_json::to_vec(&self.envelope()).unwrap_or_else(|_| {
            br#"{"code":"SERVER_ERROR","message":"Unexpected server error"}"#.to_vec()
        });
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        HttpResponse::builder(status)
            .content_type("application/json; charset=utf-8")
            .body(body)
    }
}

impl std::fmt::Display for EdgeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for EdgeFailure {}

/// JSON parse for a core response, port of `parseJsonBuffer`:
/// an empty body is `{}` and a non-JSON body becomes `{"message": text}`.
#[must_use]
pub fn parse_json_buffer(buffer: &[u8]) -> Value {
    let text = String::from_utf8_lossy(buffer);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| json!({ "message": trimmed }))
}

fn envelope_field<'a>(payload: &'a Value, name: &str) -> Option<&'a Value> {
    payload.as_object().and_then(|object| object.get(name))
}

/// Port of `parseCoreEnvelope` + `mapCoreHttpError`.
#[must_use]
pub fn map_core_http_error(status: u16, payload: &Value) -> EdgeFailure {
    let code = envelope_field(payload, "code")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let message = envelope_field(payload, "message")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let reference = envelope_field(payload, "reference")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let details = payload
        .as_object()
        .and_then(|object| object.get("details").cloned());
    let (fallback_code, fallback_message) = status_fallback(status);
    EdgeFailure {
        status,
        code: code.unwrap_or_else(|| fallback_code.to_owned()),
        message: message.unwrap_or(fallback_message),
        reference,
        details,
    }
}

/// The public inbound error vocabulary (`PUBLIC_INBOUND_ERRORS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicInboundError {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}

pub const INBOUND_REJECTED: PublicInboundError = PublicInboundError {
    status: 400,
    code: "INBOUND_REJECTED",
    message: "The notification was rejected",
};
pub const INBOUND_NOT_FOUND: PublicInboundError = PublicInboundError {
    status: 404,
    code: "INBOUND_NOT_FOUND",
    message: "The inbound channel is not available",
};
pub const INBOUND_CONFLICT: PublicInboundError = PublicInboundError {
    status: 409,
    code: "INBOUND_CONFLICT",
    message: "The notification conflicts with the current state",
};
pub const INBOUND_TOO_LARGE: PublicInboundError = PublicInboundError {
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    message: "The notification exceeds the size limit",
};
pub const INBOUND_RATE_LIMITED: PublicInboundError = PublicInboundError {
    status: 429,
    code: "RATE_LIMITED",
    message: "Inbound webhook rate limit exceeded",
};
pub const INBOUND_UNAVAILABLE: PublicInboundError = PublicInboundError {
    status: 503,
    code: "INBOUND_UNAVAILABLE",
    message: "The notification could not be processed right now",
};

/// Port of `toPublicInboundError`: core's own codes, messages, details and references never
/// leave the edge.
#[must_use]
pub fn to_public_inbound_error(status: u16) -> PublicInboundError {
    match status {
        400 | 415 | 422 => INBOUND_REJECTED,
        401 | 403 | 404 | 410 => INBOUND_NOT_FOUND,
        409 => INBOUND_CONFLICT,
        413 => INBOUND_TOO_LARGE,
        429 => INBOUND_RATE_LIMITED,
        _ => INBOUND_UNAVAILABLE,
    }
}

impl PublicInboundError {
    #[must_use]
    pub fn to_failure(self) -> EdgeFailure {
        EdgeFailure::new(self.status, self.code, self.message)
    }

    #[must_use]
    pub fn to_response(self) -> HttpResponse {
        self.to_failure().to_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_omits_absent_fields() {
        let failure = EdgeFailure::new(400, "X", "y");
        assert_eq!(
            serde_json::to_value(failure.envelope()).expect("json"),
            json!({ "code": "X", "message": "y" })
        );
    }

    #[test]
    fn core_envelope_is_preserved() {
        let failure = map_core_http_error(
            409,
            &json!({
                "code": "SLOT_EXHAUSTED",
                "message": "no active slot left",
                "reference": "ref-42",
                "details": { "activeLockedCount": 5 },
            }),
        );
        assert_eq!(failure.status, 409);
        assert_eq!(failure.code, "SLOT_EXHAUSTED");
        assert_eq!(failure.message, "no active slot left");
        assert_eq!(failure.reference.as_deref(), Some("ref-42"));
        assert_eq!(
            serde_json::to_value(failure.envelope()).expect("json"),
            json!({
                "code": "SLOT_EXHAUSTED",
                "message": "no active slot left",
                "reference": "ref-42",
                "details": { "activeLockedCount": 5 },
            })
        );
    }

    #[test]
    fn core_status_fallbacks_match_the_ts_table() {
        assert_eq!(
            map_core_http_error(500, &json!({})).code,
            "CORE_INTERNAL_ERROR"
        );
        assert_eq!(
            map_core_http_error(502, &json!({})).code,
            "CORE_BAD_GATEWAY"
        );
        assert_eq!(
            map_core_http_error(503, &json!({})).code,
            "CORE_UNAVAILABLE"
        );
        assert_eq!(
            map_core_http_error(504, &json!({})).code,
            "CORE_GATEWAY_TIMEOUT"
        );
        assert_eq!(
            map_core_http_error(429, &json!({})).code,
            "CORE_RATE_LIMITED"
        );
        assert_eq!(
            map_core_http_error(401, &json!({})).code,
            "CORE_UNAUTHORIZED"
        );
        assert_eq!(map_core_http_error(403, &json!({})).code, "CORE_FORBIDDEN");
        assert_eq!(map_core_http_error(418, &json!({})).code, "CORE_ERROR");
        assert_eq!(
            map_core_http_error(418, &json!({})).message,
            "Core service returned status 418"
        );
    }

    #[test]
    fn non_json_core_bodies_keep_the_text_as_the_message() {
        let payload = parse_json_buffer(b"plain text");
        assert_eq!(payload, json!({ "message": "plain text" }));
        let failure = map_core_http_error(503, &payload);
        assert_eq!(failure.code, "CORE_UNAVAILABLE");
        assert_eq!(failure.message, "plain text");
    }

    #[test]
    fn empty_core_body_is_an_empty_object() {
        assert_eq!(parse_json_buffer(b""), json!({}));
        assert_eq!(parse_json_buffer(b"   "), json!({}));
        assert_eq!(parse_json_buffer(b"{\"a\":1}"), json!({ "a": 1 }));
    }

    #[test]
    fn public_inbound_errors_never_leak_core_details() {
        let failure = map_core_http_error(
            403,
            &json!({
                "code": "INBOUND_GATEWAY_MISMATCH",
                "message": "The inbound gateway does not match the channel",
                "details": { "expectedGateway": "secret-gateway" },
                "reference": "ref-internal-1",
            }),
        );
        let public = to_public_inbound_error(failure.status);
        assert_eq!(public.code, "INBOUND_NOT_FOUND");
        assert_eq!(public.message, "The inbound channel is not available");
        let rendered = serde_json::to_value(public.to_failure().envelope()).expect("json");
        assert_eq!(rendered.as_object().expect("object").len(), 2);
        assert!(!rendered.to_string().contains("secret-gateway"));
        assert!(!rendered.to_string().contains("ref-internal-1"));
    }

    #[test]
    fn inbound_error_mapping_table() {
        assert_eq!(to_public_inbound_error(400).code, "INBOUND_REJECTED");
        assert_eq!(to_public_inbound_error(415).code, "INBOUND_REJECTED");
        assert_eq!(to_public_inbound_error(422).code, "INBOUND_REJECTED");
        assert_eq!(to_public_inbound_error(401).code, "INBOUND_NOT_FOUND");
        assert_eq!(to_public_inbound_error(410).code, "INBOUND_NOT_FOUND");
        assert_eq!(to_public_inbound_error(409).code, "INBOUND_CONFLICT");
        assert_eq!(to_public_inbound_error(413).status, 413);
        assert_eq!(to_public_inbound_error(429).status, 429);
        assert_eq!(to_public_inbound_error(500).code, "INBOUND_UNAVAILABLE");
        assert_eq!(to_public_inbound_error(302).code, "INBOUND_UNAVAILABLE");
    }

    #[test]
    fn body_parser_errors_keep_the_express_branch() {
        assert_eq!(EdgeFailure::body_parser(413).code, "PAYLOAD_TOO_LARGE");
        assert_eq!(
            EdgeFailure::body_parser(413).message,
            "The request body exceeds the size limit"
        );
        assert_eq!(EdgeFailure::body_parser(400).status, 400);
        assert_eq!(EdgeFailure::body_parser(400).code, "BAD_REQUEST");
        assert_eq!(
            EdgeFailure::body_parser(400).message,
            "The request body could not be parsed"
        );
        assert_eq!(EdgeFailure::body_parser(415).status, 415);
    }

    #[test]
    fn not_found_message_names_the_method_and_raw_path() {
        let failure = EdgeFailure::not_found("GET", "/api/v1/nope");
        assert_eq!(failure.status, 404);
        assert_eq!(failure.message, "No route matches GET /api/v1/nope");
    }
}
