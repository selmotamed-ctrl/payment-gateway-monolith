//! The merchant edge error envelope.
//!
//! Port of `merchant-back/lib/error/index.ts` (`ApiError`, `parseOrThrow`, `notFoundHandler`,
//! `apiErrorHandler`) and `merchant-back/lib/coreInternalClient.ts:104-258`
//! (`STATUS_FALLBACKS`, `mapCoreHttpError`).
//!
//! Envelope order is `{code, message, reference?, details?}`, exactly like `ApiError.toEnvelope`.

#![forbid(unsafe_code)]

use pg_edge::EdgeError;
use pg_upstream::PoolError;
use serde_json::{Map, Value};

use crate::validate::{validation_details, Issue};

/// A failure the edge renders itself.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
    pub reference: Option<String>,
}

impl EdgeApiError {
    #[must_use]
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
            reference: None,
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

    /// `parseOrThrow`: `400 VALIDATION_FAILED` with the raw zod issue list.
    #[must_use]
    pub fn validation(issues: Vec<Issue>) -> Self {
        Self::new(
            400,
            "VALIDATION_FAILED",
            "Request payload failed validation",
        )
        .with_details(validation_details(issues))
    }

    #[must_use]
    pub fn auth_required() -> Self {
        Self::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    }

    #[must_use]
    pub fn invalid_api_token() -> Self {
        Self::new(
            401,
            "INVALID_API_TOKEN",
            "A valid pg_live_ (Live) or pg_test_ (Sandbox) bearer token is required",
        )
    }

    /// Express `body-parser` failure branch (`merchant-back/lib/error/index.ts:75-89`).
    #[must_use]
    pub fn bad_request_body() -> Self {
        Self::new(400, "BAD_REQUEST", "The request body could not be parsed")
    }

    #[must_use]
    pub fn payload_too_large() -> Self {
        Self::new(
            413,
            "PAYLOAD_TOO_LARGE",
            "The request body exceeds the size limit",
        )
    }

    #[must_use]
    pub fn not_found(method: &str, path: &str) -> Self {
        Self::new(
            404,
            "NOT_FOUND",
            format!("No route matches {method} {path}"),
        )
    }

    #[must_use]
    pub fn rate_limited(message: &str) -> Self {
        Self::new(429, "RATE_LIMITED", message)
    }

    #[must_use]
    pub fn server_error() -> Self {
        Self::new(500, "SERVER_ERROR", "Unexpected server error")
    }

    #[must_use]
    pub fn from_edge(error: EdgeError) -> Self {
        Self::new(error.status(), error.code(), error.message())
    }

    #[must_use]
    pub fn from_pool(error: &PoolError) -> Self {
        if error.code() == "CORE_RESPONSE_TOO_LARGE" {
            // Exact TS message of `mapCoreTransportError`.
            return Self::new(
                502,
                "CORE_RESPONSE_TOO_LARGE",
                "Core response exceeded the edge size limit",
            );
        }
        Self::new(error.status(), error.code(), error.message())
    }

    /// Map a non-2xx core answer (`mapCoreHttpError`).
    ///
    /// A core envelope supplies `code`, `message`, `details` and `reference`; otherwise the
    /// status fallback table is used.
    #[must_use]
    pub fn from_core(status: u16, payload: &Value) -> Self {
        let envelope = core_envelope(payload);
        let (fallback_code, fallback_message) = status_fallback(status);
        let code = envelope
            .as_ref()
            .and_then(|envelope| envelope.0.clone())
            .unwrap_or_else(|| fallback_code.to_owned());
        let message = envelope
            .as_ref()
            .and_then(|envelope| envelope.1.clone())
            .unwrap_or(fallback_message);
        let mut error = Self::new(status, code, message);
        if let Some(envelope) = envelope {
            error.details = envelope.2;
            error.reference = envelope.3;
        }
        error
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".to_owned(), Value::String(self.code.clone()));
        map.insert("message".to_owned(), Value::String(self.message.clone()));
        if let Some(reference) = &self.reference {
            map.insert("reference".to_owned(), Value::String(reference.clone()));
        }
        if let Some(details) = &self.details {
            map.insert("details".to_owned(), details.clone());
        }
        Value::Object(map)
    }
}

impl std::fmt::Display for EdgeApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for EdgeApiError {}

type CoreEnvelope = (
    Option<String>,
    Option<String>,
    Option<Value>,
    Option<String>,
);

