//! Request-scoped failures and the two error envelopes the admin edge produces.
//!
//! Port of `admin-back/lib/error/index.ts` (`ApiError`, `parseOrThrow`, the body-parser branch
//! and `notFoundHandler`) and `admin-back/lib/coreInternalClient.ts`
//! (`mapCoreHttpError`, `mapCoreTransportError`, `STATUS_FALLBACKS`).

#![forbid(unsafe_code)]

use pg_upstream::PoolError;
use serde_json::{json, Map, Value};

/// Port of `ApiError`: a status, a code, a message and an optional JSON `details` payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
    pub reference: Option<String>,
}

impl ApiError {
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
    pub fn with_reference(mut self, reference: impl Into<String>) -> Self {
        self.reference = Some(reference.into());
        self
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn validation_failed(issues: Vec<Value>) -> Self {
        Self::new(
            400,
            "VALIDATION_FAILED",
            "Request payload failed validation",
        )
        .with_details(Value::Array(issues))
    }

    #[must_use]
    pub fn auth_required() -> Self {
        Self::new(
            401,
            "AUTH_REQUIRED",
            "An administrative bearer token is required",
        )
    }

    #[must_use]
    pub fn auth_invalid() -> Self {
        Self::new(
            401,
            "AUTH_INVALID",
            "The administrative session is invalid or expired",
        )
    }

    #[must_use]
    pub fn authority_denied(required: &[&str]) -> Self {
        Self::new(
            403,
            "EDGE_AUTHORITY_DENIED",
            "The supplied administrative session does not carry the required authority",
        )
        .with_details(json!({ "required": required }))
    }

    #[must_use]
    pub fn rate_limited(code: &str, message: &str) -> Self {
        Self::new(429, code, message)
    }

    /// The JSON envelope, preserving the TS key order (`code`, `message`, `reference`, `details`).
    #[must_use]
    pub fn envelope(&self) -> Value {
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

pub type EdgeResult<T> = Result<T, ApiError>;

const STATUS_FALLBACKS: &[(u16, &str, &str)] = &[
    (400, "CORE_BAD_REQUEST", "Core rejected the request payload"),
    (
        401,
        "CORE_UNAUTHORIZED",
        "Core rejected the supplied credentials",
    ),
    (
        403,
        "CORE_FORBIDDEN",
        "Core denied the operation for this principal",
    ),
    (404, "CORE_NOT_FOUND", "Core resource was not found"),
    (
        405,
        "CORE_METHOD_NOT_ALLOWED",
        "Core does not allow this method",
    ),
    (408, "CORE_TIMEOUT", "Core request timed out"),
    (409, "CORE_CONFLICT", "Core reported a state conflict"),
    (410, "CORE_GONE", "Core resource is no longer available"),
    (
        413,
        "CORE_PAYLOAD_TOO_LARGE",
        "Core rejected the payload size",
    ),
    (
        415,
        "CORE_UNSUPPORTED_MEDIA_TYPE",
        "Core rejected the media type",
    ),
    (
        422,
        "CORE_VALIDATION_FAILED",
        "Core failed payload validation",
    ),
    (429, "CORE_RATE_LIMITED", "Core rate limited the request"),
    (500, "CORE_INTERNAL_ERROR", "Core service failed internally"),
    (
        502,
        "CORE_BAD_GATEWAY",
        "Core service returned an invalid response",
    ),
    (
        503,
        "CORE_UNAVAILABLE",
        "Core service is temporarily unavailable",
    ),
    (
        504,
        "CORE_GATEWAY_TIMEOUT",
        "Core service did not respond in time",
    ),
];

/// Parse a core envelope (`code`, `message`, `details`, `reference`) when the body carries one.
#[must_use]
fn parse_core_envelope(payload: &Value) -> Option<(&str, &str, Option<&Value>, Option<&str>)> {
    let object = payload.as_object()?;
    let code = object.get("code").and_then(Value::as_str);
    let message = object.get("message").and_then(Value::as_str);
    let reference = object.get("reference").and_then(Value::as_str);
    let details = object.get("details");
    if code.is_none() && message.is_none() && details.is_none() && reference.is_none() {
        return None;
    }
    Some((
        code.unwrap_or(""),
        message.unwrap_or(""),
        details,
        reference,
    ))
}

/// Port of `mapCoreHttpError`: keep a core envelope verbatim, otherwise use the status fallback.
#[must_use]
pub fn map_core_http_error(status: u16, payload: &Value) -> ApiError {
    let fallback = STATUS_FALLBACKS.iter().find(|entry| entry.0 == status);
    let (fallback_code, fallback_message) = match fallback {
        Some((_, code, message)) => (*code, *message),
        None => ("CORE_ERROR", "Core service returned an unexpected status"),
    };
    match parse_core_envelope(payload) {
        Some((code, message, details, reference)) => {
            let mut error = ApiError::new(
                status,
                if code.is_empty() { fallback_code } else { code },
                if message.is_empty() {
                    fallback_message
                } else {
                    message
                },
            );
            if let Some(details) = details {
                error.details = Some(details.clone());
            }
            if let Some(reference) = reference {
                error = error.with_reference(reference);
            }
            error
        }
        None => ApiError::new(status, fallback_code, fallback_message),
    }
}

/// Port of `mapCoreTransportError`: pool errors already carry the TS code and status.
#[must_use]
pub fn map_transport_error(error: &PoolError) -> ApiError {
    ApiError::new(error.status(), error.code(), error.message().to_owned())
}

/// The body-parser branch of `apiErrorHandler`: malformed JSON is `400 BAD_REQUEST`, an
/// oversized body is `413 PAYLOAD_TOO_LARGE`, and neither is the generic envelope.
#[must_use]
pub fn body_parser_error(status: u16) -> ApiError {
    if status == 413 {
        ApiError::new(
            413,
            "PAYLOAD_TOO_LARGE",
            "The request body exceeds the size limit",
        )
    } else {
        ApiError::new(400, "BAD_REQUEST", "The request body could not be parsed")
    }
}

/// Port of `notFoundHandler`.
#[must_use]
pub fn not_found(method: &str, path: &str) -> ApiError {
    ApiError::new(
        404,
        "NOT_FOUND",
        format!("No route matches {method} {path}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_core_envelope_fields() {
        let error = map_core_http_error(
            409,
            &json!({"code":"CONFLICT","message":"nope","reference":"r1","details":{"a":1}}),
        );
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "CONFLICT");
        assert_eq!(error.message, "nope");
        assert_eq!(error.reference.as_deref(), Some("r1"));
        assert_eq!(error.details, Some(json!({"a":1})));
    }

    #[test]
    fn falls_back_when_core_has_no_envelope() {
        let error = map_core_http_error(503, &json!({"unexpected": true}));
        assert_eq!(error.code, "CORE_UNAVAILABLE");
        assert_eq!(error.status, 503);
    }

    #[test]
    fn envelope_order_matches_ts() {
        let value = ApiError::new(400, "X", "y")
            .with_reference("r")
            .with_details(json!([]))
            .envelope();
        let keys: Vec<&String> = value.as_object().expect("object").keys().collect();
        assert_eq!(keys, vec!["code", "message", "reference", "details"]);
    }
}
