//! The Fake Rails error envelope.
//!
//! TS: `lib/error/index.ts` renders `{ code, message, details? }` (no `error` wrapper). A malformed
//! JSON body reaches the handler as a syntax error and renders 400 `INVALID_BODY`; any unexpected
//! failure renders 500 `SERVER_ERROR` / `Internal server error`.

#![forbid(unsafe_code)]

use serde_json::{json, Value};

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiError {
    #[must_use]
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn invalid_body() -> Self {
        Self::new(400, "INVALID_BODY", "Invalid request data")
    }

    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NOT_FOUND", message)
    }

    #[must_use]
    pub fn server_error() -> Self {
        Self::new(500, "SERVER_ERROR", "Internal server error")
    }

    #[must_use]
    pub fn body(&self) -> Value {
        let mut body = json!({ "code": self.code, "message": self.message });
        if let Some(details) = &self.details {
            if let Some(object) = body.as_object_mut() {
                object.insert("details".to_owned(), details.clone());
            }
        }
        body
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        tracing::error!(error = %error, "sqlite failure");
        Self::server_error()
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid_body().with_details(json!([{ "message": error.to_string() }]))
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        tracing::error!(error = %error, "io failure");
        Self::server_error()
    }
}

/// A `zod`-style body parse failure. The TS `details` is a list of `{path, code, message}`; the
/// Rust port keeps `path` + `message` (issue codes are TS/zod specific and are not faked).
pub fn invalid_body_details(field: &str, message: impl Into<String>) -> ApiError {
    ApiError::invalid_body().with_details(json!([{
        "path": [field],
        "message": message.into(),
    }]))
}
