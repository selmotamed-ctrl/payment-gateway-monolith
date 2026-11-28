//! The API error envelope.
//!
//! Port of `core-back/lib/error/index.ts`.
//!
//! Core: `{"code","message","reference"?,"details"?}`. Edges use the same shape without a
//! reference. Malformed JSON is a 400 whose body is still `SERVER_ERROR` / `Internal server error`.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub reference: Option<String>,
    pub details: Option<Value>,
}

impl ApiError {
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

    #[must_use]
    pub fn to_envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            code: self.code.clone(),
            message: self.message.clone(),
            reference: self.reference.clone(),
            details: self.details.clone(),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.to_envelope()).unwrap_or_else(|_| {
            r#"{"code":"SERVER_ERROR","message":"Internal server error"}"#.to_owned()
        })
    }

    // Common constructors used by the TS code. Keep the exact code strings.

    #[must_use]
    pub fn invalid_body(details: Value) -> Self {
        Self::new(400, "INVALID_BODY", "Invalid request body").with_details(details)
    }

    #[must_use]
    pub fn validation_failed(details: Value) -> Self {
        Self::new(400, "VALIDATION_FAILED", "Validation failed").with_details(details)
    }

    #[must_use]
    pub fn unauthorized(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(401, code, message)
    }

    #[must_use]
    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(403, code, message)
    }

    #[must_use]
    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(404, code, message)
    }

    #[must_use]
    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(409, code, message)
    }

    #[must_use]
    pub fn payload_too_large() -> Self {
        Self::new(413, "PAYLOAD_TOO_LARGE", "Request body is too large")
    }

    #[must_use]
    pub fn server_error() -> Self {
        Self::new(500, "SERVER_ERROR", "Internal server error")
    }

    /// TS: malformed JSON reaches the error handler as a `SyntaxError` and renders a 400 with the
    /// generic `SERVER_ERROR` body (chapter 2 §2/§3).
    #[must_use]
    pub fn malformed_json() -> Self {
        Self::new(400, "SERVER_ERROR", "Internal server error")
    }

    #[must_use]
    pub fn mtls_unauthorized() -> Self {
        Self::new(
            401,
            "MTLS_UNAUTHORIZED",
            "Client certificate not authorized by internal CA",
        )
    }

    #[must_use]
    pub fn mtls_uninspectable() -> Self {
        Self::new(
            401,
            "MTLS_UNAUTHORIZED",
            "Client certificate could not be inspected",
        )
    }

    #[must_use]
    pub fn forbidden_service_identity(cn: &str, allowed: &[&str], channel: &str) -> Self {
        Self::new(
            403,
            "FORBIDDEN_SERVICE_IDENTITY",
            format!(
                "Certificate CN '{cn}' is not permitted on {} channel",
                allowed.join(", ")
            ),
        )
        .with_details(serde_json::json!({ "channel": channel }))
    }

    /// Daemons use `{error:{code,message}}`.
    #[must_use]
    pub fn daemon_json(code: &str, message: &str) -> String {
        serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

/// Map a PostgreSQL SQLSTATE to the Prisma-style code used by the TS error handlers
/// (chapter 2 §18). Returns `None` for states without a Prisma equivalent.
#[must_use]
pub fn prisma_code_for_sqlstate(sqlstate: &str) -> Option<&'static str> {
    match sqlstate {
        "23505" => Some("P2002"),
        "23503" => Some("P2003"),
        "40001" | "40P01" => Some("P2034"),
        "P2025" => Some("P2025"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_omits_absent_fields() {
        let error = ApiError::new(400, "X", "y");
        assert_eq!(error.to_json(), r#"{"code":"X","message":"y"}"#);
    }

    #[test]
    fn reference_is_emitted_when_present() {
        let error = ApiError::server_error().with_reference("req-1");
        assert_eq!(
            error.to_json(),
            r#"{"code":"SERVER_ERROR","message":"Internal server error","reference":"req-1"}"#
        );
    }

    #[test]
    fn sqlstate_mapping() {
        assert_eq!(prisma_code_for_sqlstate("23505"), Some("P2002"));
        assert_eq!(prisma_code_for_sqlstate("08006"), None);
    }
}