fn core_envelope(payload: &Value) -> Option<CoreEnvelope> {
    let object = payload.as_object()?;
    let code = object
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let reference = object
        .get("reference")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let details = object.get("details").cloned();
    if code.is_none() && message.is_none() && details.is_none() && reference.is_none() {
        return None;
    }
    Some((code, message, details, reference))
}

/// `STATUS_FALLBACKS` (`merchant-back/lib/coreInternalClient.ts:104-121`).
#[must_use]
pub fn status_fallback(status: u16) -> (&'static str, String) {
    let pair = match status {
        400 => ("CORE_BAD_REQUEST", "Core rejected the request payload"),
        401 => (
            "CORE_UNAUTHORIZED",
            "Core rejected the supplied credentials",
        ),
        403 => (
            "CORE_FORBIDDEN",
            "Core denied the operation for this principal",
        ),
        404 => ("CORE_NOT_FOUND", "Core resource was not found"),
        405 => ("CORE_METHOD_NOT_ALLOWED", "Core does not allow this method"),
        408 => ("CORE_TIMEOUT", "Core request timed out"),
        409 => ("CORE_CONFLICT", "Core reported a state conflict"),
        410 => ("CORE_GONE", "Core resource is no longer available"),
        413 => ("CORE_PAYLOAD_TOO_LARGE", "Core rejected the payload size"),
        415 => (
            "CORE_UNSUPPORTED_MEDIA_TYPE",
            "Core rejected the media type",
        ),
        422 => ("CORE_VALIDATION_FAILED", "Core failed payload validation"),
        429 => ("CORE_RATE_LIMITED", "Core rate limited the request"),
        500 => ("CORE_INTERNAL_ERROR", "Core service failed internally"),
        502 => (
            "CORE_BAD_GATEWAY",
            "Core service returned an invalid response",
        ),
        503 => (
            "CORE_UNAVAILABLE",
            "Core service is temporarily unavailable",
        ),
        504 => (
            "CORE_GATEWAY_TIMEOUT",
            "Core service did not respond in time",
        ),
        _ => ("CORE_ERROR", "Core service returned an unexpected status"),
    };
    (pair.0, pair.1.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_matches_the_typescript_shape() {
        let error = EdgeApiError::validation(vec![Issue::new(
            "invalid_type",
            vec![crate::validate::PathItem::Key("name".to_owned())],
            "Invalid input: expected string, received undefined",
            Vec::new(),
        )]);
        assert_eq!(error.status, 400);
        let value = error.to_json();
        assert_eq!(value["code"], json!("VALIDATION_FAILED"));
        assert_eq!(value["message"], json!("Request payload failed validation"));
        assert_eq!(value["details"][0]["code"], json!("invalid_type"));
        assert_eq!(value["details"][0]["path"], json!(["name"]));
        assert!(value.get("reference").is_none());
    }

    #[test]
    fn core_envelope_is_relayed_with_details_and_reference() {
        let error = EdgeApiError::from_core(
            409,
            &json!({
                "code": "VERSION_CONFLICT",
                "message": "The application changed",
                "details": { "currentVersion": 3 },
                "reference": "req-9"
            }),
        );
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "VERSION_CONFLICT");
        assert_eq!(error.message, "The application changed");
        assert_eq!(error.details, Some(json!({ "currentVersion": 3 })));
        assert_eq!(error.reference.as_deref(), Some("req-9"));
    }

    #[test]
    fn a_bare_core_status_uses_the_fallback_table() {
        let error = EdgeApiError::from_core(502, &json!({}));
        assert_eq!(error.code, "CORE_BAD_GATEWAY");
        assert_eq!(error.message, "Core service returned an invalid response");
        let not_found = EdgeApiError::from_core(404, &json!({ "message": "nope" }));
        assert_eq!(not_found.code, "CORE_NOT_FOUND");
        assert_eq!(not_found.message, "nope");
    }

    #[test]
    fn not_found_message_contains_method_and_path() {
        let error = EdgeApiError::not_found("POST", "/api/v1/nope");
        assert_eq!(error.status, 404);
        assert_eq!(error.message, "No route matches POST /api/v1/nope");
    }

    #[test]
    fn edge_errors_keep_their_own_codes() {
        let error = EdgeApiError::from_edge(EdgeError::CsrfHeaderRequired);
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "CSRF_HEADER_REQUIRED");
        assert_eq!(
            error.message,
            "Cookie-authenticated writes must send the x-pg-csrf header"
        );
    }
}
